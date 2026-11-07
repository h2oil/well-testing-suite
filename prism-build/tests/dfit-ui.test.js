// DFIT — WP6 UI tests (docs/DFIT-PLAN.md §9 WP6, §2.6–2.11, §6.12, §6.13, §7).
//
// Built against FAKE engines (§2.12 rule 4): 57 (pipeline, Job, summarise, report, exports, hand-off), 58 (leak-off model,
// designer) and the 49-calc-dfit-synth demo are replaced in memory with stubs that return the frozen fixtures of
// tests/_dfit-shapes.js (FIX.run, FIX.ds, FIX.samples). The real 56 stays (range table and clamp, frozen in WP0).
// Tests that need the generic shell hooks of WPH (§3.12: PRiSM_modeExt read by 01/04/37, PRiSM_undoBatch, PRiSM_drawPlot,
// panel / Tools `modes`) check what they can without them and print "skip (WPH hooks absent): …" for the rest.
//
//   U1  select option + setMode('dfit') relabel the steps            U9  zero pending timers after Analyse + flush(5000)
//   U2  transient / decline / combined unchanged                     U10 exact mounted panel list per mode
//   U3  onEnter: falloff + multiRate q_eq, one undo step             U11 390 px structure (.dtable-wrap, rail sheet)
//   U4  every DFIT plot draws (axes rule, no foreign hook draws)      U12 the iOS CSS block exists
//   U5  dfit-picks hook registered once                              U13 numeric inputs clamp; counts integral; "1,5"
//   U6  dfitTangent pick: stored, logged, not in analysisKeyResults  U14 exact Tools list per mode
//   U7  a drag through the pointer owner commits one log entry       U15 tests table add / open / delete; overlay of two curves
//   U8  Analyse through the Job: progress, cancel keeps results      U16 method notes
'use strict';

const fs = require('fs');
const path = require('path');
const S = require('./_dfit-shapes');

const WP = 'WP6';
const BUILD = path.join(__dirname, '..');
const REPO = path.join(BUILD, '..');

// ── fake engines (sources injected in memory) ──
let _fakes = null;
function fakes() {
  if (_fakes) return _fakes;
  const RUN = JSON.stringify(S.FIX.run), DS = JSON.stringify(S.FIX.ds), SM = JSON.stringify(S.FIX.samples);
  const f57 = '(function () {\n' +
    "  'use strict';\n  var G = window, RUN = " + RUN + ';\n' +
    '  function c(o) { return JSON.parse(JSON.stringify(o)); }\n' +
    '  G.__dfitCalls = [];\n' +
    '  G.PRiSM_dfit_pipeline = function (ds, inputs, well, picks, opts) {\n' +
    '    var r = c(RUN); r.fast = !!(opts && opts.fast); if (r.fast) { r.unc = null; r.consensus.stability = null; }\n' +
    '    G.__dfitCalls.push({ fast: r.fast, picks: c(picks || {}), alpha: inputs && inputs.options && inputs.options.alpha });\n' +
    '    return r;\n  };\n' +
    '  G.PRiSM_dfit_pipelineJob = function () {\n' +
    '    var a = arguments, i = 0, n = 3, res = null, cancelled = false;\n' +
    "    return { step: function () { if (cancelled) return { done: true, progress: 1, label: 'cancelled' }; i++; if (i >= n) res = G.PRiSM_dfit_pipeline.apply(null, a); return { done: i >= n, progress: i / n, label: 'stage ' + i }; },\n" +
    '             result: function () { return res; }, cancel: function () { cancelled = true; } };\n  };\n' +
    '  G.PRiSM_dfit_summarise = function (run) { return c(run.summary); };\n' +
    '  G.PRiSM_dfit_reportModel = function (run) { return c(run.report); };\n' +
    "  G.PRiSM_dfit_exportText = function () { return { text: 'time_h,p_psia\\n0,4500\\n', filename: 'dfit-reference-18ec3a2a.txt' }; };\n" +
    "  G.PRiSM_dfit_fracSheet = function () { return { rows: [['closure', 'F1', 6995, 7000, 7005, 'psia', '', 'C1']], csv: 'name,p50\\nclosure,7000\\n' }; };\n" +
    '  G.PRiSM_dfit_handoff = function (run, target) { var s = ' + SM + '.HandoffPacket; s.target = target || s.target; return s; };\n' +
    '  G.PRiSM_dfit_kConstraint = function () { return null; };\n' +
    '})();\n// === SELF-TEST ===\n(function () {})();\n';
  const f58 = '(function () {\n' +
    "  'use strict';\n  var G = window, SM = " + SM + ';\n' +
    '  function c(o) { return JSON.parse(JSON.stringify(o)); }\n' +
    '  G.PRiSM_dfit_lkDefaults = function () { return c(SM.LkConfig); };\n' +
    "  G.PRiSM_dfit_lkQuick = function () { return { rows: [{ label: 'shut-in', dtMin: 0, qL: 0.5 }, { label: 'closure', dtMin: 305.1, qL: 0.0405 }], VL: 22.5, eta: 0.9, tc: 5.08, xf: 131.2, partition: {}, CLeq: 1.903e-4 }; };\n" +
    '  G.PRiSM_dfit_lkSimulate = function () { return c(SM.LkResult); };\n' +
    '  G.PRiSM_dfit_lkSample = function (res, t) { return t.map(function () { return 7000; }); };\n' +
    '  G.PRiSM_dfit_design = function () { return c(SM.Design); };\n' +
    '  G.PRiSM_dfit_identify = function () { return c(SM.Identify); };\n' +
    '})();\n// === SELF-TEST ===\n(function () {})();\n';
  const fSynth = '// helper module: does not add a page to window.WTS_calcRegistry\n(function () {\n' +
    "  'use strict';\n  var G = window, DS = " + DS + ';\n' +
    "  G.PRiSM_dfit_synth = { version: 'g1', demo: function (name) { var d = JSON.parse(JSON.stringify(DS)); d.name = 'DFIT demo — ' + name; return d; } };\n" +
    '})();\n// === SELF-TEST ===\n(function () {})();\n';
  _fakes = { '57-prism-dfit-aca.js': f57, '58-prism-dfit-leakoff.js': f58, '49-calc-dfit-synth.js': fSynth };
  return _fakes;
}
const OPTS = () => ({ sourceOverrides: fakes() });
const hooks = (w) => typeof w.PRiSM_drawPlot === 'function' && typeof w.PRiSM_undoBatch === 'function' && !!w.PRiSM_modeExt;
const skip = (what) => console.log('      skip (WPH hooks absent): ' + what);
const BANNED = /\b(null|undefined|NaN|Infinity)\b|\[object Object\]/;
const DFIT_PANELS = ['dfit-tests', 'dfit-well', 'dfit-channels', 'dfit-triage', 'dfit-board', 'dfit-classify', 'dfit-frac', 'dfit-whatif', 'dfit-report-opts'];

function host(app) { const h = app.document.createElement('div'); h.id = 'dfit_test_host'; app.document.body.appendChild(h); return h; }
// load the reference demo and store a run (synchronously, through the fast pipeline)
function withRun(app) {
  const U = app.win.PRiSM_dfit_ui;
  U.loadDemo('reference');
  const r = U.runFast('test');
  if (!r) throw new Error('fake pipeline did not run');
  return r;
}
async function settle(app, p) {
  let done = false, val;
  Promise.resolve(p).then((v) => { done = true; val = v; }, (e) => { done = true; val = e; });
  for (let i = 0; i < 200 && !done; i++) await app.flushAsync(5);
  if (!done) throw new Error('promise did not settle');
  return val;
}
function renderAll(app, h) {
  const w = app.win, U = w.PRiSM_dfit_ui;
  h.innerHTML = '';
  Object.keys(U.panels).forEach((id) => { const b = app.document.createElement('div'); h.appendChild(b); U.panels[id].render(b); });
  const s2 = app.document.createElement('div'); h.appendChild(s2); w.PRiSM_dfit_renderStep2(s2);
  U.s4Tabs.forEach((t) => { const s4 = app.document.createElement('div'); h.appendChild(s4); w.PRiSM_dfit_renderStep4(s4, t); });
  const rl = app.document.createElement('div'); h.appendChild(rl); U.rail(rl);
  return h;
}

module.exports = [
  {
    name: 'U1 the header option and setMode("dfit") relabel the steps (PRiSM_modeExt.dfit)',
    wp: WP, opts: OPTS(),
    run(app, assert) {
      const w = app.win, X = w.PRiSM_modeExt && w.PRiSM_modeExt.dfit;
      assert(X, 'PRiSM_modeExt.dfit registered');
      ['label', 'steps', 'analyse', 'rail', 'showsPanel', 'stepView', 'onEnter', 'onLeave', 'reportHeader', 'status'].forEach((k) => assert(X[k], 'ext.' + k));
      assert.strictEqual(X.label, 'DFIT (fracture injection)');
      assert.deepStrictEqual(Object.assign({}, X.steps), { 1: 'Data & events', 2: 'ISIP & friction', 3: 'Pre-closure', 4: 'After-closure & model', 5: 'Report' });
      assert.deepStrictEqual(Object.assign({}, X.tabs), { 1: 1, 3: 2, 5: 7 });
      assert(typeof X.stepView[2] === 'function' && typeof X.stepView[4] === 'function', 'step views ② and ④');
      assert.strictEqual(X.reportLegacySections, false);
      assert.strictEqual(X.testType, 'falloff');
      if (!hooks(w)) { skip('header #prism_testtype option and step labels after setMode("dfit")'); return; }
      app.openPRiSM(); app.flush(100);
      const sel = app.el('prism_testtype');
      assert(sel && Array.from(sel.querySelectorAll('option')).some((o) => /DFIT \(fracture injection\)/.test(o.textContent)), 'header option');
      w.PRiSM.setMode('dfit'); app.flush(100);
      const txt = app.el('prism_shell').textContent;
      ['Data & events', 'ISIP & friction', 'Pre-closure', 'After-closure & model'].forEach((l) => assert(txt.indexOf(l) !== -1, 'step label ' + l));
    },
  },
  {
    name: 'U2 transient / decline / combined unchanged: no DFIT plot, panel or report section outside DFIT mode',
    wp: WP, opts: OPTS(),
    run(app, assert) {
      const w = app.win;
      withRun(app);
      app.openPRiSM(); app.flush(100);
      [1, 2, 7].forEach((n) => { app.renderTab(n); app.flush(20); });
      const ids = app.findAll('[data-panel-id]').map((e) => e.getAttribute('data-panel-id'));
      assert.deepStrictEqual(ids.filter((i) => /^dfit-/.test(i)), [], 'no DFIT panel mounted in transient mode');
      assert(w.PRiSM.mode === 'transient', 'transient mode');
      w.PRiSM_reportSections.filter((f) => /^dfit-/.test(f._prismId || '')).forEach((f) => {
        assert.deepStrictEqual(Array.from(f.modes), ['dfit'], f._prismId + ' carries modes:[dfit]');
        assert.strictEqual(f({}), null, f._prismId + ' returns null outside DFIT mode');
      });
      const reg = w.PRiSM_PLOT_REGISTRY;
      if (!hooks(w)) {
        assert(!Object.keys(reg).some((k) => /^dfit/.test(k)), 'DFIT plots stay off the shared registry until the WPH hooks exist (combined mode shows every entry)');
        assert(!Object.keys(w.PRiSM_analysisKeys || {}).some((k) => /^dfit/.test(k)), 'DFIT line tools wait for the hooks');
        skip('picker lists in transient / decline / combined with the DFIT entries registered');
        return;
      }
      ['transient', 'decline', 'combined'].forEach((m) => {
        w.PRiSM.setMode(m); app.flush(50);
        const opts = app.findAll('#prism_plot_select option').map((o) => o.value);
        assert(!opts.some((v) => /^dfit/.test(v)), m + ': no DFIT plot in the picker');
      });
    },
  },
  {
    name: 'U3 onEnter writes falloff + the idealised multiRate (q_eq) as one undo step',
    wp: WP, opts: OPTS(),
    run(app, assert) {
      const w = app.win, U = w.PRiSM_dfit_ui;
      w.PRiSM_setWell({ testType: 'buildup' }, { source: 'user' });
      U.loadDemo('reference');
      let batches = 0;
      if (!hooks(w)) { w.PRiSM_undoBatch = (x) => { if (x === 'begin') batches++; }; }
      U.ext.onEnter('transient');
      assert.strictEqual(w.PRiSM_getWell().testType, 'falloff', 'test type falloff');
      const mr = w.PRiSM.multiRate, ev = S.FIX.run.events;
      assert.strictEqual(mr.length, 2, 'two rows');
      assert.ok(Math.abs(mr[0].t - (ev.ts - ev.tp.veq)) < 1e-9 && Math.abs(mr[0].q - ev.qEq * 1440) < 1e-9, 'injection row ts − tp_veq, q_eq in bbl/d');
      assert.ok(Math.abs(mr[1].t - ev.ts) < 1e-9 && mr[1].q === 0, 'shut-in row');
      assert.deepStrictEqual(JSON.parse(app.storage.getItem('wts_prism_mrate')), JSON.parse(JSON.stringify(mr)), 'schedule persisted');
      assert(w.PRiSM_state.dfit && w.PRiSM_state.dfit.tests.length === 1, 'st.dfit created with one test');
      if (!hooks(w)) { assert(batches >= 1, 'onEnter opens an undo batch'); delete w.PRiSM_undoBatch; skip('one undo step through 37'); return; }
      // with the hooks: entering DFIT mode from transient is one undo step (undo returns the previous test type)
      w.PRiSM_setWell({ testType: 'buildup' }, { source: 'user' });
      app.openPRiSM(); app.flush(50);
      w.PRiSM.setMode('dfit'); app.flush(50);
      assert.strictEqual(w.PRiSM_getWell().testType, 'falloff');
      assert(w.PRiSM_undo(), 'undo');
      assert.strictEqual(w.PRiSM_getWell().testType, 'buildup', 'one undo step restores the test type');
    },
  },
  {
    name: 'U4 every DFIT plot draws on the reference run with _prismAxes; derivative axis rule and lock; no foreign hook draws on DFIT canvases',
    wp: WP, opts: OPTS(),
    run(app, assert) {
      const w = app.win, U = w.PRiSM_dfit_ui, run = withRun(app);
      const h = host(app), cv = app.document.createElement('canvas');
      cv.style.width = '800px'; cv.style.height = '400px'; h.appendChild(cv);
      const MUST = ['dfitHistory', 'dfitG', 'dfitSqrt', 'dfitLogLog', 'dfitCompliance', 'dfitPdpdt', 'dfitStrip', 'dfitIsip', 'dfitAcaLogLog', 'dfitFlowDim', 'dfitFL', 'dfitImpLin', 'dfitImpRad', 'dfitPiTraj', 'dfitOverlay'];
      U.plotKeys().forEach((k) => {
        const e = U.plots[k];
        assert(e.mode === 'dfit' && e.kind === 'dfit' && typeof w[e.fn] === 'function' && e.axes && e.axes.x && e.axes.y, k + ': mode/kind/fn/axes');
        cv._prismAxes = null;
        const ok = U.drawPlot(cv, k);
        if (MUST.indexOf(k) !== -1) {
          assert(ok, k + ' draws');
          assert(cv._prismAxes && cv._prismAxes.plotKey === k, k + ': _prismAxes with its plotKey');
        } else if (!ok) {
          const t = app.canvasTexts(cv).join(' ');
          assert(t.length > 10 && !BANNED.test(t), k + ': a plain reason when it cannot draw (' + t.slice(0, 80) + ')');
        }
      });
      // axis rule: the right axis of dfitG defaults to derivs.axis.GdPdG (data after G_min), not the early drop
      U.drawPlot(cv, 'dfitG');
      const ax = cv._prismAxes, a = run.derivs.axis.GdPdG;
      assert(ax.scaleY2 && Math.abs(ax.scaleY2.min - a[0]) < 1e-9 && Math.abs(ax.scaleY2.max - a[1]) < 1e-9, 'right axis = derivs.axis.GdPdG');
      const peak = Math.max.apply(null, run.derivs.GdPdG.filter((v, i) => run.derivs.G[i] < 18));
      assert(peak >= ax.scaleY2.min && peak <= ax.scaleY2.max, 'the pre-closure G·dP/dG lies inside the plotted range');
      // lock axis: the range is kept when the run's axis changes
      U.setInput('options.axisLock', true);
      U.drawPlot(cv, 'dfitG');
      w.PRiSM_state._dfitRun.derivs.axis.GdPdG = [0, 5];
      U.drawPlot(cv, 'dfitG');
      assert(Math.abs(cv._prismAxes.scaleY2.max - a[1]) < 1e-9, 'locked range kept');
      U.setInput('options.axisLock', false);
      // foreign post-draw hooks make no canvas calls on DFIT canvases
      const hk = w.PRiSM_postDrawHooks.filter((x) => x && x._prismId !== 'dfit-picks');
      U.drawPlot(cv, 'dfitG');
      const DRAW = /^(stroke|fill|fillRect|strokeRect|fillText|strokeText|drawImage|putImageData|clearRect)$/;
      const draws = () => app.canvasLog(cv).filter((e) => DRAW.test(e.op)).length;
      const n0 = draws();
      hk.forEach((fn) => { const f = typeof fn === 'function' ? fn : fn.fn; try { f({ canvas: cv, plotKey: 'dfitG', data: {}, opts: { plotKey: 'dfitG' }, axes: cv._prismAxes }); } catch (e) { /* a hook may throw on foreign data */ } });
      assert.strictEqual(draws(), n0, 'no foreign hook draws on a DFIT canvas (' + hk.length + ' hooks)');
    },
  },
  {
    name: 'U5 the dfit-picks post-draw hook is registered once (also after a second install)',
    wp: WP, opts: OPTS(),
    run(app, assert) {
      const w = app.win, U = w.PRiSM_dfit_ui;
      const count = () => w.PRiSM_postDrawHooks.filter((h) => h && h._prismId === 'dfit-picks').length;
      assert.strictEqual(count(), 1);
      U.install();
      assert.strictEqual(count(), 1, 'still once after install()');
      assert.strictEqual(w.PRiSM_reportSections.filter((f) => f && f._prismId === 'dfit-headline').length, 1, 'report sections not duplicated');
    },
  },
  {
    name: 'U6 a dfitTangent click stores a pick (store:false, not in analysisKeyResults), logs it, and undo restores the previous picks',
    wp: WP, opts: OPTS(),
    run(app, assert) {
      const w = app.win, U = w.PRiSM_dfit_ui, run = withRun(app);
      const T = w.PRiSM_dfit_test(), n0 = T.log.length, snap = U.undo.get();
      assert(U.lineTools.dfitTangent.store === false && U.lineTools.dfitTangent.group === 'DFIT', 'store:false, group DFIT');
      const res = U.lineTools.dfitTangent.action([{ x: 12, y: 7200 }]);
      assert(res && !res.error, 'tangent action: ' + JSON.stringify(res));
      const pk = w.PRiSM_dfit_test().picks.user.dfitTangent;
      assert(pk && pk.p > 6900 && pk.p < 7100 && pk.G > 15 && pk.G <= 18.01, 'tangent pick near closure (normal leak-off): ' + JSON.stringify(pk));
      assert.strictEqual(w.PRiSM_dfit_test().log.length, n0 + 1, 'one log entry');
      assert.strictEqual(w.PRiSM_dfit_test().log[n0].item, 'pick.dfitTangent');
      assert(!(w.PRiSM_state.analysisKeyResults && w.PRiSM_state.analysisKeyResults.dfitTangent), 'not stored in analysisKeyResults');
      U.undo.set(snap);
      assert(!w.PRiSM_dfit_test().picks.user.dfitTangent, 'undo extra restores the picks');
      assert(w.PRiSM_state._dfitRun && w.PRiSM_state._dfitRun.fast, 'set() re-ran the fast pipeline');
      void run;
      if (!hooks(w)) { skip('PRiSM_runAnalysisKey + Ctrl-Z through 37'); return; }
      const r = w.PRiSM_runAnalysisKey('dfitTangent', [{ x: 12, y: 7200 }], { plotKey: 'dfitG' });
      assert(r.ok, 'runAnalysisKey');
      assert(!(w.PRiSM_state.analysisKeyResults || {}).dfitTangent, 'store:false honoured by 11');
      assert(w.PRiSM_undo(), 'undo');
      assert(!w.PRiSM_dfit_test().picks.user.dfitTangent, 'undo restores');
    },
  },
  {
    name: 'U7 a drag of the closure marker through the pointer owner commits exactly one pick-log entry',
    wp: WP, opts: OPTS(),
    run(app, assert) {
      const w = app.win, U = w.PRiSM_dfit_ui;
      withRun(app);
      const h = host(app), cv = app.document.createElement('canvas');
      cv.style.width = '800px'; cv.style.height = '400px'; h.appendChild(cv);
      U.drawPlot(cv, 'dfitG');
      assert(typeof cv._prismPointerOwner === 'function', 'pointer owner attached');
      const ax = cv._prismAxes, mx = ax.toX(18);
      assert.strictEqual(cv._prismPointerOwner({ offsetX: mx + 60, offsetY: 100 }), false, 'far from the marker: not taken');
      const n0 = w.PRiSM_dfit_test().log.length;
      assert.strictEqual(cv._prismPointerOwner({ offsetX: mx + 5, offsetY: 100 }), true, 'near the marker: taken');
      const drag = cv._dfitDrag;
      drag.move({ offsetX: ax.toX(15), offsetY: 100 });
      drag.move({ offsetX: ax.toX(14), offsetY: 100 });
      assert.strictEqual(w.PRiSM_dfit_test().log.length, n0, 'no log entry while dragging');
      drag.up({ type: 'pointerup', offsetX: ax.toX(14), offsetY: 100 });
      const T = w.PRiSM_dfit_test();
      assert.strictEqual(T.log.length, n0 + 1, 'one log entry on release');
      assert(T.picks.closure && T.picks.closure.source === 'user' && T.picks.closure.p > 7000 && /dragged/i.test(T.picks.closure.reason), 'user closure from the drag: ' + JSON.stringify(T.picks.closure));
      // Escape cancels a drag: no entry
      U.drawPlot(cv, 'dfitG');
      const mx2 = cv._prismAxes.toX(T.picks.closure.G);
      assert(cv._prismPointerOwner({ offsetX: mx2, offsetY: 100 }), 'taken again at the user marker');
      cv._dfitDrag.cancel();
      assert.strictEqual(w.PRiSM_dfit_test().log.length, n0 + 1, 'cancelled drag adds nothing');
      // keyboard equivalent (§7.14): arrows move the marker by one resampled point, Enter commits one entry
      const b = app.document.createElement('div'); h.appendChild(b);
      U.panels['dfit-board'].render(b);
      const mk = app.el('prism_dfit_marker');
      assert(mk, 'focusable closure-marker button');
      const i0 = +mk.getAttribute('data-dfit-idx');
      app.key(mk, 'ArrowLeft'); app.key(mk, 'ArrowLeft');
      assert.strictEqual(+app.el('prism_dfit_marker').getAttribute('data-dfit-idx'), i0 - 2, 'two points back');
      assert.strictEqual(w.PRiSM_dfit_test().log.length, n0 + 1, 'arrows alone add nothing');
      app.key(app.el('prism_dfit_marker'), 'Enter');
      assert.strictEqual(w.PRiSM_dfit_test().log.length, n0 + 2, 'Enter commits one entry');
      assert(/keyboard/.test(w.PRiSM_dfit_test().picks.closure.reason), 'keyboard pick');
    },
  },
  {
    name: 'U8 ▶ Analyse runs the pipeline Job with progress; Cancel keeps the previous results; one undo batch per run',
    wp: WP, opts: OPTS(),
    async run(app, assert) {
      const w = app.win, U = w.PRiSM_dfit_ui;
      U.loadDemo('reference');
      let begins = 0, ends = 0, depth = 0, maxDepth = 0;
      const realBatch = w.PRiSM_undoBatch;
      w.PRiSM_undoBatch = (x) => { if (x === 'begin') { begins++; depth++; maxDepth = Math.max(maxDepth, depth); } else { ends++; depth--; } if (realBatch) realBatch(x); };
      const prog = [];
      const run = await settle(app, w.PRiSM_dfit_analyse({ onProgress: (p, l) => prog.push([p, l]) }));
      assert(run && run.ok === true && run.fast === false, 'full run stored: ' + (run && run.code));
      assert.deepStrictEqual(prog.map((p) => Math.round(p[0] * 3)), [1, 2, 3], 'progress per work unit');
      assert.strictEqual(w.PRiSM_state._dfitRun, run, 'st._dfitRun');
      const T = w.PRiSM_dfit_test();
      assert(T.summary && T.summary.closure.value === 7000 && T.summary.stale === false, 'summary written');
      assert(S.checkShape('Summary', T.summary).ok, 'summary shape');
      assert.strictEqual(w.WTS_state.dfit.ok, true, 'WTS_state.dfit published');
      assert.strictEqual(w.WTS_state.dfit.closure.value, 7000);
      assert.strictEqual(begins, ends, 'every batch closed');
      assert.strictEqual(depth, 0, 'batch depth back to 0');
      // cancel: start, cancel before the first tick completes, the previous run stays
      const prev = w.PRiSM_state._dfitRun;
      const p = w.PRiSM_dfit_analyse();
      U.cancel('Cancelled — previous results kept.');
      const r2 = await settle(app, p);
      assert.strictEqual(r2.code, 'CANCELLED', 'cancelled: ' + JSON.stringify(r2));
      assert.strictEqual(w.PRiSM_state._dfitRun, prev, 'previous results kept');
      assert(/Cancelled — previous results kept/.test(U.statusText()), 'status text');
      assert.strictEqual(begins, ends, 'cancel closes the batch');
      w.PRiSM_undoBatch = realBatch;
      // high-rate windows: without IndexedDB only the shut-in window is kept in wts_prism_dfit_hf (§3.11)
      const hr = JSON.parse(JSON.stringify(run)); hr.prep.hf = { windows: [{ kind: 'shutin', t0: 0.1166, dtS: 0.02, p: [7640, 7652.5, 7631.25, 7600] }, { kind: 'step', t0: 0.1, dtS: 0.02, p: [7900, 7899] }] };
      const idx = U.storeHf(app.toWin(hr));
      if (w.PRiSM_storage && w.PRiSM_storage.backend === 'indexedDB') assert(idx && idx.store === 'idb' && idx.kinds.length === 2, 'HF index (idb)');
      else {
        assert(idx && idx.store === 'ls' && idx.key === 'dfit-hf:' + run.dsHash && JSON.stringify(idx.kinds) === '["shutin"]', 'HF index (localStorage, shut-in only): ' + JSON.stringify(idx));
        const rec = JSON.parse(app.storage.getItem('wts_prism_dfit_hf'));
        let acc = 0; const back = rec.windows[0].p.map((d) => { acc += d; return rec.windows[0].offset + acc * rec.windows[0].scale; });
        assert(back.every((v, i) => Math.abs(v - [7640, 7652.5, 7631.25, 7600][i]) < 0.006), 'delta encoding round-trips: ' + back);
      }
      assert(S.checkShape('DfitTest', JSON.parse(JSON.stringify(w.PRiSM_dfit_test()))).ok, 'test with the HF index keeps its shape');
      if (!hooks(w)) skip('one Analyse = one undo step through 37');
    },
  },
  {
    name: 'U9 zero pending timers after ▶ Analyse and flush(5000)',
    wp: WP, opts: OPTS(),
    async run(app, assert) {
      const w = app.win;
      w.PRiSM_dfit_ui.loadDemo('reference');
      app.openPRiSM(); app.flush(100);
      await settle(app, w.PRiSM_dfit_analyse());
      app.flush(5000);
      assert.strictEqual(app.pendingTimers(), 0, 'pending: ' + JSON.stringify(app.timers()).slice(0, 400));
    },
  },
  {
    name: 'U10 panel specs (ids, tabs, order, modes, when) and the exact mounted list per mode',
    wp: WP, opts: OPTS(),
    run(app, assert) {
      const w = app.win, U = w.PRiSM_dfit_ui;
      assert.deepStrictEqual(Array.from(Object.keys(U.panels)), DFIT_PANELS);
      const want = { 'dfit-tests': [1, 5], 'dfit-well': [1, 10], 'dfit-channels': [1, 20], 'dfit-triage': [1, 30], 'dfit-board': [2, 10], 'dfit-classify': [2, 20], 'dfit-frac': [2, 30], 'dfit-whatif': [2, 40], 'dfit-report-opts': [7, 10] };
      DFIT_PANELS.forEach((id) => {
        const s = U.panels[id];
        assert.deepStrictEqual([s.tab, s.order], want[id], id + ' tab/order');
        assert.deepStrictEqual(Array.from(s.modes), ['dfit'], id + ' modes');
        assert.strictEqual(s.when(), false, id + ' when() false in transient');
        const reg = w.PRiSM_tabPanels[s.tab].filter((p) => p.id === id);
        assert.strictEqual(reg.length, 1, id + ' registered once on tab ' + s.tab);
      });
      assert.deepStrictEqual(Array.from(U.ext.panelAllow), ['crop', 'gauges', 'linetools']);
      assert(U.ext.showsPanel(1, { id: 'crop' }) && !U.ext.showsPanel(1, { id: 'semilog' }) && U.ext.showsPanel(2, { id: 'x', modes: ['dfit'] }) && !U.ext.showsPanel(2, { id: 'x', modes: ['transient'] }), 'showsPanel rule');
      if (!hooks(w)) { skip('mounted panel list after setMode("dfit")'); return; }
      withRun(app);
      app.openPRiSM(); w.PRiSM.setMode('dfit'); app.flush(50);
      const mounted = (n) => { app.renderTab(n); app.flush(20); return app.findAll('#prism_tab_' + n + '_panels [data-panel-id]').map((e) => e.getAttribute('data-panel-id')); };
      const m1 = mounted(1), m2 = mounted(2), m7 = mounted(7);
      assert.deepStrictEqual(m1.filter((i) => /^dfit-/.test(i)), ['dfit-tests', 'dfit-well', 'dfit-channels', 'dfit-triage']);
      m1.concat(m2, m7).forEach((i) => assert(/^dfit-/.test(i) || ['crop', 'gauges', 'linetools'].indexOf(i) !== -1, 'only DFIT + allow-list panels: ' + i));
      assert.deepStrictEqual(m2.filter((i) => /^dfit-/.test(i)), ['dfit-board', 'dfit-classify', 'dfit-frac', 'dfit-whatif']);
      assert.deepStrictEqual(m7.filter((i) => /^dfit-/.test(i)), ['dfit-report-opts']);
    },
  },
  {
    name: 'U11 390 px structure: every DFIT table inside .dtable-wrap, the rail is the bottom sheet',
    wp: WP, opts: OPTS(),
    run(app, assert) {
      const w = app.win;
      withRun(app);
      w.PRiSM_dfit_state();
      w.PRiSM_dfit_addTest({ zone: 'B' });
      w.PRiSM_dfit_selectTest('t1');
      app.resize(390, 800);
      const h = renderAll(app, host(app));
      const tables = Array.from(h.querySelectorAll('table'));
      assert(tables.length >= 10, 'tables rendered: ' + tables.length);
      tables.forEach((t) => assert(t.parentNode && /\bdtable-wrap\b/.test(t.parentNode.className), 'table ' + (t.id || '') + ' wrapped'));
      assert(!BANNED.test(h.textContent), 'no NaN / undefined text: ' + (h.textContent.match(BANNED) || [''])[0]);
      app.openPRiSM(); app.flush(50);
      const rail = app.el('prism_rail');
      assert(rail && /prism-rail--sheet/.test(rail.className), 'rail sheet below 1,024 px');
      assert(/max-width:600px/.test(w.PRiSM_dfit_ui.css()) && /#prism_dfit_cv_dfitStrip\{height:160px/.test(w.PRiSM_dfit_ui.css()), 'phone rules (strip 160 px)');
    },
  },
  {
    name: 'U12 the iOS CSS block: safe-area padding for the two DFIT dialogs and 44 px tile buttons',
    wp: WP, opts: false,
    run(app, assert) {
      const css = fs.readFileSync(path.join(REPO, 'ios-app', 'ios-additions', 'ios-styles.css'), 'utf8');
      const i = css.indexOf('DFIT');
      assert(i !== -1, 'DFIT block marker');
      const blk = css.slice(i);
      assert(/html\.ios-app #prism_dfit_override,\s*html\.ios-app #wts_dfit_info\s*\{[^}]*env\(safe-area-inset-top\)[^}]*env\(safe-area-inset-right\)[^}]*env\(safe-area-inset-bottom\)[^}]*env\(safe-area-inset-left\)[^}]*max-height:\s*calc\(100dvh - 20px\)/.test(blk), 'dialog safe-area rule');
      assert(/html\.ios-app \.prism-dfit-tile button\s*\{[^}]*min-height:\s*44px/.test(blk), '44 px tile buttons');
    },
  },
  {
    name: 'U13 every DFIT numeric input clamps blank / 0 / −1 / 1e12 without NaN text; counts integral and capped; "1,5" → 1.5 with the decimal-comma option',
    wp: WP, opts: OPTS(),
    run(app, assert) {
      const w = app.win, U = w.PRiSM_dfit_ui, R = w.PRiSM_dfit_inputRanges.table;
      withRun(app);
      const h = renderAll(app, host(app));
      const inputs = Array.from(h.querySelectorAll('input[data-dfit-path]')).filter((e) => e.type !== 'checkbox');
      assert(inputs.length >= 36, 'numeric inputs rendered: ' + inputs.length);
      inputs.forEach((inp) => {
        const p = inp.getAttribute('data-dfit-path'), row = R[p];
        assert(row, p + ' is a range-table field');
        const scale = (row.display && row.display.scale) || 1;
        ['', '0', '-1', '1e12', 'abc'].forEach((raw) => {
          const el = app.document.getElementById(inp.id);
          app.change(el, raw);
          const v = p.split('.').reduce((o, k) => (o == null ? o : o[k]), w.PRiSM_dfit_test().inputs);
          if (v === null || v === 'auto') { assert(row.def === null || row.def === 'auto' || raw === '', p + ' ' + JSON.stringify(raw) + ' → default'); }
          else {
            assert(typeof v === 'number' && isFinite(v) && v >= row.min - 1e-9 && v <= row.max + 1e-9, p + ' ' + JSON.stringify(raw) + ' → ' + v + ' outside [' + row.min + ', ' + row.max + ']');
            if (row.integer) assert(Math.floor(v) === v, p + ' integral');
          }
          const shown = app.document.getElementById(inp.id).value;
          assert(!BANNED.test(shown), p + ' shows ' + shown);
          if (v !== null && typeof v === 'number') assert(Math.abs(parseFloat(shown) * scale - v) <= 1e-6 * Math.max(1, Math.abs(v)), p + ' display ' + shown + ' vs ' + v);
        });
      });
      assert(!BANNED.test(h.textContent), 'no NaN text after the sweep');
      assert.strictEqual(U.clampField('options.unc.n', '1e12').value, 2000, 'draws hard cap 2,000');
      assert.strictEqual(U.clampField('perfs.n', '12.6').value, 13, 'shot holes integral');
      assert.strictEqual(U.clampField('designer.n', '99999').value, 2000, 'designer n cap');
      // decimal comma: "1,5" → 1.5 in a single-value field; "1,500" never 1.5 without the option
      assert.strictEqual(U.clampField('fluid.muCp', '1,500').value, 1.0, 'option off: "1,500" is ambiguous → default');
      w.WTS_a11y.decimalComma(true);
      const mu = app.document.getElementById(U.id('fluid.muCp'));
      app.change(mu, '1,5');
      assert.strictEqual(w.PRiSM_dfit_test().inputs.fluid.muCp, 1.5, '"1,5" → 1.5');
      w.WTS_a11y.decimalComma(false);
    },
  },
  {
    name: 'U14 the exact Tools catalogue: the sandbox in every mode, the others only in DFIT mode, none under "More"',
    wp: WP, opts: OPTS(),
    run(app, assert) {
      const w = app.win, U = w.PRiSM_dfit_ui;
      assert.deepStrictEqual(JSON.parse(JSON.stringify(U.tools.map((t) => [t.id, t.fn, t.group, JSON.stringify(t.modes)]))), [
        ['dfit-sandbox', 'PRiSM_renderDfitSandboxTool', 'DFIT', '"*"'], ['dfit-designer', 'PRiSM_renderDfitDesignerTool', 'DFIT', '["dfit"]'],
        ['dfit-replay', 'PRiSM_renderDfitReplayTool', 'DFIT', '["dfit"]'], ['dfit-hammer', 'PRiSM_renderDfitHammerTool', 'DFIT', '["dfit"]'],
        ['dfit-notes', 'PRiSM_renderDfitNotesTool', 'DFIT', '["dfit"]']]);
      Object.keys(U.toolFns).forEach((k) => assert(typeof U.toolFns[k] === 'function', k));
      // each tool renders (the sandbox switches mode only with the hooks)
      const h = host(app);
      Object.keys(U.toolFns).forEach((k) => { const b = app.document.createElement('div'); h.appendChild(b); U.toolFns[k](b); assert(b.innerHTML.length > 20 && !BANNED.test(b.textContent), k + ' renders'); });
      if (!hooks(w)) {
        assert(!Object.keys(w).some((k) => /^PRiSM_renderDfit\w*Tool$/.test(k)), 'no PRiSM_renderDfit*Tool on window before the hooks (37 would list it under "More")');
        skip('PRiSM_listTools per mode');
        return;
      }
      const list = (m) => { w.PRiSM.setMode(m); app.flush(20); return w.PRiSM_listTools().filter((t) => /^dfit-|Dfit/.test(t.id + ' ' + t.fn)); };
      const tr = list('transient');
      assert.deepStrictEqual(tr.map((t) => t.id), ['dfit-sandbox'], 'transient: sandbox only');
      const df = list('dfit');
      assert.deepStrictEqual(df.map((t) => t.id).sort(), ['dfit-designer', 'dfit-hammer', 'dfit-notes', 'dfit-replay', 'dfit-sandbox']);
      assert(!w.PRiSM_listTools().some((t) => t.group === 'More' && /Dfit/.test(t.fn || '')), 'none under More');
    },
  },
  {
    name: 'U15 tests table: add / open / delete (logged, batched), overlay of two stored curves, stress plot',
    wp: WP, opts: OPTS(),
    run(app, assert) {
      const w = app.win, U = w.PRiSM_dfit_ui;
      w.PRiSM_state.dfit = app.toWin(S.FIX.state);
      const d = w.PRiSM_dfit_state();
      assert.strictEqual(d.tests.length, 2, 'two tests from the fixture');
      assert(S.checkShape('DfitState', JSON.parse(JSON.stringify(d))).ok, 'state shape kept');
      const h = host(app), b = app.document.createElement('div'); h.appendChild(b);
      U.panels['dfit-tests'].render(b);
      const tbl = b.querySelector('#prism_dfit_tests_tbl');
      assert(tbl && tbl.querySelectorAll('tbody tr').length === 2, 'two rows');
      assert(/0\.700/.test(tbl.textContent) || /0\.70/.test(tbl.textContent) || /—/.test(tbl.textContent), 'gradients shown');
      // overlay of two stored gdpdgN curves
      const cv = b.querySelector('canvas[data-dfit-plot="dfitOverlay"]');
      assert(cv, 'overlay canvas with two tests');
      U.drawPlot(cv, 'dfitOverlay');
      assert(cv._prismAxes && cv._prismAxes.plotKey === 'dfitOverlay', 'overlay drawn');
      const built = U.buildPlot('dfitOverlay');
      assert.strictEqual(built.data.series.length, 2, 'one curve per stored test');
      // add / open / delete
      app.click(b.querySelector('#prism_dfit_test_add'));
      assert.strictEqual(w.PRiSM_dfit_state().tests.length, 3, 'added');
      assert.strictEqual(w.PRiSM_dfit_state().active, 't3', 'new test active');
      const snap = U.undo.get();
      assert.strictEqual(snap.active, 't3');
      assert(w.PRiSM_dfit_selectTest('t2').ok && w.PRiSM_dfit_state().active === 't2', 'open t2');
      assert(w.PRiSM_dfit_test().log.some((l) => l.item === 'test.open'), 'open logged');
      assert(w.PRiSM_dfit_deleteTest('t3').ok && w.PRiSM_dfit_state().tests.length === 2, 'deleted');
      assert.strictEqual(w.PRiSM_dfit_deleteTest('t9').code, 'NO_TEST');
      for (let i = 0; i < 12; i++) w.PRiSM_dfit_addTest({});
      assert.strictEqual(w.PRiSM_dfit_state().tests.length, 12, 'cap 12 tests');
      assert.strictEqual(w.PRiSM_dfit_addTest({}).code, 'TEST_CAP');
      const st = U.buildPlot('dfitStress');
      assert(st.data && st.data.markers.length >= 2, 'stress plot from two analysed tests');
      if (!hooks(w)) skip('undo of add / delete through 37');
    },
  },
  {
    name: 'U16 method notes: every pick method and family has a note; the dialog is rp-skip / data-rp-nosnap; neutral wording',
    wp: WP, opts: OPTS(),
    run(app, assert) {
      const w = app.win, I = w.WTS_dfitInfo;
      ['tangent', 'sqrt', 'maxdpdg', 'compliance', 'crel', 'loglog', 'varcomp', 'model', 'fissure', 'reopening', 'user', 'F0', 'F1', 'F2', 'F3', 'F4',
       'normal', 'matrix', 'pdl', 'tip', 'hr-contact', 'storage', 'undetermined', 'linear', 'bilinear', 'radial', 'spherical', 'transition', 'artefact'].forEach((k) => {
        const c = I.content(k);
        assert(c.ok && c.key !== 'index', k + ' has a note');
        assert(c.assumptions.length && c.failureModes.length && c.cites.length && c.distinguish, k + ' complete');
      });
      const all = JSON.stringify(I.notes);
      assert(!/[™®©]|\b(Inc|Ltd|LLC|Corp|GmbH|plc)\b\.?|https?:|www\.|\.com\b|\bPIE\b/.test(all), 'no product, vendor or company marks, no web addresses');
      assert(!BANNED.test(all), 'no banned words');
      I.keys().forEach((k) => I.notes[k].cites.forEach((c) => assert(!/to verify/i.test(c), k + ': no unverified reference')));
      app.openPRiSM(); app.flush(50);
      const btn = app.document.createElement('button'); app.document.body.appendChild(btn);
      const dlg = I.open('tangent', btn);
      assert(dlg && dlg.id === 'wts_dfit_info', 'dialog opens');
      assert(/\brp-skip\b/.test(dlg.className) && dlg.hasAttribute('data-rp-nosnap'), 'rp-skip + data-rp-nosnap');
      assert(/Tangent/.test(dlg.textContent) && /SPE \d+/.test(dlg.textContent), 'content with citations');
      app.click(dlg.querySelector('[data-dfit-note="index"]'));
      assert(/Closure methods/.test(app.el('wts_dfit_info').textContent), 'index from the note');
      app.key(app.el('wts_dfit_info'), 'Escape');
      assert(!app.el('wts_dfit_info'), 'Escape closes');
      // the override dialog follows the same capture rules
      withRun(app);
      const ov = w.PRiSM_dfit_ui.openOverride();
      assert(ov && ov.id === 'prism_dfit_override' && /\brp-skip\b/.test(ov.className) && ov.hasAttribute('data-rp-nosnap'), 'override dialog rp-skip');
      app.el('prism_dfit_ov_value').value = '6990';
      assert.strictEqual(w.PRiSM_dfit_ui.saveOverride(), false, 'a reason is required');
      app.el('prism_dfit_ov_reason').value = 'Offset well closure';
      assert.strictEqual(w.PRiSM_dfit_ui.saveOverride(), true, 'saved with a reason');
      assert(!app.el('prism_dfit_override'), 'dialog closed');
      const cp = w.PRiSM_dfit_test().picks.closure;
      assert(cp.source === 'user' && cp.p === 6990 && cp.reason === 'Offset well closure', 'override stored');
    },
  },
];
