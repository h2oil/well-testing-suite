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
//   This step publishes the engine only. The page (renderChemInj /
//   calcChemInj and the window.WTS_calcRegistry.cheminj entry, group
//   "Test System Safety") is added in the next step; nothing here touches
//   the DOM, starts a timer or wraps a function.
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
//   spread(i) → {ok, nodes[], shutin, startup, margin, jt, title, verdicts, warnings}
//   hydrateDose(i) → {ok, control, dT, XR, XR_ham, XR_nb, x, water, inh, freezeF, shutin, startup, verdicts}
//   doseRate(i) → {ok, gal_d, L_d, L_hr, gal_h, mL_min, bbl_d, gal_MMscf, activePpm, phase}
//   scavRatio(i), scavengerDose(i)   gas-phase H2S scavenger line rate (stoichiometry ÷ utilisation)
//   pumpSetting(i) → plunger {spm…} | meter {f, S, N…} | air-driven {airDesign, cyclesMin…}
//   pumpOptions(i) → {ranked[≤3], current, nextPlunger, reason, byPump}
//   injectionPressure(i) → {ok, pLine, pBack, pReq, pRating, psvBand, dPdT_psiF, verdicts}
//   supplyGas(i) → {applies, ps_set, stalls, scf_stroke, scf_d, scf_h, regDefault_scf_h, exhaust…, verdicts}
//   calibration(i), fieldCheck(rate_gal_d, peakF), tank(i), compat(lines)
//   defaults() → the page-default input (worked example H1); fromIds(map) → input from cj_* ids
//   stats() → {isenthalpicSolves, memoHits}
//   WTS_cheminj_compute(input, opts?) → {ok, spread, hydrate, lines[], summary, compat, calibration,
//                                        basis, verdicts, warnings} | {ok:false, errors[], bad[cj ids]}
//   Every function returns {ok:false, errors[], bad[]} on bad input; verdicts are
//   {level:'ok'|'warn'|'bad', code, text} with plain text under 299 characters.
//   opts.fmt may override the text formatters (pG, dp, t, dt, galD, lbD, gal, scf…)
//   so the page can show Metric values in verdict text.
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
        inch: function (v) { return _frac(v) + ' in'; }
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
        if (t < 60) warnings.push('Water content below 60 °F is extrapolated beyond the Bukacek correlation range (60–460 °F).');
        if (t > 460 || p < 15 || p > 10000) warnings.push('Water content is outside the Bukacek correlation range (60–460 °F, 15–10,000 psia).');
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
                w.push('Real-gas J-T expansion not available here (' + ((r && r.errors && r.errors[0]) || 'Gas PVT engine missing') + '): 7 °F/100 psi rule used.');
            } else w.push('Gas PVT engine not loaded: 7 °F/100 psi rule used.');
        }
        return { t: t1 - RULE_FPSI * Math.max(0, p1g - p2g), tDak: null, method: 'rule', warnings: w };
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
            if (y > 3) { refused = true; refusedText = 'H2S ' + _grp(y, 2) + ' mol % is beyond the sweet-gas correlation: enter a lab or composition-based hydrate temperature. No rate given.'; }
            else if (y > 0.1) adder += Math.max(v.sour, v.sour * y);
            if (v.co2 > 20) { refused = true; refusedText = refusedText || ('CO2 ' + _grp(v.co2, 1) + ' mol % is beyond the sweet-gas correlation: enter a lab or composition-based hydrate temperature. No rate given.'); }
            else if (v.co2 > 5) adder += v.sour;
        }
        var mUsed = v.margin + adder;
        if (refused) verdicts.push(_V('bad', 'sour_refused', refusedText));
        else if (adder > 0) verdicts.push(_V('warn', 'sour_adder', 'Sweet-gas hydrate correlation used on sour gas: margin raised by ' + F.dt(adder) + ' (margin now ' + F.dt(mUsed) + '). Enter a lab or composition-based hydrate temperature.'));
        if (v.margin < 5) verdicts.push(_V('warn', 'margin_low', 'Hydrate margin ' + F.dt(v.margin) + ' is below 5 °F.'));
        else if (src === 'tm' && v.margin < 10) verdicts.push(_V('warn', 'margin_corr', 'Hydrate margin ' + F.dt(v.margin) + ' is below 10 °F while the hydrate temperature comes from the gas-gravity correlation (about ±5 °F).'));
        var jtMethod = v.jt === 'rule' ? 'rule' : v.jt === 'user' ? 'user' : 'ise';
        if (jtMethod === 'ise' && v.fJT < 1.10) verdicts.push(_V('warn', 'fjt_low', 'J-T factor ' + _grp(v.fJT, 2) + ' is below 1.10: DAK alone under-predicts J-T cooling by up to 9 %.'));
        if (jtMethod === 'rule') verdicts.push(_V('warn', 'jt_rule', 'Choke outlet uses 7 °F/100 psi: a quick check that can overstate or understate cooling.'));
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
        var allOk = nodes.every(function (n) { return n.status === 'ok'; });
        if (allOk) verdicts.push(_V('ok', 'no_risk', 'No hydrate risk at the spread nodes with a ' + F.dt(mUsed) + ' margin.'));
        var jtTxt = jtMethod === 'ise' ? 'J-T × ' + _grp(v.fJT, 2) : jtMethod === 'rule' ? 'J-T 7 °F/100 psi' : 'choke temperature entered';
        return {
            ok: true, sg: v.sg, gas: gas, qg: v.qg, h2s_ppm: v.h2s, h2s_molPct: y,
            sithp: v.sithp, fwhp: v.fwhp, fwht: v.fwht, tamb: v.tamb, pck: v.pck, psep: v.psep, tsep: tsep, heater: heater,
            margin: { base: v.margin, adder: adder, used: mUsed, refused: refused, refusedText: refusedText },
            thydSrc: src, thydShift: shift,
            jt: { method: jtMethod, fJT: v.fJT, choke: ck, startup: suJ },
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
            var ws = waterContent(sp.psep + ATM, sp.tsep);
            Wsep = ws.ok ? ws.W_lbMMscf : 0;
            cond = Math.max(0, q.qg) * Math.max(0, Wsep - Wout);
        } else cond = Math.max(0, q.qg) * Math.max(0, Win - Wout);
        var oth = 0, oList = [];
        (other || []).forEach(function (o) {
            if (o && _fin(o.lb_d) && o.lb_d > 0 && _ptOrder(o.point) <= LOC_ORDER[ctrl.loc]) { oth += o.lb_d; oList.push(o); }
        });
        var warns = [];
        if (q.cond !== 'all' && ctrl.t_F < 60 && q.qg > 0) warns.push('Condensed water at ' + F.t(ctrl.t_F) + ' is extrapolated below the 60 °F limit of the Bukacek correlation.');
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
            water: null, inh: null, freezeF: null, required: false, noRate: false, leanPct: leanPct,
            shutin: null, startup: null, verdicts: verdicts, warnings: warnings
        };
        // Shut-in and start-up requirements (any THI line; information + verdicts)
        function caseReq(node, label) {
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
            res.noRate = true;
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
            warnings.push('Rich concentration entered by the user (' + _grp(override, 2) + ' wt %), not the design value.');
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
            if (!ml.inRange) warnings.push('Methanol vapour-loss correlation used outside its range (−10 to 100 °F, 100–5,000 psia, up to 70 wt %).');
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
            if (res.freezeF > tMin - 5) verdicts.push(_V('warn', 'freeze', 'Rich-phase freeze point ' + F.t(res.freezeF) + ' is within 5 °F of the coldest node (' + F.t(tMin) + ').'));
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
        switch (b) {
            case 'ppmv_oil': g = 42 * qo * C * 1e-6; break;
            case 'ppmv_water': g = 42 * qw * C * 1e-6; break;
            case 'ppmv_liq': g = 42 * (qo + qw) * C * 1e-6; break;
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
        if (out.removed_lb_d > 200) verdicts.push(_V('warn', 'high_load', 'High H2S load (above 200 lb/d): consider a contactor vessel or an alternative treatment; liquid direct injection is commonly economic only below about 100–200 lb/d.'));
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
            ratio: _opt(i.ratio, P.ratio),
            vcyc: _opt(i.vcyc_in3, P.vcyc_in3),
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
        var verdicts = [], warnings = [], why = [];
        var o = {
            ok: true, pump: P.key, name: P.short, kind: P.kind, setting: P.setting, electric: !!P.electric, vents: !!P.vents,
            rate_gal_d: rate, peak_gal_d: rate * peakF, peakF: peakF, noFlow: !(rate > 0), pReq: pReq, pRating: pRating,
            pct: 0, peakPct: 0, band: 'green', feasible: true, why: why, whyText: '', pMax: null, pOk: true, verdicts: verdicts, warnings: warnings
        };
        var hazTxt = 'Electric pump in a classified area: motor and controls must be certified for the zone (API RP 500/505).';
        if (P.electric && i.haz === 'yes' && !i._lite) verdicts.push(_V('warn', 'haz_electric', hazTxt));
        if (P.kind === 'hand') {
            o.feasible = false; why.push('batch'); o.whyText = 'batch only';
            verdicts.push(_V('warn', 'hand', 'Hand pump: batch filling only, not continuous dosing.'));
            o.pMax = P.pmax || 0; return o;
        }
        o.pMax = _pmaxOf(P, c, psup);
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
            function air(q) { return (q < q0) ? pReq / (r * (1 - q / q0)) : null; }
            o.airDesign = air(rate); o.airPeak = air(rate * peakF);
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
            if (!o.noFlow && !i._lite) verdicts.push(_V('warn', 'transfer', 'Air-operated diaphragm pump: a coarse transfer pump, not a metering pump.'));
        }
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
                case 'pressure': return 'pressure (maximum ' + _grp(o.pMax, 0) + ' psig)';
                case 'drivegas': return 'drive gas ' + _grp(o.psSet, 1) + ' psig needed';
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
        if (!o.pOk && o.kind !== 'airliquid') {
            var pl = (o.kind === 'plunger') ? ' with a ' + F.inch(o.plunger_in) + ' plunger' : '';
            var dmax = '';
            if (o.kind === 'plunger' && o.setting === 'spm') {
                var P = _pumpRec(i.pump), c = _cfg(i);
                var dm = Math.sqrt(4 / Math.PI * (P.etaM || 0.8) * _opt(i.psup, 100) * _area(c.actD) / (c.heads * o.pRating));
                var fits = (P.plungers || []).filter(function (d) { return d <= dm + 1e-9; });
                if (fits.length) dmax = ' (' + F.inch(fits[fits.length - 1]) + ' or less)';
            }
            V.push(_V('bad', 'pressure', 'Pump cannot reach ' + F.pG(o.pRating) + pl + ' (maximum ' + F.pG(o.pMax) + '). Use a smaller plunger' + dmax + ', a larger actuator, an air-driven pump or an electric plunger metering pump.'));
        } else if (!o.pOk) {
            V.push(_V('bad', 'pressure', 'Pump cannot reach ' + F.pG(o.pRating) + ' (maximum ' + F.pG(o.pMax) + '). Raise the drive air, or use a higher-ratio air-driven pump or an electric plunger metering pump.'));
        }
    }
    // Next plunger for a pneumatic plunger pump: design > 85 % → the smallest larger plunger at ≤ 85 %
    // whose P_max passes; minimum below the stable SPM → the largest smaller plunger that runs stable.
    function nextPlunger(i, o) {
        var P = _pumpRec(i.pump);
        if (!P || P.kind !== 'plunger' || P.setting !== 'spm' || !o || o.noFlow) return null;
        var B = _bands(i), list = (P.plungers || []).slice().sort(function (a, b) { return a - b; });
        var up = o.pct > B.a || o.peakPct > B.a, down = !up && o.spmMin < o.spmMinStable, byPeak = up && o.pct <= B.a;
        if (!up && !down) return null;
        var cand = up ? list.filter(function (d) { return d > o.plunger_in + 1e-9; }) : list.filter(function (d) { return d < o.plunger_in - 1e-9; }).reverse();
        for (var k = 0; k < cand.length; k++) {
            var j = {}, key;
            for (key in i) if (_has(i, key)) j[key] = i[key];
            j.plunger_in = cand[k];
            var r = _plungerQuick(j);
            if (!r.pOk) continue;
            if (up && (byPeak ? r.pct * _opt(i.peakF, 1.25) : r.pct) <= B.a) return { plunger_in: cand[k], spm: r.spm, pct: r.pct, pMax: r.pMax };
            if (down && r.spmMin >= r.spmMinStable) return { plunger_in: cand[k], spm: r.spm, pct: r.pct, pMax: r.pMax };
        }
        return null;
    }
    function _plungerQuick(i) {
        var c = _cfg(i), P = c.P, psup = _opt(i.psup, 100), pReq = _opt(i.pReq, 0), pRating = _opt(i.pRating, pReq);
        var eta = _blank(i.eta) ? _etaAuto(i.beta, pReq, P.strokeMax || c.stroke, c.stroke) : _opt(i.eta, P.etaDef || 0.9);
        var spm = Math.max(0, _num(i.rate_gal_d, 0)) / (c.heads * _area(c.plunger) * c.stroke * 1440 / IN3_GAL * eta);
        var pMax = _pmaxOf(P, c, psup);
        return { spm: spm, pct: 100 * spm / c.spmMax, spmMin: spm * _opt(i.minF, 0.5), spmMinStable: P.spmMin || 3, pMax: pMax, pOk: pMax >= pRating - 1e-9 };
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
            var rateLim = cands.some(function (c) { return c.why.indexOf('pressure') === -1 && c.why.indexOf('drivegas') === -1; });
            var presLim = cands.some(function (c) { return c.why.indexOf('rate') === -1 && c.why.indexOf('peak') === -1 && c.why.indexOf('turndown') === -1; });
            var parts = [];
            if (rateLim) parts.push('rate-limited: two pumps in parallel, an air-driven liquid pump, an electric plunger pump or a skid');
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
            case 'bpv': pLine = _fin(pbpv) ? pbpv : 0; if (!_fin(pbpv)) warnings.push('Flare-line pressure not entered: 0 psig assumed.'); break;
            default: pLine = 0;
        }
        var cls = i.rateBasis === 'class';
        var bk = cls ? pt.pBackClass : pt.pBack;
        pBack = bk === 'sithp' ? sithp : bk === 'whclass' ? whc : bk === 'psvsep' ? psv : 0;
        var pReq = pLine + dpq;
        var pRating = Math.max(pReq * (1 + mp / 100), pReq + ma, pBack * (1 + mp / 100), pBack + ma);
        var mawpIn = _opt(i.mawp, NaN), pumpP = _opt(i.pumpPmax, NaN);
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
        if (pt.key === 'tank') verdicts.push(_V('warn', 'anti_siphon', 'Atmospheric tank: fit an anti-siphon / back-pressure valve set at least 25 psi above the suction head.'));
        else advice.push(_V('warn', 'backflow', BACKFLOW));
        if (dPdT != null) advice.push(_thermalV(chem.short, dPdT));
        return {
            ok: true, point: pt.key, pLine: pLine, pBack: pBack, pBackBasis: bk, rateBasis: cls ? 'class' : 'credible',
            breakdown: { line: pLine, allowance: dpq, friction: 0, hydrostatic: 0, civ: 0 },
            pReq: pReq, pReqFlow: pReq, pReqShutin: pReq, pRating: pRating, mawp: mawp, psvBand: band,
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
                var ex = 'Exhaust carries ' + _grp(y, 0) + ' ppm H2S' + (out.exhaustH2S_lb_d != null ? ' (' + _grp(out.exhaustH2S_lb_d, 4) + ' lb/d)' : '') + '.';
                if (y >= 10) verdicts.push(_V('bad', 'sour_drive', 'Do not drive pneumatic pumps with sour produced gas: use instrument air, nitrogen or sweet gas, or route the exhaust to flare. ' + ex));
                else verdicts.push(_V('warn', 'well_drive', 'Produced gas drives the pump and vents methane at the pump. ' + ex));
            } else verdicts.push(_V('warn', 'sweet_drive', 'Sweet fuel gas drives the pump and vents methane at the pump (regulatory default 13.3 scf/h per pump).'));
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
        var q = 22.8245 * mL / s, out = { ok: true, gal_d: q, mL_min: 60 * mL / s, etaActual: null, newSetting: null, withinPct: null, q0Refit_gal_d: null, verdicts: [] };
        if (kind === 'spm') {
            var Vs = Number(i.Vs_mL), nh = _opt(i.heads, 1);
            if (Vs > 0) out.etaActual = out.mL_min / (nh * Vs * set);
        }
        if (tgt > 0) {
            out.withinPct = 100 * (q - tgt) / tgt;
            if (kind === 'air') {
                var pd = Number(i.pReq), r = Number(i.ratio);
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
            cal: { line: 1, mL: '', s: '', setting: '' }
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
        cal: { line: 'cj_cal_line', mL: 'cj_cal_ml', s: 'cj_cal_s', setting: 'cj_cal_set' }
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
        }
        return errors.length ? { errors: errors, bad: bad } : null;
    }
    function _merge(def, inp) {
        var out = {}, k;
        for (k in def) out[k] = def[k];
        if (inp && typeof inp === 'object') for (k in inp) if (_has(inp, k) && inp[k] !== undefined) out[k] = inp[k];
        return out;
    }

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
            qg: st.qg, sg: st.sg, h2s: st.h2s, co2: st.co2, n2: st.n2,
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
                        if (ratio.effClamped) r.verdicts.push(_V('warn', 'eff_clamped', 'Utilisation raised to ' + _grp(ratio.eff, 3) + ' so that the ratio stays within 10 gal/lb.'));
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
                        basis: u.basis, dose: d0, activePct: u.active, qo: st.qo, qw: st.qw, qg: st.qg, api: st.api, sgw: st.sgw, sgc: u.sgc,
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
                psup: b.psup, peakF: u.peak, minF: b.minf, pRating: ip0.pRating, pReq: ip0.pReq, bandG: b.bandG, bandA: b.bandA, haz: sp.haz
            };
            var ps = pumpSetting(pumpIn);
            ipIn.pumpPmax = ps.pMax;
            var ip = injectionPressure(ipIn);
            var opt = opts.noOptions ? null : pumpOptions(_merge(pumpIn, { current: { pump: P.key } }));
            var gasKind = P.kind === 'plunger' && P.setting === 'spm' ? 'pneumatic' : P.kind === 'airliquid' ? 'airliquid' : P.kind === 'transfer' ? 'transfer' : null;
            var sg2 = supplyGas({
                kind: gasKind, actD_in: ps.actD_in, stroke_in: ps.stroke_in, heads: ps.heads, plunger_in: ps.plunger_in, spm: ps.spm,
                pdDesign_psig: ip.pReq, airPeak_psig: ps.airPeak, psup: b.psup, etaM: P.etaM, pSpring: P.pSpring, gasType: sp.supgas, h2s_ppm: st.h2s, vm: vm
            });
            if (gal > 0) {
                ps.verdicts.forEach(function (x) { lv.push(x); });
                if (gasKind) sg2.verdicts.forEach(function (x) { lv.push(x); });
            } else if (P.electric && sp.haz === 'yes') lv.push(_V('warn', 'haz_electric', 'Electric pump in a classified area: motor and controls must be certified for the zone (API RP 500/505).'));
            ip.verdicts.forEach(function (x) { lv.push(x); });
            var fc = fieldCheck(gal, u.peak);
            var tk = (l.tank === undefined || _blank(l.tank)) ? null : tank({ V_gal: Number(l.tank), rate_gal_d: gal, days: b.days });
            if (tk) tk.verdicts.forEach(function (x) { lv.push(x); });
            var setTxt = _settingText(ps);
            var chip = c.short + ' · ' + pt.short + ' · ' + (gal > 0 ? F.galD(gal) : 'no flow') + (setTxt ? ' · ' + setTxt : '');
            lines.push({
                n: u.n, point: pt.key, pointLabel: pt.label, pointShort: pt.short, chem: c.key, chemName: c.name, chemShort: c.short, kind: c.kind,
                basis: u.basis, dose: r.doseUsed, sgc: u.sgc, water: u.water, peakF: u.peak, suit: si,
                rate: rates, peak_gal_d: gal * u.peak, achieved: r.achieved || null, activePpm: r.activePpm != null ? r.activePpm : null,
                hydrate: r.hydrate || null, scav: r.scav || null, ratio: r.ratio || null, doseCalc: r.dose || null,
                pump: ps, options: opt, pressure: ip, gas: sg2, field: fc, supply: tk, dPdT_psiF: c.dPdT,
                setting: setTxt, chip: chip, verdicts: lv, level: _worst(lv)
            });
        });
        // Aqueous chemicals upstream of an unprotected hydrate-risk node (§3.2 rule 8)
        lines.forEach(function (ln) {
            var u = setups[ln.n - 1];
            if (!(u.water > 0) || u.c.kind === 'thi' || u.c.kind === 'ldhi' || !(ln.rate.gal_d > 0)) return;
            var o = _ptOrder(ln.point);
            var risk = S.nodes.filter(function (nd) { return nd.dTreq > 0 && LOC_ORDER[nd.loc] >= o; });
            risk.forEach(function (nd) {
                var prot = lines.some(function (t) { return t.kind === 'thi' && t.hydrate && t.rate.gal_d > 0 && _ptOrder(t.point) <= LOC_ORDER[nd.loc]; });
                if (!prot && !ln.verdicts.some(function (x) { return x.code === 'aq_hydrate'; })) {
                    ln.verdicts.push(_V('warn', 'aq_hydrate', u.c.short + ' is about ' + _grp(u.water * 100, 0) + ' % water and is injected upstream of a hydrate-risk node (' + nd.label + ') with no hydrate inhibitor: it can form hydrate or ice there.'));
                    ln.level = _worst(ln.verdicts);
                }
            });
        });
        // Hydrate block (spread + node verdicts with the inhibitor lines)
        var hv = S.verdicts.slice();
        S.nodes.forEach(function (nd) {
            if (!(nd.dTreq > 0)) return;
            var prot = lines.filter(function (t) { return t.kind === 'thi' && t.hydrate && t.rate.gal_d > 0 && _ptOrder(t.point) <= LOC_ORDER[nd.loc]; });
            if (prot.length) hv.push(_V('ok', 'node_protected', nd.label + ' is protected by line ' + prot.map(function (t) { return t.n; }).join(', ') + ' (' + prot[0].chemShort + ', margin ' + F.dt(S.margin.used) + ').'));
            else if (nd.status === 'bad') hv.push(_V('bad', 'node_risk', 'Hydrate risk at ' + nd.label.toLowerCase() + ': ' + F.t(nd.t_F) + ' is ' + F.dt(nd.sub) + ' below the hydrate temperature ' + F.t(nd.thyd) + ' (margin ' + F.dt(S.margin.used) + '). Inject upstream of ' + nd.label.toLowerCase() + '.'));
            else hv.push(_V('warn', 'node_margin', nd.label + ' is within the ' + F.dt(S.margin.used) + ' hydrate margin (' + F.t(nd.t_F) + ' against ' + F.t(nd.thyd) + ').'));
        });
        [S.shutin, S.startup].forEach(function (nd) {
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
                return { n: ln.n, point: ln.pointShort, chem: ln.chemShort, gal_d: ln.rate.gal_d, mL_min: ln.rate.mL_min, pump: ln.pump.name, setting: ln.setting,
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
                target_gal_d: ln.rate.gal_d, pReq: ln.pressure.pReq, ratio: ps2.ratio });
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
