// =============================================================================
// PRiSM — 59-prism-dfit-ui.js  (Round 8)
// -----------------------------------------------------------------------------
// DFIT user interface: PRiSM_modeExt.dfit, step views, C7 panels, plots and picks, rail, ▶ Analyse, Tools entries,
// report sections, exports and hand-offs (docs/DFIT-PLAN.md §3.8, §7; owner WP6). The only DFIT file that touches the
// DOM, writes PRiSM.multiRate, writes C1, writes storage and fires events.
//
// WP0 SKELETON. Every §3.8 export is a stub returning {ok:false, code:'NOT_IMPLEMENTED', errors:[…], bad:[]}
// (PRiSM_dfit_analyse returns a Promise resolving to it). Nothing touches the DOM, the state or storage, and the
// skeleton deliberately does NOT register PRiSM_modeExt.dfit, panels, plots, line tools, report sections, undo extras or
// Tools entries: once the generic hooks (WPH) land, a registered stub mode would show in the header select. WP6 adds
// them. PRiSM_dfit_hooks is real (the read-only hook points for the 3.4b files; merged, never replaced).
// =============================================================================

(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;

    function _ni(name) {
        return { ok: false, code: 'NOT_IMPLEMENTED', errors: [name + ' is not implemented yet (DFIT WP0 skeleton).'], bad: [] };
    }
    function _stub(name) { var f = function () { return _ni(name); }; f._dfitStub = true; return f; }

    ['PRiSM_dfit_renderStep2', 'PRiSM_dfit_renderStep4',
     'PRiSM_renderDfitDesignerTool', 'PRiSM_renderDfitSandboxTool', 'PRiSM_renderDfitReplayTool', 'PRiSM_renderDfitHammerTool',
     'PRiSM_renderDfitNotesTool',
     'PRiSM_dfit_state', 'PRiSM_dfit_test', 'PRiSM_dfit_selectTest', 'PRiSM_dfit_addTest', 'PRiSM_dfit_setPick',
     'PRiSM_dfit_applyHandoff', 'PRiSM_dfit_results',
     'PRiSM_plot_dfitDual', 'PRiSM_plot_dfitStrip', 'PRiSM_plot_dfitStack'].forEach(function (n) { G[n] = _stub(n); });

    G.PRiSM_dfit_analyse = function () {
        var r = _ni('PRiSM_dfit_analyse');
        return (typeof Promise !== 'undefined') ? Promise.resolve(r) : r;
    };
    G.PRiSM_dfit_analyse._dfitStub = true;

    // read-only hook points for the 3.4b files (§3.8): merged, never replaced
    var H = G.PRiSM_dfit_hooks = G.PRiSM_dfit_hooks || {};
    if (!('liveVerdict' in H)) H.liveVerdict = null;
    if (!(H.railRows instanceof Array)) H.railRows = [];
    if (!(H.step2Cards instanceof Array)) H.step2Cards = [];
})();

// === SELF-TEST ===
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var r = G.PRiSM_dfit_results && G.PRiSM_dfit_results();
    if ((!r || r.code !== 'NOT_IMPLEMENTED' || !(G.PRiSM_dfit_hooks.railRows instanceof Array)) && typeof console !== 'undefined') {
        console.warn('[59-prism-dfit-ui self-test] stubs');
    }
})();
