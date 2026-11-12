// =============================================================================
// WTS — 49-calc-wp-inj.js  (Round 9; helper module: no page in window.WTS_calcRegistry)
// -----------------------------------------------------------------------------
// Well Performance injection wells (WP24, increment B) — docs/WELL-PERFORMANCE-PLAN.md §1.4 (E9 injector VLP), §4.2 (injector index
// with a fracture-pressure limit), §2.10 (DFIT closure), D3, D17.
//
// An injector (fluid type 'waterinj' or 'gasinj') is solved by WTS_wp_system.solve through this file: the inflow is the WTS_wp_ipr
// model 'injector' (pwf(q) = p̄r + q/II for water; the reversed m(p) LIT for gas), the outflow is the ONE marcher with the flow DOWN
// the deviated path (WTS_wp_vlp.traverse with o.inject: hydrostatic gain on TVD, friction on MD; the single-phase path of the marcher
// for water, gas for a gas injector) from the surface injection pressure M.system.thp_psig. Nothing here re-implements a march, a
// correlation or an inflow model: the file only couples them.
//
// OPERATING POINT. Δ(q) = pwf_VLP(q) − pwf_IPR(q): pwf_VLP falls with q (friction), pwf_IPR rises (injectivity), so there is at most
//   one root and it is always statically stable (dΔ/dq < 0 in the producer sign convention is reported as stable: a larger rate
//   needs more pressure than the column delivers). Δ(0) ≤ 0 → no injection (the THP plus the column does not reach p̄r); the THP needed
//   to start is reported. Coarse scan (8 points, frozen step layout), then Brent (|Δ| < 0.1 psi).
// FRACTURE LIMIT. p_frac (psia at the mid-perforations): the inflow input wp_ip_pfrac, else the DFIT closure of this well
//   (WTS_state.dfit.closureGrad × the mid-perforation TVD, provisional like every DFIT label). q_frac = the rate at p_frac on the inflow;
//   thpFrac = the THP that puts the bottom-hole pressure at p_frac at that rate (a march up from p_frac) — the highest injection
//   pressure that does not fracture. Verdict on the operating pwf: ✗ above p_frac, ⚠ within 5 %, ✓ below.
// BREAKDOWN (producer sign: each item a loss; they sum to THP − p̄r): reservoir = pwf − p̄r (the injection drive), gravity = the
//   column (negative: a gain), friction, acceleration, restrictions.
// TEMPERATURE. The linear profile of WTS_wp_well (THT = the injection temperature at the wellhead → the reservoir temperature).
//
// API
//   WTS_wp_inj.solve(M, o?) → R in the shape of WTS_wp_system.solve (roots, op, curves {ipr, vlp}, traverse, breakdown, surface, rates,
//        velocities, flags, warnings, errors, evals, counts, grid) plus R.injector = true and R.inj = {fluid, pFrac, pFracSource,
//        pFracProvisional, qFrac, thpFrac_psig, margin, verdict 'ok'|'warn'|'fail'|'none', II, thpStart_psig}
//   WTS_wp_inj.fracFromDfit(tvd) → {ok, p, grad, source, isip, provisional} | {ok:false}
//   WTS_wp_inj.isInjector(M) → bool
// =============================================================================
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var PATM = 14.696, TOL_P = 0.1;
    var PROVISIONAL = 'provisional — not verified against a published example';

    function _fin(v) { return typeof v === 'number' && isFinite(v); }
    function _n(v) { if (typeof v === 'number') return isFinite(v) ? v : null; if (typeof v === 'string' && v.trim() !== '' && isFinite(+v)) return +v; return null; }
    function _w(code, msg, sev) { return { code: code, msg: String(msg).slice(0, 299), sev: sev === 'info' ? 'info' : 'warn' }; }
    function _f(x, dp) { return _fin(x) ? Number(x).toLocaleString('en-US', { maximumFractionDigits: dp || 0, minimumFractionDigits: dp || 0 }) : '–'; }
    function _fn(path) { var p = path.split('.'), f = p.length > 1 ? (G[p[0]] || {})[p[1]] : G[p[0]]; return typeof f === 'function' ? f : null; }
    function isInjector(M) { var t = M && M.fluid && M.fluid.type; return t === 'waterinj' || t === 'gasinj'; }
    function _fail(code, errors, extra) {
        var r = { ok: false, injector: true, code: code, node: 'bottom', roots: [], op: null, qs: null, vlpMin: null, traverse: null, breakdown: [], surface: {},
            rates: {}, flags: [], discontinuities: [], warnings: [], errors: [].concat(errors || []), evals: 0, counts: { fine: 0, coarse: 0, line: 0 } };
        if (extra) for (var k in extra) r[k] = extra[k];
        return r;
    }

    // the DFIT closure of this well at a TVD (psia): closure gradient × TVD; ISIP reported as the upper bound (information)
    function fracFromDfit(tvd) {
        var d = G.WTS_state && G.WTS_state.dfit;
        if (!d || !d.ok) return { ok: false };
        var g = _n(d.closureGrad);
        if (!(g > 0) || !(_n(tvd) > 0)) return { ok: false };
        return { ok: true, p: g * tvd, grad: g, source: 'DFIT closure gradient ' + _f(g, 3) + ' psi/ft × ' + _f(tvd, 0) + ' ft TVD', isip: _n(d.isip),
            provisional: d.labelsCalibrated !== true };
    }

    function solve(M, o) {
        o = o || {};
        var need = ['WTS_wp_fluid.build', 'WTS_wp_ipr.curve', 'WTS_wp_well.build', 'WTS_wp_vlp.traverse'];
        for (var i = 0; i < need.length; i++) if (!_fn(need[i])) return _fail('MISSING_ENGINE', [need[i] + ' is not available'], { name: need[i] });
        if (!M || !M.fluid || !M.res || !M.well) return _fail('NO_MODEL', ['the model is incomplete']);
        var type = M.fluid.type, gas = type === 'gasinj';
        var F = G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F, table: o.table !== false });
        if (!F || !F.ok) return _fail('NEEDS_FLUID', (F && F.errors && F.errors.length) ? F.errors : ['the fluid is incomplete'], { F: F });
        if (M.res.model !== 'injector') return _fail('INJ_MODEL', ['An injection well needs the injector inflow model (step ②: injectivity index with a fracture-pressure limit).'], { F: F });
        var W = G.WTS_wp_well.build(M.well, { res: M.res, fluidType: type, tests: M.tests, surface: M.surface });
        if (!W || !W.ok || !W.segments || !W.segments.length) return _fail('NEEDS_WELL', (W && W.errors && W.errors.length) ? W.errors : ['the well has no flow path (survey and strings)'], { F: F, W: W });
        var refMd = W.nodes && _fin(W.nodes.midPerfMd) ? W.nodes.midPerfMd : null, midTvd = W.nodes && _fin(W.nodes.midPerfTvd) ? W.nodes.midPerfTvd : null;
        var I = G.WTS_wp_ipr.curve(M.res, F, { tvdAt: W.tvdAt, refMd: refMd });
        if (!I || !I.ok) return _fail('NEEDS_IPR', (I && I.errors && I.errors.length) ? I.errors : ['the injectivity is incomplete (p̄r and II, or k and h)'], { F: F, W: W, I: I });
        var thp = _n(M.system && M.system.thp_psig);
        if (!_fin(thp)) return _fail('NEEDS_THP', ['Enter the surface injection pressure (wellhead pressure, step ⑤).'], { F: F, W: W, I: I });
        var V = G.WTS_wp_vlp, sys = M.system || {}, REG = G.WTS_flowline_corr || {};
        var corr = (sys.corr && sys.corr.well) ? String(sys.corr.well) : (V.defaultCorr ? V.defaultCorr(F).key : 'bb');
        if (!REG[corr]) return _fail('UNKNOWN_CORR', ['unknown correlation key ' + String(corr).slice(0, 40)], { F: F, W: W, I: I });
        var E = REG[corr];
        if (!gas && (corr === 'gasTZ' || corr === 'gasCS')) return _fail('CORR_NOT_APPLICABLE', ['The dry-gas method is not applicable to a water injector. Choose another correlation.'], { F: F, W: W, I: I });
        var warnings = [], counts = { fine: 0, coarse: 0, line: 0 }, pr = I.pr;
        if (M.surface && M.surface.choke && M.surface.choke.present) warnings.push(_w('INJ_NO_CHOKE', 'Injection well: the surface choke is not used; the wellhead (injection) pressure is the boundary.', 'info'));
        if (M.lift && M.lift.type && M.lift.type !== 'none') warnings.push(_w('INJ_NO_LIFT', 'Injection well: artificial lift does not apply.', 'info'));
        var p0 = thp + PATM, stepFt = +sys.stepFt > 0 ? +sys.stepFt : 100, eroC = +sys.eroC > 0 ? +sys.eroC : 100;
        var base = { corr: corr, stepFt: stepFt, eroC: eroC, refine: sys.refine !== false, inject: true, pMax: Math.max(3 * pr, pr + 10000) };
        if (sys.mult && (+sys.mult.hl !== 1 || +sys.mult.f !== 1)) base.mult = { hl: +sys.mult.hl || 1, f: +sys.mult.f || 1 };
        var grid = null;
        function march(q, from, pStart, coarse, keep) {
            var opt = Object.assign({}, base, { from: from, p0: pStart, coarse: !!coarse });
            if (grid && !coarse && !keep) opt.grid = grid;
            if (!grid && !coarse) opt.grid = true;
            var tr = V.traverse(F, W, q, opt);
            if (coarse) counts.coarse++; else counts.fine++;
            if (!grid && !coarse && tr && tr.grid) grid = tr.grid;
            return tr;
        }
        function pwfV(q, coarse) {
            var tr = march(q, 'top', p0, coarse);
            return (tr && tr.ok && _fin(tr.pEnd)) ? tr.pEnd : -1e6;          // a lost march (no pressure left) counts as "cannot deliver"
        }
        function delta(q, coarse) { return pwfV(q, coarse) - I.pwfAt(q); }
        // the column at zero rate (a tiny rate): no injection below this THP
        var qTiny = Math.max(1e-3, 1e-6 * I.aof);
        var d0 = delta(qTiny, false);
        var R = { ok: false, injector: true, node: 'bottom', nodeAsked: sys.node || 'bottom', mode: sys.mode || 'rate', corr: { well: corr, line: null }, roots: [], op: null,
            qs: null, vlpMin: null, pwf: null, traverse: null, breakdown: [], surface: {}, rates: {}, velocities: {}, flags: [], discontinuities: [], marginal: [],
            loading: null, warnings: warnings.concat((I.warnings || []).filter(function (x) { return x.sev === 'warn'; })), errors: [], aof: I.aof, pr: pr, choke: { present: false } };
        // fracture limit
        var pFrac = _n(I.pFrac), pfSrc = _fin(pFrac) ? 'input' : null, pfProv = false;
        if (!_fin(pFrac)) { var df = fracFromDfit(midTvd); if (df.ok && df.p > pr) { pFrac = df.p; pfSrc = df.source; pfProv = !!df.provisional; } }
        var inj = { fluid: gas ? 'gas' : 'water', pFrac: _fin(pFrac) ? pFrac : null, pFracSource: pfSrc, pFracProvisional: pfProv, qFrac: null, thpFrac_psig: null,
            margin: null, verdict: 'none', II: I.II, thpStart_psig: null, rateUnit: gas ? 'Mscf/d' : 'BWPD' };
        // THP needed to start injecting: the column marched up from p̄r at a tiny rate
        var st = march(qTiny, 'bottom', pr, false, true);
        if (st && st.ok && _fin(st.pEnd)) inj.thpStart_psig = st.pEnd - PATM;
        if (_fin(pFrac)) {
            var qf = I.qAt(pFrac);
            if (qf > 0) {
                inj.qFrac = qf;
                var tf = march(qf, 'bottom', pFrac, false, true);
                if (tf && tf.ok && _fin(tf.pEnd)) inj.thpFrac_psig = tf.pEnd - PATM;
            }
        }
        // the outflow and inflow curves for the plot (coarse scan to the limit rate, extended while the column still delivers)
        var qTop = Math.max(_fin(inj.qFrac) ? inj.qFrac * 1.25 : 0, I.aof || 0), scan = [], cur = { ipr: [], vlp: [] };
        if (!(qTop > 0)) qTop = 1000;
        if (d0 > 0) {
            // extend the scan until the outflow falls below the inflow (at most ×64)
            for (var ext = 0; ext < 6; ext++) { if (delta(qTop, true) < 0) break; qTop *= 2; }
        }
        for (var k = 0; k <= 8; k++) {
            var q = qTop * (k === 0 ? 0.002 : k / 8), pv = pwfV(q, true), pi = I.pwfAt(q);
            scan.push({ q: q, pOut: pv > 0 ? pv : null, pIn: pi, lost: pv > 0 ? null : 'pressure' });
            if (pv > 0) cur.vlp.push({ q: q, p: pv });
        }
        for (var j = 0; j <= 40; j++) { var qj = qTop * j / 40; cur.ipr.push({ q: qj, p: I.pwfAt(qj) }); }
        R.scan = scan; R.curves = cur;
        if (!(d0 > 0)) {
            R.code = 'NO_INJECTION';
            R.errors.push('No injection: the wellhead pressure plus the ' + (gas ? 'gas' : 'water') + ' column does not reach p̄r' + (_fin(inj.thpStart_psig) ? ' — it needs more than ' + _f(inj.thpStart_psig, 0) + ' psig at the wellhead.' : '.'));
            R.warnings.push(_w('NO_OP', R.errors[0]));
        } else {
            // bracket from the scan (Δ decreases with q), then Brent on fine marches with the frozen layout
            var lo = qTiny, flo = d0, hi = null, fhi = null;
            for (var s = 1; s < scan.length; s++) {
                var ds = (scan[s].pOut != null ? scan[s].pOut : -1e6) - scan[s].pIn;
                if (ds < 0) { hi = scan[s].q; break; }
                lo = scan[s].q;
            }
            if (hi == null) { R.code = 'NO_ROOT'; R.errors.push('The injection rate is beyond the scanned range.'); }
            else {
                flo = delta(lo, false); fhi = delta(hi, false);
                if (flo < 0) { hi = lo; fhi = flo; lo = qTiny; flo = d0; }
                var Br = G.WTS_wp_system && G.WTS_wp_system._brent;
                var fq = function (x) { return delta(x, false); };
                var r = (typeof Br === 'function' && fhi < 0 && flo > 0) ? Br(fq, lo, hi, flo, fhi, 30) : null;
                var qop = r ? r.x : null;
                if (!_fin(qop) || !(qop > 0)) { R.code = 'NO_ROOT'; R.errors.push('The injection operating point could not be bracketed.'); }
                else {
                    var dq = Math.max(1e-6, 0.01 * qop), dd = (delta(qop + dq, false) - delta(Math.max(qTiny, qop - dq), false)) / (qop + dq - Math.max(qTiny, qop - dq));
                    var pwf = I.pwfAt(qop);
                    R.roots = [{ q: qop, p: pwf, dDdq: -dd, stable: true, conv: r.conv }];
                    R.op = { q: qop, p: pwf, stable: true, dDdq: -dd };
                    R.pwf = pwf;
                    var tr = march(qop, 'top', p0, false);
                    if (tr && tr.ok) {
                        R.traverse = tr;
                        var el = 0, fr = 0, ac = 0, rs = tr.restrictionsDp || 0;
                        (tr.segments || []).forEach(function (sg) { el += sg.dpEl || 0; fr += sg.dpF || 0; ac += sg.dpAcc || 0; });
                        // pwf = THP − Σ(dpEl + dpF + dpAcc) − restrictions (flow downward: dpEl < 0 is the column's gain)
                        var resid = (p0 - pwf) - (el + fr + ac + rs);
                        R.breakdown = [{ key: 'reservoir', dp: pwf - pr }, { key: 'gravity', dp: el + resid }, { key: 'friction', dp: fr }, { key: 'acceleration', dp: ac }];
                        if (rs) R.breakdown.push({ key: 'restrictions', dp: rs });
                        R.velocities = { vmMax: tr.vmMax, eroMax: tr.eroMax, eroC: eroC, qEro: null, where: 'tubing', tubing: { vmMax: tr.vmMax, eroMax: tr.eroMax }, flowline: null };
                        R.ok = true;
                    } else R.errors.push('the traverse at the injection rate failed');
                    var tht = (W.temp && _fin(W.temp.tht)) ? W.temp.tht : (W.tAt ? W.tAt(0) : null);
                    R.surface = { thp: p0, thp_psig: thp, tht: tht, thtHyd: null, tHyd: null, hydMargin: null, choke: { present: false, regime: 'none' }, pChokeDn: null };
                    R.rates = gas ? { q: qop, qo: 0, qw: 0, qg: qop, qL: 0, basis: 'gas', injection: true } : { q: qop, qo: 0, qw: qop, qg: 0, qL: qop, basis: 'water', injection: true };
                    R.heat = { mode: 'linear', tht: tht };
                    if (_fin(pFrac)) {
                        inj.margin = pFrac - pwf;
                        inj.verdict = pwf > pFrac ? 'fail' : (pwf > 0.95 * pFrac ? 'warn' : 'ok');
                    }
                }
            }
        }
        // flags
        var F2 = [];
        if (inj.verdict === 'fail') F2.push(_w('INJ_FRAC', 'The bottom-hole injection pressure ' + _f(R.pwf, 0) + ' psia is above the fracture pressure ' + _f(pFrac, 0) + ' psia: the well would fracture at this wellhead pressure (keep the THP below ' + _f(inj.thpFrac_psig, 0) + ' psig).'));
        else if (inj.verdict === 'warn') F2.push(_w('INJ_FRAC_NEAR', 'The bottom-hole injection pressure is within 5 % of the fracture pressure ' + _f(pFrac, 0) + ' psia.'));
        if (pfProv) F2.push(_w('INJ_FRAC_DFIT', 'Fracture pressure from the DFIT closure of this well (' + pfSrc + '); the DFIT labels are provisional (not yet calibrated).', 'info'));
        if (!_fin(pFrac)) F2.push(_w('INJ_NO_FRAC', 'No fracture pressure: enter it (step ②) or run a DFIT on this well to check the injection pressure against it.', 'info'));
        if (E && E.verified !== true) F2.push(_w('PROVISIONAL', (E.label || corr) + ': ' + PROVISIONAL + '.', 'info'));
        F2.push(_w('PROVISIONAL_INJ', 'Injector inflow: ' + PROVISIONAL + '.', 'info'));
        if (R.velocities && _fin(R.velocities.eroMax) && R.velocities.eroMax > 0.8) F2.push(_w('EROSION', 'Mixture velocity reaches ' + _f(R.velocities.eroMax * 100, 0) + ' % of the API RP 14E erosional velocity (C = ' + _f(eroC, 0) + ') in the tubing.'));
        R.flags = F2;
        R.inj = inj;
        R.counts = counts;
        R.evals = counts.fine + 0.5 * counts.coarse;
        R.grid = { dir: 'inject', fine: grid };
        R.I = { aof: I.aof, pr: pr, kind: 'inj', key: I.key };
        return R;
    }

    var NS = G.WTS_wp_inj = G.WTS_wp_inj || {};
    NS.solve = solve; NS.fracFromDfit = fracFromDfit; NS.isInjector = isInjector; NS.PROVISIONAL = PROVISIONAL;
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var N = G.WTS_wp_inj;
    if (!(N && typeof N.solve === 'function') && typeof console !== 'undefined') console.error('[wp-inj self-test] namespace missing');
})();
