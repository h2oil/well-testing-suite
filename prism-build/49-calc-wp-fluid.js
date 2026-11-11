// =============================================================================
// WTS — 49-calc-wp-fluid.js  (Round 9; helper module: no page in window.WTS_calcRegistry)
// -----------------------------------------------------------------------------
// Well Performance fluid engine (black oil through the flowline props path, wet gas, recombination) — docs/WELL-PERFORMANCE-PLAN.md §3.2, §4.1.
// WP0 STUB (contract only): every function below returns {ok:false, code:'STUB', name, wp, errors[]} until WP1 replaces it.
// The work package that implements a function removes its name from window.__WP_STUBS (tests/wellperf-shapes.test.js lists them).
// Interfaces (field units, §3.0; every result {ok, errors[], warnings[{code, msg, sev}], …}; nothing throws for user data):
//   WTS_wp_fluid
//     .build(fluidSpec)
//         → F = {ok, type, pvt /*object for WTS_flowline_props fluid.pvt*/, at(p psia, T °F) → props, pb(T), table(pList, T), validity[], warnings}
//     .table(F, pList, T)
//         → {ok, rows:[{p, rs, bo, muo, z, bg, mug, rhoO, rhoG, rhoW, ...}], warnings}
//     .check(fluidSpec)
//         → {errors[], warnings[], validity:[{corr, inRange, msg}]}  (Appendix A ranges)
//     .recombine({sgSep, gorSep, apiST, cgr})
//         → {ok, sgWell, gorTotal}  (Standing well-stream gravity, D14)
//     .flowlineFluid(F, q /*{qo, qw, qg_Mscfd} or a liquid / gas rate per the fluid type*/)
//         → {qo STB/d, qw BWPD, qg MMscf/d, api, sgg, sgw, pvt}
// =============================================================================
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var STUBS = G.__WP_STUBS = G.__WP_STUBS || [];
    function _mark(name) { if (STUBS.indexOf(name) === -1) STUBS.push(name); }
    function _stub(name, wp) { return { ok: false, code: 'STUB', name: name, wp: wp, errors: [name + ' is not built yet (' + wp + ')'], warnings: [] }; }
    var wp_fluid = G.WTS_wp_fluid = G.WTS_wp_fluid || {};
    if (!wp_fluid.build) { wp_fluid.build = function () { return _stub('WTS_wp_fluid.build', 'WP1'); }; _mark('WTS_wp_fluid.build'); }
    if (!wp_fluid.table) { wp_fluid.table = function () { return _stub('WTS_wp_fluid.table', 'WP1'); }; _mark('WTS_wp_fluid.table'); }
    if (!wp_fluid.check) { wp_fluid.check = function () { return _stub('WTS_wp_fluid.check', 'WP1'); }; _mark('WTS_wp_fluid.check'); }
    if (!wp_fluid.recombine) { wp_fluid.recombine = function () { return _stub('WTS_wp_fluid.recombine', 'WP1'); }; _mark('WTS_wp_fluid.recombine'); }
    if (!wp_fluid.flowlineFluid) { wp_fluid.flowlineFluid = function () { return _stub('WTS_wp_fluid.flowlineFluid', 'WP1'); }; _mark('WTS_wp_fluid.flowlineFluid'); }
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var names = ["WTS_wp_fluid.build","WTS_wp_fluid.table","WTS_wp_fluid.check","WTS_wp_fluid.recombine","WTS_wp_fluid.flowlineFluid"], bad = [];
    names.forEach(function (n) {
        var p = n.split('.'), f = p.length > 1 ? (G[p[0]] || {})[p[1]] : G[p[0]];
        if (typeof f !== 'function') bad.push(n + ' missing');
    });
    if (bad.length && typeof console !== 'undefined') console.error('[49-calc-wp-fluid.js self-test] ' + bad.join('; '));
})();
