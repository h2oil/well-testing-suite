// DFIT — WP3 uncertainty budget and what-if propagator (docs/DFIT-PLAN.md §6.6; §9 WP3).
//
//   U1  determinism: the same seed gives the same result (sync = job); another seed differs
//   U2  all inputs fixed, single closure: P10 = P50 = P90 = the deterministic chain (incl. C_sys, A_f·c_f, R_vis), which
//       agrees with the frozen §4.21 reference chain of _dfit-shapes; the matched-α η_G for α = 1 and α = 4/5 runs
//   U3  range case: bimodal, no pooled P50 for closure, xf, η, p_n or CL; per-family columns contain each family's chain;
//       interpretation share > 60 % (closure, p_n; η shares it with the tp draw); V_i*(σ_c) of each family chain (§4.3)
//   U4  first-order shares sum within [0.8, 1.2] on an additive test function
//   U5  1,000 draws = 1,000 chain evaluations (counts.draws) and linear scaling (2,000 draws < 2.5 × the work)
//   U6  changing the family weight changes neither per-family column and logs one entry
'use strict';

const S = require('./_dfit-shapes');

const WP = 'DF3';
const near = (assert, a, b, tol, what) => assert(typeof a === 'number' && isFinite(a) && Math.abs(a - b) <= tol, what + ': ' + a + ' vs ' + b + ' (± ' + tol + ')');
const rel = (assert, a, b, f, what) => near(assert, a, b, Math.abs(b) * f, what);
function app0(ctx) { const a = S.sharedApp(ctx); S.resetDfit(a); return a; }
const WELL = { mu: 0.5, phi: 0.06, ct: 1e-5, h: 40, fluid: 'water' };
const INPUTS = () => S.FIX.state.tests[0].inputs;
// the toy contact case of FIX.state t2 on the reference data: closure RANGE, family medians 6,998 (F1) / 6,507 (F2)
function rangeRun() {
  const run = S.FIX.run, r = S.rng(11), g = () => { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
  const c = run.consensus;
  c.mode = 'range'; c.value = null; c.confidence = 'medium'; c.bimodal = true;
  c.range = { lo: 6495, hi: 7004, medians: { low: 6507, high: 6998 }, lowFamily: 'F2', highFamily: 'F1' };
  c.samples = { F1: Array.from({ length: 104 }, () => 6998 + 4 * g()), F2: Array.from({ length: 104 }, () => 6507 + 6 * g()), F4: [] };
  c.families.F1 = { p10: 6993, p50: 6998, p90: 7003, sigma: 4, n: 104 }; c.families.F2 = { p10: 6499, p50: 6507, p90: 6515, sigma: 6, n: 104 };
  return run;
}
const CLOSURE_DEP = ['closure', 'xf', 'eta', 'pn', 'CL'];

module.exports = [
  {
    name: 'U1 determinism: same seed → same result (sync = job); another seed differs',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win, run = S.FIX.run, o = { n: 500, seed: 7, inputs: INPUTS(), well: WELL };
      const a = win.PRiSM_dfit_uncertainty(run, o), b = win.PRiSM_dfit_uncertainty(run, o);
      assert(a.ok === true, 'ok: ' + JSON.stringify(a.errors || ''));
      const sh = S.checkShape('Uncertainty', a); assert(sh.ok, 'Uncertainty shape: ' + JSON.stringify(sh.errors.slice(0, 5)));
      assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), 'same seed, same result');
      const j = win.PRiSM_dfit_uncertaintyJob(run, o); let k = 0; while (!j.step().done && k++ < 50);
      assert(k >= 1, 'the job takes several units (250 draws each)');
      assert.deepStrictEqual(JSON.parse(JSON.stringify(j.result())), JSON.parse(JSON.stringify(a)), 'job = sync');
      const c = win.PRiSM_dfit_uncertainty(run, Object.assign({}, o, { seed: 8 }));
      assert(c.outputs.xf.p50 !== a.outputs.xf.p50, 'another seed gives other draws');
      assert(a.seed === 7 && a.n === 500 && a.mode === 'single', 'seed, n and mode carried');
    },
  },
  {
    name: 'U2 all inputs fixed and a single closure: P10 = P50 = P90 = the deterministic chain (C_sys, A_f·c_f, R_vis), = the §4.21 reference chain',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win, run = S.FIX.run, o = { n: 200, seed: 1, inputs: INPUTS(), well: WELL, fixAll: true };
      const u = win.PRiSM_dfit_uncertainty(run, o);
      assert(u.ok === true, 'ok');
      const det = win.PRiSM_dfit_uncertainty.chain(run.consensus.value, run, o);
      ['closure', 'pn', 'eta', 'etaF', 'Csys', 'AfCf', 'Rvis', 'xf', 'CL', 'Gamma', 'k', 'pi'].forEach((k) => {
        const q = u.outputs[k]; assert(q && q.bimodal === false, k + ' present');
        near(assert, q.p10, det[k], 1e-9 * Math.max(1, Math.abs(det[k])), k + ' P10'); near(assert, q.p90, det[k], 1e-9 * Math.max(1, Math.abs(det[k])), k + ' P90');
        near(assert, q.p50, det[k], 1e-9 * Math.max(1, Math.abs(det[k])), k + ' P50 = deterministic chain');
      });
      assert(u.inputs.every((it) => it.dist === 'fixed'), 'every input fixed');
      const ref = S.FIX.ref.chain(run.consensus.value);
      rel(assert, det.Csys, ref.Csys, 0.005, 'C_sys vs the reference chain'); rel(assert, det.AfCf, ref.AfCf, 0.01, 'A_f·c_f');
      near(assert, det.Rvis, ref.Rvis, 0.005, 'R_vis'); near(assert, det.eta, ref.eta.a05, 0.002, 'η_G');
      rel(assert, det.xf, ref.geometry.byModel.PKN.xf, 0.01, 'PKN xf'); rel(assert, det.CL, ref.geometry.byModel.PKN.CL, 0.01, 'CL');
      near(assert, det.Gamma, ref.Gamma, 0.01, 'Γ'); rel(assert, det.k, ref.kBefore.kCL.k, 0.02, 'k from CL');
      near(assert, det.pn, ref.pn, 0.2, 'p_n');
      // matched α: an α = 1 run (G on the α = 1 closed form) gives η_G = G_c/(G_c + 16/(3π)) = the reference α = 1 value
      const G1 = (d) => 4 / Math.PI * (4 / 3 * (Math.pow(1 + d, 1.5) - Math.pow(d, 1.5)) - 4 / 3);
      const r1 = S.FIX.run; r1.derivs.alpha = 1; r1.derivs.gType = 'a1'; r1.derivs.G = r1.derivs.dtD.map((d) => (d == null ? null : G1(d)));
      const d1 = win.PRiSM_dfit_uncertainty.chain(run.consensus.value, r1, o);
      near(assert, d1.eta, d1.Gc / (d1.Gc + 16 / (3 * Math.PI)), 1e-12, 'α = 1: η_G = G_c/(G_c + 16/(3π))');
      near(assert, d1.eta, ref.eta.a1, 0.002, 'α = 1: η_G vs the reference α = 1 value');
      assert(d1.eta > det.eta, 'α = 1 efficiency above α = ½ (' + d1.eta + ' > ' + det.eta + ')');
      const u1 = win.PRiSM_dfit_uncertainty(r1, o);
      near(assert, u1.outputs.eta.p50, d1.eta, 1e-12, 'α = 1 run: P50 = the matched-α chain');
      // general α (4/5): 4·g0/π = 1.8016
      const r8 = S.FIX.run; r8.derivs.alpha = 0.8; r8.derivs.gType = 'general';
      const d8 = win.PRiSM_dfit_uncertainty.chain(run.consensus.value, r8, o);
      near(assert, d8.eta, d8.Gc / (d8.Gc + 1.8016), 2e-5, 'α = 4/5: η_G = G_c/(G_c + 1.8016)');
    },
  },
  {
    name: 'U3 range case: bimodal, no pooled P50 for closure, xf, η, p_n, CL; per-family columns contain each chain; interpretation share > 60 %',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win, run = rangeRun(), o = { n: 1000, seed: 3, inputs: INPUTS(), well: WELL, familyWeightF1: 0.5 };
      const u = win.PRiSM_dfit_uncertainty(run, o);
      assert(u.ok === true && u.mode === 'range', 'range mode');
      const sh = S.checkShape('Uncertainty', u); assert(sh.ok, 'Uncertainty shape: ' + JSON.stringify(sh.errors.slice(0, 5)));
      CLOSURE_DEP.forEach((k) => {
        const q = u.outputs[k];
        assert(q.bimodal === true && q.p10 === null && q.p50 === null && q.p90 === null, k + ': no pooled P10/P50/P90');
        assert(q.byFamily && q.envelope, k + ': per-family columns and the envelope');
        ['F1', 'F2'].forEach((F) => {
          const det = win.PRiSM_dfit_uncertainty.chain(F === 'F1' ? 6998 : 6507, run, o)[k], b = q.byFamily[F];
          assert(b.p10 <= det && det <= b.p90, k + ' ' + F + ' column [' + b.p10 + ', ' + b.p90 + '] contains the chain value ' + det);
        });
        assert(q.envelope[0] <= Math.min(q.byFamily.F1.p10, q.byFamily.F2.p10) + 1e-9 && q.envelope[1] >= Math.max(q.byFamily.F1.p90, q.byFamily.F2.p90) - 1e-9, k + ' envelope');
      });
      ['closure', 'pn'].forEach((k) => assert(u.outputs[k].closureShare > 0.6, k + ' interpretation share > 60 %: ' + u.outputs[k].closureShare));
      // η moves with the tp draw (pump / breakdown / veq, §6.6) as much as with the family here (G_c 17.9 / 19.0 for F1 / F2,
      // 19.2 at the breakdown tp): the interpretation and tp shares together carry ≥ 80 % of its variance
      const eS = u.outputs.eta, tpS = (eS.shares.find((x) => x.input === 'tp') || { s: 0 }).s;
      assert(eS.closureShare > 0.25 && eS.closureShare + tpS >= 0.8, 'η: interpretation ' + eS.closureShare + ' + tp ' + tpS + ' ≥ 0.8');
      assert(u.inputs.some((it) => it.name === 'tp' && it.dist === 'empirical' && it.params.values.length === 3), 'tp drawn from the three event values');
      ['Gamma', 'pi'].forEach((k) => assert(u.outputs[k].bimodal === false && u.outputs[k].p50 !== null, k + ' does not depend on the closure: single P50'));
      assert(u.familyWeight.F1 === 0.5 && u.familyWeight.F2 === 0.5, 'family weight');
      // V_i*(σ_c) per family chain (§4.3): V_i − V_w·c_w·(σ_c − p_start) − V_fill. A run whose V_i* follows that definition at its
      // closure (FracOutputs of 56: 25 − 7.908e-4 × (7,000 − 4,500) = 23.02 bbl) gives each family chain the 56 value at its own σ_c
      const r3 = rangeRun(), VwCw = r3.frac.chosen.VwCw, vi = (pc) => 25 - VwCw * (pc - 4500);
      r3.frac.chosen.ViStar = vi(r3.frac.chosen.pClosure); r3.events.ViStar = r3.frac.chosen.ViStar;
      ['F1', 'F2'].forEach((F) => {
        const pc = F === 'F1' ? 6998 : 6507, c3 = win.PRiSM_dfit_uncertainty.chain(pc, r3, o);
        near(assert, c3.ViStar, vi(pc), 1e-9, F + ' chain V_i*(σ_c) = the FracOutputs value at ' + pc + ' psia');
      });
      const c1 = win.PRiSM_dfit_uncertainty.chain(6998, run, o), c2 = win.PRiSM_dfit_uncertainty.chain(6507, run, o);
      near(assert, c2.ViStar - c1.ViStar, VwCw * (6998 - 6507), 1e-9, 'F2 chain V_i* larger by V_w·c_w·Δσ (' + (c2.ViStar - c1.ViStar) + ' bbl)');
      const c2w = win.PRiSM_dfit_uncertainty.chain(6507, run, o, { VwCw: 2 * VwCw });
      near(assert, c2w.ViStar, c2.ViStar - VwCw * (6507 - 4500), 1e-9, 'a drawn V_w·c_w moves V_i* by ΔV_w·c_w·(σ_c − p_start)');
      assert(u.tornado.some((t) => t.family === 'F1') && u.tornado.some((t) => t.family === 'F2'), 'tornado per family');
    },
  },
  {
    name: 'U4 first-order shares sum within [0.8, 1.2] on an additive test function',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win, r = S.rng(5), n = 2000, X = [[], [], []], y = [];
      for (let i = 0; i < n; i++) { const a = r(), b = r(), c = r(); X[0].push(a); X[1].push(b); X[2].push(c); y.push(3 * a + 2 * b + c); }
      const s = X.map((x) => win.PRiSM_dfit_uncertainty.shares(x, y, 20)), sum = s[0] + s[1] + s[2];
      assert(sum >= 0.8 && sum <= 1.2, 'sum of shares ' + sum);
      assert(s[0] > s[1] && s[1] > s[2], 'ordering 9 : 4 : 1 → ' + s.map((v) => v.toFixed(3)).join(' / '));
      near(assert, s[0], 9 / 14, 0.05, 'S₁ ≈ 9/14');
    },
  },
  {
    name: 'U5 1,000 draws make exactly 1,000 chain evaluations and the work scales linearly (2,000 < 2.5 × 1,000)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win, run = S.FIX.run, base = { seed: 1, inputs: INPUTS(), well: WELL };
      const a = win.PRiSM_dfit_uncertainty(run, Object.assign({ n: 1000 }, base)), b = win.PRiSM_dfit_uncertainty(run, Object.assign({ n: 2000 }, base));
      assert(a.counts.draws === 1000 && b.counts.draws === 2000, 'draws ' + a.counts.draws + ' / ' + b.counts.draws);
      assert(a.counts.chainEvals - a.counts.draws === b.counts.chainEvals - b.counts.draws, 'only the tornado adds chain evaluations, independent of n');
      assert(b.counts.ops < 2.5 * a.counts.ops, 'work ' + b.counts.ops + ' < 2.5 × ' + a.counts.ops);
      const c = win.PRiSM_dfit_uncertainty(run, Object.assign({}, base, { n: 5000 }));
      assert(c.n === 2000 && c.counts.draws === 2000, 'hard cap 2,000 draws');
    },
  },
  {
    name: 'U6 changing the family weight changes neither per-family column and logs one entry',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win, run = rangeRun(), o = { n: 600, seed: 4, inputs: INPUTS(), well: WELL };
      const a = win.PRiSM_dfit_uncertainty(run, Object.assign({ familyWeightF1: 0.5 }, o));
      const b = win.PRiSM_dfit_uncertainty(run, Object.assign({ familyWeightF1: 0.8, prevFamilyWeightF1: 0.5 }, o));
      CLOSURE_DEP.forEach((k) => {
        assert.deepStrictEqual(b.outputs[k].byFamily, a.outputs[k].byFamily, k + ': per-family columns unchanged');
        assert.deepStrictEqual(b.outputs[k].envelope, a.outputs[k].envelope, k + ': envelope unchanged');
      });
      assert(b.familyWeight.F1 === 0.8 && Math.abs(b.familyWeight.F2 - 0.2) < 1e-12, 'weight carried');
      assert(b.outputs.closure.closureShare !== a.outputs.closure.closureShare, 'the weight changes only the share split');
      assert(Array.isArray(b.log) && b.log.length === 1 && b.log[0].item === 'options.familyWeightF1' && b.log[0].old === 0.5 && b.log[0].new === 0.8 && /not a probability/.test(b.log[0].reason), 'one log entry');
      assert(a.log.length === 0, 'no entry without a change');
    },
  },
];
