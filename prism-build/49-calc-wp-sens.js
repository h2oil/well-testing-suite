// =============================================================================
// WTS — 49-calc-wp-sens.js  (Round 9; helper module: no page in window.WTS_calcRegistry)
// -----------------------------------------------------------------------------
// Well Performance sensitivity: case matrix and Jobs — docs/WELL-PERFORMANCE-PLAN.md §3.6, §6.
// WP0 STUB (contract only): every function below returns {ok:false, code:'STUB', name, wp, errors[]} until WP6 replaces it.
// The work package that implements a function removes its name from window.__WP_STUBS (tests/wellperf-shapes.test.js lists them).
// Interfaces (field units, §3.0; every result {ok, errors[], warnings[{code, msg, sev}], …}; nothing throws for user data):
//   WTS_wp_sens
//     .matrix(vars /*[{key, values[]}]*/)
//         → {ok, cases:[{values:{key: v}}]}
//     .job(M, vars)
//         → Job for PRiSM_autoInterp.drive: {step(), done(), progress(), result() → {cases:[{values, R}], table}, cancel()}
//     .table(result)
//         → {head[], rows[][]}
//     .csv(result)
//         → string
// =============================================================================
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var STUBS = G.__WP_STUBS = G.__WP_STUBS || [];
    function _mark(name) { if (STUBS.indexOf(name) === -1) STUBS.push(name); }
    function _stub(name, wp) { return { ok: false, code: 'STUB', name: name, wp: wp, errors: [name + ' is not built yet (' + wp + ')'], warnings: [] }; }
    var wp_sens = G.WTS_wp_sens = G.WTS_wp_sens || {};
    if (!wp_sens.matrix) { wp_sens.matrix = function () { return _stub('WTS_wp_sens.matrix', 'WP6'); }; _mark('WTS_wp_sens.matrix'); }
    if (!wp_sens.job) { wp_sens.job = function () { return _stub('WTS_wp_sens.job', 'WP6'); }; _mark('WTS_wp_sens.job'); }
    if (!wp_sens.table) { wp_sens.table = function () { return _stub('WTS_wp_sens.table', 'WP6'); }; _mark('WTS_wp_sens.table'); }
    if (!wp_sens.csv) { wp_sens.csv = function () { return _stub('WTS_wp_sens.csv', 'WP6'); }; _mark('WTS_wp_sens.csv'); }
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var names = ["WTS_wp_sens.matrix","WTS_wp_sens.job","WTS_wp_sens.table","WTS_wp_sens.csv"], bad = [];
    names.forEach(function (n) {
        var p = n.split('.'), f = p.length > 1 ? (G[p[0]] || {})[p[1]] : G[p[0]];
        if (typeof f !== 'function') bad.push(n + ' missing');
    });
    if (bad.length && typeof console !== 'undefined') console.error('[49-calc-wp-sens.js self-test] ' + bad.join('; '));
})();
