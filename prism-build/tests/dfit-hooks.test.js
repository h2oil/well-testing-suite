// DFIT — WPH generic PRiSM hooks (docs/DFIT-PLAN.md §2.3, §3.12, §9 WPH). No DFIT logic: every hook is exercised
// with a dummy workspace mode `PRiSM_modeExt.test` registered after 01 / 37 have loaded.
//
//   H1  O(n) Bourdet (02) and _bourdetOnLn (33) identical to the old loops (log-spaced, uniform, superposition time,
//       NaN, duplicate t, t ≤ 0, unsorted); linear work (4,000 points < 2.5 × 2,000); C2 on 4,000 uniform falloff points
//   H2  window aliases of the 02 helpers
//   H3  opts.hoverEvent → prism:plot-hover; canvas._prismPointerOwner suppresses the box gesture
//   H4  _defaultKinds honours entry.axes; PTA-kind post-draw hooks (51 saved fits, 21 overlays) skip a kind:'dfit' entry
//   H5  the dummy mode: select option, step labels, step views 2 and 4 in #prism_stepview, gotoStep(4) survives
//       refreshShell and a reload, #prism_tabs hidden, ext rail and status, exact panels per mode, built-in modes unchanged
//   H6  PRiSM_undoExtras round trip, PRiSM_undoBatch (also ended after a rejection), ext rail + step view after undo,
//       'dfit' in STATE_FIELDS and P.step survive a reload
//   H7  report section with modes + blocks (3 tables, verdict, 2 plots) in Tab 7 and PDF, only in its mode;
//       PRiSM_reportKeyLine / PRiSM_reportReady; the gallery lists only ext.reportPlots, no mode:'test' entry in combined
//   H8  PRiSM_rng(1) reproduces the 05 bootstrap sequence; PRiSM_rng(undefined) deterministic
//   H9  CSV with surface pressure in psig, bbl/min rate and temperature → all channels + meta.psigConverted, after a reload
//   H10 RTA linear flow takes k from PRiSM_dfit_kConstraint when no input or fit exists
//   H11 PRiSM_toolCatalogueExtra: only in its modes ('*' everywhere), de-duplicated, never under "More"
//   H12 PRiSM_plot_overlay draws on the cached frame without calling the plot function
//   H13 PRiSM_drawPlot on a second canvas runs each post-draw hook once with its plotKey; drawActivePlot unchanged
//   H14 'dfit' in PRISM_KEYS (project round trip), 30-quick-report key line in an ext mode, store:false analysis keys
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WP = 'DFH';
const BUILD = path.join(__dirname, '..');

// ── the pre-WPH loops, copied verbatim (reference for H1) ─────────────────────────────────────────────────────────
function oldBourdet(t, dp, L) {
  L = (isFinite(L) && L > 0) ? L : 0;
  const n = t.length;
  const d = new Array(n).fill(NaN);
  if (n < 3) return d;
  for (let i = 1; i < n - 1; i++) {
    if (!isFinite(t[i]) || t[i] <= 0 || !isFinite(dp[i])) continue;
    let i1 = i - 1, i2 = i + 1;
    if (L > 0) {
      const lnT = Math.log(t[i]);
      while (i1 > 0 && lnT - Math.log(t[i1]) < L) i1--;
      while (i2 < n - 1 && Math.log(t[i2]) - lnT < L) i2++;
    }
    const t1 = t[i1], t2 = t[i2], ti = t[i];
    if (!isFinite(t1) || !isFinite(t2) || t1 <= 0 || t2 <= 0) continue;
    const dl1 = Math.log(ti) - Math.log(t1);
    const dl2 = Math.log(t2) - Math.log(ti);
    const dlT = Math.log(t2) - Math.log(t1);
    if (dl1 === 0 || dl2 === 0 || dlT === 0) continue;
    const a = (dp[i] - dp[i1]) / dl1 * (dl2 / dlT);
    const b = (dp[i2] - dp[i]) / dl2 * (dl1 / dlT);
    d[i] = a + b;
  }
  return d;
}
const _num = (v) => typeof v === 'number' && isFinite(v);
function oldBourdetOnLn(lx, y, L) {
  L = (_num(L) && L > 0) ? L : 0;
  let n = lx.length, d = new Array(n), i;
  for (i = 0; i < n; i++) d[i] = NaN;
  if (n < 3) return d;
  for (i = 1; i < n - 1; i++) {
    if (!_num(lx[i]) || !_num(y[i])) continue;
    let i1 = i - 1, i2 = i + 1;
    if (L > 0) {
      while (i1 > 0 && lx[i] - lx[i1] < L) i1--;
      while (i2 < n - 1 && lx[i2] - lx[i] < L) i2++;
    }
    const dl1 = lx[i] - lx[i1], dl2 = lx[i2] - lx[i], dlT = lx[i2] - lx[i1];
    if (!_num(dl1) || !_num(dl2) || !_num(dlT) || dl1 === 0 || dl2 === 0 || dlT === 0) continue;
    if (!_num(y[i1]) || !_num(y[i2])) continue;
    d[i] = (y[i] - y[i1]) / dl1 * (dl2 / dlT) + (y[i2] - y[i]) / dl2 * (dl1 / dlT);
  }
  return d;
}
// 33's current _bourdetOnLn, extracted from the source and run in a bare context
function newBourdetOnLn() {
  const src = fs.readFileSync(path.join(BUILD, '33-pta-core.js'), 'utf8');
  const a = src.indexOf('function _bourdetOnLn(lx, y, L) {');
  const b = src.indexOf('// Prefer the shared plot-layer implementation');
  if (a < 0 || b < 0) throw new Error('_bourdetOnLn not found in 33-pta-core.js');
  const ctx = { _num: _num };
  vm.createContext(ctx);
  vm.runInContext(src.slice(a, b), ctx);
  return ctx._bourdetOnLn;
}

// seeded PRNG for the test sets (mulberry32)
function rng(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function bourdetSets() {
  const R = rng(11), sets = [];
  const mk = (name, t) => { const y = t.map((x) => (x > 0 ? 30 * Math.log(x) : 0) + 2 * R()); sets.push({ name, t, y }); };
  mk('log-spaced', Array.from({ length: 300 }, (_, i) => 1e-3 * Math.pow(10, i * 6 / 299)));
  mk('uniform', Array.from({ length: 400 }, (_, i) => 0.01 + i * 0.05));
  // superposition time (single-rate falloff after tp = 12 h): exp of ln(Δt/(tp+Δt)) + ln tp
  mk('superposition', Array.from({ length: 250 }, (_, i) => { const dt = 1e-3 * Math.pow(10, i * 5 / 249); return Math.exp(Math.log(dt / (12 + dt)) + Math.log(12)); }));
  const nanSet = Array.from({ length: 200 }, (_, i) => 0.01 * Math.pow(1.04, i));
  const s = { name: 'NaN in y', t: nanSet, y: nanSet.map((x, i) => (i % 17 === 5 ? NaN : 25 * Math.log(x) + R())) };
  sets.push(s);
  const dup = Array.from({ length: 220 }, (_, i) => 0.1 + Math.floor(i / 3) * 0.07);
  mk('duplicate t', dup);
  mk('t <= 0', Array.from({ length: 150 }, (_, i) => -0.5 + i * 0.02));
  const nanT = Array.from({ length: 150 }, (_, i) => (i === 40 ? NaN : 0.05 + i * 0.03));
  mk('NaN in t', nanT);
  mk('unsorted', Array.from({ length: 160 }, () => 0.01 + 50 * R()));
  return sets;
}
function sameArrays(a, b) {
  let worst = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (Number.isNaN(x) && Number.isNaN(y)) continue;
    if (Number.isNaN(x) !== Number.isNaN(y)) return Infinity;
    const r = Math.abs(x - y) / Math.max(1e-300, Math.abs(y));
    if (r > worst) worst = r;
  }
  return a.length === b.length ? worst : Infinity;
}

// ── the dummy workspace mode (app realm) ─────────────────────────────────────────────────────────────────────────────
const EXT_SRC = `
(function () {
  var W = window;
  W.__ext = { log: [], v: 1, sv2: 0, sv4: 0, rail: 0 };
  W.PRiSM_PLOT_REGISTRY.testPlot = {
    label: 'Test plot', mode: 'test', kind: 'dfit', axes: { x: 'log', y: 'lin' },
    fn: function (c, d, o) { W.__ext.plotCalls = (W.__ext.plotCalls || 0) + 1; return W.PRiSM_plot_cartesian(c, d, o); },
    build: function (ctx) { var ds = ctx.ds; return (ds && ds.t && ds.p) ? { data: { t: ds.t.slice(), p: ds.p.slice(), q: null } } : null; }
  };
  W.PRiSM_PLOT_REGISTRY.testPlot2 = {
    label: 'Test plot 2', mode: 'test', kind: 'dfit', axes: { x: 'lin', y: 'lin' },
    fn: function (c, d, o) { return W.PRiSM_plot_cartesian(c, d, o); },
    build: function (ctx) { var ds = ctx.ds; return (ds && ds.t && ds.p) ? { data: { t: ds.t.slice(), p: ds.p.slice(), q: null } } : null; }
  };
  W.PRiSM_registerTabPanel(1, { id: 'tpanel', title: 'Test panel', order: 5, modes: ['test'],
    when: function () { return W.PRiSM && W.PRiSM.mode === 'test'; },
    render: function (b) { b.innerHTML = '<div id="tx_panel">test panel</div>'; } });
  W.PRiSM_modeExt = W.PRiSM_modeExt || {};
  W.PRiSM_modeExt.test = {
    label: 'Test mode (hooks)',
    steps: { 1: 'T-Data', 2: 'T-Two', 3: 'T-Three', 4: { label: 'T-Four' }, 5: 'T-Report' },
    tabs: { 1: 1, 3: 2, 5: 7 },
    stepView: {
      2: function (host) { W.__ext.sv2++; host.innerHTML = '<div class="card" id="tx_sv2">two ' + W.__ext.v + '</div>'; },
      4: function (host) { W.__ext.sv4++; host.innerHTML = '<div class="card" id="tx_sv4">four ' + W.__ext.v + '</div>'; }
    },
    defaultPlot: 'testPlot',
    panelAllow: ['crop'],
    plotsTab: { hide: ['period', 'timeFn', 'overlay'] },
    note: 'Test mode shows pressure models.',
    rail: function (el) { W.__ext.rail++; el.innerHTML = '<div id="tx_rail">rail ' + W.__ext.v + '</div>'; },
    status: function () { return { 1: true, 2: false, 3: true, 4: false }; },
    analyse: function (opts) { W.__ext.log.push('analyse'); return Promise.resolve({ ok: true }); },
    onEnter: function (prev) { W.__ext.log.push('enter:' + prev + ':' + W.PRiSM.mode); },
    onLeave: function (next) { W.__ext.log.push('leave:' + next + ':' + W.PRiSM.mode); },
    reportHeader: function () { return { title: 'Test report', keyRows: [['Closure', '7,000 psia']], keyLine: 'TEST · closure 7,000 psia' }; },
    reportPlots: [{ key: 'testPlot', title: 'Test plot in the report' }],
    reportLegacySections: false,
    exportItems: [{ id: 'tx', label: 'Test export', fn: function () { W.__ext.log.push('export'); } }]
  };
})();`;
function installExt(app) { app.evalInApp(EXT_SRC); }

const TOOL_IDS_PROBE = `(function () { return JSON.stringify(window.PRiSM_listTools().map(function (t) { return t.id + '|' + t.group; })); })()`;

// a small falloff dataset (pressure falls after a 10 h injection)
function falloffDs(n) {
  const t = [], p = [], q = [];
  for (let i = 0; i < n; i++) {
    const tt = 10 + 0.01 + i * (40 / n);
    t.push(tt); p.push(5000 - 300 * Math.log(1 + (tt - 10))); q.push(0);
  }
  t.unshift(0); p.unshift(5200); q.unshift(-500);
  return { t, p, q };
}
function demo(app) {
  app.openPRiSM();
  return app.win.PRiSM_dataset;
}
function stepLabels(app) {
  return [1, 2, 3, 4, 5].map((n) => { const b = app.el('prism_step_btn_' + n); const l = b && b.querySelector('.prism-step-label'); return l ? l.textContent : null; });
}
function panelIds(app, n) {
  const host = app.el('prism_tab_' + n + '_panels');
  if (!host) return [];
  return Array.from(host.querySelectorAll('.prism-panel')).map((c) => c.getAttribute('data-panel-id'));
}
function plotOptions(app) {
  const s = app.el('prism_plot_picker');
  return s ? Array.from(s.querySelectorAll('option')).map((o) => o.value) : [];
}
function mkCanvas(app, w, h) {
  const c = app.document.createElement('canvas');
  c.setAttribute('width', String(w || 800)); c.setAttribute('height', String(h || 450));
  app.document.body.appendChild(c);
  return c;
}
function ptr(app, c, type, x, y) {
  c.dispatchEvent(new app.win.PointerEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0 }));
}
function strokeOps(ops) { return ops.filter((e) => e.op === 'stroke' || e.op === 'fill' || e.op === 'fillRect' || e.op === 'lineTo' || e.op === 'fillText'); }
async function settle(app, promise, maxMs) {
  let done = false, value, error;
  promise.then((v) => { done = true; value = v; }, (e) => { done = true; error = e; });
  for (let t = 0; !done && t < (maxMs || 5000); t += 20) await app.flushAsync(20);
  if (!done) throw new Error('promise did not settle');
  if (error) throw error;
  return value;
}
function noErrors(app, assert) {
  assert.equal(app.errors.length, 0, 'no listener / timer errors: ' + app.errors.map((e) => e.message).join('; '));
}

module.exports = [
  {
    name: 'H1 O(n) Bourdet identical to the old loops (02 + 33) on log / uniform / superposition / NaN / duplicate / t≤0 / unsorted sets; linear work; C2 on 4,000 points',
    wp: WP,
    run(app, assert, ctx) {
      const W = app.win;
      const onLn = newBourdetOnLn();
      for (const s of bourdetSets()) {
        for (const L of [0, 0.05, 0.1, 0.2, 0.5, 2]) {
          // plain arrays (app.toWin would turn NaN into null)
          const got = Array.from(W.PRiSM_compute_bourdet(s.t, s.y, L));
          const want = oldBourdet(s.t, s.y, L);
          const d = sameArrays(got, want);
          assert(d <= 1e-12, '02 ' + s.name + ' L=' + L + ': max relative difference ' + d);
          const lx = s.t.map((x) => Math.log(x));
          const d2 = sameArrays(onLn(lx, s.y, L), oldBourdetOnLn(lx, s.y, L));
          assert(d2 <= 1e-12, '33 ' + s.name + ' L=' + L + ': max relative difference ' + d2);
        }
      }
      // linear work: Math.log calls of the app realm on uniform t (the old loop's window grows with n)
      app.evalInApp('window.__lnN = 0; window.__lnOrig = Math.log; Math.log = function (x) { window.__lnN++; return window.__lnOrig(x); };');
      const work = (n) => {
        const t = Array.from({ length: n }, (_, i) => 0.01 + i * 0.01), y = t.map((x) => 40 * Math.log(x));
        W.__lnN = 0;
        W.PRiSM_compute_bourdet(app.toWin(t), app.toWin(y), 0.1);
        return W.__lnN;
      };
      const w2 = work(2000), w4 = work(4000);
      app.evalInApp('Math.log = window.__lnOrig;');
      assert(w2 > 0 && w4 < 2.5 * w2, 'operation count 4,000 vs 2,000 points: ' + w4 + ' vs ' + w2);
      // C2 on 4,000 uniform falloff points (real time; the plan's --perf budget is 60 ms)
      const ds = falloffDs(4000);
      W.PRiSM_dataset = app.toWin(ds);
      const t0 = process.hrtime.bigint();
      const ad = W.PRiSM_getAnalysisData(W.PRiSM_dataset, app.toWin({ L: 0.1 }));
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      assert(ad && ad.ok, 'C2 analysis data ok on 4,000 points: ' + (ad && ad.reason));
      assert(ms < 250, 'C2 on 4,000 uniform falloff points: ' + ms.toFixed(1) + ' ms');
      if (ctx && ctx.note) ctx.note('C2 4,000 pts ' + ms.toFixed(1) + ' ms; ln calls ' + w2 + ' / ' + w4);
    },
  },
  {
    name: 'H2 window aliases: PRiSM_plot_finish, _straightLine, _keyPoint, _clip, PRiSM_THEME, PRiSM_plot_overlay',
    wp: WP,
    run(app, assert) {
      const W = app.win;
      ['PRiSM_plot_finish', 'PRiSM_plot_straightLine', 'PRiSM_plot_keyPoint', 'PRiSM_plot_clip', 'PRiSM_plot_overlay', 'PRiSM_drawPlot', 'PRiSM_rng',
        'PRiSM_undoBatch', 'PRiSM_reportKeyLine', 'PRiSM_reportReady'].forEach((k) => assert.equal(typeof W[k], 'function', k));
      assert(W.PRiSM_THEME && typeof W.PRiSM_THEME.accent === 'string', 'PRiSM_THEME');
      assert(W.PRiSM_undoExtras && typeof W.PRiSM_undoExtras === 'object' && Array.isArray(W.PRiSM_toolCatalogueExtra), 'registries exist');
    },
  },
  {
    name: 'H3 opts.hoverEvent dispatches prism:plot-hover {plotKey, x, y, index}; the pointer owner suppresses the box gesture',
    wp: WP,
    run(app, assert) {
      const W = app.win;
      demo(app);
      const ds = W.PRiSM_dataset;
      const c = mkCanvas(app);
      W.PRiSM_plot_cartesian(c, app.toWin({ t: Array.from(ds.t), p: Array.from(ds.p), q: null }), app.toWin({ hover: true, dragZoom: true, hoverEvent: true, plotKey: 'hk' }));
      const got = [];
      app.document.body.addEventListener('prism:plot-hover', (e) => got.push(e.detail));
      const ax = c._prismAxes;
      const px = ax.plot.x + ax.plot.w / 2, py = ax.plot.y + ax.plot.h / 2;
      ptr(app, c, 'pointermove', px, py);
      assert.equal(got.length, 1, 'one hover event (bubbles to body)');
      assert.equal(got[0].plotKey, 'hk');
      assert.near(got[0].x, ax.fromX(px), 1e-9 * Math.abs(ax.fromX(px)) + 1e-12, 'world x');
      assert.near(got[0].y, ax.fromY(py), 1e-9 * Math.abs(ax.fromY(py)) + 1e-12, 'world y');
      assert(got[0].index === null || (Number.isInteger(got[0].index) && got[0].index >= 0), 'index: ' + got[0].index);
      ptr(app, c, 'pointermove', 1, 1);
      assert.equal(got.length, 1, 'no event outside the plot box');
      // without hoverEvent: no event
      const c2 = mkCanvas(app);
      W.PRiSM_plot_cartesian(c2, app.toWin({ t: Array.from(ds.t), p: Array.from(ds.p), q: null }), app.toWin({ hover: true, dragZoom: true, plotKey: 'hk2' }));
      ptr(app, c2, 'pointermove', px, py);
      assert.equal(got.length, 1, 'plain plots fire no hover event');
      // pointer owner
      const min0 = c._prismAxes.scaleX.min;
      let owned = 0;
      c._prismPointerOwner = function () { owned++; return true; };
      ptr(app, c, 'pointerdown', px - 100, py - 60); ptr(app, c, 'pointermove', px + 100, py + 60); ptr(app, c, 'pointerup', px + 100, py + 60);
      assert.equal(owned, 1, 'owner asked on pointerdown');
      assert.equal(c._prismAxes.scaleX.min, min0, 'owned gesture: no box zoom');
      c._prismPointerOwner = function () { return false; };
      ptr(app, c, 'pointerdown', px - 100, py - 60); ptr(app, c, 'pointermove', px + 100, py + 60); ptr(app, c, 'pointerup', px + 100, py + 60);
      assert.notEqual(c._prismAxes.scaleX.min, min0, 'owner declined: box zoom as before');
      noErrors(app, assert);
    },
  },
  {
    name: 'H4 _defaultKinds honours entry.axes; PTA-kind post-draw hooks (51 saved fits, 21 overlays) do not draw on a kind:dfit entry',
    wp: WP,
    run(app, assert) {
      const W = app.win;
      demo(app);
      installExt(app);
      app.evalInApp(`window.PRiSM_analysisKeys.__axesProbe = { label: 'Axes probe', plot: 'testPlot', clicks: 1, store: false,
        action: function (pts) { window.__kinds = pts[0].xKind + '/' + pts[0].yKind; return { values: {} }; } };`);
      const r = W.PRiSM_runAnalysisKey('__axesProbe', app.toWin([{ x: 2, y: 3 }]), app.toWin({ plotKey: 'testPlot' }));
      assert(r.ok, 'probe ran: ' + r.error);
      assert.equal(W.__kinds, 'log/lin', 'registry axes used');
      W.PRiSM_runAnalysisKey('__axesProbe', app.toWin([{ x: 2, y: 3 }]), app.toWin({ plotKey: 'bourdet' }));
      assert.equal(W.__kinds, 'log/log', 'built-in kinds unchanged');
      // 51: a saved-fit compare selection with the overlay on; 21: a visible overlay item
      const st = W.PRiSM_state;
      st.fitWorkspace = app.toWin({ overlay: true, compare: ['f1'] });
      st.fits = app.toWin([{ id: 'f1', name: 'Fit 1', fit: { modelKey: 'homogeneous', params: { Cd: 80, S: 2.5 }, scales: { A: 104.78, B: 39854 } } }]);
      if (W.PRiSM_overlays && typeof W.PRiSM_overlays.add === 'function') { try { W.PRiSM_overlays.add('period:0'); } catch (e) { /* optional */ } }
      const c = mkCanvas(app);
      let mark = -1;
      app.win.__mark = () => { mark = c._log.length; };
      app.evalInApp(`(function () { var e = window.PRiSM_PLOT_REGISTRY.testPlot, f = e.fn;
        e.fn = function (cv, d, o) { var r = f(cv, d, o); window.__mark(); return r; }; })();`);
      assert(W.PRiSM_drawPlot(c, 'testPlot'), 'drawn');
      assert(mark > 0, 'plot function ran');
      const after = strokeOps(c._log.slice(mark));
      assert.equal(after.length, 0, 'no post-draw hook painted on the kind:dfit plot: ' + JSON.stringify(after.slice(0, 3)));
      noErrors(app, assert);
    },
  },
  {
    name: 'H5 dummy mode: select, labels, step views 2/4 in #prism_stepview, gotoStep(4) survives refresh + reload, #prism_tabs hidden, rail/status, exact panels, built-ins unchanged',
    wp: WP,
    run(app, assert) {
      const W = app.win;
      demo(app);
      // built-in baseline before the ext exists
      const base = {};
      for (const m of ['transient', 'decline', 'combined']) {
        W.PRiSM.setMode(m);
        W.PRiSM_gotoStep(3);
        base[m] = { labels: stepLabels(app), plots: plotOptions(app).join(','), panels1: (W.PRiSM_gotoStep(1), panelIds(app, 1)).join(','),
                    hasStepview: !!app.el('prism_stepview') };
      }
      W.PRiSM.setMode('transient');
      installExt(app);
      W.PRiSM_refreshShell();
      W.PRiSM.setMode('transient');   // re-render the shell so the select learns the mode
      const opts = Array.from(app.el('prism_testtype').querySelectorAll('option')).map((o) => o.value);
      assert.deepEqual(opts.slice(-2), ['combined', 'test'], 'ext option appended: ' + opts.join(','));
      app.change('prism_testtype', 'test');
      assert.equal(W.PRiSM.mode, 'test', 'select → setMode');
      assert.deepEqual(Array.from(W.__ext.log), ['enter:transient:test'], 'onEnter(prev) after the re-render');
      assert.deepEqual(stepLabels(app), ['T-Data', 'T-Two', 'T-Three', 'T-Four', 'T-Report']);
      assert.equal(app.el('prism_testtype').value, 'test', 'chip shows the mode');
      // step 2 / 4 step views
      W.PRiSM_gotoStep(2);
      assert(app.el('tx_sv2'), 'step 2 view rendered');
      assert.equal(app.el('prism_stepview').style.display, 'block');
      assert.equal(app.el('prism_step2').style.display, 'none', 'built-in step ② host hidden');
      W.PRiSM_gotoStep(4);
      assert(app.el('tx_sv4') && app.el('prism_stepview').contains(app.el('tx_sv4')), 'step 4 view in #prism_stepview');
      assert.equal(app.el('prism_tabs').style.display, 'none', '#prism_tabs hidden in the ext mode');
      for (let i = 3; i <= 6; i++) assert.equal(app.el('prism_tab_' + i).style.display, 'none', 'tab ' + i + ' hidden');
      W.PRiSM_refreshShell();
      assert.equal(W.PRiSM_currentStep(), 4, 'step 4 survives refreshShell');
      assert(app.el('prism_step_btn_4').classList.contains('is-active'));
      assert(app.el('tx_rail'), 'ext rail used');
      assert.equal(app.el('prism_step_tick_1').textContent, '✓');
      assert.equal(app.el('prism_step_tick_2').textContent, '', 'ext status used');
      assert.equal(app.el('prism_step_tick_3').textContent, '✓');
      // tab 2 in the ext mode: own plots, default plot, hidden controls
      W.PRiSM_gotoStep(3);
      assert.equal(app.el('prism_tab_2').style.display, 'block', 'step 3 → ext.tabs[3] = tab 2');
      assert.deepEqual(plotOptions(app), ['testPlot', 'testPlot2'], 'only mode:test plots');
      assert.equal(W.PRiSM_state.activePlot, 'testPlot', 'ext.defaultPlot');
      assert(!app.el('prism_plot_overlay') && !app.el('prism_plot_timefn') && !app.el('prism_plot_period'), 'plotsTab.hide');
      // panels: exactly the ext panel + the allow-list
      W.PRiSM_gotoStep(1);
      const reg1 = (W.PRiSM_tabPanels[1] || []).map((s) => s.id);
      const want = reg1.filter((id) => id === 'tpanel' || id === 'crop');
      assert.deepEqual(panelIds(app, 1).slice().sort(), want.slice().sort(), 'test-mode tab-1 panels: ' + panelIds(app, 1).join(','));
      assert(want.indexOf('tpanel') !== -1, 'the ext panel mounts');
      // a reload keeps the mode and step 4
      W.PRiSM_gotoStep(4);
      app.flush(400);
      const app2 = app.reload();
      try {
        app2.evalInApp(EXT_SRC);
        app2.openPRiSM();
        assert.equal(app2.win.PRiSM.mode, 'test', 'mode restored');
        assert.equal(app2.win.PRiSM_currentStep(), 4, 'step 4 restored');
        assert(app2.el('tx_sv4'), 'step view rendered after the reload');
      } finally { /* app2 is discarded */ }
      // back to the built-ins: unchanged
      app.change('prism_testtype', 'falloff');
      assert.equal(W.PRiSM.mode, 'transient');
      assert(W.__ext.log.indexOf('leave:transient:test') !== -1, 'onLeave(next) while the old mode is still set: ' + W.__ext.log.join(','));
      for (const m of ['transient', 'decline', 'combined']) {
        W.PRiSM.setMode(m);
        W.PRiSM_gotoStep(3);
        const now = { labels: stepLabels(app), plots: plotOptions(app).join(','), panels1: (W.PRiSM_gotoStep(1), panelIds(app, 1)).join(','), hasStepview: !!app.el('prism_stepview') };
        assert.deepEqual(now.labels, base[m].labels, m + ' labels');
        assert.equal(now.plots, base[m].plots, m + ' plot list (no mode:test entry)');
        assert.equal(now.panels1, base[m].panels1, m + ' tab-1 panels');
      }
      // step hosts (the same code path in all three built-in modes; checked in transient)
      W.PRiSM.setMode('transient');
      W.PRiSM_gotoStep(4);
      assert.equal(app.el('prism_stepview').style.display, 'none', 'step view host stays hidden');
      assert.equal(app.el('prism_tabs').style.display, 'flex', 'model sub-tabs shown on step 4');
      W.PRiSM.setMode('transient');
      W.PRiSM_gotoStep(2);
      assert.equal(app.el('prism_step2').style.display, 'block', 'built-in step ② view unchanged');
      noErrors(app, assert);
    },
  },
  {
    name: 'H6 undo extras: first undo keeps the extra, pick → undo → redo, a batch is one step (also after a rejection), ext rail + step view after undo, dfit + step persist',
    wp: WP,
    async run(app, assert) {
      const W = app.win;
      demo(app);
      installExt(app);
      app.evalInApp(`window.PRiSM_state.dfit = { picks: [] };
        window.PRiSM_undoExtras.test = {
          get: function () { return { v: window.__ext.v, picks: window.PRiSM_state.dfit.picks.slice() }; },
          set: function (o) { window.__ext.v = o.v; window.PRiSM_state.dfit.picks = o.picks.slice(); },
          events: ['prism:test-updated'] };
        window.__pick = function (v, src) { window.__ext.v = v; window.PRiSM_state.dfit.picks.push(v);
          window.dispatchEvent(new CustomEvent('prism:test-updated', { detail: { what: 'pick', source: src || 'user' } })); };`);
      W.PRiSM.setMode('test');
      W.PRiSM_gotoStep(4);
      // a first undo after load (the baseline predates the extra) leaves the extra alone
      W.PRiSM_setWell(app.toWin({ h: 61 }), app.toWin({ source: 'user' }));
      W.__ext.v = 5; W.PRiSM_state.dfit.picks.push(5);   // a silent change, not recorded
      assert(W.PRiSM_undo(), 'undo the well change');
      assert.equal(W.__ext.v, 5, 'the extra keeps its state on the first undo');
      W.PRiSM_workflow._resetHistory();
      // pick → undo → redo
      W.__pick(7);
      W.__pick(8);
      assert.deepEqual(Array.from(W.PRiSM_state.dfit.picks), [5, 7, 8]);
      const sv4 = W.__ext.sv4, rail = W.__ext.rail;
      assert(W.PRiSM_undo(), 'undo the pick');
      assert.equal(W.__ext.v, 7);
      assert.deepEqual(Array.from(W.PRiSM_state.dfit.picks), [5, 7]);
      assert(W.__ext.sv4 > sv4, 'the step view re-rendered after undo');
      assert(W.__ext.rail > rail && app.el('tx_rail') && /rail 7/.test(app.el('tx_rail').textContent), 'the ext rail after undo');
      assert(W.PRiSM_redo(), 'redo');
      assert.equal(W.__ext.v, 8);
      // events with source undo / restore are not recorded
      const depth0 = W.PRiSM_workflow.undoDepth().undo;
      W.__pick(9, 'restore');
      assert.equal(W.PRiSM_workflow.undoDepth().undo, depth0, 'source restore ignored');
      W.__pick(10);
      // a batch: several changes → one undo step
      const h0 = W.PRiSM_getWell().h;
      const depth1 = W.PRiSM_workflow.undoDepth().undo;
      assert.equal(W.PRiSM_undoBatch('begin'), 1);
      assert.equal(W.PRiSM_undoBatch('begin'), 2, 'nesting counter');
      W.__pick(11); W.__pick(12);
      W.PRiSM_setWell(app.toWin({ h: 62 }), app.toWin({ source: 'user' }));
      assert.equal(W.PRiSM_undoBatch('end'), 1);
      assert.equal(W.PRiSM_workflow.undoDepth().undo, depth1, 'nothing recorded inside the batch');
      assert.equal(W.PRiSM_undoBatch('end'), 0);
      assert.equal(W.PRiSM_workflow.undoDepth().undo, depth1 + 1, 'one snapshot for the outermost batch');
      W.PRiSM_undo();
      assert.equal(W.__ext.v, 10, 'one undo reverts the whole batch');
      assert.equal(W.PRiSM_getWell().h, h0, 'the batch well change is undone too');
      // a batch ended after a rejected job is still one step
      const depth2 = W.PRiSM_workflow.undoDepth().undo;
      W.PRiSM_undoBatch('begin');
      const job = new W.Promise((res, rej) => { W.__pick(20); W.__pick(21); rej(new W.Error('cancelled')); });
      await settle(app, job.then(() => 'ok', () => 'rejected').then((r) => { W.PRiSM_undoBatch('end'); return r; }));
      assert.equal(W.PRiSM_workflow.undoDepth().undo, depth2 + 1, 'rejected batch = one step');
      W.PRiSM_undo();
      assert.equal(W.__ext.v, 10);
      // Analyse in the ext mode is the ext's
      const r = await settle(app, W.PRiSM_analyse());
      assert(r && r.ok && W.__ext.log.indexOf('analyse') !== -1, 'ext.analyse dispatched by 37');
      // 'dfit' in STATE_FIELDS and P.step survive a reload
      W.PRiSM_saveState();
      const app2 = app.reload();
      assert.deepEqual(app2.win.PRiSM_state.dfit && Array.from(app2.win.PRiSM_state.dfit.picks), [5, 7, 8, 9, 10], 'st.dfit restored');
      assert.equal(app2.win.PRiSM.step, 4, 'P.step restored');
      noErrors(app, assert);
    },
  },
  {
    name: 'H7 a section with modes + blocks (3 tables, verdict, 2 plots) in Tab 7 and PDF only in its mode; key line / ready; gallery = ext.reportPlots, none in combined',
    wp: WP,
    run(app, assert) {
      const W = app.win;
      demo(app);
      installExt(app);
      app.evalInApp(`(function () {
        var f = function () { return { id: 'tsec', title: 'Test section', order: 10, blocks: [
          { kind: 'kv', pairs: [['ISIP', '7,400 psia']] },
          { kind: 'table', title: 'Table A', head: ['a', 'b'], rows: [['1', '2']] },
          { kind: 'table', title: 'Table B', head: ['c'], rows: [['3'], ['4']] },
          { kind: 'table', head: ['d', 'e', 'f'], rows: [['<x>', '6', '7']] },
          { kind: 'verdict', level: 'warn', text: 'Closure is a range' },
          { kind: 'plot', key: 'testPlot', title: 'Block plot 1' },
          { kind: 'plot', key: 'testPlot2', title: 'Block plot 2' },
          { kind: 'notes', items: ['A note.'] } ] }; };
        f.modes = ['test'];
        window.PRiSM_reportSections = window.PRiSM_reportSections || [];
        window.PRiSM_reportSections.push(f);
      })();`);
      // built-in mode: the section does not print, key line '' and ready follows the host rule
      const pdfT = W.PRiSM_buildReportHTML();
      assert(!/Test section/.test(pdfT), 'not in transient');
      assert.equal(W.PRiSM_reportKeyLine(), '', 'no key line in a built-in mode');
      const st = W.PRiSM_state;
      const hostRule = !!(((W.PRiSM_getLastFit && W.PRiSM_getLastFit()) || st.lastFit || (st.model && W.PRiSM_dataset)) && typeof W.PRiSM_buildReportHTML === 'function');
      assert.equal(W.PRiSM_reportReady(), hostRule, 'ready = the host rule in transient');
      // PDF in the ext mode
      W.PRiSM.setMode('test');
      const pdf = W.PRiSM_buildReportHTML();
      assert(/Test report/.test(pdf) && /TEST · closure 7,000 psia/.test(pdf), 'ext header and key line');
      assert(/Test section/.test(pdf), 'section printed in its mode');
      assert.equal((pdf.match(/<table class="rp-tbl">/g) || []).length, 3, 'three tables');
      assert(/Table A/.test(pdf) && /Table B/.test(pdf) && /&lt;x&gt;/.test(pdf), 'table titles; cells escaped');
      assert(/⚠ Closure is a range/.test(pdf), 'verdict');
      assert(/Block plot 1/.test(pdf) && /Block plot 2/.test(pdf), 'plot blocks');
      assert.equal((pdf.match(/<img src="data:image\/png/g) || []).length, 3, 'two block plots + one report plot as PNG');
      assert(!/Key results \(field units\)<\/h2>.*Quantity/.test(pdf) && !/Fit quality/.test(pdf), 'no PTA blocks (reportLegacySections false)');
      assert.equal(W.PRiSM_reportKeyLine(), 'TEST · closure 7,000 psia');
      assert.equal(W.PRiSM_reportReady(), true);
      // Tab 7
      W.PRiSM_gotoStep(5);
      const tab = app.el('prism_tab_7');
      assert(/Test section/.test(tab.innerHTML) && tab.querySelectorAll('table.prism-rpt-tbl').length >= 3, 'Tab 7 blocks');
      const blockCanvases = Array.from(tab.querySelectorAll('canvas[data-prism-block-plot]'));
      assert.equal(blockCanvases.length, 2, 'two block canvases');
      blockCanvases.forEach((cv) => assert(cv._prismAxes && cv._prismAxes.plotKey === cv.getAttribute('data-plot-key'), 'block plot drawn: ' + cv.getAttribute('data-plot-key')));
      assert(tab.querySelector('canvas[data-plot-key="testPlot"]#prism_report_plot_x_testPlot'), 'ext.reportPlots on Tab 7');
      // the PDF gallery (11): only ext.reportPlots in the ext mode, none of them in combined
      let gallery = '';
      W.__reportOverride = (title, html) => { gallery = html; };
      W.PRiSM_exportReportPDF();
      const h3 = (gallery.match(/<h3 style="margin:6px 0;">([^<]*)<\/h3>/g) || []).map((x) => x.replace(/<[^>]+>/g, ''));
      assert.deepEqual(h3, ['Test plot in the report'], 'gallery in the ext mode: ' + h3.join(','));
      W.PRiSM.setMode('combined');
      W.PRiSM_exportReportPDF();
      const h3c = (gallery.match(/<h3 style="margin:6px 0;">([^<]*)<\/h3>/g) || []).map((x) => x.replace(/<[^>]+>/g, ''));
      assert(h3c.length > 0 && h3c.indexOf('Test plot') === -1 && h3c.indexOf('Test plot 2') === -1, 'combined gallery has no mode:test plot: ' + h3c.join(','));
      assert(!/Test section/.test(W.PRiSM_buildReportHTML()), 'section not printed in combined');
      noErrors(app, assert);
    },
  },
  {
    name: 'H8 PRiSM_rng(1) reproduces the 05 bootstrap sequence; PRiSM_rng(undefined) is deterministic (never Math.random)',
    wp: WP,
    run(app, assert) {
      const W = app.win;
      const r1 = W.PRiSM_rng(1), seq = [];
      for (let i = 0; i < 6; i++) seq.push(r1());
      const ref = rng(1), want = [];
      for (let i = 0; i < 6; i++) want.push(ref());
      assert.deepEqual(seq, want, 'mulberry32 seed 1');
      const a = W.PRiSM_rng(undefined), b = W.PRiSM_rng(null), c = W.PRiSM_rng(1);
      for (let i = 0; i < 5; i++) { const x = a(); assert.equal(x, b()); assert.equal(x, c()); }
      // the bootstrap with seed 1 draws its residual indices from the same sequence: constant model, one replicate
      const n = 9, t = Array.from({ length: n }, (_, i) => i + 1), p = t.map((x) => (x * 7) % 5 + 100);
      const mean = p.reduce((s, v) => s + v, 0) / n;
      app.evalInApp('window.__constModel = function (tt, pr) { return tt.map(function () { return pr.a; }); };');
      const boot = W.PRiSM_bootstrap(W.__constModel, app.toWin({ t, p }), app.toWin({ a: mean }), app.toWin({ nBootstrap: 1, seed: 1, lmOpts: { maxIter: 40, tolerance: 1e-12 } }));
      const g = W.PRiSM_rng(1);
      let s = 0;
      for (let i = 0; i < n; i++) { let idx = (g() * n) | 0; if (idx >= n) idx = n - 1; s += mean + (p[idx] - mean); }
      const dist = boot.distributions.a;
      assert(dist && dist.length === 1, 'one replicate');
      assert.near(dist[0], s / n, 1e-6, 'bootstrap replicate = mean of the resample drawn with PRiSM_rng(1)');
      const src = fs.readFileSync(path.join(BUILD, '05-regression.js'), 'utf8');
      assert(/G\.PRiSM_rng = function \(seed\) \{ return _makeRng\(seed == null \? 1 : seed\); \};/.test(src), 'the one-line export');
    },
  },
  {
    name: 'H9 a CSV with surface pressure in psig, bbl/min rate and temperature keeps every channel and meta.psigConverted after a reload',
    wp: WP,
    run(app, assert) {
      const W = app.win;
      const rows = ['time_h,pressure_psia,pressure_surf_psig,rate_bbl/min,temp_F,pressure_ann_psig,rate_fb_bbl/min'];
      for (let i = 0; i < 40; i++) {
        const t = i * 0.05, q = t < 0.5 ? 5 : 0;
        rows.push([t.toFixed(3), (7000 + (t < 0.5 ? 100 * t : -50 * t)).toFixed(2), (3000 - 20 * t).toFixed(2), q, (180 + t).toFixed(2), (100 + t).toFixed(1), t > 1.5 ? 0.5 : 0].join(','));
      }
      const csv = rows.join('\n');
      app.openPRiSM();
      const ds = W.PRiSM_datasetFromText(csv, app.toWin({ name: 'dfit.csv' }));
      assert(ds && ds.t.length === 40, 'parsed');
      const check = (d, what) => {
        assert(d.pSurf && d.pSurf.length === 40, what + ': pSurf');
        assert.near(d.pSurf[0], 3000 + 14.696, 1e-9, what + ': psig → psia');
        assert(d.pAnn && d.pAnn.length === 40 && Math.abs(d.pAnn[0] - 114.696) < 1e-9, what + ': pAnn psig → psia');
        assert(d.T && Math.abs(d.T[3] - 180.15) < 1e-9, what + ': temperature °F');
        assert.near(d.q[0], 5 * 1440, 1e-9, what + ': bbl/min → bbl/d');
        assert(d.qFb && Math.abs(d.qFb[39] - 720) < 1e-9, what + ': flowback rate bbl/min → bbl/d');
        assert.near(d.p[0], 7000, 1e-9, what + ': psia unchanged');
        assert(d.meta && d.meta.psigConverted && d.meta.psigConverted.pSurf === 14.696 && d.meta.psigConverted.pAnn === 14.696 && !('p' in d.meta.psigConverted),
          what + ': psig record ' + JSON.stringify(d.meta));
      };
      check(ds, 'parse');
      // commit through the Data tab (paste) so the text is persisted, then reload
      W.PRiSM_commitDataset(ds, app.toWin({ source: 'paste' }));
      const box = JSON.parse(app.storage.getItem('wts_prism') || '{}');
      box.prism_data_paste = csv;
      app.storage.setItem('wts_prism', JSON.stringify(box));
      const app2 = app.reload();
      app2.openPRiSM();
      check(app2.win.PRiSM_dataset, 'reload');
      // a psig main pressure is recorded too; a psia file carries no meta
      const ds2 = W.PRiSM_datasetFromText('time (h),BHP (psig),rate\n0,100,0\n1,90,0\n2,85,0\n3,80,0', app.toWin({}));
      assert(ds2.meta && ds2.meta.psigConverted.p === 14.696, 'main pressure psig recorded');
      const ds3 = W.PRiSM_datasetFromText('time,pressure,rate\n0,100,0\n1,90,0\n2,85,0\n3,80,0', app.toWin({}));
      assert(!ds3.meta && !ds3.pSurf && !ds3.T, 'plain files unchanged');
    },
  },
  {
    name: 'H10 RTA linear flow takes k from PRiSM_dfit_kConstraint when no input or fit exists',
    wp: WP,
    run(app, assert) {
      const W = app.win;
      // a rate-transient linear-flow set: q falls as 1/√t at constant pwf
      const t = [], q = [], p = [];
      for (let i = 1; i <= 60; i++) { const tt = i * 24; t.push(tt); q.push(800 / Math.sqrt(i)); p.push(1500); }
      W.PRiSM_dataset = app.toWin({ t, q, p, name: 'rta' });
      W.PRiSM_setWell(app.toWin({ pi: 5000, B: 1.2, h: 40, mu: 0.8, phi: 0.08, ct: 1.5e-5, rw: 0.3, q: 800 }), app.toWin({ source: 'user' }));
      W.PRiSM_state.lastFit = null;
      if (typeof W.PRiSM_setLastFit === 'function') { try { W.PRiSM_setLastFit(null); } catch (e) { /* optional */ } }
      const rta = W.PRiSM_rtaData ? W.PRiSM_rtaData(W.PRiSM_dataset) : null;
      assert(rta && rta.ok, 'rta data: ' + (rta && rta.reason));
      const before = W.PRiSM_rtaLinearFlow(rta, app.toWin({}));
      assert(before.ok && before.k === null && before.xf_sqrt_k > 0, 'no k without input / fit / DFIT: ' + JSON.stringify([before.ok, before.k]));
      app.evalInApp('window.PRiSM_dfit_kConstraint = function () { return { k: 0.004, kLo: 0.002, kHi: 0.008 }; };');
      const after = W.PRiSM_rtaLinearFlow(rta, app.toWin({}));
      assert.equal(after.k, 0.004, 'k from DFIT');
      assert.equal(after.kSource, 'DFIT after-closure');
      assert.near(after.xf, after.xf_sqrt_k / Math.sqrt(0.004), 1e-9);
      const withInput = W.PRiSM_rtaLinearFlow(rta, app.toWin({ k: 0.5 }));
      assert.equal(withInput.kSource, 'input', 'an input k still wins');
      app.evalInApp('window.PRiSM_dfit_kConstraint = function () { return null; };');
      assert.equal(W.PRiSM_rtaLinearFlow(rta, app.toWin({})).k, null, 'a null constraint is ignored');
    },
  },
  {
    name: 'H11 PRiSM_toolCatalogueExtra: only in its modes (\'*\' in all), de-duplicated, never under "More"',
    wp: WP,
    run(app, assert) {
      const W = app.win;
      demo(app);
      installExt(app);
      const before = JSON.parse(app.evalInApp(TOOL_IDS_PROBE));
      app.evalInApp(`
        window.PRiSM_renderTestDesignerTool = function (h) { h.innerHTML = '<div id="tx_designer">designer</div>'; };
        window.PRiSM_renderTestSandboxTool = function (h) { h.innerHTML = '<div id="tx_sandbox">sandbox</div>'; };
        window.PRiSM_toolCatalogueExtra.push(
          { id: 'tdesigner', fn: 'PRiSM_renderTestDesignerTool', group: 'Test', title: 'Test designer', sub: 'only in test', modes: ['test'] },
          { id: 'tsandbox', fn: 'PRiSM_renderTestSandboxTool', group: 'Test', title: 'Test sandbox', sub: 'every mode', modes: '*' },
          { id: 'tsandbox', fn: 'PRiSM_renderTestSandboxTool', group: 'Test', title: 'Duplicate', modes: '*' },
          { id: 'tfn', fn: function (h) { h.innerHTML = '<div id="tx_fn">fn</div>'; }, group: 'Test', title: 'Function tool', modes: ['test'] });`);
      const tr = JSON.parse(app.evalInApp(TOOL_IDS_PROBE));
      const added = tr.filter((x) => before.indexOf(x) === -1);
      assert.deepEqual(added, ['tsandbox|Test'], 'transient: only the "*" entry, once: ' + added.join(','));
      assert(!tr.some((x) => /TestDesigner|TestSandbox/.test(x)), 'never discovered under More');
      W.PRiSM.setMode('test');
      const te = JSON.parse(app.evalInApp(TOOL_IDS_PROBE));
      ['tdesigner|Test', 'tsandbox|Test', 'tfn|Test'].forEach((x) => assert(te.indexOf(x) !== -1, 'test mode lists ' + x));
      assert.equal(te.filter((x) => /^tsandbox\|/.test(x)).length, 1, 'de-duplicated by id');
      assert(!te.some((x) => /\|More$/.test(x) && /Test/.test(x)), 'nothing under More');
      // C7 panels in the drawer follow when() and modes in the ext mode
      assert(te.indexOf('tab1:tpanel|Step panels') !== -1, 'the ext panel is a step panel in its mode');
      W.PRiSM.setMode('transient');
      assert(JSON.parse(app.evalInApp(TOOL_IDS_PROBE)).indexOf('tab1:tpanel|Step panels') === -1, 'not in transient');
      assert.deepEqual(JSON.parse(app.evalInApp(TOOL_IDS_PROBE)).filter((x) => before.indexOf(x) === -1), ['tsandbox|Test'], 'transient list = baseline + "*" entry');
      // ext.exportItems join the Export menu in the ext mode only
      const exportLabels = () => { app.click('prism_export_btn'); const l = Array.from(app.el('prism_menu').querySelectorAll('[data-prism-menu]')).map((b) => b.textContent); app.click('prism_export_btn'); return l; };
      W.PRiSM.setMode('test');
      assert(exportLabels().indexOf('Test export') !== -1, 'ext export item listed');
      app.click('prism_export_btn');
      const tb = Array.from(app.el('prism_menu').querySelectorAll('[data-prism-menu]')).find((b) => b.textContent === 'Test export');
      app.click(tb);
      assert(W.__ext.log.indexOf('export') !== -1, 'ext export item runs');
      W.PRiSM.setMode('transient');
      assert(exportLabels().indexOf('Test export') === -1, 'not in transient');
      // opening the function tool works in the ext mode
      W.PRiSM.setMode('test');
      W.PRiSM_openTools();
      const item = Array.from(app.document.querySelectorAll('[data-tool-id], [data-prism-tool]')).find((b) => /tfn/.test(b.getAttribute('data-tool-id') || b.getAttribute('data-prism-tool') || ''));
      if (item) { app.click(item); assert(app.el('tx_fn'), 'function tool rendered'); }
      noErrors(app, assert);
    },
  },
  {
    name: 'H12 PRiSM_plot_overlay draws on the cached frame without calling the plot function',
    wp: WP,
    run(app, assert) {
      const W = app.win;
      demo(app);
      installExt(app);
      const c = mkCanvas(app);
      assert(W.PRiSM_drawPlot(c, 'testPlot'), 'drawn');
      const calls = W.__ext.plotCalls;
      const n0 = c._log.length;
      let gotAxes = null, gotPlot = null;
      const ok = W.PRiSM_plot_overlay(c, (ctx, axes, plot) => { gotAxes = axes; gotPlot = plot; ctx.beginPath(); ctx.moveTo(axes.toX(1), plot.y); ctx.lineTo(axes.toX(1), plot.y + plot.h); ctx.stroke(); });
      assert.equal(ok, true);
      assert.equal(W.__ext.plotCalls, calls, 'the plot function was not called');
      const ops = c._log.slice(n0);
      const di = ops.findIndex((e) => e.op === 'drawImage');
      const li = ops.findIndex((e) => e.op === 'lineTo');
      assert(di >= 0 && li > di, 'frame restored, then the cursor drawn');
      assert(gotAxes === c._prismAxes && gotPlot && gotPlot.w > 0, 'axes and plot box passed');
      assert(!ops.some((e) => e.op === 'resize' || e.op === 'clearRect'), 'no full redraw');
      assert.equal(W.PRiSM_plot_overlay(c, null), true, 'null drawFn restores the frame only');
      assert.equal(W.PRiSM_plot_overlay(mkCanvas(app), () => {}), false, 'an undrawn canvas → false');
      noErrors(app, assert);
    },
  },
  {
    name: 'H13 PRiSM_drawPlot on a second canvas runs each post-draw hook once with its own plotKey; PRiSM_drawActivePlot unchanged',
    wp: WP,
    run(app, assert) {
      const W = app.win;
      demo(app);
      W.PRiSM_gotoStep(3);
      const main = app.el('prism_plot_canvas');
      // the active plot (bourdet) before any hook spy
      W.PRiSM_drawActivePlot();
      const ref = JSON.stringify(main._log.slice(main._log.map((e) => e.op).lastIndexOf('resize')));
      const seen = [];
      app.win.__seen = (k, c) => seen.push([k, c]);
      app.evalInApp(`window.PRiSM_registerPostDrawHook(function (info) { window.__seen(info.plotKey, info.canvas.id || 'second'); });`);
      W.PRiSM_drawActivePlot();
      const after = main._log.slice(main._log.map((e) => e.op).lastIndexOf('resize'));
      // the spy hook draws nothing, so the active plot output is unchanged
      assert.equal(JSON.stringify(after), ref, 'drawActivePlot output unchanged');
      assert.deepEqual(seen.splice(0), [['bourdet', 'prism_plot_canvas']], 'active: hooks once with bourdet');
      installExt(app);
      const c2 = mkCanvas(app);
      assert(W.PRiSM_drawPlot(c2, 'testPlot', app.toWin({ title: 'Second' })), 'second canvas');
      assert.deepEqual(seen.splice(0), [['testPlot', 'second']], 'second: hooks once with its own plotKey');
      assert.equal(c2._prismAxes.plotKey, 'testPlot');
      assert.equal(main._prismAxes.plotKey, 'bourdet', 'main canvas untouched');
      assert.equal(W.PRiSM_state.activePlot, 'bourdet', 'active plot not changed');
      assert.equal(W.PRiSM_drawPlot(c2, 'noSuchPlot'), false, 'unknown key → false');
      noErrors(app, assert);
    },
  },
  {
    name: 'H14 \'dfit\' rides in PRISM_KEYS (project round trip), quick report uses PRiSM_reportKeyLine in an ext mode, store:false keys neither stored nor drawn',
    wp: WP,
    async run(app, assert) {
      const W = app.win;
      demo(app);
      installExt(app);
      // project round trip of a dummy st.dfit (two tests)
      const big = 'x'.repeat(210000);   // larger than the extra limit: only a PRISM_KEYS field survives
      W.PRiSM_state.dfit = app.toWin({ v: 1, tests: [{ id: 'T1', zone: 'A', blob: big }, { id: 'T2', zone: 'B' }] });
      const proj = W.WTS_project;
      const saved = await settle(app, proj.save('t.prism'));
      const payload = JSON.parse(JSON.stringify(saved.payload));
      const pm = payload.modules && payload.modules.prism;
      assert(pm && pm.dfit && pm.dfit.tests.length === 2, 'st.dfit in the prism module');
      assert(!(pm.extra && pm.extra.dfit), 'not carried in extra');
      W.PRiSM_state.dfit = null;
      proj.loadFromObject(app.toWin(payload));
      const d = W.PRiSM_state.dfit;
      assert(d && d.tests && d.tests.length === 2 && d.tests[0].blob.length === 210000 && d.tests[1].zone === 'B', 'st.dfit restored from the project');
      // quick report key line in the ext mode
      W.PRiSM.setMode('test');
      const html = String(W.WTS_quickReport.preview());
      assert(/TEST · closure 7,000 psia/.test(html), 'quick report shows the ext key line');
      assert(/Test mode \(hooks\)/.test(html), 'and the mode label');
      W.PRiSM.setMode('transient');
      assert(!/TEST · closure/.test(String(W.WTS_quickReport.preview())), 'not in transient');
      W.PRiSM.setMode('test');
      // store:false analysis keys
      app.evalInApp(`window.PRiSM_analysisKeys.__noStore = { label: 'No store', plot: 'testPlot', clicks: 2, store: false,
          action: function (pts) { return { values: { k: 1 } }; } };
        window.PRiSM_analysisKeys.__store = { label: 'Store', plot: 'testPlot', clicks: 2,
          action: function (pts) { return { values: { k: 2 } }; } };`);
      const r1 = W.PRiSM_runAnalysisKey('__noStore', app.toWin([{ x: 1, y: 5000 }, { x: 3, y: 4900 }]), app.toWin({ plotKey: 'testPlot' }));
      assert(r1.ok && r1.result.values.k === 1, 'store:false key returns its result');
      assert(!(W.PRiSM_state.analysisKeyResults || {}).__noStore, 'not stored');
      const r2 = W.PRiSM_runAnalysisKey('__store', app.toWin([{ x: 1, y: 5000 }, { x: 3, y: 4900 }]), app.toWin({ plotKey: 'testPlot' }));
      assert(r2.ok && W.PRiSM_state.analysisKeyResults.__store, 'a normal key is stored');
      // a stale stored entry of a store:false key is not drawn by linetools-picks
      W.PRiSM_state.analysisKeyResults.__noStore = app.toWin({ key: '__noStore', plotKey: 'testPlot', points: [{ x: 1, y: 5000 }, { x: 3, y: 4900 }], timestamp: 1 });
      delete W.PRiSM_state.analysisKeyResults.__store;
      const c = mkCanvas(app);
      let mark = -1;
      app.win.__mark2 = () => { mark = c._log.length; };
      app.evalInApp(`(function () { var e = window.PRiSM_PLOT_REGISTRY.testPlot, f = e.fn;
        e.fn = function (cv, d, o) { var r = f(cv, d, o); window.__mark2(); return r; }; })();`);
      W.PRiSM_drawPlot(c, 'testPlot');
      assert.equal(strokeOps(c._log.slice(mark)).length, 0, 'linetools-picks skips store:false keys');
      W.PRiSM_state.analysisKeyResults.__store2 = app.toWin({ key: '__store', plotKey: 'testPlot', points: [{ x: 1, y: 5000 }, { x: 3, y: 4900 }], timestamp: 2 });
      W.PRiSM_drawPlot(c, 'testPlot');
      assert(strokeOps(c._log.slice(mark)).length > 0, 'a stored key is still drawn');
      noErrors(app, assert);
    },
  },
];
