// =============================================================================
// WTS — 49-calc-dfit-triage.js  (Round 9)
// -----------------------------------------------------------------------------
// helper module: does not add a page to window.WTS_calcRegistry
//
// DFIT triage and data-health gate: window.PRiSM_dfit_triage, PRiSM_dfit_blunders, PRiSM_dfit_repump, PRiSM_dfit_grade
// (docs/DFIT-PLAN.md §3.5a, §6.3; owner WPT). Pure: no DOM, storage, timers or events. Resolved at call time by the
// Round-8 DFIT pipeline (fallback "triage unavailable").
//
// WP0 SKELETON. Every function is a stub returning {ok:false, code:'NOT_IMPLEMENTED', errors:[…], bad:[]}.
// Shape: prism-build/tests/_dfit-shapes.js (Triage).
// =============================================================================

(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;

    function _ni(name) {
        return { ok: false, code: 'NOT_IMPLEMENTED', errors: [name + ' is not implemented yet (DFIT WP0 skeleton).'], bad: [] };
    }
    function _stub(name) { var f = function () { return _ni(name); }; f._dfitStub = true; return f; }

    ['PRiSM_dfit_triage', 'PRiSM_dfit_blunders', 'PRiSM_dfit_repump', 'PRiSM_dfit_grade'].forEach(function (n) { G[n] = _stub(n); });
})();

// === SELF-TEST ===
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var r = G.PRiSM_dfit_triage && G.PRiSM_dfit_triage();
    if ((!r || r.code !== 'NOT_IMPLEMENTED') && typeof console !== 'undefined') console.warn('[49-calc-dfit-triage self-test] stubs');
})();
