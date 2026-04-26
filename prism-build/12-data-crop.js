// ════════════════════════════════════════════════════════════════════
// PRiSM ─ Layer 12 — Interactive Data Crop / Trim tool
//   • Drag-to-select crop window on a pressure-vs-time canvas
//   • Fine-control numeric trim (t_start, t_end + sample-index pair)
//   • Live first/last sample preview before confirming
//   • One-click confirm + reset
// ════════════════════════════════════════════════════════════════════
//
// USER FLOW
//   1. Tab 1 file picker fills window.PRiSM_dataset = { t, p, q, ... }
//   2. This module appends an interactive crop chart below the existing
//      preview. The user drags handles or types t_start/t_end/i_start/i_end
//      to define the cropped window.
//   3. A first-3 / last-3 preview block updates live.
//   4. "Confirm crop" replaces window.PRiSM_dataset with the slice and
//      fires window CustomEvent('prism:dataset-cropped', { detail }).
//   5. "Reset" restores the original snapshot.
//
// PUBLIC API
//   window.PRiSM_renderCropTool(container)
//   window.PRiSM_applyCrop(t_start, t_end)
//   window.PRiSM_resetCrop()
//   window.PRiSM_getCropPreview()
//   window.PRiSM_cropState               (read-only inspection)
//
// CONVENTIONS
//   • Single outer IIFE, 'use strict'.
//   • All public symbols on window.PRiSM_*.
//   • No external libraries — vanilla canvas, plain DOM.
//   • The original (uncropped) dataset is snapshotted on first interaction
//     and restored on reset; subsequent crops always slice from that snapshot
//     so a reset is always exact.
// ════════════════════════════════════════════════════════════════════

(function () {
    'use strict';

    // ───────────────────────────────────────────────────────────────
    // Tiny env shims so the module can load in the smoke-test stub.
    // ───────────────────────────────────────────────────────────────
    var _hasDoc = (typeof document !== 'undefined');
    var _hasWin = (typeof window !== 'undefined');
    var G       = _hasWin ? window : (typeof globalThis !== 'undefined' ? globalThis : {});

    function _eng(n, sig) {
        if (typeof G.PRiSM_plot_format_eng === 'function') {
            return G.PRiSM_plot_format_eng(n, sig || 3);
        }
        if (n == null || !isFinite(n)) return '';
        sig = sig || 3;
        if (n === 0) return '0';
        var a = Math.abs(n);
        if (a >= 1e9) return (n / 1e9).toPrecision(sig).replace(/\.?0+$/, '') + 'G';
        if (a >= 1e6) return (n / 1e6).toPrecision(sig).replace(/\.?0+$/, '') + 'M';
        if (a >= 1e3) return (n / 1e3).toPrecision(sig).replace(/\.?0+$/, '') + 'k';
        if (a >= 1)   return n.toPrecision(sig).replace(/\.?0+$/, '');
        if (a >= 1e-3) return n.toPrecision(sig).replace(/\.?0+$/, '');
        return n.toExponential(2).replace(/e([+-])0?(\d)/, 'e$1$2');
    }

    function _fmt(n, dp) {
        if (n == null || !isFinite(n)) return '—';
        return Number(n).toFixed(dp == null ? 4 : dp);
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 1 — STATE
    // ═══════════════════════════════════════════════════════════════
    var cropState = {
        t_start: null,        // crop window in time units (canonical hours)
        t_end:   null,
        i_start: null,        // sample-index window (derived)
        i_end:   null,
        fullDataset: null,    // snapshot of pre-crop dataset
        container: null,      // DOM container for the crop UI
        canvas:    null,      // crop chart canvas
        // Derived layout from the most recent draw — used by mouse maths.
        layout: null,         // { x, y, w, h, cssW, cssH, tMin, tMax, pMin, pMax }
        drag: null,           // { kind: 'left'|'right'|'new', startX, ... }
        debounceTimer: null,
        wired: false
    };

    // Expose state for inspection (read mostly; tests poke it directly).
    G.PRiSM_cropState = cropState;


    // ═══════════════════════════════════════════════════════════════
    // SECTION 2 — DATASET HELPERS
    // ═══════════════════════════════════════════════════════════════

    // Take a SHALLOW snapshot of the active dataset's array refs (we only
    // ever .slice() — never mutate the originals, so shallow is safe).
    function _snapshotDataset(ds) {
        if (!ds) return null;
        var snap = {
            t: (ds.t || []).slice(),
            p: ds.p ? ds.p.slice() : null,
            q: ds.q ? ds.q.slice() : null
        };
        // Optional period array.
        if (ds.period) snap.period = ds.period.slice();
        // Optional multi-phase rates.
        if (ds.phases) {
            snap.phases = {
                oil:   ds.phases.oil   ? ds.phases.oil.slice()   : null,
                gas:   ds.phases.gas   ? ds.phases.gas.slice()   : null,
                water: ds.phases.water ? ds.phases.water.slice() : null
            };
        }
        // Carry through any other simple top-level keys the dataset may
        // already hold (e.g. .units, .meta), so we don't drop info.
        for (var k in ds) {
            if (snap[k] !== undefined) continue;
            if (k === 't' || k === 'p' || k === 'q' || k === 'period' || k === 'phases') continue;
            try { snap[k] = ds[k]; } catch (e) { /* ignore */ }
        }
        return snap;
    }

    // Slice helper — produces a new object with .slice(i_start, i_end)
    // applied to every parallel array. Indices are inclusive at i_start,
    // exclusive at i_end (matching Array.prototype.slice).
    function _sliceDataset(snap, i_start, i_end) {
        if (!snap) return null;
        var out = { t: snap.t.slice(i_start, i_end) };
        if (snap.p) out.p = snap.p.slice(i_start, i_end);
        if (snap.q) out.q = snap.q.slice(i_start, i_end);
        if (snap.period) out.period = snap.period.slice(i_start, i_end);
        if (snap.phases) {
            out.phases = {
                oil:   snap.phases.oil   ? snap.phases.oil.slice(i_start, i_end)   : null,
                gas:   snap.phases.gas   ? snap.phases.gas.slice(i_start, i_end)   : null,
                water: snap.phases.water ? snap.phases.water.slice(i_start, i_end) : null
            };
        }
        // Carry through scalar keys.
        for (var k in snap) {
            if (out[k] !== undefined) continue;
            if (k === 't' || k === 'p' || k === 'q' || k === 'period' || k === 'phases') continue;
            try { out[k] = snap[k]; } catch (e) {}
        }
        return out;
    }

    // Find the smallest index i such that t[i] >= target.
    function _findIndex(t, target) {
        if (!t || !t.length) return 0;
        if (target <= t[0]) return 0;
        if (target >= t[t.length - 1]) return t.length - 1;
        // Binary search.
        var lo = 0, hi = t.length - 1;
        while (lo < hi) {
            var mid = (lo + hi) >>> 1;
            if (t[mid] < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    // Median of array (used for keyboard arrow-key step).
    function _medianStep(t) {
        if (!t || t.length < 2) return 0.001;
        var dts = [];
        for (var i = 1; i < t.length; i++) {
            var d = t[i] - t[i - 1];
            if (isFinite(d) && d > 0) dts.push(d);
        }
        if (!dts.length) return 0.001;
        dts.sort(function (a, b) { return a - b; });
        return dts[dts.length >> 1] || 0.001;
    }

    // Snapshot the live dataset if we don't already have one.
    function _ensureSnapshot() {
        if (cropState.fullDataset) return cropState.fullDataset;
        var ds = G.PRiSM_dataset;
        if (!ds || !ds.t || !ds.t.length) return null;
        cropState.fullDataset = _snapshotDataset(ds);
        // Initialise crop window to the full range.
        var t = cropState.fullDataset.t;
        cropState.t_start = t[0];
        cropState.t_end   = t[t.length - 1];
        cropState.i_start = 0;
        cropState.i_end   = t.length;
        return cropState.fullDataset;
    }

    // Clamp + reconcile crop bounds against the snapshot.
    function _normaliseBounds() {
        var snap = cropState.fullDataset;
        if (!snap || !snap.t || !snap.t.length) return false;
        var t = snap.t;
        var tMin = t[0], tMax = t[t.length - 1];
        // Time bounds.
        var ts = cropState.t_start, te = cropState.t_end;
        if (!isFinite(ts)) ts = tMin;
        if (!isFinite(te)) te = tMax;
        if (ts < tMin) ts = tMin;
        if (te > tMax) te = tMax;
        if (ts >= te) {
            // Collapse — restore at least one sample.
            ts = tMin;
            te = tMax;
        }
        cropState.t_start = ts;
        cropState.t_end   = te;
        // Derive sample indices.
        cropState.i_start = _findIndex(t, ts);
        cropState.i_end   = _findIndex(t, te) + 1; // exclusive
        if (cropState.i_end > t.length) cropState.i_end = t.length;
        if (cropState.i_start < 0) cropState.i_start = 0;
        if (cropState.i_end <= cropState.i_start) cropState.i_end = cropState.i_start + 1;
        return true;
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 3 — CROP CHART (canvas) RENDERING
    // ═══════════════════════════════════════════════════════════════

    var THEME = {
        bg:      '#0d1117',
        panel:   '#161b22',
        border:  '#30363d',
        grid:    '#21262d',
        text:    '#c9d1d9',
        text2:   '#8b949e',
        text3:   '#6e7681',
        curve:   '#58a6ff',
        handle:  '#f0883e',
        band:    'rgba(240,136,62,0.10)'
    };

    var PADDING = { top: 12, right: 14, bottom: 28, left: 56 };

    function _setupCanvas(canvas, opts) {
        var dpr = (typeof G.devicePixelRatio === 'number' ? G.devicePixelRatio : 1) || 1;
        var cssW = opts.width;
        var cssH = opts.height;
        canvas.style.width  = cssW + 'px';
        canvas.style.height = cssH + 'px';
        canvas.width  = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
        var ctx = canvas.getContext && canvas.getContext('2d');
        if (ctx && ctx.setTransform) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return { ctx: ctx, dpr: dpr, cssW: cssW, cssH: cssH };
    }

    // "Nice" linear ticks (4-6 of them).
    function _linTicks(min, max, target) {
        target = target || 5;
        if (!isFinite(min) || !isFinite(max) || max <= min) return [];
        var span = max - min;
        var rough = span / target;
        var mag = Math.pow(10, Math.floor(Math.log10(rough)));
        var norm = rough / mag;
        var step;
        if (norm < 1.5)      step = 1 * mag;
        else if (norm < 3)   step = 2 * mag;
        else if (norm < 7)   step = 5 * mag;
        else                 step = 10 * mag;
        var start = Math.ceil(min / step) * step;
        var ticks = [];
        for (var v = start; v <= max + step * 0.001; v += step) {
            ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
        }
        return ticks;
    }

    function _drawCropChart() {
        var canvas = cropState.canvas;
        var snap   = cropState.fullDataset;
        if (!canvas || !snap || !snap.t || !snap.t.length) return;
        var t = snap.t;
        var p = snap.p && snap.p.length === t.length ? snap.p
              : (snap.q && snap.q.length === t.length ? snap.q : t);

        // Compute target canvas size from container.
        var container = cropState.container;
        var maxW = 800;
        var availW = (container && container.clientWidth) ? container.clientWidth : maxW;
        var cssW = Math.max(360, Math.min(maxW, availW));
        var cssH = 300;
        var setup = _setupCanvas(canvas, { width: cssW, height: cssH });
        var ctx = setup.ctx;
        if (!ctx) return;
        // Wrap calls so a stub canvas (e.g. node smoke-test) that lacks some
        // methods doesn't throw. We always still compute the layout so that
        // hit-testing / preview state remains correct.
        var _safe = function (fn) {
            try { fn(); } catch (e) { /* canvas method missing — silently skip */ }
        };

        var pad = PADDING;
        var plot = {
            x: pad.left,
            y: pad.top,
            w: cssW - pad.left - pad.right,
            h: cssH - pad.top - pad.bottom,
            cssW: cssW,
            cssH: cssH
        };

        // Data bounds.
        var tMin = t[0], tMax = t[t.length - 1];
        var pMin = Infinity, pMax = -Infinity;
        for (var i = 0; i < p.length; i++) {
            var v = p[i];
            if (isFinite(v)) {
                if (v < pMin) pMin = v;
                if (v > pMax) pMax = v;
            }
        }
        if (!isFinite(pMin) || !isFinite(pMax) || pMin === pMax) {
            pMin = (isFinite(pMin) ? pMin : 0) - 1;
            pMax = (isFinite(pMax) ? pMax : 0) + 1;
        }
        // Pad pressure axis ±5%.
        var pSpan = pMax - pMin;
        pMin -= pSpan * 0.05;
        pMax += pSpan * 0.05;

        // World→pixel transforms.
        function toX(v) { return plot.x + (v - tMin) / (tMax - tMin) * plot.w; }
        function toY(v) { return plot.y + plot.h - (v - pMin) / (pMax - pMin) * plot.h; }

        // Stash layout for hit-testing — done before paint so a stub
        // canvas with missing methods doesn't trip up subsequent logic.
        cropState.layout = {
            x: plot.x, y: plot.y, w: plot.w, h: plot.h,
            cssW: cssW, cssH: cssH,
            tMin: tMin, tMax: tMax,
            pMin: pMin, pMax: pMax,
            toX: toX, toY: toY
        };

        // ─── Paint (all calls inside the safe wrapper) ──────────────
        _safe(function () {
            // Background.
            ctx.fillStyle = THEME.bg;
            ctx.fillRect(0, 0, cssW, cssH);
            ctx.fillStyle = THEME.panel;
            ctx.fillRect(plot.x, plot.y, plot.w, plot.h);

            // Gridlines + tick labels.
            var xTicks = _linTicks(tMin, tMax, 6);
            var yTicks = _linTicks(pMin, pMax, 5);

            ctx.strokeStyle = THEME.grid;
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (var ix = 0; ix < xTicks.length; ix++) {
                var px = Math.round(toX(xTicks[ix])) + 0.5;
                ctx.moveTo(px, plot.y);
                ctx.lineTo(px, plot.y + plot.h);
            }
            for (var iy = 0; iy < yTicks.length; iy++) {
                var py = Math.round(toY(yTicks[iy])) + 0.5;
                ctx.moveTo(plot.x, py);
                ctx.lineTo(plot.x + plot.w, py);
            }
            ctx.stroke();

            // Border.
            ctx.strokeStyle = THEME.border;
            if (typeof ctx.strokeRect === 'function') {
                ctx.strokeRect(plot.x + 0.5, plot.y + 0.5, plot.w, plot.h);
            }

            // Axis labels.
            ctx.fillStyle = THEME.text2;
            ctx.font = '11px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            for (var jx = 0; jx < xTicks.length; jx++) {
                var pxL = Math.round(toX(xTicks[jx]));
                ctx.fillText(_eng(xTicks[jx], 3), pxL, plot.y + plot.h + 4);
            }
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            for (var jy = 0; jy < yTicks.length; jy++) {
                var pyL = Math.round(toY(yTicks[jy]));
                ctx.fillText(_eng(yTicks[jy], 3), plot.x - 6, pyL);
            }

            // Pressure curve.
            ctx.save();
            ctx.beginPath();
            ctx.rect(plot.x, plot.y, plot.w, plot.h);
            ctx.clip();
            ctx.strokeStyle = THEME.curve;
            ctx.lineWidth = 1.25;
            ctx.beginPath();
            var moved = false;
            for (var k = 0; k < t.length; k++) {
                var vy = p[k];
                if (!isFinite(vy)) continue;
                var x = toX(t[k]);
                var y = toY(vy);
                if (!moved) { ctx.moveTo(x, y); moved = true; }
                else        { ctx.lineTo(x, y); }
            }
            ctx.stroke();
            ctx.restore();

            // Selection band + handles.
            var ts = cropState.t_start, te = cropState.t_end;
            if (isFinite(ts) && isFinite(te) && te > ts) {
                var xL = toX(ts), xR = toX(te);
                // Band.
                ctx.fillStyle = THEME.band;
                ctx.fillRect(xL, plot.y, xR - xL, plot.h);
                // Left + right handles.
                ctx.fillStyle = THEME.handle;
                ctx.fillRect(Math.round(xL) - 1, plot.y, 3, plot.h);
                ctx.fillRect(Math.round(xR) - 1, plot.y, 3, plot.h);
                // Handle grips (small squares mid-height).
                ctx.fillRect(Math.round(xL) - 4, plot.y + plot.h / 2 - 6, 9, 12);
                ctx.fillRect(Math.round(xR) - 4, plot.y + plot.h / 2 - 6, 9, 12);
            }
        });
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 4 — POINTER / DRAG INTERACTION
    // ═══════════════════════════════════════════════════════════════

    function _eventToCanvasX(canvas, ev) {
        if (!canvas || !canvas.getBoundingClientRect) return 0;
        var rect = canvas.getBoundingClientRect();
        var clientX = (ev.clientX != null) ? ev.clientX
                      : (ev.touches && ev.touches[0] ? ev.touches[0].clientX : 0);
        return clientX - rect.left;
    }

    function _xToTime(x) {
        var L = cropState.layout;
        if (!L) return null;
        var frac = (x - L.x) / L.w;
        if (frac < 0) frac = 0;
        if (frac > 1) frac = 1;
        return L.tMin + frac * (L.tMax - L.tMin);
    }

    // Decide whether the cursor is over a handle. Returns 'left' | 'right' | null.
    function _hitTest(x) {
        var L = cropState.layout;
        if (!L) return null;
        var ts = cropState.t_start, te = cropState.t_end;
        if (!isFinite(ts) || !isFinite(te)) return null;
        var xL = L.toX(ts), xR = L.toX(te);
        var TOL = 8;
        if (Math.abs(x - xL) <= TOL) return 'left';
        if (Math.abs(x - xR) <= TOL) return 'right';
        return null;
    }

    function _onPointerDown(ev) {
        if (!cropState.canvas) return;
        var x = _eventToCanvasX(cropState.canvas, ev);
        var hit = _hitTest(x);
        if (hit) {
            cropState.drag = { kind: hit };
        } else {
            // Start a new range select from this point.
            var t = _xToTime(x);
            if (t == null) return;
            cropState.t_start = t;
            cropState.t_end   = t;
            cropState.drag = { kind: 'new', anchor: t };
        }
        // Try to capture the pointer for smooth tracking.
        if (ev.pointerId != null && cropState.canvas.setPointerCapture) {
            try { cropState.canvas.setPointerCapture(ev.pointerId); } catch (e) {}
        }
        if (ev.preventDefault) ev.preventDefault();
        _refreshFromInternal();
    }

    function _onPointerMove(ev) {
        if (!cropState.canvas) return;
        var L = cropState.layout;
        if (!L) return;
        var x = _eventToCanvasX(cropState.canvas, ev);
        if (!cropState.drag) {
            // Update cursor based on hover.
            var over = _hitTest(x);
            cropState.canvas.style.cursor = over ? 'ew-resize' : 'crosshair';
            return;
        }
        var t = _xToTime(x);
        if (t == null) return;
        if (cropState.drag.kind === 'left') {
            if (t >= cropState.t_end) t = cropState.t_end - (L.tMax - L.tMin) * 1e-4;
            cropState.t_start = t;
        } else if (cropState.drag.kind === 'right') {
            if (t <= cropState.t_start) t = cropState.t_start + (L.tMax - L.tMin) * 1e-4;
            cropState.t_end = t;
        } else if (cropState.drag.kind === 'new') {
            var a = cropState.drag.anchor;
            if (t < a) { cropState.t_start = t; cropState.t_end = a; }
            else       { cropState.t_start = a; cropState.t_end = t; }
        }
        if (ev.preventDefault) ev.preventDefault();
        _refreshFromInternal();
    }

    function _onPointerUp(ev) {
        if (!cropState.canvas) return;
        cropState.drag = null;
        if (ev && ev.pointerId != null && cropState.canvas.releasePointerCapture) {
            try { cropState.canvas.releasePointerCapture(ev.pointerId); } catch (e) {}
        }
    }

    function _wireCanvasEvents(canvas) {
        if (!canvas || !canvas.addEventListener) return;
        canvas.style.touchAction = 'none';
        canvas.style.cursor = 'crosshair';
        // Prefer Pointer Events if available.
        var hasPointer = (typeof G.PointerEvent !== 'undefined');
        if (hasPointer) {
            canvas.addEventListener('pointerdown',   _onPointerDown);
            canvas.addEventListener('pointermove',   _onPointerMove);
            canvas.addEventListener('pointerup',     _onPointerUp);
            canvas.addEventListener('pointercancel', _onPointerUp);
            canvas.addEventListener('pointerleave',  function () { /* keep cursor */ });
        } else {
            canvas.addEventListener('mousedown',  _onPointerDown);
            canvas.addEventListener('mousemove',  _onPointerMove);
            canvas.addEventListener('mouseup',    _onPointerUp);
            canvas.addEventListener('mouseleave', _onPointerUp);
            canvas.addEventListener('touchstart', function (e) { _onPointerDown(e); }, { passive: false });
            canvas.addEventListener('touchmove',  function (e) { _onPointerMove(e); }, { passive: false });
            canvas.addEventListener('touchend',   _onPointerUp);
            canvas.addEventListener('touchcancel',_onPointerUp);
        }
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 5 — NUMERIC INPUT WIRING
    // ═══════════════════════════════════════════════════════════════

    function _byId(id) {
        return _hasDoc ? document.getElementById(id) : null;
    }

    function _debounce(fn) {
        if (cropState.debounceTimer) clearTimeout(cropState.debounceTimer);
        cropState.debounceTimer = setTimeout(fn, 50);
    }

    // After a numeric input changes, reconcile + redraw.
    function _refreshFromInputs() {
        var snap = cropState.fullDataset;
        if (!snap) return;
        var ts = parseFloat((_byId('prism_crop_tstart') || {}).value);
        var te = parseFloat((_byId('prism_crop_tend')   || {}).value);
        var is = parseInt((_byId('prism_crop_istart')   || {}).value, 10);
        var ie = parseInt((_byId('prism_crop_iend')     || {}).value, 10);

        // Determine which inputs the user just changed by comparing to the
        // current cropState values; any deviating input wins.
        var changedT = false, changedI = false;
        if (isFinite(ts) && Math.abs(ts - (cropState.t_start || 0)) > 1e-9) changedT = true;
        if (isFinite(te) && Math.abs(te - (cropState.t_end   || 0)) > 1e-9) changedT = true;
        if (isFinite(is) && is !== cropState.i_start) changedI = true;
        if (isFinite(ie) && ie !== cropState.i_end)   changedI = true;

        var t = snap.t;
        if (changedI && !changedT) {
            // Index inputs win.
            if (!isFinite(is)) is = cropState.i_start;
            if (!isFinite(ie)) ie = cropState.i_end;
            is = Math.max(0, Math.min(t.length - 1, is | 0));
            ie = Math.max(is + 1, Math.min(t.length, ie | 0));
            cropState.i_start = is;
            cropState.i_end   = ie;
            cropState.t_start = t[is];
            cropState.t_end   = t[Math.min(ie - 1, t.length - 1)];
        } else {
            // Time inputs win (default).
            if (!isFinite(ts)) ts = cropState.t_start;
            if (!isFinite(te)) te = cropState.t_end;
            cropState.t_start = ts;
            cropState.t_end   = te;
        }
        _normaliseBounds();
        _syncInputs();
        _drawCropChart();
        _renderPreviewBlock();
    }

    function _refreshFromInternal() {
        // After a drag, sync inputs + preview live (no debounce — mouse).
        _normaliseBounds();
        _syncInputs();
        _drawCropChart();
        _renderPreviewBlock();
    }

    function _syncInputs() {
        var ts = _byId('prism_crop_tstart');
        var te = _byId('prism_crop_tend');
        var is = _byId('prism_crop_istart');
        var ie = _byId('prism_crop_iend');
        if (ts) ts.value = isFinite(cropState.t_start) ? Number(cropState.t_start.toFixed(6)) : '';
        if (te) te.value = isFinite(cropState.t_end)   ? Number(cropState.t_end.toFixed(6))   : '';
        if (is) is.value = (cropState.i_start != null) ? cropState.i_start : '';
        if (ie) ie.value = (cropState.i_end   != null) ? cropState.i_end   : '';
    }

    function _wireInputs() {
        var ts = _byId('prism_crop_tstart');
        var te = _byId('prism_crop_tend');
        var is = _byId('prism_crop_istart');
        var ie = _byId('prism_crop_iend');
        var apply = _byId('prism_crop_apply');
        var reset = _byId('prism_crop_reset');

        var onInput = function () { _debounce(_refreshFromInputs); };
        [ts, te, is, ie].forEach(function (inp) {
            if (!inp) return;
            inp.oninput  = onInput;
            inp.onchange = onInput;
            // Arrow-key fine step on the time inputs: ±median dt.
            if (inp === ts || inp === te) {
                inp.onkeydown = function (ev) {
                    if (!cropState.fullDataset) return;
                    var step = _medianStep(cropState.fullDataset.t);
                    var which = (inp === ts) ? 't_start' : 't_end';
                    var cur = cropState[which];
                    if (!isFinite(cur)) return;
                    if (ev.key === 'ArrowUp')   { cropState[which] = cur + step; ev.preventDefault(); _refreshFromInternal(); }
                    if (ev.key === 'ArrowDown') { cropState[which] = cur - step; ev.preventDefault(); _refreshFromInternal(); }
                };
            }
        });

        if (apply) apply.onclick = function () {
            try {
                var res = G.PRiSM_applyCrop(cropState.t_start, cropState.t_end);
                _flashMessage('prism_crop_msg',
                    'Cropped dataset of ' + (res ? res.t.length : '?') + ' points active.', 'green');
            } catch (e) {
                _flashMessage('prism_crop_msg', 'Crop failed: ' + (e && e.message), 'red');
            }
        };
        if (reset) reset.onclick = function () {
            G.PRiSM_resetCrop();
            _flashMessage('prism_crop_msg', 'Crop reset — full dataset restored.', 'text2');
        };
    }

    function _flashMessage(id, html, colorVar) {
        var el = _byId(id);
        if (!el) return;
        var color = '';
        if (colorVar === 'green') color = 'color:#3fb950;';
        else if (colorVar === 'red') color = 'color:#f85149;';
        else color = 'color:#8b949e;';
        el.innerHTML = '<span style="' + color + '">' + html + '</span>';
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 6 — PREVIEW BLOCK (first 3 + last 3, stats)
    // ═══════════════════════════════════════════════════════════════

    function _previewLine(snap, idx) {
        if (!snap) return '';
        var parts = [];
        parts.push('t=' + _eng(snap.t[idx], 4));
        if (snap.p) parts.push('p=' + _eng(snap.p[idx], 4));
        if (snap.q) parts.push('q=' + _eng(snap.q[idx], 4));
        return '    ' + parts.join(', ');
    }

    function _renderPreviewBlock() {
        var pre = _byId('prism_crop_preview');
        if (!pre) return;
        var snap = cropState.fullDataset;
        if (!snap || !snap.t || !snap.t.length) {
            pre.textContent = 'No dataset loaded yet.';
            return;
        }
        var i0 = cropState.i_start, i1 = cropState.i_end;
        var sliced = _sliceDataset(snap, i0, i1);
        var n = sliced.t.length;
        var nFull = snap.t.length;
        var firstN = Math.min(3, n);
        var lastN  = (n > 3) ? Math.min(3, n - firstN) : 0;
        var tMin = sliced.t[0];
        var tMax = sliced.t[n - 1];
        var dT = tMax - tMin;
        var pMin = Infinity, pMax = -Infinity;
        if (sliced.p) {
            for (var k = 0; k < sliced.p.length; k++) {
                var v = sliced.p[k];
                if (isFinite(v)) {
                    if (v < pMin) pMin = v;
                    if (v > pMax) pMax = v;
                }
            }
        }
        var lines = [];
        lines.push('Cropped dataset preview:');
        lines.push('  Samples:  ' + nFull.toLocaleString() + '  →  ' + n.toLocaleString());
        lines.push('  Time:     ' + _eng(tMin, 4) + '  to  ' + _eng(tMax, 4) + '  hours  (Δ ' + _eng(dT, 4) + ')');
        if (sliced.p) {
            var rng = pMax - pMin;
            lines.push('  Pressure: ' + _eng(pMin, 4) + '  to  ' + _eng(pMax, 4) + '  psi  (range ' + _eng(rng, 4) + ')');
        }
        lines.push('');
        lines.push('  First ' + firstN + ':');
        for (var i = 0; i < firstN; i++) lines.push(_previewLine(sliced, i));
        if (lastN > 0) {
            lines.push('  Last ' + lastN + ':');
            for (var j = n - lastN; j < n; j++) lines.push(_previewLine(sliced, j));
        }
        pre.textContent = lines.join('\n');
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 7 — PUBLIC API
    // ═══════════════════════════════════════════════════════════════

    G.PRiSM_renderCropTool = function PRiSM_renderCropTool(container) {
        if (!_hasDoc) return;
        if (!container) return;
        cropState.container = container;

        // Build UI markup.
        container.innerHTML =
              '<div class="prism-crop-card" style="background:#161b22; border:1px solid #30363d; border-radius:6px; padding:12px;">'
            +   '<div style="font-weight:600; color:#c9d1d9; font-size:13px; margin-bottom:6px;">'
            +     'Interactive crop &amp; trim'
            +   '</div>'
            +   '<div style="font-size:12px; color:#8b949e; margin-bottom:10px;">'
            +     'Drag on the chart to define a crop window, or fine-tune with the inputs below. '
            +     'Click <b>Confirm crop</b> to replace the active dataset.'
            +   '</div>'
            +   '<canvas id="prism_crop_canvas" width="800" height="300" '
            +     'style="display:block; background:#0d1117; border:1px solid #30363d; '
            +     'border-radius:6px; max-width:100%; touch-action:none;"></canvas>'
            +   '<div class="prism-crop-controls" style="margin-top:10px; display:flex; flex-wrap:wrap; gap:10px; align-items:flex-end;">'
            +     '<label style="display:flex; flex-direction:column; font-size:11px; color:#8b949e;">'
            +       't start'
            +       '<input type="number" id="prism_crop_tstart" step="0.001" '
            +         'style="width:120px; padding:4px 6px; background:#0d1117; color:#c9d1d9; '
            +         'border:1px solid #30363d; border-radius:4px; font-family:monospace; font-size:12px;">'
            +     '</label>'
            +     '<label style="display:flex; flex-direction:column; font-size:11px; color:#8b949e;">'
            +       't end'
            +       '<input type="number" id="prism_crop_tend" step="0.001" '
            +         'style="width:120px; padding:4px 6px; background:#0d1117; color:#c9d1d9; '
            +         'border:1px solid #30363d; border-radius:4px; font-family:monospace; font-size:12px;">'
            +     '</label>'
            +     '<label style="display:flex; flex-direction:column; font-size:11px; color:#8b949e;">'
            +       'i start'
            +       '<input type="number" id="prism_crop_istart" min="0" step="1" '
            +         'style="width:90px; padding:4px 6px; background:#0d1117; color:#c9d1d9; '
            +         'border:1px solid #30363d; border-radius:4px; font-family:monospace; font-size:12px;">'
            +     '</label>'
            +     '<label style="display:flex; flex-direction:column; font-size:11px; color:#8b949e;">'
            +       'i end'
            +       '<input type="number" id="prism_crop_iend" min="0" step="1" '
            +         'style="width:90px; padding:4px 6px; background:#0d1117; color:#c9d1d9; '
            +         'border:1px solid #30363d; border-radius:4px; font-family:monospace; font-size:12px;">'
            +     '</label>'
            +     '<button id="prism_crop_apply" type="button" class="btn btn-primary" '
            +       'style="padding:6px 14px; background:#238636; color:#fff; border:1px solid #2ea043; '
            +       'border-radius:4px; cursor:pointer; font-size:12px; font-weight:600;">Confirm crop</button>'
            +     '<button id="prism_crop_reset" type="button" class="btn btn-secondary" '
            +       'style="padding:6px 14px; background:#21262d; color:#c9d1d9; border:1px solid #30363d; '
            +       'border-radius:4px; cursor:pointer; font-size:12px;">Reset</button>'
            +     '<span id="prism_crop_msg" style="font-size:12px; color:#8b949e;"></span>'
            +   '</div>'
            +   '<pre id="prism_crop_preview" '
            +     'style="margin-top:12px; padding:10px; background:#0d1117; color:#c9d1d9; '
            +     'border:1px solid #30363d; border-radius:6px; font-size:11px; '
            +     'font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace; '
            +     'max-height:240px; overflow:auto; white-space:pre;">'
            +     'No dataset loaded yet.'
            +   '</pre>'
            + '</div>';

        cropState.canvas = _byId('prism_crop_canvas');
        _wireCanvasEvents(cropState.canvas);
        _wireInputs();

        // Snapshot the live dataset (if any) and paint.
        cropState.fullDataset = null;  // force re-snapshot for fresh load
        _ensureSnapshot();
        if (cropState.fullDataset) {
            _normaliseBounds();
            _syncInputs();
            _drawCropChart();
            _renderPreviewBlock();
        }

        // Repaint on window resize so the canvas keeps filling its container.
        if (_hasWin && !cropState._resizeWired) {
            G.addEventListener('resize', function () {
                if (cropState.fullDataset && cropState.canvas) {
                    _drawCropChart();
                }
            });
            cropState._resizeWired = true;
        }
    };

    // Programmatically apply a crop. Returns the newly-active dataset.
    G.PRiSM_applyCrop = function PRiSM_applyCrop(t_start, t_end) {
        var snap = _ensureSnapshot();
        if (!snap || !snap.t || !snap.t.length) return null;
        if (isFinite(t_start)) cropState.t_start = t_start;
        if (isFinite(t_end))   cropState.t_end   = t_end;
        _normaliseBounds();
        var from = G.PRiSM_dataset || snap;
        var cropped = _sliceDataset(snap, cropState.i_start, cropState.i_end);
        G.PRiSM_dataset = cropped;
        // Update displays.
        _syncInputs();
        _drawCropChart();
        _renderPreviewBlock();
        // Fire event.
        _dispatchCropEvent(from, cropped);
        // Refresh active plot if the host bound it.
        if (typeof G.PRiSM_drawActivePlot === 'function') {
            try { G.PRiSM_drawActivePlot(); } catch (e) { /* ignore */ }
        }
        return cropped;
    };

    // Restore the snapshot — reverses any prior PRiSM_applyCrop.
    G.PRiSM_resetCrop = function PRiSM_resetCrop() {
        var snap = cropState.fullDataset;
        if (!snap) return null;
        var from = G.PRiSM_dataset;
        var restored = _snapshotDataset(snap);
        G.PRiSM_dataset = restored;
        // Reset window to full range.
        var t = snap.t;
        cropState.t_start = t[0];
        cropState.t_end   = t[t.length - 1];
        cropState.i_start = 0;
        cropState.i_end   = t.length;
        _syncInputs();
        _drawCropChart();
        _renderPreviewBlock();
        _dispatchCropEvent(from, restored);
        if (typeof G.PRiSM_drawActivePlot === 'function') {
            try { G.PRiSM_drawActivePlot(); } catch (e) { /* ignore */ }
        }
        return restored;
    };

    // Return preview details — used by other modules / tests.
    G.PRiSM_getCropPreview = function PRiSM_getCropPreview() {
        var snap = cropState.fullDataset;
        if (!snap) return null;
        var i0 = cropState.i_start, i1 = cropState.i_end;
        var sliced = _sliceDataset(snap, i0, i1);
        var n = sliced.t.length;
        var firstN = Math.min(3, n);
        var lastN  = (n > 3) ? Math.min(3, n - firstN) : 0;
        var firstRows = [], lastRows = [];
        for (var i = 0; i < firstN; i++) {
            firstRows.push({
                t: sliced.t[i],
                p: sliced.p ? sliced.p[i] : null,
                q: sliced.q ? sliced.q[i] : null
            });
        }
        for (var j = n - lastN; j < n; j++) {
            lastRows.push({
                t: sliced.t[j],
                p: sliced.p ? sliced.p[j] : null,
                q: sliced.q ? sliced.q[j] : null
            });
        }
        var tMin = sliced.t[0], tMax = sliced.t[n - 1];
        var pMin = null, pMax = null;
        if (sliced.p) {
            pMin = Infinity; pMax = -Infinity;
            for (var k = 0; k < sliced.p.length; k++) {
                var v = sliced.p[k];
                if (isFinite(v)) {
                    if (v < pMin) pMin = v;
                    if (v > pMax) pMax = v;
                }
            }
            if (!isFinite(pMin)) pMin = null;
            if (!isFinite(pMax)) pMax = null;
        }
        return {
            firstRows: firstRows,
            lastRows: lastRows,
            n: n,
            tSpan: { from: tMin, to: tMax, delta: tMax - tMin },
            pRange: (pMin != null && pMax != null) ? { min: pMin, max: pMax, range: pMax - pMin } : null
        };
    };


    // ═══════════════════════════════════════════════════════════════
    // SECTION 8 — EVENTS + INTEGRATION
    // ═══════════════════════════════════════════════════════════════

    function _dispatchCropEvent(from, to) {
        if (!_hasWin) return;
        try {
            var ev;
            if (typeof CustomEvent === 'function') {
                ev = new CustomEvent('prism:dataset-cropped', {
                    detail: { from: from, to: to, t_start: cropState.t_start, t_end: cropState.t_end,
                              i_start: cropState.i_start, i_end: cropState.i_end }
                });
            } else if (_hasDoc && document.createEvent) {
                ev = document.createEvent('CustomEvent');
                ev.initCustomEvent('prism:dataset-cropped', false, false,
                    { from: from, to: to, t_start: cropState.t_start, t_end: cropState.t_end,
                      i_start: cropState.i_start, i_end: cropState.i_end });
            }
            if (ev && G.dispatchEvent) G.dispatchEvent(ev);
        } catch (e) { /* ignore */ }
    }

    // Listen for an upstream "dataset-loaded" signal — when a new file is
    // loaded, we want to forget the previous snapshot.
    if (_hasWin && G.addEventListener) {
        G.addEventListener('prism:dataset-loaded', function () {
            cropState.fullDataset = null;
            cropState.t_start = cropState.t_end = null;
            cropState.i_start = cropState.i_end = null;
            if (cropState.container) {
                _ensureSnapshot();
                if (cropState.fullDataset) {
                    _normaliseBounds();
                    _syncInputs();
                    _drawCropChart();
                    _renderPreviewBlock();
                }
            }
        });
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 9 — WRAP THE ENHANCED DATA-TAB RENDER
    // ═══════════════════════════════════════════════════════════════

    (function _wrapDataRender() {
        if (!_hasWin) return;
        if (typeof G.PRiSM_renderDataTabEnhanced !== 'function') {
            // Tab 1 may render via the foundation directly. Try again later.
            if (typeof setTimeout === 'function') {
                setTimeout(_wrapDataRender, 250);
            }
            return;
        }
        if (G.PRiSM_renderDataTabEnhanced._cropToolWrapped) return;
        var orig = G.PRiSM_renderDataTabEnhanced;
        var wrapped = function (container) {
            var ret = orig.apply(this, arguments);
            try {
                // Find or create a host below the existing data card.
                var host = null;
                if (_hasDoc) {
                    host = document.getElementById('prism_crop_tool_host');
                    if (!host) {
                        // Place it inside the Tab 1 body if we can find it.
                        var tab1 = container && container.appendChild
                            ? container
                            : document.getElementById('prism_tab_1');
                        if (tab1 && tab1.appendChild) {
                            host = document.createElement('div');
                            host.id = 'prism_crop_tool_host';
                            host.className = 'prism-crop-tool';
                            host.style.marginTop = '16px';
                            tab1.appendChild(host);
                        }
                    }
                }
                if (host && typeof G.PRiSM_renderCropTool === 'function') {
                    G.PRiSM_renderCropTool(host);
                }
            } catch (e) {
                if (typeof console !== 'undefined' && console.warn) {
                    console.warn('PRiSM crop-tool render failed:', e);
                }
            }
            return ret;
        };
        // Preserve flags so other wrappers don't rewrap.
        for (var k in orig) { try { wrapped[k] = orig[k]; } catch (e) {} }
        wrapped._cropToolWrapped = true;
        G.PRiSM_renderDataTabEnhanced = wrapped;
    })();


    // ═══════════════════════════════════════════════════════════════
    // SECTION 10 — SELF-TEST
    // ═══════════════════════════════════════════════════════════════
    // === SELF-TEST ===
    (function PRiSM_cropSelfTest() {
        var log = (typeof console !== 'undefined' && console.log) ? console.log.bind(console) : function () {};
        var err = (typeof console !== 'undefined' && console.error) ? console.error.bind(console) : function () {};
        var checks = [];

        // ─── Test 1: PRiSM_renderCropTool injects expected DOM elements
        // We can't easily exercise the real DOM in the smoke-test harness, so
        // this test runs a lightweight DOM-presence check using a fake
        // container with a recording appendChild + getElementById.
        try {
            if (_hasDoc && typeof document.createElement === 'function') {
                // Create a container detached from <body> — only works in a
                // real browser. In smoke-test stubs, document.body may exist
                // but appendChild is a noop, so we just check the API exists.
                var c = document.createElement('div');
                if (c && c.style) {
                    G.PRiSM_renderCropTool(c);
                    // Check innerHTML now contains the expected ids.
                    var html = c.innerHTML || '';
                    var ids = ['prism_crop_canvas', 'prism_crop_tstart', 'prism_crop_tend',
                               'prism_crop_istart', 'prism_crop_iend',
                               'prism_crop_apply',  'prism_crop_reset',
                               'prism_crop_preview'];
                    var allPresent = true;
                    for (var i = 0; i < ids.length; i++) {
                        if (html.indexOf(ids[i]) < 0) { allPresent = false; break; }
                    }
                    checks.push({ name: 'renderCropTool injects all expected ids', ok: allPresent });
                } else {
                    checks.push({ name: 'renderCropTool injects all expected ids', ok: true /* skipped: no DOM */ });
                }
            } else {
                checks.push({ name: 'renderCropTool injects all expected ids', ok: true /* skipped: no DOM */ });
            }
        } catch (e) {
            checks.push({ name: 'renderCropTool injects all expected ids', ok: false, msg: e && e.message });
        }

        // ─── Test 2: PRiSM_applyCrop slices correctly + replaces dataset
        try {
            // Build a synthetic dataset of 100 samples, t in [0, 99].
            var t = [], p = [], q = [];
            for (var i2 = 0; i2 < 100; i2++) { t.push(i2); p.push(2000 + i2); q.push(500); }
            var prevDS = G.PRiSM_dataset;
            G.PRiSM_dataset = { t: t.slice(), p: p.slice(), q: q.slice() };
            // Force snapshot from this dataset.
            cropState.fullDataset = null;
            // Apply a crop t in [25, 74] — should yield 50 samples.
            var res = G.PRiSM_applyCrop(25, 74);
            var n = res && res.t ? res.t.length : 0;
            var firstOK = res && res.t[0] === 25;
            var lastOK  = res && res.t[res.t.length - 1] === 74;
            var datasetReplaced = (G.PRiSM_dataset === res);
            // Counts to 50: t[25] .. t[74] inclusive.
            var countOK = (n === 50);
            checks.push({ name: 'applyCrop slices to expected range',
                ok: firstOK && lastOK && datasetReplaced && countOK,
                msg: 'n=' + n + ' first=' + (res && res.t[0]) + ' last=' + (res && res.t[res.t.length - 1]) });
            // Also: original snapshot length is still 100.
            checks.push({ name: 'applyCrop preserves snapshot of full dataset',
                ok: cropState.fullDataset && cropState.fullDataset.t.length === 100 });
            // Restore previous global state.
            G.PRiSM_dataset = prevDS;
        } catch (e) {
            checks.push({ name: 'applyCrop slices to expected range', ok: false, msg: e && e.message });
        }

        // ─── Test 3: PRiSM_getCropPreview returns first/last + valid stats
        try {
            // Re-prep a dataset.
            var t3 = [], p3 = [], q3 = [];
            for (var i3 = 0; i3 < 50; i3++) { t3.push(i3 * 0.1); p3.push(1000 + i3 * 2); q3.push(100); }
            G.PRiSM_dataset = { t: t3, p: p3, q: q3 };
            cropState.fullDataset = null;
            G.PRiSM_applyCrop(1.0, 3.0); // slice to ~ 21 samples
            var prev = G.PRiSM_getCropPreview();
            var hasFirst = prev && prev.firstRows && prev.firstRows.length === 3;
            var hasLast  = prev && prev.lastRows  && prev.lastRows.length === 3;
            var hasN     = prev && prev.n === 21;
            var hasSpan  = prev && prev.tSpan && Math.abs(prev.tSpan.delta - 2.0) < 1e-6;
            var hasPRng  = prev && prev.pRange && prev.pRange.range > 0;
            checks.push({ name: 'getCropPreview returns first/last + stats',
                ok: hasFirst && hasLast && hasN && hasSpan && hasPRng,
                msg: 'n=' + (prev && prev.n) + ' delta=' + (prev && prev.tSpan && prev.tSpan.delta) });
        } catch (e) {
            checks.push({ name: 'getCropPreview returns first/last + stats', ok: false, msg: e && e.message });
        }

        // ─── Test 4: PRiSM_resetCrop restores the full snapshot
        try {
            var t4 = [], p4 = [];
            for (var i4 = 0; i4 < 30; i4++) { t4.push(i4); p4.push(1500 + i4); }
            G.PRiSM_dataset = { t: t4.slice(), p: p4.slice(), q: null };
            cropState.fullDataset = null;
            G.PRiSM_applyCrop(5, 20);   // crop to 16 samples
            var beforeReset = G.PRiSM_dataset.t.length;
            G.PRiSM_resetCrop();
            var afterReset  = G.PRiSM_dataset.t.length;
            checks.push({ name: 'resetCrop restores full snapshot',
                ok: beforeReset === 16 && afterReset === 30,
                msg: 'before=' + beforeReset + ' after=' + afterReset });
        } catch (e) {
            checks.push({ name: 'resetCrop restores full snapshot', ok: false, msg: e && e.message });
        }

        var fails = checks.filter(function (c) { return !c.ok; });
        if (fails.length) {
            err('PRiSM data-crop self-test FAILED:', fails);
        } else {
            log('✓ data-crop self-test passed (' + checks.length + ' checks).');
        }
    })();

})();
