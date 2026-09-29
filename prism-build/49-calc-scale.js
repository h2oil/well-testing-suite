// ════════════════════════════════════════════════════════════════════
// WTS — Round-9 plug-in calculator — Scale & Water Analysis (scale)
//
// PURPOSE
//   From a produced / injection water analysis (mg/L): ion molarities and
//   meq/L, charge balance, TDS, ionic strength, Langelier and Stiff–Davis
//   calcium carbonate indices, and Oddo–Tomson saturation indices for
//   calcite, barite, celestite, gypsum and anhydrite at temperature and
//   pressure, with ✓ / ⚠ / ✗ scaling-tendency verdicts, an SI-vs-temperature
//   table and chart.
//
// METHOD (references in brackets)
//   Molarity c = mg/L / (1000·MW); meq/L = mg/L·|z| / MW.
//   Ionic strength I = ½ Σ cᵢ·zᵢ² (mol/L).                         [Standard Methods 1030 / USBR MS-2016 eq. 1]
//   Charge balance % = (Σcat − Σan)/(Σcat + Σan)·100 in meq/L;
//     ≤ 5 % acceptable, 5–10 % questionable, > 10 % poor.           [Standard Methods 1030 E; USBR MS-2016 eq. 3]
//   Langelier (Carrier 1965 form):                                   [ASTM D3739; Carrier (1965)]
//     pHs = (9.3 + A + B) − (C + D); A = (log10 TDS − 1)/10,
//     B = −13.12·log10(T_K) + 34.55, C = log10(Ca as CaCO3, mg/L) − 0.4,
//     D = log10(total alkalinity as CaCO3, mg/L); LSI = pH − pHs.
//     Valid for TDS ≤ 10,000 mg/L.
//   Stiff–Davis: S&DSI = pH − pCa − pAlk − K, pCa = −log10[Ca] (mol/L),
//     pAlk = −log10(total alkalinity, eq/L); K from the ASTM D4582 chart
//     curve fit (USBR MS-2016 eqs. 13–14, T in °C):
//       I < 1.2: K = 2.022·exp((ln I + 7.544)²/102.6) − 0.0002·T² + 0.00097·T + 0.262
//       I ≥ 1.2: K = −0.1·I − 0.0002·T² − 0.00097·T + 3.887
//   Oddo–Tomson (1994), SPE Production & Facilities 9(1) 47–54; T in °F,
//   P in psia, concentrations and I in mol/L:
//     calcite (pH known):
//       SI = log10([Ca][HCO3]) + pH − 2.76 + 9.88e-3·T + 0.61e-6·T² − 3.03e-5·P − 2.348·√I + 0.77·I
//     sulphates: SI = log10([Me][SO4]) + A + B·T + C·T² + D·P + E·√I + F·I + G·√I·T
//       mineral      A      B          C          D          E       F      G
//       gypsum       3.47   1.8e-3     2.5e-6    −5.9e-5    −1.13   0.37   −2.0e-3
//       anhydrite    2.52   9.98e-3   −0.97e-6   −3.07e-5   −1.09   0.50   −3.3e-3
//       celestite    6.11   2.0e-3     6.4e-6    −4.6e-5    −1.89   0.67   −1.9e-3
//       barite      10.03  −4.8e-3    11.4e-6    −4.8e-5    −2.62   0.89   −2.0e-3
//     (coefficient table as reproduced in Mathematical Modelling of
//      Engineering Problems 11(9), 2024, Table 9.) Valid 32–392 °F,
//      14.7–20,000 psia, I up to about 6 mol/L.
//   Verdicts: SI ≤ 0 ✓ undersaturated; 0 < SI ≤ 0.5 ⚠ marginal / slight
//   tendency; SI > 0.5 ✗ scale likely (common oilfield screening bands).
//
// PUBLIC API (window.*)
//   renderScale(body), calcScale()
//   WTS_scale_compute(input) → {ok, ions, I, tds, cb, lsi, sdi, si, curve, …} or {ok:false, errors, bad}
//   WTS_scale_oddoTomson(mineral, {ca, sr, ba, so4, hco3 (mol/L), ph, t °F, p psia, I}) → SI
//
// STATE  WTS_state.scale = {I, tds, cbPct, lsi, sdi, si:{calcite,barite,celestite,gypsum,anhydrite}, ts, result}
// Registers window.WTS_calcRegistry.scale (group "Fluid & Field Calcs").
// ════════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    var G = (typeof window !== 'undefined') ? window : globalThis;

    // Ions: molar mass g/mol (IUPAC 2013 atomic weights) and charge.
    var IONS = [
        { k: 'na', name: 'Sodium, Na⁺', mw: 22.990, z: 1 },
        { k: 'k', name: 'Potassium, K⁺', mw: 39.098, z: 1 },
        { k: 'ca', name: 'Calcium, Ca²⁺', mw: 40.078, z: 2 },
        { k: 'mg', name: 'Magnesium, Mg²⁺', mw: 24.305, z: 2 },
        { k: 'ba', name: 'Barium, Ba²⁺', mw: 137.327, z: 2 },
        { k: 'sr', name: 'Strontium, Sr²⁺', mw: 87.62, z: 2 },
        { k: 'fe', name: 'Iron, Fe²⁺', mw: 55.845, z: 2 },
        { k: 'cl', name: 'Chloride, Cl⁻', mw: 35.453, z: -1 },
        { k: 'so4', name: 'Sulphate, SO4²⁻', mw: 96.06, z: -2 },
        { k: 'hco3', name: 'Bicarbonate, HCO3⁻', mw: 61.017, z: -1 },
        { k: 'co3', name: 'Carbonate, CO3²⁻', mw: 60.009, z: -2 }
    ];
    var CACO3 = 100.087;
    var OT = {
        gypsum: [3.47, 1.8e-3, 2.5e-6, -5.9e-5, -1.13, 0.37, -2.0e-3],
        anhydrite: [2.52, 9.98e-3, -0.97e-6, -3.07e-5, -1.09, 0.50, -3.3e-3],
        celestite: [6.11, 2.0e-3, 6.4e-6, -4.6e-5, -1.89, 0.67, -1.9e-3],
        barite: [10.03, -4.8e-3, 11.4e-6, -4.8e-5, -2.62, 0.89, -2.0e-3]
    };
    var MINERALS = [
        { k: 'calcite', name: 'Calcite, CaCO3' },
        { k: 'barite', name: 'Barite, BaSO4' },
        { k: 'celestite', name: 'Celestite, SrSO4' },
        { k: 'gypsum', name: 'Gypsum, CaSO4·2H2O' },
        { k: 'anhydrite', name: 'Anhydrite, CaSO4' }
    ];
    var SI_WARN = 0, SI_BAD = 0.5;

    function oddoTomson(min, c) {
        var T = c.t, P = c.p, I = c.I, sI = Math.sqrt(I);
        if (min === 'calcite') {
            if (!(c.ca > 0 && c.hco3 > 0)) return null;
            return Math.log10(c.ca * c.hco3) + c.ph - 2.76 + 9.88e-3 * T + 0.61e-6 * T * T - 3.03e-5 * P - 2.348 * sI + 0.77 * I;
        }
        var k = OT[min]; if (!k) return null;
        var me = min === 'barite' ? c.ba : min === 'celestite' ? c.sr : c.ca;
        if (!(me > 0 && c.so4 > 0)) return null;
        return Math.log10(me * c.so4) + k[0] + k[1] * T + k[2] * T * T + k[3] * P + k[4] * sI + k[5] * I + k[6] * sI * T;
    }

    function _fin(x) { return typeof x === 'number' && isFinite(x); }

    // input = {na,k,ca,mg,ba,sr,fe,cl,so4,hco3,co3 mg/L (blank → 0), ph, tds mg/L (blank → sum of ions),
    //          t °F, p psia}
    function compute(input) {
        var i = input || {}, errors = [], bad = [];
        function need(ok, key, msg) { if (!ok) { errors.push(msg); bad.push(key); } return ok; }
        var mg = {};
        IONS.forEach(function (ion) {
            var v = i[ion.k];
            v = (v == null || v === '' || (typeof v === 'number' && isNaN(v))) ? 0 : Number(v);
            mg[ion.k] = v;
            need(_fin(v) && v >= 0 && v <= 400000, ion.k, ion.name + ' must be between 0 and 400,000 mg/L.');
        });
        var ph = Number(i.ph), t = Number(i.t), p = Number(i.p);
        var tdsIn = (i.tds == null || i.tds === '' || (typeof i.tds === 'number' && isNaN(i.tds))) ? null : Number(i.tds);
        need(_fin(ph) && ph >= 3 && ph <= 11, 'ph', 'pH must be between 3 and 11.');
        need(_fin(t) && t >= 32 && t <= 392, 't', 'Temperature must be between 32 and 392 °F.');
        need(_fin(p) && p >= 14.7 && p <= 20000, 'p', 'Pressure must be between 14.7 and 20,000 psia.');
        if (tdsIn != null) need(_fin(tdsIn) && tdsIn > 0 && tdsIn <= 500000, 'tds', 'TDS must be above 0 and no more than 500,000 mg/L, or blank.');
        if (!errors.length) need(mg.ca > 0, 'ca', 'Calcium is needed for the carbonate and sulphate indices.');
        if (!errors.length) need(mg.hco3 + mg.co3 > 0, 'hco3', 'Enter bicarbonate or carbonate alkalinity.');
        if (errors.length) return { ok: false, errors: errors, bad: bad };

        var ions = [], c = {}, cat = 0, an = 0, I2 = 0, sum = 0;
        IONS.forEach(function (ion) {
            var m = mg[ion.k] / (1000 * ion.mw), meq = mg[ion.k] * Math.abs(ion.z) / ion.mw;
            c[ion.k] = m; sum += mg[ion.k]; I2 += m * ion.z * ion.z;
            if (ion.z > 0) cat += meq; else an += meq;
            ions.push({ k: ion.k, name: ion.name, mgL: mg[ion.k], molL: m, meqL: meq, z: ion.z });
        });
        var I = I2 / 2;
        var cbPct = (cat + an) > 0 ? (cat - an) / (cat + an) * 100 : 0;
        var tds = tdsIn != null ? tdsIn : sum;
        var tK = (t - 32) / 1.8 + 273.15, tC = tK - 273.15;
        // Alkalinity: HCO3 + 2·CO3 in eq/L; as CaCO3 mg/L = eq/L × 50,043.5
        var alkEq = c.hco3 + 2 * c.co3;
        var caCaCO3 = c.ca * CACO3 * 1000, alkCaCO3 = alkEq * CACO3 / 2 * 1000;
        // Langelier (Carrier)
        var A = (Math.log10(tds) - 1) / 10, B = -13.12 * Math.log10(tK) + 34.55;
        var C = Math.log10(caCaCO3) - 0.4, D = Math.log10(alkCaCO3);
        var pHsL = 9.3 + A + B - (C + D);
        // Stiff–Davis (ASTM D4582 fit, T °C)
        var K = I < 1.2 ? 2.022 * Math.exp(Math.pow(Math.log(I) + 7.544, 2) / 102.6) - 0.0002 * tC * tC + 0.00097 * tC + 0.262
            : -0.1 * I - 0.0002 * tC * tC - 0.00097 * tC + 3.887;
        var pCa = -Math.log10(c.ca), pAlk = -Math.log10(alkEq);
        var pHsS = pCa + pAlk + K;
        // Oddo–Tomson at T, P
        var cond = { ca: c.ca, ba: c.ba, sr: c.sr, so4: c.so4, hco3: c.hco3, ph: ph, t: t, p: p, I: I };
        var si = {};
        MINERALS.forEach(function (m) { si[m.k] = oddoTomson(m.k, cond); });
        // SI vs temperature at the same pressure
        var tLo = Math.min(50, Math.floor(t / 10) * 10), tHi = Math.max(300, Math.ceil(t / 10) * 10), curve = [];
        for (var n = 0; n <= 25; n++) {
            var tt = tLo + (tHi - tLo) * n / 25, row = { t: tt };
            MINERALS.forEach(function (m) { row[m.k] = oddoTomson(m.k, { ca: c.ca, ba: c.ba, sr: c.sr, so4: c.so4, hco3: c.hco3, ph: ph, t: tt, p: p, I: I }); });
            curve.push(row);
        }
        var table = [];
        for (var tt2 = 50; tt2 <= 350; tt2 += 50) {
            var r2 = { t: tt2 };
            MINERALS.forEach(function (m) { r2[m.k] = oddoTomson(m.k, { ca: c.ca, ba: c.ba, sr: c.sr, so4: c.so4, hco3: c.hco3, ph: ph, t: tt2, p: p, I: I }); });
            table.push(r2);
        }
        function band(v) { return v == null ? 'none' : v > SI_BAD ? 'bad' : v > SI_WARN ? 'warn' : 'ok'; }
        var verdicts = {};
        MINERALS.forEach(function (m) { verdicts[m.k] = band(si[m.k]); });
        return {
            ok: true, ions: ions, molar: c, cations_meq: cat, anions_meq: an, cbPct: cbPct,
            cb: Math.abs(cbPct) <= 5 ? 'ok' : Math.abs(cbPct) <= 10 ? 'warn' : 'bad',
            sumIons: sum, tds: tds, tdsMeasured: tdsIn != null, I: I, t: t, p: p, ph: ph, tC: tC,
            alkEq: alkEq, caCaCO3: caCaCO3, alkCaCO3: alkCaCO3,
            lsi: { A: A, B: B, C: C, D: D, pHs: pHsL, value: ph - pHsL, valid: tds <= 10000, band: band(ph - pHsL) },
            sdi: { K: K, pCa: pCa, pAlk: pAlk, pHs: pHsS, value: ph - pHsS, band: band(ph - pHsS), tempOk: tC >= 0 && tC <= 90 },
            si: si, verdicts: verdicts, curve: curve, table: table
        };
    }
    G.WTS_scale_compute = compute;
    G.WTS_scale_oddoTomson = oddoTomson;

    // ── Page ─────────────────────────────────────────────────────────
    var TITLE = 'Scale & Water Analysis';
    var SUB = 'Charge balance, ionic strength, Langelier and Stiff–Davis indices, Oddo–Tomson saturation indices for calcite, barite, celestite, gypsum and anhydrite vs temperature and pressure';
    var UNITS = { sc_t: 'temperature', sc_p: 'pressure' };

    function _byId(id) { return (typeof document !== 'undefined' && document.getElementById) ? document.getElementById(id) : null; }
    function _num(id) { var e = _byId(id); if (!e) return NaN; var s = String(e.value).trim(); return s === '' ? NaN : parseFloat(s); }
    function _fmt(v, d) {
        if (v == null || !isFinite(v)) return '—';
        return (G.WTS_fmtNum ? G.WTS_fmtNum(v, 0, (d == null ? 2 : d)) : Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: (d == null ? 2 : d) }));
    }
    function _fx(v, d) {
        if (v == null || !isFinite(v)) return '—';
        return (G.WTS_fmtNum ? G.WTS_fmtNum(v, d, d) : Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
    }
    function _sci(v) { return (v == null || !isFinite(v)) ? '—' : v === 0 ? '0' : Number(v).toExponential(3); }
    function _metric() { var U = G.WTS_units; return !!(U && U.getSystem && U.getSystem() === 'metric'); }
    function _u(v, cat, d, impLabel, dMet) {
        var U = G.WTS_units;
        if (_metric() && U.format) { var f = U.format(v, cat); return _fmt(f.value, dMet == null ? d : dMet) + ' ' + f.label; }
        return _fmt(v, d) + ' ' + impLabel;
    }
    function _disp(v, cat) { var U = G.WTS_units; return (_metric() && U.format) ? U.format(v, cat).value : v; }
    function _lab(cat, imp) { var U = G.WTS_units; return (_metric() && U.format) ? U.format(1, cat).label : imp; }
    function _tag(map) { var U = G.WTS_units; if (!U || !U.tagInput) return; for (var id in map) U.tagInput(id, map[id]); }
    function _canon(fn) { var U = G.WTS_units; return (U && U.runCanonical) ? U.runCanonical(fn) : fn(); }
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
    var MSG = {
        t: function () { return 'Temperature must be between ' + _u(32, 'temperature', 0, '°F') + ' and ' + _u(392, 'temperature', 0, '°F') + '.'; },
        p: function () { return 'Pressure must be between ' + _u(14.7, 'pressure', 1, 'psia') + ' and ' + _u(20000, 'pressure', 0, 'psia') + '.'; }
    };
    function _verdict(nm, v, band) {
        if (band === 'none') return '';
        var s = nm + ' SI ' + _fx(v, 2);
        if (band === 'bad') return _bad(s + ': scale likely.');
        if (band === 'warn') return _warn(s + ': slightly supersaturated, marginal scaling tendency.');
        return _ok(s + ': undersaturated, no scaling tendency.');
    }

    function _paint(r) {
        var res = _byId('sc_res');
        if (!res) return;
        if (!r.ok) {
            var items = '', seen = {};
            r.bad.forEach(function (k, j) {
                var el = _byId('sc_' + k); if (el && el.classList) el.classList.add('input-err');
                if (seen[k]) return; seen[k] = 1;
                items += '<li>' + (MSG[k] ? MSG[k]() : r.errors[j]) + '</li>';
            });
            res.innerHTML = '<div class="val-error"><strong>Please fix the following:</strong><ul>' + items + '</ul></div>';
            res.setAttribute('data-done', '1');
            return;
        }
        var h = '';
        // Water analysis
        var cbv = r.cb === 'ok' ? _ok('Charge balance ' + _fx(r.cbPct, 2) + ' %: analysis acceptable (within ±5 %).')
            : r.cb === 'warn' ? _warn('Charge balance ' + _fx(r.cbPct, 2) + ' %: questionable (5 to 10 %). Check the analysis.')
                : _bad('Charge balance ' + _fx(r.cbPct, 2) + ' %: poor (above 10 %). Resample or re-analyse before relying on the indices.');
        h += '<div class="rbox"><div class="rbox-title">Water Analysis</div>' +
            _tbl(['Ion', 'mg/L', 'mol/L', 'meq/L'], r.ions.map(function (x) { return [x.name, _fmt(x.mgL, 1), _sci(x.molL), _fmt(x.meqL, 3)]; })) +
            _row('Sum of cations', _fmt(r.cations_meq, 2) + ' meq/L') +
            _row('Sum of anions', _fmt(r.anions_meq, 2) + ' meq/L') +
            _row('Charge balance', _fx(r.cbPct, 2) + ' %') +
            _row('Sum of ions', _fmt(r.sumIons, 0) + ' mg/L') +
            _row('TDS used', _fmt(r.tds, 0) + ' mg/L' + (r.tdsMeasured ? ' (measured)' : ' (sum of ions)')) +
            _row('Ionic strength', _fx(r.I, 4) + ' mol/L') +
            _row('Total alkalinity as CaCO3', _fmt(r.alkCaCO3, 1) + ' mg/L') +
            cbv + '</div>';
        // Carbonate indices
        var L = r.lsi, S = r.sdi;
        h += '<div class="rbox"><div class="rbox-title">Calcium Carbonate Indices</div>' +
            _row('Langelier saturation pH, pHs', _fx(L.pHs, 2)) +
            _row('Langelier index, LSI', _fx(L.value, 2)) +
            _row('Stiff–Davis K', _fx(S.K, 3)) +
            _row('Stiff–Davis saturation pH', _fx(S.pHs, 2)) +
            _row('Stiff–Davis index, S&DSI', _fx(S.value, 2)) +
            (L.valid ? _verdict('Langelier', L.value, L.band) : _warn('TDS is above 10,000 mg/L: the Langelier index is outside its range. Use Stiff–Davis or Oddo–Tomson.')) +
            _verdict('Stiff–Davis', S.value, S.band) +
            (S.tempOk ? '' : _warn('Temperature is outside the 0 to 90 °C range of the Stiff–Davis chart; K is extrapolated.')) +
            _note('Both indices use the measured pH and the analysis temperature. LSI by the Carrier (1965) form of ASTM D3739; ' +
                'Stiff–Davis K from the ASTM D4582 chart fit. Positive values mean calcium carbonate tends to deposit; ' +
                'values below −0.5 mean the water is aggressive to carbonate films.') +
            '</div>';
        // Oddo–Tomson
        var v = '';
        MINERALS.forEach(function (m) {
            if (r.si[m.k] == null) v += '<div>' + m.name + ': not computed, an ion is zero.</div>';
            else v += _verdict(m.name, r.si[m.k], r.verdicts[m.k]);
        });
        h += '<div class="rbox"><div class="rbox-title">Oddo–Tomson Saturation Indices</div>' +
            _row('Conditions', _u(r.t, 'temperature', 0, '°F') + ', ' + _u(r.p, 'pressure', 0, 'psia')) +
            MINERALS.map(function (m) { return _row(m.name, r.si[m.k] == null ? '—' : _fx(r.si[m.k], 2)); }).join('') +
            v +
            _note('SI = log10(ion product / conditional solubility product), Oddo & Tomson (1994). SI 0 is saturation; ' +
                'SI above 0.5 is taken as scale likely. Calcite uses the measured pH; the pH at downhole conditions is usually ' +
                'lower than a degassed surface sample, so the calcite SI is conservative. Gypsum and anhydrite: the stable ' +
                'calcium sulphate is gypsum at low temperature and anhydrite at high temperature; watch the larger SI.') +
            '</div>';
        // SI vs temperature
        var tl = _lab('temperature', '°F');
        h += '<div class="rbox"><div class="rbox-title">Saturation Index vs Temperature</div>' +
            _tbl(['Temperature (' + tl + ')'].concat(MINERALS.map(function (m) { return m.name; })), r.table.map(function (row) {
                return [_fmt(_disp(row.t, 'temperature'), 0)].concat(MINERALS.map(function (m) { return row[m.k] == null ? '—' : _fx(row[m.k], 2); }));
            })) +
            '<div class="chart-wrap"><canvas id="sc_chart" width="600" height="340"></canvas></div>' +
            _note('Each row keeps the water composition, pH and pressure (' + _u(r.p, 'pressure', 0, 'psia') + ') and changes the temperature only.') +
            '</div>';
        res.innerHTML = h;
        _chart(r);
        res.setAttribute('data-done', '1');
    }

    function _chart(r) {
        var cv = _byId('sc_chart');
        var draw = (typeof drawLineChart === 'function') ? drawLineChart : (typeof G.drawLineChart === 'function' ? G.drawLineChart : null); // eslint-disable-line no-undef
        if (!cv || !draw || !cv.getContext) return;
        var colors = { calcite: '#f0883e', barite: '#58a6ff', celestite: '#3fb950', gypsum: '#bc8cff', anhydrite: '#d29922' };
        var ds = [];
        MINERALS.forEach(function (m) {
            if (r.si[m.k] == null) return;
            ds.push({ label: m.name, color: colors[m.k], points: false, width: 2, data: r.curve.map(function (c) { return { x: _disp(c.t, 'temperature'), y: c[m.k] }; }) });
        });
        var t0 = r.curve[0].t, t1 = r.curve[r.curve.length - 1].t;
        ds.push({ label: 'SI = 0', color: '#8b949e', dash: [4, 4], points: false, width: 1, data: [{ x: _disp(t0, 'temperature'), y: 0 }, { x: _disp(t1, 'temperature'), y: 0 }] });
        try { draw(cv, ds, { xLabel: 'Temperature (' + _lab('temperature', '°F') + ')', yLabel: 'Saturation index', xDec: 0, yDec: 1 }); } catch (e) { /* decorative */ }
    }

    function _read() {
        var o = { ph: _num('sc_ph'), tds: _num('sc_tds'), t: _num('sc_t'), p: _num('sc_p') };
        IONS.forEach(function (ion) { o[ion.k] = _num('sc_' + ion.k); });
        return o;
    }
    function _calcImpl() {
        var root = _byId('sc_root');
        if (!root) return null;
        var ins = root.querySelectorAll ? root.querySelectorAll('input,select') : [];
        for (var n = 0; n < ins.length; n++) if (ins[n].classList) ins[n].classList.remove('input-err');
        var r = compute(_read());
        _paint(r);
        G.WTS_state = G.WTS_state || {};
        G.WTS_state.scale = {
            I: r.ok ? r.I : null, tds: r.ok ? r.tds : null, cbPct: r.ok ? r.cbPct : null,
            lsi: r.ok ? r.lsi.value : null, sdi: r.ok ? r.sdi.value : null,
            si: r.ok ? r.si : null, ts: Date.now(), result: r
        };
        return r;
    }
    G.calcScale = function () { return _canon(_calcImpl); };

    var DEF = { na: 30000, k: 400, ca: 2500, mg: 400, ba: 50, sr: 300, fe: 10, cl: 52000, so4: 20, hco3: 600, co3: 0 };
    function render(body) {
        if (!body) return;
        var t = _byId('pgTitle'), s = _byId('pgSub');
        if (t) t.textContent = TITLE;
        if (s) s.textContent = SUB;
        var ions = '';
        IONS.forEach(function (ion) { ions += _fg('sc_' + ion.k, ion.name + ', mg/L', String(DEF[ion.k]), ' min="0"'); });
        body.innerHTML =
            '<div id="sc_root"><div class="cols-2">' +
            '<div>' +
            '<div class="card"><div class="card-title">Water Analysis</div><div class="fg">' + ions +
            _fg('sc_ph', 'pH, measured', '6.8', ' min="0" max="14"') +
            _fg('sc_tds', 'TDS measured, blank = sum of ions, mg/L', '', ' min="0"') +
            '</div></div>' +
            '<div class="card"><div class="card-title">Conditions</div><div class="fg">' +
            _fg('sc_t', 'Temperature (°F)', '180') +
            _fg('sc_p', 'Pressure (psia)', '2000', ' min="0"') +
            '</div><div class="btn-row"><button class="btn btn-primary" id="sc_calc" onclick="calcScale()">Calculate</button></div></div>' +
            '</div>' +
            '<div><div id="sc_res"></div></div>' +
            '</div></div>';
        _tag(UNITS);
        var root = _byId('sc_root');
        if (root && root.addEventListener) {
            root.addEventListener('change', function (e) {
                if (e && e.target && /^sc_/.test(e.target.id || '')) G.calcScale();
            });
        }
        G.calcScale();
    }
    G.renderScale = render;

    G.WTS_calcRegistry = G.WTS_calcRegistry || {};
    G.WTS_calcRegistry.scale = {
        key: 'scale',
        title: TITLE,
        sub: SUB,
        group: 'Fluid & Field Calcs',
        icon: '&#9878;',
        badge: 'Chemistry',
        bc: 'dc-b-blue',
        desc: 'Water analysis QC and scaling tendency: charge balance, ionic strength, LSI, Stiff–Davis and Oddo–Tomson SI for calcite, barite, celestite, gypsum and anhydrite.',
        render: function (body) { return G.renderScale(body); }
    };

    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('wts:unit-system-changed', function () {
            var r = _byId('sc_res');
            if (r && r.getAttribute && r.getAttribute('data-done') === '1') G.calcScale();
        });
    }
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var fails = [], n = 0;
    function near(a, b, tol, what) { n++; if (!(isFinite(a) && Math.abs(a - b) <= tol)) fails.push(what + ': got ' + a + ', expected ' + b); }
    // USBR MS-2016 worked example (Na 93, K 9, Ca 196.3, Mg 120.4, Cl 1.9, HCO3 169.2, SO4 953 mg/L, pH 7.5, 59 °F)
    var r = G.WTS_scale_compute({ na: 93, k: 9, ca: 196.3, mg: 120.4, ba: 0.1426, sr: 0.12, cl: 1.9, hco3: 169.2, so4: 953, ph: 7.5, tds: 1566.56, t: 59, p: 14.7 });
    near(r.I, 0.0433, 0.0005, 'USBR ionic strength');
    near(r.lsi.value, 0.18, 0.08, 'USBR LSI');
    if (fails.length) {
        if (typeof console !== 'undefined') console.error('[scale self-test] ' + fails.length + '/' + n + ' FAILED:\n  ' + fails.join('\n  '));
        if (typeof window === 'undefined' && typeof process !== 'undefined') process.exitCode = 1;
    } else if (typeof console !== 'undefined') {
        console.log('[scale self-test] ' + n + '/' + n + ' checks passed');
    }
})();
