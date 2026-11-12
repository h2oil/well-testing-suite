// =============================================================================
// WTS — 49-calc-wp-match.js  (Round 9; helper module: no page in window.WTS_calcRegistry)
// -----------------------------------------------------------------------------
// Well Performance correlation comparison, IPR from a test, production-test QC (WP7, increment A1) and VLP tuning (WP17, A2) —
// docs/WELL-PERFORMANCE-PLAN.md §3.7, §5.2–§5.4, §17.1, D17.
//
// Nothing here re-implements a correlation, a march, an inflow model or a choke law: the comparison and the back-calculation drive
// the fluid (WTS_wp_fluid), the well path on the true inclination of every segment (WTS_wp_well: hydrostatic on TVD, friction on
// MD), the vertical lift on the ONE marcher (WTS_wp_vlp.traverse → WTS_flowline_march), the inflow models (WTS_wp_ipr.curve) and
// the surface boundary of the system solver (WTS_wp_system.boundary: flowline + choke). Pure: no DOM, storage, timers or events.
//
// TEST RATES. A test {q_o, q_w, q_g (Mscf/d), thp_psig, tht_F, bean64, gaugeMd, gauge_psia} is marched with its OWN measured rates
// (the flowline fluid {qo, qw, qg_Mscfd}); a missing water or gas rate is filled from the model (WC, GOR; CGR / WGR for a gas well)
// and listed in `derived`. The inflow rate basis is the module's: oil wells liquid STB/d (q_o + q_w), gas wells Mscf/d, water BWPD.
// A measured THT replaces the model THT for the march (the linear THT → BHT profile of WTS_wp_well, "measured" for the hydrate check);
// in the relaxation mode (A2, WP14) the march takes the relaxation profile with U fitted to that THT (cx.heat).
//
// COMPARE (§5.2). For each registered well correlation (the registry key strings of WTS_flowline_corr, D3): one march top-down
//   from the measured THP to the gauge MD along the deviated path (WTS_wp_well.segmentsFor(W, {from: gaugeMd, toMd: 0})), so the
//   calculated pressure is the march end exactly (no interpolation). err = p_calc − p_gauge (psi), errPct = 100·err / p_gauge,
//   errPctDp = 100·err / (p_gauge − THP) (the share of the measured tubing Δp). Ranked by |err| (several tests: by the RMS over the
//   tests with a gauge); a lost march ranks last. Unverified correlations keep their "provisional — not verified against a published
//   example" label in every row (D17). No multipliers unless o.mult (tune() fits them, A2 WP17).
// IPR FROM A TEST (§5.3). pwf at the mid-perforations: marched DOWN from the gauge (segmentsFor between the gauge and the
//   mid-perforations; a gauge below the mid-perforations is marched up), the gauge itself when it sits at the mid-perforations
//   (±1 ft), or marched down from the THP when there is no gauge — with the chosen correlation (o.corr, else M.system.corr.well,
//   else the verified default of WTS_wp_vlp.defaultCorr) and M.system.mult. Then, with the inflow model of step ② (WTS_wp_ipr.curve):
//     'pr' (the model coefficients held): closed form for pi (p̄r = pwf + q/J), jbgOil (p̄r = pwf + A·q + B·q²) and litP2
//          (p̄r² = pwf² + a·q + b·q²); a safeguarded 1-D root (Illinois) on q(pwf; p̄r) = q for the others.
//     'J'  (p̄r held): the model's productivity coefficient — J (pi, composite), q_max (vogel), C (fetkovich, back-pressure), k
//          (darcyOil): q is linear in it, so x = x₀·q / q₀ (closed form); A, B (jbgOil), a, b (litP2, litMp) divided by a factor,
//          k (darcyGas): the factor by the 1-D root. value = the PI equivalent q / (p̄r − pwf); `adopt` holds the model coefficient(s).
//     'S'  (k·h held, Darcy models only): darcyOil — q is linear in J and J ∝ 1/(X + S), so X + S = (X + S₀)·q₀ / q; darcyGas —
//          Δ = a·q + b·q² with a ∝ (X + S) and b (D) held, so a = (a₀·q₀ + b·q₀² − b·q²) / q and X + S = (X + S₀)·a / a₀ (closed
//          forms; X = the ln term of the chosen reference form). Other models → NEEDS_DARCY.
//   adopt = {control id: value} for the page (through normal input events); the provenance is "matched to test <id>".
// QC (§5.4). Every test (used or not) gets a check per code — st 'ok' | 'warn' | 'fail' | 'na' — and the non-ok ones as flags
//   ({code, sev:'fail'|'warn'|'info', msg}; 'na' = info):
//     QC_BHP_GT_PR  gauge or back-calculated pwf at or above p̄r (fail)
//     QC_Q_GT_AOF   rate above the model AOF (fail)
//     QC_GOR_LT_RSB producing GOR below Rsb for a saturated oil (warn) — only with a user bubble point (Rsb = Standing Rs at pbUser,
//                   the correlation without the one-point shift); else "not applicable" (a correlation Pb from the producing GOR
//                   gives Rsb = GOR by construction)
//     QC_CHOKE      the choke-model rate at the measured THP / bean (the rate whose surface boundary needs the measured THP, a secant
//                   on WTS_wp_system.boundary) differs from the measured rate by more than 20 %, or the choke is sub-critical at the
//                   test and a critical correlation was used (warn)
//     QC_THT        THT above the bottom-hole temperature (warn); A2 relaxation mode: also more than 20 °F outside the relaxation THT at
//                   the test rates for the matched U range (the min–max of the U fitted to the used tests' THTs; the model U when none)
//     QC_VLP        gauge error of the best correlation above 5 % (warn)
//     QC_WC         water cut outside 0–1 / negative rates (fail), or a jump of more than 20 points from the previous test by date (warn)
//     QC_SEP        producing GOR inconsistent with Separator QC (WTS_state.sepqc) — off by more than 15 % from its total GOR, or equal
//                   to its separator-basis GOR (warn)
//   score = 100 − 30 per fail − 10 per warn (≥ 0); tests ranked by score (ties in input order); the comparison and the inflow back-
//   calculation of the page use only tests with use: true.
//
// Interfaces (field units, §3.0; psia inside, *_psig at surface inputs; every result {ok, errors[], warnings[{code, msg, sev}], …}):
//   WTS_wp_match
//     .compare(M, test | tests[], corrKeys?, o? /*{stepFt, mult, profiles:false}*/)
//         → {ok, tests:[id], gauge:{md, tvd, p} (one test), thp, rows:[{corr, label, pCalc psia|null, err, errPct, errPctDp, rank,
//            verified, provisional, lost, warnings[], profile:[{md, tvd, p}] (one test), perTest:[{id, pCalc, err, errPct}], n}],
//            best, warnings, errors}
//     .thtFit(M, tests) → {ok, rows:[{id, use, tht, q, ok, U, Ubasis, A, w, cp, range, msg}], uRange:[lo, hi] | null, U (geometric
//            mean of the used fits), n, provisional}   (A2, WP14: U fitted to each test's measured THT, relaxation model)
//     .iprFromTest(M, test, solveFor /*'pr'|'J'|'S'*/, o? /*{corr}*/)
//         → {ok, solveFor, value, unit, pwf psia, method:'gauge'|'gauge at mid-perf'|'thp', corr, q, rateUnit, model, param, params
//            (the changed coefficients), jEq, adopt:{controlId: value}, closedForm, provenance, warnings, errors}
//     .pwfFromTest(M, test, o?) → {ok, pwf, method, corr, gauge, warnings}      (the pwf step alone)
//     .rates(M, test) → {ok, qo, qw, qg_Mscfd, q, gor, wc, derived[]}
//     .tune(M, tests | test, corr?, o? /*{free:['hl'] | ['hl','f'] (default: the D10 rule), bounds:{hl:[lo,hi], f:[lo,hi]}, start:{hl, f},
//            stepFt, maxIter, scan:false, profiles:false}*/)                                                       (A2, WP17; §5.2, D10)
//         → {ok, corr, label, verified, provisional, free, freeAsked, bounds, start, mult:{hl, f}, adopt:{wp_mult_hl, wp_mult_f},
//            residuals:[{id, q, rateUnit, gauge:{md, tvd, p}, thp, pUntuned, pTuned, errUntuned, errTuned, errPctUntuned, errPctTuned}],
//            rms:{untuned, tuned, untunedPct, tunedPct}, rateSpan, nTests, tests, corrMatrix:[[1, ρ], [ρ, 1]] | null, corrBasis:'lm' |
//            'jacobian', rho, separable, flags:[{code, sev, msg}], scan:[{hl, rms}], profiles:[{id, gauge, thp, untuned:[{md, tvd, p}],
//            tuned:[…]}], lm:{iterations, converged, stopReason, ssr, nEval, ci95:{hl, f}, stderr:{hl, f}}, warnings, errors}
//         flags: TUNE_MH_ONLY (info; rate span < 2:1 or one test), TUNE_INSEPARABLE (|ρ| > 0.9), TUNE_HL_RANGE / TUNE_F_RANGE
//         (outside 0.9–1.1), TUNE_AT_BOUND, TUNE_NOT_CONVERGED, TUNE_RESIDUAL (a test still > 5 % off), PROVISIONAL (D17).
//         Refusals: NO_TEST, NO_GAUGE…, LOST, UNKNOWN_CORR, INSENSITIVE (the gradient has no holdup to scale), MISSING_ENGINE (PRiSM_lm).
//     .tuneJob(M, tests, corr?, o?) → Job (PRiSM_autoInterp.drive protocol, one stage per step); result() = tune()'s result
//     .TUNE = {bounds, flag:[0.9, 1.1], rho: 0.9, span: 2, scan, inseparable}
//   (A2) pwfFromTest / iprFromTest report the multipliers they used (mult: {hl, f} | null; M.system.mult = the tuned VLP, §5.3);
//   QC_VLP is checked after tuning when M.system.mult ≠ 1 (§5.4).
//   WTS_wp_qc(M, tests, o? /*{corrKeys, sepqc}*/)
//         → {ok, rows:[{id, use, score, rank, q, pwf, gor, wc, checks:[{code, st, msg}], flags:[{code, sev, msg}], compare}], codes,
//            warnings, errors}
// =============================================================================
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;

    // WP7 implements compare / iprFromTest / qc and WP17 (A2) tune: their names leave window.__WP_STUBS
    var STUBS = G.__WP_STUBS = G.__WP_STUBS || [];
    ['WTS_wp_match.compare', 'WTS_wp_match.iprFromTest', 'WTS_wp_match.tune', 'WTS_wp_qc'].forEach(function (n) { var i = STUBS.indexOf(n); if (i !== -1) STUBS.splice(i, 1); });
    function _mark(name) { if (STUBS.indexOf(name) === -1) STUBS.push(name); }
    function _stub(name, wp) { return { ok: false, code: 'STUB', name: name, wp: wp, errors: [name + ' is not built yet (' + wp + ')'], warnings: [] }; }

    var PATM = 14.696;
    var PROVISIONAL = 'provisional — not verified against a published example';
    var QC_CODES = ['QC_BHP_GT_PR', 'QC_Q_GT_AOF', 'QC_GOR_LT_RSB', 'QC_CHOKE', 'QC_THT', 'QC_VLP', 'QC_WC', 'QC_SEP'];
    var QC_LABEL = { QC_BHP_GT_PR: 'pwf vs p̄r', QC_Q_GT_AOF: 'Rate vs AOF', QC_GOR_LT_RSB: 'GOR vs Rsb', QC_CHOKE: 'Choke', QC_THT: 'THT',
        QC_VLP: 'VLP at gauge', QC_WC: 'Water cut', QC_SEP: 'Separator QC' };
    var PEN = { fail: 30, warn: 10 };
    var CHOKE_TOL = 0.20, VLP_TOL = 5, WC_JUMP = 0.20, SEP_TOL = 0.15, SEP_SAME = 0.05;
    var CTRL = { pr: 'wp_pr', S: 'wp_ip_S' };          // page control ids (the page maps wp_ip_<name> → res.params.<name>)
    var IP_PREFIX = 'wp_ip_';

    // ── helpers ──────────────────────────────────────────────────────────────
    function _fin(v) { return typeof v === 'number' && isFinite(v); }
    function _n(v) { if (typeof v === 'number') return isFinite(v) ? v : null; if (typeof v === 'string' && v.trim() !== '' && isFinite(+v)) return +v; return null; }
    function _w(code, msg, sev) { return { code: code, msg: String(msg).slice(0, 299), sev: sev === 'info' ? 'info' : 'warn' }; }
    function _f(x, dp) {
        if (!_fin(x)) return '–';
        var s = (+x.toFixed(dp || 0)).toFixed(dp || 0), neg = s.charAt(0) === '-';
        if (neg) s = s.slice(1);
        var parts = s.split('.'), ip = parts[0], out = '';
        while (ip.length > 3) { out = ',' + ip.slice(-3) + out; ip = ip.slice(0, -3); }
        return (neg ? '−' : '') + ip + out + (parts[1] ? '.' + parts[1] : '');
    }
    function _clone(o) { return JSON.parse(JSON.stringify(o)); }
    function _isGas(t) { return t === 'gas' || t === 'condensate' || t === 'gasinj'; }
    function _fn(path) { var p = path.split('.'), f = p.length > 1 ? (G[p[0]] || {})[p[1]] : G[p[0]]; return typeof f === 'function' && (G.__WP_STUBS || []).indexOf(path) === -1 ? f : null; }
    function _fail(code, msg, extra) { var o = { ok: false, code: code, errors: [].concat(msg), warnings: [] }; if (extra) for (var k in extra) o[k] = extra[k]; return o; }
    function _reg() { return G.WTS_flowline_corr || {}; }
    function _tid(t, i) { return (t && t.id != null && String(t.id) !== '') ? String(t.id).slice(0, 40) : 'test ' + (i + 1); }

    // safeguarded 1-D root (Illinois regula falsi) on [a, b] with f(a)·f(b) ≤ 0; relative tolerance on x and on f / fScale
    function _root(f, a, b, fa, fb, fScale, maxIt) {
        if (fa === 0) return { x: a, fx: 0, it: 0 };
        if (fb === 0) return { x: b, fx: 0, it: 0 };
        var side = 0, x = a, fx = fa;
        for (var it = 0; it < (maxIt || 80); it++) {
            x = (a * fb - b * fa) / (fb - fa);
            if (!(x > Math.min(a, b) && x < Math.max(a, b))) x = 0.5 * (a + b);
            fx = f(x);
            if (!_fin(fx)) return null;
            if (Math.abs(fx) <= 1e-10 * fScale || Math.abs(b - a) <= 1e-12 * Math.max(1, Math.abs(x))) return { x: x, fx: fx, it: it + 1 };
            if ((fx > 0) === (fb > 0)) { b = x; fb = fx; if (side === -1) fa /= 2; side = -1; }
            else { a = x; fa = fx; if (side === 1) fb /= 2; side = 1; }
        }
        return { x: x, fx: fx, it: maxIt || 80 };
    }

    // ── the test model, rates and the well path ──────────────────────────────
    function rates(M, t) {
        if (!M || !M.fluid) return _fail('NO_MODEL', 'the model is incomplete');
        if (!t || typeof t !== 'object') return _fail('NO_TEST', 'no test');
        var type = M.fluid.type || 'oil', qo = _n(t.q_o), qw = _n(t.q_w), qg = _n(t.q_g), derived = [];
        var wc = _fin(_n(M.fluid.wc)) ? _n(M.fluid.wc) : 0, gor = _fin(_n(M.fluid.gor)) ? _n(M.fluid.gor) : 0;
        if (type === 'oil') {
            if (!_fin(qo)) return _fail('NO_RATE', 'The test has no oil rate.');
            if (!_fin(qw)) { qw = wc < 1 ? qo * wc / (1 - wc) : 0; derived.push('q_w from the model water cut'); }
            if (!_fin(qg)) { qg = qo * gor / 1000; derived.push('q_g from the model GOR'); }
        } else if (_isGas(type)) {
            if (!_fin(qg)) return _fail('NO_RATE', 'The test has no gas rate.');
            if (!_fin(qo)) { qo = (_n(M.fluid.cgr) || 0) * qg / 1000; derived.push('condensate from the model CGR'); }
            if (!_fin(qw)) { qw = (_n(M.fluid.wgr) || 0) * qg / 1000; derived.push('water from the model WGR'); }
        } else {
            if (!_fin(qw)) return _fail('NO_RATE', 'The test has no water rate.');
            qo = _fin(qo) ? qo : 0; qg = _fin(qg) ? qg : 0;
        }
        var q = type === 'oil' ? qo + qw : (_isGas(type) ? qg : qw);
        return { ok: true, type: type, qo: qo, qw: qw, qg_Mscfd: qg, q: q, rateUnit: type === 'oil' ? 'STB/d' : (_isGas(type) ? 'Mscf/d' : 'BWPD'),
            gor: qo > 0 ? qg * 1000 / qo : null, wc: (qo + qw) > 0 ? qw / (qo + qw) : null, derived: derived, errors: [], warnings: [] };
    }
    function _testModel(M, t) {
        var M2 = _clone(M);
        M2.well = M2.well || {}; M2.well.heat = M2.well.heat || {};
        var tht = _n(t && t.tht_F);
        if (_fin(tht)) { M2.well.heat.tht_F = tht; M2.well.heat.thtMeasured = true; }
        var bean = _n(t && t.bean64);
        if (_fin(bean) && bean > 0 && M2.surface && M2.surface.choke) M2.surface.choke.bean64 = bean;
        return M2;
    }
    // fluid + well of one test (exact properties: no binned table — a comparison is about accuracy, not speed)
    function _ctx(M, t) {
        var need = ['WTS_wp_fluid.build', 'WTS_wp_well.build', 'WTS_wp_well.segmentsFor', 'WTS_wp_vlp.traverse'];
        for (var i = 0; i < need.length; i++) if (!_fn(need[i])) return { fail: _fail('MISSING_ENGINE', need[i] + ' is not available', { name: need[i] }) };
        if (!M || !M.fluid || !M.res || !M.well) return { fail: _fail('NO_MODEL', 'the model is incomplete') };
        var r = rates(M, t);
        if (!r.ok) return { fail: r };
        var M2 = _testModel(M, t);
        var F = G.WTS_wp_fluid.build(M2.fluid, { T_F: M2.res.T_F });
        if (!F || !F.ok) return { fail: _fail('NEEDS_FLUID', (F && F.errors && F.errors.length) ? F.errors : ['the fluid is incomplete']) };
        var W = G.WTS_wp_well.build(M2.well, { res: M2.res, fluidType: M2.fluid.type, tests: [t], surface: M2.surface });
        if (!W || !W.ok || !W.segments || !W.segments.length) return { fail: _fail('NEEDS_WELL', (W && W.errors && W.errors.length) ? W.errors : ['the well has no flow path (survey and strings)']) };
        var flow = { qo: r.qo, qw: r.qw, qg_Mscfd: r.qg_Mscfd }, heat = null;
        // relaxation mode (A2, WP14): the test is marched on the relaxation profile with U fitted to its measured THT, so the profile has
        // the physical shape and passes through the measurement; a THT the model cannot reach keeps the linear profile (heat.ok false)
        if (M2.well.heat && M2.well.heat.mode === 'relax' && _fin(_n(t && t.tht_F)) && _fn('WTS_wp_well.fitU') && _fn('WTS_wp_well.relax')) {
            var fu = G.WTS_wp_well.fitU(W, F, flow, _n(t.tht_F));
            if (fu && fu.ok) {
                var hu = {}; hu.U_to = fu.U;
                var rx = G.WTS_wp_well.relax(W, F, flow, { heat: hu });
                if (rx && rx.ok) { W.tAt = rx.tAt; heat = { ok: true, U: fu.U, Ubasis: fu.Ubasis, A: rx.A, tht: rx.tht }; }
            } else heat = { ok: false, code: fu && fu.code, msg: fu && fu.errors && fu.errors[0], range: fu && fu.range };
        }
        return { M: M2, F: F, W: W, r: r, flow: flow, heat: heat };
    }
    // U fitted to the measured THT of every test (relaxation mode, A2 WP14): rows per test, the matched U range [min, max] over the
    // fitted tests with use !== false, and their geometric mean (the value the page offers to adopt)
    function thtFit(M, tests, o) {
        o = o || {};
        if (!M || !M.fluid || !M.res || !M.well) return _fail('NO_MODEL', 'the model is incomplete', { rows: [] });
        if (!_fn('WTS_wp_well.fitU')) return _fail('MISSING_ENGINE', 'WTS_wp_well.fitU is not available', { rows: [] });
        var list = (Array.isArray(tests) ? tests : [tests]).filter(function (t) { return t && typeof t === 'object'; });
        var rows = [], us = [];
        list.forEach(function (t, i) {
            var id = _tid(t, i), tht = _n(t.tht_F), row = { id: id, use: t.use !== false, tht: tht, ok: false, U: null, q: null };
            if (!_fin(tht)) { row.msg = 'No THT in the test.'; rows.push(row); return; }
            var r = rates(M, t);
            if (!r.ok) { row.msg = r.errors[0]; rows.push(row); return; }
            row.q = r.q;
            var Fm = G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F });
            var Wm = Fm && Fm.ok ? G.WTS_wp_well.build(M.well, { res: M.res, fluidType: M.fluid.type, surface: M.surface }) : null;
            if (!Wm || !Wm.ok) { row.msg = 'The fluid or the well is incomplete.'; rows.push(row); return; }
            var fu = G.WTS_wp_well.fitU(Wm, Fm, { qo: r.qo, qw: r.qw, qg_Mscfd: r.qg_Mscfd }, tht);
            if (fu && fu.ok) { row.ok = true; row.U = fu.U; row.Ubasis = fu.Ubasis; row.A = fu.A; row.w = fu.w; row.cp = fu.cp; row.range = fu.range; if (row.use) us.push(fu.U); }
            else { row.msg = (fu && fu.errors && fu.errors[0]) || 'U fit failed'; row.range = fu && fu.range; row.code = fu && fu.code; }
            rows.push(row);
        });
        var lo = us.length ? Math.min.apply(null, us) : null, hi = us.length ? Math.max.apply(null, us) : null;
        var gm = us.length ? Math.exp(us.reduce(function (a, u) { return a + Math.log(u); }, 0) / us.length) : null;
        return { ok: us.length > 0, rows: rows, uRange: us.length ? [lo, hi] : null, U: gm, n: us.length, provisional: PROVISIONAL, errors: us.length ? [] : ['No test THT could be matched.'], warnings: [] };
    }
    // the part of the flow path between two MDs (flow order from `from` to `to`) as a path object for WTS_wp_vlp.traverse
    function _sub(W, from, to) {
        var segs = G.WTS_wp_well.segmentsFor(W, { from: from, toMd: to });
        if (!Array.isArray(segs) || !segs.length) return null;
        return { ok: true, segments: segs, tAt: W.tAt, nodes: W.nodes };
    }
    function _corrOf(M, F, o) {
        if (o && o.corr) return String(o.corr);
        if (M.system && M.system.corr && M.system.corr.well) return String(M.system.corr.well);
        var V = G.WTS_wp_vlp;
        return (V && typeof V.defaultCorr === 'function') ? V.defaultCorr(F).key : 'bb';
    }
    // per-section correlations (v4.5 WP21): o.sections when given (false / [] = none); else the model's sections when the march uses the
    // model's own well correlation (pwf / IPR from a test, tuning of the model); the comparison rows are pure (one correlation each)
    function _secFor(M, F, corr, o) {
        if (o && o.sections !== undefined) return Array.isArray(o.sections) && o.sections.length ? o.sections : null;
        var sc = M && M.system && M.system.corr;
        if (!sc || !Array.isArray(sc.sections) || !sc.sections.length) return null;
        return String(corr) === _corrOf(M, F, null) ? sc.sections : null;
    }
    function _march(cx, path, from, p0, corr, o) {
        var sys = cx.M.system || {};
        var to = { from: from, p0: p0, corr: corr, stepFt: (o && +o.stepFt > 0) ? +o.stepFt : (+sys.stepFt > 0 ? +sys.stepFt : 100),
            eroC: +sys.eroC > 0 ? +sys.eroC : 100, refine: sys.refine !== false, pMax: Math.max(p0 * 4, p0 + 10000) };
        var sec = (o && o._pure) ? null : _secFor(cx.M, cx.F, corr, o);
        if (sec) to.sections = sec;
        var mult = o && o.mult;
        if (mult && (+mult.hl !== 1 || +mult.f !== 1)) to.mult = { hl: _fin(+mult.hl) ? +mult.hl : 1, f: _fin(+mult.f) ? +mult.f : 1 };
        return G.WTS_wp_vlp.traverse(cx.F, path, cx.flow, to);
    }
    function _gaugeOf(t) {
        var md = _n(t && t.gaugeMd), p = _n(t && t.gauge_psia);
        return (_fin(md) && md > 0 && _fin(p) && p > 0) ? { md: md, p: p } : null;
    }
    function _decim(prof, n) {
        if (!Array.isArray(prof) || !prof.length) return [];
        var step = Math.max(1, Math.ceil(prof.length / (n || 80))), out = [];
        for (var i = 0; i < prof.length; i += step) out.push({ md: prof[i].md, tvd: prof[i].tvd, p: prof[i].p });
        var last = prof[prof.length - 1];
        if (out[out.length - 1].md !== last.md) out.push({ md: last.md, tvd: last.tvd, p: last.p });
        return out;
    }
    function _defaultKeys(type) {
        var REG = _reg(), out = [];
        var gas = _isGas(type);
        Object.keys(REG).forEach(function (k) {
            var e = REG[k];
            if (!e || typeof e.grad !== 'function') return;
            var kind = e.kind || 'any';
            if (kind === 'any' || kind === 'well' || (gas && kind === 'gas')) out.push(e.key || k);
        });
        return out;
    }

    // ── compare (§5.2) ───────────────────────────────────────────────────────
    function _compareOne(M, t, idx, keys, o) {
        var cx = _ctx(M, t);
        if (cx.fail) return { ok: false, id: _tid(t, idx), fail: cx.fail };
        var g = _gaugeOf(t), thp = _n(t.thp_psig);
        if (!g) return { ok: false, id: _tid(t, idx), fail: _fail('NO_GAUGE', 'Test ' + _tid(t, idx) + ' has no gauge depth and pressure: the correlations are ranked at the gauge.') };
        if (!_fin(thp)) return { ok: false, id: _tid(t, idx), fail: _fail('NO_THP', 'Test ' + _tid(t, idx) + ' has no wellhead pressure.') };
        var path = _sub(cx.W, g.md, 0);
        if (!path) return { ok: false, id: _tid(t, idx), fail: _fail('NO_PATH', 'No flow path between the wellhead and the gauge.') };
        var thpA = thp + PATM, REG = _reg(), res = {};
        keys.forEach(function (k) {
            var e = REG[k], tr = _march(cx, path, 'top', thpA, k, Object.assign({}, o, { _pure: o.sections === undefined })), pC = (tr && tr.ok && _fin(tr.pEnd)) ? tr.pEnd : null;
            res[k] = { pCalc: pC, err: pC == null ? null : pC - g.p, errPct: pC == null ? null : 100 * (pC - g.p) / g.p,
                errPctDp: (pC == null || !(g.p - thpA > 1)) ? null : 100 * (pC - g.p) / (g.p - thpA), lost: !(tr && tr.ok),
                lostAt: tr && tr.lost ? tr.lost : null, warnings: ((tr && tr.warnings) || []).map(function (w) { return w.code; }),
                profile: (o && o.profiles === false) || !(tr && tr.profile) ? null : _decim(tr.profile, 80), verified: !!(e && e.verified === true) };
        });
        return { ok: true, id: _tid(t, idx), gauge: { md: g.md, tvd: typeof cx.W.tvdAt === 'function' ? cx.W.tvdAt(g.md) : null, p: g.p }, thp: thpA, res: res, rates: cx.r };
    }
    function compare(M, test, corrKeys, o) {
        o = o || {};
        var multi = Array.isArray(test), tests = multi ? test.filter(function (t) { return t && t.use !== false; }) : [test];
        if (!tests.length || !tests[0]) return _fail('NO_TEST', 'No production test to compare (tests with use: true).', { rows: [] });
        if (!M || !M.fluid) return _fail('NO_MODEL', 'the model is incomplete', { rows: [] });
        var REG = _reg(), warnings = [], keys = [];
        var asked = (Array.isArray(corrKeys) && corrKeys.length) ? corrKeys : _defaultKeys(M.fluid.type);
        asked.forEach(function (k) {
            k = String(k);
            if (!Object.prototype.hasOwnProperty.call(REG, k) || typeof REG[k].grad !== 'function') { warnings.push(_w('UNKNOWN_CORR', 'Unknown correlation key ' + k.slice(0, 40) + ' (skipped).')); return; }
            if (keys.indexOf(k) === -1) keys.push(k);
        });
        if (!keys.length) return _fail('NO_CORR', 'No known correlation to compare.', { rows: [], warnings: warnings });
        var per = tests.map(function (t, i) { return _compareOne(M, t, i, keys, o); });
        var good = per.filter(function (p) { return p.ok; });
        if (!good.length) { var f = per[0].fail; return _fail(f.code, f.errors, { rows: [], warnings: warnings.concat(f.warnings || []) }); }
        per.filter(function (p) { return !p.ok; }).forEach(function (p) { warnings.push(_w(p.fail.code, p.fail.errors[0] + ' (skipped)')); });
        var rows = keys.map(function (k) {
            var e = REG[k], row = { corr: k, label: e.label || k, verified: e.verified === true, provisional: e.verified === true ? null : PROVISIONAL };
            if (!multi) {
                var r = good[0].res[k];
                row.pCalc = r.pCalc; row.err = r.err; row.errPct = r.errPct; row.errPctDp = r.errPctDp; row.lost = r.lost; row.lostAt = r.lostAt;
                row.warnings = r.warnings; row.profile = r.profile; row.n = r.pCalc == null ? 0 : 1;
            } else {
                var e2 = 0, p2 = 0, n = 0;
                row.perTest = good.map(function (p) { var r = p.res[k]; if (r.pCalc != null) { e2 += r.err * r.err; p2 += r.errPct * r.errPct; n++; } return { id: p.id, pCalc: r.pCalc, err: r.err, errPct: r.errPct }; });
                row.n = n; row.pCalc = null; row.err = n ? Math.sqrt(e2 / n) : null; row.errPct = n ? Math.sqrt(p2 / n) : null; row.errPctDp = null;
                row.lost = n < good.length; row.rms = true; row.warnings = [];
            }
            return row;
        });
        rows.sort(function (a, b) {
            var ea = a.err == null ? Infinity : Math.abs(a.err), eb = b.err == null ? Infinity : Math.abs(b.err);
            if (multi && a.n !== b.n) return b.n - a.n;
            return ea - eb;
        });
        rows.forEach(function (r, i) { r.rank = i + 1; });
        var best = rows[0] && rows[0].err != null ? rows[0].corr : null;
        if (rows.some(function (r) { return !r.verified; })) warnings.push(_w('PROVISIONAL', 'Correlations marked provisional have no verified published example (' + PROVISIONAL + ').', 'info'));
        var out = { ok: !!best, tests: good.map(function (p) { return p.id; }), rows: rows, best: best, warnings: warnings, errors: best ? [] : ['Every march was lost before the gauge.'] };
        if (!multi) { out.gauge = good[0].gauge; out.thp = good[0].thp; out.thp_psig = good[0].thp - PATM; out.rates = good[0].rates; }
        return out;
    }

    // ── pwf from a test (§5.3, first step) ───────────────────────────────────
    function pwfFromTest(M, t, o) {
        o = o || {};
        var cx = _ctx(M, t);
        if (cx.fail) return cx.fail;
        return _pwf(cx, t, o);
    }
    function _pwf(cx, t, o) {
        var W = cx.W, mid = W.nodes && W.nodes.midPerfMd, corr = _corrOf(cx.M, cx.F, o), g = _gaugeOf(t), warnings = [];
        var mult = (o && o.mult) || (cx.M.system && cx.M.system.mult);
        var mo = { mult: mult, stepFt: o && o.stepFt };
        if (!_fin(mid)) return _fail('NO_MIDPERF', 'The mid-perforation depth is needed.');
        if (!Object.prototype.hasOwnProperty.call(_reg(), corr)) return _fail('UNKNOWN_CORR', 'unknown correlation key ' + String(corr).slice(0, 40));
        if (g) {
            if (Math.abs(g.md - mid) <= 1) return { ok: true, pwf: g.p, method: 'gauge at mid-perf', corr: corr, gauge: g, warnings: warnings, errors: [] };
            var down = g.md < mid, path = down ? _sub(W, mid, g.md) : _sub(W, g.md, mid);
            if (!path) return _fail('NO_PATH', 'No flow path between the gauge and the mid-perforations.');
            var tr = _march(cx, path, down ? 'top' : 'bottom', g.p, corr, mo);
            if (!tr || !tr.ok) return _fail('LOST', 'The march from the gauge to the mid-perforations is lost (' + ((tr && tr.lost && tr.lost.reason) || (tr && tr.code) || 'failed') + ').');
            if (!down) warnings.push(_w('GAUGE_BELOW_MIDPERF', 'The gauge is below the mid-perforations: the pressure is marched up to them.', 'info'));
            return { ok: true, pwf: tr.pEnd, method: 'gauge', corr: corr, mult: mo.mult && (+mo.mult.hl !== 1 || +mo.mult.f !== 1) ? { hl: +mo.mult.hl, f: +mo.mult.f } : null, gauge: g, dpGauge: tr.pEnd - g.p, warnings: warnings, errors: [] };
        }
        var thp = _n(t.thp_psig);
        if (!_fin(thp)) return _fail('NO_PRESSURE', 'The test needs a gauge pressure or a wellhead pressure.');
        var pth = _sub(W, mid, 0);
        if (!pth) return _fail('NO_PATH', 'No flow path between the wellhead and the mid-perforations.');
        var tr2 = _march(cx, pth, 'top', thp + PATM, corr, mo);
        if (!tr2 || !tr2.ok) return _fail('LOST', 'The march from the wellhead to the mid-perforations is lost (' + ((tr2 && tr2.lost && tr2.lost.reason) || (tr2 && tr2.code) || 'failed') + ').');
        warnings.push(_w('PWF_FROM_THP', 'No gauge: pwf is marched down from the THP with ' + ((_reg()[corr] || {}).label || corr) + ((_reg()[corr] || {}).verified === true ? '' : ' (' + PROVISIONAL + ')') + '.', 'info'));
        return { ok: true, pwf: tr2.pEnd, method: 'thp', corr: corr, mult: mo.mult && (+mo.mult.hl !== 1 || +mo.mult.f !== 1) ? { hl: +mo.mult.hl, f: +mo.mult.f } : null, gauge: null, warnings: warnings, errors: [] };
    }

    // ── IPR from a test (§5.3) ───────────────────────────────────────────────
    var J_PARAM = { pi: ['J'], composite: ['J'], vogel: ['qmax'], fetkovich: ['C'], backPressure: ['C'], darcyOil: ['k'] };   // q ∝ x
    var J_INV = { jbgOil: ['A', 'B'], litP2: ['a', 'b'], litMp: ['a', 'b'] };                                                  // Δ ∝ x
    function _curve(res, F) { return G.WTS_wp_ipr.curve(res, F); }
    function iprFromTest(M, t, solveFor, o) {
        o = o || {};
        var sf = solveFor === 'J' || solveFor === 'S' ? solveFor : (solveFor === 'pr' || solveFor == null ? 'pr' : null);
        if (!sf) return _fail('BAD_SOLVE_FOR', 'solveFor must be pr, J or S.');
        if (!_fn('WTS_wp_ipr.curve')) return _fail('MISSING_ENGINE', 'WTS_wp_ipr.curve is not available', { name: 'WTS_wp_ipr.curve' });
        var cx = _ctx(M, t);
        if (cx.fail) return cx.fail;
        var pw = _pwf(cx, t, o);
        if (!pw.ok) return pw;
        var pwf = pw.pwf, q = cx.r.q, key = String(M.res.model || ''), def = (G.WTS_wp_ipr.models || {})[key];
        var warnings = pw.warnings.slice(), res0 = _clone(M.res);
        res0.params = res0.params || {};
        if (!def) return _fail('UNKNOWN_MODEL', 'Unknown inflow model "' + key.slice(0, 40) + '".');
        if (!(q > 0)) return _fail('NO_RATE', 'The test rate must be above zero.');
        var out = { ok: true, solveFor: sf, pwf: pwf, method: pw.method, corr: pw.corr, mult: pw.mult || null, q: q, rateUnit: cx.r.rateUnit, model: key, closedForm: false,
            provenance: 'matched to test ' + _tid(t, 0), warnings: warnings, errors: [], params: {}, adopt: {} };
        var jUnit = cx.r.rateUnit + '/psi';
        if (sf === 'pr') {
            var P = res0.params, pr = null;
            if (key === 'pi' && _fin(_n(P.J)) && P.J > 0) { pr = pwf + q / P.J; out.closedForm = true; }
            else if (key === 'jbgOil' && _fin(_n(P.A)) && _fin(_n(P.B))) { pr = pwf + P.A * q + P.B * q * q; out.closedForm = true; }
            else if (key === 'litP2' && _fin(_n(P.a)) && _fin(_n(P.b))) { pr = Math.sqrt(pwf * pwf + P.a * q + P.b * q * q); out.closedForm = true; }
            else {
                // hold the resolved coefficients of the current model (a curve fitted to points keeps its fitted coefficients)
                var I0 = res0.pr > 0 ? _curve(res0, cx.F) : null;
                if (I0 && I0.ok && I0.params) Object.keys(I0.params).forEach(function (k) { if (['k', 'h', 'rw', 're', 'S', 'J', 'qmax', 'C', 'n', 'A', 'B', 'a', 'b', 'FE', 'D'].indexOf(k) !== -1 && !_fin(_n(P[k]))) P[k] = I0.params[k]; });
                res0.points = [];
                var fq = function (x) { var r = Object.assign({}, res0, { pr: x }), I = _curve(r, cx.F); return (I && I.ok) ? I.qAt(pwf) - q : NaN; };
                var lo = pwf * (1 + 1e-6) + 1e-3, flo = fq(lo), hi = pwf + Math.max(50, pwf * 0.1), fhi = fq(hi), n = 0;
                while (_fin(fhi) && fhi < 0 && n++ < 40) { lo = hi; flo = fhi; hi = pwf + (hi - pwf) * 2; fhi = fq(hi); }
                if (!_fin(flo)) flo = -q;
                if (!_fin(fhi) || fhi < 0) return _fail('NO_ROOT', 'No reservoir pressure reproduces the test rate with this inflow model.', { pwf: pwf, warnings: warnings });
                var rr = _root(fq, lo, hi, flo, fhi, q, 100);
                if (!rr) return _fail('NO_ROOT', 'The reservoir-pressure solve failed.', { pwf: pwf, warnings: warnings });
                pr = rr.x;
            }
            out.value = pr; out.unit = 'psia'; out.param = 'pr'; out.params.pr = pr; out.adopt[CTRL.pr] = pr;
            out.jEq = q / (pr - pwf);
            return out;
        }
        // J and S need p̄r and a working current curve
        var Ic = _curve(res0, cx.F);
        if (!Ic || !Ic.ok) return _fail((Ic && Ic.code) || 'NEEDS_IPR', (Ic && Ic.errors && Ic.errors.length) ? Ic.errors : ['the inflow is incomplete'], { pwf: pwf, warnings: warnings });
        if (!(pwf < Ic.pr)) return _fail('PWF_ABOVE_PR', 'The test pwf ' + _f(pwf, 0) + ' psia is at or above p̄r ' + _f(Ic.pr, 0) + ' psia: no inflow can match it.', { pwf: pwf, warnings: warnings });
        var q0 = Ic.qAt(pwf), Pc = Ic.params || {};
        if (!(q0 > 0)) return _fail('NO_ROOT', 'The inflow model gives no rate at the test pwf.', { pwf: pwf, warnings: warnings });
        if (sf === 'J') {
            if (J_PARAM[key]) {
                var pk = J_PARAM[key][0], x0 = _n(Pc[pk]);
                if (!_fin(x0)) return _fail('NEEDS_IPR', 'The inflow model has no ' + pk + ' to scale.');
                var x1 = x0 * q / q0;
                out.closedForm = true; out.param = pk; out.params[pk] = x1; out.adopt[IP_PREFIX + pk] = x1;
            } else if (J_INV[key] || key === 'darcyGas') {
                var ks = key === 'darcyGas' ? ['k'] : J_INV[key], P0 = {};
                ks.forEach(function (k) { P0[k] = _n(Pc[k]); });
                if (ks.some(function (k) { return !_fin(P0[k]); })) return _fail('NEEDS_IPR', 'The inflow model has no ' + ks.join(' / ') + ' to scale.');
                var base = _clone(res0); base.points = [];
                if (key === 'darcyGas') { base.params.D = Pc.D; base.params.S = Pc.S; }     // hold D and S while k changes
                var scaled = function (fct) { var r = _clone(base); ks.forEach(function (k) { r.params[k] = key === 'darcyGas' ? P0[k] * fct : P0[k] / fct; }); return r; };
                var fj = function (lf) { var I = _curve(scaled(Math.exp(lf)), cx.F); return (I && I.ok) ? I.qAt(pwf) - q : NaN; };
                var a = Math.log(q / q0) - 1, b = Math.log(q / q0) + 1, fa = fj(a), fb = fj(b), it = 0;
                while (_fin(fa) && fa > 0 && it++ < 30) { b = a; fb = fa; a -= 2; fa = fj(a); }
                it = 0; while (_fin(fb) && fb < 0 && it++ < 30) { a = b; fa = fb; b += 2; fb = fj(b); }
                if (!_fin(fa) || !_fin(fb) || fa > 0 || fb < 0) return _fail('NO_ROOT', 'No productivity reproduces the test rate with this inflow model.', { pwf: pwf, warnings: warnings });
                var rj = _root(fj, a, b, fa, fb, q, 100);
                if (!rj) return _fail('NO_ROOT', 'The productivity solve failed.', { pwf: pwf, warnings: warnings });
                var fct = Math.exp(rj.x);
                out.param = ks.join('/'); out.factor = fct;
                ks.forEach(function (k) { var v = key === 'darcyGas' ? P0[k] * fct : P0[k] / fct; out.params[k] = v; out.adopt[IP_PREFIX + k] = v; });
            } else return _fail('NO_J', 'The inflow model ' + key + ' has no productivity coefficient to solve for.');
            out.value = q / (Ic.pr - pwf); out.jEq = out.value; out.unit = jUnit;
            if (out.param !== 'J') warnings.push(_w('J_EQUIVALENT', 'The value is the PI equivalent q / (p̄r − pwf); the model coefficient ' + out.param + ' is adopted.', 'info'));
            return out;
        }
        // S (k·h held): Darcy models only
        if (key !== 'darcyOil' && key !== 'darcyGas') return _fail('NEEDS_DARCY', 'Skin is back-calculated with the Darcy inflow models (k·h held); choose Darcy oil or Darcy gas in step ②.', { pwf: pwf, warnings: warnings });
        var X = Ic.form && _fin(Ic.form.X) ? Ic.form.X : null, S0 = _n(Pc.S);
        if (!_fin(X) || !_fin(S0)) return _fail('NEEDS_IPR', 'The Darcy inflow has no ln term or skin to start from.');
        var Snew;
        if (key === 'darcyOil') Snew = (X + S0) * q0 / q - X;
        else {
            var a0 = _n(Pc.a), b0 = _n(Pc.b) || 0;
            if (!(a0 > 0)) return _fail('NEEDS_IPR', 'The Darcy gas inflow has no Darcy coefficient.');
            var aN = (a0 * q0 + b0 * q0 * q0 - b0 * q * q) / q;
            if (!(aN > 0)) return _fail('NO_ROOT', 'The non-Darcy term alone exceeds the test drawdown: no skin reproduces the rate (check D).', { pwf: pwf, warnings: warnings });
            Snew = (X + S0) * aN / a0 - X;
        }
        if (!(X + Snew > 0)) return _fail('NO_ROOT', 'The skin needed (' + _f(Snew, 2) + ') makes the ln term + S negative: the test rate is above what k·h allows.', { pwf: pwf, warnings: warnings });
        out.closedForm = true; out.value = Snew; out.unit = ''; out.param = 'S'; out.params.S = Snew; out.adopt[CTRL.S] = Snew; out.jEq = q / (Ic.pr - pwf);
        return out;
    }

    // ── production-test QC (§5.4) ────────────────────────────────────────────
    function _chk(code, st, msg) { return { code: code, st: st, msg: String(msg).slice(0, 299), label: QC_LABEL[code] }; }
    function _dateKey(t, i) { var d = t && t.date ? Date.parse(String(t.date)) : NaN; return _fin(d) ? d : 1e15 + i; }
    // the rate whose surface boundary (choke + flowline + separator) needs the measured THP: a secant on log q (≤ 8 boundary calls)
    function _chokeRate(M2, q, thpA) {
        var B = G.WTS_wp_system.boundary, b0 = B(M2, q, {});
        if (!b0 || !b0.ok) return { fail: b0 };
        var f = function (lq) { var b = B(M2, Math.exp(lq), {}); return (b && b.ok) ? Math.log(b.thp / thpA) : NaN; };
        var x0 = Math.log(q), f0 = Math.log(b0.thp / thpA), x1 = x0 - f0, f1 = f(x1), it = 0;
        while (_fin(f1) && Math.abs(f1) > 1e-5 && it++ < 8 && f1 !== f0) {
            var x2 = x1 - f1 * (x1 - x0) / (f1 - f0);
            if (!_fin(x2)) break;
            x0 = x1; f0 = f1; x1 = Math.max(x2, Math.log(q) - 6); f1 = f(x1);
        }
        return { b0: b0, q: _fin(f1) ? Math.exp(x1) : null, conv: _fin(f1) && Math.abs(f1) <= 1e-3 };
    }
    var THT_TOL = 20;                     // °F, QC_THT against the relaxation estimate (A2)
    // the relaxation THT at the test rates for the two ends of a U range (U low → hot, U high → cold)
    function _thtBand(M, cx, ur) {
        var Fm = G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F });
        var Wm = Fm && Fm.ok ? G.WTS_wp_well.build(M.well, { res: M.res, fluidType: M.fluid.type, surface: M.surface }) : null;
        if (!Wm || !Wm.ok) return null;
        var ts = ur.map(function (u) { var r = G.WTS_wp_well.relax(Wm, Fm, cx.flow, { heat: { U_to: u } }); return r && r.ok ? r.tht : NaN; });
        if (!_fin(ts[0]) || !_fin(ts[1])) return null;
        return { lo: Math.min(ts[0], ts[1]), hi: Math.max(ts[0], ts[1]), u: ur.slice() };
    }
    function qc(M, tests, o) {
        o = o || {};
        if (!M || !M.fluid || !M.res) return _fail('NO_MODEL', 'the model is incomplete', { rows: [] });
        var list = Array.isArray(tests) ? tests.filter(function (t) { return t && typeof t === 'object'; }) : [];
        if (!list.length) return _fail('NO_TEST', 'No production test to check.', { rows: [] });
        var type = M.fluid.type || 'oil', gas = _isGas(type), oil = type === 'oil';
        var sepqc = o.sepqc !== undefined ? o.sepqc : (G.WTS_state && G.WTS_state.sepqc) || null;
        var Fm = _fn('WTS_wp_fluid.build') ? G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F }) : null;
        var I = (Fm && Fm.ok && _fn('WTS_wp_ipr.curve') && _n(M.res.pr) > 0) ? G.WTS_wp_ipr.curve(M.res, Fm) : null;
        var pr = I && I.ok ? I.pr : _n(M.res.pr);
        var order = list.map(function (t, i) { return { t: t, i: i, k: _dateKey(t, i) }; }).sort(function (a, b) { return a.k - b.k || a.i - b.i; });
        var prevWc = {};
        order.forEach(function (x, j) { if (j > 0) { var p = rates(M, order[j - 1].t); prevWc[x.i] = { wc: p.ok ? p.wc : null, id: _tid(order[j - 1].t, order[j - 1].i) }; } });
        // relaxation mode: the matched U range over the used tests with a THT (or the model U when none can be matched)
        var relaxQc = null;
        if (M.well && M.well.heat && M.well.heat.mode === 'relax' && _fn('WTS_wp_well.relax')) {
            var tf = o.uRange ? { ok: true, uRange: o.uRange } : thtFit(M, list.filter(function (t) { return t.use !== false; }));
            var u0 = _n(M.well.heat.U_to) || 2;
            relaxQc = tf.ok && tf.uRange ? { uRange: tf.uRange, src: tf.uRange[0] === tf.uRange[1] ? 'the U matched to the tests' : 'the U range matched to the tests' } : { uRange: [u0, u0], src: 'the model U' };
        }
        var rows = list.map(function (t, i) {
            var id = _tid(t, i), checks = [], r = rates(M, t), cx = _ctx(M, t), pw = null, cmp = null;
            if (!cx.fail) pw = _pwf(cx, t, { corr: o.corr });
            var pwf = pw && pw.ok ? pw.pwf : null, g = _gaugeOf(t);
            // QC_BHP_GT_PR
            if (!_fin(pr) || !(pr > 0)) checks.push(_chk('QC_BHP_GT_PR', 'na', 'p̄r needed: the pwf check is not applicable.'));
            else if (g && g.p >= pr) checks.push(_chk('QC_BHP_GT_PR', 'fail', 'Gauge pressure ' + _f(g.p, 0) + ' psia is at or above p̄r ' + _f(pr, 0) + ' psia: the well could not flow (check p̄r, the gauge or its depth).'));
            else if (_fin(pwf) && pwf >= pr) checks.push(_chk('QC_BHP_GT_PR', 'fail', 'Back-calculated pwf ' + _f(pwf, 0) + ' psia (' + pw.method + ') is at or above p̄r ' + _f(pr, 0) + ' psia.'));
            else if (_fin(pwf)) checks.push(_chk('QC_BHP_GT_PR', 'ok', 'pwf ' + _f(pwf, 0) + ' psia is below p̄r ' + _f(pr, 0) + ' psia (drawdown ' + _f(pr - pwf, 0) + ' psi).'));
            else checks.push(_chk('QC_BHP_GT_PR', 'na', 'No pwf: ' + ((pw && pw.errors && pw.errors[0]) || (cx.fail && cx.fail.errors[0]) || 'the test needs a gauge or a THP')));
            // QC_Q_GT_AOF
            if (!r.ok) checks.push(_chk('QC_Q_GT_AOF', 'na', r.errors[0]));
            else if (!(I && I.ok && I.aof > 0)) checks.push(_chk('QC_Q_GT_AOF', 'na', 'No inflow model (p̄r and the IPR parameters are needed).'));
            else if (r.q > I.aof) checks.push(_chk('QC_Q_GT_AOF', 'fail', 'Test rate ' + _f(r.q, 0) + ' ' + r.rateUnit + ' is above the model AOF ' + _f(I.aof, 0) + ' ' + r.rateUnit + '.'));
            else checks.push(_chk('QC_Q_GT_AOF', 'ok', 'Test rate is ' + _f(100 * r.q / I.aof, 0) + ' % of the model AOF.'));
            // QC_GOR_LT_RSB
            var pbU = _n(M.fluid.pbUser), L = G.PRiSM_pvt_correlations;
            if (!oil) checks.push(_chk('QC_GOR_LT_RSB', 'na', 'Not applicable: gas well.'));
            else if (!_fin(pbU) || !(pbU > 0)) checks.push(_chk('QC_GOR_LT_RSB', 'na', 'Not applicable: no bubble-point pressure entered (a correlation Pb from the producing GOR gives Rsb = GOR by construction).'));
            else if (!r.ok || !_fin(r.gor)) checks.push(_chk('QC_GOR_LT_RSB', 'na', 'No producing GOR.'));
            else if (!L || typeof L.Rs_standing !== 'function' || !_fin(_n(M.res.T_F))) checks.push(_chk('QC_GOR_LT_RSB', 'na', 'Rs correlation or reservoir temperature not available.'));
            else {
                var rsb = L.Rs_standing(+M.fluid.api, +M.fluid.sgg, pbU, +M.res.T_F), sat = (_fin(pr) && pr <= pbU) || (_fin(pwf) && pwf < pbU);
                if (!_fin(rsb)) checks.push(_chk('QC_GOR_LT_RSB', 'na', 'Rsb could not be evaluated.'));
                else if (sat && r.gor < 0.95 * rsb) checks.push(_chk('QC_GOR_LT_RSB', 'warn', 'Producing GOR ' + _f(r.gor, 0) + ' scf/STB is below Rsb ' + _f(rsb, 0) + ' scf/STB (Standing at the entered Pb ' + _f(pbU, 0) + ' psia) with free gas at the well: gas may be under-measured or the Pb is high.'));
                else checks.push(_chk('QC_GOR_LT_RSB', 'ok', 'Producing GOR ' + _f(r.gor, 0) + ' scf/STB against Rsb ' + _f(rsb, 0) + ' scf/STB' + (sat ? '' : ' (undersaturated at the well)') + '.'));
            }
            // QC_CHOKE
            var C_GAS = { gas: 1, condensate: 1, gasinj: 1 };
            var ch = M.surface && M.surface.choke, bean = _n(t.bean64) || (ch && _n(ch.bean64)), thp = _n(t.thp_psig);
            if (!ch || ch.present === false) checks.push(_chk('QC_CHOKE', 'na', 'No surface choke in the model.'));
            else if (!_fin(thp) || !(bean > 0)) checks.push(_chk('QC_CHOKE', 'na', 'The test needs a THP and a bean.'));
            else if (!r.ok || !_fn('WTS_wp_system.boundary')) checks.push(_chk('QC_CHOKE', 'na', !r.ok ? r.errors[0] : 'The surface boundary engine is not available.'));
            else {
                var M2 = _testModel(M, t); M2.system = M2.system || {}; M2.system.mode = 'rate';
                var cr = _chokeRate(M2, r.q, thp + PATM);
                if (cr.fail) checks.push(_chk('QC_CHOKE', 'na', 'Choke model not available: ' + ((cr.fail && cr.fail.errors && cr.fail.errors[0]) || 'boundary failed')));
                else {
                    var reg0 = cr.b0.regime, dev = _fin(cr.q) ? cr.q / r.q - 1 : null, corrN = (ch.corr || 'gilbert');
                    if (reg0 === 'subcritical-bound') checks.push(_chk('QC_CHOKE', 'warn', 'The choke is sub-critical at the test (p2/p1 ' + _f(cr.b0.ratio, 2) + ' above ' + _f(cr.b0.yc, 3) + '): the critical correlation ' + corrN + ' does not apply to this test.'));
                    // A2 (WP15): sub-critical on the continuous Sachdeva et al. (1986) branch — modelled, but provisional (D17), so it still warns
                    else if (reg0 === 'subcritical' && !(C_GAS[M.fluid.type] && ch.corr !== 'sachdeva')) checks.push(_chk('QC_CHOKE', 'warn', 'The choke is sub-critical at the test (p2/p1 ' + _f(cr.b0.ratio, 2) + ' above ' + _f(cr.b0.yc, 3) + '): the rate rests on the Sachdeva et al. (1986) sub-critical branch, provisional — not verified against a published example' + (dev != null ? '; model rate ' + _f(cr.q, 0) + ' ' + r.rateUnit + ' (' + (dev > 0 ? '+' : '') + _f(100 * dev, 0) + ' %).' : '.')));
                    else if (dev == null) checks.push(_chk('QC_CHOKE', 'na', 'The choke rate at the measured THP could not be found.'));
                    else if (Math.abs(dev) > CHOKE_TOL) checks.push(_chk('QC_CHOKE', 'warn', 'Choke-model rate at THP ' + _f(thp, 0) + ' psig and bean ' + _f(bean, 0) + '/64 is ' + _f(cr.q, 0) + ' ' + r.rateUnit + ', ' + (dev > 0 ? '+' : '') + _f(100 * dev, 0) + ' % from the measured rate (' + reg0 + ').'));
                    else checks.push(_chk('QC_CHOKE', 'ok', 'Choke-model rate within ' + _f(Math.abs(100 * dev), 0) + ' % of the measured rate (' + reg0 + ').'));
                }
            }
            // QC_THT (A2: in the relaxation mode also more than 20 °F from the relaxation estimate with the matched U range)
            var tht = _n(t.tht_F), bht = cx.fail ? _n(M.res.T_F) : (_fin(cx.W.bht) ? cx.W.bht : (cx.W.temp && _fin(cx.W.temp.bht) ? cx.W.temp.bht : _n(M.res.T_F)));
            var band = (relaxQc && !cx.fail && _fin(tht)) ? _thtBand(M, cx, relaxQc.uRange) : null;
            if (!_fin(tht)) checks.push(_chk('QC_THT', 'na', 'No THT in the test.'));
            else if (!_fin(bht)) checks.push(_chk('QC_THT', 'na', 'No bottom-hole temperature in the model.'));
            else if (tht > bht + 0.5) checks.push(_chk('QC_THT', 'warn', 'THT ' + _f(tht, 0) + ' °F is above the bottom-hole temperature ' + _f(bht, 0) + ' °F.'));
            else if (band && (tht < band.lo - THT_TOL || tht > band.hi + THT_TOL)) checks.push(_chk('QC_THT', 'warn', 'THT ' + _f(tht, 0) + ' °F is more than ' + THT_TOL + ' °F from the relaxation estimate ' + _f(band.lo, 0) + (band.hi - band.lo >= 0.5 ? '–' + _f(band.hi, 0) : '') + ' °F (U ' + _f(band.u[0], 2) + (band.u[1] !== band.u[0] ? '–' + _f(band.u[1], 2) : '') + ', ' + relaxQc.src + ').'));
            else if (band) checks.push(_chk('QC_THT', 'ok', 'THT ' + _f(tht, 0) + ' °F is within ' + THT_TOL + ' °F of the relaxation estimate ' + _f(band.lo, 0) + (band.hi - band.lo >= 0.5 ? '–' + _f(band.hi, 0) : '') + ' °F (' + relaxQc.src + ').'));
            else checks.push(_chk('QC_THT', 'ok', 'THT ' + _f(tht, 0) + ' °F is below the bottom-hole temperature ' + _f(bht, 0) + ' °F.'));
            // QC_VLP
            if (!g) checks.push(_chk('QC_VLP', 'na', 'No gauge pressure: the correlations cannot be checked.'));
            else {
                cmp = compare(M, t, o.corrKeys, { profiles: false });
                var b = cmp.ok ? cmp.rows[0] : null;
                // A2 (§5.4): with tuned multipliers (M.system.mult ≠ 1) the check is made after tuning, on the model's well correlation
                var tm = M.system && M.system.mult, tuned = tm && ((_fin(+tm.hl) && +tm.hl !== 1) || (_fin(+tm.f) && +tm.f !== 1)) ? { hl: _fin(+tm.hl) ? +tm.hl : 1, f: _fin(+tm.f) ? +tm.f : 1 } : null;
                var tcmp = tuned && !cx.fail ? compare(M, t, [_corrOf(cx.M, cx.F, { corr: o.corr })], { profiles: false, mult: tuned }) : null;
                if (!b) checks.push(_chk('QC_VLP', 'na', 'Comparison not available: ' + ((cmp.errors || [])[0] || '')));
                else if (tuned && tcmp && tcmp.ok && tcmp.rows[0] && _fin(tcmp.rows[0].errPct) && Math.abs(tcmp.rows[0].errPct) <= Math.abs(b.errPct)) {
                    var tb = tcmp.rows[0], tl = ' after tuning (' + tb.label + ', m_h ' + _f(tuned.hl, 3) + ', m_f ' + _f(tuned.f, 3) + ')';
                    if (Math.abs(tb.errPct) > VLP_TOL) checks.push(_chk('QC_VLP', 'warn', 'The tuned correlation still misses the gauge by ' + _f(tb.err, 0) + ' psi (' + _f(tb.errPct, 1) + ' %)' + tl + ': rates, THP, gauge depth or the fluid may be inconsistent.'));
                    else checks.push(_chk('QC_VLP', 'ok', 'Within ' + _f(Math.abs(tb.errPct), 1) + ' % of the gauge' + tl + (tb.verified ? '' : ' (' + PROVISIONAL + ')') + '.'));
                }
                else if (Math.abs(b.errPct) > VLP_TOL) checks.push(_chk('QC_VLP', 'warn', 'Best correlation ' + b.label + ' misses the gauge by ' + _f(b.err, 0) + ' psi (' + _f(b.errPct, 1) + ' %): rates, THP, gauge depth or the fluid may be inconsistent.'));
                else checks.push(_chk('QC_VLP', 'ok', 'Best correlation ' + b.label + ' within ' + _f(Math.abs(b.errPct), 1) + ' % of the gauge' + (b.verified ? '' : ' (' + PROVISIONAL + ')') + '.'));
            }
            // QC_WC
            var qo = _n(t.q_o), qw = _n(t.q_w);
            if ((_fin(qo) && qo < 0) || (_fin(qw) && qw < 0) || (_fin(_n(t.q_g)) && _n(t.q_g) < 0)) checks.push(_chk('QC_WC', 'fail', 'A test rate is negative.'));
            else if (!r.ok || r.wc == null) checks.push(_chk('QC_WC', 'na', 'No liquid rate.'));
            else if (r.wc < 0 || r.wc > 1) checks.push(_chk('QC_WC', 'fail', 'Water cut ' + _f(100 * r.wc, 1) + ' % is outside 0–100 %.'));
            else if (prevWc[i] && _fin(prevWc[i].wc) && Math.abs(r.wc - prevWc[i].wc) > WC_JUMP) checks.push(_chk('QC_WC', 'warn', 'Water cut ' + _f(100 * r.wc, 0) + ' % jumped ' + _f(100 * Math.abs(r.wc - prevWc[i].wc), 0) + ' points from test ' + prevWc[i].id + ' (' + _f(100 * prevWc[i].wc, 0) + ' %).'));
            else checks.push(_chk('QC_WC', 'ok', (gas ? 'Water fraction of the liquids ' : 'Water cut ') + _f(100 * r.wc, 1) + ' %' + (r.derived.some(function (d) { return /^q_w/.test(d); }) ? ' (from the model)' : '') + '.'));
            // QC_SEP
            var sq = sepqc && sepqc.ok !== false ? sepqc : null, ref = sq ? (_n(sq.gorTotal) || _n(sq.gorSTCorr)) : null, gsep = sq ? _n(sq.gorSepCorr) : null;
            if (!oil) checks.push(_chk('QC_SEP', 'na', 'Not applicable: gas well.'));
            else if (!sq || !(ref > 0)) checks.push(_chk('QC_SEP', 'na', 'Not applicable: no Separator QC result in this project.'));
            else if (!r.ok || !_fin(r.gor)) checks.push(_chk('QC_SEP', 'na', 'No producing GOR.'));
            else if (gsep > 0 && Math.abs(r.gor / gsep - 1) <= SEP_SAME && Math.abs(gsep / ref - 1) > SEP_SAME) checks.push(_chk('QC_SEP', 'warn', 'Producing GOR ' + _f(r.gor, 0) + ' scf/STB equals the separator-basis GOR of Separator QC; the total (stock-tank) GOR is ' + _f(ref, 0) + ' scf/STB.'));
            else if (Math.abs(r.gor / ref - 1) > SEP_TOL) checks.push(_chk('QC_SEP', 'warn', 'Producing GOR ' + _f(r.gor, 0) + ' scf/STB differs by ' + _f(100 * (r.gor / ref - 1), 0) + ' % from the Separator QC total GOR ' + _f(ref, 0) + ' scf/STB.'));
            else checks.push(_chk('QC_SEP', 'ok', 'Producing GOR consistent with Separator QC (' + _f(ref, 0) + ' scf/STB).'));
            var flags = checks.filter(function (c) { return c.st !== 'ok'; }).map(function (c) { return { code: c.code, sev: c.st === 'na' ? 'info' : c.st, msg: c.msg, na: c.st === 'na' }; });
            var score = 100;
            checks.forEach(function (c) { score -= PEN[c.st] || 0; });
            return { id: id, use: t.use !== false, score: Math.max(0, score), q: r.ok ? r.q : null, rateUnit: r.ok ? r.rateUnit : null, pwf: pwf, pwfMethod: pw && pw.ok ? pw.method : null,
                gor: r.ok ? r.gor : null, wc: r.ok ? r.wc : null, checks: checks, flags: flags, compare: cmp && cmp.ok ? { best: cmp.best, rows: cmp.rows.map(function (x) { return { corr: x.corr, err: x.err, errPct: x.errPct, rank: x.rank, verified: x.verified }; }) } : null };
        });
        var ranked = rows.map(function (r, i) { return { r: r, i: i }; }).sort(function (a, b) { return b.r.score - a.r.score || a.i - b.i; });
        ranked.forEach(function (x, k) { x.r.rank = k + 1; });
        return { ok: true, rows: rows, codes: QC_CODES.slice(), labels: QC_LABEL, warnings: gas ? [_w('QC_GAS', 'Gas well: the GOR and Separator QC checks are not applicable.', 'info')] : [], errors: [] };
    }

    // ── VLP tuning (§5.2 A2, D10; WP17) ──────────────────────────────────────
    // The multipliers act INSIDE the one marcher (WTS_flowline_march opt.mult, WP0b): H_L' = clamp(m_h·H_L, λ_L, 1), then ρ_s, the
    // slip viscosity / friction of the correlation (its .friction hook), gradEl, gradF = m_f·gradF' and grad = (gradEl + gradF)/(1 − Ek)
    // are rebuilt. The residual of a test is p_calc(m) − p_gauge with p_calc the march from the measured THP down the surveyed path to
    // the gauge MD at the test's own rates and THT (the compare march); the sub-step layout is frozen at the start (§4.5) so p(m) is
    // smooth for the forward-difference Jacobian. PRiSM_lm (05-regression) fits m_h, or m_h and m_f when the used tests span at least
    // 2:1 in rate (with gauges at one depth the two are nearly collinear otherwise). The 2 × 2 parameter correlation is reported
    // either from the LM covariance (both fitted) or from the Jacobian of both multipliers at the answer (m_h only): |ρ| > 0.9 →
    // "the two multipliers cannot be separated with these tests".
    var TUNE_BOUNDS = { hl: [0.8, 1.25], f: [0.7, 1.5] }, TUNE_FLAG = [0.9, 1.1], TUNE_RHO = 0.9, TUNE_SPAN = 2, TUNE_SCAN = 9;
    var INSEP_MSG = 'the two multipliers cannot be separated with these tests';
    function _bnd(o, k) {
        var b = o && o.bounds && Array.isArray(o.bounds[k]) ? o.bounds[k] : null, d = TUNE_BOUNDS[k];
        var lo = b && _fin(+b[0]) ? +b[0] : d[0], hi = b && _fin(+b[1]) ? +b[1] : d[1];
        lo = Math.max(0.05, lo); hi = Math.min(20, hi);
        return hi > lo ? [lo, hi] : d.slice();
    }
    function _cl(v, b) { return Math.min(b[1], Math.max(b[0], v)); }
    // the fit in stages (the Job runs one stage per step; tune() runs them all): contexts + untuned marches · free set + sensitivity ·
    // LM · correlation + flags · objective scan + profiles
    function _tuneStages(M, tests, corr, o) {
        o = o || {};
        var S = { out: null };
        var stages = [function () { S.out = _tuneA(M, tests, corr, o, S); }, function () { S.out = _tuneB(o, S); }, function () { S.out = _tuneC(o, S); },
            function () { S.out = _tuneD(o, S); }, function () { S.out = _tuneE(o, S); }];
        return { S: S, stages: stages, labels: ['untuned marches', 'free multipliers', 'Levenberg-Marquardt fit', 'parameter correlation', 'objective and traverses'] };
    }
    function tune(M, tests, corr, o) {
        var R = _tuneStages(M, tests, corr, o);
        for (var i = 0; i < R.stages.length; i++) { R.stages[i](); if (R.S.out) return R.S.out; }
        return R.S.out || _fail('TUNE_FAILED', 'the fit did not finish');
    }
    function tuneJob(M, tests, corr, o) {
        var R = _tuneStages(M, tests, corr, o), J = G.WTS_wp_system && G.WTS_wp_system.job;
        var spec = { next: function (i) { if (i < R.stages.length && !R.S.out) R.stages[i](); return !!R.S.out || i + 1 >= R.stages.length; },
            finish: function () { return R.S.out || _fail('CANCELLED', 'The tuning was cancelled.'); },
            progress: function (i) { return i / R.stages.length; }, label: function (i) { return R.labels[Math.min(i, R.labels.length - 1)]; } };
        if (typeof J === 'function') return J(spec);
        var done = false, res = null, i0 = 0;
        return { step: function () { if (!done) { done = spec.next(i0++); if (done) res = spec.finish(); } return { done: done, progress: done ? 1 : spec.progress(i0), label: spec.label(i0) }; },
            done: function () { return done; }, progress: function () { return done ? 1 : spec.progress(i0); }, result: function () { return res || spec.finish(); }, cancel: function () { done = true; } };
    }
    function _tuneA(M, tests, corr, o, S) {
        if (!M || !M.fluid) return _fail('NO_MODEL', 'the model is incomplete');
        var LM = G.PRiSM_lm;
        if (typeof LM !== 'function') return _fail('MISSING_ENGINE', 'PRiSM_lm (Levenberg-Marquardt) is not available', { name: 'PRiSM_lm' });
        var list = (Array.isArray(tests) ? tests : [tests]).filter(function (t) { return t && typeof t === 'object' && t.use !== false; });
        if (!list.length) return _fail('NO_TEST', 'No production test to tune to (tests with use: true).');
        var REG = _reg(), warnings = [], flags = [], cases = [];
        var flag = function (code, sev, msg) { flags.push({ code: code, sev: sev, msg: String(msg).slice(0, 299) }); };
        // one context per test: fluid, deviated well path wellhead → gauge, frozen sub-step grid
        var key = null;
        list.forEach(function (t, i) {
            var id = _tid(t, i), g = _gaugeOf(t), thp = _n(t.thp_psig);
            if (!g) { warnings.push(_w('NO_GAUGE', 'Test ' + id + ' has no gauge depth and pressure (skipped).')); return; }
            if (!_fin(thp)) { warnings.push(_w('NO_THP', 'Test ' + id + ' has no wellhead pressure (skipped).')); return; }
            var cx = _ctx(M, t);
            if (cx.fail) { warnings.push(_w(cx.fail.code, 'Test ' + id + ': ' + (cx.fail.errors[0] || 'not usable') + ' (skipped).')); return; }
            if (key == null) key = _corrOf(cx.M, cx.F, { corr: corr });
            var path = _sub(cx.W, g.md, 0);
            if (!path) { warnings.push(_w('NO_PATH', 'Test ' + id + ': no flow path between the wellhead and the gauge (skipped).')); return; }
            cases.push({ id: id, t: t, cx: cx, path: path, g: g, thpA: thp + PATM, q: cx.r.q, rateUnit: cx.r.rateUnit, grid: true, memo: {},
                gaugeTvd: typeof cx.W.tvdAt === 'function' ? cx.W.tvdAt(g.md) : null });
        });
        if (!cases.length) { var w0 = warnings[0]; return _fail(w0 ? w0.code : 'NO_TEST', w0 ? w0.msg : 'No usable test (gauge depth and pressure, THP, rates).', { warnings: warnings }); }
        key = String(key);
        if (!Object.prototype.hasOwnProperty.call(REG, key) || typeof REG[key].grad !== 'function') return _fail('UNKNOWN_CORR', 'unknown correlation key ' + key.slice(0, 40), { warnings: warnings });
        var E = REG[key], sys = M.system || {}, stepFt = +o.stepFt > 0 ? +o.stepFt : (+sys.stepFt > 0 ? +sys.stepFt : 100);
        var bH = _bnd(o, 'hl'), bF = _bnd(o, 'f'), nEval = 0;
        // p_calc at the gauge for multipliers m (a lost march returns null)
        function pAt(c, hl, f, keepProfile) {
            var mk = hl.toPrecision(14) + '|' + f.toPrecision(14);
            if (!keepProfile && c.memo[mk] !== undefined) return c.memo[mk];
            var so = { from: 'top', p0: c.thpA, corr: key, stepFt: stepFt, eroC: +sys.eroC > 0 ? +sys.eroC : 100, refine: sys.refine !== false,
                pMax: Math.max(c.thpA * 4, c.thpA + 10000), grid: c.grid };
            var secT = _secFor(M, c.cx.F, key, o); if (secT) so.sections = secT;
            if (hl !== 1 || f !== 1) so.mult = { hl: hl, f: f };
            var tr = G.WTS_wp_vlp.traverse(c.cx.F, c.path, c.cx.flow, so);
            nEval++;
            if (c.grid === true && tr && tr.grid) c.grid = tr.grid;          // the layout of the first march is kept (§4.5 frozen grid)
            var p = (tr && tr.ok && _fin(tr.pEnd)) ? tr.pEnd : null;
            c.memo[mk] = p;
            return keepProfile ? { p: p, profile: tr && tr.profile ? _decim(tr.profile, 80) : null } : p;
        }
        var h0 = _fin(+(o.start && o.start.hl)) ? _cl(+o.start.hl, bH) : 1, f0 = _fin(+(o.start && o.start.f)) ? _cl(+o.start.f, bF) : 1;
        // untuned residuals (m = 1) — the march at the published correlation fixes each test's grid
        cases.forEach(function (c) { c.pU = pAt(c, 1, 1); });
        var live = cases.filter(function (c) { return c.pU != null; });
        cases.filter(function (c) { return c.pU == null; }).forEach(function (c) { warnings.push(_w('LOST', 'Test ' + c.id + ': the untuned march is lost before the gauge (skipped).')); });
        if (!live.length) return _fail('LOST', 'Every march was lost before the gauge.', { warnings: warnings });
        S.c = { key: key, E: E, bH: bH, bF: bF, h0: h0, f0: f0, live: live, warnings: warnings, flags: flags, flag: flag, pAt: pAt, LM: LM, nEval: function () { return nEval; } };
        return null;
    }
    function _tuneB(o, S) {
        var c0 = S.c, live = c0.live, flag = c0.flag, pAt = c0.pAt, f0 = c0.f0, E = c0.E, key = c0.key, warnings = c0.warnings;
        // which multipliers are free (D10): m_h always; m_f only when the tests span ≥ 2:1 in rate
        var qs = live.map(function (c) { return c.q; }).filter(function (q) { return q > 0; });
        var span = qs.length ? Math.max.apply(null, qs) / Math.min.apply(null, qs) : 1;
        var asked = Array.isArray(o.free) ? o.free.filter(function (k) { return k === 'hl' || k === 'f'; }) : null;
        var wantF = asked ? asked.indexOf('f') !== -1 : (span >= TUNE_SPAN && live.length >= 2);
        var free = ['hl'];
        if (wantF && span >= TUNE_SPAN && live.length >= 2) free.push('f');
        else if (wantF || (asked == null && live.length >= 2)) flag('TUNE_MH_ONLY', 'info', 'The tests span ' + _f(span, 2) + ':1 in rate (below ' + TUNE_SPAN + ':1): with gauge pressures at one depth the holdup and friction multipliers are nearly collinear, so only the holdup multiplier m_h is fitted (m_f held at ' + _f(f0, 3) + ').');
        else if (live.length === 1) flag('TUNE_MH_ONLY', 'info', 'One test: only the holdup multiplier m_h is fitted (m_f held at ' + _f(f0, 3) + ').');
        // sensitivity: a method whose gradient does not depend on the holdup (single-phase gas) cannot be tuned this way
        var dH = 0;
        live.forEach(function (c) { var a = pAt(c, _cl(1.02, [0.01, 99]), 1), b = pAt(c, _cl(0.98, [0.01, 99]), 1); if (a != null && b != null) dH = Math.max(dH, Math.abs(a - b) / 0.04); });
        if (!(dH > 0.5)) return _fail('INSENSITIVE', (E.label || key) + ': the pressure at the gauge does not respond to the holdup multiplier (' + _f(dH, 2) + ' psi per unit) — no liquid holdup to scale; nothing to tune.', { corr: key, warnings: warnings });
        c0.free = free; c0.span = span; c0.asked = asked;
        return null;
    }
    function _tuneC(o, S) {
        var c0 = S.c, live = c0.live, pAt = c0.pAt, bH = c0.bH, bF = c0.bF, free = c0.free, warnings = c0.warnings, LM = c0.LM, h0 = c0.h0, f0 = c0.f0;
        // PRiSM_lm on the gauge residuals (one row per test; a single test gets a zero-weight copy: PRiSM_lm needs two rows)
        var n = live.length, T = [], P = [], Wt = [];
        live.forEach(function (c, i) { T.push(i); P.push(c.g.p); Wt.push(1); });
        if (n === 1) { T.push(0); P.push(live[0].g.p); Wt.push(0); }
        var model = function (tt, pr) {
            var hl = _cl(+pr.hl, bH), f = _cl(+pr.f, bF);
            return tt.map(function (i) { var c = live[i], p = pAt(c, hl, f); return p == null ? c.g.p + 1e4 : p; });
        };
        var lm;
        try {
            lm = LM(model, { t: T, p: P, weights: Wt }, { hl: h0, f: f0 }, { hl: bH, f: bF }, free.indexOf('f') === -1 ? { f: true } : null,
                { maxIter: +o.maxIter > 0 ? +o.maxIter : 30, tolerance: 1e-9, gtol: 1e-10, derivStep: 1e-3 });
        } catch (e) { return _fail('LM_FAILED', 'The fit failed: ' + String(e && e.message || e).slice(0, 200), { warnings: warnings }); }
        var mh = _cl(+lm.params.hl, bH), mf = free.indexOf('f') !== -1 ? _cl(+lm.params.f, bF) : f0;
        c0.lm = lm; c0.mh = mh; c0.mf = mf; c0.n = n;
        return null;
    }
    function _tuneD(o, S) {
        var c0 = S.c, live = c0.live, pAt = c0.pAt, bH = c0.bH, bF = c0.bF, free = c0.free, lm = c0.lm, mh = c0.mh, mf = c0.mf, flag = c0.flag, E = c0.E, key = c0.key;
        // residuals before / after, RMS
        var res = live.map(function (c) {
            var pT = pAt(c, mh, mf);
            return { id: c.id, q: c.q, rateUnit: c.rateUnit, gauge: { md: c.g.md, tvd: c.gaugeTvd, p: c.g.p }, thp: c.thpA, pUntuned: c.pU, pTuned: pT,
                errUntuned: c.pU - c.g.p, errTuned: pT == null ? null : pT - c.g.p, errPctUntuned: 100 * (c.pU - c.g.p) / c.g.p,
                errPctTuned: pT == null ? null : 100 * (pT - c.g.p) / c.g.p };
        });
        var rms = function (k) { var s = 0, m = 0; res.forEach(function (r) { if (_fin(r[k])) { s += r[k] * r[k]; m++; } }); return m ? Math.sqrt(s / m) : null; };
        // the 2 × 2 parameter correlation: LM covariance (both free) or the Jacobian of both multipliers at the answer
        var rho = null, basis = null;
        if (free.length === 2 && lm.corr && lm.corr[0] && _fin(lm.corr[0][1])) { rho = lm.corr[0][1]; basis = 'lm'; }
        else {
            var hh = 0.01, sHH = 0, sFF = 0, sHF = 0;
            live.forEach(function (c) {
                var a = pAt(c, mh + hh, mf), b = pAt(c, mh - hh, mf), cc = pAt(c, mh, mf + hh), d = pAt(c, mh, mf - hh);
                if ([a, b, cc, d].some(function (v) { return v == null; })) return;
                var jh = (a - b) / (2 * hh), jf = (cc - d) / (2 * hh);
                sHH += jh * jh; sFF += jf * jf; sHF += jh * jf;
            });
            if (sHH > 0 && sFF > 0) {
                var det = sHH * sFF - sHF * sHF;
                rho = det > 1e-9 * sHH * sFF ? -sHF / Math.sqrt(sHH * sFF) : (sHF >= 0 ? -1 : 1);
                basis = 'jacobian';
            }
        }
        var separable = rho == null ? null : Math.abs(rho) <= TUNE_RHO;
        if (separable === false) flag('TUNE_INSEPARABLE', free.length === 2 ? 'warn' : 'info', 'Parameter correlation |ρ| = ' + _f(Math.abs(rho), 3) + ' above ' + TUNE_RHO + ': ' + INSEP_MSG + (free.length === 2 ? '; consider fitting m_h only.' : ' (m_h alone is fitted).'));
        // flags (D10): a multiplier outside 0.9–1.1 stretches the correlation; at a bound; not converged; still off the gauge
        var near = function (v, b) { return Math.abs(v - b) <= 1e-3 * (bH[1] - bH[0]); };
        if (mh < TUNE_FLAG[0] || mh > TUNE_FLAG[1]) flag('TUNE_HL_RANGE', 'warn', 'Holdup multiplier m_h = ' + _f(mh, 3) + ' is outside ' + TUNE_FLAG[0] + '–' + TUNE_FLAG[1] + ': the correlation is being stretched — check the test rates, the gauge depth and the fluid before adopting it.');
        if (free.indexOf('f') !== -1 && (mf < TUNE_FLAG[0] || mf > TUNE_FLAG[1])) flag('TUNE_F_RANGE', 'warn', 'Friction multiplier m_f = ' + _f(mf, 3) + ' is outside ' + TUNE_FLAG[0] + '–' + TUNE_FLAG[1] + ': check the roughness, the tubing ID and the rates before adopting it.');
        if (near(mh, bH[0]) || near(mh, bH[1]) || (free.indexOf('f') !== -1 && (Math.abs(mf - bF[0]) <= 1e-3 * (bF[1] - bF[0]) || Math.abs(mf - bF[1]) <= 1e-3 * (bF[1] - bF[0]))))
            flag('TUNE_AT_BOUND', 'warn', 'A multiplier stopped at its bound (m_h ' + bH[0] + '–' + bH[1] + (free.indexOf('f') !== -1 ? ', m_f ' + bF[0] + '–' + bF[1] : '') + '): the correlation cannot reach the gauge within the allowed range — the test or the model is inconsistent, or another correlation fits better.');
        if (!lm.converged) flag('TUNE_NOT_CONVERGED', 'warn', 'The fit stopped before convergence (' + (lm.stopReason || 'iterations') + ').');
        var worst = 0; res.forEach(function (r) { if (_fin(r.errPctTuned)) worst = Math.max(worst, Math.abs(r.errPctTuned)); });
        if (worst > VLP_TOL) flag('TUNE_RESIDUAL', 'warn', 'After tuning a test still misses the gauge by ' + _f(worst, 1) + ' % (above ' + VLP_TOL + ' %): the tests are not consistent with one pair of multipliers.');
        if (E.verified !== true) flag('PROVISIONAL', 'info', (E.label || key) + ': ' + PROVISIONAL + '.');
        c0.res = res; c0.rms = rms; c0.rho = rho; c0.basis = basis; c0.separable = separable;
        return null;
    }
    function _tuneE(o, S) {
        var c0 = S.c, live = c0.live, pAt = c0.pAt, bH = c0.bH, bF = c0.bF, free = c0.free, lm = c0.lm, mh = c0.mh, mf = c0.mf, E = c0.E, key = c0.key;
        var res = c0.res, rms = c0.rms, rho = c0.rho, basis = c0.basis, separable = c0.separable, flags = c0.flags, warnings = c0.warnings;
        var span = c0.span, asked = c0.asked, h0 = c0.h0, f0 = c0.f0, n = c0.n;
        // the objective along m_h (m_f at its answer) for the page's residual plot
        var scan = [];
        if (o.scan !== false) for (var k = 0; k < TUNE_SCAN; k++) {
            var hk = bH[0] + (bH[1] - bH[0]) * k / (TUNE_SCAN - 1), s2 = 0, m2 = 0;
            live.forEach(function (c) { var p = pAt(c, hk, mf); if (p != null) { s2 += (p - c.g.p) * (p - c.g.p); m2++; } });
            scan.push({ hl: hk, rms: m2 ? Math.sqrt(s2 / m2) : null });
        }
        var profiles = null;
        if (o.profiles !== false) profiles = live.slice(0, 6).map(function (c) { return { id: c.id, gauge: { md: c.g.md, tvd: c.gaugeTvd, p: c.g.p }, thp: c.thpA, untuned: pAt(c, 1, 1, true).profile, tuned: pAt(c, mh, mf, true).profile }; });
        var ci = lm.ci95 || {}, se = lm.stderr || {};
        return { ok: true, corr: key, label: E.label || key, verified: E.verified === true, provisional: E.verified === true ? null : PROVISIONAL,
            free: free, freeAsked: asked, bounds: { hl: bH, f: bF }, start: { hl: h0, f: f0 }, mult: { hl: mh, f: mf },
            adopt: { wp_mult_hl: +mh.toPrecision(6), wp_mult_f: +mf.toPrecision(6) },
            residuals: res, rms: { untuned: rms('errUntuned'), tuned: rms('errTuned'), untunedPct: rms('errPctUntuned'), tunedPct: rms('errPctTuned') },
            rateSpan: span, nTests: n, tests: live.map(function (c) { return c.id; }), corrMatrix: rho == null ? null : [[1, rho], [rho, 1]], corrBasis: basis, rho: rho,
            separable: separable, flags: flags, scan: scan, profiles: profiles,
            lm: { iterations: lm.iterations, converged: !!lm.converged, stopReason: lm.stopReason || null, ssr: lm.ssr, nEval: c0.nEval(),
                ci95: { hl: ci.hl && _fin(ci.hl[0]) ? ci.hl : null, f: free.indexOf('f') !== -1 && ci.f && _fin(ci.f[0]) ? ci.f : null },
                stderr: { hl: _fin(se.hl) ? se.hl : null, f: free.indexOf('f') !== -1 && _fin(se.f) ? se.f : null } },
            warnings: warnings, errors: [] };
    }

    var NS = G.WTS_wp_match = G.WTS_wp_match || {};
    NS.compare = compare; NS.iprFromTest = iprFromTest; NS.pwfFromTest = pwfFromTest; NS.rates = rates; NS.thtFit = thtFit;
    NS.QC_CODES = QC_CODES.slice(); NS.QC_LABEL = QC_LABEL; NS.PROVISIONAL = PROVISIONAL; NS._root = _root;
    NS.TOL = { choke: CHOKE_TOL, vlpPct: VLP_TOL, wcJump: WC_JUMP, sep: SEP_TOL, tht: THT_TOL };
    NS.tune = tune; NS.tuneJob = tuneJob; NS.TUNE = { bounds: { hl: TUNE_BOUNDS.hl.slice(), f: TUNE_BOUNDS.f.slice() }, flag: TUNE_FLAG.slice(), rho: TUNE_RHO, span: TUNE_SPAN, scan: TUNE_SCAN, inseparable: INSEP_MSG };
    G.WTS_wp_qc = qc;
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis, bad = [];
    var N = G.WTS_wp_match;
    if (!N || typeof N.compare !== 'function' || typeof N.iprFromTest !== 'function' || typeof G.WTS_wp_qc !== 'function') bad.push('namespace');
    else {
        var r = N._root(function (x) { return x * x - 2; }, 1, 2, -1, 2, 1, 100);
        if (!r || Math.abs(r.x - Math.SQRT2) > 1e-9) bad.push('root');
        var q = N.rates({ fluid: { type: 'oil', wc: 0.3, gor: 500 } }, { q_o: 700 });
        if (!(q.ok && Math.abs(q.qw - 300) < 1e-9 && Math.abs(q.qg_Mscfd - 350) < 1e-9 && Math.abs(q.q - 1000) < 1e-9)) bad.push('rates');
    }
    if (bad.length && typeof console !== 'undefined') console.error('[49-calc-wp-match.js self-test] ' + bad.join('; '));
})();
