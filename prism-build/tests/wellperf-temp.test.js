// Well Performance WP4 — flowing temperature, A1 (docs/WELL-PERFORMANCE-PLAN.md §4.6, §17.1: wellperf-temp).
//
// WT1 linear mode: THT → BHT along MD, BHT from the reservoir temperature or the geotherm, no THT → static geotherm, relax → A2 note
// WT2 Joule-Thomson hydrate THT for gas / condensate wells: THT_hyd = THT − μ_JT·Δp_tubing, μ_JT from WTS_gaspvt_isenthalpic at the
//     mean tubing conditions (the fluid's gas gravity and impurities)
// WT3 verdicts: measured THT, "upper-bound THT, not conservative" without the correction, oil wells
// The fluid F is the WP1 interface (WTS_wp_fluid.build → {type, pvt, at(p, T) → props}); a fixture stands in until WP1 merges.
'use strict';

const S = require('./_wellperf-shapes');

const WP = 'WP4';
const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const app = (ctx) => S.sharedApp(ctx);
const near = (assert, a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, what + ': ' + a + ' vs ' + b + ' (tol ' + tol + ')');
// the WP1 fluid interface (fixture stub): separator gas gravity through at(p, T).sgGas, impurities in pvt.imp (mol %)
const FLUID = (type, sg, imp) => ({ ok: true, type, pvt: { imp: imp || {} }, at: () => ({ sgGas: sg, pvt: true }), validity: [], warnings: [] });

module.exports = [
  {
    name: 'WT1 linear temperature: THT → BHT along MD (BHT = reservoir T, else the geotherm at the mid-perf TVD); no THT → the static geotherm; relax → linear with an A2 note',
    wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const N = app(ctx).win.WTS_wp_well, O = S.FIX.oilWell;
      const W = N.build(O.well, { res: O.res });
      const T = W.temp;
      assert.ok(T.ok && T.mode === 'linear', 'linear');
      near(assert, W.tAt(0), 120, 1e-12, 'THT'); near(assert, W.tAt(8000), 200, 1e-12, 'BHT');
      near(assert, W.tAt(2000), 140, 1e-12, 'quarter'); near(assert, W.tAt(9000), 200, 1e-12, 'below the mid-perf: BHT');
      // deviated: linear along MD, not TVD
      const M = S.FIX.gasWell, Wg = N.build(M.well, { res: M.res });
      near(assert, Wg.tAt(4975), 140 + (230 - 140) * 0.5, 1e-9, 'half the MD → half way');
      assert.ok(Math.abs(Wg.tvdAt(4975) - 4975) > 100, 'the deviated well is not linear in TVD at that point');
      // BHT from the geotherm when the reservoir temperature is missing (gas well geotherm 70 °F → 230 °F at 9,300 ft TVD)
      const Wn = N.build(M.well, { res: { T_F: null } });
      near(assert, Wn.temp.bht, 70 + 160 * Wn.nodes.midPerfTvd / 9300, 1e-9, 'BHT from the geotherm');
      // no THT: the static geotherm along the well, the surface temperature for the hydrate check
      const O2 = S.FIX.oilWell; O2.well.heat.tht_F = null;
      const W2 = N.build(O2.well, { res: O2.res });
      assert.strictEqual(W2.temp.mode, 'static');
      near(assert, W2.tAt(4000), 130, 1e-9, 'geotherm at 4,000 ft TVD');
      assert.strictEqual(W2.temp.verdict, 'geotherm');
      near(assert, W2.temp.thtHyd, 60, 1e-12, 'surface geotherm for the hydrate check');
      assert.ok(plain(W2.warnings).some((w) => w.code === 'NO_THT'));
      // relax (A2): linear with an info note
      const r = N.temperature(W, { mode: 'relax' });
      assert.ok(r.ok && r.mode === 'linear' && plain(r.warnings).some((w) => w.code === 'TEMP_RELAX_A2' && w.sev === 'info'));
      near(assert, r.tAt(4000), 160, 1e-12, 'same profile');
      // overrides through o: THT / BHT
      const o = N.temperature(W, { tht_F: 100, bht_F: 220 });
      near(assert, o.tAt(4000), 160, 1e-12, 'override midpoint');
      assert.strictEqual(N.temperature(null).ok, false);
    },
  },
  {
    name: 'WT2 J-T hydrate THT (gas / condensate, estimated THT): THT_hyd = THT − μ_JT·Δp_tubing with μ_JT from WTS_gaspvt_isenthalpic at the mean tubing pressure and temperature; Δp from pwf − THP or given; impurities change μ_JT',
    wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, N = G.WTS_wp_well, M = S.FIX.gasWell;
      const W = N.build(M.well, { res: M.res, fluidType: 'condensate' });
      const F = FLUID('condensate', 0.65);
      const t = N.temperature(W, { F, pwf: 3200, thp: 1600 });
      assert.strictEqual(t.verdict, 'jt-corrected', t.verdictText);
      const tm = 0.5 * (140 + 230), pm = 2400;
      const ref = G.WTS_gaspvt_isenthalpic({ sg: 0.65, p1: pm, t1: tm, p2: pm }).muJT1_Fpsi;
      assert.ok(ref > 0.005 && ref < 0.08, 'μ_JT plausible for a natural gas: ' + ref);
      near(assert, t.muJT, ref, 1e-15, 'μ_JT from WTS_gaspvt_isenthalpic');
      near(assert, t.dpTubing, 1600, 1e-12, 'Δp = pwf − THP'); near(assert, t.pMean, pm, 1e-12, 'mean pressure');
      near(assert, t.thtHyd, 140 - ref * 1600, 1e-12, 'THT_hyd');
      assert.ok(t.thtHyd < 140, 'cooling');
      assert.ok(/Joule-Thomson/.test(t.verdictText), 'verdict text');
      // Δp given with the THP only (mean = THP + Δp / 2); the THT profile itself is unchanged (the correction is for the hydrate check)
      const t2 = N.temperature(W, { F, thp: 1600, dpTubing: 1600 });
      near(assert, t2.thtHyd, t.thtHyd, 1e-12, 'same mean conditions');
      near(assert, t2.tAt(0), 140, 1e-12, 'profile unchanged');
      // gas gravity from the fluid object without at(): F.sgg; dry gas type 'gas'
      const t3 = N.temperature(W, { F: { type: 'gas', sgg: 0.75, pvt: {} }, pwf: 3200, thp: 1600 });
      near(assert, t3.muJT, G.WTS_gaspvt_isenthalpic({ sg: 0.75, p1: pm, t1: tm, p2: pm }).muJT1_Fpsi, 1e-15, 'sgg 0.75');
      // impurities (mol %) through F.pvt.imp
      const t4 = N.temperature(W, { F: FLUID('condensate', 0.75, { co2: 10, n2: 0, h2s: 0 }), pwf: 3200, thp: 1600 });
      near(assert, t4.muJT, G.WTS_gaspvt_isenthalpic({ sg: 0.75, p1: pm, t1: tm, p2: pm, co2: 10 }).muJT1_Fpsi, 1e-15, 'CO2 10 %');
      assert.ok(Math.abs(t4.muJT - t3.muJT) > 1e-4, 'impurities change μ_JT');
    },
  },
  {
    name: 'WT3 verdicts: measured THT is used as is; an estimated THT without the J-T correction reads "upper-bound THT, not conservative" (gas without pressures, oil wells)',
    wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const N = app(ctx).win.WTS_wp_well, M = S.FIX.gasWell;
      const W = N.build(M.well, { res: M.res, fluidType: 'condensate' });
      const F = FLUID('condensate', 0.65);
      // no tubing pressures yet (before a solve)
      const u = N.temperature(W, { F });
      assert.strictEqual(u.verdict, 'upper-bound');
      assert.ok(/upper-bound THT, not conservative/.test(u.verdictText), u.verdictText);
      assert.strictEqual(u.thtHyd, 140);
      assert.strictEqual(W.temp.verdict, 'upper-bound', 'the build-time profile has no pressures');
      // measured: no correction even with pressures
      const m = N.temperature(W, { F, pwf: 3200, thp: 1600, thtMeasured: true });
      assert.deepStrictEqual([m.verdict, m.thtHyd, m.muJT], ['measured', 140, null]);
      const Mm = S.FIX.gasWell; Mm.well.heat.thtMeasured = true;
      assert.strictEqual(N.build(Mm.well, { res: Mm.res }).temp.verdict, 'measured', 'from M.well.heat.thtMeasured');
      // an oil well with an estimated THT: no gas J-T correction → upper-bound
      const O = S.FIX.oilWell, Wo = N.build(O.well, { res: O.res, fluidType: 'oil' });
      const o = N.temperature(Wo, { F: FLUID('oil', 0.65), pwf: 2500, thp: 250 });
      assert.deepStrictEqual([o.verdict, o.thtHyd, o.muJT], ['upper-bound', 120, null]);
      // THT above BHT is flagged
      const h = N.temperature(Wo, { tht_F: 250 });
      assert.ok(plain(h.warnings).some((w) => w.code === 'THT_ABOVE_BHT'));
    },
  },
];
