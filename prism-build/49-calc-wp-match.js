// =============================================================================
// WTS — 49-calc-wp-match.js  (Round 9; helper module: no page in window.WTS_calcRegistry)
// -----------------------------------------------------------------------------
// Well Performance correlation comparison, IPR from a test, production-test QC — docs/WELL-PERFORMANCE-PLAN.md §3.7, §5.
// WP0 STUB (contract only): every function below returns {ok:false, code:'STUB', name, wp, errors[]} until WP7 replaces it.
// The work package that implements a function removes its name from window.__WP_STUBS (tests/wellperf-shapes.test.js lists them).
// Interfaces (field units, §3.0; every result {ok, errors[], warnings[{code, msg, sev}], …}; nothing throws for user data):
//   WTS_wp_match
//     .compare(M, test, corrKeys)
//         → {ok, rows:[{corr, pCalc, err, errPct, rank, verified}]}
//     .iprFromTest(M, test, solveFor /*"pr"|"J"|"S"*/)
//         → {ok, value, pwf, method}
//     .tune(M, tests, corr, o)
//         → A2 (WP17)
//   WTS_wp_qc(M, tests)
//         → {ok, rows:[{id, flags:[{code, sev, msg}], score}]}
// =============================================================================
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var STUBS = G.__WP_STUBS = G.__WP_STUBS || [];
    function _mark(name) { if (STUBS.indexOf(name) === -1) STUBS.push(name); }
    function _stub(name, wp) { return { ok: false, code: 'STUB', name: name, wp: wp, errors: [name + ' is not built yet (' + wp + ')'], warnings: [] }; }
    var wp_match = G.WTS_wp_match = G.WTS_wp_match || {};
    if (!wp_match.compare) { wp_match.compare = function () { return _stub('WTS_wp_match.compare', 'WP7'); }; _mark('WTS_wp_match.compare'); }
    if (!wp_match.iprFromTest) { wp_match.iprFromTest = function () { return _stub('WTS_wp_match.iprFromTest', 'WP7'); }; _mark('WTS_wp_match.iprFromTest'); }
    if (!wp_match.tune) { wp_match.tune = function () { return _stub('WTS_wp_match.tune', 'WP7'); }; _mark('WTS_wp_match.tune'); }
    if (typeof G.WTS_wp_qc !== 'function') { G.WTS_wp_qc = function () { return _stub('WTS_wp_qc', 'WP7'); }; _mark('WTS_wp_qc'); }
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var names = ["WTS_wp_match.compare","WTS_wp_match.iprFromTest","WTS_wp_match.tune","WTS_wp_qc"], bad = [];
    names.forEach(function (n) {
        var p = n.split('.'), f = p.length > 1 ? (G[p[0]] || {})[p[1]] : G[p[0]];
        if (typeof f !== 'function') bad.push(n + ' missing');
    });
    if (bad.length && typeof console !== 'undefined') console.error('[49-calc-wp-match.js self-test] ' + bad.join('; '));
})();
