// =============================================================================
// WTS — 49-calc-wd-view.js  (Round 9; helper module: no page in window.WTS_calcRegistry)
// -----------------------------------------------------------------------------
// Well Dynamics views (lane WD2; docs/WELL-DYNAMICS-PLAN.md §3.11, §6.4, §6.5): the animated wellbore along the true trajectory,
// the navigator, the cell close-up, the depth log, the time trends, the IPR / VLP plot with the live point, WHP against rate and
// the well-state strip. Pure drawing code: no storage, no engines, no timers, no polling, no function wrapping. Animation is
// driven only by the page's frame loop (each draw(frame) advances the particles by frame.dtWall). Field units come in (the
// engine state, §3.2); display units come from spec.units (default: WTS_wd_view.units(), which follows the units layer, so Metric
// works without the page converting the arrays).
//
//   WTS_wd_view.wellbore(canvas, spec) → V
//       spec = {grid, traj, strings, layer:'phase'|'regime'|'pressure'|'holdup'|'velocity', exaggerate:25, aspect:'true'|'fit',
//               view:'trajectory'|'schematic' (additive: schematic = MD straightened, one column), labels:true,
//               particles:{on:true, max:300}, reduced, fmt:{p, md, v, T}, units, liquid:'oil'|'condensate', w:360, h:480,
//               onHover(info|null), onSelect(i, how), onZoom(md0, md1)}
//       V = {draw(frame), setLayer(k), setZoom(md0, md1), setView(k), pick(x, y) → {i, cell, info} | null, select(i),
//            info(i) → info, infoLines(info) → [string], layout() → geometry (tests), zoom() → [md0, md1], destroy()}
//       frame = {t, cells:{p, T, ag, ao, aw, vg, vl, vm, vc, regime}, faces, markers:[{md, kind, state, label}], gasCapMd,
//                liquidTopMd, dtWall, playing}
//   WTS_wd_view.navigator(canvas, spec) → {draw(frame), setWindow(md0, md1), window(), destroy()}; spec.onWindow(md0, md1)
//   WTS_wd_view.closeUp(canvas, info, spec) → {lines}
//   WTS_wd_view.depthLog(canvas, frame, spec) → WTS_wp_view chart state (spec {grid, track:'pressure'|'velocity', units, markers})
//   WTS_wd_view.trend(canvas, rec, spec) → chart state (spec {keys, window:[t0, t1] s, cursor s, marks, units, onScrub(t, phase)})
//   WTS_wd_view.nodal(canvas, spec) → chart state (spec {curves:{ipr, vlp}, op:{q, p}, live:{q, p}, trail:[[q, p]], gas, units})
//   WTS_wd_view.whpRate(canvas, rec, spec), stateStrip(canvas, rec, spec) → {segments}
//   WTS_wd_view.STATE_COLORS (theme-aware, refreshed by stateColors()), units(system?), describe(frame, grid, U), REGIMES,
//   STATE_ORDER (fallback copies of the engine's frozen orders; the engine's own are used when it is loaded), CH_META.
//
// Particles are deterministic: a low-discrepancy sequence per cell, advanced by the visual velocity
// v_vis = sign(v)·min(1.5, 0.3·log10(1 + |v|/0.05)) cell lengths per wall second; never Math.random. Reduced motion → arrows only.
// =============================================================================
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;

    function _fin(v) { return typeof v === 'number' && isFinite(v); }
    function _clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
    function _frac(x) { return x - Math.floor(x); }
    function _WV() { return G.WTS_wp_view || null; }
    function _dpr() { var d = (typeof G.devicePixelRatio === 'number' && G.devicePixelRatio > 0) ? G.devicePixelRatio : 1; return Math.min(2, Math.max(1, d)); }

    // ── frozen orders (fallback copies; the engine's arrays win when present) ─────────────────────────────────
    var REGIMES = ['liquid', 'bubble', 'slug', 'churn', 'annular', 'mist', 'stratified', 'segregated', 'gas', 'unknown'];
    var STATE_ORDER = ['stable', 'startup', 'unloading', 'marginal', 'loading', 'heading', 'dying', 'dead', 'shutin', 'gl_unloading',
                       'gl_lifting', 'gl_multipoint', 'esp_off', 'esp_ramp', 'esp_running', 'esp_pumpoff', 'esp_gaslock', 'esp_tripped'];
    var STATE_LABELS = { stable: 'Stable', startup: 'Start-up', unloading: 'Unloading', marginal: 'Marginal', loading: 'Loading',
                         heading: 'Heading', dying: 'Dying', dead: 'Dead', shutin: 'Shut in', gl_unloading: 'GL unloading',
                         gl_lifting: 'GL lifting', gl_multipoint: 'GL multipoint', esp_off: 'ESP off', esp_ramp: 'ESP ramp',
                         esp_running: 'ESP running', esp_pumpoff: 'ESP pump-off', esp_gaslock: 'ESP gas lock', esp_tripped: 'ESP tripped' };
    function _regimes() { var E = G.WTS_wd_engine; return (E && E.REGIMES && E.REGIMES.length) ? E.REGIMES : REGIMES; }
    function _stateOrder() { var E = G.WTS_wd_engine; return (E && E.STATE_ORDER && E.STATE_ORDER.length) ? E.STATE_ORDER : STATE_ORDER; }
    function _stateLabel(k) { var E = G.WTS_wd_engine, s = E && E.STATES && E.STATES[k]; return (s && s.label) || STATE_LABELS[k] || String(k || '—'); }
    function _regName(code) {
        if (typeof code === 'string') return code;
        var R = _regimes(); return (_fin(code) && R[code]) ? R[code] : 'unknown';
    }

    // the channel table of §3.4 (display metadata only; the recorder's channels() wins when it lists a key)
    var CH_META = {
        t: ['time', 's', null], thp: ['THP', 'psig', 'pressureG'], tht: ['THT', '°F', 'temperature'], pwf: ['BHP', 'psia', 'pressure'],
        pr: ['p̄r', 'psia', 'pressure'], pcs: ['casing', 'psig', 'pressureG'], qo: ['q oil', 'STB/d', 'liquidRate'],
        qw: ['q water', 'STB/d', 'liquidRate'], qL: ['q liquid', 'STB/d', 'liquidRate'], qg: ['q gas', 'Mscf/d', 'gasRateSmall'],
        qo_res: ['q oil (sandface)', 'STB/d', 'liquidRate'], qw_res: ['q water (sandface)', 'STB/d', 'liquidRate'],
        qg_res: ['q gas (sandface)', 'Mscf/d', 'gasRateSmall'], gor: ['GOR', 'scf/STB', null], wc: ['water cut', '–', null],
        bean: ['bean', '/64 in', null], open: ['open', '–', null], state: ['state', '–', null], lratio: ['q / q_c', '–', null],
        qc: ['q_c', 'MMscf/d', 'gasRate'], liq: ['liquid in the well', 'bbl', 'volume'], gascap: ['gas cap', 'ft', 'length'],
        qinj: ['q inj', 'Mscf/d', 'gasRateSmall'], opValve: ['operating valve', '–', null], pint: ['pump intake', 'psia', 'pressure'],
        freq: ['frequency', 'Hz', null], load: ['motor load', '–', null], foam: ['foamer', 'ppm', null], dt: ['Δt', 's', null],
        massErr: ['mass error', '–', null], qgForm: ['q gas (formation)', 'Mscf/d', 'gasRateSmall'], gorForm: ['GOR (formation)', 'scf/STB', null],
        qvent: ['q vent', 'Mscf/d', 'gasRateSmall'], liftgas: ['lift gas in the tubing', 'Mscf', null],
        qcVert: ['q_c vertical', 'MMscf/d', 'gasRate'], qcBelfroid: ['q_c Belfroid', 'MMscf/d', 'gasRate']
    };

    // ── theme and colours ─────────────────────────────────────────────────────
    function _theme() {
        var W = _WV();
        if (W && typeof W.theme === 'function') return W.theme();
        return { bg: '#0d1117', panel: '#161b22', grid: 'rgba(139,148,158,0.16)', axis: '#3d444d', text: '#e6edf3', text2: '#8b949e',
                 accent: '#f0883e', green: '#3fb950', blue: '#58a6ff', purple: '#bc8cff', red: '#f85149', yellow: '#d29922', focus: '#58a6ff' };
    }
    var PATTERN_FALLBACK = { liquid: '#58a6ff', bubble: '#58a6ff', slug: '#bc8cff', churn: '#f0883e', annular: '#3fb950', mist: '#3fb950',
                             stratified: '#d29922', segregated: '#d29922', gas: '#e6edf3', unknown: '#6e7681' };
    function _patColor(name) { var W = _WV(), P = (W && W.PATTERN_COLORS) || PATTERN_FALLBACK; return P[name] || P.unknown || '#6e7681'; }
    function _ramp(f) { var W = _WV(); if (W && W.ramp) return W.ramp(f); var g = Math.round(60 + 160 * _clamp(f, 0, 1)); return 'rgb(' + g + ',' + g + ',200)'; }
    var STATE_COLORS = {};
    function stateColors() {
        var T = _theme();
        var map = { stable: T.green, startup: T.blue, unloading: T.purple, marginal: T.yellow, loading: T.accent, heading: T.yellow,
                    dying: T.red, dead: T.red, shutin: T.text2, gl_unloading: T.purple, gl_lifting: T.green, gl_multipoint: T.yellow,
                    esp_off: T.text2, esp_ramp: T.blue, esp_running: T.green, esp_pumpoff: T.yellow, esp_gaslock: T.accent, esp_tripped: T.red };
        Object.keys(map).forEach(function (k) { STATE_COLORS[k] = map[k]; });
        return STATE_COLORS;
    }
    stateColors();
    // phase colours (fixed hues that read on the dark panels and on paper)
    var PH = { gas: '#d7dde5', oil: '#c98a2e', water: '#3b82d6' };
    function _hex(c) {
        var m = /^#([0-9a-f]{6})$/i.exec(String(c || '').trim());
        if (m) { var n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
        m = /^rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(String(c || ''));
        if (m) return [+m[1], +m[2], +m[3]];
        return [128, 128, 128];
    }
    function _mix(a, b, f) { var A = _hex(a), B = _hex(b); f = _clamp(_fin(f) ? f : 0, 0, 1); return 'rgb(' + [0, 1, 2].map(function (k) { return Math.round(A[k] + (B[k] - A[k]) * f); }).join(',') + ')'; }
    function _alpha(c, a) { var A = _hex(c); return 'rgba(' + A[0] + ',' + A[1] + ',' + A[2] + ',' + a + ')'; }

    // ── units (display) ──────────────────────────────────────────────────────
    // units(system?) → converters {metric, p, pg, T, md, v, ql, qg, qgMM, vol, id, rho}: each {f(v) → display number, lab, dp}
    function units(system) {
        var U = G.WTS_units, C = U && U.CATEGORIES;
        var metric = system ? system === 'metric' : !!(U && U.getSystem && U.getSystem() === 'metric');
        function mk(cat, imp, dpI, dpM) {
            var ok = metric && C && C[cat] && U.convertCategory;
            return { cat: cat, lab: ok ? C[cat].metric.label : imp, dp: ok ? (dpM == null ? dpI : dpM) : dpI,
                     f: ok ? function (v) { return _fin(v) ? U.convertCategory(v, cat, 'imperial', 'metric') : v; } : function (v) { return v; } };
        }
        return { metric: !!(metric && C), p: mk('pressure', 'psia', 0, 0), pg: mk('pressureG', 'psig', 0, 0), T: mk('temperature', '°F', 0, 0),
                 md: mk('length', 'ft', 0, 0), v: mk('velocity', 'ft/s', 2, 2), ql: mk('liquidRate', 'STB/d', 0, 1), qg: mk('gasRateSmall', 'Mscf/d', 0, 0),
                 qgMM: mk('gasRate', 'MMscf/d', 3, 1), vol: mk('volume', 'bbl', 1, 2), id: mk('lengthSmall', 'in', 3, 1), cat: mk };
    }
    function _num(v, dp) {
        if (!_fin(v)) return '—';
        var s = Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: dp == null ? 2 : dp });
        return s === '-0' ? '0' : s;
    }
    function _ufmt(c, v, dp) { return _fin(v) ? _num(c.f(v), dp == null ? c.dp : dp) + ' ' + c.lab : '—'; }
    function _fmtT(s) {
        if (!_fin(s)) return '—';
        var neg = s < 0; s = Math.abs(Math.round(s));
        var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
        return (neg ? '−' : '') + h + ':' + (m < 10 ? '0' : '') + m + ':' + (x < 10 ? '0' : '') + x;
    }
    function _defaultFmt(U) {
        return { p: function (v) { return _ufmt(U.p, v); }, md: function (v) { return _ufmt(U.md, v); }, v: function (v) { return _ufmt(U.v, v); },
                 T: function (v) { return _ufmt(U.T, v); }, t: _fmtT };
    }

    // ── canvas sizing (fixed CSS sizes so a hidden panel and the report draw the same) ───────────────────────────
    function _size(cv, wDef, hDef, fixed) {
        var cw = (!fixed && cv.clientWidth > 100) ? cv.clientWidth : wDef;
        cw = Math.min(Math.round(cw), 1600);
        var ch = Math.round(hDef), dpr = _dpr(), W = Math.round(cw * dpr), H = Math.round(ch * dpr);
        if (cv.width !== W) cv.width = W;
        if (cv.height !== H) cv.height = H;
        if (cv.style) { if (cv.style.height !== ch + 'px') cv.style.height = ch + 'px'; if (fixed && cv.style.width !== cw + 'px') cv.style.width = cw + 'px'; }
        var ctx = cv.getContext && cv.getContext('2d');
        if (ctx && ctx.setTransform) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return { ctx: ctx, w: cw, h: ch, dpr: dpr };
    }
    function _font(px, w) { return (w || '') + ' ' + px + 'px -apple-system, Segoe UI, Roboto, sans-serif'; }

    // ── path along the trajectory ───────────────────────────────────────────────
    // traj rows {md, tvd, dep, n, e} → [{md, x (vertical section along the bottom-hole azimuth, else departure), y (TVD)}]
    function _path(traj, grid) {
        var rows = (traj || []).filter(function (r) { return r && _fin(r.md) && _fin(r.tvd); }).slice().sort(function (a, b) { return a.md - b.md; });
        if (rows.length < 2 && grid && grid.cells && grid.cells.length) {
            // no stations: rebuild from the cells (TVD exact; the horizontal step from the cell length and its TVD drop)
            var cs = grid.cells.slice().sort(function (a, b) { return Math.min(a.md0, a.md1) - Math.min(b.md0, b.md1); }), x = 0;
            rows = [{ md: Math.min(cs[0].md0, cs[0].md1), tvd: Math.min(cs[0].tvd0, cs[0].tvd1), dep: 0 }];
            cs.forEach(function (c) {
                var a = Math.min(c.md0, c.md1), b = Math.max(c.md0, c.md1), dz = Math.abs(c.tvd1 - c.tvd0);
                x += Math.sqrt(Math.max(0, (b - a) * (b - a) - dz * dz));
                rows.push({ md: b, tvd: Math.max(c.tvd0, c.tvd1), dep: x });
            });
        }
        var last = rows[rows.length - 1] || {}, az = (_fin(last.n) && _fin(last.e) && (Math.abs(last.n) + Math.abs(last.e) > 1e-6)) ? Math.atan2(last.e, last.n) : null;
        return rows.map(function (r) {
            var x = (az != null && _fin(r.n) && _fin(r.e)) ? r.n * Math.cos(az) + r.e * Math.sin(az) : (_fin(r.dep) ? r.dep : 0);
            return { md: r.md, x: x, y: r.tvd };
        });
    }
    function _at(path, md) {
        if (!path.length) return { x: 0, y: md };
        if (md <= path[0].md) { var a0 = path[0], b0 = path[1] || path[0], f0 = (b0.md > a0.md) ? (md - a0.md) / (b0.md - a0.md) : 0; return { x: a0.x + f0 * (b0.x - a0.x), y: a0.y + f0 * (b0.y - a0.y) }; }
        for (var i = 1; i < path.length; i++) {
            if (md <= path[i].md) { var a = path[i - 1], b = path[i], f = (b.md > a.md) ? (md - a.md) / (b.md - a.md) : 0; return { x: a.x + f * (b.x - a.x), y: a.y + f * (b.y - a.y) }; }
        }
        var n = path.length, p = path[n - 1], q = path[n - 2] || p, g = (p.md > q.md) ? (md - p.md) / (p.md - q.md) : 0;
        return { x: p.x + g * (p.x - q.x), y: p.y + g * (p.y - q.y) };
    }
    function _cellsOf(grid) { return (grid && grid.cells) || []; }
    function _mdRange(grid, path) {
        var lo = Infinity, hi = -Infinity;
        _cellsOf(grid).forEach(function (c) { lo = Math.min(lo, c.md0, c.md1); hi = Math.max(hi, c.md0, c.md1); });
        if (!_fin(lo)) { lo = path.length ? path[0].md : 0; hi = path.length ? path[path.length - 1].md : 1; }
        lo = Math.min(lo, path.length ? path[0].md : lo);
        return [lo, Math.max(hi, lo + 1)];
    }

    // ── layer colours ───────────────────────────────────────────────────────────
    function _cellArr(frame, k) { var c = frame && frame.cells; return c && c[k] ? c[k] : null; }
    function _val(a, i) { return a && _fin(a[i]) ? a[i] : NaN; }
    function _scaleOf(layer, frame, idx) {
        var key = layer === 'pressure' ? 'p' : layer === 'velocity' ? 'vm' : null;
        if (!key) return { lo: 0, hi: 1 };
        var a = _cellArr(frame, key) || (layer === 'velocity' ? _cellArr(frame, 'vg') : null), lo = Infinity, hi = -Infinity;
        (idx || []).forEach(function (i) { var v = _val(a, i); if (_fin(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } });
        if (!_fin(lo)) return { lo: 0, hi: 1 };
        if (layer === 'velocity') lo = Math.min(0, lo);
        if (hi - lo < 1e-9) { hi = lo + 1; }
        return { lo: lo, hi: hi };
    }
    function _phaseColor(ao, aw, liquid) { var t = (ao + aw) > 1e-12 ? ao / (ao + aw) : 0.5; return _mix(PH.water, PH.oil, t); }

    // ── wellbore ──────────────────────────────────────────────────────────────
    function wellbore(cv, spec) {
        spec = spec || {};
        var V = { cv: cv, spec: spec, layer: spec.layer || 'phase', view: spec.view === 'schematic' ? 'schematic' : 'trajectory',
                  zoomW: null, sel: -1, hov: -1, geo: null, geoKey: '', frame: null, offG: null, offL: null, ops: 0, destroyed: false, ls: [] };
        var path = _path(spec.traj || (spec.grid && spec.grid.traj), spec.grid);
        var full = _mdRange(spec.grid, path);
        var cells = _cellsOf(spec.grid), n = cells.length;
        V.offG = new Float64Array(n); V.offL = new Float64Array(n);
        var idMax = 0; cells.forEach(function (c) { if (_fin(c.id) && c.id > idMax) idMax = c.id; });
        if (!(idMax > 0)) idMax = 2.441;
        var U = spec.units || units();
        var fmt = Object.assign(_defaultFmt(U), spec.fmt || {});

        function win() { return V.zoomW || full; }
        function geom(w, h) {
            var Z = win(), key = [w, h, Z[0], Z[1], V.view, spec.aspect || 'true', spec.exaggerate || 25].join('|');
            if (V.geo && V.geoKey === key) return V.geo;
            var lab = spec.labels !== false, P = { x: 46, y: 26, w: Math.max(40, w - 46 - (lab ? 74 : 12)), h: Math.max(40, h - 26 - 12) };
            var g = { P: P, cells: [], w: w, h: h, md0: Z[0], md1: Z[1] };
            var toS, sEff, base;
            if (V.view === 'schematic') {
                var span = Math.max(1e-6, Z[1] - Z[0]);
                toS = function (md) { return { X: P.x + P.w / 2, Y: P.y + (md - Z[0]) / span * P.h }; };
                sEff = P.h / span; base = _clamp(0.3 * P.w, 24, 90);
            } else {
                var pts = [_at(path, Z[0]), _at(path, Z[1])];
                path.forEach(function (p) { if (p.md > Z[0] && p.md < Z[1]) pts.push(p); });
                var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
                pts.forEach(function (p) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); });
                var ys = Math.max(y1 - y0, 1), xs = Math.max(x1 - x0, 1), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, sx, sy;
                if (spec.aspect === 'fit') {
                    xs = Math.max(xs, 0.02 * ys); ys = Math.max(ys, 0.02 * xs);
                    sx = P.w * 0.9 / xs; sy = P.h * 0.94 / ys;
                } else { sx = sy = Math.min(P.w * 0.9 / xs, P.h * 0.94 / ys); }
                toS = function (md) { var q = _at(path, md); return { X: P.x + P.w / 2 + (q.x - cx) * sx, Y: P.y + P.h / 2 + (q.y - cy) * sy }; };
                sEff = Math.sqrt(sx * sy);
                base = spec.aspect === 'fit' ? _clamp(0.12 * Math.min(P.w, P.h), 14, 48) : _clamp(0.05 * Math.min(P.w, P.h), 9, 20);
            }
            g.toS = toS; g.scale = sEff;
            var exag = _fin(spec.exaggerate) ? spec.exaggerate : 25, maxW = 0.35 * Math.min(P.w, P.h);
            for (var i = 0; i < n; i++) {
                var c = cells[i], a = Math.min(c.md0, c.md1), b = Math.max(c.md0, c.md1);
                var vis = b > Z[0] && a < Z[1];
                var A = Math.max(a, Z[0]), B = Math.min(b, Z[1]);
                var id = _fin(c.id) && c.id > 0 ? c.id : idMax;
                var wpx = _clamp(Math.max(base * id / idMax, id / 12 * sEff * exag), 3, Math.max(4, maxW));
                if (!vis) { g.cells.push({ i: i, vis: false, a: a, b: b }); continue; }
                // centreline from the deep end (s = 0) to the shallow end (s = 1)
                var mds = [B];
                if (V.view !== 'schematic') for (var k = path.length - 1; k >= 0; k--) if (path[k].md < B && path[k].md > A) mds.push(path[k].md);
                mds.push(A);
                var pts2 = mds.map(function (m) { var q = toS(m); return [q.X, q.Y, m]; }), cum = [0];
                for (var j = 1; j < pts2.length; j++) cum.push(cum[j - 1] + Math.hypot(pts2[j][0] - pts2[j - 1][0], pts2[j][1] - pts2[j - 1][1]));
                var L = cum[cum.length - 1] || 1e-9;
                var nrm = pts2.map(function (p, j) {
                    var p0 = pts2[Math.max(0, j - 1)], p1 = pts2[Math.min(pts2.length - 1, j + 1)], dx = p1[0] - p0[0], dy = p1[1] - p0[1], l = Math.hypot(dx, dy);
                    if (!(l > 1e-9)) return [1, 0];
                    return [-dy / l, dx / l];
                });
                var mid = Math.floor(nrm.length / 2), dirx = pts2[pts2.length - 1][0] - pts2[0][0], diry = pts2[pts2.length - 1][1] - pts2[0][1], dl = Math.hypot(dirx, diry) || 1;
                g.cells.push({ i: i, vis: true, a: a, b: b, A: A, B: B, w: wpx, pts: pts2, cum: cum, L: L, nrm: nrm,
                               low: nrm[mid][1] >= 0 ? 1 : -1, ux: dirx / dl, uy: diry / dl,
                               incl: V.view === 'schematic' ? (_fin(c.inc) ? c.inc : 0) : Math.acos(_clamp(-diry / dl, -1, 1)) * 180 / Math.PI });
            }
            V.geo = g; V.geoKey = key;
            return g;
        }
        // point at (s along the cell from the deep end, u across from −1 to +1)
        function pt(gc, s, u) {
            var d = _clamp(s, 0, 1) * gc.L, k = 1;
            while (k < gc.cum.length - 1 && gc.cum[k] < d) k++;
            var c0 = gc.cum[k - 1], c1 = gc.cum[k], f = c1 > c0 ? (d - c0) / (c1 - c0) : 0;
            var p0 = gc.pts[k - 1], p1 = gc.pts[k] || p0, n0 = gc.nrm[k - 1], n1 = gc.nrm[k] || n0;
            var nx = n0[0] + f * (n1[0] - n0[0]), ny = n0[1] + f * (n1[1] - n0[1]), nl = Math.hypot(nx, ny) || 1;
            return [p0[0] + f * (p1[0] - p0[0]) + u * gc.w / 2 * nx / nl, p0[1] + f * (p1[1] - p0[1]) + u * gc.w / 2 * ny / nl];
        }
        function band(ctx, gc, s0, s1, u0, u1) {
            var ss = [s0];
            for (var k = 1; k < gc.cum.length - 1; k++) { var s = gc.cum[k] / gc.L; if (s > s0 && s < s1) ss.push(s); }
            ss.push(s1);
            ctx.beginPath();
            ss.forEach(function (s, j) { var q = pt(gc, s, u0); if (j) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); });
            for (var j = ss.length - 1; j >= 0; j--) { var q = pt(gc, ss[j], u1); ctx.lineTo(q[0], q[1]); }
            ctx.closePath(); ctx.fill();
        }
        function vVis(v) { if (!_fin(v) || v === 0) return 0; return (v > 0 ? 1 : -1) * Math.min(1.5, 0.3 * Math.log(1 + Math.abs(v) / 0.05) / Math.LN10); }

        function info(i) {
            var f = V.frame, c = cells[i];
            if (!c) return null;
            var g = function (k) { return _val(_cellArr(f, k), i); };
            var ag = g('ag'), ao = g('ao'), aw = g('aw'), vg = g('vg'), vc = g('vc');
            return { i: i, md: _fin(c.mdc) ? c.mdc : (c.md0 + c.md1) / 2, tvd: _fin(c.tvdc) ? c.tvdc : (c.tvd0 + c.tvd1) / 2, inc: c.inc, id: c.id, kind: c.kind,
                     p: g('p'), T: g('T'), ag: ag, ao: ao, aw: aw, aL: _fin(ag) ? 1 - ag : NaN, vg: vg, vl: g('vl'), vm: g('vm'), vc: vc,
                     ratio: (_fin(vg) && vc > 0) ? vg / vc : NaN, regime: _regName(_cellArr(f, 'regime') ? _cellArr(f, 'regime')[i] : null), t: f ? f.t : NaN };
        }
        function infoLines(x) {
            if (!x) return [];
            var pc = function (v) { return _fin(v) ? Math.round(v * 1000) / 10 + ' %' : '—'; };
            return ['MD ' + fmt.md(x.md) + ' · TVD ' + fmt.md(x.tvd), 'p ' + fmt.p(x.p) + ' · T ' + fmt.T(x.T),
                    'gas ' + pc(x.ag) + ' · oil ' + pc(x.ao) + ' · water ' + pc(x.aw),
                    'v_g ' + fmt.v(x.vg) + ' · v_L ' + fmt.v(x.vl), 'v_c ' + fmt.v(x.vc) + (_fin(x.ratio) ? ' (v_g / v_c ' + _num(x.ratio, 2) + ')' : ''),
                    'regime ' + x.regime];
        }

        function draw(frame) {
            if (V.destroyed) return V;
            if (frame) V.frame = frame;
            frame = V.frame || { t: NaN, cells: {} };
            var sz = _size(cv, spec.w || 360, spec.h || 480, !!spec.fixed), ctx = sz.ctx;
            if (!ctx) return V;
            var T = _theme(), g = geom(sz.w, sz.h), P = g.P, ops = 0;
            var dtw = _fin(frame.dtWall) && frame.dtWall > 0 ? Math.min(frame.dtWall, 0.25) : 0;
            ctx.fillStyle = T.bg; ctx.fillRect(0, 0, sz.w, sz.h); ops += 2;
            ctx.fillStyle = T.panel; ctx.fillRect(P.x, P.y, P.w, P.h); ops += 2;
            // depth ticks (TVD on the trajectory, MD on the schematic)
            var W = _WV(), ticks = [];
            ctx.font = _font(10); ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.lineWidth = 1; ctx.strokeStyle = T.grid; ctx.fillStyle = T.text2; ops += 6;
            if (V.view === 'schematic') {
                ticks = W && W.ticks ? W.ticks(U.md.f(g.md0), U.md.f(g.md1), 6, false) : [];
                ticks.forEach(function (tv) { var md = g.md0 + (tv - U.md.f(g.md0)) / ((U.md.f(g.md1) - U.md.f(g.md0)) || 1) * (g.md1 - g.md0), y = g.toS(md).Y; ctx.beginPath(); ctx.moveTo(P.x, y); ctx.lineTo(P.x + P.w, y); ctx.stroke(); ctx.fillText(_num(tv, 0), P.x - 4, y); ops += 5; });
            } else {
                var yT = g.toS(g.md0).Y, yB = g.toS(g.md1).Y, tv0 = _at(path, g.md0).y, tv1 = _at(path, g.md1).y;
                var lo = Math.min(tv0, tv1), hi = Math.max(tv0, tv1), yLo = Math.min(yT, yB), yHi = Math.max(yT, yB);
                if (hi - lo > 1) {
                    ticks = W && W.ticks ? W.ticks(U.md.f(lo), U.md.f(hi), 6, false) : [];
                    ticks.forEach(function (tv) { var y = yLo + (tv - U.md.f(lo)) / ((U.md.f(hi) - U.md.f(lo)) || 1) * (yHi - yLo); ctx.beginPath(); ctx.moveTo(P.x, y); ctx.lineTo(P.x + P.w, y); ctx.stroke(); ctx.fillText(_num(tv, 0), P.x - 4, y); ops += 5; });
                }
            }
            ctx.save(); ctx.translate(11, P.y + P.h / 2); if (ctx.rotate) ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText((V.view === 'schematic' ? 'MD' : 'TVD') + ' (' + U.md.lab + ')', 0, 0); ctx.restore(); ops += 6;

            var vis = g.cells.filter(function (c) { return c.vis; }), idx = vis.map(function (c) { return c.i; });
            var sc = _scaleOf(V.layer, frame, idx);
            var ag = _cellArr(frame, 'ag'), ao = _cellArr(frame, 'ao'), aw = _cellArr(frame, 'aw'), vg = _cellArr(frame, 'vg'), vl = _cellArr(frame, 'vl'), rg = _cellArr(frame, 'regime');
            var liqName = spec.liquid === 'condensate' ? 'condensate' : 'oil';
            // pipe wall
            ctx.fillStyle = T.axis; ops++;
            vis.forEach(function (gc) { band(ctx, gc, 0, 1, -1.18, 1.18); ops += 4 + gc.pts.length * 2; });
            var pOn = !spec.reduced && !(spec.particles && spec.particles.on === false), pMax = (spec.particles && _fin(spec.particles.max)) ? spec.particles.max : 300;
            // cell fills
            vis.forEach(function (gc) {
                var i = gc.i, a_g = _clamp(_fin(_val(ag, i)) ? ag[i] : 1, 0, 1), a_o = _clamp(_fin(_val(ao, i)) ? ao[i] : 0, 0, 1), a_w = _clamp(_fin(_val(aw, i)) ? aw[i] : 0, 0, 1);
                var aL = _clamp(1 - a_g, 0, 1), r = _regName(rg ? rg[i] : null), liqC = _phaseColor(a_o, a_w), k = 4 + gc.pts.length * 2;
                if (V.layer !== 'phase') {
                    var col = V.layer === 'regime' ? _patColor(r) : V.layer === 'holdup' ? _ramp(aL) :
                        _ramp((_val(_cellArr(frame, V.layer === 'pressure' ? 'p' : 'vm') || _cellArr(frame, 'vg'), i) - sc.lo) / (sc.hi - sc.lo));
                    if (!_fin(_val(_cellArr(frame, V.layer === 'pressure' ? 'p' : 'ag'), i)) && V.layer !== 'regime') col = '#6e7681';
                    ctx.fillStyle = col; band(ctx, gc, 0, 1, -1, 1); ops += 1 + k;
                    return;
                }
                if (!_fin(_val(ag, i))) { ctx.fillStyle = '#6e7681'; band(ctx, gc, 0, 1, -1, 1); ops += 1 + k; return; }
                var tw = 1.2 / Math.max(gc.w, 1);              // at least ~0.6 px of film on each wall
                if (r === 'stratified' || (r === 'segregated' && gc.incl > 60)) {
                    ctx.fillStyle = PH.gas; band(ctx, gc, 0, 1, -1, 1);
                    var lo = gc.low, uw = 2 * a_w, uo = 2 * a_o;
                    if (a_w > 0) { ctx.fillStyle = PH.water; band(ctx, gc, 0, 1, lo, lo * (1 - uw)); }
                    if (a_o > 0) { ctx.fillStyle = PH.oil; band(ctx, gc, 0, 1, lo * (1 - uw), lo * (1 - uw - uo)); }
                    ops += 3 * (1 + k);
                } else if (r === 'segregated') {
                    ctx.fillStyle = PH.gas; band(ctx, gc, 0, 1, -1, 1);
                    if (a_w > 0) { ctx.fillStyle = PH.water; band(ctx, gc, 0, a_w, -1, 1); }
                    if (a_o > 0) { ctx.fillStyle = PH.oil; band(ctx, gc, a_w, a_w + a_o, -1, 1); }
                    ops += 3 * (1 + k);
                } else if (r === 'annular' || r === 'mist' || r === 'gas') {
                    ctx.fillStyle = PH.gas; band(ctx, gc, 0, 1, -1, 1); ops += 1 + k;
                    if (aL > 1e-4) { var ft = Math.max(tw, aL * (r === 'mist' ? 0.6 : 1)); ctx.fillStyle = liqC; band(ctx, gc, 0, 1, -1, -1 + ft); band(ctx, gc, 0, 1, 1 - ft, 1); ops += 1 + 2 * k; }
                } else {
                    ctx.fillStyle = liqC; band(ctx, gc, 0, 1, -1, 1); ops += 1 + k;
                    if (a_g > 0.005 && (r === 'churn' || r === 'unknown' || !pOn)) { ctx.fillStyle = _alpha(PH.gas, 0.55); band(ctx, gc, 0, 1, -a_g, a_g); ops += 1 + k; }
                }
            });
            // particles (deterministic) or arrows (reduced motion)
            if (pOn && pMax > 0 && vis.length) {
                var totL = vis.reduce(function (s, gc) { return s + gc.L; }, 0) || 1, bub = [], drp = [], rip = [], tay = [];
                vis.forEach(function (gc) {
                    var i = gc.i;
                    V.offG[i] = _frac(V.offG[i] + vVis(_val(vg, i)) * dtw);
                    V.offL[i] = _frac(V.offL[i] + vVis(_val(vl, i)) * dtw);
                    var a_g = _clamp(_fin(_val(ag, i)) ? ag[i] : 0, 0, 1), aL = 1 - a_g, r = _regName(rg ? rg[i] : null);
                    var nC = Math.min(Math.floor(gc.L / 2.5), Math.floor(pMax * gc.L / totL));
                    if (nC < 1) return;
                    var j, s, u, lc = _phaseColor(_val(ao, i) || 0, _val(aw, i) || 0);
                    if (r === 'annular' || r === 'mist' || r === 'gas') {
                        var nr = (r === 'gas' || nC < 2) ? 0 : Math.max(1, Math.round(nC / 3)), nd = Math.min(nC - nr, Math.round(nC * Math.min(1, aL * 25)));
                        for (j = 0; j < nd; j++) { s = _frac(_frac(j * 0.6180339887 + i * 0.3819660113) + V.offG[i]); u = (_frac(j * 0.7548776662 + i * 0.5698402910) * 2 - 1) * 0.6; drp.push([gc, s, u, lc]); }
                        for (j = 0; j < nr; j++) { s = _frac(_frac(j * 0.6180339887 + i * 0.1324717957) + V.offL[i]); rip.push([gc, s, (j % 2 ? 1 : -1) * (1 - Math.max(0.04, aL) / 2), lc]); }
                    } else if (r === 'stratified' || r === 'segregated') {
                        var nb = Math.round(nC * 0.3);
                        for (j = 0; j < nb; j++) { s = _frac(_frac(j * 0.6180339887 + i * 0.3819660113) + V.offL[i]); rip.push([gc, s, r === 'segregated' ? (j % 2 ? 0.5 : -0.5) : gc.low * (1 - Math.min(1, 2 * aL)), lc]); }
                    } else {
                        if (r === 'slug' && a_g > 0.05 && gc.L > gc.w * 1.5) tay.push([gc, V.offG[i], Math.min(0.85, 0.25 + 0.6 * a_g)]);
                        var nbb = Math.round(nC * Math.min(1, a_g * (r === 'slug' ? 1.2 : 2.5)));
                        for (j = 0; j < nbb; j++) { s = _frac(_frac(j * 0.6180339887 + i * 0.3819660113) + V.offG[i]); u = (_frac(j * 0.7548776662 + i * 0.5698402910) * 2 - 1) * 0.7; bub.push([gc, s, u]); }
                    }
                });
                // Taylor bubbles (slug flow): one per cell, moving at the gas velocity, wrapping around the cell
                if (tay.length) {
                    ctx.fillStyle = _alpha(PH.gas, 0.9); ops++;
                    tay.forEach(function (t) { var s0 = t[1], ln = t[2], s1 = s0 + ln; if (s1 <= 1) band(ctx, t[0], s0, s1, -0.72, 0.72); else { band(ctx, t[0], s0, 1, -0.72, 0.72); band(ctx, t[0], 0, s1 - 1, -0.72, 0.72); } ops += 12; });
                }
                if (bub.length) {
                    ctx.fillStyle = _alpha(PH.gas, 0.95); ctx.beginPath(); ops += 3;
                    bub.forEach(function (b) { var q = pt(b[0], b[1], b[2]), r = _clamp(b[0].w * 0.1, 1, 3.5); ctx.moveTo(q[0] + r, q[1]); if (ctx.arc) ctx.arc(q[0], q[1], r, 0, Math.PI * 2); ops += 2; });
                    ctx.fill();
                }
                if (drp.length) {
                    drp.forEach(function (d) { var q = pt(d[0], d[1], d[2]), r = _clamp(d[0].w * 0.06, 0.8, 2.2); ctx.fillStyle = d[3]; ctx.beginPath(); if (ctx.arc) ctx.arc(q[0], q[1], r, 0, Math.PI * 2); ctx.fill(); ops += 4; });
                }
                if (rip.length) {
                    ctx.lineWidth = 1.4; ops++;
                    rip.forEach(function (rp) { var gc = rp[0], q0 = pt(gc, rp[1], rp[2]), q1 = pt(gc, Math.min(1, rp[1] + Math.min(0.25, 6 / gc.L)), rp[2]); ctx.strokeStyle = _alpha(_mix(rp[3], '#ffffff', 0.45), 0.9); ctx.beginPath(); ctx.moveTo(q0[0], q0[1]); ctx.lineTo(q1[0], q1[1]); ctx.stroke(); ops += 5; });
                }
            } else if (vis.length) {
                // arrows: gas velocity direction at the cell centres, at least 18 px apart
                var lastY = -1e9, lastX = -1e9;
                ctx.strokeStyle = T.text; ctx.lineWidth = 1.5; ops += 2;
                vis.forEach(function (gc) {
                    var v = _val(vg, gc.i); if (!(_fin(v) && Math.abs(v) > 0.05)) return;
                    var c = pt(gc, 0.5, 0); if (Math.hypot(c[0] - lastX, c[1] - lastY) < 18) return;
                    lastX = c[0]; lastY = c[1];
                    var sgn = v > 0 ? 1 : -1, ux = gc.ux * sgn, uy = gc.uy * sgn, L = Math.min(9, gc.w * 0.45 + 3);
                    ctx.beginPath(); ctx.moveTo(c[0] - ux * L, c[1] - uy * L); ctx.lineTo(c[0] + ux * L, c[1] + uy * L);
                    ctx.moveTo(c[0] + ux * L, c[1] + uy * L); ctx.lineTo(c[0] + ux * L * 0.3 - uy * 4, c[1] + uy * L * 0.3 + ux * 4);
                    ctx.moveTo(c[0] + ux * L, c[1] + uy * L); ctx.lineTo(c[0] + ux * L * 0.3 + uy * 4, c[1] + uy * L * 0.3 - ux * 4); ctx.stroke(); ops += 9;
                });
            }
            // interfaces when shut in: liquid top and gas cap
            function across(md, color, label, dash) {
                if (!_fin(md) || md < g.md0 || md > g.md1) return;
                var gc = null; vis.forEach(function (c) { if (md >= c.a && md <= c.b) gc = c; });
                if (!gc) return;
                var s = gc.B > gc.A ? (gc.B - md) / (gc.B - gc.A) : 0.5, q0 = pt(gc, s, -1.5), q1 = pt(gc, s, 1.5);
                ctx.strokeStyle = color; ctx.lineWidth = 2; if (ctx.setLineDash) ctx.setLineDash(dash ? [4, 3] : []);
                ctx.beginPath(); ctx.moveTo(q0[0], q0[1]); ctx.lineTo(q1[0], q1[1]); ctx.stroke(); if (ctx.setLineDash) ctx.setLineDash([]);
                ctx.fillStyle = color; ctx.font = _font(10, '600'); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
                ctx.fillText(label, Math.max(q0[0], q1[0]) + 4, (q0[1] + q1[1]) / 2 - 7); ops += 14;
            }
            across(frame.liquidTopMd, PH.water, 'liquid top', false);
            across(frame.gasCapMd, T.yellow, 'gas cap', true);
            // markers
            (frame.markers || []).forEach(function (mk) {
                if (!mk || !_fin(mk.md) || mk.md < g.md0 || mk.md > g.md1) return;
                var gc = null; vis.forEach(function (c) { if (mk.md >= c.a && mk.md <= c.b) gc = c; });
                if (!gc) return;
                var s = gc.B > gc.A ? (gc.B - mk.md) / (gc.B - gc.A) : 0.5, c0 = pt(gc, s, 0), l = pt(gc, s, -1.3), r = pt(gc, s, 1.3), k = mk.kind;
                if (k === 'perf') {
                    ctx.strokeStyle = T.red; ctx.lineWidth = 2; ctx.beginPath();
                    [-1, 1].forEach(function (sd) { var a1 = pt(gc, s, sd * 1.25), a2 = pt(gc, s, sd * 1.9); ctx.moveTo(a1[0], a1[1]); ctx.lineTo(a2[0], a2[1]); });
                    ctx.stroke(); ops += 8;
                } else if (k === 'pump') {
                    ctx.fillStyle = mk.state === 'off' ? T.text2 : T.accent; ctx.beginPath(); ctx.moveTo(l[0], l[1]); ctx.lineTo(r[0], r[1]);
                    var r2 = pt(gc, Math.min(1, s + 6 / gc.L), 1.3), l2 = pt(gc, Math.min(1, s + 6 / gc.L), -1.3); ctx.lineTo(r2[0], r2[1]); ctx.lineTo(l2[0], l2[1]); ctx.closePath(); ctx.fill(); ops += 8;
                } else if (k === 'valve') {
                    var vc = mk.state === 'open' ? T.green : mk.state === 'passing' ? T.yellow : T.text2, q = pt(gc, s, 1.55);
                    ctx.fillStyle = vc; ctx.beginPath(); ctx.moveTo(q[0], q[1] - 4); ctx.lineTo(q[0] + 4, q[1]); ctx.lineTo(q[0], q[1] + 4); ctx.lineTo(q[0] - 4, q[1]); ctx.closePath(); ctx.fill(); ops += 9;
                } else if (k === 'gauge') {
                    var qg = pt(gc, s, -1.6); ctx.strokeStyle = T.blue; ctx.lineWidth = 1.5; ctx.beginPath(); if (ctx.arc) ctx.arc(qg[0], qg[1], 3.5, 0, Math.PI * 2); ctx.stroke(); ops += 5;
                } else if (k === 'restr') {
                    ctx.fillStyle = T.text2; [-1, 1].forEach(function (sd) { var a1 = pt(gc, s - 3 / gc.L, sd), a2 = pt(gc, s, sd * 0.55), a3 = pt(gc, s + 3 / gc.L, sd); ctx.beginPath(); ctx.moveTo(a1[0], a1[1]); ctx.lineTo(a2[0], a2[1]); ctx.lineTo(a3[0], a3[1]); ctx.closePath(); ctx.fill(); }); ops += 12;
                } else {           // eot and anything else: a bar across
                    ctx.strokeStyle = T.text; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(l[0], l[1]); ctx.lineTo(r[0], r[1]); ctx.stroke(); ops += 5;
                }
                if (mk.label && spec.labels !== false) { ctx.fillStyle = T.text2; ctx.font = _font(9); ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(String(mk.label).slice(0, 18), Math.min(l[0], r[0]) - 6, c0[1]); ops += 5; }
            });
            // regime labels: one per run of equal regime, at the middle of the run, right of the pipe, no overlaps
            if (spec.labels !== false && rg) {
                var boxes = [], runs = [], cur = null;
                vis.slice().sort(function (a, b) { return b.B - a.B; }).forEach(function (gc) {
                    var r = _regName(rg[gc.i]);
                    if (cur && cur.r === r) { cur.cells.push(gc); cur.L += gc.L; } else { cur = { r: r, cells: [gc], L: gc.L }; runs.push(cur); }
                });
                ctx.font = _font(10, '600'); ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ops += 3;
                runs.slice().sort(function (a, b) { return b.L - a.L; }).forEach(function (run) {
                    if (run.L < 6) return;
                    var gc = run.cells[Math.floor(run.cells.length / 2)], q1 = pt(gc, 0.5, 1), q2 = pt(gc, 0.5, -1);
                    var x = Math.max(q1[0], q2[0]) + 8, y = (q1[1] + q2[1]) / 2, tw = run.r.length * 6 + 4;
                    if (x + tw > sz.w - 2) x = sz.w - 2 - tw;
                    if (Math.abs(q1[1] - q2[1]) > Math.abs(q1[0] - q2[0])) { y = Math.max(q1[1], q2[1]) + 9; x = (q1[0] + q2[0]) / 2 - tw / 2; }   // a level stretch: label below
                    x = _clamp(x, P.x + 2, sz.w - 2 - tw);
                    var bx = { x0: x, x1: x + tw, y0: y - 7, y1: y + 7 };
                    if (bx.y1 > sz.h - 1 || bx.y0 < P.y - 6) return;
                    if (boxes.some(function (o) { return o.x0 < bx.x1 && o.x1 > bx.x0 && o.y0 < bx.y1 && o.y1 > bx.y0; })) return;
                    boxes.push(bx);
                    ctx.fillStyle = _patColor(run.r); ctx.fillText(run.r, x, y); ops += 2;
                });
                V.labelBoxes = boxes;
            }
            // hover and selection outlines
            [[V.hov, T.text2, [3, 2]], [V.sel, T.focus, []]].forEach(function (h) {
                var gc = g.cells[h[0]];
                if (!gc || !gc.vis) return;
                ctx.strokeStyle = h[1]; ctx.lineWidth = 2; if (ctx.setLineDash) ctx.setLineDash(h[2]);
                var q = [pt(gc, 0, -1.25), pt(gc, 1, -1.25), pt(gc, 1, 1.25), pt(gc, 0, 1.25)];
                ctx.beginPath(); q.forEach(function (p, j) { if (j) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }); ctx.closePath(); ctx.stroke(); if (ctx.setLineDash) ctx.setLineDash([]); ops += 10;
            });
            // header: time, layer legend
            ctx.font = _font(11, '600'); ctx.fillStyle = T.text; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
            ctx.fillText((fmt.t || _fmtT)(frame.t), 6, 15); ops += 5;
            var lx = sz.w - 6; ctx.textAlign = 'right'; ctx.font = _font(9);
            var legend = V.layer === 'phase' ? [['gas', PH.gas], [liqName, PH.oil], ['water', PH.water]] :
                V.layer === 'regime' ? [] :
                [[V.layer === 'pressure' ? fmt.p(sc.lo) + ' – ' + fmt.p(sc.hi) : V.layer === 'holdup' ? 'holdup 0 – 1' : fmt.v(sc.lo) + ' – ' + fmt.v(sc.hi), null]];
            legend.forEach(function (it) {
                var tw = (ctx.measureText ? ctx.measureText(it[0]).width : it[0].length * 5);
                ctx.fillStyle = T.text2; ctx.fillText(it[0], lx, 15); ops += 2;
                if (it[1]) { ctx.fillStyle = it[1]; ctx.fillRect(lx - tw - 11, 8, 8, 8); ops += 2; lx -= tw + 18; }
                else {
                    var gw = 40; for (var q = 0; q < 8; q++) { ctx.fillStyle = _ramp(q / 7); ctx.fillRect(lx - tw - gw - 6 + q * gw / 8, 8, gw / 8 + 0.5, 8); ops += 2; }
                    lx -= tw + gw + 12;
                }
            });
            if (V.zoomW) { ctx.fillStyle = T.accent; ctx.textAlign = 'left'; ctx.font = _font(9); ctx.fillText('zoom ' + fmt.md(V.zoomW[0]) + ' – ' + fmt.md(V.zoomW[1]), P.x + 2, sz.h - 2); ops += 4; }
            V.ops = ops;
            if (cv.setAttribute && spec.aria !== false) { try { cv.setAttribute('aria-label', describe(frame, spec.grid, U, { liquid: liqName })); } catch (e) { /* ignore */ } }
            return V;
        }

        function pick(x, y) {
            var g = V.geo; if (!g) return null;
            var best = null, bd = Infinity;
            g.cells.forEach(function (gc) {
                if (!gc.vis) return;
                for (var k = 1; k < gc.pts.length; k++) {
                    var a = gc.pts[k - 1], b = gc.pts[k], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
                    var f = l2 > 0 ? _clamp(((x - a[0]) * dx + (y - a[1]) * dy) / l2, 0, 1) : 0, d = Math.hypot(x - a[0] - f * dx, y - a[1] - f * dy);
                    if (d < bd && d <= gc.w / 2 + 6) { bd = d; best = gc.i; }
                }
            });
            return best == null ? null : { i: best, cell: cells[best], info: info(best) };
        }
        function select(i) { V.sel = (_fin(i) && i >= 0 && i < n) ? i : -1; draw(); return V.sel; }
        function setZoom(a, b) {
            if (!_fin(a) || !_fin(b) || Math.abs(b - a) < 1) { V.zoomW = null; }
            else { var lo = Math.max(full[0], Math.min(a, b)), hi = Math.min(full[1], Math.max(a, b)); V.zoomW = (hi - lo >= full[1] - full[0] - 1e-6) ? null : [lo, Math.max(hi, lo + 20)]; }
            V.geo = null; draw();
            var w = win(); if (spec.onZoom) spec.onZoom(w[0], w[1]);
            return w;
        }
        function zoomAt(md, factor) {
            var w = win(), span = Math.max(40, (w[1] - w[0]) * factor), f = (w[1] - w[0]) > 0 ? (md - w[0]) / (w[1] - w[0]) : 0.5;
            var a = md - f * span, b = a + span;
            if (a < full[0]) { b += full[0] - a; a = full[0]; }
            if (b > full[1]) { a -= b - full[1]; b = full[1]; }
            return setZoom(Math.max(full[0], a), b);
        }
        // pointer, wheel and keyboard (bound once; removed by destroy)
        function on(t, f, o) { if (cv.addEventListener) { cv.addEventListener(t, f, o || false); V.ls.push([t, f, o || false]); } }
        function pos(e) { var r = cv.getBoundingClientRect ? cv.getBoundingClientRect() : { left: 0, top: 0 }; return { x: (e.clientX || 0) - (r.left || 0), y: (e.clientY || 0) - (r.top || 0) }; }
        var drag = null;
        on('pointermove', function (e) {
            var p = pos(e);
            if (drag) {
                var hit0 = drag.md, hp = pick(p.x, p.y);
                if (hp && V.zoomW) { var d = hit0 - (hp.info ? hp.info.md : hit0); if (Math.abs(d) > 0) { var w = win(); drag.moved = true; setZoom(w[0] + d, w[1] + d); } }
                return;
            }
            var h = pick(p.x, p.y), hi = h ? h.i : -1;
            if (hi !== V.hov) { V.hov = hi; draw(); }
            if (spec.onHover) spec.onHover(h ? h.info : null);
        });
        on('pointerleave', function () { if (V.hov !== -1) { V.hov = -1; draw(); } if (spec.onHover) spec.onHover(null); drag = null; });
        on('pointerdown', function (e) { var p = pos(e), h = pick(p.x, p.y); drag = h ? { md: h.info.md, moved: false } : null; });
        on('pointerup', function (e) {
            var p = pos(e), h = pick(p.x, p.y), d = drag; drag = null;
            if (d && d.moved) return;
            if (h) { select(h.i); if (spec.onSelect) spec.onSelect(h.i, 'click'); }
        });
        on('wheel', function (e) {
            var focused = typeof document !== 'undefined' && document.activeElement === cv;
            if (!focused && !e.ctrlKey) return;
            if (e.preventDefault) e.preventDefault();
            var p = pos(e), h = pick(p.x, p.y), w = win(), md = h ? h.info.md : (w[0] + w[1]) / 2;
            zoomAt(md, (e.deltaY || 0) > 0 ? 1.4 : 1 / 1.4);
        }, { passive: false });
        on('keydown', function (e) {
            var k = e.key, cur = V.sel >= 0 ? V.sel : (n ? n - 1 : -1), hit = false;
            if (k === 'ArrowUp' && n) { select(Math.min(n - 1, cur + (V.sel >= 0 ? 1 : 0))); hit = true; }
            else if (k === 'ArrowDown' && n) { select(Math.max(0, cur - 1)); hit = true; }
            else if (k === 'Enter' && V.sel >= 0) { if (spec.onSelect) spec.onSelect(V.sel, 'key'); hit = true; }
            else if (k === 'Escape' && V.sel >= 0) { select(-1); hit = true; }
            else if (k === '0') { setZoom(null, null); hit = true; }
            else if (k === '+' || k === '=' || k === '-') { var w = win(), md = V.sel >= 0 ? info(V.sel).md : (w[0] + w[1]) / 2; zoomAt(md, k === '-' ? 1.5 : 1 / 1.5); hit = true; }
            if (hit) {
                if (e.preventDefault) e.preventDefault();
                if ((k === 'ArrowUp' || k === 'ArrowDown') && spec.onHover) spec.onHover(info(V.sel));
            }
        });

        V.draw = draw;
        V.setLayer = function (k) { if (['phase', 'regime', 'pressure', 'holdup', 'velocity'].indexOf(k) !== -1) { V.layer = k; draw(); } return V.layer; };
        V.setView = function (k) { V.view = k === 'schematic' ? 'schematic' : 'trajectory'; V.geo = null; draw(); return V.view; };
        V.setZoom = setZoom;
        V.zoom = function () { return win().slice(); };
        V.pick = pick; V.select = select; V.info = info; V.infoLines = infoLines;
        V.layout = function () { if (!V.geo) draw(); return V.geo; };
        V.cellAt = function (i, s, u) { var gc = V.geo && V.geo.cells[i]; return gc && gc.vis ? pt(gc, s == null ? 0.5 : s, u || 0) : null; };
        V.destroy = function () { V.ls.forEach(function (l) { try { cv.removeEventListener(l[0], l[1], l[2]); } catch (e) { /* ignore */ } }); V.ls = []; V.destroyed = true; };
        return V;
    }

    // ── navigator: the whole well with the zoom window ───────────────────────────────
    function navView(cv, spec) {
        spec = spec || {};
        var N = { win: null, frame: null, ls: [], destroyed: false };
        var path = _path(spec.traj || (spec.grid && spec.grid.traj), spec.grid), full = _mdRange(spec.grid, path), cells = _cellsOf(spec.grid);
        var geo = null;
        function W() { return N.win || full; }
        function draw(frame) {
            if (N.destroyed) return N;
            if (frame) N.frame = frame;
            var sz = _size(cv, spec.w || 120, spec.h || 480, !!spec.fixed), ctx = sz.ctx; if (!ctx) return N;
            var T = _theme(), w = sz.w, h = sz.h, bar = { x: 8, y: 10, w: Math.min(26, Math.max(14, w * 0.22)), h: h - 20 };
            ctx.fillStyle = T.bg; ctx.fillRect(0, 0, w, h);
            var y = function (md) { return bar.y + (md - full[0]) / (full[1] - full[0]) * bar.h; };
            var f = N.frame, ag = _cellArr(f, 'ag'), rg = _cellArr(f, 'regime'), layer = spec.layer || 'phase';
            cells.forEach(function (c, i) {
                var a = Math.min(c.md0, c.md1), b = Math.max(c.md0, c.md1), col;
                if (layer === 'regime') col = _patColor(_regName(rg ? rg[i] : null));
                else col = _fin(_val(ag, i)) ? _mix(_phaseColor(_val(_cellArr(f, 'ao'), i) || 0, _val(_cellArr(f, 'aw'), i) || 0), PH.gas, ag[i]) : '#6e7681';
                ctx.fillStyle = col; ctx.fillRect(bar.x, y(a), bar.w, Math.max(1, y(b) - y(a)));
            });
            // mini trajectory
            var px = bar.x + bar.w + 10, pw = Math.max(20, w - px - 6), x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
            path.forEach(function (p) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); });
            var ysp = Math.max(1, y1 - y0), xsp = Math.max(x1 - x0, 0.05 * ysp), sx = pw / xsp, s = bar.h / ysp, ox = px + (pw - (x1 - x0) * sx) / 2;
            var mp = function (md) { var q = _at(path, md); return [ox + (q.x - x0) * sx, bar.y + (q.y - y0) * s]; };
            ctx.strokeStyle = T.axis; ctx.lineWidth = 2; ctx.beginPath();
            path.forEach(function (p, i) { var q = [ox + (p.x - x0) * sx, bar.y + (p.y - y0) * s]; if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); }); ctx.stroke();
            var Z = W();
            ctx.strokeStyle = T.accent; ctx.lineWidth = 3; ctx.beginPath();
            var steps = 24; for (var k = 0; k <= steps; k++) { var q = mp(Z[0] + (Z[1] - Z[0]) * k / steps); if (k) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); } ctx.stroke();
            // window on the bar
            ctx.strokeStyle = T.accent; ctx.lineWidth = 2; ctx.fillStyle = _alpha(T.accent, 0.18);
            ctx.fillRect(bar.x - 4, y(Z[0]), bar.w + 8, Math.max(3, y(Z[1]) - y(Z[0])));
            ctx.strokeRect(bar.x - 4, y(Z[0]), bar.w + 8, Math.max(3, y(Z[1]) - y(Z[0])));
            geo = { bar: bar, y: y, md: function (py) { return full[0] + _clamp((py - bar.y) / bar.h, 0, 1) * (full[1] - full[0]); } };
            if (cv.setAttribute) { try { cv.setAttribute('aria-valuetext', 'window ' + Math.round(Z[0]) + ' – ' + Math.round(Z[1]) + ' ft MD'); } catch (e) { /* ignore */ } }
            return N;
        }
        function setWindow(a, b) {
            if (!_fin(a) || !_fin(b) || Math.abs(b - a) < 1 || (Math.min(a, b) <= full[0] && Math.max(a, b) >= full[1])) N.win = null;
            else {
                var span = Math.min(full[1] - full[0], Math.abs(b - a)), lo = Math.min(a, b);
                lo = _clamp(lo, full[0], full[1] - span); N.win = [lo, lo + span];
            }
            draw(); return W().slice();
        }
        function emit() { var Z = W(); if (spec.onWindow) spec.onWindow(Z[0], Z[1]); }
        function on(t, f, o) { if (cv.addEventListener) { cv.addEventListener(t, f, o || false); N.ls.push([t, f, o || false]); } }
        function py(e) { var r = cv.getBoundingClientRect ? cv.getBoundingClientRect() : { top: 0 }; return (e.clientY || 0) - (r.top || 0); }
        var drag = null;
        on('pointerdown', function (e) {
            if (!geo) draw();
            var md = geo.md(py(e)), Z = W(), span = Z[1] - Z[0];
            if (!N.win) span = Math.max(100, (full[1] - full[0]) * 0.2);
            if (!(N.win && md >= Z[0] && md <= Z[1])) { setWindow(md - span / 2, md + span / 2); }
            drag = { md: md, w: W().slice() };
        });
        on('pointermove', function (e) { if (!drag || !geo) return; var d = geo.md(py(e)) - drag.md; setWindow(drag.w[0] + d, drag.w[1] + d); });
        on('pointerup', function () { if (drag) { drag = null; emit(); } });
        on('keydown', function (e) {
            var Z = W(), span = Z[1] - Z[0], d = 0;
            if (e.key === 'ArrowDown') d = span * 0.1; else if (e.key === 'ArrowUp') d = -span * 0.1;
            if (e.key === '0') { setWindow(null, null); emit(); if (e.preventDefault) e.preventDefault(); return; }
            if (d && N.win) { setWindow(Z[0] + d, Z[1] + d); emit(); if (e.preventDefault) e.preventDefault(); }
        });
        N.draw = draw; N.setWindow = setWindow; N.window = function () { return W().slice(); };
        N.destroy = function () { N.ls.forEach(function (l) { try { cv.removeEventListener(l[0], l[1], l[2]); } catch (e) { /* ignore */ } }); N.ls = []; N.destroyed = true; };
        return N;
    }

    // ── close-up of one cell ────────────────────────────────────────────────────
    function closeUp(cv, x, spec) {
        spec = spec || {};
        var U = spec.units || units(), fmt = Object.assign(_defaultFmt(U), spec.fmt || {});
        var cw0 = (!spec.fixed && cv.clientWidth > 100) ? cv.clientWidth : (spec.w || 420), narrow = cw0 < 380;
        var sz = _size(cv, spec.w || 420, Math.max(spec.h || 300, narrow ? 330 : 0), !!spec.fixed), ctx = sz.ctx;
        if (!ctx || !x) return { lines: [] };
        var T = _theme(), w = sz.w, h = sz.h;
        ctx.fillStyle = T.bg; ctx.fillRect(0, 0, w, h);
        var lines = ['MD ' + fmt.md(x.md) + ' · TVD ' + fmt.md(x.tvd) + (_fin(x.inc) ? ' · ' + Math.round(x.inc) + '°' : ''),
                     'p ' + fmt.p(x.p) + ' · T ' + fmt.T(x.T), 'gas ' + _pct(x.ag) + ' · liquid ' + _pct(x.aL),
                     'oil ' + _pct(x.ao) + ' · water ' + _pct(x.aw), 'v_g ' + fmt.v(x.vg), 'v_L ' + fmt.v(x.vl),
                     'v_c ' + fmt.v(x.vc) + (_fin(x.ratio) ? ' (' + _num(x.ratio, 2) + '×)' : ''), 'regime: ' + (x.regime || 'unknown')];
        // pipe section at the cell inclination (flow up the hole points up / right)
        var bw = narrow ? w - 24 : Math.round(w * 0.55), bh = narrow ? h - 24 - 8 * 14 - 10 : h - 24;
        var cx = 12 + bw / 2, cy = 12 + bh / 2, inc = _fin(x.inc) ? _clamp(x.inc, 0, 100) : 0, a = (90 - inc) * Math.PI / 180;
        var ux = Math.cos(a), uy = -Math.sin(a), L = Math.min(bw, bh) * 0.92, D = Math.min(L * 0.42, 90);
        if (inc > 45) { L = Math.min(bw * 0.95, Math.hypot(bw, bh) * 0.9); D = Math.min(bh * 0.7, 90); }
        var nx = -uy, ny = ux;
        var P = function (s, u) { return [cx + (s - 0.5) * L * ux + u * D / 2 * nx, cy + (s - 0.5) * L * uy + u * D / 2 * ny]; };
        var quad = function (s0, s1, u0, u1, col) { var q = [P(s0, u0), P(s1, u0), P(s1, u1), P(s0, u1)]; ctx.fillStyle = col; ctx.beginPath(); q.forEach(function (p, i) { if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }); ctx.closePath(); ctx.fill(); };
        var ag = _clamp(_fin(x.ag) ? x.ag : 0, 0, 1), aL = 1 - ag, ao = _fin(x.ao) ? x.ao : 0, aw = _fin(x.aw) ? x.aw : 0, lc = _phaseColor(ao, aw), r = x.regime || 'unknown';
        var ph = _fin(spec.phase) ? spec.phase : 0, low = ny >= 0 ? 1 : -1;
        quad(0, 1, -1.12, 1.12, T.axis);
        if (r === 'annular' || r === 'mist' || r === 'gas') {
            quad(0, 1, -1, 1, PH.gas);
            var ft = Math.max(0.04, aL * (r === 'mist' ? 0.6 : 1));
            if (aL > 1e-4) { quad(0, 1, -1, -1 + ft, lc); quad(0, 1, 1 - ft, 1, lc); }
            ctx.fillStyle = lc; for (var j = 0; j < Math.round(40 * Math.min(1, aL * 25)); j++) { var q = P(_frac(j * 0.618034 + ph), (_frac(j * 0.754878) * 2 - 1) * 0.6); ctx.beginPath(); if (ctx.arc) ctx.arc(q[0], q[1], 2, 0, Math.PI * 2); ctx.fill(); }
        } else if (r === 'stratified' || (r === 'segregated' && inc > 60)) {
            quad(0, 1, -1, 1, PH.gas); quad(0, 1, low, low * (1 - 2 * aL), lc);
        } else if (r === 'segregated') {
            quad(0, 1, -1, 1, PH.gas); if (aw > 0) quad(0, aw, -1, 1, PH.water); if (ao > 0) quad(aw, aw + ao, -1, 1, PH.oil);
        } else {
            quad(0, 1, -1, 1, lc);
            if (r === 'slug' && ag > 0.05) { var s0 = _frac(0.15 + ph), ln = Math.min(0.7, 0.2 + 0.6 * ag); quad(s0, Math.min(1, s0 + ln), -0.72, 0.72, _alpha(PH.gas, 0.92)); if (s0 + ln > 1) quad(0, s0 + ln - 1, -0.72, 0.72, _alpha(PH.gas, 0.92)); }
            ctx.fillStyle = _alpha(PH.gas, 0.95);
            for (var k = 0; k < Math.round(60 * Math.min(1, ag * 2.5)); k++) { var b = P(_frac(k * 0.618034 + 0.3 + ph), (_frac(k * 0.754878 + 0.2) * 2 - 1) * 0.8); ctx.beginPath(); if (ctx.arc) ctx.arc(b[0], b[1], 3, 0, Math.PI * 2); ctx.fill(); }
        }
        // velocity arrows: gas (light) and liquid (blue); a negative liquid velocity = falling film
        [[x.vg, PH.gas, -0.45, 'v_g'], [x.vl, PH.water, 0.45, 'v_L']].forEach(function (av) {
            if (!_fin(av[0]) || Math.abs(av[0]) < 1e-3) return;
            var sg = av[0] > 0 ? 1 : -1, c = P(0.5, av[2]), l = 0.22 * L, ex = c[0] + sg * ux * l / 2, ey = c[1] + sg * uy * l / 2;
            ctx.strokeStyle = av[1]; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(c[0] - sg * ux * l / 2, c[1] - sg * uy * l / 2); ctx.lineTo(ex, ey);
            ctx.lineTo(ex - sg * ux * 8 + nx * 5, ey - sg * uy * 8 + ny * 5); ctx.moveTo(ex, ey); ctx.lineTo(ex - sg * ux * 8 - nx * 5, ey - sg * uy * 8 - ny * 5); ctx.stroke();
            var lp = P(0.5, av[2] > 0 ? 1.45 : -1.45); ctx.fillStyle = av[1]; ctx.font = _font(10, '600'); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(av[3], lp[0] + (av[2] > 0 ? 8 : -8) * Math.abs(nx), lp[1] + (av[2] > 0 ? 8 : -8) * Math.abs(ny));
        });
        // readout
        ctx.font = _font(11); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        var tx = narrow ? 12 : bw + 28, ty = narrow ? bh + 30 : 26;
        lines.forEach(function (ln, i) { ctx.fillStyle = i === lines.length - 1 ? _patColor(r) : T.text; ctx.fillText(ln, tx, ty + i * (narrow ? 14 : 17)); });
        if (cv.setAttribute) { try { cv.setAttribute('aria-label', 'Cell close-up: ' + lines.join('; ')); } catch (e) { /* ignore */ } }
        return { lines: lines };
    }
    function _pct(v) { return _fin(v) ? Math.round(v * 1000) / 10 + ' %' : '—'; }

    // ── charts on WTS_wp_view.chart ──────────────────────────────────────────────
    function _chart(cv, spec) { var W = _WV(); if (!cv || !W || typeof W.chart !== 'function') return null; return W.chart(cv, spec); }
    function _chMeta(rec, key) {
        var list = null; try { list = rec && typeof rec.channels === 'function' ? rec.channels() : null; } catch (e) { list = null; }
        var c = (list || []).filter(function (x) { return x && x.key === key; })[0], m = CH_META[key] || [key, '', null];
        return { key: key, label: (c && c.label) || m[0], unit: (c && c.unit != null) ? c.unit : m[1], cat: (c && c.cat !== undefined) ? c.cat : m[2], dp: c && c.dp };
    }
    function _conv(U, meta) {
        var cat = meta.cat;
        if (!cat) return { f: function (v) { return v; }, lab: meta.unit };
        var c = U.cat(cat, meta.unit, 2, 2);
        return c;
    }
    // min / max decimation per bucket (keeps peaks); pts [[x, y]]
    function _decimate(pts, maxN) {
        if (pts.length <= maxN) return pts;
        var b = Math.ceil(pts.length / Math.max(2, Math.floor(maxN / 2))), out = [];
        for (var i = 0; i < pts.length; i += b) {
            var lo = null, hi = null;
            for (var j = i; j < Math.min(pts.length, i + b); j++) { var p = pts[j]; if (!_fin(p[1])) continue; if (!lo || p[1] < lo[1]) lo = p; if (!hi || p[1] > hi[1]) hi = p; }
            if (!lo) continue;
            if (lo === hi) out.push(lo); else if (lo[0] < hi[0]) { out.push(lo); out.push(hi); } else { out.push(hi); out.push(lo); }
        }
        return out;
    }
    function _recArrays(rec, key) {
        var t = null, y = null;
        try { t = rec && rec.times ? rec.times() : null; y = rec && rec.series ? rec.series(key) : null; } catch (e) { t = y = null; }
        return { t: t || [], y: y || [] };
    }
    var SERIES_COLORS = ['accent', 'blue', 'green', 'purple', 'yellow', 'red', 'text2'];
    function trend(cv, rec, spec) {
        spec = spec || {};
        var U = spec.units || units(), T = _theme(), keys = spec.keys || ['qg'], series = [], cats = {}, ylab = null;
        var win = spec.window || null, maxN = spec.maxPoints || 900;
        keys.forEach(function (k, i) {
            var m = _chMeta(rec, k), c = _conv(U, m), A = _recArrays(rec, k), pts = [];
            for (var j = 0; j < A.t.length && j < A.y.length; j++) {
                var tt = A.t[j]; if (win && (tt < win[0] || tt > win[1])) continue;
                var v = A.y[j]; pts.push([tt / 3600, _fin(v) ? c.f(v) : NaN]);
            }
            cats[c.lab] = (cats[c.lab] || 0) + 1; if (ylab == null) ylab = c.lab;
            series.push({ key: k, label: m.label + (c.lab ? ' (' + c.lab + ')' : ''), color: (spec.colors && spec.colors[k]) || T[SERIES_COLORS[i % SERIES_COLORS.length]],
                          pts: _decimate(pts, maxN), width: 1.8, dash: (spec.dash && spec.dash[k]) || null });
        });
        var bands = (spec.marks || []).filter(function (m) { return m && _fin(m.t0) && _fin(m.t1); }).map(function (m) { return { x0: m.t0 / 3600, x1: m.t1 / 3600, color: _alpha(T.blue, 0.14), label: String(m.label || '').slice(0, 30) }; });
        var handles = [];
        if (_fin(spec.cursor)) {
            var hx0 = win ? win[0] / 3600 : (series[0] && series[0].pts.length ? series[0].pts[0][0] : 0);
            var hx1 = win ? win[1] / 3600 : (series[0] && series[0].pts.length ? series[0].pts[series[0].pts.length - 1][0] : 1);
            handles.push({ key: 'cursor', kind: 'lineX', value: spec.cursor / 3600, min: hx0, max: Math.max(hx1, hx0 + 1e-6), step: Math.max(1e-6, (hx1 - hx0) / 200),
                           label: 'now', color: T.text, fmt: function (v) { return _fmtT(v * 3600); } });
        }
        var multi = Object.keys(cats).length > 1;
        return _chart(cv, {
            key: spec.key || ('wd-trend:' + keys.join(',')), aspect: spec.aspect || 0.34, minH: spec.minH || 200, maxH: spec.maxH || 320, w: spec.w || 640,
            x: { label: 'time (h)', min: win ? win[0] / 3600 : undefined, max: win ? win[1] / 3600 : undefined, fmt: function (v) { return _fmtT(v * 3600).replace(/:\d\d$/, ''); } },
            y: { label: spec.yLabel || (multi ? keys.map(function (k) { return _chMeta(rec, k).label; }).join(' / ') : ylab || ''), min: spec.yMin },
            series: series, bands: bands, handles: handles, readout: 'x',
            empty: spec.empty || 'No recorded data yet: press Play.',
            onHandle: function (k, v, phase) { if (k === 'cursor' && spec.onScrub) spec.onScrub(v * 3600, phase); }
        });
    }
    function nodal(cv, spec) {
        spec = spec || {};
        var U = spec.units || units(), T = _theme(), qc = spec.gas ? U.qg : U.ql, pc = U.p, cur = spec.curves || {};
        var mk = function (arr) { return (arr || []).filter(function (r) { return r && _fin(r.q) && _fin(r.p); }).map(function (r) { return [qc.f(r.q), pc.f(r.p)]; }); };
        var series = [{ key: 'ipr', label: 'inflow (IPR)', color: T.blue, pts: mk(cur.ipr), width: 2 }, { key: 'vlp', label: 'outflow (VLP)', color: T.accent, pts: mk(cur.vlp), width: 2 }];
        var trail = (spec.trail || []).filter(function (p) { return p && _fin(p[0]) && _fin(p[1]); }).map(function (p) { return [qc.f(p[0]), pc.f(p[1])]; });
        if (trail.length > 1) series.push({ key: 'trail', label: 'path in time', color: _alpha(T.yellow, 0.6), pts: trail, width: 1.2, dash: [3, 3] });
        var markers = [];
        if (spec.op && _fin(spec.op.q) && _fin(spec.op.p)) markers.push({ x: qc.f(spec.op.q), y: pc.f(spec.op.p), kind: 'filled', color: T.green, label: 'steady' });
        if (spec.live && _fin(spec.live.q) && _fin(spec.live.p)) markers.push({ x: qc.f(spec.live.q), y: pc.f(spec.live.p), kind: 'hollow', color: T.yellow, label: 'now', r: 7 });
        return _chart(cv, { key: spec.key || 'wd-nodal', aspect: spec.aspect || 0.62, minH: 220, maxH: 420, w: spec.w || 520,
            x: { label: (spec.gas ? 'gas rate' : 'oil rate') + ' (' + qc.lab + ')', min: 0 }, y: { label: 'bottom-hole pressure (' + pc.lab + ')', min: 0 },
            series: series, markers: markers, readout: 'x', empty: 'No steady reference: the well has no stable operating point.' });
    }
    function whpRate(cv, rec, spec) {
        spec = spec || {};
        var U = spec.units || units(), T = _theme(), qk = spec.qKey || (spec.gas ? 'qg' : 'qo'), m = _chMeta(rec, qk), qc = _conv(U, m), pc = U.pg;
        var A = _recArrays(rec, qk), B = _recArrays(rec, 'thp'), pts = [], cur = null;
        for (var j = 0; j < A.t.length && j < A.y.length && j < B.y.length; j++) {
            var q = A.y[j], p = B.y[j]; if (!_fin(q) || !_fin(p)) continue;
            pts.push([qc.f(q), pc.f(p)]);
            if (_fin(spec.cursor) && A.t[j] <= spec.cursor) cur = [qc.f(q), pc.f(p)];
        }
        var markers = [];
        if (cur) markers.push({ x: cur[0], y: cur[1], kind: 'hollow', color: T.yellow, label: 'now', r: 7 });
        if (spec.op && _fin(spec.op.q) && _fin(spec.op.thp_psig)) markers.push({ x: qc.f(spec.op.q), y: pc.f(spec.op.thp_psig), kind: 'filled', color: T.green, label: 'steady' });
        return _chart(cv, { key: spec.key || 'wd-whp', aspect: spec.aspect || 0.62, minH: 220, maxH: 420, w: spec.w || 520,
            x: { label: m.label + ' (' + qc.lab + ')' }, y: { label: 'THP (' + pc.lab + ')' },
            series: [{ key: 'path', label: 'run path', color: T.accent, pts: _decimate(pts, 1200), width: 1.6 }], markers: markers, readout: 'near',
            empty: 'No recorded data yet: press Play.' });
    }
    function depthLog(cv, frame, spec) {
        spec = spec || {};
        var U = spec.units || units(), T = _theme(), cells = _cellsOf(spec.grid), track = spec.track === 'velocity' ? 'velocity' : 'pressure';
        var md = cells.map(function (c) { return U.md.f(_fin(c.mdc) ? c.mdc : (c.md0 + c.md1) / 2); });
        var col = function (k, cv2) { var a = _cellArr(frame, k); return cells.map(function (c, i) { var v = _val(a, i); return [_fin(v) ? cv2.f(v) : NaN, md[i]]; }).filter(function (p) { return _fin(p[0]); }); };
        var hold = (function () { var a = _cellArr(frame, 'ag'); return cells.map(function (c, i) { var v = _val(a, i); return [_fin(v) ? 1 - v : NaN, md[i]]; }).filter(function (p) { return _fin(p[0]); }); })();
        var series = [];
        if (track === 'pressure') series.push({ key: 'p', label: 'pressure (' + U.p.lab + ')', color: T.accent, pts: col('p', U.p), width: 2 });
        else {
            series.push({ key: 'vg', label: 'v_g (' + U.v.lab + ')', color: T.text, pts: col('vg', U.v), width: 2 });
            series.push({ key: 'vc', label: 'v_c critical (' + U.v.lab + ')', color: T.red, pts: col('vc', U.v), width: 1.6, dash: [5, 4] });
            series.push({ key: 'vl', label: 'v_L (' + U.v.lab + ')', color: T.blue, pts: col('vl', U.v), width: 1.4 });
        }
        series.push({ key: 'hl', label: 'liquid holdup (top axis)', color: T.green, pts: hold, width: 1.6, axis: 'x2' });
        // regime bands along the depth axis
        var rg = _cellArr(frame, 'regime'), hb = [], cur = null;
        cells.map(function (c, i) { return { a: U.md.f(Math.min(c.md0, c.md1)), b: U.md.f(Math.max(c.md0, c.md1)), r: _regName(rg ? rg[i] : null) }; })
            .sort(function (p, q) { return p.a - q.a; })
            .forEach(function (s) { if (cur && cur.label === s.r && Math.abs(cur.y1 - s.a) < 1e-6) cur.y1 = s.b; else { cur = { y0: s.a, y1: s.b, color: _patColor(s.r), label: s.r }; hb.push(cur); } });
        if (!rg) hb = [];
        var hl = [];
        if (_fin(frame && frame.liquidTopMd)) hl.push({ y: U.md.f(frame.liquidTopMd), color: PH.water, label: 'liquid top' });
        if (_fin(frame && frame.gasCapMd)) hl.push({ y: U.md.f(frame.gasCapMd), color: T.yellow, label: 'gas cap', dash: [4, 3] });
        ((frame && frame.markers) || []).forEach(function (m) { if (m && _fin(m.md) && m.kind !== 'perf' && m.label) hl.push({ y: U.md.f(m.md), color: T.text2, label: String(m.label).slice(0, 18), dash: [2, 3] }); });
        return _chart(cv, { key: spec.key || ('wd-depth:' + track), aspect: spec.aspect || 0.9, minH: 280, maxH: 520, w: spec.w || 480,
            x: { label: track === 'pressure' ? 'pressure (' + U.p.lab + ')' : 'velocity (' + U.v.lab + ')' },
            x2: { label: 'liquid holdup α_L (–)', min: 0, max: 1 }, y: { label: 'MD (' + U.md.lab + ')', invert: true },
            series: series, hbands: hb, hlines: hl, readout: 'y', empty: 'No state to show yet.' });
    }
    function stateStrip(cv, rec, spec) {
        spec = spec || {};
        stateColors();
        var sz = _size(cv, spec.w || 640, spec.h || 26, !!spec.fixed), ctx = sz.ctx, T = _theme(), order = _stateOrder();
        var A = _recArrays(rec, 'state'), segs = [];
        var t0 = spec.window ? spec.window[0] : (A.t.length ? A.t[0] : 0), t1 = spec.window ? spec.window[1] : (A.t.length ? A.t[A.t.length - 1] : 1);
        if (!(t1 > t0)) t1 = t0 + 1;
        for (var j = 0; j < A.t.length && j < A.y.length; j++) {
            var key = order[A.y[j]] || 'stable', tt = A.t[j];
            if (segs.length && segs[segs.length - 1].key === key) segs[segs.length - 1].t1 = tt;
            else { if (segs.length) segs[segs.length - 1].t1 = tt; segs.push({ key: key, label: _stateLabel(key), t0: tt, t1: tt }); }
        }
        if (!ctx) return { segments: segs };
        var X = function (t) { return 2 + (t - t0) / (t1 - t0) * (sz.w - 4); };
        ctx.fillStyle = T.panel; ctx.fillRect(0, 0, sz.w, sz.h);
        ctx.font = _font(10, '600'); ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
        segs.forEach(function (s) {
            var a = _clamp(X(s.t0), 0, sz.w), b = _clamp(X(Math.max(s.t1, s.t0)), 0, sz.w); if (b - a < 1) b = a + 1;
            ctx.fillStyle = STATE_COLORS[s.key] || T.text2; ctx.fillRect(a, 3, b - a, sz.h - 6);
            var tw = ctx.measureText ? ctx.measureText(s.label).width : s.label.length * 6;
            if (b - a > tw + 8) { ctx.fillStyle = T.bg; ctx.fillText(s.label, a + 4, sz.h / 2); }
        });
        (spec.marks || []).forEach(function (m) { if (!m || !_fin(m.t0) || !_fin(m.t1)) return; ctx.strokeStyle = T.blue; ctx.lineWidth = 1.5; ctx.strokeRect(X(m.t0), 1, Math.max(2, X(m.t1) - X(m.t0)), sz.h - 2); });
        if (_fin(spec.cursor)) { var cx = X(spec.cursor); ctx.strokeStyle = T.text; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, sz.h); ctx.stroke(); }
        if (!segs.length) { ctx.fillStyle = T.text2; ctx.textAlign = 'center'; ctx.fillText('no states recorded yet', sz.w / 2, sz.h / 2); }
        // scrub on the strip (bound once per canvas)
        cv._wdStrip = { t0: t0, t1: t1, spec: spec, w: sz.w };
        if (!cv._wdStripBound && cv.addEventListener) {
            cv._wdStripBound = true;
            var down = false;
            var tAt = function (e) { var st = cv._wdStrip, r = cv.getBoundingClientRect ? cv.getBoundingClientRect() : { left: 0 }; return st.t0 + _clamp(((e.clientX || 0) - (r.left || 0) - 2) / (st.w - 4), 0, 1) * (st.t1 - st.t0); };
            cv.addEventListener('pointerdown', function (e) { down = true; var s = cv._wdStrip.spec; if (s.onScrub) s.onScrub(tAt(e), 'move'); });
            cv.addEventListener('pointermove', function (e) { if (!down) return; var s = cv._wdStrip.spec; if (s.onScrub) s.onScrub(tAt(e), 'move'); });
            cv.addEventListener('pointerup', function (e) { if (!down) return; down = false; var s = cv._wdStrip.spec; if (s.onScrub) s.onScrub(tAt(e), 'end'); });
        }
        if (cv.setAttribute) { try { cv.setAttribute('aria-label', 'Well states: ' + segs.slice(-6).map(function (s) { return s.label + ' from ' + _fmtT(s.t0); }).join(', ')); } catch (e) { /* ignore */ } }
        return { segments: segs };
    }

    // ── text summary for screen readers and the report ────────────────────────────────
    function describe(frame, grid, U, o) {
        U = U || units(); o = o || {};
        var cells = _cellsOf(grid), rg = _cellArr(frame, 'regime'), out = ['Wellbore at ' + _fmtT(frame && frame.t)];
        if (rg && cells.length) {
            var runs = [], cur = null;
            cells.map(function (c, i) { return { a: Math.min(c.md0, c.md1), b: Math.max(c.md0, c.md1), r: _regName(rg[i]) }; }).sort(function (p, q) { return p.a - q.a; })
                .forEach(function (s) { if (cur && cur.r === s.r) cur.b = s.b; else { cur = { a: s.a, b: s.b, r: s.r }; runs.push(cur); } });
            out.push(runs.slice(0, 6).map(function (r) { return r.r + ' ' + _num(U.md.f(r.a), 0) + '–' + _num(U.md.f(r.b), 0) + ' ' + U.md.lab; }).join(', ') + (runs.length > 6 ? ', …' : ''));
        }
        if (_fin(frame && frame.liquidTopMd)) out.push('liquid top at ' + _ufmt(U.md, frame.liquidTopMd) + ' MD');
        if (_fin(frame && frame.gasCapMd)) out.push('gas cap to ' + _ufmt(U.md, frame.gasCapMd) + ' MD');
        var p = _cellArr(frame, 'p');
        if (p && cells.length) out.push('pressure ' + _ufmt(U.p, p[cells.length - 1]) + ' at the top, ' + _ufmt(U.p, p[0]) + ' at the bottom');
        return out.join('; ') + '.';
    }

    G.WTS_wd_view = {
        VERSION: '1.0.0', wellbore: wellbore, navigator: navView, closeUp: closeUp, depthLog: depthLog, trend: trend, nodal: nodal,
        whpRate: whpRate, stateStrip: stateStrip, STATE_COLORS: STATE_COLORS, stateColors: stateColors, units: units, describe: describe,
        REGIMES: REGIMES, STATE_ORDER: STATE_ORDER, STATE_LABELS: STATE_LABELS, CH_META: CH_META, PHASE_COLORS: PH, fmtTime: _fmtT,
        _decimate: _decimate, _path: _path
    };
    if (G.__WD_STUBS && G.__WD_STUBS.length) {     // WD0 stubs: this file replaces its own entries
        for (var si = G.__WD_STUBS.length - 1; si >= 0; si--) if (/^WTS_wd_view\b/.test(String(G.__WD_STUBS[si]))) G.__WD_STUBS.splice(si, 1);
    }
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis, V = G.WTS_wd_view, bad = [];
    try {
        if (V.fmtTime(3725) !== '1:02:05') bad.push('fmtTime');
        var d = V._decimate([[0, 1], [1, 5], [2, 0], [3, 2], [4, 9], [5, 1]], 4);
        if (d.length > 6 || d.length < 2) bad.push('decimate');
        var p = V._path([{ md: 0, tvd: 0, n: 0, e: 0 }, { md: 100, tvd: 50, n: 30, e: 40 }]);
        if (Math.abs(p[1].x - 50) > 1e-9) bad.push('vertical section');
    } catch (e) { bad.push('threw ' + e.message); }
    if (bad.length && typeof console !== 'undefined') console.error('[wd-view self-test] ' + bad.join('; '));
})();
