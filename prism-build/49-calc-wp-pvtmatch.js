// =============================================================================
// WTS — 49-calc-wp-pvtmatch.js  (Round 9; helper module: no page in window.WTS_calcRegistry)
// -----------------------------------------------------------------------------
// Well Performance PVT lab match, modified black oil (Rv) and emulsion helpers — docs/WELL-PERFORMANCE-PLAN.md §5.1, §1.4 (B4, B5,
// B7), §3.1 (fluid.match), §3.11 (wts_wellperf_model.lab), US14 (WP23, increment B).
//
// The module evaluates no fluid property itself: every value comes from WTS_wp_fluid.build → WTS_flowline_props (the one property
// path of the march), so the matched set this module fits is exactly the set the rest of the module uses.
//
// PVT lab match (§5.1). Per property y ∈ {Rs, Bo, μo} two parameters, a multiplier a and a shift b: y_matched = a·y_corr + b, fitted
// by PRiSM_lm (05-regression) on the relative residuals (weights 1 / y_lab²); the bubble point is one value, so it is the one-point
// factor of A1 (Rs evaluated at p·f, f = Pb_corr(Rsb, T_lab) / Pb_lab). The fits run in order Pb → Rs → Bo → μo, each on the model
// already matched by the previous ones (Bo below pb depends on the matched Rs, μo on the matched Rs). One lab point → a only (b held
// at 0). The lab oil is the lab's own: its solution GOR Rsb (the flash Rsb when given, else the highest lab Rs) at the lab temperature;
// the well then uses the same multipliers with its producing GOR at every temperature (an assumption, stated in the Notes).
// Differential liberation → flash (the standard adjustment with the separator-test Bob and Rsb, labelled provisional — D17 / Q9):
//   p ≤ pb: Bo_f = Bo_d·(Bob_f / Bob_d), Rs_f = Rsb_f − (Rsb_d − Rs_d)·(Bob_f / Bob_d);  p > pb: Bo_f = Bo_d·(Bob_f / Bob_d), Rs_f = Rsb_f.
// Ranking: every black-oil family (Pb / Rs / Bo) by the mean absolute relative error (MARE, %) of its unmatched values against the
// lab table, and every dead / live viscosity pair by its μo MARE on the matched Rs of the selected family.
//
// Interfaces (field units, §3.0; every result {ok, errors[], warnings[{code, msg, sev}], …}; nothing throws for user data):
//   WTS_wp_pvtmatch
//     .normLab(lab)              → {ok, lab:{T_F, basis, pb, rsbF, bobF, rows:[{p, rs, bo, muo}] ascending p, rv:[[p, rv]], emul:[[fw, r]]},
//                                   errors, warnings}
//     .diffToFlash(lab)          → {ok, applied, factor, rsbD, bobD, rows (flash basis), warnings}
//     .labOil(spec, lab)         the fluid spec of the lab oil (gor = Rsb, no water, no user pb, no match)
//     .predict(spec, lab, match?, pList?) → {ok, rows:[{p, rs, bo, muo}], pb, F}  (the matched set when match is given)
//     .fit(spec, lab, o?)        → {ok, corr:{rs, bo, muod, muo}, rsb, T_F, basis, flash, pb:{lab, corr, after, factor, errPct},
//                                   props:{rs|bo|muo: {n, a, b, ci95:{a, b}, mareBefore, mareAfter, converged, iterations, fixedB}},
//                                   match:{on:true, pbFactor, mult:{rs, bo, muo}, shift:{rs, bo, muo}, corr, T_F, mare, ts},
//                                   points:[{p, lab:{rs, bo, muo}, before:{…}, after:{…}}], flags[{code, sev, msg}], warnings, provisional}
//                                o.props = subset of ['rs', 'bo', 'muo'] (default all with lab values)
//     .rank(spec, lab, o?)       → {ok, families:[{key, label, verified, pbErrPct, mare:{rs, bo}, score, after:{rs, bo}}] sorted by score,
//                                   viscosity:[{muod, muo, label, verified, mare}] sorted}
//     .job(spec, lab, o?)        → Job for PRiSM_autoInterp.drive (step / done / progress / result / cancel); result() = {ok, fit, rank,
//                                   evals (property evaluations)}
//     .applyTo(spec, match)      spec with fluid.match = the adopted match (the page writes lab.adopt through WTS_wp_model)
//     .preview(spec, lab, base, edit)  the fit's points re-evaluated with the multipliers of one property edited by hand (drag rails)
//     .example(spec, T_F)        a synthetic lab table for the page example (a known distortion of the Standing family; flagged
//                                example:true — never presented as measured data)
//     .exampleRv(cgr, pd) / .exampleEmul()   example Rv and emulsion tables
//     .emulsion(fw, muo, muw, e) = WTS_flowline_emulsion (the march's own function); .rvAt(rv, p, cgr) = WTS_flowline_rvAt
//     .emulCurve(e, {muo, muw, n}) → [{fw, ratio, cont}] (0 … 1); .rvCurve(rv, cgr, {pMax, n}) → [{p, rv, free}]
//     .METHODS   {pvtmatch, diffFlash, rv, woelflin, brinkman, table}: {label, verified, provisional, note}
// =============================================================================
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var PROV = 'provisional — not verified against a published example';
    var PROPS = ['rs', 'bo', 'muo'];
    var MAX_ROWS = 60;
    var BOUNDS = { rs: { a: [0.5, 2], b: null }, bo: { a: [0.8, 1.25], b: [-0.3, 0.3] }, muo: { a: [0.2, 5], b: null } };
    var BAND = { ok: [0.9, 1.1], warn: [0.8, 1.25] };            // multiplier a: inside 0.9–1.1 fine; outside 0.8–1.25 the correlation is stretched
    var METHODS = {
        pvtmatch: { label: 'Lab match (multiplier and shift, Levenberg-Marquardt)', verified: true, note: 'least squares on the lab points (no published example needed)' },
        diffFlash: { label: 'Differential liberation to flash adjustment (separator Bob / Rsb)', verified: false, provisional: PROV },
        rv: { label: 'Modified black oil (vaporised oil-gas ratio Rv)', verified: false, provisional: PROV },
        woelflin: { label: 'Woelflin (1942) emulsion curves — chart readings', verified: false, provisional: PROV, note: 'chart readings to verify against the published figure (owner Q9)' },
        brinkman: { label: 'Brinkman (1952) emulsion viscosity', verified: false, provisional: PROV },
        table: { label: 'User emulsion table (μ_em / μo against the water fraction)', verified: true, note: 'user data' }
    };

    function _fin(v) { return typeof v === 'number' && isFinite(v); }
    function _num(v) { if (v === '' || v == null) return null; var n = Number(v); return _fin(n) ? n : null; }
    function _isObj(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
    function _clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
    function _w(code, msg, sev) { return { code: code, msg: String(msg).slice(0, 299), sev: sev || 'warn' }; }
    function _f(v, d) { return _fin(v) ? Number(v).toFixed(d == null ? 2 : d).replace(/\.?0+$/, function (m) { return m.indexOf('.') === 0 ? '' : m; }) : '—'; }
    function _fail(code, msg, extra) { var o = { ok: false, code: code, errors: [msg], warnings: [] }; if (extra) Object.keys(extra).forEach(function (k) { o[k] = extra[k]; }); return o; }
    function _interp(xs, ys, x) {
        var n = xs.length; if (!n) return null;
        if (n === 1 || x <= xs[0]) return ys[0];
        if (x >= xs[n - 1]) return ys[n - 1];
        for (var i = 1; i < n; i++) if (x <= xs[i]) return ys[i - 1] + (ys[i] - ys[i - 1]) * (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
        return ys[n - 1];
    }

    // ── lab record ─────────────────────────────────────────────────────────────
    function normLab(lab) {
        var L = _isObj(lab) ? lab : {}, errors = [], warnings = [];
        var T = _num(L.T_F), pb = _num(L.pb), rsbF = _num(L.rsbF), bobF = _num(L.bobF);
        if (!(_fin(T) && T >= 40 && T <= 450)) errors.push('The lab temperature is needed (40–450 °F).');
        if (pb != null && !(pb > 14.7 && pb <= 15000)) { warnings.push(_w('LAB_PB', 'The lab bubble point must be above 14.7 psia: ignored.')); pb = null; }
        var rows = [], seen = {};
        (Array.isArray(L.rows) ? L.rows : []).forEach(function (r) {
            if (!_isObj(r) && !Array.isArray(r)) return;
            var o = Array.isArray(r) ? { p: _num(r[0]), rs: _num(r[1]), bo: _num(r[2]), muo: _num(r[3]) } : { p: _num(r.p), rs: _num(r.rs), bo: _num(r.bo), muo: _num(r.muo) };
            if (!(_fin(o.p) && o.p > 0 && o.p <= 20000)) return;
            if (o.rs != null && !(o.rs >= 0 && o.rs <= 10000)) o.rs = null;
            if (o.bo != null && !(o.bo >= 0.8 && o.bo <= 5)) o.bo = null;
            if (o.muo != null && !(o.muo > 0 && o.muo <= 1e5)) o.muo = null;
            if (o.rs == null && o.bo == null && o.muo == null) return;
            var k = String(Math.round(o.p * 1000));
            if (seen[k]) { warnings.push(_w('LAB_DUP', 'Two lab rows at ' + _f(o.p, 1) + ' psia: the first is kept.', 'info')); return; }
            seen[k] = 1; rows.push(o);
        });
        rows.sort(function (a, b) { return a.p - b.p; });
        if (rows.length > MAX_ROWS) { rows = rows.slice(0, MAX_ROWS); warnings.push(_w('LAB_ROWS', 'Only the first ' + MAX_ROWS + ' lab rows are used.', 'info')); }
        if (!rows.length) errors.push('Enter at least one lab row (pressure with Rs, Bo or μo).');
        var basis = L.basis === 'differential' ? 'differential' : 'flash';
        var rv = (Array.isArray(L.rv) ? L.rv : []).map(function (r) { return Array.isArray(r) ? [_num(r[0]), _num(r[1])] : null; })
            .filter(function (r) { return r && _fin(r[0]) && r[0] > 0 && _fin(r[1]) && r[1] >= 0; }).sort(function (a, b) { return a[0] - b[0]; }).slice(0, MAX_ROWS);
        var emul = (Array.isArray(L.emul) ? L.emul : []).map(function (r) { return Array.isArray(r) ? [_num(r[0]), _num(r[1])] : null; })
            .filter(function (r) { return r && _fin(r[0]) && r[0] >= 0 && r[0] <= 1 && _fin(r[1]) && r[1] > 0; }).sort(function (a, b) { return a[0] - b[0]; }).slice(0, MAX_ROWS);
        return { ok: errors.length === 0, lab: { T_F: T, basis: basis, pb: pb, rsbF: rsbF, bobF: bobF, rows: rows, rv: rv, emul: emul, example: !!L.example },
            errors: errors, warnings: warnings };
    }
    function _labAt(rows, key, p) {
        var r = rows.filter(function (x) { return _fin(x[key]); });
        return r.length ? _interp(r.map(function (x) { return x.p; }), r.map(function (x) { return x[key]; }), p) : null;
    }
    function diffToFlash(lab) {
        var n = normLab(lab);
        if (!n.ok) return { ok: false, errors: n.errors, warnings: n.warnings, rows: [] };
        var L = n.lab, warnings = [];
        if (L.basis !== 'differential') return { ok: true, applied: false, factor: 1, rows: _clone(L.rows), warnings: warnings };
        var pb = L.pb;
        if (!_fin(pb)) { warnings.push(_w('DIFF_NO_PB', 'Differential liberation data need the lab bubble point for the flash adjustment: the table is used as entered.')); return { ok: true, applied: false, factor: 1, rows: _clone(L.rows), warnings: warnings }; }
        var bobD = _labAt(L.rows, 'bo', pb), rsbD = _labAt(L.rows, 'rs', pb);
        if (!(_fin(L.bobF) && L.bobF > 0.8 && _fin(L.rsbF) && L.rsbF > 0 && _fin(bobD) && bobD > 0 && _fin(rsbD))) {
            warnings.push(_w('DIFF_NO_SEP', 'Differential liberation data without the separator-test Bob and Rsb (or without Bo and Rs at the bubble point): the table is used as entered, not adjusted to flash.'));
            return { ok: true, applied: false, factor: 1, rows: _clone(L.rows), warnings: warnings };
        }
        var k = L.bobF / bobD, neg = 0;
        var rows = L.rows.map(function (r) {
            var o = { p: r.p, rs: r.rs, bo: _fin(r.bo) ? r.bo * k : null, muo: r.muo };
            if (_fin(r.rs)) {
                o.rs = r.p <= pb ? L.rsbF - (rsbD - r.rs) * k : L.rsbF;
                if (o.rs < 0) { neg++; o.rs = 0; }
            }
            return o;
        });
        if (neg) warnings.push(_w('DIFF_NEG_RS', neg + ' adjusted Rs value(s) fell below zero and were set to 0: check the separator Rsb.'));
        warnings.push(_w('DIFF_FLASH', 'Differential liberation adjusted to flash with Bob_f / Bob_d = ' + _f(k, 4) + ' — ' + PROV + '.', 'info'));
        return { ok: true, applied: true, factor: k, rsbD: rsbD, bobD: bobD, rows: rows, warnings: warnings };
    }

    // ── the lab oil and its predicted (optionally matched) properties ─────────
    function _rsb(L, rows) {
        if (_fin(L.rsbF) && L.rsbF > 0 && L.basis === 'flash') return L.rsbF;
        if (L.basis === 'differential' && _fin(L.rsbF) && L.rsbF > 0) return L.rsbF;
        var rs = rows.map(function (r) { return r.rs; }).filter(_fin);
        return rs.length ? Math.max.apply(null, rs) : null;
    }
    function labOil(spec, lab, rsb) {
        var s = _clone(spec || {}) || {};
        s.type = 'oil'; s.wc = 0; s.pbUser = null; s.match = null; s.rv = null; s.emul = null;
        if (_fin(rsb) && rsb > 0) s.gor = rsb;
        return s;
    }
    function _build(spec, T, match) {
        var W = G.WTS_wp_fluid; if (!W || typeof W.build !== 'function') return null;
        var s = _clone(spec);
        if (match) s.match = { on: true, pbFactor: match.pbFactor, mult: match.mult, shift: match.shift, rsPb: match.rsPb || null, corr: match.corr || null };
        return W.build(s, { T_F: T, table: false });
    }
    function _corrOf(spec) { var c = (spec && spec.corr) || {}; return { rs: c.rs || 'standing', bo: c.bo || 'standing', muod: c.muod || 'beggsRobinson', muo: c.muo || 'beggsRobinson' }; }
    var _evals = 0;
    function _props(F, ps, T, rsb) {
        return ps.map(function (p) {
            _evals++;
            var r = F.at(p, T, { qo: 1000, qw: 0, qg_Mscfd: rsb });
            return r ? { p: p, rs: r.rs, bo: r.bo, muo: r.muo } : { p: p, rs: null, bo: null, muo: null };
        });
    }
    function predict(spec, lab, match, pList) {
        var n = normLab(lab); if (!n.ok) return { ok: false, errors: n.errors, warnings: n.warnings, rows: [] };
        var L = n.lab, fl = diffToFlash(L), rows = fl.rows, rsb = _rsb(L, rows), base = labOil(spec, L, rsb);
        if (!_fin(base.gor)) return _fail('NO_RSB', 'The lab oil needs its solution GOR (flash Rsb or the lab Rs values).');
        var F = _build(base, L.T_F, match || null);
        if (!F || !F.ok) return _fail('NO_FLUID', ((F && F.errors) || ['the fluid engine is not available'])[0]);
        var ps = Array.isArray(pList) ? pList.filter(function (p) { return _fin(p) && p > 0; }) : rows.map(function (r) { return r.p; });
        return { ok: true, rows: _props(F, ps, L.T_F, base.gor), pb: F.pb(L.T_F), F: F, rsb: base.gor, errors: [], warnings: fl.warnings.slice() };
    }

    // ── fits ───────────────────────────────────────────────────────────────────
    function _mare(pts, key, which) {
        var s = 0, n = 0;
        pts.forEach(function (q) { var y = q.lab[key], m = q[which] && q[which][key]; if (_fin(y) && y > 0 && _fin(m)) { s += Math.abs(m / y - 1); n++; } });
        return n ? 100 * s / n : null;
    }
    // closed-form relative (1 / y²) weighted least squares of y ≈ a·yc + b (b = 0 when fixB) — the cross-check of the LM fit (X22)
    // xb (optional): the regressor of b per point (the Rs shift tapers as min(1, p / pb_lab); default 1)
    function wls(yc, y, fixB, xb) {
        var n = y.length, Sw = 0, Sx = 0, Sy = 0, Sxx = 0, Sxy = 0;
        for (var i = 0; i < n; i++) { var w = 1 / (y[i] * y[i]), u = xb ? xb[i] : 1; Sw += w * u * u; Sx += w * yc[i] * u; Sy += w * y[i] * u; Sxx += w * yc[i] * yc[i]; Sxy += w * yc[i] * y[i]; }
        if (!(Sxx > 0)) return null;
        if (fixB || n < 2) return { a: Sxy / Sxx, b: 0 };
        var det = Sw * Sxx - Sx * Sx; if (!(Math.abs(det) > 1e-300)) return { a: Sxy / Sxx, b: 0 };
        return { a: (Sw * Sxy - Sx * Sy) / det, b: (Sxx * Sy - Sx * Sxy) / det };
    }
    function _lmFit(yc, y, bnd, fixB, xb) {
        // relative least squares of y ≈ a·yc + b with PRiSM_lm; one point → a only
        var LM = G.PRiSM_lm;
        if (typeof LM !== 'function') return { ok: false, code: 'MISSING_ENGINE', name: 'PRiSM_lm' };
        var n = y.length, T = [], P = [], Wt = [];
        for (var i = 0; i < n; i++) { T.push(i); P.push(y[i]); Wt.push(1 / Math.max(1e-12, y[i] * y[i])); }
        if (n === 1) { T.push(0); P.push(y[0]); Wt.push(0); }
        var yMax = Math.max.apply(null, y.map(Math.abs).concat([1e-9]));
        var bB = bnd.b || [-0.5 * yMax, 0.5 * yMax];
        var a0 = 1;
        var model = function (tt, pr) { return tt.map(function (k) { return pr.a * yc[k] + pr.b * (xb ? xb[k] : 1); }); };
        var lm;
        try {
            lm = LM(model, { t: T, p: P, weights: Wt }, { a: a0, b: 0 }, { a: bnd.a, b: bB }, fixB ? { b: true } : null,
                { maxIter: 60, tolerance: 1e-12, gtol: 1e-14, derivStep: 1e-6 });
        } catch (e) { return { ok: false, code: 'LM_FAILED', msg: String(e && e.message || e).slice(0, 200) }; }
        var a = Math.min(bnd.a[1], Math.max(bnd.a[0], +lm.params.a)), b = fixB ? 0 : Math.min(bB[1], Math.max(bB[0], +lm.params.b));
        // the problem is linear in (a, b): the closed-form weighted least squares is the optimality check of the LM answer (an LM stop on
        // its damping limit at the noise floor of rounded lab values is still the optimum when the objectives agree)
        var cf = wls(yc, y, fixB, xb), ssr = function (aa, bb) { var t = 0; for (var j = 0; j < n; j++) { var e = (aa * yc[j] + bb * (xb ? xb[j] : 1) - y[j]) / y[j]; t += e * e; } return t; };
        var sL = ssr(a, b), sC = cf ? ssr(cf.a, cf.b) : null, inB = cf && cf.a >= bnd.a[0] && cf.a <= bnd.a[1] && (fixB || (cf.b >= bB[0] && cf.b <= bB[1]));
        var conv = !!lm.converged || (inB && Math.abs(sL - sC) <= 1e-9 * sC + 1e-18);
        return { ok: true, a: a, b: b, lm: lm, ci95: lm.ci95 || null, converged: conv, stopReason: lm.stopReason, iterations: lm.iterations, nEval: lm.nEval, bBounds: bB, cf: cf, ssr: sL };
    }
    function fit(spec, lab, o) {
        o = o || {};
        var n = normLab(lab); if (!n.ok) return { ok: false, code: 'BAD_LAB', errors: n.errors, warnings: n.warnings };
        if (!G.WTS_wp_fluid || typeof G.WTS_wp_fluid.build !== 'function') return _fail('MISSING_ENGINE', 'WTS_wp_fluid is not loaded', { name: 'WTS_wp_fluid' });
        if (typeof G.PRiSM_lm !== 'function') return _fail('MISSING_ENGINE', 'PRiSM_lm (Levenberg-Marquardt) is not available', { name: 'PRiSM_lm' });
        if (spec && spec.type && spec.type !== 'oil') return _fail('NOT_OIL', 'The black-oil lab match applies to an oil.');
        var L = n.lab, warnings = n.warnings.slice(), flags = [];
        var fl = diffToFlash(L); warnings = warnings.concat(fl.warnings);
        var rows = fl.rows, rsb = _rsb(L, rows), T = L.T_F, corr = _corrOf(spec);
        if (!(_fin(rsb) && rsb > 0)) return _fail('NO_RSB', 'The lab oil needs its solution GOR: enter the flash Rsb or Rs values in the table.', { warnings: warnings });
        var base = labOil(spec, L, rsb);
        var F0 = _build(base, T, null);
        if (!F0 || !F0.ok) return _fail('NO_FLUID', ((F0 && F0.errors) || ['the fluid could not be built'])[0], { warnings: warnings });
        var want = Array.isArray(o.props) ? o.props.filter(function (k) { return PROPS.indexOf(k) !== -1; }) : PROPS.slice();
        var ps = rows.map(function (r) { return r.p; });
        var before = _props(F0, ps, T, rsb);
        var pts = rows.map(function (r, i) { return { p: r.p, lab: { rs: r.rs, bo: r.bo, muo: r.muo }, before: before[i], after: null }; });
        // 1. the bubble point (one value → the one-point factor of A1)
        var pbCorr = F0.pb(T), pbOut = { lab: L.pb, corr: pbCorr, after: null, factor: 1, errPct: null };
        var match = { on: true, pbFactor: 1, mult: { rs: 1, bo: 1, muo: 1 }, shift: { rs: 0, bo: 0, muo: 0 }, corr: corr, T_F: T, rsPb: _fin(L.pb) ? L.pb : null };
        if (_fin(L.pb) && _fin(pbCorr) && pbCorr > 14.7) { match.pbFactor = pbCorr / L.pb; pbOut.factor = match.pbFactor; pbOut.errPct = 100 * (pbCorr / L.pb - 1); }
        else if (_fin(L.pb)) warnings.push(_w('PB_NOT_MATCHED', 'The correlation bubble point could not be evaluated: the lab bubble point is not matched.'));
        else warnings.push(_w('PB_NO_LAB', 'No lab bubble point: the bubble point is not matched (Rs, Bo and μo are).', 'info'));
        var props = {};
        // 2–4. Rs (below pb only), Bo, μo — each on the model matched so far. Rs and the bubble-point factor are solved together as a
        // fixed point: Rs_m(p) = a·Rs_c(p·f) + b, and f such that the matched Rs reaches Rsb at the lab pb (f = Pb_c((Rsb − b)/a) / Pb_lab)
        var pbLab = _fin(L.pb) ? L.pb : null, rsIter = 0;
        ['rs', 'bo', 'muo'].forEach(function (k) {
            if (want.indexOf(k) === -1) return;
            var F = _build(base, T, match), cur = _props(F, ps, T, rsb), idx = [];
            if (k === 'rs') { var mr = _clone(match); mr.mult.rs = 1; mr.shift.rs = 0; F = _build(base, T, mr); cur = _props(F, ps, T, rsb); }
            pts.forEach(function (q, i) {
                var y = q.lab[k];
                if (!_fin(y) || !(y > 0) || !_fin(cur[i][k])) return;
                if (k === 'rs' && ((pbLab != null && q.p > pbLab * (1 + 1e-9)) || (pbLab == null && y >= rsb * 0.999))) return;   // Rs above pb is Rsb by definition
                if (k === 'rs' && pbLab != null && y >= rsb * 0.999 && q.p >= pbLab * 0.995) return;   // the lab pb point itself (Rs = Rsb) carries no slope
                idx.push(i);
            });
            if (!idx.length) return;
            var yc = idx.map(function (i) { return cur[i][k]; }), y = idx.map(function (i) { return pts[i].lab[k]; });
            var fixB = idx.length < 2 || o.fixB === true;
            var xb = (k === 'rs' && match.rsPb) ? idx.map(function (i) { return Math.min(1, pts[i].p / match.rsPb); }) : null;
            var r = _lmFit(yc, y, BOUNDS[k], fixB, xb);
            if (k === 'rs' && r.ok && pbLab != null && match.pbFactor !== 1) {
                // g(f) = f(a, b refitted at f) − f, solved by the secant method (Rs_c(p·f)·a is nearly a power law, so a plain fixed point
                // creeps); the refit at the root is the answer
                var gOf = function (fv) {
                    var mr2 = _clone(match); mr2.pbFactor = fv; mr2.mult.rs = 1; mr2.shift.rs = 0;
                    var cur2 = _props(_build(base, T, mr2), ps, T, rsb), yc2 = idx.map(function (i) { return cur2[i].rs; });
                    if (!yc2.every(_fin)) return null;
                    var r2 = _lmFit(yc2, y, BOUNDS.rs, fixB, xb); if (!r2.ok) return null;
                    var Fp = _build(base, T, { pbFactor: 1, mult: { rs: r2.a, bo: 1, muo: 1 }, shift: { rs: r2.b, bo: 0, muo: 0 }, rsPb: match.rsPb, corr: corr }), pbm = Fp && Fp.ok ? Fp.pb(T) : null;
                    return _fin(pbm) ? { f: fv, g: pbm / pbLab - fv, r: r2, yc: yc2 } : null;
                };
                var e0 = gOf(match.pbFactor), e1 = e0 ? gOf(e0.f + e0.g) : null;
                for (rsIter = 2; e0 && e1 && rsIter < 30; rsIter++) {
                    if (Math.abs(e1.g) < 1e-12 * e1.f || e1.g === e0.g) break;
                    var fn = e1.f - e1.g * (e1.f - e0.f) / (e1.g - e0.g);
                    if (!(fn > 0.2 && fn < 5)) break;
                    var en = gOf(fn); if (!en) break;
                    e0 = e1; e1 = en;
                }
                var best = e1 || e0;
                if (best) { match.pbFactor = best.f; r = best.r; yc = best.yc; }
                pbOut.factor = match.pbFactor;
            }
            if (!r.ok) { warnings.push(_w('LM_' + k.toUpperCase(), (k === 'rs' ? 'Rs' : k === 'bo' ? 'Bo' : 'μo') + ': the fit failed (' + (r.msg || r.code) + ').')); return; }
            match.mult[k] = r.a; match.shift[k] = r.b;
            props[k] = { n: idx.length, a: r.a, b: r.b, iter: k === 'rs' ? rsIter : undefined, ci95: r.ci95 ? { a: r.ci95.a || null, b: fixB ? null : (r.ci95.b || null) } : null, converged: r.converged,
                iterations: r.iterations, nEval: r.nEval, stopReason: r.stopReason, cf: r.cf, yc: yc.slice(), y: y.slice(), xb: xb ? xb.slice() : null, fixedB: fixB, used: idx.map(function (i) { return pts[i].p; }) };
            var lab = k === 'rs' ? 'Rs' : k === 'bo' ? 'Bo' : 'μo';
            if (r.a < BAND.warn[0] || r.a > BAND.warn[1]) flags.push(_w('MULT_' + k.toUpperCase(), lab + ' multiplier ' + _f(r.a, 3) + ' is outside 0.8–1.25: the correlation is stretched far — try the family ranked first.', 'fail'));
            else if (r.a < BAND.ok[0] || r.a > BAND.ok[1]) flags.push(_w('MULT_' + k.toUpperCase(), lab + ' multiplier ' + _f(r.a, 3) + ' is outside 0.9–1.1.', 'warn'));
            if (Math.abs(r.a - BOUNDS[k].a[0]) < 1e-9 || Math.abs(r.a - BOUNDS[k].a[1]) < 1e-9) flags.push(_w('BOUND_' + k.toUpperCase(), lab + ' multiplier at its bound ' + _f(r.a, 3) + ': the correlation cannot follow the lab data.', 'fail'));
            if (!r.converged && idx.length > 1) flags.push(_w('NOCONV_' + k.toUpperCase(), lab + ': the fit did not converge.', 'warn'));
        });
        var Fm = _build(base, T, match), after = _props(Fm, ps, T, rsb);
        pts.forEach(function (q, i) { q.after = after[i]; });
        pbOut.after = Fm.pb(T);
        var mare = {};
        PROPS.forEach(function (k) {
            var b0 = _mare(pts, k, 'before'), a0 = props[k] ? _mare(pts, k, 'after') : null;
            if (props[k]) { props[k].mareBefore = b0; props[k].mareAfter = a0; }
            mare[k] = { before: b0, after: props[k] ? a0 : b0 };
        });
        match.mare = mare; match.ts = Date.now();
        if (pbLab != null && _fin(pbOut.after) && Math.abs(pbOut.after / pbLab - 1) > 0.02)
            flags.push(_w('PB_AFTER', 'With the matched Rs the bubble point of the lab oil is ' + _f(pbOut.after, 0) + ' psia against the lab ' + _f(pbLab, 0) + ' psia: the Rs points near pb do not follow the lab pb.', 'warn'));
        if (L.example) flags.push(_w('EXAMPLE', 'Example lab data (synthetic, for trying the page) — not a measured lab report.', 'info'));
        if (!Object.keys(props).length && !(match.pbFactor !== 1)) return _fail('NOTHING', 'Nothing to match: the lab table has no usable Rs, Bo or μo values and no bubble point.', { warnings: warnings });
        var provisional = fl.applied ? [METHODS.diffFlash.label] : [];
        return { ok: true, corr: corr, rsb: rsb, T_F: T, basis: L.basis, flash: { applied: !!fl.applied, factor: fl.factor || 1, rsbD: fl.rsbD || null, bobD: fl.bobD || null },
            pb: pbOut, props: props, match: match, points: pts, flags: flags, warnings: warnings, errors: [], provisional: provisional, example: !!L.example };
    }

    // ── a hand edit of one property's a / b (the page's drag rails): the points re-evaluated on the matched model ──
    function preview(spec, lab, base, edit) {
        if (!base || !base.ok || !base.match) return null;
        var n = normLab(lab); if (!n.ok) return null;
        var L = n.lab, fl = diffToFlash(L), rows = fl.rows, m = _clone(base.match);
        if (edit && PROPS.indexOf(edit.key) !== -1) { if (_fin(edit.a)) m.mult[edit.key] = edit.a; if (_fin(edit.b)) m.shift[edit.key] = edit.b; }
        var F = _build(labOil(spec, L, base.rsb), L.T_F, m); if (!F || !F.ok) return null;
        var after = _props(F, rows.map(function (r) { return r.p; }), L.T_F, base.rsb);
        var pts = base.points.map(function (q, i) { return { p: q.p, lab: q.lab, before: q.before, after: after[i] }; }), mare = {};
        PROPS.forEach(function (k) { mare[k] = _mare(pts, k, 'after'); });
        return { match: m, points: pts, mare: mare, pb: F.pb(L.T_F), F: F };
    }

    // ── ranking of the families and viscosity pairs ────────────────────────────
    function _fams(slot) { var W = G.WTS_wp_fluid; try { return (W && typeof W.families === 'function') ? W.families(slot) : []; } catch (e) { return []; } }
    function _famList() { var bo = _fams('bo'); return _fams('rs').filter(function (o) { return bo.some(function (b) { return b.key === o.key; }); }); }
    function _rankFamily(spec, lab, key, label, verified) {
        var c = Object.assign({}, (spec && spec.corr) || {}, { pb: key, rs: key, bo: key });
        var s = Object.assign({}, spec, { corr: c });
        var r = fit(s, lab, { props: ['rs', 'bo'] });
        if (!r.ok) return { key: key, label: label, verified: verified, ok: false, errors: r.errors };
        var mb = [r.props.rs ? r.props.rs.mareBefore : _mare(r.points, 'rs', 'before'), r.props.bo ? r.props.bo.mareBefore : _mare(r.points, 'bo', 'before')];
        var parts = mb.filter(_fin).concat(_fin(r.pb.errPct) ? [Math.abs(r.pb.errPct)] : []);
        return { key: key, label: label, verified: verified, ok: true, pbErrPct: r.pb.errPct, mare: { rs: mb[0], bo: mb[1] },
            after: { rs: r.props.rs ? r.props.rs.mareAfter : null, bo: r.props.bo ? r.props.bo.mareAfter : null }, mult: { rs: r.match.mult.rs, bo: r.match.mult.bo },
            score: parts.length ? parts.reduce(function (a, b) { return a + b; }, 0) / parts.length : null };
    }
    function _rankVisc(spec, lab, base, muod, muo, label, verified) {
        var c = Object.assign({}, (spec && spec.corr) || {}, { muod: muod, muo: muo });
        var s = Object.assign({}, spec, { corr: c });
        var n = normLab(lab), L = n.lab, fl = diffToFlash(L), rows = fl.rows;
        var m = base && base.ok ? { on: true, pbFactor: base.match.pbFactor, mult: { rs: base.match.mult.rs, bo: 1, muo: 1 }, shift: { rs: base.match.shift.rs, bo: 0, muo: 0 }, rsPb: base.match.rsPb || null, corr: _corrOf(s) } : null;
        var F = _build(labOil(s, L, base ? base.rsb : _rsb(L, rows)), L.T_F, m);
        if (!F || !F.ok) return { muod: muod, muo: muo, label: label, verified: verified, ok: false };
        var pv = _props(F, rows.map(function (r) { return r.p; }), L.T_F, base ? base.rsb : _rsb(L, rows));
        var pts = rows.map(function (r, i) { return { lab: { muo: r.muo }, before: pv[i] }; });
        return { muod: muod, muo: muo, label: label, verified: verified, ok: true, mare: _mare(pts, 'muo', 'before') };
    }
    function _viscPairs() {
        var out = [];
        _fams('muod').forEach(function (d) { _fams('muo').forEach(function (l) { out.push({ muod: d.key, muo: l.key, label: d.label + ' + ' + l.label, verified: d.verified !== false && l.verified !== false }); }); });
        return out;
    }
    function _sortRank(a, b) { var x = _fin(a.score) ? a.score : Infinity, y = _fin(b.score) ? b.score : Infinity; return x - y; }
    function _sortVisc(a, b) { var x = _fin(a.mare) ? a.mare : Infinity, y = _fin(b.mare) ? b.mare : Infinity; return x - y; }
    function rank(spec, lab, o) {
        o = o || {};
        var n = normLab(lab); if (!n.ok) return { ok: false, errors: n.errors, warnings: n.warnings, families: [], viscosity: [] };
        var fams = _famList().map(function (f) { return _rankFamily(spec, lab, f.key, f.label, f.verified !== false); }).sort(_sortRank);
        var base = o.base || fit(spec, lab, { props: ['rs'] });
        var hasMu = n.lab.rows.some(function (r) { return _fin(r.muo); });
        var visc = hasMu ? _viscPairs().map(function (v) { return _rankVisc(spec, lab, base, v.muod, v.muo, v.label, v.verified); }).sort(_sortVisc) : [];
        return { ok: true, families: fams, viscosity: visc, errors: [], warnings: [] };
    }

    // ── the Job (PRiSM_autoInterp.drive) ───────────────────────────────────────
    function job(spec, lab, o) {
        o = o || {};
        var st = { i: 0, done: false, cancelled: false, res: null, fit: null, fams: [], visc: [], base: null }, e0 = _evals;
        var n = normLab(lab);
        var famList = n.ok ? _famList() : [], visc = n.ok && n.lab.rows.some(function (r) { return _fin(r.muo); }) ? _viscPairs() : [];
        var total = 1 + famList.length + (visc.length ? 1 + visc.length : 0);
        function finish() {
            if (st.res) return st.res;
            if (st.cancelled) return (st.res = { ok: false, code: 'CANCELLED', cancelled: true, errors: ['cancelled'], warnings: [] });
            st.res = { ok: !!(st.fit && st.fit.ok), fit: st.fit, rank: { ok: true, families: st.fams.slice().sort(_sortRank), viscosity: st.visc.slice().sort(_sortVisc) },
                evals: _evals - e0, errors: st.fit && !st.fit.ok ? st.fit.errors : [], warnings: [] };
            return st.res;
        }
        return {
            step: function () {
                if (st.done || st.cancelled) return { done: true, progress: 1, label: 'done' };
                var i = st.i++, label;
                if (!n.ok) { st.fit = { ok: false, code: 'BAD_LAB', errors: n.errors, warnings: n.warnings }; st.done = true; return { done: true, progress: 1, label: 'lab table' }; }
                if (i === 0) { st.fit = fit(spec, lab, o); label = 'matching the selected correlations'; if (!st.fit.ok) { st.done = true; return { done: true, progress: 1, label: label }; } }
                else if (i <= famList.length) { var f = famList[i - 1]; st.fams.push(_rankFamily(spec, lab, f.key, f.label, f.verified !== false)); label = 'ranking ' + f.label; }
                else if (i === famList.length + 1) { st.base = fit(spec, lab, { props: ['rs'] }); label = 'viscosity base'; }
                else { var v = visc[i - famList.length - 2]; if (v) st.visc.push(_rankVisc(spec, lab, st.base, v.muod, v.muo, v.label, v.verified)); label = 'ranking ' + (v ? v.label : 'viscosity'); }
                if (st.i >= total) st.done = true;
                return { done: st.done, progress: Math.min(1, st.i / total), label: label };
            },
            done: function () { return st.done; },
            progress: function () { return Math.min(1, st.i / total); },
            result: function () { return finish(); },
            cancel: function () { st.cancelled = true; st.done = true; st.res = null; }
        };
    }

    function applyTo(spec, match) {
        var s = _clone(spec || {}) || {};
        s.match = match ? Object.assign({}, s.match || {}, { on: true, pbFactor: match.pbFactor, mult: match.mult, shift: match.shift, rsPb: match.rsPb || null, corr: match.corr }) : null;
        return s;
    }

    // ── examples (synthetic, flagged; the page labels them "example") ──────────
    // A known distortion of the Standing family at the lab temperature: Pb 8 % above Standing, Rs = 0.93·Rs_c + 12, Bo = 1.012·Bo_c − 0.004,
    // μo = 1.3·μo_c; the fit recovers it (wellperf-pvtmatch PM2)
    var EX = { pbF: 1 / 1.08, rs: [0.93, 12], bo: [1.012, -0.004], muo: [1.3, 0] };
    function example(spec, T_F) {
        var s = spec || {}, T = _fin(+T_F) ? +T_F : 200, gor = _fin(+s.gor) && +s.gor > 0 ? +s.gor : 500;
        var base = labOil({ type: 'oil', api: s.api, sgg: s.sgg, psep_psig: s.psep_psig, tsep_F: s.tsep_F, corr: { pb: 'standing', rs: 'standing', bo: 'standing', muod: 'beggsRobinson', muo: 'beggsRobinson' } }, null, gor);
        var F0 = _build(base, T, null); if (!F0 || !F0.ok) return null;
        var pbC = F0.pb(T); if (!_fin(pbC)) return null;
        var m = { pbFactor: EX.pbF, mult: { rs: EX.rs[0], bo: EX.bo[0], muo: EX.muo[0] }, shift: { rs: EX.rs[1], bo: EX.bo[1], muo: EX.muo[1] }, corr: _corrOf(base) };
        var F = _build(base, T, m); if (!F || !F.ok) return null;
        var pb = F.pb(T); if (!_fin(pb)) return null;
        // the Rs shift tapers below the bubble point, as a fit applies it (the bubble point itself is unchanged: the taper is 1 there)
        m.rsPb = Math.round(pb); F = _build(base, T, m); if (!F || !F.ok) return null;
        var ps = [0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1].map(function (x) { return Math.round(pb * x / 5) * 5; }).concat([Math.round(pb * 1.15 / 5) * 5, Math.round(pb * 1.35 / 5) * 5]);
        var rows = _props(F, ps, T, gor).map(function (r) { return { p: r.p, rs: Math.round(r.rs * 10) / 10, bo: Math.round(r.bo * 10000) / 10000, muo: Math.round(r.muo * 1000) / 1000 }; });
        return { v: 1, example: true, T_F: T, basis: 'flash', pb: Math.round(pb), rsbF: gor, bobF: null, rows: rows };
    }
    function exampleRv(cgr, pd) {
        var c = _fin(+cgr) && +cgr > 0 ? +cgr : 20, d = _fin(+pd) && +pd > 0 ? +pd : 4200, out = [];
        [0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 0.92].forEach(function (x) { out.push([Math.round(d * x / 10) * 10, Math.round(c * (0.18 + 0.82 * Math.pow(x, 1.6)) * 100) / 100]); });
        return out;
    }
    function exampleEmul() { return [[0, 1], [0.1, 1.4], [0.2, 2.1], [0.3, 3.2], [0.4, 5.0], [0.5, 7.8]]; }

    function emulsion(fw, muo, muw, e) { return typeof G.WTS_flowline_emulsion === 'function' ? G.WTS_flowline_emulsion(fw, muo, muw, e) : null; }
    function rvAt(rv, p, cgr) { return typeof G.WTS_flowline_rvAt === 'function' ? G.WTS_flowline_rvAt(rv, p, cgr) : null; }
    function emulCurve(e, o) {
        o = o || {}; var muo = _fin(+o.muo) && +o.muo > 0 ? +o.muo : 5, muw = _fin(+o.muw) && +o.muw > 0 ? +o.muw : 0.5, n = o.n > 4 ? Math.floor(o.n) : 60, out = [];
        for (var i = 0; i <= n; i++) {
            var fw = i / n, r = (e && e.model && e.model !== 'none') ? emulsion(fw, muo, muw, e) : null;
            var mix = ((1 - fw) * muo + fw * muw) / muo;
            out.push({ fw: fw, ratio: r ? r.ratio : mix, cont: r ? r.cont : 'mix', mix: mix });
        }
        return out;
    }
    function rvCurve(rv, cgr, o) {
        o = o || {}; var pMax = _fin(+o.pMax) && +o.pMax > 0 ? +o.pMax : 6000, n = o.n > 4 ? Math.floor(o.n) : 60, out = [];
        for (var i = 0; i <= n; i++) { var p = 14.7 + (pMax - 14.7) * i / n, v = rvAt(rv, p, cgr); out.push({ p: p, rv: v, free: _fin(v) ? Math.max(0, cgr - v) : null }); }
        return out;
    }

    var NS = G.WTS_wp_pvtmatch = G.WTS_wp_pvtmatch || {};
    NS.wls = wls; NS.normLab = normLab; NS.diffToFlash = diffToFlash; NS.labOil = labOil; NS.predict = predict; NS.fit = fit; NS.rank = rank; NS.job = job;
    NS.applyTo = applyTo; NS.preview = preview; NS.example = example; NS.exampleRv = exampleRv; NS.exampleEmul = exampleEmul;
    NS.emulsion = emulsion; NS.rvAt = rvAt; NS.emulCurve = emulCurve; NS.rvCurve = rvCurve;
    NS.METHODS = METHODS; NS.PROV_NOTE = PROV; NS.BOUNDS = BOUNDS; NS.BAND = BAND; NS.PROPS = PROPS.slice(); NS._EX = EX;
    NS.evals = function () { return _evals; };
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis, P = G.WTS_wp_pvtmatch, bad = [];
    if (!P || !G.WTS_wp_fluid || !G.PRiSM_lm || !G.WTS_flowline_props) return;
    try {
        var spec = { type: 'oil', api: 35, sgg: 0.75, gor: 600, psep_psig: 100, tsep_F: 80 };
        var lab = P.example(spec, 200), r = P.fit(spec, lab);
        if (!(r.ok && Math.abs(r.props.rs.a - 0.93) < 0.01 && Math.abs(r.props.muo.a - 1.3) < 0.02)) bad.push('recover');
        var e = P.emulsion(0.3, 5, 0.5, { model: 'brinkman' });
        if (!(e && Math.abs(e.ratio - Math.pow(0.7, -2.5)) < 1e-9)) bad.push('brinkman');
    } catch (x) { bad.push('threw ' + x.message); }
    if (bad.length && typeof console !== 'undefined') console.error('[49-calc-wp-pvtmatch.js self-test] ' + bad.join('; '));
})();
