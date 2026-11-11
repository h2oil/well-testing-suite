// =============================================================================
// WTS — 49-calc-wp-ipr.js  (Round 9; helper module: no page in window.WTS_calcRegistry)
// -----------------------------------------------------------------------------
// Well Performance inflow (delegates to WTS_oilipr_model / WTS_gasdeliv_model), skin table, PRiSM import — docs/WELL-PERFORMANCE-PLAN.md §3.3, §4.2, §4.3.
// WP0 STUB (contract only): every function below returns {ok:false, code:'STUB', name, wp, errors[]} until WP2 replaces it.
// The work package that implements a function removes its name from window.__WP_STUBS (tests/wellperf-shapes.test.js lists them).
// Interfaces (field units, §3.0; every result {ok, errors[], warnings[{code, msg, sev}], …}; nothing throws for user data):
//   WTS_wp_ipr
//     .curve(spec /*M.res*/, F)
//         → I = {ok, kind, pr, pb, aof, J, qAt(pwf), pwfAt(q), curve:[{q, pwf}], skin, warnings}
//     .fit(kind, points, opts)
//         → {ok, params, r2, warnings}
//     .fromWell()
//         → {ok, spec, provenance:{key: source}, warnings}  (PRiSM_getWell / PRiSM_getLastFit / PRiSM_gasDeliverability; null pi kept null)
//     .skin(spec)
//         → SkinTable {parts:[{key, label, S, basis, source}], total, dpSkin(q), FE}
// =============================================================================
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var STUBS = G.__WP_STUBS = G.__WP_STUBS || [];
    function _mark(name) { if (STUBS.indexOf(name) === -1) STUBS.push(name); }
    function _stub(name, wp) { return { ok: false, code: 'STUB', name: name, wp: wp, errors: [name + ' is not built yet (' + wp + ')'], warnings: [] }; }
    var wp_ipr = G.WTS_wp_ipr = G.WTS_wp_ipr || {};
    if (!wp_ipr.models) wp_ipr.models = {};
    if (!wp_ipr.curve) { wp_ipr.curve = function () { return _stub('WTS_wp_ipr.curve', 'WP2'); }; _mark('WTS_wp_ipr.curve'); }
    if (!wp_ipr.fit) { wp_ipr.fit = function () { return _stub('WTS_wp_ipr.fit', 'WP2'); }; _mark('WTS_wp_ipr.fit'); }
    if (!wp_ipr.fromWell) { wp_ipr.fromWell = function () { return _stub('WTS_wp_ipr.fromWell', 'WP2'); }; _mark('WTS_wp_ipr.fromWell'); }
    if (!wp_ipr.skin) { wp_ipr.skin = function () { return _stub('WTS_wp_ipr.skin', 'WP2'); }; _mark('WTS_wp_ipr.skin'); }
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var names = ["WTS_wp_ipr.curve","WTS_wp_ipr.fit","WTS_wp_ipr.fromWell","WTS_wp_ipr.skin"], bad = [];
    names.forEach(function (n) {
        var p = n.split('.'), f = p.length > 1 ? (G[p[0]] || {})[p[1]] : G[p[0]];
        if (typeof f !== 'function') bad.push(n + ' missing');
    });
    if (bad.length && typeof console !== 'undefined') console.error('[49-calc-wp-ipr.js self-test] ' + bad.join('; '));
})();
