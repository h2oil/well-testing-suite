// Well Performance correlation comparison and IPR from a test — docs/WELL-PERFORMANCE-PLAN.md §3.7, §5.2, §5.3, §17.1 (WP7).
//
// WM1 compare ranking: every well correlation marched top-down from the measured THP to the gauge MD on the deviated path, the
//     calculated pressure equals an independent full-well traverse at the gauge, err / errPct / rank, a test built from one
//     correlation ranks it first with zero error, several tests rank by RMS; the WP7 names left __WP_STUBS (tune too since A2 WP17)
// WM2 provisional label (D17): unverified correlations carry the label in every row, Beggs & Brill is verified; gas-well set (Gray,
//     dry gas) with MD > TVD at the gauge; unknown keys are skipped with a warning; NO_GAUGE / NO_TEST
// WM3 IPR from a test, p̄r (coefficients held): pwf marched down from the gauge, the gauge itself at the mid-perforations, from the
//     THP without a gauge; closed form for PI / litP2 and the 1-D root for Vogel and composite recover the true p̄r
// WM4 IPR from a test, J (p̄r held): PI closed form, composite / Vogel scaled (closed form), litP2 through the factor root; the adopted
//     coefficients reproduce the test rate; the PI equivalent value
// WM5 IPR from a test, S (k·h held): Darcy oil and Darcy gas recover the true skin (closed forms), more rate at the same pwf means
//     less skin, other models → NEEDS_DARCY
// WM6 the page, step ⑥ on the real engines: QC matrix (a chip per code, score, rank), ranking with provisional chips, the
//     interactive comparison plot (a traverse per correlation, gauge / THP / pwf markers, TVD ↔ MD, legend), Adopt writes p̄r
//     through the normal input path, all-tests RMS mode, no NaN, no console errors
'use strict';

const S = require('./_wellperf-shapes');

const WP = 'WP7';
const PATM = 14.696;
const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const app = (ctx) => S.sharedApp(ctx);
const rowOf = (c, k) => c.rows.filter((r) => r.corr === k)[0];

module.exports = [
  {
    name: 'WM1 compare ranking: THP → gauge marches on the true path, p_calc = independent traverse at the gauge, err / errPct / rank, self-consistent test ranks first, RMS over tests',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, Mt = G.WTS_wp_match;
      ['WTS_wp_match.compare', 'WTS_wp_match.iprFromTest', 'WTS_wp_qc'].forEach((n) => assert.ok((G.__WP_STUBS || []).indexOf(n) === -1, n + ' left __WP_STUBS'));
      assert.ok((G.__WP_STUBS || []).indexOf('WTS_wp_match.tune') === -1 && typeof G.WTS_wp_match.tune === 'function', 'tune is built (A2, WP17; wellperf-tune)');
      const M = S.FIX.oilWell, t = S.FIX.test1;
      const c = Mt.compare(M, t, ['bb', 'hb', 'nsl']);
      assert.ok(c.ok, JSON.stringify(plain(c.errors)));
      assert.deepStrictEqual(plain(c.rows.map((r) => r.rank)), [1, 2, 3]);
      for (let i = 1; i < c.rows.length; i++) assert.ok(Math.abs(c.rows[i].err) >= Math.abs(c.rows[i - 1].err), 'ranked by |err|');
      c.rows.forEach((r) => {
        assert.near(r.err, r.pCalc - t.gauge_psia, 1e-9, r.corr + ' err');
        assert.near(r.errPct, 100 * r.err / t.gauge_psia, 1e-9, r.corr + ' errPct');
        assert.near(r.errPctDp, 100 * r.err / (t.gauge_psia - t.thp_psig - PATM), 1e-9, r.corr + ' errPctDp');
        assert.ok(r.profile.length > 10 && Math.abs(r.profile[r.profile.length - 1].md - t.gaugeMd) < 1e-6 && Math.abs(r.profile[0].md) < 1e-6, 'profile wellhead → gauge');
      });
      assert.near(c.gauge.md, 7900, 1e-9); assert.near(c.gauge.tvd, 7900, 1e-6, 'vertical well: TVD = MD');
      // independent check: the full-well traverse from the THP at the test rates, interpolated at the gauge MD
      const M2 = S.FIX.oilWell; M2.well.heat.thtMeasured = true;
      const F = G.WTS_wp_fluid.build(M2.fluid, { T_F: M2.res.T_F }), W = G.WTS_wp_well.build(M2.well, { res: M2.res, fluidType: 'oil', tests: [t] });
      const tr = G.WTS_wp_vlp.traverse(F, W, { qo: 700, qw: 300, qg_Mscfd: 350 }, { from: 'top', p0: t.thp_psig + PATM, corr: 'bb', stepFt: 100 });
      assert.ok(tr.ok);
      const pr = tr.profile, j = pr.findIndex((r) => r.md >= t.gaugeMd);
      const pInt = pr[j - 1].p + (pr[j].p - pr[j - 1].p) * (t.gaugeMd - pr[j - 1].md) / (pr[j].md - pr[j - 1].md);
      assert.near(rowOf(c, 'bb').pCalc, pInt, 0.5, 'Beggs & Brill at the gauge = the full traverse there');
      // a test whose gauge is the Hagedorn & Brown answer: hb ranks first with zero error
      const tH = Object.assign({}, t, { gauge_psia: rowOf(c, 'hb').pCalc });
      const cH = Mt.compare(M, tH, ['bb', 'hb', 'nsl']);
      assert.strictEqual(cH.best, 'hb'); assert.near(cH.rows[0].err, 0, 1e-6, 'self-consistent test');
      // several tests: RMS over the tests with a gauge, per-test rows, use:false left out
      const t2 = Object.assign({}, t, { id: 'T2', gauge_psia: t.gauge_psia - 60 }), t3 = Object.assign({}, t, { id: 'T3', use: false });
      const cm = Mt.compare(M, [t, t2, t3], ['bb', 'hb']);
      assert.ok(cm.ok && plain(cm.tests).join() === 'T1,T2', 'tests used: ' + plain(cm.tests));
      cm.rows.forEach((r) => {
        const e = r.perTest.map((x) => x.err);
        assert.near(r.err, Math.sqrt((e[0] * e[0] + e[1] * e[1]) / 2), 1e-9, r.corr + ' RMS');
        assert.strictEqual(r.n, 2);
      });
      assert.ok(Math.abs(cm.rows[0].err) <= Math.abs(cm.rows[1].err));
    },
  },
  {
    name: 'WM2 provisional label in every unverified row (D17); gas-well set on the deviated S-shaped path (MD > TVD at the gauge); unknown keys skipped; NO_GAUGE / NO_TEST',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, Mt = G.WTS_wp_match, REG = G.WTS_flowline_corr;
      const c = Mt.compare(S.FIX.oilWell, S.FIX.test1);
      const keys = plain(c.rows.map((r) => r.corr));
      assert.ok(keys.includes('bb') && keys.includes('hb') && keys.includes('nsl') && !keys.includes('gray') && !keys.includes('gasTZ'), 'oil default set: ' + keys);
      c.rows.forEach((r) => {
        assert.strictEqual(r.verified, REG[r.corr].verified === true, r.corr + ' verified flag from the registry');
        if (!r.verified) assert.strictEqual(r.provisional, 'provisional — not verified against a published example', r.corr + ' label');
        else assert.strictEqual(r.provisional, null);
      });
      assert.ok(rowOf(c, 'bb').verified && !rowOf(c, 'hb').verified, 'Beggs & Brill verified, Hagedorn & Brown provisional (Q9)');
      assert.ok(c.warnings.some((w) => w.code === 'PROVISIONAL'), 'provisional note');
      // gas well (deviated): Gray and the dry-gas method join the set; the gauge TVD is below its MD
      const gt = { id: 'G1', q_g: 6000, thp_psig: 2300, tht_F: 140, bean64: 24, gaugeMd: 9800, gauge_psia: 3900 };
      const cg = Mt.compare(S.FIX.gasWell, gt);
      const gk = plain(cg.rows.map((r) => r.corr));
      assert.ok(cg.ok && gk.includes('gray') && gk.includes('gasTZ') && gk.includes('bb'), 'gas set: ' + gk);
      assert.ok(cg.gauge.tvd < cg.gauge.md - 100, 'S-shaped well: gauge TVD ' + cg.gauge.tvd + ' < MD ' + cg.gauge.md);
      assert.ok(cg.rows.every((r) => r.pCalc > gt.thp_psig + PATM), 'every gas march gains pressure downwards');
      assert.ok(plain(cg.rates).derived.length === 2, 'condensate and water filled from CGR / WGR');
      // unknown key skipped, all unknown → NO_CORR; no gauge; no test
      const cu = Mt.compare(S.FIX.oilWell, S.FIX.test1, ['bb', 'nope']);
      assert.ok(cu.ok && cu.rows.length === 1 && cu.warnings.some((w) => w.code === 'UNKNOWN_CORR'));
      assert.strictEqual(Mt.compare(S.FIX.oilWell, S.FIX.test1, ['nope']).code, 'NO_CORR');
      assert.strictEqual(Mt.compare(S.FIX.oilWell, Object.assign(S.FIX.test1, { gauge_psia: null })).code, 'NO_GAUGE');
      assert.strictEqual(Mt.compare(S.FIX.oilWell, []).code, 'NO_TEST');
    },
  },
  {
    name: 'WM3 IPR from a test, p̄r: pwf from the gauge (marched down), at the mid-perforations, from the THP; closed form (PI, LIT p²) and 1-D root (Vogel, composite) recover the true p̄r',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, Mt = G.WTS_wp_match;
      const M = S.FIX.oilWell, t = S.FIX.test1;
      const r = Mt.iprFromTest(M, t, 'pr');
      assert.ok(r.ok && r.method === 'gauge' && r.closedForm, JSON.stringify(plain(r)).slice(0, 300));
      assert.within(r.pwf - t.gauge_psia, 20, 45, 'pwf = gauge + 100 ft of live column: ' + (r.pwf - t.gauge_psia));
      assert.near(r.value, r.pwf + 1000 / 2, 1e-9, 'p̄r = pwf + q/J');
      assert.near(r.adopt.wp_pr, r.value, 0); assert.strictEqual(r.unit, 'psia'); assert.strictEqual(r.provenance, 'matched to test T1');
      // the pwf from the gauge equals a march down from the gauge done here
      const pw = Mt.pwfFromTest(M, t);
      assert.near(pw.pwf, r.pwf, 1e-9);
      // gauge at the mid-perforations: no march, exact back-calculation
      const tm = Object.assign({}, t, { gaugeMd: 8000, gauge_psia: 2500 });
      const rm = Mt.iprFromTest(M, tm, 'pr');
      assert.strictEqual(rm.method, 'gauge at mid-perf'); assert.near(rm.value, 3000, 1e-9);
      // no gauge: marched down from the THP with the chosen correlation (a note says so)
      const rt = Mt.iprFromTest(M, Object.assign({}, t, { gauge_psia: null }), 'pr');
      assert.ok(rt.ok && rt.method === 'thp' && rt.warnings.some((w) => w.code === 'PWF_FROM_THP'));
      assert.ok(rt.pwf > t.thp_psig + PATM + 1500 && rt.pwf < 3000, 'pwf from the THP: ' + rt.pwf);
      // Vogel (q_max held): the test made at p̄r = 3,000 psia is matched back by the 1-D root
      const Mv = S.FIX.oilWell; Mv.res = Object.assign(Mv.res, { model: 'vogel', params: { qmax: 2500 } });
      const Iv = G.WTS_wp_ipr.curve(Mv.res, null), pv = Iv.pwfAt(1000);
      const Mv2 = JSON.parse(JSON.stringify(Mv)); Mv2.res.pr = 2600;          // a wrong p̄r in the model: the root finds 3,000
      const rv = Mt.iprFromTest(Mv2, Object.assign({}, t, { gaugeMd: 8000, gauge_psia: pv }), 'pr');
      assert.ok(rv.ok && !rv.closedForm); assert.near(rv.value, 3000, 1e-6, 'Vogel p̄r');
      // composite with a bubble point (J held)
      const Mc = S.FIX.oilWell; Mc.res = Object.assign(Mc.res, { model: 'composite', pb: 2200, params: { J: 2 } });
      const Ic = G.WTS_wp_ipr.curve(Mc.res, null), pc = Ic.pwfAt(3000);
      assert.ok(pc < 2200, 'below the bubble point');
      const rc = Mt.iprFromTest(Mc, Object.assign({}, t, { q_o: 2100, q_w: 900, gaugeMd: 8000, gauge_psia: pc }), 'pr');
      assert.near(rc.value, 3000, 1e-6, 'composite p̄r');
      // gas LIT p² closed form: p̄r² = pwf² + a·q + b·q²
      const g = S.FIX.gasWell, Ig = G.WTS_wp_ipr.curve(g.res, null), pg = Ig.pwfAt(6000);
      const rg = Mt.iprFromTest(g, { id: 'G1', q_g: 6000, thp_psig: 2300, tht_F: 140, gaugeMd: 9950, gauge_psia: pg }, 'pr');
      assert.ok(rg.closedForm); assert.near(rg.value, 5000, 1e-6, 'LIT p² p̄r');
      assert.strictEqual(Mt.iprFromTest(M, t, 'x').code, 'BAD_SOLVE_FOR');
    },
  },
  {
    name: 'WM4 IPR from a test, J (p̄r held): PI closed form, composite / Vogel scaled, LIT p² by the factor root; the adopted coefficients reproduce the test rate',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, Mt = G.WTS_wp_match, IPR = G.WTS_wp_ipr;
      const M = S.FIX.oilWell, t = S.FIX.test1;
      const r = Mt.iprFromTest(M, t, 'J');
      assert.ok(r.ok && r.closedForm && r.param === 'J');
      assert.near(r.value, 1000 / (3000 - r.pwf), 1e-12, 'J = q / (p̄r − pwf)');
      assert.near(r.adopt.wp_ip_J, r.value, 1e-12); assert.strictEqual(r.unit, 'STB/d/psi');
      // composite: J scaled so that the adopted curve passes through the test
      const Mc = S.FIX.oilWell; Mc.res = Object.assign(Mc.res, { model: 'composite', pb: 2600, params: { J: 2 } });
      const rc = Mt.iprFromTest(Mc, t, 'J');
      const Ic = IPR.curve(Object.assign({}, Mc.res, { params: { J: rc.params.J } }), null);
      assert.near(Ic.qAt(rc.pwf), 1000, 1e-6, 'composite through the test point');
      // Vogel: q_max scaled
      const Mv = S.FIX.oilWell; Mv.res = Object.assign(Mv.res, { model: 'vogel', params: { qmax: 2500 } });
      const rv = Mt.iprFromTest(Mv, t, 'J');
      assert.ok(rv.param === 'qmax' && 'wp_ip_qmax' in rv.adopt && rv.warnings.some((w) => w.code === 'J_EQUIVALENT'));
      assert.near(IPR.curve(Object.assign({}, Mv.res, { params: { qmax: rv.params.qmax } }), null).qAt(rv.pwf), 1000, 1e-6, 'Vogel through the test point');
      // LIT p² (a and b divided by one factor, 1-D root on the factor)
      const g = S.FIX.gasWell, gt = { id: 'G1', q_g: 6000, thp_psig: 2300, tht_F: 140, bean64: 24, gaugeMd: 9800, gauge_psia: 3900 };
      const rg = Mt.iprFromTest(g, gt, 'J');
      assert.ok(rg.ok && rg.param === 'a/b' && rg.unit === 'Mscf/d/psi', JSON.stringify(plain(rg)).slice(0, 300));
      assert.near(rg.params.a / rg.params.b, 500 / 0.05, 1e-6, 'a / b ratio kept');
      assert.near(IPR.curve(Object.assign({}, g.res, { params: { a: rg.params.a, b: rg.params.b } }), null).qAt(rg.pwf), 6000, 1e-6, 'LIT through the test point');
      assert.near(rg.value, 6000 / (5000 - rg.pwf), 1e-12, 'PI equivalent');
      // p̄r missing: J cannot be solved (p̄r is never defaulted)
      const Mn = S.FIX.oilWell; Mn.res.pr = null;
      assert.strictEqual(Mt.iprFromTest(Mn, t, 'J').code, 'PR_NEEDED');
    },
  },
  {
    name: 'WM5 IPR from a test, S (k·h held): Darcy oil and Darcy gas recover the true skin (closed forms); more rate at the same pwf → less skin; other models → NEEDS_DARCY',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, Mt = G.WTS_wp_match, IPR = G.WTS_wp_ipr;
      const t = S.FIX.test1;
      const Mo = S.FIX.oilWell;
      Mo.res = Object.assign(Mo.res, { model: 'darcyOil', pb: 1800, params: { k: 50, h: 40, rw: 0.354, re: 1490, S: 2, Bo: 1.2, muo: 1.1, ref: 'pss' } });
      const Io = IPR.curve(Mo.res, null), po = Io.pwfAt(1000);
      const tm = Object.assign({}, t, { gaugeMd: 8000, gauge_psia: po });
      const Mo0 = JSON.parse(JSON.stringify(Mo)); Mo0.res.params.S = 8;          // the model's skin is wrong: the test says 2
      const ro = Mt.iprFromTest(Mo0, tm, 'S');
      assert.ok(ro.ok && ro.closedForm && ro.param === 'S', JSON.stringify(plain(ro)).slice(0, 300));
      assert.near(ro.value, 2, 1e-9, 'Darcy oil skin'); assert.near(ro.adopt.wp_ip_S, 2, 1e-9);
      const ro2 = Mt.iprFromTest(Mo0, Object.assign({}, tm, { q_o: 840, q_w: 360 }), 'S');
      assert.ok(ro2.value < ro.value, 'more rate at the same pwf → less skin');
      // below the bubble point (composite with the Darcy J) the closed form still holds
      const pb2 = Io.pwfAt(2000);
      assert.ok(pb2 < 1800, 'below pb');
      assert.near(Mt.iprFromTest(Mo0, Object.assign({}, tm, { q_o: 1400, q_w: 600, gauge_psia: pb2 }), 'S').value, 2, 1e-9, 'Darcy oil skin below pb');
      // Darcy gas with non-Darcy D (m(p) form): S from a = (a₀q₀ + b q₀² − b q²)/q
      const g = S.FIX.gasWell;
      g.res = Object.assign(g.res, { model: 'darcyGas', params: { k: 5, h: 50, rw: 0.354, re: 1490, S: 1, D: 1e-4 } });
      const Ig = IPR.curve(g.res, G.WTS_wp_fluid.build(g.fluid, { T_F: g.res.T_F }));
      assert.ok(Ig.ok, JSON.stringify(plain(Ig.errors)));
      const pg = Ig.pwfAt(4000), g0 = JSON.parse(JSON.stringify(g)); g0.res.params.S = 6;
      const rg = Mt.iprFromTest(g0, { id: 'G1', q_g: 4000, thp_psig: 2000, tht_F: 140, gaugeMd: 9950, gauge_psia: pg }, 'S');
      assert.ok(rg.ok && rg.closedForm, JSON.stringify(plain(rg)).slice(0, 300));
      assert.near(rg.value, 1, 1e-6, 'Darcy gas skin');
      const r = Mt.iprFromTest(S.FIX.oilWell, t, 'S');
      assert.strictEqual(r.code, 'NEEDS_DARCY'); assert.includes(r.errors[0], 'Darcy');
    },
  },
  {
    name: 'WM6 page step ⑥ on the real engines: QC matrix, ranking with provisional chips, interactive comparison plot (traverses, gauge / THP / pwf markers, TVD ↔ MD), Adopt p̄r, RMS mode',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const A = app(ctx), G = A.win, txt = (e) => String(e && e.textContent || '').replace(/\s+/g, ' ').trim(), BAD = /NaN|undefined|Infinity|\[object Object\]/;
      if (G.__WP_MOCK) return assert.ok(true, 'mock installed in this app');
      S.resetWellPerf(A);
      A.hook.nav('wellperf'); A.flush(30);
      A.click(A.find('[data-act="example"][data-ex="oil"]')); A.flush(30);
      A.click(A.find('#wp_steps [data-step="6"]')); A.flush(5);
      const sel = A.el('wpv_mtest');
      assert.ok(sel && /T1/.test(txt(sel)), 'test selector lists the example test: ' + txt(sel));
      A.click(A.find('[data-act="match"]')); A.flush(10);
      const st = G.WTS_state.wellperf.match;
      assert.ok(st && st.compare.ok && st.qc.ok && st.ipr.ok, 'match state: ' + JSON.stringify(plain({ c: st && st.compare.errors, q: st && st.qc.errors, i: st && st.ipr.errors })));
      const res = A.el('wp_matchres'), t = txt(res);
      assert.match(t, /Production-test QC/); assert.match(t, /Correlation ranking — test T1/);
      assert.strictEqual(A.findAll('#wp_matchres .wp-qcb').length, 8, 'a chip per QC code');
      assert.ok(A.findAll('#wp_matchres .wp-chip.prov').length >= 1, 'provisional chips on the unverified correlations');
      assert.match(t, /Back-calculated reservoir pressure p̄r from test T1: [\d,]+ psia/);
      assert.ok(!BAD.test(t), 'step ⑥ clean: ' + (t.match(BAD) || [''])[0]);
      const cv = A.el('wp_cv_match');
      assert.ok(cv && cv._wp && cv._wp.spec, 'comparison plot drawn');
      const sp = cv._wp.spec;
      assert.ok(sp.series.length >= 3 && sp.series.every((x) => x.pts.length > 10), 'a traverse per correlation');
      assert.ok(sp.y.invert && /TVD/.test(sp.y.label), 'depth axis inverted, TVD by default');
      assert.deepStrictEqual(plain(sp.markers.map((m) => m.label)), ['Gauge', 'THP', 'pwf'], 'gauge, THP and pwf markers');
      A.click(A.find('#wp_mdepth [data-mdepth="md"]')); A.flush(2);
      assert.match(A.el('wp_cv_match')._wp.spec.y.label, /MD/, 'MD toggle');
      // Adopt p̄r → the wp_pr control and a new solve
      const v = +A.find('[data-act="adopt"]').getAttribute('data-vs');
      A.click(A.find('[data-act="adopt"]')); A.flush(30);
      assert.near(+A.el('wp_pr').value, +v.toPrecision(6), 1e-6, 'p̄r adopted');
      assert.near(G.WTS_wellperf_page.state().M.res.pr, +v.toPrecision(6), 1e-6, 'the page model reads the adopted p̄r (normal input path)');
      assert.match(txt(A.find('label[for="wp_pr"]')), /matched to test/, 'provenance chip');
      // all used tests (RMS) once there are two
      const tests = plain(G.WTS_wp_model.read().tests); tests.push(Object.assign({}, tests[0], { id: 'T2', date: '2026-11-03', gauge_psia: tests[0].gauge_psia - 40 }));
      G.WTS_wp_model.write({ tests }); A.flush(30);
      A.click(A.find('#wp_steps [data-step="6"]')); A.flush(2);
      assert.match(txt(A.el('wpv_mtest')), /All used tests/);
      A.el('wpv_mtest').value = 'all';
      A.click(A.find('[data-act="match"]')); A.flush(10);
      assert.match(txt(A.el('wp_matchres')), /RMS/);
      assert.strictEqual(A.findAll('#wp_matchres .wp-qcb').length, 16, 'two tests × eight checks');
      assert.strictEqual(A.consoleErrors().length, 0, 'no console errors');
    },
  },
];
