// ════════════════════════════════════════════════════════════════════
// PRiSM — Layer 36 — Report (step ⑤ / Tab 7), PDF and CSV export
//
// PURPOSE
//   One report model feeds every output: the Report tab, the PDF (host
//   report styling), the CSV, the header job report and the quick report.
//   Results are shown in field units with ±95 % CI and a source chip
//   (regression / auto-match / type-curve match / straight line / input).
//
// REPORT CONTENT (in order)
//   Header      client / well / field (h2oil_client_info), test type, period
//   Key results k, kh, C, CD, S, pi, xf / Lh, boundary distances, rinv,
//               ΔpS, FE, DR, J, J_ideal, rw′  (value ± CI, unit, source)
//   Fit quality model, R², RMSE, AIC, iterations, converged, identifiability,
//               log PM / log TM (the old "time / pressure match" rows are gone)
//   Model parameters (dimensionless registry values ± CI)
//   Interpretation narrative, actions, cautions
//   Plots       log-log (Δp, Δp′ + model), semilog (MDH / Horner + line),
//               history (p, q + model); rate–time plots for decline fits
//   Model comparison (ΔAIC, from st.autoMatch.ranked / st.fits)
//   Pinned results (rail "Pin to report": PRiSM_getReportPins / st.reportPins)
//   Straight-line results (semilog analysis + plot-key results) with the
//               cross-check against the model fit (Δk %, ΔS)
//   Skin        summary + decomposition
//   Flow regimes, data summary (n, Δt range, reference pressure + source)
//   Decline block (qi, Di, b, EUR, P10/P50/P90) when the fit is a rate fit
//   Appendix    every input with its provenance; defaults flagged
//
// PUBLIC API (window.*)
//   PRiSM_renderReportTab(hostEl?)   render into hostEl or #prism_tab_7
//   PRiSM_buildReportHTML(opts?)     HTML fragment for the host report
//                                    pipeline (rp-* classes, plots as PNG)
//   PRiSM_buildReportCSV(opts?)      {filename, header, rows, text, kind}
//   PRiSM_exportCSV(opts?)           build + download; returns the same
//   PRiSM_reportData(opts?)          structured report model
//   PRiSM_reportResults()            compact key results (rail, quick report)
//   PRiSM_exportReport(opts?)        PDF via the host exportReport path
//   PRiSM_hostExportReport(title, html, subtitle)
//                                    bridge to the host exportReport (the
//                                    host function is not on window)
//   Analyst comments typed on the tab persist in localStorage
//   'wts_prism_report_notes' (so project files carry them and New clears them).
//   Result labels carry data-wts-help="prism_help_*" for the help tooltips.
//   The tab re-renders (debounced, one-shot) on prism:fit-updated,
//   well-changed, dataset-loaded, model-changed, automatch-updated,
//   report-pinned and window resize, only while it is on screen.
//
// CONTRACTS USED (all optional — every call is guarded, with local fallbacks)
//   C1 PRiSM_getWell           C2 PRiSM_getAnalysisData   C3 PRiSM_physicalModel
//   C4 PRiSM_getLastFit        C5 st.tcMatch              C6 PRiSM_buildPlotData
//   C7 PRiSM_PLOT_REGISTRY / PRiSM_postDrawHooks / prism:* events
//   WP5 PRiSM_skinSummary, PRiSM_skinDecomposition, st.semilog
//   WP3 PRiSM_interpretCurrentFit / st.interp   13 PRiSM_classifyRegimes
//   WP12 PRiSM_declineResults
//
// CONVENTIONS
//   Single outer IIFE; field units (t hours, p psia, q STB/d or Mscf/d;
//   decline time in days); sign-aware Δp (CLAUDE.md); no external deps;
//   no polling; dark theme via host CSS variables; works at 375 px.
// ════════════════════════════════════════════════════════════════════

(function () {
'use strict';

var G = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : {});
var _hasDoc = (typeof document !== 'undefined' && document && typeof document.createElement === 'function');

function _warn() { try { if (typeof console !== 'undefined' && console.warn) console.warn.apply(console, arguments); } catch (e) {} }

// ───────────────────────────────────────────────────────────────────
// SECTION 1 — SMALL HELPERS
// ───────────────────────────────────────────────────────────────────
function _isNum(v) { return typeof v === 'number' && isFinite(v); }
function _num() {
    for (var i = 0; i < arguments.length; i++) if (_isNum(arguments[i])) return arguments[i];
    return NaN;
}
function _esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function _arr(a) {
    if (a == null) return null;
    if (typeof a === 'number') return [a];
    if (typeof a.length !== 'number') return null;
    var out = new Array(a.length);
    for (var i = 0; i < a.length; i++) out[i] = a[i];
    return out;
}
function _own(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
function _copy(o) { var r = {}; if (o) for (var k in o) if (_own(o, k)) r[k] = o[k]; return r; }

// First non-null value under any of the alias names (searches a few
// nested containers too, so producers can use their own layout).
function _pick(obj, names) {
    if (!obj || typeof obj !== 'object') return undefined;
    var boxes = [obj, obj.skin, obj.skinSummary, obj.summary, obj.results, obj.result];
    for (var b = 0; b < boxes.length; b++) {
        var o = boxes[b];
        if (!o || typeof o !== 'object') continue;
        for (var i = 0; i < names.length; i++) if (o[names[i]] != null) return o[names[i]];
    }
    return undefined;
}
function _pickNum(obj, names) {
    if (!obj || typeof obj !== 'object') return NaN;
    var boxes = [obj, obj.skin, obj.skinSummary, obj.summary, obj.results, obj.result];
    for (var b = 0; b < boxes.length; b++) {
        var o = boxes[b];
        if (!o || typeof o !== 'object') continue;
        for (var i = 0; i < names.length; i++) if (_isNum(o[names[i]])) return o[names[i]];
    }
    return NaN;
}

// Significant-figure formatting without thousands separators
// (45.001 → "45.0", 261.9 → "262", 0.7641 → "0.764", 1548.3 → "1548").
function _fmt(v, sig) {
    if (!_isNum(v)) return '—';
    sig = sig || 3;
    var a = Math.abs(v);
    if (a === 0) return '0';
    if (a >= 1e5 || a < 1e-3) {
        return v.toExponential(Math.max(0, sig - 1)).replace('e+', 'e').replace(/e(-?)0*(\d)/, 'e$1$2');
    }
    var mag = Math.floor(Math.log(a) / Math.LN10 + 1e-12);
    return v.toFixed(Math.max(0, Math.min(8, sig - 1 - mag)));
}
function _fixed(v, d) { return _isNum(v) ? v.toFixed(d) : '—'; }
function _decimalsOf(str) { var i = String(str).indexOf('.'); return (i < 0 || /e/.test(str)) ? -1 : String(str).length - i - 1; }
// ± half-width, shown with the value's decimals when that keeps 1+ sig fig.
function _fmtPM(v, str, lo, hi) {
    if (!_isNum(lo) || !_isNum(hi) || !_isNum(v)) return '';
    var pm = Math.abs(hi - lo) / 2;
    if (!(pm > 0)) return '';
    var d = _decimalsOf(str);
    if (d >= 0 && pm >= Math.pow(10, -d)) return pm.toFixed(d);
    return _fmt(pm, 2);
}
function _today() {
    try { var d = new Date(); return d.toISOString().slice(0, 10) + ' ' + d.toTimeString().slice(0, 5); }
    catch (e) { return ''; }
}
function _slug(s) {
    return String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}
function _humanize(key) {
    var s = String(key || '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '';
}
function _ls() {
    try { return (typeof localStorage !== 'undefined' && localStorage) || G.localStorage || null; }
    catch (e) { return null; }
}

// ───────────────────────────────────────────────────────────────────
// SECTION 2 — LABELS
// ───────────────────────────────────────────────────────────────────
var MODEL_LABELS = {
    homogeneous: 'Homogeneous reservoir',
    infiniteFrac: 'Infinite-conductivity fracture', finiteFrac: 'Finite-conductivity fracture',
    finiteFracSkin: 'Fracture with fracture-face skin', partialPenFrac: 'Partially penetrating fracture',
    inclined: 'Slanted well', horizontal: 'Horizontal well', partialPen: 'Partially penetrating well',
    verticalPulse: 'Vertical pulse test', linearBoundary: 'Single straight boundary',
    parallelChannel: 'Channel (two parallel boundaries)', closedChannel3: 'Channel closed at one end',
    closedRectangle: 'Closed rectangle', intersecting: 'Two intersecting boundaries',
    fogBoundary: 'Leaky boundary', doublePorosity: 'Dual porosity',
    twoLayerXF: 'Two layers with crossflow', radialComposite: 'Radial composite',
    multiLayerXF: 'Layered with crossflow', multiLayerNoXF: 'Layered without crossflow',
    linearComposite: 'Linear composite', interference: 'Interference (observation well)',
    userDefined: 'User-defined type curve', waterInjection: 'Water injection',
    arps: 'Arps decline', duong: 'Duong decline', sepd: 'Stretched-exponential decline',
    fetkovich: 'Fetkovich decline'
};
function _modelLabel(key) {
    if (!key) return '';
    var e = G.PRiSM_MODELS && G.PRiSM_MODELS[key];
    return (e && (e.label || e.name)) || MODEL_LABELS[key] || _humanize(key);
}
var SOURCE_LABELS = {
    regression: 'Regression', automatch: 'Auto-match', match: 'Type-curve match',
    semilog: 'Straight line', input: 'Input', derived: 'Derived', project: 'Project file',
    preview: 'Model preview'
};
function _sourceLabel(s) { return SOURCE_LABELS[s] || (s ? _humanize(s) : ''); }
var TEST_LABELS = {
    drawdown: 'Drawdown', buildup: 'Buildup', injection: 'Injection', falloff: 'Falloff',
    interference: 'Interference', rate: 'Rate only (decline)', auto: 'Auto-detect'
};
function _testLabel(t) { return TEST_LABELS[t] || (t ? _humanize(t) : ''); }
var PREF_LABELS = {
    'pi': 'initial pressure (input)', 'pwf0': 'flowing pressure at shut-in',
    't0-row': 't = 0 row in the data', 'extrapolated': 'extrapolated to t = 0 (check)',
    'first-sample': 'first data point (skin will be biased)', 'fit': 'fitted initial pressure'
};
var REGIME_LABELS = {
    wellboreStorage: 'Wellbore storage (unit slope)', linearFlow: 'Linear flow (half slope)',
    bilinearFlow: 'Bilinear flow (quarter slope)', radialFlow: 'Radial flow (flat derivative)',
    sphericalFlow: 'Spherical flow (negative half slope)', constPressure: 'Constant-pressure boundary',
    closedBoundary: 'Closed boundary', sealingFault: 'Sealing fault (derivative steps up)',
    doublePorosity: 'Dual-porosity dip', unknown: 'Not classified'
};
var FLUID_UNITS = {
    oil:   { q: 'STB/d',  B: 'RB/STB',  J: 'STB/d/psi',  vol: 'STB' },
    water: { q: 'bbl/d',  B: 'RB/STB',  J: 'bbl/d/psi',  vol: 'bbl' },
    gas:   { q: 'Mscf/d', B: 'RB/Mscf', J: 'Mscf/d/psi', vol: 'Mscf' }
};
function _units(fluid) { return FLUID_UNITS[fluid] || FLUID_UNITS.oil; }

// ───────────────────────────────────────────────────────────────────
// SECTION 3 — STATE ACCESS (contracts first, local fallbacks second)
// ───────────────────────────────────────────────────────────────────
function _state() { return G.PRiSM_state || {}; }

function _normFit(f, st) {
    if (!f || typeof f !== 'object') return null;
    var o = _copy(f);
    o.modelKey = f.modelKey || f.model || (st && st.model) || null;
    o.r2 = _num(f.r2, f.R2);
    o.rmse = _num(f.rmse, f.RMSE);
    o.aic = _num(f.aic, f.AIC);
    o.dAIC = _num(f.dAIC, f.deltaAIC);
    o.dAICnext = _num(f.dAICnext, f.dAIC_next);
    o.ci95 = f.ci95 || f.CI95 || {};
    var e = o.modelKey && G.PRiSM_MODELS ? G.PRiSM_MODELS[o.modelKey] : null;
    o.kind = f.kind || (e && e.kind === 'rate' ? 'rate' : 'pressure');
    o.params = f.params || {};
    return o;
}
function _getFit() {
    var st = _state();
    if (typeof G.PRiSM_getLastFit === 'function') {
        try { var f = G.PRiSM_getLastFit(); if (f) return _normFit(f, st); } catch (e) { _warn('[report] getLastFit failed', e); }
    }
    return st.lastFit ? _normFit(st.lastFit, st) : null;
}

function _clientInfo() {
    var ci = {};
    try { var ls = _ls(); ci = JSON.parse((ls && ls.getItem('h2oil_client_info')) || '{}') || {}; } catch (e) { ci = {}; }
    var p = G.WTS_state && G.WTS_state.clientInfo;
    if (p) for (var k in p) if (_own(p, k) && ci[k] == null) ci[k] = p[k];
    return {
        client: ci.client || ci.clientName || ci.operator || '',
        well: ci.well || ci.wellName || '',
        field: ci.field || ci.fieldName || '',
        operator: ci.operator || '',
        ref: ci.ref || ci.jobId || '',
        engineer: ci.engineer || ''
    };
}

// C1 well store. Returns the C1 shape plus provenance per C1 key.
var WELL_PVT_KEY = { pi: 'p_res', T_R: 'T_res', T_F: 'T_res', sg: 'SG_g', fluid: 'fluidType' };
function _getWell(ds) {
    var pvt = G.PRiSM_pvt || {};
    var prov = pvt.provenance || {};
    var w = null;
    if (typeof G.PRiSM_getWell === 'function') {
        try { w = G.PRiSM_getWell(ds); } catch (e) { _warn('[report] getWell failed', e); w = null; }
    }
    if (!w || typeof w !== 'object') {
        var c = pvt._computed || {};
        var fluid = pvt.fluidType || 'oil';
        var B = fluid === 'gas' ? _num(pvt.Bg, c.Bg) : fluid === 'water' ? _num(pvt.Bw, c.B) : _num(pvt.Bo, c.Bo, c.B);
        var mu = fluid === 'gas' ? _num(pvt.mu_g, c.mu_g, c.mu) : fluid === 'water' ? _num(pvt.mu_w, c.mu) : _num(pvt.mu_o, c.mu_o, c.mu);
        var piProv = prov.p_res || prov.pi;
        var qData = NaN;
        if (ds && ds.q && ds.q.length) {
            for (var i = ds.q.length - 1; i >= 0; i--) if (_isNum(ds.q[i]) && ds.q[i] > 0) { qData = ds.q[i]; break; }
        }
        w = {
            fluid: fluid, q: _num(qData, pvt.q), B: B, mu: mu, ct: _num(pvt.ct, c.ct),
            h: _num(pvt.h), phi: _num(pvt.phi), rw: _num(pvt.rw),
            pi: (piProv === 'user' || piProv === 'sample' || piProv === 'deconvolution') ? _num(pvt.p_res) : NaN,
            T_F: _num(pvt.T_res), T_R: _num(pvt.T_res) + 459.67, sg: _num(pvt.SG_g),
            testType: pvt.testType || 'auto', tp: _num(pvt.tp), tShut: _num(pvt.tShut), pwf0: _num(pvt.pwf0)
        };
        var need = ['q', 'B', 'mu', 'ct', 'h', 'phi', 'rw'];
        w.missing = need.filter(function (k) { return !_isNum(w[k]); });
        w.defaulted = need.concat(['pi']).filter(function (k) {
            var pk = WELL_PVT_KEY[k] || k;
            var pv = prov[k] || prov[pk];
            if (k === 'B') pv = prov.B || prov.Bo || prov.Bg || prov.Bw;
            if (k === 'mu') pv = prov.mu || prov.mu_o || prov.mu_g || prov.mu_w;
            return !pv || pv === 'default';
        });
        w.complete = w.missing.length === 0;
        w._local = true;
    }
    if (!w.provenance || typeof w.provenance !== 'object') w.provenance = prov;
    return w;
}
function _provOf(well, key) {
    var prov = (well && well.provenance) || {};
    var store = (G.PRiSM_pvt && G.PRiSM_pvt.provenance) || {};
    var pk = WELL_PVT_KEY[key] || key;
    var pv = prov[key] || prov[pk] || store[key] || store[pk];
    if (key === 'B' && !pv) pv = store.Bo || store.Bg || store.Bw;
    if (key === 'mu' && !pv) pv = store.mu_o || store.mu_g || store.mu_w;
    if (!pv && well && Array.isArray(well.defaulted) && well.defaulted.indexOf(key) >= 0) pv = 'default';
    return pv || 'default';
}

// Local Bourdet derivative d(y)/d ln t with smoothing window L (ln units).
function _bourdet(t, y, L) {
    var n = t.length, d = new Array(n);
    if (n < 3) { for (var z = 0; z < n; z++) d[z] = NaN; return d; }
    var lt = t.map(function (v) { return Math.log(v); });
    L = _isNum(L) ? Math.max(0, L) : 0.1;
    for (var i = 0; i < n; i++) {
        var j = i - 1, k = i + 1;
        while (j > 0 && lt[i] - lt[j] < L) j--;
        while (k < n - 1 && lt[k] - lt[i] < L) k++;
        if (i === 0) d[i] = (y[k] - y[i]) / (lt[k] - lt[i]);
        else if (i === n - 1) d[i] = (y[i] - y[j]) / (lt[i] - lt[j]);
        else {
            var dl = lt[i] - lt[j], dr = lt[k] - lt[i];
            var m1 = (y[i] - y[j]) / dl, m2 = (y[k] - y[i]) / dr;
            d[i] = (m1 * dr + m2 * dl) / (dl + dr);
        }
    }
    return d;
}
function _bourdetFn() {
    if (typeof G.PRiSM_compute_bourdet === 'function') return G.PRiSM_compute_bourdet;
    if (typeof PRiSM_compute_bourdet === 'function') return PRiSM_compute_bourdet;   // host-scope (02)
    return _bourdet;
}

// C2 analysis data, with a sign-aware local fallback (CLAUDE.md rule).
function _getAData(ds, st, fit, well) {
    if (!ds || !ds.t || !ds.p || !ds.t.length) return null;
    var warnings = [];
    if (typeof G.PRiSM_getAnalysisData === 'function') {
        try {
            var o = {};
            if (st.activePeriod != null) o.period = st.activePeriod;
            if (st.timeFn) o.timeFn = st.timeFn;
            if (_isNum(st.bourdetL)) o.L = st.bourdetL;
            var a = G.PRiSM_getAnalysisData(ds, o);
            if (a && a.ok) return a;
            if (a && a.reason) warnings.push(String(a.reason));
        } catch (e) { warnings.push('Analysis data failed: ' + (e && e.message)); }
    }
    var t = [], tAbs = [], p = [], idx = [];
    for (var i = 0; i < ds.t.length; i++) {
        var ti = ds.t[i], pi = ds.p[i];
        if (!_isNum(ti) || !_isNum(pi)) continue;
        tAbs.push(ti); p.push(pi); idx.push(i);
    }
    if (p.length < 3) return null;
    var tt = (well && well.testType) || 'auto';
    if (tt === 'auto' || !TEST_LABELS[tt]) {
        tt = null;
        if (ds.q && ds.q.length) {
            var last = ds.q[ds.q.length - 1], seenFlow = false;
            for (var qi = 0; qi < ds.q.length; qi++) if (_isNum(ds.q[qi]) && Math.abs(ds.q[qi]) > 0) { seenFlow = true; break; }
            if (seenFlow && _isNum(last) && last === 0) tt = 'buildup';
        }
        if (!tt) tt = (p[p.length - 1] - p[0]) >= 0 ? 'buildup' : 'drawdown';   // CLAUDE.md sign rule
    }
    var rising = (tt === 'buildup' || tt === 'injection');
    var tStart = 0;
    if (rising && tt === 'buildup' && well && _isNum(well.tShut)) tStart = well.tShut;
    var pRef = NaN, src = null;
    if (fit && _isNum(fit.pRef)) { pRef = fit.pRef; src = fit.pRefSource || 'fit'; }
    else if ((tt === 'drawdown' || tt === 'injection') && well && _isNum(well.pi)) { pRef = well.pi; src = 'pi'; }
    else if ((tt === 'buildup' || tt === 'falloff') && well && _isNum(well.pwf0)) { pRef = well.pwf0; src = 'pwf0'; }
    for (var j = 0; j < tAbs.length; j++) {
        var dt = tAbs[j] - tStart;
        if (dt > 0) { t.push(dt); } else { t.push(NaN); if (!_isNum(pRef) && Math.abs(dt) < 1e-12) { pRef = p[j]; src = 't0-row'; } }
    }
    if (!_isNum(pRef)) {
        for (var f0 = 0; f0 < t.length; f0++) if (_isNum(t[f0])) { pRef = p[f0]; break; }
        src = 'first-sample';
        warnings.push('Reference pressure taken from the first data point — skin will be biased. Enter the initial pressure on step ①.');
    }
    var T = [], TA = [], P = [], DP = [], IX = [];
    for (var m = 0; m < t.length; m++) {
        if (!_isNum(t[m])) continue;
        T.push(t[m]); TA.push(tAbs[m]); P.push(p[m]); IX.push(idx[m]);
        DP.push(rising ? p[m] - pRef : pRef - p[m]);
    }
    var L = _isNum(st.bourdetL) ? st.bourdetL : 0.1;
    var deriv = null;
    try { deriv = _arr(_bourdetFn()(T, DP, L)); } catch (e) { deriv = _bourdet(T, DP, L); }
    return {
        ok: true, local: true, reason: null, n: T.length, t: T, tAbs: TA, p: P, dp: DP, deriv: deriv,
        idx: IX, x: T, L: L, timeFn: 'dt', sign: rising ? 1 : -1, pRef: pRef, pRefSource: src,
        testType: tt, tStart: tStart, tShut: well ? _num(well.tShut) : NaN, tp: well ? _num(well.tp) : NaN,
        qRef: well ? _num(well.q) : NaN, rateHistory: [], periods: [], fluid: well ? well.fluid : 'oil',
        warnings: warnings
    };
}

// Rate at each analysis point (by source index, else nearest absolute time).
function _qAt(ds, adata) {
    var out = [];
    if (!ds || !ds.q || !adata) return out;
    var n = adata.t.length;
    for (var i = 0; i < n; i++) {
        var q = NaN;
        if (adata.idx && _isNum(adata.idx[i])) q = ds.q[adata.idx[i]];
        else if (adata.tAbs) {
            var ta = adata.tAbs[i], best = -1, bd = Infinity;
            for (var j = 0; j < ds.t.length; j++) { var d = Math.abs(ds.t[j] - ta); if (d < bd) { bd = d; best = j; } }
            if (best >= 0) q = ds.q[best];
        }
        out.push(_isNum(q) ? q : NaN);
    }
    return out;
}

// ───────────────────────────────────────────────────────────────────
// SECTION 4 — MODEL EVALUATION (physical model → scales → preview)
// ───────────────────────────────────────────────────────────────────
function _entry(key) { return key && G.PRiSM_MODELS ? G.PRiSM_MODELS[key] : null; }

function _callPd(fn, td, params) {
    var r = fn(td, params);
    if (typeof r === 'number') return [r];
    return _arr(r);
}
function _refLength(entry, phys, well) {
    var ref = entry && entry.refLength;
    if (ref === 'xf' && phys && _isNum(phys.xf)) return phys.xf;
    if (ref === 'Lh' && phys && _isNum(phys.Lh)) return phys.Lh;
    return well ? well.rw : NaN;
}
// A = 141.2 qBμ/(kh), B = 0.0002637 k/(φ μ ct Lref²)  (C3 conversions)
function _scalesFor(fit, well) {
    var A = fit.scales ? _num(fit.scales.A) : NaN, B = fit.scales ? _num(fit.scales.B) : NaN;
    if (_isNum(A) && _isNum(B)) return { A: A, B: B };
    var ph = fit.phys || {}, w = well || {};
    var k = _num(ph.k), kh = _num(ph.kh, k * w.h);
    var Lref = _refLength(_entry(fit.modelKey), ph, w);
    A = 141.2 * w.q * w.B * w.mu / kh;
    B = 0.0002637 * k / (w.phi * w.mu * w.ct * Lref * Lref);
    return (_isNum(A) && _isNum(B) && A > 0 && B > 0) ? { A: A, B: B } : null;
}
function _dimParams(fit, well, entry) {
    var p = _copy(fit.params);
    var ph = fit.phys || {};
    if (!_isNum(p.Cd) && _isNum(ph.Cd)) p.Cd = ph.Cd;
    if (!_isNum(p.Cd) && _isNum(ph.C) && well) {
        var Lr = _refLength(entry, ph, well);
        var cd = 0.8936 * ph.C / (well.phi * well.ct * well.h * Lr * Lr);
        if (_isNum(cd)) p.Cd = cd;
    }
    if (!_isNum(p.S) && _isNum(ph.S) && entry && entry.paramSpec &&
        entry.paramSpec.some(function (s) { return s.key === 'S'; })) p.S = ph.S;
    if (!_isNum(p.__h_rw) && well && _isNum(well.h) && _isNum(well.rw)) p.__h_rw = well.h / well.rw;
    return p;
}
function _pRefDir(adata) {
    if (!adata || !adata.p || !adata.dp || !adata.p.length) return 1;
    // +1 when Δp = pRef − p (drawdown / falloff), −1 when Δp = p − pRef.
    var e1 = Math.abs(adata.dp[0] - (adata.pRef - adata.p[0]));
    var e2 = Math.abs(adata.dp[0] - (adata.p[0] - adata.pRef));
    return e1 <= e2 ? 1 : -1;
}

function _evalPressure(c, t) {
    var fit = c.fit, entry = _entry(fit.modelKey), res = null;
    if (typeof G.PRiSM_physicalModel === 'function' && fit.phys && c.adata) {
        try {
            var floatPi = !!(fit.floatPi || (fit.ci95 && fit.ci95.pi));
            var pm = G.PRiSM_physicalModel(fit.modelKey, c.well, c.adata, { floatPi: floatPi });
            if (pm && pm.ok !== false && typeof pm.dp === 'function') {
                var phys = _copy(fit.params);
                var fp = fit.phys; for (var k in fp) if (_own(fp, k)) phys[k] = fp[k];
                var dp = _arr(pm.dp(t, phys));
                if (dp && dp.length === t.length) {
                    res = {
                        t: t, dp: dp,
                        deriv: typeof pm.deriv === 'function' ? _arr(pm.deriv(t, phys)) : null,
                        p: typeof pm.p === 'function' ? _arr(pm.p(t, phys)) : null,
                        source: 'physical'
                    };
                }
            }
        } catch (e) { _warn('[report] physical model failed', e); res = null; }
    }
    if (!res && entry && typeof entry.pd === 'function') {
        var sc = _scalesFor(fit, c.well);
        if (sc) {
            try {
                var params = _dimParams(fit, c.well, entry);
                var td = t.map(function (x) { return sc.B * x; });
                var pd = _callPd(entry.pd, td, params);
                var pdp = null;
                if (typeof entry.pdPrime === 'function') { try { pdp = _callPd(entry.pdPrime, td, params); } catch (e2) { pdp = null; } }
                if (!pdp) {
                    var h = 0.02;
                    var up = _callPd(entry.pd, td.map(function (x) { return x * Math.exp(h); }), params);
                    var dn = _callPd(entry.pd, td.map(function (x) { return x * Math.exp(-h); }), params);
                    pdp = up.map(function (v, i) { return (v - dn[i]) / (2 * h); });
                }
                res = {
                    t: t, dp: pd.map(function (v) { return sc.A * v; }),
                    deriv: pdp.map(function (v) { return sc.A * v; }), p: null, source: 'scales'
                };
            } catch (e3) { _warn('[report] model evaluation failed', e3); res = null; }
        }
    }
    if (res && !res.p && c.adata && _isNum(c.adata.pRef)) {
        var dir = _pRefDir(c.adata), pr = _num(fit.pRef, c.adata.pRef);
        res.p = res.dp.map(function (v) { return pr - dir * v; });
    }
    return res;
}
function _evalRate(c, tDays) {
    var fit = c.fit, entry = _entry(fit.modelKey);
    if (!entry || typeof entry.pd !== 'function') return null;
    var hours = entry.timeInput === 'hours';
    try {
        var q = _callPd(entry.pd, tDays.map(function (d) { return hours ? d * 24 : d; }), fit.params);
        return { t: tDays, q: q, source: 'rate' };
    } catch (e) { _warn('[report] rate model failed', e); return null; }
}
// Model preview curve from the UI layer (st.modelCurveData, C6/7.4) when
// there is no fit: interpolated in log-log.
function _previewAt(st, t) {
    var mc = st.modelCurveData;
    if (!mc || !mc.t || !mc.dp || mc.t.length < 2) return null;
    function at(arr, x) {
        if (!arr) return NaN;
        var n = mc.t.length;
        if (x <= mc.t[0] || x >= mc.t[n - 1]) return NaN;
        for (var i = 1; i < n; i++) if (mc.t[i] >= x) {
            var a = Math.log(mc.t[i - 1]), b = Math.log(mc.t[i]), f = (Math.log(x) - a) / (b - a);
            return arr[i - 1] + f * (arr[i] - arr[i - 1]);
        }
        return NaN;
    }
    return { t: t, dp: t.map(function (x) { return at(mc.dp, x); }), deriv: t.map(function (x) { return at(mc.deriv, x); }), p: mc.p ? t.map(function (x) { return at(mc.p, x); }) : null, source: 'preview' };
}
function _modelAt(c, t) {
    if (!t || !t.length) return null;
    if (c.fit && c.kind !== 'rate') return _evalPressure(c, t);
    if (!c.fit) return _previewAt(c.st, t);
    return null;
}
function _logspace(a, b, n) {
    var out = [], la = Math.log(a), lb = Math.log(b);
    for (var i = 0; i < n; i++) out.push(Math.exp(la + (lb - la) * i / (n - 1)));
    return out;
}

// ───────────────────────────────────────────────────────────────────
// SECTION 5 — DERIVED RESULTS (skin, rinv, comparison, regimes, decline)
// ───────────────────────────────────────────────────────────────────
var SL = {
    m: ['m', 'slope', 'mAbs'], b: ['b', 'intercept'], kh: ['kh'], k: ['k'],
    p1hr: ['p1hr', 'p1h', 'p1'], pStar: ['pStar', 'pstar', 'p_star'], S: ['S', 'skin', 'S_semilog'],
    C: ['C'], CD: ['CD', 'Cd'], rinv: ['rinv', 'r_inv', 'rInv'],
    dpS: ['dpS', 'dPs', 'dp_skin', 'dpSkin', 'deltaPs', 'dPskin'], FE: ['FE', 'fe', 'flowEfficiency'],
    DR: ['DR', 'dr', 'damageRatio'], J: ['J', 'PI'], J_ideal: ['J_ideal', 'Jideal', 'J_id'],
    rwa: ['rwa', 'rw_eff', 'rwPrime', 'rw_prime', 'rwEff', 'rw_apparent'], CDe2S: ['CDe2S', 'CDe2s', 'Cde2S']
};

function _skinFromInputs(inp) {
    // ΔpS = 141.2 qBμS/kh ; FE = (p̄ − pwf − ΔpS)/(p̄ − pwf) ; DR = 1/FE ;
    // J = q/(p̄ − pwf) ; J_ideal = q/(p̄ − pwf − ΔpS) ; rw′ = rw e^−S
    var r = {};
    if (inp.fluid !== 'gas') r.dpS = 141.2 * inp.q * inp.B * inp.mu * inp.S / inp.kh;
    var dd = inp.pbar - inp.pwf;
    if (_isNum(r.dpS) && _isNum(dd) && dd !== 0) {
        r.FE = (dd - r.dpS) / dd;
        r.DR = r.FE !== 0 ? 1 / r.FE : NaN;
        r.J = inp.q / dd;
        r.J_ideal = (dd - r.dpS) !== 0 ? inp.q / (dd - r.dpS) : NaN;
    }
    r.rwa = inp.rw * Math.exp(-inp.S);
    if (_isNum(inp.CD)) r.CDe2S = inp.CD * Math.exp(2 * inp.S);
    return r;
}

function _skinBlock(c, res) {
    var S = res.S, kh = res.kh, k = res.k, w = c.well || {};
    var sl = c.semilog;
    if (!_isNum(S)) return null;
    var a = c.adata, tt = (a && a.testType) || w.testType;
    var buildup = tt === 'buildup' || tt === 'falloff';
    var pbar = NaN, pwf = NaN;
    if (buildup) {
        pbar = _num(sl ? _pickNum(sl, SL.pStar) : NaN, res.pi);
        pwf = _num(w.pwf0, a && a.pRefSource === 'pwf0' ? a.pRef : NaN, a ? a.pRef : NaN);
    } else {
        pbar = _num(res.pi, a && a.pRefSource === 'pi' ? a.pRef : NaN, w.pi);
        if (a && a.p && a.p.length) pwf = a.p[a.p.length - 1];
    }
    var inp = {
        S: S, kh: kh, k: k, m: sl ? _pickNum(sl, SL.m) : NaN, q: w.q, B: w.B, mu: w.mu, rw: w.rw,
        pbar: pbar, pwf: pwf, testType: tt, CD: res.Cd, fluid: w.fluid
    };
    var out = null;
    if (typeof G.PRiSM_skinSummary === 'function') {
        try {
            var r = G.PRiSM_skinSummary(inp);
            if (r && typeof r === 'object') {
                out = {};
                for (var key in SL) if (_own(SL, key)) {
                    var v = _pickNum(r, SL[key]);
                    if (_isNum(v)) out[key] = v;
                }
            }
        } catch (e) { _warn('[report] skinSummary failed', e); out = null; }
    }
    var loc = _skinFromInputs(inp);
    if (!out) out = loc;
    else for (var lk in loc) if (_own(loc, lk) && !_isNum(out[lk])) out[lk] = loc[lk];
    out.S = S; out.pbar = pbar; out.pwf = pwf; out.pbarLabel = buildup ? 'p*' : 'pi';
    return out;
}

function _decomp(c, res) {
    if (typeof G.PRiSM_skinDecomposition !== 'function' || !c.fit) return null;
    try {
        var w = c.well || {}, p = c.fit.params || {};
        var r = G.PRiSM_skinDecomposition({
            S_total: res.S, modelKey: c.fit.modelKey, params: p,
            geom: { h: w.h, hp: _num(p.hp, _isNum(p.hp_to_h) ? p.hp_to_h * w.h : NaN), rw: w.rw,
                    kvkh: _num(p.KvKh, p.kvkh), theta: _num(p.theta_deg, p.theta), xf: _num(c.fit.phys && c.fit.phys.xf) },
            D: _num(c.st.rateSkin && c.st.rateSkin.D), q: w.q
        });
        return (r && typeof r === 'object') ? r : null;
    } catch (e) { _warn('[report] skinDecomposition failed', e); return null; }
}

function _rinv(k, t, well) {
    var w = well || {};
    var r = Math.sqrt(k * t / (948 * w.phi * w.mu * w.ct));
    return _isNum(r) ? r : NaN;
}

function _comparison(c) {
    var st = c.st, rows = [], seen = {};
    var am = st.autoMatch || st.lastAutoMatch || G.PRiSM_lastAutoMatch || null;
    // Only rankings / saved fits of the active dataset (a stamped hash that
    // differs from the current data is another well's result).
    var curHash = null;
    if (typeof G.PRiSM_datasetHash === 'function') { try { curHash = G.PRiSM_datasetHash(); } catch (e) { curHash = null; } }
    function fresh(o) { return !(curHash && o && o.datasetHash && o.datasetHash !== curHash); }
    if (am && !Array.isArray(am) && !fresh(am)) am = null;
    var ranked = Array.isArray(am) ? am : (am && Array.isArray(am.ranked) ? am.ranked : []);
    function add(r, origin) {
        if (!r || !fresh(r)) return;
        var key = r.modelKey || r.model || r.key;
        if (!key || seen[key + '|' + origin]) return;
        seen[key + '|' + origin] = true;
        rows.push({
            key: key, label: r.modelName || _modelLabel(key), aic: _num(r.aic, r.AIC), r2: _num(r.r2, r.R2),
            rmse: _num(r.rmse, r.RMSE), converged: r.converged, bestEffort: !!r.bestEffort, origin: origin,
            k: r.phys ? _num(r.phys.k) : NaN, S: r.phys ? _num(r.phys.S, r.phys.S_total) : NaN
        });
    }
    ranked.forEach(function (r) { add(r, 'race'); });
    if (Array.isArray(st.fits)) st.fits.forEach(function (f) { add(f && (f.fit || f), 'saved'); });
    var best = Infinity;
    rows.forEach(function (r) { if (_isNum(r.aic) && r.aic < best) best = r.aic; });
    rows.forEach(function (r) { r.dAIC = (_isNum(r.aic) && _isNum(best)) ? r.aic - best : NaN; });
    rows.sort(function (a, b) {
        if (_isNum(a.dAIC) && _isNum(b.dAIC)) return a.dAIC - b.dAIC;
        return _isNum(a.dAIC) ? -1 : _isNum(b.dAIC) ? 1 : 0;
    });
    var cur = c.fit && c.fit.modelKey;
    rows.forEach(function (r) { r.current = r.key === cur; });
    return rows;
}

// Comparison table (shared by the tab and the PDF). chip(label) marks the reported model.
function _comparisonTable(m, reportedMark) {
    var withKS = m.comparison.some(function (r) { return _isNum(r.k); });
    var head = ['Model', 'ΔAIC', 'R²', 'RMSE'].concat(withKS ? ['k (md)', 'S'] : []).concat(['Converged']);
    var rows = m.comparison.map(function (r) {
        var row = [_esc(r.label) + (r.current ? reportedMark : ''), _fixed(r.dAIC, 1), _isNum(r.r2) ? r.r2.toFixed(4) : '—', _fmt(r.rmse, 3)];
        if (withKS) row.push(_fmt(r.k, 3), _fixed(r.S, 2));
        row.push(r.converged === true ? 'yes' : r.converged === false ? (r.bestEffort ? 'starting point' : 'no') : '—');
        return row;
    });
    return { head: head, rows: rows };
}

// Results pinned from the rail (WP13 PRiSM_getReportPins / st.reportPins).
function _pins(c) {
    var pins = null;
    if (typeof G.PRiSM_getReportPins === 'function') { try { pins = G.PRiSM_getReportPins(); } catch (e) { pins = null; } }
    if (!Array.isArray(pins)) pins = Array.isArray(c.st.reportPins) ? c.st.reportPins : [];
    return pins.filter(function (p) { return p && typeof p === 'object'; }).map(function (p) {
        var ph = p.phys || {}, sl = p.semilog || {};
        var per = typeof p.period === 'string' ? p.period : (p.period && (p.period.label || p.period.name)) || '';
        return {
            label: p.modelName || (p.modelKey ? _modelLabel(p.modelKey) : 'Straight line'), source: p.source || '',
            k: _num(ph.k, _pickNum(sl, SL.k)), S: _num(ph.S, _pickNum(sl, SL.S)), C: _num(ph.C, _pickNum(sl, SL.C)),
            r2: _num(p.r2), when: p.timestamp ? String(p.timestamp).replace('T', ' ').slice(0, 16) : '',
            period: per, headline: p.headline || ''
        };
    });
}
function _pinsTable(m) {
    return {
        head: ['Model', 'Source', 'k (md)', 'S', 'C (bbl/psi)', 'R²', 'Pinned'],
        rows: m.pins.map(function (p) {
            return [_esc(p.label) + (p.period ? ' <span style="opacity:.7">(' + _esc(p.period) + ')</span>' : ''), _esc(_sourceLabel(p.source)),
                    _fmt(p.k, 3), _fixed(p.S, 2), _fmt(p.C, 3), _isNum(p.r2) ? p.r2.toFixed(4) : '—', _esc(p.when)];
        })
    };
}

function _regimes(c) {
    var a = c.adata;
    if (!a || typeof G.PRiSM_classifyRegimes !== 'function' || a.t.length < 4) return null;
    try {
        var r = G.PRiSM_classifyRegimes(_arr(a.t), _arr(a.p), a.deriv ? _arr(a.deriv) : undefined);
        if (!r || !Array.isArray(r.regimes)) return null;
        var list = [];
        r.regimes.forEach(function (g) {
            if (!g) return;
            var prev = list[list.length - 1];
            if (prev && prev.tag === g.tag) { prev.t1 = _num(g.tdEnd, prev.t1); return; }   // merge neighbours
            list.push({ tag: g.tag, label: g.label || REGIME_LABELS[g.tag] || _humanize(g.tag), t0: g.tdStart, t1: g.tdEnd,
                        slope: g.slope, confidence: g.confidence });
        });
        return { summary: r.summary || '', list: list };
    } catch (e) { _warn('[report] classifyRegimes failed', e); return null; }
}

// Only a real pressure fit is interpreted (a rate fit is reported by the
// decline block; default parameters are not a result).
function _interp(c) {
    if (!c.fit || c.kind === 'rate') return null;
    var st = c.st, it = st.interp || null;
    if (!it && typeof G.PRiSM_interpretCurrentFit === 'function') {
        try { it = G.PRiSM_interpretCurrentFit(); } catch (e) { it = null; }
    }
    if (!it) return null;
    return {
        narrative: it.narrative || '', actions: Array.isArray(it.actions) ? it.actions : [],
        cautions: Array.isArray(it.cautions) ? it.cautions : [], confidence: it.confidence || ''
    };
}

function _trapzDays(ds) {
    if (!ds || !ds.t || !ds.q) return NaN;
    var s = 0, n = 0;
    for (var i = 1; i < ds.t.length; i++) {
        var a = ds.q[i - 1], b = ds.q[i], dt = (ds.t[i] - ds.t[i - 1]) / 24;
        if (_isNum(a) && _isNum(b) && _isNum(dt) && dt > 0) { s += 0.5 * (a + b) * dt; n++; }
    }
    return n ? s : NaN;
}
function _decline(c) {
    if (c.kind !== 'rate' || !c.fit) return null;
    var p = c.fit.params || {}, r = null, warn = [];
    if (typeof G.PRiSM_declineResults === 'function') {
        try { r = G.PRiSM_declineResults(c.fit, c.ds, {}); } catch (e) { warn.push('Decline results failed: ' + (e && e.message)); }
    }
    var out = {
        qi: _num(_pickNum(r, ['qi']), p.qi, p.q1), Di: _num(_pickNum(r, ['Di']), p.Di),
        Di_yr: _pickNum(r, ['Di_yr', 'DiYr']), De: _pickNum(r, ['De', 'De_yr']), b: _num(_pickNum(r, ['b']), p.b),
        q_ab: _pickNum(r, ['q_ab', 'qab']), t_ab: _pickNum(r, ['t_ab', 'tab']),
        EUR: _pickNum(r, ['EUR', 'eur']), Np_hist: _num(_pickNum(r, ['Np_hist', 'Np']), _trapzDays(c.ds)),
        remaining: _pickNum(r, ['remaining', 'Remaining']),
        P10: _pickNum(r && (r.bands || r.pBands || r.percentiles) || r, ['P10', 'p10']),
        P50: _pickNum(r && (r.bands || r.pBands || r.percentiles) || r, ['P50', 'p50']),
        P90: _pickNum(r && (r.bands || r.pBands || r.percentiles) || r, ['P90', 'p90']),
        warnings: warn.concat(r && Array.isArray(r.warnings) ? r.warnings : []), eurLabel: 'EUR'
    };
    if (!_isNum(out.Di_yr) && _isNum(out.Di)) out.Di_yr = 365 * out.Di;
    if (!_isNum(out.EUR)) {
        var e = _entry(c.fit.modelKey);
        if (e && typeof e.eur === 'function') {
            try { out.EUR = e.eur(p, 30 * 365); out.eurLabel = 'Cumulative to 30 years'; } catch (e2) {}
        }
    }
    if (!_isNum(out.remaining) && _isNum(out.EUR) && _isNum(out.Np_hist)) out.remaining = out.EUR - out.Np_hist;
    return out;
}

// ───────────────────────────────────────────────────────────────────
// SECTION 6 — REPORT MODEL
// ───────────────────────────────────────────────────────────────────
function _ctx() {
    var st = _state();
    var ds = G.PRiSM_dataset || null;
    var fit = _getFit();
    var modelKey = (fit && fit.modelKey) || st.model || null;
    var entry = _entry(modelKey);
    var kind = fit ? fit.kind : (entry && entry.kind === 'rate' ? 'rate' : 'pressure');
    if (!fit && ds && (!ds.p || !ds.p.length) && ds.q) kind = 'rate';
    var well = _getWell(ds);
    var c = { st: st, ds: ds, fit: fit, modelKey: modelKey, entry: entry, kind: kind, well: well,
              mode: (G.PRiSM && G.PRiSM.mode) || 'transient', semilog: null };
    c.adata = kind === 'rate' ? null : _getAData(ds, st, fit, well);
    // The straight-line result is reported only for the data it was made on.
    var sl = st.semilog;
    if (kind !== 'rate' && sl && typeof sl === 'object' && sl.ok !== false) {
        var same = true;
        if (sl.datasetHash && typeof G.PRiSM_datasetHash === 'function') {
            try { same = sl.datasetHash === G.PRiSM_datasetHash(ds); } catch (e) { same = true; }
        }
        if (same) c.semilog = sl;
    }
    return c;
}

// Physical results: lastFit.phys first, then C3 conversions from scales.
function _physResults(c) {
    var fit = c.fit, w = c.well || {}, res = {}, ci = {};
    if (fit && fit.kind !== 'rate') {
        var ph = fit.phys || {}, p = fit.params || {};
        res.k = _num(ph.k); res.kh = _num(ph.kh, res.k * w.h);
        if (!_isNum(res.k) && _isNum(res.kh)) res.k = res.kh / w.h;
        if (!_isNum(res.k) && fit.scales && _isNum(fit.scales.A)) {
            res.kh = 141.2 * w.q * w.B * w.mu / fit.scales.A;
            res.k = res.kh / w.h;
        }
        // Scale mode: params.Cd is the arbitrary reference Cd, not a result.
        res.C = _num(ph.C); res.Cd = fit.mode === 'scale' ? _num(ph.Cd) : _num(ph.Cd, p.Cd);
        var Lr = _refLength(c.entry, ph, w);
        if (!_isNum(res.C) && _isNum(res.Cd)) res.C = res.Cd * w.phi * w.ct * w.h * Lr * Lr / 0.8936;
        if (!_isNum(res.Cd) && _isNum(res.C)) res.Cd = 0.8936 * res.C / (w.phi * w.ct * w.h * Lr * Lr);
        // Scale mode (φ, ct or rw missing): params.S is the curve's skin at an
        // arbitrary reference Cd, not a result — skin comes from phys only.
        var scaleMode = fit.mode === 'scale';
        res.scaleMode = scaleMode;
        res.S = scaleMode ? _num(ph.S, ph.S_total) : _num(ph.S, ph.S_total, p.S);
        res.pi = _num(ph.pi);
        res.xf = _num(ph.xf); res.Lh = _num(ph.Lh);
        res.distances = ph.distances_ft || ph.distances || null;
        var f = fit.ci95 || {};
        ['k', 'C', 'Cd', 'S', 'pi', 'xf', 'Lh'].forEach(function (k) {
            if (Array.isArray(f[k]) && f[k].length === 2) ci[k] = [f[k][0], f[k][1]];
        });
        if (!ci.Cd && ci.C && _isNum(res.C) && _isNum(res.Cd)) ci.Cd = [ci.C[0] * res.Cd / res.C, ci.C[1] * res.Cd / res.C];
        if (ci.k && _isNum(w.h)) ci.kh = [ci.k[0] * w.h, ci.k[1] * w.h];
        else if (Array.isArray(f.kh)) ci.kh = [f.kh[0], f.kh[1]];
        res.source = fit.source || 'regression';
        // extra skin components of wells with separate skins
        res.skins = {};
        ['S_perf', 'S_global', 'Sf', 'Sg', 'S_total'].forEach(function (k) {
            var v = (scaleMode && k !== 'Sf') ? _num(ph[k]) : _num(ph[k], p[k]);
            if (_isNum(v)) { res.skins[k] = v; if (Array.isArray(f[k])) ci[k] = f[k]; }
        });
        if (!_isNum(res.S) && _isNum(res.skins.S_total)) res.S = res.skins.S_total;
    } else if (!fit && c.semilog && c.semilog.ok !== false) {
        var sl = c.semilog;
        res.k = _pickNum(sl, SL.k); res.kh = _num(_pickNum(sl, SL.kh), res.k * w.h);
        res.S = _pickNum(sl, SL.S); res.C = _pickNum(sl, SL.C); res.Cd = _pickNum(sl, SL.CD);
        res.pi = NaN; res.source = 'semilog';
    }
    if (!_isNum(res.pi) && c.kind !== 'rate') { res.piInput = _num(w.pi); }
    // rinv at the end of the analysed data
    var tEnd = c.adata && c.adata.t && c.adata.t.length ? c.adata.t[c.adata.t.length - 1] : NaN;
    res.rinv = _num(fit && fit.phys ? _num(fit.phys.rinv) : NaN, _rinv(res.k, tEnd, w));
    res.tEnd = tEnd;
    res.ci = ci;
    return res;
}

// Type-curve position of the reported result: the fit's own (PM = 1/A,
// TM = B), the manual match when that is the result, else the manual match.
function _tcMatch(c) {
    var f = c.fit, tc = c.st.tcMatch;
    var tcOk = !!(tc && _isNum(tc.logPM) && _isNum(tc.logTM));
    if (f && f.kind !== 'rate') {
        var ph = f.phys || {};
        if (_isNum(ph.logPM) && _isNum(ph.logTM)) return { logPM: ph.logPM, logTM: ph.logTM, source: f.source || 'fit' };
        if (f.source === 'match' && tcOk) return { logPM: tc.logPM, logTM: tc.logTM, source: 'match' };
        var sc = _scalesFor(f, c.well);
        if (sc) return { logPM: -Math.log(sc.A) / Math.LN10, logTM: Math.log(sc.B) / Math.LN10, source: f.source || 'fit' };
    }
    return tcOk ? { logPM: tc.logPM, logTM: tc.logTM, source: tc.source || 'match' } : null;
}

function reportData() {
    var c = _ctx();
    var st = c.st, ds = c.ds, fit = c.fit, w = c.well || {}, a = c.adata;
    var ci = _clientInfo();
    var hasData = !!(ds && ds.t && ds.t.length);
    var testType = (a && a.testType) || (c.kind === 'rate' ? 'rate' : w.testType) || '';
    var periodLabel = '';
    if (a && a.t && a.t.length) {
        var per = null;
        if (st.activePeriod != null && Array.isArray(a.periods)) per = a.periods[st.activePeriod] || null;
        periodLabel = (per ? 'Period ' + (Number(st.activePeriod) + 1) + ': ' : '') +
            'Δt ' + _fmt(a.t[0], 3) + '–' + _fmt(a.t[a.t.length - 1], 4) + ' h';
    } else if (hasData) {
        periodLabel = 't ' + _fmt(ds.t[0], 3) + '–' + _fmt(ds.t[ds.t.length - 1], 4) + ' h';
    }
    var model = {
        ok: true, generatedAt: _today(), kind: c.kind, hasData: hasData, mode: c.mode,
        header: {
            client: ci.client, well: ci.well, field: ci.field, operator: ci.operator, ref: ci.ref, engineer: ci.engineer,
            testType: testType, testLabel: _testLabel(testType), periodLabel: periodLabel,
            nPoints: hasData ? ds.t.length : 0, datasetName: (ds && (ds.name || ds.fileName)) || ''
        },
        model: c.modelKey ? {
            key: c.modelKey, label: _modelLabel(c.modelKey),
            category: c.entry && c.entry.category || '', description: c.entry && c.entry.description || '',
            reference: c.entry && c.entry.reference || ''
        } : null,
        fit: fit, stale: !!(fit && fit.stale), units: _units(w.fluid),
        warnings: [], well: w
    };
    if (fit && Array.isArray(fit.warnings)) model.warnings = model.warnings.concat(fit.warnings);
    if (a && Array.isArray(a.warnings)) model.warnings = model.warnings.concat(a.warnings);
    model.warnings = model.warnings.filter(function (x, i, arr) { return x && arr.indexOf(x) === i; }).map(String);

    // Results
    var res = _physResults(c);
    model.res = res;
    model.skin = (c.kind !== 'rate') ? _skinBlock(c, res) : null;
    model.decomp = (c.kind !== 'rate' && _isNum(res.S)) ? _decomp(c, res) : null;
    model.stats = fit ? {
        source: fit.source || 'regression', r2: fit.r2, rmse: fit.rmse, aic: fit.aic, dAIC: (_isNum(fit.dAICnext) && fit.dAICnext > 0) ? fit.dAICnext : ((_isNum(fit.dAIC) && fit.dAIC > 0) ? fit.dAIC : NaN), secondModelKey: fit.secondModelKey || '',
        iterations: _num(fit.iterations), converged: fit.converged, objective: fit.objective || '',
        window: fit.window || null, identifiable: fit.identifiable || null, elapsedMs: _num(fit.elapsedMs)
    } : null;
    model.tc = (c.kind !== 'rate') ? _tcMatch(c) : null;
    model.params = _paramRows(c);
    model.interp = _interp(c);
    model.comparison = _comparison(c);
    model.pins = _pins(c);
    model.regimes = _regimes(c);
    model.semilog = _semilogBlock(c, res);
    model.keys = _keyResults(st.analysisKeyResults);
    model.decline = _decline(c);
    model.data = a ? {
        n: a.n || a.t.length, t0: a.t[0], t1: a.t[a.t.length - 1], pRef: a.pRef, pRefSource: a.pRefSource,
        pRefLabel: PREF_LABELS[a.pRefSource] || a.pRefSource || '', testType: a.testType, tp: _num(a.tp),
        timeFn: a.timeFn || '', L: _num(a.L), fluid: a.fluid || w.fluid, local: !!a.local
    } : null;
    model.inputs = _inputRows(c);
    model.results = _resultRows(model, c);
    model.notes = _notes();
    model.ctx = c;
    return model;
}

function _paramRows(c) {
    var fit = c.fit, st = c.st, rows = [];
    var params = (fit && fit.params) || st.params || {};
    var ci = (fit && fit.ci95) || {};
    var spec = (c.entry && c.entry.paramSpec) || [];
    var seen = {};
    function push(key, label, unit) {
        var v = params[key];
        seen[key] = true;
        if (v == null) return;
        var num = _isNum(v);
        rows.push({
            key: key, label: label || key, unit: unit && unit !== '-' ? unit : '',
            value: num ? v : (Array.isArray(v) ? '(' + v.length + ' items)' : String(v)),
            lo: Array.isArray(ci[key]) ? ci[key][0] : NaN, hi: Array.isArray(ci[key]) ? ci[key][1] : NaN,
            frozen: !!(st.paramFreeze && st.paramFreeze[key]),
            identifiable: fit && fit.identifiable ? fit.identifiable[key] : undefined
        });
    }
    spec.forEach(function (s) { push(s.key, s.label, s.unit); });
    for (var k in params) if (_own(params, k) && !seen[k] && k.indexOf('__') !== 0) push(k, k, '');
    return rows;
}

function _semilogBlock(c, res) {
    var sl = c.semilog;
    if (!sl || typeof sl !== 'object' || sl.ok === false) return null;
    var o = {
        method: _pick(sl, ['method', 'kind']) || '', methodLabel: sl.methodLabel || '', m: _pickNum(sl, SL.m), b: _pickNum(sl, SL.b),
        kh: _pickNum(sl, SL.kh), k: _pickNum(sl, SL.k), p1hr: _pickNum(sl, SL.p1hr), pStar: _pickNum(sl, SL.pStar),
        S: _pickNum(sl, SL.S), C: _pickNum(sl, SL.C), CD: _pickNum(sl, SL.CD), rinv: _pickNum(sl, SL.rinv),
        window: _pick(sl, ['window', 'win']) || null, warnings: Array.isArray(sl.warnings) ? sl.warnings : []
    };
    if (!_isNum(o.k) && _isNum(o.kh) && c.well && _isNum(c.well.h)) o.k = o.kh / c.well.h;
    if (c.fit && c.fit.kind !== 'rate' && _isNum(res.k) && _isNum(o.k)) {
        o.dk_pct = 100 * (o.k - res.k) / res.k;
        o.dS = _isNum(res.S) && _isNum(o.S) ? o.S - res.S : NaN;
        o.agree = Math.abs(o.dk_pct) <= 5 && (!_isNum(o.dS) || Math.abs(o.dS) <= 0.3);
    }
    return o;
}

// analysisKeyResults (plot keys, WP10) → flat rows {label, value, unit}
function _keyResults(akr) {
    var rows = [];
    if (!akr || typeof akr !== 'object') return rows;
    var list = Array.isArray(akr) ? akr : Object.keys(akr).map(function (k) {
        var v = akr[k];
        return (v && typeof v === 'object') ? Object.assign({ key: k }, v) : { key: k, value: v };
    });
    list.forEach(function (r) {
        if (!r) return;
        var name = r.label || r.name || r.key || '';
        if (_isNum(r.value)) { rows.push({ label: name, value: r.value, unit: r.unit || '' }); return; }
        var box = r.results || r.result || r.values || null;
        if (box && typeof box === 'object') {
            for (var k in box) if (_own(box, k) && _isNum(box[k])) rows.push({ label: name + ' — ' + k, value: box[k], unit: '' });
        }
    });
    return rows.slice(0, 40);
}

var INPUT_DEFS = [
    ['testType', 'Test type', ''], ['pi', 'Initial reservoir pressure pi', 'psia'],
    ['q', 'Rate q', 'q'], ['B', 'Formation volume factor B', 'B'], ['mu', 'Viscosity μ', 'cp'],
    ['ct', 'Total compressibility ct', '1/psi'], ['h', 'Net pay h', 'ft'], ['phi', 'Porosity φ', 'fraction'],
    ['rw', 'Wellbore radius rw', 'ft'], ['T_F', 'Reservoir temperature', '°F'], ['fluid', 'Fluid', ''],
    ['tp', 'Producing time before shut-in tp', 'h'], ['tShut', 'Shut-in time', 'h'], ['pwf0', 'Flowing pressure at shut-in', 'psia']
];
function _inputRows(c) {
    var w = c.well || {}, u = _units(w.fluid), rows = [];
    INPUT_DEFS.forEach(function (d) {
        var key = d[0], v = w[key];
        if (v == null || (typeof v === 'number' && !isFinite(v))) {
            if (key === 'tp' || key === 'tShut' || key === 'pwf0' || key === 'T_F') return;   // optional
        }
        var unit = d[2] === 'q' ? u.q : d[2] === 'B' ? u.B : d[2];
        var pv = w.provenance || {};
        var prov = key === 'fluid' ? (pv.fluidType || pv.fluid || '') : key === 'testType' ? (pv.testType || '') : _provOf(w, key);
        var missing = (w.missing || []).indexOf(key) >= 0 || (key === 'pi' && !_isNum(v));
        rows.push({
            key: key, label: d[1], unit: unit,
            value: typeof v === 'number' ? v : (key === 'testType' ? _testLabel(v) : (v == null ? '' : String(v))),
            provenance: prov, isDefault: prov === 'default' && key !== 'fluid' && key !== 'testType', missing: missing
        });
    });
    return rows;
}

function _resultRows(m, c) {
    var r = m.res, u = m.units, rows = [], src = r.source || '';
    function add(key, label, v, unit, sig, lo, hi, source, note) {
        if (!_isNum(v)) return;
        rows.push({ key: key, label: label, value: v, unit: unit, sig: sig || 3, lo: lo, hi: hi,
                    source: source || src, note: note || '' });
    }
    var ci = r.ci || {};
    var idf = (m.fit && m.fit.identifiable) || {};
    function note(k) { return idf[k] === false ? 'not resolved by the data' : ''; }
    if (c.kind === 'rate') return rows;
    add('k', 'Permeability k', r.k, 'md', 3, ci.k && ci.k[0], ci.k && ci.k[1], src, note('k'));
    add('kh', 'Permeability-thickness kh', r.kh, 'md·ft', 4, ci.kh && ci.kh[0], ci.kh && ci.kh[1], src);
    add('C', 'Wellbore storage C', r.C, 'bbl/psi', 3, ci.C && ci.C[0], ci.C && ci.C[1], src, note('C'));
    add('Cd', 'Dimensionless storage CD', r.Cd, '', 3, ci.Cd && ci.Cd[0], ci.Cd && ci.Cd[1], src);
    add('S', 'Skin S', r.S, '', 3, ci.S && ci.S[0], ci.S && ci.S[1], src, note('S'));
    if (!_isNum(r.S) && r.scaleMode) {
        rows.push({ key: 'S', label: 'Skin S', value: NaN, text: 'not identifiable (enter φ, ct, rw)', unit: '', sig: 3,
                    lo: NaN, hi: NaN, source: src, note: '' });
    }
    for (var sk in r.skins || {}) if (_own(r.skins, sk) && sk !== 'S_total') {
        add(sk, 'Skin component ' + sk, r.skins[sk], '', 3, ci[sk] && ci[sk][0], ci[sk] && ci[sk][1], src, note(sk));
    }
    if (_isNum(r.pi)) add('pi', 'Initial pressure pi', r.pi, 'psia', 5, ci.pi && ci.pi[0], ci.pi && ci.pi[1], src, 'fitted');
    else if (_isNum(r.piInput)) add('pi', 'Initial pressure pi', r.piInput, 'psia', 5, NaN, NaN, 'input');
    add('xf', 'Fracture half-length xf', r.xf, 'ft', 3, ci.xf && ci.xf[0], ci.xf && ci.xf[1], src, note('xf'));
    add('Lh', 'Horizontal length Lh', r.Lh, 'ft', 3, ci.Lh && ci.Lh[0], ci.Lh && ci.Lh[1], src, note('Lh'));
    var d = r.distances;
    if (d && typeof d === 'object') {
        var labels = {};
        ((c.entry && c.entry.paramSpec) || []).forEach(function (s) { labels[s.key] = s.label; });
        if (Array.isArray(d)) d.forEach(function (v, i) { add('dist' + i, 'Distance to boundary ' + (i + 1), v, 'ft', 3); });
        else for (var dk in d) if (_own(d, dk)) add('dist_' + dk, 'Distance to boundary (' + (labels[dk] || dk) + ')', d[dk], 'ft', 3);
    }
    add('rinv', 'Radius of investigation (end of data)', r.rinv, 'ft', 4, NaN, NaN, 'derived');
    var s = m.skin;
    if (s) {
        add('dpS', 'Pressure drop due to skin ΔpS', s.dpS, 'psi', 3, NaN, NaN, 'derived');
        add('FE', 'Flow efficiency FE', s.FE, '', 3, NaN, NaN, 'derived');
        add('DR', 'Damage ratio DR', s.DR, '', 3, NaN, NaN, 'derived');
        add('J', 'Productivity index J', s.J, u.J, 3, NaN, NaN, 'derived');
        add('J_ideal', 'Productivity index without skin', s.J_ideal, u.J, 3, NaN, NaN, 'derived');
        add('rwa', 'Effective wellbore radius rw′', s.rwa, 'ft', 3, NaN, NaN, 'derived');
    }
    return rows;
}

function _notes() {
    try { var ls = _ls(); return (ls && ls.getItem('wts_prism_report_notes')) || ''; } catch (e) { return ''; }
}

// Compact results for the rail / quick report / job report summary.
function reportResults() {
    var m = reportData(), r = m.res || {}, s = m.skin || {}, f = m.fit;
    return {
        ok: !!(f || (m.semilog && _isNum(m.semilog.k))),
        modelKey: m.model ? m.model.key : null, modelLabel: m.model ? m.model.label : '',
        kind: m.kind, source: r.source || (f && f.source) || '', sourceLabel: _sourceLabel(r.source || (f && f.source)),
        stale: m.stale, converged: f ? f.converged : undefined, iterations: f ? _num(f.iterations) : NaN,
        r2: f ? f.r2 : NaN, rmse: f ? f.rmse : NaN, rmseUnit: m.kind === 'rate' ? m.units.q : 'psi', aic: f ? f.aic : NaN,
        k: r.k, kh: r.kh, C: r.C, Cd: r.Cd, S: r.S, pi: _num(r.pi, r.piInput), xf: r.xf, Lh: r.Lh, rinv: r.rinv,
        dpS: s.dpS, FE: s.FE, DR: s.DR, J: s.J, J_ideal: s.J_ideal, rwa: s.rwa, ci: r.ci || {},
        narrative: m.interp ? m.interp.narrative : '', semilog: m.semilog, decline: m.decline,
        testType: m.header.testType, units: m.units
    };
}

// ───────────────────────────────────────────────────────────────────
// SECTION 7 — CSV
// ───────────────────────────────────────────────────────────────────
var CSV_PRESSURE = ['t_hr', 'p_psia', 'q', 'dp_psi', 'dp_deriv_psi', 'model_dp_psi', 'model_dp_deriv_psi', 'residual_psi'];
var CSV_RATE = ['t_day', 'q', 'model_q', 'residual_q'];
function _csvNum(v) { return _isNum(v) ? String(+v.toPrecision(10)) : ''; }

function buildReportCSV() {
    var c = _ctx(), ds = c.ds;
    if (!ds || !ds.t || !ds.t.length) throw new Error('No dataset loaded — load data on step ① first.');
    var rows = [], header, kind;
    var mk = c.modelKey || 'data';
    if (c.kind === 'rate') {
        kind = 'rate'; header = CSV_RATE.slice();
        var td = [], qd = [];
        for (var i = 0; i < ds.t.length; i++) {
            if (!_isNum(ds.t[i]) || !(ds.t[i] > 0) || !ds.q || !_isNum(ds.q[i])) continue;
            td.push(ds.t[i] / 24); qd.push(ds.q[i]);
        }
        var mq = c.fit ? _evalRate(c, td) : null;
        for (var j = 0; j < td.length; j++) {
            var m = mq && mq.q ? mq.q[j] : NaN;
            rows.push([td[j], qd[j], m, _isNum(m) ? qd[j] - m : NaN]);
        }
    } else {
        kind = 'pressure'; header = CSV_PRESSURE.slice();
        var a = c.adata;
        if (!a) throw new Error('No pressure data to export.');
        var q = _qAt(ds, a);
        var model = _modelAt(c, a.t);
        var shift = 0;
        // A fit that floated pi measures Δp from its own pi (drawdown/injection).
        if (c.fit && _isNum(c.fit.pRef) && _isNum(a.pRef) && Math.abs(c.fit.pRef - a.pRef) > 1e-9 &&
            (a.testType === 'drawdown' || a.testType === 'injection')) {
            shift = _pRefDir(a) * (c.fit.pRef - a.pRef);
        }
        for (var k = 0; k < a.t.length; k++) {
            var dp = a.dp[k] + shift;
            var md = model && model.dp ? model.dp[k] : NaN;
            var mdd = model && model.deriv ? model.deriv[k] : NaN;
            rows.push([a.t[k], a.p[k], q[k], dp, a.deriv ? a.deriv[k] : NaN, md, mdd, _isNum(md) ? dp - md : NaN]);
        }
    }
    var lines = [header.join(',')];
    rows.forEach(function (r) { lines.push(r.map(_csvNum).join(',')); });
    var ci = _clientInfo();
    var d = new Date();
    var stamp = d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2);
    var filename = 'prism_' + (ci.well ? _slug(ci.well) + '_' : '') + _slug(mk) + '_' + stamp + '.csv';
    return { filename: filename, header: header, rows: rows, text: lines.join('\n'), kind: kind };
}

function _download(filename, text, mime) {
    if (!_hasDoc) return false;
    try {
        var blob = new Blob([text], { type: mime || 'text/csv' });
        var url = (typeof URL !== 'undefined' && URL.createObjectURL) ? URL.createObjectURL(blob)
            : 'data:' + (mime || 'text/csv') + ';charset=utf-8,' + encodeURIComponent(text);
        var a = document.createElement('a');
        a.href = url; a.download = filename; a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        try { document.body.removeChild(a); } catch (e) {}
        if (/^blob:/.test(url) && URL.revokeObjectURL) setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 1000);
        return true;
    } catch (e) { _warn('[report] download failed', e); return false; }
}

function exportCSV() {
    var r = buildReportCSV();
    r.downloaded = _download(r.filename, r.text, 'text/csv');
    return r;
}

// ───────────────────────────────────────────────────────────────────
// SECTION 8 — PLOTS (C6 payloads via PRiSM_buildPlotData, else local)
// ───────────────────────────────────────────────────────────────────
var DEFAULT_PLOT_FN = {
    bourdet: 'PRiSM_plot_bourdet', cartesian: 'PRiSM_plot_cartesian', horner: 'PRiSM_plot_horner',
    mdh: 'PRiSM_plot_mdh', superposition: 'PRiSM_plot_buildup_superposition',
    rateSemi: 'PRiSM_plot_rate_time_semilog', rateCum: 'PRiSM_plot_rate_cumulative'
};
function _plotFn(key) {
    var reg = G.PRiSM_PLOT_REGISTRY, e = reg && reg[key], fn = e ? e.fn : DEFAULT_PLOT_FN[key];
    if (typeof fn === 'function') return fn;
    if (typeof fn === 'string' && typeof G[fn] === 'function') return G[fn];
    if (DEFAULT_PLOT_FN[key] && typeof G[DEFAULT_PLOT_FN[key]] === 'function') return G[DEFAULT_PLOT_FN[key]];
    return null;
}
function _semilogKey(c) {
    var sl = c.semilog, mth = sl ? String(_pick(sl, ['method', 'kind']) || '').toLowerCase() : '';
    if (/horner/.test(mth)) return 'horner';
    if (/super/.test(mth)) return 'superposition';
    if (/mdh|agarwal/.test(mth)) return 'mdh';
    var tt = c.adata && c.adata.testType;
    return (tt === 'buildup' || tt === 'falloff') ? 'horner' : 'mdh';
}
function _plotSpecs(c) {
    var withModel = c.fit ? ' with the model' : '', withLine = c.semilog ? ' with the straight line' : '';
    if (c.kind === 'rate') {
        return [
            { id: 'rate', key: 'rateSemi', title: 'Rate vs time' + (c.fit ? ' with the decline model' : '') },
            { id: 'cum', key: 'rateCum', title: 'Rate vs cumulative production' }
        ];
    }
    var sk = _semilogKey(c);
    return [
        { id: 'loglog', key: 'bourdet', title: 'Log-log diagnostic: Δp and derivative' + withModel },
        { id: 'semilog', key: sk, title: (sk === 'horner' ? 'Horner plot' : sk === 'superposition' ? 'Superposition plot' : 'Semilog (MDH) plot') + withLine },
        { id: 'history', key: 'cartesian', title: 'Pressure and rate history' + withModel }
    ];
}
function _semilogLine(c) {
    var sl = c.semilog;
    if (!sl) return null;
    var m = _pickNum(sl, SL.m), b = _pickNum(sl, SL.b), p1 = _pickNum(sl, SL.p1hr);
    if (sl.line && _isNum(sl.line.m) && _isNum(sl.line.b)) return sl.line;
    if (!_isNum(m)) return null;
    var w = _pick(sl, ['window', 'win']) || {};
    var falling = c.adata && (c.adata.testType === 'drawdown' || c.adata.testType === 'falloff');
    var sm = (falling && m > 0) ? -m : m;
    if (!_isNum(b) && _isNum(p1)) b = p1;
    return _isNum(b) ? { m: sm, b: b, t0: w.t0, t1: w.t1 } : null;
}
function _localPlotData(c, spec) {
    var a = c.adata, ds = c.ds, st = c.st, data = null, opts = {};
    if (spec.key === 'bourdet' && a) {
        data = { t: a.t.slice(), dp: a.dp.slice(), deriv: a.deriv ? a.deriv.slice() : null, x: a.x || null };
        opts.smoothL = _isNum(st.bourdetL) ? st.bourdetL : 0.1;
    } else if ((spec.key === 'mdh' || spec.key === 'horner' || spec.key === 'superposition') && a) {
        data = { t: a.t.slice(), p: a.p.slice(), dp: a.dp.slice(), tp: _num(a.tp, c.well && c.well.tp) };
        var line = _semilogLine(c);
        if (line) data.line = line;
    } else if (spec.key === 'cartesian' && ds && ds.p) {
        data = { t: ds.t.slice(), p: ds.p.slice(), q: ds.q ? ds.q.slice() : null, periods: a && a.periods ? a.periods : [] };
    } else if ((spec.key === 'rateSemi' || spec.key === 'rateCum') && ds && ds.q) {
        var t = [], q = [];
        for (var i = 0; i < ds.t.length; i++) if (_isNum(ds.t[i]) && ds.t[i] > 0 && _isNum(ds.q[i])) { t.push(ds.t[i] / 24); q.push(ds.q[i]); }
        data = { t: t, q: q };
        opts.xLabel = 'Time (days)'; opts.timeUnit = 'd';
    }
    return data ? { data: data, opts: opts } : null;
}
function _withOverlay(c, spec, payload) {
    var d = payload.data;
    if (!d || d.overlay || !c.fit) return payload;
    try {
        if (spec.key === 'bourdet' && c.adata && c.adata.t.length) {
            var a = c.adata, t0 = Math.min.apply(null, a.t), t1 = Math.max.apply(null, a.t);
            var tm = _logspace(t0, t1, 120), mm = _modelAt(c, tm);
            if (mm && mm.dp) d.overlay = { t: tm, dp: mm.dp, deriv: mm.deriv || null };
        } else if (spec.key === 'cartesian' && c.adata && c.adata.t.length) {
            var ad = c.adata, m2 = _modelAt(c, ad.t);
            if (m2 && m2.p) d.overlay = { t: ad.tAbs ? ad.tAbs.slice() : ad.t.map(function (x) { return x + (ad.tStart || 0); }), p: m2.p };
        } else if ((spec.key === 'rateSemi' || spec.key === 'rateCum') && d.t && d.t.length && c.kind === 'rate') {
            var mr = _evalRate(c, d.t.slice());
            if (mr && mr.q) d.overlay = { t: d.t.slice(), q: mr.q };
        }
    } catch (e) { _warn('[report] overlay failed', e); }
    return payload;
}
function _plotPayload(c, spec) {
    var payload = null;
    if (typeof G.PRiSM_buildPlotData === 'function') {
        try {
            var r = G.PRiSM_buildPlotData(spec.key);
            if (r && r.data) payload = { data: r.data, opts: _copy(r.opts) };
        } catch (e) { payload = null; }
    }
    if (!payload) payload = _localPlotData(c, spec);
    if (!payload) return null;
    if ((spec.key === 'mdh' || spec.key === 'horner' || spec.key === 'superposition') && !payload.data.line) {
        var line = _semilogLine(c);
        if (line) payload.data.line = line;
    }
    return _withOverlay(c, spec, payload);
}
function _drawPlot(canvas, c, spec, size) {
    var fn = _plotFn(spec.key);
    if (!fn) return false;
    var payload = _plotPayload(c, spec);
    if (!payload) return false;
    var opts = _copy(payload.opts);
    opts.width = size.width; opts.height = size.height;
    opts.hover = !!size.hover; opts.dragZoom = false; opts.showLegend = true;
    try { fn(canvas, payload.data, opts); } catch (e) { _warn('[report] plot ' + spec.key + ' failed', e); return false; }
    var hooks = G.PRiSM_postDrawHooks;
    if (Array.isArray(hooks)) hooks.forEach(function (h) {
        try { if (typeof h === 'function') h({ canvas: canvas, plotKey: spec.key, data: payload.data, opts: opts, axes: canvas._prismAxes || null, report: true }); }
        catch (e) {}
    });
    return true;
}
function _plotImages(c) {
    var out = [];
    if (!_hasDoc) return out;
    _plotSpecs(c).forEach(function (spec) {
        if (!_plotFn(spec.key)) return;
        try {
            var cv = document.createElement('canvas');
            cv.width = 900; cv.height = 480;
            if (!_drawPlot(cv, c, spec, { width: 900, height: 480, hover: false })) return;
            var url = cv.toDataURL('image/png');
            if (url) out.push({ title: spec.title, src: url, key: spec.key });
        } catch (e) { _warn('[report] plot image failed', e); }
    });
    return out;
}

// ───────────────────────────────────────────────────────────────────
// SECTION 9 — PDF / job-report HTML (host rp-* report classes)
// ───────────────────────────────────────────────────────────────────
function _valueStr(row) {
    if (row.text) return { str: row.text, pm: '', full: row.text };
    var str = row.key === 'S' || /^S_|^Sf|^Sg/.test(row.key) ? _fixed(row.value, 2)
        : row.key === 'pi' ? _fixed(row.value, 1) : _fmt(row.value, row.sig);
    var pm = _fmtPM(row.value, str, row.lo, row.hi);
    return { str: str, pm: pm, full: str + (pm ? ' ± ' + pm : '') };
}
function _rpKV(pairs) {
    return '<div class="rp-kv">' + pairs.filter(function (p) { return p && p[1] !== '' && p[1] != null; }).map(function (p) {
        return '<div class="rp-kvr"><span>' + _esc(p[0]) + '</span><b>' + _esc(p[1]) + '</b></div>';
    }).join('') + '</div>';
}
function _rpTable(head, rows) {
    return '<div class="rp-tblwrap"><table class="rp-tbl"><thead><tr>' +
        head.map(function (h) { return '<th>' + _esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' +
        rows.map(function (r) { return '<tr>' + r.map(function (cell, i) {
            return '<td' + (i === 0 ? ' class="b"' : '') + '>' + cell + '</td>'; }).join('') + '</tr>'; }).join('') +
        '</tbody></table></div>';
}
function _statsPairs(m) {
    var s = m.stats, u = m.kind === 'rate' ? m.units.q : 'psi', out = [];
    if (m.model) out.push(['Model', m.model.label + ' (' + m.model.key + ')']);
    if (s) {
        out.push(['Result from', _sourceLabel(s.source)]);
        out.push(['R²', _isNum(s.r2) ? s.r2.toFixed(s.r2 >= 0.99999 ? 6 : 5) : '—']);
        out.push(['RMSE', _isNum(s.rmse) ? _fmt(s.rmse, 3) + ' ' + u : '—']);
        out.push(['AIC', _isNum(s.aic) ? s.aic.toFixed(1) : '—']);
        if (_isNum(s.dAIC)) out.push(['ΔAIC to the next model' + (s.secondModelKey ? ' (' + _modelLabel(s.secondModelKey) + ')' : ''), s.dAIC.toFixed(1)]);
        out.push(['Iterations', _isNum(s.iterations) ? String(Math.round(s.iterations)) : '—']);
        out.push(['Converged', s.converged === true ? 'yes' : s.converged === false ? 'no' : '—']);
        if (s.window && (_isNum(s.window.tmin) || _isNum(s.window.tmax))) {
            out.push(['Fit window', _fmt(s.window.tmin, 3) + '–' + _fmt(s.window.tmax, 4) + ' h']);
        }
    }
    if (m.tc) {
        out.push(['Pressure match (log PM)', m.tc.logPM.toFixed(3)]);
        out.push(['Time match (log TM)', m.tc.logTM.toFixed(3)]);
    }
    return out;
}
function _unresolved(m) {
    var idf = m.stats && m.stats.identifiable, bad = [];
    if (idf) for (var k in idf) if (_own(idf, k) && idf[k] === false) bad.push(k);
    return bad;
}

function buildReportHTML(opts) {
    opts = opts || {};
    var m = opts.model || reportData();
    var h = '', u = m.units;
    var hd = m.header;
    // Test & well summary
    h += '<section class="rp-sec"><h2>Well test</h2>' + _rpKV([
        ['Client', hd.client], ['Well', hd.well], ['Field', hd.field],
        ['Test type', hd.testLabel], ['Analysed period', hd.periodLabel],
        ['Data points', hd.nPoints ? String(hd.nPoints) : ''], ['Model', m.model ? m.model.label : ''],
        ['Report date', m.generatedAt]
    ]) + '</section>';
    if (!m.hasData) {
        h += '<div class="rp-note n-amber"><b>No data.</b>Load pressure or rate data in PRiSM before issuing a report.</div>';
        return h;
    }
    if (m.stale) h += '<div class="rp-note n-amber"><b>Check:</b>The fit was made on different data or a different model. Re-run the fit before relying on these numbers.</div>';
    if (!m.fit) h += '<div class="rp-note n-blue"><b>No model fit yet.</b>Results below come from the straight-line analysis and inputs only.</div>';

    // Key results
    if (m.results.length) {
        h += '<section class="rp-sec rp-out"><h2>Key results (field units)</h2>' + _rpTable(
            ['Quantity', 'Value ± 95 % CI', 'Unit', 'Source'],
            m.results.map(function (r) {
                var v = _valueStr(r);
                return [_esc(r.label), '<b>' + _esc(v.full) + '</b>', _esc(r.unit || '–'),
                        _esc(_sourceLabel(r.source)) + (r.note ? ' <span class="s-amber">(' + _esc(r.note) + ')</span>' : '')];
            })) + '</section>';
    }
    // Decline block
    if (m.decline) h += _declineHTML(m.decline, u, true);
    // Fit quality
    if (m.stats || m.tc) {
        h += '<section class="rp-sec"><h2>Fit quality</h2>' + _rpKV(_statsPairs(m));
        var bad = _unresolved(m);
        if (bad.length) h += '<div class="rp-note n-amber"><b>Not resolved by the data:</b>' + _esc(bad.join(', ')) + '</div>';
        h += '</section>';
    }
    // Interpretation
    if (m.interp && (m.interp.narrative || m.interp.actions.length)) {
        h += '<section class="rp-sec"><h2>Interpretation</h2>';
        if (m.interp.narrative) h += '<div class="rp-note n-blue">' + _esc(m.interp.narrative) + '</div>';
        if (m.interp.actions.length) h += '<ul>' + m.interp.actions.map(function (a) { return '<li>' + _esc(a) + '</li>'; }).join('') + '</ul>';
        m.interp.cautions.forEach(function (x) { h += '<div class="rp-note n-amber">' + _esc(x) + '</div>'; });
        h += '</section>';
    }
    if (m.notes) h += '<section class="rp-sec"><h2>Analyst comments</h2><p>' + _esc(m.notes).replace(/\n/g, '<br>') + '</p></section>';
    m.warnings.forEach(function (x) { h += '<div class="rp-note n-amber">' + _esc(x) + '</div>'; });
    // Plots
    if (opts.plots !== false) {
        var imgs = _plotImages(m.ctx);
        if (imgs.length) {
            h += '<section class="rp-sec"><h2>Plots</h2>' + imgs.map(function (im) {
                return '<div class="rp-fig"><img src="' + _esc(im.src) + '" alt="' + _esc(im.title) + '"><div class="rp-modsub">' + _esc(im.title) + '</div></div>';
            }).join('') + '</section>';
        }
    }
    // Model comparison
    if (m.comparison.length) {
        var ct = _comparisonTable(m, ' (reported)');
        h += '<section class="rp-sec"><h2>Model comparison</h2>' + _rpTable(ct.head, ct.rows) +
            '<p class="rp-modsub">ΔAIC below 2: the data cannot separate the models; above 10: strong preference.</p></section>';
    }
    if (m.pins.length) {
        var pt = _pinsTable(m);
        h += '<section class="rp-sec"><h2>Pinned results</h2>' + _rpTable(pt.head, pt.rows) + '</section>';
    }
    // Straight-line results
    if (m.semilog || m.keys.length) h += _straightLineHTML(m, true);
    // Skin
    if (m.skin || m.decomp) h += _skinHTML(m, true);
    // Flow regimes
    if (m.regimes && m.regimes.list.length) {
        h += '<section class="rp-sec"><h2>Flow regimes seen in the derivative</h2>' + _rpTable(['Regime', 'From (h)', 'To (h)'],
            m.regimes.list.map(function (g) { return [_esc(g.label), _fmt(g.t0, 3), _fmt(g.t1, 3)]; })) + '</section>';
    }
    // Data summary
    if (m.data) {
        h += '<section class="rp-sec"><h2>Data used</h2>' + _rpKV([
            ['Points analysed', String(m.data.n)], ['Δt range', _fmt(m.data.t0, 3) + '–' + _fmt(m.data.t1, 4) + ' h'],
            ['Reference pressure', _fixed(m.data.pRef, 1) + ' psia'], ['Reference source', m.data.pRefLabel],
            ['Test type', _testLabel(m.data.testType)], ['tp', _isNum(m.data.tp) ? _fmt(m.data.tp, 4) + ' h' : ''],
            ['Time function', m.data.timeFn], ['Derivative smoothing L', _isNum(m.data.L) ? String(m.data.L) : '']
        ]) + '</section>';
    }
    // Model parameters
    if (m.params.length) {
        h += '<section class="rp-sec"><h2>Model parameters (dimensionless)</h2>' + _rpTable(['Parameter', 'Value ± 95 % CI', 'Unit', 'Held fixed'],
            m.params.map(function (p) {
                var s = typeof p.value === 'number' ? _fmt(p.value, 4) : p.value;
                var pm = typeof p.value === 'number' ? _fmtPM(p.value, s, p.lo, p.hi) : '';
                return [_esc(p.label), _esc(s + (pm ? ' ± ' + pm : '')), _esc(p.unit || '–'), p.frozen ? 'yes' : ''];
            })) + '</section>';
    }
    // Appendix — inputs
    if (m.inputs.length) {
        h += '<section class="rp-sec rp-in"><h2>Appendix — inputs and where they came from</h2>' + _rpTable(['Input', 'Value', 'Unit', 'Source'],
            m.inputs.map(function (r) {
                var v = typeof r.value === 'number' ? _fmt(r.value, 4) : (r.value || '—');
                var src = r.missing ? '<span class="s-red">missing</span>' : r.isDefault ? '<span class="s-amber">default — not confirmed</span>' : _esc(_provLabel(r.provenance));
                return [_esc(r.label), _esc(v), _esc(r.unit || '–'), src];
            })) + '</section>';
    }
    if (m.model && (m.model.description || m.model.reference)) {
        h += '<section class="rp-sec"><h2>Model reference</h2><p>' + _esc(m.model.description) + '</p>' +
            (m.model.reference ? '<p class="rp-modsub">' + _esc(m.model.reference) + '</p>' : '') + '</section>';
    }
    return h;
}
var PROV_LABELS = { user: 'entered', sample: 'demo data', dataset: 'from the data file', deconvolution: 'from deconvolution', project: 'project file', computed: 'computed from correlations', correlation: 'computed from correlations' };
function _provLabel(p) { return PROV_LABELS[p] || (p ? _humanize(p) : ''); }

// Volumes: rounded, with thousands separators and the fluid's volume unit.
function _vol(v, u, bare) {
    if (!_isNum(v)) return '';
    var s = Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return bare ? s : s + ' ' + ((u && u.vol) || 'STB');
}
function _declineHTML(d, u, pdf) {
    var pairs = [
        ['Initial rate qi', _fmt(d.qi, 4) + ' ' + u.q], ['Initial decline Di', _fmt(d.Di, 3) + ' 1/d'],
        ['Annual nominal decline', _isNum(d.Di_yr) ? _fmt(d.Di_yr, 3) + ' 1/yr' : ''],
        ['Effective annual decline', _isNum(d.De) ? _fmt(100 * d.De, 3) + ' %' : ''], ['b-factor', _fmt(d.b, 3)],
        ['Abandonment rate', _isNum(d.q_ab) ? _fmt(d.q_ab, 3) + ' ' + u.q : ''],
        ['Time to abandonment', _isNum(d.t_ab) ? _fmt(d.t_ab / 365, 3) + ' yr' : ''],
        ['Produced to date', _vol(d.Np_hist, u)], [d.eurLabel, _vol(d.EUR, u)], ['Remaining', _vol(d.remaining, u)],
        ['Low / mid / high (P90 / P50 / P10)', _isNum(d.P50) ? _vol(d.P90, u, true) + ' / ' + _vol(d.P50, u, true) + ' / ' + _vol(d.P10, u) : '']
    ];
    if (pdf) {
        return '<section class="rp-sec rp-out"><h2>Decline results</h2>' + _rpKV(pairs) +
            d.warnings.map(function (x) { return '<div class="rp-note n-amber">' + _esc(x) + '</div>'; }).join('') + '</section>';
    }
    return _card('Decline results', _kvHTML(pairs) + d.warnings.map(_warnHTML).join(''));
}
function _straightLineHTML(m, pdf) {
    var s = m.semilog, pairs = [], rows = m.keys;
    if (s) {
        pairs = [
            ['Method', s.methodLabel || (s.method ? (String(s.method).toUpperCase() === 'MDH' ? 'MDH (drawdown semilog)' : _humanize(s.method)) : '')],
            ['Straight-line window', s.window && _isNum(s.window.t0) ? _fmt(s.window.t0, 3) + '–' + _fmt(s.window.t1, 4) + ' h' : ''],
            ['Slope m', _isNum(s.m) ? _fmt(Math.abs(s.m), 4) + ' psi/cycle' : ''], ['kh', _isNum(s.kh) ? _fmt(s.kh, 4) + ' md·ft' : ''],
            ['k', _isNum(s.k) ? _fmt(s.k, 3) + ' md' : ''], ['p at 1 h', _isNum(s.p1hr) ? _fixed(s.p1hr, 1) + ' psia' : ''],
            ['Extrapolated pressure p*', _isNum(s.pStar) ? _fixed(s.pStar, 1) + ' psia' : ''], ['Skin S', _fixed(s.S, 2)],
            ['Storage C (unit slope)', _isNum(s.C) ? _fmt(s.C, 3) + ' bbl/psi' : '']
        ];
        if (_isNum(s.dk_pct)) {
            pairs.push(['Difference from model fit', 'k ' + (s.dk_pct >= 0 ? '+' : '') + s.dk_pct.toFixed(1) + ' %' +
                (_isNum(s.dS) ? ', S ' + (s.dS >= 0 ? '+' : '') + s.dS.toFixed(2) : '')]);
        }
    }
    var keyRows = rows.map(function (r) { return [_esc(r.label), _esc(_fmt(r.value, 4)), _esc(r.unit || '')]; });
    if (pdf) {
        var h = '<section class="rp-sec"><h2>Straight-line results</h2>' + (pairs.length ? _rpKV(pairs) : '');
        if (s && _isNum(s.dk_pct)) h += '<div class="rp-note ' + (s.agree ? 'n-green' : 'n-amber') + '">' +
            (s.agree ? 'Straight-line and model results agree.' : 'Straight-line and model results differ — check the straight-line window and the model.') + '</div>';
        if (s) s.warnings.forEach(function (x) { h += '<div class="rp-note n-amber">' + _esc(x) + '</div>'; });
        if (keyRows.length) h += _rpTable(['Plot pick', 'Value', 'Unit'], keyRows);
        return h + '</section>';
    }
    var body = pairs.length ? _kvHTML(pairs) : '';
    if (s && _isNum(s.dk_pct)) body += s.agree ? _okHTML('Straight-line and model results agree.') : _warnHTML('Straight-line and model results differ — check the straight-line window and the model.');
    if (s) body += s.warnings.map(_warnHTML).join('');
    if (keyRows.length) body += _tableHTML(['Plot pick', 'Value', 'Unit'], keyRows);
    return _card('Straight-line results', body);
}
function _skinHTML(m, pdf) {
    var s = m.skin || {}, pairs = [];
    if (m.skin) {
        pairs = [
            ['Skin S', _fixed(s.S, 2)], ['Pressure drop due to skin ΔpS', _isNum(s.dpS) ? _fmt(s.dpS, 3) + ' psi' : ''],
            ['Flow efficiency FE', _fmt(s.FE, 3)], ['Damage ratio DR', _fmt(s.DR, 3)],
            ['Productivity index J', _isNum(s.J) ? _fmt(s.J, 3) + ' ' + m.units.J : ''],
            ['J without skin', _isNum(s.J_ideal) ? _fmt(s.J_ideal, 3) + ' ' + m.units.J : ''],
            ['Effective wellbore radius rw′', _isNum(s.rwa) ? _fmt(s.rwa, 3) + ' ft' : ''],
            ['Reference pressures', _isNum(s.pbar) && _isNum(s.pwf) ? s.pbarLabel + ' ' + _fixed(s.pbar, 1) + ', pwf ' + _fixed(s.pwf, 1) + ' psia' : '']
        ];
    }
    var d = m.decomp, dpairs = [];
    if (d) {
        var names = [['Partial-penetration skin', ['S_pp', 'Spp']], ['Slant skin', ['S_theta', 'S_θ', 'Stheta']],
                     ['Fracture skin', ['S_f', 'Sf']], ['Rate-dependent skin D·q', ['Dq', 'D_q', 'DQ']]];
        var anyPseudo = false;
        names.forEach(function (n) {
            var v = _pickNum(d, n[1]);
            if (_isNum(v) && Math.abs(v) > 1e-9) { anyPseudo = true; dpairs.push([n[0], _fmt(v, 3)]); }
        });
        var mech = _pickNum(d, ['S_mech', 'Smech', 'mechanical']);
        if (anyPseudo && _isNum(mech)) dpairs.unshift(['Mechanical (damage) skin', _fmt(mech, 3)]);
        if (!anyPseudo) dpairs = [];
    }
    if (pdf) {
        return '<section class="rp-sec"><h2>Skin</h2>' + (pairs.length ? _rpKV(pairs) : '') +
            (dpairs.length ? '<h3>Skin breakdown</h3>' + _rpKV(dpairs) : '') + '</section>';
    }
    return _card('Skin', (pairs.length ? _kvHTML(pairs) : '') + (dpairs.length ? '<div class="prism-rpt-sub">Skin breakdown</div>' + _kvHTML(dpairs) : ''));
}

// ───────────────────────────────────────────────────────────────────
// SECTION 10 — REPORT TAB (dark theme, 375 px safe)
// ───────────────────────────────────────────────────────────────────
var CSS_ID = 'prism-report-css';
function _injectStyles() {
    if (!_hasDoc || document.getElementById(CSS_ID)) return;
    var s = document.createElement('style');
    s.id = CSS_ID;
    s.textContent =
        '.prism-rpt{display:flex;flex-direction:column;gap:12px;min-width:0;max-width:100%;}' +
        '.prism-rpt-card{background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:12px 14px;min-width:0;}' +
        '.prism-rpt-h{font-size:12px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin:0 0 8px;}' +
        '.prism-rpt-sub{font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.4px;margin:10px 0 6px;}' +
        '.prism-rpt-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;}' +
        '.prism-rpt-tile{background:var(--bg1);border:1px solid var(--border);border-radius:6px;padding:6px 9px;min-width:0;}' +
        '.prism-rpt-tile span{display:block;font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.4px;}' +
        '.prism-rpt-tile b{display:block;font-size:13px;color:var(--text);overflow-wrap:anywhere;}' +
        '.prism-rpt-kv{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,230px),1fr));column-gap:18px;}' +
        '.prism-rpt-kvr{display:flex;justify-content:space-between;gap:10px;padding:4px 0;border-bottom:1px solid var(--border);font-size:12px;min-width:0;}' +
        '.prism-rpt-kvr span{color:var(--text2);} .prism-rpt-kvr b{color:var(--text);text-align:right;overflow-wrap:anywhere;}' +
        '.prism-rpt-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%;}' +
        '.prism-rpt-tbl{width:100%;border-collapse:collapse;font-size:12px;}' +
        '.prism-rpt-tbl th{text-align:left;font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.4px;padding:5px 6px;border-bottom:1px solid var(--border);white-space:nowrap;}' +
        '.prism-rpt-tbl td{padding:5px 6px;border-bottom:1px solid var(--border);color:var(--text);vertical-align:top;}' +
        '.prism-rpt-tbl td.v{font-weight:700;white-space:nowrap;}' +
        '.prism-chip{display:inline-block;padding:1px 7px;border-radius:10px;font-size:10.5px;border:1px solid var(--border);color:var(--text2);white-space:nowrap;}' +
        '.prism-chip--fit{border-color:var(--blue);color:var(--blue);} .prism-chip--line{border-color:var(--green);color:var(--green);}' +
        '.prism-chip--def{border-color:var(--yellow);color:var(--yellow);} .prism-chip--bad{border-color:var(--red);color:var(--red);}' +
        '.prism-rpt-note{font-size:12px;padding:7px 10px;border-radius:6px;border-left:3px solid var(--border);background:var(--bg1);color:var(--text2);margin-top:6px;}' +
        '.prism-rpt-note--warn{border-left-color:var(--yellow);} .prism-rpt-note--ok{border-left-color:var(--green);} .prism-rpt-note--info{border-left-color:var(--blue);}' +
        '.prism-rpt-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:10px;}' +
        '.prism-rpt-plots{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:10px;}' +
        '.prism-rpt-plot{min-width:0;} .prism-rpt-plot canvas{display:block;width:100%;height:280px;border-radius:6px;}' +
        '.prism-rpt-plot div{font-size:11px;color:var(--text3);margin-top:4px;}' +
        '.prism-rpt-narr{font-size:13px;line-height:1.5;color:var(--text);padding:8px 10px;background:var(--bg1);border-left:3px solid var(--blue);border-radius:4px;}' +
        '.prism-rpt textarea{width:100%;max-width:100%;min-height:70px;background:var(--bg1);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px;font:inherit;font-size:12px;box-sizing:border-box;}' +
        '@media (max-width:600px){.prism-rpt-card{padding:10px;}.prism-rpt-tbl{font-size:11px;}.prism-rpt-actions .btn{flex:1 1 auto;}}';
    try { (document.head || document.body).appendChild(s); } catch (e) {}
}
function _card(title, body, id) {
    return '<div class="prism-rpt-card"' + (id ? ' id="' + id + '"' : '') + '><div class="prism-rpt-h">' + _esc(title) + '</div>' + body + '</div>';
}
function _kvHTML(pairs) {
    return '<div class="prism-rpt-kv">' + pairs.filter(function (p) { return p && p[1] !== '' && p[1] != null; }).map(function (p) {
        return '<div class="prism-rpt-kvr"><span>' + _esc(p[0]) + '</span><b>' + _esc(p[1]) + '</b></div>';
    }).join('') + '</div>';
}
function _tableHTML(head, rows) {
    return '<div class="prism-rpt-scroll" style="overflow-x:auto;max-width:100%;"><table class="prism-rpt-tbl"><thead><tr>' +
        head.map(function (x) { return '<th>' + _esc(x) + '</th>'; }).join('') + '</tr></thead><tbody>' +
        rows.map(function (r) { return '<tr>' + r.map(function (cell, i) { return '<td' + (i === 1 ? ' class="v"' : '') + '>' + cell + '</td>'; }).join('') + '</tr>'; }).join('') +
        '</tbody></table></div>';
}
function _warnHTML(t) { return '<div class="prism-rpt-note prism-rpt-note--warn">' + _esc(t) + '</div>'; }
function _okHTML(t) { return '<div class="prism-rpt-note prism-rpt-note--ok">' + _esc(t) + '</div>'; }
function _infoHTML(t) { return '<div class="prism-rpt-note prism-rpt-note--info">' + _esc(t) + '</div>'; }
function _chip(source) {
    var cls = source === 'semilog' ? 'prism-chip--line' : (source === 'input' || source === 'derived') ? '' : 'prism-chip--fit';
    return '<span class="prism-chip ' + cls + '">' + _esc(_sourceLabel(source)) + '</span>';
}

var RESULT_HELP = {
    k: 'prism_help_k', kh: 'prism_help_kh', C: 'prism_help_C', Cd: 'prism_help_Cd', S: 'prism_help_S', pi: 'prism_help_pi',
    xf: 'prism_help_xf', Lh: 'prism_help_Lh', rinv: 'prism_help_rinv', dpS: 'prism_help_dpS', FE: 'prism_help_FE',
    DR: 'prism_help_DR', J: 'prism_help_J', J_ideal: 'prism_help_Jideal', rwa: 'prism_help_rwa'
};
function _tabHTML(m) {
    var hd = m.header, h = '<div class="prism-rpt" id="prism_report_root">';
    var tiles = [['Client', hd.client], ['Well', hd.well], ['Field', hd.field], ['Test', hd.testLabel],
                 ['Period', hd.periodLabel], ['Data', hd.nPoints ? hd.nPoints + ' points' : ''],
                 ['Model', m.model ? m.model.label : '']];
    var head = '<div class="prism-rpt-tiles">' + tiles.filter(function (t) { return t[1]; }).map(function (t) {
        return '<div class="prism-rpt-tile"><span>' + _esc(t[0]) + '</span><b>' + _esc(t[1]) + '</b></div>';
    }).join('') + '</div>';
    if (!hd.client && !hd.well) head += '<div class="prism-rpt-note">Client and well names come from the Client &amp; Well Info page.</div>';
    var btns = '<div class="prism-rpt-actions">' +
        '<button type="button" class="btn btn-primary" id="prism_report_pdf">Export PDF</button>' +
        '<button type="button" class="btn btn-secondary" id="prism_report_csv">Export CSV</button>' +
        (typeof G.PRiSM_exportReportPDF === 'function' ? '<button type="button" class="btn btn-secondary" id="prism_report_pdf_hires">PDF with all plots</button>' : '') +
        (typeof G.PRiSM_exportXMLDownload === 'function' ? '<button type="button" class="btn btn-secondary" id="prism_report_xml">Export XML</button>' : '') +
        '</div><div id="prism_report_msg" style="margin-top:6px;font-size:12px;color:var(--text2);min-height:16px;"></div>';
    h += _card('Report', head + btns);
    if (!m.hasData) {
        h += _card('Nothing to report yet', '<div class="prism-rpt-note">Load pressure or rate data on step ① (Data) to build a report.</div>' +
            '<div class="prism-rpt-actions"><button type="button" class="btn btn-secondary" id="prism_report_goto_data">Go to Data</button></div>');
        return h + '</div>';
    }
    if (m.stale) h += _warnHTML('This fit was made on different data or a different model. Re-run the fit before issuing the report.');
    if (!m.fit) {
        h += _card('No model fit yet', '<div class="prism-rpt-note">Run a fit on step ④ (Model &amp; fit) to add field-unit results with confidence intervals.</div>' +
            '<div class="prism-rpt-actions"><button type="button" class="btn btn-secondary" id="prism_report_goto_fit">Go to Model &amp; fit</button></div>');
    }
    // Key results
    if (m.results.length) {
        h += _card('Key results', _tableHTML(['Quantity', 'Value ± 95 % CI', 'Unit', 'Source'], m.results.map(function (r) {
            var v = _valueStr(r);
            var help = RESULT_HELP[r.key] || '';
            return [help ? '<span data-wts-help="' + help + '">' + _esc(r.label) + '</span>' : _esc(r.label), _esc(v.full), _esc(r.unit || '–'),
                    _chip(r.source) + (r.note ? ' <span class="prism-chip prism-chip--def">' + _esc(r.note) + '</span>' : '')];
        })), 'prism_report_results');
    }
    if (m.decline) h += _declineHTML(m.decline, m.units, false);
    // Interpretation
    if (m.interp && (m.interp.narrative || m.interp.actions.length)) {
        var ib = m.interp.narrative ? '<div class="prism-rpt-narr" id="prism_report_narrative">' + _esc(m.interp.narrative) + '</div>' : '';
        if (m.interp.actions.length) ib += '<ul style="margin:8px 0 0 18px;font-size:12px;color:var(--text2);">' + m.interp.actions.map(function (a) { return '<li>' + _esc(a) + '</li>'; }).join('') + '</ul>';
        ib += m.interp.cautions.map(_warnHTML).join('');
        h += _card('Interpretation', ib);
    }
    m.warnings.forEach(function (x) { h += _warnHTML(x); });
    // Fit quality
    if (m.stats || m.tc) {
        var fq = _kvHTML(_statsPairs(m));
        var bad = _unresolved(m);
        if (bad.length) fq += _warnHTML('Not resolved by the data: ' + bad.join(', '));
        h += _card('Fit quality', fq, 'prism_report_fit');
    }
    // Plots
    var specs = _plotSpecs(m.ctx).filter(function (s) { return !!_plotFn(s.key); });
    if (specs.length) {
        h += _card('Plots', '<div class="prism-rpt-plots" id="prism_report_plots">' + specs.map(function (s) {
            return '<div class="prism-rpt-plot"><canvas id="prism_report_plot_' + s.id + '" data-plot-key="' + _esc(s.key) + '" style="width:100%;height:280px;display:block;"></canvas><div>' + _esc(s.title) + '</div></div>';
        }).join('') + '</div>');
    }
    // Model comparison
    if (m.comparison.length) {
        var ct = _comparisonTable(m, ' <span class="prism-chip prism-chip--fit">reported</span>');
        h += _card('Model comparison', _tableHTML(ct.head, ct.rows) +
            '<div class="prism-rpt-note">ΔAIC below 2: the data cannot separate the models. Above 10: strong preference.</div>', 'prism_report_compare');
    } else if (m.fit) {
        h += _card('Model comparison', '<div class="prism-rpt-note">Run the model race on step ④ to compare models by AIC.</div>');
    }
    if (m.pins.length) {
        var pt = _pinsTable(m);
        h += _card('Pinned results', _tableHTML(pt.head, pt.rows), 'prism_report_pins');
    }
    if (m.semilog || m.keys.length) h += _straightLineHTML(m, false);
    if (m.skin || m.decomp) h += _skinHTML(m, false);
    if (m.regimes && m.regimes.list.length) {
        h += _card('Flow regimes', _tableHTML(['Regime', 'From (h)', 'To (h)'], m.regimes.list.map(function (g) {
            return [_esc(g.label), _fmt(g.t0, 3), _fmt(g.t1, 3)];
        })));
    }
    if (m.data) {
        var dw = m.data.pRefSource === 'first-sample' ? _warnHTML('The reference pressure is the first data point, so skin is biased. Enter the initial pressure on step ①.') : '';
        h += _card('Data used', _kvHTML([
            ['Points analysed', String(m.data.n)], ['Δt range', _fmt(m.data.t0, 3) + '–' + _fmt(m.data.t1, 4) + ' h'],
            ['Reference pressure', _fixed(m.data.pRef, 1) + ' psia'], ['Reference source', m.data.pRefLabel],
            ['Test type', _testLabel(m.data.testType)], ['tp', _isNum(m.data.tp) ? _fmt(m.data.tp, 4) + ' h' : ''],
            ['Time function', m.data.timeFn]
        ]) + dw);
    }
    if (m.params.length) {
        h += _card(m.fit ? 'Model parameters' : 'Model parameters (not fitted yet)', _tableHTML(['Parameter', 'Value ± 95 % CI', 'Unit', 'Fixed'], m.params.map(function (p) {
            var s = typeof p.value === 'number' ? _fmt(p.value, 4) : p.value;
            var pm = typeof p.value === 'number' ? _fmtPM(p.value, s, p.lo, p.hi) : '';
            return [_esc(p.label), _esc(s + (pm ? ' ± ' + pm : '')), _esc(p.unit || '–'),
                    (p.frozen ? 'yes' : '') + (p.identifiable === false ? ' <span class="prism-chip prism-chip--def">not resolved</span>' : '')];
        })));
    }
    if (m.inputs.length) {
        h += _card('Inputs and where they came from', _tableHTML(['Input', 'Value', 'Unit', 'Source'], m.inputs.map(function (r) {
            var v = typeof r.value === 'number' ? _fmt(r.value, 4) : (r.value || '—');
            var src = r.missing ? '<span class="prism-chip prism-chip--bad">missing</span>'
                : r.isDefault ? '<span class="prism-chip prism-chip--def">default — not confirmed</span>'
                : '<span class="prism-chip">' + _esc(_provLabel(r.provenance) || '—') + '</span>';
            return [_esc(r.label), _esc(v), _esc(r.unit || '–'), src];
        })) + '<div class="prism-rpt-actions"><button type="button" class="btn btn-secondary" id="prism_report_goto_inputs">Edit inputs</button></div>', 'prism_report_inputs');
    }
    h += _card('Analyst comments', '<textarea id="prism_report_notes" placeholder="Comments to print with the report">' + _esc(m.notes) + '</textarea>');
    return h + '</div>';
}

function _goto(step, tab) {
    try {
        if (typeof G.PRiSM_gotoStep === 'function') { G.PRiSM_gotoStep(step); return; }
        if (G.PRiSM && typeof G.PRiSM.setTab === 'function') G.PRiSM.setTab(tab);
    } catch (e) { _warn('[report] navigation failed', e); }
}
function _msg(host, html) { var el = host.querySelector('#prism_report_msg'); if (el) el.innerHTML = html; }

function _wireTab(host, m) {
    function on(id, fn) { var el = host.querySelector('#' + id); if (el) el.onclick = fn; }
    on('prism_report_pdf', function () {
        try {
            var r = exportReportPDF();
            _msg(host, r && r.method === 'none' ? '<span style="color:var(--yellow);">Report built, but no print window could be opened.</span>'
                : '<span style="color:var(--green);">Report sent to the print dialog — choose "Save as PDF".</span>');
        } catch (e) { _msg(host, '<span style="color:var(--red);">Export failed: ' + _esc(e.message) + '</span>'); }
    });
    on('prism_report_csv', function () {
        try { var r = exportCSV(); _msg(host, '<span style="color:var(--green);">CSV ready: ' + _esc(r.filename) + ' (' + r.rows.length + ' rows).</span>'); }
        catch (e) { _msg(host, '<span style="color:var(--red);">CSV export failed: ' + _esc(e.message) + '</span>'); }
    });
    on('prism_report_pdf_hires', function () {
        try { G.PRiSM_exportReportPDF(); } catch (e) { _msg(host, '<span style="color:var(--red);">Export failed: ' + _esc(e.message) + '</span>'); }
    });
    on('prism_report_xml', function () {
        try { G.PRiSM_exportXMLDownload(); _msg(host, '<span style="color:var(--green);">XML download started.</span>'); }
        catch (e) { _msg(host, '<span style="color:var(--red);">XML export failed: ' + _esc(e.message) + '</span>'); }
    });
    on('prism_report_goto_data', function () { _goto(1, 1); });
    on('prism_report_goto_inputs', function () { _goto(1, 1); });
    on('prism_report_goto_fit', function () { _goto(4, 6); });
    var notes = host.querySelector('#prism_report_notes');
    if (notes) notes.oninput = function () {
        try { var ls = _ls(); if (ls) ls.setItem('wts_prism_report_notes', String(notes.value || '')); } catch (e) {}
    };
}

function _plotWidth(el) {
    var cw = el && el.clientWidth ? el.clientWidth : 0;
    var vw = _isNum(G.innerWidth) && G.innerWidth > 0 ? G.innerWidth - 32 : 900;
    var w = Math.min(cw > 0 ? cw : Infinity, vw, 900);
    return Math.max(240, Math.floor(_isNum(w) ? w : 600));
}
function _drawTabPlots(host, m) {
    var c = m.ctx;
    _plotSpecs(c).forEach(function (spec) {
        var cv = host.querySelector('#prism_report_plot_' + spec.id);
        if (!cv) return;
        _drawPlot(cv, c, spec, { width: _plotWidth(cv.parentNode), height: 280, hover: true });
    });
}

function renderReportTab(hostEl) {
    if (!_hasDoc) return null;
    var host = (hostEl && hostEl.nodeType === 1) ? hostEl : document.getElementById('prism_tab_7');
    if (!host) return null;
    _injectStyles();
    _wireEvents();
    var m;
    try { m = reportData(); }
    catch (e) {
        host.innerHTML = '<div class="prism-rpt-card"><div class="prism-rpt-h">Report</div><div class="prism-rpt-note prism-rpt-note--warn">The report could not be built: ' + _esc(e && e.message) + '</div></div>';
        return null;
    }
    host.innerHTML = _tabHTML(m);
    _wireTab(host, m);
    try { _drawTabPlots(host, m); } catch (e) { _warn('[report] plots failed', e); }
    try { if (G.WTS_helpTooltips && typeof G.WTS_helpTooltips.refresh === 'function') G.WTS_helpTooltips.refresh(); } catch (e) {}
    return m;
}

// Re-render when the analysis changes while the report is on screen.
function _visible(el) {
    if (!el) return false;
    for (var n = el; n && n.nodeType === 1; n = n.parentNode) {
        if (n.style && n.style.display === 'none') return false;
        if (n.hasAttribute && n.hasAttribute('hidden')) return false;
    }
    try {
        var root = document.documentElement;
        if (root && typeof root.contains === 'function') return root.contains(el);
    } catch (e) {}
    return true;
}
var _refreshTimer = null, _wired = false;
function _scheduleRefresh() {
    if (!_hasDoc) return;
    if (_refreshTimer) clearTimeout(_refreshTimer);
    _refreshTimer = setTimeout(function () {
        _refreshTimer = null;
        var root = document.getElementById('prism_report_root');
        var host = root && root.parentNode;
        if (host && _visible(host)) renderReportTab(host);
    }, 30);
}
function _wireEvents() {
    if (_wired || typeof G.addEventListener !== 'function') return;
    _wired = true;
    ['prism:fit-updated', 'prism:well-changed', 'prism:dataset-loaded', 'prism:model-changed',
     'prism:automatch-updated', 'prism:report-pinned'].forEach(function (ev) {
        G.addEventListener(ev, _scheduleRefresh);
    });
    G.addEventListener('resize', _scheduleRefresh);
}

// ───────────────────────────────────────────────────────────────────
// SECTION 11 — PDF ROUTING (host report pipeline)
// ───────────────────────────────────────────────────────────────────
function _standaloneDoc(title, html, subtitle) {
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + _esc(title) + '</title>' +
        '<meta name="viewport" content="width=device-width, initial-scale=1"><style>' +
        'body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1f2328;max-width:860px;margin:0 auto;padding:24px;font-size:13px;}' +
        '.rp-sec{border:1px solid #e5e7eb;border-radius:10px;padding:10px 14px;margin:0 0 12px;break-inside:avoid;}' +
        '.rp-sec h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#bc4c00;margin:0 0 8px;}' +
        '.rp-kv{display:grid;grid-template-columns:1fr 1fr;column-gap:24px;}.rp-kvr{display:flex;justify-content:space-between;gap:10px;padding:4px 0;border-bottom:1px solid #f0f2f4;}' +
        '.rp-tbl{width:100%;border-collapse:collapse;font-size:11.5px;}.rp-tbl th,.rp-tbl td{text-align:left;padding:5px 8px;border-bottom:1px solid #eef0f2;}' +
        '.rp-note{margin:6px 0;padding:7px 10px;border-left:4px solid #8c959f;background:#f6f8fa;}.n-amber{border-left-color:#9a6700;}.n-blue{border-left-color:#0969da;}.n-green{border-left-color:#1a7f37;}' +
        '.s-amber{color:#9a6700;}.s-red{color:#cf222e;}.rp-fig img{max-width:100%;height:auto;}' +
        '</style></head><body><h1>' + _esc(title) + '</h1>' + (subtitle ? '<p>' + _esc(subtitle) + '</p>' : '') + html + '</body></html>';
}
function hostExportReport(title, html, subtitle) {
    if (typeof exportReport === 'function') { exportReport(title, html, subtitle); return { method: 'host' }; }   // host scope
    if (typeof G.exportReport === 'function') { G.exportReport(title, html, subtitle); return { method: 'host' }; }
    if (typeof G.__reportOverride === 'function') { G.__reportOverride(title, html, subtitle); return { method: 'override' }; }
    var doc = (typeof G.buildReportHTML === 'function') ? G.buildReportHTML(title, html, subtitle) : _standaloneDoc(title, html, subtitle);
    var w = null;
    try { w = typeof G.open === 'function' ? G.open('', '_blank', 'width=960,height=800') : null; } catch (e) { w = null; }
    if (w && w.document) {
        w.document.open(); w.document.write(doc); w.document.close();
        try { if (typeof w.setTimeout === 'function') w.setTimeout(function () { try { w.focus(); w.print(); } catch (e) {} }, 400); } catch (e) {}
        return { method: 'window', html: doc };
    }
    return { method: 'none', html: doc };
}
function exportReportPDF(opts) {
    opts = opts || {};
    var m = reportData();
    var html = buildReportHTML({ model: m, plots: opts.plots });
    var title = 'Well Test Analysis' + (m.model ? ' — ' + m.model.label : '');
    var sub = [m.header.well, m.header.testLabel, m.header.periodLabel].filter(Boolean).join(' · ');
    try { if (typeof G.gtag === 'function') G.gtag('event', 'prism_report_pdf', { event_category: 'PRiSM', model: m.model ? m.model.key : 'none' }); } catch (e) {}
    return hostExportReport(title, html, sub);
}

// ───────────────────────────────────────────────────────────────────
// SECTION 12 — PUBLISH
// ───────────────────────────────────────────────────────────────────
G.PRiSM_renderReportTab = renderReportTab;
G.PRiSM_buildReportHTML = buildReportHTML;
G.PRiSM_buildReportCSV = buildReportCSV;
G.PRiSM_exportCSV = exportCSV;
G.PRiSM_reportData = reportData;
G.PRiSM_reportResults = reportResults;
G.PRiSM_exportReport = exportReportPDF;
G.PRiSM_hostExportReport = hostExportReport;
G.PRiSM_report_internal = { fmt: _fmt, skinFromInputs: _skinFromInputs, bourdet: _bourdet, normFit: _normFit };

// ───────────────────────────────────────────────────────────────────
// === SELF-TEST ===
// ───────────────────────────────────────────────────────────────────
(function () {
    var checks = [];
    function ok(name, cond) { checks.push({ name: name, ok: !!cond }); }
    var saved = { st: G.PRiSM_state, ds: G.PRiSM_dataset, pvt: G.PRiSM_pvt, M: G.PRiSM_MODELS };
    try {
        ok('fmt 45.001 → 45.0', _fmt(45.001, 3) === '45.0');
        ok('fmt 261.9 → 262', _fmt(261.9, 3) === '262');
        ok('fmt 1548.3 → 1548', _fmt(1548.3, 4) === '1548');
        ok('fmt 8.48e-4', _fmt(8.48e-4, 3) === '8.48e-4');
        var sk = _skinFromInputs({ S: 2.5, kh: 1575, q: 850, B: 1.25, mu: 1.1, rw: 0.354, pbar: 4200, pwf: 3089.8, fluid: 'oil' });
        ok('ΔpS 261.9', Math.abs(sk.dpS - 261.9) < 0.2);
        ok('FE 0.764', Math.abs(sk.FE - 0.764) < 0.002);
        ok('DR 1.309', Math.abs(sk.DR - 1.309) < 0.003);
        ok('J 0.766', Math.abs(sk.J - 0.7656) < 0.001);
        ok('rw′ 0.0291', Math.abs(sk.rwa - 0.0291) < 0.0002);
        ok('rinv 1548', Math.abs(_rinv(45, 120, { phi: 0.18, mu: 1.1, ct: 1.2e-5 }) - 1548) < 2);
        var tt = [], yy = [];
        for (var i = 0; i < 40; i++) { tt.push(Math.pow(10, -2 + i * 0.1)); yy.push(52.4 * Math.log(tt[i]) + 300); }
        var d = _bourdet(tt, yy, 0.1);
        ok('bourdet of 52.4·ln t is 52.4', Math.abs(d[20] - 52.4) < 1e-6);
        var nf = _normFit({ R2: 0.9, RMSE: 1, AIC: 3, CI95: { S: [1, 2] }, model: 'x' }, {});
        ok('fit aliases normalised', nf.r2 === 0.9 && nf.rmse === 1 && nf.aic === 3 && nf.modelKey === 'x' && nf.ci95.S[1] === 2);
        // CSV through the scales path with a stub linear model: pd = td
        G.PRiSM_MODELS = { lin: { pd: function (td) { return td.map(function (x) { return x; }); },
                                  pdPrime: function (td) { return td.map(function (x) { return x; }); }, paramSpec: [] } };
        G.PRiSM_dataset = { t: [1, 2, 3, 4], p: [990, 980, 970, 960], q: [10, 10, 10, 10] };
        G.PRiSM_pvt = { fluidType: 'oil', q: 10, p_res: 1000, provenance: { p_res: 'user' }, h: 10, phi: 0.2, rw: 0.3, Bo: 1, mu_o: 1, ct: 1e-5 };
        G.PRiSM_state = { model: 'lin', params: {}, lastFit: { modelKey: 'lin', params: {}, scales: { A: 10, B: 1 }, pRef: 1000, r2: 1 } };
        var csv = buildReportCSV();
        ok('CSV header', csv.text.split('\n')[0] === CSV_PRESSURE.join(','));
        ok('CSV model_dp at t=4 is 40', Math.abs(csv.rows[3][5] - 40) < 1e-9 && Math.abs(csv.rows[3][7]) < 1e-9);
        var html = buildReportHTML({ plots: false });
        ok('report HTML has key results', html.indexOf('Key results') >= 0 && html.indexOf('rp-sec') >= 0);
        ok('no legacy time-match rows', html.indexOf('Time-match') < 0 && html.indexOf('Pressure-match') < 0);
        var rr = reportResults();
        ok('reportResults shape', rr && rr.modelKey === 'lin' && _isNum(rr.r2));
    } catch (e) {
        checks.push({ name: 'self-test threw: ' + (e && e.message), ok: false });
    } finally {
        G.PRiSM_state = saved.st; G.PRiSM_dataset = saved.ds; G.PRiSM_pvt = saved.pvt; G.PRiSM_MODELS = saved.M;
    }
    var fails = checks.filter(function (c) { return !c.ok; });
    G.PRiSM_report_selfTest = { checks: checks, passed: checks.length - fails.length, failed: fails.length };
    if (fails.length) { try { console.error('PRiSM report self-test FAILED:', fails); } catch (e) {} }
    else { try { console.log('PRiSM report self-test passed (' + checks.length + ' checks).'); } catch (e) {} }
})();

})();
