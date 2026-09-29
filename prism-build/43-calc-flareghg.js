// ═══════════════════════════════════════════════════════════════════════
// 43-calc-flareghg.js — Flare Emissions (plug-in calculator, Round-9)
//
//   Route key : flareghg          (window.WTS_calcRegistry.flareghg)
//   Page      : Flare Emissions   (sidebar group "Safety & Process")
//   Public    : window.renderFlareEmissions(body)
//               window.calcFlareGHG()            — reads the DOM, validates, renders
//               window.WTS_flareghg_compute(inp) — pure, field units in/out, no DOM
//   State     : window.WTS_state.flareghg = {V_scf, E_MMBtu, co2_t, ch4_t, n2o_kg,
//                                            so2_t, co2e_t, co2oil_t, gwp, hrs,
//                                            h2sUnburned_kg, ts}
//
// Flared gas volume, heat released and CO2 / CH4 / N2O / CO2e / SO2 for well
// test flaring, plus CO2 from an oil / condensate burner. Field units inside
// (MMSCFD, hr, °F, psia, BPD, °API); tagged inputs are converted by the units
// layer. Emissions are always reported in metric tonnes / kg (reporting
// practice) and are not unit-tagged.
//
// Method (NEW-CALCS-SPEC §3.3):
//   (1) normalise the composition y_j = x_j / Σx
//   (2) base molar volume V_m = R·(T_b + 459.67)/p_b, R = 10.7316 psia·ft³/(lbmol·°R)
//   (3) flared volume V = q_g·10⁶·hrs/24 scf, moles n = V/V_m
//   (4) MW = Σ y_j·M_j, SG = MW/28.9647, HHV_mix = Σ y_j·HHV_j (60 °F, 14.696 psia)
//   (5) heat released E = n·HHV_mix·V_m,std/10⁶ MMBtu (HHV is per scf at the
//       GPA 2145 standard, so moles are converted back at 60 °F / 14.696 psia)
//   (6) oxidised fraction η = 1 (oxidation factor 1) or CE/100
//   (7) CO2 = n·(η·Σ y_j·C_j + y_CO2)·44.010 lb            — 40 CFR 98.233(n)
//   (8) CH4 slip = n·(1 − η)·y_C1·16.043 lb                 — 40 CFR 98.233(n)
//   (9) N2O = E·1.0×10⁻⁴ kg/MMBtu                           — 40 CFR 98.233(z) flare factor
//  (10) SO2 = n·y_H2S·η·64.064 lb; unburned H2S = n·y_H2S·(1 − η)·34.081 lb
//  (11) liquid burner: m = q_o·hrs/24·SG_o·350.16 lb, SG_o = 141.5/(131.5 + API);
//       CO2 = m·(w_C/100)·(44.010/12.011)·η
//  (12) CO2e = CO2_gas + CO2_liquid + GWP_CH4·CH4 + GWP_N2O·N2O  (t)
//  (13) Tier-1 cross-check: V_N = n·0.45359237·22.41397 Nm³, CO2 = V_N·0.00393 t
//       (EU 2018/2066 Annex IV flare reference factor, ethane proxy; for reference)
//
// References: 40 CFR 98.233(n) and (v); IPCC AR4 / AR5 / AR6 GWP-100; GPA 2145
// (ideal-gas properties at 60 °F and 14.696 psia); EU 2018/2066 Annex IV as
// retained in the UK ETS; NSTA flaring and venting guidance.
//
// Conventions: one outer IIFE, 'use strict', window-only public symbols, no
// external dependencies, safe without document / WTS_units / drawLineChart,
// no timers. Self-test at the end (stripped by concat-round9).
// ═══════════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    var G = (typeof window !== 'undefined') ? window : globalThis;
    var P = 'fe_';

    // ── page helpers (NEW-CALCS-SPEC §0.3) ──────────────────────────────
    function _byId(id) { return (typeof document !== 'undefined' && document.getElementById) ? document.getElementById(id) : null; }
    function _num(id) { var e = _byId(id); if (!e) return NaN; var s = String(e.value).trim(); return s === '' ? NaN : parseFloat(s); }
    function _blank(id) { var e = _byId(id); return !e || String(e.value).trim() === ''; }
    function _fmt(v, d) {
        if (v == null || !isFinite(v)) return '—';
        return Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: (d == null ? 2 : d) });
    }
    // value in the display system; impLabel is the imperial text
    function _u(v, cat, d, impLabel) {
        var U = G.WTS_units;
        if (U && U.getSystem && U.getSystem() === 'metric' && U.format) { var f = U.format(v, cat); return _fmt(f.value, d) + ' ' + f.label; }
        return _fmt(v, d) + ' ' + impLabel;
    }
    function _tag(map) { var U = G.WTS_units; if (!U || !U.tagInput) return; for (var id in map) U.tagInput(id, map[id]); }
    function _canon(fn) { var U = G.WTS_units; return (U && U.runCanonical) ? U.runCanonical(fn) : fn(); }
    // tonnes: more decimals for small numbers
    function _t(v) { if (v == null || !isFinite(v)) return '—'; var a = Math.abs(v); return _fmt(v, a >= 100 ? 2 : a >= 1 ? 3 : 4); }

    // ── constants (§3.2) ────────────────────────────────────────────────
    // GPA 2145 ideal-gas values at 60 °F and 14.696 psia: carbon atoms C,
    // molar mass M (lb/lbmol), gross heating value H (Btu/scf).
    var COMP = [
        { k: 'c1',  C: 1, M: 16.043, H: 1010.0, name: 'Methane C1',            def: 85.0 },
        { k: 'c2',  C: 2, M: 30.070, H: 1769.7, name: 'Ethane C2',             def: 6.0 },
        { k: 'c3',  C: 3, M: 44.097, H: 2516.1, name: 'Propane C3',            def: 3.0 },
        { k: 'ic4', C: 4, M: 58.123, H: 3251.9, name: 'i-Butane',              def: 0.6 },
        { k: 'nc4', C: 4, M: 58.123, H: 3262.3, name: 'n-Butane',              def: 0.8 },
        { k: 'ic5', C: 5, M: 72.150, H: 4000.9, name: 'i-Pentane',             def: 0.3 },
        { k: 'nc5', C: 5, M: 72.150, H: 4008.9, name: 'n-Pentane',             def: 0.3 },
        { k: 'c6',  C: 6, M: 86.177, H: 4755.9, name: 'Hexanes C6',            def: 0.2 },
        { k: 'c7',  C: 7, M: 100.205, H: 5502.5, name: 'Heptanes-plus C7+',    def: 0.2, plus: true },
        { k: 'co2', C: 0, M: 44.010, H: 0,      name: 'Carbon dioxide CO2',    def: 2.0 },
        { k: 'n2',  C: 0, M: 28.014, H: 0,      name: 'Nitrogen N2',           def: 1.5 },
        { k: 'h2s', C: 0, M: 34.081, H: 637.1,  name: 'Hydrogen sulphide H2S', def: 0.1 }
    ];
    var M_CO2 = 44.010, M_CH4 = 16.043, M_SO2 = 64.064, M_H2S = 34.081, M_C = 12.011, M_AIR = 28.9647;
    var R_GAS = 10.7316;                                   // psia·ft³/(lbmol·°R)
    var LB_KG = 0.45359237;                                // kg per lb
    var WATER_LB_BBL = 350.16;                             // lb/bbl water at 60 °F
    var NM3_KMOL = 22.41397;                               // Nm³/kmol at 0 °C, 101.325 kPa
    var VM_STD = R_GAS * (60 + 459.67) / 14.696;           // 379.48 scf/lbmol (HHV basis)
    var N2O_KG_MMBTU = 1.0e-4;                             // 40 CFR 98 Subpart W flare N2O factor
    var TIER1_T_NM3 = 0.00393;                             // EU 2018/2066 Annex IV flare reference (ethane proxy)
    var GWP = {                                            // IPCC GWP-100
        ar5: { ch4: 28,   n2o: 265, label: 'IPCC AR5', text: 'IPCC AR5 — CH4 28, N2O 265' },
        ar6: { ch4: 29.8, n2o: 273, label: 'IPCC AR6', text: 'IPCC AR6 — CH4 29.8, N2O 273' },
        ar4: { ch4: 25,   n2o: 298, label: 'IPCC AR4', text: 'IPCC AR4 — CH4 25, N2O 298' }
    };
    var GWP_ORDER = ['ar5', 'ar6', 'ar4'];

    // Unit map (input id → WTS_units category). fe_c7n, fe_ox1, fe_gwp untagged.
    var UNITS = {
        fe_qg: 'gasRate', fe_hrs: 'time', fe_ce: 'percent', fe_tb: 'temperature', fe_pbase: 'pressureBase',
        fe_qo: 'liquidRate', fe_api: 'api', fe_wc: 'percent'
    };
    COMP.forEach(function (c) { UNITS[P + c.k] = 'percent'; });

    // ── validation helpers ──────────────────────────────────────────────
    // Range check with a small relative tolerance, so a metric round trip
    // (e.g. 0 °C → 32 °F) never trips a bound.
    function _inR(v, lo, hi) {
        var e = 1e-6 * Math.max(1, Math.abs(lo), Math.abs(hi));
        return isFinite(v) && v >= lo - e && v <= hi + e;
    }
    function _rngText(lo, hi, cat, d, imp) {
        return 'between ' + _u(lo, cat, d, imp) + ' and ' + _u(hi, cat, d, imp);
    }

    // ── pure compute (§3.3) ─────────────────────────────────────────────
    // inp = {qg, hrs, ce, ox1, gwp, tb, pbase, y:{c1..h2s}, c7n, qo, api, wc}
    // Field units: qg MMSCFD, hrs hr, ce %, tb °F, pbase psia, y mol %, qo BPD,
    // api °API, wc mass %. Returns the §3.5 compute contract. errors[] are
    // messages; errFields[] the matching input keys (for highlighting).
    function compute(inp) {
        inp = inp || {};
        var errors = [], errFields = [], warnings = [];
        function err(key, msg) { errors.push(msg); errFields.push(key); }
        function num(v) { return (v === '' || v == null) ? NaN : Number(v); }

        var qg = num(inp.qg), hrs = num(inp.hrs), ce = num(inp.ce), tb = num(inp.tb), pb = num(inp.pbase);
        var qo = (inp.qo === '' || inp.qo == null) ? 0 : Number(inp.qo);
        var api = num(inp.api), wc = num(inp.wc), c7n = num(inp.c7n);
        var ox1 = !!inp.ox1;
        var gkey = String(inp.gwp == null ? 'ar5' : inp.gwp);

        if (!isFinite(qg)) err('qg', 'Gas to flare is required (enter 0 for a liquid-only burn).');
        else if (!_inR(qg, 0, 500)) err('qg', 'Gas to flare must be ' + _rngText(0, 500, 'gasRate', 3, 'MMSCFD') + '.');
        if (!isFinite(qo)) err('qo', 'Liquid to burner must be a number (0 if none).');
        else if (!_inR(qo, 0, 100000)) err('qo', 'Liquid to burner must be ' + _rngText(0, 100000, 'liquidRate', 1, 'BPD') + '.');
        if (isFinite(qg) && isFinite(qo) && qg <= 0 && qo <= 0) err('qg', 'Enter a gas rate or a liquid-to-burner rate above 0.');
        if (!isFinite(hrs)) err('hrs', 'Flaring duration is required.');
        else if (!(hrs > 0) || !_inR(hrs, 0, 8760)) err('hrs', 'Flaring duration must be above 0 and at most 8,760 hr.');
        if (!isFinite(ce)) err('ce', 'Combustion efficiency is required.');
        else if (!_inR(ce, 50, 100)) err('ce', 'Combustion efficiency must be between 50 and 100 %.');
        if (!GWP[gkey]) err('gwp', 'Select a GWP basis (IPCC AR4, AR5 or AR6).');
        if (!isFinite(tb)) err('tb', 'Base temperature is required.');
        else if (!_inR(tb, 32, 77)) err('tb', 'Base temperature must be ' + _rngText(32, 77, 'temperature', 1, '°F') + '.');
        if (!isFinite(pb)) err('pbase', 'Base pressure is required.');
        else if (!_inR(pb, 14.0, 15.1)) err('pbase', 'Base pressure must be ' + _rngText(14.0, 15.1, 'pressure', 3, 'psia') + '.');

        // Composition — blank components count as 0.
        var y = inp.y || {}, x = {}, sumIn = 0, compOk = true;
        COMP.forEach(function (c) {
            var v = (y[c.k] === '' || y[c.k] == null) ? 0 : Number(y[c.k]);
            if (!isFinite(v) || !_inR(v, 0, 100)) { err(c.k, c.name + ' must be between 0 and 100 %.'); compOk = false; v = 0; }
            x[c.k] = v; sumIn += v;
        });
        if (compOk && !_inR(sumIn, 50, 150)) err('c1', 'Composition totals ' + _fmt(sumIn, 2) + ' % — the total must be between 50 and 150 %.');
        if (!isFinite(c7n)) err('c7n', 'C7+ average carbon number is required.');
        else if (!_inR(c7n, 7, 30)) err('c7n', 'C7+ average carbon number must be between 7 and 30.');

        // Liquid properties matter only when liquid is burned.
        if (isFinite(qo) && qo > 0) {
            if (!isFinite(api)) err('api', 'Liquid gravity is required when liquid is burned.');
            else if (!_inR(api, 5, 90)) err('api', 'Liquid gravity must be between 5 and 90 °API.');
            if (!isFinite(wc)) err('wc', 'Carbon content is required when liquid is burned.');
            else if (!_inR(wc, 80, 90)) err('wc', 'Carbon content must be between 80 and 90 %.');
        } else {
            if (isFinite(api) && !_inR(api, 5, 90)) err('api', 'Liquid gravity must be between 5 and 90 °API.');
            if (isFinite(wc) && !_inR(wc, 80, 90)) err('wc', 'Carbon content must be between 80 and 90 %.');
        }

        var out = { ok: false, errors: errors, errFields: errFields, warnings: warnings, verdicts: [] };
        if (errors.length) return out;

        // (1) normalise
        var yn = {};
        COMP.forEach(function (c) { yn[c.k] = x[c.k] / sumIn; });
        // C7+ pseudo-component from the average carbon number N
        function props(c) {
            if (!c.plus) return c;
            return { C: c7n, M: 14.027 * c7n + 2.016, H: 5502.5 + 746.4 * (c7n - 7) };
        }
        // (2) base molar volume; (3) volume and moles
        var Vm = R_GAS * (tb + 459.67) / pb;                       // scf/lbmol at base
        var Vscf = qg * 1e6 * hrs / 24;                             // scf at base
        var nmol = Vscf / Vm;                                       // lbmol
        // (4) mixture properties
        var MW = 0, HHV = 0, sumC = 0;
        COMP.forEach(function (c) { var p = props(c); MW += yn[c.k] * p.M; HHV += yn[c.k] * p.H; sumC += yn[c.k] * p.C; });
        var SG = MW / M_AIR;
        // (5) heat released
        var E = nmol * HHV * VM_STD / 1e6;                          // MMBtu
        // (6) oxidised fraction
        var eta = ox1 ? 1 : ce / 100;
        // (7)-(10) gas emissions (lb → t / kg)
        var co2_lb = nmol * (eta * sumC + yn.co2) * M_CO2;
        var ch4_lb = nmol * (1 - eta) * yn.c1 * M_CH4;
        var n2o_kg = E * N2O_KG_MMBTU;
        var so2_lb = nmol * yn.h2s * eta * M_SO2;
        var h2s_lb = nmol * yn.h2s * (1 - eta) * M_H2S;
        // (11) liquid burner
        var sgo = (qo > 0) ? 141.5 / (131.5 + api) : null;
        var oil_lb = (qo > 0) ? qo * hrs / 24 * sgo * WATER_LB_BBL : 0;
        var co2oil_lb = (qo > 0) ? oil_lb * (wc / 100) * (M_CO2 / M_C) * eta : 0;
        // (12) CO2e
        var g = GWP[gkey];
        var co2_t = co2_lb * LB_KG / 1000, ch4_t = ch4_lb * LB_KG / 1000, so2_t = so2_lb * LB_KG / 1000;
        var co2oil_t = co2oil_lb * LB_KG / 1000;
        var co2eGas_t = co2_t + g.ch4 * ch4_t + g.n2o * n2o_kg / 1000;
        var co2e_t = co2eGas_t + co2oil_t;
        // (13) Tier-1 reference
        var Nm3 = nmol * LB_KG * NM3_KMOL;
        var tier1_t = Nm3 * TIER1_T_NM3;

        out.ok = true;
        out.sumIn = sumIn; out.Vm = Vm; out.Vscf = Vscf; out.Nm3 = Nm3; out.nmol = nmol;
        out.MW = MW; out.SG = SG; out.HHV = HHV; out.sumC = sumC;
        out.E_MMBtu = E; out.E_GJ = E * 1.055056;
        out.eta = eta; out.ox1 = ox1; out.ce = ce; out.hrs = hrs; out.qg = qg; out.qo = qo;
        out.co2_t = co2_t; out.ch4_t = ch4_t; out.n2o_kg = n2o_kg; out.so2_t = so2_t;
        out.h2sUnburned_kg = h2s_lb * LB_KG;
        out.oilSG = sgo; out.oilMass_lb = oil_lb; out.co2oil_t = co2oil_t;
        out.co2eGas_t = co2eGas_t; out.co2e_t = co2e_t; out.co2ePerDay_t = co2e_t * 24 / hrs;
        out.intensity = (Vscf > 0) ? co2eGas_t / (Vscf / 1e6) : null;   // t CO2e per MMSCF
        out.tier1_t = tier1_t;
        out.gwp = gkey; out.gwpLabel = g.label; out.gwpCH4 = g.ch4; out.gwpN2O = g.n2o;

        // Verdicts (§3.4)
        if (Math.abs(sumIn - 100) > 0.5) {
            warnings.push('Composition totals ' + _fmt(sumIn, 2) + ' % — normalised to 100 %.');
            out.verdicts.push({ level: 'warn', text: 'Composition totals ' + _fmt(sumIn, 2) + ' % — normalised to 100 %.' });
        }
        if (qg > 0 && HHV < 300) {
            var hv = 'Heating value ' + _u(HHV, 'heatingValue', 1, 'Btu/scf') + ' is below ' + _u(300, 'heatingValue', 1, 'Btu/scf') +
                ' — the flare may not sustain the assumed combustion efficiency; consider assist gas.';
            warnings.push(hv);
            out.verdicts.push({ level: 'warn', text: hv });
        }
        if (ox1) out.verdicts.push({ level: 'ok', text: 'Oxidation factor 1 — all carbon reported as CO2; no methane slip or unburned H2S.' });
        else out.verdicts.push({ level: 'ok', text: 'Combustion efficiency ' + _fmt(ce, 2) + ' % applied to hydrocarbons and H2S.' });
        return out;
    }
    G.WTS_flareghg_compute = compute;

    // ── render (§3.1, §3.6) ─────────────────────────────────────────────
    function _field(id, label, value, extra) {
        return '<div class="fg-item"><label for="' + id + '">' + label + '</label>' +
            '<input type="number" id="' + id + '" value="' + value + '" step="any"' + (extra || '') + '></div>';
    }
    function _pageHtml() {
        var gwpOpts = GWP_ORDER.map(function (k) {
            return '<option value="' + k + '"' + (k === 'ar5' ? ' selected' : '') + '>' + GWP[k].text + '</option>';
        }).join('');
        var comp = COMP.map(function (c) {
            var lbl = c.name + ' (%)';
            return _field(P + c.k, lbl, c.def, ' min="0" max="100"');
        }).join('');
        return '<div id="fe_root"><div class="cols-2">' +
            '<div>' +
              '<div class="card"><div class="card-title">Flared Gas</div><div class="fg">' +
                _field('fe_qg', 'Gas to flare (MMSCFD)', 5, ' min="0"') +
                _field('fe_hrs', 'Flaring duration (hr)', 24, ' min="0"') +
                _field('fe_ce', 'Combustion efficiency (%)', 98, ' min="50" max="100"') +
                '<div class="fg-item"><label for="fe_ox1">Assume complete combustion, oxidation factor 1</label>' +
                  '<input type="checkbox" id="fe_ox1" style="width:20px;height:20px;padding:0;margin:6px 0 0;align-self:flex-start;accent-color:var(--accent)"></div>' +
                '<div class="fg-item"><label for="fe_gwp">GWP basis</label><select id="fe_gwp">' + gwpOpts + '</select></div>' +
                _field('fe_tb', 'Base temperature (°F)', 60) +
                _field('fe_pbase', 'Base pressure, absolute (psia)', 14.696) +
              '</div></div>' +
              '<div class="card"><div class="card-title">Gas Composition (mol %)</div>' +
                '<div class="info-bar">Blank components count as 0. A total other than 100 % is normalised to 100 %.</div>' +
                '<div class="fg">' + comp +
                  _field('fe_c7n', 'C7+ average carbon number', 7, ' min="7" max="30"') +
                '</div></div>' +
              '<div class="card"><div class="card-title">Oil / Condensate to Burner (optional)</div><div class="fg">' +
                _field('fe_qo', 'Liquid to burner (BPD)', 0, ' min="0"') +
                _field('fe_api', 'Liquid gravity (°API)', 40, ' min="5" max="90"') +
                _field('fe_wc', 'Carbon content, mass (%)', 85, ' min="80" max="90"') +
                '</div>' +
                '<div class="btn-row"><button class="btn btn-primary" onclick="calcFlareGHG()">Calculate</button></div>' +
              '</div>' +
            '</div>' +
            '<div><div id="fe_res"></div></div>' +
            '</div></div>';
    }

    function render(body) {
        if (!body) return;
        var t = _byId('pgTitle'), s = _byId('pgSub');
        if (t) t.textContent = ENTRY.title;
        if (s) s.textContent = ENTRY.sub;
        body.innerHTML = _pageHtml();
        _tag(UNITS);
        var root = _byId('fe_root');
        if (root && root.addEventListener) {
            root.addEventListener('change', function (e) {
                var id = (e && e.target && e.target.id) || '';
                if (id.indexOf(P) === 0) G.calcFlareGHG();
            });
        }
        G.calcFlareGHG();
    }
    G.renderFlareEmissions = render;

    // ── calc (reads DOM in a canonical context → imperial values) ───────
    function _readInputs() {
        var y = {};
        COMP.forEach(function (c) { y[c.k] = _blank(P + c.k) ? '' : _num(P + c.k); });
        var gsel = _byId('fe_gwp'), ox = _byId('fe_ox1');
        return {
            qg: _num('fe_qg'), hrs: _num('fe_hrs'), ce: _num('fe_ce'),
            ox1: !!(ox && ox.checked), gwp: gsel ? String(gsel.value) : 'ar5',
            tb: _num('fe_tb'), pbase: _num('fe_pbase'), y: y, c7n: _num('fe_c7n'),
            qo: _blank('fe_qo') ? '' : _num('fe_qo'), api: _num('fe_api'), wc: _num('fe_wc')
        };
    }
    function _row(label, value) { return '<div class="rrow"><span class="rl">' + label + '</span><span class="rv">' + value + '</span></div>'; }
    function _verdictHtml(v) {
        var col = v.level === 'ok' ? 'var(--green)' : v.level === 'bad' ? 'var(--red)' : 'var(--yellow)';
        var sym = v.level === 'ok' ? '✓' : v.level === 'bad' ? '✗' : '⚠';
        return '<div style="color:' + col + ';font-size:13px;margin:6px 0">' + sym + ' ' + v.text + '</div>';
    }
    // Base-condition text for the Notes (the header "Std" selector fills the
    // base fields while they hold the value it last wrote — 22-units.js).
    function _basisText(inp) {
        var B = G.WTS_baseConditions, b = { Tb_F: +inp.tb, Pb_psia: +inp.pbase };
        return (B && B.text) ? B.text(b) : (_fmt(b.Tb_F, 2) + ' °F / ' + _fmt(b.Pb_psia, 3) + ' psia');
    }
    // Metric (v3.0): molar volume m³/kmol (1 scf/lbmol = 0.0283168466/0.45359237),
    // molar mass kg/kmol (same number), intensity per 10³ Sm³ (1 MMSCF = 28.3168466 10³ Sm³).
    function _isMet() { return !!(G.WTS_units && G.WTS_units.getSystem && G.WTS_units.getSystem() === 'metric'); }
    function _resultsHtml(r, inp) {
        var met = _isMet();
        var h = '<div class="rbox"><div class="rbox-title">Flared Gas</div>' +
            _row('Volume flared', _u(r.Vscf / 1e6, 'gasVolume', 4, 'MMSCF')) +
            _row('Normal volume (0 °C, 101.325 kPa)', _fmt(r.Nm3, 1) + ' Nm³') +
            _row('Molar volume at base', met ? _fmt(r.Vm * 0.0283168466 / LB_KG, 3) + ' Sm³/kmol' : _fmt(r.Vm, 2) + ' scf/lbmol') +
            _row('Moles flared', _fmt(r.nmol, 1) + ' lbmol (' + _fmt(r.nmol * LB_KG, 1) + ' kmol)') +
            _row('Molar mass', _fmt(r.MW, 3) + (met ? ' kg/kmol' : ' lb/lbmol')) +
            _row('Gas gravity (air = 1)', _fmt(r.SG, 4)) +
            _row('Heating value HHV', _u(r.HHV, 'heatingValue', 1, 'Btu/scf')) +
            _row('Heat released', _fmt(r.E_MMBtu, 1) + ' MMBtu (' + _fmt(r.E_GJ, 1) + ' GJ)') +
            _row('Composition total entered', _fmt(r.sumIn, 2) + ' %') +
            '</div>';
        h += '<div class="rbox"><div class="rbox-title">Emissions for ' + _fmt(r.hrs, 2) + ' h</div>' +
            _row('CO2 from gas', _t(r.co2_t) + ' t');
        if (r.qo > 0) {
            h += _row('Liquid burned', _fmt(r.oilMass_lb, 1) + ' lb (' + _t(r.oilMass_lb * LB_KG / 1000) + ' t), SG ' + _fmt(r.oilSG, 4)) +
                 _row('CO2 from liquid burner', _t(r.co2oil_t) + ' t');
        }
        h += _row('CH4 (methane slip)', _t(r.ch4_t) + ' t') +
            _row('N2O', _fmt(r.n2o_kg, 4) + ' kg') +
            _row('SO2', _t(r.so2_t) + ' t') +
            _row('Unburned H2S', _fmt(r.h2sUnburned_kg, 2) + ' kg') +
            _row('Total CO2e (' + r.gwpLabel + ')', _t(r.co2e_t) + ' t') +
            _row('CO2e per day', _t(r.co2ePerDay_t) + ' t/d') +
            _row('Intensity (gas CO2e)', (r.intensity == null ? '—' : met ? _fmt(r.intensity / 28.3168466, 4) + ' t CO2e per 10³ Sm³' : _fmt(r.intensity, 2) + ' t CO2e per MMSCF')) +
            _row('Tier-1 reference CO2 (ethane proxy)', _t(r.tier1_t) + ' t') +
            '</div>';
        h += r.verdicts.map(_verdictHtml).join('');
        h += '<div style="font-size:12px;color:var(--text2);line-height:1.6;margin-top:10px"><b>Notes</b> ' +
            'Emission factors and combustion efficiency follow common reporting practice (98 % default). ' +
            'Check the method your consent, permit or trading scheme requires before submitting figures. ' +
            'Standard volumes (scf' + ((G.WTS_units && G.WTS_units.getSystem && G.WTS_units.getSystem() === 'metric') ? ', 10³ Sm³' : '') +
            ') are at the entered base conditions, ' + _basisText(inp || {}) + '; the header standard-conditions selector sets them.</div>';
        return h;
    }
    function _clearErrs() {
        var root = _byId('fe_root');
        if (!root || !root.querySelectorAll) return;
        var els = root.querySelectorAll('.input-err');
        for (var i = 0; i < els.length; i++) els[i].classList.remove('input-err');
    }
    function _calcImpl() {
        var res = _byId('fe_res');
        var inp = _readInputs();
        var r = compute(inp);
        if (!res) return r;
        _clearErrs();
        if (!r.ok) {
            r.errFields.forEach(function (k) { var e = _byId(P + k); if (e && e.classList) e.classList.add('input-err'); });
            // Messages are fixed text + formatted numbers only (never user text).
            res.innerHTML = '<div class="val-error"><strong>Please fix the following:</strong><ul>' +
                r.errors.map(function (m) { return '<li>' + m + '</li>'; }).join('') + '</ul></div>';
            res.removeAttribute('data-done');
            return r;
        }
        res.innerHTML = _resultsHtml(r, inp);
        G.WTS_state = G.WTS_state || {};
        G.WTS_state.flareghg = {
            V_scf: r.Vscf, E_MMBtu: r.E_MMBtu, co2_t: r.co2_t, ch4_t: r.ch4_t, n2o_kg: r.n2o_kg,
            so2_t: r.so2_t, co2e_t: r.co2e_t, co2oil_t: r.co2oil_t, gwp: r.gwp,
            hrs: r.hrs, h2sUnburned_kg: r.h2sUnburned_kg, ts: Date.now()
        };
        res.setAttribute('data-done', '1');
        return r;
    }
    G.calcFlareGHG = function () { return _canon(_calcImpl); };

    // ── registry entry ──────────────────────────────────────────────────
    var ENTRY = {
        key: 'flareghg',
        title: 'Flare Emissions',
        sub: 'Flared gas volume, heat released and CO2 / CH4 / N2O / CO2e / SO2 emissions for well test flaring, with liquid-burner CO2',
        group: 'Safety & Process',
        icon: '&#127981;',
        badge: 'Safety',
        bc: 'dc-b-orange',
        desc: 'Flared volume, heat released, CO2, CH4, N2O, CO2e, SO2 and liquid-burner CO2 for well test flaring reports.',
        render: function (body) { return G.renderFlareEmissions(body); }
    };
    G.WTS_calcRegistry = G.WTS_calcRegistry || {};
    G.WTS_calcRegistry.flareghg = ENTRY;

    // Recalculate on a unit-system flip (results already shown only).
    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('wts:unit-system-changed', function () {
            var r = _byId('fe_res');
            if (r && r.getAttribute('data-done') === '1') G.calcFlareGHG();
        });
        document.addEventListener('wts:base-conditions-changed', function () {
            var r = _byId('fe_res');
            if (r && r.getAttribute('data-done') === '1') G.calcFlareGHG();
        });
    }
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var f = G.WTS_flareghg_compute;
    var fails = [];
    function rel(got, want, tol, what) {
        var ok = isFinite(got) && Math.abs(got - want) <= (tol || 1e-3) * Math.max(Math.abs(want), 1e-12);
        if (!ok) fails.push(what + ': got ' + got + ', want ' + want);
    }
    function abs(got, want, tol, what) { if (!(Math.abs(got - want) <= tol)) fails.push(what + ': got ' + got + ', want ' + want); }
    var Y = { c1: 85, c2: 6, c3: 3, ic4: 0.6, nc4: 0.8, ic5: 0.3, nc5: 0.3, c6: 0.2, c7: 0.2, co2: 2, n2: 1.5, h2s: 0.1 };
    var base = { qg: 5, hrs: 24, ce: 98, ox1: false, gwp: 'ar5', tb: 60, pbase: 14.696, y: Y, c7n: 7, qo: 0, api: 40, wc: 85 };
    function mk(o) { var r = {}, k; for (k in base) r[k] = base[k]; for (k in o) r[k] = o[k]; return r; }

    // F1 — defaults
    var a = f(base);
    if (!a.ok) fails.push('F1 not ok: ' + a.errors.join('; '));
    rel(a.Vm, 379.48, 1e-4, 'F1 Vm'); rel(a.Vscf, 5e6, 1e-9, 'F1 V'); rel(a.nmol, 13175.8, 1e-3, 'F1 n');
    rel(a.MW, 19.718, 1e-3, 'F1 MW'); rel(a.SG, 0.6807, 1e-3, 'F1 SG'); rel(a.sumC, 1.1720, 1e-3, 'F1 sumC');
    rel(a.HHV, 1131.0, 1e-3, 'F1 HHV'); rel(a.E_MMBtu, 5654.7, 1e-3, 'F1 E'); rel(a.E_GJ, 5966.1, 1e-3, 'F1 E GJ');
    rel(a.co2_t, 307.36, 1e-3, 'F1 CO2'); rel(a.ch4_t, 1.630, 1e-3, 'F1 CH4'); rel(a.n2o_kg, 0.565, 2e-3, 'F1 N2O');
    rel(a.so2_t, 0.3752, 1e-3, 'F1 SO2'); rel(a.h2sUnburned_kg, 4.07, 2e-3, 'F1 H2S');
    rel(a.co2e_t, 353.15, 1e-3, 'F1 CO2e'); rel(a.co2ePerDay_t, 353.15, 1e-3, 'F1 CO2e/d'); rel(a.intensity, 70.63, 1e-3, 'F1 intensity');
    rel(a.Nm3, 133955.8, 1e-3, 'F1 Nm3'); rel(a.tier1_t, 526.45, 1e-3, 'F1 Tier-1');

    // F2 — pure methane, 1 MMSCFD for 24 h
    var b = f(mk({ qg: 1, y: { c1: 100 } }));
    if (!b.ok) fails.push('F2 not ok: ' + b.errors.join('; '));
    rel(b.nmol, 2635.16, 1e-3, 'F2 n'); rel(b.co2_t, 51.553, 1e-3, 'F2 CO2'); rel(b.ch4_t, 0.3835, 1e-3, 'F2 CH4');
    rel(b.E_MMBtu, 1010.0, 1e-3, 'F2 E'); rel(b.n2o_kg, 0.101, 1e-2, 'F2 N2O'); rel(b.co2e_t, 62.318, 1e-3, 'F2 CO2e');
    rel(b.Nm3, 26791.2, 1e-3, 'F2 Nm3'); rel(b.tier1_t, 105.29, 1e-3, 'F2 Tier-1');
    rel(1e6 * 0.98 * 0.0526 / 1000, b.co2_t, 2e-3, 'F2 Subpart W density cross-check');

    // F3 — oxidation factor 1 + liquid burner, AR6
    var c = f(mk({ qg: 2, hrs: 12, ox1: true, gwp: 'ar6', qo: 1000, api: 35, wc: 85 }));
    if (!c.ok) fails.push('F3 not ok: ' + c.errors.join('; '));
    rel(c.Vscf, 1e6, 1e-9, 'F3 V'); rel(c.co2_t, 62.705, 1e-3, 'F3 CO2 gas');
    abs(c.ch4_t, 0, 1e-12, 'F3 CH4'); abs(c.h2sUnburned_kg, 0, 1e-12, 'F3 H2S');
    rel(c.so2_t, 0.07657, 1e-3, 'F3 SO2'); rel(c.n2o_kg, 0.1131, 1e-3, 'F3 N2O');
    rel(c.oilMass_lb, 148791.7, 1e-3, 'F3 liquid mass'); rel(c.oilSG, 0.8498, 1e-3, 'F3 SG');
    rel(c.co2oil_t, 210.20, 1e-3, 'F3 CO2 liquid'); rel(c.co2e_t, 272.94, 1e-3, 'F3 CO2e');
    rel(c.co2ePerDay_t, 545.87, 1e-3, 'F3 CO2e/d');

    // Validation — messages, never NaN
    var e = f(mk({ qg: 0, qo: 0 }));
    if (e.ok || !e.errors.length) fails.push('qg = qo = 0 must be an error');
    var e2 = f(mk({ y: { c1: 40 } }));
    if (e2.ok || !/between 50 and 150/.test(e2.errors.join(' '))) fails.push('composition total 40 must be an error');

    if (fails.length) throw new Error('[43-calc-flareghg] self-test failed:\n  ' + fails.join('\n  '));
    if (typeof console !== 'undefined') console.log('[43-calc-flareghg] self-test ok (F1, F2, F3 + validation)');
})();
