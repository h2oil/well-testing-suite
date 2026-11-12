// =============================================================================
// WTS — 49-calc-wp-sens.js  (Round 9; helper module: no page in window.WTS_calcRegistry)
// -----------------------------------------------------------------------------
// Well Performance sensitivity (WP6, increment A1) — docs/WELL-PERFORMANCE-PLAN.md §3.6, §6, §15.2, §16, D9.
//
// One variable at a time (A1) or two (A2, WP16: a rate line per value of the second and the 2-D table; up to four in B): every value is one system solve (WTS_wp_system.solve — nothing here
// re-implements a correlation, a march or a root search), driven as a Job through PRiSM_autoInterp.drive on a button press, with
// progress and Cancel (cancel within one case; the results are discarded). No timer, no polling.
//
// NUMERICS (§6.3). The cases are sorted by value. The START case is the one at the model's own value when that value is in the
//   list (else the value nearest to it): it is a plain cold solve(M), so the sensitivity at the base value equals the single solve
//   exactly (§15.2). The other cases walk outwards from it, each a TRACKING solve (WTS_wp_system.solve {track}) warm-started from
//   the neighbouring case's root (linear extrapolation from the two previous cases on that side) on the START case's frozen step
//   layout, so p_out(q) is the same function as in a cold solve (X11: warm = cold). The tracking solve skips the scan; when its
//   ±10 % bracket fails it falls back to the full solve by itself.
// FAMILIES (§6.2). Inflow variables (p̄r, skin, k·h, J) give one IPR per value — the IPR curve is evaluated directly
//   (WTS_wp_ipr.curve, no march). Outflow variables (WC, GOR, GLR, WGR, CGR, THP, separator pressure, tubing ID, bean) give one
//   outflow curve per value: a 4-point coarse scan (½ E each, the solver's coarseOnly path on the same frozen layout) plus the
//   fine operating point as a knot, so the dashed curve passes through the operating-point marker. A case that fell back to a full
//   solve keeps that solve's curves. Budget (§16): 10 cases ≤ 80 E (≈ 22 E start + 9 × (4 E tracked + 2 E family)).
// VARIABLES (§6.1, A1). Each maps to a path in M and a validity range; values are in field units (WC in %, as the page control):
//   pr psia · wc % · gor scf/STB · glr scf/STB (GOR = GLR / (1 − WC)) · wgr / cgr STB/MMscf · thp psig (fixed THP, choke out of
//   line) · psep psig · tubingId in (or a WTS_tubulars catalogue key) · skin (Darcy inflow models) · kh md·ft (Darcy, k = kh / h)
//   · bean /64 in (choke in line) · J STB/d/psi (pi, composite).
//
// Interfaces (field units, §3.0; every result {ok, errors[], warnings[{code, msg, sev}], …}; nothing throws for user data):
//   WTS_wp_sens
//     .VARS                       registry {key: {key, label, unit, family:'ipr'|'vlp', types[], lo, hi, base(M), apply(M, v)}}
//     .vars(M?)                   → [{key, label, unit, family, applicable, why, base}] (the page's select)
//     .suggest(M, key, n?)        → {ok, values[]} n (default 5) values around the base inside the validity range
//     .matrix(vars /*[{key, values[]}]*/)
//         → {ok, cases:[{values:{key: v}}], errors, warnings}  full factorial, ≤ 4 variables, ≤ 1,000 cases
//     .job(M, vars, o?)           (A2: one or two variables; two → result.two, key2, label2, unit2, base2, start {x, y},
//                                   grid {x[], y[], q[j][i], stable[j][i], labelsX, labelsY}, cases[{values, R, i, j}], no curves)
//                                 → Job for PRiSM_autoInterp.drive: {step() → {done, progress, label}, done(), progress(), result(),
//                                   cancel()}; result() → {ok, key, label, unit, family, base, start, cases:[{values, label?, R}],
//                                   table, evals, cancelled?, errors, warnings}; R-summary = {ok, code, error, q, qo, qw, qg, qL,
//                                   pwf, thp, tht, stable, loadingMargin, regime, tracked, evals, op, qs, curve:[{q, p}], family}
//                                   o.families false → no family curves (rates only)
//                                 B (WP27): three or four variables → jobN (result.nd: keys[], labels[], units[], axes[{key, values, labels}],
//                                   q[] / stable[] flat in row-major order of the axes (strides), cases[{values, R, idx[]}], start idx[],
//                                   base[{value, inList}]); every cell a tracking solve warm-started from a solved neighbour (breadth-first
//                                   from the start cell = the single solve when every model value is listed); ≤ 1,000 cases
//     .tornado(M, o?)             → Job (B, WP27): result() → {ok, base:{q, …R-summary}, bars:[{key, label, unit, lo, hi, qLo, qHi, swing,
//                                   okLo, okHi, noteLo, noteHi}] (largest swing first), rateUnit, evals}; o = {vars:[{key, lo?, hi?}], frac}
//                                   (default: every applicable variable at its tornado range, TORNADO), the base = the single solve exactly
//     .table(result)              → {head[], rows[][]}   (field units; numbers unformatted)
//     .csv(result)                → string (the table, then the family curves in long form)
// =============================================================================
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;

    // WP6 replaces the WP0 stub file: its names leave window.__WP_STUBS
    var STUBS = G.__WP_STUBS = G.__WP_STUBS || [];
    ['WTS_wp_sens.matrix', 'WTS_wp_sens.job', 'WTS_wp_sens.table', 'WTS_wp_sens.csv'].forEach(function (n) { var i = STUBS.indexOf(n); if (i !== -1) STUBS.splice(i, 1); });

    var MAX_VALUES = 10;                  // Appendix B: ≤ 10 values per variable
    var MAX_VARS = 4, MAX_CASES = 1000;   // matrix (B); the A1 job takes one variable
    var FAM_FRACS = [0.03, 0.3, 0.65, 0.995];   // family outflow curve: coarse scan points (fractions of AOF)
    var OIL = ['oil', 'water'], GAS = ['gas', 'condensate'], ALL = ['oil', 'water', 'gas', 'condensate'];

    function _fin(v) { return typeof v === 'number' && isFinite(v); }
    function _n(v) { if (typeof v === 'number') return isFinite(v) ? v : null; if (typeof v === 'string' && v.trim() !== '' && isFinite(+v)) return +v; return null; }
    function _w(code, msg, sev) { return { code: code, msg: String(msg).slice(0, 299), sev: sev === 'info' ? 'info' : 'warn' }; }
    function _clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
    function _get(o, path, d) { var c = o; for (var i = 0; i < path.length; i++) { if (c == null) return d; c = c[path[i]]; } return c === undefined ? d : c; }
    function _fn(path) { var p = path.split('.'), f = p.length > 1 ? (G[p[0]] || {})[p[1]] : G[p[0]]; return typeof f === 'function' && (G.__WP_STUBS || []).indexOf(path) === -1 ? f : null; }
    function _f(x, dp) { if (!_fin(x)) return '–'; return (+x.toFixed(dp == null ? 2 : dp)).toString(); }
    function _darcy(M) { var k = _get(M, ['res', 'model'], ''); return k === 'darcyOil' || k === 'darcyGas'; }
    function _type(M) { return _get(M, ['fluid', 'type'], 'oil') || 'oil'; }
    function _tubings(M) { return (_get(M, ['well', 'strings'], []) || []).filter(function (s) { return s && (s.kind || 'tubing') === 'tubing'; }); }

    // ── variables (§6.1) ─────────────────────────────────────────────────────
    // apply(Mx, v) mutates the clone and returns null, or an error message; base(M) → the model's own value (or null)
    var VARS = {
        pr: { label: 'Reservoir pressure p̄r', unit: 'psia', family: 'ipr', types: ALL, lo: 14.7, hi: 30000,
            base: function (M) { return _n(_get(M, ['res', 'pr'])); },
            apply: function (M, v) { M.res.pr = v; return null; } },
        wc: { label: 'Water cut', unit: '%', family: 'vlp', types: OIL, lo: 0, hi: 99.9,
            base: function (M) { var w = _n(_get(M, ['fluid', 'wc'])); return _fin(w) ? w * 100 : null; },
            apply: function (M, v) { M.fluid.wc = v / 100; return null; } },
        gor: { label: 'Producing GOR', unit: 'scf/STB', family: 'vlp', types: ['oil'], lo: 0, hi: 50000,
            base: function (M) { return _n(_get(M, ['fluid', 'gor'])); },
            apply: function (M, v) { M.fluid.gor = v; return null; } },
        glr: { label: 'Producing GLR', unit: 'scf/STB', family: 'vlp', types: ['oil'], lo: 0, hi: 50000,
            base: function (M) { var g = _n(_get(M, ['fluid', 'gor'])), w = _n(_get(M, ['fluid', 'wc'])) || 0; return _fin(g) ? g * (1 - w) : null; },
            apply: function (M, v) { var w = _n(M.fluid.wc) || 0; if (w >= 1) return 'GLR needs a water cut below 100 %.'; M.fluid.gor = v / (1 - w); return null; } },
        wgr: { label: 'Water-gas ratio', unit: 'STB/MMscf', family: 'vlp', types: GAS, lo: 0, hi: 2000,
            base: function (M) { return _n(_get(M, ['fluid', 'wgr'])); },
            apply: function (M, v) { M.fluid.wgr = v; return null; } },
        cgr: { label: 'Condensate-gas ratio', unit: 'STB/MMscf', family: 'vlp', types: GAS, lo: 0, hi: 1000,
            base: function (M) { return _n(_get(M, ['fluid', 'cgr'])); },
            apply: function (M, v) { M.fluid.cgr = v; return null; } },
        thp: { label: 'Wellhead pressure (fixed, choke out of line)', unit: 'psig', family: 'vlp', types: ALL, lo: 0, hi: 15000,
            base: function (M) { return _get(M, ['surface', 'choke', 'present'], false) ? null : _n(_get(M, ['system', 'thp_psig'])); },
            apply: function (M, v) { M.surface.choke.present = false; M.system.thp_psig = v; if (M.system.mode === 'max' || M.system.mode === 'design') M.system.mode = 'rate'; return null; } },
        psep: { label: 'Separator pressure', unit: 'psig', family: 'vlp', types: ALL, lo: 0, hi: 5000,
            base: function (M) { return _n(_get(M, ['surface', 'psep_psig'])); },
            apply: function (M, v) { M.surface.psep_psig = v; return null; } },
        tubingId: { label: 'Tubing ID', unit: 'in', family: 'vlp', types: ALL, lo: 0.5, hi: 12,
            base: function (M) { var t = _tubings(M); if (!t.length) return null; var id = _n(t[0].id); if (!_fin(id) && t[0].tubKey && G.WTS_tubulars) { var e = G.WTS_tubulars.find(t[0].tubKey); id = e ? e.id : null; } return id; },
            apply: function (M, v, raw) {
                var t = _tubings(M); if (!t.length) return 'The well has no tubing string to resize.';
                var e = (typeof raw === 'string' && G.WTS_tubulars && G.WTS_tubulars.find) ? G.WTS_tubulars.find(raw) : null;
                t.forEach(function (s) {
                    if (e) { s.tubKey = raw; s.id = e.id; s.od = e.od; s.wall = e.wall; return; }
                    var od = _n(s.od), wall = _n(s.wall);
                    if (!_fin(wall) || wall <= 0) wall = (_fin(od) && _fin(_n(s.id)) && od > +s.id) ? (od - s.id) / 2 : 0.217;
                    s.tubKey = null; s.id = v; s.od = v + 2 * wall; s.wall = wall;
                });
                return null;
            } },
        skin: { label: 'Skin S', unit: '', family: 'ipr', types: ALL, lo: -7, hi: 200,
            base: function (M) { return _darcy(M) ? _n(_get(M, ['res', 'params', 'S'])) : null; },
            apply: function (M, v) { if (!_darcy(M)) return 'The skin variable needs a Darcy inflow model (darcyOil or darcyGas) in step ②.'; M.res.params = M.res.params || {}; M.res.params.S = v; return null; } },
        kh: { label: 'Permeability-thickness k·h', unit: 'md·ft', family: 'ipr', types: ALL, lo: 1e-3, hi: 1e7,
            base: function (M) { var k = _n(_get(M, ['res', 'params', 'k'])), h = _n(_get(M, ['res', 'params', 'h'])); return _darcy(M) && _fin(k) && _fin(h) ? k * h : null; },
            apply: function (M, v) { if (!_darcy(M)) return 'The k·h variable needs a Darcy inflow model (darcyOil or darcyGas) in step ②.'; var h = _n(_get(M, ['res', 'params', 'h'])); if (!(h > 0)) return 'The k·h variable needs the net thickness h.'; M.res.params.k = v / h; return null; } },
        bean: { label: 'Choke bean', unit: '/64 in', family: 'vlp', types: ALL, lo: 2, hi: 192,
            base: function (M) { return _get(M, ['surface', 'choke', 'present'], false) ? _n(_get(M, ['surface', 'choke', 'bean64'])) : null; },
            apply: function (M, v) { M.surface.choke.present = true; M.surface.choke.bean64 = v; if (M.system.mode === 'max' || M.system.mode === 'design') M.system.mode = 'rate'; return null; } },
        J: { label: 'Productivity index J', unit: 'STB/d/psi', family: 'ipr', types: OIL, lo: 1e-4, hi: 1000,
            base: function (M) { var k = _get(M, ['res', 'model'], ''); return (k === 'pi' || k === 'composite') ? _n(_get(M, ['res', 'params', 'J'])) : null; },
            apply: function (M, v) { var k = M.res.model; if (k !== 'pi' && k !== 'composite') return 'The J variable needs the straight-line (pi) or composite inflow model in step ②.'; M.res.params = M.res.params || {}; M.res.params.J = v; return null; } }
    };
    Object.keys(VARS).forEach(function (k) { VARS[k].key = k; });
    var ORDER = ['pr', 'wc', 'gor', 'glr', 'wgr', 'cgr', 'thp', 'psep', 'tubingId', 'bean', 'J', 'skin', 'kh'];

    function _applicable(M, key) {
        var d = VARS[key];
        if (!d) return 'unknown sensitivity variable ' + String(key).slice(0, 40);
        if (M && d.types.indexOf(_type(M)) === -1) return d.label + ' does not apply to a ' + _type(M) + ' well.';
        if (M && (key === 'skin' || key === 'kh') && !_darcy(M)) return 'needs a Darcy inflow model in step ②';
        if (M && key === 'J' && ['pi', 'composite'].indexOf(_get(M, ['res', 'model'], '')) === -1) return 'needs the straight-line (pi) or composite inflow model';
        if (M && key === 'tubingId' && !_tubings(M).length) return 'the well has no tubing string';
        return null;
    }
    function vars(M) {
        return ORDER.map(function (k) { var d = VARS[k], why = _applicable(M, k); return { key: k, label: d.label, unit: d.unit, family: d.family, applicable: !why, why: why, base: M ? d.base(M) : null, lo: d.lo, hi: d.hi }; });
    }
    function _nice(x) { if (!(x > 0)) return x; var e = Math.pow(10, Math.floor(Math.log(x) / Math.LN10) - 1); return Math.round(x / e) * e; }
    function suggest(M, key, n) {
        var d = VARS[key]; n = Math.max(2, Math.min(MAX_VALUES, Math.round(+n) || 5));
        if (!d) return { ok: false, values: [], errors: ['unknown sensitivity variable'], warnings: [] };
        var b = M ? d.base(M) : null, lo, hi, out = [];
        if (key === 'wc') { lo = 0; hi = 80; }
        else if (key === 'bean') { var bl = (_get(M, ['surface', 'beans'], null) || [16, 20, 24, 32, 40, 48]).map(Number).filter(function (x) { return x >= 2 && x <= 192; }); if (bl.length >= 2) return { ok: true, values: bl.slice(0, MAX_VALUES), errors: [], warnings: [] }; lo = 16; hi = 64; }
        else if (key === 'tubingId') { return { ok: true, values: [1.995, 2.441, 2.992, 3.958].slice(0, n), errors: [], warnings: [] }; }
        else if (key === 'skin') { lo = -3; hi = 20; }
        else if (_fin(b) && b > 0) { lo = b * 0.5; hi = b * 1.5; if (key === 'pr') { lo = b * 0.7; hi = b * 1.1; } }
        else if (key === 'thp' || key === 'psep') { lo = 100; hi = 500; }
        else if (key === 'gor' || key === 'glr') { lo = 200; hi = 1500; }
        else { lo = d.lo; hi = Math.min(d.hi, d.lo * 10 + 10); }
        lo = Math.max(d.lo, lo); hi = Math.min(d.hi, hi);
        for (var i = 0; i < n; i++) { var v = lo + (hi - lo) * i / (n - 1); out.push(key === 'skin' || key === 'wc' ? Math.round(v) : _nice(v)); }
        if (_fin(b) && b >= d.lo && b <= d.hi && out.indexOf(b) === -1) { out.push(b); out.sort(function (a, c) { return a - c; }); if (out.length > MAX_VALUES) out.pop(); }
        return { ok: true, values: out.filter(function (v, i, a) { return a.indexOf(v) === i; }), base: b, errors: [], warnings: [] };
    }

    // ── matrix (full factorial) ──────────────────────────────────────────────
    function _vals(spec, errors) {
        var d = VARS[spec.key], out = [];
        (Array.isArray(spec.values) ? spec.values : []).forEach(function (raw) {
            var v = _n(raw), label = null;
            if (!_fin(v) && spec.key === 'tubingId' && typeof raw === 'string' && G.WTS_tubulars && G.WTS_tubulars.find && G.WTS_tubulars.find(raw)) { v = G.WTS_tubulars.find(raw).id; label = raw; }
            if (!_fin(v)) { errors.push(d.label + ': "' + String(raw).slice(0, 20) + '" is not a number'); return; }
            if (v < d.lo || v > d.hi) { errors.push(d.label + ' ' + _f(v) + ' ' + d.unit + ' is outside ' + _f(d.lo) + '–' + _f(d.hi) + ' ' + d.unit); return; }
            if (out.some(function (o) { return o.v === v; })) return;
            out.push({ v: v, raw: label || v, label: label });
        });
        return out;
    }
    function matrix(list) {
        var errors = [], warnings = [];
        if (!Array.isArray(list) || !list.length) return { ok: false, cases: [], errors: ['no sensitivity variable'], warnings: [] };
        if (list.length > MAX_VARS) return { ok: false, cases: [], errors: ['at most ' + MAX_VARS + ' variables'], warnings: [] };
        var seen = {}, axes = [];
        list.forEach(function (s) {
            if (!s || !VARS[s.key]) { errors.push('unknown sensitivity variable ' + String(s && s.key).slice(0, 40)); return; }
            if (seen[s.key]) { errors.push(VARS[s.key].label + ' is listed twice'); return; }
            seen[s.key] = 1;
            var vs = _vals(s, errors);
            if (!vs.length) { errors.push(VARS[s.key].label + ': no valid value'); return; }
            if (vs.length > MAX_VALUES) { errors.push(VARS[s.key].label + ': at most ' + MAX_VALUES + ' values'); return; }
            axes.push({ key: s.key, vals: vs });
        });
        if (errors.length) return { ok: false, cases: [], errors: errors, warnings: warnings };
        var n = axes.reduce(function (a, x) { return a * x.vals.length; }, 1);
        if (n > MAX_CASES) return { ok: false, cases: [], errors: ['at most ' + MAX_CASES + ' cases (' + n + ' asked)'], warnings: [] };
        var cases = [{ values: {}, raw: {} }];
        axes.forEach(function (ax) {
            var next = [];
            cases.forEach(function (c) { ax.vals.forEach(function (o) { var nc = { values: Object.assign({}, c.values), raw: Object.assign({}, c.raw) }; nc.values[ax.key] = o.v; nc.raw[ax.key] = o.raw; if (o.label) nc.label = o.label; next.push(nc); }); });
            cases = next;
        });
        return { ok: true, cases: cases, axes: axes.map(function (a) { return { key: a.key, values: a.vals.map(function (o) { return o.v; }) }; }), errors: [], warnings: warnings };
    }

    // ── summary of one solve (the R-summary of a case) ───────────────────────
    function _summary(R, family) {
        var ok = !!(R && R.ok && R.op);
        var s = { ok: ok, code: ok ? null : ((R && R.code) || 'FAILED'), error: ok ? null : ((R && R.errors && R.errors[0]) || 'no operating point'),
            q: ok ? R.op.q : null, qo: null, qw: null, qg: null, qL: null, pwf: ok ? (_fin(R.pwf) ? R.pwf : R.op.p) : null,
            thp: null, tht: null, stable: ok ? !!R.op.stable : false, loadingMargin: null, regime: null,
            tracked: !!(R && R.tracked), evals: R ? (R.evals || 0) : 0, op: ok ? { q: R.op.q, p: R.op.p } : null, qs: ok && R.qs ? { q: R.qs.q, p: R.qs.p } : null,
            curve: [], family: family, flags: [] };
        if (ok) {
            var rt = R.rates || {};
            s.qo = _fin(rt.qo) ? rt.qo : null; s.qw = _fin(rt.qw) ? rt.qw : null; s.qg = _fin(rt.qg) ? rt.qg : null; s.qL = _fin(rt.qL) ? rt.qL : null;
            var sf = R.surface || {};
            s.thp = _fin(sf.thp_psig) ? sf.thp_psig : null; s.tht = _fin(sf.tht) ? sf.tht : null;
            s.regime = sf.choke && sf.choke.present !== false ? (sf.choke.regime || null) : null;
            s.loadingMargin = R.loading && _fin(R.loading.margin) ? R.loading.margin : null;
            s.flags = (R.flags || []).filter(function (f) { return f && f.sev === 'warn'; }).map(function (f) { return f.code; }).slice(0, 8);
        }
        return s;
    }
    function _iprCurve(Mx, F) {
        var I = _fn('WTS_wp_ipr.curve') ? G.WTS_wp_ipr.curve(Mx.res, F) : null;
        if (!I || !I.ok || !(I.aof > 0)) return [];
        var out = []; for (var k = 0; k <= 40; k++) { var q = I.aof * k / 40, p = I.pwfAt(q); if (_fin(p)) out.push({ q: q, p: p }); }
        return out;
    }
    function _withKnot(cur, op) {
        if (!op || !_fin(op.q) || !_fin(op.p)) return cur;
        var c = cur.filter(function (p) { return Math.abs(p.q - op.q) > 1e-6 * Math.max(1, op.q); });
        c.push({ q: op.q, p: op.p });
        c.sort(function (a, b) { return a.q - b.q; });
        return c;
    }

    // ── the Job (§6.4) ───────────────────────────────────────────────────────
    function _failJob(code, errors, warnings) {
        var res = { ok: false, code: code, cases: [], table: { head: [], rows: [] }, evals: 0, errors: errors, warnings: warnings || [] };
        return { step: function () { return { done: true, progress: 1, label: '' }; }, done: function () { return true; }, progress: function () { return 1; },
            result: function () { return res; }, cancel: function () { }, errors: errors, code: code };
    }
    function job(M, list, o) {
        o = o || {};
        if (!_fn('WTS_wp_system.solve')) return _failJob('MISSING_ENGINE', ['WTS_wp_system.solve is not available'], []);
        if (!M || !M.res || !M.fluid || !M.surface || !M.system) return _failJob('NO_MODEL', ['the model is incomplete'], []);
        var mx = matrix(list);
        if (!mx.ok) return _failJob('BAD_VARS', mx.errors, mx.warnings);
        if (mx.axes.length > 2) return jobN(M, mx, o);
        if (mx.axes.length === 2) return job2(M, mx, o);
        var key = mx.axes[0].key, d = VARS[key], why = _applicable(M, key);
        if (why) return _failJob('NOT_APPLICABLE', [d.label + ': ' + why], []);
        var SY = G.WTS_wp_system, base = _clone(M), bv = d.base(M), fams = o.families !== false;
        // sort by value; the start case = the model's own value (exact) or the value nearest to it, else the middle
        var cases = mx.cases.map(function (c) { return { values: c.values, raw: c.raw[key], label: c.label || null, v: c.values[key], R: null, res: null }; });
        cases.sort(function (a, b) { return a.v - b.v; });
        var start = Math.floor((cases.length - 1) / 2), exact = false;
        if (_fin(bv)) {
            start = 0; cases.forEach(function (c, i) { if (Math.abs(c.v - bv) < Math.abs(cases[start].v - bv)) start = i; });
            exact = Math.abs(cases[start].v - bv) <= 1e-9 * Math.max(1, Math.abs(bv));
        }
        var order = [start]; for (var i = start + 1; i < cases.length; i++) order.push(i); for (var j = start - 1; j >= 0; j--) order.push(j);
        var F = null;
        if (d.family === 'ipr' && fams && _fn('WTS_wp_fluid.build')) { F = G.WTS_wp_fluid.build(base.fluid, { T_F: base.res.T_F, table: false }); if (!F || !F.ok) F = null; }
        var st = { i: 0, done: false, cancelled: false, grid: null, res: null, warnings: mx.warnings.slice() };
        if (_fin(bv) && !exact) st.warnings.push(_w('NO_BASE_CASE', 'The model value ' + _f(bv) + ' ' + d.unit + ' is not in the list: the sensitivity has no base case.', 'info'));
        if (key === 'psep' && !_get(M, ['surface', 'choke', 'present'], false) && _fin(_n(_get(M, ['system', 'thp_psig'])))) st.warnings.push(_w('PSEP_NO_EFFECT', 'The wellhead pressure is fixed (choke out of line): the separator pressure does not change the rate.'));
        if (key === 'wc' && _get(M, ['res', 'model'], '') === 'pi') st.warnings.push(_w('WC_IPR', 'The straight-line IPR does not change with water cut: only the outflow changes.', 'info'));

        function neighbour(idx) {
            // the solved neighbour on the walk side and the one beyond it (linear extrapolation of the rate)
            var dir = idx > start ? -1 : 1, a = cases[idx + dir], b = cases[idx + 2 * dir];
            if (!a || !a.R || !a.R.ok) return null;
            var q = a.R.op.q;
            if (b && b.R && b.R.ok && b.v !== a.v) { var qe = a.R.op.q + (b.R.op.q - a.R.op.q) / (b.v - a.v) * (cases[idx].v - a.v); if (qe > 0) q = qe; }
            return { q: q, slope: a.R.op.dDdq };
        }
        function solveCase(idx) {
            var c = cases[idx], Mx = _clone(base);
            if (!(idx === start && exact)) { var e = d.apply(Mx, c.v, c.raw); if (e) { c.res = { ok: false, code: 'NOT_APPLICABLE', error: e, evals: 0, curve: [], family: d.family }; return; } }
            var R, opt = {};
            if (idx === start) R = SY.solve(Mx);                                     // the single solve, exactly (§15.2)
            else {
                if (st.grid) opt.warm = st.grid;
                var nb = neighbour(idx);
                if (nb && nb.q > 0) opt.track = { q: nb.q, slope: nb.slope };
                R = SY.solve(Mx, opt);
            }
            if (!st.grid && R && R.grid && (R.grid.fine || R.grid.coarse)) st.grid = R.grid;
            c.R = R;
            var s = _summary(R, d.family);
            if (fams) {
                if (d.family === 'ipr') s.curve = F ? _iprCurve(Mx, F) : [];
                else if (R && !R.tracked && R.curves && R.curves.vlp && R.curves.vlp.length) s.curve = R.curves.vlp.map(function (p) { return { q: p.q, p: p.p }; });
                else if (R && R.tracked) {
                    var Rc = SY.solve(Mx, { warm: st.grid || undefined, coarseOnly: true, scanFracs: FAM_FRACS });
                    if (Rc && Rc.curves && Rc.curves.vlp) s.curve = _withKnot(Rc.curves.vlp.filter(function (p) { return _fin(p.p); }).map(function (p) { return { q: p.q, p: p.p }; }), R.node === 'bottom' ? s.op : null);
                    s.evals += Rc ? (Rc.evals || 0) : 0;
                }
            }
            c.res = s;
        }
        function finish() {
            if (st.res) return st.res;
            if (st.cancelled) { st.res = { ok: false, code: 'CANCELLED', key: key, cases: [], table: { head: [], rows: [] }, evals: 0, cancelled: true, errors: ['cancelled'], warnings: [] }; return st.res; }
            var out = cases.map(function (c) { var r = { values: c.values, R: c.res || { ok: false, code: 'NOT_RUN', error: 'not run', evals: 0, curve: [], family: d.family } }; if (c.label) r.label = c.label; return r; });
            var nOk = out.filter(function (c) { return c.R.ok; }).length;
            var tp = _type(M), res = { ok: nOk > 0, key: key, label: d.label, unit: d.unit, family: d.family, fluidType: tp,
                rateUnit: tp === 'oil' ? 'STB/d liquid' : tp === 'water' ? 'BWPD' : 'Mscf/d', base: { value: _fin(bv) ? bv : null, inList: exact },
                start: cases[start].v, cases: out, evals: out.reduce(function (a, c) { return a + (c.R.evals || 0); }, 0),
                errors: nOk ? [] : ['No case has an operating point.'], warnings: st.warnings };
            out.forEach(function (c) { if (!c.R.ok && c.R.code === 'NOT_APPLICABLE') res.warnings.push(_w('CASE_NA', c.R.error)); });
            res.table = table(res);
            st.res = res;
            return res;
        }
        var J = {
            key: key, n: cases.length,
            step: function () {
                if (!st.done && !st.cancelled) {
                    solveCase(order[st.i]);
                    st.i++;
                    if (st.i >= order.length) st.done = true;
                } else st.done = true;
                if (st.done) finish();
                var nx = order[Math.min(st.i, order.length - 1)];
                return { done: st.done, progress: st.done ? 1 : Math.min(0.99, st.i / order.length), label: st.done ? 'done' : (d.label + ' ' + _f(cases[nx].v) + (d.unit ? ' ' + d.unit : '') + ' (' + (st.i + 1) + ' of ' + order.length + ')') };
            },
            done: function () { return st.done; },
            progress: function () { return st.done ? 1 : st.i / order.length; },
            result: function () { return finish(); },
            cancel: function () { st.cancelled = true; st.done = true; st.res = null; }
        };
        return J;
    }


    // ── two variables (A2, WP16; §6.2): the primary variable along x, one line per value of the second ─────────────────
    // The start cell (both model values when listed, else the nearest) is a cold solve — the plain single solve when both values
    // are the model's own (§15.2). Its row walks outwards along the primary variable; every further row starts from the cell of
    // the row before at the same primary value (tracking solve), so each cell is warm-started from a solved neighbour on the start
    // cell's frozen layout. Rates only (no family curves: one rate line per second-variable value; the 2-D table is the heat map).
    var CONFLICT = [['thp', 'bean'], ['thp', 'psep'], ['gor', 'glr'], ['skin', 'kh']];
    function job2(M, mx, o) {
        var a1 = mx.axes[0], a2 = mx.axes[1], k1 = a1.key, k2 = a2.key, d1 = VARS[k1], d2 = VARS[k2];
        var w1 = _applicable(M, k1), w2 = _applicable(M, k2);
        if (w1) return _failJob('NOT_APPLICABLE', [d1.label + ': ' + w1], []);
        if (w2) return _failJob('NOT_APPLICABLE', [d2.label + ': ' + w2], []);
        var cf = CONFLICT.filter(function (c) { return (c[0] === k1 && c[1] === k2) || (c[0] === k2 && c[1] === k1); })[0];
        if (cf) return _failJob('BAD_PAIR', [d1.label + ' and ' + d2.label + ' cannot be varied together (' + (cf[0] === 'thp' && cf[1] === 'bean' ? 'a fixed wellhead pressure takes the choke out of line' : cf[0] === 'thp' ? 'with a fixed wellhead pressure the separator pressure has no effect' : 'they set the same input') + ').'], []);
        var SY = G.WTS_wp_system, base = _clone(M);
        var sortV = function (vals) { return vals.slice().sort(function (a, b) { return a - b; }); };
        var xs = sortV(a1.values), ys = sortV(a2.values), b1 = d1.base(M), b2 = d2.base(M);
        var raw1 = {}, raw2 = {};
        mx.cases.forEach(function (c) { raw1[c.values[k1]] = c.raw[k1]; raw2[c.values[k2]] = c.raw[k2]; });
        var near = function (vals, b) { var k = Math.floor((vals.length - 1) / 2), ex = false; if (_fin(b)) { k = 0; vals.forEach(function (v, i) { if (Math.abs(v - b) < Math.abs(vals[k] - b)) k = i; }); ex = Math.abs(vals[k] - b) <= 1e-9 * Math.max(1, Math.abs(b)); } return { i: k, exact: ex }; };
        var s1 = near(xs, b1), s2 = near(ys, b2);
        var cell = [];
        ys.forEach(function (y, j) { cell[j] = xs.map(function (x, i) { return { i: i, j: j, x: x, y: y, R: null, res: null }; }); });
        var walk = function (n, s) { var o2 = [s]; for (var i = s + 1; i < n; i++) o2.push(i); for (var k = s - 1; k >= 0; k--) o2.push(k); return o2; };
        var order = [];
        walk(ys.length, s2.i).forEach(function (j) { walk(xs.length, s1.i).forEach(function (i) { order.push(cell[j][i]); }); });
        var st = { i: 0, done: false, cancelled: false, grid: null, res: null, warnings: mx.warnings.slice() };
        if (_fin(b1) && !s1.exact) st.warnings.push(_w('NO_BASE_CASE', 'The model value ' + _f(b1) + ' ' + d1.unit + ' of ' + d1.label + ' is not in the list.', 'info'));
        if (_fin(b2) && !s2.exact) st.warnings.push(_w('NO_BASE_CASE', 'The model value ' + _f(b2) + ' ' + d2.unit + ' of ' + d2.label + ' is not in the list.', 'info'));
        var startCell = cell[s2.i][s1.i], exactBoth = s1.exact && s2.exact;
        function nb(c) {
            var dj = c.j > s2.i ? -1 : 1, up = cell[c.j + dj] && cell[c.j + dj][c.i];
            if (c.j !== s2.i && up && up.R && up.R.ok) return { q: up.R.op.q, slope: up.R.op.dDdq };
            var di = c.i > s1.i ? -1 : 1, lf = cell[c.j][c.i + di];
            if (lf && lf.R && lf.R.ok) return { q: lf.R.op.q, slope: lf.R.op.dDdq };
            return null;
        }
        function solveCell(c) {
            var Mx = _clone(base);
            if (!(c === startCell && exactBoth)) {
                var e = d2.apply(Mx, c.y, raw2[c.y]) || d1.apply(Mx, c.x, raw1[c.x]);
                if (e) { c.res = { ok: false, code: 'NOT_APPLICABLE', error: e, evals: 0, curve: [], family: d1.family }; return; }
            }
            var R, opt = {};
            if (c === startCell) R = SY.solve(Mx);
            else { if (st.grid) opt.warm = st.grid; var n2 = nb(c); if (n2 && n2.q > 0) opt.track = { q: n2.q, slope: n2.slope }; R = SY.solve(Mx, opt); }
            if (!st.grid && R && R.grid && (R.grid.fine || R.grid.coarse)) st.grid = R.grid;
            c.R = R; c.res = _summary(R, d1.family);
        }
        function finish() {
            if (st.res) return st.res;
            if (st.cancelled) { st.res = { ok: false, code: 'CANCELLED', key: k1, key2: k2, cases: [], table: { head: [], rows: [] }, evals: 0, cancelled: true, errors: ['cancelled'], warnings: [] }; return st.res; }
            var cases = [], q = [], stab = [], nOk = 0;
            ys.forEach(function (y, j) {
                q[j] = []; stab[j] = [];
                xs.forEach(function (x, i) {
                    var c = cell[j][i], r = c.res || { ok: false, code: 'NOT_RUN', error: 'not run', evals: 0, curve: [], family: d1.family }, v = {};
                    v[k1] = x; v[k2] = y;
                    var cs = { values: v, R: r, i: i, j: j };
                    if (typeof raw1[x] === 'string') cs.label = raw1[x];
                    if (typeof raw2[y] === 'string') cs.label2 = raw2[y];
                    cases.push(cs);
                    q[j][i] = r.ok ? r.q : null; stab[j][i] = r.ok ? !!r.stable : null;
                    if (r.ok) nOk++;
                });
            });
            var tp = _type(M), res = { ok: nOk > 0, key: k1, key2: k2, label: d1.label, label2: d2.label, unit: d1.unit, unit2: d2.unit, family: d1.family, fluidType: tp, two: true,
                rateUnit: tp === 'oil' ? 'STB/d liquid' : tp === 'water' ? 'BWPD' : 'Mscf/d',
                base: { value: _fin(b1) ? b1 : null, inList: s1.exact }, base2: { value: _fin(b2) ? b2 : null, inList: s2.exact }, start: { x: xs[s1.i], y: ys[s2.i] },
                grid: { x: xs.slice(), y: ys.slice(), q: q, stable: stab, labelsX: xs.map(function (x) { return typeof raw1[x] === 'string' ? raw1[x] : null; }), labelsY: ys.map(function (y) { return typeof raw2[y] === 'string' ? raw2[y] : null; }) },
                cases: cases, evals: cases.reduce(function (a, c) { return a + (c.R.evals || 0); }, 0), errors: nOk ? [] : ['No case has an operating point.'], warnings: st.warnings };
            cases.forEach(function (c) { if (!c.R.ok && c.R.code === 'NOT_APPLICABLE' && !res.warnings.some(function (w) { return w.msg === String(c.R.error).slice(0, 299); })) res.warnings.push(_w('CASE_NA', c.R.error)); });
            res.table = table(res);
            st.res = res;
            return res;
        }
        return {
            key: k1, key2: k2, n: order.length,
            step: function () {
                if (!st.done && !st.cancelled) { solveCell(order[st.i]); st.i++; if (st.i >= order.length) st.done = true; } else st.done = true;
                if (st.done) finish();
                var nx = order[Math.min(st.i, order.length - 1)];
                return { done: st.done, progress: st.done ? 1 : Math.min(0.99, st.i / order.length), label: st.done ? 'done' : (d1.label + ' ' + _f(nx.x) + ', ' + d2.label + ' ' + _f(nx.y) + ' (' + (st.i + 1) + ' of ' + order.length + ')') };
            },
            done: function () { return st.done; },
            progress: function () { return st.done ? 1 : st.i / order.length; },
            result: function () { return finish(); },
            cancel: function () { st.cancelled = true; st.done = true; st.res = null; }
        };
    }

    // ── three or four variables (B, WP27; §6.2): the full factorial walked breadth-first from the start cell ──────────────
    // The start cell (every model value when listed, else the nearest) is a cold solve — the plain single solve when every value
    // is the model's own (§15.2). Every other cell is a tracking solve warm-started from the solved neighbour it was reached from
    // (one index away in one variable) on the start cell's frozen layout; rates only.
    function jobN(M, mx, o) {
        var axes = mx.axes, D = axes.length, keys = axes.map(function (a) { return a.key; }), defs = keys.map(function (k) { return VARS[k]; });
        for (var a = 0; a < D; a++) { var why = _applicable(M, keys[a]); if (why) return _failJob('NOT_APPLICABLE', [defs[a].label + ': ' + why], []); }
        for (var i1 = 0; i1 < D; i1++) for (var i2 = i1 + 1; i2 < D; i2++) {
            var k1 = keys[i1], k2 = keys[i2], cf = CONFLICT.filter(function (c) { return (c[0] === k1 && c[1] === k2) || (c[0] === k2 && c[1] === k1); })[0];
            if (cf) return _failJob('BAD_PAIR', [defs[i1].label + ' and ' + defs[i2].label + ' cannot be varied together.'], []);
        }
        var SY = G.WTS_wp_system, base = _clone(M);
        var vals = axes.map(function (ax) { return ax.values.slice().sort(function (x, y) { return x - y; }); });
        var raw = keys.map(function () { return {}; });
        mx.cases.forEach(function (c) { keys.forEach(function (k, d) { raw[d][c.values[k]] = c.raw[k]; }); });
        var start = [], exact = [];
        vals.forEach(function (vs, d) {
            var b = defs[d].base(M), k = Math.floor((vs.length - 1) / 2), ex = false;
            if (_fin(b)) { k = 0; vs.forEach(function (v, i) { if (Math.abs(v - b) < Math.abs(vs[k] - b)) k = i; }); ex = Math.abs(vs[k] - b) <= 1e-9 * Math.max(1, Math.abs(b)); }
            start.push(k); exact.push(ex);
        });
        var strides = [], n = 1;
        for (var d0 = D - 1; d0 >= 0; d0--) { strides[d0] = n; n *= vals[d0].length; }
        var idxOf = function (ix) { var s = 0; for (var d = 0; d < D; d++) s += ix[d] * strides[d]; return s; };
        var ixOf = function (f) { var ix = []; for (var d = 0; d < D; d++) { ix.push(Math.floor(f / strides[d]) % vals[d].length); } return ix; };
        // breadth-first order from the start cell, each cell with the neighbour it was reached from
        var s0 = idxOf(start), order = [s0], parent = {}, seen = {}; seen[s0] = 1; parent[s0] = -1;
        for (var qh = 0; qh < order.length; qh++) {
            var ix0 = ixOf(order[qh]);
            for (var d1 = 0; d1 < D; d1++) [-1, 1].forEach(function (dd) {
                var ix2 = ix0.slice(); ix2[d1] += dd;
                if (ix2[d1] < 0 || ix2[d1] >= vals[d1].length) return;
                var f2 = idxOf(ix2); if (seen[f2]) return;
                seen[f2] = 1; parent[f2] = order[qh]; order.push(f2);
            });
        }
        var cells = {}, st = { i: 0, done: false, cancelled: false, grid: null, res: null, warnings: mx.warnings.slice() };
        vals.forEach(function (vs, d) { var b = defs[d].base(M); if (_fin(b) && !exact[d]) st.warnings.push(_w('NO_BASE_CASE', 'The model value ' + _f(b) + ' ' + defs[d].unit + ' of ' + defs[d].label + ' is not in the list.', 'info')); });
        var exactAll = exact.every(Boolean);
        function solveCell(f) {
            var ix = ixOf(f), Mx = _clone(base), e = null;
            if (!(f === s0 && exactAll)) for (var d = 0; d < D && !e; d++) e = defs[d].apply(Mx, vals[d][ix[d]], raw[d][vals[d][ix[d]]]);
            if (e) { cells[f] = { R: null, res: { ok: false, code: 'NOT_APPLICABLE', error: e, evals: 0, curve: [], family: defs[0].family } }; return; }
            var R, opt = {};
            if (f === s0) R = SY.solve(Mx);
            else {
                if (st.grid) opt.warm = st.grid;
                var p = parent[f], pc = cells[p];
                if (pc && pc.R && pc.R.ok && pc.R.op) opt.track = { q: pc.R.op.q, slope: pc.R.op.dDdq };
                else { var alt = null; for (var d2 = 0; d2 < D && !alt; d2++) [-1, 1].forEach(function (dd) { if (alt) return; var ix3 = ix.slice(); ix3[d2] += dd; if (ix3[d2] < 0 || ix3[d2] >= vals[d2].length) return; var c3 = cells[idxOf(ix3)]; if (c3 && c3.R && c3.R.ok && c3.R.op) alt = c3; }); if (alt) opt.track = { q: alt.R.op.q, slope: alt.R.op.dDdq }; }
                R = SY.solve(Mx, opt);
            }
            if (!st.grid && R && R.grid && (R.grid.fine || R.grid.coarse)) st.grid = R.grid;
            cells[f] = { R: R, res: _summary(R, defs[0].family) };
        }
        function finish() {
            if (st.res) return st.res;
            if (st.cancelled) { st.res = { ok: false, code: 'CANCELLED', keys: keys, nd: true, cases: [], table: { head: [], rows: [] }, evals: 0, cancelled: true, errors: ['cancelled'], warnings: [] }; return st.res; }
            var q = [], stab = [], cases = [], nOk = 0;
            for (var f = 0; f < n; f++) {
                var c = cells[f], r = c ? c.res : { ok: false, code: 'NOT_RUN', error: 'not run', evals: 0, curve: [], family: defs[0].family }, ix = ixOf(f), v = {}, lab = null;
                keys.forEach(function (k, d) { v[k] = vals[d][ix[d]]; var rw = raw[d][vals[d][ix[d]]]; if (typeof rw === 'string') lab = (lab ? lab + ' · ' : '') + rw; });
                q[f] = r.ok ? r.q : null; stab[f] = r.ok ? !!r.stable : null; if (r.ok) nOk++;
                var cs = { values: v, R: r, idx: ix }; if (lab) cs.label = lab;
                cases.push(cs);
            }
            var tp = _type(M), res = { ok: nOk > 0, nd: true, key: keys[0], keys: keys, labels: defs.map(function (x) { return x.label; }), units: defs.map(function (x) { return x.unit; }),
                axes: keys.map(function (k, d) { return { key: k, values: vals[d].slice(), labels: vals[d].map(function (x) { return typeof raw[d][x] === 'string' ? raw[d][x] : null; }) }; }),
                strides: strides.slice(), q: q, stable: stab, cases: cases, start: start.slice(), base: defs.map(function (x, d) { var b = x.base(M); return { value: _fin(b) ? b : null, inList: exact[d] }; }),
                family: defs[0].family, fluidType: tp, rateUnit: tp === 'oil' ? 'STB/d liquid' : tp === 'water' ? 'BWPD' : 'Mscf/d',
                evals: cases.reduce(function (s2, c2) { return s2 + (c2.R.evals || 0); }, 0), errors: nOk ? [] : ['No case has an operating point.'], warnings: st.warnings };
            cases.forEach(function (c2) { if (!c2.R.ok && c2.R.code === 'NOT_APPLICABLE' && !res.warnings.some(function (w) { return w.msg === String(c2.R.error).slice(0, 299); })) res.warnings.push(_w('CASE_NA', c2.R.error)); });
            res.table = table(res);
            st.res = res;
            return res;
        }
        return {
            key: keys[0], keys: keys, n: order.length,
            step: function () {
                if (!st.done && !st.cancelled) { solveCell(order[st.i]); st.i++; if (st.i >= order.length) st.done = true; } else st.done = true;
                if (st.done) finish();
                var nx = ixOf(order[Math.min(st.i, order.length - 1)]);
                return { done: st.done, progress: st.done ? 1 : Math.min(0.99, st.i / order.length), label: st.done ? 'done' : ('case ' + (st.i + 1) + ' of ' + order.length + ': ' + keys.map(function (k, d) { return _f(vals[d][nx[d]]); }).join(' · ')) };
            },
            done: function () { return st.done; },
            progress: function () { return st.done ? 1 : st.i / order.length; },
            result: function () { return finish(); },
            cancel: function () { st.cancelled = true; st.done = true; st.res = null; }
        };
    }

    // ── tornado (B, WP27; §6.2): the rate at the low and high value of every variable, one at a time around the model ─────
    // The base = the single solve exactly; every low / high case is a tracking solve warm-started from the base root on its frozen
    // layout (the solver falls back to a full solve when the bracket fails). Bars sorted by the swing |q_hi − q_lo| (a case that does
    // not flow counts as rate 0 and is marked).
    var TORNADO = {
        pr: function (b, f) { return [b * (1 - f / 2), b * (1 + f / 2)]; },
        wc: function (b) { return [Math.max(0, b - 10), Math.min(98, b + 10)]; },
        gor: function (b, f) { return [b * (1 - f), b * (1 + f)]; }, glr: function (b, f) { return [b * (1 - f), b * (1 + f)]; },
        wgr: function (b, f) { return b > 0 ? [b * (1 - 2 * f), b * (1 + 2 * f)] : [0, 20]; }, cgr: function (b, f) { return b > 0 ? [b * (1 - 2 * f), b * (1 + 2 * f)] : [0, 20]; },
        thp: function (b, f) { return [Math.max(0, b * (1 - f)), b * (1 + f)]; }, psep: function (b, f) { return [Math.max(0, b * (1 - f)), b * (1 + f)]; },
        bean: function (b) { return [Math.max(4, b - 8), Math.min(128, b + 8)]; },
        J: function (b, f) { return [b * (1 - f), b * (1 + f)]; }, kh: function (b, f) { return [b * (1 - 2 * f), b * (1 + 2 * f)]; },
        skin: function (b) { return [b - 2, b + 5]; },
        tubingId: function (b) {
            var T = G.WTS_tubulars, ids = (T && typeof T.list === 'function') ? T.list('tubing').map(function (e) { return e.id; }).filter(_fin).sort(function (x, y) { return x - y; }) : [];
            ids = ids.filter(function (x, i, a) { return a.indexOf(x) === i; });
            var lo = ids.filter(function (x) { return x < b - 0.05; }).pop(), hi = ids.filter(function (x) { return x > b + 0.05; })[0];
            return [_fin(lo) ? lo : b * 0.8, _fin(hi) ? hi : b * 1.25];
        }
    };
    var TORNADO_ORDER = ['pr', 'wc', 'gor', 'wgr', 'cgr', 'thp', 'bean', 'psep', 'tubingId', 'J', 'skin', 'kh'];
    function tornado(M, o) {
        o = o || {};
        if (!_fn('WTS_wp_system.solve')) return _failJob('MISSING_ENGINE', ['WTS_wp_system.solve is not available'], []);
        if (!M || !M.res || !M.fluid || !M.surface || !M.system) return _failJob('NO_MODEL', ['the model is incomplete'], []);
        var frac = _fin(+o.frac) && +o.frac > 0 && +o.frac < 0.9 ? +o.frac : 0.2, list = [], warnings = [];
        var asked = Array.isArray(o.vars) && o.vars.length ? o.vars : TORNADO_ORDER.map(function (k) { return { key: k }; });
        asked.forEach(function (v) {
            var k = v && v.key, d = VARS[k]; if (!d) { warnings.push(_w('UNKNOWN_VAR', 'unknown variable ' + String(k).slice(0, 30))); return; }
            if (_applicable(M, k)) return;
            var b = d.base(M); if (!_fin(b)) return;
            var lh = (_fin(+v.lo) && _fin(+v.hi)) ? [+v.lo, +v.hi] : (TORNADO[k] ? TORNADO[k](b, frac) : [b * (1 - frac), b * (1 + frac)]);
            var lo = Math.max(d.lo, Math.min(lh[0], lh[1])), hi = Math.min(d.hi, Math.max(lh[0], lh[1]));
            if (k === 'skin' || k === 'wc' || k === 'bean') { lo = Math.round(lo * 10) / 10; hi = Math.round(hi * 10) / 10; } else { lo = +lo.toPrecision(4); hi = +hi.toPrecision(4); }
            if (!(hi > lo)) return;
            list.push({ key: k, label: d.label, unit: d.unit, base: b, lo: lo, hi: hi });
        });
        if (!list.length) return _failJob('NO_VARS', ['no applicable variable has a model value to vary'], warnings);
        var SY = G.WTS_wp_system, base = _clone(M), st = { R0: null, grid: null, i: 0, done: false, cancelled: false, res: null }, todo = [];
        list.forEach(function (v) { todo.push({ v: v, side: 'lo' }); todo.push({ v: v, side: 'hi' }); });
        var n = 1 + todo.length, gas = ['gas', 'condensate'].indexOf(_type(M)) !== -1;
        var qOf = function (s) { return s && s.ok ? (gas ? s.qg : s.q) : null; };
        function finish() {
            if (st.res) return st.res;
            if (st.cancelled) { st.res = { ok: false, code: 'CANCELLED', cancelled: true, bars: [], evals: 0, errors: ['cancelled'], warnings: [] }; return st.res; }
            var b0 = _summary(st.R0, 'vlp'), q0 = qOf(b0), ev = (st.R0 && st.R0.evals) || 0;
            var bars = list.map(function (v) {
                var L = v.resLo || { ok: false }, H = v.resHi || { ok: false }; ev += (L.evals || 0) + (H.evals || 0);
                var qL = qOf(L), qH = qOf(H), aL = _fin(qL) ? qL : 0, aH = _fin(qH) ? qH : 0;
                return { key: v.key, label: v.label, unit: v.unit, base: v.base, lo: v.lo, hi: v.hi, qLo: qL, qHi: qH, okLo: !!L.ok, okHi: !!H.ok, stableLo: !!L.stable, stableHi: !!H.stable,
                    noteLo: L.ok ? (L.stable ? '' : 'unstable') : (L.error || L.code || 'no flow'), noteHi: H.ok ? (H.stable ? '' : 'unstable') : (H.error || H.code || 'no flow'),
                    dLo: _fin(q0) ? aL - q0 : null, dHi: _fin(q0) ? aH - q0 : null, swing: Math.abs(aH - aL) };
            }).sort(function (x, y) { return y.swing - x.swing; });
            var tp = _type(M);
            st.res = { ok: !!(b0.ok), base: b0, q0: q0, bars: bars, frac: frac, fluidType: tp, rateUnit: tp === 'oil' ? 'STB/d liquid' : tp === 'water' ? 'BWPD' : 'Mscf/d', evals: ev,
                errors: b0.ok ? [] : ['the base case has no operating point'], warnings: warnings };
            return st.res;
        }
        return {
            n: n,
            step: function () {
                if (!st.done && !st.cancelled) {
                    if (st.i === 0) { st.R0 = SY.solve(base); st.grid = st.R0 && st.R0.grid; }
                    else {
                        var t = todo[st.i - 1], Mx = _clone(base), e = VARS[t.v.key].apply(Mx, t.side === 'lo' ? t.v.lo : t.v.hi);
                        var res;
                        if (e) res = { ok: false, code: 'NOT_APPLICABLE', error: e, evals: 0 };
                        else {
                            var opt = {}; if (st.grid) opt.warm = st.grid;
                            if (st.R0 && st.R0.ok && st.R0.op) opt.track = { q: st.R0.op.q, slope: st.R0.op.dDdq };
                            res = _summary(SY.solve(Mx, opt), 'vlp');
                        }
                        if (t.side === 'lo') t.v.resLo = res; else t.v.resHi = res;
                    }
                    st.i++; if (st.i >= n) st.done = true;
                } else st.done = true;
                if (st.done) finish();
                var t2 = todo[Math.min(st.i, n - 1) - 1];
                return { done: st.done, progress: st.done ? 1 : Math.min(0.99, st.i / n), label: st.done ? 'done' : (st.i === 0 || !t2 ? 'base case' : t2.v.label + ' ' + (t2.side === 'lo' ? 'low' : 'high') + ' (' + (st.i + 1) + ' of ' + n + ')') };
            },
            done: function () { return st.done; },
            progress: function () { return st.done ? 1 : st.i / n; },
            result: function () { return finish(); },
            cancel: function () { st.cancelled = true; st.done = true; st.res = null; }
        };
    }

    // ── table / CSV ──────────────────────────────────────────────────────────
    var HEAD_TAIL = ['q_o (STB/d)', 'q_w (BWPD)', 'q_g (Mscf/d)', 'q_L (STB/d)', 'pwf (psia)', 'THP (psig)', 'THT (°F)', 'Stable', 'Loading margin (%)', 'Choke regime', 'Note'];
    function table(res) {
        if (!res || !Array.isArray(res.cases) || !res.key || !VARS[res.key]) return { head: [], rows: [] };
        if (res.nd && Array.isArray(res.keys)) {
            var hd = res.keys.map(function (k) { var dk = VARS[k]; return dk.label + (dk.unit ? ' (' + dk.unit + ')' : ''); }).concat(['Rate (' + (res.rateUnit || 'IPR basis') + ')']).concat(HEAD_TAIL);
            return { head: hd, rows: res.cases.map(function (c) { var R = c.R || {}; return res.keys.map(function (k) { return c.values ? c.values[k] : null; }).concat([R.ok ? R.q : null, R.qo, R.qw, R.qg, R.qL, R.pwf, R.thp, R.tht, R.ok ? (R.stable ? 'yes' : 'no') : '',
                _fin(R.loadingMargin) ? R.loadingMargin * 100 : null, R.regime || '', R.ok ? (R.tracked ? 'tracked' : '') : (R.error || R.code || '')]); }) };
        }
        var d = VARS[res.key], d2 = res.key2 ? VARS[res.key2] : null;
        var head = [d.label + (d.unit ? ' (' + d.unit + ')' : '')].concat(d2 ? [d2.label + (d2.unit ? ' (' + d2.unit + ')' : '')] : []).concat(['Rate (' + (res.rateUnit || 'IPR basis') + ')']).concat(HEAD_TAIL);
        var rows = res.cases.map(function (c) {
            var R = c.R || {}, v = c.values ? c.values[res.key] : null;
            return [c.label || v].concat(d2 ? [c.label2 || (c.values ? c.values[res.key2] : null)] : []).concat([R.ok ? R.q : null, R.qo, R.qw, R.qg, R.qL, R.pwf, R.thp, R.tht, R.ok ? (R.stable ? 'yes' : 'no') : '',
                _fin(R.loadingMargin) ? R.loadingMargin * 100 : null, R.regime || '', R.ok ? (R.tracked ? 'tracked' : '') : (R.error || R.code || '')]);
        });
        return { head: head, rows: rows };
    }
    function _cell(x) {
        if (x == null) return '';
        if (typeof x === 'number') return isFinite(x) ? String(+x.toPrecision(10)) : '';
        var s = String(x); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    function csv(res) {
        var t = table(res);
        if (!t.head.length) return '';
        var d = VARS[res.key], L = [];
        if (res.nd) { L.push(_cell('Well Performance sensitivity matrix: ' + res.labels.join(' × ') + ' — field units')); L.push(t.head.map(_cell).join(',')); t.rows.forEach(function (r) { L.push(r.map(_cell).join(',')); }); return L.join('\n'); }
        L.push(_cell('Well Performance sensitivity: ' + d.label + (d.unit ? ' (' + d.unit + ')' : '') + ' — field units'));
        if (res.base && _fin(res.base.value)) L.push(_cell('Model value') + ',' + _cell(res.base.value) + (res.base.inList ? ',base case in the list' : ',not in the list'));
        L.push(t.head.map(_cell).join(','));
        t.rows.forEach(function (r) { L.push(r.map(_cell).join(',')); });
        var fam = res.cases.filter(function (c) { return c.R && Array.isArray(c.R.curve) && c.R.curve.length; });
        if (fam.length) {
            L.push('');
            L.push(_cell('Family curves (' + (d.family === 'ipr' ? 'inflow, one IPR per value' : 'outflow, one curve per value') + ')'));
            L.push([d.label + (d.unit ? ' (' + d.unit + ')' : ''), 'q (' + (res.rateUnit || 'IPR basis') + ')', 'p (psia)'].map(_cell).join(','));
            fam.forEach(function (c) { c.R.curve.forEach(function (p) { L.push([c.label || c.values[res.key], p.q, p.p].map(_cell).join(',')); }); });
        }
        if (res.grid && res.key2 && VARS[res.key2]) {
            // the 2-D rate table (rows: the second variable; columns: the primary variable); empty cell = no operating point
            var d2 = VARS[res.key2];
            L.push('');
            L.push(_cell('Rate (' + (res.rateUnit || '') + '): rows ' + d2.label + (d2.unit ? ' (' + d2.unit + ')' : '') + ', columns ' + d.label + (d.unit ? ' (' + d.unit + ')' : '')));
            L.push([''].concat(res.grid.x.map(function (x, i) { return res.grid.labelsX[i] || x; })).map(_cell).join(','));
            res.grid.y.forEach(function (y, j) { L.push([res.grid.labelsY[j] || y].concat(res.grid.q[j]).map(_cell).join(',')); });
        }
        return L.join('\n');
    }

    var NS = G.WTS_wp_sens = G.WTS_wp_sens || {};
    NS.VARS = VARS; NS.ORDER = ORDER.slice(); NS.vars = vars; NS.suggest = suggest;
    NS.matrix = matrix; NS.job = job; NS.table = table; NS.csv = csv;
    NS.tornado = tornado; NS.TORNADO_ORDER = TORNADO_ORDER.slice();
    NS.tornadoCsv = function (res) {
        if (!res || !Array.isArray(res.bars) || !res.bars.length) return '';
        var L = [_cell('Well Performance tornado — rate (' + res.rateUnit + ') at the low and high value of each variable; base ' + _f(res.q0, 1))];
        L.push(['Variable', 'Unit', 'Base', 'Low', 'High', 'Rate at low', 'Rate at high', 'Swing', 'Note low', 'Note high'].map(_cell).join(','));
        res.bars.forEach(function (b) { L.push([b.label, b.unit, b.base, b.lo, b.hi, b.qLo, b.qHi, b.swing, b.noteLo, b.noteHi].map(_cell).join(',')); });
        return L.join('\n');
    };
    NS.MAX_VALUES = MAX_VALUES; NS.FAM_FRACS = FAM_FRACS.slice();
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis, S = G.WTS_wp_sens, bad = [];
    if (!S || typeof S.matrix !== 'function' || typeof S.job !== 'function' || typeof S.table !== 'function' || typeof S.csv !== 'function') bad.push('namespace');
    else {
        var m = S.matrix([{ key: 'wc', values: [0, 20, 20, 40] }]);
        if (!m.ok || m.cases.length !== 3) bad.push('matrix dedupe');
        var m2 = S.matrix([{ key: 'wc', values: [0, 50] }, { key: 'pr', values: [2000, 2500, 3000] }]);
        if (!m2.ok || m2.cases.length !== 6) bad.push('matrix factorial');
        if (S.matrix([{ key: 'nope', values: [1] }]).ok) bad.push('unknown key');
    }
    if (bad.length && typeof console !== 'undefined') console.error('[49-calc-wp-sens.js self-test] ' + bad.join('; '));
})();
