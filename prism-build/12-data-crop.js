// ════════════════════════════════════════════════════════════════════
// PRiSM ─ Layer 12 — Interactive Data Crop / Trim tool
//   • Drag-to-select crop window on a pressure-vs-time canvas
//   • Fine-control numeric trim (t_start, t_end + sample-index pair)
//   • Live first/last sample preview before confirming
//   • One-click confirm + reset
// ════════════════════════════════════════════════════════════════════
//
// USER FLOW
//   1. Step ① Data loads window.PRiSM_dataset = { t, p, q, ... }
//   2. This module is a Tab 1 panel ("Crop & trim", C7 registry, order 30).
//      The user drags handles (Pointer Events — mouse, pen and touch) or
//      types t_start/t_end/i_start/i_end to define the window.
//   3. A first-3 / last-3 preview block updates live.
//   4. "Confirm crop" makes the slice the active dataset (absolute times
//      kept) through window.PRiSM_commitDataset → 'prism:dataset-loaded'
//      {source:'crop'}, fires 'prism:dataset-cropped' and redraws the plot.
//   5. "Reset" restores the original snapshot the same way.
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
//     so a reset is always exact. The snapshot survives re-renders of the
//     Data tab while the active dataset is still the one this tool set; a
//     newly loaded dataset starts a new snapshot.
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
        owned: null,          // the dataset object this tool last made active
        wired: false
    };

    // Expose state for inspection (read mostly; tests poke it directly).
    G.PRiSM_cropState = cropState;


    // ═══════════════════════════════════════════════════════════════
    // SECTION 2 — DATASET HELPERS
    // ═══════════════════════════════════════════════════════════════

    var _isArr = function (a) {
        return !!a && (Array.isArray(a) || (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(a)));
    };
    var _copy = function (a) { return Array.prototype.slice.call(a); };

    // Keys that are derived from the full record and would be wrong for a
    // slice (they are rebuilt by their owners on 'prism:dataset-loaded').
    var DERIVED_KEYS = { periods: 1, dp: 1, deriv: 1, _cache: 1 };

    // Take a snapshot of the active dataset (arrays copied — we never mutate
    // the originals).
    function _snapshotDataset(ds) {
        if (!ds) return null;
        var n = (ds.t || []).length;
        var snap = {
            t: _copy(ds.t || []),
            p: _isArr(ds.p) ? _copy(ds.p) : null,
            q: _isArr(ds.q) ? _copy(ds.q) : null
        };
        if (_isArr(ds.period)) snap.period = _copy(ds.period);
        if (ds.phases) {
            snap.phases = {
                oil:   _isArr(ds.phases.oil)   ? _copy(ds.phases.oil)   : null,
                gas:   _isArr(ds.phases.gas)   ? _copy(ds.phases.gas)   : null,
                water: _isArr(ds.phases.water) ? _copy(ds.phases.water) : null
            };
        }
        // Carry other top-level keys: parallel arrays are copied, other
        // arrays (derived, e.g. detected periods) are dropped, scalars and
        // small objects (name, source, units, …) are kept.
        for (var k in ds) {
            if (!Object.prototype.hasOwnProperty.call(ds, k)) continue;
            if (snap[k] !== undefined || DERIVED_KEYS[k]) continue;
            if (k === 't' || k === 'p' || k === 'q' || k === 'period' || k === 'phases') continue;
            var v = ds[k];
            if (_isArr(v)) { if (v.length === n) snap[k] = _copy(v); continue; }
            try { snap[k] = v; } catch (e) { /* ignore */ }
        }
        return snap;
    }

    // Slice helper — produces a new object with .slice(i_start, i_end)
    // applied to every parallel array. Indices are inclusive at i_start,
    // exclusive at i_end (matching Array.prototype.slice).
    function _sliceDataset(snap, i_start, i_end) {
        if (!snap) return null;
        var n = snap.t.length;
        var out = { t: snap.t.slice(i_start, i_end) };
        out.p = snap.p ? snap.p.slice(i_start, i_end) : null;
        out.q = snap.q ? snap.q.slice(i_start, i_end) : null;
        if (snap.period) out.period = snap.period.slice(i_start, i_end);
        if (snap.phases) {
            out.phases = {
                oil:   snap.phases.oil   ? snap.phases.oil.slice(i_start, i_end)   : null,
                gas:   snap.phases.gas   ? snap.phases.gas.slice(i_start, i_end)   : null,
                water: snap.phases.water ? snap.phases.water.slice(i_start, i_end) : null
            };
        }
        for (var k in snap) {
            if (!Object.prototype.hasOwnProperty.call(snap, k)) continue;
            if (out[k] !== undefined) continue;
            if (k === 't' || k === 'p' || k === 'q' || k === 'period' || k === 'phases') continue;
            var v = snap[k];
            if (_isArr(v)) { if (v.length === n) out[k] = v.slice(i_start, i_end); continue; }
            try { out[k] = v; } catch (e) {}
        }
        return out;
    }

    // Make ds active through the shared commit path (one
    // 'prism:dataset-loaded' {source:'crop'}), then redraw the active plot.
    function _commit(ds) {
        cropState.owned = ds;
        if (typeof G.PRiSM_commitDataset === 'function') {
            G.PRiSM_commitDataset(ds, { source: 'crop' });
        } else {
            G.PRiSM_dataset = ds;
            _dispatch('prism:dataset-loaded', { source: 'crop', dataset: ds });
        }
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
        // Derive sample indices: keep tStart ≤ t ≤ tEnd (small tolerance for
        // values typed from rounded times).
        var eps = 1e-9 * Math.max(1, Math.abs(tMax - tMin));
        cropState.i_start = _findIndex(t, ts - eps);
        var last = _findIndex(t, te + eps);
        if (t[last] > te + eps) last--;
        cropState.i_end   = last + 1; // exclusive
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

        // Canvas fills its container (down to 200 px on a phone) so the page
        // never scrolls sideways.
        var container = cropState.container;
        var maxW = 800;
        var availW = (container && container.clientWidth) ? container.clientWidth : maxW;
        var cssW = Math.max(200, Math.min(maxW, availW));
        var cssH = cssW < 480 ? 220 : 300;
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

    // Pointer → canvas CSS-pixel x (the layout frame). Scales by the drawn
    // width in case CSS max-width shrank the canvas below its set width.
    function _eventToCanvasX(canvas, ev) {
        if (!canvas || !canvas.getBoundingClientRect) return 0;
        var rect = canvas.getBoundingClientRect();
        var clientX = (ev.clientX != null) ? ev.clientX
                      : (ev.touches && ev.touches[0] ? ev.touches[0].clientX : 0);
        var x = clientX - rect.left;
        var L = cropState.layout;
        if (L && rect.width > 0 && L.cssW > 0 && Math.abs(rect.width - L.cssW) > 0.5) x *= L.cssW / rect.width;
        return x;
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
        if (colorVar === 'green') color = 'color:var(--green, #3fb950);';
        else if (colorVar === 'red') color = 'color:var(--red, #f85149);';
        else color = 'color:var(--text2, #8b949e);';
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

    var INPUT_STYLE = 'width:120px; max-width:100%; padding:4px 6px; background:var(--bg1, #0d1117); color:var(--text, #c9d1d9); ' +
                      'border:1px solid var(--border, #30363d); border-radius:4px; font-family:monospace; font-size:12px;';
    var LABEL_STYLE = 'display:flex; flex-direction:column; gap:3px; font-size:11px; color:var(--text2, #8b949e);';

    G.PRiSM_renderCropTool = function PRiSM_renderCropTool(container) {
        if (!_hasDoc) return;
        if (!container) return;
        cropState.container = container;

        container.innerHTML =
              '<div class="prism-crop-card">'
            +   '<div style="font-size:12px; color:var(--text2, #8b949e); margin-bottom:10px; line-height:1.5;">'
            +     'Drag across the chart to choose the part of the record to keep, or type the limits. '
            +     '<b style="color:var(--text, #c9d1d9);">Confirm crop</b> makes it the active dataset; '
            +     '<b style="color:var(--text, #c9d1d9);">Reset</b> brings the full record back.'
            +   '</div>'
            +   '<canvas id="prism_crop_canvas" width="800" height="300" aria-label="Crop chart: drag to select the time window" '
            +     'style="display:block; width:100%; max-width:100%; background:var(--bg1, #0d1117); border:1px solid var(--border, #30363d); '
            +     'border-radius:6px; touch-action:none;"></canvas>'
            +   '<div class="prism-crop-controls" style="margin-top:10px; display:flex; flex-wrap:wrap; gap:10px; align-items:flex-end;">'
            +     '<label style="' + LABEL_STYLE + '">t start (h)'
            +       '<input type="number" id="prism_crop_tstart" step="0.001" style="' + INPUT_STYLE + '"></label>'
            +     '<label style="' + LABEL_STYLE + '">t end (h)'
            +       '<input type="number" id="prism_crop_tend" step="0.001" style="' + INPUT_STYLE + '"></label>'
            +     '<label style="' + LABEL_STYLE + '">first row'
            +       '<input type="number" id="prism_crop_istart" min="0" step="1" style="' + INPUT_STYLE.replace('120px', '90px') + '"></label>'
            +     '<label style="' + LABEL_STYLE + '">last row (excl.)'
            +       '<input type="number" id="prism_crop_iend" min="0" step="1" style="' + INPUT_STYLE.replace('120px', '90px') + '"></label>'
            +     '<button id="prism_crop_apply" type="button" class="btn btn-primary" style="padding:8px 14px; font-size:12px;">Confirm crop</button>'
            +     '<button id="prism_crop_reset" type="button" class="btn btn-secondary" style="padding:8px 14px; font-size:12px;">Reset</button>'
            +     '<span id="prism_crop_msg" role="status" aria-live="polite" style="font-size:12px; color:var(--text2, #8b949e);"></span>'
            +   '</div>'
            +   '<pre id="prism_crop_preview" '
            +     'style="margin-top:12px; padding:10px; background:var(--bg1, #0d1117); color:var(--text, #c9d1d9); '
            +     'border:1px solid var(--border, #30363d); border-radius:6px; font-size:11px; '
            +     'font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace; '
            +     'max-height:240px; overflow:auto; white-space:pre; max-width:100%;">'
            +     'No dataset loaded yet.'
            +   '</pre>'
            + '</div>';

        cropState.canvas = container.querySelector ? container.querySelector('#prism_crop_canvas') : _byId('prism_crop_canvas');
        _wireCanvasEvents(cropState.canvas);
        _wireInputs();

        // Keep the snapshot while the active dataset is still the one this
        // tool set (a re-render of the Data tab must not lose "Reset").
        if (!(cropState.fullDataset && cropState.owned && G.PRiSM_dataset === cropState.owned)) {
            cropState.fullDataset = null;
            cropState.owned = null;
        }
        _ensureSnapshot();
        if (cropState.fullDataset) {
            _normaliseBounds();
            _syncInputs();
            _drawCropChart();
            _renderPreviewBlock();
        }

        // Repaint on window resize so the canvas keeps filling its container.
        if (_hasWin && !cropState._resizeWired && G.addEventListener) {
            G.addEventListener('resize', function () {
                if (cropState.fullDataset && cropState.canvas && cropState.canvas.isConnected !== false) {
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
        _commit(cropped);
        _syncInputs();
        _drawCropChart();
        _renderPreviewBlock();
        _dispatchCropEvent(from, cropped);
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
        var t = snap.t;
        cropState.t_start = t[0];
        cropState.t_end   = t[t.length - 1];
        cropState.i_start = 0;
        cropState.i_end   = t.length;
        _commit(restored);
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

    function _dispatch(type, detail) {
        if (!_hasWin || typeof G.dispatchEvent !== 'function') return;
        try {
            var ev = null;
            if (typeof CustomEvent === 'function') ev = new CustomEvent(type, { detail: detail });
            else if (_hasDoc && document.createEvent) {
                ev = document.createEvent('CustomEvent');
                ev.initCustomEvent(type, false, false, detail);
            }
            if (ev) G.dispatchEvent(ev);
        } catch (e) { /* ignore */ }
    }

    function _dispatchCropEvent(from, to) {
        _dispatch('prism:dataset-cropped', {
            from: from, to: to, t_start: cropState.t_start, t_end: cropState.t_end,
            i_start: cropState.i_start, i_end: cropState.i_end
        });
    }

    // A dataset loaded from anywhere else starts a new snapshot; our own
    // commits (source 'crop') keep it.
    function _forgetSnapshot() {
        cropState.fullDataset = null;
        cropState.owned = null;
        cropState.t_start = cropState.t_end = null;
        cropState.i_start = cropState.i_end = null;
    }

    function _connected() {
        var c = cropState.container;
        return !!(c && c.isConnected !== false);
    }

    if (_hasWin && G.addEventListener) {
        G.addEventListener('prism:dataset-loaded', function (ev) {
            var d = ev && ev.detail;
            if (d && d.source === 'crop') return;
            _forgetSnapshot();
            if (cropState.container && _connected()) {
                _ensureSnapshot();
                if (cropState.fullDataset) {
                    _normaliseBounds();
                    _syncInputs();
                    _drawCropChart();
                }
                _renderPreviewBlock();
            }
        });
        G.addEventListener('prism:dataset-cleared', function () {
            _forgetSnapshot();
            if (cropState.container && _connected()) _renderPreviewBlock();
        });
    }


    // ═══════════════════════════════════════════════════════════════
    // SECTION 9 — TAB 1 PANEL (C7 registry)
    // ═══════════════════════════════════════════════════════════════
    // Mounted by PRiSM_renderTab(1) after the Data tab, below the Well &
    // Test card (order 10). No wrapping of other renderers, no timers.

    var CROP_PANEL = {
        id: 'crop',
        title: 'Crop & trim the record',
        order: 30,
        render: function (host) {
            if (!_hasDoc || !host) return;
            host.innerHTML = '';
            var box = document.createElement('div');
            box.id = 'prism_crop_tool_host';
            box.className = 'prism-crop-tool';
            host.appendChild(box);
            G.PRiSM_renderCropTool(box);
        }
    };

    (function _registerPanel() {
        if (!_hasWin) return;
        if (typeof G.PRiSM_registerTabPanel === 'function') {
            try { G.PRiSM_registerTabPanel(1, CROP_PANEL); return; } catch (e) { /* fall through */ }
        }
        G.PRiSM_tabPanels = G.PRiSM_tabPanels || {};
        var list = G.PRiSM_tabPanels[1] = G.PRiSM_tabPanels[1] || [];
        for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].id === CROP_PANEL.id) { list[i] = CROP_PANEL; return; }
        }
        list.push(CROP_PANEL);
    })();


    // ═══════════════════════════════════════════════════════════════
    // SECTION 10 — SELF-TEST
    // ═══════════════════════════════════════════════════════════════
    // === SELF-TEST ===
    (function PRiSM_cropSelfTest() {
        var log = (typeof console !== 'undefined' && console.log) ? console.log.bind(console) : function () {};
        var err = (typeof console !== 'undefined' && console.error) ? console.error.bind(console) : function () {};
        var checks = [];
        var prevDS = G.PRiSM_dataset;
        var prevState = { full: cropState.fullDataset, owned: cropState.owned, ts: cropState.t_start, te: cropState.t_end,
                          is: cropState.i_start, ie: cropState.i_end };

        // Test 1: applyCrop slices by absolute time and replaces the dataset.
        try {
            var t = [], p = [], q = [];
            for (var i2 = 0; i2 < 100; i2++) { t.push(i2); p.push(2000 + i2); q.push(500); }
            G.PRiSM_dataset = { t: t.slice(), p: p.slice(), q: q.slice(), name: 'x', periods: [{ t0: 0, t1: 99 }] };
            _forgetSnapshot();
            var res = G.PRiSM_applyCrop(25, 74);
            var n = res && res.t ? res.t.length : 0;
            checks.push({ name: 'applyCrop slices to expected range',
                ok: res && res.t[0] === 25 && res.t[n - 1] === 74 && G.PRiSM_dataset === res && n === 50 });
            checks.push({ name: 'applyCrop keeps scalars, drops derived periods',
                ok: res && res.name === 'x' && res.periods === undefined });
            checks.push({ name: 'applyCrop preserves snapshot of full dataset',
                ok: cropState.fullDataset && cropState.fullDataset.t.length === 100 });
        } catch (e) {
            checks.push({ name: 'applyCrop slices to expected range', ok: false, msg: e && e.message });
        }

        // Test 2: getCropPreview returns first/last + valid stats.
        try {
            var t3 = [], p3 = [], q3 = [];
            for (var i3 = 0; i3 < 50; i3++) { t3.push(i3 * 0.1); p3.push(1000 + i3 * 2); q3.push(100); }
            G.PRiSM_dataset = { t: t3, p: p3, q: q3 };
            _forgetSnapshot();
            G.PRiSM_applyCrop(1.0, 3.0);
            var prev = G.PRiSM_getCropPreview();
            checks.push({ name: 'getCropPreview returns first/last + stats',
                ok: prev && prev.firstRows.length === 3 && prev.lastRows.length === 3 && prev.n === 21 &&
                    Math.abs(prev.tSpan.delta - 2.0) < 1e-6 && prev.pRange && prev.pRange.range > 0 });
        } catch (e) {
            checks.push({ name: 'getCropPreview returns first/last + stats', ok: false, msg: e && e.message });
        }

        // Test 3: resetCrop restores the full snapshot; rate-only data works.
        try {
            var t4 = [], q4 = [];
            for (var i4 = 0; i4 < 30; i4++) { t4.push(i4); q4.push(900 - i4); }
            G.PRiSM_dataset = { t: t4.slice(), p: null, q: q4.slice() };
            _forgetSnapshot();
            G.PRiSM_applyCrop(5, 20);
            var beforeReset = G.PRiSM_dataset.t.length;
            G.PRiSM_resetCrop();
            checks.push({ name: 'resetCrop restores full snapshot (rate-only data)',
                ok: beforeReset === 16 && G.PRiSM_dataset.t.length === 30 && G.PRiSM_dataset.p === null });
        } catch (e) {
            checks.push({ name: 'resetCrop restores full snapshot', ok: false, msg: e && e.message });
        }

        // Test 4: the crop panel is registered for Tab 1.
        var reg = G.PRiSM_tabPanels && G.PRiSM_tabPanels[1];
        checks.push({ name: 'crop panel registered on Tab 1',
            ok: !_hasWin || !!(reg && reg.some(function (s) { return s && s.id === 'crop'; })) });

        G.PRiSM_dataset = prevDS;
        cropState.fullDataset = prevState.full; cropState.owned = prevState.owned;
        cropState.t_start = prevState.ts; cropState.t_end = prevState.te;
        cropState.i_start = prevState.is; cropState.i_end = prevState.ie;

        var fails = checks.filter(function (c) { return !c.ok; });
        if (fails.length) {
            err('PRiSM data-crop self-test FAILED:', fails);
        } else {
            log('✓ data-crop self-test passed (' + checks.length + ' checks).');
        }
    })();

})();
