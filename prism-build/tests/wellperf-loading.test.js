// Well Performance liquid loading — docs/WELL-PERFORMANCE-PLAN.md §4.11, §15.1 (Turner / Coleman), §17.1 (WP5, 6 tests).
//
// WLD1 Turner / Coleman / Li critical velocity by hand at a node: v_c = C·σ^¼·(ρ_L − ρ_g)^¼/ρ_g^½, C = 1.912 / 1.593 / 0.7241
// WLD2 q_c (MMscf/d) = 3.067·p·v_c·A/((T + 460)·z) at EVERY traverse node; the reported q_c is the maximum, the margin q_op/q_c − 1
// WLD3 limiting depth with a tapered string: the casing below the tubing shoe (bottom) controls FIX.gasWell; with the path in the
//      tubing only the larger upper string controls
// WLD4 method suggested by the flowing wellhead pressure: Coleman below 500 psia, Turner above 1,000 psia, both shown in between
// WLD5 verdicts (✗ below, ⚠ within 10 %, ✓) and recommendations; an oil well is "not applicable"
// WLD6 the solve carries the loading (same as WTS_wp_loading(R, F, W)), the LOADING flag and the per-depth profile with MD and TVD
'use strict';

const S = require('./_wellperf-shapes');

const WP = 'WP5';
const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const app = (ctx) => S.sharedApp(ctx);
const _memo = new Map();
const sol = (SY, M) => { const k = JSON.stringify(M); if (!_memo.has(k)) _memo.set(k, SY.solve(M)); return _memo.get(k); };
function env(ctx, M) {
  const G = app(ctx).win, SY = G.WTS_wp_system;
  M = M || S.FIX.gasWell;
  // the fluid exactly as the solver builds it (with the (p, T)-binned property table, §4.5)
  const R = sol(SY, M), F = G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F, table: true }), W = G.WTS_wp_well.build(M.well, { res: M.res, fluidType: M.fluid.type });
  return { G, SY, M, R, F, W };
}
function fixedThp(thp) { const M = S.FIX.gasWell; M.surface.choke.present = false; M.surface.flowline = []; M.system.thp_psig = thp; return M; }

module.exports = [
  {
    name: 'WLD1 critical velocity by hand at the limiting node for Turner (1.912, with the 20 % uplift), Coleman (1.593) and Li (0.7241)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const { R, F } = env(ctx), L = R.loading;
      assert.ok(L && L.applicable, 'loading on the wet-gas well');
      const row = L.perDepth[0], pr = F.at(R.traverse.profile[0].p, R.traverse.profile[0].t);
      assert.ok(pr && row, 'props at the top node');
      // the well makes water (WGR 2): the liquid is water
      const vc = (C) => C * Math.pow(pr.sigW, 0.25) * Math.pow(pr.rhoW - pr.rhoG, 0.25) / Math.sqrt(pr.rhoG);
      assert.rel(row.vc, vc(1.912), 1e-12, 'Turner');
      assert.rel(row.vcColeman, vc(1.593), 1e-12, 'Coleman');
      assert.rel(row.vcLi, vc(0.7241), 1e-12, 'Li');
      assert.rel(L.methods.coleman.qc_MMscfd / L.methods.turner.qc_MMscfd, 1.593 / 1.912, 1e-12, 'q_c scales with the coefficient');
      assert.rel(L.methods.li.qc_MMscfd / L.methods.turner.qc_MMscfd, 0.7241 / 1.912, 1e-12);
      assert.deepStrictEqual(Object.keys(plain(L.methods)).sort(), ['coleman', 'li', 'turner']);
    },
  },
  {
    name: 'WLD2 q_c = 3.067·p·v_c·A/((T + 460)·z) at every traverse node; the reported q_c is the largest; margin = q_op/q_c − 1',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const { R, F } = env(ctx), L = R.loading;
      const prof = R.traverse.profile.filter((r) => !r.restr);
      let n = 0;
      L.perDepth.forEach((row) => {
        const tr = prof.find((r) => Math.abs(r.md - row.md) < 1e-9);
        assert.ok(tr, 'node at MD ' + row.md);
        const pr = F.at(tr.p, tr.t), A = Math.PI * row.id * row.id / 4 / 144;
        assert.rel(row.qc, 3.067 * tr.p * row.vc * A / ((tr.t + 460) * pr.z), 1e-12, 'q_c at ' + row.md.toFixed(0));
        assert.strictEqual(row.vg, tr.vsg, 'gas velocity = the in-situ superficial gas velocity');
        n++;
      });
      assert.ok(n > 40, 'q_c along the whole well: ' + n + ' nodes');
      const mx = Math.max.apply(null, L.perDepth.map((r) => r.qc));
      assert.ok(L.methods.turner.qc_MMscfd >= mx - 1e-12, 'reported q_c is the maximum over the nodes');
      assert.rel(L.methods.turner.margin, R.rates.qg / 1000 / L.methods.turner.qc_MMscfd - 1, 1e-12, 'margin');
    },
  },
  {
    name: 'WLD3 limiting depth with a tapered path: the 7 in casing below the tubing shoe (bottom) controls FIX.gasWell; in the tubing alone the larger upper string controls',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const { R } = env(ctx), L = R.loading;
      assert.within(L.limitingMd, 9850 - 1e-6, 9950 + 1e-6, 'bottom (casing 9,850–9,950 ft MD) controls');
      assert.ok(L.limitingTvd < L.limitingMd, 'TVD of the limiting point on the deviated well');
      const M = S.FIX.gasWell; M.well.midPerfMd = 9840; M.well.perfTopMd = 9830; M.well.perfBotMd = 9845;
      const L2 = sol(app(ctx).win.WTS_wp_system, M).loading;
      assert.ok(L2 && L2.limitingMd <= 5000 + 1e-6, 'the 3-1/2 in upper string controls in the tubing alone: ' + (L2 && L2.limitingMd));
      assert.ok(L2.methods.turner.qc_MMscfd < L.methods.turner.qc_MMscfd, 'a smaller controlling bore → a smaller critical rate');
    },
  },
  {
    name: 'WLD4 method suggestion by the flowing wellhead pressure: Coleman below 500 psia, Turner above 1,000 psia, both shown between',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const SY = app(ctx).win.WTS_wp_system;
      const L1 = sol(SY, fixedThp(300)).loading;
      assert.ok(L1.whp < 500 && L1.suggested === 'coleman' && L1.method === 'coleman' && !L1.both, 'Coleman: ' + L1.whp);
      assert.includes(L1.methodText, 'Coleman');
      const L2 = sol(SY, fixedThp(700)).loading;
      assert.ok(L2.whp >= 500 && L2.whp <= 1000 && L2.both === true && L2.suggested === 'turner', 'both: ' + L2.whp);
      const L3 = env(ctx).R.loading;
      assert.ok(L3.whp > 1000 && L3.suggested === 'turner' && !L3.both, 'Turner: ' + L3.whp);
      assert.strictEqual(L1.margin, L1.methods.coleman.margin, 'the reported margin is the suggested method');
    },
  },
  {
    name: 'WLD5 verdicts: ✗ below the critical rate (with recommendations), ⚠ within 10 %, ✓ above; an oil well is not applicable',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const { G, R, F, W } = env(ctx);
      const L = R.loading;
      assert.ok(L.margin < 0 && L.verdict === 'fail' && L.recommendations.length === 3, 'below: ' + L.margin);
      // the same well at a scaled rate: rebuild the verdict through the engine (the margin is linear in q_op)
      const at = (q) => { const R2 = Object.assign({}, R, { rates: Object.assign({}, R.rates, { qg: q }) }); return G.WTS_wp_loading(R2, F, W); };
      const qc = L.qc_MMscfd * 1000;
      assert.strictEqual(at(qc * 1.05).verdict, 'warn');
      assert.strictEqual(at(qc * 1.5).verdict, 'ok');
      assert.ok(!at(qc * 1.5).recommendations, 'no recommendation when unloading');
      const Ro = sol(G.WTS_wp_system, S.FIX.oilWell);
      assert.strictEqual(Ro.loading, null, 'oil well: no loading block');
      const Lo = G.WTS_wp_loading(Ro, G.WTS_wp_fluid.build(S.FIX.oilWell.fluid, {}), null);
      assert.ok(Lo.ok && Lo.applicable === false && Lo.margin === null, 'oil: not applicable');
      const bad = G.WTS_wp_loading({}, F, W);
      assert.ok(!bad.ok && bad.code === 'NO_TRAVERSE', 'no traverse → error, no throw');
    },
  },
  {
    name: 'WLD6 the solve carries the loading (equal to WTS_wp_loading(R, F, W)), the LOADING flag, and a per-depth profile from the wellhead to the mid-perforations with MD and TVD',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const { G, R, F, W } = env(ctx);
      assert.deepStrictEqual(plain(R.loading), plain(G.WTS_wp_loading(R, F, W)), 'same result');
      assert.ok(R.flags.some((f) => f.code === 'LOADING' && f.sev === 'warn'), 'LOADING flag');
      const pd = R.loading.perDepth;
      assert.near(pd[0].md, 0, 1e-6); assert.near(pd[pd.length - 1].md, W.nodes.midPerfMd, 1e-6, 'to the mid-perforations');
      assert.ok(pd.every((r) => r.tvd <= r.md + 1e-6 && isFinite(r.vg) && isFinite(r.vc) && isFinite(r.qc)), 'MD / TVD / velocities');
      for (let i = 1; i < pd.length; i++) assert.ok(pd[i].md >= pd[i - 1].md, 'ordered by MD');
    },
  },
];
