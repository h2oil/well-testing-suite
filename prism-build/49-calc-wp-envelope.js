// =============================================================================
// WTS — 49-calc-wp-envelope.js  (Round 9; helper module: no page in window.WTS_calcRegistry)
// -----------------------------------------------------------------------------
// Well Performance operating envelope and lift screening (WP27, increment B) — docs/WELL-PERFORMANCE-PLAN.md §1.4 G6 / H11,
// §4.9–§4.12, §7.4, §16, D9, D17.
//
// OPERATING ENVELOPE (rate against wellhead pressure, with the constraints). The wellhead deliverability curve THP_av(q) is the
//   wellhead-node inflow of the solver: for each rate the pressure marched UP the surveyed well (hydrostatic on TVD, friction on MD,
//   the model's correlation, multipliers and temperature model) from the IPR pwf — one WTS_wp_system.evalAt per rate on one frozen
//   step layout (≈ 1 E each). Choking moves the operating point along this curve; the flowline back pressure THP_line(q) (separator +
//   flowline, WTS_wp_system.boundary) is the lowest wellhead pressure at a rate, so the vertical distance between the two curves is
//   the choke pressure drop at that rate and their crossing is the maximum rate (no choke). Constraints, each a rate limit:
//     lower — static stability at a fixed THP (right of the THP_av maximum: dTHP_av/dq < 0), liquid loading (gas wells: the rate where
//             q = q_c of the traverse at that rate, WTS_wp_loading, provisional methods), the wellhead rating (THP_av ≤ rating);
//     upper — the maximum rate, the erosional ratio of the tubing (API RP 14E, C = M.system.eroC; ≤ o.eroLimit, default 1), the
//             drawdown limit (pwf ≥ p̄r − ΔP_max), a minimum pwf, the bubble point at the mid-perforations (pwf ≥ p_b, optional), a
//             facility rate.
//   The operating window = [max of the lower limits, min of the upper limits] on the curve; the binding constraints are named; the
//   current operating point (the solve with the model's choke) is checked against every limit. No new correlation: the envelope is
//   the existing solver's numbers (no D17 gate of its own; the loading methods carry their provisional label).
// LIFT SCREENING (§7.4). A screening matrix — natural flow, continuous gas lift, ESP, rod pump, progressing-cavity pump, jet pump,
//   plunger lift — against the well: TVD and MD, the maximum inclination and dogleg severity of the survey (deviation first), the
//   liquid rate, GLR, water cut, bottom-hole temperature, oil gravity, H₂S / CO₂, lift gas available. Indicative ranges from the
//   published screening literature (Brown 1982; Clegg, Bucaram & Hein 1993) — no verified published example (Q9): verified:false with
//   the provisional label; a screening aid, not a design. The pump setting window: the deepest MD interval above the perforations
//   whose dogleg severity stays within the method's limit (ESP 3°/100 ft, rod pump 2°/100 ft by default) and whose inclination is
//   below its limit, with MD and TVD. The rate comparison (a Job): natural flow (the solve), gas lift (the quick-look performance
//   curve on a short list, its optimum; with the model's injection pressure, else a stated screening pressure), ESP (a solve with
//   M.lift.type 'esp' when the ESP engine answers with R.lift.type 'esp'; otherwise not available) and the inflow potential of any
//   pump (the IPR rate at a minimum practical pwf).
// EVALUATIONS (§16). Envelope ≈ 14 + 4 refinement marches + the flowline at each rate ≈ 26 E; screening ≈ a solve + the short
//   performance curve (≈ 60 E) + an ESP solve.
//
// Interfaces (field units, §3.0; every result {ok, errors[], warnings[{code, msg, sev}], …}; nothing throws for user data):
//   WTS_wp_envelope
//     .job(M, o?) → Job: result() → {ok, curve:[{q, thp, thpLine, pwf, ok, stable, qc, loadMargin, ero}] (psig, Mscf/d for q_c),
//         peak:{q, thp}, max:{q, thp}, limits:{stab, load, rating, max, ero, dd, pwfMin, pb, fac → {q, kind:'lower'|'upper', label, on}},
//         window:{ok, qLo, qHi, thpLo, thpHi, lo:[keys], hi:[keys]}, op:{q, thp, pwf, inside, violated:[keys]}, rateUnit, evals}
//         o = {n, ddMax psi, pwfMin psia, pbLimit, qFac (rate units of the well), eroLimit, R (a solve of M to reuse)}
//     .at(res, q) → {q, thp, thpLine, pwf, chokeDp, checks:[{key, ok}]}   (interpolated on the curve; the page's drag handle)
//   WTS_wp_screen
//     .PROVISIONAL, .METHODS [{key, label}]
//     .matrix(M, o?) → {ok, verified:false, provisional, well:{tvd, md, maxInc, maxDls, qL, glr, wc, bht, api, h2s, co2, gasAvailable},
//         methods:[{key, label, verdict:'ok'|'warn'|'fail', checks:[{key, label, st, msg}], rank}], windows:{esp, rod}}   (no solve;
//         o.R = a solve of M for the rates, o.W = WTS_wp_well.build of M.well)
//     .job(M, o?) → Job: result() → {ok, natural:{ok, q, qL, …}, gaslift:{ok, qinj, qL, pinj_psig, assumedPinj, code?, error?},
//         esp:{ok, available, q, code?, error?}, potential:{q, pwf}, matrix, evals}
// =============================================================================
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;

    var PROVISIONAL = 'provisional — not verified against a published example';
    var PATM = 14.696;
    var FRACS = [0.01, 0.025, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.97];
    var GAS = ['gas', 'condensate', 'gasinj'];

    function _fin(v) { return typeof v === 'number' && isFinite(v); }
    function _n(v) { if (typeof v === 'number') return isFinite(v) ? v : null; if (typeof v === 'string' && v.trim() !== '' && isFinite(+v)) return +v; return null; }
    function _w(code, msg, sev) { return { code: code, msg: String(msg).slice(0, 299), sev: sev === 'info' ? 'info' : 'warn' }; }
    function _clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
    function _get(o, path, d) { var c = o; for (var i = 0; i < path.length; i++) { if (c == null) return d; c = c[path[i]]; } return c === undefined ? d : c; }
    function _fn(path) { var p = path.split('.'), f = p.length > 1 ? (G[p[0]] || {})[p[1]] : G[p[0]]; return typeof f === 'function' && (G.__WP_STUBS || []).indexOf(path) === -1 ? f : null; }
    function _f(x, dp) { if (!_fin(x)) return '–'; return (+x.toFixed(dp == null ? 0 : dp)).toString(); }
    function _isGas(t) { return GAS.indexOf(t) !== -1; }
    function _type(M) { return _get(M, ['fluid', 'type'], 'oil') || 'oil'; }
    function _rateUnit(t) { return t === 'oil' ? 'STB/d liquid' : t === 'water' || t === 'waterinj' ? 'BWPD' : 'Mscf/d'; }
    function _failJob(code, errors) {
        var res = { ok: false, code: code, curve: [], evals: 0, errors: errors, warnings: [] };
        return { step: function () { return { done: true, progress: 1, label: '' }; }, done: function () { return true; }, progress: function () { return 1; },
            result: function () { return res; }, cancel: function () { }, errors: errors, code: code };
    }
    function _job(spec) {
        var st = { i: 0, done: false, cancelled: false, res: null };
        return {
            n: spec.n,
            step: function () {
                if (!st.done && !st.cancelled) { var r = spec.next(st.i); st.i++; if (r === true || st.i >= spec.n) st.done = true; }
                else st.done = true;
                if (st.done && !st.res) st.res = st.cancelled ? { ok: false, code: 'CANCELLED', cancelled: true, errors: ['cancelled'], warnings: [] } : spec.finish();
                return { done: st.done, progress: st.done ? 1 : Math.min(0.99, st.i / Math.max(1, spec.n)), label: st.done ? 'done' : spec.label(st.i) };
            },
            done: function () { return st.done; },
            progress: function () { return st.done ? 1 : st.i / Math.max(1, spec.n); },
            result: function () { if (!st.res) st.res = st.cancelled ? { ok: false, code: 'CANCELLED', cancelled: true, errors: ['cancelled'], warnings: [] } : spec.finish(); return st.res; },
            cancel: function () { st.cancelled = true; st.done = true; st.res = null; }
        };
    }
    function _interp(pts, x, kx, ky) {
        for (var i = 1; i < pts.length; i++) {
            var a = pts[i - 1], b = pts[i];
            if (x >= a[kx] && x <= b[kx] && _fin(a[ky]) && _fin(b[ky])) { var t = b[kx] > a[kx] ? (x - a[kx]) / (b[kx] - a[kx]) : 0; return a[ky] + t * (b[ky] - a[ky]); }
        }
        return null;
    }
    // the first x (ascending) where f(point) changes sign, linear between the two points
    function _cross(pts, f, from) {
        for (var i = Math.max(1, from || 1); i < pts.length; i++) {
            var a = f(pts[i - 1]), b = f(pts[i]);
            if (_fin(a) && _fin(b) && ((a < 0 && b >= 0) || (a >= 0 && b < 0))) return pts[i - 1].q + (pts[i].q - pts[i - 1].q) * (a / (a - b));
        }
        return null;
    }

    // ── the operating envelope ──────────────────────────────────────────────
    function envJob(M, o) {
        o = o || {};
        if (!_fn('WTS_wp_system.evalAt') || !_fn('WTS_wp_system.solve') || !_fn('WTS_wp_ipr.curve') || !_fn('WTS_wp_fluid.build')) return _failJob('MISSING_ENGINE', ['the system engine is not available']);
        if (!M || !M.res || !M.fluid || !M.surface || !M.system || !M.well) return _failJob('NO_MODEL', ['the model is incomplete']);
        var t = _type(M), gas = _isGas(t);
        if (t === 'gasinj' || t === 'waterinj') return _failJob('NOT_APPLICABLE', ['the operating envelope is for producers']);
        if (!(_n(M.res.pr) > PATM)) return _failJob('NEEDS_PR', ['the reservoir pressure is needed (step ②)']);
        var SY = G.WTS_wp_system, F = G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F }), I = F && F.ok ? G.WTS_wp_ipr.curve(M.res, F) : null;
        if (!I || !I.ok || !(I.aof > 0)) return _failJob('NO_IPR', [(I && I.errors && I.errors[0]) || 'the inflow curve could not be built']);
        var W = _fn('WTS_wp_well.build') ? G.WTS_wp_well.build(M.well, { res: M.res, fluidType: t, surface: M.surface }) : null;
        var Mw = _clone(M); Mw.system.node = 'wellhead';
        var Mb = _clone(M); Mb.surface.choke.present = true; Mb.surface.choke.bean64 = _fin(_n(Mb.surface.choke.bean64)) ? Mb.surface.choke.bean64 : 32;
        var n = Math.max(8, Math.min(30, Math.round(_n(o.n) || FRACS.length)));
        var fr = FRACS.length === n ? FRACS.slice() : (function () { var a = []; for (var i = 0; i < n; i++) a.push(0.01 + (0.97 - 0.01) * Math.pow(i / (n - 1), 1.4)); return a; })();
        var qs = fr.map(function (f) { return f * I.aof; });
        var st = { grid: null, pts: [], evals: 0, R: o.R && o.R.ok ? o.R : null, refine: 0 };
        var REF = 4, POL = 4;
        var nTot = 1 + qs.length + REF + POL;
        function point(q) {
            var e = SY.evalAt(Mw, q, st.grid ? { grid: st.grid, node: 'wellhead' } : { node: 'wellhead' });
            if (!st.grid && e && e.grid) st.grid = e.grid;
            st.evals += 1;
            var thp = e && e.ok && _fin(e.pIn) ? e.pIn - PATM : null, pwf = I.pwfAt(q);
            var b = SY.boundary(Mb, q), thpLine = b && b.ok && _fin(b.p2_psig) ? b.p2_psig : (_fin(_n(M.surface.psep_psig)) ? +M.surface.psep_psig : null);
            if (M.surface.flowline && M.surface.flowline.length) st.evals += 0.5;
            var ero = null, qc = null, lm = null;
            if (e && e.tr && Array.isArray(e.tr.profile)) {
                e.tr.profile.forEach(function (r) { if (_fin(r.ero) && (ero == null || r.ero > ero)) ero = r.ero; });
                if (gas && thp != null && typeof G.WTS_wp_loading === 'function') {
                    var L = G.WTS_wp_loading({ ok: true, traverse: e.tr, rates: { qg: q } }, F, W);
                    if (L && L.ok !== false && _fin(L.qc_MMscfd)) { qc = L.qc_MMscfd * 1000; lm = q / qc - 1; }
                }
            }
            return { q: q, thp: thp, thpLine: thpLine, pwf: pwf, ok: thp != null && thp >= 0, qc: qc, loadMargin: lm, ero: ero };
        }
        return _job({
            n: nTot,
            next: function (i) {
                if (i === 0) { if (!st.R) { st.R = SY.solve(M); st.evals += (st.R && st.R.evals) || 0; } return false; }
                if (i <= qs.length) { st.pts.push(point(qs[i - 1])); return false; }
                // polish: one exact march at each limit read from the curve (loading, rating, erosion, stability peak), so the window
                // edges are evaluated rather than interpolated
                if (st.polish) { var qp = st.polish.shift(); if (_fin(qp)) st.pts.push(point(qp)); return !st.polish.length; }
                // refinement: the end of flow (THP reaches zero) and the maximum rate (THP_av = THP_line)
                var pts = st.pts.slice().sort(function (a, b) { return a.q - b.q; }), k = i - qs.length;
                var cross = null;
                for (var j = 1; j < pts.length; j++) {
                    var a = pts[j - 1], b = pts[j], fa = a.ok ? a.thp - a.thpLine : -1, fb = b.ok ? b.thp - b.thpLine : -1;
                    if (a.ok && fa >= 0 && (fb < 0 || !b.ok)) { cross = [a, b]; break; }
                }
                var toPolish = function () {
                    var c0 = core(); if (!c0.ok) return true;
                    var have = st.pts.map(function (p) { return p.q; }), near = function (q) { return have.some(function (h) { return Math.abs(h - q) <= 1e-3 * Math.max(1, q); }); };
                    st.polish = ['load', 'rating', 'ero'].map(function (kk) { return c0.limits[kk] && c0.limits[kk].q; }).concat([c0.peak.q]).filter(function (q) { return _fin(q) && q > 0 && !near(q); }).slice(0, POL);
                    return !st.polish.length;
                };
                if (!cross) return k >= REF ? toPolish() : false;
                var A = cross[0], B = cross[1], qn;
                if (B.ok && _fin(B.thp)) { var fA = A.thp - A.thpLine, fB = B.thp - B.thpLine; qn = A.q + (B.q - A.q) * fA / (fA - fB); }
                else qn = 0.5 * (A.q + B.q);
                if (!(qn > A.q && qn < B.q) || (B.q - A.q) < 1e-3 * B.q || k >= REF) return toPolish();
                st.pts.push(point(qn));
                return false;
            },
            label: function (i) { return i === 0 ? 'operating point' : i <= qs.length ? 'deliverability ' + i + ' of ' + qs.length : (st.polish ? 'limits' : 'maximum rate'); },
            finish: function () { return core(); }
        });
        function core() {
                var pts = st.pts.slice().sort(function (a, b) { return a.q - b.q; }), warnings = [];
                var okP = pts.filter(function (p) { return p.ok; });
                if (okP.length < 2) return { ok: false, code: 'NO_FLOW', curve: pts, evals: st.evals, rateUnit: _rateUnit(t), errors: ['the well cannot lift to surface at any rate'], warnings: warnings };
                // the THP_av maximum (parabola through the best point and its neighbours) — stable at a fixed THP to its right
                var bi = 0; okP.forEach(function (p, i2) { if (p.thp > okP[bi].thp) bi = i2; });
                var peak = { q: okP[bi].q, thp: okP[bi].thp };
                if (bi > 0 && bi < okP.length - 1) {
                    var x0 = okP[bi - 1].q, x1 = okP[bi].q, x2 = okP[bi + 1].q, y0 = okP[bi - 1].thp, y1 = okP[bi].thp, y2 = okP[bi + 1].thp;
                    var den = (x0 - x1) * (x0 - x2) * (x1 - x2), A2 = (x2 * (y1 - y0) + x1 * (y0 - y2) + x0 * (y2 - y1)) / den, B2 = (x2 * x2 * (y0 - y1) + x1 * x1 * (y2 - y0) + x0 * x0 * (y1 - y2)) / den;
                    if (A2 < 0) { var xv = -B2 / (2 * A2); if (xv > x0 && xv < x2) peak = { q: xv, thp: y1 + (xv - x1) * ((y2 - y0) / (x2 - x0)) }; }
                }
                pts.forEach(function (p) { p.stable = p.ok && p.q >= peak.q - 1e-9; });
                var lim = {}, set = function (k, q, kind, label) { lim[k] = { q: _fin(q) ? q : null, kind: kind, label: label }; };
                set('stab', peak.q, 'lower', 'static stability (fixed THP)');
                // maximum rate: THP_av = THP_line on the stable branch
                var okPts = pts.filter(function (p) { return p.ok; });
                var right = [{ q: peak.q, thp: peak.thp, thpLine: _interp(okPts, peak.q, 'q', 'thpLine'), ok: true, loadMargin: _interp(okPts.filter(function (p) { return _fin(p.loadMargin); }), peak.q, 'q', 'loadMargin') }]
                    .concat(pts.filter(function (p) { return p.q > peak.q + 1e-9; }));
                var qMax = _cross(right, function (p) { return p.ok && _fin(p.thpLine) ? p.thp - p.thpLine : -1; });
                if (!_fin(qMax)) { var lastOk = right.filter(function (p) { return p.ok; }).pop(); qMax = lastOk ? lastOk.q : null; warnings.push(_w('MAX_NOT_BRACKETED', 'The flowline back pressure is not reached within the rates sampled: the maximum rate is the last rate that flows.', 'info')); }
                set('max', qMax, 'upper', 'maximum rate (choke fully open)');
                if (gas) set('load', _cross(right, function (p) { return _fin(p.loadMargin) ? p.loadMargin : NaN; }), 'lower', 'liquid loading (q = q_c)');
                var rating = _n(_get(M, ['surface', 'rating', 'wellhead_psi']));
                if (_fin(rating)) set('rating', peak.thp > rating ? _cross(right, function (p) { return p.ok ? rating - p.thp : NaN; }) : null, 'lower', 'wellhead rating ' + _f(rating) + ' psig');
                var eroL = _fin(_n(o.eroLimit)) ? _n(o.eroLimit) : 1;
                set('ero', _cross(pts, function (p) { return _fin(p.ero) ? eroL - p.ero : NaN; }), 'upper', 'erosional ratio ' + _f(eroL, 2) + ' (tubing)');
                var pr = +M.res.pr, dd = _n(o.ddMax), pwM = _n(o.pwfMin);
                if (dd > 0) set('dd', I.qAt(Math.max(PATM, pr - dd)), 'upper', 'drawdown ≤ ' + _f(dd) + ' psi');
                if (pwM > 0) set('pwfMin', pwM < pr ? I.qAt(pwM) : 0, 'upper', 'pwf ≥ ' + _f(pwM) + ' psia');
                var pb = _fin(I.pb) ? I.pb : (F.pb ? F.pb(+M.res.T_F) : null);
                if (o.pbLimit && _fin(pb) && t === 'oil') set('pb', pb < pr ? I.qAt(pb) : 0, 'upper', 'pwf ≥ p_b ' + _f(pb) + ' psia');
                var qf = _n(o.qFac); if (qf > 0) set('fac', qf, 'upper', 'facility rate');
                // the window on the curve
                var lo = 0, hi = Infinity, loK = [], hiK = [];
                Object.keys(lim).forEach(function (k) {
                    var L2 = lim[k]; if (!_fin(L2.q)) return;
                    if (L2.kind === 'lower') { if (L2.q > lo + 1e-9) { lo = L2.q; loK = [k]; } else if (Math.abs(L2.q - lo) <= 1e-9) loK.push(k); }
                    else { if (L2.q < hi - 1e-9) { hi = L2.q; hiK = [k]; } else if (Math.abs(L2.q - hi) <= 1e-9) hiK.push(k); }
                });
                var win = { ok: _fin(hi) && hi > lo, qLo: lo, qHi: _fin(hi) ? hi : null, lo: loK, hi: hiK, thpLo: null, thpHi: null };
                if (win.ok) { win.thpHi = _interp(pts.filter(function (p) { return p.ok; }), lo, 'q', 'thp'); win.thpLo = _interp(pts.filter(function (p) { return p.ok; }), hi, 'q', 'thp'); }
                // the current operating point against the limits
                var R = st.R, op = null;
                if (R && R.ok && R.op) {
                    var qOp = R.op.q, thpOp = R.surface && _fin(R.surface.thp_psig) ? R.surface.thp_psig : null, viol = [];
                    Object.keys(lim).forEach(function (k) { var L3 = lim[k]; if (!_fin(L3.q)) return; if (L3.kind === 'lower' ? qOp < L3.q - 1e-6 * L3.q : qOp > L3.q + 1e-6 * L3.q) viol.push(k); });
                    op = { q: qOp, thp: thpOp, pwf: _fin(R.pwf) ? R.pwf : R.op.p, inside: !viol.length, violated: viol, stable: !!R.op.stable };
                }
                if (!win.ok) warnings.push(_w('NO_WINDOW', 'The constraints leave no operating window: ' + loK.concat(hiK).map(function (k) { return lim[k].label; }).join(' vs ') + '.'));
                var res = { ok: true, curve: pts, peak: peak, max: _fin(qMax) ? { q: qMax, thp: _interp(pts.filter(function (p) { return p.ok; }), qMax, 'q', 'thp') } : null,
                    limits: lim, window: win, op: op, rateUnit: _rateUnit(t), fluidType: t, pr: pr, aof: I.aof, evals: st.evals, errors: [], warnings: warnings };
                if (gas) res.loadingProvisional = PROVISIONAL;
                return res;
        }
    }
    // a point on the envelope curve (the page's drag handle): interpolated, no solve
    function at(res, q) {
        if (!res || !res.ok || !Array.isArray(res.curve)) return null;
        var pts = res.curve.filter(function (p) { return p.ok; });
        var thp = _interp(pts, q, 'q', 'thp'), thpLine = _interp(pts, q, 'q', 'thpLine'), pwf = _interp(pts, q, 'q', 'pwf');
        if (!_fin(thp)) return null;
        var checks = Object.keys(res.limits || {}).filter(function (k) { return _fin(res.limits[k].q); }).map(function (k) {
            var L = res.limits[k]; return { key: k, label: L.label, ok: L.kind === 'lower' ? q >= L.q : q <= L.q, kind: L.kind, q: L.q };
        });
        return { q: q, thp: thp, thpLine: thpLine, pwf: pwf, chokeDp: _fin(thpLine) ? thp - thpLine : null, inside: checks.every(function (c) { return c.ok; }), checks: checks,
            ero: _interp(pts, q, 'q', 'ero'), loadMargin: _interp(pts.filter(function (p) { return _fin(p.loadMargin); }), q, 'q', 'loadMargin') };
    }

    // ── lift screening ──────────────────────────────────────────────────────
    var METHODS = [['natural', 'Natural flow'], ['gaslift', 'Gas lift (continuous)'], ['esp', 'Electrical submersible pump'], ['rod', 'Rod (beam) pump'],
        ['pcp', 'Progressing-cavity pump'], ['jet', 'Jet pump'], ['plunger', 'Plunger lift']].map(function (x) { return { key: x[0], label: x[1] }; });
    // indicative ranges (after Brown 1982; Clegg, Bucaram & Hein 1993): [ok up to, warn up to] — beyond = fail; rate [min ok, max ok, max warn]
    var RANGE = {
        gaslift: { tvd: [15000, 18000], rate: [100, 30000, 50000], inc: [70, 85], dls: [10, 15], temp: [400, 450], api: [15, 10] },
        esp: { tvd: [12000, 15000], rate: [200, 30000, 60000], inc: [80, 90], dls: [3, 6], temp: [300, 400], api: [15, 10], glr: [500, 2000] },
        rod: { tvd: [8000, 14000], rate: [5, 1000, 5000], inc: [20, 45], dls: [2, 4], temp: [500, 550], api: [8, 5], glr: [300, 1000] },
        pcp: { tvd: [5000, 9000], rate: [5, 2000, 5000], inc: [45, 80], dls: [4, 8], temp: [250, 300], api: [5, 3], glr: [300, 800] },
        jet: { tvd: [15000, 20000], rate: [300, 15000, 25000], inc: [90, 90], dls: [20, 30], temp: [500, 550], api: [8, 5] },
        plunger: { tvd: [12000, 19000], rate: [0, 200, 400], inc: [30, 60], dls: [8, 15], temp: [500, 550], api: [15, 10] }
    };
    function _wellFacts(M, o) {
        var t = _type(M), W = o.W || (_fn('WTS_wp_well.build') ? G.WTS_wp_well.build(M.well, { res: M.res, fluidType: t, surface: M.surface }) : null), R = o.R || null;
        var nd = W && W.ok ? W.nodes || {} : {}, sv = W && W.ok ? W.survey || {} : {};
        var md = _fin(nd.midPerfMd) ? nd.midPerfMd : _n(M.well.midPerfMd), tvd = _fin(nd.midPerfTvd) ? nd.midPerfTvd : md;
        var wc = _n(M.fluid.wc) || 0, gor = _n(M.fluid.gor) || 0, glr = null, qL = null;
        if (_isGas(t)) { var lg = (_n(M.fluid.cgr) || 0) + (_n(M.fluid.wgr) || 0); glr = lg > 0 ? 1e6 / lg : null; }
        else glr = gor * (1 - wc);
        if (R && R.ok && R.rates) qL = _isGas(t) ? ((_n(R.rates.qo) || 0) + (_n(R.rates.qw) || 0)) : R.rates.qL;
        var bht = W && W.ok && _fin(W.bht) ? W.bht : _n(M.res.T_F);
        return { type: t, md: md, tvd: tvd, maxInc: _fin(sv.maxInc) ? sv.maxInc : 0, maxDls: _fin(sv.maxDls) ? sv.maxDls : 0, qL: _fin(qL) ? qL : null, glr: glr, wc: wc,
            bht: bht, api: _n(M.fluid.api), h2s: _n(M.fluid.yH2S) || 0, co2: _n(M.fluid.yCO2) || 0, gasAvailable: _n(_get(M, ['lift', 'gl', 'pinj_psig'])) > 0,
            flows: !!(R && R.ok && R.op), stable: !!(R && R.ok && R.op && R.op.stable), loadingMargin: R && R.loading && _fin(R.loading.margin) ? R.loading.margin : null, W: W };
    }
    // the deepest MD interval above the perforations with dogleg ≤ dlsMax and inclination ≤ incMax (station to station)
    function _window(W, mdTop, dlsMax, incMax) {
        if (!W || !W.ok || !Array.isArray(W.stations) || W.stations.length < 2 || !_fin(mdTop) || typeof W.tvdAt !== 'function') return null;
        var st = W.stations.filter(function (s) { return s.md <= mdTop + 1e-6; });
        if (!st.length || st[st.length - 1].md < mdTop - 1e-6) st.push({ md: mdTop, tvd: W.tvdAt(mdTop), inc: ((typeof W.at === 'function' ? W.at(mdTop) : null) || {}).inc || st[st.length - 1].inc, dls: st[st.length - 1].dls || 0 });
        var bot = null, top = null;
        for (var i = st.length - 1; i >= 0; i--) {
            var s = st[i], good = (s.dls || 0) <= dlsMax + 1e-9 && (s.inc || 0) <= incMax + 1e-9;
            if (good) { if (bot == null) bot = s.md; top = s.md; }
            else if (bot != null) break;
        }
        if (bot == null) return null;
        if (top === bot && i >= 0 && st[i]) top = Math.max(st[i].md, bot - 1);
        return { md0: top, md1: bot, tvd0: W.tvdAt(top), tvd1: W.tvdAt(bot), dlsMax: dlsMax, incMax: incMax };
    }
    function matrix(M, o) {
        o = o || {};
        if (!M || !M.fluid || !M.well) return { ok: false, code: 'NO_MODEL', errors: ['the model is incomplete'], warnings: [] };
        var w = _wellFacts(M, o), gas = _isGas(w.type), out = [];
        var lvl = function (v, r, higherWorse) { if (!_fin(v)) return 'na'; if (higherWorse === false) return v >= r[0] ? 'ok' : v >= r[1] ? 'warn' : 'fail'; return v <= r[0] ? 'ok' : v <= r[1] ? 'warn' : 'fail'; };
        var depthTop = _fin(_n(M.well.perfTopMd)) ? _n(M.well.perfTopMd) : (_fin(w.md) ? w.md - 50 : null);
        var windows = { esp: _window(w.W, depthTop != null ? depthTop - 100 : null, 3, 80), rod: _window(w.W, depthTop != null ? depthTop - 50 : null, 2, 45) };
        METHODS.forEach(function (m) {
            var ch = [], add = function (key, label, st, msg) { ch.push({ key: key, label: label, st: st, msg: msg }); }, r = RANGE[m.key];
            if (m.key === 'natural') {
                add('flow', 'Flows at the model settings', w.flows ? (w.stable ? 'ok' : 'warn') : 'fail', w.flows ? (w.stable ? 'stable operating point' : 'statically unstable') : 'no operating point');
                if (gas) add('load', 'Liquid loading', w.loadingMargin == null ? 'na' : w.loadingMargin < 0 ? 'fail' : w.loadingMargin < 0.1 ? 'warn' : 'ok', w.loadingMargin == null ? 'no margin' : 'margin ' + _f(100 * w.loadingMargin) + ' %');
            } else {
                add('tvd', 'Depth (TVD)', lvl(w.tvd, r.tvd), _f(w.tvd) + ' ft TVD (' + _f(w.md) + ' ft MD)');
                if (_fin(w.qL)) { var q = w.qL, rs = q < r.rate[0] ? 'warn' : q <= r.rate[1] ? 'ok' : q <= r.rate[2] ? 'warn' : 'fail'; add('rate', 'Liquid rate', rs, _f(q) + ' STB/d'); }
                add('inc', 'Maximum inclination', lvl(w.maxInc, r.inc), _f(w.maxInc, 1) + '°');
                add('dls', 'Dogleg severity', lvl(w.maxDls, r.dls), _f(w.maxDls, 1) + '°/100 ft');
                add('temp', 'Bottom-hole temperature', lvl(w.bht, r.temp), _f(w.bht) + ' °F');
                if (!gas && _fin(w.api)) add('api', 'Oil gravity (viscosity)', lvl(w.api, r.api, false), _f(w.api, 1) + ' °API');
                if (r.glr && _fin(w.glr)) add('glr', 'Gas-liquid ratio (free gas at the pump)', lvl(w.glr, r.glr), _f(w.glr) + ' scf/STB');
                if (m.key === 'gaslift') { add('gas', 'Lift gas available', w.gasAvailable ? 'ok' : 'warn', w.gasAvailable ? 'injection pressure entered' : 'no injection pressure in step ④'); if (gas) add('fluid', 'Well type', 'warn', 'gas wells: gas lift only to unload liquids'); }
                if (m.key === 'pcp' && (w.h2s > 0.5 || w.co2 > 5)) add('elast', 'Elastomer (H₂S / CO₂)', 'warn', 'H₂S ' + _f(w.h2s, 1) + ' % · CO₂ ' + _f(w.co2, 1) + ' %');
                if (m.key === 'plunger') { var perK = _fin(w.glr) && _fin(w.tvd) && w.tvd > 0 ? w.glr / (w.tvd / 1000) : null; add('glrd', 'GLR per 1,000 ft (≥ 400 scf/STB rule)', perK == null ? 'na' : perK >= 400 ? 'ok' : perK >= 300 ? 'warn' : 'fail', perK == null ? '—' : _f(perK) + ' scf/STB per 1,000 ft'); }
                if ((m.key === 'esp' || m.key === 'rod') && _fin(depthTop)) { var wnd = windows[m.key]; add('window', 'Pump setting window', wnd ? 'ok' : 'warn', wnd ? 'MD ' + _f(wnd.md0) + '–' + _f(wnd.md1) + ' ft (TVD ' + _f(wnd.tvd0) + '–' + _f(wnd.tvd1) + ' ft)' : 'no interval above the perforations within ' + (m.key === 'esp' ? '3' : '2') + '°/100 ft'); }
                if (gas && (m.key === 'esp' || m.key === 'rod' || m.key === 'pcp')) add('fluid', 'Well type', 'warn', 'a gas well: pumps only for dewatering');
            }
            var nf = ch.filter(function (c) { return c.st === 'fail'; }).length, nw = ch.filter(function (c) { return c.st === 'warn'; }).length;
            out.push({ key: m.key, label: m.label, verdict: nf ? 'fail' : nw ? 'warn' : 'ok', checks: ch, nFail: nf, nWarn: nw, score: 100 - 40 * nf - 10 * nw });
        });
        var ranked = out.filter(function (m) { return m.key !== 'natural'; }).slice().sort(function (a, b) { return b.score - a.score; });
        ranked.forEach(function (m, i) { m.rank = i + 1; });
        var wf = Object.assign({}, w); delete wf.W;
        return { ok: true, verified: false, provisional: PROVISIONAL, source: 'indicative ranges after Brown (1982) and Clegg, Bucaram & Hein (1993)', well: wf, methods: out, windows: windows, errors: [], warnings: [] };
    }
    function screenJob(M, o) {
        o = o || {};
        if (!_fn('WTS_wp_system.solve')) return _failJob('MISSING_ENGINE', ['WTS_wp_system.solve is not available']);
        if (!M || !M.res || !M.fluid || !M.surface || !M.system) return _failJob('NO_MODEL', ['the model is incomplete']);
        var SY = G.WTS_wp_system, t = _type(M), gas = _isGas(t), st = { R: o.R && o.R.ok !== undefined ? o.R : null, gl: null, esp: null, evals: 0, glJob: null };
        var list = Array.isArray(o.qinjList) && o.qinjList.length ? o.qinjList : [0, 500, 1000, 2000, 3500];
        var pinjModel = _n(_get(M, ['lift', 'gl', 'pinj_psig'])), pinjAssumed = !(pinjModel > 0), pinj = pinjAssumed ? (_fin(_n(o.pinj)) ? _n(o.pinj) : 1000) : pinjModel;
        return _job({
            n: 3,
            next: function (i) {
                if (i === 0) { if (!st.R) { st.R = SY.solve(M); st.evals += (st.R && st.R.evals) || 0; } return false; }
                if (i === 1) {
                    if (gas || t === 'waterinj' || t === 'gasinj' || !_fn('WTS_wp_gl.glpc')) { st.gl = { ok: false, code: gas ? 'GL_NOT_APPLICABLE' : 'MISSING_ENGINE', error: gas ? 'the gas-lift rate comparison is for oil (and water) producers' : 'the gas-lift engine is not available' }; return false; }
                    var Mg = _clone(M); Mg.lift = Mg.lift || {}; Mg.lift.gl = Object.assign({}, Mg.lift.gl || {}, { pinj_psig: pinj }); Mg.lift.type = 'gaslift';
                    var j = G.WTS_wp_gl.glpc(Mg, { qinjList: list }), s, k = 0; do { s = j.step(); k++; } while (!s.done && k < 200);
                    var g = j.result(); st.evals += (g && g.evals) || 0;
                    st.gl = g && g.optimum ? { ok: true, qinj: g.optimum.qinj, qL: g.optimum.qL, natural: g.natural, gain: g.gain, pinj_psig: pinj, assumedPinj: pinjAssumed, points: (g.points || []).map(function (p) { return { qinj: p.qinj, qL: p.qL, ok: p.ok }; }) }
                        : { ok: false, code: (g && g.code) || 'NO_FLOW', error: (g && g.errors && g.errors[0]) || 'no lifted rate', pinj_psig: pinj, assumedPinj: pinjAssumed };
                    return false;
                }
                // ESP: only when the solver answers with an ESP lift result (the ESP engine of this increment); never the natural-flow number
                var Me = _clone(M); Me.lift = Me.lift || {}; Me.lift.type = 'esp';
                var Re = (Me.lift.esp || G.WTS_wp_esp) ? SY.solve(Me) : null;
                if (Re) st.evals += Re.evals || 0;
                st.esp = Re && Re.ok && Re.lift && Re.lift.type === 'esp' ? { ok: true, available: true, q: Re.op.q, qL: Re.rates && Re.rates.qL, pwf: Re.pwf }
                    : { ok: false, available: !!G.WTS_wp_esp, code: Re && Re.code ? Re.code : 'ESP_NOT_AVAILABLE', error: G.WTS_wp_esp ? ((Re && Re.errors && Re.errors[0]) || 'enter the pump (step ④, ESP) for a sized rate') : 'the ESP engine is not part of this build: the inflow potential below is the most any pump can lift' };
                return true;
            },
            label: function (i) { return ['natural flow', 'gas lift (performance curve)', 'ESP'][Math.min(i, 2)]; },
            finish: function () {
                var R = st.R, F = _fn('WTS_wp_fluid.build') ? G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F }) : null, I = F && F.ok && _fn('WTS_wp_ipr.curve') ? G.WTS_wp_ipr.curve(M.res, F) : null;
                var pr = _n(M.res.pr), pwfMin = _fin(_n(o.pwfMin)) ? _n(o.pwfMin) : (_fin(pr) ? Math.max(200, 0.1 * pr) : null);
                var pot = I && I.ok && _fin(pwfMin) && pwfMin < pr ? { q: I.qAt(pwfMin), pwf: pwfMin } : null;
                var nat = R && R.ok && R.op ? { ok: true, q: R.op.q, qL: R.rates && R.rates.qL, qg: R.rates && R.rates.qg, stable: !!R.op.stable } : { ok: false, error: (R && R.errors && R.errors[0]) || 'no operating point' };
                var mx = matrix(M, { R: R });
                return { ok: true, natural: nat, gaslift: st.gl, esp: st.esp, potential: pot, matrix: mx, rateUnit: _rateUnit(t), evals: st.evals, verified: false, provisional: PROVISIONAL, errors: [], warnings: st.gl && st.gl.assumedPinj && st.gl.ok ? [_w('PINJ_ASSUMED', 'No injection pressure in step ④: the gas-lift rate uses a screening casing pressure of ' + _f(pinj) + ' psig.', 'info')] : [] };
            }
        });
    }

    var NS = G.WTS_wp_envelope = G.WTS_wp_envelope || {};
    NS.job = envJob; NS.at = at; NS.FRACS = FRACS.slice();
    var SC = G.WTS_wp_screen = G.WTS_wp_screen || {};
    SC.PROVISIONAL = PROVISIONAL; SC.METHODS = METHODS; SC.RANGE = RANGE; SC.matrix = matrix; SC.job = screenJob; SC._window = _window;
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis, E = G.WTS_wp_envelope, S = G.WTS_wp_screen, bad = [];
    if (!E || typeof E.job !== 'function' || typeof E.at !== 'function' || !S || typeof S.matrix !== 'function' || typeof S.job !== 'function') bad.push('namespace');
    else {
        var r = { ok: true, curve: [{ q: 0, thp: 100, thpLine: 50, ok: true }, { q: 100, thp: 50, thpLine: 60, ok: true }], limits: {} };
        var a = E.at(r, 50); if (!a || Math.abs(a.thp - 75) > 1e-9 || Math.abs(a.chokeDp - 20) > 1e-9) bad.push('at');
    }
    if (bad.length && typeof console !== 'undefined') console.error('[49-calc-wp-envelope.js self-test] ' + bad.join('; '));
})();
