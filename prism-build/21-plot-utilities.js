// ════════════════════════════════════════════════════════════════════
// PRiSM ─ Layer 21 — Plot utilities (overlays + diff + XML + clipboard)
//   • Plot overlays for multi-period / multi-dataset / model comparison
//   • Two-dataset diff plot (interpolation + 2-panel render)
//   • XML project export (one-file portable export)
//   • Copy plot / data to the clipboard
//   • Tab 2 panel "Plot tools" that hosts all of the above plus PNG / PDF export
//
// PUBLIC API (all on window.*)
//
//   PRiSM_overlays                          — state container
//     .items / .add(source, label?, color?) → id / .remove(id) / .toggle(id)
//     .clear() / .list()
//     Sources: 'period:N', 'analysis:ID', 'gauge:ID', 'model:KEY', 'fit:KEY'
//
//   PRiSM_drawOverlays(canvas, plotKey, axes?, opts?) → void   (also a post-draw hook)
//   PRiSM_renderOverlayManager(container)             → void
//
//   PRiSM_datasetDiff(dataA, dataB)               → diff result object
//   PRiSM_plot_dataset_diff(canvas, data, opts)   → void  (2-panel plot)
//   PRiSM_renderDiffPicker(container)             → void
//
//   PRiSM_exportXML(opts)                  → { blob, filename, xmlString }
//   PRiSM_exportXMLDownload(opts)          → void  (triggers <a download>)
//
//   PRiSM_copyPlotToClipboard(plotKey?)    → Promise<{ success, error? }>
//   PRiSM_copyDataToClipboard(format?)     → Promise<{ success, error? }>
//   PRiSM_renderClipboardToolbar(container) → void
//   PRiSM_renderPlotToolsPanel(container)   → void  (Tab 2 panel body)
//
// CONVENTIONS
//   • Single outer IIFE, 'use strict'. Pure vanilla JS — no dependencies.
//   • Mounting through C7 only: Tab 2 panel registry + PRiSM_postDrawHooks.
//     No polling, no function wrapping.
//   • Overlays are drawn with the host plot's own transform
//     (canvas._prismAxes: toX/toY or scaleX/scaleY/plot, C6).
//   • Exported analysis data uses C2 (PRiSM_getAnalysisData): Δt [hr],
//     dp_psi (sign-aware Δp) and dp_deriv_psi (Bourdet derivative).
//   • XML is well-formed: 5-entity escaping for <, >, &, ", '.
// ════════════════════════════════════════════════════════════════════

(function () {
    'use strict';

    var _hasDoc = (typeof document !== 'undefined') && !!document && typeof document.createElement === 'function';
    var _hasWin = (typeof window !== 'undefined');
    var G       = _hasWin ? window : (typeof globalThis !== 'undefined' ? globalThis : {});

    function _theme() {
        /* global PRiSM_THEME */
        if (typeof PRiSM_THEME !== 'undefined' && PRiSM_THEME && typeof PRiSM_THEME === 'object') return PRiSM_THEME;
        if (G.PRiSM_THEME && typeof G.PRiSM_THEME === 'object') return G.PRiSM_THEME;
        return {
            bg: '#0d1117', panel: '#161b22', border: '#30363d',
            grid: '#21262d', gridMajor: '#30363d',
            text: '#c9d1d9', text2: '#8b949e', text3: '#6e7681',
            accent: '#f0883e', blue: '#58a6ff', green: '#3fb950',
            red: '#f85149', yellow: '#d29922', cyan: '#39c5cf',
            purple: '#bc8cff'
        };
    }

    function _defaultPad() {
        return { top: 30, right: 80, bottom: 48, left: 64 };
    }

    function _ga4(eventName, params) {
        if (typeof G.gtag === 'function') {
            try { G.gtag('event', eventName, params); } catch (e) { /* swallow */ }
        }
    }

    function _num(v) { return typeof v === 'number' && isFinite(v); }

    function _on(target, type, fn) {
        try { if (target && typeof target.addEventListener === 'function') target.addEventListener(type, fn); }
        catch (e) { /* stub environments */ }
    }

    function _registerTabPanel(n, spec) {
        if (typeof G.PRiSM_registerTabPanel === 'function') {
            try { G.PRiSM_registerTabPanel(n, spec); return; } catch (e) { /* fall back */ }
        }
        G.PRiSM_tabPanels = G.PRiSM_tabPanels || {};
        var arr = G.PRiSM_tabPanels[n] = G.PRiSM_tabPanels[n] || [];
        for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].id === spec.id) { arr[i] = spec; return; }
        arr.push(spec);
    }

    function _registerPostDraw(fn) {
        var hooks = G.PRiSM_postDrawHooks = Array.isArray(G.PRiSM_postDrawHooks) ? G.PRiSM_postDrawHooks : [];
        for (var i = 0; i < hooks.length; i++) if (hooks[i] && hooks[i]._prismId === fn._prismId) { hooks[i] = fn; return; }
        hooks.push(fn);
    }

    function _redraw() {
        if (typeof G.PRiSM_drawActivePlot === 'function') { try { G.PRiSM_drawActivePlot(); } catch (e) { /* ignore */ } }
    }

    function _toArr(a) {
        if (!a) return null;
        if (Array.isArray(a)) return a;
        try { return Array.prototype.slice.call(a); } catch (e) { return null; }
    }

    // Bourdet derivative (3-point, window L in ln t).
    function _bourdet(t, y, L) {
        if (typeof G.PRiSM_compute_bourdet === 'function') {
            try { var r = G.PRiSM_compute_bourdet(t, y, L); if (r && r.length === t.length) return r; } catch (e) { /* inline */ }
        }
        var n = t.length, d = new Array(n), i;
        for (i = 0; i < n; i++) d[i] = NaN;
        for (i = 1; i < n - 1; i++) {
            var i1 = i - 1, i2 = i + 1;
            if (L > 0) {
                while (i1 > 0 && Math.log(t[i]) - Math.log(t[i1]) < L) i1--;
                while (i2 < n - 1 && Math.log(t[i2]) - Math.log(t[i]) < L) i2++;
            }
            var dl1 = Math.log(t[i]) - Math.log(t[i1]), dl2 = Math.log(t[i2]) - Math.log(t[i]), dlT = Math.log(t[i2]) - Math.log(t[i1]);
            if (!(dl1 > 0) || !(dl2 > 0) || !(dlT > 0)) continue;
            d[i] = (y[i] - y[i1]) / dl1 * (dl2 / dlT) + (y[i2] - y[i]) / dl2 * (dl1 / dlT);
        }
        return d;
    }

    function _currentL() {
        var st = G.PRiSM_state || {};
        return _num(st.bourdetL) ? st.bourdetL : 0.15;
    }

    // Sign-aware Δp (CLAUDE.md) + derivative for a raw {t, p} series; t re-zeroed.
    function _localDelta(t, p, t0) {
        var tt = [], pp = [], tAbs = [];
        for (var i = 0; i < t.length; i++) {
            if (!_num(t[i]) || !_num(p[i])) continue;
            var dt = t[i] - (t0 || 0);
            if (!(dt > 0)) continue;
            tt.push(dt); pp.push(p[i]); tAbs.push(t[i]);
        }
        if (tt.length < 3) return null;
        var n = pp.length, sign = (pp[n - 1] - pp[0]) >= 0 ? 1 : -1, dp = [];
        for (var k = 0; k < n; k++) dp.push(sign * (pp[k] - pp[0]));
        return { t: tt, tAbs: tAbs, p: pp, dp: dp, deriv: _bourdet(tt, dp, _currentL()), pRefSource: 'first-sample' };
    }

    // Analysis data (C2) for the whole dataset or one period.
    function _analysisData(period) {
        var st = G.PRiSM_state || {};
        if (typeof G.PRiSM_getAnalysisData === 'function') {
            try {
                var o = { L: _currentL() };
                if (_num(period) && period >= 0) o.period = period;
                else if (_num(st.activePeriod) && st.activePeriod >= 0) o.period = st.activePeriod;
                if (st.timeFn) o.timeFn = st.timeFn;
                var ad = G.PRiSM_getAnalysisData(G.PRiSM_dataset, o);
                if (ad && ad.ok && ad.t && ad.t.length) return ad;
            } catch (e) { /* fall back */ }
        }
        var ds = G.PRiSM_dataset;
        if (!ds || !ds.t || !ds.p) return null;
        var loc = _localDelta(_toArr(ds.t), _toArr(ds.p), 0);
        if (!loc) return null;
        loc.ok = true;
        return loc;
    }

    // Pretty palette for fresh overlay colours, cycling through.
    var OVERLAY_PALETTE = [
        '#58a6ff', '#3fb950', '#d29922', '#bc8cff',
        '#39c5cf', '#f85149', '#f0883e', '#c9d1d9'
    ];

    // ═══════════════════════════════════════════════════════════════
    // SECTION 1 — OVERLAY STATE CONTAINER
    // ═══════════════════════════════════════════════════════════════
    //
    // window.PRiSM_overlays.items is a flat list. Each entry:
    //   { id, source, label, color, visible }
    //
    // 'source' is a colon-prefixed string:
    //   'period:N'    — flow period N of the loaded dataset (C2, Δt re-zeroed,
    //                   rate-normalised to the analysed period on Δp plots)
    //   'analysis:ID' — PRiSM_analysisData item
    //   'gauge:ID'    — PRiSM_gaugeData item
    //   'model:KEY'   — model curve via PRiSM_evalModelCurve (C7)
    //   'fit:KEY'     — fitted curve from PRiSM_state.history[KEY]
    // ═══════════════════════════════════════════════════════════════

    var _overlayCounter = 0;
    function _genOverlayId() {
        _overlayCounter += 1;
        return 'overlay_' + _overlayCounter + '_' + (Date.now() % 100000);
    }

    function _nextColor() {
        var existing = (G.PRiSM_overlays && G.PRiSM_overlays.items) || [];
        for (var i = 0; i < OVERLAY_PALETTE.length; i++) {
            var c = OVERLAY_PALETTE[i], used = false;
            for (var j = 0; j < existing.length; j++) if (existing[j].color === c) { used = true; break; }
            if (!used) return c;
        }
        return OVERLAY_PALETTE[existing.length % OVERLAY_PALETTE.length];
    }

    function _modelName(key) {
        var e = G.PRiSM_MODELS && G.PRiSM_MODELS[key];
        return (e && (e.label || e.name)) || key;
    }

    function _autoLabel(source) {
        if (!source || typeof source !== 'string') return 'Overlay';
        var parts = source.split(':');
        var kind = parts[0], id = parts.slice(1).join(':');
        switch (kind) {
            case 'period':   return 'Period #' + (parseInt(id, 10) + 1);
            case 'analysis': return 'Analysis: ' + id;
            case 'gauge':    return 'Gauge: ' + id;
            case 'model':    return 'Model: ' + _modelName(id);
            case 'fit':      return 'Fit: ' + id;
            default:         return source;
        }
    }

    if (!G.PRiSM_overlays) {
        G.PRiSM_overlays = {
            items: [],
            add: function (source, label, color) {
                if (typeof source !== 'string' || !source) {
                    throw new Error('PRiSM_overlays.add: source must be a non-empty string');
                }
                var id = _genOverlayId();
                this.items.push({ id: id, source: source, label: label || _autoLabel(source),
                                  color: color || _nextColor(), visible: true });
                _ga4('prism_overlay_add', { source: source.split(':')[0] });
                return id;
            },
            remove: function (id) {
                for (var i = 0; i < this.items.length; i++) {
                    if (this.items[i].id === id) { this.items.splice(i, 1); return; }
                }
            },
            toggle: function (id) {
                for (var i = 0; i < this.items.length; i++) {
                    if (this.items[i].id === id) { this.items[i].visible = !this.items[i].visible; return; }
                }
            },
            clear: function () { this.items.length = 0; },
            list:  function () { return this.items.slice(); }
        };
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 2 — OVERLAY DATA RESOLUTION + DRAWING
    // ═══════════════════════════════════════════════════════════════
    // A resolved overlay is { t (Δt hr), tAbs?, p?, dp?, deriv?, q?, tp?,
    // qRef?, dimensionless? }. Drawing maps it onto the active plot's own
    // abscissa (Δt, √Δt, Δt^¼, Δt^−½, Horner ratio, days) and ordinate.
    // ═══════════════════════════════════════════════════════════════

    function _periodBounds(pp) {
        var a = _num(pp.t0) ? pp.t0 : pp.start, b = _num(pp.t1) ? pp.t1 : pp.end;
        return (_num(a) && _num(b)) ? { t0: a, t1: b } : null;
    }

    function _datasetPeriods(ds) {
        var pers = (ds && ds.periods) || [];
        if ((!pers || !pers.length) && ds && ds.q && typeof G.PRiSM_detectPeriods === 'function') {
            try { pers = G.PRiSM_detectPeriods(ds.t, ds.q) || []; } catch (e) { pers = []; }
        }
        return pers || [];
    }

    function _evalModel(key) {
        var reg = G.PRiSM_MODELS, st = G.PRiSM_state || {};
        var entry = reg && reg[key];
        if (!entry) return null;
        var params = (key === st.model && st.params) ? st.params : (entry.defaults || {});
        var curve = null;
        if (typeof G.PRiSM_evalModelCurve === 'function') {
            // The dispatcher may cache its curve on the state — keep the active one intact.
            var keep = { a: st.modelCurveData, b: st.modelCurve }, had = { a: 'modelCurveData' in st, b: 'modelCurve' in st };
            try { curve = G.PRiSM_evalModelCurve(key, params, { store: false }); } catch (e) { curve = null; }
            if (had.a) st.modelCurveData = keep.a; else delete st.modelCurveData;
            if (had.b) st.modelCurve = keep.b; else delete st.modelCurve;
        }
        if (curve && curve.t && curve.dp) {
            return { t: _toArr(curve.t), dp: _toArr(curve.dp), deriv: _toArr(curve.deriv), p: _toArr(curve.p), model: true };
        }
        if (!(curve && curve.td && curve.pd) && typeof entry.pd === 'function') {
            var td = [];
            for (var e10 = -2; e10 <= 5.0001; e10 += 0.05) td.push(Math.pow(10, e10));
            try {
                var pd = entry.pd(td, params);
                var pdp = (typeof entry.pdPrime === 'function') ? entry.pdPrime(td, params) : null;
                curve = { td: td, pd: _toArr(pd), pdPrime: _toArr(pdp) };
            } catch (e2) { curve = null; }
        }
        if (!curve || !curve.td || !curve.pd) return null;
        if (st.tcMatch && typeof G.PRiSM_applyTypeCurveMatch === 'function') {
            try {
                var m = G.PRiSM_applyTypeCurveMatch(curve, st.tcMatch);
                if (m && m.t && m.dp) return { t: _toArr(m.t), dp: _toArr(m.dp), deriv: _toArr(m.deriv), model: true };
            } catch (e3) { /* dimensionless */ }
        }
        return { t: _toArr(curve.td), dp: _toArr(curve.pd), deriv: _toArr(curve.pdPrime), dimensionless: true, model: true };
    }

    function _resolveOverlay(source) {
        if (!source || typeof source !== 'string') return null;
        var parts = source.split(':');
        var kind = parts[0], id = parts.slice(1).join(':');
        var ds = G.PRiSM_dataset;
        try {
            switch (kind) {
                case 'period': {
                    if (!ds || !ds.t) return null;
                    var pIdx = parseInt(id, 10);
                    if (!isFinite(pIdx) || pIdx < 0) return null;
                    var pers = _datasetPeriods(ds);
                    var qRef = (pers[pIdx] && _num(pers[pIdx].q)) ? pers[pIdx].q : null;
                    if (typeof G.PRiSM_getAnalysisData === 'function') {
                        try {
                            var ad = G.PRiSM_getAnalysisData(ds, { period: pIdx, L: _currentL() });
                            if (ad && ad.ok && ad.t && ad.t.length) {
                                return { t: _toArr(ad.t), tAbs: _toArr(ad.tAbs), p: _toArr(ad.p), dp: _toArr(ad.dp),
                                         deriv: _toArr(ad.deriv), tp: ad.tp, qRef: _num(ad.qRef) ? ad.qRef : qRef };
                            }
                        } catch (e) { /* local fallback */ }
                    }
                    if (!pers[pIdx]) return null;
                    var b = _periodBounds(pers[pIdx]);
                    if (!b || !ds.p) return null;
                    var ts = [], ps = [];
                    for (var i = 0; i < ds.t.length; i++) {
                        if (ds.t[i] >= b.t0 && ds.t[i] <= b.t1) { ts.push(ds.t[i]); ps.push(ds.p[i]); }
                    }
                    var loc = _localDelta(ts, ps, b.t0);
                    if (!loc) return null;
                    loc.qRef = qRef;
                    return loc;
                }
                case 'analysis': {
                    var adm = G.PRiSM_analysisData;
                    if (!adm) return null;
                    var item = (typeof adm.get === 'function') ? adm.get(id)
                             : (adm.items && adm.items[id]) ? adm.items[id]
                             : (Array.isArray(adm) && adm.find) ? adm.find(function (x) { return x.id === id; })
                             : null;
                    if (!item) return null;
                    return {
                        t:  item.t  || (item.data && item.data.t)  || [],
                        p:  item.p  || (item.data && item.data.p)  || null,
                        dp: item.dp || (item.data && item.data.dp) || null,
                        q:  item.q  || (item.data && item.data.q)  || null
                    };
                }
                case 'gauge': {
                    var gd = G.PRiSM_gaugeData;
                    if (!gd) return null;
                    var g = (typeof gd.get === 'function') ? gd.get(id)
                          : (gd.items && gd.items[id]) ? gd.items[id]
                          : (Array.isArray(gd) && gd.find) ? gd.find(function (x) { return x.id === id; })
                          : null;
                    if (!g) return null;
                    return {
                        t: g.t || (g.samples && g.samples.t) || [],
                        p: g.p || (g.samples && g.samples.p) || null,
                        q: g.q || (g.samples && g.samples.q) || null
                    };
                }
                case 'model':
                    return _evalModel(id);
                case 'fit': {
                    var st = G.PRiSM_state || {};
                    var hist = st.history || st.fitHistory || {};
                    var fit = hist[id];
                    if (!fit) return null;
                    if (fit.curve && fit.curve.t && (fit.curve.dp || fit.curve.p)) {
                        return { t: _toArr(fit.curve.t), dp: _toArr(fit.curve.dp), deriv: _toArr(fit.curve.deriv), p: _toArr(fit.curve.p) };
                    }
                    if (fit.td && fit.pd) return { t: fit.td.slice(), dp: fit.pd.slice(), dimensionless: true };
                    return null;
                }
            }
        } catch (e) {
            return null;
        }
        return null;
    }

    // Axis transform of the host plot (C6), with an older-shape fallback.
    function _axisFwd(sc, off, len, flip) {
        if (!sc || !_num(sc.min) || !_num(sc.max) || !(len > 0)) return null;
        if (sc.kind === 'log') {
            if (!(sc.min > 0 && sc.max > 0)) return null;
            var a = Math.log10(sc.min), b = Math.log10(sc.max);
            return function (v) { if (!(v > 0)) return NaN; var f = (Math.log10(v) - a) / (b - a); return flip ? off + len - f * len : off + f * len; };
        }
        return function (v) { if (!_num(v)) return NaN; var f = (v - sc.min) / (sc.max - sc.min); return flip ? off + len - f * len : off + f * len; };
    }

    function _plotRect(canvas) {
        var cssW = (canvas && canvas.clientWidth) || (canvas && canvas.width) || 600;
        var cssH = (canvas && canvas.clientHeight) || (canvas && canvas.height) || 400;
        if (canvas && canvas.style) {
            var w = parseInt(canvas.style.width, 10);
            if (isFinite(w) && w > 0) cssW = w;
            var h = parseInt(canvas.style.height, 10);
            if (isFinite(h) && h > 0) cssH = h;
        }
        var pad = _defaultPad();
        return { x: pad.left, y: pad.top, w: Math.max(1, cssW - pad.left - pad.right),
                 h: Math.max(1, cssH - pad.top - pad.bottom), cssW: cssW, cssH: cssH, pad: pad };
    }

    // → { toX, toY, plotRect, xKind, yKind } or null
    function _getCanvasAxes(canvas, axes) {
        var ax = axes || (canvas && canvas._prismAxes) || null;
        if (ax && typeof ax.toX === 'function' && typeof ax.toY === 'function' && ax.plot) {
            return { toX: ax.toX, toY: ax.toY, plotRect: ax.plot,
                     xKind: (ax.scaleX && ax.scaleX.kind) || 'lin', yKind: (ax.scaleY && ax.scaleY.kind) || 'lin' };
        }
        if (ax && ax.scaleX && ax.scaleY && ax.plot) {
            var fx = _axisFwd(ax.scaleX, ax.plot.x, ax.plot.w, false), fy = _axisFwd(ax.scaleY, ax.plot.y, ax.plot.h, true);
            if (fx && fy) return { toX: fx, toY: fy, plotRect: ax.plot, xKind: ax.scaleX.kind, yKind: ax.scaleY.kind };
        }
        if (ax && ax.plotRect && _num(ax.xMin) && _num(ax.xMax) && _num(ax.yMin) && _num(ax.yMax)) {   // older argument shape
            var gx = _axisFwd({ kind: ax.xLog ? 'log' : 'lin', min: ax.xMin, max: ax.xMax }, ax.plotRect.x, ax.plotRect.w, false);
            var gy = _axisFwd({ kind: ax.yLog ? 'log' : 'lin', min: ax.yMin, max: ax.yMax }, ax.plotRect.y, ax.plotRect.h, true);
            if (gx && gy) return { toX: gx, toY: gy, plotRect: ax.plotRect, xKind: ax.xLog ? 'log' : 'lin', yKind: ax.yLog ? 'log' : 'lin' };
        }
        if (canvas && canvas._prismOriginalScale && canvas._prismOriginalScale.x && canvas._prismOriginalScale.y) {
            var s = canvas._prismOriginalScale, pr = _plotRect(canvas);
            var hx = _axisFwd(s.x, pr.x, pr.w, false), hy = _axisFwd(s.y, pr.y, pr.h, true);
            if (hx && hy) return { toX: hx, toY: hy, plotRect: pr, xKind: s.x.kind, yKind: s.y.kind };
        }
        return null;
    }

    var _PRESSURE_X = {
        cartesian: function (r) { return r.tAbs || r.t; },
        mdh:       function (r) { return r.t; },
        sqrt:      function (r) { return r.t.map(Math.sqrt); },
        quarter:   function (r) { return r.t.map(function (v) { return Math.pow(v, 0.25); }); },
        spherical: function (r) { return r.t.map(function (v) { return v > 0 ? Math.pow(v, -0.5) : NaN; }); }
    };

    // Series [{pts:[[x,y]], dash, dots}] to draw for a resolved overlay on plotKey.
    function _seriesForPlot(data, plotKey, opts) {
        opts = opts || {};
        if (!data || !data.t || !data.t.length) return [];
        var t = _toArr(data.t), out = [], i;
        function zip(xs, ys, scale) {
            var pts = [];
            if (!xs || !ys) return pts;
            for (var k = 0; k < xs.length && k < ys.length; k++) pts.push([xs[k], ys[k] * (scale || 1)]);
            return pts;
        }
        if (plotKey === 'bourdet' || plotKey === 'sandface') {
            var dp = data.dp ? _toArr(data.dp) : null, deriv = data.deriv ? _toArr(data.deriv) : null;
            if (!dp && data.p) {
                var loc = _localDelta(t, _toArr(data.p), 0);
                if (loc) { t = loc.t; dp = loc.dp; deriv = loc.deriv; }
            }
            if (!dp) return [];
            if (!deriv && !data.model) deriv = _bourdet(t, dp, _currentL());
            // Rate-normalise another flow period to the analysed period.
            var scale = 1;
            if (_num(data.qRef) && data.qRef !== 0 && _num(opts.qRef) && opts.qRef !== 0) scale = Math.abs(opts.qRef / data.qRef);
            out.push({ pts: zip(t, dp, scale) });
            if (deriv) out.push({ pts: zip(t, deriv, scale), dash: [2, 3] });
            return out;
        }
        if (data.dimensionless) return [];
        if (plotKey === 'horner') {
            var tp = _num(data.tp) ? data.tp : opts.tp;
            if (!_num(tp) || !data.p) return [];
            var hx = t.map(function (v) { return v > 0 ? (tp + v) / v : NaN; });
            return [{ pts: zip(hx, _toArr(data.p)) }];
        }
        if (_PRESSURE_X[plotKey]) {
            if (!data.p) return [];
            return [{ pts: zip(_PRESSURE_X[plotKey](data), _toArr(data.p)) }];
        }
        if (plotKey === 'rateCart' || plotKey === 'rateSemi' || plotKey === 'rateLog') {
            if (!data.q) return [];
            var tt = t;
            if (opts.timeUnit === 'd') { tt = []; for (i = 0; i < t.length; i++) tt.push(t[i] / 24); }
            return [{ pts: zip(tt, _toArr(data.q)) }];
        }
        return [];
    }

    G.PRiSM_drawOverlays = function PRiSM_drawOverlays(canvas, plotKey, baseAxes, opts) {
        if (!canvas || !canvas.getContext) return;
        var items = (G.PRiSM_overlays && G.PRiSM_overlays.items) || [];
        if (!items.length) return;
        try {
            var st = G.PRiSM_state || {};
            plotKey = plotKey || st.activePlot || 'bourdet';
            var axes = _getCanvasAxes(canvas, baseAxes);
            if (!axes) return;                                  // no transform — silent skip
            var ctx = canvas.getContext('2d');
            if (!ctx) return;
            var pr = axes.plotRect;
            var sopts = { timeUnit: opts && opts.timeUnit, tp: opts && opts.tp };
            var cur = null;
            if (plotKey === 'bourdet' || plotKey === 'horner') {
                cur = _analysisData();
                if (cur) { sopts.qRef = cur.qRef; if (!_num(sopts.tp)) sopts.tp = cur.tp; }
            }
            var drawn = [];
            ctx.save();
            try { ctx.beginPath(); ctx.rect(pr.x, pr.y, pr.w, pr.h); ctx.clip(); } catch (e) { /* optional */ }
            for (var i = 0; i < items.length; i++) {
                var it = items[i];
                if (!it.visible) continue;
                var series = _seriesForPlot(_resolveOverlay(it.source), plotKey, sopts);
                if (!series.length) continue;
                drawn.push(it);
                for (var s = 0; s < series.length; s++) {
                    var pts = series[s].pts;
                    ctx.strokeStyle = it.color || '#58a6ff';
                    ctx.lineWidth = series[s].dash ? 1.5 : 2;
                    ctx.setLineDash(series[s].dash || [5, 3]);
                    ctx.beginPath();
                    var started = false;
                    for (var k = 0; k < pts.length; k++) {
                        var p = pts[k];
                        if (!p || !_num(p[0]) || !_num(p[1])) { started = false; continue; }
                        var px = axes.toX(p[0]), py = axes.toY(p[1]);
                        if (!_num(px) || !_num(py)) { started = false; continue; }
                        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
                    }
                    ctx.stroke();
                }
            }
            ctx.setLineDash([]);
            ctx.restore();
            canvas._prismOverlaysDrawn = drawn.map(function (x) { return x.id; });

            // Legend chip, bottom-left of the plot box.
            if (drawn.length) {
                ctx.save();
                ctx.font = '11px sans-serif';
                ctx.textBaseline = 'middle';
                var th = _theme(), lineH = 14, padXL = 6, padYL = 4, maxW = 0;
                for (var m = 0; m < drawn.length; m++) {
                    var w = ctx.measureText(drawn[m].label || '').width || 0;
                    if (w > maxW) maxW = w;
                }
                var boxW = Math.min(pr.w - 16, 20 + maxW + padXL * 2), boxH = drawn.length * lineH + padYL * 2;
                var bx = pr.x + 8, by = pr.y + pr.h - boxH - 8;
                ctx.fillStyle = 'rgba(13,17,23,0.85)';
                ctx.fillRect(bx, by, boxW, boxH);
                ctx.strokeStyle = th.border || '#30363d';
                ctx.lineWidth = 1;
                ctx.strokeRect(bx + 0.5, by + 0.5, boxW, boxH);
                for (var n = 0; n < drawn.length; n++) {
                    var iy = by + padYL + n * lineH + lineH / 2;
                    ctx.strokeStyle = drawn[n].color;
                    ctx.lineWidth = 2;
                    ctx.setLineDash([4, 3]);
                    ctx.beginPath(); ctx.moveTo(bx + padXL, iy); ctx.lineTo(bx + padXL + 14, iy); ctx.stroke();
                    ctx.setLineDash([]);
                    ctx.fillStyle = th.text || '#c9d1d9';
                    ctx.textAlign = 'left';
                    ctx.fillText(String(drawn[n].label || ''), bx + padXL + 18, iy);
                }
                ctx.restore();
            }
        } catch (e) {
            try { console.warn('PRiSM_drawOverlays:', e && e.message); } catch (_) { /* ignore */ }
        }
    };

    function _overlaysPostDraw(info) {
        if (!info || !info.canvas) return;
        G.PRiSM_drawOverlays(info.canvas, info.plotKey, info.axes || null, info.opts || null);
    }
    _overlaysPostDraw._prismId = 'plot-overlays';
    _registerPostDraw(_overlaysPostDraw);

    // ═══════════════════════════════════════════════════════════════
    // SECTION 3 — OVERLAY MANAGER UI
    // ═══════════════════════════════════════════════════════════════

    function _enumerateSources() {
        var out = [];
        var ds = G.PRiSM_dataset;
        if (ds && ds.t) {
            var pers = _datasetPeriods(ds);
            for (var i = 0; i < pers.length; i++) out.push({ source: 'period:' + i, label: 'Period #' + (i + 1) });
        }
        var ad = G.PRiSM_analysisData;
        if (ad) {
            var adList = [];
            if (typeof ad.list === 'function') adList = ad.list();
            else if (Array.isArray(ad)) adList = ad;
            else if (ad.items) {
                for (var k in ad.items) if (Object.prototype.hasOwnProperty.call(ad.items, k)) adList.push({ id: k, name: ad.items[k].name });
            }
            for (var a = 0; a < adList.length; a++) {
                var aid = adList[a].id || adList[a].name || ('a' + a);
                out.push({ source: 'analysis:' + aid, label: 'Analysis: ' + (adList[a].name || aid) });
            }
        }
        var gd = G.PRiSM_gaugeData;
        if (gd) {
            var gdList = [];
            if (typeof gd.list === 'function') gdList = gd.list();
            else if (Array.isArray(gd)) gdList = gd;
            else if (gd.items) {
                for (var kk in gd.items) if (Object.prototype.hasOwnProperty.call(gd.items, kk)) gdList.push({ id: kk, name: gd.items[kk].name });
            }
            for (var g = 0; g < gdList.length; g++) {
                var gid = gdList[g].id || gdList[g].name || ('g' + g);
                out.push({ source: 'gauge:' + gid, label: 'Gauge: ' + (gdList[g].name || gid) });
            }
        }
        var reg = G.PRiSM_MODELS;
        if (reg) {
            for (var key in reg) if (Object.prototype.hasOwnProperty.call(reg, key)) {
                if (reg[key] && typeof reg[key].pd === 'function' && reg[key].kind !== 'rate') {
                    out.push({ source: 'model:' + key, label: 'Model: ' + _modelName(key) });
                }
            }
        }
        var st = G.PRiSM_state || {};
        var hist = st.history || st.fitHistory || {};
        for (var fk in hist) if (Object.prototype.hasOwnProperty.call(hist, fk)) out.push({ source: 'fit:' + fk, label: 'Fit: ' + fk });
        return out;
    }

    function _esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    var _CTRL_CSS = 'padding:6px 8px; background:var(--bg1, #0d1117); color:var(--text, #e6edf3); ' +
                    'border:1px solid var(--border, #30363d); border-radius:4px; font-size:12px; max-width:100%; box-sizing:border-box;';

    G.PRiSM_renderOverlayManager = function PRiSM_renderOverlayManager(container) {
        if (!container || !_hasDoc) return;
        var items = G.PRiSM_overlays.list();
        var sources = _enumerateSources();
        var st = G.PRiSM_state || {};
        var plotKey = st.activePlot || 'bourdet';
        var sourceOpts = '<option value="">Add overlay…</option>';
        for (var i = 0; i < sources.length; i++) {
            sourceOpts += '<option value="' + _esc(sources[i].source) + '">' + _esc(sources[i].label) + '</option>';
        }
        var rows = '';
        if (!items.length) {
            rows = '<div style="font-size:12px; color:var(--text3, #6e7681); padding:6px 0;">No overlays yet.</div>';
        } else {
            for (var k = 0; k < items.length; k++) {
                var it = items[k];
                var res = _resolveOverlay(it.source);
                var canDraw = _seriesForPlot(res, plotKey, { tp: 1 }).length > 0;
                var why = !res ? 'not available' : (res.dimensionless ? 'needs a type-curve match or complete well inputs' : 'not shown on this plot');
                rows += '<div data-overlay-id="' + _esc(it.id) + '" style="display:flex; align-items:center; gap:8px; padding:4px 0; ' +
                            'border-bottom:1px solid var(--border, #30363d); min-width:0;">' +
                    '<input type="checkbox" data-overlay-toggle="' + _esc(it.id) + '"' + (it.visible ? ' checked' : '') + ' aria-label="Show overlay">' +
                    '<span style="flex:0 0 auto; width:14px; height:14px; border-radius:3px; background:' + _esc(it.color) + ';"></span>' +
                    '<span style="flex:1 1 auto; min-width:0; font-size:12px; color:var(--text, #e6edf3); overflow-wrap:anywhere;">' + _esc(it.label) +
                        (canDraw ? '' : ' <span style="color:var(--yellow, #d29922); font-size:11px;">(' + _esc(why) + ')</span>') + '</span>' +
                    '<button type="button" data-overlay-remove="' + _esc(it.id) + '" aria-label="Remove overlay" ' +
                        'style="background:none; border:none; color:var(--red, #f85149); cursor:pointer; font-size:16px; padding:2px 6px;">×</button>' +
                '</div>';
            }
        }
        container.innerHTML =
            '<div style="max-width:100%; box-sizing:border-box;">' +
                '<div data-overlay-list>' + rows + '</div>' +
                '<div style="display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-top:8px;">' +
                    '<select data-overlay-add aria-label="Add overlay" style="flex:1 1 180px; min-width:0; ' + _CTRL_CSS + '">' + sourceOpts + '</select>' +
                    '<button type="button" data-overlay-clear style="' + _CTRL_CSS + ' cursor:pointer;">Clear all</button>' +
                '</div>' +
            '</div>';

        function refresh() { G.PRiSM_renderOverlayManager(container); _redraw(); }
        var sel = container.querySelector('[data-overlay-add]');
        if (sel) sel.addEventListener('change', function (ev) {
            var v = ev.target.value;
            if (!v) return;
            G.PRiSM_overlays.add(v);
            refresh();
        });
        var clr = container.querySelector('[data-overlay-clear]');
        if (clr) clr.addEventListener('click', function () { G.PRiSM_overlays.clear(); refresh(); });
        var toggles = container.querySelectorAll('[data-overlay-toggle]');
        for (var tt = 0; tt < toggles.length; tt++) {
            (function (el) {
                el.addEventListener('change', function () {
                    G.PRiSM_overlays.toggle(el.getAttribute('data-overlay-toggle'));
                    _redraw();
                });
            })(toggles[tt]);
        }
        var rms = container.querySelectorAll('[data-overlay-remove]');
        for (var rr = 0; rr < rms.length; rr++) {
            (function (el) {
                el.addEventListener('click', function () {
                    G.PRiSM_overlays.remove(el.getAttribute('data-overlay-remove'));
                    refresh();
                });
            })(rms[rr]);
        }
    };

    // ═══════════════════════════════════════════════════════════════
    // SECTION 4 — TWO-DATASET DIFF (interpolation + summary stats)
    // ═══════════════════════════════════════════════════════════════
    //
    // PRiSM_datasetDiff(dataA, dataB) interpolates B onto A's time grid
    // (intersected with B's range) and returns:
    //   { t, dp, dq?, rms, maxAbs, nCommon }
    //
    // Linear interpolation, monotonic-time assumption. Skips NaNs.
    // ═══════════════════════════════════════════════════════════════

    function _interp(t, p, x) {
        if (!t || !t.length) return NaN;
        if (x <= t[0]) return p[0];
        if (x >= t[t.length - 1]) return p[t.length - 1];
        // Binary search for the bracket.
        var lo = 0, hi = t.length - 1;
        while (hi - lo > 1) {
            var mid = (lo + hi) >> 1;
            if (t[mid] <= x) lo = mid; else hi = mid;
        }
        var t0 = t[lo], t1 = t[hi];
        if (t1 === t0) return p[lo];
        var f = (x - t0) / (t1 - t0);
        return p[lo] + f * (p[hi] - p[lo]);
    }

    G.PRiSM_datasetDiff = function PRiSM_datasetDiff(dataA, dataB) {
        if (!dataA || !dataB || !Array.isArray(dataA.t) || !Array.isArray(dataB.t)) {
            return { t: [], dp: [], dq: null, rms: NaN, maxAbs: NaN, nCommon: 0 };
        }
        var hasP = (dataA.p && dataB.p);
        var hasQ = (dataA.q && dataB.q);
        if (!hasP) {
            return { t: [], dp: [], dq: null, rms: NaN, maxAbs: NaN, nCommon: 0 };
        }
        var tBmin = dataB.t[0], tBmax = dataB.t[dataB.t.length - 1];
        var tt = [], dpArr = [], dqArr = hasQ ? [] : null;
        var sumSq = 0, maxAbs = 0, n = 0;
        for (var i = 0; i < dataA.t.length; i++) {
            var ti = dataA.t[i];
            if (!isFinite(ti) || ti < tBmin || ti > tBmax) continue;
            var pa = dataA.p[i];
            var pb = _interp(dataB.t, dataB.p, ti);
            if (!isFinite(pa) || !isFinite(pb)) continue;
            var d = pa - pb;
            tt.push(ti);
            dpArr.push(d);
            sumSq += d * d;
            var a = Math.abs(d);
            if (a > maxAbs) maxAbs = a;
            n++;
            if (hasQ) {
                var qa = dataA.q[i];
                var qb = _interp(dataB.t, dataB.q, ti);
                dqArr.push((isFinite(qa) && isFinite(qb)) ? (qa - qb) : NaN);
            }
        }
        return {
            t:       tt,
            dp:      dpArr,
            dq:      dqArr,
            rms:     n ? Math.sqrt(sumSq / n) : NaN,
            maxAbs:  n ? maxAbs : NaN,
            nCommon: n
        };
    };

    // ═══════════════════════════════════════════════════════════════
    // SECTION 5 — DIFF PLOT (2-panel: superimposed + delta)
    // ═══════════════════════════════════════════════════════════════
    //
    // PRiSM_plot_dataset_diff(canvas, data, opts)
    //   data = { dataA: {t,p,q}, dataB: {t,p,q}, labelA?, labelB? }
    //   opts = { width, height, title, padding }
    //
    // Top panel: pA(t) and pB(t) on a shared linear/log time axis.
    // Bottom panel: dp = pA − pB (interpolated to A's grid).
    // ═══════════════════════════════════════════════════════════════

    function _setupCanvas(canvas, opts) {
        opts = opts || {};
        if (typeof G.PRiSM_plot_setup === 'function') {
            return G.PRiSM_plot_setup(canvas, opts);
        }
        // Inline mini-setup mirroring layer 2.
        var dpr = (typeof G !== 'undefined' && G.devicePixelRatio) || 1;
        var cssW = opts.width || (canvas && canvas.clientWidth) || (canvas && canvas.width) || 600;
        var cssH = opts.height || (canvas && canvas.clientHeight) || (canvas && canvas.height) || 400;
        if (canvas && canvas.style) {
            canvas.style.width = cssW + 'px';
            canvas.style.height = cssH + 'px';
        }
        if (canvas) {
            canvas.width = Math.round(cssW * dpr);
            canvas.height = Math.round(cssH * dpr);
        }
        var ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
        if (ctx && ctx.setTransform) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        var pad = Object.assign({}, _defaultPad(), opts.padding || {});
        return {
            ctx: ctx,
            plot: {
                x: pad.left, y: pad.top,
                w: cssW - pad.left - pad.right,
                h: cssH - pad.top - pad.bottom,
                cssW: cssW, cssH: cssH, pad: pad
            },
            dpr: dpr
        };
    }

    function _rangeOf(arr, padFrac) {
        var min = Infinity, max = -Infinity;
        for (var i = 0; i < arr.length; i++) {
            var v = arr[i];
            if (!isFinite(v)) continue;
            if (v < min) min = v;
            if (v > max) max = v;
        }
        if (!isFinite(min) || !isFinite(max)) return { min: 0, max: 1 };
        if (min === max) {
            if (min === 0) return { min: -1, max: 1 };
            min = min - Math.abs(min) * 0.1;
            max = max + Math.abs(max) * 0.1;
        }
        var span = max - min;
        var pf = padFrac == null ? 0.05 : padFrac;
        return { min: min - span * pf, max: max + span * pf };
    }

    G.PRiSM_plot_dataset_diff = function PRiSM_plot_dataset_diff(canvas, data, opts) {
        opts = opts || {};
        if (!canvas || !canvas.getContext) return;
        var setup = _setupCanvas(canvas, opts);
        var ctx = setup.ctx, plot = setup.plot;
        if (!ctx) return;
        var th = _theme();
        var dataA = data && data.dataA, dataB = data && data.dataB;
        // Background
        ctx.fillStyle = th.bg;
        ctx.fillRect(0, 0, plot.cssW, plot.cssH);
        if (!dataA || !dataB || !dataA.t || !dataB.t || !dataA.t.length || !dataB.t.length) {
            ctx.fillStyle = th.text3;
            ctx.font = '13px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('Select two datasets to diff', plot.cssW / 2, plot.cssH / 2);
            return;
        }
        var labelA = (data.labelA || 'Dataset A');
        var labelB = (data.labelB || 'Dataset B');

        var diff = G.PRiSM_datasetDiff(dataA, dataB);

        // Split the plot region into top (60%) and bottom (35%) with a gutter.
        var gutter = 14;
        var topH = Math.floor(plot.h * 0.60);
        var botH = plot.h - topH - gutter;
        var topPlot = { x: plot.x, y: plot.y, w: plot.w, h: topH };
        var botPlot = { x: plot.x, y: plot.y + topH + gutter, w: plot.w, h: botH };

        // Shared X range (union of both, padded).
        var xMinA = dataA.t[0], xMaxA = dataA.t[dataA.t.length - 1];
        var xMinB = dataB.t[0], xMaxB = dataB.t[dataB.t.length - 1];
        var xMin = Math.min(xMinA, xMinB);
        var xMax = Math.max(xMaxA, xMaxB);
        if (xMax <= xMin) xMax = xMin + 1;

        // Top Y range (both pressures).
        var pAll = (dataA.p || []).concat(dataB.p || []);
        var yT = _rangeOf(pAll, 0.05);
        // Bottom Y range (delta).
        var yB = _rangeOf(diff.dp, 0.10);

        function panelFrame(pp) {
            ctx.fillStyle = th.panel;
            ctx.fillRect(pp.x, pp.y, pp.w, pp.h);
            ctx.strokeStyle = th.border;
            ctx.lineWidth = 1;
            ctx.strokeRect(pp.x + 0.5, pp.y + 0.5, pp.w, pp.h);
        }

        function lineSeries(pp, t, p, xMn, xMx, yMn, yMx, color, dash) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(pp.x, pp.y, pp.w, pp.h);
            ctx.clip();
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            if (dash) ctx.setLineDash(dash);
            ctx.beginPath();
            var started = false;
            for (var i = 0; i < t.length; i++) {
                if (!isFinite(t[i]) || !isFinite(p[i])) { started = false; continue; }
                var x = pp.x + (t[i] - xMn) / (xMx - xMn) * pp.w;
                var y = pp.y + pp.h - (p[i] - yMn) / (yMx - yMn) * pp.h;
                if (!isFinite(x) || !isFinite(y)) { started = false; continue; }
                if (!started) { ctx.moveTo(x, y); started = true; }
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.restore();
        }

        // Top panel
        panelFrame(topPlot);
        lineSeries(topPlot, dataA.t, dataA.p, xMin, xMax, yT.min, yT.max, th.accent);
        lineSeries(topPlot, dataB.t, dataB.p, xMin, xMax, yT.min, yT.max, th.blue, [6, 4]);

        // Top y-axis labels (3 ticks)
        ctx.fillStyle = th.text2;
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (var t = 0; t <= 4; t++) {
            var v = yT.min + (yT.max - yT.min) * (t / 4);
            var py = topPlot.y + topPlot.h - (v - yT.min) / (yT.max - yT.min) * topPlot.h;
            ctx.fillText(v.toPrecision(3), topPlot.x - 4, py);
        }

        // Top legend
        ctx.fillStyle = 'rgba(13,17,23,0.85)';
        ctx.fillRect(topPlot.x + 8, topPlot.y + 8, 130, 36);
        ctx.strokeStyle = th.border;
        ctx.strokeRect(topPlot.x + 8.5, topPlot.y + 8.5, 130, 36);
        ctx.strokeStyle = th.accent;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(topPlot.x + 14, topPlot.y + 18);
        ctx.lineTo(topPlot.x + 30, topPlot.y + 18);
        ctx.stroke();
        ctx.fillStyle = th.text;
        ctx.textAlign = 'left';
        ctx.fillText(labelA, topPlot.x + 36, topPlot.y + 18);
        ctx.strokeStyle = th.blue;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(topPlot.x + 14, topPlot.y + 32);
        ctx.lineTo(topPlot.x + 30, topPlot.y + 32);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = th.text;
        ctx.fillText(labelB, topPlot.x + 36, topPlot.y + 32);

        // Title
        if (opts.title) {
            ctx.fillStyle = th.text;
            ctx.font = 'bold 13px sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText(opts.title, topPlot.x, 8);
        }

        // Bottom panel — Δp
        panelFrame(botPlot);
        // Zero line if range crosses
        if (yB.min < 0 && yB.max > 0) {
            ctx.strokeStyle = th.text3;
            ctx.setLineDash([3, 3]);
            var zy = botPlot.y + botPlot.h - (0 - yB.min) / (yB.max - yB.min) * botPlot.h;
            ctx.beginPath();
            ctx.moveTo(botPlot.x, zy);
            ctx.lineTo(botPlot.x + botPlot.w, zy);
            ctx.stroke();
            ctx.setLineDash([]);
        }
        lineSeries(botPlot, diff.t, diff.dp, xMin, xMax, yB.min, yB.max, th.green);

        // Y-axis labels for bottom
        ctx.fillStyle = th.text2;
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (var bt = 0; bt <= 2; bt++) {
            var bv = yB.min + (yB.max - yB.min) * (bt / 2);
            var bpy = botPlot.y + botPlot.h - (bv - yB.min) / (yB.max - yB.min) * botPlot.h;
            ctx.fillText(bv.toPrecision(3), botPlot.x - 4, bpy);
        }

        // X-axis ticks shared at bottom of bottom panel.
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (var xt = 0; xt <= 5; xt++) {
            var xv = xMin + (xMax - xMin) * (xt / 5);
            var xpx = botPlot.x + (xv - xMin) / (xMax - xMin) * botPlot.w;
            ctx.fillText(xv.toPrecision(3), xpx, botPlot.y + botPlot.h + 4);
        }

        // Y-labels (rotated)
        ctx.fillStyle = th.text;
        ctx.font = '11px sans-serif';
        ctx.save();
        ctx.translate(14, topPlot.y + topPlot.h / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Pressure', 0, 0);
        ctx.restore();
        ctx.save();
        ctx.translate(14, botPlot.y + botPlot.h / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('ΔP', 0, 0);
        ctx.restore();

        // Stats footer
        ctx.fillStyle = th.text2;
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText(
            'n=' + diff.nCommon + '  RMS=' + (isFinite(diff.rms) ? diff.rms.toPrecision(3) : '—') +
            '  max|Δp|=' + (isFinite(diff.maxAbs) ? diff.maxAbs.toPrecision(3) : '—'),
            botPlot.x + botPlot.w, plot.cssH - 4
        );
    };

    // ═══════════════════════════════════════════════════════════════
    // SECTION 5b — DIFF PICKER UI
    // ═══════════════════════════════════════════════════════════════

    function _diffSourceList() {
        var out = [];
        var ds = G.PRiSM_dataset;
        if (ds && ds.t) {
            out.push({ id: 'current', name: 'Current dataset', resolve: function () { return ds; } });
        }
        var gd = G.PRiSM_gaugeData;
        if (gd) {
            var list = (typeof gd.list === 'function') ? gd.list()
                     : Array.isArray(gd) ? gd
                     : (gd.items ? Object.keys(gd.items).map(function (k) { return Object.assign({ id: k }, gd.items[k]); }) : []);
            for (var i = 0; i < list.length; i++) {
                (function (g, idx) {
                    var gid = g.id || g.name || ('g' + idx);
                    out.push({ id: 'gauge:' + gid, name: 'Gauge: ' + (g.name || gid),
                               resolve: function () { return _resolveOverlay('gauge:' + gid); } });
                })(list[i], i);
            }
        }
        var ad = G.PRiSM_analysisData;
        if (ad) {
            var alist = (typeof ad.list === 'function') ? ad.list()
                      : Array.isArray(ad) ? ad
                      : (ad.items ? Object.keys(ad.items).map(function (k) { return Object.assign({ id: k }, ad.items[k]); }) : []);
            for (var j = 0; j < alist.length; j++) {
                (function (a, idx) {
                    var aid = a.id || a.name || ('a' + idx);
                    out.push({ id: 'analysis:' + aid, name: 'Analysis: ' + (a.name || aid),
                               resolve: function () { return _resolveOverlay('analysis:' + aid); } });
                })(alist[j], j);
            }
        }
        var st = G.PRiSM_state || {};
        var saved = st.savedSets || st.snapshots || {};
        for (var sk in saved) if (Object.prototype.hasOwnProperty.call(saved, sk)) {
            (function (key, snap) {
                out.push({ id: 'saved:' + key, name: 'Saved: ' + key, resolve: function () { return snap; } });
            })(sk, saved[sk]);
        }
        return out;
    }

    G.PRiSM_renderDiffPicker = function PRiSM_renderDiffPicker(container) {
        if (!container || !_hasDoc) return;
        var sources = _diffSourceList();
        function buildOpts(sel) {
            var opts = '<option value="">Pick a dataset…</option>';
            for (var i = 0; i < sources.length; i++) {
                opts += '<option value="' + _esc(sources[i].id) + '"' + (sources[i].id === sel ? ' selected' : '') + '>' +
                        _esc(sources[i].name) + '</option>';
            }
            return opts;
        }
        container.innerHTML =
            '<div style="max-width:100%; box-sizing:border-box;">' +
                (sources.length < 2
                    ? '<div style="font-size:12px; color:var(--text3, #6e7681); margin-bottom:6px;">Load a second gauge or analysis dataset (Tab 1) to compare it with the current data.</div>'
                    : '') +
                '<div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:8px;">' +
                    '<label style="flex:1 1 150px; min-width:0; font-size:12px; color:var(--text2, #8b949e); display:flex; gap:6px; align-items:center;">A ' +
                        '<select data-diff-a style="flex:1 1 auto; min-width:0; ' + _CTRL_CSS + '">' + buildOpts('current') + '</select></label>' +
                    '<label style="flex:1 1 150px; min-width:0; font-size:12px; color:var(--text2, #8b949e); display:flex; gap:6px; align-items:center;">B ' +
                        '<select data-diff-b style="flex:1 1 auto; min-width:0; ' + _CTRL_CSS + '">' + buildOpts('') + '</select></label>' +
                    '<button type="button" data-diff-go class="btn btn-secondary" style="font-size:12px; padding:6px 12px;">Compare</button>' +
                '</div>' +
                '<canvas data-diff-canvas style="width:100%; height:300px; display:block; ' +
                    'background:var(--bg1, #0d1117); border:1px solid var(--border, #30363d); border-radius:4px;"></canvas>' +
                '<div data-diff-summary role="status" style="margin-top:6px; font-size:11px; color:var(--text2, #8b949e);"></div>' +
            '</div>';
        var btn = container.querySelector('[data-diff-go]');
        if (btn) btn.addEventListener('click', function () {
            var aSel = container.querySelector('[data-diff-a]');
            var bSel = container.querySelector('[data-diff-b]');
            var idA = aSel && aSel.value, idB = bSel && bSel.value;
            var sum = container.querySelector('[data-diff-summary]');
            if (!idA || !idB) { if (sum) sum.textContent = 'Pick two datasets.'; return; }
            var a = sources.filter(function (x) { return x.id === idA; })[0];
            var b = sources.filter(function (x) { return x.id === idB; })[0];
            if (!a || !b) return;
            var dA = a.resolve(), dB = b.resolve();
            var canvas = container.querySelector('[data-diff-canvas]');
            G.PRiSM_plot_dataset_diff(canvas, { dataA: dA, dataB: dB, labelA: a.name, labelB: b.name },
                                      { title: a.name + ' − ' + b.name });
            var diff = G.PRiSM_datasetDiff(dA, dB);
            if (sum) {
                sum.textContent = 'Common samples: ' + diff.nCommon +
                    ' · RMS Δp = ' + (isFinite(diff.rms) ? diff.rms.toPrecision(4) : '—') + ' psi' +
                    ' · max |Δp| = ' + (isFinite(diff.maxAbs) ? diff.maxAbs.toPrecision(4) : '—') + ' psi';
            }
            _ga4('prism_diff_compute', {});
        });
    };

    // ═══════════════════════════════════════════════════════════════
    // SECTION 6 — XML EXPORT
    // ═══════════════════════════════════════════════════════════════
    //
    // Serialise the PRiSM project into a single XML document.
    // Number arrays are space-separated (compact, but still parseable).
    // String content gets the standard 5-entity escape.
    // ═══════════════════════════════════════════════════════════════

    function _xmlEscape(s) {
        return String(s == null ? '' : s)
            .replace(/&/g,  '&amp;')
            .replace(/</g,  '&lt;')
            .replace(/>/g,  '&gt;')
            .replace(/"/g,  '&quot;')
            .replace(/'/g,  '&apos;');
    }

    function _xmlAttrs(attrs) {
        if (!attrs) return '';
        var out = '';
        for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) {
            if (attrs[k] == null) continue;
            out += ' ' + k + '="' + _xmlEscape(attrs[k]) + '"';
        }
        return out;
    }

    function _arrCompact(arr) {
        if (!arr || !arr.length) return '';
        var parts = [];
        for (var i = 0; i < arr.length; i++) {
            var v = arr[i];
            if (v == null || !isFinite(v)) parts.push('NaN');
            else parts.push(String(v));
        }
        return parts.join(' ');
    }

    // Lightweight XML builder. _b(name, attrs, children) where children
    // is either: a string (raw text — must already be escaped or be an
    // array-compact string), an array of more _b() outputs, or null.
    function _xmlBuilder(pretty) {
        var nl = pretty ? '\n' : '';
        function indent(n) {
            if (!pretty) return '';
            var s = ''; for (var i = 0; i < n; i++) s += '  '; return s;
        }
        function build(name, attrs, children, depth) {
            depth = depth || 0;
            var pre = indent(depth);
            var openTag = '<' + name + _xmlAttrs(attrs);
            if (children == null || children === '' || (Array.isArray(children) && !children.length)) {
                return pre + openTag + '/>' + nl;
            }
            if (typeof children === 'string') {
                // Inline content — keep on one line if short, else block
                if (children.length < 80 && children.indexOf('\n') < 0) {
                    return pre + openTag + '>' + children + '</' + name + '>' + nl;
                }
                return pre + openTag + '>' + nl + indent(depth + 1) + children + nl +
                       pre + '</' + name + '>' + nl;
            }
            // Array of pre-built strings (each already includes newline if pretty)
            var inner = children.join('');
            return pre + openTag + '>' + nl + inner + pre + '</' + name + '>' + nl;
        }
        return build;
    }

    function _now() {
        try { return (new Date()).toISOString(); } catch (e) { return ''; }
    }

    function _formatStamp() {
        try {
            var d = new Date();
            var yyyy = d.getFullYear();
            var mm = String(d.getMonth() + 1).padStart(2, '0');
            var dd = String(d.getDate()).padStart(2, '0');
            var hh = String(d.getHours()).padStart(2, '0');
            var mi = String(d.getMinutes()).padStart(2, '0');
            var ss = String(d.getSeconds()).padStart(2, '0');
            return yyyy + mm + dd + '-' + hh + mi + ss;
        } catch (e) { return 'export'; }
    }

    function _serializeMeta(b) {
        return b('Meta', null, [
            b('Name',      null, _xmlEscape((G.PRiSM_state && G.PRiSM_state.projectName) || 'PRiSM Project'), 2),
            b('CreatedAt', null, _xmlEscape(_now()), 2),
            b('Notes',     null, _xmlEscape((G.PRiSM_state && G.PRiSM_state.notes) || ''), 2)
        ], 1);
    }

    function _serializePVT(b) {
        var pvt = G.PRiSM_pvt;
        if (!pvt) return b('PVT', { available: 'false' }, null, 1);
        var children = [];
        var keysToSerialise = ['inputs', 'computed', 'fluidType', 'units'];
        for (var i = 0; i < keysToSerialise.length; i++) {
            var k = keysToSerialise[i];
            if (pvt[k] == null) continue;
            var section = pvt[k];
            if (typeof section === 'object' && !Array.isArray(section)) {
                var fields = [];
                for (var fk in section) if (Object.prototype.hasOwnProperty.call(section, fk)) {
                    var v = section[fk];
                    if (v == null) continue;
                    if (typeof v === 'object') continue; // skip nested
                    fields.push(b(fk, null, _xmlEscape(String(v)), 3));
                }
                children.push(b(k.charAt(0).toUpperCase() + k.slice(1), null, fields, 2));
            } else if (typeof section !== 'object') {
                children.push(b(k.charAt(0).toUpperCase() + k.slice(1), null, _xmlEscape(String(section)), 2));
            }
        }
        if (!children.length) return b('PVT', { available: 'true', empty: 'true' }, null, 1);
        return b('PVT', { available: 'true' }, children, 1);
    }

    function _serializeGauges(b, includeRaw) {
        var gd = G.PRiSM_gaugeData;
        if (!gd) return b('GaugeData', { available: 'false' }, null, 1);
        var list = (typeof gd.list === 'function') ? gd.list()
                 : Array.isArray(gd) ? gd
                 : (gd.items ? Object.keys(gd.items).map(function (k) {
                     return Object.assign({ id: k }, gd.items[k]);
                   }) : []);
        if (!list.length) return b('GaugeData', { available: 'true', empty: 'true' }, null, 1);
        var children = [];
        for (var i = 0; i < list.length; i++) {
            var g = list[i];
            var gid = g.id || g.name || ('gauge_' + i);
            var attrs = { id: gid, name: (g.name || gid) };
            var inner = [];
            if (g.metadata && typeof g.metadata === 'object') {
                var meta = [];
                for (var mk in g.metadata) if (Object.prototype.hasOwnProperty.call(g.metadata, mk)) {
                    if (typeof g.metadata[mk] === 'object') continue;
                    meta.push(b(mk, null, _xmlEscape(String(g.metadata[mk])), 4));
                }
                if (meta.length) inner.push(b('Metadata', null, meta, 3));
            }
            var t = g.t || (g.samples && g.samples.t) || [];
            var p = g.p || (g.samples && g.samples.p) || [];
            var q = g.q || (g.samples && g.samples.q) || null;
            inner.push(b('Samples', { count: t.length, includeRaw: !!includeRaw }, includeRaw && t.length ? [
                b('t', null, _arrCompact(t), 4),
                p.length ? b('p', null, _arrCompact(p), 4) : '',
                (q && q.length) ? b('q', null, _arrCompact(q), 4) : ''
            ].filter(Boolean) : null, 3));
            children.push(b('Gauge', attrs, inner, 2));
        }
        return b('GaugeData', { available: 'true', count: list.length }, children, 1);
    }

    function _serializeAnalysis(b) {
        var ad = G.PRiSM_analysisData;
        if (!ad) return b('AnalysisData', { available: 'false' }, null, 1);
        var list = (typeof ad.list === 'function') ? ad.list()
                 : Array.isArray(ad) ? ad
                 : (ad.items ? Object.keys(ad.items).map(function (k) {
                     return Object.assign({ id: k }, ad.items[k]);
                   }) : []);
        if (!list.length) return b('AnalysisData', { available: 'true', empty: 'true' }, null, 1);
        var children = [];
        for (var i = 0; i < list.length; i++) {
            var a = list[i];
            var aid = a.id || a.name || ('analysis_' + i);
            var attrs = {
                id:          aid,
                name:        (a.name || aid),
                derivedFrom: (a.derivedFrom || a.source || '')
            };
            var inner = [];
            var t = a.t || (a.data && a.data.t) || [];
            var p = a.p || (a.data && a.data.p) || [];
            var dp = a.dp || (a.data && a.data.dp) || [];
            inner.push(b('Samples', { count: t.length },
                (t.length ? [
                    b('t', null, _arrCompact(t), 4),
                    p.length  ? b('p',  null, _arrCompact(p),  4) : '',
                    dp.length ? b('dp', null, _arrCompact(dp), 4) : ''
                ].filter(Boolean) : null), 3));
            if (a.notes) inner.push(b('Notes', null, _xmlEscape(String(a.notes)), 3));
            children.push(b('Analysis', attrs, inner, 2));
        }
        return b('AnalysisData', { available: 'true', count: list.length }, children, 1);
    }

    function _serializeWell(b) {
        var w = null;
        if (typeof G.PRiSM_getWell === 'function') { try { w = G.PRiSM_getWell(); } catch (e) { w = null; } }
        if (!w || typeof w !== 'object') return b('Well', { available: 'false' }, null, 1);
        var gas = w.fluid === 'gas';
        var units = { q: gas ? 'Mscf/d' : 'STB/d', B: gas ? 'RB/Mscf' : 'RB/STB', mu: 'cp', ct: '1/psi', h: 'ft',
                      phi: 'fraction', rw: 'ft', pi: 'psia', T_R: 'degR', tp: 'hr', tShut: 'hr', pwf0: 'psia' };   // T_R is Rankine (°F + 459.67)
        var keys = ['fluid', 'testType', 'q', 'B', 'mu', 'ct', 'h', 'phi', 'rw', 'pi', 'T_R', 'sg', 'tp', 'tShut', 'pwf0'];
        var dflt = Array.isArray(w.defaulted) ? w.defaulted : [];
        var children = [];
        keys.forEach(function (k) {
            if (w[k] == null || (typeof w[k] === 'number' && !isFinite(w[k]))) return;
            children.push(b('Input', { name: k, unit: units[k] || null, defaulted: dflt.indexOf(k) !== -1 ? 'true' : null },
                            _xmlEscape(String(w[k])), 2));
        });
        return b('Well', { available: 'true', complete: w.complete ? 'true' : 'false' }, children.length ? children : null, 1);
    }

    // C2 analysis data: Δt, p, sign-aware Δp and its Bourdet derivative.
    function _serializeDerivative(b) {
        var ad = _analysisData();
        if (!ad || !ad.ok) return b('DerivativeData', { available: 'false' }, null, 1);
        var attrs = {
            available: 'true', count: ad.t.length,
            pRef: _num(ad.pRef) ? ad.pRef : null, pRefSource: ad.pRefSource || null,
            testType: ad.testType || null, timeFn: ad.timeFn || null, L: _num(ad.L) ? ad.L : null
        };
        return b('DerivativeData', attrs, [
            b('dt_hr', null, _arrCompact(_toArr(ad.t)), 2),
            ad.p ? b('p_psia', null, _arrCompact(_toArr(ad.p)), 2) : '',
            b('dp_psi', null, _arrCompact(_toArr(ad.dp)), 2),
            ad.deriv ? b('dp_deriv_psi', null, _arrCompact(_toArr(ad.deriv)), 2) : ''
        ].filter(Boolean), 1);
    }

    function _serializeLineTools(b) {
        if (typeof G.PRiSM_analysisKeyReportRows !== 'function') return b('LineTools', { available: 'false' }, null, 1);
        var rows = [];
        try { rows = G.PRiSM_analysisKeyReportRows() || []; } catch (e) { rows = []; }
        if (!rows.length) return b('LineTools', { available: 'true', count: 0 }, null, 1);
        var byKey = {}, order = [];
        rows.forEach(function (r) {
            if (!byKey[r.key]) { byKey[r.key] = { label: r.tool, defaulted: r.defaulted, rows: [] }; order.push(r.key); }
            byKey[r.key].rows.push(r);
        });
        var children = order.map(function (k) {
            var e = byKey[k];
            return b('Tool', { key: k, label: e.label, defaultInputs: e.defaulted ? 'true' : null },
                     e.rows.map(function (r) {
                         return b('Value', { name: r.quantity, unit: r.unit || null }, _xmlEscape(String(r.value)), 3);
                     }), 2);
        });
        return b('LineTools', { available: 'true', count: order.length }, children, 1);
    }

    function _lastFit() {
        var lf = null;
        if (typeof G.PRiSM_getLastFit === 'function') { try { lf = G.PRiSM_getLastFit(); } catch (e) { lf = null; } }
        if (!lf) lf = (G.PRiSM_state || {}).lastFit || null;
        return lf;
    }

    function _kvChildren(b, obj, depth, tag) {
        var out = [];
        for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) {
            var v = obj[k];
            if (v == null || typeof v === 'object' || typeof v === 'function') continue;
            out.push(b(tag || 'Param', { name: k }, _xmlEscape(String(v)), depth));
        }
        return out;
    }

    function _serializeModel(b, includeFitHistory) {
        var st = G.PRiSM_state || {};
        var children = [];
        children.push(b('Active', null, _xmlEscape(st.model || ''), 2));
        var params = st.params || {}, paramChildren = [];
        for (var pk in params) if (Object.prototype.hasOwnProperty.call(params, pk)) {
            if (params[pk] == null || typeof params[pk] === 'object') continue;
            paramChildren.push(b('Param', { name: pk, frozen: !!(st.paramFreeze && st.paramFreeze[pk]) },
                                 _xmlEscape(String(params[pk])), 3));
        }
        children.push(b('Params', null, paramChildren.length ? paramChildren : null, 2));
        if (st.tcMatch && typeof st.tcMatch === 'object') {
            children.push(b('TypeCurveMatch', { logPM: _num(st.tcMatch.logPM) ? st.tcMatch.logPM : null,
                                                logTM: _num(st.tcMatch.logTM) ? st.tcMatch.logTM : null,
                                                source: st.tcMatch.source || null }, null, 2));
        }
        var lf = _lastFit();
        if (lf) {
            var lfChildren = [];
            if (lf.params) lfChildren.push(b('Params', null, _kvChildren(b, lf.params, 4), 3));
            if (lf.phys) lfChildren.push(b('Physical', null, _kvChildren(b, lf.phys, 4, 'Value'), 3));
            if (lf.ci95) {
                var ci = [];
                for (var ck in lf.ci95) if (Object.prototype.hasOwnProperty.call(lf.ci95, ck)) {
                    var rng = lf.ci95[ck] || [];
                    ci.push(b('CI', { name: ck, low: rng[0], high: rng[1] }, null, 4));
                }
                if (ci.length) lfChildren.push(b('CI95', null, ci, 3));
            }
            var r2 = _num(lf.r2) ? lf.r2 : lf.R2, rmse = _num(lf.rmse) ? lf.rmse : lf.RMSE, aic = _num(lf.aic) ? lf.aic : lf.AIC;
            if (_num(aic))  lfChildren.push(b('AIC',  null, _xmlEscape(String(aic)),  3));
            if (_num(r2))   lfChildren.push(b('R2',   null, _xmlEscape(String(r2)),   3));
            if (_num(rmse)) lfChildren.push(b('RMSE', null, _xmlEscape(String(rmse)), 3));
            if (_num(lf.iterations)) lfChildren.push(b('Iterations', null, _xmlEscape(String(lf.iterations)), 3));
            if (lf.converged != null) lfChildren.push(b('Converged', null, _xmlEscape(String(!!lf.converged)), 3));
            children.push(b('LastFit', { model: lf.modelKey || lf.model || null, source: lf.source || null },
                            lfChildren.length ? lfChildren : null, 2));
        }
        if (st.semilog && typeof st.semilog === 'object') {
            children.push(b('Semilog', { method: st.semilog.method || null }, _kvChildren(b, st.semilog, 3, 'Value'), 2));
        }
        if (includeFitHistory) {
            var hist = st.history || st.fitHistory || {}, histChildren = [];
            for (var hk in hist) if (Object.prototype.hasOwnProperty.call(hist, hk)) {
                var f = hist[hk] || {};
                histChildren.push(b('Fit', { key: hk, aic: _num(f.aic) ? f.aic : null, r2: _num(f.r2) ? f.r2 : null,
                                             model: f.model || f.modelKey || null }, null, 3));
            }
            if (histChildren.length) children.push(b('FitHistory', { count: histChildren.length }, histChildren, 2));
        }
        return b('Model', null, children, 1);
    }

    function _serializeDataset(b, includeRaw) {
        var ds = G.PRiSM_dataset;
        if (!ds || !ds.t) return b('Dataset', { available: 'false' }, null, 1);
        var children = [];
        if (ds.periods && ds.periods.length) {
            var pc = [];
            for (var i = 0; i < ds.periods.length; i++) {
                var pr = ds.periods[i], bb = _periodBounds(pr) || {};
                pc.push(b('Period', { index: i, t0: bb.t0, t1: bb.t1, q: pr.q }, null, 3));
            }
            children.push(b('Periods', { count: pc.length }, pc, 2));
        }
        if (includeRaw && ds.t.length) {
            children.push(b('Samples', { count: ds.t.length }, [
                b('t_hr', null, _arrCompact(_toArr(ds.t)), 3),
                ds.p ? b('p_psia', null, _arrCompact(_toArr(ds.p)), 3) : '',
                ds.q ? b('q', null, _arrCompact(_toArr(ds.q)), 3) : ''
            ].filter(Boolean), 2));
        } else {
            children.push(b('Samples', { count: ds.t.length, includeRaw: 'false' }, null, 2));
        }
        return b('Dataset', { available: 'true', samples: ds.t.length }, children, 1);
    }

    G.PRiSM_exportXML = function PRiSM_exportXML(opts) {
        opts = opts || {};
        var pretty            = opts.pretty !== false;
        var includeRawGauge   = !!opts.includeRawGaugeData;
        var includeAnalysis   = opts.includeAnalysisData !== false;
        var includeFitHistory = opts.includeFitHistory   !== false;
        var includeRawDataset = opts.includeRawDataset   !== false;

        var b = _xmlBuilder(pretty);
        var nl = pretty ? '\n' : '';
        var sections = [];
        sections.push(_serializeMeta(b));
        sections.push(_serializeWell(b));
        sections.push(_serializePVT(b));
        sections.push(_serializeDataset(b, includeRawDataset));
        sections.push(_serializeDerivative(b));
        sections.push(_serializeGauges(b, includeRawGauge));
        if (includeAnalysis) sections.push(_serializeAnalysis(b));
        sections.push(_serializeModel(b, includeFitHistory));
        sections.push(_serializeLineTools(b));

        var body = b('PRiSMProject', { version: '1.1', exportedAt: _now(), generator: 'PRiSM' }, sections, 0);
        var xml = '<?xml version="1.0" encoding="UTF-8"?>' + nl + body;
        var filename = 'prism-export-' + _formatStamp() + '.xml';
        var blob = null;
        try { if (typeof Blob === 'function' || typeof Blob === 'object') blob = new Blob([xml], { type: 'application/xml' }); }
        catch (e) { blob = null; }
        _ga4('prism_xml_export', {});
        return { blob: blob, filename: filename, xmlString: xml };
    };

    // ═══════════════════════════════════════════════════════════════
    // SECTION 7 — DOWNLOAD HELPER (general)
    // ═══════════════════════════════════════════════════════════════

    function _downloadText(text, filename, mime) {
        if (!_hasDoc) return false;
        try {
            var url, blob = null;
            if (typeof Blob !== 'undefined') blob = new Blob([text], { type: mime || 'text/plain' });
            if (blob && typeof URL !== 'undefined' && URL.createObjectURL) url = URL.createObjectURL(blob);
            else url = 'data:' + (mime || 'text/plain') + ';charset=utf-8,' + encodeURIComponent(text);
            var a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            if (url && url.indexOf('blob:') === 0 && URL.revokeObjectURL) {
                setTimeout(function () { URL.revokeObjectURL(url); }, 0);
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    G.PRiSM_exportXMLDownload = function PRiSM_exportXMLDownload(opts) {
        var res = G.PRiSM_exportXML(opts);
        if (!_downloadText(res.xmlString, res.filename, 'application/xml')) {
            try { console.warn('PRiSM_exportXMLDownload: download not available'); } catch (_) { /* ignore */ }
        }
        return res;
    };

    // ═══════════════════════════════════════════════════════════════
    // SECTION 8 — CLIPBOARD HELPERS (PNG + TSV/CSV/JSON)
    // ═══════════════════════════════════════════════════════════════

    function _hasClipboardImageAPI() {
        try {
            return _hasWin && G.navigator && G.navigator.clipboard &&
                   typeof G.navigator.clipboard.write === 'function' && typeof G.ClipboardItem === 'function';
        } catch (e) { return false; }
    }

    function _hasClipboardTextAPI() {
        try {
            return _hasWin && G.navigator && G.navigator.clipboard && typeof G.navigator.clipboard.writeText === 'function';
        } catch (e) { return false; }
    }

    // Off-screen render (11: PRiSM_renderPlotToCanvas uses PRiSM_buildPlotData)
    // or, failing that, a snapshot of the live plot canvas.
    function _plotCanvas(plotKey, w, h) {
        var key = plotKey || (G.PRiSM_state && G.PRiSM_state.activePlot) || 'bourdet';
        if (typeof G.PRiSM_renderPlotToCanvas === 'function') {
            try { var c = G.PRiSM_renderPlotToCanvas(key, w, h); if (c) return c; } catch (e) { /* snapshot */ }
        }
        if (!_hasDoc) return null;
        var live = document.getElementById('prism_plot_canvas');
        if (!live) return null;
        var off = document.createElement('canvas');
        off.width = w || live.width || 1200;
        off.height = h || live.height || 800;
        try { off.getContext('2d').drawImage(live, 0, 0, off.width, off.height); return off; } catch (e2) { return null; }
    }

    G.PRiSM_copyPlotToClipboard = function PRiSM_copyPlotToClipboard(plotKey) {
        return new Promise(function (resolve) {
            try {
                var off = _plotCanvas(plotKey, 1200, 800);
                if (!off || !off.toBlob) { resolve({ success: false, error: 'No plot available' }); return; }
                if (!_hasClipboardImageAPI()) {
                    var url = '';
                    try { url = off.toDataURL('image/png'); } catch (e) { /* ignore */ }
                    resolve({ success: false, error: 'Copying images is not supported here — use Export PNG', dataUrl: url });
                    return;
                }
                off.toBlob(function (blob) {
                    if (!blob) { resolve({ success: false, error: 'Could not encode the image' }); return; }
                    try {
                        var item = new G.ClipboardItem({ 'image/png': blob });
                        G.navigator.clipboard.write([item]).then(function () {
                            _ga4('prism_copy_plot', {});
                            resolve({ success: true });
                        }, function (err) {
                            resolve({ success: false, error: (err && err.message) || String(err) });
                        });
                    } catch (e) {
                        resolve({ success: false, error: e && e.message });
                    }
                }, 'image/png');
            } catch (e) {
                resolve({ success: false, error: e && e.message });
            }
        });
    };

    // Raw samples: t [hr], p [psia], q.
    function _rawTable(ds, sep) {
        if (!ds || !ds.t) return '';
        var cols = ['t_hr'];
        if (ds.p) cols.push('p_psia');
        if (ds.q) cols.push('q');
        var lines = [cols.join(sep)];
        for (var i = 0; i < ds.t.length; i++) {
            var row = [String(ds.t[i])];
            if (ds.p) row.push(String(ds.p[i]));
            if (ds.q) row.push(String(ds.q[i]));
            lines.push(row.join(sep));
        }
        return lines.join('\n');
    }

    // Analysis data (C2): Δt, t, p, Δp and Δp′ in psi.
    function _analysisTable(ad, sep) {
        if (!ad || !ad.ok || !ad.t) return '';
        var t = _toArr(ad.t), tAbs = _toArr(ad.tAbs), p = _toArr(ad.p), dp = _toArr(ad.dp), dv = _toArr(ad.deriv);
        var cols = ['dt_hr'];
        if (tAbs) cols.push('t_hr');
        if (p) cols.push('p_psia');
        cols.push('dp_psi', 'dp_deriv_psi');
        var lines = [cols.join(sep)];
        for (var i = 0; i < t.length; i++) {
            var row = [String(t[i])];
            if (tAbs) row.push(String(tAbs[i]));
            if (p) row.push(String(p[i]));
            row.push(String(dp[i]), (dv && _num(dv[i])) ? String(dv[i]) : '');
            lines.push(row.join(sep));
        }
        return lines.join('\n');
    }

    function _dataJSON(ds, ad) {
        var out = { units: { t: 'hr', p: 'psia', dp: 'psi' } };
        if (ds && ds.t) out.raw = { t_hr: _toArr(ds.t), p_psia: _toArr(ds.p) || null, q: _toArr(ds.q) || null, periods: ds.periods || null };
        if (ad && ad.ok) {
            out.analysis = { dt_hr: _toArr(ad.t), p_psia: _toArr(ad.p) || null, dp_psi: _toArr(ad.dp), dp_deriv_psi: _toArr(ad.deriv) || null,
                             pRef: ad.pRef, pRefSource: ad.pRefSource || null, testType: ad.testType || null };
        }
        return JSON.stringify(out);
    }

    // format: 'tsv' | 'csv' (analysis data when available, else raw) | 'raw-tsv' | 'raw-csv' | 'json'
    G.PRiSM_copyDataToClipboard = function PRiSM_copyDataToClipboard(format) {
        format = (format || 'tsv').toLowerCase();
        return new Promise(function (resolve) {
            try {
                var ds = G.PRiSM_dataset;
                if (!ds || !ds.t || !ds.t.length) { resolve({ success: false, error: 'No dataset loaded' }); return; }
                var ad = (format === 'raw-tsv' || format === 'raw-csv') ? null : _analysisData();
                var sep = (format === 'csv' || format === 'raw-csv') ? ',' : '\t';
                var text;
                if (format === 'json') text = _dataJSON(ds, ad);
                else if (format === 'tsv' || format === 'csv' || format === 'raw-tsv' || format === 'raw-csv') {
                    text = (ad && ad.ok) ? _analysisTable(ad, sep) : _rawTable(ds, sep);
                } else { resolve({ success: false, error: 'Unsupported format: ' + format }); return; }
                if (!_hasClipboardTextAPI()) {
                    resolve({ success: false, error: 'Clipboard text API unavailable in this context', text: text });
                    return;
                }
                G.navigator.clipboard.writeText(text).then(function () {
                    _ga4('prism_copy_data', { format: String(format) });
                    resolve({ success: true, length: text.length, text: text });
                }, function (err) {
                    resolve({ success: false, error: (err && err.message) || String(err) });
                });
            } catch (e) {
                resolve({ success: false, error: e && e.message });
            }
        });
    };

    // ═══════════════════════════════════════════════════════════════
    // SECTION 9 — EXPORT/COPY TOOLBAR + TAB 2 "PLOT TOOLS" PANEL
    // ═══════════════════════════════════════════════════════════════

    var _BTN = 'class="btn btn-secondary" style="font-size:12px; padding:6px 10px; max-width:100%; box-sizing:border-box;"';

    G.PRiSM_renderClipboardToolbar = function PRiSM_renderClipboardToolbar(container) {
        if (!container || !_hasDoc) return;
        container.innerHTML =
            '<div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center; max-width:100%;">' +
                '<button type="button" data-cb-png ' + _BTN + '>Export PNG</button>' +
                '<button type="button" data-cb-pdf ' + _BTN + '>Export PDF report</button>' +
                '<button type="button" data-cb-plot ' + _BTN + '>Copy plot</button>' +
                '<button type="button" data-cb-data ' + _BTN + '>Copy data (TSV)</button>' +
                '<button type="button" data-cb-xml ' + _BTN + '>Export XML</button>' +
            '</div>' +
            '<div data-cb-msg role="status" style="font-size:11px; color:var(--text2, #8b949e); margin-top:6px; min-height:14px;"></div>';
        var msg = container.querySelector('[data-cb-msg]');
        function flash(text, isErr) {
            if (!msg) return;
            msg.style.color = isErr ? 'var(--red, #f85149)' : 'var(--green, #3fb950)';
            msg.textContent = text;
            setTimeout(function () { if (msg && msg.textContent === text) msg.textContent = ''; }, 4000);
        }
        function activePlot() { return (G.PRiSM_state && G.PRiSM_state.activePlot) || 'bourdet'; }
        var png = container.querySelector('[data-cb-png]');
        if (png) png.addEventListener('click', function () {
            if (typeof G.PRiSM_exportPlotPNG !== 'function') { flash('PNG export is not available.', true); return; }
            var ok = G.PRiSM_exportPlotPNG(activePlot());
            flash(ok === false ? 'PNG export failed.' : 'PNG saved.', ok === false);
        });
        var pdf = container.querySelector('[data-cb-pdf]');
        if (pdf) pdf.addEventListener('click', function () {
            if (typeof G.PRiSM_exportReportPDF !== 'function') { flash('PDF export is not available.', true); return; }
            var r = G.PRiSM_exportReportPDF();
            flash(r ? 'Report opened for printing / saving as PDF.' : 'PDF export failed.', !r);
        });
        var pBtn = container.querySelector('[data-cb-plot]');
        if (pBtn) pBtn.addEventListener('click', function () {
            G.PRiSM_copyPlotToClipboard(activePlot()).then(function (r) {
                if (r.success) flash('Plot copied to the clipboard.');
                else flash('Copy plot failed: ' + (r.error || 'unknown'), true);
            });
        });
        var dBtn = container.querySelector('[data-cb-data]');
        if (dBtn) dBtn.addEventListener('click', function () {
            G.PRiSM_copyDataToClipboard('tsv').then(function (r) {
                if (r.success) flash('Data copied (' + r.length + ' characters).');
                else flash('Copy data failed: ' + (r.error || 'unknown'), true);
            });
        });
        var xBtn = container.querySelector('[data-cb-xml]');
        if (xBtn) xBtn.addEventListener('click', function () {
            try { G.PRiSM_exportXMLDownload(); flash('XML export downloaded.'); }
            catch (e) { flash('Export failed: ' + (e && e.message), true); }
        });
    };

    function _section(title, attr) {
        return '<div style="margin-top:10px;">' +
                 '<div style="font-size:11px; font-weight:600; color:var(--text2, #8b949e); text-transform:uppercase; ' +
                   'letter-spacing:.4px; margin-bottom:6px;">' + _esc(title) + '</div>' +
                 '<div ' + attr + '></div>' +
               '</div>';
    }

    G.PRiSM_renderPlotToolsPanel = function PRiSM_renderPlotToolsPanel(container) {
        if (!container || !_hasDoc) return;
        container.innerHTML =
            '<div class="prism-plottools" style="max-width:100%; box-sizing:border-box; color:var(--text, #e6edf3);">' +
                _section('Export & copy', 'data-pt-export') +
                _section('Overlays', 'data-pt-overlays') +
                _section('Compare two datasets', 'data-pt-diff') +
            '</div>';
        G.PRiSM_renderClipboardToolbar(container.querySelector('[data-pt-export]'));
        G.PRiSM_renderOverlayManager(container.querySelector('[data-pt-overlays]'));
        G.PRiSM_renderDiffPicker(container.querySelector('[data-pt-diff]'));
    };

    _registerTabPanel(2, {
        id: 'plottools',
        title: 'Plot tools',
        order: 40,
        collapsed: true,
        render: function (host) { G.PRiSM_renderPlotToolsPanel(host); }
    });

    function _refreshOverlayManagers() {
        if (!_hasDoc || typeof document.querySelectorAll !== 'function') return;
        var hosts;
        try { hosts = document.querySelectorAll('[data-pt-overlays]'); } catch (e) { return; }
        for (var i = 0; i < hosts.length; i++) { try { G.PRiSM_renderOverlayManager(hosts[i]); } catch (e2) { /* ignore */ } }
    }
    _on(G, 'prism:plot-changed', _refreshOverlayManagers);
    _on(G, 'prism:dataset-loaded', _refreshOverlayManagers);

    // ═══════════════════════════════════════════════════════════════
    // SELF-TEST
    // ═══════════════════════════════════════════════════════════════

    (function _selfTest() {
        var log = (G.console && G.console.log) ? G.console.log.bind(G.console) : function () {};
        var err = (G.console && G.console.error) ? G.console.error.bind(G.console) : function () {};
        var checks = [];

        // 1. Overlay add / remove / toggle round-trip.
        try {
            var snapshot = G.PRiSM_overlays.list().slice();
            G.PRiSM_overlays.clear();
            var id1 = G.PRiSM_overlays.add('period:0', 'Test P0');
            var id2 = G.PRiSM_overlays.add('model:homogeneous');
            var afterAdd = G.PRiSM_overlays.items.length === 2;
            G.PRiSM_overlays.toggle(id1);
            var afterToggle = (G.PRiSM_overlays.items[0].visible === false);
            G.PRiSM_overlays.remove(id2);
            var afterRemove = (G.PRiSM_overlays.items.length === 1 && G.PRiSM_overlays.items[0].id === id1);
            G.PRiSM_overlays.clear();
            for (var s = 0; s < snapshot.length; s++) G.PRiSM_overlays.items.push(snapshot[s]);
            checks.push({ name: 'overlays add/remove/toggle round-trip', ok: afterAdd && afterToggle && afterRemove });
        } catch (e) {
            checks.push({ name: 'overlays add/remove/toggle round-trip', ok: false, msg: e && e.message });
        }

        // 2. datasetDiff on near-identical synthetics → small RMS.
        try {
            var t = [], pA = [], pB = [];
            for (var i = 0; i < 100; i++) {
                t.push(i * 0.1);
                pA.push(100 + Math.sin(i * 0.3) * 10);
                pB.push(100 + Math.sin(i * 0.3) * 10 + 0.01);
            }
            var d = G.PRiSM_datasetDiff({ t: t, p: pA }, { t: t, p: pB });
            checks.push({ name: 'datasetDiff near-identical → small RMS',
                          ok: d && d.rms < 0.05 && d.nCommon === 100 && Math.abs(d.dp[50] + 0.01) < 1e-6 });
        } catch (e) {
            checks.push({ name: 'datasetDiff near-identical → small RMS', ok: false, msg: e && e.message });
        }

        // 3-4. XML export: header, root, sections, parseable where a parser exists.
        try {
            var res = G.PRiSM_exportXML({ pretty: true });
            var x = res.xmlString;
            var parseOK = true;
            if (typeof DOMParser !== 'undefined') {
                try { parseOK = new DOMParser().parseFromString(x, 'application/xml').getElementsByTagName('parsererror').length === 0; }
                catch (e) { parseOK = false; }
            }
            checks.push({ name: 'exportXML valid (header, root, filename)',
                          ok: x.indexOf('<?xml') === 0 && x.indexOf('<PRiSMProject') > 0 &&
                              /^prism-export-\d{8}-\d{6}\.xml$/.test(res.filename) && parseOK });
            checks.push({ name: 'exportXML sections (Meta, Well, PVT, Model, LineTools, DerivativeData)',
                          ok: ['<Meta', '<Well', '<PVT', '<Model>', '<LineTools', '<DerivativeData'].every(function (tag) { return x.indexOf(tag) >= 0; }) });
        } catch (e) {
            checks.push({ name: 'exportXML', ok: false, msg: e && e.message });
        }

        // 5. Clipboard helpers return Promises; raw table shape.
        try {
            var ret = G.PRiSM_copyPlotToClipboard();
            var isPromise = ret && typeof ret.then === 'function';
            if (isPromise) ret.then(function () {}, function () {});
            var tsv = _rawTable({ t: [0, 1, 2], p: [100, 110, 120], q: [50, 50, 0] }, '\t');
            checks.push({ name: 'clipboard returns Promise; raw TSV has units in the header',
                          ok: isPromise && tsv.indexOf('t_hr\tp_psia\tq') === 0 && tsv.split('\n').length === 4 });
        } catch (e) {
            checks.push({ name: 'clipboard helpers', ok: false, msg: e && e.message });
        }

        // 6. Analysis table uses dp_psi / dp_deriv_psi.
        try {
            var at = _analysisTable({ ok: true, t: [1, 2, 3], p: [10, 9, 8], dp: [1, 2, 3], deriv: [NaN, 1, NaN] }, ',');
            checks.push({ name: 'analysis table columns dt_hr … dp_psi, dp_deriv_psi',
                          ok: at.split('\n')[0] === 'dt_hr,p_psia,dp_psi,dp_deriv_psi' && at.split('\n')[2] === '2,9,2,1' });
        } catch (e) {
            checks.push({ name: 'analysis table', ok: false, msg: e && e.message });
        }

        // 7. Overlay abscissa per plot (Horner ratio, √t).
        try {
            var hs = _seriesForPlot({ t: [1, 2], p: [5, 6], tp: 10 }, 'horner', {});
            var sq = _seriesForPlot({ t: [4, 9], p: [5, 6] }, 'sqrt', {});
            checks.push({ name: 'overlay x-transform per plot',
                          ok: hs[0].pts[0][0] === 11 && hs[0].pts[1][0] === 6 && sq[0].pts[1][0] === 3 });
        } catch (e) {
            checks.push({ name: 'overlay x-transform per plot', ok: false, msg: e && e.message });
        }

        // 8. Hook + panel registration; drawOverlays is a no-op with no overlays.
        try {
            G.PRiSM_drawOverlays(null, 'bourdet', null);
            var hooks = G.PRiSM_postDrawHooks || [];
            var panels = (G.PRiSM_tabPanels && G.PRiSM_tabPanels[2]) || [];
            checks.push({ name: 'post-draw hook + Tab 2 panel registered',
                          ok: hooks.filter(function (f) { return f && f._prismId === 'plot-overlays'; }).length === 1 &&
                              (typeof G.PRiSM_registerTabPanel === 'function' ||
                               panels.some(function (p) { return p && p.id === 'plottools'; })) });
        } catch (e) {
            checks.push({ name: 'registration', ok: false, msg: e && e.message });
        }

        var fails = checks.filter(function (c) { return !c.ok; });
        if (fails.length) err('PRiSM plot-utilities self-test FAILED:', JSON.stringify(fails));
        else log('✓ plot-utilities self-test passed (' + checks.length + ' checks).');
    })();

})();
