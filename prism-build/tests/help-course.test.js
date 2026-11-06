// Well Test Simulator course and field scenarios — docs/HELP-GUIDE-PLAN.md §6 and §7.5 (WP-T).
//
// Content: prism-build/48-calc-help-simcourse.js (WTS_helpContent.course / .scenarios). Checks here:
//   • shape: every exercise has goal, set-up, steps, observe, questions, answers, trainer notes (duration, fault and
//     time, good response, mistakes, ≥ 3 debrief questions) and a set-up form of live wts_* ids; FS-1 / FS-2 open with
//     "which pressure goes where" and carry both variants; size limits (§4.6);
//   • live references: tags and alarm ids are read from the engine (WTS_sim.TAGS, the 31-wts-sim.js source), fault
//     menu items from WTS_sim.FAULTS, bold phrases from the page and the HMI source (38-wts-live.js) — never a fixed list;
//   • numbers: CHECKS below reproduce every number quoted in the text. 'page' checks run calcWTS on route wts now (host
//     code, in the harness). 'sim' checks run the dynamic simulator; they run only when Round 7 is in the harness pipeline
//     (sim-equip WP0) or with WTS_HELP_SIMCHECKS=1 (the HTML's injected Round 7), and are skipped with the reason otherwise;
//   • FS-1 / FS-2 select the variant for WTS_sim.features (bypassDest); worksheets print without answers or trainer notes.
// The checks live in this file, not in the content, so they add nothing to the app bundle (D15).
'use strict';

const fs = require('fs');
const path = require('path');

const WP = 'HELPCOURSE';
const BUILD = path.resolve(__dirname, '..');
const SIM_SKIP = 'Round 7 not in the harness';
const simInHarness = () => /['"]concat-round7['"]/.test(fs.readFileSync(path.join(__dirname, '_harness.js'), 'utf8')) || process.env.WTS_HELP_SIMCHECKS === '1';

const FS1 = { wts_Psep: 15, wts_Psurge: 5, wts_Qg: 0.3, wts_Qo: 0, wts_Qw: 2400, wts_Pwh: 500, wts_bean: 32 };
const mix = (a, b) => Object.assign({}, a, b);
// Every course / scenario id must have an entry; [] only with a reason in NO_NUMBERS.
const CHECKS = {
  ex1: [
    { kind: 'page', set: {}, tol: 0.005, expectState: { 'flow.choke.Pout': 157.66, 'flow.choke.Pin': 2999.26, 'flow.choke.ratio': 0.0572, 'flow.choke.regime': 'Critical',
      'flow.choke.QmaxMMscfd': 10.71, 'flow.choke.dTjt': 111.26, 'flow.choke.dP': 2841.6, 'flow.nodes.2.T': 68.74, 'flow.heater.Tout': 150 } },
    { kind: 'page', set: { wts_Psep: 160 }, tol: 0.005, expectState: { 'flow.choke.regime': 'Critical', 'flow.choke.flowLimited': false, 'flow.choke.QmaxMMscfd': 10.71 } },
    { kind: 'sim', run: 120, dt: 1, actions: [{ t: 30, sp: 160 }], expect: [{ at: 33, path: 'sep.SPeff', v: 156, tol: 0.01 }] },
  ],
  ex2: [
    { kind: 'page', set: { wts_bean: 30 }, tol: 0.002, expectState: { 'flow.choke.flowLimited': true, 'flow.choke.QmaxMMscfd': 9.413 }, expectText: ['Choke is flow-limited — bean 30/64'] },
    { kind: 'page', set: { wts_bean: 28 }, tol: 0.005, expectState: { 'flow.choke.flowLimited': true, 'flow.choke.QmaxMMscfd': 8.2 } },
    { kind: 'page', set: { wts_bean: 34 }, expectState: { 'flow.choke.flowLimited': false }, absentText: ['Choke is flow-limited'] },
    { kind: 'sim', set: { wts_bean: 30 }, run: 120, expect: [{ alarm: 'CHOKE_LIMIT', from: 0, to: 30 }] },
  ],
  ex3: [],   // its numbers are FS-1's
  ex4: [
    { kind: 'sim', run: 1800, actions: [{ t: 600, fault: 'oilDumpStuckClosed', on: true }, { t: 900, resetESD: false, blocking: 'LSHH_SEP' }, { t: 900, fault: 'oilDumpStuckClosed', on: false }, { t: 1500, resetESD: true }],
      expect: [{ alarm: 'LSH_SEP', from: 720, to: 840 }, { alarm: 'LSHH_SEP', from: 790, to: 900 }, { alarm: 'ESD_TRIPPED', from: 790, to: 900 }] },
    { kind: 'sim', run: 3000, actions: [{ t: 600, fault: 'waterDumpStuckClosed', on: true }], expect: [{ alarm: 'ISHH_SEP', from: 900, to: 2600 }, { noAlarm: 'ESD_TRIPPED' }] },
  ],
  ex5: [
    { kind: 'sim', run: 960, dt: 1, actions: [{ t: 600, esd: true }, { t: 900, resetESD: true }],
      expect: [{ at: 606, path: 'esd.travel', v: 0, tol: 0.001 }, { at: 900, path: 'nodes.wellhead.P', v: 3298, tol: 0.01 }, { at: 917, path: 'esd.travel', v: 1, tol: 0.001 }] },
  ],
  ex6: [
    { kind: 'sim', run: 5400, dt: 5, expect: [{ batch: 1, from: 4600, to: 5800 }, { at: 5400, path: 'gauge.batches.0.tClose', v: 4680, tol: 0.1 }, { at: 5400, path: 'gauge.batches.0.settled', v: true }] },
    { kind: 'sim', run: 11000, dt: 10, actions: [{ t: 600, fault: 'surgePumpFail', on: true }], expect: [{ alarm: 'LAH_GT', from: 8000, to: 10800 }, { alarm: 'LSHH_GT', from: 8000, to: 11000 }, { noAlarm: 'ESD_TRIPPED' }] },
  ],
  ex7: [
    { kind: 'sim', run: 150, dt: 1, actions: [{ t: 60, valve: ['surge', 1, false] }, { t: 120, valve: ['surge', 1, true] }, { t: 120, valve: ['surge', 0, false] }],
      expect: [{ at: 100, path: 'surge.comps.1.pos', v: 0 }, { at: 123, path: 'surge.comps.0.pos', v: 1 }, { at: 123, path: 'surge.comps.0.hold', v: true }, { at: 140, path: 'surge.comps.0.pos', v: 0 },
        { at: 140, path: 'surge.comps.1.pos', v: 1 }, { noAlarm: 'SURGE_BLOCKED' }] },
    { kind: 'sim', run: 4800, dt: 5, actions: [{ t: 600, fault: 'xferStuckClosed', on: true }], expect: [{ alarm: 'XFER_FAIL', from: 600, to: 640 }, { alarm: 'LSHH_SURGE', from: 3600, to: 4800 }, { alarm: 'ESD_TRIPPED', from: 3600, to: 4800 }] },
    { kind: 'sim', set: { wts_Psurge: 2 }, run: 3600, dt: 10, expect: [{ alarm: 'XFER_LOW_DP', from: 600, to: 3600 }] },
  ],
  ex8: [
    { kind: 'page', set: { wts_Twh: 60 }, tol: 0.01, expectState: { 'flow.nodes.2.T': -51.3, 'flow.nodes.2.th': 36.6, 'flow.choke.dTjt': 111.3, 'flow.nodes.0.th': 75.1 },
      expectText: ['WH→ESD: Hydrate risk', 'Choke→Heater: Hydrate risk'], absentText: ['Heater→Sep: Hydrate risk'] },
    { kind: 'page', set: { wts_Twh: 60, wts_bypass: '1' }, expectText: ['Heater→Sep: Hydrate risk', 'Sep→Flare: Hydrate risk'] },
    { kind: 'page', set: {}, tol: 0.01, expectState: { 'flow.nodes.2.T': 68.74, 'flow.nodes.2.th': 36.59 }, absentText: ['Hydrate risk'] },
    { kind: 'sim', set: { wts_Twh: 60 }, run: 120, expect: [{ alarm: 'HYD_choke', from: 0, to: 60 }] },
  ],
  // FS-1 (a)–(d) of plan §6.2; (e) is FS-2's default-spread check
  'FS-1': [
    { kind: 'page', set: mix(FS1, { wts_Psurge: 25 }), tol: 0.01, expectState: { 'flow.choke.Pout': 20.5, 'flow.choke.regime': 'Critical', 'flow.choke.flowLimited': false,
      'flow.choke.QmaxMMscfd': 1.78, 'flow.choke.ratio': 0.0684, 'flow.sim.surgeP_psig': 5 }, expectText: ['Surge tank pressure too close to separator pressure — liquids cannot dump'] },
    { kind: 'page', set: FS1, tol: 0.01, expectState: { 'flow.choke.Pout': 20.5, 'flow.warnings.length': 0 }, absentText: ['Surge tank pressure too close'] },
    { kind: 'page', set: mix(FS1, { wts_Pwh: 60 }), tol: 0.02, expectState: { 'flow.choke.flowLimited': true, 'flow.choke.QmaxMMscfd': 0.25 } },
    { kind: 'page', set: mix(FS1, { wts_Pwh: 100 }), tol: 0.02, expectState: { 'flow.choke.flowLimited': false, 'flow.choke.QmaxMMscfd': 0.387 } },
    { kind: 'page', set: mix(FS1, { wts_Pwh: 2000, wts_Qg: 5, wts_Qo: 500, wts_Qw: 300 }), tol: 0.01,
      expectState: { 'flow.choke.Pout': 24.1, 'flow.choke.QmaxMMscfd': 7.21, 'flow.choke.regime': 'Critical', 'flow.warnings.length': 0 } },
    { kind: 'page', set: mix(FS1, { wts_Pwh: 3000, wts_Qg: 10, wts_Qo: 1000, wts_Qw: 200 }), expectText: ['Heater→Sep: Velocity 287 ft/s EXCEEDS erosional limit 240 ft/s'] },
    { kind: 'sim', set: FS1, rig: { separator: false }, run: 900, dt: 5, expect: [{ at: 900, path: 'nodes.choke.P', v: 10.5, tol: 0.03 }, { at: 900, path: 'rigup.flare', v: true }] },
    { kind: 'sim', run: 900, dt: 5, rig: { separator: false }, expect: [{ at: 900, path: 'nodes.choke.P', v: 14.3, tol: 0.03 }] },
  ],
  'FS-2': [
    { kind: 'page', set: {}, tol: 0.005, expectState: { 'flow.choke.Pout': 157.7, 'flow.choke.ratio': 0.0572, 'flow.choke.regime': 'Critical' } },
    { kind: 'sim', run: 300, rig: { flare: false, surge: false, gauge: false },
      expect: [{ at: 300, path: 'sep.pshh', v: 180 }, { at: 300, path: 'sep.psh', v: 165 }, { at: 300, path: 'sep.psl', v: 120 }, { at: 300, path: 'sep.mawp', v: 1440 }, { at: 300, path: 'rigup.flare', v: false }] },
    { kind: 'sim', run: 10, rig: { separator: false, flare: false }, expect: [{ at: 10, path: 'rigup.flare', v: true }] },
  ],
  'FS-4': [
    { kind: 'page', set: { wts_Twh: 60, wts_bypass: '1' }, tol: 0.01, expectState: { 'flow.nodes.2.T': -51.3, 'flow.nodes.2.th': 36.5 },
      expectText: ['WH→ESD: Hydrate risk', 'Heater→Sep: Hydrate risk', 'Sep→Flare: Hydrate risk'] },
    { kind: 'page', set: { wts_Twh: 60 }, expectText: ['ESD→Choke: Hydrate risk', 'Choke→Heater: Hydrate risk'], absentText: ['Heater→Sep: Hydrate risk'] },
    { kind: 'page', set: {}, tol: 0.01, expectState: { 'flow.nodes.2.T': 68.74 }, absentText: ['Hydrate risk'] },
  ],
};
const NO_NUMBERS = { ex3: 'reuses FS-1 by reference; FS-1 carries the checks' };

// ── helpers ──
const txt = (e) => String((e && e.textContent) || '').replace(/\s+/g, ' ').trim();
const A = (x) => (Array.isArray(x) ? x : x == null ? [] : [x]);
const getPath = (o, p) => String(p).split('.').reduce((a, k) => (a == null ? a : a[k]), o);
const near = (a, b, tol) => (typeof b === 'number' ? typeof a === 'number' && Math.abs(a - b) <= (tol == null ? 0.005 : tol) * Math.max(1, Math.abs(b)) : a === b);
const fail = (assert, list, what) => assert.ok(!list.length, what + ':\n  ' + list.slice(0, 40).join('\n  ') + (list.length > 40 ? '\n  … ' + (list.length - 40) + ' more' : ''));
const readSrc = (f) => fs.readFileSync(path.join(BUILD, f), 'utf8');
function strings(v, p, cb) {
  if (typeof v === 'string') { cb(v, p); return; }
  if (Array.isArray(v)) { v.forEach((x, i) => strings(x, p + '[' + i + ']', cb)); return; }
  if (v && typeof v === 'object') Object.keys(v).forEach((k) => { if (k !== 'form' && k !== '_group') strings(v[k], p + '.' + k, cb); });
}
function content(app) { const C = app.win.WTS_help.load(); return { C, course: A(C.course).filter((x) => x._group === 'simcourse'), scenarios: A(C.scenarios).filter((x) => x._group === 'simcourse') }; }
function openWts(app, set) {
  app.hook.nav('home');
  app.storage.removeItem('wts_page_wts'); app.storage.removeItem('wts_wts');
  app.hook.nav('wts');
  app.flush(300);
  Object.keys(set || {}).forEach((id) => {
    const el = app.el(id);
    if (!el) throw new Error('no #' + id + ' on the wts page');
    if (String(el.localName).toLowerCase() === 'select') app.select(el, String(set[id]));
    else { app.input(el, String(set[id])); app.change(el, String(set[id])); }
  });
  app.win.calcWTS();
  app.flush(300);
}
function pageCheck(app, where, ck) {
  const out = [];
  try { openWts(app, ck.set); } catch (e) { return [where + ': ' + e.message]; }
  const W = app.win;
  Object.keys(ck.expectState || {}).forEach((k) => { const v = getPath(W.WTS_state, k); if (!near(v, ck.expectState[k], ck.tol)) out.push(where + ': WTS_state.' + k + ' = ' + v + ', text says ' + ck.expectState[k]); });
  const body = txt(app.el('pgBody'));
  A(ck.expectText).forEach((t) => { if (body.indexOf(t) === -1) out.push(where + ': page does not show "' + t + '"'); });
  A(ck.absentText).forEach((t) => { if (body.indexOf(t) !== -1) out.push(where + ': page still shows "' + t + '"'); });
  return out;
}
const activeIds = (st) => A(st.alarms).filter((a) => a && a.active !== false).map((a) => a.id);
// sim check: flow from calcWTS with `set` (else SAMPLE_FLOW), noise off, seed 7; actions at sim times; expectations:
//   { alarm, from, to } first raise in [from, to] · { noAlarm } never active · { at, path, v, tol } value at a time ·
//   actions: { t, fault, on } · { t, esd } · { t, resetESD: ok, blocking } · { t, sp } (separator set point) · { t, valve: [eq, idx, open] }
//   { batch: n, from, to } the n-th gauge batch is listed (closed and settled) in [from, to]
function simCheck(app, where, ck) {
  const out = [], W = app.win, S = W.WTS_sim;
  if (!S) return [where + ': WTS_sim missing'];
  let flow = S.SAMPLE_FLOW;
  if (ck.set && Object.keys(ck.set).length) { openWts(app, ck.set); flow = JSON.parse(JSON.stringify(W.WTS_state.flow)); }
  const s = S.create(app.toWin(flow), app.toWin({ seed: 7, config: { noise: { on: false } } }));
  if (ck.rig) s.setRigup(app.toWin(ck.rig));
  const dt = ck.dt || 2, acts = A(ck.actions).map((a) => Object.assign({ done: false }, a)), first = {}, ats = A(ck.expect).filter((e) => e.at != null).map((e) => Object.assign({ done: false }, e));
  let batchT = {}, t = 0;
  const doAct = (a) => {
    if (a.fault) s.setFault(a.fault, a.on !== false);
    if (a.esd) s.tripESD('manual');
    if (a.valve) s.setValve(a.valve[0], a.valve[1], !!a.valve[2]);
    if (a.sp != null) { const f2 = JSON.parse(JSON.stringify(flow)); f2.separatorPressure = a.sp; f2.inputs.Psep = a.sp; f2.seq = (f2.seq || 1) + 1; s.setFlow(app.toWin(f2)); }
    if (a.resetESD != null) {
      const r = s.resetESD();
      if (!!r.ok !== !!a.resetESD) out.push(where + ': Reset ESD at ' + a.t + ' s gave ok=' + r.ok + ', text says ' + a.resetESD);
      if (a.blocking && A(r.blocking).indexOf(a.blocking) === -1) out.push(where + ': Reset ESD at ' + a.t + ' s not blocked by ' + a.blocking + ' (' + r.blocking + ')');
    }
  };
  const look = () => {
    const st = s.getState();
    activeIds(st).forEach((id) => { if (first[id] == null) first[id] = st.t; });
    A(st.gauge && st.gauge.batches).forEach((b, i) => { if (batchT[i + 1] == null) batchT[i + 1] = st.t; });
    ats.forEach((e) => {
      if (e.done || st.t < e.at - 1e-6) return;
      e.done = true;
      const v = getPath(st, e.path);
      if (!near(v, e.v, e.tol)) out.push(where + ': at ' + e.at + ' s ' + e.path + ' = ' + v + ', text says ' + e.v);
    });
  };
  while (t < ck.run - 1e-9) {
    acts.forEach((a) => { if (!a.done && a.t <= t + 1e-9) { a.done = true; doAct(a); } });
    s.advance(dt); t += dt;
    look();
  }
  A(ck.expect).forEach((e) => {
    if (e.alarm) { const f = first[e.alarm]; if (f == null || f < e.from || f > e.to) out.push(where + ': alarm ' + e.alarm + ' first at ' + f + ' s, text needs ' + e.from + '–' + e.to + ' s'); }
    if (e.noAlarm && first[e.noAlarm] != null) out.push(where + ': ' + e.noAlarm + ' raised at ' + first[e.noAlarm] + ' s, text says it does not');
    if (e.batch) { const f = batchT[e.batch]; if (f == null || f < e.from || f > e.to) out.push(where + ': batch ' + e.batch + ' closed at ' + f + ' s, text needs ' + e.from + '–' + e.to + ' s'); }
  });
  ats.forEach((e) => { if (!e.done) out.push(where + ': run ended before ' + e.at + ' s'); });
  if (typeof s.dispose === 'function') s.dispose();
  return out;
}
// Engine vocabulary: tags in WTS_sim.TAGS and anywhere in the engine source; alarm ids from aDef('<ID>', …).
function engineVocab(app) {
  const S = app.win.WTS_sim, src = readSrc('31-wts-sim.js');
  const tags = new Set(Object.keys(S.TAGS).map((k) => S.TAGS[k]));
  (src.match(/\b[A-Z]{1,5}-\d{3}[A-Z]?\b/g) || []).forEach((t) => tags.add(t));
  const alarms = new Set();
  (src.match(/aDef\('([A-Z0-9_]+)/g) || []).forEach((m) => alarms.add(m.slice(6)));
  if (/aDef\('HYD_' \+/.test(src)) ['wellhead', 'esd', 'choke', 'heater', 'separator'].forEach((n) => alarms.add('HYD_' + n));
  const faults = new Map(A(S.FAULTS).map((f) => [f.label, f.id]));
  return { tags, alarms, faults, faultIds: new Set(A(S.FAULTS).map((f) => f.id)), rig: new Set(A(S.RIG_KEYS)) };
}
const TAG_RE = /\b[A-Z]{1,5}-\d{3}[A-Z]?\b/g, ALARM_RE = /\b[A-Z]{2,}(?:_[A-Z]+)+\b/g;
function refIssues(items, V) {
  const out = [];
  items.forEach((x) => strings(x, x.id, (s, p) => {
    if (/\.afterSim/.test(p)) return;   // describes a feature that is only shown once installed (WTS_sim.features)
    (s.match(TAG_RE) || []).forEach((t) => { if (!V.tags.has(t)) out.push(p + ': tag ' + t + ' is not in the engine'); });
    (s.match(ALARM_RE) || []).forEach((t) => { if (!V.alarms.has(t)) out.push(p + ': alarm id ' + t + ' is not in the engine'); });
    (s.match(/\*\*Scenarios → ([^*]+)\*\*/g) || []).forEach((b) => { const l = b.slice(14, -2); if (!V.faults.has(l)) out.push(p + ': fault "' + l + '" is not in WTS_sim.FAULTS'); });
  }));
  return out;
}
// Bold phrases: visible text on the wts page (form, HUD, toolbar), or a string of the HMI / engine source, or a speed
// label; a menu path "A → B" checks each part. afterSim is skipped (feature-gated).
function boldIssues(app, items) {
  openWts(app, {});
  const S = app.win.WTS_sim;
  const vocab = [txt(app.el('pgBody')), txt(app.el('pgTitle')), readSrc('38-wts-live.js'), readSrc('31-wts-sim.js'),
    A(S.DEFAULTS.speeds).map((v) => '×' + v).join(' ')].join(' | ').replace(/&amp;/g, '&').toLowerCase();
  const out = [];
  items.forEach((x) => strings(x, x.id, (s, p) => {
    if (/\.afterSim/.test(p)) return;
    (s.match(/\*\*([^*]+)\*\*/g) || []).forEach((b) => {
      b.slice(2, -2).split('→').map((q) => q.trim().toLowerCase()).forEach((q) => { if (q && vocab.indexOf(q) === -1) out.push(p + ': bold "' + q + '" is not on the page or in the simulator'); });
    });
  }));
  return out;
}
function shapeIssues(app, course, scenarios) {
  const out = [], size = (x) => Buffer.byteLength(JSON.stringify(x), 'utf8');
  const ids = new Set(Array.from(app.el('pgBody').querySelectorAll('input[id^="wts_"], select[id^="wts_"]')).map((e) => e.id));
  if (!course.length) out.push('no exercises');
  course.forEach((x, i) => {
    const w = 'course[' + (x.id || i) + ']';
    if (x.id !== 'ex' + (i + 1)) out.push(w + ': id should be ex' + (i + 1) + ' (exercises in order)');
    ['title', 'goal'].forEach((k) => { if (!x[k]) out.push(w + ': ' + k + ' missing'); });
    ['setup', 'steps', 'observe', 'questions', 'answers', 'keywords'].forEach((k) => { if (!A(x[k]).length) out.push(w + ': ' + k + ' missing'); });
    const t = x.trainer || {};
    ['duration', 'fault', 'good'].forEach((k) => { if (!t[k]) out.push(w + ': trainer.' + k + ' missing'); });
    if (!A(t.mistakes).length) out.push(w + ': trainer.mistakes missing');
    if (A(t.debrief).length < 3 || A(t.debrief).length > 5) out.push(w + ': trainer.debrief needs 3–5 questions');
    if (!x.form || typeof x.form !== 'object') out.push(w + ': form (set-up values) missing');
    else Object.keys(x.form).forEach((k) => { if (!/^wts_/.test(k) || !ids.has(k)) out.push(w + ': form id ' + k + ' is not a wts_* input on the page'); });
    if (size(x) > 4096) out.push(w + ': ' + size(x) + ' bytes, over 4 kB');
  });
  scenarios.forEach((x, i) => {
    const w = 'scenarios[' + (x.id || i) + ']';
    if (!/^FS-\d+$/.test(String(x.id))) out.push(w + ': id FS-n');
    if (!x.title || !A(x.today).length || !A(x.keywords).length) out.push(w + ': title, today and keywords required');
    if (size(x) > 5120) out.push(w + ': ' + size(x) + ' bytes, over 5 kB');
  });
  ['FS-1', 'FS-2'].forEach((id) => {
    const x = scenarios.filter((s) => s.id === id)[0];
    if (!x) { out.push(id + ' missing'); return; }
    const intro = A(x.intro);
    if (!(intro[0] && intro[0].h === 'Which pressure goes where')) out.push(id + ': must open with "Which pressure goes where"');
    const tab = intro.filter((b) => b && b.table && /pressure you have/i.test(A(b.table.head).join(' ')))[0];
    if (!tab) out.push(id + ': the which-pressure table is missing');
    else {
      const flat = A(tab.table.rows).map((r) => r.join(' | ')).join(' / ');
      ['Wellhead Pressure', 'Operating Pressure', 'Surge Tank Pressure', 'V-101 out', 'V-101 in only'].forEach((k) => { if (flat.indexOf(k) === -1) out.push(id + ': the table does not mention ' + k); });
    }
    if (x.feature !== 'bypassDest' || !A(x.afterSim).length) out.push(id + ': needs both variants (today, afterSim) with feature bypassDest');
  });
  const ex3 = course.filter((x) => x.id === 'ex3')[0];
  if (ex3 && JSON.stringify(ex3).indexOf('[[fs#FS-1') === -1) out.push('ex3 must reuse FS-1 by reference');
  course.concat(scenarios).forEach((x) => { if (!CHECKS[x.id]) out.push(x.id + ': no CHECKS entry in help-course.test.js'); else if (!CHECKS[x.id].length && !NO_NUMBERS[x.id]) out.push(x.id + ': empty CHECKS without a NO_NUMBERS reason'); });
  return out;
}
function simCheckShape(V) {
  const out = [];
  Object.keys(CHECKS).forEach((id) => CHECKS[id].filter((c) => c.kind === 'sim').forEach((c, i) => {
    const w = id + ' sim[' + i + ']';
    A(c.actions).forEach((a) => { if (a.fault && !V.faultIds.has(a.fault)) out.push(w + ': fault ' + a.fault + ' not in WTS_sim.FAULTS'); });
    A(c.expect).forEach((e) => { [e.alarm, e.noAlarm].filter(Boolean).forEach((a) => { if (!V.alarms.has(a)) out.push(w + ': alarm ' + a + ' not in the engine'); }); });
    Object.keys(c.rig || {}).forEach((k) => { if (!V.rig.has(k)) out.push(w + ': rig-up key ' + k + ' not in WTS_sim.RIG_KEYS'); });
  }));
  return out;
}

module.exports = [
  {
    name: 'HELPCOURSE shape: exercises with trainer notes and set-up form, FS-1/FS-2 open with "which pressure goes where", both variants, limits',
    wp: WP,
    run(app, assert) {
      const { course, scenarios } = content(app);
      openWts(app, {});
      fail(assert, shapeIssues(app, course, scenarios), 'course and scenarios');
      assert.ok(scenarios.some((s) => s.id === 'FS-4'), 'FS-4 cold start-up shipped');
      assert.ok(!course.some((x) => /desander|DS-101|T-202/.test(JSON.stringify(x))), 'exercises 9–10 wait for the sim-equip merge (not shipped half-written)');
    },
  },
  {
    name: 'HELPCOURSE live references: tags, alarm ids and fault menu items read from the engine; bold phrases are page or simulator text',
    wp: WP,
    run(app, assert) {
      const { course, scenarios } = content(app);
      const V = engineVocab(app);
      assert.ok(V.faults.size >= 8 && V.tags.has('LSHH-301') && V.alarms.has('CHOKE_LIMIT'), 'engine vocabulary read');
      const items = course.concat(scenarios);
      fail(assert, refIssues(items, V).concat(boldIssues(app, items), simCheckShape(V)), 'references');
      // every fault the course injects is a real menu item
      const used = new Set();
      items.forEach((x) => strings(x, x.id, (s) => (s.match(/\*\*Scenarios → ([^*]+)\*\*/g) || []).forEach((b) => used.add(V.faults.get(b.slice(14, -2))))));
      ['oilDumpStuckClosed', 'surgePumpFail', 'xferStuckClosed'].forEach((f) => assert.ok(used.has(f), 'course injects ' + f));
    },
  },
  {
    name: 'HELPCOURSE steady numbers reproduce: calcWTS page checks for the exercises and FS-1 (a)–(d), FS-2 (e), FS-4',
    wp: WP,
    timeoutMs: 300000,
    run(app, assert) {
      const issues = [];
      let n = 0;
      Object.keys(CHECKS).forEach((id) => CHECKS[id].forEach((c, i) => { if (c.kind === 'page') { n++; pageCheck(app, id + ' page[' + i + ']', c).forEach((m) => issues.push(m)); } }));
      assert.ok(n >= 15, n + ' page checks');
      fail(assert, issues, 'page checks');
    },
  },
  {
    name: 'HELPCOURSE dynamic numbers reproduce on the simulator (skipped until Round 7 is in the harness)',
    wp: WP,
    timeoutMs: 900000,
    run(app, assert) {
      const V = engineVocab(app);
      fail(assert, simCheckShape(V), 'sim check shape');
      const all = [];
      Object.keys(CHECKS).forEach((id) => CHECKS[id].forEach((c, i) => { if (c.kind === 'sim') all.push([id + ' sim[' + i + ']', c]); }));
      if (!simInHarness()) { console.log('[help-course] ' + all.length + ' simulator check(s) skipped — ' + SIM_SKIP + ' (set WTS_HELP_SIMCHECKS=1 to run them on the HTML\'s Round 7)'); return; }
      const issues = [];
      all.forEach(([w, c]) => simCheck(app, w, c).forEach((m) => issues.push(m)));
      fail(assert, issues, 'simulator checks');
    },
  },
  {
    name: 'HELPCOURSE FS-1/FS-2 follow WTS_sim.features; worksheets print without answers or trainer notes; search finds the field answers',
    wp: WP,
    run(app, assert) {
      const { course, scenarios } = content(app);
      const H = app.win.WTS_help, S = app.win.WTS_sim;
      const today = (id) => JSON.stringify(scenarios.filter((s) => s.id === id)[0].today).slice(2, 40).replace(/\*\*/g, '');
      const plain = (h) => h.replace(/<[^>]+>/g, '');
      const had = S.features;
      try {
        S.features = undefined;
        let h = plain(H.renderList('scenarios'));
        assert.ok(h.indexOf('Rig-up: switch V-101') !== -1 && h.indexOf('Keep V-101 in and set') !== -1, 'today variants shown without the feature');
        assert.ok(h.indexOf('With V-101 out, well stream to') === -1, 'after-WP-SIM text hidden');
        S.features = { bypassDest: true };
        h = plain(H.renderList('scenarios'));
        assert.ok(h.indexOf('With V-101 out, well stream to') !== -1, 'after-WP-SIM text shown with the feature');
        assert.ok(h.indexOf('Rig-up: switch V-101') === -1 && h.indexOf('Keep V-101 in and set') === -1, 'today text replaced: ' + today('FS-1'));
        assert.ok(h.indexOf('Which pressure goes where') !== -1 && h.indexOf('A well that has been shut in arrives cold') !== -1, 'intro and FS-4 unchanged');
      } finally { S.features = had; }
      course.forEach((x, i) => {
        const full = plain(H.renderExercise(x, i, {})), ws = plain(H.renderExercise(x, i, { worksheet: true }));
        assert.ok(full.indexOf('For the trainer') !== -1 && full.indexOf('Answers') !== -1, x.id + ': answers and trainer notes on screen');
        assert.ok(ws.indexOf('For the trainer') === -1 && ws.indexOf('Answers') === -1 && ws.indexOf(plain(x.answers[0]).slice(0, 30)) === -1, x.id + ': worksheet has no answers or notes');
      });
      const hits = (q) => H.search(q).map((r) => r.id);
      assert.ok(hits('burner').includes('FS-1') && hits('burner').includes('ex3'), 'burner → FS-1 and exercise 3: ' + hits('burner'));
      assert.ok(['FS-1', 'FS-2'].includes(hits('production pressure')[0]), 'production pressure → FS-1/FS-2 first: ' + hits('production pressure'));
      assert.ok(hits('cushion').includes('FS-1'), 'cushion → FS-1');
    },
  },
  {
    name: 'HELPCOURSE checks bite: unknown tag, fault label, missing debrief, wrong number, wrong alarm window',
    wp: WP,
    run(app, assert) {
      const { course, scenarios } = content(app);
      const V = engineVocab(app);
      const c = JSON.parse(JSON.stringify(course[3]));
      c.steps.push('Watch LSHH-999 and FAKE_ALARM.', 'Then **Scenarios → LCV-999 stuck**.');
      const r = refIssues([c], V).join(' | ');
      assert.ok(/tag LSHH-999/.test(r) && /alarm id FAKE_ALARM/.test(r) && /fault "LCV-999 stuck"/.test(r), r);
      assert.ok(/bold "no such button"/.test(boldIssues(app, [{ id: 'x', steps: ['Select **No such button**.'] }]).join(' ')), 'bold check');
      openWts(app, {});
      const bad = JSON.parse(JSON.stringify(course));
      bad[0].trainer.debrief = ['one'];
      bad[1].form = { wts_nothing: 1 };
      const sh = shapeIssues(app, bad, scenarios).join(' | ');
      assert.ok(/debrief needs 3–5/.test(sh) && /form id wts_nothing/.test(sh), sh);
      const pc = pageCheck(app, 'neg', { kind: 'page', set: { wts_bean: 30 }, expectState: { 'flow.choke.QmaxMMscfd': 9.0 }, expectText: ['not on the page'] }).join(' | ');
      assert.ok(/QmaxMMscfd = 9\.41/.test(pc) && /does not show "not on the page"/.test(pc), pc);
      const sc = simCheck(app, 'neg', { kind: 'sim', run: 60, expect: [{ alarm: 'CHOKE_LIMIT', from: 0, to: 30 }, { at: 60, path: 'nodes.wellhead.P', v: 2000 }] }).join(' | ');
      assert.ok(/alarm CHOKE_LIMIT first at undefined/.test(sc) && /nodes\.wellhead\.P = 3000/.test(sc.replace(/3000\.\d+/, '3000')), sc);
    },
  },
];
module.exports.CHECKS = CHECKS;
