// =============================================================================
// WTS — 49-calc-wp-export.js  (Round 9; helper module: no page in window.WTS_calcRegistry)
// -----------------------------------------------------------------------------
// Well Performance lift-curve tables and PVT tables (WP20, increment B) — docs/WELL-PERFORMANCE-PLAN.md §3.9, §9, §13, §16, B9, D9,
// D17, Q4.
//
// LIFT-CURVE TABLES (§9). Axes: rate (oil, liquid or gas basis; water or gas for an injector), THP, water fraction (WC, WOR or WGR),
//   gas fraction (GOR, GLR or OGR) and the artificial-lift quantity (lift-gas rate, or none); value = BHP at the table datum depth.
//   Every point is ONE top-down traverse from the THP at that rate, through the system solver's own evaluator
//   (WTS_wp_system.evalAt with {outflowOnly: true}: the model's well correlation, multipliers, temperature model (linear or the A2
//   relaxation), restrictions, deviated path and — on a lift-gas axis — the A2 gas-lift injection point solved inside the point; the
//   choke, flowline and separator are not in a lift table, the THP is the boundary). Nothing here re-implements a correlation, a
//   march or the injection depth. An injector table (water or gas injection well) marches the one marcher WTS_flowline_march down
//   the well WITH the flow (the producing path reversed, rise negated: hydrostatic gained, friction lost); the temperature is the
//   well's linear THT → BHT profile (no injection-temperature model in this release).
//   Datum: an MD on the surveyed path (default the mid-perforations); BHP there is read on the traverse (linear between its rows),
//   the record carries the datum TVD (a deviated well's table datum is a true vertical depth), the notes carry MD and TVD.
//   Points that cannot be evaluated (a lost march, a lift-gas point whose casing gas cannot enter the tubing) are FILLED by monotone
//   extrapolation along the rate axis (interpolation between valid neighbours; above the last valid rate a straight-line extension
//   never falling; below the first valid rate the first value) — or, when a whole row is lost, from the next lower THP row shifted
//   by the THP difference; every filled point is listed in the notes and flagged in the CSV. Monotonicity is checked on every column
//   along THP (strictly rising, a hard expectation: flagged when a computed point breaks it) and on every row along the rate axis:
//   a row is expected to be UNIMODAL (falling on the low-rate branch of the outflow curve, rising after its minimum) — the plan's
//   "monotone along the rate axis" holds right of the tubing-curve minimum only (the falling branch is physical), so the check is
//   "monotone on each side of the row's minimum" and a second minimum is flagged.
//   Run as a Job (§6.4, D9): a step evaluates points for up to SLICE_MS (at least one); Cancel takes effect at the next step.
//
// FORMATS (owner Q4: the plan's default). Always field units.
//   1. The lift-curve table text format (producer / injector). Records end with "/"; "--" starts a comment. Producer:
//        keyword line; record 1 = table number, datum depth (ft TVD), rate type, water-fraction type, gas-fraction type, 'THP',
//        lift-quantity type (' ' = none), 'FIELD', 'BHP'; records 2–6 = the rate, THP, water-fraction, gas-fraction and lift-quantity
//        values; then one record per (THP, water fraction, gas fraction, lift quantity) combination = the four 1-based indices and
//        the BHP at every rate. Injector: keyword line; record 1 = table number, datum depth, rate type, 'THP', 'FIELD', 'BHP';
//        record 2 = rates, record 3 = THPs, then one record per THP = its index and the BHP at every rate.
//      Field units of the format: oil / liquid / water rate STB/d, gas rate Mscf/d, THP and BHP psia, WC fraction, WOR STB/STB,
//      WGR STB/Mscf, GOR and GLR Mscf/STB, OGR STB/Mscf, lift gas Mscf/d, depth ft. The keyword tokens are literal format strings
//      in this file only (KW); parseText() reads the layout back (round trip, wellperf-export).
//   2. CSV long format: one row per point (rate, THP, WFR, GFR, ALQ, BHP, flags), unit headers, field units.
// PVT TABLES (B9). Rs, Bo, μo, co, Z, Bg, μg, Bw, μw, densities against pressure at the reservoir temperature, each row from the
//   fluid engine's one property path (WTS_wp_fluid.table: the same numbers as the traverse); the bubble point is always a row. CSV
//   (field units, or the display unit system through WTS_units when asked), and the black-oil PVT table text format: a live-oil
//   table (Rs Mscf/STB, p psia, Bo rb/STB, μo cp; the undersaturated branch under the bubble-point Rs), a dry-gas table (p, Bg
//   rb/Mscf, μg cp) and a water record (p_ref, Bw, cw 1/psi, μw, viscosibility 1/psi, cw and viscosibility by central differences).
//   A wet gas (D14) exports the separator gas only (the condensate is a constant-volume liquid: no vaporised-oil table).
// D17. The export carries the provisional label of every unverified method it used (the well correlation, the PVT families) in its
//   notes and in the text header; it never changes a method or a default.
//
// Interfaces (field units, §3.0; every result {ok, errors[], warnings[{code, msg, sev}]}; nothing throws for user data):
//   WTS_wp_export
//     .kind(M)                       → 'prod' | 'inj' | null
//     .FLO / .WFR / .GFR / .ALQ      axis-type registries {key: {key, label, unit, kinds[], types[], apply(Mx, v) → null | error}};
//                                    ALQ is open for later lift types (an ESP frequency adds ALQ.<key> with apply())
//     .suggest(M, R?)                → spec: {kind, tableNo, datumMd, flo:{type, values[]}, thp:[psia], wfr:{type, values[]},
//                                      gfr:{type, values[]}, alq:{type, values[]}} around the model / operating point (10 × 5 × 4 × 4 × n)
//     .normalize(M, spec)            → {ok, spec (cleaned, sorted, deduplicated), n (points), datum:{md, tvd}, errors, warnings}
//     .liftJob(M, spec, o?)          → Job for PRiSM_autoInterp.drive (step / done / progress / result / cancel); o {sliceMs, pMax}
//         result() → T = {ok, kind, spec, datum:{md, tvd}, axes:{flo, thp, wfr, gfr, alq}, n, bhp (nested [t][w][g][a][f], psia),
//                         status (same nesting: 'ok' | 'filled'), points:[{t, w, g, a, f, flo, thp, wfr, gfr, alq, bhp, flag, code?}],
//                         filled:[{t, w, g, a, f, how, code}], monotone:{thp:{ok, list[]}, rate:{ok, list[]}}, corr, provisional[],
//                         notes[], evals (E), ms, warnings, errors, cancelled?}
//     .liftTable(M, spec, o?)        → T (the Job run to the end; tests and tools)
//     .fill(T) / .monotone(T)        (pure; exported for tests)
//     .text(T, o?)                   → string (the lift-curve table text format)
//     .parseText(s)                  → {ok, kind, tableNo, datum, types:{flo, wfr, gfr, thp, alq, units, tab}, axes:{flo, thp, wfr, gfr,
//                                      alq}, bhp ([t][w][g][a][f]), errors}
//     .csv(T)                        → string (long format)
//     .slice(T, {w, g, a})           → [{t, thp, pts:[{f, q, bhp, filled}]}]  (one curve per THP; the page's chart)
//     .interp(T, {flo, thp, wfr, gfr, alq}) → BHP psia (multilinear on the axes, clamped) | null
//     .pvtTable(M, o?)               o {pList psia, n, T_F} → P = {ok, type, T, pb, gor, rows:[{p, rs, bo, muo, co, z, bg, bgRB, mug, bw,
//                                      muw, rhoO, rhoG, rhoW, saturated}], provisional[], notes[], warnings, errors}
//     .pvtCsv(P, o?)                 o {metric: true} → string (unit headers; display units through WTS_units when metric)
//     .pvtText(P)                    → string (the black-oil PVT table text format)
//     .parsePvtText(s)               → {ok, oil:[{rs, rows:[{p, bo, muo}]}], gas:[{p, bg, mug}], water:{pref, bw, cw, muw, cmu} | null, errors}
// =============================================================================
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;

    var PATM = 14.696;
    var MAX_VALUES = { flo: 30, thp: 15, wfr: 10, gfr: 10, alq: 10 };
    var MAX_POINTS = 12000;                       // a table larger than this is refused (≈ 3 minutes in the container)
    var SLICE_MS = 20;                            // a Job step evaluates points for up to this long (at least one)
    var PROVISIONAL = 'provisional — not verified against a published example';
    // the literal keyword tokens of the two text formats (format strings only)
    var KW = { prod: 'VFPPROD', inj: 'VFPINJ', oil: 'PVTO', gas: 'PVDG', water: 'PVTW' };

    function _fin(v) { return typeof v === 'number' && isFinite(v); }
    function _n(v) { if (typeof v === 'number') return isFinite(v) ? v : null; if (typeof v === 'string' && v.trim() !== '' && isFinite(+v)) return +v; return null; }
    function _w(code, msg, sev) { return { code: code, msg: String(msg).slice(0, 299), sev: sev === 'info' ? 'info' : 'warn' }; }
    function _clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
    function _get(o, path, d) { var c = o; for (var i = 0; i < path.length; i++) { if (c == null) return d; c = c[path[i]]; } return c === undefined ? d : c; }
    function _fn(path) { var p = path.split('.'), f = p.length > 1 ? (G[p[0]] || {})[p[1]] : G[p[0]]; return typeof f === 'function' && (G.__WP_STUBS || []).indexOf(path) === -1 ? f : null; }
    function _now() { try { return (G.performance && typeof G.performance.now === 'function') ? G.performance.now() : Date.now(); } catch (e) { return Date.now(); } }
    function _f(x, dp) { if (!_fin(x)) return '–'; return (+x.toFixed(dp == null ? 2 : dp)).toString(); }
    function _num(v) { if (!_fin(v)) return '0'; var s = String(+(+v).toPrecision(7)); return s.indexOf('e') !== -1 ? (+v).toExponential(6).replace('e+', 'E+').replace('e-', 'E-') : s; }
    function _type(M) { return _get(M, ['fluid', 'type'], 'oil') || 'oil'; }
    function kind(M) { var t = _type(M); return (t === 'waterinj' || t === 'gasinj') ? 'inj' : (['oil', 'gas', 'condensate', 'water'].indexOf(t) !== -1 ? 'prod' : null); }
    function _isGas(t) { return t === 'gas' || t === 'condensate'; }

    // ── axis-type registries ─────────────────────────────────────────────────
    // FLO: q(Mx, v) → the rate on the fluid engine's rate basis (oil: liquid STB/d; gas: separator gas Mscf/d; water: BWPD) | error text
    var FLO = {
        OIL: { label: 'Oil rate', unit: 'STB/d', kinds: ['prod'], types: ['oil'],
            q: function (Mx, v) { var wc = +Mx.fluid.wc || 0; if (wc >= 1) return 'an oil-rate axis needs a water cut below 100 %'; return v / (1 - wc); } },
        LIQ: { label: 'Liquid rate', unit: 'STB/d', kinds: ['prod'], types: ['oil', 'water'], q: function (Mx, v) { return v; } },
        GAS: { label: 'Gas rate', unit: 'Mscf/d', kinds: ['prod', 'inj'], types: ['oil', 'gas', 'condensate', 'gasinj'],
            q: function (Mx, v) {
                var t = _type(Mx);
                if (t !== 'oil') return v;
                var gor = +Mx.fluid.gor, wc = +Mx.fluid.wc || 0;
                if (!(gor > 0)) return 'a gas-rate axis on an oil well needs a GOR above zero';
                if (wc >= 1) return 'a gas-rate axis needs a water cut below 100 %';
                return v * 1000 / gor / (1 - wc);          // q_o = q_g / GOR, q_L = q_o / (1 − WC)
            } },
        WAT: { label: 'Water rate', unit: 'STB/d', kinds: ['prod', 'inj'], types: ['water', 'waterinj', 'oil'],
            q: function (Mx, v) { var t = _type(Mx); if (t !== 'oil') return v; var wc = +Mx.fluid.wc || 0; if (!(wc > 0)) return 'a water-rate axis on an oil well needs a water cut above zero'; return v / wc; } }
    };
    var WFR = {
        WCT: { label: 'Water cut', unit: 'fraction', types: ['oil', 'water'], apply: function (Mx, v) { if (_type(Mx) === 'water') return null; if (v < 0 || v >= 1) return 'water cut must be 0 ≤ WC < 1'; Mx.fluid.wc = v; return null; } },
        WOR: { label: 'Water-oil ratio', unit: 'STB/STB', types: ['oil'], apply: function (Mx, v) { if (v < 0) return 'WOR must be ≥ 0'; Mx.fluid.wc = v / (1 + v); return null; } },
        WGR: { label: 'Water-gas ratio', unit: 'STB/Mscf', types: ['gas', 'condensate'], apply: function (Mx, v) { if (v < 0) return 'WGR must be ≥ 0'; Mx.fluid.wgr = v * 1000; return null; } }
    };
    var GFR = {
        GOR: { label: 'Gas-oil ratio', unit: 'Mscf/STB', types: ['oil'], apply: function (Mx, v) { if (v < 0) return 'GOR must be ≥ 0'; Mx.fluid.gor = v * 1000; return null; } },
        GLR: { label: 'Gas-liquid ratio', unit: 'Mscf/STB', types: ['oil', 'water'], apply: function (Mx, v) { if (_type(Mx) === 'water') return null; var wc = +Mx.fluid.wc || 0; if (v < 0) return 'GLR must be ≥ 0'; if (wc >= 1) return 'GLR needs a water cut below 100 %'; Mx.fluid.gor = v * 1000 / (1 - wc); return null; } },
        OGR: { label: 'Oil (condensate)-gas ratio', unit: 'STB/Mscf', types: ['gas', 'condensate'], apply: function (Mx, v) { if (v < 0) return 'OGR must be ≥ 0'; Mx.fluid.cgr = v * 1000; return null; } }
    };
    var ALQ = {
        '': { label: 'None', unit: '', types: ['oil', 'gas', 'condensate', 'water'], apply: function () { return null; } },
        GRAT: { label: 'Lift-gas rate', unit: 'Mscf/d', types: ['oil'],
            apply: function (Mx, v) {
                if (v < 0) return 'the lift-gas rate must be ≥ 0';
                Mx.lift = Mx.lift || {}; Mx.lift.gl = Mx.lift.gl || {};
                if (!(+Mx.lift.gl.pinj_psig > 0)) return 'a lift-gas axis needs the gas-lift injection pressure (step ④)';
                Mx.lift.type = 'gaslift'; Mx.lift.gl.qinj_Mscfd = v;
                return null;
            } }
    };
    [FLO, WFR, GFR, ALQ].forEach(function (r) { Object.keys(r).forEach(function (k) { r[k].key = k; }); });

    // ── the well path and its datum ──────────────────────────────────────────
    function _well(M) {
        if (!_fn('WTS_wp_well.build')) return null;
        var W = G.WTS_wp_well.build(M.well, { res: M.res, fluidType: _type(M), tests: M.tests, surface: M.surface });
        return W && W.ok && W.segments && W.segments.length ? W : null;
    }
    function _datum(M, W, md) {
        var mid = W && W.nodes ? W.nodes.midPerfMd : null, d = _fin(_n(md)) ? +md : mid, warn = null;
        if (_fin(mid) && d > mid + 1e-6) { warn = _w('DATUM_DEEP', 'The table datum ' + _f(d, 0) + ' ft MD is below the mid-perforations: the mid-perforations (' + _f(mid, 0) + ' ft MD) are used.'); d = mid; }
        if (!(d >= 0)) d = mid;
        var tvd = W && W.tvdAt ? W.tvdAt(d) : d;
        return { md: d, tvd: _fin(tvd) ? tvd : d, mid: mid, warn: warn };
    }
    // the pressure at a measured depth on a traverse profile ({md, p} rows in MD order)
    function _pAtMd(prof, md) {
        var rows = (prof || []).filter(function (r) { return r && _fin(r.md) && _fin(r.p); });
        if (!rows.length) return null;
        if (md <= rows[0].md) return rows[0].p;
        for (var i = 1; i < rows.length; i++) {
            if (rows[i].md >= md - 1e-9) { var a = rows[i - 1], b = rows[i]; if (b.md - a.md < 1e-9) return b.p; return a.p + (b.p - a.p) * (md - a.md) / (b.md - a.md); }
        }
        return rows[rows.length - 1].p;
    }

    // ── axes: suggestions and cleaning ───────────────────────────────────────
    function _nice(x) { if (!(x > 0)) return 0; var e = Math.pow(10, Math.floor(Math.log(x) / Math.LN10) - 1); return Math.round(x / e) * e; }
    function _span(lo, hi, n) { var out = []; for (var i = 0; i < n; i++) out.push(_nice(lo + (hi - lo) * i / Math.max(1, n - 1))); return out.filter(function (v, i, a) { return a.indexOf(v) === i; }); }
    function suggest(M, R) {
        var k = kind(M), t = _type(M), gas = _isGas(t);
        var op = R && R.ok && R.op ? R.op.q : null, rt = R && R.ok && R.rates ? R.rates : {};
        var thp0 = R && R.ok && R.surface && _fin(R.surface.thp) ? R.surface.thp : (_fin(_n(_get(M, ['system', 'thp_psig']))) ? +M.system.thp_psig + PATM : (+_get(M, ['surface', 'psep_psig'], 100) || 100) + PATM + 100);
        var spec = { kind: k, tableNo: 1, datumMd: null };
        if (k === 'inj') {
            var gi = t === 'gasinj';
            spec.flo = { type: gi ? 'GAS' : 'WAT', values: gi ? _span(500, 20000, 8) : _span(500, 20000, 8) };
            spec.thp = _span(Math.max(PATM + 50, thp0 * 0.5), Math.max(thp0 * 2, 1500), 5);
            return spec;
        }
        var floType = gas ? 'GAS' : (t === 'water' ? 'LIQ' : 'OIL');
        // rates: 3 % … 2 × the operating point (or of a typical rate), ten values
        var qRef = gas ? (_fin(rt.qg) && rt.qg > 0 ? rt.qg : (op || 5000)) : (floType === 'OIL' ? (_fin(rt.qo) && rt.qo > 0 ? rt.qo : (op || 1000) * (1 - (+M.fluid.wc || 0))) : (op || 1000));
        spec.flo = { type: floType, values: _span(qRef * 0.05, qRef * 2, 10) };
        spec.thp = _span(Math.max(PATM + 25, thp0 * 0.5), thp0 * 2, 5);
        if (gas) {
            var wgr = (+M.fluid.wgr || 0) / 1000, ogr = (+M.fluid.cgr || 0) / 1000;
            spec.wfr = { type: 'WGR', values: _uniq([0, wgr, Math.max(wgr * 2, 0.005), Math.max(wgr * 5, 0.02)]) };
            spec.gfr = { type: 'OGR', values: _uniq([0, ogr, Math.max(ogr * 2, 0.01), Math.max(ogr * 4, 0.04)]) };
        } else if (t === 'water') {
            spec.wfr = { type: 'WCT', values: [0] };          // a water producer: the fraction axes are single placeholders
            spec.gfr = { type: 'GLR', values: [0] };
        } else {
            var wc = +M.fluid.wc || 0, gor = (+M.fluid.gor || 0) / 1000;
            spec.wfr = { type: 'WCT', values: _uniq([0, wc, Math.min(0.95, Math.max(wc + 0.3, 0.5)), 0.9].map(function (x) { return +x.toFixed(4); })) };
            spec.gfr = { type: 'GOR', values: _uniq([gor * 0.5, gor, gor * 2, gor * 4].map(function (x) { return +x.toFixed(4); })) };
        }
        var lift = _get(M, ['lift', 'type'], 'none'), qi = _n(_get(M, ['lift', 'gl', 'qinj_Mscfd']));
        if (!gas && lift === 'gaslift' && +_get(M, ['lift', 'gl', 'pinj_psig'], 0) > 0) spec.alq = { type: 'GRAT', values: _uniq([0, (qi > 0 ? qi : 500) * 0.5, qi > 0 ? qi : 500, (qi > 0 ? qi : 500) * 2].map(_nice)) };
        else spec.alq = { type: '', values: [0] };
        return spec;
    }
    function _uniq(a) { var o = []; a.forEach(function (v) { if (_fin(v) && o.indexOf(v) === -1) o.push(v); }); return o.sort(function (x, y) { return x - y; }); }
    function _vals(raw, name, errors, max, lo) {
        var out = [];
        (Array.isArray(raw) ? raw : []).forEach(function (r) {
            var v = _n(r);
            if (!_fin(v)) { errors.push(name + ': "' + String(r).slice(0, 20) + '" is not a number'); return; }
            if (lo != null && v < lo) { errors.push(name + ': ' + _f(v, 4) + ' is below ' + lo); return; }
            if (out.indexOf(v) === -1) out.push(v);
        });
        out.sort(function (a, b) { return a - b; });
        if (!out.length) errors.push(name + ': at least one value is needed');
        if (out.length > max) errors.push(name + ': at most ' + max + ' values (' + out.length + ' given)');
        return out;
    }
    function normalize(M, spec) {
        var errors = [], warnings = [], k = kind(M), t = _type(M);
        if (!M || !M.fluid || !M.well) return { ok: false, errors: ['the model is incomplete'], warnings: [], n: 0 };
        if (!k) return { ok: false, errors: ['no lift table for a ' + t + ' well'], warnings: [], n: 0 };
        spec = spec || {};
        var s = { kind: k, tableNo: Math.max(1, Math.min(9999, Math.round(_n(spec.tableNo) || 1))), datumMd: _n(spec.datumMd) };
        var ft = spec.flo && spec.flo.type ? String(spec.flo.type).toUpperCase() : null, F0 = FLO[ft];
        if (!F0) errors.push('unknown rate type ' + String(ft).slice(0, 12));
        else if (F0.kinds.indexOf(k) === -1 || F0.types.indexOf(t) === -1) errors.push(F0.label + ' is not a rate axis for a ' + t + ' well');
        s.flo = { type: ft, values: _vals(spec.flo && spec.flo.values, 'rates', errors, MAX_VALUES.flo, 0) };
        if (s.flo.values.length && s.flo.values[0] <= 0) { s.flo.values = s.flo.values.filter(function (v) { return v > 0; }); warnings.push(_w('RATE_ZERO', 'A zero rate is not a table point: dropped.', 'info')); if (!s.flo.values.length) errors.push('rates: at least one rate above zero'); }
        s.thp = _vals(spec.thp, 'THP', errors, MAX_VALUES.thp, PATM);
        if (k === 'prod') {
            var wt = spec.wfr && spec.wfr.type ? String(spec.wfr.type).toUpperCase() : null, gt = spec.gfr && spec.gfr.type ? String(spec.gfr.type).toUpperCase() : null;
            var at = spec.alq && spec.alq.type != null ? String(spec.alq.type).toUpperCase().trim() : '';
            if (!WFR[wt]) errors.push('unknown water-fraction type ' + String(wt).slice(0, 12)); else if (WFR[wt].types.indexOf(t) === -1) errors.push(WFR[wt].label + ' is not a water-fraction axis for a ' + t + ' well');
            if (!GFR[gt]) errors.push('unknown gas-fraction type ' + String(gt).slice(0, 12)); else if (GFR[gt].types.indexOf(t) === -1) errors.push(GFR[gt].label + ' is not a gas-fraction axis for a ' + t + ' well');
            if (!ALQ[at]) errors.push('unknown lift-quantity type ' + String(at).slice(0, 12)); else if (ALQ[at].types.indexOf(t) === -1) errors.push(ALQ[at].label + ' is not a lift axis for a ' + t + ' well');
            s.wfr = { type: wt, values: _vals(spec.wfr && spec.wfr.values, 'water fraction', errors, MAX_VALUES.wfr, 0) };
            s.gfr = { type: gt, values: _vals(spec.gfr && spec.gfr.values, 'gas fraction', errors, MAX_VALUES.gfr, 0) };
            s.alq = { type: at, values: at === '' ? [0] : _vals(spec.alq && spec.alq.values, 'lift quantity', errors, MAX_VALUES.alq, 0) };
            if (wt === 'WCT' && s.wfr.values.some(function (v) { return v >= 1; })) errors.push('water cut values must be below 1 (a fraction)');
            if (at === 'GRAT' && !(+_get(M, ['lift', 'gl', 'pinj_psig'], 0) > 0)) errors.push('a lift-gas axis needs gas lift with an injection pressure (step ④)');
            if (at === '' && _get(M, ['lift', 'type']) === 'gaslift' && +_get(M, ['lift', 'gl', 'qinj_Mscfd'], 0) > 0) warnings.push(_w('ALQ_MODEL_LIFT', 'No lift axis: every point carries the model\'s lift-gas rate (' + _f(+M.lift.gl.qinj_Mscfd, 0) + ' Mscf/d).', 'info'));
        } else { s.wfr = { type: null, values: [0] }; s.gfr = { type: null, values: [0] }; s.alq = { type: null, values: [0] }; }
        var n = s.flo.values.length * s.thp.length * s.wfr.values.length * s.gfr.values.length * s.alq.values.length;
        if (n > MAX_POINTS) errors.push('at most ' + MAX_POINTS + ' points (' + n + ' asked)');
        var W = _well(M);
        if (!W) errors.push('the well has no flow path (survey and strings, step ③)');
        var d = W ? _datum(M, W, s.datumMd) : null;
        if (d && d.warn) warnings.push(d.warn);
        if (d) s.datumMd = d.md;
        return { ok: !errors.length, spec: s, n: n, datum: d ? { md: d.md, tvd: d.tvd } : null, errors: errors, warnings: warnings };
    }

    // ── one axis combination: the model of a point ───────────────────────────
    function pointModel(M, s, w, g, a) {
        var Mx = _clone(M);
        Mx.surface = Mx.surface || {}; Mx.surface.choke = Object.assign({}, Mx.surface.choke || {}, { present: false });
        Mx.system = Mx.system || {}; Mx.system.mode = 'rate'; Mx.system.node = 'bottom';
        if (s.kind === 'prod') {
            if (s.alq.type === 'GRAT' || (s.alq.type === '' && _get(Mx, ['lift', 'type']) !== 'gaslift')) { Mx.lift = Mx.lift || {}; if (s.alq.type === '') Mx.lift.type = 'none'; }
            // the water fraction first (GLR and the oil / gas rate bases read the water cut)
            var e = WFR[s.wfr.type].apply(Mx, s.wfr.values[w]) || GFR[s.gfr.type].apply(Mx, s.gfr.values[g]) || ALQ[s.alq.type].apply(Mx, s.alq.values[a]);
            if (e) return { error: e };
        }
        return { M: Mx };
    }

    // ── the injector traverse: the one marcher, down the well with the flow ──
    function _injPoint(F, W, q, thpA, o, datumMd) {
        var segs = W.segments.slice().reverse();                  // wellhead first (the producing path reversed)
        var xs = [], x = 0;
        segs.forEach(function (sg) { xs.push({ x0: x, x1: x + sg.len, md0: sg.md1, md1: sg.md0 }); x += sg.len; });
        var mdOf = function (xx) { for (var i = 0; i < xs.length; i++) { var r = xs[i]; if (xx <= r.x1 + 1e-9 || i === xs.length - 1) { var fr = r.x1 > r.x0 ? Math.min(1, Math.max(0, (xx - r.x0) / (r.x1 - r.x0))) : 0; return r.md0 + (r.md1 - r.md0) * fr; } } return 0; };
        var L = 0, Sr = 0; segs.forEach(function (sg) { if (sg.rough > 0) { L += sg.len; Sr += sg.len * sg.rough; } });
        var mo = { corr: o.corr, reverse: false, tAt: function (xx) { return W.tAt(mdOf(xx)); }, stepFt: o.stepFt || 100, detail: false, rough: L > 0 ? Sr / L : 0.0006,
            accel: true, payne: true, refine: true, pMax: o.pMax || 30000 };
        var ff = G.WTS_wp_fluid.flowlineFluid(F, q);
        var m = G.WTS_flowline_march(segs.map(function (sg) { var c = { name: sg.name, len: sg.len, id: sg.id, dz: -sg.dz }; if (sg.area) c.area = sg.area; if (sg.restr) c.restr = sg.restr; return c; }), ff, thpA - PATM, NaN, NaN, mo);
        if (!m || m.ok === false) return { ok: false, code: (m && m.code) || 'MARCH_FAILED' };
        if (m.lost) return { ok: false, code: 'LOST', reason: m.lost.reason };
        var prof = (m.profile || []).map(function (e) { return { md: mdOf(e.x), p: e.p + PATM }; });
        return { ok: true, bhp: _pAtMd(prof, datumMd), pEnd: m.pOut + PATM };
    }

    // ── the Job ──────────────────────────────────────────────────────────────
    function _nest(s, v) {
        var out = [];
        for (var t = 0; t < s.thp.length; t++) { var A = []; for (var w = 0; w < s.wfr.values.length; w++) { var B = []; for (var g = 0; g < s.gfr.values.length; g++) { var C = []; for (var a = 0; a < s.alq.values.length; a++) { var D = []; for (var f = 0; f < s.flo.values.length; f++) D.push(v); C.push(D); } B.push(C); } A.push(B); } out.push(A); }
        return out;
    }
    function _failJob(code, errors, warnings) {
        var res = { ok: false, code: code, points: [], errors: errors, warnings: warnings || [] };
        return { step: function () { return { done: true, progress: 1, label: '' }; }, done: function () { return true; }, progress: function () { return 1; },
            result: function () { return res; }, cancel: function () { }, errors: errors, code: code };
    }
    function liftJob(M, spec, o) {
        o = o || {};
        var nz = normalize(M, spec);
        if (!nz.ok) return _failJob('BAD_SPEC', nz.errors, nz.warnings);
        var s = nz.spec, k = s.kind, t0 = _now(), slice = _fin(o.sliceMs) && o.sliceMs >= 0 ? o.sliceMs : SLICE_MS;
        if (k === 'prod' && !_fn('WTS_wp_system.evalAt')) return _failJob('MISSING_ENGINE', ['WTS_wp_system.evalAt is not available']);
        if (k === 'inj' && (!_fn('WTS_wp_fluid.build') || typeof G.WTS_flowline_march !== 'function')) return _failJob('MISSING_ENGINE', ['the fluid engine or the marcher is not available']);
        var nF = s.flo.values.length, nT = s.thp.length, nW = s.wfr.values.length, nG = s.gfr.values.length, nA = s.alq.values.length;
        var bhp = _nest(s, null), status = _nest(s, null), codes = _nest(s, null);
        var st = { i: 0, done: false, cancelled: false, res: null, evals: 0, combos: {}, warnings: nz.warnings.slice(), corr: null, provisional: [], trWarn: {} };
        // the evaluation order: per row (water fraction, gas fraction, lift, THP) the middle rate first — it records the frozen step
        // layout of that row, so BHP is a smooth function of the rate along every row (as the solver's p_out(q) on its frozen grid) —
        // then the other rates of the row
        var order = [], fm = Math.floor((nF - 1) / 2);
        for (var w = 0; w < nW; w++) for (var g = 0; g < nG; g++) for (var a = 0; a < nA; a++) for (var tt = 0; tt < nT; tt++) {
            order.push([tt, w, g, a, fm]);
            for (var ff = 0; ff < nF; ff++) if (ff !== fm) order.push([tt, w, g, a, ff]);
        }
        var W = _well(M), datum = _datum(M, W, s.datumMd);
        var injCtx = null;
        if (k === 'inj') {
            var Fi = G.WTS_wp_fluid.build(M.fluid, { T_F: _get(M, ['res', 'T_F']), table: true });
            if (!Fi || !Fi.ok) return _failJob('NEEDS_FLUID', (Fi && Fi.errors && Fi.errors.length) ? Fi.errors : ['the fluid is incomplete']);
            var REG = G.WTS_flowline_corr || {}, ck = _get(M, ['system', 'corr', 'well']) || (G.WTS_wp_vlp && G.WTS_wp_vlp.defaultCorr ? G.WTS_wp_vlp.defaultCorr(Fi).key : 'bb');
            if (!REG[ck]) return _failJob('UNKNOWN_CORR', ['unknown correlation key ' + String(ck).slice(0, 40)]);
            injCtx = { F: Fi, corr: ck, stepFt: +_get(M, ['system', 'stepFt'], 100) || 100 };
            st.corr = ck;
            if (REG[ck].verified !== true) st.provisional.push((REG[ck].label || ck) + ': ' + PROVISIONAL);
            (Fi.provisional || []).forEach(function (l) { st.provisional.push(l + ': ' + PROVISIONAL); });
            st.warnings.push(_w('INJ_TEMP', 'Injector table: the temperature is the well\'s linear THT → BHT profile (no injection-temperature model in this release).', 'info'));
        }
        function evalPoint(ix) {
            var t = ix[0], w2 = ix[1], g2 = ix[2], a2 = ix[3], f = ix[4], key = w2 + ',' + g2 + ',' + a2;
            var thpA = s.thp[t], flo = s.flo.values[f];
            if (k === 'inj') {
                var qi = FLO[s.flo.type].q({ fluid: M.fluid }, flo);
                var r = _injPoint(injCtx.F, W, qi, thpA, { corr: injCtx.corr, stepFt: injCtx.stepFt, pMax: o.pMax }, datum.md);
                st.evals += 1;
                if (r.ok && _fin(r.bhp)) { bhp[t][w2][g2][a2][f] = r.bhp; status[t][w2][g2][a2][f] = 'ok'; }
                else { status[t][w2][g2][a2][f] = 'lost'; codes[t][w2][g2][a2][f] = r.code || 'LOST'; }
                return;
            }
            var cb = st.combos[key];
            if (!cb) {
                var pm = pointModel(M, s, w2, g2, a2);
                cb = st.combos[key] = { M: pm.M || null, error: pm.error || null, ctx: null, grids: {} };
                if (pm.M) {
                    cb.M.system.thp_psig = s.thp[t] - PATM;
                    // one solver context per (water fraction, gas fraction, lift) combination: one fluid build and property table;
                    // each THP row freezes its own step layout at its middle-rate point (below)
                    var cx = G.WTS_wp_system.context ? G.WTS_wp_system.context(cb.M, { outflowOnly: true, pMax: o.pMax || 30000 }) : null;
                    if (cx && cx.ok) cb.ctx = cx;
                    else if (cx && cx.ok === false) { cb.error = (cx.errors && cx.errors[0]) || cx.code || 'failed'; cb.code = cx.code; if (!st.trWarn[cx.code]) { st.trWarn[cx.code] = 1; st.warnings.push(_w(cx.code || 'FAILED', cb.error)); } }
                }
            }
            if (cb.error) { status[t][w2][g2][a2][f] = 'lost'; codes[t][w2][g2][a2][f] = cb.code || 'BAD_AXIS'; return; }
            var q = FLO[s.flo.type].q(cb.M, flo);
            if (typeof q === 'string' || !(q > 0)) { status[t][w2][g2][a2][f] = 'lost'; codes[t][w2][g2][a2][f] = 'BAD_RATE'; if (typeof q === 'string' && !st.trWarn.rate) { st.trWarn.rate = 1; st.warnings.push(_w('BAD_RATE', q)); } return; }
            cb.M.system.thp_psig = thpA - PATM;
            var opt = { outflowOnly: true, pMax: o.pMax || 30000 };
            if (cb.ctx) { opt.ctx = cb.ctx; opt.thp_psig = thpA - PATM; opt.grid = cb.grids[t] || { fine: null, coarse: null, line: null }; }
            var e = G.WTS_wp_system.evalAt(cb.M, q, opt);
            if (cb.ctx && !cb.grids[t] && e && e.grid && e.grid.fine) cb.grids[t] = { fine: e.grid.fine, coarse: e.grid.coarse, line: e.grid.line };
            st.evals += e && e.counts ? (e.counts.fine || 0) + 0.5 * (e.counts.coarse || 0) : 1;
            if (!e || e.ok === false && !e.tr) {
                status[t][w2][g2][a2][f] = 'lost'; codes[t][w2][g2][a2][f] = (e && (e.code || (e.lost && e.lost.reason))) || 'FAILED';
                if (e && e.code && e.code !== 'LOST' && !st.trWarn[e.code]) { st.trWarn[e.code] = 1; st.warnings.push(_w(e.code, (e.errors && e.errors[0]) || e.code)); }
                return;
            }
            if (!e.ok || !e.tr || !e.tr.ok) { status[t][w2][g2][a2][f] = 'lost'; codes[t][w2][g2][a2][f] = (e.lost && e.lost.reason) || (e.tr && e.tr.code) || 'LOST'; return; }
            if (!st.corr) {
                st.corr = e.tr.corr || null;
                (e.tr.warnings || []).forEach(function (wn) { if (wn.code === 'PROVISIONAL' && st.provisional.indexOf(wn.msg) === -1) st.provisional.push(wn.msg.replace(/\.$/, '')); });
            }
            var p = Math.abs(datum.md - datum.mid) < 1e-6 ? e.pOut : _pAtMd(e.tr.profile, datum.md);
            if (!_fin(p)) { status[t][w2][g2][a2][f] = 'lost'; codes[t][w2][g2][a2][f] = 'NO_DATUM'; return; }
            bhp[t][w2][g2][a2][f] = p; status[t][w2][g2][a2][f] = 'ok';
        }
        function finish() {
            if (st.res) return st.res;
            if (st.cancelled) { st.res = { ok: false, code: 'CANCELLED', cancelled: true, points: [], errors: ['cancelled'], warnings: [] }; return st.res; }
            var T = { ok: true, kind: k, spec: s, datum: { md: datum.md, tvd: datum.tvd }, axes: { flo: s.flo.values.slice(), thp: s.thp.slice(), wfr: s.wfr.values.slice(), gfr: s.gfr.values.slice(), alq: s.alq.values.slice() },
                n: nz.n, bhp: bhp, status: status, codes: codes, points: [], filled: [], monotone: null, corr: st.corr, provisional: st.provisional.slice(), notes: [],
                fluidType: _type(M), evals: st.evals, ms: _now() - t0, warnings: st.warnings, errors: [] };
            fill(T);
            if (T.ok === false) return (st.res = T);
            T.monotone = monotone(T);
            _points(T);
            _notes(T, M);
            st.res = T;
            return T;
        }
        return {
            step: function () {
                if (st.done) return { done: true, progress: 1, label: '' };
                if (st.cancelled) { st.done = true; return { done: true, progress: 1, label: 'cancelled' }; }
                var ts = _now();
                do { evalPoint(order[st.i]); st.i++; } while (st.i < order.length && _now() - ts < slice);
                if (st.i >= order.length) { st.done = true; finish(); }
                return { done: st.done, progress: st.done ? 1 : Math.min(0.99, st.i / order.length), label: 'point ' + Math.min(st.i, order.length) + ' of ' + order.length };
            },
            done: function () { return st.done; },
            progress: function () { return st.done ? 1 : st.i / order.length; },
            result: function () { return finish(); },
            cancel: function () { st.cancelled = true; },
            n: order.length
        };
    }
    function liftTable(M, spec, o) {
        var j = liftJob(M, spec, Object.assign({ sliceMs: 1e9 }, o || {})), s, n = 0;
        do { s = j.step(); n++; } while (!s.done && n < 1e6);
        return j.result();
    }

    // ── fill and monotonicity ────────────────────────────────────────────────
    function _each(T, fn) {
        var b = T.bhp;
        for (var t = 0; t < b.length; t++) for (var w = 0; w < b[t].length; w++) for (var g = 0; g < b[t][w].length; g++) for (var a = 0; a < b[t][w][g].length; a++) fn(t, w, g, a, b[t][w][g][a], T.status[t][w][g][a]);
    }
    function fill(T) {
        var q = T.axes.flo, thp = T.axes.thp, filled = T.filled = T.filled || [], inj = T.kind === 'inj' || (T.spec && T.spec.kind === 'inj');
        var rowsLost = [];
        _each(T, function (t, w, g, a, row, sr) {
            var v = []; for (var f = 0; f < row.length; f++) if (sr[f] === 'ok' && _fin(row[f])) v.push(f);
            if (!v.length) { rowsLost.push([t, w, g, a]); return; }
            for (var i = 0; i < row.length; i++) {
                if (sr[i] === 'ok' && _fin(row[i])) continue;
                var lo = null, hi = null;
                for (var j = 0; j < v.length; j++) { if (v[j] < i) lo = v[j]; if (v[j] > i && hi == null) hi = v[j]; }
                var val, how;
                if (lo != null && hi != null) { val = row[lo] + (row[hi] - row[lo]) * (q[i] - q[lo]) / (q[hi] - q[lo]); how = 'interpolated'; }
                else if (lo != null) {
                    var lo2 = null; for (var j2 = v.length - 1; j2 >= 0; j2--) if (v[j2] < lo) { lo2 = v[j2]; break; }
                    var sl = lo2 != null ? (row[lo] - row[lo2]) / (q[lo] - q[lo2]) : 0;
                    // a producer's BHP never falls above the last valid rate; an injector's never rises (friction is lost), ≥ 1 atm
                    val = inj ? Math.max(PATM, row[lo] + Math.min(0, sl) * (q[i] - q[lo])) : row[lo] + Math.max(0, sl) * (q[i] - q[lo]); how = 'extrapolated';
                } else { val = row[hi]; how = 'held'; }
                row[i] = val; sr[i] = 'filled';
                filled.push({ t: t, w: w, g: g, a: a, f: i, how: how, code: (T.codes && T.codes[t][w][g][a][i]) || 'LOST' });
            }
        });
        // a whole row lost: the next lower (else higher) THP row with the same (w, g, a), shifted by the THP difference
        var pending = rowsLost.slice(), guard = 0;
        while (pending.length && guard++ < 100) {
            var next = [];
            pending.forEach(function (k) {
                var t = k[0], w = k[1], g = k[2], a = k[3], src = null;
                for (var d = 1; d < thp.length && src == null; d++) {
                    [t - d, t + d].forEach(function (tt) { if (src == null && tt >= 0 && tt < thp.length && T.status[tt][w][g][a].every(function (x) { return x === 'ok' || x === 'filled'; })) src = tt; });
                }
                if (src == null) { next.push(k); return; }
                var row = T.bhp[t][w][g][a], sr = T.status[t][w][g][a];
                for (var f = 0; f < row.length; f++) { row[f] = T.bhp[src][w][g][a][f] + (thp[t] - thp[src]); sr[f] = 'filled'; filled.push({ t: t, w: w, g: g, a: a, f: f, how: 'from THP row ' + (src + 1), code: (T.codes && T.codes[t][w][g][a][f]) || 'LOST' }); }
            });
            if (next.length === pending.length) { pending = next; break; }
            pending = next;
        }
        if (pending.length) { T.ok = false; T.code = 'NO_POINTS'; T.errors = ['No point of ' + pending.length + ' (water fraction, gas fraction, lift) combination(s) could be evaluated at any THP.']; }
        // keep the filled values monotone along THP (a filled point never below the computed or filled point of the lower THP)
        if (T.ok !== false) {
            for (var w2 = 0; w2 < T.axes.wfr.length; w2++) for (var g2 = 0; g2 < T.axes.gfr.length; g2++) for (var a2 = 0; a2 < T.axes.alq.length; a2++) for (var f2 = 0; f2 < q.length; f2++) {
                for (var t2 = 1; t2 < thp.length; t2++) {
                    if (T.status[t2][w2][g2][a2][f2] !== 'filled') continue;
                    var below = T.bhp[t2 - 1][w2][g2][a2][f2], min = below + 0.01 * (thp[t2] - thp[t2 - 1]);
                    if (T.bhp[t2][w2][g2][a2][f2] < min) T.bhp[t2][w2][g2][a2][f2] = min;
                }
            }
        }
        return T;
    }
    function monotone(T) {
        var thpL = [], rateL = [], q = T.axes.flo, nT = T.axes.thp.length;
        for (var w = 0; w < T.axes.wfr.length; w++) for (var g = 0; g < T.axes.gfr.length; g++) for (var a = 0; a < T.axes.alq.length; a++) {
            for (var f = 0; f < q.length; f++) for (var t = 1; t < nT; t++) {
                if (!(T.bhp[t][w][g][a][f] > T.bhp[t - 1][w][g][a][f])) thpL.push({ t: t, w: w, g: g, a: a, f: f, d: T.bhp[t][w][g][a][f] - T.bhp[t - 1][w][g][a][f] });
            }
            for (var t2 = 0; t2 < nT; t2++) {
                var row = T.bhp[t2][w][g][a], im = 0, tol = 0.01;
                for (var i = 1; i < row.length; i++) if (row[i] < row[im]) im = i;
                for (var j = 1; j <= im; j++) if (row[j] > row[j - 1] + tol) { rateL.push({ t: t2, w: w, g: g, a: a, f: j, side: 'falling branch rises' }); break; }
                for (var j2 = im + 1; j2 < row.length; j2++) if (row[j2] < row[j2 - 1] - tol) { rateL.push({ t: t2, w: w, g: g, a: a, f: j2, side: 'rising branch falls' }); break; }
            }
        }
        return { thp: { ok: !thpL.length, list: thpL.slice(0, 50), n: thpL.length }, rate: { ok: !rateL.length, list: rateL.slice(0, 50), n: rateL.length } };
    }
    function _points(T) {
        var A = T.axes, out = [];
        _each(T, function (t, w, g, a, row, sr) {
            for (var f = 0; f < row.length; f++) out.push({ t: t, w: w, g: g, a: a, f: f, flo: A.flo[f], thp: A.thp[t], wfr: A.wfr[w], gfr: A.gfr[g], alq: A.alq[a], bhp: row[f], flag: sr[f] === 'ok' ? 'ok' : 'filled', code: sr[f] === 'ok' ? null : (T.codes[t][w][g][a][f] || 'LOST') });
        });
        T.points = out;
    }
    function _notes(T, M) {
        var s = T.spec, n = [];
        n.push('Datum ' + _f(T.datum.md, 0) + ' ft MD = ' + _f(T.datum.tvd, 0) + ' ft TVD (the record carries the TVD).');
        if (s.kind === 'prod') n.push('BHP from a top-down traverse at each THP (choke, flowline and separator not included); well correlation ' + _corrLabel(T.corr) + (_get(M, ['system', 'mult']) && (+M.system.mult.hl !== 1 || +M.system.mult.f !== 1) ? ', tuned multipliers m_h ' + _f(+M.system.mult.hl, 3) + ' / m_f ' + _f(+M.system.mult.f, 3) : '') + ', temperature ' + (_get(M, ['well', 'heat', 'mode']) === 'relax' ? 'relaxation model (provisional)' : 'linear THT → BHT') + '.');
        else n.push('Injector: BHP marched down the well with the flow (hydrostatic gained, friction lost); correlation ' + _corrLabel(T.corr) + '.');
        T.provisional.forEach(function (p) { n.push('Provisional: ' + p + '.'); });
        if (T.filled.length) n.push(T.filled.length + ' of ' + T.n + ' points filled (' + _filledSummary(T) + ').');
        if (!T.monotone.thp.ok) n.push('⚠ BHP does not rise with THP at ' + T.monotone.thp.n + ' point(s).');
        if (!T.monotone.rate.ok) n.push('⚠ ' + T.monotone.rate.n + ' row(s) are not single-minimum along the rate axis (flow-pattern changes of the correlation; see the chart).');
        T.notes = n;
    }
    function _corrLabel(k) { var e = k && G.WTS_flowline_corr ? G.WTS_flowline_corr[k] : null; return e && e.label ? e.label : (k || '—'); }
    function _filledSummary(T) {
        var c = {}; T.filled.forEach(function (x) { c[x.how] = (c[x.how] || 0) + 1; });
        return Object.keys(c).map(function (k) { return c[k] + ' ' + k; }).join(', ');
    }

    // ── text format (writer and reader) ──────────────────────────────────────
    function _wrap(vals, per, indent) {
        var lines = [], ln = [];
        vals.forEach(function (v) { ln.push(v); if (ln.length >= per) { lines.push(indent + ln.join('  ')); ln = []; } });
        if (ln.length) lines.push(indent + ln.join('  '));
        if (!lines.length) lines.push(indent);
        lines[lines.length - 1] += ' /';
        return lines.join('\n');
    }
    function _q(s) { return "'" + String(s == null ? '' : s) + "'"; }
    function text(T, o) {
        o = o || {};
        if (!T || !T.ok) return '';
        var s = T.spec, A = T.axes, L = [], prod = s.kind === 'prod';
        L.push('-- Lift-curve table (' + (prod ? 'producer' : 'injector') + '), Well Performance page' + (o.well ? ', well ' + String(o.well).replace(/[\r\n]/g, ' ').slice(0, 60) : '') + (o.date ? ', ' + String(o.date).slice(0, 20) : ''));
        L.push('-- Field units: oil / liquid / water rate STB/d, gas rate Mscf/d, THP and BHP psia, WC fraction, WOR STB/STB, WGR STB/Mscf,');
        L.push('--   GOR and GLR Mscf/STB, OGR STB/Mscf, lift gas Mscf/d, datum ft TVD.');
        T.notes.forEach(function (n) { L.push('-- ' + n.replace(/[\r\n]/g, ' ')); });
        if (T.filled.length) {
            var lst = T.filled.slice(0, 40).map(function (x) { return prod ? '(' + [x.t + 1, x.w + 1, x.g + 1, x.a + 1, x.f + 1].join(',') + ' ' + x.how + ')' : '(' + [x.t + 1, x.f + 1].join(',') + ' ' + x.how + ')'; });
            L.push('-- Filled points (THP, WFR, GFR, ALQ, rate indices): ' + lst.join(' ') + (T.filled.length > 40 ? ' …' : ''));
        }
        L.push('');
        L.push(prod ? KW.prod : KW.inj);
        if (prod) {
            L.push('-- table  datum  rate  WFR  GFR  THP  ALQ  units  value');
            L.push('  ' + [String(s.tableNo), _num(T.datum.tvd), _q(s.flo.type), _q(s.wfr.type), _q(s.gfr.type), _q('THP'), _q(s.alq.type === '' ? ' ' : s.alq.type), _q('FIELD'), _q('BHP')].join('  ') + ' /');
            L.push('-- rate values (' + FLO[s.flo.type].unit + ')'); L.push(_wrap(A.flo.map(_num), 8, '  '));
            L.push('-- THP values (psia)'); L.push(_wrap(A.thp.map(_num), 8, '  '));
            L.push('-- water-fraction values (' + WFR[s.wfr.type].unit + ')'); L.push(_wrap(A.wfr.map(_num), 8, '  '));
            L.push('-- gas-fraction values (' + GFR[s.gfr.type].unit + ')'); L.push(_wrap(A.gfr.map(_num), 8, '  '));
            L.push('-- lift-quantity values' + (s.alq.type ? ' (' + ALQ[s.alq.type].unit + ')' : ' (none)')); L.push(_wrap(A.alq.map(_num), 8, '  '));
            L.push('-- THP  WFR  GFR  ALQ indices, then BHP (psia) at every rate');
            for (var t = 0; t < A.thp.length; t++) for (var w = 0; w < A.wfr.length; w++) for (var g = 0; g < A.gfr.length; g++) for (var a = 0; a < A.alq.length; a++) {
                L.push('  ' + [t + 1, w + 1, g + 1, a + 1].join(' ') + '\n' + _wrap(T.bhp[t][w][g][a].map(function (v) { return v.toFixed(2); }), 8, '    '));
            }
        } else {
            L.push('-- table  datum  rate  THP  units  value');
            L.push('  ' + [String(s.tableNo), _num(T.datum.tvd), _q(s.flo.type), _q('THP'), _q('FIELD'), _q('BHP')].join('  ') + ' /');
            L.push('-- rate values (' + FLO[s.flo.type].unit + ')'); L.push(_wrap(A.flo.map(_num), 8, '  '));
            L.push('-- THP values (psia)'); L.push(_wrap(A.thp.map(_num), 8, '  '));
            L.push('-- THP index, then BHP (psia) at every rate');
            for (var t2 = 0; t2 < A.thp.length; t2++) L.push('  ' + (t2 + 1) + '\n' + _wrap(T.bhp[t2][0][0][0].map(function (v) { return v.toFixed(2); }), 8, '    '));
        }
        L.push('');
        return L.join('\n');
    }
    // tokens with '/' as a record end; quotes kept together; "--" comments removed; "n*v" repeats expanded
    function _tokens(str) {
        var out = [], lines = String(str == null ? '' : str).replace(/\r\n?/g, '\n').split('\n');
        lines.forEach(function (ln) {
            var c = ln.indexOf('--'), i = 0;
            // a "--" inside quotes is not a comment
            var inQ = false; for (var k = 0; k < ln.length - 1; k++) { if (ln[k] === "'") inQ = !inQ; if (!inQ && ln[k] === '-' && ln[k + 1] === '-') { c = k; break; } }
            if (c !== -1 && !inQ) ln = ln.slice(0, c);
            while (i < ln.length) {
                var ch = ln[i];
                if (/\s/.test(ch)) { i++; continue; }
                if (ch === '/') { out.push({ end: true }); i++; continue; }
                if (ch === "'") { var j = ln.indexOf("'", i + 1); if (j === -1) j = ln.length; out.push({ s: ln.slice(i + 1, j) }); i = j + 1; continue; }
                var m = /^[^\s\/']+/.exec(ln.slice(i));
                var tk = m[0]; i += tk.length;
                var rep = /^(\d+)\*(.*)$/.exec(tk);
                if (rep) { for (var r = 0; r < +rep[1]; r++) out.push({ s: rep[2] }); } else out.push({ s: tk });
            }
        });
        return out;
    }
    function _records(tokens, from) {
        var recs = [], cur = [];
        for (var i = from; i < tokens.length; i++) { if (tokens[i].end) { recs.push(cur); cur = []; } else cur.push(tokens[i].s); }
        if (cur.length) recs.push(cur);
        return recs;
    }
    function _nums(rec, name, errors) { var o = rec.map(function (x) { return +x; }); if (o.some(function (v) { return !_fin(v); })) errors.push(name + ': not a number'); return o; }
    function parseText(str) {
        var errors = [], tk = _tokens(str), kw = -1, kd = null;
        for (var i = 0; i < tk.length; i++) { if (!tk[i].end && (tk[i].s === KW.prod || tk[i].s === KW.inj)) { kw = i; kd = tk[i].s === KW.prod ? 'prod' : 'inj'; break; } }
        if (kw === -1) return { ok: false, errors: ['no lift-curve table keyword found'] };
        var recs = _records(tk, kw + 1), r1 = recs[0] || [];
        var out = { ok: false, kind: kd, errors: errors };
        if (kd === 'prod') {
            if (r1.length < 9) { errors.push('record 1 has ' + r1.length + ' items (9 expected)'); return out; }
            out.tableNo = +r1[0]; out.datum = +r1[1];
            out.types = { flo: r1[2], wfr: r1[3], gfr: r1[4], thp: r1[5], alq: r1[6].trim(), units: r1[7], tab: r1[8] };
            if (recs.length < 6) { errors.push('the axis records are incomplete'); return out; }
            out.axes = { flo: _nums(recs[1], 'rates', errors), thp: _nums(recs[2], 'THP', errors), wfr: _nums(recs[3], 'water fraction', errors), gfr: _nums(recs[4], 'gas fraction', errors), alq: _nums(recs[5], 'lift quantity', errors) };
            var A = out.axes, nRec = A.thp.length * A.wfr.length * A.gfr.length * A.alq.length;
            out.bhp = A.thp.map(function () { return A.wfr.map(function () { return A.gfr.map(function () { return A.alq.map(function () { return null; }); }); }); });
            var got = 0;
            for (var k = 6; k < recs.length; k++) {
                var r = recs[k]; if (!r.length) continue;
                var ix = r.slice(0, 4).map(function (x) { return +x - 1; }), v = _nums(r.slice(4), 'BHP record ' + (k - 5), errors);
                if (v.length !== A.flo.length) { errors.push('BHP record ' + (k - 5) + ': ' + v.length + ' values (' + A.flo.length + ' expected)'); continue; }
                if (!(out.bhp[ix[0]] && out.bhp[ix[0]][ix[1]] && out.bhp[ix[0]][ix[1]][ix[2]] && ix[3] >= 0 && ix[3] < A.alq.length)) { errors.push('BHP record ' + (k - 5) + ': index out of range'); continue; }
                out.bhp[ix[0]][ix[1]][ix[2]][ix[3]] = v; got++;
            }
            if (got !== nRec) errors.push(got + ' BHP records (' + nRec + ' expected)');
        } else {
            if (r1.length < 6) { errors.push('record 1 has ' + r1.length + ' items (6 expected)'); return out; }
            out.tableNo = +r1[0]; out.datum = +r1[1];
            out.types = { flo: r1[2], thp: r1[3], units: r1[4], tab: r1[5] };
            if (recs.length < 3) { errors.push('the axis records are incomplete'); return out; }
            out.axes = { flo: _nums(recs[1], 'rates', errors), thp: _nums(recs[2], 'THP', errors), wfr: [0], gfr: [0], alq: [0] };
            out.bhp = out.axes.thp.map(function () { return [[[null]]]; });
            var got2 = 0;
            for (var k2 = 3; k2 < recs.length; k2++) {
                var r2 = recs[k2]; if (!r2.length) continue;
                var it = +r2[0] - 1, v2 = _nums(r2.slice(1), 'BHP record ' + (k2 - 2), errors);
                if (v2.length !== out.axes.flo.length || !out.bhp[it]) { errors.push('BHP record ' + (k2 - 2) + ' is malformed'); continue; }
                out.bhp[it][0][0][0] = v2; got2++;
            }
            if (got2 !== out.axes.thp.length) errors.push(got2 + ' BHP records (' + out.axes.thp.length + ' expected)');
        }
        out.ok = !errors.length;
        return out;
    }

    // ── CSV long format ──────────────────────────────────────────────────────
    function _csvCell(v) { var s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
    function csv(T) {
        if (!T || !T.ok) return '';
        var s = T.spec, prod = s.kind === 'prod';
        var head = ['rate_' + s.flo.type + '_' + FLO[s.flo.type].unit, 'thp_psia'];
        if (prod) head.push('wfr_' + s.wfr.type + '_' + WFR[s.wfr.type].unit, 'gfr_' + s.gfr.type + '_' + GFR[s.gfr.type].unit, 'alq' + (s.alq.type ? '_' + s.alq.type + '_' + ALQ[s.alq.type].unit : '_none'));
        head.push('bhp_psia', 'flags');
        var lines = ['# Lift-curve table (' + (prod ? 'producer' : 'injector') + ') ' + s.tableNo + ', datum ' + _f(T.datum.md, 0) + ' ft MD / ' + _f(T.datum.tvd, 0) + ' ft TVD, field units', head.map(_csvCell).join(',')];
        var how = {}; T.filled.forEach(function (x) { how[[x.t, x.w, x.g, x.a, x.f].join(',')] = x.how; });
        T.points.forEach(function (p) {
            var r = [_num(p.flo), _num(p.thp)];
            if (prod) r.push(_num(p.wfr), _num(p.gfr), _num(p.alq));
            r.push(p.bhp.toFixed(2), p.flag === 'ok' ? '' : 'filled:' + (how[[p.t, p.w, p.g, p.a, p.f].join(',')] || '') + ':' + (p.code || ''));
            lines.push(r.map(_csvCell).join(','));
        });
        return lines.join('\n') + '\n';
    }
    function slice(T, o) {
        o = o || {};
        if (!T || !T.ok) return [];
        var w = o.w || 0, g = o.g || 0, a = o.a || 0;
        return T.axes.thp.map(function (thp, t) {
            var row = T.bhp[t] && T.bhp[t][w] && T.bhp[t][w][g] && T.bhp[t][w][g][a];
            return { t: t, thp: thp, pts: (row || []).map(function (v, f) { return { f: f, q: T.axes.flo[f], bhp: v, filled: T.status[t][w][g][a][f] !== 'ok' }; }) };
        });
    }
    // multilinear interpolation on the five axes (clamped to the table)
    function _br(ax, v) {
        if (ax.length === 1) return [0, 0, 0];
        if (v <= ax[0]) return [0, 1, 0];
        if (v >= ax[ax.length - 1]) return [ax.length - 2, ax.length - 1, 1];
        for (var i = 1; i < ax.length; i++) if (v <= ax[i]) return [i - 1, i, (v - ax[i - 1]) / (ax[i] - ax[i - 1])];
        return [0, 0, 0];
    }
    function interp(T, x) {
        if (!T || !T.ok || !x) return null;
        var A = T.axes, keys = ['thp', 'wfr', 'gfr', 'alq', 'flo'], br = keys.map(function (k) { return _br(A[k], _fin(+x[k]) ? +x[k] : A[k][0]); });
        var sum = 0;
        for (var m = 0; m < 32; m++) {
            var wgt = 1, ix = [];
            for (var d = 0; d < 5; d++) { var bit = (m >> d) & 1, b = br[d]; ix.push(bit ? b[1] : b[0]); wgt *= bit ? b[2] : 1 - b[2]; }
            if (wgt === 0) continue;
            var v = T.bhp[ix[0]][ix[1]][ix[2]][ix[3]][ix[4]];
            if (!_fin(v)) return null;
            sum += wgt * v;
        }
        return sum;
    }

    // ── PVT tables ───────────────────────────────────────────────────────────
    function pvtTable(M, o) {
        o = o || {};
        if (!_fn('WTS_wp_fluid.build')) return { ok: false, code: 'MISSING_ENGINE', rows: [], errors: ['WTS_wp_fluid.build is not available'], warnings: [] };
        if (!M || !M.fluid) return { ok: false, code: 'NO_MODEL', rows: [], errors: ['the model is incomplete'], warnings: [] };
        var T = _fin(_n(o.T_F)) ? +o.T_F : _n(_get(M, ['res', 'T_F']));
        if (!_fin(T)) return { ok: false, code: 'BAD_T', rows: [], errors: ['the reservoir temperature is needed (step ②)'], warnings: [] };
        var F = G.WTS_wp_fluid.build(M.fluid, { T_F: T });
        if (!F || !F.ok) return { ok: false, code: 'NEEDS_FLUID', rows: [], errors: (F && F.errors && F.errors.length) ? F.errors : ['the fluid is incomplete'], warnings: [] };
        var pb = F.pb ? F.pb(T) : null, pr = _n(_get(M, ['res', 'pr'])), pList;
        if (Array.isArray(o.pList) && o.pList.length) pList = o.pList.map(Number).filter(function (p) { return _fin(p) && p > 0; });
        else {
            var top = Math.max(pr || 0, pb || 0, 1000) * 1.15, n = Math.max(6, Math.min(40, Math.round(_n(o.n) || 15)));
            pList = [];
            for (var i = 0; i < n; i++) pList.push(+(PATM + (top - PATM) * i / (n - 1)).toFixed(1));
        }
        if (_fin(pb) && pb > PATM && pList.indexOf(pb) === -1 && F.type === 'oil') pList.push(pb);
        pList.sort(function (a, b) { return a - b; });
        pList = pList.filter(function (p, i, a) { return i === 0 || p - a[i - 1] > 1e-6; });
        var tb = G.WTS_wp_fluid.table(F, pList, T);
        if (!tb || !tb.ok) return { ok: false, code: 'NO_ROWS', rows: [], errors: (tb && tb.errors && tb.errors.length) ? tb.errors : ['no rows'], warnings: (tb && tb.warnings) || [] };
        var notes = [];
        notes.push('Black-oil properties at ' + _f(T, 1) + ' °F from the page\'s fluid engine (the traverse uses the same path).');
        if (F.wet) notes.push('Wet gas (D14): the separator gas is the free gas; the condensate is a constant-volume liquid (no vaporised-oil table).');
        var prov = (F.provisional || []).map(function (l) { return l + ': ' + PROVISIONAL; });
        prov.forEach(function (p) { notes.push('Provisional: ' + p + '.'); });
        return { ok: true, type: F.type, wet: !!F.wet, T: T, pb: _fin(pb) ? pb : null, gor: F.gor, rsb: F.rsb, api: F.api, sgg: F.sgg, rows: tb.rows, provisional: prov, notes: notes, warnings: tb.warnings || [], errors: [] };
    }
    var PVT_COLS = [
        ['p', 'p', 'psia', 'pressure'], ['rs', 'Rs', 'scf/STB', 'gor'], ['bo', 'Bo', 'rb/STB', null], ['muo', 'mu_o', 'cp', 'viscosity'],
        ['co', 'co', '1/psi', 'compressibility'], ['z', 'Z', '-', null], ['bgRB', 'Bg', 'rb/Mscf', 'bg'], ['mug', 'mu_g', 'cp', 'viscosity'],
        ['bw', 'Bw', 'rb/STB', null], ['muw', 'mu_w', 'cp', 'viscosity'], ['rhoO', 'rho_o', 'lbm/ft3', 'density'], ['rhoG', 'rho_g', 'lbm/ft3', 'density'],
        ['rhoW', 'rho_w', 'lbm/ft3', 'density']
    ];
    function _pvtCols(P) {
        var oil = P.type === 'oil', gas = P.type === 'gas' || P.type === 'condensate' || P.type === 'gasinj', water = P.type === 'water' || P.type === 'waterinj';
        return PVT_COLS.filter(function (c) {
            if (oil) return true;
            if (gas) return ['p', 'z', 'bgRB', 'mug', 'rhoG', 'bw', 'muw', 'rhoW'].indexOf(c[0]) !== -1;
            if (water) return ['p', 'bw', 'muw', 'rhoW'].indexOf(c[0]) !== -1;
            return true;
        });
    }
    function pvtCsv(P, o) {
        o = o || {};
        if (!P || !P.ok) return '';
        var U = G.WTS_units, metric = !!o.metric && U && U.CATEGORIES && typeof U.convertCategory === 'function', cols = _pvtCols(P);
        var unit = function (c) {
            if (!metric || !c[3]) return c[2] === 'rb/STB' && metric ? 'rm3/sm3' : c[2];
            if (c[3] === 'bg') return 'rm3/sm3';
            var C = U.CATEGORIES[c[3]]; return C ? String(C.metric.unit) : c[2];
        };
        var conv = function (c, v) {
            if (!_fin(v)) return '';
            if (!metric || !c[3]) return _num(v);
            if (c[3] === 'bg') return _num(v * 5.614583 / 1000);              // rb/Mscf → rm³/sm³ (= ft³/scf)
            return U.CATEGORIES[c[3]] ? _num(U.convertCategory(v, c[3], 'imperial', 'metric')) : _num(v);
        };
        var head = cols.map(function (c) { return c[1] + '_' + unit(c); });
        if (P.type === 'oil') head.push('state');
        var lines = ['# PVT table at ' + (metric ? _f((P.T - 32) * 5 / 9, 1) + ' degC' : _f(P.T, 1) + ' degF') + (P.pb ? ', bubble point ' + (metric ? conv(PVT_COLS[0], P.pb) + ' ' + unit(PVT_COLS[0]) : _f(P.pb, 1) + ' psia') : '') + ', ' + (metric ? 'metric' : 'field') + ' units',
            head.map(_csvCell).join(',')];
        P.rows.forEach(function (r) {
            var cells = cols.map(function (c) { return conv(c, r[c[0]]); });
            if (P.type === 'oil') cells.push(r.saturated ? 'saturated' : 'undersaturated');
            lines.push(cells.map(_csvCell).join(','));
        });
        return lines.join('\n') + '\n';
    }
    function _waterRec(P) {
        var rows = P.rows.filter(function (r) { return _fin(r.bw) && _fin(r.muw); });
        if (rows.length < 3) return null;
        var mid = Math.floor(rows.length / 2), a = rows[mid - 1], b = rows[mid], c = rows[mid + 1];
        var cw = -(c.bw - a.bw) / ((c.p - a.p) * b.bw), cmu = (c.muw - a.muw) / ((c.p - a.p) * b.muw);
        return { pref: b.p, bw: b.bw, cw: _fin(cw) ? Math.max(0, cw) : 0, muw: b.muw, cmu: _fin(cmu) ? cmu : 0 };
    }
    function pvtText(P) {
        if (!P || !P.ok) return '';
        var L = [], oil = P.type === 'oil', gas = oil || P.type === 'gas' || P.type === 'condensate' || P.type === 'gasinj';
        L.push('-- Black-oil PVT tables, Well Performance page, ' + _f(P.T, 1) + ' degF (field units)');
        P.notes.forEach(function (n) { L.push('-- ' + n.replace(/[\r\n]/g, ' ')); });
        L.push('');
        if (oil) {
            var sat = P.rows.filter(function (r) { return r.saturated; }), und = P.rows.filter(function (r) { return !r.saturated; });
            var recs = [], lastRs = -1;
            sat.forEach(function (r) { var rs = r.rs / 1000; if (rs > lastRs + 1e-9) { recs.push({ rs: rs, rows: [r] }); lastRs = rs; } });
            if (recs.length && und.length) und.forEach(function (r) { recs[recs.length - 1].rows.push(r); });
            L.push(KW.oil);
            L.push('-- Rs (Mscf/STB)  p (psia)  Bo (rb/STB)  mu_o (cp)');
            recs.forEach(function (rc) {
                rc.rows.forEach(function (r, i) { L.push((i === 0 ? '  ' + _num(rc.rs) : '          ') + '  ' + _num(r.p) + '  ' + r.bo.toFixed(5) + '  ' + r.muo.toFixed(5) + (i === rc.rows.length - 1 ? ' /' : '')); });
            });
            L.push('/');
            L.push('');
        }
        if (gas) {
            L.push(KW.gas);
            L.push('-- p (psia)  Bg (rb/Mscf)  mu_g (cp)');
            P.rows.filter(function (r) { return _fin(r.bgRB) && _fin(r.mug); }).forEach(function (r) { L.push('  ' + _num(r.p) + '  ' + r.bgRB.toFixed(5) + '  ' + r.mug.toFixed(6)); });
            L.push('/');
            L.push('');
        }
        var wr = _waterRec(P);
        if (wr && (P.type === 'water' || P.type === 'waterinj' || P.rows.some(function (r) { return _fin(r.bw); }))) {
            L.push(KW.water);
            L.push('-- p_ref (psia)  Bw (rb/STB)  cw (1/psi)  mu_w (cp)  viscosibility (1/psi)');
            L.push('  ' + [_num(wr.pref), wr.bw.toFixed(5), wr.cw.toExponential(4).toUpperCase(), wr.muw.toFixed(5), wr.cmu.toExponential(4).toUpperCase()].join('  ') + ' /');
            L.push('');
        }
        return L.join('\n');
    }
    function parsePvtText(str) {
        var tk = _tokens(str), errors = [], out = { ok: false, oil: [], gas: [], water: null, errors: errors };
        var at = function (kw) { for (var i = 0; i < tk.length; i++) if (!tk[i].end && tk[i].s === kw) return i; return -1; };
        var io = at(KW.oil), ig = at(KW.gas), iw = at(KW.water);
        var stopAt = function (i0) { var idx = [io, ig, iw].filter(function (x) { return x > i0; }); return idx.length ? Math.min.apply(null, idx) : tk.length; };
        if (io !== -1) {
            var e = stopAt(io), cur = [];
            for (var i = io + 1; i < e; i++) {
                if (tk[i].end) {
                    if (!cur.length) break;                          // the empty record ends the table
                    var v = cur.map(Number);
                    if (v.some(function (x) { return !_fin(x); }) || (v.length - 1) % 3 !== 0) errors.push('live-oil record malformed');
                    else { var rec = { rs: v[0], rows: [] }; for (var k = 1; k < v.length; k += 3) rec.rows.push({ p: v[k], bo: v[k + 1], muo: v[k + 2] }); out.oil.push(rec); }
                    cur = [];
                } else cur.push(tk[i].s);
            }
        }
        if (ig !== -1) {
            var e2 = stopAt(ig), vals = [];
            for (var j = ig + 1; j < e2 && !tk[j].end; j++) vals.push(+tk[j].s);
            if (vals.length % 3 !== 0 || vals.some(function (x) { return !_fin(x); })) errors.push('dry-gas table malformed');
            else for (var k2 = 0; k2 < vals.length; k2 += 3) out.gas.push({ p: vals[k2], bg: vals[k2 + 1], mug: vals[k2 + 2] });
        }
        if (iw !== -1) {
            var w = []; for (var j2 = iw + 1; j2 < tk.length && !tk[j2].end; j2++) w.push(+tk[j2].s);
            if (w.length !== 5 || w.some(function (x) { return !_fin(x); })) errors.push('water record malformed'); else out.water = { pref: w[0], bw: w[1], cw: w[2], muw: w[3], cmu: w[4] };
        }
        if (io === -1 && ig === -1 && iw === -1) errors.push('no PVT table keyword found');
        out.ok = !errors.length;
        return out;
    }

    var NS = G.WTS_wp_export = G.WTS_wp_export || {};
    NS.kind = kind; NS.FLO = FLO; NS.WFR = WFR; NS.GFR = GFR; NS.ALQ = ALQ;
    NS.suggest = suggest; NS.normalize = normalize; NS.pointModel = pointModel;
    NS.liftJob = liftJob; NS.liftTable = liftTable; NS.fill = fill; NS.monotone = monotone;
    NS.text = text; NS.parseText = parseText; NS.csv = csv; NS.slice = slice; NS.interp = interp;
    NS.pvtTable = pvtTable; NS.pvtCsv = pvtCsv; NS.pvtText = pvtText; NS.parsePvtText = parsePvtText;
    NS.MAX_POINTS = MAX_POINTS; NS.MAX_VALUES = MAX_VALUES; NS.SLICE_MS = SLICE_MS; NS.PROVISIONAL = PROVISIONAL;
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis, X = G.WTS_wp_export, bad = [];
    if (!X || typeof X.liftJob !== 'function' || typeof X.parseText !== 'function') bad.push('namespace');
    else {
        var T = { ok: true, spec: { kind: 'inj', tableNo: 3, flo: { type: 'WAT' } }, datum: { md: 100, tvd: 90 }, axes: { flo: [1, 2], thp: [100, 200], wfr: [0], gfr: [0], alq: [0] },
            bhp: [[[[[150, 160]]]], [[[[250, 262]]]]], status: [[[[['ok', 'ok']]]], [[[['ok', 'ok']]]]], filled: [], notes: [], provisional: [] };
        var P = X.parseText(X.text(T));
        if (!P.ok || P.bhp[1][0][0][0][1] !== 262 || P.datum !== 90) bad.push('injector round trip');
    }
    if (bad.length && typeof console !== 'undefined') console.error('[49-calc-wp-export.js self-test] ' + bad.join('; '));
})();
