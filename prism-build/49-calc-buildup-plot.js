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
    var PALETTE = ['#58a6ff', '#f0883e', '#3fb950', '#d2a8ff', '#ff7b72', '#e3b341', '#79c0ff', '#56d364', '#ffa657', '#bc8cff', '#a5d6ff', '#f778ba'];

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
                    if (s.kind === 'deriv') { c.moveTo(px, py - 3.2); c.lineTo(px + 3, py + 2.4); c.lineTo(px - 3, py + 2.4); c.closePath(); c.fill(); }
                    else { c.arc(px, py, 2.6, 0, Math.PI * 2); c.fill(); }
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
        // legend
        var lgy = pad.t + 10;
        c.font = '11px sans-serif'; c.textAlign = 'left';
        series.forEach(function (s, si) {
            if (!s.label) return;
            c.fillStyle = s.color || PALETTE[si % PALETTE.length];
            c.fillRect(pad.l + 8, lgy - 3, 12, 3);
            c.fillStyle = AXIS; c.fillText(String(s.label), pad.l + 24, lgy + 1);
            lgy += 15;
        });
        var xr = 'over ' + (o.xLabel || 'time') + ' ' + _decTick(Math.pow(10, bx.lo)) + ' to ' + _decTick(Math.pow(10, bx.hi));
        _aria(cv, label + ', ' + xr + (o.band && _fin(o.band.dt0) ? ', IARF window shaded' : '') + '.');
        return { ok: true, points: npts };
    }

    // ── rate-normalised overlay ──
    function overlay(cv, tests, opts) {
        opts = opts || {};
        var series = [];
        (Array.isArray(tests) ? tests : []).forEach(function (t, i) {
            var col = t.color || PALETTE[i % PALETTE.length];
            series.push({ dt: t.dt || [], y: t.dpq || [], kind: 'dp', color: col, label: String(t.id || ('Test ' + (i + 1))) });
            series.push({ dt: t.dt || [], y: t.derivq || [], kind: 'deriv', color: col });
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
    function trend(cv, spec) {
        spec = spec || {};
        var ds = [];
        (spec.datasets || []).forEach(function (d) {
            var data = (d.data || []).filter(function (p) { return p && _fin(p.x) && _fin(p.y); });
            if (data.length) ds.push({ label: d.label || '', color: d.color, data: data, dash: d.dash, points: d.points, width: d.width });
        });
        var xs = [];
        ds.forEach(function (d) { d.data.forEach(function (p) { xs.push(p.x); }); });
        var xMin = _fin(spec.xMin) ? spec.xMin : (xs.length ? Math.min.apply(null, xs) : 0);
        var xMax = _fin(spec.xMax) ? spec.xMax : (xs.length ? Math.max.apply(null, xs) : 1);
        (spec.thresholds || []).forEach(function (t) {
            if (t && _fin(t.y)) ds.push({ label: t.label || '', color: t.color || '#8b949e', data: [{ x: xMin, y: t.y }, { x: xMax, y: t.y }], dash: t.dash || [6, 4], points: false, width: 1.5 });
        });
        var n = 0;
        (spec.datasets || []).forEach(function (d) { n += (d.data || []).filter(function (p) { return p && _fin(p.x) && _fin(p.y); }).length; });
        var f = _dlc(), c = _ctx(cv);
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
            var o = { xLabel: spec.xLabel || '', yLabel: spec.yLabel || '', yDec: _fin(spec.yDec) ? spec.yDec : 1, xDec: _fin(spec.xDec) ? spec.xDec : 0 };
            if (_fin(spec.yMin)) o.yMin = spec.yMin;
            if (_fin(spec.yMax)) o.yMax = spec.yMax;
            try { f(cv, ds, o); } catch (e) { /* drawing is best effort */ }
        }
        // drawLineChart writes its own summary; keep it when present, else ours
        if (!cv.getAttribute || !cv.getAttribute('aria-label')) _aria(cv, 'Chart of ' + (spec.yLabel || 'value') + ' against ' + (spec.xLabel || 'days') + ': ' + n + ' points.');
        else cv.setAttribute('role', 'img');
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
