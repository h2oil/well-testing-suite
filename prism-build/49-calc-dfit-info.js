// =============================================================================
// WTS — 49-calc-dfit-info.js  (Round 9)
// -----------------------------------------------------------------------------
// helper module: does not add a page to window.WTS_calcRegistry
//
// DFIT method notes: window.WTS_dfitInfo = {notes, open(key, opener)} (docs/DFIT-PLAN.md §3.9, §6.13; owner WP6) —
// neutral method notes (assumptions, failure modes, citations) and their modal <dialog id="wts_dfit_info" class="rp-skip"
// data-rp-nosnap>, the pattern of 49-calc-cheminj-info.js.
//
// WP0 SKELETON. notes is empty; open() is a stub returning {ok:false, code:'NOT_IMPLEMENTED', errors:[…], bad:[]} and
// touches no DOM.
// =============================================================================

(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;

    var I = G.WTS_dfitInfo = G.WTS_dfitInfo || {};   // merge, never replace
    if (!I.notes || typeof I.notes !== 'object') I.notes = {};
    I.open = function () {
        return { ok: false, code: 'NOT_IMPLEMENTED', errors: ['WTS_dfitInfo.open is not implemented yet (DFIT WP0 skeleton).'], bad: [] };
    };
    I.open._dfitStub = true;
})();

// === SELF-TEST ===
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    if ((!G.WTS_dfitInfo || G.WTS_dfitInfo.open().code !== 'NOT_IMPLEMENTED') && typeof console !== 'undefined') console.warn('[49-calc-dfit-info self-test] stub');
})();
