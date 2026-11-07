// DFIT — WP6 integration tests (docs/DFIT-PLAN.md §9 WP6, §2.12 rule 4: the cross-WP tests live here and land last).
//
// Real engines only: 56 (pre-closure), 57 (pipeline, after-closure, results), 58 (leak-off model), 48-calc-wellbore,
// 49-calc-dfit-triage and 49-calc-dfit-synth (demos, cases, scorer); several tests also need the WPH shell hooks. Every
// test checks what it needs first and prints "skip (…): reason" while a piece is still a WP0 stub, so this file passes
// cleanly on a branch and turns into real assertions after integration.
//
//   I1  reference demo end to end            I9  no pending timers 5 s after opening DFIT mode
//   I2  surface-gauge demo                   I10 DFIT → transient → DFIT keeps the picks
//   I3  PTA hand-off (multiRate q_eq, Δp>0)  I11–I13 integration cases through the pipeline and the scorer
//   I4  RTA k fallback                       I14 mini-model (gas-filled wellbore) through the pre-closure chain
//   I5  Tab-7 report and PDF HTML            I15 PTA radial kh/μ = ACA kh/μ within 2 %
//   I6  reload + project save/open (2 tests) I16 two stacked tests on two demo datasets
//   I7  two wells keep separate DFIT states
//   I8  Quick Report key line in DFIT mode
'use strict';

const WP = 'WP6';
const BANNED = /\b(null|undefined|NaN|Infinity)\b|\[object Object\]/;
const real = (f) => typeof f === 'function' && !f._dfitStub;
function engines(w) {
  const S = w.PRiSM_dfit_synth || {};
  const miss = [];
  if (!real(w.PRiSM_dfit_derivs) || !real(w.PRiSM_dfit_isip) || !real(w.PRiSM_dfit_consensus)) miss.push('56 pre-closure core');
  if (!real(w.PRiSM_dfit_pipeline) || !real(w.PRiSM_dfit_pipelineJob) || !real(w.PRiSM_dfit_aca)) miss.push('57 pipeline / after-closure');
  if (!real(S.demo) || !real(S.make) || !real(S.score)) miss.push('49-calc-dfit-synth demos and scorer');
  if (!real(w.PRiSM_dfit_triage)) miss.push('49-calc-dfit-triage');
  if (!(w.WTS_wellbore && real(w.WTS_wellbore.convert))) miss.push('48-calc-wellbore');
  return miss;
}
const hooks = (w) => typeof w.PRiSM_drawPlot === 'function' && typeof w.PRiSM_undoBatch === 'function' && !!w.PRiSM_modeExt;
function gate(w, needHooks, extra) {
  const miss = engines(w);
  if (needHooks && !hooks(w)) miss.push('WPH shell hooks');
  (extra || []).forEach((x) => { if (!x[0]) miss.push(x[1]); });
  if (miss.length) { console.log('      skip (not integrated yet): needs ' + miss.join(', ')); return false; }
  return true;
}
async function settle(app, p) {
  let done = false, val;
  Promise.resolve(p).then((v) => { done = true; val = v; }, (e) => { done = true; val = e; });
  for (let i = 0; i < 4000 && !done; i++) await app.flushAsync(5);
  if (!done) throw new Error('promise did not settle');
  return val;
}
async function analyseDemo(app, name) {
  const w = app.win;
  const ds = w.PRiSM_dfit_ui.loadDemo(name);
  if (!ds) throw new Error('demo ' + name + ' did not load');
  const run = await settle(app, w.PRiSM_dfit_analyse());
  if (!run || run.ok !== true) throw new Error('analysis of ' + name + ' failed: ' + JSON.stringify(run && (run.code || run.errors)).slice(0, 200));
  return run;
}
const near = (assert, a, b, tol, what) => assert(typeof a === 'number' && Math.abs(a - b) <= tol, what + ': ' + a + ' vs ' + b + ' ± ' + tol);
// one app shared by the tests that change neither the well (C1 user values), the undo stack, the wells nor the timers
// (budget): the DFIT state and storage keys are reset and the mode is set back to transient between them
const SH = require('./_dfit-shapes');
function shared(ctx) {
  const app = SH.sharedApp(ctx, {});
  const P = app.win.PRiSM;
  if (P && typeof P.setMode === 'function' && P.mode && P.mode !== 'transient') { P.setMode('transient'); app.flush(20); }
  SH.resetDfit(app);
  return app;
}

module.exports = [
  {
    name: 'I1 reference demo end to end (ISIP, closure, η_G, xf, R_vis)', wp: WP, integration: true, opts: false,
    async run(_app, assert, ctx) {
      const app = shared(ctx);
      const w = app.win;
      if (!gate(w, false)) return;
      const run = await analyseDemo(app, 'reference');
      const s = w.PRiSM_dfit_results(), c = run.frac.chosen;
      near(assert, s.isip.value, 7600, 5, 'ISIP');
      assert.strictEqual(s.closure.mode, 'single');
      near(assert, s.closure.value, 7000, 25, 'closure');
      near(assert, c.eta.a05, 0.900, 0.005, 'η_G (α = ½)');
      near(assert, c.geometry.byModel.PKN.xf, 131, 3, 'xf (PKN)');
      near(assert, c.Rvis, 0.979, 0.01, 'R_vis');
      assert(w.WTS_state.dfit && w.WTS_state.dfit.ok, 'WTS_state.dfit');
    },
  },
  {
    name: 'I2 surface-gauge demo: conversion band, vacuum masking after 31 h, closure within 30 psi of the bottomhole result', wp: WP, integration: true, opts: false,
    async run(_app, assert, ctx) {
      const app = shared(ctx);
      const w = app.win;
      if (!gate(w, false)) return;
      const ref = await analyseDemo(app, 'reference');
      const pBH = ref.consensus.value;
      w.PRiSM_dfit_test().inputs.channels.primary = 'surface';
      const run = await analyseDemo(app, 'surface-gauge');
      assert.strictEqual(run.prep.src, 'surface-converted', 'surface converted');
      assert(run.prep.band && run.prep.band.p10.length === run.prep.t.length, 'P10–P90 band');
      const ex = (run.triage.windows.excluded || []).filter((x) => /vacuum/i.test(x.why || ''));
      assert(ex.length && ex[0].t0 - run.events.ts >= 30 && ex[0].t0 - run.events.ts <= 33, 'vacuum masked after about 31 h');
      const c = w.PRiSM_dfit_results().closure;
      const pS = c.mode === 'single' ? c.value : (c.lo + c.hi) / 2;
      near(assert, pS, pBH, 30, 'closure surface vs bottomhole');
    },
  },
  {
    name: 'I3 PTA hand-off: multiRate carries q_eq; transient C2 sees Δp > 0 for ≥ 95 % of the falloff points', wp: WP, integration: true,
    async run(app, assert) {
      const w = app.win;
      if (!gate(w, false, [[real(w.PRiSM_dfit_handoff), '57 hand-off']])) return;
      const run = await analyseDemo(app, 'reference');
      const r = w.PRiSM_dfit_applyHandoff('pta', { confirm: false });
      assert(r.ok, 'hand-off: ' + JSON.stringify(r).slice(0, 200));
      const mr = w.PRiSM.multiRate, qEq = run.events.qEq * 1440;
      assert(mr.length >= 2 && Math.abs(mr[0].q - qEq) < 1e-6 * qEq, 'multiRate q_eq (bbl/d)');
      assert.strictEqual(w.PRiSM.mode, 'transient');
      assert.strictEqual(w.PRiSM_getWell().testType, 'falloff');
      const ad = w.PRiSM_getAnalysisData();
      assert(ad && ad.ok, 'C2 analysis data');
      const pos = ad.dp.filter((v) => v > 0).length;
      assert(pos / ad.dp.length >= 0.95, 'Δp > 0 for ' + (100 * pos / ad.dp.length).toFixed(1) + ' %');
    },
  },
  {
    name: 'I4 RTA k fallback: PRiSM_dfit_kConstraint gives the after-closure k', wp: WP, integration: true,
    async run(app, assert) {
      const w = app.win;
      if (!gate(w, true, [[real(w.PRiSM_dfit_kConstraint), '57 kConstraint']])) return;
      app.openPRiSM(); w.PRiSM.setMode('dfit'); app.flush(50);
      await analyseDemo(app, 'conventional-radial');
      const k = w.PRiSM_dfit_kConstraint();
      assert(k && k.k > 0 && /^(aca-radial|aca-match|bounds)$/.test(k.source), 'k constraint: ' + JSON.stringify(k));
      // a rate-transient linear-flow set (q ∝ 1/√t at constant pwf, as dfit-hooks H10) with no input k and no pressure fit:
      // the 35 linear-flow analysis takes the DFIT after-closure k
      const t = [], q = [], p = [];
      for (let i = 1; i <= 60; i++) { t.push(i * 24); q.push(800 / Math.sqrt(i)); p.push(1500); }
      w.PRiSM_dataset = app.toWin({ t, q, p, name: 'rta' });
      w.PRiSM_setWell(app.toWin({ testType: 'drawdown', pi: 5000, B: 1.2, h: 40, mu: 0.8, phi: 0.08, ct: 1.5e-5, rw: 0.3, q: 800 }), app.toWin({ source: 'user' }));
      w.PRiSM_state.lastFit = null;
      if (typeof w.PRiSM_setLastFit === 'function') { try { w.PRiSM_setLastFit(null); } catch (e) { /* optional */ } }
      const lin = w.PRiSM_rtaLinearFlow(w.PRiSM_rtaData(w.PRiSM_dataset), app.toWin({}));
      assert(lin.ok && lin.kSource === 'DFIT after-closure', 'RTA linear flow k source: ' + JSON.stringify([lin.ok, lin.kSource, lin.k, lin.reason, lin.missing, w.PRiSM_rtaData(w.PRiSM_dataset).reason]));
      assert(Math.abs(lin.k / k.k - 1) < 1e-9 && Math.abs(lin.xf - lin.xf_sqrt_k / Math.sqrt(k.k)) < 1e-6 * lin.xf, 'k and xf from the DFIT k');
    },
  },
  {
    name: 'I5 the Tab-7 report and the PDF HTML contain the DFIT sections, plots, grade and key line', wp: WP, integration: true,
    async run(app, assert) {
      const w = app.win;
      if (!gate(w, true, [[real(w.PRiSM_dfit_reportModel), '57 report model']])) return;
      app.openPRiSM(); w.PRiSM.setMode('dfit'); app.flush(50);
      await analyseDemo(app, 'reference');
      app.renderTab(7); app.flush(50);
      const tab = app.el('prism_tab_7').textContent;
      ['DFIT headline', 'Closure board', 'After-closure analysis'].forEach((t) => assert(tab.indexOf(t) !== -1, 'Tab 7: ' + t));
      const html = w.PRiSM_buildReportHTML();
      assert(/DFIT interpretation/.test(html) && /DFIT headline/.test(html), 'PDF HTML: DFIT title and sections');
      assert(/<img[^>]+data:image\/png/.test(html), 'PDF HTML: plots');
      assert(/Grade|grade/.test(html) && html.indexOf(w.PRiSM_reportKeyLine()) !== -1, 'grade and key line');
      assert(!/Semilog|Horner/.test(html), 'no PTA-only sections in DFIT mode');
      const bad = tab.match(BANNED);
      assert(!bad, 'no banned words on Tab 7: ' + (bad ? JSON.stringify(tab.slice(Math.max(0, bad.index - 120), bad.index + 60)) : ''));
    },
  },
  {
    name: 'I6 reload and project save/open restore st.dfit (two tests) and the HF index; a demo dataset reloads with the same hash', wp: WP, integration: true,
    async run(app, assert, ctx) {
      const w = app.win;
      if (!gate(w, true)) return;
      app.openPRiSM(); w.PRiSM.setMode('dfit'); app.flush(50);
      await analyseDemo(app, 'reference');
      w.PRiSM_dfit_addTest({ zone: 'B' });
      await analyseDemo(app, 'tight-linear');
      const d0 = JSON.parse(JSON.stringify(w.PRiSM_dfit_state()));
      app.flush(500);
      const app2 = app.reload();
      app2.hook.nav('prism'); app2.flush(100);
      const d1 = JSON.parse(JSON.stringify(app2.win.PRiSM_dfit_state()));
      assert.strictEqual(d1.tests.length, 2, 'two tests after reload');
      assert.deepStrictEqual(d1.tests.map((t) => t.picks), d0.tests.map((t) => t.picks), 'picks restored');
      assert.deepStrictEqual(d1.tests.map((t) => t.hf), d0.tests.map((t) => t.hf), 'HF index restored');
      const T = app2.win.PRiSM_dfit_test();
      assert(T.dsRef && T.dsRef.hash === app2.win.PRiSM_dfit_ui.dsHash(app2.win.PRiSM_dataset), 'the demo dataset reloads from the Data-tab text with the same hash');
      assert(!T.summary.forOtherDataset, 'not marked for another dataset');
      const saved = await settle(app2, app2.win.WTS_project.save('dfit-test.wtsproj'));
      const app3 = ctx.loadApp({ timers: 'manual' });
      app3.win.WTS_project.loadFromObject(JSON.parse(JSON.stringify(saved.payload)));
      app3.hook.nav('prism'); app3.flush(100);
      assert.strictEqual(app3.win.PRiSM_dfit_state().tests.length, 2, 'project open restores both tests');
      app2.dispose(); app3.dispose();
    },
  },
  {
    name: 'I7 two wells keep separate DFIT states; the comparison rows show both', wp: WP, integration: true,
    async run(app, assert) {
      const w = app.win;
      if (!gate(w, true, [[w.WTS_wells && typeof w.WTS_wells.create === 'function', 'WTS_wells']])) return;
      app.openPRiSM(); w.PRiSM.setMode('dfit'); app.flush(50);
      await analyseDemo(app, 'reference');
      w.PRiSM_dfit_test().inputs.datumTvd = 10000;
      w.PRiSM_dfit_ui.publish();
      const id2 = w.WTS_wells.create('Well 2', { switchTo: true });
      app.flush(100); app.hook.nav('prism'); app.flush(50); w.PRiSM.setMode('dfit');
      await analyseDemo(app, 'tight-linear');
      w.PRiSM_dfit_test().inputs.datumTvd = 9000;
      w.PRiSM_dfit_ui.publish();
      const t = w.WTS_wells.table();
      const row = t.rows.map((r) => r.key).indexOf('dfGrad');
      assert(row !== -1, 'DFIT comparison row');
      assert(t.cells[row].filter((c) => /psi\/ft/.test(c)).length === 2, 'both wells show a closure gradient: ' + JSON.stringify(t.cells[row]));
      void id2;
    },
  },
  {
    name: 'I8 header Quick Report and the 30-quick-report key line in DFIT mode', wp: WP, integration: true, opts: false,
    async run(_app, assert, ctx) {
      const app = shared(ctx);
      const w = app.win;
      if (!gate(w, true, [[typeof w.PRiSM_reportKeyLine === 'function', '36 PRiSM_reportKeyLine']])) return;
      app.openPRiSM(); w.PRiSM.setMode('dfit'); app.flush(50);
      await analyseDemo(app, 'reference');
      const kl = w.PRiSM_reportKeyLine();
      assert(/^DFIT · closure 7,0\d\d psia \(single, (high|medium|low)\)/.test(kl), 'key line: ' + kl);
      const html = w.WTS_quickReport.preview();
      assert(html.indexOf(kl) !== -1, 'Quick Report carries the DFIT key line');
    },
  },
  {
    name: 'I9 no pending timers 5 s after opening DFIT mode', wp: WP, integration: true,
    run(app, assert) {
      const w = app.win;
      if (!gate(w, true)) return;
      app.openPRiSM(); w.PRiSM.setMode('dfit'); app.flush(5000);
      assert.strictEqual(app.pendingTimers(), 0, JSON.stringify(app.timers()).slice(0, 300));
    },
  },
  {
    name: 'I10 DFIT → transient → DFIT keeps the picks', wp: WP, integration: true, opts: false,
    async run(_app, assert, ctx) {
      const app = shared(ctx);
      const w = app.win;
      if (!gate(w, true)) return;
      app.openPRiSM(); w.PRiSM.setMode('dfit'); app.flush(50);
      await analyseDemo(app, 'reference');
      w.PRiSM_dfit_setPick('closure', { mode: 'user', method: 'user', p: 6990, dt: null }, { source: 'user', reason: 'Test pick' });
      const before = JSON.stringify(w.PRiSM_dfit_test().picks);
      w.PRiSM.setMode('transient'); app.flush(50);
      w.PRiSM.setMode('dfit'); app.flush(50);
      assert.strictEqual(JSON.stringify(w.PRiSM_dfit_test().picks), before, 'picks kept');
    },
  },
].concat(['reference', 'contact', 'example-b'].map((id, j) => ({
  name: 'I' + (11 + j) + ' integration case "' + id + '" through PRiSM_dfit_pipeline and PRiSM_dfit_synth.score: closure and mechanism right or partial, p_i inside the bracket',
  wp: WP, integration: true, opts: false,
  run(_app, assert, ctx) {
    const app = shared(ctx);
    const w = app.win;
    if (!gate(w, false, [[w.PRiSM_dfit_synth && real(w.PRiSM_dfit_synth.cases), '49-calc-dfit-synth cases']])) return;
    const S = w.PRiSM_dfit_synth, cases = S.cases('integration');
    assert(Array.isArray(cases) && cases.length === 3, 'three integration cases');
    const cs = cases[j], mk = S.make(cs, cs.seed || 1);
    assert(mk && mk.ok !== false && mk.ds, cs.id + ': case made');
    // the case's own inputs and well (what dfit-validate passes), never the app's C1 well
    const inputs = real(S.inputsFor) ? S.inputsFor(cs, mk) : w.PRiSM_dfit_inputRanges.defaults();
    const well = real(S.wellFor) ? S.wellFor(cs, mk) : w.PRiSM_getWell();
    if (inputs.datumTvd == null) inputs.datumTvd = 10000;
    const run = w.PRiSM_dfit_pipeline(mk.ds, inputs, well, null, { seed: 1 });
    assert(run && run.ok === true, cs.id + ': pipeline ok');
    const sc = S.score(run, mk.truth);
    assert(sc.closure.right || sc.closure.inBand || /partial/.test(String(sc.closure.mode)), cs.id + ': closure ' + JSON.stringify(sc.closure));
    assert(sc.classify.right || sc.classify.partial, cs.id + ': mechanism ' + JSON.stringify(sc.classify));
    const pi = run.aca && run.aca.pi;
    if (pi && pi.lo != null) assert(pi.lo <= mk.truth.pi && mk.truth.pi <= pi.hi, cs.id + ': p_i ' + mk.truth.pi + ' inside [' + pi.lo + ', ' + pi.hi + ']');
  },
}))).concat([
  {
    name: 'I14 a mini-model run with V_w·c_w 0.178 ft³/psi (gas-filled wellbore) analysed by the pre-closure chain recovers the model xf within 3 %; κ_exp from the coarse run', wp: WP, integration: true, opts: false,
    run(_app, assert, ctx) {
      const app = shared(ctx);
      const w = app.win;
      if (!gate(w, false, [[real(w.PRiSM_dfit_lkSimulate) && real(w.PRiSM_dfit_lkDefaults), '58 leak-off model']])) return;
      const cfg = w.PRiSM_dfit_lkDefaults();
      cfg.VwCw = 0.178 / 5.614583;
      const res = w.PRiSM_dfit_lkSimulate(cfg, { grid: 'fit' });
      assert(res && res.ok === true, 'model run');
      const t = res.t.slice(), p = res.pw.slice(), q = res.t.map((x) => { let qq = 0; cfg.schedule.forEach((s) => { if (x >= s.t) qq = s.q; }); return qq * 1440; });
      const ds = { t, p, q, name: 'mini-model', source: 'synthetic', timeUnit: 'h', rateUnit: 'bbl/d', ratePhase: 'water', meta: {} };
      const inputs = w.PRiSM_dfit_inputRanges.defaults();
      inputs.datumTvd = 10000;
      inputs.rock.Ep = cfg.Ep; inputs.rock.hf = cfg.hf; inputs.rock.hp = cfg.hp;
      const run = w.PRiSM_dfit_pipeline(ds, inputs, w.PRiSM_getWell(), null, { seed: 1 });
      assert(run && run.ok === true, 'pipeline');
      const xf = run.frac.chosen.geometry.byModel[cfg.geometry] ? (run.frac.chosen.geometry.byModel[cfg.geometry].xf || run.frac.chosen.geometry.byModel[cfg.geometry].R) : null;
      const xm = res.xf.tc || res.xf.ts;
      assert(xf && Math.abs(xf / xm - 1) <= 0.03, 'xf ' + xf + ' vs model ' + xm);
      assert(run.classification.features && typeof run.classification.features.curvExp === 'number', 'κ_exp from the coarse run');
    },
  },
  {
    name: 'I15 after the PTA hand-off on the conventional-radial demo the transient radial kh/μ equals the ACA kh/μ within 2 %', wp: WP, integration: true,
    async run(app, assert) {
      const w = app.win;
      if (!gate(w, true, [[real(w.PRiSM_dfit_handoff), '57 hand-off']])) return;
      app.openPRiSM(); w.PRiSM.setMode('dfit'); app.flush(50);
      const run = await analyseDemo(app, 'conventional-radial');
      assert(run.aca.kh && run.aca.kh.khmu > 0, 'ACA kh/μ');
      assert(w.PRiSM_dfit_applyHandoff('pta', { confirm: false }).ok, 'hand-off');
      assert.strictEqual(w.PRiSM_getWell().B, 1, 'the hand-off takes B = 1 for the injected liquid volumes');
      const ad = w.PRiSM_getAnalysisData();
      // the plateau is read in the after-closure radial window (the window of the ACA kh/μ; Δt from the shut-in differs from the
      // centroid-origin clock by less than tp, which is negligible at these times): the median Bourdet derivative there
      const win = run.aca.nolte && run.aca.nolte.rad && run.aca.nolte.rad.win;
      assert(win && win[1] > win[0], 'ACA radial window');
      const idx = ad.t.map((t, j) => j).filter((j) => ad.t[j] >= win[0] && ad.t[j] <= win[1] && ad.deriv[j] > 0);
      assert(idx.length >= 5, 'derivative points in the radial window: ' + idx.length);
      const ys = idx.map((j) => ad.deriv[j]).sort((a, b) => a - b), ym = ys[Math.floor(ys.length / 2)];
      const r = w.PRiSM_runAnalysisKey('radialPlateau', [{ x: Math.sqrt(win[0] * win[1]), y: ym }], { plotKey: 'bourdet' });
      assert(r.ok, 'radial plateau');
      const khmu = r.result.values.kh / w.PRiSM_getWell().mu;
      assert(Math.abs(khmu / run.aca.kh.khmu - 1) <= 0.02, 'kh/μ ' + khmu + ' vs ' + run.aca.kh.khmu);
    },
  },
  {
    name: 'I16 two stacked tests on two demo datasets: switching keeps each test\'s picks, the gradient plot shows both', wp: WP, integration: true, opts: false,
    async run(_app, assert, ctx) {
      const app = shared(ctx);
      const w = app.win;
      if (!gate(w, false)) return;
      await analyseDemo(app, 'reference');
      w.PRiSM_dfit_test().inputs.datumTvd = 10000;
      w.PRiSM_dfit_setPick('dfitTangent', { G: 18, dt: 5.08, p: 7000, value: 7000 }, { source: 'user', reason: 'Zone A pick' });
      w.PRiSM_dfit_addTest({ zone: 'B' });
      await analyseDemo(app, 'tight-linear');
      w.PRiSM_dfit_test().inputs.datumTvd = 9000;
      assert(!w.PRiSM_dfit_test().picks.user.dfitTangent, 'the second test has its own picks');
      w.PRiSM_dfit_selectTest('t1');
      assert(w.PRiSM_dfit_test().picks.user.dfitTangent, 'the first test keeps its pick');
      assert.strictEqual(w.PRiSM_dfit_test().dsRef.id, 'reference', 'its demo dataset was reloaded');
      const b = w.PRiSM_dfit_ui.buildPlot('dfitStress');
      assert(b.data && b.data.markers.filter((m) => /closure/.test(m.label || '')).length + b.data.series.filter((s) => /closure range/.test(s.label || '')).length === 2, 'both tests on the gradient plot');
    },
  },
]);
