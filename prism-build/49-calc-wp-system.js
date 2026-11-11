// =============================================================================
// WTS — 49-calc-wp-system.js  (Round 9; helper module: no page in window.WTS_calcRegistry)
// -----------------------------------------------------------------------------
// Well Performance system solver: roots, stability, breakdown, design modes, shut-in, bean schedule; liquid loading; checks — docs/WELL-PERFORMANCE-PLAN.md §3.5, §4.7–§4.14.
// WP0 STUB (contract only): every function below returns {ok:false, code:'STUB', name, wp, errors[]} until WP5 replaces it.
// The work package that implements a function removes its name from window.__WP_STUBS (tests/wellperf-shapes.test.js lists them).
// Interfaces (field units, §3.0; every result {ok, errors[], warnings[{code, msg, sev}], …}; nothing throws for user data):
//   WTS_wp_system
//     .solve(M, ctx /*{warm, grid, coarseOnly, budget}*/)
//         → R = {ok, node, roots:[{q, p, stable, dDdq}], op, qs, vlpMin, traverse, breakdown:[{key, dp}], surface:{thp, tht, thtHyd, pChokeDn, choke:{regime, ratio}}, rates:{qo, qw, qg, qL}, velocities, flags[], discontinuities[], loading, warnings, evals, grid}
//     .designFor(M, target /*{bean: q} | {thp: q}*/)
//         → Job (PRiSM_autoInterp.drive): result() → {ok, bean | thp, R}
//     .maxRate(M)
//         → {ok, q, thp, R}
//     .shutIn(M)
//         → {ok, gasFilled, actualFluid, partLiquid:[{liquidTopMd, sithp}], rating:{verdict, margin}}
//     .beanSchedule(M, beans)
//         → Job: result() → [{bean, q, thp, tht, dpChoke, regime, stable, loadingMargin}]
//   WTS_wp_loading(R, F, W)
//         → {ok, method, suggested, qc_MMscfd, limitingMd, margin, perDepth:[{md, tvd, vg, vc, qc}]}
//   WTS_wp_check(M)
//         → {ok, errors[], warnings[], validity:[{corr, inRange, msg}]}
// =============================================================================
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var STUBS = G.__WP_STUBS = G.__WP_STUBS || [];
    function _mark(name) { if (STUBS.indexOf(name) === -1) STUBS.push(name); }
    function _stub(name, wp) { return { ok: false, code: 'STUB', name: name, wp: wp, errors: [name + ' is not built yet (' + wp + ')'], warnings: [] }; }
    var wp_system = G.WTS_wp_system = G.WTS_wp_system || {};
    if (!wp_system.solve) { wp_system.solve = function () { return _stub('WTS_wp_system.solve', 'WP5'); }; _mark('WTS_wp_system.solve'); }
    if (!wp_system.designFor) { wp_system.designFor = function () { return _stub('WTS_wp_system.designFor', 'WP5'); }; _mark('WTS_wp_system.designFor'); }
    if (!wp_system.maxRate) { wp_system.maxRate = function () { return _stub('WTS_wp_system.maxRate', 'WP5'); }; _mark('WTS_wp_system.maxRate'); }
    if (!wp_system.shutIn) { wp_system.shutIn = function () { return _stub('WTS_wp_system.shutIn', 'WP5'); }; _mark('WTS_wp_system.shutIn'); }
    if (!wp_system.beanSchedule) { wp_system.beanSchedule = function () { return _stub('WTS_wp_system.beanSchedule', 'WP5'); }; _mark('WTS_wp_system.beanSchedule'); }
    if (typeof G.WTS_wp_loading !== 'function') { G.WTS_wp_loading = function () { return _stub('WTS_wp_loading', 'WP5'); }; _mark('WTS_wp_loading'); }
    if (typeof G.WTS_wp_check !== 'function') { G.WTS_wp_check = function () { return _stub('WTS_wp_check', 'WP5'); }; _mark('WTS_wp_check'); }
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var names = ["WTS_wp_system.solve","WTS_wp_system.designFor","WTS_wp_system.maxRate","WTS_wp_system.shutIn","WTS_wp_system.beanSchedule","WTS_wp_loading","WTS_wp_check"], bad = [];
    names.forEach(function (n) {
        var p = n.split('.'), f = p.length > 1 ? (G[p[0]] || {})[p[1]] : G[p[0]];
        if (typeof f !== 'function') bad.push(n + ' missing');
    });
    if (bad.length && typeof console !== 'undefined') console.error('[49-calc-wp-system.js self-test] ' + bad.join('; '));
})();
