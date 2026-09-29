// WP7 — UI Tabs 2–6, plot dispatcher and state (04-ui-wiring.js).
//
// Unit tests run 04 against the git HEAD version of every other source file
// (new Round-8 files treated as missing), so they exercise 04 and its local
// fallbacks only. Where a test needs the C1 well store it installs a stub
// window.PRiSM_getWell with the default-sample values.
// Integration tests (integration:true) run against the current working tree and
// need WP1 (PTA core), WP2 (regression), WP4 (models) and WP8 (shell/sample).
'use strict';

const fs = require('fs');
const path = require('path');
const H = require('./_harness');

let _pins = null;
function pins() {
  if (_pins) return _pins;
  _pins = {};
  const dir = path.join(__dirname, '..');
  const names = new Set(fs.readdirSync(dir).filter((f) => /^(0\d|1\d|2\d|30|3[3-7])-[\w-]+\.js$/.test(f)));
  ['33-pta-core.js', '34-semilog-skin.js', '35-rta-dca.js', '36-report.js', '37-prism-workflow.js'].forEach((f) => names.add(f));
  for (const f of names) if (f !== '04-ui-wiring.js') _pins[f] = H.gitShowHead('prism-build/' + f);
  return _pins;
}
function iso(ctx, extra) { return ctx.loadApp(Object.assign({ sourceOverrides: pins() }, extra || {})); }

const SAMPLE_WELL = { fluid: 'oil', q: 850, B: 1.25, mu: 1.1, ct: 1.2e-5, h: 35, phi: 0.18, rw: 0.354, pi: 4200,
  T_R: 180, sg: 0.65, testType: 'drawdown', tp: null, tShut: null, pwf0: null, complete: true, missing: [], defaulted: [] };
const META = { pi: 4200, testType: 'drawdown', q: 850, Bo: 1.25, mu_o: 1.1, ct: 1.2e-5, h: 35, phi: 0.18, rw: 0.354, fluidType: 'oil' };
const A_TRUE = 104.78, B_TRUE = 39854;

function stubWell(app, over) {
  app.evalInApp('window.PRiSM_getWell = function () { return JSON.parse(' + JSON.stringify(JSON.stringify(Object.assign({}, SAMPLE_WELL, over || {}))) + '); };');
}
// Integration: make sure the sample well is in the C1 store (WP8 normally does this on seed).
function sampleWell(app) {
  const w = app.win;
  if (typeof w.PRiSM_setWell === 'function') w.PRiSM_setWell(app.toWin(w.PRiSM_DEFAULT_SAMPLE_META || META), app.toWin({ source: 'sample' }));
}
function spy(app, name) {
  const calls = [];
  const orig = app.win[name];
  app.win[name] = function (canvas, data, opts) {
    calls.push({ id: canvas && canvas.id, data, opts });
    return typeof orig === 'function' ? orig.apply(this, arguments) : undefined;
  };
  calls.last = (id) => { for (let i = calls.length - 1; i >= 0; i--) if (!id || calls[i].id === id) return calls[i]; return null; };
  return calls;
}
function lerpLog(x, xs, ys) {
  for (let i = 1; i < xs.length; i++) {
    if (xs[i] >= x && xs[i - 1] <= x) {
      const f = (Math.log(x) - Math.log(xs[i - 1])) / (Math.log(xs[i]) - Math.log(xs[i - 1]));
      return Math.exp(Math.log(ys[i - 1]) + f * (Math.log(ys[i]) - Math.log(ys[i - 1])));
    }
  }
  return NaN;
}
function median(a) { const s = a.filter((v) => isFinite(v)).sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]); }
function visibleCards(app) { return app.findAll('#prism_tab_3 .prism-model-card').filter((c) => c.style.display !== 'none'); }
function listenerCount(app, type) { const m = app.win.__listeners; return (m && m.get(type) ? m.get(type).length : 0); }
function withApp(ctx, extra, fn) {
  const app = iso(ctx, extra);
  return Promise.resolve().then(() => fn(app)).finally(() => { try { app.dispose(); } catch (_) { /* ignore */ } });
}

// Two-rate synthetic drawdown (homogeneous k 45, Cd 80, S 2.5): q 500 then 1000 from t = 10 h.
function twoRateDataset(app) {
  const pd = app.win.PRiSM_MODELS.homogeneous.pd;
  const t1 = []; for (let i = 0; i < 30; i++) t1.push(Math.pow(10, -2 + 3 * i / 29));
  const t2 = []; for (let i = 0; i < 30; i++) t2.push(10 + Math.pow(10, -2 + (Math.log10(20) + 2) * i / 29));
  const t = t1.concat(t2);
  const par = app.toWin({ Cd: 80, S: 2.5 });
  const unit = (tt) => (A_TRUE / 850) * pd(app.toWin([B_TRUE * tt]), par)[0];
  const p = t.map((tt) => 4200 - 500 * unit(tt) - (tt > 10 ? 500 * unit(tt - 10) : 0));
  const q = t.map((tt) => (tt <= 10 ? 500 : 1000));
  return { t, p, q };
}

module.exports = [
  // ───────────────────────────── unit ─────────────────────────────
  {
    name: 'exports, plot registry (mdh + both-mode support) and no timers from 04',
    wp: 'WP7', opts: false,
    run: (_a, assert, ctx) => withApp(ctx, null, (app) => {
      const w = app.win;
      ['PRiSM_drawActivePlot', 'PRiSM_buildPlotData', 'PRiSM_evalModelCurve', 'PRiSM_detectPeriods', 'PRiSM_setModel',
        'PRiSM_registerPostDrawHook', 'PRiSM_autoAlignOverlay', 'PRiSM_modelDisplayName', 'PRiSM_renderFitResults',
        'PRiSM_renderPlotsTab', 'PRiSM_renderModelTab', 'PRiSM_renderParamsTab', 'PRiSM_renderMatchTab', 'PRiSM_renderRegressTab']
        .forEach((n) => assert.fn(w[n], n));
      const reg = w.PRiSM_PLOT_REGISTRY;
      assert.ok(reg && reg.bourdet && reg.mdh && reg.rateLog, 'registry has bourdet, mdh, rateLog');
      assert.equal(reg.mdh.mode, 'transient');
      assert.ok(Array.isArray(w.PRiSM_postDrawHooks), 'postDrawHooks is an array');
      const src04 = fs.readFileSync(path.join(__dirname, '..', '04-ui-wiring.js'), 'utf8');
      ['PRiSM_renderReportTab', 'PRiSM_buildReportHTML', 'PRiSM_exportCSV', 'PRiSM_installSetTabHook', 'setInterval']
        .forEach((n) => assert.equal(src04.indexOf(n), -1, n + ' no longer lives in 04'));
      // 'both' entries show in every mode.
      w.PRiSM_PLOT_REGISTRY.wp7both = { fn: 'PRiSM_plot_cartesian', label: 'WP7 both-mode probe', mode: 'both' };
      app.openPRiSM();
      for (const m of ['transient', 'decline', 'combined']) {
        w.PRiSM.mode = m;
        app.renderTab(2);
        const opts = app.findAll('#prism_plot_picker option').map((o) => o.value);
        assert.ok(opts.indexOf('wp7both') !== -1, 'both-mode plot listed in ' + m);
        assert.equal(opts.indexOf('rateLog') !== -1, m !== 'transient', 'rate plots listed only outside transient (' + m + ')');
      }
      app.flush(5000);
      const mine = app.timers().filter((t) => /04-ui-wiring/.test(t.where || ''));
      assert.equal(mine.length, 0, 'no pending timers created by 04: ' + mine.map((t) => t.where).join(' / '));
    }),
  },
  {
    name: 'post-draw hooks run exactly once per draw with {canvas, plotKey, data, opts, axes}',
    wp: 'WP7', opts: false,
    run: (_a, assert, ctx) => withApp(ctx, null, (app) => {
      stubWell(app);
      app.openPRiSM();
      app.flush(1000);                                    // let any legacy wrappers install
      app.gotoTab(2);
      const seen = [];
      app.win.PRiSM_postDrawHooks.push(function (info) { seen.push(info); });
      const ok = app.win.PRiSM_drawActivePlot();
      assert.equal(ok, true);
      assert.equal(seen.length, 1, 'hook ran once');
      assert.equal(seen[0].plotKey, 'bourdet');
      assert.equal(seen[0].canvas.id, 'prism_plot_canvas');
      assert.equal(seen[0].data.dp.length, 55);
      assert.ok(seen[0].axes && seen[0].axes.scaleX, 'axes passed');
      assert.equal(seen[0].opts.smoothL, 0.15);
      // A throwing hook never breaks the draw.
      app.win.PRiSM_postDrawHooks.push(function () { throw new Error('boom'); });
      assert.equal(app.win.PRiSM_drawActivePlot(), true);
      assert.equal(seen.length, 2);
    }),
  },
  {
    name: 'Tab 2 Bourdet receives C6 data: 55 positive sign-aware Δp from pi, derivative plateau 52.4, ds.dp untouched, L control',
    wp: 'WP7', opts: false,
    run: (_a, assert, ctx) => withApp(ctx, null, (app) => {
      stubWell(app);
      app.openPRiSM();
      const calls = spy(app, 'PRiSM_plot_bourdet');
      app.gotoTab(2);
      const c = calls.last('prism_plot_canvas');
      assert.ok(c, 'bourdet plot called on the main canvas');
      const d = c.data;
      assert.equal(d.dp.length, 55);
      assert.ok(d.dp.every((v) => v > 0), 'all 55 Δp positive');
      assert.near(d.dp[0], 338.6, 0.5, 'Δp(t0) from pi');
      assert.near(d.dp[54], 1110.2, 0.5, 'Δp(120 h)');
      const late = d.deriv.filter((v, i) => d.t[i] >= 10);
      assert.near(median(late), 52.4, 1.0, 'late derivative median');
      assert.equal(app.win.PRiSM_dataset.dp, undefined, 'dataset not mutated');
      assert.equal(app.el('prism_plot_bourdet_btn'), null, 'no "Compute Bourdet" button');
      assert.equal(c.opts.smoothL, 0.15);
      app.input('prism_plot_L', '0.3');
      assert.equal(app.win.PRiSM_state.bourdetL, 0.3);
      assert.equal(calls.last('prism_plot_canvas').opts.smoothL, 0.3);
      app.input('prism_plot_L', '0.9');
      assert.equal(app.win.PRiSM_state.bourdetL, 0.5, 'L clamped to 0.5');
      // Auto L uses 15's picker and writes st.bourdetL.
      app.click('prism_plot_autoL');
      assert.ok(app.win.PRiSM_state.bourdetL >= 0 && app.win.PRiSM_state.bourdetL <= 0.5);
      // Plot picker change emits prism:plot-changed.
      app.evalInApp("window.__pc = []; window.addEventListener('prism:plot-changed', function (e) { window.__pc.push(e.detail.plotKey); });");
      app.select('prism_plot_picker', 'cartesian');
      assert.deepEqual(Array.from(app.win.__pc), ['cartesian']);
    }),
  },
  {
    name: 'physical model overlay reproduces the sample: Δp(120 h) = 1110.2, late Δp′ = 52.4',
    wp: 'WP7', opts: false,
    run: (_a, assert, ctx) => withApp(ctx, null, (app) => {
      stubWell(app);
      app.openPRiSM();
      const st = app.win.PRiSM_state;
      st.model = 'homogeneous';
      st.phys = app.toWin({ k: 45, C: 8.48e-4, S: 2.5 });
      st.modelCurveData = null;
      const calls = spy(app, 'PRiSM_plot_bourdet');
      app.gotoTab(2);
      const ov = calls.last('prism_plot_canvas').data.overlay;
      assert.ok(ov && ov.dp && ov.deriv, 'overlay present');
      assert.equal(st.modelCurveData.mode, 'physical');
      assert.near(lerpLog(120, ov.t, ov.dp), 1110.2, 1.0, 'overlay Δp at 120 h');
      const late = ov.deriv.filter((v, i) => ov.t[i] >= 50 && ov.t[i] <= 120);
      assert.ok(late.length > 3);
      late.forEach((v) => assert.near(v, 52.4, 0.5, 'late overlay derivative'));
      assert.near(st.modelCurveData.params.Cd, 79.98, 0.2, 'curve Cd from C');
      assert.deepEqual(JSON.parse(JSON.stringify(st.params)), { Cd: 100, S: 0 }, 'drawing never rewrites st.params');
      // Cartesian overlay is in absolute pressure.
      const cc = spy(app, 'PRiSM_plot_cartesian');
      app.select('prism_plot_picker', 'cartesian');
      const hov = cc.last('prism_plot_canvas').data.overlay;
      assert.near(lerpLog(120, hov.t, hov.p), 4200 - 1110.2, 1.0, 'history overlay p(120 h)');
    }),
  },
  {
    name: 'Tab 3 library: card counts 45 / 41 / 4 by mode; selected hidden model still rendered',
    wp: 'WP7', opts: false,
    run: (_a, assert, ctx) => withApp(ctx, null, (app) => {
      app.openPRiSM();
      const total = Object.keys(app.win.PRiSM_MODELS).length;
      const counts = {};
      for (const m of ['combined', 'transient', 'decline']) {
        app.win.PRiSM.mode = m;
        app.renderTab(3);
        counts[m] = app.findAll('#prism_tab_3 .prism-model-card').length;
      }
      assert.equal(counts.combined, total);
      assert.equal(total, 45, 'registry has 45 models');
      assert.equal(counts.transient, 41);
      assert.equal(counts.decline, 4);
      const keys = app.findAll('#prism_tab_3 .prism-model-card').map((c) => c.getAttribute('data-prism-model')).sort();
      assert.deepEqual(keys, ['arps', 'duong', 'fetkovich', 'sepd']);
      const sel = app.el('prism_model_selected');
      assert.ok(sel, 'selected model detail rendered');
      assert.equal(sel.getAttribute('data-prism-model'), 'homogeneous');
      assert.includes(sel.textContent, 'hides it');
      // Schematic thumbnails come from the registry schematics.
      app.win.PRiSM.mode = 'combined';
      app.renderTab(3);
      const thumbs = app.findAll('#prism_tab_3 .prism-model-card .prism-thumb svg').length;
      assert.equal(thumbs, 45, 'every card has a schematic thumbnail');
      // Categories: chips built from the registry, known order first.
      const cats = app.findAll('#prism_model_chips .prism-chip').map((c) => c.getAttribute('data-prism-cat'));
      assert.equal(cats[0], 'all');
      assert.equal(cats[1], 'homogeneous');
      assert.ok(cats.indexOf('decline') > cats.indexOf('boundary'));
    }),
  },
  {
    name: 'Tab 3 search + category chips filter in place; card click sets defaults, defaultFrozen, stale lastFit and fires prism:model-changed',
    wp: 'WP7', opts: false,
    run: (_a, assert, ctx) => withApp(ctx, null, (app) => {
      app.openPRiSM();
      app.win.PRiSM.mode = 'transient';
      app.win.PRiSM_MODELS.horizontal.defaultFrozen = app.toWin(['S_global']);
      app.win.PRiSM_state.lastFit = app.toWin({ modelKey: 'homogeneous', r2: 0.99 });
      app.renderTab(3);
      app.input('prism_model_search', 'fault');
      const vis = visibleCards(app);
      assert.ok(vis.length > 0 && vis.length < 41, 'search narrows the list (' + vis.length + ')');
      vis.forEach((c) => assert.includes(c.getAttribute('data-prism-search'), 'fault'));
      assert.includes(app.el('prism_model_count').textContent, 'of 41');
      app.input('prism_model_search', '');
      app.click(app.find('#prism_model_chips [data-prism-cat="boundary"]'));
      const vb = visibleCards(app);
      assert.ok(vb.length >= 5);
      vb.forEach((c) => assert.equal(c.getAttribute('data-prism-cat'), 'boundary'));
      app.click(app.find('#prism_model_chips [data-prism-cat="all"]'));
      assert.equal(visibleCards(app).length, 41);
      app.evalInApp("window.__mc = []; window.addEventListener('prism:model-changed', function (e) { window.__mc.push(e.detail.model); });");
      app.click(app.find('#prism_tab_3 .prism-model-card[data-prism-model="horizontal"]'));
      const st = app.win.PRiSM_state;
      assert.equal(st.model, 'horizontal');
      assert.deepEqual(Array.from(app.win.__mc), ['horizontal']);
      assert.equal(st.paramFreeze.S_global, true, 'defaultFrozen applied');
      const defs = app.win.PRiSM_MODELS.horizontal.defaults;
      Object.keys(defs).forEach((k) => assert.equal(st.params[k], defs[k], 'default ' + k));
      assert.equal(st.lastFit.stale, true, 'lastFit marked stale');
      assert.ok(app.find('#prism_tab_3 .prism-model-card.is-selected[data-prism-model="horizontal"]'), 'selection highlighted after re-render');
      assert.equal(app.el('prism_model_selected').getAttribute('data-prism-model'), 'horizontal');
    }),
  },
  {
    name: 'Tab 3 Recommended strip from auto-match results: ΔAIC, convergence badges, thumbnails, Use applies the row',
    wp: 'WP7', opts: false,
    run: (_a, assert, ctx) => withApp(ctx, null, (app) => {
      stubWell(app);
      app.openPRiSM();
      const st = app.win.PRiSM_state;
      st.autoMatch = app.toWin({
        bestKey: 'homogeneous',
        ranked: [
          { modelKey: 'homogeneous', AIC: -500, R2: 0.99995, converged: true, params: { Cd: 80, S: 2.5 }, phys: { k: 45, C: 8.48e-4, S: 2.5 }, scales: { A: A_TRUE, B: B_TRUE } },
          { modelKey: 'radialComposite', AIC: -496.8, R2: 0.9991, converged: false, params: { Cd: 80, S: 2.5, M: 1, F: 1, R: 1000 } },
          { modelKey: 'linearBoundary', aic: -480, r2: 0.998, converged: true, dAIC: 20 },
        ],
      });
      app.renderTab(3);
      const strip = app.el('prism_model_recommended');
      assert.ok(strip);
      assert.equal(strip.getAttribute('data-prism-rec-count'), '3');
      const txt = strip.textContent;
      assert.includes(txt, 'ΔAIC');
      assert.includes(txt, '0.0');
      assert.includes(txt, '3.2');
      assert.includes(txt, '20.0');
      assert.includes(txt, 'converged');
      assert.includes(txt, 'starting point, refine');
      assert.includes(txt, 'Homogeneous reservoir');
      assert.equal(app.findAll('#prism_model_recommended .prism-thumb svg').length, 3);
      app.click(app.find('#prism_model_recommended .prism-rec-use[data-prism-model="homogeneous"]'));
      assert.equal(st.model, 'homogeneous');
      assert.equal(st.lastFit.source, 'automatch');
      assert.near(st.phys.k, 45, 1e-9);
      assert.near(st.tcMatch.logTM, Math.log10(B_TRUE), 1e-9);
      assert.deepEqual(JSON.parse(JSON.stringify(st.match)), { timeShift: 0, pressShift: 0 });
      // Empty state offers a ranking action when auto-match is available.
      st.autoMatch = null;
      app.renderTab(3);
      assert.equal(app.el('prism_model_recommended').getAttribute('data-prism-rec-count'), '0');
      assert.ok(app.el('prism_model_findbest'), 'Find best models button');
      // A ranking finished elsewhere (e.g. Analyse) refreshes only the strip.
      app.input('prism_model_search', 'frac');
      const searchEl = app.el('prism_model_search');
      st.autoMatch = app.toWin({ ranked: [{ modelKey: 'infiniteFrac', aic: -10, r2: 0.99, converged: true }] });
      app.fire('window', 'prism:automatch-updated', {});
      assert.equal(app.el('prism_model_recommended').getAttribute('data-prism-rec-count'), '1');
      assert.equal(app.el('prism_model_search'), searchEl, 'search box untouched');
      assert.equal(searchEl.value, 'frac');
      app.click(app.find('#prism_model_recommended .prism-rec-use[data-prism-model="infiniteFrac"]'));
      assert.equal(st.model, 'infiniteFrac');
    }),
  },
  {
    name: 'Tab 4 dimensionless preview plots dp == pD, deriv == pD′, and the range reaches pD′ < 0.52 (Cd 100, S 0)',
    wp: 'WP7', opts: false,
    run: (_a, assert, ctx) => withApp(ctx, null, (app) => {
      app.openPRiSM();
      const st = app.win.PRiSM_state;
      st.model = 'homogeneous';
      st.params = app.toWin({ Cd: 100, S: 0 });
      st.paramUnits = 'dimensionless';
      const calls = spy(app, 'PRiSM_plot_bourdet');
      app.renderTab(4);
      const c = calls.last('prism_params_canvas');
      assert.ok(c, 'preview drawn');
      const d = c.data;
      assert.near(d.t[0], 1e-3, 1e-12);
      assert.near(d.t[d.t.length - 1], 6e5, 1);
      const M = app.win.PRiSM_MODELS.homogeneous;
      const idx = [0, 20, 60, 100, d.t.length - 1];
      const td = app.toWin(idx.map((i) => d.t[i]));
      const pd = M.pd(td, app.toWin({ Cd: 100, S: 0 }));
      const pdp = M.pdPrime(td, app.toWin({ Cd: 100, S: 0 }));
      idx.forEach((i, j) => { assert.rel(d.dp[i], pd[j], 1e-12, 'dp == pD at ' + i); assert.rel(d.deriv[i], pdp[j], 1e-12, 'deriv == pD′ at ' + i); });
      const lastDeriv = d.deriv[d.deriv.length - 1];
      assert.ok(lastDeriv < 0.52 && lastDeriv > 0.48, 'late pD′ = ' + lastDeriv);
      assert.equal(c.opts.xLabel, 'tD');
      assert.ok(app.el('prism_p_Cd') && app.el('prism_p_S'), 'dimensionless inputs');
      assert.equal(app.el('prism_tab_4').textContent.indexOf('Phase 3'), -1, 'no stale Phase 3 text');
      app.input('prism_p_S', '5');
      assert.equal(st.params.S, 5);
      const d2 = calls.last('prism_params_canvas').data;
      assert.ok(d2.t[d2.t.length - 1] > 6e5, 'range grows with S');
    }),
  },
  {
    name: 'Tab 4 physical inputs (k md, C bbl/psi with CD, S) drive st.phys, st.params and a data+model preview',
    wp: 'WP7', opts: false,
    run: (_a, assert, ctx) => withApp(ctx, null, (app) => {
      stubWell(app);
      app.openPRiSM();
      const st = app.win.PRiSM_state;
      st.paramUnits = 'auto';
      const calls = spy(app, 'PRiSM_plot_bourdet');
      app.renderTab(4);
      assert.ok(app.el('prism_phys_k') && app.el('prism_phys_C') && app.el('prism_phys_S'), 'physical inputs rendered');
      assert.equal(app.el('prism_phys_pi'), null, 'pi hidden unless estimated');
      app.input('prism_phys_k', '45');
      app.input('prism_phys_C', '0.000848');
      app.input('prism_phys_S', '2.5');
      assert.equal(st.phys.k, 45);
      assert.equal(st.phys.C, 0.000848);
      assert.equal(st.phys.S, 2.5);
      assert.near(st.params.Cd, 79.98, 0.2);
      assert.includes(app.el('prism_phys_Cd_readout').textContent, '79.9');
      const c = calls.last('prism_params_canvas');
      assert.equal(c.data.dp.length, 55, 'data in the preview');
      assert.near(lerpLog(120, c.data.overlay.t, c.data.overlay.dp), 1110.2, 1.0);
      assert.includes(app.el('prism_tab_4').textContent, 'md');
      // Freeze writes to state (and aliases C ↔ Cd).
      app.check('prism_pfz_C', true);
      assert.equal(st.paramFreeze.C, true);
      assert.equal(st.paramFreeze.Cd, true);
    }),
  },
  {
    name: 'Tab 5 at the truth: RMSE(log Δp) < 0.005; Apply → k 45.0, S 2.50, C 8.48e-4; st.match untouched',
    wp: 'WP7', opts: false,
    run: (_a, assert, ctx) => withApp(ctx, null, (app) => {
      stubWell(app);
      app.openPRiSM();
      const st = app.win.PRiSM_state;
      st.model = 'homogeneous';
      st.params = app.toWin({ Cd: 80, S: 2.5 });
      st.tcMatch = app.toWin({ logPM: Math.log10(1 / A_TRUE), logTM: Math.log10(B_TRUE), source: 'test' });
      app.renderTab(5);
      const rmse = parseFloat(app.el('prism_match_rmse_dp').textContent);
      assert.ok(rmse < 0.005, 'RMSE log Δp = ' + rmse);
      assert.includes(app.el('prism_match_k').textContent, 'md');
      app.click('prism_match_apply');
      assert.near(st.phys.k, 45, 0.5);
      assert.near(st.phys.S, 2.5, 0.05);
      assert.rel(st.phys.C, 8.48e-4, 0.01);
      assert.equal(st.lastFit.source, 'match');
      assert.near(st.lastFit.phys.k, 45, 0.5);
      assert.ok(st.lastFit.rmse < 1, 'psi RMSE ' + st.lastFit.rmse);
      assert.deepEqual(JSON.parse(JSON.stringify(st.match)), { timeShift: 0, pressShift: 0 });
      assert.includes(app.el('prism_match_msg').textContent, 'Match applied');
      // Same physical answer from an equivalent (Cd, S, TM) triple.
      st.params = app.toWin({ Cd: 800, S: 2.5 - 0.5 * Math.LN10 });
      st.tcMatch = app.toWin({ logPM: Math.log10(1 / A_TRUE), logTM: Math.log10(B_TRUE) + 1 });
      app.renderTab(5);
      app.click('prism_match_apply');
      assert.near(st.phys.k, 45, 0.5);
      assert.near(st.phys.S, 2.5, 0.05);
      assert.near(st.params.Cd, 80, 0.5);
    }),
  },
  {
    name: 'Tab 5 arrows move the overlay by exactly 0.05 decade; auto-align recovers the truth',
    wp: 'WP7', opts: false,
    run: (_a, assert, ctx) => withApp(ctx, null, (app) => {
      stubWell(app);
      app.openPRiSM();
      const st = app.win.PRiSM_state;
      st.model = 'homogeneous';
      st.params = app.toWin({ Cd: 80, S: 2.5 });
      st.tcMatch = app.toWin({ logPM: Math.log10(1 / A_TRUE), logTM: Math.log10(B_TRUE) });
      const calls = spy(app, 'PRiSM_plot_bourdet');
      app.renderTab(5);
      const o0 = calls.last('prism_match_canvas');
      assert.equal(o0.opts.dragZoom, false, 'drag-zoom off on the match canvas');
      const a = o0.data.overlay;
      app.click('prism_match_up');
      const b = calls.last('prism_match_canvas').data.overlay;
      for (let i = 0; i < a.dp.length; i += 17) {
        assert.rel(b.dp[i] / a.dp[i], Math.pow(10, 0.05), 1e-9, 'Δp up 0.05 decade');
        assert.rel(b.t[i], a.t[i], 1e-12);
      }
      app.click('prism_match_right');
      const c = calls.last('prism_match_canvas').data.overlay;
      for (let i = 0; i < c.t.length; i += 17) assert.rel(c.t[i] / b.t[i], Math.pow(10, 0.05), 1e-9, 't right 0.05 decade');
      app.click('prism_match_down');
      app.click('prism_match_left');
      assert.near(st.tcMatch.logPM, Math.log10(1 / A_TRUE), 1e-12);
      assert.near(st.tcMatch.logTM, Math.log10(B_TRUE), 1e-12);
      // Auto-align from a poor start lands on the truth.
      st.tcMatch = app.toWin({ logPM: -1, logTM: 2 });
      app.click('prism_match_auto');
      assert.near(st.tcMatch.logPM, Math.log10(1 / A_TRUE), 0.02);
      assert.near(st.tcMatch.logTM, Math.log10(B_TRUE), 0.05);
    }),
  },
  {
    name: 'Tab 5 drag uses Pointer Events; three renders leave no window listeners behind',
    wp: 'WP7', opts: false,
    run: (_a, assert, ctx) => withApp(ctx, null, (app) => {
      stubWell(app);
      app.openPRiSM();
      const st = app.win.PRiSM_state;
      st.model = 'homogeneous';
      st.params = app.toWin({ Cd: 80, S: 2.5 });
      st.tcMatch = app.toWin({ logPM: Math.log10(1 / A_TRUE), logTM: Math.log10(B_TRUE) });
      const base = { pm: listenerCount(app, 'pointermove'), mm: listenerCount(app, 'mousemove'), pu: listenerCount(app, 'pointerup') };
      app.renderTab(5); app.renderTab(5); app.renderTab(5);
      assert.equal(listenerCount(app, 'pointermove'), base.pm, 'no idle pointermove listeners');
      assert.equal(listenerCount(app, 'mousemove'), base.mm, 'no window mousemove listeners');
      const cv = app.el('prism_match_canvas');
      assert.ok(cv._prismAxes && cv._prismAxes.plot, 'axes stashed by the plot');
      const W = app.win;
      cv.dispatchEvent(new W.PointerEvent('pointerdown', { clientX: 200, clientY: 150, bubbles: true, pointerId: 7 }));
      assert.equal(listenerCount(app, 'pointermove'), base.pm + 1, 'exactly one window pointermove listener while dragging');
      const logTM0 = st.tcMatch.logTM, logPM0 = st.tcMatch.logPM;
      W.dispatchEvent(new W.PointerEvent('pointermove', { clientX: 260, clientY: 190, pointerId: 7 }));
      const ax = cv._prismAxes;
      const dpx = (Math.log10(ax.scaleX.max) - Math.log10(ax.scaleX.min)) / ax.plot.w;
      const dpy = (Math.log10(ax.scaleY.max) - Math.log10(ax.scaleY.min)) / ax.plot.h;
      assert.near(st.tcMatch.logTM, logTM0 - 60 * dpx, 1e-9, 'right drag lowers log TM (curve moves right)');
      assert.near(st.tcMatch.logPM, logPM0 + 40 * dpy, 1e-9, 'down drag raises log PM (curve moves down)');
      W.dispatchEvent(new W.PointerEvent('pointerup', { clientX: 260, clientY: 190, pointerId: 7 }));
      assert.equal(listenerCount(app, 'pointermove'), base.pm, 'listener removed on pointerup');
      assert.equal(listenerCount(app, 'pointerup'), base.pu);
      // Re-render mid-drag also cleans up.
      app.el('prism_match_canvas').dispatchEvent(new W.PointerEvent('pointerdown', { clientX: 10, clientY: 10, bubbles: true }));
      app.renderTab(5);
      assert.equal(listenerCount(app, 'pointermove'), base.pm, 'render ends any drag');
    }),
  },
  {
    name: 'Tab 6 run: options passed, green status, field-unit results with CI in md; failures restore params; st.match untouched',
    wp: 'WP7', opts: false,
    run: (_a, assert, ctx) => withApp(ctx, null, (app) => {
      stubWell(app);
      app.openPRiSM();
      const st = app.win.PRiSM_state;
      app.flush(1000);
      const legacy = app.win.PRiSM_runRegression;
      app.evalInApp(
        'window.PRiSM_runRegression = function (opts) {' +
        '  window.__regOpts = JSON.parse(JSON.stringify(opts));' +
        '  var f = { modelKey: "homogeneous", kind: "pressure", source: "regression", converged: true, r2: 0.99999, rmse: 0.31, aic: -120.5, iterations: 7,' +
        '    params: { Cd: 79.9, S: 2.501 }, phys: { k: 45.01, kh: 1575.3, C: 8.47e-4, Cd: 79.9, S: 2.501, rinv: 1548 },' +
        '    ci95: { k: [44.91, 45.11], S: [2.491, 2.511] }, identifiable: { k: true, S: true, C: false } };' +
        '  window.PRiSM_state.params = f.params; window.PRiSM_state.phys = f.phys; window.PRiSM_state.lastFit = f; return f; };');
      app.renderTab(6);
      app.input('prism_reg_tmin', '0.5');
      app.select('prism_reg_objective', 'dp');
      app.check('prism_reg_floatpi', true);
      app.click('prism_regress_run');
      app.flush(100);
      const o = app.win.__regOpts;
      assert.equal(o.window.tmin, 0.5);
      assert.equal(o.objective, 'dp');
      assert.equal(o.floatPi, true);
      assert.equal(app.el('prism_regress_status').getAttribute('data-prism-status'), 'ok');
      assert.includes(app.el('prism_regress_status').textContent, 'converged');
      const res = app.el('prism_regress_results').textContent;
      assert.includes(res, 'md');
      assert.includes(res, '45.0');
      assert.includes(res, '2.50');
      assert.includes(res, '± 0.10');
      assert.includes(res, 'not identifiable');
      assert.deepEqual(JSON.parse(JSON.stringify(st.match)), { timeShift: 0, pressShift: 0 });
      assert.ok(app.canvasLog('prism_regress_plot').length > 0, 'data+model mini plot drawn');
      assert.ok(app.canvasLog('prism_regress_resid').length > 0, 'residual plot drawn');
      // A failed fit that clobbers params is rolled back and shown red.
      const before = JSON.stringify(st.params);
      app.evalInApp('window.PRiSM_runRegression = function () { window.PRiSM_state.params = { Cd: 6.8e-11, S: 50 }; return { source: "regression", converged: false, r2: -287, params: { Cd: 6.8e-11, S: 50 } }; };');
      app.click('prism_regress_run');
      app.flush(100);
      assert.equal(app.el('prism_regress_status').getAttribute('data-prism-status'), 'bad');
      assert.equal(JSON.stringify(st.params), before, 'params restored after a failed fit');
      // The original engine: with the legacy (HEAD 05) fitter a bad fit is never shown green, and
      // no engine can write st.match.
      app.win.PRiSM_runRegression = legacy;
      app.click('prism_regress_run');
      app.flush(100);
      if (typeof app.win.PRiSM_fitPhysical !== 'function') assert.notEqual(app.el('prism_regress_status').getAttribute('data-prism-status'), 'ok');
      assert.deepEqual(JSON.parse(JSON.stringify(st.match)), { timeShift: 0, pressShift: 0 });
    }),
  },
  {
    name: 'periods: two-rate synthetic — period picker re-zeroes Δt and changes the Bourdet data; >20 steps hides the picker',
    wp: 'WP7', opts: false,
    run: (_a, assert, ctx) => withApp(ctx, null, (app) => {
      stubWell(app, { testType: 'auto' });
      app.openPRiSM();
      const ds = twoRateDataset(app);
      app.win.PRiSM_dataset = app.toWin(ds);
      const per = app.win.PRiSM_detectPeriods(app.toWin(ds.t), app.toWin(ds.q));
      assert.equal(per.length, 2);
      ['t0', 't1', 'start', 'end', 'q'].forEach((k) => assert.ok(k in per[0], 'period has ' + k));
      assert.equal(per[1].q, 1000);
      const calls = spy(app, 'PRiSM_plot_bourdet');
      app.renderTab(2);
      const sel = app.el('prism_plot_period');
      assert.ok(sel, 'period picker shown');
      assert.equal(sel.options.length, 3);
      app.evalInApp("window.__per = []; window.addEventListener('prism:period-changed', function (e) { window.__per.push(e.detail.period); });");
      app.select('prism_plot_period', '0');
      const d0 = calls.last('prism_plot_canvas').data;
      app.select('prism_plot_period', '1');
      const d1 = calls.last('prism_plot_canvas').data;
      assert.equal(app.win.PRiSM_state.activePeriod, 1);
      assert.deepEqual(Array.from(app.win.__per), [0, 1]);
      assert.equal(d0.t.length, 30);
      assert.equal(d1.t.length, 30);
      assert.ok(d1.t[0] < 0.1, 'period 1 Δt re-zeroed (t0 = ' + d1.t[0] + ')');
      assert.ok(d1.dp.every((v) => v > 0), 'period 1 Δp positive');
      assert.notDeepEqual(Array.from(d0.dp), Array.from(d1.dp));
      // Variable rate → no picker.
      const t = [], p = [], q = [];
      for (let i = 0; i < 60; i++) { t.push(0.1 * (i + 1)); p.push(4000 - i); q.push(500 + 10 * i); }
      app.win.PRiSM_dataset = app.toWin({ t, p, q });
      app.renderTab(2);
      assert.equal(app.el('prism_plot_period'), null, 'no picker for a continuously varying rate');
      assert.includes(app.el('prism_plot_notes').textContent, 'Rate changes');
    }),
  },
  {
    name: 'decline mode: rate plots in days with the model overlay; combined mode keeps rate plots; transient snaps back',
    wp: 'WP7', opts: false,
    run: (_a, assert, ctx) => withApp(ctx, null, (app) => {
      app.openPRiSM();
      const w = app.win;
      const t = [], q = [];
      for (let d = 1; d <= 365; d++) { t.push(24 * d); q.push(1000 * Math.pow(1 + 0.5 * 0.01 * d, -1 / 0.5)); }
      w.PRiSM_dataset = app.toWin({ t, p: null, q });
      w.PRiSM.mode = 'decline';
      const st = w.PRiSM_state;
      st.model = 'arps';
      st.params = app.toWin({ qi: 1000, Di: 0.01, b: 0.5 });
      st.modelCurveData = null;
      st.activePlot = 'rateLog';
      const calls = spy(app, 'PRiSM_plot_rate_time_loglog');
      app.renderTab(2);
      const c = calls.last('prism_plot_canvas');
      assert.ok(c, 'rate log-log plotted');
      assert.near(c.data.t[0], 1, 1e-12, 'time in days');
      assert.equal(c.opts.timeUnit, 'd');
      assert.ok(c.data.overlay && c.data.overlay.q && c.data.overlay.q.length > 10, 'decline overlay drawn');
      assert.near(c.data.overlay.t[c.data.overlay.t.length - 1], 365 + 2 * 364, 1e-6, 'forecast horizon = 2 × span');
      assert.rel(lerpLog(100, c.data.overlay.t, c.data.overlay.q), 1000 / Math.pow(1.5, 2), 1e-3);
      w.PRiSM.mode = 'combined';
      st.activePlot = 'rateCum';
      app.renderTab(2);
      assert.equal(st.activePlot, 'rateCum', 'combined mode never snaps a valid plot');
      w.PRiSM.mode = 'transient';
      app.renderTab(2);
      assert.equal(st.activePlot, 'bourdet', 'transient mode snaps a rate plot back to bourdet');
      // Tab 3 / Tab 4 for a rate model.
      w.PRiSM.mode = 'decline';
      app.renderTab(4);
      assert.ok(app.el('prism_p_qi') && app.el('prism_p_Di'));
      assert.includes(app.el('prism_tab_4').textContent, '1/day');
    }),
  },
  {
    name: 'every registered plot draws through PRiSM_drawActivePlot without errors (pressure sample and rate data)',
    wp: 'WP7', opts: false,
    run: (_a, assert, ctx) => withApp(ctx, null, (app) => {
      stubWell(app, { tp: 24 });
      app.openPRiSM();
      const w = app.win;
      const st = w.PRiSM_state;
      w.PRiSM.mode = 'combined';
      app.renderTab(2);
      const keys = Object.keys(w.PRiSM_PLOT_REGISTRY).filter((k) => !w.PRiSM_PLOT_REGISTRY[k].build);
      const run = (label) => keys.forEach((k) => {
        st.activePlot = k;
        const nErr = app.errors.length, nCon = app.consoleErrors().length;
        w.PRiSM_drawActivePlot();
        assert.equal(app.errors.length, nErr, label + ' ' + k + ' threw');
        assert.equal(app.consoleErrors().length, nCon, label + ' ' + k + ' logged an error');
        assert.ok(app.canvasLog('prism_plot_canvas').length > 0, label + ' ' + k + ' drew');
        const b = w.PRiSM_buildPlotData(k);
        assert.ok(b && (b.data || b.error), label + ' ' + k + ' built');
        if (b.data && b.data.dp) assert.ok(b.data.dp.every((v) => typeof v === 'number'), 'dp numeric');
      });
      run('pressure');
      const t = [], q = [];
      for (let d = 1; d <= 100; d++) { t.push(24 * d); q.push(800 * Math.exp(-0.01 * d)); }
      w.PRiSM_dataset = app.toWin({ t, p: null, q });
      w.PRiSM_setModel('arps');
      run('rate');
    }),
  },
  {
    name: 'phone width (375 px): tabs 2–6 render with no fixed widths beyond the viewport and scrollable tables',
    wp: 'WP7', opts: false,
    run: (_a, assert, ctx) => withApp(ctx, { viewport: { width: 375, height: 812 } }, (app) => {
      stubWell(app);
      app.openPRiSM();
      app.win.PRiSM_state.autoMatch = app.toWin({ ranked: [{ modelKey: 'homogeneous', AIC: -1, R2: 0.99, converged: true }] });
      const px = (v) => { const m = /^\s*([\d.]+)px\s*$/.exec(v || ''); return m ? parseFloat(m[1]) : null; };
      for (let n = 2; n <= 6; n++) {
        app.renderTab(n);
        const host = app.el('prism_tab_' + n);
        const all = [host].concat(Array.from(host.querySelectorAll('*')));
        all.forEach((el) => {
          ['width', 'minWidth'].forEach((prop) => {
            const v = px(el.style && el.style[prop]);
            if (v != null) assert.ok(v <= 375, 'tab ' + n + ' <' + el.localName + ' id=' + el.id + '> ' + prop + ' ' + v + 'px');
          });
        });
        Array.from(host.querySelectorAll('table.dtable')).forEach((tb) => {
          assert.ok(tb.closest('.prism-scroll-x'), 'tab ' + n + ' table ' + (tb.id || '') + ' is inside a horizontal scroller');
        });
        Array.from(host.querySelectorAll('canvas')).forEach((cv) => {
          const h = px(cv.style.height);
          assert.ok(h != null && h <= 0.75 * 343 + 1, 'tab ' + n + ' canvas ' + cv.id + ' height ' + h + ' fits a 4:3 phone plot');
        });
      }
    }),
  },
  {
    name: 'rendering tabs 2–6, drawing and evalModelCurve never change the analysis state (undo-safe)',
    wp: 'WP7', opts: false,
    run: (_a, assert, ctx) => withApp(ctx, null, (app) => {
      stubWell(app);
      app.openPRiSM();
      const st = app.win.PRiSM_state;
      const snap = () => JSON.stringify({ model: st.model, params: st.params, phys: st.phys, tcMatch: st.tcMatch || null,
        lastFit: st.lastFit || null, paramFreeze: st.paramFreeze, fitOpts: st.fitOpts });
      for (const units of ['auto', 'dimensionless']) {
        st.paramUnits = units;
        const before = snap();
        for (let n = 2; n <= 6; n++) app.renderTab(n);
        app.win.PRiSM_drawActivePlot();
        app.win.PRiSM_evalModelCurve(st.model, st.params);
        app.win.PRiSM_buildPlotData('bourdet');
        app.win.PRiSM_buildPlotData('cartesian');
        app.fire('window', 'prism:well-changed', {});
        app.fire('window', 'prism:dataset-loaded', {});
        assert.equal(snap(), before, 'state unchanged (' + units + ')');
      }
      // A user edit is a commit: the whole displayed physical set is stored consistently.
      st.paramUnits = 'auto';
      app.renderTab(4);
      const shownC = parseFloat(app.el('prism_phys_C').value);
      app.input('prism_phys_k', '50');
      assert.equal(st.phys.k, 50);
      assert.rel(st.phys.C, shownC, 1e-5, 'displayed C committed with the k edit');
      assert.ok(isFinite(st.phys.S));
      assert.rel(st.params.Cd, 0.8936 * st.phys.C / (0.18 * 1.2e-5 * 35 * 0.354 * 0.354), 1e-9, 'params synced on commit');
    }),
  },
  {
    name: 'state: st.match is read-only, legacy evalModelCurve(td[]) signature, edits call PRiSM_saveState',
    wp: 'WP7', opts: false,
    run: (_a, assert, ctx) => withApp(ctx, null, (app) => {
      stubWell(app);
      app.openPRiSM();
      const st = app.win.PRiSM_state;
      st.match = app.toWin({ timeShift: 5, pressShift: 7 });
      assert.deepEqual(JSON.parse(JSON.stringify(st.match)), { timeShift: 0, pressShift: 0 });
      const c = app.win.PRiSM_evalModelCurve('homogeneous', app.toWin({ Cd: 100, S: 0 }), app.toWin([1, 10, 100]));
      assert.equal(c.pd.length, 3);
      assert.ok(c.td && c.pdPrime);
      ['phys', 'tcMatch', 'bourdetL', 'timeFn', 'semilog', 'analysisKeyResults', 'autoMatch'].forEach((k) => assert.ok(k in st, 'state field ' + k));
      app.evalInApp('window.__saves = 0; window.PRiSM_saveState = function () { window.__saves++; };');
      app.renderTab(2);
      app.input('prism_plot_L', '0.2');
      assert.ok(app.win.__saves > 0, 'L edit saved');
      const s1 = app.win.__saves;
      app.renderTab(3);
      app.click(app.find('#prism_tab_3 .prism-model-card[data-prism-model="radialComposite"]'));
      assert.ok(app.win.__saves > s1, 'model change saved');
    }),
  },

  // ─────────────────────────── integration ───────────────────────────
  {
    name: '[a,e] default sample end to end: Bourdet from pi, Tab 6 regression green with k 45 md, overlay 1110.2 / 52.4 (WP1+WP2+WP8)',
    wp: 'WP7', integration: true, timeoutMs: 180000,
    run(app, assert) {
      app.openPRiSM();
      sampleWell(app);
      const calls = spy(app, 'PRiSM_plot_bourdet');
      app.gotoTab(2);
      const d = calls.last('prism_plot_canvas').data;
      assert.equal(d.dp.length, 55);
      assert.ok(d.dp.every((v) => v > 0));
      assert.near(d.dp[0], 338.6, 0.5);
      assert.near(median(d.deriv.filter((v, i) => d.t[i] >= 10)), 52.4, 1.0);
      app.renderTab(6);
      app.click('prism_regress_run');
      app.flush(200);
      const st = app.win.PRiSM_state;
      assert.equal(app.el('prism_regress_status').getAttribute('data-prism-status'), 'ok', app.el('prism_regress_status').textContent);
      const lf = app.win.PRiSM_getLastFit ? app.win.PRiSM_getLastFit() : st.lastFit;
      assert.near(lf.phys.k, 45, 0.5);
      assert.includes(app.el('prism_regress_results').textContent, 'md');
      assert.deepEqual(JSON.parse(JSON.stringify(st.match)), { timeShift: 0, pressShift: 0 });
      app.gotoTab(2);
      const ov = calls.last('prism_plot_canvas').data.overlay;
      assert.near(lerpLog(120, ov.t, ov.dp), 1110.2, 1.0);
      ov.deriv.forEach((v, i) => { if (ov.t[i] >= 50 && ov.t[i] <= 120) assert.near(v, 52.4, 0.5); });
    },
  },
  {
    name: '[d] Tab 5 with the PTA core: truth RMSE < 0.005, Apply → k 45, S 2.5, match untouched (WP1)',
    wp: 'WP7', integration: true,
    run(app, assert) {
      app.openPRiSM();
      sampleWell(app);
      const st = app.win.PRiSM_state;
      app.win.PRiSM_setModel('homogeneous');
      st.params = app.toWin({ Cd: 80, S: 2.5 });
      st.tcMatch = app.toWin({ logPM: Math.log10(1 / A_TRUE), logTM: Math.log10(B_TRUE) });
      app.renderTab(5);
      assert.ok(parseFloat(app.el('prism_match_rmse_dp').textContent) < 0.005);
      app.click('prism_match_apply');
      assert.near(st.phys.k, 45, 0.5);
      assert.near(st.phys.S, 2.5, 0.05);
      const lf = app.win.PRiSM_getLastFit ? app.win.PRiSM_getLastFit() : st.lastFit;
      assert.equal(lf.source, 'match');
      assert.deepEqual(JSON.parse(JSON.stringify(st.match)), { timeShift: 0, pressShift: 0 });
    },
  },
  {
    name: '[c2] Recommended strip from the real auto-match: Find best models → ranked rows → Use applies (WP3)',
    wp: 'WP7', integration: true, timeoutMs: 180000,
    async run(app, assert) {
      app.openPRiSM();
      sampleWell(app);
      app.renderTab(3);
      app.click('prism_model_findbest');
      for (let i = 0; i < 20 && app.el('prism_model_recommended').getAttribute('data-prism-rec-count') === '0'; i++) await app.flushAsync(500);
      const n = +app.el('prism_model_recommended').getAttribute('data-prism-rec-count');
      assert.ok(n >= 1, 'ranked rows shown');
      assert.includes(app.el('prism_model_recommended').textContent, 'ΔAIC');
      const first = app.find('#prism_model_recommended .prism-rec-use');
      const key = first.getAttribute('data-prism-model');
      app.click(first);
      const st = app.win.PRiSM_state;
      assert.equal(st.model, key);
      const lf = app.win.PRiSM_getLastFit ? app.win.PRiSM_getLastFit() : st.lastFit;
      assert.equal(lf.source, 'automatch');
      assert.deepEqual(JSON.parse(JSON.stringify(st.match)), { timeShift: 0, pressShift: 0 });
    },
  },
  {
    name: '[c] Tab 3 counts with the current registry: 45 combined / 41 transient / 4 decline (WP4a/4b)',
    wp: 'WP7', integration: true,
    run(app, assert) {
      app.openPRiSM();
      const n = {};
      for (const m of ['combined', 'transient', 'decline']) { app.win.PRiSM.mode = m; app.renderTab(3); n[m] = app.findAll('#prism_tab_3 .prism-model-card').length; }
      assert.deepEqual(n, { combined: 45, transient: 41, decline: 4 });
    },
  },
  {
    name: '[g] two-rate synthetic through PRiSM_getAnalysisData({period}) — Δt re-zeroed per period (WP1)',
    wp: 'WP7', integration: true,
    run(app, assert) {
      app.openPRiSM();
      sampleWell(app);
      const ds = twoRateDataset(app);
      app.win.PRiSM_dataset = app.toWin(ds);
      app.fire('window', 'prism:dataset-loaded', {});
      const calls = spy(app, 'PRiSM_plot_bourdet');
      app.renderTab(2);
      app.select('prism_plot_period', '0');
      const d0 = calls.last('prism_plot_canvas').data;
      app.select('prism_plot_period', '1');
      const d1 = calls.last('prism_plot_canvas').data;
      assert.ok(d1.t[0] < 0.1, 'Δt re-zeroed');
      assert.notDeepEqual(Array.from(d0.dp), Array.from(d1.dp));
    },
  },
  {
    name: '[f] Tab 4 physical mode through PRiSM_physicalModel: k/C/S inputs and data+model preview (WP1)',
    wp: 'WP7', integration: true,
    run(app, assert) {
      app.openPRiSM();
      sampleWell(app);
      const st = app.win.PRiSM_state;
      app.win.PRiSM_setModel('homogeneous');
      st.paramUnits = 'auto';
      const calls = spy(app, 'PRiSM_plot_bourdet');
      app.renderTab(4);
      assert.ok(app.el('prism_phys_k'), 'physical inputs');
      app.input('prism_phys_k', '45');
      app.input('prism_phys_C', '0.000848');
      app.input('prism_phys_S', '2.5');
      const c = calls.last('prism_params_canvas');
      assert.near(lerpLog(120, c.data.overlay.t, c.data.overlay.dp), 1110.2, 1.0);
    },
  },
];
