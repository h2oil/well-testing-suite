// =============================================================================
// WTS — 48-calc-wellbore.js  (Round 9)
// -----------------------------------------------------------------------------
// helper module: does not add a page to window.WTS_calcRegistry
//
// window.WTS_wellbore — shared surface ↔ bottomhole, step-test, ramp and water-hammer engine (docs/DFIT-PLAN.md §3.4,
// §4.2, §4.14–§4.17; owner WP1). Pure: no DOM, storage, timers or events. Resolved at call time by the Round-8 DFIT
// files (Round 9 loads after Round 8). 3.4b items go into 48-calc-wellbore-field.js and merge into this namespace.
//
// WP0 SKELETON. Every 3.4a §3.4 function is a stub returning {ok:false, code:'NOT_IMPLEMENTED', errors:[…], bad:[]}.
// Shapes: prism-build/tests/_dfit-shapes.js (StepDown, StepRate, Ramp, Hammer).
// =============================================================================

(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;

    function _ni(name) {
        return { ok: false, code: 'NOT_IMPLEMENTED', errors: ['WTS_wellbore.' + name + ' is not implemented yet (DFIT WP0 skeleton).'], bad: [] };
    }
    function _stub(name) { var f = function () { return _ni(name); }; f._dfitStub = true; return f; }

    var W = G.WTS_wellbore = G.WTS_wellbore || {};   // merge, never replace
    ['column', 'csys', 'tempProfile', 'hydrostatic', 'pipeFriction', 'perfFriction', 'nwbLoss', 'bleedOff', 'convert', 'vacuum',
     'stepDown', 'stepDownDesignCheck', 'stepRate', 'ramp', 'hammerQuick', 'align'].forEach(function (n) { W[n] = _stub(n); });
})();

// === SELF-TEST ===
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var r = G.WTS_wellbore && G.WTS_wellbore.stepDown && G.WTS_wellbore.stepDown([]);
    if ((!r || r.code !== 'NOT_IMPLEMENTED') && typeof console !== 'undefined') console.warn('[48-calc-wellbore self-test] stubs');
})();
