// =============================================================================
// WTS — 49-calc-wp-vlp.js  (Round 9; helper module: no page in window.WTS_calcRegistry)
// -----------------------------------------------------------------------------
// Well Performance vertical lift: registers hb / gray / nsl / gasTZ / single into WTS_flowline_corr; traverses and curves — docs/WELL-PERFORMANCE-PLAN.md §3.4, §4.4.
// WP0 STUB (contract only): every function below returns {ok:false, code:'STUB', name, wp, errors[]} until WP3 replaces it.
// The work package that implements a function removes its name from window.__WP_STUBS (tests/wellperf-shapes.test.js lists them).
// Interfaces (field units, §3.0; every result {ok, errors[], warnings[{code, msg, sev}], …}; nothing throws for user data):
//   WTS_wp_vlp
//     .traverse(F, W, q, o /*{from:"bottom"|"top", p0, corr, mult, tProfile, grid, stepFt}*/)
//         → {ok, profile:[{md, tvd, inc, p, t, hl, pattern, vm, vsl, vsg, rhoS, gradEl, gradF, gradAcc, ero}], pEnd, lost, grid, segments, restrictionsDp, warnings}
//     .curve(F, W, o /*{qList, p0, corr, mult, coarse, grid}*/)
//         → [{q, pwf|null, lost}]
//     .family(F, W, o, vary)
//         → [{value, curve}]
//     .gasDry(F, W, q, o)
//         → {ok, pwf, pEnd, zAvg, tAvg, warnings}  (average T and Z; Cullender-Smith in A2)
//     .singlePhase(F, W, q, o)
//         → {ok, pEnd, profile, warnings}
// =============================================================================
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var STUBS = G.__WP_STUBS = G.__WP_STUBS || [];
    function _mark(name) { if (STUBS.indexOf(name) === -1) STUBS.push(name); }
    function _stub(name, wp) { return { ok: false, code: 'STUB', name: name, wp: wp, errors: [name + ' is not built yet (' + wp + ')'], warnings: [] }; }
    var wp_vlp = G.WTS_wp_vlp = G.WTS_wp_vlp || {};
    if (!wp_vlp.traverse) { wp_vlp.traverse = function () { return _stub('WTS_wp_vlp.traverse', 'WP3'); }; _mark('WTS_wp_vlp.traverse'); }
    if (!wp_vlp.curve) { wp_vlp.curve = function () { return _stub('WTS_wp_vlp.curve', 'WP3'); }; _mark('WTS_wp_vlp.curve'); }
    if (!wp_vlp.family) { wp_vlp.family = function () { return _stub('WTS_wp_vlp.family', 'WP3'); }; _mark('WTS_wp_vlp.family'); }
    if (!wp_vlp.gasDry) { wp_vlp.gasDry = function () { return _stub('WTS_wp_vlp.gasDry', 'WP3'); }; _mark('WTS_wp_vlp.gasDry'); }
    if (!wp_vlp.singlePhase) { wp_vlp.singlePhase = function () { return _stub('WTS_wp_vlp.singlePhase', 'WP3'); }; _mark('WTS_wp_vlp.singlePhase'); }
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var names = ["WTS_wp_vlp.traverse","WTS_wp_vlp.curve","WTS_wp_vlp.family","WTS_wp_vlp.gasDry","WTS_wp_vlp.singlePhase"], bad = [];
    names.forEach(function (n) {
        var p = n.split('.'), f = p.length > 1 ? (G[p[0]] || {})[p[1]] : G[p[0]];
        if (typeof f !== 'function') bad.push(n + ' missing');
    });
    if (bad.length && typeof console !== 'undefined') console.error('[49-calc-wp-vlp.js self-test] ' + bad.join('; '));
})();
