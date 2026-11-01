// ════════════════════════════════════════════════════════════════════
// WTS — Round-9 — Build-up Surveillance: PLOTS (window.WTS_buildup.plot)
// helper module: does not add a page to window.WTS_calcRegistry
//
// Plan: docs/BUILDUP-SURVEILLANCE-PLAN.md §3.11, §6.3 (WP6), D20.
//
//   loglog(canvas, {series:[{dt, y, kind:'dp'|'deriv'|'model', color, dash, mask, label}],
//                   band:{dt0, dt1}|null, markersNeg:[{dt, y}], xLabel, yLabel, title})
//       page-local log-log renderer (the host drawLineChart is linear only): decade grid,
//       points for data, lines for model curves, the IARF band shaded, negative-derivative
//       markers drawn as crosses at their absolute value (never logged as negative).
//   overlay(canvas, tests[, opts])  rate-normalised Δp/q and Δp′/q of every test
//       tests = [{id, dt:[], dpq:[], derivq:[], color?}]   (opts: xLabel, yLabel)
//   trend(canvas, spec)  time-axis chart through drawLineChart: spec = {datasets:[{label, color,
//       data:[{x,y}], dash, points, width}], thresholds:[{label, y, color, dash}], xLabel, yLabel,
//       yDec, xDec, xMin, xMax}; thresholds become 2-point datasets.
//
// Series arrive already converted to display units (the page uses WTS_units.convertCategory);
// labels arrive in display units too. Every renderer sets role="img" and an aria-label summary.
// Colours follow the host chart palette. Canvas only; no timers, no listeners.
// ════════════════════════════════════════════════════════════════════
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var B = G.WTS_buildup = G.WTS_buildup || {};
    var P = B.plot = B.plot || {};

    var BG = '#0d1117', GRID = '#21262d', TICK = '#6e7681', AXIS = '#8b949e';
    // distinct hues first (blue, orange, green, purple, red, yellow, cyan, pink), lighter variants after; beyond 8 series
    // the overlay also switches to open markers, so no two tests look alike
    var PALETTE = ['#58a6ff', '#f0883e', '#3fb950', '#d2a8ff', '#ff7b72', '#e3b341', '#39c5cf', '#f778ba', '#a5d6ff', '#ffa657', '#56d364', '#bc8cff'];
    var OPEN_FROM = 8;

    // A legend in a box (the background at 88 % opacity), so data and threshold lines never strike through the labels.
    // entries [{label, color, dash, kind: 'line'|'point'|'deriv'|'open'|'bar'}]; cover: rows to hide underneath (the
    // host legend's swatches).
    function _legend(c, entries, x0, y0, cover) {
        if (!c) return;
        var list = (entries || []).filter(function (e) { return e && e.label; });
        var rows = Math.max(list.length, cover || 0);
        if (!rows) return;
        c.font = '11px sans-serif';
        var w = 0;
        list.forEach(function (e) {
            var s = String(e.label), m = 0;
            try { m = (typeof c.measureText === 'function' && c.measureText(s)) ? c.measureText(s).width : 0; } catch (x) { m = 0; }
            w = Math.max(w, m || s.length * 6);
        });
        var a0 = c.globalAlpha;
        c.globalAlpha = 0.88; c.fillStyle = BG;
        c.fillRect(x0 - 6, y0 - 8, Math.max(40, w) + 30, rows * 16 + 6);
        c.globalAlpha = a0 == null ? 1 : a0;
        list.forEach(function (e, i) {
            var y = y0 + i * 16, col = e.color || PALETTE[i % PALETTE.length];
            c.strokeStyle = col; c.fillStyle = col; c.lineWidth = 2;
            if (typeof c.setLineDash === 'function') c.setLineDash(e.dash || []);
            if (e.kind === 'point' || e.kind === 'open') { c.beginPath(); c.arc(x0 + 6, y + 1.5, 3, 0, Math.PI * 2); if (e.kind === 'open') { c.lineWidth = 1.5; c.stroke(); } else c.fill(); }
            else if (e.kind === 'deriv') { c.beginPath(); c.moveTo(x0 + 6, y - 1.7); c.lineTo(x0 + 9, y + 3.9); c.lineTo(x0 + 3, y + 3.9); c.closePath(); c.fill(); }
            else if (e.kind === 'bar') { c.beginPath(); c.moveTo(x0 + 6, y - 4); c.lineTo(x0 + 6, y + 7); c.moveTo(x0 + 2, y - 4); c.lineTo(x0 + 10, y - 4); c.moveTo(x0 + 2, y + 7); c.lineTo(x0 + 10, y + 7); c.stroke(); }
            else { c.beginPath(); c.moveTo(x0, y + 1.5); c.lineTo(x0 + 12, y + 1.5); c.stroke(); }
            if (typeof c.setLineDash === 'function') c.setLineDash([]);
            c.fillStyle = AXIS; c.textAlign = 'left'; c.fillText(String(e.label), x0 + 16, y + 4);
        });
    }
    // Decimals that keep the 6 tick steps of a range distinct (drawLineChart widens y by 8 %, x by 5 %).
    function _autoDec(lo, hi, pad) {
        if (!_fin(lo) || !_fin(hi)) return 0;
        var r = (hi - lo) * (1 + 2 * pad);
        if (!(r > 0)) return 0;
        return Math.max(0, Math.min(4, Math.ceil(-Math.log(r / 6) / Math.LN10 + 1e-9)));
    }

    function _fin(x) { return typeof x === 'number' && isFinite(x); }
    function _ctx(cv) { try { return cv && typeof cv.getContext === 'function' ? cv.getContext('2d') : null; } catch (e) { return null; } }
    function _num(v, d) {
        if (!_fin(v)) return '—';
        try { return (typeof G.WTS_fmtNum === 'function') ? G.WTS_fmtNum(v, 0, d) : Number(v).toLocaleString(undefined, { maximumFractionDigits: d }); }
        catch (e) { return Number(v).toFixed(d); }
    }
    function _aria(cv, text) {
        if (!cv || typeof cv.setAttribute !== 'function') return;
        cv.setAttribute('role', 'img');
        cv.setAttribute('aria-label', String(text).slice(0, 400));
    }
    function _decTick(v) {
        var e = Math.round(Math.log(v) / Math.LN10);
        if (Math.abs(e) <= 3) return _num(Math.pow(10, e), Math.max(0, -e));
        return '1e' + e;
    }
    function _bounds(vals) {
        var lo = Infinity, hi = -Infinity;
        for (var i = 0; i < vals.length; i++) { var v = vals[i]; if (_fin(v) && v > 0) { if (v < lo) lo = v; if (v > hi) hi = v; } }
        if (!(lo < Infinity)) return null;
        var a = Math.floor(Math.log(lo) / Math.LN10), b = Math.ceil(Math.log(hi) / Math.LN10);
        if (b <= a) b = a + 1;
        return { lo: a, hi: b };
    }

    // ── log-log ──
    function loglog(cv, o) {
        o = o || {};
        var series = Array.isArray(o.series) ? o.series : [];
        var xs = [], ys = [], npts = 0;
        series.forEach(function (s) {
            var dt = s.dt || [], y = s.y || [];
            for (var i = 0; i < dt.length; i++) {
                if (s.mask && s.mask[i] === false) continue;
                if (_fin(dt[i]) && dt[i] > 0 && _fin(y[i]) && y[i] > 0) { xs.push(dt[i]); ys.push(y[i]); if (s.kind !== 'model') npts++; }
            }
        });
        (o.markersNeg || []).forEach(function (m) { if (m && _fin(m.dt) && m.dt > 0 && _fin(m.y) && Math.abs(m.y) > 0) { xs.push(m.dt); ys.push(Math.abs(m.y)); } });
        var label = 'Log-log chart of ' + (o.yLabel || 'pressure change and derivative') + ' against ' + (o.xLabel || 'shut-in time') + ': ' + npts + ' points';
        var c = _ctx(cv);
        if (!c) { _aria(cv, label); return { ok: false, points: npts }; }
        var W = cv.width || 720, H = cv.height || 300;
        var pad = { t: 24, r: 18, b: 46, l: 66 }, pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
        c.fillStyle = BG; c.fillRect(0, 0, W, H);
        var bx = _bounds(xs), by = _bounds(ys);
        if (!bx || !by) {
            c.fillStyle = TICK; c.font = '12px sans-serif'; c.textAlign = 'center';
            c.fillText('No data to plot', W / 2, H / 2);
            _aria(cv, label);
            return { ok: false, points: 0 };
        }
        var lx = function (v) { return pad.l + (Math.log(v) / Math.LN10 - bx.lo) / (bx.hi - bx.lo) * pw; };
        var ly = function (v) { return pad.t + ph - (Math.log(v) / Math.LN10 - by.lo) / (by.hi - by.lo) * ph; };
        // band
        if (o.band && _fin(o.band.dt0) && _fin(o.band.dt1) && o.band.dt1 > o.band.dt0 && o.band.dt0 > 0) {
            var x0 = Math.max(pad.l, lx(o.band.dt0)), x1 = Math.min(pad.l + pw, lx(o.band.dt1));
            if (x1 > x0) { c.fillStyle = 'rgba(63,185,80,0.12)'; c.fillRect(x0, pad.t, x1 - x0, ph); }
        }
        // grid
        c.strokeStyle = GRID; c.lineWidth = 1; c.font = '11px sans-serif'; c.fillStyle = TICK;
        var d, v, k;
        for (d = bx.lo; d <= bx.hi; d++) {
            v = Math.pow(10, d);
            c.beginPath(); c.moveTo(lx(v), pad.t); c.lineTo(lx(v), pad.t + ph); c.stroke();
            c.textAlign = 'center'; c.fillText(_decTick(v), lx(v), H - pad.b + 16);
            if (d < bx.hi) for (k = 2; k < 10; k++) { var xm = lx(k * v); c.strokeStyle = 'rgba(33,38,45,0.6)'; c.beginPath(); c.moveTo(xm, pad.t); c.lineTo(xm, pad.t + ph); c.stroke(); c.strokeStyle = GRID; }
        }
        for (d = by.lo; d <= by.hi; d++) {
            v = Math.pow(10, d);
            c.beginPath(); c.moveTo(pad.l, ly(v)); c.lineTo(pad.l + pw, ly(v)); c.stroke();
            c.textAlign = 'right'; c.fillText(_decTick(v), pad.l - 6, ly(v) + 4);
        }
        c.fillStyle = AXIS; c.font = '12px sans-serif'; c.textAlign = 'center';
        if (o.xLabel) c.fillText(o.xLabel, pad.l + pw / 2, H - 8);
        if (o.yLabel) { c.save(); c.translate(14, pad.t + ph / 2); c.rotate(-Math.PI / 2); c.fillText(o.yLabel, 0, 0); c.restore(); }
        // series
        series.forEach(function (s, si) {
            var col = s.color || PALETTE[si % PALETTE.length], dt = s.dt || [], y = s.y || [];
            if (s.kind === 'model') {
                c.strokeStyle = col; c.lineWidth = 2;
                if (typeof c.setLineDash === 'function') c.setLineDash(s.dash || []);
                c.beginPath();
                var started = false;
                for (var i = 0; i < dt.length; i++) {
                    if (!(_fin(dt[i]) && dt[i] > 0 && _fin(y[i]) && y[i] > 0)) { started = false; continue; }
                    if (!started) { c.moveTo(lx(dt[i]), ly(y[i])); started = true; } else c.lineTo(lx(dt[i]), ly(y[i]));
                }
                c.stroke();
                if (typeof c.setLineDash === 'function') c.setLineDash([]);
            } else {
                c.fillStyle = col; c.strokeStyle = col;
                for (var j = 0; j < dt.length; j++) {
                    if (s.mask && s.mask[j] === false) continue;
                    if (!(_fin(dt[j]) && dt[j] > 0 && _fin(y[j]) && y[j] > 0)) continue;
                    var px = lx(dt[j]), py = ly(y[j]);
                    c.beginPath();
                    if (s.kind === 'deriv') { c.moveTo(px, py - 3.2); c.lineTo(px + 3, py + 2.4); c.lineTo(px - 3, py + 2.4); c.closePath(); }
                    else c.arc(px, py, 2.6, 0, Math.PI * 2);
                    if (s.open) { c.lineWidth = 1.2; c.stroke(); } else c.fill();
                }
            }
        });
        // negative-derivative markers (crosses at |y|)
        c.strokeStyle = '#ff7b72'; c.lineWidth = 1.5;
        (o.markersNeg || []).forEach(function (m) {
            if (!(m && _fin(m.dt) && m.dt > 0 && _fin(m.y) && Math.abs(m.y) > 0)) return;
            var px = lx(m.dt), py = ly(Math.abs(m.y));
            c.beginPath(); c.moveTo(px - 3, py - 3); c.lineTo(px + 3, py + 3); c.moveTo(px + 3, py - 3); c.lineTo(px - 3, py + 3); c.stroke();
        });
        // legend (in a box, marker or line style per series)
        _legend(c, series.map(function (s, si) {
            return s.label ? { label: String(s.label), color: s.color || PALETTE[si % PALETTE.length], dash: s.dash,
                kind: s.kind === 'model' ? 'line' : (s.open ? 'open' : (s.kind === 'deriv' ? 'deriv' : 'point')) } : null;
        }), pad.l + 12, pad.t + 10, 0);
        var xr = 'over ' + (o.xLabel || 'time') + ' ' + _decTick(Math.pow(10, bx.lo)) + ' to ' + _decTick(Math.pow(10, bx.hi));
        _aria(cv, label + ', ' + xr + (o.band && _fin(o.band.dt0) ? ', IARF window shaded' : '') + '.');
        return { ok: true, points: npts };
    }

    // ── rate-normalised overlay ──
    function overlay(cv, tests, opts) {
        opts = opts || {};
        var series = [];
        (Array.isArray(tests) ? tests : []).forEach(function (t, i) {
            var col = t.color || PALETTE[i % PALETTE.length], open = i >= OPEN_FROM;   // beyond 8 tests: open markers too
            series.push({ dt: t.dt || [], y: t.dpq || [], kind: 'dp', color: col, open: open, label: String(t.id || ('Test ' + (i + 1))) });
            series.push({ dt: t.dt || [], y: t.derivq || [], kind: 'deriv', color: col, open: open });
        });
        var r = loglog(cv, { series: series, xLabel: opts.xLabel, yLabel: opts.yLabel || 'rate-normalised pressure change' });
        if (cv && typeof cv.setAttribute === 'function') {
            var n = (Array.isArray(tests) ? tests.length : 0);
            cv.setAttribute('aria-label', ('Rate-normalised overlay of ' + n + ' tests (the same derivative plateau means the same kh): ' + (r.points || 0) + ' points.').slice(0, 400));
        }
        return r;
    }

    // ── time-axis charts (drawLineChart) ──
    function _dlc() {
        if (typeof drawLineChart === 'function') return drawLineChart;   // eslint-disable-line no-undef
        return typeof G.drawLineChart === 'function' ? G.drawLineChart : null;
    }
    // drawLineChart's frame (host): pads 30/20/50/70 px and widens the given bounds by 5 % (x) and 8 % (y).
    function _frame(cv, b) {
        var W = cv.width || 720, H = cv.height || 300, pad = { t: 30, r: 20, b: 50, l: 70 }, pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
        var x0 = b.xMin, x1 = b.xMax, y0 = b.yMin, y1 = b.yMax;
        if (x0 === x1) x1 = x0 + 1;
        if (y0 === y1) y1 = y0 + 1;
        var xp = (x1 - x0) * 0.05, yp = (y1 - y0) * 0.08;
        x0 -= xp; x1 += xp; y0 -= yp; y1 += yp;
        return { x: function (v) { return pad.l + (v - x0) / (x1 - x0) * pw; }, y: function (v) { return pad.t + ph - (v - y0) / (y1 - y0) * ph; } };
    }
    function _minMax(a) {
        var lo = Infinity, hi = -Infinity;
        for (var i = 0; i < a.length; i++) { if (a[i] < lo) lo = a[i]; if (a[i] > hi) hi = a[i]; }
        return lo <= hi ? [lo, hi] : null;
    }
    // spec.datasets[].hollow: points drawn as open circles (for example excluded tests), no line;
    // spec.bars [{x, lo, hi}] (+ barsLabel, barsColor): vertical range bars with caps. Both are drawn over the
    // drawLineChart frame, with a legend entry each.
    function trend(cv, spec) {
        spec = spec || {};
        var ds = [], hollow = [], bars = [];
        (spec.datasets || []).forEach(function (d) {
            var data = (d.data || []).filter(function (p) { return p && _fin(p.x) && _fin(p.y); });
            if (!data.length) return;
            if (d.hollow) hollow.push({ label: d.label || '', color: d.color || '#8b949e', data: data });
            else ds.push({ label: d.label || '', color: d.color, data: data, dash: d.dash, points: d.points, width: d.width });
        });
        (spec.bars || []).forEach(function (b) { if (b && _fin(b.x) && _fin(b.lo) && _fin(b.hi)) bars.push({ x: b.x, lo: Math.min(b.lo, b.hi), hi: Math.max(b.lo, b.hi) }); });
        var xs = [], ys = [];
        ds.concat(hollow).forEach(function (d) { d.data.forEach(function (p) { xs.push(p.x); ys.push(p.y); }); });
        bars.forEach(function (b) { xs.push(b.x); ys.push(b.lo, b.hi); });
        var xr = _minMax(xs);
        var xMin = _fin(spec.xMin) ? spec.xMin : (xr ? xr[0] : 0);
        var xMax = _fin(spec.xMax) ? spec.xMax : (xr ? xr[1] : 1);
        (spec.thresholds || []).forEach(function (t) {
            if (t && _fin(t.y)) { ds.push({ label: t.label || '', color: t.color || '#8b949e', data: [{ x: xMin, y: t.y }, { x: xMax, y: t.y }], dash: t.dash || [6, 4], points: false, width: 1.5 }); ys.push(t.y); }
        });
        var yr = _minMax(ys);
        var n = 0;
        (spec.datasets || []).forEach(function (d) { n += (d.data || []).filter(function (p) { return p && _fin(p.x) && _fin(p.y); }).length; });
        var f = _dlc(), c = _ctx(cv);
        if (!ds.length && hollow.length) ds.push({ label: '', color: 'rgba(0,0,0,0)', data: hollow[0].data.slice(0, 1), points: false, width: 0.01 });   // a frame to draw on
        if (!ds.length || !c) {
            if (c) {
                var W = cv.width || 720, H = cv.height || 300;
                c.fillStyle = BG; c.fillRect(0, 0, W, H);
                c.fillStyle = TICK; c.font = '12px sans-serif'; c.textAlign = 'center';
                c.fillText('No data to plot', W / 2, H / 2);
            }
            _aria(cv, 'Chart of ' + (spec.yLabel || 'value') + ' against ' + (spec.xLabel || 'days') + ': no data.');
            return { ok: false, points: 0 };
        }
        if (f) {
            var bnd = { xMin: xMin, xMax: xMax, yMin: _fin(spec.yMin) ? spec.yMin : (yr ? yr[0] : 0), yMax: _fin(spec.yMax) ? spec.yMax : (yr ? yr[1] : 1) };
            // tick decimals: the caller's (a floor), raised until the 6 tick steps of the range read differently
            var o = { xLabel: spec.xLabel || '', yLabel: spec.yLabel || '',
                yDec: Math.max(_fin(spec.yDec) ? spec.yDec : 0, _autoDec(bnd.yMin, bnd.yMax, 0.08)),
                xDec: Math.max(_fin(spec.xDec) ? spec.xDec : 0, _autoDec(bnd.xMin, bnd.xMax, 0.05)) };
            o.xMin = bnd.xMin; o.xMax = bnd.xMax; o.yMin = bnd.yMin; o.yMax = bnd.yMax;
            // Our own boxed legend replaces drawLineChart's (drawn with blank labels underneath and covered): line and dash
            // style per series, open circles and range bars with their own symbols.
            var leg = ds.map(function (d) { return d.label ? { label: d.label, color: d.color, dash: d.dash, kind: d.points === false ? 'line' : (d.width != null && d.width < 0.1 ? 'point' : 'line') } : null; });
            hollow.forEach(function (h) { if (h.label) leg.push({ label: h.label + ' (open circles)', color: h.color, kind: 'open' }); });
            if (bars.length) leg.push({ label: spec.barsLabel || 'Range', color: spec.barsColor || '#79c0ff', kind: 'bar' });
            var hostDs = ds.map(function (d) { return { label: '', color: d.color, data: d.data, dash: d.dash, points: d.points, width: d.width }; });
            try {
                f(cv, hostDs, o);
                var fr = _frame(cv, bnd);
                if (typeof c.setLineDash === 'function') c.setLineDash([]);
                c.lineWidth = 1.5;
                c.strokeStyle = spec.barsColor || '#79c0ff';
                bars.forEach(function (b) {
                    var x = fr.x(b.x), ya = fr.y(b.lo), yb = fr.y(b.hi);
                    c.beginPath(); c.moveTo(x, ya); c.lineTo(x, yb); c.moveTo(x - 4, ya); c.lineTo(x + 4, ya); c.moveTo(x - 4, yb); c.lineTo(x + 4, yb); c.stroke();
                });
                hollow.forEach(function (h) {
                    c.strokeStyle = h.color;
                    h.data.forEach(function (p) { c.beginPath(); c.arc(fr.x(p.x), fr.y(p.y), 4, 0, Math.PI * 2); c.stroke(); });
                });
                _legend(c, leg, 80, 40, hostDs.length > 1 ? hostDs.length : 0);   // last, at drawLineChart's legend origin (pad.l + 10, pad.t + 10)
            } catch (e) { /* drawing is best effort */ }
        }
        // our own summary (the page's placeholder label is not one): series names and point counts
        var parts = (spec.datasets || []).filter(function (d) { return d && d.label; }).map(function (d) {
            return d.label + ' ' + (d.data || []).filter(function (p) { return p && _fin(p.x) && _fin(p.y); }).length;
        });
        if (bars.length) parts.push((spec.barsLabel || 'Range') + ' ' + bars.length);
        _aria(cv, 'Chart of ' + (spec.yLabel || 'value') + ' against ' + (spec.xLabel || 'days') + ': ' + n + ' points' + (parts.length ? ' (' + parts.join(', ') + ')' : '') + '.');
        return { ok: true, points: n };
    }

    P.loglog = loglog;
    P.overlay = overlay;
    P.trend = trend;
    P.PALETTE = PALETTE.slice();
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var P = G.WTS_buildup && G.WTS_buildup.plot;
    if (!P || typeof P.loglog !== 'function') return;
    var r = P.loglog(null, { series: [{ dt: [0.01, 0.1, 1], y: [1, 10, 20], kind: 'dp' }] });
    if (!r || r.points !== 3) { if (typeof console !== 'undefined') console.error('[buildup-plot self-test] FAILED: point count'); }
})();
