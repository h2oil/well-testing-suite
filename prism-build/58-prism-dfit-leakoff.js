// =============================================================================
// PRiSM — 58-prism-dfit-leakoff.js  (Round 8)
// -----------------------------------------------------------------------------
// DFIT leak-off mini-model, history match, identifiability, designer and leak budget (docs/DFIT-PLAN.md §3.7, §5;
// owner WP4). Pure engine: no DOM, no storage, no timers, no events.
//
// WP0 SKELETON. Every §3.7 function is a stub returning {ok:false, code:'NOT_IMPLEMENTED', errors:[…], bad:[]};
// Job twins return a Job whose result() is that object. Shapes: prism-build/tests/_dfit-shapes.js.
// =============================================================================

(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;

    function _ni(name) {
        return { ok: false, code: 'NOT_IMPLEMENTED', errors: [name + ' is not implemented yet (DFIT WP0 skeleton).'], bad: [] };
    }
    function _stub(name) { var f = function () { return _ni(name); }; f._dfitStub = true; return f; }
    function _jobStub(name) {
        var f = function () {
            var r = _ni(name);
            return {
                step: function () { return { done: true, progress: 1, label: 'not implemented' }; },
                result: function () { return r; },
                cancel: function () {}
            };
        };
        f._dfitStub = true;
        return f;
    }

    ['PRiSM_dfit_lkDefaults', 'PRiSM_dfit_lkToEngine', 'PRiSM_dfit_lkSimulate', 'PRiSM_dfit_lkSample', 'PRiSM_dfit_lkQuick',
     'PRiSM_dfit_lkSolveCL', 'PRiSM_dfit_lkGoalSeek', 'PRiSM_dfit_lkFit', 'PRiSM_dfit_lkFisher', 'PRiSM_dfit_lkGroups',
     'PRiSM_dfit_identify', 'PRiSM_dfit_lkVerify', 'PRiSM_dfit_design', 'PRiSM_dfit_leakBudget'].forEach(function (n) { G[n] = _stub(n); });
    ['PRiSM_dfit_lkFitJob', 'PRiSM_dfit_designJob'].forEach(function (n) { G[n] = _jobStub(n); });
})();

// === SELF-TEST ===
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var r = G.PRiSM_dfit_lkSimulate && G.PRiSM_dfit_lkSimulate();
    if ((!r || r.code !== 'NOT_IMPLEMENTED') && typeof console !== 'undefined') console.warn('[58-prism-dfit-leakoff self-test] lkSimulate stub');
})();
