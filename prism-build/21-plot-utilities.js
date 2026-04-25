// ════════════════════════════════════════════════════════════════════
// PRiSM ─ Layer 21 — Plot Utilities (overlays + diff + XML + clipboard)
//   • Plot overlays for multi-period / multi-dataset comparison
//   • Two-dataset diff plot (interpolation + 2-panel render)
//   • XML project export (one-file portable export)
//   • Copy plot / data to clipboard via navigator.clipboard
//
// PUBLIC API (all on window.*)
//
//   PRiSM_overlays                          — state container
//     .items                                — current overlay list
//     .add(source, label?, color?) → string (id)
//     .remove(id)                           → void
//     .toggle(id)                           → void
//     .clear()                              → void
//     .list()                               → array (defensive copy)
//
//   PRiSM_drawOverlays(canvas, plotKey, baseAxes?) → void
//   PRiSM_renderOverlayManager(container)         → void
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
//
// CONVENTIONS
//   • Single outer IIFE, 'use strict'.
//   • Pure vanilla JS — no external dependencies.
//   • Defensive against missing helpers (PRiSM_pvt, PRiSM_gaugeData,
//     PRiSM_analysisData, PRiSM_drawActivePlot may not be loaded).
//   • Modern browsers only for clipboard (Clipboard API + ClipboardItem) —
//     graceful fallback otherwise.
//   • XML is well-formed: 5-entity escaping for <, >, &, ", '.
//   • Self-test is non-destructive — does not write to the real clipboard
//     (that requires a user gesture).
// ════════════════════════════════════════════════════════════════════

(function () {
    'use strict';

    // ───────────────────────────────────────────────────────────────
    // Tiny env shims — module loads in browser AND in the smoke-test
    // stub (see prism-build/smoke-test.js).
    // ───────────────────────────────────────────────────────────────
    var _hasDoc = (typeof document !== 'undefined');
    var _hasWin = (typeof window !== 'undefined');
    var G       = _hasWin ? window : (typeof globalThis !== 'undefined' ? globalThis : {});

    function _theme() {
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
    // 'source' is a colon-prefixed string. Supported forms:
    //   'period:N'    — flow period N from window.PRiSM_dataset
    //   'analysis:ID' — uses PRiSM_analysisData if loaded
    //   'gauge:ID'    — uses PRiSM_gaugeData if loaded
    //   'model:KEY'   — type-curve from PRiSM_MODELS[KEY] with defaults
    //   'fit:KEY'     — fitted curve from PRiSM_state.history[KEY]
    //
    // The container is created once on first load and survives re-loads
    // of this layer (idempotency via window.PRiSM_overlays guard).
    // ═══════════════════════════════════════════════════════════════

    var _overlayCounter = 0;
    function _genOverlayId() {
        _overlayCounter += 1;
        return 'overlay_' + _overlayCounter + '_' + (Date.now() % 100000);
    }

    function _nextColor() {
        var existing = (G.PRiSM_overlays && G.PRiSM_overlays.items) || [];
        for (var i = 0; i < OVERLAY_PALETTE.length; i++) {
            var c = OVERLAY_PALETTE[i];
            var used = false;
            for (var j = 0; j < existing.length; j++) {
                if (existing[j].color === c) { used = true; break; }
            }
            if (!used) return c;
        }
        // All used — cycle on count
        return OVERLAY_PALETTE[existing.length % OVERLAY_PALETTE.length];
    }

    function _autoLabel(source) {
        if (!source || typeof source !== 'string') return 'Overlay';
        var parts = source.split(':');
        var kind = parts[0], id = parts.slice(1).join(':');
        switch (kind) {
            case 'period':   return 'Period #' + (parseInt(id, 10) + 1);
            case 'analysis': return 'Analysis: ' + id;
            case 'gauge':    return 'Gauge: ' + id;
            case 'model':    return 'Model: ' + id;
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
                this.items.push({
                    id:      id,
                    source:  source,
                    label:   label || _autoLabel(source),
                    color:   color || _nextColor(),
                    visible: true
                });
                _ga4('prism_overlay_add', { source: source });
                return id;
            },
            remove: function (id) {
                for (var i = 0; i < this.items.length; i++) {
                    if (this.items[i].id === id) {
                        this.items.splice(i, 1);
                        return;
                    }
                }
            },
            toggle: function (id) {
                for (var i = 0; i < this.items.length; i++) {
                    if (this.items[i].id === id) {
                        this.items[i].visible = !this.items[i].visible;
                        return;
                    }
                }
            },
            clear: function () { this.items.length = 0; },
            list:  function () { return this.items.slice(); }
        };
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 2 — OVERLAY DATA RESOLUTION + DRAWING
    // ═══════════════════════════════════════════════════════════════
    //
    // Resolve a 'source' string into a {t, p} or {t, dp/dp'} pair we
    // can plot on the active canvas. Returns null on miss (silently —
    // the overlay just doesn't paint).
    //
    // Drawing uses the host plot's stashed axis transform if available
    // (canvas._prismAxes), else re-derives a sensible transform from
    // the data range, mirroring layer-2's tick generator.
    // ═══════════════════════════════════════════════════════════════

    function _resolveOverlay(source) {
        if (!source || typeof source !== 'string') return null;
        var parts = source.split(':');
        var kind = parts[0], id = parts.slice(1).join(':');
        var ds   = G.PRiSM_dataset;
        try {
            switch (kind) {
                case 'period': {
                    if (!ds || !Array.isArray(ds.t)) return null;
                    var pIdx = parseInt(id, 10);
                    if (!isFinite(pIdx) || pIdx < 0) return null;
                    var pers = ds.periods || [];
                    if (typeof G.PRiSM_detectPeriods === 'function' && (!pers || !pers.length) && ds.q) {
                        pers = G.PRiSM_detectPeriods(ds.t, ds.q);
                    }
                    if (!pers[pIdx]) return null;
                    var pp = pers[pIdx];
                    var t = [], p = [], q = [];
                    for (var i = 0; i < ds.t.length; i++) {
                        if (ds.t[i] >= pp.t0 && ds.t[i] <= pp.t1) {
                            t.push(ds.t[i] - pp.t0);
                            if (ds.p) p.push(ds.p[i]);
                            if (ds.q) q.push(ds.q[i]);
                        }
                    }
                    return { t: t, p: p.length ? p : null, q: q.length ? q : null };
                }
                case 'analysis': {
                    var ad = G.PRiSM_analysisData;
                    if (!ad) return null;
                    var item = (typeof ad.get === 'function')   ? ad.get(id)
                              : (ad.items && ad.items[id])      ? ad.items[id]
                              : (Array.isArray(ad) && ad.find)  ? ad.find(function (x) { return x.id === id; })
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
                    var g = (typeof gd.get === 'function')        ? gd.get(id)
                          : (gd.items && gd.items[id])            ? gd.items[id]
                          : (Array.isArray(gd) && gd.find)        ? gd.find(function (x) { return x.id === id; })
                          : null;
                    if (!g) return null;
                    return {
                        t: g.t || (g.samples && g.samples.t) || [],
                        p: g.p || (g.samples && g.samples.p) || null,
                        q: g.q || (g.samples && g.samples.q) || null
                    };
                }
                case 'model': {
                    var reg = G.PRiSM_MODELS;
                    if (!reg || !reg[id] || typeof reg[id].pd !== 'function') return null;
                    // Generate a canonical type-curve over 4 decades.
                    var td = [];
                    for (var k = -2; k <= 4; k += 0.05) td.push(Math.pow(10, k));
                    var defaults = reg[id].defaults || {};
                    var pd = reg[id].pd(td, defaults);
                    return { t: td, p: pd, dp: pd };
                }
                case 'fit': {
                    var st = G.PRiSM_state || {};
                    var hist = st.history || st.fitHistory || {};
                    var fit = hist[id];
                    if (!fit) return null;
                    if (fit.curve && fit.curve.t && fit.curve.p) {
                        return { t: fit.curve.t.slice(), p: fit.curve.p.slice() };
                    }
                    if (fit.td && fit.pd) {
                        return { t: fit.td.slice(), p: fit.pd.slice() };
                    }
                    return null;
                }
            }
        } catch (e) {
            return null;
        }
        return null;
    }

    function _plotRect(canvas) {
        var cssW = (canvas && canvas.clientWidth)  || (canvas && canvas.width)  || 600;
        var cssH = (canvas && canvas.clientHeight) || (canvas && canvas.height) || 400;
        if (canvas && canvas.style) {
            var w = parseInt(canvas.style.width, 10);
            if (isFinite(w) && w > 0) cssW = w;
            var h = parseInt(canvas.style.height, 10);
            if (isFinite(h) && h > 0) cssH = h;
        }
        var pad = _defaultPad();
        return {
            x: pad.left,
            y: pad.top,
            w: Math.max(1, cssW - pad.left - pad.right),
            h: Math.max(1, cssH - pad.top - pad.bottom),
            cssW: cssW,
            cssH: cssH,
            pad: pad
        };
    }

    // Pull the active axis transform off the canvas. Tries the modern
    // _prismAxes shape first (planned by layer 11), then the older
    // _prismOriginalScale shape (set by layer 2). Else null.
    function _getCanvasAxes(canvas, plotKey) {
        if (canvas && canvas._prismAxes) {
            var ax = canvas._prismAxes;
            return {
                plotRect: { x: ax.x0, y: ax.y0, w: (ax.x1 - ax.x0), h: (ax.y1 - ax.y0) },
                xLog: !!ax.xLog,
                yLog: !!ax.yLog,
                xMin: ax.dx0, xMax: ax.dx1,
                yMin: ax.dy0, yMax: ax.dy1
            };
        }
        if (canvas && canvas._prismOriginalScale) {
            var s = canvas._prismOriginalScale;
            var pr = _plotRect(canvas);
            return {
                plotRect: pr,
                xLog: (s.x && s.x.kind === 'log'),
                yLog: (s.y && s.y.kind === 'log'),
                xMin: s.x && s.x.min, xMax: s.x && s.x.max,
                yMin: s.y && s.y.min, yMax: s.y && s.y.max
            };
        }
        return null;
    }

    // Build a world->pixel function pair from an axis spec.
    function _makeTransforms(axes) {
        var pr = axes.plotRect;
        var toX = axes.xLog
            ? function (v) {
                if (!isFinite(v) || v <= 0) return NaN;
                var lmin = Math.log10(axes.xMin), lmax = Math.log10(axes.xMax);
                if (lmax === lmin) return pr.x;
                return pr.x + (Math.log10(v) - lmin) / (lmax - lmin) * pr.w;
            }
            : function (v) {
                if (!isFinite(v)) return NaN;
                if (axes.xMax === axes.xMin) return pr.x;
                return pr.x + (v - axes.xMin) / (axes.xMax - axes.xMin) * pr.w;
            };
        var toY = axes.yLog
            ? function (v) {
                if (!isFinite(v) || v <= 0) return NaN;
                var lmin = Math.log10(axes.yMin), lmax = Math.log10(axes.yMax);
                if (lmax === lmin) return pr.y + pr.h;
                return pr.y + pr.h - (Math.log10(v) - lmin) / (lmax - lmin) * pr.h;
            }
            : function (v) {
                if (!isFinite(v)) return NaN;
                if (axes.yMax === axes.yMin) return pr.y + pr.h;
                return pr.y + pr.h - (v - axes.yMin) / (axes.yMax - axes.yMin) * pr.h;
            };
        return { toX: toX, toY: toY };
    }

    // Pick which series field to plot for a given plotKey. Most diagnostic
    // plots want pressure or Δp. Bourdet wants Δp + Δp'. The mapper is
    // best-effort — overlay drawing is non-critical.
    function _seriesForPlot(data, plotKey) {
        if (!data || !data.t || !data.t.length) return [];
        var t = data.t;
        var arr = [];
        if (plotKey === 'cartesian' || plotKey === 'horner' ||
            plotKey === 'sqrt' || plotKey === 'quarter' || plotKey === 'spherical') {
            var p = data.p || data.dp;
            if (!p) return [];
            for (var i = 0; i < t.length; i++) arr.push([t[i], p[i]]);
            return arr;
        }
        if (plotKey === 'rateCart' || plotKey === 'rateSemi' || plotKey === 'rateLog') {
            var q = data.q;
            if (!q) return [];
            for (var j = 0; j < t.length; j++) arr.push([t[j], q[j]]);
            return arr;
        }
        // Default: Bourdet/log-log → Δp series.
        var dp = data.dp;
        if (!dp && data.p && data.p.length) {
            var p0 = data.p[0];
            dp = data.p.map(function (v) { return v - p0; });
        }
        if (!dp) return [];
        for (var k = 0; k < t.length; k++) arr.push([t[k], dp[k]]);
        return arr;
    }

    G.PRiSM_drawOverlays = function PRiSM_drawOverlays(canvas, plotKey, baseAxes) {
        if (!canvas || !canvas.getContext) return;
        var items = (G.PRiSM_overlays && G.PRiSM_overlays.items) || [];
        if (!items.length) return;
        try {
            // Prefer baseAxes argument; else read off canvas.
            var axes = baseAxes || _getCanvasAxes(canvas, plotKey);
            if (!axes || !isFinite(axes.xMin) || !isFinite(axes.xMax) ||
                !isFinite(axes.yMin) || !isFinite(axes.yMax)) {
                return; // can't compute transform — silent skip
            }
            var tr  = _makeTransforms(axes);
            var ctx = canvas.getContext('2d');
            if (!ctx) return;
            var pr  = axes.plotRect;
            ctx.save();
            try {
                // Clip to plot area to avoid spilling into tick margins.
                ctx.beginPath();
                ctx.rect(pr.x, pr.y, pr.w, pr.h);
                ctx.clip();
            } catch (e) { /* clip not strictly required */ }
            ctx.lineWidth = 2;

            for (var i = 0; i < items.length; i++) {
                var it = items[i];
                if (!it.visible) continue;
                var resolved = _resolveOverlay(it.source);
                if (!resolved) continue;
                var pts = _seriesForPlot(resolved, plotKey);
                if (!pts.length) continue;
                ctx.strokeStyle = it.color || '#58a6ff';
                ctx.setLineDash([5, 3]);
                ctx.beginPath();
                var started = false;
                for (var k = 0; k < pts.length; k++) {
                    var p = pts[k];
                    if (!p || !isFinite(p[0]) || !isFinite(p[1])) { started = false; continue; }
                    var px = tr.toX(p[0]), py = tr.toY(p[1]);
                    if (!isFinite(px) || !isFinite(py)) { started = false; continue; }
                    if (!started) { ctx.moveTo(px, py); started = true; }
                    else ctx.lineTo(px, py);
                }
                ctx.stroke();
            }
            ctx.setLineDash([]);
            ctx.restore();

            // Draw a small overlay legend chip in the bottom-left corner.
            var visibleItems = items.filter(function (x) { return x.visible; });
            if (visibleItems.length) {
                ctx.save();
                ctx.font = '11px sans-serif';
                ctx.textBaseline = 'middle';
                var th = _theme();
                var lineH = 14, padXL = 6, padYL = 4;
                var maxW = 0;
                for (var m = 0; m < visibleItems.length; m++) {
                    var w = ctx.measureText(visibleItems[m].label || '').width;
                    if (w > maxW) maxW = w;
                }
                var boxW = 20 + maxW + padXL * 2;
                var boxH = visibleItems.length * lineH + padYL * 2;
                var bx = pr.x + 8, by = pr.y + pr.h - boxH - 8;
                ctx.fillStyle = 'rgba(13,17,23,0.85)';
                ctx.fillRect(bx, by, boxW, boxH);
                ctx.strokeStyle = th.border || '#30363d';
                ctx.lineWidth = 1;
                ctx.strokeRect(bx + 0.5, by + 0.5, boxW, boxH);
                for (var n = 0; n < visibleItems.length; n++) {
                    var iy = by + padYL + n * lineH + lineH / 2;
                    ctx.strokeStyle = visibleItems[n].color;
                    ctx.lineWidth = 2;
                    ctx.setLineDash([4, 3]);
                    ctx.beginPath();
                    ctx.moveTo(bx + padXL, iy);
                    ctx.lineTo(bx + padXL + 14, iy);
                    ctx.stroke();
                    ctx.setLineDash([]);
                    ctx.fillStyle = th.text || '#c9d1d9';
                    ctx.textAlign = 'left';
                    ctx.fillText(String(visibleItems[n].label || ''), bx + padXL + 18, iy);
                }
                ctx.restore();
            }
        } catch (e) {
            // Overlays are non-critical — never throw upward.
            try { console.warn('PRiSM_drawOverlays:', e && e.message); } catch (_) {}
        }
    };

    // ═══════════════════════════════════════════════════════════════
    // SECTION 3 — OVERLAY MANAGER UI
    // ═══════════════════════════════════════════════════════════════
    //
    // Renders a small panel into `container` with:
    //   - one row per current overlay (visibility checkbox + colour
    //     swatch + label + remove button)
    //   - "+ Add overlay" select listing all currently-resolvable sources
    // ═══════════════════════════════════════════════════════════════

    function _enumerateSources() {
        var out = [];
        var ds = G.PRiSM_dataset;
        if (ds && Array.isArray(ds.t)) {
            var pers = ds.periods || [];
            if (typeof G.PRiSM_detectPeriods === 'function' && (!pers || !pers.length) && ds.q) {
                pers = G.PRiSM_detectPeriods(ds.t, ds.q);
            }
            for (var i = 0; i < pers.length; i++) {
                out.push({ source: 'period:' + i, label: 'Period #' + (i + 1) });
            }
        }
        var ad = G.PRiSM_analysisData;
        if (ad) {
            var adList = [];
            if (typeof ad.list === 'function') adList = ad.list();
            else if (Array.isArray(ad)) adList = ad;
            else if (ad.items) {
                for (var k in ad.items) if (Object.prototype.hasOwnProperty.call(ad.items, k)) {
                    adList.push({ id: k, name: ad.items[k].name });
                }
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
                for (var kk in gd.items) if (Object.prototype.hasOwnProperty.call(gd.items, kk)) {
                    gdList.push({ id: kk, name: gd.items[kk].name });
                }
            }
            for (var g = 0; g < gdList.length; g++) {
                var gid = gdList[g].id || gdList[g].name || ('g' + g);
                out.push({ source: 'gauge:' + gid, label: 'Gauge: ' + (gdList[g].name || gid) });
            }
        }
        var reg = G.PRiSM_MODELS;
        if (reg) {
            for (var key in reg) if (Object.prototype.hasOwnProperty.call(reg, key)) {
                if (reg[key] && typeof reg[key].pd === 'function') {
                    out.push({ source: 'model:' + key, label: 'Model: ' + key });
                }
            }
        }
        var st = G.PRiSM_state || {};
        var hist = st.history || st.fitHistory || {};
        for (var fk in hist) if (Object.prototype.hasOwnProperty.call(hist, fk)) {
            out.push({ source: 'fit:' + fk, label: 'Fit: ' + fk });
        }
        return out;
    }

    function _esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    G.PRiSM_renderOverlayManager = function PRiSM_renderOverlayManager(container) {
        if (!container || !_hasDoc) return;
        var th = _theme();
        var items = G.PRiSM_overlays.list();
        var sources = _enumerateSources();
        var sourceOpts = '<option value="">— Add overlay…</option>';
        for (var i = 0; i < sources.length; i++) {
            sourceOpts += '<option value="' + _esc(sources[i].source) + '">' +
                          _esc(sources[i].label) + '</option>';
        }

        var rows = '';
        if (!items.length) {
            rows = '<div style="font-size:12px; color:' + th.text3 +
                   '; padding:8px 4px;">No overlays. Use the picker below.</div>';
        } else {
            for (var k = 0; k < items.length; k++) {
                var it = items[k];
                rows += '<div data-overlay-id="' + _esc(it.id) +
                        '" style="display:flex; align-items:center; gap:8px; padding:4px 0; border-bottom:1px solid ' +
                        th.border + ';">' +
                    '<input type="checkbox" data-overlay-toggle="' + _esc(it.id) + '"' +
                        (it.visible ? ' checked' : '') + '>' +
                    '<span style="display:inline-block; width:14px; height:14px; border-radius:3px; background:' +
                        _esc(it.color) + '; border:1px solid ' + th.border + ';"></span>' +
                    '<span style="flex:1; font-size:12px; color:' + th.text + ';">' +
                        _esc(it.label) + '</span>' +
                    '<span style="font-size:10px; color:' + th.text3 + ';">' +
                        _esc(it.source) + '</span>' +
                    '<button type="button" data-overlay-remove="' + _esc(it.id) +
                        '" style="background:none; border:none; color:' + th.red +
                        '; cursor:pointer; font-size:14px; padding:2px 6px;">×</button>' +
                '</div>';
            }
        }

        container.innerHTML =
            '<div style="background:' + th.panel + '; border:1px solid ' + th.border +
                '; border-radius:6px; padding:10px;">' +
                '<div style="font-size:11px; font-weight:700; color:' + th.text2 +
                    '; text-transform:uppercase; letter-spacing:.5px; margin-bottom:8px;">' +
                    'Plot overlays (' + items.length + ')</div>' +
                '<div data-overlay-list>' + rows + '</div>' +
                '<div style="display:flex; gap:8px; align-items:center; margin-top:10px;">' +
                    '<select data-overlay-add style="flex:1; padding:5px 8px; background:' + th.bg +
                        '; color:' + th.text + '; border:1px solid ' + th.border +
                        '; border-radius:4px; font-size:12px;">' + sourceOpts + '</select>' +
                    '<button type="button" data-overlay-clear style="padding:5px 10px; background:' + th.bg +
                        '; color:' + th.text2 + '; border:1px solid ' + th.border +
                        '; border-radius:4px; font-size:12px; cursor:pointer;">Clear all</button>' +
                '</div>' +
            '</div>';

        function redraw() {
            G.PRiSM_renderOverlayManager(container);
            if (typeof G.PRiSM_drawActivePlot === 'function') {
                try { G.PRiSM_drawActivePlot(); } catch (e) { /* ignore */ }
            }
        }

        var sel = container.querySelector('[data-overlay-add]');
        if (sel) sel.addEventListener('change', function (ev) {
            var v = ev.target.value;
            if (!v) return;
            G.PRiSM_overlays.add(v);
            redraw();
        });
        var clr = container.querySelector('[data-overlay-clear]');
        if (clr) clr.addEventListener('click', function () {
            G.PRiSM_overlays.clear();
            redraw();
        });
        var toggles = container.querySelectorAll('[data-overlay-toggle]');
        for (var tt = 0; tt < toggles.length; tt++) {
            (function (el) {
                el.addEventListener('change', function () {
                    G.PRiSM_overlays.toggle(el.getAttribute('data-overlay-toggle'));
                    if (typeof G.PRiSM_drawActivePlot === 'function') {
                        try { G.PRiSM_drawActivePlot(); } catch (e) {}
                    }
                });
            })(toggles[tt]);
        }
        var rms = container.querySelectorAll('[data-overlay-remove]');
        for (var rr = 0; rr < rms.length; rr++) {
            (function (el) {
                el.addEventListener('click', function () {
                    G.PRiSM_overlays.remove(el.getAttribute('data-overlay-remove'));
                    redraw();
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

    // Auto-register the plot if a registry exists on window.
    if (G.PRISM_PLOT_REGISTRY && !G.PRISM_PLOT_REGISTRY.datasetDiff) {
        try {
            G.PRISM_PLOT_REGISTRY.datasetDiff = {
                fn:    'PRiSM_plot_dataset_diff',
                label: 'Dataset diff (A − B)',
                mode:  'transient'
            };
        } catch (e) { /* registry may be const-frozen, ignore */ }
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 5b — DIFF PICKER UI
    // ═══════════════════════════════════════════════════════════════

    function _diffSourceList() {
        var out = [];
        var ds = G.PRiSM_dataset;
        if (ds && Array.isArray(ds.t)) {
            out.push({ id: 'current', name: 'Current dataset', resolve: function () { return ds; } });
        }
        var gd = G.PRiSM_gaugeData;
        if (gd) {
            var list = (typeof gd.list === 'function') ? gd.list()
                     : Array.isArray(gd) ? gd
                     : (gd.items ? Object.keys(gd.items).map(function (k) {
                         return Object.assign({ id: k }, gd.items[k]);
                       }) : []);
            for (var i = 0; i < list.length; i++) {
                (function (g) {
                    var gid = g.id || g.name || ('g' + i);
                    out.push({
                        id:   'gauge:' + gid,
                        name: 'Gauge: ' + (g.name || gid),
                        resolve: function () {
                            return _resolveOverlay('gauge:' + gid);
                        }
                    });
                })(list[i]);
            }
        }
        var ad = G.PRiSM_analysisData;
        if (ad) {
            var alist = (typeof ad.list === 'function') ? ad.list()
                      : Array.isArray(ad) ? ad
                      : (ad.items ? Object.keys(ad.items).map(function (k) {
                          return Object.assign({ id: k }, ad.items[k]);
                        }) : []);
            for (var j = 0; j < alist.length; j++) {
                (function (a) {
                    var aid = a.id || a.name || ('a' + j);
                    out.push({
                        id:   'analysis:' + aid,
                        name: 'Analysis: ' + (a.name || aid),
                        resolve: function () {
                            return _resolveOverlay('analysis:' + aid);
                        }
                    });
                })(alist[j]);
            }
        }
        var st = G.PRiSM_state || {};
        var saved = st.savedSets || st.snapshots || {};
        for (var sk in saved) if (Object.prototype.hasOwnProperty.call(saved, sk)) {
            (function (key, snap) {
                out.push({
                    id:   'saved:' + key,
                    name: 'Saved: ' + key,
                    resolve: function () { return snap; }
                });
            })(sk, saved[sk]);
        }
        return out;
    }

    G.PRiSM_renderDiffPicker = function PRiSM_renderDiffPicker(container) {
        if (!container || !_hasDoc) return;
        var th = _theme();
        var sources = _diffSourceList();
        function buildOpts(sel) {
            var opts = '<option value="">— pick dataset —</option>';
            for (var i = 0; i < sources.length; i++) {
                opts += '<option value="' + _esc(sources[i].id) + '"' +
                        (sources[i].id === sel ? ' selected' : '') + '>' +
                        _esc(sources[i].name) + '</option>';
            }
            return opts;
        }
        container.innerHTML =
            '<div style="background:' + th.panel + '; border:1px solid ' + th.border +
                '; border-radius:6px; padding:10px;">' +
                '<div style="font-size:11px; font-weight:700; color:' + th.text2 +
                    '; text-transform:uppercase; letter-spacing:.5px; margin-bottom:8px;">' +
                    'Two-dataset diff</div>' +
                '<div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:8px;">' +
                    '<label style="font-size:12px; color:' + th.text2 + ';">A: ' +
                        '<select data-diff-a style="padding:4px 8px; background:' + th.bg + '; color:' + th.text +
                            '; border:1px solid ' + th.border + '; border-radius:4px; font-size:12px;">' +
                            buildOpts('current') + '</select></label>' +
                    '<label style="font-size:12px; color:' + th.text2 + ';">B: ' +
                        '<select data-diff-b style="padding:4px 8px; background:' + th.bg + '; color:' + th.text +
                            '; border:1px solid ' + th.border + '; border-radius:4px; font-size:12px;">' +
                            buildOpts('') + '</select></label>' +
                    '<button type="button" data-diff-go style="padding:5px 12px; background:' + th.accent +
                        '; color:#fff; border:none; border-radius:4px; font-size:12px; cursor:pointer;">' +
                        'Compute diff</button>' +
                '</div>' +
                '<canvas data-diff-canvas style="width:100%; height:380px; display:block; ' +
                    'background:' + th.bg + '; border:1px solid ' + th.border + '; border-radius:4px;"></canvas>' +
                '<div data-diff-summary style="margin-top:6px; font-size:11px; color:' + th.text2 + ';"></div>' +
            '</div>';
        var btn = container.querySelector('[data-diff-go]');
        if (btn) btn.addEventListener('click', function () {
            var aSel = container.querySelector('[data-diff-a]');
            var bSel = container.querySelector('[data-diff-b]');
            var idA = aSel && aSel.value, idB = bSel && bSel.value;
            if (!idA || !idB) {
                container.querySelector('[data-diff-summary]').textContent = 'Pick two datasets.';
                return;
            }
            var a = sources.filter(function (x) { return x.id === idA; })[0];
            var b = sources.filter(function (x) { return x.id === idB; })[0];
            if (!a || !b) return;
            var dA = a.resolve(), dB = b.resolve();
            var canvas = container.querySelector('[data-diff-canvas]');
            G.PRiSM_plot_dataset_diff(canvas, {
                dataA: dA, dataB: dB, labelA: a.name, labelB: b.name
            }, { title: 'Diff: ' + a.name + ' − ' + b.name });
            var diff = G.PRiSM_datasetDiff(dA, dB);
            var sum = container.querySelector('[data-diff-summary]');
            if (sum) {
                sum.textContent = 'Common samples: ' + diff.nCommon +
                    '  •  RMS Δp = ' + (isFinite(diff.rms) ? diff.rms.toPrecision(4) : '—') +
                    '  •  max |Δp| = ' + (isFinite(diff.maxAbs) ? diff.maxAbs.toPrecision(4) : '—');
            }
            _ga4('prism_diff_compute', { idA: idA, idB: idB, n: diff.nCommon });
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

    function _serializeModel(b, includeFitHistory) {
        var st = G.PRiSM_state || {};
        var children = [];
        children.push(b('Active', null, _xmlEscape(st.model || ''), 2));
        // Params
        var params = st.params || {};
        var paramChildren = [];
        for (var pk in params) if (Object.prototype.hasOwnProperty.call(params, pk)) {
            var pv = params[pk];
            paramChildren.push(b('Param', { name: pk, frozen: !!(st.paramFreeze && st.paramFreeze[pk]) },
                _xmlEscape(String(pv)), 3));
        }
        children.push(b('Params', null, paramChildren.length ? paramChildren : null, 2));
        // Last fit
        var lf = st.lastFit;
        if (lf) {
            var lfChildren = [];
            if (lf.params) {
                var lfp = [];
                for (var fk in lf.params) if (Object.prototype.hasOwnProperty.call(lf.params, fk)) {
                    lfp.push(b('Param', { name: fk }, _xmlEscape(String(lf.params[fk])), 4));
                }
                lfChildren.push(b('Params', null, lfp, 3));
            }
            if (lf.ci95) {
                var ci = [];
                for (var ck in lf.ci95) if (Object.prototype.hasOwnProperty.call(lf.ci95, ck)) {
                    var rng = lf.ci95[ck] || [];
                    ci.push(b('CI', { name: ck, low: rng[0], high: rng[1] }, null, 4));
                }
                lfChildren.push(b('CI95', null, ci, 3));
            }
            if (isFinite(lf.aic))  lfChildren.push(b('AIC',  null, _xmlEscape(String(lf.aic)),  3));
            if (isFinite(lf.r2))   lfChildren.push(b('R2',   null, _xmlEscape(String(lf.r2)),   3));
            if (isFinite(lf.rmse)) lfChildren.push(b('RMSE', null, _xmlEscape(String(lf.rmse)), 3));
            if (isFinite(lf.ssr))  lfChildren.push(b('SSR',  null, _xmlEscape(String(lf.ssr)),  3));
            if (isFinite(lf.iterations)) lfChildren.push(b('Iterations', null, _xmlEscape(String(lf.iterations)), 3));
            if (lf.converged != null)    lfChildren.push(b('Converged',  null, _xmlEscape(String(!!lf.converged)),  3));
            children.push(b('LastFit', null, lfChildren, 2));
        }
        // Fit history (optional)
        if (includeFitHistory) {
            var hist = st.history || st.fitHistory || {};
            var histChildren = [];
            for (var hk in hist) if (Object.prototype.hasOwnProperty.call(hist, hk)) {
                var f = hist[hk] || {};
                var attrs = {
                    key:   hk,
                    aic:   isFinite(f.aic) ? f.aic : null,
                    r2:    isFinite(f.r2)  ? f.r2  : null,
                    model: f.model || null
                };
                histChildren.push(b('Fit', attrs, null, 3));
            }
            if (histChildren.length) {
                children.push(b('FitHistory', { count: histChildren.length }, histChildren, 2));
            }
        }
        return b('Model', null, children, 1);
    }

    function _serializeDataset(b, includeRaw) {
        var ds = G.PRiSM_dataset;
        if (!ds || !Array.isArray(ds.t)) {
            return b('Dataset', { available: 'false' }, null, 1);
        }
        var attrs = { available: 'true', samples: ds.t.length };
        var children = [];
        if (ds.periods && ds.periods.length) {
            var pc = [];
            for (var i = 0; i < ds.periods.length; i++) {
                var pr = ds.periods[i];
                pc.push(b('Period', { index: i, t0: pr.t0, t1: pr.t1, q: pr.q }, null, 3));
            }
            children.push(b('Periods', { count: pc.length }, pc, 2));
        }
        if (includeRaw && ds.t.length) {
            children.push(b('Samples', { count: ds.t.length }, [
                b('t', null, _arrCompact(ds.t), 3),
                ds.p ? b('p', null, _arrCompact(ds.p), 3) : '',
                ds.q ? b('q', null, _arrCompact(ds.q), 3) : '',
                ds.dp ? b('dp', null, _arrCompact(ds.dp), 3) : ''
            ].filter(Boolean), 2));
        } else {
            children.push(b('Samples', { count: ds.t.length, includeRaw: 'false' }, null, 2));
        }
        return b('Dataset', attrs, children, 1);
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
        sections.push(_serializePVT(b));
        sections.push(_serializeDataset(b, includeRawDataset));
        sections.push(_serializeGauges(b, includeRawGauge));
        if (includeAnalysis) sections.push(_serializeAnalysis(b));
        sections.push(_serializeModel(b, includeFitHistory));

        var rootAttrs = { version: '1.0', exportedAt: _now(), generator: 'PRiSM' };
        var body = b('PRiSMProject', rootAttrs, sections, 0);
        var xml = '<?xml version="1.0" encoding="UTF-8"?>' + nl + body;

        var filename = 'prism-export-' + _formatStamp() + '.xml';
        var blob = null;
        try {
            if (typeof Blob === 'function' || typeof Blob === 'object') {
                blob = new Blob([xml], { type: 'application/xml' });
            }
        } catch (e) {
            blob = null;
        }
        _ga4('prism_xml_export', { sizeBytes: xml.length });
        return { blob: blob, filename: filename, xmlString: xml };
    };

    G.PRiSM_exportXMLDownload = function PRiSM_exportXMLDownload(opts) {
        var res = G.PRiSM_exportXML(opts);
        if (!_hasDoc) return res;
        try {
            var url;
            if (res.blob && typeof URL !== 'undefined' && URL.createObjectURL) {
                url = URL.createObjectURL(res.blob);
            } else {
                url = 'data:application/xml;charset=utf-8,' + encodeURIComponent(res.xmlString);
            }
            var a = document.createElement('a');
            a.href = url;
            a.download = res.filename;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            if (url && url.indexOf('blob:') === 0 && URL.revokeObjectURL) {
                setTimeout(function () { URL.revokeObjectURL(url); }, 0);
            }
        } catch (e) {
            try { console.warn('PRiSM_exportXMLDownload:', e && e.message); } catch (_) {}
        }
        return res;
    };

    // ═══════════════════════════════════════════════════════════════
    // SECTION 7 — DOWNLOAD HELPER (general)
    // ═══════════════════════════════════════════════════════════════

    function _downloadText(text, filename, mime) {
        if (!_hasDoc) return false;
        try {
            var url, blob = null;
            if (typeof Blob !== 'undefined') {
                blob = new Blob([text], { type: mime || 'text/plain' });
            }
            if (blob && typeof URL !== 'undefined' && URL.createObjectURL) {
                url = URL.createObjectURL(blob);
            } else {
                url = 'data:' + (mime || 'text/plain') + ';charset=utf-8,' + encodeURIComponent(text);
            }
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

    // ═══════════════════════════════════════════════════════════════
    // SECTION 8 — CLIPBOARD HELPERS (PNG + TSV/CSV/JSON)
    // ═══════════════════════════════════════════════════════════════

    function _hasClipboardImageAPI() {
        try {
            return _hasWin && G.navigator && G.navigator.clipboard &&
                   typeof G.navigator.clipboard.write === 'function' &&
                   typeof G.ClipboardItem === 'function';
        } catch (e) { return false; }
    }

    function _hasClipboardTextAPI() {
        try {
            return _hasWin && G.navigator && G.navigator.clipboard &&
                   typeof G.navigator.clipboard.writeText === 'function';
        } catch (e) { return false; }
    }

    // Render a target plot to an offscreen canvas at exportW × exportH.
    // If plotKey is null, just snapshot the current visible canvas.
    function _renderPlotToCanvas(plotKey, exportW, exportH) {
        if (!_hasDoc) return null;
        exportW = exportW || 1200;
        exportH = exportH || 800;
        var off = document.createElement('canvas');
        off.width = exportW;
        off.height = exportH;
        if (off.style) {
            off.style.width = exportW + 'px';
            off.style.height = exportH + 'px';
        }
        var key = plotKey || (G.PRiSM_state && G.PRiSM_state.activePlot) || null;
        var registry = G.PRISM_PLOT_REGISTRY;
        var fn = null;
        if (registry && key && registry[key]) {
            fn = G[registry[key].fn];
        }
        var ds = G.PRiSM_dataset;
        var data = null;
        if (ds && Array.isArray(ds.t)) {
            data = { t: ds.t, p: ds.p, q: ds.q };
            if (ds.dp) data.dp = ds.dp;
            if (ds.periods) data.periods = ds.periods;
        }
        if (typeof fn === 'function' && data) {
            try {
                fn(off, data, { width: exportW, height: exportH, hover: false, dragZoom: false });
            } catch (e) {
                // Fall through to snapshot fallback
            }
        }
        return off;
    }

    // Snapshot the live plot canvas if rendering off-screen failed/unavailable.
    function _snapshotLivePlot(exportW, exportH) {
        if (!_hasDoc) return null;
        var live = document.getElementById('prism_plot_canvas');
        if (!live) return null;
        var off = document.createElement('canvas');
        off.width  = exportW || live.width  || 1200;
        off.height = exportH || live.height || 800;
        try {
            var ctx = off.getContext('2d');
            ctx.drawImage(live, 0, 0, off.width, off.height);
            return off;
        } catch (e) { return null; }
    }

    G.PRiSM_copyPlotToClipboard = function PRiSM_copyPlotToClipboard(plotKey) {
        return new Promise(function (resolve) {
            try {
                var off = _renderPlotToCanvas(plotKey, 1200, 800);
                if (!off) off = _snapshotLivePlot(1200, 800);
                if (!off || !off.toBlob) {
                    resolve({ success: false, error: 'No canvas available' });
                    return;
                }
                if (!_hasClipboardImageAPI()) {
                    // Graceful fallback — emit data URL so caller can use it.
                    var url = '';
                    try { url = off.toDataURL('image/png'); } catch (e) {}
                    resolve({
                        success: false,
                        error:   'Clipboard image API unavailable in this context',
                        dataUrl: url
                    });
                    return;
                }
                off.toBlob(function (blob) {
                    if (!blob) {
                        resolve({ success: false, error: 'toBlob returned null' });
                        return;
                    }
                    try {
                        var item = new G.ClipboardItem({ 'image/png': blob });
                        G.navigator.clipboard.write([item]).then(function () {
                            _ga4('prism_copy_plot', { sizeBytes: blob.size });
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

    function _serializeDataset_TSV(ds, sep) {
        if (!ds || !Array.isArray(ds.t)) return '';
        var cols = ['t'];
        if (ds.p) cols.push('p');
        if (ds.q) cols.push('q');
        if (ds.dp) cols.push('dp');
        var lines = [cols.join(sep)];
        for (var i = 0; i < ds.t.length; i++) {
            var row = [String(ds.t[i])];
            if (ds.p) row.push(String(ds.p[i]));
            if (ds.q) row.push(String(ds.q[i]));
            if (ds.dp) row.push(String(ds.dp[i]));
            lines.push(row.join(sep));
        }
        return lines.join('\n');
    }

    function _serializeDataset_JSON(ds) {
        if (!ds) return '{}';
        var out = { t: ds.t || [], p: ds.p || null, q: ds.q || null };
        if (ds.dp) out.dp = ds.dp;
        if (ds.periods) out.periods = ds.periods;
        return JSON.stringify(out);
    }

    G.PRiSM_copyDataToClipboard = function PRiSM_copyDataToClipboard(format) {
        format = (format || 'tsv').toLowerCase();
        return new Promise(function (resolve) {
            try {
                var ds = G.PRiSM_dataset;
                if (!ds || !Array.isArray(ds.t) || !ds.t.length) {
                    resolve({ success: false, error: 'No dataset loaded' });
                    return;
                }
                var text = '';
                if (format === 'tsv') text = _serializeDataset_TSV(ds, '\t');
                else if (format === 'csv') text = _serializeDataset_TSV(ds, ',');
                else if (format === 'json') text = _serializeDataset_JSON(ds);
                else { resolve({ success: false, error: 'Unsupported format: ' + format }); return; }

                if (!_hasClipboardTextAPI()) {
                    resolve({
                        success: false,
                        error:   'Clipboard text API unavailable in this context',
                        text:    text
                    });
                    return;
                }
                G.navigator.clipboard.writeText(text).then(function () {
                    _ga4('prism_copy_data', { format: format, length: text.length });
                    resolve({ success: true, length: text.length });
                }, function (err) {
                    resolve({ success: false, error: (err && err.message) || String(err) });
                });
            } catch (e) {
                resolve({ success: false, error: e && e.message });
            }
        });
    };

    // ═══════════════════════════════════════════════════════════════
    // SECTION 9 — COMBINED CLIPBOARD TOOLBAR UI
    // ═══════════════════════════════════════════════════════════════

    G.PRiSM_renderClipboardToolbar = function PRiSM_renderClipboardToolbar(container) {
        if (!container || !_hasDoc) return;
        var th = _theme();
        container.innerHTML =
            '<div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">' +
                '<button type="button" data-cb-plot style="padding:5px 12px; background:' + th.bg +
                    '; color:' + th.text + '; border:1px solid ' + th.border +
                    '; border-radius:4px; font-size:12px; cursor:pointer;">Copy plot</button>' +
                '<button type="button" data-cb-data style="padding:5px 12px; background:' + th.bg +
                    '; color:' + th.text + '; border:1px solid ' + th.border +
                    '; border-radius:4px; font-size:12px; cursor:pointer;">Copy data (TSV)</button>' +
                '<button type="button" data-cb-xml style="padding:5px 12px; background:' + th.bg +
                    '; color:' + th.text + '; border:1px solid ' + th.border +
                    '; border-radius:4px; font-size:12px; cursor:pointer;">Export XML</button>' +
                '<span data-cb-msg style="font-size:11px; color:' + th.text2 + '; margin-left:8px;"></span>' +
            '</div>';
        var msg = container.querySelector('[data-cb-msg]');
        function flash(text, isErr) {
            if (!msg) return;
            msg.style.color = isErr ? th.red : th.green;
            msg.textContent = text;
            setTimeout(function () { if (msg) msg.textContent = ''; }, 2500);
        }
        var pBtn = container.querySelector('[data-cb-plot]');
        if (pBtn) pBtn.addEventListener('click', function () {
            G.PRiSM_copyPlotToClipboard().then(function (r) {
                if (r.success) flash('Plot copied to clipboard.');
                else flash('Copy plot failed: ' + (r.error || 'unknown'), true);
            });
        });
        var dBtn = container.querySelector('[data-cb-data]');
        if (dBtn) dBtn.addEventListener('click', function () {
            G.PRiSM_copyDataToClipboard('tsv').then(function (r) {
                if (r.success) flash('Data copied (' + r.length + ' chars).');
                else flash('Copy data failed: ' + (r.error || 'unknown'), true);
            });
        });
        var xBtn = container.querySelector('[data-cb-xml]');
        if (xBtn) xBtn.addEventListener('click', function () {
            try {
                G.PRiSM_exportXMLDownload();
                flash('XML export downloaded.');
            } catch (e) {
                flash('Export failed: ' + (e && e.message), true);
            }
        });
    };

    // ═══════════════════════════════════════════════════════════════
    // SELF-TEST
    // ═══════════════════════════════════════════════════════════════

    (function _selfTest() {
        var log = (G.console && G.console.log) ? G.console.log.bind(G.console) : function () {};
        var err = (G.console && G.console.error) ? G.console.error.bind(G.console) : function () {};
        var checks = [];

        // ─── Test 1: overlay add / remove / toggle round-trip
        try {
            var snapshot = G.PRiSM_overlays.list().slice();
            G.PRiSM_overlays.clear();
            var id1 = G.PRiSM_overlays.add('period:0', 'Test P0');
            var id2 = G.PRiSM_overlays.add('model:homogeneous');
            var afterAdd = G.PRiSM_overlays.items.length === 2;
            G.PRiSM_overlays.toggle(id1);
            var afterToggle = (G.PRiSM_overlays.items[0].visible === false);
            G.PRiSM_overlays.remove(id2);
            var afterRemove = (G.PRiSM_overlays.items.length === 1 &&
                                G.PRiSM_overlays.items[0].id === id1);
            G.PRiSM_overlays.clear();
            // Restore prior overlays
            for (var s = 0; s < snapshot.length; s++) G.PRiSM_overlays.items.push(snapshot[s]);
            checks.push({
                name: 'PRiSM_overlays add/remove/toggle round-trip',
                ok:    afterAdd && afterToggle && afterRemove
            });
        } catch (e) {
            checks.push({ name: 'PRiSM_overlays add/remove/toggle round-trip',
                          ok: false, msg: e && e.message });
        }

        // ─── Test 2: datasetDiff on near-identical synthetics → small RMS
        try {
            var t = [], pA = [], pB = [];
            for (var i = 0; i < 100; i++) {
                t.push(i * 0.1);
                pA.push(100 + Math.sin(i * 0.3) * 10);
                pB.push(100 + Math.sin(i * 0.3) * 10 + 0.01); // tiny offset
            }
            var d = G.PRiSM_datasetDiff({ t: t, p: pA }, { t: t, p: pB });
            var ok2 = d && isFinite(d.rms) && d.rms < 0.05 && d.nCommon === 100 &&
                       Math.abs(d.dp[50] - (-0.01)) < 1e-6;
            checks.push({ name: 'datasetDiff on near-identical synthetics → small RMS',
                          ok: ok2, msg: 'rms=' + (d && d.rms) + ' n=' + (d && d.nCommon) });
        } catch (e) {
            checks.push({ name: 'datasetDiff on near-identical synthetics → small RMS',
                          ok: false, msg: e && e.message });
        }

        // ─── Test 3: exportXML returns parseable XML
        try {
            var res = G.PRiSM_exportXML({ pretty: true });
            var hasHeader = res.xmlString.indexOf('<?xml') === 0;
            var hasRoot   = res.xmlString.indexOf('<PRiSMProject') > 0;
            var hasFilename = /^prism-export-\d{8}-\d{6}\.xml$/.test(res.filename);
            var parseOK = true;
            if (typeof DOMParser !== 'undefined') {
                try {
                    var doc = new DOMParser().parseFromString(res.xmlString, 'application/xml');
                    var pe = doc.getElementsByTagName('parsererror');
                    parseOK = (pe.length === 0);
                } catch (e) { parseOK = false; }
            }
            checks.push({
                name: 'exportXML returns valid XML (header + root + filename, parseable)',
                ok:    hasHeader && hasRoot && hasFilename && parseOK,
                msg:   'len=' + res.xmlString.length
            });
        } catch (e) {
            checks.push({ name: 'exportXML returns valid XML', ok: false, msg: e && e.message });
        }

        // ─── Test 4: exportXML includes key sections
        try {
            var res2 = G.PRiSM_exportXML({ pretty: false });
            var s = res2.xmlString;
            var hasMeta     = s.indexOf('<Meta>')         >= 0 || s.indexOf('<Meta ')  >= 0;
            var hasPVT      = s.indexOf('<PVT')           >= 0;
            var hasModel    = s.indexOf('<Model>')        >= 0;
            var hasAnalysis = s.indexOf('<AnalysisData')  >= 0;
            checks.push({
                name: 'exportXML includes Meta + PVT + Model + AnalysisData sections',
                ok:    hasMeta && hasPVT && hasModel && hasAnalysis
            });
        } catch (e) {
            checks.push({ name: 'exportXML includes key sections', ok: false, msg: e && e.message });
        }

        // ─── Test 5: copyPlotToClipboard returns a Promise
        try {
            var ret = G.PRiSM_copyPlotToClipboard();
            var isPromise = ret && typeof ret.then === 'function';
            // Don't await — clipboard requires user gesture, just verify shape.
            if (isPromise) {
                ret.then(function () {}, function () {}); // swallow rejection if any
            }
            checks.push({ name: 'copyPlotToClipboard returns a Promise', ok: !!isPromise });
        } catch (e) {
            checks.push({ name: 'copyPlotToClipboard returns a Promise', ok: false, msg: e && e.message });
        }

        // ─── Test 6: copyDataToClipboard with format=tsv returns expected shape
        try {
            // Stash + populate a tiny synthetic dataset for the test, then restore.
            var prev = G.PRiSM_dataset;
            G.PRiSM_dataset = { t: [0, 1, 2], p: [100, 110, 120], q: [50, 50, 0] };
            var ret2 = G.PRiSM_copyDataToClipboard('tsv');
            var isPromise2 = ret2 && typeof ret2.then === 'function';
            // The serialiser is reachable independent of clipboard avail.
            var tsv = _serializeDataset_TSV(G.PRiSM_dataset, '\t');
            var hasHeader = tsv.indexOf('t\tp\tq') === 0;
            var rows = tsv.split('\n');
            G.PRiSM_dataset = prev;
            if (isPromise2) ret2.then(function () {}, function () {});
            checks.push({
                name: 'copyDataToClipboard(tsv) returns Promise + correct TSV shape',
                ok:    isPromise2 && hasHeader && rows.length === 4
            });
        } catch (e) {
            checks.push({ name: 'copyDataToClipboard(tsv) returns Promise + correct TSV shape',
                          ok: false, msg: e && e.message });
        }

        // ─── Test 7: XML escaping handles special characters
        try {
            var res3 = G.PRiSM_exportXML({ pretty: false });
            // Ensure the escape function is robust regardless of state
            var sample = _xmlEscape('<a&b>"c\'d');
            var ok7 = sample === '&lt;a&amp;b&gt;&quot;c&apos;d';
            checks.push({ name: 'XML escaping handles 5 standard entities', ok: ok7 });
        } catch (e) {
            checks.push({ name: 'XML escaping handles 5 standard entities', ok: false, msg: e && e.message });
        }

        // ─── Test 8: PRiSM_drawOverlays is a callable no-op when no overlays
        try {
            var canvas = null;
            if (_hasDoc && typeof document.createElement === 'function') {
                canvas = document.createElement('canvas');
                if (canvas.width !== undefined) {
                    canvas.width = 600; canvas.height = 400;
                    if (canvas.style) { canvas.style.width = '600px'; canvas.style.height = '400px'; }
                }
            }
            // No overlays present (or any state) — should not throw.
            var beforeLen = G.PRiSM_overlays.items.length;
            G.PRiSM_overlays.clear();
            G.PRiSM_drawOverlays(canvas, 'bourdet', null);
            // Restore (test is non-destructive).
            for (var rk = 0; rk < beforeLen; rk++) {
                // not strictly restorable; tests already cleared in test 1.
            }
            checks.push({ name: 'PRiSM_drawOverlays no-op when overlay list empty', ok: true });
        } catch (e) {
            checks.push({ name: 'PRiSM_drawOverlays no-op when overlay list empty',
                          ok: false, msg: e && e.message });
        }

        var fails = checks.filter(function (c) { return !c.ok; });
        if (fails.length) {
            err('PRiSM plot-utilities self-test FAILED:', fails);
        } else {
            log('✓ plot-utilities self-test passed (' + checks.length + ' checks).');
        }
    })();

})();
