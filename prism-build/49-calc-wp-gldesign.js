// =============================================================================
// WTS — 49-calc-wp-gldesign.js  (Round 9; helper module: no page in window.WTS_calcRegistry)
// -----------------------------------------------------------------------------
// Well Performance gas-lift design and diagnostics (B, WP25) — docs/WELL-PERFORMANCE-PLAN.md §1.3 US16, §2.3, §3.8, §4.10, §7.2, D17.
//
// Nothing here re-implements a march, a correlation, the casing gas column or the nitrogen dome: the design is WTS_gaslift_compute
// (49-calc-gaslift.js, API RP 11V6 spacing) driven with the SHARED model through its additive inputs (WP25: ipr, segments, tAt, corr,
// pvt) — the model's inflow (WTS_wp_ipr), the deviated flow path (WTS_wp_well.segmentsFor: hydrostatic on TVD, friction on MD), the
// flowing temperature of the operating solve at every valve (linear, relaxation or enthalpy — WP14 / WP22) and the well correlation;
// the diagnostic traverses are WTS_flowline_march on the same path; the gas column is WTS_gaslift_casingP and the dome correction
// WTS_gaslift_ct.
//
// METHODS (field units: psia inside, psig at surface inputs named *_psig, ft MD / TVD, °F, Mscf/d, STB/d)
//   Thornhill-Craver valve throughput (Thornhill & Craver; as written in API RP 11V2 and Brown 1980 vol. 2a), ideal gas:
//     q (Mscf/d) = 155.5·Cd·A·p1·√{ 2g·k/(k−1)·(r^(2/k) − r^((k+1)/k)) } / √(γg·T1)
//     A port area in², p1 upstream (casing) psia, T1 °R, g = 32.16 ft/s², r = max(p2/p1, r_c) — the critical ratio cap
//     r_c = (2/(k+1))^(k/(k−1)); Cd default 0.865; k default 1.27. Provisional (D17): no worked example verified (Q9); cross-check
//     X: at the same Cd it equals the isentropic gas nozzle of 49-calc-chokeperf.js with z = 1 within 0.5 %.
//   Valve mechanics (IPO, nitrogen-charged bellows, force balance; 49-calc-gaslift.js): dome at 60 °F from the test-rack opening
//     pressure p_d60 = p_tro·(1 − R); at the valve temperature p_d from the real-gas dome (WTS_gaslift_ct inverted); opening casing
//     pressure at depth p_vo = (p_d − R·p_t)/(1 − R); closing p_vc = p_d. A valve is open when p_c ≥ p_vo (orifice: always), and
//     passes gas when also p_c > p_t.
//   Diagnosis from a test (CHP, THP, lift gas, liquid and gas rates; M.tests rows carry chp_psig / qinj_Mscfd): casing pressure at
//     every valve from the CHP (static gas column over TVD at the flowing temperature), tubing pressure from the THP marched down the
//     path with the lift gas to the operating valve and with the formation gas below it (two marches); status per valve, operating
//     valve = the deepest valve that passes gas, multi-pointing (> 1), throughput (Thornhill-Craver at p_c, p_t) against the measured
//     lift gas, under- / over-injection against the reference rate (the performance-curve optimum or economic point, else the design
//     rate): under below 80 %, over above 120 %; lifting from a valve above the deepest (bottom) valve.
//   Flowing gradient survey (J3): import of (MD or TVD, p, T) rows (psig or psia; m, bar, kPa headers converted), residuals against
//     the solved traverse (RMS, bias, worst), and the gradient break of the survey — two straight lines in p against TVD fitted by least
//     squares over every split; the intersection is the injection depth read from the survey, compared with the valves.
//   Stability after Asheim (1988), written for this module from the lumped annulus–tubing description (provisional, D17; the paper's
//     coefficients could not be checked, Q9):
//     F1 = (dp_in/dq) / (dp_out/dq) at the operating point (inflow slope over the tubing-curve slope at a fixed lift-gas rate, the
//          solver's static criterion; ∞ on a rising tubing curve) — stable when F1 > 1;
//     F2 = |∂p_ti/∂q_gi| · |∂q_v/∂p_ti| — the loop gain of the injection: a higher tubing pressure at the valve passes less gas
//          (Thornhill-Craver slope; 0 when the port flow is critical) and less gas makes the column heavier (no-slip column above the
//          point, ∂p/∂v_G = −(H/144)·q_L·(ρ_L − ρ_G)/(q_L + v_G)², v_G = q_g·B_g) — stable when F2 < 1.
//     The static criterion does not predict heading dynamics (§21); both numbers are screening values.
//
// Interfaces (every result {ok, errors[], warnings[{code, msg, sev}]}; nothing throws for user data):
//   WTS_wp_gl (namespace shared with 49-calc-wp-lift.js)
//     .TC              {cd: 0.865, k: 1.27, abellows_in2: 0.77, ports: [8, 12, 16, 20, 24, 28, 32] (/64 in), verified: false, label}
//     .tc({port64 | d_in, cd?, p1, p2 (psia), T (°F), sg, k?}) → {ok, q, qCrit, r, rc, critical, area_in2, dqdp2 (Mscf/d per psi)}
//     .portR(port64, abellows?) → R = A_port / A_bellows
//     .context(M)      → {ok, F, I, W} the model's fluid, inflow and path (built like the system solver) | failure
//     .inputFor(M, R, o?) → {ok, input (the WTS_gaslift_compute input on the shared model), notes[]} | failure
//     .design(M, R, o?) → Job (step / done / progress / result / cancel); result() → {ok, gl (the WTS_gaslift_compute result),
//          valves:[{n, md, tvd, role, port, R, t, pso, pvo, pt, pd, pd60, ptro, pvcs, spacing, tc:{q, critical, r}, need, ok}],
//          operating:{n, md, tvd}, qinj, qL, port, portRec, capOk, inputs, warnings, errors, ms}
//     .valvesFromDesign(D) → rows for the model table glValves [{md, port, ptro, R, kind:'ipo'}]
//     .setValve(D, i, md) → design valve i re-set at MD md on the same surface opening pressure and design tubing line (casing p_vo at
//          its TVD and flowing temperature, dome / p_tro, Thornhill-Craver) — the page's drag of a valve; null when out of range
//     .pdAt(ptro, R, T) → the dome pressure (psig) at T from the test-rack opening pressure
//     .diagnose(M, R, valves, test, o?) → {ok, valves:[{n, md, tvd, t, port, R, kind, pc, pt, pd, pvo, pvc, open, passing, status,
//          q, critical}], operating:{n, md, tvd} | null, multi, qCap, qinj, ref, flags[{code, sev, msg}], tubing:[{md, tvd, p}],
//          casing:[{md, tvd, p}], verdict:'ok'|'warn'|'fail'}
//     .parseSurvey(text, o? {axis:'md'|'tvd', unit:'psig'|'psia'}) → {ok, rows:[{md?, tvd?, p psia, t?}], axis, unit, skipped, warnings}
//     .matchSurvey(M, R, rows, o? {W, valves}) → {ok, rows:[{md, tvd, p, pModel, dp, t?, tModel?, dt?}], n, rms, bias, maxAbs, rmsT,
//          brk:{md, tvd, p, gUp, gDown, sse} | null, nearValve:{n, md, tvd, dMd} | null, verdict}
//     .asheim(M, R, o? {port64, cd, W}) → {ok, F1, F2, stable1, stable2, verdict, parts{…}, label, verified:false, provisional}
// =============================================================================
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;

    var PATM = 14.696, RANK = 459.67, GFT = 32.16;
    var TC = { cd: 0.865, k: 1.27, abellows_in2: 0.77, ports: [8, 12, 16, 20, 24, 28, 32], verified: false, label: 'Thornhill-Craver' };
    var PROVISIONAL = 'provisional — not verified against a published example';
    // the valve design on the model path (deviated well, the model's inflow / correlation / temperatures): no published worked example
    // checked (Q9) → verified:false, labelled provisional on the card, verdicts, notes and report (review fix v4.5, BENCH lift glDesign)
    var DESIGN = { verified: false, label: 'Gas-lift valve design on the model path (spacing after API RP 11V6)' };
    var UNDER = 0.8, OVER = 1.2;
    var PORT_TXT = { 8: '1/8', 12: '3/16', 16: '1/4', 20: '5/16', 24: '3/8', 28: '7/16', 32: '1/2' };
    function _portTxt(p64) { return PORT_TXT[p64] || (p64 + '/64'); }

    function _fin(v) { return typeof v === 'number' && isFinite(v); }
    function _n(v) { if (typeof v === 'number') return isFinite(v) ? v : null; if (typeof v === 'string' && v.trim() !== '' && isFinite(+v)) return +v; return null; }
    function _w(code, msg, sev) { return { code: code, msg: String(msg).slice(0, 299), sev: sev === 'info' ? 'info' : (sev === 'fail' ? 'fail' : 'warn') }; }
    function _fail(code, errors, extra) { var r = { ok: false, code: code, errors: errors || [], warnings: [] }; if (extra) Object.keys(extra).forEach(function (k) { r[k] = extra[k]; }); return r; }
    function _f(x, dp) { if (!_fin(x)) return '–'; var s = (+x.toFixed(dp || 0)).toFixed(dp || 0), p = s.split('.'), ip = p[0], neg = ip.charAt(0) === '-', out = ''; if (neg) ip = ip.slice(1); while (ip.length > 3) { out = ',' + ip.slice(-3) + out; ip = ip.slice(0, -3); } return (neg ? '−' : '') + ip + out + (p[1] ? '.' + p[1] : ''); }
    function _fn(path) { var o = G, ks = path.split('.'); for (var i = 0; i < ks.length; i++) { if (!o) return null; o = o[ks[i]]; } return typeof o === 'function' ? o : null; }
    function _interp(rows, x, kx, ky) {
        if (!rows || !rows.length) return null;
        if (x <= rows[0][kx]) return rows[0][ky];
        for (var i = 1; i < rows.length; i++) if (x <= rows[i][kx]) { var a = rows[i - 1], b = rows[i], d = b[kx] - a[kx]; return d > 0 ? a[ky] + (b[ky] - a[ky]) * (x - a[kx]) / d : b[ky]; }
        return rows[rows.length - 1][ky];
    }

    // ── Thornhill-Craver ─────────────────────────────────────────────────────
    function portR(port64, ab) { var d = (+port64) / 64, A = Math.PI * d * d / 4; return A / ((+ab > 0) ? +ab : TC.abellows_in2); }
    function _tcRaw(A, cd, p1, p2, TR, sg, k) {
        var rc = Math.pow(2 / (k + 1), k / (k - 1)), r = Math.max(p2 / p1, rc);
        if (!(r < 1)) return { q: 0, r: p2 / p1, rc: rc, critical: false };
        var br = 2 * GFT * k / (k - 1) * (Math.pow(r, 2 / k) - Math.pow(r, (k + 1) / k));
        return { q: br > 0 ? 155.5 * cd * A * p1 * Math.sqrt(br) / Math.sqrt(sg * TR) : 0, r: p2 / p1, rc: rc, critical: p2 / p1 <= rc };
    }
    function tc(o) {
        o = o || {};
        var d = _fin(+o.d_in) && +o.d_in > 0 ? +o.d_in : (+o.port64 > 0 ? +o.port64 / 64 : NaN), cd = _fin(+o.cd) && +o.cd > 0 ? +o.cd : TC.cd, k = _fin(+o.k) && +o.k > 1 ? +o.k : TC.k;
        var p1 = +o.p1, p2 = +o.p2, T = +o.T, sg = +o.sg, errs = [];
        if (!(d > 0 && d < 2)) errs.push('port size');
        if (!(p1 > 0)) errs.push('upstream pressure');
        if (!(p2 > 0)) errs.push('downstream pressure');
        if (!_fin(T)) errs.push('temperature');
        if (!(sg > 0.4 && sg < 2)) errs.push('gas gravity');
        if (errs.length) return _fail('BAD_INPUT', ['Thornhill-Craver needs ' + errs.join(', ')]);
        var A = Math.PI * d * d / 4, TR = T + RANK, a = _tcRaw(A, cd, p1, p2, TR, sg, k), c = _tcRaw(A, cd, p1, p1 * a.rc * 0.999999, TR, sg, k);
        var h = Math.max(0.5, 1e-3 * p1), lo = _tcRaw(A, cd, p1, Math.max(1, p2 - h), TR, sg, k), hi = _tcRaw(A, cd, p1, Math.min(p1, p2 + h), TR, sg, k);
        var dq = (Math.min(p1, p2 + h) - Math.max(1, p2 - h)) > 0 ? (hi.q - lo.q) / (Math.min(p1, p2 + h) - Math.max(1, p2 - h)) : 0;
        if (a.critical) dq = 0;
        return { ok: true, q: p2 >= p1 ? 0 : a.q, qCrit: c.q, r: p2 / p1, rc: a.rc, critical: a.critical, area_in2: A, cd: cd, k: k, dqdp2: dq, errors: [], warnings: [] };
    }

    // ── the shared model: fluid, inflow and path (as the system solver builds them) ───────────────────────────
    function context(M) {
        var need = ['WTS_wp_fluid.build', 'WTS_wp_ipr.curve', 'WTS_wp_well.build', 'WTS_wp_well.segmentsFor'];
        for (var i = 0; i < need.length; i++) if (!_fn(need[i])) return _fail('MISSING_ENGINE', [need[i] + ' is not available']);
        if (!M || !M.fluid || !M.res || !M.well) return _fail('NO_MODEL', ['the model is incomplete']);
        var type = M.fluid.type || 'oil';
        if (type !== 'oil' && type !== 'water') return _fail('GL_NOT_APPLICABLE', ['Gas-lift design is for oil (and water) producers; this is a ' + type + ' well.']);
        var F = G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F, table: false });
        if (!F || !F.ok) return _fail('NEEDS_FLUID', (F && F.errors && F.errors.length) ? F.errors : ['the fluid is incomplete']);
        var W = G.WTS_wp_well.build(M.well, { res: M.res, fluidType: type, tests: M.tests, surface: M.surface });
        if (!W || !W.ok) return _fail('NEEDS_WELL', (W && W.errors && W.errors.length) ? W.errors : ['the well has no flow path']);
        var I = G.WTS_wp_ipr.curve(M.res, F, { tvdAt: W.tvdAt, refMd: W.nodes ? W.nodes.midPerfMd : null });
        if (!I || !I.ok || I.inj) return _fail('NEEDS_IPR', (I && I.errors && I.errors.length) ? I.errors : ['the inflow is incomplete']);
        return { ok: true, F: F, I: I, W: W, errors: [], warnings: [] };
    }
    // the flowing temperature along the hole: the operating solve's traverse (linear, relaxation or enthalpy profile), else W.tAt
    function _tAtFrom(R, W) {
        var rows = R && R.ok && R.traverse && Array.isArray(R.traverse.profile) ? R.traverse.profile.filter(function (r) { return r && _fin(r.md) && _fin(r.t); }).slice().sort(function (a, b) { return a.md - b.md; }) : [];
        if (rows.length >= 2) return { src: (R.heat && R.heat.mode) || 'linear', fn: function (md) { return _interp(rows, md, 'md', 't'); } };
        return { src: 'linear', fn: function (md) { return W.tAt ? W.tAt(md) : NaN; } };
    }
    function _gld(M) { var g = (M.lift && M.lift.gl) || {}; return g.design || {}; }
    function _corrOf(M, R) { var c = (R && R.corr && R.corr.well) || (M.system && M.system.corr && M.system.corr.well) || null; var REG = G.WTS_flowline_corr || {}; return c && REG[c] && !REG[c].gasOnly ? String(c) : null; }

    function inputFor(M, R, o) {
        o = o || {};
        var X = o.ctx || context(M); if (!X.ok) return X;
        var F = X.F, I = X.I, W = X.W, gl = (M.lift && M.lift.gl) || {}, d = _gld(M), notes = [];
        var pso = _n(gl.pinj_psig); if (!(pso > 0)) return _fail('NEEDS_PINJ', ['Enter the surface injection (casing) pressure (step ④).']);
        var qinj = _fin(_n(o.qinj)) ? _n(o.qinj) : _n(gl.qinj_Mscfd);
        if (!(qinj > 0)) return _fail('NEEDS_QINJ', ['Set the lift-gas injection rate (step ④) or run the performance curve and use the optimum: the design injects that rate.']);
        var rt = R && R.ok && R.rates ? R.rates : null;
        var qL = _fin(_n(o.qL)) ? _n(o.qL) : (_n(d.qL) > 0 ? _n(d.qL) : (rt && _fin(rt.qL) ? rt.qL : null));
        if (!(qL > 0)) return _fail('NEEDS_RATE', ['No design liquid rate: solve the well with gas lift, or enter the design rate.']);
        var wc = rt && rt.qL > 0 && _fin(rt.qw) ? rt.qw / rt.qL : (_fin(+F.wc) ? +F.wc : 0);
        var qo = qL * (1 - wc), qw = qL * wc;
        var pwh = _fin(_n(o.pwh)) ? _n(o.pwh) : (R && R.ok && R.surface && _fin(R.surface.thp_psig) ? R.surface.thp_psig : _n(M.system && M.system.thp_psig));
        if (!(pwh >= 0)) return _fail('NEEDS_THP', ['No flowing wellhead pressure: solve the well first.']);
        var mid = W.nodes.midPerfMd, shoe = _fin(W.nodes.tubingShoeMd) ? W.nodes.tubingShoeMd : mid;
        var pk = _n(gl.packerMd); if (!(pk > 0) || pk > Math.min(shoe, mid)) pk = Math.min(shoe, mid);
        var dmax = _n(d.dmaxMd) > 0 ? Math.min(_n(d.dmaxMd), pk) : Math.max(200, pk - 30);
        var segs = G.WTS_wp_well.segmentsFor(W, { from: mid, toMd: 0 });
        if (!Array.isArray(segs) || !segs.length) return _fail('NEEDS_WELL', ['the well has no flow path from the mid-perforations']);
        var tA = _tAtFrom(R, W), port = _n(d.port64) > 0 ? _n(d.port64) : 16, Rv = _n(d.R) > 0 && _n(d.R) < 0.5 ? _n(d.R) : portR(port);
        var gor = _fin(+F.gor) ? +F.gor : (_fin(+M.fluid.gor) ? +M.fluid.gor : 0), glrF = qL > 0 ? qo * gor / qL : 0;
        var input = {
            qo: qo, qw: qw, gor: gor, api: +F.api || +M.fluid.api, sgg: +F.sgg || +M.fluid.sgg, sgw: Math.min(1.3, Math.max(0.95, +F.sgw || +M.fluid.sgw || 1.07)),
            sginj: _n(gl.sginj) > 0 ? _n(gl.sginj) : 0.65, pr: I.pr - PATM, pi: 1, dmax: dmax, rough: _fin(+W.rough) && +W.rough >= 0 ? +W.rough : 0.0018,
            pwh: pwh, twh: tA.fn(0), bht: Math.max(tA.fn(0), tA.fn(mid)), pko: _n(d.pko_psig) > 0 ? _n(d.pko_psig) : pso + 100, pso: pso,
            glr: glrF + qinj * 1000 / qL, dpv: _fin(_n(gl.dpValve)) && _n(gl.dpValve) >= 0 ? _n(gl.dpValve) : 100, dpdrop: _fin(_n(d.dpdrop)) && _n(d.dpdrop) >= 0 ? _n(d.dpdrop) : 25,
            gs: _n(d.gs) > 0 ? _n(d.gs) : 0.465, ftub: _fin(_n(d.ftub)) && _n(d.ftub) >= 0 ? _n(d.ftub) : 20, minsp: _fin(_n(d.minsp)) && _n(d.minsp) >= 0 ? _n(d.minsp) : 250, R: Rv,
            ipr: I, segments: segs, tAt: tA.fn, corr: _corrOf(M, R), pvt: F.pvt
        };
        if (!_n(d.pko_psig)) notes.push('kickoff pressure = injection pressure + 100 psi (default)');
        notes.push('valve temperatures from the ' + tA.src + ' flowing profile of the operating solve');
        return { ok: true, input: input, qinj: qinj, qL: qL, port: port, R: Rv, packerMd: pk, tSrc: tA.src, notes: notes, ctx: X, errors: [], warnings: [] };
    }

    // throughput of every designed valve at its opening conditions; the operating valve against the design injection rate
    function _throughput(D, In, port) {
        var sg = In.input.sginj, need = In.qinj, rows = [];
        D.valves.forEach(function (v) {
            var t = tc({ port64: port, p1: v.pvo + PATM, p2: v.pt + PATM, T: v.t, sg: sg });
            rows.push({ n: v.n, md: _fin(v.md) ? v.md : v.d, tvd: _fin(v.tvd) ? v.tvd : v.d, role: v.role, port: port, R: In.R, t: v.t, pso: v.pso, pvo: v.pvo, pt: v.pt,
                pd: v.pd, pd60: v.pd60, ptro: v.ptro, pvcs: v.pvcs, spacing: v.spacing, ct: v.ct,
                tc: t.ok ? { q: t.q, critical: t.critical, r: t.r, rc: t.rc } : null, need: v.role === 'Operating' ? need : null,
                ok: v.role !== 'Operating' || !(t.ok) || t.q >= need });
        });
        var op = rows.filter(function (r) { return r.role === 'Operating'; })[0] || null;
        // the smallest port that passes 110 % of the design rate at the operating valve
        var rec = null;
        if (op) TC.ports.some(function (p64) { var t = tc({ port64: p64, p1: op.pvo + PATM, p2: op.pt + PATM, T: op.t, sg: sg }); if (t.ok && t.q >= 1.1 * need) { rec = p64; return true; } return false; });
        return { rows: rows, op: op, rec: rec };
    }

    function design(M, R, o) {
        o = o || {};
        var st = { i: 0, done: false, res: null, cancelled: false, In: null, D: null, t0: Date.now() };
        function finish() {
            if (st.res) return st.res;
            if (st.cancelled) { st.res = _fail('CANCELLED', ['cancelled']); st.res.cancelled = true; return st.res; }
            if (st.In && !st.In.ok) { st.res = st.In; return st.res; }
            var D = st.D;
            if (!D || !D.ok) { st.res = _fail(D && D.bad ? 'BAD_INPUT' : 'DESIGN_FAILED', (D && D.errors) || ['the design failed'], { inputs: st.In ? st.In.input : null }); return st.res; }
            var T = _throughput(D, st.In, st.In.port), warnings = [];
            (D.warnings || []).forEach(function (t) { warnings.push(_w('GL_DESIGN', t, 'info')); });
            if (D.spacingFail) warnings.push(_w('GL_SPACING', 'The unloading valves cannot reach the point of injection: the spacing stops after valve ' + D.spacingFail.after + ' (' + _f(D.spacingFail.d, 0) + ' ft MD). Raise the kickoff pressure or lower the kill-fluid gradient.'));
            if (T.op && T.op.tc && T.op.tc.q < st.In.qinj) warnings.push(_w('GL_PORT_SMALL', 'The ' + _portTxt(T.op.port) + ' in port of the operating valve passes ' + _f(T.op.tc.q, 0) + ' Mscf/d at its opening conditions, less than the design ' + _f(st.In.qinj, 0) + ' Mscf/d' + (T.rec ? ': use ' + _portTxt(T.rec) + ' in.' : '.')));
            if (T.op && T.op.tc && !T.op.tc.critical) warnings.push(_w('GL_SUBCRITICAL', 'Port flow at the operating valve is sub-critical (p_t/p_c ' + _f(T.op.tc.r, 2) + ' > ' + _f(T.op.tc.rc, 2) + '): the injection follows the tubing pressure (heading risk; see the stability numbers).', 'info'));
            warnings.push(_w('TC_PROVISIONAL', 'Thornhill-Craver valve throughput is ' + PROVISIONAL + '.', 'info'));
            warnings.push(_w('GLD_PROVISIONAL', DESIGN.label + ': ' + PROVISIONAL + '.', 'info'));
            st.res = { ok: true, gl: D, valves: T.rows, operating: T.op ? { n: T.op.n, md: T.op.md, tvd: T.op.tvd } : null, qinj: st.In.qinj, qL: st.In.qL, port: st.In.port, R: st.In.R,
                portRec: T.rec, capOk: !!(T.op && T.op.ok), packerMd: st.In.packerMd, tSrc: st.In.tSrc, inputs: (function () { var c = {}; Object.keys(st.In.input).forEach(function (k) { if (k !== 'ipr' && k !== 'segments' && k !== 'tAt' && k !== 'pvt') c[k] = st.In.input[k]; }); return c; })(),
                notes: st.In.notes, warnings: warnings, errors: [], ms: Date.now() - st.t0, provisional: [DESIGN.label, TC.label], verified: false };
            // kept for setValve (a valve dragged to another depth is re-set on the same design lines); functions, not serialised
            Object.defineProperty(st.res, '_tAt', { value: st.In.input.tAt, enumerable: false });
            Object.defineProperty(st.res, '_tvdAt', { value: st.In.ctx.W.tvdAt, enumerable: false });
            return st.res;
        }
        var steps = [
            function () { st.In = inputFor(M, R, o); return !st.In.ok; },
            function () { if (typeof G.WTS_gaslift_compute !== 'function') { st.In = _fail('MISSING_ENGINE', ['WTS_gaslift_compute is not available']); return true; } st.D = G.WTS_gaslift_compute(st.In.input); return true; }
        ];
        var J = {
            n: steps.length,
            step: function () {
                if (!st.done && !st.cancelled) { var stop = steps[st.i++](); if (stop || st.i >= steps.length) st.done = true; } else st.done = true;
                if (st.done) finish();
                return { done: st.done, progress: st.done ? 1 : st.i / steps.length, label: st.done ? 'done' : 'spacing the unloading valves on the deviated path' };
            },
            done: function () { return st.done; },
            progress: function () { return st.done ? 1 : st.i / steps.length; },
            result: function () { while (!st.done) J.step(); return finish(); },
            cancel: function () { st.cancelled = true; st.done = true; st.res = null; }
        };
        return J;
    }
    // a designed valve moved to MD md (the page's drag): its casing opening pressure on the same surface opening pressure, the design
    // tubing line at its TVD, the dome and test-rack settings at its temperature and its Thornhill-Craver throughput → a new valve row
    function setValve(Dr, i, md) {
        if (!Dr || !Dr.ok || !Dr.valves || !Dr.valves[i] || !(md > 0)) return null;
        var v = Dr.valves[i], g = Dr.gl, In = Dr.inputs, tvdAt = Dr._tvdAt || function (x) { return x; }, tAt = Dr._tAt || function () { return v.t; };
        var tvd = tvdAt(md), T = tAt(md), Rv = v.R, cp = G.WTS_gaslift_casingP(v.pso, Math.max(0, tvd), In.sginj, In.twh, T);
        if (!cp || !_fin(cp.p)) return null;
        var poiT = _fin(g.poiValveTvd) ? g.poiValveTvd : g.poiValve, pt = g.pts + (g.ptPoi - g.pts) * tvd / (poiT || 1), pd = cp.p * (1 - Rv) + pt * Rv;
        var c = G.WTS_gaslift_ct(pd + PATM, T), pd60 = c.ct * (pd + PATM) - PATM, t = tc({ port64: v.port, p1: cp.p + PATM, p2: pt + PATM, T: T, sg: In.sginj });
        var out = {}; Object.keys(v).forEach(function (k) { out[k] = v[k]; });
        out.md = md; out.tvd = tvd; out.t = T; out.pvo = cp.p; out.pt = pt; out.pd = pd; out.ct = c.ct; out.pd60 = pd60; out.ptro = pd60 / (1 - Rv); out.moved = true;
        out.tc = t.ok ? { q: t.q, critical: t.critical, r: t.r, rc: t.rc } : null; out.ok = v.role !== 'Operating' || !t.ok || t.q >= (v.need || 0);
        return out;
    }
    function valvesFromDesign(Dr) {
        if (!Dr || !Dr.ok) return [];
        return Dr.valves.map(function (v) { return { md: Math.round(v.md), port: v.port, ptro: Math.round(v.ptro), R: +(+v.R).toFixed(4), kind: 'ipo' }; });
    }

    // dome pressure at the valve temperature from the test-rack opening pressure (inverse of WTS_gaslift_ct: p_d60 = C_t·p_d)
    function _pdAt(ptro, Rv, tF) {
        var p60 = ptro * (1 - Rv) + PATM, pT = p60;
        if (typeof G.WTS_gaslift_ct !== 'function') return p60 - PATM;
        for (var k = 0; k < 12; k++) { var c = G.WTS_gaslift_ct(pT, tF); if (!c || !_fin(c.ct) || !(c.ct > 0)) break; var pn = p60 / c.ct; if (Math.abs(pn - pT) < 1e-6) { pT = pn; break; } pT = pn; }
        return pT - PATM;
    }
    function _cleanValves(valves, W) {
        return (Array.isArray(valves) ? valves : []).map(function (v, i) {
            var md = _n(v && v.md); if (!(md > 0)) return null;
            var kind = v.kind === 'orifice' || v.kind === 'dummy' ? v.kind : 'ipo', port = _n(v.port) > 0 ? _n(v.port) : 16;
            return { md: md, tvd: W && W.tvdAt ? W.tvdAt(md) : md, port: port, ptro: _n(v.ptro), R: _n(v.R) > 0 && _n(v.R) < 0.5 ? _n(v.R) : portR(port), kind: kind, i: i };
        }).filter(Boolean).sort(function (a, b) { return a.md - b.md; });
    }
    // a top-down march of the shared path from the THP to MD toMd (lift gas included or not); → rows [{md, p psia}]
    function _down(X, M, R, toMd, fl, thp, tFn) {
        var segs = G.WTS_wp_well.segmentsFor(X.W, { from: toMd, toMd: 0 });
        if (!Array.isArray(segs) || !segs.length || typeof G.WTS_flowline_march !== 'function') return null;
        var o = { reverse: true, rough: _fin(+X.W.rough) ? +X.W.rough : 0.0018, payne: true, accel: false, tAt: function (x) { return tFn(x); } }, c = _corrOf(M, R);
        if (c) o.corr = c;
        var m = G.WTS_flowline_march(segs.slice().reverse(), fl, thp, tFn(0), tFn(toMd), o);
        if (!m || m.ok === false) return null;
        return { rows: (m.profile || []).filter(function (r) { return _fin(r.x) && _fin(r.p); }).map(function (r) { return { md: r.x, p: r.p + PATM }; }), lost: m.lost || null };
    }
    function diagnose(M, R, valves, test, o) {
        o = o || {};
        var X = o.ctx || context(M); if (!X.ok) return X;
        var W = X.W, F = X.F, gl = (M.lift && M.lift.gl) || {}, sg = _n(gl.sginj) > 0 ? _n(gl.sginj) : 0.65, t = test || {};
        var V = _cleanValves(valves, W);
        if (!V.length) return _fail('NO_VALVES', ['No gas-lift valves: run the design and use it, or enter the mandrel depths.']);
        var chp = _n(t.chp_psig), thp = _n(t.thp_psig), qinj = _n(t.qinj_Mscfd), qo = _n(t.q_o), qw = _n(t.q_w), qgm = _n(t.q_g);
        var miss = [];
        if (!(chp > 0)) miss.push('casing pressure (CHP)'); if (!(thp >= 0)) miss.push('THP'); if (!(qinj >= 0)) miss.push('lift-gas rate');
        if (!((qo || 0) + (qw || 0) > 0)) miss.push('liquid rate');
        if (miss.length) return _fail('NEEDS_TEST', ['The diagnosis needs the ' + miss.join(', ') + ' of a test (step ⑥, test table).']);
        qo = qo || 0; qw = qw || 0;
        var gor = _fin(+F.gor) ? +F.gor : 0, qgF = (qgm > qinj) ? (qgm - qinj) : qo * gor / 1000;   // Mscf/d of formation gas
        if (!(qgm > qinj) && qgm != null) qgF = qo * gor / 1000;
        var tA = _tAtFrom(R, W).fn, deep = V[V.length - 1].md;
        var base = function (qgMs, sgm) { var f = G.WTS_wp_fluid.flowlineFluid(F, { qo: qo, qw: qw, qg_Mscfd: qgMs }); var c = {}; Object.keys(f).forEach(function (k) { c[k] = f[k]; }); c.sgg = sgm; if (c.pvt) { var p = {}; Object.keys(c.pvt).forEach(function (k) { if (k !== 'table' && k !== 'injGas') p[k] = c.pvt[k]; }); c.pvt = p; } return c; };
        var sgMix = (qgF + qinj) > 0 ? (qgF * (+F.sgg || 0.65) + qinj * sg) / (qgF + qinj) : (+F.sgg || 0.65);
        var up = _down(X, M, R, deep, base(qgF + qinj, sgMix), thp, tA);
        if (!up || !up.rows.length) return _fail('TRAVERSE_FAILED', ['The tubing traverse from the test THP failed.']);
        var pcAt = function (md) { var tvd = W.tvdAt ? W.tvdAt(md) : md, r = G.WTS_gaslift_casingP(chp, Math.max(0, tvd), sg, tA(0), tA(md)); return r && _fin(r.p) ? r.p + PATM : NaN; };
        function evalAt(ptOf) {
            return V.map(function (v, k) {
                var T = tA(v.md), pc = pcAt(v.md), pt = ptOf(v.md), out = { n: k + 1, md: v.md, tvd: v.tvd, t: T, port: v.port, R: v.R, kind: v.kind, ptro: v.ptro, pc: pc, pt: pt };
                if (v.kind === 'dummy') { out.open = false; out.passing = false; out.status = 'dummy'; return out; }
                if (v.kind === 'orifice' || !_fin(v.ptro)) { out.open = true; out.status = v.kind === 'orifice' ? 'orifice' : 'no setting'; }
                else {
                    out.pd = _pdAt(v.ptro, v.R, T) + PATM;
                    out.pvo = (out.pd - v.R * pt) / (1 - v.R); out.pvc = out.pd;
                    // an IPO valve opens at p_vo and, once open (unloading opened it), closes only below p_vc = p_d
                    out.open = pc >= out.pvc;
                    out.held = out.open && pc < out.pvo;
                }
                out.passing = !!out.open && pc > pt;
                if (out.passing) { var q = tc({ port64: v.port, p1: pc, p2: pt, T: T, sg: sg }); out.q = q.ok ? q.q : null; out.critical = q.ok ? q.critical : null; out.r = q.ok ? q.r : null; }
                out.status = out.status && out.status !== 'no setting' ? out.status : (out.passing ? (out.held ? 'open (held above closing) — injecting' : 'open — injecting') : (out.open ? 'open — no flow (p_c ≤ p_t)' : 'closed'));
                if (!_fin(v.ptro) && v.kind !== 'orifice') out.status = out.passing ? 'injecting (no setting)' : 'no flow (no setting)';
                return out;
            });
        }
        var ptUp = function (md) { return _interp(up.rows, md, 'md', 'p'); };
        var rows = evalAt(ptUp), opI = -1;
        rows.forEach(function (r, k) { if (r.passing) opI = k; });
        var tub = up.rows.slice(), lowRows = null;
        // below the operating valve the tubing carries the formation gas only: march on from the valve with the formation fluid
        if (opI >= 0 && opI < rows.length - 1) {
            var mdOp = rows[opI].md, pOp = ptUp(mdOp), segs = G.WTS_wp_well.segmentsFor(W, { from: deep, toMd: mdOp });
            if (Array.isArray(segs) && segs.length) {
                var oo = { reverse: true, rough: _fin(+W.rough) ? +W.rough : 0.0018, payne: true, accel: false, tAt: function (x) { return tA(mdOp + x); } }, c2 = _corrOf(M, R);
                if (c2) oo.corr = c2;
                var m2 = G.WTS_flowline_march(segs.slice().reverse(), base(qgF, +F.sgg || 0.65), pOp - PATM, tA(mdOp), tA(deep), oo);
                if (m2 && m2.ok !== false && m2.profile) {
                    lowRows = m2.profile.filter(function (r) { return _fin(r.x) && _fin(r.p); }).map(function (r) { return { md: mdOp + r.x, p: r.p + PATM }; });
                    var ptOf2 = function (md) { return md <= mdOp ? ptUp(md) : _interp(lowRows, md, 'md', 'p'); };
                    rows = evalAt(ptOf2); opI = -1; rows.forEach(function (r, k) { if (r.passing) opI = k; });
                    tub = up.rows.filter(function (r) { return r.md <= mdOp; }).concat(lowRows.filter(function (r) { return r.md > mdOp; }));
                }
            }
        }
        var passing = rows.filter(function (r) { return r.passing; }), qCap = passing.reduce(function (a, r) { return a + (_fin(r.q) ? r.q : 0); }, 0);
        var flags = [], op = opI >= 0 ? rows[opI] : null;
        var ref = _fin(_n(o.ref)) && _n(o.ref) > 0 ? _n(o.ref) : (_n(gl.qinj_Mscfd) > 0 ? _n(gl.qinj_Mscfd) : null), refSrc = o.refSrc || 'the design injection rate';
        if (!op) flags.push(_w('GL_NO_VALVE', 'No valve passes gas at this CHP and THP: the casing pressure is below every opening pressure or below the tubing pressure (check the CHP, the valve settings or a plugged valve).', 'fail'));
        else {
            if (passing.length > 1) flags.push(_w('GL_MULTIPOINT', 'Multi-pointing: ' + passing.length + ' valves pass gas (' + passing.map(function (r) { return 'valve ' + r.n + ' ' + _f(r.md, 0) + ' ft MD'; }).join(', ') + ').'));
            if (opI < rows.length - 1 && rows.slice(opI + 1).some(function (r) { return r.kind !== 'dummy'; })) flags.push(_w('GL_SHALLOW', 'Lifting from valve ' + op.n + ' (' + _f(op.md, 0) + ' ft MD · ' + _f(op.tvd, 0) + ' ft TVD), above the deepest valve: the well is not unloaded to the bottom valve.'));
            if (qinj > 0 && qCap > 0 && qinj > 1.15 * qCap) flags.push(_w('GL_THROUGHPUT', 'The measured lift gas (' + _f(qinj, 0) + ' Mscf/d) is more than the open valves pass (' + _f(qCap, 0) + ' Mscf/d, Thornhill-Craver): a leak, a hole in the tubing or a wrong gas meter.'));
            if (qinj > 0 && qCap > 0 && qinj < 0.5 * qCap && op.critical === false) flags.push(_w('GL_THROTTLED', 'The open valves could pass ' + _f(qCap, 0) + ' Mscf/d but ' + _f(qinj, 0) + ' Mscf/d is metered: the surface gas supply limits the injection.', 'info'));
            if (op.critical === false) flags.push(_w('GL_SUBCRITICAL', 'Port flow at the operating valve is sub-critical (p_t/p_c ' + _f(op.r, 2) + '): the injection follows the tubing pressure (heading risk).', 'info'));
        }
        if (ref && qinj >= 0) {
            if (qinj < UNDER * ref) flags.push(_w('GL_UNDER', 'Under-injection: ' + _f(qinj, 0) + ' Mscf/d against ' + _f(ref, 0) + ' Mscf/d (' + refSrc + ').'));
            else if (qinj > OVER * ref) flags.push(_w('GL_OVER', 'Over-injection: ' + _f(qinj, 0) + ' Mscf/d against ' + _f(ref, 0) + ' Mscf/d (' + refSrc + '): the extra gas adds little rate.'));
        }
        var verdict = flags.some(function (f) { return f.sev === 'fail'; }) ? 'fail' : (flags.some(function (f) { return f.sev === 'warn'; }) ? 'warn' : 'ok');
        var cas = []; for (var k = 0; k <= 20; k++) { var md = deep * k / 20; cas.push({ md: md, tvd: W.tvdAt ? W.tvdAt(md) : md, p: pcAt(md) }); }
        return { ok: true, valves: rows, operating: op ? { n: op.n, md: op.md, tvd: op.tvd } : null, multi: passing.length > 1, qCap: qCap, qinj: qinj, ref: ref, refSrc: refSrc,
            flags: flags, verdict: verdict, tubing: tub.map(function (r) { return { md: r.md, tvd: W.tvdAt ? W.tvdAt(r.md) : r.md, p: r.p }; }), casing: cas,
            test: { chp_psig: chp, thp_psig: thp, qinj_Mscfd: qinj, q_o: qo, q_w: qw, qgF_Mscfd: qgF, id: t.id || null }, errors: [], warnings: [] };
    }

    // ── flowing gradient survey (J3) ─────────────────────────────────────────
    function parseSurvey(text, o) {
        o = o || {};
        var lines = String(text == null ? '' : text).split(/\r?\n/).map(function (l) { return l.trim(); }).filter(function (l) { return l && !/^#/.test(l); });
        var axis = o.axis === 'tvd' ? 'tvd' : 'md', unit = o.unit === 'psia' ? 'psia' : 'psig', fL = 1, fP = 1, cols = { d: 0, p: 1, t: 2 }, rows = [], skipped = 0, warnings = [], tC = false;
        if (lines.length && /[a-z]/i.test(lines[0]) && !/^[-+\d.]/.test(lines[0])) {
            var h0 = lines.shift().toLowerCase(), h = h0.split(/[,;\t]+|\s{2,}/).map(function (x) { return x.trim(); }).filter(function (x) { return x !== ''; });
            if (h.length < 2) h = h0.split(/\s+/).filter(function (x) { return x !== ''; });
            h.forEach(function (x, i) {
                if (/tvd/.test(x)) { cols.d = i; axis = 'tvd'; } else if (/md|depth/.test(x)) { cols.d = i; if (!/tvd/.test(x)) axis = o.axis === 'tvd' ? 'tvd' : 'md'; }
                if (/^p|press/.test(x)) { cols.p = i; if (/psia/.test(x)) unit = 'psia'; else if (/psig/.test(x)) unit = 'psig'; else if (/kpa/.test(x)) { fP = 0.1450377; unit = /a\)?$|kpaa/.test(x) ? 'psia' : 'psig'; } else if (/bar/.test(x)) { fP = 14.50377; unit = /bara/.test(x) ? 'psia' : 'psig'; } }
                if (/^t|temp/.test(x) && !/tvd/.test(x)) { cols.t = i; if (/°?c\)?$|degc|\(c\)/.test(x)) tC = true; }
                if ((/md|tvd|depth/.test(x)) && /\(m\)|\bm\b|metre|meter/.test(x)) fL = 1 / 0.3048;
            });
        }
        lines.forEach(function (l) {
            var a = l.split(/[,;\t ]+/).map(function (x) { return x.trim(); }).filter(function (x) { return x !== ''; }).map(Number);
            var d = a[cols.d], p = a[cols.p], t = a.length > cols.t ? a[cols.t] : NaN;
            if (!_fin(d) || !_fin(p) || d < 0 || p <= 0) { skipped++; return; }
            var r = {}; r[axis] = d * fL; r.p = p * fP + (unit === 'psig' ? PATM : 0); if (_fin(t)) r.t = tC ? t * 9 / 5 + 32 : t;
            rows.push(r);
        });
        rows.sort(function (x, y) { return x[axis] - y[axis]; });
        if (rows.length > 400) { warnings.push(_w('SURVEY_LONG', 'Only the first 400 survey points are used.', 'info')); rows = rows.slice(0, 400); }
        if (skipped) warnings.push(_w('SURVEY_SKIPPED', skipped + ' line(s) were not read (depth and pressure needed).', 'info'));
        return { ok: rows.length >= 2, rows: rows, axis: axis, unit: unit, skipped: skipped, warnings: warnings, errors: rows.length >= 2 ? [] : ['At least two survey points (depth, pressure) are needed.'] };
    }
    function _line(pts) {          // least squares p = a + b·tvd
        var n = pts.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
        pts.forEach(function (q) { sx += q.x; sy += q.y; sxx += q.x * q.x; sxy += q.x * q.y; });
        var den = n * sxx - sx * sx; if (!(Math.abs(den) > 1e-12)) return null;
        var b = (n * sxy - sx * sy) / den, a = (sy - b * sx) / n, sse = 0;
        pts.forEach(function (q) { var e = q.y - a - b * q.x; sse += e * e; });
        return { a: a, b: b, sse: sse };
    }
    function matchSurvey(M, R, rows, o) {
        o = o || {};
        if (!R || !R.ok || !R.traverse || !Array.isArray(R.traverse.profile)) return _fail('NO_SOLVE', ['Solve the well first: the survey is compared with the solved traverse.']);
        var W = o.W || (context(M).W);
        if (!W) return _fail('NEEDS_WELL', ['the well has no path']);
        var prof = R.traverse.profile.filter(function (r) { return r && _fin(r.md) && _fin(r.p) && !r.restr; }).slice().sort(function (a, b) { return a.md - b.md; });
        var mdOf = function (r) { return _fin(r.md) ? r.md : (W.mdAt ? W.mdAt(r.tvd) : r.tvd); }, tvdOf = function (r, md) { return _fin(r.tvd) ? r.tvd : (W.tvdAt ? W.tvdAt(md) : md); };
        var out = [], s2 = 0, sb = 0, mx = 0, st2 = 0, nt = 0, mdEnd = prof.length ? prof[prof.length - 1].md : 0;
        (rows || []).forEach(function (r) {
            var md = mdOf(r); if (!_fin(md) || md > mdEnd + 1) return;
            var tvd = tvdOf(r, md), pm = _interp(prof, md, 'md', 'p'), x = { md: md, tvd: tvd, p: r.p, pModel: pm, dp: r.p - pm };
            if (_fin(r.t)) { x.t = r.t; x.tModel = _interp(prof, md, 'md', 't'); x.dt = _fin(x.tModel) ? r.t - x.tModel : null; if (_fin(x.dt)) { st2 += x.dt * x.dt; nt++; } }
            s2 += x.dp * x.dp; sb += x.dp; mx = Math.max(mx, Math.abs(x.dp)); out.push(x);
        });
        if (!out.length) return _fail('NO_POINTS', ['No survey point lies on the solved path.']);
        var n = out.length, res = { ok: true, rows: out, n: n, rms: Math.sqrt(s2 / n), bias: sb / n, maxAbs: mx, rmsT: nt ? Math.sqrt(st2 / nt) : null, brk: null, nearValve: null, errors: [], warnings: [] };
        // gradient break: two lines in p against TVD, every split with ≥ 2 points each side
        if (n >= 4) {
            var pts = out.map(function (x) { return { x: x.tvd, y: x.p }; }), best = null;
            for (var k = 2; k <= n - 2; k++) {
                var a = _line(pts.slice(0, k)), b = _line(pts.slice(k));
                if (!a || !b) continue;
                if (!best || a.sse + b.sse < best.sse) best = { k: k, a: a, b: b, sse: a.sse + b.sse };
            }
            if (best && best.b.b > best.a.b * 1.15) {
                var xi = Math.abs(best.a.b - best.b.b) > 1e-9 ? (best.b.a - best.a.a) / (best.a.b - best.b.b) : (pts[best.k - 1].x + pts[best.k].x) / 2;
                xi = Math.max(pts[best.k - 1].x, Math.min(pts[best.k].x, xi));
                var mdI = W.mdAt ? W.mdAt(xi) : xi;
                res.brk = { tvd: xi, md: _fin(mdI) ? mdI : xi, p: best.a.a + best.a.b * xi, gUp: best.a.b, gDown: best.b.b, sse: best.sse };
                var V = _cleanValves(o.valves, W);
                if (V.length && _fin(res.brk.md)) {
                    var nv = null; V.forEach(function (v, i) { var dd = Math.abs(v.md - res.brk.md); if (!nv || dd < nv.dMd) nv = { n: i + 1, md: v.md, tvd: v.tvd, dMd: dd }; });
                    res.nearValve = nv;
                }
            }
        }
        res.verdict = res.rms <= 25 ? 'ok' : (res.rms <= 75 ? 'warn' : 'fail');
        return res;
    }

    // ── stability after Asheim (1988), provisional ───────────────────────────
    function asheim(M, R, o) {
        o = o || {};
        if (!R || !R.ok || !R.op || !R.lift || R.lift.type !== 'gaslift') return _fail('NOT_LIFTED', ['The stability numbers need a gas-lifted operating point.']);
        var X = o.ctx || context(M); if (!X.ok) return X;
        var I = X.I, F = X.F, q = R.op.q, h = Math.max(1, 0.01 * q);
        var p1 = I.pwfAt(Math.max(0, q - h)), p2 = I.pwfAt(q + h), dIn = (_fin(p1) && _fin(p2)) ? (p2 - p1) / (2 * h) : null;   // psi per (STB/d), < 0
        var dD = R.op.dDdq, dOut = _fin(dD) && _fin(dIn) ? dD + dIn : null;
        var F1 = (_fin(dOut) && dOut < 0 && _fin(dIn)) ? dIn / dOut : Infinity;
        // the lifted column above the injection point (no-slip, average conditions)
        var L = R.lift, H = _fin(L.injTvd) ? L.injTvd : null, pti = L.pTub, pca = L.pCas, thp = R.surface && _fin(R.surface.thp) ? R.surface.thp : (R.surface && _fin(R.surface.thp_psig) ? R.surface.thp_psig + PATM : null);
        var tA = _tAtFrom(R, X.W).fn, pAvg = _fin(thp) && _fin(pti) ? (thp + pti) / 2 : pti, tAvg = (tA(0) + tA(L.injMd)) / 2;
        var sg = _n(L.sginj) > 0 ? _n(L.sginj) : 0.65, port = _n(o.port64) > 0 ? _n(o.port64) : 16, gl = M.lift.gl || {};
        var fl = G.WTS_wp_fluid.flowlineFluid(F, { qo: R.rates.qo, qw: R.rates.qw, qg_Mscfd: R.rates.qo * (+F.gor || 0) / 1000 });
        var pv = {}; if (fl.pvt) Object.keys(fl.pvt).forEach(function (k) { if (k !== 'table') pv[k] = fl.pvt[k]; });
        pv.injGas = { qg_MMscfd: L.qinj / 1000, sg: sg };
        var flI = {}; Object.keys(fl).forEach(function (k) { flI[k] = fl[k]; }); flI.pvt = pv;
        var pr = (typeof G.WTS_flowline_props === 'function' && _fin(pAvg)) ? G.WTS_flowline_props(flI, Math.max(pAvg, 15), tAvg) : null;
        if (!pr || !_fin(H) || !_fin(pti) || !_fin(pca)) return _fail('NO_PROPS', ['The column properties at the injection point are not available.']);
        var qLr = pr.qL, vG = pr.qG, rhoL = pr.rhoL, rhoG = pr.rhoG, Bg = pr.bg;
        var dpdv = -(H / 144) * qLr * (rhoL - rhoG) / Math.pow(qLr + vG, 2);                 // psi per (ft³/s of gas in situ)
        var dvdq = Bg * 1000 / 86400;                                                          // ft³/s per Mscf/d of lift gas
        var dpdq = dpdv * dvdq;                                                                // psi per Mscf/d (< 0)
        var t = tc({ port64: port, p1: pca, p2: pti, T: tA(L.injMd), sg: sg, cd: o.cd });
        var F2 = t.ok ? Math.abs(dpdq) * Math.abs(t.dqdp2) : null;
        var s1 = F1 > 1, s2 = _fin(F2) ? F2 < 1 : null;
        var verdict = !s1 ? 'fail' : (s2 === false ? 'warn' : 'ok');
        return { ok: true, F1: F1, F2: F2, stable1: s1, stable2: s2, verdict: verdict, label: 'Static stability and injection loop gain (screening, after Asheim 1988)', verified: false, casingHeading: false, provisional: PROVISIONAL,
            parts: { q: q, dpInDq: dIn, dpOutDq: dOut, dDdq: dD, H: H, pti: pti, pca: pca, qLres_ft3s: qLr, vG_ft3s: vG, rhoL: rhoL, rhoG: rhoG, Bg: Bg, dpdqg: dpdq,
                port64: port, critical: t.ok ? t.critical : null, r: t.ok ? t.r : null, rc: t.ok ? t.rc : null, dqvdpt: t.ok ? t.dqdp2 : null, qValve: t.ok ? t.q : null, qinj: L.qinj, dpValve: _n(gl.dpValve) },
            errors: [], warnings: [] };
    }

    var NS = G.WTS_wp_gl = G.WTS_wp_gl || {};
    NS.TC = TC; NS.DESIGN = DESIGN; NS.tc = tc; NS.portR = portR; NS.context = context; NS.inputFor = inputFor; NS.design = design; NS.valvesFromDesign = valvesFromDesign; NS.setValve = setValve;
    NS.diagnose = diagnose; NS.parseSurvey = parseSurvey; NS.matchSurvey = matchSurvey; NS.asheim = asheim; NS.pdAt = _pdAt;
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis, L = G.WTS_wp_gl, bad = [];
    if (!L || typeof L.tc !== 'function' || typeof L.design !== 'function') bad.push('namespace');
    else {
        var c = L.tc({ port64: 16, p1: 1000, p2: 400, T: 150, sg: 0.65 }), s = L.tc({ port64: 16, p1: 1000, p2: 950, T: 150, sg: 0.65 });
        if (!(c.ok && c.critical && c.q > 0 && s.q < c.q && s.dqdp2 < 0)) bad.push('tc');
        var p = L.parseSurvey('MD,P (psig)\n0,100\n1000,400\n2000,700');
        if (!(p.ok && p.rows.length === 3 && Math.abs(p.rows[1].p - 414.696) < 1e-9)) bad.push('survey');
    }
    if (bad.length && typeof console !== 'undefined') console.error('[49-calc-wp-gldesign.js self-test] ' + bad.join('; '));
})();
