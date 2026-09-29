// WP0 — integration fixes made while merging the gap-closure work packages.
'use strict';

module.exports = [
  {
    name: 'a user-loaded dataset releases the demo sample\'s well inputs (no pi 4200 leak)',
    wp: 'WP0', integration: true,
    run(app, assert) {
      const w = app.win;
      app.seedSample();
      assert.equal(w.PRiSM_getWell().pi, 4200, 'sample pi applied on seed');
      const ds = app.toWin({ t: [0.1, 0.2, 0.5, 1, 2, 5, 10], p: [3000, 3050, 3100, 3130, 3150, 3170, 3180],
        q: [0, 0, 0, 0, 0, 0, 0], name: 'Other well' });
      w.PRiSM_commitDataset(ds, { source: 'paste' });
      const g = w.PRiSM_getWell();
      assert.equal(g.pi, null, 'pi no longer trusted');
      assert.equal(g.testType, 'auto');
      assert.ok(g.defaulted.indexOf('h') !== -1, 'sample h is now a default');
      // Re-committing the sample text itself keeps the sample inputs.
      w.PRiSM_seedDefaultSample(null, { force: true });
      assert.equal(w.PRiSM_getWell().pi, 4200);
    },
  },
  {
    name: 'step ② period list is the PTA core\'s list (indices drive getAnalysisData)',
    wp: 'WP0', integration: true,
    run(app, assert) {
      const w = app.win;
      const t = [], p = [], q = [];
      for (let i = 1; i <= 40; i++) { t.push(i * 0.5); p.push(4000 - 5 * i); q.push(i <= 20 ? 500 : 0); }
      w.PRiSM_commitDataset(app.toWin({ t, p, q, name: 'two periods' }), { source: 'paste' });
      const core = w.PRiSM_rateHistory().periods;
      const step2 = w.PRiSM_workflow.getPeriods();
      assert.equal(step2.length, core.length);
      for (let i = 0; i < core.length; i++) assert.near(step2[i].t0, core[i].t0, 1e-9);
      assert.equal(step2[1].type, 'Buildup', 'display label from rates');
    },
  },
  {
    name: 'physical model never regresses categorical parameters (BC, interporosityMode)',
    wp: 'WP0', integration: true,
    run(app, assert) {
      const w = app.win;
      app.seedSample();
      const pm = w.PRiSM_physicalModel('linearBoundary');
      assert.ok(pm.ok);
      assert.ok(pm.keys.indexOf('BC') === -1, 'BC not fitted');
      assert.deepEqual(Array.from(pm.fixedKeys), ['BC']);
      assert.equal(pm.toModelParams({ k: 45, C: 8.5e-4, S: 2.5, dF: 1000 }).params.BC, 'noflow');
      const f = w.PRiSM_fitPhysical('linearBoundary');
      assert.finite(f.r2, 'r2 finite');
    },
  },
  {
    name: 'horizontal (Lh-referenced) physical mode derives L_to_h from Lh',
    wp: 'WP0', integration: true,
    run(app, assert) {
      const w = app.win;
      app.seedSample();
      const pm = w.PRiSM_physicalModel('horizontal');
      assert.ok(pm.ok && pm.mode === 'physical');
      assert.ok(pm.keys.indexOf('L_to_h') === -1, 'L_to_h not a second unknown');
      const mp = pm.toModelParams({ k: 45, C: 8.5e-4, Lh: 500, S_perf: 0, S_global: 0, KvKh: 0.1, zw_to_h: 0.5 }).params;
      assert.near(mp.__Lh_h, 500 / 35, 1e-9);
      assert.near(mp.L_to_h, 1000 / 35, 1e-9);
    },
  },
  {
    name: 'host job report summary row names the model and k / S from lastFit.phys',
    wp: 'WP0', integration: true,
    run(app, assert) {
      const w = app.win;
      app.openPRiSM();
      const fit = w.PRiSM_runRegression({ modelKey: 'homogeneous' });
      assert.ok(fit && fit.converged, 'regression converged');
      w.WTS_exportJobReport();
      const html = app.opened[app.opened.length - 1].html();
      assert.match(html, /homogeneous · k = 45\.0 md, S = 2\.5\d/);
      assert.ok(html.indexOf('PRiSM Well Test Analysis') !== -1);
    },
  },
];
