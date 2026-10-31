// ════════════════════════════════════════════════════════════════════
// WTS — Round-9 plug-in calculator — Chemical Injection (cheminj): ENGINE
//
// PURPOSE
//   Pure computation engine of the Chemical Injection planner
//   (docs/CHEMICAL-INJECTION-PLAN.md, release 3.2a): spread hydrate check
//   (flowing, shut-in and start-up nodes), thermodynamic-inhibitor design,
//   ppm-basis treating chemicals, pump settings (plunger SPM, metering
//   % stroke × % speed, air-driven liquid pump air pressure and cycles/min),
//   pump options ranked by hazardous-area suitability, surface discharge
//   pressure with the back-pressure basis, relief-valve band, backflow and
//   thermal-relief verdicts, drive-gas setting at the shut-in pressure,
//   drawdown-cylinder calibration, tank and totes.
//
//   The page (renderChemInj / calcChemInj, window.WTS_calcRegistry.cheminj,
//   sidebar group "Test System Safety", ids cj_*) is the second half of this
//   file. The engine functions touch no DOM; the page attaches listeners to
//   #cj_root only. Nothing starts a timer or wraps a function.
//
//   Every chemical and pump is named by its generic chemistry or type only
//   (data in prism-build/40-calc-chemlib.js, window.WTS_chemlib).
//
// SHARED ENGINES (resolved at call time, never copied)
//   WTS_hydrate_temp, WTS_hammerschmidt_depression, WTS_hammerschmidt_invert
//     (25-hydrate.js; chemlib keys map to its keys through thi.hamKey — ethanol
//     is never passed to it, its 80 wt % clamp is treated as out of range)
//   WTS_gaspvt_isenthalpic, WTS_gaspvt_z (46-calc-gaspvt.js; impurities in mol %:
//     H2S is held in ppm here and converted once, _ppmToMolPct)
//   WTS_h2s_scavenger (44-calc-h2sroe.js; gas mass balance of the scavenger line)
//   WTS_baseConditions (22-units.js; molar volume for the methanol vapour
//     constant, H2S mass and drive-gas exhaust)
//
// UNITS (field units in and out)
//   Pressures psig at the compute / spread / pressure / pump boundaries
//   (the page inputs), psia where a name says pPsia; temperatures °F; gas
//   MMscf/d; liquids bbl/d; chemical rates gal/d (US gal) with L/d, L/h,
//   mL/min and bbl/d alongside; masses lb/d; plunger, stroke and actuator
//   inches; drive gas scf; H2S ppm (mole).
//
// PUBLIC API — window.WTS_cheminj (namespace) and window.WTS_cheminj_compute
//   pvWater(tF) → psia (Wagner–Pruss 1993)
//   waterContent(pPsia, tF) → {ok, W_lbMMscf, pv, B, inRange, warnings}   (Bukacek)
//   hydrateTemp(pPsia, sg, shift?) → °F (WTS_hydrate_temp + user shift)
//   hydrateCurve(sg, shift, pMaxPsia, n) → [{p_psia, t_F}]
//   depression(key, W, method) → ΔT °F       method 'auto' | 'ham' | 'nb'
//   requiredWt(key, dT, method) → {ok, W, W_ham, W_nb, methodUsed, outOfRange, overMax, marginal, warnings}
//   methanolLoss(pPsia, tF, W, vm?, M?) → {K, x, perMole, lbPerMMscf, inRange}
//   freezePoint(key, W) → °F | null
//   spread(i) → {ok, nodes[], shutin, startup, margin, jt {…, liquids}, title, verdicts, warnings}
//     (optional i.qo/qw/api/sgw: ⚠ jt_liquids when the liquids carry > 10 % of the gas heat capacity;
//      a refused sour correlation marks every node status 'refused' and keeps the largest adder)
//   hydrateDose(i) → {ok, control, dT, XR, XR_ham, XR_nb, x, water, inh, freezeF, shutin, startup,
//                     noRate, refused, underDosed, XRdesign, verdicts}
//   doseRate(i) → {ok, gal_d, L_d, L_hr, gal_h, mL_min, bbl_d, gal_MMscf, activePpm, phase}
//     (optional i.phases {oil, water}: total-liquid ppm on the phases present at the point)
//   scavRatio(i), scavengerDose(i)   gas-phase H2S scavenger line rate (stoichiometry ÷ utilisation)
//   pumpSetting(i) → plunger {spm…} | meter {f, S, N…} | air-driven {airDesign, airFlow (at i.pFlow), cyclesMin…};
//     every kind: pMax (capability), pumpRating (default MAWP), deliverable (design rate at P_req)
//   pumpOptions(i) → {ranked[≤3], current, nextPlunger, reason, byPump}
//   injectionPressure(i) → {ok, pLine, pBack, pReq, pReqFlow, pReqShutin, pRating, mawp, psvBand, dPdT_psiF, verdicts}
//   supplyGas(i) → {applies, ps_set, stalls, scf_stroke, scf_d, scf_h, regDefault_scf_h, exhaust…, verdicts}
//   calibration(i) (air-driven: Q₀ re-fit at i.pTest, default i.pReq), fieldCheck(rate_gal_d, peakF), tank(i), compat(lines)
//   defaults() → the page-default input (worked example H1); fromIds(map) → input from cj_* ids
//   stats() → {isenthalpicSolves, memoHits}
//   WTS_cheminj_compute(input, opts?) → {ok, spread, hydrate, lines[], summary, compat, calibration,
//                                        basis, verdicts, warnings} | {ok:false, errors[], bad[cj ids]}
//   Every function returns {ok:false, errors[], bad[]} on bad input; verdicts are
//   {level:'ok'|'warn'|'bad', code, text} with plain text under 299 characters.
//   opts.fmt may override the text formatters (pG, dp, t, dt, galD, lbD, gal, scf…)
//   so the page can show Metric values in verdict text.
//
// PAGE (route cheminj) — window.renderChemInj(body), window.calcChemInj(); registry entry with
//   hooks.silent (restore applies saved values without events, hooks.after runs one calc).
//   WTS_cheminj.ranges (validation ranges), WTS_cheminj.pageCalcs() (calc counter for tests).
//   Publishes window.WTS_state.cheminj {ok, ts, lines[], total_gal_d, hydrate, h2s, result}.
//   Unit categories added when absent: chemRate, chemRateHr, doseGasVol, volPerStroke,
//   massRateDay, lbPerBbl.
// ════════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    var G = (typeof window !== 'undefined') ? window : globalThis;

    // ── Constants (plan §4) ──────────────────────────────────────────
    var ATM = 14.7;                       // psig → psia (plan: 3000 psig = 3014.7 psia)
    var LB_GAL = 8.337, LB_BBL = 350.2, GAL_L = 3.785411784, IN3_GAL = 231, ML_IN3 = 16.387064;
    var MW_W = 18.015, MW_H2S = 34.081, NB_A = 129.6, VM_DEF = 379.48;
    var X_REF_30 = (30 / 32.04) / (30 / 32.04 + 70 / MW_W);   // 0.1942: 30 wt % methanol
    var RULE_FPSI = 0.07;                 // 7 °F per 100 psi
    var CYLINDERS = [100, 250, 500, 1000, 2000, 4000];
    var REG_SCF_H = 13.3;                 // natural-gas-driven pneumatic pump default, scf/h
    var LOC_ORDER = { dh: 0, wh: 1, dsch: 2, sepin: 3 };
    var WHCLASSES = [2000, 3000, 5000, 10000, 15000];

    function _fin(x) { return typeof x === 'number' && isFinite(x); }
    function _low(s) { s = String(s || ''); return s.charAt(0).toLowerCase() + s.slice(1); }
    function _has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
    function _lib() { return G.WTS_chemlib || null; }
    function _num(v, d) { if (v === undefined) return d; if (v === '' || v === null) return NaN; var n = Number(v); return _fin(n) ? n : NaN; }
    function _blank(v) { return v === '' || v === null || (typeof v === 'number' && !isFinite(v)); }
    function _opt(v, d) { return (v === undefined || _blank(v)) ? d : Number(v); }
    function _ppmToMolPct(ppm) { return (_fin(ppm) ? ppm : 0) / 1e4; }
    function _vm() {
        var B = G.WTS_baseConditions;
        if (B && typeof B.resolve === 'function') {
            var b = B.resolve(60, 14.696);
            if (b && b.fromSetting && typeof B.molarVolume === 'function') {
                var v = B.molarVolume(b);
                if (_fin(v) && v > 0) return v;
            }
        }
        return VM_DEF;
    }
    function _xMol(W, M) { if (!(W > 0)) return 0; if (W >= 100) return 1; return (W / M) / (W / M + (100 - W) / MW_W); }
    function _rates(gal, qg) {
        var g = _fin(gal) && gal > 0 ? gal : 0;
        return { gal_d: g, L_d: g * GAL_L, L_hr: g * GAL_L / 24, gal_h: g / 24, mL_min: g * GAL_L * 1000 / 1440, bbl_d: g / 42, gal_MMscf: (_fin(qg) && qg > 0) ? g / qg : null };
    }
    function _V(level, code, text) { return { level: level, code: code, text: String(text).slice(0, 298) }; }
    function _worst(vs) { var r = 'ok'; (vs || []).forEach(function (v) { if (v.level === 'bad') r = 'bad'; else if (v.level === 'warn' && r !== 'bad') r = 'warn'; }); return r; }

    // ── Text formatting (imperial by default; the page may pass Metric formatters) ──
    function _grp(v, d) {
        if (!_fin(v)) return '–';
        var s = Math.abs(v).toFixed(d), parts = s.split('.');
        var ip = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        return (v < 0 && Number(s) !== 0 ? '-' : '') + ip + (parts.length > 1 ? '.' + parts[1] : '');
    }
    function _sig(v) { return Math.abs(v) >= 100 ? _grp(v, 0) : Math.abs(v) >= 10 ? _grp(v, 1) : _grp(v, 2); }
    function _frac(x) {
        var whole = Math.floor(x + 1e-9), rem = x - whole, n = Math.round(rem * 64), d = 64;
        if (n === 0) return String(whole);
        while (n % 2 === 0 && d > 1) { n /= 2; d /= 2; }
        return (whole ? whole + '-' : '') + n + '/' + d;
    }
    var FMT0 = {
        pG: function (v) { return _grp(v, 0) + ' psig'; },
        pA: function (v) { return _grp(v, 1) + ' psia'; },
        dp: function (v) { return _grp(v, 0) + ' psi'; },
        t: function (v) { return _grp(v, 1) + ' °F'; },
        dt: function (v) { return _grp(v, Math.abs(v - Math.round(v)) < 0.05 ? 0 : 1) + ' °F'; },
        pSet: function (v) { return _grp(v, 1) + ' psig'; },
        galD: function (v) { return _grp(v, Math.abs(v) < 10 ? 2 : 1) + ' gal/d'; },
        gal: function (v) { return _grp(v, 0) + ' gal'; },
        lbD: function (v) { return _sig(v) + ' lb/d'; },
        scfD: function (v) { return _grp(v, 0) + ' scf/d'; },
        psiF: function (v) { return _grp(v, 0) + ' psi per °F'; },
        inch: function (v) { return _frac(v) + ' in'; },
        pA0: function (v) { return _grp(v, 0) + ' psia'; },
        t0: function (v) { return _grp(v, 0) + ' °F'; },
        scfH: function (v) { return _grp(v, 1) + ' scf/h'; },
        lbD4: function (v) { return _grp(v, 4) + ' lb/d'; },
        galLb: function (v) { return _grp(v, 0) + ' gal/lb'; },
        jtRule: function () { return '7 °F/100 psi'; }
    };
    function _fmt(o) {
        var f = {}, k;
        for (k in FMT0) f[k] = FMT0[k];
        if (o && typeof o === 'object') for (k in o) if (_has(o, k) && typeof o[k] === 'function') f[k] = o[k];
        return f;
    }
    var F = FMT0;   // active formatter set (set per compute call; engines read it)

    // ── Water vapour pressure (Wagner & Pruss 1993) and water content (Bukacek 1955) ──
    var WP_A = [-7.85951783, 1.84408259, -11.7866497, 22.6807411, -15.9618719, 1.80122502];
    function pvWater(tF) {
        var t = Number(tF);
        if (!_fin(t)) return NaN;
        var T = (t + 459.67) / 1.8, Tc = 647.096;
        if (!(T > 150 && T < Tc)) return NaN;
        var tau = 1 - T / Tc;
        var s = WP_A[0] * tau + WP_A[1] * Math.pow(tau, 1.5) + WP_A[2] * Math.pow(tau, 3) + WP_A[3] * Math.pow(tau, 3.5) +
            WP_A[4] * Math.pow(tau, 4) + WP_A[5] * Math.pow(tau, 7.5);
        return 22.064e6 * Math.exp(Tc / T * s) / 6894.757293168;
    }
    function waterContent(pPsia, tF) {
        var p = Number(pPsia), t = Number(tF);
        if (!(_fin(p) && p > 0)) return { ok: false, errors: ['Pressure must be above 0 psia.'], bad: ['p'] };
        var pv = pvWater(t);
        if (!_fin(pv)) return { ok: false, errors: ['Temperature is outside the water vapour-pressure range.'], bad: ['t'] };
        var B = Math.pow(10, -3083.87 / (t + 459.6) + 6.69449);
        var W = 47484 * pv / p + B, warnings = [];
        var inRange = t >= 60 && t <= 460 && p >= 15 && p <= 10000;
        if (t < 60) warnings.push('Water content below ' + F.t0(60) + ' is extrapolated beyond the Bukacek correlation range (' + F.t0(60) + ' to ' + F.t0(460) + ').');
        if (t > 460 || p < 15 || p > 10000) warnings.push('Water content is outside the Bukacek correlation range (' + F.t0(60) + ' to ' + F.t0(460) + ', ' + F.pA0(15) + ' to ' + F.pA0(10000) + ').');
        return { ok: true, W_lbMMscf: W, pv: pv, B: B, inRange: inRange, warnings: warnings };
    }

    // ── Hydrate temperature (25-hydrate.js engine, plus the user parallel shift) ──
    function _thydRaw(pPsia, sg) {
        var f = G.WTS_hydrate_temp;
        return typeof f === 'function' ? f(pPsia, sg) : NaN;
    }
    function hydrateTemp(pPsia, sg, shift) { return _thydRaw(pPsia, sg) + (_fin(shift) ? shift : 0); }
    function hydrateCurve(sg, shift, pMaxPsia, n) {
        var N = Math.max(2, Math.min(200, Math.round(n || 40))), pmax = Math.max(100, _fin(pMaxPsia) ? pMaxPsia : 4000), out = [];
        var p0 = 50, r = Math.log(pmax / p0);
        for (var k = 0; k < N; k++) { var p = p0 * Math.exp(r * k / (N - 1)); out.push({ p_psia: p, t_F: hydrateTemp(p, sg, shift) }); }
        return out;
    }

    // ── Thermodynamic inhibitor depression (plan §4.3) ──────────────
    function _thi(key) { var L = _lib(), c = L && L.find(key); return c && c.kind === 'thi' && c.thi ? c : null; }
    function _inhKey(key) { var c = _thi(key); return c ? c.thi.hamKey : null; }   // null for ethanol: never passed to 25-hydrate
    function _nbInv(M, dT) { if (!(dT > 0)) return 0; var x = 1 - Math.exp(-dT / NB_A); return 100 * x * M / (MW_W + x * (M - MW_W)); }
    function _nbDep(M, W) { if (!(W > 0)) return 0; return -NB_A * Math.log(1 - _xMol(Math.min(W, 99.999), M)); }
    function _hamDep(c, W) {
        var hk = c.thi.hamKey, f = G.WTS_hammerschmidt_depression;
        if (hk && typeof f === 'function') return f(W, hk);
        if (!(W > 0)) return 0;
        var w = Math.min(W, 99.999);
        return c.thi.K * w / (c.thi.Mham * (100 - w));
    }
    function _hamInv(c, dT) {
        var hk = c.thi.hamKey, f = G.WTS_hammerschmidt_invert;
        if (hk && typeof f === 'function') return f(dT, hk);
        if (!(dT > 0)) return 0;
        return Math.min(80, 100 * dT * c.thi.Mham / (c.thi.K + dT * c.thi.Mham));
    }
    function depression(key, W, method) {
        var c = _thi(key), w = Number(W);
        if (!c || !_fin(w)) return NaN;
        var h = _hamDep(c, w);
        if (method === 'ham' || !c.thi.nb) return h;
        var n = _nbDep(c.thi.M, w);
        return method === 'nb' ? n : Math.min(h, n);   // design: the smaller depression for a given W
    }
    function requiredWt(key, dT, method) {
        var c = _thi(key), d = Number(dT), m = method || 'auto', warnings = [];
        if (!c) return { ok: false, errors: ['Not a thermodynamic hydrate inhibitor.'], bad: ['key'] };
        if (!_fin(d)) return { ok: false, errors: ['Depression must be a number.'], bad: ['dT'] };
        if (d <= 0) return { ok: true, W: 0, W_ham: 0, W_nb: c.thi.nb ? 0 : null, methodUsed: c.thi.nb && m !== 'ham' ? 'nb' : 'ham', outOfRange: false, overMax: false, marginal: false, warnings: warnings };
        var wh = _hamInv(c, d), wn = c.thi.nb ? _nbInv(c.thi.M, d) : null, W, used;
        if (m === 'ham') { W = wh; used = 'ham'; warnings.push('Forced Hammerschmidt: comparison only, not the design value.'); }
        else if (m === 'nb' && c.thi.nb) { W = wn; used = 'nb'; warnings.push('Forced Nielsen–Bucklin: comparison only, not the design value.'); }
        else if (m === 'nb') { W = wh; used = 'ham'; warnings.push('Nielsen–Bucklin is not used for ' + c.short + ': Hammerschmidt applied.'); }
        else if (c.thi.nb) { if (wn >= wh) { W = wn; used = 'nb'; } else { W = wh; used = 'ham'; } }
        else { W = wh; used = 'ham'; warnings.push(c.short + ': Hammerschmidt only, limited validation; rarely injected' + (c.key === 'teg' ? ' (TEG is a dehydration glycol).' : '.')); }
        var out = wh >= 79.99 || W >= 79.99;
        return {
            ok: true, W: W, W_ham: wh, W_nb: wn, methodUsed: used, outOfRange: out,
            overMax: out || W > c.thi.maxPct, marginal: W > c.thi.warnPct, warnings: warnings
        };
    }
    function freezePoint(key, W) {
        var c = _thi(key), w = Number(W);
        if (!c || !c.freezeCurve || !_fin(w)) return null;
        var cv = c.freezeCurve, k;
        if (w <= cv[0][0]) return cv[0][1];
        for (k = 1; k < cv.length; k++) {
            if (w <= cv[k][0]) return cv[k - 1][1] + (w - cv[k - 1][0]) / (cv[k][0] - cv[k - 1][0]) * (cv[k][1] - cv[k - 1][1]);
        }
        var a = cv[cv.length - 2], b = cv[cv.length - 1];
        var t = b[1] + (w - b[0]) / (b[0] - a[0]) * (b[1] - a[1]);
        return (_fin(c.freezeF) && t < c.freezeF) ? c.freezeF : t;
    }

    // ── Methanol vapour loss: K-value express (Moshfeghian 2011) ─────
    function methanolLoss(pPsia, tF, W, vm, M) {
        var p = Number(pPsia), t = Number(tF), w = Number(W);
        var v = (_fin(Number(vm)) && vm > 0) ? Number(vm) : _vm(), mw = (_fin(Number(M)) && M > 0) ? Number(M) : 32.04;
        var Ps = p / 35, Ts = (t + 459.67) / 615;
        var om = 2.95 - 0.02607 * Ps + 8.92828e-5 * Ps * Ps - 0.851257 / Ts;
        var K = (1 / Ps) * Math.exp(5.37 * (1 + om) * (1 - 1 / Ts));
        var x = _xMol(w, mw), per = 1e6 * mw / v;
        return { K: K, x: x, perMole: per, lbPerMMscf: per * K * x, inRange: t >= -10 && t <= 100 && p >= 100 && p <= 5000 && w <= 70 };
    }

    // ── Spread: flowing, shut-in and start-up nodes (plan §3.1, §4.1, §4.2, §4.7) ──
    var SPREAD_DEF = {
        qg: 10, sg: 0.65, h2s: 0, co2: 0, n2: 0,
        sithp: 3500, fwhp: 3000, fwht: 110, tamb: 60, pck: 1000, jt: 'ise', tck: 34.6,
        htr: 'yes', thtr: 90, psep: 1000, tsep: '', psvsep: 1440, whclass: 5000,
        margin: 10, fJT: 1.10, sour: 5, thsrc: 'tm', thuser: '', thuserp: ''
    };
    function _jt(gas, p1g, t1, p2g, method, fJT, userT) {
        var w = [];
        if (method === 'user' && _fin(userT)) return { t: userT, tDak: null, method: 'user', warnings: w };
        if (method !== 'rule') {
            var f = G.WTS_gaspvt_isenthalpic;
            if (typeof f === 'function') {
                var r = f({ sg: gas.sg, p1: p1g + ATM, t1: t1, p2: Math.min(p2g, p1g) + ATM, co2: gas.co2, h2s: gas.h2s, n2: gas.n2, fJT: fJT });
                if (r && r.ok) return { t: r.t2Design, tDak: r.t2, method: 'ise', warnings: (r.warnings || []).slice(), iterations: r.iterations, clamped: r.clamped };
                w.push('Real-gas J-T expansion not available here (' + ((r && r.errors && r.errors[0]) || 'Gas PVT engine missing') + '): ' + F.jtRule() + ' rule used.');
            } else w.push('Gas PVT engine not loaded: ' + F.jtRule() + ' rule used.');
        }
        return { t: t1 - RULE_FPSI * Math.max(0, p1g - p2g), tDak: null, method: 'rule', warnings: w };
    }
    // Heat capacity of the stream through the choke (plan §4.1.5 mixture formula, used for the
    // 3.2a warning only): gas q_g·10⁶/V_m·28.97·γ lb/d, oil q_o·350.2·SG_o, water q_w·350.2·SG_w,
    // with typical c_p 0.6 (gas at line pressure), 0.5 (oil) and 1.0 (water) Btu/lb·°F.
    // Returns null without liquids; ratio = liquid / gas heat capacity (null with no gas).
    var CP_GAS = 0.6, CP_OIL = 0.5, CP_WATER = 1.0, LIQ_HEAT_WARN = 0.10;
    function _liqHeat(qg, sg, i, vm) {
        var qo = Math.max(0, _opt(i.qo, 0)), qw = Math.max(0, _opt(i.qw, 0));
        if (!(_fin(qo) && _fin(qw)) || !(qo + qw > 0)) return null;
        var api = _opt(i.api, 50), sgw = _opt(i.sgw, 1.05);
        var sgo = 141.5 / (131.5 + (_fin(api) ? api : 50));
        var cg = Math.max(0, _fin(qg) ? qg : 0) * 1e6 / vm * 28.97 * sg * CP_GAS;
        var cl = qo * LB_BBL * sgo * CP_OIL + qw * LB_BBL * (_fin(sgw) ? sgw : 1.05) * CP_WATER;
        return { gasFrac: cg / (cg + cl), ratio: cg > 0 ? cl / cg : null };
    }
    function _zAt(gas, pPsia, tF) {
        var f = G.WTS_gaspvt_z;
        if (typeof f !== 'function') return null;
        var r = f({ sg: gas.sg, p: pPsia, t: tF, co2: gas.co2, h2s: gas.h2s, n2: gas.n2 });
        return r && r.ok ? r : null;
    }
    function _node(key, label, loc, pG, tF, tDak, gas, thydFn, margin) {
        var pa = pG + ATM, th = thydFn(pa), z = _zAt(gas, pa, tF);
        var dTreq = th - tF + margin;
        return {
            key: key, label: label, loc: loc, p_psig: pG, p_psia: pa, t_F: tF, tDak_F: tDak, thyd: th,
            sub: th - tF, dTreq: dTreq, status: tF < th ? 'bad' : (dTreq > 0 ? 'warn' : 'ok'),
            z: z ? z.z : null, Bg: z ? z.Bg_ft3scf : null
        };
    }
    function spread(i) {
        i = i || {};
        var v = {}, k, errors = [], bad = [];
        for (k in SPREAD_DEF) v[k] = _has(i, k) && i[k] !== undefined ? i[k] : SPREAD_DEF[k];
        ['qg', 'sg', 'h2s', 'co2', 'n2', 'sithp', 'fwhp', 'fwht', 'tamb', 'pck', 'thtr', 'psep', 'psvsep', 'margin', 'fJT', 'sour'].forEach(function (f) {
            v[f] = Number(v[f]);
            if (!_fin(v[f])) { errors.push('Spread input ' + f + ' must be a number.'); bad.push(f); }
        });
        if (errors.length) return { ok: false, errors: errors, bad: bad };
        if (!(v.sg >= 0.55 && v.sg <= 3)) { errors.push('Gas gravity must be between 0.55 and 3.0.'); bad.push('sg'); }
        if (v.pck > v.fwhp) { errors.push('Pressure downstream of the choke must not exceed the flowing wellhead pressure.'); bad.push('pck'); }
        if (v.psep > v.pck) { errors.push('Separator pressure must not exceed the pressure downstream of the choke.'); bad.push('psep'); }
        if (errors.length) return { ok: false, errors: errors, bad: bad };
        var verdicts = [], warnings = [];
        var gas = { sg: v.sg, co2: v.co2, h2s: _ppmToMolPct(v.h2s), n2: v.n2 };
        // Hydrate temperature source and the user parallel shift
        var src = v.thsrc === 'user' ? 'user' : 'tm', shift = 0;
        if (src === 'user') {
            var tu = Number(v.thuser), pu = Number(v.thuserp);
            if (_blank(v.thuser) || _blank(v.thuserp) || !_fin(tu) || !_fin(pu)) return { ok: false, errors: ['Enter the user hydrate temperature and the pressure it applies at.'], bad: ['thuser', 'thuserp'] };
            shift = tu - _thydRaw(pu + ATM, v.sg);
        }
        if (!_fin(_thydRaw(1000, v.sg))) return { ok: false, errors: ['The hydrate engine (Hydrate Management) is not loaded.'], bad: ['sg'] };
        if (v.sg < 0.55 || v.sg > 1.0) verdicts.push(_V('warn', 'sg_range', 'Gas gravity ' + _grp(v.sg, 3) + ' is outside 0.55–1.0, the range of the gas-gravity hydrate correlation: the hydrate temperature is taken at the nearest limit.'));
        // Margin and sour gas (§4.2)
        var y = gas.h2s, adder = 0, refused = false, refusedText = '';
        if (src === 'tm') {
            // Beyond the limits the correlation is refused; the margin keeps the largest adder
            // (3 × sour for H2S, the flat adder for CO2) so it never falls as the gas gets sourer.
            if (y > 3) { refused = true; adder += 3 * v.sour; refusedText = 'H2S ' + _grp(y, 2) + ' mol % is beyond the sweet-gas correlation: enter a lab or composition-based hydrate temperature. No rate given.'; }
            else if (y > 0.1) adder += Math.max(v.sour, v.sour * y);
            if (v.co2 > 20) { refused = true; adder += v.sour; refusedText = refusedText || ('CO2 ' + _grp(v.co2, 1) + ' mol % is beyond the sweet-gas correlation: enter a lab or composition-based hydrate temperature. No rate given.'); }
            else if (v.co2 > 5) adder += v.sour;
        }
        var mUsed = v.margin + adder;
        if (refused) verdicts.push(_V('bad', 'sour_refused', refusedText));
        else if (adder > 0) verdicts.push(_V('warn', 'sour_adder', 'Sweet-gas hydrate correlation used on sour gas: margin raised by ' + F.dt(adder) + ' (margin now ' + F.dt(mUsed) + '). Enter a lab or composition-based hydrate temperature.'));
        if (v.margin < 5) verdicts.push(_V('warn', 'margin_low', 'Hydrate margin ' + F.dt(v.margin) + ' is below ' + F.dt(5) + '.'));
        else if (src === 'tm' && v.margin < 10) verdicts.push(_V('warn', 'margin_corr', 'Hydrate margin ' + F.dt(v.margin) + ' is below ' + F.dt(10) + ' while the hydrate temperature comes from the gas-gravity correlation (about ±' + F.dt(5) + ').'));
        var jtMethod = v.jt === 'rule' ? 'rule' : v.jt === 'user' ? 'user' : 'ise';
        if (jtMethod === 'ise' && v.fJT < 1.10) verdicts.push(_V('warn', 'fjt_low', 'J-T factor ' + _grp(v.fJT, 2) + ' is below 1.10: DAK alone under-predicts J-T cooling by up to 9 %.'));
        if (jtMethod === 'rule') verdicts.push(_V('warn', 'jt_rule', 'Choke outlet uses ' + F.jtRule() + ': a quick check that can overstate or understate cooling.'));
        if (v.fwhp > v.sithp) verdicts.push(_V('warn', 'fwhp_gt_sithp', 'Flowing wellhead pressure is above the shut-in pressure: check the inputs.'));
        var whc = Number(v.whclass);
        if (_fin(whc) && v.sithp > whc) verdicts.push(_V('bad', 'class', 'SITHP exceeds the flowhead class (' + F.pG(v.sithp) + ' against ' + F.pG(whc) + ').'));
        var thydFn = function (pa) { return _thydRaw(pa, v.sg) + shift; };
        // Flowing nodes
        var tckUser = Number(v.tck);
        if (jtMethod === 'user' && (_blank(v.tck) || !_fin(tckUser))) return { ok: false, errors: ['Enter the choke outlet temperature.'], bad: ['tck'] };
        var ck = _jt(gas, v.fwhp, v.fwht, v.pck, jtMethod, v.fJT, tckUser);
        ck.warnings.forEach(function (w) { warnings.push('Choke: ' + w); });
        var heater = v.htr !== 'no';
        var tSepIn = heater ? v.thtr : ck.t;
        var tsep = (_blank(v.tsep) || !_fin(Number(v.tsep))) ? tSepIn : Number(v.tsep);
        var nodes = [
            _node('fh', 'Flowhead (flowing)', 'wh', v.fwhp, v.fwht, null, gas, thydFn, mUsed),
            _node('ck', 'Downstream of choke', 'dsch', v.pck, ck.t, ck.tDak, gas, thydFn, mUsed),
            _node('sep', heater ? 'Heater outlet / separator inlet' : 'Separator inlet', 'sepin', v.psep, tSepIn, null, gas, thydFn, mUsed)
        ];
        // Shut-in (SITHP, ambient) and start-up (cold tree expanding to the choke outlet pressure)
        var si = _node('si', 'Shut-in: flowhead', 'wh', v.sithp, v.tamb, null, gas, thydFn, mUsed);
        var suJ = _jt(gas, v.sithp, v.tamb, Math.min(v.pck, v.sithp), jtMethod === 'user' ? 'ise' : jtMethod, v.fJT, NaN);
        suJ.warnings.forEach(function (w) { warnings.push('Start-up: ' + w); });
        var su = _node('su', 'Start-up: downstream of choke', 'dsch', Math.min(v.pck, v.sithp), suJ.t, suJ.tDak, gas, thydFn, mUsed);
        // Refused correlation: the temperatures stand, the hydrate status of every node is unknown.
        if (refused) nodes.concat([si, su]).forEach(function (n) { n.status = 'refused'; });
        var allOk = !refused && nodes.every(function (n) { return n.status === 'ok'; });
        if (allOk) verdicts.push(_V('ok', 'no_risk', 'No hydrate risk at the spread nodes with a ' + F.dt(mUsed) + ' margin.'));
        // Liquids in the choke (plan §4.1.5, §8.3): the 3.2a choke temperature is for the gas
        // only. When the liquids carry more than 10 % of the gas heat capacity the cooling, and
        // with it the hydrate dose, is overstated: say so with the mixture estimate (not applied).
        var liq = _liqHeat(v.qg, v.sg, i, _vm());
        var liqInfo = null;
        if (liq) {
            var dTg = v.fwht - ck.t;
            liqInfo = { gasFrac: liq.gasFrac, ratio: liq.ratio, tMix: v.fwht - dTg * liq.gasFrac };
            if (jtMethod !== 'user' && (liq.ratio == null || liq.ratio > LIQ_HEAT_WARN) && dTg > 0) {
                verdicts.push(_V('warn', 'jt_liquids', 'Choke cooling is computed for the gas only; the liquids carry ' + _grp(100 * (1 - liq.gasFrac), 0) +
                    ' % of the stream heat capacity and reduce it (mixture estimate ' + F.t(liqInfo.tMix) + ' against ' + F.t(ck.t) + '). The hydrate dose is conservative and may be far too high.'));
            }
        }
        var jtTxt = jtMethod === 'ise' ? 'J-T × ' + _grp(v.fJT, 2) : jtMethod === 'rule' ? 'J-T ' + F.jtRule() : 'choke temperature entered';
        return {
            ok: true, sg: v.sg, gas: gas, qg: v.qg, h2s_ppm: v.h2s, h2s_molPct: y,
            sithp: v.sithp, fwhp: v.fwhp, fwht: v.fwht, tamb: v.tamb, pck: v.pck, psep: v.psep, tsep: tsep, heater: heater,
            margin: { base: v.margin, adder: adder, used: mUsed, refused: refused, refusedText: refusedText },
            thydSrc: src, thydShift: shift,
            jt: { method: jtMethod, fJT: v.fJT, choke: ck, startup: suJ, liquids: liqInfo },
            nodes: nodes, shutin: si, startup: su,
            title: 'Spread hydrate check (margin ' + F.dt(mUsed) + ', ' + jtTxt + ')',
            verdicts: verdicts, warnings: warnings
        };
    }

    // ── Water at a node and the hydrate dose (plan §3.2, §4.4, §4.5, §4.7) ──
    function _ptOrder(pt) { return _has(LOC_ORDER, pt) ? LOC_ORDER[pt] : 99; }
    function _path(sp, point) {
        var o = _ptOrder(point);
        return { up: sp.nodes.filter(function (n) { return LOC_ORDER[n.loc] < o; }), path: sp.nodes.filter(function (n) { return LOC_ORDER[n.loc] >= o; }) };
    }
    function _ctrlOf(nodes) { var c = null; nodes.forEach(function (n) { if (!c || n.dTreq > c.dTreq) c = n; }); return c; }
    // Water to treat at node `ctrl`: free + condensed (+ other aqueous chemicals upstream).
    function _water(sp, ctrl, q, other) {
        var free = Math.max(0, q.qw) * LB_BBL * q.sgw;
        var wsat = waterContent(sp.fwhp + ATM, sp.fwht), wc = waterContent(ctrl.p_psia, ctrl.t_F);
        var Win = wsat.ok ? wsat.W_lbMMscf : 0, Wout = q.cond === 'all' ? 0 : (wc.ok ? wc.W_lbMMscf : 0), Wsep = null, cond;
        if (q.wbasis === 'sep') {
            // The separator gas carries at most the flowhead water: a separator warmer than the
            // gas dew point condensed nothing upstream, so W_sep is capped at W_in.
            var ws = waterContent(sp.psep + ATM, sp.tsep);
            Wsep = ws.ok ? ws.W_lbMMscf : 0;
            cond = Math.max(0, q.qg) * Math.max(0, Math.min(Win, Wsep) - Wout);
        } else cond = Math.max(0, q.qg) * Math.max(0, Win - Wout);
        var oth = 0, oList = [];
        (other || []).forEach(function (o) {
            if (o && _fin(o.lb_d) && o.lb_d > 0 && _ptOrder(o.point) <= LOC_ORDER[ctrl.loc]) { oth += o.lb_d; oList.push(o); }
        });
        var warns = [];
        if (q.cond !== 'all' && ctrl.t_F < 60 && q.qg > 0) warns.push('Condensed water at ' + F.t(ctrl.t_F) + ' is extrapolated below the ' + F.t0(60) + ' limit of the Bukacek correlation.');
        // Plan §4.4: acid gas raises the water content at high pressure; no correction in 3.2a.
        var gs = sp.gas || {};
        if (q.qg > 0 && ((gs.h2s || 0) > 0.1 || (gs.h2s || 0) + (gs.co2 || 0) > 5)) {
            warns.push('Sour gas holds more water than the sweet-gas Bukacek correlation predicts at high pressure; condensed water may be under-estimated (no correction in this version).');
        }
        return { free: free, cond: cond, other: oth, otherLines: oList, total: free + cond + oth, Win: Win, Wout: Wout, Wsep: Wsep, extrapolated: ctrl.t_F < 60, warnings: warns };
    }
    function hydrateDose(i) {
        i = i || {};
        var L = _lib(), c = _thi(i.chem || 'meoh');
        if (!L || !c) return { ok: false, errors: ['Choose a thermodynamic hydrate inhibitor.'], bad: ['chem'] };
        var sp = i.spread && i.spread.ok ? i.spread : spread(i);
        if (!sp.ok) return sp;
        var q = {
            qg: _num(i.qg, sp.qg), qw: _num(i.qw, 2), sgw: _num(i.sgw, 1.05), qo: _num(i.qo, 0),
            wbasis: i.wbasis === 'sep' ? 'sep' : 'free', cond: i.cond === 'all' ? 'all' : 'buk'
        };
        var point = i.point || 'wh', method = i.method || 'auto';
        var leanPct = _opt(i.leanPct, c.leanDef), XL = leanPct / 100;
        var fc = _opt(i.fc, 0.25), gly = _opt(i.glyLossPct, 1), vm = _opt(i.vm, _vm());
        var sg = _opt(i.sgc, c.sg);
        var verdicts = [], warnings = [], m = sp.margin.used;
        var res = {
            ok: true, chem: c.key, point: point, marginUsed: m, control: null, dT: 0, XR: 0, XR_ham: 0, XR_nb: null, methodUsed: null, x: 0,
            water: null, inh: null, freezeF: null, required: false, noRate: false, refused: false, underDosed: false, XRdesign: null, leanPct: leanPct,
            shutin: null, startup: null, verdicts: verdicts, warnings: warnings
        };
        // Shut-in and start-up requirements (any THI line; information + verdicts)
        function caseReq(node, label) {
            if (sp.margin.refused) {
                // No correlation-based requirement when the sweet-gas correlation is refused.
                return { node: node.key, label: label, dT: node.dTreq, XR: null, XR_ham: null, XR_nb: null, level: 'bad', refused: true,
                    text: label + ': not assessed, the sweet-gas hydrate correlation is refused: enter a lab or composition-based hydrate temperature.' };
            }
            var r = requiredWt(c.key, node.dTreq, method), o = { node: node.key, label: label, dT: node.dTreq, XR: r.W, XR_ham: r.W_ham, XR_nb: r.W_nb, level: 'ok', text: '' };
            if (node.dTreq <= 0) { o.text = label + ': no inhibitor needed with a ' + F.dt(m) + ' margin.'; return o; }
            if (r.overMax) { o.level = 'bad'; o.text = label + ': required concentration is beyond the method range (' + _grp(r.W, 1) + ' wt %). Heat, stage the pressure drop or start on a small choke.'; }
            else if (r.marginal) { o.level = 'warn'; o.text = label + ': required ' + _grp(r.W, 1) + ' wt % ' + c.short + ' is high: chemical-only inhibition is marginal. Consider heating, staging the choke or a smaller start-up choke.'; }
            else o.text = label + ': ' + _grp(r.W, 1) + ' wt % ' + c.short + ' in the water (margin ' + F.dt(m) + ').';
            return o;
        }
        res.shutin = caseReq(sp.shutin, 'Shut-in');
        res.startup = caseReq(sp.startup, 'Start-up');
        if (sp.margin.refused) {
            res.noRate = true; res.refused = true;
            verdicts.push(_V('bad', 'sour_refused', sp.margin.refusedText));
            res.inh = _inhOut(0, 0, 0, 0, 0, 0, 1, q.qg);
            return res;
        }
        var pp = _path(sp, point);
        if (!pp.path.length) {
            verdicts.push(_V('warn', 'no_nodes', 'No spread node downstream of this point is checked for hydrate; the separator gas re-expansion check is not included yet.'));
            res.inh = _inhOut(0, 0, 0, 0, 0, 0, 1, q.qg);
            return res;
        }
        var upRisk = pp.up.filter(function (n) { return n.dTreq > 0; });
        if (upRisk.length) verdicts.push(_V('bad', 'downstream_of_risk', 'Injection point is downstream of the first hydrate-risk node (' + upRisk[0].label + '): move it upstream.'));
        if (point === 'dsch') {
            var ckN = sp.nodes.filter(function (n) { return n.key === 'ck'; })[0];
            if (ckN && ckN.dTreq > 0) verdicts.push(_V('warn', 'choke_unprotected', 'Injection downstream of the choke: the choke body and bean are not protected.'));
        }
        var ctrl = _ctrlOf(pp.path);
        res.control = { key: ctrl.key, label: ctrl.label, p_psig: ctrl.p_psig, p_psia: ctrl.p_psia, t_F: ctrl.t_F, thyd: ctrl.thyd, dTreq: ctrl.dTreq };
        var wat = _water(sp, ctrl, q, i.otherWater);
        res.water = wat;
        wat.warnings.forEach(function (w) { warnings.push(w); });
        var tMin = Math.min.apply(null, pp.path.map(function (n) { return n.t_F; }));
        var override = _opt(i.XRoverride, NaN);
        if (!(ctrl.dTreq > 0) && !_fin(override)) {
            verdicts.push(_V('ok', 'no_risk_path', 'No hydrate risk downstream of this point with a ' + F.dt(m) + ' margin.'));
            verdicts.push(_V('warn', 'not_required', 'Line not required for steady flow (start-up and shut-in needs are shown separately).'));
            res.inh = _inhOut(0, 0, 0, 0, 0, 0, 1, q.qg);
            return res;
        }
        res.required = true;
        if (!(wat.total > 0)) {
            verdicts.push(_V('ok', 'no_water', 'No free or condensed water at the controlling node: no thermodynamic inhibitor needed.'));
            res.inh = _inhOut(0, 0, 0, 0, 0, 0, 1, q.qg);
            return res;
        }
        var dT = ctrl.dTreq, req;
        if (_fin(override)) {
            req = { ok: true, W: override, W_ham: _hamInv(c, Math.max(0, dT)), W_nb: c.thi.nb ? _nbInv(c.thi.M, Math.max(0, dT)) : null, methodUsed: 'user', outOfRange: override >= 79.99, overMax: override > c.thi.maxPct, marginal: override > c.thi.warnPct, warnings: [] };
            // An override below the design requirement does not protect the controlling node.
            var des = dT > 0 ? requiredWt(c.key, dT, method) : null;
            if (des && des.ok && override < des.W - 1e-9) {
                res.underDosed = true; res.XRdesign = des.W;
                verdicts.push(_V('bad', 'override_low', 'Rich ' + _grp(override, 2) + ' wt % entered is below the required ' + _grp(des.W, 2) + ' wt % ' + c.short +
                    ': the dose does not protect ' + _low(ctrl.label) + ' (margin ' + F.dt(m) + ').'));
            } else warnings.push('Rich concentration entered by the user (' + _grp(override, 2) + ' wt %), not the design value.');
        } else req = requiredWt(c.key, dT, method);
        req.warnings.forEach(function (w) { warnings.push(w); });
        res.dT = dT; res.XR = req.W; res.XR_ham = req.W_ham; res.XR_nb = req.W_nb; res.methodUsed = req.methodUsed;
        if (req.overMax) {
            res.noRate = true;
            verdicts.push(_V('bad', 'beyond_range', 'Required concentration is beyond the method range (' + _grp(req.W, 1) + ' wt %): no rate given. Heat or stage the pressure drop.'));
            res.inh = _inhOut(0, 0, 0, 0, 0, 0, 1, q.qg);
            return res;
        }
        if (req.marginal) verdicts.push(_V('warn', 'marginal', 'Required ' + _grp(req.W, 1) + ' wt % ' + c.short + ' is high: chemical-only inhibition is marginal. Consider heating, staging the choke or a smaller start-up choke.'));
        var XR = req.W / 100;
        if (!(XL > XR)) {
            res.noRate = true;
            verdicts.push(_V('bad', 'lean_too_weak', 'Lean strength ' + _grp(leanPct, 1) + ' wt % is not above the required ' + _grp(req.W, 1) + ' wt %: no rate given.'));
            res.inh = _inhOut(0, 0, 0, 0, 0, 0, 1, q.qg);
            return res;
        }
        if (c.leanMin != null && (leanPct < c.leanMin || leanPct > c.leanMax)) warnings.push('Lean strength ' + _grp(leanPct, 1) + ' wt % is outside the usual ' + c.leanMin + '–' + c.leanMax + ' wt % for ' + c.short + '.');
        var x = _xMol(req.W, c.thi.M);
        res.x = x;
        var vap = 0, lhc = 0, K = null, Lsol, loss = 0;
        if (c.vapourLoss) {
            var ml = methanolLoss(ctrl.p_psia, ctrl.t_F, req.W, vm, c.thi.M);
            K = ml.K;
            vap = Math.max(0, q.qg) * ml.lbPerMMscf;
            lhc = Math.max(0, q.qo) * fc * x / X_REF_30;
            if (!ml.inRange) warnings.push('Methanol vapour-loss correlation used outside its range (' + F.t0(-10) + ' to ' + F.t0(100) + ', ' + F.pA0(100) + ' to ' + F.pA0(5000) + ', up to 70 wt %).');
            if (c.key !== 'meoh') warnings.push(c.short + ' vapour and condensate losses use the methanol correlations (conservative).');
            Lsol = (XR * wat.total + (vap + lhc) * (1 - XR)) / (XL - XR);
        } else {
            var base = XR * wat.total / (XL - XR);
            loss = base * gly / 100;
            Lsol = base + loss;
        }
        var rhoI = sg * LB_GAL, rho = 1 / (XL / rhoI + (1 - XL) / LB_GAL);
        res.inh = _inhOut(Lsol, Lsol * XL - vap - lhc - loss * XL, vap, lhc, loss, rho, XL, q.qg);
        res.inh.K = K;
        res.freezeF = freezePoint(c.key, req.W);
        res.tMin = tMin;
        if (res.freezeF != null) {
            if (res.freezeF > tMin - 5) verdicts.push(_V('warn', 'freeze', 'Rich-phase freeze point ' + F.t(res.freezeF) + ' is within ' + F.dt(5) + ' of the coldest node (' + F.t(tMin) + ').'));
        }
        return res;
    }
    function _inhOut(Lsol, aq, vap, lhc, loss, rho, XL, qg) {
        var gal = rho > 0 ? Lsol / rho : 0;
        var r = _rates(gal, qg);
        return {
            aq: aq, vap: vap, lhc: lhc, loss: loss, solution_lb_d: Lsol, pure_lb_d: Lsol * XL, kg_d: Lsol * 0.45359237, rho_lbgal: rho,
            gal_d: r.gal_d, L_d: r.L_d, L_hr: r.L_hr, gal_h: r.gal_h, mL_min: r.mL_min, bbl_d: r.bbl_d, gal_MMscf: r.gal_MMscf
        };
    }

    // ── ppm-basis and volume-basis chemicals (plan §4.9) ─────────────
    function doseRate(i) {
        i = i || {};
        var L = _lib(), b = i.basis, C = Number(i.dose);
        if (!L || !L.bases[b]) return { ok: false, errors: ['Unknown dose basis.'], bad: ['basis'] };
        if (b === 'wt_water') return { ok: false, errors: ['The wt % in water basis comes from the hydrate design (thermodynamic inhibitors only).'], bad: ['basis'] };
        if (b === 'gal_lb_h2s' || b === 'l_kg_h2s') return { ok: false, errors: ['Scavenger bases use scavengerDose().'], bad: ['basis'] };
        if (!(_fin(C) && C >= 0)) return { ok: false, errors: ['Dose must be 0 or more.'], bad: ['dose'] };
        var qo = Math.max(0, _num(i.qo, 0)), qw = Math.max(0, _num(i.qw, 0)), qg = Math.max(0, _num(i.qg, 0));
        var api = _num(i.api, 50), sgo = 141.5 / (131.5 + api), sgw = _num(i.sgw, 1.05), sgc = _num(i.sgc, 1);
        var qwc = _opt(i.qwCtrl, qw), g = 0, batch = null;
        // Plan §4.9: the rate is on the phase present at the point (i.phases = the point's
        // {oil, water}); total liquid is oil + water only where both are present.
        var ph = i.phases && typeof i.phases === 'object' ? i.phases : null;
        var qLiq = ph ? (ph.oil ? qo : 0) + (ph.water ? qw : 0) : qo + qw;
        switch (b) {
            case 'ppmv_oil': g = 42 * qo * C * 1e-6; break;
            case 'ppmv_water': g = 42 * qw * C * 1e-6; break;
            case 'ppmv_liq': g = 42 * qLiq * C * 1e-6; break;
            case 'ppmw_water': g = 42 * qw * C * 1e-6 * sgw / sgc; break;
            case 'ppmw_oil': g = 42 * qo * C * 1e-6 * sgo / sgc; break;
            case 'pt_mmscf': g = qg * C / 8; break;
            case 'gal_mmscf': g = qg * C; break;
            case 'l_1e6sm3': g = qg * 0.028316846592 * C / GAL_L; break;
            case 'vol_water': g = Math.max(0, qwc) * 42 * C / 100; break;
            case 'ppm_per_ppm_liq': g = 42 * qo * (C * Math.max(0, _num(i.h2sOil, 0))) * 1e-6 * sgo / sgc; break;
            case 'ppm_per_ppm_o2': g = 42 * qw * (C * Math.max(0, _num(i.o2, 0.5))) * 1e-6 * sgw / sgc; break;
            case 'batch_gal': g = 0; batch = C; break;
        }
        var r = _rates(g, qg), act = _opt(i.activePct, NaN);
        r.ok = true; r.basis = b; r.phase = L.bases[b].phase; r.dose = C; r.batch_gal = batch; r.sgo = sgo;
        r.activePpm = (/^ppm[vw]_/.test(b) && _fin(act)) ? C * act / 100 : null;
        return r;
    }

    // ── H2S scavenger (gas-phase line rate; plan §4.8) ───────────────
    function scavRatio(i) {
        i = i || {};
        var mw = Number(i.mw), n = Number(i.nH2S), a = Number(i.activePct), sg = Number(i.sg), eff = Number(i.eff);
        if (!(mw > 0 && n > 0 && a > 0 && a <= 100 && sg > 0 && eff > 0 && eff <= 1)) return { ok: false, errors: ['Scavenger stoichiometry needs MW, H2S per molecule, active %, SG and utilisation (0–1).'], bad: ['eff'] };
        var th = (mw / (n * MW_H2S)) / (a / 100 * LB_GAL * sg), effMin = th / 10, clamped = false, e = eff;
        if (e < effMin) { e = effMin; clamped = true; }
        var R = th / e;
        return { ok: true, theo_galPerLb: th, galPerLb: R, lbProdPerLb: R * LB_GAL * sg, eff: e, effClamped: clamped, effMin: effMin };
    }
    function scavengerDose(i) {
        i = i || {};
        var qg = Math.max(0, _num(i.qg, 0)), yin = _num(i.yin, 0), yout = _num(i.yout, 4), R = Number(i.galPerLb), vm = _opt(i.vm, _vm());
        var gasPhase = i.gasPhase !== false, verdicts = [];
        var out = { ok: true, gas: null, liq_lb_d: 0, removed_lb_d: 0, galPerLb: R, verdicts: verdicts };
        var liq = i.liq || {}, liqLb = 0;
        if (i.upstreamOfSep !== false || i.oilPhase) liqLb += Math.max(0, _num(liq.qo, 0)) * LB_BBL * _num(liq.sgo, 0.85) * Math.max(0, _num(liq.ppmwO, 0)) * 1e-6;
        if (i.upstreamOfSep !== false || i.waterPhase) liqLb += Math.max(0, _num(liq.qw, 0)) * LB_BBL * _num(liq.sgw, 1.05) * Math.max(0, _num(liq.ppmwW, 0)) * 1e-6;
        out.liq_lb_d = liqLb;
        if (gasPhase) {
            if (!(yin > 0)) verdicts.push(_V('ok', 'no_h2s', 'No H2S: no scavenger needed.'));
            else if (yout >= yin) verdicts.push(_V('ok', 'below_target', 'Inlet is already at or below the target.'));
            else if (!(qg > 0)) verdicts.push(_V('bad', 'needs_gas', 'Scavenger dosing on gas needs a gas rate.'));
            else {
                var f = G.WTS_h2s_scavenger;
                var r = typeof f === 'function' ? f(qg, yin, yout, Math.min(10, Math.max(0.1, R))) : null;
                if (r && r.ok) out.gas = r;
                else if (r) verdicts.push(_V('bad', 'engine', r.errors.join(' ')));
                else out.gas = { lb_d: qg * 1e6 * (yin - yout) * 1e-6 / vm * MW_H2S };
            }
        }
        if (!gasPhase && !(liqLb > 0)) verdicts.push(_V('ok', 'no_h2s', 'No H2S in this phase: no scavenger needed.'));
        out.removed_lb_d = (out.gas ? out.gas.lb_d : 0) + liqLb;
        var g = out.removed_lb_d * (_fin(R) ? R : 0), r2 = _rates(g, qg);
        for (var k in r2) out[k] = r2[k];
        if (out.removed_lb_d > 200) verdicts.push(_V('warn', 'high_load', 'High H2S load (above ' + F.lbD(200) + '): consider a contactor vessel or an alternative treatment; liquid direct injection is commonly economic only below about ' + F.lbD(100) + ' to ' + F.lbD(200) + '.'));
        return out;
    }

    // ── Pumps (plan §4.10) ───────────────────────────────────────────
    function _area(d) { return Math.PI / 4 * d * d; }
    function _pumpRec(p) {
        var L = _lib();
        if (p && typeof p === 'object') return p;
        return L ? L.pump(p) : null;
    }
    function _band(pct, B) {
        if (!_fin(pct)) return 'red';
        if (pct > B.a || pct < B.min) return 'red';
        if (pct > B.g || pct < B.low) return 'amber';
        return 'green';
    }
    function _bands(i) {
        var g = _opt(i.bandG, 70), a = _opt(i.bandA, 85);
        return { g: g, a: Math.max(a, g), low: 20, min: 10 };
    }
    function _etaAuto(beta, pReq, Lmax, L) {
        var b = _fin(beta) ? beta : 3.1e-6, pd = Math.max(0, _fin(pReq) ? pReq : 0), r = 0.5 * ((Lmax > 0 && L > 0) ? Lmax / L : 1);
        return Math.max(0.3, 1 - b * pd * (1 + r) - 0.03);
    }
    // Pressure rating of the pump itself (the default MAWP of the discharge circuit): the body
    // rating of a pneumatic or air-driven pump, not its drive-limited output; the rod-load rating
    // of an electric plunger pump at this plunger; the nameplate of a metering pump.
    function _ratingOf(P, c, pMax) {
        if ((P.pmaxRule === 'pneumatic' || P.pmaxRule === 'ratio') && _fin(P.bodyPsi)) return P.bodyPsi;
        return pMax;
    }
    function _pmaxOf(P, c, psup) {
        switch (P.pmaxRule) {
            case 'pneumatic': return Math.min(P.bodyPsi || 10000, (P.etaM || 0.8) * psup * _area(c.actD) / (c.heads * _area(c.plunger)));
            case 'rod': return Math.min(P.capPsi || 15000, c.rod / _area(c.plunger));
            case 'ratio': return P.bodyPsi ? Math.min(P.bodyPsi, c.ratio * psup) : c.ratio * psup;
            default: return _fin(c.pmax) ? c.pmax : (P.pmax || 0);
        }
    }
    // Normalise one pump configuration from the preset and line overrides.
    function _cfg(i) {
        var P = _pumpRec(i.pump);
        if (!P) return null;
        var c = {
            P: P, key: P.key, kind: P.kind, setting: P.setting,
            plunger: _opt(i.plunger_in, P.plungerDef != null ? P.plungerDef : 0.875),
            stroke: _opt(i.stroke_in, P.strokeDef != null ? P.strokeDef : 1),
            heads: Math.max(1, Math.round(_opt(i.heads, 1))),
            actD: _opt(i.actD_in, P.actDef != null ? P.actDef : 4),
            spmMax: _opt(i.spmMax, P.setting === 'stroke_speed' && P.kind === 'plunger' ? (P.spmCrank || 120) : (P.spmMax || 60)),
            qRated_galh: _opt(i.qRated_galh, P.qRated_galh),
            pmax: _opt(i.pmax, P.pmax),
            q0_galh: _opt(i.q0_galh, P.q0_galh),
            // The pressure ratio is an air-driven liquid pump input only: an air-operated diaphragm
            // pump is about 1:1 whatever a hidden field left over from another pump type holds.
            ratio: P.kind === 'airliquid' ? _opt(i.ratio, P.ratio) : (P.ratio || 1),
            vcyc: P.kind === 'airliquid' ? _opt(i.vcyc_in3, P.vcyc_in3) : P.vcyc_in3,
            rod: _opt(i.rod, P.rodLbf || 2500),
            vfd: _has(i, 'vfd') ? !!i.vfd : !!P.vfd
        };
        if (P.kind === 'plunger' && P.setting === 'spm' && c.heads > 2) c.heads = 2;
        return c;
    }
    function pumpSetting(i) {
        i = i || {};
        var c = _cfg(i);
        if (!c) return { ok: false, errors: ['Unknown pump type.'], bad: ['pump'] };
        var P = c.P, rate = Math.max(0, _num(i.rate_gal_d, 0)), peakF = _opt(i.peakF, 1.25), minF = _opt(i.minF, 0.5);
        var B = _bands(i), psup = _opt(i.psup, 100), pReq = _opt(i.pReq, 0), pRating = _opt(i.pRating, pReq);
        var pFlow = Math.min(pReq, _opt(i.pFlow, pReq));   // discharge pressure while the well flows
        var verdicts = [], warnings = [], why = [];
        var o = {
            ok: true, pump: P.key, name: P.short, kind: P.kind, setting: P.setting, electric: !!P.electric, vents: !!P.vents,
            rate_gal_d: rate, peak_gal_d: rate * peakF, peakF: peakF, noFlow: !(rate > 0), pReq: pReq, pFlow: pFlow, pRating: pRating,
            pct: 0, peakPct: 0, band: 'green', feasible: true, why: why, whyText: '', pMax: null, pumpRating: null, pOk: true, verdicts: verdicts, warnings: warnings
        };
        var hazTxt = 'Electric pump in a classified area: motor and controls must be certified for the zone (API RP 500/505).';
        if (P.electric && i.haz === 'yes' && !i._lite) verdicts.push(_V('warn', 'haz_electric', hazTxt));
        if (P.kind === 'hand') {
            o.feasible = false; why.push('batch'); o.whyText = 'batch only';
            verdicts.push(_V('warn', 'hand', 'Hand pump: batch filling only, not continuous dosing.'));
            o.pMax = P.pmax || 0; o.pumpRating = o.pMax; o.deliverable = false; return o;
        }
        o.pMax = _pmaxOf(P, c, psup);
        o.pumpRating = _ratingOf(P, c, o.pMax);
        o.pOk = o.pMax >= pRating - 1e-9;
        if (P.kind === 'plunger') {
            var eta = _blank(i.eta) ? _etaAuto(i.beta, pReq, P.strokeMax || c.stroke, c.stroke) : _opt(i.eta, P.etaDef || 0.9);
            var Vs = _area(c.plunger) * c.stroke, VsmL = Vs * ML_IN3;
            o.plunger_in = c.plunger; o.stroke_in = c.stroke; o.heads = c.heads; o.eta = eta;
            o.Vs_in3 = Vs; o.Vs_mL = VsmL; o.del_mL = VsmL * eta;
            if (eta < 0.80) verdicts.push(_V('warn', 'eta_low', 'Volumetric efficiency ' + _grp(eta, 2) + ' is below 0.80: check valves, packing or gas lock.'));
            if (P.setting === 'spm') {
                o.actD_in = c.actD; o.spmMax = c.spmMax; o.spmMinStable = P.spmMin || 3;
                var qPer = c.heads * Vs * 1440 / IN3_GAL * eta;
                o.galPerSpm = qPer;
                o.spm = rate / qPer; o.spmPeak = o.spm * peakF; o.spmMin = o.spm * minF;
                o.pct = 100 * o.spm / c.spmMax; o.peakPct = o.pct * peakF;
                o.sPerStroke = o.spm > 0 ? 60 / o.spm : null; o.per15 = o.spm / 4;
                var ps = Math.max(20, c.heads * pReq * _area(c.plunger) / ((P.etaM || 0.8) * _area(c.actD)) + (P.pSpring != null ? P.pSpring : 5));
                o.psSet = ps; o.gasOk = ps <= psup + 1e-9;
                if (o.pct > B.a) why.push('rate');
                else if (o.peakPct > B.a) why.push('peak');
                if (!o.noFlow && o.spmMin < o.spmMinStable) why.push('turndown');
                if (!o.pOk) why.push('pressure');
                if (!o.gasOk) why.push('drivegas');
            } else {
                // Electric plunger metering pump: % stroke (× % speed with a variable-speed drive)
                o.spmCrank = c.spmMax;
                var qmax = c.heads * Vs * 1440 / IN3_GAL * c.spmMax * eta;
                _meterSet(o, rate, qmax, P, c.vfd, peakF, minF, B, why);
                o.mLperStroke = VsmL * o.S / 100; o.del_mL = o.mLperStroke * eta;
                o.pulse = c.spmMax * o.N / 100;
                o.hhp = rate / 1440 * pReq / 1714; o.hhpRating = rate / 1440 * pRating / 1714;
                if (!o.pOk) why.push('pressure');
            }
        } else if (P.kind === 'meter') {
            var qm = (c.qRated_galh || 0) * 24;
            o.qRated_galh = c.qRated_galh;
            _meterSet(o, rate, qm, P, true, peakF, minF, B, why);
            o.pulse = c.spmMax * o.N / 100; o.spmMax = c.spmMax;
            o.mLperStroke = o.pulse > 0 ? (rate * GAL_L * 1000 / 1440) / o.pulse : 0;
            o.hhp = rate / 1440 * pReq / 1714;
            if (!o.pOk) why.push('pressure');
        } else if (P.kind === 'airliquid') {
            var q0 = (c.q0_galh || 0) * 24, r = c.ratio || 1, stall = r * psup;
            o.q0_gal_d = q0; o.ratio = r; o.vcyc_in3 = c.vcyc; o.stallAvail = stall;
            o.qAtPreq = Math.max(0, q0 * (1 - pReq / stall));
            function air(q, pd) { return (q < q0) ? pd / (r * (1 - q / q0)) : null; }
            // Design and peak settings at P_req (the shut-in case upstream of the choke: the
            // feasibility, stall and drive-gas basis); the operating setting while the well flows
            // is at the flowing discharge pressure, where the shut-in setting over-delivers.
            o.airDesign = air(rate, pReq); o.airPeak = air(rate * peakF, pReq);
            o.airFlow = air(rate, pFlow); o.airFlowPeak = air(rate * peakF, pFlow);
            o.cyclesMin = c.vcyc > 0 ? rate * IN3_GAL / 1440 / c.vcyc : null;
            o.cyclesPeak = o.cyclesMin != null ? o.cyclesMin * peakF : null;
            o.pStallDesign = o.airDesign != null ? r * o.airDesign : null;
            o.pct = o.airDesign != null ? 100 * o.airDesign / psup : 999;
            o.peakPct = o.airPeak != null ? 100 * o.airPeak / psup : 999;
            var stallMax = (P.stallFracMax || 0.7) * stall, qMin = (P.q0FracMin || 0.1) * q0;
            if (!o.noFlow && (o.airPeak == null || rate * peakF > o.qAtPreq + 1e-9 || o.peakPct > B.a)) why.push('rate');
            if (pReq > stallMax) why.push('pressure');
            else if (!o.pOk) why.push('pressure');
            if (!o.noFlow && rate < qMin) why.push('turndown');
            o.psSet = o.airPeak; o.gasOk = o.airPeak != null && o.airPeak <= psup + 1e-9;
            if (!o.noFlow && !i._lite) {
                verdicts.push(_V('warn', 'air_verify', 'Air-driven pump: set the air and verify the rate with a drawdown cylinder or meter. Stall at this setting is ' +
                    (o.pStallDesign != null ? F.pG(o.pStallDesign) : 'not reached') + '; the discharge relief valve is the overpressure protection.'));
                if (pReq > stallMax) verdicts.push(_V('bad', 'air_stall', 'Required ' + F.pG(pReq) + ' is above 0.7 × the stall pressure (' + F.pG(stall) + ' at full air): the pump runs near stall.'));
                if (rate < qMin) verdicts.push(_V('warn', 'air_lowflow', 'Design flow is below 0.1 × the free flow: the pump cycles erratically at low flow.'));
                if (o.airPeak == null || rate * peakF > o.qAtPreq + 1e-9) verdicts.push(_V('bad', 'air_rate', 'Air-driven pump cannot deliver the peak ' + F.galD(rate * peakF) + ' at ' + F.pG(pReq) + ' (' + F.galD(o.qAtPreq) + ' at full air).'));
            }
        } else if (P.kind === 'transfer') {
            var qf = (c.q0_galh || 0) * 24;
            o.q0_gal_d = qf; o.f = qf > 0 ? rate / qf : 0;
            o.pct = 100 * o.f; o.peakPct = o.pct * peakF;
            o.cyclesMin = (c.spmMax || 200) * o.f; o.cyclesPeak = o.cyclesMin * peakF;
            o.psSet = pReq; o.gasOk = pReq <= psup + 1e-9;
            if (o.peakPct > B.a) why.push('rate');
            if (!o.noFlow && o.f * minF < 0.10) why.push('turndown');
            if (!o.pOk) why.push('pressure');
            if (!o.gasOk) why.push('drivegas');
            if (!o.noFlow && !i._lite) verdicts.push(_V('warn', 'transfer', 'Air-operated diaphragm pump: a coarse transfer pump, not a metering pump.'));
        }
        // Can the pump deliver the design rate at P_req at all (capacity, pressure, drive gas)?
        // Narrower than `feasible`, which also wants start-up headroom, turndown and the rating margin.
        var canQ = true;
        if (P.kind === 'plunger') canQ = P.setting === 'spm' ? o.pct <= 100 + 1e-9 : o.f <= 1 + 1e-9;
        else if (P.kind === 'meter') canQ = o.f <= 1 + 1e-9;
        else if (P.kind === 'airliquid') canQ = o.airDesign != null && o.airDesign <= psup + 1e-9;
        else if (P.kind === 'transfer') canQ = o.pct <= 100 + 1e-9;
        var gasQ = ((P.kind === 'plunger' && P.setting === 'spm') || P.kind === 'transfer') ? o.gasOk !== false : true;
        o.deliverable = canQ && o.pMax >= pReq - 1e-9 && gasQ;
        o.band = _band(o.pct, B);
        o.peakBand = _band(o.peakPct, B);
        if (o.noFlow) { o.why = []; o.feasible = true; o.whyText = 'no flow required'; return o; }
        o.feasible = why.length === 0;
        if (!i._lite) { o.whyText = _whyText(o, why); _pumpVerdicts(o, i, B, why); }
        return o;
    }
    function _meterSet(o, rate, qmax, P, vfd, peakF, minF, B, why) {
        var f = qmax > 0 ? rate / qmax : Infinity, sMin = P.sMin || 10, nMin = P.nMin || 10;
        var fMin = Math.max(0.10, sMin / 100 * nMin / 100), S, N;
        if (!vfd) { N = 100; S = 100 * f; }
        else if (f >= 0.5) { S = 100; N = 100 * f; }
        else { S = Math.max(sMin, Math.ceil(200 * f / 5 - 1e-9) * 5); N = 100 * f / (S / 100); }
        var alt = null;
        if (vfd && _fin(f)) {
            var Sa = S <= 90 ? S + 10 : S - 10;
            if (Sa >= sMin) alt = { S: Sa, N: 100 * f / (Sa / 100) };
        }
        o.qMax_gal_d = qmax; o.f = f; o.S = S; o.N = N; o.alt = alt; o.vfd = !!vfd; o.fMin = fMin; o.sMin = sMin; o.nMin = nMin;
        o.pct = 100 * f; o.peakPct = o.pct * peakF;
        o.turndownN = (f > 0 && f < fMin) ? Math.ceil(0.25 / f - 1e-9) : null;
        if (f > 0.9 || o.pct > B.a) why.push('rate');
        else if (o.peakPct > B.a) why.push('peak');
        if (rate > 0 && f * minF < fMin) why.push('turndown');
    }
    function _whyText(o, why) {
        return why.map(function (w) {
            switch (w) {
                case 'rate': return 'rate ' + _grp(o.pct, 0) + ' %';
                case 'peak': return 'peak ' + _grp(o.peakPct, 0) + ' %';
                case 'turndown': return 'below turndown';
                case 'pressure': return 'pressure (maximum ' + F.pG(o.pMax) + ')';
                case 'drivegas': return 'drive gas ' + F.pSet(o.psSet) + ' needed';
                default: return w;
            }
        }).join(', ');
    }
    function _pumpVerdicts(o, i, B, why) {
        var V = o.verdicts;
        if (o.kind === 'plunger' && o.setting === 'spm') {
            var nx = nextPlunger(i, o);
            o.nextPlunger = nx;
            var nxt = nx ? ' Next plunger: ' + F.inch(nx.plunger_in) + ' at ' + _grp(nx.spm, 1) + ' SPM.' : '';
            if (o.pct > 100) V.push(_V('bad', 'spm_over', _grp(o.spm, 1) + ' SPM is above the ' + _grp(o.spmMax, 0) + ' SPM maximum: the pump cannot deliver ' + F.galD(o.rate_gal_d) + '.' + nxt));
            else if (o.pct > B.a || o.peakPct > B.a) V.push(_V('warn', 'spm_headroom', _grp(o.spm, 1) + ' SPM is ' + _grp(o.pct, 0) + ' % of the ' + _grp(o.spmMax, 0) + ' SPM maximum, leaving no start-up headroom.' + nxt));
            if (o.spm < o.spmMinStable) V.push(_V('bad', 'spm_min', _grp(o.spm, 1) + ' SPM is below the stable minimum of ' + _grp(o.spmMinStable, 0) + ' SPM.' + nxt));
            else if (why.indexOf('turndown') !== -1) V.push(_V('warn', 'spm_min', 'Minimum rate runs at ' + _grp(o.spmMin, 1) + ' SPM, below the stable ' + _grp(o.spmMinStable, 0) + ' SPM.' + nxt));
        } else if (o.setting === 'stroke_speed') {
            if (o.f > 0.9) V.push(_V('bad', 'meter_full', 'Required rate is ' + _grp(o.pct, 0) + ' % of the pump maximum: no headroom. Use a larger pump or head.'));
            else if (o.peakPct > B.a) V.push(_V('warn', 'meter_peak', 'Peak rate is ' + _grp(o.peakPct, 0) + ' % of the pump maximum, leaving no start-up headroom.'));
            if (o.f < o.fMin) V.push(_V('warn', 'turndown', 'Below pump turndown: dilute 1 : ' + Math.ceil(0.25 / Math.max(o.f, 1e-9) - 1e-9) + ' in a compatible carrier or use a smaller head.'));
            else if (why.indexOf('turndown') !== -1) V.push(_V('warn', 'turndown_min', 'At the minimum rate the pump is below its turndown (' + _grp(100 * o.fMin, 0) + ' % of maximum): use a smaller head or dilute.'));
        }
        if (!o.pOk && o.kind === 'plunger' && o.setting === 'spm') {
            var P = _pumpRec(i.pump), c = _cfg(i), dmax = '';
            var dm = Math.sqrt(4 / Math.PI * (P.etaM || 0.8) * _opt(i.psup, 100) * _area(c.actD) / (c.heads * o.pRating));
            var fits = (P.plungers || []).filter(function (d) { return d <= dm + 1e-9; });
            if (fits.length) dmax = ' (' + F.inch(fits[fits.length - 1]) + ' or less)';
            V.push(_V('bad', 'pressure', 'Pump cannot reach ' + F.pG(o.pRating) + ' with a ' + F.inch(o.plunger_in) + ' plunger (maximum ' + F.pG(o.pMax) + '). Use a smaller plunger' + dmax + ', a larger actuator, an air-driven pump or an electric plunger metering pump.'));
        } else if (!o.pOk && o.kind === 'plunger') {
            // Electric plunger: the rod load sets the pressure; no actuator to change.
            V.push(_V('bad', 'pressure', 'Pump cannot reach ' + F.pG(o.pRating) + ' with a ' + F.inch(o.plunger_in) + ' plunger (rod-load maximum ' + F.pG(o.pMax) + '). Use a smaller plunger, a frame with a higher rod load or an air-driven liquid pump.'));
        } else if (!o.pOk && o.kind !== 'airliquid') {
            // Metering diaphragm or transfer pump: a fixed pressure rating, no plunger or actuator.
            V.push(_V('bad', 'pressure', 'Pump cannot reach ' + F.pG(o.pRating) + ' (maximum ' + F.pG(o.pMax) + '). Choose a pump rated for at least ' + F.pG(o.pRating) + ': an electric plunger metering pump or an air-driven liquid pump.'));
        } else if (!o.pOk) {
            V.push(_V('bad', 'pressure', 'Pump cannot reach ' + F.pG(o.pRating) + ' (maximum ' + F.pG(o.pMax) + '). Raise the drive air, or use a higher-ratio air-driven pump or an electric plunger metering pump.'));
        }
    }
    // Next plunger for a pneumatic plunger pump: design or peak > 85 % → the smallest larger plunger;
    // minimum below the stable SPM → the largest smaller plunger. Either way the suggestion must be
    // feasible itself (§4.10.5): peak ≤ the amber limit, minimum ≥ the stable SPM, P_max ≥ the
    // rating and the drive gas enough at the design pressure; otherwise no suggestion.
    function nextPlunger(i, o) {
        var P = _pumpRec(i.pump);
        if (!P || P.kind !== 'plunger' || P.setting !== 'spm' || !o || o.noFlow) return null;
        var B = _bands(i), pk = _opt(i.peakF, 1.25), list = (P.plungers || []).slice().sort(function (a, b) { return a - b; });
        var up = o.pct > B.a || o.peakPct > B.a, down = !up && o.spmMin < o.spmMinStable;
        if (!up && !down) return null;
        var cand = up ? list.filter(function (d) { return d > o.plunger_in + 1e-9; }) : list.filter(function (d) { return d < o.plunger_in - 1e-9; }).reverse();
        for (var k = 0; k < cand.length; k++) {
            var j = {}, key;
            for (key in i) if (_has(i, key)) j[key] = i[key];
            j.plunger_in = cand[k];
            var r = _plungerQuick(j);
            if (!r.pOk || !r.gasOk || r.pct * pk > B.a + 1e-9 || r.spmMin < r.spmMinStable) continue;
            return { plunger_in: cand[k], spm: r.spm, pct: r.pct, peakPct: r.pct * pk, pMax: r.pMax };
        }
        return null;
    }
    function _plungerQuick(i) {
        var c = _cfg(i), P = c.P, psup = _opt(i.psup, 100), pReq = _opt(i.pReq, 0), pRating = _opt(i.pRating, pReq);
        var eta = _blank(i.eta) ? _etaAuto(i.beta, pReq, P.strokeMax || c.stroke, c.stroke) : _opt(i.eta, P.etaDef || 0.9);
        var spm = Math.max(0, _num(i.rate_gal_d, 0)) / (c.heads * _area(c.plunger) * c.stroke * 1440 / IN3_GAL * eta);
        var pMax = _pmaxOf(P, c, psup);
        var ps = Math.max(20, c.heads * pReq * _area(c.plunger) / ((P.etaM || 0.8) * _area(c.actD)) + (P.pSpring != null ? P.pSpring : 5));
        return { spm: spm, pct: 100 * spm / c.spmMax, spmMin: spm * _opt(i.minF, 0.5), spmMinStable: P.spmMin || 3, pMax: pMax, pOk: pMax >= pRating - 1e-9,
            psSet: ps, gasOk: ps <= psup + 1e-9 };
    }
    // Pump options: every candidate, ranked (§4.10.6).
    function pumpOptions(i) {
        i = i || {};
        var L = _lib();
        if (!L) return { ok: false, errors: ['Chemical library not loaded.'], bad: [] };
        var haz = i.haz === 'yes', cands = [], byPump = {};
        function base() { var j = {}, k; for (k in i) if (_has(i, k) && k !== 'current') j[k] = i[k]; return j; }
        var J = base();                       // one reusable candidate input (pumpSetting keeps no reference)
        J._lite = true;
        function add(P, d, s, h, a) {
            J.pump = P.key; J.plunger_in = d; J.stroke_in = s; J.heads = h;
            if (a != null) J.actD_in = a;
            var own = P.key === i.pump;
            J.spmMax = own ? i.spmMax : undefined; J.rod = own ? i.rod : undefined;
            J.qRated_galh = own ? i.qRated_galh : undefined; J.pmax = own ? i.pmax : undefined;
            J.q0_galh = own ? i.q0_galh : undefined; J.ratio = own ? i.ratio : undefined; J.vcyc_in3 = own ? i.vcyc_in3 : undefined;
            var r = pumpSetting(J);
            if (!r.ok) return;
            var c = {
                pump: r.pump, name: r.name, kind: r.kind, setting: r.setting, electric: r.electric, label: null,
                plunger_in: r.plunger_in || null, stroke_in: r.stroke_in || null, heads: r.heads || null, actD_in: r.actD_in || null,
                pct: r.pct, peakPct: r.peakPct, pMax: r.pMax, feasible: r.feasible, why: r.why, whyText: null,
                spm: r.spm != null ? r.spm : null, S: r.S != null ? r.S : null, N: r.N != null ? r.N : null,
                airDesign: r.airDesign != null ? r.airDesign : null, airPeak: r.airPeak != null ? r.airPeak : null,
                cyclesMin: r.cyclesMin != null ? r.cyclesMin : null, psSet: r.psSet != null ? r.psSet : null, _r: r
            };
            cands.push(c);
            var bp = byPump[c.pump] || (byPump[c.pump] = { feasible: 0, total: 0, rateOnly: 0, pressureOnly: 0 });
            bp.total++; if (c.feasible) bp.feasible++;
            if (!c.feasible) {
                var rate = c.why.some(function (w) { return w === 'rate' || w === 'peak' || w === 'turndown'; });
                var pres = c.why.some(function (w) { return w === 'pressure' || w === 'drivegas'; });
                if (rate && !pres) bp.rateOnly++;
                if (pres && !rate) bp.pressureOnly++;
            }
        }
        function finish(c) {
            if (c.label == null) {
                c.label = c.kind === 'plunger'
                    ? (c.actD_in != null && c.setting === 'spm' ? c.actD_in + ' in actuator, ' : '') + _frac(c.plunger_in) + ' × ' + _frac(c.stroke_in) + ' in' + (c.heads > 1 ? ', ' + c.heads + ' heads' : '')
                    : c.name;
                c.whyText = _whyText(c._r, c.why);
            }
            delete c._r;
            return c;
        }
        L.pumps.forEach(function (P) {
            if (!P.mvp) return;
            if (P.kind === 'plunger') {
                var pls = P.plungers || [], sts = P.strokes || [1], hmax = P.headsMax || 1, acts = P.setting === 'spm' ? (P.actuators || [4]) : [null];
                for (var a1 = 0; a1 < pls.length; a1++) for (var b1 = 0; b1 < sts.length; b1++) for (var h = 1; h <= hmax; h++) for (var c1 = 0; c1 < acts.length; c1++) add(P, pls[a1], sts[b1], h, acts[c1]);
            } else add(P, undefined, undefined, undefined, null);
        });
        function dist(p) { return p < 40 ? 40 - p : p > 50 ? p - 50 : 0; }
        var ranked = cands.slice().sort(function (a, b) {
            if (a.feasible !== b.feasible) return a.feasible ? -1 : 1;
            if (haz && a.electric !== b.electric) return a.electric ? 1 : -1;
            var ha = a.heads || 1, hb = b.heads || 1;
            if (ha !== hb) return ha - hb;
            var da = dist(a.pct), db = dist(b.pct);
            if (Math.abs(da - db) > 1e-9) return da - db;
            if ((b.plunger_in || 0) !== (a.plunger_in || 0)) return (b.plunger_in || 0) - (a.plunger_in || 0);
            return (b.stroke_in || 0) - (a.stroke_in || 0);
        });
        var feas = ranked.filter(function (c) { return c.feasible; });
        var reason = '';
        if (!feas.length) {
            // Too much flow (rate / peak), too little (below turndown only) or too much pressure.
            var has = function (c, w) { return c.why.indexOf(w) !== -1; };
            var pres = function (c) { return has(c, 'pressure') || has(c, 'drivegas'); };
            var highLim = cands.some(function (c) { return !pres(c) && (has(c, 'rate') || has(c, 'peak')); });
            var lowLim = cands.some(function (c) { return !pres(c) && has(c, 'turndown') && !has(c, 'rate') && !has(c, 'peak'); });
            var presLim = cands.some(function (c) { return pres(c) && !has(c, 'rate') && !has(c, 'peak') && !has(c, 'turndown'); });
            var parts = [];
            if (highLim) parts.push('rate-limited: two pumps in parallel, an air-driven liquid pump, an electric plunger pump or a skid');
            if (lowLim) parts.push('below turndown: dilute in a compatible carrier or use a smaller metering pump or head');
            if (presLim) parts.push('pressure-limited: a smaller plunger, a larger actuator, an air-driven pump or an electric plunger pump');
            reason = 'No feasible pump option (' + (parts.join('; ') || 'check the inputs') + ').';
        }
        var cur = null;
        if (i.current) {
            var cj = base(); for (var k in i.current) if (_has(i.current, k)) cj[k] = i.current[k];
            cur = pumpSetting(cj);
        }
        var top = feas.slice(0, 3).map(finish);
        var out = { ok: true, ranked: top, current: cur, nextPlunger: cur && cur.nextPlunger ? cur.nextPlunger : null, reason: reason, byPump: byPump, count: cands.length };
        if (i.all) out.candidates = ranked.map(finish);
        return out;
    }

    // ── Discharge pressure (plan §4.11.1) ────────────────────────────
    function injectionPressure(i) {
        i = i || {};
        var L = _lib(), pt = L && L.point(i.point);
        if (!pt) return { ok: false, errors: ['Unknown injection point.'], bad: ['point'] };
        var sithp = _num(i.sithp, 3500), fwhp = _num(i.fwhp, 3000), pck = _num(i.pck, 1000), psep = _num(i.psep, 1000);
        var psv = _num(i.psvsep, 1440), whc = _num(i.whclass, 5000), dpq = _opt(i.dpq, 50);
        var mp = _opt(i.marginPct, 10), ma = _opt(i.marginAbs, 100), pbpv = _opt(i.pbpv, NaN);
        var verdicts = [], warnings = [], pLine, pBack;
        switch (pt.pLine) {
            case 'dh': case 'wh': pLine = Math.max(sithp, fwhp); break;
            case 'ck': pLine = pck; break;
            case 'sep': pLine = psep; break;
            case 'bpv': pLine = _fin(pbpv) ? pbpv : 0; if (!_fin(pbpv)) warnings.push('Flare-line pressure not entered: ' + F.pG(0) + ' assumed.'); break;
            default: pLine = 0;
        }
        var cls = i.rateBasis === 'class';
        var bk = cls ? pt.pBackClass : pt.pBack;
        pBack = bk === 'sithp' ? sithp : bk === 'whclass' ? whc : bk === 'psvsep' ? psv : 0;
        var pReq = pLine + dpq;
        // While the well flows the line upstream of the choke is at FWHP, not the shut-in case.
        var pReqFlow = (pt.pLine === 'dh' || pt.pLine === 'wh') ? fwhp + dpq : pReq;
        var pRating = Math.max(pReq * (1 + mp / 100), pReq + ma, pBack * (1 + mp / 100), pBack + ma);
        // Blank MAWP = the pump's own pressure rating (body rating for pneumatic and air-driven
        // pumps, never their drive-limited output); pumpPmax is the older name of the same input.
        var mawpIn = _opt(i.mawp, NaN), pumpP = _opt(i.pumpRating, _opt(i.pumpPmax, NaN));
        var mawp = _fin(mawpIn) ? mawpIn : (_fin(pumpP) ? pumpP : null);
        var lo = Math.max(1.10 * pReq, pBack), hi = mawp;
        var band = { lo: lo, hi: hi, ok: hi == null ? null : lo <= hi + 1e-9 };
        var chem = L.find(i.chem), dPdT = chem ? chem.dPdT : null;
        if (pt.key === 'dh') warnings.push('Downhole hydrostatic head, capillary friction and the injection-valve set pressure are not included: the surface figure is a minimum.');
        if (pt.wellbore && mawp != null && mawp < sithp) verdicts.push(_V('bad', 'below_sithp', 'Discharge circuit rated ' + F.pG(mawp) + ', below the shut-in wellhead pressure ' + F.pG(sithp) + '.'));
        if (pt.wellbore && _fin(whc) && sithp > whc) verdicts.push(_V('bad', 'class', 'SITHP exceeds the flowhead class (' + F.pG(sithp) + ' against ' + F.pG(whc) + ').'));
        if (mawp != null && mawp < pRating - 1e-9) verdicts.push(_V('bad', 'below_rating', 'Discharge circuit rated ' + F.pG(mawp) + ', below the required rating ' + F.pG(pRating) + '.'));
        if (band.ok === false) verdicts.push(_V('bad', 'psv_band', 'Relief valve band is empty: the set pressure must be at least ' + F.pG(lo) + ' but the circuit MAWP is ' + F.pG(hi) + '.'));
        var advice = [];
        if (pt.key === 'tank') verdicts.push(_V('warn', 'anti_siphon', 'Atmospheric tank: fit an anti-siphon / back-pressure valve set at least ' + F.dp(25) + ' above the suction head.'));
        else advice.push(_V('warn', 'backflow', BACKFLOW));
        if (dPdT != null) advice.push(_thermalV(chem.short, dPdT));
        return {
            ok: true, point: pt.key, pLine: pLine, pBack: pBack, pBackBasis: bk, rateBasis: cls ? 'class' : 'credible',
            breakdown: { line: pLine, allowance: dpq, friction: 0, hydrostatic: 0, civ: 0 },
            pReq: pReq, pReqFlow: pReqFlow, pReqShutin: pReq, pRating: pRating, mawp: mawp, mawpEntered: _fin(mawpIn), psvBand: band,
            dPdT_psiF: dPdT, verdicts: verdicts, advice: advice, warnings: warnings
        };
    }
    var BACKFLOW = 'Backflow: block valve, two check valves in series and a bleed at the tie-in. Size the tank vent for gas blow-by or fit a low-discharge-pressure trip; the pump PSV does not protect the tank.';
    function _thermalV(name, dPdT) {
        return _V('warn', 'thermal', 'Thermal relief on any blockable liquid-full section, or a lock-open procedure: blocked-in ' + String(name).toLowerCase() + ' rises about ' + F.psiF(dPdT) + '.');
    }

    // ── Drive gas (plan §4.12.3) ─────────────────────────────────────
    function supplyGas(i) {
        i = i || {};
        var kind = i.kind, verdicts = [], vm = _opt(i.vm, _vm());
        var out = { applies: kind === 'pneumatic' || kind === 'airliquid' || kind === 'transfer', ps_set: null, stalls: false, scf_stroke: null, scf_d: null, scf_h: null,
            regDefault_scf_h: null, exhaustH2S_ppm: null, exhaustH2S_lb_d: null, gasType: i.gasType || 'air', verdicts: verdicts };
        if (!out.applies) return out;
        var psup = _opt(i.psup, 100), y = Math.max(0, _num(i.h2s_ppm, 0));
        if (kind === 'pneumatic') {
            var A = _area(_opt(i.actD_in, 4)), Lst = _opt(i.stroke_in, 1), nh = _opt(i.heads, 1), d = _opt(i.plunger_in, 0.5);
            var ps = Math.max(20, nh * _opt(i.pdDesign_psig, 0) * _area(d) / (_opt(i.etaM, 0.8) * A) + _opt(i.pSpring, 5));
            out.ps_set = ps;
            out.scf_stroke = A * Lst * (ps + 14.7) / 14.7 / 1728;
            var spm = Math.max(0, _num(i.spm, 0));
            out.scf_d = out.scf_stroke * spm * 1440; out.scf_h = out.scf_d / 24;
        } else if (kind === 'airliquid') {
            // Peak air setting; null when the pump cannot deliver the peak at any air pressure.
            var ap = Number(i.airPeak_psig);
            out.ps_set = (i.airPeak_psig == null || _blank(i.airPeak_psig) || !_fin(ap)) ? null : ap;
        } else out.ps_set = _opt(i.pdDesign_psig, 0);   // air-operated diaphragm: about 1:1
        out.stalls = !(_fin(out.ps_set) && out.ps_set <= psup + 1e-9);
        if (out.stalls) verdicts.push(_V('bad', 'gas_stall', 'Drive gas ' + F.pG(psup) + ' is too low to inject at the shut-in pressure (' + (_fin(out.ps_set) ? F.pG(out.ps_set) + ' needed' : 'not reachable') + '): the pump stalls before the well is opened.'));
        var gt = out.gasType;
        if (gt === 'sweet' || gt === 'well') {
            out.regDefault_scf_h = REG_SCF_H;
            if (gt === 'well') {
                out.exhaustH2S_ppm = y;
                out.exhaustH2S_lb_d = out.scf_d != null ? out.scf_d * y * 1e-6 * MW_H2S / vm : null;
                var ex = 'Exhaust carries ' + _grp(y, 0) + ' ppm H2S' + (out.exhaustH2S_lb_d != null ? ' (' + F.lbD4(out.exhaustH2S_lb_d) + ')' : '') + '.';
                if (y >= 10) verdicts.push(_V('bad', 'sour_drive', 'Do not drive pneumatic pumps with sour produced gas: use instrument air, nitrogen or sweet gas, or route the exhaust to flare. ' + ex));
                else verdicts.push(_V('warn', 'well_drive', 'Produced gas drives the pump and vents methane at the pump. ' + ex));
            } else verdicts.push(_V('warn', 'sweet_drive', 'Sweet fuel gas drives the pump and vents methane at the pump (regulatory default ' + F.scfH(REG_SCF_H) + ' per pump).'));
        }
        return out;
    }

    // ── Field check, calibration and supply (plan §4.12.1–2) ─────────
    function fieldCheck(rate_gal_d, peakF) {
        var q = Math.max(0, Number(rate_gal_d) || 0), pk = _fin(Number(peakF)) && peakF > 0 ? Number(peakF) : 1;
        var mlmin = q * GAL_L * 1000 / 1440, need = 1.25 * mlmin * pk;
        var cyl = null;
        for (var k = 0; k < CYLINDERS.length; k++) if (CYLINDERS[k] >= need) { cyl = CYLINDERS[k]; break; }
        return { mL_min: mlmin, mL_30s: mlmin / 2, mL_60s: mlmin, s_per_100mL: mlmin > 0 ? 6000 / mlmin : null, cylNeed_mL: need, cylinder_mL: q > 0 ? cyl : null, meterNeeded: q > 0 && cyl == null };
    }
    function calibration(i) {
        i = i || {};
        var mL = Number(i.mL), s = Number(i.s), set = Number(i.setting), tgt = Number(i.target_gal_d), kind = i.kind || 'spm', tol = _opt(i.tolPct, 5);
        if (!(mL > 0 && s > 0)) return { ok: false, errors: ['Enter the measured volume (mL) and the time (s), both above 0.'], bad: ['mL', 's'] };
        if (!(set > 0)) return { ok: false, errors: ['Enter the pump setting used during the test.'], bad: ['setting'] };
        var q = 22.8245 * mL / s, out = { ok: true, gal_d: q, mL_min: 60 * mL / s, etaActual: null, newSetting: null, withinPct: null, q0Refit_gal_d: null, pTest: null, verdicts: [] };
        if (kind === 'spm') {
            var Vs = Number(i.Vs_mL), nh = _opt(i.heads, 1);
            if (Vs > 0) out.etaActual = out.mL_min / (nh * Vs * set);
        }
        if (tgt > 0) {
            out.withinPct = 100 * (q - tgt) / tgt;
            if (kind === 'air') {
                // Q₀ is re-fitted, and the corrected air found, at the discharge pressure during the
                // test (i.pTest: the flowing line pressure + allowance by default), not at P_req.
                var pd = _opt(i.pTest, Number(i.pReq)), r = Number(i.ratio);
                out.pTest = _fin(pd) ? pd : null;
                var den = 1 - pd / (r * set);
                if (pd >= 0 && r > 0 && den > 0) {
                    var q0 = q / den;
                    out.q0Refit_gal_d = q0;
                    out.newSetting = tgt < q0 ? pd / (r * (1 - tgt / q0)) : null;
                }
            } else out.newSetting = set * tgt / q;
            if (Math.abs(out.withinPct) > tol) out.verdicts.push(_V('warn', 'cal_off', 'Calibration reads ' + _grp(out.withinPct, 1) + ' % from target: reset to ' + (out.newSetting != null ? _grp(out.newSetting, 2) : '–') + ' and re-test.'));
            else out.verdicts.push(_V('ok', 'cal_ok', 'Calibration within ' + _grp(tol, 0) + ' % of the target rate.'));
        }
        return out;
    }
    function tank(i) {
        i = i || {};
        var V = Number(i.V_gal), heel = _opt(i.heelPct, 10), q = Math.max(0, _num(i.rate_gal_d, 0)), D = _opt(i.days, 5);
        var tote = _opt(i.toteGal, 275), uf = _opt(i.toteUsableFrac, 0.9), cont = _opt(i.contingencyPct, 20), dia = _opt(i.diam_ft, NaN);
        if (!(V >= 0)) return { ok: false, errors: ['Tank volume must be 0 or more.'], bad: ['V_gal'] };
        var usable = V * (1 - heel / 100), inv = q * D * (1 + cont / 100);
        var totes = q > 0 ? Math.max(1, Math.ceil(inv / (uf * tote) - 1e-9)) : 0;
        var out = {
            ok: true, usable_gal: usable, days: q > 0 ? usable / q : null, inventory_gal: inv, totes: totes, toteChanges: Math.max(0, totes - 1),
            levelDrop_ft_d: (q > 0 && dia > 0) ? q / (5.875 * dia * dia) : null, verdicts: []
        };
        out.levelDrop_in_d = out.levelDrop_ft_d != null ? out.levelDrop_ft_d * 12 : null;
        if (q > 0 && out.days < D) out.verdicts.push(_V('warn', 'supply', 'Tank lasts ' + _grp(out.days, 2) + ' days at this rate against a ' + _grp(D, 1) + '-day test: plan ' + out.toteChanges + ' tote changes or a larger tank.'));
        return out;
    }

    // ── Compatibility of active lines (plan §5.4) ────────────────────
    function compat(lines) {
        var L = _lib(), out = [];
        if (!L) return out;
        var act = (lines || []).filter(function (l) { return l && L.find(l.chem); });
        for (var a = 0; a < act.length; a++) {
            for (var b = a + 1; b < act.length; b++) {
                if (act[a].point !== act[b].point && !(act[a].tank && act[a].tank === act[b].tank)) continue;
                var A = L.find(act[a].chem), Bc = L.find(act[b].chem);
                L.pairRules(A.key, Bc.key).forEach(function (r) {
                    out.push(_V(r.level, 'compat_' + r.key, r.level === 'bad'
                        ? A.short + ' and ' + Bc.short + ' must never share a line or tank: ' + r.text
                        : A.short + ' and ' + Bc.short + ' at the same point: ' + r.text));
                });
            }
            var c = L.find(act[a].chem);
            L.ctxRules(c.key).forEach(function (r) {
                if ((r.ctx === 'hc_tank' && act[a].point === 'tank') || (r.ctx === 'sepgas_no_ko' && act[a].point === 'sepgas')) {
                    out.push(_V(r.level, 'compat_' + r.key, c.short + ': ' + r.text));
                }
            });
        }
        return out;
    }

    // ── Page-default input (worked example H1) and cj_* id mapping ───
    var LINE_DEF = [
        { point: 'wh', chem: 'meoh', pump: 'air_liquid' },
        { point: 'wh', chem: 'ci_film_liq', pump: 'pneu_plunger' },
        { point: 'wh', chem: 'demulsifier', pump: 'pneu_plunger' },
        { point: 'sepin', chem: 'af_silicone', pump: 'elec_solenoid' },
        { point: 'wh', chem: 'h2s_mea_triazine', pump: 'pneu_plunger' },
        { point: 'dsch', chem: 'si_phosphonate', pump: 'elec_hyd_diaph' }
    ];
    function defaults() {
        var lines = LINE_DEF.map(function (d, k) {
            return {
                n: k + 1, point: d.point, chem: d.chem, basis: '', dose: '', lean: '', sgc: '', eff: '',
                pump: d.pump, plunger: d.pump === 'air_liquid' ? 0.875 : '', stroke: 1, heads: 1,
                qrated: '', pmax: '', q0: '', ratio: '', vcyc: '', tank: 275,
                active: '', water: '', peak: '', ve: 0.90, spmmax: '', actd: 4, rod: 2500, dpq: 50, mawp: '', o2: 0.5
            };
        });
        return {
            stream: { qg: 10, sg: 0.65, h2s: 0, co2: 0, n2: 0, qo: 0, api: 50, qw: 2, sgw: 1.05, wbasis: 'free', h2so: 0, h2sw: 0 },
            spread: { sithp: 3500, fwhp: 3000, fwht: 110, tamb: 60, pck: 1000, jt: 'ise', tck: 34.6, htr: 'yes', thtr: 90, psep: 1000, tsep: '',
                psvsep: 1440, whclass: 5000, haz: 'yes', supgas: 'air', pbpv: '' },
            basis: { margin: 10, fJT: 1.10, thsrc: 'tm', thuser: '', thuserp: '', method: 'auto', cond: 'buk', h2sOut: 4,
                pmpct: 10, pmabs: 100, ratebasis: 'credible', days: 5, psup: 100, fc: 0.25, glyloss: 1, sour: 5, bandG: 70, bandA: 85, minf: 0.5 },
            nlines: 1, lines: lines,
            cal: { line: 1, mL: '', s: '', setting: '', pd: '' }
        };
    }
    var IDS = {
        stream: { qg: 'cj_qg', sg: 'cj_sg', h2s: 'cj_h2s', co2: 'cj_co2', n2: 'cj_n2', qo: 'cj_qo', api: 'cj_api', qw: 'cj_qw', sgw: 'cj_sgw', wbasis: 'cj_wbasis', h2so: 'cj_h2so', h2sw: 'cj_h2sw' },
        spread: { sithp: 'cj_sithp', fwhp: 'cj_fwhp', fwht: 'cj_fwht', tamb: 'cj_tamb', pck: 'cj_pck', jt: 'cj_jt', tck: 'cj_tck', htr: 'cj_htr', thtr: 'cj_thtr',
            psep: 'cj_psep', tsep: 'cj_tsep', psvsep: 'cj_psvsep', whclass: 'cj_whclass', haz: 'cj_haz', supgas: 'cj_supgas', pbpv: 'cj_pbpv' },
        basis: { margin: 'cj_margin', fJT: 'cj_fjt', thsrc: 'cj_thsrc', thuser: 'cj_thuser', thuserp: 'cj_thuserp', method: 'cj_method', cond: 'cj_cond',
            h2sOut: 'cj_h2scus', pmpct: 'cj_pmpct', pmabs: 'cj_pmabs', ratebasis: 'cj_ratebasis', days: 'cj_days', psup: 'cj_psup', fc: 'cj_fc',
            glyloss: 'cj_glyloss', sour: 'cj_sour', bandG: 'cj_band_g', bandA: 'cj_band_a', minf: 'cj_minf' },
        line: { point: 'cj_pt_', chem: 'cj_chem_', basis: 'cj_basis_', dose: 'cj_dose_', lean: 'cj_lean_', sgc: 'cj_sgc_', eff: 'cj_eff_', pump: 'cj_pump_',
            plunger: 'cj_plg_', stroke: 'cj_stk_', heads: 'cj_heads_', qrated: 'cj_qrated_', pmax: 'cj_pmax_', q0: 'cj_q0_', ratio: 'cj_ratio_', vcyc: 'cj_vcyc_',
            tank: 'cj_tank_', active: 'cj_act_', water: 'cj_wat_', peak: 'cj_peak_', ve: 'cj_ve_', spmmax: 'cj_spmmax_', actd: 'cj_actd_', rod: 'cj_rod_',
            dpq: 'cj_dpq_', mawp: 'cj_mawp_', o2: 'cj_o2_' },
        cal: { line: 'cj_cal_line', mL: 'cj_cal_ml', s: 'cj_cal_s', setting: 'cj_cal_set', pd: 'cj_cal_pd' }
    };
    function fromIds(map) {
        map = map || {};
        var d = defaults(), sec, k;
        ['stream', 'spread', 'basis', 'cal'].forEach(function (s) {
            sec = IDS[s];
            for (k in sec) if (_has(map, sec[k])) d[s][k] = map[sec[k]];
        });
        if (_has(map, 'cj_nlines')) d.nlines = map.cj_nlines;
        d.lines.forEach(function (l, n) {
            for (k in IDS.line) { var id = IDS.line[k] + (n + 1); if (_has(map, id)) l[k] = map[id]; }
        });
        return d;
    }

    // ── Validation (plan §2.3 ranges; bad[] carries the cj_* ids) ────
    var RANGES = {
        stream: { qg: [0, 500], sg: [0.55, 3], h2s: [0, 100000], co2: [0, 50], n2: [0, 50], qo: [0, 100000], api: [10, 90], qw: [0, 100000], sgw: [1.0, 1.25], h2so: [0, 10000, 1], h2sw: [0, 10000, 1] },
        spread: { sithp: [0, 20000], fwhp: [0, 20000], fwht: [-40, 400], tamb: [-60, 130], pck: [0, 20000], tck: [-60, 400, 1], thtr: [-40, 400], psep: [0, 20000],
            tsep: [-60, 400, 1], psvsep: [0, 30000], pbpv: [0, 20000, 1] },
        basis: { margin: [0, 30], fJT: [1.0, 1.3], thuser: [-40, 100, 1], thuserp: [0, 20000, 1], h2sOut: [0, 100000, 1], pmpct: [0, 50], pmabs: [0, 1000], days: [0.1, 90],
            psup: [10, 150], fc: [0, 2, 1], glyloss: [0, 10], sour: [0, 20], bandG: [50, 95], bandA: [50, 95], minf: [0.1, 1] },
        line: { dose: [0, 1e6, 1], lean: [50, 100, 1], sgc: [0.5, 2.0, 1], eff: [0.01, 1, 1], qrated: [0.01, 10000, 1], pmax: [1, 30000, 1], q0: [0.01, 10000, 1],
            ratio: [1, 500, 1], vcyc: [0.01, 100, 1], tank: [0, 100000, 1], active: [0.1, 100, 1], water: [0, 99, 1], peak: [1, 5, 1], ve: [0.5, 1, 1],
            spmmax: [1, 300, 1], rod: [100, 20000, 1], dpq: [0, 1000, 1], mawp: [0, 30000, 1], o2: [0, 20, 1] }
    };
    var SELECTS = {
        stream: { wbasis: ['free', 'sep'] },
        spread: { jt: ['ise', 'rule', 'user'], htr: ['yes', 'no'], whclass: ['2000', '3000', '5000', '10000', '15000'], haz: ['yes', 'no'], supgas: ['air', 'n2', 'sweet', 'well'] },
        basis: { thsrc: ['tm', 'user'], method: ['auto', 'ham', 'nb'], cond: ['buk', 'all'], ratebasis: ['credible', 'class'] }
    };
    function _validate(inp) {
        var errors = [], bad = [], L = _lib();
        function err(id, m) { errors.push(m); if (bad.indexOf(id) === -1) bad.push(id); }
        ['stream', 'spread', 'basis'].forEach(function (s) {
            var R = RANGES[s], k;
            for (k in R) {
                var v = inp[s][k], r = R[k], id = IDS[s][k];
                if (_blank(v) || v === undefined) { if (!r[2]) err(id, 'Enter a value for ' + id.replace('cj_', '') + '.'); continue; }
                var n = Number(v);
                if (!_fin(n) || n < r[0] || n > r[1]) err(id, id.replace('cj_', '') + ' must be between ' + _grp(r[0], r[0] % 1 ? 2 : 0) + ' and ' + _grp(r[1], r[1] % 1 ? 2 : 0) + '.');
                else inp[s][k] = n;
            }
            var S = SELECTS[s];
            for (k in S) if (S[k].indexOf(String(inp[s][k])) === -1) err(IDS[s][k], 'Choose an option for ' + IDS[s][k].replace('cj_', '') + '.');
        });
        if (errors.length) return { errors: errors, bad: bad };
        var sp = inp.spread, st = inp.stream, b = inp.basis;
        if (sp.pck > sp.fwhp) err('cj_pck', 'Pressure downstream of the choke must not exceed the flowing wellhead pressure.');
        if (sp.psep > sp.pck) err('cj_psep', 'Separator pressure must not exceed the pressure downstream of the choke.');
        if (sp.psvsep < sp.psep) err('cj_psvsep', 'Separator relief-valve set pressure must be at least the separator pressure.');
        if (sp.jt === 'user' && !_fin(Number(sp.tck))) err('cj_tck', 'Enter the choke outlet temperature.');
        if (b.thsrc === 'user' && (!_fin(Number(b.thuser)) || !_fin(Number(b.thuserp)) || _blank(b.thuser) || _blank(b.thuserp))) { err('cj_thuser', 'Enter the user hydrate temperature and its pressure.'); bad.push('cj_thuserp'); }
        if (b.bandA < b.bandG) err('cj_band_a', 'The amber limit must be at least the green limit.');
        if (st.co2 + _ppmToMolPct(st.h2s) + st.n2 >= 95) err('cj_co2', 'CO2 + H2S + N2 must be below 95 mol %.');
        var nl = Number(inp.nlines);
        if (!(nl >= 1 && nl <= 6 && Math.round(nl) === nl)) err('cj_nlines', 'Choose 1 to 6 injection lines.');
        else inp.nlines = nl;
        if (errors.length) return { errors: errors, bad: bad };
        for (var n = 0; n < inp.nlines; n++) {
            var l = inp.lines[n], sfx = String(n + 1), k;
            if (!l) { err('cj_nlines', 'Line ' + sfx + ' is missing.'); continue; }
            if (!L.point(l.point)) err('cj_pt_' + sfx, 'Choose the injection point of line ' + sfx + '.');
            var c = L.find(l.chem);
            if (!c) err('cj_chem_' + sfx, 'Choose the chemical of line ' + sfx + '.');
            if (!_blank(l.basis) && l.basis !== undefined && !L.bases[l.basis]) err('cj_basis_' + sfx, 'Choose the dose basis of line ' + sfx + '.');
            var basis = (_blank(l.basis) || l.basis === undefined) ? (c ? c.basis : null) : l.basis;
            if (c && basis === 'wt_water' && c.kind !== 'thi') err('cj_basis_' + sfx, 'Line ' + sfx + ': the wt % in water basis applies to thermodynamic hydrate inhibitors only.');
            var P = L.pump(l.pump);
            if (!P) err('cj_pump_' + sfx, 'Choose the pump type of line ' + sfx + '.');
            for (k in RANGES.line) {
                var v = l[k], r = RANGES.line[k], id = IDS.line[k] + sfx;
                if (v === undefined || _blank(v)) continue;
                var x = Number(v);
                if (!_fin(x) || x < r[0] || x > r[1]) err(id, 'Line ' + sfx + ': ' + IDS.line[k].replace('cj_', '').replace(/_$/, '') + ' must be between ' + _grp(r[0], r[0] % 1 ? 2 : 0) + ' and ' + _grp(r[1], r[1] % 1 ? 2 : 0) + '.');
                else l[k] = x;
            }
            if (P && P.kind === 'plunger') {
                var pl = Number(l.plunger), stv = Number(l.stroke), h = Number(l.heads);
                if (!(l.plunger === undefined || _blank(l.plunger)) && !L.plungers.some(function (p) { return Math.abs(p['in'] - pl) < 1e-6; })) err('cj_plg_' + sfx, 'Line ' + sfx + ': choose a plunger size.');
                if (!(l.stroke === undefined || _blank(l.stroke)) && !L.strokes.some(function (p) { return Math.abs(p['in'] - stv) < 1e-6; })) err('cj_stk_' + sfx, 'Line ' + sfx + ': choose a stroke length.');
                if (!(l.heads === undefined || _blank(l.heads)) && [1, 2, 3].indexOf(h) === -1) err('cj_heads_' + sfx, 'Line ' + sfx + ': choose 1, 2 or 3 heads.');
                if (P.setting === 'spm' && h === 3) err('cj_heads_' + sfx, 'Line ' + sfx + ': a pneumatic pump takes 1 or 2 plungers on one actuator.');
                if (P.setting === 'spm' && !(l.actd === undefined || _blank(l.actd)) && [4, 6, 8].indexOf(Number(l.actd)) === -1) err('cj_actd_' + sfx, 'Line ' + sfx + ': choose a 4, 6 or 8 in actuator.');
            }
            if (c && c.kind === 'thi' && basis === 'wt_water' && !(l.lean === undefined || _blank(l.lean))) {
                var dv = Number(l.dose);
                if (!(l.dose === undefined || _blank(l.dose)) && !(dv > 0 && dv < Number(l.lean))) err('cj_dose_' + sfx, 'Line ' + sfx + ': the rich wt % override must be above 0 and below the lean strength.');
            }
        }
        if (inp.cal && !_blank(inp.cal.mL) && inp.cal.mL !== undefined) {
            var cl = Number(inp.cal.line);
            if (!(cl >= 1 && cl <= inp.nlines && Math.round(cl) === cl)) err('cj_cal_line', 'Choose a calibration line between 1 and the number of lines.');
            ['mL', 's', 'setting'].forEach(function (k) { var x = Number(inp.cal[k]); if (!(x > 0 && x < 1e7)) err(IDS.cal[k], 'Calibration ' + k + ' must be above 0.'); });
            if (!(inp.cal.pd === undefined || _blank(inp.cal.pd))) { var pdv = Number(inp.cal.pd); if (!(_fin(pdv) && pdv >= 0 && pdv <= 30000)) err('cj_cal_pd', 'Calibration discharge pressure must be between 0 and 30,000 psig.'); }
        }
        return errors.length ? { errors: errors, bad: bad } : null;
    }
    function _merge(def, inp) {
        var out = {}, k;
        for (k in def) out[k] = def[k];
        if (inp && typeof inp === 'object') for (k in inp) if (_has(inp, k) && inp[k] !== undefined) out[k] = inp[k];
        return out;
    }

    var ZERO_TXT = { refused: 'refused: enter a lab hydrate temperature', norate: 'no rate given: see ✗', nodose: 'no dose entered', batch: 'batch only' };
    // A THI line with a rate at or upstream of node nd (protection also needs !t.protectWhy).
    function _covers(t, nd) { return t.kind === 'thi' && t.hydrate && t.hydrate.ok && t.rate.gal_d > 0 && _ptOrder(t.point) <= LOC_ORDER[nd.loc]; }

    // ── WTS_cheminj_compute (plan §6.3) ──────────────────────────────
    function compute(input, opts) {
        var L = _lib();
        if (!L) return { ok: false, errors: ['The chemical library (WTS_chemlib) is not loaded.'], bad: [] };
        input = input || {}; opts = opts || {};
        var prevF = F;
        F = _fmt(opts.fmt || input.fmt);
        try { return _compute(L, input, opts); } finally { F = prevF; }
    }
    function _compute(L, input, opts) {
        var D = defaults();
        var inp = {
            stream: _merge(D.stream, input.stream), spread: _merge(D.spread, input.spread), basis: _merge(D.basis, input.basis),
            nlines: input.nlines !== undefined ? input.nlines : (input.lines && input.lines.length && input.nlines === undefined ? Math.min(6, input.lines.length) : D.nlines),
            lines: D.lines.map(function (l, n) { return _merge(l, input.lines && input.lines[n]); }),
            cal: _merge(D.cal, input.cal)
        };
        var v = _validate(inp);
        if (v) return { ok: false, errors: v.errors, bad: v.bad };
        var st = inp.stream, sp = inp.spread, b = inp.basis, vm = _vm();
        // Spread (or a precomputed one for loops)
        var pre = input.precomputed && input.precomputed.spread;
        var S = (pre && pre.ok) ? pre : spread({
            qg: st.qg, sg: st.sg, h2s: st.h2s, co2: st.co2, n2: st.n2, qo: st.qo, qw: st.qw, api: st.api, sgw: st.sgw,
            sithp: sp.sithp, fwhp: sp.fwhp, fwht: sp.fwht, tamb: sp.tamb, pck: sp.pck, jt: sp.jt, tck: sp.tck,
            htr: sp.htr, thtr: sp.thtr, psep: sp.psep, tsep: sp.tsep, whclass: sp.whclass,
            margin: b.margin, fJT: b.fJT, sour: b.sour, thsrc: b.thsrc, thuser: b.thuser, thuserp: b.thuserp
        });
        if (!S.ok) return { ok: false, errors: S.errors, bad: (S.bad || []).map(function (k) { return IDS.stream[k] || IDS.spread[k] || IDS.basis[k] || k; }) };
        var verdicts = [_V('warn', 'disclaimer', 'Planning estimate. Confirm doses with the chemical data sheet, compatibility and bottle/loop tests, and calibrate every pump at line pressure before relying on it.')];
        var warnings = [];
        var sgo = 141.5 / (131.5 + st.api);
        var lines = [], active = inp.lines.slice(0, inp.nlines);
        // Line set-up
        var setups = active.map(function (l, k) {
            var c = L.find(l.chem), P = L.pump(l.pump), pt = L.point(l.point), basis = (l.basis === undefined || _blank(l.basis)) ? c.basis : l.basis;
            return {
                n: k + 1, l: l, c: c, P: P, pt: pt, basis: basis,
                sgc: _opt(l.sgc, c.sg), water: _opt(l.water, c.water * 100) / 100, active: _opt(l.active, c.activeDef),
                peak: _opt(l.peak, c.peak), lean: _opt(l.lean, c.leanDef != null ? c.leanDef : 100)
            };
        });
        // Controlling water for volume-of-water (LDHI) bases: free + condensed at the coldest node from the point
        function qwCtrl(pt) {
            var pp = _path(S, pt), nodes = pp.path.length ? pp.path : S.nodes, ctrl = _ctrlOf(nodes);
            var w = _water(S, ctrl, { qg: st.qg, qw: st.qw, sgw: st.sgw, wbasis: st.wbasis, cond: b.cond }, []);
            return st.qw + w.cond / LB_BBL;
        }
        // Pass 1: every non-THI line (their water feeds the hydrate design)
        var rateOf = {};
        setups.forEach(function (u) {
            if (u.c.kind === 'thi' && u.basis === 'wt_water') return;
            var r = { verdicts: [] };
            if (u.basis === 'gal_lb_h2s' || u.basis === 'l_kg_h2s') {
                var R = null, ratio = null;
                var dose = _opt(u.l.dose, u.c.dose);
                if (_fin(dose)) R = u.basis === 'l_kg_h2s' ? dose * L.bases.l_kg_h2s.factor : dose;
                else if (u.c.stoich) {
                    var eff = _opt(u.l.eff, L.eff(u.c.key, u.pt.key) || 0.5);
                    ratio = scavRatio({ mw: u.c.stoich.mw, nH2S: u.c.stoich.n, activePct: _opt(u.l.active, u.c.stoich.activePct), sg: u.sgc, eff: eff });
                    if (ratio.ok) {
                        R = ratio.galPerLb;
                        if (ratio.effClamped) r.verdicts.push(_V('warn', 'eff_clamped', 'Utilisation raised to ' + _grp(ratio.eff, 3) + ' so that the ratio stays within ' + F.galLb(10) + '.'));
                    }
                }
                var fam = L.family(u.c.family);
                var sd = scavengerDose({
                    qg: st.qg, yin: st.h2s, yout: b.h2sOut, galPerLb: R, vm: vm,
                    gasPhase: (fam.scavPhase === 'gas' || u.pt.upstreamOfSep) && u.pt.phases.gas,
                    upstreamOfSep: u.pt.upstreamOfSep, oilPhase: fam.scavPhase === 'oil', waterPhase: fam.scavPhase === 'water',
                    liq: { qo: st.qo, sgo: sgo, ppmwO: st.h2so, qw: st.qw, sgw: st.sgw, ppmwW: st.h2sw }
                });
                r.scav = sd; r.ratio = ratio; r.gal_d = sd.gal_d;
                r.achieved = { value: b.h2sOut, unit: 'ppm H2S', label: 'outlet target' };
                sd.verdicts.forEach(function (x) { r.verdicts.push(x); });
                r.doseUsed = R;
            } else if (u.basis === 'wt_water') {
                r.gal_d = 0;
            } else {
                var d0 = _opt(u.l.dose, u.c.dose);
                if (!_fin(d0)) { r.gal_d = 0; r.verdicts.push(_V('warn', 'no_dose', 'Enter the dose for this chemical.')); r.doseUsed = null; }
                else {
                    var dr = doseRate({
                        basis: u.basis, dose: d0, activePct: u.active, qo: st.qo, qw: st.qw, qg: st.qg, api: st.api, sgw: st.sgw, sgc: u.sgc, phases: u.pt.phases,
                        qwCtrl: u.basis === 'vol_water' ? qwCtrl(u.pt.key) : undefined, h2sOil: st.h2so, o2: _opt(u.l.o2, 0.5)
                    });
                    r.dose = dr; r.gal_d = dr.gal_d; r.doseUsed = d0; r.activePpm = dr.activePpm;
                    r.achieved = { value: d0, unit: L.bases[u.basis].unit, label: 'dose (product)' };
                    if (dr.phase === 'gas' && !(st.qg > 0)) r.verdicts.push(_V('bad', 'needs_gas', 'A dose per volume of gas needs a gas rate.'));
                    if (u.basis === 'batch_gal') r.verdicts.push(_V('warn', 'batch', 'Batch volume ' + F.gal(d0) + ': no continuous rate.'));
                }
            }
            rateOf[u.n] = r;
        });
        // Water carried by aqueous lines (other than the THI line being designed)
        var otherWater = setups.filter(function (u) { return rateOf[u.n] && u.water > 0 && rateOf[u.n].gal_d > 0; }).map(function (u) {
            return { n: u.n, point: u.pt.key, chem: u.c.key, lb_d: rateOf[u.n].gal_d * LB_GAL * u.sgc * u.water, label: u.c.short };
        });
        // Pass 2: THI lines (hydrate design)
        var thiLines = [];
        setups.forEach(function (u) {
            if (!(u.c.kind === 'thi' && u.basis === 'wt_water')) return;
            var hd = hydrateDose({
                spread: S, chem: u.c.key, point: u.pt.key, qg: st.qg, qw: st.qw, sgw: st.sgw, qo: st.qo, wbasis: st.wbasis,
                leanPct: u.lean, method: b.method, cond: b.cond, fc: b.fc, glyLossPct: b.glyloss, vm: vm, sgc: u.sgc,
                XRoverride: _opt(u.l.dose, NaN), otherWater: otherWater
            });
            var r = { verdicts: [], hydrate: hd, gal_d: hd.ok && hd.inh ? hd.inh.gal_d : 0, doseUsed: hd.XR };
            r.achieved = { value: hd.XR, unit: 'wt %', label: 'rich inhibitor in the water' };
            if (hd.ok) hd.verdicts.forEach(function (x) { r.verdicts.push(x); });
            rateOf[u.n] = r;
            thiLines.push(u.n);
        });
        // Pass 3: rates → pressure, pump, options, drive gas, field check, supply, verdicts
        setups.forEach(function (u) {
            var r = rateOf[u.n], l = u.l, c = u.c, P = u.P, pt = u.pt;
            var gal = r.gal_d || 0, rates = _rates(gal, st.qg);
            var lv = [];
            var si = L.suitInfo(c.key, pt.key);
            lv.push(_V(si.verdict, 'suit_' + si.level, c.short + ' at ' + pt.short.toLowerCase() + ': ' + si.note));
            // Phase present at the point
            var ph = L.bases[u.basis] ? L.bases[u.basis].phase : null, phOk = true;
            if (ph === 'oil') phOk = pt.phases.oil; else if (ph === 'water') phOk = pt.phases.water; else if (ph === 'liquid') phOk = pt.phases.oil || pt.phases.water;
            else if (ph === 'gas') phOk = pt.phases.gas; else if (ph === 'thi') phOk = pt.phases.water || pt.phases.gas;
            if (!phOk) lv.push(_V('bad', 'phase', 'No ' + (ph === 'liquid' ? 'liquid' : ph) + ' phase at the ' + pt.short.toLowerCase() + ': this dose basis does not apply here.'));
            r.verdicts.forEach(function (x) { lv.push(x); });
            // Oxidiser rules (§3.2 rule 9)
            if (c.oxidiser) {
                lv.push(_V('warn', 'oxidiser_block', 'Never block in an oxidiser line: gas evolution overpressures it; fit vented relief.'));
                if (c.key === 'h2s_nitrite') lv.push(_V('warn', 'nitrite_nox', 'Nitrite with acidic sour water can release NOx: keep pH above about 7 and ventilate.'));
            }
            // Pressure (first pass for P_req / rating), pump, then the relief band with the pump rating
            var ipIn = {
                point: pt.key, chem: c.key, sithp: sp.sithp, fwhp: sp.fwhp, pck: sp.pck, psep: sp.psep, pbpv: sp.pbpv, psvsep: sp.psvsep, whclass: Number(sp.whclass),
                rateBasis: b.ratebasis, dpq: _opt(l.dpq, 50), marginPct: b.pmpct, marginAbs: b.pmabs, mawp: l.mawp
            };
            var ip0 = injectionPressure(ipIn);
            var pumpIn = {
                rate_gal_d: gal, pump: P.key, plunger_in: l.plunger, stroke_in: l.stroke, heads: l.heads, actD_in: l.actd,
                eta: l.ve, beta: c.beta, spmMax: l.spmmax, qRated_galh: l.qrated, pmax: l.pmax, q0_galh: l.q0, ratio: l.ratio, vcyc_in3: l.vcyc, rod: l.rod,
                psup: b.psup, peakF: u.peak, minF: b.minf, pRating: ip0.pRating, pReq: ip0.pReq, pFlow: ip0.pReqFlow, bandG: b.bandG, bandA: b.bandA, haz: sp.haz
            };
            var ps = pumpSetting(pumpIn);
            ipIn.pumpRating = ps.pumpRating;
            var ip = injectionPressure(ipIn);
            var opt = opts.noOptions ? null : pumpOptions(_merge(pumpIn, { current: { pump: P.key } }));
            var gasKind = P.kind === 'plunger' && P.setting === 'spm' ? 'pneumatic' : P.kind === 'airliquid' ? 'airliquid' : P.kind === 'transfer' ? 'transfer' : null;
            var sg2 = supplyGas({
                kind: gasKind, actD_in: ps.actD_in, stroke_in: ps.stroke_in, heads: ps.heads, plunger_in: ps.plunger_in, spm: ps.spm,
                pdDesign_psig: ip.pReq, airPeak_psig: ps.airPeak, psup: b.psup, etaM: P.etaM, pSpring: P.pSpring, gasType: sp.supgas, h2s_ppm: st.h2s, vm: vm
            });
            if (gal > 0) ps.verdicts.forEach(function (x) { lv.push(x); });
            else if (P.electric && sp.haz === 'yes') lv.push(_V('warn', 'haz_electric', 'Electric pump in a classified area: motor and controls must be certified for the zone (API RP 500/505).'));
            // Drive gas (stall at the shut-in pressure, sour or sweet produced gas) applies to the
            // pump whatever the steady rate: it still runs for start-up, shut-in or a refused dose.
            if (gasKind) sg2.verdicts.forEach(function (x) { lv.push(x); });
            ip.verdicts.forEach(function (x) { lv.push(x); });
            var fc = fieldCheck(gal, u.peak);
            var tk = (l.tank === undefined || _blank(l.tank)) ? null : tank({ V_gal: Number(l.tank), rate_gal_d: gal, days: b.days });
            if (tk) tk.verdicts.forEach(function (x) { lv.push(x); });
            var setTxt = _settingText(ps);
            // A zero rate that is not a real zero demand (no risk, no water, no H2S) says why.
            var zero = null;
            if (!(gal > 0)) {
                if (r.hydrate && r.hydrate.ok && r.hydrate.noRate) zero = r.hydrate.refused ? 'refused' : 'norate';
                else if (u.basis === 'batch_gal') zero = 'batch';
                else if (r.verdicts.some(function (x) { return x.code === 'no_dose'; })) zero = 'nodose';
                else if (r.verdicts.some(function (x) { return x.level === 'bad'; })) zero = 'norate';
            }
            var zeroText = zero ? ZERO_TXT[zero] : '';
            var chip = c.short + ' · ' + pt.short + ' · ' + (gal > 0 ? F.galD(gal) : (zeroText || 'no flow')) + (setTxt ? ' · ' + setTxt : '');
            // A THI line protects downstream nodes only when its dose meets the design and its
            // pump can deliver it at the required pressure (rate, pressure and drive gas).
            var protectWhy = null;
            if (c.kind === 'thi' && r.hydrate && r.hydrate.ok && gal > 0) {
                if (r.hydrate.underDosed) protectWhy = 'line ' + u.n + ' rich ' + _grp(r.hydrate.XR, 2) + ' wt % entered is below the required ' + _grp(r.hydrate.XRdesign, 2) + ' wt %';
                else if (!ps.deliverable) protectWhy = 'the line ' + u.n + ' pump cannot deliver the design dose at the required pressure (see line ' + u.n + ')';
            }
            lines.push({
                n: u.n, point: pt.key, pointLabel: pt.label, pointShort: pt.short, chem: c.key, chemName: c.name, chemShort: c.short, kind: c.kind,
                basis: u.basis, dose: r.doseUsed, sgc: u.sgc, water: u.water, peakF: u.peak, suit: si,
                rate: rates, peak_gal_d: gal * u.peak, achieved: r.achieved || null, activePpm: r.activePpm != null ? r.activePpm : null,
                hydrate: r.hydrate || null, scav: r.scav || null, ratio: r.ratio || null, doseCalc: r.dose || null,
                pump: ps, options: opt, pressure: ip, gas: sg2, field: fc, supply: tk, dPdT_psiF: c.dPdT,
                setting: setTxt, chip: chip, zero: zero, zeroText: zeroText, noRate: zero === 'refused' || zero === 'norate', protectWhy: protectWhy,
                verdicts: lv, level: _worst(lv)
            });
        });
        // Aqueous chemicals upstream of an unprotected hydrate-risk node (§3.2 rule 8)
        lines.forEach(function (ln) {
            var u = setups[ln.n - 1];
            if (!(u.water > 0) || u.c.kind === 'thi' || u.c.kind === 'ldhi' || !(ln.rate.gal_d > 0)) return;
            var o = _ptOrder(ln.point);
            var risk = S.nodes.filter(function (nd) { return nd.dTreq > 0 && LOC_ORDER[nd.loc] >= o; });
            risk.forEach(function (nd) {
                var prot = lines.some(function (t) { return _covers(t, nd) && !t.protectWhy; });
                if (!prot && !ln.verdicts.some(function (x) { return x.code === 'aq_hydrate'; })) {
                    ln.verdicts.push(_V('warn', 'aq_hydrate', u.c.short + ' is about ' + _grp(u.water * 100, 0) + ' % water and is injected upstream of a hydrate-risk node (' + nd.label + ') with no hydrate inhibitor: it can form hydrate or ice there.'));
                    ln.level = _worst(ln.verdicts);
                }
            });
        });
        // Hydrate block (spread + node verdicts with the inhibitor lines)
        var hv = S.verdicts.slice();
        // Refused correlation: no node, shut-in or start-up status (the sour_refused ✗ says why).
        if (!S.margin.refused) S.nodes.forEach(function (nd) {
            if (!(nd.dTreq > 0)) return;
            var cover = lines.filter(function (t) { return _covers(t, nd); });
            var prot = cover.filter(function (t) { return !t.protectWhy; });
            if (!prot.length && cover.length) hv.push(_V(nd.status === 'bad' ? 'bad' : 'warn', 'node_unprotected', nd.label + ' is not protected: ' + cover.map(function (t) { return t.protectWhy; }).join('; ') + '.'));
            else if (prot.length) hv.push(_V('ok', 'node_protected', nd.label + ' is protected by line ' + prot.map(function (t) { return t.n; }).join(', ') + ' (' + prot[0].chemShort + ', margin ' + F.dt(S.margin.used) + ').'));
            else if (nd.status === 'bad') hv.push(_V('bad', 'node_risk', 'Hydrate risk at ' + nd.label.toLowerCase() + ': ' + F.t(nd.t_F) + ' is ' + F.dt(nd.sub) + ' below the hydrate temperature ' + F.t(nd.thyd) + ' (margin ' + F.dt(S.margin.used) + '). Inject upstream of ' + nd.label.toLowerCase() + '.'));
            else hv.push(_V('warn', 'node_margin', nd.label + ' is within the ' + F.dt(S.margin.used) + ' hydrate margin (' + F.t(nd.t_F) + ' against ' + F.t(nd.thyd) + ').'));
        });
        if (!S.margin.refused) [S.shutin, S.startup].forEach(function (nd) {
            if (!(nd.dTreq > 0)) return;
            var thi = lines.filter(function (t) { return t.kind === 'thi' && t.hydrate && t.hydrate.ok; })[0];
            var cr = thi ? (nd.key === 'si' ? thi.hydrate.shutin : thi.hydrate.startup) : null;
            if (cr && cr.text) hv.push(_V(cr.level === 'ok' ? 'warn' : cr.level, nd.key === 'si' ? 'shutin_req' : 'startup_req', cr.text));
            else if (nd.key === 'si') hv.push(_V('warn', 'shutin_risk', 'Shut-in: trapped water at the flowhead (' + F.t(nd.t_F) + ') is ' + F.dt(nd.sub) + ' below the hydrate temperature ' + F.t(nd.thyd) + ': plan inhibitor before a shut-in.'));
            else hv.push(_V('warn', 'startup_risk', 'Start-up: the cold tree expanding to the choke outlet reaches ' + F.t(nd.t_F) + ' against a hydrate temperature of ' + F.t(nd.thyd) + ': plan heating or inhibitor for start-up.'));
        });
        var hydrate = { title: S.title, nodes: S.nodes, shutin: S.shutin, startup: S.startup, margin: S.margin, jt: S.jt, thiLines: thiLines, verdicts: hv };
        // Compatibility, summary
        var cv = compat(lines.map(function (ln) { return { n: ln.n, chem: ln.chem, point: ln.point }; }));
        var sv = [];
        if (lines.some(function (ln) { return ln.point !== 'tank'; })) sv.push(_V('warn', 'backflow', BACKFLOW));
        var seen = {};
        lines.forEach(function (ln) {
            if (seen[ln.chem] || ln.dPdT_psiF == null) return;
            seen[ln.chem] = true;
            sv.push(_thermalV(ln.chemShort, ln.dPdT_psiF));
        });
        cv.forEach(function (x) { sv.push(x); });
        var inv = {};
        lines.forEach(function (ln) {
            var e = inv[ln.chem] || (inv[ln.chem] = { chem: ln.chem, name: ln.chemShort, gal_d: 0, gal_test: 0 });
            e.gal_d += ln.rate.gal_d; e.gal_test += ln.rate.gal_d * b.days * 1.2;
        });
        var summary = {
            rows: lines.map(function (ln) {
                return { n: ln.n, point: ln.pointShort, chem: ln.chemShort, gal_d: ln.rate.gal_d, mL_min: ln.rate.mL_min, pump: ln.pump.name, setting: ln.setting, zeroText: ln.zeroText,
                    pReq: ln.pressure.pReq, pRating: ln.pressure.pRating, level: ln.level };
            }),
            inventory: Object.keys(inv).map(function (k) { return inv[k]; }),
            total_gal_d: lines.reduce(function (a, ln) { return a + ln.rate.gal_d; }, 0),
            verdicts: sv
        };
        // Calibration card
        var cal = null, ci = inp.cal;
        if (ci && !_blank(ci.mL) && ci.mL !== undefined) {
            var ln = lines[Number(ci.line) - 1];
            var ps2 = ln.pump;
            var kind = ps2.kind === 'airliquid' ? 'air' : (ps2.setting === 'spm' ? 'spm' : 'stroke_speed');
            cal = calibration({ mL: Number(ci.mL), s: Number(ci.s), setting: Number(ci.setting), kind: kind, Vs_mL: ps2.Vs_mL, heads: ps2.heads,
                target_gal_d: ln.rate.gal_d, pReq: ln.pressure.pReq, ratio: ps2.ratio,
                pTest: _opt(ci.pd, ln.pressure.pReqFlow) });
            cal.pTestEntered = !(ci.pd === undefined || _blank(ci.pd));
            cal.line = ln.n;
        }
        var basisEcho = {
            margin: b.margin, marginUsed: S.margin.used, sourAdder: S.margin.adder, fJT: b.fJT, jt: S.jt.method, thsrc: S.thydSrc, method: b.method, cond: b.cond,
            ratebasis: b.ratebasis, pmpct: b.pmpct, pmabs: b.pmabs, haz: sp.haz, supgas: sp.supgas, psup: b.psup, days: b.days, fc: b.fc, glyloss: b.glyloss,
            sour: b.sour, bandG: b.bandG, bandA: b.bandA, minf: b.minf, vm: vm, wbasis: st.wbasis, h2sOut: b.h2sOut
        };
        S.warnings.forEach(function (w) { warnings.push(w); });
        return {
            ok: true, spread: S, hydrate: hydrate, h2s: null, lines: lines, summary: summary, compat: cv, calibration: cal,
            basis: basisEcho, verdicts: verdicts, warnings: warnings, input: inp
        };
    }
    function _settingText(ps) {
        if (!ps || ps.noFlow) return '';
        if (ps.kind === 'airliquid') return ps.airDesign != null ? 'air ' + F.pSet(ps.airDesign) : 'air: not reachable';
        if (ps.kind === 'plunger' && ps.setting === 'spm') return _grp(ps.spm, 1) + ' SPM';
        if (ps.setting === 'stroke_speed') return ps.vfd ? _grp(ps.S, 0) + ' % stroke × ' + _grp(ps.N, 0) + ' % speed' : _grp(ps.S, 1) + ' % stroke';
        if (ps.kind === 'transfer') return _grp(ps.cyclesMin, 1) + ' cycles/min';
        return '';
    }

    function stats() {
        var f = G.WTS_gaspvt_isenthalpic, s = (f && typeof f.stats === 'function') ? f.stats() : { solves: 0, hits: 0 };
        return { isenthalpicSolves: s.solves, memoHits: s.hits };
    }

    G.WTS_cheminj = {
        version: 1,
        pvWater: pvWater, waterContent: waterContent, hydrateTemp: hydrateTemp, hydrateCurve: hydrateCurve,
        depression: depression, requiredWt: requiredWt, methanolLoss: methanolLoss, freezePoint: freezePoint,
        spread: spread, hydrateDose: hydrateDose, doseRate: doseRate, scavRatio: scavRatio, scavengerDose: scavengerDose,
        pumpSetting: pumpSetting, pumpOptions: pumpOptions, nextPlunger: function (i) { var o = pumpSetting(i); return o.ok ? (o.nextPlunger || null) : null; },
        injectionPressure: injectionPressure, supplyGas: supplyGas,
        calibration: calibration, fieldCheck: fieldCheck, tank: tank, compat: compat,
        defaults: defaults, fromIds: fromIds, ids: IDS, stats: stats,
        inhKey: _inhKey, ppmToMolPct: _ppmToMolPct, fmt: function (o) { return _fmt(o); },
        constants: { ATM: ATM, LB_GAL: LB_GAL, LB_BBL: LB_BBL, GAL_L: GAL_L, IN3_GAL: IN3_GAL, ML_IN3: ML_IN3, X_REF_30: X_REF_30, RULE_FPSI: RULE_FPSI }
    };
    G.WTS_cheminj_compute = compute;

    // ════════════════════════════════════════════════════════════════
    // PAGE — route `cheminj`, ids cj_* (plan §2, §6.2, §6.5–§6.9)
    //   renderChemInj(body) paints one scrolling page (no tabs, so a report keeps every
    //   visible block); calcChemInj() reads the cj_* controls in the units layer's canonical
    //   context, runs WTS_cheminj_compute (Metric verdict text through opts.fmt) and paints
    //   #cj_res, the line chips, the two charts and the six Notes boxes. Restore is silent
    //   (hooks.silent): hooks.after re-syncs data-prev and the show/hide state, then runs
    //   exactly one calc. Listeners sit on #cj_root only; no timers, no resize listener.
    // ════════════════════════════════════════════════════════════════
    var PG_KEY = 'cheminj';
    var PG_TITLE = 'Chemical Injection';
    var PG_SUB = 'Hydrate inhibitor, H2S scavenger and treating-chemical dosing per injection point, with pump settings';
    var NLINES = 6;
    var _calcCount = 0;

    // Unit categories this page needs (merged into WTS_units when absent; plan §6.5).
    (function _cats() {
        var U = G.WTS_units, C = U && U.CATEGORIES;
        if (!C) return;
        function add(k, iu, il, f, mu, ml) {
            if (!C[k]) C[k] = { imperial: { unit: iu, label: il, factor: f, offset: 0 }, metric: { unit: mu, label: ml, factor: 1, offset: 0 } };
        }
        add('chemRate', 'gal/d', 'gal/d', GAL_L, 'L/d', 'L/d');
        add('chemRateHr', 'gal/h', 'gal/h', GAL_L, 'L/h', 'L/h');
        add('doseGasVol', 'gal/MMscf', 'gal/MMscf', GAL_L / 0.028316846592, 'L/1e6Sm3', 'L/10⁶ Sm³');
        add('volPerStroke', 'in3', 'in³', ML_IN3, 'mL', 'mL');
        add('massRateDay', 'lb/d', 'lb/d', 0.45359237, 'kg/d', 'kg/d');
        add('lbPerBbl', 'lb/bbl', 'lb/bbl', 0.45359237 / 0.158987294928, 'kg/m3', 'kg/m³');
    })();

    // Converting categories only: identity categories (%, ppm, SG, °API) stay untagged so the
    // units layer leaves their labels alone.
    var PG_UNITS = {
        cj_qg: 'gasRate', cj_qo: 'liquidRate', cj_qw: 'liquidRate',
        cj_sithp: 'pressureG', cj_fwhp: 'pressureG', cj_fwht: 'temperature', cj_tamb: 'temperature', cj_pck: 'pressureG',
        cj_tck: 'temperature', cj_thtr: 'temperature', cj_psep: 'pressureG', cj_tsep: 'temperature', cj_psvsep: 'pressureG',
        cj_pbpv: 'pressureG', cj_margin: 'tempDelta', cj_thuser: 'temperature', cj_thuserp: 'pressureG', cj_pmabs: 'pressure',
        cj_psup: 'pressureG', cj_fc: 'lbPerBbl', cj_sour: 'tempDelta', cj_cal_air: 'pressureG', cj_cal_pd: 'pressureG'
    };
    var LN_UNITS = { qrated: 'chemRateHr', pmax: 'pressureG', q0: 'chemRateHr', vcyc: 'volPerStroke', tank: 'volumeSmall', rod: 'force', dpq: 'pressure', mawp: 'pressureG' };

    // ── Page helpers ─────────────────────────────────────────────────
    function _pgById(id) { try { return (typeof document !== 'undefined' && document && document.getElementById) ? document.getElementById(id) : null; } catch (e) { return null; } }
    function _esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
    }
    function _isM() { var U = G.WTS_units; return !!(U && typeof U.getSystem === 'function' && U.getSystem() === 'metric'); }
    function _nf(v, d, dmin) {
        if (!_fin(v)) return '—';
        var mx = d == null ? 2 : d, mn = dmin == null ? 0 : Math.min(dmin, mx);
        try {
            return (typeof G.WTS_fmtNum === 'function') ? G.WTS_fmtNum(v, mn, mx)
                : Number(v).toLocaleString(undefined, { minimumFractionDigits: mn, maximumFractionDigits: mx });
        } catch (e) { return Number(v).toFixed(mx); }
    }
    function _hasCat(cat) { var U = G.WTS_units; return !!(U && typeof U.format === 'function' && U.CATEGORIES && U.CATEGORIES[cat]); }
    // value in the display system ("3,550 psig" | "24,477 kPa(g)")
    function _qv(v, cat, d, imp, dm) {
        if (!_fin(v)) return '—';
        if (_isM() && _hasCat(cat)) {
            var f = G.WTS_units.format(v, cat);
            return _nf(f.value, dm == null ? d : dm) + (f.label ? ' ' + f.label : '');
        }
        return _nf(v, d) + (imp ? ' ' + imp : '');
    }
    function _dv(v, cat) { return (_isM() && _hasCat(cat) && _fin(v)) ? G.WTS_units.format(v, cat).value : v; }
    function _ul(cat, imp) { return (_isM() && _hasCat(cat)) ? G.WTS_units.CATEGORIES[cat].metric.label : imp; }
    function _canon(fn) { var U = G.WTS_units; return (U && typeof U.runCanonical === 'function') ? U.runCanonical(fn) : fn(); }
    function _r6(x) { return _fin(x) ? Number(Number(x).toPrecision(6)) : ''; }
    function _low1(s) { s = String(s || ''); return s.charAt(0).toLowerCase() + s.slice(1); }
    function _show(el, on) { if (el && el.style) el.style.display = on ? '' : 'none'; }
    function _wrapOf(id) { var e = _pgById(id); return (e && e.closest) ? e.closest('.fg-item') : null; }
    function _sv(id) { var e = _pgById(id); return e ? String(e.value) : ''; }
    function _checked(id) { var e = _pgById(id); return !!(e && e.checked); }
    function _each(list, fn) { for (var i = 0; list && i < list.length; i++) fn(list[i], i); }
    // chemical rate, one value: gal/d (imperial) | L/h (Metric)
    function _rq(galD) {
        if (!_fin(galD)) return '—';
        if (_isM()) { var lh = galD * GAL_L / 24; return _nf(lh, lh < 10 ? 3 : 2) + ' L/h'; }
        return _nf(galD, galD < 10 ? 3 : 2) + ' gal/d';
    }
    // gal/d · L/d · L/h · mL/min (Metric: L/d · L/h · mL/min)
    function _cap1(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
    function _rateTxt(r, zeroText) {
        if (!r || !(r.gal_d > 0)) return zeroText ? _cap1(zeroText) : 'No flow required';
        var mm = _nf(r.mL_min, r.mL_min < 10 ? 2 : 1) + ' mL/min', lh = _nf(r.L_hr, r.L_hr < 10 ? 3 : 2) + ' L/h', ld = _nf(r.L_d, r.L_d < 10 ? 2 : 1) + ' L/d';
        return _isM() ? ld + ' · ' + lh + ' · ' + mm : _nf(r.gal_d, r.gal_d < 10 ? 3 : 2) + ' gal/d · ' + ld + ' · ' + lh + ' · ' + mm;
    }
    // Metric text formatters for the engine's verdict strings (opts.fmt)
    function _metricFmt() {
        return {
            pG: function (v) { return _qv(v, 'pressureG', 0, 'psig', 0); },
            pA: function (v) { return _qv(v, 'pressure', 1, 'psia', 0); },
            dp: function (v) { return _qv(v, 'pressure', 0, 'psi', 0); },
            t: function (v) { return _qv(v, 'temperature', 1, '°F', 1); },
            dt: function (v) { return _qv(v, 'tempDelta', 1, '°F', 1); },
            pSet: function (v) { return _qv(v, 'pressureG', 1, 'psig', 0); },
            galD: function (v) { return _qv(v, 'chemRate', 1, 'gal/d', Math.abs(v) * GAL_L < 10 ? 2 : 1); },
            gal: function (v) { return _qv(v, 'volumeSmall', 0, 'gal', 0); },
            lbD: function (v) { return _qv(v, 'massRateDay', 1, 'lb/d', 1); },
            scfD: function (v) { return _nf(v * 0.028316846592, 1) + ' Sm³/d'; },
            psiF: function (v) { return _nf(v * 6.894757293168 * 1.8, 0) + ' kPa per °C'; },
            inch: function (v) { return _frac(v) + ' in (' + _nf(v * 25.4, 1) + ' mm)'; },
            pA0: function (v) { return _qv(v, 'pressure', 0, 'psia', 0); },
            t0: function (v) { return _qv(v, 'temperature', 0, '°F', 1); },
            scfH: function (v) { return _nf(v * 0.028316846592, 3) + ' Sm³/h'; },
            lbD4: function (v) { return _nf(v * 0.45359237, 4) + ' kg/d'; },
            galLb: function (v) { return _nf(v * GAL_L / 0.45359237, 1) + ' L/kg'; },
            jtRule: function () { return '0.56 °C per bar'; }
        };
    }
    function _ruleTxt() { return _isM() ? '0.56 °C per bar' : '7 °F per 100 psi'; }
    function _sizeTxt(d) { return _isM() ? _frac(d) + ' in (' + _nf(d * 25.4, 1) + ' mm)' : _frac(d) + ' in'; }

    // ── Markup ───────────────────────────────────────────────────────
    function _fo(v, label, sel) { return '<option value="' + _esc(v) + '"' + (sel ? ' selected' : '') + '>' + _esc(label) + '</option>'; }
    function _fsel(id, label, opts, selAttr, wrapAttr) {
        return '<div class="fg-item"' + (wrapAttr || '') + '><label for="' + id + '">' + _esc(label) + '</label><select id="' + id + '"' + (selAttr || '') + '>' + opts + '</select></div>';
    }
    function _fnum(id, label, val, attr, wrapAttr) {
        return '<div class="fg-item"' + (wrapAttr || '') + '><label for="' + id + '">' + _esc(label) + '</label>' +
            '<input type="number" id="' + id + '" step="any" value="' + _esc(val == null ? '' : val) + '"' + (attr || '') + '></div>';
    }
    function _tog(id, text, aria) { return '<label class="cj-tog rp-skip"><input type="checkbox" id="' + id + '" aria-label="' + _esc(aria) + '"> ' + _esc(text) + '</label>'; }
    function _optsList(pairs, sel) { return pairs.map(function (p) { return _fo(p[0], p[1], String(p[0]) === String(sel)); }).join(''); }
    function _chemLabel(c) {
        if (c.name.length <= 48) return c.name;
        var head = c.name.split(' (')[0];
        return head + (c.short && c.short.length <= 4 && head.indexOf(c.short) === -1 ? ' (' + c.short + ')' : '');
    }
    function _optsChems(sel) {
        var L = _lib(), h = '';
        L.groups.slice().sort(function (a, b) { return a.order - b.order; }).forEach(function (g) {
            var cs = L.chemicals.filter(function (c) { return c.group === g.key; });
            if (cs.length) h += '<optgroup label="' + _esc(g.label) + '">' + cs.map(function (c) { return _fo(c.key, _chemLabel(c), c.key === sel); }).join('') + '</optgroup>';
        });
        return h;
    }
    function _optsBases(sel) { var B = _lib().bases; return Object.keys(B).map(function (k) { return _fo(k, B[k].label, k === sel); }).join(''); }
    function _pumpLabel(P) { var s = P.short || P.name; return /pump$/i.test(s) ? s : s + ' pump'; }
    function _optsPumps(sel) { return _lib().pumps.filter(function (P) { return P.mvp; }).map(function (P) { return _fo(P.key, _pumpLabel(P), P.key === sel); }).join(''); }
    function _optsSizes(list, sel) { return list.map(function (s) { return _fo(s.value, s.label, Math.abs(s['in'] - Number(sel)) < 1e-9); }).join(''); }
    function _doseLabel(basis) {
        var B = _lib().bases[basis];
        if (basis === 'wt_water') return 'Rich wt % override, blank = hydrate design';
        if (basis === 'gal_lb_h2s') return 'Product per lb of H2S, blank = stoichiometry ÷ η (gal/lb)';
        if (basis === 'l_kg_h2s') return 'Product per kg of H2S, blank = stoichiometry ÷ η (L/kg)';
        if (basis === 'batch_gal') return 'Batch volume (gal)';
        return 'Dose (' + (B ? B.unit : '') + ')';
    }
    function _lineDefaults(n) {
        var d = LINE_DEF[n - 1], L = _lib(), c = L.find(d.chem), P = L.pump(d.pump);
        return {
            point: d.point, chem: d.chem, basis: c.basis, dose: c.dose == null ? '' : c.dose, lean: c.leanDef == null ? '' : c.leanDef,
            sgc: c.sg, eff: '', pump: d.pump,
            plunger: P.kind === 'plunger' ? P.plungerDef : 0.875, stroke: P.kind === 'plunger' ? P.strokeDef : 1, heads: 1,
            qrated: P.kind === 'meter' ? _r6(P.qRated_galh) : '', pmax: P.kind === 'meter' ? P.pmax : '',
            q0: (P.kind === 'airliquid' || P.kind === 'transfer') ? P.q0_galh : '', ratio: P.kind === 'airliquid' ? P.ratio : '',
            vcyc: P.kind === 'airliquid' ? P.vcyc_in3 : '', tank: 275, act: c.activeDef == null ? '' : c.activeDef,
            wat: c.kind === 'thi' ? '' : _r6(c.water * 100), peak: c.peak, ve: 0.9, spmmax: '', actd: P.actDef || 4,
            rod: 2500, dpq: 50, mawp: '', o2: 0.5
        };
    }
    function _lineCard(n) {
        var L = _lib(), d = _lineDefaults(n), s = String(n);
        function id(k) { return 'cj_' + k + '_' + s; }
        var heads = [[1, '1 head'], [2, '2 heads'], [3, '3 heads']];
        return '<div class="card cj-line" id="cj_line_' + s + '" data-n="' + s + '"' + (n > 1 ? ' style="display:none"' : '') + '>' +
            '<div class="card-title">Injection line ' + s + '</div>' +
            '<div class="cj-chip rp-skip" id="cj_chip_' + s + '"></div>' +
            '<div class="fg">' +
            _fsel(id('pt'), 'Injection point', L.points.map(function (p) { return _fo(p.key, p.label, p.key === d.point); }).join('')) +
            _fsel(id('chem'), 'Chemical (grouped by purpose)', _optsChems(d.chem), ' data-prev="' + _esc(d.chem) + '"') +
            _fsel(id('basis'), 'Dose basis', _optsBases(d.basis)) +
            _fnum(id('dose'), _doseLabel(d.basis), d.dose, ' min="0"') +
            _fnum(id('lean'), 'Lean (as-injected) strength (wt %)', d.lean, ' min="50" max="100"', ' data-k="thi"') +
            _fnum(id('sgc'), 'Product SG (water = 1)', d.sgc, ' min="0.5" max="2"') +
            _fnum(id('eff'), 'Scavenger utilisation (0–1), blank = point default', d.eff, ' min="0.01" max="1"', ' data-k="scav"') +
            _fsel(id('pump'), 'Pump type', _optsPumps(d.pump), ' data-prev="' + _esc(d.pump) + '"') +
            _fsel(id('plg'), 'Plunger diameter', _optsSizes(L.plungers, d.plunger), '', ' data-k="plunger"') +
            _fsel(id('stk'), 'Stroke length (maximum for an electric pump)', _optsSizes(L.strokes, d.stroke), '', ' data-k="plunger"') +
            _fsel(id('heads'), 'Heads (pneumatic: plungers on one actuator)', _optsList(heads, d.heads), '', ' data-k="plunger"') +
            _fnum(id('qrated'), 'Rated capacity (gal/h)', d.qrated, ' min="0"', ' data-k="meter"') +
            _fnum(id('pmax'), 'Maximum discharge pressure (psig)', d.pmax, ' min="0"', ' data-k="meter"') +
            _fnum(id('q0'), 'Free-flow rate at full air (gal/h)', d.q0, ' min="0"', ' data-k="airliquid transfer"') +
            _fnum(id('ratio'), 'Pressure ratio, outlet : air', d.ratio, ' min="1"', ' data-k="airliquid"') +
            _fnum(id('vcyc'), 'Displacement per cycle (in³)', d.vcyc, ' min="0"', ' data-k="airliquid"') +
            _fnum(id('tank'), 'Chemical tank usable volume (gal)', d.tank, ' min="0"') +
            '</div>' +
            _tog(id('adv'), 'Advanced settings', 'Line ' + s + ' advanced settings') +
            '<div class="fg cj-adv" id="cj_advbox_' + s + '" style="display:none">' +
            _fnum(id('act'), 'Active content (%)', d.act, ' min="0.1" max="100"') +
            _fnum(id('wat'), 'Water in the product (wt %)', d.wat, ' min="0" max="99"', ' data-k="nonthi"') +
            _fnum(id('peak'), 'Peak / start-up factor (× design rate)', d.peak, ' min="1" max="5"') +
            _fnum(id('ve'), 'Volumetric efficiency (0.5–1), blank = auto model', d.ve, ' min="0.5" max="1"', ' data-k="plunger"') +
            _fnum(id('spmmax'), 'Maximum SPM, crank or pulse rate, blank = preset', d.spmmax, ' min="1"', ' data-k="plunger meter"') +
            _fsel(id('actd'), 'Pneumatic actuator diameter', _optsSizes(L.actuators, d.actd), '', ' data-k="pneu"') +
            _fnum(id('rod'), 'Frame rod load (lbf)', d.rod, ' min="100"', ' data-k="elecplunger"') +
            _fnum(id('dpq'), 'Quill / nozzle and check-valve allowance (psi)', d.dpq, ' min="0"') +
            _fnum(id('mawp'), 'Lowest MAWP in the discharge circuit, blank = pump rating (psig)', d.mawp, ' min="0"') +
            _fnum(id('o2'), 'Dissolved O2 in the water (ppm)', d.o2, ' min="0"', ' data-k="o2"') +
            '</div></div>';
    }
    var PG_CSS = '<style>' +
        '#cj_root .cj-jump{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px}' +
        '#cj_root .cj-jump a{font-size:12px;font-weight:600;padding:5px 11px;border-radius:14px;border:1px solid var(--border);background:var(--bg3);color:var(--text2);text-decoration:none}' +
        '#cj_root .cj-jump a:hover,#cj_root .cj-jump a:focus{border-color:var(--accent);color:var(--accent)}' +
        '#cj_root .cj-chip{display:inline-block;max-width:100%;margin:-4px 0 12px;padding:4px 10px;border-radius:12px;background:rgba(240,136,62,.10);color:var(--accent);font-size:12px;font-weight:600;overflow-wrap:anywhere}' +
        '#cj_root .cj-chip:empty{display:none}' +
        '#cj_root .cj-tog{display:inline-flex;align-items:center;gap:8px;margin-top:14px;font-size:12px;font-weight:600;color:var(--text2);cursor:pointer}' +
        '#cj_root .cj-tog input{width:16px;height:16px;margin:0;accent-color:var(--accent)}' +
        '#cj_root .cj-adv{margin-top:12px;padding-top:12px;border-top:1px dashed var(--border)}' +
        '#cj_root .cj-hint{font-size:12px;color:var(--text2);margin-top:10px;line-height:1.45}' +
        '#cj_root .rrow{gap:12px;align-items:flex-start}' +
        '#cj_root .rrow .rl{flex:0 1 44%;min-width:0}' +
        '#cj_root .rrow .rv{text-align:right;min-width:0;overflow-wrap:anywhere;font-size:13px}' +
        '#cj_root .rrow .rv.cj-t{font-family:inherit;font-weight:600;font-size:12px}' +
        '#cj_root .cj-sub{margin:14px 0 2px;font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.4px}' +
        '#cj_root .cj-tw{overflow-x:auto;margin:8px 0;-webkit-overflow-scrolling:touch}' +
        '#cj_root .cj-tw .dtable{min-width:520px}' +
        '#cj_root .cj-v{margin:6px 0;font-size:12.5px;line-height:1.45}' +
        '#cj_root .cj-note{font-size:12px;color:var(--text2);line-height:1.5;margin:8px 0}' +
        '#cj_root .cj-chartsel{margin-bottom:4px}' +
        '#cj_root .chart-wrap canvas{max-width:960px;margin:0 auto}' +
        '@media (max-width:768px){#cj_root .rrow{flex-direction:column;gap:2px}#cj_root .rrow .rl{flex:none}#cj_root .rrow .rv{text-align:left}}' +
        '</style>';
    function _markup() {
        var L = _lib(), lines = '';
        for (var n = 1; n <= NLINES; n++) lines += _lineCard(n);
        var yesno = [['yes', 'Yes'], ['no', 'No']];
        var jump = [['cj_card_stream', 'Stream'], ['cj_card_spread', 'Spread'], ['cj_card_basis', 'Basis'], ['cj_card_lines', 'Lines'],
            ['cj_res', 'Results'], ['cj_charts', 'Charts'], ['cj_notes_res', 'Notes']];
        var nl = [], cl = [];
        for (var k = 1; k <= NLINES; k++) { nl.push([k, String(k)]); cl.push([k, 'Line ' + k]); }
        return '<div id="cj_root">' + PG_CSS +
            '<nav class="cj-jump rp-skip" aria-label="Jump to a section of this page">' +
            jump.map(function (a) { return '<a href="#' + a[0] + '">' + a[1] + '</a>'; }).join('') + '</nav>' +
            '<div class="cols-2">' +
            '<div class="card" id="cj_card_stream"><div class="card-title">Well stream</div><div class="fg">' +
            _fnum('cj_qg', 'Gas rate (MMSCFD)', 10, ' min="0"') +
            _fnum('cj_sg', 'Gas gravity (air = 1)', 0.65, ' min="0.55" max="3"') +
            _fnum('cj_h2s', 'H2S in gas (ppm mol)', 0, ' min="0"') +
            _fnum('cj_co2', 'CO2 (mol %)', 0, ' min="0" max="50"') +
            _fnum('cj_n2', 'N2 (mol %)', 0, ' min="0" max="50"') +
            _fnum('cj_qo', 'Oil / condensate rate (BPD)', 0, ' min="0"') +
            _fnum('cj_api', 'Oil / condensate gravity (°API)', 50, ' min="10" max="90"') +
            _fnum('cj_qw', 'Water rate (BPD)', 2, ' min="0"') +
            _fnum('cj_sgw', 'Water SG', 1.05, ' min="1" max="1.25"') +
            _fsel('cj_wbasis', 'Water rate is', _optsList([['free', 'Free (formation) water at the wellhead'], ['sep', 'Measured at the separator']], 'free')) +
            _fnum('cj_h2so', 'H2S dissolved in oil (ppm by mass)', 0, ' min="0"') +
            _fnum('cj_h2sw', 'H2S dissolved in water (ppm by mass)', 0, ' min="0"') +
            '</div></div>' +
            '<div class="card" id="cj_card_spread"><div class="card-title">Spread conditions</div><div class="fg">' +
            _fnum('cj_sithp', 'Shut-in tubing head pressure, SITHP (psig)', 3500, ' min="0"') +
            _fnum('cj_fwhp', 'Flowing wellhead pressure, FWHP (psig)', 3000, ' min="0"') +
            _fnum('cj_fwht', 'Flowing wellhead temperature (°F)', 110) +
            _fnum('cj_tamb', 'Ambient / cold-tree temperature (°F)', 60) +
            _fnum('cj_pck', 'Pressure downstream of choke (psig)', 1000, ' min="0"') +
            _fsel('cj_jt', 'Choke outlet temperature from', _optsList([['ise', 'Real-gas isenthalpic × J-T factor'], ['rule', '7 °F per 100 psi rule (quick check)'], ['user', 'User value']], 'ise')) +
            _fnum('cj_tck', 'Choke outlet temperature, user (°F)', 34.6, '', ' style="display:none"') +
            _fsel('cj_htr', 'Heater on the spread', _optsList(yesno, 'yes')) +
            _fnum('cj_thtr', 'Heater outlet temperature (°F)', 90) +
            _fnum('cj_psep', 'Separator pressure (psig)', 1000, ' min="0"') +
            _fnum('cj_tsep', 'Separator temperature, blank = heater or choke outlet (°F)', '', ' placeholder="auto"') +
            _fnum('cj_psvsep', 'Separator relief-valve set pressure (psig)', 1440, ' min="0"') +
            _fsel('cj_whclass', 'Flowhead / data-header pressure class', _optsList([[2000, '2,000 psi (13.8 MPa)'], [3000, '3,000 psi (20.7 MPa)'], [5000, '5,000 psi (34.5 MPa)'], [10000, '10,000 psi (69.0 MPa)'], [15000, '15,000 psi (103.4 MPa)']], 5000)) +
            _fsel('cj_haz', 'Chemical pumps in a classified (hazardous) area', _optsList(yesno, 'yes')) +
            _fsel('cj_supgas', 'Pneumatic / air-pump drive gas', _optsList([['air', 'Instrument air'], ['n2', 'Nitrogen'], ['sweet', 'Sweet fuel gas'], ['well', 'Produced well gas']], 'air')) +
            _fnum('cj_pbpv', 'Flare line downstream of the back-pressure valve, blank = 0 (psig)', '', ' min="0" placeholder="blank"') +
            '</div></div></div>' +
            '<div class="card" id="cj_card_basis"><div class="card-title">Design basis</div><div class="fg">' +
            _fnum('cj_margin', 'Hydrate design margin (°F)', 10, ' min="0" max="30"') +
            _fnum('cj_fjt', 'J-T cooling design factor (1.00 to 1.30)', 1.10, ' min="1" max="1.3"') +
            _fsel('cj_thsrc', 'Hydrate temperature from', _optsList([['tm', 'Gas-gravity correlation (Towler–Mokhatab)'], ['user', 'User / lab value at one pressure']], 'tm')) +
            _fnum('cj_thuser', 'User hydrate temperature (°F)', '', '', ' style="display:none"') +
            _fnum('cj_thuserp', 'Pressure of the user hydrate temperature (psig)', '', ' min="0"', ' style="display:none"') +
            _fsel('cj_method', 'Depression method', _optsList([['auto', 'Larger of Hammerschmidt and Nielsen–Bucklin'], ['ham', 'Hammerschmidt (comparison only)'], ['nb', 'Nielsen–Bucklin (comparison only)']], 'auto')) +
            _fsel('cj_cond', 'Condensed water', _optsList([['buk', 'Bukacek water content'], ['all', 'All vapour water condenses (conservative)']], 'buk')) +
            _fnum('cj_h2scus', 'H2S outlet target for scavenger lines (ppm)', 4, ' min="0"') +
            _fnum('cj_pmpct', 'Pump pressure margin, percent (%)', 10, ' min="0" max="50"') +
            _fnum('cj_pmabs', 'Pump pressure margin, absolute (psi)', 100, ' min="0"') +
            _fsel('cj_ratebasis', 'Discharge-circuit rating basis', _optsList([['credible', 'Maximum credible back-pressure'], ['class', 'Full tie-in class']], 'credible')) +
            _fnum('cj_days', 'Test duration (d)', 5, ' min="0.1" max="90"') +
            _fnum('cj_psup', 'Drive-gas (air) pressure available (psig)', 100, ' min="10"') +
            '</div>' +
            _tog('cj_adv_basis', 'Advanced design basis', 'Show advanced design basis') +
            '<div class="fg cj-adv" id="cj_basis_adv" style="display:none">' +
            _fnum('cj_fc', 'Methanol loss to condensate at 30 wt % and 40 °F (lb/bbl)', 0.25, ' min="0"') +
            _fnum('cj_glyloss', 'Glycol loss allowance (%)', 1, ' min="0" max="10"') +
            _fnum('cj_sour', 'Sour adder per mol % H2S, and for CO2 above 5 mol % (°F)', 5, ' min="0"') +
            _fnum('cj_band_g', 'Setting band, green up to (% of maximum)', 70, ' min="50" max="95"') +
            _fnum('cj_band_a', 'Setting band, amber up to (% of maximum)', 85, ' min="50" max="95"') +
            _fnum('cj_minf', 'Minimum-rate factor for the turndown check', 0.5, ' min="0.1" max="1"') +
            '</div></div>' +
            '<div class="card" id="cj_card_lines"><div class="card-title">Injection lines</div><div class="fg">' +
            _fsel('cj_nlines', 'Number of injection lines', _optsList(nl, 1)) +
            '</div><div class="cj-hint">For each line choose the injection point, the chemical and the pump. Choosing a chemical fills in its dose and product data; the point never changes by itself, and its suitability shows as a verdict.</div></div>' +
            lines +
            '<div class="card" id="cj_card_cal"><div class="card-title">Field calibration check</div><div class="fg">' +
            _fsel('cj_cal_line', 'Line tested', _optsList(cl, 1)) +
            _fnum('cj_cal_ml', 'Measured volume drawn down (mL)', '', ' min="0" placeholder="blank = no check"') +
            _fnum('cj_cal_s', 'Measured time (s)', '', ' min="0" placeholder="e.g. 60"') +
            _fnum('cj_cal_set', 'Setting during the test (SPM)', '', ' min="0"') +
            _fnum('cj_cal_air', 'Air pressure during the test (psig)', '', ' min="0"', ' style="display:none"') +
            _fnum('cj_cal_pd', 'Discharge pressure during the test, blank = flowing line pressure + allowance (psig)', '', ' min="0" placeholder="auto"', ' style="display:none"') +
            '</div></div>' +
            '<div id="cj_res"></div>' +
            '<div class="card" id="cj_charts"><div class="card-title">Charts</div>' +
            '<div class="fg cj-chartsel rp-skip">' + _fsel('cj_chart_line', 'Pump chart for line', _optsList(cl, 1)) + '</div>' +
            '<div class="rbox"><div class="rbox-title">Hydrate curve vs spread temperatures</div>' +
            '<div class="chart-wrap"><canvas id="cj_chart_hyd" width="720" height="300" role="img" aria-label="Hydrate curve against the spread temperatures"></canvas></div></div>' +
            '<div class="rbox"><div class="rbox-title" id="cj_chart_pump_t">Pump rate vs setting, line 1</div>' +
            '<div class="chart-wrap"><canvas id="cj_chart_pump" width="720" height="300" role="img" aria-label="Pump rate against the pump setting"></canvas></div></div>' +
            '</div>' +
            '<div id="cj_notes_res"></div>' +
            '</div>';
    }

    // ── Show / hide and data-prev (restore-safe: static markup, nothing rebuilt) ──
    function _lineTokens(n) {
        var L = _lib(), c = L.find(_sv('cj_chem_' + n)), P = L.pump(_sv('cj_pump_' + n)), b = _sv('cj_basis_' + n), tok = {};
        if (c && c.kind === 'thi' && b === 'wt_water') tok.thi = 1; else tok.nonthi = 1;
        if (c && c.stoich && (b === 'gal_lb_h2s' || b === 'l_kg_h2s')) tok.scav = 1;
        if (b === 'ppm_per_ppm_o2') tok.o2 = 1;
        if (P) { tok[P.kind] = 1; if (P.kind === 'plunger') tok[P.setting === 'spm' ? 'pneu' : 'elecplunger'] = 1; }
        return tok;
    }
    function _applyVisibility() {
        var L = _lib(), root = _pgById('cj_root');
        if (!L || !root) return;
        var nl = Math.max(1, Math.min(NLINES, parseInt(_sv('cj_nlines'), 10) || 1));
        _show(_wrapOf('cj_tck'), _sv('cj_jt') === 'user');
        _show(_wrapOf('cj_thtr'), _sv('cj_htr') !== 'no');
        _show(_wrapOf('cj_thuser'), _sv('cj_thsrc') === 'user');
        _show(_wrapOf('cj_thuserp'), _sv('cj_thsrc') === 'user');
        _show(_pgById('cj_basis_adv'), _checked('cj_adv_basis'));
        for (var n = 1; n <= NLINES; n++) {
            var card = _pgById('cj_line_' + n);
            if (!card) continue;
            _show(card, n <= nl);
            var tok = _lineTokens(n);
            _each(card.querySelectorAll('[data-k]'), function (w) {
                _show(w, String(w.getAttribute('data-k')).split(' ').some(function (k) { return !!tok[k]; }));
            });
            _show(_pgById('cj_advbox_' + n), _checked('cj_adv_' + n));
            var dl = _pgById('cj_dose_' + n), lab = dl && dl.closest ? dl.closest('.fg-item').querySelector('label') : null;
            if (lab) lab.textContent = _doseLabel(_sv('cj_basis_' + n));
        }
        // calibration: air pressure for an air-driven line, else SPM / % speed / % stroke
        var cl = parseInt(_sv('cj_cal_line'), 10) || 1, P = L.pump(_sv('cj_pump_' + cl)), air = !!(P && P.kind === 'airliquid');
        _show(_wrapOf('cj_cal_air'), air);
        _show(_wrapOf('cj_cal_pd'), air);
        _show(_wrapOf('cj_cal_set'), !air);
        var cs = _wrapOf('cj_cal_set'), csl = cs ? cs.querySelector('label') : null;
        if (csl && P) csl.textContent = 'Setting during the test (' + (P.setting === 'spm' ? 'SPM' : P.kind === 'transfer' ? 'cycles/min' : (P.kind === 'plunger' && !P.vfd) ? '% stroke' : '% speed') + ')';
    }
    function _syncUi() {
        for (var n = 1; n <= NLINES; n++) {
            var c = _pgById('cj_chem_' + n), p = _pgById('cj_pump_' + n);
            if (c) c.setAttribute('data-prev', c.value);
            if (p) p.setAttribute('data-prev', p.value);
        }
        _applyVisibility();
    }
    // A chemical change presets only chemical-property fields, once per actual change (data-prev).
    // It runs inside the #pgBody change event (canonical context), so tagged writes are imperial.
    function _setv(id, v) { var e = _pgById(id); if (e) e.value = (v == null || (typeof v === 'number' && !isFinite(v))) ? '' : String(v); }
    function _presetChem(n) {
        var L = _lib(), sel = _pgById('cj_chem_' + n);
        if (!L || !sel) return;
        var key = sel.value;
        if (key === sel.getAttribute('data-prev')) return;
        sel.setAttribute('data-prev', key);
        var c = L.find(key);
        if (!c) return;
        var basis = c.basis, dose = c.dose, B = L.bases[basis];
        if (_isM() && B && B.twin && (basis === 'pt_mmscf' || basis === 'gal_mmscf' || basis === 'gal_lb_h2s')) {
            dose = dose == null ? null : dose * B.factor;
            basis = B.twin;
        }
        _setv('cj_basis_' + n, basis);
        _setv('cj_dose_' + n, dose == null ? '' : _r6(dose));
        _setv('cj_lean_' + n, c.leanDef == null ? '' : c.leanDef);
        _setv('cj_sgc_' + n, c.sg);
        _setv('cj_eff_' + n, '');
        _setv('cj_act_' + n, c.activeDef == null ? '' : c.activeDef);
        _setv('cj_wat_' + n, c.kind === 'thi' ? '' : _r6(c.water * 100));
        _setv('cj_peak_' + n, c.peak);
    }
    function _presetPump(n) {
        var L = _lib(), sel = _pgById('cj_pump_' + n);
        if (!L || !sel) return;
        var key = sel.value;
        if (key === sel.getAttribute('data-prev')) return;
        sel.setAttribute('data-prev', key);
        var P = L.pump(key);
        if (!P) return;
        if (P.kind === 'plunger') {
            _setv('cj_plg_' + n, P.plungerDef);
            _setv('cj_stk_' + n, P.strokeDef);
            if (Number(_sv('cj_heads_' + n)) > (P.headsMax || 1)) _setv('cj_heads_' + n, 1);
            if (P.setting === 'spm') _setv('cj_actd_' + n, P.actDef || 4);
        } else if (P.kind === 'meter') {
            _setv('cj_qrated_' + n, _r6(P.qRated_galh));
            _setv('cj_pmax_' + n, P.pmax);
        } else if (P.kind === 'airliquid') {
            _setv('cj_q0_' + n, P.q0_galh);
            _setv('cj_ratio_' + n, P.ratio);
            _setv('cj_vcyc_' + n, P.vcyc_in3);
        } else if (P.kind === 'transfer') _setv('cj_q0_' + n, P.q0_galh);
        if (P.kind !== 'airliquid') { _setv('cj_ratio_' + n, ''); _setv('cj_vcyc_' + n, ''); }
        _setv('cj_spmmax_' + n, '');
    }
    function _onChange(e) {
        var t = e && e.target, id = (t && t.id) || '';
        if (!/^cj_/.test(id)) return;
        var m = /^cj_(chem|pump)_(\d)$/.exec(id);
        if (m) { if (m[1] === 'chem') _presetChem(Number(m[2])); else _presetPump(Number(m[2])); }
        _applyVisibility();
        G.calcChemInj();
    }

    // ── Read the controls (canonical values inside calcChemInj) ──────
    function _readInput() {
        var root = _pgById('cj_root'), map = {}, L = _lib();
        _each(root.querySelectorAll('input[id], select[id]'), function (el) {
            if (!/^cj_/.test(el.id) || el.type === 'checkbox') return;
            map[el.id] = String(el.value == null ? '' : el.value).trim();
        });
        var inp = G.WTS_cheminj.fromIds(map), ctx = { calUnused: false, calIncomplete: false, calLine: 1 };
        var nl = parseInt(map.cj_nlines, 10) || 1, cl = parseInt(map.cj_cal_line, 10) || 1;
        ctx.calLine = cl;
        // The calibration card never blocks the results: a line not in use or a half-filled
        // entry is reported in the calibration box instead of the validation list.
        if (map.cj_cal_ml !== '' && map.cj_cal_ml !== undefined) {
            var P = L.pump(map['cj_pump_' + cl]), set = (P && P.kind === 'airliquid') ? map.cj_cal_air : map.cj_cal_set;
            var pos = function (v) { var x = Number(v); return v !== '' && v != null && isFinite(x) && x > 0 && x < 1e7; };
            var air = !!(P && P.kind === 'airliquid'), pd = map.cj_cal_pd, pdx = Number(pd);
            var pdOk = !air || pd === '' || pd == null || (isFinite(pdx) && pdx >= 0 && pdx <= 30000);
            if (cl > nl) ctx.calUnused = true;
            else if (!(pos(map.cj_cal_ml) && pos(map.cj_cal_s) && pos(set) && pdOk)) ctx.calIncomplete = true;
            if (ctx.calUnused || ctx.calIncomplete) inp.cal = { line: 1, mL: '', s: '', setting: '', pd: '' };
            else { inp.cal.setting = set; if (!air) inp.cal.pd = ''; }
        }
        return { inp: inp, map: map, ctx: ctx };
    }

    // ── Results ──────────────────────────────────────────────────────
    var SYM = { ok: '✓', warn: '⚠', bad: '✗' };
    var VCOL = { ok: 'var(--green)', warn: 'var(--yellow)', bad: 'var(--red)' };
    function _vdiv(v) {
        var lv = (v && SYM[v.level]) ? v.level : 'warn';
        return '<div class="cj-v" style="color:' + VCOL[lv] + '">' + SYM[lv] + ' ' + _esc(String(v.text || '').slice(0, 296)) + '</div>';
    }
    function _rrow(l, v, txt) { return '<div class="rrow"><span class="rl">' + _esc(l) + '</span><span class="rv' + (txt ? ' cj-t' : '') + '">' + _esc(v) + '</span></div>'; }
    function _subh(t) { return '<div class="cj-sub">' + _esc(t) + '</div>'; }
    function _tbl(head, rows) {
        return '<div class="cj-tw"><table class="dtable"><thead><tr>' + head.map(function (x) { return '<th>' + _esc(x) + '</th>'; }).join('') + '</tr></thead><tbody>' +
            rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + _esc(c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
    }
    function _worse(a, b) { var o = { ok: 0, warn: 1, bad: 2 }; return (o[b] || 0) > (o[a] || 0) ? b : a; }
    function _bandTxt(b) { return b === 'green' ? 'green band' : b === 'amber' ? 'amber band' : 'red band'; }
    function _pctTxt(p) { return _fin(p) && p < 900 ? _nf(p, p < 10 ? 1 : 0) + ' %' : '—'; }
    function _lineName(ln) { return ln.chemShort + ' · ' + ln.pointShort; }

    function _headline(r) {
        var lv = 'ok';
        r.lines.forEach(function (ln) { lv = _worse(lv, ln.level); });
        r.hydrate.verdicts.forEach(function (v) { lv = _worse(lv, v.level); });
        r.summary.verdicts.forEach(function (v) { if (v.level === 'bad') lv = 'bad'; });
        var l1 = r.lines[0];
        var one = function (ln) {
            return ln.chemShort + ' ' + _low1(ln.pointShort) + ', ' + (ln.rate.gal_d > 0 ? _rq(ln.rate.gal_d) + ' (' + _nf(ln.rate.mL_min, 1) + ' mL/min)' + (ln.setting ? ', ' + ln.setting : '') : (ln.zeroText || 'no flow required'));
        };
        var t = r.lines.length === 1 ? 'Line 1: ' + one(l1) + '.'
            : r.lines.length + ' injection lines, ' + _rq(r.summary.total_gal_d) + ' in total. Line 1: ' + one(l1) + '.';
        return _vdiv({ level: lv, text: t });
    }
    function _basisBox(r) {
        var b = r.basis, S = r.spread, m = S.margin, sp = r.input.spread;
        var h = '<div class="rbox" id="cj_rb_basis"><div class="rbox-title">Design basis</div>';
        h += _rrow('Hydrate design margin', m.adder > 0 ? _qv(m.base, 'tempDelta', 1, '°F') + ' + ' + _qv(m.adder, 'tempDelta', 1, '°F') + ' sour adder = ' + _qv(m.used, 'tempDelta', 1, '°F') : _qv(m.used, 'tempDelta', 1, '°F'));
        h += _rrow('Hydrate temperature', S.thydSrc === 'user'
            ? 'User value ' + _qv(Number(r.input.basis.thuser), 'temperature', 1, '°F') + ' at ' + _qv(Number(r.input.basis.thuserp), 'pressureG', 0, 'psig') + ', correlation curve shifted in parallel'
            : 'Gas-gravity correlation (Towler–Mokhatab), sweet gas, about ±' + _qv(5, 'tempDelta', 1, '°F'), true);
        h += _rrow('Choke outlet temperature', b.jt === 'ise' ? 'Real-gas isenthalpic (DAK) for the gas only (liquids reduce the cooling), with J-T cooling × ' + _nf(b.fJT, 2, 2)
            : b.jt === 'rule' ? _ruleTxt() + ' rule (quick check)' : 'User value', true);
        h += _rrow('Depression method', b.method === 'ham' ? 'Hammerschmidt (forced, comparison only)' : b.method === 'nb' ? 'Nielsen–Bucklin (forced, comparison only)'
            : 'Larger of Hammerschmidt and Nielsen–Bucklin (Hammerschmidt only for DEG and TEG)', true);
        h += _rrow('Condensed water', b.cond === 'all' ? 'All vapour water condenses at the cold node (conservative)' : 'Bukacek water content, gas saturated at the flowhead', true);
        h += _rrow('Water rate', b.wbasis === 'sep' ? 'Measured at the separator' : 'Free (formation) water at the wellhead', true);
        h += _rrow('Discharge rating basis', b.ratebasis === 'class'
            ? 'Full tie-in class: flowhead ' + _qv(Number(sp.whclass), 'pressureG', 0, 'psig') + ', separator relief valve ' + _qv(sp.psvsep, 'pressureG', 0, 'psig')
            : 'Maximum credible back-pressure: SITHP ' + _qv(sp.sithp, 'pressureG', 0, 'psig') + ' at the wellbore, separator relief valve ' + _qv(sp.psvsep, 'pressureG', 0, 'psig') + ' downstream of the choke', true);
        h += _rrow('Pump pressure margins', _nf(b.pmpct, 1) + ' % and ' + _qv(b.pmabs, 'pressure', 0, 'psi'));
        h += _rrow('Pumps in a classified area', b.haz === 'yes' ? 'Yes: pneumatic and air-driven pumps rank first' : 'No', true);
        h += _rrow('Drive gas', ({ air: 'Instrument air', n2: 'Nitrogen', sweet: 'Sweet fuel gas', well: 'Produced well gas' })[b.supgas] + ', ' + _qv(b.psup, 'pressureG', 0, 'psig') + ' available', true);
        h += _rrow('Test duration', _nf(b.days, 1) + ' d');
        h += _rrow('Molar volume at the base conditions', _isM() ? _nf(b.vm * 0.028316846592 / 0.45359237, 3) + ' m³/kmol' : _nf(b.vm, 2) + ' scf/lb-mol');
        if (r.lines.some(function (ln) { return ln.scav; })) h += _rrow('H2S outlet target (scavenger lines)', _nf(b.h2sOut, 2) + ' ppm');
        h += _rrow('Advanced values', 'methanol loss to condensate ' + _qv(b.fc, 'lbPerBbl', 3, 'lb/bbl') + ' at 30 wt %; glycol loss ' + _nf(b.glyloss, 1) + ' %; sour adder ' +
            _qv(b.sour, 'tempDelta', 1, '°F') + ' per mol %; bands green ≤ ' + _nf(b.bandG, 0) + ' %, amber ≤ ' + _nf(b.bandA, 0) + ' %; minimum-rate factor ' + _nf(b.minf, 2), true);
        return h + '</div>';
    }
    function _statusTxt(s) { return s === 'refused' ? '✗ refused: enter a lab hydrate temperature' : s === 'bad' ? '✗ hydrate region' : s === 'warn' ? '⚠ within margin' : '✓ no risk'; }
    function _thiRows(ln, prefix) {
        var hd = ln.hydrate, h = '', c = _lib().find(ln.chem), name = c ? _low1(c.short) : 'inhibitor';
        if (!hd || !hd.ok) return '';
        if (hd.control) {
            h += _rrow(prefix + 'Controlling node', hd.control.label + ': ' + _qv(hd.control.t_F, 'temperature', 1, '°F') + ' at ' + _qv(hd.control.p_psig, 'pressureG', 0, 'psig') +
                ', hydrate ' + _qv(hd.control.thyd, 'temperature', 1, '°F'), true);
        }
        if (hd.required && !hd.noRate && hd.water) {
            h += _rrow(prefix + 'Required depression (hydrate − T + margin)', _qv(hd.dT, 'tempDelta', 2, '°F'));
            h += _rrow(prefix + 'Rich inhibitor in the water', _nf(hd.XR, 2, 2) + ' wt % ' + name + ' (' +
                (hd.methodUsed === 'nb' ? 'Nielsen–Bucklin' : hd.methodUsed === 'ham' ? 'Hammerschmidt' : 'entered') + '; Hammerschmidt ' + _nf(hd.XR_ham, 2, 2) + ' wt %)');
            var w = hd.water;
            h += _rrow(prefix + 'Water to treat: free + condensed + other chemicals', _qv(w.total, 'massRateDay', 1, 'lb/d') + ' (' + _nf(_dv(w.free, 'massRateDay'), 1) + ' + ' +
                _nf(_dv(w.cond, 'massRateDay'), 1) + ' + ' + _nf(_dv(w.other, 'massRateDay'), 1) + ')');
            var inh = hd.inh;
            h += _rrow(prefix + 'Inhibitor: in water + vapour loss + condensate loss', _nf(_dv(inh.aq, 'massRateDay'), 1) + ' + ' + _nf(_dv(inh.vap, 'massRateDay'), 1) + ' + ' +
                _nf(_dv(inh.lhc, 'massRateDay'), 1) + ' ' + _ul('massRateDay', 'lb/d') + (inh.loss > 0 ? ' (glycol loss ' + _qv(inh.loss, 'massRateDay', 1, 'lb/d') + ')' : ''));
            h += _rrow(prefix + 'Lean solution rate', _qv(inh.solution_lb_d, 'massRateDay', 1, 'lb/d') + ' = ' + _rq(inh.gal_d) + ' at ' + _nf(hd.leanPct, 1) + ' wt %');
            if (hd.freezeF != null) h += _rrow(prefix + 'Rich-phase freeze point', _qv(hd.freezeF, 'temperature', 1, '°F'));
        }
        return h;
    }
    function _caseTxt(cr, chemName, dT, refused) {
        if (refused) return 'Not assessed: the sweet-gas correlation is refused; enter a lab or composition-based hydrate temperature';
        if (!(dT > 0)) return 'No inhibitor needed with the margin';
        if (!cr) return 'Depression needed ' + _qv(dT, 'tempDelta', 2, '°F');
        return _nf(cr.XR, 2, 2) + ' wt % ' + chemName + ' (depression ' + _qv(dT, 'tempDelta', 2, '°F') + ')';
    }
    function _spreadBox(r) {
        var S = r.spread, H = r.hydrate, m = S.margin, b = r.basis, h = '';
        var jt = b.jt === 'ise' ? 'J-T × ' + _nf(b.fJT, 2, 2) : b.jt === 'rule' ? 'J-T ' + _ruleTxt() : 'choke temperature entered';
        h += '<div class="rbox" id="cj_rb_spread"><div class="rbox-title">Spread hydrate check (margin ' + _esc(_qv(m.used, 'tempDelta', 1, '°F')) + ', ' + _esc(jt) + ')</div>';
        var rows = S.nodes.concat([S.shutin, S.startup]).map(function (nd) {
            return [nd.label, _nf(_dv(nd.p_psig, 'pressureG'), 0),
                _nf(_dv(nd.t_F, 'temperature'), 1) + (nd.tDak_F != null && b.jt === 'ise' ? ' (DAK ' + _nf(_dv(nd.tDak_F, 'temperature'), 1) + ')' : ''),
                _nf(_dv(nd.thyd, 'temperature'), 1), _nf(_dv(nd.sub, 'tempDelta'), 1), _statusTxt(nd.status)];
        });
        h += _tbl(['Node', 'Pressure (' + _ul('pressureG', 'psig') + ')', 'Temperature (' + _ul('temperature', '°F') + ')', 'Hydrate temperature (' + _ul('temperature', '°F') + ')',
            'Subcooling, hydrate − T (' + _ul('tempDelta', '°F') + ')', 'Status'], rows);
        var ck = H.jt.choke;
        h += _rrow('Choke outlet temperature', ck.method === 'ise' ? _qv(ck.t, 'temperature', 2, '°F') + ' design (DAK ' + _qv(ck.tDak, 'temperature', 2, '°F') + ', J-T × ' + _nf(b.fJT, 2, 2) + ')'
            : ck.method === 'rule' ? _qv(ck.t, 'temperature', 2, '°F') + ' (' + _ruleTxt() + ' rule)' : _qv(ck.t, 'temperature', 2, '°F') + ' (entered)');
        h += _rrow('Design margin used', _qv(m.used, 'tempDelta', 1, '°F') + (m.adder > 0 ? ' (includes ' + _qv(m.adder, 'tempDelta', 1, '°F') + ' sour adder)' : ''));
        var thi = r.lines.filter(function (ln) { return ln.kind === 'thi' && ln.hydrate; });
        thi.forEach(function (ln) { h += _thiRows(ln, thi.length > 1 ? 'Line ' + ln.n + ': ' : ''); });
        var t0 = thi.filter(function (ln) { return ln.hydrate.ok; })[0], cn = t0 ? _low1(t0.chemShort) : '';
        h += _rrow('Shut-in requirement (SITHP, ambient)', _caseTxt(t0 && t0.hydrate.shutin, cn, S.shutin.dTreq, m.refused), true);
        h += _rrow('Start-up requirement (cold tree to choke outlet)', _caseTxt(t0 && t0.hydrate.startup, cn, S.startup.dTreq, m.refused), true);
        if (!thi.length && S.nodes.some(function (nd) { return nd.dTreq > 0; })) h += _rrow('Hydrate inhibitor line', 'None: add a line with a thermodynamic inhibitor upstream of the first risk node', true);
        var seen = {};
        H.verdicts.forEach(function (v) { if (!seen[v.text]) { seen[v.text] = 1; h += _vdiv(v); } });
        var ws = (S.warnings || []).slice();
        thi.forEach(function (ln) { (ln.hydrate.warnings || []).forEach(function (w) { ws.push(w); }); });
        ws.forEach(function (w) { if (!seen[w]) { seen[w] = 1; h += _vdiv({ level: 'warn', text: w }); } });
        return h + '</div>';
    }
    function _pumpCfgTxt(ps) {
        if (ps.kind !== 'plunger') return ps.name;
        var t = ps.name + ', ' + _frac(ps.plunger_in) + ' × ' + _frac(ps.stroke_in) + ' in, ' + ps.heads + (ps.heads > 1 ? ' heads' : ' head');
        if (ps.setting === 'spm' && ps.actD_in != null) t += ', ' + _frac(ps.actD_in) + ' in actuator';
        return t;
    }
    function _pumpRows(ln, r) {
        var ps = ln.pump, h = '';
        h += _rrow('Pump', _pumpCfgTxt(ps), true);
        if (ps.noFlow) return h + _rrow('Pump setting', ln.zeroText ? _cap1(ln.zeroText) : 'No flow required', true);
        if (ps.kind === 'airliquid') {
            h += _rrow('Air pressure setting at the shut-in design pressure: design · peak', ps.airDesign != null
                ? _qv(ps.airDesign, 'pressureG', 1, 'psig', 0) + ' · ' + (ps.airPeak != null ? _qv(ps.airPeak, 'pressureG', 1, 'psig', 0) : 'peak not reachable')
                : 'Not reachable at the required pressure');
            if (ps.pFlow < ps.pReq - 0.5) {
                h += _rrow('Operating air setting while flowing (' + _qv(ps.pFlow, 'pressureG', 0, 'psig') + '): design · peak', ps.airFlow != null
                    ? _qv(ps.airFlow, 'pressureG', 1, 'psig', 0) + ' · ' + (ps.airFlowPeak != null ? _qv(ps.airFlowPeak, 'pressureG', 1, 'psig', 0) : 'peak not reachable')
                    : 'Not reachable');
            }
            h += _rrow('Flow at the required pressure with full air', _rq(ps.qAtPreq) + ' at ' + _qv(ps.pReq, 'pressureG', 0, 'psig'));
            h += _rrow('Cycles per minute (field count): design · peak', ps.cyclesMin != null ? _nf(ps.cyclesMin, 1, 1) + ' · ' + _nf(ps.cyclesPeak, 1, 1) : '—');
            h += _rrow('Stall pressure at the design setting', ps.pStallDesign != null ? _qv(ps.pStallDesign, 'pressureG', 0, 'psig') : '—');
            h += _rrow('Air setting, share of the air available', _pctTxt(ps.pct) + ' of ' + _qv(r.basis.psup, 'pressureG', 0, 'psig') + ' (' + _bandTxt(ps.band) + ')');
        } else if (ps.kind === 'plunger' && ps.setting === 'spm') {
            h += _rrow('Speed: design · peak · minimum', _nf(ps.spm, 1, 1) + ' · ' + _nf(ps.spmPeak, 1, 1) + ' · ' + _nf(ps.spmMin, 1, 1) + ' SPM');
            h += _rrow('Share of the maximum SPM', _pctTxt(ps.pct) + ' of ' + _nf(ps.spmMax, 0) + ' SPM, peak ' + _pctTxt(ps.peakPct) + ' (' + _bandTxt(ps.band) + ')');
            h += _rrow('Seconds per stroke · strokes per 15 s', (ps.sPerStroke != null ? _nf(ps.sPerStroke, 2, 2) + ' s' : '—') + ' · ' + _nf(ps.per15, 1, 1));
            h += _rrow('Volume per stroke: swept · delivered (ηv ' + _nf(ps.eta, 2, 2) + ')', _nf(ps.Vs_mL, 3) + ' · ' + _nf(ps.del_mL, 3) + ' mL');
            h += _rrow('Pump maximum pressure', _qv(ps.pMax, 'pressureG', 0, 'psig') + (ps.pOk ? ' ✓' : ' ✗'));
            h += _rrow('Drive-gas setting at the shut-in design pressure', _qv(ps.psSet, 'pressureG', 1, 'psig', 0) + (ps.gasOk ? ' ✓' : ' ✗'));
        } else if (ps.kind === 'plunger') {
            h += _rrow('Setting', ps.vfd ? _nf(ps.S, 0) + ' % stroke × ' + _nf(ps.N, 1) + ' % speed' : _nf(ps.S, 1, 1) + ' % stroke at ' + _nf(ps.spmCrank, 0) + ' SPM');
            h += _rrow('Share of the pump maximum: design · peak', _pctTxt(ps.pct) + ' · ' + _pctTxt(ps.peakPct) + ' (' + _bandTxt(ps.band) + ')');
            h += _rrow('Volume per stroke at this setting: swept · delivered', _nf(ps.mLperStroke, 2, 2) + ' · ' + _nf(ps.del_mL, 2, 2) + ' mL');
            h += _rrow('Pump maximum pressure (rod load)', _qv(ps.pMax, 'pressureG', 0, 'psig') + (ps.pOk ? ' ✓' : ' ✗'));
            h += _rrow('Hydraulic power: at the required pressure · at the rating', _qv(ps.hhp, 'power', 2, 'hp', 3) + ' · ' + _qv(ps.hhpRating, 'power', 2, 'hp', 3));
        } else if (ps.kind === 'meter') {
            h += _rrow('Setting', _nf(ps.S, 0) + ' % stroke × ' + _nf(ps.N, 1) + ' % speed' + (ps.alt ? ' (alternative ' + _nf(ps.alt.S, 0) + ' × ' + _nf(ps.alt.N, 1) + ')' : ''));
            h += _rrow('Share of the pump maximum: design · peak', _pctTxt(ps.pct) + ' · ' + _pctTxt(ps.peakPct) + ' (' + _bandTxt(ps.band) + ')');
            h += _rrow('Pulse rate · volume per stroke', _nf(ps.pulse, 1, 1) + ' per min · ' + _nf(ps.mLperStroke, 3) + ' mL');
            h += _rrow('Rated capacity · maximum pressure', _qv(ps.qRated_galh, 'chemRateHr', 2, 'gal/h') + ' · ' + _qv(ps.pMax, 'pressureG', 0, 'psig') + (ps.pOk ? ' ✓' : ' ✗'));
        } else if (ps.kind === 'transfer') {
            h += _rrow('Cycles per minute: design · peak', _nf(ps.cyclesMin, 1, 1) + ' · ' + _nf(ps.cyclesPeak, 1, 1));
            h += _rrow('Share of the free flow', _pctTxt(ps.pct) + ' (' + _bandTxt(ps.band) + ')');
        }
        return h;
    }
    function _optSetting(o) {
        if (o.kind === 'airliquid') return o.airDesign != null ? 'air ' + _qv(o.airDesign, 'pressureG', 1, 'psig', 0) : 'not reachable';
        if (o.setting === 'spm') return _nf(o.spm, 1, 1) + ' SPM';
        if (o.setting === 'stroke_speed') return (o.N != null && o.N < 99.95 ? _nf(o.S, 0) + ' % × ' + _nf(o.N, 1) + ' %' : _nf(o.S, 1, 1) + ' % stroke');
        if (o.kind === 'transfer') return _nf(o.cyclesMin, 1, 1) + ' cycles/min';
        return '—';
    }
    function _optionsTable(ln) {
        var op = ln.options;
        if (!op || !op.ok) return '';
        var rows = op.ranked.map(function (o, k) {
            return [String(k + 1), o.kind === 'plunger' ? _pumpLabel({ short: o.name }) + ', ' + o.label : _pumpLabel({ short: o.name }), _optSetting(o),
                _pctTxt(o.pct) + ' (peak ' + _pctTxt(o.peakPct) + ')', _nf(_dv(o.pMax, 'pressureG'), 0), '✓ feasible'];
        });
        var c = op.current;
        if (c && c.ok) {
            rows.push(['Current', _pumpCfgTxt(c), c.noFlow ? (ln.zeroText || 'no flow') : _optSetting(c), c.noFlow ? '—' : _pctTxt(c.pct) + ' (peak ' + _pctTxt(c.peakPct) + ')',
                _nf(_dv(c.pMax, 'pressureG'), 0), c.feasible ? '✓ feasible' : '✗ ' + (c.whyText || 'not feasible')]);
        }
        var h = _subh('Pump options (top 3 feasible, ranked; then the current choice)') +
            _tbl(['#', 'Option', 'Setting', 'Share of maximum', 'Maximum pressure (' + _ul('pressureG', 'psig') + ')', 'Verdict'], rows);
        if (op.reason) h += _vdiv({ level: 'warn', text: op.reason });
        return h;
    }
    function _pressureRows(ln) {
        var ip = ln.pressure, ps = ln.pump, h = '';
        var bb = { sithp: 'SITHP', psvsep: 'separator relief-valve set pressure', whclass: 'flowhead pressure class', none: 'atmospheric tank' }[ip.pBackBasis] || ip.pBackBasis;
        h += _rrow('Required discharge pressure: line + allowance', _qv(ip.pReq, 'pressureG', 0, 'psig') + ' (' + _nf(_dv(ip.pLine, 'pressureG'), 0) + ' + ' + _nf(_dv(ip.breakdown.allowance, 'pressure'), 0) + ')');
        h += _rrow('Back-pressure basis', _qv(ip.pBack, 'pressureG', 0, 'psig') + ' (' + bb + ')');
        h += _rrow('Minimum discharge-circuit rating', _qv(ip.pRating, 'pressureG', 0, 'psig'));
        h += _rrow('Pump pressure capability', ps.pMax != null ? _qv(ps.pMax, 'pressureG', 0, 'psig') + (ps.pOk ? ' ✓' : ' ✗') : '—');
        h += _rrow('Relief-valve set band', ip.psvBand.hi != null ? _qv(ip.psvBand.lo, 'pressureG', 0, 'psig') + ' to ' + _qv(ip.psvBand.hi, 'pressureG', 0, 'psig') + (ip.psvBand.ok === false ? ' ✗ empty' : '')
            : 'at least ' + _qv(ip.psvBand.lo, 'pressureG', 0, 'psig'));
        if (ip.dPdT_psiF != null) {
            h += _rrow('Blocked-in pressure rise', _isM() ? _nf(ip.dPdT_psiF * 6.894757293168 * 1.8, 0) + ' kPa per °C (' + _nf(ip.dPdT_psiF * 30 * 6.894757293168, 0) + ' kPa for a 16.7 °C rise)'
                : _nf(ip.dPdT_psiF, 0) + ' psi per °F (' + _nf(ip.dPdT_psiF * 30, 0) + ' psi for a 30 °F rise)');
        }
        return h;
    }
    function _fieldRows(ln) {
        var f = ln.field, h = '';
        if (!(ln.rate.gal_d > 0)) return '';
        h += _rrow('Drawdown cylinder: 30 s · 60 s', _nf(f.mL_30s, 0) + ' · ' + _nf(f.mL_60s, 0) + ' mL');
        h += _rrow('Time to draw 100 mL', f.s_per_100mL != null ? _nf(f.s_per_100mL, 1, 1) + ' s' : '—');
        h += _rrow('Calibration cylinder (1.25 × peak for 60 s)', f.cylinder_mL != null ? _nf(f.cylinder_mL, 0) + ' mL' : 'Over 4,000 mL: use an in-line meter', f.cylinder_mL == null);
        return h;
    }
    function _supplyRows(ln) {
        var t = ln.supply, g = ln.gas, h = '';
        if (t && ln.rate.gal_d > 0) {
            h += _rrow('Days per tank (' + _qv(t.usable_gal, 'volumeSmall', 1, 'gal', 0) + ' usable after a 10 % heel)', _nf(t.days, 2, 2) + ' d');
            h += _rrow('Chemical for the test (+20 % contingency)', _qv(t.inventory_gal, 'volumeSmall', 0, 'gal', 0));
            h += _rrow('Totes on site · tote changes (' + _qv(275, 'volumeSmall', 0, 'gal', 0) + ' totes)', t.totes + ' · ' + t.toteChanges);
        }
        if (g && g.applies && ln.rate.gal_d > 0) {
            if (ln.pump.kind === 'plunger' && g.scf_d != null) {
                h += _rrow('Drive gas: per stroke · per day', _isM() ? _nf(g.scf_stroke * 0.028316846592, 5) + ' Sm³ · ' + _nf(g.scf_d * 0.028316846592, 2) + ' Sm³/d'
                    : _nf(g.scf_stroke, 5) + ' scf · ' + _nf(g.scf_d, 0) + ' scf/d (' + _nf(g.scf_h, 1) + ' scf/h)');
            } else if (ln.pump.kind === 'airliquid') h += _rrow('Drive gas use', 'From the pump’s air-consumption curve (not computed)', true);
            if (g.regDefault_scf_h != null) h += _rrow('Regulatory default for a gas-driven pump', _isM() ? _nf(g.regDefault_scf_h * 0.028316846592, 3) + ' Sm³/h' : _nf(g.regDefault_scf_h, 1) + ' scf/h');
        }
        return h;
    }
    function _doseRows(ln) {
        var h = '', L = _lib(), B = L.bases[ln.basis];
        if (ln.kind === 'thi' && ln.hydrate) {
            if (ln.hydrate.XR > 0) h += _rrow('Rich inhibitor in the water', _nf(ln.hydrate.XR, 2, 2) + ' wt %');
        } else if (ln.scav) {
            var sc = ln.scav;
            h += _rrow('H2S removed', _qv(sc.removed_lb_d, 'massRateDay', 3, 'lb/d', 3));
            if (_fin(ln.dose)) h += _rrow('Product ratio', (_isM() ? _nf(ln.dose * L.bases.gal_lb_h2s.factor, 3) + ' L/kg' : _nf(ln.dose, 3) + ' US gal/lb') +
                (ln.ratio && ln.ratio.ok ? ' (η ' + _nf(ln.ratio.eff, 3) + ')' : ''));
        } else if (_fin(ln.dose)) {
            h += _rrow('Dose (product, as supplied)', _nf(ln.dose, 3) + ' ' + (B ? B.unit : '') + (ln.activePpm != null ? ' (' + _nf(ln.activePpm, 2) + ' ppm active)' : ''));
        }
        if (ln.rate.gal_MMscf != null && ln.rate.gal_d > 0) h += _rrow('Per gas volume', _qv(ln.rate.gal_MMscf, 'doseGasVol', 3, 'gal/MMscf', 1));
        return h;
    }
    function _lineBox(r, ln) {
        var h = '<div class="rbox" id="cj_rb_line_' + ln.n + '"><div class="rbox-title">' + _esc('Line ' + ln.n + ' — ' + _lineName(ln)) + '</div>';
        h += _subh('Rate');
        h += _rrow('Chemical rate', _rateTxt(ln.rate, ln.zeroText));
        if (ln.rate.gal_d > 0) h += _rrow('Peak / start-up rate (× ' + _nf(ln.peakF, 2, 1) + ')', _rq(ln.peak_gal_d));
        h += _doseRows(ln);
        h += _subh('Pump setting') + _pumpRows(ln, r);
        h += _optionsTable(ln);
        h += _subh('Discharge pressure') + _pressureRows(ln);
        var fr = _fieldRows(ln), sr = _supplyRows(ln);
        if (fr) h += _subh('Field check') + fr;
        if (sr) h += _subh('Supply') + sr;
        var c = _lib().find(ln.chem), ps = ln.pump, ip = ln.pressure;
        var echo = ['peak × ' + _nf(ln.peakF, 2, 1)];
        if (ps.kind === 'plunger') echo.push('ηv ' + _nf(ps.eta, 2, 2));
        if (ln.water > 0) echo.push('water ' + _nf(ln.water * 100, 0) + ' %');
        echo.push('allowance ' + _qv(ip.breakdown.allowance, 'pressure', 0, 'psi'));
        var mv = r.input.lines[ln.n - 1].mawp, mawpIn = mv !== '' && mv != null && _fin(Number(mv));
        echo.push(mawpIn ? 'MAWP ' + _qv(Number(mv), 'pressureG', 0, 'psig') : 'MAWP = pump rating');
        h += _rrow('Line settings', echo.join(' · '), true);
        if (c && c.cautions) h += _rrow('Chemical cautions', c.cautions, true);
        var seen = {};
        ln.verdicts.forEach(function (v) { if (!seen[v.text]) { seen[v.text] = 1; h += _vdiv(v); } });
        (ip.warnings || []).forEach(function (w) { if (!seen[w]) { seen[w] = 1; h += _vdiv({ level: 'warn', text: w }); } });
        return h + '</div>';
    }
    function _summaryBox(r) {
        var h = '<div class="rbox" id="cj_rb_summary"><div class="rbox-title">Summary</div>';
        h += _tbl(['Line', 'Point', 'Chemical', 'Rate (' + (_isM() ? 'L/h' : 'gal/d') + ')', 'Rate (mL/min)', 'Pump', 'Setting', 'Required (' + _ul('pressureG', 'psig') + ')', 'Rating (' + _ul('pressureG', 'psig') + ')', 'Verdict'],
            r.summary.rows.map(function (s) {
                var q = _isM() ? s.gal_d * GAL_L / 24 : s.gal_d;
                return [String(s.n), s.point, s.chem, _nf(q, q < 10 ? 3 : 2), _nf(s.mL_min, 1), _pumpLabel({ short: s.pump }), s.setting || s.zeroText || 'no flow',
                    _nf(_dv(s.pReq, 'pressureG'), 0), _nf(_dv(s.pRating, 'pressureG'), 0), SYM[s.level] || '⚠'];
            }));
        r.summary.inventory.forEach(function (e) {
            if (e.gal_d > 0) h += _rrow(e.name + ' for the test (' + _nf(r.basis.days, 1) + ' d + 20 %)', _qv(e.gal_test, 'volumeSmall', 0, 'gal', 0) + ' at ' + _rq(e.gal_d));
        });
        h += _rrow('Total chemical rate', _rq(r.summary.total_gal_d));
        r.summary.verdicts.forEach(function (v) { h += _vdiv(v); });
        return h + '</div>';
    }
    function _calBox(r, rd) {
        var c = r.calibration;
        if (rd.ctx.calUnused) {
            return '<div class="rbox" id="cj_rb_cal"><div class="rbox-title">Field calibration check</div>' +
                _vdiv({ level: 'warn', text: 'Calibration line ' + rd.ctx.calLine + ' is not in use: choose a line between 1 and ' + r.lines.length + '.' }) + '</div>';
        }
        if (rd.ctx.calIncomplete) {
            return '<div class="rbox" id="cj_rb_cal"><div class="rbox-title">Field calibration check, line ' + rd.ctx.calLine + '</div>' +
                _vdiv({ level: 'warn', text: 'Enter the measured volume, the time and the pump setting during the test (all above 0; a discharge pressure, when entered, 0 or more) to check line ' + rd.ctx.calLine + '.' }) + '</div>';
        }
        if (!c) return '';
        var ln = r.lines[c.line - 1], ps = ln.pump, h = '<div class="rbox" id="cj_rb_cal"><div class="rbox-title">Field calibration check, line ' + c.line + '</div>';
        var air = ps.kind === 'airliquid';
        var setTxt = function (v) {
            if (v == null || !_fin(v)) return 'not reachable';
            if (air) return 'air ' + _qv(v, 'pressureG', 1, 'psig', 0);
            if (ps.setting === 'spm') return _nf(v, 2, 2) + ' SPM';
            return _nf(v, 2, 2) + (ps.kind === 'plunger' && !ps.vfd ? ' % stroke' : ' % speed');
        };
        h += _rrow('Measured rate', _rq(c.gal_d) + ' (' + _nf(c.mL_min, 1, 1) + ' mL/min)');
        h += _rrow('Target rate', _rq(ln.rate.gal_d));
        if (c.withinPct != null) h += _rrow('Deviation from target', (c.withinPct > 0 ? '+' : '') + _nf(c.withinPct, 1, 1) + ' %');
        if (c.etaActual != null) h += _rrow('Measured volumetric efficiency', _nf(c.etaActual, 3, 3));
        if (air && c.pTest != null) h += _rrow('Discharge pressure during the test', _qv(c.pTest, 'pressureG', 0, 'psig') + (c.pTestEntered ? ' (entered)' : ' (flowing line pressure + allowance)'));
        if (c.q0Refit_gal_d != null) h += _rrow('Free flow re-fitted to the test', _rq(c.q0Refit_gal_d));
        h += _rrow('Corrected setting', setTxt(c.newSetting));
        if (c.withinPct != null) {
            var tol = 5;
            h += Math.abs(c.withinPct) > tol
                ? _vdiv({ level: 'warn', text: 'Calibration reads ' + (c.withinPct > 0 ? '+' : '') + _nf(c.withinPct, 1, 1) + ' % from target: reset to ' + setTxt(c.newSetting) + ' and re-test.' })
                : _vdiv({ level: 'ok', text: 'Calibration within 5 % of the target rate.' });
        } else h += _vdiv({ level: 'warn', text: 'The line has no flow to compare with: no corrected setting.' });
        return h + '</div>';
    }
    var NOTES = [
        'Methods. Hydrate temperature: gas-gravity correlation (Towler–Mokhatab 2005), sweet gas, about ±5 °F. Choke temperature: real-gas isenthalpic (DAK) for the gas only (liquids reduce the cooling), with J-T cooling × {fjt} for design. Depression: larger of Hammerschmidt and Nielsen–Bucklin (Hammerschmidt only for DEG/TEG). Water: free + condensed (Bukacek) + water in other aqueous chemicals. Methanol loss to gas: K-value correlation. Scavenger: stoichiometry ÷ utilisation. Pumps: displacement × volumetric efficiency. Downhole: tubing pressure + valve set + friction − hydrostatic.',
        'Sour service and samples. The sour-service materials basis and the radius of exposure use the untreated H2S; scavenging does not change them. Take PVT and H2S samples upstream of the scavenger, or with it off. Do not drive pneumatic or air-driven pumps with sour produced gas: use instrument air, nitrogen or sweet gas, or route the exhaust to flare.',
        'Injection hardware and overpressure. Every tie-in: block valve, two check valves in series and a bleed, rated to the flowhead or manifold class and leak-tested before opening the well; a tie-in upstream of the surface safety valve can bypass it. Rate the pump discharge for the shut-in or tie-in pressure, not the operating pressure. Fit a relief valve on every pump discharge and drive-gas regulator. Size the tank vent for gas blow-by or fit a low-discharge-pressure trip: the pump relief valve does not protect the tank.',
        'Methanol. Flash point 52 °F (11 °C), near-invisible flame, toxic by skin, inhalation and ingestion (exposure limit 200 ppm, skin). Bond and ground during transfer; flame arrestor on the vent; bund at 110 %; shade the tank and keep a flooded suction. Separator water carrying methanol is itself flammable: treat water tanks, pits and lines as hazardous. With high-salinity brine, methanol can precipitate salt and scale. Area classification per API RP 500/505.',
        'Plugs, mixing and shutdown. Treat a suspected hydrate plug as trapped pressure: depressurise both sides equally and never heat the middle of a plug. Never mix incompatible chemicals in one line or tank, and flush lines when changing chemical. Oxidisers (peroxide, nitrite) go only into a vented, non-hydrocarbon tank and are never blocked in. Fit thermal relief on blockable liquid-full sections, or lock them open. Decide the ESD philosophy for each chemical pump (trip, or keep running for shut-in hydrate protection) before the test.',
        'Data limits and sign-off. LDHI, scavenger utilisation, treating-chemical doses and pump presets depend on the formulation and the equipment; values here are screening ranges and illustrative envelopes, to be replaced by data-sheet and nameplate values. This page is not a substitute for the operator’s chemical programme, permit to work or a competent engineer’s review.'
    ];
    function _notesHtml(fJT) {
        var f = _fin(fJT) ? _nf(fJT, 2, 2) : '1.10';
        return '<div class="rbox" id="cj_rb_notes"><div class="rbox-title">Notes and assumptions</div>' +
            NOTES.map(function (t) { return '<div class="cj-note"><b>Notes</b> ' + _esc(t.replace('{fjt}', f)) + '</div>'; }).join('') + '</div>';
    }

    // ── Charts (drawLineChart in fixed 720 × 300 canvases, drawn once per calc) ──
    function _drawFn() {
        // eslint-disable-next-line no-undef
        if (typeof drawLineChart === 'function') return drawLineChart;
        return typeof G.drawLineChart === 'function' ? G.drawLineChart : null;
    }
    function _pts(list) { return list.filter(function (p) { return p && _fin(p.x) && _fin(p.y); }); }
    function _drawHyd(r) {
        var cv = _pgById('cj_chart_hyd'), draw = _drawFn();
        if (!cv || !draw) return;
        var S = r.spread, X = function (t) { return _dv(t, 'temperature'); }, Y = function (pg) { return _dv(pg, 'pressureG'); };
        var pMax = (Math.max(S.sithp, S.fwhp) + ATM) * 1.1;
        var curve = hydrateCurve(S.sg, S.thydShift, pMax, 40);
        var ds = [{ label: 'Hydrate curve (no inhibitor)', color: '#f85149', points: false, width: 2, data: _pts(curve.map(function (q) { return { x: X(q.t_F), y: Y(q.p_psia - ATM) }; })) }];
        ds.push({ label: 'Hydrate curve + ' + _qv(S.margin.used, 'tempDelta', 1, '°F') + ' margin', color: '#d29922', points: false, width: 1.5, dash: [6, 4],
            data: _pts(curve.map(function (q) { return { x: X(q.t_F + S.margin.used), y: Y(q.p_psia - ATM) }; })) });
        var thi = r.lines.filter(function (ln) { return ln.kind === 'thi' && ln.hydrate && ln.hydrate.ok && ln.hydrate.XR > 0 && ln.rate.gal_d > 0; })[0];
        if (thi) {
            var dep = depression(thi.chem, thi.hydrate.XR, r.basis.method === 'ham' ? 'ham' : r.basis.method === 'nb' ? 'nb' : 'auto');
            if (_fin(dep)) ds.push({ label: 'Inhibited (line ' + thi.n + ', ' + _nf(thi.hydrate.XR, 1) + ' wt %)', color: '#3fb950', points: false, width: 2, dash: [3, 3],
                data: _pts(curve.map(function (q) { return { x: X(q.t_F - dep), y: Y(q.p_psia - ATM) }; })) });
        }
        ds.push({ label: 'Flowing spread', color: '#58a6ff', points: true, width: 2, data: _pts(S.nodes.map(function (nd) { return { x: X(nd.t_F), y: Y(nd.p_psig) }; })) });
        ds.push({ label: 'Shut-in to start-up', color: '#a371f7', points: true, width: 1.5, dash: [4, 4], data: _pts([S.shutin, S.startup].map(function (nd) { return { x: X(nd.t_F), y: Y(nd.p_psig) }; })) });
        var at = { wh: S.nodes[0], dsch: S.nodes[1], sepin: S.nodes[2] }, inj = [];
        r.lines.forEach(function (ln) { var nd = at[ln.point]; if (nd) inj.push({ x: X(nd.t_F), y: Y(nd.p_psig) }); });
        if (inj.length) ds.push({ label: 'Injection points', color: '#f0883e', points: true, width: 0.001, data: _pts(inj) });
        try {
            draw(cv, ds, { xLabel: 'Temperature (' + _ul('temperature', '°F') + ')', yLabel: 'Pressure (' + _ul('pressureG', 'psig') + ')', yMin: 0, xDec: 0, yDec: 0 });
        } catch (e) { /* chart is cosmetic */ }
    }
    function _drawPump(r) {
        var cv = _pgById('cj_chart_pump'), draw = _drawFn(), tt = _pgById('cj_chart_pump_t');
        if (!cv) return;
        var want = parseInt(_sv('cj_chart_line'), 10) || 1, n = Math.min(Math.max(1, want), r.lines.length), ln = r.lines[n - 1], ps = ln.pump, P = _lib().pump(ps.pump);
        if (tt) tt.textContent = 'Pump rate vs setting, line ' + n + (want > r.lines.length ? ' (line ' + want + ' is not in use)' : '') + ': ' + _pumpLabel({ short: ps.name });
        if (!draw || !P) return;
        var Q = function (galD) { return _isM() ? galD * GAL_L / 24 : galD; };
        var ds = [], xMax = 100, xl = '', op = null, x85 = null, k, pts;
        var colors = ['#58a6ff', '#f0883e', '#8b949e'];
        if (ps.kind === 'plunger') {
            var list = (P.plungers || []).slice().sort(function (a, b) { return a - b; }), idx = -1;
            for (k = 0; k < list.length; k++) if (Math.abs(list[k] - ps.plunger_in) < 1e-9) idx = k;
            var pick = idx === -1 ? [ps.plunger_in] : list.slice(Math.max(0, idx - 1), Math.min(list.length, idx + 2));
            var spmX = ps.setting === 'spm' ? ps.spmMax : ps.spmCrank;
            xMax = ps.setting === 'spm' ? spmX : 100;
            pick.forEach(function (d) {
                var perSpm = ps.heads * Math.PI / 4 * d * d * ps.stroke_in * 1440 / IN3_GAL * (ps.eta || 0.9);
                pts = [];
                for (var i = 0; i <= 20; i++) { var x = xMax * i / 20; pts.push({ x: x, y: Q(ps.setting === 'spm' ? perSpm * x : perSpm * spmX * x / 100) }); }
                var cur = Math.abs(d - ps.plunger_in) < 1e-9;
                ds.push({ label: _frac(d) + ' in plunger' + (cur ? ' (selected)' : ''), color: cur ? '#f0883e' : (d < ps.plunger_in ? '#58a6ff' : '#8b949e'), points: false, width: cur ? 2.5 : 1.5, data: _pts(pts) });
            });
            xl = ps.setting === 'spm' ? 'Pump speed (SPM)' : 'Setting (% of pump maximum)';
            if (!ps.noFlow) op = { x: ps.setting === 'spm' ? ps.spm : ps.pct, y: Q(ps.rate_gal_d) };
            x85 = r.basis.bandA / 100 * xMax;
        } else if (ps.kind === 'meter' || ps.kind === 'transfer') {
            var qm = ps.kind === 'meter' ? ps.qMax_gal_d : ps.q0_gal_d;
            ds.push({ label: ps.kind === 'meter' ? 'Rate at stroke × speed' : 'Rate', color: colors[0], points: false, width: 2, data: _pts([{ x: 0, y: 0 }, { x: 100, y: Q(qm) }]) });
            xl = ps.kind === 'meter' ? 'Setting: % stroke × % speed / 100' : 'Share of the free flow (%)';
            if (!ps.noFlow) op = { x: ps.pct, y: Q(ps.rate_gal_d) };
            x85 = r.basis.bandA;
        } else if (ps.kind === 'airliquid') {
            var psup = r.basis.psup, pmin = ps.pReq / (ps.ratio || 1);
            xMax = _dv(psup, 'pressureG');
            pts = [];
            for (k = 0; k <= 30; k++) {
                var pa = pmin + (psup - pmin) * k / 30;
                if (pa > 0) pts.push({ x: _dv(pa, 'pressureG'), y: Q(Math.max(0, ps.q0_gal_d * (1 - ps.pReq / ((ps.ratio || 1) * pa)))) });
            }
            ds.push({ label: 'Flow at ' + _qv(ps.pReq, 'pressureG', 0, 'psig'), color: colors[0], points: false, width: 2, data: _pts(pts) });
            xl = 'Air pressure setting (' + _ul('pressureG', 'psig') + ')';
            if (!ps.noFlow && ps.airDesign != null) op = { x: _dv(ps.airDesign, 'pressureG'), y: Q(ps.rate_gal_d) };
            x85 = _dv(r.basis.bandA / 100 * psup, 'pressureG');
        }
        if (!ds.length) return;
        var x0 = 0;
        if (ps.rate_gal_d > 0) {
            ds.push({ label: 'Design rate', color: '#3fb950', points: false, width: 1.5, dash: [6, 4], data: _pts([{ x: x0, y: Q(ps.rate_gal_d) }, { x: xMax, y: Q(ps.rate_gal_d) }]) });
            ds.push({ label: 'Peak rate', color: '#d29922', points: false, width: 1.5, dash: [3, 3], data: _pts([{ x: x0, y: Q(ps.peak_gal_d) }, { x: xMax, y: Q(ps.peak_gal_d) }]) });
        }
        var yTop = 0;
        ds.forEach(function (d) { d.data.forEach(function (p) { if (p.y > yTop) yTop = p.y; }); });
        if (_fin(x85) && yTop > 0) ds.push({ label: _nf(r.basis.bandA, 0) + ' % limit', color: '#f85149', points: false, width: 1, dash: [2, 3], data: _pts([{ x: x85, y: 0 }, { x: x85, y: yTop }]) });
        if (op && _fin(op.x) && _fin(op.y)) ds.push({ label: 'Operating point', color: '#e6edf3', points: true, width: 0.001, data: [op] });
        try {
            draw(cv, ds, { xLabel: xl, yLabel: 'Rate (' + (_isM() ? 'L/h' : 'gal/d') + ')', xMin: 0, yMin: 0, xDec: 0, yDec: _isM() ? 1 : 0 });
        } catch (e) { /* chart is cosmetic */ }
    }

    // ── Paint ────────────────────────────────────────────────────────
    function _clearChips() { for (var n = 1; n <= NLINES; n++) { var c = _pgById('cj_chip_' + n); if (c) c.textContent = ''; } }
    function _labelOf(id) {
        var w = _wrapOf(id), l = w ? w.querySelector('label') : null;
        return l ? String(l.textContent).replace(/\s+/g, ' ').trim() : '';
    }
    function _bare(lab) { return lab.replace(/\s*\((?:[^()]|\([^()]*\))*\)\s*$/, ''); }
    function _rangeFor(id) {
        var m = /^cj_([a-z0-9]+)_(\d)$/.exec(id), sec, k;
        if (m && RANGES.line) {
            for (k in IDS.line) if (IDS.line[k] === 'cj_' + m[1] + '_' && RANGES.line[k]) return { r: RANGES.line[k], cat: LN_UNITS[k], line: m[2] };
        }
        for (sec in IDS) {
            if (sec === 'line' || sec === 'cal' || !RANGES[sec]) continue;
            for (k in IDS[sec]) if (IDS[sec][k] === id && RANGES[sec][k]) return { r: RANGES[sec][k], cat: PG_UNITS[id], line: null };
        }
        return null;
    }
    function _errMsg(msg, id) {
        var rg = id ? _rangeFor(id) : null, raw = id ? _labelOf(id) : '';
        // unit-tagged labels lose their "(unit)" (the bounds carry it); ", blank = …" hints go
        var lab = String(rg && rg.cat ? _bare(raw) : raw).replace(/, blank = [^()]*(?=\s*\(|$)/, '').trim();
        if (id && lab && rg && /must be between/.test(msg)) {
            var cat = rg.cat, imp = cat && _hasCat(cat) ? G.WTS_units.CATEGORIES[cat].imperial.label : '';
            var lo = _dv(rg.r[0], cat), hi = _dv(rg.r[1], cat);
            var dp = function (v) { return Math.abs(v) < 10 && v % 1 ? 2 : 0; };
            return (rg.line ? 'Line ' + rg.line + ': ' : '') + lab + ' must be between ' + _nf(lo, dp(lo)) + ' and ' + _qv(rg.r[1], cat, dp(rg.r[1]), imp, dp(hi)) + '.';
        }
        if (id && lab && /^Enter a value for /.test(msg)) return 'Enter a value for ' + _low1(_bare(lab)) + '.';
        return msg;
    }
    function _paintError(r) {
        var res = _pgById('cj_res');
        _clearChips();
        _show(_pgById('cj_charts'), false);
        var items = '', bad = r.bad || [], errs = r.errors || [];
        errs.forEach(function (m, k) {
            var id = null, mm = /^(?:Line (\d): )?([a-z0-9_]+) must be between/.exec(m) || /^Enter a value for ([a-z0-9_]+)\./.exec(m);
            if (mm) id = mm.length === 3 ? ('cj_' + mm[2] + (mm[1] ? '_' + mm[1] : '')) : 'cj_' + mm[1];
            if (id && !_pgById(id)) id = bad[k] || null;
            items += '<li>' + _esc(_errMsg(m, id)) + '</li>';
        });
        bad.forEach(function (id) { var e = _pgById(id); if (e && e.classList) e.classList.add('input-err'); });
        if (res) {
            res.innerHTML = '<div class="val-error"><strong>Please fix the following:</strong><ul>' + (items || '<li>Check the inputs.</li>') + '</ul></div>';
            res.setAttribute('data-done', '1');
        }
        var nb = _pgById('cj_notes_res');
        if (nb) nb.innerHTML = _notesHtml(NaN);
    }
    function _paint(r, rd) {
        var res = _pgById('cj_res');
        if (!res) return;
        var h = _headline(r);
        r.verdicts.forEach(function (v) { h += _vdiv(v); });
        h += _basisBox(r) + _spreadBox(r);
        r.lines.forEach(function (ln) { h += _lineBox(r, ln); });
        h += _summaryBox(r) + _calBox(r, rd);
        res.innerHTML = h;
        res.setAttribute('data-done', '1');
        for (var n = 1; n <= NLINES; n++) {
            var c = _pgById('cj_chip_' + n), ln = r.lines[n - 1];
            if (c) c.textContent = ln ? ln.chip : '';
        }
        _show(_pgById('cj_charts'), true);
        _drawHyd(r);
        _drawPump(r);
        var nb = _pgById('cj_notes_res');
        if (nb) nb.innerHTML = _notesHtml(r.basis.fJT);
    }
    function _publish(r) {
        G.WTS_state = G.WTS_state || {};
        if (!r.ok) { G.WTS_state.cheminj = { ok: false, errors: (r.errors || []).slice(), ts: Date.now() }; return; }
        var t = r.lines.filter(function (ln) { return ln.kind === 'thi' && ln.hydrate && ln.hydrate.ok; })[0];
        G.WTS_state.cheminj = {
            ok: true, ts: Date.now(),
            lines: r.lines.map(function (ln) {
                return { n: ln.n, point: ln.point, chem: ln.chem, gal_d: ln.rate.gal_d, L_hr: ln.rate.L_hr, mL_min: ln.rate.mL_min, pump: ln.pump.pump,
                    setting: ln.setting, spm: ln.pump.spm != null ? ln.pump.spm : null, pReq_psig: ln.pressure.pReq, pRating_psig: ln.pressure.pRating, verdict: ln.level,
                    noRate: !!ln.noRate, zero: ln.zero || null };
            }),
            total_gal_d: r.summary.total_gal_d,
            hydrate: { controlNode: t && t.hydrate.control ? t.hydrate.control.key : null, dT: t ? t.hydrate.dT : null, XR: t ? t.hydrate.XR : null,
                inh_gal_d: t ? t.rate.gal_d : null, fJT: r.basis.fJT },
            h2s: null, result: r
        };
    }
    function _calcImpl() {
        var root = _pgById('cj_root');
        if (!root || !_lib()) return null;
        _calcCount++;
        _each(root.querySelectorAll('.input-err'), function (el) { el.classList.remove('input-err'); });
        var rd = _readInput();
        var r = G.WTS_cheminj_compute(rd.inp, { fmt: _isM() ? _metricFmt() : null });
        if (!r.ok) _paintError(r); else _paint(r, rd);
        _publish(r);
        return r;
    }
    G.calcChemInj = function () { return _canon(_calcImpl); };

    function renderChemInj(body) {
        if (!body) return;
        var t = _pgById('pgTitle'), s = _pgById('pgSub');
        if (t) t.textContent = PG_TITLE;
        if (s) s.textContent = PG_SUB;
        if (!_lib()) {
            body.innerHTML = '<div class="card"><div class="card-title">Chemical Injection</div><div class="val-error">The chemical library is not loaded.</div></div>';
            return;
        }
        body.innerHTML = _markup();
        var U = G.WTS_units, k, n;
        if (U && typeof U.tagInput === 'function') {
            for (k in PG_UNITS) U.tagInput(k, PG_UNITS[k]);
            for (n = 1; n <= NLINES; n++) for (k in LN_UNITS) U.tagInput('cj_' + k + '_' + n, LN_UNITS[k]);
        }
        var root = _pgById('cj_root');
        if (root && root.addEventListener) root.addEventListener('change', _onChange);
        _syncUi();
        // With autosave on, the host restores the saved values silently right after this
        // render and then calls hooks.after, which runs the one calc; otherwise calc now.
        var AS = G.WTS_pageAutosave;
        var hostRestores = !!(AS && typeof AS.page === 'function' && AS.page() === PG_KEY && typeof AS.enabled === 'function' && AS.enabled(PG_KEY) && body.id === 'pgBody');
        if (!hostRestores) G.calcChemInj();
    }
    G.renderChemInj = renderChemInj;
    G.WTS_cheminj.ranges = RANGES;
    G.WTS_cheminj.pageCalcs = function () { return _calcCount; };

    // ── Registry (merge, never replace) ──────────────────────────────
    G.WTS_calcRegistry = G.WTS_calcRegistry || {};
    G.WTS_calcRegistry.cheminj = {
        key: PG_KEY,
        title: PG_TITLE,
        sub: PG_SUB,
        group: 'Test System Safety',
        icon: '&#128167;',
        desc: 'Plan where to inject, how much, and the pump stroke, speed or air setting for every chemical on the spread.',
        hooks: { silent: true, after: function () { _syncUi(); G.calcChemInj(); } },
        render: function (body) { return G.renderChemInj(body); }
    };

    // Unit flip / base-conditions change: recalculate a page that has shown results.
    if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
        ['wts:unit-system-changed', 'wts:base-conditions-changed'].forEach(function (ev) {
            document.addEventListener(ev, function () {
                var res = _pgById('cj_res');
                if (res && res.getAttribute && res.getAttribute('data-done') === '1') { _applyVisibility(); G.calcChemInj(); }
            });
        });
    }
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var E = G.WTS_cheminj, fails = [];
    if (!E) return;
    function near(a, b, tol, what) { if (!(Math.abs(a - b) <= tol)) fails.push(what + ': ' + a + ' vs ' + b); }
    near(E.pvWater(60), 0.2564, 0.0005, 'p_v 60 °F');
    near(E.pvWater(212), 14.71, 0.01, 'p_v 212 °F');
    near(E.waterContent(1000, 100).W_lbMMscf, 60.40, 0.05, 'Bukacek 1000 psia / 100 °F');
    near(E.methanolLoss(1000, 10, 25, 379.48).lbPerMMscf, 12.81, 0.13, 'methanol K-value loss');
    if (G.WTS_chemlib) near(E.requiredWt('meoh', 38.57, 'auto').W, 38.14, 0.05, 'NB methanol at 38.57 °F');
    if (fails.length && typeof console !== 'undefined') console.error('[cheminj self-test] FAILED:\n  ' + fails.join('\n  '));
})();
