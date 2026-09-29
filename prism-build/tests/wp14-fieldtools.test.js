// WP14 — field-data tools (39-prism-fieldtools.js): R12 gauge register +
// resolution check, R13 sequence-of-events log + flow-period seeding,
// R15 total-compressibility builder.
//
// Expected values are hand calculations from the published formulas, not
// outputs of the code under test:
//   Hall (1953):   cf = 1.782e-6 / φ^0.438              φ = 0.2 → 3.606256e-6 1/psi
//   Newman (1973): sandstone cf = 97.32e-6/(1+55.8721φ)^1.42859 → 2.738682e-6
//                  limestone cf = 0.853531/(1+2.47664e6φ)^0.9299 → 4.320536e-6
//   Vasquez-Beggs co (API 35, γg 0.65, Rs 500, 180 °F, 4000 psia):
//                  (−1433 + 2500 + 3096 − 767 + 441.35)/(1e5·4000) = 9.593375e-6
//   Osif cw (4000 psia, 180 °F, fresh, Rsw 0): 1/(28132 − 96660 + 403300) = 2.987108e-6
//   Semilog slope m = 162.6·500·1.2·0.8/(20·50) = 78.048 psi/cycle;
//   window change at L = 0.1: 78.048·0.2/ln10 = 6.779163 psi.
//   Sampling limit m·Δs/(ln10·r) = 20·0.01/(2.302585·0.01) = 8.685890 h.
'use strict';

function freshWell(app) {
  const pvt = app.win.PRiSM_pvt;
  if (pvt && pvt.provenance) for (const k of Object.keys(pvt.provenance)) pvt.provenance[k] = 'default';
  if (pvt) pvt.testType = 'auto';
}

// Drawdown at 500 STB/d: p = 3900 − 30·log10 t up to 10 h, then flat
// (derivative → 0). 10 samples per log cycle from 0.01 to 100 h (+ a t = 0 row).
function flatLateDataset() {
  const t = [0], p = [3900 + 30 * 2 + 30], q = [500];
  for (let k = -20; k <= 20; k++) {
    const tt = Math.pow(10, k / 10);
    t.push(tt);
    p.push(tt <= 10 + 1e-9 ? 3900 - 30 * (k / 10) : 3870);
    q.push(500);
  }
  return { t, p, q };
}

module.exports = [
  {
    name: 'R15 rock compressibility: Hall and Newman correlations match hand values',
    wp: 'WP14',
    run(app, assert) {
      const W = app.win;
      assert.rel(W.PRiSM_rockCompressibility(0.2, 'hall'), 3.606256e-6, 1e-6, 'Hall φ=0.2');
      assert.rel(W.PRiSM_rockCompressibility(0.2, 'newman-sandstone'), 2.738682e-6, 1e-6, 'Newman sandstone');
      assert.rel(W.PRiSM_rockCompressibility(0.2, 'newman-limestone'), 4.320536e-6, 1e-6, 'Newman limestone');
      assert.ok(!isFinite(W.PRiSM_rockCompressibility(0, 'hall')), 'φ = 0 rejected');
      assert.ok(!isFinite(W.PRiSM_rockCompressibility(1.2, 'hall')), 'φ > 1 rejected');
    },
  },
  {
    name: 'R15 ct builder: entered values sum So·co + Sw·cw + Sg·cg + cf; bad saturations refused',
    wp: 'WP14',
    run(app, assert) {
      const W = app.win;
      const r = W.PRiSM_ctBuild({ fluid: 'oil', So: 0.7, Sw: 0.3, co: 1.2e-5, cw: 3e-6, phi: 0.2, cfMethod: 'hall' });
      assert.ok(r.ok, r.reason);
      // 0.7·1.2e-5 + 0.3·3e-6 + 3.606256e-6 = 1.2906256e-5
      assert.rel(r.ct, 1.2906256e-5, 1e-6, 'ct');
      assert.rel(r.terms.oil, 8.4e-6, 1e-9);
      assert.rel(r.terms.water, 9.0e-7, 1e-9);
      assert.equal(r.terms.gas, 0);
      // Gas reservoir, all entered: 0.7·2.5e-4 + 0.3·3e-6 + 4e-6 = 1.799e-4
      const g = W.PRiSM_ctBuild({ fluid: 'gas', Sw: 0.3, cg: 2.5e-4, cw: 3e-6, cf: 4e-6, cfMethod: 'user' });
      assert.ok(g.ok, g.reason);
      assert.rel(g.ct, 1.799e-4, 1e-9, 'gas ct');
      assert.near(g.inputs.Sg, 0.7, 1e-12, 'Sg = 1 − Sw');
      const bad = W.PRiSM_ctBuild({ fluid: 'oil', So: 0.6, Sw: 0.3, Sg: 0.3, co: 1e-5, cw: 3e-6, cf: 4e-6, cfMethod: 'user' });
      assert.ok(!bad.ok && /add up to 1/.test(bad.reason), 'sum ≠ 1 refused');
    },
  },
  {
    name: 'R15 ct builder: 16-pvt correlations (Vasquez-Beggs co, Osif cw) + Newman cf; ct written with provenance correlation',
    wp: 'WP14',
    run(app, assert) {
      const W = app.win;
      freshWell(app);
      W.PRiSM_setWell(app.toWin({ fluid: 'oil', p_res: 4000, T_res: 180, API: 35, SG_g: 0.65, Rs: 500, Rsw: 0, Sw: 0.25, phi: 0.2 }), { source: 'user' });
      const r = W.PRiSM_ctBuild({ cfMethod: 'newman-sandstone' });
      assert.ok(r.ok, r.reason);
      assert.rel(r.inputs.co, 9.593375e-6, 1e-6, 'co Vasquez-Beggs');
      assert.rel(r.inputs.cw, 2.987108e-6, 1e-6, 'cw Osif');
      assert.rel(r.inputs.cf, 2.738682e-6, 1e-6, 'cf Newman');
      assert.near(r.inputs.So, 0.75, 1e-12);
      // 0.75·9.593375e-6 + 0.25·2.987108e-6 + 2.738682e-6 = 1.068049e-5
      assert.rel(r.ct, 1.068049e-5, 1e-6, 'ct');
      assert.equal(r.sources.co, 'correlation');
      assert.equal(r.isDefaulted, false, 'all inputs entered: ' + r.defaulted.join(','));
      const a = W.PRiSM_ctApply(r);
      assert.ok(a.ok);
      const w = W.PRiSM_getWell();
      assert.rel(w.ct, 1.068049e-5, 1e-6, 'getWell().ct');
      assert.equal(w.provenance.ct, 'correlation');
      assert.equal(W.PRiSM_pvt.provenance.ct, 'correlation');
      assert.ok(W.PRiSM_state.fieldTools.ctBuild && W.PRiSM_state.fieldTools.ctBuild.cfMethod === 'newman-sandstone');
    },
  },
  {
    name: 'R15 ct builder flags defaulted inputs (Sw, φ, p, T from store defaults)',
    wp: 'WP14',
    run(app, assert) {
      const W = app.win;
      freshWell(app);
      W.PRiSM_setWell(app.toWin({ fluid: 'oil' }), { source: 'user' });
      const r = W.PRiSM_ctBuild({});
      assert.ok(r.ok, r.reason);
      assert.equal(r.isDefaulted, true);
      ['Sw', 'phi', 'p', 'T'].forEach((k) => assert.ok(r.defaulted.indexOf(k) !== -1, k + ' in ' + r.defaulted.join(',')));
      assert.equal(r.cfMethod, 'hall', 'Hall is the default rock correlation');
    },
  },
  {
    name: 'R12 gauge register: validation, primary gauge, remove, persisted by PRiSM_saveState across a reload',
    wp: 'WP14',
    run(app, assert) {
      const W = app.win;
      const bad = W.PRiSM_setGauge(app.toWin({ serial: 'X', resolution: -1, calDate: '2026-13-01' }));
      assert.ok(!bad.ok && bad.errors.length === 2, 'negative resolution + bad date: ' + bad.errors.join(' | '));
      const a = W.PRiSM_setGauge(app.toWin({ serial: 'QZ-101', type: 'quartz', range: 10000, resolution: 0.01, accuracy: 2, calDate: '2026-03-15', depth: 9850 }));
      const b = W.PRiSM_setGauge(app.toWin({ serial: 'SG-7', type: 'strain', range: 15000, resolution: 0.5, accuracy: 15 }));
      assert.ok(a.ok && b.ok);
      assert.equal(W.PRiSM_primaryGauge().serial, 'QZ-101', 'first gauge is primary');
      assert.ok(W.PRiSM_setPrimaryGauge(b.gauge.id));
      assert.equal(W.PRiSM_primaryGauge().serial, 'SG-7');
      assert.equal(W.PRiSM_listGauges().length, 2);
      const saved = JSON.parse(app.storage.getItem('wts_prism_state'));
      assert.equal(saved.fieldTools.gauges.length, 2, 'saved in wts_prism_state');
      const app2 = app.reload();
      try {
        assert.equal(app2.win.PRiSM_listGauges().length, 2, 'restored after reload');
        assert.equal(app2.win.PRiSM_primaryGauge().serial, 'SG-7');
        assert.ok(app2.win.PRiSM_removeGauge(b.gauge.id));
        assert.equal(app2.win.PRiSM_primaryGauge().serial, 'QZ-101', 'primary falls back');
      } finally { app2.dispose(); }
    },
  },
  {
    name: 'C8 project file carries the field tools (prism module) and New clears them',
    wp: 'WP14',
    run(app, assert) {
      const W = app.win;
      if (!W.WTS_project || typeof W.WTS_project._buildPayload !== 'function') { assert.ok(true, 'project layer absent'); return; }
      W.PRiSM_setGauge(app.toWin({ serial: 'PF-1', resolution: 0.01 }));
      W.PRiSM_addEvent(app.toWin({ type: 'open', t: 0, q: 900 }));
      const payload = JSON.parse(JSON.stringify(W.WTS_project._buildPayload()));
      const pm = payload.modules.prism;
      const ftp = (pm.extra && pm.extra.fieldTools) || pm.fieldTools;
      assert.ok(ftp && ftp.gauges.length === 1 && ftp.events.length === 1, 'fieldTools in the prism module');
      W.PRiSM_clearEvents();
      W.PRiSM_removeGauge(W.PRiSM_listGauges()[0].id);
      const res = W.WTS_project.loadFromObject(app.toWin(payload));
      assert.ok(!res.error, res.error);
      assert.equal(W.PRiSM_listGauges()[0].serial, 'PF-1', 'gauge restored from the project');
      assert.equal(W.PRiSM_listEvents()[0].q, 900, 'event restored from the project');
    },
  },
  {
    name: 'R12 resolution check: expected slope from the fit, late-time flat data flagged, range + calibration checks',
    wp: 'WP14',
    run(app, assert) {
      const W = app.win;
      freshWell(app);
      W.PRiSM_state.bourdetL = 0.1;
      W.PRiSM_dataset = app.toWin(flatLateDataset());
      W.PRiSM_setWell(app.toWin({ fluid: 'oil', B: 1.2, mu: 0.8, h: 50 }), { source: 'user' });
      W.PRiSM_setLastFit(app.toWin({ modelKey: W.PRiSM_state.model || 'homogeneous', phys: { k: 20 }, r2: 0.99, converged: true }));
      W.PRiSM_setEventClock('2026-09-01 00:00');
      W.PRiSM_setGauge(app.toWin({ serial: 'QZ-1', range: 3000, resolution: 1, calDate: '2025-01-01' }));
      const r = W.PRiSM_gaugeResolutionCheck({ L: 0.1 });
      assert.ok(r.ok, r.reason);
      assert.equal(r.mSource, 'fit');
      assert.rel(r.m, 78.048, 1e-9, 'm = 162.6 qBμ/kh');
      assert.rel(r.windowChange, 6.779163, 1e-6, 'm·2L/ln10');
      assert.rel(r.ratio, 6.779163, 1e-6);
      assert.equal(r.verdict, 'marginal', '1 ≤ ratio < 10');
      // Early points: neighbours 0.2 cycles apart → 6 psi window (> 1 psi). Flat from
      // 10 h: every point from 10^1.1 h to the last interior point 10^1.9 h is flagged.
      assert.equal(r.flagged.length, 9, 'flagged: ' + r.flagged.length);
      assert.rel(r.tFlagStart, 12.589254, 1e-6);
      assert.equal(r.nBelow, 9);
      const range = r.checks.filter((c) => c.key === 'range')[0];
      assert.ok(range && !range.ok, 'p max 3990 psia > 3000 psi range');
      const cal = r.checks.filter((c) => c.key === 'calibration')[0];
      assert.ok(cal && !cal.ok && Math.round(r.calAgeDays) === 608, 'calibration 608 days old: ' + r.calAgeDays);
      // Quartz-class gauge (0.01 psi): ratio 678 → ✓; the flat tail (zero change) stays flagged.
      const r2 = W.PRiSM_gaugeResolutionCheck({ L: 0.1, resolution: 0.01 });
      assert.equal(r2.verdict, 'ok');
      assert.rel(r2.ratio, 677.9163, 1e-6);
      assert.equal(r2.flagged.length, 9);
      assert.equal(r2.points.filter((p) => p.below && p.t < 10).length, 0, 'no early point below 0.01 psi');
      assert.rel(W.PRiSM_gaugeSamplingLimit(20, 0.01, 0.01), 8.685890, 1e-6, 'sampling limit');
    },
  },
  {
    name: 'R12/R13 post-draw hook: flags on the log-log plot, event markers on the history plot',
    wp: 'WP14',
    run(app, assert) {
      const W = app.win;
      app.openPRiSM();
      freshWell(app);
      W.PRiSM_state.bourdetL = 0.1;
      W.PRiSM_dataset = app.toWin(flatLateDataset());
      W.PRiSM_setGauge(app.toWin({ serial: 'QZ-1', resolution: 1 }));
      W.PRiSM_addEvent(app.toWin({ type: 'close', t: 5, label: 'Choke shut' }));
      W.PRiSM_gotoStep(3);
      const c = app.el('prism_plot_canvas');
      assert.ok(c, 'plot canvas');
      W.PRiSM_state.activePlot = 'bourdet';
      assert.ok(W.PRiSM_drawActivePlot(), 'drawn');
      const texts = app.canvasTexts(c);
      assert.ok(texts.some((s) => /9 derivative points below gauge resolution/.test(s)), 'flag label: ' + texts.filter((s) => /gauge/.test(s)).join('|'));
      assert.ok(texts.indexOf('Choke shut') !== -1, 'event label on log-log (Δt = 5 h)');
      W.PRiSM_state.activePlot = 'cartesian';
      assert.ok(W.PRiSM_drawActivePlot());
      assert.ok(app.canvasTexts(c).indexOf('Choke shut') !== -1, 'event label on history plot');
    },
  },
  {
    name: 'R13 events: aliases, clock conversion, host API source, remove/clear, invalid rejected',
    wp: 'WP14',
    run(app, assert) {
      const W = app.win;
      assert.equal(W.PRiSM_addEvent(app.toWin({ type: 'teleport', t: 1 })), null, 'unknown type rejected');
      W.PRiSM_setEventClock('2026-09-01T06:00:00Z');
      const e1 = W.PRiSM_addEvent(app.toWin({ type: 'shut-in', time: '2026-09-02T06:30:00Z', source: 'simulator' }));
      assert.equal(e1.type, 'close');
      assert.near(e1.t, 24.5, 1e-12, '24.5 h after the clock zero');
      assert.equal(e1.source, 'simulator');
      const e0 = W.PRiSM_addEvent(app.toWin({ type: 'tool-open', t: 0, q: 800 }));
      assert.equal(e0.type, 'open');
      const ev = W.PRiSM_listEvents();
      assert.deepEqual(Array.from(ev).map((e) => e.type), ['open', 'close'], 'sorted by t');
      // Event added before the clock is known is placed when the clock is set.
      W.PRiSM_setEventClock(null);
      const e2 = W.PRiSM_addEvent(app.toWin({ type: 'sampling', time: '2026-09-01 18:00' }));
      assert.equal(e2.t, null, 'unplaced without a clock');
      W.PRiSM_setEventClock('2026-09-01 06:00');
      const s = W.PRiSM_listEvents().filter((e) => e.type === 'sampling')[0];
      assert.near(s.t, 12, 1e-12, 'placed at 12 h');
      assert.ok(W.PRiSM_removeEvent(e2.id));
      assert.equal(W.PRiSM_listEvents().length, 2);
      assert.ok(W.PRiSM_clearEvents());
      assert.equal(W.PRiSM_listEvents().length, 0);
    },
  },
  {
    name: 'R13 seed flow periods from events → C2 rate history; undo / redo restore the multi-rate table',
    wp: 'WP14',
    run(app, assert) {
      const W = app.win;
      app.openPRiSM();
      const t = [], p = [];
      for (let i = 1; i <= 200; i++) { t.push(i * 0.5); p.push(4000 - i * 0.1); }
      W.PRiSM_dataset = app.toWin({ t, p });
      W.PRiSM.multiRate = app.toWin([]);
      [{ type: 'open', t: 0, q: 800 }, { type: 'sampling', t: 5 }, { type: 'choke', t: 10, q: 1200 },
       { type: 'close', t: 24 }, { type: 'open', t: 48 }, { type: 'rate', t: 50, q: 600 }, { type: 'close', t: 72 }]
        .forEach((e) => W.PRiSM_addEvent(app.toWin(e)));
      const sch = W.PRiSM_eventsToRateSchedule();
      assert.deepEqual(JSON.parse(JSON.stringify(sch.rows)),
        [{ t: 0, q: 800 }, { t: 10, q: 1200 }, { t: 24, q: 0 }, { t: 48, q: 600 }, { t: 72, q: 0 }]);
      const res = W.PRiSM_seedPeriodsFromEvents();
      assert.ok(res.ok, res.reason);
      assert.equal(W.PRiSM.multiRate.length, 5);
      assert.equal(JSON.parse(app.storage.getItem('wts_prism_mrate')).length, 5, 'multi-rate table persisted');
      const rh = W.PRiSM_rateHistory();
      assert.equal(rh.source, 'multiRate');
      assert.deepEqual(Array.from(rh.periods).map((x) => x.type), ['flow', 'flow', 'shut-in', 'flow', 'shut-in']);
      assert.deepEqual(Array.from(rh.periods).map((x) => x.t0), [0, 10, 24, 48, 72]);
      assert.ok(res.undoable && W.PRiSM_canUndo(), 'undoable');
      W.PRiSM_undo();
      assert.equal(W.PRiSM.multiRate.length, 0, 'undo restores the empty table');
      assert.equal(W.PRiSM_rateHistory().source, 'none');
      W.PRiSM_redo();
      assert.equal(W.PRiSM.multiRate.length, 5, 'redo re-applies');
      // Open without any rate before the next close → warning, not seeded.
      const s2 = W.PRiSM_eventsToRateSchedule(app.toWin([{ type: 'open', t: 0 }, { type: 'close', t: 5 }]));
      assert.ok(!s2.ok && s2.warnings.length === 1);
    },
  },
  {
    name: 'C7 panels: ct builder, gauge register and events log mount on Tab 1; UI adds a gauge and seeds periods',
    wp: 'WP14',
    run(app, assert) {
      const W = app.win;
      app.openPRiSM();
      app.renderTab(1);
      const ids = app.findAll('#prism_tab_1_panels .prism-panel').map((e) => e.getAttribute('data-panel-id'));
      ['prism_ct_builder', 'prism_gauge_register', 'prism_events_log'].forEach((id) => assert.ok(ids.indexOf(id) !== -1, id + ' in ' + ids.join(',')));
      assert.ok(app.el('prism_ft_gauges_root') && app.el('prism_ft_events_root'));
      app.input('prism_ft_g_serial', 'UI-9');
      app.input('prism_ft_g_res', '0.02');
      app.input('prism_ft_g_range', '10000');
      app.click('prism_ft_g_add');
      assert.equal(W.PRiSM_listGauges().length, 1);
      assert.equal(W.PRiSM_primaryGauge().resolution, 0.02);
      assert.includes(app.el('prism_ft_gauges_root').textContent, 'UI-9', 'table re-rendered');
      app.select('prism_ft_e_type', 'open'); app.input('prism_ft_e_t', '0'); app.input('prism_ft_e_q', '700');
      app.click('prism_ft_e_add');
      app.select('prism_ft_e_type', 'close'); app.input('prism_ft_e_t', '12');
      app.click('prism_ft_e_add');
      assert.equal(W.PRiSM_listEvents().length, 2);
      app.click('prism_ft_seed');
      assert.deepEqual(JSON.parse(JSON.stringify(W.PRiSM.multiRate)), [{ t: 0, q: 700 }, { t: 12, q: 0 }]);
      assert.includes(app.el('prism_ft_e_msg').textContent, '2 rate steps');
      assert.equal(app.consoleErrors().length, 0, 'no console errors');
    },
  },
];
