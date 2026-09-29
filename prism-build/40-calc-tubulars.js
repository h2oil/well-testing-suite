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

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var T = G.WTS_tubulars, fails = [];
    function near(a, b, tol, what) { if (!(Math.abs(a - b) <= tol)) fails.push(what + ': ' + a + ' vs ' + b); }
    near(T.capacity(6.276), 0.0382622, 1e-6, '7" 26# capacity');
    near(T.annularCapacity(6.276, 2.875), 0.0302326, 1e-6, '7" x 2-7/8" annulus');
    near(T.find('casing-7-26').drift, 6.151, 1e-9, '7" 26# drift');
    near(T.find('tubing-2.875-6.5').drift, 2.347, 1e-9, '2-7/8" drift');
    near(T.find('casing-9.625-47').wall, 0.472, 1e-9, '9-5/8" 47# wall');
    if (T.hostCasingKeys.some(function (k) { return !T.find(k); })) fails.push('host casing key missing');
    if (fails.length && typeof console !== 'undefined') console.error('[tubulars self-test] FAILED:\n  ' + fails.join('\n  '));
})();
