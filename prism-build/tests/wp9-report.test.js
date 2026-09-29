// WP9 — Report (Tab 7 / step ⑤), CSV, PDF routing, quick report, project
// save / open / new, help tooltips.
//
// Non-integration tests set the fit and straight-line result by hand, the way
// the producers (regression, auto-match, semilog) store them, so they run with
// or without the other work packages. Tests marked integration:true drive the
// real regression / semilog / well card.
'use strict';

// Default-sample truth (plan §1.4).
const META = { pi: 4200, testType: 'drawdown', q: 850, Bo: 1.25, mu_o: 1.1, ct: 1.2e-5, h: 35, phi: 0.18, rw: 0.354, fluidType: 'oil' };
const FIT = {
  modelKey: 'homogeneous', kind: 'pressure', source: 'regression', params: { Cd: 80, S: 2.5 },
  phys: { k: 45.0, kh: 1575, C: 8.48e-4, Cd: 80, S: 2.5 },
  ci95: { k: [44.8, 45.2], S: [2.47, 2.53], C: [8.4e-4, 8.56e-4] },
  r2: 0.99999, rmse: 0.31, aic: -120.4, iterations: 7, converged: true,
  scales: { A: 104.78, B: 39854 }, pRef: 4200, pRefSource: 'pi',
};
const SEMILOG = {
  ok: true, method: 'mdh', methodLabel: 'MDH (drawdown semilog)', m: 120.7, kh: 1575, k: 45.0, p1hr: 3340.9,
  S: 2.50, window: { t0: 10, t1: 120 }, line: { kind: 'mdh', m: -120.7, b: 3340.9, t0: 10, t1: 120 },
};
// Removing the other Round-8 layers exercises the local fallbacks.
const WITHOUT_ROUND8 = { '33-pta-core.js': null, '34-semilog-skin.js': null, '35-rta-dca.js': null, '37-prism-workflow.js': null };

function applyWell(app, meta) {
  const w = app.win;
  if (typeof w.PRiSM_setWell === 'function') {
    w.PRiSM_setWell(app.toWin(meta), app.toWin({ source: 'sample' }));
    return;
  }
  const pvt = w.PRiSM_pvt || (w.PRiSM_pvt = app.toWin({}));
  const map = { pi: 'p_res' };
  const prov = {};
  for (const k of Object.keys(meta)) { pvt[map[k] || k] = meta[k]; prov[map[k] || k] = 'sample'; }
  pvt.provenance = app.toWin(prov);
  if (typeof w.PRiSM_pvt_compute === 'function') w.PRiSM_pvt_compute();
}
function setup(app) {
  app.openPRiSM();
  const ds = app.seedSample();
  applyWell(app, META);
  return ds;
}
function setFit(app, fit) {
  const w = app.win;
  w.PRiSM_state.model = fit.modelKey;
  w.PRiSM_state.params = app.toWin(fit.params);
  if (typeof w.PRiSM_setLastFit === 'function') w.PRiSM_setLastFit(app.toWin(fit));
  else w.PRiSM_state.lastFit = app.toWin(fit);
}
function setSemilog(app) { app.win.PRiSM_state.semilog = app.toWin(SEMILOG); }
function text(el) { return String(el.textContent || '').replace(/\s+/g, ' '); }

function assertReportText(assert, t) {
  assert.ok(/45\.0/.test(t) && /\bmd\b/.test(t), 'k 45.0 md shown: ' + t.slice(0, 200));
  assert.includes(t, '2.50 ±');
  assert.includes(t, 'R²');
  assert.includes(t, 'AIC');
  assert.includes(t, '262');        // ΔpS
  assert.includes(t, '0.76');       // FE 0.764
  assert.includes(t, '1548');       // rinv(120 h)
  assert.ok(t.indexOf('Time-match') === -1 && t.indexOf('Pressure-match') === -1, 'legacy match rows removed');
  assert.includes(t, 'log PM');
  assert.includes(t, 'log TM');
}

module.exports = [
  {
    name: 'Tab 7 shows field-unit results with ± CI, skin deliverables, rinv and a narrative',
    wp: 'WP9',
    run(app, assert) {
      setup(app);
      setFit(app, FIT);
      setSemilog(app);
      const host = app.renderTab(7);
      const t = text(host);
      assertReportText(assert, t);
      const narr = app.find('#prism_report_narrative');
      assert.ok(narr && /[a-z].*\.\s*$/i.test(text(narr).trim()), 'narrative sentence present');
      // Source chips and the straight-line cross-check
      assert.includes(t, 'Regression');
      assert.includes(t, 'Straight-line results');
      assert.includes(t, 'agree');
      // Appendix of inputs: sample values are marked as demo data, not defaults
      const inputs = text(app.find('#prism_report_inputs'));
      assert.includes(inputs, 'Initial reservoir pressure');
      assert.ok(inputs.indexOf('4200') !== -1, 'pi listed');
      // Plots drawn on canvases
      const drawn = app.canvases('prism_report_plots').filter((c) => app.canvasLog(c).length > 0);
      assert.ok(drawn.length >= 2, 'log-log and history plots drawn (' + drawn.length + ')');
    },
  },
  {
    name: 'Tab 7 without the Round-8 layers still reports k, S, ΔpS, FE, rinv (local fallbacks)',
    wp: 'WP9',
    opts: { sourceOverrides: WITHOUT_ROUND8 },
    run(app, assert) {
      setup(app);
      assert.ok(typeof app.win.PRiSM_getLastFit !== 'function', 'C4 getter absent in this build');
      setFit(app, FIT);
      setSemilog(app);
      const t = text(app.renderTab(7));
      assertReportText(assert, t);
    },
  },
  {
    name: 'Tab 7 without a fit: honest notice, no invented interpretation, no straight line from other data',
    wp: 'WP9',
    run(app, assert) {
      setup(app);
      const w = app.win;
      w.PRiSM_state.lastFit = null;
      w.PRiSM_state.interp = null;
      w.PRiSM_state.semilog = app.toWin(Object.assign({}, SEMILOG, { datasetHash: 'another-dataset' }));
      const t = text(app.renderTab(7));
      assert.includes(t, 'No model fit yet');
      assert.ok(!app.find('#prism_report_narrative'), 'no narrative without a fit');
      assert.ok(t.indexOf('not fitted yet') !== -1, 'parameters marked as not fitted');
      if (typeof w.PRiSM_datasetHash === 'function') {
        assert.ok(t.indexOf('Straight-line results') === -1, 'straight line made on other data is not reported');
      }
      assert.ok(app.find('#prism_report_goto_fit'), 'link to step ④');
      w.PRiSM_dataset = null;
      const t2 = text(app.renderTab(7));
      assert.includes(t2, 'Nothing to report yet');
      assert.throws(() => w.PRiSM_buildReportCSV(), /No dataset/);
    },
  },
  {
    name: 'CSV: exact header, model Δp(120 h) = 1110.2 ± 1 psi, residual RMS < 1 psi, download works',
    wp: 'WP9',
    run(app, assert) {
      setup(app);
      setFit(app, FIT);
      const r = app.win.PRiSM_buildReportCSV();
      const lines = r.text.split('\n');
      assert.equal(lines[0], 't_hr,p_psia,q,dp_psi,dp_deriv_psi,model_dp_psi,model_dp_deriv_psi,residual_psi');
      assert.equal(r.rows.length, 55);
      const last = r.rows[r.rows.length - 1];
      assert.near(last[0], 120, 1e-9);
      assert.near(last[5], 1110.2, 1);
      assert.near(last[3], 1110.2, 0.1);
      let ss = 0, n = 0;
      for (const row of r.rows) if (Number.isFinite(row[7])) { ss += row[7] * row[7]; n++; }
      assert.equal(n, 55, 'residual on every row');
      assert.ok(Math.sqrt(ss / n) < 1, 'RMS residual ' + Math.sqrt(ss / n));
      assert.ok(r.rows.every((row) => row[2] === 850), 'q column filled');
      app.renderTab(7);
      app.click('prism_report_csv');
      const d = app.downloads[app.downloads.length - 1];
      assert.ok(d && /\.csv$/.test(d.filename), 'csv downloaded');
      assert.equal(d.content.split('\n')[0], lines[0]);
    },
  },
  {
    name: 'CSV for a decline fit: t_day, q, model_q, residual_q',
    wp: 'WP9',
    run(app, assert) {
      app.openPRiSM();
      const w = app.win;
      const t = [], q = [];
      // Arps qi 1000, Di 0.01/d, b 0.5, one point per day
      for (let d = 1; d <= 40; d++) { t.push(d * 24); q.push(1000 * Math.pow(1 + 0.5 * 0.01 * d, -2)); }
      w.PRiSM_dataset = app.toWin({ t, p: null, q });
      setFit(app, { modelKey: 'arps', kind: 'rate', source: 'regression', params: { qi: 1000, Di: 0.01, b: 0.5 }, r2: 1, rmse: 0, aic: -50 });
      const r = w.PRiSM_buildReportCSV();
      assert.equal(r.text.split('\n')[0], 't_day,q,model_q,residual_q');
      assert.near(r.rows[9][0], 10, 1e-9);
      assert.near(r.rows[9][2], r.rows[9][1], 1e-6);
      const txt = text(app.renderTab(7));
      assert.includes(txt, 'Decline results');
    },
  },
  {
    name: 'Export PDF goes through the host report pipeline (cover, rp-* styling, plots)',
    wp: 'WP9',
    run(app, assert) {
      setup(app);
      setFit(app, FIT);
      setSemilog(app);
      app.renderTab(7);
      const before = app.opened.length;
      app.click('prism_report_pdf');
      assert.equal(app.opened.length, before + 1, 'one print window opened');
      const html = app.opened[app.opened.length - 1].html();
      assert.includes(html, 'Engineering calculation report');   // host cover
      assert.includes(html, 'Well Test Analysis');
      assert.includes(html, 'rp-sec');
      assert.includes(html, '45.0 ± 0.2');
      assert.includes(html, 'data:image/png');
      assert.includes(html, 'Appendix');
      assert.equal(typeof app.win.PRiSM_buildReportHTML, 'function');
      const frag = app.win.PRiSM_buildReportHTML({ plots: false });
      assert.ok(frag.indexOf('<html') === -1, 'buildReportHTML returns a fragment for the host report');
    },
  },
  {
    name: 'Quick report preview shows the model, RMSE, AIC and k / S / ΔpS / FE',
    wp: 'WP9',
    run(app, assert) {
      setup(app);
      setFit(app, FIT);
      const html = app.win.WTS_quickReport.preview();
      assert.includes(html, 'PRiSM Well Test Analysis');
      assert.includes(html, 'homogeneous');
      assert.ok(/RMSE<\/th><td>0\.310/.test(html), 'RMSE number');
      assert.ok(/AIC<\/th><td>-120\.4/.test(html), 'AIC number');
      assert.includes(html, '45.0 ± 0.2');
      assert.includes(html, '2.50 ± 0.03');
      assert.includes(html, '262');
      assert.includes(html, '0.764');
      assert.ok(app.win.WTS_quickReport.availableModules().indexOf('prism') !== -1);
    },
  },
  {
    name: 'Quick report counts PRiSM as run with a model + data (no fit) and accepts legacy key case',
    wp: 'WP9',
    run(app, assert) {
      setup(app);
      const w = app.win;
      w.PRiSM_state.lastFit = null;
      assert.ok(w.WTS_quickReport.availableModules().indexOf('prism') !== -1, 'model + dataset counts');
      w.PRiSM_state.lastFit = app.toWin({ model: 'homogeneous', R2: 0.9, RMSE: 1.5, AIC: 12 });
      const html = w.WTS_quickReport.preview();
      assert.ok(/R²<\/th><td>0\.90000/.test(html), 'R2 accepted');
      assert.ok(/RMSE<\/th><td>1\.50/.test(html), 'RMSE accepted');
    },
  },
  {
    name: 'Project save → open round-trips radialComposite, params, freeze, tcMatch, mode, pi, fit, dataset',
    wp: 'WP9',
    run(app, assert, ctx) {
      setup(app);
      const w = app.win;
      if (typeof w.PRiSM_setModel === 'function') w.PRiSM_setModel('radialComposite');
      const st = w.PRiSM_state;
      st.model = 'radialComposite';
      st.params = app.toWin({ Cd: 50, S: 1.2, M: 3, F: 0.5, R: 400 });
      st.paramFreeze = app.toWin({ Cd: true, M: false });
      st.tcMatch = app.toWin({ logPM: -2.02, logTM: 4.6, source: 'match' });
      setFit(app, Object.assign({}, FIT, { modelKey: 'radialComposite', params: { Cd: 50, S: 1.2, M: 3, F: 0.5, R: 400 } }));
      st.model = 'radialComposite';
      w.PRiSM.mode = 'combined';
      if (typeof w.PRiSM_setWell === 'function') w.PRiSM_setWell(app.toWin({ pi: 4321 }), app.toWin({ source: 'user' }));
      else { w.PRiSM_pvt.p_res = 4321; w.PRiSM_pvt.provenance.p_res = 'user'; }
      const json = JSON.stringify(w.WTS_project._buildPayload());
      const mods = JSON.parse(json).modules;
      assert.ok(mods.prism && mods.prism.model === 'radialComposite', 'prism module saved');
      assert.ok(!('activeModel' in mods.prism) && !('match' in mods.prism), 'never-set / legacy keys dropped');
      assert.deepEqual(Object.keys(mods).filter((k) => /^(pvt|prism_dataset|prism)$/.test(k)), ['pvt', 'prism_dataset', 'prism']);

      const b = ctx.loadApp();                       // a fresh session, empty storage
      const res = b.win.WTS_project.loadFromObject(b.toWin(JSON.parse(json)));
      assert.ok(res && !res.error, 'loaded');
      const s2 = b.win.PRiSM_state;
      assert.equal(s2.model, 'radialComposite');
      assert.equal(s2.params.R, 400);
      assert.equal(s2.params.M, 3);
      assert.equal(s2.paramFreeze.Cd, true);
      assert.near(s2.tcMatch.logTM, 4.6, 1e-12);
      assert.near(s2.tcMatch.logPM, -2.02, 1e-12);
      assert.equal(b.win.PRiSM.mode, 'combined');
      assert.ok(s2.lastFit && s2.lastFit.phys && s2.lastFit.phys.k === 45, 'fit restored');
      assert.equal(s2.match.timeShift, 0, 'legacy match stays neutral');
      const pi = typeof b.win.PRiSM_getWell === 'function' ? b.win.PRiSM_getWell().pi : b.win.PRiSM_pvt.p_res;
      assert.equal(pi, 4321);
      assert.equal(b.win.PRiSM_dataset.t.length, 55);
      if (typeof b.win.PRiSM_getLastFit === 'function') assert.equal(b.win.PRiSM_getLastFit().stale, false, 'fit not stale after open');
    },
  },
  {
    name: 'Project New clears the dataset and the fit and resets the well inputs to defaults',
    wp: 'WP9',
    run(app, assert) {
      setup(app);
      setFit(app, FIT);
      setSemilog(app);
      app.hook.nav('clientinfo');                    // leave PRiSM so the re-render does not re-seed
      const w = app.win;
      w.WTS_project['new']();
      assert.equal(w.PRiSM_dataset, null);
      assert.equal(w.PRiSM_state.lastFit, null);
      assert.equal(w.PRiSM_state.semilog == null, true);
      assert.equal(w.PRiSM_state.model, 'homogeneous');
      const prov = (w.PRiSM_pvt && w.PRiSM_pvt.provenance) || {};
      assert.ok(!prov.p_res || prov.p_res === 'default', 'pi back to default');
      if (typeof w.PRiSM_getWell === 'function') assert.equal(w.PRiSM_getWell().pi, null);
      assert.equal(w.PRiSM.mode, 'transient');
    },
  },
  {
    name: 'Legacy project file (activeModel) still opens and does not keep a foreign dataset',
    wp: 'WP9',
    run(app, assert) {
      setup(app);
      const w = app.win;
      const r = w.WTS_project.loadFromObject(app.toWin({ format: 'h2oilproj', version: '1.0',
        modules: { prism: { activeModel: 'radialComposite', params: { Cd: 40, S: 3, M: 2, F: 1, R: 300 }, lastFit: null } } }));
      assert.ok(r && r.loaded.indexOf('prism') !== -1);
      assert.equal(w.PRiSM_state.model, 'radialComposite');
      assert.equal(w.PRiSM_state.params.R, 300);
    },
  },
  {
    name: 'Report re-renders on prism:fit-updated while visible (no polling)',
    wp: 'WP9',
    run(app, assert) {
      setup(app);
      setFit(app, FIT);
      app.gotoTab(7);
      app.renderTab(7);
      assert.includes(text(app.el('prism_tab_7')), '45.0');
      setFit(app, Object.assign({}, FIT, { phys: Object.assign({}, FIT.phys, { k: 50.0, kh: 1750 }), ci95: {} }));
      app.fire('window', 'prism:fit-updated', { source: 'regression' });
      app.flush(200);
      assert.includes(text(app.el('prism_tab_7')), '50.0');
      app.flush(5000);
      const mine = app.timers().filter((t) => /(28-help-tooltips|29-project-save|30-quick-report|36-report)/.test(t.where));
      assert.equal(mine.length, 0, 'no pending timers from WP9 files: ' + JSON.stringify(mine));
    },
  },
  {
    name: 'Report at 375 px: no fixed widths wider than the phone, tables scroll inside their card',
    wp: 'WP9',
    opts: { viewport: { width: 375, height: 812 } },
    run(app, assert) {
      setup(app);
      setFit(app, FIT);
      setSemilog(app);
      const host = app.renderTab(7);
      const all = [host].concat(Array.from(host.querySelectorAll('*')));
      for (const el of all) {
        const wv = String((el.style && (el.style.width || el.style.minWidth)) || '');
        const m = /^(\d+(?:\.\d+)?)px$/.exec(wv);
        if (m) assert.ok(+m[1] <= 375, (el.id || el.localName) + ' is ' + wv + ' wide');
      }
      for (const tbl of host.querySelectorAll('table')) {
        let p = tbl.parentNode, ok = false;
        while (p && p !== host) { if (/auto|scroll/.test(String(p.style && p.style.overflowX))) { ok = true; break; } p = p.parentNode; }
        assert.ok(ok, 'table wrapped in a horizontal scroller');
      }
      for (const c of app.canvases('prism_report_plots')) {
        const m = /^(\d+)px$/.exec(c.style.width || '');
        assert.ok(m && +m[1] <= 343, 'plot fits the phone: ' + c.style.width);
      }
    },
  },
  {
    name: 'Help tooltips: well-card ids, data-wts-help and semilog row labels get plain-language help',
    wp: 'WP9',
    run(app, assert) {
      const w = app.win, doc = app.document;
      const box = doc.createElement('div');
      box.innerHTML =
        '<label><span class="cap">Initial reservoir pressure pi</span><input id="prism_well_pi" type="number"></label>' +
        '<label><span class="cap">Producing time tp</span><input id="prism_well_tp" type="number"></label>' +
        '<div><span id="wp9_fe" data-wts-help="prism_help_FE">FE</span></div>' +
        '<table id="prism_sl_table"><tr><td class="prism-sl-l">Flow efficiency FE</td><td>0.764</td></tr>' +
        '<tr><td class="prism-sl-l">Method</td><td>MDH</td></tr></table>';
      app.el('pgBody').appendChild(box);
      w.WTS_helpTooltips.refresh();
      const capIcon = box.querySelector('.cap .wts-help-icon[data-wts-id="prism_well_pi"]');
      assert.ok(capIcon, 'icon placed in the label caption, not after the input');
      assert.ok(box.querySelector('#wp9_fe .wts-help-icon[data-wts-id="prism_help_FE"]'), 'data-wts-help binding');
      const cells = box.querySelectorAll('#prism_sl_table td.prism-sl-l');
      assert.ok(cells[0].querySelector('.wts-help-icon[data-wts-id="prism_help_FE"]'), 'semilog row bound by its label');
      assert.ok(!cells[1].querySelector('.wts-help-icon'), 'unmatched rows left alone');
      const n2 = w.WTS_helpTooltips.refresh();
      assert.equal(box.querySelectorAll('.wts-help-icon').length, 4, 'refresh is idempotent (' + n2 + ' new)');
      assert.ok(w.WTS_helpTooltips.show('prism_well_pi'));
      const layer = app.el('wts-tooltip-layer');
      assert.includes(text(layer), 'Initial reservoir pressure');
      assert.includes(text(layer), 'skin');
      assert.ok(text(layer).indexOf('prism_well_pi') === -1, 'heading is plain language, not the id');
      assert.ok(w.WTS_helpTooltips.list().indexOf('PRiSM_pInitial') !== -1, 'legacy id kept');
    },
  },

  // ─── integration (need WP1/WP2/WP5/WP8 and WP0 host edits) ────────────
  {
    name: 'Integration: Tab 7 after the real default-sample regression + semilog',
    wp: 'WP9',
    integration: true,
    timeoutMs: 120000,
    run(app, assert) {
      setup(app);
      const w = app.win;
      assert.fn(w.PRiSM_runRegression, 'regression (WP2)');
      assert.fn(w.PRiSM_semilogAnalysis, 'semilog (WP5)');
      w.PRiSM_state.model = 'homogeneous';
      const fit = w.PRiSM_runRegression(app.toWin({ modelKey: 'homogeneous' }));
      assert.ok(fit && fit.converged !== false, 'regression converged: ' + (fit && fit.reason));
      const sl = w.PRiSM_semilogAnalysis();
      assert.ok(sl && sl.ok, 'semilog ok');
      const lf = w.PRiSM_getLastFit();
      assert.near(lf.phys.k, 45, 0.5);
      const t = text(app.renderTab(7));
      // Real fit: k = 45.02 gives rinv 1548.8 → shown as 1549; check the number, not the text.
      const m = /Radius of investigation[^0-9]*([0-9.]+)/.exec(t);
      assert.ok(m, 'rinv row');
      assert.near(+m[1], 1548, 15);
      assertReportText(assert, t.replace(/Radius of investigation[^0-9]*[0-9.]+/, 'rinv 1548'));
      const r = w.PRiSM_buildReportCSV();
      assert.near(r.rows[r.rows.length - 1][5], 1110.2, 1);
    },
  },
  {
    name: 'Integration: an opened project survives a reload (C8 state + well store + dataset)',
    wp: 'WP9',
    integration: true,
    run(app, assert, ctx) {
      setup(app);
      const w = app.win;
      w.PRiSM_state.model = 'radialComposite';
      w.PRiSM_state.params = app.toWin({ Cd: 50, S: 1.2, M: 3, F: 0.5, R: 400 });
      w.PRiSM_state.tcMatch = app.toWin({ logPM: -2.02, logTM: 4.6, source: 'match' });
      w.PRiSM_setWell(app.toWin({ pi: 4321 }), app.toWin({ source: 'user' }));
      const json = JSON.stringify(w.WTS_project._buildPayload());
      const b = ctx.loadApp();
      b.win.WTS_project.loadFromObject(b.toWin(JSON.parse(json)));
      const c = b.reload();
      c.openPRiSM();
      assert.equal(c.win.PRiSM_state.model, 'radialComposite');
      assert.equal(c.win.PRiSM_state.params.R, 400);
      assert.near(c.win.PRiSM_state.tcMatch.logTM, 4.6, 1e-12);
      assert.equal(c.win.PRiSM_getWell().pi, 4321);
      assert.ok(c.win.PRiSM_dataset && c.win.PRiSM_dataset.t.length === 55, 'dataset back after reload');
    },
  },
  {
    name: 'Integration: host job report includes the PRiSM section',
    wp: 'WP9',
    integration: true,
    run(app, assert) {
      setup(app);
      setFit(app, FIT);
      const w = app.win;
      assert.equal(typeof w.PRiSM_buildReportHTML, 'function');
      w.WTS_exportJobReport();
      const html = app.opened[app.opened.length - 1].html();
      assert.includes(html, 'PRiSM Well Test Analysis');
      assert.includes(html, 'Key results');
      assert.includes(html, '45.0 ± 0.2');
    },
  },
  {
    name: 'Integration: Well & Test card inputs get help icons after the tab renders',
    wp: 'WP9',
    integration: true,
    run(app, assert) {
      app.openPRiSM();
      app.renderTab(1);
      app.flush(500);
      assert.ok(app.el('prism_well_pi'), 'well card mounted (WP1 + WP8)');
      assert.ok(app.find('.wts-help-icon[data-wts-id="prism_well_pi"]'), 'pi has a help icon');
      assert.ok(app.find('.wts-help-icon[data-wts-id="prism_well_ct"]'), 'ct has a help icon');
    },
  },
];
