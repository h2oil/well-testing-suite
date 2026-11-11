// =============================================================================
// WTS — 49-calc-wellperf.js  (Round 9) — Well Performance (nodal analysis) page, route `wellperf`
// -----------------------------------------------------------------------------
// docs/WELL-PERFORMANCE-PLAN.md §2.6–§2.9, §3.10, §10. Member of the sidebar hub "Well Performance" (hub key `perf`, members
// wellperf, oilipr, gasdeliv, gaslift; host __NAV_HUBS / __NAV_ORDER / static hub row — WP0).
//
// WP0 STUB: the page shell only. WP9 builds the seven steps (① Fluid ② Reservoir ③ Well ④ Lift ⑤ System ⑥ Match ⑦ Report), the
// interactive schematic and plots, the KPI strip and the compact report block on top of this contract:
//   registry  WTS_calcRegistry.wellperf {key, title, navTitle, sub, group 'Production & Reservoir', icon, badge, bc, render,
//             hooks: {silent: true, after: → one calcWellPerf()}}
//   window.renderWellPerf(body), window.calcWellPerf() (the units layer wraps calc* in a canonical context)
//   WTS_state.wellperf = {v, ok, op, roots, qs, vlpMin, traverse, breakdown, shutIn, flags, loading, sens, match}  (recomputed)
//   events    document 'wts:wellperf-solved' {ok} after each calc; listens to 'wts:well-changed' / 'wts:project-loaded' (re-read
//             the model through WTS_wp_model.read(); no cache) and 'wts:unit-system-changed' (re-render results)
//   markup    #wp_root; #wp_res = the compact report block (always rendered); step strip, editors and step-only plots are .rp-skip
// =============================================================================
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var TITLE = 'Well Performance (Nodal Analysis)';
    var SUB = 'Inflow and outflow through the completion, tubing, choke and flowline to the separator: operating point, stability, choke sizing, shut-in and liquid loading';
    var calcs = 0;

    function _byId(id) { return (typeof document !== 'undefined' && document.getElementById) ? document.getElementById(id) : null; }
    function _emit(name, detail) {
        try {
            if (typeof document === 'undefined' || !document.dispatchEvent) return;
            var ev = (typeof CustomEvent === 'function') ? new CustomEvent(name, { detail: detail }) : null;
            if (!ev && document.createEvent) { ev = document.createEvent('CustomEvent'); ev.initCustomEvent(name, false, false, detail); }
            if (ev) document.dispatchEvent(ev);
        } catch (e) { /* smoke stub */ }
    }
    function _calc() {
        calcs++;
        var M = (G.WTS_wp_model && typeof G.WTS_wp_model.read === 'function') ? G.WTS_wp_model.read() : null;
        var S = G.WTS_state = (G.WTS_state && typeof G.WTS_state === 'object') ? G.WTS_state : {};
        S.wellperf = { v: 1, ok: false, code: 'STUB', op: null, roots: [], qs: null, vlpMin: null, traverse: null, breakdown: [], shutIn: null,
                       flags: [], loading: null, sens: null, match: null, model: M ? M.v : null, ts: Date.now() };
        var res = _byId('wp_res');
        if (res) res.setAttribute('data-done', '1');
        _emit('wts:wellperf-solved', { ok: false });
        return S.wellperf;
    }
    G.calcWellPerf = function () {
        var U = G.WTS_units;
        return (U && typeof U.runCanonical === 'function') ? U.runCanonical(_calc) : _calc();
    };
    // test hook: the number of calcs so far (the units layer wraps window.calcWellPerf, so it carries no own properties)
    G.WTS_wellperf_page = { calcs: function () { return calcs; } };

    function render(body) {
        body.innerHTML = '<div id="wp_root">' +
            '<div id="wp_res">' +
            '<div class="rbox"><div class="rbox-title">Well Performance</div>' +
            '<div class="rrow"><span class="rl">Status</span><span class="rv">In development (release 4.3)</span></div></div>' +
            '<div style="margin-top:10px;font-size:12px;color:var(--text2)"><b>Notes</b> The nodal analysis page is being built. ' +
            'Use the other pages of this hub meanwhile: Oil Well IPR, Gas Well Deliverability and Gas Lift Design.</div>' +
            '</div></div>';
        // With autosave on, the host restores the saved values silently right after this render and then calls hooks.after,
        // which runs the one calc (as 49-calc-cheminj.js); otherwise calc now.
        var AS = G.WTS_pageAutosave;
        var hostRestores = !!(AS && typeof AS.page === 'function' && AS.page() === 'wellperf' && typeof AS.enabled === 'function' && AS.enabled('wellperf') && body.id === 'pgBody');
        if (!hostRestores) G.calcWellPerf();
    }
    G.renderWellPerf = render;

    G.WTS_calcRegistry = G.WTS_calcRegistry || {};
    G.WTS_calcRegistry.wellperf = {
        key: 'wellperf',
        title: TITLE,
        navTitle: 'Nodal Analysis',
        sub: SUB,
        group: 'Production & Reservoir',
        icon: '&#8645;',
        badge: 'Production',
        bc: 'dc-b-green',
        desc: 'Nodal analysis of a well: inflow, vertical lift with deviation, choke and flowline to the separator; operating point and stability, choke sizing, shut-in pressure and liquid loading.',
        hooks: { silent: true, after: function () { G.calcWellPerf(); } },
        render: function (body) { return G.renderWellPerf(body); }
    };

    if (typeof document !== 'undefined' && document.addEventListener) {
        var again = function () { if (_byId('wp_root')) G.calcWellPerf(); };
        document.addEventListener('wts:well-changed', again);
        document.addEventListener('wts:project-loaded', again);
        document.addEventListener('wts:unit-system-changed', function () {
            var r = _byId('wp_res');
            if (r && r.getAttribute && r.getAttribute('data-done') === '1') G.calcWellPerf();
        });
    }
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var e = G.WTS_calcRegistry && G.WTS_calcRegistry.wellperf;
    if (!(e && e.key === 'wellperf' && typeof e.render === 'function' && e.hooks && e.hooks.silent === true) && typeof console !== 'undefined') console.error('[wellperf self-test] registry entry malformed');
})();
