// WP13 — workflow layer (37-prism-workflow.js): results rail, one-click
// Analyse, step ② flow periods, Tools drawer, undo/redo.
'use strict';

const META = { pi: 4200, testType: 'drawdown', q: 850, Bo: 1.25, mu_o: 1.1, ct: 1.2e-5, h: 35, phi: 0.18, rw: 0.354, fluidType: 'oil' };

// Resolve an app-realm promise while pumping the virtual clock.
async function settle(app, promise, maxMs) {
  let done = false, value, error;
  promise.then((v) => { done = true; value = v; }, (e) => { done = true; error = e; });
  const limit = maxMs || 20000;
  for (let t = 0; !done && t < limit; t += 20) await app.flushAsync(20);
  if (!done) throw new Error('promise did not settle within ' + limit + ' virtual ms');
  if (error) throw error;
  return value;
}

// Default sample + its well metadata (what WP8 seeding + WP1 setWell provide).
function seedDemo(app) {
  app.openPRiSM();
  const ds = app.seedSample();
  const w = app.win;
  if (!w.PRiSM_DEFAULT_SAMPLE_META) w.PRiSM_DEFAULT_SAMPLE_META = app.toWin(META);
  if (typeof w.PRiSM_setWell === 'function') {
    try { w.PRiSM_setWell(w.PRiSM_DEFAULT_SAMPLE_META, { source: 'sample' }); } catch (e) { /* contract variant */ }
  }
  // Without the C1 setter (or if it ignored the aliases), write the store the
  // way the sample seeding does: PRiSM_pvt field names + provenance 'sample'.
  const pvt = w.PRiSM_pvt || (w.PRiSM_pvt = app.toWin({}));
  const prov = (pvt.provenance && typeof pvt.provenance === 'object') ? pvt.provenance : (pvt.provenance = app.toWin({}));
  const fields = { p_res: META.pi, Bo: META.Bo, mu_o: META.mu_o, ct: META.ct, h: META.h, phi: META.phi, rw: META.rw, q: META.q, testType: META.testType, fluidType: 'oil' };
  for (const k of Object.keys(fields)) {
    if (pvt[k] !== fields[k] || prov[k] !== 'sample') { pvt[k] = fields[k]; prov[k] = 'sample'; }
  }
  if (typeof w.PRiSM_pvt_compute === 'function') { try { w.PRiSM_pvt_compute(); } catch (e) { /* ignore */ } }
  return ds;
}

// Loading non-demo data: forget the demo's well inputs (provenance 'sample')
// so they cannot leak into the test dataset.
function clearSampleWell(app) {
  const pvt = app.win.PRiSM_pvt;
  if (!pvt) return;
  pvt.testType = 'auto';
  const prov = pvt.provenance || {};
  for (const k of Object.keys(prov)) if (prov[k] === 'sample') prov[k] = 'default';
  if (typeof app.win.PRiSM_pvt_compute === 'function') { try { app.win.PRiSM_pvt_compute(); } catch (e) { /* ignore */ } }
}

// A rail host like the C9 shell's #prism_rail (created here when WP8's shell is absent).
function railHost(app, sheet) {
  let rail = app.el('prism_rail');
  if (!rail) {
    rail = app.document.createElement('div');
    rail.id = 'prism_rail';
    app.el('pgBody').appendChild(rail);
  }
  if (sheet) rail.classList.add('prism-rail--sheet'); else rail.classList.remove('prism-rail--sheet');
  return rail;
}

// The step ② host: the C9 shell's #prism_step2 when present, else a test div.
function workspaceHost(app) {
  let ws = app.el('prism_step2') || app.el('wp13_step_host');
  if (!ws) {
    ws = app.document.createElement('div');
    ws.id = 'wp13_step_host';
    app.el('pgBody').appendChild(ws);
  }
  return ws;
}

function twoPeriodDataset() {
  // Drawdown at 850 STB/d for 24 h, then shut-in to 72 h.
  const t = [], p = [], q = [];
  for (let i = 1; i <= 24; i++) { t.push(i); p.push(4200 - 300 - 20 * Math.log(i)); q.push(850); }
  for (let i = 1; i <= 48; i++) { t.push(24 + i); p.push(3836 + 250 * (1 - Math.exp(-i / 6))); q.push(0); }
  return { t, p, q };
}

// Elements whose inline width / min-width exceeds the phone viewport.
function wideElements(root, maxPx) {
  const out = [];
  const all = [root].concat(Array.from(root.querySelectorAll('*')));
  for (const el of all) {
    const st = el.style || {};
    for (const prop of ['width', 'minWidth']) {
      const m = /^([\d.]+)px$/.exec(String(st[prop] || ''));
      if (m && +m[1] > maxPx) out.push((el.id || el.tagName) + ' ' + prop + '=' + st[prop]);
    }
  }
  return out;
}

module.exports = [
  {
    name: 'exports: rail, analyse, step ② view, tools, undo/redo',
    wp: 'WP13',
    run(app, assert) {
      const w = app.win;
      ['PRiSM_renderRail', 'PRiSM_railInfo', 'PRiSM_analyse', 'PRiSM_openTools', 'PRiSM_closeTools', 'PRiSM_listTools',
        'PRiSM_undo', 'PRiSM_redo', 'PRiSM_canUndo', 'PRiSM_canRedo', 'PRiSM_renderFlowPeriods', 'PRiSM_getReportPins']
        .forEach((k) => assert.fn(w[k], k));
      assert.equal(typeof w.PRiSM_stepViews, 'object');
      assert.equal(w.PRiSM_stepViews[2], w.PRiSM_renderFlowPeriods, 'step ② view registered (merge pattern)');
    },
  },
  {
    name: 'Analyse on the demo data: rail shows k 45 md ±10%, S 2.5 ±0.5, C within 20%, converged, < 3 s',
    wp: 'WP13',
    timeoutMs: 60000,
    async run(app, assert) {
      seedDemo(app);
      const rail = railHost(app, false);
      const t0 = Date.now();
      const res = await settle(app, app.win.PRiSM_analyse({ engine: 'fallback' }));
      const wall = Date.now() - t0;
      assert.ok(res.ok, 'analyse ok: ' + res.error);
      const lf = app.win.PRiSM_state.lastFit;
      assert.ok(lf && lf.phys, 'lastFit committed with phys');
      const info = app.win.PRiSM_railInfo();
      const p = info.fit.phys;
      assert.within(p.k, 45 * 0.9, 45 * 1.1);
      assert.within(p.S, 2.0, 3.0);
      assert.within(p.C, 8.48e-4 * 0.8, 8.48e-4 * 1.2);
      assert.equal(info.fit.converged, true, 'converged');
      assert.ok(wall < 3000, 'analyse took ' + wall + ' ms of wall time');
      // Rail content
      const txt = rail.textContent;
      assert.includes(txt, ' md');
      assert.includes(txt, 'md·ft');
      assert.includes(txt, 'bbl/psi');
      assert.includes(txt, 'converged');
      assert.ok(/regression|auto-match|match|straight-line/.test(txt), 'source chip shown');
      assert.ok(app.el('prism_rail_headline'), 'interpretation headline shown');
      assert.equal(app.win.PRiSM_state.match.timeShift, 0, 'st.match never written');
      // Progress UI reports every step
      const prog = app.el('prism_analyse_progress');
      assert.ok(prog, 'progress UI rendered');
      assert.ok(/Done in/.test(app.el('prism_analyse_title').textContent));
      assert.ok(app.el('prism_analyse_step_refine').className.indexOf('is-ok') !== -1);
    },
  },
  {
    name: 'Analyse pipeline: race → refine; an inconsistent refined fit (A ≠ 141.2qBμ/kh) is rejected for the race row',
    wp: 'WP13',
    async run(app, assert) {
      seedDemo(app);
      railHost(app, false);
      const w = app.win;
      // Stand-ins for the shared engine (contract shapes only).
      app.evalInApp([
        "window.__wp13calls = [];",
        "window.PRiSM_fitPhysical = function () { window.__wp13calls.push('fitPhysical'); return null; };",
        "window.PRiSM_autoMatch = function (o) { window.__wp13calls.push('autoMatch:' + o.topN);",
        "  return Promise.resolve({ ranked: [",
        "    { modelKey: 'homogeneous', source: 'automatch', aic: -800, r2: 0.99999, rmse: 0.3, converged: true, params: { Cd: 80, S: 2.5 },",
        "      phys: { k: 45, kh: 1575, C: 8.48e-4, Cd: 80, S: 2.5, pi: 4200 }, scales: { A: 104.78, B: 39854 } },",
        "    { modelKey: 'infiniteFrac', source: 'automatch', aic: -780, r2: 0.9999, rmse: 0.5, converged: true, params: { Cd: 80, S: 2 },",
        "      phys: { k: 44, kh: 1540, C: 8.4e-4, S: 2 }, scales: { A: 107.2, B: 39000 } } ] }); };",
        "window.PRiSM_runRegression = function (o) { window.__wp13calls.push('runRegression:' + o.modelKey);",
        "  var f = { modelKey: o.modelKey, source: 'regression', r2: 0.99999, rmse: 0.25, aic: -900, converged: true, params: { Cd: 50, S: 2.7 },",
        "    phys: { k: 18.7, kh: 934.8, C: 8.6e-4, S: 2.7 }, scales: { A: 104.7, B: 25056 } };",
        "  window.PRiSM_state.lastFit = f; return f; };",
      ].join('\n'));
      const res = await settle(app, w.PRiSM_analyse({ goto: false }));
      assert.ok(res.ok, res.error);
      assert.equal(res.engine, 'shared');
      assert.deepEqual(Array.from(w.__wp13calls), ['autoMatch:3', 'runRegression:homogeneous']);
      assert.equal(res.candidates.length, 2);
      assert.near(res.candidates[1].dAIC, 20, 1e-9);
      const lf = w.PRiSM_state.lastFit;
      assert.near(lf.phys.k, 45, 1e-9, 'race row kept');
      assert.equal(lf.source, 'automatch');
      assert.ok(res.warnings.some((m) => /inconsistent/.test(m)), 'warning explains the rejection');
      const txt = app.el('prism_rail').textContent;
      assert.includes(txt, 'auto-match');
      assert.includes(txt, 'ΔAIC');
      assert.near(w.PRiSM_state.tcMatch.logTM, Math.log10(39854), 1e-9, 'tcMatch from scales');
    },
  },
  {
    name: 'Analyse on rate-only data races the decline models through the rate fitter',
    wp: 'WP13',
    async run(app, assert) {
      app.openPRiSM();
      await app.flushAsync(200);   // let the shell's first-render work (Data-tab parse) finish first
      const w = app.win;
      const t = [], q = [];
      for (let i = 0; i < 40; i++) { t.push(i * 24); q.push(1000 / Math.pow(1 + 0.5 * 0.01 * i, 2)); }
      clearSampleWell(app);
      w.PRiSM_dataset = app.toWin({ t, p: null, q });
      app.evalInApp([
        "window.PRiSM_fitRate = function (key, ds) {",
        "  var aic = { arps: -500, duong: -300, sepd: -350 }[key]; if (aic == null) throw new Error('no');",
        "  return { modelKey: key, kind: 'rate', source: 'regression', params: { qi: 1000, Di: 0.01, b: 0.5 }, r2: 0.999999, AIC: aic, converged: true };",
        "};",
      ].join('\n'));
      const rateKeys = Object.keys(w.PRiSM_MODELS).filter((k) => w.PRiSM_MODELS[k].kind === 'rate');
      const rail = railHost(app, false);
      const res = await settle(app, w.PRiSM_analyse({ goto: false }));
      if (rateKeys.indexOf('arps') === -1) { assert.equal(res.ok, false); return; }
      assert.ok(res.ok, res.error);
      assert.equal(res.fit.modelKey, 'arps');
      assert.equal(w.PRiSM_state.lastFit.kind, 'rate');
      assert.includes(rail.textContent, 'q_i');
      assert.includes(rail.textContent, 'D_i');
      assert.ok(/skip/.test(app.el('prism_analyse_step_semilog').className), 'no straight-line step on rates');
    },
  },
  {
    name: 'Analyse degrades gracefully with no data (resolves, no throw)',
    wp: 'WP13',
    async run(app, assert) {
      app.win.PRiSM_dataset = null;
      const res = await settle(app, app.win.PRiSM_analyse({ goto: false, engine: 'fallback' }));
      assert.equal(res.ok, false);
      assert.ok(/data/i.test(res.error), res.error);
      assert.ok(app.el('prism_analyse_step_data').className.indexOf('is-fail') !== -1);
    },
  },
  {
    name: 'Rail at 375 px: bottom sheet shows "kh · S · model · ⚠n" and expands on tap',
    wp: 'WP13',
    opts: { viewport: { width: 375, height: 812 } },
    async run(app, assert) {
      seedDemo(app);
      const rail = railHost(app, true);
      await settle(app, app.win.PRiSM_analyse({ goto: false, engine: 'fallback' }));
      app.win.PRiSM_renderRail(rail);
      const bar = app.el('prism_rail_sheetbar');
      assert.ok(bar, 'sheet bar rendered');
      const sum = app.el('prism_rail_summary').textContent;
      assert.ok(/^kh [\d,]+ · S [-\d.]+ · .+/.test(sum), 'summary: ' + sum);
      assert.equal(app.el('prism_rail_body').style.display, 'none', 'collapsed by default');
      app.click(bar);
      assert.equal(app.el('prism_rail_body').style.display, 'flex', 'expanded after tap');
      assert.equal(app.el('prism_rail_sheetbar').getAttribute('aria-expanded'), 'true');
      assert.deepEqual(wideElements(rail, 375), [], 'no fixed width wider than the phone');
      app.click('prism_rail_sheetbar');
      assert.equal(app.el('prism_rail_body').style.display, 'none', 'collapses again');
    },
  },
  {
    name: 'Rail warnings: defaulted inputs + Accept, first-sample bias, stale fit',
    wp: 'WP13',
    run(app, assert) {
      app.openPRiSM();
      const w = app.win;
      // A non-demo drawdown with no pi → reference from the data, well inputs from defaults.
      const t = [], p = [], q = [];
      for (let i = 0; i < 30; i++) { const tt = 0.1 * Math.pow(1.3, i); t.push(tt); p.push(3000 - 50 * Math.log(1 + tt * 10)); q.push(500); }
      clearSampleWell(app);
      w.PRiSM_dataset = app.toWin({ t, p, q });
      const rail = railHost(app, false);
      w.PRiSM_renderRail(rail);
      let info = w.PRiSM_railInfo();
      const ids = info.warnings.map((x) => x.id);
      assert.ok(ids.indexOf('pref') !== -1, 'reference-pressure warning: ' + JSON.stringify(ids));
      assert.ok(/biased/.test(rail.textContent), 'bias warning text');
      const defaulted = info.warnings.find((x) => x.id === 'defaulted');
      assert.ok(defaulted, 'defaulted-inputs warning');
      const acc = app.el('prism_rail_accept');
      assert.ok(acc, 'Accept button');
      app.click(acc);
      info = w.PRiSM_railInfo();
      assert.ok(!info.warnings.find((x) => x.id === 'defaulted'), 'defaulted warning cleared after Accept');
      // Stale fit: a fit for another model than the active one.
      w.PRiSM_state.lastFit = app.toWin({ modelKey: 'homogeneous', source: 'match', phys: { k: 12, kh: 600, S: 1 }, r2: 0.99, converged: true });
      w.PRiSM_state.model = 'infiniteFrac';
      w.PRiSM_renderRail(rail);
      info = w.PRiSM_railInfo();
      if (typeof w.PRiSM_getLastFit !== 'function') {
        assert.ok(info.warnings.find((x) => x.id === 'stale'), 'stale-fit notice');
        assert.includes(rail.textContent, 'out of date');
      }
      assert.includes(rail.textContent, 'match');   // source chip
    },
  },
  {
    name: 'Rail buttons: "Use as start values" and "Pin to report"',
    wp: 'WP13',
    async run(app, assert) {
      seedDemo(app);
      const rail = railHost(app, false);
      await settle(app, app.win.PRiSM_analyse({ goto: false, engine: 'fallback' }));
      const st = app.win.PRiSM_state;
      st.phys = null;
      app.click('prism_rail_use_start');
      assert.ok(st.phys && Math.abs(st.phys.k - app.win.PRiSM_railInfo().fit.phys.k) < 1e-9, 'st.phys seeded from the fit');
      app.click('prism_rail_pin');
      const pins = app.win.PRiSM_getReportPins();
      assert.equal(pins.length, 1);
      assert.ok(pins[0].phys && pins[0].phys.k > 0 && pins[0].modelKey);
      assert.includes(rail.textContent, 'Pinned');
    },
  },
  {
    name: 'Step ② flow periods: history plot, period table, select period, shut-in/tp inputs, log-log preview',
    wp: 'WP13',
    run(app, assert) {
      app.openPRiSM();
      const w = app.win;
      clearSampleWell(app);
      w.PRiSM_dataset = app.toWin(twoPeriodDataset());
      const host = workspaceHost(app);
      let seen = null;
      app.evalInApp("window.__wp13Period = []; window.addEventListener('prism:period-changed', function (e) { window.__wp13Period.push(e.detail); });");
      w.PRiSM_stepViews[2](host);
      assert.ok(app.el('prism_fp_history'), 'history canvas');
      assert.ok(app.canvasLog('prism_fp_history').length > 20, 'history drawn');
      assert.ok(app.canvasLog('prism_fp_history', 'fillRect').length >= 3, 'period bands filled');
      const rows = app.findAll('#prism_fp_table tbody tr');
      assert.equal(rows.length, 2, 'two periods');
      assert.includes(rows[0].textContent, 'Drawdown');
      assert.includes(rows[1].textContent, 'Buildup');
      app.click(rows[1]);
      assert.equal(w.PRiSM_state.activePeriod, 1, 'activePeriod set');
      seen = w.__wp13Period;
      assert.ok(seen.length >= 1 && seen[seen.length - 1].period === 1, 'prism:period-changed fired');
      const active = app.find('#prism_fp_table tbody tr.is-active');
      assert.ok(active && active.getAttribute('data-period') === '1', 'row highlighted after re-render');
      // Preview is of the extracted period
      assert.ok(app.canvasLog('prism_fp_preview').length > 5, 'preview drawn');
      const info = app.el('prism_fp_preview_info').textContent;
      assert.ok(/buildup/i.test(info), 'preview describes the buildup period: ' + info);
      // Editable shut-in time and tp → well store
      app.input('prism_fp_tshut', '24');
      app.input('prism_fp_tp', '24');
      const well = typeof w.PRiSM_getWell === 'function' ? w.PRiSM_getWell() : w.PRiSM_pvt;
      assert.equal(+well.tShut, 24);
      assert.equal(+well.tp, 24);
      assert.equal(+app.el('prism_fp_tp').value, 24, 'value shown after re-render');
      // Overlay flag + "use all data"
      app.check('prism_fp_ovl_0', true);
      assert.equal(w.PRiSM_state.periodFlags[0].overlay, true);
      app.click('prism_fp_all');
      assert.equal(w.PRiSM_state.activePeriod, null);
    },
  },
  {
    name: 'Step ② at 375 px: no element wider than the viewport; empty state links to Data',
    wp: 'WP13',
    opts: { viewport: { width: 375, height: 812 } },
    run(app, assert) {
      app.openPRiSM();
      const w = app.win;
      w.PRiSM_dataset = app.toWin(twoPeriodDataset());
      const host = workspaceHost(app);
      w.PRiSM_renderFlowPeriods(host);
      assert.deepEqual(wideElements(host, 375), []);
      w.PRiSM_dataset = null;
      w.PRiSM_renderFlowPeriods(host);
      assert.ok(app.el('prism_fp_goto_data'), 'empty state offers a way back to step ①');
    },
  },
  {
    name: 'Tools drawer: every window.PRiSM_render*Panel is reachable and opens',
    wp: 'WP13',
    run(app, assert) {
      app.openPRiSM();
      app.seedSample();
      const w = app.win;
      const listed = w.PRiSM_listTools().filter((t) => t.available);
      const fns = listed.map((t) => t.fn).filter(Boolean);
      const panels = Object.getOwnPropertyNames(w).filter((k) => /^PRiSM_render\w*(Panel|Manager|Toolbar)$/.test(k) && typeof w[k] === 'function');
      assert.ok(panels.length >= 10, 'found ' + panels.length + ' panel renderers');
      const missing = panels.filter((k) => fns.indexOf(k) === -1);
      assert.deepEqual(missing, [], 'every panel renderer is listed in the Tools drawer');
      const dr = w.PRiSM_openTools();
      assert.ok(dr && app.el('prism_tools_drawer'), 'drawer opened');
      const items = app.findAll('#prism_tools_list [data-tool]');
      assert.equal(items.length, listed.length);
      for (const t of listed) {
        const btn = app.find('#prism_tools_list [data-tool="' + t.id + '"]');
        assert.ok(btn, 'button for ' + t.id);
        app.click(btn, { allowErrors: true });
        const panel = app.el('prism_tools_panel');
        assert.ok(panel && panel.innerHTML.trim().length > 0, t.id + ' rendered content');
        assert.equal(app.el('prism_tools_title').textContent, t.title);
        app.click('prism_tools_back');
        assert.notEqual(app.el('prism_tools_listwrap').style.display, 'none');
      }
      // Search filters the list; close removes the drawer.
      app.input('prism_tools_search', 'tide', { change: false });
      const visible = app.findAll('#prism_tools_list [data-tool]').filter((b) => b.style.display !== 'none');
      assert.ok(visible.length >= 1 && visible.every((b) => /tide/i.test(b.textContent)));
      app.click('prism_tools_close');
      assert.equal(app.el('prism_tools_drawer'), null);
      // Direct open of one tool
      w.PRiSM_openTools('pvt');
      assert.equal(app.el('prism_tools_title').textContent, 'Well & fluid properties');
      w.PRiSM_closeTools();
    },
  },
  {
    name: 'Undo reverses an Apply and a model switch; redo re-applies',
    wp: 'WP13',
    run(app, assert) {
      app.openPRiSM();
      app.seedSample();
      const w = app.win;
      const st = w.PRiSM_state;
      w.PRiSM_workflow._resetHistory();
      const before = JSON.stringify({ params: st.params, lastFit: st.lastFit || null, model: st.model });
      // "Apply" of a type-curve match: params + lastFit + tcMatch, announced by prism:fit-updated.
      st.params = w.PRiSM_state.params = app.toWin({ Cd: 80, S: 2.5 });
      st.phys = app.toWin({ k: 45, C: 8.48e-4, S: 2.5 });
      st.tcMatch = app.toWin({ logPM: -2.02, logTM: 4.6, source: 'match' });
      st.lastFit = app.toWin({ modelKey: st.model, source: 'match', params: { Cd: 80, S: 2.5 }, phys: { k: 45, S: 2.5 }, r2: 0.9999, converged: true });
      app.fire('window', 'prism:fit-updated', { source: 'match' });
      assert.equal(w.PRiSM_canUndo(), true);
      // Model switch
      const prevModel = st.model;
      if (typeof w.PRiSM_setModel === 'function') w.PRiSM_setModel('infiniteFrac'); else st.model = 'infiniteFrac';
      app.fire('window', 'prism:model-changed', { modelKey: 'infiniteFrac' });
      assert.equal(st.model, 'infiniteFrac');
      // Undo the model switch
      let heard = 0;
      w.addEventListener('prism:fit-updated', () => { heard++; });
      assert.equal(w.PRiSM_undo(), true);
      assert.equal(w.PRiSM_state.model, prevModel, 'model restored');
      assert.equal(w.PRiSM_state.params.S, 2.5, 'applied params restored');
      assert.equal(w.PRiSM_state.lastFit.source, 'match');
      assert.ok(heard >= 1, 'restore dispatches prism:fit-updated');
      // Undo the Apply
      assert.equal(w.PRiSM_undo(), true);
      const after = JSON.stringify({ params: w.PRiSM_state.params, lastFit: w.PRiSM_state.lastFit || null, model: w.PRiSM_state.model });
      assert.equal(after, before, 'pre-Apply state restored');
      assert.equal(w.PRiSM_state.tcMatch == null || w.PRiSM_state.tcMatch.source !== 'match', true);
      assert.equal(w.PRiSM_canUndo(), false);
      // Redo twice
      assert.equal(w.PRiSM_redo(), true);
      assert.equal(w.PRiSM_state.params.S, 2.5);
      assert.equal(w.PRiSM_redo(), true);
      assert.equal(w.PRiSM_state.model, 'infiniteFrac');
      assert.equal(w.PRiSM_canRedo(), false);
      // Restores must not record themselves
      assert.deepEqual(JSON.parse(JSON.stringify(w.PRiSM_workflow.undoDepth())), { undo: 2, redo: 0 });
    },
  },
  {
    name: 'One Analyse run is one undo step',
    wp: 'WP13',
    async run(app, assert) {
      seedDemo(app);
      railHost(app, false);
      const w = app.win;
      w.PRiSM_state.lastFit = null;
      w.PRiSM_workflow._resetHistory();
      const res = await settle(app, w.PRiSM_analyse({ goto: false, engine: 'fallback' }));
      assert.ok(res.ok, res.error);
      assert.equal(w.PRiSM_workflow.undoDepth().undo, 1, 'exactly one snapshot for the run');
      assert.ok(w.PRiSM_state.lastFit);
      w.PRiSM_undo();
      assert.ok(!w.PRiSM_state.lastFit, 'undo removes the Analyse result');
      w.PRiSM_redo();
      assert.ok(w.PRiSM_state.lastFit && w.PRiSM_state.lastFit.phys.k > 40);
    },
  },
  {
    name: 'Undo: history is capped at 50 and a new change clears redo; undo of a well edit',
    wp: 'WP13',
    run(app, assert) {
      app.openPRiSM();
      const w = app.win;
      w.PRiSM_workflow._resetHistory();
      for (let i = 0; i < 60; i++) {
        w.PRiSM_state.params = app.toWin({ Cd: 100 + i, S: 0 });
        app.fire('window', 'prism:fit-updated', {});
      }
      assert.equal(w.PRiSM_workflow.undoDepth().undo, 50);
      w.PRiSM_undo();
      assert.equal(w.PRiSM_state.params.Cd, 158);
      w.PRiSM_state.params = app.toWin({ Cd: 1, S: 0 });
      app.fire('window', 'prism:model-changed', {});
      assert.equal(w.PRiSM_canRedo(), false, 'new change clears redo');
      // Well edit
      w.PRiSM_workflow._resetHistory();
      const h0 = w.PRiSM_pvt.h;
      w.PRiSM_pvt.h = 77;
      app.fire('window', 'prism:well-changed', {});
      w.PRiSM_undo();
      assert.equal(w.PRiSM_pvt.h, h0, 'well store restored');
    },
  },
  {
    name: 'Undo buttons + keyboard shortcut while PRiSM is on screen',
    wp: 'WP13',
    run(app, assert) {
      app.openPRiSM();
      const w = app.win;
      const doc = app.document;
      ['prism_undo', 'prism_redo'].forEach((id) => {
        if (!app.el(id)) { const b = doc.createElement('button'); b.id = id; app.el('pgBody').appendChild(b); }
      });
      w.PRiSM_workflow._resetHistory();
      assert.equal(app.el('prism_undo').disabled, true);
      w.PRiSM_state.params = app.toWin({ Cd: 5, S: 1 });
      app.fire('window', 'prism:fit-updated', {});
      assert.equal(app.el('prism_undo').disabled, false);
      doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
      assert.notEqual(w.PRiSM_state.params.Cd, 5, 'Ctrl+Z undid the change');
      assert.equal(app.el('prism_redo').disabled, false);
    },
  },
  {
    name: 'No timers left behind by the workflow layer',
    wp: 'WP13',
    async run(app, assert) {
      seedDemo(app);
      railHost(app, false);
      await settle(app, app.win.PRiSM_analyse({ goto: false, engine: 'fallback' }));
      app.win.PRiSM_renderFlowPeriods(workspaceHost(app));
      app.win.PRiSM_openTools();
      app.win.PRiSM_closeTools();
      await app.flushAsync(100);
      const mine = app.timers().filter((t) => /37-prism-workflow/.test(t.where || ''));
      assert.deepEqual(mine.map((t) => t.where), []);
    },
  },
  {
    name: 'Analyse uses the shared engine (auto-match + regression + interpretation) when loaded',
    wp: 'WP13',
    integration: true,
    timeoutMs: 60000,
    async run(app, assert) {
      seedDemo(app);
      railHost(app, false);
      const w = app.win;
      assert.fn(w.PRiSM_fitPhysical, 'WP2 fitPhysical');
      assert.fn(w.PRiSM_getAnalysisData, 'WP1 getAnalysisData');
      const t0 = Date.now();
      const res = await settle(app, w.PRiSM_analyse());
      assert.ok(res.ok, res.error);
      assert.equal(res.engine, 'shared');
      assert.ok(res.candidates.length >= 1, 'model race produced candidates');
      assert.equal(res.candidates[0].modelKey, 'homogeneous');
      const lf = w.PRiSM_getLastFit();
      assert.within(lf.phys.k, 40.5, 49.5);
      assert.within(lf.phys.S, 2.0, 3.0);
      assert.within(lf.phys.C, 8.48e-4 * 0.8, 8.48e-4 * 1.2);
      assert.equal(lf.converged, true);
      assert.ok(Date.now() - t0 < 3000, 'under 3 s');
      assert.ok(!(lf.warnings || []).some((m) => /fallback/.test(m)), 'not the built-in fallback');
      assert.ok(w.PRiSM_state.interp, 'interpretation stored');
    },
  },
  {
    name: 'C9 shell: header buttons, rail, step ② and Tools drive the workflow layer',
    wp: 'WP13',
    integration: true,
    timeoutMs: 60000,
    async run(app, assert) {
      app.openPRiSM();
      await app.flushAsync(200);
      const w = app.win;
      assert.fn(w.PRiSM_gotoStep, 'WP8 shell');
      const rail = app.el('prism_rail');
      assert.ok(rail && rail.querySelector('.prism-rail-body'), 'shell rail filled by PRiSM_renderRail');
      w.PRiSM_gotoStep(2);
      assert.ok(app.el('prism_step2').querySelector('#prism_fp_root'), 'step ② view mounted in #prism_step2');
      app.click('prism_tools_btn');
      assert.ok(app.el('prism_tools_drawer'), 'Tools button opens the drawer');
      app.click('prism_tools_close');
      w.PRiSM_workflow._resetHistory();
      const before = w.PRiSM_state.lastFit || null;
      app.evalInApp("window.__wp13done = false; window.addEventListener('prism:analyse-done', function () { window.__wp13done = true; });");
      app.click('prism_analyse_btn');
      for (let i = 0; i < 1000 && !w.__wp13done; i++) await app.flushAsync(20);
      assert.ok(w.__wp13done, 'analyse finished');
      await app.flushAsync(50);
      assert.equal(w.PRiSM_currentStep(), 4, 'Analyse lands on step ④');
      const k = w.PRiSM_railInfo().fit.phys.k;
      assert.within(k, 40.5, 49.5);
      assert.includes(app.el('prism_rail').textContent, 'md');
      assert.equal(app.el('prism_undo').disabled, false, 'undo enabled after Analyse');
      app.click('prism_undo');
      const after = w.PRiSM_state.lastFit || null;
      assert.equal(JSON.stringify(after), JSON.stringify(before), 'header undo reverts the Analyse');
    },
  },
  {
    name: 'C9 shell at 375 px: rail bottom sheet rendered by the workflow layer',
    wp: 'WP13',
    integration: true,
    opts: { viewport: { width: 375, height: 812 } },
    async run(app, assert) {
      app.openPRiSM();
      await app.flushAsync(200);
      const rail = app.el('prism_rail');
      assert.ok(rail.classList.contains('prism-rail--sheet'), 'shell put the rail in sheet mode');
      assert.ok(app.el('prism_rail_summary'), 'sheet summary from PRiSM_renderRail');
      assert.ok(/^kh .* · S .* · /.test(app.el('prism_rail_summary').textContent));
      assert.deepEqual(wideElements(rail, 375), []);
    },
  },
];
