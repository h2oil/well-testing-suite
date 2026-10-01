// WP16 — v3.1 PRiSM review: crop window kept across a reload, XML unit of the
// reservoir temperature, undersaturated-oil PVT, Tools drawer titles.
//
// Independent references:
//   • Vasquez & Beggs (1980): co = A/(1e5·p), A = −1433 + 5Rs + 17.2T − 1180γg + 12.61API;
//     integrated from pb: Bo = Bob·(p/pb)^(−A/1e5).  μo = μob·(p/pb)^m,
//     m = 2.6·p^1.187·exp(−11.513 − 8.98e−5·p).
//   • McCain (1991) water-viscosity pressure factor 0.9994 + 4.0295e−5·p + 3.1062e−9·p².
'use strict';

function twoPeriodText() {
  const rows = ['time,pressure,rate'];
  for (let i = 1; i <= 24; i++) rows.push([i, (4200 - 300 - 20 * Math.log(i)).toFixed(2), 850].join(','));
  for (let i = 1; i <= 48; i++) rows.push([24 + i, (3836 + 250 * (1 - Math.exp(-i / 6))).toFixed(2), 0].join(','));
  return rows.join('\n');
}

function loadText(app, text) {
  app.openPRiSM();
  app.gotoTab(1);
  app.flush(100);
  app.input('prism_data_paste', text);
  app.click('prism_data_parse');
  app.flush(500);
}

module.exports = [
  {
    name: 'crop window survives a reload of the same record; Reset forgets it; another record is never cropped',
    wp: 'WP16',
    run(app, assert) {
      const W = app.win;
      loadText(app, twoPeriodText());
      assert.equal(W.PRiSM_dataset.t.length, 72, 'full record loaded');
      const c = W.PRiSM_applyCrop(2, 60);
      assert.equal(c.t.length, 59, 'cropped to 2..60 h');
      const saved = W.PRiSM_persistedCrop();
      assert.ok(saved && saved.n === 72 && saved.t_start === 2 && saved.t_end === 60, 'crop stored with the full record');
      app.flush(1000);

      // Reload: the Data-tab text restores the full record, the crop is re-applied.
      const app2 = app.reload();
      app2.openPRiSM();
      app2.flush(500);
      const ds2 = app2.win.PRiSM_dataset;
      assert.equal(ds2.t.length, 59, 'crop re-applied after reload');
      assert.near(ds2.t[0], 2, 1e-9);
      assert.near(ds2.t[ds2.t.length - 1], 60, 1e-9);
      assert.equal(app2.win.PRiSM_cropState.fullDataset.t.length, 72, 'Reset still restores the whole record');

      // Reset clears the stored window.
      app2.win.PRiSM_resetCrop();
      assert.equal(app2.win.PRiSM_dataset.t.length, 72);
      assert.equal(app2.win.PRiSM_persistedCrop(), null, 'stored crop removed by Reset');
      const app3 = app2.reload();
      app3.openPRiSM();
      app3.flush(500);
      assert.equal(app3.win.PRiSM_dataset.t.length, 72, 'no crop after Reset + reload');

      // A crop stored for one record is not applied to another.
      app3.win.PRiSM_applyCrop(2, 60);
      app3.flush(200);
      loadText(app3, twoPeriodText().replace(/,850$/gm, ',900'));
      app3.flush(500);
      const app4 = app3.reload();
      app4.openPRiSM();
      app4.flush(500);
      assert.equal(app4.win.PRiSM_dataset.t.length, 72, 'different record: stored crop ignored');
    },
  },
  {
    name: 'XML export labels the reservoir temperature T_R in °R (it is °F + 459.67)',
    wp: 'WP16',
    run(app, assert) {
      app.openPRiSM();
      app.seedSample();
      const W = app.win;
      const x = W.PRiSM_exportXML();
      const xml = x && (x.xmlString || x.xml || '');
      const m = /<Input name="T_R" unit="([^"]+)">([^<]+)<\/Input>/.exec(xml);
      assert.ok(m, 'T_R input present');
      assert.equal(m[1], 'degR');
      assert.near(+m[2], W.PRiSM_pvt.T_res + 459.67, 1e-6, 'value is Rankine');
    },
  },
  {
    name: 'PVT above the bubble point: Bo and μo corrected by Vasquez-Beggs, μw by the McCain pressure factor',
    wp: 'WP16',
    run(app, assert) {
      const W = app.win, C = W.PRiSM_pvt_correlations;
      const pvt = W.PRiSM_pvt;
      Object.assign(pvt, { fluidType: 'oil', p_res: 4000, T_res: 180, API: 35, SG_g: 0.65, Rs: null, Pb: null, Bo: null, mu_o: null, co: null, ct: null });
      const c = W.PRiSM_pvt_compute();
      // Independent reference (Standing at pb with Rs = 500, then the undersaturated legs).
      const API = 35, sg = 0.65, T = 180, p = 4000, Rs = 500;
      const pb = 18.2 * (Math.pow(Rs / sg, 0.83) * Math.pow(10, 0.00091 * T - 0.0125 * API) - 1.4);
      assert.near(c.Pb, pb, 1e-6, 'Standing pb');
      const sgo = 141.5 / (API + 131.5);
      const Bob = 0.972 + 0.000147 * Math.pow(Rs * Math.sqrt(sg / sgo) + 1.25 * T, 1.175);
      const A = -1433 + 5 * Rs + 17.2 * T - 1180 * sg + 12.61 * API;
      assert.rel(c.Bo, Bob * Math.pow(p / pb, -A / 1e5), 1e-9, 'Bo(p) = Bob·(p/pb)^(−A/1e5)');
      assert.ok(c.Bo < Bob, 'undersaturated oil is compressed below Bob');
      const muD = Math.pow(10, Math.pow(T, -1.163) * Math.pow(10, 3.0324 - 0.02023 * API)) - 1;
      const muob = 10.715 * Math.pow(Rs + 100, -0.515) * Math.pow(muD, 5.44 * Math.pow(Rs + 150, -0.338));
      const mExp = 2.6 * Math.pow(p, 1.187) * Math.exp(-11.513 - 8.98e-5 * p);
      assert.rel(c.mu_o, muob * Math.pow(p / pb, mExp), 1e-9, 'μo(p) Vasquez-Beggs');
      assert.ok(c.mu_o > 1.15 * muob, 'μo above pb is markedly higher than μob here');
      // At / below pb nothing changes.
      assert.equal(C.Bo_undersaturated(1.3, API, sg, Rs, pb - 10, T, pb), 1.3);
      assert.equal(C.mu_o_vasquezBeggs(0.6, pb, pb), 0.6);
      // User entries still win.
      pvt.Bo = 1.25; pvt.mu_o = 1.1;
      const c2 = W.PRiSM_pvt_compute();
      assert.equal(c2.Bo, 1.25); assert.equal(c2.mu_o, 1.1);
      // Water viscosity pressure factor.
      const mu1 = C.mu_w_meehan(200, 50000);
      assert.rel(C.mu_w_meehan(200, 50000, 5000), mu1 * (0.9994 + 4.0295e-5 * 5000 + 3.1062e-9 * 25e6), 1e-12);
    },
  },
  {
    name: 'Tools drawer: every panel has a written title and group (no machine-named "More" entries)',
    wp: 'WP16',
    run(app, assert) {
      app.openPRiSM();
      app.seedSample();
      const W = app.win;
      const tools = W.PRiSM_listTools().filter((t) => t.available);
      const more = tools.filter((t) => t.group === 'More');
      assert.deepEqual(more.map((t) => t.title), [], 'no auto-named tools');
      const titles = tools.map((t) => t.title.toLowerCase());
      assert.equal(new Set(titles).size, titles.length, 'no duplicate titles');
      ['Rate-transient analysis', 'PLT & inverse simulation', 'Gauge resolution check', 'Model browser: search by behaviour']
        .forEach((t) => assert.ok(titles.indexOf(t.toLowerCase()) >= 0, t));
      W.PRiSM_openTools('rta');
      assert.equal(app.el('prism_tools_title').textContent, 'Rate-transient analysis');
      assert.ok(app.el('prism_tools_panel').innerHTML.trim().length > 0);
      W.PRiSM_closeTools();
    },
  },
  {
    name: 'GUI sweep: presets disabled with none saved, then load/delete give feedback',
    wp: 'WP16',
    run(app, assert) {
      const W = app.win;
      app.openPRiSM(); app.seedSample();
      W.PRiSM_state.presets = app.toWin([]);
      app.gotoTab(4); app.flush(100);
      assert.ok(app.el('prism_preset_load').disabled && app.el('prism_preset_del').disabled, 'Load/Delete disabled');
      assert.ok(/No saved presets/.test(app.el('prism_preset_picker').textContent));
      app.input('prism_preset_name', 'base');
      app.click('prism_preset_save');
      assert.ok(!app.el('prism_preset_load').disabled, 'enabled once a preset exists');
      app.click('prism_preset_load');
      assert.ok(/Pick a saved preset first/.test(app.el('prism_params_msg').textContent), 'load without a pick explains');
      app.select('prism_preset_picker', '0');
      app.click('prism_preset_del');
      assert.ok(/Deleted preset/.test(app.el('prism_params_msg').textContent));
      assert.ok(app.el('prism_preset_load').disabled, 'disabled again after the last delete');
    },
  },
  {
    name: 'GUI sweep: Set clock / Detect again feedback; model chips carry aria-pressed',
    wp: 'WP16',
    run(app, assert) {
      app.openPRiSM(); app.seedSample();
      app.gotoTab(1); app.flush(100);
      app.input('prism_ft_clock', '');
      app.click('prism_ft_clock_set');
      assert.ok(/Enter the clock time/.test(app.el('prism_ft_e_msg').textContent), 'empty clock warns');
      app.input('prism_ft_clock', '2026-09-01 06:00');
      app.click('prism_ft_clock_set');
      assert.ok(/Clock at t = 0 set to 2026-09-01 06:00/.test(app.el('prism_ft_e_msg').textContent), 'clock set confirmed');
      app.input('prism_ft_clock', 'nonsense');
      app.click('prism_ft_clock_set');
      assert.ok(/not recognised/.test(app.el('prism_ft_e_msg').textContent));
      app.click('prism_map_reset');
      assert.ok(/re-detected/.test(app.el('prism_data_msg').textContent), 'Detect again reports');
      app.gotoTab(3); app.flush(100);
      assert.equal(app.find('#prism_model_chips [data-prism-cat="all"]').getAttribute('aria-pressed'), 'true');
      app.click(app.find('#prism_model_chips [data-prism-cat="boundary"]'));
      assert.equal(app.find('#prism_model_chips [data-prism-cat="all"]').getAttribute('aria-pressed'), 'false');
      assert.equal(app.find('#prism_model_chips [data-prism-cat="boundary"]').getAttribute('aria-pressed'), 'true');
    },
  },
  {
    name: 'GUI sweep: Reset view is disabled until the plot is zoomed (main plot and model preview)',
    wp: 'WP16',
    run(app, assert) {
      app.openPRiSM(); app.seedSample();
      for (const [tab, btn, cv] of [[2, 'prism_plot_reset', 'prism_plot_canvas'], [4, 'prism_params_reset_view', 'prism_params_canvas']]) {
        app.gotoTab(tab); app.flush(100);
        const b = app.el(btn);
        assert.ok(b && b.disabled, btn + ' disabled before zoom');
        assert.ok(/Zoom or pan/.test(b.title), 'tooltip explains');
        app.fire(cv, 'prism:plot-view-changed', app.toWin({ zoomed: true }));
        assert.ok(!app.el(btn).disabled, btn + ' enabled after a zoom');
        app.click(btn);
        assert.ok(app.el(btn).disabled, btn + ' disabled again after reset');
      }
    },
  },
  {
    name: 'Metric mode: PRiSM states that it works in field units (prism, dca and pta routes)',
    wp: 'WP16',
    run(app, assert) {
      const W = app.win;
      app.openPRiSM();
      assert.ok(app.el('prism_units_note').hasAttribute('hidden'), 'hidden in imperial');
      W.WTS_units.setSystem('metric');
      app.flush(50);
      assert.ok(!app.el('prism_units_note').hasAttribute('hidden'), 'shown after switching to Metric');
      assert.ok(/oilfield units/.test(app.el('prism_units_note').textContent));
      for (const r of ['dca', 'pta', 'prism']) {
        app.hook.nav(r); app.flush(50);
        const n = app.el('prism_units_note');
        assert.ok(n && !n.hasAttribute('hidden'), 'note on route ' + r);
      }
      W.WTS_units.setSystem('imperial');
      app.flush(50);
      assert.ok(app.el('prism_units_note').hasAttribute('hidden'), 'hidden again in imperial');
    },
  },
  {
    name: 'ranking: double porosity at its degenerate limit (ω ≥ 0.95) yields to homogeneous with the same k and S',
    wp: 'WP16',
    run(app, assert) {
      const W = app.win;
      // Clean-data race (gas build-up k 10, S 3): double porosity leads on AIC with ω = 0.992.
      const rows = () => app.toWin([
        { modelKey: 'doublePorosity', aic: -900, r2: 0.999999999998, converged: true, params: { omega: 0.992, lambda: 1.7e-5, S: 3 }, phys: { k: 10.0008, S: 3.0 } },
        { modelKey: 'infiniteFrac', aic: -842, r2: 0.999999999996, converged: true, params: {}, phys: { k: 10.1, S: -1 } },
        { modelKey: 'homogeneous', aic: -835, r2: 0.999999999996, converged: true, params: { S: 3 }, phys: { k: 10.0008, S: 3.0 } },
      ]);
      const r1 = W.PRiSM_rankCandidates(rows());
      assert.equal(r1[0].modelKey, 'homogeneous', 'simpler model leads');
      assert.ok(r1[0].parsimony && /ω = 0.992/.test(r1[0].parsimonyNote));
      const x = rows(); x[0].params.omega = 0.1;          // a real dual-porosity signature keeps its lead
      assert.equal(W.PRiSM_rankCandidates(x)[0].modelKey, 'doublePorosity');
      const y = rows(); y[2].phys.k = 13;                 // different k: not the same description
      assert.equal(W.PRiSM_rankCandidates(y)[0].modelKey, 'doublePorosity');
      const z = rows(); z[2].r2 = 0.99;                   // homogeneous clearly worse
      assert.equal(W.PRiSM_rankCandidates(z)[0].modelKey, 'doublePorosity');
    },
  },
];
