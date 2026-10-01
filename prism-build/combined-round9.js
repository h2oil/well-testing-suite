
// ═══════════════════════════════════════════════════════════════════════
// Round-9 (calculators) — auto-injected from prism-build/4N-calc-*.js
//   Each file registers window.WTS_calcRegistry[key] = { key, title, sub, group, icon, render(body) };
//   the host render() / sidebar / dashboard pick the entries up (no route-table edit).
//   • 40-calc-tubulars
//   • 41-calc-gasdeliv
//   • 42-calc-oilipr
//   • 43-calc-flareghg
//   • 44-calc-h2sroe
//   • 45-calc-orifice
//   • 46-calc-gaspvt
//   • 47-calc-historian
//   • 48-calc-wellkill
//   • 49-calc-chokeperf
//   • 49-calc-dispersion
//   • 49-calc-flowline
//   • 49-calc-fluids
//   • 49-calc-gaslift
//   • 49-calc-lineheat
//   • 49-calc-proving
//   • 49-calc-scale
//   • 49-calc-sepqc
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 40-calc-tubulars ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════
// WTS — Round-9 shared data module — tubular table (tubulars)
//
// PURPOSE
//   One table of API 5CT casing and tubing, common API 5DP drill pipe and
//   liners, with capacity / annular-capacity / displacement helpers. Shared
//   by the plug-in calculators (Well Kill & Bullhead first; DST recovery and
//   bottoms-up later). It is a data module: it deliberately does NOT add a
//   page to window.WTS_calcRegistry, so it has no sidebar button or tile.
//   The file lives in the 4N-calc- namespace only so concat-round9.js picks
//   it up ahead of the calculators (40 sorts first).
//
// DATA
//   Every entry: {key, type, od, wt, id, wall, drift, label}
//     od, id, wall, drift in inches; wt = nominal weight, lb/ft.
//     wall = (od − id) / 2 (API 5CT: ID = OD − 2·wall).
//     drift = API 5CT drift mandrel diameter:
//       casing   ID − 1/8"  (OD below 9-5/8"), ID − 5/32" (9-5/8" to 13-3/8"),
//                ID − 3/16" (16" and larger)
//       tubing   ID − 3/32" (OD ≤ 2-7/8"), ID − 1/8" (3-1/2" and larger)
//       drill pipe: no API drift → null.
//   Casing and tubing include every row of the host Casing & Tubing page
//   (`casingData` / `tubingData`) with identical IDs; the extra rows follow
//   API 5CT / API TR 5C3 nominal weights and wall thicknesses.
//   Liners are the casing rows commonly run as liners (OD 4-1/2" to 9-5/8"),
//   with type 'liner'. Drill pipe IDs are API 5DP plain-pipe body IDs; the
//   displacement helpers work on the plain body (tool joints excluded).
//
// PUBLIC API (window.WTS_tubulars)
//   casing, tubing, drillpipe, liners       arrays of entries (read-only by convention)
//   all()                                   every entry
//   list(type)                              'casing' | 'tubing' | 'drillpipe' | 'liner'
//   find(key)                               entry by key, or null
//   hostCasingKeys, hostTubingKeys          keys matching the host casingData / tubingData order
//   BBL_PER_FT_PER_IN2                      π/4 · 12 in / 9702 in³ per bbl = 0.000971413
//   capacity(idIn)                          bbl/ft inside a pipe
//   annularCapacity(holeIdIn, pipeOdIn)     bbl/ft of annulus (NaN if the pipe does not fit)
//   displacement(odIn, idIn)                bbl/ft open-end (steel) displacement
//   closedEndDisplacement(odIn)             bbl/ft closed-end displacement
//   bblFtToM3m(x)                           bbl/ft → m³/m (× 0.521612)
// ════════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    var G = (typeof window !== 'undefined') ? window : globalThis;

    // 1 bbl = 9702 in³ (42 US gal × 231 in³); a 1 in bore, 1 ft long = π/4 · 12 in³.
    var K = Math.PI / 4 * 12 / 9702;          // 0.000971413 bbl/ft per in²
    var BBLFT_TO_M3M = 0.158987294928 / 0.3048;

    function _r(x, d) { var f = Math.pow(10, d); return Math.round(x * f) / f; }
    function _frac(od) {
        var whole = Math.floor(od + 1e-9), rem = od - whole;
        var n = Math.round(rem * 64);
        if (n === 0) return String(whole);
        var d = 64;
        while (n % 2 === 0 && d > 1) { n /= 2; d /= 2; }
        if (Math.abs(rem * 64 - Math.round(rem * 64)) > 1e-6) return String(od);
        return (whole ? whole + '-' : '') + n + '/' + d;
    }
    // API Spec 5CT, drift-mandrel table: casing smaller than 9-5/8" → d − 1/8" (3.18 mm);
    // 9-5/8" to 13-3/8" inclusive → d − 5/32" (3.97 mm); larger than 13-3/8" → d − 3/16" (4.76 mm).
    // Check: 9-5/8" 47# ID 8.681" → drift 8.525" (published); 9-5/8" 53.5# 8.535" → 8.379".
    function _casingDrift(od, id) { return id - (od < 9.625 - 1e-9 ? 0.125 : od <= 13.375 + 1e-9 ? 0.15625 : 0.1875); }
    function _tubingDrift(od, id) { return id - (od <= 2.875 + 1e-9 ? 0.09375 : 0.125); }

    function _mk(type, od, wt, id, note) {
        var drift = type === 'casing' || type === 'liner' ? _casingDrift(od, id) : type === 'tubing' ? _tubingDrift(od, id) : null;
        var key = type + '-' + od + '-' + wt;
        var name = { casing: 'casing', liner: 'liner', tubing: 'tubing', drillpipe: 'drill pipe' }[type];
        return {
            key: key, type: type, od: od, wt: wt, id: id,
            wall: _r((od - id) / 2, 4),
            drift: drift == null ? null : _r(drift, 3),
            label: _frac(od) + '" ' + wt.toFixed(2) + ' lb/ft ' + name + ' (ID ' + id.toFixed(3) + '")' + (note ? ' ' + note : '')
        };
    }

    // [od, wt, id] — API 5CT casing (wall per API TR 5C3). Rows marked * are the host casingData.
    var CASING = [
        [4.5, 9.5, 4.09], [4.5, 10.5, 4.052], [4.5, 11.6, 4.0], [4.5, 13.5, 3.92], [4.5, 15.1, 3.826],
        [5, 11.5, 4.56], [5, 13, 4.494], [5, 15, 4.408], [5, 18, 4.276], [5, 21.4, 4.126], [5, 23.2, 4.044],
        [5.5, 14, 5.012], [5.5, 15.5, 4.95], [5.5, 17, 4.892], [5.5, 20, 4.778], [5.5, 23, 4.67], [5.5, 26, 4.548],
        [6.625, 20, 6.049], [6.625, 24, 5.921], [6.625, 28, 5.791], [6.625, 32, 5.675],
        [7, 17, 6.538], [7, 20, 6.456], [7, 23, 6.366], [7, 26, 6.276], [7, 29, 6.184], [7, 32, 6.094], [7, 35, 6.004], [7, 38, 5.92],
        [7.625, 20, 7.125], [7.625, 24, 7.025], [7.625, 26.4, 6.969], [7.625, 29.7, 6.875], [7.625, 33.7, 6.765], [7.625, 39, 6.625],
        [8.625, 24, 8.097], [8.625, 28, 8.017], [8.625, 32, 7.921], [8.625, 36, 7.825], [8.625, 40, 7.725], [8.625, 44, 7.625], [8.625, 49, 7.511],
        [9.625, 32.3, 9.001], [9.625, 36, 8.921], [9.625, 40, 8.835], [9.625, 43.5, 8.755], [9.625, 47, 8.681], [9.625, 53.5, 8.535],
        [10.75, 32.75, 10.192], [10.75, 40.5, 10.05], [10.75, 45.5, 9.95], [10.75, 51, 9.85], [10.75, 55.5, 9.76],
        [13.375, 48, 12.715], [13.375, 54.5, 12.615], [13.375, 61, 12.515], [13.375, 68, 12.415], [13.375, 72, 12.347],
        [16, 65, 15.25], [16, 75, 15.124], [16, 84, 15.01],
        [20, 94, 19.124], [20, 106.5, 19.0], [20, 133, 18.73]
    ];
    // [od, wt, id] — API 5CT tubing. The host tubingData has 4-1/2" 9.50 lb/ft (ID 4.090") too.
    var TUBING = [
        [1.9, 2.9, 1.61],
        [2.375, 4.7, 1.995], [2.375, 5.95, 1.867],
        [2.875, 6.5, 2.441], [2.875, 8.7, 2.259],
        [3.5, 7.7, 3.068], [3.5, 9.3, 2.992], [3.5, 10.3, 2.922], [3.5, 12.95, 2.75],
        [4, 9.5, 3.548], [4, 11, 3.476],
        [4.5, 9.5, 4.09], [4.5, 12.75, 3.958]
    ];
    // [od, wt, id] — API 5DP drill pipe, nominal weight, plain-pipe body ID.
    var DRILLPIPE = [
        [2.375, 6.65, 1.815], [2.875, 10.4, 2.151], [3.5, 13.3, 2.764], [3.5, 15.5, 2.602],
        [4, 14, 3.34], [4.5, 16.6, 3.826], [4.5, 20, 3.64], [5, 19.5, 4.276], [5, 25.6, 4],
        [5.5, 21.9, 4.778], [5.5, 24.7, 4.67], [6.625, 25.2, 5.965]
    ];
    // Host page order (well-testing-app.html, Casing & Tubing Size) — identical IDs.
    var HOST_CASING = [
        [4.5, 9.5], [4.5, 11.6], [4.5, 13.5], [5, 11.5], [5, 15], [5, 18], [5.5, 14], [5.5, 17], [5.5, 20], [5.5, 23],
        [7, 17], [7, 20], [7, 23], [7, 26], [7, 29], [7, 32], [7.625, 20], [7.625, 24], [7.625, 26.4], [7.625, 29.7],
        [9.625, 32.3], [9.625, 36], [9.625, 40], [9.625, 43.5], [9.625, 47], [10.75, 32.75], [10.75, 40.5], [10.75, 45.5],
        [13.375, 48], [13.375, 54.5], [13.375, 61], [13.375, 68]
    ];
    var HOST_TUBING = [[2.375, 4.7], [2.375, 5.95], [2.875, 6.5], [2.875, 8.7], [3.5, 7.7], [3.5, 9.3], [3.5, 12.95], [4.5, 9.5], [4.5, 12.75]];

    var casing = CASING.map(function (r) { return _mk('casing', r[0], r[1], r[2]); });
    var tubing = TUBING.map(function (r) { return _mk('tubing', r[0], r[1], r[2]); });
    var drillpipe = DRILLPIPE.map(function (r) { return _mk('drillpipe', r[0], r[1], r[2]); });
    var liners = CASING.filter(function (r) { return r[0] <= 9.625; }).map(function (r) { return _mk('liner', r[0], r[1], r[2]); });
    var ALL = casing.concat(tubing, drillpipe, liners);
    var BY_KEY = {};
    ALL.forEach(function (e) { BY_KEY[e.key] = e; });

    function _fin(x) { return typeof x === 'number' && isFinite(x); }
    function capacity(idIn) { var d = Number(idIn); return _fin(d) && d > 0 ? d * d * K : NaN; }
    function annularCapacity(holeIdIn, pipeOdIn) {
        var D = Number(holeIdIn), d = Number(pipeOdIn);
        if (!(_fin(D) && _fin(d) && D > 0 && d >= 0 && d < D)) return NaN;
        return (D * D - d * d) * K;
    }
    function displacement(odIn, idIn) {
        var D = Number(odIn), d = Number(idIn);
        if (!(_fin(D) && _fin(d) && D > 0 && d >= 0 && d < D)) return NaN;
        return (D * D - d * d) * K;
    }
    function closedEndDisplacement(odIn) { return capacity(odIn); }

    G.WTS_tubulars = {
        casing: casing, tubing: tubing, drillpipe: drillpipe, liners: liners,
        hostCasingKeys: HOST_CASING.map(function (r) { return 'casing-' + r[0] + '-' + r[1]; }),
        hostTubingKeys: HOST_TUBING.map(function (r) { return 'tubing-' + r[0] + '-' + r[1]; }),
        BBL_PER_FT_PER_IN2: K,
        all: function () { return ALL.slice(); },
        list: function (type) {
            return type === 'casing' ? casing.slice() : type === 'tubing' ? tubing.slice() :
                type === 'drillpipe' ? drillpipe.slice() : type === 'liner' ? liners.slice() : [];
        },
        find: function (key) { return Object.prototype.hasOwnProperty.call(BY_KEY, key) ? BY_KEY[key] : null; },
        capacity: capacity,
        annularCapacity: annularCapacity,
        displacement: displacement,
        closedEndDisplacement: closedEndDisplacement,
        bblFtToM3m: function (x) { return Number(x) * BBLFT_TO_M3M; }
    };
})();

// ─── END 40-calc-tubulars ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 41-calc-gasdeliv ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════
// WTS ─ Round-9 plug-in calculator 41 — Gas Deliverability & AOF
//
// PURPOSE
//   Multipoint gas-well deliverability analysis of flow-after-flow,
//   isochronal, modified isochronal and single-point (stabilised) tests.
//   Two methods side by side:
//     • Back-pressure equation (Rawlins & Schellhardt 1935):
//           q = C·(p̄r² − pwf²)ⁿ
//     • Laminar-inertial-turbulent (LIT) equation (Houpeurt 1959):
//           p̄r² − pwf² = a·q + b·q²
//   Results: absolute open flow (AOF) at the sandface back-pressure pb,
//   rate at a chosen flowing pressure, flowing pressure at a target rate,
//   11-row deliverability table and a q–pwf plot.
//
// REFERENCES
//   • Rawlins, E.L. & Schellhardt, M.A. (1935) "Back-pressure data on
//     natural gas wells and their application to production practices",
//     USBM Monograph 7.
//   • Houpeurt, A. (1959) "On the flow of gases in porous media",
//     Revue de l'Institut Français du Pétrole XIV (11).
//   • Cullender, M.H. (1955) "The isochronal performance method of
//     determining the flow characteristics of gas wells", Trans. AIME 204.
//   • Katz, D.L. et al. (1959) Handbook of Natural Gas Engineering —
//     modified isochronal test (Δ from the shut-in pressure before each flow).
//   • Alberta ERCB Directive 034 (1975), "Gas Well Testing — Theory and
//     Practice" — test types, AOF at atmospheric back-pressure (14.65 psia).
//
// FIELD UNITS (canonical): pressures psia, rates MSCFD, C in MSCFD/psia²ⁿ,
//   a in psia²/MSCFD, b in psia²/(MSCFD)². The units layer converts tagged
//   inputs; results are formatted with WTS_units.format when metric.
//
// PUBLIC API (window.*)
//   renderGasDeliverability(body)   paint the page into #pgBody
//   calcGasDeliv()                  read DOM → validate → compute → render
//   WTS_gasdeliv_compute(input)     pure; field units in and out, no DOM
//       input  {type, pr, pb, nAssumed, pwfDesign, qTarget,
//               points:[{kind, q, pwf, pws, row}]}
//       output {ok, errors[], errorIds[], warnings[], verdicts[], deltas[],
//               cn:{n, C, r2, aof, qAtPwf, pwfAtQ, qAboveAof},
//               lit:{ok, a, b, aof, qAtPwf, pwfAtQ, qAboveAof, nonDarcyPct, reason},
//               table:[{pwf, qCn, qLit}], ...}
//   WTS_state.gasdeliv              last result (in memory only)
//   WTS_calcRegistry.gasdeliv       Round-9 registration (host adds route,
//                                   sidebar button and dashboard tile)
//
// CONVENTIONS: single outer IIFE, 'use strict', no dependencies, no timers,
//   loads without document / WTS_units / drawLineChart. Self-test block at
//   the end is stripped by concat-round9.
// ════════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    var G = (typeof window !== 'undefined') ? window : globalThis;
    var P = 'gd_';
    var NROWS = 6;

    // ── Page helpers (shared calculator pattern) ─────────────────────
    function _byId(id) { return (typeof document !== 'undefined' && document.getElementById) ? document.getElementById(id) : null; }
    function _num(id) { var e = _byId(id); if (!e) return NaN; var s = String(e.value).trim(); return s === '' ? NaN : parseFloat(s); }
    function _blank(id) { var e = _byId(id); return !e || String(e.value).trim() === ''; }
    function _fmt(v, d) {
        if (v == null || !isFinite(v)) return '—';
        return (G.WTS_fmtNum ? G.WTS_fmtNum(v, 0, (d == null ? 2 : d)) : Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: (d == null ? 2 : d) }));
    }
    function _metric() { var U = G.WTS_units; return !!(U && U.getSystem && U.getSystem() === 'metric' && U.format); }
    // Value in the display system; impLabel is the imperial text shown in imperial.
    function _u(v, cat, d, impLabel) {
        if (v == null || !isFinite(v)) return '—';
        if (_metric()) { var f = G.WTS_units.format(v, cat); return _fmt(f.value, d) + ' ' + f.label; }
        return _fmt(v, d) + ' ' + impLabel;
    }
    function _dv(v, cat) { return _metric() ? G.WTS_units.format(v, cat).value : v; }       // display value
    function _lab(cat, impLabel) { return _metric() ? G.WTS_units.format(1, cat).label : impLabel; }
    function _tag(map) { var U = G.WTS_units; if (!U || !U.tagInput) return; for (var id in map) U.tagInput(id, map[id]); }
    function _canon(fn) { var U = G.WTS_units; return (U && U.runCanonical) ? U.runCanonical(fn) : fn(); }
    function _nv(v) { return (v === null || v === undefined || v === '') ? NaN : Number(v); }
    function _given(v) { return isFinite(_nv(v)); }

    var TYPES = {
        faf: 'Flow-after-flow (conventional)',
        iso: 'Isochronal',
        miso: 'Modified isochronal',
        single: 'Single-point (stabilised)'
    };
    var KINDS = { trans: 'Transient', stab: 'Stabilised' };
    var TYPE_SHORT = { faf: 'flow-after-flow', iso: 'isochronal', miso: 'modified isochronal', single: 'single-point' };

    // Least squares y = c0 + c1·x. R² = Sxy²/(Sxx·Syy).
    function _fit(xs, ys) {
        var n = xs.length, mx = 0, my = 0, i;
        for (i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
        mx /= n; my /= n;
        var sxx = 0, sxy = 0, syy = 0;
        for (i = 0; i < n; i++) {
            var dx = xs[i] - mx, dy = ys[i] - my;
            sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
        }
        var scale = 0; for (i = 0; i < n; i++) scale = Math.max(scale, Math.abs(xs[i]));
        if (!(sxx > 1e-20 * Math.max(1, scale * scale))) return null;
        var slope = sxy / sxx;
        return { slope: slope, intercept: my - slope * mx, r2: (syy > 0) ? (sxy * sxy) / (sxx * syy) : 1 };
    }
    function _log10(x) { return Math.log(x) / Math.LN10; }

    // ═════════════════════════════════════════════════════════════════
    // PURE COMPUTE — field units (psia, MSCFD)
    // ═════════════════════════════════════════════════════════════════
    function compute(inp) {
        inp = inp || {};
        var errors = [], errorIds = [];
        function err(msg, id) { errors.push(msg); errorIds.push(id || null); }
        var fail = function () {
            return { ok: false, errors: errors, errorIds: errorIds, warnings: [], verdicts: [], deltas: [],
                cn: null, lit: null, table: [] };
        };

        var type = Object.prototype.hasOwnProperty.call(TYPES, inp.type) ? inp.type : null;
        if (!type) { err('Select a test type.', P + 'type'); return fail(); }

        var pr = _nv(inp.pr), pb = _nv(inp.pb);
        var prOk = isFinite(pr) && pr >= 50 && pr <= 30000;
        if (!isFinite(pr) || pr <= 0) err('Average reservoir pressure is required and must be above 0.', P + 'pr');
        else if (!prOk) err('Average reservoir pressure must be between ' + _u(50, 'pressure', 1, 'psia') + ' and ' + _u(30000, 'pressure', 0, 'psia') + '.', P + 'pr');

        if (!isFinite(pb)) err('AOF back-pressure is required.', P + 'pb');
        else if (pb < 0 || (prOk && pb >= pr)) err('AOF back-pressure must be 0 or more and below the average reservoir pressure.', P + 'pb');
        else if (pb > 100) err('AOF back-pressure must not exceed ' + _u(100, 'pressure', 1, 'psia') + ' — AOF is quoted at an atmospheric sandface back-pressure.', P + 'pb');

        var nAss = _nv(inp.nAssumed);
        if (type === 'single' && !(nAss >= 0.5 && nAss <= 1.0)) err('Assumed exponent n must be between 0.5 and 1.0.', P + 'nass');

        // Test points
        var pts = Array.isArray(inp.points) ? inp.points : [];
        var used = [];
        for (var i = 0; i < pts.length; i++) {
            var p = pts[i] || {}, row = (p.row >= 1 && p.row <= 99) ? Math.floor(p.row) : (i + 1);
            var q = _nv(p.q), pwf = _nv(p.pwf), pws = _nv(p.pws);
            var hasQ = isFinite(q), hasP = isFinite(pwf);
            if (!hasQ && !hasP) continue;
            if (hasQ !== hasP) { err('Point ' + row + ': enter both rate and pwf, or leave both blank.', P + (hasQ ? 'pwf' : 'q') + row); continue; }
            var bad = false;
            if (!(q > 0)) { err('Point ' + row + ': rate must be above 0.', P + 'q' + row); bad = true; }
            if (!(pwf > 0) || (prOk && pwf >= pr)) { err('Point ' + row + ': pwf must be above 0 and below the average reservoir pressure.', P + 'pwf' + row); bad = true; }
            var kind = (p.kind === 'stab' || p.kind === 'trans') ? p.kind : 'trans';
            if (type === 'miso' && kind === 'trans' && !bad) {
                if (!isFinite(pws)) { err('Point ' + row + ': enter pws (the shut-in pressure before this flow) for a transient point of a modified isochronal test.', P + 'pws' + row); bad = true; }
                else if (pws <= pwf) { err('Point ' + row + ': pws must be above pwf.', P + 'pws' + row); bad = true; }
                else if (prOk && pws > 1.01 * pr) { err('Point ' + row + ': pws cannot exceed the average reservoir pressure by more than 1 %.', P + 'pws' + row); bad = true; }
            }
            if (!bad) used.push({ row: row, kind: kind, q: q, pwf: pwf, pws: isFinite(pws) ? pws : null });
        }
        if (errors.length) return fail();

        if (type === 'single') used = used.slice(0, 1);
        var trans = used.filter(function (u) { return u.kind === 'trans'; });
        var stabs = used.filter(function (u) { return u.kind === 'stab'; });
        if (type === 'faf' && used.length < 2) err('Flow-after-flow needs at least two test points.', P + 'q1');
        if ((type === 'iso' || type === 'miso')) {
            if (trans.length < 2) err('An ' + TYPE_SHORT[type] + ' test needs at least two transient points.', P + 'k1');
            if (!stabs.length) err('An ' + TYPE_SHORT[type] + ' test needs one stabilised point (Point type = Stabilised).', P + 'k1');
        }
        if (type === 'single' && !used.length) err('Enter the stabilised test point (rate and pwf).', P + 'q1');

        var pwfd = _nv(inp.pwfDesign), qt = _nv(inp.qTarget);
        var hasPwfd = isFinite(pwfd), hasQt = isFinite(qt);
        if (hasPwfd && (pwfd < pb || pwfd >= pr)) err('Flowing pressure for the rate readout must be at least the AOF back-pressure and below the average reservoir pressure.', P + 'pwfd');
        if (hasQt && !(qt > 0)) err('Target rate for the pressure readout must be above 0.', P + 'qt');
        if (errors.length) return fail();

        // Drawdown terms. faf / iso / stabilised: Δ = p̄r² − pwf².
        // Modified isochronal transient: Δ = pws² − pwf² (Katz et al. 1959).
        var pr2 = pr * pr, dAOF = pr2 - pb * pb;
        used.forEach(function (u) {
            u.delta = (type === 'miso' && u.kind === 'trans') ? (u.pws * u.pws - u.pwf * u.pwf) : (pr2 - u.pwf * u.pwf);
        });
        var deltas = used.map(function (u) { return u.delta; });
        var slopeSet = (type === 'faf') ? used : (type === 'single' ? used : trans);
        var stab = (type === 'iso' || type === 'miso') ? stabs[stabs.length - 1] : null;

        // ── Back-pressure equation (Rawlins & Schellhardt 1935) ──
        var n, C, r2 = null;
        if (type === 'single') {
            n = nAss;
            C = used[0].q / Math.pow(used[0].delta, n);
        } else {
            var fit = _fit(slopeSet.map(function (u) { return _log10(u.delta); }),
                           slopeSet.map(function (u) { return _log10(u.q); }));
            if (!fit) { err('The slope points all have the same drawdown Δ — the fit is singular; check the rates and pressures.', P + 'pwf1'); return fail(); }
            n = fit.slope;
            if (slopeSet.length >= 3) r2 = fit.r2;
            C = (type === 'faf') ? Math.pow(10, fit.intercept) : stab.q / Math.pow(stab.delta, n);
        }
        if (!(n > 0) || !(C > 0) || !isFinite(C)) {
            err('The fitted exponent n is not positive — the rates do not increase with drawdown; check the test points.', P + 'q1');
            return fail();
        }
        var cnAt = function (pwf) { return C * Math.pow(Math.max(0, pr2 - pwf * pwf), n); };
        var aofCn = C * Math.pow(dAOF, n);
        var cn = { n: n, C: C, r2: r2, aof: aofCn, qAtPwf: null, pwfAtQ: null, qAboveAof: false };
        if (hasPwfd) cn.qAtPwf = cnAt(pwfd);
        if (hasQt) {
            if (qt >= aofCn) cn.qAboveAof = true;
            else cn.pwfAtQ = Math.sqrt(pr2 - Math.pow(qt / C, 1 / n));
        }

        // ── LIT equation (Houpeurt 1959): Δ/q = a + b·q ──
        var lit = { ok: false, a: null, b: null, aof: null, qAtPwf: null, pwfAtQ: null, qAboveAof: false, nonDarcyPct: null, reason: '' };
        if (type === 'single') {
            lit.reason = 'LIT needs at least two points';
        } else {
            var lf = _fit(slopeSet.map(function (u) { return u.q; }), slopeSet.map(function (u) { return u.delta / u.q; }));
            if (!lf) {
                lit.reason = 'The slope points have equal rates — the LIT fit is singular.';
            } else {
                var b = lf.slope;
                var a = (type === 'faf') ? lf.intercept : (stab.delta - b * stab.q * stab.q) / stab.q;
                lit.a = a; lit.b = b;
                if (!(b > 0)) lit.reason = 'b ≤ 0';
                else if (!(a > 0)) lit.reason = 'a ≤ 0';
                else {
                    lit.ok = true;
                    var litQ = function (d) { return (-a + Math.sqrt(a * a + 4 * b * d)) / (2 * b); };
                    lit.aof = litQ(dAOF);
                    if (hasPwfd) lit.qAtPwf = litQ(pr2 - pwfd * pwfd);
                    if (hasQt) {
                        if (qt >= lit.aof) lit.qAboveAof = true;
                        else lit.pwfAtQ = Math.sqrt(pr2 - (a * qt + b * qt * qt));
                    }
                    lit.nonDarcyPct = b * lit.aof * lit.aof / dAOF * 100;
                    lit._q = litQ;
                }
            }
        }

        // ── Deliverability table: pwf_k = p̄r − k·(p̄r − pb)/10 ──
        var table = [];
        for (var k = 0; k <= 10; k++) {
            var pw = pr - k * (pr - pb) / 10;
            table.push({ pwf: pw, qCn: cnAt(pw), qLit: lit.ok ? lit._q(pr2 - pw * pw) : null });
        }
        delete lit._q;

        // ── Verdicts ──
        var verdicts = [];
        function v(level, text) { verdicts.push({ level: level, text: text }); }
        var n3 = n.toFixed(3);
        if (n >= 0.5 && n <= 1.0) v('ok', '✓ Exponent n = ' + n3 + ' is within the physical range 0.5–1.0.');
        else v('warn', '⚠ Exponent n = ' + n3 + ' is outside 0.5–1.0 — check stabilisation, liquid loading, rate/pressure timing or a changing skin.');
        if (type !== 'single' && lit.b != null && !(lit.b > 0)) v('warn', '⚠ LIT coefficient b ≤ 0 — the points show no non-Darcy flow; LIT results are not reported.');
        if (type !== 'single' && lit.a != null && !(lit.a > 0)) v('warn', '⚠ LIT coefficient a ≤ 0 — the stabilised point is inconsistent with the transient points; LIT results are not reported.');
        if (r2 != null && r2 < 0.98) v('warn', '⚠ Points scatter about the back-pressure line (R² = ' + r2.toFixed(4) + ').');
        var dMax = Math.max.apply(null, deltas);
        if (dMax / dAOF < 0.10) v('warn', '⚠ The largest test drawdown is only ' + (dMax / dAOF * 100).toFixed(1) + ' % of the AOF drawdown — the AOF is a long extrapolation.');
        if (type === 'single') v('warn', '⚠ Single-point AOF uses an assumed n = ' + _fmt(n, 3) + '; confirm with a multipoint test.');
        if ((type === 'iso' || type === 'miso') && stabs.length > 1) v('warn', '⚠ More than one stabilised point — the last one was used.');

        return {
            ok: true, errors: [], errorIds: [], type: type, pr: pr, pb: pb, deltaAOF: dAOF,
            pwfDesign: hasPwfd ? pwfd : null, qTarget: hasQt ? qt : null,
            points: used, slopeCount: slopeSet.length, stabCount: stabs.length,
            deltas: deltas, cn: cn, lit: lit, table: table,
            verdicts: verdicts,
            warnings: verdicts.filter(function (x) { return x.level === 'warn'; }).map(function (x) { return x.text; })
        };
    }
    G.WTS_gasdeliv_compute = compute;

    // ═════════════════════════════════════════════════════════════════
    // PAGE
    // ═════════════════════════════════════════════════════════════════
    var TITLE = 'Gas Deliverability & AOF';
    var SUB = 'Back-pressure (C and n) and laminar-inertial-turbulent analysis of gas well tests — AOF, IPR table and plot';

    var UNITS = { gd_pr: 'pressure', gd_pb: 'pressure', gd_pwfd: 'pressure', gd_qt: 'gasRateSmall' };
    (function () { for (var i = 1; i <= NROWS; i++) { UNITS[P + 'q' + i] = 'gasRateSmall'; UNITS[P + 'pwf' + i] = 'pressure'; UNITS[P + 'pws' + i] = 'pressure'; } })();

    var DEF_ROWS = [[2624.6, 1700], [4154.7, 1500], [5425.1, 1300]];

    // CSV paste / file import of the test points (host WTS_csv, P9). The
    // host parses, reads units from the header and converts to psia / MSCFD;
    // values without a unit are taken in the unit shown on the page.
    var CSV_SPEC = {
        maxRows: NROWS, leadingEnum: 'kind', positional: ['kind', 'q', 'pwf', 'pws'],
        aria: 'Test points as CSV',
        columns: [
            { key: 'kind', label: 'Point type', kind: 'enum', names: ['type', 'point type', 'kind', 'point', 'flow type', 'test type'],
              values: { stab: /^\s*(stab|stabili[sz]ed|extended|s)\s*$/i, trans: /^\s*(trans|transient|t|iso|isochronal)\s*$/i } },
            { key: 'q', label: 'Rate q', kind: 'gasRate', cat: 'gasRateSmall', required: true, positive: true,
              names: ['q', 'qg', 'rate', 'rate q', 'gas rate', 'flow rate', 'q gas', 'gas flow rate'] },
            { key: 'pwf', label: 'pwf', kind: 'pressure', cat: 'pressure', required: true, positive: true,
              names: ['pwf', 'p wf', 'pwf abs', 'flowing pressure', 'bottomhole flowing pressure', 'bhfp', 'fbhp'] },
            { key: 'pws', label: 'pws', kind: 'pressure', cat: 'pressure', positive: true,
              names: ['pws', 'p ws', 'pws abs', 'pws before flow', 'pws before flow abs', 'shut in pressure', 'shutin pressure', 'sibhp'] }
        ],
        hint: 'One row per test point (up to ' + NROWS + '). Header names: type (stab / trans), q, pwf, pws — in any order, with units in brackets, ' +
            'e.g. <b>q (MMSCFD)</b>, <b>pwf [psig]</b>, <b>kPa(a)</b>, <b>bar</b>, <b>e3m3/d</b>. Without a header the order is type (optional), q, pwf, pws. ' +
            'Comma, semicolon or tab separated. Values without a unit are read in the units shown in the table. Gauge pressures are made absolute with 1 atm.',
        example: 'type,q (MSCFD),pwf (psia),pws (psia)\nstab,2624.6,1700,\nstab,4154.7,1500,\nstab,5425.1,1300,'
    };
    function _applyCsv(res) {
        var n = res.rows.length;
        _canon(function () {
            for (var i = 1; i <= NROWS; i++) {
                var r = res.rows[i - 1];
                var put = function (id, v) { var e = _byId(id); if (e) e.value = (r && isFinite(v)) ? String(v) : ''; };
                put(P + 'q' + i, r && r.q); put(P + 'pwf' + i, r && r.pwf); put(P + 'pws' + i, r && r.pws);
                if (r && r.kind) { var k = _byId(P + 'k' + i); if (k) k.value = r.kind; }
            }
        });
        G.calcGasDeliv();
        return 'Imported ' + n + ' test point' + (n === 1 ? '' : 's') + (n < NROWS ? '; rows ' + (n + 1) + '–' + NROWS + ' cleared.' : '.');
    }

    function _field(id, label, value, extra) {
        return '<div class="fg-item"><label for="' + id + '">' + label + '</label>' +
            '<input type="number" step="any" id="' + id + '" value="' + (value == null ? '' : value) + '"' + (extra || '') + '></div>';
    }
    function _select(id, opts, sel, aria) {
        var h = '<select id="' + id + '"' + (aria ? ' aria-label="' + aria + '"' : '') + (aria ? ' style="width:100%;min-width:72px"' : '') + '>';
        for (var k in opts) h += '<option value="' + k + '"' + (k === sel ? ' selected' : '') + '>' + opts[k] + '</option>';
        return h + '</select>';
    }

    function _pageHtml() {
        // min-width:0 lets the grid columns shrink below the test-point table's
        // intrinsic width at 375 px (the table then scrolls inside its wrapper).
        var h = '<div id="gd_root"><div class="cols-2"><div style="min-width:0">';
        // Card 1 — test type & reservoir
        h += '<div class="card"><div class="card-title">Test Type &amp; Reservoir</div><div class="fg">';
        h += '<div class="fg-item"><label for="gd_type">Test type</label>' + _select('gd_type', TYPES, 'faf') + '</div>';
        h += _field('gd_pr', 'Average reservoir pressure, absolute (psia)', 1952);
        h += _field('gd_pb', 'AOF back-pressure, absolute (psia)', 14.65);
        h += _field('gd_nass', 'Assumed exponent n, single-point only', 0.85, ' min="0.5" max="1"');
        h += _field('gd_pwfd', 'Flowing pressure for rate readout, absolute (psia)', 1000);
        h += _field('gd_qt', 'Target rate for pressure readout (MSCFD)', 5000);
        h += '</div></div>';
        // Card 2 — test points
        h += '<div class="card"><div class="card-title">Test Points</div>';
        h += '<div style="overflow-x:auto"><table class="dtable" id="gd_pts"><thead><tr>' +
            '<th>#</th><th>Point type</th>' +
            '<th data-wts-unit-label="gasRateSmall">Rate q (MSCFD)</th>' +
            '<th data-wts-unit-label="pressure">pwf, abs (psia)</th>' +
            '<th data-wts-unit-label="pressure">pws before flow, abs (psia)</th>' +
            '</tr></thead><tbody>';
        for (var i = 1; i <= NROWS; i++) {
            var d = DEF_ROWS[i - 1] || ['', ''];
            var cell = function (id, val, aria) {
                return '<td><input type="number" step="any" id="' + id + '" value="' + val + '" aria-label="' + aria + '" style="width:100%;min-width:72px"></td>';
            };
            h += '<tr><td>' + i + '</td>' +
                '<td>' + _select(P + 'k' + i, KINDS, i <= 3 ? 'stab' : 'trans', 'Point ' + i + ' type') + '</td>' +
                cell(P + 'q' + i, d[0], 'Point ' + i + ' rate q') +
                cell(P + 'pwf' + i, d[1], 'Point ' + i + ' flowing pressure pwf') +
                cell(P + 'pws' + i, '', 'Point ' + i + ' shut-in pressure before flow pws') +
                '</tr>';
        }
        h += '</tbody></table></div>';
        h += '<div class="info-bar" style="margin-top:12px">A row is used when both rate and pwf are filled in. pws is only needed for transient points of a modified isochronal test. All pressures absolute.</div>';
        h += '<div id="gd_csv_host"></div>';
        h += '<div class="btn-row"><button class="btn btn-primary" id="gd_go" onclick="calcGasDeliv()">Calculate</button></div>';
        h += '</div>';
        h += '</div><div style="min-width:0"><div id="gd_res"></div></div></div></div>';
        return h;
    }

    function renderGasDeliverability(body) {
        body = body || _byId('pgBody');
        if (!body) return;
        var t = _byId('pgTitle'), s = _byId('pgSub');
        if (t) t.textContent = TITLE;
        if (s) s.textContent = SUB;
        body.innerHTML = _pageHtml();
        _tag(UNITS);
        if (G.WTS_csv && typeof G.WTS_csv.mountImporter === 'function') G.WTS_csv.mountImporter(_byId('gd_csv_host'), CSV_SPEC, _applyCsv);
        var root = _byId('gd_root');
        if (root && root.addEventListener) {
            root.addEventListener('change', function (e) {
                var id = e && e.target && e.target.id;
                if (id && id.indexOf(P) === 0) G.calcGasDeliv();
            });
        }
        G.calcGasDeliv();
    }
    G.renderGasDeliverability = renderGasDeliverability;

    // ── Calc (DOM) ───────────────────────────────────────────────────
    function _readInputs() {
        var tEl = _byId('gd_type');
        var type = tEl ? String(tEl.value) : 'faf';
        var pts = [];
        for (var i = 1; i <= NROWS; i++) {
            if (_blank(P + 'q' + i) && _blank(P + 'pwf' + i)) continue;
            var kEl = _byId(P + 'k' + i);
            pts.push({ row: i, kind: kEl ? String(kEl.value) : 'trans', q: _num(P + 'q' + i), pwf: _num(P + 'pwf' + i), pws: _num(P + 'pws' + i) });
        }
        return {
            type: type, pr: _num('gd_pr'), pb: _num('gd_pb'), nAssumed: _num('gd_nass'),
            pwfDesign: _num('gd_pwfd'), qTarget: _num('gd_qt'), points: pts
        };
    }

    function _row(l, v) { return '<div class="rrow"><span class="rl">' + l + '</span><span class="rv">' + v + '</span></div>'; }
    // Metric companions of the field-unit coefficients (v3.0). The equations are
    // unit-specific, so C, a and b stay in field units and Metric mode adds the same
    // equation written in m³/d (at the same base) and kPa:
    //   q[m³/d] = C_SI·(p̄r² − pwf²)[kPa²]ⁿ,  C_SI = C·Kq/Kp^(2n)
    //   Δp²[kPa²] = a_SI·q[m³/d] + b_SI·q²,   a_SI = a·Kp²/Kq,  b_SI = b·Kp²/Kq²
    //   Kq = 28.3168466 m³ per Mscf, Kp = 6.894757293 kPa per psi (exact definitions).
    var KQ = 28.3168466, KP = 6.894757293168;
    function coeffSI(n, C, a, b) {
        return {
            C: (C != null && isFinite(C) && isFinite(n)) ? C * KQ / Math.pow(KP, 2 * n) : null,
            a: (a != null && isFinite(a)) ? a * KP * KP / KQ : null,
            b: (b != null && isFinite(b)) ? b * KP * KP / (KQ * KQ) : null
        };
    }
    G.WTS_gasdeliv_coeffSI = coeffSI;
    function _aofText(q) {
        if (q == null || !isFinite(q)) return '—';
        return _u(q, 'gasRateSmall', 1, 'MSCFD') + ' (' + _u(q / 1000, 'gasRate', 3, 'MMSCFD') + ')';
    }
    var VCOL = { ok: 'var(--green)', warn: 'var(--yellow)', bad: 'var(--red)' };

    function _resultsHtml(r) {
        var cn = r.cn, lit = r.lit, h = '';
        var pwfdTxt = r.pwfDesign != null ? _u(r.pwfDesign, 'pressure', 1, 'psia') : '';
        var qtTxt = r.qTarget != null ? _u(r.qTarget, 'gasRateSmall', 1, 'MSCFD') : '';
        // 1 — back-pressure
        h += '<div class="rbox"><div class="rbox-title">Back-pressure Equation — q = C (p̄r² − pwf²)ⁿ</div>';
        h += _row('Points used', _fmt(r.type === 'single' ? 1 : r.points.length, 0) + ' (' + TYPE_SHORT[r.type] + ')');
        h += _row('Exponent n', cn.n.toFixed(4));
        h += _row('Coefficient C', cn.C.toExponential(4) + ' MSCFD/psia²ⁿ');
        if (_metric()) h += _row('Coefficient C (metric: q in m³/d, p in kPa)', coeffSI(cn.n, cn.C).C.toExponential(4) + ' (m³/d)/kPa²ⁿ');
        if (cn.r2 != null) h += _row('Fit R² (log–log)', cn.r2.toFixed(4));
        h += _row('AOF', _aofText(cn.aof));
        if (r.pwfDesign != null) h += _row('Rate at pwf = ' + pwfdTxt, _u(cn.qAtPwf, 'gasRateSmall', 1, 'MSCFD'));
        if (r.qTarget != null) h += _row('pwf at q = ' + qtTxt, cn.qAboveAof ? 'above AOF' : _u(cn.pwfAtQ, 'pressure', 1, 'psia'));
        h += '</div>';
        // 2 — LIT
        h += '<div class="rbox"><div class="rbox-title">LIT Equation — p̄r² − pwf² = a·q + b·q²</div>';
        if (r.type === 'single') {
            h += _row('Status', 'LIT needs at least two points');
        } else {
            h += _row('a', lit.a != null ? lit.a.toFixed(2) + ' psia²/MSCFD' : '—');
            h += _row('b', lit.b != null ? lit.b.toExponential(4) + ' psia²/(MSCFD)²' : '—');
            if (_metric() && lit.a != null && lit.b != null) {
                var si = coeffSI(null, null, lit.a, lit.b);
                h += _row('a (metric: kPa², m³/d)', _fmt(si.a, 4) + ' kPa²/(m³/d)');
                h += _row('b (metric: kPa², m³/d)', si.b.toExponential(4) + ' kPa²/(m³/d)²');
            }
            h += _row('AOF', lit.ok ? _aofText(lit.aof) : '—');
            if (r.pwfDesign != null) h += _row('Rate at pwf = ' + pwfdTxt, lit.ok ? _u(lit.qAtPwf, 'gasRateSmall', 1, 'MSCFD') : '—');
            if (r.qTarget != null) h += _row('pwf at q = ' + qtTxt, !lit.ok ? '—' : (lit.qAboveAof ? 'above AOF' : _u(lit.pwfAtQ, 'pressure', 1, 'psia')));
            h += _row('Non-Darcy share of drawdown at AOF', lit.ok ? _fmt(lit.nonDarcyPct, 1) + ' %' : '—');
        }
        h += '</div>';
        // 3 — verdicts (direct children of _res so each is its own report callout)
        r.verdicts.forEach(function (x) {
            h += '<div style="color:' + (VCOL[x.level] || 'var(--yellow)') + ';margin:6px 0;font-size:13px">' + x.text + '</div>';
        });
        // 4 — deliverability table (values written already converted)
        h += '<div class="rbox"><div class="rbox-title">Deliverability Table</div><div style="overflow-x:auto"><table class="dtable"><thead><tr>' +
            '<th data-wts-unit-label="pressure">pwf (' + _lab('pressure', 'psia') + ')</th>' +
            '<th data-wts-unit-label="gasRateSmall">q (C and n) (' + _lab('gasRateSmall', 'MSCFD') + ')</th>' +
            '<th data-wts-unit-label="gasRateSmall">q (LIT) (' + _lab('gasRateSmall', 'MSCFD') + ')</th>' +
            '</tr></thead><tbody>';
        r.table.forEach(function (t) {
            h += '<tr><td>' + _fmt(_dv(t.pwf, 'pressure'), 1) + '</td><td>' + _fmt(_dv(t.qCn, 'gasRateSmall'), 1) + '</td><td>' +
                (t.qLit == null ? '—' : _fmt(_dv(t.qLit, 'gasRateSmall'), 1)) + '</td></tr>';
        });
        h += '</tbody></table></div></div>';
        // 5 — chart
        h += '<div class="chart-wrap"><canvas id="gd_chart" width="600" height="340"></canvas></div>';
        // 6 — notes
        h += '<div><b>Notes</b> AOF is the rate at a sandface back-pressure of ' + _u(r.pb, 'pressure', 2, 'psia') +
            '. Pressures are squared (p² method), which is adequate below about 2,000 psia or where μZ is nearly constant; use pseudo-pressure analysis in PRiSM for high-pressure gas. ' +
            _basisNote() + '</div>';
        return h;
    }

    // The analysis is basis-neutral: C, a, b and the AOF come out in the same
    // standard-volume basis as the entered rates — say which basis that is.
    function _basisNote() {
        var B = G.WTS_baseConditions, b = B && B.get ? B.get() : null;
        if (!b || b.perCalc) return 'Rates (and the AOF) are in the standard-volume basis of the entered test rates; no base-condition conversion is applied.';
        return 'Rates (and the AOF) are standard volumes at ' + B.text(b) + ' (app setting) — enter the test rates on that basis.';
    }

    function _drawChart(r) {
        var cv = _byId('gd_chart');
        if (!cv || typeof drawLineChart !== 'function') return;   // host-scope helper when injected
        var cnPts = [], litPts = [];
        r.table.slice().reverse().forEach(function (t) {
            cnPts.push({ x: _dv(t.qCn, 'gasRateSmall'), y: _dv(t.pwf, 'pressure') });
            if (t.qLit != null) litPts.push({ x: _dv(t.qLit, 'gasRateSmall'), y: _dv(t.pwf, 'pressure') });
        });
        var testPts = r.points.map(function (u) { return { x: _dv(u.q, 'gasRateSmall'), y: _dv(u.pwf, 'pressure') }; })
            .sort(function (a, b) { return a.x - b.x; });
        var ds = [{ label: 'C and n', color: '#f0883e', data: cnPts, points: false, width: 2 }];
        if (litPts.length) ds.push({ label: 'LIT', color: '#58a6ff', data: litPts, points: false, dash: [6, 4], width: 2 });
        ds.push({ label: 'Test points', color: '#3fb950', data: testPts, points: true, width: 0.001 });
        try {
            drawLineChart(cv, ds, {
                xLabel: 'Gas rate (' + _lab('gasRateSmall', 'MSCFD') + ')',
                yLabel: 'pwf (' + _lab('pressure', 'psia') + ')', xMin: 0, yMin: 0, xDec: 0, yDec: 0
            });
        } catch (e) { /* chart is cosmetic */ }
    }

    function _calcImpl() {
        var res = _byId('gd_res'), root = _byId('gd_root');
        if (root && root.querySelectorAll) {
            var all = root.querySelectorAll('input, select');
            for (var i = 0; i < all.length; i++) if (all[i].classList) all[i].classList.remove('input-err');
        }
        var inp = _readInputs();
        var r = compute(inp);
        G.WTS_state = G.WTS_state || {};
        if (!r.ok) {
            G.WTS_state.gasdeliv = { ok: false, type: inp.type, errors: r.errors.slice(), aofCn: null, aofLit: null, ts: Date.now() };
            if (res) {
                res.innerHTML = '<div class="val-error"><strong>Please fix the following:</strong><ul>' +
                    r.errors.map(function (m) { return '<li>' + m + '</li>'; }).join('') + '</ul></div>';
                res.setAttribute('data-done', '1');
            }
            r.errorIds.forEach(function (id) { var e = id && _byId(id); if (e && e.classList) e.classList.add('input-err'); });
            return r;
        }
        G.WTS_state.gasdeliv = {
            ok: true, type: r.type, pr: r.pr, pb: r.pb, n: r.cn.n, C: r.cn.C, r2: r.cn.r2, aofCn: r.cn.aof,
            a: r.lit.a, b: r.lit.b, aofLit: r.lit.ok ? r.lit.aof : null,
            qAtPwfCn: r.cn.qAtPwf, pwfAtQCn: r.cn.pwfAtQ, qAtPwfLit: r.lit.qAtPwf, pwfAtQLit: r.lit.pwfAtQ,
            nonDarcyPct: r.lit.nonDarcyPct, ts: Date.now()
        };
        if (res) {
            res.innerHTML = _resultsHtml(r);
            _drawChart(r);
            res.setAttribute('data-done', '1');
        }
        return r;
    }
    G.calcGasDeliv = function () { return _canon(_calcImpl); };

    // Unit flip → recalc (results are formatted in the display system).
    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('wts:unit-system-changed', function () {
            var r = _byId('gd_res');
            if (r && r.getAttribute && r.getAttribute('data-done') === '1') G.calcGasDeliv();
        });
        document.addEventListener('wts:base-conditions-changed', function () {
            var r = _byId('gd_res');
            if (r && r.getAttribute && r.getAttribute('data-done') === '1') G.calcGasDeliv();
        });
    }

    // ── Round-9 registration (merge, never replace) ──────────────────
    G.WTS_calcRegistry = G.WTS_calcRegistry || {};
    G.WTS_calcRegistry.gasdeliv = {
        key: 'gasdeliv',
        title: TITLE,
        navTitle: 'Gas Deliverability & AOF',
        sub: SUB,
        group: 'Production & Reservoir',
        icon: '&#8599;',
        badge: 'Production',
        bc: 'dc-b-green',
        desc: 'Back-pressure (C and n) and LIT analysis of flow-after-flow, isochronal and modified isochronal tests: AOF, IPR table and plot.',
        render: function (body) { G.renderGasDeliverability(body); }
    };
})();

// ─── END 41-calc-gasdeliv ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 42-calc-oilipr ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════
// 42-calc-oilipr.js — Oil Well IPR (plug-in calculator, Round 9)
//
// Registers window.WTS_calcRegistry.oilipr. The host adds the route, the
// sidebar button (Production & Reservoir) and the dashboard tile.
//
// Inflow performance from one or more stabilised test points:
//   • Straight-line PI:          q = J·(p̄r − pwf)
//   • Vogel (saturated, pb ≥ p̄r) with Standing's flow efficiency FE
//   • Composite (p̄r > pb):       PI above pb, Vogel below pb
//   • Fetkovich multipoint:       q = C·(p̄r² − pwf²)ⁿ  (log-log least squares)
//   • Future IPR:                 Vogel cube rule / Fetkovich C·(prf/p̄r)
//
// References
//   Vogel, J.V. (1968) "Inflow Performance Relationships for Solution-Gas
//     Drive Wells", JPT 20(1) 83-92.  V(x) = 1 − 0.2x − 0.8x², x = pwf/p̄r.
//   Standing, M.B. (1970) "Inflow Performance Relationships for Damaged
//     Wells Producing by Solution-Gas Drive", JPT 22(11) 1399-1400.
//     pwf′ = p̄r − FE·(p̄r − pwf).
//   Fetkovich, M.J. (1973) "The Isochronal Testing of Oil Wells", SPE 4529.
//     q = C·(p̄r² − pwf²)ⁿ; future C_f = C·(p̄r,f / p̄r).
//   Fetkovich / Eickmeier future Vogel: qmax,f = qmax·(p̄r,f / p̄r)³.
//   Brown, K.E., Technology of Artificial Lift Methods, Vol. 1 — composite
//     IPR: q_b = J·(p̄r − pb), q_v = J·pb/1.8.
//
// Units: field units throughout (psia, BPD). The units layer converts the
// tagged inputs; calcOilIPR reads imperial inside a canonical context.
//
// Public API (window.*)
//   WTS_oilipr_compute(input[, fmt])  pure, field units in and out, no DOM
//   renderOilIPR(body)                paints the page into body
//   calcOilIPR()                      read DOM → validate → compute → render
//   WTS_oilipr_fetkCMetric(C, n)      Fetkovich C (BPD/psia²ⁿ) → m³/d/kPa²ⁿ (shown in Metric mode)
//   WTS_state.oilipr                  last result {ok, mode, J, qb, qmax, C, CMetric, …}
// ═══════════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    var G = (typeof window !== 'undefined') ? window : globalThis;
    var P = 'oi_';
    var NPTS = 4;
    var METHODS = ['vogel', 'fetk', 'pi'];
    var METHOD_LABEL = { vogel: 'Vogel / composite (automatic)', fetk: 'Fetkovich (multipoint)', pi: 'Straight-line PI' };
    var MODE_LABEL = {
        'vogel-sat': 'Vogel (saturated)',
        'composite': 'Composite (PI above pb, Vogel below)',
        'fetkovich': 'Fetkovich (C and n)',
        'pi': 'Straight-line PI'
    };
    var TITLE = 'Oil Well IPR';
    var SUB = 'Inflow performance from a test point — straight-line PI, Vogel, composite (above and below bubble point) and Fetkovich, with flow efficiency and future IPR';

    // ── Page helpers (shared calculator pattern) ─────────────────────────
    function _byId(id) { return (typeof document !== 'undefined' && document.getElementById) ? document.getElementById(id) : null; }
    function _num(id) { var e = _byId(id); if (!e) return NaN; var s = String(e.value).trim(); return s === '' ? NaN : parseFloat(s); }
    function _fmt(v, d) { if (v == null || !isFinite(v)) return '—'; return (G.WTS_fmtNum ? G.WTS_fmtNum(v, 0, (d == null ? 2 : d)) : Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: (d == null ? 2 : d) })); }
    function _fix(v, d) { if (v == null || !isFinite(v)) return '—'; return Number(v).toFixed(d); }
    function _metric() { var U = G.WTS_units; return !!(U && U.getSystem && U.getSystem() === 'metric' && U.format); }
    // value in the display system; impLabel is the imperial text ('psia' where the category says 'psi')
    function _u(v, cat, d, impLabel) {
        var U = G.WTS_units;
        if (_metric()) { var f = U.format(v, cat); return _fmt(f.value, d) + ' ' + f.label; }
        return _fmt(v, d) + ' ' + impLabel;
    }
    function _disp(v, cat) { if (v == null || !isFinite(v)) return v; return _metric() ? G.WTS_units.format(v, cat).value : v; }
    function _lab(cat, impLabel) { return _metric() ? G.WTS_units.format(0, cat).label : impLabel; }
    function _tag(map) { var U = G.WTS_units; if (!U || !U.tagInput) return; for (var id in map) U.tagInput(id, map[id]); }
    function _canon(fn) { var U = G.WTS_units; return (U && U.runCanonical) ? U.runCanonical(fn) : fn(); }

    function _blankV(v) { return v == null || v === '' || (typeof v === 'number' && isNaN(v)); }
    function _n(v) { return _blankV(v) ? NaN : Number(v); }

    // Field-unit text formatters (the page swaps in display-unit versions)
    var FIELD_FMT = {
        p: function (v) { return _fmt(v, 1) + ' psia'; },
        q: function (v) { return _fmt(v, 1) + ' BPD'; }
    };

    // ── Engineering core ────────────────────────────────────────────────
    // Vogel (1968) dimensionless IPR
    function V(x) { return 1 - 0.2 * x - 0.8 * x * x; }
    // Inverse of V: V(x) = y → x = [−0.2 + √(0.04 + 3.2·(1 − y))]/1.6
    function Vinv(y) { return (-0.2 + Math.sqrt(0.04 + 3.2 * (1 - y))) / 1.6; }

    function _validate(inp, fmt) {
        var errors = [], keys = [];
        function err(key, msg) { errors.push(msg); keys.push(key); }
        var method = inp.method == null ? 'vogel' : String(inp.method);
        if (METHODS.indexOf(method) === -1) { err('method', 'Unknown IPR method.'); method = 'vogel'; }
        var pr = _n(inp.pr), pb = _n(inp.pb), fe = _blankV(inp.fe) ? 1 : _n(inp.fe);
        var pwfd = _n(inp.pwfDesign), qt = _n(inp.qTarget), prf = _n(inp.prFuture);
        var prOk = false;
        if (!isFinite(pr)) err('pr', 'Average reservoir pressure is required.');
        else if (pr <= 0) err('pr', 'Average reservoir pressure must be above 0.');
        else if (pr < 50 || pr > 30000) err('pr', 'Average reservoir pressure must be between ' + fmt.p(50) + ' and ' + fmt.p(30000) + '.');
        else prOk = true;

        if (method === 'vogel') {
            if (!isFinite(pb)) err('pb', 'Bubble-point pressure is required for the Vogel / composite method.');
            else if (pb < 0) err('pb', 'Bubble-point pressure cannot be negative.');
            else if (pb > 30000) err('pb', 'Bubble-point pressure must not exceed ' + fmt.p(30000) + '.');
        }
        if (!isFinite(fe) || fe < 0.3 || fe > 2.0) err('fe', 'Flow efficiency FE must be between 0.3 and 2.0.');
        if (!_blankV(inp.pwfDesign)) {
            if (!isFinite(pwfd) || pwfd < 0) err('pwfd', 'Flowing pressure for the rate readout cannot be negative.');
            else if (prOk && pwfd >= pr) err('pwfd', 'Flowing pressure for the rate readout must be below the average reservoir pressure.');
        }
        if (!_blankV(inp.qTarget) && (!isFinite(qt) || qt <= 0)) err('qt', 'Target rate for the pressure readout must be above 0.');
        if (!_blankV(inp.prFuture)) {
            if (!isFinite(prf) || prf <= 0) err('prf', 'Future average reservoir pressure must be above 0.');
            else if (prOk && prf >= pr) err('prf', 'Future average reservoir pressure must be below the current average reservoir pressure.');
        }

        var raw = Array.isArray(inp.points) ? inp.points : [];
        var used = [], row1 = null;
        for (var i = 0; i < Math.min(raw.length, NPTS); i++) {
            var pt = raw[i] || {}, k = i + 1;
            var qb = _blankV(pt.q), pbk = _blankV(pt.pwf);
            if (qb && pbk) continue;
            if (qb || pbk) { err(qb ? 'q' + k : 'pwf' + k, 'Test point ' + k + ': enter both the rate and the flowing pressure.'); continue; }
            var q = _n(pt.q), pwf = _n(pt.pwf), good = true;
            if (!isFinite(q) || q <= 0) { err('q' + k, 'Test point ' + k + ': rate must be above 0.'); good = false; }
            if (!isFinite(pwf) || pwf < 0) { err('pwf' + k, 'Test point ' + k + ': flowing pressure cannot be negative.'); good = false; }
            else if (prOk && pwf >= pr) { err('pwf' + k, 'Test point ' + k + ': flowing pressure must be below the average reservoir pressure.'); good = false; }
            if (good) { var o = { q: q, pwf: pwf, row: k }; used.push(o); if (k === 1) row1 = o; }
        }
        if ((method === 'vogel' || method === 'pi') && !row1 && _blankV((raw[0] || {}).q) && _blankV((raw[0] || {}).pwf)) {
            err('q1', 'Test point 1 is required for the ' + METHOD_LABEL[method] + ' method.');
        }
        if (method === 'fetk') {
            if (!used.length && !errors.some(function (m, j) { return /^(q|pwf)\d$/.test(keys[j]); })) err('q1', 'Fetkovich needs at least one test point.');
            for (var a = 0; a < used.length; a++) for (var b = a + 1; b < used.length; b++) {
                if (used[a].pwf === used[b].pwf) err('pwf' + used[b].row, 'Test points ' + used[a].row + ' and ' + used[b].row + ' have the same flowing pressure — Fetkovich needs distinct pressures.');
            }
        }
        return { errors: errors, keys: keys, method: method, pr: pr, pb: pb, fe: fe, pwfd: pwfd, qt: qt, prf: prf, used: used, row1: row1 };
    }

    // Pure compute — field units in and out.
    //   input: {method, pr, pb, fe, pwfDesign, qTarget, prFuture, points:[{q, pwf}]}
    //   fmt (optional): {p(v), q(v)} text formatters for messages (default field units)
    function compute(input, fmt) {
        fmt = fmt || FIELD_FMT;
        var v = _validate(input || {}, fmt);
        var out = {
            ok: false, errors: v.errors, errorKeys: v.keys, warnings: [], verdicts: [], mode: null,
            J: null, qb: null, qmax: null, qmaxFE1: null, pwfLimitFE: null, n: null, C: null, r2: null,
            qAtPwf: null, pwfAtQ: null, future: null, table: [], points: v.used
        };
        if (v.errors.length) return out;

        var pr = v.pr, fe = v.fe, prf = v.prf, method = v.method;
        var hasPwfd = isFinite(v.pwfd), hasQt = isFinite(v.qt), hasPrf = isFinite(prf);
        var qAt, pwfAt, qfAt = null;          // q(pwf) → {q, held}; pwf(q) → number|null
        function warn(level, text) { out.verdicts.push({ level: level, text: text }); out.warnings.push(text); }
        function fail(key, msg) { out.errors.push(msg); out.errorKeys.push(key); return out; }

        if (method === 'pi') {
            // (1) Straight-line PI: J = q₁/(p̄r − pwf₁); q = J·(p̄r − pwf)
            var t = v.row1;
            var J = t.q / (pr - t.pwf);
            out.mode = 'pi'; out.J = J; out.qmax = J * pr;
            qAt = function (pwf) { return { q: J * (pr - pwf), held: false }; };
            pwfAt = function (q) { return pr - q / J; };
            if (isFinite(v.pb) && v.pb > t.pwf) warn('warn', '⚠ Test pwf is below the bubble point — a straight-line PI overstates the rate; use Vogel/composite.');
            if (hasPrf) warn('warn', '⚠ Future IPR is available for saturated Vogel and Fetkovich only.');
        } else if (method === 'vogel' && v.pb >= pr) {
            // (2) Saturated Vogel with Standing (1970) flow efficiency
            var t2 = v.row1;
            var pwf1p = pr - fe * (pr - t2.pwf);
            if (pwf1p < 0) {
                return fail('pwf1', 'Test point 1 lies below the flow-efficiency validity limit (pwf = ' + fmt.p(pr * (1 - 1 / fe)) + '), so qmax cannot be backed out. Use a test point above this pressure or a lower FE.');
            }
            var qm1 = t2.q / V(pwf1p / pr);
            out.mode = 'vogel-sat';
            out.qmaxFE1 = qm1;
            out.qmax = fe <= 1 ? qm1 * V(1 - fe) : qm1;
            if (fe > 1) out.pwfLimitFE = pr * (1 - 1 / fe);
            var mkQ = function (p, qmax1) {
                return function (pwf) {
                    var pp = p - fe * (p - pwf);
                    if (pp < 0) return { q: qmax1, held: true };
                    return { q: qmax1 * V(pp / p), held: false };
                };
            };
            var mkPwf = function (p, qmax1) {
                return function (q) { var x = Vinv(q / qmax1); return p - (p - x * p) / fe; };
            };
            qAt = mkQ(pr, qm1);
            pwfAt = mkPwf(pr, qm1);
            if (fe > 1) warn('warn', '⚠ Standing\'s FE > 1 curve is valid down to pwf = ' + fmt.p(out.pwfLimitFE) + '; below that the rate is held at qmax (FE = 1).');
            if (hasPrf) {
                // Fetkovich/Eickmeier cube rule
                var qmf1 = qm1 * Math.pow(prf / pr, 3);
                qfAt = mkQ(prf, qmf1);
                out.future = { pr: prf, qmaxFE1: qmf1, qmax: fe <= 1 ? qmf1 * V(1 - fe) : qmf1, qAtPwf: null };
            }
        } else if (method === 'vogel') {
            // (3) Composite (undersaturated): PI above pb, Vogel below pb
            var pb = v.pb, t3 = v.row1, Jc;
            if (t3.pwf >= pb) Jc = t3.q / (pr - t3.pwf);
            else Jc = t3.q / ((pr - pb) + (pb / 1.8) * V(t3.pwf / pb));
            var qbub = Jc * (pr - pb), qv = Jc * pb / 1.8;
            out.mode = 'composite'; out.J = Jc; out.qb = qbub; out.qmax = qbub + qv;
            qAt = function (pwf) { return { q: pwf >= pb ? Jc * (pr - pwf) : qbub + qv * V(pwf / pb), held: false }; };
            pwfAt = function (q) { return q <= qbub ? pr - q / Jc : pb * Vinv((q - qbub) / qv); };
            if (fe !== 1) warn('warn', '⚠ Flow efficiency applies to saturated (Vogel) wells only — FE ignored.');
            if (hasPrf) warn('warn', '⚠ Future IPR is available for saturated Vogel and Fetkovich only.');
        } else {
            // (4) Fetkovich (1973): log10 q = log10 C + n·log10(p̄r² − pwf²)
            var pts = v.used, m = pts.length, n, C, r2 = null;
            if (m === 1) {
                n = 1; C = pts[0].q / (pr * pr - pts[0].pwf * pts[0].pwf);
                warn('warn', '⚠ One point — n assumed 1.0.');
            } else {
                var X = [], Y = [], sx = 0, sy = 0;
                for (var i = 0; i < m; i++) {
                    X.push(Math.log10(pr * pr - pts[i].pwf * pts[i].pwf)); Y.push(Math.log10(pts[i].q));
                    sx += X[i]; sy += Y[i];
                }
                var xb = sx / m, yb = sy / m, sxx = 0, sxy = 0, syy = 0;
                for (i = 0; i < m; i++) { sxx += (X[i] - xb) * (X[i] - xb); sxy += (X[i] - xb) * (Y[i] - yb); syy += (Y[i] - yb) * (Y[i] - yb); }
                n = sxy / sxx;
                C = Math.pow(10, yb - n * xb);
                if (m >= 3) {
                    var ssr = 0;
                    for (i = 0; i < m; i++) { var e = Y[i] - (Math.log10(C) + n * X[i]); ssr += e * e; }
                    r2 = syy > 0 ? 1 - ssr / syy : 1;
                }
                if (!(n > 0) || !isFinite(C)) {
                    return fail('q1', 'The Fetkovich fit gives n ≤ 0 — rates must increase as the flowing pressure falls. Check the test points.');
                }
            }
            out.mode = 'fetkovich'; out.n = n; out.C = C; out.r2 = r2;
            out.qmax = C * Math.pow(pr, 2 * n);
            qAt = function (pwf) { return { q: C * Math.pow(pr * pr - pwf * pwf, n), held: false }; };
            pwfAt = function (q) { return Math.sqrt(pr * pr - Math.pow(q / C, 1 / n)); };
            if (m > 1 && (n < 0.5 || n > 1.0)) warn('warn', '⚠ Fetkovich exponent n = ' + _fix(n, 4) + ' is outside 0.5–1.0 — check the test points for unstabilised or non-Darcy data.');
            if (hasPrf) {
                var Cf = C * (prf / pr);
                qfAt = function (pwf) { return { q: Cf * Math.pow(prf * prf - pwf * pwf, n), held: false }; };
                out.future = { pr: prf, C: Cf, qmax: Cf * Math.pow(prf, 2 * n), qAtPwf: null };
            }
        }

        // Readouts
        if (hasPwfd) out.qAtPwf = qAt(v.pwfd).q;
        if (hasQt) {
            if (v.qt >= out.qmax) warn('bad', '✗ Target rate exceeds the maximum rate ' + fmt.q(out.qmax) + '.');
            else out.pwfAtQ = pwfAt(v.qt);
        }
        if (out.future && hasPwfd && v.pwfd < prf) out.future.qAtPwf = qfAt(v.pwfd).q;

        // (6) IPR table: pwf_k = p̄r·(1 − k/10), k = 0…10
        for (var k = 0; k <= 10; k++) {
            var pw = pr * (1 - k / 10), r = qAt(pw), rf = (qfAt && pw < prf) ? qfAt(pw) : null;
            out.table.push({ pwf: pw, q: r.q, qf: rf ? rf.q : null, heldAtMax: r.held, heldFuture: rf ? rf.held : false });
        }
        // Dense curves for the chart
        out.curve = []; out.curveF = [];
        for (var c = 0; c <= 40; c++) {
            var pc = pr * (1 - c / 40);
            out.curve.push({ pwf: pc, q: qAt(pc).q });
            if (qfAt) { var pcf = prf * (1 - c / 40); out.curveF.push({ pwf: pcf, q: qfAt(pcf).q }); }
        }
        out.ok = true;
        return out;
    }
    G.WTS_oilipr_compute = compute;

    // Fetkovich C in metric. q = C·(p̄r² − pwf²)ⁿ holds in any consistent units, so
    // with q_m = fq·q (m³/d per BPD) and p_m = fp·p (kPa per psi):
    //   q_m = fq·C·((p̄r_m² − pwf_m²)/fp²)ⁿ  →  C_m = fq·C / fp^(2n)   [m³/d/kPa²ⁿ].
    // fq and fp are the units layer's own factors (liquidRate, pressure) so C_m is
    // consistent with the metric pressures and rates shown on the page.
    function fetkCMetric(C, n) {
        var U = G.WTS_units, fq = 0.158987294928, fp = 6.894757;
        if (U && U.CATEGORIES && U.CATEGORIES.liquidRate && U.CATEGORIES.pressure) {
            fq = U.CATEGORIES.liquidRate.imperial.factor / U.CATEGORIES.liquidRate.metric.factor;
            fp = U.CATEGORIES.pressure.imperial.factor / U.CATEGORIES.pressure.metric.factor;
        }
        return fq * C / Math.pow(fp, 2 * n);
    }
    G.WTS_oilipr_fetkCMetric = fetkCMetric;

    // ── Page ─────────────────────────────────────────────────────────────
    var UNITS = { oi_pr: 'pressure', oi_pb: 'pressure', oi_pwfd: 'pressure', oi_prf: 'pressure', oi_qt: 'liquidRate' };
    for (var ui = 1; ui <= NPTS; ui++) { UNITS['oi_q' + ui] = 'liquidRate'; UNITS['oi_pwf' + ui] = 'pressure'; }

    // CSV paste / file import of the test points (host WTS_csv, P9): q and pwf,
    // converted to BPD / psia; values without a unit are in the page's units.
    var CSV_SPEC = {
        maxRows: NPTS, positional: ['q', 'pwf'], aria: 'Test points as CSV',
        columns: [
            { key: 'q', label: 'Rate q', kind: 'liquidRate', cat: 'liquidRate', required: true, positive: true,
              names: ['q', 'qo', 'ql', 'rate', 'rate q', 'oil rate', 'liquid rate', 'flow rate', 'q oil', 'test rate'] },
            { key: 'pwf', label: 'pwf', kind: 'pressure', cat: 'pressure', required: true, positive: true,
              names: ['pwf', 'p wf', 'pwf abs', 'flowing pressure', 'bottomhole flowing pressure', 'bhfp', 'fbhp'] }
        ],
        hint: 'One row per test point (up to ' + NPTS + '). Header names q and pwf in any order, units in brackets, e.g. <b>q (STB/d)</b>, <b>q [m3/d]</b>, ' +
            '<b>pwf (psig)</b>, <b>bar</b>, <b>kPa(a)</b>. Without a header the order is q, pwf. Comma, semicolon or tab separated. ' +
            'Values without a unit are read in the units shown in the table. Gauge pressures are made absolute with 1 atm.',
        example: 'q (BPD),pwf (psia)\n100,1800\n160,1400'
    };
    function _applyCsv(res) {
        var n = res.rows.length;
        _canon(function () {
            for (var i = 1; i <= NPTS; i++) {
                var r = res.rows[i - 1];
                var eq = _byId('oi_q' + i), ep = _byId('oi_pwf' + i);
                if (eq) eq.value = (r && isFinite(r.q)) ? String(r.q) : '';
                if (ep) ep.value = (r && isFinite(r.pwf)) ? String(r.pwf) : '';
            }
        });
        G.calcOilIPR();
        return 'Imported ' + n + ' test point' + (n === 1 ? '' : 's') + (n < NPTS ? '; rows ' + (n + 1) + '–' + NPTS + ' cleared.' : '.');
    }

    function _field(id, label, val, extra) {
        return '<div class="fg-item"><label for="' + id + '">' + label + '</label>' +
            '<input type="number" id="' + id + '" value="' + val + '" step="any"' + (extra || '') + '></div>';
    }

    function render(body) {
        if (!body) body = _byId('pgBody');
        if (!body) return;
        var t = _byId('pgTitle'), s = _byId('pgSub');
        if (t) t.textContent = TITLE;
        if (s) s.textContent = SUB;
        var opts = METHODS.map(function (m) { return '<option value="' + m + '"' + (m === 'vogel' ? ' selected' : '') + '>' + METHOD_LABEL[m] + '</option>'; }).join('');
        var rows = '';
        for (var i = 1; i <= NPTS; i++) {
            rows += '<tr><td>' + i + '</td>' +
                '<td><input type="number" id="oi_q' + i + '" value="' + (i === 1 ? '100' : '') + '" step="any" style="width:100%;min-width:72px" aria-label="Test point ' + i + ' rate q"></td>' +
                '<td><input type="number" id="oi_pwf' + i + '" value="' + (i === 1 ? '1800' : '') + '" step="any" style="width:100%;min-width:72px" aria-label="Test point ' + i + ' flowing pressure pwf, absolute"></td></tr>';
        }
        body.innerHTML =
            '<div id="oi_root"><div class="cols-2">' +
            '<div>' +
            '<div class="card"><div class="card-title">Reservoir &amp; Method</div><div class="fg">' +
            '<div class="fg-item"><label for="oi_method">IPR method</label><select id="oi_method">' + opts + '</select></div>' +
            _field('oi_pr', 'Average reservoir pressure, absolute (psia)', '2400') +
            _field('oi_pb', 'Bubble-point pressure, absolute (psia)', '2400') +
            _field('oi_fe', 'Flow efficiency FE, Standing', '1.0') +
            _field('oi_pwfd', 'Flowing pressure for rate readout, absolute (psia)', '1200') +
            _field('oi_qt', 'Target rate for pressure readout (BPD)', '150') +
            _field('oi_prf', 'Future average reservoir pressure, absolute (psia)', '') +
            '</div></div>' +
            '<div class="card"><div class="card-title">Test Points</div>' +
            '<div style="overflow-x:auto"><table class="dtable" id="oi_pts"><thead><tr><th>#</th>' +
            '<th data-wts-unit-label="liquidRate">Rate q (' + _lab('liquidRate', 'BPD') + ')</th>' +
            '<th data-wts-unit-label="pressure">pwf, abs (' + _lab('pressure', 'psia') + ')</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
            '<div style="font-size:12px;color:var(--text2);margin-top:6px">Vogel and straight-line PI use test point 1; Fetkovich fits every filled row.</div>' +
            '<div id="oi_csv_host"></div>' +
            '<div class="btn-row"><button class="btn btn-primary" id="oi_go" onclick="calcOilIPR()">Calculate</button></div>' +
            '</div>' +
            '</div>' +
            '<div><div id="oi_res"></div></div>' +
            '</div></div>';
        _tag(UNITS);
        if (G.WTS_csv && typeof G.WTS_csv.mountImporter === 'function') G.WTS_csv.mountImporter(_byId('oi_csv_host'), CSV_SPEC, _applyCsv);
        var root = _byId('oi_root');
        if (root && root.addEventListener) {
            root.addEventListener('change', function (e) {
                var id = e && e.target && e.target.id;
                if (id && id.indexOf(P) === 0 && id !== 'oi_go') G.calcOilIPR();
            });
        }
        G.calcOilIPR();
    }

    function _row(label, value) { return '<div class="rrow"><span class="rl">' + label + '</span><span class="rv">' + value + '</span></div>'; }

    function _readInputs() {
        var pts = [];
        for (var i = 1; i <= NPTS; i++) pts.push({ q: _num('oi_q' + i), pwf: _num('oi_pwf' + i) });
        var me = _byId('oi_method');
        var m = me ? String(me.value) : 'vogel';
        return {
            method: m, pr: _num('oi_pr'), pb: _num('oi_pb'), fe: _num('oi_fe'),
            pwfDesign: _num('oi_pwfd'), qTarget: _num('oi_qt'), prFuture: _num('oi_prf'), points: pts
        };
    }

    function _calcImpl() {
        var res = _byId('oi_res');
        var root = _byId('oi_root');
        if (root && root.querySelectorAll) {
            var all = root.querySelectorAll('input, select');
            for (var a = 0; a < all.length; a++) if (all[a].classList) all[a].classList.remove('input-err');
        }
        var inp = _readInputs();
        var fmtUI = {
            p: function (v) { return _u(v, 'pressure', 1, 'psia'); },
            q: function (v) { return _u(v, 'liquidRate', 1, 'BPD'); }
        };
        var r = compute(inp, fmtUI);
        G.WTS_state = G.WTS_state || {};
        if (!r.ok) {
            var seen = {};
            r.errorKeys.forEach(function (k) {
                if (seen[k]) return; seen[k] = 1;
                var el = _byId(P + k); if (el && el.classList) el.classList.add('input-err');
            });
            G.WTS_state.oilipr = { ok: false, errors: r.errors.slice(), mode: null, ts: Date.now() };
            if (res) {
                res.removeAttribute('data-done');
                res.innerHTML = '<div class="val-error"><strong>Please fix the following:</strong><ul>' +
                    r.errors.map(function (e) { return '<li>' + _esc(e) + '</li>'; }).join('') + '</ul></div>';
            }
            return r;
        }

        G.WTS_state.oilipr = {
            ok: true, mode: r.mode, J: r.J, qb: r.qb, qmax: r.qmax, qmaxFE1: r.qmaxFE1, n: r.n, C: r.C, r2: r.r2,
            CMetric: r.C != null ? fetkCMetric(r.C, r.n) : null,
            qAtPwf: r.qAtPwf, pwfAtQ: r.pwfAtQ, qmaxFuture: r.future ? r.future.qmax : null,
            qAtPwfFuture: r.future ? r.future.qAtPwf : null, ts: Date.now()
        };
        if (!res) return r;

        var fe = isFinite(inp.fe) ? inp.fe : 1;
        var h = '<div class="rbox"><div class="rbox-title">IPR Result — ' + MODE_LABEL[r.mode] + '</div>';
        if (r.J != null) h += _row('Productivity index J', _metric() ? _u(r.J, 'productivityIndex', 5, 'BPD/psi') : _fix(r.J, 4) + ' BPD/psi');
        if (r.qb != null) h += _row('Rate at bubble point q_b', fmtUI.q(r.qb));
        h += _row('Maximum rate qmax (AOF)', fmtUI.q(r.qmax));
        if (r.mode === 'vogel-sat' && fe !== 1) h += _row('qmax at FE = 1', fmtUI.q(r.qmaxFE1));
        if (r.pwfLimitFE != null) h += _row('FE validity limit pwf', fmtUI.p(r.pwfLimitFE));
        if (r.n != null) h += _row('Fetkovich n', _fix(r.n, 4));
        // Metric C: q[m³/d] = C_m·(p̄r² − pwf²)ⁿ with p in kPa (absolute) →
        //   C_m = C·0.158987 / 6.894757^(2n)   [m³/d/kPa²ⁿ] (the exponent n is unit-free).
        if (r.C != null) h += _row('Fetkovich C', _metric()
            ? Number(fetkCMetric(r.C, r.n)).toExponential(4) + ' m³/d/kPa²ⁿ (n = ' + _fix(r.n, 4) + ')'
            : Number(r.C).toExponential(4) + ' BPD/psia²ⁿ');
        if (r.r2 != null) h += _row('Fit R²', _fix(r.r2, 4));
        if (isFinite(inp.pwfDesign)) h += _row('Rate at pwf = ' + fmtUI.p(inp.pwfDesign), fmtUI.q(r.qAtPwf));
        if (isFinite(inp.qTarget)) h += _row('pwf at q = ' + fmtUI.q(inp.qTarget), r.pwfAtQ == null ? '—' : fmtUI.p(r.pwfAtQ));
        h += '</div>';

        if (r.future) {
            h += '<div class="rbox"><div class="rbox-title">Future IPR at p̄r = ' + fmtUI.p(r.future.pr) + '</div>';
            h += _row('Maximum rate qmax (future)', fmtUI.q(r.future.qmax));
            if (isFinite(inp.pwfDesign)) h += _row('Rate at pwf = ' + fmtUI.p(inp.pwfDesign) + ' (future)', r.future.qAtPwf == null ? '—' : fmtUI.q(r.future.qAtPwf));
            h += '</div>';
        }

        r.verdicts.forEach(function (vd) {
            var col = vd.level === 'bad' ? 'var(--red)' : vd.level === 'ok' ? 'var(--green)' : 'var(--yellow)';
            h += '<div style="color:' + col + ';margin:6px 0">' + _esc(vd.text) + '</div>';
        });

        var qL = _lab('liquidRate', 'BPD'), pL = _lab('pressure', 'psia'), anyHeld = false;
        h += '<div class="rbox"><div class="rbox-title">IPR Table</div><div style="overflow-x:auto"><table class="dtable" id="oi_tbl"><thead><tr>' +
            '<th>pwf (' + pL + ')</th><th>q (' + qL + ')</th>' + (r.future ? '<th>q future (' + qL + ')</th>' : '') + '</tr></thead><tbody>';
        r.table.forEach(function (row) {
            if (row.heldAtMax || row.heldFuture) anyHeld = true;
            h += '<tr><td>' + _fmt(_disp(row.pwf, 'pressure'), 1) + '</td><td>' + _fmt(_disp(row.q, 'liquidRate'), 1) + (row.heldAtMax ? ' *' : '') + '</td>' +
                (r.future ? '<td>' + (row.qf == null ? '' : _fmt(_disp(row.qf, 'liquidRate'), 1) + (row.heldFuture ? ' *' : '')) + '</td>' : '') + '</tr>';
        });
        h += '</tbody></table></div>';
        if (anyHeld) h += '<div style="font-size:12px;color:var(--text2);margin-top:4px">* Below the FE validity limit — rate held at qmax (FE = 1).</div>';
        h += '</div>';

        h += '<div class="chart-wrap"><canvas id="oi_chart" width="600" height="340"></canvas></div>';
        h += '<div style="font-size:12px;color:var(--text2);margin-top:8px"><b>Notes</b> Use absolute pressures consistently; Vogel curves are dimensionless ratios, so gauge-pressure inputs change results by less than about 1 % at typical reservoir pressures.</div>';
        res.innerHTML = h;
        _chart(r);
        res.setAttribute('data-done', '1');
        return r;
    }

    function _esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function _chart(r) {
        var cv = _byId('oi_chart');
        var draw = (typeof drawLineChart === 'function') ? drawLineChart : (typeof G.drawLineChart === 'function' ? G.drawLineChart : null); // eslint-disable-line no-undef
        if (!cv || !draw || !cv.getContext) return;
        function xy(p) { return { x: _disp(p.q, 'liquidRate'), y: _disp(p.pwf, 'pressure') }; }
        var ds = [{ label: 'IPR (present)', color: '#f0883e', data: r.curve.map(xy), points: false, width: 2 }];
        if (r.curveF && r.curveF.length) ds.push({ label: 'Future IPR', color: '#bc8cff', dash: [4, 4], data: r.curveF.map(xy), points: false, width: 2 });
        var tp = r.points.slice().sort(function (a, b) { return a.q - b.q; }).map(xy);
        if (tp.length) ds.push({ label: 'Test points', color: '#3fb950', data: tp, points: true, width: 0.001 });
        try {
            draw(cv, ds, {
                xLabel: 'Rate q (' + _lab('liquidRate', 'BPD') + ')', yLabel: 'pwf (' + _lab('pressure', 'psia') + ')',
                xMin: 0, yMin: 0, xDec: 0, yDec: 0
            });
        } catch (e) { /* chart is decorative; results stay valid */ }
    }

    G.calcOilIPR = function () { return _canon(_calcImpl); };
    G.renderOilIPR = render;

    // ── Registry entry (merge, never replace) ────────────────────────────
    G.WTS_calcRegistry = G.WTS_calcRegistry || {};
    G.WTS_calcRegistry.oilipr = {
        key: 'oilipr',
        title: TITLE,
        sub: SUB,
        group: 'Production & Reservoir',
        icon: '&#8600;',
        badge: 'Production',
        bc: 'dc-b-green',
        desc: 'Straight-line PI, Vogel, composite and Fetkovich IPR with Standing flow efficiency, future IPR and rate/pressure readouts.',
        render: render
    };

    // Unit flip: re-render results in the new display system
    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('wts:unit-system-changed', function () {
            var r = _byId('oi_res');
            if (r && r.getAttribute && r.getAttribute('data-done') === '1') G.calcOilIPR();
        });
    }
})();

// ─── END 42-calc-oilipr ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 43-calc-flareghg ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
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
        return (G.WTS_fmtNum ? G.WTS_fmtNum(v, 0, (d == null ? 2 : d)) : Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: (d == null ? 2 : d) }));
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

// ─── END 43-calc-flareghg ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 44-calc-h2sroe ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════
// WTS — Round-9 plug-in calculator — H2S Exposure & Scavenger (h2sroe)
//
// PURPOSE
//   Three independent H2S screening cards on one page:
//     A. Radius of exposure (ROE) for 100 ppm and 500 ppm H2S, using the
//        Pasquill-Gifford screening formulas of Texas Statewide Rule 36
//        (16 TAC §3.36(c)), also used in US federal onshore H2S rules.
//     B. SO2 generated (and H2S left unburned) when sour gas is flared.
//     C. Triazine-type H2S scavenger dosing for a gas stream.
//   A validation error in one card never blocks the other two.
//
// UNITS
//   Field units throughout: gas rates in MMSCFD (standard conditions
//   14.696 psia / 60 °F; 379.48 scf per lb-mol), concentrations in ppm
//   (mole), masses in lb, product volume in US gal. Metric companions
//   (m, kg, L, t) are shown next to the field values. The units layer
//   converts tagged inputs, so the calc always reads imperial values.
//
// PUBLIC API (window.*)
//   renderH2SSafety(body)            paints the page into #pgBody
//   calcH2S()                        reads the DOM, validates, computes, renders
//   WTS_h2s_roe(qMMscfd, ppm)        → {ok, mf, Q, x100_ft, x500_ft, x100_m, x500_m, h2s_lbd, h2s_kgd}
//   WTS_h2s_so2(qMMscfd, ppm, cePct) → {ok, so2_lbhr, so2_kghr, so2_td, h2s_lbhr, h2s_kghr}
//   WTS_h2s_scavenger(qMMscfd, cin, cout, galPerLb)
//                                    → {ok, lb_d, kg_d, gal_d, L_d, L_hr, gal_hr, gr_in, gr_out}
//   WTS_h2sroe_compute(input)        all three at once (registry contract)
//   WTS_h2sUseAOF()                  copies WTS_state.gasdeliv.aofCn into the escape rate
//   Each compute returns {ok:false, errors:[…], bad:[param…]} on bad input.
//
// STATE
//   WTS_state.h2sroe = {x100_ft, x500_ft, so2_lbhr, scav_gal_d, ts, roe, so2, scav}
//
// Registers window.WTS_calcRegistry.h2sroe (Round-9 contract; the host adds
// the route, sidebar button in "Test System Safety" and the dashboard tile).
// ════════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    var G = (typeof window !== 'undefined') ? window : globalThis;

    // ── Constants ────────────────────────────────────────────────────
    var SCF_PER_LBMOL = 379.48;       // ideal gas, 14.696 psia and 60 °F
    var MW_H2S = 34.081;              // lb/lb-mol
    var MW_SO2 = 64.064;              // lb/lb-mol
    var LB_TO_KG = 0.45359237;
    var FT_TO_M = 0.3048;
    var GAL_TO_L = 3.785412;          // US gallon
    var SCF_TO_M3 = 0.028316847;
    // grains per 100 scf per ppm: 100 scf · 1e-6 / 379.48 · 34.081 lb · 7000 gr/lb
    var GR100_PER_PPM = 0.062867;
    var ROE_EXP = 0.6258;             // 16 TAC §3.36(c) exponent
    var ROE_K100 = 1.589;             // 100 ppm coefficient
    var ROE_K500 = 0.4546;            // 500 ppm coefficient
    var SALES_LIMIT_PPM = 4;          // common 0.25 gr/100 scf sales-gas limit

    // ── Helpers (page pattern, NEW-CALCS-SPEC §0.3) ─────────────────
    function _byId(id) { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }
    function _num(id) { var e = _byId(id); if (!e) return NaN; var s = String(e.value).trim(); return s === '' ? NaN : parseFloat(s); }
    function _fmt(v, d) {
        if (v == null || !isFinite(v)) return '—';
        return (G.WTS_fmtNum ? G.WTS_fmtNum(v, 0, (d == null ? 2 : d)) : Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: (d == null ? 2 : d) }));
    }
    // Auto decimals: about 4-5 significant figures without trailing zeros.
    function _fa(v) {
        if (v == null || !isFinite(v)) return '—';
        var a = Math.abs(v);
        return _fmt(v, a >= 10000 ? 0 : a >= 100 ? 1 : a >= 10 ? 2 : a >= 1 ? 3 : 4);
    }
    // value in the display system; impLabel is the imperial text
    function _u(v, cat, d, impLabel) {
        var U = G.WTS_units;
        if (U && U.getSystem && U.getSystem() === 'metric' && U.format) {
            var f = U.format(v, cat);
            return _fmt(f.value, d) + ' ' + f.label;
        }
        return _fmt(v, d) + ' ' + impLabel;
    }
    // v3.1: Metric mode leads with the SI value, the field-unit value follows in brackets.
    function _isMetric() { var U = G.WTS_units; return !!(U && U.getSystem && U.getSystem() === 'metric'); }
    function _pair(vi, ui, vm, um) { return _isMetric() ? _fa(vm) + ' ' + um + ' (' + _fa(vi) + ' ' + ui + ')' : _fa(vi) + ' ' + ui + ' (' + _fa(vm) + ' ' + um + ')'; }
    function _tag(map) { var U = G.WTS_units; if (!U || !U.tagInput) return; for (var id in map) U.tagInput(id, map[id]); }
    function _canon(fn) { var U = G.WTS_units; return (U && U.runCanonical) ? U.runCanonical(fn) : fn(); }
    function _fin(x) { return typeof x === 'number' && isFinite(x); }

    // ── Standard (base) conditions ───────────────────────────────────
    // Entered gas rates are standard volumes at the app's standard-conditions
    // setting (22-units.js WTS_baseConditions). With the setting left on
    // "calculator default" the page keeps its original basis: 60 °F /
    // 14.696 psia (379.48 scf/lb-mol) and the rule's own 14.65 psia for the
    // escape rate. With a setting chosen, moles use that basis's molar volume
    // and the escape rate is re-referred to the rule's 14.65 psia / 60 °F.
    var RULE_BASIS = { Tb_F: 60, Pb_psia: 14.65 };
    function _basis() {
        var B = G.WTS_baseConditions;
        var b = (B && B.resolve) ? B.resolve(60, 14.696) : { Tb_F: 60, Pb_psia: 14.696, fromSetting: false, label: '60 °F / 14.696 psia' };
        b.vm = (b.fromSetting && B.molarVolume) ? B.molarVolume(b) : SCF_PER_LBMOL;
        b.toRule = (b.fromSetting && B.volumeFactor) ? B.volumeFactor(b, RULE_BASIS) : 1;
        b.gr100 = b.fromSetting ? 100 * 1e-6 / b.vm * MW_H2S * 7000 : GR100_PER_PPM;
        return b;
    }

    // ── Pure compute (field units in and out, no DOM) ───────────────

    // Radius of exposure — 16 TAC §3.36(c)(1) (Texas Statewide Rule 36),
    // Pasquill-Gifford screening form:
    //   X100 = (1.589 · mf · Q)^0.6258 ft ;  X500 = (0.4546 · mf · Q)^0.6258 ft
    //   mf = H2S mole fraction, Q = maximum volume available for escape, scf/d
    //   (14.65 psia, 60 °F; for a producing well the current adjusted open flow).
    // H2S mass release = Q · mf / 379.48 · 34.081 lb/d.
    function roe(qMMscfd, ppm) {
        var q = Number(qMMscfd), c = Number(ppm), errors = [], bad = [];
        if (!(_fin(q) && q > 0 && q <= 10000)) { errors.push('Maximum escape rate must be above 0 and no more than 10,000 MMSCFD.'); bad.push('q'); }
        if (!(_fin(c) && c > 0 && c <= 1e6)) { errors.push('H2S in gas must be above 0 and no more than 1,000,000 ppm.'); bad.push('ppm'); }
        if (errors.length) return { ok: false, errors: errors, bad: bad };
        var bc = _basis();
        var mf = c / 1e6, Q = q * 1e6 * bc.toRule;       // scf/d at the rule's 14.65 psia / 60 °F
        var x100 = Math.pow(ROE_K100 * mf * Q, ROE_EXP);
        var x500 = Math.pow(ROE_K500 * mf * Q, ROE_EXP);
        var lbd = q * 1e6 * mf / bc.vm * MW_H2S;
        return {
            ok: true, mf: mf, Q: Q, basis: bc,
            x100_ft: x100, x500_ft: x500, x100_m: x100 * FT_TO_M, x500_m: x500 * FT_TO_M,
            h2s_lbd: lbd, h2s_kgd: lbd * LB_TO_KG
        };
    }

    // SO2 from flaring sour gas — stoichiometry H2S + 1.5 O2 → SO2 + H2O
    // (1 mol SO2 per mol H2S burned):
    //   n = q·1e6 / 379.48 / 24 lb-mol/hr
    //   SO2 = n · mf · CE · 64.064 lb/hr ; unburned H2S = n · mf · (1 − CE) · 34.081 lb/hr
    function so2(qMMscfd, ppm, cePct) {
        var q = Number(qMMscfd), c = Number(ppm), ce = Number(cePct), errors = [], bad = [];
        if (!(_fin(q) && q > 0 && q <= 500)) { errors.push('Gas to flare must be above 0 and no more than 500 MMSCFD.'); bad.push('q'); }
        if (!(_fin(c) && c >= 0 && c <= 1e6)) { errors.push('H2S in flared gas must be between 0 and 1,000,000 ppm.'); bad.push('ppm'); }
        if (!(_fin(ce) && ce >= 50 && ce <= 100)) { errors.push('Combustion efficiency must be between 50 and 100 %.'); bad.push('ce'); }
        if (errors.length) return { ok: false, errors: errors, bad: bad };
        var bc = _basis();
        var mf = c / 1e6, n = q * 1e6 / bc.vm / 24, f = ce / 100;
        var so2lb = n * mf * f * MW_SO2;
        var h2slb = n * mf * (1 - f) * MW_H2S;
        return {
            ok: true, mf: mf, lbmol_hr: n, basis: bc,
            so2_lbhr: so2lb, so2_kghr: so2lb * LB_TO_KG, so2_td: so2lb * 24 * LB_TO_KG / 1000,
            h2s_lbhr: h2slb, h2s_kghr: h2slb * LB_TO_KG
        };
    }

    // Triazine-type scavenger dosing (mass balance on H2S removed):
    //   removed = q·1e6 · (cin − cout)·1e-6 / 379.48 · 34.081 lb/d
    //   product = removed · consumption (US gal per lb H2S, supplier figure)
    //   gr/100 scf = ppm · 0.062867
    function scavenger(qMMscfd, cin, cout, galPerLb) {
        var q = Number(qMMscfd), ci = Number(cin), co = Number(cout), r = Number(galPerLb), errors = [], bad = [];
        if (!(_fin(q) && q > 0 && q <= 500)) { errors.push('Gas to treat must be above 0 and no more than 500 MMSCFD.'); bad.push('q'); }
        var ciOk = _fin(ci) && ci > 0 && ci <= 100000;
        if (!ciOk) { errors.push('Inlet H2S must be above 0 and no more than 100,000 ppm.'); bad.push('cin'); }
        if (!(_fin(co) && co >= 0 && (!ciOk || co < ci))) { errors.push('Target outlet H2S must be 0 ppm or more and below the inlet H2S.'); bad.push('cout'); }
        if (!(_fin(r) && r >= 0.1 && r <= 10)) { errors.push('Product consumption must be between 0.1 and 10 US gal per lb H2S.'); bad.push('ratio'); }
        if (errors.length) return { ok: false, errors: errors, bad: bad };
        var bc = _basis();
        var lbd = q * 1e6 * (ci - co) * 1e-6 / bc.vm * MW_H2S;
        var gal = lbd * r, L = gal * GAL_TO_L;
        return {
            ok: true, lb_d: lbd, kg_d: lbd * LB_TO_KG, basis: bc,
            gal_d: gal, L_d: L, L_hr: L / 24, gal_hr: gal / 24,
            gr_in: ci * bc.gr100, gr_out: co * bc.gr100, meetsSales: co <= SALES_LIMIT_PPM
        };
    }

    G.WTS_h2s_roe = roe;
    G.WTS_h2s_so2 = so2;
    G.WTS_h2s_scavenger = scavenger;
    // Registry contract: one pure compute for the whole page.
    // input = {q, ppm, fq, fppm, fce, sq, sin, sout, ratio}
    G.WTS_h2sroe_compute = function (input) {
        var i = input || {};
        var a = roe(i.q, i.ppm), b = so2(i.fq, i.fppm, i.fce), c = scavenger(i.sq, i.sin, i.sout, i.ratio);
        return { ok: a.ok && b.ok && c.ok, roe: a, so2: b, scav: c };
    };

    // ── Page ─────────────────────────────────────────────────────────
    var UNITS = {
        hs_q: 'gasRate', hs_ppm: 'concentration', hs_fq: 'gasRate', hs_fppm: 'concentration', hs_fce: 'percent',
        hs_sq: 'gasRate', hs_sin: 'concentration', hs_sout: 'concentration', hs_ratio: 'volPerMass'
    };
    var TITLE = 'H2S Exposure & Scavenger';
    var SUB = 'Radius of exposure for 100 and 500 ppm H2S, SO2 from flaring sour gas, and H2S scavenger dosing';

    // Validation messages in the display system (limits are imperial).
    var MSG = {
        roe: {
            q: function () { return 'Maximum escape rate must be above 0 and no more than ' + _u(10000, 'gasRate', 0, 'MMSCFD') + '.'; },
            ppm: function () { return 'H2S in gas must be above 0 and no more than 1,000,000 ppm.'; }
        },
        so2: {
            q: function () { return 'Gas to flare must be above 0 and no more than ' + _u(500, 'gasRate', 0, 'MMSCFD') + '.'; },
            ppm: function () { return 'H2S in flared gas must be between 0 and 1,000,000 ppm.'; },
            ce: function () { return 'Combustion efficiency must be between 50 and 100 %.'; }
        },
        scv: {
            q: function () { return 'Gas to treat must be above 0 and no more than ' + _u(500, 'gasRate', 0, 'MMSCFD') + '.'; },
            cin: function () { return 'Inlet H2S must be above 0 and no more than 100,000 ppm.'; },
            cout: function () { return 'Target outlet H2S must be 0 ppm or more and below the inlet H2S.'; },
            ratio: function () { return _isMetric() ? 'Product consumption must be between ' + _u(0.1, 'volPerMass', 2, 'US gal/lb') + ' and ' + _u(10, 'volPerMass', 1, 'US gal/lb') + ' of H2S removed.' : 'Product consumption must be between 0.1 and 10 US gal per lb H2S.'; }
        }
    };
    var IDS = {
        roe: { q: 'hs_q', ppm: 'hs_ppm' },
        so2: { q: 'hs_fq', ppm: 'hs_fppm', ce: 'hs_fce' },
        scv: { q: 'hs_sq', cin: 'hs_sin', cout: 'hs_sout', ratio: 'hs_ratio' }
    };

    function _fg(id, label, val, extra) {
        return '<div class="fg-item"><label for="' + id + '">' + label + '</label>' +
            '<input type="number" id="' + id + '" value="' + val + '" step="any"' + (extra || '') + '></div>';
    }
    function _row(l, v) { return '<div class="rrow"><span class="rl">' + l + '</span><span class="rv">' + v + '</span></div>'; }
    function _ok(t) { return '<div style="color:var(--green)">✓ ' + t + '</div>'; }
    function _warn(t) { return '<div style="color:var(--yellow)">⚠ ' + t + '</div>'; }
    function _note(t) { return '<div style="margin-top:10px;font-size:12px;color:var(--text2)"><b>Notes</b> ' + t + '</div>'; }
    function _calcBtn(id) {
        return '<button class="btn btn-primary" id="' + id + '" onclick="calcH2S()">Calculate</button>';
    }

    function _errors(resId, group, bad) {
        var res = _byId(resId);
        var items = '';
        for (var i = 0; i < bad.length; i++) {
            var k = bad[i];
            var el = _byId(IDS[group][k]);
            if (el && el.classList) el.classList.add('input-err');
            items += '<li>' + (MSG[group][k] ? MSG[group][k]() : 'Invalid input.') + '</li>';
        }
        if (res) {
            res.innerHTML = '<div class="val-error"><strong>Please fix the following:</strong><ul>' + items + '</ul></div>';
            res.setAttribute('data-done', '1');
        }
    }

    function _basisNote(b, rule) {
        if (!b) return '';
        if (!b.fromSetting) return 'Gas rates are standard volumes at 60 °F / 14.696 psia (379.48 scf per lb-mol)' +
            (rule ? '; the escape rate is used as entered.' : '.');
        return 'Gas rates are standard volumes at ' + b.label + ' (app setting, ' + _fmt(b.vm, 2) + ' scf per lb-mol)' +
            (rule ? '; the escape rate is re-referred to 14.65 psia / 60 °F (× ' + _fmt(b.toRule, 5) + ') for the formula.' : '.');
    }

    function _paintRoe(r) {
        var res = _byId('hs_roe_res');
        if (!res) return;
        if (!r.ok) { _errors('hs_roe_res', 'roe', r.bad); return; }
        var v = '';
        if (r.x100_ft < 50) v += _ok(_isMetric() ? '100 ppm radius of exposure is under 15.2 m (50 ft).' : '100 ppm radius of exposure is under 50 ft.');
        else v += _warn('100 ppm radius of exposure is ' + _pair(r.x100_ft, 'ft', r.x100_m, 'm') + ' — check for public areas inside it; a contingency plan may be required.');
        if (r.x100_ft > 3000) v += _warn(_isMetric() ? '100 ppm radius of exposure exceeds 914 m (3,000 ft).' : '100 ppm radius of exposure exceeds 3,000 ft.');
        if (r.x500_ft >= 50) v += _warn('500 ppm radius of exposure is ' + _pair(r.x500_ft, 'ft', r.x500_m, 'm') + ' — check for public roads inside it.');
        res.innerHTML =
            '<div class="rbox"><div class="rbox-title">Radius of Exposure</div>' +
            _row('H2S mole fraction', _fmt(r.mf, 6)) +
            _row('Escape rate', _pair(r.Q, 'scf/d', r.Q * SCF_TO_M3, 'm³/d')) +
            _row('100 ppm radius of exposure', _pair(r.x100_ft, 'ft', r.x100_m, 'm')) +
            _row('500 ppm radius of exposure', _pair(r.x500_ft, 'ft', r.x500_m, 'm')) +
            _row('H2S release', _pair(r.h2s_lbd, 'lb/d', r.h2s_kgd, 'kg/d')) +
            v +
            _note('Screening formula from Texas Statewide Rule 36 (also used in US federal onshore H2S rules). ' +
                'Escape rate = maximum volume available for escape, for a producing well the current adjusted ' +
                'open-flow rate, at 14.65 psia and 60 °F. Local regulations and site dispersion studies take precedence. ' +
                _basisNote(r.basis, true)) +
            '</div>';
        res.setAttribute('data-done', '1');
    }

    function _paintSo2(r) {
        var res = _byId('hs_so2_res');
        if (!res) return;
        if (!r.ok) { _errors('hs_so2_res', 'so2', r.bad); return; }
        res.innerHTML =
            '<div class="rbox"><div class="rbox-title">SO2 Generation</div>' +
            _row('SO2', _pair(r.so2_lbhr, 'lb/hr', r.so2_kghr, 'kg/hr')) +
            _row('SO2 per day', _fa(r.so2_td) + ' t/d') +
            _row('Unburned H2S', _pair(r.h2s_lbhr, 'lb/hr', r.h2s_kghr, 'kg/hr')) +
            _note('Ground-level SO2 concentration depends on flare height, plume rise and weather: screen it on the ' +
                'SO2 / H2S Dispersion Screening page. Use Flare Emissions for full-period reporting. ' +
                _basisNote(r.basis)) +
            '</div>';
        res.setAttribute('data-done', '1');
    }

    function _paintScv(r, cin, cout) {
        var res = _byId('hs_scv_res');
        if (!res) return;
        if (!r.ok) { _errors('hs_scv_res', 'scv', r.bad); return; }
        var v = r.meetsSales
            ? _ok('Outlet target meets a 4 ppm (0.25 gr/100 scf) limit.')
            : _warn('Outlet target is above the common 4 ppm (0.25 gr/100 scf) sales-gas limit.');
        res.innerHTML =
            '<div class="rbox"><div class="rbox-title">Scavenger Requirement</div>' +
            _row('H2S removed', _pair(r.lb_d, 'lb/d', r.kg_d, 'kg/d')) +
            _row('Inlet H2S', _fa(cin) + ' ppm = ' + _fa(r.gr_in) + ' gr/100 scf') +
            _row('Outlet H2S', _fa(cout) + ' ppm = ' + _fa(r.gr_out) + ' gr/100 scf') +
            _row('Product', _pair(r.gal_d, 'US gal/d', r.L_d, 'L/d')) +
            _row('Injection rate', _fa(r.L_hr) + ' L/hr (' + _fa(r.gal_hr) + ' US gal/hr)')   /* dosing pumps are rated in L/hr: SI first in both systems */ +
            v +
            _note('Consumption depends on product strength, contact time, temperature and injection design. ' +
                'Use the supplier\'s figure; published field trials of triazine products report about ' +
                (_isMetric() ? '10 to 16 L/kg (1.2 to 1.9 US gal per lb)' : '1.2 to 1.9 US gal per lb (10 to 16 L/kg)') + ' of H2S removed. Stoichiometric use is lower. Watch for solids from spent product. ' +
                _basisNote(r.basis)) +
            '</div>';
        res.setAttribute('data-done', '1');
    }

    function _calcImpl() {
        var root = _byId('hs_root');
        if (!root) return null;
        var ins = root.querySelectorAll ? root.querySelectorAll('input') : [];
        for (var i = 0; i < ins.length; i++) if (ins[i].classList) ins[i].classList.remove('input-err');

        var a = roe(_num('hs_q'), _num('hs_ppm'));
        var b = so2(_num('hs_fq'), _num('hs_fppm'), _num('hs_fce'));
        var sin = _num('hs_sin'), sout = _num('hs_sout');
        var c = scavenger(_num('hs_sq'), sin, sout, _num('hs_ratio'));
        _paintRoe(a);
        _paintSo2(b);
        _paintScv(c, sin, sout);

        G.WTS_state = G.WTS_state || {};
        G.WTS_state.h2sroe = {
            x100_ft: a.ok ? a.x100_ft : null,
            x500_ft: a.ok ? a.x500_ft : null,
            so2_lbhr: b.ok ? b.so2_lbhr : null,
            scav_gal_d: c.ok ? c.gal_d : null,
            ts: Date.now(),
            roe: a, so2: b, scav: c
        };
        return { roe: a, so2: b, scav: c };
    }

    G.calcH2S = function () { return _canon(_calcImpl); };

    // "Use AOF from Gas Deliverability": WTS_state.gasdeliv.aofCn is in Mscf/d.
    G.WTS_h2sUseAOF = function () {
        var st = G.WTS_state && G.WTS_state.gasdeliv;
        var aof = st ? Number(st.aofCn) : NaN;
        var el = _byId('hs_q');
        if (!el) return false;
        if (!(_fin(aof) && aof > 0)) {
            var res = _byId('hs_roe_res');
            if (res) res.innerHTML = _warn('Open Gas Deliverability &amp; AOF and calculate first.');
            return false;
        }
        var q = Number((aof / 1000).toPrecision(12));
        // Canonical assignment: in metric the units layer shows it converted.
        _canon(function () { el.value = String(q); });
        // Let the page autosave see the new value; the change listener recalculates.
        try {
            if (typeof Event === 'function' && el.dispatchEvent) {
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }
        } catch (e) { /* ignore */ }
        G.calcH2S();
        return true;
    };

    function render(body) {
        if (!body) return;
        var t = _byId('pgTitle'), s = _byId('pgSub');
        if (t) t.textContent = TITLE;
        if (s) s.textContent = SUB;
        body.innerHTML =
            '<div id="hs_root"><div class="cols-2">' +
            // left column
            '<div>' +
            '<div class="card"><div class="card-title">Radius of Exposure</div>' +
            '<div class="fg">' +
            _fg('hs_q', 'Maximum escape rate (MMSCFD)', '10', ' min="0"') +
            _fg('hs_ppm', 'H2S in gas (ppm)', '10000', ' min="0"') +
            '</div>' +
            '<div class="btn-row">' + _calcBtn('hs_calc') +
            '<button class="btn btn-secondary" id="hs_useaof" onclick="WTS_h2sUseAOF()">Use AOF from Gas Deliverability</button></div>' +
            '<div id="hs_roe_res" style="margin-top:14px"></div></div>' +
            '<div class="card"><div class="card-title">SO2 from Flaring Sour Gas</div>' +
            '<div class="fg">' +
            _fg('hs_fq', 'Gas to flare (MMSCFD)', '5', ' min="0"') +
            _fg('hs_fppm', 'H2S in flared gas (ppm)', '10000', ' min="0"') +
            _fg('hs_fce', 'Combustion efficiency (%)', '98', ' min="50" max="100"') +
            '</div>' +
            '<div class="btn-row">' + _calcBtn('hs_calc2') + '</div>' +
            '<div id="hs_so2_res" style="margin-top:14px"></div></div>' +
            '</div>' +
            // right column
            '<div>' +
            '<div class="card"><div class="card-title">H2S Scavenger Dosing (triazine-type)</div>' +
            '<div class="fg">' +
            _fg('hs_sq', 'Gas to treat (MMSCFD)', '5', ' min="0"') +
            _fg('hs_sin', 'Inlet H2S (ppm)', '50', ' min="0"') +
            _fg('hs_sout', 'Target outlet H2S (ppm)', '4', ' min="0"') +
            _fg('hs_ratio', 'Product consumption per H2S removed (US gal/lb)', '1.5', ' min="0"') +
            '</div>' +
            '<div class="btn-row">' + _calcBtn('hs_calc3') + '</div>' +
            '<div id="hs_scv_res" style="margin-top:14px"></div></div>' +
            '</div>' +
            '</div></div>';
        _tag(UNITS);
        var root = _byId('hs_root');
        if (root && root.addEventListener) {
            root.addEventListener('change', function (e) {
                if (e && e.target && /^hs_/.test(e.target.id || '')) G.calcH2S();
            });
        }
        G.calcH2S();
    }
    G.renderH2SSafety = render;

    // ── Registry (merge, never replace) ──────────────────────────────
    G.WTS_calcRegistry = G.WTS_calcRegistry || {};
    G.WTS_calcRegistry.h2sroe = {
        key: 'h2sroe',
        title: TITLE,
        sub: SUB,
        group: 'Test System Safety',
        icon: '&#9763;',
        badge: 'Safety',
        bc: 'dc-b-orange',
        desc: '100 and 500 ppm radius of exposure, SO2 from flaring sour gas and triazine-type scavenger dosing.',
        render: function (body) { return G.renderH2SSafety(body); }
    };

    // Unit flip: recalculate a page that has already shown results.
    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('wts:unit-system-changed', function () {
            var ids = ['hs_roe_res', 'hs_so2_res', 'hs_scv_res'];
            for (var i = 0; i < ids.length; i++) {
                var r = _byId(ids[i]);
                if (r && r.getAttribute && r.getAttribute('data-done') === '1') { G.calcH2S(); return; }
            }
        });
        document.addEventListener('wts:base-conditions-changed', function () {
            var r = _byId('hs_roe_res');
            if (r && r.getAttribute && r.getAttribute('data-done') === '1') G.calcH2S();
        });
    }
})();

// ─── END 44-calc-h2sroe ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 45-calc-orifice ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════
// WTS ─ Round-9 plug-in calculator 45 — Orifice Plate Selection
//
// PURPOSE
//   Inverse AGA-3 (roadmap #6). For a target gas rate, meter run ID, line
//   pressure/temperature, gas gravity (+ CO2 / N2 / H2S) and the DP
//   transmitter range, pick the orifice bore that keeps the differential
//   between the low and high % of range (default 20–80 %) at the target
//   rate, with β = d/D inside the AGA-3 RG limits 0.10–0.75. Shows the next
//   plate up and down and the plate-change points (the rates at which each
//   plate reaches the low / high % of range).
//
// METHOD
//   Every rate comes from the host's pure AGA-3 engine
//   window.WTS_aga3_compute (API MPMS 14.3.1 RG flange-tap Cd with Re
//   iteration, Y1 upstream expansion factor, Standing + Wichert-Aziz
//   pseudo-criticals, Dranchuk-Abou-Kassem Z, v3.0 Fpv = √(Zb/Zf) with the
//   base Z, real/ideal gravity basis Gr = Gi·0.99959/Zb) — the same numbers as the
//   AGA-3 Gas Metering page. Z does not depend on bore or differential, so
//   it is solved once and passed back in (identical value, faster).
//     • Exact bore d*: bisection on d in [0.10·D, 0.75·D] so that the rate
//       at the design differential (default 50 % of range) equals the target.
//     • Differential at the target for a given plate: bisection on hw.
//     • Plate-change points: forward rate at low % and high % of range.
//   Plate list: every 0.125" bore from 0.125" up to the largest bore with
//   β ≤ 0.75 (bores below β 0.10 are dropped). The chosen plate is d*
//   rounded to the nearest 0.125" when that plate keeps the differential
//   inside the window; otherwise the plate inside the window closest to the
//   design %; otherwise (none inside) the nearest plate, flagged ✗.
//   Plate sizes are always shown as decimal inches (1.875", 2.000") — in
//   Metric mode with the mm conversion alongside (1.875" (47.63 mm)).
//
// REFERENCES
//   • AGA Report No. 3 / API MPMS Ch. 14.3.1–14.3.3 (1992+, 2012/2013):
//     orifice equation, RG Cd, β 0.10–0.75, D ≥ 2 in, x1 = hw/(N3·Pf1).
//   • ISO 5167-1/-2 (2003) — flow measurement practice: keep the working
//     differential in the upper part of the transmitter span (the 20–80 %
//     window is common field practice, not a standard requirement).
//
// FIELD UNITS (canonical): rate MSCFD, lengths in, pressure psig / psia,
//   differential inH2O @ 60 °F, temperature °F.
//
// PUBLIC API (window.*)
//   renderOrificeSelect(body)      paint the page into #pgBody
//   calcOrificeSelect()            read DOM → validate → compute → render
//   WTS_orifice_compute(input)     pure; field units in and out, no DOM
//       input  {q, D, Ps, TfF, SG, sgBasis ('real' default | 'ideal'), co2, n2, h2s, urv, lo, hi, des, TbF, Pb}
//              (a legacy `mode` from an earlier build is accepted and ignored)
//       output {ok, errors[], errorIds[], dStar, betaStar, dStarFlag, candidates[],
//               chosen, up, down, table[], verdicts[], warnings[], Z, ...}
//   WTS_state.orifice              last result (in memory only)
//   WTS_calcRegistry.orifice       Round-9 registration
//
// CONVENTIONS: single outer IIFE, 'use strict', no dependencies, no timers,
//   loads without document / WTS_units / drawLineChart / WTS_aga3_compute.
//   Self-test block at the end is stripped by concat-round9.
// ════════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    var G = (typeof window !== 'undefined') ? window : globalThis;
    var P = 'op_';

    // ── Page helpers (shared calculator pattern) ─────────────────────
    function _byId(id) { return (typeof document !== 'undefined' && document.getElementById) ? document.getElementById(id) : null; }
    function _num(id) { var e = _byId(id); if (!e) return NaN; var s = String(e.value).trim(); return s === '' ? NaN : parseFloat(s); }
    function _fmt(v, d) {
        if (v == null || !isFinite(v)) return '—';
        return (G.WTS_fmtNum ? G.WTS_fmtNum(v, 0, (d == null ? 2 : d)) : Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: (d == null ? 2 : d) }));
    }
    function _metric() { var U = G.WTS_units; return !!(U && U.getSystem && U.getSystem() === 'metric' && U.format); }
    function _u(v, cat, d, impLabel, dMet) {
        if (v == null || !isFinite(v)) return '—';
        if (_metric()) { var f = G.WTS_units.format(v, cat); return _fmt(f.value, dMet == null ? d : dMet) + ' ' + f.label; }
        return _fmt(v, d) + ' ' + impLabel;
    }
    function _dv(v, cat) { return _metric() ? G.WTS_units.format(v, cat).value : v; }
    function _lab(cat, impLabel) { return _metric() ? G.WTS_units.format(1, cat).label : impLabel; }
    function _tag(map) { var U = G.WTS_units; if (!U || !U.tagInput) return; for (var id in map) U.tagInput(id, map[id]); }
    function _canon(fn) { var U = G.WTS_units; return (U && U.runCanonical) ? U.runCanonical(fn) : fn(); }
    function _nv(v) { return (v === null || v === undefined || v === '') ? NaN : Number(v); }
    function _opt(v, def) { return (v === null || v === undefined || v === '' || (typeof v === 'number' && isNaN(v))) ? def : Number(v); }
    var STEP = 0.125;   // plate bores in 0.125" increments over the whole range
    // Plate size text: always decimal inches; Metric mode adds the mm conversion.
    function _boreTxt(d, dp) {
        if (d == null || !isFinite(d)) return '—';
        var t = d.toFixed(dp == null ? 3 : dp) + '"';
        return _metric() ? t + ' (' + (d * 25.4).toFixed(dp == null ? 2 : 3) + ' mm)' : t;
    }

    var BETA_MIN = 0.1, BETA_MAX = 0.75;
    var N3 = 27.707;   // inH2O (60 °F) per psi — same constant as the AGA-3 engine

    // ═════════════════════════════════════════════════════════════════
    // PURE COMPUTE — field units
    // ═════════════════════════════════════════════════════════════════
    function compute(inp) {
        inp = inp || {};
        var errors = [], errorIds = [];
        function err(msg, id) { errors.push(msg); errorIds.push(id || null); }
        function fail() { return { ok: false, errors: errors, errorIds: errorIds, verdicts: [], warnings: [], candidates: [], table: [] }; }

        var aga = G.WTS_aga3_compute;
        if (typeof aga !== 'function') { err('The AGA-3 engine (WTS_aga3_compute) is not loaded.', null); return fail(); }

        var q = _nv(inp.q), D = _nv(inp.D), Ps = _nv(inp.Ps), TfF = _nv(inp.TfF), SG = _nv(inp.SG);
        var co2 = _opt(inp.co2, 0), n2 = _opt(inp.n2, 0), h2s = _opt(inp.h2s, 0);
        var urv = _nv(inp.urv), lo = _opt(inp.lo, 20), hi = _opt(inp.hi, 80), des = _opt(inp.des, 50);
        var TbF = _opt(inp.TbF, 60), Pb = _opt(inp.Pb, 14.696);
        var sgBasis = inp.sgBasis === 'ideal' ? 'ideal' : 'real';

        if (!(q > 0)) err('Target gas rate must be greater than zero.', P + 'q');
        if (!(D > 0)) err('Meter run internal diameter must be greater than zero.', P + 'D');
        else if (D > 48) err('Meter run internal diameter must not exceed ' + _u(48, 'lengthSmall', 3, 'in', 0) + '.', P + 'D');
        if (!isFinite(Ps) || Ps + 14.696 <= 0) err('Enter a valid static (line) pressure.', P + 'P');
        if (!(TfF > -459.67)) err('Flowing temperature must be above absolute zero.', P + 'T');
        if (!(SG >= 0.5 && SG <= 1.8)) err('Gas specific gravity must be between 0.5 and 1.8.', P + 'SG');
        if (!(co2 >= 0 && co2 <= 100)) err('CO2 must be between 0 and 100 %.', P + 'CO2');
        if (!(n2 >= 0 && n2 <= 100)) err('N2 must be between 0 and 100 %.', P + 'N2');
        if (!(h2s >= 0 && h2s <= 100)) err('H2S must be between 0 and 100 %.', P + 'H2S');
        if (co2 >= 0 && h2s >= 0 && n2 >= 0 && co2 + h2s + n2 > 100) err('CO2 + N2 + H2S must not exceed 100 %.', P + 'CO2');
        if (!(urv > 0)) err('DP transmitter range must be greater than zero.', P + 'urv');
        if (!(lo > 0 && lo < 100)) err('Low limit must be between 0 and 100 % of range.', P + 'lo');
        if (!(hi > 0 && hi <= 100)) err('High limit must be above 0 and at most 100 % of range.', P + 'hi');
        else if (lo > 0 && lo < 100 && !(hi > lo)) err('High limit must be above the low limit.', P + 'hi');
        if (!(des >= lo && des <= hi)) err('Design differential must lie between the low and high limits.', P + 'des');
        if (!(TbF > -459.67)) err('Base temperature must be above absolute zero.', P + 'Tb');
        if (!(Pb > 0)) err('Base pressure must be greater than zero.', P + 'Pb');
        if (errors.length) return fail();

        var base = { D: D, Ps: Ps, TfF: TfF, SG: SG, sgBasis: sgBasis, co2: co2, h2s: h2s, n2: n2, TbF: TbF, Pb: Pb, tap: 'flange' };
        var probe = aga(Object.assign({}, base, { d: D / 2, hw: urv * des / 100 }));
        if (!probe.ok) { probe.errors.forEach(function (m) { err(m, null); }); return fail(); }
        base.Z = probe.Z;   // Z is independent of bore and differential
        var Pf1 = probe.Pf1, hwCap = 0.5 * N3 * Pf1;   // x1 = 0.5: far beyond the Y1 validity (0.2)

        function run(d, hw) { return aga(Object.assign({}, base, { d: d, hw: hw })); }
        function qAt(d, hw) { return run(d, hw).Qmscfd; }
        // Differential that passes q through bore d (bisection on hw; q rises with hw below x1 ≈ 0.57).
        function hwFor(d, qq) {
            if (qAt(d, hwCap) < qq) return Infinity;
            var a = 0, b = hwCap;
            for (var i = 0; i < 100; i++) { var m = (a + b) / 2; if (qAt(d, m) < qq) a = m; else b = m; }
            return (a + b) / 2;
        }

        // Exact bore at the design differential (bisection on d; q rises with d).
        var hwDes = urv * des / 100, dMin = BETA_MIN * D, dMax = BETA_MAX * D;
        var dStar = null, dStarFlag = '';
        if (qAt(dMin, hwDes) > q) dStarFlag = 'low';
        else if (qAt(dMax, hwDes) < q) dStarFlag = 'high';
        else {
            var a = dMin, b = dMax;
            for (var i = 0; i < 100; i++) { var m = (a + b) / 2; if (qAt(m, hwDes) < q) a = m; else b = m; }
            dStar = (a + b) / 2;
        }

        // Candidate plates: every 0.125" bore with β in 0.10–0.75.
        var list = [], tolB = 1e-9;
        for (var k = 1; k * STEP <= BETA_MAX * D * (1 + tolB); k++) if (k * STEP >= BETA_MIN * D * (1 - tolB)) list.push(k * STEP);
        if (!list.length) { err('No 0.125" bore gives β between 0.10 and 0.75 in this meter run.', P + 'D'); return fail(); }

        var hwLo = urv * lo / 100, hwHi = urv * hi / 100;
        var candidates = list.map(function (d) {
            var hw = hwFor(d, q);
            var at = isFinite(hw) ? run(d, hw) : null;
            var pct = hw / urv * 100;
            return {
                d: d, bore: d.toFixed(3), beta: d / D, hw: hw, pct: pct,
                inWindow: isFinite(pct) && pct >= lo - 1e-9 && pct <= hi + 1e-9,
                qLo: qAt(d, hwLo), qHi: qAt(d, hwHi),
                Cd: at ? at.Cd : null, Y1: at ? at.Y1 : null, x1: at ? at.x1 : null, Re: at ? at.Re_D : null
            };
        });

        // Choose.
        var idx = -1, rule = '';
        if (dStar != null) {
            var r8 = Math.round(dStar / STEP) * STEP;
            for (var j = 0; j < candidates.length; j++) if (Math.abs(candidates[j].d - r8) < 1e-9 && candidates[j].inWindow) { idx = j; rule = 'rounded'; }
        }
        if (idx < 0) {
            var best = Infinity;
            candidates.forEach(function (c, j) { if (c.inWindow && Math.abs(c.pct - des) < best) { best = Math.abs(c.pct - des); idx = j; rule = 'window'; } });
        }
        var inWin = idx >= 0;
        if (!inWin) {
            // No plate keeps the differential in the window: take the nearest (in % of range).
            var bestD = Infinity;
            candidates.forEach(function (c, j) {
                var dist = !isFinite(c.pct) ? 1e12 : (c.pct < lo ? lo - c.pct : c.pct - hi);
                if (dist < bestD) { bestD = dist; idx = j; }
            });
            rule = 'nearest';
        }
        var chosen = candidates[idx];
        var up = idx + 1 < candidates.length ? candidates[idx + 1] : null;     // larger bore → lower DP
        var down = idx > 0 ? candidates[idx - 1] : null;                        // smaller bore → higher DP
        var t0 = Math.max(0, idx - 3), t1 = Math.min(candidates.length, idx + 4);
        // Exact DP-vs-rate curves (5 … 100 % of range) for the chart.
        [chosen, up, down].forEach(function (c) {
            if (!c) return;
            c.curve = [];
            for (var k = 1; k <= 20; k++) c.curve.push({ pct: k * 5, q: qAt(c.d, urv * k * 5 / 100) });
        });
        var table = candidates.slice(t0, t1).map(function (c) { return Object.assign({ role: c === chosen ? 'chosen' : (c === up ? 'up' : (c === down ? 'down' : '')) }, c); });

        // Verdicts.
        var verdicts = [];
        function v(level, text) { verdicts.push({ level: level, text: text }); }
        var bTxt = _boreTxt(chosen.d);
        if (inWin) v('ok', '✓ ' + bTxt + ' plate (β ' + chosen.beta.toFixed(3) + ') reads ' + _fmt(chosen.pct, 1) + ' % of range at the target rate — inside ' + _fmt(lo, 0) + '–' + _fmt(hi, 0) + ' %.');
        // Review fix: an exact bore exists inside β 0.10–0.75, so the miss is the
        // 0.125" plate step against a narrow window — not the meter run size.
        else if (dStar != null)
            v('bad', '✗ No 0.125" plate lands inside ' + _fmt(lo, 0) + '–' + _fmt(hi, 0) + ' % of range at the target rate (exact bore ' + _boreTxt(dStar, 4) +
                '; nearest plate ' + bTxt + ' reads ' + (isFinite(chosen.pct) ? _fmt(chosen.pct, 1) + ' %' : 'off scale') + ') — widen the window or change the transmitter range.');
        else if (dStarFlag === 'high' || (isFinite(chosen.pct) === false) || chosen.pct > hi)
            v('bad', '✗ No plate with β ≤ 0.75 keeps the differential below ' + _fmt(hi, 0) + ' % of range at the target rate — use a larger meter run or a higher-range transmitter.');
        else
            v('bad', '✗ No plate with β ≥ 0.10 lifts the differential above ' + _fmt(lo, 0) + ' % of range at the target rate — use a smaller meter run or a lower-range transmitter.');
        if (inWin && chosen.x1 > 0.2) v('warn', '⚠ x1 = hw/(N3·Pf1) is ' + chosen.x1.toFixed(3) + ' at the target rate — above 0.2 the Y1 expansion factor is outside its validated range.');
        else if (hwHi / (N3 * Pf1) > 0.2) v('warn', '⚠ At ' + _fmt(hi, 0) + ' % of range x1 exceeds 0.2 — line pressure is low for this transmitter range.');
        if (D < 2) v('warn', '⚠ Meter run ID is below the AGA-3 minimum of 2 in.');
        if (chosen.beta > 0.6 && inWin) v('warn', '⚠ β above 0.6 needs longer upstream straight lengths (AGA-3 Part 2).');

        return {
            ok: true, errors: [], errorIds: [], step: STEP, rule: rule,
            q: q, D: D, Ps: Ps, TfF: TfF, SG: SG, sgBasis: sgBasis, co2: co2, n2: n2, h2s: h2s, urv: urv, lo: lo, hi: hi, des: des, TbF: TbF, Pb: Pb,
            Z: probe.Z, Zb: probe.Zb, Fpv: probe.Fpv, Gr: probe.Gr, Gi: probe.Gi, Pf1: Pf1, Tpr: probe.Tpr, Ppr: probe.Ppr,
            hwDes: hwDes, dStar: dStar, betaStar: dStar != null ? dStar / D : null, dStarFlag: dStarFlag,
            candidates: candidates, chosen: chosen, up: up, down: down, inWindow: inWin, table: table,
            verdicts: verdicts,
            warnings: verdicts.filter(function (x) { return x.level !== 'ok'; }).map(function (x) { return x.text; })
        };
    }
    G.WTS_orifice_compute = compute;

    // ═════════════════════════════════════════════════════════════════
    // PAGE
    // ═════════════════════════════════════════════════════════════════
    var TITLE = 'Orifice Plate Selection';
    var SUB = 'Pick the orifice bore that keeps the differential inside the transmitter range at a target gas rate (inverse AGA-3)';
    var UNITS = { op_q: 'gasRateSmall', op_D: 'lengthSmall', op_P: 'pressureG', op_T: 'temperature', op_urv: 'pressureSmall60', op_Tb: 'temperature', op_Pb: 'pressureBase' };

    function _field(id, label, value, extra) {
        return '<div class="fg-item"><label for="' + id + '">' + label + '</label>' +
            '<input type="number" step="any" id="' + id + '" value="' + value + '"' + (extra || '') + '></div>';
    }
    function _pageHtml() {
        var h = '<div id="op_root"><div class="cols-2"><div style="min-width:0">';
        h += '<div class="card"><div class="card-title">Target Flow &amp; Meter Run</div><div class="fg">';
        h += _field('op_q', 'Target gas rate (MSCFD)', 5000);
        h += _field('op_D', 'Meter run internal diameter (in)', 4.026);
        h += '</div></div>';
        h += '<div class="card"><div class="card-title">Operating Conditions</div><div class="fg">';
        h += _field('op_P', 'Static (line) pressure (psig)', 500);
        h += _field('op_T', 'Flowing temperature (°F)', 80);
        h += '</div></div>';
        h += '<div class="card"><div class="card-title">Gas Composition</div><div class="fg">';
        h += _field('op_SG', 'Gas specific gravity (air = 1)', 0.65, ' min="0.5" max="1.8"');
        h += '<div class="fg-item"><label for="op_sgb">Gas gravity basis</label><select id="op_sgb">' +
            '<option value="real" selected>Real (ρgas/ρair at base)</option><option value="ideal">Ideal (M/M_air)</option></select></div>';
        h += _field('op_CO2', 'CO2 (%)', 0.5);
        h += _field('op_N2', 'N2 (%)', 1.0);
        h += _field('op_H2S', 'H2S (%)', 0);
        h += '</div></div>';
        h += '<div class="card"><div class="card-title">DP Transmitter</div><div class="fg">';
        h += _field('op_urv', 'Transmitter range, 0 to (inH2O)', 200);
        h += _field('op_lo', 'Low limit (% of range)', 20);
        h += _field('op_hi', 'High limit (% of range)', 80);
        h += _field('op_des', 'Design differential (% of range)', 50);
        h += '</div></div>';
        h += '<div class="card"><div class="card-title">Base Conditions</div><div class="fg">';
        h += _field('op_Tb', 'Base temperature (°F)', 60);
        h += _field('op_Pb', 'Base pressure, absolute (psia)', 14.696);
        h += '</div>';
        h += '<div class="btn-row"><button class="btn btn-primary" id="op_calc" onclick="calcOrificeSelect()">Select Plate</button></div>';
        h += '</div>';
        h += '</div><div style="min-width:0"><div id="op_res"></div></div></div></div>';
        return h;
    }

    function renderOrificeSelect(body) {
        body = body || _byId('pgBody');
        if (!body) return;
        var t = _byId('pgTitle'), s = _byId('pgSub');
        if (t) t.textContent = TITLE;
        if (s) s.textContent = SUB;
        body.innerHTML = _pageHtml();
        _tag(UNITS);
        var root = _byId('op_root');
        if (root && root.addEventListener) {
            root.addEventListener('change', function (e) {
                var id = e && e.target && e.target.id;
                if (id && id.indexOf(P) === 0) G.calcOrificeSelect();
            });
        }
        G.calcOrificeSelect();
    }
    G.renderOrificeSelect = renderOrificeSelect;

    function _readInputs() {
        return {
            q: _num('op_q'), D: _num('op_D'), Ps: _num('op_P'), TfF: _num('op_T'), SG: _num('op_SG'),
            sgBasis: (_byId('op_sgb') && _byId('op_sgb').value === 'ideal') ? 'ideal' : 'real',
            co2: _num('op_CO2'), n2: _num('op_N2'), h2s: _num('op_H2S'),
            urv: _num('op_urv'), lo: _num('op_lo'), hi: _num('op_hi'), des: _num('op_des'),
            TbF: _num('op_Tb'), Pb: _num('op_Pb')
        };
    }

    function _row(l, v) { return '<div class="rrow"><span class="rl">' + l + '</span><span class="rv">' + v + '</span></div>'; }
    function _bore(c) { return _boreTxt(c.d); }
    function _dp(c) { return isFinite(c.hw) ? _u(c.hw, 'pressureSmall60', 1, 'inH2O', 1) + ' — ' + _fmt(c.pct, 1) + ' % of range' : 'above x1 = 0.5 (off scale)'; }
    var VCOL = { ok: 'var(--green)', warn: 'var(--yellow)', bad: 'var(--red)' };

    function _resultsHtml(r) {
        var c = r.chosen, h = '';
        r.verdicts.forEach(function (x) {
            h += '<div style="color:' + (VCOL[x.level] || 'var(--yellow)') + ';margin:6px 0;font-size:13px">' + x.text + '</div>';
        });
        h += '<div class="rbox"><div class="rbox-title">Selected Plate</div>';
        h += _row('Orifice bore', _bore(c));
        h += _row('Beta ratio (d/D)', c.beta.toFixed(4));
        h += _row('Differential at target rate', _dp(c));
        h += _row('Rate at ' + _fmt(r.lo, 0) + ' % of range (change down below)', _u(c.qLo, 'gasRateSmall', 1, 'MSCFD', 0));
        h += _row('Rate at ' + _fmt(r.hi, 0) + ' % of range (change up above)', _u(c.qHi, 'gasRateSmall', 1, 'MSCFD', 0));
        h += _row('Discharge coefficient (Cd)', c.Cd != null ? c.Cd.toFixed(5) : '—');
        h += _row('Expansion factor (Y1)', c.Y1 != null ? c.Y1.toFixed(5) : '—');
        h += _row('Pipe Reynolds number', c.Re != null ? _fmt(c.Re, 0) : '—');
        h += '</div>';
        h += '<div class="rbox"><div class="rbox-title">Exact Bore &amp; Neighbours</div>';
        h += _row('Exact bore at ' + _fmt(r.des, 0) + ' % of range', r.dStar != null ? _boreTxt(r.dStar, 4) + ' (β ' + r.betaStar.toFixed(4) + ')' :
            (r.dStarFlag === 'high' ? 'above β 0.75' : 'below β 0.10'));
        h += _row('Next plate up (larger bore)', r.up ? _bore(r.up) + ' — ' + (isFinite(r.up.pct) ? _fmt(r.up.pct, 1) + ' % of range' : 'off scale') : 'none within β 0.75');
        h += _row('Next plate down (smaller bore)', r.down ? _bore(r.down) + ' — ' + (isFinite(r.down.pct) ? _fmt(r.down.pct, 1) + ' % of range' : 'off scale') : 'none within β 0.10');
        h += _row('Z-factor (DAK)', r.Z.toFixed(4));
        h += _row('Base Z-factor (Zb) / Fpv = √(Zb/Zf)', r.Zb.toFixed(5) + ' / ' + r.Fpv.toFixed(5));
        h += _row('Gas gravity real Gr / ideal Gi', r.Gr.toFixed(4) + ' / ' + r.Gi.toFixed(4));
        h += _row('Flowing pressure Pf1', _u(r.Pf1, 'pressure', 1, 'psia', 0));
        h += '</div>';
        // Plate-change table (values written already converted)
        var ql = _lab('gasRateSmall', 'MSCFD'), dl = _lab('pressureSmall60', 'inH2O'), bl = _metric() ? 'in (mm)' : 'in';
        h += '<div class="rbox"><div class="rbox-title">Plate-Change Points</div><div style="overflow-x:auto"><table class="dtable"><thead><tr>' +
            '<th>Plate</th><th>Bore, ' + bl + '</th><th>β</th>' +
            '<th data-wts-unit-label="pressureSmall60">DP at target (' + dl + ')</th><th>% of range</th>' +
            '<th data-wts-unit-label="gasRateSmall">Rate at ' + _fmt(r.lo, 0) + ' % (' + ql + ')</th>' +
            '<th data-wts-unit-label="gasRateSmall">Rate at ' + _fmt(r.hi, 0) + ' % (' + ql + ')</th></tr></thead><tbody>';
        var ROLE = { chosen: 'Selected', up: 'Next up', down: 'Next down' };
        r.table.forEach(function (t) {
            var bd = t.d.toFixed(3) + (_metric() ? ' (' + (t.d * 25.4).toFixed(2) + ')' : '');
            h += '<tr' + (t.role === 'chosen' ? ' style="font-weight:600"' : '') + '><td>' + (ROLE[t.role] || '') + '</td><td>' + bd + '</td><td>' + t.beta.toFixed(3) + '</td><td>' +
                (isFinite(t.hw) ? _fmt(_dv(t.hw, 'pressureSmall60'), 1) : '&gt; scale') + '</td><td>' + (isFinite(t.pct) ? _fmt(t.pct, 1) : '—') + '</td><td>' +
                _fmt(_dv(t.qLo, 'gasRateSmall'), 0) + '</td><td>' + _fmt(_dv(t.qHi, 'gasRateSmall'), 0) + '</td></tr>';
        });
        h += '</tbody></table></div></div>';
        h += '<div class="chart-wrap"><canvas id="op_chart" width="600" height="320"></canvas></div>';
        h += '<div><b>Notes</b> Rates use the AGA-3 page engine (flange taps, RG Cd, DAK Z with Standing + Wichert-Aziz pseudo-criticals; N2 is recorded but not in the Z correction). ' +
            'Fpv = √(Zb/Zf) with the base Z (v3.0; was 1/√Zf, ≈ 0.1–0.3 % high); ' + (r.sgBasis === 'ideal' ? 'ideal gravity converted to real. ' : 'real gravity. ') +
            'Plate list: every 0.125" bore from 0.125" to the largest bore with β ≤ 0.75; the exact bore is rounded to the nearest 0.125" — confirm the plates on site.' +
            ' The 20–80 % window is field practice. Standard volumes are at the entered base conditions (they follow the header "Std" setting until you type your own).</div>';
        return h;
    }

    function _drawChart(r) {
        var cv = _byId('op_chart');
        if (!cv || typeof drawLineChart !== 'function') return;
        var colors = { down: '#58a6ff', chosen: '#f0883e', up: '#3fb950' };
        var ds = [], qMax = 0;
        [['down', r.down], ['chosen', r.chosen], ['up', r.up]].forEach(function (p) {
            var c = p[1]; if (!c) return;
            var pts = (c.curve || []).map(function (pt) { qMax = Math.max(qMax, pt.q); return { x: _dv(pt.q, 'gasRateSmall'), y: pt.pct }; });
            pts.sort(function (a, b) { return a.x - b.x; });
            ds.push({ label: (p[0] === 'chosen' ? 'Selected ' : p[0] === 'up' ? 'Next up ' : 'Next down ') + _boreTxt(c.d), color: colors[p[0]], data: pts, points: false, width: 2 });
        });
        var xm = _dv(qMax, 'gasRateSmall');
        ds.push({ label: _fmt(r.lo, 0) + ' % limit', color: '#8b949e', data: [{ x: 0, y: r.lo }, { x: xm, y: r.lo }], points: false, dash: [6, 4], width: 1 });
        ds.push({ label: _fmt(r.hi, 0) + ' % limit', color: '#8b949e', data: [{ x: 0, y: r.hi }, { x: xm, y: r.hi }], points: false, dash: [6, 4], width: 1 });
        ds.push({ label: 'Target rate', color: '#d2a8ff', data: [{ x: _dv(r.q, 'gasRateSmall'), y: 0 }, { x: _dv(r.q, 'gasRateSmall'), y: 100 }], points: false, dash: [3, 3], width: 1 });
        try {
            drawLineChart(cv, ds, { xLabel: 'Gas rate (' + _lab('gasRateSmall', 'MSCFD') + ')', yLabel: 'DP (% of range)', xMin: 0, yMin: 0, yMax: 100, xDec: 0, yDec: 0 });
        } catch (e) { /* chart is cosmetic */ }
    }

    function _calcImpl() {
        var res = _byId('op_res'), root = _byId('op_root');
        if (root && root.querySelectorAll) {
            var all = root.querySelectorAll('input, select');
            for (var i = 0; i < all.length; i++) if (all[i].classList) all[i].classList.remove('input-err');
        }
        var inp = _readInputs();
        var r = compute(inp);
        G.WTS_state = G.WTS_state || {};
        if (!r.ok) {
            G.WTS_state.orifice = { ok: false, errors: r.errors.slice(), d: null, ts: Date.now() };
            if (res) {
                res.innerHTML = '<div class="val-error"><strong>Please fix the following:</strong><ul>' +
                    r.errors.map(function (m) { return '<li>' + m + '</li>'; }).join('') + '</ul></div>';
                res.setAttribute('data-done', '1');
            }
            r.errorIds.forEach(function (id) { var e = id && _byId(id); if (e && e.classList) e.classList.add('input-err'); });
            return r;
        }
        var c = r.chosen;
        function brief(x) { return x ? { d: x.d, bore: x.bore, beta: x.beta, hw: x.hw, pct: x.pct, qLo: x.qLo, qHi: x.qHi } : null; }
        G.WTS_state.orifice = {
            ok: true, inWindow: r.inWindow, q: r.q, D: r.D, urv: r.urv, lo: r.lo, hi: r.hi,
            d: c.d, bore: c.bore, beta: c.beta, hw: c.hw, pct: c.pct, qLo: c.qLo, qHi: c.qHi, Cd: c.Cd,
            dStar: r.dStar, Z: r.Z, up: brief(r.up), down: brief(r.down), ts: Date.now()
        };
        if (res) {
            res.innerHTML = _resultsHtml(r);
            _drawChart(r);
            res.setAttribute('data-done', '1');
        }
        return r;
    }
    G.calcOrificeSelect = function () { return _canon(_calcImpl); };

    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('wts:unit-system-changed', function () {
            var r = _byId('op_res');
            if (r && r.getAttribute && r.getAttribute('data-done') === '1') G.calcOrificeSelect();
        });
    }

    // ── Round-9 registration (merge, never replace) ──────────────────
    G.WTS_calcRegistry = G.WTS_calcRegistry || {};
    G.WTS_calcRegistry.orifice = {
        key: 'orifice',
        title: TITLE,
        navTitle: 'Orifice Plate Selection',
        sub: SUB,
        group: 'Well Testing',
        icon: '&#9678;',
        badge: 'Metering',
        bc: 'dc-b-blue',
        desc: 'Inverse AGA-3: the plate bore that keeps DP between 20 % and 80 % of the transmitter range at a target rate, with plate-change points.',
        render: function (body) { G.renderOrificeSelect(body); }
    };
})();

// ─── END 45-calc-orifice ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 46-calc-gaspvt ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
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
        return (G.WTS_fmtNum ? G.WTS_fmtNum(v, (d == null ? 2 : d), (d == null ? 2 : d)) : Number(v).toLocaleString(undefined, { minimumFractionDigits: (d == null ? 2 : d), maximumFractionDigits: (d == null ? 2 : d) }));
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
        // AGA-3 / API MPMS 14.3.3 supercompressibility Fpv = √(Zb/Zf) (v3.0, as the AGA-3 engine;
        // was 1/√Z with Zb = 1): Zb = DAK Z at the standard conditions on the same pseudo-criticals.
        s.Zb = L.Z_dranchukAbouKassem(T_SC / pc.Tpc, P_SC / pc.Ppc);
        s.Fpv = Math.sqrt(s.Zb / Z);
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
            _row('Apparent molecular weight', _fmt(r.M, 2) + (_metric() ? ' kg/kmol' : ' lb/lb-mol')) +   // same number in both
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
                _row('Supercompressibility Fpv = √(Zb/Z)', _fmt(s.Fpv, 4) + ' (Zb ' + _fmt(s.Zb, 5) + ')') +
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
            '1,552 ft/s). Fpv = √(Zb/Z) with the DAK base Z at 14.696 psia / 60 °F (AGA-3; v3.0, was 1/√Z).</div>';
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

// ─── END 46-calc-gaspvt ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 47-calc-historian ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════
// 47-calc-historian.js — Mini WellOS historian (v3.0, Round-9 plug-in)
//
// A small process historian that runs entirely in the browser:
//   • record()  — cheap in-memory buffer, flushed in batches on a short
//                 one-shot debounce (2 s) or at once when 2000 samples wait.
//                 No timer exists while the buffer is empty.
//   • storage   — auto-selected, shown on the page:
//        1. opfs    official SQLite WASM build (@sqlite.org/sqlite-wasm 3.53.4)
//                   in a dedicated Worker on the OPFS "opfs-sahpool" VFS
//                   (sync access handles are Worker-only; no COOP/COEP needed).
//        2. sqljs   sql.js 1.14.2 (SQLite compiled to WASM) in memory, the
//                   whole database file snapshotted to IndexedDB.
//        3. idb     plain IndexedDB object stores with the same API.
//        4. memory  volatile (private windows / tests); never persisted.
//      The engine that first holds data becomes "home"; if it is unavailable
//      later (another tab holds the OPFS files, offline without the library)
//      the samples are spooled to IndexedDB and merged into home next time.
//   • schema    tags(id, name, device, unit, descr, created)
//               samples(tag_id, t, v, q) — clustered PRIMARY KEY (tag_id, t)
//                 (WITHOUT ROWID: the key IS the (tag_id, t) index)
//               rollups(tag_id, t, dt, n, avg, min, max, last, lt, q, nall)
//      t = epoch ms (UTC), v = REAL or NULL, q = 0 good / 1 stale / 2 bad.
//   • retention days / maxRows / downsampleAfterDays; raw samples older than
//     downsampleAfterDays become 60-s rollups. The job runs after a flush (at
//     most every 10 min, or at once when over the row cap) — never on a timer.
//   • libraries load only on first use: web → pinned CDN URL, SHA-384 checked
//     before use (bytes that fail the check are never executed); iOS → the copy
//     bundled next to index.html (ios-app/ios-additions/libs, copied by
//     sync-from-main.js). sw.js precaches the pinned URLs for offline use.
//
// Public API (window.WTS_historian) — contract with the Modbus page:
//   record(samples)  samples = [{tag, device, t, v, q, raw, unit}]  → count accepted
//   query({tags, from, to, maxPoints, agg:'raw'|'avg'|'min'|'max'|'last', bucketMs})
//   listTags() stats() exportCSV(o) exportXLSX(o) exportDb(o) importFile(file, o)
//   purge({before, tags}) setRetention({days, maxRows, downsampleAfterDays})
//   flush() ready() engine() status() switchEngine(name)
// Inputs also accepted as document event 'wts:modbus-samples' (detail = batch).
// Tag metadata from window.WTS_modbus.getTags() when present.
// Fires document event 'wts:historian-updated' after every write.
//
// Aggregation rule (documented on the page): a bucket's avg/min/max/last use
// its GOOD samples; if it has none, its STALE samples (bucket flagged stale);
// with neither the bucket is a gap (bad). Averages are arithmetic means of the
// samples, not time-weighted. Buckets start at multiples of bucketMs since the
// Unix epoch (UTC). LTTB = Steinarsson (2013), "Downsampling Time Series for
// Visual Representation", MSc thesis, University of Iceland, §4.2.
// ════════════════════════════════════════════════════════════════════
(function () {
'use strict';
var G = (typeof window !== 'undefined') ? window : globalThis;
function hasDoc() { return typeof document !== 'undefined' && !!document && typeof document.getElementById === 'function'; }
function $(id) { return hasDoc() ? document.getElementById(id) : null; }

// ─── §0 constants ────────────────────────────────────────────────────
var QN = ['good', 'stale', 'bad'];
var ROLLUP_MS = 60000, DAY = 86400000, MAXT = 8640000000000000;
var FLUSH_MS = 2000, FLUSH_MAX = 2000, BUFFER_CAP = 200000, CHUNK = 20000;
var RETENTION_EVERY_MS = 600000;
var LS_SETTINGS = 'wts_historian_settings', LS_VIEW = 'wts_historian_view';
var LS_HOME = 'wtshist_home', LS_SPOOL = 'wtshist_spool';      // not wts_* → never copied into project files
var IDB_NAME = 'wts-historian', SNAP_DB = 'wts-historian-sqljs', SNAP_STORE = 'files', SNAP_KEY = 'historian.sqlite';
var OPFS_VFS = 'wts-historian', OPFS_DIR = '.wts-historian', OPFS_FILE = '/historian.sqlite3';
var ENGINES = ['opfs', 'sqljs', 'idb', 'memory'];
// Raw-sample caps per engine (0 = only the user's maxRows applies). sql.js keeps the
// whole file in memory and re-writes it to IndexedDB, IndexedDB costs ~100+ bytes a row.
var ENGINE_CAPS = { opfs: 0, sqljs: 1000000, idb: 2000000, memory: 200000 };
var ENGINE_LABEL = {
    opfs: 'SQLite (OPFS, worker)', sqljs: 'SQLite (sql.js) in IndexedDB',
    idb: 'IndexedDB', memory: 'Memory only (not saved)'
};
var DEFAULTS = { days: 30, maxRows: 5000000, downsampleAfterDays: 7 };

// Pinned libraries. base64 SHA-384 of the exact published files (identical on
// jsDelivr, unpkg and the npm tarballs; checked 2026-09-29). The iOS bundle ships
// the same bytes under the key names; ios-app/scripts/sync-from-main.js re-checks them.
var CDN = 'https://cdn.jsdelivr.net/npm/', UNPKG = 'https://unpkg.com/';
var SQLITE_PKG = '@sqlite.org/sqlite-wasm@3.53.4-build1/dist/', SQLJS_PKG = 'sql.js@1.14.2/dist/';
var HIST_SHA384 = {
    'sqlite3.mjs': 'j+gbV/w2zeGv9WgmsnVPrKK5J4gE96kxDRDMpGJTnRgI68fZrprxhjFdcuoaGIdC',
    'sqlite3.wasm': 'zML1l9maR5lcyboDPcoNcYzQnFUv0o9WvMB8Pn16kfu9F+YX+62NQVuTzV0f3/07',
    'sql-wasm.js': '7Zym2PlgXfg8ap8cqJUwlZrLl+VEwt0NVbzYfhH28IWLnSpAgQOnSCY2+EXo5MtM',
    'sql-wasm.wasm': 'x0YkuPkDHnKTZcB1JO4eb6j5+eU36aka+jBA6tOKTFaTz98b9V7fPT0QgZ9qyQW2'
};
var LIBS = {
    'sqlite3.mjs': { urls: [CDN + SQLITE_PKG + 'index.mjs', UNPKG + SQLITE_PKG + 'index.mjs'], bytes: 642742 },
    'sqlite3.wasm': { urls: [CDN + SQLITE_PKG + 'sqlite3.wasm', UNPKG + SQLITE_PKG + 'sqlite3.wasm'], bytes: 868907 },
    'sql-wasm.js': { urls: [CDN + SQLJS_PKG + 'sql-wasm.js', UNPKG + SQLJS_PKG + 'sql-wasm.js'], bytes: 46535 },
    'sql-wasm.wasm': { urls: [CDN + SQLJS_PKG + 'sql-wasm.wasm', UNPKG + SQLJS_PKG + 'sql-wasm.wasm'], bytes: 658410 }
};

// Test hooks (tests/historian.test.js): fetchBytes(url) → ArrayBuffer, workerMemory → ':memory:' in the worker.
var T = { fetchBytes: null, workerMemory: false, noEstimate: false };

// ─── §1 small utilities ──────────────────────────────────────────────
function isNum(x) { return typeof x === 'number' && isFinite(x); }
function numOr(x, d) { var n = +x; return (x === null || x === undefined || x === '' || !isFinite(n)) ? d : n; }
function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}
function errMsg(e) { return String((e && e.message) || e || 'error'); }
function lsGet(k) { try { return G.localStorage ? G.localStorage.getItem(k) : null; } catch (e) { return null; } }
function lsSet(k, v) { try { if (G.localStorage) G.localStorage.setItem(k, v); } catch (e) { /* quota / private mode */ } }
function lsJSON(k) { try { var s = lsGet(k); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function pad3(n) { return n < 10 ? '00' + n : n < 100 ? '0' + n : '' + n; }
function fmtLocal(t, ms) {
    if (!isNum(t)) return '—';
    var d = new Date(t);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' +
        pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) + (ms ? '.' + pad3(d.getMilliseconds()) : '');
}
function isoUTC(t) { return new Date(t).toISOString(); }
function fmtVal(v) {
    if (v === null || v === undefined || !isFinite(v)) return '';
    var a = Math.abs(v);
    if (a !== 0 && (a >= 1e9 || a < 1e-4)) return v.toExponential(4);
    return String(+v.toPrecision(7));
}
function fmtCount(n) { return isNum(n) ? String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '—'; }
function fmtBytes(n) {
    if (!isNum(n)) return '—';
    var u = ['B', 'kB', 'MB', 'GB', 'TB'], i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i ? n.toFixed(n < 10 ? 2 : 1) : String(Math.round(n))) + ' ' + u[i];
}
function fmtDur(ms) {
    if (!isNum(ms)) return '—';
    var s = Math.abs(ms) / 1000;
    if (s < 60) return Math.round(s) + ' s';
    if (s < 3600) return Math.round(s / 60) + ' min';
    if (s < 172800) return (s / 3600).toFixed(s < 36000 ? 1 : 0) + ' h';
    return (s / 86400).toFixed(1) + ' d';
}
function stamp(t) { var d = new Date(t); return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes()); }
function uniq(a) { var s = {}, o = []; for (var i = 0; i < a.length; i++) if (!s[a[i]]) { s[a[i]] = 1; o.push(a[i]); } return o; }
function repeat(x, n) { var a = new Array(n); for (var i = 0; i < n; i++) a[i] = x; return a; }
function isDateObj(x) { return Object.prototype.toString.call(x) === '[object Date]'; }

// Quality: 0 good, 1 stale (held / uncertain), 2 bad. A missing value is never "good".
function qCode(q, v) {
    var c = -1;
    if (q === 0 || q === 1 || q === 2) c = q;
    else if (typeof q === 'string') {
        var s = q.trim().toLowerCase();
        if (s === 'good' || s === 'g' || s === 'ok' || s === '0') c = 0;
        else if (s === 'stale' || s === 's' || s === 'uncertain' || s === 'u' || s === 'held' || s === '1') c = 1;
        else if (s === 'bad' || s === 'b' || s === 'error' || s === 'fault' || s === '2') c = 2;
    }
    if (c < 0) c = (v === null) ? 2 : 0;
    if (v === null && c === 0) c = 2;
    return c;
}
function cleanStr(x, max) { if (x === null || x === undefined) return null; var s = String(x).trim(); return s ? s.slice(0, max || 64) : null; }

// One sample from record(): {tag, device, t, v, q, raw, unit} → normalised or null.
function normSample(s, tNow) {
    if (!s || typeof s !== 'object') return null;
    var tag = cleanStr(s.tag != null ? s.tag : s.name, 128);
    if (!tag) return null;
    var t = isDateObj(s.t) ? s.t.getTime() : +s.t;
    if (s.t === null || s.t === undefined || s.t === '' || !isFinite(t)) t = tNow;
    t = Math.round(t);
    if (!(t >= 0 && t <= MAXT)) return null;
    var v = s.v;
    v = (v === null || v === undefined || v === '') ? null : +v;
    if (v !== null && !isFinite(v)) v = null;
    var o = { tag: tag, device: cleanStr(s.device), t: t, v: v, q: qCode(s.q, v), raw: s.raw, unit: cleanStr(s.unit, 32) };
    if (s.desc != null && s.desc !== '') o.desc = cleanStr(s.desc, 200);          // optional description (Mini WellOS form values)
    return o;
}

// ─── §2 pure algorithms ──────────────────────────────────────────────
// Streaming bucket aggregator (reference implementation; the SQL store computes
// the same numbers in SQL). Rows must arrive in ascending t.
function Agg(b) { this.b = b; this.out = []; this.cur = null; }
function _cat() { return { n: 0, sum: 0, min: Infinity, max: -Infinity, last: null, lt: -Infinity }; }
function _fin(c) {
    var x = c.g.n ? c.g : c.s.n ? c.s : null, q = c.g.n ? 0 : c.s.n ? 1 : 2;
    if (!x) return { t: c.k, n: 0, avg: null, min: null, max: null, last: null, lt: null, q: 2, nall: c.nall };
    return { t: c.k, n: x.n, avg: x.sum / x.n, min: x.min, max: x.max, last: x.last, lt: x.lt, q: q, nall: c.nall };
}
Agg.prototype.push = function (t, v, q) {
    var k = t - (t % this.b), c = this.cur;
    if (!c || c.k !== k) {
        if (c) this.out.push(_fin(c));
        c = this.cur = { k: k, nall: 0, g: _cat(), s: _cat() };
    }
    c.nall++;
    if (v === null || v === undefined || !isFinite(v)) return;
    var x = q === 0 ? c.g : q === 1 ? c.s : null;
    if (!x) return;
    x.n++; x.sum += v;
    if (v < x.min) x.min = v;
    if (v > x.max) x.max = v;
    if (t >= x.lt) { x.lt = t; x.last = v; }
};
Agg.prototype.result = function () { if (this.cur) { this.out.push(_fin(this.cur)); this.cur = null; } return this.out; };
function aggArrays(t, v, q, b) { var a = new Agg(b); for (var i = 0; i < t.length; i++) a.push(t[i], v[i], q[i]); return a.result(); }

// Combine bucket partials {t,n,avg,min,max,last,lt,q,nall} into buckets of b ms
// (b = 0 → by exact t). Same rule as Agg: good partials if any, else stale, else a gap.
// Merging partials chosen that way gives the same result as re-aggregating the samples.
function _combine(k, src, q, nall) {
    if (!src.length) return { t: k, n: 0, avg: null, min: null, max: null, last: null, lt: null, q: 2, nall: nall };
    if (src.length === 1) { var o = src[0]; return { t: k, n: o.n, avg: o.avg, min: o.min, max: o.max, last: o.last, lt: o.lt, q: q, nall: nall }; }
    var n = 0, sum = 0, mn = Infinity, mx = -Infinity, last = null, lt = -Infinity;
    for (var i = 0; i < src.length; i++) {
        var p = src[i];
        n += p.n; sum += p.avg * p.n;
        if (p.min < mn) mn = p.min;
        if (p.max > mx) mx = p.max;
        if (p.lt > lt) { lt = p.lt; last = p.last; }
    }
    return { t: k, n: n, avg: sum / n, min: mn, max: mx, last: last, lt: lt, q: q, nall: nall };
}
function mergePartials(list, b) {
    var map = {}, keys = [];
    for (var i = 0; i < list.length; i++) {
        var p = list[i], k = b ? p.t - (p.t % b) : p.t, m = map[k];
        if (!m) { m = map[k] = { g: [], s: [], nall: 0 }; keys.push(k); }
        m.nall += (p.nall || 0);
        if (p.q === 0 && p.n > 0) m.g.push(p); else if (p.q === 1 && p.n > 0) m.s.push(p);
    }
    keys.sort(function (a, c) { return a - c; });
    return keys.map(function (k) {
        var m = map[k];
        return _combine(k, m.g.length ? m.g : m.s, m.g.length ? 0 : m.s.length ? 1 : 2, m.nall);
    });
}

// Largest-Triangle-Three-Buckets over indices [i0, i1): returns kept indices.
// Transcribed from Steinarsson (2013) §4.2 / his reference implementation: first and
// last points kept; the rest split into (threshold−2) equal buckets; in each bucket the
// point forming the largest triangle with the previously kept point and the average
// of the next bucket is kept.
function lttbIdx(x, y, i0, i1, threshold) {
    var len = i1 - i0, out = [], j;
    if (threshold >= len || threshold < 3) { for (j = i0; j < i1; j++) out.push(j); return out; }
    var every = (len - 2) / (threshold - 2), a = i0;
    out.push(i0);
    for (var i = 0; i < threshold - 2; i++) {
        var s = i0 + Math.floor((i + 1) * every) + 1, e = i0 + Math.floor((i + 2) * every) + 1;
        if (e > i1) e = i1;
        var ax2 = 0, ay2 = 0, cnt = e - s;
        for (j = s; j < e; j++) { ax2 += x[j]; ay2 += y[j]; }
        ax2 /= cnt; ay2 /= cnt;
        var r0 = i0 + Math.floor(i * every) + 1, r1 = i0 + Math.floor((i + 1) * every) + 1;
        var ax = x[a], ay = y[a], best = -1, next = r0;
        for (j = r0; j < r1; j++) {
            var area = Math.abs((ax - ax2) * (y[j] - ay) - (ax - x[j]) * (ay2 - ay)) * 0.5;
            if (area > best) { best = area; next = j; }
        }
        out.push(next); a = next;
    }
    out.push(i1 - 1);
    return out;
}
// LTTB that respects gaps: points with no value or bad quality split the series
// into runs; each gap keeps one marker point, each run gets a share of the budget
// proportional to its length (at least its two end points). Returns kept indices
// (ascending) or null when nothing needs dropping.
function decimate(t, v, q, maxPoints) {
    var n = t.length;
    if (!(maxPoints > 0) || n <= maxPoints) return null;
    var ok = function (i) { return v[i] !== null && v[i] !== undefined && isFinite(v[i]) && q[i] !== 2; };
    var runs = [], keep = [], i = 0, total = 0;
    while (i < n) {
        if (ok(i)) { var s = i; while (i < n && ok(i)) i++; runs.push([s, i]); total += i - s; }
        else { keep.push(i); while (i < n && !ok(i)) i++; }
    }
    var budget = Math.max(maxPoints - keep.length, runs.length * 2);
    runs.forEach(function (r) {
        var len = r[1] - r[0], alloc = Math.max(Math.min(len, 2), Math.round(budget * len / Math.max(1, total)));
        var idx = alloc >= len ? null : alloc < 3 ? (len === 1 ? [r[0]] : [r[0], r[1] - 1]) : lttbIdx(t, v, r[0], r[1], alloc);
        if (!idx) { for (var j = r[0]; j < r[1]; j++) keep.push(j); } else keep.push.apply(keep, idx);
    });
    keep.sort(function (a, b) { return a - b; });
    return keep;
}

var BUCKETS = [100, 200, 500, 1e3, 2e3, 5e3, 1e4, 15e3, 3e4, 6e4, 12e4, 3e5, 6e5, 9e5, 18e5, 36e5, 72e5, 108e5, 216e5, 432e5, 864e5, 1728e5, 6048e5];
function niceBucket(ms) { for (var i = 0; i < BUCKETS.length; i++) if (BUCKETS[i] >= ms) return BUCKETS[i]; return Math.ceil(ms / 864e5) * 864e5; }
function bucketLabel(ms) {
    if (ms < 1000) return ms + ' ms';
    if (ms < 60000) return (ms / 1000) + ' s';
    if (ms < 3600000) return (ms / 60000) + ' min';
    if (ms < DAY) return (ms / 3600000) + ' h';
    return (ms / DAY) + ' d';
}
// "Nice" axis ticks (Heckbert, "Nice numbers for graph labels", Graphics Gems, 1990).
function niceNum(x, round) {
    var e = Math.floor(Math.log(x) / Math.LN10), f = x / Math.pow(10, e), nf;
    if (round) nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10; else nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
    return nf * Math.pow(10, e);
}
function niceTicks(lo, hi, n) {
    if (!(hi > lo)) { var d0 = Math.abs(lo) * 0.05 || 1; lo -= d0; hi += d0; }
    var range = niceNum(hi - lo, false), step = niceNum(range / Math.max(1, n - 1), true);
    var a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step, ticks = [];
    for (var x = a; x <= b + step * 0.5 && ticks.length < 50; x += step) ticks.push(+x.toPrecision(12));
    return { lo: a, hi: b, step: step, ticks: ticks };
}
var TSTEPS = [1e3, 2e3, 5e3, 1e4, 15e3, 3e4, 6e4, 12e4, 3e5, 6e5, 9e5, 18e5, 36e5, 72e5, 108e5, 216e5, 432e5, 864e5, 1728e5, 6048e5, 2592e6];
function timeTicks(from, to, maxTicks) {
    var span = to - from, step = TSTEPS[TSTEPS.length - 1];
    for (var i = 0; i < TSTEPS.length; i++) if (span / TSTEPS[i] <= Math.max(2, maxTicks)) { step = TSTEPS[i]; break; }
    var tz = -new Date(from).getTimezoneOffset() * 60000;            // align hour/day ticks to local time
    var off = step >= 36e5 ? tz : 0, out = [];
    for (var t = Math.ceil((from + off) / step) * step - off; t <= to && out.length < 60; t += step) out.push(t);
    return { step: step, ticks: out };
}
function tickLabel(t, step, span) {
    var d = new Date(t);
    if (step >= DAY) return pad2(d.getDate()) + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
    var hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    if (step < 60000) return hm + ':' + pad2(d.getSeconds());
    if (span > DAY && d.getHours() === 0 && d.getMinutes() === 0) return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1);
    return hm;
}

// ─── §3 CSV / time parsing ───────────────────────────────────────────
function csvCell(s) { s = (s === null || s === undefined) ? '' : String(s); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function csvLine(row) { return row.map(csvCell).join(',') + '\r\n'; }
function parseDelimited(text) {
    text = String(text == null ? '' : text);
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    var nl = text.indexOf('\n'), first = nl < 0 ? text : text.slice(0, nl);
    var cnt = function (ch) { return first.split(ch).length - 1; };
    var d = ',', nc = cnt(','), ns = cnt(';'), nt = cnt('\t');
    if (nt > nc && nt >= ns) d = '\t'; else if (ns > nc) d = ';';
    var rows = [], row = [], cell = '', i = 0, n = text.length, inQ = false;
    while (i < n) {
        var c = text[i];
        if (inQ) {
            if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i += 2; continue; } inQ = false; i++; continue; }
            cell += c; i++; continue;
        }
        if (c === '"' && cell === '') { inQ = true; i++; continue; }
        if (c === d) { row.push(cell); cell = ''; i++; continue; }
        if (c === '\r' || c === '\n') {
            row.push(cell); cell = '';
            if (!(row.length === 1 && row[0] === '')) rows.push(row);
            row = [];
            i += (c === '\r' && text[i + 1] === '\n') ? 2 : 1;
            continue;
        }
        cell += c; i++;
    }
    if (cell !== '' || row.length) { row.push(cell); if (!(row.length === 1 && row[0] === '')) rows.push(row); }
    return rows;
}
// Time cell → epoch ms. ISO strings with Z/offset → exact; "YYYY-MM-DD HH:MM[:SS[.mmm]]"
// without a zone → local time; numbers: > 1e11 epoch ms, > 1e9 epoch s, else an Excel
// serial day number (read as UTC, the way this page writes times).
function epochFromNumber(n) {
    if (n > 1e11) return Math.round(n);
    if (n > 1e9) return Math.round(n * 1000);
    if (n > 0 && n < 2958466) return Math.round((n - 25569) * DAY);
    return NaN;
}
function parseTime(x) {
    if (x === null || x === undefined || x === '') return NaN;
    if (typeof x === 'number') return epochFromNumber(x);
    if (isDateObj(x)) return x.getTime();
    var s = String(x).trim();
    if (/^-?\d+(\.\d+)?$/.test(s)) return epochFromNumber(+s);
    if (/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(s) && /^\d{4}-\d/.test(s)) return Date.parse(s.replace(' ', 'T'));
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/.exec(s);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), +((m[7] || '0') + '00').slice(0, 3)).getTime();
    var p = Date.parse(s);
    return isFinite(p) ? p : NaN;
}
var LONG_HEAD = ['time_utc', 'epoch_ms', 'tag', 'value', 'quality', 'unit', 'device', 'source', 'n', 'min', 'max'];
// Spreadsheet rows (array of arrays) → {format, tags:{name:{unit,device}}, samples:{tag:{t,v,q}}, rollups:{tag:[…]}, invalid}
// Long layout: columns tag + value (+ time_utc / epoch_ms, quality, unit, device, source, n, min, max).
// Wide layout: a time column then one column per tag, headed "TAG [unit]".
function rowsToImport(aoa) {
    var hi = -1, i, j;
    for (i = 0; i < Math.min(aoa.length, 25); i++) {
        var r = aoa[i] || [], filled = 0, text = false;
        for (j = 0; j < r.length; j++) {
            var c = r[j];
            if (c === null || c === undefined || String(c).trim() === '') continue;
            filled++;
            if (typeof c === 'string' && !isFinite(+c)) text = true;
        }
        if (filled >= 2 && text) { hi = i; break; }
    }
    if (hi < 0) throw new Error('No header row found — expected columns such as time_utc, tag, value.');
    var H = aoa[hi].map(function (c) { return String(c == null ? '' : c).trim(); }), h = H.map(function (x) { return x.toLowerCase(); });
    var col = function (names) { for (var k = 0; k < names.length; k++) { var ix = h.indexOf(names[k]); if (ix >= 0) return ix; } return -1; };
    var cT = col(['time_utc', 'time', 'timestamp', 'datetime', 'date_time', 'date', 'time (utc)', 'local_time', 'bucket_start']);
    var cE = col(['epoch_ms', 'epoch', 't_ms', 'unix_ms', 't']);
    var out = { format: '', tags: {}, samples: {}, rollups: {}, invalid: 0, rows: 0 };
    var timeOf = function (row) { var t = cE >= 0 ? parseTime(row[cE]) : NaN; if (!isFinite(t) && cT >= 0) t = parseTime(row[cT]); return t; };
    var ser = function (tag) { return out.samples[tag] || (out.samples[tag] = { t: [], v: [], q: [] }); };
    var numCell = function (c) { if (c === null || c === undefined || String(c).trim() === '') return null; var x = +c; return isFinite(x) ? x : NaN; };
    if (cE < 0 && cT < 0) throw new Error('No time column found — expected time_utc, epoch_ms or timestamp.');
    var cTag = col(['tag', 'tag_name', 'name', 'tagname']), cV = col(['value', 'v', 'val', 'avg']);
    if (cTag >= 0 && cV >= 0) {
        out.format = 'long';
        var cQ = col(['quality', 'q']), cU = col(['unit', 'units']), cD = col(['device']), cS = col(['source']),
            cN = col(['n', 'count']), cMin = col(['min']), cMax = col(['max']);
        for (i = hi + 1; i < aoa.length; i++) {
            var row = aoa[i] || [];
            if (!row.length || row.every(function (c) { return c === null || c === undefined || String(c).trim() === ''; })) continue;
            out.rows++;
            var tag = cleanStr(row[cTag], 128), t = timeOf(row), v = numCell(row[cV]);
            if (!tag || !isFinite(t) || t < 0 || (typeof v === 'number' && !isFinite(v))) { out.invalid++; continue; }
            var q = qCode(cQ >= 0 ? row[cQ] : undefined, v);
            if (!out.tags[tag]) out.tags[tag] = { unit: cU >= 0 ? cleanStr(row[cU], 32) : null, device: cD >= 0 ? cleanStr(row[cD]) : null };
            var src = cS >= 0 ? String(row[cS] || '').toLowerCase() : '';
            if (/^rollup/.test(src)) {
                var nn = numCell(cN >= 0 ? row[cN] : null), mn = numCell(cMin >= 0 ? row[cMin] : null), mx = numCell(cMax >= 0 ? row[cMax] : null);
                if (v === null || !isNum(nn) || nn < 1) { out.invalid++; continue; }
                (out.rollups[tag] || (out.rollups[tag] = [])).push({ t: Math.round(t), n: Math.round(nn), avg: v, min: isNum(mn) ? mn : v, max: isNum(mx) ? mx : v,
                    last: v, lt: Math.round(t), q: q === 2 ? 2 : q, nall: Math.round(nn), dt: ROLLUP_MS });
                continue;
            }
            var s = ser(tag); s.t.push(Math.round(t)); s.v.push(v); s.q.push(q);
        }
        return out;
    }
    out.format = 'wide';
    var cols = [];
    for (j = 0; j < H.length; j++) {
        if (j === cT || j === cE || !H[j]) continue;
        if (/^(local_time|n|quality)$/i.test(H[j])) continue;
        var m = /^(.*?)\s*\[(.*)\]\s*$/.exec(H[j]), tg = cleanStr(m ? m[1] : H[j], 128);
        if (!tg) continue;
        cols.push({ j: j, tag: tg });
        if (!out.tags[tg]) out.tags[tg] = { unit: m ? cleanStr(m[2], 32) : null, device: null };
    }
    if (!cols.length) throw new Error('No value columns found next to the time column.');
    for (i = hi + 1; i < aoa.length; i++) {
        var rw = aoa[i] || [];
        if (!rw.length) continue;
        out.rows++;
        var tt = timeOf(rw);
        if (!isFinite(tt) || tt < 0) { out.invalid++; continue; }
        for (var k = 0; k < cols.length; k++) {
            var val = numCell(rw[cols[k].j]);
            if (val === null) continue;
            if (!isFinite(val)) { out.invalid++; continue; }
            var sw = ser(cols[k].tag); sw.t.push(Math.round(tt)); sw.v.push(val); sw.q.push(0);
        }
    }
    return out;
}

// ─── §4 stores ───────────────────────────────────────────────────────
// Every store exposes the same (async on the outside) methods:
//   init() info() getTags() putTags(list) putSamples(ids,ts,vs,qs,mode) getSamples(id,from,to,limit,desc)
//   countSamples(id,from,to) deleteSamples(id,from,to) aggSamples(id,from,to,b) statsAll()
//   putRollups(id,parts) getRollups(id,from,to) countRollups(id,from,to) deleteRollups(id,from,to)
//   totals() clear() vacuum() close() [+ exportBytes() on the SQL stores]
// mode: 'ignore' keeps an existing (tag_id, t) row, 'replace' overwrites it.

// SQL store over a tiny adapter A {all(sql,p) → rows[], run(sql,p) → changes, prep(sql) → {run, all, free},
// exportBytes(), close(), version}. Self-contained (no outer references): its source is
// also shipped into the storage Worker with Function.prototype.toString.
function HistSqlStore(A) {
    var SCHEMA = [
        'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)',
        'CREATE TABLE IF NOT EXISTS tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, device TEXT, unit TEXT, descr TEXT, created INTEGER)',
        // Clustered primary key (tag_id, t): the table is its own (tag_id, t) index.
        'CREATE TABLE IF NOT EXISTS samples (tag_id INTEGER NOT NULL, t INTEGER NOT NULL, v REAL, q INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tag_id, t)) WITHOUT ROWID',
        'CREATE TABLE IF NOT EXISTS rollups (tag_id INTEGER NOT NULL, t INTEGER NOT NULL, dt INTEGER NOT NULL, n INTEGER NOT NULL, avg REAL, min REAL, max REAL, last REAL, lt INTEGER, q INTEGER NOT NULL, nall INTEGER NOT NULL, PRIMARY KEY (tag_id, t)) WITHOUT ROWID'
    ];
    // Bucket start = t − (t mod b): SQLite's % casts both sides to INTEGER, so the bucket
    // is exact whatever type the driver binds b as. Per bucket: the good and the stale
    // statistics side by side; the last value of each is looked up by its time.
    var AGG = 'SELECT g.k, g.nall, g.ng, g.ag, g.ming, g.maxg, g.ltg, (SELECT v FROM samples WHERE tag_id=?2 AND t=g.ltg), ' +
        'g.ns, g.as1, g.mins, g.maxs, g.lts, (SELECT v FROM samples WHERE tag_id=?2 AND t=g.lts) FROM (' +
        'SELECT t - (t % ?1) AS k, count(*) AS nall, ' +
        'sum(CASE WHEN q=0 AND v IS NOT NULL THEN 1 ELSE 0 END) AS ng, avg(CASE WHEN q=0 THEN v END) AS ag, ' +
        'min(CASE WHEN q=0 THEN v END) AS ming, max(CASE WHEN q=0 THEN v END) AS maxg, max(CASE WHEN q=0 AND v IS NOT NULL THEN t END) AS ltg, ' +
        'sum(CASE WHEN q=1 AND v IS NOT NULL THEN 1 ELSE 0 END) AS ns, avg(CASE WHEN q=1 THEN v END) AS as1, ' +
        'min(CASE WHEN q=1 THEN v END) AS mins, max(CASE WHEN q=1 THEN v END) AS maxs, max(CASE WHEN q=1 AND v IS NOT NULL THEN t END) AS lts ' +
        'FROM samples WHERE tag_id=?2 AND t>=?3 AND t<=?4 GROUP BY k) g ORDER BY g.k';
    function N(x) { return (x === null || x === undefined) ? null : Number(x); }
    function rows(sql, p) { return A.all(sql, p || []); }
    function one(sql, p) { var r = rows(sql, p); return r.length ? r[0] : null; }
    function tx(fn) {
        A.run('BEGIN');
        try { var r = fn(); A.run('COMMIT'); return r; }
        catch (e) { try { A.run('ROLLBACK'); } catch (e2) { /* already rolled back */ } throw e; }
    }
    function part(k, n, avg, mn, mx, last, lt, q, nall) {
        return { t: N(k), n: N(n), avg: N(avg), min: N(mn), max: N(mx), last: N(last), lt: N(lt), q: q, nall: N(nall) };
    }
    function tagRow(r) { return { id: N(r[0]), name: String(r[1]), device: r[2] == null ? null : String(r[2]), unit: r[3] == null ? null : String(r[3]), descr: r[4] == null ? null : String(r[4]), created: N(r[5]) }; }
    function rollRow(r) { return { t: N(r[0]), dt: N(r[1]), n: N(r[2]), avg: N(r[3]), min: N(r[4]), max: N(r[5]), last: N(r[6]), lt: N(r[7]), q: N(r[8]), nall: N(r[9]) }; }
    function putR(id, parts) {                                         // caller holds a transaction
        var st = A.prep('INSERT OR REPLACE INTO rollups (tag_id, t, dt, n, avg, min, max, last, lt, q, nall) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        try {
            for (var i = 0; i < parts.length; i++) {
                var p = parts[i];
                st.run([id, p.t, p.dt || 60000, p.n, p.avg, p.min, p.max, p.last, p.lt, p.q, p.nall == null ? p.n : p.nall]);
            }
        } finally { st.free(); }
    }
    var S = {
        kind: 'sql',
        init: function () {
            var tables = N(one("SELECT count(*) FROM sqlite_master WHERE type='table'")[0]);
            if (!tables) A.run('PRAGMA auto_vacuum=INCREMENTAL');        // only effective before the first table
            SCHEMA.forEach(function (s) { A.run(s); });
            A.run("INSERT OR IGNORE INTO meta(k, v) VALUES ('schema', '1')");
            A.run("INSERT OR IGNORE INTO meta(k, v) VALUES ('created', ?)", [String(Date.now())]);
            return S.info();
        },
        info: function () {
            var pc = N(one('PRAGMA page_count')[0]), ps = N(one('PRAGMA page_size')[0]), fl = N(one('PRAGMA freelist_count')[0]);
            return { version: String(one('SELECT sqlite_version()')[0]), bytes: pc * ps, freeBytes: fl * ps, pageSize: ps };
        },
        getTags: function () { return rows('SELECT id, name, device, unit, descr, created FROM tags ORDER BY id').map(tagRow); },
        putTags: function (list) {
            var st = A.prep('INSERT INTO tags (name, device, unit, descr, created) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET ' +
                'device = coalesce(excluded.device, tags.device), unit = coalesce(excluded.unit, tags.unit), descr = coalesce(excluded.descr, tags.descr)');
            try {
                tx(function () {
                    for (var i = 0; i < list.length; i++) {
                        var x = list[i];
                        st.run([String(x.name), x.device == null ? null : String(x.device), x.unit == null ? null : String(x.unit),
                            x.descr == null ? null : String(x.descr), x.created == null ? Date.now() : Number(x.created)]);
                    }
                });
            } finally { st.free(); }
            return S.getTags();
        },
        putSamples: function (ids, ts, vs, qs, mode) {
            var ins = A.prep('INSERT OR IGNORE INTO samples (tag_id, t, v, q) VALUES (?, ?, ?, ?)');
            var upd = mode === 'replace' ? A.prep('UPDATE samples SET v = ?, q = ? WHERE tag_id = ? AND t = ?') : null;
            var r = { inserted: 0, updated: 0, skipped: 0, byTag: {} };
            try {
                tx(function () {
                    for (var i = 0; i < ids.length; i++) {
                        var v = (vs[i] === null || vs[i] === undefined) ? null : Number(vs[i]);
                        if (ins.run([ids[i], ts[i], v, qs[i]])) { r.inserted++; r.byTag[ids[i]] = (r.byTag[ids[i]] || 0) + 1; }
                        else if (upd) { upd.run([v, qs[i], ids[i], ts[i]]); r.updated++; }
                        else r.skipped++;
                    }
                });
            } finally { ins.free(); if (upd) upd.free(); }
            return r;
        },
        getSamples: function (id, from, to, limit, desc) {
            var sql = 'SELECT t, v, q FROM samples WHERE tag_id = ? AND t >= ? AND t <= ? ORDER BY t ' + (desc ? 'DESC' : 'ASC') +
                (limit > 0 ? ' LIMIT ' + Math.floor(limit) : '');
            var rs = rows(sql, [id, from, to]), o = { t: new Array(rs.length), v: new Array(rs.length), q: new Array(rs.length) };
            for (var i = 0; i < rs.length; i++) { o.t[i] = N(rs[i][0]); o.v[i] = N(rs[i][1]); o.q[i] = N(rs[i][2]); }
            return o;
        },
        countSamples: function (id, from, to) { return N(one('SELECT count(*) FROM samples WHERE tag_id = ? AND t >= ? AND t <= ?', [id, from, to])[0]); },
        deleteSamples: function (id, from, to) { return A.run('DELETE FROM samples WHERE tag_id = ? AND t >= ? AND t <= ?', [id, from, to]); },
        aggSamples: function (id, from, to, b) {
            return rows(AGG, [Math.max(1, Math.round(b)), id, from, to]).map(function (r) {
                var ng = N(r[2]), ns = N(r[8]);
                if (ng > 0) return part(r[0], ng, r[3], r[4], r[5], r[7], r[6], 0, r[1]);
                if (ns > 0) return part(r[0], ns, r[9], r[10], r[11], r[13], r[12], 1, r[1]);
                return part(r[0], 0, null, null, null, null, null, 2, r[1]);
            });
        },
        statsAll: function () {
            var o = {};
            rows('SELECT tag_id, count(*), min(t), max(t) FROM samples GROUP BY tag_id').forEach(function (r) { o[N(r[0])] = { n: N(r[1]), first: N(r[2]), last: N(r[3]), rn: 0, rfirst: null, rlast: null }; });
            rows('SELECT tag_id, count(*), min(t), max(t) FROM rollups GROUP BY tag_id').forEach(function (r) {
                var x = o[N(r[0])] || (o[N(r[0])] = { n: 0, first: null, last: null });
                x.rn = N(r[1]); x.rfirst = N(r[2]); x.rlast = N(r[3]);
            });
            rows('SELECT s.tag_id, s.t, s.v, s.q FROM samples s JOIN (SELECT tag_id, max(t) AS mt FROM samples GROUP BY tag_id) m ON s.tag_id = m.tag_id AND s.t = m.mt')
                .forEach(function (r) { var x = o[N(r[0])]; if (x) { x.lastV = N(r[2]); x.lastQ = N(r[3]); } });
            return o;
        },
        putRollups: function (id, parts) { tx(function () { putR(id, parts); }); return parts.length; },
        // Rollups in, the raw rows they replace out — one transaction, so a snapshot or a crash
        // never sees both (which would count those samples twice) or neither.
        rollupWrite: function (id, parts, cut) {
            return tx(function () { putR(id, parts); return A.run('DELETE FROM samples WHERE tag_id = ? AND t >= 0 AND t <= ?', [id, cut - 1]); });
        },
        getRollups: function (id, from, to) {
            return rows('SELECT t, dt, n, avg, min, max, last, lt, q, nall FROM rollups WHERE tag_id = ? AND t >= ? AND t <= ? ORDER BY t', [id, from, to]).map(rollRow);
        },
        countRollups: function (id, from, to) { return N(one('SELECT count(*) FROM rollups WHERE tag_id = ? AND t >= ? AND t <= ?', [id, from, to])[0]); },
        deleteRollups: function (id, from, to) { return A.run('DELETE FROM rollups WHERE tag_id = ? AND t >= ? AND t <= ?', [id, from, to]); },
        totals: function () {
            return { samples: N(one('SELECT count(*) FROM samples')[0]), rollups: N(one('SELECT count(*) FROM rollups')[0]), tags: N(one('SELECT count(*) FROM tags')[0]) };
        },
        clear: function () {
            tx(function () { A.run('DELETE FROM samples'); A.run('DELETE FROM rollups'); A.run('DELETE FROM tags'); });
            S.vacuum();
            return true;
        },
        vacuum: function () { try { A.all('PRAGMA incremental_vacuum', []); } catch (e) { /* not in auto-vacuum mode */ } return true; },
        exportBytes: function () { return A.exportBytes(); },
        close: function () { A.close(); return true; }
    };
    return S;
}

// sql.js adapter (main thread).
function histSqlJsAdapter(db) {
    function bindArgs(p) { return p && p.length ? p : undefined; }
    return {
        all: function (sql, p) {
            var st = db.prepare(sql), out = [];
            try { if (p && p.length) st.bind(p); while (st.step()) out.push(st.get()); } finally { st.free(); }
            return out;
        },
        run: function (sql, p) { db.run(sql, bindArgs(p)); return db.getRowsModified(); },
        prep: function (sql) {
            var st = db.prepare(sql);
            return { run: function (p) { st.run(p); return db.getRowsModified(); }, free: function () { st.free(); } };
        },
        exportBytes: function () { return db.export(); },
        close: function () { db.close(); }
    };
}
// Official SQLite WASM (oo1 API) adapter — runs inside the storage Worker. Self-contained.
function histWasmAdapter(sqlite3, db) {
    function bind(p) { return (p && p.length) ? p : undefined; }
    return {
        all: function (sql, p) { return db.exec({ sql: sql, bind: bind(p), rowMode: 'array', returnValue: 'resultRows' }); },
        run: function (sql, p) { db.exec({ sql: sql, bind: bind(p) }); return db.changes(); },
        prep: function (sql) {
            var st = db.prepare(sql);
            return { run: function (p) { st.bind(p); st.stepReset(); return db.changes(); }, free: function () { st.finalize(); } };
        },
        exportBytes: function () { return sqlite3.capi.sqlite3_js_db_export(db); },
        close: function () { db.close(); }
    };
}

// Wrap a synchronous store so every method returns a Promise.
function asyncStore(sync, kind, extra) {
    var o = { kind: kind };
    Object.keys(sync).forEach(function (k) {
        if (typeof sync[k] !== 'function') return;
        o[k] = function () { try { return Promise.resolve(sync[k].apply(sync, arguments)); } catch (e) { return Promise.reject(e); } };
    });
    if (extra) Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
    return o;
}

// Partial ↔ compact array (IndexedDB / memory values).
function rollToArr(p) { return [p.t, p.dt || ROLLUP_MS, p.n, p.avg, p.min, p.max, p.last, p.lt, p.q, p.nall == null ? p.n : p.nall]; }
function arrToRoll(a) { return { t: a[0], dt: a[1], n: a[2], avg: a[3], min: a[4], max: a[5], last: a[6], lt: a[7], q: a[8], nall: a[9] }; }

// IndexedDB store: object stores meta / tags (keyPath id, unique index name) /
// samples (key [tag_id, t] → [t, v, q]) / rollups (key [tag_id, t] → rollup array).
function idbReq(r) {
    return new Promise(function (res, rej) {
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error || new Error('IndexedDB request failed')); };
    });
}
function idbDone(tx) {
    return new Promise(function (res, rej) {
        tx.oncomplete = function () { res(); };
        tx.onabort = function () { rej(tx.error || new Error('IndexedDB transaction aborted')); };
    });
}
function idbOpen(idb, name, upgrade) {
    return new Promise(function (res, rej) {
        var r;
        try { r = idb.open(name, 1); } catch (e) { rej(e); return; }
        r.onupgradeneeded = function () { try { upgrade(r.result); } catch (e) { rej(e); } };
        r.onsuccess = function () { var d = r.result; d.onversionchange = function () { try { d.close(); } catch (e) {} }; res(d); };
        r.onerror = function () { rej(r.error || new Error('IndexedDB open failed')); };
    });
}
function IdbStore(idb, KR) {
    var db = null;
    function has(d, n) { return d.objectStoreNames && (typeof d.objectStoreNames.contains === 'function' ? d.objectStoreNames.contains(n) : Array.prototype.indexOf.call(d.objectStoreNames, n) >= 0); }
    function rng(id, from, to) { return KR.bound([id, from], [id, to]); }
    function ro(names) { return db.transaction(names, 'readonly'); }
    function rw(names) { return db.transaction(names, 'readwrite'); }
    function readChunks(store, id, from, to, onChunk) {
        var lo = from;
        function step() {
            if (lo > to) return Promise.resolve();
            return idbReq(ro(store).objectStore(store).getAll(rng(id, lo, to), CHUNK)).then(function (arr) {
                if (!arr.length) return;
                onChunk(arr);
                if (arr.length < CHUNK) return;
                lo = arr[arr.length - 1][0] + 1;
                return step();
            });
        }
        return step();
    }
    function countIn(store, id, from, to) { return idbReq(ro(store).objectStore(store).count(rng(id, from, to))); }
    function deleteIn(store, id, from, to) {
        var tx = rw(store), st = tx.objectStore(store), r = rng(id, from, to), n = 0;
        idbReq(st.count(r)).then(function (c) { n = c; });
        st.delete(r);
        return idbDone(tx).then(function () { return n; });
    }
    var S = {
        kind: 'idb',
        init: function () {
            return idbOpen(idb, IDB_NAME, function (d) {
                if (!has(d, 'meta')) d.createObjectStore('meta');
                if (!has(d, 'tags')) d.createObjectStore('tags', { keyPath: 'id' }).createIndex('name', 'name', { unique: true });
                if (!has(d, 'samples')) d.createObjectStore('samples');
                if (!has(d, 'rollups')) d.createObjectStore('rollups');
            }).then(function (d) { db = d; return S.info(); });
        },
        info: function () { return Promise.resolve({ version: 'IndexedDB', bytes: null }); },
        getTags: function () {
            return idbReq(ro('tags').objectStore('tags').getAll()).then(function (a) { return a.slice().sort(function (x, y) { return x.id - y.id; }); });
        },
        putTags: function (list) {
            return S.getTags().then(function (cur) {
                var byName = {}, maxId = 0;
                cur.forEach(function (t) { byName[t.name] = t; if (t.id > maxId) maxId = t.id; });
                var tx = rw('tags'), st = tx.objectStore('tags');
                list.forEach(function (x) {
                    var name = String(x.name), old = byName[name];
                    var rec = old ? { id: old.id, name: name, device: x.device != null ? String(x.device) : old.device, unit: x.unit != null ? String(x.unit) : old.unit,
                        descr: x.descr != null ? String(x.descr) : old.descr, created: old.created }
                        : { id: ++maxId, name: name, device: x.device != null ? String(x.device) : null, unit: x.unit != null ? String(x.unit) : null,
                            descr: x.descr != null ? String(x.descr) : null, created: x.created != null ? +x.created : Date.now() };
                    byName[name] = rec;
                    st.put(rec);
                });
                return idbDone(tx);
            }).then(S.getTags);
        },
        putSamples: function (ids, ts, vs, qs, mode) {
            var r = { inserted: 0, updated: 0, skipped: 0, byTag: {} };
            if (!ids.length) return Promise.resolve(r);
            var tx = rw('samples'), st = tx.objectStore('samples');
            ids.forEach(function (id, i) {
                var key = [id, ts[i]], val = [ts[i], (vs[i] === undefined ? null : vs[i]), qs[i]];
                var q = st.add(val, key);
                q.onsuccess = function () { r.inserted++; r.byTag[id] = (r.byTag[id] || 0) + 1; };
                q.onerror = function (ev) {
                    // Existing (tag, t): keep the transaction alive and skip or overwrite.
                    // Any other error (quota, bad key) is left to abort the transaction.
                    if (!q.error || q.error.name !== 'ConstraintError') return;
                    if (ev && ev.preventDefault) ev.preventDefault();
                    if (ev && ev.stopPropagation) ev.stopPropagation();
                    if (mode === 'replace') st.put(val, key).onsuccess = function () { r.updated++; };
                    else r.skipped++;
                };
            });
            return idbDone(tx).then(function () { return r; });
        },
        getSamples: function (id, from, to, limit, desc) {
            var o = { t: [], v: [], q: [] };
            var push = function (a) { o.t.push(a[0]); o.v.push(a[1]); o.q.push(a[2]); };
            if (!desc && !(limit > 0)) return readChunks('samples', id, from, to, function (arr) { arr.forEach(push); }).then(function () { return o; });
            if (!desc) return idbReq(ro('samples').objectStore('samples').getAll(rng(id, from, to), limit)).then(function (arr) { arr.forEach(push); return o; });
            return new Promise(function (res, rej) {
                var c = ro('samples').objectStore('samples').openCursor(rng(id, from, to), 'prev');
                c.onsuccess = function () {
                    var cur = c.result;
                    if (!cur || (limit > 0 && o.t.length >= limit)) { res(o); return; }
                    push(cur.value); cur.continue();
                };
                c.onerror = function () { rej(c.error); };
            });
        },
        countSamples: function (id, from, to) { return countIn('samples', id, from, to); },
        deleteSamples: function (id, from, to) { return deleteIn('samples', id, from, to); },
        aggSamples: function (id, from, to, b) {
            var a = new Agg(Math.max(1, Math.round(b)));
            return readChunks('samples', id, from, to, function (arr) { for (var i = 0; i < arr.length; i++) a.push(arr[i][0], arr[i][1], arr[i][2]); })
                .then(function () { return a.result(); });
        },
        statsAll: function () {
            return S.getTags().then(function (tags) {
                var o = {};
                return tags.reduce(function (p, tg) {
                    return p.then(function () {
                        var x = o[tg.id] = { n: 0, first: null, last: null, rn: 0, rfirst: null, rlast: null };
                        var tx = ro(['samples', 'rollups']), s = tx.objectStore('samples'), rr = tx.objectStore('rollups'), all = rng(tg.id, 0, MAXT);
                        idbReq(s.count(all)).then(function (n) { x.n = n; });
                        idbReq(s.getAll(all, 1)).then(function (a) { if (a.length) x.first = a[0][0]; });
                        var c = s.openCursor(all, 'prev');
                        c.onsuccess = function () { if (c.result) { x.last = c.result.value[0]; x.lastV = c.result.value[1]; x.lastQ = c.result.value[2]; } };
                        idbReq(rr.count(all)).then(function (n) { x.rn = n; });
                        idbReq(rr.getAll(all, 1)).then(function (a) { if (a.length) x.rfirst = a[0][0]; });
                        var c2 = rr.openCursor(all, 'prev');
                        c2.onsuccess = function () { if (c2.result) x.rlast = c2.result.value[0]; };
                        return idbDone(tx);
                    });
                }, Promise.resolve()).then(function () { return o; });
            });
        },
        putRollups: function (id, parts) {
            if (!parts.length) return Promise.resolve(0);
            var tx = rw('rollups'), st = tx.objectStore('rollups');
            parts.forEach(function (p) { st.put(rollToArr(p), [id, p.t]); });
            return idbDone(tx).then(function () { return parts.length; });
        },
        rollupWrite: function (id, parts, cut) {                       // one transaction: rollups in, raw rows out
            var tx = rw(['samples', 'rollups']), rs = tx.objectStore('rollups'), ss = tx.objectStore('samples'), r = rng(id, 0, cut - 1), n = 0;
            parts.forEach(function (p) { rs.put(rollToArr(p), [id, p.t]); });
            idbReq(ss.count(r)).then(function (c) { n = c; });
            ss.delete(r);
            return idbDone(tx).then(function () { return n; });
        },
        getRollups: function (id, from, to) {
            var out = [];
            return readChunks('rollups', id, from, to, function (arr) { arr.forEach(function (a) { out.push(arrToRoll(a)); }); }).then(function () { return out; });
        },
        countRollups: function (id, from, to) { return countIn('rollups', id, from, to); },
        deleteRollups: function (id, from, to) { return deleteIn('rollups', id, from, to); },
        totals: function () {
            var tx = ro(['samples', 'rollups', 'tags']), o = {};
            idbReq(tx.objectStore('samples').count()).then(function (n) { o.samples = n; });
            idbReq(tx.objectStore('rollups').count()).then(function (n) { o.rollups = n; });
            idbReq(tx.objectStore('tags').count()).then(function (n) { o.tags = n; });
            return idbDone(tx).then(function () { return o; });
        },
        clear: function () {
            var tx = rw(['samples', 'rollups', 'tags']);
            tx.objectStore('samples').clear(); tx.objectStore('rollups').clear(); tx.objectStore('tags').clear();
            return idbDone(tx).then(function () { return true; });
        },
        vacuum: function () { return Promise.resolve(true); },
        close: function () { try { if (db) db.close(); } catch (e) {} db = null; return Promise.resolve(true); }
    };
    return S;
}

// Volatile store (no IndexedDB, or explicitly chosen). Sorted parallel arrays per tag.
function MemStore() {
    var tags = [], S = {}, R = {};
    function lb(a, x) { var lo = 0, hi = a.length; while (lo < hi) { var m = (lo + hi) >>> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; }
    function ub(a, x) { var lo = 0, hi = a.length; while (lo < hi) { var m = (lo + hi) >>> 1; if (a[m] <= x) lo = m + 1; else hi = m; } return lo; }
    function ser(map, id) { return map[id] || (map[id] = { t: [], x: [] }); }
    function span(map, id, from, to) { var s = map[id]; if (!s) return [0, 0, null]; return [lb(s.t, from), ub(s.t, to), s]; }
    function del(map, id, from, to) { var p = span(map, id, from, to); if (!p[2] || p[1] <= p[0]) return 0; p[2].t.splice(p[0], p[1] - p[0]); p[2].x.splice(p[0], p[1] - p[0]); return p[1] - p[0]; }
    var M = {
        kind: 'memory',
        init: function () { return M.info(); },
        info: function () { return { version: 'memory', bytes: null }; },
        getTags: function () { return tags.map(function (t) { return Object.assign({}, t); }); },
        putTags: function (list) {
            list.forEach(function (x) {
                var name = String(x.name), old = null;
                for (var i = 0; i < tags.length; i++) if (tags[i].name === name) old = tags[i];
                if (old) {
                    if (x.device != null) old.device = String(x.device);
                    if (x.unit != null) old.unit = String(x.unit);
                    if (x.descr != null) old.descr = String(x.descr);
                } else tags.push({ id: tags.length ? tags[tags.length - 1].id + 1 : 1, name: name, device: x.device != null ? String(x.device) : null,
                    unit: x.unit != null ? String(x.unit) : null, descr: x.descr != null ? String(x.descr) : null, created: x.created != null ? +x.created : Date.now() });
            });
            return M.getTags();
        },
        putSamples: function (ids, ts, vs, qs, mode) {
            var r = { inserted: 0, updated: 0, skipped: 0, byTag: {} };
            for (var i = 0; i < ids.length; i++) {
                var s = ser(S, ids[i]), t = ts[i], val = [(vs[i] === undefined ? null : vs[i]), qs[i]], n = s.t.length;
                if (!n || s.t[n - 1] < t) { s.t.push(t); s.x.push(val); }
                else {
                    var k = lb(s.t, t);
                    if (s.t[k] === t) { if (mode === 'replace') { s.x[k] = val; r.updated++; } else r.skipped++; continue; }
                    s.t.splice(k, 0, t); s.x.splice(k, 0, val);
                }
                r.inserted++; r.byTag[ids[i]] = (r.byTag[ids[i]] || 0) + 1;
            }
            return r;
        },
        getSamples: function (id, from, to, limit, desc) {
            var p = span(S, id, from, to), o = { t: [], v: [], q: [] };
            if (!p[2]) return o;
            var a = p[0], b = p[1];
            if (limit > 0 && b - a > limit) { if (desc) a = b - limit; else b = a + limit; }
            for (var i = a; i < b; i++) { o.t.push(p[2].t[i]); o.v.push(p[2].x[i][0]); o.q.push(p[2].x[i][1]); }
            if (desc) { o.t.reverse(); o.v.reverse(); o.q.reverse(); }
            return o;
        },
        countSamples: function (id, from, to) { var p = span(S, id, from, to); return Math.max(0, p[1] - p[0]); },
        deleteSamples: function (id, from, to) { return del(S, id, from, to); },
        aggSamples: function (id, from, to, b) {
            var p = span(S, id, from, to), a = new Agg(Math.max(1, Math.round(b)));
            if (p[2]) for (var i = p[0]; i < p[1]; i++) a.push(p[2].t[i], p[2].x[i][0], p[2].x[i][1]);
            return a.result();
        },
        statsAll: function () {
            var o = {};
            tags.forEach(function (tg) {
                var s = S[tg.id], r = R[tg.id], x = o[tg.id] = { n: 0, first: null, last: null, rn: 0, rfirst: null, rlast: null };
                if (s && s.t.length) { x.n = s.t.length; x.first = s.t[0]; x.last = s.t[s.t.length - 1]; x.lastV = s.x[s.x.length - 1][0]; x.lastQ = s.x[s.x.length - 1][1]; }
                if (r && r.t.length) { x.rn = r.t.length; x.rfirst = r.t[0]; x.rlast = r.t[r.t.length - 1]; }
            });
            return o;
        },
        putRollups: function (id, parts) {
            var s = ser(R, id);
            parts.forEach(function (p) {
                var k = lb(s.t, p.t), a = rollToArr(p);
                if (s.t[k] === p.t) s.x[k] = a; else { s.t.splice(k, 0, p.t); s.x.splice(k, 0, a); }
            });
            return parts.length;
        },
        rollupWrite: function (id, parts, cut) { M.putRollups(id, parts); return del(S, id, 0, cut - 1); },
        getRollups: function (id, from, to) {
            var p = span(R, id, from, to), out = [];
            if (p[2]) for (var i = p[0]; i < p[1]; i++) out.push(arrToRoll(p[2].x[i]));
            return out;
        },
        countRollups: function (id, from, to) { var p = span(R, id, from, to); return Math.max(0, p[1] - p[0]); },
        deleteRollups: function (id, from, to) { return del(R, id, from, to); },
        totals: function () {
            var n = 0, nr = 0, k;
            for (k in S) n += S[k].t.length;
            for (k in R) nr += R[k].t.length;
            return { samples: n, rollups: nr, tags: tags.length };
        },
        clear: function () { tags = []; S = {}; R = {}; return true; },
        vacuum: function () { return true; },
        close: function () { return true; }
    };
    return M;
}

// ─── §5 storage Worker (official SQLite WASM on OPFS) ────────────────
// Runs inside a classic Worker built from a Blob. The verified sqlite3.mjs text is
// evaluated with Function after two exact rewrites (checked, else the load fails):
// every `import.meta.url` → a base URL argument, and the final `export {…}` → return.
// That keeps the SHA-384-checked bytes as the code that runs, and avoids module
// Workers and blob-URL module imports (not reliable in every WebView).
function histWorkerMain(S) {
    var store = null, sqlite3 = null, db = null, meta = null;
    var EXPORT = 'export { sqlite3InitModule as default, sqlite3Worker1Promiser$1 as sqlite3Worker1Promiser };';
    function probe() {
        var nav = S.navigator, FH = S.FileSystemFileHandle;
        var ok = !!(nav && nav.storage && typeof nav.storage.getDirectory === 'function' && FH && FH.prototype &&
            typeof FH.prototype.createSyncAccessHandle === 'function');
        return { opfs: ok };
    }
    function factoryFrom(js, base) {
        if (js.split('import.meta.url').length - 1 !== 4 || js.lastIndexOf(EXPORT) < 0) throw new Error('unexpected sqlite3.mjs layout (version mismatch)');
        var body = js.split('import.meta.url').join('__wtsBase').replace(EXPORT, 'return sqlite3InitModule;');
        return (new Function('__wtsBase', '"use strict";\n' + body))(base);
    }
    function open(m) {
        var quiet = function () {};
        S.sqlite3ApiConfig = { debug: quiet, log: quiet, warn: quiet, error: function () { try { console.error.apply(console, arguments); } catch (e) {} },
            disable: { vfs: { opfs: true, 'opfs-vfs': true, 'opfs-wl': true, kvvfs: true } } };
        var init = factoryFrom(m.js, m.base);
        return init({ wasmBinary: new Uint8Array(m.wasm), locateFile: function (p) { return p; }, print: quiet, printErr: quiet }).then(function (s3) {
            sqlite3 = s3;
            if (m.mode === 'memory') { db = new sqlite3.oo1.DB(':memory:', 'c'); return 'memory'; }
            return sqlite3.installOpfsSAHPoolVfs({ name: m.vfs, directory: m.dir, initialCapacity: 6 }).then(function (pool) {
                db = new pool.OpfsSAHPoolDb(m.file);
                return 'opfs-sahpool';
            });
        }).then(function (vfs) {
            store = HistSqlStore(histWasmAdapter(sqlite3, db));
            var info = store.init();
            meta = { version: sqlite3.version.libVersion, vfs: vfs, info: info };
            return meta;
        });
    }
    S.onmessage = function (ev) {
        var m = (ev && ev.data) || {}, p;
        try {
            if (m.op === 'probe') p = probe();
            else if (m.op === 'open') p = open(m);
            else if (m.op === 'call') {
                if (!store || typeof store[m.method] !== 'function') throw new Error('storage worker: no method ' + m.method);
                p = store[m.method].apply(store, m.args || []);
            } else if (m.op === 'close') { if (db) db.close(); db = null; store = null; p = true; }
            else throw new Error('storage worker: bad op ' + m.op);
        } catch (e) { p = Promise.reject(e); }
        Promise.resolve(p).then(function (r) {
            var tr = [];
            if (r && typeof r.byteLength === 'number' && r.buffer && r.byteLength === r.buffer.byteLength) tr.push(r.buffer);   // exported file (a copy)
            S.postMessage({ id: m.id, ok: true, result: r }, tr);
        }, function (e) { S.postMessage({ id: m.id, ok: false, error: String((e && e.message) || e) }); });
    };
}
function workerSource() {
    return '"use strict";\n/* H2Oil Well Testing Suite — historian storage worker */\n' +
        'var HistSqlStore = ' + HistSqlStore.toString() + ';\n' +
        'var histWasmAdapter = ' + histWasmAdapter.toString() + ';\n' +
        '(' + histWorkerMain.toString() + ')(self);\n';
}
var STORE_METHODS = ['info', 'getTags', 'putTags', 'putSamples', 'getSamples', 'countSamples', 'deleteSamples', 'aggSamples', 'statsAll',
    'putRollups', 'rollupWrite', 'getRollups', 'countRollups', 'deleteRollups', 'totals', 'clear', 'vacuum', 'exportBytes'];
// Main-thread proxy: one Promise per request, matched by id.
function WorkerStore(w) {
    var seq = 0, pend = {}, dead = null;
    function failAll(e) { dead = e; Object.keys(pend).forEach(function (k) { var p = pend[k]; delete pend[k]; if (p.timer) clearTimeout(p.timer); p.rej(e); }); }
    w.onmessage = function (ev) {
        var m = ev && ev.data, p = m && pend[m.id];
        if (!p) return;
        delete pend[m.id];
        if (p.timer) clearTimeout(p.timer);
        if (m.ok) p.res(m.result); else p.rej(new Error(m.error));
    };
    w.onerror = function (e) { if (e && e.preventDefault) e.preventDefault(); failAll(new Error('storage worker error: ' + ((e && e.message) || 'unknown'))); };
    function send(msg, transfer, timeoutMs) {
        if (dead) return Promise.reject(dead);
        return new Promise(function (res, rej) {
            msg.id = ++seq;
            var p = pend[msg.id] = { res: res, rej: rej, timer: null };
            if (timeoutMs) p.timer = setTimeout(function () { if (pend[msg.id]) { delete pend[msg.id]; rej(new Error('storage worker did not answer "' + msg.op + '" in ' + (timeoutMs / 1000) + ' s')); } }, timeoutMs);
            try { w.postMessage(msg, transfer || []); } catch (e) { delete pend[msg.id]; if (p.timer) clearTimeout(p.timer); rej(e); }
        });
    }
    var api = { kind: 'opfs', _send: send, isDead: function () { return !!dead; },
        terminate: function () { failAll(new Error('storage worker closed')); try { w.terminate(); } catch (e) {} } };
    STORE_METHODS.forEach(function (name) {
        api[name] = function () { return send({ op: 'call', method: name, args: Array.prototype.slice.call(arguments) }); };
    });
    api.close = function () { return send({ op: 'close' }).then(function () { api.terminate(); return true; }, function () { api.terminate(); return true; }); };
    return api;
}

// ─── §6 library loader (lazy, integrity-checked) ─────────────────────
function noop() {}
function isNativeShell() {
    try {
        if (G.location && G.location.protocol === 'capacitor:') return true;
        var C = G.Capacitor;
        return !!(C && typeof C.isNativePlatform === 'function' && C.isNativePlatform());
    } catch (e) { return false; }
}
function absUrl(u) { try { return new URL(u, G.location && G.location.href).href; } catch (e) { return u; } }
function asBuf(x) {
    if (x && typeof x.byteLength === 'number' && x.buffer && typeof x.byteOffset === 'number') return x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength);
    return x;
}
function toU8(x) { return (x && x.buffer && typeof x.byteOffset === 'number') ? new Uint8Array(x.buffer, x.byteOffset, x.byteLength) : new Uint8Array(x); }
function utf8(buf) { return new TextDecoder('utf-8').decode(toU8(buf)); }
function b64(ab) {
    var b = new Uint8Array(ab), s = '', CH = 0x8000;
    for (var i = 0; i < b.length; i += CH) s += String.fromCharCode.apply(null, b.subarray(i, i + CH));
    return G.btoa(s);
}
function fetchBytes(url) {
    if (typeof T.fetchBytes === 'function') return Promise.resolve().then(function () { return T.fetchBytes(url); });
    if (typeof G.fetch !== 'function') return Promise.reject(new Error('fetch is not available'));
    var ac = typeof G.AbortController === 'function' ? new G.AbortController() : null;
    var timer = setTimeout(function () { if (ac) ac.abort(); }, 30000);
    var cross = /^https?:/i.test(url) && (!G.location || url.indexOf(G.location.origin + '/') !== 0);
    var init = cross ? { mode: 'cors', credentials: 'omit' } : { credentials: 'same-origin' };
    if (ac) init.signal = ac.signal;
    return G.fetch(url, init).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
        .then(function (b) { clearTimeout(timer); return b; }, function (e) { clearTimeout(timer); throw e; });
}
// Sources in order: a local copy (iOS app bundle, or window.WTS_HIST_LIB_BASE for a self-hosted
// intranet copy), then the pinned CDN URLs. CDN bytes are used only after their SHA-384 matches;
// without WebCrypto (plain http) only the local copy is accepted, unverified — like the 3D loader.
function libSources(name) {
    var src = [], base = G.WTS_HIST_LIB_BASE != null ? String(G.WTS_HIST_LIB_BASE) : (isNativeShell() ? '' : null);
    if (base !== null) src.push({ url: absUrl(base + name), local: true });
    LIBS[name].urls.forEach(function (u) { src.push({ url: u, local: false }); });
    return src;
}
function fetchVerified(name) {
    var want = HIST_SHA384[name], subtle = (G.crypto && G.crypto.subtle && typeof G.crypto.subtle.digest === 'function') ? G.crypto.subtle : null;
    var srcs = libSources(name), tried = [], i = 0;
    function next() {
        if (i >= srcs.length) {
            var e = new Error(name + ' could not be loaded — ' + tried.join('; '));
            e.code = tried.some(function (x) { return /SHA-384/.test(x); }) ? 'integrity' : 'offline';
            return Promise.reject(e);
        }
        var s = srcs[i++];
        if (!s.local && !subtle) { tried.push(s.url + ' (skipped: no WebCrypto to check its SHA-384)'); return next(); }
        return fetchBytes(s.url).then(function (buf) {
            buf = asBuf(buf);
            if (!subtle) return { buf: buf, url: s.url, verified: false, local: true };
            return subtle.digest('SHA-384', buf).then(function (d) {
                if (b64(d) !== want) { tried.push(s.url + ' (SHA-384 mismatch — not used)'); return next(); }
                return { buf: buf, url: s.url, verified: true, local: s.local };
            });
        }, function (e) { tried.push(s.url + ' (' + errMsg(e) + ')'); return next(); });
    }
    return next();
}
var _sqljsP = null;
function loadSqlJs() {
    if (_sqljsP) return _sqljsP;
    _sqljsP = Promise.all([fetchVerified('sql-wasm.js'), fetchVerified('sql-wasm.wasm')]).then(function (r) {
        var init = (new Function(utf8(r[0].buf) + '\n;return initSqlJs;'))();
        return init({ wasmBinary: new Uint8Array(r[1].buf), locateFile: function (p) { return p; } }).then(function (SQL) {
            var d = new SQL.Database(), ver = String(d.exec('SELECT sqlite_version()')[0].values[0][0]);
            d.close();
            E.lib.sqljs = { name: 'sql.js 1.14.2', version: ver, url: r[0].url, verified: !!(r[0].verified && r[1].verified) };
            return SQL;
        });
    });
    _sqljsP.catch(function () { _sqljsP = null; });
    return _sqljsP;
}

// ─── §7 engine ───────────────────────────────────────────────────────
var E = {
    store: null, engine: null, home: null, spoolFor: null, reasons: [], notes: [], initP: null, info: null, lib: {},
    chain: Promise.resolve(), buf: [], timer: null, timerMs: -1,
    byName: {}, byId: {}, stat: {}, live: {}, tot: { samples: 0, rollups: 0, tags: 0 },
    lastFlush: 0, lastFlushMs: 0, flushes: 0, written: 0, dropped: 0, rejected: 0, errors: 0, lastError: '',
    lastRetention: 0, lastRetentionResult: null, dirty: false, persistTimer: null, lastPersist: 0
};
function lock(fn) { var p = E.chain.then(fn, fn); E.chain = p.then(noop, noop); return p; }
function perfNow() { try { return G.performance && G.performance.now ? G.performance.now() : Date.now(); } catch (e) { return Date.now(); } }
function isSqlEngine() { return E.engine === 'opfs' || E.engine === 'sqljs'; }
function floorTo(t, b) { return t - (((t % b) + b) % b); }
function firstDef() { for (var i = 0; i < arguments.length; i++) if (arguments[i] !== undefined && arguments[i] !== null) return arguments[i]; return null; }

function getSettings() {
    var s = lsJSON(LS_SETTINGS) || {};
    var ci = function (x, d, lo, hi) { x = Math.round(numOr(x, d)); return Math.min(hi, Math.max(lo, x)); };
    return {
        days: ci(s.days, DEFAULTS.days, 0, 36500), maxRows: ci(s.maxRows, DEFAULTS.maxRows, 0, 1e10),
        downsampleAfterDays: ci(s.downsampleAfterDays, DEFAULTS.downsampleAfterDays, 0, 36500),
        engine: ENGINES.indexOf(s.engine) >= 0 ? s.engine : 'auto'
    };
}
function saveSettings(s) { lsSet(LS_SETTINGS, JSON.stringify({ days: s.days, maxRows: s.maxRows, downsampleAfterDays: s.downsampleAfterDays, engine: s.engine })); }
function effCap(engine) {
    var s = getSettings(), c = ENGINE_CAPS[engine || E.engine] || 0, u = s.maxRows || 0;
    if (!c) return u || Infinity;
    return u ? Math.min(c, u) : c;
}
function hasStore(d, n) { return !!d.objectStoreNames && (typeof d.objectStoreNames.contains === 'function' ? d.objectStoreNames.contains(n) : Array.prototype.indexOf.call(d.objectStoreNames, n) >= 0); }

// Engine openers — each resolves to an initialised async store.
function openOpfs() {
    if (typeof G.Worker !== 'function') return Promise.reject(new Error('Web Workers are not available'));
    if (!G.Blob || !G.URL || typeof G.URL.createObjectURL !== 'function') return Promise.reject(new Error('Blob URLs are not available'));
    var w;
    try { w = new G.Worker(G.URL.createObjectURL(new G.Blob([workerSource()], { type: 'text/javascript' }))); }
    catch (e) { return Promise.reject(new Error('the storage worker could not start (' + errMsg(e) + ')')); }
    var ws = WorkerStore(w);
    return ws._send({ op: 'probe' }, null, 10000).then(function (pr) {
        if (!(pr && pr.opfs) && !T.workerMemory) throw new Error('OPFS sync access handles are not available in workers');
        return Promise.all([fetchVerified('sqlite3.mjs'), fetchVerified('sqlite3.wasm')]);
    }).then(function (r) {
        var base = /^https?:|^capacitor:/i.test(r[0].url) ? r[0].url : absUrl('sqlite3.mjs');
        return ws._send({ op: 'open', js: utf8(r[0].buf), wasm: r[1].buf, base: base, mode: T.workerMemory ? 'memory' : 'opfs',
            vfs: OPFS_VFS, dir: OPFS_DIR, file: OPFS_FILE }, [r[1].buf], 60000).then(function (m) {
            E.lib.sqlite = { name: 'SQLite WASM (official build) 3.53.4', version: m.version, vfs: m.vfs, url: r[0].url, verified: !!(r[0].verified && r[1].verified) };
            return ws;
        });
    }).catch(function (e) {
        ws.terminate();
        var m = errMsg(e);
        if (/NoModificationAllowed|locked|Access Handles cannot be created/i.test(m)) m = 'the SQLite files are in use by another tab of this app (' + m + ')';
        throw new Error(m);
    });
}
function openSqlJs() {
    var idb = G.indexedDB;
    if (!idb) return Promise.reject(new Error('IndexedDB is not available (needed to keep the SQLite file)'));
    var SQL, snapDb, release = null;
    return holdLock('wts-historian-sqljs').then(function (rel) {
        if (!rel) throw new Error('the SQLite file is open in another tab of this app');
        release = rel;
        return loadSqlJs();
    }).then(function (S) {
        SQL = S;
        return idbOpen(idb, SNAP_DB, function (d) { if (!hasStore(d, SNAP_STORE)) d.createObjectStore(SNAP_STORE); });
    }).then(function (d) {
        snapDb = d;
        return idbReq(snapDb.transaction(SNAP_STORE, 'readonly').objectStore(SNAP_STORE).get(SNAP_KEY));
    }).then(function (bytes) {
        var db = null;
        if (bytes) {
            try { db = new SQL.Database(toU8(bytes)); db.exec('SELECT count(*) FROM sqlite_master'); }
            catch (e) {
                // Keep the unreadable file aside (never silently discarded) and start a new one.
                try { if (db) db.close(); } catch (e2) {}
                db = null;
                try { var tx0 = snapDb.transaction(SNAP_STORE, 'readwrite'); tx0.objectStore(SNAP_STORE).put(bytes, SNAP_KEY + '.unreadable-' + Date.now()); } catch (e3) {}
                E.notes.push('The saved SQLite file could not be opened (' + errMsg(e) + '); it was kept aside and a new file started.');
            }
        }
        if (!db) db = new SQL.Database();
        var sync = HistSqlStore(histSqlJsAdapter(db));
        sync.init();
        return asyncStore(sync, 'sqljs', {
            persist: function () {
                var b = db.export(), tx = snapDb.transaction(SNAP_STORE, 'readwrite');
                tx.objectStore(SNAP_STORE).put(b, SNAP_KEY);
                return idbDone(tx);
            },
            close: function () { try { db.close(); } catch (e) {} try { snapDb.close(); } catch (e) {} if (release) release(); release = null; return Promise.resolve(true); }
        });
    }).catch(function (e) { if (release) release(); throw e; });
}
function openIdb() {
    if (!G.indexedDB || !G.IDBKeyRange) return Promise.reject(new Error('IndexedDB is not available'));
    var st = IdbStore(G.indexedDB, G.IDBKeyRange);
    return st.init().then(function () { return st; });
}
function openMemory() { var st = asyncStore(MemStore(), 'memory'); return st.init().then(function () { return st; }); }
var OPEN = { opfs: openOpfs, sqljs: openSqlJs, idb: openIdb, memory: openMemory };

function engineOrder() {
    var s = getSettings(), home = lsGet(LS_HOME);
    var first = s.engine !== 'auto' ? s.engine : (ENGINES.indexOf(home) >= 0 ? home : null);
    if (first === 'memory') return ['memory'];
    if (first) return uniq([first, 'idb', 'memory']);      // home unavailable → spool to IndexedDB, merged later
    return ENGINES.slice();
}
function openBest() {
    var order = engineOrder(), i = 0;
    E.reasons = [];
    function next() {
        if (i >= order.length) return Promise.reject(new Error('no storage engine available: ' + E.reasons.join('; ')));
        var name = order[i++];
        return OPEN[name]().then(function (st) { return { name: name, store: st }; },
            function (e) { E.reasons.push(ENGINE_LABEL[name] + ' — ' + errMsg(e)); return next(); });
    }
    return next();
}
function indexTag(t) { E.byName[t.name] = t; E.byId[t.id] = t; }
function reloadMeta() {
    return E.store.getTags().then(function (tags) {
        E.byName = {}; E.byId = {};
        tags.forEach(indexTag);
        return refreshStats();
    }).then(function () { return E.store.info().then(function (i) { E.info = i; }, noop); });
}
function refreshStats() {
    return E.store.statsAll().then(function (s) { E.stat = s || {}; return E.store.totals(); }).then(function (t) { E.tot = t; });
}
function afterOpen(r) {
    E.store = r.store; E.engine = r.name;
    var home = lsGet(LS_HOME);
    if (!home && r.name !== 'memory') { lsSet(LS_HOME, r.name); home = r.name; }
    E.home = home || r.name;
    E.spoolFor = (home && home !== r.name && ENGINES.indexOf(home) >= 0 && r.name !== 'memory') ? home : null;
    if (E.spoolFor) lsSet(LS_SPOOL, '1');
    return reloadMeta().then(function () {
        if (E.spoolFor || r.name === 'idb' || r.name === 'memory' || lsGet(LS_SPOOL) !== '1') return null;
        return drainSpool().catch(function (e) { E.notes.push('Merging the IndexedDB spool failed: ' + errMsg(e)); });
    }).then(function () { publishState(); return E.store; });
}
function ensureStore() {
    if (E.store) return Promise.resolve(E.store);
    if (!E.initP) E.initP = openBest().then(afterOpen).then(function (s) { E.initP = null; return s; }, function (e) { E.initP = null; throw e; });
    return E.initP;
}
// Samples written to IndexedDB while the home engine was unavailable → home. Only what was
// copied is deleted from the spool (per tag, up to the latest copied time), so samples another
// tab is still spooling meanwhile are kept for the next merge.
function drainSpool() {
    if (!G.indexedDB || !G.IDBKeyRange) return Promise.resolve();
    var sp = IdbStore(G.indexedDB, G.IDBKeyRange), left = 0;
    return sp.init().then(function () { return sp.totals(); }).then(function (t) {
        if (!t.samples && !t.rollups) return null;
        return copyStore(sp, E.store, 'ignore').then(function (r) {
            E.notes.push('Merged ' + fmtCount(r.samples) + ' samples recorded while the ' + ENGINE_LABEL[E.engine] + ' store was unavailable.');
            return Object.keys(r.upTo).reduce(function (p, id) {
                return p.then(function () { return sp.deleteSamples(+id, 0, r.upTo[id]); }).then(function () { return sp.deleteRollups(+id, 0, r.upTo[id]); });
            }, Promise.resolve());
        }).then(function () { return sp.totals(); }).then(function (t2) { left = t2.samples + t2.rollups; markDirty(); return reloadMeta(); });
    }).then(function () { lsSet(LS_SPOOL, left ? '1' : '0'); return sp.close(); });
}
// Copy every tag, sample and rollup from one store into another (dup: 'ignore' | 'replace').
function copyStore(src, dst, dup) {
    var res = { samples: 0, rollups: 0, tags: 0, upTo: {} };        // upTo: source tag id → latest time copied
    return src.getTags().then(function (tags) {
        if (!tags.length) return res;
        res.tags = tags.length;
        return dst.putTags(tags.map(function (t) { return { name: t.name, device: t.device, unit: t.unit, descr: t.descr, created: t.created }; })).then(function (dt) {
            var map = {};
            dt.forEach(function (t) { map[t.name] = t.id; });
            return tags.reduce(function (p, tg) {
                return p.then(function () {
                    var did = map[tg.name], lo = 0;
                    function more() {
                        return src.getSamples(tg.id, lo, MAXT, CHUNK).then(function (c) {
                            if (!c.t.length) return null;
                            res.upTo[tg.id] = Math.max(res.upTo[tg.id] || 0, c.t[c.t.length - 1]);
                            return dst.putSamples(repeat(did, c.t.length), c.t, c.v, c.q, dup).then(function (r) {
                                res.samples += r.inserted + r.updated;
                                if (c.t.length < CHUNK) return null;
                                lo = c.t[c.t.length - 1] + 1;
                                return more();
                            });
                        });
                    }
                    return more().then(function () { return src.getRollups(tg.id, 0, MAXT); }).then(function (rs) {
                        if (!rs.length) return null;
                        res.upTo[tg.id] = Math.max(res.upTo[tg.id] || 0, rs[rs.length - 1].t);
                        return dst.putRollups(did, rs).then(function (n) { res.rollups += n; });
                    });
                });
            }, Promise.resolve()).then(function () { return res; });
        });
    });
}

// sql.js keeps the file in memory: save it to IndexedDB 1–8 s after a write, and at once
// when the page is hidden. Every store call is atomic (the rollup swap is one transaction), so a
// snapshot taken between two calls is always consistent; the urgent path skips the queue.
function markDirty() {
    if (E.engine !== 'sqljs' || !E.store || !E.store.persist) return;
    E.dirty = true;
    // A small file (< 100k rows ≈ 2.5 MB) is cheap to re-write: save within 1 s; larger ones every 8 s.
    if (E.persistTimer === null) E.persistTimer = setTimeout(function () { E.persistTimer = null; persistNow(); }, E.tot.samples < 100000 ? 1000 : 8000);
}
function persistNow(urgent) {
    if (E.persistTimer !== null) { clearTimeout(E.persistTimer); E.persistTimer = null; }
    var run = function () {
        if (!E.dirty || !E.store || !E.store.persist) return Promise.resolve(false);
        E.dirty = false;
        return E.store.persist().then(function () { E.lastPersist = Date.now(); return true; },
            function (e) { E.dirty = true; E.lastError = 'Saving the SQLite file failed: ' + errMsg(e); return false; });
    };
    return urgent ? run() : lock(run);
}
// One tab at a time may own the sql.js file (two in-memory copies would overwrite each
// other's snapshot). Web Locks: resolves to a release function, or null when another tab holds it.
function holdLock(name) {
    var L = G.navigator && G.navigator.locks;
    if (!L || typeof L.request !== 'function') return Promise.resolve(noop);   // no Web Locks (older browsers): single-tab use
    return new Promise(function (res) {
        var p;
        try {
            p = L.request(name, { ifAvailable: true }, function (lk) {
                if (!lk) { res(null); return null; }
                return new Promise(function (release) { res(release); });       // held until released (no timer involved)
            });
        } catch (e) { res(noop); return; }
        if (p && typeof p.catch === 'function') p.catch(function () { res(noop); });
    });
}
function emit(detail) {
    if (!hasDoc() || typeof document.dispatchEvent !== 'function' || typeof G.CustomEvent !== 'function') return;
    detail.engine = E.engine;
    try { document.dispatchEvent(new G.CustomEvent('wts:historian-updated', { detail: detail })); } catch (e) { /* listeners' errors stay theirs */ }
}
function publishState() {
    try {
        G.WTS_state = G.WTS_state || {};
        G.WTS_state.historian = { engine: E.engine, label: E.engine ? ENGINE_LABEL[E.engine] : null, samples: E.tot.samples, rollups: E.tot.rollups,
            tags: Object.keys(E.byId).length, buffer: E.buf.length, lastFlush: E.lastFlush || null, lastError: E.lastError || null };
    } catch (e) { /* read-only WTS_state */ }
}

// Modbus tag metadata (the Modbus page owns polling; we only read its configuration).
function modbusTagMap() {
    var M = G.WTS_modbus, out = {}, list;
    if (!M || typeof M.getTags !== 'function') return out;
    try { list = M.getTags(); } catch (e) { return out; }
    if (list && !Array.isArray(list) && typeof list === 'object') list = Object.keys(list).map(function (k) { return Object.assign({ tag: k }, list[k]); });
    (Array.isArray(list) ? list : []).forEach(function (x) {
        if (!x || typeof x !== 'object') return;
        var name = cleanStr(firstDef(x.tag, x.name, x.id), 128);
        if (!name) return;
        var poll = +firstDef(x.pollMs, x.intervalMs, x.pollRateMs, x.rateMs, x.pollIntervalMs);
        out[name] = { device: cleanStr(firstDef(x.device, x.deviceName)), unit: cleanStr(firstDef(x.unit, x.units, x.engUnit), 32),
            desc: cleanStr(firstDef(x.desc, x.description), 200), pollMs: isNum(poll) && poll > 0 ? poll : null,
            enabled: (x.enabled === false || x.log === false || x.logged === false || x.historian === false) ? false : true };
    });
    return out;
}

// ── record / flush ──
function record(samples) {
    if (!samples) return 0;
    var list = Array.isArray(samples) ? samples : (Array.isArray(samples.samples) ? samples.samples : [samples]);
    var tNow = Date.now(), n = 0;
    for (var i = 0; i < list.length; i++) {
        var s = normSample(list[i], tNow);
        if (!s) { E.rejected++; continue; }
        E.buf.push(s); n++;
        var L = E.live[s.tag];
        if (!L || s.t >= L.t) E.live[s.tag] = { t: s.t, v: s.v, q: s.q, raw: s.raw, device: s.device, unit: s.unit };
    }
    if (E.buf.length > BUFFER_CAP) { var d = E.buf.length - BUFFER_CAP; E.buf.splice(0, d); E.dropped += d; }
    if (n) scheduleFlush();
    return n;
}
function scheduleFlush() {
    var ms = E.buf.length >= FLUSH_MAX ? 0 : FLUSH_MS;
    if (E.timer !== null) {
        if (ms === 0 && E.timerMs !== 0) { clearTimeout(E.timer); E.timer = null; } else return;
    }
    E.timerMs = ms;
    E.timer = setTimeout(function () { E.timer = null; flush().catch(noop); }, ms);
}
function flush() {
    if (E.timer !== null) { clearTimeout(E.timer); E.timer = null; }
    return lock(doFlush);
}
function doFlush() {
    if (!E.buf.length) return Promise.resolve({ count: 0, inserted: 0, updated: 0 });
    var batch = E.buf, t0 = perfNow(), want = {}, names;
    E.buf = [];
    return ensureStore().then(function () {
        var mb = modbusTagMap(), list = [];
        batch.forEach(function (s) {
            var w = want[s.tag] || (want[s.tag] = { name: s.tag, device: null, unit: null, descr: null });
            if (s.device) w.device = s.device;
            if (s.unit) w.unit = s.unit;
            if (s.desc) w.descr = s.desc;
        });
        names = Object.keys(want);
        names.forEach(function (name) {
            var w = want[name], cur = E.byName[name], m = mb[name];
            if (m) { if (!w.unit) w.unit = m.unit; if (!w.device) w.device = m.device; if (m.desc) w.descr = m.desc; }
            if (!cur || (w.unit && w.unit !== cur.unit) || (w.device && w.device !== cur.device) || (w.descr && w.descr !== cur.descr)) list.push(w);
        });
        return list.length ? E.store.putTags(list).then(function (all) { all.forEach(indexTag); E.tot.tags = all.length; }) : null;
    }).then(function () {
        batch.sort(function (a, b) { return a.t - b.t; });                    // stable: a later record of the same (tag, t) wins
        var ids = [], ts = [], vs = [], qs = [];
        batch.forEach(function (s) { ids.push(E.byName[s.tag].id); ts.push(s.t); vs.push(s.v); qs.push(s.q); });
        return E.store.putSamples(ids, ts, vs, qs, 'replace');
    }).then(function (r) {
        batch.forEach(function (s) {
            var id = E.byName[s.tag].id, x = E.stat[id] || (E.stat[id] = { n: 0, first: null, last: null, rn: 0, rfirst: null, rlast: null });
            if (x.first === null || s.t < x.first) x.first = s.t;
            if (x.last === null || s.t >= x.last) { x.last = s.t; x.lastV = s.v; x.lastQ = s.q; }
        });
        Object.keys(r.byTag || {}).forEach(function (id) { if (E.stat[id]) E.stat[id].n += r.byTag[id]; });
        E.tot.samples += r.inserted;
        E.written += r.inserted + r.updated; E.flushes++; E.lastFlush = Date.now(); E.lastFlushMs = perfNow() - t0; E.lastError = '';
        if (E.spoolFor) lsSet(LS_SPOOL, '1');
        markDirty();
        var due = Date.now() - E.lastRetention >= RETENTION_EVERY_MS || E.tot.samples > effCap();
        return (due ? runRetention() : Promise.resolve(null)).then(function () {
            publishState();
            emit({ reason: 'flush', count: batch.length, inserted: r.inserted, updated: r.updated, tags: names, from: batch[0].t, to: batch[batch.length - 1].t });
            return { count: batch.length, inserted: r.inserted, updated: r.updated };
        });
    }).catch(function (e) {
        // Keep the samples (bounded) for the next attempt; the next record() schedules it.
        E.buf = batch.concat(E.buf);
        if (E.buf.length > BUFFER_CAP) { var d = E.buf.length - BUFFER_CAP; E.buf.splice(0, d); E.dropped += d; }
        E.errors++; E.lastError = errMsg(e);
        // A crashed storage worker is reopened by the next write (never in a loop: only record() schedules it).
        if (E.store && typeof E.store.isDead === 'function' && E.store.isDead()) { E.store = null; E.initP = null; }
        publishState();
        throw e;
    });
}

// ── retention / downsampling (runs inside the lock) ──
function eachId(fn) {
    var ids = Object.keys(E.byId).map(Number);
    return ids.reduce(function (p, id) { return p.then(function () { return fn(id); }); }, Promise.resolve());
}
// Raw samples of one tag before `cut` (a minute boundary) → 60-s rollups (merged with any
// rollup already stored for the same minute), then the raw rows are removed.
function rollupBefore(id, cut, out) {
    return E.store.countSamples(id, 0, cut - 1).then(function (n) {
        if (!n) return 0;
        return E.store.aggSamples(id, 0, cut - 1, ROLLUP_MS).then(function (parts) {
            if (!parts.length) return parts;
            return E.store.getRollups(id, parts[0].t, parts[parts.length - 1].t).then(function (old) {
                if (old.length) parts = mergePartials(old.concat(parts), ROLLUP_MS);
                parts.forEach(function (p) { p.dt = ROLLUP_MS; });
                return parts;
            });
        }).then(function (parts) { out.rollups += parts.length; return E.store.rollupWrite(id, parts, cut); }).then(function () { return n; });
    });
}
function runRetention() {
    var s = getSettings(), now = Date.now(), out = { deleted: 0, deletedRollups: 0, rolledUp: 0, rollups: 0, capped: 0 };
    E.lastRetention = now;
    var p = Promise.resolve();
    if (s.days > 0) {
        var cut = now - s.days * DAY;
        p = p.then(function () {
            return eachId(function (id) {
                return E.store.deleteSamples(id, 0, cut - 1).then(function (n) { out.deleted += n; return E.store.deleteRollups(id, 0, cut - 1); })
                    .then(function (n) { out.deletedRollups += n; });
            });
        });
    }
    if (s.downsampleAfterDays > 0) {
        var cut2 = floorTo(now - s.downsampleAfterDays * DAY, ROLLUP_MS);
        p = p.then(function () { return eachId(function (id) { return rollupBefore(id, cut2, out).then(function (n) { out.rolledUp += n; }); }); });
    }
    var cap = effCap();
    if (isFinite(cap)) {
        // Row cap: move the cut forward in proportion to the excess (aiming 10 % below the cap)
        // and roll up (or, with downsampling off, delete) the oldest raw samples. ≤ 4 passes.
        var pass = 0;
        var capStep = function () {
            return E.store.totals().then(function (t) {
                if (t.samples <= cap || pass++ >= 4) return null;
                return E.store.statsAll().then(function (st) {
                    var lo = Infinity, hi = -Infinity;
                    Object.keys(st).forEach(function (k) { var x = st[k]; if (x.n > 0) { if (x.first < lo) lo = x.first; if (x.last > hi) hi = x.last; } });
                    if (!isFinite(lo)) return null;
                    var excess = t.samples - Math.floor(cap * 0.9);
                    var T = floorTo(lo + (hi - lo) * Math.min(1, excess / t.samples), ROLLUP_MS);
                    T = Math.max(T, floorTo(lo, ROLLUP_MS) + ROLLUP_MS);
                    return eachId(function (id) {
                        if (s.downsampleAfterDays > 0) return rollupBefore(id, T, out).then(function (n) { out.capped += n; });
                        return E.store.deleteSamples(id, 0, T - 1).then(function (n) { out.capped += n; });
                    }).then(capStep);
                });
            });
        };
        p = p.then(capStep);
    }
    return p.then(function () { return E.store.vacuum(); }).then(refreshStats).then(function () {
        E.lastRetentionResult = out;
        if (out.deleted || out.deletedRollups || out.rolledUp || out.capped) {
            markDirty();
            emit({ reason: 'retention', deleted: out.deleted, deletedRollups: out.deletedRollups, rolledUp: out.rolledUp, capped: out.capped });
        }
        return out;
    });
}

// ── query ──
var AGGS = ['raw', 'avg', 'min', 'max', 'last'];
function resolveTagNames(tags) {
    if (tags === undefined || tags === null) return Object.keys(E.byName).sort();
    var a = Array.isArray(tags) ? tags : [tags];
    return uniq(a.map(function (x) { return x && typeof x === 'object' ? String(firstDef(x.tag, x.name, '')) : String(x == null ? '' : x); }).filter(Boolean));
}
function timeArg(x, d) {
    if (x === undefined || x === null || x === '') return d;
    var n = isDateObj(x) ? x.getTime() : +x;
    return isFinite(n) ? Math.round(n) : d;
}
function seriesFor(tag, from, to, agg, o) {
    var meta = E.byName[tag];
    var base = { tag: tag, unit: meta ? meta.unit : null, device: meta ? meta.device : null, t: [], v: [], q: [] };
    if (!meta) { base.missing = true; return Promise.resolve(base); }
    var id = meta.id;
    if (agg === 'raw') {
        return Promise.all([E.store.getSamples(id, from, to), E.store.getRollups(id, from, to)]).then(function (r) {
            var raw = r[0], roll = r[1], t = raw.t, v = raw.v, q = raw.q, src = null;
            if (roll.length) {                                  // rolled-up minutes appear as their mean, flagged in .rollup
                var mt = [], mv = [], mq = [], ms = [], i = 0, j = 0;
                while (i < t.length || j < roll.length) {
                    if (j >= roll.length || (i < t.length && t[i] <= roll[j].t)) { mt.push(t[i]); mv.push(v[i]); mq.push(q[i]); ms.push(0); i++; }
                    else { var x = roll[j++]; mt.push(x.t); mv.push(x.avg); mq.push(x.q); ms.push(1); }
                }
                t = mt; v = mv; q = mq; src = ms;
            }
            base.count = raw.t.length + roll.length;
            var keep = o.maxPoints > 0 ? decimate(t, v, q, o.maxPoints) : null;
            if (keep) {
                base.t = keep.map(function (k) { return t[k]; }); base.v = keep.map(function (k) { return v[k]; }); base.q = keep.map(function (k) { return q[k]; });
                if (src) base.rollup = keep.map(function (k) { return src[k]; });
                base.decimated = true;
            } else { base.t = t; base.v = v; base.q = q; if (src) base.rollup = src; }
            return base;
        });
    }
    var b = o.bucketMs;
    return Promise.all([E.store.aggSamples(id, from, to, b), E.store.getRollups(id, from, to)]).then(function (r) {
        var parts = r[0], roll = r[1];
        if (roll.length) parts = mergePartials(parts.concat(b >= ROLLUP_MS ? mergePartials(roll, b) : roll), 0);
        var pick = agg === 'min' ? 'min' : agg === 'max' ? 'max' : agg === 'last' ? 'last' : 'avg';
        base.bucketMs = b;
        base.t = parts.map(function (p) { return p.t; });
        base.v = parts.map(function (p) { return p[pick]; });
        base.q = parts.map(function (p) { return p.q; });
        base.n = parts.map(function (p) { return p.n; });
        base.min = parts.map(function (p) { return p.min; });
        base.max = parts.map(function (p) { return p.max; });
        return base;
    });
}
function dataSpan(names) {
    var lo = Infinity, hi = -Infinity;
    names.forEach(function (n) {
        var m = E.byName[n], x = m && E.stat[m.id];
        if (!x) return;
        [x.first, x.rfirst].forEach(function (v) { if (isNum(v) && v < lo) lo = v; });
        [x.last, x.rlast].forEach(function (v) { if (isNum(v) && v > hi) hi = v; });
    });
    return isFinite(lo) ? [lo, hi] : [Date.now() - 3600000, Date.now()];
}
function query(o) {
    o = o || {};
    return flush().catch(noop).then(ensureStore).then(function () {
        var tags = resolveTagNames(o.tags), agg = AGGS.indexOf(o.agg) >= 0 ? o.agg : 'raw';
        var from = Math.max(0, timeArg(o.from, 0)), to = timeArg(o.to, MAXT), b = null, mp = Math.max(0, Math.floor(+o.maxPoints || 0));
        if (agg !== 'raw') {
            if (isNum(+o.bucketMs) && +o.bucketMs >= 1) b = Math.round(+o.bucketMs);
            else {
                var sp = dataSpan(tags), lo = Math.max(from, sp[0]), hi = Math.min(to, sp[1]);
                b = niceBucket(Math.max(1, hi - lo) / Math.max(1, mp || 1000));
            }
        }
        var series = [];
        return tags.reduce(function (p, tag) {
            return p.then(function () { return seriesFor(tag, from, to, agg, { maxPoints: mp, bucketMs: b }).then(function (s) { series.push(s); }); });
        }, Promise.resolve()).then(function () { return { from: from, to: to, agg: agg, bucketMs: b, engine: E.engine, series: series }; });
    });
}
// Trend data for the page: per tag, raw points when they fit (LTTB above 2 px⁻¹),
// else bucket means with the min/max envelope.
function trendData(o) {
    return flush().catch(noop).then(ensureStore).then(function () {
        var span = Math.max(1000, o.to - o.from), margin = span * 0.02, from = Math.max(0, Math.floor(o.from - margin)), to = Math.ceil(o.to + margin);
        var px = Math.max(50, Math.floor(o.px || 600)), out = [];
        return resolveTagNames(o.tags).reduce(function (p, tag) {
            return p.then(function () {
                var m = E.byName[tag];
                if (!m) { out.push({ tag: tag, t: [], v: [], q: [], unit: null, mode: 'raw', count: 0 }); return null; }
                return Promise.all([E.store.countSamples(m.id, from, to), E.store.countRollups(m.id, from, to)]).then(function (c) {
                    var n = c[0] + c[1], mode = o.agg && o.agg !== 'auto' ? o.agg : (n <= 3 * px ? 'raw' : 'avg');
                    var b = mode === 'raw' ? null : niceBucket(span / px);
                    return seriesFor(tag, from, to, mode, { maxPoints: mode === 'raw' ? 2 * px : 0, bucketMs: b }).then(function (s) {
                        s.mode = mode; s.count = n; out.push(s);
                    });
                });
            });
        }, Promise.resolve()).then(function () { return { from: o.from, to: o.to, series: out }; });
    });
}

function tagStatus(m, lastT, lastQ, now) {
    if (m && m.enabled === false) return { code: 'disabled', label: 'Not logged (disabled on the Modbus page)' };
    if (!isNum(lastT)) return { code: 'nodata', label: m ? 'Configured — no data yet' : 'No data' };
    var age = now - lastT, lim = (m && m.pollMs) ? Math.max(3 * m.pollMs, 10000) : 60000;
    if (age > lim) return { code: 'idle', label: 'Idle — last sample ' + fmtDur(age) + ' ago' };
    if (lastQ === 2) return { code: 'bad', label: 'Logging — bad quality' };
    if (lastQ === 1) return { code: 'stale', label: 'Logging — stale value' };
    return { code: 'logging', label: 'Logging' };
}
function listTags() {
    return flush().catch(noop).then(ensureStore).then(function () {
        var mb = modbusTagMap(), now = Date.now();
        var names = uniq(Object.keys(E.byName).concat(Object.keys(mb)).concat(Object.keys(E.live))).sort();
        return names.map(function (name) {
            var t = E.byName[name], x = (t && E.stat[t.id]) || {}, m = mb[name] || null, L = E.live[name];
            var lastT = L ? Math.max(L.t, isNum(x.last) ? x.last : -Infinity) : firstDef(x.last, x.rlast);
            var useLive = L && (!isNum(x.last) || L.t >= x.last);
            var lastQ = useLive ? L.q : firstDef(x.lastQ, null), lastV = useLive ? L.v : firstDef(x.lastV, null);
            var first = [x.first, x.rfirst].filter(isNum);
            return {
                tag: name, id: t ? t.id : null, device: firstDef(t && t.device, m && m.device, L && L.device), unit: firstDef(t && t.unit, m && m.unit, L && L.unit),
                desc: firstDef(t && t.descr, m && m.desc), count: x.n || 0, rollups: x.rn || 0, first: first.length ? Math.min.apply(null, first) : null,
                last: isNum(lastT) ? lastT : null, lastValue: lastV, lastQuality: lastQ === null || lastQ === undefined ? null : QN[lastQ],
                configured: !!m, enabled: m ? m.enabled : null, pollMs: m ? m.pollMs : null, source: /^FORM\.|^SIM\./.test(name) || firstDef(t && t.device, L && L.device) === 'form' ? 'form' : /^DEMO\./.test(name) ? 'demo' : (m ? 'modbus' : 'recorded'),
                status: tagStatus(m, isNum(lastT) ? lastT : null, lastQ, now)
            };
        });
    });
}
function storageEstimate() {
    var st = G.navigator && G.navigator.storage, o = { usage: null, quota: null, persisted: null, canPersist: !!(st && typeof st.persist === 'function') };
    if (!st || T.noEstimate) return Promise.resolve(o);
    var est = typeof st.estimate === 'function' ? st.estimate().catch(noop) : null, per = typeof st.persisted === 'function' ? st.persisted().catch(noop) : null;
    return Promise.all([est, per]).then(function (r) {
        if (r[0]) { o.usage = isNum(r[0].usage) ? r[0].usage : null; o.quota = isNum(r[0].quota) ? r[0].quota : null; }
        if (typeof r[1] === 'boolean') o.persisted = r[1];
        return o;
    });
}
function status() {
    return {
        ready: !!E.store, engine: E.engine, label: E.engine ? ENGINE_LABEL[E.engine] : null, home: E.home, spoolFor: E.spoolFor,
        reasons: E.reasons.slice(), notes: E.notes.slice(), buffer: E.buf.length, dropped: E.dropped, rejected: E.rejected,
        flushes: E.flushes, written: E.written, lastFlush: E.lastFlush || null, lastFlushMs: E.lastFlushMs, lastError: E.lastError || null,
        samples: E.tot.samples, rollups: E.tot.rollups, tags: Object.keys(E.byId).length, lib: JSON.parse(JSON.stringify(E.lib))
    };
}
function stats() {
    return ensureStore().then(function () {
        return E.store.info().then(function (i) { E.info = i; }, noop);
    }).then(storageEstimate).then(function (est) {
        var s = status(), set = getSettings(), lo = Infinity, hi = -Infinity;
        Object.keys(E.stat).forEach(function (k) {
            var x = E.stat[k];
            [x.first, x.rfirst].forEach(function (v) { if (isNum(v) && v < lo) lo = v; });
            [x.last, x.rlast].forEach(function (v) { if (isNum(v) && v > hi) hi = v; });
        });
        s.first = isFinite(lo) ? lo : null; s.last = isFinite(hi) ? hi : null;
        s.version = E.info ? E.info.version : null; s.dbBytes = E.info && isNum(E.info.bytes) ? E.info.bytes : null;
        s.retention = { days: set.days, maxRows: set.maxRows, downsampleAfterDays: set.downsampleAfterDays };
        s.enginePref = set.engine; s.effectiveMaxRows = isFinite(effCap()) ? effCap() : null;
        s.lastRetention = E.lastRetention || null; s.lastRetentionResult = E.lastRetentionResult;
        s.storage = est; s.lastPersist = E.lastPersist || null;
        return s;
    });
}

// ── retention settings / purge / engine switch ──
function setRetention(o) {
    o = o || {};
    var s = getSettings(), errs = [];
    var chk = function (k, lo, hi, label) {
        if (o[k] === undefined || o[k] === null || o[k] === '') return;
        var n = +o[k];
        if (!isFinite(n) || n < lo || n > hi || Math.round(n) !== n) errs.push(label + ' must be a whole number from ' + lo + ' to ' + fmtCount(hi));
        else s[k] = n;
    };
    chk('days', 0, 36500, 'Retention (days)');
    chk('downsampleAfterDays', 0, 36500, 'Downsample after (days)');
    chk('maxRows', 0, 1e10, 'Max raw rows');
    if (s.maxRows > 0 && s.maxRows < 1000) errs.push('Max raw rows must be 0 (no limit) or at least 1,000');
    if (errs.length) return Promise.reject(new Error(errs.join('; ')));
    saveSettings(s);
    return lock(function () { return ensureStore().then(runRetention); }).then(function (res) {
        publishState();
        return { days: s.days, maxRows: s.maxRows, downsampleAfterDays: s.downsampleAfterDays, effectiveMaxRows: isFinite(effCap()) ? effCap() : null, result: res };
    });
}
function purge(o) {
    o = o || {};
    var before = o.before === undefined || o.before === null || o.before === '' ? null : timeArg(o.before, null);
    if (before === null && !o.tags && o.all !== true) return Promise.reject(new Error('purge() needs {before}, {tags} or {all: true}'));
    return flush().catch(noop).then(function () {
        return lock(function () {
            return ensureStore().then(function () {
                var out = { samples: 0, rollups: 0 };
                if (o.all === true && before === null && !o.tags) {
                    out.samples = E.tot.samples; out.rollups = E.tot.rollups;
                    return E.store.clear().then(function () { return reloadMeta(); }).then(function () { return out; });
                }
                var names = o.tags ? resolveTagNames(o.tags) : Object.keys(E.byName), to = before === null ? MAXT : before - 1;
                return names.reduce(function (p, n) {
                    var m = E.byName[n];
                    if (!m) return p;
                    return p.then(function () { return E.store.deleteSamples(m.id, 0, to); }).then(function (k) { out.samples += k; return E.store.deleteRollups(m.id, 0, to); })
                        .then(function (k) { out.rollups += k; });
                }, Promise.resolve()).then(function () { return E.store.vacuum(); }).then(refreshStats).then(function () { return out; });
            }).then(function (out) {
                markDirty(); publishState();
                emit({ reason: 'purge', samples: out.samples, rollups: out.rollups });
                return out;
            });
        });
    });
}
function switchEngine(name, opts) {
    if (name !== 'auto' && ENGINES.indexOf(name) < 0) return Promise.reject(new Error('Unknown storage engine "' + name + '"'));
    opts = opts || {};
    return flush().catch(noop).then(function () {
        return lock(function () {
            return ensureStore().then(function () {
                var s = getSettings();
                if (name === 'auto' || name === E.engine) {
                    s.engine = name; saveSettings(s);
                    if (name !== 'auto') { lsSet(LS_HOME, name); E.home = name; E.spoolFor = null; }
                    return { engine: E.engine, from: E.engine, moved: 0, rollups: 0 };
                }
                var old = E.store, oldName = E.engine, dst, res;
                return OPEN[name]().then(function (st) { dst = st; return copyStore(old, dst, 'ignore'); }).then(function (r) {
                    res = r;
                    if (oldName === 'sqljs') { E.dirty = false; if (E.persistTimer !== null) { clearTimeout(E.persistTimer); E.persistTimer = null; } }
                    var clearOld = opts.clearOld === false ? Promise.resolve() : old.clear().then(function () { return old.persist ? old.persist() : null; }).catch(noop);
                    return clearOld.then(function () { return old.close ? old.close() : null; }).catch(noop);
                }).then(function () {
                    E.store = dst; E.engine = name; E.home = name; E.spoolFor = null;
                    lsSet(LS_HOME, name); s.engine = name; saveSettings(s);
                    return reloadMeta();
                }).then(function () {
                    markDirty(); publishState();
                    emit({ reason: 'engine', from: oldName, samples: res.samples });
                    return { engine: name, from: oldName, moved: res.samples, rollups: res.rollups };
                });
            });
        });
    });
}

// ── export ──
function fileStamp(ext, pre) { return (pre || 'historian') + '-' + stamp(Date.now()) + '.' + ext; }
function download(parts, filename, type) {
    if (!hasDoc() || !G.Blob || !G.URL || typeof G.URL.createObjectURL !== 'function') return false;
    var a = document.createElement('a');
    a.href = G.URL.createObjectURL(new G.Blob(parts, { type: type }));
    a.download = filename;
    a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a);
    a.click();
    setTimeout(function () { try { G.URL.revokeObjectURL(a.href); if (a.parentNode) a.parentNode.removeChild(a); } catch (e) {} }, 1500);
    return true;
}
function rawWithRollups(id, from, to, withRoll) {
    var lo = from, o = { t: [], v: [], q: [], roll: [] };
    function more() {
        return E.store.getSamples(id, lo, to, CHUNK).then(function (c) {
            for (var i = 0; i < c.t.length; i++) { o.t.push(c.t[i]); o.v.push(c.v[i]); o.q.push(c.q[i]); }
            if (c.t.length < CHUNK) return null;
            lo = c.t[c.t.length - 1] + 1;
            return more();
        });
    }
    return more().then(function () { return withRoll ? E.store.getRollups(id, from, to) : []; }).then(function (r) { o.roll = r; return o; });
}
// → {head, rows, layout, agg, bucketMs, tags, from, to}; empty cells are null.
function exportRows(o) {
    o = o || {};
    return flush().catch(noop).then(ensureStore).then(function () {
        var tags = resolveTagNames(o.tags).filter(function (n) { return !!E.byName[n]; });
        var from = Math.max(0, timeArg(o.from, 0)), to = timeArg(o.to, MAXT), agg = AGGS.indexOf(o.agg) >= 0 ? o.agg : 'raw';
        var layout = o.layout === 'wide' ? 'wide' : 'long', withRoll = o.rollups !== false, b = null;
        if (agg !== 'raw') {
            if (isNum(+o.bucketMs) && +o.bucketMs >= 1) b = Math.round(+o.bucketMs);
            else { var sp = dataSpan(tags); b = niceBucket(Math.max(1, Math.min(to, sp[1]) - Math.max(from, sp[0])) / 1000); }
        }
        var X = { head: null, rows: [], layout: layout, agg: agg, bucketMs: b, tags: tags, from: from, to: to };
        var per = {};
        return tags.reduce(function (p, name) {
            return p.then(function () {
                var m = E.byName[name];
                if (agg === 'raw') return rawWithRollups(m.id, from, to, withRoll).then(function (r) { per[name] = r; });
                return seriesFor(name, from, to, agg, { bucketMs: b }).then(function (s) { per[name] = s; });
            });
        }, Promise.resolve()).then(function () {
            if (layout === 'long') {
                X.head = LONG_HEAD.slice();
                var srcLabel = agg === 'raw' ? 'raw' : agg + ' ' + bucketLabel(b);
                tags.forEach(function (name) {
                    var m = E.byName[name], s = per[name], unit = m.unit || null, dev = m.device || null, i = 0, j = 0;
                    var roll = agg === 'raw' ? s.roll : [];
                    while (i < s.t.length || j < roll.length) {
                        if (j >= roll.length || (i < s.t.length && s.t[i] <= roll[j].t)) {
                            var v = s.v[i];
                            X.rows.push([isoUTC(s.t[i]), s.t[i], name, v === null || v === undefined ? null : v, QN[s.q[i]] || 'bad', unit, dev, srcLabel,
                                agg === 'raw' ? null : s.n[i], agg === 'raw' ? null : s.min[i], agg === 'raw' ? null : s.max[i]]);
                            i++;
                        } else {
                            var r = roll[j++];
                            X.rows.push([isoUTC(r.t), r.t, name, r.avg, QN[r.q] || 'bad', unit, dev, 'rollup ' + bucketLabel(r.dt || ROLLUP_MS), r.n, r.min, r.max]);
                        }
                    }
                });
                return X;
            }
            // Wide: one row per distinct time, one column per tag (value only; bad → empty).
            X.head = ['time_utc', 'epoch_ms'].concat(tags.map(function (n) { var u = E.byName[n].unit; return u ? n + ' [' + u + ']' : n; }));
            var cols = tags.map(function (name) {
                var s = per[name], mp = {};
                if (agg === 'raw') { s.roll.forEach(function (r) { if (r.q !== 2) mp[r.t] = r.avg; }); }
                for (var i = 0; i < s.t.length; i++) if (s.q[i] !== 2 && s.v[i] !== null && s.v[i] !== undefined) mp[s.t[i]] = s.v[i];
                return mp;
            });
            var times = {};
            tags.forEach(function (name) { var s = per[name]; s.t.forEach(function (t) { times[t] = 1; }); if (agg === 'raw') s.roll.forEach(function (r) { times[r.t] = 1; }); });
            Object.keys(times).map(Number).sort(function (a, c) { return a - c; }).forEach(function (t) {
                var row = [isoUTC(t), t], any = false;
                cols.forEach(function (mp) { var v = Object.prototype.hasOwnProperty.call(mp, t) ? mp[t] : null; if (v !== null) any = true; row.push(v); });
                if (any) X.rows.push(row);
            });
            return X;
        });
    });
}
function exportCSV(o) {
    o = o || {};
    return exportRows(o).then(function (X) {
        if (o.skipEmpty && !X.rows.length) return { filename: null, rows: 0, empty: true };       // page export: no empty file
        var parts = [csvLine(X.head)];
        for (var i = 0; i < X.rows.length; i += 5000) {
            var chunk = '';
            for (var j = i; j < Math.min(X.rows.length, i + 5000); j++) chunk += csvLine(X.rows[j]);
            parts.push(chunk);
        }
        var text = parts.join(''), filename = o.filename || fileStamp('csv');
        if (o.download !== false) download([text], filename, 'text/csv;charset=utf-8');
        return { filename: filename, rows: X.rows.length, layout: X.layout, agg: X.agg, bucketMs: X.bucketMs, text: text };
    });
}
function loadXLSX() {
    if (G.XLSX && G.XLSX.utils && typeof G.XLSX.write === 'function') return Promise.resolve(G.XLSX);
    if (typeof G.PRiSM_loadXLSX === 'function') return G.PRiSM_loadXLSX();          // the app's lazy SheetJS loader (07-data-enhancements.js)
    return Promise.reject(new Error('Excel support (SheetJS) is not available'));
}
function tagSheet(names) {
    var rows = [['tag', 'device', 'unit', 'description', 'samples', 'downsampled_rows', 'first_utc', 'last_utc']];
    names.forEach(function (n) {
        var m = E.byName[n], x = (m && E.stat[m.id]) || {}, f = [x.first, x.rfirst].filter(isNum), l = [x.last, x.rlast].filter(isNum);
        rows.push([n, m && m.device || null, m && m.unit || null, m && m.descr || null, x.n || 0, x.rn || 0,
            f.length ? isoUTC(Math.min.apply(null, f)) : null, l.length ? isoUTC(Math.max.apply(null, l)) : null]);
    });
    return rows;
}
function exportXLSX(o) {
    o = o || {};
    var X;
    return exportRows(o).then(function (x) {
        X = x;
        if (o.skipEmpty && !X.rows.length) return null;
        if (X.rows.length > 1048575) throw new Error('Too many rows for one Excel sheet (' + fmtCount(X.rows.length) + ' > 1,048,575) — narrow the range, aggregate, or export CSV.');
        return loadXLSX();
    }).then(function (XL) {
        if (!XL) return { filename: null, rows: 0, empty: true };
        var wb = XL.utils.book_new(), sheet = X.layout === 'wide' ? 'Data' : 'Samples';
        XL.utils.book_append_sheet(wb, XL.utils.aoa_to_sheet([X.head].concat(X.rows)), sheet);
        XL.utils.book_append_sheet(wb, XL.utils.aoa_to_sheet(tagSheet(X.tags)), 'Tags');
        XL.utils.book_append_sheet(wb, XL.utils.aoa_to_sheet([
            ['H2Oil Well Testing Suite — historian export'], ['exported_utc', isoUTC(Date.now())], ['engine', ENGINE_LABEL[E.engine]],
            ['from_utc', X.from > 0 ? isoUTC(X.from) : 'start'], ['to_utc', X.to < MAXT ? isoUTC(X.to) : 'end'],
            ['aggregation', X.agg === 'raw' ? 'raw samples (+ 60-s rollups of older data)' : X.agg + ' per ' + bucketLabel(X.bucketMs)],
            ['layout', X.layout], ['rows', X.rows.length],
            ['note', 'Times are UTC (ISO 8601); epoch_ms = milliseconds since 1970-01-01 UTC. Quality: good / stale / bad.']
        ]), 'Info');
        var bytes = XL.write(wb, { bookType: 'xlsx', type: 'array' }), filename = o.filename || fileStamp('xlsx');
        if (o.download !== false) download([bytes], filename, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        return { filename: filename, rows: X.rows.length, layout: X.layout, sheets: [sheet, 'Tags', 'Info'], bytes: bytes };
    });
}
function jsonBackup() {
    var out = { format: 'wts-historian', version: 1, exported: isoUTC(Date.now()), engine: E.engine, tags: [], samples: {}, rollups: {}, settings: getSettings() };
    var tags = Object.keys(E.byId).map(function (k) { return E.byId[k]; }).sort(function (a, b) { return a.id - b.id; });
    return tags.reduce(function (p, t) {
        return p.then(function () {
            out.tags.push({ name: t.name, device: t.device, unit: t.unit, descr: t.descr, created: t.created });
            return rawWithRollups(t.id, 0, MAXT, true).then(function (r) {
                if (r.t.length) out.samples[t.name] = { t: r.t, v: r.v, q: r.q };
                if (r.roll.length) out.rollups[t.name] = r.roll.map(rollToArr);
            });
        });
    }, Promise.resolve()).then(function () { return out; });
}
function sqliteFromStore(src) {
    return loadSqlJs().then(function (SQL) {
        var db = new SQL.Database(), tmp = asyncStore(HistSqlStore(histSqlJsAdapter(db)), 'sqljs');
        return tmp.init().then(function () { return copyStore(src, tmp, 'ignore'); })
            .then(function () { var b = db.export(); db.close(); return b; }, function (e) { try { db.close(); } catch (e2) {} throw e; });
    });
}
function exportDb(o) {
    o = o || {};
    return flush().catch(noop).then(ensureStore).then(function () {
        var fmt = o.format === 'json' ? 'json' : o.format === 'sqlite' ? 'sqlite' : (isSqlEngine() ? 'sqlite' : 'json');
        var filename = o.filename || fileStamp(fmt === 'json' ? 'json' : 'sqlite', 'historian-backup');
        if (fmt === 'json') {
            return jsonBackup().then(function (obj) {
                var text = JSON.stringify(obj);
                if (o.download !== false) download([text], filename, 'application/json');
                return { format: 'json', filename: filename, text: text, size: text.length, tags: obj.tags.length };
            });
        }
        return (isSqlEngine() ? E.store.exportBytes() : sqliteFromStore(E.store)).then(function (bytes) {
            bytes = toU8(bytes);
            if (o.download !== false) download([bytes], filename, 'application/vnd.sqlite3');
            return { format: 'sqlite', filename: filename, bytes: bytes, size: bytes.byteLength };
        });
    });
}

// ── import / restore ──
function readInput(input) {
    if (input === null || input === undefined) return Promise.reject(new Error('No file'));
    if (typeof input === 'string') return Promise.resolve(input);
    if (input && typeof input === 'object' && 'data' in input && !(typeof input.arrayBuffer === 'function')) return readInput(input.data);
    if (typeof input.byteLength === 'number') return Promise.resolve(asBuf(input));
    if (typeof input.arrayBuffer === 'function') return input.arrayBuffer();
    if (typeof G.FileReader === 'function') {
        return new Promise(function (res, rej) {
            var fr = new G.FileReader();
            fr.onload = function () { res(fr.result); };
            fr.onerror = function () { rej(fr.error || new Error('The file could not be read')); };
            fr.readAsArrayBuffer(input);
        });
    }
    return Promise.reject(new Error('Unsupported input'));
}
function detectKind(name, data) {
    var head = '';
    if (typeof data === 'string') head = data.slice(0, 16);
    else { var u = new Uint8Array(data, 0, Math.min(16, data.byteLength)); for (var i = 0; i < u.length; i++) head += String.fromCharCode(u[i]); }
    if (head.indexOf('SQLite format 3') === 0) return 'sqlite';
    if (head.indexOf('PK\u0003\u0004') === 0) return 'xlsx';
    if (/\.(sqlite3?|db)$/i.test(name)) return 'sqlite';
    if (/\.xlsx?$/i.test(name)) return 'xlsx';
    if (/^\s*\{/.test(head) || /\.json$/i.test(name)) return 'json';
    return 'csv';
}
function readSqliteBackup(bytes) {
    return loadSqlJs().then(function (SQL) {
        var db;
        try { db = new SQL.Database(toU8(bytes)); } catch (e) { throw new Error('Not a readable SQLite file (' + errMsg(e) + ')'); }
        try {
            var names = {};
            (db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0] || { values: [] }).values.forEach(function (r) { names[r[0]] = 1; });
            if (!names.tags || !names.samples) throw new Error('This SQLite file is not a historian backup (no tags / samples tables).');
            var st = HistSqlStore(histSqlJsAdapter(db)), d = { format: 'sqlite', tags: {}, samples: {}, rollups: {}, invalid: 0, rows: 0 };
            st.getTags().forEach(function (t) {
                d.tags[t.name] = { unit: t.unit, device: t.device, descr: t.descr };
                var s = st.getSamples(t.id, 0, MAXT);
                if (s.t.length) { d.samples[t.name] = s; d.rows += s.t.length; }
                if (names.rollups) { var r = st.getRollups(t.id, 0, MAXT); if (r.length) { d.rollups[t.name] = r; d.rows += r.length; } }
            });
            return d;
        } finally { db.close(); }
    });
}
function readJsonBackup(text) {
    var o;
    try { o = JSON.parse(text); } catch (e) { throw new Error('Not valid JSON (' + errMsg(e) + ')'); }
    if (!o || o.format !== 'wts-historian') throw new Error('Not a historian JSON backup (format is not "wts-historian").');
    var d = { format: 'json', tags: {}, samples: {}, rollups: {}, invalid: 0, rows: 0 };
    (Array.isArray(o.tags) ? o.tags : []).forEach(function (t) { var n = cleanStr(t && t.name, 128); if (n) d.tags[n] = { unit: cleanStr(t.unit, 32), device: cleanStr(t.device), descr: cleanStr(t.descr, 200) }; });
    Object.keys(o.samples || {}).forEach(function (name) {
        var s = o.samples[name], n = cleanStr(name, 128);
        if (!n || !s || !Array.isArray(s.t)) return;
        var out = { t: [], v: [], q: [] };
        for (var i = 0; i < s.t.length; i++) {
            d.rows++;
            var t = +s.t[i], v = s.v && s.v[i] !== undefined ? s.v[i] : null;
            v = v === null ? null : +v;
            if (!isFinite(t) || t < 0 || (v !== null && !isFinite(v))) { d.invalid++; continue; }
            out.t.push(Math.round(t)); out.v.push(v); out.q.push(qCode(s.q ? s.q[i] : undefined, v));
        }
        d.samples[n] = out;
        if (!d.tags[n]) d.tags[n] = { unit: null, device: null };
    });
    Object.keys(o.rollups || {}).forEach(function (name) {
        var n = cleanStr(name, 128), a = o.rollups[name];
        if (!n || !Array.isArray(a)) return;
        d.rollups[n] = a.filter(function (r) { d.rows++; var ok = Array.isArray(r) && isNum(+r[0]) && isNum(+r[2]); if (!ok) d.invalid++; return ok; }).map(arrToRoll);
        if (!d.tags[n]) d.tags[n] = { unit: null, device: null };
    });
    return d;
}
function readXlsx(buf) {
    return loadXLSX().then(function (XL) {
        var wb = XL.read(new Uint8Array(buf), { type: 'array' }), sn = wb.SheetNames || [];
        var name = sn.indexOf('Samples') >= 0 ? 'Samples' : sn.indexOf('Data') >= 0 ? 'Data' : sn[0];
        if (!name) throw new Error('The workbook has no sheets');
        var d = rowsToImport(XL.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' }));
        if (wb.Sheets.Tags) {
            var ta = XL.utils.sheet_to_json(wb.Sheets.Tags, { header: 1, raw: true, defval: '' }), h = (ta[0] || []).map(function (x) { return String(x).toLowerCase(); });
            var ci = function (k) { return h.indexOf(k); };
            ta.slice(1).forEach(function (r) {
                var n = cleanStr(r[ci('tag')], 128);
                if (!n) return;
                var cur = d.tags[n] || (d.tags[n] = { unit: null, device: null });
                if (ci('unit') >= 0 && cleanStr(r[ci('unit')], 32)) cur.unit = cleanStr(r[ci('unit')], 32);
                if (ci('device') >= 0 && cleanStr(r[ci('device')])) cur.device = cleanStr(r[ci('device')]);
                if (ci('description') >= 0 && cleanStr(r[ci('description')], 200)) cur.descr = cleanStr(r[ci('description')], 200);
            });
        }
        d.format = 'xlsx (' + d.format + ')';
        return d;
    });
}
function importData(d, o) {
    var dup = o.dup === 'overwrite' ? 'replace' : 'ignore', mode = o.mode === 'replace' ? 'replace' : 'merge';
    var names = uniq(Object.keys(d.tags).concat(Object.keys(d.samples)).concat(Object.keys(d.rollups)));
    var res = { format: d.format, mode: mode, duplicates: dup === 'replace' ? 'overwrite' : 'skip', rows: d.rows || 0, invalid: d.invalid || 0,
        tags: names.length, tagsCreated: 0, inserted: 0, updated: 0, skipped: 0, rollups: 0, rollupsSkipped: 0, from: null, to: null, olderThanRetention: 0 };
    var set = getSettings(), cutRet = set.days > 0 ? Date.now() - set.days * DAY : -Infinity;
    return ensureStore().then(function () {
        return mode === 'replace' ? E.store.clear().then(reloadMeta) : null;
    }).then(function () {
        res.tagsCreated = names.filter(function (n) { return !E.byName[n]; }).length;
        if (!names.length) return null;
        return E.store.putTags(names.map(function (n) { var t = d.tags[n] || {}; return { name: n, device: t.device || null, unit: t.unit || null, descr: t.descr || null }; }))
            .then(function (all) { all.forEach(indexTag); });
    }).then(function () {
        return names.reduce(function (p, n) {
            return p.then(function () {
                var id = E.byName[n].id, S = d.samples[n], R = d.rollups[n] || [];
                var span = function (t) { if (res.from === null || t < res.from) res.from = t; if (res.to === null || t > res.to) res.to = t; if (t < cutRet) res.olderThanRetention++; };
                var chunkAt = function (off) {
                    if (!S || off >= S.t.length) return Promise.resolve();
                    var end = Math.min(S.t.length, off + CHUNK), t = S.t.slice(off, end);
                    t.forEach(span);
                    return E.store.putSamples(repeat(id, t.length), t, S.v.slice(off, end), S.q.slice(off, end), dup).then(function (r) {
                        res.inserted += r.inserted; res.updated += r.updated; res.skipped += r.skipped;
                        return chunkAt(end);
                    });
                };
                return chunkAt(0).then(function () {
                    if (!R.length) return null;
                    var lo = Infinity, hi = -Infinity;
                    R.forEach(function (r) { if (r.t < lo) lo = r.t; if (r.t > hi) hi = r.t; span(r.t); });
                    return (dup === 'ignore' ? E.store.getRollups(id, lo, hi) : Promise.resolve([])).then(function (old) {
                        var have = {};
                        old.forEach(function (r) { have[r.t] = 1; });
                        var put = R.filter(function (r) { return !have[r.t]; });
                        res.rollupsSkipped += R.length - put.length;
                        return E.store.putRollups(id, put).then(function (k) { res.rollups += k; });
                    });
                });
            });
        }, Promise.resolve());
    }).then(refreshStats).then(function () {
        markDirty(); publishState();
        emit({ reason: 'import', inserted: res.inserted, updated: res.updated, rollups: res.rollups, tags: names });
        return res;
    });
}
function importFile(input, o) {
    o = o || {};
    var name = String(o.name || (input && input.name) || 'import.csv');
    return readInput(input).then(function (data) {
        var kind = o.kind || detectKind(name, data);
        if (kind === 'sqlite') return readSqliteBackup(typeof data === 'string' ? new TextEncoder().encode(data) : data);
        if (kind === 'xlsx') return readXlsx(data);
        var text = typeof data === 'string' ? data : utf8(data);
        if (kind === 'json') return readJsonBackup(text);
        var d = rowsToImport(parseDelimited(text));
        d.format = 'csv (' + d.format + ')';
        return d;
    }).then(function (d) {
        return flush().catch(noop).then(function () { return lock(function () { return importData(d, o); }); });
    }).then(function (res) { res.file = name; return res; });
}

// ─── §8 demo data and form logging (work without Modbus) ─────────────
var DEMO = [
    { tag: 'DEMO.WHP', unit: 'psig', base: 2850, amp: 60, per: 1800e3 },
    { tag: 'DEMO.WHT', unit: 'degF', base: 176, amp: 3, per: 3600e3 },
    { tag: 'DEMO.QG', unit: 'MMscf/d', base: 9.6, amp: 0.5, per: 2400e3 },
    { tag: 'DEMO.PSEP', unit: 'psig', base: 150, amp: 4, per: 600e3 }
];
function lcg(seed) { var s = (seed >>> 0) || 1; return function () { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 4294967296; }; }
// Synthetic samples: a slow sine per tag plus ±10 % noise; every 97th sample stale, every 331st bad.
function demoBatch(t, rnd, k) {
    return DEMO.map(function (d, i) {
        var v = d.base + d.amp * Math.sin(2 * Math.PI * (t % d.per) / d.per + i) + d.amp * 0.1 * (rnd() * 2 - 1), q = 'good';
        if ((k + i * 7) % 331 === 0) { v = null; q = 'bad'; } else if ((k + i * 5) % 97 === 0) q = 'stale';
        return { tag: d.tag, device: 'demo', unit: d.unit, t: t, v: v === null ? null : +v.toFixed(4), q: q };
    });
}
function demoHistory(hours, stepMs) {
    hours = hours || 24; stepMs = stepMs || 10000;
    var now = Date.now(), rnd = lcg(12345), k = 0, all = [];
    for (var t = floorTo(now - hours * 3600000, stepMs); t <= now; t += stepMs) all.push.apply(all, demoBatch(t, rnd, k++));
    record(all);
    return flush().then(function () { return all.length; });
}
var DEMOLIVE = { timer: null, until: 0, rnd: null, k: 0 };
function demoStart() {
    if (DEMOLIVE.timer !== null) return true;
    DEMOLIVE.rnd = lcg(Date.now() & 0xffff); DEMOLIVE.until = Date.now() + 3600000;      // stops by itself after 1 h
    DEMOLIVE.timer = setInterval(function () {
        var t = Date.now();
        if (t > DEMOLIVE.until) { demoStop(); return; }
        record(demoBatch(t - (t % 1000), DEMOLIVE.rnd, DEMOLIVE.k++));
    }, 1000);
    updateButtons();
    return true;
}
function demoStop() { if (DEMOLIVE.timer !== null) { clearInterval(DEMOLIVE.timer); DEMOLIVE.timer = null; } updateButtons(); return false; }

// "Log form data": the Well Test form's solved flow path (event 'wts:calc', WTS_lastCalc — imperial,
// as calcWTS publishes it) and, while the live simulator runs, its rate/cumulative summary
// (WTS_state.sim) every 5 s. Session only: it is never restarted automatically after a reload.
var FORM = { on: false, timer: null };
function formSamples(d, t) {
    if (!d || typeof d !== 'object') return [];
    var I = d.inputs || {}, C = d.choke || {}, H = d.heater || {}, out = [];
    var add = function (tag, v, unit) { if (v !== null && v !== undefined && v !== '' && isFinite(+v)) out.push({ tag: tag, device: 'form', unit: unit, t: t, v: +v, q: 'good' }); };
    add('FORM.WHP', I.Pwh, 'psig'); add('FORM.WHT', I.Twh, 'degF'); add('FORM.QG', I.Qg, 'MMscf/d');
    add('FORM.QO', I.Qo, 'bbl/d'); add('FORM.QW', I.Qw, 'bbl/d'); add('FORM.CHOKE', I.bean, '1/64 in'); add('FORM.PSEP', I.Psep, 'psig');
    if (isNum(C.Pin) && isNum(C.Pout)) add('FORM.CHOKE_DP', C.Pin - C.Pout, 'psi');
    add('FORM.HTR_OUT', H.Tout, 'degF');
    return out;
}
function simSamples(t) {
    var s = G.WTS_state && G.WTS_state.sim, out = [];
    if (!s || !s.running) return out;
    var R = s.rates || {}, C = s.cum || {};
    var add = function (tag, v, unit) { if (v !== null && v !== undefined && isFinite(+v)) out.push({ tag: tag, device: 'simulator', unit: unit, t: t, v: +v, q: 'good' }); };
    add('SIM.QG', R.gas_mmscfd, 'MMscf/d'); add('SIM.QO', R.oil_stbd, 'STB/d'); add('SIM.QW', R.water_bpd, 'bbl/d');
    add('SIM.GOR', R.gor, 'scf/STB'); add('SIM.BSW', R.bsw_pct, '%'); add('SIM.CUM_OIL', C.oil_stb, 'STB'); add('SIM.CUM_GAS', C.gas_mmscf, 'MMscf');
    return out;
}
function setFormLogging(on) {
    on = !!on;
    if (FORM.on === on) return on;
    FORM.on = on;
    if (on) {
        if (G.WTS_lastCalc) record(formSamples(G.WTS_lastCalc, Date.now()));
        FORM.timer = setInterval(function () { var s = simSamples(Date.now()); if (s.length) record(s); }, 5000);
    } else if (FORM.timer !== null) { clearInterval(FORM.timer); FORM.timer = null; }
    var cb = pageEl('[data-h="logform"]');
    if (cb) cb.checked = on;
    return on;
}

// ─── §9 page ─────────────────────────────────────────────────────────
// Categorical series colours (dark surface; checked with a CVD / contrast validator against
// #0d1117: adjacent-pair CVD ΔE ≥ 8.4, all ≥ 3:1). Assigned to tags by selection slot, never cycled.
var COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
var INK = { bg: '#0d1117', text: '#e6edf3', text2: '#8b949e', muted: '#8b949e', grid: '#21262d', axis: '#30363d', bad: '#f85149', stale: '#fab219', good: '#0ca30c' };
var PRESETS = [['5m', 300000, '5 min'], ['1h', 3600000, '1 h'], ['8h', 28800000, '8 h'], ['24h', 86400000, '24 h'], ['7d', 604800000, '7 d']];
var MAX_TREND_TAGS = COLORS.length;
var V = {
    preset: '1h', lastPreset: '1h', from: 0, to: 0, live: true, tags: null, slots: {}, agg: 'auto', layout: 'stacked',
    data: null, seq: 0, fetchTimer: null, liveTimer: null, raf: null, cursorX: null, ptr: {}, drag: null, pinch: null, geo: null,
    tagList: [], tbl: { page: 0, size: 100, desc: true, mode: 'raw', bucket: 0, qf: 'all', rows: null, series: null, bucketMs: null, seq: 0, timer: null }
};
function presetMs(p) { for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i][0] === p) return PRESETS[i][1]; return 3600000; }
function pageMounted() { return !!$('hist_root'); }
function pageEl(sel) { var r = $('hist_root'); return r && typeof r.querySelector === 'function' ? r.querySelector(sel) : null; }
function loadView() {
    var s = lsJSON(LS_VIEW) || {};
    if (PRESETS.some(function (p) { return p[0] === s.preset; })) { V.preset = s.preset; V.lastPreset = s.preset; }
    V.live = s.live !== false;
    if (!V.live && isNum(s.from) && isNum(s.to) && s.to > s.from) { V.from = s.from; V.to = s.to; V.preset = 'custom'; }
    if (Array.isArray(s.tags)) V.tags = s.tags.filter(function (x) { return typeof x === 'string'; }).slice(0, MAX_TREND_TAGS);
    if (s.slots && typeof s.slots === 'object') V.slots = s.slots;
    if (['auto', 'raw', 'avg', 'min', 'max', 'last'].indexOf(s.agg) >= 0) V.agg = s.agg;
    if (s.layout === 'overlay' || s.layout === 'stacked') V.layout = s.layout;
    var t = s.tbl || {};
    if (AGGS.indexOf(t.mode) >= 0) V.tbl.mode = t.mode;
    if ([50, 100, 500].indexOf(t.size) >= 0) V.tbl.size = t.size;
    if (['all', 'good', 'issues'].indexOf(t.qf) >= 0) V.tbl.qf = t.qf;
    if (isNum(t.bucket)) V.tbl.bucket = t.bucket;
    V.tbl.desc = t.desc !== false;
}
function saveView() {
    lsSet(LS_VIEW, JSON.stringify({ preset: V.preset === 'custom' || V.preset === 'zoom' ? V.lastPreset : V.preset, live: V.live,
        from: V.live ? null : V.from, to: V.live ? null : V.to, tags: V.tags, slots: V.slots, agg: V.agg, layout: V.layout,
        tbl: { mode: V.tbl.mode, size: V.tbl.size, qf: V.tbl.qf, bucket: V.tbl.bucket, desc: V.tbl.desc } }));
}
function colorOf(tag) { var k = V.slots[tag]; return COLORS[isNum(k) ? k : 0]; }
function assignSlot(tag) {
    if (isNum(V.slots[tag])) return;
    var used = {};
    (V.tags || []).forEach(function (t) { if (t !== tag && isNum(V.slots[t])) used[V.slots[t]] = 1; });
    for (var i = 0; i < COLORS.length; i++) if (!used[i]) { V.slots[tag] = i; return; }
}
function hexA(hex, a) { var n = parseInt(hex.slice(1), 16); return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'; }

var CSS = [
    '.hist .hist-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:10px 0 0}',
    '.hist .btn-sm{padding:7px 12px;font-size:12px;min-height:34px}',
    '.hist .hist-seg{display:inline-flex;flex-wrap:wrap;gap:2px;background:var(--bg1);border:1px solid var(--border);border-radius:8px;padding:2px}',
    '.hist .hist-seg button{background:transparent;border:0;color:var(--text2);font-size:12px;font-weight:600;padding:7px 10px;border-radius:6px;cursor:pointer;min-height:32px}',
    '.hist .hist-seg button.on{background:var(--accent);color:#fff}',
    '.hist .hist-chips{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 0}',
    '.hist .hist-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border);border-radius:999px;padding:5px 10px;font-size:12px;cursor:pointer;background:var(--bg1);color:var(--text2);min-height:30px}',
    '.hist .hist-chip.on{color:var(--text);border-color:var(--border-light);background:var(--bg4)}',
    '.hist .hist-sw{display:inline-block;width:10px;height:10px;border-radius:3px;flex:0 0 10px;vertical-align:-1px}',
    '.hist .chart-wrap{position:relative;padding:6px}',
    '.hist canvas.hist-cv{height:340px;touch-action:pan-y;cursor:crosshair;border-radius:6px;outline:none}',
    '.hist canvas.hist-cv:focus-visible{box-shadow:0 0 0 2px var(--accent)}',
    '.hist .hist-cursor{position:absolute;top:10px;left:0;pointer-events:none;background:rgba(13,17,23,.95);border:1px solid var(--border);border-radius:8px;padding:6px 9px;font-size:11.5px;color:var(--text);max-width:260px;z-index:2;font-variant-numeric:tabular-nums}',
    '.hist .hist-cursor div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.hist .hist-legend{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:12px;color:var(--text2);margin-top:8px}',
    '.hist .hist-legend b{color:var(--text);font-weight:600}',
    '.hist .hist-tblwrap{overflow-x:auto;max-width:100%;margin-top:8px}',
    '.hist .hist-tblwrap .dtable td,.hist .hist-tblwrap .dtable th{white-space:nowrap;font-variant-numeric:tabular-nums}',
    '.hist .hist-sort{background:none;border:0;color:inherit;font:inherit;cursor:pointer;padding:0;text-transform:inherit;letter-spacing:inherit}',
    '.hist .hist-badge{display:inline-block;padding:3px 9px;border-radius:999px;font-size:11.5px;font-weight:700;background:rgba(88,166,255,.12);color:var(--blue);margin-right:6px}',
    '.hist .hist-status{font-size:12.5px;color:var(--text2);line-height:1.7}',
    '.hist .hist-banner{margin-top:10px;padding:8px 12px;border-radius:8px;font-size:12.5px;border-left:3px solid var(--yellow);background:rgba(210,153,34,.08);color:var(--text)}',
    '.hist .hist-muted{color:var(--text3);font-size:12px;margin-top:6px}',
    '.hist .hist-chk{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--text);cursor:pointer;min-height:34px}',
    '.hist .hist-msg{margin-top:10px;font-size:12.5px}',
    '.hist .q-good{color:#0ca30c}.hist .q-stale{color:#fab219}.hist .q-bad{color:#f85149}.hist .q-idle{color:var(--text3)}',
    '.hist .hist-notes{margin-top:16px;font-size:12px;color:var(--text2);line-height:1.55;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:12px 14px}',
    '.hist .hist-custom label{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--text2)}',
    '.hist .fg-item{min-width:0;overflow:hidden}.hist .fg-item input,.hist .fg-item select,.hist .hist-custom input{min-width:0;max-width:100%}',
    '.hist input[type=file]{width:100%;overflow:hidden}',
    '@media (max-width:600px){.hist canvas.hist-cv{height:260px}.hist .fg{grid-template-columns:1fr}.hist .hist-seg button{padding:7px 8px}}'
].join('\n');
function ensureCss() {
    if (!hasDoc() || $('hist_css') || typeof document.createElement !== 'function') return;
    var st = document.createElement('style');
    st.id = 'hist_css';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
}
function seg(name, items, cur) {
    return '<div class="hist-seg" role="group" aria-label="' + esc(name) + '" data-seg="' + esc(name) + '">' + items.map(function (it) {
        var on = it[0] === cur;
        return '<button type="button" data-v="' + esc(it[0]) + '"' + (on ? ' class="on"' : '') + ' aria-pressed="' + on + '">' + esc(it[it.length - 1]) + '</button>';
    }).join('') + '</div>';
}
function opts(list, cur) { return list.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(cur) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join(''); }
var AGG_OPTS = [['avg', 'Average per bucket'], ['min', 'Minimum per bucket'], ['max', 'Maximum per bucket'], ['last', 'Last value per bucket']];
function pageHtml() {
    var ranges = PRESETS.map(function (p) { return [p[0], p[2]]; }).concat([['custom', 'Custom']]);
    return '<div id="hist_root" class="hist">' +
        '<div class="card"><div class="card-title">Historian status</div>' +
        '<div id="hist_status" class="hist-status">Opening the historian store…</div>' +
        '<div id="hist_banner" class="hist-banner" style="display:none"></div>' +
        '<div class="hist-row rp-skip">' +
        '<button type="button" class="btn btn-secondary btn-sm" id="hist_modbus_btn" style="display:none">Modbus configuration &#8594;</button>' +
        '<label class="hist-chk"><input type="checkbox" data-h="logform"' + (FORM.on ? ' checked' : '') + '> Log form data (Well Test form + live simulator)</label>' +
        '<button type="button" class="btn btn-secondary btn-sm" id="hist_demo_btn">' + (DEMOLIVE.timer !== null ? '&#9632; Stop demo data' : '&#9654; Start demo data') + '</button>' +
        '<button type="button" class="btn btn-secondary btn-sm" id="hist_demohist_btn">Add 24 h of demo history</button>' +
        '<button type="button" class="btn btn-secondary btn-sm" id="hist_refresh_btn">Refresh</button></div>' +
        '<div class="hist-muted rp-skip">Tags and polling rates are set on the Modbus page; this page records, trends, tabulates and exports what it receives.</div></div>' +

        '<div class="card"><div class="card-title">Trend</div>' +
        '<div class="hist-row rp-skip">' + seg('Time range', ranges, V.preset) +
        '<button type="button" class="btn btn-secondary btn-sm" id="hist_live_btn" aria-pressed="' + V.live + '">' + (V.live ? '&#9679; Live' : '&#9675; Live off') + '</button></div>' +
        '<div class="hist-row hist-custom rp-skip" id="hist_custom" style="display:' + (V.preset === 'custom' ? 'flex' : 'none') + '">' +
        '<label>From <input type="datetime-local" step="1" data-h="from"></label><label>To <input type="datetime-local" step="1" data-h="to"></label>' +
        '<button type="button" class="btn btn-secondary btn-sm" id="hist_custom_apply">Apply range</button></div>' +
        '<div class="fg" style="margin-top:12px">' +
        '<div class="fg-item"><label>Values</label><select data-h="agg">' + opts([['auto', 'Auto (raw or bucket means)'], ['raw', 'Raw samples (LTTB)']].concat(AGG_OPTS), V.agg) + '</select></div>' +
        '<div class="fg-item"><label>Layout</label><select data-h="layout">' + opts([['stacked', 'One lane per unit'], ['overlay', 'Overlay, one axis per unit']], V.layout) + '</select></div></div>' +
        '<div class="hist-chips rp-skip" id="hist_tagpick" role="group" aria-label="Tags on the trend"></div>' +
        '<div class="chart-wrap"><canvas id="hist_cv" class="hist-cv" tabindex="0" role="img" aria-label="Historian trend"></canvas>' +
        '<div id="hist_cursor" class="hist-cursor" style="display:none"></div></div>' +
        '<div id="hist_legend" class="hist-legend"></div>' +
        '<div class="hist-row rp-skip"><button type="button" class="btn btn-secondary btn-sm" id="hist_reset_btn">Reset zoom</button>' +
        '<button type="button" class="btn btn-secondary btn-sm" id="hist_png_btn">Export PNG</button><span class="hist-muted" id="hist_trend_info"></span></div>' +
        '<div class="hist-muted rp-skip">Drag to pan, mouse wheel or pinch to zoom, double-click to reset. Keyboard on the chart: &#8592; &#8594; pan, + &#8722; zoom, 0 reset.</div></div>' +

        '<div class="card"><div class="card-title">Data table</div>' +
        '<div class="fg">' +
        '<div class="fg-item"><label>Table rows</label><select data-h="tmode">' + opts([['raw', 'Raw samples, time-aligned']].concat(AGG_OPTS), V.tbl.mode) + '</select></div>' +
        '<div class="fg-item"><label>Bucket</label><select data-h="tbucket">' + opts([[0, 'Auto'], [1000, '1 s'], [10000, '10 s'], [60000, '1 min'], [300000, '5 min'], [900000, '15 min'], [3600000, '1 h'], [86400000, '1 day']], V.tbl.bucket) + '</select></div>' +
        '<div class="fg-item"><label>Quality filter</label><select data-h="tq">' + opts([['all', 'All values'], ['good', 'Good values only'], ['issues', 'Rows with stale or bad values']], V.tbl.qf) + '</select></div>' +
        '<div class="fg-item"><label>Rows per page</label><select data-h="tps">' + opts([[50, '50'], [100, '100'], [500, '500']], V.tbl.size) + '</select></div></div>' +
        '<div class="hist-muted">Time range and tags: as on the trend above. &#9676; = stale value, &#10007; = bad / no value, &#8224; = 1-minute mean of downsampled data.</div>' +
        '<div class="hist-tblwrap" id="hist_table_wrap"></div>' +
        '<div class="hist-row rp-skip"><button type="button" class="btn btn-secondary btn-sm" id="hist_prev_btn">&#8249; Prev</button>' +
        '<span id="hist_pageinfo" class="hist-muted" style="margin:0"></span>' +
        '<button type="button" class="btn btn-secondary btn-sm" id="hist_next_btn">Next &#8250;</button>' +
        '<button type="button" class="btn btn-secondary btn-sm" id="hist_copy_btn">Copy (tab-separated)</button></div>' +
        '<div id="hist_tbl_msg" class="hist-msg rp-skip"></div></div>' +

        '<div class="card"><div class="card-title">Export and restore</div>' +
        '<div class="fg">' +
        '<div class="fg-item"><label>Export format</label><select data-h="xfmt">' + opts([['csv', 'CSV, one row per sample'], ['csvwide', 'CSV, one column per tag'],
            ['xlsx', 'Excel workbook (.xlsx)'], ['sqlite', 'Database backup (.sqlite)'], ['json', 'Database backup (.json)']], 'csv') + '</select></div>' +
        '<div class="fg-item"><label>Export range</label><select data-h="xrange">' + opts([['view', 'Trend time range'], ['all', 'All data']], 'view') + '</select></div>' +
        '<div class="fg-item"><label>Export tags</label><select data-h="xtags">' + opts([['sel', 'Tags on the trend'], ['all', 'All tags']], 'sel') + '</select></div>' +
        '<div class="fg-item"><label>Export values</label><select data-h="xagg">' + opts([['raw', 'Raw samples']].concat(AGG_OPTS), 'raw') + '</select></div></div>' +
        '<div class="hist-row rp-skip"><button type="button" class="btn btn-primary btn-sm" id="hist_export_btn">Export</button>' +
        '<span class="hist-muted" style="margin:0">Raw exports include the 1-min rollups of downsampled history (source “rollup”); database backups hold every tag and all data.</span></div>' +
        '<div class="fg rp-skip" style="margin-top:14px">' +
        '<div class="fg-item"><label>Restore from a file</label><input type="file" data-h="file" accept=".csv,.txt,.tsv,.xlsx,.xls,.sqlite,.sqlite3,.db,.json"></div>' +
        '<div class="fg-item"><label>Restore mode</label><select data-h="imode">' + opts([['merge', 'Merge into the current data'], ['replace', 'Replace all current data']], 'merge') + '</select></div>' +
        '<div class="fg-item"><label>Same tag and time already stored</label><select data-h="idup">' + opts([['skip', 'Keep the stored value'], ['overwrite', 'Overwrite with the file value']], 'skip') + '</select></div></div>' +
        '<div class="hist-row rp-skip"><button type="button" class="btn btn-primary btn-sm" id="hist_import_btn">Restore</button>' +
        '<span class="hist-muted" style="margin:0">Accepts this page’s CSV / Excel exports and .sqlite / .json backups.</span></div>' +
        '<div id="hist_io_res" class="hist-msg"></div></div>' +

        '<div class="card"><div class="card-title">Storage and retention</div>' +
        '<div class="fg">' +
        '<div class="fg-item"><label>Keep data for (days, 0 = forever)</label><input type="number" min="0" step="1" data-h="days"></div>' +
        '<div class="fg-item"><label>Downsample raw data older than (days, 0 = never)</label><input type="number" min="0" step="1" data-h="dsdays"></div>' +
        '<div class="fg-item"><label>Max raw rows (0 = no limit)</label><input type="number" min="0" step="1000" data-h="maxrows"></div>' +
        '<div class="fg-item"><label>Storage engine</label><select data-h="engine">' + opts([['auto', 'Automatic (best available)'], ['opfs', ENGINE_LABEL.opfs], ['sqljs', ENGINE_LABEL.sqljs],
            ['idb', ENGINE_LABEL.idb], ['memory', ENGINE_LABEL.memory]], getSettings().engine) + '</select></div></div>' +
        '<div class="hist-row rp-skip"><button type="button" class="btn btn-secondary btn-sm" id="hist_ret_btn">Apply retention</button>' +
        '<button type="button" class="btn btn-secondary btn-sm" id="hist_engine_btn">Switch engine (moves the data)</button>' +
        '<button type="button" class="btn btn-secondary btn-sm" id="hist_persist_btn">Request persistent storage</button></div>' +
        '<div id="hist_set_msg" class="hist-msg"></div>' +
        '<div class="fg rp-skip" style="margin-top:14px">' +
        '<div class="fg-item"><label>Purge data older than</label><input type="datetime-local" step="1" data-h="pbefore"></div>' +
        '<div class="fg-item"><label>Purge which tags</label><select data-h="ptags">' + opts([['sel', 'Tags on the trend'], ['all', 'All tags']], 'sel') + '</select></div></div>' +
        '<div class="hist-row rp-skip"><button type="button" class="btn btn-secondary btn-sm" id="hist_purge_btn">Purge</button>' +
        '<button type="button" class="btn btn-secondary btn-sm" id="hist_clear_btn">Delete all historian data</button></div></div>' +

        '<div id="hist_res">' +
        '<div class="rbox"><div class="rbox-title">Historian summary</div><div id="hist_summary"></div></div>' +
        '<div class="rbox"><div class="rbox-title">Tag logging status</div><div class="hist-tblwrap" id="hist_tags_wrap"></div>' +
        '<div class="hist-row rp-skip"><button type="button" class="btn btn-secondary btn-sm" id="hist_modbus_btn2" style="display:none">Configure tags and polling on the Modbus page &#8594;</button></div></div></div>' +

        '<div class="hist-notes"><b>Notes</b> Times are stored in UTC and shown in local time. Bucket average, minimum, maximum and last use the good samples; ' +
        'a bucket with only stale samples uses those and is marked stale; with neither it is a gap. Averages are sample means, not time-weighted. ' +
        'Raw samples older than the downsample age become 1-minute rollups; data older than the retention age is deleted (checked after a write, at most every 10 min). ' +
        'Browsers may clear site data when storage is short: request persistent storage and export backups.</div>' +
        '</div>';
}
function setMsg(id, ok, text) {
    var el = $(id);
    if (!el) return;
    el.innerHTML = text ? '<div style="color:var(' + (ok === true ? '--green' : ok === false ? '--red' : '--yellow') + ')">' +
        (ok === true ? '&#10003; ' : ok === false ? '&#10007; ' : '&#9888; ') + esc(text) + '</div>' : '';
}
function updateButtons() {
    var b = $('hist_demo_btn');
    if (b) b.innerHTML = DEMOLIVE.timer !== null ? '&#9632; Stop demo data' : '&#9654; Start demo data';
    var lv = $('hist_live_btn');
    if (lv) { lv.innerHTML = V.live ? '&#9679; Live' : '&#9675; Live off'; lv.setAttribute('aria-pressed', String(V.live)); }
    var r = pageEl('[data-seg="Time range"]');
    if (r) Array.prototype.forEach.call(r.querySelectorAll('button'), function (x) {
        var on = x.getAttribute('data-v') === V.preset;
        x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on));
    });
    var c = $('hist_custom');
    if (c) c.style.display = V.preset === 'custom' ? 'flex' : 'none';
    var hasModbus = !!(G.WTS_calcRegistry && G.WTS_calcRegistry.modbus) || !!(hasDoc() && document.querySelector && document.querySelector('.nav-btn[data-p="modbus"]'));
    ['hist_modbus_btn', 'hist_modbus_btn2'].forEach(function (id) { var e = $(id); if (e) e.style.display = hasModbus ? '' : 'none'; });
}
function goModbus() {
    var b = hasDoc() && document.querySelector ? document.querySelector('.nav-btn[data-p="modbus"]') : null;
    if (b) b.click();
}

// ── status / summary / tag table ──
function refreshStatus() {
    return stats().then(function (s) {
        if (!pageMounted()) return s;
        var lib = s.engine === 'opfs' ? s.lib.sqlite : s.engine === 'sqljs' ? s.lib.sqljs : null, st = $('hist_status');
        if (st) {
            st.innerHTML = '<span class="hist-badge">' + esc(s.label) + '</span> ' +
                (lib ? esc(lib.name) + (lib.vfs ? ' · VFS ' + esc(lib.vfs) : '') + ' · ' + (lib.verified ? 'SHA-384 verified' : 'bundled copy (not hash-checked)') + ' · ' : '') +
                fmtCount(s.samples) + ' samples · ' + s.tags + ' tags' + (s.buffer ? ' · ' + fmtCount(s.buffer) + ' waiting to be written' : '');
        }
        var warn = [];
        if (s.spoolFor) warn.push('&#9888; The ' + esc(ENGINE_LABEL[s.spoolFor]) + ' store is not available in this session (' + esc(s.reasons[0] || 'unavailable') +
            '). New samples go to IndexedDB and are merged into it automatically next time it opens.');
        else if (s.reasons.length && s.engine !== 'opfs' && s.enginePref === 'auto') warn.push('&#9888; Using ' + esc(s.label) + ' — ' + esc(s.reasons.join('; ')) + '.');
        if (s.engine === 'memory') warn.push('&#9888; Memory only: the data is lost when the page closes. Export a backup to keep it.');
        s.notes.forEach(function (n) { warn.push('&#9432; ' + esc(n)); });
        if (s.lastError) warn.push('&#10007; Last write failed: ' + esc(s.lastError));
        var bn = $('hist_banner');
        if (bn) { bn.innerHTML = warn.join('<br>'); bn.style.display = warn.length ? '' : 'none'; }
        var R = s.retention, rr = function (l, v) { return '<div class="rrow"><span class="rl">' + esc(l) + '</span><span class="rv">' + esc(v) + '</span></div>'; };
        var use = s.storage || {};
        var sm = $('hist_summary');
        if (sm) sm.innerHTML =
            rr('Storage engine', s.label + (s.home && s.home !== s.engine ? ' (home: ' + ENGINE_LABEL[s.home] + ')' : '')) +
            rr('Library', lib ? lib.name + ' — ' + (lib.verified ? 'SHA-384 verified' : 'bundled copy') : (s.engine === 'idb' ? 'none (IndexedDB)' : s.engine === 'memory' ? 'none' : '—')) +
            rr('Raw samples', fmtCount(s.samples)) + rr('Downsampled 1-min rows', fmtCount(s.rollups)) + rr('Tags', fmtCount(s.tags)) +
            rr('First sample', s.first ? fmtLocal(s.first) : '—') + rr('Last sample', s.last ? fmtLocal(s.last) : '—') +
            rr('Database file size', s.dbBytes !== null ? fmtBytes(s.dbBytes) : '—') +
            rr('Site storage used / quota', use.usage !== null && use.usage !== undefined ? fmtBytes(use.usage) + ' / ' + fmtBytes(use.quota) : 'not reported by this browser') +
            rr('Persistent storage', use.persisted === true ? 'granted' : use.persisted === false ? 'not granted (the browser may evict)' : 'not reported') +
            rr('Retention', (R.days ? R.days + ' days' : 'forever') + '; raw kept ' + (R.downsampleAfterDays ? R.downsampleAfterDays + ' days, then 1-min rollups' : 'until deleted') +
                '; raw row cap ' + (s.effectiveMaxRows ? fmtCount(s.effectiveMaxRows) : 'none')) +
            rr('Last write', s.lastFlush ? fmtLocal(s.lastFlush) + ' (' + fmtCount(s.written) + ' samples written this session)' : '—');
        var setIf = function (sel, v) { var el = pageEl(sel); if (el && (!hasDoc() || document.activeElement !== el)) el.value = String(v); };
        setIf('[data-h="days"]', R.days); setIf('[data-h="dsdays"]', R.downsampleAfterDays); setIf('[data-h="maxrows"]', R.maxRows); setIf('[data-h="engine"]', s.enginePref);
        updateButtons();
        return s;
    });
}
function refreshTags() {
    return listTags().then(function (list) {
        V.tagList = list;
        var recorded = list.filter(function (x) { return x.count > 0 || x.rollups > 0 || x.last !== null; }).map(function (x) { return x.tag; });
        if (V.tags === null) {
            var pref = recorded.filter(function (n) { return !/^DEMO\./.test(n); });
            V.tags = (pref.length ? pref : recorded).slice(0, 4);
        }
        V.tags = V.tags.filter(function (n) { return recorded.indexOf(n) >= 0 || list.some(function (x) { return x.tag === n; }); }).slice(0, MAX_TREND_TAGS);
        V.tags.forEach(assignSlot);
        if (!pageMounted()) return list;
        var pick = $('hist_tagpick');
        if (pick) {
            pick.innerHTML = recorded.length ? recorded.map(function (n) {
                var on = V.tags.indexOf(n) >= 0, x = list.filter(function (y) { return y.tag === n; })[0] || {};
                return '<button type="button" class="hist-chip' + (on ? ' on' : '') + '" data-tag="' + esc(n) + '" aria-pressed="' + on + '">' +
                    '<span class="hist-sw" style="background:' + (on ? colorOf(n) : 'transparent') + ';border:1px solid ' + (on ? colorOf(n) : 'var(--border-light)') + '"></span>' +
                    esc(n) + (x.unit ? ' <span style="color:var(--text3)">' + esc(x.unit) + '</span>' : '') + '</button>';
            }).join('') : '<span class="hist-muted" style="margin:0">No data recorded yet — start Modbus polling, tick “Log form data”, or add demo data.</span>';
        }
        renderTagTable(list);
        saveView();
        return list;
    });
}
function renderTagTable(list) {
    var w = $('hist_tags_wrap');
    if (!w) return;
    if (!list.length) { w.innerHTML = '<div class="hist-muted">No tags yet.</div>'; return; }
    var sym = { logging: ['&#9679;', 'q-good'], stale: ['&#9888;', 'q-stale'], bad: ['&#10007;', 'q-bad'], idle: ['&#9675;', 'q-idle'], nodata: ['&#9675;', 'q-idle'], disabled: ['&#8856;', 'q-idle'] };
    w.innerHTML = '<table class="dtable" id="hist_tags_table"><thead><tr><th>Tag</th><th>Device</th><th>Unit</th><th>Samples</th><th>Last sample</th><th>Last value</th><th>Quality</th><th>Status</th></tr></thead><tbody>' +
        list.map(function (x) {
            var s = sym[x.status.code] || sym.idle;
            return '<tr><td>' + esc(x.tag) + '</td><td>' + esc(x.device || '') + '</td><td>' + esc(x.unit || '') + '</td><td>' + fmtCount(x.count + x.rollups) + '</td>' +
                '<td>' + esc(x.last !== null ? fmtLocal(x.last) : '—') + '</td><td>' + esc(fmtVal(x.lastValue)) + '</td>' +
                '<td class="' + (x.lastQuality === 'good' ? 'q-good' : x.lastQuality === 'stale' ? 'q-stale' : x.lastQuality === 'bad' ? 'q-bad' : '') + '">' + esc(x.lastQuality || '—') + '</td>' +
                '<td class="' + s[1] + '">' + s[0] + ' ' + esc(x.status.label) + '</td></tr>';
        }).join('') + '</tbody></table>';
}
function refreshAll() {
    if (!pageMounted()) return Promise.resolve();
    return ensureStore().then(function () { return refreshStatus(); }).then(function () { return refreshTags(); }).then(function () {
        if (V.live) { var span = (V.to - V.from) || presetMs(V.preset); V.to = Date.now(); V.from = V.to - span; }
        scheduleTrend(0); scheduleTable(0);
    }).catch(function (e) { var bn = $('hist_banner'); if (bn) { bn.innerHTML = '&#10007; ' + esc(errMsg(e)); bn.style.display = ''; } });
}

// ── trend ──
function scheduleTrend(ms) {
    if (V.fetchTimer !== null) clearTimeout(V.fetchTimer);
    V.fetchTimer = setTimeout(function () { V.fetchTimer = null; fetchTrend(); }, ms || 0);
}
function plotPx() { var g = V.geo; return g ? Math.max(100, Math.round(g.plot.w)) : 600; }
function fetchTrend() {
    if (!pageMounted()) return Promise.resolve();
    var seq = ++V.seq, tags = (V.tags || []).slice();
    if (!tags.length) { V.data = { from: V.from, to: V.to, series: [] }; drawTrend(); return Promise.resolve(); }
    return trendData({ tags: tags, from: V.from, to: V.to, px: plotPx(), agg: V.agg }).then(function (d) {
        if (seq !== V.seq || !pageMounted()) return;
        V.data = d;
        var info = $('hist_trend_info');
        if (info) {
            var modes = uniq(d.series.map(function (s) { return s.mode === 'raw' ? (s.decimated ? 'raw, LTTB-decimated' : 'raw') : s.mode + ' per ' + bucketLabel(s.bucketMs); }));
            info.textContent = fmtLocal(V.from) + ' → ' + fmtLocal(V.to) + ' · ' + modes.join(', ');
        }
        drawTrend();
    }).catch(function (e) { var info = $('hist_trend_info'); if (info) info.textContent = '✗ ' + errMsg(e); });
}
function requestDraw() {
    if (V.raf !== null) return;
    if (typeof G.requestAnimationFrame === 'function') V.raf = G.requestAnimationFrame(function () { V.raf = null; drawTrend(); });
    else drawTrend();
}
function cvSize(cv) {
    var dpr = Math.max(1, Math.min(3, G.devicePixelRatio || 1));
    // The canvas is width:100% of .chart-wrap's content box (6-px padding each side).
    var pw = cv.parentNode && cv.parentNode.clientWidth ? cv.parentNode.clientWidth - 12 : 0;
    var w = Math.max(220, Math.round(pw > 0 ? pw : (cv.clientWidth || 600)));
    var narrow = w < 560, h = narrow ? 260 : 340;
    if (cv.width !== Math.round(w * dpr)) cv.width = Math.round(w * dpr);
    if (cv.height !== Math.round(h * dpr)) cv.height = Math.round(h * dpr);
    return { w: w, h: h, dpr: dpr, narrow: narrow };
}
function trendSeries() {
    var d = V.data;
    if (!d) return [];
    return d.series.filter(function (s) { return (V.tags || []).indexOf(s.tag) >= 0; });
}
function geometry(series, sz) {
    var units = [];
    series.forEach(function (s) { var u = s.unit || '(no unit)'; if (units.indexOf(u) < 0) units.push(u); });
    if (!units.length) units.push('');
    var AW = sz.narrow ? 44 : 56, top = 20, bottom = 24, gap = 16, lanes = [], plot;
    if (V.layout === 'overlay') {
        var nL = Math.ceil(units.length / 2), nR = Math.floor(units.length / 2), x0 = 6 + nL * AW, x1 = sz.w - 8 - nR * AW;
        plot = { x: x0, y: top, w: Math.max(40, x1 - x0), h: sz.h - top - bottom };
        units.forEach(function (u, i) {
            var left = i % 2 === 0, k = Math.floor(i / 2);
            lanes.push({ unit: u, y0: plot.y, y1: plot.y + plot.h, side: left ? 'L' : 'R', axisX: left ? x0 - k * AW : x1 + k * AW });
        });
    } else {
        var xs = 6 + AW;
        plot = { x: xs, y: top, w: Math.max(40, sz.w - xs - 12), h: sz.h - top - bottom };
        var n = units.length, lh = (plot.h - gap * (n - 1)) / n;
        units.forEach(function (u, i) { var y0 = plot.y + i * (lh + gap); lanes.push({ unit: u, y0: y0, y1: y0 + lh, side: 'L', axisX: xs }); });
    }
    return { plot: plot, lanes: lanes, sz: sz };
}
function laneOf(g, s) { var u = s.unit || '(no unit)'; for (var i = 0; i < g.lanes.length; i++) if (g.lanes[i].unit === u) return g.lanes[i]; return g.lanes[0]; }
function laneScale(g, lane, series, from, to) {
    var lo = Infinity, hi = -Infinity;
    series.forEach(function (s) {
        if (laneOf(g, s) !== lane) return;
        for (var i = 0; i < s.t.length; i++) {
            if (s.t[i] < from || s.t[i] > to) continue;
            [s.v[i], s.min ? s.min[i] : null, s.max ? s.max[i] : null].forEach(function (x) { if (x !== null && x !== undefined && isFinite(x)) { if (x < lo) lo = x; if (x > hi) hi = x; } });
        }
    });
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    var tk = niceTicks(lo, hi, Math.max(2, Math.min(6, Math.floor((lane.y1 - lane.y0) / 26))));
    lane.lo = tk.lo; lane.hi = tk.hi; lane.ticks = tk.ticks; lane.step = tk.step;
    lane.toY = function (v) { return lane.y1 - (v - lane.lo) / ((lane.hi - lane.lo) || 1) * (lane.y1 - lane.y0); };
}
function fmtTick(v, step) {
    var d = step >= 1 ? 0 : Math.min(6, Math.ceil(-Math.log(step) / Math.LN10));
    var a = Math.abs(v);
    if (a >= 1e6 || (a > 0 && a < 1e-4)) return v.toExponential(1);
    return v.toFixed(d);
}
function median(a) { if (!a.length) return 0; var b = a.slice().sort(function (x, y) { return x - y; }); return b[Math.floor(b.length / 2)]; }
function drawSeries(ctx, g, s, col, from, to) {
    var lane = laneOf(g, s), n = s.t.length;
    if (!lane || !n) return;
    var P = g.plot, span = to - from;
    var X = function (i) { return P.x + (s.t[i] - from) / span * P.w; }, Y = function (v) { return lane.toY(v); };
    var ok = function (i) { var v = s.v[i]; return v !== null && v !== undefined && isFinite(v) && s.q[i] !== 2; };
    var dts = [], stride = Math.max(1, Math.floor(n / 400));
    for (var i0 = stride; i0 < n; i0 += stride) dts.push(s.t[i0] - s.t[i0 - stride]);
    var gapT = s.bucketMs ? s.bucketMs * 1.5 + 1 : Math.max(median(dts) / stride * 5, 1);
    if (s.decimated) gapT = Math.max(gapT, span / 40);
    // min–max envelope of bucket statistics
    if (s.min && s.max && (V.agg === 'auto' || V.agg === 'avg')) {
        ctx.fillStyle = hexA(col, 0.16);
        var a = 0;
        while (a < n) {
            if (!ok(a) || s.min[a] === null) { a++; continue; }
            var b = a;
            while (b + 1 < n && ok(b + 1) && s.min[b + 1] !== null && s.t[b + 1] - s.t[b] <= gapT) b++;
            ctx.beginPath();
            for (var k = a; k <= b; k++) { if (k === a) ctx.moveTo(X(k), Y(s.max[k])); else ctx.lineTo(X(k), Y(s.max[k])); }
            for (k = b; k >= a; k--) ctx.lineTo(X(k), Y(s.min[k]));
            ctx.closePath(); ctx.fill();
            a = b + 1;
        }
    }
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ['solid', 'dashed'].forEach(function (want) {
        if (typeof ctx.setLineDash === 'function') ctx.setLineDash(want === 'dashed' ? [4, 4] : []);
        ctx.beginPath();
        var pen = false;
        for (var i = 1; i < n; i++) {
            var seg = ok(i - 1) && ok(i) && (s.t[i] - s.t[i - 1]) <= gapT;
            var st = seg && (s.q[i - 1] === 1 || s.q[i] === 1) ? 'dashed' : 'solid';
            if (seg && st === want) { if (!pen) { ctx.moveTo(X(i - 1), Y(s.v[i - 1])); pen = true; } ctx.lineTo(X(i), Y(s.v[i])); }
            else pen = false;
        }
        ctx.stroke();
    });
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);
    // points: every point when sparse, else only isolated ones; bad / no-value ticks on the lane floor
    var sparse = n < P.w / 10;
    ctx.fillStyle = col;
    for (var j = 0; j < n; j++) {
        if (!ok(j)) { continue; }
        var iso = !((j > 0 && ok(j - 1) && s.t[j] - s.t[j - 1] <= gapT) || (j < n - 1 && ok(j + 1) && s.t[j + 1] - s.t[j] <= gapT));
        if (sparse || iso) { ctx.beginPath(); ctx.arc(X(j), Y(s.v[j]), 3, 0, 2 * Math.PI); ctx.fill(); }
    }
    ctx.fillStyle = INK.bad;
    for (var m = 0; m < n; m++) if (!ok(m) && s.t[m] >= from && s.t[m] <= to) ctx.fillRect(X(m) - 1, lane.y1 - 5, 2, 5);
}
function nearest(ts, t) {
    if (!ts.length) return -1;
    var lo = 0, hi = ts.length - 1;
    while (hi - lo > 1) { var m = (lo + hi) >> 1; if (ts[m] < t) lo = m; else hi = m; }
    return Math.abs(ts[lo] - t) <= Math.abs(ts[hi] - t) ? lo : hi;
}
function drawTrend() {
    var cv = $('hist_cv');
    if (!cv || typeof cv.getContext !== 'function') return;
    var ctx = cv.getContext('2d');
    if (!ctx) return;
    var sz = cvSize(cv), series = trendSeries(), from = V.from, to = V.to > V.from ? V.to : V.from + 1;
    if (typeof ctx.setTransform === 'function') ctx.setTransform(sz.dpr, 0, 0, sz.dpr, 0, 0);
    ctx.fillStyle = INK.bg; ctx.fillRect(0, 0, sz.w, sz.h);
    var g = geometry(series, sz), P = g.plot;
    V.geo = g;
    g.fromX = function (x) { return from + (x - P.x) / P.w * (to - from); };
    g.toX = function (t) { return P.x + (t - from) / (to - from) * P.w; };
    ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.lineWidth = 1;
    // time grid and labels
    var tt = timeTicks(from, to, Math.max(2, Math.floor(P.w / 90)));
    ctx.strokeStyle = INK.grid; ctx.fillStyle = INK.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    tt.ticks.forEach(function (t) {
        var x = Math.round(g.toX(t)) + 0.5;
        ctx.beginPath(); g.lanes.forEach(function (l) { ctx.moveTo(x, l.y0); ctx.lineTo(x, l.y1); }); ctx.stroke();
        ctx.fillText(tickLabel(t, tt.step, to - from), x, P.y + P.h + 6);
    });
    // lanes: value grid, axis, unit
    g.lanes.forEach(function (lane, li) {
        laneScale(g, lane, series, from, to);
        ctx.textBaseline = 'middle'; ctx.textAlign = lane.side === 'L' ? 'right' : 'left';
        lane.ticks.forEach(function (v) {
            var y = Math.round(lane.toY(v)) + 0.5;
            if (y < lane.y0 - 1 || y > lane.y1 + 1) return;
            if (V.layout !== 'overlay' || li === 0) { ctx.strokeStyle = INK.grid; ctx.beginPath(); ctx.moveTo(P.x, y); ctx.lineTo(P.x + P.w, y); ctx.stroke(); }
            ctx.fillStyle = INK.muted;
            ctx.fillText(fmtTick(v, lane.step), lane.side === 'L' ? lane.axisX - 6 : lane.axisX + 6, y);
        });
        ctx.strokeStyle = INK.axis; ctx.beginPath(); ctx.moveTo(Math.round(lane.axisX) + 0.5, lane.y0); ctx.lineTo(Math.round(lane.axisX) + 0.5, lane.y1); ctx.stroke();
        ctx.fillStyle = INK.text2; ctx.textBaseline = 'bottom';
        ctx.textAlign = V.layout === 'overlay' ? (lane.side === 'L' ? 'right' : 'left') : 'left';
        ctx.fillText(lane.unit, V.layout === 'overlay' ? (lane.side === 'L' ? lane.axisX - 4 : lane.axisX + 4) : P.x + 4, lane.y0 - 3);
    });
    ctx.strokeStyle = INK.axis; ctx.beginPath(); ctx.moveTo(P.x, P.y + P.h + 0.5); ctx.lineTo(P.x + P.w, P.y + P.h + 0.5); ctx.stroke();
    if (typeof ctx.save === 'function') ctx.save();
    ctx.beginPath(); ctx.rect(P.x, P.y - 3, P.w, P.h + 6); if (typeof ctx.clip === 'function') ctx.clip();
    series.forEach(function (s) { drawSeries(ctx, g, s, colorOf(s.tag), from, to); });
    if (typeof ctx.restore === 'function') ctx.restore();
    var empty = !series.length || series.every(function (s) { return !s.t.some(function (t) { return t >= from && t <= to; }); });
    if (empty) {
        ctx.fillStyle = INK.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText((V.tags || []).length ? 'No data in this time range' : 'Select tags to trend', P.x + P.w / 2, P.y + P.h / 2);
    }
    drawCursor(ctx, g, series);
    renderLegend(series);
    try { cv.setAttribute('aria-label', 'Historian trend of ' + series.map(function (s) { return s.tag; }).join(', ') + ' from ' + fmtLocal(from) + ' to ' + fmtLocal(to)); } catch (e) {}
}
function drawCursor(ctx, g, series) {
    var box = $('hist_cursor'), P = g.plot;
    if (V.cursorX === null || V.cursorX < P.x || V.cursorX > P.x + P.w || !series.length) { if (box) box.style.display = 'none'; return; }
    var t = g.fromX(V.cursorX), x = Math.round(V.cursorX) + 0.5, rows = [];
    ctx.strokeStyle = INK.text2;
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, P.y); ctx.lineTo(x, P.y + P.h); ctx.stroke();
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);
    series.forEach(function (s) {
        var k = nearest(s.t, t);
        if (k < 0) return;
        var v = s.v[k], lane = laneOf(g, s), col = colorOf(s.tag);
        if (v !== null && v !== undefined && isFinite(v) && s.q[k] !== 2) {
            ctx.fillStyle = INK.bg; ctx.beginPath(); ctx.arc(g.toX(s.t[k]), lane.toY(v), 5, 0, 2 * Math.PI); ctx.fill();
            ctx.fillStyle = col; ctx.beginPath(); ctx.arc(g.toX(s.t[k]), lane.toY(v), 3.5, 0, 2 * Math.PI); ctx.fill();
        }
        rows.push({ tag: s.tag, unit: s.unit, v: v, q: s.q[k], t: s.t[k], col: col, roll: s.rollup ? s.rollup[k] : 0, mode: s.mode, b: s.bucketMs });
    });
    if (!box) return;
    box.innerHTML = '<div style="color:var(--text2)">' + esc(fmtLocal(t)) + '</div>' + rows.map(function (r) {
        var val = (r.v === null || r.v === undefined || r.q === 2) ? '<span class="q-bad">&#10007; bad / no value</span>' : '<b>' + esc(fmtVal(r.v)) + '</b> ' + esc(r.unit || '');
        return '<div><span class="hist-sw" style="background:' + r.col + '"></span> ' + esc(r.tag) + ': ' + val +
            (r.q === 1 ? ' <span class="q-stale">&#9676; stale</span>' : '') + (r.roll ? ' <span style="color:var(--text3)">(1-min mean)</span>' : '') +
            (r.mode && r.mode !== 'raw' ? ' <span style="color:var(--text3)">(' + esc(r.mode) + ' ' + esc(bucketLabel(r.b)) + ')</span>' : '') + '</div>';
    }).join('');
    box.style.display = 'block';
    var w = g.sz.w, left = V.cursorX + 20;                     // box is placed in .chart-wrap (canvas at 6 px)
    if (left > w - 200) left = Math.max(4, V.cursorX - 208);
    box.style.left = Math.round(left) + 'px';
}
function renderLegend(series) {
    var el = $('hist_legend');
    if (!el) return;
    var parts = series.map(function (s) {
        var last = null;
        for (var i = s.t.length - 1; i >= 0; i--) if (s.t[i] <= V.to && s.v[i] !== null && s.q[i] !== 2) { last = s.v[i]; break; }
        return '<span><span class="hist-sw" style="background:' + colorOf(s.tag) + '"></span> <b>' + esc(s.tag) + '</b>' + (s.unit ? ' (' + esc(s.unit) + ')' : '') +
            (last !== null ? ' — ' + esc(fmtVal(last)) : '') + '</span>';
    });
    if (series.length) parts.push('<span style="color:var(--text3)">dashed = stale · red ticks = bad / no value' + (series.some(function (s) { return !!s.min; }) ? ' · band = min–max per bucket' : '') + '</span>');
    el.innerHTML = parts.join('');
}
function setView(from, to, live, keepPreset) {
    var span = Math.min(400 * DAY, Math.max(1000, to - from));
    if (to - from !== span) { var c = (from + to) / 2; from = c - span / 2; to = c + span / 2; }
    if (from < 0) { to -= from; from = 0; }
    V.from = Math.round(from); V.to = Math.round(to); V.live = !!live;
    if (!keepPreset) V.preset = live ? V.preset : 'zoom';
    updateButtons(); requestDraw(); scheduleTrend(150); scheduleTable(300); saveView();
}
function onRange(p) {
    if (p === 'custom') {
        V.preset = 'custom'; V.live = false;
        var f = pageEl('[data-h="from"]'), t = pageEl('[data-h="to"]');
        var loc = function (ms) { var d = new Date(ms); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); };
        if (f && !f.value) f.value = loc(V.from);
        if (t && !t.value) t.value = loc(V.to);
        updateButtons(); saveView();
        return;
    }
    V.preset = p; V.lastPreset = p;
    var now = Date.now();
    setView(now - presetMs(p), now, true, true);
}
function applyCustom() {
    var f = pageEl('[data-h="from"]'), t = pageEl('[data-h="to"]');
    var a = parseTime(f && f.value), b = parseTime(t && t.value);
    if (!isFinite(a) || !isFinite(b) || b <= a) { setMsg('hist_tbl_msg', false, 'Enter a custom range with “To” after “From”.'); return; }
    V.preset = 'custom';
    setView(a, b, false, true);
}
function zoomAt(x, f) {
    var g = V.geo;
    if (!g) return;
    var span = V.to - V.from, ns = Math.min(400 * DAY, Math.max(1000, span * f));
    if (V.live) { setView(V.to - ns, V.to, true, true); return; }            // live: keep the right edge on "now"
    var t = g.fromX(Math.min(g.plot.x + g.plot.w, Math.max(g.plot.x, x)));
    var from = t - (t - V.from) * ns / span;
    setView(from, from + ns, false);
}
function resetZoom() { onRange(V.lastPreset || '1h'); }
function localX(e, cv) {
    var r = cv.getBoundingClientRect ? cv.getBoundingClientRect() : { left: 0 };
    return (isNum(e.clientX) ? e.clientX : 0) - (r.left || 0);
}
function wireCanvas(cv) {
    if (!cv || typeof cv.addEventListener !== 'function') return;
    var end = function (e) {
        delete V.ptr[e.pointerId];
        if (Object.keys(V.ptr).length < 2) V.pinch = null;
        if (!Object.keys(V.ptr).length) V.drag = null;
    };
    cv.addEventListener('pointerdown', function (e) {
        if (e.button !== undefined && e.button !== 0) return;
        V.ptr[e.pointerId] = { x: localX(e, cv) };
        try { cv.setPointerCapture(e.pointerId); } catch (x) {}
        var ids = Object.keys(V.ptr);
        if (ids.length === 1) V.drag = { x0: V.ptr[ids[0]].x, from: V.from, to: V.to, moved: false };
        else if (ids.length === 2) {
            var a = V.ptr[ids[0]].x, b = V.ptr[ids[1]].x;
            V.drag = null;
            V.pinch = { d0: Math.max(10, Math.abs(a - b)), mid0: (a + b) / 2, from: V.from, to: V.to };
        }
    });
    cv.addEventListener('pointermove', function (e) {
        var x = localX(e, cv);
        if (V.ptr[e.pointerId]) V.ptr[e.pointerId].x = x;
        var ids = Object.keys(V.ptr), g = V.geo;
        if (V.pinch && ids.length >= 2 && g) {
            var a = V.ptr[ids[0]].x, b = V.ptr[ids[1]].x, span0 = V.pinch.to - V.pinch.from;
            var ns = Math.min(400 * DAY, Math.max(1000, span0 * V.pinch.d0 / Math.max(10, Math.abs(a - b))));
            var tc = V.pinch.from + (V.pinch.mid0 - g.plot.x) / g.plot.w * span0, mid = (a + b) / 2;
            var from = tc - (mid - g.plot.x) / g.plot.w * ns;
            setView(from, from + ns, false);
            return;
        }
        if (V.drag && g) {
            var dx = x - V.drag.x0;
            if (Math.abs(dx) > 3) V.drag.moved = true;
            if (V.drag.moved) {
                var dt = -dx / g.plot.w * (V.drag.to - V.drag.from);
                setView(V.drag.from + dt, V.drag.to + dt, false);
            }
            return;
        }
        V.cursorX = x; requestDraw();
    });
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', function () { if (!V.drag && !V.pinch) { V.cursorX = null; requestDraw(); } });
    cv.addEventListener('wheel', function (e) {
        if (e.preventDefault) e.preventDefault();
        var dy = isNum(e.deltaY) ? e.deltaY : 0;
        if (e.deltaMode === 1) dy *= 16;
        zoomAt(localX(e, cv), Math.exp(Math.max(-300, Math.min(300, dy)) * 0.0015));
    }, { passive: false });
    cv.addEventListener('dblclick', resetZoom);
    cv.addEventListener('keydown', function (e) {
        var k = e.key, span = V.to - V.from, g = V.geo;
        if (k === 'ArrowLeft' || k === 'ArrowRight') { var d = (k === 'ArrowLeft' ? -0.1 : 0.1) * span; setView(V.from + d, V.to + d, false); }
        else if (k === '+' || k === '=') zoomAt(g ? g.plot.x + g.plot.w / 2 : 0, 0.8);
        else if (k === '-' || k === '_') zoomAt(g ? g.plot.x + g.plot.w / 2 : 0, 1.25);
        else if (k === '0' || k === 'Home') resetZoom();
        else return;
        if (e.preventDefault) e.preventDefault();
    });
}
function exportPNG() {
    var cv = $('hist_cv');
    if (!cv || !hasDoc()) return false;
    var sz = cvSize(cv), out = document.createElement('canvas'), dpr = sz.dpr, H = sz.h + 44;
    out.width = Math.round(sz.w * dpr); out.height = Math.round(H * dpr);
    var ctx = out.getContext && out.getContext('2d');
    if (!ctx) return false;
    if (typeof ctx.setTransform === 'function') ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = INK.bg; ctx.fillRect(0, 0, sz.w, H);
    ctx.fillStyle = INK.text; ctx.font = '600 13px -apple-system, "Segoe UI", Roboto, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('Historian trend — ' + fmtLocal(V.from) + ' to ' + fmtLocal(V.to), 8, 6);
    ctx.font = '11px -apple-system, "Segoe UI", Roboto, sans-serif';
    var x = 8;
    trendSeries().forEach(function (s) {
        ctx.fillStyle = colorOf(s.tag); ctx.fillRect(x, 26, 10, 10);
        ctx.fillStyle = INK.text2;
        var label = s.tag + (s.unit ? ' (' + s.unit + ')' : '');
        ctx.fillText(label, x + 14, 25);
        x += 24 + (ctx.measureText ? ctx.measureText(label).width : label.length * 6);
    });
    ctx.drawImage(cv, 0, 44, sz.w, sz.h);
    var url = out.toDataURL('image/png'), a = document.createElement('a');
    a.href = url; a.download = fileStamp('png', 'historian-trend'); a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a); a.click();
    if (a.parentNode) a.parentNode.removeChild(a);
    return true;
}
function toggleTag(tag) {
    var i = V.tags.indexOf(tag);
    if (i >= 0) { V.tags.splice(i, 1); delete V.slots[tag]; }
    else {
        if (V.tags.length >= MAX_TREND_TAGS) { setMsg('hist_tbl_msg', null, 'Up to ' + MAX_TREND_TAGS + ' tags on the trend — use the table or an export for more.'); return; }
        V.tags.push(tag); assignSlot(tag);
    }
    saveView();
    refreshTags().then(function () { requestDraw(); scheduleTrend(0); scheduleTable(0); });
}

// ── table ──
function scheduleTable(ms) {
    if (V.tbl.timer !== null) clearTimeout(V.tbl.timer);
    V.tbl.timer = setTimeout(function () { V.tbl.timer = null; buildTable(); }, ms || 0);
}
var TABLE_MAX = 200000;
function buildTable() {
    var wrap = $('hist_table_wrap');
    if (!wrap) return Promise.resolve();
    var seq = ++V.tbl.seq, tags = (V.tags || []).slice(), mode = V.tbl.mode;
    if (!tags.length) { wrap.innerHTML = '<div class="hist-muted">Select tags on the trend to list their values.</div>'; var pi0 = $('hist_pageinfo'); if (pi0) pi0.textContent = ''; return Promise.resolve(); }
    var o = { tags: tags, from: V.from, to: V.to, agg: mode };
    if (mode !== 'raw') o.bucketMs = V.tbl.bucket > 0 ? V.tbl.bucket : niceBucket(Math.max(1, V.to - V.from) / 500);
    return query(o).then(function (res) {
        if (seq !== V.tbl.seq || !$('hist_table_wrap')) return;
        var total = 0;
        res.series.forEach(function (s) { total += s.t.length; });
        if (total > TABLE_MAX) {
            V.tbl.rows = []; V.tbl.series = res.series;
            $('hist_table_wrap').innerHTML = '<div style="color:var(--yellow)">&#9888; ' + fmtCount(total) + ' samples in this range — choose a bucketed table, a shorter range, or export the data.</div>';
            return;
        }
        var map = {}, times = [];
        res.series.forEach(function (s, k) {
            for (var i = 0; i < s.t.length; i++) {
                var t = s.t[i], r = map[t];
                if (!r) { r = map[t] = { t: t, c: new Array(tags.length) }; times.push(t); }
                r.c[k] = { v: s.v[i], q: s.q[i], roll: s.rollup ? s.rollup[i] : 0 };
            }
        });
        var rows = times.map(function (t) { return map[t]; });
        if (V.tbl.qf === 'good') {
            rows.forEach(function (r) { for (var k = 0; k < r.c.length; k++) { var c = r.c[k]; if (c && (c.q !== 0 || c.v === null)) r.c[k] = undefined; } });
            rows = rows.filter(function (r) { return r.c.some(Boolean); });
        } else if (V.tbl.qf === 'issues') rows = rows.filter(function (r) { return r.c.some(function (c) { return c && (c.q !== 0 || c.v === null); }); });
        rows.sort(function (a, b) { return V.tbl.desc ? b.t - a.t : a.t - b.t; });
        V.tbl.rows = rows; V.tbl.series = res.series; V.tbl.bucketMs = res.bucketMs;
        V.tbl.page = Math.max(0, Math.min(V.tbl.page, Math.ceil(rows.length / V.tbl.size) - 1));
        renderTablePage();
    }).catch(function (e) { var w = $('hist_table_wrap'); if (w) w.innerHTML = '<div style="color:var(--red)">&#10007; ' + esc(errMsg(e)) + '</div>'; });
}
function cellHtml(c) {
    if (!c) return '<td></td>';
    if (c.v === null || c.v === undefined || c.q === 2) return '<td class="q-bad" title="bad / no value">&#10007;</td>';
    return '<td' + (c.q === 1 ? ' class="q-stale" title="stale value"' : '') + '>' + esc(fmtVal(c.v)) + (c.q === 1 ? ' &#9676;' : '') + (c.roll ? ' &#8224;' : '') + '</td>';
}
function renderTablePage() {
    var wrap = $('hist_table_wrap');
    if (!wrap) return;
    var rows = V.tbl.rows || [], series = V.tbl.series || [], a = V.tbl.page * V.tbl.size, b = Math.min(rows.length, a + V.tbl.size);
    var h = '<table class="dtable" id="hist_table"><thead><tr><th><button type="button" class="hist-sort" id="hist_sort_btn" aria-label="Sort by time">Time ' +
        (V.tbl.desc ? '&#8595;' : '&#8593;') + '</button></th>' + series.map(function (s) { return '<th>' + esc(s.tag) + (s.unit ? ' (' + esc(s.unit) + ')' : '') + '</th>'; }).join('') + '</tr></thead><tbody>';
    for (var i = a; i < b; i++) {
        var r = rows[i], cells = '';
        for (var k = 0; k < series.length; k++) cells += cellHtml(r.c[k]);
        h += '<tr><td>' + esc(fmtLocal(r.t, V.tbl.mode === 'raw')) + '</td>' + cells + '</tr>';
    }
    if (!rows.length) h += '<tr><td colspan="' + (series.length + 1) + '">No rows in this time range.</td></tr>';
    wrap.innerHTML = h + '</tbody></table>';
    var pi = $('hist_pageinfo');
    if (pi) pi.textContent = rows.length ? 'Rows ' + fmtCount(a + 1) + '–' + fmtCount(b) + ' of ' + fmtCount(rows.length) +
        (V.tbl.mode !== 'raw' ? ' · ' + V.tbl.mode + ' per ' + bucketLabel(V.tbl.bucketMs) : '') : '';
}
function tableTSV(limit) {
    var rows = V.tbl.rows || [], series = V.tbl.series || [], n = Math.min(rows.length, limit || 50000);
    var lines = [['time_local'].concat(series.map(function (s) { return s.tag + (s.unit ? ' [' + s.unit + ']' : ''); })).join('\t')];
    for (var i = 0; i < n; i++) {
        var r = rows[i];
        lines.push([fmtLocal(r.t, true)].concat(series.map(function (s, k) { var c = r.c[k]; return c && c.v !== null && c.q !== 2 ? String(c.v) : ''; })).join('\t'));
    }
    return { text: lines.join('\n') + '\n', rows: n, total: rows.length };
}
function copyTable() {
    var x = tableTSV(50000), nav = G.navigator;
    var done = function (ok) { setMsg('hist_tbl_msg', ok, ok ? 'Copied ' + fmtCount(x.rows) + ' rows' + (x.total > x.rows ? ' (of ' + fmtCount(x.total) + ')' : '') + ' to the clipboard.' : 'The clipboard is not available here.'); };
    if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') return nav.clipboard.writeText(x.text).then(function () { done(true); }, function () { done(false); });
    done(false);
    return Promise.resolve();
}

// ── export / restore / settings actions ──
function val(sel) { var e = pageEl(sel); return e ? e.value : ''; }
function doExport() {
    var fmt = val('[data-h="xfmt"]') || 'csv', range = val('[data-h="xrange"]'), tagsSel = val('[data-h="xtags"]'), agg = val('[data-h="xagg"]') || 'raw';
    var o = { tags: tagsSel === 'all' ? undefined : (V.tags || []).slice(), agg: agg, skipEmpty: true };
    if (range !== 'all') { o.from = V.from; o.to = V.to; }
    if (o.tags && !o.tags.length) { setMsg('hist_io_res', false, 'No tags selected on the trend — choose “All tags” or select tags.'); return Promise.resolve(); }
    setMsg('hist_io_res', null, 'Exporting…');
    var p = fmt === 'csv' ? exportCSV(o) : fmt === 'csvwide' ? exportCSV(Object.assign(o, { layout: 'wide' })) : fmt === 'xlsx' ? exportXLSX(o)
        : exportDb({ format: fmt === 'json' ? 'json' : 'sqlite' });
    return p.then(function (r) {
        if (r && r.empty) { setMsg('hist_io_res', false, 'No samples to export' + (range !== 'all' ? ' in the time window shown' : '') + (o.tags ? ' for the selected tags' : '') + ' — nothing was downloaded.'); return; }
        setMsg('hist_io_res', true, 'Exported ' + (r.rows !== undefined ? fmtCount(r.rows) + ' rows' : fmtBytes(r.size)) + ' to ' + r.filename + '.');
    }, function (e) { setMsg('hist_io_res', false, errMsg(e)); });
}
function doImport() {
    var inp = pageEl('[data-h="file"]'), f = inp && inp.files && inp.files[0];
    if (!f) { setMsg('hist_io_res', false, 'Choose a file to restore first.'); return Promise.resolve(); }
    var mode = val('[data-h="imode"]') === 'replace' ? 'replace' : 'merge', dup = val('[data-h="idup"]') === 'overwrite' ? 'overwrite' : 'skip';
    if (mode === 'replace' && typeof G.confirm === 'function' && !G.confirm('Replace ALL historian data with the contents of ' + f.name + '? Export a backup first if you may need the current data.')) return Promise.resolve();
    setMsg('hist_io_res', null, 'Restoring ' + f.name + '…');
    return importFile(f, { mode: mode, dup: dup }).then(function (r) {
        var t = 'Restored ' + r.file + ' (' + r.format + '): ' + fmtCount(r.inserted) + ' new samples' + (r.updated ? ', ' + fmtCount(r.updated) + ' overwritten' : '') +
            (r.skipped ? ', ' + fmtCount(r.skipped) + ' already stored (kept)' : '') + (r.rollups ? ', ' + fmtCount(r.rollups) + ' 1-min rollups' : '') +
            '; ' + r.tags + ' tags (' + r.tagsCreated + ' new)' + (r.invalid ? '; ' + fmtCount(r.invalid) + ' rows skipped as invalid' : '') +
            (r.from !== null ? '; ' + fmtLocal(r.from) + ' to ' + fmtLocal(r.to) : '') + '.';
        setMsg('hist_io_res', true, t);
        if (r.olderThanRetention) {
            var el = $('hist_io_res');
            if (el) el.innerHTML += '<div style="color:var(--yellow)">&#9888; ' + fmtCount(r.olderThanRetention) + ' restored samples are older than the retention period and will be deleted at the next retention run — raise “Keep data for” first to keep them.</div>';
        }
        if (inp) try { inp.value = ''; } catch (e) {}
        return refreshAll();
    }, function (e) { setMsg('hist_io_res', false, errMsg(e)); });
}
function applyRetention() {
    var o = { days: val('[data-h="days"]'), downsampleAfterDays: val('[data-h="dsdays"]'), maxRows: val('[data-h="maxrows"]') };
    return setRetention(o).then(function (r) {
        var x = r.result || {};
        setMsg('hist_set_msg', true, 'Retention saved. This run: ' + fmtCount(x.deleted + x.deletedRollups) + ' old rows deleted, ' + fmtCount(x.rolledUp + x.capped) + ' raw samples downsampled or capped.');
        return refreshAll();
    }, function (e) { setMsg('hist_set_msg', false, errMsg(e)); });
}
function doSwitchEngine() {
    var to = val('[data-h="engine"]') || 'auto';
    if (to !== 'auto' && to !== E.engine && typeof G.confirm === 'function' && !G.confirm('Move all historian data from ' + ENGINE_LABEL[E.engine] + ' to ' + ENGINE_LABEL[to] + '?')) return Promise.resolve();
    setMsg('hist_set_msg', null, 'Switching the storage engine…');
    return switchEngine(to).then(function (r) {
        setMsg('hist_set_msg', true, to === 'auto' ? 'Engine choice set to automatic (current: ' + ENGINE_LABEL[r.engine] + ').' :
            'Now using ' + ENGINE_LABEL[r.engine] + (r.moved ? '; moved ' + fmtCount(r.moved) + ' samples and ' + fmtCount(r.rollups) + ' rollups.' : '.'));
        return refreshAll();
    }, function (e) { setMsg('hist_set_msg', false, 'Could not switch: ' + errMsg(e)); });
}
function requestPersist() {
    var st = G.navigator && G.navigator.storage;
    if (!st || typeof st.persist !== 'function') { setMsg('hist_set_msg', false, 'This browser does not offer persistent storage.'); return Promise.resolve(false); }
    return st.persist().then(function (ok) {
        setMsg('hist_set_msg', ok, ok ? 'Persistent storage granted — the browser will not clear this data under storage pressure.' : 'The browser declined persistent storage (it may grant it later, e.g. after the site is installed or bookmarked).');
        refreshStatus();
        return ok;
    }, function (e) { setMsg('hist_set_msg', false, errMsg(e)); return false; });
}
function doPurge(all) {
    var before = all ? null : parseTime(val('[data-h="pbefore"]')), which = val('[data-h="ptags"]');
    if (!all && !isFinite(before)) { setMsg('hist_set_msg', false, 'Enter the “Purge data older than” date first.'); return Promise.resolve(); }
    var tags = all || which === 'all' ? undefined : (V.tags || []).slice();
    if (!all && tags && !tags.length) { setMsg('hist_set_msg', false, 'No tags selected on the trend.'); return Promise.resolve(); }
    var q = all ? 'Delete ALL historian data (every tag, sample and rollup)? This cannot be undone.' :
        'Delete ' + (tags ? tags.length + ' selected tag(s)' : 'all tags') + ' data older than ' + fmtLocal(before) + '?';
    if (typeof G.confirm === 'function' && !G.confirm(q)) return Promise.resolve();
    return purge(all ? { all: true } : { before: before, tags: tags }).then(function (r) {
        setMsg('hist_set_msg', true, 'Deleted ' + fmtCount(r.samples) + ' samples and ' + fmtCount(r.rollups) + ' rollups.');
        return refreshAll();
    }, function (e) { setMsg('hist_set_msg', false, errMsg(e)); });
}
function wire(root) {
    root.addEventListener('click', function (e) {
        var b = e.target && e.target.closest ? e.target.closest('button') : null;
        if (!b || !root.contains(b)) return;
        var sg = b.parentNode && b.parentNode.getAttribute ? b.parentNode.getAttribute('data-seg') : null;
        if (sg) { onRange(b.getAttribute('data-v')); return; }
        if (b.hasAttribute('data-tag')) { toggleTag(b.getAttribute('data-tag')); return; }
        switch (b.id) {
            case 'hist_modbus_btn': case 'hist_modbus_btn2': goModbus(); break;
            case 'hist_demo_btn': if (DEMOLIVE.timer !== null) demoStop(); else { demoStart(); if (V.tags && !V.tags.length) V.tags = null; } break;
            case 'hist_demohist_btn': b.disabled = true; demoHistory(24, 10000).then(function (n) { b.disabled = false; if (V.tags && !V.tags.length) V.tags = null; setMsg('hist_set_msg', true, 'Added ' + fmtCount(n) + ' demo samples (24 h at 10 s, tags DEMO.*).'); return refreshAll(); }, function (er) { b.disabled = false; setMsg('hist_set_msg', false, errMsg(er)); }); break;
            case 'hist_refresh_btn': G.calcHistorian(); break;
            case 'hist_live_btn': if (V.live) { V.live = false; updateButtons(); saveView(); } else { var sp = V.to - V.from; var n = Date.now(); setView(n - sp, n, true, true); } break;
            case 'hist_custom_apply': applyCustom(); break;
            case 'hist_reset_btn': resetZoom(); break;
            case 'hist_png_btn': exportPNG(); break;
            case 'hist_prev_btn': if (V.tbl.page > 0) { V.tbl.page--; renderTablePage(); } break;
            case 'hist_next_btn': if ((V.tbl.page + 1) * V.tbl.size < (V.tbl.rows || []).length) { V.tbl.page++; renderTablePage(); } break;
            case 'hist_sort_btn': V.tbl.desc = !V.tbl.desc; (V.tbl.rows || []).reverse(); V.tbl.page = 0; renderTablePage(); saveView(); break;
            case 'hist_copy_btn': copyTable(); break;
            case 'hist_export_btn': doExport(); break;
            case 'hist_import_btn': doImport(); break;
            case 'hist_ret_btn': applyRetention(); break;
            case 'hist_engine_btn': doSwitchEngine(); break;
            case 'hist_persist_btn': requestPersist(); break;
            case 'hist_purge_btn': doPurge(false); break;
            case 'hist_clear_btn': doPurge(true); break;
            default: break;
        }
    });
    root.addEventListener('change', function (e) {
        var el = e.target, h = el && el.getAttribute ? el.getAttribute('data-h') : null;
        if (!h) return;
        if (h === 'logform') setFormLogging(!!el.checked);
        else if (h === 'agg') { V.agg = el.value; saveView(); scheduleTrend(0); }
        else if (h === 'layout') { V.layout = el.value === 'overlay' ? 'overlay' : 'stacked'; saveView(); requestDraw(); }
        else if (h === 'tmode') { V.tbl.mode = AGGS.indexOf(el.value) >= 0 ? el.value : 'raw'; V.tbl.page = 0; saveView(); scheduleTable(0); }
        else if (h === 'tbucket') { V.tbl.bucket = Math.max(0, +el.value || 0); V.tbl.page = 0; saveView(); scheduleTable(0); }
        else if (h === 'tq') { V.tbl.qf = el.value; V.tbl.page = 0; saveView(); scheduleTable(0); }
        else if (h === 'tps') { V.tbl.size = [50, 100, 500].indexOf(+el.value) >= 0 ? +el.value : 100; V.tbl.page = 0; saveView(); renderTablePage(); }
    });
    wireCanvas($('hist_cv'));
}
function render(body) {
    ensureCss();
    loadView();
    body.innerHTML = pageHtml();
    var root = $('hist_root');
    if (root) wire(root);
    if (V.live || !(V.to > V.from)) { var now = Date.now(); V.to = now; V.from = now - presetMs(V.preset === 'custom' || V.preset === 'zoom' ? V.lastPreset : V.preset); }
    updateButtons();
    drawTrend();
    G.calcHistorian();
}
G.calcHistorian = function () { return refreshAll(); };

// ─── §10 events, API, registry ───────────────────────────────────────
function onHide() {
    if (E.dirty) persistNow(true);                                     // what is written already, at once
    if (E.buf.length) flush().then(function () { return E.dirty ? persistNow(true) : null; }).catch(noop);   // then the last buffered samples
}
function onUpdated() {
    if (!pageMounted() || V.liveTimer !== null) return;
    V.liveTimer = setTimeout(function () {                   // at most one refresh a second, only while data arrives
        V.liveTimer = null;
        if (!pageMounted()) return;
        if (V.live) { var span = V.to - V.from; V.to = Date.now(); V.from = V.to - span; }
        fetchTrend(); refreshTags(); refreshStatus().catch(noop);
        scheduleTable(0);
    }, 1000);
}
if (hasDoc() && typeof document.addEventListener === 'function') {
    document.addEventListener('wts:modbus-samples', function (e) { var d = e && e.detail; if (d) record(d); });
    document.addEventListener('wts:calc', function (e) { if (FORM.on) record(formSamples(e && e.detail, Date.now())); });
    document.addEventListener('wts:historian-updated', onUpdated);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') onHide(); });
    document.addEventListener('app-backgrounded', onHide);
}
if (typeof G.addEventListener === 'function') {
    G.addEventListener('pagehide', onHide);
    G.addEventListener('resize', function () { if (pageMounted()) requestDraw(); });
}

var API = {
    version: '1.0.0',
    record: record,
    flush: function () { return flush(); },
    ready: function () { return ensureStore().then(status); },
    query: query, listTags: listTags, stats: stats, status: status,
    exportCSV: exportCSV, exportXLSX: exportXLSX, exportDb: exportDb, importFile: importFile,
    purge: purge, setRetention: setRetention,
    getRetention: function () { var s = getSettings(); return { days: s.days, maxRows: s.maxRows, downsampleAfterDays: s.downsampleAfterDays }; },
    engine: function () { return { engine: E.engine, label: E.engine ? ENGINE_LABEL[E.engine] : null, home: E.home, spoolFor: E.spoolFor, preference: getSettings().engine, reasons: E.reasons.slice() }; },
    switchEngine: switchEngine,
    persist: function () { return persistNow(); },
    demo: { start: demoStart, stop: demoStop, history: demoHistory, running: function () { return DEMOLIVE.timer !== null; } },
    logForm: setFormLogging,
    util: { aggregate: aggArrays, mergePartials: mergePartials, lttb: lttbIdx, decimate: decimate, niceBucket: niceBucket, parseDelimited: parseDelimited,
        rowsToImport: rowsToImport, parseTime: parseTime, csvLine: csvLine, qCode: qCode, normSample: normSample, formSamples: formSamples, demoBatch: demoBatch, lcg: lcg },
    LIBS: LIBS, SHA384: HIST_SHA384, ENGINES: ENGINES.slice(), ENGINE_LABEL: ENGINE_LABEL, ROLLUP_MS: ROLLUP_MS,
    _test: T,
    _internal: { E: E, V: V, workerSource: workerSource, HistSqlStore: HistSqlStore, histSqlJsAdapter: histSqlJsAdapter, histWasmAdapter: histWasmAdapter,
        histWorkerMain: histWorkerMain, IdbStore: IdbStore, MemStore: MemStore, WorkerStore: WorkerStore, asyncStore: asyncStore, copyStore: copyStore,
        fetchVerified: fetchVerified, loadSqlJs: loadSqlJs, trendData: trendData, drawTrend: drawTrend, buildTable: buildTable, fetchTrend: fetchTrend,
        refreshAll: refreshAll, runRetention: function () { return lock(runRetention); }, tableTSV: tableTSV, exportPNG: exportPNG, setView: setView, zoomAt: zoomAt }
};
var prevApi = G.WTS_historian;
G.WTS_historian = API;
if (prevApi && Array.isArray(prevApi._queue) && prevApi._queue.length) record(prevApi._queue);   // samples an early caller queued before this file loaded
publishState();

G.WTS_calcRegistry = G.WTS_calcRegistry || {};
G.WTS_calcRegistry.historian = {
    key: 'historian', title: 'Historian', navTitle: 'Historian',
    sub: 'Record, trend, tabulate and export tag data — SQLite in the browser',
    group: 'Mini WellOS', icon: '&#128200;', badge: 'WellOS', bc: 'dc-b-blue',
    desc: 'Trends and tables of Modbus, form and simulator data with retention, CSV / Excel export and database backup / restore.',
    render: render
};
})();

// ─── END 47-calc-historian ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 48-calc-wellkill ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════
// WTS — Round-9 plug-in calculator — Well Kill & Bullhead (wellkill)
//
// PURPOSE
//   A. Kill-weight fluid from reservoir pressure and top-perforation TVD
//      with an overbalance (ppg, SG, kg/m³, gradient).
//   B. Bullhead volume per string section (tubing to the packer, casing or
//      liner below the packer to the top perforation, perforated interval,
//      rathole to PBTD) from the shared tubular table (40-calc-tubulars.js,
//      window.WTS_tubulars), plus over-displacement, pump strokes and time,
//      and a static pumping schedule.
//   C. Maximum static surface pressure against the fracture gradient at the
//      perforations (and at the casing shoe when entered), at the start and
//      the end of the bullhead, with verdicts.
//   D. U-tube check at the packer / circulating point and the static fluid
//      level if the formation takes fluid.
//   E. Clear-brine selection guide (guidance values).
//   F. Liquid / mixed gradient card: static liquid column, gas cap with an
//      average-Z gas gradient and a mixed gas/liquid column, surface ↔
//      bottomhole conversion (window.WTS_gradient_compute).
//
// UNITS
//   Field units throughout: psi, ft (MD / TVD), ppg, bbl, bbl/stroke, °F.
//   Hydrostatic constant 0.052 psi/ft per ppg (API well-control convention);
//   SG = ppg / 8.33; kg/m³ = ppg × 119.826. The units layer converts tagged
//   inputs, so the calc always reads imperial values.
//
// PUBLIC API (window.*)
//   renderWellKill(body)          paints the page into #pgBody
//   calcWellKill()                reads the DOM, validates, computes, renders (both cards)
//   WTS_wellkill_compute(input)   → {ok, kill, bullhead, limits, utube, brines, …} or {ok:false, errors, bad}
//   WTS_gradient_compute(input)   → {ok, pSurf, pBot, sections[], avgGrad, …} or {ok:false, errors, bad}
//   WTS_wellkill_brines           the brine guide rows
//
// STATE
//   WTS_state.wellkill = {kwf, kwfUsed, bullheadVol, pumpedVol, strokes, maspStart, maspEnd, ts, result}
//   WTS_state.gradient = {pSurf, pBot, avgGrad, ts, result}
//
// Registers window.WTS_calcRegistry.wellkill (group "Test System Safety").
// ════════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    var G = (typeof window !== 'undefined') ? window : globalThis;

    // ── Constants ────────────────────────────────────────────────────
    var HYD = 0.052;                  // psi/ft per ppg
    var PPG_PER_SG = 8.33;            // fresh water, ppg
    var KGM3_PER_PPG = 119.826;       // kg/m³ per ppg
    var PSIFT_TO_KPAM = 6.894757 / 0.3048;   // 22.6206 kPa/m per psi/ft
    var PATM = 14.696;                // psia
    // Gas gradient: dp/dh = P·M/(Z·R·T)/144, M = 28.9647·SG, R = 10.7316 → 0.018743·SG·P/(Z·T)
    var GAS_C = 28.9647 / (10.7316 * 144);
    var K_CAP = Math.PI / 4 * 12 / 9702;       // bbl/ft per in² (fallback if WTS_tubulars is absent)
    var WINDOW_FRAC = 0.10;           // ⚠ when the start bullhead window is below 10 % of fracture pressure

    // Clear-brine guide: typical maximum density at surface temperature (about 70 °F),
    // conservative published values. Guidance only.
    var BRINES = [
        { name: 'Fresh water', short: 'fresh water', ppg: 8.33, note: 'Freezes at 32 °F. Clay swelling without an inhibitor.' },
        { name: 'Seawater', short: 'seawater', ppg: 8.55, note: 'Filter it. Sulphate scale risk with some formation waters.' },
        { name: 'Potassium chloride, KCl', short: 'KCl', ppg: 9.7, note: 'Clay and shale inhibition. Salt crystallises out as it cools near saturation.' },
        { name: 'Sodium chloride, NaCl', short: 'NaCl', ppg: 10.0, note: 'Low cost. Check the crystallisation temperature near saturation.' },
        { name: 'Sodium formate', short: 'Na formate', ppg: 11.0, note: 'Low corrosion, biodegradable. Higher cost.' },
        { name: 'Calcium chloride, CaCl2', short: 'CaCl2', ppg: 11.6, note: 'Heats up when mixed. Scale risk with sulphate or carbonate formation water.' },
        { name: 'Sodium bromide, NaBr', short: 'NaBr', ppg: 12.5, note: 'Use where calcium is incompatible with the formation water.' },
        { name: 'Potassium formate', short: 'K formate', ppg: 13.1, note: 'Low corrosion, good elastomer compatibility. High cost.' },
        { name: 'Calcium bromide, CaBr2', short: 'CaBr2', ppg: 14.2, note: 'Standard stock fluid. Heavier blends raise the crystallisation temperature.' },
        { name: 'CaCl2 / CaBr2 blend', short: 'CaCl2/CaBr2', ppg: 15.1, note: 'Crystallisation temperature set by the blend ratio. Confirm with the supplier.' },
        { name: 'Cesium formate', short: 'Cs formate', ppg: 19.2, note: 'Very high cost, often rented. Low corrosion.' },
        { name: 'ZnBr2 / CaBr2 blend', short: 'ZnBr2/CaBr2', ppg: 19.2, note: 'Corrosive and acidic. Handling hazard. Zinc discharge restricted. Check elastomers.' }
    ];
    BRINES.forEach(function (b) { b.sg = b.ppg / PPG_PER_SG; b.kgm3 = b.ppg * KGM3_PER_PPG; });

    // ── Helpers ─────────────────────────────────────────────────────
    function _byId(id) { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }
    function _num(id) { var e = _byId(id); if (!e) return NaN; var s = String(e.value).trim(); return s === '' ? NaN : parseFloat(s); }
    function _str(id) { var e = _byId(id); return e ? String(e.value) : ''; }
    function _fmt(v, d) {
        if (v == null || !isFinite(v)) return '—';
        return (G.WTS_fmtNum ? G.WTS_fmtNum(v, 0, (d == null ? 2 : d)) : Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: (d == null ? 2 : d) }));
    }
    function _fixed(v, d) {
        if (v == null || !isFinite(v)) return '—';
        return (G.WTS_fmtNum ? G.WTS_fmtNum(v, d, d) : Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
    }
    function _metric() { var U = G.WTS_units; return !!(U && U.getSystem && U.getSystem() === 'metric'); }
    // value in the display system; impLabel is the imperial text
    function _u(v, cat, d, impLabel, dMet) {
        var U = G.WTS_units;
        if (_metric() && U.format) {
            var f = U.format(v, cat);
            return _fmt(f.value, dMet == null ? d : dMet) + ' ' + f.label;
        }
        return _fmt(v, d) + ' ' + impLabel;
    }
    function _grad(psiFt) { return _metric() ? _fmt(psiFt * PSIFT_TO_KPAM, 3) + ' kPa/m' : _fmt(psiFt, 4) + ' psi/ft'; }
    function _tag(map) { var U = G.WTS_units; if (!U || !U.tagInput) return; for (var id in map) U.tagInput(id, map[id]); }
    function _canon(fn) { var U = G.WTS_units; return (U && U.runCanonical) ? U.runCanonical(fn) : fn(); }
    function _fin(x) { return typeof x === 'number' && isFinite(x); }
    function _blank(x) { return x == null || x === '' || (typeof x === 'number' && (isNaN(x) || x === 0)); }
    function _tub(key) {
        var T = G.WTS_tubulars;
        return (T && T.find) ? T.find(String(key)) : null;
    }
    function _cap(idIn) {
        var T = G.WTS_tubulars;
        return (T && T.capacity) ? T.capacity(idIn) : idIn * idIn * K_CAP;
    }

    // ── Pure compute: kill & bullhead ───────────────────────────────
    // input = {pres, tvd, ob, kwo, fg, wf, ann, stvd, sfg, tub, cas, pmd, ptvd, tmd, bmd, pbtd, to, od, pump, spm}
    //   pres psi at top perfs; tvd = top-perforation TVD ft; ob psi; kwo ppg (blank/0 → calculated
    //   kill weight rounded up to 0.1 ppg); fg, sfg fracture gradient EMW ppg; wf = well fluid EMW ppg
    //   before the kill; ann = annulus fluid ppg; stvd shoe TVD ft (blank/0 → no shoe check);
    //   tub / cas = WTS_tubulars keys; pmd/ptvd packer MD/TVD; tmd/bmd top/bottom perf MD; pbtd MD;
    //   to = 'top' | 'bot' | 'pbtd' (displace to); od over-displacement %; pump bbl/stroke; spm (blank → no time).
    function wellkill(input) {
        var i = input || {}, errors = [], bad = [];
        function need(ok, key, msg) { if (!ok) { errors.push(msg); bad.push(key); } return ok; }
        var pres = Number(i.pres), tvd = Number(i.tvd), ob = Number(i.ob), fg = Number(i.fg), wf = Number(i.wf), ann = Number(i.ann);
        var kwo = _blank(i.kwo) ? null : Number(i.kwo);
        var stvd = _blank(i.stvd) ? null : Number(i.stvd);
        var sfg = _blank(i.sfg) ? null : Number(i.sfg);
        var pmd = Number(i.pmd), ptvd = Number(i.ptvd), tmd = Number(i.tmd), bmd = Number(i.bmd), pbtd = Number(i.pbtd);
        var od = Number(i.od), pump = Number(i.pump);
        var spm = _blank(i.spm) ? null : Number(i.spm);
        var tpmd = _blank(i.tpmd) ? null : Number(i.tpmd);             // tailpipe (WLEG) MD, blank = none
        var mu = _blank(i.mu) ? 2 : Number(i.mu), rough = (i.rough === '' || i.rough == null || (typeof i.rough === 'number' && isNaN(i.rough))) ? 0.0018 : Number(i.rough);
        var to = (i.to === 'bot' || i.to === 'pbtd') ? i.to : 'top';
        var tub = _tub(i.tub), cas = _tub(i.cas);

        need(_fin(pres) && pres > 0 && pres <= 30000, 'pres', 'Reservoir pressure must be above 0 and no more than 30,000 psi.');
        var tvdOk = need(_fin(tvd) && tvd > 0 && tvd <= 40000, 'tvd', 'Top perforation TVD must be above 0 and no more than 40,000 ft.');
        need(_fin(ob) && ob >= 0 && ob <= 5000, 'ob', 'Overbalance must be between 0 and 5,000 psi.');
        if (kwo != null) need(_fin(kwo) && kwo >= 6 && kwo <= 25, 'kwo', 'Kill fluid density to use must be between 6 and 25 ppg, or blank.');
        var wfOk = need(_fin(wf) && wf >= 0 && wf < 25, 'wf', 'Well fluid density must be 0 ppg or more and below 25 ppg.');
        need(_fin(fg) && fg >= 6 && fg <= 25 && (!wfOk || fg > wf), 'fg', 'Fracture gradient must be between 6 and 25 ppg EMW and above the well fluid density.');
        need(_fin(ann) && ann > 0 && ann <= 25, 'ann', 'Annulus fluid density must be above 0 and no more than 25 ppg.');
        if (stvd != null) need(_fin(stvd) && stvd > 0 && (!tvdOk || stvd <= tvd), 'stvd', 'Casing shoe TVD must be above 0 and no deeper than the top perforation TVD, or blank.');
        if (stvd != null) need(sfg != null && _fin(sfg) && sfg >= 6 && sfg <= 25 && (!wfOk || sfg > wf), 'sfg', 'Shoe fracture gradient must be between 6 and 25 ppg EMW and above the well fluid density.');
        var tubOk = need(!!tub, 'tub', 'Select a tubing size.');
        var casOk = need(!!cas, 'cas', 'Select a casing or liner size.');
        if (tubOk && casOk) need(tub.od < cas.id, 'tub', 'Tubing OD does not fit inside the casing / liner ID.');
        var pmdOk = need(_fin(pmd) && pmd > 0 && pmd <= 50000, 'pmd', 'Packer MD must be above 0 and no more than 50,000 ft.');
        need(_fin(ptvd) && ptvd > 0 && (!pmdOk || ptvd <= pmd + 1e-6) && (!tvdOk || ptvd <= tvd + 1e-6), 'ptvd', 'Packer TVD must be above 0, no more than the packer MD and no deeper than the top perforation TVD.');
        var tmdOk = need(_fin(tmd) && (!pmdOk || tmd >= pmd) && (!tvdOk || tmd >= tvd - 1e-6) && tmd <= 50000, 'tmd', 'Top perforation MD must be at or below the packer MD and not less than the top perforation TVD.');
        var bmdOk = need(_fin(bmd) && (!tmdOk || bmd >= tmd) && bmd <= 50000, 'bmd', 'Bottom perforation MD must be at or below the top perforation MD.');
        need(_fin(pbtd) && (!bmdOk || pbtd >= bmd) && pbtd <= 50000, 'pbtd', 'PBTD must be at or below the bottom perforation MD.');
        need(_fin(od) && od >= 0 && od <= 100, 'od', 'Over-displacement must be between 0 and 100 %.');
        need(_fin(pump) && pump >= 0.001 && pump <= 2, 'pump', 'Pump output must be between 0.001 and 2 bbl per stroke.');
        if (spm != null) need(_fin(spm) && spm >= 1 && spm <= 300, 'spm', 'Pump speed must be between 1 and 300 strokes per minute, or blank.');
        if (tpmd != null) need(_fin(tpmd) && (!pmdOk || tpmd > pmd) && (!tmdOk || tpmd <= tmd), 'tpmd', 'Tailpipe end MD must be below the packer MD and no deeper than the top perforation MD, or blank.');
        need(_fin(mu) && mu >= 0.3 && mu <= 100, 'mu', 'Kill fluid viscosity must be between 0.3 and 100 cp.');
        need(_fin(rough) && rough >= 0 && rough <= 0.01, 'rough', 'Pipe roughness must be between 0 and 0.01 in.');
        if (errors.length) return { ok: false, errors: errors, bad: bad };

        // A. Kill fluid
        var balance = pres / (HYD * tvd);
        var obPpg = ob / (HYD * tvd);
        var kwf = (pres + ob) / (HYD * tvd);
        var auto = kwo == null;
        var used = auto ? Math.ceil(kwf * 10 - 1e-9) / 10 : kwo;
        var grad = HYD * used;
        var hyd = grad * tvd;
        var kill = {
            balance: balance, obPpg: obPpg, kwf: kwf, used: used, auto: auto,
            sg: used / PPG_PER_SG, kgm3: used * KGM3_PER_PPG, grad: grad, gradKpaM: grad * PSIFT_TO_KPAM,
            kwfSg: kwf / PPG_PER_SG, kwfKgm3: kwf * KGM3_PER_PPG,
            hyd: hyd, obActual: hyd - pres,
            belowKwf: used < kwf - 1e-9, belowBalance: used < balance - 1e-9
        };

        // B. Bullhead volumes
        var tubCap = _cap(tub.id), casCap = _cap(cas.id);
        // With a tailpipe the fluid path below the packer is the tailpipe bore (tubing ID) down to
        // its end (WLEG), then the casing. The casing × tailpipe annulus below the packer is a dead
        // volume the bullhead does not sweep.
        var tpEnd = tpmd != null ? tpmd : pmd;
        var sections = [{ key: 'tubing', name: 'Tubing', from: 0, to: pmd, idIn: tub.id, cap: tubCap }];
        if (tpmd != null) sections.push({ key: 'tailpipe', name: 'Tailpipe below packer', from: pmd, to: tpEnd, idIn: tub.id, cap: tubCap });
        sections.push(
            { key: 'casing', name: tpmd != null ? 'Casing below tailpipe' : 'Casing below packer', from: tpEnd, to: tmd, idIn: cas.id, cap: casCap },
            { key: 'perfs', name: 'Perforated interval', from: tmd, to: bmd, idIn: cas.id, cap: casCap },
            { key: 'rathole', name: 'Rathole', from: bmd, to: pbtd, idIn: cas.id, cap: casCap });
        var nIn = (tpmd != null ? 1 : 0) + (to === 'top' ? 2 : to === 'bot' ? 3 : 4);
        var vol = 0;
        sections.forEach(function (s, k) {
            s.len = s.to - s.from; s.vol = s.len * s.cap; s.included = k < nIn;
            if (s.included) vol += s.vol;
        });
        var pumped = vol * (1 + od / 100);
        var strokes = pumped / pump;
        var bullhead = {
            sections: sections, to: to, vol: vol, extra: pumped - vol, pumped: pumped,
            strokes: strokes, minutes: spm ? strokes / spm : null, tubCap: tubCap, casCap: casCap,
            annCap: (cas.id * cas.id - tub.od * tub.od) * K_CAP,
            tailpipe: tpmd != null ? { md: tpmd, len: tpmd - pmd, vol: (tpmd - pmd) * tubCap,
                deadVol: (tpmd - pmd) * (cas.id * cas.id - tub.od * tub.od) * K_CAP } : null
        };

        // Friction at the pump rate, kill fluid in the flow path (Newtonian, user viscosity).
        // Bourgoyne et al., "Applied Drilling Engineering" (SPE Textbook 2, 1986), §4.6 pipe flow,
        // field units (ρ ppg, v ft/s, d in, μ cp, q gal/min, L ft):
        //   v = q / (2.448·d²),  NRe = 928·ρ·v·d/μ
        //   laminar (NRe < 2100): Fanning f = 16/NRe;  turbulent: Colebrook (1939) in Fanning form,
        //   1/√f = −4·log10(ε/(3.7·d) + 1.255/(NRe·√f))
        //   dp/dL = f·ρ·v² / (25.8·d)   (eq. 4.66a)
        var rate = spm ? pump * spm : null;                      // bbl/min
        var fric = null;
        function _fanning(nre, rr) {
            if (nre < 2100) return 16 / nre;
            var x = -4 * Math.log(rr / 3.7 + 5.74 / Math.pow(nre, 0.9)) / Math.LN10;   // 1/√f, Swamee–Jain start
            for (var k = 0; k < 60; k++) {
                var xn = -4 * Math.log(rr / 3.7 + 1.255 * x / nre) / Math.LN10;
                if (Math.abs(xn - x) < 1e-12) { x = xn; break; }
                x = xn;
            }
            return 1 / (x * x);
        }
        function _pipe(dIn, L) {
            var qg = rate * 42, v = qg / (2.448 * dIn * dIn), nre = 928 * used * v * dIn / mu;
            var f = _fanning(nre, rough / dIn), g = f * used * v * v / (25.8 * dIn);
            return { d: dIn, len: L, v: v, nre: nre, regime: nre < 2100 ? 'laminar' : 'turbulent', f: f, grad: g, dp: g * L };
        }
        if (rate) {
            var pTub = _pipe(tub.id, tpEnd), pCas = _pipe(cas.id, Math.max(0, tmd - tpEnd));
            fric = { rate: rate, mu: mu, rough: rough, tubing: pTub, casing: pCas, total: pTub.dp + pCas.dp };
        }
        bullhead.friction = fric;

        // C. Surface pressure limits (static, no friction)
        var pFrac = HYD * fg * tvd;
        var hydWf = HYD * wf * tvd;
        var sithp = Math.max(0, pres - hydWf);
        var perfStart = pFrac - hydWf, perfEnd = pFrac - hyd;
        var shoe = null;
        if (stvd != null) {
            var pFs = HYD * sfg * stvd;
            shoe = { tvd: stvd, fg: sfg, pFrac: pFs, start: pFs - HYD * wf * stvd, end: pFs - grad * stvd };
        }
        var maspStart = shoe ? Math.min(perfStart, shoe.start) : perfStart;
        var maspEnd = shoe ? Math.min(perfEnd, shoe.end) : perfEnd;
        var endReq = Math.max(0, pres - hyd);
        var limits = {
            pFrac: pFrac, fgGrad: HYD * fg, sithp: sithp, hydWf: hydWf,
            perfStart: perfStart, perfEnd: perfEnd, shoe: shoe,
            maspStart: maspStart, maspEnd: maspEnd, endReq: endReq,
            windowStart: maspStart - sithp,
            governs: shoe && (shoe.start < perfStart || shoe.end < perfEnd) ? 'shoe' : 'perfs',
            killFracs: used >= fg - 1e-9
        };
        if (fric) {
            // While pumping, BHP = p_surface + hydrostatic − friction, so at the pump rate the surface
            // pressure that just reaches the fracture pressure is MASP + friction, and the pressure
            // needed to keep injecting at the end is (p_res − hydrostatic) + friction.
            limits.pumpEnd = endReq + fric.total;
            // Friction credit applies to the perforation limit only (the shoe sees casing pressure).
            limits.maxPumpEnd = shoe ? Math.min(perfEnd + fric.total, shoe.end) : perfEnd + fric.total;
            limits.pumpOverStatic = limits.pumpEnd > maspEnd + 1e-9;
        }

        // Static pumping schedule, 0 → 100 % of the bullhead volume (MD → TVD linear between
        // surface, packer and top perforation; below the top perforation the front is at the perfs).
        function tvdAt(md) {
            if (md <= pmd) return pmd > 0 ? md / pmd * ptvd : 0;
            if (md <= tmd) return tmd > pmd ? ptvd + (md - pmd) / (tmd - pmd) * (tvd - ptvd) : tvd;   // tailpipe inside this span
            return tvd;
        }
        function frontMd(v) {
            var left = v, md = 0;
            for (var k = 0; k < nIn; k++) {
                var s = sections[k];
                if (left <= s.vol || k === nIn - 1) { md = s.from + (s.cap > 0 ? Math.min(left, s.vol) / s.cap : 0); break; }
                left -= s.vol;
            }
            return md;
        }
        var schedule = [];
        for (var n = 0; n <= 10; n++) {
            var v = vol * n / 10, fmd = frontMd(v), ftvd = Math.min(tvd, tvdAt(fmd));
            var h = HYD * (used * ftvd + wf * (tvd - ftvd));
            var sf = shoe ? Math.min(stvd, ftvd) : 0;
            var mShoe = shoe ? shoe.pFrac - HYD * (used * sf + wf * (stvd - sf)) : Infinity;
            var fAt = null;
            if (fric) {                                          // kill fluid only; friction of the well fluid ahead of it is not credited
                var mdT = Math.min(fmd, tpEnd), mdC = Math.max(0, Math.min(fmd, tmd) - tpEnd);
                fAt = fric.tubing.grad * mdT + fric.casing.grad * mdC;
            }
            schedule.push({
                pct: n * 10, vol: v, strokes: v / pump, frontMd: fmd, frontTvd: ftvd,
                sitp: Math.max(0, pres - h), masp: Math.min(pFrac - h, mShoe),
                friction: fAt, maspPump: fAt == null ? null : Math.min(pFrac - h + fAt, mShoe)
            });
        }
        bullhead.schedule = schedule;

        // D. U-tube and fluid level
        var dU = HYD * (used - ann) * ptvd;
        var level = tvd - pres / grad;
        var utube = {
            dp: dU, heavier: dU > 1e-9 ? 'tubing' : dU < -1e-9 ? 'annulus' : 'none',
            level: level > 0 ? level : 0, onVacuum: level > 0
        };

        // E. Brine guide
        var brines = BRINES.map(function (b) {
            return { name: b.name, short: b.short, ppg: b.ppg, sg: b.sg, kgm3: b.kgm3, note: b.note, reaches: b.ppg >= used - 1e-9 };
        });
        var reach = brines.filter(function (b) { return b.reaches && b.ppg > 8.6; });
        return {
            ok: true, kill: kill, bullhead: bullhead, limits: limits, utube: utube,
            brines: brines, brineOk: brines.some(function (b) { return b.reaches; }),
            brineList: (used <= 8.55 ? brines.filter(function (b) { return b.reaches; }) : reach).slice(0, 4).map(function (b) { return b.short; }),
            tubing: tub, casing: cas
        };
    }

    // ── Pure compute: liquid / mixed gradient ───────────────────────
    // input = {dir:'s2b'|'b2s', p psig (known pressure), tvd ft, gasLen ft, mixLen ft, hl % (liquid
    //          holdup in the mixed column), rho ppg, sg (gas), t °F (average), z (average)}
    // Column from surface: gas cap [0, gasLen], mixed [gasLen, gasLen+mixLen], liquid to tvd.
    // Each section solves dp/dh = a + b·P (P psia): a = liquid part, b = gas part (average Z, T):
    //   P(h) = (P0 + a/b)·e^(b·h) − a/b   (b > 0);   P(h) = P0 + a·h   (b = 0).
    function gradient(input) {
        var i = input || {}, errors = [], bad = [];
        function need(ok, key, msg) { if (!ok) { errors.push(msg); bad.push(key); } return ok; }
        var dir = i.dir === 'b2s' ? 'b2s' : 's2b';
        var p = Number(i.p), tvd = Number(i.tvd), lg = _blank(i.gasLen) ? 0 : Number(i.gasLen), lm = _blank(i.mixLen) ? 0 : Number(i.mixLen);
        var hl = Number(i.hl), rho = Number(i.rho), sg = Number(i.sg), t = Number(i.t), z = Number(i.z);
        need(_fin(p) && p >= 0 && p <= 30000, 'p', 'Known pressure must be between 0 and 30,000 psig.');
        var tvdOk = need(_fin(tvd) && tvd > 0 && tvd <= 40000, 'tvd', 'Column TVD must be above 0 and no more than 40,000 ft.');
        var lgOk = need(_fin(lg) && lg >= 0 && (!tvdOk || lg <= tvd), 'gasLen', 'Gas cap length must be 0 or more and no longer than the column.');
        need(_fin(lm) && lm >= 0 && (!tvdOk || !lgOk || lg + lm <= tvd + 1e-9), 'mixLen', 'Mixed column length must be 0 or more; gas cap plus mixed column cannot exceed the column TVD.');
        need(_fin(hl) && hl >= 0 && hl <= 100, 'hl', 'Liquid holdup must be between 0 and 100 %.');
        need(_fin(rho) && rho > 0 && rho <= 25, 'rho', 'Liquid density must be above 0 and no more than 25 ppg.');
        need(_fin(sg) && sg >= 0.55 && sg <= 3, 'sg', 'Gas gravity must be between 0.55 and 3.');
        need(_fin(t) && t >= -40 && t <= 500, 't', 'Average temperature must be between -40 and 500 °F.');
        need(_fin(z) && z >= 0.2 && z <= 2, 'z', 'Average Z-factor must be between 0.2 and 2.');
        if (errors.length) return { ok: false, errors: errors, bad: bad };

        var TR = t + 459.67, gL = HYD * rho, bg = GAS_C * sg / (z * TR), H = hl / 100;
        var ll = Math.max(0, tvd - lg - lm);
        var secs = [
            { key: 'gas', name: 'Gas cap', len: lg, a: 0, b: bg },
            { key: 'mixed', name: 'Mixed column', len: lm, a: H * gL, b: (1 - H) * bg },
            { key: 'liquid', name: 'Liquid column', len: ll, a: gL, b: 0 }
        ];
        function down(P0, s) { return s.b > 0 ? (P0 + s.a / s.b) * Math.exp(s.b * s.len) - s.a / s.b : P0 + s.a * s.len; }
        function up(P1, s) { return s.b > 0 ? (P1 + s.a / s.b) * Math.exp(-s.b * s.len) - s.a / s.b : P1 - s.a * s.len; }
        var top = 0;
        secs.forEach(function (s) { s.top = top; s.bottom = top + s.len; top = s.bottom; });
        if (dir === 's2b') {
            var P = p + PATM;
            secs.forEach(function (s) { s.pTop = P; P = down(P, s); s.pBot = P; });
        } else {
            var Q = p + PATM;
            for (var k = secs.length - 1; k >= 0; k--) {
                secs[k].pBot = Q; Q = up(Q, secs[k]); secs[k].pTop = Q;
                if (!(Q > 0)) return { ok: false, errors: ['Bottomhole pressure is too low to hold this column to surface; the liquid level would stand below surface.'], bad: ['p'] };
            }
        }
        var pSurfA = secs[0].pTop, pBotA = secs[2].pBot;
        secs.forEach(function (s) {
            s.pTop -= PATM; s.pBot -= PATM;
            s.grad = s.len > 0 ? (s.pBot - s.pTop) / s.len : null;
            delete s.a; delete s.b;
        });
        return {
            ok: true, dir: dir, pSurf: pSurfA - PATM, pBot: pBotA - PATM, tvd: tvd,
            avgGrad: (pBotA - pSurfA) / tvd, liqGrad: gL, liqLen: ll,
            gasGradSurf: bg * pSurfA, gasGradBot: bg * pBotA, sections: secs
        };
    }

    G.WTS_wellkill_compute = wellkill;
    G.WTS_gradient_compute = gradient;
    G.WTS_wellkill_brines = BRINES.map(function (b) { return { name: b.name, ppg: b.ppg, sg: b.sg, kgm3: b.kgm3, note: b.note }; });

    // ── Page ─────────────────────────────────────────────────────────
    var TITLE = 'Well Kill & Bullhead';
    var SUB = 'Kill-weight fluid, bullhead volumes and strokes, surface pressure limits against fracture gradient, U-tube check, brine guide and liquid / gas gradients';
    var UNITS = {
        wk_pres: 'pressure', wk_tvd: 'length', wk_ob: 'pressure', wk_kwo: 'densityLiquid', wk_fg: 'densityLiquid',
        wk_wf: 'densityLiquid', wk_ann: 'densityLiquid', wk_stvd: 'length', wk_sfg: 'densityLiquid',
        wk_pmd: 'length', wk_ptvd: 'length', wk_tmd: 'length', wk_bmd: 'length', wk_pbtd: 'length',
        wk_od: 'percent', wk_pump: 'volume', wk_spm: 'count', wk_tpmd: 'length', wk_mu: 'viscosity', wk_rough: 'lengthSmall',
        wk_gp: 'pressureG', wk_gtvd: 'length', wk_glen: 'length', wk_gmix: 'length', wk_ghl: 'percent',
        wk_grho: 'densityLiquid', wk_gsg: 'sg', wk_gt: 'temperature', wk_gz: 'dimensionless'
    };
    var KILL_IDS = {
        pres: 'wk_pres', tvd: 'wk_tvd', ob: 'wk_ob', kwo: 'wk_kwo', fg: 'wk_fg', wf: 'wk_wf', ann: 'wk_ann',
        stvd: 'wk_stvd', sfg: 'wk_sfg', tub: 'wk_tub', cas: 'wk_cas', pmd: 'wk_pmd', ptvd: 'wk_ptvd',
        tmd: 'wk_tmd', bmd: 'wk_bmd', pbtd: 'wk_pbtd', od: 'wk_od', pump: 'wk_pump', spm: 'wk_spm',
        tpmd: 'wk_tpmd', mu: 'wk_mu', rough: 'wk_rough'
    };
    var GRAD_IDS = { p: 'wk_gp', tvd: 'wk_gtvd', gasLen: 'wk_glen', mixLen: 'wk_gmix', hl: 'wk_ghl', rho: 'wk_grho', sg: 'wk_gsg', t: 'wk_gt', z: 'wk_gz' };

    // Validation messages in the display system (limits are imperial).
    function _den(v) { return _u(v, 'densityLiquid', 2, 'ppg', 3); }
    var MSG = {
        pres: function () { return 'Reservoir pressure must be above 0 and no more than ' + _u(30000, 'pressure', 0, 'psi') + '.'; },
        tvd: function () { return 'Top perforation TVD must be above 0 and no more than ' + _u(40000, 'length', 0, 'ft') + '.'; },
        ob: function () { return 'Overbalance must be between 0 and ' + _u(5000, 'pressure', 0, 'psi') + '.'; },
        kwo: function () { return 'Kill fluid density to use must be between ' + _den(6) + ' and ' + _den(25) + ', or blank.'; },
        wf: function () { return 'Well fluid density must be 0 or more and below ' + _den(25) + '.'; },
        fg: function () { return 'Fracture gradient must be between ' + _den(6) + ' and ' + _den(25) + ' EMW and above the well fluid density.'; },
        ann: function () { return 'Annulus fluid density must be above 0 and no more than ' + _den(25) + '.'; },
        stvd: function () { return 'Casing shoe TVD must be above 0 and no deeper than the top perforation TVD, or blank.'; },
        sfg: function () { return 'Shoe fracture gradient must be between ' + _den(6) + ' and ' + _den(25) + ' EMW and above the well fluid density.'; },
        pmd: function () { return 'Packer MD must be above 0 and no more than ' + _u(50000, 'length', 0, 'ft') + '.'; },
        od: function () { return 'Over-displacement must be between 0 and 100 %.'; },
        pump: function () { return 'Pump output must be between ' + _u(0.001, 'volume', 3, 'bbl', 5) + ' and ' + _u(2, 'volume', 0, 'bbl', 3) + ' per stroke.'; },
        spm: function () { return 'Pump speed must be between 1 and 300 strokes per minute, or blank.'; },
        rough: function () { return 'Pipe roughness must be between 0 and ' + _u(0.01, 'lengthSmall', 2, 'in', 3) + '.'; },
        p: function () { return 'Known pressure must be between 0 and ' + _u(30000, 'pressureG', 0, 'psig') + '.'; },
        gtvd: function () { return 'Column TVD must be above 0 and no more than ' + _u(40000, 'length', 0, 'ft') + '.'; },
        rho: function () { return 'Liquid density must be above 0 and no more than ' + _den(25) + '.'; },
        t: function () { return 'Average temperature must be between ' + _u(-40, 'temperature', 0, '°F') + ' and ' + _u(500, 'temperature', 0, '°F') + '.'; }
    };

    function _fg(id, label, val, extra) {
        return '<div class="fg-item"><label for="' + id + '">' + label + '</label>' +
            '<input type="number" id="' + id + '" value="' + val + '" step="any"' + (extra || '') + '></div>';
    }
    function _sel(id, label, opts, val) {
        var h = '<div class="fg-item"><label for="' + id + '">' + label + '</label><select id="' + id + '">';
        opts.forEach(function (o) {
            if (o.group != null) { h += (o.group ? '<optgroup label="' + o.group + '">' : '</optgroup>'); return; }
            h += '<option value="' + o.v + '"' + (o.v === val ? ' selected' : '') + '>' + o.t + '</option>';
        });
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
    // v3.1: Metric mode leads with kg/m³ (ppg follows); imperial text unchanged.
    function _ppgTriple(ppg) {
        return _metric() ? _fmt(ppg * KGM3_PER_PPG, 0) + ' kg/m³ · SG ' + _fixed(ppg / PPG_PER_SG, 3) + ' · ' + _fixed(ppg, 2) + ' ppg'
                         : _fixed(ppg, 2) + ' ppg · SG ' + _fixed(ppg / PPG_PER_SG, 3) + ' · ' + _fmt(ppg * KGM3_PER_PPG, 0) + ' kg/m³';
    }

    // A single density: ppg in imperial; kg/m³ first (ppg in brackets) in Metric mode.
    function _ppgMet(ppg) {
        return _metric() ? _fmt(ppg * KGM3_PER_PPG, 0) + ' kg/m³ (' + _fixed(ppg, 2) + ' ppg)' : _fixed(ppg, 2) + ' ppg';
    }

    function _errors(resId, ids, bad, errs) {
        var res = _byId(resId), items = '', seen = {};
        for (var k = 0; k < bad.length; k++) {
            var key = bad[k], el = _byId(ids[key]);
            if (el && el.classList) el.classList.add('input-err');
            if (seen[key]) continue;
            seen[key] = 1;
            var mk = (resId === 'wk_gres' && key === 'tvd') ? 'gtvd' : key;
            items += '<li>' + (MSG[mk] ? MSG[mk]() : errs[k]) + '</li>';
        }
        if (res) {
            res.innerHTML = '<div class="val-error"><strong>Please fix the following:</strong><ul>' + items + '</ul></div>';
            res.setAttribute('data-done', '1');
        }
    }

    function _paintKill(r) {
        var res = _byId('wk_res');
        if (!res) return;
        if (!r.ok) { _errors('wk_res', KILL_IDS, r.bad, r.errors); return; }
        var k = r.kill, b = r.bullhead, L = r.limits, U = r.utube;
        var P = function (v) { return _u(v, 'pressure', 0, 'psi'); };
        var V = function (v) { return _u(v, 'volume', 1, 'bbl', 2); };
        var ft = function (v) { return _u(v, 'length', 0, 'ft', 1); };
        var h = '';

        // Kill fluid
        var kv = '';
        if (k.belowBalance) kv += _bad('Selected kill fluid is below the balance density; it will not kill the well.');
        else if (k.belowKwf) kv += _warn('Selected kill fluid is below the calculated kill weight; overbalance is ' + P(k.obActual) + '.');
        else kv += _ok('Kill fluid gives ' + P(k.obActual) + ' overbalance at the top perforation.');
        h += '<div class="rbox"><div class="rbox-title">Kill Fluid</div>' +
            _row('Balance density', _ppgTriple(k.balance)) +
            _row('Overbalance as density', _metric() ? _den(k.obPpg) : _fixed(k.obPpg, 2) + ' ppg') +
            _row('Kill weight', _ppgTriple(k.kwf)) +
            _row('Kill fluid used', _ppgTriple(k.used) + (k.auto ? ' (rounded up)' : ' (selected)')) +
            _row('Kill fluid gradient', _grad(k.grad)) +
            _row('Hydrostatic at top perforation', P(k.hyd)) +
            _row('Overbalance at top perforation', P(k.obActual)) +
            kv + '</div>';

        // Bullhead
        var toTxt = { top: 'top perforation', bot: 'bottom perforation', pbtd: 'PBTD' }[b.to];
        h += '<div class="rbox"><div class="rbox-title">Bullhead Volume</div>' +
            _tbl(['Section', 'From', 'To', 'ID', 'Capacity', 'Volume', 'Pumped'], b.sections.map(function (s) {
                return [s.name, ft(s.from), ft(s.to), _metric() ? _u(s.idIn, 'lengthSmall', 3, 'in', 1) : _fixed(s.idIn, 3) + ' in',
                    _u(s.cap, 'capacity', 5, 'bbl/ft', 5), V(s.vol), s.included ? 'yes' : 'no'];
            })) +
            _row('Tubing', r.tubing.label) +
            _row('Casing / liner below packer', r.casing.label) +
            _row('Bullhead volume to ' + toTxt, V(b.vol)) +
            _row('Over-displacement', V(b.extra)) +
            _row('Total to pump', V(b.pumped)) +
            _row('Pump strokes', _fmt(Math.ceil(b.strokes - 1e-9), 0) + ' strokes') +
            (b.minutes != null ? _row('Pumping time', _fmt(b.minutes, 1) + ' min') : '') +
            _row('Tubing x casing annular capacity', _u(b.annCap, 'capacity', 5, 'bbl/ft', 5)) +
            (b.tailpipe ? _row('Tailpipe volume below the packer (included)', V(b.tailpipe.vol)) +
                _row('Casing x tailpipe annulus below the packer (not swept)', V(b.tailpipe.deadVol)) +
                _warn('Gas in the casing x tailpipe annulus below the packer (' + V(b.tailpipe.deadVol) + ') is not displaced by the bullhead and can migrate after the kill.') : '') +
            '</div>';

        // Pressure limits
        var pv = '';
        if (L.killFracs) pv += _bad('Kill fluid gradient is at or above the fracture gradient. Expect losses; use a lighter fluid with back-pressure or a loss plan.');
        if (L.windowStart <= 0) pv += _bad('Shut-in tubing pressure is at or above the maximum surface pressure: bullheading would fracture the formation.');
        else if (L.windowStart < WINDOW_FRAC * L.pFrac) pv += _warn('Narrow bullhead window at the start: ' + P(L.windowStart) + ' between shut-in pressure and the fracture limit.');
        else pv += _ok('Bullhead window at the start is ' + P(L.windowStart) + ' above the shut-in tubing pressure.');
        if (L.maspEnd <= 0 && !L.killFracs) pv += _bad('Maximum surface pressure reaches zero before the kill fluid reaches the perforations.');
        if (b.friction && L.pumpOverStatic) pv += _warn('At this pump rate the pump pressure at the end (' + P(L.pumpEnd) + ') exceeds the static maximum surface pressure; only the friction loss keeps the perforations below fracture pressure. Slow the pump near the end.');
        else if (b.friction) pv += _ok('Pump pressure at the end (' + P(L.pumpEnd) + ', with ' + P(b.friction.total) + ' friction) stays below the static maximum surface pressure.');
        h += '<div class="rbox"><div class="rbox-title">Surface Pressure Limits</div>' +
            _row('Fracture pressure at top perforation', P(L.pFrac)) +
            _row('Fracture gradient', _grad(L.fgGrad)) +
            _row('Shut-in tubing pressure, estimated', P(L.sithp)) +
            _row('Max surface pressure at start', P(L.maspStart)) +
            _row('Max surface pressure at end', P(L.maspEnd)) +
            _row('Surface pressure needed at end', P(L.endReq)) +
            (b.friction ? _row('Pump rate', _u(b.friction.rate, 'volume', 2, 'bbl', 3) + '/min') +
                _row('Tubing: velocity / Reynolds number / regime', _u(b.friction.tubing.v, 'velocity', 2, 'ft/s') + ' / ' + _fmt(b.friction.tubing.nre, 0) + ' / ' + b.friction.tubing.regime) +
                _row('Tubing: Fanning friction factor', _fixed(b.friction.tubing.f, 5)) +
                _row('Friction pressure, tubing' + (b.tailpipe ? ' and tailpipe' : ''), P(b.friction.tubing.dp)) +
                _row('Friction pressure, casing to top perforation', P(b.friction.casing.dp)) +
                _row('Friction pressure at pump rate, kill fluid', P(b.friction.total)) +
                _row('Pump pressure to keep injecting at end (needed + friction)', P(L.pumpEnd)) +
                _row('Max pump pressure at end at this rate (limit + friction)', P(L.maxPumpEnd)) : '') +
            (L.shoe ? _row('Shoe: fracture pressure', P(L.shoe.pFrac)) +
                _row('Shoe: max surface pressure start / end', P(L.shoe.start) + ' / ' + P(L.shoe.end)) +
                _row('Governing limit', L.governs === 'shoe' ? 'casing shoe' : 'top perforation') : '') +
            pv +
            '<div class="rbox-title" style="margin-top:10px">Static Pumping Schedule</div>' +
            _tbl(['Pumped', 'Volume', 'Strokes', 'Front MD', 'Shut-in pressure', 'Max surface pressure'].concat(b.friction ? ['Kill-fluid friction', 'Max pump pressure at rate'] : []), b.schedule.map(function (s) {
                return [s.pct + ' %', V(s.vol), _fmt(Math.round(s.strokes), 0), ft(s.frontMd), P(s.sitp), P(s.masp)].concat(b.friction ? [P(s.friction), P(s.maspPump)] : []);
            })) +
            _note('Shut-in and maximum surface pressures are static: no gas migration, incompressible fluids. Friction (v3.0) is ' +
                'for the kill fluid as a Newtonian fluid of the entered viscosity at pump output × speed: Fanning f = 16/Re laminar ' +
                '(Re < 2,100), Colebrook turbulent, dp/dL = f·ρ·v²/(25.8·d) (Bourgoyne et al., Applied Drilling Engineering, §4.6). ' +
                'While pumping, BHP = surface + hydrostatic − friction, so friction is credited to the perforation limit only as the ' +
                'kill fluid fills the string; friction of the well fluid ahead of it is not credited, and none is credited at the shoe. ' +
                'Keep the pump pressure below the wellhead / treating-iron rating. The shoe limit applies where the casing sees the ' +
                'pressure, e.g. no packer or a leak. With a tailpipe the bullhead path is the tailpipe bore; the casing x tailpipe ' +
                'annulus below the packer is not swept.') +
            '</div>';

        // U-tube
        var uv = '';
        if (U.heavier === 'tubing') uv += _warn('Kill fluid is heavier than the annulus fluid: if tubing and annulus communicate, the tubing will U-tube with up to ' + P(U.dp) + ' difference at the packer.');
        else if (U.heavier === 'annulus') uv += _warn('Annulus fluid is heavier: on communication the annulus will U-tube into the tubing, up to ' + P(-U.dp) + ' difference at the packer.');
        else uv += _ok('Tubing and annulus fluids balance at the packer.');
        if (U.onVacuum) uv += _warn('If the formation takes fluid, the tubing will go on vacuum with a static fluid level at about ' + ft(U.level) + ' TVD.');
        else uv += _ok('Kill fluid column does not exceed reservoir pressure; the tubing stays full.');
        h += '<div class="rbox"><div class="rbox-title">U-tube Check</div>' +
            _row('Pressure difference at packer, tubing minus annulus', P(U.dp)) +
            _row('Static fluid level if the formation takes fluid', U.onVacuum ? ft(U.level) + ' TVD' : 'surface') +
            uv + '</div>';

        // Brines
        var bv = '';
        if (!r.brineOk) bv = _bad('No clear brine in the guide reaches ' + _ppgMet(k.used) + '. Use a weighted fluid.');
        else bv = _ok('Clear brines that reach ' + _ppgMet(k.used) + ': ' + r.brineList.join(', ') + '.');
        h += '<div class="rbox"><div class="rbox-title">Brine Selection Guide</div>' +
            _tbl(_metric() ? ['Brine', 'Max kg/m³', 'Max SG', 'Max ppg', 'Reaches kill fluid', 'Crystallisation / notes']
                           : ['Brine', 'Max ppg', 'Max SG', 'Max kg/m³', 'Reaches kill fluid', 'Crystallisation / notes'], r.brines.map(function (x) {
                return _metric() ? [x.name, _fmt(x.kgm3, 0), _fixed(x.sg, 2), _fixed(x.ppg, 2), x.reaches ? 'yes' : 'no', x.note]
                                 : [x.name, _fixed(x.ppg, 2), _fixed(x.sg, 2), _fmt(x.kgm3, 0), x.reaches ? 'yes' : 'no', x.note];
            })) +
            bv +
            _note('Guidance only. Maximum densities are typical values at about 70 °F. Crystallisation temperature rises steeply ' +
                'near the maximum density, and pressure raises it further. Brine density falls as temperature rises. Confirm ' +
                'density at well temperature, crystallisation temperature and compatibility with the fluid supplier.') +
            '</div>';

        res.innerHTML = h;
        res.setAttribute('data-done', '1');
    }

    function _paintGrad(r) {
        var res = _byId('wk_gres');
        if (!res) return;
        if (!r.ok) { _errors('wk_gres', GRAD_IDS, r.bad, r.errors); return; }
        var P = function (v) { return _u(v, 'pressureG', 1, 'psig', 0); };
        var ft = function (v) { return _u(v, 'length', 0, 'ft', 1); };
        var h = '<div class="rbox"><div class="rbox-title">Column Pressures</div>' +
            _row('Surface pressure', P(r.pSurf)) +
            _row('Bottomhole pressure', P(r.pBot)) +
            _row('Average gradient', _grad(r.avgGrad)) +
            _row('Liquid gradient', _grad(r.liqGrad)) +
            _row('Gas gradient at surface', _grad(r.gasGradSurf)) +
            _tbl(['Section', 'Top', 'Bottom', 'Pressure at top', 'Pressure at bottom', 'Gradient'], r.sections.map(function (s) {
                return [s.name, ft(s.top), ft(s.bottom), P(s.pTop), P(s.pBot), s.grad == null ? '—' : _grad(s.grad)];
            })) +
            (r.pSurf < 0 ? _warn('Surface pressure is below atmospheric: the column would not stand to surface.') : '') +
            _note('Static column, top to bottom: gas cap, mixed gas/liquid column, liquid. The gas gradient uses one average Z ' +
                'and temperature for the column. The mixed column uses a fixed liquid holdup with no slip or friction. ' +
                'Liquid gradient = 0.052 × density.') +
            '</div>';
        res.innerHTML = h;
        res.setAttribute('data-done', '1');
    }

    function _readKill() {
        return {
            pres: _num('wk_pres'), tvd: _num('wk_tvd'), ob: _num('wk_ob'), kwo: _num('wk_kwo'), fg: _num('wk_fg'),
            wf: _num('wk_wf'), ann: _num('wk_ann'), stvd: _num('wk_stvd'), sfg: _num('wk_sfg'),
            tub: _str('wk_tub'), cas: _str('wk_cas'), pmd: _num('wk_pmd'), ptvd: _num('wk_ptvd'),
            tmd: _num('wk_tmd'), bmd: _num('wk_bmd'), pbtd: _num('wk_pbtd'), to: _str('wk_to'),
            od: _num('wk_od'), pump: _num('wk_pump'), spm: _num('wk_spm'),
            tpmd: _num('wk_tpmd'), mu: _num('wk_mu'), rough: _num('wk_rough')
        };
    }
    function _readGrad() {
        return {
            dir: _str('wk_gdir'), p: _num('wk_gp'), tvd: _num('wk_gtvd'), gasLen: _num('wk_glen'), mixLen: _num('wk_gmix'),
            hl: _num('wk_ghl'), rho: _num('wk_grho'), sg: _num('wk_gsg'), t: _num('wk_gt'), z: _num('wk_gz')
        };
    }

    function _calcImpl() {
        var root = _byId('wk_root');
        if (!root) return null;
        var ins = root.querySelectorAll ? root.querySelectorAll('input,select') : [];
        for (var n = 0; n < ins.length; n++) if (ins[n].classList) ins[n].classList.remove('input-err');
        var a = wellkill(_readKill());
        var g = gradient(_readGrad());
        _paintKill(a);
        _paintGrad(g);
        G.WTS_state = G.WTS_state || {};
        G.WTS_state.wellkill = {
            kwf: a.ok ? a.kill.kwf : null, kwfUsed: a.ok ? a.kill.used : null,
            bullheadVol: a.ok ? a.bullhead.vol : null, pumpedVol: a.ok ? a.bullhead.pumped : null,
            strokes: a.ok ? a.bullhead.strokes : null,
            maspStart: a.ok ? a.limits.maspStart : null, maspEnd: a.ok ? a.limits.maspEnd : null,
            ts: Date.now(), result: a
        };
        G.WTS_state.gradient = {
            pSurf: g.ok ? g.pSurf : null, pBot: g.ok ? g.pBot : null, avgGrad: g.ok ? g.avgGrad : null,
            ts: Date.now(), result: g
        };
        return { kill: a, gradient: g };
    }
    G.calcWellKill = function () { return _canon(_calcImpl); };

    function _tubOpts() {
        var T = G.WTS_tubulars, o = [];
        if (!T) return o;
        o.push({ group: 'Tubing' });
        T.tubing.forEach(function (e) { o.push({ v: e.key, t: e.label }); });
        o.push({ group: '' }, { group: 'Casing sizes used as tubing' });
        T.casing.filter(function (e) { return e.od <= 7.625; }).forEach(function (e) { o.push({ v: e.key, t: e.label }); });
        o.push({ group: '' });
        return o;
    }
    function _casOpts() {
        var T = G.WTS_tubulars, o = [];
        if (!T) return o;
        o.push({ group: 'Casing' });
        T.casing.forEach(function (e) { o.push({ v: e.key, t: e.label }); });
        o.push({ group: '' }, { group: 'Liner' });
        T.liners.forEach(function (e) { o.push({ v: e.key, t: e.label }); });
        o.push({ group: '' });
        return o;
    }

    function render(body) {
        if (!body) return;
        var t = _byId('pgTitle'), s = _byId('pgSub');
        if (t) t.textContent = TITLE;
        if (s) s.textContent = SUB;
        var btn = function (id) { return '<div class="btn-row"><button class="btn btn-primary" id="' + id + '" onclick="calcWellKill()">Calculate</button></div>'; };
        body.innerHTML =
            '<div id="wk_root"><div class="cols-2">' +
            '<div>' +
            '<div class="card"><div class="card-title">Well &amp; Kill Fluid</div><div class="fg">' +
            _fg('wk_pres', 'Reservoir pressure at top perforation (psi)', '5400', ' min="0"') +
            _fg('wk_tvd', 'Top perforation TVD (ft)', '10000', ' min="0"') +
            _fg('wk_ob', 'Overbalance (psi)', '200', ' min="0"') +
            _fg('wk_kwo', 'Kill fluid density to use, blank = calculated (ppg)', '', ' min="0"') +
            _fg('wk_fg', 'Fracture gradient at top perforation, EMW (ppg)', '15', ' min="0"') +
            _fg('wk_wf', 'Well fluid density before the kill, EMW (ppg)', '1.9', ' min="0"') +
            _fg('wk_ann', 'Annulus / packer fluid density (ppg)', '8.6', ' min="0"') +
            _fg('wk_stvd', 'Casing shoe TVD, optional (ft)', '', ' min="0"') +
            _fg('wk_sfg', 'Fracture gradient at shoe, EMW (ppg)', '', ' min="0"') +
            '</div></div>' +
            '<div class="card"><div class="card-title">Completion &amp; Pumping</div><div class="fg">' +
            _sel('wk_tub', 'Tubing', _tubOpts(), 'tubing-2.875-6.5') +
            _sel('wk_cas', 'Casing / liner below packer', _casOpts(), 'casing-7-29') +
            _fg('wk_pmd', 'Packer MD (ft)', '9800', ' min="0"') +
            _fg('wk_ptvd', 'Packer TVD (ft)', '9620', ' min="0"') +
            _fg('wk_tmd', 'Top perforation MD (ft)', '10150', ' min="0"') +
            _fg('wk_bmd', 'Bottom perforation MD (ft)', '10250', ' min="0"') +
            _fg('wk_pbtd', 'PBTD, MD (ft)', '10400', ' min="0"') +
            _fg('wk_tpmd', 'Tailpipe end (WLEG) MD below the packer, blank = none (ft)', '', ' min="0"') +
            _sel('wk_to', 'Displace to', [{ v: 'top', t: 'Top perforation' }, { v: 'bot', t: 'Bottom perforation' }, { v: 'pbtd', t: 'PBTD, rathole included' }], 'top') +
            _fg('wk_od', 'Over-displacement (%)', '10', ' min="0" max="100"') +
            _fg('wk_pump', 'Pump output per stroke (bbl)', '0.1', ' min="0"') +
            _fg('wk_spm', 'Pump speed, strokes per minute', '40', ' min="0"') +
            _fg('wk_mu', 'Kill fluid viscosity, Newtonian (cp)', '2', ' min="0"') +
            _fg('wk_rough', 'Pipe roughness (in)', '0.0018', ' min="0"') +
            '</div>' + btn('wk_calc') + '</div>' +
            '<div class="card"><div class="card-title">Liquid / Mixed Gradient</div><div class="fg">' +
            _sel('wk_gdir', 'Pressure given at', [{ v: 's2b', t: 'Surface, find bottomhole' }, { v: 'b2s', t: 'Bottomhole, find surface' }], 's2b') +
            _fg('wk_gp', 'Known pressure (psig)', '1500', ' min="0"') +
            _fg('wk_gtvd', 'Column TVD (ft)', '10000', ' min="0"') +
            _fg('wk_glen', 'Gas cap length (ft)', '2000', ' min="0"') +
            _fg('wk_gmix', 'Mixed column length (ft)', '1000', ' min="0"') +
            _fg('wk_ghl', 'Liquid holdup in mixed column (%)', '40', ' min="0" max="100"') +
            _fg('wk_grho', 'Liquid density (ppg)', '8.6', ' min="0"') +
            _fg('wk_gsg', 'Gas gravity, air = 1', '0.65', ' min="0"') +
            _fg('wk_gt', 'Average temperature (°F)', '150') +
            _fg('wk_gz', 'Average Z-factor', '0.9', ' min="0"') +
            '</div>' + btn('wk_gcalc') +
            '<div id="wk_gres" style="margin-top:14px"></div></div>' +
            '</div>' +
            '<div><div id="wk_res"></div></div>' +
            '</div></div>';
        _tag(UNITS);
        var root = _byId('wk_root');
        if (root && root.addEventListener) {
            root.addEventListener('change', function (e) {
                if (e && e.target && /^wk_/.test(e.target.id || '')) G.calcWellKill();
            });
        }
        G.calcWellKill();
    }
    G.renderWellKill = render;

    // ── Registry (merge, never replace) ──────────────────────────────
    G.WTS_calcRegistry = G.WTS_calcRegistry || {};
    G.WTS_calcRegistry.wellkill = {
        key: 'wellkill',
        title: TITLE,
        sub: SUB,
        group: 'Test System Safety',
        icon: '&#9660;',
        badge: 'Well control',
        bc: 'dc-b-orange',
        desc: 'Kill-weight fluid, bullhead volumes and strokes, fracture-limited surface pressure, U-tube check, brine guide and gradients.',
        render: function (body) { return G.renderWellKill(body); }
    };

    // Unit flip: recalculate a page that has already shown results.
    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('wts:unit-system-changed', function () {
            var ids = ['wk_res', 'wk_gres'];
            for (var n = 0; n < ids.length; n++) {
                var r = _byId(ids[n]);
                if (r && r.getAttribute && r.getAttribute('data-done') === '1') { G.calcWellKill(); return; }
            }
        });
    }
})();

// ─── END 48-calc-wellkill ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 49-calc-chokeperf ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════
// WTS — Round-9 plug-in calculator — Choke Performance & Critical Flow (chokeperf)
//
// PURPOSE (roadmap #9, method notes §1.3)
//   One surface bean (choke), sized in 64ths or decimal inches:
//     • critical pressure ratio (p2/p1)c = (2/(k+1))^(k/(k−1)), k = Cp/Cv from
//       the Gas PVT engine (WTS_gaspvt_k) or entered;
//     • dry-gas rate through the bean, subcritical and critical, from the
//       compressible-orifice (isentropic nozzle) equation with a discharge
//       coefficient Cd and Z at upstream conditions (WTS_gaspvt_compute, DAK);
//     • multiphase (gas–liquid) bean correlations of the form
//         q = p1 · S^b / (a · GLR^c)
//       with the published Gilbert, Ros, Baxendell and Achong constants;
//     • a chart of rate vs wellhead pressure for several bean sizes, with the
//       well's wellhead performance curve when the shut-in WHP is given;
//     • a bean-up planning table: next bean → expected rate and WHP.
//
// REFERENCES
//   Gas through a bean — isentropic nozzle flow of a perfect gas with a real-gas
//   Z at upstream conditions (e.g. Guo, Lyons & Ghalambor, Petroleum Production
//   Engineering, 2007, §5.2, Eqs. 5.3–5.8; Beggs, Gas Production Operations,
//   1984, ch. 5):
//       ṁ   = Cd·A·p1·√( 2·gc·M/(Z1·R·T1) · k/(k−1)·(r^(2/k) − r^((k+1)/k)) )
//       q_sc = ṁ / ρ_sc ,  ρ_sc = Pb·M/(R·Tb) ,  r = max(p2/p1, rc)
//   which in field units is
//       q[Mscf/d] = K_G · Cd · A[in²] · p1[psia] · √( k/(k−1)·(r^(2/k) − r^((k+1)/k)) / (γg·T1[°R]·Z1) )
//       K_G = 86.4 · Tb/(144·Pb) · √(2·gc·R/M_air) = 1243.2 at 60 °F / 14.696 psia
//   (Guo et al. round it to 1,248; the sonic form 879·√(2k/(k+1)·…) is the same
//   equation at r = rc: 879·√2 = 1243.1).
//   Critical ratio — (2/(k+1))^(k/(k−1)): 0.5283 for k = 1.4, 0.5457 for k = 1.3.
//   Multiphase bean correlations (critical flow), p1 psig, S bean in 64ths,
//   GLR scf/STB, q gross liquid STB/d — constants as tabulated by Guo et al.
//   (2007) Table 5.1 and Brown & Beggs, The Technology of Artificial Lift
//   Methods, Vol. 1 (1977):
//       Gilbert (1954)   a = 10.01  b = 1.89  c = 0.546   (v3.0: exactly Gilbert's
//                        published q = p1·S^1.89/(435·R^0.546), R in Mscf/bbl, i.e.
//                        a = 435/1000^0.546 = 10.0113 with GLR in scf/STB — the same
//                        form as the host Choke Flow Rates and Dual Choke pages; the
//                        rounded a = 10.00 of the tabulations read 0.11 % high)
//       Ros (1960)       a = 17.40  b = 2.00  c = 0.500
//       Baxendell (1958) a =  9.56  b = 1.93  c = 0.546
//       Achong (1961)    a =  3.82  b = 1.88  c = 0.650
//     Gilbert, W.E. (1954) "Flowing and Gas-Lift Well Performance", API
//     Drilling & Production Practice, 126–157. Ros, N.C.J. (1960) "An Analysis
//     of Critical Simultaneous Gas/Liquid Flow Through a Restriction", Appl.
//     Sci. Res. 9, 374. Baxendell, P.B. (1958) and Achong, I. (1961) "Revised
//     Bean Performance Formula for Lake Maracaibo Wells" (Shell reports, as
//     tabulated in the references above).
//     Validity: critical flow through the bean — Gilbert: upstream pressure at
//     least 1.7 × downstream (p2/p1 ≤ 0.588, absolute).
//   Bean-up (Gilbert 1954 graphical method: the new rate is where the bean
//   performance line crosses the wellhead performance curve):
//     gas     wellhead back-pressure curve q = Cw·(pws² − pwh²)^n (Rawlins &
//             Schellhardt 1936 form written at the wellhead, psia), Cw from
//             the current point;
//     liquid  straight wellhead performance line from the shut-in WHP through
//             the current point (psig): pwh = pws − (pws − p1)·q/q0.
//   A measured current rate, when given, tunes the bean equation by
//   f = q_measured / q_calculated and is carried to the next beans.
//
// UNITS
//   Field units in and out (psig, °F, Mscf/d, STB/d, scf/STB). Standard gas
//   volumes at the app standard-conditions setting (WTS_baseConditions;
//   calculator default 60 °F / 14.696 psia). Bean sizes stay in 64ths and
//   inches (mm shown in Metric mode).
//
// PUBLIC API (window.*)
//   renderChokePerf(body)          paints the page into #pgBody
//   calcChokePerf()                reads the DOM, validates, computes, renders
//   WTS_chokeperf_compute(input)   pure → {ok, …} | {ok:false, errors[], keys[], bad[]}
//   WTS_chokeperf_criticalRatio(k)
//   WTS_chokeperf_gasRate({s64, cd, p1a, p2a, tR, sg, k, z, Tb_R, Pb})   Mscf/d
//   WTS_chokeperf_multiphaseRate(corrKey, p1psig, s64, glr)                STB/d
//   WTS_chokeperf_CORR             correlation constants {key: {name, a, b, c}}
//   WTS_chokeperf_BEANS            standard bean sizes, 64ths
//
// STATE
//   WTS_state.chokeperf = {ok, fluid, s64, sizeIn, q, qOil, rc, ratio, critical, k, z, f, beanUp[], ts}
// ════════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    var G = (typeof window !== 'undefined') ? window : globalThis;

    // ── Constants ────────────────────────────────────────────────────
    var PATM = 14.696;                 // psia
    var RANKINE = 459.67;
    var GC = 32.174;                   // lbm·ft/(lbf·s²)
    var R_FT_LBF = 1545.35;            // ft·lbf/(lb-mol·°R)
    var MW_AIR = 28.9647;              // lb/lb-mol
    var GILBERT_CRIT = 0.588;          // p2/p1 (absolute) for critical multiphase flow — Gilbert (1954): p1 ≥ 1.7·p2
    var CORR = {
        gilbert:   { key: 'gilbert',   name: 'Gilbert (1954)',   a: 435 / Math.pow(1000, 0.546), b: 1.89, c: 0.546 },   // = 435·(GLR/1000)^0.546
        ros:       { key: 'ros',       name: 'Ros (1960)',       a: 17.40, b: 2.00, c: 0.500 },
        baxendell: { key: 'baxendell', name: 'Baxendell (1958)', a: 9.56,  b: 1.93, c: 0.546 },
        achong:    { key: 'achong',    name: 'Achong (1961)',    a: 3.82,  b: 1.88, c: 0.650 }
    };
    var CORR_KEYS = ['gilbert', 'ros', 'baxendell', 'achong'];
    // Standard positive / adjustable bean sizes, 64ths of an inch.
    var BEANS = [4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 40, 44, 48, 52, 56, 60, 64, 72, 80, 88, 96, 104, 112, 120, 128];
    var N_BEANUP = 4;

    // ── Helpers ──────────────────────────────────────────────────────
    function _byId(id) { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }
    function _num(id) { var e = _byId(id); if (!e) return NaN; var s = String(e.value).trim(); return s === '' ? NaN : parseFloat(s); }
    function _str(id) { var e = _byId(id); return e ? String(e.value) : ''; }
    function _fin(x) { return typeof x === 'number' && isFinite(x); }
    function _opt(x) { return (x === '' || x == null) ? NaN : Number(x); }
    function _fmt(v, d) {
        if (v == null || !isFinite(v)) return '—';
        return (G.WTS_fmtNum ? G.WTS_fmtNum(v, (d == null ? 2 : d), (d == null ? 2 : d)) : Number(v).toLocaleString(undefined, { minimumFractionDigits: (d == null ? 2 : d), maximumFractionDigits: (d == null ? 2 : d) }));
    }
    function _metric() { var U = G.WTS_units; return !!(U && U.getSystem && U.getSystem() === 'metric' && U.format); }
    function _u(v, cat, d, impLabel, dMet) {
        if (v == null || !isFinite(v)) return '—';
        if (_metric()) { var f = G.WTS_units.format(v, cat); return _fmt(f.value, dMet == null ? d : dMet) + ' ' + f.label; }
        return _fmt(v, d) + ' ' + impLabel;
    }
    function _dv(v, cat) { return _metric() ? G.WTS_units.format(v, cat).value : v; }
    function _lab(cat, impLabel) { return _metric() ? G.WTS_units.format(1, cat).label : impLabel; }
    function _tag(map) { var U = G.WTS_units; if (!U || !U.tagInput) return; for (var id in map) U.tagInput(id, map[id]); }
    function _canon(fn) { var U = G.WTS_units; return (U && U.runCanonical) ? U.runCanonical(fn) : fn(); }
    function _basis() {
        var B = G.WTS_baseConditions;
        if (B && typeof B.resolve === 'function') { try { var b = B.resolve(60, PATM); if (b && b.Tb_R > 0 && b.Pb_psia > 0) return b; } catch (e) { /* fall through */ } }
        return { Tb_F: 60, Tb_R: 519.67, Pb_psia: PATM, label: '60 °F / 14.696 psia', fromSetting: false };
    }
    function _size(s64) {
        var inch = s64 / 64;
        return s64.toFixed(Math.abs(s64 - Math.round(s64)) < 1e-9 ? 0 : 1) + '/64" (' + inch.toFixed(4) + '"' + (_metric() ? ', ' + _fmt(inch * 25.4, 2) + ' mm' : '') + ')';
    }

    // ── Pure compute ─────────────────────────────────────────────────
    function criticalRatio(k) { return Math.pow(2 / (k + 1), k / (k - 1)); }

    // K_G of the field-unit compressible-orifice equation (see header).
    function gasConst(Tb_R, Pb) { return 86.4 * Tb_R / (144 * Pb) * Math.sqrt(2 * GC * R_FT_LBF / MW_AIR); }

    // Dry-gas rate (Mscf/d at Tb/Pb) through a bean of s64/64 in, Cd, upstream
    // p1a psia, downstream p2a psia, T1 °R, gravity sg, Cp/Cv k, Z at upstream.
    function gasRate(o) {
        var k = o.k, rc = criticalRatio(k);
        var r = Math.max(o.p2a / o.p1a, rc);
        if (r >= 1) return 0;
        var br = k / (k - 1) * (Math.pow(r, 2 / k) - Math.pow(r, (k + 1) / k));
        if (!(br > 0)) return 0;
        var d = o.s64 / 64, A = Math.PI / 4 * d * d;
        var Tb = o.Tb_R > 0 ? o.Tb_R : 519.67, Pb = o.Pb > 0 ? o.Pb : PATM;
        return gasConst(Tb, Pb) * o.cd * A * o.p1a * Math.sqrt(br / (o.sg * o.tR * o.z));
    }

    // Gross liquid rate STB/d, p1 psig, S 64ths, GLR scf/STB.
    function multiphaseRate(key, p1, s64, glr) {
        var c = CORR[key];
        if (!c || !(glr > 0)) return NaN;
        return p1 * Math.pow(s64, c.b) / (c.a * Math.pow(glr, c.c));
    }

    function _nextBeans(s64) {
        var up = [], below = null;
        for (var i = 0; i < BEANS.length; i++) {
            if (BEANS[i] > s64 + 1e-9 && up.length < N_BEANUP) up.push(BEANS[i]);
            if (BEANS[i] < s64 - 1e-9) below = BEANS[i];
        }
        return { up: up, below: below };
    }

    function compute(input) {
        var i = input || {};
        var fluid = i.fluid === 'liquid' ? 'liquid' : 'gas';
        var s64 = Number(i.s64), p1 = Number(i.p1), p2 = _opt(i.p2);
        var tF = _opt(i.t), sg = _opt(i.sg), cd = _opt(i.cd);
        var co2 = _fin(_opt(i.co2)) ? Number(i.co2) : 0, h2s = _fin(_opt(i.h2s)) ? Number(i.h2s) : 0, n2 = _fin(_opt(i.n2)) ? Number(i.n2) : 0;
        var kIn = _opt(i.k), zIn = _opt(i.z);
        var glr = _opt(i.glr), wc = _fin(_opt(i.wc)) ? Number(i.wc) : 0;
        var corrKey = CORR[i.corr] ? i.corr : 'gilbert';
        var pws = _opt(i.pws), qm = _opt(i.qm), nBp = _fin(_opt(i.n)) ? Number(i.n) : 1;
        var errors = [], keys = [], bad = [];
        function err(k, m) { errors.push(m); keys.push(k); if (bad.indexOf(k) === -1) bad.push(k); }

        if (!(_fin(s64) && s64 >= 2 && s64 <= 192)) err('size', 'Bean size must be between 2/64" and 192/64" (0.031" to 3").');
        if (!(_fin(p1) && p1 > 0 && p1 <= 20000)) err('p1', 'Upstream (wellhead) pressure must be above 0 and no more than 20,000 psig.');
        if (fluid === 'gas') {
            if (!(_fin(p2) && p2 > -PATM)) err('p2', 'Downstream pressure is required for gas and must be above full vacuum (−14.696 psig).');
            else if (_fin(p1) && !(p2 < p1)) err('p2', 'Downstream pressure must be below the upstream pressure.');
            if (!(_fin(tF) && tF >= -40 && tF <= 400)) err('t', 'Upstream temperature must be between −40 and 400 °F.');
            if (!(_fin(sg) && sg >= 0.55 && sg <= 3)) err('sg', 'Gas gravity must be between 0.55 and 3.0 (air = 1).');
            if (!(_fin(cd) && cd >= 0.5 && cd <= 1.2)) err('cd', 'Discharge coefficient Cd must be between 0.5 and 1.2.');
            if (!(co2 >= 0 && co2 < 100 && h2s >= 0 && h2s < 100 && n2 >= 0 && n2 < 100 && co2 + h2s + n2 < 95)) err('co2', 'CO2, H2S and N2 must each be 0–100 mol % and total below 95 %.');
            if (_fin(kIn) && !(kIn > 1 && kIn <= 1.67)) err('k', 'Cp/Cv (k) must be above 1.0 and no more than 1.67 (or leave blank to calculate it).');
            if (_fin(zIn) && !(zIn >= 0.2 && zIn <= 2)) err('z', 'Z must be between 0.2 and 2.0 (or leave blank to calculate it).');
            if (_fin(nBp) && !(nBp >= 0.5 && nBp <= 1)) err('n', 'Back-pressure exponent n must be between 0.5 and 1.0.');
        } else {
            if (_fin(p2) && !(p2 > -PATM && p2 < p1)) err('p2', 'Downstream pressure must be above full vacuum and below the upstream pressure (or leave it blank).');
            if (!(_fin(glr) && glr >= 10 && glr <= 100000)) err('glr', 'Gas–liquid ratio must be between 10 and 100,000 scf/STB.');
            if (!(wc >= 0 && wc < 100)) err('wc', 'Water cut must be at least 0 and below 100 %.');
        }
        if (_fin(pws) && _fin(p1) && !(pws > p1)) err('pws', 'Shut-in wellhead pressure must be above the flowing (upstream) pressure (or leave it blank).');
        if (_fin(pws) && !(pws <= 20000)) err('pws', 'Shut-in wellhead pressure must be no more than 20,000 psig.');
        if (_fin(qm) && !(qm > 0)) err('qm', 'Measured rate must be above 0 (or leave it blank).');
        if (errors.length) return { ok: false, errors: errors, keys: keys, bad: bad };

        var nb = _nextBeans(s64);
        var out = { ok: true, fluid: fluid, s64: s64, sizeIn: s64 / 64, areaIn2: Math.PI / 4 * Math.pow(s64 / 64, 2), p1: p1, p2: _fin(p2) ? p2 : null,
            pws: _fin(pws) ? pws : null, qm: _fin(qm) ? qm : null, warnings: [], beanUp: [], chartBeans: [] };
        out.chartBeans = (nb.below != null ? [nb.below] : []).concat([s64], nb.up.slice(0, 3));

        if (fluid === 'gas') {
            var basis = _basis();
            var TR = tF + RANKINE, p1a = p1 + PATM, p2a = p2 + PATM;
            // k and Z: entered, or from the Gas PVT engine (Sutton + Kay + Wichert–Aziz, DAK Z; ideal-gas Cp°/Cv°).
            var pvt = null, L = G.PRiSM_pvt_correlations;
            var needPvt = !_fin(kIn) || !_fin(zIn);
            if (needPvt) {
                if (typeof G.WTS_gaspvt_compute !== 'function' || !L) {
                    return { ok: false, keys: ['k'], bad: ['k', 'z'], errors: ['The Gas PVT engine is not loaded: enter Cp/Cv (k) and Z.'] };
                }
                pvt = G.WTS_gaspvt_compute({ sg: sg, p: p1a, t: tF, co2: co2, h2s: h2s, n2: n2 });
                if (!pvt.ok) return { ok: false, keys: pvt.keys || [], bad: (pvt.bad || []).map(function (b) { return b === 'p' ? 'p1' : b; }), errors: pvt.errors.slice() };
            }
            var k = _fin(kIn) ? kIn : pvt.k;
            var zAt = _fin(zIn) ? function () { return zIn; } : function (pa) { return L.Z_dranchukAbouKassem(TR / pvt.Tpc, pa / pvt.Ppc); };
            var z1 = _fin(zIn) ? zIn : pvt.z;
            var rc = criticalRatio(k), ratio = p2a / p1a;
            function qc(s, pa, f) {
                return (f || 1) * gasRate({ s64: s, cd: cd, p1a: pa, p2a: p2a, tR: TR, sg: sg, k: k, z: zAt(pa), Tb_R: basis.Tb_R, Pb: basis.Pb_psia });
            }
            var q = gasRate({ s64: s64, cd: cd, p1a: p1a, p2a: p2a, tR: TR, sg: sg, k: k, z: z1, Tb_R: basis.Tb_R, Pb: basis.Pb_psia });
            var qCrit = gasRate({ s64: s64, cd: cd, p1a: p1a, p2a: 0, tR: TR, sg: sg, k: k, z: z1, Tb_R: basis.Tb_R, Pb: basis.Pb_psia });
            var f = _fin(qm) ? qm / q : 1;
            Object.assign(out, {
                k: k, kSrc: _fin(kIn) ? 'input' : 'gaspvt', z: z1, zSrc: _fin(zIn) ? 'input' : 'gaspvt',
                rc: rc, ratio: ratio, critical: ratio <= rc, q: q, qCrit: qCrit, f: f, q0: _fin(qm) ? qm : q,
                p2CritMax: rc * p1a - PATM, KG: gasConst(basis.Tb_R, basis.Pb_psia), basis: basis, tF: tF, sg: sg, cd: cd, n: nBp
            });
            if (_fin(qm) && (f < 0.7 || f > 1.3)) out.warnings.push('Measured rate is ' + _fmt(100 * (f - 1), 0) + ' % off the bean equation: check the bean size, Cd, erosion of the bean, or liquid loading.');
            // Bean-up: wellhead back-pressure curve through the current point.
            if (_fin(pws)) {
                var pwsa = pws + PATM, q0 = out.q0;
                var Cw = q0 / Math.pow(pwsa * pwsa - p1a * p1a, nBp);
                out.Cw = Cw;
                var qw = function (pa) { return pa >= pwsa ? 0 : Cw * Math.pow(pwsa * pwsa - pa * pa, nBp); };
                out.qwAt = qw;
                nb.up.forEach(function (s) {
                    var lo = p2a, hi = pwsa;
                    for (var it = 0; it < 100; it++) { var m = (lo + hi) / 2; if (qc(s, m, f) > qw(m)) hi = m; else lo = m; }
                    var pwh = (lo + hi) / 2, qn = qw(pwh);
                    out.beanUp.push({ s64: s, q: qn, pwh: pwh - PATM, dqPct: 100 * (qn / q0 - 1), critical: p2a / pwh <= rc });
                });
            } else {
                nb.up.forEach(function (s) {
                    var qn = qc(s, p1a, f);
                    out.beanUp.push({ s64: s, q: qn, pwh: null, dqPct: 100 * (qn / out.q0 - 1), critical: ratio <= rc });
                });
            }
            out.qcAt = function (s, pwhG) { return qc(s, pwhG + PATM, f); };
            out.pMin = p2;
        } else {
            var rates = {}, table = [];
            CORR_KEYS.forEach(function (key) {
                var qq = multiphaseRate(key, p1, s64, glr);
                rates[key] = qq;
                table.push({ key: key, name: CORR[key].name, a: CORR[key].a, b: CORR[key].b, c: CORR[key].c, q: qq, qOil: qq * (1 - wc / 100) });
            });
            var qSel = rates[corrKey], fl = _fin(qm) ? qm / qSel : 1;
            var qMin = Math.min.apply(null, CORR_KEYS.map(function (k2) { return rates[k2]; }));
            var qMax = Math.max.apply(null, CORR_KEYS.map(function (k2) { return rates[k2]; }));
            var ratioL = _fin(p2) ? (p2 + PATM) / (p1 + PATM) : null;
            var Kof = function (s) { return fl * Math.pow(s, CORR[corrKey].b) / (CORR[corrKey].a * Math.pow(glr, CORR[corrKey].c)); };
            Object.assign(out, {
                corr: corrKey, corrName: CORR[corrKey].name, glr: glr, wc: wc, table: table, rates: rates,
                q: qSel, qOil: qSel * (1 - wc / 100), f: fl, q0: _fin(qm) ? qm : qSel, spreadPct: 100 * (qMax / qMin - 1),
                rc: GILBERT_CRIT, ratio: ratioL, critical: ratioL == null ? null : ratioL <= GILBERT_CRIT,
                p2CritMax: GILBERT_CRIT * (p1 + PATM) - PATM
            });
            if (_fin(qm) && (fl < 0.7 || fl > 1.3)) out.warnings.push('Measured rate is ' + _fmt(100 * (fl - 1), 0) + ' % off ' + CORR[corrKey].name + ': the correlation constants are field fits — tuning is applied to the bean-up.');
            if (_fin(pws)) {
                var q0l = out.q0;
                nb.up.forEach(function (s) {
                    // Straight wellhead line through (0, pws) and (q0, p1) meets q = K(S)·pwh:
                    //   pwh = q0·pws / (K(S)·(pws − p1) + q0)
                    var K = Kof(s), pwhN = q0l * pws / (K * (pws - p1) + q0l), qn = K * pwhN;
                    out.beanUp.push({ s64: s, q: qn, qOil: qn * (1 - wc / 100), pwh: pwhN, dqPct: 100 * (qn / q0l - 1),
                        critical: _fin(p2) ? (p2 + PATM) / (pwhN + PATM) <= GILBERT_CRIT : null });
                });
                out.qwAt = function (pwhG) { return pwhG >= pws ? 0 : q0l * (pws - pwhG) / (pws - p1); };
            } else {
                nb.up.forEach(function (s) {
                    var qn = Kof(s) * p1;
                    out.beanUp.push({ s64: s, q: qn, qOil: qn * (1 - wc / 100), pwh: null, dqPct: 100 * (qn / out.q0 - 1), critical: out.critical });
                });
            }
            out.qcAt = function (s, pwhG) { return Kof(s) * pwhG; };
            out.pMin = 0;
        }
        if (!nb.up.length) out.warnings.push('The bean is at or above the largest standard size (128/64"): no bean-up rows.');
        if (!_fin(pws)) out.warnings.push('Shut-in WHP not given: bean-up rates are at the current WHP (an upper bound; the WHP falls as the rate rises).');
        return out;
    }

    G.WTS_chokeperf_compute = compute;
    G.WTS_chokeperf_criticalRatio = criticalRatio;
    G.WTS_chokeperf_gasRate = gasRate;
    G.WTS_chokeperf_multiphaseRate = multiphaseRate;
    G.WTS_chokeperf_CORR = CORR;
    G.WTS_chokeperf_BEANS = BEANS.slice();

    // ── Page ─────────────────────────────────────────────────────────
    var TITLE = 'Choke Performance & Critical Flow';
    var SUB = 'Critical pressure ratio, gas and multiphase flow through a bean (Gilbert, Ros, Baxendell, Achong), rate vs WHP for several beans and bean-up planning';
    var UNITS = {
        ck_p1: 'pressureG', ck_p2: 'pressureG', ck_t: 'temperature', ck_sg: 'sg',
        ck_co2: 'percent', ck_h2s: 'percent', ck_n2: 'percent',
        ck_glr: 'gor', ck_wc: 'percent', ck_pws: 'pressureG', ck_qmg: 'gasRateSmall', ck_qml: 'liquidRate'
    };
    var IDS = { size: 'ck_size', p1: 'ck_p1', p2: 'ck_p2', t: 'ck_t', sg: 'ck_sg', cd: 'ck_cd', co2: 'ck_co2', h2s: 'ck_h2s', n2: 'ck_n2',
        k: 'ck_k', z: 'ck_z', n: 'ck_n', glr: 'ck_glr', wc: 'ck_wc', pws: 'ck_pws', qm: 'ck_qmg', qmL: 'ck_qml' };
    var GAS_ONLY = ['ck_t', 'ck_sg', 'ck_cd', 'ck_co2', 'ck_h2s', 'ck_n2', 'ck_k', 'ck_z', 'ck_n', 'ck_qmg'];
    var LIQ_ONLY = ['ck_glr', 'ck_wc', 'ck_corr', 'ck_qml'];
    // Validation messages in the display system (limits are imperial).
    var MSG = {
        p1: function () { return 'Upstream (wellhead) pressure must be above 0 and no more than ' + _u(20000, 'pressureG', 0, 'psig') + '.'; },
        t: function () { return 'Upstream temperature must be between ' + _u(-40, 'temperature', 0, '°F') + ' and ' + _u(400, 'temperature', 0, '°F') + '.'; },
        glr: function () { return 'Gas–liquid ratio must be between ' + _u(10, 'gor', 0, 'scf/STB', 1) + ' and ' + _u(100000, 'gor', 0, 'scf/STB') + '.'; }
    };

    function _fg(id, label, val, extra, hint) {
        return '<div class="fg-item" id="' + id + '_fg"><label for="' + id + '">' + label + '</label>' +
            '<input type="number" id="' + id + '" value="' + val + '" step="any"' + (extra || '') + '>' +
            (hint ? '<span style="font-size:10px;color:var(--text3)">' + hint + '</span>' : '') + '</div>';
    }
    function _sel(id, label, opts) {
        return '<div class="fg-item" id="' + id + '_fg"><label for="' + id + '">' + label + '</label><select id="' + id + '">' +
            opts.map(function (o) { return '<option value="' + o[0] + '"' + (o[2] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></div>';
    }
    function _row(l, v) { return '<div class="rrow"><span class="rl">' + l + '</span><span class="rv">' + v + '</span></div>'; }
    function _ok(t) { return '<div style="color:var(--green)">✓ ' + t + '</div>'; }
    function _warn(t) { return '<div style="color:var(--yellow)">⚠ ' + t + '</div>'; }
    function _qTxt(r, q, d) { return r.fluid === 'gas' ? _u(q, 'gasRateSmall', d == null ? 0 : d, 'MSCF/D') : _u(q, 'liquidRate', d == null ? 0 : d, 'BPD', 1); }

    function _resultsHtml(r) {
        var h = '', met = _metric();
        h += '<div class="rbox"><div class="rbox-title">Bean</div>' +
            _row('Bean size', _size(r.s64)) +
            _row('Bean area', met ? _fmt(r.areaIn2 * 645.16, 1) + ' mm²' : _fmt(r.areaIn2, 5) + ' in²') +
            _row('Upstream (wellhead) pressure', _u(r.p1, 'pressureG', 0, 'psig')) +
            (r.p2 != null ? _row('Downstream pressure', _u(r.p2, 'pressureG', 0, 'psig')) : '') + '</div>';
        if (r.fluid === 'gas') {
            h += '<div class="rbox"><div class="rbox-title">Gas Flow Through the Bean</div>' +
                _row('Cp/Cv (k)', _fmt(r.k, 4) + (r.kSrc === 'input' ? ' (entered)' : ' (Gas PVT, ideal gas at T1)')) +
                _row('Z at upstream conditions', _fmt(r.z, 4) + (r.zSrc === 'input' ? ' (entered)' : ' (Gas PVT, DAK)')) +
                _row('Critical pressure ratio (p2/p1)c', _fmt(r.rc, 4)) +
                _row('Actual ratio p2/p1 (absolute)', _fmt(r.ratio, 4)) +
                _row('Flow regime', r.critical ? 'Critical (sonic)' : 'Subcritical') +
                _row('Gas rate', _qTxt(r, r.q, 0) + (met ? '' : ' (' + _fmt(r.q / 1000, 3) + ' MMSCF/D)')) +
                _row('Critical-flow rate at this p1', _qTxt(r, r.qCrit, 0)) +
                _row('Highest downstream pressure for critical flow', _u(r.p2CritMax, 'pressureG', 0, 'psig')) +
                _row('Discharge coefficient Cd', _fmt(r.cd, 3)) +
                (r.qm != null ? _row('Tuning factor f = measured / calculated', _fmt(r.f, 3)) : '') + '</div>';
        } else {
            h += '<div class="rbox"><div class="rbox-title">Multiphase Bean Correlations</div>' +
                _row('Selected correlation', r.corrName) +
                _row('Liquid rate (selected)', _qTxt(r, r.q, 0)) +
                _row('Oil rate (selected)', _qTxt(r, r.qOil, 0)) +
                _row('Gas–liquid ratio', _u(r.glr, 'gor', 0, 'scf/STB', 1)) +
                (r.ratio != null ? _row('Actual ratio p2/p1 (absolute)', _fmt(r.ratio, 4)) : '') +
                _row('Highest downstream pressure for critical flow', _u(r.p2CritMax, 'pressureG', 0, 'psig')) +
                _row('Spread between correlations', _fmt(r.spreadPct, 1) + ' %') +
                (r.qm != null ? _row('Tuning factor f = measured / calculated', _fmt(r.f, 3)) : '') +
                '<div style="overflow-x:auto"><table class="dtable"><thead><tr><th>Correlation</th><th>a</th><th>b</th><th>c</th>' +
                '<th>Liquid (' + _lab('liquidRate', 'BPD') + ')</th><th>Oil (' + _lab('liquidRate', 'BPD') + ')</th></tr></thead><tbody>';
            r.table.forEach(function (t) {
                h += '<tr><td>' + t.name + (t.key === r.corr ? ' *' : '') + '</td><td>' + _fmt(t.a, 2) + '</td><td>' + _fmt(t.b, 2) + '</td><td>' + _fmt(t.c, 3) +
                    '</td><td>' + _fmt(_dv(t.q, 'liquidRate'), met ? 1 : 0) + '</td><td>' + _fmt(_dv(t.qOil, 'liquidRate'), met ? 1 : 0) + '</td></tr>';
            });
            h += '</tbody></table></div><div style="font-size:11px;color:var(--text3)">q = p1·S^b / (a·GLR^c): p1 psig, S in 64ths, GLR scf/STB, q STB/d gross liquid. * selected.</div></div>';
        }
        // Checks
        var v = '';
        if (r.fluid === 'gas') {
            v += r.critical ? _ok('Critical (sonic) flow: p2/p1 = ' + _fmt(r.ratio, 3) + ' ≤ ' + _fmt(r.rc, 3) + ' — the rate does not depend on the downstream pressure.')
                : _warn('Subcritical flow: p2/p1 = ' + _fmt(r.ratio, 3) + ' > ' + _fmt(r.rc, 3) + ' — the rate depends on the downstream pressure.');
        } else if (r.critical == null) {
            v += _warn('Downstream pressure not given: critical flow (p2/p1 ≤ 0.588) is assumed; the correlations do not apply to subcritical flow.');
        } else {
            v += r.critical ? _ok('Critical flow: p2/p1 = ' + _fmt(r.ratio, 3) + ' ≤ 0.588 (Gilbert) — the bean correlations apply.')
                : _warn('Not critical: p2/p1 = ' + _fmt(r.ratio, 3) + ' > 0.588 — the bean correlations over-predict the rate.');
        }
        r.warnings.forEach(function (w) { v += _warn(w); });
        h += '<div class="rbox"><div class="rbox-title">Checks</div>' + v + '</div>';
        // Bean-up
        var qL = r.fluid === 'gas' ? _lab('gasRateSmall', 'MSCF/D') : _lab('liquidRate', 'BPD');
        h += '<div class="rbox"><div class="rbox-title">Bean-up Planning</div>';
        if (r.beanUp.length) {
            h += '<div style="overflow-x:auto"><table class="dtable" id="ck_btbl"><thead><tr><th>Bean</th><th>Rate (' + qL + ')</th>' +
                (r.fluid === 'liquid' ? '<th>Oil (' + qL + ')</th>' : '') + '<th>WHP (' + _lab('pressureG', 'psig') + ')</th><th>Change</th><th>Flow</th></tr></thead><tbody>';
            var qd = r.fluid === 'gas' ? 0 : (met ? 1 : 0);
            h += '<tr><td>' + _size(r.s64) + ' now</td><td>' + _fmt(_dv(r.q0, r.fluid === 'gas' ? 'gasRateSmall' : 'liquidRate'), qd) + '</td>' +
                (r.fluid === 'liquid' ? '<td>' + _fmt(_dv(r.q0 * (1 - r.wc / 100), 'liquidRate'), qd) + '</td>' : '') +
                '<td>' + _fmt(_dv(r.p1, 'pressureG'), 0) + '</td><td>—</td><td>' + (r.critical === false ? 'subcritical' : 'critical') + '</td></tr>';
            r.beanUp.forEach(function (b) {
                h += '<tr><td>' + _size(b.s64) + '</td><td>' + _fmt(_dv(b.q, r.fluid === 'gas' ? 'gasRateSmall' : 'liquidRate'), qd) + '</td>' +
                    (r.fluid === 'liquid' ? '<td>' + _fmt(_dv(b.qOil, 'liquidRate'), qd) + '</td>' : '') +
                    '<td>' + (b.pwh == null ? '(held)' : _fmt(_dv(b.pwh, 'pressureG'), 0)) + '</td><td>' + (b.dqPct >= 0 ? '+' : '') + _fmt(b.dqPct, 1) + ' %</td>' +
                    '<td>' + (b.critical == null ? '—' : b.critical ? 'critical' : 'subcritical') + '</td></tr>';
            });
            h += '</tbody></table></div>';
            if (r.fluid === 'liquid' && r.beanUp.some(function (b) { return b.critical === false; })) h += _warn('Some bean-up rows are not in critical flow: the WHP falls below 1.7 × the downstream pressure, so those rates read high.');
            if (r.fluid === 'gas' && r.beanUp.some(function (b) { return b.critical === false; })) h += _warn('Some bean-up rows are subcritical: the downstream pressure now controls the rate.');
        }
        h += '<div class="chart-wrap"><canvas id="ck_chart" width="600" height="340"></canvas></div></div>';
        // Notes
        h += '<div><b>Notes</b> ' + (r.fluid === 'gas'
            ? 'Gas: isentropic compressible-orifice (nozzle) equation with discharge coefficient Cd, ideal-gas k and Z at upstream conditions; q = ' + _fmt(r.KG, 1) +
              '·Cd·A·p1·√(k/(k−1)·(r^(2/k) − r^((k+1)/k))/(γg·T1·Z1)), r = max(p2/p1, rc). Dry gas only — liquids raise the pressure drop. Standard volumes at ' + r.basis.label + '. ' +
              'Bean-up: wellhead back-pressure curve q = Cw·(pws² − pwh²)^n (absolute pressures, n = ' + _fmt(r.n, 2) + ') through the current point. '
            : 'Multiphase: Gilbert (1954), Ros (1960), Baxendell (1958) and Achong (1961) bean correlations, q = p1·S^b/(a·GLR^c), valid for critical flow (p1 ≥ 1.7·p2). ' +
              'They give gross liquid; oil = liquid × (1 − water cut). Upstream pressure is gauge, as in Gilbert\'s original chart. ' +
              'Gilbert uses his published form q = p1·S^1.89/(435·R^0.546), R in Mscf/bbl (a = 10.01 with GLR in scf/STB; v3.0, was the rounded 10.00 — rates 0.11 % lower), the same as the Choke Flow Rates and Dual Choke pages. ' +
              'Bean-up: straight wellhead performance line from the shut-in WHP through the current point. ') +
            'A measured current rate tunes the bean equation and is carried to the next beans. Bean-up is a planning screen — the real wellhead performance ' +
            'bends with GLR and reservoir drawdown; step up one bean at a time and re-test.</div>';
        return h;
    }

    var COLORS = ['#8b949e', '#f0883e', '#58a6ff', '#3fb950', '#d2a8ff'];
    function _drawChart(r) {
        var cv = _byId('ck_chart');
        if (!cv || typeof drawLineChart !== 'function') return;   // host-scope helper when injected
        var qCat = r.fluid === 'gas' ? 'gasRateSmall' : 'liquidRate';
        var pTop = Math.max(r.pws != null ? r.pws : 0, r.p1 * 1.25);
        var p0 = r.fluid === 'gas' ? r.pMin : 0;
        var ds = [], N = 40;
        r.chartBeans.forEach(function (s, j) {
            var pts = [];
            for (var i = 0; i <= N; i++) {
                var p = p0 + (pTop - p0) * i / N, q = r.qcAt(s, p);
                if (_fin(q)) pts.push({ x: _dv(p, 'pressureG'), y: _dv(q, qCat) });
            }
            ds.push({ label: s + '/64"' + (s === r.s64 ? ' (now)' : ''), color: s === r.s64 ? COLORS[1] : COLORS[(j + 2) % COLORS.length], data: pts, points: false, width: s === r.s64 ? 2.5 : 1.5, dash: s < r.s64 ? [4, 4] : undefined });
        });
        if (r.pws != null && r.qwAt) {
            var w = [];
            for (var k = 0; k <= N; k++) {
                var pw = p0 + (r.pws - p0) * k / N;
                w.push({ x: _dv(pw, 'pressureG'), y: _dv(r.fluid === 'gas' ? r.qwAt(pw + PATM) : r.qwAt(pw), qCat) });
            }
            ds.push({ label: 'Wellhead performance', color: '#e6edf3', data: w, points: false, width: 1.5, dash: [6, 4] });
        }
        var op = [{ x: _dv(r.p1, 'pressureG'), y: _dv(r.q0, qCat) }];
        r.beanUp.forEach(function (b) { if (b.pwh != null) op.push({ x: _dv(b.pwh, 'pressureG'), y: _dv(b.q, qCat) }); });
        ds.push({ label: 'Operating points', color: '#ff7b72', data: op, points: true, width: 0.001 });
        try {
            drawLineChart(cv, ds, { xLabel: 'Wellhead pressure (' + _lab('pressureG', 'psig') + ')', yLabel: 'Rate (' + _lab(qCat, r.fluid === 'gas' ? 'MSCF/D' : 'BPD') + ')', xMin: _dv(p0, 'pressureG'), yMin: 0, xDec: 0, yDec: 0 });
        } catch (e) { /* chart is cosmetic */ }
    }

    function _readInputs() {
        var fluid = _str('ck_fluid') === 'liquid' ? 'liquid' : 'gas';
        var size = _num('ck_size'), unit = _str('ck_sunit');
        return {
            fluid: fluid, s64: unit === 'in' ? size * 64 : size,
            p1: _num('ck_p1'), p2: _num('ck_p2'), t: _num('ck_t'), sg: _num('ck_sg'), cd: _num('ck_cd'),
            co2: _num('ck_co2'), h2s: _num('ck_h2s'), n2: _num('ck_n2'), k: _num('ck_k'), z: _num('ck_z'), n: _num('ck_n'),
            glr: _num('ck_glr'), wc: _num('ck_wc'), corr: _str('ck_corr'), pws: _num('ck_pws'),
            qm: fluid === 'gas' ? _num('ck_qmg') : _num('ck_qml')
        };
    }

    function _showFields(fluid) {
        GAS_ONLY.forEach(function (id) { var e = _byId(id + '_fg'); if (e && e.style) e.style.display = fluid === 'gas' ? '' : 'none'; });
        LIQ_ONLY.forEach(function (id) { var e = _byId(id + '_fg'); if (e && e.style) e.style.display = fluid === 'liquid' ? '' : 'none'; });
    }

    function _calcImpl() {
        var root = _byId('ck_root'), res = _byId('ck_res');
        if (!root) return null;
        var ins = root.querySelectorAll ? root.querySelectorAll('input, select') : [];
        for (var i = 0; i < ins.length; i++) if (ins[i].classList) ins[i].classList.remove('input-err');
        var inp = _readInputs();
        _showFields(inp.fluid);
        var r = compute(inp);
        G.WTS_state = G.WTS_state || {};
        if (!r.ok) {
            G.WTS_state.chokeperf = { ok: false, errors: r.errors.slice(), q: null, ts: Date.now() };
            var items = '';
            for (var j = 0; j < r.errors.length; j++) {
                var k = r.keys && r.keys[j];
                items += '<li>' + (k && MSG[k] ? MSG[k](r) : r.errors[j]) + '</li>';
            }
            for (var b = 0; b < r.bad.length; b++) {
                var id = r.bad[b] === 'qm' && inp.fluid === 'liquid' ? IDS.qmL : IDS[r.bad[b]];
                var el = _byId(id); if (el && el.classList) el.classList.add('input-err');
            }
            if (res) {
                res.innerHTML = '<div class="val-error"><strong>Please fix the following:</strong><ul>' + items + '</ul></div>';
                res.setAttribute('data-done', '1');
            }
            return r;
        }
        G.WTS_state.chokeperf = {
            ok: true, fluid: r.fluid, s64: r.s64, sizeIn: r.sizeIn, q: r.q, qOil: r.qOil == null ? null : r.qOil, q0: r.q0,
            rc: r.rc, ratio: r.ratio, critical: r.critical, k: r.k == null ? null : r.k, z: r.z == null ? null : r.z,
            kSrc: r.kSrc || null, zSrc: r.zSrc || null, qCrit: r.qCrit == null ? null : r.qCrit, f: r.f, corr: r.corr || null,
            rates: r.rates || null, beanUp: r.beanUp.map(function (x) { return { s64: x.s64, q: x.q, pwh: x.pwh, critical: x.critical }; }),
            ts: Date.now()
        };
        if (res) {
            res.innerHTML = _resultsHtml(r);
            res.setAttribute('data-done', '1');
            _drawChart(r);
        }
        return r;
    }

    G.calcChokePerf = function () { return _canon(_calcImpl); };

    function render(body) {
        if (!body) return;
        var t = _byId('pgTitle'), s = _byId('pgSub');
        if (t) t.textContent = TITLE;
        if (s) s.textContent = SUB;
        body.innerHTML =
            '<div id="ck_root"><div class="cols-2">' +
            '<div>' +
            '<div class="card"><div class="card-title">Bean and Pressures</div><div class="fg">' +
            _sel('ck_fluid', 'Flow through the bean', [['gas', 'Dry gas', true], ['liquid', 'Oil well — gas + liquid (multiphase)']]) +
            _fg('ck_size', 'Bean size', '24', ' min="0"') +
            _sel('ck_sunit', 'Bean size in', [['64', '64ths of an inch', true], ['in', 'Decimal inches']]) +
            _fg('ck_p1', 'Upstream pressure, WHP (psig)', '1500') +
            _fg('ck_p2', 'Downstream pressure (psig)', '400', '', 'Gas: required. Multiphase: optional, for the critical-flow check.') +
            _fg('ck_cd', 'Discharge coefficient Cd', '0.85', ' min="0.5" max="1.2"', 'Typical 0.82–0.86 for positive beans.') +
            _sel('ck_corr', 'Bean correlation (for bean-up)', CORR_KEYS.map(function (k) { return [k, CORR[k].name, k === 'gilbert']; })) +
            '</div></div>' +
            '<div class="card"><div class="card-title">Fluid</div><div class="fg">' +
            _fg('ck_t', 'Upstream temperature (°F)', '120') +
            _fg('ck_sg', 'Gas gravity (air = 1)', '0.7', ' min="0.55"') +
            _fg('ck_co2', 'CO2 (mol %)', '0', ' min="0" max="100"') +
            _fg('ck_h2s', 'H2S (mol %)', '0', ' min="0" max="100"') +
            _fg('ck_n2', 'N2 (mol %)', '0', ' min="0" max="100"') +
            _fg('ck_k', 'Cp/Cv k (blank = Gas PVT)', '', ' min="1" placeholder="calculated"') +
            _fg('ck_z', 'Z at upstream (blank = Gas PVT)', '', ' min="0" placeholder="calculated"') +
            _fg('ck_glr', 'Gas–liquid ratio (SCF/STB)', '800', ' min="0"') +
            _fg('ck_wc', 'Water cut (%)', '0', ' min="0" max="100"') +
            '</div></div>' +
            '<div class="card"><div class="card-title">Bean-up Planning</div><div class="fg">' +
            _fg('ck_pws', 'Shut-in wellhead pressure (psig)', '2500', ' min="0" placeholder="blank = hold WHP"') +
            _fg('ck_qmg', 'Measured gas rate now, optional (MSCFD)', '', ' min="0" placeholder="blank = calculated"') +
            _fg('ck_qml', 'Measured liquid rate now, optional (BPD)', '', ' min="0" placeholder="blank = calculated"') +
            _fg('ck_n', 'Back-pressure exponent n (gas)', '1', ' min="0.5" max="1"', '1 = laminar; 0.5 = fully turbulent.') +
            '</div>' +
            '<div class="btn-row"><button class="btn btn-primary" id="ck_calc" onclick="calcChokePerf()">Calculate</button></div>' +
            '</div>' +
            '</div>' +
            '<div id="ck_res"></div>' +
            '</div></div>';
        _tag(UNITS);
        var root = _byId('ck_root');
        if (root && root.addEventListener) {
            root.addEventListener('change', function (e) {
                if (e && e.target && /^ck_/.test(e.target.id || '')) G.calcChokePerf();
            });
        }
        G.calcChokePerf();
    }
    G.renderChokePerf = render;

    // ── Registry (merge, never replace) ──────────────────────────────
    G.WTS_calcRegistry = G.WTS_calcRegistry || {};
    G.WTS_calcRegistry.chokeperf = {
        key: 'chokeperf',
        title: TITLE,
        navTitle: 'Choke Performance',
        sub: SUB,
        group: 'Well Testing',
        icon: '&#9678;',
        badge: 'Well Testing',
        bc: 'dc-b-green',
        desc: 'Critical ratio, gas rate through a bean (Cd), Gilbert/Ros/Baxendell/Achong multiphase beans, rate vs WHP chart and bean-up planning.',
        render: function (body) { return G.renderChokePerf(body); }
    };

    // Unit flip: recalculate a page that has already shown results.
    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('wts:unit-system-changed', function () {
            var r = _byId('ck_res');
            if (r && r.getAttribute && r.getAttribute('data-done') === '1') G.calcChokePerf();
        });
    }
})();

// ─── END 49-calc-chokeperf ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 49-calc-dispersion ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
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
// Registers window.WTS_calcRegistry.dispersion (group "Safety & Process").
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
        group: 'Safety & Process',
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

// ─── END 49-calc-dispersion ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 49-calc-flowline ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
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
// Registers window.WTS_calcRegistry.flowline (group "Well Testing").
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
        group: 'Well Testing',
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

// ─── END 49-calc-flowline ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 49-calc-fluids ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════
// WTS — Round-9 plug-in calculator — Cement & Completion Fluids (complfluids)
//
// PURPOSE (kept modest, roadmap #17)
//   A. Cement slurry: water requirement and yield of a neat slurry from its
//      density (absolute-volume mass balance), annular and shoe-track slurry
//      volume with open-hole excess, sacks, mix water and displacement.
//   B. Brine blending: density of a blend of two clear brines (volume
//      fractions) and the volumes of each for a target density, with
//      crystallisation-point and compatibility cautions. The salt list and
//      maximum densities are the Well Kill page's brine guide
//      (window.WTS_wellkill_brines, 48-calc-wellkill.js), not a copy.
//
// METHOD (references in brackets)
//   Absolute volume of cement = 1 / (SG·8.33) gal/lb (Class G / H SG 3.14
//   to 3.18 → 0.0382 gal/lb). Per sack of mass m (94 lb US):
//     ρ = (m + 8.33·w) / (m·v_c + w)  →  w = (m − ρ·m·v_c) / (ρ − 8.33)   gal/sk
//     yield Y = (m·v_c + w) / 7.4805 ft³/sk                               [API RP 10B-2 / Nelson & Guillot,
//                                                                            Well Cementing (2006) ch. 4]
//     Check: Class G neat at 15.8 ppg → 4.97 gal/sk (44 % water), 1.15 ft³/sk.
//   Capacities: annulus (Dh² − OD²)/1029.4 bbl/ft, pipe ID²/1029.4 bbl/ft.
//   Slurry = annulus·L·(1 + excess) + shoe track; sacks = slurry ft³ / Y;
//   mix water = sacks·w / 42 bbl; displacement = casing capacity × (shoe − shoe track).
//   Brine blend (ideal volume additivity, mass balance):
//     ρ_mix = (ρA·VA + ρB·VB) / (VA + VB);   VA = V·(ρt − ρB)/(ρA − ρB)    [API RP 13J, clear brine practice]
//
// PUBLIC API (window.*)
//   renderComplFluids(body), calcComplFluids()
//   WTS_complfluids_compute(input) → {ok, cement, blend} (each card validated separately)
//   WTS_cement_slurry(input), WTS_brine_blend(input)
//
// STATE  WTS_state.complfluids = {slurryBbl, sacks, yieldFt3, waterGalSk, mixWaterBbl, dispBbl,
//                                 blendPpg, vA, vB, ts, cement, blend}
// Registers window.WTS_calcRegistry.complfluids (group "Test System Safety", next to Well Kill).
// ════════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    var G = (typeof window !== 'undefined') ? window : globalThis;
    var WATER_PPG = 8.33, GAL_FT3 = 7.4805, GAL_BBL = 42, K_CAP = 1029.4;
    var FT3_BBL = 5.6146;
    // Fallback when the Well Kill page is not loaded (same values, guidance only).
    var FALLBACK = [
        { name: 'Fresh water', ppg: 8.33 }, { name: 'Seawater', ppg: 8.55 },
        { name: 'Potassium chloride, KCl', ppg: 9.7 }, { name: 'Sodium chloride, NaCl', ppg: 10.0 },
        { name: 'Calcium chloride, CaCl2', ppg: 11.6 }, { name: 'Calcium bromide, CaBr2', ppg: 14.2 }
    ];
    function _brines() {
        var b = G.WTS_wellkill_brines;
        return (b && b.length) ? b : FALLBACK;
    }
    function _fin(x) { return typeof x === 'number' && isFinite(x); }
    function _isCa(n) { return /calcium|CaCl2|CaBr2/i.test(n); }
    function _isSulphateOrFormate(n) { return /seawater|formate/i.test(n); }

    // ── A. Cement slurry ─────────────────────────────────────────────
    // input = {dh in (hole), od in (casing OD), cid in (casing ID), shoe ft MD, toc ft MD,
    //          track ft (shoe track), excess %, rho ppg, sgc (cement SG), sack lb}
    function cement(input) {
        var i = input || {}, errors = [], bad = [];
        function need(ok, key, msg) { if (!ok) { errors.push(msg); bad.push(key); } return ok; }
        var dh = Number(i.dh), od = Number(i.od), cid = Number(i.cid), shoe = Number(i.shoe), toc = Number(i.toc);
        var track = Number(i.track), ex = Number(i.excess), rho = Number(i.rho), sgc = Number(i.sgc), sack = Number(i.sack);
        var odOk = need(_fin(od) && od > 0 && od <= 30, 'od', 'Casing OD must be above 0 and no more than 30 in.');
        need(_fin(dh) && dh > 0 && dh <= 48 && (!odOk || dh > od), 'dh', 'Hole diameter must be larger than the casing OD and no more than 48 in.');
        need(_fin(cid) && cid > 0 && (!odOk || cid < od), 'cid', 'Casing ID must be above 0 and below the casing OD.');
        var shoeOk = need(_fin(shoe) && shoe > 0 && shoe <= 40000, 'shoe', 'Casing shoe depth must be above 0 and no more than 40,000 ft.');
        need(_fin(toc) && toc >= 0 && (!shoeOk || toc < shoe), 'toc', 'Top of cement must be 0 or deeper and above the casing shoe.');
        need(_fin(track) && track >= 0 && (!shoeOk || track < shoe), 'track', 'Shoe track length must be 0 or more and shorter than the shoe depth.');
        need(_fin(ex) && ex >= 0 && ex <= 300, 'excess', 'Open-hole excess must be between 0 and 300 %.');
        var sgOk = need(_fin(sgc) && sgc >= 2 && sgc <= 4, 'sgc', 'Cement specific gravity must be between 2 and 4.');
        need(_fin(sack) && sack > 0 && sack <= 200, 'sack', 'Sack weight must be above 0 and no more than 200 lb.');
        var rhoMax = sgOk ? sgc * WATER_PPG : 30;
        need(_fin(rho) && rho > WATER_PPG + 0.5 && rho < rhoMax - 0.5, 'rho', 'Slurry density must lie between water (8.83 ppg) and the dry cement density minus 0.5 ppg.');
        if (errors.length) return { ok: false, errors: errors, bad: bad };

        var vc = 1 / (sgc * WATER_PPG);                 // gal/lb absolute volume
        var absGal = sack * vc;                         // gal per sack
        var w = (sack - rho * absGal) / (rho - WATER_PPG);
        var yieldFt3 = (absGal + w) / GAL_FT3;
        var wcr = w * WATER_PPG / sack;                 // water / cement mass ratio
        var annCap = (dh * dh - od * od) / K_CAP, pipeCap = cid * cid / K_CAP;
        var annLen = shoe - toc;
        var annBbl = annCap * annLen, annEx = annBbl * (1 + ex / 100), trackBbl = pipeCap * track;
        var slurry = annEx + trackBbl, slurryFt3 = slurry * FT3_BBL;
        var sacks = slurryFt3 / yieldFt3;
        var mixWater = sacks * w / GAL_BBL;
        var disp = pipeCap * (shoe - track);
        return {
            ok: true, waterGalSk: w, yieldFt3: yieldFt3, wcr: wcr, absGalSk: absGal,
            annCap: annCap, pipeCap: pipeCap, annLen: annLen, annBbl: annBbl, annExBbl: annEx, excessBbl: annEx - annBbl,
            trackBbl: trackBbl, slurryBbl: slurry, slurryFt3: slurryFt3, sacks: sacks, sacksRounded: Math.ceil(sacks - 1e-9),
            mixWaterBbl: mixWater, dispBbl: disp,
            lowWater: wcr < 0.35, highWater: wcr > 0.60
        };
    }

    // ── B. Brine blend ────────────────────────────────────────────────
    // input = {a, b: brine indices into the guide (or -1 = other), ra, rb ppg, va, vb bbl,
    //          target ppg (blank → none), vt bbl (final volume for the target)}
    function blend(input) {
        var i = input || {}, errors = [], bad = [];
        function need(ok, key, msg) { if (!ok) { errors.push(msg); bad.push(key); } return ok; }
        var list = _brines();
        var ia = parseInt(i.a, 10), ib = parseInt(i.b, 10);
        var A = (ia >= 0 && ia < list.length) ? list[ia] : null, B = (ib >= 0 && ib < list.length) ? list[ib] : null;
        var ra = Number(i.ra), rb = Number(i.rb), va = Number(i.va), vb = Number(i.vb);
        var tgt = (i.target == null || i.target === '' || (typeof i.target === 'number' && isNaN(i.target))) ? null : Number(i.target);
        var vt = Number(i.vt);
        var raOk = need(_fin(ra) && ra >= 6 && ra <= 25, 'ra', 'Brine A density must be between 6 and 25 ppg.');
        var rbOk = need(_fin(rb) && rb >= 6 && rb <= 25, 'rb', 'Brine B density must be between 6 and 25 ppg.');
        need(_fin(va) && va >= 0 && va <= 1e5, 'va', 'Brine A volume must be between 0 and 100,000 bbl.');
        need(_fin(vb) && vb >= 0 && vb <= 1e5 && (!_fin(va) || va + vb > 0), 'vb', 'Brine B volume must be 0 or more, with a total above 0.');
        if (tgt != null) {
            var lo = Math.min(ra, rb), hi = Math.max(ra, rb);
            need(_fin(tgt) && raOk && rbOk && Math.abs(ra - rb) > 1e-6 && tgt >= lo - 1e-9 && tgt <= hi + 1e-9, 'target',
                'Target density must lie between the two brine densities, and the brines must differ.');
            need(_fin(vt) && vt > 0 && vt <= 1e5, 'vt', 'Final blend volume must be above 0 and no more than 100,000 bbl.');
        }
        if (errors.length) return { ok: false, errors: errors, bad: bad };
        var v = va + vb, mix = (ra * va + rb * vb) / v;
        var out = {
            ok: true, a: A ? A.name : 'Other brine', b: B ? B.name : 'Other brine', aMax: A ? A.ppg : null, bMax: B ? B.ppg : null,
            ra: ra, rb: rb, va: va, vb: vb, vol: v, fa: va / v, fb: vb / v, mix: mix, sg: mix / WATER_PPG, kgm3: mix * 119.826,
            target: null, cautions: []
        };
        if (tgt != null) {
            var fa = Math.abs(ra - rb) > 1e-9 ? (tgt - rb) / (ra - rb) : 1;
            out.target = { ppg: tgt, vt: vt, fa: fa, va: vt * fa, vb: vt * (1 - fa) };
        }
        // Cautions (guidance)
        [['A', A, ra], ['B', B, rb]].forEach(function (x) {
            if (!x[1]) return;
            if (x[2] > x[1].ppg + 1e-9) out.cautions.push({ lvl: 'bad', t: 'Brine ' + x[0] + ' is above the usual maximum density of ' + x[1].name + ' (' + x[1].ppg.toFixed(2) + ' ppg). It cannot be made or will crystallise.' });
            else if (x[2] >= 0.97 * x[1].ppg && x[1].ppg > 8.6) out.cautions.push({ lvl: 'warn', t: 'Brine ' + x[0] + ' is within 3 % of the maximum density of ' + x[1].name + ': the crystallisation temperature rises steeply here.' });
        });
        if (A && B && A.name !== B.name) out.cautions.push({ lvl: 'warn', t: 'Two different salts: the blend crystallisation temperature is not the average of the two. Confirm TCT with the supplier.' });
        if (A && B && ((_isCa(A.name) && _isSulphateOrFormate(B.name)) || (_isCa(B.name) && _isSulphateOrFormate(A.name))))
            out.cautions.push({ lvl: 'warn', t: 'Calcium brine with seawater or formate: calcium sulphate, carbonate or formate may precipitate. Test compatibility.' });
        return out;
    }

    function compute(input) {
        var i = input || {};
        return { ok: true, cement: cement(i.cement), blend: blend(i.blend) };
    }
    G.WTS_cement_slurry = cement;
    G.WTS_brine_blend = blend;
    G.WTS_complfluids_compute = compute;

    // ── Page ─────────────────────────────────────────────────────────
    var TITLE = 'Cement & Completion Fluids';
    var SUB = 'Neat cement slurry water requirement, yield, sacks and volumes; two-brine blending density with crystallisation cautions';
    var UNITS = {
        cmf_dh: 'lengthSmall', cmf_od: 'lengthSmall', cmf_cid: 'lengthSmall', cmf_shoe: 'length', cmf_toc: 'length',
        cmf_track: 'length', cmf_ex: 'percent', cmf_rho: 'densityLiquid', cmf_sgc: 'sg', cmf_sack: 'mass',
        cmf_ra: 'densityLiquid', cmf_rb: 'densityLiquid', cmf_va: 'volume', cmf_vb: 'volume', cmf_tgt: 'densityLiquid', cmf_vt: 'volume'
    };
    var CIDS = { dh: 'cmf_dh', od: 'cmf_od', cid: 'cmf_cid', shoe: 'cmf_shoe', toc: 'cmf_toc', track: 'cmf_track', excess: 'cmf_ex', rho: 'cmf_rho', sgc: 'cmf_sgc', sack: 'cmf_sack' };
    var BIDS = { ra: 'cmf_ra', rb: 'cmf_rb', va: 'cmf_va', vb: 'cmf_vb', target: 'cmf_tgt', vt: 'cmf_vt' };

    function _byId(id) { return (typeof document !== 'undefined' && document.getElementById) ? document.getElementById(id) : null; }
    function _num(id) { var e = _byId(id); if (!e) return NaN; var s = String(e.value).trim(); return s === '' ? NaN : parseFloat(s); }
    function _str(id) { var e = _byId(id); return e ? String(e.value) : ''; }
    function _fmt(v, d) {
        if (v == null || !isFinite(v)) return '—';
        return (G.WTS_fmtNum ? G.WTS_fmtNum(v, 0, (d == null ? 2 : d)) : Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: (d == null ? 2 : d) }));
    }
    function _fx(v, d) {
        if (v == null || !isFinite(v)) return '—';
        return (G.WTS_fmtNum ? G.WTS_fmtNum(v, d, d) : Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
    }
    function _metric() { var U = G.WTS_units; return !!(U && U.getSystem && U.getSystem() === 'metric'); }
    function _u(v, cat, d, impLabel, dMet) {
        var U = G.WTS_units;
        if (_metric() && U.format) { var f = U.format(v, cat); return _fmt(f.value, dMet == null ? d : dMet) + ' ' + f.label; }
        return _fmt(v, d) + ' ' + impLabel;
    }
    function _tag(map) { var U = G.WTS_units; if (!U || !U.tagInput) return; for (var id in map) U.tagInput(id, map[id]); }
    function _canon(fn) { var U = G.WTS_units; return (U && U.runCanonical) ? U.runCanonical(fn) : fn(); }
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
    function _den(v) { return _u(v, 'densityLiquid', 2, 'ppg', 3); }
    // v3.1: Metric mode leads with kg/m³ (ppg follows), like the rest of the page.
    function _ppg3(v) {
        return _metric() ? _fmt(v * 119.826, 0) + ' kg/m³ · SG ' + _fx(v / WATER_PPG, 3) + ' · ' + _fx(v, 2) + ' ppg'
                         : _fx(v, 2) + ' ppg · SG ' + _fx(v / WATER_PPG, 3) + ' · ' + _fmt(v * 119.826, 0) + ' kg/m³';
    }
    function _perSack(v, imp, f, met, dImp, dMet) {   // per-sack quantity: metric first in Metric mode
        return _metric() ? _fx(v * f, dMet) + ' ' + met + ' (' + _fx(v, dImp) + ' ' + imp + ')' : _fx(v, dImp) + ' ' + imp + ' (' + _fx(v * f, dMet) + ' ' + met + ')';
    }
    function _ppgText(t) { return _metric() ? String(t).replace(/(\d+(?:\.\d+)?) ppg/g, function (m, x) { return _fmt(parseFloat(x) * 119.826, 0) + ' kg/m³'; }) : t; }
    var V = function (v) { return _u(v, 'volume', 1, 'bbl', 2); };
    var MSG = {
        od: function () { return 'Casing OD must be above 0 and no more than ' + _u(30, 'lengthSmall', 0, 'in') + '.'; },
        dh: function () { return 'Hole diameter must be larger than the casing OD and no more than ' + _u(48, 'lengthSmall', 0, 'in') + '.'; },
        shoe: function () { return 'Casing shoe depth must be above 0 and no more than ' + _u(40000, 'length', 0, 'ft') + '.'; },
        rho: function () { return 'Slurry density must lie between water (' + _den(8.83) + ') and the dry cement density minus ' + _den(0.5) + '.'; },
        sack: function () { return 'Sack weight must be above 0 and no more than ' + _u(200, 'mass', 0, 'lb') + '.'; },
        ra: function () { return 'Brine A density must be between ' + _den(6) + ' and ' + _den(25) + '.'; },
        rb: function () { return 'Brine B density must be between ' + _den(6) + ' and ' + _den(25) + '.'; },
        va: function () { return 'Brine A volume must be between 0 and ' + _u(1e5, 'volume', 0, 'bbl') + '.'; },
        vt: function () { return 'Final blend volume must be above 0 and no more than ' + _u(1e5, 'volume', 0, 'bbl') + '.'; }
    };
    function _errors(resId, ids, r) {
        var res = _byId(resId), items = '', seen = {};
        r.bad.forEach(function (k, j) {
            var el = _byId(ids[k]); if (el && el.classList) el.classList.add('input-err');
            if (seen[k]) return; seen[k] = 1;
            items += '<li>' + (MSG[k] ? MSG[k]() : r.errors[j]) + '</li>';
        });
        if (res) { res.innerHTML = '<div class="val-error"><strong>Please fix the following:</strong><ul>' + items + '</ul></div>'; res.setAttribute('data-done', '1'); }
    }

    function _paintCement(r) {
        var res = _byId('cmf_cres');
        if (!res) return;
        if (!r.ok) { _errors('cmf_cres', CIDS, r); return; }
        var v = '';
        if (r.lowWater) v += _warn('Water-to-cement ratio ' + _fx(r.wcr, 2) + ' is below about 0.35: a dispersant is needed to mix and pump this slurry.');
        else if (r.highWater) v += _warn('Water-to-cement ratio ' + _fx(r.wcr, 2) + ' is above about 0.60: expect free water and low strength without an extender.');
        else v += _ok('Water-to-cement ratio ' + _fx(r.wcr, 2) + ' is in the normal neat-slurry range.');
        res.innerHTML =
            '<div class="rbox"><div class="rbox-title">Slurry Design</div>' +
            _row('Water requirement', _perSack(r.waterGalSk, 'gal/sack', 3.78541, 'L/sack', 2, 1)) +
            _row('Water-to-cement ratio', _fx(r.wcr * 100, 1) + ' % by mass') +
            _row('Slurry yield', _perSack(r.yieldFt3, 'ft³/sack', 28.3168, 'L/sack', 3, 1)) +
            v + '</div>' +
            '<div class="rbox"><div class="rbox-title">Slurry Volume &amp; Sacks</div>' +
            _tbl(['Section', 'Length', 'Capacity', 'Volume'], [
                ['Annulus, casing x hole', _u(r.annLen, 'length', 0, 'ft', 1), _u(r.annCap, 'capacity', 5, 'bbl/ft', 5), V(r.annBbl)],
                ['Open-hole excess', '', '', V(r.excessBbl)],
                ['Shoe track', '', _u(r.pipeCap, 'capacity', 5, 'bbl/ft', 5), V(r.trackBbl)]
            ]) +
            _row('Total slurry', V(r.slurryBbl) + (_metric() ? '' : ' (' + _fmt(r.slurryFt3, 0) + ' ft³)')) +
            _row('Cement', _fmt(r.sacksRounded, 0) + ' sacks') +
            _row('Mix water', V(r.mixWaterBbl)) +
            _row('Displacement to the float collar', V(r.dispBbl)) +
            _note('Neat cement only: additives change the absolute volume and water demand, so use the laboratory yield for a ' +
                'designed slurry. Yield and water from the absolute-volume mass balance (API RP 10B-2). Excess applies to the ' +
                'open-hole annulus; use a caliper log where available.') +
            '</div>';
        res.setAttribute('data-done', '1');
    }

    function _paintBlend(r) {
        var res = _byId('cmf_bres');
        if (!res) return;
        if (!r.ok) { _errors('cmf_bres', BIDS, r); return; }
        var h = '<div class="rbox"><div class="rbox-title">Brine Blend</div>' +
            _tbl(['Brine', 'Density', 'Volume', 'Fraction', 'Guide max'], [
                ['A: ' + r.a, _den(r.ra), V(r.va), _fx(r.fa * 100, 1) + ' %', r.aMax == null ? '—' : _den(r.aMax)],
                ['B: ' + r.b, _den(r.rb), V(r.vb), _fx(r.fb * 100, 1) + ' %', r.bMax == null ? '—' : _den(r.bMax)]
            ]) +
            _row('Blend volume', V(r.vol)) +
            _row('Blend density', _ppg3(r.mix));
        if (r.target) {
            h += _row('Target density', _ppg3(r.target.ppg)) +
                _row('Brine A for target', V(r.target.va) + ' (' + _fx(r.target.fa * 100, 1) + ' %)') +
                _row('Brine B for target', V(r.target.vb));
        }
        var v = r.cautions.map(function (c) { return c.lvl === 'bad' ? _bad(_ppgText(c.t)) : _warn(_ppgText(c.t)); }).join('');
        if (!r.cautions.length) v = _ok('No crystallisation or compatibility flags for this pair.');
        h += v + _note('Densities at surface temperature (about 70 °F). Volumes are taken as additive; real blends can shrink by up to about 1 %. ' +
            'Brine density falls as temperature rises. The crystallisation temperature (TCT) rises steeply near the maximum density ' +
            'and with pressure; order the blend to a TCT below the lowest temperature it will see, including seabed and surface lines. ' +
            'Guide densities from the Well Kill page brine guide.') + '</div>';
        res.innerHTML = h;
        res.setAttribute('data-done', '1');
    }

    function _readCement() {
        return { dh: _num('cmf_dh'), od: _num('cmf_od'), cid: _num('cmf_cid'), shoe: _num('cmf_shoe'), toc: _num('cmf_toc'),
            track: _num('cmf_track'), excess: _num('cmf_ex'), rho: _num('cmf_rho'), sgc: _num('cmf_sgc'), sack: _num('cmf_sack') };
    }
    function _readBlend() {
        return { a: _str('cmf_a'), b: _str('cmf_b'), ra: _num('cmf_ra'), rb: _num('cmf_rb'), va: _num('cmf_va'), vb: _num('cmf_vb'),
            target: _num('cmf_tgt'), vt: _num('cmf_vt') };
    }
    function _calcImpl() {
        var root = _byId('cmf_root');
        if (!root) return null;
        var ins = root.querySelectorAll ? root.querySelectorAll('input,select') : [];
        for (var n = 0; n < ins.length; n++) if (ins[n].classList) ins[n].classList.remove('input-err');
        var c = cement(_readCement()), b = blend(_readBlend());
        _paintCement(c);
        _paintBlend(b);
        G.WTS_state = G.WTS_state || {};
        G.WTS_state.complfluids = {
            slurryBbl: c.ok ? c.slurryBbl : null, sacks: c.ok ? c.sacks : null, yieldFt3: c.ok ? c.yieldFt3 : null,
            waterGalSk: c.ok ? c.waterGalSk : null, mixWaterBbl: c.ok ? c.mixWaterBbl : null, dispBbl: c.ok ? c.dispBbl : null,
            blendPpg: b.ok ? b.mix : null, vA: b.ok && b.target ? b.target.va : null, vB: b.ok && b.target ? b.target.vb : null,
            ts: Date.now(), cement: c, blend: b
        };
        return { cement: c, blend: b };
    }
    G.calcComplFluids = function () { return _canon(_calcImpl); };

    function render(body) {
        if (!body) return;
        var t = _byId('pgTitle'), s = _byId('pgSub');
        if (t) t.textContent = TITLE;
        if (s) s.textContent = SUB;
        var bl = _brines();
        var opts = bl.map(function (b, k) { return { v: String(k), t: b.name + ' (max ' + b.ppg.toFixed(1) + ' ppg)' }; });
        opts.push({ v: '-1', t: 'Other brine' });
        function idx(re, def) { for (var k = 0; k < bl.length; k++) if (re.test(bl[k].name)) return String(k); return def; }
        var btn = '<div class="btn-row"><button class="btn btn-primary" onclick="calcComplFluids()">Calculate</button></div>';
        body.innerHTML =
            '<div id="cmf_root"><div class="cols-2">' +
            '<div>' +
            '<div class="card"><div class="card-title">Cement Slurry</div><div class="fg">' +
            _fg('cmf_dh', 'Hole diameter (in)', '8.5', ' min="0"') +
            _fg('cmf_od', 'Casing OD (in)', '7', ' min="0"') +
            _fg('cmf_cid', 'Casing ID (in)', '6.276', ' min="0"') +
            _fg('cmf_shoe', 'Casing shoe depth, MD (ft)', '10000', ' min="0"') +
            _fg('cmf_toc', 'Top of cement, MD (ft)', '8000', ' min="0"') +
            _fg('cmf_track', 'Shoe track length (ft)', '80', ' min="0"') +
            _fg('cmf_ex', 'Open-hole excess (%)', '20', ' min="0"') +
            _fg('cmf_rho', 'Slurry density (ppg)', '15.8', ' min="0"') +
            _fg('cmf_sgc', 'Cement specific gravity', '3.14', ' min="0"') +
            _fg('cmf_sack', 'Sack weight (lb)', '94', ' min="0"') +
            '</div>' + btn.replace('<button', '<button id="cmf_calc"') + '<div id="cmf_cres" style="margin-top:14px"></div></div>' +
            '</div>' +
            '<div>' +
            '<div class="card"><div class="card-title">Brine Blending</div><div class="fg">' +
            _sel('cmf_a', 'Brine A', opts, idx(/^Calcium bromide/i, '0')) +
            _fg('cmf_ra', 'Brine A density (ppg)', '14.2', ' min="0"') +
            _fg('cmf_va', 'Brine A volume (bbl)', '100', ' min="0"') +
            _sel('cmf_b', 'Brine B', opts, idx(/^Calcium chloride/i, '0')) +
            _fg('cmf_rb', 'Brine B density (ppg)', '11.6', ' min="0"') +
            _fg('cmf_vb', 'Brine B volume (bbl)', '100', ' min="0"') +
            _fg('cmf_tgt', 'Target density, optional (ppg)', '13.0', ' min="0"') +
            _fg('cmf_vt', 'Final blend volume for the target (bbl)', '300', ' min="0"') +
            '</div>' + btn.replace('<button', '<button id="cmf_bcalc"') + '<div id="cmf_bres" style="margin-top:14px"></div></div>' +
            '</div>' +
            '</div></div>';
        _tag(UNITS);
        var root = _byId('cmf_root');
        if (root && root.addEventListener) {
            root.addEventListener('change', function (e) {
                if (e && e.target && /^cmf_/.test(e.target.id || '')) G.calcComplFluids();
            });
        }
        G.calcComplFluids();
    }
    G.renderComplFluids = render;

    G.WTS_calcRegistry = G.WTS_calcRegistry || {};
    G.WTS_calcRegistry.complfluids = {
        key: 'complfluids',
        title: TITLE,
        navTitle: 'Cement & Brines',
        sub: SUB,
        group: 'Test System Safety',
        icon: '&#9707;',
        badge: 'Completions',
        bc: 'dc-b-blue',
        desc: 'Neat cement water requirement, yield, sacks and displacement; two-brine blend density and target volumes with crystallisation cautions.',
        render: function (body) { return G.renderComplFluids(body); }
    };

    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('wts:unit-system-changed', function () {
            var ids = ['cmf_cres', 'cmf_bres'];
            for (var n = 0; n < ids.length; n++) {
                var r = _byId(ids[n]);
                if (r && r.getAttribute && r.getAttribute('data-done') === '1') { G.calcComplFluids(); return; }
            }
        });
    }
})();

// ─── END 49-calc-fluids ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 49-calc-gaslift ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
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

// ─── END 49-calc-gaslift ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 49-calc-lineheat ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
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
//   WTS_lineheat_ua(seg, T, env)  overall UA' per foot (used by the flowline coupled P–T march)
//   WTS_lineheat_massFlow(f)      stream mass flows and ṁ·cp
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

    // Mass flows (lb/hr) and ṁ·cp (Btu/hr·°F) of the stream; gas from the ideal-gas molar
    // volume at the standard conditions (22-units WTS_baseConditions, default 60 °F / 14.696 psia).
    function massFlow(f) {
        var B = G.WTS_baseConditions, b = (B && B.resolve) ? B.resolve(60, 14.696) : null;
        if (!(b && _fin(b.Tb_F) && _fin(b.Pb_psia))) b = { Tb_F: 60, Pb_psia: 14.696 };
        var vm = R_GAS * (b.Tb_F + RANK) / b.Pb_psia;              // scf/lb-mol
        var go = 141.5 / (131.5 + (+f.api));
        var mo = (+f.qo || 0) * FT3_BBL * RHO_W * go / 24, mw = (+f.qw || 0) * FT3_BBL * RHO_W * (+f.sgw) / 24;
        var mg = (+f.qg || 0) * 1e6 / vm * MW_AIR * (+f.sgg) / 24;
        return { mo: mo, mw: mw, mg: mg, m: mo + mw + mg, mcp: mo * (+f.cpo) + mw * (+f.cpw) + mg * (+f.cpg), molarVolume: vm };
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
        var mf = massFlow({ qo: qo, qw: qw, qg: qg, api: api, sgg: sgg, sgw: sgw, cpo: cpo, cpw: cpw, cpg: cpg });
        var vm = mf.molarVolume, mo = mf.mo, mw = mf.mw, mg = mf.mg, m = mf.m, mcp = mf.mcp;
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
    // For the coupled pressure–temperature march of the flowline page (49-calc-flowline.js):
    //   WTS_lineheat_ua(seg {di, od, ds in, type 'bare'|'ins'|'buried', depth ft}, T °F, env) → {ua Btu/hr·ft·°F, ta, …}
    //   WTS_lineheat_massFlow({qo, qw, qg, api, sgg, sgw, cpo, cpw, cpg}) → {mo, mw, mg, m lb/hr, mcp Btu/hr·°F}
    G.WTS_lineheat_ua = ua;
    G.WTS_lineheat_massFlow = massFlow;

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

// ─── END 49-calc-lineheat ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 49-calc-proving ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════
// WTS — Round-9 plug-in calculator — Meter Proving & Net Standard Volume (proving)
//
// PURPOSE (docs/ROADMAP.md §1.2 #13, with #18 folded in)
//   • Meter factor from pipe-prover runs (API MPMS Ch. 4.8 / 12.2.3):
//       MF = GSVp / ISVm = (BPV·CTSp·CPSp·CTLp·CPLp) / (IVm·CTLm·CPLm)
//     average-data method for the final MF (run averages of IV, T and P), plus
//     each run's intermediate MF and the average-meter-factor method;
//     repeatability = (max − min)/min of the run meter factors against the
//     MPMS 4.8 Table A-1 limits for ±0.027 % MF uncertainty
//     (3 runs 0.02 %, 4 0.03 %, 5 0.05 %, 6 0.06 %, 7 0.08 %, 8 0.09 %, 9 0.10 %, 10 0.12 %).
//   • CTL from API MPMS 11.1 (1980) / ASTM D1250 Tables 6A–6D, closed form:
//       α60 = K0/ρ60² + K1/ρ60   (transition zone: α60 = A + B/ρ60²)
//       CTL = exp[−α60·Δt·(1 + 0.8·α60·Δt)],  Δt = t − 60 °F
//     crude oils K0 = 341.0957, K1 = 0 (the host Fluid Properties / Oil & Gas
//     Rate pages use the same equation); refined-product groups are offered.
//     Observed API at the hydrometer temperature → API @ 60 °F by the Table 5
//     iteration with the glass-hydrometer correction 1 − 1.278e-5·Δt − 6.2e-9·Δt².
//   • CPL from API MPMS 11.2.1 (1984) / 11.1-2004 compressibility:
//       F = exp(−1.9947 + 0.00013427·t + (793920 + 2326·t)/ρ60²) × 10⁻⁵  [1/psi]
//       CPL = 1 / [1 − F·(P − Pe)],  P and Pe gauge (Pe below 0 psig taken as 0)
//   • Prover steel: CTSp = 1 + (Tp − 60)·Gc, CPSp = 1 + Pp·ID/(E·wt)
//     (API MPMS 12.2.3 / 12.2 Part 1 steel constants).
//   • Measurement ticket (API MPMS 12.2.2): IV → CCF = CTL·CPL·MF → GSV = IV·CCF
//     → CSW = 1 − S&W/100 → NSV = GSV·CSW, with an audit-trail table.
//     Optional MPMS 12.2 discrimination levels: ticket CTL, CPL, CCF, CSW to
//     4 decimals and volumes to 0.01 bbl; proving factors to 5 decimals and the
//     meter factor to 4 decimals.
//   • #18 Oil & gas BS&W / shrinkage audit trail: reproduces the Oil & Gas
//     Rate page's net-oil chain one factor at a time:
//       rate = (m1 − m0)·MF·VCF(Table 6A)·(1 − BS&W)·shrinkage·1440/interval
//
// PUBLIC API (window.*)
//   renderProving(body), calcProving(), copyOilGasToProving()
//   WTS_proving_compute(input)          → {ok, liquid, prove, ticket, audit, errors[]}
//   WTS_proving_ctl(api60, tF, group)   → CTL (unrounded)
//   WTS_proving_fp(api60, tF)           → F (1/psi)
//   WTS_proving_api60(apiObs, tF, group)→ {api60, rho60, ctl}
//   WTS_proving_ticketChain({iv, ctl, cpl, mf, sw, round}) → audit rows
// STATE
//   WTS_state.proving = {ok, mf, mfAvgMethod, rangePct, repeatOk, gsv, nsv, auditRate, ts}
// ════════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    var G = (typeof window !== 'undefined') ? window : globalThis;
    var RHO_W = 999.012;   // kg/m³, water at 60 °F (MPMS 11.1-1980)
    var NR = 10;           // prover-run rows

    // API MPMS 11.1 (1980) commodity groups, ρ60 in kg/m³.
    var GROUPS = {
        crude:    { name: 'Crude oil (Table 6A)', K0: 341.0957, K1: 0, lo: 610.5, hi: 1075.0 },
        gasoline: { name: 'Gasolines (Table 6B)', K0: 192.4571, K1: 0.2438, lo: 653.0, hi: 770.5 },
        trans:    { name: 'Transition zone (Table 6B)', A: -0.00186840, B: 1489.0670, lo: 770.5, hi: 788.0 },
        jet:      { name: 'Jet fuels (Table 6B)', K0: 330.3010, K1: 0, lo: 788.0, hi: 839.0 },
        fuel:     { name: 'Fuel oils (Table 6B)', K0: 103.8720, K1: 0.2701, lo: 839.0, hi: 1075.0 },
        lube:     { name: 'Lubricating oils (Table 6D)', K0: 0, K1: 0.34878, lo: 800.9, hi: 1163.5 }
    };
    // Prover steel: cubical expansion Gc (1/°F) and modulus E (psi) — API MPMS 12.2.
    var STEELS = {
        cs:    { name: 'Carbon steel', Gc: 1.86e-5, E: 3.0e7 },
        ss304: { name: 'Stainless 304', Gc: 2.88e-5, E: 2.8e7 },
        ss316: { name: 'Stainless 316', Gc: 2.65e-5, E: 2.8e7 },
        ph17:  { name: 'Stainless 17-4PH', Gc: 1.20e-5, E: 2.85e7 }
    };
    // MPMS 4.8 Table A-1: range limit (%) for ±0.027 % MF uncertainty by number of runs.
    var REPEAT = { 3: 0.02, 4: 0.03, 5: 0.05, 6: 0.06, 7: 0.08, 8: 0.09, 9: 0.10, 10: 0.12 };

    // ── Helpers ──────────────────────────────────────────────────────
    function _byId(id) { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }
    function _str(id) { var e = _byId(id); return e ? String(e.value) : ''; }
    function _chk(id) { var e = _byId(id); return !!(e && e.checked); }
    function _num(id) { var e = _byId(id); if (!e) return NaN; var s = String(e.value).trim(); return s === '' ? NaN : parseFloat(s); }
    function _fin(x) { return typeof x === 'number' && isFinite(x); }
    function _blank(x) { return x === '' || x == null || (typeof x === 'number' && isNaN(x)); }
    function _fmt(v, d) {
        if (v == null || !isFinite(v)) return '—';
        return (G.WTS_fmtNum ? G.WTS_fmtNum(v, (d == null ? 2 : d), (d == null ? 2 : d)) : Number(v).toLocaleString(undefined, { minimumFractionDigits: (d == null ? 2 : d), maximumFractionDigits: (d == null ? 2 : d) }));
    }
    function _fx(v, d) { return (v == null || !isFinite(v)) ? '—' : Number(v).toFixed(d); }
    function _metric() { var U = G.WTS_units; return !!(U && U.getSystem && U.getSystem() === 'metric' && U.format); }
    function _u(v, cat, d, impLabel, dMet) {
        if (v == null || !isFinite(v)) return '—';
        if (_metric()) { var f = G.WTS_units.format(v, cat); return _fmt(f.value, dMet == null ? d : dMet) + ' ' + f.label; }
        return _fmt(v, d) + ' ' + impLabel;
    }
    function _dv(v, cat) { return _metric() ? G.WTS_units.format(v, cat).value : v; }
    function _lab(cat, impLabel) { return _metric() ? G.WTS_units.format(1, cat).label : impLabel; }
    function _tag(map) { var U = G.WTS_units; if (!U || !U.tagInput) return; for (var id in map) U.tagInput(id, map[id]); }
    function _canon(fn) { var U = G.WTS_units; return (U && U.runCanonical) ? U.runCanonical(fn) : fn(); }
    // MPMS 12.2 rounding: round half away from zero at the stated decimal.
    function _rnd(x, dp) { var f = Math.pow(10, dp); return (x < 0 ? -1 : 1) * Math.floor(Math.abs(x) * f + 0.5 + 1e-9) / f; }

    // ── Pure compute ─────────────────────────────────────────────────
    function _grp(g) { return GROUPS[g] || GROUPS.crude; }
    function rho60Of(api60) { return 141.5 * RHO_W / (api60 + 131.5); }
    function alpha60(rho, group) {
        var c = _grp(group);
        return c.A != null ? c.A + c.B / (rho * rho) : c.K0 / (rho * rho) + c.K1 / rho;
    }
    function ctlRho(rho, tF, group) {
        var a = alpha60(rho, group), dt = tF - 60;
        return Math.exp(-a * dt * (1 + 0.8 * a * dt));
    }
    function ctl(api60, tF, group) { return ctlRho(rho60Of(api60), tF, group); }
    // Table 5 style: observed hydrometer API at tF → API @ 60 °F (iterative, glass-hydrometer correction).
    function api60(apiObs, tF, group) {
        var dt = tF - 60;
        var rhoObs = 141.5 * RHO_W / (apiObs + 131.5) * (1 - 1.278e-5 * dt - 6.2e-9 * dt * dt);
        var rho = rhoObs, c = 1;
        for (var i = 0; i < 50; i++) {
            c = ctlRho(rho, tF, group);
            var nx = rhoObs / c;
            if (Math.abs(nx - rho) < 1e-9) { rho = nx; break; }
            rho = nx;
        }
        return { api60: 141.5 * RHO_W / rho - 131.5, rho60: rho, ctl: c };
    }
    // MPMS 11.2.1 compressibility factor, 1/psi.
    function fpRho(rho, tF) { return 1e-5 * Math.exp(-1.9947 + 0.00013427 * tF + (793920 + 2326 * tF) / (rho * rho)); }
    function fp(api60v, tF) { return fpRho(rho60Of(api60v), tF); }
    function cplOf(F, pPsig, pe) {
        var d = pPsig - Math.max(pe || 0, 0);
        return d > 0 ? 1 / (1 - F * d) : 1;
    }

    // MPMS 12.2.2 ticket chain from the factors.
    function ticketChain(t) {
        var R = t.round !== false;
        var iv = R ? _rnd(t.iv, 2) : t.iv;
        var CTL = R ? _rnd(t.ctl, 4) : t.ctl, CPL = R ? _rnd(t.cpl, 4) : t.cpl, MF = R ? _rnd(t.mf, 4) : t.mf;
        var CCF = CTL * CPL * MF; if (R) CCF = _rnd(CCF, 4);
        var gsv = iv * CCF; if (R) gsv = _rnd(gsv, 2);
        var csw = 1 - (t.sw || 0) / 100; if (R) csw = _rnd(csw, 4);
        var nsv = gsv * csw; if (R) nsv = _rnd(nsv, 2);
        return { iv: iv, ctl: CTL, cpl: CPL, mf: MF, ccf: CCF, gsv: gsv, csw: csw, nsv: nsv, swv: R ? _rnd(gsv - nsv, 2) : gsv - nsv, round: R };
    }

    function _proveFactors(o, liq, steel, R) {
        // o = {iv, tp, pp, tm, pm}
        var r5 = function (x) { return R ? _rnd(x, 5) : x; };
        var ctsp = r5(1 + (o.tp - 60) * steel.Gc);
        var cpsp = r5(1 + o.pp * liq.proverId / (steel.E * liq.wall));
        var ctlp = r5(ctlRho(liq.rho60, o.tp, liq.group));
        var cplp = r5(cplOf(fpRho(liq.rho60, o.tp), o.pp, liq.pe));
        var ctlm = r5(ctlRho(liq.rho60, o.tm, liq.group));
        var cplm = r5(cplOf(fpRho(liq.rho60, o.tm), o.pm, liq.pe));
        var ccfp = r5(ctsp * cpsp * ctlp * cplp);
        var ccfm = r5(ctlm * cplm);
        var gsvp = liq.bpv * ccfp, isvm = o.iv * ccfm;
        return { ctsp: ctsp, cpsp: cpsp, ctlp: ctlp, cplp: cplp, ccfp: ccfp, ctlm: ctlm, cplm: cplm, ccfm: ccfm, gsvp: gsvp, isvm: isvm, mf: gsvp / isvm };
    }

    function compute(input) {
        var i = input || {};
        var n = function (x) { return _blank(x) ? NaN : Number(x); };
        var R = i.round !== false;
        var errors = [], bad = [], keys = [];
        function err(k, m) { errors.push(m); keys.push(k); if (bad.indexOf(k) === -1) bad.push(k); }

        // Liquid
        var group = GROUPS[i.group] ? i.group : 'crude';
        var apiObs = n(i.apiObs), tHyd = n(i.tHyd), pe = _blank(i.pe) ? 0 : Number(i.pe);
        if (!(_fin(apiObs) && apiObs >= 0 && apiObs <= 100)) err('apiObs', 'Observed gravity must be between 0 and 100 °API.');
        if (!(_fin(tHyd) && tHyd >= 0 && tHyd <= 300)) err('tHyd', 'Hydrometer temperature must be between 0 and 300 °F.');
        if (!(_fin(pe) && pe >= -14.696 && pe <= 1000)) err('pe', 'Equilibrium vapour pressure must be between -14.7 and 1,000 psig.');
        // Prover
        var steel = STEELS[i.steel] || STEELS.cs;
        var bpv = n(i.bpv), pid = n(i.proverId), wall = n(i.wall);
        if (!(_fin(bpv) && bpv > 0 && bpv <= 10000)) err('bpv', 'Prover base volume must be above 0 and no more than 10,000 bbl.');
        if (!(_fin(pid) && pid > 0 && pid <= 60)) err('proverId', 'Prover inside diameter must be above 0 and no more than 60 in.');
        if (!(_fin(wall) && wall > 0 && wall < pid / 2)) err('wall', 'Prover wall thickness must be above 0 and less than half the inside diameter.');
        var liqErr = errors.length > 0;
        var liq = null;
        if (!liqErr) {
            var a = api60(apiObs, tHyd, group);
            liq = { group: group, apiObs: apiObs, tHyd: tHyd, api60: a.api60, rho60: a.rho60, ctlHyd: a.ctl, pe: pe,
                bpv: bpv, proverId: pid, wall: wall, steel: steel, warnings: [] };
            var gr = _grp(group);
            if (liq.rho60 < gr.lo || liq.rho60 > gr.hi) liq.warnings.push('Density at 60 °F (' + _fmt(liq.rho60, 1) + ' kg/m³) is outside the ' + gr.name + ' range ' + _fmt(gr.lo, 1) + '–' + _fmt(gr.hi, 1) + ' kg/m³.');
        }

        // Prover runs
        var runs = [];
        (Array.isArray(i.runs) ? i.runs : []).forEach(function (r, k) {
            if (!r) return;
            var iv = n(r.iv), tp = n(r.tp), pp = n(r.pp), tm = n(r.tm), pm = n(r.pm);
            if (!_fin(iv)) return;
            var row = k + 1;
            if (!(iv > 0)) err('run' + row, 'Run ' + row + ': meter volume must be greater than zero.');
            else if (!(_fin(tp) && _fin(tm) && tp >= -40 && tp <= 300 && tm >= -40 && tm <= 300)) err('run' + row, 'Run ' + row + ': prover and meter temperatures must be between -40 and 300 °F.');
            else if (!(_fin(pp) && _fin(pm) && pp >= 0 && pm >= 0 && pp <= 3000 && pm <= 3000)) err('run' + row, 'Run ' + row + ': prover and meter pressures must be between 0 and 3,000 psig.');
            else runs.push({ row: row, iv: iv, tp: tp, pp: pp, tm: tm, pm: pm });
        });
        var prevMf = n(i.prevMf), mfTol = _blank(i.mfTol) ? 0.25 : Number(i.mfTol);
        if (!_blank(i.prevMf) && !(_fin(prevMf) && prevMf > 0.5 && prevMf < 1.5)) err('prevMf', 'Previous meter factor must be between 0.5 and 1.5, or blank.');
        if (!(_fin(mfTol) && mfTol > 0 && mfTol <= 10)) err('mfTol', 'Meter-factor change limit must be between 0 and 10 %.');

        var prove = null;
        if (liq && !errors.length) {
            if (runs.length < 3) {
                prove = { ok: false, reason: 'At least three prover runs with a meter volume are needed (MPMS 4.8); ' + runs.length + ' entered.' };
            } else {
                runs.forEach(function (r) { r.f = _proveFactors(r, liq, steel, R); r.mfRun = R ? _rnd(r.f.mf, 4) : r.f.mf; r.mfRaw = r.f.mf; });
                var mean = function (k) { return runs.reduce(function (s, r) { return s + r[k]; }, 0) / runs.length; };
                var avg = { iv: mean('iv'), tp: mean('tp'), pp: mean('pp'), tm: mean('tm'), pm: mean('pm') };
                if (R) { avg.tp = _rnd(avg.tp, 1); avg.tm = _rnd(avg.tm, 1); avg.pp = _rnd(avg.pp, 0); avg.pm = _rnd(avg.pm, 0); avg.iv = _rnd(avg.iv, 4); }
                var fa = _proveFactors(avg, liq, steel, R);
                var mf = R ? _rnd(fa.mf, 4) : fa.mf;
                var mfs = runs.map(function (r) { return r.mfRaw; });
                var mx = Math.max.apply(null, mfs), mn = Math.min.apply(null, mfs);
                var rangePct = 100 * (mx - mn) / mn;
                var ivs = runs.map(function (r) { return r.iv; });
                var ivRangePct = 100 * (Math.max.apply(null, ivs) - Math.min.apply(null, ivs)) / Math.min.apply(null, ivs);
                var lim = REPEAT[runs.length];
                var mfAvgMethod = mfs.reduce(function (s, v) { return s + v; }, 0) / mfs.length;
                if (R) mfAvgMethod = _rnd(mfAvgMethod, 4);
                prove = {
                    ok: true, runs: runs, avg: avg, factors: fa, mf: mf, mfRaw: fa.mf, mfAvgMethod: mfAvgMethod,
                    rangePct: rangePct, ivRangePct: ivRangePct, limitPct: lim, repeatOk: rangePct <= lim + 1e-12,
                    prevMf: _fin(prevMf) ? prevMf : null, mfTol: mfTol,
                    mfChangePct: _fin(prevMf) ? 100 * (mf - prevMf) / prevMf : null
                };
            }
        }

        // Ticket
        var t = i.ticket || {};
        var ticket = null;
        var tO = n(t.open), tC = n(t.close), tT = n(t.tm), tP = n(t.pm), tSW = n(t.sw), tMF = n(t.mf);
        if (!(_fin(tO) && _fin(tC) && tC > tO)) err('tclose', 'Ticket: closing meter reading must be above the opening reading.');
        if (!(_fin(tT) && tT >= -40 && tT <= 300)) err('ttm', 'Ticket: meter temperature must be between -40 and 300 °F.');
        if (!(_fin(tP) && tP >= 0 && tP <= 3000)) err('tpm', 'Ticket: meter pressure must be between 0 and 3,000 psig.');
        if (!(_fin(tSW) && tSW >= 0 && tSW < 100)) err('tsw', 'Ticket: S&W must be between 0 and 100 %.');
        if (!_blank(t.mf) && !(_fin(tMF) && tMF > 0.5 && tMF < 1.5)) err('tmf', 'Ticket: meter factor must be between 0.5 and 1.5, or blank to use the proven factor.');
        if (liq && !errors.length) {
            var mfT = _fin(tMF) ? tMF : (prove && prove.ok ? prove.mf : NaN);
            if (!_fin(mfT)) ticket = { ok: false, reason: 'No meter factor: prove the meter (three or more runs) or type the factor.' };
            else {
                var cTL = ctlRho(liq.rho60, tT, group), F = fpRho(liq.rho60, tT), cPL = cplOf(F, tP, liq.pe);
                var ch = ticketChain({ iv: tC - tO, ctl: cTL, cpl: cPL, mf: mfT, sw: tSW, round: R });
                ch.ok = true; ch.mfSrc = _fin(tMF) ? 'typed' : 'proven'; ch.ctlRaw = cTL; ch.cplRaw = cPL; ch.F = F; ch.tm = tT; ch.pm = tP; ch.sw = tSW;
                ticket = ch;
            }
        }

        // #18 audit trail (the Oil & Gas Rate page's net-oil chain; crude Table 5A/6A as that page)
        var au = i.audit || {};
        var audit = null;
        var aInt = n(au.interval), aApi = n(au.apiObs), aHt = n(au.tHyd), aM0 = n(au.m0), aM1 = n(au.m1), aT = n(au.tLine),
            aBsw = n(au.bsw), aMf = n(au.mf), aShr = n(au.shr), aP = n(au.pLine), aGas = n(au.gas);
        if (!(_fin(aInt) && aInt > 0)) err('aint', 'Audit trail: interval must be greater than zero.');
        if (!(_fin(aApi) && aApi > 0 && aApi <= 100)) err('aapi', 'Audit trail: API gravity must be above 0 and no more than 100.');
        if (!(_fin(aHt) && _fin(aT))) err('aht', 'Audit trail: enter the hydrometer and oil line temperatures.');
        if (!(_fin(aM0) && _fin(aM1) && aM1 >= aM0)) err('am1', 'Audit trail: current meter reading must not be below the previous reading.');
        if (!(_fin(aBsw) && aBsw >= 0 && aBsw <= 100)) err('absw', 'Audit trail: BS&W must be between 0 and 100 %.');
        if (!_blank(au.mf) && !(_fin(aMf) && aMf > 0)) err('amf', 'Audit trail: meter factor must be greater than zero, or blank to use the proven factor.');
        if (!(_fin(aShr) && aShr > 0)) err('ashr', 'Audit trail: shrinkage factor must be greater than zero.');
        if (!_blank(au.pLine) && !(_fin(aP) && aP >= 0 && aP <= 3000)) err('ap', 'Audit trail: oil line pressure must be between 0 and 3,000 psig, or blank.');
        if (!_blank(au.gas) && !(_fin(aGas) && aGas >= 0)) err('agas', 'Audit trail: gas rate must be 0 or more, or blank.');
        if (!errors.length) {
            var mfA = _fin(aMf) ? aMf : (prove && prove.ok ? prove.mf : NaN);
            if (!_fin(mfA)) audit = { ok: false, reason: 'No meter factor for the audit trail: prove the meter or type the factor.' };
            else {
                var h5 = api60(aApi, aHt, 'crude');
                var vcf = ctl(h5.api60, aT, 'crude');
                var iv = aM1 - aM0, gross = iv * mfA, gsvA = gross * vcf, nsvA = gsvA * (1 - aBsw / 100), sto = nsvA * aShr;
                var perDay = 1440 / aInt, rate = sto * perDay;
                var cplA = _fin(aP) ? cplOf(fp(h5.api60, aT), aP, 0) : null;
                audit = {
                    ok: true, mf: mfA, mfSrc: _fin(aMf) ? 'typed' : 'proven', api60: h5.api60, vcf: vcf, iv: iv, gross: gross, gsv: gsvA,
                    csw: 1 - aBsw / 100, nsv: nsvA, shr: aShr, sto: sto, perDay: perDay, rate: rate, bsw: aBsw, interval: aInt,
                    cpl: cplA, rateCpl: cplA != null ? rate * cplA : null, pLine: _fin(aP) ? aP : null,
                    gas: _fin(aGas) ? aGas : null, gor: (_fin(aGas) && rate > 0) ? 1000 * aGas / rate : null, tLine: aT, tHyd: aHt, apiObs: aApi
                };
            }
        }

        if (errors.length) return { ok: false, errors: errors, bad: bad, keys: keys };
        return { ok: true, round: R, liquid: liq, prove: prove, ticket: ticket, audit: audit };
    }

    G.WTS_proving_compute = compute;
    G.WTS_proving_ctl = ctl;
    G.WTS_proving_fp = fp;
    G.WTS_proving_api60 = api60;
    G.WTS_proving_ticketChain = ticketChain;

    // ── Page ─────────────────────────────────────────────────────────
    var TITLE = 'Meter Proving & Net Standard Volume';
    var SUB = 'Meter factor from prover runs with repeatability, CTL/CPL (API MPMS 11.1), S&W and net standard volume (API MPMS 12.2), with a net-oil audit trail';
    var UNITS = {
        pv_bpv: 'volume', pv_pid: 'lengthSmall', pv_wall: 'lengthSmall', pv_api: 'api', pv_th: 'temperature', pv_pe: 'pressureG',
        pv_mft: 'percent',
        pv_to: 'volume', pv_tc: 'volume', pv_ttm: 'temperature', pv_tpm: 'pressureG', pv_tsw: 'percent',
        pv_aint: 'timeMin', pv_aapi: 'api', pv_aht: 'temperature', pv_am0: 'volume', pv_am1: 'volume', pv_at: 'temperature',
        pv_absw: 'percent', pv_ap: 'pressureG', pv_agas: 'gasRateSmall'
    };
    for (var ri = 1; ri <= NR; ri++) { UNITS['pv_iv' + ri] = 'volume'; UNITS['pv_tp' + ri] = 'temperature'; UNITS['pv_pp' + ri] = 'pressureG'; UNITS['pv_tm' + ri] = 'temperature'; UNITS['pv_pm' + ri] = 'pressureG'; }
    var IDS = {
        apiObs: 'pv_api', tHyd: 'pv_th', pe: 'pv_pe', bpv: 'pv_bpv', proverId: 'pv_pid', wall: 'pv_wall', prevMf: 'pv_prev', mfTol: 'pv_mft',
        tclose: 'pv_tc', ttm: 'pv_ttm', tpm: 'pv_tpm', tsw: 'pv_tsw', tmf: 'pv_tmf',
        aint: 'pv_aint', aapi: 'pv_aapi', aht: 'pv_aht', am1: 'pv_am1', absw: 'pv_absw', amf: 'pv_amf', ashr: 'pv_ashr', ap: 'pv_ap', agas: 'pv_agas'
    };
    // [iv, tp, pp, tm, pm]
    var DEF_RUNS = [
        ['49.950', '78.2', '95', '78.0', '100'],
        ['49.960', '78.2', '95', '78.0', '100'],
        ['49.950', '78.3', '95', '78.1', '100'],
        ['49.970', '78.3', '95', '78.1', '100'],
        ['49.960', '78.2', '95', '78.0', '100']
    ];
    // Oil & Gas Rate page ids → this page's audit-trail ids.
    var OG_MAP = { og_int: 'pv_aint', og_api: 'pv_aapi', og_ht: 'pv_aht', og_m0: 'pv_am0', og_m1: 'pv_am1', og_olt: 'pv_at', og_bsw: 'pv_absw', og_mf: 'pv_amf', og_sf: 'pv_ashr' };

    function _fg(id, label, val, extra) {
        return '<div class="fg-item"><label for="' + id + '">' + label + '</label>' +
            '<input type="number" id="' + id + '" value="' + val + '" step="any"' + (extra || '') + '></div>';
    }
    function _sel(id, label, opts, val) {
        var h = '<div class="fg-item"><label for="' + id + '">' + label + '</label><select id="' + id + '">';
        opts.forEach(function (o) { h += '<option value="' + o[0] + '"' + (o[0] === val ? ' selected' : '') + '>' + o[1] + '</option>'; });
        return h + '</select></div>';
    }
    // v3.1: Metric mode shows the coefficients per °C / per kPa and the standard basis in SI first.
    // α per °C = α per °F × 1.8; F per kPa = F per psi ÷ 6.894757.
    function _alphaTxt(aF) { return _metric() ? (aF * 1.8 * 1e6).toFixed(3) + ' ×10⁻⁶ /°C (' + (aF * 1e6).toFixed(3) + ' ×10⁻⁶ /°F)' : (aF * 1e6).toFixed(3) + ' ×10⁻⁶ /°F'; }
    function _fTxt(fPsi) { return _metric() ? (fPsi / 6.894757 * 1e6).toFixed(4) + ' ×10⁻⁶ /kPa (' + (fPsi * 1e6).toFixed(3) + ' ×10⁻⁶ /psi)' : (fPsi * 1e6).toFixed(3) + ' ×10⁻⁶ /psi'; }
    function _stdTxt() { return _metric() ? '15.56 °C (60 °F), 0 kPa(g)' : '60 °F, 0 psig'; }
    function _row(l, v) { return '<div class="rrow"><span class="rl">' + l + '</span><span class="rv">' + v + '</span></div>'; }
    function _ok(t) { return '<div style="color:var(--green)">✓ ' + t + '</div>'; }
    function _warn(t) { return '<div style="color:var(--yellow)">⚠ ' + t + '</div>'; }
    function _bad(t) { return '<div style="color:var(--red)">✗ ' + t + '</div>'; }
    function _tbl(head, rows) {
        return '<div style="overflow-x:auto"><table class="dtable"><thead><tr>' + head.map(function (h) { return '<th>' + h + '</th>'; }).join('') +
            '</tr></thead><tbody>' + rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>'; }).join('') +
            '</tbody></table></div>';
    }

    function _resultsHtml(r) {
        var h = '', L = r.liquid, R = r.round;
        var V = function (v, d) { return _u(v, 'volume', d == null ? 2 : d, 'bbl', 3); };
        var T = function (v) { return _u(v, 'temperature', 1, '°F'); };
        var P = function (v) { return _u(v, 'pressureG', 0, 'psig'); };
        var f5 = R ? 5 : 6, f4 = R ? 4 : 6;
        // Liquid
        h += '<div class="rbox"><div class="rbox-title">Liquid Properties</div>' +
            _row('Commodity group', GROUPS[L.group].name) +
            _row('API @ 60 °F', _fx(L.api60, 2)) +
            _row('Density @ 60 °F', _fmt(L.rho60, 1) + ' kg/m³') +
            _row('Thermal expansion α60', _alphaTxt(alpha60(L.rho60, L.group))) +
            _row('Compressibility F at ' + (_metric() ? '15.56 °C (60 °F)' : '60 °F'), _fTxt(fpRho(L.rho60, 60))) +
            L.warnings.map(_warn).join('') + '</div>';
        // Proving
        var pv = r.prove;
        if (pv && pv.ok) {
            var runRows = pv.runs.map(function (x) {
                return [String(x.row), _fx(_dv(x.iv, 'volume'), _metric() ? 4 : 3), _fx(_dv(x.tp, 'temperature'), 1), _fx(_dv(x.pp, 'pressureG'), 0),
                    _fx(x.f.ctsp, f5), _fx(x.f.cpsp, f5), _fx(x.f.ctlp, f5), _fx(x.f.cplp, f5), _fx(x.f.ccfp, f5),
                    _fx(_dv(x.tm, 'temperature'), 1), _fx(_dv(x.pm, 'pressureG'), 0), _fx(x.f.ctlm, f5), _fx(x.f.cplm, f5), _fx(x.mfRaw, 5)];
            });
            var tl = _lab('temperature', '°F'), pl = _lab('pressureG', 'psig'), vl = _lab('volume', 'bbl');
            var fa = pv.factors;
            var rv = pv.repeatOk ? _ok('Repeatability ' + _fx(pv.rangePct, 4) + ' % over ' + pv.runs.length + ' runs is within the ' + _fx(pv.limitPct, 2) + ' % limit (MPMS 4.8, ±0.027 %).')
                : _bad('Repeatability ' + _fx(pv.rangePct, 4) + ' % over ' + pv.runs.length + ' runs exceeds the ' + _fx(pv.limitPct, 2) + ' % limit: do more runs or find the cause.');
            var mv = '';
            if (pv.prevMf != null) {
                mv = Math.abs(pv.mfChangePct) <= pv.mfTol ? _ok('Meter factor changed ' + _fx(pv.mfChangePct, 3) + ' % from the previous proving (limit ' + _fx(pv.mfTol, 2) + ' %).')
                    : _warn('Meter factor changed ' + _fx(pv.mfChangePct, 3) + ' % from the previous proving (limit ' + _fx(pv.mfTol, 2) + ' %): check the meter.');
            }
            h += '<div class="rbox"><div class="rbox-title">Meter Proving</div>' +
                _tbl(['Run', 'IVm (' + vl + ')', 'Tp (' + tl + ')', 'Pp (' + pl + ')', 'CTSp', 'CPSp', 'CTLp', 'CPLp', 'CCFp',
                    'Tm (' + tl + ')', 'Pm (' + pl + ')', 'CTLm', 'CPLm', 'Run MF'], runRows) +
                _row('Prover base volume', V(L.bpv, 4)) +
                _row('Average IVm', V(pv.avg.iv, 4)) +
                _row('Average Tp / Tm', T(pv.avg.tp) + ' / ' + T(pv.avg.tm)) +
                _row('Average Pp / Pm', P(pv.avg.pp) + ' / ' + P(pv.avg.pm)) +
                _row('CTSp · CPSp', _fx(fa.ctsp, f5) + ' · ' + _fx(fa.cpsp, f5)) +
                _row('CTLp · CPLp', _fx(fa.ctlp, f5) + ' · ' + _fx(fa.cplp, f5)) +
                _row('CCFp', _fx(fa.ccfp, f5)) +
                _row('CTLm · CPLm = CCFm', _fx(fa.ctlm, f5) + ' · ' + _fx(fa.cplm, f5) + ' = ' + _fx(fa.ccfm, f5)) +
                _row('GSVp (prover at ' + _stdTxt() + ')', V(fa.gsvp, 4)) +
                _row('ISVm (meter at ' + _stdTxt() + ')', V(fa.isvm, 4)) +
                _row('Meter factor (average data method)', _fx(pv.mf, f4)) +
                _row('Meter factor (average meter factor method)', _fx(pv.mfAvgMethod, f4)) +
                _row('Repeatability, run meter factors', _fx(pv.rangePct, 4) + ' %') +
                _row('Range of meter volumes', _fx(pv.ivRangePct, 4) + ' %') +
                _row('Repeatability limit for ' + pv.runs.length + ' runs', _fx(pv.limitPct, 2) + ' %') +
                rv + mv + '</div>';
        } else if (pv) {
            h += '<div class="rbox"><div class="rbox-title">Meter Proving</div>' + _bad(pv.reason) + '</div>';
        }
        // Ticket
        var tk = r.ticket;
        if (tk && tk.ok) {
            h += '<div class="rbox"><div class="rbox-title">Net Standard Volume</div>' +
                _tbl(['Step', 'Factor / volume', 'Value'], [
                    ['1', 'Indicated volume IV = closing − opening', V(tk.iv)],
                    ['2', 'CTL at ' + T(tk.tm) + ' (MPMS 11.1)', _fx(tk.ctl, f4)],
                    ['3', 'CPL at ' + P(tk.pm) + ' (F = ' + _fTxt(tk.F) + ')', _fx(tk.cpl, f4)],
                    ['4', 'Meter factor MF (' + tk.mfSrc + ')', _fx(tk.mf, f4)],
                    ['5', 'CCF = CTL × CPL × MF', _fx(tk.ccf, f4)],
                    ['6', 'Gross standard volume GSV = IV × CCF', V(tk.gsv)],
                    ['7', 'S&W ' + _fx(tk.sw, 3) + ' % → CSW = 1 − S&W/100', _fx(tk.csw, f4)],
                    ['8', 'Net standard volume NSV = GSV × CSW', V(tk.nsv)],
                    ['9', 'S&W volume = GSV − NSV', V(tk.swv)]
                ]) +
                _row('Gross standard volume', V(tk.gsv)) +
                _row('Net standard volume', V(tk.nsv)) +
                _row('S&W volume', V(tk.swv)) +
                (R ? _ok('Factors and volumes rounded to the API MPMS 12.2 discrimination levels.') : _warn('MPMS 12.2 rounding is off: factors and volumes are unrounded.')) +
                '</div>';
        } else if (tk) {
            h += '<div class="rbox"><div class="rbox-title">Net Standard Volume</div>' + _bad(tk.reason) + '</div>';
        }
        // Audit trail (#18)
        var a = r.audit;
        if (a && a.ok) {
            var rows = [
                ['1', 'Observed API ' + _fx(a.apiObs, 1) + ' at ' + T(a.tHyd) + ' → API @ 60 °F (Table 5A)', _fx(a.api60, 2)],
                ['2', 'Indicated volume = current − previous meter', V(a.iv, 3)],
                ['3', '× meter factor (' + a.mfSrc + ') ' + _fx(a.mf, 4), V(a.gross, 3)],
                ['4', '× VCF / CTL at ' + T(a.tLine) + ' (Table 6A) ' + _fx(a.vcf, 6) + ' = GSV', V(a.gsv, 3)],
                ['5', '× (1 − BS&W ' + _fx(a.bsw, 2) + ' %) ' + _fx(a.csw, 4) + ' = NSV', V(a.nsv, 3)],
                ['6', '× shrinkage ' + _fx(a.shr, 4) + ' = stock-tank oil', V(a.sto, 3)],
                ['7', '× 1440 / ' + _fmt(a.interval, 0) + ' min = oil rate', _u(a.rate, 'liquidRate', 2, 'BPD', 3)]
            ];
            if (a.cpl != null) rows.push(['8', 'with CPL ' + _fx(a.cpl, 5) + ' at ' + P(a.pLine) + ' (not applied on the Oil & Gas Rate page)', _u(a.rateCpl, 'liquidRate', 2, 'BPD', 3)]);
            h += '<div class="rbox"><div class="rbox-title">Oil &amp; Gas BS&amp;W / Shrinkage Audit Trail</div>' +
                _tbl(['Step', 'Operation', 'Result'], rows) +
                _row('Net oil rate', _u(a.rate, 'liquidRate', 2, 'BPD', 3)) +
                (a.gor != null ? _row('GOR (gas rate / net oil rate)', _u(a.gor, 'gor', 0, 'scf/bbl', 1)) : '') +
                _ok('Same chain and factors as the Oil & Gas Rate page: rate = IV × MF × VCF × (1 − BS&W) × shrinkage × 1440 / interval.') +
                '</div>';
        } else if (a) {
            h += '<div class="rbox"><div class="rbox-title">Oil &amp; Gas BS&amp;W / Shrinkage Audit Trail</div>' + _bad(a.reason) + '</div>';
        }
        h += '<div><b>Notes</b> CTL: API MPMS 11.1 (1980) / ASTM D1250 closed-form equations, α60 = K0/ρ60² + K1/ρ60 ' +
            '(crude K0 341.0957, K1 0; transition zone α60 = A + B/ρ60²), no table rounding of density or α. CPL: MPMS 11.2.1 ' +
            'F = 10⁻⁵·exp(−1.9947 + 0.00013427·t + (793920 + 2326·t)/ρ60²) per psi, CPL = 1/(1 − F·(P − Pe)). Prover: CTSp = ' +
            '1 + (Tp − 60)·Gc, CPSp = 1 + Pp·ID/(E·wt) for an unrestrained pipe prover. MF = GSVp/ISVm by the average data ' +
            'method (MPMS 12.2.3); repeatability is the range of the run meter factors, (max − min)/min, against MPMS 4.8 ' +
            'Table A-1. Ticket: MPMS 12.2.2, CCF = CTL·CPL·MF. The audit trail repeats the Oil & Gas Rate page (crude, ' +
            'Table 5A/6A, no CPL) so each factor can be checked.</div>';
        return h;
    }

    function _readInputs() {
        var runs = [];
        for (var k = 1; k <= NR; k++) runs.push({ iv: _num('pv_iv' + k), tp: _num('pv_tp' + k), pp: _num('pv_pp' + k), tm: _num('pv_tm' + k), pm: _num('pv_pm' + k) });
        return {
            round: _chk('pv_round'), group: _str('pv_grp'), apiObs: _num('pv_api'), tHyd: _num('pv_th'), pe: _num('pv_pe'),
            steel: _str('pv_steel'), bpv: _num('pv_bpv'), proverId: _num('pv_pid'), wall: _num('pv_wall'),
            prevMf: _num('pv_prev'), mfTol: _num('pv_mft'), runs: runs,
            ticket: { open: _num('pv_to'), close: _num('pv_tc'), tm: _num('pv_ttm'), pm: _num('pv_tpm'), sw: _num('pv_tsw'), mf: _num('pv_tmf') },
            audit: { interval: _num('pv_aint'), apiObs: _num('pv_aapi'), tHyd: _num('pv_aht'), m0: _num('pv_am0'), m1: _num('pv_am1'),
                tLine: _num('pv_at'), bsw: _num('pv_absw'), mf: _num('pv_amf'), shr: _num('pv_ashr'), pLine: _num('pv_ap'), gas: _num('pv_agas') }
        };
    }

    function _calcImpl() {
        var root = _byId('pv_root'), res = _byId('pv_res');
        if (!root) return null;
        var ins = root.querySelectorAll ? root.querySelectorAll('input,select') : [];
        for (var i = 0; i < ins.length; i++) if (ins[i].classList) ins[i].classList.remove('input-err');
        var r = compute(_readInputs());
        G.WTS_state = G.WTS_state || {};
        if (!r.ok) {
            G.WTS_state.proving = { ok: false, errors: r.errors.slice(), mf: null, ts: Date.now() };
            var items = r.errors.map(function (e) { return '<li>' + e.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</li>'; }).join('');
            r.bad.forEach(function (k) {
                var m = /^run(\d+)$/.exec(k);
                var ids = m ? ['pv_iv' + m[1], 'pv_tp' + m[1], 'pv_pp' + m[1], 'pv_tm' + m[1], 'pv_pm' + m[1]] : [IDS[k]];
                ids.forEach(function (id) { var el = _byId(id); if (el && el.classList) el.classList.add('input-err'); });
            });
            if (res) { res.innerHTML = '<div class="val-error"><strong>Please fix the following:</strong><ul>' + items + '</ul></div>'; res.setAttribute('data-done', '1'); }
            return r;
        }
        var pv = r.prove, tk = r.ticket, a = r.audit;
        G.WTS_state.proving = {
            ok: true, api60: r.liquid.api60, rho60: r.liquid.rho60,
            mf: pv && pv.ok ? pv.mf : null, mfAvgMethod: pv && pv.ok ? pv.mfAvgMethod : null,
            rangePct: pv && pv.ok ? pv.rangePct : null, repeatOk: pv && pv.ok ? pv.repeatOk : null,
            gsv: tk && tk.ok ? tk.gsv : null, nsv: tk && tk.ok ? tk.nsv : null, ccf: tk && tk.ok ? tk.ccf : null,
            auditRate: a && a.ok ? a.rate : null, ts: Date.now()
        };
        if (res) { res.innerHTML = _resultsHtml(r); res.setAttribute('data-done', '1'); }
        return r;
    }
    G.calcProving = function () { return _canon(_calcImpl); };

    // Copy the Oil & Gas Rate page's saved inputs into the audit-trail card.
    // Saved values are canonical imperial (page autosave record, else the page's own list).
    G.copyOilGasToProving = function () {
        var src = null;
        try {
            var ls = G.localStorage;
            var rec = ls ? JSON.parse(ls.getItem('wts_page_oilgas') || 'null') : null;
            if (rec && rec.f) src = rec.f;
            if (!src) { var leg = ls ? JSON.parse(ls.getItem('wts_oilgas') || 'null') : null; if (leg && typeof leg === 'object') src = leg; }
        } catch (e) { src = null; }
        var msg = _byId('pv_copymsg');
        if (!src) { if (msg) msg.textContent = 'No saved Oil & Gas Rate inputs found: open that page and calculate first.'; return false; }
        var U = G.WTS_units, met = _metric(), n = 0;
        Object.keys(OG_MAP).forEach(function (k) {
            var el = _byId(OG_MAP[k]);
            if (!el || src[k] == null || String(src[k]).trim() === '') return;
            var v = parseFloat(src[k]);
            if (!isFinite(v)) return;
            var cat = UNITS[OG_MAP[k]];
            if (met && cat && U && U.convertCategory) { var c = U.convertCategory(v, cat, 'imperial', 'metric'); if (isFinite(c)) v = Number(c.toPrecision(10)); }
            el.value = String(v);
            n++;
        });
        if (msg) msg.textContent = n ? 'Copied ' + n + ' inputs from the Oil & Gas Rate page.' : 'No usable Oil & Gas Rate inputs found.';
        G.calcProving();
        return n > 0;
    };

    function _pageHtml() {
        var h = '<div id="pv_root"><div class="cols-2"><div style="min-width:0">';
        var grpOpts = Object.keys(GROUPS).map(function (k) { return [k, GROUPS[k].name]; });
        var stOpts = Object.keys(STEELS).map(function (k) { return [k, STEELS[k].name]; });
        h += '<div class="card"><div class="card-title">Liquid and Prover</div><div class="fg">' +
            _sel('pv_grp', 'Commodity group (MPMS 11.1)', grpOpts, 'crude') +
            _fg('pv_api', 'Observed gravity (°API)', '32.5') +
            _fg('pv_th', 'Hydrometer temperature (°F)', '75') +
            _fg('pv_pe', 'Equilibrium vapour pressure (psig)', '0') +
            _fg('pv_bpv', 'Prover base volume (bbl)', '50.0000') +
            _sel('pv_steel', 'Prover steel', stOpts, 'cs') +
            _fg('pv_pid', 'Prover inside diameter (in)', '15.25') +
            _fg('pv_wall', 'Prover wall thickness (in)', '0.375') +
            _fg('pv_prev', 'Previous meter factor (optional)', '1.0005', ' placeholder="blank = skip"') +
            _fg('pv_mft', 'Meter-factor change limit (%)', '0.25') +
            '<div class="fg-item"><label for="pv_round">Round per API MPMS 12.2</label><input type="checkbox" id="pv_round" checked></div>' +
            '</div></div>';
        // Runs
        h += '<div class="card"><div class="card-title">Prover Runs</div>' +
            '<div style="overflow-x:auto"><table class="dtable" id="pv_runs"><thead><tr><th>Run</th>' +
            '<th data-wts-unit-label="volume">Meter volume IVm (bbl)</th>' +
            '<th data-wts-unit-label="temperature">Prover T (°F)</th>' +
            '<th data-wts-unit-label="pressureG">Prover P (psig)</th>' +
            '<th data-wts-unit-label="temperature">Meter T (°F)</th>' +
            '<th data-wts-unit-label="pressureG">Meter P (psig)</th></tr></thead><tbody>';
        for (var k = 1; k <= NR; k++) {
            var d = DEF_RUNS[k - 1] || ['', '', '', '', ''];
            var cell = function (id, val, aria) {
                return '<td><input type="number" step="any" id="' + id + '" value="' + val + '" aria-label="' + aria + '" style="width:100%;min-width:64px"></td>';
            };
            h += '<tr><td>' + k + '</td>' + cell('pv_iv' + k, d[0], 'Run ' + k + ' meter volume') + cell('pv_tp' + k, d[1], 'Run ' + k + ' prover temperature') +
                cell('pv_pp' + k, d[2], 'Run ' + k + ' prover pressure') + cell('pv_tm' + k, d[3], 'Run ' + k + ' meter temperature') +
                cell('pv_pm' + k, d[4], 'Run ' + k + ' meter pressure') + '</tr>';
        }
        h += '</tbody></table></div>' +
            '<div class="info-bar" style="margin-top:12px">A run is used when its meter volume is filled in. Meter volume IVm = meter pulses / nominal K-factor. At least 3 runs; 5 is usual.</div></div>';
        // Ticket
        h += '<div class="card"><div class="card-title">Measurement Ticket</div><div class="fg">' +
            _fg('pv_to', 'Opening meter reading (bbl)', '125000.00') +
            _fg('pv_tc', 'Closing meter reading (bbl)', '131250.40') +
            _fg('pv_ttm', 'Average meter temperature (°F)', '78.0') +
            _fg('pv_tpm', 'Average meter pressure (psig)', '100') +
            _fg('pv_tsw', 'S&W (%)', '0.35') +
            _fg('pv_tmf', 'Meter factor (blank = proven)', '', ' placeholder="blank = proven"') +
            '</div></div>';
        // #18 audit trail
        h += '<div class="card"><div class="card-title">Oil &amp; Gas BS&amp;W / Shrinkage Audit Trail</div><div class="fg">' +
            _fg('pv_aint', 'Calc interval (min)', '60') +
            _fg('pv_aapi', 'API gravity (observed)', '35') +
            _fg('pv_aht', 'Hydrometer temperature (°F)', '80') +
            _fg('pv_am0', 'Previous meter (bbl)', '1000') +
            _fg('pv_am1', 'Current meter (bbl)', '1004.5') +
            _fg('pv_at', 'Oil line temperature (°F)', '120') +
            _fg('pv_absw', 'BS&W (%)', '2') +
            _fg('pv_amf', 'Meter factor (blank = proven)', '1.0') +
            _fg('pv_ashr', 'Shrinkage factor', '0.95') +
            _fg('pv_ap', 'Oil line pressure for CPL (psig, optional)', '', ' placeholder="blank = no CPL"') +
            _fg('pv_agas', 'Gas rate for GOR (MSCFD, optional)', '', ' placeholder="blank = skip"') +
            '</div>' +
            '<div class="btn-row"><button class="btn btn-secondary" id="pv_copy" onclick="copyOilGasToProving()">Copy from Oil &amp; Gas Rate</button>' +
            '<button class="btn btn-primary" id="pv_calc" onclick="calcProving()">Calculate</button></div>' +
            '<div class="info-bar" id="pv_copymsg" style="margin-top:8px">Defaults match the Oil &amp; Gas Rate page.</div></div>';
        h += '</div><div style="min-width:0"><div id="pv_res"></div></div></div></div>';
        return h;
    }

    function render(body) {
        if (!body) return;
        var t = _byId('pgTitle'), s = _byId('pgSub');
        if (t) t.textContent = TITLE;
        if (s) s.textContent = SUB;
        body.innerHTML = _pageHtml();
        _tag(UNITS);
        var root = _byId('pv_root');
        if (root && root.addEventListener) {
            root.addEventListener('change', function (e) {
                if (e && e.target && /^pv_/.test(e.target.id || '')) G.calcProving();
            });
        }
        G.calcProving();
    }
    G.renderProving = render;

    G.WTS_calcRegistry = G.WTS_calcRegistry || {};
    G.WTS_calcRegistry.proving = {
        key: 'proving',
        title: TITLE,
        navTitle: 'Meter Proving & NSV',
        sub: SUB,
        group: 'Well Testing',
        icon: '&#9878;',
        badge: 'Metering',
        bc: 'dc-b-orange',
        desc: 'Meter factor from prover runs with the MPMS 4.8 repeatability check, CTL/CPL, S&W and net standard volume, plus a net-oil audit trail.',
        render: function (body) { return G.renderProving(body); }
    };

    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('wts:unit-system-changed', function () {
            var r = _byId('pv_res');
            if (r && r.getAttribute && r.getAttribute('data-done') === '1') G.calcProving();
        });
    }
})();

// ─── END 49-calc-proving ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 49-calc-scale ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
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
//   Langelier (v3.0: ASTM D3739 chart fit, the value shown and used):  [USBR MS-2016 eqs. 9–11; DuPont (1992)]
//     pHs = pCa + pAlk + C,  pCa = −log10[Ca] (mol/L), pAlk = −log10(total alkalinity, eq/L),
//     C(TDS, T) = 3.26·e^(−0.005·T) − 0.0116·log10(TDS³) + 0.0905·log10(TDS²) − 0.133·log10(TDS) − 0.02,
//     T in °F; LSI = pH − pHs. Reproduces the USBR worked example (0.184 vs 0.18 published).
//   Langelier, Carrier (1965) form (shown for comparison; the pre-v3.0 value): [Carrier (1965)]
//     pHs = (9.3 + A + B) − (C + D); A = (log10 TDS − 1)/10,
//     B = −13.12·log10(T_K) + 34.55, C = log10(Ca as CaCO3, mg/L) − 0.4,
//     D = log10(total alkalinity as CaCO3, mg/L). USBR example: 0.13.
//     Both valid for TDS ≤ 10,000 mg/L.
//   Stiff–Davis: S&DSI = pH − pCa − pAlk − K, pCa = −log10[Ca] (mol/L),
//     pAlk = −log10(total alkalinity, eq/L); K from the ASTM D4582 chart
//     curve fit (USBR MS-2016 eqs. 13–14, T in °C; transcription checked
//     against the published document in v3.0):
//       I < 1.2: K = 2.022·exp((ln I + 7.544)²/102.6) − 0.0002·T² + 0.00097·T + 0.262
//       I ≥ 1.2: K = −0.1·I − 0.0002·T² − 0.00097·T + 3.887
//     On the USBR example (I 0.0433, 15 °C) this gives K 2.674 and S&DSI −0.04; the
//     worksheet prints 0.12 (K ≈ 2.515), which no reading of eq. 13 reproduces (°F,
//     log10 I, sign of the 0.00097·T term: 0.57, −0.66, −0.01). The thermodynamic
//     form K = pK2 − pKsp − log γCa − log γHCO3 (Plummer & Busenberg 1982, Davies
//     activities, no ion pairs) gives K ≈ 2.40, S&DSI ≈ +0.24. The fit is kept; the
//     published value lies between the fit and the theory (±0.15).
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
        // Langelier, Carrier (1965) form (comparison)
        var A = (Math.log10(tds) - 1) / 10, B = -13.12 * Math.log10(tK) + 34.55;
        var C = Math.log10(caCaCO3) - 0.4, D = Math.log10(alkCaCO3);
        var pHsCarrier = 9.3 + A + B - (C + D);
        // Langelier, ASTM D3739 chart fit (USBR MS-2016 eq. 9, T °F): pHs = pCa + pAlk + C(TDS, T)
        var lt = Math.log10(tds);
        var Cchart = 3.26 * Math.exp(-0.005 * t) - 0.0116 * 3 * lt + 0.0905 * 2 * lt - 0.133 * lt - 0.02;
        var pHsL = -Math.log10(c.ca) - Math.log10(alkEq) + Cchart;
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
            lsi: { Cchart: Cchart, pHs: pHsL, value: ph - pHsL, valid: tds <= 10000, band: band(ph - pHsL), tempOk: t <= 212,
                carrier: { A: A, B: B, C: C, D: D, pHs: pHsCarrier, value: ph - pHsCarrier } },
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
            _row('Langelier index, Carrier (1965) form (pre-v3.0 value)', _fx(L.carrier.value, 2)) +
            _row('Stiff–Davis K', _fx(S.K, 3)) +
            _row('Stiff–Davis saturation pH', _fx(S.pHs, 2)) +
            _row('Stiff–Davis index, S&DSI', _fx(S.value, 2)) +
            (L.valid ? _verdict('Langelier', L.value, L.band) : _warn('TDS is above 10,000 mg/L: the Langelier index is outside its range. Use Stiff–Davis or Oddo–Tomson.')) +
            _verdict('Stiff–Davis', S.value, S.band) +
            (S.tempOk ? '' : _warn('Temperature is outside the 0 to 90 °C range of the Stiff–Davis chart; K is extrapolated.')) +
            (L.valid && !L.tempOk ? _warn('Temperature is above 212 °F: the Langelier chart fit is extrapolated. Use Oddo–Tomson.') : '') +
            _note('Both indices use the measured pH and the analysis temperature. From v3.0 the LSI uses the ASTM D3739 ' +
                'chart fit (DuPont 1992, USBR 2016 eq. 9: pHs = pCa + pAlk + C(TDS, T)), which reproduces the USBR worked ' +
                'example (0.18); the Carrier (1965) form used before is shown for comparison (typically 0.02 to 0.06 lower). ' +
                'Stiff–Davis K from the ASTM D4582 chart fit (USBR 2016 eqs. 13–14); on the USBR example it gives −0.04 against ' +
                'the worksheet\'s 0.12, so treat |S&DSI| below about 0.2 as neutral. Positive values mean calcium carbonate ' +
                'tends to deposit; values below −0.5 mean the water is aggressive to carbonate films.') +
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

// ─── END 49-calc-scale ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 49-calc-sepqc ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════
// WTS — Round-9 plug-in calculator — Separator Sampling & GOR QC (sepqc)
//
// PURPOSE (docs/ROADMAP.md §1.2 #8, method notes §1.3)
//   Quality control of separator samples and of the GOR handed to the PVT
//   laboratory for recombination, following API RP 44 (Sampling Petroleum
//   Reservoir Fluids) practice:
//     • separator vs stock-tank GOR through the separator oil shrinkage
//       (Standing Bo at separator conditions, or a user / laboratory value);
//     • gas rate re-computed with the laboratory gas gravity and Z:
//         q_corr = q_field · √(SG_field / SG_lab) · (Fpv,lab / Fpv,field),
//         Fpv = 1/√Z at the meter (separator) conditions  — AGA-3 /
//         API MPMS 14.3 flow equation, q ∝ Fgr·Fpv with Fgr = 1/√G;
//     • the recombination GOR for the laboratory (scf of separator gas per
//       barrel of separator liquid at separator conditions);
//     • sample validity checks per bottle: opening pressure vs separator
//       pressure, laboratory saturation pressure vs separator conditions,
//       and duplicate-sample agreement, each with ✓ / ⚠ / ✗ verdicts.
//
// SHRINKAGE AND GOR
//   Shrinkage S = stock-tank barrels per barrel of separator oil at
//   separator conditions (S = 1/Bo,sep ≤ 1). The separator volume factor
//   Bsep = 1/S (separator bbl per STB).
//     GOR_ST  [scf sep gas/STB]      = GOR_sep · Bsep = GOR_sep / S
//     GOR_sep [scf sep gas/sep bbl]  = GOR_ST · S
//   (the ROADMAP note writes "GOR_ST = GOR_sep × shrinkage" with the shrinkage
//   taken as the separator volume factor Bsep; with S ≤ 1 defined as above the
//   same relation reads GOR_ST = GOR_sep / S.)
//   Standing (1947), separator oil at its bubble point (as the host Fluid
//   Properties → Shrinkage tab):
//     Rs = γg·[(p/18.2 + 1.4)·10^(0.0125·API − 0.00091·T)]^1.2048   (p psia, T °F)
//     F  = Rs·(γg/γo)^0.5 + 1.25·T ;  Bo = 0.9759 + 0.00012·F^1.2 ;  S = 1/Bo
//   Standing, M.B., "A Pressure-Volume-Temperature Correlation for Mixtures of
//   California Oils and Gases", API Drilling & Production Practice (1947).
//
// Z-FACTOR
//   WTS_gaspvt_compute (46-calc-gaspvt.js: Sutton pseudo-criticals, Kay mixing
//   of N2/CO2/H2S, Wichert–Aziz, Dranchuk–Abou-Kassem Z) at separator
//   pressure and temperature; falls back to the host WTS_aga3_compute Z
//   (Standing pseudo-criticals + DAK) when 46 is not loaded. Either Z can be
//   typed instead (e.g. the Z the field flow computer used).
//
// UNITS
//   Field units inside: psig / psia, °F, MSCFD, bbl/d, scf/bbl. Tagged inputs
//   read imperial inside calcSepQC(); results use the active unit system.
//
// PUBLIC API (window.*)
//   renderSepQC(body), calcSepQC()
//   WTS_sepqc_compute(input) → {ok, …} | {ok:false, errors[], bad[]}
//   WTS_sepqc_standing(psepPsig, tsepF, api, sgGas) → {Rs, F, Bo, S}
// STATE
//   WTS_state.sepqc = {ok, S, Bsep, qGasCorr, gorSepCorr, gorSTCorr, fails, warns, ts}
// ════════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    var G = (typeof window !== 'undefined') ? window : globalThis;

    var P_ATM = 14.696, RANKINE = 459.67;
    var NB = 6;                           // bottle rows in the sample table

    // ── Helpers ──────────────────────────────────────────────────────
    function _byId(id) { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }
    function _str(id) { var e = _byId(id); return e ? String(e.value) : ''; }
    function _num(id) { var e = _byId(id); if (!e) return NaN; var s = String(e.value).trim(); return s === '' ? NaN : parseFloat(s); }
    function _fin(x) { return typeof x === 'number' && isFinite(x); }
    function _blank(x) { return x === '' || x == null || (typeof x === 'number' && isNaN(x)); }
    function _fmt(v, d) {
        if (v == null || !isFinite(v)) return '—';
        return (G.WTS_fmtNum ? G.WTS_fmtNum(v, (d == null ? 2 : d), (d == null ? 2 : d)) : Number(v).toLocaleString(undefined, { minimumFractionDigits: (d == null ? 2 : d), maximumFractionDigits: (d == null ? 2 : d) }));
    }
    function _esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function _metric() { var U = G.WTS_units; return !!(U && U.getSystem && U.getSystem() === 'metric' && U.format); }
    function _u(v, cat, d, impLabel, dMet) {
        if (v == null || !isFinite(v)) return '—';
        if (_metric()) { var f = G.WTS_units.format(v, cat); return _fmt(f.value, dMet == null ? d : dMet) + ' ' + f.label; }
        return _fmt(v, d) + ' ' + impLabel;
    }
    function _dv(v, cat) { return _metric() ? G.WTS_units.format(v, cat).value : v; }
    function _lab(cat, impLabel) { return _metric() ? G.WTS_units.format(1, cat).label : impLabel; }
    function _tag(map) { var U = G.WTS_units; if (!U || !U.tagInput) return; for (var id in map) U.tagInput(id, map[id]); }
    function _canon(fn) { var U = G.WTS_units; return (U && U.runCanonical) ? U.runCanonical(fn) : fn(); }

    // ── Pure compute ─────────────────────────────────────────────────

    // Standing (1947) separator oil: Rs, Bo and shrinkage at separator p (psig), T (°F).
    function standing(psepPsig, tF, api, sg) {
        var go = 141.5 / (api + 131.5);
        var Rs = sg * Math.pow(((psepPsig + 14.7) / 18.2 + 1.4) * Math.pow(10, 0.0125 * api - 0.00091 * tF), 1.2048);
        var F = Rs * Math.sqrt(sg / go) + 1.25 * tF;
        var Bo = 0.9759 + 0.00012 * Math.pow(Math.max(F, 0), 1.2);
        return { Rs: Rs, F: F, Bo: Bo, S: 1 / Bo, go: go };
    }

    // Z at separator conditions: 46-calc-gaspvt (Sutton + DAK) or host AGA-3 (Standing + DAK).
    function zAt(sg, pPsia, tF, co2, h2s, n2) {
        if (typeof G.WTS_gaspvt_compute === 'function') {
            var r = G.WTS_gaspvt_compute({ sg: sg, p: pPsia, t: tF, co2: co2, h2s: h2s, n2: n2 });
            if (r && r.ok) return { z: r.z, src: 'Sutton + DAK (Gas PVT)' };
            if (r && r.errors) return { z: NaN, err: r.errors[0] };
        }
        if (typeof G.WTS_aga3_compute === 'function') {
            // Only Z is used; the orifice geometry is a placeholder the Z does not depend on.
            // sgBasis 'ideal': the gravity here is the same M/M_air gravity Gas PVT takes.
            var a = G.WTS_aga3_compute({ D: 4, d: 2, hw: 50, Ps: pPsia - P_ATM, TfF: tF, SG: sg, sgBasis: 'ideal', co2: co2, h2s: h2s, n2: n2 });
            if (a && a.ok) return { z: a.Z, src: 'Standing + DAK (AGA-3)' };
        }
        return { z: NaN, err: 'No Z-factor engine is loaded; type the Z-factors.' };
    }

    function compute(input) {
        var i = input || {};
        var n = function (x) { return _blank(x) ? NaN : Number(x); };
        var psep = n(i.psep), tsep = n(i.tsep), api = n(i.api), sgF = n(i.sgField), sgL = n(i.sgLab);
        var co2 = _blank(i.co2) ? 0 : Number(i.co2), h2s = _blank(i.h2s) ? 0 : Number(i.h2s), n2 = _blank(i.n2) ? 0 : Number(i.n2);
        var zF = n(i.zField), zL = n(i.zLab), qg = n(i.qGas), qo = n(i.qOil);
        var basis = i.oilBasis === 'st' ? 'st' : 'sep';
        var shrM = i.shrMethod === 'user' ? 'user' : 'standing', shrU = n(i.shrUser);
        var tolOpen = _blank(i.tolOpen) ? 5 : Number(i.tolOpen), tolSat = _blank(i.tolSat) ? 5 : Number(i.tolSat), tolDup = _blank(i.tolDup) ? 2 : Number(i.tolDup);
        var bottlesIn = Array.isArray(i.bottles) ? i.bottles : [];
        var errors = [], bad = [], keys = [];
        function err(k, m) { errors.push(m); keys.push(k); if (bad.indexOf(k) === -1) bad.push(k); }

        if (!(_fin(psep) && psep >= 0 && psep <= 15000)) err('psep', 'Separator pressure must be between 0 and 15,000 psig.');
        if (!(_fin(tsep) && tsep >= -20 && tsep <= 350)) err('tsep', 'Separator temperature must be between -20 and 350 °F.');
        if (!(_fin(api) && api >= 5 && api <= 90)) err('api', 'Stock-tank oil gravity must be between 5 and 90 °API.');
        if (!(_fin(sgF) && sgF >= 0.55 && sgF <= 2)) err('sgField', 'Field (meter) gas gravity must be between 0.55 and 2.0.');
        if (!(_fin(qg) && qg > 0)) err('qGas', 'Field gas rate must be greater than zero.');
        if (!(_fin(qo) && qo > 0)) err('qOil', 'Oil rate must be greater than zero.');
        if (!(_fin(co2) && co2 >= 0 && co2 < 100 && _fin(h2s) && h2s >= 0 && h2s < 100 && _fin(n2) && n2 >= 0 && n2 < 100 && co2 + h2s + n2 < 95)) err('co2', 'Laboratory CO2, H2S and N2 must each be 0–100 mol % and total below 95 %.');
        if (!_blank(i.zField) && !(_fin(zF) && zF > 0.2 && zF < 2)) err('zField', 'Field Z-factor must be between 0.2 and 2, or blank.');
        if (!_blank(i.zLab) && !(_fin(zL) && zL > 0.2 && zL < 2)) err('zLab', 'Laboratory Z-factor must be between 0.2 and 2, or blank.');
        if (shrM === 'user' && !(_fin(shrU) && shrU > 0.3 && shrU <= 1)) err('shrUser', 'Shrinkage factor must be above 0.3 and no more than 1 (stock-tank volume per separator volume).');
        if (!(_fin(tolOpen) && tolOpen > 0 && tolOpen <= 50)) err('tolOpen', 'Opening-pressure tolerance must be between 0 and 50 %.');
        if (!(_fin(tolSat) && tolSat > 0 && tolSat <= 50)) err('tolSat', 'Saturation-pressure tolerance must be between 0 and 50 %.');
        if (!(_fin(tolDup) && tolDup > 0 && tolDup <= 50)) err('tolDup', 'Duplicate-agreement tolerance must be between 0 and 50 %.');

        // Bottles: a row is used when it has an opening pressure, a saturation pressure or a gravity.
        var bottles = [];
        bottlesIn.forEach(function (b, k) {
            if (!b) return;
            var po = n(b.pOpen), to = n(b.tOpen), ps = n(b.psat), sg = n(b.sg);
            if (!_fin(po) && !_fin(ps) && !_fin(sg)) return;
            var kind = b.kind === 'gas' ? 'gas' : 'oil', row = k + 1;
            if (!_blank(b.pOpen) && !(_fin(po) && po >= 0 && po <= 15000)) err('b' + row, 'Bottle ' + row + ': opening pressure must be between 0 and 15,000 psig.');
            if (!_blank(b.tOpen) && !(_fin(to) && to >= -20 && to <= 350)) err('b' + row, 'Bottle ' + row + ': opening temperature must be between -20 and 350 °F.');
            if (!_blank(b.psat) && !(_fin(ps) && ps >= 0 && ps <= 15000)) err('b' + row, 'Bottle ' + row + ': saturation pressure must be between 0 and 15,000 psig.');
            if (!_blank(b.sg) && !(_fin(sg) && sg >= 0.55 && sg <= 2)) err('b' + row, 'Bottle ' + row + ': gas gravity must be between 0.55 and 2.0.');
            bottles.push({ row: row, id: String(b.id == null ? '' : b.id).slice(0, 40), kind: kind, pOpen: po, tOpen: to, psat: ps, sg: sg });
        });
        // Laboratory gas gravity: typed, else the mean of the gas bottles' gravities.
        var sgLabSrc = 'input';
        if (!_fin(sgL) && _blank(i.sgLab)) {
            var gs = bottles.filter(function (b) { return b.kind === 'gas' && _fin(b.sg) && b.sg >= 0.55 && b.sg <= 2; });
            if (gs.length) { sgL = gs.reduce(function (s, b) { return s + b.sg; }, 0) / gs.length; sgLabSrc = 'bottles'; }
        }
        if (!(_fin(sgL) && sgL >= 0.55 && sgL <= 2)) err('sgLab', 'Laboratory gas gravity must be between 0.55 and 2.0 (or blank with gas bottle gravities entered).');
        if (errors.length) return { ok: false, errors: errors, bad: bad, keys: keys };

        var psepA = psep + P_ATM, tsepR = tsep + RANKINE;

        // Z-factors at the meter (separator) conditions.
        var zFsrc = 'input', zLsrc = 'input';
        if (!_fin(zF)) { var a = zAt(sgF, psepA, tsep, 0, 0, 0); zF = a.z; zFsrc = a.src; if (!_fin(zF)) { err('zField', 'Field Z could not be computed: ' + (a.err || '') + ' Type the Z-factor.'); } }
        if (!_fin(zL)) { var b2 = zAt(sgL, psepA, tsep, co2, h2s, n2); zL = b2.z; zLsrc = b2.src; if (!_fin(zL)) { err('zLab', 'Laboratory Z could not be computed: ' + (b2.err || '') + ' Type the Z-factor.'); } }
        if (errors.length) return { ok: false, errors: errors, bad: bad, keys: keys };

        // Shrinkage.
        var st = standing(psep, tsep, api, sgL);
        var S = shrM === 'user' ? shrU : st.S, Bsep = 1 / S;

        // Gas-rate correction (AGA-3: q ∝ Fgr·Fpv; Fgr = 1/√G, Fpv = 1/√Z).
        var fgrRatio = Math.sqrt(sgF / sgL);
        var fpvF = 1 / Math.sqrt(zF), fpvL = 1 / Math.sqrt(zL), fpvRatio = fpvL / fpvF;
        var corr = fgrRatio * fpvRatio, qgc = qg * corr;

        // Oil rates on both bases.
        var qoSep = basis === 'sep' ? qo : qo / S, qoST = basis === 'st' ? qo : qo * S;
        var gorSepF = 1000 * qg / qoSep, gorSTF = 1000 * qg / qoST;
        var gorSepC = 1000 * qgc / qoSep, gorSTC = 1000 * qgc / qoST;
        // Total producing GOR estimate: separator gas + stock-tank flash gas (Standing Rs at separator).
        var gorTot = gorSTC + st.Rs;

        // ── Sample checks ───────────────────────────────────────────
        var checks = [];
        function chk(level, text, row) { checks.push({ level: level, text: text, row: row || 0 }); }
        bottles.forEach(function (b) {
            b.checks = [];
            var add = function (level, text) { b.checks.push(level); chk(level, text, b.row); };
            var label = 'Bottle ' + b.row;
            if (_fin(b.pOpen)) {
                var tO = _fin(b.tOpen) ? b.tOpen : tsep, poA = b.pOpen + P_ATM, exp;
                if (b.kind === 'gas') {
                    // Constant-volume gas bottle: p/T constant (ideal gas; Z ratio neglected).
                    exp = psepA * (tO + RANKINE) / tsepR;
                } else {
                    exp = psepA;
                }
                b.pOpenExpG = exp - P_ATM;
                b.openDev = 100 * (poA - exp) / exp;
                if (b.kind === 'oil' && Math.abs(tO - tsep) > 5) {
                    add('warn', label + ' (oil): opened at ' + _fmt(tO, 0) + ' °F, not at separator temperature; the opening-pressure check is indicative only.');
                }
                if (b.openDev < -tolOpen) add('bad', label + ': opening pressure is ' + _fmt(-b.openDev, 1) + ' % below the expected value: possible leak or lost gas.');
                else if (b.openDev > tolOpen) add('warn', label + ': opening pressure is ' + _fmt(b.openDev, 1) + ' % above the expected value: check the bottle temperature and filling.');
                else add('ok', label + ': opening pressure within ' + _fmt(tolOpen, 1) + ' % of the expected value.');
            }
            if (b.kind === 'oil' && _fin(b.psat)) {
                var psA = b.psat + P_ATM;
                b.satDev = 100 * (psA - psepA) / psepA;
                if (b.satDev < -tolSat) add('bad', label + ': saturation pressure is ' + _fmt(-b.satDev, 1) + ' % below separator pressure: gas lost from the sample (leak or poor transfer).');
                else if (b.satDev > tolSat) add('bad', label + ': saturation pressure is ' + _fmt(b.satDev, 1) + ' % above separator pressure: free gas in the sample (carry-under) or separator not at equilibrium.');
                else add('ok', label + ': saturation pressure within ' + _fmt(tolSat, 1) + ' % of separator pressure.');
            } else if (b.kind === 'oil') {
                add('warn', label + ' (oil): no laboratory saturation pressure entered.');
            }
            if (b.kind === 'gas' && _fin(b.psat)) add('warn', label + ': a saturation pressure is only checked for oil bottles.');
            b.verdict = b.checks.indexOf('bad') !== -1 ? 'bad' : b.checks.indexOf('warn') !== -1 ? 'warn' : 'ok';
        });
        function spread(vals) {
            var mx = Math.max.apply(null, vals), mn = Math.min.apply(null, vals), mean = vals.reduce(function (s, v) { return s + v; }, 0) / vals.length;
            return { max: mx, min: mn, mean: mean, pct: 100 * (mx - mn) / mean };
        }
        var dup = {};
        var oilPs = bottles.filter(function (b) { return b.kind === 'oil' && _fin(b.psat); }).map(function (b) { return b.psat + P_ATM; });
        if (oilPs.length >= 2) {
            dup.oil = spread(oilPs);
            if (dup.oil.pct <= tolDup) chk('ok', 'Duplicate oil samples: saturation pressures agree within ' + _fmt(dup.oil.pct, 2) + ' % (limit ' + _fmt(tolDup, 1) + ' %).');
            else chk('bad', 'Duplicate oil samples: saturation pressures differ by ' + _fmt(dup.oil.pct, 2) + ' % (limit ' + _fmt(tolDup, 1) + ' %).');
        } else chk('warn', 'Fewer than two oil samples with a saturation pressure: no duplicate check (API RP 44 recommends duplicates).');
        var gasSg = bottles.filter(function (b) { return b.kind === 'gas' && _fin(b.sg); }).map(function (b) { return b.sg; });
        if (gasSg.length >= 2) {
            dup.gas = spread(gasSg);
            if (dup.gas.pct <= tolDup) chk('ok', 'Duplicate gas samples: gas gravities agree within ' + _fmt(dup.gas.pct, 2) + ' % (limit ' + _fmt(tolDup, 1) + ' %).');
            else chk('bad', 'Duplicate gas samples: gas gravities differ by ' + _fmt(dup.gas.pct, 2) + ' % (limit ' + _fmt(tolDup, 1) + ' %).');
        } else chk('warn', 'Fewer than two gas samples with a laboratory gravity: no duplicate check.');
        var gasCorrPct = 100 * (corr - 1);
        if (Math.abs(gasCorrPct) > 2) chk('warn', 'Laboratory gravity and Z change the gas rate by ' + _fmt(gasCorrPct, 2) + ' %: report the corrected GOR to the laboratory.');

        var fails = checks.filter(function (c) { return c.level === 'bad'; }).length;
        var warns = checks.filter(function (c) { return c.level === 'warn'; }).length;
        return {
            ok: true, psep: psep, psepA: psepA, tsep: tsep, api: api, sgField: sgF, sgLab: sgL, sgLabSrc: sgLabSrc,
            co2: co2, h2s: h2s, n2: n2, zField: zF, zLab: zL, zFieldSrc: zFsrc, zLabSrc: zLsrc,
            fpvField: fpvF, fpvLab: fpvL, fgrRatio: fgrRatio, fpvRatio: fpvRatio, corr: corr, gasCorrPct: gasCorrPct,
            qGas: qg, qGasCorr: qgc, qOil: qo, oilBasis: basis, qOilSep: qoSep, qOilST: qoST,
            shrMethod: shrM, S: S, Bsep: Bsep, standing: st,
            gorSepField: gorSepF, gorSTField: gorSTF, gorSepCorr: gorSepC, gorSTCorr: gorSTC, gorTotal: gorTot,
            tolOpen: tolOpen, tolSat: tolSat, tolDup: tolDup,
            bottles: bottles, dup: dup, checks: checks, fails: fails, warns: warns
        };
    }

    G.WTS_sepqc_compute = compute;
    G.WTS_sepqc_standing = standing;

    // ── Page ─────────────────────────────────────────────────────────
    var TITLE = 'Separator Sampling & GOR QC';
    var SUB = 'Separator vs stock-tank GOR, gas rate re-computed with laboratory gravity and Z, recombination GOR and sample validity checks (API RP 44)';
    var UNITS = {
        sq_psep: 'pressureG', sq_tsep: 'temperature', sq_api: 'api', sq_sgf: 'sg', sq_sgl: 'sg',
        sq_co2: 'percent', sq_h2s: 'percent', sq_n2: 'percent',
        sq_qg: 'gasRateSmall', sq_qo: 'liquidRate',
        sq_tolo: 'percent', sq_tols: 'percent', sq_told: 'percent'
    };
    for (var bi = 1; bi <= NB; bi++) { UNITS['sq_bpo' + bi] = 'pressureG'; UNITS['sq_bto' + bi] = 'temperature'; UNITS['sq_bps' + bi] = 'pressureG'; UNITS['sq_bsg' + bi] = 'sg'; }
    var IDS = {
        psep: 'sq_psep', tsep: 'sq_tsep', api: 'sq_api', sgField: 'sq_sgf', sgLab: 'sq_sgl', co2: 'sq_co2',
        zField: 'sq_zf', zLab: 'sq_zl', qGas: 'sq_qg', qOil: 'sq_qo', shrUser: 'sq_shr',
        tolOpen: 'sq_tolo', tolSat: 'sq_tols', tolDup: 'sq_told'
    };
    var MSG = {
        psep: function () { return 'Separator pressure must be between ' + _u(0, 'pressureG', 0, 'psig') + ' and ' + _u(15000, 'pressureG', 0, 'psig') + '.'; },
        tsep: function () { return 'Separator temperature must be between ' + _u(-20, 'temperature', 0, '°F') + ' and ' + _u(350, 'temperature', 0, '°F') + '.'; }
    };
    // [id, kind, pOpen, tOpen, psat, sg]
    var DEF_B = [
        ['A-101', 'oil', '495', '100', '505', ''],
        ['A-102', 'oil', '490', '100', '498', ''],
        ['G-201', 'gas', '470', '70', '', '0.752'],
        ['G-202', 'gas', '468', '70', '', '0.748']
    ];

    function _fg(id, label, val, extra) {
        return '<div class="fg-item"><label for="' + id + '">' + label + '</label>' +
            '<input type="number" id="' + id + '" value="' + val + '" step="any"' + (extra || '') + '></div>';
    }
    function _selHtml(id, opts, val, aria) {
        var h = '<select id="' + id + '"' + (aria ? ' aria-label="' + aria + '"' : '') + '>';
        opts.forEach(function (o) { h += '<option value="' + o[0] + '"' + (o[0] === val ? ' selected' : '') + '>' + o[1] + '</option>'; });
        return h + '</select>';
    }
    function _row(l, v) { return '<div class="rrow"><span class="rl">' + l + '</span><span class="rv">' + v + '</span></div>'; }
    function _ok(t) { return '<div style="color:var(--green)">✓ ' + t + '</div>'; }
    function _warn(t) { return '<div style="color:var(--yellow)">⚠ ' + t + '</div>'; }
    function _bad(t) { return '<div style="color:var(--red)">✗ ' + t + '</div>'; }
    function _v(c) { return c.level === 'bad' ? _bad(c.text) : c.level === 'warn' ? _warn(c.text) : _ok(c.text); }
    function _tbl(head, rows) {
        return '<div style="overflow-x:auto"><table class="dtable"><thead><tr>' + head.map(function (h) { return '<th>' + h + '</th>'; }).join('') +
            '</tr></thead><tbody>' + rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>'; }).join('') +
            '</tbody></table></div>';
    }
    function _gor(v, basis) {   // basis: 'st' (per STB) or 'sep' (per separator bbl)
        if (!_fin(v)) return '—';
        if (_metric()) { var f = G.WTS_units.format(v, 'gor'); return _fmt(f.value, 2) + ' ' + f.label + (basis === 'sep' ? ' (separator liquid)' : ' (stock tank)'); }
        return _fmt(v, 1) + (basis === 'sep' ? ' scf/sep bbl' : ' scf/STB');
    }

    function _resultsHtml(r) {
        var h = '';
        var Q = function (v) { return _u(v, 'gasRateSmall', 1, 'MSCFD', 1); };
        var L = function (v) { return _u(v, 'liquidRate', 1, 'BPD', 2); };
        // 1 — gas-rate re-computation
        h += '<div class="rbox"><div class="rbox-title">Gas Rate Re-computation</div>' +
            _row('Field gas gravity (meter)', _fmt(r.sgField, 4)) +
            _row('Laboratory gas gravity', _fmt(r.sgLab, 4) + (r.sgLabSrc === 'bottles' ? ' (mean of gas bottles)' : '')) +
            _row('Z, field gravity', _fmt(r.zField, 4) + ' (' + (r.zFieldSrc === 'input' ? 'typed' : r.zFieldSrc) + ')') +
            _row('Z, laboratory gas', _fmt(r.zLab, 4) + ' (' + (r.zLabSrc === 'input' ? 'typed' : r.zLabSrc) + ')') +
            _row('Gravity factor ratio √(SG field / SG lab)', _fmt(r.fgrRatio, 5)) +
            _row('Supercompressibility ratio Fpv,lab / Fpv,field', _fmt(r.fpvRatio, 5)) +
            _row('Combined correction', _fmt(r.corr, 5) + ' (' + (r.gasCorrPct >= 0 ? '+' : '') + _fmt(r.gasCorrPct, 2) + ' %)') +
            _row('Field gas rate', Q(r.qGas)) +
            _row('Corrected gas rate', Q(r.qGasCorr)) +
            '</div>';
        // 2 — shrinkage and GOR
        var st = r.standing;
        h += '<div class="rbox"><div class="rbox-title">Shrinkage and GOR</div>' +
            (r.shrMethod === 'standing' ?
                _row('Solution GOR of separator oil (Standing)', _gor(st.Rs, 'st')) +
                _row('Bo of separator oil (Standing)', _fmt(st.Bo, 4)) : '') +
            _row('Shrinkage factor S (' + (_metric() ? 'stock-tank m³ per separator m³' : 'STB per separator bbl') + ')', _fmt(r.S, 4) + (r.shrMethod === 'user' ? ' (typed)' : ' (Standing)')) +
            _row('Separator volume factor 1/S (' + (_metric() ? 'separator m³ per stock-tank m³' : 'separator bbl per STB') + ')', _fmt(r.Bsep, 4)) +
            _row('Oil rate, separator conditions', L(r.qOilSep) + (r.oilBasis === 'sep' ? ' (entered)' : '')) +
            _row('Oil rate, stock tank', L(r.qOilST) + (r.oilBasis === 'st' ? ' (entered)' : '')) +
            _row('Field GOR, separator basis', _gor(r.gorSepField, 'sep')) +
            _row('Field GOR, stock-tank basis', _gor(r.gorSTField, 'st')) +
            _row('Corrected GOR, stock-tank basis', _gor(r.gorSTCorr, 'st')) +
            _row('Total producing GOR estimate (+ stock-tank gas)', _gor(r.gorTotal, 'st')) +
            '</div>';
        // 3 — recombination
        h += '<div class="rbox"><div class="rbox-title">Recombination GOR for the Laboratory</div>' +
            _row('Recombination GOR (separator gas / separator liquid)', _gor(r.gorSepCorr, 'sep')) +
            _row('Separator pressure', _u(r.psep, 'pressureG', 1, 'psig', 0)) +
            _row('Separator temperature', _u(r.tsep, 'temperature', 1, '°F')) +
            _ok('Recombine the separator gas and liquid samples at ' + _fmt(_metric() ? G.WTS_units.format(r.gorSepCorr, 'gor').value : r.gorSepCorr, _metric() ? 2 : 1) +
                ' ' + (_metric() ? 'sm³/m³' : 'scf/bbl') + ' of separator liquid at separator conditions.') +
            '</div>';
        // 4 — samples
        var ex = function (v) { return v == null || !_fin(v) ? '—' : _fmt(_dv(v, 'pressureG'), _metric() ? 0 : 1); };
        var pc = function (v) { return _fin(v) ? (v >= 0 ? '+' : '') + _fmt(v, 2) + ' %' : '—'; };
        var mark = { ok: '✓', warn: '⚠', bad: '✗' };
        var rows = r.bottles.map(function (b) {
            return [String(b.row), b.id ? _esc(b.id) : '—', b.kind === 'gas' ? 'Gas' : 'Oil',
                ex(b.pOpen), ex(b.pOpenExpG), pc(b.openDev), ex(b.psat), pc(b.satDev), _fin(b.sg) ? _fmt(b.sg, 3) : '—', mark[b.verdict]];
        });
        var pl = _lab('pressureG', 'psig');
        h += '<div class="rbox"><div class="rbox-title">Sample Validity</div>' +
            (rows.length ? _tbl(['#', 'Bottle', 'Type', 'Opening p (' + pl + ')', 'Expected (' + pl + ')', 'Deviation',
                'Saturation p (' + pl + ')', 'vs separator', 'Gas gravity', 'Verdict'], rows) : _warn('No sample bottles entered.')) +
            (r.dup.oil ? _row('Oil duplicates: saturation pressure spread', _fmt(r.dup.oil.pct, 2) + ' %') : '') +
            (r.dup.gas ? _row('Gas duplicates: gravity spread', _fmt(r.dup.gas.pct, 2) + ' %') : '') +
            r.checks.map(_v).join('') +
            (r.fails ? _bad(r.fails + ' check(s) failed: resample or reject the flagged bottles before recombination.') :
                r.warns ? _warn('No check failed; review the ' + r.warns + ' warning(s).') : _ok('All sample checks passed.')) +
            '</div>';
        h += '<div><b>Notes</b> API RP 44 practice. Gas rate: AGA-3 / API MPMS 14.3 flow is proportional to Fgr·Fpv, so ' +
            'q_corr = q_field·√(SG_field/SG_lab)·(Fpv,lab/Fpv,field) with Fpv = 1/√Z at separator conditions; the field Z uses ' +
            'the field gravity with no impurities, the laboratory Z the laboratory gravity and composition. The correction ' +
            'does not depend on the base conditions. Shrinkage S = 1/Bo of the separator oil (Standing 1947) unless typed ' +
            '(use the laboratory separator test when available). GOR per STB = GOR per separator bbl / S. The total GOR ' +
            'adds Standing Rs at separator conditions as the stock-tank flash gas and is an estimate. Opening pressure: oil ' +
            'bottles are compared with separator pressure (open at separator temperature); gas bottles with separator ' +
            'pressure scaled by absolute temperature (ideal gas, Z ratio neglected). Duplicate spread = (max − min)/mean. ' +
            'Tolerances are user choices; RP 44 gives no fixed values.</div>';
        return h;
    }

    function _readInputs() {
        var bottles = [];
        for (var k = 1; k <= NB; k++) {
            bottles.push({ id: _str('sq_bid' + k), kind: _str('sq_bk' + k), pOpen: _num('sq_bpo' + k), tOpen: _num('sq_bto' + k), psat: _num('sq_bps' + k), sg: _num('sq_bsg' + k) });
        }
        return {
            psep: _num('sq_psep'), tsep: _num('sq_tsep'), api: _num('sq_api'), sgField: _num('sq_sgf'), sgLab: _num('sq_sgl'),
            co2: _num('sq_co2'), h2s: _num('sq_h2s'), n2: _num('sq_n2'), zField: _num('sq_zf'), zLab: _num('sq_zl'),
            qGas: _num('sq_qg'), qOil: _num('sq_qo'), oilBasis: _str('sq_basis'), shrMethod: _str('sq_shrm'), shrUser: _num('sq_shr'),
            tolOpen: _num('sq_tolo'), tolSat: _num('sq_tols'), tolDup: _num('sq_told'), bottles: bottles
        };
    }

    function _calcImpl() {
        var root = _byId('sq_root'), res = _byId('sq_res');
        if (!root) return null;
        var ins = root.querySelectorAll ? root.querySelectorAll('input,select') : [];
        for (var i = 0; i < ins.length; i++) if (ins[i].classList) ins[i].classList.remove('input-err');
        var r = compute(_readInputs());
        G.WTS_state = G.WTS_state || {};
        if (!r.ok) {
            G.WTS_state.sepqc = { ok: false, errors: r.errors.slice(), ts: Date.now() };
            var items = '';
            for (var j = 0; j < r.errors.length; j++) items += '<li>' + (MSG[r.keys[j]] ? MSG[r.keys[j]]() : _esc(r.errors[j])) + '</li>';
            for (var b = 0; b < r.bad.length; b++) {
                var k = r.bad[b], m = /^b(\d+)$/.exec(k);
                var ids = m ? ['sq_bpo' + m[1], 'sq_bto' + m[1], 'sq_bps' + m[1], 'sq_bsg' + m[1]] : [IDS[k]];
                ids.forEach(function (id) { var el = _byId(id); if (el && el.classList && (!m || String(el.value).trim() !== '')) el.classList.add('input-err'); });
            }
            if (res) { res.innerHTML = '<div class="val-error"><strong>Please fix the following:</strong><ul>' + items + '</ul></div>'; res.setAttribute('data-done', '1'); }
            return r;
        }
        G.WTS_state.sepqc = {
            ok: true, S: r.S, Bsep: r.Bsep, zField: r.zField, zLab: r.zLab, corr: r.corr, qGasCorr: r.qGasCorr,
            qOilSep: r.qOilSep, qOilST: r.qOilST, gorSepField: r.gorSepField, gorSTField: r.gorSTField,
            gorSepCorr: r.gorSepCorr, gorSTCorr: r.gorSTCorr, gorTotal: r.gorTotal,
            fails: r.fails, warns: r.warns, ts: Date.now()
        };
        if (res) { res.innerHTML = _resultsHtml(r); res.setAttribute('data-done', '1'); }
        return r;
    }
    G.calcSepQC = function () { return _canon(_calcImpl); };

    function _pageHtml() {
        var h = '<div id="sq_root"><div class="cols-2"><div style="min-width:0">';
        h += '<div class="card"><div class="card-title">Separator and Rates</div><div class="fg">' +
            _fg('sq_psep', 'Separator pressure (psig)', '500') +
            _fg('sq_tsep', 'Separator temperature (°F)', '100') +
            _fg('sq_api', 'Stock-tank oil gravity (°API)', '40') +
            _fg('sq_qg', 'Field gas rate (MSCFD)', '5000', ' min="0"') +
            _fg('sq_qo', 'Oil rate (BPD)', '2000', ' min="0"') +
            '<div class="fg-item"><label for="sq_basis">Oil rate basis</label>' +
            _selHtml('sq_basis', [['sep', 'Separator conditions (metered)'], ['st', 'Stock tank']], 'sep') + '</div>' +
            '</div></div>';
        h += '<div class="card"><div class="card-title">Gas Gravity and Z</div><div class="fg">' +
            _fg('sq_sgf', 'Field gas gravity used by the meter (air = 1)', '0.70') +
            _fg('sq_sgl', 'Laboratory gas gravity (blank = mean of gas bottles)', '', ' placeholder="blank = bottles"') +
            _fg('sq_co2', 'Laboratory CO2 (mol %)', '2') +
            _fg('sq_h2s', 'Laboratory H2S (mol %)', '0') +
            _fg('sq_n2', 'Laboratory N2 (mol %)', '0.5') +
            _fg('sq_zf', 'Field Z-factor (blank = calculate)', '', ' placeholder="blank = calculate"') +
            _fg('sq_zl', 'Laboratory Z-factor (blank = calculate)', '', ' placeholder="blank = calculate"') +
            '</div></div>';
        h += '<div class="card"><div class="card-title">Shrinkage and Tolerances</div><div class="fg">' +
            '<div class="fg-item"><label for="sq_shrm">Shrinkage source</label>' +
            _selHtml('sq_shrm', [['standing', 'Standing Bo at separator conditions'], ['user', 'Typed value (laboratory / meter)']], 'standing') + '</div>' +
            _fg('sq_shr', 'Shrinkage factor, typed (stock-tank / separator volume)', '0.90') +
            _fg('sq_tolo', 'Opening-pressure tolerance (%)', '5') +
            _fg('sq_tols', 'Saturation-pressure tolerance (%)', '5') +
            _fg('sq_told', 'Duplicate-agreement tolerance (%)', '2') +
            '</div></div>';
        // Sample table
        var pl = 'psig', tl = '°F';
        h += '<div class="card"><div class="card-title">Sample Bottles</div>' +
            '<div style="overflow-x:auto"><table class="dtable" id="sq_bottles"><thead><tr><th>#</th><th>Bottle ID</th><th>Type</th>' +
            '<th data-wts-unit-label="pressureG">Opening p (' + pl + ')</th>' +
            '<th data-wts-unit-label="temperature">Opening T (' + tl + ')</th>' +
            '<th data-wts-unit-label="pressureG">Lab saturation p at sep. T (' + pl + ')</th>' +
            '<th>Lab gas gravity</th></tr></thead><tbody>';
        for (var k = 1; k <= NB; k++) {
            var d = DEF_B[k - 1] || ['', k <= 2 ? 'oil' : 'gas', '', '', '', ''];
            var cell = function (id, val, aria) {
                return '<td><input type="number" step="any" id="' + id + '" value="' + val + '" aria-label="' + aria + '" style="width:100%;min-width:64px"></td>';
            };
            h += '<tr><td>' + k + '</td>' +
                '<td><input type="text" id="sq_bid' + k + '" value="' + d[0] + '" aria-label="Bottle ' + k + ' ID" maxlength="40" style="width:100%;min-width:64px"></td>' +
                '<td>' + _selHtml('sq_bk' + k, [['oil', 'Oil'], ['gas', 'Gas']], d[1], 'Bottle ' + k + ' type') + '</td>' +
                cell('sq_bpo' + k, d[2], 'Bottle ' + k + ' opening pressure') +
                cell('sq_bto' + k, d[3], 'Bottle ' + k + ' opening temperature') +
                cell('sq_bps' + k, d[4], 'Bottle ' + k + ' saturation pressure') +
                cell('sq_bsg' + k, d[5], 'Bottle ' + k + ' gas gravity') + '</tr>';
        }
        h += '</tbody></table></div>' +
            '<div class="info-bar" style="margin-top:12px">A row is used when it has an opening pressure, a saturation pressure or a gas gravity. ' +
            'Oil bottles: opening and saturation pressures at separator temperature. Gas bottles: opening pressure at the stated temperature.</div>' +
            '<div class="btn-row"><button class="btn btn-primary" id="sq_calc" onclick="calcSepQC()">Calculate</button></div></div>';
        h += '</div><div style="min-width:0"><div id="sq_res"></div></div></div></div>';
        return h;
    }

    function render(body) {
        if (!body) return;
        var t = _byId('pgTitle'), s = _byId('pgSub');
        if (t) t.textContent = TITLE;
        if (s) s.textContent = SUB;
        body.innerHTML = _pageHtml();
        _tag(UNITS);
        var root = _byId('sq_root');
        if (root && root.addEventListener) {
            root.addEventListener('change', function (e) {
                if (e && e.target && /^sq_/.test(e.target.id || '')) G.calcSepQC();
            });
        }
        G.calcSepQC();
    }
    G.renderSepQC = render;

    G.WTS_calcRegistry = G.WTS_calcRegistry || {};
    G.WTS_calcRegistry.sepqc = {
        key: 'sepqc',
        title: TITLE,
        navTitle: 'Sampling & GOR QC',
        sub: SUB,
        group: 'Well Testing',
        icon: '&#9878;',
        badge: 'Sampling',
        bc: 'dc-b-blue',
        desc: 'Separator and stock-tank GOR through shrinkage, gas rate with laboratory gravity and Z, recombination GOR and bottle checks (API RP 44).',
        render: function (body) { return G.renderSepQC(body); }
    };

    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('wts:unit-system-changed', function () {
            var r = _byId('sq_res');
            if (r && r.getAttribute && r.getAttribute('data-done') === '1') G.calcSepQC();
        });
    }
})();

// ─── END 49-calc-sepqc ─────────────────────────────────────────────

