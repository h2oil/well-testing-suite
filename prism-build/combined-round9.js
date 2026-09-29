
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
//   • 48-calc-wellkill
//   • 49-calc-chokeperf
//   • 49-calc-dispersion
//   • 49-calc-flowline
//   • 49-calc-fluids
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
        return Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: (d == null ? 2 : d) });
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
    function _fmt(v, d) { if (v == null || !isFinite(v)) return '—'; return Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: (d == null ? 2 : d) }); }
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
        return Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: (d == null ? 2 : d) });
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
        hs_sq: 'gasRate', hs_sin: 'concentration', hs_sout: 'concentration'
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
            ratio: function () { return 'Product consumption must be between 0.1 and 10 US gal per lb H2S.'; }
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
        if (r.x100_ft < 50) v += _ok('100 ppm radius of exposure is under 50 ft.');
        else v += _warn('100 ppm radius of exposure is ' + _fa(r.x100_ft) + ' ft — check for public areas inside it; a contingency plan may be required.');
        if (r.x100_ft > 3000) v += _warn('100 ppm radius of exposure exceeds 3,000 ft.');
        if (r.x500_ft >= 50) v += _warn('500 ppm radius of exposure is ' + _fa(r.x500_ft) + ' ft — check for public roads inside it.');
        res.innerHTML =
            '<div class="rbox"><div class="rbox-title">Radius of Exposure</div>' +
            _row('H2S mole fraction', _fmt(r.mf, 6)) +
            _row('Escape rate', _fmt(r.Q, 0) + ' scf/d (' + _fa(r.Q * SCF_TO_M3) + ' m³/d)') +
            _row('100 ppm radius of exposure', _fa(r.x100_ft) + ' ft (' + _fa(r.x100_m) + ' m)') +
            _row('500 ppm radius of exposure', _fa(r.x500_ft) + ' ft (' + _fa(r.x500_m) + ' m)') +
            _row('H2S release', _fa(r.h2s_lbd) + ' lb/d (' + _fa(r.h2s_kgd) + ' kg/d)') +
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
            _row('SO2', _fa(r.so2_lbhr) + ' lb/hr (' + _fa(r.so2_kghr) + ' kg/hr)') +
            _row('SO2 per day', _fa(r.so2_td) + ' t/d') +
            _row('Unburned H2S', _fa(r.h2s_lbhr) + ' lb/hr (' + _fa(r.h2s_kghr) + ' kg/hr)') +
            _note('Ground-level SO2 concentration depends on flare height, plume rise and weather; a dispersion ' +
                'screening tool is planned (roadmap item 11). Use Flare Emissions for full-period reporting. ' +
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
            _row('H2S removed', _fa(r.lb_d) + ' lb/d (' + _fa(r.kg_d) + ' kg/d)') +
            _row('Inlet H2S', _fa(cin) + ' ppm = ' + _fa(r.gr_in) + ' gr/100 scf') +
            _row('Outlet H2S', _fa(cout) + ' ppm = ' + _fa(r.gr_out) + ' gr/100 scf') +
            _row('Product', _fa(r.gal_d) + ' US gal/d (' + _fa(r.L_d) + ' L/d)') +
            _row('Injection rate', _fa(r.L_hr) + ' L/hr (' + _fa(r.gal_hr) + ' US gal/hr)') +
            v +
            _note('Consumption depends on product strength, contact time, temperature and injection design. ' +
                'Use the supplier\'s figure; published field trials of triazine products report about 1.2 to 1.9 ' +
                'US gal per lb H2S removed. Stoichiometric use is lower. Watch for solids from spent product. ' +
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
            _fg('hs_ratio', 'Product consumption, US gal per lb H2S', '1.5', ' min="0.1" max="10"') +
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
        return Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: (d == null ? 2 : d) });
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
//       1966), gas compressibility cg, heat-capacity ratio k and speed of sound;
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

    // Properties at one (p, T) given the pseudo-criticals.
    function _state(L, pc, sg, p, tF, full) {
        var TR = tF + RANKINE, Tpr = TR / pc.Tpc, Ppr = p / pc.Ppc;
        var z = _zBoth(L, Tpr, Ppr), Z = z.dak;
        var M = MW_AIR * sg;
        var s = {
            p: p, t: tF, Tpr: Tpr, Ppr: Ppr, zDAK: z.dak, zHY: z.hy,
            zDiff: z.hy - z.dak, zDiffPct: 100 * (z.hy - z.dak) / z.dak, z: Z,
            Bg_ft3scf: P_SC * Z * TR / (T_SC * p),
            // rb/Mscf from the same standard conditions (PRiSM Bg() rounds the constant to 5.035).
            Bg_rbMscf: 1000 * P_SC * Z * TR / (T_SC * p) / FT3_PER_BBL,
            rho: p * M / (Z * R_GAS * TR),
            mu: L.mu_g_leeGonzalezEakin(sg, tF, Z, p)
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
        var st = _state(L, pc, sg, p, t, true);
        if (!(_fin(st.zDAK) && _fin(st.zHY) && pc.Tpc > 0 && TR / pc.Tpc >= 1.0)) {
            return { ok: false, bad: ['t'], keys: ['tpc'], tpcF: pc.Tpc - RANKINE, errors: ['Temperature is below the pseudo-critical temperature (' + _fmt(pc.Tpc - RANKINE, 1) + ' °F); the gas correlations do not apply (Tpr must be at least 1.0).'] };
        }
        var hc = heatCapacity(pc.sgHc, t, yco2, yh2s, yn2);
        var M = MW_AIR * sg;
        // Speed of sound: c = √(k·Z·g_c·R·T / M), k = ideal-gas Cp°/Cv° at T.
        var c = Math.sqrt(hc.k * st.z * GC * R_FT_LBF * TR / M);

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
            sep = _state(L, pc, sg, psep, tsep, false);
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
            cg: st.cg, cpr: st.cpr, cp: hc.cp, cv: hc.cv, k: hc.k, c: c,
            sep: sep, table: table, curve: curve, pMax: pMax, warnings: warnings
        };
    }

    G.WTS_gaspvt_compute = compute;
    G.WTS_gaspvt_pseudoCriticals = pseudoCriticals;
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
            _row('Gas compressibility cg', _us(r.cg, 'compressibility', 4, '1/psi')) +
            _row('Pseudo-reduced compressibility cpr', _sig(r.cpr, 4)) +
            _row('Cp/Cv (k), ideal gas', _fmt(r.k, 4)) +
            _row('Speed of sound', _u(r.c, 'velocity', 1, 'ft/s')) +
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
            'Standard conditions 14.696 psia and 60 °F. Viscosity is Lee–Gonzalez–Eakin with the total gas gravity (no ' +
            'impurity correction). k is the ideal-gas Cp°/Cv° at the flowing temperature: Cp° of a paraffin gas of the ' +
            'hydrocarbon molecular weight (interpolated between methane, ethane and propane) mixed with N2, CO2 and H2S ' +
            '(Reid–Prausnitz–Poling heat capacities). Speed of sound c = √(k·Z·R·T/M); the real-gas departure of k is ' +
            'neglected, which is usual for engineering use but understates c at high pressure. Fpv = √(Zb/Z) with the DAK base Z at 14.696 psia / 60 °F (AGA-3; v3.0, was 1/√Z).</div>';
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
            Bg_ft3scf: r.Bg_ft3scf, Bg_rbMscf: r.Bg_rbMscf, rho: r.rho, mu: r.mu, cg: r.cg, k: r.k, c: r.c,
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
        return Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: (d == null ? 2 : d) });
    }
    function _fixed(v, d) {
        if (v == null || !isFinite(v)) return '—';
        return Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
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
        var sections = [
            { key: 'tubing', name: 'Tubing', from: 0, to: pmd, idIn: tub.id, cap: tubCap },
            { key: 'casing', name: 'Casing below packer', from: pmd, to: tmd, idIn: cas.id, cap: casCap },
            { key: 'perfs', name: 'Perforated interval', from: tmd, to: bmd, idIn: cas.id, cap: casCap },
            { key: 'rathole', name: 'Rathole', from: bmd, to: pbtd, idIn: cas.id, cap: casCap }
        ];
        var nIn = to === 'top' ? 2 : to === 'bot' ? 3 : 4;
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
            annCap: (cas.id * cas.id - tub.od * tub.od) * K_CAP
        };

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

        // Static pumping schedule, 0 → 100 % of the bullhead volume (MD → TVD linear between
        // surface, packer and top perforation; below the top perforation the front is at the perfs).
        function tvdAt(md) {
            if (md <= pmd) return pmd > 0 ? md / pmd * ptvd : 0;
            if (md <= tmd) return tmd > pmd ? ptvd + (md - pmd) / (tmd - pmd) * (tvd - ptvd) : tvd;
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
            schedule.push({
                pct: n * 10, vol: v, strokes: v / pump, frontMd: fmd, frontTvd: ftvd,
                sitp: Math.max(0, pres - h), masp: Math.min(pFrac - h, mShoe)
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
        wk_od: 'percent', wk_pump: 'volume', wk_spm: 'count',
        wk_gp: 'pressureG', wk_gtvd: 'length', wk_glen: 'length', wk_gmix: 'length', wk_ghl: 'percent',
        wk_grho: 'densityLiquid', wk_gsg: 'sg', wk_gt: 'temperature', wk_gz: 'dimensionless'
    };
    var KILL_IDS = {
        pres: 'wk_pres', tvd: 'wk_tvd', ob: 'wk_ob', kwo: 'wk_kwo', fg: 'wk_fg', wf: 'wk_wf', ann: 'wk_ann',
        stvd: 'wk_stvd', sfg: 'wk_sfg', tub: 'wk_tub', cas: 'wk_cas', pmd: 'wk_pmd', ptvd: 'wk_ptvd',
        tmd: 'wk_tmd', bmd: 'wk_bmd', pbtd: 'wk_pbtd', od: 'wk_od', pump: 'wk_pump', spm: 'wk_spm'
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
    function _ppgTriple(ppg) {
        return _fixed(ppg, 2) + ' ppg · SG ' + _fixed(ppg / PPG_PER_SG, 3) + ' · ' + _fmt(ppg * KGM3_PER_PPG, 0) + ' kg/m³';
    }

    // A single density in ppg, with its kg/m³ companion in Metric mode (imperial text unchanged).
    function _ppgMet(ppg) {
        return _fixed(ppg, 2) + ' ppg' + (_metric() ? ' (' + _fmt(ppg * KGM3_PER_PPG, 0) + ' kg/m³)' : '');
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
            '</div>';

        // Pressure limits
        var pv = '';
        if (L.killFracs) pv += _bad('Kill fluid gradient is at or above the fracture gradient. Expect losses; use a lighter fluid with back-pressure or a loss plan.');
        if (L.windowStart <= 0) pv += _bad('Shut-in tubing pressure is at or above the maximum surface pressure: bullheading would fracture the formation.');
        else if (L.windowStart < WINDOW_FRAC * L.pFrac) pv += _warn('Narrow bullhead window at the start: ' + P(L.windowStart) + ' between shut-in pressure and the fracture limit.');
        else pv += _ok('Bullhead window at the start is ' + P(L.windowStart) + ' above the shut-in tubing pressure.');
        if (L.maspEnd <= 0 && !L.killFracs) pv += _bad('Maximum surface pressure reaches zero before the kill fluid reaches the perforations.');
        h += '<div class="rbox"><div class="rbox-title">Surface Pressure Limits</div>' +
            _row('Fracture pressure at top perforation', P(L.pFrac)) +
            _row('Fracture gradient', _grad(L.fgGrad)) +
            _row('Shut-in tubing pressure, estimated', P(L.sithp)) +
            _row('Max surface pressure at start', P(L.maspStart)) +
            _row('Max surface pressure at end', P(L.maspEnd)) +
            _row('Surface pressure needed at end', P(L.endReq)) +
            (L.shoe ? _row('Shoe: fracture pressure', P(L.shoe.pFrac)) +
                _row('Shoe: max surface pressure start / end', P(L.shoe.start) + ' / ' + P(L.shoe.end)) +
                _row('Governing limit', L.governs === 'shoe' ? 'casing shoe' : 'top perforation') : '') +
            pv +
            '<div class="rbox-title" style="margin-top:10px">Static Pumping Schedule</div>' +
            _tbl(['Pumped', 'Volume', 'Strokes', 'Front MD', 'Shut-in pressure', 'Max surface pressure'], b.schedule.map(function (s) {
                return [s.pct + ' %', V(s.vol), _fmt(Math.round(s.strokes), 0), ft(s.frontMd), P(s.sitp), P(s.masp)];
            })) +
            _note('Static values: no pipe friction, no gas migration, and fluids are assumed incompressible. Pipe friction at ' +
                'the pump rate adds to the surface pressure. Keep the pump pressure below the maximum surface pressure and the ' +
                'wellhead / treating-iron rating. The shoe limit applies where the casing sees the pressure, e.g. no packer or a leak.') +
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
            _tbl(['Brine', 'Max ppg', 'Max SG', 'Max kg/m³', 'Reaches kill fluid', 'Crystallisation / notes'], r.brines.map(function (x) {
                return [x.name, _fixed(x.ppg, 2), _fixed(x.sg, 2), _fmt(x.kgm3, 0), x.reaches ? 'yes' : 'no', x.note];
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
            od: _num('wk_od'), pump: _num('wk_pump'), spm: _num('wk_spm')
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
            _sel('wk_to', 'Displace to', [{ v: 'top', t: 'Top perforation' }, { v: 'bot', t: 'Bottom perforation' }, { v: 'pbtd', t: 'PBTD, rathole included' }], 'top') +
            _fg('wk_od', 'Over-displacement (%)', '10', ' min="0" max="100"') +
            _fg('wk_pump', 'Pump output per stroke (bbl)', '0.1', ' min="0"') +
            _fg('wk_spm', 'Pump speed, strokes per minute', '40', ' min="0"') +
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
        return Number(v).toLocaleString(undefined, { minimumFractionDigits: (d == null ? 2 : d), maximumFractionDigits: (d == null ? 2 : d) });
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
        return Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: (d == null ? 2 : d) });
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
//   Gas rate = separator gas at standard conditions (22-units WTS_baseConditions,
//   default 60 °F / 14.696 psia). Free gas = qg − qo·Rs.
//
// PUBLIC API (window.*)
//   WTS_flowline_bb(input)        Beggs & Brill gradient at one point (no PVT)
//   WTS_flowline_props(fluid, p, t)  in-situ fluid properties
//   WTS_flowline_compute(input)   full routes → {ok, routes[], …} or {ok:false, errors, bad}
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
        return Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: (d == null ? 2 : d) });
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
    function march(route, fluid, p0g, t0, t1, opt) {
        var segs = route.segments, total = 0;
        segs.forEach(function (s) { total += s.len; });
        var P = p0g + PATM, x = 0, out = [], profile = [], lost = null;
        var first = null;
        function pt(xx) { return total > 0 ? t0 + (t1 - t0) * xx / total : t0; }
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
                var ta = pt(x), tb = pt(x + dx), tm = (ta + tb) / 2;
                var g = gAt(P, ta, s);
                if (j === 0) { r.hlIn = g.hl; r.in = g; if (!first) first = g; }
                var P2 = P - g.grad * dx;
                for (var it = 0; it < 3; it++) {
                    var pm = (P + Math.max(P2, 1)) / 2;
                    g = gAt(pm, tm, s);
                    P2 = P - g.grad * dx;
                }
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
                P = P2; x += dx;
                profile.push({ x: x, p: P - PATM, t: tb, hl: g.hl, pattern: g.pattern });
            }
            r.pOut = lost ? null : P - PATM;
            r.dp = lost ? null : r.pIn - r.pOut;
            r.tOut = pt(x);
            out.push(r);
        }
        return { segments: out, profile: profile, pIn: p0g, pOut: lost ? null : P - PATM, dp: lost ? null : p0g - (P - PATM),
            length: total, lost: lost, inlet: first };
    }

    var PAT_NAME = { segregated: 'Segregated', transition: 'Transition', intermittent: 'Intermittent', distributed: 'Distributed',
        gas: 'Single-phase gas', liquid: 'Single-phase liquid', none: 'No flow' };

    // input = {qo, qw, qg, api, sgg, sgw, pwh psig, t0, t1 °F, psep psig, rough in, payne, accel,
    //          well: [{name,len,id,dz}], flare: [{name,len,id,dz}]}
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
        need(_fin(t1) && t1 >= 0 && t1 <= 400, 't1', 'Arrival temperature must be between 0 and 400 °F.');
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
        if (!_lib()) { errors.push('The PVT correlation library (PRiSM) is not loaded.'); bad.push('lib'); }
        if (errors.length) return { ok: false, errors: errors, bad: bad };

        var opt = { rough: rough, payne: !!i.payne, accel: !!i.accel };
        var fluid = { qo: qo, qw: qw, qg: qg, api: api, sgg: sgg, sgw: sgw };
        var r1 = march({ segments: well }, fluid, pwh, t0, t1, opt);
        r1.key = 'well'; r1.name = 'Wellhead to separator';
        r1.reaches = r1.pOut != null && r1.pOut >= psep - 1e-9;
        r1.margin = r1.pOut != null ? r1.pOut - psep : null;
        var r2 = null;
        if (flare.length && qg > 0) {
            r2 = march({ segments: flare }, { qo: 0, qw: 0, qg: qg, api: api, sgg: sgg, sgw: sgw }, psep, t1, t1, opt);
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
            flareSkipped: flare.length && !(qg > 0)
        };
    }

    G.WTS_flowline_bb = bb;
    G.WTS_flowline_props = function (fluid, p, t) { return _lib() ? props(fluid, p, t) : null; };
    G.WTS_flowline_compute = compute;
    G.WTS_flowline_friction = { smooth: fSmooth, colebrook: fColebrook };
    G.WTS_flowline_sigma = { oil: sigmaOil, water: sigmaWater };

    // ── Page ─────────────────────────────────────────────────────────
    var TITLE = 'Multiphase Flowline Pressure Drop';
    var SUB = 'Beggs & Brill with Payne corrections: flow pattern, holdup, elevation, friction and acceleration, segment by segment from the wellhead to the separator and the flare';
    var UNITS = {
        fl_qo: 'liquidRate', fl_qw: 'liquidRate', fl_qg: 'gasRate', fl_api: 'api', fl_sgg: 'sg', fl_sgw: 'sg',
        fl_pwh: 'pressureG', fl_t0: 'temperature', fl_t1: 'temperature', fl_psep: 'pressureG', fl_rough: 'lengthSmall'
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
            well: rd(WELL_IDS), flare: rd(FLARE_IDS)
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
        rough: function () { return 'Pipe roughness must be between 0 and ' + _u(0.1, 'lengthSmall', 1, 'in', 2) + '.'; }
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
            (r.flare ? _row('Pressure drop, separator to flare tip', r.flare.dp == null ? '—' : dP(r.flare.dp)) +
                _row('Flare tip pressure', r.flare.pOut == null ? '—' : P(r.flare.pOut)) : '') +
            v + '</div>';

        // Inlet conditions
        if (pr && bI) {
            h += '<div class="rbox"><div class="rbox-title">Inlet Conditions and Fluid Properties</div>' +
                _row('Producing GOR', _u(pr.gor, 'gor', 0, 'SCF/STB', 1)) +
                _row('Solution GOR at inlet, Standing', _u(pr.rs, 'gor', 0, 'SCF/STB', 1)) +
                _row('Oil FVF, Standing', _fmt(pr.bo, 4) + ' rb/STB') +
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
                    'Elevation', 'Friction', 'Acceleration', 'Total drop', 'Max velocity', 'Erosional ratio'], rt.segments.map(function (s) {
                    return [s.name, ft(s.len), inch(s.id), _fmt(s.theta, 1) + '°',
                        s.patterns.map(function (p) { return PAT_NAME[p] || p; }).join(' → ') || '—',
                        _fmt(s.hlIn, 3) + ' → ' + _fmt(s.hlOut, 3), P(s.pIn), s.pOut == null ? '—' : P(s.pOut),
                        dP(s.dpEl), dP(s.dpF), dP(s.dpAcc), s.dp == null ? '—' : dP(s.dp), vel(s.vmMax), _fmt(s.eroMax, 2)];
                })) + '</div>';
        });

        h += '<div class="rbox"><div class="rbox-title">Pressure vs Distance</div>' +
            '<div class="chart-wrap"><canvas id="fl_chart" width="600" height="320"></canvas></div>' +
            _note('Beggs &amp; Brill (1973) in the form of Brill &amp; Mukherjee (1999). With the Payne et al. (1979) option the holdup is ' +
                'multiplied by 0.924 uphill and 0.685 downhill (horizontal unchanged) and the no-slip friction factor is the rough-pipe ' +
                'Colebrook value; without it the original smooth-pipe factor is used. Holdup is held at or above the no-slip value in ' +
                'horizontal and uphill flow. Fluid properties at each step: Standing Rs and Bo, Beggs-Robinson oil viscosity, DAK Z, ' +
                'Lee-Gonzalez-Eakin gas viscosity, Baker-Swerdloff and Hough surface tensions. Temperature is linear from the inlet to the ' +
                'arrival temperature (use Line Heat Loss for it). The flare line carries the separator gas at the separator temperature. ' +
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
            '</div><div class="btn-row"><button class="btn btn-primary" id="fl_calc" onclick="calcFlowline()">Calculate</button>' +
            '<button class="btn btn-secondary" id="fl_useheat" onclick="WTS_flowlineUseHeat()">Use temperatures from Line Heat Loss</button></div>' +
            '<div id="fl_heatmsg"></div></div>' +
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
        return Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: (d == null ? 2 : d) });
    }
    function _fx(v, d) {
        if (v == null || !isFinite(v)) return '—';
        return Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
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
    function _ppg3(v) { return _fx(v, 2) + ' ppg · SG ' + _fx(v / WATER_PPG, 3) + ' · ' + _fmt(v * 119.826, 0) + ' kg/m³'; }
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
            _row('Water requirement', _fx(r.waterGalSk, 2) + ' gal/sack (' + _fx(r.waterGalSk * 3.78541, 1) + ' L/sack)') +
            _row('Water-to-cement ratio', _fx(r.wcr * 100, 1) + ' % by mass') +
            _row('Slurry yield', _fx(r.yieldFt3, 3) + ' ft³/sack (' + _fx(r.yieldFt3 * 28.3168, 1) + ' L/sack)') +
            v + '</div>' +
            '<div class="rbox"><div class="rbox-title">Slurry Volume &amp; Sacks</div>' +
            _tbl(['Section', 'Length', 'Capacity', 'Volume'], [
                ['Annulus, casing x hole', _u(r.annLen, 'length', 0, 'ft', 1), _u(r.annCap, 'capacity', 5, 'bbl/ft', 5), V(r.annBbl)],
                ['Open-hole excess', '', '', V(r.excessBbl)],
                ['Shoe track', '', _u(r.pipeCap, 'capacity', 5, 'bbl/ft', 5), V(r.trackBbl)]
            ]) +
            _row('Total slurry', V(r.slurryBbl) + ' (' + _fmt(r.slurryFt3, 0) + ' ft³)') +
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
        var v = r.cautions.map(function (c) { return c.lvl === 'bad' ? _bad(c.t) : _warn(c.t); }).join('');
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
        return Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: (d == null ? 2 : d) });
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
        return Number(v).toLocaleString(undefined, { minimumFractionDigits: (d == null ? 2 : d), maximumFractionDigits: (d == null ? 2 : d) });
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
            _row('Thermal expansion α60', (alpha60(L.rho60, L.group) * 1e6).toFixed(3) + ' ×10⁻⁶ /°F') +
            _row('Compressibility F at 60 °F', (fpRho(L.rho60, 60) * 1e6).toFixed(3) + ' ×10⁻⁶ /psi') +
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
                _row('GSVp (prover at 60 °F, 0 psig)', V(fa.gsvp, 4)) +
                _row('ISVm (meter at 60 °F, 0 psig)', V(fa.isvm, 4)) +
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
                    ['3', 'CPL at ' + P(tk.pm) + ' (F = ' + (tk.F * 1e6).toFixed(3) + ' ×10⁻⁶ /psi)', _fx(tk.cpl, f4)],
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
        return Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: (d == null ? 2 : d) });
    }
    function _fx(v, d) {
        if (v == null || !isFinite(v)) return '—';
        return Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
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
        return Number(v).toLocaleString(undefined, { minimumFractionDigits: (d == null ? 2 : d), maximumFractionDigits: (d == null ? 2 : d) });
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
        if (shrM === 'user' && !(_fin(shrU) && shrU > 0.3 && shrU <= 1)) err('shrUser', 'Shrinkage factor must be above 0.3 and no more than 1 (stock-tank bbl per separator bbl).');
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
            _row('Shrinkage factor S (STB per separator bbl)', _fmt(r.S, 4) + (r.shrMethod === 'user' ? ' (typed)' : ' (Standing)')) +
            _row('Separator volume factor 1/S (separator bbl per STB)', _fmt(r.Bsep, 4)) +
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
            _fg('sq_shr', 'Shrinkage factor, typed (STB per separator bbl)', '0.90') +
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

