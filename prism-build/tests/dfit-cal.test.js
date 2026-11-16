// DFIT — WP8 (3.4b) label calibration (docs/DFIT-PLAN.md §8.4, §9 WP8 "dfit-cal").
//
//   CA1 the generated table 49-calc-dfit-cal.js: shape, calibrated:true, generator g1, per-mode cells {p, lo, hi, n, met, target}
//       whose Wilson numbers recompute from (p, n), met = the §8.4 target out of fold (single high p ≥ 0.90 / lo ≥ 0.85, single
//       medium p ≥ 0.70 / lo ≥ 0.60, range medium p ≥ 0.70 and the interval-score check; low cells: no target), thresholds that
//       only tighten the 3.4a rule (wLow, gLow ≤ 2.5; rvisLow ≥ 0.3), only closure labels calibrated, the type not
//   CA2 the reference demo: the consensus label and hitRate follow the table cell, and the label text carries the rate
//   CA3 the shipped thresholds are applied by the engine: a benchmark case labelled medium by the 3.4a rule (R_vis 0.47 < rvisLow)
//       is low with the table, and medium again with the placeholder
//   CA4 the calibration tool (dfit-validate.js calibrate): out-of-fold search on synthetic records only tightens, picks R_vis when
//       low-R_vis medium cases are wrong, marks a missed cell met:false and refuses no fold
'use strict';

const SH = require('./_dfit-shapes');
const V = require('../dfit-validate.js');

const WP = 'DF8';
const real = (f) => typeof f === 'function' && !f._dfitStub;
function eng(ctx) { const a = SH.sharedApp(ctx, {}); SH.resetDfit(a); return a.win; }
const PLACEHOLDER = () => Object.freeze({ calibrated: false, version: null, generator: null, n: 0,
  hitRate: { single: { high: null, medium: null, low: null }, range: { medium: null, low: null } }, intervalScore: { range: null },
  cusum: { k: 0.5, h: 5, decimate: '2L' }, thresholds: {} });

const T = [];
T.push({
  name: 'CA1 the WP8 table: calibrated:true, out-of-fold Wilson cells, met = the §8.4 targets, tightening-only thresholds, closure labels only',
  wp: WP, opts: false,
  run(_a, assert, ctx) {
    const c = eng(ctx).PRiSM_dfit_cal;
    assert(c && c.calibrated === true && c.generator === 'g1' && /^g1-wp8-/.test(c.version) && c.n >= 800, 'table: ' + (c && c.version) + ' n ' + (c && c.n));
    assert(Object.isFrozen(c) && Object.isFrozen(c.hitRate.single.high || {}), 'deep-frozen');
    const TG = V.TARGETS;
    [['single', 'high'], ['single', 'medium'], ['single', 'low'], ['range', 'medium'], ['range', 'low']].forEach(([m, l]) => {
      const h = c.hitRate[m][l];
      if (!h) return;
      const w = V.wilson(Math.round(h.p * h.n), h.n);
      assert(Math.abs(w.lo - h.lo) < 1e-4 && Math.abs(w.hi - h.hi) < 1e-4 && h.lo <= h.p && h.p <= h.hi, m + ' ' + l + ' Wilson interval recomputes: ' + JSON.stringify(h));
      let want;
      if (m === 'single' && l === 'high') want = h.p >= TG.singleHigh && h.lo >= TG.singleHighLo;
      else if (m === 'single' && l === 'medium') want = h.p >= TG.singleMedium && h.lo >= TG.singleMediumLo;
      else if (m === 'range' && l === 'medium') want = h.p >= TG.rangeMedium && !!(c.intervalScore.rangeMedium && c.intervalScore.rangeMedium.ok);
      else want = true;
      assert.strictEqual(h.met, want, m + ' ' + l + ' met follows the §8.4 target: ' + JSON.stringify(h));
      assert(l === 'low' ? h.target === null : !!h.target, m + ' ' + l + ' target recorded');
    });
    const th = c.thresholds;
    assert(th.wLow <= 2.5 && th.gLow <= 2.5 && th.rvisLow >= 0.3, 'thresholds only tighten the 3.4a rule: ' + JSON.stringify(th));
    assert(V.CAL_GRID.wLow.indexOf(th.wLow) !== -1 && V.CAL_GRID.gLow.indexOf(th.gLow) !== -1 && V.CAL_GRID.rvisLow.indexOf(th.rvisLow) !== -1, 'thresholds on the search grid');
    assert.deepStrictEqual(Object.assign({}, c.labels), { closure: 'per-cell', isip: false, pi: false, stepDown: false, grade: false }, 'only closure labels calibrated');
    assert(c.typeCalibrated === false && c.benchmark.classify.p < 0.5, 'leak-off type not calibrated (benchmark agreement ' + c.benchmark.classify.p + ')');
    assert(c.folds && c.folds.k === 5 && c.folds.pooled === false && c.folds.choice.length === 5, 'out of fold over 5 seed folds');
  },
});
T.push({
  name: 'CA2 reference demo: the consensus label and hit rate follow the table cell; the provisional suffix only where the cell missed',
  wp: WP, opts: false,
  run(_a, assert, ctx) {
    const w = eng(ctx), S = w.PRiSM_dfit_synth;
    if (!real(w.PRiSM_dfit_pipeline) || !S || !real(S.make)) return;
    const sp = S.demoSpec('reference');
    const run = w.PRiSM_dfit_pipeline(S.demo('reference'), S.inputsFor(sp.spec), S.wellFor(sp.spec),
      { isip: null, closure: null, user: {}, aca: { origin: 'centroid', linWin: null, radWin: null, piLevel: null } }, { fast: false, seed: 1 });
    assert(run && run.ok === true, 'pipeline ok');
    const c = run.consensus, cell = w.PRiSM_dfit_cal.hitRate[c.mode] && w.PRiSM_dfit_cal.hitRate[c.mode][c.confidence];
    const r = SH.checkShape('Consensus', c); assert(r.ok, 'Consensus shape: ' + JSON.stringify(r.errors.slice(0, 3)));
    if (cell && cell.met) {
      assert(c.calibrated === true && c.label === c.confidence && c.hitRate && c.hitRate.p === cell.p && c.hitRate.lo === cell.lo && c.hitRate.n === cell.n && c.hitRate.mode === c.mode,
        'calibrated cell: ' + c.mode + ' ' + c.label + ' ' + JSON.stringify(c.hitRate));
    } else assert(c.calibrated === false && c.hitRate === null && /provisional rule label — not yet calibrated/.test(c.label), 'missed cell: ' + c.label);
  },
});
T.push({
  name: 'CA3 the shipped thresholds are applied: a 3.4a medium case with R_vis below rvisLow is low with the table, medium with the placeholder',
  wp: WP, opts: false,
  run(_a, assert, ctx) {
    const w = eng(ctx), S = w.PRiSM_dfit_synth, cal = w.PRiSM_dfit_cal;
    if (!real(w.PRiSM_dfit_pipeline) || !S || !real(S.make)) return;
    const idx = S.cases('benchmark').findIndex((x) => x.id === 'pre-normal-r1-n1-s5-1');
    assert(idx !== -1, 'benchmark case pre-normal-r1-n1-s5-1');
    const spec = S.cases('benchmark')[idx], sd = spec.seed || 1 + idx, m = S.make(spec, sd);   // dfit-validate: the case's own seed (base 1)
    assert(m && m.ok, 'case generated');
    const go = () => w.PRiSM_dfit_pipeline(m.ds, S.inputsFor(spec, m), S.wellFor(spec, m),
      { isip: null, closure: null, user: {}, aca: { origin: 'centroid', linWin: null, radWin: null, piLevel: null } }, { fast: false, seed: sd }).consensus;
    let a, b;
    try { w.PRiSM_dfit_cal = PLACEHOLDER(); a = go(); } finally { w.PRiSM_dfit_cal = cal; }
    b = go();
    const rv = b.chain && b.chain.Rvis;
    assert(a.mode === b.mode && a.value === b.value, 'mode and value unchanged by the table');
    assert(a.confidence === 'medium' && /provisional rule label/.test(a.label), '3.4a rule: medium, provisional (' + a.confidence + ')');
    assert(typeof rv === 'number' && rv >= 0.3 && rv < cal.thresholds.rvisLow, 'R_vis ' + rv + ' between 0.3 and rvisLow ' + cal.thresholds.rvisLow);
    assert.strictEqual(b.confidence, 'low', 'calibrated thresholds: low');
  },
});
T.push({
  name: 'CA4 calibrate(): out-of-fold search on synthetic records tightens R_vis, keeps the 3.4a rule otherwise, and marks a missed cell',
  wp: WP, opts: false,
  run(_a, assert) {
    // 400 single-mode records over 5 seed folds: medium with R_vis ≥ 0.6 right 9 in 10, medium with R_vis < 0.6 always wrong,
    // high always right, low right 1 in 4; 40 range-medium records, right 1 in 2 (misses 0.70)
    const recs = [];
    let seed = 1;
    const rec = (mode, conf, right, Rvis) => recs.push({ id: 'syn-' + seed, seed: seed++, status: 'scored', cons: { mode, conf, tau: 20, w: 5, g: 0, Rvis, bandWidth: 20 },
      score: { closure: { mode, right, intervalScore: mode === 'range' ? 100 : null }, labels: { closure: conf }, classify: { right: false }, isip: { right: true }, pi: { right: false, err: 1 } } });
    for (let i = 0; i < 200; i++) rec('single', 'medium', i % 10 !== 0, 0.8);
    for (let i = 0; i < 100; i++) rec('single', 'medium', false, 0.45);
    for (let i = 0; i < 60; i++) rec('single', 'high', true, 0.95);
    for (let i = 0; i < 40; i++) rec('single', 'low', i % 4 === 0, 0.9);
    for (let i = 0; i < 40; i++) rec('range', 'medium', i % 2 === 0, 0.9);
    const t = V.calibrate(recs, 5);
    assert(t.thresholds.rvisLow >= 0.5 && t.thresholds.rvisLow <= 0.8 && t.thresholds.wLow <= 2.5, 'R_vis tightened: ' + JSON.stringify(t.thresholds));
    assert(t.hitRate.single.medium.met === true && t.hitRate.single.medium.n === 200 && Math.abs(t.hitRate.single.medium.p - 0.9) < 1e-9, 'single medium out of fold: ' + JSON.stringify(t.hitRate.single.medium));
    assert(t.hitRate.single.low.n === 140 && t.hitRate.single.low.met === true && t.hitRate.single.low.target === null, 'low cell measured, no target');
    assert(t.hitRate.range.medium.met === false, 'range medium below 0.70: missed');
    assert(t.folds.choice.every((f) => f.searched && f.rvisLow >= 0.5), 'every fold searched: ' + JSON.stringify(t.folds.choice));
    // the 3.4a rule alone already meets the targets → the least tightening (no change) is chosen
    const easy = recs.filter((r) => !(r.cons.conf === 'medium' && r.cons.Rvis < 0.6) && r.score.closure.mode === 'single');
    const t2 = V.calibrate(easy, 5);
    assert.deepStrictEqual(t2.thresholds, { wLow: 2.5, gLow: 2.5, rvisLow: 0.3 }, 'no tightening when the 3.4a rule meets the targets');
  },
});

module.exports = T;
