// WP3 — auto-match acceptance tests (13-auto-match.js).
// Non-integration tests pin the engine to the local physical fitter
// (useCore:false) and pass the well explicitly, so they depend only on 13,
// the model registry and PRiSM_lm. Integration tests use the default path
// (33 getWell / getAnalysisData / physicalModel, 05 fitPhysical / fitRate,
// 04 evalModelCurve, 01 sample META).
'use strict';

// Ground truth for the default sample (plan §1.4).
const WELL = { q: 850, B: 1.25, mu: 1.1, ct: 1.2e-5, h: 35, phi: 0.18, rw: 0.354, pi: 4200, testType: 'drawdown' };

function sampleMatch(app, extra) {
  app.seedSample();
  const opts = Object.assign({ well: WELL, useCore: false }, extra || {});
  return app.win.PRiSM_autoMatchSync(app.toWin(opts));
}

function lastFitOf(w) {
  if (typeof w.PRiSM_getLastFit === 'function') return w.PRiSM_getLastFit();
  return w.PRiSM_state && w.PRiSM_state.lastFit;
}

// Synthetic single-rate buildup: q = 850 for tp = 24 h, then shut in.
function buildupDataset(w) {
  const pd = w.PRiSM_MODELS.homogeneous.pd;
  const A = 141.2 * 850 * 1.25 * 1.1 / (45 * 35);
  const B = 0.0002637 * 45 / (0.18 * 1.1 * 1.2e-5 * 0.354 * 0.354);
  const Cd = 0.8936 * 8.48e-4 / (0.18 * 1.2e-5 * 35 * 0.354 * 0.354);
  const par = w.JSON.parse(JSON.stringify({ Cd, S: 2.5 }));
  const tp = 24;
  const t = [], p = [], q = [];
  const flow = [0.05, 0.2, 1, 4, 12, 24];
  const pdFlow = pd(w.JSON.parse(JSON.stringify(flow.map((x) => B * x))), par);
  flow.forEach((x, i) => { t.push(x); p.push(4200 - A * pdFlow[i]); q.push(850); });
  const pwf0 = p[p.length - 1];
  const dts = [];
  for (let lx = -3; lx <= Math.log10(72) + 1e-9; lx += 0.1) dts.push(Math.pow(10, lx));
  const pdTp = pd(w.JSON.parse(JSON.stringify([B * tp])), par)[0];
  const pdDt = pd(w.JSON.parse(JSON.stringify(dts.map((d) => B * d))), par);
  const pdTot = pd(w.JSON.parse(JSON.stringify(dts.map((d) => B * (tp + d)))), par);
  dts.forEach((d, i) => { t.push(tp + d); p.push(pwf0 + A * (pdTp - pdTot[i] + pdDt[i])); q.push(0); });
  return { t, p, q, pwf0 };
}

module.exports = [
  {
    name: 'a. default sample: homogeneous is best, k/S/Cd recovered in field units',
    wp: 'WP3', timeoutMs: 120000,
    run(app, assert) {
      const res = sampleMatch(app);
      assert.ok(res.ok, 'auto-match succeeded');
      assert.equal(res.kind, 'pressure');
      const best = res.ranked[0];
      assert.equal(best.modelKey, 'homogeneous', 'best model');
      assert.equal(res.bestKey, 'homogeneous');
      assert.ok(best.converged, 'best row converged');
      assert.equal(best.label, 'Best fit');
      assert.near(best.phys.k, 45, 2, 'k (md)');
      assert.near(best.phys.S, 2.5, 0.2, 'S');
      assert.near(best.phys.Cd, 80, 5, 'Cd');
      assert.rel(best.phys.C, 8.48e-4, 0.05, 'C (bbl/psi)');
      assert.ok(best.r2 > 0.999, 'R² > 0.999, got ' + best.r2);
      assert.ok(best.rmse < 2, 'RMSE (psi) small, got ' + best.rmse);
      assert.includes(res.classification.summary.toLowerCase(), 'storage');
      assert.ok(!/spherical/i.test(res.classification.summary), 'no spherical-flow tag on the storage hump');
      assert.ok(res.classification.regimes.every((r) => r.tag !== 'sphericalFlow'));
      assert.ok(res.elapsedMs < 3000, 'race under 3 s, took ' + res.elapsedMs);
    },
  },
  {
    name: 'top-3 candidates expose plain names, ΔAIC, R², converged flag and Akaike weights',
    wp: 'WP3', timeoutMs: 120000,
    run(app, assert) {
      const res = sampleMatch(app);
      assert.ok(res.top.length >= 3, 'at least 3 candidates, got ' + res.top.length);
      assert.equal(res.candidates.length, res.top.length);
      res.top.forEach((r, i) => {
        assert.equal(r.rank, i + 1);
        assert.ok(typeof r.modelName === 'string' && r.modelName.length > 3 && !/[A-Z][a-z]+[A-Z]/.test(r.modelName),
          'plain model name: ' + r.modelName);
        assert.finite(r.dAIC); assert.finite(r.r2); assert.finite(r.aic);
        assert.equal(typeof r.converged, 'boolean');
        assert.equal(r.source, 'automatch');
        assert.equal(r.kind, 'pressure');
        assert.ok(r.phys && r.params && r.ci95 && r.scales, 'C4 fields present');
      });
      assert.equal(res.top[0].dAIC, 0);
      for (let i = 1; i < res.ranked.length; i++) assert.ok(res.ranked[i].dAIC >= res.ranked[i - 1].dAIC);
      const wsum = res.ranked.reduce((s, r) => s + r.akaikeWeight, 0);
      assert.near(wsum, 1, 1e-9, 'Akaike weights sum to 1 over the ranked rows');
      assert.equal(res.top.filter((r) => r.label === 'Best fit').length, 1);
      assert.ok(res.ranked[0].params.Cd > 0 && !('__h_rw' in res.ranked[0].params), 'dimensionless params, no injected keys');
    },
  },
  {
    name: 'non-converged candidates are labelled "Starting point — refine", never "Best fit"',
    wp: 'WP3', timeoutMs: 120000,
    run(app, assert) {
      const res = sampleMatch(app, { maxIter: 1 });
      assert.ok(res.ranked.length > 0);
      res.ranked.forEach((r) => {
        assert.equal(r.converged, false, r.modelKey + ' should not be converged at maxIter 1');
        assert.equal(r.label, 'Starting point — refine');
        assert.equal(r.status, 'refine');
      });
      assert.equal(res.bestKey, null, 'no converged best');
      assert.equal(res.bestConverged, false);
      assert.ok(res.warnings.some((w) => /starting point/i.test(w)));
      const host = app.document.createElement('div');
      app.win.PRiSM_renderAutoMatchPanel(host, res);
      assert.ok(host.innerHTML.indexOf('Starting point — refine') !== -1);
      assert.ok(host.innerHTML.indexOf('Best fit') === -1, 'panel never says Best fit for a non-converged row');
      assert.ok(!/BEST FIT/.test(host.innerHTML));
    },
  },
  {
    name: 'b. apply: model/params/phys/lastFit/tcMatch set, st.match untouched, event fired',
    wp: 'WP3', timeoutMs: 120000,
    run(app, assert) {
      app.openPRiSM();
      const w = app.win;
      const matchBefore = JSON.stringify(w.PRiSM_state.match);
      const res = w.PRiSM_autoMatchSync(app.toWin({ well: WELL, useCore: false }));
      app.evalInApp("window.__wp3fit = 0; window.addEventListener('prism:fit-updated', function () { window.__wp3fit++; });");
      const row = w.PRiSM_applyAutoMatchRow('homogeneous', res);
      assert.ok(row, 'row applied');
      const st = w.PRiSM_state;
      assert.equal(JSON.stringify(st.match), matchBefore, 'st.match unchanged');
      assert.equal(st.model, 'homogeneous');
      assert.near(st.params.Cd, 80, 5); assert.near(st.params.S, 2.5, 0.2);
      assert.near(st.phys.k, 45, 2);
      const lf = lastFitOf(w);
      assert.equal(lf.source, 'automatch');
      assert.equal(lf.modelKey || lf.model, 'homogeneous');
      assert.near(st.tcMatch.logPM, -2.020, 0.01, 'logPM');
      assert.near(st.tcMatch.logTM, 4.600, 0.02, 'logTM');
      assert.ok(w.__wp3fit >= 1, 'prism:fit-updated dispatched');
      assert.ok(st.interp && st.interp.narrative, 'interpretation refreshed into st.interp');
      assert.includes(st.autoMatchStatus, 'Applied Homogeneous reservoir — k 45.0 md, S 2.5');
    },
  },
  {
    name: 'c. decline mode: Arps {t,q} dataset recovers qi, Di, b (days)',
    wp: 'WP3', timeoutMs: 120000,
    run(app, assert) {
      const w = app.win;
      const t = [], q = [];
      for (let d = 0; d <= 1000; d += 20) { t.push(24 * d); q.push(1000 * Math.pow(1 + 0.5 * 0.01 * d, -2)); }
      w.PRiSM_dataset = app.toWin({ t, q });
      const res = w.PRiSM_autoMatchSync(app.toWin({ useCore: false }));
      assert.ok(res.ok, 'decline race ran: ' + res.error);
      assert.equal(res.kind, 'rate');
      assert.equal(res.mode, 'decline');
      const arps = res.ranked.find((r) => r.modelKey === 'arps');
      assert.ok(arps, 'arps fitted');
      assert.equal(res.ranked[0].modelKey, 'arps', 'arps ranks first');
      assert.near(arps.params.qi, 1000, 1, 'qi');
      assert.near(arps.params.Di, 0.0100, 1e-4, 'Di (1/d)');
      assert.near(arps.params.b, 0.50, 0.01, 'b');
      assert.equal(arps.phys.timeUnit, 'd');
      assert.ok(res.ranked.every((r) => r.kind === 'rate'), 'pressure and rate never share one ranking');
    },
  },
  {
    name: 'combined mode with constant rate does not race decline models',
    wp: 'WP3', timeoutMs: 120000,
    run(app, assert) {
      const res = sampleMatch(app, { mode: 'combined' });
      assert.equal(res.decline, null);
      assert.ok(res.ranked.every((r) => r.kind === 'pressure'));
    },
  },
  {
    name: 'scale mode (φ, ct, rw missing): kh and C reported, S flagged not identifiable',
    wp: 'WP3', timeoutMs: 120000,
    run(app, assert) {
      const well = { q: 850, B: 1.25, mu: 1.1, h: 35, pi: 4200, testType: 'drawdown' };
      app.seedSample();
      const res = app.win.PRiSM_autoMatchSync(app.toWin({ well, useCore: false, candidates: ['homogeneous'] }));
      const r = res.ranked[0];
      assert.equal(r.mode, 'scale');
      assert.rel(r.phys.kh, 1575, 0.05, 'kh');
      assert.rel(r.phys.C, 8.48e-4, 0.1, 'C');
      assert.equal(r.phys.S, null);
      assert.ok(r.warnings.some((x) => /not identifiable/.test(x)));
      assert.equal(res.well.complete, false);
      assert.ok(res.well.missing.indexOf('ct') !== -1);
    },
  },
  {
    name: 'pi unknown: reference is flagged and pi floats back to 4200',
    wp: 'WP3', timeoutMs: 120000,
    run(app, assert) {
      const well = Object.assign({}, WELL, { pi: null });
      app.seedSample();
      const res = app.win.PRiSM_autoMatchSync(app.toWin({ well, useCore: false, candidates: ['homogeneous'] }));
      assert.ok(['extrapolated', 'first-sample'].indexOf(res.analysis.pRefSource) !== -1);
      assert.ok(res.analysis.warnings.some((x) => /biased/.test(x)), 'bias warning');
      assert.equal(res.analysis.floatPi, true);
      const r = res.ranked[0];
      assert.equal(r.pRefSource, 'floated');
      assert.near(r.pRef, 4200, 5, 'pi floated');
      assert.near(r.phys.k, 45, 1.5); assert.near(r.phys.S, 2.5, 0.25);
    },
  },
  {
    name: 'synthetic buildup (tp 24 h): superposed physical model recovers k and S',
    wp: 'WP3', timeoutMs: 120000,
    run(app, assert) {
      const w = app.win;
      const ds = buildupDataset(w);
      w.PRiSM_dataset = app.toWin({ t: ds.t, p: ds.p, q: ds.q });
      const well = Object.assign({}, WELL, { testType: 'auto', pi: null });
      const res = w.PRiSM_autoMatchSync(app.toWin({ well, useCore: false, candidates: ['homogeneous'] }));
      assert.equal(res.analysis.testType, 'buildup');
      assert.equal(res.analysis.floatPi, false);
      assert.near(res.analysis.pRef, ds.pwf0, 1e-6);
      const r = res.ranked[0];
      assert.near(r.phys.k, 45, 1, 'k');
      assert.near(r.phys.S, 2.5, 0.2, 'S');
      assert.ok(r.r2 > 0.999);
    },
  },
  {
    name: 'classifier: −½ slope after radial flow is still spherical; falling hump is storage',
    wp: 'WP3',
    run(app, assert) {
      const w = app.win;
      const t = [], d = [];
      for (let i = 0; i < 40; i++) {
        const x = -1 + i * 0.1; t.push(Math.pow(10, x));
        d.push(x < 1 ? 50 : 50 * Math.pow(10, -0.5 * (x - 1)));
      }
      const c = w.PRiSM_classifyRegimes(app.toWin(t), app.toWin(t.map(() => 0)), app.toWin(d));
      assert.ok(c.regimes.some((r) => r.tag === 'sphericalFlow'), 'spherical after radial: ' + c.summary);
      const t2 = [], d2 = [];
      for (let i = 0; i < 40; i++) {
        const x = -2 + i * 0.1; t2.push(Math.pow(10, x));
        d2.push(x < -1.4 ? 300 * Math.pow(10, -0.6 * (x + 1.4)) : (x < -0.6 ? 300 * Math.pow(10, -0.6 * (x + 1.4)) : 99.5));
      }
      const c2 = w.PRiSM_classifyRegimes(app.toWin(t2), app.toWin(t2.map(() => 0)), app.toWin(d2));
      assert.ok(c2.regimes.every((r) => r.tag !== 'sphericalFlow'), c2.summary);
      assert.includes(c2.summary, 'storage');
      assert.equal(c2.candidates[0], 'homogeneous');
    },
  },
  {
    name: 'panel: top-3 cards with plain names and working "Use this model" buttons',
    wp: 'WP3', timeoutMs: 120000,
    run(app, assert) {
      app.openPRiSM();
      const w = app.win;
      const res = w.PRiSM_autoMatchSync(app.toWin({ well: WELL, useCore: false }));
      const host = app.document.createElement('div');
      app.document.body.appendChild(host);
      w.PRiSM_renderAutoMatchPanel(host, res);
      assert.includes(host.innerHTML, 'Recommended models');
      assert.includes(host.innerHTML, 'Homogeneous reservoir');
      assert.includes(host.innerHTML, 'ΔAIC');
      const btns = host.querySelectorAll('button[data-prism-am-apply]');
      assert.equal(btns.length, res.top.length);
      w.PRiSM_state.model = 'linearBoundary';
      app.click(btns[0]);
      assert.equal(w.PRiSM_state.model, 'homogeneous');
      assert.includes(app.find('#prism_am_status').textContent, 'Applied Homogeneous reservoir');
      assert.ok(app.document.getElementById('prism_am_css'), 'scoped panel CSS injected once');
      const css = app.document.getElementById('prism_am_css').textContent;
      assert.ok(/var\(--bg2\)/.test(css) && /var\(--green\)/.test(css), 'uses host theme variables');
      assert.ok(!/width:\s*[4-9]\d\dpx|width:\s*\d{4,}px/.test(host.innerHTML + css), 'no fixed widths wider than a phone');
    },
  },
  {
    name: 'panel with no result offers "Find best model" (runs asynchronously)',
    wp: 'WP3', timeoutMs: 120000,
    async run(app, assert) {
      const w = app.win;
      app.seedSample();
      w.PRiSM_state = w.PRiSM_state || app.toWin({ params: {}, match: { timeShift: 0, pressShift: 0 } });
      w.PRiSM_state.autoMatch = null;
      const host = app.document.createElement('div');
      app.document.body.appendChild(host);
      w.PRiSM_renderAutoMatchPanel(host, null);
      const run = host.querySelector('#prism_am_run');
      assert.ok(run, 'run button');
      assert.includes(run.textContent, 'Find best model');
    },
  },
  {
    name: 'PRiSM_autoMatch returns a Promise and yields between candidates',
    wp: 'WP3', timeoutMs: 120000,
    async run(app, assert) {
      app.seedSample();
      const w = app.win;
      const prog = [];
      const opts = app.toWin({ well: WELL, useCore: false, candidates: ['homogeneous', 'linearBoundary'] });
      opts.onProgress = (i, n, key) => prog.push(key);
      const pr = w.PRiSM_autoMatch(opts);
      assert.equal(typeof pr.then, 'function');
      assert.equal(prog.length, 0, 'nothing runs before the first yield');
      await app.flushAsync(100);
      const res = await pr;
      assert.deepEqual(prog, ['homogeneous', 'linearBoundary']);
      assert.equal(res.bestKey, 'homogeneous');
      assert.equal(w.PRiSM_state && w.PRiSM_state.autoMatch ? w.PRiSM_state.autoMatch.bestKey : 'homogeneous', 'homogeneous');
    },
  },
  {
    name: 'no dataset → friendly error result, no throw',
    wp: 'WP3',
    run(app, assert) {
      const w = app.win;
      w.PRiSM_dataset = null;
      const res = w.PRiSM_autoMatchSync();
      assert.equal(res.ok, false);
      assert.includes(res.error, 'dataset');
      assert.equal(w.PRiSM_applyAutoMatchRow('homogeneous', res), null);
    },
  },

  // ── Integration (need WP1 33, WP2 05, WP7 04, WP8 01) ──────────────────
  {
    name: 'I1. default path on the opened app: homogeneous, k 45, S 2.5, Cd 80',
    wp: 'WP3', integration: true, timeoutMs: 180000,
    run(app, assert) {
      app.openPRiSM();
      const res = app.win.PRiSM_autoMatchSync();
      const best = res.ranked[0];
      assert.equal(best.modelKey, 'homogeneous');
      assert.ok(best.converged);
      assert.near(best.phys.k, 45, 2); assert.near(best.phys.S, 2.5, 0.2); assert.near(best.phys.Cd, 80, 5);
      assert.ok(best.r2 > 0.999);
      assert.ok(!/spherical/i.test(res.classification.summary));
    },
  },
  {
    name: 'I2. apply propagates: model curve finite, lastFit via getLastFit, interpretation says FE',
    wp: 'WP3', integration: true, timeoutMs: 180000,
    run(app, assert) {
      app.openPRiSM();
      const w = app.win;
      const res = w.PRiSM_autoMatchSync();
      w.PRiSM_applyAutoMatchRow(res.bestKey, res);
      const st = w.PRiSM_state;
      assert.deepEqual(JSON.parse(JSON.stringify(st.match)), { timeShift: 0, pressShift: 0 });
      assert.fn(w.PRiSM_getLastFit);
      assert.equal(w.PRiSM_getLastFit().source, 'automatch');
      const mc = st.modelCurveData;
      assert.ok(mc, 'modelCurveData present');
      const arr = mc.dp || mc.pd;
      assert.ok(arr && arr.length && Array.prototype.every.call(arr, (v) => isFinite(v)), 'finite model curve');
      assert.ok(st.interp && /FE \d+%/.test(st.interp.narrative), 'FE in narrative');
    },
  },
  {
    name: 'I3. decline race through the core rate fitter',
    wp: 'WP3', integration: true, timeoutMs: 180000,
    run(app, assert) {
      const w = app.win;
      const t = [], q = [];
      for (let d = 0; d <= 1000; d += 20) { t.push(24 * d); q.push(1000 * Math.pow(1 + 0.5 * 0.01 * d, -2)); }
      w.PRiSM_dataset = app.toWin({ t, q });
      assert.fn(w.PRiSM_fitRate);
      const res = w.PRiSM_autoMatchSync();
      const arps = res.ranked.find((r) => r.modelKey === 'arps');
      assert.near(arps.params.qi, 1000, 1); assert.near(arps.params.Di, 0.01, 1e-4); assert.near(arps.params.b, 0.5, 0.01);
    },
  },
  {
    name: 'ranking parsimony: within ΔAIC < 2 an all-determined model beats a leader with an undeterminable parameter',
    wp: 'WP3',
    run(app, assert) {
      const w = app.win;
      assert.fn(w.PRiSM_rankCandidates);
      const rows = () => app.toWin([
        { modelKey: 'infiniteFrac', aic: 10.0, r2: 0.99999, converged: true, identifiable: { k: true, S: false, xf: false } },
        { modelKey: 'homogeneous', aic: 10.2, r2: 0.99998, converged: true, identifiable: { k: true, S: true, C: true } },
        { modelKey: 'linearBoundary', aic: 12.1, r2: 0.99990, converged: true, identifiable: { k: true, S: true, L: true } },
      ]);
      // Tie within 2 → the fully determined homogeneous model leads.
      const a = w.PRiSM_rankCandidates(rows());
      assert.equal(a[0].modelKey, 'homogeneous');
      assert.equal(a[0].parsimony, true);
      assert.equal(a[1].modelKey, 'infiniteFrac');
      // A real AIC gap (≥ 2) is respected even with an undetermined parameter.
      const r2 = rows(); r2[1].aic = 12.5;
      const b = w.PRiSM_rankCandidates(r2);
      assert.equal(b[0].modelKey, 'infiniteFrac');
      assert.ok(!b[0].parsimony);
      // A fully determined leader is never displaced.
      const r3 = rows(); r3[0].identifiable = { k: true, S: true, xf: true };
      assert.equal(w.PRiSM_rankCandidates(r3)[0].modelKey, 'infiniteFrac');
    },
  },
];
