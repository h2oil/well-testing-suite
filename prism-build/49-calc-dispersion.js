// ════════════════════════════════════════════════════════════════════
// WTS — Round-9 plug-in calculator — SO2 / H2S Dispersion Screening (dispersion)
//
// PURPOSE
//   Screening estimate of the ground-level, plume-centreline concentration of
//   SO2 (from flaring sour gas) and H2S (unburned, or a cold vent / leak)
//   downwind of a flare tip or vent, against IDLH / STEL / TWA limits.
//   SCREENING ONLY — NOT A SUBSTITUTE FOR A SITE DISPERSION STUDY.
//
// METHOD (every formula checked against the reference in brackets)
//   1. Gaussian plume, ground-reflected, centreline at ground level
//        C(x,0,0) = Q / (π·u·σy·σz) · exp(−H² / (2·σz²))            [Turner 1970, eq. 3.1 with y = z = 0]
//   2. Briggs (1973) open-country (rural) dispersion coefficients, x in m
//      (100 m < x < 10 km), as tabulated by Hanna, Briggs & Hosker (1982)
//      and in the EPA ISC3 user guide (EPA-454/B-95-003b, Table 1-1 note):
//        class  σy                        σz
//        A      0.22x(1+0.0001x)^-1/2     0.20x
//        B      0.16x(1+0.0001x)^-1/2     0.12x
//        C      0.11x(1+0.0001x)^-1/2     0.08x(1+0.0002x)^-1/2
//        D      0.08x(1+0.0001x)^-1/2     0.06x(1+0.0015x)^-1/2
//        E      0.06x(1+0.0001x)^-1/2     0.03x(1+0.0003x)^-1
//        F      0.04x(1+0.0001x)^-1/2     0.016x(1+0.0003x)^-1
//   3. Wind at the release height from the 10 m wind by the rural power law
//      u = u10·(h/10)^p, p = 0.07, 0.07, 0.10, 0.15, 0.35, 0.55 for A–F,
//      h not below 10 m, u not below 1 m/s                              [EPA ISC3 / SCREEN3 user guides]
//   4. Flare buoyancy flux from the net (sensible) heat release
//        F = g·Q_H / (π·ρa·cp·Ta) = 8.81×10⁻⁶·Q_H [W]  (ρa·Ta = p/R_air)
//      with Q_H = (1 − radiant fraction)·total heat release. With the
//      default 55 % radiant loss this is F = 1.66×10⁻⁵·H [cal/s], the EPA
//      SCREEN3 flare formula                                               [Briggs 1975; EPA-454/B-95-004 §2.1.3]
//   5. Briggs buoyant plume rise
//        neutral / unstable (A–D): Δh = 21.425·F^¾/u,  x_f = 49·F^⅝     (F < 55)
//                                  Δh = 38.71·F^⅗/u,   x_f = 119·F^⅖    (F ≥ 55)
//        stable (E, F): s = g/Ta·dθ/dz (0.020 K/m E, 0.035 K/m F)
//                       Δh = 2.6·(F/(u·s))^⅓, x_f = 2.0715·u/√s, taken as
//                       the smaller of the stable and neutral values       [EPA ISC3 user guide §1.1.4]
//        transitional rise before x_f (Briggs "2/3 law"):
//                       Δh(x) = 1.6·F^⅓·x^⅔/u, capped at the final rise    [Briggs 1975]
//      Gradual rise is used at every distance (lower plume near the flare =
//      higher ground concentration; the conservative choice).
//   6. Effective height H(x) = flare tip / vent height + Δh(x). The flame
//      length that SCREEN3 adds is not included (conservative).
//   7. ppm = mg/m³ × 24.45 / MW (25 °C, 1 atm, the NIOSH / ACGIH basis).
//
// EXPOSURE LIMITS (defaults, editable; ppm)
//   H2S : IDLH 100 (NIOSH); STEL 10 = NIOSH REL ceiling (10 min);
//         TWA 1 = ACGIH TLV-TWA (2010)                     [NIOSH Pocket Guide; ACGIH TLVs]
//   SO2 : IDLH 100 (NIOSH); STEL 5 (NIOSH REL); TWA 2 (NIOSH REL)
//
// UNITS
//   Field units on the page (lb/hr, MMBtu/hr, ft, mph, °F); the plume maths
//   runs in SI internally (the published σ and rise formulas are in metres).
//
// PUBLIC API (window.*)
//   renderDispersion(body), calcDispersion()
//   WTS_dispersion_compute(input) → {ok, …} or {ok:false, errors, bad}
//   WTS_dispersion_sigma(cls, x_m) → {sy, sz} (m)
//   WTS_dispersionUseFlare() / WTS_dispersionUseH2S()  copy release rates
//     from WTS_state.flareghg / WTS_state.h2sroe
//
// STATE
//   WTS_state.dispersion = {maxSO2_ppm, maxH2S_ppm, xMax_ft, hEff_ft, rise_ft,
//                           so2Idlh_ft, h2sIdlh_ft, ts, result}
// Registers window.WTS_calcRegistry.dispersion (group "Flare & Relief").
// ════════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    var G = (typeof window !== 'undefined') ? window : globalThis;

    // ── Constants ────────────────────────────────────────────────────
    var FT = 0.3048, MPH = 0.44704, LBHR_GS = 453.59237 / 3600;
    var MMBTUHR_W = 1.05505585262e9 / 3600;          // W per MMBtu/hr
    var GRAV = 9.80665, CP = 1004, R_AIR = 287.05, P_ATM = 101325;
    var F_COEF = GRAV / (Math.PI * CP * P_ATM / R_AIR); // 8.81e-6 m⁴/s³ per W
    var VM25 = 24.45;                                 // L/mol at 25 °C, 1 atm
    var MW = { so2: 64.064, h2s: 34.081 };
    var CLASSES = ['A', 'B', 'C', 'D', 'E', 'F'];
    var P_EXP = { A: 0.07, B: 0.07, C: 0.10, D: 0.15, E: 0.35, F: 0.55 };
    var DTHETA = { E: 0.020, F: 0.035 };
    var X_MIN = 10, X_MAX = 10000;                    // m, curve range
    var DEF_LIMITS = { h2sIdlh: 100, h2sStel: 10, h2sTwa: 1, so2Idlh: 100, so2Stel: 5, so2Twa: 2 };
    var TABLE_FT = [100, 250, 500, 1000, 2000, 3000, 5000, 10000, 20000, 32800];

    function sigma(cls, x) {
        var sy, sz, r = 1 / Math.sqrt(1 + 0.0001 * x);
        switch (cls) {
            case 'A': sy = 0.22 * x * r; sz = 0.20 * x; break;
            case 'B': sy = 0.16 * x * r; sz = 0.12 * x; break;
            case 'C': sy = 0.11 * x * r; sz = 0.08 * x / Math.sqrt(1 + 0.0002 * x); break;
            case 'D': sy = 0.08 * x * r; sz = 0.06 * x / Math.sqrt(1 + 0.0015 * x); break;
            case 'E': sy = 0.06 * x * r; sz = 0.03 * x / (1 + 0.0003 * x); break;
            default: sy = 0.04 * x * r; sz = 0.016 * x / (1 + 0.0003 * x); break;
        }
        return { sy: sy, sz: sz };
    }

    // ── Helpers ─────────────────────────────────────────────────────
    function _byId(id) { return (typeof document !== 'undefined' && document.getElementById) ? document.getElementById(id) : null; }
    function _num(id) { var e = _byId(id); if (!e) return NaN; var s = String(e.value).trim(); return s === '' ? NaN : parseFloat(s); }
    function _str(id) { var e = _byId(id); return e ? String(e.value) : ''; }
    function _fmt(v, d) {
        if (v == null || !isFinite(v)) return '—';
        return (G.WTS_fmtNum ? G.WTS_fmtNum(v, 0, (d == null ? 2 : d)) : Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: (d == null ? 2 : d) }));
    }
    function _sig(v) {   // 3 significant figures for concentrations spanning decades
        if (v == null || !isFinite(v)) return '—';
        if (v === 0) return '0';
        var a = Math.abs(v), d = a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : Math.min(6, 2 - Math.floor(Math.log10(a)));
        return _fmt(v, d);
    }
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
    function _fin(x) { return typeof x === 'number' && isFinite(x); }

    // ── Pure compute ─────────────────────────────────────────────────
    // input = {src:'flare'|'vent', so2 lb/hr, h2s lb/hr, heat MMBtu/hr (total), frad %,
    //          hs ft (flare tip / vent height), u10 mph (10 m wind), cls 'A'..'F', ta °F,
    //          limits:{h2sIdlh,h2sStel,h2sTwa,so2Idlh,so2Stel,so2Twa} ppm (missing → defaults)}
    function compute(input) {
        var i = input || {}, errors = [], bad = [];
        function need(ok, key, msg) { if (!ok) { errors.push(msg); bad.push(key); } return ok; }
        var src = i.src === 'vent' ? 'vent' : 'flare';
        var so2 = Number(i.so2), h2s = Number(i.h2s), heat = Number(i.heat), frad = Number(i.frad);
        var hs = Number(i.hs), u10 = Number(i.u10), ta = Number(i.ta);
        var cls = String(i.cls || 'D').toUpperCase();
        var lim = {}, L = i.limits || {};
        Object.keys(DEF_LIMITS).forEach(function (k) {
            var v = L[k];
            lim[k] = (v == null || v === '' || (typeof v === 'number' && isNaN(v))) ? DEF_LIMITS[k] : Number(v);
        });
        if (src === 'vent') { if (!_fin(so2)) so2 = 0; if (!_fin(heat)) heat = 0; }
        need(_fin(so2) && so2 >= 0 && so2 <= 1e6, 'so2', 'SO2 release rate must be between 0 and 1,000,000 lb/hr.');
        need(_fin(h2s) && h2s >= 0 && h2s <= 1e6, 'h2s', 'H2S release rate must be between 0 and 1,000,000 lb/hr.');
        if (_fin(so2) && _fin(h2s) && so2 >= 0 && h2s >= 0) need(so2 + h2s > 0, 'so2', 'Enter an SO2 or H2S release rate above 0.');
        if (src === 'flare') {
            need(_fin(heat) && heat > 0 && heat <= 1e5, 'heat', 'Flare heat release must be above 0 and no more than 100,000 MMBtu/hr.');
            need(_fin(frad) && frad >= 0 && frad < 100, 'frad', 'Radiant heat fraction must be 0 or more and below 100 %.');
        }
        need(_fin(hs) && hs >= 0 && hs <= 1000, 'hs', 'Release height must be between 0 and 1,000 ft.');
        need(_fin(u10) && u10 >= 1 && u10 <= 100, 'u10', 'Wind speed at 10 m must be between 1 and 100 mph.');
        need(CLASSES.indexOf(cls) !== -1, 'cls', 'Select a stability class A to F.');
        need(_fin(ta) && ta >= -60 && ta <= 140, 'ta', 'Ambient temperature must be between -60 and 140 °F.');
        Object.keys(lim).forEach(function (k) { need(_fin(lim[k]) && lim[k] > 0 && lim[k] <= 1e5, k, 'Exposure limits must be above 0 ppm.'); });
        if (errors.length) return { ok: false, errors: errors, bad: bad };

        var hsM = hs * FT, u10M = u10 * MPH, TaK = (ta - 32) / 1.8 + 273.15;
        var hRef = Math.max(hsM, 10);
        var u = Math.max(1, u10M * Math.pow(hRef / 10, P_EXP[cls]));
        // Plume rise
        var QH_W = 0, F = 0, dhF = 0, xf = 0, stableUsed = false;
        if (src === 'flare') {
            QH_W = heat * MMBTUHR_W * (1 - frad / 100);
            F = F_COEF * QH_W;
            if (F < 55) { dhF = 21.425 * Math.pow(F, 0.75) / u; xf = 49 * Math.pow(F, 0.625); }
            else { dhF = 38.71 * Math.pow(F, 0.6) / u; xf = 119 * Math.pow(F, 0.4); }
            if (cls === 'E' || cls === 'F') {
                var s = GRAV / TaK * DTHETA[cls];
                var dhS = 2.6 * Math.pow(F / (u * s), 1 / 3), xfS = 2.0715 * u / Math.sqrt(s);
                if (dhS < dhF) { dhF = dhS; xf = xfS; stableUsed = true; }
            }
        }
        function rise(x) { return F > 0 ? Math.min(dhF, 1.6 * Math.pow(F, 1 / 3) * Math.pow(x, 2 / 3) / u) : 0; }
        var qs = { so2: so2 * LBHR_GS, h2s: h2s * LBHR_GS };   // g/s
        // unit-release ground-level concentration, (g/m³) per (g/s)
        function chi1(x) {
            var sg = sigma(cls, x), H = hsM + rise(x);
            return Math.exp(-H * H / (2 * sg.sz * sg.sz)) / (Math.PI * u * sg.sy * sg.sz);
        }
        function ppm(gas, x) { return qs[gas] * chi1(x) * 1000 * VM25 / MW[gas]; }

        // Curve on a log grid 10 m … 10 km
        var N = 400, curve = [];
        for (var n = 0; n <= N; n++) {
            var x = X_MIN * Math.pow(X_MAX / X_MIN, n / N);
            curve.push({ x: x, so2: ppm('so2', x), h2s: ppm('h2s', x) });
        }
        function peak(gas) {
            var best = 0, k = 0;
            curve.forEach(function (c, j) { if (c[gas] > best) { best = c[gas]; k = j; } });
            // golden-section refinement between the neighbours
            var a = curve[Math.max(0, k - 1)].x, b = curve[Math.min(N, k + 1)].x;
            for (var it = 0; it < 60; it++) {
                var m1 = a + (b - a) * 0.382, m2 = a + (b - a) * 0.618;
                if (ppm(gas, m1) > ppm(gas, m2)) b = m2; else a = m1;
            }
            var xm = (a + b) / 2, v = ppm(gas, xm);
            return v >= best ? { x: xm, ppm: v } : { x: curve[k].x, ppm: best };
        }
        function crossing(gas, lo, hi, limit) {       // bisection on log x
            for (var it = 0; it < 60; it++) {
                var mid = Math.sqrt(lo * hi);
                if ((ppm(gas, mid) >= limit) === (ppm(gas, lo) >= limit)) lo = mid; else hi = mid;
            }
            return Math.sqrt(lo * hi);
        }
        function exceed(gas, limit) {
            if (!(qs[gas] > 0)) return { none: true, reached: false };
            var from = null, to = null, fromEdge = false, toEdge = false;
            for (var j = 0; j <= N; j++) {
                var over = curve[j][gas] >= limit;
                if (over && from == null) {
                    if (j === 0) { from = curve[0].x; fromEdge = true; }
                    else from = crossing(gas, curve[j - 1].x, curve[j].x, limit);
                }
                if (over) {
                    if (j === N) { to = curve[N].x; toEdge = true; }
                    else if (!(curve[j + 1][gas] >= limit)) to = crossing(gas, curve[j].x, curve[j + 1].x, limit);
                }
            }
            if (from == null) return { reached: false };
            return { reached: true, from_m: from, to_m: to, from_ft: from / FT, to_ft: to / FT, fromEdge: fromEdge, toEdge: toEdge, limit: limit };
        }
        var pk = { so2: so2 > 0 ? peak('so2') : null, h2s: h2s > 0 ? peak('h2s') : null };
        var ex = {
            so2: { idlh: exceed('so2', lim.so2Idlh), stel: exceed('so2', lim.so2Stel), twa: exceed('so2', lim.so2Twa) },
            h2s: { idlh: exceed('h2s', lim.h2sIdlh), stel: exceed('h2s', lim.h2sStel), twa: exceed('h2s', lim.h2sTwa) }
        };
        var table = TABLE_FT.map(function (xft) {
            var x = xft * FT, sg = sigma(cls, x), dh = rise(x);
            return { x_ft: xft, x_m: x, sy_m: sg.sy, sz_m: sg.sz, rise_m: dh, H_m: hsM + dh, so2: ppm('so2', x), h2s: ppm('h2s', x) };
        });
        var warn = [];
        var u10ms = u10M;
        if (cls === 'A' && u10ms > 3) warn.push('Class A is normally limited to 10 m winds below about 3 m/s (6.7 mph).');
        if (cls === 'B' && u10ms > 5) warn.push('Class B is normally limited to 10 m winds below about 5 m/s (11 mph).');
        if ((cls === 'E' || cls === 'F') && u10ms > 5) warn.push('Stable classes E and F normally occur only with 10 m winds below about 5 m/s (11 mph) at night.');
        return {
            ok: true, src: src, cls: cls, limits: lim,
            q_gs: qs, u_ms: u, u_mph: u / MPH, p: P_EXP[cls], ta_K: TaK,
            qh_W: QH_W, qh_MMBtuhr: QH_W / MMBTUHR_W, F: F,
            rise_m: dhF, rise_ft: dhF / FT, xf_m: xf, xf_ft: xf / FT, stableRise: stableUsed,
            hs_m: hsM, hEff_m: hsM + dhF, hEff_ft: (hsM + dhF) / FT,
            peak: pk, exceed: ex, table: table, curve: curve, warnings: warn,
            chi: function (gas, xm) { return ppm(gas, xm); }
        };
    }

    G.WTS_dispersion_compute = compute;
    G.WTS_dispersion_sigma = sigma;
    G.WTS_dispersion_limits = DEF_LIMITS;

    // ── Page ─────────────────────────────────────────────────────────
    var TITLE = 'SO2 / H2S Dispersion Screening';
    var SUB = 'Gaussian plume with Briggs rural dispersion and flare plume rise: ground-level SO2 and H2S vs distance against IDLH, STEL and TWA. Screening only';
    var UNITS = {
        ds_so2: 'massRate', ds_h2s: 'massRate', ds_heat: 'powerLarge', ds_frad: 'percent',
        ds_hs: 'length', ds_u10: 'windSpeed', ds_ta: 'temperature'
    };
    var IDS = {
        so2: 'ds_so2', h2s: 'ds_h2s', heat: 'ds_heat', frad: 'ds_frad', hs: 'ds_hs', u10: 'ds_u10', cls: 'ds_cls', ta: 'ds_ta',
        h2sIdlh: 'ds_lhi', h2sStel: 'ds_lhs', h2sTwa: 'ds_lht', so2Idlh: 'ds_lsi', so2Stel: 'ds_lss', so2Twa: 'ds_lst'
    };
    var MSG = {
        so2: function () { return 'SO2 release rate must be between 0 and ' + _u(1e6, 'massRate', 0, 'lb/hr') + '.'; },
        h2s: function () { return 'H2S release rate must be between 0 and ' + _u(1e6, 'massRate', 0, 'lb/hr') + '.'; },
        heat: function () { return 'Flare heat release must be above 0 and no more than ' + _u(1e5, 'powerLarge', 0, 'MMBtu/hr') + '.'; },
        hs: function () { return 'Release height must be between 0 and ' + _u(1000, 'length', 0, 'ft') + '.'; },
        u10: function () { return 'Wind speed at 10 m must be between ' + _u(1, 'windSpeed', 0, 'mph', 2) + ' and ' + _u(100, 'windSpeed', 0, 'mph', 1) + '.'; },
        ta: function () { return 'Ambient temperature must be between ' + _u(-60, 'temperature', 0, '°F') + ' and ' + _u(140, 'temperature', 0, '°F') + '.'; }
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
    var ftx = function (v) { return _u(v, 'length', 0, 'ft', 0); };

    function _exText(e) {
        if (e.none) return 'no release';
        if (!e.reached) return 'not reached';
        return (e.fromEdge ? 'from the source' : 'from ' + ftx(e.from_ft)) + ' to ' + (e.toEdge ? 'beyond ' : '') + ftx(e.to_ft);
    }

    function _paint(r) {
        var res = _byId('ds_res');
        if (!res) return;
        if (!r.ok) {
            var items = '', seen = {};
            r.bad.forEach(function (k, j) {
                var el = _byId(IDS[k]); if (el && el.classList) el.classList.add('input-err');
                if (seen[k]) return; seen[k] = 1;
                items += '<li>' + (MSG[k] ? MSG[k]() : r.errors[j]) + '</li>';
            });
            res.innerHTML = '<div class="val-error"><strong>Please fix the following:</strong><ul>' + items + '</ul></div>';
            res.setAttribute('data-done', '1');
            return;
        }
        var h = '';
        h += '<div class="rbox"><div class="rbox-title">Screening Only</div>' +
            _warn('Screening only, not a substitute for a site dispersion study. Flat open terrain, steady wind, no buildings, no inversion lid, no dense-gas slumping.') +
            '</div>';
        // Plume
        h += '<div class="rbox"><div class="rbox-title">Plume Rise &amp; Effective Height</div>' +
            _row('Wind at release height', _u(r.u_mph, 'windSpeed', 1, 'mph', 2) + ' (power-law exponent ' + _fmt(r.p, 2) + ')') +
            (r.src === 'flare' ?
                _row('Net (convective) heat release', _u(r.qh_MMBtuhr, 'powerLarge', 2, 'MMBtu/hr', 0)) +
                _row('Buoyancy flux F', _fmt(r.F, 2) + ' m⁴/s³') +
                _row('Final plume rise', _u(r.rise_ft, 'length', 0, 'ft', 1) + (r.stableRise ? ' (stable formula)' : '')) +
                _row('Distance to final rise', _u(r.xf_ft, 'length', 0, 'ft', 0)) : _row('Plume rise', 'none (cold vent, no buoyancy)')) +
            _row('Effective height after final rise', _u(r.hEff_ft, 'length', 0, 'ft', 1)) +
            r.warnings.map(_warn).join('') + '</div>';

        // Exceedance
        var L = r.limits, rows = [], v = '';
        [['h2s', 'H2S'], ['so2', 'SO2']].forEach(function (g) {
            var gas = g[0], nm = g[1], pk = r.peak[gas], E = r.exceed[gas];
            if (!pk) return;
            rows.push([nm, 'IDLH', _fmt(L[gas + 'Idlh'], 2) + ' ppm', _exText(E.idlh)]);
            rows.push([nm, 'STEL / ceiling', _fmt(L[gas + 'Stel'], 2) + ' ppm', _exText(E.stel)]);
            rows.push([nm, 'TWA', _fmt(L[gas + 'Twa'], 2) + ' ppm', _exText(E.twa)]);
            if (E.idlh.reached) v += _bad(nm + ' exceeds IDLH ' + _exText(E.idlh) + ' downwind.');
            else if (E.stel.reached) v += _warn(nm + ' exceeds the STEL ' + _exText(E.stel) + ' downwind; IDLH not reached.');
            else if (E.twa.reached) v += _warn(nm + ' exceeds the TWA ' + _exText(E.twa) + ' downwind.');
            else v += _ok(nm + ' stays below the TWA at ground level at every distance.');
        });
        h += '<div class="rbox"><div class="rbox-title">Ground-Level Maximum &amp; Exceedance Distances</div>' +
            (r.peak.h2s ? _row('H2S maximum', _sig(r.peak.h2s.ppm) + ' ppm at ' + ftx(r.peak.h2s.x / FT)) : '') +
            (r.peak.so2 ? _row('SO2 maximum', _sig(r.peak.so2.ppm) + ' ppm at ' + ftx(r.peak.so2.x / FT)) : '') +
            ((r.peak.h2s && r.peak.h2s.x >= X_MAX * 0.999) || (r.peak.so2 && r.peak.so2.x >= X_MAX * 0.999) ?
                _warn('The ground-level maximum lies at or beyond ' + ftx(X_MAX / FT) + ', outside the range of the Briggs curves.') : '') +
            _tbl(['Gas', 'Limit', 'Value', 'Exceeded downwind'], rows) + v +
            _note('Limits: IDLH 100 ppm for H2S and SO2 (NIOSH); STEL is the NIOSH REL (SO2 5 ppm; H2S 10 ppm 10-minute ceiling); ' +
                'TWA: SO2 2 ppm NIOSH REL, H2S 1 ppm ACGIH TLV. Edit the limits to your site standard.') +
            '</div>';

        // Distance table
        h += '<div class="rbox"><div class="rbox-title">Concentration vs Distance</div>' +
            _tbl(['Distance', 'σy (m)', 'σz (m)', 'Plume height', 'H2S (ppm)', 'SO2 (ppm)'], r.table.map(function (t) {
                return [ftx(t.x_ft), _fmt(t.sy_m, 1), _fmt(t.sz_m, 1), _u(t.H_m / FT, 'length', 0, 'ft', 0), _sig(t.h2s), _sig(t.so2)];
            })) +
            '<div class="chart-wrap"><canvas id="ds_chart" width="600" height="340"></canvas></div>' +
            _note('Ground-level plume-centreline concentration, Gaussian plume with Briggs (1973) rural σy/σz, ' +
                'Briggs buoyant plume rise from the net heat release (gradual rise), ppm at 25 °C. The σ curves are ' +
                'for about 10-minute to 1-hour averages and are fitted for 100 m to 10 km; values nearer than 100 m ' +
                '(330 ft) are extrapolated. The wind does not hold one direction for 8 hours, so the TWA comparison is conservative. ' +
                'Unburned H2S is taken to leave with the flare plume.') +
            '</div>';
        res.innerHTML = h;
        _chart(r);
        res.setAttribute('data-done', '1');
    }

    function _chart(r) {
        var cv = _byId('ds_chart');
        var draw = (typeof drawLineChart === 'function') ? drawLineChart : (typeof G.drawLineChart === 'function' ? G.drawLineChart : null); // eslint-disable-line no-undef
        if (!cv || !draw || !cv.getContext) return;
        // x range: to twice the farthest TWA exceedance or 3× the peak distance, 500 m … 10 km
        var far = 0;
        ['so2', 'h2s'].forEach(function (g) {
            var e = r.exceed[g].twa; if (e && e.reached) far = Math.max(far, e.to_m * 2);
            if (r.peak[g]) far = Math.max(far, r.peak[g].x * 3);
        });
        var xMax = Math.min(X_MAX, Math.max(500, far));
        var FLOOR = 1e-3;
        function pts(g) {
            return r.curve.filter(function (c) { return c.x <= xMax; }).map(function (c) {
                return { x: _disp(c.x / FT, 'length'), y: Math.log10(Math.max(FLOOR, c[g])) };
            });
        }
        function hline(v) { return [{ x: _disp(X_MIN / FT, 'length'), y: Math.log10(v) }, { x: _disp(xMax / FT, 'length'), y: Math.log10(v) }]; }
        var ds = [];
        if (r.peak.h2s) ds.push({ label: 'H2S', color: '#f0883e', data: pts('h2s'), points: false, width: 2 });
        if (r.peak.so2) ds.push({ label: 'SO2', color: '#58a6ff', data: pts('so2'), points: false, width: 2 });
        ds.push({ label: 'IDLH 100 ppm', color: '#f85149', dash: [6, 4], data: hline(r.limits.h2sIdlh), points: false, width: 1 });
        if (r.peak.h2s) ds.push({ label: 'H2S STEL', color: '#d29922', dash: [3, 3], data: hline(r.limits.h2sStel), points: false, width: 1 });
        if (r.peak.so2) ds.push({ label: 'SO2 STEL', color: '#a371f7', dash: [3, 3], data: hline(r.limits.so2Stel), points: false, width: 1 });
        try {
            draw(cv, ds, { xLabel: 'Distance downwind (' + _lab('length', 'ft') + ')', yLabel: 'log10 concentration (ppm)', xMin: 0, xDec: 0, yDec: 1 });
        } catch (e) { /* decorative */ }
    }

    function _read() {
        return {
            src: _str('ds_src'), so2: _num('ds_so2'), h2s: _num('ds_h2s'), heat: _num('ds_heat'), frad: _num('ds_frad'),
            hs: _num('ds_hs'), u10: _num('ds_u10'), cls: _str('ds_cls'), ta: _num('ds_ta'),
            limits: {
                h2sIdlh: _num('ds_lhi'), h2sStel: _num('ds_lhs'), h2sTwa: _num('ds_lht'),
                so2Idlh: _num('ds_lsi'), so2Stel: _num('ds_lss'), so2Twa: _num('ds_lst')
            }
        };
    }

    function _calcImpl() {
        var root = _byId('ds_root');
        if (!root) return null;
        var ins = root.querySelectorAll ? root.querySelectorAll('input,select') : [];
        for (var n = 0; n < ins.length; n++) if (ins[n].classList) ins[n].classList.remove('input-err');
        var r = compute(_read());
        _paint(r);
        var ex = function (g, k) { return r.ok && r.exceed[g][k].reached ? r.exceed[g][k].to_ft : null; };
        G.WTS_state = G.WTS_state || {};
        G.WTS_state.dispersion = {
            maxSO2_ppm: r.ok && r.peak.so2 ? r.peak.so2.ppm : null,
            maxH2S_ppm: r.ok && r.peak.h2s ? r.peak.h2s.ppm : null,
            xMaxSO2_ft: r.ok && r.peak.so2 ? r.peak.so2.x / FT : null,
            xMaxH2S_ft: r.ok && r.peak.h2s ? r.peak.h2s.x / FT : null,
            hEff_ft: r.ok ? r.hEff_ft : null, rise_ft: r.ok ? r.rise_ft : null,
            so2Idlh_ft: ex('so2', 'idlh'), h2sIdlh_ft: ex('h2s', 'idlh'),
            ts: Date.now(), result: r
        };
        return r;
    }
    G.calcDispersion = function () { return _canon(_calcImpl); };

    function _setVal(id, v) {
        var el = _byId(id);
        if (!el) return;
        _canon(function () { el.value = String(Number(v.toPrecision(10))); });
        try {
            if (typeof Event === 'function' && el.dispatchEvent) {
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }
        } catch (e) { /* ignore */ }
    }
    function _msg(t) { var res = _byId('ds_res'); if (res) res.innerHTML = _warn(t); }

    // Flare Emissions: totals over the flaring duration → rates.
    // Heat: E (HHV basis) × 0.90 ≈ LHV for natural gas (methane LHV/HHV = 909.4/1010.0).
    G.WTS_dispersionUseFlare = function () {
        var st = G.WTS_state && G.WTS_state.flareghg;
        var hrs = st ? Number(st.hrs) : NaN;
        if (!st || !(hrs > 0) || !_fin(Number(st.so2_t))) { _msg('Open Flare Emissions and calculate first.'); return false; }
        var so2 = Number(st.so2_t) * 1000 / 0.45359237 / hrs;
        var h2s = _fin(Number(st.h2sUnburned_kg)) ? Number(st.h2sUnburned_kg) / 0.45359237 / hrs : 0;
        var heat = _fin(Number(st.E_MMBtu)) ? Number(st.E_MMBtu) / hrs * 0.90 : NaN;
        var s = _byId('ds_src'); if (s) { s.value = 'flare'; }
        _setVal('ds_so2', so2); _setVal('ds_h2s', h2s);
        if (heat > 0) _setVal('ds_heat', heat);
        G.calcDispersion();
        return true;
    };
    // H2S Safety: flare card (SO2 + unburned H2S) for a flare; escape rate × H2S for a cold vent.
    G.WTS_dispersionUseH2S = function () {
        var st = G.WTS_state && G.WTS_state.h2sroe;
        var src = _str('ds_src') === 'vent' ? 'vent' : 'flare';
        if (src === 'flare') {
            var b = st && st.so2;
            if (!b || !b.ok) { _msg('Open H2S Exposure &amp; Scavenger and calculate the flaring card first.'); return false; }
            _setVal('ds_so2', Number(b.so2_lbhr)); _setVal('ds_h2s', Number(b.h2s_lbhr) || 0);
        } else {
            var a = st && st.roe;
            if (!a || !a.ok || !_fin(Number(a.h2s_lbd))) { _msg('Open H2S Exposure &amp; Scavenger and calculate the radius-of-exposure card first.'); return false; }
            _setVal('ds_h2s', Number(a.h2s_lbd) / 24); _setVal('ds_so2', 0);
        }
        G.calcDispersion();
        return true;
    };

    function render(body) {
        if (!body) return;
        var t = _byId('pgTitle'), s = _byId('pgSub');
        if (t) t.textContent = TITLE;
        if (s) s.textContent = SUB;
        body.innerHTML =
            '<div id="ds_root"><div class="cols-2">' +
            '<div>' +
            '<div class="card"><div class="card-title">Release</div><div class="fg">' +
            _sel('ds_src', 'Source', [{ v: 'flare', t: 'Flare (buoyant plume)' }, { v: 'vent', t: 'Cold vent / leak (no rise)' }], 'flare') +
            _fg('ds_so2', 'SO2 release rate (lb/hr)', '400', ' min="0"') +
            _fg('ds_h2s', 'H2S release rate, unburned or vented (lb/hr)', '4', ' min="0"') +
            _fg('ds_heat', 'Flare heat release, total (MMBtu/hr)', '200', ' min="0"') +
            _fg('ds_frad', 'Heat lost as radiation (%)', '55', ' min="0" max="99"') +
            _fg('ds_hs', 'Flare tip / vent height above grade (ft)', '30', ' min="0"') +
            '</div><div class="btn-row">' +
            '<button class="btn" id="ds_useflare" onclick="WTS_dispersionUseFlare()">Use Flare Emissions</button>' +
            '<button class="btn" id="ds_useh2s" onclick="WTS_dispersionUseH2S()">Use H2S Safety</button>' +
            '</div></div>' +
            '<div class="card"><div class="card-title">Weather</div><div class="fg">' +
            _fg('ds_u10', 'Wind speed at 10 m (mph)', '20', ' min="0"') +
            _sel('ds_cls', 'Stability class', [
                { v: 'A', t: 'A, very unstable' }, { v: 'B', t: 'B, unstable' }, { v: 'C', t: 'C, slightly unstable' },
                { v: 'D', t: 'D, neutral' }, { v: 'E', t: 'E, slightly stable' }, { v: 'F', t: 'F, stable' }], 'D') +
            _fg('ds_ta', 'Ambient temperature (°F)', '68') +
            '</div></div>' +
            '<div class="card"><div class="card-title">Exposure Limits</div><div class="fg">' +
            _fg('ds_lhi', 'H2S IDLH, ppm', '100', ' min="0"') +
            _fg('ds_lhs', 'H2S STEL / ceiling, ppm', '10', ' min="0"') +
            _fg('ds_lht', 'H2S TWA, ppm', '1', ' min="0"') +
            _fg('ds_lsi', 'SO2 IDLH, ppm', '100', ' min="0"') +
            _fg('ds_lss', 'SO2 STEL, ppm', '5', ' min="0"') +
            _fg('ds_lst', 'SO2 TWA, ppm', '2', ' min="0"') +
            '</div><div class="btn-row"><button class="btn btn-primary" id="ds_calc" onclick="calcDispersion()">Calculate</button></div></div>' +
            '</div>' +
            '<div><div id="ds_res"></div></div>' +
            '</div></div>';
        _tag(UNITS);
        var root = _byId('ds_root');
        if (root && root.addEventListener) {
            root.addEventListener('change', function (e) {
                if (e && e.target && /^ds_/.test(e.target.id || '')) G.calcDispersion();
            });
        }
        G.calcDispersion();
    }
    G.renderDispersion = render;

    // ── Registry (merge, never replace) ──────────────────────────────
    G.WTS_calcRegistry = G.WTS_calcRegistry || {};
    G.WTS_calcRegistry.dispersion = {
        key: 'dispersion',
        title: TITLE,
        navTitle: 'SO2 / H2S Dispersion',
        sub: SUB,
        group: 'Flare & Relief',
        icon: '&#9729;',
        badge: 'Screening',
        bc: 'dc-b-orange',
        desc: 'Gaussian plume screening of SO2 and H2S downwind of a flare or vent: plume rise, ground-level ppm vs distance, IDLH / STEL / TWA distances.',
        render: function (body) { return G.renderDispersion(body); }
    };

    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('wts:unit-system-changed', function () {
            var r = _byId('ds_res');
            if (r && r.getAttribute && r.getAttribute('data-done') === '1') G.calcDispersion();
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
    var s = G.WTS_dispersion_sigma('D', 1000);
    rel(s.sy, 80 / Math.sqrt(1.1), 1e-9, 'σy D 1 km'); rel(s.sz, 60 / Math.sqrt(2.5), 1e-9, 'σz D 1 km');
    // Ground-level vent, class D, u = 5 m/s at 10 m: C = Q/(π u σy σz)
    var r = G.WTS_dispersion_compute({ src: 'vent', so2: 0, h2s: 1 / (453.59237 / 3600), hs: 0, u10: 5 / 0.44704, cls: 'D', ta: 68 });
    rel(r.chi('h2s', 1000), 1 / (Math.PI * 5 * s.sy * s.sz) * 1000 * 24.45 / 34.081, 1e-9, 'vent D 1 km');
    // SCREEN3 flare flux: F = 1.66e-5·H(cal/s) with 55 % radiant loss
    var f = G.WTS_dispersion_compute({ src: 'flare', so2: 100, h2s: 0, heat: 100, frad: 55, hs: 30, u10: 10, cls: 'D', ta: 68 });
    rel(f.F, 1.66e-5 * 100 * 1.05505585262e9 / 3600 / 4.1868, 2e-3, 'SCREEN3 F');
    if (fails.length) {
        if (typeof console !== 'undefined') console.error('[dispersion self-test] ' + fails.length + '/' + n + ' FAILED:\n  ' + fails.join('\n  '));
        if (typeof window === 'undefined' && typeof process !== 'undefined') process.exitCode = 1;
    } else if (typeof console !== 'undefined') {
        console.log('[dispersion self-test] ' + n + '/' + n + ' checks passed');
    }
})();
