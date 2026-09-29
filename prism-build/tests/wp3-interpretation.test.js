// WP3 — interpretation acceptance tests (14-interpretation.js).
'use strict';

const WELL = { q: 850, B: 1.25, mu: 1.1, ct: 1.2e-5, h: 35, phi: 0.18, rw: 0.354, pi: 4200 };

function interp(app, model, params, ci, meta) {
  return app.win.PRiSM_interpretFit(model, app.toWin(params), app.toWin(ci || {}), app.toWin(meta || {}));
}
const txt = (r) => (r.narrative + ' ' + r.actions.join(' | ')).toLowerCase();

module.exports = [
  {
    name: 'd1. lastFit R2 = 0.8 (alias) → confidence low via interpretCurrentFit',
    wp: 'WP3',
    run(app, assert) {
      const w = app.win;
      w.PRiSM_state = w.PRiSM_state || app.toWin({});
      w.PRiSM_state.model = 'homogeneous';
      w.PRiSM_state.lastFit = app.toWin({ modelKey: 'homogeneous', params: { Cd: 80, S: 1 }, R2: 0.8, CI95: { S: [0.9, 1.1] } });
      const r = w.PRiSM_interpretCurrentFit();
      assert.ok(r, 'interpretation produced');
      assert.equal(r.confidence, 'low');
    },
  },
  {
    name: 'd2. skin actions keyed on S: 2.5 consider, 7 not strongly, 15 strongly',
    wp: 'WP3',
    run(app, assert) {
      const r25 = interp(app, 'homogeneous', { Cd: 80, S: 2.5 });
      const s = r25.tags.find((t) => t.param === 'S');
      assert.equal(s.qualitative, 'mildly damaged');
      assert.ok(r25.actions.some((a) => /consider/i.test(a)), r25.actions.join(' | '));
      assert.ok(!/strongly/.test(txt(r25)));
      assert.ok(!/no immediate workover/.test(txt(r25)));
      const r7 = interp(app, 'homogeneous', { Cd: 80, S: 7 });
      assert.ok(!/strongly/.test(txt(r7)), 'S 7 must not say strongly: ' + txt(r7));
      assert.ok(r7.actions.some((a) => /remedial treatment recommended/i.test(a)));
      const r15 = interp(app, 'homogeneous', { Cd: 80, S: 15 });
      assert.ok(r15.actions.some((a) => /strongly/i.test(a)));
    },
  },
  {
    name: 'd3. FE < 0.5 forces "strongly" even at moderate skin',
    wp: 'WP3',
    run(app, assert) {
      // S 7 with a small drawdown: ΔpS ≈ 733 psi > half of (pi − pwf) = 1000 psi → FE < 0.5
      const r = interp(app, 'homogeneous', { Cd: 80, S: 7 }, {}, {
        phys: { k: 45, kh: 1575, pi: 4200 }, pwf: 3200, well: WELL });
      assert.ok(r.skin.FE < 0.5, 'FE ' + r.skin.FE);
      assert.ok(r.actions.some((a) => /strongly/i.test(a)));
    },
  },
  {
    name: 'd4. homogeneous S = −6 → fracture-model suggestion; no reassurance contradiction',
    wp: 'WP3',
    run(app, assert) {
      const r = interp(app, 'homogeneous', { Cd: 80, S: -6 });
      assert.ok(r.actions.some((a) => /try a fracture model/i.test(a) && /50·rw/.test(a)), r.actions.join(' | '));
      assert.ok(!/no immediate workover/.test(txt(r)));
      const frac = interp(app, 'infiniteFrac', { Cd: 80, S: -6 });
      assert.ok(!frac.actions.some((a) => /try a fracture model/i.test(a)), 'no fracture suggestion for a fracture model');
    },
  },
  {
    name: 'd5. finiteFracSkin Sf = 5 → fracture-face damage tag and action',
    wp: 'WP3',
    run(app, assert) {
      const r = interp(app, 'finiteFracSkin', { Cd: 100, S: 0, FcD: 10, Sf: 5 });
      const sf = r.tags.find((t) => t.param === 'Sf');
      assert.ok(sf, 'Sf tagged');
      assert.equal(sf.qualitative, 'fracture-face damage');
      assert.ok(r.actions.some((a) => /fracture-face damage/i.test(a)));
      assert.ok(!/no immediate workover/.test(txt(r)));
    },
  },
  {
    name: 'd6. horizontal {S_perf 1, S_global 6} → no "no workover" sentence',
    wp: 'WP3',
    run(app, assert) {
      const r = interp(app, 'horizontal', { Cd: 100, S_perf: 1, S_global: 6, KvKh: 0.1, L_to_h: 5, zw_to_h: 0.5 });
      assert.ok(!/no immediate workover/.test(txt(r)), txt(r));
      assert.ok(r.actions.some((a) => /remedial/i.test(a)), 'total mechanical skin 7 → remedial');
      const clean = interp(app, 'horizontal', { Cd: 100, S_perf: 0.5, S_global: 0.5, KvKh: 0.1, L_to_h: 5, zw_to_h: 0.5 });
      assert.ok(clean.actions.some((a) => /no immediate workover/i.test(a)), 'reassurance when every skin term is fine');
    },
  },
  {
    name: 'default-sample wording: mild damage, FE 76 %, +31 % rate, honest precision',
    wp: 'WP3',
    run(app, assert) {
      const r = interp(app, 'homogeneous', { Cd: 79.9, S: 2.5047 },
        { S: [2.457, 2.552], Cd: [78.4, 81.4], k: [44.71, 45.33], C: [8.33e-4, 8.62e-4] },
        { r2: 0.99999, dAIC: 12, iterations: 5, phys: { k: 45.02, kh: 1575.7, C: 8.47e-4, Cd: 79.9, S: 2.5047, pi: 4200, rinv: 1548 },
          pwf: 3089.8, well: WELL, testType: 'drawdown' });
      assert.includes(r.narrative, 'mild damage');
      assert.includes(r.narrative, 'FE 76%');
      assert.includes(r.narrative, '≈31% rate');
      assert.includes(r.narrative, 'S = 2.50 ± 0.05');
      assert.includes(r.narrative, '45.0 ± 0.3 md');
      assert.near(r.skin.FE, 0.764, 0.005);
      assert.near(r.skin.DR, 1.309, 0.01);
      assert.near(r.skin.dpS, 261.9, 1.5);
      assert.includes(r.headline, 'FE 76%');
      assert.includes(r.headline.toLowerCase(), 'mildly damaged');
      assert.equal(r.confidence, 'high');
    },
  },
  {
    name: 'honest precision formatter',
    wp: 'WP3',
    run(app, assert) {
      const f = app.win.PRiSM_formatWithCI;
      assert.equal(f(45.0312, 0.31, 'md'), '45.0 ± 0.3 md');
      assert.equal(f(2.5047, 0.047), '2.50 ± 0.05');
      assert.equal(f(1575.7, 13.6, 'md·ft'), '1576 ± 14 md·ft');
      assert.equal(f(0.3, 2), '≈0.3 (poorly constrained)');
      assert.equal(f(120.66), '121');
    },
  },
  {
    name: 'pseudo-skin: actions use S_mech (registry pseudoSkin metadata)',
    wp: 'WP3',
    run(app, assert) {
      app.evalInApp("window.PRiSM_MODELS.__wp3pp = { pd: function (t) { return t; }, defaults: { Cd: 100, S: 0 }, category: 'well-type'," +
        " paramSpec: [{ key: 'Cd' }, { key: 'S' }], pseudoSkin: function () { return 10; } };");
      const r = interp(app, '__wp3pp', { Cd: 100, S: 1.5 });
      assert.near(r.skin.S_total, 11.5, 1e-9);
      assert.near(r.skin.S_mech, 1.5, 1e-9);
      assert.ok(!r.actions.some((a) => /strongly|remedial|acid/i.test(a)), 'geometric skin does not trigger stimulation');
      assert.includes(r.narrative, 'mechanical skin of 1.50');
    },
  },
  {
    name: 'interpretation refreshes st.interp on prism:fit-updated and the panel renders it',
    wp: 'WP3',
    run(app, assert) {
      const w = app.win;
      w.PRiSM_state = w.PRiSM_state || app.toWin({});
      w.PRiSM_state.model = 'homogeneous';
      w.PRiSM_state.interp = null;
      w.PRiSM_state.lastFit = app.toWin({ modelKey: 'homogeneous', params: { Cd: 80, S: 2.5 }, r2: 0.9999,
        phys: { k: 45, kh: 1575, S: 2.5, pi: 4200 }, source: 'regression' });
      app.fire('window', 'prism:fit-updated', { source: 'regression' });
      const st = w.PRiSM_state;
      assert.ok(st.interp && st.interp.narrative, 'st.interp refreshed');
      assert.includes(st.interp.narrative, 'mild damage');
      const host = app.document.createElement('div');
      w.PRiSM_renderInterpretationPanel(host);
      assert.includes(host.innerHTML, 'Interpretation');
      assert.includes(host.innerHTML, 'prism-interp');
      assert.includes(host.innerHTML, 'Suggested actions');
      const css = app.document.getElementById('prism_interp_css').textContent;
      assert.ok(/var\(--bg2\)/.test(css) && /var\(--yellow\)/.test(css), 'theme variables');
      assert.ok(!/#0d1117|#c9d1d9/.test(host.innerHTML), 'no hard-coded palette');
    },
  },
  {
    name: 'interpretation panel is registered for Tab 6 (order 30, only when a fit exists)',
    wp: 'WP3',
    run(app, assert) {
      const w = app.win;
      const list = (w.PRiSM_tabPanels && w.PRiSM_tabPanels[6]) || [];
      const p = Array.prototype.find.call(list, (x) => x && x.id === 'prism_interp_panel');
      assert.ok(p, 'registered');
      assert.equal(p.order, 30);
      w.PRiSM_state = w.PRiSM_state || app.toWin({});
      w.PRiSM_state.lastFit = null;
      if (typeof w.PRiSM_getLastFit !== 'function' || !w.PRiSM_getLastFit()) assert.equal(p.when(), false);
      w.PRiSM_state.lastFit = app.toWin({ modelKey: 'homogeneous', params: { Cd: 80, S: 2.5 }, r2: 0.99 });
      assert.equal(p.when(), true);
      const host = app.document.createElement('div');
      p.render(host);
      assert.includes(host.innerHTML, 'Interpretation');
    },
  },
  {
    name: 'decline fits are not given a pressure narrative',
    wp: 'WP3',
    run(app, assert) {
      const w = app.win;
      w.PRiSM_state = w.PRiSM_state || app.toWin({});
      w.PRiSM_state.lastFit = app.toWin({ modelKey: 'arps', kind: 'rate', params: { qi: 1000, Di: 0.01, b: 0.5 }, r2: 1 });
      assert.equal(w.PRiSM_interpretCurrentFit(), null);
    },
  },
  {
    name: 'I5. plain-S model with partial-penetration geometry: actions use S_mech from 34',
    wp: 'WP3', integration: true,
    run(app, assert) {
      assert.fn(app.win.PRiSM_skinDecomposition);
      const r = interp(app, 'homogeneous', { Cd: 80, S: 12.79 }, {}, {
        geom: { h: 35, hp: 7, rw: 0.354, kvkh: 1 }, well: WELL });
      assert.near(r.skin.S_total, 12.79, 1e-9);
      assert.ok(r.skin.S_mech < 5, 'S_mech ' + r.skin.S_mech);
      assert.ok(!r.actions.some((a) => /strongly/i.test(a)), 'geometric skin does not trigger "strongly"');
      assert.includes(r.narrative, 'mechanical skin');
    },
  },
  {
    name: 'S_perf/S_global models are not decomposed twice',
    wp: 'WP3',
    run(app, assert) {
      const r = interp(app, 'partialPen', { Cd: 100, S_perf: 3, S_global: 0, KvKh: 0.1, hp_to_h: 0.3, zw_to_h: 0.5, h_eff: 1 }, {}, {
        geom: { h: 35, hp: 7, rw: 0.354, kvkh: 0.1 }, well: WELL });
      assert.near(r.skin.S_mech, 3, 1e-9, 'fitted perforation + global skin is already mechanical');
      assert.ok(r.actions.some((a) => /consider/i.test(a)));
    },
  },
  {
    name: 'I4. Tab 6 renders the interpretation card after an applied auto-match',
    wp: 'WP3', integration: true, timeoutMs: 180000,
    run(app, assert) {
      app.openPRiSM();
      const w = app.win;
      const res = w.PRiSM_autoMatchSync();
      w.PRiSM_applyAutoMatchRow(res.bestKey, res);
      const host = app.renderTab(6);
      // C7 panels mount in the sibling #prism_tab_6_panels (WP8), not inside #prism_tab_6.
      const panels = app.el('prism_tab_6_panels');
      const html = host.innerHTML + (panels ? panels.innerHTML : '');
      assert.includes(html, 'prism-interp');
      assert.includes(html, 'FE 76%');
    },
  },
];
