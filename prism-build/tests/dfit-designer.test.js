// DFIT — WP4 pre-job designer and leak budget (docs/DFIT-PLAN.md §6.4, §6.5, §9 WP4). Pure engine, one shared app per
// file (opts:false).
//
//   D1  deterministic with the seed (same seed → identical Design; another seed → different draws); Design shape
//   D2  planning reference cases (conventional oil / tight gas / shale gas): outcome labels and the radial recognisable /
//       confirmed times within 5 % of 3.6 h / 16 h, 20 d / 90 d (≈ 0.5 psi signal at confirmation), 7.1 yr / 33 yr
//   D3  V_min = C_ac·(p_c − p_i)/ε_max: 7.5e-4 × 2,500/0.05 = 37.5 bbl (19 bbl at ε_max 0.10)
//   D4  vacuum predictor on the reference column: p_s 195 / 96 / −3 psia for p_w 4,500 / 4,400 / 4,300 — WTS_wellbore.vacuum
//       (WP1) is stubbed in the test with the reference column's numbers until WP1 merges (plan §2.12 rule 4); the
//       constant-gradient fallback is checked as well
//   D5  500 draws as a Job stepped synchronously make exactly 500 coarse runs (counts.evals); Job = sync
//   D6  the leak budget switches from Θ = 2 to the radial Θ when the P90 t_DL(t_end) ≥ 1; the hold card flags the
//       temperature requirement as unrealistic at 100 °F
'use strict';

const S = require('./_dfit-shapes');

const WP = 'DF4';
let CACHE = { app: null };
function app(ctx) {
  const a = S.sharedApp(ctx); S.resetDfit(a);
  if (CACHE.app !== a) CACHE = { app: a };
  return a.win;
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const rel = (a, b) => Math.abs(a - b) / Math.abs(b);
function within(assert, a, b, r, what) { assert(typeof a === 'number' && rel(a, b) <= r, what + ': ' + a + ' vs ' + b + ' (± ' + r * 100 + ' %)'); }
const RANGES = () => S.FIX.samples.DesignRanges;
function fixedCase(o) {
  const r = RANGES(), pr = (v) => ({ p10: v, p90: v });
  r.k = pr(o.k); r.phi = pr(o.phi); r.ct = pr(o.ct); r.muRes = pr(o.mu); r.h = pr(o.h); r.hf = pr(o.hf || 100); r.hp = null;
  r.V = o.V; r.allowedShutInD = o.days || 10; r.Ep = { p50: 5e6, sdLn: 0 }; r.sigmaGrad = { p50: 0.7, sd: 0 }; r.piGrad = { p50: o.piGrad || 0.45, sd: 0 };
  return r;
}
const CASES = {
  conventional: { r: { k: 5, phi: 0.18, ct: 1e-5, mu: 1, h: 30, V: 10 }, L: 40, label: 'radial', rec: 3.6, conf: 16, unit: 1 },
  tight: { r: { k: 0.01, phi: 0.08, ct: 1.11e-4, mu: 0.0243, h: 60, V: 15 }, L: 60, label: 'linear', rec: 20, conf: 90, unit: 24 },
  shale: { r: { k: 1e-4, phi: 0.06, ct: 1.11e-4, mu: 0.0243, h: 100, V: 20 }, L: 80, label: 'linear', rec: 7.1, conf: 33, unit: 8766 },
};
function runCase(W, name) {
  if (CACHE['case_' + name]) return CACHE['case_' + name];
  const c = CASES[name], d = W.PRiSM_dfit_design(fixedCase(c.r), { n: 8, seed: 1, L: c.L, precision: false });
  CACHE['case_' + name] = d; return d;
}

module.exports = [
  {
    name: 'DFIT D1: designer deterministic with the seed; Design shape; another seed changes the draws', wp: WP, opts: false,
    run(_a, assert, ctx) {
      const W = app(ctx), a = W.PRiSM_dfit_design(RANGES(), { n: 60, seed: 7 }), b = W.PRiSM_dfit_design(RANGES(), { n: 60, seed: 7 });
      assert.strictEqual(a.ok, true, 'design ok: ' + JSON.stringify(a).slice(0, 200));
      const sh = S.checkShape('Design', a); assert(sh.ok, 'Design shape: ' + sh.errors.slice(0, 4).join('; '));
      assert(S.checkShape('DesignRanges', RANGES()).ok, 'fixture ranges');
      assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), 'same seed → identical design');
      const c = W.PRiSM_dfit_design(RANGES(), { n: 60, seed: 8 });
      assert.notDeepStrictEqual(c.tc, a.tc, 'another seed → other draws');
      assert.strictEqual(a.seed, 7, 'the seed travels with the result'); assert.strictEqual(a.n, 60, 'n');
      assert(a.tc.p10 <= a.tc.p50 && a.tc.p50 <= a.tc.p90, 't_c P10 ≤ P50 ≤ P90');
      assert(a.corridor.t.length === 60 && a.corridor.p50.every((v, i) => v == null || (v >= a.corridor.p10[i] - 1e-9 && v <= a.corridor.p90[i] + 1e-9)), 'P10–P90 corridor');
      assert(a.checklist.length >= 6 && a.checklist.every((x) => /^C\d+$/.test(x.id) && x.text.length < 300), 'checklist');
      assert.deepStrictEqual(JSON.parse(JSON.stringify(a.stepDown.rates)), [5, 4, 3, 2, 1], 'five-step step-down from the treating rate to 20 %');
      const bad = W.PRiSM_dfit_design({}, { n: 5 });
      assert(bad.ok === false && S.checkShape('Failure', bad).ok, 'missing ranges → failure form');
    },
  },
  {
    name: 'DFIT D2: planning reference cases — conventional 3.6 h / 16 h radial, tight gas 20 d / 90 d linear (≈ 0.5 psi), shale 7.1 / 33 yr linear', wp: WP, opts: false,
    run(_a, assert, ctx) {
      const W = app(ctx);
      Object.keys(CASES).forEach((name) => {
        const c = CASES[name], d = runCase(W, name);
        assert.strictEqual(d.ok, true, name + ' ok');
        assert.strictEqual(d.outcome.label, c.label, name + ' outcome: ' + d.outcome.text);
        within(assert, d.tRadial.p50 / c.unit, c.rec, 0.05, name + ' radial recognisable');
        within(assert, d.tConfirm.p50 / c.unit, c.conf, 0.05, name + ' radial confirmed');
        assert(d.outcome.text.length < 300 && /k range/.test(d.outcome.text), name + ' outcome sentence names the k range');
      });
      within(assert, runCase(W, 'tight').signalConfirmPsi.p50, 0.5, 0.10, 'tight-gas signal at confirmation');
      assert(/p_i and bounds on k/.test(runCase(W, 'shale').outcome.text), 'shale: plan for p_i and bounds on k');
      assert.strictEqual(runCase(W, 'conventional').shutIn.binding, 'radial', 'conventional: the radial confirmation binds');
    },
  },
  {
    name: 'DFIT D3: V_min = C_ac·(p_c − p_i)/ε_max — 37.5 bbl at 7.5e-4 bbl/psi, 2,500 psi, 0.05; 19 bbl at ε_max 0.10', wp: WP, opts: false,
    run(_a, assert, ctx) {
      const W = app(ctx), r = fixedCase(CASES.conventional.r);
      r.sigmaGrad = { p50: 0.70, sd: 0 }; r.piGrad = { p50: 0.45, sd: 0 }; r.datumTvd = 10000;   // p_c − p_i = 2,500 psi
      const a = W.PRiSM_dfit_design(r, { n: 4, seed: 1, VwCw: 7.5e-4, precision: false });
      assert.strictEqual(a.ok, true, 'ok'); assert.near(a.Vmin, 37.5, 1e-9, 'V_min');
      const r2 = clone(r); r2.epsMax = 0.10;
      const b = W.PRiSM_dfit_design(r2, { n: 4, seed: 1, VwCw: 7.5e-4, precision: false });
      assert.near(b.Vmin, 18.75, 1e-9, 'V_min at ε_max 0.10 (≈ 19 bbl)');
      const c = W.PRiSM_dfit_design(Object.assign(clone(r), { V: null, suggest: true }), { n: 4, seed: 1, VwCw: 7.5e-4, precision: false });
      assert.strictEqual(c.V, 38, 'suggested volume = V_min rounded up');
      const f = W.PRiSM_dfit_design(r, { n: 4, seed: 1, precision: false });   // C_ac from the string capacity (fallback): 7.91e-4 bbl/psi
      within(assert, f.VwCw, 7.91e-4, 0.005, 'string-capacity storage'); assert.near(f.Vmin, f.VwCw * 2500 / 0.05, 1e-9, 'V_min with the string storage');
      assert(a.warnings.some((w) => w.code === 'VOLUME_BELOW_VMIN'), 'a planned 10 bbl below V_min is flagged');
    },
  },
  {
    name: 'DFIT D4: vacuum predictor on the reference column — p_s 195 / 96 / −3 psia for p_w 4,500 / 4,400 / 4,300', wp: WP, opts: false,
    run(_a, assert, ctx) {
      const W = app(ctx), wb = W.WTS_wellbore, orig = wb && wb.vacuum;
      const seen = [];
      // explicit stub of WP1's WTS_wellbore.vacuum (reference column, geotherm) until WP1 merges
      const REF = { 4500: 195, 4400: 96, 4300: -3 };
      wb.vacuum = function (pi) { seen.push(pi); const ps = REF[Math.round(pi)]; return { risk: ps < 14.696 ? 'surface-zero' : 'none', pSurfAtPi: ps, text: '' }; };
      try {
        const out = {};
        [4500, 4400, 4300].forEach((p) => {
          const r = fixedCase(CASES.conventional.r); r.piGrad = { p50: p / 10000, sd: 0 }; r.gauge.kind = 'surface';
          out[p] = W.PRiSM_dfit_design(r, { n: 4, seed: 1, precision: false });
          assert.strictEqual(out[p].ok, true, 'design ok at ' + p);
        });
        assert.deepStrictEqual(seen.map((v) => Math.round(v)), [4500, 4400, 4300], 'the designer asks the column at the expected p_i');
        assert.near(out[4500].vacuumDetail.pSurfAtPi, 195, 1e-9, 'p_s at 4,500'); assert.near(out[4400].vacuumDetail.pSurfAtPi, 96, 1e-9, 'p_s at 4,400'); assert.near(out[4300].vacuumDetail.pSurfAtPi, -3, 1e-9, 'p_s at 4,300');
        assert.strictEqual(out[4500].vacuum.risk, 'none', '4,500: liquid-supported'); assert.strictEqual(out[4400].vacuum.risk, 'none', '4,400: liquid-supported');
        assert.strictEqual(out[4300].vacuum.risk, 'surface-zero', '4,300: vacuum');
        assert(/BH gauge required for ACA/.test(out[4300].vacuum.text) && out[4300].gauge.bhRequired === true, 'bottomhole gauge required');
        assert(/surface gauge sees closure/.test(out[4500].vacuum.text), 'surface gauge sufficient');
      } finally { wb.vacuum = orig; }
      // constant-gradient fallback while WTS_wellbore.vacuum is still the WP0 stub
      const r = fixedCase(CASES.conventional.r);
      const d = W.PRiSM_dfit_design(r, { n: 4, seed: 1, precision: false });
      if (orig && orig._dfitStub) { assert.strictEqual(d.vacuumDetail.src, 'constant gradient', 'fallback'); assert.near(d.vacuumDetail.pSurfAtPi, 4500 - 0.052 * 8.43 * 10000, 1e-6, 'constant-gradient p_s'); }
    },
  },
  {
    name: 'DFIT D5: 500 draws as a Job stepped synchronously — exactly 500 coarse runs; Job = sync', wp: WP, opts: false,
    run(_a, assert, ctx) {
      const W = app(ctx), job = W.PRiSM_dfit_designJob(RANGES(), { n: 500, seed: 3 });
      assert(S.checkShape('Job', job).ok, 'Job shape');
      let s, steps = 0, last = -1;
      do { s = job.step(); steps++; assert(s.progress >= last && s.progress <= 1, 'progress'); last = s.progress; } while (!s.done && steps < 1000);
      const j = job.result();
      assert.strictEqual(j.ok, true, 'job ok'); assert.strictEqual(j.counts.evals, 500, 'exactly 500 coarse runs'); assert.strictEqual(j.n, 500, 'n');
      assert(steps >= 20, 'sliced by count (' + steps + ' steps)');
      const sy = W.PRiSM_dfit_design(RANGES(), { n: 500, seed: 3 });
      assert.deepStrictEqual(JSON.parse(JSON.stringify(sy)), JSON.parse(JSON.stringify(j)), 'job = sync');
      assert(sy.precision.length >= 3 && sy.precision.every((p, i) => i === 0 || p.sdPi <= sy.precision[i - 1].sdPi + 1e-12), 'pre-job precision falls with the shut-in');
      const jc = W.PRiSM_dfit_designJob(RANGES(), { n: 100, seed: 3 }); jc.step(); jc.step(); jc.cancel();
      assert(jc.step().done && jc.result().code === 'CANCELLED', 'cancel');
    },
  },
  {
    name: 'DFIT D6: leak budget — Θ = 2 in linear flow, the radial Θ when the P90 t_DL(t_end) ≥ 1; hold unrealistic at 100 °F', wp: WP, opts: false,
    run(_a, assert, ctx) {
      const W = app(ctx);
      const lin = W.PRiSM_dfit_leakBudget(25, 300, { sigmaP: 0.05, VwCw: 7.91e-4 });
      assert.strictEqual(lin.ok, true, 'ok'); assert.strictEqual(lin.regime, 'linear', 'linear'); assert.strictEqual(lin.theta, 2, 'Θ = 2');
      assert.near(lin.qkMax, 0.050, 1e-9, 'q_k,max 0.050 bbl/d (25 bbl, 300 h)'); assert.near(lin.holdMin, 5.7, 0.05, 'hold 5.7 min');
      assert.near(lin.dTneeded, 0.25 / 65, 1e-9, 'temperature stability 0.004 °F'); assert.strictEqual(lin.holdRealistic, false, 'unrealistic at 100 °F');
      assert(/unrealistic/.test(lin.text) && lin.text.length < 300, 'hold sentence');
      const rad = W.PRiSM_dfit_leakBudget(25, 300, { tDL: 5, sigmaP: 0.05, VwCw: 7.91e-4 });
      assert.strictEqual(rad.regime, 'radial', 'radial'); within(assert, rad.theta, 4.509, 0.01, 'Θ(t_DL 5)'); assert.near(rad.qkMax, 0.022, 5e-4, 'q_k,max 0.022 bbl/d');
      const below = W.PRiSM_dfit_leakBudget(25, 300, { tDLDraws: [0.1, 0.3, 0.5, 0.8, 0.9], sigmaP: 0.05 });
      assert.strictEqual(below.theta, 2, 'P90 t_DL < 1 → Θ = 2');
      const above = W.PRiSM_dfit_leakBudget(25, 300, { tDLDraws: [0.1, 0.3, 0.5, 2, 3], sigmaP: 0.05 });
      assert(above.regime === 'radial' && above.theta > 2, 'P90 t_DL ≥ 1 → radial Θ');
      // permeability draws (md) under the §3.7 name kDraws: converted to t_DL(t_end) = C_TDL·k·t_end/(φ·μ·c_t·L²) when φ, μ,
      // c_t and L are given; without them they are not mistaken for t_DL values (warning, linear flow)
      const kNo = W.PRiSM_dfit_leakBudget(25, 300, { kDraws: [1e-3, 5e-3, 0.01], sigmaP: 0.05 });
      assert(kNo.ok && kNo.regime === 'linear' && kNo.theta === 2 && kNo.tDL === null, 'k draws without φ, μ, c_t, L: not read as t_DL');
      assert(kNo.warnings.some((w) => w.code === 'LEAK_KDRAWS_UNUSED' && w.text.length < 300), 'k draws without φ, μ, c_t, L: warning');
      const kTight = W.PRiSM_dfit_leakBudget(25, 300, { kDraws: [1e-3, 5e-3, 0.01], phi: 0.1, muRes: 0.5, ct: 1e-5, L: 100, sigmaP: 0.05 });
      assert(kTight.regime === 'linear' && kTight.theta === 2, 'tight k draws converted → linear (t_DL ' + kTight.tDL + ')');
      assert.near(kTight.tDL, 0.0002637 * 0.009 * 300 / (0.1 * 0.5 * 1e-5 * 1e4), 1e-9, 'P90 k 0.009 md → t_DL 0.142');
      const kConv = W.PRiSM_dfit_leakBudget(25, 300, { kDraws: [1, 5, 10], phi: 0.1, muRes: 0.5, ct: 1e-5, L: 100, sigmaP: 0.05 });
      assert(kConv.regime === 'radial' && kConv.warnings.length === 0, 'conventional k draws converted → radial');
      within(assert, kConv.theta, W._PRiSM_dfit_lk.theta(0.0002637 * 9 * 300 / (0.1 * 0.5 * 1e-5 * 1e4)), 1e-9, 'Θ at the P90 t_DL of the converted draws');
      const both = W.PRiSM_dfit_leakBudget(25, 300, { tDLDraws: [0.1, 0.2], kDraws: [1, 5, 10], phi: 0.1, muRes: 0.5, ct: 1e-5, L: 100 });
      assert.strictEqual(both.regime, 'linear', 'tDLDraws take precedence over kDraws');
      const hot = W.PRiSM_dfit_leakBudget(25, 300, { sigmaP: 0.05, VwCw: 7.91e-4, tempF: 250 });
      assert.near(hot.dpdT, 105, 1e-9, 'sealed column ≈ 105 psi/°F at 250 °F');
      // in the designer: conventional oil reaches radial flow (radial Θ), tight gas stays linear (Θ = 2)
      const conv = runCase(W, 'conventional'), tight = runCase(W, 'tight');
      assert(conv.leak.regime === 'radial' && conv.leak.theta > 2, 'designer: conventional → radial Θ (' + conv.leak.theta + ')');
      assert(tight.leak.regime === 'linear' && tight.leak.theta === 2, 'designer: tight gas → Θ = 2');
      assert.strictEqual(conv.leak.holdRealistic, false, 'designer hold card: unrealistic at 100 °F');
    },
  },
];
