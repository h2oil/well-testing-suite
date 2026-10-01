
// ═══════════════════════════════════════════════════════════════════════
// PRiSM Phase 3 + 4 expansion — auto-injected from prism-build/
//   • 04-ui-wiring         (Tabs 2-7 render fns + state seed + plot registry)
//   • 05-regression        (Levenberg-Marquardt + bootstrap + sandface conv)
//   • 06-decline-and-specialised (Arps/Duong/SEPD/Fetkovich + 3 PTA models)
//   • 07-data-enhancements (multi-format file parser + filters + col-mapper)
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 04-ui-wiring ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
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
    if (fit.adopted === false) {
        var why = '';
        (fit.warnings || []).forEach(function (m) { var mm = /Fit not adopted \((.*)\)/.exec(String(m)); if (mm) why = mm[1]; });
        return { cls: 'prism-bad', text: 'Fit not adopted' + (why ? ' (' + why + ')' : '') + ' — R² ' + (_isNum(r2) ? _fixed(r2, 4) : '—') + '; parameters were not changed.' };
    }
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
        // runRegression decides adoption (R², bounds, settled); legacy engines fall back.
        var good = typeof fit.adopted === 'boolean' ? fit.adopted : (fit.converged === true || (_isNum(fit.r2) && fit.r2 >= 0.9));
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

})();

// ─── END 04-ui-wiring ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 05-regression ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// =============================================================================
// PRiSM — Regression engine (layer 05)
// Levenberg-Marquardt + bootstrap + superposition + Agarwal time +
// dimensional (field-unit) pressure fits + rate (decline) fits.
// -----------------------------------------------------------------------------
// Public exports (all on window.*):
//
//   PRiSM_lm                   — Levenberg-Marquardt least squares (signature
//                                unchanged; new opts: logKeys, gtol)
//   PRiSM_bootstrap            — residual bootstrap CIs + P10/P50/P90
//   PRiSM_superposition        — convolve a rate history over a unit-rate model
//   PRiSM_sandface_convolution — multi-rate Agarwal equivalent time + Δp
//   PRiSM_agarwalTime          — Agarwal equivalent time for one flow period
//   PRiSM_fitPhysical          — field-unit pressure fit (k, C, S, pi, shape)
//                                → LastFit-shaped object (contract C4), not stored
//   PRiSM_fitRate              — decline fit on q (t in days) → LastFit-shaped object
//   PRiSM_runRegression        — Tab 6 glue: dispatch by model kind, store via
//                                PRiSM_setLastFit, never writes PRiSM_state.match
//
// Lower-level helpers (exposed for unit tests and other layers):
//   PRiSM_invertMatrix, PRiSM_solveLinear, PRiSM_jacobianForward,
//   PRiSM_tQuantile975
//
// Contracts consumed (all optional — local fallbacks when absent):
//   C1 PRiSM_getWell, C2 PRiSM_getAnalysisData, C3 PRiSM_physicalModel,
//   C4 PRiSM_setLastFit, C7 PRiSM_evalModelCurve / PRiSM_drawActivePlot /
//   PRiSM_setModel, PRiSM_compute_bourdet.
//
// Units: t in HOURS for pressure data (Δt since start of the analysed flow
// period), p in psia, q in STB/d (oil) or Mscf/d (gas). Rate (decline) fits
// run in DAYS: t_days = t_h / 24 unless the dataset says otherwise, and Di is
// reported in 1/day.
//
// Field-unit relations (contract C3):
//   A  = 141.2 q B μ / (k h)            psi per unit pD
//   B  = 0.0002637 k / (φ μ ct Lref²)   tD per hour
//   Cd = 0.8936 C / (φ ct h Lref²)
//   rinv = √(k t / (948 φ μ ct))
// =============================================================================


(function () {
'use strict';

var G = (typeof window !== 'undefined') ? window
      : (typeof globalThis !== 'undefined' ? globalThis : {});
var LN10 = Math.LN10;


// =============================================================================
// SECTION 1 — LINEAR ALGEBRA (Gauss-Jordan inversion + linear solver)
// =============================================================================

function _zeros2D(n, m) {
    if (m == null) m = n;
    var out = new Array(n);
    for (var i = 0; i < n; i++) {
        var row = new Array(m);
        for (var j = 0; j < m; j++) row[j] = 0;
        out[i] = row;
    }
    return out;
}

function _copy2D(A) {
    var n = A.length;
    var out = new Array(n);
    for (var i = 0; i < n; i++) out[i] = A[i].slice();
    return out;
}

/**
 * Invert an n×n matrix via Gauss-Jordan elimination with partial pivoting.
 * The input is preserved. Throws if A is singular or non-square.
 */
function PRiSM_invertMatrix(A) {
    if (!Array.isArray(A) || !A.length) throw new Error('PRiSM_invertMatrix: empty matrix');
    var n = A.length;
    for (var i = 0; i < n; i++) {
        if (!Array.isArray(A[i]) || A[i].length !== n) {
            throw new Error('PRiSM_invertMatrix: matrix must be square (got ' + n + 'x' + (A[i] ? A[i].length : '?') + ')');
        }
    }
    var M = new Array(n);
    for (var r = 0; r < n; r++) {
        var row = new Array(2 * n);
        for (var c = 0; c < n; c++) row[c] = A[r][c];
        for (var c2 = 0; c2 < n; c2++) row[n + c2] = (r === c2) ? 1 : 0;
        M[r] = row;
    }
    for (var k = 0; k < n; k++) {
        var pivotRow = k;
        var pivotVal = Math.abs(M[k][k]);
        for (var rr = k + 1; rr < n; rr++) {
            var v = Math.abs(M[rr][k]);
            if (v > pivotVal) { pivotVal = v; pivotRow = rr; }
        }
        if (!(pivotVal >= 1e-300)) {
            throw new Error('PRiSM_invertMatrix: matrix is singular (pivot ' + pivotVal + ' at column ' + k + ')');
        }
        if (pivotRow !== k) { var tmp = M[k]; M[k] = M[pivotRow]; M[pivotRow] = tmp; }
        var inv = 1.0 / M[k][k];
        for (var c3 = 0; c3 < 2 * n; c3++) M[k][c3] *= inv;
        for (var ir = 0; ir < n; ir++) {
            if (ir === k) continue;
            var f = M[ir][k];
            if (f === 0) continue;
            for (var c4 = 0; c4 < 2 * n; c4++) M[ir][c4] -= f * M[k][c4];
        }
    }
    var Ainv = _zeros2D(n, n);
    for (var rr2 = 0; rr2 < n; rr2++) {
        for (var cc = 0; cc < n; cc++) Ainv[rr2][cc] = M[rr2][n + cc];
    }
    return Ainv;
}

/** Solve A·x = b (Gauss-Jordan with partial pivoting). */
function PRiSM_solveLinear(A, b) {
    var n = A.length;
    if (b.length !== n) throw new Error('PRiSM_solveLinear: dimension mismatch (A is ' + n + 'x' + n + ', b is ' + b.length + ')');
    var M = new Array(n);
    for (var r = 0; r < n; r++) {
        var row = new Array(n + 1);
        for (var c = 0; c < n; c++) row[c] = A[r][c];
        row[n] = b[r];
        M[r] = row;
    }
    for (var k = 0; k < n; k++) {
        var pivotRow = k;
        var pivotVal = Math.abs(M[k][k]);
        for (var rr = k + 1; rr < n; rr++) {
            var v = Math.abs(M[rr][k]);
            if (v > pivotVal) { pivotVal = v; pivotRow = rr; }
        }
        if (!(pivotVal >= 1e-300)) {
            throw new Error('PRiSM_solveLinear: matrix is singular (pivot ' + pivotVal + ' at column ' + k + ')');
        }
        if (pivotRow !== k) { var tmp = M[k]; M[k] = M[pivotRow]; M[pivotRow] = tmp; }
        var inv = 1.0 / M[k][k];
        for (var c2 = 0; c2 <= n; c2++) M[k][c2] *= inv;
        for (var ir = 0; ir < n; ir++) {
            if (ir === k) continue;
            var f = M[ir][k];
            if (f === 0) continue;
            for (var c3 = 0; c3 <= n; c3++) M[ir][c3] -= f * M[k][c3];
        }
    }
    var x = new Array(n);
    for (var i = 0; i < n; i++) x[i] = M[i][n];
    return x;
}

// Inverse of a symmetric positive semi-definite matrix via diagonal
// (Jacobi) scaling, falling back to a small ridge. Returns null on failure.
function _safeInvert(A) {
    var n = A.length;
    var d = new Array(n);
    for (var i = 0; i < n; i++) d[i] = (A[i][i] > 0) ? 1 / Math.sqrt(A[i][i]) : 1;
    var S = _zeros2D(n, n);
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) S[r][c] = A[r][c] * d[r] * d[c];
    var inv = null;
    try { inv = PRiSM_invertMatrix(S); }
    catch (e) {
        for (var k = 0; k < n; k++) S[k][k] += 1e-10;
        try { inv = PRiSM_invertMatrix(S); } catch (e2) { return null; }
    }
    for (var r2 = 0; r2 < n; r2++) for (var c2 = 0; c2 < n; c2++) inv[r2][c2] *= d[r2] * d[c2];
    return inv;
}


// =============================================================================
// SECTION 2 — JACOBIAN VIA FORWARD DIFFERENCES
// =============================================================================
// Step size (relative): h_j = derivStep · max(|p_j|, floor_j) with
//   floor_j = min(1e-4 · (max − min), 1e-3)   for finite bounds
//   floor_j = 1e-3                             otherwise.
// The old max(|p|, 1) floor was far larger than small-magnitude parameters
// (λ ≈ 1e-6 was stepped by 1e-4). A pure 1e-8·range floor under-runs the
// precision of Stehfest-inverted models when a parameter sits at 0 (S = 0),
// so the floor is capped from both sides. Log-scaled keys are differenced in
// log10 space by PRiSM_lm, where |p| is O(1).
// =============================================================================

function _fdScale(p0, lo, hi) {
    var range = hi - lo;
    var floor = (isFinite(range) && range > 0) ? Math.min(1e-4 * range, 1e-3) : 1e-3;
    return Math.max(Math.abs(p0), floor);
}

/**
 * n × n_free forward-difference Jacobian ∂model_i/∂p_j.
 * @param bounds optional [[lo, hi], ...] aligned with freeKeys (a backward
 *               step is used when a forward step would leave the box).
 */
function PRiSM_jacobianForward(modelFn, t, params, baseline, freeKeys, derivStep, bounds) {
    var n = baseline.length;
    var nf = freeKeys.length;
    var J = _zeros2D(n, nf);
    for (var j = 0; j < nf; j++) {
        var k = freeKeys[j];
        var p0 = params[k];
        var lo = (bounds && bounds[j]) ? bounds[j][0] : -Infinity;
        var hi = (bounds && bounds[j]) ? bounds[j][1] : Infinity;
        var h = derivStep * _fdScale(p0, lo, hi);
        var dir = 1;
        if (isFinite(hi) && (p0 + h) > hi) dir = -1;
        if (dir < 0 && isFinite(lo) && (p0 - h) < lo) {
            h = Math.max(1e-15, Math.min(h, 0.5 * (hi - lo)));
            dir = (Math.abs(hi - p0) >= Math.abs(p0 - lo)) ? 1 : -1;
        }
        var pert = {};
        for (var k2 in params) if (Object.prototype.hasOwnProperty.call(params, k2)) pert[k2] = params[k2];
        pert[k] = p0 + dir * h;
        var fpert = null;
        try { fpert = modelFn(t, pert); } catch (err) { fpert = null; }
        if (!fpert || !_allFinite(fpert)) {
            var ok = false, hh = h;
            for (var s = 0; s < 3; s++) {
                hh *= 0.1;
                pert[k] = p0 + dir * hh;
                try { fpert = modelFn(t, pert); if (fpert && _allFinite(fpert)) { ok = true; h = hh; break; } }
                catch (err2) { /* keep shrinking */ }
            }
            if (!ok) { for (var i = 0; i < n; i++) J[i][j] = 0; continue; }
        }
        var inv_h = 1.0 / (dir * h);
        for (var i2 = 0; i2 < n; i2++) J[i2][j] = (fpert[i2] - baseline[i2]) * inv_h;
    }
    return J;
}

function _allFinite(a) {
    for (var i = 0; i < a.length; i++) if (!isFinite(a[i])) return false;
    return true;
}


// =============================================================================
// SECTION 3 — LEVENBERG-MARQUARDT NON-LINEAR LEAST SQUARES
// =============================================================================
//     (JᵀWJ + λ·diag(JᵀWJ)) · Δ = JᵀW·r
// Accept → λ·lambdaDown; reject → λ·lambdaUp.
//
// Convergence (honest):
//   'tolerance'  every free parameter moved less than `tolerance` (relative,
//                in the internal — log10 for log keys — coordinates);
//   'plateau'    SSR improved by < 1e-12 (relative) on 5 accepted steps;
//   'stationary' no step could be accepted, but the Gauss-Newton predicted
//                reduction (over parameters not pinned at a bound) is below
//                gtol·SSR — i.e. already at a (constrained) minimum;
//   'exact'      SSR ≈ 0.
// 'lambda-max' and 'maxIter' stops return converged:false.
//
// Statistics: σ² = Σ wᵢ rᵢ² / (n − p) (weighted), cov = σ² (JᵀWJ)⁻¹,
// CI = value ± t₀.₉₇₅(n−p)·se. Log keys get CIs in log space (then
// back-transformed), and all CIs are clipped to the bounds.
// identifiable[key] = false when the CI half-width exceeds |value|, when the
// key is correlated |r| > 0.98 with another free key, or when it sits at a bound.
// =============================================================================

var LM_DEFAULTS = {
    maxIter:        100,
    tolerance:      1e-6,
    gtol:           1e-6,
    lambda0:        0.001,
    lambdaUp:       10,
    lambdaDown:     0.1,
    lambdaMax:      1e10,
    lambdaMin:      1e-12,
    derivStep:      1e-4,
    weightingMode:  'uniform',   // 'uniform' | 'inverse_p' | 'inverse_log'
    onIter:         null,
    marquardtScale: 'jjdiag',    // 'jjdiag' | 'identity'
    logKeys:        null         // [key, ...] or {key:true} — fitted in log10
};

// Two-sided 95% Student-t quantiles, ν = 1..30.
var _T975 = [NaN, 12.7062, 4.3027, 3.1824, 2.7764, 2.5706, 2.4469, 2.3646, 2.3060,
    2.2622, 2.2281, 2.2010, 2.1788, 2.1604, 2.1448, 2.1314, 2.1199, 2.1098, 2.1009,
    2.0930, 2.0860, 2.0796, 2.0739, 2.0687, 2.0639, 2.0595, 2.0555, 2.0518, 2.0484,
    2.0452, 2.0423];

/** Student-t 0.975 quantile for ν degrees of freedom (table ≤ 30, Cornish-Fisher above). */
function PRiSM_tQuantile975(nu) {
    nu = Math.floor(nu);
    if (!(nu >= 1)) return NaN;
    if (nu <= 30) return _T975[nu];
    var z = 1.959963985, z2 = z * z, z3 = z2 * z, z5 = z3 * z2, z7 = z5 * z2, z9 = z7 * z2;
    return z + (z3 + z) / (4 * nu)
             + (5 * z5 + 16 * z3 + 3 * z) / (96 * nu * nu)
             + (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * nu * nu * nu)
             + (79 * z9 + 776 * z7 + 1482 * z5 - 1920 * z3 - 945 * z) / (92160 * nu * nu * nu * nu);
}

function _buildWeights(p, mode, explicit) {
    var n = p.length;
    var W = new Array(n);
    if (Array.isArray(explicit) && explicit.length === n) {
        for (var i = 0; i < n; i++) W[i] = (explicit[i] > 0) ? explicit[i] : 0;
        return W;
    }
    if (mode === 'inverse_p') {
        for (var i2 = 0; i2 < n; i2++) {
            var ap = Math.abs(p[i2]);
            W[i2] = (ap > 1e-20) ? (1.0 / (ap * ap)) : 1.0;
        }
        return W;
    }
    if (mode === 'inverse_log') {
        for (var i3 = 0; i3 < n; i3++) {
            var lp = Math.log(Math.max(Math.abs(p[i3]), 1e-20));
            W[i3] = 1.0 / Math.max(lp * lp, 1e-6);
        }
        return W;
    }
    for (var i4 = 0; i4 < n; i4++) W[i4] = 1.0;
    return W;
}

function _ssr(yObs, yMod, W) {
    var s = 0;
    for (var i = 0; i < yObs.length; i++) {
        var r = yObs[i] - yMod[i];
        s += W[i] * r * r;
    }
    return s;
}

// Free parameters: numeric, finite, not frozen, not injected ('__*').
function _activeParams(params0, freeze) {
    var keys = [];
    for (var k in params0) {
        if (!Object.prototype.hasOwnProperty.call(params0, k)) continue;
        if (k.indexOf('__') === 0) continue;
        if (freeze && freeze[k] === true) continue;
        var v = params0[k];
        if (typeof v !== 'number' || !isFinite(v)) continue;
        keys.push(k);
    }
    return keys;
}

function _keySet(x) {
    var out = {};
    if (!x) return out;
    if (Array.isArray(x)) { for (var i = 0; i < x.length; i++) out[x[i]] = true; return out; }
    if (typeof x === 'object') { for (var k in x) if (x[k]) out[k] = true; }
    return out;
}

function _clipInternal(params, freeKeys, ib) {
    for (var j = 0; j < freeKeys.length; j++) {
        var k = freeKeys[j], b = ib[k];
        if (params[k] < b[0]) params[k] = b[0];
        if (params[k] > b[1]) params[k] = b[1];
    }
    return params;
}

/**
 * Levenberg-Marquardt least-squares fit.
 *
 * @param {Function} modelFn  f(t_array, params_obj) → y_array
 * @param {object}   data     { t: number[], p: number[], weights?: number[] }
 * @param {object}   params0  initial guess (strings / '__*' keys pass through)
 * @param {object=}  bounds   { key: [lo, hi], ... }  (external units)
 * @param {object=}  freeze   { key: true|false, ... }
 * @param {object=}  opts     see LM_DEFAULTS
 * @return {object} { params, stderr, ci95, ssr, rmse, r2, aic, iterations,
 *                    converged, stopReason, covariance, corr, identifiable,
 *                    atBound, sigma2, dof, tQuantile, residualHistory,
 *                    nFreeParams, nObs, freeKeys, logKeys }
 */
function PRiSM_lm(modelFn, data, params0, bounds, freeze, opts) {
    if (typeof modelFn !== 'function') throw new Error('PRiSM_lm: modelFn must be a function');
    if (!data || !Array.isArray(data.t) || !Array.isArray(data.p)) {
        throw new Error('PRiSM_lm: data must have t[] and p[] arrays');
    }
    if (data.t.length !== data.p.length) {
        throw new Error('PRiSM_lm: data.t and data.p must have the same length');
    }
    if (data.t.length < 2) throw new Error('PRiSM_lm: need at least 2 data points');

    var O = {};
    for (var k0 in LM_DEFAULTS) if (Object.prototype.hasOwnProperty.call(LM_DEFAULTS, k0)) O[k0] = LM_DEFAULTS[k0];
    if (opts) for (var k1 in opts) if (Object.prototype.hasOwnProperty.call(opts, k1) && opts[k1] !== undefined) O[k1] = opts[k1];

    var logSet = _keySet(O.logKeys);
    var freeKeys = _activeParams(params0, freeze);

    // Internal coordinates: log10 for positive log keys.
    var isLog = {}, ib = {}, extBounds = {};
    for (var fk = 0; fk < freeKeys.length; fk++) {
        var key = freeKeys[fk];
        var b = bounds && bounds[key];
        var lo = (b && isFinite(b[0])) ? b[0] : -Infinity;
        var hi = (b && isFinite(b[1])) ? b[1] : Infinity;
        extBounds[key] = [lo, hi];
        isLog[key] = !!logSet[key] && params0[key] > 0;
        if (isLog[key]) {
            ib[key] = [lo > 0 ? Math.log10(lo) : -Infinity, hi > 0 ? Math.log10(hi) : Infinity];
        } else {
            ib[key] = [lo, hi];
        }
    }
    function toExt(pInt) {
        var o = {};
        for (var kk in pInt) if (Object.prototype.hasOwnProperty.call(pInt, kk)) o[kk] = pInt[kk];
        for (var j = 0; j < freeKeys.length; j++) {
            var kj = freeKeys[j];
            if (isLog[kj]) o[kj] = Math.pow(10, pInt[kj]);
        }
        return o;
    }
    var fInt = function (t, pInt) { return modelFn(t, toExt(pInt)); };

    var params = {};
    for (var kk in params0) if (Object.prototype.hasOwnProperty.call(params0, kk)) params[kk] = params0[kk];
    for (var fk2 = 0; fk2 < freeKeys.length; fk2++) {
        var kf = freeKeys[fk2];
        if (isLog[kf]) params[kf] = Math.log10(params0[kf]);
    }
    _clipInternal(params, freeKeys, ib);

    var W = _buildWeights(data.p, O.weightingMode, data.weights);
    var ctx = { isLog: isLog, ib: ib, extBounds: extBounds, toExt: toExt, stopReason: 'none' };

    var yMod = fInt(data.t, params);
    var ssr = _ssr(data.p, yMod, W);
    if (!freeKeys.length) {
        ctx.stopReason = 'no-free-params';
        return _buildResult(params, freeKeys, null, data, yMod, W, ssr, 0, false, [ssr], ctx);
    }
    if (!isFinite(ssr)) {
        ctx.stopReason = 'non-finite-start';
        return _buildResult(params, freeKeys, null, data, yMod, W, ssr, 0, false, [ssr], ctx);
    }

    var boundArr = freeKeys.map(function (k) { return ib[k]; });
    var history = [ssr];
    var lambda = O.lambda0;
    var iter = 0;
    var converged = false;
    var stagnantSteps = 0;
    var nf = freeKeys.length;
    var n = data.p.length;
    // 'exact' fit: weighted RMS residual ≤ 1e-7 of max(1, |y|) — at the
    // precision of the Laplace-inversion models themselves.
    var exactSsr = 0;
    for (var ex = 0; ex < n; ex++) exactSsr += W[ex] * Math.max(1, data.p[ex] * data.p[ex]);
    exactSsr *= 1e-14;

    // Optional budget: O.deadline (wall clock, ms since epoch) and/or
    // O.shouldStop() (e.g. an evaluation-cost budget). The race fits use it so
    // one slow model cannot block the UI for minutes. Stops with
    // converged:false, stopReason 'budget'.
    var hasDeadline = typeof O.deadline === 'number' && isFinite(O.deadline);
    var overBudget = function () {
        if (hasDeadline && Date.now() > O.deadline) return true;
        if (typeof O.shouldStop === 'function') { try { return !!O.shouldStop(); } catch (e) { return false; } }
        return false;
    };
    while (iter < O.maxIter) {
        iter++;
        if (ssr <= exactSsr) { converged = true; ctx.stopReason = 'exact'; break; }
        if (overBudget()) { ctx.stopReason = 'budget'; break; }

        var J = PRiSM_jacobianForward(fInt, data.t, params, yMod, freeKeys, O.derivStep, boundArr);
        var JtWJ = _zeros2D(nf, nf);
        var JtWr = new Array(nf);
        for (var jj = 0; jj < nf; jj++) JtWr[jj] = 0;
        for (var i = 0; i < n; i++) {
            var ri = data.p[i] - yMod[i];
            var wi = W[i];
            if (wi === 0) continue;
            for (var a = 0; a < nf; a++) {
                var Jia = J[i][a];
                if (Jia === 0) continue;
                JtWr[a] += wi * Jia * ri;
                for (var bb = a; bb < nf; bb++) JtWJ[a][bb] += wi * Jia * J[i][bb];
            }
        }
        for (var a2 = 0; a2 < nf; a2++) for (var b2 = a2 + 1; b2 < nf; b2++) JtWJ[b2][a2] = JtWJ[a2][b2];
        var diagJtWJ = new Array(nf);
        for (var d = 0; d < nf; d++) diagJtWJ[d] = Math.max(JtWJ[d][d], 1e-30);

        var accepted = false, innerTries = 0;
        var newSsr = ssr, newParams = params, newYMod = yMod;
        while (!accepted && innerTries < 40) {
            if (innerTries > 0 && overBudget()) break;
            innerTries++;
            var A = _copy2D(JtWJ);
            for (var dd = 0; dd < nf; dd++) {
                if (O.marquardtScale === 'identity') A[dd][dd] += lambda;
                else A[dd][dd] += lambda * diagJtWJ[dd];
            }
            var deltaTry;
            try { deltaTry = PRiSM_solveLinear(A, JtWr); }
            catch (e) { lambda *= O.lambdaUp; if (lambda > O.lambdaMax) break; continue; }
            var trialParams = {};
            for (var pk in params) if (Object.prototype.hasOwnProperty.call(params, pk)) trialParams[pk] = params[pk];
            for (var jj2 = 0; jj2 < nf; jj2++) trialParams[freeKeys[jj2]] = params[freeKeys[jj2]] + deltaTry[jj2];
            _clipInternal(trialParams, freeKeys, ib);
            var trialY = null;
            try { trialY = fInt(data.t, trialParams); } catch (err) { trialY = null; }
            var trialSsr = trialY ? _ssr(data.p, trialY, W) : NaN;
            if (isFinite(trialSsr) && trialSsr < ssr) {
                accepted = true;
                newSsr = trialSsr; newParams = trialParams; newYMod = trialY;
                lambda = Math.max(lambda * O.lambdaDown, O.lambdaMin);
            } else {
                lambda *= O.lambdaUp;
                if (lambda > O.lambdaMax) break;
            }
        }

        if (!accepted) {
            history.push(ssr);
            if (typeof O.onIter === 'function') { try { O.onIter(iter, toExt(params), ssr, lambda); } catch (_) {} }
            var pred = _gnPredictedDecrease(JtWJ, JtWr, params, freeKeys, ib);
            if (ssr <= exactSsr) {
                converged = true; ctx.stopReason = 'exact';
            } else if (isFinite(pred) && pred <= O.gtol * Math.max(ssr, 1e-300)) {
                converged = true; ctx.stopReason = 'stationary';
            } else {
                ctx.stopReason = overBudget() ? 'budget' : 'lambda-max';
            }
            break;
        }

        var maxRel = 0;
        for (var rk = 0; rk < nf; rk++) {
            var kr = freeKeys[rk];
            var rel = Math.abs(newParams[kr] - params[kr]) / _fdScale(params[kr], ib[kr][0], ib[kr][1]);
            if (rel > maxRel) maxRel = rel;
        }
        if (Math.abs(ssr - newSsr) < 1e-12 * Math.max(Math.abs(ssr), 1e-300)) stagnantSteps++;
        else stagnantSteps = 0;

        params = newParams; yMod = newYMod; ssr = newSsr;
        history.push(ssr);
        if (typeof O.onIter === 'function') { try { O.onIter(iter, toExt(params), ssr, lambda); } catch (_) {} }

        if (maxRel < O.tolerance) { converged = true; ctx.stopReason = 'tolerance'; break; }
        if (stagnantSteps >= 5) { converged = true; ctx.stopReason = 'plateau'; break; }
    }
    if (!converged && ctx.stopReason === 'none') ctx.stopReason = 'maxIter';

    var Jfinal = PRiSM_jacobianForward(fInt, data.t, params, yMod, freeKeys, O.derivStep, boundArr);
    return _buildResult(params, freeKeys, Jfinal, data, yMod, W, ssr, iter, converged, history, ctx);
}

// Gauss-Newton predicted SSR decrease over parameters that are not pinned at
// a bound with the gradient pushing outward. Used to recognise a minimum when
// no damped step can be accepted (round-off floor).
function _gnPredictedDecrease(JtWJ, JtWr, params, freeKeys, ib) {
    var idx = [];
    for (var j = 0; j < freeKeys.length; j++) {
        var k = freeKeys[j], v = params[k], b = ib[k];
        var span = (isFinite(b[1] - b[0]) ? (b[1] - b[0]) : 1) * 1e-9;
        var atLo = isFinite(b[0]) && v <= b[0] + span;
        var atHi = isFinite(b[1]) && v >= b[1] - span;
        if ((atLo && JtWr[j] < 0) || (atHi && JtWr[j] > 0)) continue;
        if (JtWJ[j][j] <= 0) continue;
        idx.push(j);
    }
    if (!idx.length) return 0;
    var m = idx.length;
    var A = _zeros2D(m, m), g = new Array(m);
    for (var a = 0; a < m; a++) {
        g[a] = JtWr[idx[a]];
        for (var c = 0; c < m; c++) A[a][c] = JtWJ[idx[a]][idx[c]];
        A[a][a] *= (1 + 1e-10);
    }
    var inv = _safeInvert(A);
    if (!inv) return Infinity;
    var pred = 0;
    for (var r = 0; r < m; r++) for (var s = 0; s < m; s++) pred += g[r] * inv[r][s] * g[s];
    return pred;
}

function _buildResult(params, freeKeys, J, data, yMod, W, ssr, iter, converged, history, ctx) {
    var n = data.p.length;
    var p = freeKeys.length;
    var dof = Math.max(n - p, 1);
    var ext = ctx.toExt(params);

    var ssrU = 0, pMean = 0;
    for (var i = 0; i < n; i++) pMean += data.p[i];
    pMean /= Math.max(n, 1);
    var ssTot = 0;
    for (var i2 = 0; i2 < n; i2++) {
        var dv = data.p[i2] - pMean, rr = data.p[i2] - yMod[i2];
        ssTot += dv * dv; ssrU += rr * rr;
    }
    var rmse = Math.sqrt(ssrU / Math.max(n, 1));
    var r2 = (ssTot > 1e-20) ? (1 - ssrU / ssTot) : NaN;
    var aic = (ssr > 0 && n > 0) ? (n * Math.log(ssr / n) + 2 * p) : (ssr === 0 ? -Infinity : NaN);

    var sigma2 = ssr / dof;
    var tq = PRiSM_tQuantile975(dof);
    var stderr = {}, ci95 = {}, identifiable = {}, atBound = {};
    var covariance = null, corr = null;

    for (var q = 0; q < p; q++) {
        var kq = freeKeys[q], bq = ctx.ib[kq], vq = params[kq];
        var span = isFinite(bq[1] - bq[0]) ? (bq[1] - bq[0]) : Math.max(Math.abs(vq), 1);
        // 1e-3 of the internal span (~0.9 % relative on a 4-decade log range):
        // a fit converging ONTO a bound under a wall-clock budget stops a hair
        // inside it (xf = 1.00002 ft on a 1 ft floor) and must still count as
        // stalled, or ▶ Analyse commits a degenerate model.
        atBound[kq] = (isFinite(bq[0]) && vq <= bq[0] + 1e-3 * span) ||
                      (isFinite(bq[1]) && vq >= bq[1] - 1e-3 * span);
    }

    if (J && p > 0 && J.length === n) {
        var JtWJ = _zeros2D(p, p);
        for (var ii = 0; ii < n; ii++) {
            var wi = W[ii];
            if (!wi) continue;
            for (var aa = 0; aa < p; aa++) {
                var Jia = J[ii][aa];
                if (Jia === 0) continue;
                for (var bb = aa; bb < p; bb++) JtWJ[aa][bb] += wi * Jia * J[ii][bb];
            }
        }
        for (var aa2 = 0; aa2 < p; aa2++) for (var bb2 = aa2 + 1; bb2 < p; bb2++) JtWJ[bb2][aa2] = JtWJ[aa2][bb2];
        var zeroCol = false;
        for (var zc = 0; zc < p; zc++) if (!(JtWJ[zc][zc] > 0)) zeroCol = true;
        var inv = zeroCol ? null : _safeInvert(JtWJ);
        if (inv) {
            var covInt = _zeros2D(p, p);
            for (var u = 0; u < p; u++) for (var v = 0; v < p; v++) covInt[u][v] = sigma2 * inv[u][v];
            corr = _zeros2D(p, p);
            covariance = _zeros2D(p, p);
            var dExt = new Array(p);
            for (var e = 0; e < p; e++) dExt[e] = ctx.isLog[freeKeys[e]] ? ext[freeKeys[e]] * LN10 : 1;
            for (var u2 = 0; u2 < p; u2++) {
                for (var v2 = 0; v2 < p; v2++) {
                    var den = Math.sqrt(Math.abs(covInt[u2][u2] * covInt[v2][v2]));
                    corr[u2][v2] = den > 0 ? covInt[u2][v2] / den : (u2 === v2 ? 1 : 0);
                    covariance[u2][v2] = covInt[u2][v2] * dExt[u2] * dExt[v2];
                }
            }
            for (var f = 0; f < p; f++) {
                var kf = freeKeys[f];
                var seInt = covInt[f][f] > 0 ? Math.sqrt(covInt[f][f]) : NaN;
                var val = ext[kf], lo, hi, se;
                if (ctx.isLog[kf]) {
                    se = val * LN10 * seInt;
                    lo = Math.pow(10, params[kf] - tq * seInt);
                    hi = Math.pow(10, params[kf] + tq * seInt);
                } else {
                    se = seInt;
                    lo = val - tq * seInt;
                    hi = val + tq * seInt;
                }
                var eb = ctx.extBounds[kf];
                if (isFinite(lo) && lo < eb[0]) lo = eb[0];
                if (isFinite(hi) && hi > eb[1]) hi = eb[1];
                stderr[kf] = se;
                ci95[kf] = isFinite(seInt) ? [lo, hi] : [NaN, NaN];
            }
        }
    }
    for (var g = 0; g < p; g++) {
        var kg = freeKeys[g];
        var okId = !atBound[kg];
        var ci = ci95[kg];
        if (!ci || !isFinite(ci[0]) || !isFinite(ci[1])) okId = false;
        else if ((ci[1] - ci[0]) / 2 > Math.abs(ext[kg])) okId = false;
        if (corr) {
            for (var h = 0; h < p; h++) if (h !== g && Math.abs(corr[g][h]) > 0.98) okId = false;
        }
        identifiable[kg] = okId;
    }
    for (var pk in ext) {
        if (!Object.prototype.hasOwnProperty.call(ext, pk)) continue;
        if (!(pk in stderr)) { stderr[pk] = NaN; ci95[pk] = [NaN, NaN]; }
    }
    var logKeys = freeKeys.filter(function (k) { return ctx.isLog[k]; });

    return {
        params:           ext,
        stderr:           stderr,
        ci95:             ci95,
        ssr:              ssr,
        rmse:             rmse,
        r2:               r2,
        aic:              aic,
        iterations:       iter,
        converged:        !!converged,
        stopReason:       ctx.stopReason,
        covariance:       covariance,
        corr:             corr,
        identifiable:     identifiable,
        atBound:          atBound,
        sigma2:           sigma2,
        dof:              dof,
        tQuantile:        tq,
        residualHistory:  history,
        nFreeParams:      p,
        nObs:             n,
        freeKeys:         freeKeys.slice(),
        logKeys:          logKeys
    };
}


// =============================================================================
// SECTION 4 — BOOTSTRAP CONFIDENCE INTERVALS
// =============================================================================
// Residual bootstrap (Efron): resample the fitted residuals, refit, collect.
// Returns percentile CIs plus P10 / P50 / P90 per free parameter (P90 is
// the LOW value in the reserves convention, i.e. the 10th percentile —
// here reported by name: p10 = 10th percentile, p90 = 90th percentile).
// =============================================================================

/**
 * @param {Function} modelFn
 * @param {object}   data          { t, p, weights? }
 * @param {object}   fittedParams  best-fit params from PRiSM_lm
 * @param {object=}  opts          { nBootstrap: 200, ci: 0.95, bounds, freeze,
 *                                   lmOpts, seed, onProgress }
 * @return {object}  { ci, distributions, percentiles:{key:{p10,p50,p90}},
 *                     nBootstrap, failures }
 */
function PRiSM_bootstrap(modelFn, data, fittedParams, opts) {
    opts = opts || {};
    var nBoot = opts.nBootstrap || 200;
    var ciLevel = (opts.ci != null) ? opts.ci : 0.95;
    var lmOpts = opts.lmOpts || { maxIter: 30, tolerance: 1e-5 };
    var bounds = opts.bounds || null;
    var freeze = opts.freeze || null;
    var onProgress = (typeof opts.onProgress === 'function') ? opts.onProgress : null;
    var rng = _makeRng(opts.seed);

    var yHat = modelFn(data.t, fittedParams);
    var n = data.p.length;
    var residuals = new Array(n);
    for (var i = 0; i < n; i++) residuals[i] = data.p[i] - yHat[i];

    var distributions = {};
    var freeKeys = _activeParams(fittedParams, freeze);
    for (var k = 0; k < freeKeys.length; k++) distributions[freeKeys[k]] = [];

    var failures = 0;
    for (var b = 0; b < nBoot; b++) {
        var pStar = new Array(n);
        for (var i2 = 0; i2 < n; i2++) {
            var idx = (rng() * n) | 0;
            if (idx >= n) idx = n - 1;
            pStar[i2] = yHat[i2] + residuals[idx];
        }
        var init = {};
        for (var pk in fittedParams) if (Object.prototype.hasOwnProperty.call(fittedParams, pk)) init[pk] = fittedParams[pk];
        var res;
        try { res = PRiSM_lm(modelFn, { t: data.t, p: pStar, weights: data.weights }, init, bounds, freeze, lmOpts); }
        catch (err) { failures++; continue; }
        for (var fk2 = 0; fk2 < freeKeys.length; fk2++) {
            var v = res.params[freeKeys[fk2]];
            if (isFinite(v)) distributions[freeKeys[fk2]].push(v);
        }
        if (onProgress) { try { onProgress(b + 1, nBoot); } catch (_) {} }
    }

    var alpha = (1 - ciLevel) / 2;
    var ci = {}, percentiles = {};
    for (var fk3 = 0; fk3 < freeKeys.length; fk3++) {
        var key2 = freeKeys[fk3];
        var arr = distributions[key2].slice().sort(function (a, b) { return a - b; });
        if (arr.length < 4) {
            ci[key2] = [NaN, NaN];
            percentiles[key2] = { p10: NaN, p50: NaN, p90: NaN };
            continue;
        }
        ci[key2] = [_percentile(arr, alpha), _percentile(arr, 1 - alpha)];
        percentiles[key2] = { p10: _percentile(arr, 0.1), p50: _percentile(arr, 0.5), p90: _percentile(arr, 0.9) };
    }
    return { ci: ci, distributions: distributions, percentiles: percentiles, nBootstrap: nBoot, failures: failures };
}

function _percentile(sorted, q) {
    var n = sorted.length;
    if (n === 0) return NaN;
    if (n === 1) return sorted[0];
    var pos = q * (n - 1);
    var lo = Math.floor(pos), hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
}

// mulberry32 PRNG; Math.random when no seed.
function _makeRng(seed) {
    if (seed == null) return Math.random;
    var s = (seed | 0) || 1;
    return function () {
        s |= 0; s = (s + 0x6D2B79F5) | 0;
        var t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return (((t ^ (t >>> 14)) >>> 0) / 4294967296);
    };
}


// =============================================================================
// SECTION 5 — MULTI-RATE SUPERPOSITION
// =============================================================================
//   p(t) = Σ_{i: t_i < t} (q_i − q_{i-1}) · p_unit(t − t_i),  q_{-1} = 0
// =============================================================================

/**
 * @param {Function} modelFn      f(td_array, params) → pd_array
 * @param {object[]} rateHistory  [{ t_start (or t), q }, ...]
 * @param {number[]} evalTimes    real-time points to evaluate
 * @param {object}   params       model parameters
 * @param {Function=} tdNormaliser f(t_real, params) → td (default identity)
 */
function PRiSM_superposition(modelFn, rateHistory, evalTimes, params, tdNormaliser) {
    if (!Array.isArray(rateHistory) || !rateHistory.length) {
        throw new Error('PRiSM_superposition: rateHistory must be a non-empty array');
    }
    if (!Array.isArray(evalTimes) || !evalTimes.length) {
        throw new Error('PRiSM_superposition: evalTimes must be a non-empty array');
    }
    var ndt = (typeof tdNormaliser === 'function') ? tdNormaliser : function (t) { return t; };
    var rh = _normSteps(rateHistory);
    var dq = new Array(rh.length);
    for (var i = 0; i < rh.length; i++) dq[i] = rh[i].q - ((i === 0) ? 0 : rh[i - 1].q);
    var n = evalTimes.length;
    var out = new Array(n);
    for (var k = 0; k < n; k++) out[k] = 0;
    for (var i2 = 0; i2 < rh.length; i2++) {
        if (dq[i2] === 0) continue;
        var tStart = rh[i2].t;
        var tdActive = [], tdIdx = [];
        for (var j = 0; j < n; j++) {
            var dt = evalTimes[j] - tStart;
            if (dt <= 0) continue;
            tdActive.push(ndt(dt, params));
            tdIdx.push(j);
        }
        if (!tdActive.length) continue;
        var pUnit;
        try { pUnit = modelFn(tdActive, params); }
        catch (err) {
            pUnit = new Array(tdActive.length);
            for (var s = 0; s < tdActive.length; s++) {
                try { pUnit[s] = modelFn([tdActive[s]], params)[0]; } catch (e2) { pUnit[s] = 0; }
            }
        }
        for (var c = 0; c < tdIdx.length; c++) out[tdIdx[c]] += dq[i2] * pUnit[c];
    }
    return out;
}

// Normalise a rate history to sorted [{t, q}] (accepts t_start or t).
function _normSteps(rh) {
    var out = [];
    if (!Array.isArray(rh)) return out;
    for (var i = 0; i < rh.length; i++) {
        var r = rh[i] || {};
        var t = (r.t_start != null) ? +r.t_start : (r.t != null ? +r.t : (r.t0 != null ? +r.t0 : NaN));
        var q = +r.q;
        if (isFinite(t) && isFinite(q)) out.push({ t: t, q: q, t_start: t });
    }
    out.sort(function (a, b) { return a.t - b.t; });
    return out;
}


// =============================================================================
// SECTION 6 — RATE STEPS, SUPERPOSITION TIME, AGARWAL EQUIVALENT TIME
// =============================================================================
// Rate-step convention for sampled data: the rate on row i applies over
// (t[i−1], t[i]]; a change of rate between rows i−1 and i therefore starts at
// t[i−1]. Rates within 1 % (relative) are merged into one step.
//
// For the analysed period n (0-based step index, start ts_n, rate change
// Δq_n = q_n − q_{n−1}):
//   superposition  sup(Δt) = Σ_{i=0..n} (Δq_i/Δq_n) · ln(ts_n − ts_i + Δt)
//   Agarwal        ln Δte  = sup(Δt) − Σ_{i<n} (Δq_i/Δq_n) · ln(ts_n − ts_i)
// For a shut-in (q_n = 0) the Agarwal expression equals the textbook
//   ln Δte = Σ_{i<n} (Δq_i/q_{n−1}) · ln[(ts_n − ts_i)·Δt / (ts_n − ts_i + Δt)]
// and for a single rate Δte = tp·Δt/(tp + Δt).
// =============================================================================

function _sameRate(a, b) {
    var m = Math.max(Math.abs(a), Math.abs(b));
    return m === 0 || Math.abs(a - b) <= 0.01 * m;
}

function _rateStepsFromSamples(t, q) {
    var steps = [];
    if (!Array.isArray(t) || !Array.isArray(q)) return steps;
    var cur = null, lastT = null;
    for (var i = 0; i < t.length; i++) {
        var ti = +t[i], qi = +q[i];
        if (!isFinite(ti) || !isFinite(qi)) continue;
        if (cur === null) {
            cur = { t: Math.min(0, ti), q: qi };
            steps.push(cur);
        } else if (!_sameRate(qi, cur.q)) {
            cur = { t: (lastT != null ? lastT : ti), q: qi };
            steps.push(cur);
        }
        lastT = ti;
    }
    return steps;
}

function _supTime(dt, steps, n) {
    var dqn = steps[n].q - (n > 0 ? steps[n - 1].q : 0);
    if (dqn === 0 || n === 0) return Math.log(dt);
    var tsn = steps[n].t, s = 0;
    for (var i = 0; i <= n; i++) {
        var dqi = steps[i].q - (i > 0 ? steps[i - 1].q : 0);
        if (dqi === 0) continue;
        s += (dqi / dqn) * Math.log(tsn - steps[i].t + dt);
    }
    return s;
}

function _agarwalConst(steps, n) {
    var dqn = steps[n].q - (n > 0 ? steps[n - 1].q : 0);
    if (dqn === 0 || n === 0) return 0;
    var tsn = steps[n].t, c = 0;
    for (var i = 0; i < n; i++) {
        var dqi = steps[i].q - (i > 0 ? steps[i - 1].q : 0);
        if (dqi === 0) continue;
        c += (dqi / dqn) * Math.log(tsn - steps[i].t);
    }
    return c;
}

/**
 * Agarwal equivalent time for Δt values in flow period n.
 * @param {number|number[]} dt           elapsed time since the start of period n (hr)
 * @param {object[]}        rateHistory  [{t|t_start, q}]
 * @param {number=}         n            period index (default: last step)
 */
function PRiSM_agarwalTime(dt, rateHistory, n) {
    var steps = _normSteps(rateHistory);
    var scalar = !Array.isArray(dt);
    var arr = scalar ? [dt] : dt;
    if (!steps.length) return scalar ? arr[0] : arr.slice();
    if (n == null || !(n >= 0) || n >= steps.length) n = steps.length - 1;
    var c = _agarwalConst(steps, n);
    var out = arr.map(function (x) {
        if (!(x > 0)) return NaN;
        return Math.exp(_supTime(x, steps, n) - c);
    });
    return scalar ? out[0] : out;
}

// Producing time tp = Np / q_{n−1} for period n.
function _producingTime(steps, n) {
    if (!(n > 0)) return null;
    var qn1 = steps[n - 1].q;
    if (!qn1) return null;
    var np = 0;
    for (var i = 0; i < n; i++) np += steps[i].q * (steps[i + 1].t - steps[i].t);
    return np / qn1;
}

function _interpAt(x, y, xt) {
    var n = x.length;
    if (xt <= x[0]) return y[0];
    if (xt >= x[n - 1]) return y[n - 1];
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) {
        var mid = (lo + hi) >> 1;
        if (x[mid] > xt) hi = mid; else lo = mid;
    }
    var f = (xt - x[lo]) / (x[hi] - x[lo]);
    return y[lo] + f * (y[hi] - y[lo]);
}

/**
 * Multi-rate Agarwal equivalent time + Δp for plotting a later flow period on
 * a single-rate diagnostic axis.
 *
 * @param {object}  data        { t, p, q?, rateHistory?, pRef? }
 * @param {number=} refRateIdx  period (rate step) to analyse; default = last
 * @return {object} { teq[], dp_eff[], dt[], tShut, tp, pRef, rateHistory, method }
 *                  teq / dp_eff are NaN for samples before the period start.
 */
function PRiSM_sandface_convolution(data, refRateIdx) {
    if (!data || !Array.isArray(data.t) || !Array.isArray(data.p)) {
        throw new Error('PRiSM_sandface_convolution: data must have t[] and p[] arrays');
    }
    if (data.t.length !== data.p.length) {
        throw new Error('PRiSM_sandface_convolution: t and p must be the same length');
    }
    var steps = _normSteps(data.rateHistory);
    if (!steps.length && typeof G.PRiSM_getAnalysisData === 'function' && Array.isArray(data.q)) {
        try {
            var ad = G.PRiSM_getAnalysisData({ t: data.t, p: data.p, q: data.q }, { timeFn: 'agarwal' });
            if (ad && ad.ok && Array.isArray(ad.rateHistory)) steps = _normSteps(ad.rateHistory);
        } catch (e) { steps = []; }
    }
    if (!steps.length) {
        if (!Array.isArray(data.q) || data.q.length !== data.t.length) {
            throw new Error('PRiSM_sandface_convolution: need q[] or rateHistory');
        }
        steps = _rateStepsFromSamples(data.t, data.q);
    }
    var n = (refRateIdx == null) ? steps.length - 1 : Math.max(0, Math.min(steps.length - 1, refRateIdx | 0));
    var tShut = steps[n].t;
    var pRef = isFinite(data.pRef) ? +data.pRef : _interpAt(data.t, data.p, tShut);
    var c = _agarwalConst(steps, n);
    var tEnd = (n + 1 < steps.length) ? steps[n + 1].t : Infinity;
    var N = data.t.length;
    var teq = new Array(N), dpEff = new Array(N), dts = new Array(N);
    for (var j = 0; j < N; j++) {
        var dt = data.t[j] - tShut;
        if (!(dt > 0) || data.t[j] > tEnd) { teq[j] = NaN; dpEff[j] = NaN; dts[j] = NaN; continue; }
        dts[j] = dt;
        teq[j] = Math.exp(_supTime(dt, steps, n) - c);
        dpEff[j] = Math.abs(data.p[j] - pRef);
    }
    return {
        teq: teq, dp_eff: dpEff, dt: dts,
        tShut: tShut, tp: _producingTime(steps, n), pRef: pRef,
        rateHistory: steps.map(function (s) { return { t: s.t, q: s.q }; }),
        method: (n === 0) ? 'drawdown' : 'agarwal'
    };
}


// =============================================================================
// SECTION 7 — LOCAL FALLBACKS FOR CONTRACTS C1 / C2 / C3
// =============================================================================
// Used only when the core layer (PRiSM_getWell / PRiSM_getAnalysisData /
// PRiSM_physicalModel) is not loaded. They follow the same contract shapes.
// =============================================================================

function _num(x) { return typeof x === 'number' && isFinite(x); }
function _pos(x) { return _num(x) && x > 0; }
function _pick() {
    for (var i = 0; i < arguments.length; i++) {
        var v = arguments[i];
        if (v !== null && v !== undefined && v !== '' && isFinite(+v)) return +v;
    }
    return null;
}
function _median(a) {
    var s = a.filter(function (v) { return isFinite(v); }).sort(function (x, y) { return x - y; });
    if (!s.length) return NaN;
    var m = s.length >> 1;
    return (s.length % 2) ? s[m] : 0.5 * (s[m - 1] + s[m]);
}
function _registry() { return (G.PRiSM_MODELS && typeof G.PRiSM_MODELS === 'object') ? G.PRiSM_MODELS : {}; }
function _state() { return G.PRiSM_state || null; }
function _copy(o) {
    var out = {};
    if (!o) return out;
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k];
    return out;
}

// 3-point Bourdet derivative d y / d ln x with smoothing window L (ln units).
function _bourdet(x, y, L) {
    if (typeof G.PRiSM_compute_bourdet === 'function') {
        try { var r = G.PRiSM_compute_bourdet(x, y, L); if (r && r.length === x.length) return Array.prototype.slice.call(r); }
        catch (e) { /* local fallback */ }
    }
    L = L || 0;
    var n = x.length, d = new Array(n);
    for (var z = 0; z < n; z++) d[z] = NaN;
    if (n < 3) return d;
    for (var i = 1; i < n - 1; i++) {
        if (!(x[i] > 0) || !isFinite(y[i])) continue;
        var i1 = i - 1, i2 = i + 1;
        if (L > 0) {
            while (i1 > 0 && Math.log(x[i]) - Math.log(x[i1]) < L) i1--;
            while (i2 < n - 1 && Math.log(x[i2]) - Math.log(x[i]) < L) i2++;
        }
        if (!(x[i1] > 0) || !(x[i2] > 0)) continue;
        var dl1 = Math.log(x[i]) - Math.log(x[i1]);
        var dl2 = Math.log(x[i2]) - Math.log(x[i]);
        var dlT = Math.log(x[i2]) - Math.log(x[i1]);
        if (dl1 === 0 || dl2 === 0 || dlT === 0) continue;
        d[i] = (y[i] - y[i1]) / dl1 * (dl2 / dlT) + (y[i2] - y[i]) / dl2 * (dl1 / dlT);
    }
    return d;
}

// C1 fallback — well & fluid inputs from PRiSM_pvt.
function _localWell(ds) {
    var pv = G.PRiSM_pvt || {};
    var c = pv._computed || {};
    var fluid = pv.fluidType || 'oil';
    var B, mu;
    if (fluid === 'gas') { B = _pick(pv.B, pv.Bg, c.Bg, c.B); mu = _pick(pv.mu, pv.mu_g, c.mu_g, c.mu); }
    else if (fluid === 'water') { B = _pick(pv.B, pv.Bw, c.B); mu = _pick(pv.mu, pv.mu_w, c.mu); }
    else { B = _pick(pv.B, pv.Bo, c.Bo, c.B); mu = _pick(pv.mu, pv.mu_o, c.mu_o, c.mu); }
    var prov = pv.provenance || {};
    var piSrc = prov.p_res || prov.pi;
    var pi = _pick(pv.pi);
    if (pi == null && (piSrc === 'user' || piSrc === 'sample' || piSrc === 'deconvolution')) pi = _pick(pv.p_res);
    var qData = null;
    if (ds && Array.isArray(ds.q)) {
        for (var i = ds.q.length - 1; i >= 0; i--) { if (_pos(+ds.q[i])) { qData = +ds.q[i]; break; } }
    }
    var w = {
        fluid: fluid, q: _pick(qData, pv.q), B: B, mu: mu, ct: _pick(pv.ct, c.ct),
        h: _pick(pv.h), phi: _pick(pv.phi), rw: _pick(pv.rw), pi: pi,
        T_R: _pick(pv.T_res) != null ? _pick(pv.T_res) + 459.67 : null, sg: _pick(pv.SG_g),
        testType: pv.testType || 'auto', tp: _pick(pv.tp), tShut: _pick(pv.tShut), pwf0: _pick(pv.pwf0)
    };
    _completeWell(w);
    return w;
}

function _completeWell(w) {
    var req = ['q', 'B', 'mu', 'ct', 'h', 'phi', 'rw'];
    var missing = [];
    for (var i = 0; i < req.length; i++) if (!_pos(w[req[i]])) missing.push(req[i]);
    if (!Array.isArray(w.missing)) w.missing = missing;
    if (typeof w.complete !== 'boolean') w.complete = missing.length === 0;
    if (!Array.isArray(w.defaulted)) w.defaulted = [];
    return w;
}

function _getWell(ds) {
    if (typeof G.PRiSM_getWell === 'function') {
        try { var w = G.PRiSM_getWell(ds); if (w) return _completeWell(_copy(w)); } catch (e) { /* fallback */ }
    }
    return _localWell(ds);
}

// C2 fallback — Δp / time function / derivative for one flow period.
function _localAnalysisData(ds, well, opts) {
    opts = opts || {};
    well = well || {};
    var out = { ok: false, reason: '', warnings: [] };
    if (!ds || !Array.isArray(ds.t) || !Array.isArray(ds.p)) { out.reason = 'no pressure data'; return out; }
    var rows = [];
    for (var i = 0; i < ds.t.length; i++) {
        var ti = +ds.t[i], pi_ = +ds.p[i];
        var qi = (Array.isArray(ds.q) && ds.q[i] != null && ds.q[i] !== '') ? +ds.q[i] : NaN;
        if (isFinite(ti) && isFinite(pi_)) rows.push({ t: ti, p: pi_, q: qi });
    }
    rows.sort(function (a, b) { return a.t - b.t; });
    if (rows.length < 3) { out.reason = 'fewer than 3 pressure points'; return out; }
    var T = rows.map(function (r) { return r.t; });
    var P = rows.map(function (r) { return r.p; });
    var Q = rows.map(function (r) { return r.q; });
    var hasQ = Q.some(function (v) { return isFinite(v) && v !== 0; });

    var steps = _normSteps(opts.rateHistory);
    if (!steps.length && hasQ) steps = _rateStepsFromSamples(T, Q);
    var testType = opts.testType || well.testType || 'auto';
    var shutType = (testType === 'buildup' || testType === 'falloff');
    if (!steps.length || (steps.length === 1 && shutType && _pos(well.tp) && !(steps[0].q === 0))) {
        var qw = _pos(well.q) ? well.q : 1;
        if (shutType && _pos(well.tp)) {
            var tsh = _num(well.tShut) ? well.tShut : Math.min(0, T[0]);
            steps = [{ t: tsh - well.tp, q: qw }, { t: tsh, q: 0 }];
        } else {
            steps = [{ t: Math.min(0, T[0]), q: qw }];
        }
    }
    var n = (opts.period != null && steps[+opts.period]) ? +opts.period : steps.length - 1;
    while (n > 0 && !(T[T.length - 1] > steps[n].t)) n--;
    var tStart = steps[n].t;
    var tEnd = (n + 1 < steps.length) ? steps[n + 1].t : Infinity;
    var qN = steps[n].q, qPrev = n > 0 ? steps[n - 1].q : 0;
    var dq = qN - qPrev;
    var isShut = n > 0 && _sameRate(qN, 0);

    var sigma, tt = testType;
    if (tt === 'drawdown' || tt === 'falloff') sigma = 1;
    else if (tt === 'buildup' || tt === 'injection') sigma = -1;
    else if (hasQ || n > 0) { sigma = dq >= 0 ? 1 : -1; tt = isShut ? 'buildup' : 'drawdown'; }
    else {
        var trend = (P[P.length - 1] - P[0]) >= 0 ? 1 : -1;   // CLAUDE.md sign rule
        sigma = -trend;
        tt = trend > 0 ? 'buildup' : 'drawdown';
    }

    var pRef, src;
    if (n === 0 && !shutType) {
        var piIn = _pick(opts.pi, well.pi);
        if (piIn != null) { pRef = piIn; src = 'pi'; }
        else {
            var row0 = null;
            for (var r0 = 0; r0 < rows.length && rows[r0].t <= tStart; r0++) row0 = rows[r0];
            if (row0) { pRef = row0.p; src = 't0-row'; }
            else {
                var ex = [];
                for (var r1 = 0; r1 < rows.length && ex.length < 3; r1++) if (rows[r1].t > tStart) ex.push(rows[r1]);
                if (ex.length >= 2) {
                    var mt = 0, mp = 0;
                    ex.forEach(function (r) { mt += r.t; mp += r.p; });
                    mt /= ex.length; mp /= ex.length;
                    var sxy = 0, sxx = 0;
                    ex.forEach(function (r) { sxy += (r.t - mt) * (r.p - mp); sxx += (r.t - mt) * (r.t - mt); });
                    var slope = sxx > 0 ? sxy / sxx : 0;
                    pRef = mp + slope * (tStart - mt); src = 'extrapolated';
                    out.warnings.push('Reference pressure extrapolated to t = 0 (no initial pressure entered) — skin is biased; enter pi.');
                } else {
                    pRef = rows[0].p; src = 'first-sample';
                    out.warnings.push('Reference pressure taken from the first sample (no initial pressure entered) — skin is biased; enter pi.');
                }
            }
        }
    } else {
        var pw = (isShut || shutType) ? _pick(opts.pwf0, well.pwf0) : null;
        if (pw != null) pRef = pw; else pRef = _interpAt(T, P, tStart);
        src = 'pwf0';
    }

    var t = [], tAbs = [], p = [], dp = [];
    var tmin = _num(opts.tmin) ? opts.tmin : -Infinity, tmax = _num(opts.tmax) ? opts.tmax : Infinity;
    for (var k = 0; k < rows.length; k++) {
        var dt = rows[k].t - tStart;
        if (!(dt > 0) || rows[k].t > tEnd || dt < tmin || dt > tmax) continue;
        t.push(dt); tAbs.push(rows[k].t); p.push(rows[k].p);
        dp.push(sigma * (pRef - rows[k].p));
    }
    if (t.length < 3) { out.reason = 'fewer than 3 points in the analysed period'; return out; }
    var timeFn = opts.timeFn || 'auto';
    if (timeFn === 'auto') timeFn = (n === 0) ? 'dt' : 'superposition';
    var x;
    if (timeFn === 'agarwal') x = PRiSM_agarwalTime(t, steps, n);
    else if (timeFn === 'superposition') x = t.map(function (v) { return Math.exp(_supTime(v, steps, n)); });
    else { x = t.slice(); timeFn = 'dt'; }
    var st = _state() || {};
    var L = _num(opts.L) ? opts.L : (_num(st.bourdetL) ? st.bourdetL : 0.1);
    var deriv = _bourdet(x, dp, L);
    if (steps.length > 20) out.warnings.push('Continuously varying rate (> 20 steps) — rate-transient analysis or deconvolution applies.');

    return {
        ok: true, reason: '', n: t.length,
        t: t, tAbs: tAbs, p: p, dp: dp, x: x, deriv: deriv, L: L, timeFn: timeFn,
        sign: -sigma, pRef: pRef, pRefSource: src, testType: tt,
        tStart: tStart, tShut: isShut ? tStart : null, tp: _producingTime(steps, n),
        qRef: Math.abs(n === 0 ? qN : dq) || null,
        rateHistory: steps.map(function (s) { return { t: s.t, q: s.q }; }),
        periods: steps.map(function (s, j) {
            var t1 = (j + 1 < steps.length) ? steps[j + 1].t : T[T.length - 1];
            return { t0: s.t, t1: t1, start: s.t, end: t1, q: s.q };
        }),
        fluid: well.fluid || 'oil', warnings: out.warnings, period: n
    };
}

function _getAnalysisData(ds, well, opts) {
    if (typeof G.PRiSM_getAnalysisData === 'function') {
        try {
            var a = G.PRiSM_getAnalysisData(ds, opts || {});
            if (a) return a;
        } catch (e) { /* fallback */ }
    }
    return _localAnalysisData(ds, well, opts);
}

// Model evaluation helpers — always array in, array out; NaN on failure.
function _evalArr(fn, td, params) {
    if (!td.length) return [];
    var r;
    try { r = fn(td, params); } catch (e) { r = null; }
    if (Array.isArray(r) && r.length === td.length) return r;
    if (r && typeof r.length === 'number' && r.length === td.length) return Array.prototype.slice.call(r);
    var out = new Array(td.length);
    for (var i = 0; i < td.length; i++) {
        try { var v = fn(td[i], params); out[i] = Array.isArray(v) ? v[0] : +v; }
        catch (e2) { out[i] = NaN; }
    }
    return out;
}

function _evalPdPrime(entry, td, params) {
    if (typeof entry.pdPrime === 'function') {
        var r = _evalArr(entry.pdPrime, td, params);
        if (_allFinite(r)) return r;
    }
    var h = 0.01, up = td.map(function (v) { return v * Math.exp(h); }), dn = td.map(function (v) { return v * Math.exp(-h); });
    var a = _evalArr(entry.pd, up, params), b = _evalArr(entry.pd, dn, params);
    return a.map(function (v, i) { return (v - b[i]) / (2 * h); });
}

var _LOG_SHAPE_KEYS = { lambda: 1, Cd: 1, CD: 1, FcD: 1, reD: 1, xfD: 1, L_to_h: 1, R: 1, M: 1, D: 1 };

function _shapeScale(sp) {
    if (sp && sp.scale) return sp.scale;
    if (sp && _LOG_SHAPE_KEYS[sp.key]) return (sp.min != null && sp.min < 0) ? 'lin' : 'log';
    if (sp && _pos(sp.min) && _num(sp.max) && sp.max / sp.min >= 1e3) return 'log';
    return 'lin';
}

// C3 fallback — dimensional wrapper around a dimensionless registry model.
function _localPhysicalModel(modelKey, well, adata, opts) {
    opts = opts || {};
    var entry = _registry()[modelKey];
    if (!entry || typeof entry.pd !== 'function') return { ok: false, reason: 'unknown model "' + modelKey + '"' };
    if (entry.kind === 'rate') return { ok: false, reason: 'rate model — use PRiSM_fitRate' };
    if (!adata || !adata.ok) return { ok: false, reason: 'no analysis data' };
    var w = well || {};
    var specArr = Array.isArray(entry.paramSpec) ? entry.paramSpec : [];
    var specBy = {};
    specArr.forEach(function (s) { if (s && s.key) specBy[s.key] = s; });
    var base = _copy(entry.defaults);
    specArr.forEach(function (s) { if (s && s.key && !(s.key in base) && s['default'] !== undefined) base[s.key] = s['default']; });
    var p0 = opts.params0 || {};
    for (var pk in p0) if (Object.prototype.hasOwnProperty.call(p0, pk) && (pk in base)) base[pk] = p0[pk];
    var numKeys = Object.keys(base).filter(function (k) { return k.indexOf('__') !== 0 && _num(base[k]); });
    var hasCd = numKeys.indexOf('Cd') >= 0, hasS = numKeys.indexOf('S') >= 0;
    var refLength = entry.refLength || 'rw';
    var refKey = (refLength === 'xf' || refLength === 'Lh') ? refLength : null;
    var shapeKeys = numKeys.filter(function (k) { return k !== 'Cd' && k !== 'S' && k !== refKey; });
    var complete = ['q', 'B', 'mu', 'ct', 'h', 'phi', 'rw'].every(function (k) { return _pos(w[k]); });
    var mode = opts.mode || (complete ? 'physical' : 'scale');
    if (mode === 'physical' && !complete) mode = 'scale';

    var steps = _normSteps(adata.rateHistory);
    var nPer = 0;
    if (steps.length) {
        var best = Infinity;
        for (var s = 0; s < steps.length; s++) {
            var dd = Math.abs(steps[s].t - (_num(adata.tStart) ? adata.tStart : steps[0].t));
            if (dd < best) { best = dd; nPer = s; }
        }
    }
    var single = !steps.length || nPer === 0;
    var qRef = _pos(adata.qRef) ? adata.qRef : (_pos(w.q) ? w.q : null);
    if (!single) {
        var dqn = steps[nPer].q - steps[nPer - 1].q;
        if (!_pos(qRef)) qRef = Math.abs(dqn) || 1;
    }
    if (mode === 'scale' && !_pos(qRef)) qRef = 1;
    var sgnPer = single ? 1 : ((steps[nPer].q - steps[nPer - 1].q) >= 0 ? 1 : -1);
    var tData = adata.t || [];
    var tEndData = tData.length ? tData[tData.length - 1] : 1;
    var Cd0 = _pos(base.Cd) ? base.Cd : 100;
    var sigmaData = _dataSign(adata);

    var keys = [], spec = {};
    if (mode === 'physical') {
        keys.push('k'); spec.k = { min: 1e-5, max: 1e6, unit: 'md', scale: 'log', 'default': 10 };
        if (hasCd) { keys.push('C'); spec.C = { min: 1e-8, max: 10, unit: 'bbl/psi', scale: 'log', 'default': 1e-2 }; }
        if (hasS) { keys.push('S'); spec.S = { min: _pick(specBy.S && specBy.S.min, -7), max: _pick(specBy.S && specBy.S.max, 50), unit: '-', scale: 'lin', 'default': 0 }; }
        if (refKey) { keys.push(refKey); spec[refKey] = { min: 1, max: 1e5, unit: 'ft', scale: 'log', 'default': 100 }; }
    } else {
        keys.push('A'); spec.A = { min: 1e-8, max: 1e9, unit: 'psi', scale: 'log', 'default': 100 };
        keys.push('T'); spec.T = { min: 1e-10, max: 1e14, unit: '1/hr', scale: 'log', 'default': 100 };
        if (hasCd && hasS) { keys.push('CDe2S'); spec.CDe2S = { min: 1e-6, max: 1e80, unit: '-', scale: 'log', 'default': 1e3 }; }
        else if (hasS) { keys.push('S'); spec.S = { min: -7, max: 50, unit: '-', scale: 'lin', 'default': 0 }; }
    }
    shapeKeys.forEach(function (k) {
        var sp = specBy[k] || { key: k };
        keys.push(k);
        spec[k] = { min: _pick(sp.min, -Infinity), max: _pick(sp.max, Infinity), unit: sp.unit || '-', scale: _shapeScale(sp), 'default': base[k] };
        if (spec[k].scale === 'log' && !(spec[k].min > 0)) spec[k].min = Math.max(1e-30, _pos(base[k]) ? base[k] * 1e-6 : 1e-30);
    });
    if (opts.floatPi) {
        keys.push('pi');
        var pmax = -Infinity, pmin = Infinity;
        (adata.p || []).forEach(function (v) { if (v > pmax) pmax = v; if (v < pmin) pmin = v; });
        var pr = _num(adata.pRef) ? adata.pRef : pmax;
        spec.pi = (sigmaData > 0)
            ? { min: pmax + 0.01, max: pr + 10000, unit: 'psia', scale: 'lin', 'default': pr }
            : { min: pr - 10000, max: pmin - 0.01, unit: 'psia', scale: 'lin', 'default': pr };
    }

    function toModelParams(phys) {
        var params = _copy(base);
        shapeKeys.forEach(function (k) { if (_num(phys[k])) params[k] = phys[k]; });
        var A, Bt;
        if (mode === 'physical') {
            var Lref = refKey ? phys[refKey] : w.rw;
            A = 141.2 * qRef * w.B * w.mu / (phys.k * w.h);
            Bt = 0.0002637 * phys.k / (w.phi * w.mu * w.ct * Lref * Lref);
            if (hasCd) params.Cd = 0.8936 * phys.C / (w.phi * w.ct * w.h * Lref * Lref);
            if (hasS) params.S = phys.S;
            params.__h_rw = w.h / w.rw;
        } else {
            A = phys.A;
            Bt = phys.T * (hasCd ? Cd0 : 1);
            if (hasCd) params.Cd = Cd0;
            if (hasCd && hasS) params.S = 0.5 * Math.log(phys.CDe2S / Cd0);
            else if (hasS) params.S = phys.S;
            if (_pos(w.h) && _pos(w.rw)) params.__h_rw = w.h / w.rw;
        }
        return { params: params, A: A, B: Bt };
    }

    function dp(t, phys) {
        var mp = toModelParams(phys);
        if (single) {
            var pd = _evalArr(entry.pd, t.map(function (v) { return mp.B * v; }), mp.params);
            return pd.map(function (v) { return mp.A * v; });
        }
        var unit = mp.A / qRef, tS = steps[nPer].t;
        var tds = [], map = [];
        for (var i = 0; i <= nPer; i++) {
            var dqi = steps[i].q - (i > 0 ? steps[i - 1].q : 0);
            if (dqi === 0) continue;
            if (i < nPer) { tds.push(mp.B * (tS - steps[i].t)); map.push([i, -1, dqi]); }
            for (var j = 0; j < t.length; j++) { tds.push(mp.B * (tS + t[j] - steps[i].t)); map.push([i, j, dqi]); }
        }
        var pdv = _evalArr(entry.pd, tds, mp.params);
        var D = new Array(t.length), D0 = 0;
        for (var z = 0; z < t.length; z++) D[z] = 0;
        for (var m = 0; m < map.length; m++) {
            var c = map[m][2] * unit * pdv[m];
            if (map[m][1] < 0) D0 += c; else D[map[m][1]] += c;
        }
        return D.map(function (v) { return sgnPer * (v - D0); });
    }

    function timeFnValues(t) {
        var tf = adata.timeFn || 'dt';
        if (single || tf === 'dt') return t.slice();
        if (tf === 'agarwal') return PRiSM_agarwalTime(t, steps, nPer);
        return t.map(function (v) { return Math.exp(_supTime(v, steps, nPer)); });
    }

    function deriv(t, phys) {
        var mp = toModelParams(phys);
        if (single) {
            var pp = _evalPdPrime(entry, t.map(function (v) { return mp.B * v; }), mp.params);
            return pp.map(function (v) { return mp.A * v; });
        }
        var tmin = Infinity, tmax = -Infinity;
        t.forEach(function (v) { if (v < tmin) tmin = v; if (v > tmax) tmax = v; });
        var l0 = Math.log10(tmin / 2), l1 = Math.log10(tmax * 2);
        var ng = Math.max(20, Math.ceil((l1 - l0) * 24));
        var grid = [];
        for (var g = 0; g <= ng; g++) grid.push(Math.pow(10, l0 + (l1 - l0) * g / ng));
        var dpg = dp(grid, phys), xg = timeFnValues(grid);
        var lx = xg.map(function (v) { return Math.log(v); });
        var dg = new Array(grid.length);
        for (var i = 0; i < grid.length; i++) {
            var a = Math.max(0, i - 1), b = Math.min(grid.length - 1, i + 1);
            dg[i] = (dpg[b] - dpg[a]) / (lx[b] - lx[a]);
        }
        var lg = grid.map(function (v) { return Math.log(v); });
        return t.map(function (v) { return _interpAt(lg, dg, Math.log(v)); });
    }

    function p(t, phys) {
        var d = dp(t, phys);
        var pr = (opts.floatPi && _num(phys.pi)) ? phys.pi : adata.pRef;
        return d.map(function (v) { return pr - sigmaData * v; });
    }

    function seed() {
        var t = adata.t || [], d = adata.deriv || [], y = adata.dp || [];
        var late = [];
        for (var i = Math.floor(t.length * 0.6); i < t.length; i++) if (_pos(d[i])) late.push(d[i]);
        if (!late.length) for (var i2 = 0; i2 < t.length; i2++) if (_pos(d[i2])) late.push(d[i2]);
        var dLate = late.length ? _median(late) : NaN;
        var i0 = -1, ir = -1;
        for (var a = 0; a < t.length; a++) if (_pos(y[a])) { i0 = a; break; }
        for (var b = t.length - 1; b >= 0; b--) if (_pos(y[b]) && _pos(d[b])) { ir = b; break; }
        var tr = ir >= 0 ? t[ir] : tEndData;
        if (!single && ir >= 0) {
            var te = PRiSM_agarwalTime(tr, steps, nPer);
            if (_pos(te)) tr = te;
        }
        var ph = {};
        shapeKeys.forEach(function (k) { ph[k] = base[k]; });
        if (mode === 'physical') {
            var kh = _pos(dLate) ? 70.6 * qRef * w.B * w.mu / dLate : 100 * w.h;
            ph.k = _clampSpec(kh / w.h, spec.k);
            if (hasCd) {
                var Cs = (i0 >= 0) ? qRef * w.B * t[i0] / (24 * y[i0]) : 1e-2;
                ph.C = _clampSpec(_pos(Cs) ? Cs : 1e-2, spec.C);
            }
            if (refKey) ph[refKey] = _clampSpec(_pos(p0[refKey]) ? p0[refKey] : 100, spec[refKey]);
            if (hasS) {
                var Lr = refKey ? ph[refKey] : w.rw;
                var S0 = (ir >= 0 && _pos(dLate))
                    ? 0.5 * (y[ir] / d[ir] - Math.log(0.0002637 * ph.k * tr / (w.phi * w.mu * w.ct * Lr * Lr)) - 0.80907)
                    : 0;
                ph.S = _clampSpec(isFinite(S0) ? Math.max(-5, Math.min(20, S0)) : 0, spec.S);
            }
        } else {
            var A0 = _pos(dLate) ? 2 * dLate : (ir >= 0 ? y[ir] / 10 : 100);
            ph.A = _clampSpec(A0, spec.A);
            var T0 = (i0 >= 0) ? y[i0] / (A0 * t[i0]) : 100;
            ph.T = _clampSpec(_pos(T0) ? T0 : 100, spec.T);
            if (hasCd && hasS) {
                var lnC = (ir >= 0) ? 2 * y[ir] / A0 - Math.log(ph.T * tr) - 0.80907 : Math.log(1e3);
                ph.CDe2S = _clampSpec(Math.exp(Math.max(-5, Math.min(120, lnC))), spec.CDe2S);
            } else if (hasS) ph.S = 0;
        }
        if (opts.floatPi) ph.pi = _clampSpec(_num(w.pi) ? w.pi : adata.pRef, spec.pi);
        return ph;
    }

    function derived(phys) {
        var mp = toModelParams(phys);
        var out = { A: mp.A, B: mp.B };
        var piOut = _num(phys.pi) ? phys.pi : ((adata.pRefSource === 'pi') ? adata.pRef : (_num(w.pi) ? w.pi : null));
        if (mode === 'physical') {
            var Lref = refKey ? phys[refKey] : w.rw;
            out.k = phys.k; out.kh = phys.k * w.h;
            if (hasCd) { out.C = phys.C; out.Cd = mp.params.Cd; }
            if (hasS) out.S = phys.S;
            if (refKey) out[refKey] = phys[refKey];
            out.refLength_ft = Lref;
            out.rinv = Math.sqrt(phys.k * tEndData / (948 * w.phi * w.mu * w.ct));
        } else {
            out.T = phys.T;
            if (hasCd && hasS) { out.CDe2S = phys.CDe2S; out.Cd = Cd0; }
            if (_pos(w.B) && _pos(w.mu) && _pos(qRef) && qRef !== 1) {
                out.kh = 141.2 * qRef * w.B * w.mu / mp.A;
                if (_pos(w.h)) out.k = out.kh / w.h;
                if (hasCd) out.C = 0.0002951 * out.kh / (w.mu * phys.T);
            }
            out.S = null;
        }
        out.pi = piOut;
        out.distances_ft = {};
        return out;
    }

    return {
        ok: true, mode: mode, kind: 'pressure', keys: keys, spec: spec,
        toModelParams: toModelParams, dp: dp, deriv: deriv, p: p, seed: seed, derived: derived,
        _local: true
    };
}

function _clampSpec(v, sp) {
    if (!sp || !isFinite(v)) return v;
    if (_num(sp.min) && v < sp.min) v = sp.min;
    if (_num(sp.max) && v > sp.max) v = sp.max;
    return v;
}

// +1 when Δp = pRef − p (drawdown / falloff), −1 when Δp = p − pRef.
// Contract C2: p = pRef + sign·Δp, so this is −adata.sign.
function _dataSign(adata) {
    if (!adata) return 1;
    if (adata.sign === 1 || adata.sign === -1) return -adata.sign;
    if (Array.isArray(adata.p) && Array.isArray(adata.dp) && _num(adata.pRef)) {
        for (var i = 0; i < adata.p.length; i++) {
            var a = adata.pRef - adata.p[i];
            if (Math.abs(a) > 1e-9 && isFinite(adata.dp[i])) return (Math.abs(adata.dp[i] - a) <= Math.abs(adata.dp[i] + a)) ? 1 : -1;
        }
    }
    var tt = adata.testType;
    return (tt === 'buildup' || tt === 'injection') ? -1 : 1;
}

function _getPM(modelKey, well, adata, opts) {
    if (typeof G.PRiSM_physicalModel === 'function') {
        try {
            var pm = G.PRiSM_physicalModel(modelKey, well, adata, opts);
            if (pm && pm.ok && Array.isArray(pm.keys) && typeof pm.dp === 'function') return pm;
        } catch (e) { /* fallback */ }
    }
    return _localPhysicalModel(modelKey, well, adata, opts);
}

function _datasetHash(ds) {
    if (typeof G.PRiSM_datasetHash === 'function') { try { return G.PRiSM_datasetHash(ds); } catch (e) { /* none */ } }
    return null;
}


// =============================================================================
// SECTION 8 — PRiSM_fitPhysical — field-unit pressure regression
// =============================================================================
// Objective 'dp+deriv' (default): residuals
//   [ln Δp_d − ln Δp_m] ∪ [ln Δp'_d − ln Δp'_m], each weighted 0.5,
// over points with positive values inside opts.window. Objective 'dp':
// linear Δp residuals in psi. When pi floats, the data Δp is re-referenced
// every iteration: Δp_d(pi) = Δp + σ·(pi − pRef).
//
// Model derivative: derivMode 'consistent' (default) applies the SAME Bourdet
// operator (adata.x, adata.L) to the model Δp at the data times, so the data
// and model derivatives carry identical differencing error; 'analytic' uses
// the physical model's own derivative (PM.deriv).
// =============================================================================

var _PHYS_ALIASES = { Cd: 'C', CD: 'C', xfD: 'xf' };

// Approximate cost (ms) of one 70-point pressure evaluation, for the slow
// Laplace-space models (the rest are ≈ 3 ms). Used only for fit budgets;
// a registry entry may override with evalCostMs.
var _EVAL_COST_MS = {
    multiLatMLXF: 900, linearCompMultiLat: 900, mlNoXFHoriz: 750, mlHorizontalXF: 360, horizontal: 340,
    linearCompMultiLatInterference: 150, generalMLNoXF: 140, finiteFrac: 110, finiteFracSkin: 110,
    mlHorizInterference: 65, closedRectangle: 60, closedChannel3: 35, parallelChannel: 35,
    genHetRadialLinear: 20, genHetRadial: 17, radialComposite: 10
};

/**
 * @param {string} modelKey
 * @param {object=} adata  C2 analysis data (default: PRiSM_getAnalysisData())
 * @param {object=} well   C1 well (default: PRiSM_getWell())
 * @param {object=} opts   { objective:'dp+deriv'|'dp', window:{tmin,tmax},
 *                           floatPi, freeze:{key:true} (physical or registry
 *                           names), start:{phys}, params0:{dimensionless},
 *                           maxIter, tolerance, derivMode, mode:'physical'|'scale',
 *                           singleStart, bootstrap:n, seed }
 * @return LastFit-shaped object (contract C4) with ok:true, or {ok:false, reason}.
 */
function PRiSM_fitPhysical(modelKey, adata, well, opts) {
    opts = opts || {};
    var t0 = Date.now();
    var fail = function (reason) {
        return { ok: false, reason: reason, modelKey: modelKey, model: modelKey, kind: 'pressure',
                 source: 'regression', converged: false, warnings: [reason] };
    };
    var entry = _registry()[modelKey];
    if (!entry) return fail('Unknown model "' + modelKey + '".');
    if (entry.kind === 'rate') return fail('"' + modelKey + '" is a rate model — use the decline fit.');
    var ds = opts.dataset || G.PRiSM_dataset;
    well = well || _getWell(ds);
    if (!adata) {
        var st0 = _state() || {};
        adata = _getAnalysisData(ds, well, {
            period: st0.activePeriod, timeFn: st0.timeFn || 'auto', L: st0.bourdetL
        });
    }
    if (!adata || !adata.ok) return fail('No analysable pressure data' + (adata && adata.reason ? ': ' + adata.reason : '.'));

    var shutIn = adata.testType === 'buildup' || adata.testType === 'falloff' || adata.pRefSource === 'pwf0';
    var floatPi = (opts.floatPi != null) ? !!opts.floatPi
                : (!shutIn && ['pi', 'pwf0'].indexOf(adata.pRefSource) < 0);
    if (shutIn) floatPi = false;

    var pm = _getPM(modelKey, well, adata, { floatPi: floatPi, mode: opts.mode, params0: opts.params0 });
    if (!pm || !pm.ok) return fail('Physical model unavailable: ' + (pm && pm.reason || 'unknown reason'));
    var keys = pm.keys.filter(function (k) { return String(k).indexOf('__') !== 0; });
    if (keys.indexOf('pi') < 0) floatPi = false;

    var objective = (opts.objective === 'dp') ? 'dp' : 'dp+deriv';
    var derivMode = opts.derivMode || 'consistent';
    var win = opts.window || {};
    var tmin = _num(win.tmin) ? win.tmin : -Infinity, tmax = _num(win.tmax) ? win.tmax : Infinity;
    var T = adata.t, DP = adata.dp, DD = adata.deriv || [];
    var X = (Array.isArray(adata.x) && adata.x.length === T.length) ? adata.x : T;
    var Lb = _num(adata.L) ? adata.L : 0.1;
    var sigma = _dataSign(adata);
    var pRef = adata.pRef;

    var idxDp = [], idxD = [];
    for (var i = 0; i < T.length; i++) {
        if (!(T[i] >= tmin && T[i] <= tmax)) continue;
        if (isFinite(DP[i]) && ((floatPi && pm._local) || DP[i] > 0)) idxDp.push(i);
        if (objective === 'dp+deriv' && _pos(DD[i])) idxD.push(i);
    }
    if (idxDp.length + idxD.length < keys.length + 2) return fail('Too few points in the fit window.');

    var tAll = T.slice();
    var nRes = idxDp.length + idxD.length;
    var PEN = 30;

    function modelDpAll(phys) { return pm.dp(tAll, phys); }
    function modelDeriv(phys, dpAll) {
        if (derivMode === 'consistent') return _bourdet(X, dpAll, Lb);
        var tD = idxD.map(function (i) { return T[i]; });
        var dv = pm.deriv(tD, phys), full = new Array(T.length);
        for (var z = 0; z < idxD.length; z++) full[idxD[z]] = dv[z];
        return full;
    }
    // Floating pi: the local wrapper re-references the DATA (Δp_d + σ·(pi − pRef));
    // the core-layer wrapper (C3) already returns the model Δp relative to adata.pRef.
    var shiftData = floatPi && !!pm._local;
    function shiftOf(phys) { return (shiftData && _num(phys.pi)) ? sigma * (phys.pi - pRef) : 0; }

    // Residual-mode model for PRiSM_lm: returns −r so that 0 − model = r.
    var resFn = function (_t, phys) {
        var dpm = modelDpAll(phys);
        var sh = shiftOf(phys);
        var out = new Array(nRes), c = 0;
        for (var a = 0; a < idxDp.length; a++) {
            var j = idxDp[a], yd = DP[j] + sh, ym = dpm[j];
            if (objective === 'dp') out[c++] = -((yd) - ym);
            else out[c++] = (yd > 0 && ym > 0) ? -(Math.log(yd) - Math.log(ym)) : PEN;
        }
        if (idxD.length) {
            var dm = modelDeriv(phys, dpm);
            for (var b = 0; b < idxD.length; b++) {
                var jd = idxD[b], dmv = dm[jd];
                out[c++] = (dmv > 0) ? -(Math.log(DD[jd]) - Math.log(dmv)) : PEN;
            }
        }
        return out;
    };
    var data = { t: new Array(nRes), p: new Array(nRes), weights: new Array(nRes) };
    for (var r = 0; r < nRes; r++) { data.t[r] = r; data.p[r] = 0; data.weights[r] = (objective === 'dp') ? 1 : 0.5; }

    // Freeze: user (physical or registry names), registry defaultFrozen.
    var freeze = {};
    var addFreeze = function (k) {
        var kk = (keys.indexOf(k) >= 0) ? k : _PHYS_ALIASES[k];
        if (kk && keys.indexOf(kk) >= 0) freeze[kk] = true;
    };
    (Array.isArray(entry.defaultFrozen) ? entry.defaultFrozen : []).forEach(addFreeze);
    var uf = opts.freeze || {};
    if (Array.isArray(uf)) uf.forEach(addFreeze);
    else for (var fk in uf) if (uf[fk]) addFreeze(fk);
    if (opts.unfreeze) (Array.isArray(opts.unfreeze) ? opts.unfreeze : Object.keys(opts.unfreeze)).forEach(function (k) { delete freeze[k]; });

    var bounds = {}, logKeys = [];
    keys.forEach(function (k) {
        var sp = (pm.spec && pm.spec[k]) || {};
        bounds[k] = [_num(sp.min) ? sp.min : -Infinity, _num(sp.max) ? sp.max : Infinity];
        if (sp.scale === 'log') logKeys.push(k);
    });

    // Starts: PM seed (+ user shape params / explicit start), then S0 ± 2.
    var seed0 = {};
    try { seed0 = pm.seed() || {}; } catch (e) { seed0 = {}; }
    var p0 = opts.params0 || {};
    keys.forEach(function (k) {
        if (k === 'k' || k === 'C' || k === 'S' || k === 'pi' || k === 'A' || k === 'T' || k === 'CDe2S') return;
        if (_num(p0[k])) seed0[k] = p0[k];
    });
    if (opts.start) for (var sk in opts.start) if (_num(opts.start[sk]) && keys.indexOf(sk) >= 0) seed0[sk] = opts.start[sk];
    keys.forEach(function (k) {
        if (!_num(seed0[k])) {
            var sp = (pm.spec && pm.spec[k]) || {};
            seed0[k] = _num(sp['default']) ? sp['default'] : 1;
        }
        seed0[k] = _clampSpec(seed0[k], { min: bounds[k][0], max: bounds[k][1] });
        if (logKeys.indexOf(k) >= 0 && !(seed0[k] > 0)) seed0[k] = bounds[k][0] > 0 ? bounds[k][0] : 1e-6;
    });
    var starts = [seed0];
    // Race fits (auto-match) use one start and a wall-clock budget so a slow
    // model (finite-conductivity fracture: ~0.1 s per evaluation) cannot block
    // the UI for minutes. opts.timeBudgetMs applies to any caller.
    var singleStart = !!opts.singleStart;
    if (!singleStart && keys.indexOf('S') >= 0 && !freeze.S) {
        [2, -2].forEach(function (dS) {
            var s2 = _copy(seed0);
            s2.S = _clampSpec(seed0.S + dS, { min: bounds.S[0], max: bounds.S[1] });
            // Skip a start that the bounds collapse onto an existing one.
            for (var q0 = 0; q0 < starts.length; q0++) if (Math.abs(starts[q0].S - s2.S) < 1e-9) return;
            starts.push(s2);
        });
    }
    // Budget = wall clock (browsers) and an estimated evaluation cost (the same
    // cap wherever Date.now() does not advance, e.g. a virtual test clock).
    var budgetMs = _num(opts.timeBudgetMs) ? opts.timeBudgetMs : (opts.race ? 4000 : null);
    var lmOpts = {
        maxIter: _num(opts.maxIter) ? opts.maxIter : 60,
        tolerance: _num(opts.tolerance) ? opts.tolerance : 1e-6,
        logKeys: logKeys
    };
    var nEval = 0;
    if (_pos(budgetMs)) {
        lmOpts.deadline = t0 + budgetMs;
        var nSteps = (adata.rateHistory && adata.rateHistory.length) || 1;
        var costMs = (_pos(entry.evalCostMs) ? entry.evalCostMs : (_EVAL_COST_MS[modelKey] || 3)) *
                     Math.max(1, T.length / 70) * (pm.simple ? 1 : Math.max(1, nSteps));
        lmOpts.shouldStop = function () { return nEval * costMs > budgetMs; };
        var resFn0 = resFn;
        resFn = function (a, b) { nEval++; return resFn0(a, b); };
    }
    var best = null, nStartsOk = 0;
    for (var si = 0; si < starts.length; si++) {
        if (si > 0 && ((lmOpts.deadline && Date.now() > lmOpts.deadline) || (lmOpts.shouldStop && lmOpts.shouldStop()))) break;
        var res;
        try { res = PRiSM_lm(resFn, data, starts[si], bounds, freeze, lmOpts); }
        catch (e) { continue; }
        if (!res || !isFinite(res.ssr)) continue;
        nStartsOk++;
        if (_betterRun(res, best)) best = res;
    }
    if (!best) return fail('Regression failed at every start.');

    var phys = _copy(best.params);
    var dpm = modelDpAll(phys);
    var sh = shiftOf(phys);
    var ssr = 0, mean = 0, cnt = 0;
    idxDp.forEach(function (j) { mean += DP[j] + sh; cnt++; });
    mean /= Math.max(cnt, 1);
    var ssTot = 0;
    idxDp.forEach(function (j) { var e = DP[j] + sh - dpm[j], dv = DP[j] + sh - mean; ssr += e * e; ssTot += dv * dv; });
    var r2 = ssTot > 0 ? 1 - ssr / ssTot : NaN;
    var rmse = Math.sqrt(ssr / Math.max(cnt, 1));

    var derived = {};
    try { derived = pm.derived(phys) || {}; } catch (e) { derived = {}; }
    var physOut = _copy(derived);
    keys.forEach(function (k) { if (_num(phys[k])) physOut[k] = phys[k]; });
    if (floatPi && _num(phys.pi)) physOut.pi = phys.pi;
    var mp = pm.toModelParams(phys);
    var params = {};
    for (var pk in mp.params) if (Object.prototype.hasOwnProperty.call(mp.params, pk) && pk.indexOf('__') !== 0) params[pk] = mp.params[pk];

    var ci95 = _copy(best.ci95), stderr = _copy(best.stderr), identifiable = _copy(best.identifiable);
    keys.forEach(function (k) { if (freeze[k]) { identifiable[k] = false; } });
    if (_pos(physOut.C) && _pos(physOut.Cd) && ci95.C && isFinite(ci95.C[0])) {
        var f = physOut.Cd / physOut.C;
        ci95.Cd = [ci95.C[0] * f, ci95.C[1] * f]; stderr.Cd = stderr.C * f; identifiable.Cd = identifiable.C;
    }
    if (_pos(physOut.kh) && _pos(physOut.k) && ci95.k && isFinite(ci95.k[0])) {
        var fh = physOut.kh / physOut.k;
        ci95.kh = [ci95.k[0] * fh, ci95.k[1] * fh]; stderr.kh = stderr.k * fh; identifiable.kh = identifiable.k;
    }

    var warnings = (adata.warnings || []).slice();
    if (!best.converged) warnings.push('Regression did not converge (' + best.stopReason + ', ' + best.iterations + ' iterations).');
    keys.forEach(function (k) {
        if (freeze[k]) return;
        if (best.atBound && best.atBound[k]) warnings.push('Parameter ' + k + ' is at its bound (' + _fmtNum(phys[k]) + ').');
        else if (identifiable[k] === false) warnings.push('Parameter ' + k + ' is poorly determined by the data (wide interval or strongly correlated).');
    });
    if (pm.mode === 'scale') {
        warnings.push('Well inputs incomplete (' + ((well && well.missing) || []).join(', ') + ') — fitted in scale mode; skin is not identifiable without φ·ct·rw².');
        identifiable.S = false;
    }
    // Inputs still at their store defaults (never entered or accepted): k and S
    // are only as good as those guesses, so S is not reported as identifiable.
    var inputsDefaulted = [];
    if (pm.mode !== 'scale' && well && Array.isArray(well.defaulted)) {
        inputsDefaulted = well.defaulted.filter(function (k) { return ['h', 'B', 'mu', 'phi', 'ct', 'rw'].indexOf(k) >= 0; });
        if (inputsDefaulted.length) {
            warnings.push('Well inputs ' + inputsDefaulted.join(', ') + ' are defaults, not entered values — k and S depend on them; enter or accept them on Well & Test.');
            if (keys.indexOf('S') >= 0) identifiable.S = false;
        }
    }
    // Fracture / horizontal models: S and the reference length trade off along a
    // ridge; flag the length when the two are strongly correlated.
    var refKey = (pm.refLength === 'xf' || pm.refLength === 'Lh') ? pm.refLength : null;
    if (refKey && best.corr && best.freeKeys) {
        var iS = best.freeKeys.indexOf('S'), iL = best.freeKeys.indexOf(refKey);
        if (iS >= 0 && iL >= 0 && Math.abs(best.corr[iS][iL]) > 0.95) {
            identifiable[refKey] = false;
            warnings.push(refKey + ' and S are strongly correlated (r = ' + best.corr[iS][iL].toFixed(3) + ') — ' + refKey + ' is not identifiable from these data.');
        }
    }
    if (isFinite(r2) && r2 < 0.9) warnings.push('Poor match (R² = ' + r2.toFixed(3) + ').');
    // A fit stuck at a bound or with a poor match is not a converged result,
    // whatever the LM stop criterion said ('stationary' / 'plateau' at a bound).
    // Natural bounds (no storage: C at its minimum; fracture-face skin at 0;
    // boundary / shape parameters) do not count.
    var stalledAtBound = [];
    keys.forEach(function (k) {
        if (freeze[k] || !(best.atBound && best.atBound[k])) return;
        if (shapeKeyOf(k)) return;
        // best.atBound already says "within tolerance of a bound"; here we only
        // need which side (same tolerance as atBound, so natural lower bounds
        // stay exempt when the fit stops a hair inside them).
        var lo = bounds[k][0], hi = bounds[k][1];
        var atLo = !isFinite(hi) || Math.abs(phys[k] - lo) <= Math.abs(hi - phys[k]);
        if ((k === 'C' || k === 'CDe2S') && atLo) return;
        if (k === 'S' && atLo && refKey) return;
        stalledAtBound.push(k);
    });
    function shapeKeyOf(k) { return ['k', 'C', 'S', 'pi', 'A', 'T', 'CDe2S'].indexOf(k) < 0 && k !== refKey; }
    var convergedOut = !!best.converged && !(isFinite(r2) && r2 < 0.9) && !stalledAtBound.length;
    var stopOut = best.stopReason;
    if (best.converged && !convergedOut) stopOut = stalledAtBound.length ? 'stalled-at-bound' : 'poor-match';

    var corrOut = null;
    if (best.corr) corrOut = best.corr.map(function (row) { return row.slice(); });

    var fit = {
        ok: true,
        modelKey: modelKey, model: modelKey, kind: 'pressure', source: 'regression',
        mode: pm.mode || 'physical',
        params: params, phys: physOut, fitKeys: keys.slice(), frozen: Object.keys(freeze),
        ci95: ci95, stderr: stderr, corr: corrOut, corrKeys: best.freeKeys.slice(), identifiable: identifiable,
        r2: r2, rmse: rmse, aic: best.aic, dAIC: 0,
        iterations: best.iterations, converged: convergedOut, stopReason: stopOut,
        settled: _lmSettled(best), atBoundKeys: _boundKeys(best, keys, freeze),
        stalledAtBound: stalledAtBound, inputsDefaulted: inputsDefaulted,
        objective: objective, objectiveValue: best.ssr, derivMode: derivMode,
        nPoints: { dp: idxDp.length, deriv: idxD.length }, starts: nStartsOk,
        window: { tmin: isFinite(tmin) ? tmin : T[0], tmax: isFinite(tmax) ? tmax : T[T.length - 1] },
        scales: { A: mp.A, B: mp.B },
        floatPi: floatPi,
        pRef: floatPi && _num(phys.pi) ? phys.pi : pRef,
        pRefSource: floatPi ? 'fitted' : adata.pRefSource,
        testType: adata.testType, timeFn: adata.timeFn,
        datasetHash: _datasetHash(ds),
        timestamp: new Date().toISOString(),
        elapsedMs: Date.now() - t0,
        warnings: warnings
    };

    if (opts.bootstrap) {
        try {
            var nb = (opts.bootstrap === true) ? 200 : Math.max(10, opts.bootstrap | 0);
            var bs = PRiSM_bootstrap(resFn, data, phys, {
                nBootstrap: nb, bounds: bounds, freeze: freeze, seed: (opts.seed != null ? opts.seed : 12345),
                lmOpts: { maxIter: 25, tolerance: 1e-5, logKeys: logKeys }
            });
            fit.bootstrap = { n: nb, failures: bs.failures, ci: bs.ci, percentiles: bs.percentiles };
        } catch (e) { fit.warnings.push('Bootstrap failed: ' + e.message); }
    }
    return fit;
}

// Lower SSR wins (equal parameter count → same ordering as AIC), but a converged
// run within 0.1 % of the best SSR is preferred to an unconverged one.
function _betterRun(res, best) {
    if (!best) return true;
    var tol = 1e-3 * Math.max(best.ssr, res.ssr) + 1e-300;
    if (res.converged && !best.converged && res.ssr <= best.ssr + tol) return true;
    if (!res.converged && best.converged && res.ssr >= best.ssr - tol) return false;
    return res.ssr < best.ssr;
}

// Did an LM run settle? A converged run did. An unconverged one (maxIter,
// lambda-max, time budget) counts as settled only when its last iteration
// changed the objective by less than 1 % — i.e. it stopped on a plateau of the
// objective, not in mid-descent (a 3-iteration run from a garbage start can
// pass R² ≥ 0.9 while still moving by orders of magnitude per step).
var SETTLED_REL_DROP = 0.01;
function _lmSettled(res) {
    if (!res) return false;
    if (res.converged) return true;
    var h = res.residualHistory;
    if (!Array.isArray(h) || h.length < 2) return false;
    var prev = h[h.length - 2], last = h[h.length - 1];
    if (!isFinite(prev) || !isFinite(last)) return false;
    return (prev - last) <= SETTLED_REL_DROP * Math.max(Math.abs(prev), 1e-300);
}

// Free parameters sitting (within LM tolerance) at any bound, natural ones included.
function _boundKeys(res, keys, freeze) {
    return keys.filter(function (k) { return !freeze[k] && !!(res && res.atBound && res.atBound[k]); });
}

function _fmtNum(v) { return _num(v) ? (Math.abs(v) >= 1e4 || Math.abs(v) < 1e-3 ? v.toExponential(3) : +v.toPrecision(4)) : String(v); }


// =============================================================================
// SECTION 9 — PRiSM_fitRate — decline-curve regression on q
// =============================================================================
// t_days = t × (days per dataset time unit); hours by default. Keeps t ≥ 0 and
// q > 0 (t > 0 for models that are singular at 0, e.g. Duong). Residuals are
// ln q_d − ln q_m. Rates keep the dataset units; Di is in 1/day.
// =============================================================================

function _daysPerUnit(unit) {
    var u = String(unit || 'h').toLowerCase();
    if (u === 'd' || u === 'day' || u === 'days') return 1;
    if (u === 'mo' || u === 'month' || u === 'months') return 30.4375;
    if (u === 'y' || u === 'yr' || u === 'year' || u === 'years') return 365.25;
    if (u === 'min' || u === 'mins' || u === 'minute' || u === 'minutes') return 1 / 1440;
    if (u === 's' || u === 'sec' || u === 'seconds') return 1 / 86400;
    return 1 / 24;
}

var _RATE_POSITIVE_T = { duong: true };
var _RATE_LOG_KEYS = { qi: 1, q1: 1, Di: 1, tau: 1, reD: 1 };

function _seedRate(modelKey, entry, t, q, base) {
    var s = _copy(base);
    var n = t.length, q0 = q[0];
    var m = Math.max(2, Math.floor(n * 0.2));
    var lnq0 = Math.log(q[0]), lnqm = Math.log(q[Math.min(m, n - 1)]);
    var dtm = t[Math.min(m, n - 1)] - t[0];
    var Dexp = (dtm > 0) ? Math.max((lnq0 - lnqm) / dtm, 1e-6) : 0.01;
    var qi0 = q0 * Math.exp(Dexp * Math.max(t[0], 0));
    if ('qi' in s) s.qi = qi0;
    if ('Di' in s) s.Di = Dexp;
    if ('tau' in s) {
        var tau = t[n - 1];
        for (var i = 0; i < n; i++) if (q[i] < qi0 / Math.E) { tau = Math.max(t[i], 1e-3); break; }
        s.tau = tau;
    }
    if ('q1' in s) {
        var lt = t.map(function (v) { return Math.log(Math.max(v, 1e-9)); });
        s.q1 = (t[0] <= 1 && t[n - 1] >= 1) ? Math.exp(_interpAt(lt, q.map(Math.log), 0)) : q0;
    }
    return s;
}

/**
 * @param {string} modelKey  a kind:'rate' registry model
 * @param {object=} ds       { t, q, timeUnit? } (default PRiSM_dataset)
 * @param {object=} opts     { timeUnit, window:{tmin,tmax} (days), params (start),
 *                             freeze, maxIter, tolerance, bootstrap, seed }
 */
function PRiSM_fitRate(modelKey, ds, opts) {
    opts = opts || {};
    var t0 = Date.now();
    var fail = function (reason) {
        return { ok: false, reason: reason, modelKey: modelKey, model: modelKey, kind: 'rate',
                 source: 'regression', converged: false, warnings: [reason] };
    };
    var entry = _registry()[modelKey];
    if (!entry || typeof entry.pd !== 'function') return fail('Unknown model "' + modelKey + '".');
    if (entry.kind !== 'rate') return fail('"' + modelKey + '" is not a rate model.');
    ds = ds || G.PRiSM_dataset;
    if (!ds || !Array.isArray(ds.t) || !Array.isArray(ds.q)) return fail('No rate data (need t and q columns).');
    var f = _daysPerUnit(opts.timeUnit || ds.timeUnit);
    var positiveT = !!(_RATE_POSITIVE_T[modelKey] || entry.requiresPositiveT);
    var win = opts.window || {};
    var tmin = _num(win.tmin) ? win.tmin : -Infinity, tmax = _num(win.tmax) ? win.tmax : Infinity;
    var rows = [];
    var dropped = 0;
    for (var i = 0; i < ds.t.length; i++) {
        var td = +ds.t[i] * f, qv = +ds.q[i];
        if (!isFinite(td) || !isFinite(qv)) { dropped++; continue; }
        if (td < 0 || (positiveT && td <= 0) || !(qv > 0)) { dropped++; continue; }
        if (td < tmin || td > tmax) continue;
        rows.push({ t: td, q: qv });
    }
    rows.sort(function (a, b) { return a.t - b.t; });
    if (rows.length < 3) return fail('Fewer than 3 usable rate points (need t ≥ 0 and q > 0).');
    var T = rows.map(function (r) { return r.t; }), Q = rows.map(function (r) { return r.q; });
    var lnQ = Q.map(Math.log);

    var st = _state() || {};
    var base = _copy(entry.defaults);
    (entry.paramSpec || []).forEach(function (s) { if (s && s.key && !(s.key in base) && s['default'] !== undefined) base[s.key] = s['default']; });
    var start = opts.params ? _copy(opts.params) : null;
    if (start) for (var bk in base) if (!(bk in start)) start[bk] = base[bk];

    var bounds = {}, logKeys = [];
    (entry.paramSpec || []).forEach(function (s) {
        if (!s || !s.key || typeof base[s.key] !== 'number') return;
        bounds[s.key] = [_num(s.min) ? s.min : -Infinity, _num(s.max) ? s.max : Infinity];
        if (s.scale === 'log' || _RATE_LOG_KEYS[s.key]) logKeys.push(s.key);
    });
    var freeze = {};
    var uf = opts.freeze || (st.model === modelKey ? st.paramFreeze : null) || {};
    for (var fk in uf) if (uf[fk]) freeze[fk] = true;

    // Some evaluators reject t = 0; evaluate those at a vanishing t instead.
    var tEval = T.slice(), needEps = false;
    try { entry.pd([0], _copy(base)); } catch (e) { needEps = true; }
    if (needEps) tEval = T.map(function (v) { return v > 0 ? v : 1e-9; });
    var modelFn = function (_t, params) {
        var qm = _evalArr(entry.pd, tEval, params);
        return qm.map(function (v) { return v > 0 ? Math.log(v) : -700; });
    };
    var data = { t: T.map(function (_, i) { return i; }), p: lnQ };

    var starts = [];
    if (start) starts.push(start);
    else {
        var s0 = _seedRate(modelKey, entry, T, Q, base);
        starts.push(s0);
        if ('b' in s0 && !freeze.b) {
            [0.1, 1.0].forEach(function (bv) { var s1 = _copy(s0); s1.b = bv; starts.push(s1); });
        }
        if ('n' in s0 && !freeze.n) { var s2 = _copy(s0); s2.n = 0.3; starts.push(s2); }
    }
    starts.forEach(function (s) {
        for (var k in bounds) s[k] = _clampSpec(s[k], { min: bounds[k][0], max: bounds[k][1] });
        logKeys.forEach(function (k) { if (!(s[k] > 0)) s[k] = (bounds[k] && bounds[k][0] > 0) ? bounds[k][0] : 1e-6; });
    });
    var lmOpts = {
        maxIter: _num(opts.maxIter) ? opts.maxIter : 200,
        tolerance: _num(opts.tolerance) ? opts.tolerance : 1e-10,
        logKeys: logKeys
    };
    var best = null;
    starts.forEach(function (s) {
        var r;
        try { r = PRiSM_lm(modelFn, data, s, bounds, freeze, lmOpts); } catch (e) { return; }
        if (!r || !isFinite(r.ssr)) return;
        if (_betterRun(r, best)) best = r;
    });
    if (!best) return fail('Rate regression failed at every start.');

    var qm = _evalArr(entry.pd, tEval, best.params);
    var mean = 0; Q.forEach(function (v) { mean += v; }); mean /= Q.length;
    var ssr = 0, ssTot = 0;
    Q.forEach(function (v, i) { var e = v - qm[i]; ssr += e * e; ssTot += (v - mean) * (v - mean); });
    var r2 = ssTot > 0 ? 1 - ssr / ssTot : NaN;
    var rmse = Math.sqrt(ssr / Q.length);

    var params = _copy(best.params);
    var phys = _copy(params);
    if (_num(params.Di)) phys.Di_yr = 365 * params.Di;
    var warnings = [];
    if (dropped) warnings.push(dropped + ' point(s) excluded (t < 0' + (positiveT ? ' or t = 0' : '') + ', q ≤ 0 or non-numeric).');
    if (!best.converged) warnings.push('Rate regression did not converge (' + best.stopReason + ').');
    Object.keys(bounds).forEach(function (k) {
        if (freeze[k]) return;
        if (best.atBound && best.atBound[k]) warnings.push('Parameter ' + k + ' is at its bound (' + _fmtNum(params[k]) + ').');
    });
    if (_num(params.b) && params.b > 1) warnings.push('b > 1: EUR is unbounded without a terminal decline (Dmin).');

    var fit = {
        ok: true,
        modelKey: modelKey, model: modelKey, kind: 'rate', source: 'regression', mode: 'rate',
        params: params, phys: phys, fitKeys: best.freeKeys.slice(), frozen: Object.keys(freeze),
        ci95: best.ci95, stderr: best.stderr, corr: best.corr, corrKeys: best.freeKeys.slice(),
        identifiable: best.identifiable,
        r2: r2, rmse: rmse, aic: best.aic, dAIC: 0,
        iterations: best.iterations, converged: best.converged, stopReason: best.stopReason,
        settled: _lmSettled(best), atBoundKeys: _boundKeys(best, Object.keys(bounds), freeze),
        objective: 'lnq', objectiveValue: best.ssr,
        nPoints: { q: Q.length },
        window: { tmin: T[0], tmax: T[T.length - 1] }, timeUnit: 'd',
        scales: null, pRef: null, pRefSource: null,
        datasetHash: _datasetHash(ds),
        timestamp: new Date().toISOString(),
        elapsedMs: Date.now() - t0,
        warnings: warnings
    };
    if (opts.bootstrap) {
        try {
            var nb = (opts.bootstrap === true) ? 200 : Math.max(10, opts.bootstrap | 0);
            var bs = PRiSM_bootstrap(modelFn, data, best.params, {
                nBootstrap: nb, bounds: bounds, freeze: freeze, seed: (opts.seed != null ? opts.seed : 12345),
                lmOpts: { maxIter: 60, tolerance: 1e-8, logKeys: logKeys }
            });
            fit.bootstrap = { n: nb, failures: bs.failures, ci: bs.ci, percentiles: bs.percentiles };
        } catch (e) { fit.warnings.push('Bootstrap failed: ' + e.message); }
    }
    return fit;
}


// =============================================================================
// SECTION 10 — PRiSM_runRegression — Tab 6 glue
// =============================================================================
// Dispatch by entry.kind (missing kind = pressure). Pressure fits use the
// well store (scale mode + warning when incomplete). The fit is always handed
// to PRiSM_setLastFit (honest status: converged / r2 / warnings), but
// st.params / st.phys / st.tcMatch are only adopted when R² ≥ 0.9 and nothing
// is stalled at a bound; an unconverged fit must also have settled (last step
// < 1 % SSR change) with no free parameter at any bound. PRiSM_state.match is
// never written.
// =============================================================================

function _storeLastFit(fit) {
    if (typeof G.PRiSM_setLastFit === 'function') {
        try { G.PRiSM_setLastFit(fit); return; } catch (e) { /* fallback below */ }
    }
    var st = _state();
    if (st) st.lastFit = fit;
    try {
        if (typeof G.dispatchEvent === 'function' && typeof G.CustomEvent === 'function') {
            G.dispatchEvent(new G.CustomEvent('prism:fit-updated', { detail: { source: fit.source, modelKey: fit.modelKey } }));
        }
    } catch (e2) { /* no event system */ }
}

/**
 * @param {object=} opts { modelKey, dataset, well, adata, window, floatPi,
 *                         objective, freeze, start, params, maxIter, tolerance,
 *                         bootstrap, mode, derivMode, timeUnit }
 * @return the stored LastFit object plus { adopted:bool } (never throws for
 *         data/model problems — returns { ok:false, converged:false, reason }).
 */
function PRiSM_runRegression(opts) {
    opts = opts || {};
    var st = _state() || {};
    var modelKey = opts.modelKey || st.model;
    var fail = function (reason) {
        return { ok: false, reason: reason, error: reason, modelKey: modelKey, model: modelKey,
                 converged: false, adopted: false, warnings: [reason], params: st.params, stderr: {}, ci95: {} };
    };
    if (!modelKey) return fail('No model selected.');
    var entry = _registry()[modelKey];
    if (!entry) return fail('Unknown model "' + modelKey + '".');
    var ds = opts.dataset || G.PRiSM_dataset;
    var kind = entry.kind || 'pressure';
    var sameModel = (st.model === modelKey);
    var fit;

    if (kind === 'rate') {
        var startR = opts.params || (sameModel ? _pickNumeric(st.params) : null);
        fit = PRiSM_fitRate(modelKey, ds, {
            timeUnit: opts.timeUnit, window: opts.window, params: opts.start || startR,
            freeze: opts.freeze || (sameModel ? st.paramFreeze : null),
            maxIter: opts.maxIter, tolerance: opts.tolerance, bootstrap: opts.bootstrap, seed: opts.seed
        });
    } else {
        if (!ds || !Array.isArray(ds.t) || !Array.isArray(ds.p)) return fail('No pressure data loaded.');
        var well = opts.well || _getWell(ds);
        var adata = opts.adata || _getAnalysisData(ds, well, {
            period: (opts.period != null ? opts.period : st.activePeriod),
            timeFn: opts.timeFn || st.timeFn || 'auto', L: st.bourdetL
        });
        fit = PRiSM_fitPhysical(modelKey, adata, well, {
            dataset: ds, objective: opts.objective, window: opts.window, floatPi: opts.floatPi,
            freeze: opts.freeze || (sameModel ? st.paramFreeze : null),
            start: opts.start, params0: opts.params || (sameModel ? st.params : null),
            maxIter: opts.maxIter, tolerance: opts.tolerance, derivMode: opts.derivMode,
            mode: opts.mode || (well && well.complete === false ? 'scale' : undefined),
            bootstrap: opts.bootstrap, seed: opts.seed, timeBudgetMs: opts.timeBudgetMs
        });
    }
    if (!fit || !fit.ok) {
        var f = fail((fit && fit.reason) || 'Regression failed.');
        return f;
    }

    // Adopt only a sane fit: R² ≥ 0.9 and no headline parameter stuck at a bound
    // (the LM 'stationary' / 'plateau' stops can report converged at a bound
    // with a strongly negative R²). Without an R², fall back to convergence.
    // An UNconverged fit (maxIter / lambda-max / time budget) is adopted only
    // when the objective had settled (last step changed SSR < 1 %) and no free
    // parameter is pinned at any bound — natural bounds included, since only a
    // converged (stationarity-checked) fit may rest on one. Otherwise an early
    // stop from a garbage start that happens to cross R² 0.9 mid-descent (e.g.
    // C slammed to its 1e-8 floor after 3 iterations) would replace st.params.
    var stalled = !!(fit.stalledAtBound && fit.stalledAtBound.length);
    var unsettled = !fit.converged && fit.settled === false;
    var boundUnconv = (!fit.converged && Array.isArray(fit.atBoundKeys)) ? fit.atBoundKeys : [];
    var adopt = isFinite(fit.r2) ? (fit.r2 >= 0.9 && !stalled && !unsettled && !boundUnconv.length)
                                 : (!!fit.converged && !stalled);
    fit.adopted = adopt;
    if (!adopt) {
        // Name the actual reason(s): the stall, the low R², or non-convergence.
        var why = [];
        if (stalled) why.push('parameter at a bound: ' + fit.stalledAtBound.join(', '));
        else if (boundUnconv.length) why.push('not converged with parameter at a bound: ' + boundUnconv.join(', '));
        if (isFinite(fit.r2) && fit.r2 < 0.9) why.push('R² ' + fit.r2.toFixed(3) + ' < 0.9');
        if (unsettled) why.push('not converged (' + (fit.stopReason || 'stopped') + ') and still improving');
        if (!isFinite(fit.r2) && !fit.converged) why.push('not converged');
        if (!why.length) why.push('not converged');
        fit.converged = false;
        if (!Array.isArray(fit.warnings)) fit.warnings = [];
        fit.warnings.push('Fit not adopted (' + why.join('; ') + ') — previous parameters and result kept.');
        // The rejected result is returned to the caller (Tab 6 shows it) but is
        // not stored as lastFit: the rail, step ④ and the report keep the
        // previous, adopted result that matches st.params.
        return fit;
    }
    // Adopt first, then store: prism:fit-updated listeners (undo snapshots, rail,
    // C8 save) must see the adopted params / phys / tcMatch (WP0 fix).
    if (adopt && G.PRiSM_state) {
        var S = G.PRiSM_state;
        if (S.model !== modelKey) {
            if (typeof G.PRiSM_setModel === 'function') { try { G.PRiSM_setModel(modelKey); } catch (e) { S.model = modelKey; } }
            else S.model = modelKey;
        }
        S.params = _copy(fit.params);
        if (fit.kind === 'pressure') {
            S.phys = _copy(fit.phys);
            if (_pos(fit.scales && fit.scales.A) && _pos(fit.scales.B)) {
                S.tcMatch = { logPM: Math.log10(1 / fit.scales.A), logTM: Math.log10(fit.scales.B), source: 'regression' };
            }
        } else {
            S.phys = _copy(fit.phys);
        }
    }
    _storeLastFit(fit);
    if (adopt && G.PRiSM_state) {
        if (typeof G.PRiSM_evalModelCurve === 'function') {
            try { G.PRiSM_evalModelCurve(modelKey, G.PRiSM_state.params, { phys: G.PRiSM_state.phys }); } catch (e) { fit.warnings.push('Model curve refresh failed: ' + e.message); }
        }
        if (typeof G.PRiSM_drawActivePlot === 'function') {
            try { G.PRiSM_drawActivePlot(); } catch (e) { /* plot layer reports its own errors */ }
        }
    }
    return fit;
}

function _pickNumeric(o) {
    if (!o) return null;
    var out = {}, any = false;
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) { out[k] = o[k]; if (_num(o[k])) any = true; }
    return any ? out : null;
}


// =============================================================================
// SECTION 11 — EXPOSE TO GLOBAL
// =============================================================================

(function _expose() {
    G.PRiSM_lm                    = PRiSM_lm;
    G.PRiSM_bootstrap             = PRiSM_bootstrap;
    G.PRiSM_superposition         = PRiSM_superposition;
    G.PRiSM_sandface_convolution  = PRiSM_sandface_convolution;
    G.PRiSM_agarwalTime           = PRiSM_agarwalTime;
    G.PRiSM_fitPhysical           = PRiSM_fitPhysical;
    G.PRiSM_fitRate               = PRiSM_fitRate;
    G.PRiSM_runRegression         = PRiSM_runRegression;
    G.PRiSM_invertMatrix          = PRiSM_invertMatrix;
    G.PRiSM_solveLinear           = PRiSM_solveLinear;
    G.PRiSM_jacobianForward       = PRiSM_jacobianForward;
    G.PRiSM_tQuantile975          = PRiSM_tQuantile975;
    // Local contract fallbacks, exposed for tests and for layers that need
    // the same behaviour without the core layer loaded.
    G.PRiSM_regressionInternals = {
        well:          _localWell,
        analysisData:  _localAnalysisData,
        physicalModel: _localPhysicalModel,
        bourdet:       _bourdet,
        rateSteps:     _rateStepsFromSamples,
        superpositionTime: function (dt, rateHistory, n) {
            var steps = _normSteps(rateHistory);
            if (n == null) n = steps.length - 1;
            return Math.exp(_supTime(dt, steps, n));
        }
    };
})();

})();

// ─── END 05-regression ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 06-decline-and-specialised ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// =============================================================================
// PRiSM — Layer 06 — Decline-Curve (Phase 3) + Specialised Single-Well (Phase 4)
// =============================================================================
// This file adds 7 evaluators to the PRiSM model registry:
//
//   Decline curves (rate-vs-time, kind: 'rate', timeInput: 'days'):
//     1. arps        — exponential / hyperbolic / harmonic (b-factor switch),
//                      optional modified-hyperbolic terminal decline Dmin
//     2. duong       — Duong (2011) shale decline
//     3. sepd        — Stretched-exponential production decline (Valko 2009)
//     4. fetkovich   — Fetkovich (1980) type curve: rigorous closed-circle
//                      constant-pwf transient stems + Arps depletion stems
//
//   Specialised single-well (pressure-vs-time, kind: 'pressure'):
//     5. doublePorosity — Warren-Root naturally fractured (PSS / 1DT / 3DT)
//     6. partialPen     — Partial-penetration vertical well
//     7. verticalPulse  — Vertical pulse-test (separated observation point)
//
// Time convention for the decline models: t is REAL production time in DAYS
// (registry `timeInput: 'days'`), rates in STB/d or Mscf/d, Di and Dmin in
// 1/day.  t = 0 is accepted by arps, sepd and fetkovich (t·dq/dt = 0 there).
//
// EUR helpers (cumulative production from t = 0 to t_end, days):
//   PRiSM_eur_arps(params, t_end)       closed form, Dmin-aware
//   PRiSM_eur_duong(params, t_end)      numerical
//   PRiSM_eur_sepd(params, t_end)       closed form (incomplete gamma)
//   PRiSM_eur_fetkovich(params, t_end)  numerical
// Arps / modified-hyperbolic helpers (for the DCA results panel):
//   PRiSM_arps_q, PRiSM_arps_Np, PRiSM_arps_D, PRiSM_arps_tSwitch,
//   PRiSM_arps_timeToRate, PRiSM_arps_eurToRate, PRiSM_arps_De
//   (also grouped on window.PRiSM_DECLINE)
// Fetkovich type curve (for the Blasingame / Fetkovich RTA plots):
//   PRiSM_fetkovich_typecurve(reD, b, tDd[]) → qDd[]
//   PRiSM_fetkovich_qD(tD, reD)             → rigorous constant-pwf qD
//
// Pressure models use the finite-wellbore well term and a WBS + skin fold that
// is valid for negative skin (effective-wellbore-radius transform).  The fold
// delegates to window.PRiSM_evalWbsSkin when that export is present and agrees
// with the local implementation; otherwise the local copy is used.
//
// All public symbols are PRiSM_* / window.PRiSM_MODELS to avoid collisions.
// =============================================================================

(function () {
'use strict';

// -- shared constants -------------------------------------------------------
var DERIV_REL_STEP  = 1e-3;     // relative log-step for numerical derivative
var EUR_INT_POINTS  = 240;      // log-spaced points for numerical EUR
var ARPS_B_EXP      = 1e-6;     // b below this → exponential branch

// -- foundation primitive resolver -----------------------------------------
function _foundation(name) {
  var g = (typeof window !== 'undefined') ? window
        : (typeof globalThis !== 'undefined' ? globalThis : {});
  if (typeof g[name] === 'function') return g[name];
  try { return eval(name); } catch (e) { return null; }
}

function _win() {
  return (typeof window !== 'undefined') ? window
       : (typeof globalThis !== 'undefined' ? globalThis : {});
}

function _num(v) {
  return (typeof v === 'number') && isFinite(v) && !isNaN(v);
}

function _arrayMap(td, fn) {
  if (Array.isArray(td)) {
    var out = new Array(td.length);
    for (var i = 0; i < td.length; i++) out[i] = fn(td[i]);
    return out;
  }
  return fn(td);
}

function _requirePositiveTd(td) {
  if (Array.isArray(td)) {
    for (var i = 0; i < td.length; i++) {
      if (!_num(td[i]) || td[i] <= 0) {
        throw new Error('PRiSM 06: td must be > 0 (got ' + td[i] + ' at index ' + i + ')');
      }
    }
  } else if (!_num(td) || td <= 0) {
    throw new Error('PRiSM 06: td must be > 0 (got ' + td + ')');
  }
}

// Decline models accept t ≥ 0 (t = 0 is the start of production).
function _requireNonNegT(t) {
  if (Array.isArray(t)) {
    for (var i = 0; i < t.length; i++) {
      if (!_num(t[i]) || t[i] < 0) {
        throw new Error('PRiSM 06: t must be ≥ 0 days (got ' + t[i] + ' at index ' + i + ')');
      }
    }
  } else if (!_num(t) || t < 0) {
    throw new Error('PRiSM 06: t must be ≥ 0 days (got ' + t + ')');
  }
}

function _requireParams(params, keys) {
  if (!params || typeof params !== 'object') {
    throw new Error('PRiSM 06: params object required');
  }
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (!(k in params)) {
      throw new Error('PRiSM 06: missing required param "' + k + '"');
    }
  }
}

// EUR functions are PRiSM_eur_x(params, t_end).  Some callers pass
// (t_end, params); accept both orders.
function _eurArgs(a, b) {
  if (typeof a === 'number' && b && typeof b === 'object') return { p: b, t: a };
  return { p: a, t: b };
}

// generic numerical logarithmic derivative td * dPd/dtd via 5-point central
// difference in ln(td) space.
function _numericLogDeriv(pdFn, td, params) {
  var h = DERIV_REL_STEP;
  var lnTd = Math.log(td);
  var f_m2 = pdFn(Math.exp(lnTd - 2 * h), params);
  var f_m1 = pdFn(Math.exp(lnTd -     h), params);
  var f_p1 = pdFn(Math.exp(lnTd +     h), params);
  var f_p2 = pdFn(Math.exp(lnTd + 2 * h), params);
  if (Array.isArray(f_m2)) f_m2 = f_m2[0];
  if (Array.isArray(f_m1)) f_m1 = f_m1[0];
  if (Array.isArray(f_p1)) f_p1 = f_p1[0];
  if (Array.isArray(f_p2)) f_p2 = f_p2[0];
  return (-f_p2 + 8 * f_p1 - 8 * f_m1 + f_m2) / (12 * h);  // == td * dPd/dtd
}

// trapezoidal integration of fn(t) over a log-spaced grid [t_min, t_end].
function _trapezoidalLog(fn, t_min, t_end, n) {
  if (!(t_end > t_min)) return 0;
  var lmin = Math.log(t_min), lmax = Math.log(t_end);
  var step = (lmax - lmin) / (n - 1);
  var sum = 0, tPrev = t_min, fPrev = fn(t_min);
  for (var j = 1; j < n; j++) {
    var t = Math.exp(lmin + j * step);
    var f = fn(t);
    var fy = (f + fPrev) * 0.5;
    if (_num(fy)) sum += fy * (t - tPrev);
    tPrev = t; fPrev = f;
  }
  return sum;
}


// =============================================================================
// SECTION 0 — Numerics (WP4b): smooth scaled Bessel functions, Stehfest,
//             wellbore-storage + skin fold
// =============================================================================
//
// Why local Bessel functions: the Abramowitz-Stegun polynomial fits switch
// formula at x = 2 (K) and x = 3.75 (I) with ~1e-7 jumps.  Stehfest (N = 12,
// weights up to 8e6) amplifies such jumps into percent-level pwd errors when
// the 12 sample points straddle a breakpoint (3.7 % measured at Cd = 0.01).
// The forms below (power series / continued fraction / Hankel series, each
// used only where it is accurate to machine precision) agree to ~1e-14 across
// their switch points and are exponentially scaled, so they never over- or
// underflow.
// =============================================================================

var _EULER = 0.5772156649015329;

// K_nu(x)·e^x for nu ∈ {0,1}, x > 0 (all branches accurate to ~1e-15):
//   x < 2       : power series (K0: −(ln(x/2)+γ)·I0 + Σ q^k/(k!)²·H_k; K1 likewise)
//   2 ≤ x ≤ 30  : Steed / Temme continued fraction CF2 (Numerical Recipes bessik)
//   x > 30      : Hankel asymptotic series, optimally truncated (error < e^-60)
function _Kse(nu, x) {
  if (!(x > 0)) return Infinity;
  if (x === Infinity) return 0;
  if (x > 30) {
    var mu = 4 * nu * nu, a = 1, s = 1, prev = Infinity;
    for (var j = 1; j < 80; j++) {
      a *= (mu - (2 * j - 1) * (2 * j - 1)) / (j * 8 * x);
      var at = Math.abs(a);
      if (at > prev) break;
      s += a; prev = at;
      if (at < 1e-17) break;
    }
    return s * Math.sqrt(Math.PI / (2 * x));
  }
  if (x < 2) {
    var q = 0.25 * x * x, lx = Math.log(0.5 * x);
    if (!nu) {
      // K0 = −(ln(x/2)+γ)·I0 + Σ_{k≥1} q^k/(k!)²·H_k
      var t = 1, I0 = 1, S = 0, H = 0;
      for (var k = 1; k < 60; k++) { t *= q / (k * k); H += 1 / k; I0 += t; S += t * H; if (t < 1e-18) break; }
      return (-(lx + _EULER) * I0 + S) * Math.exp(x);
    }
    // K1 = 1/x + ln(x/2)·I1 − (x/4)·Σ_{k≥0} (ψ(k+1)+ψ(k+2))·q^k/(k!(k+1)!)
    var tk = 1, I1s = 1, S1 = (-_EULER) + (1 - _EULER), Hk = 0;
    for (var k2 = 1; k2 < 60; k2++) {
      tk *= q / (k2 * (k2 + 1));
      Hk += 1 / k2;
      I1s += tk;
      S1 += tk * ((-_EULER + Hk) + (-_EULER + Hk + 1 / (k2 + 1)));
      if (tk < 1e-18) break;
    }
    var I1 = 0.5 * x * I1s;
    return (1 / x + lx * I1 - 0.25 * x * S1) * Math.exp(x);
  }
  // 2 ≤ x ≤ 30: Steed's continued fraction CF2 (Temme), nu = 0 → K0e, K1e
  var b = 2 * (1 + x), d = 1 / b, h = d, delh = d, q1 = 0, q2 = 1, a1 = 0.25;
  var qq = a1, c = a1, aa = -a1, ss = 1 + qq * delh;
  for (var i = 2; i < 1000; i++) {
    aa -= 2 * (i - 1);
    c = -aa * c / i;
    var qnew = (q1 - b * q2) / aa;
    q1 = q2; q2 = qnew;
    qq += c * qnew;
    b += 2;
    d = 1 / (b + aa * d);
    delh = (b * d - 1) * delh;
    h += delh;
    var dels = qq * delh;
    ss += dels;
    if (Math.abs(dels / ss) < 1e-17) break;
  }
  h = a1 * h;
  var k0e = Math.sqrt(Math.PI / (2 * x)) / ss;
  return nu ? k0e * (x + 0.5 - h) / x : k0e;
}
function _K0e(x) { return _Kse(0, x); }
function _K1e(x) { return _Kse(1, x); }

// I_nu(x)·e^-x for nu ∈ {0,1}: power series for x ≤ 15, Hankel series above.
function _Ise(nu, x) {
  x = Math.abs(x);
  if (x <= 15) {
    var q = 0.25 * x * x, term = nu ? 0.5 * x : 1, sum = term;
    for (var k = 1; k < 200; k++) {
      term *= q / (k * (k + nu));
      sum += term;
      if (term < 1e-17 * sum) break;
    }
    return sum * Math.exp(-x);
  }
  var mu = 4 * nu * nu, a = 1, s = 1, prev = Infinity;
  for (var j = 1; j < 60; j++) {
    a *= -(mu - (2 * j - 1) * (2 * j - 1)) / (j * 8 * x);
    var at = Math.abs(a);
    if (at > prev) break;
    s += a; prev = at;
    if (at < 1e-17) break;
  }
  return s / Math.sqrt(2 * Math.PI * x);
}
function _I0e(x) { return _Ise(0, x); }
function _I1e(x) { return _Ise(1, x); }

// Finite-wellbore well term K0(x) / (x·K1(x)) — scale factors cancel.
function _wellTerm(x) { return _K0e(x) / (x * _K1e(x)); }

// ---- Stehfest (N = 12) ----------------------------------------------------
var _SW12 = (function () {
  var N = 12, f = [1], w = [];
  for (var i = 1; i <= N; i++) f[i] = f[i - 1] * i;
  for (var n = 1; n <= N; n++) {
    var s = 0;
    for (var k = Math.floor((n + 1) / 2); k <= Math.min(n, N / 2); k++) {
      s += Math.pow(k, N / 2) * f[2 * k] /
           (f[N / 2 - k] * f[k] * f[k - 1] * f[n - k] * f[2 * k - n]);
    }
    w.push(((n + N / 2) % 2 === 0 ? 1 : -1) * s);
  }
  return w;
})();
var _stehImpl;   // foundation PRiSM_stehfest (same weights), resolved lazily
function _steh(F, t) {
  if (_stehImpl === undefined) _stehImpl = _foundation('PRiSM_stehfest') || null;
  if (_stehImpl) return _stehImpl(F, t, 12);
  var a = Math.LN2 / t, s = 0;
  for (var i = 1; i <= 12; i++) s += _SW12[i - 1] * F(i * a);
  return a * s;
}

// ---- Wellbore storage + skin fold ------------------------------------------
//   p̄wD(s) = (s·p̄ + S) / ( s·(1 + Cd·s·(s·p̄ + S)) )     (Agarwal-Ramey 1970)
// p̄(s) is the unit-rate reservoir response at the well, built with the
// FINITE-wellbore well term, so pwd → td/Cd at early time.
//
// Negative skin: for S < 0 the fold has a real positive pole wherever
// s·p̄ + S = −1/(Cd·s); Stehfest then returns garbage.  We use the effective-
// wellbore-radius transform (rwa = rw·e^−S): evaluate with S = 0 at
// tDa = td·e^{2S}, CDa = Cd·e^{2S}; the kernel receives sc = e^{S} and scales
// its rw-normalised distances by sc and rw²-normalised coefficients (λ) by
// 1/sc².  Late time is exactly 0.5(ln td + 0.80907) + S.
function _foldTransform(Cd, S) {
  Cd = _num(Cd) && Cd > 0 ? Cd : 0;
  S = _num(S) ? S : 0;
  if (S < 0) {
    var sc = Math.exp(S);
    return { sc: sc, tf: sc * sc, Cd: Cd * sc * sc, S: 0 };
  }
  return { sc: 1, tf: 1, Cd: Cd, S: S };
}
function _foldF(lap, Cd, S) {
  return function (s) {
    var g = s * lap(s) + S;
    if (!(Cd > 0)) return g / s;
    return g / (s * (1 + Cd * s * g));
  };
}
// Optional delegation to the shared export (WP4a, 03-models.js).  It is
// called only in the unambiguous S ≥ 0 form (after our own transform) and its
// first value is cross-checked against the local inversion.
function _extFold(lap, tArr, Cd, S, F) {
  var ext = _win().PRiSM_evalWbsSkin;
  if (typeof ext !== 'function' || !tArr.length) return null;
  try {
    var r = ext(lap, tArr.slice(), Cd, S, {});
    if (!r || r.length !== tArr.length) return null;
    for (var i = 0; i < r.length; i++) if (!_num(r[i])) return null;
    var chk = _steh(F, tArr[0]);
    if (!(Math.abs(r[0] - chk) <= 2e-3 * Math.max(Math.abs(chk), 1e-12))) return null;
    var out = new Array(r.length);
    for (var j = 0; j < r.length; j++) out[j] = r[j];
    return out;
  } catch (e) { return null; }
}
// lapFn(s, sc) → p̄(s).  Returns pwd (deriv false) or td·dpwd/dtd (deriv true,
// from the Laplace identity L[t·f'] = t·L^-1[s·F(s)] since pwd(0) = 0).
// localOnly: never delegate (kernels that depend on the inversion context).
function _evalWbsSkin(lapFn, td, Cd, S, deriv, localOnly) {
  var isArr = Array.isArray(td), arr = isArr ? td : [td];
  var T = _foldTransform(Cd, S);
  var lap = function (s) { return lapFn(s, T.sc); };
  var F = _foldF(lap, T.Cd, T.S);
  var tArr = new Array(arr.length);
  for (var i = 0; i < arr.length; i++) tArr[i] = arr[i] * T.tf;
  var out = null;
  if (!deriv && !localOnly) out = _extFold(lap, tArr, T.Cd, T.S, F);
  if (!out) {
    out = new Array(arr.length);
    var Fd = deriv ? function (s) { return s * F(s); } : null;
    for (var k = 0; k < arr.length; k++) {
      out[k] = deriv ? tArr[k] * _steh(Fd, tArr[k]) : _steh(F, tArr[k]);
    }
  }
  for (var m = 0; m < out.length; m++) {          // round-off below 1e-10 → 0
    if (out[m] < 0 && out[m] > -1e-10) out[m] = 0;
  }
  return isArr ? out : out[0];
}

// ---- Pseudo-skin library (shared export preferred) --------------------------
function _pseudoLib() {
  var lib = _win().PRiSM_pseudoSkin;
  return (lib && typeof lib === 'object') ? lib : null;
}
// Brons-Marting (1961) partial-penetration pseudo-skin
//   Sp = (1/b − 1)·[ln hD − G(b)],  G = 2.948 − 7.363b + 11.45b² − 4.675b³
//   b = hp/h, hD = (h/rw)·√(kh/kv)
function _bronsMartingLocal(b, hD) {
  if (!_num(b) || !_num(hD) || b <= 0 || b >= 1 || hD <= 0) return 0;
  var G = 2.948 - 7.363 * b + 11.45 * b * b - 4.675 * b * b * b;
  return Math.max(0, (1 / b - 1) * (Math.log(hD) - G));
}
function _bronsMarting(b, hD) {
  var lib = _pseudoLib();
  if (lib && typeof lib.bronsMarting === 'function') {
    try { var v = lib.bronsMarting(b, hD); if (_num(v)) return v; } catch (e) { /* local */ }
  }
  return _bronsMartingLocal(b, hD);
}
// h/rw injected by the physical-model wrapper as __h_rw (default 100).
function _hOverRw(params, geom) {
  if (geom && _num(geom.h) && _num(geom.rw) && geom.rw > 0) return geom.h / geom.rw;
  if (geom && _num(geom.h_rw) && geom.h_rw > 0) return geom.h_rw;
  if (params && _num(params.__h_rw) && params.__h_rw > 0) return params.__h_rw;
  return 100;
}


// =============================================================================
// SECTION A — DECLINE CURVES (Phase 3)
// =============================================================================
//
// Decline-curve evaluators take REAL elapsed production time t in DAYS and
// return RATE q(t).  They are exposed through the same evaluator interface as
// the pressure models, tagged kind: 'rate' + timeInput: 'days'.
// =============================================================================


// -----------------------------------------------------------------------------
// A.1 — ARPS DECLINE (+ optional modified-hyperbolic terminal decline)
// -----------------------------------------------------------------------------
//
// Reference: Arps, J.J. "Analysis of Decline Curves", Trans. AIME 160, 1945,
//            pp 228-247.  Modified hyperbolic: Robertson (1988).
//
//   q(t) = qi · exp(−ln(1 + b·Di·t)/b)          (b ≥ 1e-6; b = 1 harmonic)
//   q(t) = qi · exp(−Di·t)                        (b < 1e-6, exponential)
//
// Optional Dmin (1/day): the nominal decline D(t) = Di/(1 + b·Di·t) falls to
// Dmin at t_sw = (Di/Dmin − 1)/(b·Di); afterwards q = q_sw·exp(−Dmin(t−t_sw)).
// q and dq/dt are continuous at t_sw (C¹).
//
// Params: { qi, Di, b [, Dmin] }  — qi rate, Di & Dmin 1/day, b in [0, 2]
//
// Cumulative (closed form, numerically stable via log1p/expm1):
//   exponential : Np = (qi/Di)·(1 − e^{−Di·t})
//   harmonic    : Np = (qi/Di)·ln(1 + Di·t)
//   hyperbolic  : Np = qi/((1−b)·Di) · (1 − (1 + b·Di·t)^{1−1/b})
// -----------------------------------------------------------------------------

function _arpsP(params) {
  var qi = +params.qi, Di = +params.Di, b = +params.b;
  var Dmin = (params.Dmin != null) ? +params.Dmin : 0;
  var P = { qi: qi, Di: Di, b: b, Dmin: Dmin, exp: !(b >= ARPS_B_EXP),
            tsw: Infinity, qsw: 0, Npsw: 0, ok: true };
  if (!_num(qi) || !_num(Di) || !_num(b) || Di < 0 || b < 0) { P.ok = false; return P; }
  if (!P.exp && _num(Dmin) && Dmin > 0 && Dmin < Di) {
    P.tsw = (Di / Dmin - 1) / (b * Di);
    P.qsw = _arpsHypQ(P.tsw, P);
    P.Npsw = _arpsHypNp(P.tsw, P);
  }
  return P;
}
function _arpsHypQ(t, P) {
  if (P.Di === 0) return P.qi;
  if (P.exp) return P.qi * Math.exp(-P.Di * t);
  return P.qi * Math.exp(-Math.log1p(P.b * P.Di * t) / P.b);
}
function _arpsHypNp(t, P) {
  if (!(t > 0)) return 0;
  if (P.Di === 0) return P.qi * t;
  if (P.exp) return (P.qi / P.Di) * -Math.expm1(-P.Di * t);
  var L = Math.log1p(P.b * P.Di * t);
  var omb = 1 - P.b;
  if (omb === 0) return P.qi * L / P.Di;
  // qi/((1−b)Di) · (1 − exp(−((1−b)/b)·L))
  return P.qi / (omb * P.Di) * -Math.expm1(-(omb / P.b) * L);
}
function _arpsQ(t, P) {
  if (!P.ok) return NaN;
  if (t <= P.tsw) return _arpsHypQ(t, P);
  return P.qsw * Math.exp(-P.Dmin * (t - P.tsw));
}
function _arpsNp(t, P) {
  if (!P.ok) return NaN;
  if (t <= P.tsw) return _arpsHypNp(t, P);
  return P.Npsw + (P.qsw / P.Dmin) * -Math.expm1(-P.Dmin * (t - P.tsw));
}
// nominal (instantaneous) decline D(t) = −(dq/dt)/q, 1/day
function _arpsD(t, P) {
  if (!P.ok) return NaN;
  if (P.exp) return P.Di;
  if (t > P.tsw) return P.Dmin;
  return P.Di / (1 + P.b * P.Di * t);
}
// time (days) at which q falls to qTarget
function _arpsTimeToRate(qTarget, P) {
  if (!P.ok || !(qTarget > 0)) return NaN;
  if (qTarget >= P.qi) return 0;
  if (!(P.Di > 0)) return Infinity;
  if (P.exp) return Math.log(P.qi / qTarget) / P.Di;
  if (qTarget >= P.qsw) {
    return Math.expm1(P.b * Math.log(P.qi / qTarget)) / (P.b * P.Di);
  }
  return P.tsw + Math.log(P.qsw / qTarget) / P.Dmin;
}

function _arpsRate(t, params) { return _arpsQ(t, _arpsP(params)); }

/**
 * Arps decline curve evaluator (rate vs time).
 * @param {number|number[]} td  Production time t in DAYS (t ≥ 0).
 * @param {{qi:number, Di:number, b:number, Dmin?:number}} params  Di, Dmin in 1/day
 * @returns {number|number[]}   Rate q(t)
 */
function PRiSM_model_arps(td, params) {
  _requireNonNegT(td);
  _requireParams(params, ['qi', 'Di', 'b']);
  var P = _arpsP(params);
  return _arrayMap(td, function (t) { return _arpsQ(t, P); });
}

/**
 * t · dq/dt for Arps (≤ 0).  t · dq/dt = −t·D(t)·q(t); 0 at t = 0.
 */
function PRiSM_model_arps_pd_prime(td, params) {
  _requireNonNegT(td);
  _requireParams(params, ['qi', 'Di', 'b']);
  var P = _arpsP(params);
  return _arrayMap(td, function (t) {
    if (t === 0) return 0;
    return -t * _arpsD(t, P) * _arpsQ(t, P);
  });
}

/**
 * Closed-form Arps cumulative production from t = 0 to t_end (days),
 * Dmin-aware.  Accepts (params, t_end) or (t_end, params).
 */
function PRiSM_eur_arps(params, t_end) {
  var A = _eurArgs(params, t_end); params = A.p; t_end = A.t;
  _requireParams(params, ['qi', 'Di', 'b']);
  if (!_num(t_end) || t_end <= 0) return 0;
  var P = _arpsP(params);
  var Q = _arpsNp(t_end, P);
  if (!_num(Q) || Q < 0) {
    Q = _trapezoidalLog(function (t) { return _arpsQ(t, P); },
                        Math.max(t_end * 1e-8, 1e-8), t_end, EUR_INT_POINTS);
  }
  return Q;
}

// Public helpers (days / 1/day) for the DCA results panel.
function PRiSM_arps_q(t, params)            { return _arpsQ(t, _arpsP(params)); }
function PRiSM_arps_Np(t, params)           { return (t > 0) ? _arpsNp(t, _arpsP(params)) : 0; }
function PRiSM_arps_D(t, params)            { return _arpsD(t, _arpsP(params)); }
function PRiSM_arps_tSwitch(params)         { return _arpsP(params).tsw; }
function PRiSM_arps_timeToRate(q, params)   { return _arpsTimeToRate(q, _arpsP(params)); }
/** EUR to an economic-limit rate qAb (Dmin-aware; Infinity if never reached). */
function PRiSM_arps_eurToRate(qAb, params) {
  var P = _arpsP(params);
  var t = _arpsTimeToRate(qAb, P);
  if (!_num(t)) return (t === Infinity) ? Infinity : NaN;
  return _arpsNp(t, P);
}
/** Effective decline over a period (default 365 d): 1 − q(T)/qi for the
 *  initial segment, i.e. hyperbolic 1 − (1 + b·Di·T)^(−1/b), exp 1 − e^(−Di·T). */
function PRiSM_arps_De(params, periodDays) {
  var T = _num(periodDays) && periodDays > 0 ? periodDays : 365;
  var P = _arpsP(params);
  if (!P.ok || !(P.qi > 0)) return NaN;
  return 1 - _arpsHypQ(T, P) / P.qi;
}


// -----------------------------------------------------------------------------
// A.2 — DUONG DECLINE
// -----------------------------------------------------------------------------
//
// Reference: Duong, A.N. "Rate-Decline Analysis for Fracture-Dominated Shale
//            Reservoirs", SPE 137748, October 2011.
//
//   q(t) = q1 · t^(-m) · exp( a/(1-m) · ( t^(1-m) - 1 ) )     (t in days)
//
// For m == 1 the exponent factor → a · ln(t).
//
// Params: { q1, a, m }
//   q1 : rate at t = 1 day
//   a  : intercept of the t·D vs t plot (1/day^(1−m))
//   m  : slope of log(q/q1) vs log(t) — typically 1.0 < m < 1.5
//
// q → ∞ as t → 0, so Duong requires t > 0.  EUR is numerical.
// -----------------------------------------------------------------------------

function _duongRate(t, params) {
  var q1 = params.q1, a = params.a, m = params.m;
  if (!_num(q1) || !_num(a) || !_num(m)) return NaN;
  if (t <= 0) return q1;
  if (Math.abs(1 - m) < 1e-10) {
    return q1 * Math.pow(t, -m) * Math.exp(a * Math.log(t));
  }
  var expArg = (a / (1 - m)) * (Math.pow(t, 1 - m) - 1);
  if (!_num(expArg)) return 0;
  return q1 * Math.pow(t, -m) * Math.exp(expArg);
}

/**
 * Duong shale-decline rate evaluator.
 * @param {number|number[]} td  Production time in days (> 0).
 * @param {{q1:number, a:number, m:number}} params
 */
function PRiSM_model_duong(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['q1', 'a', 'm']);
  return _arrayMap(td, function (t) { return _duongRate(t, params); });
}

/**
 * t · dq/dt for Duong:  t · dq/dt = q · ( -m + a · t^(1-m) ).
 */
function PRiSM_model_duong_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['q1', 'a', 'm']);
  var a = params.a, m = params.m;
  return _arrayMap(td, function (t) {
    var q = _duongRate(t, params);
    return q * (-m + a * Math.pow(t, 1 - m));
  });
}

/** Duong EUR — numerical trapezoid on a log grid (days). */
function PRiSM_eur_duong(params, t_end) {
  var A = _eurArgs(params, t_end); params = A.p; t_end = A.t;
  _requireParams(params, ['q1', 'a', 'm']);
  if (!_num(t_end) || t_end <= 0) return 0;
  return _trapezoidalLog(function (t) { return _duongRate(t, params); },
                         Math.max(t_end * 1e-6, 1e-6), t_end, EUR_INT_POINTS);
}


// -----------------------------------------------------------------------------
// A.3 — STRETCHED-EXPONENTIAL PRODUCTION DECLINE (SEPD)
// -----------------------------------------------------------------------------
//
// Reference: Valko, P.P. SPE 119369, 2009.
//
//   q(t) = qi · exp( -(t/tau)^n )            (t, tau in days; q(0) = qi)
//
// EUR has a closed form via the lower incomplete gamma function:
//   Q(t_end) = qi · tau · (1/n) · γ_inc(1/n, (t_end/tau)^n)
// -----------------------------------------------------------------------------

function _sepdRate(t, params) {
  var qi = params.qi, tau = params.tau, n = params.n;
  if (!_num(qi) || !_num(tau) || tau <= 0 || !_num(n) || n <= 0) return NaN;
  if (t <= 0) return qi;
  return qi * Math.exp(-Math.pow(t / tau, n));
}

/**
 * Stretched-exponential rate evaluator (Valko 2009).  t ≥ 0 days.
 */
function PRiSM_model_sepd(td, params) {
  _requireNonNegT(td);
  _requireParams(params, ['qi', 'tau', 'n']);
  return _arrayMap(td, function (t) { return _sepdRate(t, params); });
}

/**
 * t · dq/dt for SEPD:  t · dq/dt = -q · n · (t/tau)^n  (0 at t = 0).
 */
function PRiSM_model_sepd_pd_prime(td, params) {
  _requireNonNegT(td);
  _requireParams(params, ['qi', 'tau', 'n']);
  var tau = params.tau, n = params.n;
  return _arrayMap(td, function (t) {
    if (t === 0) return 0;
    var q = _sepdRate(t, params);
    return -q * n * Math.pow(t / tau, n);
  });
}

// Lanczos ln Γ (g = 7, n = 9), accuracy ~1e-15.
function _lnGamma(z) {
  var g = 7;
  var c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
           771.32342877765313, -176.61502916214059, 12.507343278686905,
           -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - _lnGamma(1 - z);
  }
  z -= 1;
  var x = c[0];
  for (var i = 1; i < g + 2; i++) x += c[i] / (z + i);
  var t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

// Lower incomplete gamma γ(a, x) (Numerical Recipes gser / gcf).
function _lowerIncGamma(a, x) {
  if (x < 0 || a <= 0) return NaN;
  if (x === 0) return 0;
  var lng = _lnGamma(a);
  if (x < a + 1) {
    var ap = a, sum = 1 / a, del = sum;
    for (var k = 1; k < 500; k++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-14) break;
    }
    return Math.exp(-x + a * Math.log(x)) * sum;
  }
  var b = x + 1 - a;
  var FPMIN = 1e-300;
  var c = 1 / FPMIN, d = 1 / b, h = d;
  for (var i = 1; i < 500; i++) {
    var an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;  if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    var del2 = d * c;
    h *= del2;
    if (Math.abs(del2 - 1) < 1e-14) break;
  }
  var Q = Math.exp(-x + a * Math.log(x) - lng) * h;
  return Math.exp(lng) * (1 - Q);
}

/** SEPD EUR (closed form): Q = qi·tau·(1/n)·γ(1/n, (t_end/tau)^n). */
function PRiSM_eur_sepd(params, t_end) {
  var A = _eurArgs(params, t_end); params = A.p; t_end = A.t;
  _requireParams(params, ['qi', 'tau', 'n']);
  if (!_num(t_end) || t_end <= 0) return 0;
  var qi = params.qi, tau = params.tau, n = params.n;
  var arg = Math.pow(t_end / tau, n);
  var Q = qi * tau * (1 / n) * _lowerIncGamma(1 / n, arg);
  if (!_num(Q) || Q < 0) {
    Q = _trapezoidalLog(function (t) { return _sepdRate(t, params); },
                        Math.max(t_end * 1e-8, 1e-8), t_end, EUR_INT_POINTS);
  }
  return Q;
}


// -----------------------------------------------------------------------------
// A.4 — FETKOVICH TYPE CURVE
// -----------------------------------------------------------------------------
//
// References: Fetkovich, M.J. "Decline Curve Analysis Using Type Curves",
//             JPT June 1980, pp 1065-1077.  van Everdingen & Hurst (1949).
//
// Transient stems (rigorous): constant-pwf production from a well (finite
// wellbore, apparent radius rwa) centred in a closed circular reservoir,
// reD = re/rwa.  With the closed-circle constant-rate solution
//   p̄wD(s) = [I1(reD√s)K0(√s) + K1(reD√s)I0(√s)]
//            / ( s^{3/2}·[I1(reD√s)K1(√s) − K1(reD√s)I1(√s)] )
// the constant-pwf rate is q̄D(s) = 1/(s²·p̄wD(s)), inverted with Stehfest.
// Everything is evaluated with exponentially scaled Bessel functions because
// I1(reD√s) overflows for reD ≥ 1000.
//
// Fetkovich variables (using apparent radius, so skin is included):
//   qDd = qD·(ln reD − ½),   tDd = tD / (½·(reD² − 1)·(ln reD − ½))
// Depletion stems (Arps):    qDd = (1 + b·tDd)^(−1/b)   (b = 0 → exp(−tDd))
// The type curve is the rigorous transient solution for tDd ≤ 0.1, the Arps
// stem for tDd ≥ 0.3, and a C¹ smooth-step blend (in ln tDd) in between,
// which is how the published unified type curve joins the two families.
//
// Model (real time, days):   q(t) = qi · qDd(tDd = Di·t; reD, b)
// Params: { qi, Di, b, reD }  qi, Di (1/day) and b are the Arps parameters of
// the depletion stem; reD = re/rwa.  The constant-pwf transient rate is
// unbounded as t → 0, so t = 0 exactly returns qi (the Arps intercept, the
// usual start-of-production convention) and t·dq/dt = 0 there; for t > 0 the
// transient solution is evaluated with tD ≥ 0.01.
// -----------------------------------------------------------------------------

var FETK_BLEND_T0 = 0.1, FETK_BLEND_T1 = 0.3, FETK_TD_MIN = 1e-2;

function _fetkQDbar(s, reD) {
  var y = Math.sqrt(s);
  var r = 0;
  if (reD > 1) {
    var x = reD * y;
    var ex = 2 * y * (reD - 1);
    r = (ex < 700) ? (_K1e(x) / _I1e(x)) * Math.exp(-ex) : 0;
  }
  var num = _K1e(y) - r * _I1e(y);
  var den = y * (_K0e(y) + r * _I0e(y));
  return num / den;
}

/** Rigorous constant-pwf dimensionless rate qD(tD) for a closed circle. */
function PRiSM_fetkovich_qD(tD, reD) {
  var R = (_num(reD) && reD > 1.0001) ? reD : 1e12;
  return _arrayMap(tD, function (t) {
    var tt = (_num(t) && t > FETK_TD_MIN) ? t : FETK_TD_MIN;
    return _steh(function (s) { return _fetkQDbar(s, R); }, tt);
  });
}

function _fetkArpsStem(tDd, b) {
  if (!(b >= ARPS_B_EXP)) return Math.exp(-tDd);
  return Math.exp(-Math.log1p(b * tDd) / b);
}

function _fetkQDd(tDd, reD, b) {
  var R = Math.max(2, reD);
  var lnr = Math.log(R) - 0.5;
  if (!(tDd > 0)) tDd = 0;
  var stem = _fetkArpsStem(tDd, b);
  if (tDd >= FETK_BLEND_T1) return stem;
  var tDfac = 0.5 * (R * R - 1) * lnr;
  var tD = Math.max(tDd * tDfac, FETK_TD_MIN);
  var qT = _steh(function (s) { return _fetkQDbar(s, R); }, tD) * lnr;
  if (tDd <= FETK_BLEND_T0) return qT;
  var x = Math.log(tDd / FETK_BLEND_T0) / Math.log(FETK_BLEND_T1 / FETK_BLEND_T0);
  var w = x * x * (3 - 2 * x);
  return (1 - w) * qT + w * stem;
}

/**
 * Fetkovich unified type curve qDd(tDd) for re/rwa = reD and Arps stem b.
 * @param {number} reD  re/rwa (≥ 2)
 * @param {number} b    depletion-stem exponent (0 → exponential)
 * @param {number|number[]} tDd
 * @returns {number|number[]} qDd
 */
function PRiSM_fetkovich_typecurve(reD, b, tDd) {
  var R = _num(reD) ? reD : 1000, B = _num(b) ? b : 0;
  return _arrayMap(tDd, function (t) { return _fetkQDd(t, R, B); });
}

function _fetkovichRate(t, params) {
  var qi = params.qi, Di = params.Di, b = params.b, reD = params.reD;
  if (!_num(qi) || !_num(Di) || !_num(b) || !_num(reD) || Di < 0) return NaN;
  if (t === 0) return qi;   // start of production: the Arps intercept (see header)
  return qi * _fetkQDd(Di * t, reD, b);
}

/**
 * Fetkovich (1980) type-curve model.  Returns rate q(t) (t in days, ≥ 0).
 * @param {{qi:number, Di:number, b:number, reD:number}} params
 */
function PRiSM_model_fetkovich(td, params) {
  _requireNonNegT(td);
  _requireParams(params, ['qi', 'Di', 'b', 'reD']);
  return _arrayMap(td, function (t) { return _fetkovichRate(t, params); });
}

/** t · dq/dt for Fetkovich (numerical in ln t; 0 at t = 0). */
function PRiSM_model_fetkovich_pd_prime(td, params) {
  _requireNonNegT(td);
  _requireParams(params, ['qi', 'Di', 'b', 'reD']);
  return _arrayMap(td, function (t) {
    if (t === 0) return 0;
    return _numericLogDeriv(function (tt) { return _fetkovichRate(tt, params); }, t, params);
  });
}

/** Fetkovich EUR — numerical integration on a log grid (days). */
function PRiSM_eur_fetkovich(params, t_end) {
  var A = _eurArgs(params, t_end); params = A.p; t_end = A.t;
  _requireParams(params, ['qi', 'Di', 'b', 'reD']);
  if (!_num(t_end) || t_end <= 0) return 0;
  var t0 = t_end * 1e-8;
  var head = _fetkovichRate(t0, params) * t0;
  return head + _trapezoidalLog(function (t) { return _fetkovichRate(t, params); },
                                t0, t_end, EUR_INT_POINTS);
}


// =============================================================================
// SECTION B — SPECIALISED SINGLE-WELL MODELS (Phase 4)
// =============================================================================
//
// PRESSURE-vs-time models (kind: 'pressure', refLength 'rw').  They use the
// finite-wellbore well term and the negative-skin-safe WBS + skin fold above.
// pdPrime is computed from the Laplace identity (no numerical differencing).
// =============================================================================


// -----------------------------------------------------------------------------
// B.1 — DOUBLE-POROSITY RESERVOIR (Warren-Root)
// -----------------------------------------------------------------------------
//
// References:
//   Warren, J.E., Root, P.J. SPEJ Sept 1963, pp 245-255 (PSS).
//   Mavor, M.J., Cinco-Ley, H. SPE 7977 (1979).
//   Gringarten, A.C. SPE 10044 (1982).
//
//   ω (omega)  : fracture storativity ratio in (0, 1)
//   λ (lambda) : interporosity flow coefficient (∝ rw²)
//
//   'pss'  f(s) = ( ω·(1-ω)·s + λ ) / ( (1-ω)·s + λ )
//   '1dt'  f(s) = ω + (1-ω) · tanh(arg) / arg,        arg = √(3(1-ω)s/λ)
//   '3dt'  f(s) = ω + (1-ω) · 3·(arg·coth(arg) − 1)/arg², arg = √(15(1-ω)s/λ)
//
//   p̄(s) = K0(√(s·f)) / ( s·√(s·f)·K1(√(s·f)) )     (finite wellbore)
//
// Params: { Cd, S, omega, lambda, interporosityMode }
// -----------------------------------------------------------------------------

function _doublePor_f_pss(s, omega, lambda) {
  var num = omega * (1 - omega) * s + lambda;
  var den = (1 - omega) * s + lambda;
  if (den === 0 || !_num(den)) return omega;
  return num / den;
}

function _doublePor_f_1dt(s, omega, lambda) {
  if (lambda <= 0) return omega;
  var arg2 = 3 * (1 - omega) * s / lambda;
  if (arg2 <= 0) return omega;
  var arg = Math.sqrt(arg2);
  var tanhOverArg;
  if (arg > 20)        tanhOverArg = 1 / arg;
  else if (arg < 1e-4) tanhOverArg = 1 - arg * arg / 3;
  else                 tanhOverArg = Math.tanh(arg) / arg;
  return omega + (1 - omega) * tanhOverArg;
}

function _doublePor_f_3dt(s, omega, lambda) {
  if (lambda <= 0) return omega;
  var arg2 = 15 * (1 - omega) * s / lambda;
  if (arg2 <= 0) return omega;
  var arg = Math.sqrt(arg2);
  var fac;
  if (arg > 20) {
    fac = 3 * (arg - 1) / (arg * arg);                 // coth → 1
  } else if (arg < 1e-3) {
    fac = 1 - arg * arg / 15;                          // series
  } else {
    fac = 3 * (arg / Math.tanh(arg) - 1) / (arg * arg);
  }
  return omega + (1 - omega) * fac;
}

function _doublePor_f(mode, s, omega, lambda) {
  switch (mode) {
    case '1dt': return _doublePor_f_1dt(s, omega, lambda);
    case '3dt': return _doublePor_f_3dt(s, omega, lambda);
    case 'pss':
    default:    return _doublePor_f_pss(s, omega, lambda);
  }
}

function _checkDoublePor(params) {
  if (!_num(params.omega) || params.omega <= 0 || params.omega >= 1) {
    throw new Error('PRiSM doublePorosity: omega must be in (0, 1)');
  }
  if (!_num(params.lambda) || params.lambda <= 0) {
    throw new Error('PRiSM doublePorosity: lambda must be > 0');
  }
  if (params.interporosityMode &&
      ['pss', '1dt', '3dt'].indexOf(params.interporosityMode) === -1) {
    throw new Error('PRiSM doublePorosity: interporosityMode must be "pss", "1dt", or "3dt"');
  }
}

// sc = e^S under the negative-skin transform: λ ∝ rw² → λ/sc².
function _pdLap_doublePor(s, params, sc) {
  var lam = params.lambda / ((sc || 1) * (sc || 1));
  var f = _doublePor_f(params.interporosityMode || 'pss', s, params.omega, lam);
  var sf = s * f;
  if (!(sf > 0) || !_num(sf)) return 1e30;
  return _wellTerm(Math.sqrt(sf)) / s;
}

/**
 * Double-porosity reservoir (Warren-Root + Mavor-Cinco + Gringarten).
 * @param {number|number[]} td
 * @param {{Cd:number, S:number, omega:number, lambda:number,
 *          interporosityMode:('pss'|'1dt'|'3dt')}} params
 */
function PRiSM_model_doublePorosity(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'omega', 'lambda']);
  _checkDoublePor(params);
  return _evalWbsSkin(function (s, sc) { return _pdLap_doublePor(s, params, sc); },
                      td, params.Cd, params.S, false);
}

function PRiSM_model_doublePorosity_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'omega', 'lambda']);
  _checkDoublePor(params);
  return _evalWbsSkin(function (s, sc) { return _pdLap_doublePor(s, params, sc); },
                      td, params.Cd, params.S, true);
}


// -----------------------------------------------------------------------------
// B.2 — PARTIAL-PENETRATION VERTICAL WELL
// -----------------------------------------------------------------------------
//
// References: Brons, F., Marting, V.E. (1961) partial-penetration pseudo-skin;
//             Gringarten-Ramey (1974); Earlougher Monograph 5 §2.6.
//
// Three regimes: early radial flow over hp (derivative 0.5/(hp/h)),
// spherical transition, late radial over h (derivative 0.5).
//
// Kernel (phenomenological Laplace blend, unchanged in shape; the well terms
// use the finite-wellbore form so early time is storage-dominated):
//
//   p̄(s) = w·p̄_perf + (1−w)·p̄_full + w(1−w)·p̄_sph,  w = s·hp/(1 + s·hp)
//   p̄_full = K0(√s·heff)/(s·√s·K1(√s)),  p̄_perf = (1/hp)·K0(y)/(s·y·K1(y)),
//   y = √(s/hp),  p̄_sph = 0.1·√hp·exp(−α_sph·√s)/s
//
// Geometric pseudo-skin (late-time offset vs a fully penetrating well):
//   Sg = Brons-Marting(b = hp/h, hD = (h/rw)·√(kh/kv))
// h/rw comes from the injected __h_rw (default 100).  The total skin in the
// fold is S_perf + S_global + Sg; S_global is frozen by default because it is
// collinear with S_perf.
//
// Params: { Cd, S_perf, S_global, KvKh, hp_to_h, zw_to_h, h_eff }
// -----------------------------------------------------------------------------

function _partialPen_pseudoskin(params, geom) {
  var KvKh = params.KvKh, hp = params.hp_to_h;
  if (!_num(KvKh) || KvKh <= 0 || !_num(hp) || hp <= 0 || hp >= 1) return 0;
  var hD = _hOverRw(params, geom) * Math.sqrt(1 / KvKh);
  return _bronsMarting(hp, hD);
}

function _checkPartialPen(params, label) {
  var hp = params.hp_to_h, zw = params.zw_to_h, KvKh = params.KvKh;
  if (!_num(hp) || hp <= 0 || hp > 1) {
    throw new Error('PRiSM ' + label + ': hp_to_h must be in (0, 1]');
  }
  if (!_num(zw) || zw < 0 || zw > 1) {
    throw new Error('PRiSM ' + label + ': zw_to_h must be in [0, 1]');
  }
  if (!_num(KvKh) || KvKh <= 0) {
    throw new Error('PRiSM ' + label + ': KvKh must be > 0');
  }
}

// K0(y·r)/(y·K1(y)) — well-normalised line source at distance r (≥ 0.05)
function _kOverWell(y, r) {
  r = Math.max(r, 0.05);
  var ex = -y * (r - 1);
  if (ex > 700) ex = 700;
  return _K0e(y * r) / (y * _K1e(y)) * Math.exp(ex);
}

function _pdLap_partialPen(s, params) {
  var hp = params.hp_to_h;
  var zw = params.zw_to_h;
  var KvKh = params.KvKh;
  var heff = (params.h_eff != null && _num(params.h_eff)) ? params.h_eff : 1.0;
  var y = Math.sqrt(s);
  var pdFull = _kOverWell(y, Math.max(heff, 0.1)) / s;
  var pdPerf = (1 / hp) * _wellTerm(y / Math.sqrt(hp)) / s;
  var dz = zw - 0.5;
  var alphaSph = (1 / Math.sqrt(KvKh)) * (1 + 4 * dz * dz);
  var pdSph = (0.1 * Math.sqrt(hp)) * Math.exp(-alphaSph * y) / s;
  var w = (s * hp) / (1 + s * hp);
  return w * pdPerf + (1 - w) * pdFull + pdSph * (w * (1 - w));
}

function _partialPenStotal(params) {
  return (params.S_perf || 0) + (params.S_global || 0) + _partialPen_pseudoskin(params);
}

/**
 * Partial-penetration vertical well.
 * @param {number|number[]} td
 * @param {{Cd:number, S_perf:number, S_global:number, KvKh:number,
 *          hp_to_h:number, zw_to_h:number, h_eff:number, __h_rw?:number}} params
 */
function PRiSM_model_partialPen(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S_perf', 'S_global', 'KvKh', 'hp_to_h', 'zw_to_h']);
  _checkPartialPen(params, 'partialPen');
  return _evalWbsSkin(function (s) { return _pdLap_partialPen(s, params); },
                      td, params.Cd, _partialPenStotal(params), false);
}

function PRiSM_model_partialPen_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S_perf', 'S_global', 'KvKh', 'hp_to_h', 'zw_to_h']);
  _checkPartialPen(params, 'partialPen');
  return _evalWbsSkin(function (s) { return _pdLap_partialPen(s, params); },
                      td, params.Cd, _partialPenStotal(params), true);
}


// -----------------------------------------------------------------------------
// B.3 — VERTICAL PULSE-TEST
// -----------------------------------------------------------------------------
//
// Reference: Gringarten, A.C., Ramey, H.J. SPE 3818 / SPEJ Oct 1973;
//            Earlougher Monograph 5 §10; Streltsova (1988).
//
// Same geometry as B.2, pressure measured at a separate vertical point.
// Green's-function shortcut: the observation response is a line-source
// kernel at an effective distance combining the wellbore scale and the
// anisotropy-scaled vertical separation:
//
//   rEff = √(heff² + dz_eff²),  dz_eff = |zobs − zw|/√(Kv/Kh)·max(√hp, 0.1)
//   p̄(s) = K0(√s·rEff) / ( s·√s·K1(√s) )
//
// Total skin S_perf + Sg, Sg = Brons-Marting(hp/h, (h/rw)·√(kh/kv)).
//
// Params: { Cd, S_perf, KvKh, hp_to_h, zw_to_h, zobs_to_h, h_eff }
// -----------------------------------------------------------------------------

function _pdLap_verticalPulse(s, params) {
  var hp = params.hp_to_h;
  var zw = params.zw_to_h;
  var zobs = params.zobs_to_h;
  var KvKh = params.KvKh;
  var heff = (params.h_eff != null && _num(params.h_eff)) ? params.h_eff : 1.0;
  var y = Math.sqrt(s);
  var dz_eff = Math.abs(zobs - zw) / Math.sqrt(KvKh);
  dz_eff *= Math.max(Math.sqrt(hp), 0.1);
  var rEff = Math.sqrt(heff * heff + dz_eff * dz_eff);
  if (!(rEff > 0)) rEff = heff;
  return _kOverWell(y, rEff) / s;
}

function _checkVerticalPulse(params) {
  _checkPartialPen(params, 'verticalPulse');
  var zobs = params.zobs_to_h;
  if (!_num(zobs) || zobs < 0 || zobs > 1) {
    throw new Error('PRiSM verticalPulse: zobs_to_h must be in [0, 1]');
  }
}

function _verticalPulseStotal(params) {
  return (params.S_perf || 0) + _partialPen_pseudoskin(params);
}

/**
 * Vertical pulse-test — partial-penetration source observed at a separated
 * vertical point.  Green's-function shortcut, see header.
 */
function PRiSM_model_verticalPulse(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S_perf', 'KvKh', 'hp_to_h', 'zw_to_h', 'zobs_to_h']);
  _checkVerticalPulse(params);
  return _evalWbsSkin(function (s) { return _pdLap_verticalPulse(s, params); },
                      td, params.Cd, _verticalPulseStotal(params), false);
}

function PRiSM_model_verticalPulse_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S_perf', 'KvKh', 'hp_to_h', 'zw_to_h', 'zobs_to_h']);
  _checkVerticalPulse(params);
  return _evalWbsSkin(function (s) { return _pdLap_verticalPulse(s, params); },
                      td, params.Cd, _verticalPulseStotal(params), true);
}


// =============================================================================
// REGISTRY — merge into window.PRiSM_MODELS
// =============================================================================
//
// Metadata used by the physical-model wrapper (all optional):
//   refLength     'rw' — dimensionless time/distances referenced to rw
//   timeInput     'days' for the decline models (t in days, Di in 1/day)
//   defaultFrozen keys frozen by default (S_global is collinear with S_perf)
//   paramSpec[i].scale 'log' for positive, multi-decade parameters
//   pseudoSkin(params, geom) → geometric skin folded into the total skin
// =============================================================================

var REGISTRY_ADDITIONS = {

  arps: {
    pd: PRiSM_model_arps,
    pdPrime: PRiSM_model_arps_pd_prime,
    eur: PRiSM_eur_arps,
    defaults: { qi: 1000, Di: 0.05, b: 0.5 },
    paramSpec: [
      { key: 'qi', label: 'Initial rate qi',          unit: 'rate',  min: 0,    max: 1e9, default: 1000, scale: 'log' },
      { key: 'Di', label: 'Initial decline Di',       unit: '1/day', min: 0,    max: 5,   default: 0.05, scale: 'log' },
      { key: 'b',  label: 'Decline exponent b',       unit: '-',     min: 0,    max: 2,   default: 0.5  }
    ],
    optionalParams: [
      { key: 'Dmin', label: 'Terminal decline Dmin (modified hyperbolic; 0 = off)', unit: '1/day', min: 0, max: 1, default: 0 }
    ],
    timeInput: 'days',
    reference: 'Arps, J.J., Trans. AIME 160 (1945) 228-247; modified hyperbolic: Robertson (1988)',
    category: 'decline',
    description: 'Arps decline (exponential / hyperbolic / harmonic via b-factor): q(t) = qi · (1 + b·Di·t)^(-1/b), t in days. Optional Dmin switches to exponential terminal decline.',
    kind: 'rate'
  },

  duong: {
    pd: PRiSM_model_duong,
    pdPrime: PRiSM_model_duong_pd_prime,
    eur: PRiSM_eur_duong,
    defaults: { q1: 1000, a: 1.0, m: 1.2 },
    paramSpec: [
      { key: 'q1', label: 'Rate at t = 1 day q1',   unit: 'rate', min: 0,   max: 1e9, default: 1000, scale: 'log' },
      { key: 'a',  label: 'Intercept a',             unit: '-',    min: 0,   max: 10,  default: 1.0  },
      { key: 'm',  label: 'Slope m',                 unit: '-',    min: 0.5, max: 2,   default: 1.2  }
    ],
    timeInput: 'days',
    reference: 'Duong, A.N., SPE 137748 (Oct 2011)',
    category: 'decline',
    description: 'Duong shale decline: q(t) = q1·t^(-m)·exp(a/(1-m)·(t^(1-m)-1)), t in days. Fracture-dominated unconventionals.',
    kind: 'rate'
  },

  sepd: {
    pd: PRiSM_model_sepd,
    pdPrime: PRiSM_model_sepd_pd_prime,
    eur: PRiSM_eur_sepd,
    defaults: { qi: 1000, tau: 100, n: 0.5 },
    paramSpec: [
      { key: 'qi',  label: 'Initial rate qi',         unit: 'rate', min: 0,    max: 1e9, default: 1000, scale: 'log' },
      { key: 'tau', label: 'Characteristic time τ',   unit: 'day',  min: 0.1,  max: 1e6, default: 100,  scale: 'log' },
      { key: 'n',   label: 'Stretching exponent n',   unit: '-',    min: 0.05, max: 1,   default: 0.5  }
    ],
    timeInput: 'days',
    reference: 'Valko, P.P., SPE 119369 (2009)',
    category: 'decline',
    description: 'Stretched-exponential production decline (SEPD): q(t) = qi · exp(-(t/τ)^n), t in days. Shale wells.',
    kind: 'rate'
  },

  fetkovich: {
    pd: PRiSM_model_fetkovich,
    pdPrime: PRiSM_model_fetkovich_pd_prime,
    eur: PRiSM_eur_fetkovich,
    defaults: { qi: 1000, Di: 0.02, b: 0.5, reD: 1000 },
    paramSpec: [
      { key: 'qi',  label: 'Arps qi (depletion stem)',        unit: 'rate',  min: 0,   max: 1e9, default: 1000, scale: 'log' },
      { key: 'Di',  label: 'Arps Di (depletion stem)',        unit: '1/day', min: 0,   max: 5,   default: 0.02, scale: 'log' },
      { key: 'b',   label: 'Arps b (depletion stem)',         unit: '-',     min: 0,   max: 2,   default: 0.5  },
      { key: 'reD', label: 'Drainage ratio re/rwa (apparent wellbore radius, includes skin)', unit: '-', min: 5, max: 1e5, default: 1000, scale: 'log' }
    ],
    timeInput: 'days',
    reference: 'Fetkovich, M.J., JPT June 1980 pp 1065-1077; van Everdingen & Hurst (1949)',
    category: 'decline',
    description: 'Fetkovich type curve: rigorous closed-circle constant-pwf transient stems (re/rwa) joined to Arps depletion stems (qi, Di, b) at tDd 0.1–0.3. q(t) = qi·qDd(Di·t), t in days.',
    kind: 'rate'
  },

  doublePorosity: {
    pd: PRiSM_model_doublePorosity,
    pdPrime: PRiSM_model_doublePorosity_pd_prime,
    defaults: { Cd: 100, S: 0, omega: 0.1, lambda: 1e-5, interporosityMode: 'pss' },
    paramSpec: [
      { key: 'Cd',     label: 'Wellbore storage Cd',  unit: '-', min: 0,     max: 1e10,  default: 100, scale: 'log' },
      { key: 'S',      label: 'Skin S',               unit: '-', min: -7,    max: 50,    default: 0     },
      { key: 'omega',  label: 'Storativity ratio ω',  unit: '-', min: 0.001, max: 0.999, default: 0.1   },
      { key: 'lambda', label: 'Interporosity coef λ', unit: '-', min: 1e-9,  max: 1e-2,  default: 1e-5, scale: 'log' },
      { key: 'interporosityMode', label: 'Interporosity flow', unit: '',
        options: ['pss', '1dt', '3dt'], default: 'pss' }
    ],
    refLength: 'rw',
    reference: 'Warren-Root SPE 426 (1963); Mavor-Cinco SPE 7977 (1979); Gringarten SPE 10044 (1982)',
    category: 'reservoir',
    description: 'Double-porosity naturally fractured reservoir. ω = fracture storativity; λ = interporosity coupling. PSS / 1-D transient / 3-D transient matrix flow.',
    kind: 'pressure'
  },

  partialPen: {
    pd: PRiSM_model_partialPen,
    pdPrime: PRiSM_model_partialPen_pd_prime,
    defaults: { Cd: 100, S_perf: 0, S_global: 0, KvKh: 0.1, hp_to_h: 0.3, zw_to_h: 0.5, h_eff: 1.0 },
    paramSpec: [
      { key: 'Cd',       label: 'Wellbore storage Cd', unit: '-',  min: 0,     max: 1e10, default: 100, scale: 'log' },
      { key: 'S_perf',   label: 'Perforation skin',    unit: '-',  min: -7,    max: 50,   default: 0   },
      { key: 'S_global', label: 'Global skin',         unit: '-',  min: -7,    max: 50,   default: 0   },
      { key: 'KvKh',     label: 'Anisotropy Kv/Kh',    unit: '-',  min: 0.001, max: 100,  default: 0.1, scale: 'log' },
      { key: 'hp_to_h',  label: 'Perforated fraction hp/h', unit: '-', min: 0.05, max: 1, default: 0.3 },
      { key: 'zw_to_h',  label: 'Perf centre zw/h',    unit: '-',  min: 0,     max: 1,    default: 0.5 },
      { key: 'h_eff',    label: 'Effective thickness h_eff/h', unit: '-', min: 0.1, max: 5, default: 1.0 }
    ],
    refLength: 'rw',
    defaultFrozen: ['S_global'],
    pseudoSkin: function (params, geom) { return _partialPen_pseudoskin(params || {}, geom); },
    reference: 'Brons-Marting (1961) pseudo-skin; Gringarten-Ramey SPEJ Aug 1974; Earlougher Monograph 5 §2.6',
    category: 'well-type',
    description: 'Partial-penetration vertical well: perforated interval hp in thickness h. Early radial over hp, spherical transition, late radial over h. Geometric skin = Brons-Marting(hp/h, (h/rw)√(kh/kv)).',
    kind: 'pressure'
  },

  verticalPulse: {
    pd: PRiSM_model_verticalPulse,
    pdPrime: PRiSM_model_verticalPulse_pd_prime,
    defaults: { Cd: 10, S_perf: 0, KvKh: 0.1, hp_to_h: 0.3, zw_to_h: 0.5, zobs_to_h: 0.8, h_eff: 1.0 },
    paramSpec: [
      { key: 'Cd',         label: 'Obs-well storage Cd',  unit: '-',  min: 0,     max: 1e10, default: 10, scale: 'log' },
      { key: 'S_perf',     label: 'Perforation skin',     unit: '-',  min: -7,    max: 50,   default: 0   },
      { key: 'KvKh',       label: 'Anisotropy Kv/Kh',     unit: '-',  min: 0.001, max: 100,  default: 0.1, scale: 'log' },
      { key: 'hp_to_h',    label: 'Perforated fraction hp/h', unit: '-', min: 0.05, max: 1, default: 0.3 },
      { key: 'zw_to_h',    label: 'Perf centre zw/h',     unit: '-',  min: 0,     max: 1,    default: 0.5 },
      { key: 'zobs_to_h',  label: 'Obs point zobs/h',     unit: '-',  min: 0,     max: 1,    default: 0.8 },
      { key: 'h_eff',      label: 'Effective thickness h_eff/h', unit: '-', min: 0.1, max: 5, default: 1.0 }
    ],
    refLength: 'rw',
    pseudoSkin: function (params, geom) { return _partialPen_pseudoskin(params || {}, geom); },
    reference: 'Gringarten-Ramey SPE 3818 / SPEJ Oct 1973 (Green\'s functions); Streltsova (1988); Brons-Marting (1961)',
    category: 'well-type',
    description: 'Vertical pulse-test: partial-penetration source observed at a separate vertical point. Time-lag + amplitude attenuation give Kv/Kh. Green\'s-function shortcut.',
    kind: 'pressure'
  }
};


// install in window.PRiSM_MODELS, additive (never replace the registry object)
(function _installRegistry() {
  var g = _win();
  if (!g.PRiSM_MODELS) g.PRiSM_MODELS = {};
  for (var key in REGISTRY_ADDITIONS) {
    if (REGISTRY_ADDITIONS.hasOwnProperty(key)) {
      g.PRiSM_MODELS[key] = REGISTRY_ADDITIONS[key];
    }
  }
  g.PRiSM_model_arps                  = PRiSM_model_arps;
  g.PRiSM_model_arps_pd_prime         = PRiSM_model_arps_pd_prime;
  g.PRiSM_eur_arps                    = PRiSM_eur_arps;
  g.PRiSM_model_duong                 = PRiSM_model_duong;
  g.PRiSM_model_duong_pd_prime        = PRiSM_model_duong_pd_prime;
  g.PRiSM_eur_duong                   = PRiSM_eur_duong;
  g.PRiSM_model_sepd                  = PRiSM_model_sepd;
  g.PRiSM_model_sepd_pd_prime         = PRiSM_model_sepd_pd_prime;
  g.PRiSM_eur_sepd                    = PRiSM_eur_sepd;
  g.PRiSM_model_fetkovich             = PRiSM_model_fetkovich;
  g.PRiSM_model_fetkovich_pd_prime    = PRiSM_model_fetkovich_pd_prime;
  g.PRiSM_eur_fetkovich               = PRiSM_eur_fetkovich;
  g.PRiSM_fetkovich_typecurve         = PRiSM_fetkovich_typecurve;
  g.PRiSM_fetkovich_qD                = PRiSM_fetkovich_qD;
  g.PRiSM_arps_q                      = PRiSM_arps_q;
  g.PRiSM_arps_Np                     = PRiSM_arps_Np;
  g.PRiSM_arps_D                      = PRiSM_arps_D;
  g.PRiSM_arps_tSwitch                = PRiSM_arps_tSwitch;
  g.PRiSM_arps_timeToRate             = PRiSM_arps_timeToRate;
  g.PRiSM_arps_eurToRate              = PRiSM_arps_eurToRate;
  g.PRiSM_arps_De                     = PRiSM_arps_De;
  g.PRiSM_DECLINE = g.PRiSM_DECLINE || {};
  g.PRiSM_DECLINE.arpsQ          = PRiSM_arps_q;
  g.PRiSM_DECLINE.arpsNp         = PRiSM_arps_Np;
  g.PRiSM_DECLINE.arpsD          = PRiSM_arps_D;
  g.PRiSM_DECLINE.arpsTSwitch    = PRiSM_arps_tSwitch;
  g.PRiSM_DECLINE.arpsTimeToRate = PRiSM_arps_timeToRate;
  g.PRiSM_DECLINE.arpsEurToRate  = PRiSM_arps_eurToRate;
  g.PRiSM_DECLINE.arpsDe         = PRiSM_arps_De;
  g.PRiSM_DECLINE.eurArps        = PRiSM_eur_arps;
  g.PRiSM_DECLINE.eurDuong       = PRiSM_eur_duong;
  g.PRiSM_DECLINE.eurSepd        = PRiSM_eur_sepd;
  g.PRiSM_DECLINE.eurFetkovich   = PRiSM_eur_fetkovich;
  g.PRiSM_DECLINE.fetkovichTypeCurve = PRiSM_fetkovich_typecurve;
  g.PRiSM_DECLINE.fetkovichQD    = PRiSM_fetkovich_qD;
  g.PRiSM_model_doublePorosity        = PRiSM_model_doublePorosity;
  g.PRiSM_model_doublePorosity_pd_prime = PRiSM_model_doublePorosity_pd_prime;
  g.PRiSM_model_partialPen            = PRiSM_model_partialPen;
  g.PRiSM_model_partialPen_pd_prime   = PRiSM_model_partialPen_pd_prime;
  g.PRiSM_model_verticalPulse         = PRiSM_model_verticalPulse;
  g.PRiSM_model_verticalPulse_pd_prime = PRiSM_model_verticalPulse_pd_prime;
})();

})();

// ─── END 06-decline-and-specialised ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 07-data-enhancements ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// =============================================================================
// PRiSM — Layer 07 — Data Tab Enhancements (step ① Data)
// -----------------------------------------------------------------------------
// The normal Tab 1 renderer (the foundation's basic Data tab is only the
// fallback). PRiSM_renderTab(1) in 01-foundation calls
// window.PRiSM_renderDataTabEnhanced directly — no setTab wrapping, no polling.
//
//   1. Loader         — CSV / TSV / TXT / DAT / ASC / XLSX / XLS (XLSX via
//                       SheetJS lazy-loaded from CDN on first use), paste, and
//                       "Try demo data". Reading the data also makes it the
//                       active dataset (no separate "use this data" step).
//   2. Column mapper  — header words first (rate headers before any
//                       shape-based pressure guess), data shape second; per-
//                       column role picker; settings cached per header shape.
//   3. Units          — time → hours (canonical), pressure → psia, liquid
//                       rate → STB/d, gas rate → Mscf/d; units inferred from
//                       headers / date columns; psig and barg offsets.
//   4. Cleanup        — MAD / Hampel outlier masks, moving average,
//                       decimation (Nth / log-spaced / time-bin), time clip.
//   5. Preview        — role-labelled table + summary (N, range, Δt, gaps,
//                       rate periods).
//
// Dataset produced (window.PRiSM_dataset):
//   { t:[h], p:[psia]|null, q:[STB/d | Mscf/d]|null,
//     phases?:{oil,gas,water}, period?:[…], name, source,
//     timeUnit:'h', timeUnitOriginal, rateUnit, ratePhase }
// Rate-only files ({t,q}, p = null) are accepted and offer rate-only
// (decline) analysis.
//
// Exports: PRiSM_renderDataTabEnhanced, PRiSM_doParseData (= commit),
//   PRiSM_doUseData, PRiSM_loadFile(file) → Promise<dataset|null>,
//   PRiSM_datasetFromText(text, meta), PRiSM_parseTextEnhanced,
//   PRiSM_autoMapColumns, PRiSM_inferColumnUnits, PRiSM_convert*,
//   PRiSM_filter*, PRiSM_decimate*, PRiSM_loadXLSX, PRiSM_parseWorkbook.
// Events: 'prism:dataset-loaded' (through window.PRiSM_commitDataset),
//   'prism:dataset-cleared' on Clear.
//
// Persistence: 'wts_prism' (textarea, loadInputs/saveInputs pattern),
// 'wts_prism_mapping_<hash>' (mapping + units + rate phase + cleanup per
// header shape), 'wts_prism_units' (display name of the loaded text).
// =============================================================================

(function () {
    'use strict';

    // -----------------------------------------------------------------------
    // SAFE ACCESSORS — tiny shims so the self-test can run outside the host
    // page (node) without crashing on missing globals.
    // -----------------------------------------------------------------------
    var _hasDoc = (typeof document !== 'undefined');
    var _hasWin = (typeof window !== 'undefined');
    var W = _hasWin ? window : (typeof globalThis !== 'undefined' ? globalThis : {});
    var _byId = function (id) {
        if (typeof $ === 'function') return $(id);
        if (_hasDoc) return document.getElementById(id);
        return null;
    };
    var _fmt = function (n, dp) {
        if (typeof fmt === 'function') return fmt(n, dp);
        if (n == null || isNaN(n)) return '—';
        return Number(n).toFixed(dp == null ? 4 : dp);
    };
    var _save = function (key, ids) {
        if (typeof saveInputs === 'function') return saveInputs(key, ids);
    };
    var _load = function (key, ids) {
        if (typeof loadInputs === 'function') return loadInputs(key, ids);
    };
    var _ls = function () {
        try { return (typeof localStorage !== 'undefined') ? localStorage : null; } catch (e) { return null; }
    };

    // Canonical role names. Order drives the column-mapper dropdown; the
    // first entry "" means "ignore this column".
    var ROLES = [
        { v: '',        label: '— ignore —' },
        { v: 'time',    label: 'Time' },
        { v: 'pressure',label: 'Pressure' },
        { v: 'rate',    label: 'Rate' },
        { v: 'rate_o',  label: 'Oil rate' },
        { v: 'rate_g',  label: 'Gas rate' },
        { v: 'rate_w',  label: 'Water rate' },
        { v: 'period',  label: 'Period marker' }
    ];
    var ROLE_LABELS = {
        time: 'Time (h)', pressure: 'Pressure (psia)', rate: 'Rate (STB/d)',
        rate_o: 'Oil (STB/d)', rate_g: 'Gas (Mscf/d)', rate_w: 'Water (STB/d)',
        period: 'Period'
    };

    // Canonical units: hours, psia, STB/d (liquid), Mscf/d (gas).
    var TIME_UNITS = [
        { v: 'h',    label: 'hours',   factor: 1 },
        { v: 's',    label: 'seconds', factor: 1 / 3600 },
        { v: 'min',  label: 'minutes', factor: 1 / 60 },
        { v: 'd',    label: 'days',    factor: 24 },
        { v: 'date', label: 'date / time stamps', factor: null } // special-cased
    ];
    var PRESSURE_UNITS = [
        { v: 'psi',  label: 'psia',   factor: 1,           offset: 0 },
        { v: 'psig', label: 'psig',   factor: 1,           offset: 14.696 },
        { v: 'bar',  label: 'bar(a)', factor: 14.5037738,  offset: 0 },
        { v: 'barg', label: 'barg',   factor: 14.5037738,  offset: 14.696 },
        { v: 'kPa',  label: 'kPa(a)', factor: 0.145037738, offset: 0 },
        { v: 'MPa',  label: 'MPa(a)', factor: 145.037738,  offset: 0 },
        { v: 'atm',  label: 'atm',    factor: 14.6959488,  offset: 0 }
    ];
    var RATE_UNITS_LIQ = [
        { v: 'bbl/d', label: 'STB/d (bbl/d)', factor: 1 },
        { v: 'stb/d', label: 'stb/d',         factor: 1 },
        { v: 'm3/d',  label: 'm³/d',          factor: 6.28981077 },
        { v: 'L/min', label: 'L/min',         factor: 1440 * 0.00628981077 }   // 9.0573 bbl/d
    ];
    var RATE_UNITS_GAS = [
        { v: 'Mscf/d', label: 'Mscf/d',  factor: 1 },
        { v: 'MMscfd', label: 'MMscf/d', factor: 1000 },
        { v: 'scf/d',  label: 'scf/d',   factor: 1e-3 },
        { v: 'm3/d',   label: 'm³/d',    factor: 0.0353146667 }
    ];
    var DEFAULT_UNITS = { time: 'h', pressure: 'psi', rate: 'bbl/d', rate_g: 'Mscf/d' };
    var DEFAULT_CLEANUP = { filter: 'none', decim: 'none', decimN: 5, decimTarget: 200, decimBinMin: 5, tStart: '', tEnd: '' };


    // =======================================================================
    // SECTION 1 — TEXT PARSER (CSV / TSV / DAT / ASC / TXT)
    // =======================================================================
    // Returns { rows: [[numbers…], …], headers: [strings] | null, sep,
    //           dateCols: [bool per column] | null, errors: [...] }.
    //   • strips comment lines starting with #, *, !, //, ;;
    //   • respects double-quoted fields with embedded separators
    //   • keeps "(unit)" / "[unit]" header annotations for unit inference
    //   • date/time stamp columns → ms (UTC); clock columns (hh:mm[:ss]) →
    //     decimal hours with midnight roll-over
    // =======================================================================

    var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    var RE_DATE_ISO = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(.*)$/;
    var RE_DATE_DMY = /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})(.*)$/;
    var RE_DATE_MON = /^(\d{1,2})[-\s]?([A-Za-z]{3})[A-Za-z]*[-\s,]*(\d{2,4})(.*)$/;
    var RE_CLOCK = /^(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?$/;

    function _unquote(s) {
        var t = String(s == null ? '' : s).trim();
        if (t.length > 1 && t.charAt(0) === '"' && t.charAt(t.length - 1) === '"') t = t.slice(1, -1).trim();
        return t;
    }

    function _looksDate(s) {
        var t = _unquote(s);
        return RE_DATE_ISO.test(t) || RE_DATE_DMY.test(t) || (RE_DATE_MON.test(t) && !!MONTHS[(t.match(RE_DATE_MON)[2] || '').toLowerCase()]);
    }

    // Date/time cell → ms since epoch (UTC, so no daylight-saving jumps).
    function _parseDateCell(s, dayFirst) {
        var t = _unquote(s);
        var m, y, mo, d, rest = '';
        if ((m = t.match(RE_DATE_ISO))) { y = +m[1]; mo = +m[2]; d = +m[3]; rest = m[4]; }
        else if ((m = t.match(RE_DATE_DMY))) {
            var a = +m[1], b = +m[2];
            y = +m[3]; if (y < 100) y += 2000;
            if (dayFirst) { d = a; mo = b; } else { mo = a; d = b; }
            rest = m[4];
        } else if ((m = t.match(RE_DATE_MON))) {
            mo = MONTHS[m[2].toLowerCase()];
            if (!mo) return NaN;
            d = +m[1]; y = +m[3]; if (y < 100) y += 2000; rest = m[4];
        } else return NaN;
        if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return NaN;
        var hh = 0, mi = 0, ss = 0;
        var tm = rest.match(/^[T\s,]+(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?\s*(am|pm)?/i);
        if (tm) {
            hh = +tm[1]; mi = +tm[2]; ss = tm[3] ? +tm[3] : 0;
            if (tm[4]) {
                var pm = /pm/i.test(tm[4]);
                if (pm && hh < 12) hh += 12;
                if (!pm && hh === 12) hh = 0;
            }
        } else if (rest.trim() && !/^\s*(Z|[+-]\d{2}:?\d{2})?\s*$/i.test(rest)) {
            return NaN;
        }
        return Date.UTC(y, mo - 1, d, hh, mi, 0) + ss * 1000;
    }

    // Classify each column from its first data cells: 'date' | 'clock' | 'num'.
    function _columnKinds(cellRows, start) {
        var ncols = 0;
        for (var r = start; r < Math.min(cellRows.length, start + 5); r++) ncols = Math.max(ncols, cellRows[r].length);
        var kinds = new Array(ncols).fill('num');
        for (var c = 0; c < ncols; c++) {
            var dates = 0, clocks = 0, seen = 0;
            for (var r2 = start; r2 < Math.min(cellRows.length, start + 5); r2++) {
                var cell = cellRows[r2][c];
                if (cell == null || cell === '') continue;
                seen++;
                if (typeof cell === 'string' && _looksDate(cell)) dates++;
                else if (typeof cell === 'string' && RE_CLOCK.test(_unquote(cell))) clocks++;
            }
            if (seen && dates === seen) kinds[c] = 'date';
            else if (seen && clocks === seen) kinds[c] = 'clock';
        }
        return kinds;
    }

    // Day-first or month-first for a d/m/y column (day-first when ambiguous).
    function _dayFirst(cellRows, start, c) {
        for (var r = start; r < cellRows.length; r++) {
            var m = _unquote(cellRows[r][c]).match(RE_DATE_DMY);
            if (!m) continue;
            if (+m[1] > 12) return true;
            if (+m[2] > 12) return false;
        }
        return true;
    }

    // Cells → numeric rows (shared by the text and workbook paths).
    function _rowsFromCells(cellRows, start, decimalComma) {
        var kinds = _columnKinds(cellRows, start);
        var dayFirst = kinds.map(function (k, c) { return k === 'date' ? _dayFirst(cellRows, start, c) : false; });
        var expectedLen = cellRows[start] ? cellRows[start].length : 0;
        var rows = [], errors = [];
        for (var r = start; r < cellRows.length; r++) {
            var cells = cellRows[r];
            if (!cells || cells.length < 2) { errors.push('Row ' + (r + 1) + ': < 2 columns'); continue; }
            var nums = cells.map(function (cv, c) {
                if (typeof cv === 'number') return cv;
                if (kinds[c] === 'date') return _parseDateCell(cv, dayFirst[c]);
                if (kinds[c] === 'clock') {
                    var m = _unquote(cv).match(RE_CLOCK);
                    return m ? (+m[1] + (+m[2]) / 60 + (m[3] ? +m[3] / 3600 : 0)) : NaN;
                }
                return _parseNumberLoose(cv, decimalComma);
            });
            if (nums.every(function (n) { return n == null || isNaN(n); })) {
                errors.push('Row ' + (r + 1) + ': all cells non-numeric');
                continue;
            }
            while (nums.length < expectedLen) nums.push(NaN);
            if (nums.length > expectedLen) nums.length = expectedLen;
            rows.push(nums);
        }
        // Clock columns roll over at midnight → keep them increasing.
        kinds.forEach(function (k, c) {
            if (k !== 'clock') return;
            var add = 0, prev = null;
            rows.forEach(function (row) {
                var v = row[c];
                if (!isFinite(v)) return;
                if (prev != null && v + add < prev - 12) add += 24;
                row[c] = v + add;
                prev = row[c];
            });
        });
        var dateCols = kinds.map(function (k) { return k === 'date'; });
        return { rows: rows, errors: errors, dateCols: dateCols.some(Boolean) ? dateCols : null, kinds: kinds };
    }

    function _isHeaderCell(cell) {
        if (typeof cell === 'number') return false;
        var s = _unquote(cell);
        var stripped = s.replace(/[\(\[].*?[\)\]]/g, '').trim();
        if (!stripped.length) return true;
        if (_looksDate(stripped) || RE_CLOCK.test(stripped)) return false;
        return isNaN(parseFloat(stripped));
    }

    function PRiSM_parseTextEnhanced(text) {
        if (typeof text !== 'string') return { rows: [], headers: null, sep: 'n/a', dateCols: null, errors: ['Empty input'] };

        // Strip BOM + normalise line endings.
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        var rawLines = text.split(/\r\n|\r|\n/);

        // Filter comments + empty lines.
        var lines = [];
        for (var i = 0; i < rawLines.length; i++) {
            var ln = rawLines[i].trim();
            if (!ln.length) continue;
            if (ln.charAt(0) === '#' || ln.charAt(0) === '*' ||
                ln.charAt(0) === '!' || ln.indexOf('//') === 0 ||
                ln.indexOf(';;') === 0) continue;
            lines.push(ln);
        }
        if (!lines.length) return { rows: [], headers: null, sep: 'n/a', dateCols: null, errors: ['Empty input'] };

        // Detect the separator from the first 5 lines — highest consistent
        // column count wins. Whitespace is tried last because date/time
        // stamps contain spaces.
        var candidates = [
            { name: 'tab',       re: /\t/ },
            { name: 'comma',     re: /,/ },
            { name: 'semicolon', re: /;/ },
            { name: 'pipe',      re: /\|/ },
            { name: 'whitespace',re: /\s+/ }
        ];
        var sample = lines.slice(0, Math.min(5, lines.length));
        var bestSep = null, bestScore = -1;
        for (var c = 0; c < candidates.length; c++) {
            var cand = candidates[c];
            var counts = sample.map(function (l) {
                return _splitRespectQuotes(l, cand.re).length;
            });
            if (counts.some(function (n) { return n < 2; })) continue;
            var avg = counts.reduce(function (a, b) { return a + b; }, 0) / counts.length;
            var consistent = counts.every(function (n) { return n === counts[0]; });
            var score = avg + (consistent ? 0.5 : 0);
            // "0,01;3861,4": semicolon-separated with decimal commas.
            if (cand.name === 'semicolon' && consistent && sample.every(function (l) { return l.indexOf(';') >= 0; })) score += 100;
            if (cand.name === 'whitespace' && bestSep) score = -1;   // only as a last resort
            if (score > bestScore) { bestScore = score; bestSep = cand; }
        }
        if (!bestSep) {
            return { rows: [], headers: null, sep: 'n/a', dateCols: null, errors: ['Could not detect a column separator'] };
        }

        var parsed = lines.map(function (l) {
            return _splitRespectQuotes(l, bestSep.re).map(function (s) { return s.trim(); });
        });

        // Header: the first row counts as a header if any cell is neither a
        // number nor a date / clock stamp. "0(s)" still counts as numeric.
        var first = parsed[0];
        var headers = null;
        var dataStart = 0;
        if (first.some(_isHeaderCell)) {
            headers = first.map(_unquote);
            dataStart = 1;
        }

        var built = _rowsFromCells(parsed, dataStart, bestSep.name !== 'comma');
        return { rows: built.rows, headers: headers, sep: bestSep.name, dateCols: built.dateCols, errors: built.errors };
    }

    // Split a single line respecting double-quoted fields. The separator may
    // be a regex; we don't try to be a full RFC-4180 parser, just handle the
    // common spreadsheet-export patterns. Empty fields ("1,,3") are kept so
    // later columns do not shift; only whitespace-separated lines drop them.
    function _splitRespectQuotes(line, sep) {
        var ws = sep && sep.source === '\\s+';
        var keep = function (arr) { return ws ? arr.filter(function (s) { return s.length > 0; }) : arr; };
        if (line.indexOf('"') < 0) {
            return keep(line.split(sep).map(function (s) { return s.trim(); }));
        }
        var out = [];
        var cur = '';
        var inQuote = false;
        for (var i = 0; i < line.length; i++) {
            var ch = line.charAt(i);
            if (ch === '"') {
                if (inQuote && line.charAt(i + 1) === '"') { cur += '"'; i++; }
                else inQuote = !inQuote;
                continue;
            }
            if (!inQuote) {
                var rest = line.slice(i);
                var m = rest.match(sep);
                if (m && m.index === 0) {
                    out.push(cur.trim());
                    cur = '';
                    i += m[0].length - 1;
                    continue;
                }
            }
            cur += ch;
        }
        out.push(cur.trim());
        return keep(out);
    }

    // Parse a number that might have a trailing unit ("12.3 psi") or commas
    // as thousands separators ("1,234.5"). decimalComma (files whose column
    // separator is not a comma) reads "3861,4" as 3861.4.
    function _parseNumberLoose(s, decimalComma) {
        if (s == null) return NaN;
        var t = String(s).trim();
        if (!t.length) return NaN;
        if (t.charAt(0) === '"' && t.charAt(t.length - 1) === '"') t = t.slice(1, -1);
        if (decimalComma) {
            var dm = t.match(/^([\-\+]?\d+,\d+(?:[eE][\-\+]?\d+)?)\s*[a-zA-Z%/³²]*$/);
            if (dm) return parseFloat(dm[1].replace(',', '.'));
        }
        var m = t.match(/^([\-\+]?\d[\d,]*(?:\.\d+)?(?:[eE][\-\+]?\d+)?)\s*[a-zA-Z%/³²]*$/);
        if (m) return parseFloat(m[1].replace(/,/g, ''));
        return parseFloat(t);
    }


    // =======================================================================
    // SECTION 2 — XLSX LOADER (lazy via CDN)
    // =======================================================================
    // Loads SheetJS once on first XLSX upload; caches on window.XLSX. If the
    // load fails (offline iOS), shows a friendly notice and asks for CSV.
    // =======================================================================

    var _xlsxLoadPromise = null;
    function PRiSM_loadXLSX() {
        if (!_hasWin || !_hasDoc) return Promise.reject(new Error('No window'));
        if (window.XLSX) return Promise.resolve(window.XLSX);
        if (_xlsxLoadPromise) return _xlsxLoadPromise;
        _xlsxLoadPromise = new Promise(function (resolve, reject) {
            try {
                var s = document.createElement('script');
                s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
                s.async = true;
                s.onload = function () {
                    if (window.XLSX) resolve(window.XLSX);
                    else reject(new Error('XLSX failed to register on window'));
                };
                s.onerror = function () { _xlsxLoadPromise = null; reject(new Error('Network blocked SheetJS')); };
                document.head.appendChild(s);
            } catch (e) {
                _xlsxLoadPromise = null;
                reject(e);
            }
        });
        return _xlsxLoadPromise;
    }

    // Parse a workbook ArrayBuffer with SheetJS. Returns
    // { sheets: [{name, rows, headers, dateCols}], defaultIdx }.
    function PRiSM_parseWorkbook(arrayBuffer) {
        if (!window.XLSX) throw new Error('XLSX not loaded');
        var wb = window.XLSX.read(arrayBuffer, { type: 'array' });
        var out = [];
        wb.SheetNames.forEach(function (name) {
            var ws = wb.Sheets[name];
            var aoa = window.XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
            aoa = aoa.filter(function (r) {
                return r.some(function (c) { return c !== '' && c != null; });
            });
            if (!aoa.length) {
                out.push({ name: name, rows: [], headers: null, dateCols: null, empty: true });
                return;
            }
            var first = aoa[0];
            var headerLikely = first.some(function (cell) { return cell === '' || cell == null || _isHeaderCell(cell); });
            var headers = headerLikely ? first.map(function (c) { return String(c == null ? '' : c); }) : null;
            var cells = aoa.map(function (r) { return r.map(function (c) { return (typeof c === 'number') ? c : String(c == null ? '' : c); }); });
            var built = _rowsFromCells(cells, headerLikely ? 1 : 0);
            out.push({ name: name, rows: built.rows, headers: headers, dateCols: built.dateCols, empty: built.rows.length === 0 });
        });
        var def = out.findIndex(function (s) { return !s.empty; });
        if (def < 0) def = 0;
        return { sheets: out, defaultIdx: def };
    }


    // =======================================================================
    // SECTION 3 — COLUMN AUTO-MAPPER + UNIT INFERENCE
    // =======================================================================
    // Header words decide first. A column whose header names a rate is never
    // taken as pressure by shape; shape scoring only applies to columns with
    // no recognisable header (or to header-less files).
    // =======================================================================

    var RE_EXCL   = /\b(gor|glr|wor|cut|wc|wcut|watercut|ratio|bsw|api|temp|temperature|choke|density|sg|salinity|depth|tvd|comments?|notes?|flag|status|cum|cumulative|np|gp|wp|volume|total)\b/;
    var RE_PERIOD = /\b(period|stage|interval|event|flowperiod)\b/;
    var RE_TIME   = /\b(time|t|elapsed|etime|hours?|hrs?|hr|h|minutes?|mins?|seconds?|secs?|days?|date|datetime|timestamp|dt|delta t|epoch)\b/;
    var RE_PRES   = /\b(p|pres|press|pressure|pwf|pws|pwh|bhp|fbhp|sbhp|bhfp|whp|fwhp|swhp|thp|ftp|psia?|psig|barg?|bara|kpa|mpa|gauge|gage|bottomhole)\b/;
    var RE_PRES_BH = /\b(p|pwf|pws|bhp|fbhp|sbhp|bhfp|bottomhole|gauge|gage)\b/;
    var RE_RATE   = /\b(rate|q|flow|flowrate|prod|production|liquid|liq|ql|qliq|qt|bpd|bfpd|blpd|stbd|stb|bbl|m3d)\b/;
    var RE_OIL    = /\b(qo|oil|bopd|stbo)\b/;
    var RE_GAS    = /\b(qg|gas|mscf|mscfd|mmscf|mmscfd|scf|scfd|mcf|mcfd|mmcfd)\b/;
    var RE_WAT    = /\b(qw|water|wat|bwpd)\b/;

    // Header → {raw, words, unit}: unit = text inside ()/[]; words = the rest,
    // camelCase split, lower-cased, punctuation → spaces, Δ → "delta ".
    function _normHeader(h) {
        var raw = String(h == null ? '' : h);
        var um = raw.match(/[\(\[]([^\)\]]*)[\)\]]/);
        var unit = um ? um[1].toLowerCase().replace(/\s+/g, ' ').trim() : '';
        var words = raw.replace(/[\(\[].*?[\)\]]/g, ' ')
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .toLowerCase()
            .replace(/[δΔ]/g, 'delta ')
            .replace(/[_\-.,:;\/\\|#*+=~]+/g, ' ')
            .replace(/\s+/g, ' ').trim();
        return { raw: raw, words: words, unit: unit };
    }

    // Header → role scores ({} when unrecognised, {ignore:1} for
    // non-rate/pressure quantities such as GOR or water cut).
    function _headerRoles(h) {
        var w = _normHeader(h).words;
        if (!w) return {};
        if (RE_EXCL.test(w)) return { ignore: 1 };
        if (RE_PERIOD.test(w)) return { period: 10 };
        var isT = RE_TIME.test(w), isP = RE_PRES.test(w), isR = RE_RATE.test(w);
        var isO = RE_OIL.test(w), isG = RE_GAS.test(w), isW = RE_WAT.test(w);
        var anyRate = isR || isO || isG || isW;
        var s = {};
        if (/\b(time|date|datetime|timestamp)\b/.test(w) || (isT && !isP && !anyRate)) { s.time = 10; return s; }
        if (isP && !isR) { s.pressure = RE_PRES_BH.test(w) ? 11 : 9; return s; }
        if (isO) s.rate_o = 12;
        if (isG) s.rate_g = 12;
        if (isW) s.rate_w = 12;
        if (isR) s.rate = 10;
        return s;
    }

    // Data-shape scores for a column (used only without a header match).
    function _shapeScore(col) {
        var s = {};
        var clean = col.filter(function (v) { return isFinite(v); });
        if (clean.length < 2) return s;
        var n = clean.length;
        var min = Math.min.apply(null, clean), max = Math.max.apply(null, clean);
        var mono = true;
        for (var i = 1; i < clean.length; i++) {
            if (clean[i] < clean[i - 1] - 1e-12) { mono = false; break; }
        }
        if (mono && (max - min) > 0) s.time = 3;
        var zeros = clean.filter(function (v) { return Math.abs(v) < 1e-12; }).length;
        var positives = clean.filter(function (v) { return v > 0; }).length;
        if (zeros >= 0.05 * n && positives >= 0.3 * n) s.rate = 2;
        var uniques = new Set(clean.map(function (v) { return Math.round(v * 100) / 100; })).size;
        if (min >= 0.1 && max <= 1e6 && uniques > Math.min(50, n / 4)) s.pressure = 2;
        if (uniques <= 10 && Number.isInteger(min) && Number.isInteger(max)) s.period = 1;
        return s;
    }

    function PRiSM_autoMapColumns(headers, rows, dateCols) {
        rows = rows || [];
        var ncols = (rows[0]) ? rows[0].length : (headers ? headers.length : 0);
        var map = new Array(ncols).fill('');
        if (!ncols) return map;
        var hs = [], ss = [], known = [];
        for (var c = 0; c < ncols; c++) {
            var h = headers ? _headerRoles(headers[c]) : {};
            if (dateCols && dateCols[c]) h = { time: 11 };
            hs.push(h);
            known.push(Object.keys(h).length > 0);
            ss.push(_shapeScore(rows.map(function (r) { return r[c]; })));
        }
        var taken = new Array(ncols).fill(false);
        var best = function (scoreFn) {
            var bc = -1, bs = 0;
            for (var c2 = 0; c2 < ncols; c2++) {
                if (taken[c2]) continue;
                var s = scoreFn(c2) || 0;
                if (s > bs) { bs = s; bc = c2; }
            }
            return bc;
        };
        var assign = function (c3, role) {
            if (c3 < 0) return false;
            map[c3] = role; taken[c3] = true;
            return true;
        };
        var has = function (roles) { return map.some(function (r) { return roles.indexOf(r) !== -1; }); };

        // 1. Time — header, else the monotone column among unrecognised ones.
        if (!assign(best(function (k) { return hs[k].time; }), 'time')) {
            assign(best(function (k) { return known[k] ? 0 : ss[k].time; }), 'time');
        }
        // 2. Rates named in headers — phase-specific first, then generic.
        ['rate_o', 'rate_g', 'rate_w'].forEach(function (r) { assign(best(function (k) { return hs[k][r]; }), r); });
        assign(best(function (k) { return hs[k].rate; }), 'rate');
        // 3. Pressure — header, else shape among unrecognised columns that do
        //    not look more like a rate.
        if (!assign(best(function (k) { return hs[k].pressure; }), 'pressure')) {
            assign(best(function (k) {
                if (known[k]) return 0;
                var p = ss[k].pressure || 0, r = ss[k].rate || 0;
                return p > r ? p : 0;
            }), 'pressure');
        }
        // 4. Rate by shape (unrecognised columns) when no rate is mapped yet.
        if (!has(['rate', 'rate_o', 'rate_g', 'rate_w'])) {
            assign(best(function (k) { return known[k] ? 0 : ss[k].rate; }), 'rate');
        }
        // 5. Period marker — header only.
        assign(best(function (k) { return hs[k].period; }), 'period');
        // 6. Header-less files keep the classic order time, pressure, rate.
        if (!headers) {
            if (!has(['time']) && !taken[0]) assign(0, 'time');
            if (!has(['pressure']) && ncols > 1 && !taken[1] && !has(['rate', 'rate_o', 'rate_g', 'rate_w'])) assign(1, 'pressure');
            if (!has(['rate', 'rate_o', 'rate_g', 'rate_w']) && ncols > 2 && !taken[2]) assign(2, 'rate');
        }
        if (!has(['time']) && !taken[0] && !known[0]) assign(0, 'time');
        return map;
    }

    // Unit hints from one header ("time (d)", "BHP psig", "Gas (MMscf/d)").
    function _unitHints(header) {
        var n = _normHeader(header);
        var u = n.unit, w = n.words, all = (u + ' ' + w).trim();
        var hint = {};
        if (/\b(date|datetime|timestamp)\b/.test(w)) hint.time = 'date';
        else if (/\b(days?|d)\b/.test(u) || /\bdays?\b/.test(w)) hint.time = 'd';
        else if (/\b(hours?|hrs?|hr|h)\b/.test(u) || /\b(hours?|hrs?)\b/.test(w)) hint.time = 'h';
        else if (/\b(minutes?|mins?|min)\b/.test(u) || /\b(minutes?|mins?)\b/.test(w)) hint.time = 'min';
        else if (/\b(seconds?|secs?|sec|s)\b/.test(u) || /\b(seconds?|secs?)\b/.test(w)) hint.time = 's';
        if (/\bpsig\b/.test(all)) hint.pressure = 'psig';
        else if (/\bpsia?\b/.test(all)) hint.pressure = 'psi';
        else if (/\bbarg\b/.test(all)) hint.pressure = 'barg';
        else if (/\bbara?\b/.test(all)) hint.pressure = 'bar';
        else if (/\bkpa\b/.test(all)) hint.pressure = 'kPa';
        else if (/\bmpa\b/.test(all)) hint.pressure = 'MPa';
        else if (/\batm\b/.test(all)) hint.pressure = 'atm';
        if (/\bmmscf|\bmmcf/.test(all)) hint.rateGas = 'MMscfd';
        else if (/\bmscf|\bmcf/.test(all)) hint.rateGas = 'Mscf/d';
        else if (/\bscf/.test(all)) hint.rateGas = 'scf/d';
        if (/\b(s?m3|m³)/.test(all)) { hint.rateLiq = 'm3/d'; if (!hint.rateGas) hint.rateGasM3 = true; }
        else if (/\b(bbl|stb|bopd|bwpd|bpd|bfpd|blpd|stbd)\b/.test(all)) hint.rateLiq = 'bbl/d';
        else if (/\b(l min|lpm)\b/.test(all) || /\bl\/min\b/.test(u)) hint.rateLiq = 'L/min';
        return hint;
    }

    // Units implied by the headers of the mapped columns.
    // → { units:{time?,pressure?,rate?,rate_g?}, source:{…:'header'|'data'},
    //     genericIsGas:bool }
    function PRiSM_inferColumnUnits(headers, mapping, dateCols) {
        var units = {}, source = {}, genericIsGas = false;
        (mapping || []).forEach(function (role, c) {
            if (!role) return;
            var hint = headers ? _unitHints(headers[c]) : {};
            if (role === 'time') {
                if (dateCols && dateCols[c]) { units.time = 'date'; source.time = 'data'; }
                else if (hint.time) { units.time = hint.time; source.time = 'header'; }
            } else if (role === 'pressure') {
                if (hint.pressure && !units.pressure) { units.pressure = hint.pressure; source.pressure = 'header'; }
            } else if (role === 'rate_g') {
                if (hint.rateGas && !units.rate_g) { units.rate_g = hint.rateGas; source.rate_g = 'header'; }
                else if (hint.rateGasM3 && !units.rate_g) { units.rate_g = 'm3/d'; source.rate_g = 'header'; }
            } else if (role === 'rate' && hint.rateGas && !hint.rateLiq) {
                genericIsGas = true;
                if (!units.rate_g) { units.rate_g = hint.rateGas; source.rate_g = 'header'; }
            } else if (role === 'rate' || role === 'rate_o' || role === 'rate_w') {
                if (hint.rateLiq && !units.rate) { units.rate = hint.rateLiq; source.rate = 'header'; }
            }
        });
        return { units: units, source: source, genericIsGas: genericIsGas };
    }

    // FNV-1a 32-bit.
    function _fnv(s) {
        var h = 0x811C9DC5;
        for (var i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = (h * 0x01000193) >>> 0;
        }
        return h.toString(16);
    }

    // Hash a header signature so settings can be kept per file shape.
    function _headerHash(headers, ncols) {
        var s = (headers || []).slice(0, ncols).map(function (h) {
            return String(h || '').toLowerCase().trim();
        }).join('|') + '#' + ncols;
        return _fnv(s);
    }


    // =======================================================================
    // SECTION 4 — UNIT CONVERSION + DATE PARSING
    // =======================================================================

    function PRiSM_convertTime(rawCol, unit) {
        // Returns { hours: [...], factor: number, fromDate: bool }.
        var u = TIME_UNITS.find(function (x) { return x.v === unit; }) || TIME_UNITS[0];
        if (u.v === 'date') {
            // Numbers: Excel serial days (25 500 – 80 000) or ms since epoch;
            // strings: Date.parse. Hours are measured from the earliest stamp.
            var ms = rawCol.map(function (v) {
                if (typeof v === 'number' && isFinite(v)) {
                    if (v > 25500 && v < 80000) return (v - 25569) * 86400000;
                    return v;
                }
                var t = Date.parse(v);
                return isFinite(t) ? t : NaN;
            });
            var origin = Infinity;
            for (var i = 0; i < ms.length; i++) if (isFinite(ms[i]) && ms[i] < origin) origin = ms[i];
            if (!isFinite(origin)) return { hours: rawCol.slice(), factor: 1, fromDate: true, error: 'no parseable dates' };
            var hours = ms.map(function (m) { return (m - origin) / 3600000; });
            return { hours: hours, factor: 1 / 3600000, fromDate: true, originMs: origin };
        }
        return {
            hours: rawCol.map(function (v) { return v * u.factor; }),
            factor: u.factor,
            fromDate: false
        };
    }

    function PRiSM_convertPressure(col, unit) {
        var u = PRESSURE_UNITS.find(function (x) { return x.v === unit; }) || PRESSURE_UNITS[0];
        return { values: col.map(function (v) { return v * u.factor + u.offset; }), factor: u.factor, offset: u.offset };
    }

    function PRiSM_convertRate(col, unit, isGas) {
        var arr = isGas ? RATE_UNITS_GAS : RATE_UNITS_LIQ;
        var u = arr.find(function (x) { return x.v === unit; }) || arr[0];
        return { values: col.map(function (v) { return v * u.factor; }), factor: u.factor };
    }


    // =======================================================================
    // SECTION 5 — FILTERS & DECIMATION
    // =======================================================================

    // MAD-based outlier rejection. Keeps points within k median-absolute-
    // deviations of the median. Default k = 5 (conservative).
    function PRiSM_filterMAD(values, k) {
        if (k == null) k = 5;
        var n = values.length;
        if (n < 5) return new Array(n).fill(true);
        var sorted = values.slice().filter(function (v) { return isFinite(v); }).sort(function (a, b) { return a - b; });
        var median = sorted[Math.floor(sorted.length / 2)];
        var devs = sorted.map(function (v) { return Math.abs(v - median); }).sort(function (a, b) { return a - b; });
        var mad = devs[Math.floor(devs.length / 2)] || 1e-9;
        var thresh = k * 1.4826 * mad; // 1.4826 = scale to σ for normal data
        return values.map(function (v) { return Math.abs(v - median) <= thresh; });
    }

    // Moving average (low-pass). Returns a NEW array same length; edge points
    // use shorter windows.
    function PRiSM_filterMovingAvg(values, win) {
        if (win == null) win = 5;
        var half = Math.floor(win / 2);
        var n = values.length;
        var out = new Array(n);
        for (var i = 0; i < n; i++) {
            var sum = 0, ct = 0;
            for (var j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) {
                if (isFinite(values[j])) { sum += values[j]; ct++; }
            }
            out[i] = ct ? sum / ct : values[i];
        }
        return out;
    }

    // Hampel filter — windowed MAD-based outlier mask (true = keep).
    function PRiSM_filterHampel(values, win, k) {
        if (win == null) win = 7;
        if (k == null) k = 3;
        var half = Math.floor(win / 2);
        var n = values.length;
        var keep = new Array(n).fill(true);
        for (var i = 0; i < n; i++) {
            var wnd = [];
            for (var j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) {
                if (isFinite(values[j])) wnd.push(values[j]);
            }
            if (wnd.length < 3) continue;
            wnd.sort(function (a, b) { return a - b; });
            var med = wnd[Math.floor(wnd.length / 2)];
            var devs = wnd.map(function (v) { return Math.abs(v - med); }).sort(function (a, b) { return a - b; });
            var mad = devs[Math.floor(devs.length / 2)] || 1e-9;
            if (Math.abs(values[i] - med) > k * 1.4826 * mad) keep[i] = false;
        }
        return keep;
    }

    // Decimation: every Nth point.
    function PRiSM_decimateNth(times, indices, N) {
        if (N == null || N < 2) return indices.slice();
        var out = [];
        for (var i = 0; i < indices.length; i += N) out.push(indices[i]);
        if (out[out.length - 1] !== indices[indices.length - 1]) out.push(indices[indices.length - 1]);
        return out;
    }

    // Decimation: log-spaced — pick approximately N indices whose times are
    // roughly log-uniform. Always preserves first + last index.
    function PRiSM_decimateLog(times, indices, target) {
        if (target == null || indices.length <= target) return indices.slice();
        var t0 = times[indices[0]], tN = times[indices[indices.length - 1]];
        var offset = 0;
        if (t0 <= 0) {
            var minPos = Infinity;
            for (var i = 0; i < indices.length; i++) {
                var v = times[indices[i]];
                if (v > 0 && v < minPos) minPos = v;
            }
            offset = (minPos === Infinity) ? 1 : minPos / 2;
        }
        var lo = Math.log(t0 + offset || 1e-12);
        var hi = Math.log(tN + offset);
        var picked = [];
        var seen = new Set();
        for (var k = 0; k < target; k++) {
            var lt = lo + (hi - lo) * (k / (target - 1));
            var tt = Math.exp(lt) - offset;
            var bestIdx = 0, bestD = Infinity;
            for (var j = 0; j < indices.length; j++) {
                var d = Math.abs(times[indices[j]] - tt);
                if (d < bestD) { bestD = d; bestIdx = j; }
            }
            if (!seen.has(bestIdx)) { seen.add(bestIdx); picked.push(indices[bestIdx]); }
        }
        if (picked[0] !== indices[0]) picked.unshift(indices[0]);
        if (picked[picked.length - 1] !== indices[indices.length - 1]) picked.push(indices[indices.length - 1]);
        picked.sort(function (a, b) { return a - b; });
        return picked;
    }

    // Decimation: time-bin (1 sample per X minutes). Keeps the first sample
    // in each bin window.
    function PRiSM_decimateTimeBin(times, indices, binMinutes) {
        if (binMinutes == null || binMinutes <= 0) return indices.slice();
        var binHours = binMinutes / 60;
        var out = [];
        var lastBin = -Infinity;
        for (var i = 0; i < indices.length; i++) {
            var t = times[indices[i]];
            var bin = Math.floor(t / binHours);
            if (bin > lastBin) { out.push(indices[i]); lastBin = bin; }
        }
        if (out[out.length - 1] !== indices[indices.length - 1]) out.push(indices[indices.length - 1]);
        return out;
    }


    // =======================================================================
    // SECTION 6 — STATE + PERSISTENCE
    // =======================================================================

    var _st = null;
    function _getState() {
        if (!_st) {
            _st = {
                source: null,        // 'paste' | 'workbook'
                fileName: null,
                workbook: null,      // {sheets, defaultIdx}
                sheetIdx: 0,
                rawRows: null,
                headers: null,
                dateCols: null,
                mapping: null,       // [role per column]
                hash: null,
                units: Object.assign({}, DEFAULT_UNITS),
                unitSource: {},
                genericIsGas: false,
                ratePhase: 'auto',
                cleanup: Object.assign({}, DEFAULT_CLEANUP),
                lastApplied: null,   // last built dataset (preview)
                sorted: false,
                errors: []
            };
        }
        return _st;
    }

    function _resetState() { _st = null; return _getState(); }

    function _loadShapeSettings(hash) {
        var ls = _ls();
        if (!ls || !hash) return null;
        try {
            var raw = ls.getItem('wts_prism_mapping_' + hash);
            if (!raw) return null;
            var o = JSON.parse(raw);
            if (Array.isArray(o)) return { mapping: o };      // older builds stored the mapping only
            return (o && typeof o === 'object') ? o : null;
        } catch (e) { return null; }
    }

    function _saveShapeSettings(st) {
        var ls = _ls();
        if (!ls || !st.hash) return;
        try {
            ls.setItem('wts_prism_mapping_' + st.hash, JSON.stringify({
                v: 2, mapping: st.mapping, units: st.units, ratePhase: st.ratePhase, cleanup: st.cleanup
            }));
        } catch (e) { /* ignore */ }
    }

    // Display name of a text (file name / "Demo data"), kept by content hash.
    function _rememberName(text, name) {
        var st = _getState();
        st.nameFor = { hash: _fnv(String(text || '')), name: name };
        var ls = _ls();
        if (ls) { try { ls.setItem('wts_prism_units', JSON.stringify({ v: 2, name: name, hash: st.nameFor.hash })); } catch (e) { /* ignore */ } }
    }
    function _nameForText(text) {
        var st = _getState();
        var h = _fnv(String(text || ''));
        if (st.nameFor && st.nameFor.hash === h) return st.nameFor.name;
        var ls = _ls();
        if (ls) {
            try {
                var o = JSON.parse(ls.getItem('wts_prism_units') || 'null');
                if (o && o.hash === h && o.name) { st.nameFor = { hash: h, name: o.name }; return o.name; }
            } catch (e) { /* ignore */ }
        }
        return null;
    }

    // Persist the Data-tab text without needing the textarea on screen.
    function _persistText(text) {
        var ls = _ls();
        if (!ls) return;
        try {
            var o = {};
            var raw = ls.getItem('wts_prism');
            if (raw) { try { o = JSON.parse(raw); } catch (e) { o = {}; } }
            if (!o || typeof o !== 'object' || Array.isArray(o)) o = {};
            o.prism_data_paste = String(text == null ? '' : text);
            ls.setItem('wts_prism', JSON.stringify(o));
        } catch (e) { /* ignore */ }
    }

    // Adopt parsed rows into the state: mapping (cached per header shape or
    // auto), units (cached, else inferred from headers), rate phase, cleanup.
    function _adoptRows(st, rows, headers, dateCols, errors) {
        st.rawRows = rows;
        st.headers = headers || null;
        st.dateCols = dateCols || null;
        st.errors = errors || [];
        var ncols = rows[0] ? rows[0].length : (headers ? headers.length : 0);
        st.hash = _headerHash(st.headers, ncols);
        var saved = _loadShapeSettings(st.hash);
        var auto = PRiSM_autoMapColumns(st.headers, rows, st.dateCols);
        st.mapping = (saved && Array.isArray(saved.mapping) && saved.mapping.length === ncols) ? saved.mapping.slice() : auto;
        var inf = PRiSM_inferColumnUnits(st.headers, st.mapping, st.dateCols);
        st.units = Object.assign({}, DEFAULT_UNITS, inf.units, (saved && saved.units) || {});
        st.unitSource = Object.assign({}, inf.source);
        if (saved && saved.units) Object.keys(saved.units).forEach(function (k) { st.unitSource[k] = 'saved'; });
        st.genericIsGas = !!inf.genericIsGas;
        st.ratePhase = (saved && saved.ratePhase) || 'auto';
        st.cleanup = Object.assign({}, DEFAULT_CLEANUP, (saved && saved.cleanup) || {});
    }

    function _adoptText(text) {
        var st = _getState();
        var res = PRiSM_parseTextEnhanced(String(text == null ? '' : text));
        if (!res.rows.length) { st.parseErrors = res.errors; return false; }
        st.source = 'paste';
        st.workbook = null;
        st.sheetIdx = 0;
        st.sep = res.sep;
        _adoptRows(st, res.rows, res.headers, res.dateCols, res.errors);
        return true;
    }

    function _adoptSheet(st) {
        var s = st.workbook && st.workbook.sheets[st.sheetIdx];
        if (!s) return false;
        _adoptRows(st, s.rows.slice(), s.headers ? s.headers.slice() : null, s.dateCols, []);
        return s.rows.length > 0;
    }

    // Make ds the active dataset (single commit path in 01-foundation).
    function _commit(ds, source) {
        if (typeof W.PRiSM_commitDataset === 'function') return W.PRiSM_commitDataset(ds, { source: source });
        W.PRiSM_dataset = ds;
        try {
            if (typeof W.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
                W.dispatchEvent(new CustomEvent('prism:dataset-loaded', { detail: { source: source, dataset: ds } }));
            }
        } catch (e) { /* CustomEvent not supported */ }
        return ds;
    }

    function _setMsg(html) {
        var msg = _byId('prism_data_msg');
        if (msg) msg.innerHTML = html;
    }

    function _activeStatusHTML() {
        var ds = W.PRiSM_dataset;
        if (!ds || !ds.t || !ds.t.length) return '';
        return '<span style="color:var(--text2);">Active dataset: <b style="color:var(--text);">' +
            _escapeHTML(ds.name || 'Data') + '</b> · ' + ds.t.length + ' points' +
            (ds.p ? '' : ' (rates only)') + '.</span>';
    }


    // =======================================================================
    // SECTION 7 — RENDER THE ENHANCED DATA TAB
    // =======================================================================

    function PRiSM_renderDataTabEnhanced() {
        var host = _byId('prism_tab_1');
        if (!host) return;
        var st = _getState();

        host.innerHTML = ''
            + '<div class="cols-2">'
            + '  <div style="min-width:0;">'
            // ── Loader card ──
            + '    <div class="card" id="prism_load_card">'
            + '      <div class="card-title">Load Data</div>'
            + '      <div style="font-size:12px; color:var(--text2); margin-bottom:10px; line-height:1.5;">'
            + '        Choose a CSV / TSV / TXT / DAT / ASC / XLSX file or paste from a spreadsheet.'
            + '        Header, separator, column roles and units are detected, and the data is'
            + '        used as soon as it is read — check the mapping and units below.'
            + '      </div>'
            + '      <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:10px;">'
            + '        <input type="file" id="prism_data_file" accept=".csv,.tsv,.txt,.dat,.asc,.xls,.xlsx" style="font-size:12px; color:var(--text2); max-width:100%;">'
            + '        <span id="prism_data_filename" style="font-size:12px; color:var(--text3); overflow-wrap:anywhere;"></span>'
            + '      </div>'
            + '      <textarea id="prism_data_paste" class="data-textarea" aria-label="Pasted data" style="min-height:160px; font-family:monospace; font-size:12px; width:100%;" placeholder="time,pressure,rate&#10;0.01,3861.4,850&#10;0.02,3705.0,850"></textarea>'
            + '      <div style="margin-top:10px; display:flex; gap:10px; flex-wrap:wrap;">'
            + '        <button class="btn btn-primary" id="prism_data_parse" type="button">Load data</button>'
            + '        <button class="btn btn-secondary" id="prism_data_demo" type="button">Try demo data</button>'
            + '        <button class="btn btn-secondary" id="prism_data_clear" type="button">Clear</button>'
            + '      </div>'
            + '      <div id="prism_data_msg" role="status" aria-live="polite" style="margin-top:8px; font-size:12px; color:var(--text2);"></div>'
            + '      <div id="prism_rateonly_banner" class="info-bar" style="display:none; margin:10px 0 0;">'
            + '        This file has rates but no pressure column, so it looks like production data.'
            + '        <div style="margin-top:8px;"><button class="btn btn-secondary" id="prism_rateonly_switch" type="button">Analyse as rate-only (decline)</button></div>'
            + '      </div>'
            + '    </div>'

            // ── Sheet picker (only when a workbook is loaded) ──
            + '    <div class="card" id="prism_sheet_card" style="display:' + (st.workbook ? 'block' : 'none') + ';">'
            + '      <div class="card-title">Workbook Sheet</div>'
            + '      <div class="fg"><div class="fg-item"><label for="prism_sheet_pick">Active sheet</label>'
            + '      <select id="prism_sheet_pick"></select></div></div>'
            + '    </div>'

            // ── Column mapper ──
            + '    <div class="card" id="prism_map_card" style="display:none;">'
            + '      <div class="card-title">Column Mapping</div>'
            + '      <div style="font-size:12px; color:var(--text2); margin-bottom:10px;">'
            + '        What each column holds. Your choice is remembered for files with the same headers.'
            + '      </div>'
            + '      <div id="prism_map_grid" style="display:flex; flex-wrap:wrap; gap:10px;"></div>'
            + '      <div style="margin-top:10px; display:flex; gap:8px; flex-wrap:wrap;">'
            + '        <button class="btn btn-primary" id="prism_map_apply" type="button">Apply mapping</button>'
            + '        <button class="btn btn-secondary" id="prism_map_reset" type="button">Detect again</button>'
            + '      </div>'
            + '    </div>'

            // ── Units ──
            + '    <div class="card" id="prism_units_card" style="display:none;">'
            + '      <div class="card-title">Units</div>'
            + '      <div style="display:flex; flex-wrap:wrap; gap:10px;">'
            + '        <div class="fg-item" style="flex:1 1 130px; min-width:0;"><label for="prism_unit_time">Time</label><select id="prism_unit_time"></select></div>'
            + '        <div class="fg-item" style="flex:1 1 130px; min-width:0;"><label for="prism_unit_pressure">Pressure</label><select id="prism_unit_pressure"></select></div>'
            + '        <div class="fg-item" style="flex:1 1 130px; min-width:0;"><label for="prism_unit_rate">Rate (liquid)</label><select id="prism_unit_rate"></select></div>'
            + '        <div class="fg-item" style="flex:1 1 130px; min-width:0;"><label for="prism_unit_rate_g">Rate (gas)</label><select id="prism_unit_rate_g"></select></div>'
            + '        <div class="fg-item" id="prism_rate_phase_item" style="flex:1 1 150px; min-width:0; display:none;"><label for="prism_rate_phase">Rate used for analysis</label><select id="prism_rate_phase"></select></div>'
            + '      </div>'
            + '      <div id="prism_unit_msg" style="margin-top:8px; font-size:12px; color:var(--text3); line-height:1.5;"></div>'
            + '    </div>'

            // ── Cleanup ──
            + '    <div class="card" id="prism_clean_card" style="display:none;">'
            + '      <div class="card-title">Cleanup</div>'
            + '      <div style="display:flex; flex-wrap:wrap; gap:10px;">'
            + '        <div class="fg-item" style="flex:1 1 160px; min-width:0;"><label for="prism_clean_filter">Filter</label>'
            + '          <select id="prism_clean_filter">'
            + '            <option value="none">none</option>'
            + '            <option value="mad">Outlier removal (MAD)</option>'
            + '            <option value="ma">Low-pass (5-pt moving average)</option>'
            + '            <option value="hampel">Hampel (median outlier)</option>'
            + '          </select></div>'
            + '        <div class="fg-item" style="flex:1 1 160px; min-width:0;"><label for="prism_clean_decim">Thin out points</label>'
            + '          <select id="prism_clean_decim">'
            + '            <option value="none">none</option>'
            + '            <option value="nth">Every Nth point</option>'
            + '            <option value="log">Log-spaced (target N)</option>'
            + '            <option value="bin">One point per X minutes</option>'
            + '          </select></div>'
            + '        <div class="fg-item" style="flex:1 1 100px; min-width:0;"><label for="prism_clean_decimN">N / target</label>'
            + '          <input id="prism_clean_decimN" type="number" min="2" value="5" step="1"></div>'
            + '        <div class="fg-item" style="flex:1 1 100px; min-width:0;"><label for="prism_clean_bin">X (min)</label>'
            + '          <input id="prism_clean_bin" type="number" min="0.1" value="5" step="0.5"></div>'
            + '        <div class="fg-item" style="flex:1 1 110px; min-width:0;"><label for="prism_clean_tstart">Time start (h)</label>'
            + '          <input id="prism_clean_tstart" type="number" step="any" placeholder="(min)"></div>'
            + '        <div class="fg-item" style="flex:1 1 110px; min-width:0;"><label for="prism_clean_tend">Time end (h)</label>'
            + '          <input id="prism_clean_tend" type="number" step="any" placeholder="(max)"></div>'
            + '      </div>'
            + '      <div style="margin-top:10px; display:flex; gap:8px; flex-wrap:wrap; align-items:center;">'
            + '        <button class="btn btn-secondary" id="prism_clean_preview" type="button">Preview</button>'
            + '        <button class="btn btn-primary" id="prism_clean_apply" type="button">Apply</button>'
            + '        <span id="prism_clean_msg" style="font-size:12px; color:var(--text3);"></span>'
            + '      </div>'
            + '      <canvas id="prism_clean_canvas" width="480" height="120" style="margin-top:10px; width:100%; max-width:480px; background:var(--bg1); border:1px solid var(--border); border-radius:6px; display:none;"></canvas>'
            + '    </div>'

            // ── Multi-rate editor ──
            + '    <div class="card">'
            + '      <div class="card-title">Multi-Rate History (optional)</div>'
            + '      <div style="font-size:12px; color:var(--text2); margin-bottom:10px;">'
            + '        For superposition. One [time (h), rate] pair per rate change; rate = 0'
            + '        for a shut-in. Leave empty when the rates are in the data or the test is single-rate.'
            + '      </div>'
            + '      <div style="overflow-x:auto;"><table class="dtable" id="prism_mrate_table">'
            + '        <thead><tr><th>Time (h)</th><th>Rate</th><th></th></tr></thead>'
            + '        <tbody id="prism_mrate_body"></tbody>'
            + '      </table></div>'
            + '      <div style="margin-top:8px;"><button class="btn btn-secondary" id="prism_mrate_add" type="button">+ Add row</button></div>'
            + '    </div>'
            + '  </div>'

            + '  <div style="min-width:0;">'
            + '    <div class="card">'
            + '      <div class="card-title">Summary</div>'
            + '      <div id="prism_data_stats">'
            + '        <div style="color:var(--text3); font-size:12px;">No data parsed yet.</div>'
            + '      </div>'
            + '    </div>'
            + '    <div class="card">'
            + '      <div class="card-title">Preview</div>'
            + '      <div id="prism_data_preview" style="overflow-x:auto;">'
            + '        <div style="color:var(--text3); font-size:12px;">No data parsed yet.</div>'
            + '      </div>'
            + '    </div>'
            + '  </div>'
            + '</div>';

        // Persisted textarea (also registers the host autosave for it).
        _load('prism', ['prism_data_paste']);

        var fi = _byId('prism_data_file');
        if (fi) fi.onchange = function (ev) {
            var f = ev.target.files && ev.target.files[0];
            if (f) W.PRiSM_loadFile(f);
        };
        var pb = _byId('prism_data_parse');
        if (pb) pb.onclick = W.PRiSM_doParseData;
        var db = _byId('prism_data_demo');
        if (db) db.onclick = _loadDemo;
        var cb = _byId('prism_data_clear');
        if (cb) cb.onclick = _clearData;
        var rs = _byId('prism_rateonly_switch');
        if (rs) rs.onclick = function () {
            if (W.PRiSM && typeof W.PRiSM.setMode === 'function') W.PRiSM.setMode('decline');
            else if (W.PRiSM) W.PRiSM.mode = 'decline';
            _renderRateOnlyBanner(W.PRiSM_dataset);
        };

        if (typeof PRiSM_renderMultiRateRows === 'function') PRiSM_renderMultiRateRows();
        var mra = _byId('prism_mrate_add');
        if (mra) mra.onclick = function () {
            if (!W.PRiSM) W.PRiSM = {};
            if (!Array.isArray(W.PRiSM.multiRate)) W.PRiSM.multiRate = [];
            W.PRiSM.multiRate.push({ t: 0, q: 0 });
            if (typeof PRiSM_renderMultiRateRows === 'function') PRiSM_renderMultiRateRows();
            if (typeof PRiSM_persistMultiRate === 'function') PRiSM_persistMultiRate();
        };

        var fnl = _byId('prism_data_filename');
        if (fnl) fnl.textContent = st.fileName || '';

        var active = W.PRiSM_dataset;
        var hasActive = !!(active && active.t && active.t.length);
        if (st.rawRows && st.rawRows.length) {
            // Same session: repaint from state, never re-commit (keeps a crop).
            _paintAll();
            _renderPreview();
            _setMsg(_activeStatusHTML());
        } else {
            var ta = _byId('prism_data_paste');
            var text = ta ? ta.value : '';
            if (text.trim() && _adoptText(text)) {
                st.fileName = _nameForText(text);
                if (fnl) fnl.textContent = st.fileName || '';
                _paintAll();
                var ds = _buildDataset(true);
                if (!hasActive && ds && ds.t.length) {
                    ds.name = st.fileName || 'Pasted data';
                    ds.source = st.fileName ? 'file' : 'paste';
                    _commit(ds, 'restored');
                    if (typeof W.PRiSM_restorePersistedCrop === 'function') {
                        try { W.PRiSM_restorePersistedCrop(); } catch (e) { /* optional */ }
                    }
                }
                _renderPreview();
                _setMsg(_activeStatusHTML());
            } else if (hasActive) {
                _setMsg(_activeStatusHTML());
            }
        }
        _renderRateOnlyBanner(W.PRiSM_dataset);
    }

    // Repaint every card that depends on the parsed state.
    function _paintAll() {
        var st = _getState();
        if (st.workbook) PRiSM_renderSheetPicker();
        PRiSM_renderColumnMapper();
        PRiSM_renderUnitPickers();
        PRiSM_renderCleanupPanel();
    }

    function _renderRateOnlyBanner(ds) {
        var ban = _byId('prism_rateonly_banner');
        if (!ban) return;
        var mode = W.PRiSM && W.PRiSM.mode;
        var show = !!(ds && ds.t && ds.t.length && !ds.p && ds.q && mode !== 'decline');
        ban.style.display = show ? '' : 'none';
    }

    function _loadDemo() {
        var ds = null;
        if (typeof W.PRiSM_loadDemoData === 'function') {
            ds = W.PRiSM_loadDemoData();
        } else if (typeof W.PRiSM_DEFAULT_SAMPLE_CSV === 'string') {
            try { var ls = _ls(); if (ls) ls.removeItem('wts_prism_sample_suppress'); } catch (e) { /* ignore */ }
            var ta = _byId('prism_data_paste');
            if (ta) ta.value = W.PRiSM_DEFAULT_SAMPLE_CSV;
            _persistText(W.PRiSM_DEFAULT_SAMPLE_CSV);
            _rememberName(W.PRiSM_DEFAULT_SAMPLE_CSV, 'Demo data');
            ds = _enhParse(W.PRiSM_DEFAULT_SAMPLE_CSV, { source: 'sample', name: 'Demo data' });
        }
        var fnl = _byId('prism_data_filename');
        if (fnl) fnl.textContent = '';
        if (ds && ds.t) {
            _setMsg('<span style="color:var(--green);">Demo data loaded: ' + ds.t.length +
                ' points, homogeneous-reservoir drawdown (q = 850 STB/d, pi = 4200 psia).</span>');
        } else {
            _setMsg('<span style="color:var(--red);">The demo data could not be loaded.</span>');
        }
        _renderRateOnlyBanner(W.PRiSM_dataset);
        return ds;
    }

    function _clearData() {
        var ta = _byId('prism_data_paste');
        if (ta) ta.value = '';
        _setMsg('');
        var fnl = _byId('prism_data_filename');
        if (fnl) fnl.textContent = '';
        var prev = _byId('prism_data_preview'), stats = _byId('prism_data_stats');
        if (prev) prev.innerHTML = '<div style="color:var(--text3); font-size:12px;">No data parsed yet.</div>';
        if (stats) stats.innerHTML = '<div style="color:var(--text3); font-size:12px;">No data parsed yet.</div>';
        ['prism_map_card', 'prism_units_card', 'prism_clean_card', 'prism_sheet_card'].forEach(function (id) {
            var e = _byId(id); if (e) e.style.display = 'none';
        });
        W.PRiSM_dataset = null;
        _resetState();
        try { var ls = _ls(); if (ls) ls.setItem('wts_prism_sample_suppress', '1'); } catch (e) { /* ignore */ }
        if (ta) _save('prism', ['prism_data_paste']);
        else _persistText('');
        _renderRateOnlyBanner(null);
        try {
            if (typeof W.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
                W.dispatchEvent(new CustomEvent('prism:dataset-cleared', { detail: { source: 'clear' } }));
            }
        } catch (e) { /* ignore */ }
    }


    // =======================================================================
    // SECTION 8 — FILE LOADER (CSV/TSV/TXT/DAT/ASC/XLSX)
    // =======================================================================
    // Resolves with the committed dataset (or null). Works without the Data
    // tab on screen (e.g. from the gauge-data manager).

    W.PRiSM_loadFile = function (file) {
        if (!file) return Promise.resolve(null);
        var st = _getState();
        var name = file.name || 'file';
        var fnl = _byId('prism_data_filename');
        if (fnl) fnl.textContent = name;
        var isXlsx = /\.(xlsx|xls|xlsm|xlsb|ods)$/i.test(name);

        if (isXlsx) {
            _setMsg('<span style="color:var(--text3);">Loading the spreadsheet reader…</span>');
            return PRiSM_loadXLSX().then(function () {
                return _readArrayBuffer(file);
            }).then(function (buf) {
                var wb = PRiSM_parseWorkbook(buf);
                st.source = 'workbook';
                st.workbook = wb;
                st.sheetIdx = wb.defaultIdx;
                st.fileName = name;
                _adoptSheet(st);
                return _enhParse(undefined, { fromWorkbook: true });
            }).catch(function (e) {
                _setMsg('<span style="color:var(--red);">'
                    + 'Reading XLSX needs an internet connection the first time; please save the sheet as CSV instead. '
                    + '(' + _escapeHTML(e && e.message ? e.message : 'load failed') + ')</span>');
                return null;
            });
        }

        return _readText(file).then(function (text) {
            var ta = _byId('prism_data_paste');
            if (ta) { ta.value = text; _save('prism', ['prism_data_paste']); }
            else _persistText(text);
            _rememberName(text, name);
            st.source = 'paste';
            st.workbook = null;
            return _enhParse(text);
        });
    };

    function _readArrayBuffer(file) {
        return new Promise(function (resolve, reject) {
            var r = new FileReader();
            r.onload = function (e) { resolve(e.target.result); };
            r.onerror = function () { reject(new Error('FileReader failed')); };
            r.readAsArrayBuffer(file);
        });
    }
    function _readText(file) {
        return new Promise(function (resolve, reject) {
            var r = new FileReader();
            r.onload = function (e) { resolve(e.target.result); };
            r.onerror = function () { reject(new Error('FileReader failed')); };
            r.readAsText(file);
        });
    }


    // =======================================================================
    // SECTION 9 — PARSE = COMMIT
    // =======================================================================
    // window.PRiSM_doParseData (the "Load data" button): read the textarea
    // (or the current workbook sheet), map, convert, clean, and make the
    // result the active dataset — 'prism:dataset-loaded' fires once.

    function _enhParse(textArg, meta) {
        var st = _getState();
        meta = (meta && typeof meta === 'object') ? meta : {};
        var fromText = (typeof textArg === 'string');
        var source;
        var useSheet = !fromText && st.source === 'workbook' && !!st.workbook;
        if (useSheet && !meta.fromWorkbook) {
            // "Load data" after a workbook: use the sheet only while the
            // textarea still holds the text written from it; new text wins.
            var taW = _byId('prism_data_paste');
            if (taW && _fnv(taW.value) !== st.wbCsvHash) { useSheet = false; st.source = 'paste'; st.workbook = null; }
        }
        if (useSheet) {
            source = 'file';
        } else {
            var text = fromText ? textArg : null;
            if (text == null) {
                var ta = _byId('prism_data_paste');
                if (!ta) return null;
                text = ta.value;
                _save('prism', ['prism_data_paste']);
            }
            if (!_adoptText(text)) {
                _setMsg('<span style="color:var(--red);">No valid data rows. '
                    + _escapeHTML((st.parseErrors || []).slice(0, 3).join(' · ')) + '</span>');
                var prev0 = _byId('prism_data_preview'), stats0 = _byId('prism_data_stats');
                if (prev0) prev0.innerHTML = '<div style="color:var(--text3); font-size:12px;">No data parsed yet.</div>';
                if (stats0) stats0.innerHTML = '<div style="color:var(--text3); font-size:12px;">No data parsed yet.</div>';
                return null;
            }
            if (meta.name) _rememberName(text, meta.name);
            st.fileName = meta.name || _nameForText(text);
            source = meta.source || (st.fileName ? 'file' : 'paste');
        }
        var fnl = _byId('prism_data_filename');
        if (fnl) fnl.textContent = st.fileName || '';
        _paintAll();
        var ds = _buildDataset(true);
        if (!ds || !ds.t || !ds.t.length) {
            _renderPreview();
            _setMsg('<span style="color:var(--red);">Parsed ' + st.rawRows.length + ' rows but none are usable — check the column mapping, units and cleanup.</span>');
            return null;
        }
        ds.name = st.fileName || meta.name || 'Pasted data';
        ds.source = source;
        _commit(ds, source);
        // A workbook sheet is kept as canonical CSV text so a reload restores it.
        if (source === 'file' && st.source === 'workbook') {
            var csv = _datasetToCSV(ds);
            var ta2 = _byId('prism_data_paste');
            if (ta2) { ta2.value = csv; _save('prism', ['prism_data_paste']); } else _persistText(csv);
            _rememberName(csv, ds.name);
            st.wbCsvHash = _fnv(csv);
        }
        _renderPreview();
        _renderRateOnlyBanner(ds);
        var ncols = st.rawRows[0] ? st.rawRows[0].length : 0;
        _setMsg('<span style="color:var(--green);">Parsed ' + st.rawRows.length + ' rows (' + ncols + ' cols). '
            + 'Dataset active: ' + ds.t.length + ' points' + (ds.p ? '' : ' (rates only)') + '.</span>'
            + (st.errors && st.errors.length ? ' <span style="color:var(--yellow);">' + st.errors.length + ' rows skipped.</span>' : ''));
        return ds;
    }

    function _datasetToCSV(ds) {
        var cols = ['time'], get = [function (i) { return ds.t[i]; }];
        if (ds.p) { cols.push('pressure'); get.push(function (i) { return ds.p[i]; }); }
        if (ds.q) { cols.push(ds.rateUnit === 'Mscf/d' ? 'gas rate' : 'rate'); get.push(function (i) { return ds.q[i]; }); }
        var lines = [cols.join(',')];
        for (var i = 0; i < ds.t.length; i++) {
            lines.push(get.map(function (g) { var v = g(i); return (v == null || !isFinite(v)) ? '' : String(v); }).join(','));
        }
        return lines.join('\n');
    }

    W.PRiSM_doParseData = function PRiSM_doParseData(arg) {
        return _enhParse(typeof arg === 'string' ? arg : undefined);
    };

    // API compatibility: build with the current settings and commit.
    W.PRiSM_doUseData = function PRiSM_doUseData() {
        var st = _getState();
        if (!st.rawRows || !st.rawRows.length) return _enhParse();
        var ds = _buildDataset(true);
        if (!ds || !ds.t || !ds.t.length) {
            _setMsg('<span style="color:var(--red);">No usable rows after cleanup. Loosen the filter or time range.</span>');
            return null;
        }
        ds.name = st.fileName || 'Pasted data';
        ds.source = st.fileName ? 'file' : 'paste';
        _commit(ds, ds.source);
        _renderPreview();
        _renderRateOnlyBanner(ds);
        _setMsg('<span style="color:var(--green);">Dataset of ' + ds.t.length + ' points active.</span>');
        return ds;
    };

    // Text → dataset through this pipeline, adopted into the Data tab state
    // (and repainted when the tab is on screen). Does NOT commit — the caller
    // (01-foundation seed / restore) does.
    function PRiSM_datasetFromText(text, meta) {
        meta = meta || {};
        var st = _getState();
        text = String(text == null ? '' : text);
        if (!_adoptText(text)) return null;
        if (meta.name) _rememberName(text, meta.name);
        st.fileName = meta.name || _nameForText(text);
        var ta = _byId('prism_data_paste');
        if (ta && ta.value !== text) ta.value = text;
        var ds = _buildDataset(true);
        if (!ds || !ds.t || !ds.t.length) return null;
        ds.name = st.fileName || 'Pasted data';
        if (meta.source) ds.source = meta.source;
        if (_byId('prism_map_card')) {
            var fnl = _byId('prism_data_filename');
            if (fnl) fnl.textContent = (meta.source === 'sample') ? '' : (st.fileName || '');
            _paintAll();
            _renderPreview();
            _renderRateOnlyBanner(ds);
        }
        return ds;
    }


    // =======================================================================
    // SECTION 10 — SHEET PICKER + COLUMN MAPPER UI
    // =======================================================================

    function PRiSM_renderSheetPicker() {
        var st = _getState();
        var card = _byId('prism_sheet_card');
        var sel = _byId('prism_sheet_pick');
        if (!card || !sel || !st.workbook) return;
        card.style.display = 'block';
        sel.innerHTML = '';
        st.workbook.sheets.forEach(function (s, i) {
            var o = document.createElement('option');
            o.value = String(i);
            o.textContent = s.name + (s.empty ? ' (empty)' : ' — ' + s.rows.length + ' rows');
            if (i === st.sheetIdx) o.selected = true;
            sel.appendChild(o);
        });
        sel.onchange = function () {
            st.sheetIdx = parseInt(sel.value, 10);
            st.source = 'workbook';
            _adoptSheet(st);
            _enhParse(undefined, { fromWorkbook: true });
        };
    }

    function PRiSM_renderColumnMapper() {
        var st = _getState();
        var card = _byId('prism_map_card');
        var grid = _byId('prism_map_grid');
        if (!card || !grid || !st.rawRows || !st.rawRows.length) return;
        card.style.display = 'block';
        var ncols = st.rawRows[0].length;
        grid.innerHTML = '';
        for (var c = 0; c < ncols; c++) {
            var label = (st.headers && st.headers[c]) ? st.headers[c] : ('Column ' + (c + 1));
            var preview = [];
            for (var r = 0; r < Math.min(3, st.rawRows.length); r++) {
                var v = st.rawRows[r][c];
                preview.push((st.dateCols && st.dateCols[c] && isFinite(v)) ? new Date(v).toISOString().slice(0, 16).replace('T', ' ') : _fmt(v, 3));
            }
            var div = document.createElement('div');
            div.className = 'fg-item';
            div.style.flex = '1 1 140px';
            div.style.minWidth = '0';
            var optsHTML = ROLES.map(function (ro) {
                return '<option value="' + ro.v + '"' + (st.mapping[c] === ro.v ? ' selected' : '') + '>' + ro.label + '</option>';
            }).join('');
            div.innerHTML =
                '<label for="prism_mapcol_' + c + '" title="' + _escapeHTML(String(label)) + '">'
                + _escapeHTML(String(label).slice(0, 28)) + '</label>'
                + '<select id="prism_mapcol_' + c + '" data-mapcol="' + c + '">' + optsHTML + '</select>'
                + '<div style="font-size:10px; color:var(--text3); margin-top:4px; overflow-wrap:anywhere;">e.g. ' + _escapeHTML(preview.join(', ')) + '</div>';
            grid.appendChild(div);
        }
        grid.querySelectorAll('select[data-mapcol]').forEach(function (s) {
            s.onchange = function () {
                var i = parseInt(s.dataset.mapcol, 10);
                st.mapping[i] = s.value;
            };
        });
        var apply = _byId('prism_map_apply');
        var reset = _byId('prism_map_reset');
        if (apply) apply.onclick = function () {
            var inf = PRiSM_inferColumnUnits(st.headers, st.mapping, st.dateCols);
            Object.keys(inf.units).forEach(function (k) {
                if (st.unitSource[k] !== 'user' && st.unitSource[k] !== 'saved') { st.units[k] = inf.units[k]; st.unitSource[k] = inf.source[k]; }
            });
            st.genericIsGas = !!inf.genericIsGas;
            _saveShapeSettings(st);
            PRiSM_renderUnitPickers();
            _recommit('Mapping applied.');
        };
        if (reset) reset.onclick = function () {
            var before = JSON.stringify(st.mapping || []);
            st.mapping = PRiSM_autoMapColumns(st.headers, st.rawRows, st.dateCols);
            var changed = JSON.stringify(st.mapping || []) !== before;
            PRiSM_renderColumnMapper();
            _setMsg(changed
                ? '<span style="color:var(--orange);">Columns re-detected: press Apply mapping to use them.</span>'
                : '<span style="color:var(--text2);">Columns re-detected — no change to the mapping.</span>');
        };
    }

    // Rebuild with the current settings and commit (mapping / units / phase /
    // cleanup changes all change the dataset).
    function _recommit(note) {
        var ds = W.PRiSM_doUseData();
        if (ds && note) {
            _setMsg('<span style="color:var(--green);">' + _escapeHTML(note) + ' Dataset active: ' + ds.t.length + ' points.</span>');
        }
        return ds;
    }


    // =======================================================================
    // SECTION 11 — UNITS + CLEANUP UI
    // =======================================================================

    function _ratePhasesPresent(st) {
        var m = st.mapping || [];
        var out = [];
        if (m.indexOf('rate') !== -1) out.push({ v: 'rate', label: st.genericIsGas ? 'Rate column (gas)' : 'Rate column' });
        if (m.indexOf('rate_o') !== -1) out.push({ v: 'oil', label: 'Oil' });
        if (m.indexOf('rate_g') !== -1) out.push({ v: 'gas', label: 'Gas' });
        if (m.indexOf('rate_w') !== -1) out.push({ v: 'water', label: 'Water' });
        return out;
    }

    function PRiSM_renderUnitPickers() {
        var st = _getState();
        var card = _byId('prism_units_card');
        if (!card) return;
        card.style.display = 'block';
        var fill = function (selId, list, current, key) {
            var s = _byId(selId);
            if (!s) return;
            s.innerHTML = list.map(function (u) {
                return '<option value="' + u.v + '"' + (u.v === current ? ' selected' : '') + '>' + u.label + '</option>';
            }).join('');
            s.onchange = function () {
                st.units[key] = s.value;
                st.unitSource[key] = 'user';
                _saveShapeSettings(st);
                _showUnitMsg();
                _recommit('Units updated.');
            };
        };
        fill('prism_unit_time',     TIME_UNITS,      st.units.time,     'time');
        fill('prism_unit_pressure', PRESSURE_UNITS,  st.units.pressure, 'pressure');
        fill('prism_unit_rate',     RATE_UNITS_LIQ,  st.units.rate,     'rate');
        fill('prism_unit_rate_g',   RATE_UNITS_GAS,  st.units.rate_g,   'rate_g');

        var phases = _ratePhasesPresent(st);
        var item = _byId('prism_rate_phase_item'), ps = _byId('prism_rate_phase');
        if (item && ps) {
            item.style.display = phases.length > 1 ? '' : 'none';
            ps.innerHTML = '<option value="auto">Automatic</option>' + phases.map(function (p) {
                return '<option value="' + p.v + '">' + p.label + '</option>';
            }).join('');
            ps.value = st.ratePhase || 'auto';
            ps.onchange = function () {
                st.ratePhase = ps.value;
                _saveShapeSettings(st);
                _recommit('Rate column changed.');
            };
        }
        _showUnitMsg();
    }

    function _showUnitMsg() {
        var st = _getState();
        var msg = _byId('prism_unit_msg');
        if (!msg) return;
        var u = TIME_UNITS.find(function (x) { return x.v === st.units.time; });
        var tLabel = u ? u.label : st.units.time;
        var parts = [];
        if (st.units.time === 'date') parts.push('Time: date/time stamps → hours from the first stamp');
        else parts.push('Time: ' + tLabel + ' → hours' + (st.unitSource.time === 'header' ? ' (from the header)' : ''));
        parts.push('Pressure: ' + st.units.pressure + ' → psia');
        parts.push('Liquid: ' + st.units.rate + ' → STB/d');
        parts.push('Gas: ' + st.units.rate_g + ' → Mscf/d');
        var html = _escapeHTML(parts.join(' · '));
        var mapsTime = (st.mapping || []).indexOf('time') !== -1;
        if (mapsTime && !st.unitSource.time && st.units.time === 'h') {
            html = '<span style="color:var(--yellow);">The time unit could not be read from the file — hours assumed. Change it above if the time column is in other units.</span><br>' + html;
        }
        msg.innerHTML = html;
    }

    function PRiSM_renderCleanupPanel() {
        var st = _getState();
        var card = _byId('prism_clean_card');
        if (!card) return;
        card.style.display = 'block';
        var f = _byId('prism_clean_filter'); if (f) f.value = st.cleanup.filter;
        var d = _byId('prism_clean_decim');  if (d) d.value = st.cleanup.decim;
        var n = _byId('prism_clean_decimN'); if (n) n.value = String(st.cleanup.decimN);
        var b = _byId('prism_clean_bin');    if (b) b.value = String(st.cleanup.decimBinMin);
        var ts = _byId('prism_clean_tstart'); if (ts) ts.value = st.cleanup.tStart;
        var te = _byId('prism_clean_tend');   if (te) te.value = st.cleanup.tEnd;

        if (f) f.onchange = function () { st.cleanup.filter = f.value; };
        if (d) d.onchange = function () { st.cleanup.decim  = d.value; };
        if (n) n.oninput  = function () { st.cleanup.decimN = parseFloat(n.value) || 5; st.cleanup.decimTarget = st.cleanup.decimN; };
        if (b) b.oninput  = function () { st.cleanup.decimBinMin = parseFloat(b.value) || 5; };
        if (ts) ts.oninput = function () { st.cleanup.tStart = ts.value; };
        if (te) te.oninput = function () { st.cleanup.tEnd   = te.value; };

        var prev = _byId('prism_clean_preview');
        var apply = _byId('prism_clean_apply');
        if (prev) prev.onclick = function () { _previewCleanup(); };
        if (apply) apply.onclick = function () {
            _saveShapeSettings(st);
            var ds = _recommit('Cleanup applied.');
            var msg = _byId('prism_clean_msg');
            if (msg) msg.innerHTML = ds ? '<span style="color:var(--green);">Cleanup applied: ' + ds.t.length + ' points.</span>'
                                        : '<span style="color:var(--red);">No points left — loosen the settings.</span>';
        };
    }

    function _previewCleanup() {
        var before = _buildDataset(false, true);
        var after  = _buildDataset(true, true);
        var msg = _byId('prism_clean_msg');
        if (msg) msg.innerHTML = (before && after)
            ? ('<span style="color:var(--text2);">Before: ' + (before.t ? before.t.length : 0)
               + ' points → After: ' + (after.t ? after.t.length : 0) + ' points</span>')
            : '<span style="color:var(--red);">Nothing to preview.</span>';
        var cvs = _byId('prism_clean_canvas');
        if (!cvs || !after || !after.t || !after.t.length) return;
        cvs.style.display = 'block';
        _drawTinyCurve(cvs, after.t, after.p || after.q || after.t);
    }

    function _drawTinyCurve(cvs, x, y) {
        var ctx = cvs.getContext && cvs.getContext('2d');
        if (!ctx) return;
        var Wd = cvs.width, H = cvs.height;
        ctx.clearRect(0, 0, Wd, H);
        var pad = 6;
        var xMin = Math.min.apply(null, x), xMax = Math.max.apply(null, x);
        var yMin = Infinity, yMax = -Infinity;
        for (var i = 0; i < y.length; i++) { if (isFinite(y[i])) { if (y[i] < yMin) yMin = y[i]; if (y[i] > yMax) yMax = y[i]; } }
        if (!isFinite(xMin) || xMin === xMax) xMax = xMin + 1;
        if (!isFinite(yMin) || yMin === yMax) yMax = yMin + 1;
        ctx.strokeStyle = '#f0883e';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (var k = 0; k < x.length; k++) {
            var px = pad + (Wd - 2 * pad) * (x[k] - xMin) / (xMax - xMin);
            var py = H - pad - (H - 2 * pad) * (y[k] - yMin) / (yMax - yMin);
            if (k === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        }
        ctx.stroke();
    }


    // =======================================================================
    // SECTION 12 — BUILD DATASET (mapping + units + cleanup)
    // =======================================================================

    function _buildDataset(applyCleanup, dryRun) {
        var st = _getState();
        if (!st.rawRows || !st.rawRows.length) return null;
        var rows = st.rawRows;
        var ncols = rows[0].length;

        var idx = { time: -1, pressure: -1, rate: -1, rate_o: -1, rate_g: -1, rate_w: -1, period: -1 };
        for (var c = 0; c < ncols; c++) {
            var role = st.mapping[c];
            if (role && idx[role] === -1) idx[role] = c;
        }
        var anyRate = idx.rate >= 0 || idx.rate_o >= 0 || idx.rate_g >= 0 || idx.rate_w >= 0;
        if (idx.time < 0) {
            var free0 = !st.mapping[0];
            if (!free0) return null;
            idx.time = 0;
        }
        // Classic default: column 1 is pressure — only when nothing else is
        // mapped and column 1 is not assigned to another role.
        if (idx.pressure < 0 && !anyRate && ncols > 1 && !st.mapping[1] && idx.time !== 1) idx.pressure = 1;

        var col = function (k) { return k >= 0 ? rows.map(function (r) { return r[k]; }) : null; };
        var rawT = col(idx.time);
        var rawP = col(idx.pressure);
        var rawQ = col(idx.rate);
        var rawO = col(idx.rate_o);
        var rawG = col(idx.rate_g);
        var rawW = col(idx.rate_w);
        var rawPer = col(idx.period);

        var tConv = PRiSM_convertTime(rawT, st.units.time);
        var t = tConv.hours;
        var p = rawP ? PRiSM_convertPressure(rawP, st.units.pressure).values : null;
        var qGen = rawQ ? (st.genericIsGas ? PRiSM_convertRate(rawQ, st.units.rate_g, true).values
                                            : PRiSM_convertRate(rawQ, st.units.rate, false).values) : null;
        var qo = rawO ? PRiSM_convertRate(rawO, st.units.rate, false).values : null;
        var qg = rawG ? PRiSM_convertRate(rawG, st.units.rate_g, true).values : null;
        var qw = rawW ? PRiSM_convertRate(rawW, st.units.rate, false).values : null;

        // Rate used for analysis: the picked phase, else generic → oil → gas → water.
        var cand = { rate: qGen, oil: qo, gas: qg, water: qw };
        var phase = st.ratePhase || 'auto';
        var order = ['rate', 'oil', 'gas', 'water'];
        if (phase !== 'auto' && cand[phase]) order = [phase];
        var q = null, qPhase = null;
        for (var oi = 0; oi < order.length; oi++) { if (cand[order[oi]]) { q = cand[order[oi]]; qPhase = order[oi]; break; } }
        var qIsGas = (qPhase === 'gas') || (qPhase === 'rate' && st.genericIsGas);

        // Valid rows: finite time, and finite pressure (or rate, for rate-only data).
        var indices = [];
        for (var i = 0; i < t.length; i++) {
            if (!isFinite(t[i])) continue;
            if (p) { if (!isFinite(p[i])) continue; }
            else if (q && !isFinite(q[i])) continue;
            indices.push(i);
        }
        // Keep time increasing (logger exports are sometimes newest-first).
        var sorted = false;
        for (var s2 = 1; s2 < indices.length; s2++) {
            if (t[indices[s2]] < t[indices[s2 - 1]]) { sorted = true; break; }
        }
        if (sorted) indices.sort(function (a, b) { return (t[a] - t[b]) || (a - b); });

        if (applyCleanup) {
            var tStart = parseFloat(st.cleanup.tStart);
            var tEnd   = parseFloat(st.cleanup.tEnd);
            indices = indices.filter(function (k) {
                if (isFinite(tStart) && t[k] < tStart) return false;
                if (isFinite(tEnd)   && t[k] > tEnd)   return false;
                return true;
            });
            var sig = p || q;
            if (sig && st.cleanup.filter !== 'none') {
                var sub = indices.map(function (k) { return sig[k]; });
                var keep = null;
                if (st.cleanup.filter === 'mad') keep = PRiSM_filterMAD(sub, 5);
                else if (st.cleanup.filter === 'hampel') keep = PRiSM_filterHampel(sub, 7, 3);
                else if (st.cleanup.filter === 'ma') {
                    var smoothed = PRiSM_filterMovingAvg(sub, 5);
                    indices.forEach(function (k, j) { sig[k] = smoothed[j]; });
                }
                if (keep) indices = indices.filter(function (_, j) { return keep[j]; });
            }
            if (st.cleanup.decim === 'nth') {
                indices = PRiSM_decimateNth(t, indices, Math.max(2, Math.floor(st.cleanup.decimN)));
            } else if (st.cleanup.decim === 'log') {
                indices = PRiSM_decimateLog(t, indices, Math.max(10, Math.floor(st.cleanup.decimTarget)));
            } else if (st.cleanup.decim === 'bin') {
                indices = PRiSM_decimateTimeBin(t, indices, Math.max(0.1, st.cleanup.decimBinMin));
            }
        }

        var pickAt = function (arr) { return indices.map(function (k) { return arr[k]; }); };
        var ds = { t: pickAt(t) };
        ds.p = p ? pickAt(p) : null;
        ds.q = q ? pickAt(q) : null;
        if (qo || qg || qw) ds.phases = {
            oil:   qo ? pickAt(qo) : null,
            gas:   qg ? pickAt(qg) : null,
            water: qw ? pickAt(qw) : null
        };
        if (rawPer) ds.period = pickAt(rawPer);
        ds.timeUnit = 'h';
        ds.timeUnitOriginal = st.units.time;
        if (ds.q) {
            ds.rateUnit = qIsGas ? 'Mscf/d' : 'STB/d';
            ds.ratePhase = qPhase === 'rate' ? (st.genericIsGas ? 'gas' : 'liquid') : qPhase;
        }

        if (!dryRun) { st.lastApplied = ds; st.sorted = sorted; }
        return ds;
    }


    // =======================================================================
    // SECTION 13 — PREVIEW TABLE + STATS
    // =======================================================================

    function PRiSM_renderPreview() {
        var st = _getState();
        var ds = st.lastApplied;
        var prev = _byId('prism_data_preview');
        var statsEl = _byId('prism_data_stats');
        if (!prev || !statsEl) return;
        if (!ds || !ds.t || !ds.t.length) {
            prev.innerHTML = '<div style="color:var(--text3); font-size:12px;">No mapped data yet.</div>';
            statsEl.innerHTML = '<div style="color:var(--text3); font-size:12px;">No mapped data yet.</div>';
            return;
        }

        var qLabel = 'Rate for analysis (' + (ds.rateUnit || 'STB/d') + ')';
        var cols = [];
        cols.push({ label: ROLE_LABELS.time, values: ds.t });
        if (ds.p) cols.push({ label: ROLE_LABELS.pressure, values: ds.p });
        if (ds.q) cols.push({ label: qLabel, values: ds.q });
        if (ds.phases) {
            if (ds.phases.oil && ds.phases.oil !== ds.q)     cols.push({ label: ROLE_LABELS.rate_o, values: ds.phases.oil });
            if (ds.phases.gas && ds.phases.gas !== ds.q)     cols.push({ label: ROLE_LABELS.rate_g, values: ds.phases.gas });
            if (ds.phases.water && ds.phases.water !== ds.q) cols.push({ label: ROLE_LABELS.rate_w, values: ds.phases.water });
        }
        if (ds.period) cols.push({ label: ROLE_LABELS.period, values: ds.period });

        var N = ds.t.length;
        var tMin = Math.min.apply(null, ds.t);
        var tMax = Math.max.apply(null, ds.t);
        var dts = [];
        for (var i = 1; i < ds.t.length; i++) dts.push(ds.t[i] - ds.t[i - 1]);
        var dtSorted = dts.slice().sort(function (a, b) { return a - b; });
        var medianDt = dtSorted.length ? dtSorted[Math.floor(dtSorted.length / 2)] : NaN;
        var gaps = 0;
        if (medianDt > 0) dts.forEach(function (d) { if (d > 10 * medianDt) gaps++; });

        // Rate periods: jumps larger than 1 % of the largest rate.
        var periodCount = 1;
        var rateForPeriod = ds.q || (ds.phases && (ds.phases.oil || ds.phases.gas || ds.phases.water));
        if (rateForPeriod) {
            var maxRate = 0;
            rateForPeriod.forEach(function (v) { if (isFinite(v) && Math.abs(v) > maxRate) maxRate = Math.abs(v); });
            var thresh = 0.01 * maxRate;
            for (var k = 1; k < rateForPeriod.length; k++) {
                if (Math.abs(rateForPeriod[k] - rateForPeriod[k - 1]) > thresh) periodCount++;
            }
        } else if (ds.period) {
            periodCount = new Set(ds.period).size;
        }

        var statsHTML = '<div class="rbox" style="margin-bottom:0;">';
        statsHTML += '<div class="rrow"><span class="rl">N points</span><span class="rv">' + N + '</span></div>';
        statsHTML += '<div class="rrow"><span class="rl">Time (h)</span><span class="rv">' + _fmt(tMin, 4) + ' .. ' + _fmt(tMax, 4) + '</span></div>';
        statsHTML += '<div class="rrow"><span class="rl">Median Δt</span><span class="rv">' + _fmt(medianDt, 5) + ' h</span></div>';
        if (gaps) statsHTML += '<div class="rrow"><span class="rl" style="color:var(--yellow);">Gaps (Δt &gt; 10× median)</span><span class="rv">' + gaps + '</span></div>';
        if (ds.p) {
            var pMin = Math.min.apply(null, ds.p), pMax = Math.max.apply(null, ds.p);
            statsHTML += '<div class="rrow"><span class="rl">Pressure (psia)</span><span class="rv">' + _fmt(pMin, 2) + ' .. ' + _fmt(pMax, 2) + '</span></div>';
        } else {
            statsHTML += '<div class="rrow"><span class="rl">Pressure</span><span class="rv">— (rates only)</span></div>';
        }
        if (rateForPeriod) {
            statsHTML += '<div class="rrow"><span class="rl">Rate periods (auto)</span><span class="rv">' + periodCount + '</span></div>';
        }
        if (st.sorted) statsHTML += '<div class="rrow"><span class="rl" style="color:var(--yellow);">Rows re-ordered</span><span class="rv">by time</span></div>';
        if (st.fileName) statsHTML += '<div class="rrow"><span class="rl">File</span><span class="rv" style="overflow-wrap:anywhere;">' + _escapeHTML(st.fileName) + '</span></div>';
        if (st.errors && st.errors.length) statsHTML += '<div class="rrow"><span class="rl" style="color:var(--yellow);">Warnings</span><span class="rv">' + st.errors.length + ' rows skipped</span></div>';
        statsHTML += '</div>';
        statsEl.innerHTML = statsHTML;

        var html = '<table class="dtable"><thead><tr>';
        cols.forEach(function (c) { html += '<th>' + _escapeHTML(c.label) + '</th>'; });
        html += '</tr></thead><tbody>';
        var head = Math.min(10, N);
        var tail = N > 15 ? 5 : 0;
        var cell = function (v) { return '<td>' + (typeof v === 'number' ? _fmt(v, 4) : _escapeHTML(String(v == null ? '' : v))) + '</td>'; };
        for (var ii = 0; ii < head; ii++) {
            html += '<tr>';
            cols.forEach(function (c) { html += cell(c.values[ii]); });
            html += '</tr>';
        }
        if (tail) {
            html += '<tr><td colspan="' + cols.length + '" style="text-align:center; color:var(--text3); font-style:italic;">… ' + (N - head - tail) + ' rows omitted …</td></tr>';
            for (var jj = N - tail; jj < N; jj++) {
                html += '<tr>';
                cols.forEach(function (c) { html += cell(c.values[jj]); });
                html += '</tr>';
            }
        }
        html += '</tbody></table>';
        prev.innerHTML = html;
    }
    var _renderPreview = PRiSM_renderPreview;

    function _escapeHTML(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }


    // =======================================================================
    // EXPORT — helpers for other layers and tests.
    // =======================================================================
    W.PRiSM_renderDataTabEnhanced = PRiSM_renderDataTabEnhanced;
    W.PRiSM_datasetFromText       = PRiSM_datasetFromText;
    W.PRiSM_parseTextEnhanced     = PRiSM_parseTextEnhanced;
    W.PRiSM_autoMapColumns        = PRiSM_autoMapColumns;
    W.PRiSM_inferColumnUnits      = PRiSM_inferColumnUnits;
    W.PRiSM_convertTime           = PRiSM_convertTime;
    W.PRiSM_convertPressure       = PRiSM_convertPressure;
    W.PRiSM_convertRate           = PRiSM_convertRate;
    W.PRiSM_filterMAD             = PRiSM_filterMAD;
    W.PRiSM_filterMovingAvg       = PRiSM_filterMovingAvg;
    W.PRiSM_filterHampel          = PRiSM_filterHampel;
    W.PRiSM_decimateNth           = PRiSM_decimateNth;
    W.PRiSM_decimateLog           = PRiSM_decimateLog;
    W.PRiSM_decimateTimeBin       = PRiSM_decimateTimeBin;
    W.PRiSM_loadXLSX              = PRiSM_loadXLSX;
    W.PRiSM_parseWorkbook         = PRiSM_parseWorkbook;
    W.PRiSM_dataTabState          = function () { return _getState(); };


    // =======================================================================
    // SELF-TEST

})();

// ─── END 07-data-enhancements ─────────────────────────────────────────────

