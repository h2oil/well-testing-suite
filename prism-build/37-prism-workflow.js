// =============================================================================
// PRiSM — 37-prism-workflow.js  (WP13, Round 8)
// -----------------------------------------------------------------------------
// Content layer for the five-step workflow shell (contract C9). The shell
// itself (#prism_header, #prism_steps, #prism_workspace, #prism_rail and the
// step bar) is rendered by 01-foundation.js; this file fills it:
//
//   window.PRiSM_renderRail(railEl)     results rail (desktop column or
//                                       bottom sheet when railEl has the
//                                       class 'prism-rail--sheet')
//   window.PRiSM_railInfo()             the numbers the rail shows (tests,
//                                       report, quick summary)
//   window.PRiSM_analyse(opts)          one-click pipeline → Promise<result>
//   window.PRiSM_stepViews[2](hostEl)   step ② "Flow periods" view
//   window.PRiSM_renderFlowPeriods      (same function)
//   window.PRiSM_openTools(toolId?)     Tools drawer (every advanced panel)
//   window.PRiSM_closeTools()
//   window.PRiSM_listTools()            [{id,title,group,fn,available}]
//   window.PRiSM_undo() / PRiSM_redo()  state snapshots (cap 50)
//   window.PRiSM_canUndo() / PRiSM_canRedo() / PRiSM_recordSnapshot(reason)
//   window.PRiSM_getReportPins()        results pinned from the rail
//
// Cross-module calls are all typeof-guarded (CLAUDE.md convention 6). When a
// shared engine is missing the pipeline degrades: Δp comes from a local
// sign-aware builder, the fit from a local physical-unit Levenberg-Marquardt
// fit of the active (or homogeneous) model, and the interpretation headline
// from a short local rule set.
//
// Units: t in hours, p in psia, q in STB/d (oil) or Mscf/d (gas).
// Field-unit constants: 141.2, 70.6, 0.0002637, 0.8936, 948.
// =============================================================================

(function () {
    'use strict';

    var G = (typeof window !== 'undefined') ? window : globalThis;
    var D = G.document || null;

    // =========================================================================
    // SECTION 1 — SMALL HELPERS
    // =========================================================================

    var LN10 = Math.log(10);

    function $(id) { return D && D.getElementById ? D.getElementById(id) : null; }
    function isNum(v) { return typeof v === 'number' && isFinite(v); }
    function isArr(a) {
        return !!a && (Array.isArray(a) || (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(a)));
    }
    function toArr(a) { var o = []; for (var i = 0; i < a.length; i++) o.push(a[i]); return o; }
    function esc(s) {
        if (s == null) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function clone(v) {
        if (v == null) return v;
        try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; }
    }
    function pick(obj, keys) {
        if (!obj) return undefined;
        for (var i = 0; i < keys.length; i++) {
            var v = obj[keys[i]];
            if (v != null && v !== '') return v;
        }
        return undefined;
    }
    function pickNum(obj, keys) {
        if (!obj) return undefined;
        for (var i = 0; i < keys.length; i++) if (isNum(obj[keys[i]])) return obj[keys[i]];
        return undefined;
    }
    function now() {
        try { if (G.performance && typeof G.performance.now === 'function') return G.performance.now(); } catch (e) {}
        return Date.now();
    }
    function thousands(s) { return s.replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

    // Engineering display: 3 significant figures, thousands separators for
    // ≥ 1000, exponent for very large / very small values.
    function fmt(v, sig) {
        if (!isNum(v)) return '—';
        sig = sig || 3;
        var a = Math.abs(v);
        if (a === 0) return '0';
        if (a >= 1e7 || a < 1e-3) {
            return v.toExponential(sig - 1).replace(/\.?0+e/, 'e').replace('e+', 'e');
        }
        if (a >= 1000) return (v < 0 ? '-' : '') + thousands(String(Math.round(a)));
        if (v === Math.round(v)) return String(v);
        return v.toPrecision(sig);
    }
    function fmtFixed(v, d) { return isNum(v) ? v.toFixed(d) : '—'; }
    function fmtSigned(v, d) { return isNum(v) ? ((v > 0 ? '+' : '') + v.toFixed(d)) : '—'; }

    function st() {
        if (!G.PRiSM_state) {
            G.PRiSM_state = { model: 'homogeneous', params: {}, paramFreeze: {}, match: { timeShift: 0, pressShift: 0 } };
        }
        return G.PRiSM_state;
    }

    function dispatch(type, detail) {
        if (typeof G.dispatchEvent !== 'function') return;
        try {
            var ev;
            if (typeof G.CustomEvent === 'function') ev = new G.CustomEvent(type, { detail: detail || {} });
            else if (D && D.createEvent) { ev = D.createEvent('CustomEvent'); ev.initCustomEvent(type, false, false, detail || {}); }
            if (ev) G.dispatchEvent(ev);
        } catch (e) { /* a listener threw — never break the caller */ }
    }

    function modelName(key) {
        if (!key) return '—';
        var e = G.PRiSM_MODELS && G.PRiSM_MODELS[key];
        var n = e && (e.name || e.label || e.title);
        if (n) return String(n);
        var s = String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
        return s.charAt(0).toUpperCase() + s.slice(1);
    }

    function cssVar(name, fallback) {
        try {
            if (D && D.documentElement && typeof G.getComputedStyle === 'function') {
                var v = G.getComputedStyle(D.documentElement).getPropertyValue(name);
                if (v && String(v).trim()) return String(v).trim();
            }
        } catch (e) {}
        return fallback;
    }

    function yieldTick() {
        return new Promise(function (resolve) {
            if (typeof G.setTimeout === 'function') G.setTimeout(resolve, 0); else resolve();
        });
    }

    function saveState() {
        if (typeof G.PRiSM_saveState === 'function') { try { G.PRiSM_saveState(); } catch (e) {} }
    }

    function redraw() {
        if (typeof G.PRiSM_drawActivePlot === 'function') { try { G.PRiSM_drawActivePlot(); } catch (e) {} }
    }

    // =========================================================================
    // SECTION 2 — STYLES (scoped 'prism-' classes, host dark-theme variables)
    // =========================================================================

    var STYLE_ID = 'prism_wf_style';
    var CSS = [
        '.prism-wf, .prism-wf *, .prism-rail-body, .prism-rail-body *, .prism-drawer, .prism-drawer *, .prism-progress, .prism-progress * { box-sizing: border-box; }',
        '.prism-rail-body { display:flex; flex-direction:column; gap:10px; font-size:12.5px; color:var(--text); min-width:0; }',
        '.prism-rail-sec { background:var(--bg2); border:1px solid var(--border); border-radius:8px; padding:10px 12px; min-width:0; }',
        '.prism-rail-h { display:flex; align-items:center; justify-content:space-between; gap:6px; font-size:11px; font-weight:700; letter-spacing:.5px; text-transform:uppercase; color:var(--text2); margin-bottom:6px; }',
        '.prism-rail-kv { display:grid; grid-template-columns:minmax(0,auto) minmax(0,1fr); gap:3px 10px; align-items:baseline; }',
        '.prism-rail-k { color:var(--text2); white-space:nowrap; }',
        '.prism-rail-v { color:var(--text); font-weight:600; text-align:right; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }',
        '.prism-rail-v small { color:var(--text3); font-weight:400; }',
        '.prism-rail-line { color:var(--text2); line-height:1.45; overflow-wrap:anywhere; }',
        '.prism-rail-line b { color:var(--text); }',
        '.prism-rail-headline { color:var(--text); line-height:1.45; font-style:italic; }',
        '.prism-chip { display:inline-block; font-size:10px; font-weight:600; letter-spacing:.2px; text-transform:none; padding:1px 7px; border-radius:10px; border:1px solid var(--border); color:var(--text2); white-space:nowrap; }',
        '.prism-chip--regression { color:var(--green); border-color:var(--green); }',
        '.prism-chip--automatch { color:var(--blue); border-color:var(--blue); }',
        '.prism-chip--match { color:var(--accent); border-color:var(--accent); }',
        '.prism-chip--semilog { color:var(--yellow); border-color:var(--yellow); }',
        '.prism-chip--ok { color:var(--green); border-color:var(--green); }',
        '.prism-chip--warn { color:var(--yellow); border-color:var(--yellow); }',
        '.prism-chip--bad { color:var(--red); border-color:var(--red); }',
        '.prism-rail-warn { border-left:3px solid var(--yellow); background:var(--bg3, var(--bg2)); padding:7px 9px; border-radius:4px; color:var(--text); line-height:1.4; display:flex; flex-wrap:wrap; align-items:center; gap:6px 10px; }',
        '.prism-rail-warn--bad { border-left-color:var(--red); }',
        '.prism-rail-warn--info { border-left-color:var(--blue); }',
        '.prism-rail-warn span { flex:1 1 160px; min-width:0; }',
        '.prism-rail-actions { display:flex; flex-wrap:wrap; gap:8px; }',
        '.prism-btn { appearance:none; background:var(--bg3, var(--bg2)); border:1px solid var(--border); color:var(--text); border-radius:6px; padding:7px 11px; font:inherit; font-size:12px; line-height:1.2; cursor:pointer; min-height:34px; touch-action:manipulation; }',
        '.prism-btn:hover { border-color:var(--accent); }',
        '.prism-btn:disabled { opacity:.5; cursor:default; }',
        '.prism-btn--primary { background:var(--accent); border-color:var(--accent); color:#111; font-weight:700; }',
        '.prism-btn--small { min-height:28px; padding:4px 9px; font-size:11px; }',
        '.prism-btn--link { background:none; border:none; color:var(--blue); padding:0; min-height:0; text-decoration:underline; }',
        '.prism-rail-sheetbar { width:100%; display:flex; align-items:center; gap:8px; min-height:44px; padding:8px 12px; background:var(--bg2); border:1px solid var(--border); border-radius:10px 10px 0 0; color:var(--text); font:inherit; font-size:13px; font-weight:600; text-align:left; cursor:pointer; touch-action:manipulation; }',
        '.prism-rail-sheetbar .prism-rail-sum { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
        '.prism-rail-sheetbar .prism-rail-grip { width:36px; height:4px; border-radius:2px; background:var(--border); flex:0 0 auto; }',
        '.prism-rail--sheet .prism-rail-body { padding:10px 2px 4px; max-height:70vh; overflow-y:auto; -webkit-overflow-scrolling:touch; }',
        '.prism-wf { display:flex; flex-direction:column; gap:12px; min-width:0; }',
        '.prism-wf-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(min(100%, 300px), 1fr)); gap:12px; }',
        '.prism-wf-card { background:var(--bg2); border:1px solid var(--border); border-radius:8px; padding:12px; min-width:0; }',
        '.prism-wf-title { font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.5px; color:var(--text2); margin-bottom:8px; }',
        '.prism-wf-hint { font-size:11.5px; color:var(--text3); margin-top:6px; line-height:1.4; }',
        '.prism-wf canvas { display:block; width:100%; max-width:100%; touch-action:manipulation; background:var(--bg1); border-radius:6px; }',
        '.prism-fp-tablewrap { overflow-x:auto; max-width:100%; -webkit-overflow-scrolling:touch; }',
        '.prism-fp-table { width:100%; border-collapse:collapse; font-size:12px; }',
        '.prism-fp-table th, .prism-fp-table td { padding:6px 6px; border-bottom:1px solid var(--border); text-align:left; white-space:nowrap; }',
        '.prism-fp-table th { color:var(--text2); font-weight:600; font-size:11px; }',
        '.prism-fp-table tbody tr { cursor:pointer; }',
        '.prism-fp-table tbody tr.is-active { background:rgba(240,136,62,.14); }',
        '.prism-fp-table td.num { text-align:right; font-variant-numeric:tabular-nums; }',
        '.prism-fp-inputs { display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); gap:10px; }',
        '.prism-fp-inputs label { display:flex; flex-direction:column; gap:4px; font-size:11.5px; color:var(--text2); }',
        '.prism-fp-inputs input { width:100%; min-width:0; background:var(--bg1); border:1px solid var(--border); color:var(--text); border-radius:6px; padding:7px 8px; font:inherit; font-size:13px; }',
        '.prism-drawer-backdrop { position:fixed; top:0; right:0; bottom:0; left:0; background:rgba(0,0,0,.55); z-index:900; }',
        '.prism-drawer { position:fixed; top:0; right:0; bottom:0; width:min(600px, 100vw); max-width:100vw; background:var(--bg1); border-left:1px solid var(--border); z-index:901; display:flex; flex-direction:column; color:var(--text); }',
        '.prism-drawer-head { display:flex; align-items:center; gap:8px; padding:10px 12px; border-bottom:1px solid var(--border); }',
        '.prism-drawer-head h3 { margin:0; font-size:14px; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
        '.prism-drawer-body { flex:1; overflow:auto; padding:12px; -webkit-overflow-scrolling:touch; min-width:0; }',
        '.prism-drawer-search { width:100%; background:var(--bg2); border:1px solid var(--border); color:var(--text); border-radius:6px; padding:8px 10px; font:inherit; font-size:13px; margin-bottom:10px; }',
        '.prism-tool-group { font-size:11px; font-weight:700; letter-spacing:.5px; text-transform:uppercase; color:var(--text3); margin:12px 0 6px; }',
        '.prism-tool-item { display:block; width:100%; text-align:left; background:var(--bg2); border:1px solid var(--border); color:var(--text); border-radius:6px; padding:10px 12px; margin-bottom:6px; font:inherit; font-size:13px; cursor:pointer; min-height:44px; }',
        '.prism-tool-item:hover { border-color:var(--accent); }',
        '.prism-tool-item small { display:block; color:var(--text3); font-size:11px; margin-top:2px; }',
        '@media (max-width: 767px) { .prism-drawer { top:auto; left:0; width:100vw; height:88vh; border-left:0; border-top:1px solid var(--border); border-radius:12px 12px 0 0; } }',
        '.prism-progress { position:fixed; right:16px; bottom:16px; width:min(320px, calc(100vw - 32px)); background:var(--bg2); border:1px solid var(--border); border-radius:10px; padding:10px 12px; z-index:950; color:var(--text); font-size:12.5px; box-shadow:0 6px 24px rgba(0,0,0,.45); }',
        '.prism-progress.is-done { animation: prism-progress-out .3s ease 4s forwards; }',
        '@keyframes prism-progress-out { to { opacity:0; visibility:hidden; } }',
        '.prism-progress-head { display:flex; align-items:center; gap:8px; font-weight:700; margin-bottom:6px; }',
        '.prism-progress-head span { flex:1; }',
        '.prism-progress-row { display:flex; gap:8px; align-items:baseline; padding:2px 0; color:var(--text2); }',
        '.prism-progress-row b { width:16px; flex:0 0 16px; text-align:center; font-weight:700; }',
        '.prism-progress-row.is-run { color:var(--text); }',
        '.prism-progress-row.is-ok b { color:var(--green); }',
        '.prism-progress-row.is-warn b { color:var(--yellow); }',
        '.prism-progress-row.is-fail b { color:var(--red); }',
        '.prism-progress-row em { font-style:normal; color:var(--text3); margin-left:auto; text-align:right; overflow-wrap:anywhere; }',
        '.prism-progress-note { margin-top:6px; padding:6px 8px; border:1px dashed var(--border); border-radius:6px; color:var(--text2); overflow-wrap:anywhere; }',
        '.prism-toast { margin-top:6px; font-size:11.5px; color:var(--green); }'
    ].join('\n');

    function ensureStyle() {
        if (!D || !D.createElement) return;
        if ($(STYLE_ID)) return;
        try {
            var s = D.createElement('style');
            s.id = STYLE_ID;
            s.textContent = CSS;
            var parent = D.head || D.body || D.documentElement;
            if (parent) parent.appendChild(s);
        } catch (e) {}
    }

    // =========================================================================
    // SECTION 3 — CONTRACT ADAPTERS (C1 well, C2 analysis data, C4 lastFit)
    // =========================================================================

    var WELL_KEYS = ['q', 'B', 'mu', 'ct', 'h', 'phi', 'rw'];

    function isDefaultSample(ds) {
        if (!ds || !isArr(ds.t) || !isArr(ds.p)) return false;
        if (ds.source === 'sample' || ds._sample === true || ds.isSample === true) return true;
        return ds.t.length === 55 && Math.abs(ds.p[0] - 3861.4) < 1e-6 && Math.abs(ds.t[54] - 120) < 1e-6;
    }

    // Maps a getWell() key to the PRiSM_pvt field that stores it.
    function pvtKey(k, fluid) {
        fluid = fluid || 'oil';
        if (k === 'pi') return 'p_res';
        if (k === 'B') return fluid === 'gas' ? 'Bg' : (fluid === 'water' ? 'Bw' : 'Bo');
        if (k === 'mu') return fluid === 'gas' ? 'mu_g' : (fluid === 'water' ? 'mu_w' : 'mu_o');
        if (k === 'T_R') return 'T_res';
        if (k === 'sg') return 'SG_g';
        return k;
    }

    function datasetRate(ds) {
        if (!ds || !isArr(ds.q)) return null;
        for (var i = ds.q.length - 1; i >= 0; i--) {
            if (isNum(ds.q[i]) && ds.q[i] !== 0) return Math.abs(ds.q[i]);
        }
        return null;
    }

    // Local C1 fallback: reads PRiSM_pvt (+ the default-sample metadata when
    // the loaded data is the bundled demo).
    function localWell(ds) {
        var pvt = G.PRiSM_pvt || {};
        var prov = pvt.provenance || {};
        var fluid = pvt.fluidType || 'oil';
        var comp = pvt._computed || {};
        if (comp.B == null && comp.Bo == null && typeof G.PRiSM_pvt_compute === 'function' && G.PRiSM_pvt) {
            try { comp = G.PRiSM_pvt_compute() || pvt._computed || {}; } catch (e) { comp = {}; }
        }
        var w = {
            fluid: fluid,
            q: pvt.q, B: undefined, mu: undefined, ct: pvt.ct, h: pvt.h, phi: pvt.phi, rw: pvt.rw,
            pi: null, T_R: pvt.T_res, sg: pvt.SG_g,
            testType: pvt.testType || 'auto', tp: pvt.tp, tShut: pvt.tShut, pwf0: pvt.pwf0,
            provenance: {}, complete: false, missing: [], defaulted: [], _local: true
        };
        var Bk = pvtKey('B', fluid), Mk = pvtKey('mu', fluid);
        w.B = isNum(pvt[Bk]) ? pvt[Bk] : pickNum(comp, fluid === 'gas' ? ['Bg', 'B'] : ['Bo', 'B']);
        w.mu = isNum(pvt[Mk]) ? pvt[Mk] : pickNum(comp, fluid === 'gas' ? ['mu_g', 'mu'] : ['mu_o', 'mu']);
        if (!isNum(w.ct)) w.ct = pickNum(comp, ['ct']);
        var provOf = function (k) { return prov[pvtKey(k, fluid)] || prov[k] || 'default'; };
        ['q', 'B', 'mu', 'ct', 'h', 'phi', 'rw', 'pi'].forEach(function (k) { w.provenance[k] = provOf(k); });
        var pp = provOf('pi');
        if (isNum(pvt.p_res) && (pp === 'user' || pp === 'sample' || pp === 'deconvolution')) w.pi = pvt.p_res;
        var meta = G.PRiSM_DEFAULT_SAMPLE_META;
        if (meta && isDefaultSample(ds)) {
            var mv = {
                q: meta.q, B: pick(meta, ['Bo', 'B']), mu: pick(meta, ['mu_o', 'mu']), ct: meta.ct,
                h: meta.h, phi: meta.phi, rw: meta.rw, pi: meta.pi
            };
            Object.keys(mv).forEach(function (k) {
                if (isNum(mv[k]) && w.provenance[k] !== 'user') { w[k] = mv[k]; w.provenance[k] = 'sample'; }
            });
            if (meta.testType && w.testType === 'auto') w.testType = meta.testType;
        }
        var qd = datasetRate(ds);
        if (qd != null && w.provenance.q !== 'user') { w.q = qd; w.provenance.q = 'dataset'; }
        WELL_KEYS.forEach(function (k) {
            if (!(isNum(w[k]) && w[k] > 0)) w.missing.push(k);
            else if (w.provenance[k] === 'default') w.defaulted.push(k);
        });
        w.complete = w.missing.length === 0;
        return w;
    }

    function getWell(ds) {
        ds = ds || G.PRiSM_dataset;
        if (typeof G.PRiSM_getWell === 'function') {
            try { var w = G.PRiSM_getWell(ds); if (w) return w; } catch (e) { /* fall through */ }
        }
        return localWell(ds);
    }

    // Writes well inputs: C1 setter when present, else PRiSM_pvt directly.
    function setWell(patch, source) {
        if (typeof G.PRiSM_setWell === 'function') {
            try { G.PRiSM_setWell(patch, { source: source || 'user' }); return true; } catch (e) { /* fall through */ }
        }
        var pvt = G.PRiSM_pvt;
        if (!pvt) pvt = G.PRiSM_pvt = {};
        pvt.provenance = pvt.provenance || {};
        Object.keys(patch).forEach(function (k) {
            pvt[k] = patch[k];
            pvt.provenance[k] = source || 'user';
        });
        if (typeof G.PRiSM_pvt_compute === 'function') { try { G.PRiSM_pvt_compute(); } catch (e) {} }
        persistPvt();
        dispatch('prism:well-changed', { source: source || 'user', keys: Object.keys(patch) });
        return true;
    }

    function persistPvt() {
        try {
            var s = G.PRiSM_pvt;
            if (!s || !G.localStorage) return;
            var o = {};
            for (var k in s) if (k !== '_computed' && Object.prototype.hasOwnProperty.call(s, k)) o[k] = s[k];
            G.localStorage.setItem('wts_prism_pvt', JSON.stringify(o));
        } catch (e) {}
    }

    // ── Flow periods ─────────────────────────────────────────────────────────
    function periodType(q, prevQ) {
        if (q == null || !isNum(q)) return 'Pressure only';
        if (q === 0) return (isNum(prevQ) && prevQ < 0) ? 'Falloff' : (isNum(prevQ) && prevQ > 0 ? 'Buildup' : 'Shut-in');
        if (q < 0) return 'Injection';
        return (isNum(prevQ) && prevQ > 0) ? 'Flow (rate change)' : 'Drawdown';
    }

    function normPeriod(p, i, arr) {
        var t0 = isNum(p.t0) ? p.t0 : p.start;
        var t1 = isNum(p.t1) ? p.t1 : p.end;
        var prevQ = i > 0 ? arr[i - 1].q : undefined;
        return {
            index: i, t0: t0, t1: t1, start: t0, end: t1, q: p.q,
            // Display label from the rates; the core's machine type ('flow', 'shutin') is kept as kind.
            type: periodType(p.q, prevQ), kind: p.type ? String(p.type) : null, n: p.n
        };
    }

    function localPeriods(ds) {
        if (!ds || !isArr(ds.t) || !ds.t.length) return [];
        var t = ds.t, n = t.length, q = isArr(ds.q) ? ds.q : null;
        if (!q) return [{ index: 0, t0: Math.min(0, t[0]), t1: t[n - 1], start: Math.min(0, t[0]), end: t[n - 1], q: null, type: 'Pressure only', n: n }];
        var segs = [], cur = null;
        for (var i = 0; i < n; i++) {
            var qi = isNum(q[i]) ? q[i] : 0;
            var same = cur && ((cur.q === 0 && qi === 0) ||
                (cur.q !== 0 && Math.abs(qi - cur.q) <= 0.01 * Math.abs(cur.q)));
            if (!cur || !same) {
                if (cur) segs.push(cur);
                cur = { i0: i, i1: i, q: qi };
            } else cur.i1 = i;
        }
        if (cur) segs.push(cur);
        if (segs.length > 20) {   // continuously varying rate: one period (RTA/deconvolution territory)
            return [{ index: 0, t0: Math.min(0, t[0]), t1: t[n - 1], start: Math.min(0, t[0]), end: t[n - 1], q: datasetRate(ds), type: 'Variable rate', n: n, variable: true }];
        }
        return segs.map(function (s, k) {
            var t0 = k === 0 ? Math.min(0, t[s.i0]) : t[segs[k - 1].i1];
            var prevQ = k > 0 ? segs[k - 1].q : undefined;
            return { index: k, t0: t0, t1: t[s.i1], start: t0, end: t[s.i1], q: s.q, type: periodType(s.q, prevQ), n: s.i1 - s.i0 + 1 };
        });
    }

    function getPeriods(ds) {
        ds = ds || G.PRiSM_dataset;
        if (!ds) return [];
        // The PTA core's period list is the one whose indices drive
        // PRiSM_getAnalysisData({period}) / st.activePeriod — prefer it (WP0 fix).
        if (typeof G.PRiSM_rateHistory === 'function') {
            try {
                var rh = G.PRiSM_rateHistory(ds);
                if (rh && rh.ok && !rh.variable && rh.periods && rh.periods.length) return toArr(rh.periods).map(normPeriod);
            } catch (e0) {}
        }
        if (typeof G.PRiSM_detectPeriods === 'function' && isArr(ds.t) && isArr(ds.q)) {
            try {
                var p = G.PRiSM_detectPeriods(ds.t, ds.q);
                if (p && p.length) return toArr(p).map(normPeriod);
            } catch (e) {}
        }
        return localPeriods(ds);
    }

    function activePeriod() {
        var ap = st().activePeriod;
        return (ap === 0 || (isNum(ap) && ap >= 0)) ? ap : null;
    }

    function periodOpts() {
        var ap = activePeriod();
        return ap == null ? {} : { period: ap };
    }

    // ── Bourdet derivative (local fallback; the shared one is preferred) ──
    function bourdet(t, dp, L) {
        var sharedFn = (typeof G.PRiSM_compute_bourdet === 'function') ? G.PRiSM_compute_bourdet : null;
        if (sharedFn) {
            try { var r = sharedFn(t, dp, L); if (r && r.length === t.length) return toArr(r); } catch (e) {}
        }
        var n = t.length, x = t.map(function (v) { return Math.log(v); }), d = new Array(n);
        for (var i = 0; i < n; i++) {
            var j = i - 1, k = i + 1;
            while (j > 0 && x[i] - x[j] < L) j--;
            while (k < n - 1 && x[k] - x[i] < L) k++;
            if (j >= 0 && k < n && x[i] > x[j] && x[k] > x[i]) {
                var dl = x[i] - x[j], dr = x[k] - x[i];
                d[i] = ((dp[i] - dp[j]) / dl * dr + (dp[k] - dp[i]) / dr * dl) / (dl + dr);
            } else if (k < n && x[k] > x[i]) d[i] = (dp[k] - dp[i]) / (x[k] - x[i]);
            else if (j >= 0 && x[i] > x[j]) d[i] = (dp[i] - dp[j]) / (x[i] - x[j]);
            else d[i] = NaN;
        }
        return d;
    }

    // Local C2 fallback: sign-aware Δp from pi / pwf0 / t0 row / first sample.
    function localAnalysisData(ds, opts) {
        opts = opts || {};
        if (!ds || !isArr(ds.t) || !isArr(ds.p) || ds.t.length < 3) {
            return { ok: false, reason: 'No pressure data loaded — load data on step ① first.' };
        }
        var well = getWell(ds);
        var periods = localPeriods(ds);
        var pidx = (opts.period != null && periods[opts.period]) ? opts.period : null;
        var per = pidx != null ? periods[pidx] : null;
        var prev = (pidx != null && pidx > 0) ? periods[pidx - 1] : null;
        var tStart = per ? per.t0 : 0, tEnd = per ? per.t1 : Infinity;
        if (!per && periods.length > 1) {
            // Whole record with several periods: analyse from the first sample.
            tStart = Math.min(0, ds.t[0]);
        }
        var rows = [];
        for (var i = 0; i < ds.t.length; i++) {
            if (ds.t[i] > tStart && ds.t[i] <= tEnd && isNum(ds.p[i])) rows.push(i);
        }
        if (rows.length < 3) return { ok: false, reason: 'Fewer than 3 samples in the selected period.' };
        var warnings = [];
        var testType = (well.testType && well.testType !== 'auto') ? well.testType : null;
        if (!testType) {
            if (per && per.q === 0 && prev && prev.q > 0) testType = 'buildup';
            else if (per && per.q === 0 && prev && prev.q < 0) testType = 'falloff';
            else if (per && isNum(per.q) && per.q < 0) testType = 'injection';
            else testType = (ds.p[rows[rows.length - 1]] - ds.p[rows[0]]) >= 0 ? 'buildup' : 'drawdown';
        }
        var sign = (testType === 'buildup' || testType === 'injection') ? 1 : -1;
        var pRef = null, pRefSource = null, t0row = -1;
        for (var r0 = 0; r0 < ds.t.length; r0++) if (ds.t[r0] <= tStart && isNum(ds.p[r0])) t0row = r0;
        if (testType === 'drawdown' || testType === 'injection') {
            if (isNum(well.pi)) { pRef = well.pi; pRefSource = 'pi'; }
        } else if (isNum(well.pwf0)) { pRef = well.pwf0; pRefSource = 'pwf0'; }
        if (pRef == null && t0row >= 0) { pRef = ds.p[t0row]; pRefSource = 't0-row'; }
        if (pRef == null) {
            pRef = ds.p[rows[0]]; pRefSource = 'first-sample';
            warnings.push('Δp is measured from the first sample, so skin is biased — enter the initial pressure pi on step ①.');
        }
        var t = [], tAbs = [], p = [], dp = [];
        rows.forEach(function (ri) {
            var dt = ds.t[ri] - tStart, d = sign * (ds.p[ri] - pRef);
            if (dt > 0 && d > 0) { t.push(dt); tAbs.push(ds.t[ri]); p.push(ds.p[ri]); dp.push(d); }
        });
        if (t.length < 3) return { ok: false, reason: 'No positive Δp — check the test type and pi on step ①.' };
        var qRef = per && isNum(per.q) && per.q !== 0 ? Math.abs(per.q) : (prev && isNum(prev.q) ? Math.abs(prev.q) : (isNum(well.q) ? well.q : null));
        var tp = null;
        if (testType === 'buildup' || testType === 'falloff') {
            var Np = 0;
            for (var k = 0; k < (pidx || 0); k++) if (isNum(periods[k].q)) Np += periods[k].q * (periods[k].t1 - periods[k].t0);
            tp = (prev && prev.q) ? Np / prev.q : null;
            if (isNum(well.tp)) tp = well.tp;
            warnings.push('Δt time function without superposition (shared analysis-data builder not loaded).');
        }
        return {
            ok: true, reason: '', n: t.length, t: t, tAbs: tAbs, p: p, dp: dp, x: t.slice(),
            deriv: bourdet(t, dp, 0.1), L: 0.1, timeFn: 'dt', sign: sign,
            pRef: pRef, pRefSource: pRefSource, testType: testType, tStart: tStart,
            tShut: (testType === 'buildup' || testType === 'falloff') ? tStart : null, tp: tp,
            qRef: qRef, rateHistory: periods.map(function (pp) { return { t: pp.t0, q: pp.q }; }),
            periods: periods, fluid: well.fluid, warnings: warnings, _local: true
        };
    }

    function getAnalysisData(opts) {
        opts = opts || periodOpts();
        if (typeof G.PRiSM_getAnalysisData === 'function') {
            try {
                var a = G.PRiSM_getAnalysisData(G.PRiSM_dataset, opts);
                if (a) return a;
            } catch (e) { return { ok: false, reason: 'Analysis data: ' + (e && e.message) }; }
        }
        return localAnalysisData(G.PRiSM_dataset, opts);
    }

    function normaliseFit(lf) {
        if (!lf) return null;
        var o = {};
        for (var k in lf) if (Object.prototype.hasOwnProperty.call(lf, k)) o[k] = lf[k];
        if (o.r2 == null && o.R2 != null) o.r2 = o.R2;
        if (o.rmse == null && o.RMSE != null) o.rmse = o.RMSE;
        if (o.aic == null && o.AIC != null) o.aic = o.AIC;
        if (o.ci95 == null && o.CI95 != null) o.ci95 = o.CI95;
        if (o.modelKey == null && o.model != null) o.modelKey = o.model;
        return o;
    }

    function getLastFit() {
        if (typeof G.PRiSM_getLastFit === 'function') {
            try { var f = G.PRiSM_getLastFit(); return f ? normaliseFit(f) : null; } catch (e) {}
        }
        var s = st(), lf = normaliseFit(s.lastFit);
        if (lf && lf.stale == null) lf.stale = !!(lf.modelKey && s.model && lf.modelKey !== s.model);
        return lf;
    }

    // =========================================================================
    // SECTION 4 — LOCAL PHYSICAL-UNIT FIT (fallback when the shared regression
    // engine is not loaded). Levenberg-Marquardt on ln Δp.
    // =========================================================================

    function solveLinear(A, b) {
        var n = b.length, M = A.map(function (row, i) { return row.slice().concat([b[i]]); });
        for (var c = 0; c < n; c++) {
            var piv = c;
            for (var r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
            if (Math.abs(M[piv][c]) < 1e-300) return null;
            var tmp = M[c]; M[c] = M[piv]; M[piv] = tmp;
            for (var r2 = c + 1; r2 < n; r2++) {
                var f = M[r2][c] / M[c][c];
                for (var cc = c; cc <= n; cc++) M[r2][cc] -= f * M[c][cc];
            }
        }
        var x = new Array(n);
        for (var i = n - 1; i >= 0; i--) {
            var s = M[i][n];
            for (var j = i + 1; j < n; j++) s -= M[i][j] * x[j];
            x[i] = s / M[i][i];
        }
        return x;
    }

    function invert(A) {
        var n = A.length, out = [];
        for (var i = 0; i < n; i++) out.push(new Array(n));
        for (var c = 0; c < n; c++) {
            var e = []; for (var r = 0; r < n; r++) e.push(r === c ? 1 : 0);
            var col = solveLinear(A, e);
            if (!col) return null;
            for (var r3 = 0; r3 < n; r3++) out[r3][c] = col[r3];
        }
        return out;
    }

    // resFn(x) → residual array. lo/hi: per-parameter bounds.
    function lm(resFn, x0, lo, hi, maxIter) {
        var np = x0.length, x = x0.slice();
        function clamp(v) { for (var i = 0; i < np; i++) v[i] = Math.min(hi[i], Math.max(lo[i], v[i])); return v; }
        function ssrOf(r) { var s = 0; for (var i = 0; i < r.length; i++) s += r[i] * r[i]; return s; }
        clamp(x);
        var r = resFn(x), ssr = ssrOf(r), lambda = 1e-3, iter = 0, converged = false, J = null;
        function jac(xc, rc) {
            var Jm = [];
            for (var i = 0; i < rc.length; i++) Jm.push(new Array(np));
            for (var j = 0; j < np; j++) {
                var h = 1e-6 * Math.max(1, Math.abs(xc[j]));
                var xp = xc.slice(); xp[j] += h;
                if (xp[j] > hi[j]) { xp[j] = xc[j] - h; h = -h; }
                var rp = resFn(xp);
                for (var i2 = 0; i2 < rc.length; i2++) Jm[i2][j] = (rp[i2] - rc[i2]) / h;
            }
            return Jm;
        }
        while (iter < (maxIter || 60)) {
            iter++;
            J = jac(x, r);
            var A = [], g = [];
            for (var a = 0; a < np; a++) {
                A.push(new Array(np)); g.push(0);
                for (var b = 0; b < np; b++) {
                    var s = 0;
                    for (var i = 0; i < r.length; i++) s += J[i][a] * J[i][b];
                    A[a][b] = s;
                }
                for (var i3 = 0; i3 < r.length; i3++) g[a] += J[i3][a] * r[i3];
            }
            var accepted = false, xn = null, rn = null, ssrn = ssr;
            for (var tries = 0; tries < 12; tries++) {
                var M = A.map(function (row, ia) {
                    return row.map(function (v, ib) { return ia === ib ? v + lambda * Math.max(v, 1e-12) : v; });
                });
                var step = solveLinear(M, g.map(function (v) { return -v; }));
                if (!step) { lambda *= 10; continue; }
                xn = clamp(x.map(function (v, k) { return v + step[k]; }));
                rn = resFn(xn); ssrn = ssrOf(rn);
                if (isFinite(ssrn) && ssrn < ssr) { accepted = true; break; }
                lambda *= 10;
            }
            if (!accepted) { converged = true; break; }   // no downhill step left: at the minimum
            var rel = (ssr - ssrn) / Math.max(ssr, 1e-300);
            var dxMax = 0;
            for (var q = 0; q < np; q++) dxMax = Math.max(dxMax, Math.abs(xn[q] - x[q]));
            x = xn; r = rn; ssr = ssrn;
            lambda = Math.max(lambda / 10, 1e-12);
            if (rel < 1e-10 || dxMax < 1e-9) { converged = true; break; }
        }
        J = jac(x, r);
        var JtJ = [];
        for (var a2 = 0; a2 < np; a2++) {
            JtJ.push(new Array(np));
            for (var b2 = 0; b2 < np; b2++) {
                var s2 = 0;
                for (var i4 = 0; i4 < r.length; i4++) s2 += J[i4][a2] * J[i4][b2];
                JtJ[a2][b2] = s2;
            }
        }
        var inv = invert(JtJ), dof = Math.max(1, r.length - np), sigma2 = ssr / dof, se = [];
        for (var k2 = 0; k2 < np; k2++) se.push(inv && inv[k2][k2] > 0 ? Math.sqrt(inv[k2][k2] * sigma2) : NaN);
        return { x: x, r: r, ssr: ssr, iterations: iter, converged: converged, se: se };
    }

    function median(a) {
        var b = a.filter(isNum).sort(function (x, y) { return x - y; });
        if (!b.length) return NaN;
        var m = Math.floor(b.length / 2);
        return b.length % 2 ? b[m] : 0.5 * (b[m - 1] + b[m]);
    }

    // Seeds k, C, S from the data (C3 seed formulas).
    function seedPhys(ad, w) {
        var n = ad.t.length, qBmu = ad.qRef * w.B * w.mu;
        var late = [];
        for (var i = Math.floor(0.7 * n); i < n; i++) if (ad.deriv[i] > 0) late.push(ad.deriv[i]);
        var dpr = median(late);
        var k = isNum(dpr) && dpr > 0 ? 70.6 * qBmu / (dpr * w.h) : 10;
        var C = ad.qRef * w.B * ad.t[0] / (24 * ad.dp[0]);
        var tr = ad.t[n - 1], dpR = ad.dp[n - 1];
        var S = isNum(dpr) && dpr > 0
            ? 0.5 * (dpR / dpr - Math.log(0.0002637 * k * tr / (w.phi * w.mu * w.ct * w.rw * w.rw)) - 0.80907) : 0;
        if (!isNum(k) || k <= 0) k = 10;
        if (!isNum(C) || C <= 0) C = 1e-3;
        if (!isNum(S)) S = 0;
        return { k: k, C: C, S: Math.max(-4, Math.min(40, S)) };
    }

    function r2Linear(obs, mod) {
        var n = obs.length, mean = 0, ssT = 0, ssR = 0;
        for (var i = 0; i < n; i++) mean += obs[i];
        mean /= n;
        for (var j = 0; j < n; j++) { ssT += (obs[j] - mean) * (obs[j] - mean); ssR += (obs[j] - mod[j]) * (obs[j] - mod[j]); }
        return { r2: ssT > 0 ? 1 - ssR / ssT : NaN, rmse: Math.sqrt(ssR / n) };
    }

    // Returns a C4-shaped fit object (not stored) or {error}.
    function localFit(ad, w, modelKey) {
        var reg = G.PRiSM_MODELS || {};
        var key = modelKey;
        var entry = reg[key];
        if (!entry || typeof entry.pd !== 'function' || !entry.defaults ||
            !('Cd' in entry.defaults) || !('S' in entry.defaults) || entry.kind === 'rate') {
            key = 'homogeneous'; entry = reg.homogeneous;
        }
        if (!entry || typeof entry.pd !== 'function') return { error: 'No model evaluator loaded.' };
        if (!ad || !ad.ok) return { error: (ad && ad.reason) || 'No analysable data.' };
        if (!w.complete) return { error: 'Well inputs incomplete (missing: ' + (w.missing || []).join(', ') + ').' };
        var q = isNum(ad.qRef) && ad.qRef > 0 ? ad.qRef : w.q;
        var adq = { t: ad.t, dp: ad.dp, deriv: ad.deriv, qRef: q };
        var h = w.h, phi = w.phi, mu = w.mu, ct = w.ct, rw = w.rw, Bf = w.B;
        var base = {};
        Object.keys(entry.defaults).forEach(function (k) { base[k] = entry.defaults[k]; });
        var tArr = ad.t, lnObs = ad.dp.map(Math.log);
        function scales(k, C) {
            return {
                A: 141.2 * q * Bf * mu / (k * h),
                B: 0.0002637 * k / (phi * mu * ct * rw * rw),
                Cd: 0.8936 * C / (phi * ct * h * rw * rw)
            };
        }
        function model(x) {
            var k = Math.pow(10, x[0]), C = Math.pow(10, x[1]), sc = scales(k, C);
            var prm = {}; for (var kk in base) prm[kk] = base[kk];
            prm.Cd = sc.Cd; prm.S = x[2];
            var td = [];
            for (var i = 0; i < tArr.length; i++) td.push(sc.B * tArr[i]);
            var pd;
            try { pd = entry.pd(td, prm); } catch (e) { pd = null; }
            var out = new Array(tArr.length);
            for (var j = 0; j < tArr.length; j++) out[j] = pd ? sc.A * pd[j] : NaN;
            return out;
        }
        function res(x) {
            var m = model(x), r = new Array(m.length);
            for (var i = 0; i < m.length; i++) r[i] = (m[i] > 0 && isFinite(m[i])) ? Math.log(m[i]) - lnObs[i] : 10;
            return r;
        }
        var s0 = seedPhys(adq, { B: Bf, mu: mu, h: h, phi: phi, ct: ct, rw: rw });
        var lo = [-3, -7, -5], hi = [5, 1, 50];
        var best = null;
        [s0.S, s0.S + 2, s0.S - 1.5].forEach(function (S0, idx) {
            if (best && best.ssr < 1e-6 * ad.t.length) return;
            if (idx > 0 && best && best.converged && best.ssr / ad.t.length < 1e-4) return;
            var f = lm(res, [Math.log10(s0.k), Math.log10(s0.C), S0], lo, hi, 80);
            if (!best || f.ssr < best.ssr) best = f;
        });
        var x = best.x, k = Math.pow(10, x[0]), C = Math.pow(10, x[1]), S = x[2], sc = scales(k, C);
        var mod = model(x), gof = r2Linear(ad.dp, mod);
        var n = ad.t.length, aic = n * Math.log(best.ssr / n) + 2 * 3;
        var z = 1.96;
        var ci = {
            k: [Math.pow(10, x[0] - z * best.se[0]), Math.pow(10, x[0] + z * best.se[0])],
            C: [Math.pow(10, x[1] - z * best.se[1]), Math.pow(10, x[1] + z * best.se[1])],
            S: [S - z * best.se[2], S + z * best.se[2]]
        };
        var tEnd = ad.t[n - 1];
        var params = {}; for (var kk2 in base) params[kk2] = base[kk2];
        params.Cd = sc.Cd; params.S = S;
        return {
            modelKey: key, kind: 'pressure', source: 'regression',
            params: params,
            phys: {
                k: k, kh: k * h, C: C, Cd: sc.Cd, S: S, pi: ad.pRef,
                rinv: Math.sqrt(k * tEnd / (948 * phi * mu * ct))
            },
            ci95: ci,
            stderr: { k: k * LN10 * best.se[0], C: C * LN10 * best.se[1], S: best.se[2] },
            identifiable: { k: true, C: true, S: isNum(best.se[2]) && z * best.se[2] < Math.max(1, Math.abs(S)) },
            r2: gof.r2, rmse: gof.rmse, aic: aic, iterations: best.iterations, converged: best.converged,
            objective: best.ssr, window: { tmin: ad.t[0], tmax: tEnd },
            scales: { A: sc.A, B: sc.B }, pRef: ad.pRef, pRefSource: ad.pRefSource,
            timestamp: new Date().toISOString(),
            warnings: ['Fitted by the built-in fallback (shared regression engine not loaded).']
        };
    }

    // =========================================================================
    // SECTION 5 — RESULTS RAIL
    // =========================================================================

    var _sheetExpanded = false;
    var _lastCandidates = [];
    var _lastCandidatesHash = null;   // dataset the race ranking belongs to
    var _toast = '';

    var SOURCE_LABEL = {
        regression: 'regression', automatch: 'auto-match', 'auto-match': 'auto-match',
        match: 'match', semilog: 'straight-line', 'straight-line': 'straight-line'
    };
    function sourceChip(src) {
        var s = String(src || '').toLowerCase();
        var cls = s === 'auto-match' ? 'automatch' : (s === 'straight-line' ? 'semilog' : s);
        var label = SOURCE_LABEL[s] || (src ? String(src) : 'model');
        return '<span class="prism-chip prism-chip--' + esc(cls) + '">' + esc(label) + '</span>';
    }

    var WELL_LABEL = { q: 'q', B: 'B', mu: 'μ', ct: 'c_t', h: 'h', phi: 'φ', rw: 'r_w', pi: 'p_i' };

    function interpHeadline(interp) {
        if (!interp) return '';
        var h = pick(interp, ['headline', 'summary', 'title']);
        if (h) return String(h);
        var n = interp.narrative;
        if (!n) return '';
        n = String(n).replace(/\s+/g, ' ').trim();
        var m = n.match(/^(.+?[.!?])(\s|$)/);
        return m ? m[1] : n;
    }

    function localHeadline(fit) {
        if (fit && fit.kind === 'rate' && fit.params) {
            var rp = fit.params;
            return modelName(fit.modelKey) + ' decline' + (isNum(rp.qi) ? ': q_i ' + fmt(rp.qi) : '') +
                (isNum(rp.Di) ? ', D_i ' + fmt(rp.Di) + '/d' : '') + (isNum(rp.b) ? ', b ' + fmt(rp.b, 2) : '') + '.';
        }
        if (!fit || !fit.phys) return '';
        var S = fit.phys.S, k = fit.phys.k, txt;
        if (!isNum(S)) txt = 'Well response';
        else if (S < -3) txt = 'Strongly stimulated well';
        else if (S < 0) txt = 'Stimulated well';
        else if (S < 2) txt = 'Near-undamaged well';
        else if (S < 5) txt = 'Mildly damaged well';
        else if (S < 10) txt = 'Moderately damaged well';
        else txt = 'Severely damaged well';
        return txt + (isNum(S) ? ' (S = ' + S.toFixed(1) + ')' : '') + ' — ' + modelName(fit.modelKey).toLowerCase() +
            (isNum(k) ? ', k ≈ ' + fmt(k) + ' md.' : '.');
    }

    function describePeriod(ad) {
        var ap = activePeriod();
        var periods = getPeriods();
        var lbl;
        if (ap != null && periods[ap]) lbl = '#' + (ap + 1) + ' ' + periods[ap].type;
        else lbl = periods.length > 1 ? 'All data (' + periods.length + ' periods)' : 'Single period';
        if (ad && ad.ok && ad.t && ad.t.length) {
            lbl += ' · Δt ' + fmt(ad.t[0], 2) + '–' + fmt(ad.t[ad.t.length - 1], 3) + ' h';
        }
        return lbl;
    }

    // Collects everything the rail shows. Exported as PRiSM_railInfo().
    function railInfo() {
        var s = st();
        var ds = G.PRiSM_dataset;
        var hasData = !!(ds && isArr(ds.t) && ds.t.length);
        var info = {
            dataset: null, period: null, testType: null, fit: null, semilog: null,
            model: null, headline: '', warnings: [], summary: ''
        };
        var well = getWell(ds);
        info.fluid = well.fluid || 'oil';
        var ad = hasData ? getAnalysisData() : null;
        if (hasData) {
            info.dataset = {
                name: ds.name || ds.label || ds.fileName || ds.filename || (isDefaultSample(ds) ? 'Demo data' : 'Loaded data'),
                n: ds.t.length
            };
            info.period = describePeriod(ad);
        }
        info.testType = (ad && ad.ok && ad.testType) || (well.testType && well.testType !== 'auto' ? well.testType : null);
        var lf = getLastFit();
        if (lf) {
            var phys = lf.phys || {};
            info.fit = {
                source: lf.source || 'regression', modelKey: lf.modelKey, phys: phys, kind: lf.kind || 'pressure',
                params: lf.params || null, eur: rateEUR(lf),
                ci95: lf.ci95 || {}, r2: lf.r2, rmse: lf.rmse, aic: lf.aic, dAIC: lf.dAIC,
                converged: lf.converged, stale: !!lf.stale, pRefSource: lf.pRefSource
            };
            info.model = {
                key: lf.modelKey, name: modelName(lf.modelKey), r2: lf.r2, converged: lf.converged,
                dAIC: isNum(lf.dAIC) ? lf.dAIC : null, nextDAIC: null, nextName: null
            };
            if (_lastCandidates.length > 1 && _lastCandidates[0].modelKey === lf.modelKey &&
                (!_lastCandidatesHash || !lf.datasetHash || _lastCandidatesHash === lf.datasetHash)) {
                info.model.nextDAIC = _lastCandidates[1].dAIC;
                info.model.nextName = modelName(_lastCandidates[1].modelKey);
            }
        }
        var sl = s.semilog;
        if (sl && typeof sl === 'object') {
            var sk = sl.skin || sl.skinSummary || sl.deliverables || {};
            info.semilog = {
                method: pick(sl, ['method', 'kind']),
                m: pickNum(sl, ['m', 'slope']),
                kh: pickNum(sl, ['kh']),
                k: pickNum(sl, ['k']),
                S: pickNum(sl, ['S', 'skin']),
                dpS: pickNum(sl, ['dpS', 'dPs', 'deltaPS', 'deltaPs', 'dpSkin']) != null
                    ? pickNum(sl, ['dpS', 'dPs', 'deltaPS', 'deltaPs', 'dpSkin']) : pickNum(sk, ['dpS', 'dPs', 'deltaPS', 'deltaPs', 'dpSkin']),
                FE: pickNum(sl, ['FE']) != null ? pickNum(sl, ['FE']) : pickNum(sk, ['FE']),
                DR: pickNum(sl, ['DR']) != null ? pickNum(sl, ['DR']) : pickNum(sk, ['DR']),
                J: pickNum(sl, ['J', 'PI']) != null ? pickNum(sl, ['J', 'PI']) : pickNum(sk, ['J']),
                pStar: pickNum(sl, ['pStar', 'pstar', 'p_star', 'pStarPsia'])
            };
            if (info.semilog.k == null && info.semilog.kh == null && info.semilog.S == null) info.semilog = null;
        }
        // Only a real fit gets a headline: st.interp can hold a 'manual' reading of the
        // untouched default parameters (S 0), which must not read as a result (WP0 fix).
        info.headline = lf ? (interpHeadline(s.interp) || localHeadline(lf)) : '';

        // ── Warnings ──
        var W = info.warnings;
        if (hasData && well.defaulted && well.defaulted.length) {
            W.push({
                id: 'defaulted', level: 'warn', action: 'accept',
                text: 'Defaulted inputs: ' + well.defaulted.map(function (k) { return WELL_LABEL[k] || k; }).join(', ') + '.'
            });
        }
        if (hasData && well.missing && well.missing.length) {
            W.push({
                id: 'missing', level: 'bad', action: 'data',
                text: 'Missing inputs: ' + well.missing.map(function (k) { return WELL_LABEL[k] || k; }).join(', ') + ' — results stay in scale mode.'
            });
        }
        var prs = (ad && ad.ok && ad.pRefSource) || (lf && lf.pRefSource);
        if (prs === 'first-sample') {
            W.push({ id: 'pref', level: 'bad', action: 'data', text: 'Δp is measured from the first sample, so skin is biased. Enter the initial pressure pi.' });
        } else if (prs === 'extrapolated') {
            W.push({ id: 'pref', level: 'warn', action: 'data', text: 'Reference pressure extrapolated to t = 0 — skin may be biased. Enter pi to confirm.' });
        }
        if (lf && lf.stale) {
            W.push({ id: 'stale', level: 'warn', action: 'analyse', text: 'Fit is out of date (data, period or model changed).' });
        }
        if (lf && lf.converged === false) {
            W.push({ id: 'noconv', level: 'warn', text: 'Fit did not converge — treat it as a starting point and refine.' });
        }
        if (ad && ad.ok && isArr(ad.warnings)) {
            toArr(ad.warnings).slice(0, 3).forEach(function (m, i) {
                if (prs && /biased|first sample/i.test(m)) return;
                W.push({ id: 'ad' + i, level: 'info', text: String(m) });
            });
        }
        if (ad && !ad.ok && hasData) W.push({ id: 'adfail', level: 'bad', text: ad.reason || 'Data cannot be analysed yet.' });

        // ── Sheet summary: "kh · S · model · ⚠n" ──
        var kh = info.fit && isNum(info.fit.phys.kh) ? info.fit.phys.kh : (info.semilog ? info.semilog.kh : null);
        var S = info.fit && isNum(info.fit.phys.S) ? info.fit.phys.S : (info.semilog ? info.semilog.S : null);
        var parts = [];
        parts.push('kh ' + (isNum(kh) ? fmt(kh) : '—'));
        parts.push('S ' + (isNum(S) ? S.toFixed(2) : '—'));
        parts.push(info.model ? info.model.name : (hasData ? 'No fit yet' : 'No data'));
        if (W.length) parts.push('⚠' + W.length);
        info.summary = parts.join(' · ');
        return info;
    }

    function rateEUR(lf) {
        if (!lf || lf.kind !== 'rate') return null;
        if (typeof G.PRiSM_declineResults === 'function') {
            try {
                var r = G.PRiSM_declineResults(lf, G.PRiSM_dataset, {});
                var e = r && pickNum(r, ['EUR', 'eur']);
                if (isNum(e)) return e;
            } catch (e2) {}
        }
        return null;
    }

    function kvRow(k, v, extra) {
        return '<div class="prism-rail-k">' + k + '</div><div class="prism-rail-v">' + v + (extra ? ' <small>' + extra + '</small>' : '') + '</div>';
    }

    function ciHalf(ci) { return (ci && isNum(ci[0]) && isNum(ci[1])) ? Math.abs(ci[1] - ci[0]) / 2 : null; }

    function railBodyHTML(info) {
        var h = [];
        // Dataset / period / test type
        h.push('<div class="prism-rail-sec" id="prism_rail_data">');
        h.push('<div class="prism-rail-h"><span>Data</span>' +
            (info.testType ? '<span class="prism-chip">' + esc(info.testType) + '</span>' : '') + '</div>');
        if (info.dataset) {
            h.push('<div class="prism-rail-kv">' +
                kvRow('Dataset', esc(info.dataset.name), esc(fmt(info.dataset.n)) + ' pts') +
                kvRow('Period', esc(info.period || '—')) + '</div>');
        } else {
            h.push('<div class="prism-rail-line">No data loaded. Load a file or try the demo data on step ①.</div>');
        }
        h.push('</div>');

        // Physical results from the active fit
        var f = info.fit;
        h.push('<div class="prism-rail-sec" id="prism_rail_results">');
        h.push('<div class="prism-rail-h"><span>Results</span>' + (f ? sourceChip(f.source) : '') + '</div>');
        if (f) {
            var p = f.phys || {}, ci = f.ci95 || {}, rows = [];
            var kHalf = ciHalf(ci.k), sHalf = ciHalf(ci.S), cHalf = ciHalf(ci.C);
            if (isNum(p.k)) rows.push(kvRow('k', fmt(p.k) + ' md', isNum(kHalf) ? '±' + fmt(100 * kHalf / p.k, 2) + '%' : ''));
            if (isNum(p.kh)) rows.push(kvRow('kh', fmt(p.kh) + ' md·ft'));
            if (isNum(p.S)) rows.push(kvRow('Skin S', fmtSigned(p.S, 2) + (isNum(sHalf) ? ' ± ' + fmtFixed(sHalf, 2) : '')));
            if (isNum(p.C)) rows.push(kvRow('C', fmt(p.C) + ' bbl/psi', (isNum(p.Cd) ? 'C_D ' + fmt(p.Cd) : '') + (isNum(cHalf) ? ' ±' + fmt(100 * cHalf / p.C, 2) + '%' : '')));
            else if (isNum(p.Cd)) rows.push(kvRow('C_D', fmt(p.Cd)));
            if (isNum(p.xf)) rows.push(kvRow('x_f', fmt(p.xf) + ' ft'));
            if (isNum(p.Lh)) rows.push(kvRow('L_h', fmt(p.Lh) + ' ft'));
            if (p.distances_ft && typeof p.distances_ft === 'object') {
                Object.keys(p.distances_ft).forEach(function (dk) {
                    if (isNum(p.distances_ft[dk])) rows.push(kvRow(esc(dk), fmt(p.distances_ft[dk]) + ' ft'));
                });
            }
            if (isNum(p.rinv)) rows.push(kvRow('r_inv', fmt(p.rinv) + ' ft'));
            if (isNum(p.pi)) rows.push(kvRow('p_i', fmt(p.pi, 5) + ' psia'));
            if (f.kind === 'rate' && f.params) {
                var rp = f.params;
                if (isNum(rp.qi)) rows.push(kvRow('q_i', fmt(rp.qi) + (info.fluid === 'gas' ? ' Mscf/d' : ' STB/d')));
                if (isNum(rp.Di)) rows.push(kvRow('D_i', fmt(rp.Di) + ' 1/d'));
                if (isNum(rp.b)) rows.push(kvRow('b', fmtFixed(rp.b, 2)));
                if (isNum(f.eur)) rows.push(kvRow('EUR', fmt(f.eur)));
            }
            h.push(rows.length ? '<div class="prism-rail-kv">' + rows.join('') + '</div>'
                : '<div class="prism-rail-line">The fit has no field-unit results (well inputs incomplete).</div>');
        } else {
            h.push('<div class="prism-rail-line">No fit yet. Press <b>▶ Analyse</b> for a one-click interpretation.</div>');
        }
        h.push('</div>');

        // Straight-line (semilog) results
        var sl = info.semilog;
        if (sl) {
            var srows = [];
            if (isNum(sl.m)) srows.push(kvRow('m', fmt(Math.abs(sl.m)) + ' psi/cycle'));
            if (isNum(sl.k)) srows.push(kvRow('k', fmt(sl.k) + ' md'));
            else if (isNum(sl.kh)) srows.push(kvRow('kh', fmt(sl.kh) + ' md·ft'));
            if (isNum(sl.S)) srows.push(kvRow('Skin S', fmtSigned(sl.S, 2)));
            if (isNum(sl.dpS)) srows.push(kvRow('Δp_skin', fmt(sl.dpS) + ' psi'));
            if (isNum(sl.FE)) srows.push(kvRow('FE', fmtFixed(sl.FE, 2), isNum(sl.DR) ? 'DR ' + fmtFixed(sl.DR, 2) : ''));
            else if (isNum(sl.DR)) srows.push(kvRow('DR', fmtFixed(sl.DR, 2)));
            if (isNum(sl.J)) srows.push(kvRow('J', fmt(sl.J) + (info.fluid === 'gas' ? ' Mscf/d/psi' : ' STB/d/psi')));
            if (isNum(sl.pStar)) srows.push(kvRow('p*', fmt(sl.pStar, 5) + ' psia'));
            h.push('<div class="prism-rail-sec" id="prism_rail_semilog"><div class="prism-rail-h"><span>Straight line' +
                (sl.method ? ' · ' + esc(String(sl.method).toUpperCase()) : '') + '</span>' + sourceChip('semilog') + '</div>' +
                '<div class="prism-rail-kv">' + srows.join('') + '</div></div>');
        }

        // Model
        var m = info.model;
        if (m) {
            var badge = m.converged === true ? '<span class="prism-chip prism-chip--ok">✓ converged</span>'
                : (m.converged === false ? '<span class="prism-chip prism-chip--warn">starting point</span>' : '');
            var mrows = [kvRow('Model', esc(m.name))];
            if (isNum(m.r2)) mrows.push(kvRow('R²', m.r2 >= 0.9999 ? m.r2.toFixed(5) : m.r2.toFixed(4)));
            if (isNum(m.nextDAIC) && m.nextName) mrows.push(kvRow('ΔAIC', fmt(m.nextDAIC, 3), 'vs ' + esc(m.nextName)));
            else if (isNum(m.dAIC) && m.dAIC !== 0) mrows.push(kvRow('ΔAIC', fmt(m.dAIC, 3)));
            h.push('<div class="prism-rail-sec" id="prism_rail_model"><div class="prism-rail-h"><span>Model</span>' + badge + '</div>' +
                '<div class="prism-rail-kv">' + mrows.join('') + '</div>' +
                (info.headline ? '<div class="prism-rail-headline" id="prism_rail_headline" style="margin-top:8px;">“' + esc(info.headline) + '”</div>' : '') +
                '</div>');
        } else if (info.headline) {
            h.push('<div class="prism-rail-sec"><div class="prism-rail-headline" id="prism_rail_headline">“' + esc(info.headline) + '”</div></div>');
        }

        // Warnings
        if (info.warnings.length) {
            h.push('<div class="prism-rail-sec" id="prism_rail_warnings"><div class="prism-rail-h"><span>Checks</span><span class="prism-chip prism-chip--warn">⚠ ' + info.warnings.length + '</span></div>');
            h.push('<div style="display:flex; flex-direction:column; gap:6px;">');
            info.warnings.forEach(function (w) {
                var cls = w.level === 'bad' ? ' prism-rail-warn--bad' : (w.level === 'info' ? ' prism-rail-warn--info' : '');
                var btn = '';
                if (w.action === 'accept') btn = '<button type="button" class="prism-btn prism-btn--small" id="prism_rail_accept">Accept</button>';
                else if (w.action === 'analyse') btn = '<button type="button" class="prism-btn prism-btn--small" data-rail-act="analyse">Re-run</button>';
                else if (w.action === 'data') btn = '<button type="button" class="prism-btn prism-btn--small" data-rail-act="data">Edit inputs</button>';
                h.push('<div class="prism-rail-warn' + cls + '" data-warn="' + esc(w.id) + '"><span>⚠ ' + esc(w.text) + '</span>' + btn + '</div>');
            });
            h.push('</div></div>');
        }

        // Actions
        var canStart = !!(f && f.phys) || !!(sl && (isNum(sl.k) || isNum(sl.S)));
        h.push('<div class="prism-rail-actions">' +
            '<button type="button" class="prism-btn" id="prism_rail_use_start"' + (canStart ? '' : ' disabled') + '>Use as start values</button>' +
            '<button type="button" class="prism-btn" id="prism_rail_pin"' + (f || sl ? '' : ' disabled') + '>Pin to report</button>' +
            (!f || f.stale ? '<button type="button" class="prism-btn prism-btn--primary" data-rail-act="analyse">▶ Analyse</button>' : '') +
            '</div>');
        if (_toast) h.push('<div class="prism-toast" id="prism_rail_toast">' + esc(_toast) + '</div>');
        return h.join('');
    }

    function PRiSM_renderRail(railEl) {
        railEl = railEl || $('prism_rail');
        if (!railEl) return null;
        ensureStyle();
        var info;
        try { info = railInfo(); } catch (e) {
            railEl.innerHTML = '<div class="prism-rail-body"><div class="prism-rail-warn prism-rail-warn--bad"><span>Results unavailable: ' + esc(e && e.message) + '</span></div></div>';
            return null;
        }
        var sheet = !!(railEl.classList && railEl.classList.contains('prism-rail--sheet'));
        var body = railBodyHTML(info);
        if (sheet) {
            railEl.innerHTML =
                '<button type="button" class="prism-rail-sheetbar" id="prism_rail_sheetbar" aria-expanded="' + (_sheetExpanded ? 'true' : 'false') + '" aria-controls="prism_rail_body">' +
                '<span class="prism-rail-grip" aria-hidden="true"></span>' +
                '<span class="prism-rail-sum" id="prism_rail_summary">' + esc(info.summary) + '</span>' +
                '<span aria-hidden="true">' + (_sheetExpanded ? '▾' : '▴') + '</span></button>' +
                '<div class="prism-rail-body" id="prism_rail_body" style="display:' + (_sheetExpanded ? 'flex' : 'none') + ';">' + body + '</div>';
            var bar = railEl.querySelector ? railEl.querySelector('#prism_rail_sheetbar') : $('prism_rail_sheetbar');
            if (bar) bar.onclick = function () { _sheetExpanded = !_sheetExpanded; PRiSM_renderRail(railEl); };
            if (_sheetExpanded) fitSheet(railEl);
        } else {
            railEl.innerHTML = '<div class="prism-rail-body" id="prism_rail_body">' + body + '</div>';
        }
        wireRail(railEl);
        return info;
    }

    // Nearest scrolling ancestor (the host page body), else null.
    function scrollHost(el) {
        var n = el && el.parentNode, gcs = typeof G.getComputedStyle === 'function' ? G.getComputedStyle : null;
        for (var i = 0; n && i < 40 && n.nodeType === 1; i++, n = n.parentNode) {
            var oy = '';
            try { oy = gcs ? gcs(n).overflowY : (n.style && n.style.overflowY); } catch (e) { oy = ''; }
            if ((oy === 'auto' || oy === 'scroll') && n.clientHeight > 0) return n;
        }
        return null;
    }

    // The expanded bottom sheet must fit inside the visible scroll area, so its
    // summary bar and ▾ toggle never slide under the host page header.
    function fitSheet(railEl) {
        try {
            var body = q1(railEl, '#prism_rail_body');
            if (!body || !body.style) return;
            var wrap = $('prism_railwrap') || railEl;
            var host = scrollHost(wrap);
            var vh = isNum(G.innerHeight) && G.innerHeight > 0 ? G.innerHeight : 0;
            var avail = 0;
            if (host && host.getBoundingClientRect) {
                // Visible content box of the scroll host (its padding is not usable by
                // a sticky child).
                var r = host.getBoundingClientRect(), padT = 0, padB = 0;
                try {
                    var hcs = G.getComputedStyle(host);
                    padT = parseFloat(hcs.paddingTop) || 0; padB = parseFloat(hcs.paddingBottom) || 0;
                } catch (e) { /* no computed style */ }
                avail = Math.min(r.bottom - padB, vh || r.bottom) - Math.max(r.top + padT, 0);
            }
            if (!(avail > 0)) avail = vh;
            if (!(avail > 0)) return;
            // Everything in the sheet that is not the scrolling body: bar, paddings, borders.
            var extra = 68;
            if (wrap.getBoundingClientRect && body.getBoundingClientRect) {
                var wr = wrap.getBoundingClientRect(), bd = body.getBoundingClientRect();
                if (wr && bd && wr.height > bd.height && bd.height > 0) extra = wr.height - bd.height;
            }
            body.style.maxHeight = Math.max(120, Math.round(Math.min(avail - extra - 8, (vh || avail) * 0.7))) + 'px';
        } catch (e) { /* keep the CSS max-height */ }
    }

    function collapseSheet() {
        if (!_sheetExpanded) return false;
        _sheetExpanded = false;
        var r = $('prism_rail');
        if (r) { try { PRiSM_renderRail(r); } catch (e) {} }
        return true;
    }

    function q1(root, sel) {
        try { return root.querySelector(sel); } catch (e) { return null; }
    }

    function wireRail(railEl) {
        var acc = q1(railEl, '#prism_rail_accept');
        if (acc) acc.onclick = function () { acceptDefaults(); _toast = 'Defaults accepted as your inputs.'; PRiSM_renderRail(railEl); };
        var use = q1(railEl, '#prism_rail_use_start');
        if (use) use.onclick = function () { useAsStartValues(); PRiSM_renderRail(railEl); };
        var pin = q1(railEl, '#prism_rail_pin');
        if (pin) pin.onclick = function () { pinToReport(); PRiSM_renderRail(railEl); };
        var acts = railEl.querySelectorAll ? railEl.querySelectorAll('[data-rail-act]') : [];
        for (var i = 0; i < acts.length; i++) {
            (function (b) {
                b.onclick = function () {
                    var a = b.getAttribute('data-rail-act');
                    if (a === 'analyse') PRiSM_analyse();
                    else if (a === 'data') gotoStep(1);
                };
            })(acts[i]);
        }
    }

    function acceptDefaults() {
        var w = getWell();
        var keys = (w.defaulted || []).slice();
        if (!keys.length) return false;
        var patch = {}, pvt = G.PRiSM_pvt || {};
        keys.forEach(function (k) {
            var pk = pvtKey(k, w.fluid);
            var v = isNum(w[k]) ? w[k] : pvt[pk];
            if (isNum(v)) patch[pk] = v;
        });
        if (!Object.keys(patch).length) return false;
        setWell(patch, 'user');
        return true;
    }

    function useAsStartValues() {
        var s = st(), lf = getLastFit(), info = railInfo(), phys = null;
        if (lf && lf.phys) {
            phys = clone(lf.phys);
            if (lf.params && (!lf.modelKey || lf.modelKey === s.model)) s.params = clone(lf.params);
        } else if (info.semilog) {
            phys = {};
            if (isNum(info.semilog.k)) phys.k = info.semilog.k;
            if (isNum(info.semilog.S)) phys.S = info.semilog.S;
        }
        if (!phys) return false;
        var cur = s.phys || {};
        Object.keys(phys).forEach(function (k) { cur[k] = phys[k]; });
        s.phys = cur;
        saveState();
        recordSnapshot('start-values');
        _toast = 'Start values set for the next fit' + (isNum(cur.k) ? ' (k ' + fmt(cur.k) + ' md' + (isNum(cur.S) ? ', S ' + cur.S.toFixed(2) : '') + ')' : '') + '.';
        dispatch('prism:start-values', { phys: clone(cur) });
        return true;
    }

    function pinToReport() {
        var s = st(), info = railInfo(), lf = getLastFit();
        if (!info.fit && !info.semilog) return null;
        var pin = {
            id: 'pin_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e4),
            timestamp: new Date().toISOString(),
            dataset: info.dataset, period: info.period, testType: info.testType,
            modelKey: lf ? lf.modelKey : null, modelName: lf ? modelName(lf.modelKey) : null,
            source: lf ? lf.source : 'semilog',
            phys: lf ? clone(lf.phys) : null, ci95: lf ? clone(lf.ci95) : null,
            r2: lf ? lf.r2 : null, aic: lf ? lf.aic : null, converged: lf ? lf.converged : null,
            semilog: clone(info.semilog), headline: info.headline
        };
        s.reportPins = isArr(s.reportPins) ? s.reportPins : [];
        s.reportPins.push(pin);
        if (s.reportPins.length > 20) s.reportPins.shift();
        saveState();
        _toast = 'Pinned to the report (' + s.reportPins.length + ' pinned).';
        dispatch('prism:report-pinned', { pin: clone(pin) });
        return pin;
    }

    function renderRailIfMounted() {
        var r = $('prism_rail');
        if (r) { try { PRiSM_renderRail(r); } catch (e) {} }
    }

    // =========================================================================
    // SECTION 6 — ONE-CLICK ANALYSE PIPELINE
    // =========================================================================

    var _analyseRun = null;
    var _analyseCancel = false;

    // Hide the Analyse progress panel (auto-close after a run, on a new fit /
    // dataset / project, or the ✕ button). Never while a run is in progress.
    function hideProgress(force) {
        if (_analyseRun && !force) return;
        var box = $('prism_analyse_progress');
        if (box) box.style.display = 'none';
    }

    // Narrow screens: keep the panel clear of the rail bottom sheet's bar.
    function placeProgress(box) {
        try {
            var wrap = $('prism_railwrap'), rail = $('prism_rail');
            var vh = isNum(G.innerHeight) && G.innerHeight > 0 ? G.innerHeight : 0;
            box.style.bottom = '';
            if (!vh || !wrap || !rail || !rail.classList || !rail.classList.contains('prism-rail--sheet') || !wrap.getBoundingClientRect) return;
            var r = wrap.getBoundingClientRect();
            if (r && r.height > 0 && r.top < vh) box.style.bottom = Math.max(16, Math.round(vh - r.top + 8)) + 'px';
        } catch (e) { /* keep the CSS position */ }
    }

    var PROGRESS_STEPS = [
        ['data', 'Read data & inputs'],
        ['semilog', 'Straight-line analysis'],
        ['race', 'Model race (top 3)'],
        ['refine', 'Refine best model'],
        ['interp', 'Interpretation']
    ];

    function progressUI() {
        var host = D && D.body;
        if (!host || !D.createElement) {
            return { step: function () {}, done: function () {} };
        }
        ensureStyle();
        var box = $('prism_analyse_progress');
        if (!box) {
            box = D.createElement('div');
            box.id = 'prism_analyse_progress';
            box.className = 'prism-progress';
            box.setAttribute('role', 'status');
            box.setAttribute('aria-live', 'polite');
            host.appendChild(box);
        }
        box.style.display = '';
        if (box.classList) box.classList.remove('is-done');
        placeProgress(box);
        box.innerHTML = '<div class="prism-progress-head"><span id="prism_analyse_title">Analysing…</span>' +
            '<button type="button" class="prism-btn prism-btn--small" id="prism_analyse_cancel">Cancel</button>' +
            '<button type="button" class="prism-btn prism-btn--small" id="prism_analyse_close" aria-label="Close">✕</button></div>' +
            PROGRESS_STEPS.map(function (s) {
                return '<div class="prism-progress-row" id="prism_analyse_step_' + s[0] + '"><b>○</b><span>' + esc(s[1]) + '</span><em></em></div>';
            }).join('') +
            '<div class="prism-progress-note" id="prism_analyse_note" style="display:none"></div>';
        var close = $('prism_analyse_close');
        if (close) close.onclick = function () { hideProgress(true); };
        var cancel = $('prism_analyse_cancel');
        if (cancel) cancel.onclick = function () {
            _analyseCancel = true;
            cancel.disabled = true;
            cancel.textContent = 'Cancelling…';
        };
        var ICON = { run: '…', ok: '✓', skip: '–', warn: '⚠', fail: '✕' };
        return {
            step: function (key, status, note) {
                var row = $('prism_analyse_step_' + key);
                if (!row) return;
                row.className = 'prism-progress-row is-' + status;
                var b = row.querySelector ? row.querySelector('b') : null;
                var em = row.querySelector ? row.querySelector('em') : null;
                if (b) b.textContent = ICON[status] || '○';
                if (em) em.textContent = note || '';
            },
            done: function (res) {
                var cb = $('prism_analyse_cancel');
                if (cb) cb.style.display = 'none';
                var t = $('prism_analyse_title');
                if (!t) return;
                // A successful run fades out after a few seconds (CSS animation, no
                // timer left behind); a stopped run stays until ✕ (or a new fit /
                // dataset) so the reason can be read.
                var pb = $('prism_analyse_progress');
                if (res.ok && pb && pb.classList) pb.classList.add('is-done');
                if (res.ok) {
                    var p = res.fit && res.fit.phys || {};
                    t.textContent = 'Done in ' + (res.elapsedMs / 1000).toFixed(1) + ' s' +
                        (isNum(p.k) ? ' — k ' + fmt(p.k) + ' md' : '') + (isNum(p.S) ? ', S ' + p.S.toFixed(2) : '');
                } else {
                    t.textContent = 'Analysis stopped: ' + (res.error || 'see steps');
                }
                var note = $('prism_analyse_note');
                if (note) {
                    note.textContent = res.previewText ? 'Best candidate (preview only, not committed): ' + res.previewText : '';
                    note.style.display = res.previewText ? '' : 'none';
                }
            }
        };
    }

    function setAnalyseBusy(busy) {
        var b = $('prism_analyse_btn');
        if (!b) return;
        b.disabled = !!busy;
        if (busy) b.setAttribute('aria-busy', 'true'); else b.removeAttribute('aria-busy');
    }

    function sharedEngine() { return typeof G.PRiSM_fitPhysical === 'function'; }

    function validFitRow(r) {
        return !!(r && r.phys && isNum(r.phys.k) && r.phys.k > 0 && !r.error);
    }

    function aicOf(f) { var a = f && (f.aic != null ? f.aic : f.AIC); return isNum(a) ? a : Infinity; }

    // C3 consistency: the pressure scale A must equal 141.2·q·B·μ/kh for the
    // reported kh (oil / water; gas pseudo-pressure fits are not checked).
    function physConsistent(fit, well, ad) {
        var p = fit && fit.phys || {}, sc = fit && fit.scales || {};
        if (!isNum(p.k) || p.k <= 0) return false;
        if (!well || !well.complete || well.fluid === 'gas' || (ad && ad.fluid === 'gas')) return true;
        if (!isNum(sc.A) || !(sc.A > 0) || !isNum(p.kh) || !(p.kh > 0)) return true;
        var q = ad && isNum(ad.qRef) && ad.qRef > 0 ? ad.qRef : well.q;
        var aExp = 141.2 * q * well.B * well.mu / p.kh;
        return Math.abs(sc.A / aExp - 1) < 0.05;
    }

    function rmseOf(f) { var r = f && (f.rmse != null ? f.rmse : f.RMSE); return isNum(r) ? r : Infinity; }
    function r2Of(f) { var r = f && (f.r2 != null ? f.r2 : f.R2); return isNum(r) ? r : null; }

    // Adoption rule shared with PRiSM_runRegression (05): a fit is committed only
    // when R² ≥ 0.9 and no parameter is stalled at a bound (without an R²,
    // convergence decides); an unconverged fit must also have settled and have
    // no free parameter at any bound. Returns the reason a fit is rejected, or null.
    function fitRejectReason(f) {
        if (!f) return 'no fit';
        var why = [];
        var stalled = isArr(f.stalledAtBound) ? toArr(f.stalledAtBound) : [];
        var unconv = f.converged === false;
        var boundUnconv = (unconv && isArr(f.atBoundKeys)) ? toArr(f.atBoundKeys) : [];
        if (stalled.length) why.push('parameter at a bound: ' + stalled.join(', '));
        else if (boundUnconv.length) why.push('not converged with parameter at a bound: ' + boundUnconv.join(', '));
        if (unconv && f.settled === false) why.push('not converged (' + (f.stopReason || 'stopped') + ') and still improving');
        var r2 = r2Of(f);
        if (r2 != null && r2 < 0.9) why.push('R² ' + r2.toFixed(3) + ' < 0.9');
        if (r2 == null && f.converged === false) why.push('not converged');
        if (!why.length && f.adopted === false) why.push('rejected by the regression');
        return why.length ? why.join('; ') : null;
    }

    // Default frozen-parameter map for a model (what PRiSM_setModel would set).
    function defaultFreeze(key) {
        var e = (G.PRiSM_MODELS || {})[key], frz = {};
        if (e && isArr(e.defaultFrozen)) toArr(e.defaultFrozen).forEach(function (k) { frz[k] = true; });
        return frz;
    }

    // Refine result when nothing passes the adoption rule: nothing is committed;
    // the best rejected candidate (highest R²) is returned as a preview only.
    function noAcceptable(list) {
        var best = null;
        list.forEach(function (c) {
            if (!c || !c.fit) return;
            if (!best || (r2Of(c.fit) != null ? r2Of(c.fit) : -Infinity) > (r2Of(best.fit) != null ? r2Of(best.fit) : -Infinity)) best = c;
        });
        return { fit: null, rejected: true, preview: best ? best.fit : null,
                 reason: best ? (best.reason || fitRejectReason(best.fit)) : 'no fit' };
    }

    // Refine the chosen model. Resolves {fit, committed, note}.
    //   mode 'shared'   — shared regression engine only
    //   mode 'fallback' — built-in physical fit only
    //   default         — shared when loaded; the race row and the built-in fit
    //                     back it up when the refined result is inconsistent.
    var REFINE_BUDGET_MS = 15000;   // wall-clock cap per refine fit (slow fracture models)
    // Nothing is written to PRiSM_state here unless a fit passes the adoption
    // rule (fitRejectReason): a rejected fit resolves {fit:null, rejected:true,
    // preview, reason} and the previous model / params / lastFit stay as they were.
    function refine(key, ad, well, row, mode) {
        var s = st();
        function local() {
            var f = localFit(ad, well, key);
            if (f && !f.error) return { fit: f, committed: false };
            throw new Error(f && f.error ? f.error : 'Fit failed.');
        }
        function checked(c) {
            var why = fitRejectReason(c.fit);
            if (!why) return c;
            c.reason = why;
            return noAcceptable([c]);
        }
        if (mode === 'fallback' || !sharedEngine()) {
            if (mode === 'shared') return Promise.reject(new Error('Shared regression engine not loaded.'));
            return Promise.resolve().then(function () { return checked(local()); });
        }
        var rejected = [];
        return Promise.resolve().then(function () {
            if (typeof G.PRiSM_runRegression === 'function') {
                // Start from the race row without touching the state: runRegression
                // adopts (setModel + params + lastFit) only a fit that passes its rule.
                var ropts = { modelKey: key, start: row && row.phys, timeBudgetMs: REFINE_BUDGET_MS };
                if (row && row.params) ropts.params = clone(row.params);
                if (s.model !== key) ropts.freeze = defaultFreeze(key);
                var before = s.lastFit;
                return Promise.resolve(G.PRiSM_runRegression(ropts))
                    .then(function (r) {
                        var lf = getLastFit();
                        if (s.lastFit !== before && validFitRow(lf) && lf.modelKey === key) return { fit: lf, committed: true };
                        if (r && r.adopted === false) {
                            // Rejected by runRegression: not a result (and no point re-running
                            // the same fit through fitPhysical below).
                            if (validFitRow(r)) rejected.push({ fit: normaliseFit(r), reason: fitRejectReason(r) });
                            return { skip: true };
                        }
                        if (validFitRow(r)) return { fit: normaliseFit(r), committed: false };
                        return null;
                    }, function () { return null; });
            }
            return null;
        }).then(function (out) {
            if (out && out.skip) out = null;
            else if (!out) {
                try {
                    var f = G.PRiSM_fitPhysical(key, ad, well, { start: row && row.phys, timeBudgetMs: REFINE_BUDGET_MS });
                    if (validFitRow(f)) out = { fit: normaliseFit(f), committed: false };
                } catch (e) {}
            }
            var cands = [];
            if (out) cands.push(out);
            if (validFitRow(row)) cands.push({ fit: normaliseFit(row), committed: false, note: 'model-race result kept', race: true });
            // Parameters the refined regression (same model, started from the race
            // row) drove onto a bound: the race row is an intermediate point on the
            // way there (the short race may stop just short of the bound), so the
            // stall applies to it too.
            var refinedStall = [];
            rejected.forEach(function (c) {
                if (c.fit && isArr(c.fit.stalledAtBound)) toArr(c.fit.stalledAtBound).forEach(function (k) {
                    if (refinedStall.indexOf(k) < 0) refinedStall.push(k);
                });
            });
            // Adoption rule first (same as PRiSM_runRegression), then C3 consistency.
            cands = cands.filter(function (c) {
                var why = c.committed ? null : fitRejectReason(c.fit);
                if (!why && c.race && refinedStall.length) why = 'parameter at a bound in the refined fit: ' + refinedStall.join(', ');
                if (why) { c.reason = why; rejected.push(c); return false; }
                return true;
            });
            var ok = cands.filter(function (c) { return physConsistent(c.fit, well, ad); });
            if (!ok.length) {
                if (mode === 'shared') {
                    if (cands.length) return cands[0];
                    if (rejected.length) return noAcceptable(rejected);
                    throw new Error('The shared regression returned no usable fit.');
                }
                // Every candidate failed the adoption rule: report it, do not swap
                // in a different (built-in homogeneous) model behind the user's back.
                if (!cands.length && rejected.length) return noAcceptable(rejected);
                // A fit runRegression already adopted (and stored) stays the result
                // when the built-in fallback cannot do better.
                var adoptedC = cands.filter(function (c) { return c.committed; })[0] || null;
                var l;
                try { l = local(); } catch (e) {
                    if (adoptedC) return adoptedC;
                    if (rejected.length) return noAcceptable(rejected);
                    throw e;
                }
                var lwhy = fitRejectReason(l.fit);
                if (lwhy) {
                    if (adoptedC) return adoptedC;
                    l.reason = lwhy; rejected.push(l); return noAcceptable(rejected);
                }
                l.note = cands.length ? 'built-in fit used: the shared result was inconsistent (A ≠ 141.2qBμ/kh)'
                                  : 'built-in fit used: the shared regression returned no fit';
                return l;
            }
            var best = ok[0];
            for (var i = 1; i < ok.length; i++) if (rmseOf(best.fit) > 1.05 * rmseOf(ok[i].fit)) best = ok[i];
            if (best !== cands[0] && cands.length && !best.note) best.note = 'refined fit rejected';
            if (best !== cands[0] && cands[0] && !physConsistent(cands[0].fit, well, ad)) {
                best.note = (best.note || '') + ' (refined result inconsistent: A ≠ 141.2qBμ/kh)';
            }
            if (!best.committed && rejected.length && rejected[0].fit && rejected[0].fit !== best.fit) {
                best.note = (best.note ? best.note + ' ' : '') + '(refined fit not adopted: ' + rejected[0].reason + ')';
            }
            return best;
        });
    }

    function commitFit(fit) {
        var s = st();
        fit.source = fit.source || 'regression';
        if (fit.modelKey && s.model !== fit.modelKey) s.model = fit.modelKey;   // no setModel: keep the fitted params
        if (fit.params) s.params = clone(fit.params);
        if (fit.phys) s.phys = clone(fit.phys);
        if (fit.scales && isNum(fit.scales.A) && fit.scales.A > 0 && isNum(fit.scales.B) && fit.scales.B > 0) {
            s.tcMatch = { logPM: Math.log10(1 / fit.scales.A), logTM: Math.log10(fit.scales.B), source: fit.source };
        }
        if (typeof G.PRiSM_setLastFit === 'function') {
            try { G.PRiSM_setLastFit(fit); } catch (e) { s.lastFit = fit; dispatch('prism:fit-updated', { source: fit.source }); }
        } else {
            var lf = clone(fit);
            lf.R2 = lf.r2; lf.RMSE = lf.rmse; lf.AIC = lf.aic; lf.CI95 = lf.ci95;   // legacy readers
            s.lastFit = lf;
            dispatch('prism:fit-updated', { source: fit.source, modelKey: fit.modelKey });
        }
        if (typeof G.PRiSM_evalModelCurve === 'function') {
            try { G.PRiSM_evalModelCurve(s.model, s.params); } catch (e) {}
        }
        saveState();
        redraw();
    }

    function isRateOnly(ds) {
        if (!ds || !isArr(ds.q)) return false;
        if (!isArr(ds.p)) return true;
        for (var i = 0; i < ds.p.length; i++) if (isNum(ds.p[i])) return false;
        return true;
    }

    // Races the rate models through the shared rate fitter (q as target).
    function declineRace(ds) {
        var reg = G.PRiSM_MODELS || {}, rows = [];
        Object.keys(reg).forEach(function (k) {
            if (!reg[k] || reg[k].kind !== 'rate') return;
            try {
                var f = normaliseFit(G.PRiSM_fitRate(k, ds, {}));
                if (f && f.params && (isNum(f.r2) || isNum(f.aic))) {
                    f.modelKey = f.modelKey || k;
                    f.kind = 'rate';
                    f.source = f.source || 'regression';
                    rows.push(f);
                }
            } catch (e) { /* model not fittable to these rates */ }
        });
        rows.sort(function (a, b) { return aicOf(a) - aicOf(b); });
        var a0 = rows.length ? aicOf(rows[0]) : 0;
        return rows.slice(0, 3).map(function (row) {
            return { modelKey: row.modelKey, dAIC: isFinite(aicOf(row)) ? aicOf(row) - a0 : null, r2: row.r2, row: row };
        });
    }

    function PRiSM_analyse(opts) {
        if (_analyseRun) return _analyseRun;
        opts = opts || {};
        var t0 = now();
        var s = st();
        _analyseCancel = false;
        var ui = progressUI();
        var res = { ok: false, fit: null, semilog: null, candidates: [], engine: (opts.engine !== 'fallback' && sharedEngine()) ? 'shared' : 'fallback', warnings: [], elapsedMs: 0, error: null };
        var ad = null, well = null, rateOnly = false;
        setAnalyseBusy(true);
        recordSnapshot('pre-analyse');   // capture silent edits, then one undo step for the whole run
        _batch++;
        function stop(msg) { var e = new Error(msg); e._stop = true; return e; }

        _analyseRun = yieldTick().then(function () {
            ui.step('data', 'run');
            var ds = G.PRiSM_dataset;
            if (!ds || !isArr(ds.t) || !ds.t.length) throw stop('No data loaded — load a file or the demo data on step ①.');
            well = getWell(ds);
            if (isRateOnly(ds)) {
                if (typeof G.PRiSM_fitRate !== 'function') throw stop('Rate-only data: the decline fitting engine is not loaded.');
                rateOnly = true;
                ui.step('data', 'ok', fmt(ds.t.length) + ' pts · rate only (decline)');
                return yieldTick();
            }
            ad = getAnalysisData(opts.period != null ? { period: opts.period } : periodOpts());
            if (!ad || !ad.ok) throw stop((ad && ad.reason) || 'Data cannot be analysed.');
            ui.step('data', well.complete ? 'ok' : 'warn', fmt(ad.n) + ' pts · ' + (ad.testType || 'test') +
                (well.complete ? '' : ' · missing ' + (well.missing || []).join(', ')));
            return yieldTick();
        }).then(function () {
            if (rateOnly) { ui.step('semilog', 'skip', 'rate-only data'); return null; }
            if (typeof G.PRiSM_semilogAnalysis === 'function') {
                ui.step('semilog', 'run');
                try {
                    var sl = G.PRiSM_semilogAnalysis(ad, well, {});
                    if (sl && typeof sl === 'object' && s.semilog !== sl && sl.ok !== false) s.semilog = sl;
                    res.semilog = s.semilog || null;
                    var slk = res.semilog && pickNum(res.semilog, ['k']), sls = res.semilog && pickNum(res.semilog, ['S']);
                    ui.step('semilog', res.semilog ? 'ok' : 'warn', res.semilog ? ((isNum(slk) ? 'k ' + fmt(slk) + ' md' : '') + (isNum(sls) ? ' · S ' + sls.toFixed(2) : '')) : 'no straight line');
                } catch (e) {
                    ui.step('semilog', 'warn', e && e.message);
                    res.warnings.push('Straight-line analysis: ' + (e && e.message));
                }
            } else ui.step('semilog', 'skip', 'not available');
            return yieldTick();
        }).then(function () {
            if (rateOnly) {
                ui.step('race', 'run');
                res.candidates = declineRace(G.PRiSM_dataset);
                ui.step('race', res.candidates.length ? 'ok' : 'fail', res.candidates.length ? 'best: ' + modelName(res.candidates[0].modelKey).toLowerCase() : 'no decline model fitted');
                if (!res.candidates.length) throw stop('No decline model could be fitted to the rates.');
                return null;
            }
            if (opts.race === false || opts.engine === 'fallback' || !(sharedEngine() && typeof G.PRiSM_autoMatch === 'function')) {
                ui.step('race', 'skip', 'using ' + modelName(opts.modelKey || s.model || 'homogeneous').toLowerCase());
                return null;
            }
            ui.step('race', 'run');
            return Promise.resolve().then(function () {
                return G.PRiSM_autoMatch({ topN: 3, maxIter: 40, adata: ad, well: well, silent: true,
                    onProgress: function (i, n, key) {
                        ui.step('race', 'run', (i + 1) + '/' + n + ' · ' + modelName(key).toLowerCase());
                    },
                    shouldCancel: function () { return _analyseCancel; } });
            }).then(function (r) {
                var rows = r ? (isArr(r) ? r : (r.ranked || r.rows || r.results || [])) : [];
                rows = toArr(rows).filter(validFitRow);
                // Same ranking as the model library (13): AIC, then parsimony
                // when the leader has an undeterminable parameter.
                if (typeof G.PRiSM_rankCandidates === 'function') G.PRiSM_rankCandidates(rows, aicOf);
                else rows.sort(function (a, b) { return aicOf(a) - aicOf(b); });
                var aics = rows.map(aicOf).filter(isNum);
                var a0 = aics.length ? Math.min.apply(null, aics) : 0;
                if (rows.length && rows[0].parsimony) {
                    res.warnings.push(modelName(rows[0].modelKey || rows[0].model) + ' chosen: statistically equivalent to ' +
                        modelName(rows[1].modelKey || rows[1].model).toLowerCase() + ' (ΔAIC < 2) with every parameter determined by the data.');
                }
                res.candidates = rows.slice(0, 3).map(function (row) {
                    return { modelKey: row.modelKey || row.model, dAIC: isNum(aicOf(row)) ? aicOf(row) - a0 : null, r2: row.r2 != null ? row.r2 : row.R2, row: row };
                });
                ui.step('race', rows.length ? 'ok' : 'warn', rows.length ? 'best: ' + modelName(res.candidates[0].modelKey).toLowerCase() : 'no candidate converged');
            }, function (e) {
                ui.step('race', 'warn', e && e.message);
                res.warnings.push('Model race: ' + (e && e.message));
            });
        }).then(function () {
            if (_analyseCancel) throw stop('Cancelled.');
            ui.step('refine', 'run');
            // Race candidates in AIC order. A row that already fails the adoption
            // rule (R² < 0.9 or a parameter stalled at a bound) is skipped in favour
            // of the next one; when every row fails, the top one is still refined
            // (the regression from its start may pass). Nothing is committed unless
            // a fit passes the same rule as PRiSM_runRegression.
            var cs = res.candidates.slice();
            var order = cs.filter(function (c) { return !fitRejectReason(normaliseFit(c.row)); });
            if (!order.length) order = cs.slice(0, 1);
            if (!order.length) {
                if (rateOnly) throw stop('No decline model could be fitted to the rates.');
                return refine(opts.modelKey || s.model || 'homogeneous', ad, well, null, opts.engine);
            }
            var tried = [];
            function attempt(i) {
                if (i >= order.length) return noAcceptable(tried);
                if (_analyseCancel) throw stop('Cancelled.');
                var c = order[i];
                if (i > 0) ui.step('refine', 'run', 'trying ' + modelName(c.modelKey).toLowerCase());
                var pr;
                if (rateOnly) {
                    var rf = normaliseFit(c.row), rwhy = fitRejectReason(rf);
                    if (rwhy) pr = Promise.resolve(noAcceptable([{ fit: rf, reason: rwhy }]));
                    else pr = Promise.resolve({ fit: rf, committed: false });
                } else pr = refine(c.modelKey, ad, well, c.row, opts.engine);
                return pr.then(function (out) {
                    if (out && out.fit) { out.cand = c; return out; }
                    if (out && out.rejected) {
                        if (out.preview) tried.push({ fit: out.preview, reason: out.reason });
                        if (i + 1 < order.length) res.warnings.push(modelName(c.modelKey) + ' not adopted (' + (out.reason || 'no fit') + ').');
                    }
                    return attempt(i + 1);
                });
            }
            return attempt(0);
        }).then(function (out) {
            if (out && out.rejected) {
                // No acceptable fit: keep the previous model, params, lastFit and
                // interpretation; show the best candidate as an uncommitted preview.
                var pv = out.preview, pp = (pv && pv.phys) || {};
                res.preview = pv || null;
                res.rejectReason = out.reason || null;
                res.previewText = pv ? modelName(pv.modelKey) +
                    (r2Of(pv) != null ? ' · R² ' + r2Of(pv).toFixed(3) : '') +
                    (isNum(pp.k) ? ' · k ' + fmt(pp.k) + ' md' : '') + (isNum(pp.S) ? ' · S ' + pp.S.toFixed(2) : '') +
                    (out.reason ? ' — ' + out.reason : '') : '';
                ui.step('refine', 'warn', 'no acceptable fit' + (out.reason ? ' — ' + out.reason : ''));
                ui.step('interp', 'skip', 'previous result kept');
                res.warnings.push('No acceptable fit' + (out.reason ? ' (' + out.reason + ')' : '') +
                    (pv ? '; best candidate ' + modelName(pv.modelKey) + ' shown as a preview only' : '') +
                    ' — previous parameters and result kept.');
                throw stop('No acceptable fit' + (out.reason ? ' (' + out.reason + ')' : '') + ' — previous result kept.');
            }
            if (!out || !out.fit) throw stop('The fit failed.');
            var fit = out.fit;
            // Higher-ranked race rows that failed the adoption rule were skipped.
            if (out.cand && res.candidates.indexOf(out.cand) > 0) {
                res.candidates.slice(0, res.candidates.indexOf(out.cand)).forEach(function (c) {
                    var why = fitRejectReason(normaliseFit(c.row));
                    if (why) res.warnings.push(modelName(c.modelKey) + ' skipped (' + why + ').');
                });
            }
            if (out.note) {
                res.warnings.push(out.note);
                fit.warnings = (isArr(fit.warnings) ? toArr(fit.warnings) : []).concat([out.note]);
            }
            if (res.candidates.length) {
                fit.dAIC = out.cand && isNum(out.cand.dAIC) ? out.cand.dAIC : 0;
                _lastCandidates = res.candidates.map(function (c) { return { modelKey: c.modelKey, dAIC: c.dAIC }; });
                _lastCandidatesHash = null;
                if (typeof G.PRiSM_datasetHash === 'function') { try { _lastCandidatesHash = G.PRiSM_datasetHash(); } catch (e) {} }
            } else { _lastCandidates = []; _lastCandidatesHash = null; }
            if (!out.committed) commitFit(fit);
            res.fit = getLastFit() || fit;
            var p = res.fit.phys || {}, rp = res.fit.params || {};
            ui.step('refine', res.fit.converged === false ? 'warn' : 'ok',
                (isNum(p.k) ? 'k ' + fmt(p.k) + ' md' : '') + (isNum(p.S) ? ' · S ' + p.S.toFixed(2) : '') +
                (rateOnly && isNum(rp.qi) ? 'q_i ' + fmt(rp.qi) : '') +
                (isNum(res.fit.r2) ? ' · R² ' + res.fit.r2.toFixed(4) : ''));
            return yieldTick();
        }).then(function () {
            ui.step('interp', 'run');
            var it = null;
            if (typeof G.PRiSM_interpretCurrentFit === 'function') {
                try { it = G.PRiSM_interpretCurrentFit(); } catch (e) { it = null; }
            }
            if (it) s.interp = it;
            else if (!s.interp || s.interp._local) s.interp = { headline: localHeadline(res.fit), narrative: localHeadline(res.fit), _local: true };
            ui.step('interp', 'ok', interpHeadline(s.interp).slice(0, 60));
            res.ok = true;
        }).catch(function (e) {
            res.error = (e && e.message) || String(e);
            PROGRESS_STEPS.forEach(function (st2) {
                var row = $('prism_analyse_step_' + st2[0]);
                if (row && /is-run/.test(row.className)) ui.step(st2[0], 'fail', res.error);
            });
        }).then(function () {
            res.elapsedMs = now() - t0;
            _analyseRun = null;
            _batch = Math.max(0, _batch - 1);
            recordSnapshot('analyse');
            setAnalyseBusy(false);
            ui.done(res);
            if (res.ok && opts.goto !== false) gotoStep(4);
            renderRailIfMounted();
            dispatch('prism:analyse-done', { ok: res.ok, error: res.error, modelKey: res.fit && res.fit.modelKey });
            return res;
        });
        return _analyseRun;
    }

    function gotoStep(n) {
        if (typeof G.PRiSM_gotoStep === 'function') { try { G.PRiSM_gotoStep(n); return true; } catch (e) {} }
        var tabFor = { 1: 1, 2: 1, 3: 2, 4: 6, 5: 7 };
        if (G.PRiSM && typeof G.PRiSM.setTab === 'function' && $('prism_tabs')) {
            try { G.PRiSM.setTab(tabFor[n] || 1); return true; } catch (e) {}
        }
        return false;
    }

    // =========================================================================
    // SECTION 7 — STEP ② FLOW PERIODS VIEW
    // =========================================================================

    var PERIOD_FILL = ['rgba(88,166,255,0.10)', 'rgba(63,185,80,0.10)', 'rgba(188,140,255,0.10)', 'rgba(210,153,34,0.10)'];

    function canvasWidth(host) {
        var w = (host && host.clientWidth) || 600;
        var vw = isNum(G.innerWidth) && G.innerWidth > 0 ? G.innerWidth - 32 : w;
        return Math.max(200, Math.min(w, vw, 1100));
    }

    function prepCanvas(canvas, w, h) {
        var ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
        if (!ctx) return null;
        var dpr = G.devicePixelRatio || 1;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        canvas.style.width = '100%';
        canvas.style.maxWidth = w + 'px';
        canvas.style.height = h + 'px';
        if (ctx.setTransform) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return ctx;
    }

    function niceTicks(min, max, count) {
        var span = max - min;
        if (!(span > 0)) return [min];
        var step = Math.pow(10, Math.floor(Math.log10(span / count)));
        var err = span / count / step;
        if (err >= 7.5) step *= 10; else if (err >= 3.5) step *= 5; else if (err >= 1.5) step *= 2;
        var out = [];
        for (var v = Math.ceil(min / step) * step; v <= max + 1e-9 * span; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
        return out;
    }

    function tickLabel(v) {
        var a = Math.abs(v);
        if (a >= 1e4 || (a > 0 && a < 1e-2)) return v.toExponential(0).replace('e+', 'e');
        return String(+v.toPrecision(4));
    }

    // History plot: p (left axis) + q step (right axis) + period bands.
    // data follows the C6 cartesian contract: {t, p, q, periods:[{t0,t1,start,end,q}]}
    function drawHistory(canvas, data, sel, w, h) {
        var ds = data, periods = data.periods || [];
        var ctx = prepCanvas(canvas, w, h);
        if (!ctx) return null;
        var C = {
            bg: cssVar('--bg1', '#0d1117'), grid: cssVar('--border', '#30363d'), text: cssVar('--text2', '#8b949e'),
            p: cssVar('--accent', '#f0883e'), q: cssVar('--blue', '#58a6ff'), sel: 'rgba(240,136,62,0.22)'
        };
        var pad = { l: 52, r: 46, t: 12, b: 28 };
        var plot = { x: pad.l, y: pad.t, w: w - pad.l - pad.r, h: h - pad.t - pad.b };
        ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
        var t = ds.t, p = ds.p, q = isArr(ds.q) ? ds.q : null;
        var tmin = Infinity, tmax = -Infinity, pmin = Infinity, pmax = -Infinity, qmin = 0, qmax = -Infinity;
        for (var i = 0; i < t.length; i++) {
            if (!isNum(t[i])) continue;
            tmin = Math.min(tmin, t[i]); tmax = Math.max(tmax, t[i]);
            if (p && isNum(p[i])) { pmin = Math.min(pmin, p[i]); pmax = Math.max(pmax, p[i]); }
            if (q && isNum(q[i])) { qmin = Math.min(qmin, q[i]); qmax = Math.max(qmax, q[i]); }
        }
        periods.forEach(function (pr) { if (isNum(pr.t0)) tmin = Math.min(tmin, pr.t0); });
        if (!(tmax > tmin)) { tmax = tmin + 1; }
        if (!(pmax > pmin)) { pmax = (isNum(pmax) ? pmax : 1) + 1; pmin = pmax - 2; }
        var pp = 0.06 * (pmax - pmin); pmin -= pp; pmax += pp;
        if (!(qmax > qmin)) qmax = qmin + 1;
        var toX = function (v) { return plot.x + (v - tmin) / (tmax - tmin) * plot.w; };
        var fromX = function (px) { return tmin + (px - plot.x) / plot.w * (tmax - tmin); };
        var toY = function (v) { return plot.y + plot.h - (v - pmin) / (pmax - pmin) * plot.h; };
        var toYq = function (v) { return plot.y + plot.h - (v - qmin) / (qmax - qmin) * plot.h * 0.9; };
        // Period bands
        periods.forEach(function (pr, k) {
            var x0 = toX(pr.t0), x1 = toX(pr.t1);
            ctx.fillStyle = (sel === k) ? C.sel : PERIOD_FILL[k % PERIOD_FILL.length];
            ctx.fillRect(x0, plot.y, Math.max(1, x1 - x0), plot.h);
            if (x1 - x0 > 18) {
                ctx.fillStyle = C.text; ctx.font = '10px sans-serif'; ctx.textAlign = 'left';
                ctx.fillText('#' + (k + 1), x0 + 3, plot.y + 11);
            }
        });
        // Grid + ticks
        ctx.strokeStyle = C.grid; ctx.lineWidth = 1; ctx.font = '10px sans-serif'; ctx.fillStyle = C.text;
        ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);
        ctx.textAlign = 'center';
        niceTicks(tmin, tmax, Math.max(3, Math.floor(plot.w / 80))).forEach(function (v) {
            var x = toX(v);
            ctx.beginPath(); ctx.moveTo(x, plot.y + plot.h); ctx.lineTo(x, plot.y + plot.h + 4); ctx.stroke();
            ctx.fillText(tickLabel(v), x, plot.y + plot.h + 15);
        });
        ctx.fillText('t (hr)', plot.x + plot.w / 2, h - 2);
        ctx.textAlign = 'right';
        niceTicks(pmin, pmax, 4).forEach(function (v) {
            var y = toY(v);
            ctx.beginPath(); ctx.moveTo(plot.x - 4, y); ctx.lineTo(plot.x, y); ctx.stroke();
            ctx.fillText(tickLabel(v), plot.x - 6, y + 3);
        });
        if (q && qmax > qmin) {
            ctx.textAlign = 'left'; ctx.fillStyle = C.q;
            niceTicks(qmin, qmax, 3).forEach(function (v) { ctx.fillText(tickLabel(v), plot.x + plot.w + 5, toYq(v) + 3); });
        }
        // Rate step line
        if (q) {
            ctx.save && ctx.save();
            ctx.strokeStyle = C.q; ctx.lineWidth = 1.5; ctx.beginPath();
            var started = false, lastY = null;
            for (var j = 0; j < t.length; j++) {
                if (!isNum(t[j]) || !isNum(q[j])) continue;
                var x = toX(t[j]), y = toYq(q[j]);
                if (!started) { ctx.moveTo(toX(Math.min(tmin, t[j])), y); started = true; }
                else if (lastY !== y) ctx.lineTo(x, lastY);
                ctx.lineTo(x, y); lastY = y;
            }
            ctx.stroke();
            ctx.restore && ctx.restore();
        }
        // Pressure line
        ctx.strokeStyle = C.p; ctx.lineWidth = 2; ctx.beginPath();
        var first = true;
        for (var k2 = 0; k2 < t.length; k2++) {
            if (!isNum(t[k2]) || !p || !isNum(p[k2])) continue;
            if (first) { ctx.moveTo(toX(t[k2]), toY(p[k2])); first = false; } else ctx.lineTo(toX(t[k2]), toY(p[k2]));
        }
        ctx.stroke();
        ctx.textAlign = 'left'; ctx.fillStyle = C.p; ctx.fillText('p (psia)', plot.x + 4, plot.y + plot.h - 6);
        if (q) { ctx.fillStyle = C.q; ctx.textAlign = 'right'; ctx.fillText('q', plot.x + plot.w - 4, plot.y + plot.h - 6); }
        return { toX: toX, fromX: fromX, plot: plot, tmin: tmin, tmax: tmax };
    }

    // Log-log Δp / Δp′ thumbnail of the extracted period.
    function drawLogLog(canvas, ad, w, h) {
        var ctx = prepCanvas(canvas, w, h);
        if (!ctx) return;
        var C = {
            bg: cssVar('--bg1', '#0d1117'), grid: cssVar('--border', '#30363d'), text: cssVar('--text2', '#8b949e'),
            dp: cssVar('--accent', '#f0883e'), d: cssVar('--blue', '#58a6ff')
        };
        ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
        var pad = { l: 40, r: 10, t: 10, b: 24 };
        var plot = { x: pad.l, y: pad.t, w: w - pad.l - pad.r, h: h - pad.t - pad.b };
        ctx.font = '10px sans-serif';
        if (!ad || !ad.ok || !ad.t || !ad.t.length) {
            ctx.fillStyle = C.text; ctx.textAlign = 'center';
            ctx.fillText((ad && ad.reason) || 'No positive Δp in this period', w / 2, h / 2);
            return;
        }
        var t = ad.t, dp = ad.dp, dv = ad.deriv || [];
        var xs = [], ys = [];
        for (var i = 0; i < t.length; i++) {
            if (t[i] > 0) xs.push(t[i]);
            if (dp[i] > 0) ys.push(dp[i]);
            if (dv[i] > 0) ys.push(dv[i]);
        }
        if (!xs.length || !ys.length) return;
        var lx0 = Math.floor(Math.log10(Math.min.apply(null, xs))), lx1 = Math.ceil(Math.log10(Math.max.apply(null, xs)));
        var ly0 = Math.floor(Math.log10(Math.min.apply(null, ys))), ly1 = Math.ceil(Math.log10(Math.max.apply(null, ys)));
        if (lx1 === lx0) lx1++;
        if (ly1 === ly0) ly1++;
        var toX = function (v) { return plot.x + (Math.log10(v) - lx0) / (lx1 - lx0) * plot.w; };
        var toY = function (v) { return plot.y + plot.h - (Math.log10(v) - ly0) / (ly1 - ly0) * plot.h; };
        ctx.strokeStyle = C.grid; ctx.lineWidth = 1; ctx.fillStyle = C.text;
        ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);
        ctx.textAlign = 'center';
        for (var a = lx0; a <= lx1; a++) {
            var x = toX(Math.pow(10, a));
            ctx.beginPath(); ctx.moveTo(x, plot.y); ctx.lineTo(x, plot.y + plot.h); ctx.stroke();
            ctx.fillText(tickLabel(Math.pow(10, a)), x, plot.y + plot.h + 13);
        }
        ctx.textAlign = 'right';
        for (var b = ly0; b <= ly1; b++) {
            var y = toY(Math.pow(10, b));
            ctx.beginPath(); ctx.moveTo(plot.x, y); ctx.lineTo(plot.x + plot.w, y); ctx.stroke();
            ctx.fillText(tickLabel(Math.pow(10, b)), plot.x - 4, y + 3);
        }
        function dots(arr, color) {
            ctx.fillStyle = color;
            for (var k = 0; k < t.length; k++) {
                if (!(t[k] > 0 && arr[k] > 0)) continue;
                ctx.beginPath();
                ctx.arc(toX(t[k]), toY(arr[k]), 2.2, 0, 2 * Math.PI);
                ctx.fill();
            }
        }
        dots(dp, C.dp);
        dots(dv, C.d);
        ctx.textAlign = 'left'; ctx.fillStyle = C.dp; ctx.fillText('Δp', plot.x + 4, plot.y + 11);
        ctx.fillStyle = C.d; ctx.fillText('Δp′', plot.x + 24, plot.y + 11);
        ctx.fillStyle = C.text; ctx.textAlign = 'center'; ctx.fillText('Δt (hr)', plot.x + plot.w / 2, h - 2);
    }

    function selectPeriod(idx, host) {
        var s = st();
        var next = (idx == null || idx < 0) ? null : idx;
        if (s.activePeriod === next) return;
        s.activePeriod = next;
        saveState();
        dispatch('prism:period-changed', { period: next });
        redraw();
        if (host) PRiSM_renderFlowPeriods(host);
    }

    function wellFieldValue(w, key) {
        var pvt = G.PRiSM_pvt || {};
        var v = isNum(pvt[key]) ? pvt[key] : null;
        if (v == null && w && w.provenance && w.provenance[key] === 'user' && isNum(w[key])) v = w[key];
        return v;
    }

    function PRiSM_renderFlowPeriods(host) {
        host = host || $('prism_step2');   // never default to the whole workspace
        if (!host) return null;
        ensureStyle();
        var s = st();
        var ds = G.PRiSM_dataset;
        if (!ds || !isArr(ds.t) || !ds.t.length) {
            host.innerHTML = '<div class="prism-wf" id="prism_fp_root"><div class="prism-wf-card">' +
                '<div class="prism-wf-title">Flow periods</div>' +
                '<div class="prism-rail-line">No data loaded yet. Load a file or the demo data first.</div>' +
                '<div style="margin-top:10px;"><button type="button" class="prism-btn prism-btn--primary" id="prism_fp_goto_data">Go to step ① Data</button></div>' +
                '</div></div>';
            var gb = $('prism_fp_goto_data');
            if (gb) gb.onclick = function () { gotoStep(1); };
            return null;
        }
        var periods = getPeriods(ds);
        var sel = activePeriod();
        if (sel != null && !periods[sel]) sel = null;
        var well = getWell(ds);
        var ad = getAnalysisData(sel == null ? {} : { period: sel });
        s.periodFlags = (s.periodFlags && typeof s.periodFlags === 'object') ? s.periodFlags : {};
        var autoTShut = ad && ad.ok && isNum(ad.tShut) ? ad.tShut : null;
        var autoTp = ad && ad.ok && isNum(ad.tp) ? ad.tp : null;
        var tShutV = wellFieldValue(well, 'tShut'), tpV = wellFieldValue(well, 'tp');

        var rowsHtml = periods.map(function (pr, k) {
            var flags = s.periodFlags[k] || {};
            return '<tr data-period="' + k + '" class="' + (sel === k ? 'is-active' : '') + '">' +
                '<td><input type="radio" name="prism_fp_sel" id="prism_fp_sel_' + k + '" aria-label="Analyse period ' + (k + 1) + '"' + (sel === k ? ' checked' : '') + '></td>' +
                '<td>#' + (k + 1) + '</td>' +
                '<td>' + esc(pr.type) + '</td>' +
                '<td class="num">' + esc(fmt(pr.t0, 4)) + '</td>' +
                '<td class="num">' + esc(fmt(pr.t1, 4)) + '</td>' +
                '<td class="num">' + (isNum(pr.q) ? esc(fmt(pr.q, 4)) : '—') + '</td>' +
                '<td><input type="checkbox" id="prism_fp_ovl_' + k + '" aria-label="Overlay period ' + (k + 1) + '"' + (flags.overlay ? ' checked' : '') + '></td>' +
                '</tr>';
        }).join('');

        var adLine = ad && ad.ok
            ? fmt(ad.n) + ' points · Δt ' + fmt(ad.t[0], 2) + '–' + fmt(ad.t[ad.t.length - 1], 3) + ' h · ' +
              esc(ad.testType || '') + ' · p_ref ' + fmt(ad.pRef, 5) + ' psia (' + esc(ad.pRefSource || '?') + ')'
            : esc((ad && ad.reason) || 'Nothing to analyse in this period.');

        host.innerHTML =
            '<div class="prism-wf" id="prism_fp_root">' +
              '<div class="prism-wf-card">' +
                '<div class="prism-wf-title">Rate &amp; pressure history</div>' +
                '<canvas id="prism_fp_history" role="img" aria-label="Pressure and rate history with flow-period bands"></canvas>' +
                '<div class="prism-wf-hint">Tap a period band or a table row to choose the period to analyse.</div>' +
              '</div>' +
              '<div class="prism-wf-grid">' +
                '<div class="prism-wf-card">' +
                  '<div class="prism-wf-title">Flow periods (' + periods.length + ')</div>' +
                  '<div class="prism-fp-tablewrap"><table class="prism-fp-table" id="prism_fp_table">' +
                    '<thead><tr><th>Analyse</th><th>#</th><th>Type</th><th>Start (h)</th><th>End (h)</th><th>Rate</th><th>Overlay</th></tr></thead>' +
                    '<tbody>' + rowsHtml + '</tbody></table></div>' +
                  '<div style="margin-top:8px; display:flex; flex-wrap:wrap; gap:8px;">' +
                    '<button type="button" class="prism-btn prism-btn--small" id="prism_fp_all"' + (sel == null ? ' disabled' : '') + '>Use all data</button>' +
                    '<button type="button" class="prism-btn prism-btn--small" id="prism_fp_crop">Crop data…</button>' +
                  '</div>' +
                '</div>' +
                '<div class="prism-wf-card">' +
                  '<div class="prism-wf-title">Shut-in &amp; producing time</div>' +
                  '<div class="prism-fp-inputs">' +
                    '<label for="prism_fp_tshut">Shut-in time (h)<input type="number" inputmode="decimal" step="any" id="prism_fp_tshut" value="' + (isNum(tShutV) ? tShutV : '') + '" placeholder="' + (isNum(autoTShut) ? 'auto: ' + fmt(autoTShut, 4) : 'auto') + '"></label>' +
                    '<label for="prism_fp_tp">Producing time t_p (h)<input type="number" inputmode="decimal" step="any" id="prism_fp_tp" value="' + (isNum(tpV) ? tpV : '') + '" placeholder="' + (isNum(autoTp) ? 'auto: ' + fmt(autoTp, 4) : 'auto') + '"></label>' +
                  '</div>' +
                  '<div class="prism-wf-hint">Leave blank to use the values derived from the rate history.</div>' +
                  '<div class="prism-wf-title" style="margin-top:12px;">Log-log preview</div>' +
                  '<canvas id="prism_fp_preview" role="img" aria-label="Log-log preview of the selected period"></canvas>' +
                  '<div class="prism-wf-hint" id="prism_fp_preview_info">' + adLine + '</div>' +
                '</div>' +
              '</div>' +
            '</div>';

        // Plots
        var hc = $('prism_fp_history');
        var W = canvasWidth(host);
        var tr = null;
        if (hc) {
            var c6 = { t: ds.t, p: ds.p, q: isArr(ds.q) ? ds.q : null, periods: periods };
            try { tr = drawHistory(hc, c6, sel, W, 220); } catch (e) { tr = null; }
            if (tr) hc._prismAxes = { toX: tr.toX, fromX: tr.fromX, plot: tr.plot, scaleX: { min: tr.tmin, max: tr.tmax, kind: 'lin' }, plotKey: 'history' };
            hc.addEventListener('click', function (ev) {
                if (!tr || !ev || !isNum(ev.clientX)) return;
                var rect = hc.getBoundingClientRect ? hc.getBoundingClientRect() : { left: 0, width: W };
                var scale = rect.width > 0 ? (W / rect.width) : 1;
                var tt = tr.fromX((ev.clientX - rect.left) * scale);
                for (var k = 0; k < periods.length; k++) {
                    if (tt >= periods[k].t0 && tt <= periods[k].t1) { selectPeriod(k, host); return; }
                }
            });
        }
        var pc = $('prism_fp_preview');
        if (pc) { try { drawLogLog(pc, ad, Math.min(W, 520), 180); } catch (e) {} }

        // Table
        var tbody = q1(host, '#prism_fp_table tbody');
        var trs = tbody && tbody.querySelectorAll ? tbody.querySelectorAll('tr[data-period]') : [];
        for (var i = 0; i < trs.length; i++) {
            (function (row) {
                var k = parseInt(row.getAttribute('data-period'), 10);
                row.onclick = function () { selectPeriod(k, host); };
                var ov = $('prism_fp_ovl_' + k);
                if (ov) {
                    ov.onclick = function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); };
                    ov.onchange = function () {
                        var f = s.periodFlags[k] || {};
                        f.overlay = !!ov.checked;
                        s.periodFlags[k] = f;
                        saveState();
                        dispatch('prism:period-flags-changed', { period: k, flags: clone(f) });
                    };
                }
                var rb = $('prism_fp_sel_' + k);
                if (rb) rb.onchange = function () { if (rb.checked) selectPeriod(k, host); };
            })(trs[i]);
        }
        var all = $('prism_fp_all');
        if (all) all.onclick = function () { selectPeriod(null, host); };
        var crop = $('prism_fp_crop');
        if (crop) crop.onclick = function () { PRiSM_openTools('crop'); };

        function bindTime(id, key) {
            var inp = $(id);
            if (!inp) return;
            inp.onchange = function () {
                var raw = String(inp.value == null ? '' : inp.value).trim();
                var v = raw === '' ? null : parseFloat(raw);
                if (v != null && !(isNum(v) && v >= 0)) return;
                var patch = {}; patch[key] = v;
                setWell(patch, 'user');
                PRiSM_renderFlowPeriods(host);
            };
        }
        bindTime('prism_fp_tshut', 'tShut');
        bindTime('prism_fp_tp', 'tp');
        return { periods: periods, selected: sel, analysis: ad };
    }

    // =========================================================================
    // SECTION 8 — TOOLS DRAWER (every advanced panel reachable)
    // =========================================================================

    var TOOL_CATALOGUE = [
        { id: 'pvt',         fn: 'PRiSM_renderPVTPanel',            group: 'Data',     title: 'Well & fluid properties',          sub: 'PVT correlations and dimensional inputs' },
        { id: 'cleanup',     fn: 'PRiSM_renderCleanupPanel',        group: 'Data',     title: 'Data cleanup',                     sub: 'Filters, outliers and resampling' },
        { id: 'crop',        fn: 'PRiSM_renderCropTool',            group: 'Data',     title: 'Crop data',                        sub: 'Trim the record interactively' },
        { id: 'tide',        fn: 'PRiSM_renderTidePanel',           group: 'Data',     title: 'Tide correction',                  sub: 'Remove tidal signal from offshore gauges' },
        { id: 'gauges',      fn: 'PRiSM_renderGaugeManager',        group: 'Data',     title: 'Gauges',                           sub: 'Manage gauge channels' },
        { id: 'datasets',    fn: 'PRiSM_renderAnalysisManager',     group: 'Data',     title: 'Analysis datasets',                sub: 'Switch between saved analysis sets' },
        { id: 'project',     fn: 'PRiSM_renderProjectToolbar',      group: 'Data',     title: 'Project files',                    sub: 'Open or save a .prism project' },
        { id: 'semilog',     fn: 'PRiSM_renderSemilogPanel',        group: 'Diagnose', title: 'Semilog & skin analysis',          sub: 'Straight-line k, skin, p*, FE' },
        { id: 'annotations', fn: 'PRiSM_renderAnnotationToolbar',   group: 'Diagnose', title: 'Flow-regime markers',              sub: 'Auto-detected regimes and smoothing' },
        { id: 'keys',        fn: 'PRiSM_renderAnalysisKeyToolbar',  group: 'Diagnose', title: 'Pick on plot',                     sub: 'Click the plot to estimate kh, xf, distances', args: function () { return [st().activePlot || 'bourdet']; } },
        { id: 'deconv',      fn: 'PRiSM_renderDeconvolutionPanel',  group: 'Diagnose', title: 'Combine periods (deconvolution)',  sub: 'Constant-rate response from multi-rate data' },
        { id: 'overlays',    fn: 'PRiSM_renderOverlayManager',      group: 'Plot',     title: 'Plot overlays',                    sub: 'Compare datasets and periods on one plot' },
        { id: 'diff',        fn: 'PRiSM_renderDiffPicker',          group: 'Plot',     title: 'Difference plot',                  sub: 'Subtract two datasets' },
        { id: 'clipboard',   fn: 'PRiSM_renderClipboardToolbar',    group: 'Plot',     title: 'Copy & export',                    sub: 'Clipboard, CSV and XML export' },
        { id: 'automatch',   fn: 'PRiSM_renderAutoMatchPanel',      group: 'Model',    title: 'Model race',                       sub: 'Rank candidate models by AIC' },
        { id: 'usercurves',  fn: 'PRiSM_renderUserCurveManager',    group: 'Model',    title: 'User-defined type curves',         sub: 'Import your own pD / pD′ curves' },
        { id: 'interp',      fn: 'PRiSM_renderInterpretationPanel', group: 'Model',    title: 'Interpretation',                   sub: 'Plain-language narrative of the fit', args: function () { return [st().interp || undefined]; } },
        { id: 'plt',         fn: 'PRiSM_renderPLTPanel',            group: 'Model',    title: 'Layer contributions',              sub: 'Synthetic production log by layer' },
        { id: 'inverse',     fn: 'PRiSM_renderInverseSimPanel',     group: 'Model',    title: 'Rate from pressure',               sub: 'Invert the rate history from gauge pressure' },
        { id: 'decline',     fn: 'PRiSM_renderDeclineResultsPanel', group: 'Model',    title: 'Decline results & EUR',            sub: 'Forecast, EUR and P10/P50/P90' }
    ];
    // Words that identify a C7 tab panel as one of the catalogue tools (no duplicates in the drawer).
    var PANEL_SYNONYMS = [
        ['deconv', 'deconv'], ['semilog', 'semilog'], ['straight-line', 'semilog'], ['straight line', 'semilog'],
        ['tide', 'tide'], ['interpret', 'interp'], ['crop', 'crop'], ['gauge', 'gauges'], ['overlay', 'overlays'],
        ['auto-match', 'automatch'], ['automatch', 'automatch'], ['model race', 'automatch'], ['plt', 'plt'],
        ['inverse', 'inverse'], ['decline', 'decline'], ['annotation', 'annotations'], ['regime', 'annotations'],
        ['analysis key', 'keys'], ['pick on plot', 'keys'], ['clipboard', 'clipboard'], ['cleanup', 'cleanup'],
        ['user curve', 'usercurves'], ['user-defined', 'usercurves'], ['pvt', 'pvt']
    ];
    var EXCLUDE_DISCOVERY = /^PRiSM_render(Rail|FlowPeriods|DataTabEnhanced|Tab[A-Za-z]*|[A-Za-z]*Tab)$/;

    function humanise(fn) {
        var s = String(fn).replace(/^PRiSM_render/, '').replace(/(Panel|Manager|Toolbar|Tool|Picker)$/, function (m) { return ' ' + m; });
        s = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim().toLowerCase();
        return s.charAt(0).toUpperCase() + s.slice(1);
    }

    function listTools() {
        var out = [], seen = {};
        TOOL_CATALOGUE.forEach(function (t) {
            seen[t.fn] = true;
            out.push({ id: t.id, title: t.title, sub: t.sub, group: t.group, fn: t.fn, args: t.args, available: typeof G[t.fn] === 'function' });
        });
        // Discover any other exported panel renderer so nothing is orphaned.
        var keys = [];
        try { for (var k in G) keys.push(k); } catch (e) {}
        try { Object.getOwnPropertyNames(G).forEach(function (k) { if (keys.indexOf(k) === -1) keys.push(k); }); } catch (e) {}
        keys.sort().forEach(function (k) {
            if (seen[k]) return;
            if (!/^PRiSM_render[A-Za-z0-9_]*(Panel|Manager|Toolbar|Tool|Picker)$/.test(k)) return;
            if (EXCLUDE_DISCOVERY.test(k)) return;
            var f;
            try { f = G[k]; } catch (e) { f = null; }
            if (typeof f !== 'function') return;
            seen[k] = true;
            out.push({ id: 'fn:' + k, title: humanise(k), sub: '', group: 'More', fn: k, available: true });
        });
        // C7 panels registered on the step tabs.
        var reg = G.PRiSM_tabPanels;
        if (reg && typeof reg === 'object') {
            var titles = {};
            out.forEach(function (t) { titles[String(t.title).toLowerCase()] = true; });
            Object.keys(reg).forEach(function (n) {
                var arr = reg[n];
                if (!isArr(arr)) return;
                toArr(arr).forEach(function (spec) {
                    if (!spec || typeof spec.render !== 'function') return;
                    var title = String(spec.title || spec.id || 'Panel');
                    var hay = (String(spec.id || '') + ' ' + title).toLowerCase();
                    var dup = titles[title.toLowerCase()] || out.some(function (t) { return typeof G[t.fn] === 'function' && G[t.fn] === spec.render; }) ||
                        PANEL_SYNONYMS.some(function (sy) {
                            if (hay.indexOf(sy[0]) === -1) return false;
                            return out.some(function (t) { return t.id === sy[1] && t.available; });
                        });
                    if (dup) return;
                    titles[title.toLowerCase()] = true;
                    out.push({ id: 'tab' + n + ':' + (spec.id || title), title: title, sub: 'Also shown on tab ' + n, group: 'Step panels', render: spec.render, available: true });
                });
            });
        }
        return out;
    }

    function closeTools() {
        var d = $('prism_tools_drawer'), b = $('prism_tools_backdrop');
        if (d && d.parentNode) d.parentNode.removeChild(d);
        if (b && b.parentNode) b.parentNode.removeChild(b);
        var btn = $('prism_tools_btn');
        if (btn && btn.setAttribute) btn.setAttribute('aria-expanded', 'false');
        dispatch('prism:tools-closed', {});
    }

    function openToolIn(item, host, titleEl) {
        host.innerHTML = '';
        if (titleEl) titleEl.textContent = item.title;
        var inner = D.createElement('div');
        inner.id = 'prism_tools_panel';
        inner.className = 'prism-tools-panel';
        host.appendChild(inner);
        try {
            if (item.render) item.render(inner);
            else {
                var f = G[item.fn];
                if (typeof f !== 'function') throw new Error('This tool is not loaded in this build.');
                var args = [inner].concat(item.args ? item.args() : []);
                f.apply(G, args);
            }
            if (!inner.innerHTML || !String(inner.innerHTML).trim()) {
                inner.innerHTML = '<div class="prism-rail-line">Nothing to show yet — load data first.</div>';
            }
        } catch (e) {
            inner.innerHTML = '<div class="prism-rail-warn prism-rail-warn--bad"><span>' + esc(item.title) + ' could not open: ' + esc(e && e.message) + '</span></div>';
        }
        dispatch('prism:tool-opened', { id: item.id });
    }

    function PRiSM_openTools(toolId) {
        if (!D || !D.createElement || !D.body) return null;
        ensureStyle();
        closeTools();
        var tools = listTools().filter(function (t) { return t.available; });
        var back = D.createElement('div');
        back.id = 'prism_tools_backdrop';
        back.className = 'prism-drawer-backdrop';
        back.onclick = closeTools;
        var dr = D.createElement('div');
        dr.id = 'prism_tools_drawer';
        dr.className = 'prism-drawer';
        dr.setAttribute('role', 'dialog');
        dr.setAttribute('aria-modal', 'true');
        dr.setAttribute('aria-labelledby', 'prism_tools_title');
        var groups = [], byGroup = {};
        tools.forEach(function (t) {
            if (!byGroup[t.group]) { byGroup[t.group] = []; groups.push(t.group); }
            byGroup[t.group].push(t);
        });
        var list = groups.map(function (g) {
            return '<div class="prism-tool-group">' + esc(g) + '</div>' + byGroup[g].map(function (t) {
                return '<button type="button" class="prism-tool-item" data-tool="' + esc(t.id) + '">' + esc(t.title) +
                    (t.sub ? '<small>' + esc(t.sub) + '</small>' : '') + '</button>';
            }).join('');
        }).join('');
        dr.innerHTML =
            '<div class="prism-drawer-head">' +
              '<button type="button" class="prism-btn prism-btn--small" id="prism_tools_back" style="display:none;" aria-label="Back to the tool list">‹ Tools</button>' +
              '<h3 id="prism_tools_title">Tools</h3>' +
              '<button type="button" class="prism-btn prism-btn--small" id="prism_tools_close" aria-label="Close tools">✕</button>' +
            '</div>' +
            '<div class="prism-drawer-body">' +
              '<div id="prism_tools_listwrap">' +
                '<input type="search" class="prism-drawer-search" id="prism_tools_search" placeholder="Find a tool…" aria-label="Find a tool">' +
                '<div id="prism_tools_list">' + (list || '<div class="prism-rail-line">No advanced tools are loaded.</div>') + '</div>' +
              '</div>' +
              '<div id="prism_tools_host" style="display:none;"></div>' +
            '</div>';
        D.body.appendChild(back);
        D.body.appendChild(dr);
        var btn = $('prism_tools_btn');
        if (btn && btn.setAttribute) btn.setAttribute('aria-expanded', 'true');

        var host = $('prism_tools_host'), listWrap = $('prism_tools_listwrap');
        var titleEl = $('prism_tools_title'), backBtn = $('prism_tools_back');
        function showList() {
            host.innerHTML = '';
            host.style.display = 'none';
            listWrap.style.display = '';
            backBtn.style.display = 'none';
            titleEl.textContent = 'Tools';
        }
        function showTool(id) {
            var item = null;
            for (var i = 0; i < tools.length; i++) if (tools[i].id === id) item = tools[i];
            if (!item) return false;
            listWrap.style.display = 'none';
            host.style.display = '';
            backBtn.style.display = '';
            openToolIn(item, host, titleEl);
            return true;
        }
        $('prism_tools_close').onclick = closeTools;
        backBtn.onclick = showList;
        var items = dr.querySelectorAll('[data-tool]');
        for (var i = 0; i < items.length; i++) {
            (function (b) { b.onclick = function () { showTool(b.getAttribute('data-tool')); }; })(items[i]);
        }
        var search = $('prism_tools_search');
        if (search) {
            search.oninput = function () {
                var qv = String(search.value || '').toLowerCase().trim();
                for (var j = 0; j < items.length; j++) {
                    var txt = String(items[j].textContent || '').toLowerCase();
                    items[j].style.display = (!qv || txt.indexOf(qv) !== -1) ? '' : 'none';
                }
            };
        }
        dr.onkeydown = function (ev) { if (ev && ev.key === 'Escape') closeTools(); };
        if (toolId) showTool(toolId);
        dispatch('prism:tools-opened', { tool: toolId || null });
        return dr;
    }

    // =========================================================================
    // SECTION 9 — UNDO / REDO (state snapshots, cap 50)
    // =========================================================================

    var UNDO_CAP = 50;
    var _undo = [], _redo = [], _cur = null, _restoring = false, _batch = 0;

    function snapObject() {
        var s = st(), pvt = G.PRiSM_pvt, well = null;
        if (pvt && typeof pvt === 'object') {
            well = {};
            for (var k in pvt) if (k !== '_computed' && Object.prototype.hasOwnProperty.call(pvt, k)) well[k] = pvt[k];
        }
        return {
            model: s.model == null ? null : s.model,
            params: s.params || {},
            paramFreeze: s.paramFreeze || {},
            phys: s.phys || null,
            lastFit: s.lastFit || null,
            tcMatch: s.tcMatch || null,
            activePeriod: activePeriod(),
            well: well
        };
    }
    function snapString() {
        try { return JSON.stringify(snapObject()); } catch (e) { return null; }
    }

    function syncUndoButtons() {
        var u = $('prism_undo'), r = $('prism_redo');
        if (u) { u.disabled = !_undo.length; u.title = _undo.length ? 'Undo (' + _undo.length + ')' : 'Nothing to undo'; }
        if (r) { r.disabled = !_redo.length; r.title = _redo.length ? 'Redo (' + _redo.length + ')' : 'Nothing to redo'; }
    }

    function recordSnapshot(reason) {
        if (_restoring || _batch > 0) return false;
        var s = snapString();
        if (s == null || s === _cur) return false;
        if (_cur != null) {
            _undo.push(_cur);
            if (_undo.length > UNDO_CAP) _undo.shift();
        }
        _redo.length = 0;
        _cur = s;
        syncUndoButtons();
        return true;
    }

    function restoreSnapshot(str) {
        var o;
        try { o = JSON.parse(str); } catch (e) { return false; }
        var s = st();
        _restoring = true;
        try {
            if (o.model != null && s.model !== o.model) s.model = o.model;   // plain assignment keeps the snapshot params
            s.params = o.params || {};
            s.paramFreeze = o.paramFreeze || {};
            s.phys = o.phys || null;
            s.lastFit = o.lastFit || null;
            s.tcMatch = o.tcMatch || null;
            s.activePeriod = o.activePeriod == null ? null : o.activePeriod;
            s.modelCurve = null;
            if (o.well && typeof o.well === 'object') {
                var pvt = G.PRiSM_pvt || (G.PRiSM_pvt = {});
                Object.keys(pvt).forEach(function (k) { if (k !== '_computed' && !(k in o.well)) delete pvt[k]; });
                Object.keys(o.well).forEach(function (k) { pvt[k] = o.well[k]; });
                if (typeof G.PRiSM_pvt_compute === 'function') { try { G.PRiSM_pvt_compute(); } catch (e) {} }
                persistPvt();
            }
            if (s.lastFit && typeof G.PRiSM_interpretCurrentFit === 'function') {
                try { s.interp = G.PRiSM_interpretCurrentFit() || null; } catch (e) {}
            } else if (!s.lastFit) s.interp = null;
            if (typeof G.PRiSM_evalModelCurve === 'function') { try { G.PRiSM_evalModelCurve(s.model, s.params); } catch (e) {} }
            saveState();
            dispatch('prism:model-changed', { source: 'undo', modelKey: s.model });
            dispatch('prism:well-changed', { source: 'undo' });
            dispatch('prism:period-changed', { source: 'undo', period: s.activePeriod });
            dispatch('prism:fit-updated', { source: 'undo' });
        } finally {
            _restoring = false;
        }
        redraw();
        // Re-render the visible tab so its inputs show the restored values.
        try {
            var tab = G.PRiSM && G.PRiSM.tab;
            var rt = (typeof PRiSM_renderTab === 'function') ? PRiSM_renderTab : G.PRiSM_renderTab;   // eslint-disable-line no-undef
            if (tab && typeof rt === 'function' && $('prism_tab_' + tab)) rt(tab);
        } catch (e) {}
        renderRailIfMounted();
        syncUndoButtons();
        return true;
    }

    function PRiSM_undo() {
        if (!_undo.length) return false;
        var prev = _undo.pop();
        if (_cur != null) _redo.push(_cur);
        _cur = prev;
        return restoreSnapshot(prev);
    }

    function PRiSM_redo() {
        if (!_redo.length) return false;
        var nxt = _redo.pop();
        if (_cur != null) { _undo.push(_cur); if (_undo.length > UNDO_CAP) _undo.shift(); }
        _cur = nxt;
        return restoreSnapshot(nxt);
    }

    function isEditable(el) {
        if (!el) return false;
        var tag = String(el.tagName || '').toLowerCase();
        return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
    }

    function installListeners() {
        if (typeof G.addEventListener !== 'function' || G.__PRiSM_wfListeners) return;
        G.__PRiSM_wfListeners = true;
        ['prism:fit-updated', 'prism:model-changed', 'prism:well-changed', 'prism:period-changed'].forEach(function (type) {
            G.addEventListener(type, function (ev) {
                var src = ev && ev.detail && ev.detail.source;
                if (src === 'undo') return;
                recordSnapshot(type);
            });
        });
        // A new fit (type-curve Apply, regression), dataset or project makes the
        // Analyse panel's summary stale: close it (no-op while a run is going).
        ['prism:fit-updated', 'prism:dataset-loaded', 'prism:dataset-cleared'].forEach(function (type) {
            G.addEventListener(type, function () { hideProgress(); });
        });
        // The race ranking (rail ΔAIC line) belongs to the data it was run on.
        ['prism:dataset-loaded', 'prism:dataset-cleared', 'prism:period-changed'].forEach(function (type) {
            G.addEventListener(type, function () { _lastCandidates = []; _lastCandidatesHash = null; });
        });
        if (D && typeof D.addEventListener === 'function') {
            // Bottom sheet: Escape or a tap outside it collapses the expanded sheet.
            D.addEventListener('keydown', function (ev) {
                if (ev && (ev.key === 'Escape' || ev.key === 'Esc') && _sheetExpanded) {
                    var r = $('prism_rail');
                    if (r && r.classList && r.classList.contains('prism-rail--sheet') && collapseSheet() && ev.preventDefault) ev.preventDefault();
                }
            });
            D.addEventListener('click', function (ev) {
                if (!_sheetExpanded) return;
                var wrap = $('prism_railwrap') || $('prism_rail');
                var r = $('prism_rail');
                if (!wrap || !r || !r.classList || !r.classList.contains('prism-rail--sheet')) return;
                var t = ev && ev.target;
                if (t && typeof wrap.contains === 'function' && !wrap.contains(t) && (!D.body || D.body.contains(t))) collapseSheet();
            }, true);
            if (typeof G.addEventListener === 'function') {
                G.addEventListener('resize', function () {
                    var r = $('prism_rail');
                    if (_sheetExpanded && r && r.classList && r.classList.contains('prism-rail--sheet')) fitSheet(r);
                });
            }
            D.addEventListener('keydown', function (ev) {
                if (!ev || !(ev.ctrlKey || ev.metaKey) || isEditable(ev.target)) return;
                if (!$('prism_steps') && !$('prism_tabs')) return;   // only while PRiSM is on screen
                var k = String(ev.key || '').toLowerCase();
                var did = false;
                if (k === 'z' && !ev.shiftKey) did = PRiSM_undo();
                else if (k === 'y' || (k === 'z' && ev.shiftKey)) did = PRiSM_redo();
                if (did && ev.preventDefault) ev.preventDefault();
            });
        }
    }

    // =========================================================================
    // SECTION 10 — EXPORTS
    // =========================================================================

    G.PRiSM_renderRail = PRiSM_renderRail;
    G.PRiSM_railInfo = railInfo;
    G.PRiSM_analyse = PRiSM_analyse;
    G.PRiSM_renderFlowPeriods = PRiSM_renderFlowPeriods;
    G.PRiSM_stepViews = G.PRiSM_stepViews || {};
    G.PRiSM_stepViews[2] = PRiSM_renderFlowPeriods;
    G.PRiSM_openTools = PRiSM_openTools;
    G.PRiSM_closeTools = closeTools;
    G.PRiSM_listTools = listTools;
    G.PRiSM_undo = PRiSM_undo;
    G.PRiSM_redo = PRiSM_redo;
    G.PRiSM_canUndo = function () { return _undo.length > 0; };
    G.PRiSM_canRedo = function () { return _redo.length > 0; };
    G.PRiSM_recordSnapshot = recordSnapshot;
    G.PRiSM_getReportPins = function () { return clone(isArr(st().reportPins) ? st().reportPins : []); };
    // Internal helpers, exposed for tests and for other layers' fallbacks.
    G.PRiSM_workflow = {
        getWell: getWell, getAnalysisData: getAnalysisData, getPeriods: getPeriods,
        localFit: localFit, lm: lm, fmt: fmt, snapshot: snapObject,
        undoDepth: function () { return { undo: _undo.length, redo: _redo.length }; },
        _resetHistory: function () { _undo.length = 0; _redo.length = 0; _cur = snapString(); syncUndoButtons(); }
    };

    installListeners();
    _cur = snapString();   // baseline for the first undo step

})();

// === SELF-TEST ===
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var W = G.PRiSM_workflow;
    var checks = [];
    function check(name, fn) {
        try { var ok = fn(); checks.push({ name: name, ok: !!ok }); } catch (e) { checks.push({ name: name, ok: false, err: e && e.message }); }
    }
    check('exports present', function () {
        return typeof G.PRiSM_renderRail === 'function' && typeof G.PRiSM_analyse === 'function' &&
            typeof G.PRiSM_openTools === 'function' && typeof G.PRiSM_undo === 'function' &&
            typeof G.PRiSM_redo === 'function' && typeof G.PRiSM_stepViews[2] === 'function';
    });
    check('fmt', function () {
        return W.fmt(45.0012) === '45.0' && W.fmt(1575) === '1,575' && W.fmt(8.48e-4) === '8.48e-4' && W.fmt(120) === '120' && W.fmt(NaN) === '—';
    });
    check('LM recovers y = a·exp(b·x)', function () {
        var xs = [], ys = [];
        for (var i = 0; i < 30; i++) { xs.push(i / 10); ys.push(2.5 * Math.exp(-0.7 * i / 10)); }
        var f = W.lm(function (p) { return xs.map(function (x, k) { return p[0] * Math.exp(p[1] * x) - ys[k]; }); },
            [1, 0], [-10, -10], [10, 10], 100);
        return Math.abs(f.x[0] - 2.5) < 1e-6 && Math.abs(f.x[1] + 0.7) < 1e-6 && f.converged;
    });
    check('local periods: drawdown then buildup', function () {
        var prev = G.PRiSM_dataset;
        G.PRiSM_dataset = { t: [1, 2, 3, 4, 5, 6], p: [10, 9, 8, 9, 9.5, 9.8], q: [100, 100, 100, 0, 0, 0] };
        var p = W.getPeriods();
        G.PRiSM_dataset = prev;
        return p.length === 2 && p[0].type === 'Drawdown' && p[1].type === 'Buildup' && p[1].t0 === 3 && p[1].t1 === 6;
    });
    check('undo / redo round-trip', function () {
        W._resetHistory();
        var s = G.PRiSM_state;
        s.model = 'homogeneous'; s.params = { Cd: 100, S: 0 };
        G.PRiSM_recordSnapshot('t1');
        s.params = { Cd: 80, S: 2.5 };
        G.PRiSM_recordSnapshot('t2');
        s.model = 'infiniteFrac';
        G.PRiSM_recordSnapshot('t3');
        var ok1 = G.PRiSM_undo() && s.model === 'homogeneous' && s.params.S === 2.5;
        var ok2 = G.PRiSM_undo() && s.params.S === 0;
        var ok3 = G.PRiSM_redo() && s.params.S === 2.5;
        W._resetHistory();
        return ok1 && ok2 && ok3;
    });
    var pass = checks.filter(function (c) { return c.ok; }).length;
    var msg = '[PRiSM-workflow self-test] ' + pass + '/' + checks.length + ' passed';
    if (pass !== checks.length) {
        checks.filter(function (c) { return !c.ok; }).forEach(function (c) { msg += '\n  FAIL ' + c.name + (c.err ? ' — ' + c.err : ''); });
        if (typeof console !== 'undefined') console.warn(msg);
    } else if (typeof console !== 'undefined') console.log(msg);
    G.PRiSM_workflow_selfTest = checks;
})();
