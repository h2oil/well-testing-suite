// Well Performance A2, WP18 — the gas-lift quick look (WTS_wp_gl and the gas-lifted system solve). docs/WELL-PERFORMANCE-PLAN.md
// §3.5 (designFor {qinj}), §3.8, §7.1, §15.2 (q_inj = 0 equals natural flow exactly), §16 (GLPC 12 points ≤ 200 E), §17.2 (6 tests).
// No published GLPC example is available (Q9; Takacs, Gas Lift Manual, is a B item), so the quick look is checked against its own
// definitions: the point of balance, free-gas-only injection, the natural-flow identity, the curve shape and the summary rules.
//
// WGL1 injection depth per point: the point of balance p_cas − ΔP_valve = p_tub on the deviated path (casing = WTS_gaslift_casingP over
//      the TVD), or the packer when the casing pressure holds below it; the wellhead node finds the same point and rate
// WGL2 free gas only: above the point the lift gas adds to the free gas (Rs, Bo unchanged), the mixed gravity sets the gas density;
//      the choke and flowline carry it; the traverse rows above the point are flagged
// WGL3 q_inj = 0 (or blank) is the natural-flow solve exactly; the GLPC natural point equals it
// WGL4 GLPC: 12 points as a Job (tracking solves, ≤ 200 E), the curve rises then falls, optimum = the maximum, economic point by the
//      incremental GOR limit, gain over natural flow, lift gas for 90 % of the gain; a dead well says so
// WGL5 lift gas for a target rate (designFor {qinj}); refusals (no injection pressure, gas well) and the WTS_wp_check items
// WGL6 the page: step ④ controls, the performance curve (markers, the draggable q_inj line that re-solves), the injection-depth plot,
//      the KPI, the schematic injection point and packer, the traverse casing curve, injection line and packer handle, Use the optimum
'use strict';

const S = require('./_wellperf-shapes');

const WP = 'WP18';
const PATM = 14.696;
const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const app = (ctx) => S.sharedApp(ctx);
const run = (job) => { let s, n = 0; do { s = job.step(); n++; } while (!s.done && n < 500); return job.result(); };
// FIX.oilWell made a candidate: WC 60 % and p̄r 2,600 psia (dead in natural flow), casing 1,200 psig, packer 7,800 ft MD
const liftM = (qinj, extra) => { const M = S.FIX.oilWell; M.fluid.wc = 0.6; M.res.pr = 2600; M.lift = { type: 'gaslift', gl: Object.assign({ qinj_Mscfd: qinj, pinj_psig: 1200, sginj: 0.65, dpValve: 100, packerMd: 7800 }, extra || {}) }; return M; };
const _memo = new Map();
const sol = (SY, M, o) => { const k = JSON.stringify([M, o || null]); if (!_memo.has(k)) _memo.set(k, SY.solve(M, o)); return _memo.get(k); };

module.exports = [
  {
    name: 'WGL1 injection depth per point: the point of balance on the deviated path, or the packer; the wellhead node agrees',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, SY = G.WTS_wp_system;
      const R = sol(SY, liftM(500));
      assert.ok(R.ok && R.lift && R.lift.type === 'gaslift', JSON.stringify(plain(R.errors)));
      const L = R.lift;
      assert.ok(L.injMd > 1000 && L.injMd < L.packerMd && !L.atPacker, 'balance point above the packer: ' + L.injMd);
      assert.near(L.pCas - 100, L.pTub, 1.0, 'p_cas − ΔP_valve = p_tub at the point');
      // the casing column is WTS_gaslift_casingP over the TVD at the flowing temperatures
      const c = G.WTS_gaslift_casingP(1200, L.injTvd, 0.65, R.traverse.profile[0].t, R.traverse.profile.find((r) => r.md >= L.injMd).t);
      assert.ok(Math.abs(c.p + PATM - L.pCas) < 3, 'casing column: ' + (c.p + PATM) + ' vs ' + L.pCas);
      assert.ok(L.casing.length > 10 && L.casing.every((r, i, a) => i === 0 || r.p >= a[i - 1].p), 'casing profile rises with depth');
      // the traverse marches the lifted mixture above the point and the formation fluid below, MD and TVD on every row
      const pr = R.traverse.profile;
      assert.ok(pr.some((r) => r.lift) && pr.some((r) => !r.lift), 'two fluids');
      assert.ok(pr.filter((r) => r.lift).every((r) => r.md <= L.injMd + 1e-6), 'lift rows above the point');
      assert.ok(pr.every((r) => isFinite(r.md) && isFinite(r.tvd)), 'MD / TVD');
      assert.near(R.traverse.pBottom, R.pwf, 0.15, 'the traverse ends at pwf');
      // a high casing pressure opens the packer depth
      const Rp = sol(SY, liftM(500, { pinj_psig: 2400 }));
      assert.ok(Rp.ok && Rp.lift.atPacker && Math.abs(Rp.lift.injMd - 7800) < 1e-6, 'at the packer: ' + Rp.lift.injMd);
      assert.ok(Rp.op.q > R.op.q, 'deeper injection, more rate');
      // node independence (bottom-up march at pwf(q) on the wellhead node)
      const Mw = liftM(500); Mw.system.node = 'wellhead';
      const Rw = sol(SY, Mw);
      assert.ok(Rw.ok && Math.abs(Rw.op.q / R.op.q - 1) < 0.005, 'wellhead node rate: ' + Rw.op.q + ' vs ' + R.op.q);
      assert.ok(Math.abs(Rw.lift.injMd - L.injMd) < 25, 'same injection depth: ' + Rw.lift.injMd + ' vs ' + L.injMd);
      // deviated path: on FIX.gasWell's S-shaped survey with an oil fluid the point carries different MD and TVD
      const Md = liftM(500); Md.well = S.FIX.gasWell.well; Md.lift.gl.packerMd = 9000;
      const Rd = sol(SY, Md);
      assert.ok(Rd.ok && Rd.lift.injMd - Rd.lift.injTvd > 50, 'deviated: MD ' + Rd.lift.injMd + ' > TVD ' + Rd.lift.injTvd);
    },
  },
  {
    name: 'WGL2 free gas only above the point: Rs and Bo unchanged, free gas + q_inj at the mixed gravity; the choke and flowline carry it',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, SY = G.WTS_wp_system, M = liftM(500);
      const F = G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F });
      const ff = G.WTS_wp_fluid.flowlineFluid(F, 600), pv = Object.assign({}, ff.pvt, { injGas: { qg_MMscfd: 0.5, sg: 0.8 } });
      const a = G.WTS_flowline_props(ff, 1000, 150), b = G.WTS_flowline_props(Object.assign({}, ff, { pvt: pv }), 1000, 150);
      assert.near(b.rs, a.rs, 1e-12, 'Rs unchanged'); assert.near(b.bo, a.bo, 1e-12, 'Bo unchanged');
      assert.near(b.freeGas, a.freeGas + 0.5e6, 1e-6, 'free gas + q_inj (scf/d)');
      assert.ok(b.sgGas > a.sgGas && b.sgGas < 0.8, 'mixed gravity between the formation free gas and the lift gas');
      const R = sol(SY, M);
      assert.near(R.rates.qgTotal, R.rates.qg + 500, 1e-9, 'total gas = formation + lift gas');
      // the surface boundary at the same rate: the lift gas raises the THP the choke needs
      const bl = SY.boundary(M, 500), bn = SY.boundary(S.FIX.oilWell, 500);
      assert.ok(bl.thp > bn.thp, 'lift gas through the choke: ' + bl.thp + ' > ' + bn.thp);
      assert.ok(R.flags.some((f) => f.code === 'GL_POINT' && /MD/.test(f.msg) && /TVD/.test(f.msg)), 'GL_POINT flag with MD and TVD');
    },
  },
  {
    name: 'WGL3 q_inj = 0 (or blank) is the natural-flow solve exactly; the GLPC natural point equals it',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, SY = G.WTS_wp_system;
      const Mn = S.FIX.oilWell, Rn = SY.solve(Mn);
      [0, null].forEach((q) => {
        const M = S.FIX.oilWell; M.lift = { type: 'gaslift', gl: { qinj_Mscfd: q, pinj_psig: 1200 } };
        const R = SY.solve(M);
        assert.ok(R.op.q === Rn.op.q && R.pwf === Rn.pwf && !R.lift, 'identical at q_inj ' + q);
        assert.deepStrictEqual(plain(R.traverse.profile.map((r) => r.p)), plain(Rn.traverse.profile.map((r) => r.p)), 'same traverse');
      });
      const M2 = S.FIX.oilWell; M2.lift = { type: 'gaslift', gl: { pinj_psig: 1500, packerMd: 7800 } };
      const r = run(G.WTS_wp_gl.glpc(M2, { qinjList: [0, 500, 1000] }));
      assert.ok(r.natural.ok && r.points[0].qinj === 0 && r.points[0].qL === Rn.rates.qL && r.natural.qL === Rn.rates.qL, 'natural point: ' + r.points[0].qL + ' vs ' + Rn.rates.qL);
    },
  },
  {
    name: 'WGL4 GLPC: 12-point Job with tracking solves ≤ 200 E, rises then falls, optimum, economic point, gain, gas for 90 %; dead well noted',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, GL = G.WTS_wp_gl;
      assert.strictEqual(GL.DEFAULT_LIST.length, 12); assert.strictEqual(GL.DEFAULT_LIST[GL.DEFAULT_LIST.length - 1], 5000);
      const r = run(GL.glpc(liftM(500, { incGor: 3000 })));
      assert.ok(r.ok && r.points.length === 12, JSON.stringify(plain(r.errors)));
      assert.ok(!r.natural.ok && r.warnings.some((w) => w.code === 'GL_DEAD_WELL'), 'dead in natural flow');
      assert.ok(r.evals <= 200, 'GLPC within the §16 budget: ' + r.evals + ' E');
      assert.ok(r.points.filter((p) => p.qinj > 0 && p.ok).filter((p) => p.tracked).length >= 8, 'tracking solves');
      const ok = r.points.filter((p) => p.ok), mx = ok.reduce((a, b) => (b.qL > a.qL ? b : a));
      assert.deepStrictEqual(plain(r.optimum), { qinj: mx.qinj, qL: mx.qL }, 'optimum = the maximum');
      assert.ok(mx.qinj > ok[0].qinj && mx.qinj < 5000, 'rises then falls: optimum at ' + mx.qinj);
      assert.ok(ok[ok.length - 1].qL < mx.qL, 'falls beyond the optimum (friction and the choke)');
      assert.ok(r.points.filter((p) => p.ok && p.qinj > 0).every((p) => p.injMd > 0 && p.injMd <= 7800 && isFinite(p.injTvd)), 'depth per point');
      assert.near(r.gain, mx.qL, 1e-9, 'gain over a dead well = the optimum rate');
      assert.ok(r.economic && r.economic.rule === 'slope' && r.economic.qinj <= mx.qinj, 'economic point at or before the optimum');
      const s = GL.summary(r.points, 0);
      assert.strictEqual(s.economic.qinj, mx.qinj, 'no limit → the optimum');
      assert.ok(r.gas90 && r.gas90.qinj <= mx.qinj && r.gas90.qL >= 0.9 * r.gain - 1e-6, 'gas for 90 % of the gain');
      // a well that flows naturally: the curve starts at its natural rate and the gain is above it
      const M2 = S.FIX.oilWell; M2.lift = { type: 'gaslift', gl: { pinj_psig: 1500, packerMd: 7800 } };
      const r2 = run(GL.glpc(M2, { qinjList: [0, 250, 500, 1000, 2000] }));
      assert.ok(r2.natural.ok && r2.optimum.qL > r2.natural.qL && Math.abs(r2.gain - (r2.optimum.qL - r2.natural.qL)) < 1e-9, 'gain over natural flow');
      const j = GL.glpc(liftM(0)); j.step(); j.cancel();
      assert.ok(j.result().cancelled, 'cancel');
    },
  },
  {
    name: 'WGL5 lift gas for a target rate (designFor {qinj}); refusals and the WTS_wp_check items',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, SY = G.WTS_wp_system;
      const d = run(SY.designFor(liftM(500), { qinj: 560 }));
      assert.ok(d.ok && d.qinj > 0 && d.qinj < 500 && Math.abs(d.q - 560) <= 1, 'lift gas for 560 STB/d: ' + JSON.stringify(plain({ qinj: d.qinj, q: d.q, e: d.errors })));
      const R = SY.solve(liftM(d.qinj));
      assert.ok(Math.abs(R.op.q - 560) < 2, 'solving at that rate gives the target: ' + R.op.q);
      const u = run(SY.designFor(liftM(500), { qinj: 2000 }));
      assert.ok(!u.ok && /lift-gas rate/.test(u.errors[0]), 'unreachable: ' + u.errors[0]);
      const Mp = liftM(500); Mp.lift.gl.pinj_psig = null;
      assert.strictEqual(SY.solve(Mp).code, 'NEEDS_PINJ');
      assert.ok(G.WTS_wp_check(Mp).items.some((x) => x.code === 'GL_PINJ' && x.field === 'wp_gl_pinj'), 'check: injection pressure');
      const Mg = S.FIX.gasWell; Mg.lift = { type: 'gaslift', gl: { qinj_Mscfd: 500, pinj_psig: 1200 } };
      assert.strictEqual(SY.solve(Mg).code, 'GL_NOT_APPLICABLE');
      assert.ok(G.WTS_wp_check(Mg).items.some((x) => x.code === 'GL_NOT_APPLICABLE'), 'check: gas well');
      assert.strictEqual(run(G.WTS_wp_gl.glpc(Mg)).code, 'GL_NOT_APPLICABLE');
      assert.ok(G.WTS_wp_check(liftM(500, { packerMd: 9000 })).items.some((x) => x.code === 'GL_PACKER'), 'check: packer below the perforations');
      const Rk = SY.solve(liftM(500, { packerMd: 9000 }));
      assert.ok(Rk.ok && Rk.lift.packerMd <= 7950 && Rk.warnings.some((w) => w.code === 'GL_PACKER_DEEP'), 'packer limited to the end of the tubing');
    },
  },
  {
    name: 'WGL6 page: step ④ controls, performance curve with the draggable q_inj line, depth plot, KPI, schematic injection point, traverse casing curve and packer handle, Use the optimum',
    wp: WP, opts: false,
    async run(_a, assert, ctx) {
      const A = app(ctx), G = A.win, txt = (e) => String(e && e.textContent || '').replace(/\s+/g, ' ').trim(), BAD = /NaN|undefined|Infinity|\[object Object\]/;
      if (G.__WP_MOCK) return assert.ok(true, 'mock installed in this app');
      S.resetWellPerf(A); G.WTS_wellperf_page.resetJobs();
      A.hook.nav('wellperf'); A.flush(30);
      A.click(A.find('[data-act="example"][data-ex="oil"]')); A.flush(30);
      G.WTS_wellperf_page.goStep(4); A.flush(5);
      const off = (id) => /wp-off/.test(A.el(id).closest('.fg-item').className);
      assert.ok(off('wp_gl_pinj'), 'gas-lift inputs hidden in natural flow');
      A.select('wp_lift', 'gaslift'); A.flush(30);
      assert.ok(!off('wp_gl_pinj') && !off('wp_gl_qinj'), 'shown with gas lift');
      A.change('wp_gl_pinj', '1500'); A.change('wp_gl_packer', '7800'); A.change('wp_gl_qinj', '500'); A.flush(30);
      const st = G.WTS_state.wellperf;
      assert.ok(st.ok && st.surface && G.WTS_wellperf_page.state().R.lift, 'gas-lifted solve');
      const k = A.findAll('#wp_kpis .kpi').map(txt).join(' | ');
      assert.match(k, /Lift gas\s*500 Mscf\/d.*MD.*TVD/);
      assert.match(txt(A.el('wp_op')), /Injection point\s*[\d,]+ ft MD · [\d,]+ ft TVD/);
      assert.ok(/data-comp="gl"/.test(A.el('wp_sch').innerHTML) && /packer/.test(A.el('wp_sch').innerHTML), 'schematic: injection point and packer');
      const tr = A.el('wp_cv_tr')._wp.spec;
      assert.ok(tr.series.some((s) => s.key === 'cas') && tr.hlines.some((h) => /injection/.test(h.label)) && tr.handles.some((h) => h.key === 'packer'), 'traverse: casing curve, injection line, packer handle');
      // the performance curve through the button
      const P = G.WTS_wellperf_page, pst = P.state();
      A.click(A.find('[data-act="glpc"]'));
      for (let i = 0; i < 120 && !pst.gl; i++) await A.flushAsync(1);
      assert.ok(pst.gl && pst.gl.ok, 'GLPC on the page');
      const sp = A.el('wp_cv_glpc')._wp.spec;
      assert.ok(sp.series[0].pts.length >= 10 && sp.markers.some((m) => /optimum/.test(m.label)) && sp.handles[0].kind === 'lineX' && sp.handles[0].key === 'qinj', 'curve, optimum, q_inj line');
      assert.ok(A.el('wp_cv_gldepth')._wp.spec.series[0].pts.length >= 10, 'injection depth per rate');
      assert.match(txt(A.el('wp_glres')), /Optimum \(maximum rate\)/);
      // drag the q_inj line: a live tracking solve, then the release
      const q0 = pst.R.op.q;
      P.handle('qinj', 1000, 'move'); A.flush(5);
      assert.ok(pst.R.ok && pst.R.lift && pst.R.lift.qinj === 1000, 'live solve with 1,000 Mscf/d');
      P.handle('qinj', 1000, 'end'); A.flush(30);
      assert.strictEqual(A.el('wp_gl_qinj').value, '1000');
      assert.ok(pst.R.op.q !== q0, 'the rate follows');
      // Use the optimum
      A.click(A.find('#wp_glres [data-act="glopt"]')); A.flush(30);
      assert.strictEqual(+A.el('wp_gl_qinj').value, pst.gl.optimum.qinj, 'optimum adopted');
      const csv = P.csv();
      assert.ok(/Gas-lift performance curve/.test(csv), 'CSV block');
      assert.ok(!BAD.test(txt(A.el('wp_res'))) && !BAD.test(txt(A.el('wp_step_4'))), 'clean');
      assert.strictEqual(A.consoleErrors().length, 0, 'no console errors');
      A.select('wp_lift', 'none'); A.flush(30);
    },
  },
];
