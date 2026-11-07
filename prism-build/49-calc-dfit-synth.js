// =============================================================================
// WTS — 49-calc-dfit-synth.js  (Round 9)
// -----------------------------------------------------------------------------
// helper module: does not add a page to window.WTS_calcRegistry
//
// Synthetic DFIT generator and scorer: window.PRiSM_dfit_synth = {version, make, demo, cases, score}
// (docs/DFIT-PLAN.md §3.9, §8.1; owner WP5). Pure and seeded (PRiSM_rng only, never an unseeded generator); no DOM, storage,
// timers or events.
//
// WP0 SKELETON. make / demo / cases / score are stubs returning {ok:false, code:'NOT_IMPLEMENTED', errors:[…], bad:[]}.
// Shapes: prism-build/tests/_dfit-shapes.js (DfitDataset, CaseSpec).
// =============================================================================

(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;

    function _ni(name) {
        return { ok: false, code: 'NOT_IMPLEMENTED', errors: ['PRiSM_dfit_synth.' + name + ' is not implemented yet (DFIT WP0 skeleton).'], bad: [] };
    }
    function _stub(name) { var f = function () { return _ni(name); }; f._dfitStub = true; return f; }

    var S = G.PRiSM_dfit_synth = G.PRiSM_dfit_synth || {};   // merge, never replace
    S.version = 'g1';
    ['make', 'demo', 'cases', 'score'].forEach(function (n) { S[n] = _stub(n); });
})();

// === SELF-TEST ===
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var S = G.PRiSM_dfit_synth;
    if ((!S || S.version !== 'g1' || S.demo('reference').code !== 'NOT_IMPLEMENTED') && typeof console !== 'undefined') console.warn('[49-calc-dfit-synth self-test] stubs');
})();
