// =============================================================================
// WTS — 49-calc-wp-lift.js  (Round 9; helper module: no page in window.WTS_calcRegistry)
// -----------------------------------------------------------------------------
// Well Performance artificial lift — the gas-lift quick look (A2, WP18). docs/WELL-PERFORMANCE-PLAN.md §3.8, §7.1, §16, §17.2, D9.
//
// Every point is one system solve (WTS_wp_system.solve with M.lift.type 'gaslift' and lift.gl.qinj_Mscfd): nothing here
// re-implements a correlation, a march, the casing gas column or a root search. The solver solves the injection depth inside each
// point (the shallower of the packer and the depth where p_casing(z) − ΔP_valve = p_tubing(z); p_casing = WTS_gaslift_casingP, the
// static lift-gas column from the surface injection pressure) and treats the lift gas as free gas only above that point (WP0b
// fluid.pvt.injGas; Rs and Bo of the formation fluid; the mixed gravity only for the free-gas density and Z). q_inj = 0 is the
// natural-flow solve exactly (§15.2).
//
// GLPC (§7.1): q_L against q_inj on a 12-point grid 0–5 MMscf/d (M.lift.gl.qinjList_Mscfd when the user gave one), run as a Job
// on a button press (PRiSM_autoInterp.drive), ascending, each point a tracking solve warm-started from the previous root (a full
// solve when the bracket fails or the previous point does not flow). optimum = the maximum q_L; economic = the point where the
// incremental slope dq_L/dq_inj falls to 1000 / incGor (STB/d per Mscf/d; incGor = M.lift.gl.incGor scf/STB, the user's
// incremental gas-oil ratio limit; 0 or blank = the optimum). A point whose root is statically unstable is flagged (the Asheim
// heading check is B). The quick look adds the rate gain over natural flow and the lift gas for 90 % of the maximum gain.
//
// Interfaces (field units, §3.0; every result {ok, errors[], warnings[{code, msg, sev}]}; nothing throws for user data):
//   WTS_wp_gl
//     .glpc(M, {qinjList?, incGor?}) → Job (step / done / progress / result / cancel); result() →
//         {ok, points:[{qinj Mscf/d, ok, qL, qo, qw, qg, pwf psia, thp psig, injMd, injTvd, pCas, pTub psia, atPacker, stable, tracked,
//          evals, code?, error?}], natural:{qL, ok}, optimum:{qinj, qL}, economic:{qinj, qL, slope}, stable:[qinj of unstable points],
//          gain, gas90:{qinj, qL}, incGor, evals, warnings, errors}
//     .quickLook(M, o?)  → the same Job with the list from M.lift.gl.qinjList_Mscfd (or the default grid) — the page's button
//     .DEFAULT_LIST      the default 12-point grid (Mscf/d)
//     .summary(points, incGor) → {optimum, economic, gain, gas90, stable}   (pure; exported for tests)
// =============================================================================
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;

    var DEFAULT_LIST = [0, 250, 500, 750, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 5000];
    var MAX_POINTS = 24;

    function _fin(v) { return typeof v === 'number' && isFinite(v); }
    function _n(v) { if (typeof v === 'number') return isFinite(v) ? v : null; if (typeof v === 'string' && v.trim() !== '' && isFinite(+v)) return +v; return null; }
    function _w(code, msg, sev) { return { code: code, msg: String(msg).slice(0, 299), sev: sev === 'info' ? 'info' : 'warn' }; }
    function _clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
    function _f(x, dp) { if (!_fin(x)) return '–'; var s = (+x.toFixed(dp || 0)).toFixed(dp || 0), p = s.split('.'), ip = p[0], neg = ip.charAt(0) === '-', out = ''; if (neg) ip = ip.slice(1); while (ip.length > 3) { out = ',' + ip.slice(-3) + out; ip = ip.slice(0, -3); } return (neg ? '−' : '') + ip + out + (p[1] ? '.' + p[1] : ''); }
    function _solveFn() { var S = G.WTS_wp_system; return (S && typeof S.solve === 'function' && (G.__WP_STUBS || []).indexOf('WTS_wp_system.solve') === -1) ? S : null; }

    function _failJob(code, errors) {
        var res = { ok: false, code: code, points: [], errors: errors, warnings: [] };
        return { step: function () { return { done: true, progress: 1, label: '' }; }, done: function () { return true; }, progress: function () { return 1; }, result: function () { return res; }, cancel: function () { }, errors: errors, code: code };
    }

    // optimum, economic point, gain over natural flow and the gas for 90 % of the maximum gain (points sorted by qinj)
    function summary(points, incGor) {
        var ok = (points || []).filter(function (p) { return p && p.ok && _fin(p.qL); }), out = { optimum: null, economic: null, gain: null, gas90: null, stable: [] };
        (points || []).forEach(function (p) { if (p && p.ok && p.stable === false) out.stable.push(p.qinj); });
        if (!ok.length) return out;
        var best = ok.reduce(function (a, b) { return b.qL > a.qL ? b : a; });
        out.optimum = { qinj: best.qinj, qL: best.qL };
        var nat = (points || []).filter(function (p) { return p && p.qinj === 0; })[0], qNat = nat && nat.ok ? nat.qL : 0;
        out.gain = best.qL - qNat;
        var lim = _fin(+incGor) && +incGor > 0 ? 1000 / +incGor : null;           // STB/d per Mscf/d
        if (lim == null) out.economic = { qinj: best.qinj, qL: best.qL, slope: null, rule: 'optimum' };
        else {
            var e = { qinj: ok[0].qinj, qL: ok[0].qL, slope: null, rule: 'slope' };
            for (var i = 1; i < ok.length && ok[i].qinj <= best.qinj; i++) {
                var sl = (ok[i].qL - ok[i - 1].qL) / (ok[i].qinj - ok[i - 1].qinj);
                if (sl >= lim) e = { qinj: ok[i].qinj, qL: ok[i].qL, slope: sl, rule: 'slope' };
                else {
                    // inside this interval the incremental slope falls below the limit: the last point that still pays
                    e.slope = sl; break;
                }
            }
            out.economic = e;
        }
        var want = qNat + 0.9 * (best.qL - qNat), prev = null;
        for (var j = 0; j < ok.length; j++) {
            var p = ok[j];
            if (p.qL >= want - 1e-9) {
                if (prev && p.qL > prev.qL) { var f = (want - prev.qL) / (p.qL - prev.qL); out.gas90 = { qinj: prev.qinj + f * (p.qinj - prev.qinj), qL: want }; }
                else out.gas90 = { qinj: p.qinj, qL: p.qL };
                break;
            }
            prev = p;
        }
        return out;
    }

    function glpc(M, o) {
        o = o || {};
        var SY = _solveFn();
        if (!SY) return _failJob('MISSING_ENGINE', ['WTS_wp_system.solve is not available']);
        if (!M || !M.fluid || !M.res || !M.well || !M.surface || !M.system) return _failJob('NO_MODEL', ['the model is incomplete']);
        var t = M.fluid.type || 'oil';
        if (t === 'gas' || t === 'condensate' || t === 'gasinj' || t === 'waterinj') return _failJob('GL_NOT_APPLICABLE', ['The gas-lift quick look is for oil (and water) producers; this is a ' + t + ' well.']);
        var gl = (M.lift && M.lift.gl) || {};
        if (!(_n(gl.pinj_psig) > 0)) return _failJob('NEEDS_PINJ', ['Enter the surface injection (casing) pressure (step ④).']);
        var raw = Array.isArray(o.qinjList) && o.qinjList.length ? o.qinjList : (Array.isArray(gl.qinjList_Mscfd) && gl.qinjList_Mscfd.length ? gl.qinjList_Mscfd : DEFAULT_LIST);
        var list = raw.map(_n).filter(function (x) { return _fin(x) && x >= 0 && x <= 50000; });
        if (list.indexOf(0) === -1) list.push(0);                                  // the natural-flow point is always part of the curve
        list = list.filter(function (x, i, a) { return a.indexOf(x) === i; }).sort(function (a, b) { return a - b; });
        if (list.length > MAX_POINTS) return _failJob('BAD_LIST', ['at most ' + MAX_POINTS + ' injection rates']);
        var incGor = _fin(_n(o.incGor)) ? _n(o.incGor) : _n(gl.incGor);
        var base = _clone(M);
        if (base.system.mode === 'design' || base.system.mode === 'max') base.system.mode = 'rate';
        var pts = [], prev = null, st = { i: 0, done: false, cancelled: false, res: null }, warnings = [];
        function solvePoint(qinj) {
            var Mx = _clone(base);
            Mx.lift = Mx.lift || {}; Mx.lift.type = qinj > 0 ? 'gaslift' : 'none'; Mx.lift.gl = Mx.lift.gl || {}; Mx.lift.gl.qinj_Mscfd = qinj;
            var opt = {};
            if (prev && prev.R && prev.R.ok && qinj > 0) opt.track = { q: prev.R.op.q, slope: prev.R.op.dDdq };
            var R = SY.solve(Mx, opt), ok = !!(R && R.ok && R.op), rt = ok ? (R.rates || {}) : {}, lf = ok ? R.lift : null;
            var p = { qinj: qinj, ok: ok, qL: ok ? rt.qL : null, qo: ok ? rt.qo : null, qw: ok ? rt.qw : null, qg: ok ? rt.qg : null, pwf: ok ? R.pwf : null,
                thp: ok && R.surface ? R.surface.thp_psig : null, injMd: lf ? lf.injMd : null, injTvd: lf ? lf.injTvd : null, pCas: lf ? lf.pCas : null, pTub: lf ? lf.pTub : null,
                atPacker: lf ? lf.atPacker : null, stable: ok ? !!R.op.stable : false, tracked: !!(R && R.tracked), evals: R ? (R.evals || 0) : 0 };
            if (!ok) { p.code = (R && R.code) || 'NO_FLOW'; p.error = (R && R.errors && R.errors[0]) || 'no operating point'; }
            if (ok) prev = { R: R };
            pts.push(p);
        }
        function finish() {
            if (st.res) return st.res;
            if (st.cancelled) { st.res = { ok: false, code: 'CANCELLED', points: [], cancelled: true, errors: ['cancelled'], warnings: [] }; return st.res; }
            var sm = summary(pts, incGor), nat = pts.filter(function (p) { return p.qinj === 0; })[0];
            var res = { ok: pts.some(function (p) { return p.ok; }), points: pts, natural: { ok: !!(nat && nat.ok), qL: nat && nat.ok ? nat.qL : 0 }, optimum: sm.optimum, economic: sm.economic,
                gain: sm.gain, gas90: sm.gas90, stable: sm.stable, incGor: _fin(incGor) ? incGor : 0, evals: pts.reduce(function (a, p) { return a + (p.evals || 0); }, 0), warnings: warnings.slice(), errors: [] };
            if (!res.ok) { res.code = 'NO_FLOW'; res.errors.push('No injection rate gives an operating point: check the injection pressure, the packer depth and the surface boundary.'); }
            if (nat && !nat.ok) res.warnings.push(_w('GL_DEAD_WELL', 'The well does not flow naturally at these settings: every rate on the curve is lifted.', 'info'));
            if (sm.stable.length) res.warnings.push(_w('GL_UNSTABLE', 'Statically unstable at ' + sm.stable.map(function (x) { return _f(x, 0); }).join(', ') + ' Mscf/d of lift gas (heading risk; the Asheim check comes in a later release).'));
            var noInj = pts.filter(function (p) { return !p.ok && /injection/i.test(String(p.error || '') + String(p.code || '')); });
            if (noInj.length) res.warnings.push(_w('GL_NO_INJECTION', 'At some rates the casing pressure cannot open a point above the packer: raise the injection pressure or lower the valve ΔP.'));
            if (sm.optimum && sm.optimum.qinj === list[list.length - 1] && list.length > 2) res.warnings.push(_w('GL_OPT_AT_END', 'The maximum rate is at the largest injection rate of the list: extend the list to find the optimum.', 'info'));
            st.res = res;
            return res;
        }
        return {
            n: list.length,
            step: function () {
                if (!st.done && !st.cancelled) { solvePoint(list[st.i]); st.i++; if (st.i >= list.length) st.done = true; } else st.done = true;
                if (st.done) finish();
                return { done: st.done, progress: st.done ? 1 : Math.min(0.99, st.i / list.length), label: st.done ? 'done' : ('lift gas ' + _f(list[Math.min(st.i, list.length - 1)], 0) + ' Mscf/d (' + (st.i + 1) + ' of ' + list.length + ')') };
            },
            done: function () { return st.done; },
            progress: function () { return st.done ? 1 : st.i / list.length; },
            result: function () { return finish(); },
            cancel: function () { st.cancelled = true; st.done = true; st.res = null; }
        };
    }
    function quickLook(M, o) { return glpc(M, o); }

    var NS = G.WTS_wp_gl = G.WTS_wp_gl || {};
    NS.glpc = glpc; NS.quickLook = quickLook; NS.summary = summary; NS.DEFAULT_LIST = DEFAULT_LIST.slice();
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis, L = G.WTS_wp_gl, bad = [];
    if (!L || typeof L.glpc !== 'function' || typeof L.summary !== 'function') bad.push('namespace');
    else {
        var s = L.summary([{ qinj: 0, ok: true, qL: 100, stable: true }, { qinj: 500, ok: true, qL: 300, stable: true }, { qinj: 1000, ok: true, qL: 350, stable: true }, { qinj: 2000, ok: true, qL: 320, stable: true }], 0);
        if (!s.optimum || s.optimum.qinj !== 1000 || s.gain !== 250) bad.push('optimum');
        var e = L.summary([{ qinj: 0, ok: true, qL: 100 }, { qinj: 500, ok: true, qL: 300 }, { qinj: 1000, ok: true, qL: 350 }], 5000);   // limit 0.2 STB/d per Mscf/d
        if (!e.economic || e.economic.qinj !== 500) bad.push('economic');
    }
    if (bad.length && typeof console !== 'undefined') console.error('[49-calc-wp-lift.js self-test] ' + bad.join('; '));
})();
