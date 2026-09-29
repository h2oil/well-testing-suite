// WP11 — Advanced panels: deconvolution (17), tide correction (18),
// gauge / analysis managers (19), PLT + inverse simulation (20).
//
// Unit tests run against this WP's files alone (every shared contract is
// optional there); integration tests need WP1 (C1/C2/C4) and WP8 (C7
// panel mounting) and are flagged integration:true.
'use strict';

const fs = require('fs');
const path = require('path');

const BUILD = path.resolve(__dirname, '..');
const WP11_FILES = ['17-deconvolution.js', '18-tide-analysis.js', '19-data-managers.js', '20-plt-inverse.js'];

// ── Ground truth (plan §1.4) ────────────────────────────────────────────
const TRUTH = { pi: 4200, q: 850, B: 1.25, mu: 1.1, h: 35, phi: 0.18, ct: 1.2e-5, rw: 0.354, k: 45, Cd: 80, S: 2.5 };
const A_UNIT = 141.2 * TRUTH.B * TRUTH.mu / (TRUTH.k * TRUTH.h);                               // psi per STB/d per pD
const B_T = 0.0002637 * TRUTH.k / (TRUTH.phi * TRUTH.mu * TRUTH.ct * TRUTH.rw * TRUTH.rw);   // tD per hour

// Unit-rate response g(τ) of the truth model (psi per STB/d).
function unitResponse(app) {
  const pd = app.win.PRiSM_MODELS.homogeneous.pd;
  return (tau) => {
    if (!(tau > 0)) return 0;
    const td = B_T * tau;
    if (td < 1e-3) return A_UNIT * td / TRUTH.Cd;          // pure storage (Laplace inversion unsafe here)
    return A_UNIT * pd([td], { Cd: TRUTH.Cd, S: TRUTH.S })[0];
  };
}

// Synthetic multi-rate test with a sample at every rate change.
//   sched = [{t0, q}], log-spaced samples inside every period.
function synthMultiRate(app, sched, tEnd, nPer, injector) {
  const g = unitResponse(app);
  const sgn = injector ? -1 : 1;
  const t = [], p = [], q = [];
  const add = (tt, qq) => {
    let dp = 0, qPrev = 0;
    for (const s of sched) { if (s.t0 < tt) { dp += (s.q - qPrev) * g(tt - s.t0); qPrev = s.q; } }
    t.push(tt); p.push(TRUTH.pi - sgn * dp); q.push(qq);
  };
  for (let k = 0; k < sched.length; k++) {
    const t0 = sched[k].t0, t1 = k + 1 < sched.length ? sched[k + 1].t0 : tEnd;
    if (k > 0) add(t0, sched[k].q);
    for (let i = (k > 0 ? 1 : 0); i < nPer; i++) {
      add(t0 + Math.pow(10, -2.3 + (Math.log10((t1 - t0) * 0.999) + 2.3) * i / (nPer - 1)), sched[k].q);
    }
  }
  return { t, p, q };
}

// Well inputs through C1 when present, else straight into PRiSM_pvt.
function setWellInputs(app, patch, source) {
  const w = app.win;
  if (typeof w.PRiSM_setWell === 'function') {
    w.PRiSM_setWell(app.toWin(patch), app.toWin({ source: source || 'user' }));
    return;
  }
  const pvt = w.PRiSM_pvt || (w.PRiSM_pvt = app.toWin({}));
  if (!pvt.provenance) pvt.provenance = app.toWin({});
  for (const k of Object.keys(patch)) { pvt[k] = patch[k]; pvt.provenance[k] = source || 'user'; }
}
function sampleWell(app) {
  setWellInputs(app, { fluidType: 'oil', p_res: TRUTH.pi, pi: TRUTH.pi, testType: 'drawdown', q: TRUTH.q, Bo: TRUTH.B,
    mu_o: TRUTH.mu, ct: TRUTH.ct, h: TRUTH.h, phi: TRUTH.phi, rw: TRUTH.rw }, 'sample');
}
// C4 when present, else PRiSM_state.lastFit.
function setFit(app, fit) {
  const w = app.win;
  if (typeof w.PRiSM_setLastFit === 'function') { w.PRiSM_setLastFit(app.toWin(fit)); return; }
  w.PRiSM_state = w.PRiSM_state || app.toWin({});
  w.PRiSM_state.lastFit = app.toWin(fit);
}
function wellPi(app) {
  const w = app.win;
  if (typeof w.PRiSM_getWell === 'function') return w.PRiSM_getWell().pi;
  return w.PRiSM_pvt ? w.PRiSM_pvt.p_res : null;
}
function spyEvents(app) {
  app.evalInApp(
    "window.__wp11 = { ds: [], well: [], draws: 0 };" +
    "window.addEventListener('prism:dataset-loaded', function (e) { window.__wp11.ds.push(e.detail && e.detail.source); });" +
    "window.addEventListener('prism:well-changed', function (e) { window.__wp11.well.push(e.detail || {}); });" +
    "window.PRiSM_drawActivePlot = function () { window.__wp11.draws++; };");
  return app.win.__wp11;
}
function panelSpec(app, tab, id) {
  const reg = app.win.PRiSM_tabPanels || {};
  return (reg[tab] || []).find((s) => s && s.id === id) || null;
}
function mountHost(app, widthPx) {
  const host = app.document.createElement('div');
  if (widthPx) host.style.cssText = 'width:' + widthPx + 'px';
  app.document.body.appendChild(host);
  return host;
}
function median(a) { const v = a.filter((x) => isFinite(x)).slice().sort((x, y) => x - y); return v[v.length >> 1]; }
// Any inline fixed width wider than the host that is not capped at 100 %.
function overflowOffenders(root, maxPx) {
  const bad = [];
  for (const el of root.querySelectorAll('*')) {
    const st = el.style || {};
    for (const prop of ['width', 'minWidth']) {
      const m = /^([\d.]+)px$/.exec(st[prop] || '');
      if (m && +m[1] > maxPx && st.maxWidth !== '100%') bad.push(el.localName + '#' + (el.id || '') + ' ' + prop + '=' + st[prop]);
    }
    const g = /minmax\(\s*([\d.]+)px/.exec(st.gridTemplateColumns || '');
    if (g && +g[1] > maxPx) bad.push(el.localName + ' grid min ' + g[1] + 'px');
  }
  return bad;
}

const PANELS = [
  { tab: 1, id: 'prism_tide', title: 'Tide correction' },
  { tab: 1, id: 'prism_datasets', title: 'Gauges & analysis datasets' },
  { tab: 2, id: 'prism_deconvolution', title: 'Advanced: deconvolution' },
  { tab: 6, id: 'prism_plt_inverse', title: 'PLT & inverse simulation' },
];

module.exports = [
  // ── C7 registration + rendering ──────────────────────────────────────
  {
    name: 'panels are registered through C7 on tabs 1, 2 and 6 (merge, one entry each)',
    wp: 'WP11',
    run(app, assert) {
      for (const p of PANELS) {
        const list = (app.win.PRiSM_tabPanels || {})[p.tab] || [];
        const hits = list.filter((s) => s && s.id === p.id);
        assert.equal(hits.length, 1, p.id + ' registered exactly once on tab ' + p.tab);
        const s = hits[0];
        assert.equal(s.title, p.title);
        assert.fn(s.render, p.id + '.render');
        assert.ok(typeof s.order === 'number', p.id + '.order');
        assert.equal(s.collapsed, true, p.id + ' starts collapsed');
      }
    },
  },
  {
    name: 'every panel renders headlessly with the default sample (no throw, content present)',
    wp: 'WP11',
    run(app, assert) {
      app.seedSample();
      for (const p of PANELS) {
        const host = mountHost(app);
        app.fire('window', 'wp11-noop', {});          // guard() context for listeners
        panelSpec(app, p.tab, p.id).render(host);
        app.flush(50);
        assert.ok(host.innerHTML.length > 200, p.id + ' rendered content');
      }
      assert.equal(app.errors.length, 0, 'no listener / timer errors');
    },
  },
  {
    name: 'panels fit a 375 px phone: no fixed width wider than the host without max-width',
    wp: 'WP11',
    opts: { viewport: { width: 375, height: 812 } },
    async run(app, assert) {
      app.seedSample();
      for (const p of PANELS) {
        const host = mountHost(app, 343);
        panelSpec(app, p.tab, p.id).render(host);
        await app.flushAsync(50);
        assert.deepEqual(overflowOffenders(host, 343), [], p.id + ' has no overflowing fixed widths');
      }
      // Results views too (deconvolution result, tide results, PLT / inverse charts).
      const ds = synthMultiRate(app, [{ t0: 0, q: 850 }, { t0: 24, q: 0 }], 72, 30);
      app.win.PRiSM_dataset = app.toWin(ds);
      const h2 = mountHost(app, 343);
      panelSpec(app, 2, 'prism_deconvolution').render(h2);
      app.click(h2.querySelector('#prism_dec_run'));
      app.flush(100);
      assert.ok(h2.querySelector('#prism_dec_canvas'), 'result rendered');
      assert.deepEqual(overflowOffenders(h2, 343), []);
    },
  },

  // ── 17 deconvolution ────────────────────────────────────────────────
  {
    name: 'deconvolution: synthetic 2-rate test (drawdown + shut-in) → p_i within 5 psi, derivative plateau 52.4',
    wp: 'WP11',
    run(app, assert) {
      const ds = synthMultiRate(app, [{ t0: 0, q: 850 }, { t0: 24, q: 0 }], 72, 40);
      app.win.PRiSM_dataset = app.toWin(ds);
      const res = app.win.PRiSM_deconvolveDataset();
      assert.ok(res.piIdentifiable, 'two flow periods → p_i identifiable');
      assert.near(res.p_initial, TRUTH.pi, 5, 'p_i');
      assert.equal(res.qRef, 850);
      const late = [];
      for (let i = 0; i < res.tau.length; i++) if (res.tau[i] > 5 && res.tau[i] < 40) late.push(res.gPrime[i] * res.qRef);
      assert.near(median(late), 52.39, 2.0, 'late derivative at q_ref (psi)');
      assert.ok(res.rmse < 0.5, 'history reproduced, rmse ' + res.rmse);
    },
  },
  {
    name: 'deconvolution: two flowing rates and an injection/falloff also recover p_i within 5 psi',
    wp: 'WP11',
    run(app, assert) {
      const two = synthMultiRate(app, [{ t0: 0, q: 850 }, { t0: 24, q: 425 }], 72, 40);
      const r2 = app.win.PRiSM_deconvolve(app.toWin(two.t), app.toWin(two.p), app.toWin(two.q), app.toWin({ silent: true }));
      assert.near(r2.p_initial, TRUTH.pi, 5, 'two rates');
      const inj = synthMultiRate(app, [{ t0: 0, q: 850 }, { t0: 24, q: 0 }], 72, 40, true);
      const r3 = app.win.PRiSM_deconvolve(app.toWin(inj.t), app.toWin(inj.p), app.toWin(inj.q), app.toWin({ silent: true, injector: true }));
      assert.near(r3.p_initial, TRUTH.pi, 5, 'injection + falloff');
      assert.equal(r3.injector, true);
    },
  },
  {
    name: 'deconvolution panel: Run → Apply estimated pi writes the well pi with provenance "deconvolution"',
    wp: 'WP11',
    run(app, assert) {
      const spy = spyEvents(app);
      const ds = synthMultiRate(app, [{ t0: 0, q: 850 }, { t0: 24, q: 0 }], 72, 40);
      app.win.PRiSM_dataset = app.toWin(ds);
      const host = mountHost(app);
      panelSpec(app, 2, 'prism_deconvolution').render(host);
      assert.includes(host.querySelector('#prism_dec_summary').textContent, '2 rate changes');
      app.click(host.querySelector('#prism_dec_run'));
      app.flush(100);
      const piTxt = host.querySelector('#prism_dec_pi').textContent;
      assert.near(parseFloat(piTxt), TRUTH.pi, 5, 'displayed p_i');
      const btn = host.querySelector('#prism_dec_apply_pi');
      assert.ok(!btn.disabled, 'apply enabled for a 2-period test');
      app.click(btn);
      assert.near(wellPi(app), parseFloat(piTxt), 0.06, 'well pi = estimate');
      const pvt = app.win.PRiSM_pvt;
      assert.equal(pvt.provenance && pvt.provenance.p_res, 'deconvolution', 'provenance');
      assert.ok(spy.well.length >= 1, 'prism:well-changed fired');
      assert.includes(host.querySelector('#prism_dec_msg').textContent, 'source: deconvolution');
    },
  },
  {
    name: 'deconvolution: "use response" / "restore" swap the working data, each firing prism:dataset-loaded + a redraw',
    wp: 'WP11',
    run(app, assert) {
      const spy = spyEvents(app);
      const ds = app.toWin(synthMultiRate(app, [{ t0: 0, q: 850 }, { t0: 24, q: 0 }], 72, 40));
      app.win.PRiSM_dataset = ds;
      const res = app.win.PRiSM_deconvolveDataset();
      const resp = app.win.PRiSM_useDeconvolvedResponse(res);
      assert.equal(app.win.PRiSM_dataset, resp);
      assert.equal(resp.source, 'deconvolution');
      assert.ok(resp.q.every((v) => v === 850), 'constant reference rate');
      // Δp of the response at 72 h ≈ constant-rate drawdown of the truth model.
      const g = unitResponse(app);
      const iEnd = resp.t.length - 1;
      assert.near(res.p_initial - resp.p[iEnd], 850 * g(resp.t[iEnd]), 3, 'Δp(τ_max) of the response');
      assert.deepEqual(Array.from(spy.ds), ['deconvolution']);
      assert.equal(spy.draws, 1);
      const back = app.win.PRiSM_restoreDeconvolutionSource();
      assert.equal(back, ds, 'measured data object restored');
      assert.equal(app.win.PRiSM_dataset, ds);
      assert.deepEqual(Array.from(spy.ds), ['deconvolution', 'deconvolution-restore']);
      assert.equal(spy.draws, 2);
    },
  },
  {
    name: 'deconvolution: single flow period → p_i not identifiable; held at the well pi and Apply disabled',
    wp: 'WP11',
    run(app, assert) {
      app.seedSample();                                        // one rate, 850 STB/d
      sampleWell(app);
      const res = app.win.PRiSM_deconvolveDataset();
      assert.equal(res.piIdentifiable, false);
      assert.equal(res.piFixed, true);
      assert.equal(res.p_initial, TRUTH.pi);
      assert.ok(res.warnings.some((w) => /one flow period/i.test(w)));
      const host = mountHost(app);
      panelSpec(app, 2, 'prism_deconvolution').render(host);
      app.click(host.querySelector('#prism_dec_run'));
      app.flush(100);
      assert.equal(host.querySelector('#prism_dec_apply_pi').disabled, true);
      assert.includes(host.querySelector('#prism_dec_summary').textContent, 'Only one flow period');
    },
  },

  // ── 18 tide correction ──────────────────────────────────────────────
  {
    name: 'tide: apply / reset each dispatch prism:dataset-loaded and redraw; new data never revert to an old snapshot',
    wp: 'WP11',
    run(app, assert) {
      const spy = spyEvents(app);
      const mk = (lvl, amp) => {
        const t = [], p = [];
        for (let i = 0; i < 720; i++) { const ti = i * 168 / 719; t.push(ti); p.push(lvl - 0.02 * ti + amp * Math.cos(2 * Math.PI * ti / 12.4206 + 0.7)); }
        return app.toWin({ t, p });
      };
      const A = mk(3000, 0.5), B = mk(3500, 0.3);
      const o = app.toWin({ constituents: ['M2', 'S2'], detrend: true, minDuration_h: 24 });
      app.win.PRiSM_dataset = A;
      const corrA = app.win.PRiSM_applyTideCorrection(o);
      assert.ok(corrA && corrA.tideCorrected);
      assert.deepEqual(Array.from(spy.ds), ['tide-correction']);
      assert.equal(spy.draws, 1);
      app.win.PRiSM_dataset = B;                                   // user loads other data
      assert.equal(app.win.PRiSM_resetTideCorrection(), null, 'reset must not bring A back');
      assert.equal(app.win.PRiSM_dataset, B);
      const corrB = app.win.PRiSM_applyTideCorrection(o);
      assert.near(corrB.p[0], B.p[0], 1.0, 'corrected B (not A)');
      const r = app.win.PRiSM_resetTideCorrection();
      assert.near(r.p[5], B.p[5], 1e-9);
      assert.deepEqual(Array.from(spy.ds), ['tide-correction', 'tide-correction', 'tide-reset']);
      assert.equal(spy.draws, 3);
    },
  },
  {
    name: 'tide panel: run shows the fitted M2 amplitude; apply replaces the working pressures',
    wp: 'WP11',
    run(app, assert) {
      const t = [], p = [];
      for (let i = 0; i < 720; i++) { const ti = i * 168 / 719; t.push(ti); p.push(3000 - 0.02 * ti + 0.5 * Math.cos(2 * Math.PI * ti / 12.4206)); }
      app.win.PRiSM_dataset = app.toWin({ t, p });
      const host = mountHost(app);
      panelSpec(app, 1, 'prism_tide').render(host);
      app.click(host.querySelector('#prism_tide_run'));
      const txt = host.querySelector('.prism-tide-results').textContent;
      const m = /M2[^\d]*12\.4206\s*([\d.]+)/.exec(txt);
      assert.ok(m, 'M2 row present');
      assert.near(parseFloat(m[1]), 0.5, 0.05, 'M2 amplitude (psi)');
      app.click(host.querySelector('#prism_tide_apply'));
      assert.equal(app.win.PRiSM_dataset.tideCorrected, true);
      assert.ok(app.canvasLog(host.querySelector('.prism-tide-canvas')).length > 0, 'decomposition drawn');
    },
  },

  // ── 19 gauge / analysis managers ────────────────────────────────────
  {
    name: 'datasets panel: managers + .prism import/export inside, no second project toolbar',
    wp: 'WP11',
    async run(app, assert) {
      app.seedSample();
      const host = mountHost(app);
      panelSpec(app, 1, 'prism_datasets').render(host);
      await app.flushAsync(20);
      const labels = Array.from(host.querySelectorAll('button')).map((b) => b.textContent.trim());
      for (const l of ['Save working data as gauge', 'Import .prism', 'Export .prism', '+ Import', '+ Sample from gauge']) {
        assert.ok(labels.includes(l), 'button "' + l + '"');
      }
      for (const l of ['New', 'Open…', 'Save', 'Save As…']) assert.ok(!labels.includes(l), 'no "' + l + '" project button');
      assert.includes(host.textContent, 'Working data: 55 points');
      // The header project file (29) owns project save and knows these records.
      if (app.win.WTS_project && typeof app.win.WTS_project.listModules === 'function') {
        assert.ok(Array.from(app.win.WTS_project.listModules()).includes('prism_gauges'), 'registered with the header project');
      }
    },
  },
  {
    name: '.prism toolbar (tools drawer) is import / export / info only — no second New / Save',
    wp: 'WP11',
    run(app, assert) {
      const host = mountHost(app);
      app.win.PRiSM_renderProjectToolbar(host);
      const labels = Array.from(host.querySelectorAll('button')).map((b) => b.textContent.trim());
      assert.deepEqual(labels, ['Import .prism', 'Export .prism', 'Info']);
      assert.includes(host.textContent, 'page header');
    },
  },
  {
    name: 'header project file (29) carries the gauge / analysis records: save → New wipes → open restores',
    wp: 'WP11',
    // Make only this module's localStorage probe fail → in-memory backend
    // (the IndexedDB-like path, where records are not wts_* keys).
    opts: (() => {
      const { createStorage } = require('./_harness');
      const base = createStorage();
      const setItem = (k, v) => { if (String(k) === '__prism_ls_probe__') throw new Error('quota'); return base.setItem(k, v); };
      const s = new Proxy(base, {
        get: (t, p) => (p === 'setItem' ? setItem : Reflect.get(base, p)),
        set: (t, p, v) => Reflect.set(base, p, v),
        has: (t, p) => Reflect.has(base, p),
        deleteProperty: (t, p) => Reflect.deleteProperty(base, p),
        ownKeys: () => Reflect.ownKeys(base),
        getOwnPropertyDescriptor: (t, p) => Reflect.getOwnPropertyDescriptor(base, p),
      });
      return { storage: s };
    })(),
    async run(app, assert) {
      const W = app.win;
      await app.flushAsync(10);
      assert.equal(W.PRiSM_storage.backend, 'memory');
      const P = W.WTS_project;
      assert.ok(P && Array.from(P.listModules()).includes('prism_gauges'), 'module registered');
      app.seedSample();
      const gid = await W.PRiSM_gaugeData.addFromDataset(null, app.toWin({ name: 'G1' }));
      const payload = P._buildPayload();
      const mod = payload.modules.prism_gauges;
      assert.ok(mod && mod.gaugeData.length === 1 && mod.gaugeData[0].id === gid, 'gauge in the project payload');
      assert.ok(mod.gaugeData[0].dataB64 && mod.gaugeData[0].dataB64.t.length > 0, 'data encoded');
      const saved = JSON.parse(JSON.stringify(payload));
      P['new']();
      await app.flushAsync(20);
      assert.equal((await W.PRiSM_gaugeData.list()).length, 0, 'New wiped the records');
      P.loadFromObject(app.toWin(saved));
      await app.flushAsync(20);
      const back = await W.PRiSM_gaugeData.list();
      assert.equal(back.length, 1);
      assert.equal(back[0].metadata.name, 'G1');
      const g = await W.PRiSM_gaugeData.get(gid);
      assert.equal(g.t.length, 55);
    },
  },
  {
    name: 'data managers: store working data as gauge → sample → activate commits the dataset (event + redraw)',
    wp: 'WP11',
    async run(app, assert) {
      const ds = app.seedSample();
      const spy = spyEvents(app);                          // after seeding (it fires its own event)
      const W = app.win;
      const gid = await W.PRiSM_gaugeData.addFromDataset(null, app.toWin({ name: 'sample gauge' }));
      const aid = await W.PRiSM_analysisData.sample(app.toWin([gid]), app.toWin({ name: 'every 2nd', decimate: 'nth', decimateParam: { every: 2 } }));
      await W.PRiSM_analysisData.activate(aid);
      assert.equal(W.PRiSM_dataset.t.length, 28);
      assert.equal(W.PRiSM_dataset.timeUnit, 'h');
      assert.equal(W.PRiSM_dataset.analysisId, aid);
      assert.near(W.PRiSM_dataset.p[1], ds.p[2], 1e-3);
      assert.deepEqual(Array.from(spy.ds), ['analysis-data']);
      assert.equal(spy.draws, 1);
      // Deleting the stored copy leaves the working data alone.
      await W.PRiSM_analysisData.delete(aid);
      assert.equal(W.PRiSM_dataset.t.length, 28);
      assert.equal(W.PRiSM_analysisData.activeId(), null);
    },
  },
  {
    name: 'data managers: importText parses time / pressure / rate columns without touching the working data',
    wp: 'WP11',
    async run(app, assert) {
      const ds = app.seedSample();
      const W = app.win;
      const text = 'Elapsed time (hr),Pressure (psia),Oil rate (STB/d)\n0.5,3900,500\n1.0,3850,500\n2.0,3800,500\n4.0,3760,500\n';
      const id = await W.PRiSM_gaugeData.importText(text, app.toWin({ name: 'g-text' }));
      const g = await W.PRiSM_gaugeData.get(id);
      assert.deepEqual(Array.from(g.t), [0.5, 1, 2, 4]);
      assert.deepEqual(Array.from(g.p), [3900, 3850, 3800, 3760]);
      assert.deepEqual(Array.from(g.q), [500, 500, 500, 500]);
      assert.equal(W.PRiSM_dataset, ds, 'working data untouched');
    },
  },
  {
    name: '.prism round-trip restores model, params, fit, well inputs and the working data',
    wp: 'WP11',
    async run(app, assert) {
      const W = app.win;
      app.seedSample();
      sampleWell(app);
      W.PRiSM_state.model = 'homogeneous';
      W.PRiSM_state.params = app.toWin({ Cd: 80, S: 2.5 });
      setFit(app, { modelKey: 'homogeneous', params: { Cd: 80, S: 2.5 }, phys: { k: 45, kh: 1575, S: 2.5 }, r2: 0.9999 });
      const out = await W.PRiSM_project.save('wp11.prism');
      const dl = app.downloads.find((d) => /wp11\.prism$/.test(d.filename));
      assert.ok(dl && dl.content, 'download captured');
      const proj = JSON.parse(dl.content);
      assert.equal(out.filename, 'wp11.prism');
      assert.equal(proj.state.model, 'homogeneous');
      assert.equal(proj.state.lastFit.phys.k, 45);
      assert.equal(proj.state.pvt.h, TRUTH.h);
      assert.equal(proj.state.dataset.t.length, 55);
      assert.ok(!('_computed' in proj.state.pvt), 'computed PVT block not saved');
      // Scramble, then load.
      W.PRiSM_state.params = app.toWin({ Cd: 1, S: 0 });
      W.PRiSM_state.lastFit = null;
      W.PRiSM_pvt.h = 10;
      W.PRiSM_dataset = null;
      await W.PRiSM_project.loadFromObject(app.toWin(proj));
      assert.equal(W.PRiSM_state.model, 'homogeneous');
      assert.equal(W.PRiSM_state.params.S, 2.5);
      const lf = (typeof W.PRiSM_getLastFit === 'function') ? W.PRiSM_getLastFit() : W.PRiSM_state.lastFit;
      assert.equal(lf.phys.k, 45);
      assert.equal(W.PRiSM_pvt.h, TRUTH.h);
      assert.equal(W.PRiSM_dataset.t.length, 55);
    },
  },

  // ── 20 PLT + inverse simulation ─────────────────────────────────────
  {
    name: 'inverse simulation reads lastFit.phys.k and measures Δp from pi: default sample → q = 850 STB/d',
    wp: 'WP11',
    run(app, assert) {
      app.seedSample();
      sampleWell(app);
      setFit(app, { modelKey: 'homogeneous', params: { Cd: 80, S: 2.5 }, phys: { k: 45, kh: 1575 } });
      const r = app.win.PRiSM_inverseSimDataset();
      assert.ok(r.converged, 'solved');
      assert.equal(r.pRef, TRUTH.pi);
      assert.equal(r.pRefSource, 'pi');
      assert.equal(r.dimensional, true);
      assert.equal(r.rateUnit, 'STB/d');
      assert.near(r.k, 45, 1e-9, 'k from the fit');
      assert.rel(median(Array.from(r.q)), 850, 0.02, 'median recovered rate');
      assert.ok(r.rmse < 1.0, 'pressure reproduced (rmse ' + r.rmse + ')');
      // A different fitted k changes the answer → the fit is really used.
      setFit(app, { modelKey: 'homogeneous', params: { Cd: 80, S: 2.5 }, phys: { k: 90, kh: 3150 } });
      const r2 = app.win.PRiSM_inverseSimDataset();
      assert.near(r2.k, 90, 1e-9);
      assert.ok(median(Array.from(r2.q)) > 1.3 * 850, 'k = 90 md gives a higher implied rate');
    },
  },
  {
    name: 'inverse simulation without pi: reference extrapolated (flagged), never the first sample',
    wp: 'WP11',
    run(app, assert) {
      const ds = app.seedSample();
      sampleWell(app);
      const pvt = app.win.PRiSM_pvt;
      if (typeof app.win.PRiSM_setWell === 'function') app.win.PRiSM_setWell(app.toWin({ p_res: 4000 }), app.toWin({ source: 'default' }));
      else pvt.provenance.p_res = 'default';
      setFit(app, { modelKey: 'homogeneous', params: { Cd: 80, S: 2.5 }, phys: { k: 45, kh: 1575 } });
      const r = app.win.PRiSM_inverseSimDataset();
      assert.equal(r.pRefSource, 'extrapolated');
      assert.ok(r.pRef !== ds.p[0], 'reference is not p[0]');
      assert.ok(r.warnings.some((w) => /initial pressure/i.test(w)), 'warning shown');
    },
  },
  {
    name: 'inverse panel (Tab 6): Run shows the fitted k, pi reference and the recovered rate',
    wp: 'WP11',
    run(app, assert) {
      app.seedSample();
      sampleWell(app);
      setFit(app, { modelKey: 'homogeneous', params: { Cd: 80, S: 2.5 }, phys: { k: 45, kh: 1575 } });
      const host = mountHost(app);
      panelSpec(app, 6, 'prism_plt_inverse').render(host);
      const inputs = host.querySelector('.prism-inv-inputs').textContent;
      assert.includes(inputs, 'k = 45 md');
      assert.includes(inputs, '4200');
      app.click(host.querySelector('#prism_inv_run'));
      const msg = host.querySelector('#prism_inv_msg').textContent;
      const m = /median q = ([\d.]+) STB\/d/.exec(msg);
      assert.ok(m, 'message: ' + msg);
      assert.rel(parseFloat(m[1]), 850, 0.02);
      assert.ok(app.canvasLog(host.querySelector('#prism_inv_canvas_q')).length > 0, 'rate chart drawn');
    },
  },
  {
    name: 'synthetic PLT uses the fitted kh: layer kh in md·ft (0.5 / 0.25 / 0.25 of 1575)',
    wp: 'WP11',
    run(app, assert) {
      app.seedSample();
      sampleWell(app);
      const params = { Cd: 100, S: 0, N: 3, perms: [1, 1, 1], khFracs: [0.5, 0.25, 0.25] };
      setFit(app, { modelKey: 'multiLayerNoXF', params, phys: { k: 45, kh: 1575 } });
      const host = mountHost(app);
      panelSpec(app, 6, 'prism_plt_inverse').render(host);
      app.click(host.querySelector('#prism_plt_compute'));
      const table = host.querySelector('#prism_plt_table').textContent;
      assert.includes(table, 'kh (md·ft)');
      assert.includes(table, '787.5');
      assert.includes(table, '393.8');
      assert.includes(host.querySelector('#prism_plt_msg').textContent, '1575 md·ft');
      const r = app.win.PRiSM_syntheticPLT('multiLayerNoXF', app.toWin(params), app.toWin([1, 10]), app.toWin([850, 850]), app.toWin({ khTotal: 1575 }));
      assert.near(r.layers[0].kh, 787.5, 1e-9);
      assert.equal(r.diagnostics.khUnits, 'md·ft');
    },
  },

  // ── hygiene ─────────────────────────────────────────────────────────
  {
    name: 'no p[0]-referenced Δp left in 17–20',
    wp: 'WP11',
    opts: false,
    run(app, assert) {
      for (const f of WP11_FILES) {
        // Only the code that ships: self-tests are stripped at concat.
        const src = require(path.join(BUILD, 'concat-round3.js')).stripSelfTest(fs.readFileSync(path.join(BUILD, f), 'utf8'), f, { log() {}, warn() {} });
        const hits = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\b(p|pObs|ds\.p|dataset\.p)\[0\]/.test(l));
        assert.deepEqual(hits, [], f + ' has no p[0] reference');
      }
    },
  },
  {
    name: 'no perpetual timers from 17–20 after rendering and running every panel',
    wp: 'WP11',
    async run(app, assert) {
      app.seedSample();
      sampleWell(app);
      setFit(app, { modelKey: 'homogeneous', params: { Cd: 80, S: 2.5 }, phys: { k: 45, kh: 1575 } });
      for (const p of PANELS) panelSpec(app, p.tab, p.id).render(mountHost(app));
      const h = mountHost(app);
      panelSpec(app, 2, 'prism_deconvolution').render(h);
      app.click(h.querySelector('#prism_dec_run'));
      await app.flushAsync(100);
      app.flushUntilIdle(20000);
      const mine = app.timers().filter((t) => /prism-build\/(17|18|19|20)-/.test(t.where || ''));
      assert.deepEqual(mine.map((t) => t.kind + ' @ ' + t.where), [], 'no pending WP11 timers');
    },
  },

  // ── integration (WP1 contracts + WP8 panel mounting) ────────────────
  {
    name: '[integration] panels mount in the tab panel areas (C7 via WP8)',
    wp: 'WP11',
    integration: true,
    run(app, assert) {
      app.openPRiSM();
      for (const p of PANELS) {
        const tabHost = app.renderTab(p.tab);
        const area = app.el('prism_tab_' + p.tab + '_panels');
        assert.ok(area, 'panel area on tab ' + p.tab);
        assert.includes(area.textContent, p.title, p.title + ' card on tab ' + p.tab);
        assert.ok(tabHost);
      }
    },
  },
  {
    name: '[integration] Apply estimated pi → PRiSM_getWell().pi (C1) with provenance deconvolution',
    wp: 'WP11',
    integration: true,
    run(app, assert) {
      assert.fn(app.win.PRiSM_getWell, 'C1 getWell');
      assert.fn(app.win.PRiSM_setWell, 'C1 setWell');
      const ds = synthMultiRate(app, [{ t0: 0, q: 850 }, { t0: 24, q: 0 }], 72, 40);
      app.win.PRiSM_dataset = app.toWin(ds);
      const res = app.win.PRiSM_deconvolveDataset();
      const v = app.win.PRiSM_applyDeconvolvedPi(res.p_initial);
      assert.near(app.win.PRiSM_getWell().pi, v, 1e-6);
      assert.near(v, TRUTH.pi, 5);
      assert.equal(app.win.PRiSM_pvt.provenance.p_res, 'deconvolution');
    },
  },
  {
    name: '[integration] inverse simulation from the seeded sample well (C1 META) + setLastFit (C4) → 850 STB/d',
    wp: 'WP11',
    integration: true,
    run(app, assert) {
      app.openPRiSM();                                          // seeds the sample + META well (WP8)
      assert.fn(app.win.PRiSM_setLastFit, 'C4 setLastFit');
      app.win.PRiSM_setLastFit(app.toWin({ modelKey: 'homogeneous', params: { Cd: 80, S: 2.5 }, phys: { k: 45, kh: 1575 } }));
      const r = app.win.PRiSM_inverseSimDataset();
      assert.equal(r.pRefSource, 'pi');
      assert.rel(median(Array.from(r.q)), 850, 0.02);
    },
  },
];
