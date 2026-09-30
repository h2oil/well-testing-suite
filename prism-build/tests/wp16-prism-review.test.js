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
];
