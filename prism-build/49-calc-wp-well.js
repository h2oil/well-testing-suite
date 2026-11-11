// =============================================================================
// WTS — 49-calc-wp-well.js  (Round 9; helper module: no page in window.WTS_calcRegistry)
// -----------------------------------------------------------------------------
// Well Performance well path: deviation (minimum curvature via WTS_wellbore.surveyMC), strings → segments, restrictions, temperature, schematic data — docs/WELL-PERFORMANCE-PLAN.md §2.10, §3.1, §4.5, §4.6.
// WP0 STUB (contract only): every function below returns {ok:false, code:'STUB', name, wp, errors[]} until WP4 replaces it.
// The work package that implements a function removes its name from window.__WP_STUBS (tests/wellperf-shapes.test.js lists them).
// Interfaces (field units, §3.0; every result {ok, errors[], warnings[{code, msg, sev}], …}; nothing throws for user data):
//   WTS_wp_well
//     .build(well /*M.well*/, o)
//         → W = {ok, segments:[{name, len, id, dz, area?, restr?, md0, md1, tvd0, tvd1, inc}], nodes:{wellheadMd, midPerfMd, midPerfTvd, gauges[]}, stations:[{md, tvd, inc, azi, n, e, dep}], tAt(md) °F, warnings, errors}
//     .segmentsFor(W, o /*{from, toMd, path}*/)
//         → [{name, len ft, id in, dz ft, area?, restr?}]  (flow order, bottom → top)
//     .restrictions(W)
//         → [{kind, md, tvd, id, k, beta}]
//     .temperature(W, o /*{mode, tht_F, thtMeasured, F, dpTubing}*/)
//         → {ok, tAt(md), tht, bht, thtHyd, verdict, warnings}
//     .schematic(W, R /*solution or null*/)
//         → {trajectory:[{md, tvd, dep, n, e, inc, azi}], strings[], restrictions[], perfs:{topMd, botMd, midMd}, gauges[], choke, profile[] /*per-depth p, t, hl, vm, pattern from R*/}
// =============================================================================
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var STUBS = G.__WP_STUBS = G.__WP_STUBS || [];
    function _mark(name) { if (STUBS.indexOf(name) === -1) STUBS.push(name); }
    function _stub(name, wp) { return { ok: false, code: 'STUB', name: name, wp: wp, errors: [name + ' is not built yet (' + wp + ')'], warnings: [] }; }
    var wp_well = G.WTS_wp_well = G.WTS_wp_well || {};
    if (!wp_well.build) { wp_well.build = function () { return _stub('WTS_wp_well.build', 'WP4'); }; _mark('WTS_wp_well.build'); }
    if (!wp_well.segmentsFor) { wp_well.segmentsFor = function () { return _stub('WTS_wp_well.segmentsFor', 'WP4'); }; _mark('WTS_wp_well.segmentsFor'); }
    if (!wp_well.restrictions) { wp_well.restrictions = function () { return _stub('WTS_wp_well.restrictions', 'WP4'); }; _mark('WTS_wp_well.restrictions'); }
    if (!wp_well.temperature) { wp_well.temperature = function () { return _stub('WTS_wp_well.temperature', 'WP4'); }; _mark('WTS_wp_well.temperature'); }
    if (!wp_well.schematic) { wp_well.schematic = function () { return _stub('WTS_wp_well.schematic', 'WP4'); }; _mark('WTS_wp_well.schematic'); }
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var names = ["WTS_wp_well.build","WTS_wp_well.segmentsFor","WTS_wp_well.restrictions","WTS_wp_well.temperature","WTS_wp_well.schematic"], bad = [];
    names.forEach(function (n) {
        var p = n.split('.'), f = p.length > 1 ? (G[p[0]] || {})[p[1]] : G[p[0]];
        if (typeof f !== 'function') bad.push(n + ' missing');
    });
    if (bad.length && typeof console !== 'undefined') console.error('[49-calc-wp-well.js self-test] ' + bad.join('; '));
})();
