// DFIT — regression tests for the integration review of 3.4a (docs/DFIT-PLAN.md Appendix D, "Integration review").
//
// One test per reviewed defect, on the real engines (56, 57, 58, 48-calc-wellbore, 49-calc-dfit-synth / -triage) and the WPH shell:
//   RV1  live co-pilot: no closure call before t_c on reservoir-controlled leak-off (int-reference, int-contact, 3 seeds each)
//   RV2  the wave ISIP runs on the reference demo's 50 Hz window and agrees with the falloff family; the shut-in window is stored
//   RV3  ISIP_lp takes the friction at the last pumping rate (reference step-down)
//   RV4  re-pump after closure: the two-cycle demo analyses cycle 2 alone (pn, A_f·c_f, xf within 10 % of the cycle-2 truth)
//   RV5  the k bounds contain the true k on the mini-model reference, matrix, contact and PDL cases
//   RV6  a sharp closure is read at the break: Example A (noise-free and σ 0.05) and the penny case, F1 within 2τ
//   RV7  a vetoed-only consensus never says "never departs"; K10 is read at the vetoed picks
//   RV8  PDL: hump found, class pdl, A_f·c_f within 10 % (pdl demo and q-pdl); ISIP on the earliest line
//   RV9  tp_veq after a step-down is the main-stage value (within 5 % of tp_pump)
//   RV10 the uncertainty closure P10–P90 is at least the consensus family band; constant outputs share nothing
//   RV11 gas aca-exact truth in the gas convention: q-gas-linear ISIP, closure and k scored right
//   RV12 storage without closure is never 'normal'; F2 truth of an lk case from the model's own dP/dG maximum
//   RV13 the family band has a model-form floor (Example B inside its band)
//   RV14 triage: clock alignment passes on the clean demos (incl. the vacuum surface gauge); no tide warning without a tide
//   RV15 project files and wells reopen DFIT mode at the saved step; a transient project leaves no DFIT state behind
//   RV16 undo after a closure override brings the full run back (label and tolerance)
//   RV17 designer range inputs reach the design; shut-in in days with the binding words
//   RV18 DFIT mode: the PTA/RTA tools leave the Tools drawer and the PTA exports leave the Export menu; no C1 defaults banner
//   RV19 data + picks export header: test, datum and app version; setPick refuses a primitive; Analyse on a non-DFIT record says why
//   RV20 honest labels (WP7): every shown closure / ISIP / p_i label and the grade say "provisional — not yet calibrated"; the
//        leak-off type never carries a confidence; a calibrated table drops the closure suffix but not the type's
'use strict';

const WP = 'WP6';
const SH = require('./_dfit-shapes');
const real = (f) => typeof f === 'function' && !f._dfitStub;
async function settle(app, p) {
  let done = false, val;
  Promise.resolve(p).then((v) => { done = true; val = v; }, (e) => { done = true; val = e; });
  for (let i = 0; i < 4000 && !done; i++) await app.flushAsync(5);
  if (!done) throw new Error('promise did not settle');
  return val;
}
function ready(w) { return real(w.PRiSM_dfit_pipeline) && w.PRiSM_dfit_synth && real(w.PRiSM_dfit_synth.make) && real(w.PRiSM_dfit_triage); }
function eng(ctx) { const app = SH.sharedApp(ctx, {}); return app.win; }
// a demo or a quick / integration case through the pipeline
function runCase(w, id, set, patch) {
  const S = w.PRiSM_dfit_synth;
  let ds, truth, inputs, well;
  if (S.DEMOS.indexOf(id) !== -1 && !set) {
    const sp = S.demoSpec(id); ds = S.demo(id); truth = S.demoTruth(id); inputs = S.inputsFor(sp.spec); well = S.wellFor(sp.spec);
  } else {
    const cs = JSON.parse(JSON.stringify(S.cases(set || 'quick').find((c) => c.id === id)));
    if (patch) patch(cs);
    const mk = S.make(cs, cs.seed || 1); ds = mk.ds; truth = mk.truth; inputs = S.inputsFor(cs, mk); well = S.wellFor(cs, mk);
  }
  const run = w.PRiSM_dfit_pipeline(ds, inputs, well, null, { seed: 1 });
  return { run, truth, inputs, ds, S };
}
async function analyseDemo(app, name) {
  const w = app.win;
  w.PRiSM_dfit_ui.loadDemo(name);
  const run = await settle(app, w.PRiSM_dfit_analyse());
  if (!run || run.ok !== true) throw new Error('analysis of ' + name + ' failed');
  return run;
}
function dfitApp(app) { app.openPRiSM(); app.win.PRiSM.setMode('dfit'); app.flush(50); return app.win; }
const rel = (a, b) => Math.abs(a / b - 1);

const T = [];
T.push({
  name: 'RV1 live co-pilot: no closure call before t_c on reservoir-controlled leak-off (int-reference and int-contact, 3 seeds, σ 0.05)', wp: WP, opts: false,
  run(_a, assert, ctx) {
    const w = eng(ctx); if (!ready(w) || !real(w.PRiSM_dfit_replay)) return;
    const S = w.PRiSM_dfit_synth;
    [0, 1].forEach((k) => [1, 2, 3].forEach((seed) => {
      const spec = JSON.parse(JSON.stringify(S.cases('integration')[k])); spec.noise = { sigma: 0.05, rho1: 0, quantum: 0.01 };
      const m = S.make(spec, seed);
      const r = w.PRiSM_dfit_replay(m.ds, { inputs: S.inputsFor(spec, m), well: S.wellFor(spec, m) });
      const tc = m.truth.tStart + m.truth.tcInj, fp = r.firsts.closureProvisional;
      assert(fp == null || fp >= tc, spec.id + ' seed ' + seed + ': provisional ' + fp + ' h before t_c ' + tc.toFixed(3) + ' h');
      if (k === 0 && r.closure && typeof r.closure.p === 'number') assert(Math.abs(r.closure.p - 7000) <= 25, spec.id + ': live closure ' + r.closure.p);
    }));
  },
});
T.push({
  name: 'RV2 the wave ISIP family runs on the reference demo (agrees with the falloff ISIP within 5 psi) and the shut-in window is stored', wp: WP, integration: true,
  async run(app, assert) {
    const w = dfitApp(app); if (!ready(w)) return;
    const run = await analyseDemo(app, 'reference');
    const wh = run.isip.candidates.find((c) => c.method === 'wh'), g = run.isip.candidates.find((c) => c.method === 'g');
    assert(wh && g, 'wave and falloff candidates: ' + run.isip.candidates.map((c) => c.method));
    assert(Math.abs(wh.value - g.value) <= 5, 'wh ' + wh.value + ' vs g ' + g.value);
    const win = run.prep.hf && run.prep.hf.windows[0];
    assert(win && Array.isArray(win.t) && Array.isArray(win.p) && win.t.length === win.p.length && win.p.length > 1000, 'the window carries its samples');
    const T1 = w.PRiSM_dfit_test();
    assert(T1.hf && T1.hf.kinds.indexOf('shutin') !== -1 && T1.hf.bytes > 0, '_storeHf wrote the shut-in window: ' + JSON.stringify(T1.hf));
  },
});
T.push({
  name: 'RV3 ISIP_lp takes the friction at the last pumping rate: within the friction-family tolerance of the step-down intercept', wp: WP, opts: false,
  run(_a, assert, ctx) {
    const w = eng(ctx); if (!ready(w)) return;
    const { run } = runCase(w, 'reference');
    const c = (m) => run.isip.candidates.find((x) => x.method === m);
    assert(c('lp') && c('sd') && c('g'), 'lp, sd and g candidates');
    assert(Math.abs(c('lp').value - c('sd').value) <= 5, 'lp ' + c('lp').value + ' vs sd ' + c('sd').value);
    if (c('lp').upper) assert(c('lp').value >= c('g').value - 5, 'the upper estimate is not below the falloff ISIP');
    assert(Math.abs(run.isip.value - 7600) <= 5, 'ISIP ' + run.isip.value);
  },
});
T.push({
  name: 'RV4 re-pump after closure: the two-cycle demo analyses cycle 2 alone; pn, A_f·c_f and xf within 10 % of the cycle-2 truth; p_i flagged', wp: WP, opts: false,
  run(_a, assert, ctx) {
    const w = eng(ctx); if (!ready(w)) return;
    const { run, truth } = runCase(w, 'two-cycle');
    const cy = run.events.cycles, c2 = truth.cycle2, fr = run.frac.chosen;
    assert(cy.length === 2 && cy[1].closedBefore === true, 'cycle 2 re-pumped after closure: ' + JSON.stringify(cy.map((c) => c.closedBefore)));
    assert(Math.abs(run.events.Vi - c2.V) <= 0.05 * c2.V, 'V_i of cycle 2 alone: ' + run.events.Vi);
    assert(rel(fr.pn, c2.pn) <= 0.10, 'pn ' + fr.pn + ' vs ' + c2.pn);
    assert(rel(fr.AfCf, c2.AfCf) <= 0.10, 'A_f·c_f ' + fr.AfCf + ' vs ' + c2.AfCf);
    assert(rel(fr.geometry.byModel.PKN.xf, c2.xf) <= 0.10, 'xf ' + fr.geometry.byModel.PKN.xf + ' vs ' + c2.xf);
    assert(run.aca && run.aca.pi && run.aca.pi.label === 'low', 'p_i from the last cycle alone is labelled low');
  },
});
T.push({
  name: 'RV5 the after-closure k bounds contain the true k on the mini-model reference, matrix, contact and PDL cases', wp: WP, opts: false,
  run(_a, assert, ctx) {
    const w = eng(ctx); if (!ready(w)) return;
    ['q-reference', 'q-matrix', 'q-contact', 'q-pdl'].forEach((id) => {
      const { run, truth } = runCase(w, id, 'quick');
      const b = run.aca && run.aca.bounds;
      assert(b, id + ': bounds');
      assert(b.kLo <= truth.k && truth.k <= b.kHi, id + ': k ' + truth.k + ' outside [' + b.kLo + ', ' + b.kHi + '] (' + JSON.stringify(b.binding) + ')');
    });
  },
});
T.push({
  name: 'RV6 a sharp closure is read at the break: Example A (noise-free and σ 0.05) and the penny case give F1 within 2τ of the truth', wp: WP, opts: false,
  run(_a, assert, ctx) {
    const w = eng(ctx); if (!ready(w)) return;
    [['q-example-a', null], ['q-example-a', (c) => { c.noise = { sigma: 0.05, rho1: 0, quantum: 0.01 }; }], ['q-penny', null]].forEach(([id, patch]) => {
      const { run, truth } = runCase(w, id, 'quick', patch);
      const c = run.consensus, F1 = c.families.F1;
      assert(F1 && Math.abs(F1.p50 - truth.sigmaC) <= 2 * c.tau, id + (patch ? ' σ 0.05' : '') + ': F1 ' + (F1 && F1.p50) + ' vs ' + truth.sigmaC + ' (2τ ' + 2 * c.tau + ')');
    });
  },
});
T.push({
  name: 'RV7 when the bounds veto every closure candidate the consensus says so (K1 lists them, K10 fired), never "dP/dG never departs"', wp: WP, opts: false,
  run(_a, assert, ctx) {
    const w = eng(ctx); if (!ready(w)) return;
    // Example A at a 10,000 ft datum: σ_c 5,105 psia lies below the conservative frictional limit there (the case states 8,000 ft)
    const S = w.PRiSM_dfit_synth, cs = JSON.parse(JSON.stringify(S.cases('quick').find((c) => c.id === 'q-example-a'))), mk = S.make(cs, 1);
    const inputs = S.inputsFor(cs, mk); inputs.datumTvd = 10000; inputs.strings[0].botMd = 10000;
    const run = w.PRiSM_dfit_pipeline(mk.ds, inputs, S.wellFor(cs, mk), null, { seed: 1 });
    const c = run.consensus, K = (id) => c.rules.find((r) => r.id === id);
    assert(c.mode === 'none' && c.vetoed.length > 0, 'vetoed-only: mode none with the vetoed picks listed');
    assert(/vetoed/.test(K('K1').text) && !/never departs/.test(K('K1').text), 'K1: ' + K('K1').text);
    assert(K('K10').fired === true && /below a frictional-limit line/.test(K('K10').text), 'K10: ' + K('K10').text);
    // and with the case's own datum the closure is admissible and estimable
    const ok = runCase(w, 'q-example-a', 'quick').run;
    assert(ok.consensus.mode !== 'none', 'Example A at 8,000 ft: closure estimable (' + ok.consensus.mode + ')');
  },
});
T.push({
  name: 'RV8 PDL: the hump is found against the post-hump line, class pdl, A_f·c_f within 10 % (pdl demo and q-pdl); the demo ISIP stays on the earliest line', wp: WP, opts: false,
  run(_a, assert, ctx) {
    const w = eng(ctx); if (!ready(w)) return;
    [['pdl', null], ['q-pdl', 'quick']].forEach(([id, set]) => {
      const { run, truth } = runCase(w, id, set);
      const cl = run.classification;
      assert(cl.type === 'pdl' && cl.features.H > 0.05, id + ': class ' + cl.type + ', H ' + cl.features.H);
      assert(Array.isArray(run.derivs.humpWin), id + ': hump window reported');
      assert(rel(run.frac.chosen.AfCf, truth.AfCf) <= 0.10, id + ': A_f·c_f ' + run.frac.chosen.AfCf + ' vs ' + truth.AfCf);
      assert(Math.abs(run.consensus.value - truth.sigmaC) <= 25, id + ': closure ' + run.consensus.value);
      if (id === 'pdl') assert(Math.abs(run.isip.value - truth.isip) <= 5, 'pdl demo ISIP ' + run.isip.value);
    });
  },
});
T.push({
  name: 'RV9 tp_veq after a step-down uses the main-stage rate: within 5 % of tp_pump on the reference demo', wp: WP, opts: false,
  run(_a, assert, ctx) {
    const w = eng(ctx); if (!ready(w)) return;
    const { run } = runCase(w, 'reference');
    const tp = run.events.tp;
    assert(run.events.steps.some((s) => s.dir === 'down'), 'a step-down');
    assert(rel(tp.veq, tp.pump) <= 0.05, 'tp_veq ' + tp.veq + ' vs tp_pump ' + tp.pump);
  },
});
T.push({
  name: 'RV10 the uncertainty closure P10–P90 is at least the consensus F1 band; a constant output shares no variance', wp: WP, opts: false,
  run(_a, assert, ctx) {
    const w = eng(ctx); if (!ready(w)) return;
    const { run } = runCase(w, 'reference');
    const u = run.unc.outputs.closure, F1 = run.consensus.families.F1;
    assert(u.p90 - u.p10 >= 0.9 * (F1.p90 - F1.p10), 'closure P10–P90 ' + (u.p90 - u.p10).toFixed(2) + ' vs F1 band ' + (F1.p90 - F1.p10).toFixed(2));
    const sh = u.shares.find((x) => x.input === 'closure'), others = u.shares.filter((x) => x.input !== 'closure');
    assert(sh.s > 0.5 && others.every((x) => x.s < 0.2), 'shares: ' + JSON.stringify(u.shares));
  },
});
T.push({
  name: 'RV11 gas aca-exact truth in the gas convention: q-gas-linear ISIP, closure and k are scored right', wp: WP, opts: false,
  run(_a, assert, ctx) {
    const w = eng(ctx); if (!ready(w)) return;
    const { run, truth, S } = runCase(w, 'q-gas-linear', 'quick');
    const sc = S.score(run, truth);
    assert(truth.sigmaC < 7528 && truth.isip < 8128, 'mapped truth pressures: ' + truth.sigmaC + ' / ' + truth.isip);
    assert(sc.isip.right && sc.closure.right && sc.k.right, 'scores: ' + JSON.stringify({ isip: sc.isip, closure: sc.closure, k: sc.k }));
  },
});
T.push({
  name: 'RV12 storage without closure is not reported normal; an lk case\'s F2 truth comes from the model\'s own dP/dG maximum', wp: WP, opts: false,
  run(_a, assert, ctx) {
    const w = eng(ctx); if (!ready(w)) return;
    const st = runCase(w, 'q-storage-gas', 'quick').run;
    assert(st.consensus.mode === 'none' && st.classification.type !== 'normal', 'q-storage-gas: ' + st.classification.type);
    const { run, truth, S } = runCase(w, 'q-contact', 'quick');
    assert(truth.sigmaCF2 < truth.sigmaC - 100, 'F2 truth below σ_c: ' + truth.sigmaCF2);
    const sc = S.score(run, truth);
    assert(Math.abs(sc.frac.sigmaCF2) <= 100, 'F2 error ' + sc.frac.sigmaCF2 + ' psi (the quasi-static truth gave 436)');
  },
});
T.push({
  name: 'RV13 the voting family band has a model-form floor: Example B (noise-free) lies inside its band', wp: WP, opts: false,
  run(_a, assert, ctx) {
    const w = eng(ctx); if (!ready(w)) return;
    const { run, truth, S } = runCase(w, 'q-example-b', 'quick');
    const sc = S.score(run, truth), F1 = run.consensus.families.F1;
    assert(sc.closure.inBand === true, 'Example B in band: err ' + sc.closure.err + ', F1 ' + JSON.stringify(F1));
    assert(F1.sigma >= Math.max(1, 0.0005 * F1.p50) - 1e-9, 'σ floor: ' + F1.sigma);
  },
});
T.push({
  name: 'RV14 triage: clock alignment passes on the clean demos (reference, tight-linear, two-cycle, vacuum surface gauge); the reference has no tide warning', wp: WP, opts: false,
  run(_a, assert, ctx) {
    const w = eng(ctx); if (!ready(w)) return;
    ['reference', 'tight-linear', 'two-cycle', 'surface-gauge'].forEach((id) => {
      const { run } = runCase(w, id);
      const ck = run.triage.checks.find((c) => c.id === 'clock');
      assert(ck.level === 'pass', id + ': clock ' + ck.level + ' — ' + ck.text);
      if (id === 'reference') {
        const td = run.triage.checks.find((c) => c.id === 'tides');
        assert(td.level === 'pass' || td.level === 'na', 'reference tides ' + td.level + ' — ' + td.text);
        assert(run.grade && run.grade.grade !== 'C', 'reference grade ' + JSON.stringify(run.grade));
      }
    });
  },
});
T.push({
  name: 'RV15 a project saved in DFIT mode at step ④ reopens in DFIT mode at step ④; a DFIT well too; a transient project opened from DFIT mode leaves no DFIT state', wp: WP, integration: true, opts: { timers: 'manual' },
  async run(app, assert, ctx) {
    const w = dfitApp(app); if (!ready(w) || !w.WTS_project) return;
    await analyseDemo(app, 'reference');
    w.PRiSM.gotoStep(4); app.flush(20);
    const pay = JSON.parse(JSON.stringify(w.WTS_project._buildPayload()));
    const app3 = ctx.loadApp({ timers: 'manual' });
    try {
      app3.openPRiSM(); app3.flush(20);
      assert.strictEqual(app3.win.PRiSM.mode, 'transient', 'fresh app in transient');
      app3.win.WTS_project.loadFromObject(pay); app3.flush(100);
      assert.strictEqual(app3.win.PRiSM.mode, 'dfit', 'project reopens in DFIT mode');
      assert.strictEqual(app3.win.PRiSM.step, 4, 'at the saved step');
      // a transient-only project opened from a DFIT session
      const app4 = ctx.loadApp({ timers: 'manual' });
      app4.openPRiSM(); app4.flush(20);
      const tp = JSON.parse(JSON.stringify(app4.win.WTS_project._buildPayload()));
      app4.dispose();
      app3.win.WTS_project.loadFromObject(tp); app3.flush(100);
      assert.strictEqual(app3.win.PRiSM.mode, 'transient', 'transient project: transient mode');
      assert(!app3.win.PRiSM_state.dfit, 'no stale st.dfit');
      assert(!(app3.win.WTS_state && app3.win.WTS_state.dfit), 'no stale WTS_state.dfit');
    } finally { app3.dispose(); }
    // wells: a DFIT well reopens in DFIT mode
    if (w.WTS_wells && typeof w.WTS_wells.create === 'function') {
      const id1 = w.WTS_wells.list().find((x) => x.active).id;
      w.WTS_wells.create('Well 2', { switchTo: true }); app.flush(100);
      assert.strictEqual(w.PRiSM.mode, 'transient', 'the new well starts in transient');
      w.WTS_wells.switchTo(id1); app.flush(100);
      assert.strictEqual(w.PRiSM.mode, 'dfit', 'back on the DFIT well: DFIT mode');
    }
  },
});
T.push({
  name: 'RV16 undo after a closure override brings the full run back (label and tolerance); redo marks the fast run stale', wp: WP, integration: true, opts: { timers: 'manual' },
  async run(app, assert) {
    const w = dfitApp(app); if (!ready(w)) return;
    await analyseDemo(app, 'reference'); app.flush(50);
    const T0 = w.PRiSM_dfit_test(), lab0 = T0.summary.closure.label;
    assert(/high/.test(lab0), 'reference label ' + lab0);
    assert(w.PRiSM_dfit_setPick('closure', { p: 6950 }, { reason: 'test override' }).ok, 'override');
    app.flush(50);
    assert(w.PRiSM_undo(), 'undo'); app.flush(50);
    const T1 = w.PRiSM_dfit_test();
    assert(T1.picks.closure == null && T1.summary.closure.label === lab0 && T1.summary.stale === false, 'undo restores the full run: ' + T1.summary.closure.label + ', stale ' + T1.summary.stale);
    assert(w.PRiSM_redo(), 'redo'); app.flush(50);
    assert(w.PRiSM_dfit_test().summary.stale === true, 'redo: the fast run is marked stale');
  },
});
T.push({
  name: 'RV17 the designer takes its ranges from id\'d inputs; the shut-in is shown in days with the binding words and flagged above the allowed time', wp: WP, integration: true, opts: { timers: 'manual' },
  run(app, assert) {
    const w = dfitApp(app); if (!ready(w) || !real(w.PRiSM_dfit_design)) return;
    const host = w.document.createElement('div'); w.document.body.appendChild(host);
    w.PRiSM_renderDfitDesignerTool(host);
    ['k10', 'k90', 'phi10', 'ct10', 'h10', 'hf10', 'ep', 'sg', 'gs', 'V', 'q', 'shut', 'W'].forEach((k) => assert(w.document.getElementById('prism_dfit_dr_' + k), 'input ' + k));
    w.document.getElementById('prism_dfit_dr_k10').value = '0.002';
    w.document.getElementById('prism_dfit_dr_shut').value = '0.5';
    w.document.getElementById('prism_dfit_design_n').value = '100';
    w.document.getElementById('prism_dfit_design_go').click(); app.flush(20);
    const pl = w.PRiSM_dfit_state().plan;
    assert(pl && pl.ranges.k.p10 === 0.002 && pl.ranges.allowedShutInD === 0.5, 'ranges read from the form: ' + JSON.stringify(pl && pl.ranges.k));
    const out = w.document.getElementById('prism_dfit_design_out').textContent;
    assert(/ d \(/.test(out) && /set by (radial confirmation|three closure times|afterflow|p_i precision)/.test(out), 'days and binding words: ' + out.slice(0, 200));
    assert(/longer than the allowed 0\.5 d/.test(out), 'flagged above the allowed shut-in');
  },
});
T.push({
  name: 'RV18 DFIT mode: no PTA/RTA tools in the drawer, no PTA CSV/XML in Export, no C1 defaults banner; transient unchanged', wp: WP, integration: true, opts: { timers: 'manual' },
  async run(app, assert) {
    app.openPRiSM(); app.flush(20);
    const w = app.win;
    const ids = () => w.PRiSM_listTools().map((t) => t.id);
    const exportLabels = () => { app.click('prism_export_btn'); const l = Array.from(app.el('prism_menu').querySelectorAll('[data-prism-menu]')).map((b) => b.textContent); app.click('prism_export_btn'); return l; };
    const tr = ids(), trE = exportLabels();
    ['rta', 'semilog', 'decline', 'skincheck', 'automatch'].forEach((id) => assert(tr.indexOf(id) !== -1, 'transient lists ' + id));
    assert(trE.indexOf('Results as CSV') !== -1, 'transient export lists the results CSV');
    w.PRiSM.setMode('dfit'); app.flush(50);
    if (!ready(w)) return;
    const df = ids(), dfE = exportLabels();
    ['rta', 'semilog', 'decline', 'skincheck', 'automatch', 'deconv'].forEach((id) => assert(df.indexOf(id) === -1, 'DFIT drawer has no ' + id));
    ['pvt', 'crop', 'project'].forEach((id) => assert(df.indexOf(id) !== -1, 'DFIT drawer keeps ' + id));
    assert(dfE.indexOf('Results as CSV') === -1 && dfE.indexOf('Data and results as XML') === -1, 'no PTA exports: ' + dfE.join(' | '));
    assert(dfE.indexOf('Frac-design sheet (CSV)') !== -1, 'the DFIT sheet export is listed');
    await analyseDemo(app, 'reference');
    w.PRiSM.gotoStep(3); app.flush(50);
    const txt = w.document.getElementById('pgBody').textContent;
    assert(!/Default values in use/.test(txt) && !/Default inputs:/.test(txt), 'no C1 defaults banner in DFIT step ③');
    w.PRiSM.setMode('transient'); app.flush(50);
    assert.deepStrictEqual(ids(), tr, 'transient tool list unchanged after DFIT');
  },
});
T.push({
  name: 'RV19 export header carries the test, datum and version; setPick refuses a primitive; Analyse on a non-DFIT record says what to do', wp: WP, integration: true, opts: { timers: 'manual' },
  async run(app, assert) {
    app.openPRiSM(); app.flush(20);
    const w = app.win;
    w.PRiSM.setMode('dfit'); app.flush(50);
    if (!ready(w)) return;
    // the PTA demo of the transient workspace is still loaded: no injection / shut-in in it
    const r0 = await settle(app, w.PRiSM_dfit_analyse());
    assert(r0 && r0.ok === false, 'no result on a PTA record');
    assert(/No injection and shut-in found/.test(w.document.getElementById('prism_dfit_status').textContent), 'status: ' + w.document.getElementById('prism_dfit_status').textContent);
    await analyseDemo(app, 'reference');
    const bad = w.PRiSM_dfit_setPick('closure', 6950, { reason: 'x' });
    assert(bad.ok === false && bad.code === 'BAD_VALUE', 'primitive refused: ' + JSON.stringify(bad));
    const r = w.PRiSM_dfit_ui.exportText ? w.PRiSM_dfit_ui.exportText() : null;
    const txt = r && r.text ? r.text : null;
    if (txt) {
      assert(/# test: t1/.test(txt), 'test id in the header');
      assert(/# datum TVD ft: 10000/.test(txt), 'datum in the header');
      const v = typeof w.WTS_appVersion === 'function' ? w.WTS_appVersion() : '';
      assert(v && txt.indexOf('# app version: ' + v) !== -1, 'app version ' + v + ' in the header');
    } else {
      const run = w.PRiSM_dfit_test() && w.PRiSM_state._dfitRun;
      const e = w.PRiSM_dfit_exportText(run, 'default', { test: w.PRiSM_dfit_test(), inputs: w.PRiSM_dfit_test().inputs, well: w.PRiSM_getWell() });
      assert(/# test: t1/.test(e.text) && /# datum TVD ft: 10000/.test(e.text), 'header with the test context');
      const v = typeof w.WTS_appVersion === 'function' ? w.WTS_appVersion() : '';
      assert(v && e.text.indexOf('# app version: ' + v) !== -1, 'app version ' + v);
    }
  },
});
T.push({
  name: 'RV20 honest labels: closure, ISIP and p_i labels and the grade are marked provisional (not yet calibrated) in the UI, report, exports and WTS_state; the leak-off type never shows a confidence', wp: WP, integration: true, opts: { timers: 'manual' },
  async run(app, assert) {
    const w = dfitApp(app); if (!ready(w) || !w.PRiSM_dfit_ui) return;
    const U = w.PRiSM_dfit_ui;
    const run = await analyseDemo(app, 'reference');
    assert(w.PRiSM_dfit_cal && w.PRiSM_dfit_cal.calibrated === false, '3.4a ships the uncalibrated placeholder');
    // rail and key line
    const rows = U.railRows(), row = (k) => (rows.find((r) => r[0] === k) || [])[1] || '';
    assert(/\((high|medium|low), provisional/.test(row('Closure')), 'rail closure: ' + row('Closure'));
    assert(/\((high|medium|low), provisional\)/.test(row('p_i')), 'rail p_i: ' + row('p_i'));
    assert(row('Labels') === 'provisional — not yet calibrated', 'rail Labels row: ' + row('Labels'));
    assert(/, provisional\)/.test(U.keyLine()) && /, provisional\)/.test(w.PRiSM_reportKeyLine()), 'key line: ' + U.keyLine());
    // step ③ cards: closure label and the leak-off type
    const h = app.document.createElement('div');
    U.panels['dfit-board'].render(h);
    assert(/provisional — not yet calibrated/.test(h.innerHTML) && !/uncalibrated rule label/.test(h.innerHTML), 'board label is provisional');
    const hk = app.document.createElement('div');
    U.panels['dfit-classify'].render(hk);
    const kt = hk.innerHTML;
    assert(/\(provisional\)/.test(kt) && /not yet calibrated/.test(kt) && /often differs from the true leak-off mechanism/.test(kt), 'leak-off type is provisional with the benchmark caveat');
    assert(!/\b(high|medium) confidence\b/i.test(kt) && /not a probability/.test(kt), 'no confidence word on the type; scores are not probabilities');
    // report model, export text, WTS_state, grade
    const m = w.PRiSM_dfit_reportModel(run, {});
    const kr = (k) => (m.keyRows.find((r) => r[0] === k) || [])[1] || '';
    assert(/provisional — not yet calibrated/.test(kr('Closure')) && /provisional — not yet calibrated/.test(kr('p_i')), 'report key rows: ' + kr('Closure') + ' | ' + kr('p_i'));
    const sT = m.sections.find((s) => s.id === 'dfit-type');
    if (sT) assert(/provisional — the leak-off type is not yet calibrated/.test(sT.blocks[0].rows[0][1]), 'report type row: ' + sT.blocks[0].rows[0][1]);
    const vd = m.sections.find((s) => s.id === 'dfit-headline').blocks.find((b) => b.kind === 'verdict');
    if (run.consensus.mode === 'single') assert(/provisional — not yet calibrated/.test(vd.text) && vd.text.length < 300, 'headline verdict: ' + vd.text);
    const ex = w.PRiSM_dfit_exportText(run, 'default', {});
    assert(/# labels: rule labels, provisional — not yet calibrated/.test(ex.text) && /# leak-off type: \S+ \(provisional/.test(ex.text) && /p_i psia [^\n]*provisional\)/.test(ex.text), 'export text labels');
    const ws = U.publish();
    assert(ws.labelsCalibrated === false && /provisional — not yet calibrated/.test(ws.labelNote), 'WTS_state.dfit labelsCalibrated / labelNote');
    if (/^[AB]$/.test(run.grade.letter)) assert(/labels provisional, not yet calibrated/.test(run.grade.why[0]), 'grade why: ' + run.grade.why[0]);
    // a calibrated table (3.4b) drops the closure suffix, but the type stays provisional until it is calibrated itself
    const cal0 = w.PRiSM_dfit_cal;
    try {
      w.PRiSM_dfit_cal = Object.assign({}, cal0, { calibrated: true });
      assert(!/provisional/.test(U.keyLine()) && !U.railRows().some((r) => r[0] === 'Labels'), 'calibrated: no provisional suffix');
      const m2 = w.PRiSM_dfit_reportModel(run, {}), s2 = m2.sections.find((s) => s.id === 'dfit-type');
      if (s2) assert(/provisional/.test(s2.blocks[0].rows[0][1]), 'the type stays provisional');
    } finally { w.PRiSM_dfit_cal = cal0; }
  },
});
module.exports = T;
