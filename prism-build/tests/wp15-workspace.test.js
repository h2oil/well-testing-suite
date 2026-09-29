// WP15 — model & fit workspace (51-prism-workspace.js): fit library, compare
// table + plot overlays, named analysis branches with undo, model browser.
//
// Independent expectations:
//   • Overlay curve of a saved homogeneous fit (k 45 md, S 2.5, C 8.48e-4 bbl/psi
//     on the demo drawdown well) at late time equals the radial-flow semilog
//     line Δp = m·[log10(k·t/(φ μ ct rw²)) − 3.2275 + 0.8686·S],
//     m = 162.6·q·B·μ/(k·h) (Earlougher 1977, SPE Monograph 5, eq. 3.5).
//   • ΔAIC = AIC − min(AIC) over the compared fits: −95.5 − (−100) = 4.5.
'use strict';

const HOMOG = { k: 45, C: 8.48e-4, S: 2.5 };

function setFit(app, over) {
  const W = app.win;
  const f = Object.assign({
    modelKey: 'homogeneous', kind: 'pressure', mode: 'physical', source: 'regression',
    phys: { k: HOMOG.k, kh: HOMOG.k * 35, C: HOMOG.C, S: HOMOG.S, rinv: 1548 }, params: { Cd: 80, S: HOMOG.S },
    r2: 0.995, rmse: 1.2, aic: -100, converged: true, ci95: { k: [44.1, 45.9], S: [2.4, 2.6], C: [8.3e-4, 8.7e-4] }
  }, over || {});
  W.PRiSM_state.model = f.modelKey;
  return W.PRiSM_setLastFit(app.toWin(f));
}

module.exports = [
  {
    name: 'fit library: save a named fit from PRiSM_getLastFit, listed per dataset, persisted across a reload and in project files',
    wp: 'WP15',
    run(app, assert) {
      const W = app.win;
      app.seedSample();
      const hash = W.PRiSM_datasetHash();
      assert.ok(!W.PRiSM_saveFit('x').ok || W.PRiSM_getLastFit(), 'refuses without a fit');
      setFit(app);
      const rec = W.PRiSM_saveFit('Base case');
      assert.ok(rec.ok, rec.reason);
      assert.equal(rec.name, 'Base case');
      assert.equal(rec.datasetHash, hash);
      assert.equal(rec.modelKey, 'homogeneous');
      assert.near(rec.fit.phys.k, 45, 1e-12);
      assert.ok(rec.well && rec.well.q === 850, 'well inputs stored with the fit');
      assert.equal(W.PRiSM_listFits().length, 1);
      // Another dataset: the library is per dataset.
      W.PRiSM_dataset = app.toWin({ t: [0, 1, 2, 3, 4], p: [4000, 3990, 3985, 3982, 3980], q: [500, 500, 500, 500, 500] });
      assert.equal(W.PRiSM_listFits().length, 0, 'not listed for another dataset');
      assert.equal(W.PRiSM_listFits(app.toWin({ all: true })).length, 1);
      app.seedSample();
      W.PRiSM_setFitCompare(app.toWin([rec.id]));
      // Reload: C8 wts_prism_state.
      const app2 = app.reload();
      const W2 = app2.win;
      const all = W2.PRiSM_listFits(app2.toWin({ all: true }));
      assert.equal(all.length, 1, 'restored after reload');
      assert.equal(all[0].name, 'Base case');
      assert.deepEqual(Array.from(W2.PRiSM_getFitCompare()), [rec.id]);
      // Project file ('prism' module carries st.fits and the workspace).
      assert.ok(W.PRiSM_createBranch('Alt').ok);
      const payload = JSON.parse(JSON.stringify(W.WTS_project._buildPayload()));
      assert.ok(payload.modules.prism.fits && payload.modules.prism.fits.length === 1, 'fits in the project file');
      assert.ok(payload.modules.prism.branches && payload.modules.prism.branches.list.length === 2, 'branches in the project file');
      assert.deepEqual(payload.modules.prism.fitWorkspace.compare, [rec.id], 'compare selection in the project file');
      W.PRiSM_state.fits = [];
      W.PRiSM_state.branches = null;
      const res = W.WTS_project.loadFromObject(payload);
      assert.ok(!res.error, res.error);
      assert.equal(W.PRiSM_listFits(app.toWin({ all: true })).length, 1, 'fits back from the project file');
      assert.equal(W.PRiSM_listBranches().length, 2, 'branches back from the project file');
      assert.ok(W.PRiSM_renameFit(rec.id, 'Renamed'));
      assert.equal(W.PRiSM_getFit(rec.id).name, 'Renamed');
      assert.ok(W.PRiSM_removeFit(rec.id));
      assert.equal(W.PRiSM_listFits().length, 0);
    },
  },
  {
    name: 'compare table: k, kh, S, C with 95 % CIs, boundary distances, R², AIC and ΔAIC',
    wp: 'WP15',
    run(app, assert) {
      const W = app.win;
      app.seedSample();
      setFit(app);
      const a = W.PRiSM_saveFit('Homogeneous');
      setFit(app, { modelKey: 'linearBoundary', aic: -95.5, r2: 0.991,
        phys: { k: 44, kh: 1540, C: 8.5e-4, S: 2.3, distances_ft: { dF: 350 } }, params: { Cd: 80, S: 2.3, dF: 988.7 },
        ci95: { k: [43, 45], S: [2.1, 2.5] } });
      const b = W.PRiSM_saveFit('With fault');
      W.PRiSM_setFitCompare(app.toWin([a.id, b.id]));
      const t = W.PRiSM_fitCompareTable();
      assert.ok(t.ok);
      assert.equal(t.rows.length, 2);
      const [ra, rb] = t.rows;
      assert.equal(ra.name, 'Homogeneous');
      assert.near(ra.k, 45, 1e-12); assert.deepEqual(Array.from(ra.kCI), [44.1, 45.9]);
      assert.near(ra.kh, 1575, 1e-9); assert.near(ra.S, 2.5, 1e-12); assert.deepEqual(Array.from(ra.SCI), [2.4, 2.6]);
      assert.near(ra.C, 8.48e-4, 1e-15); assert.near(ra.r2, 0.995, 1e-12);
      assert.near(ra.dAIC, 0, 1e-12);
      assert.near(rb.dAIC, 4.5, 1e-12, 'ΔAIC = −95.5 − (−100)');
      assert.equal(rb.boundaries.length, 1);
      assert.equal(rb.boundaries[0].key, 'dF'); assert.near(rb.boundaries[0].ft, 350, 1e-12);
      assert.equal(rb.modelName, W.PRiSM_modelDisplayName('linearBoundary'));
      // Report: saved fits in the model comparison (own names) + comparison section.
      const m = W.PRiSM_reportData();
      assert.ok(m.comparison.some((r) => /^With fault — /.test(r.label)), 'saved fit named in the model comparison');
      assert.ok(m.comparison.some((r) => /^Homogeneous — /.test(r.label)), 'both saved fits listed');
      const sec = m.extra.find((s) => s.id === 'fitCompare');
      assert.ok(sec && sec.table.rows.length === 2, 'saved-fit comparison section');
      assert.includes(sec.table.rows[1].join(' '), 'dF 350');
    },
  },
  {
    name: 'overlay: a saved fit\'s curve equals the radial-flow semilog line at late time and is drawn on the log-log plot',
    wp: 'WP15',
    run(app, assert) {
      const W = app.win;
      app.openPRiSM();
      app.seedSample();
      setFit(app);
      const rec = W.PRiSM_saveFit('Base');
      W.PRiSM_setFitCompare(app.toWin([rec.id]));
      const c = W.PRiSM_fitOverlayCurve(rec.id);
      assert.ok(c && c.t.length > 50, 'curve evaluated');
      const w = rec.well;
      const m = 162.6 * w.q * w.B * w.mu / (HOMOG.k * w.h);
      const grp = w.phi * w.mu * w.ct * w.rw * w.rw;
      let checked = 0;
      c.t.forEach((t, i) => {
        if (t < 20 || t > 150) return;
        const dpLine = m * (Math.log10(HOMOG.k * t / grp) - 3.2275 + 0.8686 * HOMOG.S);
        assert.rel(c.dp[i], dpLine, 3e-3, 'Δp at ' + t.toFixed(1) + ' h');
        assert.rel(c.deriv[i], m / Math.LN10, 3e-3, 'derivative plateau m/ln10');
        checked++;
      });
      assert.ok(checked >= 3, 'late-time points checked: ' + checked);
      // Drawn by the post-draw hook on the active log-log plot.
      W.PRiSM_state.activePlot = 'bourdet';
      app.renderTab(2);
      app.flush(50);
      assert.ok(W.PRiSM_drawActivePlot(), 'plot drawn');
      const log = app.canvasLog('prism_plot_canvas');
      const i0 = log.findIndex((e) => e.op === 'set' && e.prop === 'strokeStyle' && e.value === W.PRiSM_FIT_COLORS[0]);
      assert.ok(i0 >= 0, 'overlay colour used');
      assert.ok(log.slice(i0).filter((e) => e.op === 'lineTo').length > 40, 'overlay polyline drawn');
      assert.ok(app.canvasTexts('prism_plot_canvas').indexOf('Base') !== -1, 'legend names the fit');
      // Overlay off → not drawn.
      // canvasLog is the canvas's live, cumulative record: look at what the next draws add.
      const nCol = (lg) => lg.filter((e) => e.op === 'set' && e.prop === 'strokeStyle' && e.value === W.PRiSM_FIT_COLORS[0]).length;
      const len1 = log.length;
      W.PRiSM_setFitOverlay(false);
      W.PRiSM_drawActivePlot();
      const added = app.canvasLog('prism_plot_canvas').slice(len1);
      assert.ok(added.length > 100, 'the plot was redrawn');
      assert.equal(nCol(added), 0, 'no overlay when switched off');
      assert.equal(app.consoleErrors().length, 0, app.consoleErrors().join(' | '));
    },
  },
  {
    name: 'adopt a saved fit: model, params and phys adopted before PRiSM_setLastFit (C4 order)',
    wp: 'WP15',
    run(app, assert) {
      const W = app.win;
      app.seedSample();
      setFit(app, { modelKey: 'linearBoundary', phys: { k: 44, C: 8.5e-4, S: 2.3, distances_ft: { dF: 350 } }, params: { Cd: 80, S: 2.3, dF: 988.7 } });
      const rec = W.PRiSM_saveFit('Fault');
      setFit(app);   // current fit is now homogeneous
      let seen = null;
      W.addEventListener('prism:fit-updated', () => { if (!seen) seen = { model: W.PRiSM_state.model, dF: W.PRiSM_state.params && W.PRiSM_state.params.dF }; });
      const r = W.PRiSM_adoptFit(rec.id);
      assert.ok(r.ok, r.reason);
      assert.equal(W.PRiSM_state.model, 'linearBoundary');
      assert.near(W.PRiSM_state.params.dF, 988.7, 1e-12);
      assert.ok(seen && seen.model === 'linearBoundary' && seen.dF === 988.7, 'listeners see the adopted params');
      const lf = W.PRiSM_getLastFit();
      assert.equal(lf.modelKey, 'linearBoundary');
      assert.near(lf.phys.k, 44, 1e-12);
    },
  },
  {
    name: 'branches: duplicate the analysis under a name, switch both ways, undo returns to the state before a switch',
    wp: 'WP15',
    run(app, assert) {
      const W = app.win;
      app.seedSample();
      setFit(app);
      W.PRiSM_state.params = app.toWin({ Cd: 80, S: 2.5 });
      W.PRiSM_workflow._resetHistory();
      const nb = W.PRiSM_createBranch('With fault');
      assert.ok(nb.ok, nb.reason);
      let list = W.PRiSM_listBranches();
      assert.equal(list.length, 2);
      assert.equal(list[0].name, 'Main');
      assert.ok(list[1].active && list[1].name === 'With fault');
      const mainId = list[0].id;
      // Change the analysis on the new branch.
      W.PRiSM_setModel('linearBoundary', app.toWin({ source: 'test' }));
      W.PRiSM_state.params.dF = 500;
      W.PRiSM_setWell(app.toWin({ h: 40 }), { source: 'user' });
      W.PRiSM_recordSnapshot('test');
      const sw = W.PRiSM_switchBranch(mainId);
      assert.ok(sw.ok, sw.reason);
      assert.equal(W.PRiSM_state.model, 'homogeneous');
      assert.near(W.PRiSM_state.params.S, 2.5, 1e-12);
      assert.near(W.PRiSM_getWell().h, 35, 1e-12, 'well inputs of the branch');
      assert.equal(W.PRiSM_getLastFit().modelKey, 'homogeneous');
      assert.equal(W.PRiSM_activeBranch().name, 'Main');
      const back = W.PRiSM_switchBranch(nb.id);
      assert.ok(back.ok);
      assert.equal(W.PRiSM_state.model, 'linearBoundary');
      assert.near(W.PRiSM_state.params.dF, 500, 1e-12);
      assert.near(W.PRiSM_getWell().h, 40, 1e-12);
      // Undo (workflow stack): back to the state before the last switch.
      assert.ok(W.PRiSM_canUndo(), 'switch is undoable');
      W.PRiSM_undo();
      assert.equal(W.PRiSM_state.model, 'homogeneous');
      assert.near(W.PRiSM_getWell().h, 35, 1e-12);
      assert.equal(W.PRiSM_activeBranch().name, 'Main', 'active marker follows the undo');
      // Rename / delete rules.
      assert.ok(W.PRiSM_renameBranch(nb.id, 'Fault case'));
      assert.ok(!W.PRiSM_deleteBranch(mainId).ok, 'active branch cannot be deleted');
      assert.ok(W.PRiSM_deleteBranch(nb.id).ok);
      assert.equal(W.PRiSM_listBranches().length, 1);
      // Branches persist with the analysis state.
      const snap = W.PRiSM_saveState();
      assert.ok(snap.branches && snap.branches.list.length === 1);
    },
  },
  {
    name: 'model browser: plain-language name, description and derivative signature for every model; ranked search; Tab 3 search uses the terms',
    wp: 'WP15',
    run(app, assert) {
      const W = app.win;
      Object.keys(W.PRiSM_MODELS).forEach((k) => {
        const i = W.PRiSM_modelPlainInfo(k);
        assert.ok(i && i.name && i.plain && i.signature, 'plain info for ' + k);
      });
      assert.equal(W.PRiSM_searchModels('fault')[0].key, 'linearBoundary');
      assert.equal(W.PRiSM_searchModels('valley')[0].key, 'doublePorosity');
      assert.equal(W.PRiSM_searchModels('closed compartment')[0].key, 'closedRectangle');
      const hs = W.PRiSM_searchModels('half slope').map((x) => x.key);
      ['infiniteFrac', 'parallelChannel', 'horizontal'].forEach((k) => assert.ok(hs.indexOf(k) !== -1, k + ' in "half slope"'));
      assert.ok(W.PRiSM_searchModels('decline', app.toWin({ mode: 'transient' })).every((x) => x.kind !== 'rate'));
      assert.equal(W.PRiSM_searchModels('zzzz').length, 0);
      // Tab 3 library: a plain-language word finds the model.
      app.openPRiSM();
      app.renderTab(3);
      app.input('prism_model_search', 'valley');
      const card = (k) => app.find('.prism-model-card[data-prism-model="' + k + '"]');
      assert.ok(card('doublePorosity') && card('doublePorosity').style.display !== 'none', 'dual porosity shown for "valley"');
      assert.equal(card('homogeneous').style.display, 'none');
      assert.includes(card('doublePorosity').innerHTML, 'Looks like:');
      // Model browser panel.
      const host = app.document.createElement('div');
      W.PRiSM_renderModelBrowserPanel(host);
      assert.ok(host.innerHTML.indexOf('prism_mb_q') !== -1);
    },
  },
  {
    name: 'fit workspace panel: save, compare, overlay toggle and branch buttons work from the UI',
    wp: 'WP15',
    run(app, assert) {
      const W = app.win;
      app.openPRiSM();
      app.seedSample();
      setFit(app);
      const host = app.document.createElement('div');
      app.document.body.appendChild(host);
      W.PRiSM_renderFitWorkspacePanel(host);
      app.input('prism_ws_name', 'From UI');
      app.click(app.find('#prism_ws_root [data-ws-act="save"]'));
      assert.equal(W.PRiSM_listFits().length, 1);
      assert.equal(W.PRiSM_listFits()[0].name, 'From UI');
      const cb = app.find('#prism_ws_root input[data-ws-act="compare"]');
      assert.ok(cb, 'compare checkbox rendered');
      app.check(cb, true);
      assert.equal(W.PRiSM_getFitCompare().length, 1);
      assert.ok(app.el('prism_ws_cmp_table'), 'comparison table rendered');
      app.input('prism_ws_br_name', 'Alt');
      app.click(app.find('#prism_ws_root [data-ws-act="branch-new"]'));
      assert.equal(W.PRiSM_listBranches().length, 2);
      assert.equal(app.consoleErrors().length, 0, app.consoleErrors().join(' | '));
    },
  },
];
