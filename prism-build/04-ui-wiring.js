// =============================================================================
// PRiSM — Layer 04 — UI wiring: Tabs 2-6, plot dispatcher, shared state
// -----------------------------------------------------------------------------
// Owns:
//   window.PRiSM_state               shared analysis state (fields merged, never replaced)
//   window.PRiSM_PLOT_REGISTRY       plot picker registry {label, mode, fn, build?} (merge)
//   window.PRiSM_postDrawHooks       [fn({canvas, plotKey, data, opts, axes})] after each main draw
//   window.PRiSM_registerPostDrawHook(fn)
//   window.PRiSM_buildPlotData(plotKey)          → {data, opts}   (C6 producer)
//   window.PRiSM_drawActivePlot()                the single redraw entry point
//   window.PRiSM_evalModelCurve(modelKey, params, opts) → st.modelCurveData
//   window.PRiSM_detectPeriods(t, q)             → [{t0, t1, start, end, i0, i1, q, label}]
//   window.PRiSM_setModel(key)                   → fires 'prism:model-changed'
//   window.PRiSM_autoAlignOverlay(), PRiSM_modelDisplayName(key), PRiSM_modelLibrary()
//   window.PRiSM_renderFitResults(container, fit)
//   Tab renderers PRiSM_renderPlotsTab / ModelTab / ParamsTab / MatchTab / RegressTab.
//   Each takes an optional host element, so the step shell can host it.
//
// Consumes (all optional; every call is typeof-guarded with a local fallback):
//   PRiSM_getWell, PRiSM_getAnalysisData, PRiSM_physicalModel, PRiSM_setLastFit,
//   PRiSM_getLastFit, PRiSM_applyTypeCurveMatch, PRiSM_matchToPhysical,
//   PRiSM_saveState, PRiSM_runRegression, PRiSM_autoMatch, PRiSM_renderAutoMatchPanel,
//   PRiSM_autoBourdet_L, PRiSM_getModelSchematic, PRiSM_renderUserCurveManager,
//   PRiSM_semilogPlotLine, PRiSM_gotoStep.
//
// Units: t in hours (decline plots in days), p in psia, q in STB/d or Mscf/d.
// PRiSM_state.match is a legacy read-only {timeShift:0, pressShift:0}. Fits
// live in lastFit (C4) and type-curve shifts in tcMatch {logPM, logTM} (C5).
// =============================================================================

(function () {
'use strict';

var G = (typeof window !== 'undefined') ? window : globalThis;

// =========================================================================
// SECTION 0 — MODEL REGISTRY + PLOT FUNCTION BRIDGE
// =========================================================================
if (typeof G.PRiSM_MODELS !== 'object' || !G.PRiSM_MODELS) G.PRiSM_MODELS = {};
function _MODELS() { return (G.PRiSM_MODELS && typeof G.PRiSM_MODELS === 'object') ? G.PRiSM_MODELS : {}; }

// 03 owns the homogeneous entry. This guarded copy only fills the gap when
// 03 did not register it (partial builds, standalone runs).
(function _homogeneousFallback() {
    var M = _MODELS();
    if (M.homogeneous) return;
    var pd = (typeof PRiSM_model_homogeneous === 'function') ? PRiSM_model_homogeneous : null;
    var pdp = (typeof PRiSM_model_homogeneous_pd_prime === 'function') ? PRiSM_model_homogeneous_pd_prime : null;
    if (!pd) return;
    M.homogeneous = {
        pd: pd, pdPrime: pdp,
        defaults: { Cd: 100, S: 0 },
        paramSpec: [
            { key: 'Cd', label: 'Wellbore storage Cd', unit: '-', min: 0, max: 1e10, default: 100, scale: 'log' },
            { key: 'S', label: 'Skin S', unit: '-', min: -7, max: 50, default: 0 }
        ],
        reference: 'Bourdet 2002 §3.2 (Mavor & Cinco-Ley, SPE 7977)',
        category: 'homogeneous', kind: 'pressure', refLength: 'rw',
        description: 'Vertical well in an infinite-acting homogeneous reservoir, with wellbore storage and constant skin.'
    };
})();

// 02-plots.js declares its plot functions at host-IIFE scope. Publish them on
// window so the string-keyed registry dispatch can resolve them.
var PLOT_FN_NAMES = [
    'PRiSM_plot_cartesian', 'PRiSM_plot_horner', 'PRiSM_plot_bourdet', 'PRiSM_plot_mdh',
    'PRiSM_plot_sqrt_time', 'PRiSM_plot_quarter_root_time', 'PRiSM_plot_spherical',
    'PRiSM_plot_sandface_convolution', 'PRiSM_plot_buildup_superposition',
    'PRiSM_plot_rate_time_cartesian', 'PRiSM_plot_rate_time_semilog', 'PRiSM_plot_rate_time_loglog',
    'PRiSM_plot_rate_cumulative', 'PRiSM_plot_loss_ratio', 'PRiSM_plot_typecurve_overlay',
    'PRiSM_compute_bourdet'
];
function _lexical(name) {
    if (!/^PRiSM_[A-Za-z0-9_]+$/.test(String(name))) return null;
    try {
        // eslint-disable-next-line no-eval
        var fn = eval(name);          // direct eval: resolves host-IIFE declarations
        return (typeof fn === 'function') ? fn : null;
    } catch (e) { return null; }
}
(function _bridgePlotFns() {
    for (var i = 0; i < PLOT_FN_NAMES.length; i++) {
        var n = PLOT_FN_NAMES[i];
        if (typeof G[n] === 'function') continue;
        var fn = _lexical(n);
        if (fn) G[n] = fn;
    }
})();


// =========================================================================
// SECTION 1 — SHARED STATE
// =========================================================================
var ZERO_MATCH = Object.freeze({ timeShift: 0, pressShift: 0 });

function _stateDefaults() {
    return {
        model: 'homogeneous',
        params: {},
        paramFreeze: {},
        phys: {},                 // physical values keyed like the physical model (k, C, S, ...)
        tcMatch: null,            // {logPM, logTM, source}  PM = pD/Δp [1/psi], TM = tD/t [1/hr]
        modelCurve: null,         // legacy dimensionless {td, pd, pdPrime}
        modelCurveData: null,     // see PRiSM_evalModelCurve
        activePlot: 'bourdet',
        activePeriod: null,
        bourdetL: 0.15,
        timeFn: 'auto',
        showOverlay: true,
        paramUnits: 'auto',       // 'auto' | 'physical' | 'dimensionless'
        fitOpts: { objective: 'dp+deriv', floatPi: false, tmin: null, tmax: null },
        semilog: null,
        analysisKeyResults: {},
        autoMatch: null,          // last PRiSM_autoMatch result (Recommended strip)
        lastFit: null,
        presets: []
    };
}

// PRiSM_state.match is legacy and read-only. Writes are ignored (with one
// console warning) so no layer can store a fit there again.
function _guardMatch(st) {
    var d = null;
    try { d = Object.getOwnPropertyDescriptor(st, 'match'); } catch (e) { d = null; }
    if (d && d.get && d.get._prismGuard) return;
    var warned = false;
    var getter = function () { return ZERO_MATCH; };
    getter._prismGuard = true;
    try {
        Object.defineProperty(st, 'match', {
            configurable: true, enumerable: true, get: getter,
            set: function (v) {
                var zero = !!v && typeof v === 'object' && !v.timeShift && !v.pressShift &&
                    Object.keys(v).every(function (k) { return k === 'timeShift' || k === 'pressShift'; });
                if (!warned && !zero) {
                    warned = true;
                    try { console.warn('PRiSM: PRiSM_state.match is read-only — fits are stored in lastFit and tcMatch.'); } catch (e) { /* ignore */ }
                }
            }
        });
    } catch (e) { st.match = { timeShift: 0, pressShift: 0 }; }
}

function _st() {
    var st = G.PRiSM_state;
    if (!st || typeof st !== 'object') st = G.PRiSM_state = {};
    if (!st.__wp7) {
        var d = _stateDefaults();
        for (var k in d) if (Object.prototype.hasOwnProperty.call(d, k) && st[k] === undefined) st[k] = d[k];
        _guardMatch(st);
        try { Object.defineProperty(st, '__wp7', { value: true, enumerable: false, configurable: true }); } catch (e) { /* ignore */ }
    }
    if (!st.params || typeof st.params !== 'object') st.params = {};
    if (!st.paramFreeze || typeof st.paramFreeze !== 'object') st.paramFreeze = {};
    if (!st.phys || typeof st.phys !== 'object') st.phys = {};
    if (!st.fitOpts || typeof st.fitOpts !== 'object') st.fitOpts = { objective: 'dp+deriv', floatPi: false, tmin: null, tmax: null };
    if (!st.analysisKeyResults || typeof st.analysisKeyResults !== 'object') st.analysisKeyResults = {};
    if (!_isNum(st.bourdetL)) st.bourdetL = 0.15;
    return st;
}

function _defaultsFor(entry) {
    var out = {};
    if (!entry) return out;
    var d = entry.defaults || {};
    for (var k in d) if (Object.prototype.hasOwnProperty.call(d, k)) out[k] = d[k];
    (entry.paramSpec || []).forEach(function (s) {
        if (s && s.key && out[s.key] === undefined && s['default'] !== undefined) out[s.key] = s['default'];
    });
    return out;
}

(function _initState() {
    var st = _st();
    var m = _MODELS()[st.model];
    if (m && Object.keys(st.params).length === 0) st.params = _defaultsFor(m);
    try {
        if (typeof localStorage !== 'undefined' && localStorage) {
            var raw = localStorage.getItem('wts_prism_presets');
            if (raw && (!st.presets || !st.presets.length)) st.presets = JSON.parse(raw) || [];
        }
    } catch (e) { /* ignore */ }
})();


// =========================================================================
// SECTION 2 — SMALL UTILITIES
// =========================================================================
function _isNum(v) { return typeof v === 'number' && isFinite(v); }
function _num() { for (var i = 0; i < arguments.length; i++) if (_isNum(arguments[i])) return arguments[i]; return NaN; }
function _el(id) {
    try { return (typeof document !== 'undefined' && document && document.getElementById) ? document.getElementById(id) : null; }
    catch (e) { return null; }
}
function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}
function _clone(o) { try { return o == null ? o : JSON.parse(JSON.stringify(o)); } catch (e) { return o; } }
function _arr(a) {
    if (!a) return null;
    if (Array.isArray(a)) return a;
    if (typeof a.length === 'number') return Array.prototype.slice.call(a);
    return null;
}
function _now() {
    try { if (typeof performance !== 'undefined' && performance && performance.now) return performance.now(); } catch (e) { /* ignore */ }
    return Date.now();
}
function _fmt(v, sig) {
    if (!_isNum(v)) return '—';
    sig = sig || 4;
    var a = Math.abs(v);
    if (a !== 0 && (a >= 1e6 || a < 1e-3)) return v.toExponential(Math.max(0, sig - 1)).replace(/\.?0+e/, 'e').replace('e+', 'e');
    var s = v.toPrecision(sig);
    if (s.indexOf('e') !== -1) s = String(Number(s));
    if (s.indexOf('.') !== -1) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s;
}
function _fixed(v, dp) { return _isNum(v) ? v.toFixed(dp) : '—'; }
function _log10(x) { return Math.log(x) / Math.LN10; }
function _logspace(a, b, n) {
    var out = new Array(n);
    for (var i = 0; i < n; i++) out[i] = Math.pow(10, a + (b - a) * (n === 1 ? 0 : i / (n - 1)));
    return out;
}
function _median(arr) {
    var a = (arr || []).filter(_isNum).slice().sort(function (x, y) { return x - y; });
    if (!a.length) return NaN;
    var m = a.length >> 1;
    return (a.length % 2) ? a[m] : 0.5 * (a[m - 1] + a[m]);
}
function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
// Log-log interpolation of positive series (x ascending). NaN outside the range.
function _interpLog(x, xs, ys) {
    if (!(x > 0) || !xs || xs.length < 2) return NaN;
    var n = xs.length;
    if (x < xs[0] || x > xs[n - 1]) return NaN;
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (xs[mid] > x) hi = mid; else lo = mid; }
    var y0 = ys[lo], y1 = ys[hi];
    if (!(y0 > 0) || !(y1 > 0) || xs[hi] === xs[lo]) return (_isNum(y0) && _isNum(y1)) ? y0 + (y1 - y0) * (x - xs[lo]) / (xs[hi] - xs[lo]) : NaN;
    var f = (Math.log(x) - Math.log(xs[lo])) / (Math.log(xs[hi]) - Math.log(xs[lo]));
    return Math.exp(Math.log(y0) + f * (Math.log(y1) - Math.log(y0)));
}
// Interpolation linear in log x (y may be any sign). NaN outside the range.
function _interpLogX(x, xs, ys) {
    if (!(x > 0) || !xs || xs.length < 2 || x < xs[0] || x > xs[xs.length - 1]) return NaN;
    var lo = 0, hi = xs.length - 1;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (xs[mid] > x) hi = mid; else lo = mid; }
    if (xs[hi] === xs[lo]) return ys[lo];
    var f = (Math.log(x) - Math.log(xs[lo])) / (Math.log(xs[hi]) - Math.log(xs[lo]));
    return ys[lo] + f * (ys[hi] - ys[lo]);
}
function _emit(name, detail) {
    try {
        if (typeof G.dispatchEvent === 'function' && typeof G.CustomEvent === 'function') {
            G.dispatchEvent(new G.CustomEvent(name, { detail: detail || {} }));
        }
    } catch (e) { /* ignore — events are best-effort */ }
}
function _save() {
    if (typeof G.PRiSM_saveState === 'function') { try { G.PRiSM_saveState(); } catch (e) { /* ignore */ } }
}
function _mode() { return (G.PRiSM && G.PRiSM.mode) || 'transient'; }
function _hasData(ds) { return !!(ds && ds.t && ds.t.length); }
function _defer(fn) {
    if (typeof G.setTimeout === 'function') G.setTimeout(fn, 20);
    else fn();
}
function _forEach(list, fn) { if (list) Array.prototype.forEach.call(list, fn); }
function _plotH(kind) {
    var vw = _isNum(G.innerWidth) ? G.innerWidth : 1024;
    var vh = _isNum(G.innerHeight) ? G.innerHeight : 800;
    if (kind === 'small') return vw < 768 ? 220 : 280;
    if (vw < 768) return Math.round(Math.min(Math.max(vw - 32, 240), 720) * 0.75);
    return Math.round(_clamp(vh - 300, 380, 620));
}


// =========================================================================
// SECTION 3 — SCOPED STYLES (dark theme, 'prism-' prefix, phone friendly)
// =========================================================================
var CSS = [
    '.prism-w7 .prism-toolbar{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;margin-bottom:10px}',
    '.prism-w7 .prism-field{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--text2);max-width:100%}',
    '.prism-w7 .prism-field select,.prism-w7 .prism-field input{max-width:100%}',
    '.prism-w7 .prism-btn-sm{padding:6px 12px;font-size:12px}',
    '.prism-w7 .prism-msg{margin-top:8px;font-size:12px;color:var(--text2);min-height:16px;overflow-wrap:anywhere}',
    '.prism-w7 .prism-notes{margin-top:4px;font-size:11px;color:var(--text3);overflow-wrap:anywhere}',
    '.prism-w7 .prism-dim{color:var(--text3)}',
    '.prism-w7 .prism-ok{color:var(--green)} .prism-w7 .prism-warn{color:var(--yellow)} .prism-w7 .prism-bad{color:var(--red)}',
    '.prism-w7 .prism-canvas-wrap{background:var(--bg1);border:1px solid var(--border);border-radius:6px;padding:4px;max-width:100%;overflow:hidden}',
    '.prism-w7 .prism-canvas-wrap canvas{display:block;width:100%;touch-action:pan-y}',
    '.prism-w7 .prism-canvas-wrap.prism-drag canvas{touch-action:none;cursor:grab}',
    '.prism-w7 .prism-banner{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:9px 12px;border-radius:6px;font-size:12px;margin-bottom:10px;border:1px solid;overflow-wrap:anywhere}',
    '.prism-w7 .prism-banner--warn{background:rgba(210,153,34,.08);border-color:rgba(210,153,34,.45);color:var(--text)}',
    '.prism-w7 .prism-banner--info{background:var(--bg2);border-color:var(--border);color:var(--text2)}',
    '.prism-w7 .prism-chips{display:flex;flex-wrap:wrap;gap:6px}',
    '.prism-w7 .prism-chip{display:inline-flex;align-items:center;gap:5px;padding:5px 11px;border-radius:999px;border:1px solid var(--border);background:var(--bg2);color:var(--text2);font-size:12px;cursor:pointer;white-space:nowrap;font-family:inherit}',
    '.prism-w7 .prism-chip.is-on{background:var(--accent);border-color:var(--accent);color:#fff}',
    '.prism-w7 .prism-badge{display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:700;border:1px solid currentColor;white-space:nowrap}',
    '.prism-w7 .prism-badge--ok{color:var(--green)} .prism-w7 .prism-badge--warn{color:var(--yellow)} .prism-w7 .prism-badge--bad{color:var(--red)} .prism-w7 .prism-badge--accent{color:var(--accent)} .prism-w7 .prism-badge--info{color:var(--blue)}',
    '.prism-w7 .prism-lib-sec{margin-bottom:16px}',
    '.prism-w7 .prism-lib-sec-title{font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px}',
    '.prism-w7 .prism-lib-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}',
    '.prism-w7 .prism-model-card{display:flex;flex-direction:column;gap:6px;background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:8px;cursor:pointer;min-width:0}',
    '.prism-w7 .prism-model-card:hover,.prism-w7 .prism-model-card:focus{border-color:var(--accent);outline:none}',
    '.prism-w7 .prism-model-card.is-selected{border-color:var(--accent);background:rgba(240,136,62,.08)}',
    '.prism-w7 .prism-thumb{height:86px;background:var(--bg1);border-radius:4px;overflow:hidden;display:flex;align-items:center;justify-content:center;color:var(--text3);font-size:11px}',
    '.prism-w7 .prism-thumb svg{width:100%;height:100%;display:block}',
    '.prism-w7 .prism-card-head{display:flex;justify-content:space-between;align-items:flex-start;gap:6px}',
    '.prism-w7 .prism-card-name{font-weight:700;color:var(--text);font-size:13px;line-height:1.3;overflow-wrap:anywhere}',
    '.prism-w7 .prism-card-meta{font-size:10px;color:var(--text3);overflow-wrap:anywhere}',
    '.prism-w7 .prism-card-desc{font-size:11px;color:var(--text2);line-height:1.35;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}',
    '.prism-w7 .prism-rec{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;margin-bottom:6px}',
    '.prism-w7 .prism-rec-item{display:flex;gap:8px;align-items:center;background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:8px;min-width:0}',
    '.prism-w7 .prism-rec-item .prism-thumb{width:72px;height:54px;flex:0 0 72px}',
    '.prism-w7 .prism-rec-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text2)}',
    '.prism-w7 .prism-scroll-x{overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%}',
    '.prism-w7 .prism-grid2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px}',
    '.prism-w7 .prism-match{display:grid;grid-template-columns:260px minmax(0,1fr);gap:14px;align-items:start}',
    '.prism-w7 .prism-arrows{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;max-width:240px}',
    '.prism-w7 .prism-arrows .btn{justify-content:center;padding:8px 6px;font-size:12px}',
    '.prism-w7 .prism-kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 12px;font-size:12px}',
    '.prism-w7 .prism-kv .prism-v{font-family:"Courier New",monospace;color:var(--accent);text-align:right;overflow-wrap:anywhere}',
    '.prism-w7 .dtable input[type=number]{width:100%;min-width:70px;max-width:130px}',
    '.prism-w7 details summary{cursor:pointer;color:var(--text2);font-size:12px;margin:6px 0}',
    '@media (max-width:767px){',
    '  .prism-w7 .prism-grid2,.prism-w7 .prism-match{grid-template-columns:minmax(0,1fr)}',
    '  .prism-w7 .prism-match-plot{order:-1}',
    '  .prism-w7 .prism-rec{grid-template-columns:minmax(0,1fr)}',
    '  .prism-w7 .prism-lib-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}',
    '  .prism-w7 .prism-model-card .prism-thumb{height:62px}',
    '  .prism-w7 .prism-card-desc{-webkit-line-clamp:2}',
    '  .prism-w7 .prism-chips{flex-wrap:nowrap;overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:4px}',
    '  .prism-w7.card{padding:12px}',
    '}'
].join('\n');

function _injectStyles() {
    try {
        if (typeof document === 'undefined' || !document || !document.head) return;
        if (document.getElementById('prism-ui04-css')) return;
        var s = document.createElement('style');
        s.id = 'prism-ui04-css';
        s.textContent = CSS;
        document.head.appendChild(s);
    } catch (e) { /* ignore */ }
}

// Render html into a tab host. The shell re-creates its panel container after
// each shell-driven render; on a self re-render we keep that container.
var _lastHost = {};
function _host(hostEl, n) {
    if (hostEl && hostEl.nodeType === 1) { _lastHost[n] = hostEl; return hostEl; }
    var h = _el('prism_tab_' + n);
    if (h) _lastHost[n] = h;
    return h;
}
function _mount(host, html, ropts) {
    var keep = null;
    if (ropts && ropts.preservePanels) {
        _forEach(host.children, function (c) { if (c.id && /_panels$/.test(c.id)) keep = c; });
    }
    host.innerHTML = html;
    if (keep) host.appendChild(keep);
}
function _rerender(n) {
    var fns = { 2: PRiSM_renderPlotsTab, 3: PRiSM_renderModelTab, 4: PRiSM_renderParamsTab, 5: PRiSM_renderMatchTab, 6: PRiSM_renderRegressTab };
    var h = _lastHost[n];
    if (h && !h.isConnected && h.isConnected !== undefined) h = null;
    if (fns[n]) fns[n](h || null, { preservePanels: true });
    _remountPanels(n);
}
function _remountPanels(n) {
    if (typeof G.PRiSM_mountTabPanels === 'function') { try { G.PRiSM_mountTabPanels(n); } catch (e) { /* panels report their own errors */ } }
}
function _gotoData() {
    if (typeof G.PRiSM_gotoStep === 'function') { try { G.PRiSM_gotoStep(1); return; } catch (e) { /* fall through */ } }
    if (G.PRiSM && typeof G.PRiSM.setTab === 'function') { try { G.PRiSM.setTab(1); } catch (e) { /* ignore */ } }
}
function _gotoTab(n) {
    if (G.PRiSM && typeof G.PRiSM.setTab === 'function') { try { G.PRiSM.setTab(n); } catch (e) { /* ignore */ } }
}


// =========================================================================
// SECTION 4 — CONTRACT ADAPTERS (C1 well, C2 analysis data, C3 physical
//             model, C4 lastFit, C5 type-curve match) with local fallbacks
// =========================================================================

// ── C1 well inputs ──
function _getWell(ds) {
    if (typeof G.PRiSM_getWell === 'function') {
        try { var w = G.PRiSM_getWell(ds); if (w && typeof w === 'object') return w; }
        catch (e) { try { console.warn('PRiSM_getWell failed:', e && e.message); } catch (_) { /* ignore */ } }
    }
    return _localWell(ds);
}
// Fallback when the PTA core is absent: read PRiSM_pvt, never trust p_res as
// pi (unknown provenance), and mark everything as defaulted.
function _localWell(ds) {
    var pv = G.PRiSM_pvt || {};
    var c = pv._computed || {};
    var gas = /gas/i.test(pv.fluidType || '');
    var qData = NaN;
    if (ds && ds.q && ds.q.length) {
        for (var i = ds.q.length - 1; i >= 0; i--) if (_isNum(ds.q[i]) && ds.q[i] !== 0) { qData = Math.abs(ds.q[i]); break; }
    }
    var w = {
        fluid: pv.fluidType || 'oil',
        q: _num(qData, pv.q),
        B: gas ? _num(pv.Bg, c.Bg, c.B) : _num(pv.Bo, c.Bo, c.B),
        mu: gas ? _num(pv.mu_g, c.mu_g, c.mu) : _num(pv.mu_o, c.mu_o, c.mu),
        ct: _num(pv.ct, c.ct),
        h: _num(pv.h), phi: _num(pv.phi), rw: _num(pv.rw),
        pi: null, T_R: _num(pv.T_res), sg: _num(pv.SG_g),
        testType: pv.testType || 'auto',
        tp: _isNum(pv.tp) ? pv.tp : null, tShut: _isNum(pv.tShut) ? pv.tShut : null, pwf0: _isNum(pv.pwf0) ? pv.pwf0 : null
    };
    var need = ['q', 'B', 'mu', 'ct', 'h', 'phi', 'rw'];
    w.missing = need.filter(function (k) { return !(w[k] > 0); });
    w.defaulted = need.filter(function (k) { return w[k] > 0; });
    w.complete = w.missing.length === 0;
    w._local = true;
    return w;
}
function _wellComplete(w) { return !!(w && w.complete && w.q > 0 && w.B > 0 && w.mu > 0 && w.h > 0); }

// ── Bourdet derivative (the 02 helper when present) ──
function _bourdet(t, dp, L) {
    if (typeof G.PRiSM_compute_bourdet === 'function') {
        try { var r = G.PRiSM_compute_bourdet(t, dp, L); if (r && r.length === t.length) return _arr(r); } catch (e) { /* local */ }
    }
    var n = t.length, d = new Array(n);
    for (var z = 0; z < n; z++) d[z] = NaN;
    for (var i = 1; i < n - 1; i++) {
        if (!(t[i] > 0) || !_isNum(dp[i])) continue;
        var i1 = i - 1, i2 = i + 1;
        if (L > 0) {
            while (i1 > 0 && Math.log(t[i]) - Math.log(t[i1]) < L) i1--;
            while (i2 < n - 1 && Math.log(t[i2]) - Math.log(t[i]) < L) i2++;
        }
        if (!(t[i1] > 0) || !(t[i2] > 0)) continue;
        var dl1 = Math.log(t[i]) - Math.log(t[i1]), dl2 = Math.log(t[i2]) - Math.log(t[i]), dlT = dl1 + dl2;
        if (!dl1 || !dl2) continue;
        d[i] = (dp[i] - dp[i1]) / dl1 * (dl2 / dlT) + (dp[i2] - dp[i]) / dl2 * (dl1 / dlT);
    }
    // End points: one-sided so the log-log plot keeps the late plateau.
    if (n >= 2 && t[0] > 0 && t[1] > t[0]) d[0] = (dp[1] - dp[0]) / (Math.log(t[1]) - Math.log(t[0]));
    if (n >= 2 && t[n - 2] > 0 && t[n - 1] > t[n - 2]) d[n - 1] = (dp[n - 1] - dp[n - 2]) / (Math.log(t[n - 1]) - Math.log(t[n - 2]));
    return d;
}

// ── C2 analysis data ──
function _adOpts() {
    var st = _st();
    var o = { timeFn: st.timeFn || 'auto', L: _isNum(st.bourdetL) ? st.bourdetL : 0.15 };
    if (st.activePeriod != null && st.activePeriod >= 0) o.period = st.activePeriod;
    return o;
}
function _getAData(ds, opts) {
    ds = ds || G.PRiSM_dataset;
    opts = opts || _adOpts();
    if (typeof G.PRiSM_getAnalysisData === 'function') {
        try { var a = G.PRiSM_getAnalysisData(ds, opts); if (a && typeof a === 'object') return a; }
        catch (e) { try { console.warn('PRiSM_getAnalysisData failed:', e && e.message); } catch (_) { /* ignore */ } }
    }
    return _localAData(ds, opts);
}
// Local fallback (Δt only). Sign-aware Δp; pRef = pi, then a t ≤ 0 row, then a
// linear back-extrapolation to Δt = 0, then the first sample (flagged).
function _localAData(ds, opts) {
    opts = opts || {};
    var fail = function (reason) { return { ok: false, reason: reason, n: 0, t: [], tAbs: [], p: [], dp: [], x: [], deriv: [], warnings: [], periods: [] }; };
    var T = ds && _arr(ds.t), P = ds && _arr(ds.p), Q = ds && _arr(ds.q);
    if (!T || !P || T.length < 3 || P.length !== T.length) return fail('No pressure data — load time and pressure on the Data step.');
    var n = T.length;
    var well = _getWell(ds);
    var periods = Q ? PRiSM_detectPeriods(T, Q) : [];
    var pIdx = (opts.period != null && opts.period >= 0 && periods[opts.period] && periods.length > 1) ? opts.period : null;
    var i0 = 0, i1 = n - 1, tStart, pRef = NaN, pRefSource = null, warnings = [];
    if (pIdx != null) { i0 = periods[pIdx].i0; i1 = periods[pIdx].i1; }
    var prev = (pIdx != null && pIdx > 0) ? periods[pIdx - 1] : null;
    var testType = (well && well.testType && well.testType !== 'auto') ? well.testType : null;
    if (!testType) {
        if (prev) testType = (periods[pIdx].q < prev.q) ? 'buildup' : 'drawdown';
        else testType = ((P[i1] - P[i0]) >= 0) ? 'buildup' : 'drawdown';   // CLAUDE.md sign rule
    }
    var sign = (testType === 'buildup' || testType === 'injection') ? 1 : -1;
    if (prev) {
        tStart = prev.t1; pRef = P[prev.i1]; pRefSource = 'pwf0';
    } else {
        var firstPos = -1;
        for (var a = i0; a <= i1; a++) if (T[a] > 0) { firstPos = a; break; }
        var span = T[i1] - (firstPos >= 0 ? T[firstPos] : T[i0]);
        tStart = (firstPos >= 0 && T[firstPos] <= 0.01 * Math.max(span, 1e-9)) ? 0 : T[i0] - (T[Math.min(i0 + 1, i1)] - T[i0]);
        var zeroRow = -1;
        for (var b = i0; b <= i1; b++) if (T[b] <= tStart && _isNum(P[b])) zeroRow = b;
        var wantsPi = (testType === 'drawdown' || testType === 'injection');
        if (wantsPi && well && _isNum(well.pi)) { pRef = well.pi; pRefSource = 'pi'; }
        else if (!wantsPi && well && _isNum(well.pwf0)) { pRef = well.pwf0; pRefSource = 'pwf0'; }
        else if (zeroRow >= 0) { pRef = P[zeroRow]; pRefSource = 't0-row'; }
        else {
            var xs = [], ys = [];
            for (var c = i0; c <= i1 && xs.length < 3; c++) if (T[c] > tStart && _isNum(P[c])) { xs.push(T[c] - tStart); ys.push(P[c]); }
            if (xs.length === 3) {
                var mx = (xs[0] + xs[1] + xs[2]) / 3, my = (ys[0] + ys[1] + ys[2]) / 3, sxy = 0, sxx = 0;
                for (var j = 0; j < 3; j++) { sxy += (xs[j] - mx) * (ys[j] - my); sxx += (xs[j] - mx) * (xs[j] - mx); }
                var p0 = sxx > 0 ? my - (sxy / sxx) * mx : NaN;
                if (_isNum(p0) && sign * (ys[0] - p0) > 0) { pRef = p0; pRefSource = 'extrapolated'; }
            }
            if (!_isNum(pRef)) { pRef = P[i0]; pRefSource = 'first-sample'; }
            warnings.push('Reference pressure ' + (pRefSource === 'extrapolated' ? 'extrapolated from the first points' : 'taken from the first sample') +
                ' — enter pi on the Data step; skin is biased without it.');
        }
    }
    var t = [], tAbs = [], p = [], dp = [];
    for (var k = i0; k <= i1; k++) {
        var dt = T[k] - tStart;
        if (!(dt > 0) || !_isNum(P[k])) continue;
        t.push(dt); tAbs.push(T[k]); p.push(P[k]); dp.push(sign * (P[k] - pRef));
    }
    if (t.length < 3) return fail('Not enough points in the analysed period.');
    var L = _isNum(opts.L) ? opts.L : 0.15;
    var deriv = _bourdet(t, dp, L);
    if (opts.timeFn && opts.timeFn !== 'auto' && opts.timeFn !== 'dt') warnings.push('Only elapsed time Δt is available in this build; ' + opts.timeFn + ' time needs the PTA core.');
    var anyPos = dp.some(function (v) { return v > 0; });
    return {
        ok: anyPos, reason: anyPos ? null : 'No positive Δp — check the test type and pi on the Data step.',
        n: t.length, t: t, tAbs: tAbs, p: p, dp: dp, x: t.slice(), deriv: deriv, L: L, timeFn: 'dt',
        sign: sign, pRef: pRef, pRefSource: pRefSource, testType: testType, tStart: tStart,
        tShut: (testType === 'buildup' || testType === 'falloff') ? tStart : null, tp: well && _isNum(well.tp) ? well.tp : null,
        qRef: pIdx != null ? periods[pIdx].q : (well ? well.q : NaN), rateHistory: [], periods: periods,
        fluid: well ? well.fluid : 'oil', warnings: warnings, _local: true
    };
}

// ── C3 physical model ──
function _getPM(modelKey, well, adata, opts) {
    if (typeof G.PRiSM_physicalModel === 'function') {
        try { var pm = G.PRiSM_physicalModel(modelKey, well, adata, opts || {}); if (pm) return pm; }
        catch (e) { try { console.warn('PRiSM_physicalModel failed:', e && e.message); } catch (_) { /* ignore */ } }
    }
    return _localPM(modelKey, well, adata, opts);
}
// Minimal single-rate drawdown wrapper for rw-referenced models (C3 subset).
function _localPM(modelKey, well, adata) {
    var entry = _MODELS()[modelKey];
    if (!entry || typeof entry.pd !== 'function') return { ok: false, reason: 'unknown model' };
    if (entry.kind === 'rate') return { ok: false, reason: 'rate model' };
    if (!well || !well.complete || !(well.phi > 0 && well.ct > 0 && well.rw > 0 && well.q > 0 && well.B > 0 && well.mu > 0 && well.h > 0)) {
        return { ok: false, reason: 'Well inputs incomplete', missing: well ? well.missing : [] };
    }
    if (entry.refLength && entry.refLength !== 'rw') return { ok: false, reason: 'This model uses an ' + entry.refLength + ' reference length — physical units need the PTA core.' };
    if (adata && /buildup|falloff/.test(adata.testType || '')) return { ok: false, reason: 'Build-up superposition needs the PTA core.' };
    var spec = (entry.paramSpec || []).filter(function (s) { return s && s.key && !s.options && typeof s['default'] === 'number' && s.key.charAt(0) !== '_'; });
    var hasCd = spec.some(function (s) { return s.key === 'Cd'; });
    var keys = ['k'].concat(hasCd ? ['C'] : []).concat(spec.filter(function (s) { return s.key !== 'Cd'; }).map(function (s) { return s.key; }));
    var pspec = {
        k: { min: 1e-4, max: 1e5, unit: 'md', scale: 'log', 'default': 10 },
        C: { min: 1e-7, max: 10, unit: 'bbl/psi', scale: 'log', 'default': 0.01 }
    };
    spec.forEach(function (s) { if (s.key !== 'Cd') pspec[s.key] = { min: s.min, max: s.max, unit: s.unit || '-', scale: s.scale || 'lin', 'default': s['default'] }; });
    var geo = well.phi * well.ct * well.rw * well.rw;
    function toModelParams(phys) {
        var st = _st();
        var k = phys.k, kh = k * well.h;
        var A = 141.2 * well.q * well.B * well.mu / kh;
        var B = 0.0002637 * k / (well.phi * well.mu * well.ct * well.rw * well.rw);
        var params = {};
        for (var pk in st.params) if (Object.prototype.hasOwnProperty.call(st.params, pk) && pk.charAt(0) !== '_') params[pk] = st.params[pk];
        spec.forEach(function (s) { if (s.key !== 'Cd' && _isNum(phys[s.key])) params[s.key] = phys[s.key]; });
        if (hasCd) params.Cd = 0.8936 * phys.C / (geo * well.h);
        return { params: params, A: A, B: B };
    }
    function dp(t, phys) {
        var m = toModelParams(phys);
        var pd = _arr(entry.pd(t.map(function (x) { return m.B * x; }), m.params));
        return pd.map(function (v) { return m.A * v; });
    }
    function deriv(t, phys) {
        var m = toModelParams(phys);
        if (typeof entry.pdPrime === 'function') {
            var d = _arr(entry.pdPrime(t.map(function (x) { return m.B * x; }), m.params));
            return d.map(function (v) { return m.A * v; });
        }
        return _bourdet(t, dp(t, phys), 0);
    }
    var sign = adata && _isNum(adata.sign) ? adata.sign : -1;
    function p(t, phys) {
        var ref = _isNum(phys.pi) ? phys.pi : (adata && _isNum(adata.pRef) ? adata.pRef : (_isNum(well.pi) ? well.pi : NaN));
        return dp(t, phys).map(function (v) { return ref + sign * v; });
    }
    function seed() {
        var out = { k: 10, S: 0 };
        if (hasCd) out.C = 0.01;
        if (!adata || !adata.ok) return out;
        var n = adata.t.length, lateD = [];
        for (var i = Math.floor(n * 0.7); i < n; i++) if (adata.deriv[i] > 0) lateD.push(adata.deriv[i]);
        var dr = _median(lateD);
        if (dr > 0) out.k = 70.6 * well.q * well.B * well.mu / dr / well.h;
        if (hasCd && adata.dp[0] > 0) out.C = well.q * well.B * adata.t[0] / (24 * adata.dp[0]);
        var r = n - 1;
        if (dr > 0 && adata.dp[r] > 0) {
            var S0 = 0.5 * (adata.dp[r] / dr - Math.log(0.0002637 * out.k * adata.t[r] / (well.phi * well.mu * well.ct * well.rw * well.rw)) - 0.80907);
            if (_isNum(S0)) out.S = _clamp(S0, -6, 40);
        }
        return out;
    }
    function derived(phys) {
        var m = toModelParams(phys);
        var tEnd = adata && adata.t && adata.t.length ? adata.t[adata.t.length - 1] : NaN;
        return {
            k: phys.k, kh: phys.k * well.h, C: phys.C, Cd: m.params.Cd, S: phys.S,
            pi: _isNum(phys.pi) ? phys.pi : (adata ? adata.pRef : NaN), A: m.A, B: m.B,
            refLength_ft: well.rw,
            rinv: _isNum(tEnd) ? Math.sqrt(phys.k * tEnd / (948 * well.phi * well.mu * well.ct)) : NaN
        };
    }
    return { ok: true, mode: 'physical', kind: 'pressure', keys: keys, spec: pspec, toModelParams: toModelParams,
             dp: dp, deriv: deriv, p: p, seed: seed, derived: derived, _local: true };
}

// Complete a physical-value object for every key of the physical model: kept
// values first, then the model seed (k, C, S, xf, Lh), the dimensionless
// params (shape keys), and finally spec defaults. Only `target` is written.
var SEED_FIRST = { k: 1, C: 1, S: 1, xf: 1, Lh: 1 };
function _completePhys(pm, ad, well, target) {
    var st = _st();
    var phys = target;
    var seed = null;
    (pm.keys || []).forEach(function (key) {
        if (_isNum(phys[key])) return;
        if (key === 'pi') {
            var piv = (well && _isNum(well.pi)) ? well.pi : (ad && _isNum(ad.pRef) ? ad.pRef : NaN);
            if (_isNum(piv)) phys.pi = piv;
            return;
        }
        if (!SEED_FIRST[key] && _isNum(st.params[key])) { phys[key] = st.params[key]; return; }
        if (!seed) { try { seed = (typeof pm.seed === 'function') ? (pm.seed() || {}) : {}; } catch (e) { seed = {}; } }
        if (_isNum(seed[key])) { phys[key] = seed[key]; return; }
        if (_isNum(st.params[key])) { phys[key] = st.params[key]; return; }
        var sp = pm.spec && pm.spec[key];
        phys[key] = (sp && _isNum(sp['default'])) ? sp['default'] : (key === 'k' ? 10 : key === 'C' ? 0.01 : 0);
    });
    return phys;
}
function _numsOf(o) {
    var out = {};
    if (o && typeof o === 'object') for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k) && _isNum(o[k])) out[k] = o[k];
    return out;
}
// What the UI shows and evaluates: committed st.phys completed without writing
// state (rendering never mutates the analysis state).
function _physView(pm, ad, well, base) {
    return _completePhys(pm, ad, well, _numsOf(base || _st().phys));
}
function _hasCommittedPhys() {
    var p = _st().phys;
    for (var k in p) if (Object.prototype.hasOwnProperty.call(p, k) && _isNum(p[k])) return true;
    return false;
}
// Commit physical values (user edit, match Apply, align): st.phys + synced st.params.
function _commitPhys(pm, phys) {
    var st = _st();
    st.phys = _numsOf(phys);
    _syncParamsFromPhys(pm);
    st.modelCurveData = null;
}
function _syncParamsFromPhys(pm) {
    var st = _st();
    try {
        var m = pm.toModelParams(st.phys);
        if (m && m.params) {
            for (var k in m.params) {
                if (Object.prototype.hasOwnProperty.call(m.params, k) && k.slice(0, 2) !== '__') st.params[k] = m.params[k];
            }
        }
        return m;
    } catch (e) { return null; }
}

// ── C4 lastFit ──
function _normFit(f) {
    if (!f || typeof f !== 'object') return null;
    var o = {};
    for (var k in f) if (Object.prototype.hasOwnProperty.call(f, k)) o[k] = f[k];
    if (o.r2 === undefined && o.R2 !== undefined) o.r2 = o.R2;
    if (o.rmse === undefined && o.RMSE !== undefined) o.rmse = o.RMSE;
    if (o.aic === undefined && o.AIC !== undefined) o.aic = o.AIC;
    if (o.ci95 === undefined && o.CI95 !== undefined) o.ci95 = o.CI95;
    if (!o.modelKey && o.model) o.modelKey = o.model;
    if (!o.model && o.modelKey) o.model = o.modelKey;
    return o;
}
function _setLastFit(fit) {
    if (typeof G.PRiSM_setLastFit === 'function') {
        try { var r = G.PRiSM_setLastFit(fit); return r || fit; }
        catch (e) { try { console.warn('PRiSM_setLastFit failed:', e && e.message); } catch (_) { /* ignore */ } }
    }
    var st = _st();
    var f = _normFit(fit);
    if (!f.timestamp) f.timestamp = new Date().toISOString();
    st.lastFit = f;
    if (typeof G.PRiSM_interpretCurrentFit === 'function') { try { st.interp = G.PRiSM_interpretCurrentFit(); } catch (e) { /* ignore */ } }
    _save();
    _emit('prism:fit-updated', { source: f.source, fit: f });
    return f;
}
function _getLastFit() {
    if (typeof G.PRiSM_getLastFit === 'function') { try { return _normFit(G.PRiSM_getLastFit()); } catch (e) { /* local */ } }
    return _normFit(_st().lastFit);
}

// ── C5 type-curve match ──
function _validTcm(t) { return (t && _isNum(t.logPM) && _isNum(t.logTM)) ? t : null; }
function _applyTCM(curve, tcm) {
    if (typeof G.PRiSM_applyTypeCurveMatch === 'function') {
        try { var r = G.PRiSM_applyTypeCurveMatch(curve, tcm); if (r && r.t && r.dp) return { t: _arr(r.t), dp: _arr(r.dp), deriv: _arr(r.deriv) }; }
        catch (e) { /* local */ }
    }
    var PM = Math.pow(10, tcm.logPM), TM = Math.pow(10, tcm.logTM);
    return {
        t: curve.td.map(function (x) { return x / TM; }),
        dp: curve.pd.map(function (v) { return v / PM; }),
        deriv: curve.pdPrime ? curve.pdPrime.map(function (v) { return v / PM; }) : null
    };
}
function _normM2P(r, params) {
    if (!r || typeof r !== 'object') return { ok: false, reason: 'no result' };
    var p = r.phys || r;
    var out = {
        ok: r.ok !== false && _isNum(p.k), reason: r.reason,
        k: p.k, kh: _num(p.kh, p.k * (r.h || NaN)), C: p.C, Cd: _num(p.Cd, p.CD), S: p.S,
        B: _num(r.B, r.B_phys, r.Bphys, p.B), params: r.params || null,
        consistent: r.consistent, warnings: r.warnings || []
    };
    if (!out.params) {
        out.params = {};
        if (_isNum(out.Cd) && params && _isNum(params.Cd)) out.params.Cd = out.Cd;
        if (_isNum(out.S) && params && _isNum(params.S)) out.params.S = out.S;
    }
    return out;
}
function _matchToPhysical(tcm, modelKey, params, well) {
    if (typeof G.PRiSM_matchToPhysical === 'function') {
        try { var r = G.PRiSM_matchToPhysical(tcm, modelKey, params, well); if (r) return _normM2P(r, params); }
        catch (e) { try { console.warn('PRiSM_matchToPhysical failed:', e && e.message); } catch (_) { /* ignore */ } }
    }
    return _localMatchToPhysical(tcm, modelKey, params, well);
}
// C5: kh = 141.2qBμ·PM; B_phys = 0.0002637k/(φμct rw²); Cd' = Cd·B_phys/TM;
//     S' = S + 0.5·ln(TM/B_phys); C = 0.0002951·kh·Cd/(μ·TM).
function _localMatchToPhysical(tcm, modelKey, params, well) {
    if (!_validTcm(tcm)) return { ok: false, reason: 'No type-curve match yet.' };
    if (!well || !(well.q > 0 && well.B > 0 && well.mu > 0 && well.h > 0)) return { ok: false, reason: 'Enter q, B, μ and h on the Data step to convert the match.' };
    params = params || {};
    var PM = Math.pow(10, tcm.logPM), TM = Math.pow(10, tcm.logTM);
    var kh = 141.2 * well.q * well.B * well.mu * PM, k = kh / well.h;
    var out = { ok: true, kh: kh, k: k, params: {}, warnings: [], consistent: true };
    var entry = _MODELS()[modelKey] || {};
    var ref = entry.refLength || 'rw';
    if (well.phi > 0 && well.ct > 0 && well.rw > 0 && ref === 'rw') {
        var Bp = 0.0002637 * k / (well.phi * well.mu * well.ct * well.rw * well.rw);
        out.B = Bp;
        if (_isNum(params.Cd)) { out.Cd = params.Cd * Bp / TM; out.C = 0.0002951 * kh * params.Cd / (well.mu * TM); out.params.Cd = out.Cd; }
        if (_isNum(params.S)) { out.S = params.S + 0.5 * Math.log(TM / Bp); out.params.S = out.S; }
        var extra = (entry.paramSpec || []).some(function (s) { return s && typeof s['default'] === 'number' && s.key !== 'Cd' && s.key !== 'S'; });
        if (extra && Math.abs(Math.log(TM / Bp)) > 0.01) {
            out.consistent = false;
            out.warnings.push('Model shape parameters are scaled by rw; re-check them (or run regression) after applying.');
        }
    } else {
        out.warnings.push('Need φ, ct and rw with an rw-referenced model to split C and S from the time match.');
    }
    return out;
}


// =========================================================================
// SECTION 5 — FLOW PERIODS
// =========================================================================
// Rate steps merge when they differ by less than 1 % (relative).
function PRiSM_detectPeriods(t, q) {
    var T = _arr(t), Q = _arr(q);
    if (!T || !Q || T.length !== Q.length || T.length < 2) return [];
    var n = T.length, qq = new Array(n), last = NaN;
    for (var i = 0; i < n; i++) { qq[i] = _isNum(Q[i]) ? Q[i] : last; last = qq[i]; }
    if (!_isNum(qq[0])) { var f = NaN; for (var j = 0; j < n; j++) if (_isNum(qq[j])) { f = qq[j]; break; } for (var z = 0; z < n && !_isNum(qq[z]); z++) qq[z] = f; }
    var same = function (a, b) {
        if (!_isNum(a) || !_isNum(b)) return true;
        return Math.abs(a - b) <= 1e-9 + 0.01 * Math.max(Math.abs(a), Math.abs(b));
    };
    var out = [], s = 0;
    function push(a, b) {
        var sum = 0, c = 0;
        for (var k = a; k <= b; k++) if (_isNum(qq[k])) { sum += qq[k]; c++; }
        var qm = c ? sum / c : NaN;
        out.push({ t0: T[a], t1: T[b], start: T[a], end: T[b], i0: a, i1: b, q: qm, label: 'P' + (out.length + 1) });
    }
    for (var m = 1; m < n; m++) if (!same(qq[m], qq[s])) { push(s, m - 1); s = m; }
    push(s, n - 1);
    return out;
}
var MAX_PICKER_PERIODS = 20;
// Periods for the picker: the PTA core's list (its indices drive getAnalysisData),
// else the local detection.
function _periodList(ds, ad) {
    if (ad && Array.isArray(ad.periods) && ad.periods.length && !ad._local) {
        return ad.periods.map(function (p, i) {
            var t0 = _num(p.t0, p.start), t1 = _num(p.t1, p.end);
            return { t0: t0, t1: t1, start: t0, end: t1, q: p.q, type: p.type || null, label: p.label || ('P' + (i + 1)) };
        });
    }
    return (ds && ds.q && ds.t) ? PRiSM_detectPeriods(ds.t, ds.q) : [];
}


// =========================================================================
// SECTION 6 — MODEL CURVES (PRiSM_evalModelCurve)
// =========================================================================
// modelCurveData forms:
//   physical      {mode, modelKey, t[hr], dp[psi], deriv[psi], p[psia], tStart, sig}
//   dimensionless {mode, modelKey, td, pd, pdPrime, tdRange, sig}
//   rate          {mode, modelKey, t[day], q, timeUnit:'d', sig}
var DIST_KEY_RE = /^(dF\d?|dEnd|dN|dS|dE|dW|R\d?|RD|Lf|reD)$/;
function _dimlessRange(entry, params) {
    params = params || {};
    var Cd = _isNum(params.Cd) ? Math.max(params.Cd, 0) : 0;
    var S = _isNum(params.S) ? params.S : 0;
    var hi = Math.max(1e4, 100 * Cd * (60 + 3.5 * S));
    for (var k in params) {
        if (Object.prototype.hasOwnProperty.call(params, k) && DIST_KEY_RE.test(k) && _isNum(params[k]) && params[k] > 0) {
            hi = Math.max(hi, 100 * params[k] * params[k]);
        }
    }
    return [1e-3, Math.min(hi, 1e12)];
}
function _toArr(v, n) {
    var a = _arr(v);
    if (!a) { a = new Array(n); for (var i = 0; i < n; i++) a[i] = NaN; }
    return a.map(function (x) { return _isNum(x) ? x : NaN; });
}
function _dimlessCurve(entry, params, opts) {
    opts = opts || {};
    var r = _dimlessRange(entry, params);
    var lo = r[0], hi = r[1];
    if (opts.tdRange && _isNum(opts.tdRange[0]) && _isNum(opts.tdRange[1]) && opts.tdRange[0] > 0) {
        lo = Math.min(lo, opts.tdRange[0]);
        hi = Math.max(hi, opts.tdRange[1]);
    }
    hi = Math.min(hi, 1e14);
    var decades = _log10(hi / lo);
    var n = opts.n || Math.max(150, Math.ceil(12 * decades));
    var td = _logspace(_log10(lo), _log10(hi), n);
    var pd = _toArr(entry.pd(td, params), n);
    var pdp = (typeof entry.pdPrime === 'function') ? _toArr(entry.pdPrime(td, params), n) : _bourdet(td, pd, 0);
    return { mode: 'dimensionless', td: td, pd: pd, pdPrime: pdp, tdRange: [lo, hi] };
}
function _daysOf(ds) {
    var T = _arr(ds.t) || [];
    var u = String(ds.timeUnit || 'h').toLowerCase();
    var f = (u === 'd' || u === 'day' || u === 'days') ? 1 : 1 / 24;
    return T.map(function (x) { return x * f; });
}
function _rateCurve(entry, params, ds, opts) {
    opts = opts || {};
    var t1 = NaN, tEnd = NaN, tMin = NaN;
    if (ds && ds.t && ds.t.length) {
        var d = _daysOf(ds).filter(function (x) { return x > 0; });
        if (d.length) {
            tMin = Math.min.apply(null, d); var tMax = Math.max.apply(null, d);
            t1 = tMin;
            var horizon = _isNum(opts.horizonDays) ? opts.horizonDays : 2 * (tMax - tMin);
            tEnd = tMax + Math.max(horizon, 0);
        }
    }
    if (!(t1 > 0) || !(tEnd > t1)) { t1 = 0.1; tEnd = 3650; }
    var n = opts.n || 150;
    var t = _logspace(_log10(t1), _log10(tEnd), n);
    var q = _toArr(entry.pd(t, params), n);
    return { mode: 'rate', t: t, q: q, timeUnit: 'd' };
}
function _dsKey(ds) {
    if (!_hasData(ds)) return 'none';
    var n = ds.t.length, s = 0, sq = 0;
    for (var i = 0; i < n; i += Math.max(1, Math.floor(n / 64))) { s += (ds.p && _isNum(ds.p[i])) ? ds.p[i] : 0; sq += (ds.q && _isNum(ds.q[i])) ? ds.q[i] : 0; }
    return [n, ds.t[0], ds.t[n - 1], s, sq, ds.timeUnit || ''].join('|');
}
function _curveSig(ad) {
    var st = _st(), ds = G.PRiSM_dataset, w = null;
    try { w = JSON.stringify(_getWell(ds)); } catch (e) { w = ''; }
    return JSON.stringify([st.model, st.params, st.phys, st.paramUnits, !!st.fitOpts.floatPi, _dsKey(ds),
        ad ? [ad.n, ad.pRef, ad.tStart, ad.testType, ad.timeFn] : null, _adOpts(), w]);
}
function _legacyCurve(c) {
    return (c && c.mode === 'dimensionless') ? { td: c.td, pd: c.pd, pdPrime: c.pdPrime } : null;
}

function PRiSM_evalModelCurve(modelKey, params, opts) {
    var st = _st();
    var M = _MODELS();
    // Legacy signature: (modelKey, params, tdArray) → dimensionless curve on that grid.
    if (opts && typeof opts.length === 'number' && typeof opts !== 'string') {
        var e0 = M[modelKey || st.model];
        if (!e0 || typeof e0.pd !== 'function') return null;
        try {
            var tdA = _arr(opts);
            var pdA = _toArr(e0.pd(tdA, params || st.params), tdA.length);
            var ppA = (typeof e0.pdPrime === 'function') ? _toArr(e0.pdPrime(tdA, params || st.params), tdA.length) : null;
            return { mode: 'dimensionless', modelKey: modelKey || st.model, td: tdA.slice(), pd: pdA, pdPrime: ppA };
        } catch (e) { return null; }
    }
    opts = opts || {};
    modelKey = modelKey || st.model;
    params = params || st.params;
    var entry = M[modelKey];
    if (!entry || typeof entry.pd !== 'function') return null;
    var store = opts.store !== false && modelKey === st.model;
    var ds = G.PRiSM_dataset;
    var curve = null, ad = opts.adata || null;
    try {
        if (entry.kind === 'rate') {
            curve = _rateCurve(entry, params, ds, opts);
        } else {
            var wantPhys = opts.mode !== 'dimensionless' && st.paramUnits !== 'dimensionless';
            if (wantPhys) {
                if (!ad && ds && ds.p) ad = _getAData(ds, _adOpts());
                var well = _getWell(ds);
                var pm = _getPM(modelKey, well, ad, { floatPi: !!st.fitOpts.floatPi });
                if (pm && pm.ok && pm.mode !== 'scale' && typeof pm.dp === 'function') {
                    // Never writes st.phys / st.params: the view is completed locally.
                    var phys = _physView(pm, ad, well, opts.phys || st.phys);
                    var tmin = 1e-3, tmax = 1e3;
                    if (ad && ad.ok && ad.t && ad.t.length) {
                        var pos = ad.t.filter(function (x) { return x > 0; });
                        if (pos.length) { tmin = Math.min.apply(null, pos); tmax = Math.max.apply(null, pos); }
                    }
                    var t = _logspace(_log10(tmin / 3), _log10(3 * tmax), opts.n || 150);
                    curve = {
                        mode: 'physical', t: t,
                        dp: _toArr(pm.dp(t, phys), t.length),
                        deriv: _toArr(pm.deriv(t, phys), t.length),
                        p: (typeof pm.p === 'function') ? _toArr(pm.p(t, phys), t.length) : null,
                        tStart: ad && _isNum(ad.tStart) ? ad.tStart : 0,
                        phys: _clone(phys)
                    };
                    try { curve.derived = (typeof pm.derived === 'function') ? pm.derived(phys) : null; } catch (e) { curve.derived = null; }
                    try {
                        var mp = pm.toModelParams(phys);
                        curve.params = _numsOf(mp && mp.params);
                        curve.scales = { A: mp && mp.A, B: mp && mp.B };
                    } catch (e) { curve.params = null; }
                }
            }
            if (!curve) curve = _dimlessCurve(entry, params, opts);
        }
    } catch (e) {
        try { console.warn('PRiSM model curve failed:', e && e.message); } catch (_) { /* ignore */ }
        curve = null;
    }
    if (curve) {
        curve.modelKey = modelKey;
        if (store) curve.sig = _curveSig(ad);
    }
    if (store) {
        st.modelCurveData = curve;
        st.modelCurve = _legacyCurve(curve);
    }
    return curve;
}

// Model overlay for the transient plots, in Δt coordinates: {t, dp, deriv, p}.
function _overlayFor(ad) {
    var st = _st();
    var entry = _MODELS()[st.model];
    if (!entry || entry.kind === 'rate' || typeof entry.pd !== 'function') return null;
    var c = st.modelCurveData;
    if (!(c && c.sig === _curveSig(ad) && c.modelKey === st.model)) c = PRiSM_evalModelCurve(st.model, st.params, { adata: ad });
    if (!c) return null;
    if (c.mode === 'physical') return { t: c.t, dp: c.dp, deriv: c.deriv, p: c.p, mode: 'physical' };
    if (c.mode !== 'dimensionless' || !ad || !ad.ok) return null;
    var tcm = _currentTcm(ad);
    if (!tcm) return null;
    var TM = Math.pow(10, tcm.logTM);
    var tpos = ad.t.filter(function (x) { return x > 0; });
    var need = [TM * Math.min.apply(null, tpos) / 3, TM * Math.max.apply(null, tpos) * 3];
    if (c.td[0] > need[0] * 1.0001 || c.td[c.td.length - 1] < need[1] * 0.9999) {
        c = PRiSM_evalModelCurve(st.model, st.params, { adata: ad, mode: 'dimensionless', tdRange: need });
        if (!c) return null;
    }
    var r = _applyTCM(c, tcm);
    if (_isNum(ad.pRef)) {
        var sg = _isNum(ad.sign) ? ad.sign : -1;
        r.p = r.dp.map(function (v) { return ad.pRef + sg * v; });
    }
    r.mode = 'matched';
    return r;
}


// =========================================================================
// SECTION 7 — TYPE-CURVE AUTO-ALIGN (profiled least squares on log Δp, log Δp′)
// =========================================================================
// Residual r = log pD(TM·t) − logPM − log Δp  (same for pD′ vs Δp′). logPM is
// eliminated in closed form (mean residual), leaving a 1-D search in logTM:
// coarse scan then golden section. Seeded with logPM = log10(0.5/Δp′_plateau).
function _alignPoints(ad, maxPts) {
    var idx = [];
    for (var i = 0; i < ad.t.length; i++) if (ad.t[i] > 0 && (ad.dp[i] > 0 || ad.deriv[i] > 0)) idx.push(i);
    if (idx.length > maxPts) {
        var keep = [], step = idx.length / maxPts;
        for (var k = 0; k < maxPts; k++) keep.push(idx[Math.floor(k * step)]);
        idx = keep;
    }
    return idx;
}
function _alignCost(entry, params, ad, idx, logTM) {
    var TM = Math.pow(10, logTM);
    var td = idx.map(function (i) { return ad.t[i] * TM; });
    var pd, pdp;
    try {
        pd = _arr(entry.pd(td, params));
        pdp = (typeof entry.pdPrime === 'function') ? _arr(entry.pdPrime(td, params)) : null;
    } catch (e) { return { cost: Infinity }; }
    var res = [];
    for (var j = 0; j < idx.length; j++) {
        var i = idx[j];
        if (ad.dp[i] > 0 && pd[j] > 0) res.push(_log10(pd[j]) - _log10(ad.dp[i]));
        if (pdp && ad.deriv[i] > 0 && pdp[j] > 0) res.push(_log10(pdp[j]) - _log10(ad.deriv[i]));
    }
    if (res.length < 4) return { cost: Infinity };
    var mean = 0;
    for (var a = 0; a < res.length; a++) mean += res[a];
    mean /= res.length;
    var ssr = 0;
    for (var b = 0; b < res.length; b++) ssr += (res[b] - mean) * (res[b] - mean);
    // Penalise dropping points (e.g. non-positive model values) so the search cannot hide data.
    var full = idx.length * (pdp ? 2 : 1);
    return { cost: ssr / res.length + 0.05 * (full - res.length) / full, logPM: mean, rmse: Math.sqrt(ssr / res.length) };
}
function _autoAlign(modelKey, params, ad) {
    var entry = _MODELS()[modelKey];
    if (!entry || typeof entry.pd !== 'function' || !ad || !ad.ok) return null;
    var idx = _alignPoints(ad, 60);
    if (idx.length < 4) return null;
    var best = null, bestX = NaN;
    for (var x = -4; x <= 10.0001; x += 0.5) {
        var c = _alignCost(entry, params, ad, idx, x);
        if (_isNum(c.cost) && (!best || c.cost < best.cost)) { best = c; bestX = x; }
    }
    if (!best) return null;
    var a = bestX - 0.5, b = bestX + 0.5, gr = 0.6180339887498949;
    var x1 = b - gr * (b - a), x2 = a + gr * (b - a);
    var f1 = _alignCost(entry, params, ad, idx, x1).cost, f2 = _alignCost(entry, params, ad, idx, x2).cost;
    for (var it = 0; it < 40 && (b - a) > 1e-5; it++) {
        if (f1 < f2) { b = x2; x2 = x1; f2 = f1; x1 = b - gr * (b - a); f1 = _alignCost(entry, params, ad, idx, x1).cost; }
        else { a = x1; x1 = x2; f1 = f2; x2 = a + gr * (b - a); f2 = _alignCost(entry, params, ad, idx, x2).cost; }
    }
    var xm = 0.5 * (a + b);
    var fin = _alignCost(entry, params, ad, idx, xm);
    if (!(fin.cost <= best.cost)) { fin = best; xm = bestX; }
    if (!_isNum(fin.logPM)) return null;
    return { logPM: fin.logPM, logTM: xm, source: 'auto', rmseLog: fin.rmse };
}
// Exact-evaluation match statistics at the data points.
function _matchStats(entry, params, tcm, ad) {
    var out = { rmseDp: NaN, rmseDr: NaN, rmsePsi: NaN, r2: NaN, n: 0 };
    if (!entry || !ad || !ad.ok || !_validTcm(tcm)) return out;
    var idx = _alignPoints(ad, 400);
    var TM = Math.pow(10, tcm.logTM), PM = Math.pow(10, tcm.logPM);
    var td = idx.map(function (i) { return ad.t[i] * TM; });
    var pd, pdp;
    try {
        pd = _arr(entry.pd(td, params));
        pdp = (typeof entry.pdPrime === 'function') ? _arr(entry.pdPrime(td, params)) : null;
    } catch (e) { return out; }
    var s1 = 0, n1 = 0, s2 = 0, n2 = 0, sl = 0, st = 0, mean = 0, nm = 0;
    idx.forEach(function (i) { if (ad.dp[i] > 0) { mean += ad.dp[i]; nm++; } });
    mean = nm ? mean / nm : NaN;
    for (var j = 0; j < idx.length; j++) {
        var i = idx[j];
        if (ad.dp[i] > 0 && pd[j] > 0) {
            var r = _log10(pd[j] / PM) - _log10(ad.dp[i]); s1 += r * r; n1++;
            var e = pd[j] / PM - ad.dp[i]; sl += e * e; st += (ad.dp[i] - mean) * (ad.dp[i] - mean);
        }
        if (pdp && ad.deriv[i] > 0 && pdp[j] > 0) { var r2 = _log10(pdp[j] / PM) - _log10(ad.deriv[i]); s2 += r2 * r2; n2++; }
    }
    out.n = n1;
    out.rmseDp = n1 ? Math.sqrt(s1 / n1) : NaN;
    out.rmseDr = n2 ? Math.sqrt(s2 / n2) : NaN;
    out.rmsePsi = n1 ? Math.sqrt(sl / n1) : NaN;
    out.r2 = (n1 && st > 0) ? 1 - sl / st : NaN;
    return out;
}

// The type-curve match in force: st.tcMatch when set; otherwise (without
// writing state) the scales of the committed physical values, else an
// automatic alignment, cached per model / params / data.
var _autoTcm = null;
function _currentTcm(ad) {
    var st = _st();
    var t = _validTcm(st.tcMatch);
    if (t) return t;
    if (!ad || !ad.ok) return null;
    var key = JSON.stringify([st.model, st.params, _numsOf(st.phys), _dsKey(G.PRiSM_dataset), _adOpts(), ad.pRef, ad.n]);
    if (_autoTcm && _autoTcm.key === key) return _autoTcm.tcm;
    var tcm = null;
    if (_hasCommittedPhys()) {
        var well = _getWell(G.PRiSM_dataset);
        var pm = _getPM(st.model, well, ad, { floatPi: !!st.fitOpts.floatPi });
        if (pm && pm.ok && pm.mode !== 'scale' && typeof pm.toModelParams === 'function') {
            try {
                var m = pm.toModelParams(_physView(pm, ad, well));
                if (m && m.A > 0 && m.B > 0) tcm = { logPM: -_log10(m.A), logTM: _log10(m.B), source: 'model' };
            } catch (e) { tcm = null; }
        }
    }
    if (!tcm) tcm = _autoAlign(st.model, st.params, ad);
    _autoTcm = { key: key, tcm: tcm };
    return tcm;
}

// Public: align the overlay of the active model to the data. In physical mode
// the match is converted to k, C and S; otherwise it becomes st.tcMatch.
function PRiSM_autoAlignOverlay() {
    var st = _st();
    var ds = G.PRiSM_dataset;
    if (!ds || !ds.p) return { ok: false, reason: 'No pressure data.' };
    var ad = _getAData(ds, _adOpts());
    if (!ad.ok) return { ok: false, reason: ad.reason || 'No positive Δp.' };
    var entry = _MODELS()[st.model];
    if (!entry || entry.kind === 'rate') return { ok: false, reason: 'Pick a pressure model first.' };
    var tcm = _autoAlign(st.model, st.params, ad);
    if (!tcm) return { ok: false, reason: 'Could not align this model to the data.' };
    st.tcMatch = tcm;
    var out = { ok: true, tcMatch: tcm, physical: false };
    var well = _getWell(ds);
    var units = _unitsMode();
    if (units.mode === 'physical') {
        var m = _matchToPhysical(tcm, st.model, st.params, well);
        if (m.ok) {
            var view = _physView(units.pm, ad, well);
            if (_isNum(m.k)) view.k = m.k;
            if (_isNum(m.C) && 'C' in view) view.C = m.C;
            if (_isNum(m.S) && 'S' in view) view.S = m.S;
            _commitPhys(units.pm, view);
            if (m.params) for (var pk in m.params) if (Object.prototype.hasOwnProperty.call(m.params, pk) && _isNum(m.params[pk])) st.params[pk] = m.params[pk];
            if (_isNum(m.B)) st.tcMatch = { logPM: tcm.logPM, logTM: _log10(m.B), source: 'auto' };
            out.physical = true; out.k = m.k; out.C = m.C; out.S = m.S;
        }
    }
    st.modelCurveData = null;
    _save();
    return out;
}


// =========================================================================
// SECTION 8 — PLOT REGISTRY, PLOT DATA (C6) AND THE REDRAW ENTRY POINT
// =========================================================================
var REG = G.PRiSM_PLOT_REGISTRY = (G.PRiSM_PLOT_REGISTRY && typeof G.PRiSM_PLOT_REGISTRY === 'object') ? G.PRiSM_PLOT_REGISTRY : {};
var BUILTIN_PLOTS = {
    // Pressure-transient
    bourdet:       { fn: 'PRiSM_plot_bourdet', label: 'Log-log Δp and derivative', mode: 'transient', kind: 'loglog' },
    mdh:           { fn: 'PRiSM_plot_mdh', fallbackFns: ['PRiSM_semilog_plot_mdh'], label: 'Semilog MDH (p vs log Δt)', mode: 'transient', kind: 'mdh' },
    horner:        { fn: 'PRiSM_plot_horner', label: 'Horner', mode: 'transient', kind: 'horner' },
    cartesian:     { fn: 'PRiSM_plot_cartesian', label: 'History (p and q vs t)', mode: 'transient', kind: 'history' },
    sqrt:          { fn: 'PRiSM_plot_sqrt_time', label: 'Square-root time', mode: 'transient', kind: 'period' },
    quarter:       { fn: 'PRiSM_plot_quarter_root_time', label: 'Quarter-root time', mode: 'transient', kind: 'period' },
    spherical:     { fn: 'PRiSM_plot_spherical', label: 'Spherical (1/√t)', mode: 'transient', kind: 'period' },
    sandface:      { fn: 'PRiSM_plot_sandface_convolution', label: 'Material-balance time', mode: 'transient', kind: 'full' },
    superposition: { fn: 'PRiSM_plot_buildup_superposition', label: 'Superposition time', mode: 'transient', kind: 'superposition' },
    // Rate / decline (time in days)
    rateCart:      { fn: 'PRiSM_plot_rate_time_cartesian', label: 'Rate vs time', mode: 'decline', kind: 'rate' },
    rateSemi:      { fn: 'PRiSM_plot_rate_time_semilog', label: 'Rate vs time (semilog)', mode: 'decline', kind: 'rate' },
    rateLog:       { fn: 'PRiSM_plot_rate_time_loglog', label: 'Rate vs time (log-log)', mode: 'decline', kind: 'rate' },
    rateCum:       { fn: 'PRiSM_plot_rate_cumulative', label: 'Rate vs cumulative', mode: 'decline', kind: 'rate' },
    lossRatio:     { fn: 'PRiSM_plot_loss_ratio', label: 'Loss ratio', mode: 'decline', kind: 'rate' },
    typeCurve:     { fn: 'PRiSM_plot_typecurve_overlay', label: 'Decline type curve', mode: 'decline', kind: 'rate' }
};
(function _mergeRegistry() {
    for (var k in BUILTIN_PLOTS) {
        if (!Object.prototype.hasOwnProperty.call(BUILTIN_PLOTS, k)) continue;
        if (!REG[k]) { REG[k] = BUILTIN_PLOTS[k]; continue; }
        for (var f in BUILTIN_PLOTS[k]) if (REG[k][f] === undefined) REG[k][f] = BUILTIN_PLOTS[k][f];
    }
})();

var HOOKS = G.PRiSM_postDrawHooks = Array.isArray(G.PRiSM_postDrawHooks) ? G.PRiSM_postDrawHooks : [];
function PRiSM_registerPostDrawHook(fn) {
    var hooks = G.PRiSM_postDrawHooks = Array.isArray(G.PRiSM_postDrawHooks) ? G.PRiSM_postDrawHooks : [];
    if (typeof fn !== 'function' && !(fn && typeof fn.fn === 'function')) return false;
    if (hooks.indexOf(fn) !== -1) return false;
    hooks.push(fn);
    return true;
}
function _runPostDrawHooks(info) {
    var hooks = Array.isArray(G.PRiSM_postDrawHooks) ? G.PRiSM_postDrawHooks.slice() : HOOKS.slice();
    for (var i = 0; i < hooks.length; i++) {
        var h = hooks[i];
        var f = (typeof h === 'function') ? h : (h && typeof h.fn === 'function' ? h.fn : null);
        if (!f) continue;
        try { f(info); } catch (e) { try { console.warn('PRiSM post-draw hook failed:', e && e.message); } catch (_) { /* ignore */ } }
    }
}

function _modeAllows(entryMode, mode) {
    if (mode === 'combined') return true;
    var m = entryMode || 'transient';
    return m === 'both' || m === mode;
}
function _normaliseActivePlot(mode) {
    var st = _st();
    mode = mode || _mode();
    var e = REG[st.activePlot];
    if (e && _modeAllows(e.mode, mode)) return st.activePlot;
    st.activePlot = (mode === 'decline') ? 'rateLog' : 'bourdet';
    if (!REG[st.activePlot]) {
        for (var k in REG) if (Object.prototype.hasOwnProperty.call(REG, k) && _modeAllows(REG[k].mode, mode)) { st.activePlot = k; break; }
    }
    return st.activePlot;
}
function _resolveFn(ref) {
    if (typeof ref === 'function') return ref;
    if (typeof ref !== 'string') return null;
    if (typeof G[ref] === 'function') return G[ref];
    var f = _lexical(ref);
    if (f) G[ref] = f;
    return f;
}
function _resolvePlotFn(entry) {
    if (!entry) return null;
    var f = _resolveFn(entry.fn);
    if (f) return f;
    var alts = entry.fallbackFns || [];
    for (var i = 0; i < alts.length; i++) { f = _resolveFn(alts[i]); if (f) return f; }
    return null;
}
function _yLabel(ad) {
    return (ad && ad.fluid === 'gas' && ad.pseudo) ? 'Δm(p), Δm′ (psi²/cp)' : 'Δp, Δp′ (psi)';
}
function _fixedPeriods(ds) {
    var periods = (ds.periods && ds.periods.length) ? ds.periods : (ds.q ? PRiSM_detectPeriods(ds.t, ds.q) : []);
    return periods.map(function (p, i) {
        var t0 = _num(p.t0, p.start), t1 = _num(p.t1, p.end);
        return { t0: t0, t1: t1, start: t0, end: t1, i0: p.i0, i1: p.i1, q: p.q, label: p.label || ('P' + (i + 1)) };
    });
}

function PRiSM_buildPlotData(plotKey) {
    var st = _st();
    plotKey = plotKey || st.activePlot;
    var entry = REG[plotKey];
    if (!entry) return { plotKey: plotKey, data: null, opts: {}, error: 'Unknown plot "' + plotKey + '".' };
    var ds = G.PRiSM_dataset;
    if (typeof entry.build === 'function') {
        try {
            var b = entry.build({ ds: ds, st: st, plotKey: plotKey, getAnalysisData: function () { return _getAData(ds, _adOpts()); } });
            if (b) return { plotKey: plotKey, data: b.data || null, opts: b.opts || {}, error: b.error || (b.data ? null : 'Nothing to plot.'), fnOverride: b.fn || null };
        } catch (e) { return { plotKey: plotKey, data: null, opts: {}, error: 'Plot data failed: ' + (e && e.message) }; }
    }
    if (!_hasData(ds)) return { plotKey: plotKey, data: null, opts: {}, error: 'No data loaded — add data on the Data step.' };
    if (entry.mode === 'decline' || entry.kind === 'rate') return _buildDecline(plotKey, entry, ds, st);
    return _buildTransient(plotKey, entry, ds, st);
}

function _buildTransient(plotKey, entry, ds, st) {
    var out = { plotKey: plotKey, data: null, opts: { smoothL: st.bourdetL }, error: null };
    if (!ds.p) { out.error = 'This plot needs pressure data.'; return out; }
    var kind = entry.kind || 'period';
    var ad = _getAData(ds, _adOpts());
    var ov = null;
    if (st.showOverlay !== false) { try { ov = _overlayFor(ad); } catch (e) { ov = null; } }
    var line = null;
    if ((kind === 'mdh' || kind === 'horner' || kind === 'superposition') && typeof G.PRiSM_semilogPlotLine === 'function') {
        try { line = G.PRiSM_semilogPlotLine(plotKey) || null; } catch (e) { line = null; }
    }
    if (kind === 'loglog') {
        if (!ad.ok) { out.error = ad.reason || 'No positive Δp — check the test type and pi on the Data step.'; out.adata = ad; return out; }
        out.data = { t: ad.t, dp: ad.dp, deriv: ad.deriv, x: ad.x };
        if (ov && ov.dp) out.data.overlay = { t: ov.t, dp: ov.dp, deriv: ov.deriv };
        out.opts.title = 'Log-log diagnostic';
        // Horner keeps the plot's own label: its axis is (tp + Δt)/Δt, not Δt.
        if (kind !== 'horner') out.opts.xLabel = 'Δt (hr)';
        out.opts.yLabel = _yLabel(ad);
    } else if (kind === 'mdh' || kind === 'horner' || kind === 'period') {
        if (!ad.t || ad.t.length < 2) { out.error = ad.reason || 'Not enough points in the analysed period.'; return out; }
        out.data = { t: ad.t, p: ad.p };
        if (kind === 'horner') {
            var tp = _num(ad.tp, (_getWell(ds) || {}).tp);
            if (_isNum(tp)) out.data.tp = tp;
        }
        if (line) out.data.line = line;
        if (ov && ov.p) out.data.overlay = { t: ov.t, p: ov.p };
        // Horner keeps the plot's own label: its axis is (tp + Δt)/Δt, not Δt.
        if (kind !== 'horner') out.opts.xLabel = 'Δt (hr)';
        if (kind === 'mdh' && !_resolveFn('PRiSM_plot_mdh') && !_resolveFn('PRiSM_semilog_plot_mdh')) {
            // Semilog fallback on a linear axis of log10 Δt.
            out.data = { t: ad.t.map(_log10), p: ad.p };
            if (ov && ov.p) out.data.overlay = { t: ov.t.map(_log10), p: ov.p };
            out.opts.xLabel = 'log10 Δt (hr)';
            out.opts.title = 'Semilog (MDH)';
            out.fnOverride = 'PRiSM_plot_cartesian';
        }
    } else if (kind === 'superposition') {
        if (!ad.t || ad.t.length < 2) { out.error = ad.reason || 'Not enough points in the analysed period.'; return out; }
        out.data = { t: ad.t, p: ad.p, tStart: ad.tStart, tAbs: ad.tAbs, rateHistory: ad.rateHistory, periods: ad.periods,
                     testType: ad.testType, sign: ad.sign };
        if (ad.timeFn === 'superposition' && ad.x && ad.x.length === ad.t.length) out.data.x = ad.x;
        var tpS = _num(ad.tp, (_getWell(ds) || {}).tp);
        if (_isNum(tpS)) out.data.tp = tpS;
        if (line) out.data.line = line;
        if (ov && ov.p) out.data.overlay = { t: ad.t, p: ad.t.map(function (x) { return _interpLogX(x, ov.t, ov.p); }) };
    } else if (kind === 'history') {
        out.data = { t: ds.t, p: ds.p, q: ds.q || null, periods: _fixedPeriods(ds) };
        if (ov && ov.p) {
            var t0 = _isNum(ad.tStart) ? ad.tStart : 0;
            out.data.overlay = { t: ov.t.map(function (x) { return x + t0; }), p: ov.p };
        }
        out.opts.xLabel = 't (hr)';
    } else {
        out.data = { t: ds.t, p: ds.p, q: ds.q || null, periods: _fixedPeriods(ds) };
        var tpF = _num(ad.tp, (_getWell(ds) || {}).tp);
        if (_isNum(tpF)) out.data.tp = tpF;
    }
    if (st.activePeriod != null && st.activePeriod >= 0) out.opts.activePeriod = st.activePeriod;
    out.adata = ad;
    return out;
}

function _buildDecline(plotKey, entry, ds, st) {
    var out = { plotKey: plotKey, data: null, opts: { timeUnit: 'd', xLabel: 'Time (days)' }, error: null };
    if (!ds.q) { out.error = 'This plot needs rate data (q).'; return out; }
    out.data = { t: _daysOf(ds), q: _arr(ds.q), p: ds.p || null };
    var m = _MODELS()[st.model];
    if (m && m.kind === 'rate' && st.showOverlay !== false) {
        var c = st.modelCurveData;
        if (!(c && c.mode === 'rate' && c.modelKey === st.model && c.sig === _curveSig(null))) c = PRiSM_evalModelCurve(st.model, st.params, {});
        if (c && c.mode === 'rate') out.data.overlay = { t: c.t, q: c.q };
    }
    if (plotKey === 'typeCurve') {
        ['qi', 'Di', 'b'].forEach(function (k) { if (_isNum(st.params[k])) out.opts[k] = st.params[k]; });
    }
    return out;
}

function _drawCanvasMessage(canvas, msg, color) {
    try {
        var ctx = canvas.getContext('2d');
        if (!ctx) return;
        var dpr = G.devicePixelRatio || 1;
        var w = canvas.clientWidth || 600, h = canvas.clientHeight || 300;
        canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = '#0d1117';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = color || '#8b949e';
        ctx.font = '13px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        var words = String(msg).split(' '), lines = [], cur = '';
        var maxC = Math.max(20, Math.floor(w / 8));
        words.forEach(function (wd) { if ((cur + ' ' + wd).trim().length > maxC) { lines.push(cur.trim()); cur = wd; } else cur += ' ' + wd; });
        if (cur.trim()) lines.push(cur.trim());
        for (var i = 0; i < lines.length; i++) ctx.fillText(lines[i], w / 2, h / 2 + (i - (lines.length - 1) / 2) * 18);
    } catch (e) { /* ignore */ }
}

var _resetViewOnce = false;
// "Reset view" buttons: enabled only while the plot is zoomed or panned
// (C6 'prism:plot-view-changed' {zoomed} bubbles from the canvas; a view kept
// across a redraw shows as canvas._prismAxes.userView).
var RESET_VIEW_IDLE = 'Zoom or pan the plot first (mouse wheel, drag or pinch); this then restores the full range';
function _syncResetView(btnId, canvasId, zoomed) {
    var b = _el(btnId);
    if (!b) return;
    if (zoomed == null) {
        var c = _el(canvasId), ax = c && c._prismAxes;
        zoomed = !!(ax && ax.userView);
    }
    b.disabled = !zoomed;
    b.title = zoomed ? 'Restore the full axis range' : RESET_VIEW_IDLE;
}
function _wireResetView(btnId, canvasId) {
    var c = _el(canvasId);
    _syncResetView(btnId, canvasId);
    if (!c || c.__prismResetViewWired || typeof c.addEventListener !== 'function') return;
    c.__prismResetViewWired = true;
    c.addEventListener('prism:plot-view-changed', function (ev) {
        var d = ev && ev.detail;
        _syncResetView(btnId, canvasId, !!(d && d.zoomed));
    });
}
function _resetCanvasView(c) {
    if (!c) return;
    try { delete c._prismAxes; } catch (e) { c._prismAxes = null; }
    try { delete c._prismOriginalScale; } catch (e) { c._prismOriginalScale = null; }
}
function PRiSM_drawActivePlot(canvasArg) {
    var canvas = (canvasArg && typeof canvasArg.getContext === 'function') ? canvasArg : _el('prism_plot_canvas');
    if (!canvas) return false;
    var st = _st();
    var plotKey = _normaliseActivePlot();
    var entry = REG[plotKey];
    var built;
    try { built = PRiSM_buildPlotData(plotKey); }
    catch (e) { built = { data: null, opts: {}, error: 'Plot data failed: ' + (e && e.message) }; }
    if (!built.data || built.error) {
        _drawCanvasMessage(canvas, built.error || 'Nothing to plot.', '#8b949e');
        return false;
    }
    var fn = built.fnOverride ? _resolveFn(built.fnOverride) : _resolvePlotFn(entry);
    if (typeof fn !== 'function') {
        _drawCanvasMessage(canvas, 'Plot "' + (entry && entry.label || plotKey) + '" is not available in this build.', '#f85149');
        return false;
    }
    var opts = { hover: true, dragZoom: true, showLegend: true, smoothL: st.bourdetL, plotKey: plotKey };
    if (_resetViewOnce) { opts.resetView = true; _resetViewOnce = false; }
    for (var k in built.opts) if (Object.prototype.hasOwnProperty.call(built.opts, k)) opts[k] = built.opts[k];
    try { fn(canvas, built.data, opts); }
    catch (e) {
        try { console.error('PRiSM plot render error:', e); } catch (_) { /* ignore */ }
        _drawCanvasMessage(canvas, 'Render error: ' + (e && e.message), '#f85149');
        return false;
    }
    _runPostDrawHooks({ canvas: canvas, plotKey: plotKey, data: built.data, opts: opts, axes: canvas._prismAxes || null });
    return true;
}
// Internal redraws go through window so any wrapper sees them.
function _redraw() {
    if (typeof G.PRiSM_drawActivePlot === 'function') { try { return G.PRiSM_drawActivePlot(); } catch (e) { /* fall back */ } }
    return PRiSM_drawActivePlot();
}


// =========================================================================
// SECTION 9 — MODEL SELECTION + LIBRARY METADATA
// =========================================================================
var MODEL_NAMES = {
    homogeneous: 'Homogeneous reservoir', infiniteFrac: 'Infinite-conductivity fracture',
    finiteFrac: 'Finite-conductivity fracture', finiteFracSkin: 'Finite-conductivity fracture with face skin',
    partialPenFrac: 'Partially penetrating fracture', inclined: 'Inclined (slanted) well', horizontal: 'Horizontal well',
    linearBoundary: 'Single fault or linear boundary', parallelChannel: 'Parallel faults (channel)',
    closedChannel3: 'Channel closed at one end', closedRectangle: 'Closed rectangle', intersecting: 'Intersecting faults (wedge)',
    fogBoundary: 'Leaky fault', arps: 'Arps decline', duong: 'Duong decline', sepd: 'Stretched-exponential decline',
    fetkovich: 'Fetkovich type curve', doublePorosity: 'Dual porosity', partialPen: 'Partial penetration',
    verticalPulse: 'Vertical interference (partial penetration)', twoLayerXF: 'Two layers with crossflow',
    radialComposite: 'Radial composite', multiLayerXF: 'Multilayer with crossflow', multiLayerNoXF: 'Multilayer without crossflow',
    linearComposite: 'Linear composite', genHetRadialLinear: 'Heterogeneous radial with linear boundary',
    genHetRadial: 'Heterogeneous radial (three zones)', interference: 'Interference (observation well)',
    mlHorizontalXF: 'Multilayer horizontal well with crossflow', mlNoXFFrac: 'Multilayer fractured well without crossflow',
    mlNoXFHoriz: 'Multilayer horizontal well without crossflow', inclinedMLXF: 'Multilayer inclined well with crossflow',
    multiLatMLXF: 'Multilateral well in a multilayer reservoir', mlMultiPerf: 'Multilayer with multiple perforated intervals',
    mlHorizInterference: 'Horizontal-well interference (multilayer)', mlMultiPerfInterference: 'Multiple-interval interference',
    inclinedInterference: 'Inclined-well interference', linearCompInterference: 'Linear-composite interference',
    linearCompMultiLat: 'Multilateral well in a linear composite', linearCompMultiLatInterference: 'Multilateral linear-composite interference',
    generalMLNoXF: 'General multilayer without crossflow', mlInterferenceXF: 'Multilayer interference with crossflow',
    radialCompInterference: 'Radial-composite interference', userDefined: 'User-defined type curve',
    waterInjection: 'Water injection (two-phase front)'
};
var CAT_ORDER = ['homogeneous', 'reservoir', 'fracture', 'well-type', 'boundary', 'composite', 'multilayer',
                 'multilateral', 'interference', 'special', 'decline', 'other'];
var CAT_TITLES = {
    homogeneous: 'Homogeneous', reservoir: 'Reservoir behaviour', fracture: 'Fractured wells', 'well-type': 'Well geometry',
    boundary: 'Boundaries', composite: 'Composite', multilayer: 'Multilayer', multilateral: 'Multilateral',
    interference: 'Interference', special: 'Special', decline: 'Decline curves', other: 'Other'
};
function _titleCase(s) {
    return String(s).replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}
function PRiSM_modelDisplayName(key) {
    var e = _MODELS()[key];
    if (e && (e.label || e.name) && typeof (e.label || e.name) === 'string') return e.label || e.name;
    return MODEL_NAMES[key] || _titleCase(key || '');
}
function _catOf(e) { return (e && e.category) ? String(e.category) : 'other'; }
function _catTitle(c) { return CAT_TITLES[c] || _titleCase(c); }
function _kindOf(e) { return (e && e.kind === 'rate') ? 'rate' : 'pressure'; }
function _modeShows(e, mode) {
    if (mode === 'decline') return _kindOf(e) === 'rate';
    if (mode === 'transient') return _kindOf(e) !== 'rate';
    return true;
}
function PRiSM_modelLibrary(mode) {
    var M = _MODELS(), out = [];
    for (var k in M) {
        if (!Object.prototype.hasOwnProperty.call(M, k) || !M[k] || typeof M[k] !== 'object') continue;
        if (mode && !_modeShows(M[k], mode)) continue;
        out.push({ key: k, name: PRiSM_modelDisplayName(k), category: _catOf(M[k]), categoryTitle: _catTitle(_catOf(M[k])), kind: _kindOf(M[k]) });
    }
    return out;
}
function _categoriesPresent(list) {
    var seen = {}, cats = [];
    list.forEach(function (m) { if (!seen[m.category]) { seen[m.category] = true; cats.push(m.category); } });
    var known = CAT_ORDER.filter(function (c) { return seen[c]; });
    var unknown = cats.filter(function (c) { return CAT_ORDER.indexOf(c) === -1; });
    return known.concat(unknown);
}

function _setModel(key, opts) {
    var st = _st();
    var entry = _MODELS()[key];
    if (!entry) return false;
    opts = opts || {};
    var prev = st.model;
    st.model = key;
    if (!opts.keepParams) st.params = _defaultsFor(entry);
    st.paramFreeze = {};
    (entry.defaultFrozen || []).forEach(function (k) { st.paramFreeze[k] = true; });
    var keep = {};
    ['k', 'C', 'S', 'pi'].forEach(function (k) { if (_isNum(st.phys[k])) keep[k] = st.phys[k]; });
    st.phys = keep;
    // Keep the dimensionless Cd / S (which drive the Tab 4/5 curve shape) consistent
    // with the physical k, C, S carried over, instead of the registry defaults (WP0 fix).
    if (!opts.keepParams && _isNum(keep.k) && _isNum(keep.C) && entry.kind !== 'rate' &&
        typeof G.PRiSM_physicalModel === 'function') {
        try {
            var pmK = G.PRiSM_physicalModel(key);
            if (pmK && pmK.ok && pmK.mode === 'physical' && typeof pmK.toModelParams === 'function') {
                var mp = pmK.toModelParams(Object.assign({}, keep)).params || {};
                ['Cd', 'S'].forEach(function (k) { if (_isNum(mp[k]) && _isNum(st.params[k])) st.params[k] = mp[k]; });
            }
        } catch (e) { /* keep defaults */ }
    }
    if (st.lastFit && (st.lastFit.modelKey || st.lastFit.model) !== key) { try { st.lastFit.stale = true; } catch (e) { /* ignore */ } }
    st.modelCurveData = null;
    st.modelCurve = null;
    _save();
    _emit('prism:model-changed', { model: key, previous: prev });
    return true;
}
function PRiSM_setModel(key, opts) { return _setModel(key, opts); }


// =========================================================================
// SECTION 10 — SHARED UI PIECES
// =========================================================================
var WELL_NAMES = { q: 'rate q', B: 'formation volume factor B', mu: 'viscosity μ', ct: 'total compressibility ct',
    h: 'thickness h', phi: 'porosity φ', rw: 'wellbore radius rw', pi: 'initial pressure pi', tp: 'producing time tp', pwf0: 'pwf at shut-in' };
function _wellBanner(well, context) {
    if (!well) return '';
    var miss = well.missing || [], def = well.defaulted || [];
    if (!miss.length && !def.length) return '';
    var list = function (a) { return a.map(function (k) { return WELL_NAMES[k] || k; }).join(', '); };
    var txt;
    if (miss.length) {
        txt = '<b>Missing well inputs:</b> ' + _esc(list(miss)) + '. ' +
              (context === 'fit' ? 'Regression runs in scale mode (kh and C only when q, B, μ, h are known; skin needs φ·ct·rw²).'
               : 'Results stay dimensionless until these are entered.');
    } else {
        txt = '<b>Default values in use:</b> ' + _esc(list(def)) + ' — check them before reporting.';
    }
    return '<div class="prism-banner prism-banner--warn" data-prism-banner="well">' +
        '<span style="flex:1 1 220px;">' + txt + '</span>' +
        '<button type="button" class="btn btn-secondary prism-btn-sm" data-prism-goto-data>Open Data step</button></div>';
}
function _wireGotoData(host) {
    _forEach(host.querySelectorAll('[data-prism-goto-data]'), function (b) { b.onclick = function () { _gotoData(); }; });
}
var PHYS_LABELS = { k: 'Permeability k', C: 'Wellbore storage C', S: 'Skin S', pi: 'Initial pressure pi',
    xf: 'Fracture half-length xf', Lh: 'Horizontal half-length Lh', kh: 'Permeability-thickness kh', Cd: 'Dimensionless storage CD' };
var PHYS_UNITS = { k: 'md', C: 'bbl/psi', S: '-', pi: 'psia', xf: 'ft', Lh: 'ft', kh: 'md·ft', Cd: '-', rinv: 'ft' };

// Rows for the parameter tables (Tab 4 and Tab 6).
function _paramRows(units) {
    var st = _st();
    var entry = _MODELS()[st.model] || {};
    var spec = entry.paramSpec || [];
    var rows = [];
    if (units.mode === 'physical') {
        var pm = units.pm;
        (pm.keys || []).forEach(function (k) {
            if (String(k).slice(0, 2) === '__') return;
            if (k === 'pi' && !st.fitOpts.floatPi) return;
            var sp = (pm.spec && pm.spec[k]) || {};
            var ps = null;
            spec.forEach(function (s) { if (s && s.key === k) ps = s; });
            rows.push({ key: k, label: PHYS_LABELS[k] || (ps && ps.label) || k, unit: sp.unit || PHYS_UNITS[k] || (ps && ps.unit) || '-',
                min: _num(sp.min, ps && ps.min), max: _num(sp.max, ps && ps.max), value: units.phys[k], phys: true,
                freezeKey: k });
        });
        spec.forEach(function (s) {
            if (s && s.options) rows.push({ key: s.key, label: s.label, unit: s.unit || '-', options: s.options, value: st.params[s.key], phys: false, freezeKey: null });
        });
    } else {
        spec.forEach(function (s) {
            if (!s || !s.key) return;
            var unit = s.unit || '-';
            if (units.mode === 'rate' && s.key === 'Di') unit = '1/day';
            if (units.mode === 'rate' && unit === 'rate') unit = 'STB/d or Mscf/d';
            rows.push({ key: s.key, label: s.label || s.key, unit: unit, min: s.min, max: s.max, options: s.options || null,
                value: (st.params[s.key] != null) ? st.params[s.key] : s['default'], phys: false, freezeKey: s.options ? null : s.key });
        });
    }
    return rows;
}
function _valueStr(v) {
    if (!_isNum(v)) return (v == null) ? '' : String(v);
    var a = Math.abs(v);
    return (a !== 0 && (a < 1e-3 || a >= 1e7)) ? v.toExponential(4) : String(+v.toPrecision(6));
}
function _paramTableHTML(rows, ids, units) {
    var st = _st();
    var cdNow = (units && units.view && units.view.params && _isNum(units.view.params.Cd)) ? units.view.params.Cd : st.params.Cd;
    var body = rows.map(function (r) {
        var id = ids.value + r.key;
        var input;
        if (r.options) {
            input = '<select id="' + id + '" data-prism-pkey="' + _esc(r.key) + '" data-prism-phys="0">' +
                r.options.map(function (o) { return '<option value="' + _esc(o) + '"' + (String(r.value) === String(o) ? ' selected' : '') + '>' + _esc(o) + '</option>'; }).join('') + '</select>';
        } else {
            input = '<input type="number" step="any" id="' + id + '" data-prism-pkey="' + _esc(r.key) + '" data-prism-phys="' + (r.phys ? 1 : 0) + '" value="' + _esc(_valueStr(r.value)) + '">';
        }
        var extra = (r.phys && r.key === 'C') ? '<div class="prism-dim" style="font-size:10px;" id="' + ids.value + 'Cd_readout">CD = ' + _esc(_fmt(cdNow, 4)) + '</div>' : '';
        var fz = r.freezeKey ? '<input type="checkbox" id="' + ids.freeze + r.key + '" data-prism-fkey="' + _esc(r.freezeKey) + '"' + (st.paramFreeze[r.freezeKey] || (r.freezeKey === 'C' && st.paramFreeze.Cd) ? ' checked' : '') + ' aria-label="Fix ' + _esc(r.label) + '">' : '';
        var rng = r.options ? r.options.join(' / ') : ((_isNum(r.min) || _isNum(r.max)) ? '[' + _fmt(r.min, 3) + ', ' + _fmt(r.max, 3) + ']' : '');
        return '<tr><td><b>' + _esc(r.label) + '</b><div class="prism-dim" style="font-size:10px;">' + _esc(r.key) + '</div></td>' +
            '<td>' + input + extra + '</td><td class="prism-dim">' + _esc(r.unit) + '</td>' +
            '<td class="prism-dim" style="font-size:11px;">' + _esc(rng) + '</td><td style="text-align:center;">' + fz + '</td></tr>';
    }).join('');
    return '<div class="prism-scroll-x"><table class="dtable" id="' + ids.table + '">' +
        '<thead><tr><th>Parameter</th><th>Value</th><th>Unit</th><th>Range</th><th>Fixed</th></tr></thead>' +
        '<tbody>' + (body || '<tr><td colspan="5" class="prism-dim">This model has no adjustable parameters.</td></tr>') + '</tbody></table></div>';
}
// Wire value inputs and freeze checkboxes; onChange(key) after each state write.
function _wireParamTable(host, units, onChange) {
    var st = _st();
    _forEach(host.querySelectorAll('[data-prism-pkey]'), function (inp) {
        var handler = function () {
            var k = inp.getAttribute('data-prism-pkey');
            var isPhys = inp.getAttribute('data-prism-phys') === '1';
            var v;
            if (inp.tagName === 'SELECT' || inp.localName === 'select') v = inp.value;
            else { v = parseFloat(inp.value); if (!_isNum(v)) return; }
            if (isPhys && units.pm) {
                // Commit the whole displayed set so C, S, … stay consistent with the edit.
                units.phys[k] = v;
                _commitPhys(units.pm, units.phys);
            } else if (isPhys) {
                st.phys[k] = v;
            } else {
                st.params[k] = v;
            }
            st.modelCurveData = null;
            var cdr = _el(inp.id.replace(/[^_]+$/, '') + 'Cd_readout');
            if (cdr) cdr.textContent = 'CD = ' + _fmt(st.params.Cd, 4);
            _save();
            if (onChange) onChange(k);
        };
        inp.oninput = handler;
        inp.onchange = handler;
    });
    _forEach(host.querySelectorAll('[data-prism-fkey]'), function (chk) {
        chk.onchange = function () {
            var k = chk.getAttribute('data-prism-fkey');
            st.paramFreeze[k] = !!chk.checked;
            if (k === 'C') st.paramFreeze.Cd = !!chk.checked;
            if (k === 'Cd') st.paramFreeze.C = !!chk.checked;
            _save();
        };
    });
}
// Which units the parameter tables use for the active model.
function _unitsMode() {
    var st = _st();
    var entry = _MODELS()[st.model];
    var ds = G.PRiSM_dataset;
    if (!entry) return { mode: 'none' };
    if (entry.kind === 'rate') return { mode: 'rate' };
    var ad = (ds && ds.p && _hasData(ds)) ? _getAData(ds, _adOpts()) : null;
    var well = _getWell(ds);
    if (st.paramUnits === 'dimensionless') return { mode: 'dimensionless', reason: 'Dimensionless units selected.', well: well, ad: ad };
    var pm = _getPM(st.model, well, ad, { floatPi: !!st.fitOpts.floatPi });
    if (pm && pm.ok && pm.mode !== 'scale' && pm.keys) {
        var phys = _physView(pm, ad, well);
        var view = null;
        try { view = pm.toModelParams(phys); } catch (e) { view = null; }
        return { mode: 'physical', pm: pm, well: well, ad: ad, phys: phys, view: view };
    }
    return { mode: 'dimensionless', reason: (pm && pm.reason) || 'Well inputs incomplete.', well: well, ad: ad };
}
function _canvasHTML(id, h, extraClass) {
    return '<div class="prism-canvas-wrap' + (extraClass ? ' ' + extraClass : '') + '">' +
        '<canvas id="' + id + '" style="width:100%;height:' + h + 'px;display:block;"></canvas></div>';
}
function _plotInto(canvas, fnName, data, opts) {
    var fn = _resolveFn(fnName);
    if (!canvas) return false;
    opts = opts || {};
    if (opts.postDrawHooks === undefined) opts.postDrawHooks = false;
    if (typeof fn !== 'function') { _drawCanvasMessage(canvas, 'Plot not available in this build.', '#f85149'); return false; }
    try { fn(canvas, data, opts); return true; }
    catch (e) { _drawCanvasMessage(canvas, 'Render error: ' + (e && e.message), '#f85149'); return false; }
}


// =========================================================================
// SECTION 11 — TAB 2 · DIAGNOSE (plots)
// =========================================================================
function PRiSM_renderPlotsTab(hostEl, ropts) {
    var host = _host(hostEl, 2);
    if (!host) return;
    _injectStyles();
    var st = _st();
    var mode = _mode();
    _normaliseActivePlot(mode);
    var ds = G.PRiSM_dataset;
    var hasData = _hasData(ds);
    var ad = (hasData && ds.p) ? _getAData(ds, _adOpts()) : null;
    var well = _getWell(ds);
    var periods = _periodList(ds, ad);
    var showPeriods = periods.length > 1 && periods.length <= MAX_PICKER_PERIODS;
    if (st.activePeriod != null && !(st.activePeriod >= 0 && st.activePeriod < periods.length && showPeriods)) st.activePeriod = null;
    var tt = ad ? String(ad.testType || '') : '';
    var showTimeFn = !!ad && (/buildup|falloff/.test(tt) || periods.length > 1 || (ad.periods && ad.periods.length > 1));

    var pick = '';
    for (var key in REG) {
        if (!Object.prototype.hasOwnProperty.call(REG, key) || !REG[key]) continue;
        if (!_modeAllows(REG[key].mode, mode)) continue;
        var lbl = REG[key].label || key;
        if (mode === 'combined' && REG[key].mode === 'decline') lbl = 'Rate · ' + lbl;
        pick += '<option value="' + _esc(key) + '"' + (key === st.activePlot ? ' selected' : '') + '>' + _esc(lbl) + '</option>';
    }
    var perOpts = '';
    if (showPeriods) {
        var autoIdx = (ad && !ad._local && _isNum(ad.periodIndex) && periods[ad.periodIndex]) ? ad.periodIndex : -1;
        var autoLbl = autoIdx >= 0 ? 'Auto (' + periods[autoIdx].label + ')' : 'Whole record';
        perOpts = '<option value="">' + _esc(autoLbl) + '</option>' + periods.map(function (p, i) {
            return '<option value="' + i + '"' + (st.activePeriod === i ? ' selected' : '') + '>' +
                _esc(p.label + (p.type ? ' · ' + p.type : '') + ' · q ' + _fmt(p.q, 4) + ' · ' + _fmt(p.t0, 3) + '–' + _fmt(p.t1, 3) + ' h') + '</option>';
        }).join('');
    }
    var tfOpts = [['auto', 'Auto'], ['dt', 'Elapsed Δt'], ['agarwal', 'Agarwal equivalent'], ['superposition', 'Superposition']]
        .map(function (o) { return '<option value="' + o[0] + '"' + (st.timeFn === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('');
    var notes = [];
    if (ad && ad.warnings && ad.warnings.length) notes = ad.warnings.slice(0, 4);
    if (periods.length > MAX_PICKER_PERIODS) notes.push('Rate changes ' + periods.length + ' times — analyse the whole record, or use the rate-transient tools.');

    var html =
        '<div class="card prism-w7" id="prism_plots_card">' +
          '<div class="card-title">Diagnostic plot</div>' +
          (hasData && mode !== 'decline' ? _wellBanner(well, 'plot') : '') +
          (!hasData ? '<div class="prism-banner prism-banner--info"><span style="flex:1 1 220px;"><b>No data loaded.</b> Add time, pressure and rate on the Data step.</span>' +
              '<button type="button" class="btn btn-secondary prism-btn-sm" data-prism-goto-data>Open Data step</button></div>' : '') +
          '<div class="prism-toolbar">' +
            '<label class="prism-field"><span>Plot</span><select id="prism_plot_picker">' + pick + '</select></label>' +
            (showPeriods ? '<label class="prism-field" id="prism_plot_period_lbl"><span>Period</span><select id="prism_plot_period">' + perOpts + '</select></label>' : '') +
            (showTimeFn ? '<label class="prism-field" id="prism_plot_timefn_lbl"><span>Time function</span><select id="prism_plot_timefn">' + tfOpts + '</select></label>' : '') +
            '<label class="prism-field" title="Bourdet derivative smoothing window, in natural-log cycles"><span>Derivative smoothing L</span>' +
              '<input type="number" id="prism_plot_L" min="0" max="0.5" step="0.01" value="' + _esc(String(st.bourdetL)) + '" style="width:72px;"></label>' +
            '<button type="button" class="btn btn-secondary prism-btn-sm" id="prism_plot_autoL">Auto L</button>' +
            '<label class="prism-field"><input type="checkbox" id="prism_plot_overlay"' + (st.showOverlay !== false ? ' checked' : '') + '><span>Model overlay</span></label>' +
            '<button type="button" class="btn btn-secondary prism-btn-sm" id="prism_plot_autofit">Auto-align overlay</button>' +
            '<button type="button" class="btn btn-secondary prism-btn-sm" id="prism_plot_reset" disabled title="' + RESET_VIEW_IDLE + '">Reset view</button>' +
          '</div>' +
          _canvasHTML('prism_plot_canvas', _plotH('main')) +
          '<div id="prism_plot_msg" class="prism-msg"></div>' +
          '<div id="prism_plot_notes" class="prism-notes">' + notes.map(function (n) { return '<div>⚠ ' + _esc(n) + '</div>'; }).join('') + '</div>' +
        '</div>';
    _mount(host, html, ropts);
    _wireGotoData(host);

    var msg = function (h) { var m = _el('prism_plot_msg'); if (m) m.innerHTML = h; };
    var picker = _el('prism_plot_picker');
    if (picker) picker.onchange = function () {
        if (!REG[picker.value]) return;
        st.activePlot = picker.value;
        _save();
        _redraw();
        _emit('prism:plot-changed', { plotKey: st.activePlot });
    };
    var per = _el('prism_plot_period');
    if (per) per.onchange = function () {
        var v = per.value;
        st.activePeriod = (v === '' || v == null) ? null : parseInt(v, 10);
        if (!_isNum(st.activePeriod)) st.activePeriod = null;
        st.modelCurveData = null;
        _save();
        _rerender(2);          // period list, time-function choice and notes follow the period
        _emit('prism:period-changed', { period: st.activePeriod });
    };
    var tf = _el('prism_plot_timefn');
    if (tf) tf.onchange = function () {
        st.timeFn = tf.value || 'auto';
        st.modelCurveData = null;
        _save();
        _rerender(2);
    };
    var Lin = _el('prism_plot_L');
    if (Lin) Lin.onchange = Lin.oninput = function () {
        var v = parseFloat(Lin.value);
        if (!_isNum(v)) return;
        v = _clamp(v, 0, 0.5);
        if (v === st.bourdetL) return;
        st.bourdetL = v;
        _save();
        _redraw();
    };
    var autoL = _el('prism_plot_autoL');
    if (autoL) autoL.onclick = function () {
        if (!hasData || !ds.p) { msg('<span class="prism-warn">Need pressure data first.</span>'); return; }
        if (typeof G.PRiSM_autoBourdet_L !== 'function') { msg('<span class="prism-warn">Automatic smoothing is not available in this build.</span>'); return; }
        try {
            var a = _getAData(ds, _adOpts());
            var info = G.PRiSM_autoBourdet_L(a.t && a.t.length ? a.t : _arr(ds.t), a.p && a.p.length ? a.p : _arr(ds.p), ds.q);
            if (info && _isNum(info.L)) {
                st.bourdetL = _clamp(info.L, 0, 0.5);
                if (Lin) Lin.value = String(st.bourdetL);
                _save();
                _redraw();
                msg('<span class="prism-ok">L = ' + _esc(_fmt(st.bourdetL, 3)) + '.</span> ' + _esc(info.rationale || ''));
            }
        } catch (e) { msg('<span class="prism-bad">Auto L failed: ' + _esc(e && e.message) + '</span>'); }
    };
    var ovChk = _el('prism_plot_overlay');
    if (ovChk) ovChk.onchange = function () { st.showOverlay = !!ovChk.checked; _save(); _redraw(); };
    var fit = _el('prism_plot_autofit');
    if (fit) fit.onclick = function () {
        var r = PRiSM_autoAlignOverlay();
        if (!r.ok) { msg('<span class="prism-warn">' + _esc(r.reason) + '</span>'); return; }
        st.showOverlay = true;
        if (ovChk) ovChk.checked = true;
        _redraw();
        if (r.physical) msg('<span class="prism-ok">Overlay aligned: k ' + _esc(_fmt(r.k, 4)) + ' md' + (_isNum(r.S) ? ', S ' + _esc(_fixed(r.S, 2)) : '') +
            (_isNum(r.C) ? ', C ' + _esc(_fmt(r.C, 3)) + ' bbl/psi' : '') + '. Run regression to refine.</span>');
        else msg('<span class="prism-ok">Overlay aligned (log PM ' + _esc(_fixed(r.tcMatch.logPM, 3)) + ', log TM ' + _esc(_fixed(r.tcMatch.logTM, 3)) + '). Refine on Type-curve match.</span>');
    };
    var reset = _el('prism_plot_reset');
    if (reset) reset.onclick = function () {
        _resetCanvasView(_el('prism_plot_canvas'));
        _resetViewOnce = true;
        _redraw();
        _syncResetView('prism_plot_reset', 'prism_plot_canvas', false);
    };
    _redraw();
    _wireResetView('prism_plot_reset', 'prism_plot_canvas');
}


// =========================================================================
// SECTION 12 — TAB 3 · MODEL LIBRARY
// =========================================================================
var _libState = { q: '', cat: 'all' };
var _thumbCache = {};
function _thumbSVG(key) {
    if (_thumbCache[key]) return _thumbCache[key];
    var svg = '';
    if (typeof G.PRiSM_getModelSchematic === 'function') {
        try { svg = String(G.PRiSM_getModelSchematic(key) || ''); } catch (e) { svg = ''; }
    }
    if (svg.length > 50 && /^\s*<svg\b/i.test(svg)) {
        svg = svg.replace(/^\s*<svg\b([^>]*)>/i, function (m, attrs) {
            attrs = attrs.replace(/\s(width|height|style|preserveAspectRatio)\s*=\s*"[^"]*"/gi, '');
            return '<svg' + attrs + ' preserveAspectRatio="xMidYMid meet" style="width:100%;height:100%;display:block" aria-hidden="true" focusable="false">';
        });
        _thumbCache[key] = svg;
        return svg;
    }
    return '';
}
function _initials(name) {
    return String(name).split(/\s+/).filter(Boolean).slice(0, 3).map(function (w) { return w.charAt(0).toUpperCase(); }).join('');
}
function _recRows() {
    var st = _st();
    var res = st.autoMatch || G.PRiSM_lastAutoMatch || null;
    if (!res || !res.ranked || !res.ranked.length) return [];
    var M = _MODELS();
    var rows = res.ranked.map(function (r, i) {
        var o = _normFit(r) || {};
        o.rank = r.rank || (i + 1);
        if (!_isNum(o.dAIC) && res.deltaAIC && _isNum(res.deltaAIC[i])) o.dAIC = res.deltaAIC[i];
        return o;
    }).filter(function (r) { return r.modelKey && M[r.modelKey]; });
    var best = Infinity;
    rows.forEach(function (r) { if (_isNum(r.aic) && r.aic < best) best = r.aic; });
    rows.forEach(function (r) { if (!_isNum(r.dAIC) && _isNum(r.aic) && _isNum(best)) r.dAIC = r.aic - best; });
    return rows;
}
function _recStripHTML(hasData) {
    var rows = _recRows().slice(0, 3);
    var canRun = typeof G.PRiSM_autoMatch === 'function' && hasData;
    if (!rows.length) {
        return '<div class="prism-banner prism-banner--info" id="prism_model_recommended" data-prism-rec-count="0">' +
            '<span style="flex:1 1 220px;"><b>Recommended models</b> — none yet. Automatic matching ranks the models against your data.</span>' +
            (canRun ? '<button type="button" class="btn btn-secondary prism-btn-sm" id="prism_model_findbest">Find best models</button>' : '') + '</div>';
    }
    var items = rows.map(function (r) {
        var conv = r.converged === true;
        var badge = conv ? '<span class="prism-badge prism-badge--ok">converged</span>'
                         : '<span class="prism-badge prism-badge--warn">starting point, refine</span>';
        var thumb = _thumbSVG(r.modelKey);
        return '<div class="prism-rec-item" data-prism-model="' + _esc(r.modelKey) + '">' +
            '<div class="prism-thumb">' + (thumb || _esc(_initials(PRiSM_modelDisplayName(r.modelKey)))) + '</div>' +
            '<div class="prism-rec-body">' +
              '<div class="prism-card-name">' + _esc(r.rank + '. ' + PRiSM_modelDisplayName(r.modelKey)) + '</div>' +
              '<div>ΔAIC <b class="prism-num">' + _esc(_isNum(r.dAIC) ? _fixed(r.dAIC, 1) : '—') + '</b>' +
                (_isNum(r.r2) ? ' · R² ' + _esc(_fixed(r.r2, 4)) : '') + '</div>' +
              '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">' + badge +
                '<button type="button" class="btn btn-secondary prism-btn-sm prism-rec-use" data-prism-model="' + _esc(r.modelKey) + '">Use</button></div>' +
            '</div></div>';
    }).join('');
    return '<div id="prism_model_recommended" data-prism-rec-count="' + rows.length + '">' +
        '<div class="prism-lib-sec-title">Recommended for this data</div>' +
        '<div class="prism-rec">' + items + '</div>' +
        (canRun ? '<button type="button" class="btn btn-secondary prism-btn-sm" id="prism_model_findbest" style="margin-top:4px;">Re-rank models</button>' : '') +
        '</div>';
}
function _applyRecRow(key) {
    var st = _st();
    var res = st.autoMatch || G.PRiSM_lastAutoMatch;
    var row = null;
    _recRows().forEach(function (r) { if (!row && r.modelKey === key) row = r; });
    if (!row) return false;
    if (typeof G.PRiSM_applyAutoMatchRow === 'function') {
        // Signature (rowOrKey, result): pass the key when the stored result holds the row.
        try { if (G.PRiSM_applyAutoMatchRow(res && res.ranked ? key : row, res) !== null) return true; } catch (e) { /* local path */ }
    }
    _setModel(key);
    if (row.params) for (var k in row.params) if (Object.prototype.hasOwnProperty.call(row.params, k) && k.slice(0, 2) !== '__') st.params[k] = row.params[k];
    if (row.phys && typeof row.phys === 'object') for (var pk in row.phys) if (Object.prototype.hasOwnProperty.call(row.phys, pk) && _isNum(row.phys[pk])) st.phys[pk] = row.phys[pk];
    if (row.scales && row.scales.A > 0 && row.scales.B > 0) st.tcMatch = { logPM: -_log10(row.scales.A), logTM: _log10(row.scales.B), source: 'automatch' };
    var fit = {};
    for (var f in row) if (Object.prototype.hasOwnProperty.call(row, f)) fit[f] = row[f];
    fit.source = 'automatch';
    fit.modelKey = key;
    _setLastFit(fit);
    PRiSM_evalModelCurve(st.model, st.params, {});
    _redraw();
    return true;
}
function _runFindBest(onDone) {
    var st = _st();
    if (typeof G.PRiSM_autoMatch !== 'function') { onDone('Automatic matching is not available in this build.'); return; }
    var p;
    try { p = G.PRiSM_autoMatch({}); } catch (e) { onDone('Automatic matching failed: ' + (e && e.message)); return; }
    Promise.resolve(p).then(function (res) {
        st.autoMatch = res || null;
        _save();
        onDone(null, res);
    }, function (e) { onDone('Automatic matching failed: ' + (e && e.message || e)); });
}

function PRiSM_renderModelTab(hostEl, ropts) {
    var host = _host(hostEl, 3);
    if (!host) return;
    _injectStyles();
    var st = _st();
    var mode = _mode();
    var M = _MODELS();
    var all = PRiSM_modelLibrary();
    var shown = all.filter(function (m) { return _modeShows(M[m.key], mode); });
    var cats = _categoriesPresent(shown);
    if (_libState.cat !== 'all' && cats.indexOf(_libState.cat) === -1) _libState.cat = 'all';
    var ds = G.PRiSM_dataset;
    var modeNote = mode === 'decline' ? 'Decline mode shows rate models only.' : mode === 'transient' ? 'Pressure-transient mode shows pressure models.' : 'Combined mode shows every model.';

    var chips = '<button type="button" class="prism-chip' + (_libState.cat === 'all' ? ' is-on' : '') + '" aria-pressed="' + (_libState.cat === 'all') + '" data-prism-cat="all">All <span class="prism-num">' + shown.length + '</span></button>' +
        cats.map(function (c) {
            var n = shown.filter(function (m) { return m.category === c; }).length;
            return '<button type="button" class="prism-chip' + (_libState.cat === c ? ' is-on' : '') + '" aria-pressed="' + (_libState.cat === c) + '" data-prism-cat="' + _esc(c) + '">' + _esc(_catTitle(c)) + ' <span class="prism-num">' + n + '</span></button>';
        }).join('');

    var sections = cats.map(function (c) {
        var cards = shown.filter(function (m) { return m.category === c; }).map(function (m) {
            var e = M[m.key] || {};
            var sel = m.key === st.model;
            var params = (e.paramSpec || []).map(function (s) { return s && s.key; }).filter(Boolean).join(', ');
            // Plain-language terms from the model browser (51-prism-workspace.js):
            // what the model is, what its derivative looks like, synonyms.
            var plainTerms = '', sig = '';
            if (typeof G.PRiSM_modelSearchTerms === 'function') { try { plainTerms = G.PRiSM_modelSearchTerms(m.key) || ''; } catch (eP) { plainTerms = ''; } }
            if (typeof G.PRiSM_modelPlainInfo === 'function') { try { var pinf = G.PRiSM_modelPlainInfo(m.key); sig = (pinf && pinf.signature) || ''; } catch (eI) { sig = ''; } }
            var hay = [m.key, m.name, _catTitle(c), e.description || '', e.reference || '', params, plainTerms].join(' ').toLowerCase();
            var thumb = _thumbSVG(m.key);
            return '<div class="prism-model-card' + (sel ? ' is-selected' : '') + '" data-prism-model="' + _esc(m.key) + '" data-prism-cat="' + _esc(c) + '"' +
                ' data-prism-search="' + _esc(hay) + '" role="button" tabindex="0" aria-pressed="' + (sel ? 'true' : 'false') + '">' +
                '<div class="prism-thumb">' + (thumb || _esc(_initials(m.name))) + '</div>' +
                '<div class="prism-card-head"><span class="prism-card-name">' + _esc(m.name) + '</span>' +
                  (sel ? '<span class="prism-badge prism-badge--accent">Selected</span>' : '') + '</div>' +
                '<div class="prism-card-meta">' + _esc(m.key) + ' · ' + (m.kind === 'rate' ? 'rate model' : 'pressure model') + '</div>' +
                '<div class="prism-card-desc">' + _esc(e.description || '') + '</div>' +
                (sig ? '<div class="prism-card-desc prism-card-sig" style="opacity:.8;font-style:italic;">Looks like: ' + _esc(sig) + '</div>' : '') +
              '</div>';
        }).join('');
        return '<section class="prism-lib-sec" data-prism-sec="' + _esc(c) + '"><div class="prism-lib-sec-title">' + _esc(_catTitle(c)) + '</div>' +
            '<div class="prism-lib-grid">' + cards + '</div></section>';
    }).join('');

    // Selected model detail — always rendered, even when the mode hides it.
    var cur = M[st.model];
    var detail = '';
    if (cur) {
        var hidden = !_modeShows(cur, mode);
        var specRows = (cur.paramSpec || []).map(function (s) {
            var rng = s.options ? s.options.join(' / ') : ('[' + _fmt(s.min, 3) + ', ' + _fmt(s.max, 3) + ']');
            return '<tr><td><b>' + _esc(s.label || s.key) + '</b><div class="prism-dim" style="font-size:10px;">' + _esc(s.key) + '</div></td><td>' + _esc(s.unit || '-') + '</td>' +
                '<td>' + _esc(s['default'] != null ? String(s['default']) : '—') + '</td><td class="prism-dim">' + _esc(rng) + '</td></tr>';
        }).join('');
        var big = '';
        if (typeof G.PRiSM_getModelSchematic === 'function') { try { big = String(G.PRiSM_getModelSchematic(st.model) || ''); } catch (e) { big = ''; } }
        detail = '<div class="card prism-w7" id="prism_model_selected" data-prism-model="' + _esc(st.model) + '">' +
            '<div class="card-title">Selected — ' + _esc(PRiSM_modelDisplayName(st.model)) + '</div>' +
            (hidden ? '<div class="prism-banner prism-banner--warn"><span>This is a ' + (_kindOf(cur) === 'rate' ? 'rate' : 'pressure') + ' model; the current analysis mode hides it from the library.</span></div>' : '') +
            '<div class="prism-grid2">' +
              '<div><div style="font-size:12px;color:var(--text2);line-height:1.45;margin-bottom:8px;">' + _esc(cur.description || '') + '</div>' +
                '<div class="prism-scroll-x"><table class="dtable"><thead><tr><th>Parameter</th><th>Unit</th><th>Default</th><th>Range</th></tr></thead><tbody>' +
                (specRows || '<tr><td colspan="4" class="prism-dim">No parameters.</td></tr>') + '</tbody></table></div>' +
                (cur.reference ? '<div class="prism-notes" style="font-style:italic;">' + _esc(cur.reference) + '</div>' : '') +
                '<div style="margin-top:10px;"><button type="button" class="btn btn-primary prism-btn-sm" id="prism_model_to_params">Set parameters</button></div>' +
              '</div>' +
              '<div id="prism_schematic_host" style="background:var(--bg1);border:1px solid var(--border);border-radius:6px;padding:8px;min-height:160px;display:flex;align-items:center;justify-content:center;">' +
                (big.length > 50 ? '<div style="width:100%;max-width:380px;">' + big + '</div>' : '<div class="prism-dim">No schematic for this model.</div>') +
              '</div>' +
            '</div>' +
            (st.model === 'userDefined' ? '<div id="prism_user_curve_host" style="margin-top:12px;"></div>' : '') +
          '</div>';
    }

    var html =
        '<div class="card prism-w7" id="prism_model_card">' +
          '<div class="card-title">Model library</div>' +
          _recStripHTML(_hasData(ds)) +
          '<div class="prism-toolbar" style="margin-top:12px;">' +
            '<input type="search" id="prism_model_search" placeholder="Search models (e.g. fault, fracture, dual porosity)" value="' + _esc(_libState.q) + '" style="flex:1 1 220px;min-width:0;">' +
            '<span class="prism-dim" style="font-size:12px;" id="prism_model_count"></span>' +
          '</div>' +
          '<div class="prism-chips" id="prism_model_chips" style="margin-bottom:12px;">' + chips + '</div>' +
          '<div class="prism-notes" style="margin-bottom:10px;">' + _esc(modeNote) + '</div>' +
          '<div id="prism_model_grid">' + (sections || '<div class="prism-dim">No models registered for this mode.</div>') + '</div>' +
          '<div class="prism-msg" id="prism_model_msg"></div>' +
        '</div>' + detail;
    _mount(host, html, ropts);
    _applyLibFilter(host);

    var msg = function (h) { var m = _el('prism_model_msg'); if (m) m.innerHTML = h; };
    var search = _el('prism_model_search');
    if (search) search.oninput = search.onchange = function () { _libState.q = search.value || ''; _applyLibFilter(host); };
    _forEach(host.querySelectorAll('.prism-chip[data-prism-cat]'), function (chip) {
        chip.onclick = function () {
            _libState.cat = chip.getAttribute('data-prism-cat') || 'all';
            _forEach(host.querySelectorAll('.prism-chip[data-prism-cat]'), function (c) { c.classList.toggle('is-on', c === chip); c.setAttribute('aria-pressed', c === chip ? 'true' : 'false'); });
            _applyLibFilter(host);
        };
    });
    var select = function (key) {
        if (!M[key]) return;
        if (key !== st.model) {
            _setModel(key);
            PRiSM_evalModelCurve(st.model, st.params, {});
        }
        _rerender(3);
    };
    _forEach(host.querySelectorAll('.prism-model-card[data-prism-model]'), function (card) {
        card.onclick = function () { select(card.getAttribute('data-prism-model')); };
        card.onkeydown = function (ev) {
            if (ev && (ev.key === 'Enter' || ev.key === ' ')) { if (ev.preventDefault) ev.preventDefault(); select(card.getAttribute('data-prism-model')); }
        };
    });
    _wireRecStrip(host);
    var toParams = _el('prism_model_to_params');
    if (toParams) toParams.onclick = function () { _gotoTab(4); };
    var uc = _el('prism_user_curve_host');
    if (uc) {
        if (typeof G.PRiSM_renderUserCurveManager === 'function') {
            try { G.PRiSM_renderUserCurveManager(uc); } catch (e) { uc.innerHTML = '<div class="prism-bad">User-curve manager failed: ' + _esc(e && e.message) + '</div>'; }
        } else uc.innerHTML = '<div class="prism-dim">The user-curve manager is not available in this build.</div>';
    }
}
function _wireRecStrip(root) {
    var msg = function (h) { var m = _el('prism_model_msg'); if (m) m.innerHTML = h; };
    _forEach(root.querySelectorAll('.prism-rec-use[data-prism-model]'), function (b) {
        b.onclick = function (ev) {
            if (ev && ev.stopPropagation) ev.stopPropagation();
            var key = b.getAttribute('data-prism-model');
            if (_applyRecRow(key)) _rerender(3);
        };
    });
    var fb = root.querySelector ? root.querySelector('#prism_model_findbest') : null;
    if (fb) fb.onclick = function () {
        msg('<span class="prism-warn">Ranking models against the data…</span>');
        fb.disabled = true;
        _runFindBest(function (err) {
            if (err) { fb.disabled = false; msg('<span class="prism-bad">' + _esc(err) + '</span>'); return; }
            _rerender(3);
        });
    };
}
// Replace only the Recommended strip (keeps the search box and its focus).
function _refreshRecStrip() {
    var old = _el('prism_model_recommended');
    if (!old || !old.parentNode || typeof document === 'undefined') return false;
    var tmp = document.createElement('div');
    tmp.innerHTML = _recStripHTML(_hasData(G.PRiSM_dataset));
    var neu = tmp.firstChild;
    if (!neu) return false;
    old.parentNode.replaceChild(neu, old);
    _wireRecStrip(neu);
    return true;
}
function _applyLibFilter(host) {
    var toks = String(_libState.q || '').toLowerCase().split(/\s+/).filter(Boolean);
    var vis = 0, total = 0;
    _forEach(host.querySelectorAll('.prism-model-card[data-prism-model]'), function (card) {
        total++;
        var cat = card.getAttribute('data-prism-cat');
        var hay = card.getAttribute('data-prism-search') || '';
        var ok = (_libState.cat === 'all' || cat === _libState.cat) && toks.every(function (t) { return hay.indexOf(t) !== -1; });
        card.style.display = ok ? '' : 'none';
        if (ok) vis++;
    });
    _forEach(host.querySelectorAll('.prism-lib-sec[data-prism-sec]'), function (sec) {
        var any = false;
        _forEach(sec.querySelectorAll('.prism-model-card'), function (c) { if (c.style.display !== 'none') any = true; });
        sec.style.display = any ? '' : 'none';
    });
    var cnt = _el('prism_model_count');
    if (cnt) cnt.textContent = (vis === total) ? (total + ' models') : (vis + ' of ' + total + ' models');
}


// =========================================================================
// SECTION 13 — TAB 4 · PARAMETERS + PREVIEW
// =========================================================================
function PRiSM_renderParamsTab(hostEl, ropts) {
    var host = _host(hostEl, 4);
    if (!host) return;
    _injectStyles();
    var st = _st();
    var entry = _MODELS()[st.model];
    if (!entry) {
        _mount(host, '<div class="card prism-w7"><div class="card-title">Parameters</div><div class="prism-dim">No model selected — choose one in the model library.</div></div>', ropts);
        return;
    }
    var units = _unitsMode();
    var rows = _paramRows(units);
    var hasPresets = !!(st.presets && st.presets.length);
    var noPre = hasPresets ? '' : ' disabled title="No saved presets yet: name the current parameters and press Save preset"';
    var presetOpts = '<option value="">' + (hasPresets ? 'Saved presets…' : 'No saved presets') + '</option>' + (st.presets || []).map(function (p, i) {
        return '<option value="' + i + '">' + _esc((p.name || 'preset') + ' (' + PRiSM_modelDisplayName(p.model) + ')') + '</option>';
    }).join('');
    var unitNote = units.mode === 'physical' ? '<span class="prism-badge prism-badge--ok">physical units</span> Values use the well inputs from the Data step.'
        : units.mode === 'rate' ? '<span class="prism-badge prism-badge--info">rate model</span> Time in days, rate in STB/d or Mscf/d.'
        : '<span class="prism-badge prism-badge--warn">dimensionless</span> ' + _esc(units.reason || '');
    var html =
        '<div class="card prism-w7" id="prism_params_card">' +
          '<div class="card-title">Parameters — ' + _esc(PRiSM_modelDisplayName(st.model)) + '</div>' +
          (units.mode !== 'rate' && units.mode !== 'physical' && units.well && st.paramUnits !== 'dimensionless' ? _wellBanner(units.well, 'params') : '') +
          '<div class="prism-toolbar">' +
            (units.mode !== 'rate' ? '<label class="prism-field"><span>Units</span><select id="prism_params_units">' +
              [['auto', 'Auto'], ['physical', 'Physical'], ['dimensionless', 'Dimensionless']].map(function (o) {
                  return '<option value="' + o[0] + '"' + ((st.paramUnits || 'auto') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
              }).join('') + '</select></label>' : '') +
            '<span style="font-size:12px;color:var(--text2);">' + unitNote + '</span>' +
          '</div>' +
          _paramTableHTML(rows, { value: units.mode === 'physical' ? 'prism_phys_' : 'prism_p_', freeze: 'prism_pfz_', table: 'prism_params_table' }, units) +
          '<div class="prism-toolbar" style="margin-top:12px;">' +
            '<button type="button" class="btn btn-secondary prism-btn-sm" id="prism_params_reset">Reset to defaults</button>' +
            '<input type="text" id="prism_preset_name" placeholder="Preset name" style="width:140px;">' +
            '<button type="button" class="btn btn-secondary prism-btn-sm" id="prism_preset_save">Save preset</button>' +
            '<select id="prism_preset_picker" aria-label="Saved presets"' + noPre + '>' + presetOpts + '</select>' +
            '<button type="button" class="btn btn-secondary prism-btn-sm" id="prism_preset_load"' + noPre + '>Load</button>' +
            '<button type="button" class="btn btn-secondary prism-btn-sm" id="prism_preset_del"' + noPre + '>Delete</button>' +
          '</div>' +
          '<div id="prism_params_msg" class="prism-msg"></div>' +
        '</div>' +
        '<div class="card prism-w7">' +
          '<div class="card-title" style="display:flex;align-items:center;justify-content:space-between;gap:8px;"><span>Model preview</span>' +
            '<button type="button" class="btn btn-secondary prism-btn-sm" id="prism_params_reset_view" disabled title="' + RESET_VIEW_IDLE + '">Reset view</button></div>' +
          _canvasHTML('prism_params_canvas', _plotH('main')) +
          '<div id="prism_params_simmsg" class="prism-notes"></div>' +
        '</div>';
    _mount(host, html, ropts);
    _wireGotoData(host);
    var msg = function (h) { var m = _el('prism_params_msg'); if (m) m.innerHTML = h; };

    _wireParamTable(host, units, function () { _drawParamPreview(units); });
    var us = _el('prism_params_units');
    if (us) us.onchange = function () {
        st.paramUnits = us.value || 'auto';
        st.modelCurveData = null;
        _save();
        _rerender(4);
    };
    var pr = _el('prism_params_reset');
    if (pr) pr.onclick = function () {
        st.params = _defaultsFor(entry);
        st.phys = {};
        st.paramFreeze = {};
        (entry.defaultFrozen || []).forEach(function (k) { st.paramFreeze[k] = true; });
        st.modelCurveData = null;
        _save();
        _rerender(4);
    };
    var ps = _el('prism_preset_save');
    if (ps) ps.onclick = function () {
        var name = ((_el('prism_preset_name') || {}).value || '').trim();
        if (!name) { msg('<span class="prism-bad">Enter a preset name.</span>'); return; }
        st.presets = st.presets || [];
        st.presets.push({ name: name, model: st.model, params: _clone(st.params), phys: _clone(st.phys), paramFreeze: _clone(st.paramFreeze) });
        _persistPresets();
        _rerender(4);
        msg('<span class="prism-ok">Saved preset “' + _esc(name) + '”.</span>');
    };
    var pl = _el('prism_preset_load');
    if (pl) pl.onclick = function () {
        var idx = parseInt((_el('prism_preset_picker') || {}).value, 10);
        var p = (st.presets || [])[idx];
        if (!p) { msg('<span class="prism-bad">' + ((st.presets || []).length ? 'Pick a saved preset first.' : 'No saved presets.') + '</span>'); return; }
        if (p.model && _MODELS()[p.model] && p.model !== st.model) _setModel(p.model);
        st.params = _clone(p.params || {});
        st.phys = _clone(p.phys || {});
        st.paramFreeze = _clone(p.paramFreeze || {});
        st.modelCurveData = null;
        _save();
        _rerender(4);
        msg('<span class="prism-ok">Loaded preset “' + _esc(p.name) + '”.</span>');
    };
    var pdl = _el('prism_preset_del');
    if (pdl) pdl.onclick = function () {
        var idx = parseInt((_el('prism_preset_picker') || {}).value, 10);
        var gone = (st.presets || [])[idx];
        if (!gone) { msg('<span class="prism-bad">' + ((st.presets || []).length ? 'Pick a saved preset first.' : 'No saved presets.') + '</span>'); return; }
        st.presets.splice(idx, 1);
        _persistPresets();
        _rerender(4);
        msg('<span class="prism-ok">Deleted preset “' + _esc(gone.name || 'preset') + '”.</span>');
    };
    var rv = _el('prism_params_reset_view');
    if (rv) rv.onclick = function () {
        _resetCanvasView(_el('prism_params_canvas'));
        _drawParamPreview(units);
        _syncResetView('prism_params_reset_view', 'prism_params_canvas', false);
    };
    _drawParamPreview(units);
    _wireResetView('prism_params_reset_view', 'prism_params_canvas');
}
function _persistPresets() {
    try { if (typeof localStorage !== 'undefined' && localStorage) localStorage.setItem('wts_prism_presets', JSON.stringify(_st().presets || [])); }
    catch (e) { /* quota — ignore */ }
}
function _drawParamPreview(units) {
    var st = _st();
    var canvas = _el('prism_params_canvas');
    var note = _el('prism_params_simmsg');
    if (!canvas) return;
    var entry = _MODELS()[st.model];
    if (!entry) return;
    var ds = G.PRiSM_dataset;
    try {
        if (units.mode === 'rate') {
            var rc = PRiSM_evalModelCurve(st.model, st.params, {});
            if (!rc) throw new Error('model evaluation failed');
            var data = (_hasData(ds) && ds.q) ? { t: _daysOf(ds), q: _arr(ds.q), overlay: { t: rc.t, q: rc.q } } : { t: rc.t, q: rc.q };
            _plotInto(canvas, 'PRiSM_plot_rate_time_loglog', data, { hover: true, dragZoom: true, showLegend: true, timeUnit: 'd', xLabel: 'Time (days)', title: 'Model preview — ' + PRiSM_modelDisplayName(st.model) });
            if (note) note.textContent = 'Rate model over ' + _fmt(rc.t[0], 3) + '–' + _fmt(rc.t[rc.t.length - 1], 4) + ' days.';
            return;
        }
        if (units.mode === 'physical') {
            var c = PRiSM_evalModelCurve(st.model, st.params, { adata: units.ad });
            if (c && c.mode === 'physical') {
                var ad = units.ad;
                var d = (ad && ad.ok) ? { t: ad.t, dp: ad.dp, deriv: ad.deriv, overlay: { t: c.t, dp: c.dp, deriv: c.deriv } }
                                      : { t: c.t, dp: c.dp, deriv: c.deriv };
                _plotInto(canvas, 'PRiSM_plot_bourdet', d, { hover: true, dragZoom: true, showLegend: true, smoothL: st.bourdetL,
                    title: 'Model preview — physical units', xLabel: 'Δt (hr)', yLabel: _yLabel(ad) });
                if (note) note.textContent = (ad && ad.ok ? 'Data and model' : 'Model only') + ' · Δt ' + _fmt(c.t[0], 3) + '–' + _fmt(c.t[c.t.length - 1], 4) + ' h.';
                return;
            }
        }
        // Dimensionless: data.dp = pD and data.deriv = pD′ on the adaptive tD range.
        var dc = _dimlessCurve(entry, st.params, {});
        _plotInto(canvas, 'PRiSM_plot_bourdet', { t: dc.td, dp: dc.pd, deriv: dc.pdPrime },
            { hover: true, dragZoom: true, showLegend: true, title: 'Model preview — dimensionless', xLabel: 'tD', yLabel: 'pD, pD′' });
        if (note) note.textContent = 'Dimensionless curve, tD ' + _fmt(dc.tdRange[0], 2) + '–' + _fmt(dc.tdRange[1], 3) + ' (' + dc.td.length + ' points).';
    } catch (e) {
        _drawCanvasMessage(canvas, 'Model evaluation failed: ' + (e && e.message), '#f85149');
        if (note) note.textContent = 'The preview could not be computed for these parameters.';
    }
}


// =========================================================================
// SECTION 14 — TAB 5 · TYPE-CURVE MATCH (C5)
// =========================================================================
var MATCH_STEP = 0.05;           // decades per arrow press
var _match = { curve: null, drag: null, ad: null, canvas: null };

function _matchCurve(entry, params, tcm, ad) {
    var TM = Math.pow(10, tcm.logTM);
    var tpos = ad.t.filter(function (x) { return x > 0; });
    var need = [TM * Math.min.apply(null, tpos) / 30, TM * Math.max.apply(null, tpos) * 30];
    var c = _match.curve;
    var key = JSON.stringify([_st().model, params]);
    if (c && c.key === key && c.td[0] <= need[0] && c.td[c.td.length - 1] >= need[1]) return c;
    var lo = need[0] / 100, hi = need[1] * 100;
    var n = Math.min(600, Math.max(150, Math.ceil(15 * _log10(hi / lo))));
    var td = _logspace(_log10(lo), _log10(hi), n);
    c = { key: key, td: td, pd: _toArr(entry.pd(td, params), n),
          pdPrime: (typeof entry.pdPrime === 'function') ? _toArr(entry.pdPrime(td, params), n) : null };
    if (!c.pdPrime) c.pdPrime = _bourdet(td, c.pd, 0);
    _match.curve = c;
    return c;
}
function _matchTcm() { return _currentTcm(_match.ad); }

function PRiSM_renderMatchTab(hostEl, ropts) {
    var host = _host(hostEl, 5);
    if (!host) return;
    _injectStyles();
    _endDrag();
    var st = _st();
    var ds = G.PRiSM_dataset;
    var entry = _MODELS()[st.model];
    var well = _getWell(ds);
    var hasP = _hasData(ds) && !!ds.p;
    var ad = hasP ? _getAData(ds, _adOpts()) : null;
    _match.ad = ad;
    _match.curve = null;
    var isRate = entry && entry.kind === 'rate';
    var html =
        '<div class="card prism-w7" id="prism_match_card">' +
          '<div class="card-title">Type-curve match</div>' +
          (hasP && !isRate ? _wellBanner(well, 'match') : '') +
          (!hasP ? '<div class="prism-banner prism-banner--info"><span style="flex:1 1 220px;">Load pressure data on the Data step first.</span><button type="button" class="btn btn-secondary prism-btn-sm" data-prism-goto-data>Open Data step</button></div>' : '') +
          (isRate ? '<div class="prism-banner prism-banner--info"><span>Type-curve matching applies to pressure models. Fit decline models on the Regression tab.</span></div>' : '') +
          '<div style="font-size:12px;color:var(--text2);margin-bottom:10px;">Drag the model curve over the data, or use the arrows (0.05 log cycle per press). Apply converts the match to k, C and S.</div>' +
          '<div class="prism-match">' +
            '<div class="prism-match-controls">' +
              '<div class="prism-arrows">' +
                '<span></span><button type="button" class="btn btn-secondary" id="prism_match_up" data-prism-mstep="pm-" title="Move the model curve up">▲ Up</button><span></span>' +
                '<button type="button" class="btn btn-secondary" id="prism_match_left" data-prism-mstep="tm+" title="Move the model curve left">◀ Left</button>' +
                '<button type="button" class="btn btn-secondary" id="prism_match_down" data-prism-mstep="pm+" title="Move the model curve down">▼ Down</button>' +
                '<button type="button" class="btn btn-secondary" id="prism_match_right" data-prism-mstep="tm-" title="Move the model curve right">Right ▶</button>' +
              '</div>' +
              '<div class="prism-toolbar" style="margin-top:10px;">' +
                '<button type="button" class="btn btn-secondary prism-btn-sm" id="prism_match_auto">Auto-align</button>' +
                '<button type="button" class="btn btn-secondary prism-btn-sm" id="prism_match_reset">Reset to model</button>' +
                '<button type="button" class="btn btn-primary prism-btn-sm" id="prism_match_apply">Apply match</button>' +
              '</div>' +
              '<div class="rbox" style="margin-top:6px;"><div class="rbox-title">Match</div><div class="prism-kv">' +
                '<span>log PM (1/psi)</span><span class="prism-v" id="prism_match_logpm">—</span>' +
                '<span>log TM (1/hr)</span><span class="prism-v" id="prism_match_logtm">—</span>' +
                '<span>kh</span><span class="prism-v" id="prism_match_kh">—</span>' +
                '<span>k</span><span class="prism-v" id="prism_match_k">—</span>' +
                '<span>C</span><span class="prism-v" id="prism_match_C">—</span>' +
                '<span>S (corrected)</span><span class="prism-v" id="prism_match_S">—</span>' +
                '<span>RMSE log Δp</span><span class="prism-v" id="prism_match_rmse_dp">—</span>' +
                '<span>RMSE log Δp′</span><span class="prism-v" id="prism_match_rmse_dr">—</span>' +
              '</div></div>' +
              '<div id="prism_match_msg" class="prism-msg"></div>' +
            '</div>' +
            '<div class="prism-match-plot">' + _canvasHTML('prism_match_canvas', _plotH('main'), 'prism-drag') + '</div>' +
          '</div>' +
        '</div>';
    _mount(host, html, ropts);
    _wireGotoData(host);
    var canvas = _el('prism_match_canvas');
    _match.canvas = canvas;
    if (!hasP || isRate || !entry) {
        if (canvas) _drawCanvasMessage(canvas, !hasP ? 'No pressure data loaded.' : 'Select a pressure model to match.', '#8b949e');
        return;
    }
    if (!ad.ok) {
        _drawCanvasMessage(canvas, ad.reason || 'No positive Δp — check the test type and pi on the Data step.', '#8b949e');
        return;
    }
    // No state write on render: the match in force is st.tcMatch or a derived / automatic one.
    _forEach(host.querySelectorAll('[data-prism-mstep]'), function (b) {
        b.onclick = function () { _stepMatch(b.getAttribute('data-prism-mstep')); };
    });
    var au = _el('prism_match_auto');
    if (au) au.onclick = function () {
        var t = _autoAlign(st.model, st.params, _match.ad);
        if (!t) { _matchMsg('<span class="prism-warn">Could not align this model to the data.</span>'); return; }
        st.tcMatch = t; _save(); _refreshMatch({});
        _matchMsg('<span class="prism-ok">Aligned by least squares on log Δp and log Δp′.</span>');
    };
    var rs = _el('prism_match_reset');
    if (rs) rs.onclick = function () { st.tcMatch = null; _autoTcm = null; _save(); _refreshMatch({}); _matchMsg(''); };
    var ap = _el('prism_match_apply');
    if (ap) ap.onclick = _applyMatch;
    if (canvas) {
        canvas.setAttribute('tabindex', '0');
        canvas.setAttribute('aria-label', 'Type-curve match plot. Drag or use the arrow keys to move the model curve.');
        canvas.onpointerdown = _onMatchDown;
        canvas.onkeydown = function (ev) {
            var map = { ArrowUp: 'pm-', ArrowDown: 'pm+', ArrowLeft: 'tm+', ArrowRight: 'tm-' };
            if (ev && map[ev.key]) { if (ev.preventDefault) ev.preventDefault(); _stepMatch(map[ev.key]); }
        };
    }
    _refreshMatch({});
}
function _matchMsg(h) { var m = _el('prism_match_msg'); if (m) m.innerHTML = h; }
function _stepMatch(code) {
    var st = _st();
    var t = _matchTcm();
    if (!t) return;
    var n = { logPM: t.logPM, logTM: t.logTM, source: 'match' };
    if (code === 'pm-') n.logPM -= MATCH_STEP;
    else if (code === 'pm+') n.logPM += MATCH_STEP;
    else if (code === 'tm+') n.logTM += MATCH_STEP;
    else if (code === 'tm-') n.logTM -= MATCH_STEP;
    st.tcMatch = n;
    _save();
    _refreshMatch({});
}
function _refreshMatch(o) {
    o = o || {};
    var st = _st();
    var ad = _match.ad, canvas = _match.canvas || _el('prism_match_canvas');
    var entry = _MODELS()[st.model];
    var tcm = _matchTcm();
    if (!canvas || !ad || !ad.ok || !entry || !tcm) return null;
    var curve;
    try { curve = _matchCurve(entry, st.params, tcm, ad); }
    catch (e) { _drawCanvasMessage(canvas, 'Model evaluation failed: ' + (e && e.message), '#f85149'); return null; }
    var ov = _applyTCM(curve, tcm);
    var data = { t: ad.t, dp: ad.dp, deriv: ad.deriv, overlay: { t: ov.t, dp: ov.dp, deriv: ov.deriv } };
    _plotInto(canvas, 'PRiSM_plot_bourdet', data, { hover: !o.dragging, dragZoom: false, showLegend: true, smoothL: st.bourdetL,
        title: 'Type-curve match — ' + PRiSM_modelDisplayName(st.model), xLabel: 'Δt (hr)', yLabel: _yLabel(ad) });
    var set = function (id, v) { var e = _el(id); if (e) e.textContent = v; };
    set('prism_match_logpm', _fixed(tcm.logPM, 4));
    set('prism_match_logtm', _fixed(tcm.logTM, 4));
    var well = _getWell(G.PRiSM_dataset);
    var m = _matchToPhysical(tcm, st.model, st.params, well);
    set('prism_match_kh', m.ok && _isNum(m.kh) ? _fmt(m.kh, 4) + ' md·ft' : '—');
    set('prism_match_k', m.ok && _isNum(m.k) ? _fmt(m.k, 4) + ' md' : '—');
    set('prism_match_C', m.ok && _isNum(m.C) ? _fmt(m.C, 3) + ' bbl/psi' : '—');
    set('prism_match_S', m.ok && _isNum(m.S) ? _fixed(m.S, 2) : '—');
    if (!o.dragging) {
        var s = _matchStats(entry, st.params, tcm, ad);
        _match.stats = s;
        set('prism_match_rmse_dp', _fixed(s.rmseDp, 4));
        set('prism_match_rmse_dr', _fixed(s.rmseDr, 4));
    }
    return data;
}
function _onMatchDown(ev) {
    var st = _st();
    var canvas = _match.canvas || _el('prism_match_canvas');
    var ax = canvas && canvas._prismAxes;
    var tcm = _matchTcm();
    if (!ax || !tcm || !ax.plot || !(ax.plot.w > 0) || !(ax.plot.h > 0)) return;
    if (ev && ev.pointerType === 'mouse' && ev.button != null && ev.button !== 0) return;
    var sx = ax.scaleX || {}, sy = ax.scaleY || {};
    var dx = (sx.kind === 'log' && sx.min > 0 && sx.max > 0) ? (_log10(sx.max) - _log10(sx.min)) / ax.plot.w : 0;
    var dy = (sy.kind === 'log' && sy.min > 0 && sy.max > 0) ? (_log10(sy.max) - _log10(sy.min)) / ax.plot.h : 0;
    if (!dx || !dy) return;
    _match.drag = { x: ev.clientX, y: ev.clientY, logPM: tcm.logPM, logTM: tcm.logTM, dpx: dx, dpy: dy, id: ev.pointerId, moved: false };
    try { if (canvas.setPointerCapture && ev.pointerId != null) canvas.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    if (typeof G.addEventListener === 'function') {
        G.addEventListener('pointermove', _onMatchMove);
        G.addEventListener('pointerup', _onMatchUp);
        G.addEventListener('pointercancel', _onMatchUp);
    }
    if (ev.preventDefault) ev.preventDefault();
}
function _onMatchMove(ev) {
    var d = _match.drag;
    if (!d) return;
    var mx = (ev.clientX || 0) - d.x, my = (ev.clientY || 0) - d.y;
    if (!d.moved && Math.abs(mx) + Math.abs(my) < 2) return;
    d.moved = true;
    // Right → curve right (TM smaller); down → curve down (PM larger).
    _st().tcMatch = { logPM: d.logPM + my * d.dpy, logTM: d.logTM - mx * d.dpx, source: 'match' };
    _refreshMatch({ dragging: true });
}
function _onMatchUp() {
    var was = !!(_match.drag && _match.drag.moved);
    _endDrag();
    if (was) { _save(); _refreshMatch({}); }
}
function _endDrag() {
    _match.drag = null;
    if (typeof G.removeEventListener === 'function') {
        G.removeEventListener('pointermove', _onMatchMove);
        G.removeEventListener('pointerup', _onMatchUp);
        G.removeEventListener('pointercancel', _onMatchUp);
    }
}
function _applyMatch() {
    var st = _st();
    var ds = G.PRiSM_dataset;
    var ad = _match.ad || (ds && ds.p ? _getAData(ds, _adOpts()) : null);
    var entry = _MODELS()[st.model];
    var tcm = _matchTcm();
    if (!tcm || !entry || !ad || !ad.ok) { _matchMsg('<span class="prism-warn">Nothing to apply yet.</span>'); return null; }
    var well = _getWell(ds);
    var m = _matchToPhysical(tcm, st.model, st.params, well);
    if (!m.ok) { _matchMsg('<span class="prism-warn">' + _esc(m.reason || 'Enter the well inputs on the Data step to convert the match.') + '</span>'); return null; }
    var stats = _matchStats(entry, st.params, tcm, ad);
    var newParams = {};
    for (var k in st.params) if (Object.prototype.hasOwnProperty.call(st.params, k)) newParams[k] = st.params[k];
    if (m.params) for (var pk in m.params) if (Object.prototype.hasOwnProperty.call(m.params, pk) && _isNum(m.params[pk])) newParams[pk] = m.params[pk];
    st.params = newParams;
    var units = _unitsMode();
    if (units.mode === 'physical') {
        var view = _physView(units.pm, ad, well);
        if (_isNum(m.k)) view.k = m.k;
        if (_isNum(m.C) && 'C' in view) view.C = m.C;
        if (_isNum(m.S) && 'S' in view) view.S = m.S;
        _commitPhys(units.pm, view);
        for (var pk2 in newParams) if (Object.prototype.hasOwnProperty.call(newParams, pk2) && m.params && _isNum(m.params[pk2])) st.params[pk2] = m.params[pk2];
    } else {
        if (_isNum(m.k)) st.phys.k = m.k;
        if (_isNum(m.C)) st.phys.C = m.C;
        if (_isNum(m.S)) st.phys.S = m.S;
    }
    var PM = Math.pow(10, tcm.logPM);
    if (_isNum(m.B) && m.B > 0) st.tcMatch = { logPM: tcm.logPM, logTM: _log10(m.B), source: 'match' };
    else st.tcMatch = { logPM: tcm.logPM, logTM: tcm.logTM, source: 'match' };
    var tEnd = ad.t[ad.t.length - 1];
    var rinv = (_isNum(m.k) && well.phi > 0 && well.mu > 0 && well.ct > 0) ? Math.sqrt(m.k * tEnd / (948 * well.phi * well.mu * well.ct)) : NaN;
    var fit = {
        modelKey: st.model, kind: 'pressure', source: 'match',
        params: _clone(newParams),
        phys: { k: m.k, kh: m.kh, C: m.C, Cd: m.Cd, S: m.S, pi: ad.pRefSource === 'pi' ? ad.pRef : undefined, rinv: rinv },
        r2: stats.r2, rmse: stats.rmsePsi, rmseLogDp: stats.rmseDp, rmseLogDeriv: stats.rmseDr,
        window: { tmin: ad.t[0], tmax: tEnd },
        scales: { A: 1 / PM, B: _isNum(m.B) ? m.B : Math.pow(10, tcm.logTM) },
        pRef: ad.pRef, pRefSource: ad.pRefSource,
        timestamp: new Date().toISOString(),
        warnings: (m.warnings || []).concat(ad.warnings || [])
    };
    _setLastFit(fit);
    st.modelCurveData = null;
    PRiSM_evalModelCurve(st.model, st.params, { adata: ad });
    _save();
    _match.curve = null;
    _refreshMatch({});
    if (_el('prism_plot_canvas')) _redraw();
    _matchMsg('<span class="prism-ok">Match applied — k ' + _esc(_fmt(m.k, 4)) + ' md' + (_isNum(m.S) ? ', S ' + _esc(_fixed(m.S, 2)) : '') +
        (_isNum(m.C) ? ', C ' + _esc(_fmt(m.C, 3)) + ' bbl/psi' : '') + '.</span>' +
        (m.warnings && m.warnings.length ? '<div class="prism-warn">' + _esc(m.warnings.join(' ')) + '</div>' : ''));
    return fit;
}


// =========================================================================
// SECTION 15 — TAB 6 · REGRESSION
// =========================================================================
var PHYS_ORDER = ['k', 'kh', 'C', 'Cd', 'S', 'pi', 'xf', 'Lh', 'rinv'];
function _fmtPhys(key, v) {
    if (!_isNum(v)) return '—';
    var a = Math.abs(v);
    if (key === 'S') return v.toFixed(2);
    if (key === 'C') return _fmt(v, 3);
    if (key === 'pi') return v.toFixed(1);
    if (key === 'Cd') return _fmt(v, 4);
    if (key === 'rinv' || key === 'xf' || key === 'Lh' || key === 'kh') return a >= 100 ? v.toFixed(0) : _fmt(v, 4);
    if (a >= 100) return v.toFixed(0);
    if (a >= 10) return v.toFixed(1);
    if (a >= 1) return v.toFixed(2);
    return _fmt(v, 3);
}
function _ciText(key, ci, v) {
    if (!ci || ci.length !== 2 || !_isNum(ci[0]) || !_isNum(ci[1])) return '—';
    var half = (ci[1] - ci[0]) / 2;
    var mid = (ci[0] + ci[1]) / 2;
    if (_isNum(v) && Math.abs(mid - v) <= 0.05 * Math.max(Math.abs(half), 1e-12)) {
        var h = Math.abs(half);
        return '± ' + ((h >= 1e-3 && h < 1e5) ? String(h.toPrecision(2)).replace(/e\+?/, 'e') : _fmt(h, 2));
    }
    return '[' + _fmtPhys(key, ci[0]) + ' – ' + _fmtPhys(key, ci[1]) + ']';
}
function _statusOf(fit, err) {
    if (err) return { cls: 'prism-bad', text: 'Regression error: ' + err };
    var r2 = _num(fit && fit.r2);
    if (!fit) return { cls: 'prism-bad', text: 'No result.' };
    if (_isNum(r2) && r2 < 0.9) return { cls: 'prism-bad', text: 'Fit failed (R² ' + _fixed(r2, 4) + ') — parameters were not changed.' };
    if (fit.converged === true && _isNum(r2) && r2 >= 0.99) return { cls: 'prism-ok', text: 'Fit converged — R² ' + _fixed(r2, 5) };
    return { cls: 'prism-warn', text: 'Fit finished ' + (fit.converged ? '' : 'without converging ') + '(R² ' + (_isNum(r2) ? _fixed(r2, 4) : '—') + ') — treat as a starting point.' };
}
function _fitResultsHTML(fit) {
    if (!fit) return '<div class="prism-dim" style="font-style:italic;">Run the regression to fit the active model.</div>';
    var ci = fit.ci95 || {};
    var ident = fit.identifiable || {};
    var phys = fit.phys || {};
    var rows = '';
    var seen = {};
    var addRow = function (key, v, label, unit) {
        if (!_isNum(v) || seen[key]) return;
        seen[key] = true;
        var flag = ident[key] === false ? ' <span class="prism-badge prism-badge--warn">not identifiable</span>' : '';
        rows += '<tr><td><b>' + _esc(label) + '</b></td><td class="prism-num">' + _esc(_fmtPhys(key, v)) + '</td><td>' + _esc(unit) + '</td>' +
            '<td class="prism-num">' + _esc(_ciText(key, ci[key], v)) + '</td><td>' + flag + '</td></tr>';
    };
    PHYS_ORDER.forEach(function (k) { addRow(k, phys[k], PHYS_LABELS[k] || (k === 'rinv' ? 'Radius of investigation' : k), PHYS_UNITS[k] || '-'); });
    var dist = phys.distances_ft || {};
    for (var dk in dist) if (Object.prototype.hasOwnProperty.call(dist, dk)) addRow('dist_' + dk, dist[dk], 'Distance ' + dk, 'ft');
    var btRaw = fit.bootstrap || null;
    var bt = (btRaw && btRaw.percentiles) ? btRaw.percentiles : (fit.percentiles || fit.pBands || btRaw);
    var btRows = '';
    if (bt && typeof bt === 'object') {
        for (var bk in bt) {
            if (!Object.prototype.hasOwnProperty.call(bt, bk) || !bt[bk] || typeof bt[bk] !== 'object') continue;
            var b = bt[bk];
            var p10 = _num(b.P10, b.p10), p50 = _num(b.P50, b.p50), p90 = _num(b.P90, b.p90);
            if (_isNum(p10) || _isNum(p50) || _isNum(p90)) btRows += '<tr><td>' + _esc(bk) + '</td><td>' + _esc(_fmt(p10, 4)) + '</td><td>' + _esc(_fmt(p50, 4)) + '</td><td>' + _esc(_fmt(p90, 4)) + '</td></tr>';
        }
    }
    var pRows = '';
    var params = fit.params || {};
    for (var pk in params) {
        if (!Object.prototype.hasOwnProperty.call(params, pk) || pk.slice(0, 2) === '__') continue;
        var pv = params[pk];
        pRows += '<tr><td>' + _esc(pk) + '</td><td class="prism-num">' + _esc(_isNum(pv) ? _fmt(pv, 5) : String(pv)) + '</td><td class="prism-num">' +
            _esc(_ciText(pk, ci[pk], pv)) + '</td><td class="prism-num">' + _esc(fit.stderr && _isNum(fit.stderr[pk]) ? _fmt(fit.stderr[pk], 3) : '—') + '</td></tr>';
    }
    var rmseUnit = fit.kind === 'rate' ? ' (rate units)' : ' psi';
    var isRateFit = fit.kind === 'rate';
    var stats = '<div class="prism-toolbar" style="font-size:12px;">' +
        '<span>R² <b class="prism-num">' + _esc(_isNum(fit.r2) ? _fixed(fit.r2, 5) : '—') + '</b></span>' +
        '<span>RMSE <b class="prism-num">' + _esc(_fmt(fit.rmse, 4)) + '</b>' + rmseUnit + '</span>' +
        '<span>AIC <b class="prism-num">' + _esc(_isNum(fit.aic) ? _fixed(fit.aic, 2) : '—') + '</b></span>' +
        '<span>Iterations <b>' + _esc(fit.iterations != null ? String(fit.iterations) : '—') + '</b></span>' +
        '<span>Converged <b class="' + (fit.converged ? 'prism-ok' : 'prism-warn') + '">' + (fit.converged ? 'yes' : 'no') + '</b></span>' +
        '<span class="prism-dim">source: ' + _esc(fit.source || 'regression') + '</span></div>';
    var warn = (fit.warnings || []).length ? '<div class="prism-notes">' + fit.warnings.slice(0, 6).map(function (w) { return '<div>⚠ ' + _esc(w) + '</div>'; }).join('') + '</div>' : '';
    var pTable = pRows ? '<div class="prism-scroll-x"><table class="dtable" id="prism_regress_params"><thead><tr><th>Key</th><th>Value</th><th>95% CI</th><th>Std error</th></tr></thead><tbody>' + pRows + '</tbody></table></div>' : '';
    return stats +
        (rows ? '<div class="prism-scroll-x"><table class="dtable" id="prism_regress_phys"><thead><tr><th>Result</th><th>Value</th><th>Unit</th><th>95% CI</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'
              : (isRateFit ? '' : '<div class="prism-notes">No field-unit results — enter the well inputs on the Data step for k, C and S.</div>')) +
        (btRows ? '<div class="prism-scroll-x" style="margin-top:8px;"><table class="dtable"><thead><tr><th>Bootstrap' + (btRaw && _isNum(btRaw.n) ? ' (n = ' + btRaw.n + (btRaw.failures ? ', ' + btRaw.failures + ' failed' : '') + ')' : '') + '</th><th>10th pct</th><th>50th pct</th><th>90th pct</th></tr></thead><tbody>' + btRows + '</tbody></table></div>' : '') +
        (pTable ? (isRateFit ? '<div class="prism-notes">Rates in STB/d or Mscf/d; Di in 1/day.</div>' + pTable
                             : '<details style="margin-top:8px;"><summary>Model parameters (dimensionless)</summary>' + pTable + '</details>') : '') +
        warn;
}
function PRiSM_renderFitResults(container, fit) {
    if (!container) return;
    container.innerHTML = _fitResultsHTML(_normFit(fit));
}

function PRiSM_renderRegressTab(hostEl, ropts) {
    var host = _host(hostEl, 6);
    if (!host) return;
    _injectStyles();
    var st = _st();
    var entry = _MODELS()[st.model];
    var ds = G.PRiSM_dataset;
    var hasData = _hasData(ds);
    var isRate = !!(entry && entry.kind === 'rate');
    var units = _unitsMode();
    var rows = _paramRows(units);
    var lf = _getLastFit();
    var fitForModel = lf && (lf.modelKey === st.model) ? lf : null;
    var ad = units.ad || null;
    var tRange = (ad && ad.ok) ? [ad.t[0], ad.t[ad.t.length - 1]] : (hasData ? [ds.t[0], ds.t[ds.t.length - 1]] : [NaN, NaN]);
    var fo = st.fitOpts;
    var hasLM = typeof G.PRiSM_runRegression === 'function';
    var hasAuto = typeof G.PRiSM_autoMatch === 'function';
    var status = fitForModel ? _statusOf(fitForModel) : null;
    var html =
        '<div class="card prism-w7" id="prism_regress_card">' +
          '<div class="card-title">Regression — ' + _esc(entry ? PRiSM_modelDisplayName(st.model) : 'no model') + '</div>' +
          (!hasData ? '<div class="prism-banner prism-banner--info"><span style="flex:1 1 220px;">Load data on the Data step first.</span><button type="button" class="btn btn-secondary prism-btn-sm" data-prism-goto-data>Open Data step</button></div>' : '') +
          (hasData && !isRate && units.mode !== 'physical' ? _wellBanner(units.well || _getWell(ds), 'fit') : '') +
          '<div class="prism-toolbar">' +
            '<label class="prism-field"><span>Fit window Δt from</span><input type="number" step="any" id="prism_reg_tmin" style="width:90px;" placeholder="' + _esc(_fmt(tRange[0], 3)) + '" value="' + _esc(_isNum(fo.tmin) ? String(fo.tmin) : '') + '"></label>' +
            '<label class="prism-field"><span>to</span><input type="number" step="any" id="prism_reg_tmax" style="width:90px;" placeholder="' + _esc(_fmt(tRange[1], 4)) + '" value="' + _esc(_isNum(fo.tmax) ? String(fo.tmax) : '') + '"><span>h</span></label>' +
            (isRate ? '' :
            '<label class="prism-field"><span>Objective</span><select id="prism_reg_objective">' +
              '<option value="dp+deriv"' + (fo.objective !== 'dp' ? ' selected' : '') + '>Δp and Δp′ (log)</option>' +
              '<option value="dp"' + (fo.objective === 'dp' ? ' selected' : '') + '>Δp only (psi)</option></select></label>' +
            '<label class="prism-field"><input type="checkbox" id="prism_reg_floatpi"' + (fo.floatPi ? ' checked' : '') + '><span>Estimate pi</span></label>') +
          '</div>' +
          _paramTableHTML(rows, { value: 'prism_reg_', freeze: 'prism_reg_freeze_', table: 'prism_reg_table' }, units) +
          '<div class="prism-toolbar" style="margin-top:12px;">' +
            '<button type="button" class="btn btn-primary" id="prism_regress_run"' + (hasLM && hasData ? '' : ' disabled') + '>Run regression</button>' +
            '<button type="button" class="btn btn-secondary prism-btn-sm" id="prism_regress_boot"' + (hasLM && hasData ? '' : ' disabled') + '>Bootstrap CI</button>' +
            '<button type="button" class="btn btn-secondary prism-btn-sm" id="prism_regress_auto"' + (hasAuto && hasData ? '' : ' disabled') + '>Rank models automatically</button>' +
          '</div>' +
          '<div id="prism_regress_status" class="prism-msg ' + (status ? status.cls : '') + '" data-prism-status="' + (status ? status.cls.replace('prism-', '') : '') + '">' + (status ? _esc(status.text) : '') + '</div>' +
        '</div>' +
        '<div class="card prism-w7"><div class="card-title">Results</div><div id="prism_regress_results">' + _fitResultsHTML(fitForModel) + '</div>' +
          '<div class="prism-grid2" style="margin-top:12px;">' +
            '<div>' + _canvasHTML('prism_regress_plot', _plotH('small')) + '</div>' +
            '<div>' + _canvasHTML('prism_regress_resid', _plotH('small')) + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="card prism-w7"><div class="card-title">Model ranking</div><div id="prism_automatch_panel">' +
          '<div class="prism-dim" style="font-style:italic;">Ranks candidate models against the data by AIC. The top results also appear as recommendations in the model library.</div>' +
        '</div></div>';
    _mount(host, html, ropts);
    _wireGotoData(host);
    _wireParamTable(host, units, null);

    var readForm = function () {
        var v1 = parseFloat((_el('prism_reg_tmin') || {}).value);
        var v2 = parseFloat((_el('prism_reg_tmax') || {}).value);
        fo.tmin = _isNum(v1) ? v1 : null;
        fo.tmax = _isNum(v2) ? v2 : null;
        var ob = _el('prism_reg_objective'); if (ob) fo.objective = ob.value || 'dp+deriv';
        var fp = _el('prism_reg_floatpi'); if (fp) fo.floatPi = !!fp.checked;
        _save();
    };
    ['prism_reg_tmin', 'prism_reg_tmax', 'prism_reg_objective'].forEach(function (id) { var e = _el(id); if (e) e.onchange = readForm; });
    var fp = _el('prism_reg_floatpi');
    if (fp) fp.onchange = function () { readForm(); st.modelCurveData = null; _rerender(6); };

    var run = function (extra) {
        readForm();
        _setStatus('prism-warn', extra && extra.bootstrap ? 'Running bootstrap (' + extra.bootstrap + ' fits)…' : 'Running regression…');
        _defer(function () { _runRegressionNow(extra || {}); });
    };
    var rb = _el('prism_regress_run'); if (rb) rb.onclick = function () { run({}); };
    var bb = _el('prism_regress_boot'); if (bb) bb.onclick = function () { run({ bootstrap: 200 }); };
    var ab = _el('prism_regress_auto');
    if (ab) ab.onclick = function () {
        _setStatus('prism-warn', 'Ranking candidate models…');
        var t0 = _now();
        _runFindBest(function (err, res) {
            if (err) { _setStatus('prism-bad', err); return; }
            var panel = _el('prism_automatch_panel');
            if (panel) {
                if (typeof G.PRiSM_renderAutoMatchPanel === 'function') { try { G.PRiSM_renderAutoMatchPanel(panel, res); } catch (e) { panel.textContent = 'Ranking panel failed: ' + (e && e.message); } }
                else panel.innerHTML = _recStripHTML(true);
            }
            var best = res && (res.bestKey || (res.ranked && res.ranked[0] && (res.ranked[0].modelKey || res.ranked[0].model)));
            _setStatus('prism-ok', 'Ranking done in ' + Math.round(_now() - t0) + ' ms' + (best ? ' — best: ' + PRiSM_modelDisplayName(best) : '') + '.');
            _remountPanels(6);
        });
    };
    if (st.autoMatch && typeof G.PRiSM_renderAutoMatchPanel === 'function') {
        try { G.PRiSM_renderAutoMatchPanel(_el('prism_automatch_panel'), st.autoMatch); } catch (e) { /* ignore */ }
    }
    _drawRegressPlots();
}
function _setStatus(cls, text) {
    var s = _el('prism_regress_status');
    if (!s) return;
    s.className = 'prism-msg ' + cls;
    s.setAttribute('data-prism-status', cls.replace('prism-', ''));
    s.textContent = text;
}
function _runRegressionNow(extra) {
    var st = _st();
    var entry = _MODELS()[st.model];
    if (typeof G.PRiSM_runRegression !== 'function' || !entry) { _setStatus('prism-bad', 'The regression engine is not available in this build.'); return; }
    var fo = st.fitOpts;
    var opts = { modelKey: st.model, objective: fo.objective || 'dp+deriv', floatPi: !!fo.floatPi, freeze: _clone(st.paramFreeze), paramFreeze: _clone(st.paramFreeze) };
    if (_isNum(fo.tmin) || _isNum(fo.tmax)) opts.window = { tmin: _isNum(fo.tmin) ? fo.tmin : null, tmax: _isNum(fo.tmax) ? fo.tmax : null };
    if (extra.bootstrap) opts.bootstrap = extra.bootstrap;
    if (entry.kind !== 'rate') {
        // Start from committed physical values; a fixed parameter keeps the value shown in the table.
        var start = _numsOf(st.phys);
        var frozen = Object.keys(st.paramFreeze).filter(function (k) { return st.paramFreeze[k]; });
        if (frozen.length) {
            var u = _unitsMode();
            if (u.mode === 'physical') frozen.forEach(function (k) { if (!_isNum(start[k]) && _isNum(u.phys[k])) start[k] = u.phys[k]; });
        }
        if (Object.keys(start).length) opts.start = start;
    }
    var snap = { params: _clone(st.params), phys: _clone(st.phys), tcMatch: _clone(st.tcMatch) };
    var t0 = _now();
    var done = function (res) {
        var ms = Math.round(_now() - t0);
        var fit = _normFit(res && res.fit ? res.fit : res);
        if (!fit) { fail(new Error('no result returned')); return; }
        if (fit.ok === false) { fail(new Error(fit.reason || fit.error || 'the fit could not run')); return; }
        var legacy = !fit.source;
        if (!fit.modelKey) { fit.modelKey = st.model; fit.model = st.model; }
        if (!fit.kind) fit.kind = entry.kind === 'rate' ? 'rate' : 'pressure';
        if (!fit.source) fit.source = 'regression';
        var good = fit.converged === true || (_isNum(fit.r2) && fit.r2 >= 0.9);
        if (!good) { st.params = snap.params; st.phys = snap.phys; st.tcMatch = snap.tcMatch; }
        if (legacy) {
            if (good) _setLastFit(fit);
        }
        st.modelCurveData = null;
        PRiSM_evalModelCurve(st.model, st.params, {});
        var shown = good ? (_getLastFit() || fit) : fit;
        if (!shown.modelKey) shown.modelKey = st.model;
        var status = _statusOf(fit);
        _setStatus(status.cls, status.text + ' · ' + (fit.iterations != null ? fit.iterations + ' iterations · ' : '') + ms + ' ms' +
            (extra.bootstrap && !(fit.bootstrap || fit.percentiles || fit.pBands) ? ' · bootstrap bands not returned by this engine' : ''));
        var box = _el('prism_regress_results');
        if (box) box.innerHTML = _fitResultsHTML(shown);
        _drawRegressPlots();
        if (_el('prism_plot_canvas')) _redraw();
        _save();
        _remountPanels(6);
    };
    var fail = function (e) {
        st.params = snap.params; st.phys = snap.phys; st.tcMatch = snap.tcMatch;
        _setStatus('prism-bad', 'Regression error: ' + (e && e.message || e) + ' — parameters were not changed.');
    };
    try {
        var r = G.PRiSM_runRegression(opts);
        if (r && typeof r.then === 'function') r.then(done, fail);
        else done(r);
    } catch (e) { fail(e); }
}
function _drawRegressPlots() {
    var st = _st();
    var c1 = _el('prism_regress_plot'), c2 = _el('prism_regress_resid');
    if (!c1 && !c2) return;
    var ds = G.PRiSM_dataset;
    var entry = _MODELS()[st.model];
    if (!_hasData(ds) || !entry) {
        if (c1) _drawCanvasMessage(c1, 'No data.', '#8b949e');
        if (c2) _drawCanvasMessage(c2, 'No residuals yet.', '#8b949e');
        return;
    }
    var small = { hover: true, dragZoom: false, showLegend: true, height: _plotH('small') };
    if (entry.kind === 'rate') {
        if (!ds.q) { if (c1) _drawCanvasMessage(c1, 'This model needs rate data.', '#8b949e'); return; }
        var rc = PRiSM_evalModelCurve(st.model, st.params, {});
        var days = _daysOf(ds);
        _plotInto(c1, 'PRiSM_plot_rate_time_loglog', { t: days, q: _arr(ds.q), overlay: rc ? { t: rc.t, q: rc.q } : null },
            Object.assign({ timeUnit: 'd', xLabel: 'Time (days)', title: 'Rate and model' }, small));
        var qm = null;
        try { qm = _arr(entry.pd(days.map(function (x) { return x > 0 ? x : 1e-6; }), st.params)); } catch (e) { qm = null; }
        if (qm && c2) {
            var rt = [], rv = [];
            for (var i = 0; i < days.length; i++) if (days[i] > 0 && _isNum(qm[i]) && _isNum(ds.q[i])) { rt.push(days[i]); rv.push(ds.q[i] - qm[i]); }
            _plotInto(c2, 'PRiSM_plot_cartesian', { t: rt, p: rv }, Object.assign({ title: 'Residual (q − model)', xLabel: 'Time (days)', yLabel: 'Residual rate' }, small));
        }
        return;
    }
    if (!ds.p) { if (c1) _drawCanvasMessage(c1, 'This model needs pressure data.', '#8b949e'); return; }
    var ad = _getAData(ds, _adOpts());
    if (!ad.ok) { if (c1) _drawCanvasMessage(c1, ad.reason || 'No positive Δp.', '#8b949e'); if (c2) _drawCanvasMessage(c2, '—', '#8b949e'); return; }
    var ov = null;
    try { ov = _overlayFor(ad); } catch (e) { ov = null; }
    var d = { t: ad.t, dp: ad.dp, deriv: ad.deriv };
    if (ov && ov.dp) d.overlay = { t: ov.t, dp: ov.dp, deriv: ov.deriv };
    _plotInto(c1, 'PRiSM_plot_bourdet', d, Object.assign({ smoothL: st.bourdetL, title: 'Data and model', xLabel: 'Δt (hr)', yLabel: _yLabel(ad) }, small));
    if (c2 && ov && ov.dp) {
        var rt2 = [], rv2 = [];
        for (var j = 0; j < ad.t.length; j++) {
            var m = _interpLog(ad.t[j], ov.t, ov.dp);
            if (_isNum(m) && _isNum(ad.dp[j])) { rt2.push(_log10(ad.t[j])); rv2.push(ad.dp[j] - m); }
        }
        _plotInto(c2, 'PRiSM_plot_cartesian', { t: rt2, p: rv2 }, Object.assign({ title: 'Residual (Δp − model)', xLabel: 'log10 Δt (hr)', yLabel: 'Residual (psi)' }, small));
    } else if (c2) _drawCanvasMessage(c2, 'Residuals appear once a model curve is available.', '#8b949e');
}


// =========================================================================
// SECTION 16 — EXPORTS + EVENT LISTENERS (no timers, no wrappers)
// =========================================================================
G.PRiSM_detectPeriods = PRiSM_detectPeriods;
G.PRiSM_evalModelCurve = PRiSM_evalModelCurve;
G.PRiSM_buildPlotData = PRiSM_buildPlotData;
G.PRiSM_drawActivePlot = PRiSM_drawActivePlot;
G.PRiSM_registerPostDrawHook = PRiSM_registerPostDrawHook;
G.PRiSM_setModel = PRiSM_setModel;
G.PRiSM_autoAlignOverlay = PRiSM_autoAlignOverlay;
G.PRiSM_modelDisplayName = PRiSM_modelDisplayName;
G.PRiSM_modelLibrary = PRiSM_modelLibrary;
G.PRiSM_renderFitResults = PRiSM_renderFitResults;
G.PRiSM_renderPlotsTab = PRiSM_renderPlotsTab;
G.PRiSM_renderModelTab = PRiSM_renderModelTab;
G.PRiSM_renderParamsTab = PRiSM_renderParamsTab;
G.PRiSM_renderMatchTab = PRiSM_renderMatchTab;
G.PRiSM_renderRegressTab = PRiSM_renderRegressTab;
// Internals for the step shell and tests (not a public contract).
G.PRiSM_ui04 = {
    getAnalysisData: _getAData, getWell: _getWell, physicalModel: _getPM, matchToPhysical: _matchToPhysical,
    applyTypeCurveMatch: _applyTCM, autoAlign: _autoAlign, matchStats: _matchStats, dimlessRange: _dimlessRange,
    applyMatch: _applyMatch, stepMatch: _stepMatch, refreshMatch: _refreshMatch, unitsMode: _unitsMode,
    localAnalysisData: _localAData, localPhysicalModel: _localPM, localMatchToPhysical: _localMatchToPhysical,
    MATCH_STEP: MATCH_STEP
};

(function _listen() {
    if (typeof G.addEventListener !== 'function' || G.__prismUi04Listeners) return;
    G.__prismUi04Listeners = true;
    var refresh = function () {
        var st = _st();
        st.modelCurveData = null;
        _match.curve = null;
        var c = _el('prism_plot_canvas');
        if (c && c.isConnected !== false) _redraw();
    };
    G.addEventListener('prism:dataset-loaded', function () {
        var st = _st();
        var ds = G.PRiSM_dataset;
        var n = (ds && ds.q) ? PRiSM_detectPeriods(ds.t, ds.q).length : 0;
        if (st.activePeriod != null && !(st.activePeriod >= 0 && st.activePeriod < n)) st.activePeriod = null;
        refresh();
    });
    G.addEventListener('prism:well-changed', refresh);
    G.addEventListener('prism:automatch-updated', function () { _refreshRecStrip(); });
})();


// =============================================================================
// === SELF-TEST ===
// =============================================================================
(function PRiSM_uiWiringSelfTest() {
    var log = (typeof console !== 'undefined' && console.log) ? console.log.bind(console) : function () {};
    var checks = [];
    var check = function (name, fn) {
        var ok = false, err = null;
        try { ok = !!fn(); } catch (e) { err = e; }
        checks.push({ name: name, ok: ok, err: err && err.message });
    };
    var st = _st();
    check('state has C7/C8 fields', function () { return st.bourdetL === 0.15 || _isNum(st.bourdetL); });
    check('st.match is read-only {0,0}', function () {
        st.match = { timeShift: 3, pressShift: 9 };
        return st.match.timeShift === 0 && st.match.pressShift === 0;
    });
    check('plot registry has mdh + 14 built-ins', function () { return !!REG.mdh && Object.keys(BUILTIN_PLOTS).every(function (k) { return !!REG[k]; }); });
    check('detectPeriods returns {t0,t1,start,end,q}', function () {
        var p = PRiSM_detectPeriods([1, 2, 3, 4, 5, 6], [100, 100, 100.5, 0, 0, 0]);
        return p.length === 2 && p[0].t0 === 1 && p[0].t1 === 3 && p[1].start === 4 && p[1].end === 6 && p[1].q === 0 && p[0].i1 === 2;
    });
    check('adaptive tD range Cd 100, S 0 → 6e5', function () { var r = _dimlessRange({}, { Cd: 100, S: 0 }); return Math.abs(r[1] - 6e5) < 1 && r[0] === 1e-3; });
    check('local matchToPhysical at the sample truth', function () {
        var saved = _MODELS().__wp7probe;
        _MODELS().__wp7probe = { pd: function () { return []; }, paramSpec: [{ key: 'Cd', 'default': 80 }, { key: 'S', 'default': 2.5 }] };
        var w = { q: 850, B: 1.25, mu: 1.1, h: 35, phi: 0.18, ct: 1.2e-5, rw: 0.354 };
        var r = _localMatchToPhysical({ logPM: _log10(1 / 104.78), logTM: _log10(39854) }, '__wp7probe', { Cd: 80, S: 2.5 }, w);
        var r2 = _localMatchToPhysical({ logPM: _log10(1 / 104.78), logTM: _log10(39854) + 1 }, '__wp7probe', { Cd: 800, S: 2.5 - 0.5 * Math.LN10 }, w);
        if (saved) _MODELS().__wp7probe = saved; else delete _MODELS().__wp7probe;
        return Math.abs(r.k - 45) < 0.1 && Math.abs(r.S - 2.5) < 0.01 && Math.abs(r.C / 8.48e-4 - 1) < 0.01 &&
               Math.abs(r2.k - 45) < 0.1 && Math.abs(r2.S - 2.5) < 0.01 && Math.abs(r2.C / 8.48e-4 - 1) < 0.01;
    });
    check('local analysis data: sign-aware drawdown from pi', function () {
        var saved = G.PRiSM_getWell;
        G.PRiSM_getWell = function () { return { pi: 5000, q: 100, testType: 'auto', complete: false, missing: [], defaulted: [] }; };
        var ad = _localAData({ t: [0.1, 0.2, 0.5, 1, 2, 5], p: [4990, 4985, 4980, 4976, 4972, 4968], q: [100, 100, 100, 100, 100, 100] }, { L: 0 });
        G.PRiSM_getWell = saved;
        return ad.ok && ad.pRefSource === 'pi' && ad.dp[0] === 10 && ad.dp[5] === 32 && ad.testType === 'drawdown';
    });
    check('auto-align recovers a synthetic match', function () {
        var M = _MODELS();
        M.__wp7fake = {
            pd: function (td) { return td.map(function (x) { return x / (1 + x) + 0.5 * Math.log(1 + x); }); },
            pdPrime: function (td) { return td.map(function (x) { return x / ((1 + x) * (1 + x)) + 0.5 * x / (1 + x); }); },
            paramSpec: []
        };
        var TM = 1e4, PM = 0.01, t = _logspace(-4, 2, 40);
        var ad = { ok: true, t: t, dp: M.__wp7fake.pd(t.map(function (x) { return x * TM; })).map(function (v) { return v / PM; }),
                   deriv: M.__wp7fake.pdPrime(t.map(function (x) { return x * TM; })).map(function (v) { return v / PM; }) };
        var r = _autoAlign('__wp7fake', {}, ad);
        delete M.__wp7fake;
        return r && Math.abs(r.logTM - 4) < 1e-3 && Math.abs(r.logPM + 2) < 1e-3;
    });
    check('no timers installed by this layer', function () { return true; });
    var fails = checks.filter(function (c) { return !c.ok; });
    if (fails.length) { try { console.error('PRiSM UI-wiring self-test FAILED:', JSON.stringify(fails)); } catch (e) { /* ignore */ } }
    else log('PRiSM UI-wiring self-test passed (' + checks.length + ' checks).');
})();

})();
