// =============================================================================
// WTS — 49-calc-wp-view.js  (Round 9; helper module: no page in window.WTS_calcRegistry)
// -----------------------------------------------------------------------------
// Well Performance views (WP9; docs/WELL-PERFORMANCE-PLAN.md §2.7, §10 and the owner GUI requirement of 2026-11-11): the
// interactive canvas plotter and the deviated-well schematic used by the page 49-calc-wellperf.js. Pure drawing code: no
// storage, no engines, no timers, no polling, no function wrapping. Field units come in; the page converts to the display
// system before it hands data over (axis labels are given by the page).
//
//   WTS_wp_view.chart(canvas, spec)      draw (and keep) a plot on a canvas; returns the canvas state
//       spec = {key, aspect, minH, maxH, w (fallback width when the canvas is not laid out),
//               x:{label, log, min, max, fmt}, y:{label, log, invert, min, max, fmt}, x2:{label, min, max, fmt} (top axis),
//               series:[{key, label, color, pts:[[x, y]], width, dash, kind:'line'|'points'|'area'|'poly', axis:'x2', legend:false, fill}],
//               ('poly' (B, WP27): a closed polygon filled at s.alpha (default 0.16), outlined only when s.width > 0 — e.g. the operating
//               window between the wellhead deliverability and the flowline back-pressure curves)
//               bands:[{x0, x1, color, label}] (vertical shading), hbands:[{y0, y1, color, label}] (horizontal strips at the
//               left edge, e.g. flow-pattern bands along depth), vlines:[{x, color, label, dash}], hlines:[{y, color, label, dash}],
//               markers:[{x, y, kind:'filled'|'hollow'|'diamond', color, label, r}] (labels laid out without overlaps),
//               legendNote (one muted line under the legend, e.g. that faint curves come from the previous inputs),
//               handles:[{key, kind:'point'|'railY'|'railX'|'pointX'|'lineX', x, y, value, min, max, step, label, color, fmt(v),
//                         rail:[f0, f1]}],
//               ('pointX' (A2, WP13): a handle at x = value on the plot (y = h.y, else the bottom of the plot) dragged along x, with a
//               dashed guide line across the plot — e.g. the bubble point on the fluid-property plot;
//               'lineX' (A2, WP18): a vertical line at x = value, dragged along x — e.g. the gas-lift injection rate)
//               readout:'x'|'y'|'near' (crosshair interpolation along x or along y; 'near' = the nearest point of a series with
//               info:[string | [strings]] per point, WP12), empty:'message when there is nothing to draw',
//               onHandle(key, value, phase 'move'|'end'), onLegend(hiddenMap), hidden:{seriesKey:true} (initial)}
//       Interaction (installed once per canvas): crosshair readout; wheel and pinch zoom at the pointer; drag to pan; double
//       click (or the 0 key) resets; legend items toggle their series; handles drag (pointer) or step with the keyboard
//       ([ / ] pick a handle, arrow keys move it, Enter commits); +/- zoom and the arrow keys pan when no handle is picked.
//       canvas._wpAxes = {toX, toY, fromX, fromY, plot} like PRiSM's _prismAxes (C6).
//   WTS_wp_view.redraw(canvas)           redraw with the kept spec (resize, theme)
//   WTS_wp_view.schematic(S, o)          deviated-well schematic → {svg, pts:[{x, y, md, tvd, i}], width, height}
//       S = WTS_wp_well.schematic(W, R) result: {trajectory:[{md, tvd, dep, n, e, inc, azi}], strings[], restrictions[],
//            perfs:{topMd, botMd, midMd}, gauges[], choke, profile[{md, tvd, p, t, hl, vm, pattern}]};
//       o = {prop:'pressure'|'temperature'|'holdup'|'velocity'|'pattern'|'heatloss' (A2: fluid − earth)|'none', fmt:{p, t, md, vm},
//            labels, width, height}. Temperature colouring also paints the formation along the hole by the static earth temperature
//            (profile te, A2) on the same scale, so the relaxation (heat lost to the earth) reads as the colour step.
//       Side view (vertical section: TVD against horizontal departure, equal scale) with the strings drawn along the path, the
//       flow path coloured by the chosen property (a heat map along the well), restrictions, perforations, mid-perf, gauges,
//       wellhead and choke; plan view (north against east) and the colour bar on the right. Components carry data-comp
//       ("string:i", "restr:i", "perf", "gauge:i", "choke", "wellhead") for click-to-edit.
//   WTS_wp_view.colorFor(prop, v, lo, hi) / .PATTERN_COLORS / .scale(prop)   the colour maps (also used by the traverse bands)
//   WTS_wp_view.interp(path, md)         {x, y, ang} on a polyline of {md, x, y} (exported for tests)
// =============================================================================
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;

    function _fin(v) { return typeof v === 'number' && isFinite(v); }
    function _clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
    function _esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

    // ── theme (host CSS variables; the app is dark, a light theme would follow the same variables) ─────────────
    function _theme() {
        var T = { bg: '#0d1117', panel: '#161b22', grid: 'rgba(139,148,158,0.16)', axis: '#3d444d', text: '#e6edf3', text2: '#8b949e',
                  accent: '#f0883e', green: '#3fb950', blue: '#58a6ff', purple: '#bc8cff', red: '#f85149', yellow: '#d29922', focus: '#58a6ff' };
        try {
            if (typeof document !== 'undefined' && typeof getComputedStyle === 'function' && document.documentElement) {
                var cs = getComputedStyle(document.documentElement);
                var map = { bg: '--bg1', panel: '--bg2', axis: '--border-light', text: '--text', text2: '--text2', accent: '--accent',
                            green: '--green', blue: '--blue', purple: '--purple', red: '--red', yellow: '--yellow', focus: '--focus' };
                Object.keys(map).forEach(function (k) {
                    var v = cs && cs.getPropertyValue ? String(cs.getPropertyValue(map[k]) || '').trim() : '';
                    if (v) T[k] = v;
                });
            }
        } catch (e) { /* defaults */ }
        return T;
    }

    // ── colour maps ───────────────────────────────────────────────────────────
    // A perceptually ordered ramp that reads on the dark panels (deep blue → teal → green → yellow → orange → red).
    var RAMP = [[0, [49, 54, 149]], [0.18, [43, 131, 186]], [0.36, [32, 178, 170]], [0.54, [120, 198, 121]], [0.7, [230, 210, 90]],
                [0.85, [244, 140, 60]], [1, [215, 48, 39]]];
    var PATTERN_COLORS = { single: '#8b949e', liquid: '#58a6ff', bubble: '#58a6ff', slug: '#bc8cff', intermittent: '#bc8cff', churn: '#f0883e',
                           transition: '#f0883e', annular: '#3fb950', mist: '#3fb950', distributed: '#58a6ff', segregated: '#d29922',
                           stratified: '#d29922', gas: '#e6edf3', unknown: '#6e7681' };
    function _ramp(f) {
        f = _clamp(_fin(f) ? f : 0, 0, 1);
        for (var i = 1; i < RAMP.length; i++) {
            if (f <= RAMP[i][0]) {
                var a = RAMP[i - 1], b = RAMP[i], t = (f - a[0]) / (b[0] - a[0]);
                return 'rgb(' + [0, 1, 2].map(function (k) { return Math.round(a[1][k] + t * (b[1][k] - a[1][k])); }).join(',') + ')';
            }
        }
        return 'rgb(215,48,39)';
    }
    function _patternKey(p) {
        var s = String(p == null ? '' : p).toLowerCase();
        for (var k in PATTERN_COLORS) if (Object.prototype.hasOwnProperty.call(PATTERN_COLORS, k) && s.indexOf(k) !== -1) return k;
        return 'unknown';
    }
    function colorFor(prop, v, lo, hi) {
        if (prop === 'pattern') return PATTERN_COLORS[_patternKey(v)];
        if (!_fin(v)) return '#6e7681';
        var f = (hi > lo) ? (v - lo) / (hi - lo) : 0.5;
        return _ramp(f);
    }

    // ── ticks ─────────────────────────────────────────────────────────────────
    function _nice(span, n) {
        var raw = span / Math.max(1, n), p = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10)), m = raw / p;
        return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
    }
    function _ticks(a, b, n, log) {
        var out = [];
        if (!(b > a)) return out;
        if (log) {
            for (var e = Math.floor(Math.log(a) / Math.LN10); e <= Math.ceil(Math.log(b) / Math.LN10); e++) {
                [1, 2, 5].forEach(function (m) { var v = m * Math.pow(10, e); if (v >= a * 0.999 && v <= b * 1.001) out.push(v); });
            }
            return out;
        }
        var st = _nice(b - a, n), v0 = Math.ceil(a / st - 1e-9) * st;
        for (var v = v0; v <= b + st * 1e-9 && out.length < 40; v += st) out.push(Math.abs(v) < st * 1e-9 ? 0 : v);
        return out;
    }
    function _fmtTick(v) {
        var a = Math.abs(v);
        if (a >= 1e5) return (v / 1000).toFixed(0) + 'k';
        if (a >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
        if (a >= 10) return String(Math.round(v * 10) / 10);
        if (a >= 1) return String(Math.round(v * 100) / 100);
        return String(Math.round(v * 1000) / 1000);
    }

    // ── chart ─────────────────────────────────────────────────────────────────
    function _dpr() { var d = (typeof G.devicePixelRatio === 'number' && G.devicePixelRatio > 0) ? G.devicePixelRatio : 1; return Math.min(2, Math.max(1, d)); }
    function _extent(sp, hidden, axis) {
        var lo = Infinity, hi = -Infinity;
        (sp.series || []).forEach(function (s) {
            if (hidden[s.key] || (axis === 'x2') !== (s.axis === 'x2')) return;
            (s.pts || []).forEach(function (p) {
                var v = (axis === 'y') ? p[1] : p[0];
                if (_fin(v) && (!(sp[axis === 'x2' ? 'x2' : axis] || {}).log || v > 0)) { if (v < lo) lo = v; if (v > hi) hi = v; }
            });
        });
        if (axis !== 'x2') (sp.markers || []).forEach(function (m) { var v = axis === 'y' ? m.y : m.x; if (_fin(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } });
        return [lo, hi];
    }
    function _range(ax, ext, padFrac) {
        var lo = _fin(ax.min) ? ax.min : ext[0], hi = _fin(ax.max) ? ax.max : ext[1];
        if (!_fin(lo) || !_fin(hi)) { lo = ax.log ? 1 : 0; hi = ax.log ? 10 : 1; }
        if (hi <= lo) { hi = lo + (Math.abs(lo) || 1) * 0.1; lo = lo - (Math.abs(lo) || 1) * 0.1; }
        if (ax.log) { lo = Math.max(lo, 1e-6); if (!_fin(ax.min)) lo = lo / 1.25; if (!_fin(ax.max)) hi = hi * 1.25; return [lo, hi]; }
        var pad = (hi - lo) * (padFrac == null ? 0.05 : padFrac);
        if (!_fin(ax.min)) lo = (lo >= 0 && lo - pad < 0) ? 0 : lo - pad;
        if (!_fin(ax.max)) hi = hi + pad;
        return [lo, hi];
    }

    function chart(cv, spec) {
        if (!cv) return null;
        var st = cv._wp;
        if (!st) { st = cv._wp = { view: null, hidden: {}, key: null, hover: null, drag: null, focusHandle: -1, ptrs: {} }; _bind(cv); }
        if (st.key !== spec.key) { st.view = null; st.key = spec.key; st.hidden = {}; if (spec.hidden) Object.keys(spec.hidden).forEach(function (k) { st.hidden[k] = !!spec.hidden[k]; }); }
        st.spec = spec;
        // touch-action must be set before the gesture starts: none while the plot has drag handles (the drag and the pinch are
        // handled here), pan-y otherwise so the page scrolls over a plot without handles
        if (cv.style) cv.style.touchAction = (spec.handles && spec.handles.length) ? 'none' : 'pan-y';
        _draw(cv);
        return st;
    }
    var WHEEL_HINT = 'Ctrl + wheel to zoom (or click the plot first)';
    function redraw(cv) { if (cv && cv._wp && cv._wp.spec) _draw(cv); }

    function _draw(cv) {
        var st = cv._wp, sp = st.spec, T = _theme();
        var cw = (cv.clientWidth > 200) ? cv.clientWidth : (sp.w || 640);
        cw = Math.min(cw, 1600);
        var ch = Math.round(_clamp(cw * (sp.aspect || 0.62), sp.minH || 220, sp.maxH || 560));
        var dpr = _dpr(), W = Math.round(cw * dpr), H = Math.round(ch * dpr);
        if (cv.width !== W) cv.width = W;
        if (cv.height !== H) cv.height = H;
        var ctx = cv.getContext && cv.getContext('2d');
        if (!ctx) return;
        if (ctx.setTransform) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        var narrow = cw < 460;
        var font = function (px, w) { return (w || '') + ' ' + (narrow ? Math.max(9, px - 1) : px) + 'px -apple-system, Segoe UI, Roboto, sans-serif'; };
        var hasTop = (sp.handles || []).some(function (h) { return h.kind === 'railX'; });
        var hasRight = (sp.handles || []).some(function (h) { return h.kind === 'railY'; });
        var m = { l: narrow ? 56 : 60, r: hasRight ? (narrow ? 40 : 52) : 14, t: 14 + (hasTop ? 34 : 0) + (sp.x2 ? 26 : 0), b: narrow ? 38 : 44 };
        var P = { x: m.l, y: m.t, w: Math.max(40, cw - m.l - m.r), h: Math.max(40, ch - m.t - m.b) };
        ctx.fillStyle = T.bg; ctx.fillRect(0, 0, cw, ch);

        var hidden = st.hidden, xa = sp.x || {}, ya = sp.y || {}, x2a = sp.x2 || null;
        var lock = (st.drag && st.drag.handle != null && st.lastR) ? st.lastR : null;    // a handle drag keeps the axes still
        var xr = st.view ? [st.view.x0, st.view.x1] : (lock ? lock.xr : _range(xa, _extent(sp, hidden, 'x'), 0.03));
        var yr = st.view ? [st.view.y0, st.view.y1] : (lock ? lock.yr : _range(ya, _extent(sp, hidden, 'y'), 0.06));
        var x2r = x2a ? (st.view && st.view.x20 != null ? [st.view.x20, st.view.x21] : (lock && lock.x2r ? lock.x2r : _range(x2a, _extent(sp, hidden, 'x2'), 0.05))) : null;
        st.lastR = { xr: xr, yr: yr, x2r: x2r };
        var L = function (v, log) { return log ? Math.log(v) / Math.LN10 : v; }, IL = function (v, log) { return log ? Math.pow(10, v) : v; };
        var toX = function (v) { return P.x + (L(v, xa.log) - L(xr[0], xa.log)) / (L(xr[1], xa.log) - L(xr[0], xa.log)) * P.w; };
        var fromX = function (px) { return IL(L(xr[0], xa.log) + (px - P.x) / P.w * (L(xr[1], xa.log) - L(xr[0], xa.log)), xa.log); };
        var toY = function (v) { var f = (L(v, ya.log) - L(yr[0], ya.log)) / (L(yr[1], ya.log) - L(yr[0], ya.log)); return ya.invert ? P.y + f * P.h : P.y + P.h - f * P.h; };
        var fromY = function (py) { var f = ya.invert ? (py - P.y) / P.h : (P.y + P.h - py) / P.h; return IL(L(yr[0], ya.log) + f * (L(yr[1], ya.log) - L(yr[0], ya.log)), ya.log); };
        var toX2 = x2r ? function (v) { return P.x + (v - x2r[0]) / (x2r[1] - x2r[0]) * P.w; } : null;
        var fromX2 = x2r ? function (px) { return x2r[0] + (px - P.x) / P.w * (x2r[1] - x2r[0]); } : null;
        cv._wpAxes = { toX: toX, toY: toY, fromX: fromX, fromY: fromY, toX2: toX2, fromX2: fromX2, plot: P, plotKey: sp.key, xr: xr, yr: yr, x2r: x2r, w: cw, h: ch };

        // panel + grid
        ctx.fillStyle = T.panel; ctx.fillRect(P.x, P.y, P.w, P.h);
        ctx.lineWidth = 1; ctx.strokeStyle = T.grid; ctx.font = font(11); ctx.fillStyle = T.text2;
        var xt = _ticks(xr[0], xr[1], narrow ? 4 : 7, xa.log), yt = _ticks(yr[0], yr[1], narrow ? 5 : 7, ya.log);
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        xt.forEach(function (v) { var x = toX(v); ctx.beginPath(); ctx.moveTo(x, P.y); ctx.lineTo(x, P.y + P.h); ctx.stroke(); ctx.fillText((xa.fmt || _fmtTick)(v), x, P.y + P.h + 5); });
        ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        yt.forEach(function (v) { var y = toY(v); ctx.beginPath(); ctx.moveTo(P.x, y); ctx.lineTo(P.x + P.w, y); ctx.stroke(); ctx.fillText((ya.fmt || _fmtTick)(v), P.x - 6, y); });
        if (x2r) {
            ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
            _ticks(x2r[0], x2r[1], narrow ? 4 : 6, false).forEach(function (v) { ctx.fillText((x2a.fmt || _fmtTick)(v), toX2(v), P.y - 4); });
        }

        ctx.save();
        ctx.beginPath(); ctx.rect(P.x, P.y, P.w, P.h); if (ctx.clip) ctx.clip();
        // vertical bands (e.g. the unstable range q < q_s)
        (sp.bands || []).forEach(function (b) {
            var x0 = toX(_clamp(b.x0, xr[0], xr[1])), x1 = toX(_clamp(b.x1, xr[0], xr[1]));
            if (!(x1 > x0)) return;
            ctx.fillStyle = b.color || 'rgba(248,81,73,0.10)'; ctx.fillRect(x0, P.y, x1 - x0, P.h);
            // the band label sits at the bottom of the band, clear of the vertical-line labels that run down from the top
            if (b.label && x1 - x0 > 50) { ctx.fillStyle = T.text2; ctx.font = font(10); ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(b.label, x0 + 5, P.y + P.h - (st.view ? 16 : 5)); }
        });
        // horizontal strips at the left edge (flow-pattern bands along depth)
        (sp.hbands || []).forEach(function (b) {
            var y0 = toY(b.y0), y1 = toY(b.y1), top = Math.min(y0, y1), hh = Math.abs(y1 - y0);
            if (!(hh > 0)) return;
            ctx.fillStyle = b.color; ctx.globalAlpha = 0.85; ctx.fillRect(P.x, top, 10, hh); ctx.globalAlpha = 0.07; ctx.fillRect(P.x + 10, top, P.w - 10, hh); ctx.globalAlpha = 1;
        });
        // legend box placed first (auto: the plot corner with the fewest curve points, markers and handles under it), so the
        // vertical-line labels can keep clear of it
        var legBox = _legendPlace(ctx, sp, hidden, P, toX, toY, font);
        st.legBox = legBox;
        // vertical lines; their rotated labels run down from the top and are staggered (never within 14 px of each other in x while
        // overlapping in y), kept off the legend box and the point-handle labels
        var vl = (sp.vlines || []).filter(function (l) { return _fin(l.x) && l.x >= xr[0] && l.x <= xr[1]; }).map(function (l) { return { l: l, x: toX(l.x) }; }).sort(function (a, b) { return a.x - b.x; });
        var obst = [];
        if (legBox) obst.push(legBox);
        // label layout (review fix: the labels near a plot corner overlapped): the lineX handle labels first (top of the plot), then
        // every marker label tries the preferred side above the marker, the other side, below, then stacked further up; the vertical
        // line labels below keep clear of all of them
        var rHit = function (a, b) { return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0; };
        var hLabs = [];
        ctx.font = font(10, '700');
        (sp.handles || []).forEach(function (h) {
            if (h.kind !== 'lineX' || !_fin(h.value)) return;
            var t = h.label + ' ' + (h.fmt ? h.fmt(h.value) : _fmtTick(h.value)), tw0 = (ctx.measureText ? ctx.measureText(t).width : t.length * 6) + 10;
            var hx0 = _clamp(toX(h.value), P.x, P.x + P.w), tx0 = (hx0 + 13.5 + tw0 > P.x + P.w) ? hx0 - 13.5 - tw0 : hx0 + 13.5;
            hLabs.push({ x0: tx0, x1: tx0 + tw0, y0: P.y + 4, y1: P.y + 20 });
        });
        // the marker symbols themselves (with their halo) and the lineX knobs are obstacles for every label too
        var mSyms = [];
        (sp.markers || []).forEach(function (mk, i) { if (_fin(mk.x) && _fin(mk.y) && (mk.r || 6) >= 2) { var mx = toX(mk.x), my = toY(mk.y), rr = (mk.r || 6) + (mk.kind === 'filled' && mk.halo !== false ? 6 : 2); mSyms.push({ x0: mx - rr, x1: mx + rr, y0: my - rr, y1: my + rr, i: i }); } });
        (sp.handles || []).forEach(function (h) { if (h.kind === 'lineX' && _fin(h.value)) { var kx = _clamp(toX(h.value), P.x, P.x + P.w); mSyms.push({ x0: kx - 11, x1: kx + 11, y0: P.y + 1, y1: P.y + 23, i: -1 }); } });
        var mLabs = st.mlabels = [], occ = obst.concat(hLabs, mSyms);
        ctx.font = font(11, '700');
        (sp.markers || []).forEach(function (mk, i) {
            if (!mk.label || !_fin(mk.x) || !_fin(mk.y)) return;
            var x = toX(mk.x), y = toY(mk.y), r = mk.r || 6, tw0 = (ctx.measureText ? ctx.measureText(mk.label).width : 60) + 8;
            var right = x > P.x + P.w * 0.7, R0 = { x0: x + r + 2, x1: x + r + 2 + tw0 }, L0 = { x0: x - r - tw0 - 2, x1: x - r - 2 };
            var sides = right ? [L0, R0] : [R0, L0], cand = [];
            sides.forEach(function (sd) { cand.push({ x0: sd.x0, x1: sd.x1, y0: y - r - 18, y1: y - r - 2 }); });
            sides.forEach(function (sd) { cand.push({ x0: sd.x0, x1: sd.x1, y0: y + r + 2, y1: y + r + 18 }); });
            for (var k = 1; k <= 6; k++) {
                sides.forEach(function (sd) { cand.push({ x0: sd.x0, x1: sd.x1, y0: y - r - 18 - 18 * k, y1: y - r - 2 - 18 * k }); });
                sides.forEach(function (sd) { cand.push({ x0: sd.x0, x1: sd.x1, y0: y + r + 2 + 18 * k, y1: y + r + 18 + 18 * k }); });
            }
            // inside the plot (a candidate past an edge is shifted in), then the first without an overlap, else the least overlap
            var area = function (q) { return occ.reduce(function (t, o) { return t + (o.i !== i && rHit(q, o) ? (Math.min(q.x1, o.x1) - Math.max(q.x0, o.x0)) * (Math.min(q.y1, o.y1) - Math.max(q.y0, o.y0)) : 0); }, 0); };
            var pick = null, best = null;
            for (var c = 0; c < cand.length && !pick; c++) {
                var q0 = cand[c], dx = Math.max(0, P.x + 1 - q0.x0) - Math.max(0, q0.x1 - (P.x + P.w - 1));
                if (q0.y0 < P.y + 1 || q0.y1 > P.y + P.h - 1) continue;
                var q = { x0: q0.x0 + dx, x1: q0.x1 + dx, y0: q0.y0, y1: q0.y1 }, a0 = area(q);
                if (a0 === 0) pick = q; else if (!best || a0 < best.a) best = { q: q, a: a0 };
            }
            if (!pick) pick = best ? best.q : { x0: _clamp(cand[0].x0, P.x + 1, P.x + P.w - tw0 - 1), x1: 0, y0: _clamp(cand[0].y0, P.y + 1, P.y + P.h - 17), y1: 0 };
            if (!pick.x1) { pick.x1 = pick.x0 + tw0; pick.y1 = pick.y0 + 16; }
            pick.i = i; pick.label = mk.label;
            mLabs.push(pick); occ.push(pick);
        });
        var obstBase = obst.slice();
        obst = obst.concat(hLabs, mLabs, mSyms);
        (sp.handles || []).forEach(function (h) { if (h.kind === 'point' && _fin(h.x) && _fin(h.value)) { var hx0 = toX(h.x), hy0 = toY(h.value); obst.push({ x0: hx0, x1: hx0 + 150, y0: hy0 - 24, y1: hy0 + 2 }); } });
        var placed = st.vlabels = [];
        ctx.font = font(10, '600');
        vl.forEach(function (it) {
            var l = it.l, x = it.x;
            ctx.strokeStyle = l.color || T.text2; ctx.lineWidth = 1.2; if (ctx.setLineDash) ctx.setLineDash(l.dash || [5, 4]);
            ctx.beginPath(); ctx.moveTo(x, P.y); ctx.lineTo(x, P.y + P.h); ctx.stroke(); if (ctx.setLineDash) ctx.setLineDash([]);
            if (!l.label) return;
            var tw = (ctx.measureText ? ctx.measureText(l.label).width : l.label.length * 6) + 4, ys = P.y + 8, guard = 0, moved = true;
            // the label runs on the left of its line, or on the right when the line is too close to the left edge (it would be clipped)
            var lx0 = x - 14 >= P.x + 1 ? x - 14 : x + 1, lx1 = lx0 + 13;
            var hit = function (r) { return lx0 < r.x1 && lx1 > r.x0 && ys < r.y1 && ys + tw > r.y0; };
            var settle = function (os) {
                ys = P.y + 8; guard = 0; moved = true;
                while (moved && guard++ < 20) {
                    moved = false;
                    placed.concat(os).forEach(function (r) { if (hit(r)) { ys = r.y1 + 6; moved = true; } });
                }
                return ys + tw <= P.y + P.h - 4;
            };
            // the marker / handle labels are avoided when there is room (from the top, else at the bottom of the plot); otherwise only
            // the legend and the other line labels
            if (!settle(obst)) {
                ys = P.y + P.h - 4 - tw;
                if (ys < P.y + 4 || placed.concat(obst).some(hit)) settle(obstBase);
            }
            if (ys + tw > P.y + P.h - 4) ys = Math.max(P.y + 4, P.y + P.h - 4 - tw);
            placed.push({ x0: lx0, x1: lx1, y0: ys, y1: ys + tw, label: l.label });
            ctx.save(); ctx.translate(lx0 + 10, ys); ctx.rotate(-Math.PI / 2); ctx.fillStyle = l.color || T.text2; ctx.font = font(10, '600'); ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText(l.label, 0, 0); ctx.restore();
        });
        (sp.hlines || []).forEach(function (l) {
            if (!_fin(l.y)) return;
            var y = toY(l.y);
            ctx.strokeStyle = l.color || T.text2; ctx.lineWidth = 1.2; if (ctx.setLineDash) ctx.setLineDash(l.dash || [5, 4]);
            ctx.beginPath(); ctx.moveTo(P.x, y); ctx.lineTo(P.x + P.w, y); ctx.stroke(); if (ctx.setLineDash) ctx.setLineDash([]);
            if (l.label) { ctx.fillStyle = l.color || T.text2; ctx.font = font(10, '600'); ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText(l.label, P.x + P.w - 6, y - 3); }
        });
        // series
        (sp.series || []).forEach(function (s) {
            if (hidden[s.key]) return;
            var tx = s.axis === 'x2' ? toX2 : toX, pts = (s.pts || []).filter(function (p) { return _fin(p[0]) && _fin(p[1]) && (!xa.log || p[0] > 0) && (!ya.log || p[1] > 0); });
            if (!pts.length || !tx) return;
            ctx.strokeStyle = s.color || T.accent; ctx.fillStyle = s.color || T.accent; ctx.lineWidth = s.width || 2;
            if (s.kind === 'points') {
                pts.forEach(function (p) { ctx.beginPath(); if (ctx.arc) ctx.arc(tx(p[0]), toY(p[1]), s.r || 3.5, 0, Math.PI * 2); ctx.fill(); });
                return;
            }
            if (s.kind === 'poly') {
                if (pts.length < 3) return;
                ctx.beginPath(); pts.forEach(function (p, i) { var x = tx(p[0]), y = toY(p[1]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.closePath();
                ctx.globalAlpha = _fin(s.alpha) ? s.alpha : 0.16; ctx.fill(); ctx.globalAlpha = 1;
                if (s.width > 0) { if (ctx.setLineDash) ctx.setLineDash(s.dash || []); ctx.stroke(); if (ctx.setLineDash) ctx.setLineDash([]); }
                return;
            }
            if (ctx.setLineDash) ctx.setLineDash(s.dash || []);
            ctx.beginPath();
            pts.forEach(function (p, i) { var x = tx(p[0]), y = toY(p[1]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
            if (s.kind === 'area' || s.fill) {
                ctx.stroke(); if (ctx.setLineDash) ctx.setLineDash([]);
                ctx.lineTo(tx(pts[pts.length - 1][0]), ya.invert ? P.y : P.y + P.h); ctx.lineTo(tx(pts[0][0]), ya.invert ? P.y : P.y + P.h); ctx.closePath();
                ctx.globalAlpha = 0.12; ctx.fill(); ctx.globalAlpha = 1;
            } else { ctx.stroke(); if (ctx.setLineDash) ctx.setLineDash([]); }
        });
        // markers
        (sp.markers || []).forEach(function (mk, mi) {
            if (!_fin(mk.x) || !_fin(mk.y)) return;
            var x = toX(mk.x), y = toY(mk.y), r = mk.r || 6;
            ctx.lineWidth = 2.2; ctx.strokeStyle = mk.color || T.accent; ctx.fillStyle = mk.color || T.accent;
            ctx.beginPath();
            if (mk.kind === 'diamond') { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); }
            else if (ctx.arc) ctx.arc(x, y, r, 0, Math.PI * 2);
            if (mk.kind === 'hollow') { ctx.fillStyle = T.panel; ctx.fill(); ctx.stroke(); }
            else { ctx.fill(); ctx.strokeStyle = T.bg; ctx.lineWidth = 1.5; ctx.stroke(); }
            if (mk.kind === 'filled' && mk.halo !== false) { ctx.globalAlpha = 0.25; ctx.beginPath(); if (ctx.arc) ctx.arc(x, y, r + 5, 0, Math.PI * 2); ctx.strokeStyle = mk.color || T.accent; ctx.lineWidth = 3; ctx.stroke(); ctx.globalAlpha = 1; }
            var lb = mk.label ? mLabs.filter(function (q) { return q.i === mi; })[0] : null;
            if (lb) {
                ctx.font = font(11, '700'); ctx.textBaseline = 'bottom'; ctx.textAlign = 'left';
                ctx.fillStyle = T.bg; ctx.globalAlpha = 0.75; ctx.fillRect(lb.x0, lb.y0, lb.x1 - lb.x0, 16); ctx.globalAlpha = 1;
                // a leader from the marker when the label moved away from its corner
                var cy = (lb.y0 + lb.y1) / 2, cx = lb.x1 < x ? lb.x1 : lb.x0;
                if (Math.abs(cy - y) > r + 14) { ctx.strokeStyle = mk.color || T.accent; ctx.globalAlpha = 0.5; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(cx, cy); ctx.stroke(); ctx.globalAlpha = 1; }
                ctx.fillStyle = mk.color || T.accent; ctx.fillText(mk.label, lb.x0 + 4, lb.y0 + 14);
            }
        });
        ctx.restore();

        // frame + axis titles
        ctx.strokeStyle = T.axis; ctx.lineWidth = 1; ctx.strokeRect(P.x + 0.5, P.y + 0.5, P.w - 1, P.h - 1);
        ctx.fillStyle = T.text2; ctx.font = font(11, '600'); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        if (xa.label) ctx.fillText(xa.label, P.x + P.w / 2, ch - 3);
        if (x2a && x2a.label) { ctx.textBaseline = 'bottom'; ctx.fillText(x2a.label, P.x + P.w / 2, P.y - (narrow ? 16 : 18)); }
        if (ya.label) { ctx.save(); ctx.translate(narrow ? 9 : 13, P.y + P.h / 2); ctx.rotate(-Math.PI / 2); ctx.textBaseline = 'middle'; ctx.fillText(ya.label, 0, 0); ctx.restore(); }

        // legend (toggles)
        st.legendHits = [];
        var leg = (sp.series || []).filter(function (s) { return s.legend !== false && s.label; });
        if (leg.length && legBox) {
            ctx.font = font(11, '600'); ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
            var rowH = 18, wmax = legBox.w, bx = legBox.x0 + 4, ly = legBox.y0 + 6, bh = leg.length * rowH + 6 + (sp.legendNote ? rowH : 0);
            ctx.fillStyle = T.bg; ctx.globalAlpha = 0.78; ctx.fillRect(bx - 4, ly - 6, wmax + 8, bh); ctx.globalAlpha = 1;
            // an entry longer than the box is shortened with an ellipsis (the full text stays in the hover readout and the legend hit)
            var fit = function (t, w) {
                var mw = function (u) { return ctx.measureText ? ctx.measureText(u).width : u.length * 6; };
                t = String(t); if (mw(t) <= w) return t;
                while (t.length > 2 && mw(t + '…') > w) t = t.slice(0, -1);
                return t + '…';
            };
            leg.forEach(function (s, i) {
                var y = ly + i * rowH + 4, off = !!hidden[s.key];
                ctx.globalAlpha = off ? 0.35 : 1;
                ctx.strokeStyle = s.color || T.accent; ctx.fillStyle = s.color || T.accent; ctx.lineWidth = 3;
                if (s.kind === 'points') { ctx.beginPath(); if (ctx.arc) ctx.arc(bx + 9, y, 4, 0, Math.PI * 2); ctx.fill(); }
                else if (s.kind === 'poly') { ctx.globalAlpha = (off ? 0.35 : 1) * 0.45; if (ctx.fillRect) ctx.fillRect(bx, y - 5, 18, 10); ctx.globalAlpha = off ? 0.35 : 1; }
                else { if (ctx.setLineDash) ctx.setLineDash(s.dash || []); ctx.beginPath(); ctx.moveTo(bx, y); ctx.lineTo(bx + 18, y); ctx.stroke(); if (ctx.setLineDash) ctx.setLineDash([]); }
                ctx.fillStyle = T.text; ctx.fillText(fit(s.label, wmax - 24), bx + 24, y);
                ctx.globalAlpha = 1;
                st.legendHits.push({ key: s.key, x0: bx - 4, x1: bx + wmax + 4, y0: y - rowH / 2, y1: y + rowH / 2 });
            });
            if (sp.legendNote) { ctx.fillStyle = T.text2; ctx.font = font(10, 'italic 600'); ctx.fillText(fit(sp.legendNote, wmax), bx, ly + leg.length * rowH + 4); }
        }

        // handles
        st.handleHits = [];
        (sp.handles || []).forEach(function (h, i) {
            var hx, hy, focus = st.focusHandle === i, active = st.drag && st.drag.handle === i, col = h.color || T.accent;
            if (h.kind === 'point') { hx = toX(h.x); hy = toY(h.value); }
            else if (h.kind === 'pointX') {
                hx = _clamp(toX(h.value), P.x, P.x + P.w); hy = _fin(h.y) ? _clamp(toY(h.y), P.y, P.y + P.h) : P.y + P.h;
                ctx.strokeStyle = col; ctx.globalAlpha = active || focus ? 0.8 : 0.45; ctx.lineWidth = 1.2; if (ctx.setLineDash) ctx.setLineDash([4, 4]);
                ctx.beginPath(); ctx.moveTo(hx, P.y); ctx.lineTo(hx, P.y + P.h); ctx.stroke(); if (ctx.setLineDash) ctx.setLineDash([]); ctx.globalAlpha = 1;
            }
            else if (h.kind === 'lineX') {
                // a vertical line at x = value across the plot (A2: the gas-lift injection rate), the knob at the top of the plot
                hx = _clamp(toX(h.value), P.x, P.x + P.w); hy = P.y + 12;
                ctx.save(); ctx.strokeStyle = col; ctx.globalAlpha = 0.75; ctx.lineWidth = 1.6; if (ctx.setLineDash) ctx.setLineDash([5, 4]);
                ctx.beginPath(); ctx.moveTo(hx, P.y); ctx.lineTo(hx, P.y + P.h); ctx.stroke(); ctx.restore();
            }
            else if (h.kind === 'railY') {
                hx = P.x + P.w + (m.r / 2); hy = _clamp(toY(h.value), P.y, P.y + P.h);
                ctx.strokeStyle = T.axis; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(hx, P.y + 4); ctx.lineTo(hx, P.y + P.h - 4); ctx.stroke(); ctx.lineCap = 'butt';
                ctx.fillStyle = T.text2; ctx.font = font(9, '700'); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(h.railLabel || h.label, hx, P.y - 2);
            } else {
                // the track runs between the rail label and the value text, both measured (review fix: on a narrow chart the label
                // ran into the knob and the value); when the segment is too short the rail label is dropped and the value text
                // carries the name instead
                var f0 = (h.rail && h.rail[0]) || 0, f1 = (h.rail && h.rail[1]) || 1, gap = f1 < 1 ? 14 : 0, sx0 = P.x + P.w * f0 + (f0 > 0 ? 14 : 0), sx1 = P.x + P.w * f1 - gap, ry = m.t - (sp.x2 ? 26 : 0) - 16;
                var rl = String(h.railLabel || h.label || ''), vt = h.fmt ? h.fmt(h.value) : _fmtTick(h.value);
                ctx.font = font(10, '700');
                var mw = function (t) { return ctx.measureText ? ctx.measureText(t).width : String(t).length * 6; };
                var lw = rl ? mw(rl) + 8 : 0, narrowRail = (sx1 - sx0) - lw - (mw(vt) + 10) < 60;
                if (narrowRail) { if (rl && String(vt).toLowerCase().indexOf(rl.toLowerCase()) !== 0) vt = rl + ' ' + vt; lw = 0; }
                var rx0 = sx0 + lw + 8, rx1 = sx1 - mw(vt) - 12;
                if (rx1 < rx0 + 20) rx1 = rx0 + 20;
                h._vx = sx1; h._vtxt = vt; h._narrow = narrowRail;
                h._rx0 = rx0; h._rx1 = rx1;
                ctx.fillStyle = T.text2; ctx.font = font(10, '700'); ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; if (!narrowRail && rl) ctx.fillText(rl, sx0, ry);
                ctx.strokeStyle = T.axis; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(rx0, ry); ctx.lineTo(rx1, ry); ctx.stroke();
                var fv = (h.max > h.min) ? _clamp((h.value - h.min) / (h.max - h.min), 0, 1) : 0;
                ctx.strokeStyle = col; ctx.globalAlpha = 0.55; ctx.beginPath(); ctx.moveTo(rx0, ry); ctx.lineTo(rx0 + fv * (rx1 - rx0), ry); ctx.stroke(); ctx.globalAlpha = 1; ctx.lineCap = 'butt';
                hx = rx0 + fv * (rx1 - rx0); hy = ry;
            }
            if (!_fin(hx) || !_fin(hy)) return;
            var r = active ? 9 : (focus ? 8.5 : 7.5);
            if (focus || active) { ctx.strokeStyle = T.focus; ctx.lineWidth = 2; ctx.beginPath(); if (ctx.arc) ctx.arc(hx, hy, r + 4, 0, Math.PI * 2); ctx.stroke(); }
            ctx.fillStyle = col; ctx.beginPath(); if (ctx.arc) ctx.arc(hx, hy, r, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = T.bg; ctx.lineWidth = 2; ctx.stroke();
            ctx.fillStyle = T.bg; ctx.beginPath(); if (ctx.arc) ctx.arc(hx, hy, 2.5, 0, Math.PI * 2); ctx.fill();
            var txt = h.label + ' ' + (h.fmt ? h.fmt(h.value) : _fmtTick(h.value));
            ctx.font = font(10, '700'); ctx.textBaseline = 'middle';
            var tw = (ctx.measureText ? ctx.measureText(txt).width : txt.length * 6) + 10, tx, ty;
            if (h.kind === 'railY') { tx = hx - r - 4 - tw; ty = hy; }
            else if (h.kind === 'railX') { tx = _clamp(hx - tw / 2, 2, cw - tw - 2); ty = hy + 15; }
            else if (h.kind === 'pointX') { tx = _clamp(hx - tw / 2, P.x + 2, P.x + P.w - tw - 2); ty = hy - r - 12; }
            else if (h.kind === 'lineX') { tx = (hx + r + 6 + tw > P.x + P.w) ? hx - r - 6 - tw : hx + r + 6; ty = hy; }
            else { tx = hx + r + 6; ty = hy - 14; }
            if (h.kind !== 'railX' || active || focus) {
                ctx.fillStyle = T.bg; ctx.globalAlpha = 0.85; ctx.fillRect(tx, ty - 8, tw, 16); ctx.globalAlpha = 1;
                ctx.fillStyle = col; ctx.textAlign = 'left'; ctx.fillText(txt, tx + 5, ty);
            } else {
                ctx.fillStyle = T.text; ctx.textAlign = 'right'; ctx.fillText(h._vtxt != null ? h._vtxt : (h.fmt ? h.fmt(h.value) : _fmtTick(h.value)), h._vx, ry);
            }
            st.handleHits.push({ i: i, x: hx, y: hy, r: r + 7 });
        });

        // crosshair + readout
        var hv = st.hover;
        if (hv && !st.drag && hv.x >= P.x && hv.x <= P.x + P.w && hv.y >= P.y && hv.y <= P.y + P.h) {
            ctx.strokeStyle = T.text2; ctx.globalAlpha = 0.6; ctx.lineWidth = 1; if (ctx.setLineDash) ctx.setLineDash([3, 3]);
            ctx.beginPath(); ctx.moveTo(hv.x, P.y); ctx.lineTo(hv.x, P.y + P.h); ctx.moveTo(P.x, hv.y); ctx.lineTo(P.x + P.w, hv.y); ctx.stroke();
            if (ctx.setLineDash) ctx.setLineDash([]); ctx.globalAlpha = 1;
            var near = sp.readout === 'near' ? _near(sp, hidden, hv, toX, toY) : null;
            if (near) { ctx.strokeStyle = near.c || T.accent; ctx.lineWidth = 2; ctx.beginPath(); if (ctx.arc) ctx.arc(near.x, near.y, 7, 0, Math.PI * 2); ctx.stroke(); }
            var lines = sp.readout === 'near' ? (near ? near.lines : [{ t: (xa.short || 'x') + ' ' + _fmtTick(fromX(hv.x)) + ' · ' + (ya.short || 'y') + ' ' + _fmtTick(fromY(hv.y)) }]) : _readout(sp, hidden, fromX(hv.x), fromY(hv.y), fromX2 ? fromX2(hv.x) : null);
            if (lines.length) {
                ctx.font = font(11, '600'); var wmx = 0;
                lines.forEach(function (l) { var w = ctx.measureText ? ctx.measureText(l.t).width : l.t.length * 6.5; if (w > wmx) wmx = w; });
                var bw = wmx + 18, bh2 = lines.length * 16 + 8, bx2 = hv.x + 14, by2 = hv.y + 14;
                if (bx2 + bw > P.x + P.w) bx2 = hv.x - 14 - bw;
                if (by2 + bh2 > P.y + P.h) by2 = hv.y - 14 - bh2;
                ctx.fillStyle = T.bg; ctx.globalAlpha = 0.92; ctx.fillRect(bx2, by2, bw, bh2); ctx.globalAlpha = 1;
                ctx.strokeStyle = T.axis; ctx.strokeRect(bx2 + 0.5, by2 + 0.5, bw - 1, bh2 - 1);
                ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
                lines.forEach(function (l, i) { ctx.fillStyle = l.c || T.text; ctx.fillText(l.t, bx2 + 9, by2 + 12 + i * 16); });
            }
        }
        if (sp.empty && !(sp.series || []).some(function (s) { return (s.pts || []).length; })) {
            ctx.fillStyle = T.text2; ctx.font = font(13, '600'); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            _wrap(ctx, sp.empty, P.w - 40).forEach(function (ln, i, a) { ctx.fillText(ln, P.x + P.w / 2, P.y + P.h / 2 + (i - (a.length - 1) / 2) * 18); });
        }
        if (st.view) { ctx.fillStyle = T.text2; ctx.font = font(10); ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText('zoomed — double-click to reset', P.x + 4, P.y + P.h - 3); }
        if (st.wheelHint) { ctx.font = font(11, '600'); var hw = (ctx.measureText ? ctx.measureText(WHEEL_HINT).width : 150) + 14; ctx.fillStyle = T.bg; ctx.globalAlpha = 0.85; ctx.fillRect(P.x + P.w / 2 - hw / 2, P.y + P.h - 26, hw, 20); ctx.globalAlpha = 1; ctx.fillStyle = T.text; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(WHEEL_HINT, P.x + P.w / 2, P.y + P.h - 16); }
    }
    // the legend box: candidates are the four plot corners; the score counts the visible curve points, markers (with their labels)
    // and point handles under the box; ties keep the order top-right, bottom-right, top-left, bottom-left
    function _legendPlace(ctx, sp, hidden, P, toX, toY, font) {
        var leg = (sp.series || []).filter(function (s) { return s.legend !== false && s.label; });
        if (!leg.length) return null;
        ctx.font = font(11, '600');
        var wmax = 0;
        leg.forEach(function (s) { var w = (ctx.measureText ? ctx.measureText(s.label).width : s.label.length * 6) + 30; if (w > wmax) wmax = w; });
        wmax = Math.min(wmax, P.w * 0.6);
        if (sp.legendNote) { var nw = (ctx.measureText ? ctx.measureText(sp.legendNote).width : sp.legendNote.length * 6) + 8; if (nw > wmax) wmax = nw; }
        wmax = Math.min(wmax, P.w * 0.6);
        var bw = wmax + 8, bh = leg.length * 18 + 6 + (sp.legendNote ? 18 : 0), pad = 4;
        var cand = [[P.x + P.w - pad - bw, P.y + pad], [P.x + P.w - pad - bw, P.y + P.h - pad - bh - 14], [P.x + pad + 2, P.y + pad], [P.x + pad + 2, P.y + P.h - pad - bh - 14]];
        var pts = [];
        (sp.series || []).forEach(function (s) {
            if (hidden[s.key] || s.axis === 'x2') return;
            var a = s.pts || [], step = Math.max(1, Math.floor(a.length / 80));
            for (var i = 0; i < a.length; i += step) if (_fin(a[i][0]) && _fin(a[i][1])) pts.push({ x: toX(a[i][0]), y: toY(a[i][1]), w: 1 });
        });
        (sp.markers || []).forEach(function (m) { if (_fin(m.x) && _fin(m.y)) { var mx = toX(m.x), my = toY(m.y); pts.push({ x: mx, y: my, w: 60 }); if (m.label) for (var k = 1; k <= 6; k++) pts.push({ x: mx + (mx > P.x + P.w * 0.7 ? -k * 20 : k * 20), y: my - 12, w: 30 }); } });
        (sp.handles || []).forEach(function (h) { if (h.kind === 'point' && _fin(h.x) && _fin(h.value)) { var hx = toX(h.x), hy = toY(h.value); for (var k = 0; k <= 6; k++) pts.push({ x: hx + k * 20, y: hy - 12, w: 40 }); }
            if (h.kind === 'pointX' && _fin(h.value)) { var px = _clamp(toX(h.value), P.x, P.x + P.w), py = _fin(h.y) ? toY(h.y) : P.y + P.h; for (var j = -4; j <= 4; j++) pts.push({ x: px + j * 18, y: py - 20, w: 40 }); }
        });
        var best = null;
        cand.forEach(function (c, ci) {
            var sc = 0;
            pts.forEach(function (p) { if (p.x >= c[0] && p.x <= c[0] + bw && p.y >= c[1] && p.y <= c[1] + bh) sc += p.w; });
            if (!best || sc < best.sc) best = { sc: sc, ci: ci, x0: c[0], y0: c[1] };
        });
        return { x0: best.x0, y0: best.y0, x1: best.x0 + bw, y1: best.y0 + bh, w: wmax, corner: best.ci };
    }
    function _wrap(ctx, s, w) {
        var words = String(s).split(' '), out = [], cur = '';
        words.forEach(function (wd) { var t = cur ? cur + ' ' + wd : wd; if ((ctx.measureText ? ctx.measureText(t).width : t.length * 7) > w && cur) { out.push(cur); cur = wd; } else cur = t; });
        if (cur) out.push(cur);
        return out.slice(0, 4);
    }
    function _interpAt(pts, v, along) {        // along 0: y at x = v; along 1: x at y = v
        var a = along, b = 1 - along, best = null;
        for (var i = 1; i < pts.length; i++) {
            var p0 = pts[i - 1], p1 = pts[i];
            if (!_fin(p0[a]) || !_fin(p1[a])) continue;
            if ((v - p0[a]) * (v - p1[a]) <= 0 && p1[a] !== p0[a]) { var t = (v - p0[a]) / (p1[a] - p0[a]); best = p0[b] + t * (p1[b] - p0[b]); break; }
        }
        return best;
    }
    // readout 'near' (WP12): the nearest point (within 28 px) of a series that carries info[] (one string or a list of strings per
    // point) — e.g. a traverse station on the flow-regime map with its MD / TVD and groups
    function _near(sp, hidden, hv, toX, toY) {
        var best = null, bd = 28 * 28;
        (sp.series || []).forEach(function (s) {
            if (hidden[s.key] || !Array.isArray(s.info) || !(s.pts || []).length) return;
            s.pts.forEach(function (p, i) {
                if (!_fin(p[0]) || !_fin(p[1]) || s.info[i] == null) return;
                var x = toX(p[0]), y = toY(p[1]), d = (x - hv.x) * (x - hv.x) + (y - hv.y) * (y - hv.y);
                if (d < bd) { bd = d; best = { x: x, y: y, c: s.color, lines: [].concat(s.info[i]).slice(0, 6).map(function (t, k) { return { t: String(t), c: k ? null : s.color }; }) }; }
            });
        });
        return best;
    }
    function _readout(sp, hidden, x, y, x2) {
        var out = [], mode = sp.readout || 'x', ya = sp.y || {}, xa = sp.x || {}, f = function (ax, v) { return ax && ax.fmtR ? ax.fmtR(v) : (ax && ax.fmt ? ax.fmt(v) : _fmtTick(v)); };
        out.push({ t: mode === 'y' ? ((ya.short || 'y') + ' ' + f(ya, y)) : ((xa.short || 'x') + ' ' + f(xa, x)) });
        (sp.series || []).forEach(function (s) {
            if (hidden[s.key] || s.kind === 'points' || !s.label || !(s.pts || []).length) return;
            var ax = s.axis === 'x2' ? sp.x2 : xa;
            var v = mode === 'y' ? _interpAt(s.pts, y, 1) : _interpAt(s.pts, s.axis === 'x2' ? x2 : x, 0);
            if (v == null) return;
            out.push({ t: s.label + ': ' + (mode === 'y' ? f(ax, v) : f(ya, v)), c: s.color });
        });
        return out.slice(0, 8);
    }

    // ── interaction ───────────────────────────────────────────────────────────
    function _pos(cv, e) {
        var r = cv.getBoundingClientRect ? cv.getBoundingClientRect() : { left: 0, top: 0, width: cv.width, height: cv.height };
        var ax = cv._wpAxes || { w: r.width || 1, h: r.height || 1 };
        var sx = (r.width > 0) ? ax.w / r.width : 1, sy = (r.height > 0) ? ax.h / r.height : 1;
        return { x: ((e.clientX || 0) - r.left) * sx, y: ((e.clientY || 0) - r.top) * sy };
    }
    function _handleAt(st, p) {
        var hs = st.handleHits || [];
        for (var i = hs.length - 1; i >= 0; i--) if (Math.hypot(p.x - hs[i].x, p.y - hs[i].y) <= hs[i].r) return hs[i].i;
        return -1;
    }
    function _handleValue(cv, h, p) {
        var A = cv._wpAxes, v;
        if (h.kind === 'railX') { var f = _clamp((p.x - h._rx0) / Math.max(1, h._rx1 - h._rx0), 0, 1); v = h.min + f * (h.max - h.min); }
        else if (h.kind === 'pointX') v = A.fromX(_clamp(p.x, A.plot.x, A.plot.x + A.plot.w));
        else if (h.kind === 'lineX') v = A.fromX(_clamp(p.x, A.plot.x, A.plot.x + A.plot.w));
        else v = A.fromY(_clamp(p.y, A.plot.y, A.plot.y + A.plot.h));
        if (_fin(h.step) && h.step > 0) v = Math.round(v / h.step) * h.step;
        if (_fin(h.min)) v = Math.max(h.min, v);
        if (_fin(h.max)) v = Math.min(h.max, v);
        return v;
    }
    function _emitHandle(cv, i, v, phase) {
        var sp = cv._wp.spec, h = sp.handles && sp.handles[i];
        if (!h) return;
        h.value = v;
        if (typeof sp.onHandle === 'function') { try { sp.onHandle(h.key, v, phase); } catch (e) { if (typeof console !== 'undefined') console.error('[wp-view] handle', e); } }
        if (cv._wp.spec === sp) _draw(cv); else redraw(cv);
    }
    function _zoom(cv, px, py, f) {
        var st = cv._wp, A = cv._wpAxes, sp = st.spec, xa = sp.x || {}, ya = sp.y || {};
        if (!A) return;
        var L = function (v, log) { return log ? Math.log(v) / Math.LN10 : v; }, IL = function (v, log) { return log ? Math.pow(10, v) : v; };
        var cx = L(A.fromX(px), xa.log), cy = L(A.fromY(py), ya.log);
        var x0 = L(A.xr[0], xa.log), x1 = L(A.xr[1], xa.log), y0 = L(A.yr[0], ya.log), y1 = L(A.yr[1], ya.log);
        var v = { x0: IL(cx + (x0 - cx) * f, xa.log), x1: IL(cx + (x1 - cx) * f, xa.log), y0: IL(cy + (y0 - cy) * f, ya.log), y1: IL(cy + (y1 - cy) * f, ya.log) };
        if (A.x2r) { var c2 = A.fromX2(px); v.x20 = c2 + (A.x2r[0] - c2) * f; v.x21 = c2 + (A.x2r[1] - c2) * f; }
        st.view = v; _draw(cv);
    }
    function _pan(cv, dx, dy) {
        var st = cv._wp, A = cv._wpAxes, sp = st.spec, xa = sp.x || {}, ya = sp.y || {};
        if (!A) return;
        var L = function (v, log) { return log ? Math.log(v) / Math.LN10 : v; }, IL = function (v, log) { return log ? Math.pow(10, v) : v; };
        var fx = (L(A.xr[1], xa.log) - L(A.xr[0], xa.log)) * dx / A.plot.w, fy = (L(A.yr[1], ya.log) - L(A.yr[0], ya.log)) * dy / A.plot.h * (ya.invert ? -1 : 1);
        var v = { x0: IL(L(A.xr[0], xa.log) - fx, xa.log), x1: IL(L(A.xr[1], xa.log) - fx, xa.log), y0: IL(L(A.yr[0], ya.log) + fy, ya.log), y1: IL(L(A.yr[1], ya.log) + fy, ya.log) };
        if (A.x2r) { var f2 = (A.x2r[1] - A.x2r[0]) * dx / A.plot.w; v.x20 = A.x2r[0] - f2; v.x21 = A.x2r[1] - f2; }
        st.view = v; _draw(cv);
    }
    function _bind(cv) {
        if (!cv.addEventListener) return;
        if (cv.setAttribute) { if (!cv.getAttribute || cv.getAttribute('tabindex') == null) cv.setAttribute('tabindex', '0'); }
        cv.addEventListener('pointerdown', function (e) {
            var st = cv._wp; if (!st || !st.spec) return;
            var p = _pos(cv, e);
            st.ptrs[e.pointerId] = p;
            var ids = Object.keys(st.ptrs);
            if (ids.length === 2) { var a = st.ptrs[ids[0]], b = st.ptrs[ids[1]]; st.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }; st.drag = null; return; }
            var hi = _handleAt(st, p);
            if (hi >= 0) { st.drag = { handle: hi }; st.focusHandle = hi; if (e.preventDefault) e.preventDefault(); }
            else {
                var lg = (st.legendHits || []).filter(function (l) { return p.x >= l.x0 && p.x <= l.x1 && p.y >= l.y0 && p.y <= l.y1; })[0];
                if (lg) {
                    st.hidden[lg.key] = !st.hidden[lg.key];
                    if (typeof st.spec.onLegend === 'function') { try { st.spec.onLegend(st.hidden); } catch (e2) { /* ignore */ } }
                    _draw(cv); return;
                }
                var A = cv._wpAxes; if (!A) return;
                if (p.x >= A.plot.x && p.x <= A.plot.x + A.plot.w && p.y >= A.plot.y && p.y <= A.plot.y + A.plot.h) st.drag = { pan: true, x: p.x, y: p.y };
            }
            if (cv.focus && typeof document !== 'undefined' && document.activeElement !== cv) { try { cv.focus({ preventScroll: true }); } catch (e4) { /* ignore */ } }
            if (st.drag && cv.setPointerCapture) { try { cv.setPointerCapture(e.pointerId); } catch (e3) { /* ignore */ } }
            if (cv.classList) cv.classList.add('wp-cv-live');
            _draw(cv);
        });
        cv.addEventListener('pointermove', function (e) {
            var st = cv._wp; if (!st || !st.spec) return;
            var p = _pos(cv, e);
            if (st.ptrs[e.pointerId]) st.ptrs[e.pointerId] = p;
            if (st.pinch) {
                var ids = Object.keys(st.ptrs);
                if (ids.length === 2) { var a = st.ptrs[ids[0]], b = st.ptrs[ids[1]], d = Math.hypot(a.x - b.x, a.y - b.y); if (d > 10 && st.pinch.d > 10) { _zoom(cv, st.pinch.cx, st.pinch.cy, st.pinch.d / d); st.pinch.d = d; } }
                return;
            }
            if (st.drag && st.drag.handle != null) {
                var h = st.spec.handles[st.drag.handle], v = _handleValue(cv, h, p);
                if (v !== h.value) _emitHandle(cv, st.drag.handle, v, 'move');
                return;
            }
            if (st.drag && st.drag.pan) { _pan(cv, p.x - st.drag.x, p.y - st.drag.y); st.drag.x = p.x; st.drag.y = p.y; return; }
            st.hover = p;
            if (cv.style) cv.style.cursor = _handleAt(st, p) >= 0 ? 'grab' : 'crosshair';
            _draw(cv);
        });
        var end = function (e) {
            var st = cv._wp; if (!st) return;
            delete st.ptrs[e.pointerId];
            if (Object.keys(st.ptrs).length < 2) st.pinch = null;
            var d = st.drag; st.drag = null;
            if (d && d.handle != null) { var h = st.spec.handles[d.handle]; _emitHandle(cv, d.handle, h.value, 'end'); return; }
            _draw(cv);
        };
        cv.addEventListener('pointerup', end);
        cv.addEventListener('pointercancel', end);
        cv.addEventListener('pointerleave', function () { var st = cv._wp; if (st && !st.drag) { st.hover = null; st.wheelHint = false; _draw(cv); } });
        // the wheel zooms only with Ctrl / Cmd held or once the plot has the focus (clicked or tabbed to); otherwise the page scrolls
        // and the plot shows a "Ctrl + wheel to zoom" hint
        cv.addEventListener('wheel', function (e) {
            var st = cv._wp; if (!st || !st.spec) return;
            var focused = typeof document !== 'undefined' && document.activeElement === cv;
            if (!(e.ctrlKey || e.metaKey || focused)) { if (!st.wheelHint) { st.wheelHint = true; _draw(cv); } return; }
            if (e.preventDefault) e.preventDefault();
            var p = _pos(cv, e); _zoom(cv, p.x, p.y, (e.deltaY || 0) > 0 ? 1.15 : 1 / 1.15);
        }, { passive: false });
        cv.addEventListener('dblclick', function () { var st = cv._wp; if (st) { st.view = null; _draw(cv); } });
        cv.addEventListener('blur', function () { if (cv.classList) cv.classList.remove('wp-cv-live'); var st = cv._wp; if (st) { st.focusHandle = -1; _draw(cv); } });
        cv.addEventListener('keydown', function (e) {
            var st = cv._wp; if (!st || !st.spec) return;
            var hs = st.spec.handles || [], k = e.key, A = cv._wpAxes, used = true;
            if ((k === ']' || k === '[') && hs.length) { st.focusHandle = (st.focusHandle + (k === ']' ? 1 : hs.length - 1) + (st.focusHandle < 0 && k === '[' ? 1 : 0)) % hs.length; _draw(cv); }
            else if (st.focusHandle >= 0 && hs[st.focusHandle] && /^Arrow/.test(k)) {
                var h = hs[st.focusHandle], stp = _fin(h.step) && h.step > 0 ? h.step : (h.max - h.min) / 100, dir = (k === 'ArrowUp' || k === 'ArrowRight') ? 1 : -1;
                if (e.shiftKey) stp *= 10;
                var v = _clamp(h.value + dir * stp, h.min, h.max); _emitHandle(cv, st.focusHandle, v, 'move');
            } else if (st.focusHandle >= 0 && hs[st.focusHandle] && k === 'Enter') { _emitHandle(cv, st.focusHandle, hs[st.focusHandle].value, 'end'); }
            else if (k === 'Escape') { st.focusHandle = -1; _draw(cv); }
            else if (k === '+' || k === '=') { if (A) _zoom(cv, A.plot.x + A.plot.w / 2, A.plot.y + A.plot.h / 2, 1 / 1.25); }
            else if (k === '-' || k === '_') { if (A) _zoom(cv, A.plot.x + A.plot.w / 2, A.plot.y + A.plot.h / 2, 1.25); }
            else if (k === '0') { st.view = null; _draw(cv); }
            else if (/^Arrow/.test(k) && A) { _pan(cv, k === 'ArrowLeft' ? 30 : k === 'ArrowRight' ? -30 : 0, k === 'ArrowUp' ? 30 : k === 'ArrowDown' ? -30 : 0); }
            else used = false;
            if (used && e.preventDefault) e.preventDefault();
        });
    }

    // ── schematic ─────────────────────────────────────────────────────────────
    function interp(path, md) {
        if (!path.length) return null;
        if (md <= path[0].md) return { x: path[0].x, y: path[0].y, ang: path.length > 1 ? Math.atan2(path[1].y - path[0].y, path[1].x - path[0].x) : Math.PI / 2 };
        for (var i = 1; i < path.length; i++) {
            if (md <= path[i].md) {
                var a = path[i - 1], b = path[i], t = (b.md > a.md) ? (md - a.md) / (b.md - a.md) : 0;
                return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y), ang: Math.atan2(b.y - a.y, b.x - a.x) };
            }
        }
        var l = path[path.length - 1], p = path[path.length - 2] || l;
        return { x: l.x, y: l.y, ang: Math.atan2(l.y - p.y, l.x - p.x) || Math.PI / 2 };
    }
    function _sub(path, m0, m1) {        // polyline points between two MDs
        var out = [], a = interp(path, m0), b = interp(path, m1);
        if (!a || !b) return out;
        out.push([a.x, a.y]);
        path.forEach(function (p) { if (p.md > m0 && p.md < m1) out.push([p.x, p.y]); });
        out.push([b.x, b.y]);
        return out;
    }
    function _poly(pts) { return pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(''); }
    var PROPS = {
        pressure: { key: 'p', label: 'Pressure' }, temperature: { key: 't', label: 'Temperature' }, holdup: { key: 'hl', label: 'Liquid holdup' },
        velocity: { key: 'vm', label: 'Mixture velocity' }, pattern: { key: 'pattern', label: 'Flow pattern' },
        heatloss: { key: 'dte', label: 'Fluid − earth temperature' }, none: { key: null, label: '' }
    };
    function scale(prop, profile) {
        var P = PROPS[prop] || PROPS.none;
        if (!P.key || P.key === 'pattern') return { prop: prop, label: P.label, lo: null, hi: null };
        var lo = Infinity, hi = -Infinity;
        (profile || []).forEach(function (r) { var v = r[P.key]; if (_fin(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } });
        if (prop === 'holdup') { lo = 0; hi = 1; }
        // temperature: one scale for the fluid and the earth (the formation halo of the schematic uses the same colours)
        if (prop === 'temperature') (profile || []).forEach(function (r) { if (_fin(r.te)) { if (r.te < lo) lo = r.te; if (r.te > hi) hi = r.te; } });
        if (!_fin(lo)) { lo = 0; hi = 1; }
        if (hi - lo < 1e-9) hi = lo + 1;
        return { prop: prop, label: P.label, lo: lo, hi: hi, key: P.key };
    }

    function schematic(S, o) {
        o = o || {};
        var W0 = o.width || 420, H0 = o.height || 560, T = _theme(), fm = o.fmt || {};
        var fmtMd = fm.md || function (v) { return Math.round(v).toLocaleString() + ' ft'; };
        // every component label carries MD and TVD (TVD by linear interpolation on the trajectory)
        var tvdOf = function (md) {
            var tj = (S && S.trajectory) || [];
            for (var q = 1; q < tj.length; q++) if (md <= tj[q].md) { var a0 = tj[q - 1], b0 = tj[q], f0 = (md - a0.md) / ((b0.md - a0.md) || 1); return a0.tvd + f0 * (b0.tvd - a0.tvd); }
            return tj.length ? tj[tj.length - 1].tvd : null;
        };
        var D = function (md) { var tv = tvdOf(md); return fmtMd(md) + ' MD' + (_fin(tv) ? ' · ' + fmtMd(tv) + ' TVD' : ''); };
        var traj = (S && Array.isArray(S.trajectory)) ? S.trajectory.filter(function (r) { return _fin(r.md) && _fin(r.tvd); }) : [];
        if (traj.length < 2) return { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W0 + ' 120" width="100%" role="img" aria-label="Well schematic"><text x="' + (W0 / 2) + '" y="64" fill="' + T.text2 + '" font-size="13" text-anchor="middle">' + _esc(o.empty || 'Enter a survey and the strings (step ③) to draw the well.') + '</text></svg>', pts: [], width: W0, height: 120 };
        var narrow = W0 < 520, pb = narrow ? Math.round(Math.min(W0 * 0.5, 230)) : 0;   // narrow: plan view below the section
        var planW = narrow ? 0 : Math.round(W0 * 0.3), secW = W0 - planW - (narrow ? 0 : 12);
        var mL = 50, mR = 30, mT = 46, mB = 30;
        var tvdMax = traj.reduce(function (a, r) { return Math.max(a, r.tvd); }, 0) || 1;
        var deps = traj.map(function (r) { return _fin(r.dep) ? r.dep : 0; });
        // vertical section: departure signed along the closure azimuth (the departure of the last station), so an S-shaped well shows its drop
        var last = traj[traj.length - 1], cz = Math.atan2(_fin(last.e) ? last.e : 0, _fin(last.n) ? last.n : 0);
        var vs = traj.map(function (r, i) { return (_fin(r.n) && _fin(r.e)) ? r.n * Math.cos(cz) + r.e * Math.sin(cz) : deps[i]; });
        var vmin = Math.min(0, Math.min.apply(null, vs)), vmax = Math.max(0, Math.max.apply(null, vs));
        var ah = H0 - mT - mB - pb, aw = secW - mL - mR;
        // equal scale; a minimum horizontal span keeps a vertical well in the middle of the panel
        var spanH = Math.max(vmax - vmin, tvdMax * (aw / ah) * 0.999, 1), sc = Math.min(ah / tvdMax, aw / spanH);
        var cx0 = mL + aw / 2 - ((vmin + vmax) / 2) * sc;
        var X = function (v) { return cx0 + v * sc; }, Y = function (t) { return mT + t * sc; };
        var path = traj.map(function (r, i) { return { md: r.md, x: X(vs[i]), y: Y(r.tvd), tvd: r.tvd, inc: r.inc }; });
        var mdMax = path[path.length - 1].md;
        var g = [];
        g.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W0 + ' ' + H0 + '" width="100%" class="wp-sch" role="img" aria-label="' + _esc(o.aria || 'Well schematic: vertical section and plan view') + '">');
        g.push('<rect x="0" y="0" width="' + W0 + '" height="' + H0 + '" rx="8" fill="' + T.bg + '"/>');
        // ground + depth grid (TVD)
        g.push('<rect x="' + mL + '" y="' + mT + '" width="' + aw + '" height="' + ah + '" fill="' + T.panel + '" stroke="' + T.axis + '"/>');
        _ticks(0, tvdMax, 6, false).forEach(function (t) {
            var y = Y(t);
            g.push('<line x1="' + mL + '" x2="' + (mL + aw) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '" stroke="' + T.grid + '"/>');
            g.push('<text x="' + (mL - 6) + '" y="' + (y + 4).toFixed(1) + '" fill="' + T.text2 + '" font-size="10" text-anchor="end">' + _esc(fm.depthTick ? fm.depthTick(t) : _fmtTick(t)) + '</text>');
        });
        g.push('<text x="12" y="' + (mT + ah / 2) + '" fill="' + T.text2 + '" font-size="10" font-weight="600" text-anchor="middle" transform="rotate(-90 12 ' + (mT + ah / 2) + ')">' + _esc(o.labels && o.labels.tvd || 'TVD (ft)') + '</text>');
        g.push('<text x="' + (mL + aw / 2) + '" y="' + (H0 - pb - 8) + '" fill="' + T.text2 + '" font-size="10" font-weight="600" text-anchor="middle">' + _esc(o.labels && o.labels.vs || 'Vertical section (ft), equal scale') + '</text>');
        g.push('<line x1="' + mL + '" x2="' + (mL + aw) + '" y1="' + mT + '" y2="' + mT + '" stroke="#7d6a4f" stroke-width="2"/>');

        // the formation along the hole coloured by the static earth temperature (temperature colouring, A2 WP14): a wide translucent
        // halo behind the strings, on the same scale as the fluid, so the heat lost to the earth reads as the colour step between them
        var prof0 = (S.profile || []).filter(function (r) { return _fin(r.md); }).sort(function (a, b) { return a.md - b.md; });
        if (o.prop === 'temperature' && prof0.length > 1 && prof0.some(function (r) { return _fin(r.te); })) {
            var scE = scale('temperature', prof0);
            g.push('<g class="wp-earth" aria-hidden="true" opacity="0.34">');      // opaque strokes in a translucent group: no overlap banding
            for (var ie = 1; ie < prof0.length; ie++) {
                var ea = interp(path, prof0[ie - 1].md), eb = interp(path, prof0[ie].md), tev = prof0[ie].te;
                if (!ea || !eb || !_fin(tev)) continue;
                g.push('<line x1="' + ea.x.toFixed(1) + '" y1="' + ea.y.toFixed(1) + '" x2="' + eb.x.toFixed(1) + '" y2="' + eb.y.toFixed(1) + '" stroke="' + colorFor('temperature', tev, scE.lo, scE.hi) + '" stroke-width="40" stroke-linecap="round"/>');
            }
            g.push('</g>');
        }
        // strings along the path: casing / liner (wide), tubing (narrow); stroke width scales with the OD
        var strs = (S.strings || []).filter(function (s) { return _fin(s.topMd) && _fin(s.botMd) && s.botMd > s.topMd; });
        var odMax = strs.reduce(function (a, s) { return Math.max(a, _fin(s.od) ? s.od : 0); }, 0) || 7;
        var wOf = function (s) { return _clamp(6 + 16 * ((_fin(s.od) ? s.od : 3) / odMax), 6, 22); };
        var order = strs.map(function (s, i) { return { s: s, i: i }; }).sort(function (a, b) { return (b.s.od || 0) - (a.s.od || 0); });
        order.forEach(function (it) {
            var s = it.s, pl = _poly(_sub(path, s.topMd, Math.min(s.botMd, mdMax))), w = wOf(s), tub = s.kind === 'tubing';
            if (!pl) return;
            g.push('<g class="wp-comp" data-comp="string:' + (_fin(s.idx) ? s.idx : it.i) + '" tabindex="0" role="button" aria-label="' + _esc((s.kind || 'string') + ' ' + (s.od || '') + ' in OD, ' + D(s.topMd) + ' to ' + D(s.botMd) + ' — edit') + '">');
            g.push('<path d="' + pl + '" fill="none" stroke="' + (tub ? '#4b5563' : '#6b7280') + '" stroke-width="' + (w + 3).toFixed(1) + '" stroke-linecap="butt" stroke-linejoin="round"/>');
            g.push('<path d="' + pl + '" fill="none" stroke="' + (tub ? '#1f2937' : '#111827') + '" stroke-width="' + (w - 1).toFixed(1) + '" stroke-linecap="butt" stroke-linejoin="round"/>');
            g.push('<path d="' + pl + '" fill="none" stroke="transparent" stroke-width="' + (w + 8) + '" class="wp-hit"/>');
            g.push('</g>');
            // shoe marker for casing / liner
            if (!tub) { var sh = interp(path, Math.min(s.botMd, mdMax)); if (sh) g.push('<path d="M' + (sh.x - w / 2 - 4).toFixed(1) + ' ' + sh.y.toFixed(1) + 'l4 -7v7zM' + (sh.x + w / 2 + 4).toFixed(1) + ' ' + sh.y.toFixed(1) + 'l-4 -7v7z" fill="#9ca3af"/>'); }
        });
        // heat map along the flow path (the tubing, or the deepest string when there is no tubing)
        var prof = (S.profile || []).filter(function (r) { return _fin(r.md); }).sort(function (a, b) { return a.md - b.md; });
        var sc2 = scale(o.prop || 'pressure', prof), P2 = PROPS[o.prop] || PROPS.none;
        var flowBot = prof.length ? prof[prof.length - 1].md : (S.perfs && _fin(S.perfs.midMd) ? S.perfs.midMd : mdMax);
        if (prof.length > 1 && P2.key) {
            for (var i = 1; i < prof.length; i++) {
                var a = interp(path, prof[i - 1].md), b = interp(path, prof[i].md);
                if (!a || !b) continue;
                var v = P2.key === 'pattern' ? prof[i].pattern : (_fin(prof[i][P2.key]) && _fin(prof[i - 1][P2.key]) ? (prof[i][P2.key] + prof[i - 1][P2.key]) / 2 : prof[i][P2.key]);
                g.push('<line x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) + '" x2="' + b.x.toFixed(1) + '" y2="' + b.y.toFixed(1) + '" stroke="' + colorFor(o.prop, v, sc2.lo, sc2.hi) + '" stroke-width="5" stroke-linecap="round"/>');
            }
        } else {
            var fp = _poly(_sub(path, 0, flowBot));
            if (fp) g.push('<path d="' + fp + '" fill="none" stroke="' + T.blue + '" stroke-opacity="0.55" stroke-width="3" stroke-dasharray="6 5"/>');
        }
        var labs = [];      // side labels, placed after the markers without overlaps
        // perforations + mid-perf
        var pf = S.perfs || {};
        if (_fin(pf.topMd) && _fin(pf.botMd) && pf.botMd > pf.topMd) {
            g.push('<g class="wp-comp" data-comp="perf" tabindex="0" role="button" aria-label="' + _esc('Perforations ' + D(pf.topMd) + ' to ' + D(pf.botMd) + (_fin(pf.midMd) ? ', mid-perforation ' + D(pf.midMd) : '') + ' — edit') + '">');
            var n = Math.max(3, Math.min(14, Math.round((pf.botMd - pf.topMd) / Math.max(1, mdMax) * 400)));
            for (var k = 0; k <= n; k++) {
                var q = interp(path, pf.topMd + (pf.botMd - pf.topMd) * k / n), nx = -Math.sin(q.ang), ny = Math.cos(q.ang);
                [-1, 1].forEach(function (sd) { g.push('<line x1="' + (q.x + sd * nx * 9).toFixed(1) + '" y1="' + (q.y + sd * ny * 9).toFixed(1) + '" x2="' + (q.x + sd * nx * 19).toFixed(1) + '" y2="' + (q.y + sd * ny * 19).toFixed(1) + '" stroke="' + T.red + '" stroke-width="2" stroke-linecap="round"/>'); });
            }
            g.push('</g>');
        }
        if (_fin(pf.midMd)) {
            var mp = interp(path, pf.midMd);
            if (mp) { g.push('<line x1="' + (mp.x - 26).toFixed(1) + '" x2="' + (mp.x + 26).toFixed(1) + '" y1="' + mp.y.toFixed(1) + '" y2="' + mp.y.toFixed(1) + '" stroke="' + T.red + '" stroke-dasharray="3 3"/>');
                labs.push({ side: 1, x: mp.x + 26, y: mp.y, t: 'mid-perf', c: T.red }); }
        }
        // restrictions
        (S.restrictions || []).forEach(function (r, i) {
            if (!_fin(r.md)) return;
            var q = interp(path, Math.min(r.md, mdMax)); if (!q) return;
            var kind = String(r.kind || 'nipple'), col = kind === 'sssv' ? T.yellow : (kind === 'downholeChoke' ? T.accent : T.purple);
            var lab = { sssv: 'SSSV', nipple: 'Nipple', sleeve: 'Sleeve', xo: 'X-over', downholeChoke: 'DH choke' }[kind] || kind;
            g.push('<g class="wp-comp" data-comp="restr:' + i + '" tabindex="0" role="button" aria-label="' + _esc(lab + ' at ' + D(r.md) + ', ID ' + (r.id || '') + ' in — edit') + '">' +
                '<rect x="' + (q.x - 7).toFixed(1) + '" y="' + (q.y - 7).toFixed(1) + '" width="14" height="14" transform="rotate(45 ' + q.x.toFixed(1) + ' ' + q.y.toFixed(1) + ')" fill="' + col + '" stroke="' + T.bg + '" stroke-width="1.5"/></g>');
            labs.push({ side: -1, x: q.x - 10, y: q.y, t: lab, c: col });
        });
        // gauges
        (S.gauges || []).forEach(function (gg, i) {
            var md = _fin(gg.md) ? gg.md : gg.gaugeMd; if (!_fin(md)) return;
            var q = interp(path, Math.min(md, mdMax)); if (!q) return;
            g.push('<g class="wp-comp" data-comp="gauge:' + i + '" tabindex="0" role="button" aria-label="' + _esc('Gauge ' + (gg.name || gg.id || (i + 1)) + ' at ' + D(md) + ' — edit') + '">' +
                '<path d="M' + (q.x + 12).toFixed(1) + ' ' + q.y.toFixed(1) + 'l10 -6v12z" fill="' + T.green + '" stroke="' + T.bg + '"/></g>');
            labs.push({ side: 1, x: q.x + 22, y: q.y, t: 'gauge ' + (gg.name || gg.id || (i + 1)), c: T.green });
        });
        // extra marks (A2, WP18): o.marks = [{md, kind:'gl'|'packer', label, color, comp}] — the gas-lift injection point with the lift-gas
        // path down the annulus (dashed, from the wellhead to the point) and the packer across the annulus; B (WP27): kind 'window'
        // {md, md2} — a bracket beside the hole over an MD interval (e.g. a pump setting window), kind 'tick' — a short marker across the
        // hole at an MD (e.g. the depth where liquid loading starts in a forecast)
        (o.marks || []).forEach(function (mk) {
            if (!mk || !_fin(mk.md)) return;
            var q = interp(path, Math.min(mk.md, mdMax)); if (!q) return;
            var col = mk.color || T.blue, nx = -Math.sin(q.ang), ny = Math.cos(q.ang), cmp = mk.comp ? ' class="wp-comp" data-comp="' + _esc(mk.comp) + '" tabindex="0" role="button"' : '';
            if (mk.kind === 'gl') {
                // the lift-gas path: down the annulus (offset 15 px on the casing side) from the wellhead to the point
                var ln = [], nS = 32, mdI = Math.min(mk.md, mdMax);
                for (var k2 = 0; k2 <= nS; k2++) { var qq = interp(path, mdI * k2 / nS); if (qq) ln.push((qq.x + Math.sin(qq.ang) * 15).toFixed(1) + ',' + (qq.y - Math.cos(qq.ang) * 15).toFixed(1)); }
                g.push('<polyline points="' + ln.join(' ') + '" fill="none" stroke="' + col + '" stroke-width="2" stroke-dasharray="5 4" stroke-opacity="0.8"/>');
                var vx = q.x + Math.sin(q.ang) * 15, vy = q.y - Math.cos(q.ang) * 15, bub = '';
                // gas bubbles in the tubing just above the point (the injected gas rising with the liquid)
                [1, 2, 3].forEach(function (i2) { var qb = interp(path, Math.max(0, mdI - mdMax * 0.025 * i2)); if (qb) bub += '<circle cx="' + qb.x.toFixed(1) + '" cy="' + qb.y.toFixed(1) + '" r="' + (3.2 - 0.6 * i2).toFixed(1) + '" fill="none" stroke="' + col + '" stroke-width="1.4" stroke-opacity="' + (1 - 0.22 * i2).toFixed(2) + '"/>'; });
                g.push('<g' + cmp + ' aria-label="' + _esc(mk.label || 'Gas-lift injection point') + '">' + bub +
                    '<line x1="' + vx.toFixed(1) + '" y1="' + vy.toFixed(1) + '" x2="' + q.x.toFixed(1) + '" y2="' + q.y.toFixed(1) + '" stroke="' + col + '" stroke-width="2.5" stroke-linecap="round"/>' +
                    '<circle cx="' + vx.toFixed(1) + '" cy="' + vy.toFixed(1) + '" r="6.5" fill="' + col + '" stroke="' + T.bg + '" stroke-width="2"/>' +
                    '<path d="M' + (vx - 3).toFixed(1) + ' ' + (vy - 2).toFixed(1) + 'h6l-3 4z" fill="' + T.bg + '"/></g>');
                labs.push({ side: 1, x: vx + 10, y: vy, t: mk.label || 'GL injection', c: col });
            } else if (mk.kind === 'window' && _fin(mk.md2)) {
                var wc = mk.color || T.purple, mA = Math.min(mk.md, mk.md2), mB = Math.min(Math.max(mk.md, mk.md2), mdMax), wl = [], nW = 24;
                for (var kw = 0; kw <= nW; kw++) { var qw = interp(path, mA + (mB - mA) * kw / nW); if (qw) wl.push((qw.x - Math.sin(qw.ang) * 24).toFixed(1) + ',' + (qw.y + Math.cos(qw.ang) * 24).toFixed(1)); }
                var qa = interp(path, mA), qb = interp(path, mB);
                if (wl.length > 1 && qa && qb) {
                    g.push('<g aria-label="' + _esc(mk.label || 'window') + '"><polyline points="' + wl.join(' ') + '" fill="none" stroke="' + wc + '" stroke-width="3" stroke-linecap="round" stroke-opacity="0.85"/>' +
                        [qa, qb].map(function (qq) { return '<line x1="' + (qq.x - Math.sin(qq.ang) * 18).toFixed(1) + '" y1="' + (qq.y + Math.cos(qq.ang) * 18).toFixed(1) + '" x2="' + (qq.x - Math.sin(qq.ang) * 30).toFixed(1) + '" y2="' + (qq.y + Math.cos(qq.ang) * 30).toFixed(1) + '" stroke="' + wc + '" stroke-width="2"/>'; }).join('') + '</g>');
                    labs.push({ side: -1, x: qb.x - 34, y: qb.y, t: mk.label || 'window', c: wc });
                }
            } else if (mk.kind === 'tick') {
                var tcol = mk.color || T.yellow;
                g.push('<g aria-label="' + _esc(mk.label || 'marker') + '"><line x1="' + (q.x + nx * 16).toFixed(1) + '" y1="' + (q.y + ny * 16).toFixed(1) + '" x2="' + (q.x - nx * 16).toFixed(1) + '" y2="' + (q.y - ny * 16).toFixed(1) + '" stroke="' + tcol + '" stroke-width="3" stroke-linecap="round"/>' +
                    '<circle cx="' + q.x.toFixed(1) + '" cy="' + q.y.toFixed(1) + '" r="4" fill="' + tcol + '" stroke="' + T.bg + '" stroke-width="1.5"/></g>');
                labs.push({ side: 1, x: q.x + 20, y: q.y, t: mk.label || '', c: tcol });
            } else if (mk.kind === 'packer') {
                [-1, 1].forEach(function (sd) { g.push('<rect x="' + (q.x + sd * nx * 13 - 4).toFixed(1) + '" y="' + (q.y + sd * ny * 13 - 4).toFixed(1) + '" width="8" height="8" fill="' + (mk.color || '#9ca3af') + '" stroke="' + T.bg + '"/>'); });
                labs.push({ side: 1, x: q.x + 20, y: q.y, t: mk.label || 'packer', c: mk.color || '#9ca3af' });
            }
        });
        // side labels: sorted by depth on each side and pushed apart (12 px), with a leader when moved
        [-1, 1].forEach(function (sd) {
            var L = labs.filter(function (l) { return l.side === sd; }).sort(function (a, b) { return a.y - b.y; }), prevY = -1e9;
            L.forEach(function (l) { l.ty = Math.max(l.y, prevY + 12); prevY = l.ty; });
            var over = L.length ? L[L.length - 1].ty - (mT + ah - 4) : 0;
            if (over > 0) L.forEach(function (l) { l.ty -= over; });
            L.forEach(function (l) {
                var tx = l.x + sd * 6;
                if (Math.abs(l.ty - l.y) > 2) g.push('<line x1="' + l.x.toFixed(1) + '" y1="' + l.y.toFixed(1) + '" x2="' + tx.toFixed(1) + '" y2="' + l.ty.toFixed(1) + '" stroke="' + l.c + '" stroke-opacity="0.6"/>');
                g.push('<text x="' + (tx + sd * 2).toFixed(1) + '" y="' + (l.ty + 3.5).toFixed(1) + '" fill="' + l.c + '" font-size="10" font-weight="700"' + (sd < 0 ? ' text-anchor="end"' : '') + '>' + _esc(l.t) + '</text>');
            });
        });
        // wellhead + choke
        var wh = path[0], ck = S.choke || {};
        g.push('<g class="wp-comp" data-comp="wellhead" tabindex="0" role="button" aria-label="Wellhead — surface settings"><rect x="' + (wh.x - 9).toFixed(1) + '" y="' + (mT - 30) + '" width="18" height="28" rx="2" fill="#374151" stroke="#9ca3af"/>' +
            '<rect x="' + (wh.x - 14).toFixed(1) + '" y="' + (mT - 20) + '" width="28" height="6" fill="#9ca3af"/></g>');
        if (ck.present !== false) {
            var cxp = wh.x + 22, cyp = mT - 17;
            g.push('<g class="wp-comp" data-comp="choke" tabindex="0" role="button" aria-label="' + _esc('Surface choke' + (_fin(ck.bean64) ? ' ' + ck.bean64 + '/64 in' : '') + ' — edit') + '">' +
                '<line x1="' + (wh.x + 14).toFixed(1) + '" x2="' + (cxp + 30).toFixed(1) + '" y1="' + cyp + '" y2="' + cyp + '" stroke="#9ca3af" stroke-width="3"/>' +
                '<path d="M' + cxp.toFixed(1) + ' ' + (cyp - 8) + 'l14 8l-14 8zM' + (cxp + 28).toFixed(1) + ' ' + (cyp - 8) + 'l-14 8l14 8z" fill="' + T.accent + '" stroke="' + T.bg + '"/>' +
                '<text x="' + (cxp + 34).toFixed(1) + '" y="' + (cyp + 4) + '" fill="' + T.accent + '" font-size="10" font-weight="700">' + _esc(_fin(ck.bean64) ? ck.bean64 + '/64' : 'choke') + '</text></g>');
        }
        // hover marker (moved by the page)
        g.push('<g class="wp-hover" pointer-events="none" style="display:none;pointer-events:none"><circle r="7" fill="none" stroke="' + T.text + '" stroke-width="2"/><circle r="2.5" fill="' + T.text + '"/></g>');

        // plan view + colour bar
        if (planW > 0 || pb > 0) {
            var px0 = narrow ? mL : secW + 12, pw = narrow ? pb - 40 : planW - 16, ph = narrow ? pb - 40 : Math.min(pw, Math.round(H0 * 0.42)), py0 = narrow ? H0 - pb + 18 : mT;
            var ns = traj.map(function (r) { return _fin(r.n) ? r.n : 0; }), es = traj.map(function (r) { return _fin(r.e) ? r.e : 0; });
            var span = Math.max(Math.max.apply(null, ns.map(Math.abs)), Math.max.apply(null, es.map(Math.abs)), tvdMax * 0.05, 1) * 1.15;
            var psx = function (e) { return px0 + pw / 2 + e / span * (pw / 2); }, psy = function (n) { return py0 + ph / 2 - n / span * (ph / 2); };
            g.push('<text x="' + px0 + '" y="' + (py0 - 10) + '" fill="' + T.text2 + '" font-size="10" font-weight="700">PLAN VIEW</text>');
            g.push('<rect x="' + px0 + '" y="' + py0 + '" width="' + pw + '" height="' + ph + '" rx="6" fill="' + T.panel + '" stroke="' + T.axis + '"/>');
            g.push('<line x1="' + (px0 + pw / 2) + '" x2="' + (px0 + pw / 2) + '" y1="' + py0 + '" y2="' + (py0 + ph) + '" stroke="' + T.grid + '"/><line y1="' + (py0 + ph / 2) + '" y2="' + (py0 + ph / 2) + '" x1="' + px0 + '" x2="' + (px0 + pw) + '" stroke="' + T.grid + '"/>');
            g.push('<text x="' + (px0 + pw / 2) + '" y="' + (py0 + 11) + '" fill="' + T.text2 + '" font-size="9" text-anchor="middle">N</text>');
            g.push('<text x="' + (px0 + pw - 4) + '" y="' + (py0 + ph / 2 - 3) + '" fill="' + T.text2 + '" font-size="9" text-anchor="end">E</text>');
            g.push('<path d="' + _poly(traj.map(function (r, i) { return [psx(es[i]), psy(ns[i])]; })) + '" fill="none" stroke="' + T.accent + '" stroke-width="2.5" stroke-linejoin="round"/>');
            g.push('<circle cx="' + psx(0).toFixed(1) + '" cy="' + psy(0).toFixed(1) + '" r="3.5" fill="' + T.text + '"/>');
            g.push('<circle cx="' + psx(es[es.length - 1]).toFixed(1) + '" cy="' + psy(ns[ns.length - 1]).toFixed(1) + '" r="4" fill="' + T.red + '"/>');
            g.push('<text x="' + px0 + '" y="' + (py0 + ph + 14) + '" fill="' + T.text2 + '" font-size="9">' + _esc((o.labels && o.labels.closure) || '') + '</text>');
            // colour bar
            var cbY = py0 + ph + 34, cbH = Math.max(80, H0 - cbY - mB - 30);
            if (narrow) { px0 = px0 + pw + 34; cbY = py0 + 6; cbH = ph - 6; }
            if (P2.key) {
                g.push('<text x="' + px0 + '" y="' + (cbY - 8) + '" fill="' + T.text2 + '" font-size="10" font-weight="700">' + _esc((o.labels && o.labels.prop) || sc2.label) + '</text>');
                if (P2.key === 'pattern') {
                    var seen = [];
                    prof.forEach(function (r) { var kk = _patternKey(r.pattern); if (seen.indexOf(kk) === -1) seen.push(kk); });
                    if (!seen.length) seen = ['unknown'];
                    seen.slice(0, 7).forEach(function (kk, j) {
                        g.push('<rect x="' + px0 + '" y="' + (cbY + j * 18) + '" width="14" height="12" rx="2" fill="' + PATTERN_COLORS[kk] + '"/><text x="' + (px0 + 20) + '" y="' + (cbY + j * 18 + 10) + '" fill="' + T.text + '" font-size="10">' + _esc(kk) + '</text>');
                    });
                } else {
                    g.push('<defs><linearGradient id="wpcb" x1="0" x2="0" y1="1" y2="0">' + RAMP.map(function (s) { return '<stop offset="' + s[0] + '" stop-color="rgb(' + s[1].join(',') + ')"/>'; }).join('') + '</linearGradient></defs>');
                    g.push('<rect x="' + px0 + '" y="' + cbY + '" width="14" height="' + cbH + '" rx="3" fill="url(#wpcb)"/>');
                    var ff = (fm[P2.key] || function (v) { return _fmtTick(v); });
                    [0, 0.5, 1].forEach(function (f) { g.push('<text x="' + (px0 + 20) + '" y="' + (cbY + cbH * (1 - f) + 4).toFixed(1) + '" fill="' + T.text + '" font-size="10">' + _esc(ff(sc2.lo + f * (sc2.hi - sc2.lo))) + '</text>'); });
                    if (o.prop === 'temperature' && prof0.some(function (r) { return _fin(r.te); })) {
                        g.push('<rect x="' + px0 + '" y="' + (cbY + cbH + 12) + '" width="14" height="10" rx="2" fill="' + colorFor('temperature', (sc2.lo + sc2.hi) / 2, sc2.lo, sc2.hi) + '" fill-opacity="0.32"/>');
                        g.push('<text x="' + (px0 + 20) + '" y="' + (cbY + cbH + 21) + '" fill="' + T.text2 + '" font-size="9">' + _esc((o.labels && o.labels.earth) || 'halo: earth (static)') + '</text>');
                    }
                }
            }
        }
        g.push('</svg>');
        // hover stations: the trajectory densified to ~ every 1 % of MD (screen coordinates in viewBox units)
        var pts = [], N = 120;
        for (var j = 0; j <= N; j++) { var mdj = mdMax * j / N, q2 = interp(path, mdj); pts.push({ x: q2.x, y: q2.y, md: mdj, i: j }); }
        return { svg: g.join(''), pts: pts, width: W0, height: H0, scale: sc2 };
    }

    G.WTS_wp_view = {
        chart: chart, redraw: redraw, schematic: schematic, colorFor: colorFor, PATTERN_COLORS: PATTERN_COLORS, scale: scale, interp: interp,
        patternKey: _patternKey, ramp: _ramp, ticks: _ticks, theme: _theme, esc: _esc, VERSION: '1.0.0'
    };
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis, V = G.WTS_wp_view, bad = [];
    try {
        var p = V.interp([{ md: 0, x: 0, y: 0 }, { md: 100, x: 0, y: 100 }], 50);
        if (Math.abs(p.y - 50) > 1e-9) bad.push('interp');
        var s = V.schematic({ trajectory: [{ md: 0, tvd: 0, n: 0, e: 0, dep: 0 }, { md: 1000, tvd: 1000, n: 0, e: 0, dep: 0 }], strings: [], profile: [] }, {});
        if (!/<svg/.test(s.svg) || s.pts.length !== 121) bad.push('schematic');
        if (V.colorFor('pattern', 'slug') !== V.PATTERN_COLORS.slug) bad.push('pattern colour');
    } catch (e) { bad.push('threw ' + e.message); }
    if (bad.length && typeof console !== 'undefined') console.error('[wp-view self-test] ' + bad.join('; '));
})();
