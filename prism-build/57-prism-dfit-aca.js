// =============================================================================
// PRiSM — 57-prism-dfit-aca.js  (Round 8)
// -----------------------------------------------------------------------------
// DFIT after-closure analysis, the pure pipeline and the results layer (docs/DFIT-PLAN.md §3.3a, §3.6; owner WP3).
// Pure engine: no DOM, no storage, no timers, no events.
//
// WP0 SKELETON. Every §3.3a / §3.6 function is a stub returning {ok:false, code:'NOT_IMPLEMENTED', errors:[…], bad:[]};
// Job twins return a Job whose result() is that object. PRiSM_dfit_kConstraint returns null (its "no DFIT k" value, read
// by the 35 fallback). PRiSM_dfit_live is the namespace object {create}. Shapes: prism-build/tests/_dfit-shapes.js.
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

    ['PRiSM_dfit_pipeline', 'PRiSM_dfit_summarise', 'PRiSM_dfit_timeFns', 'PRiSM_dfit_centroid', 'PRiSM_dfit_acaDiag',
     'PRiSM_dfit_nolte', 'PRiSM_dfit_impulseLines', 'PRiSM_dfit_acaBounds', 'PRiSM_dfit_piConsensus', 'PRiSM_dfit_gasAdjust',
     'PRiSM_dfit_crTransform', 'PRiSM_dfit_acaMatch', 'PRiSM_dfit_aca', 'PRiSM_dfit_leakPlot', 'PRiSM_dfit_uncertainty',
     'PRiSM_dfit_replay', 'PRiSM_dfit_evidence', 'PRiSM_dfit_reportModel', 'PRiSM_dfit_checkQuoted', 'PRiSM_dfit_exportText',
     'PRiSM_dfit_fracSheet', 'PRiSM_dfit_handoff'].forEach(function (n) { G[n] = _stub(n); });
    ['PRiSM_dfit_pipelineJob', 'PRiSM_dfit_acaMatchJob', 'PRiSM_dfit_uncertaintyJob', 'PRiSM_dfit_replayJob']
        .forEach(function (n) { G[n] = _jobStub(n); });

    G.PRiSM_dfit_live = G.PRiSM_dfit_live || {};
    G.PRiSM_dfit_live.create = _stub('PRiSM_dfit_live.create');

    // {k, kLo, kHi, source} or null when no DFIT after-closure k exists (always null in the skeleton)
    G.PRiSM_dfit_kConstraint = function () { return null; };
    G.PRiSM_dfit_kConstraint._dfitStub = true;
})();

// === SELF-TEST ===
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis, bad = [];
    var j = G.PRiSM_dfit_pipelineJob && G.PRiSM_dfit_pipelineJob();
    if (!j || !j.step().done || j.result().code !== 'NOT_IMPLEMENTED') bad.push('pipelineJob stub');
    if (G.PRiSM_dfit_kConstraint() !== null) bad.push('kConstraint');
    if (bad.length && typeof console !== 'undefined') console.warn('[57-prism-dfit-aca self-test] ' + bad.join('; '));
})();
