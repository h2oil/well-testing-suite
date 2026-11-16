// Well Dynamics frozen contract fixtures — docs/WELL-DYNAMICS-PLAN.md §3.9 (WD0, written at 4.6.1; hash-pinned like _wellperf-shapes.js).
//
// WD0 never ran before the 4.6 waves, so the lanes built their fixtures in stand-in helpers (tests/_welldyn-wd1.js, tests/_welldyn-wd4.js).
// This file replaces both (4.6.1): the same models and numbers, the gas-lift valve rows and the ESP pump record pinned as data, plus the
// casing-heading fixture of 4.6.1 (§11.7). The tests read it through require('./_welldyn-shapes'); welldyn-shapes.test.js pins the hash.
//
//   FIX.<key>          a fresh complete model M per read (gasVert, gasLoad, gasHz, oilVert, oilVertTuned, oilDev, gasLift, esp, staticOil,
//                      buildup, heading) — built from the Well Performance fixtures (require('./_wellperf-shapes').FIX) with the §3.9 changes
//                      and the deviations recorded in §11.1 / §11.4 / §11.7
//   EXPECT.<key>       the pinned steady reference of WTS_wp_system.solve (q, pwf, thp, choke regime, R.lift.injMd / pump intake)
//   SCEN.<name>        {fix, opts, duration_s} (§3.9 FIX.scenarios as shipped)
//   GATE, GATE4, GATE_OPTS, TOL, RES_BUILDUP    the consistency gate (§5.1) fixtures, options and tolerances
//   ORDER              {COMP, STATES, CHANNELS, REGIMES} — frozen orders (C9: new keys are appended, never inserted)
//   SHAPE_SPECS, SHAPES, checkShape(name, obj)  Sim, State, StepInfo, Snap, Event, Rec, RunFile, Case, Summary, Ext
//   FIXL(g)            variants that need the app: gasLift(o) re-runs WTS_wp_gl.design on a changed model, gasLiftDesign(o), esp(o)
//   sharedApp(ctx), resetWellDyn(app), loadFix(app, key), files(), STUBS, BASELINE
//   runSteady, runScenario, steadySim, memo        shared runners (one memo per process, so the engine runs are shared between test files)
'use strict';

const fs = require('fs');
const path = require('path');
const WP = require('./_wellperf-shapes');

const BUILD = path.resolve(__dirname, '..');
const REPO = path.resolve(BUILD, '..');
const H = 3600;
const clone = (o) => JSON.parse(JSON.stringify(o));

// ── models (§3.9) ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const TUB_2_7_8 = { id: 2.441, od: 2.875, wall: 0.217 };
const CSG_7 = { id: 6.276, od: 7.0, wall: 0.362 };
const LNR_4_5 = { id: 3.958, od: 4.5, wall: 0.271 };
const CSG_7_FULL = { kind: 'casing', tubKey: null, rough: 0.0006, topMd: 0, botMd: 7950, id: 6.276, od: 7.0, wall: 0.362 };

function gasVert() {
  const M = WP.FIX.gasWell;
  M.well.survey = [[0, 0], [10000, 10000]];
  M.well.strings = [Object.assign({ kind: 'tubing', tubKey: null, rough: 0.0006, topMd: 0, botMd: 9850 }, TUB_2_7_8),
    Object.assign({ kind: 'casing', tubKey: null, rough: 0.0006, topMd: 9850, botMd: 10100 }, CSG_7)];
  M.res.pr = 3500;
  M.fluid.wgr = 10;
  M.surface.psep_psig = 500;
  M.surface.choke.bean64 = 24;
  return M;
}
// §11.1: p̄r 1,200 psia leaves the bean-32 loading margin at −0.63; p̄r 1,400 psia gives +0.015 at bean 32 and −0.66 at bean 16
function gasLoad() {
  const M = gasVert();
  M.res.pr = 1400; M.fluid.wgr = 30; M.surface.psep_psig = 300; M.surface.choke.bean64 = 32;
  return M;
}
// vertical to 7,000 ft, build 8°/100 ft to 90° (1,125 ft MD), 2,000 ft lateral, azimuth 120°
function gasHz() {
  const M = WP.FIX.gasWell;
  const KOP = 7000, BUR = 8, buildMd = 90 / BUR * 100, heel = KOP + buildMd, toe = heel + 2000, az = 120;
  const rows = [[0, 0, az], [KOP, 0, az]];
  for (let inc = 15; inc <= 90; inc += 15) rows.push([KOP + inc / BUR * 100, inc, az]);
  rows.push([toe, 90, az]);
  M.well.survey = rows;
  Object.assign(M.well, { perfTopMd: heel + 50, perfBotMd: toe - 50, midPerfMd: heel + 1000 });
  M.well.strings = [Object.assign({ kind: 'tubing', tubKey: null, rough: 0.0006, topMd: 0, botMd: heel }, TUB_2_7_8),
    Object.assign({ kind: 'liner', tubKey: null, rough: 0.0006, topMd: heel, botMd: toe }, LNR_4_5)];
  M.surface.choke.bean64 = 24;
  return M;
}
function oilVert() { return WP.FIX.oilWell; }
function oilVertTuned() { const M = oilVert(); M.system.mult = { hl: 1.10, f: 0.90 }; return M; }
// §11.1: at the S-survey's 9,480 ft TVD p̄r 3,000 psia has no nodal root (NO_FLOW): 3,500 psia (critical choke, y = 0.418)
function oilDev() {
  const M = WP.FIX.oilWell, g = WP.FIX.gasWell;
  M.well.survey = g.well.survey;
  Object.assign(M.well, { perfTopMd: 9900, perfBotMd: 10000, midPerfMd: 9950 });
  M.well.strings = [Object.assign({ kind: 'tubing', tubKey: null, rough: 0.0006, topMd: 0, botMd: 9850 }, TUB_2_7_8),
    Object.assign({ kind: 'casing', tubKey: null, rough: 0.0006, topMd: 9850, botMd: 10100 }, CSG_7)];
  M.well.geo = { surfT_F: 60, points: [[0, 60], [9300, 200]] };
  M.res.pr = 3500;
  return M;
}
function buildup() {
  const M = oilVert();
  Object.assign(M.res, { model: 'darcyOil', params: { k: 50, h: 50, rw: 0.354, re: 1500, S: 2 } });
  M.dyn = { v: 1, res: { k: 50, h: 50, phi: 0.2, ct: 1.5e-5, rw: 0.354, re: 1500, S: 2 } };
  return M;
}
// §11.4 deviations: gasLift p̄r 2,600 psia (the (tune) number), valve ΔP 250 psi and design port 12/64 in (screen (c): Asheim F2 0.39), a
// full 7" casing to the packer (the annulus); esp bean 20/64 in (screen (a)), 224 stages (sizeStages at 1,500 STB/d), a full 7" casing
function gasLiftBase(o) {
  o = o || {};
  const M = WP.FIX.oilWell;
  Object.assign(M.fluid, { wc: 0.6, gor: 200 });
  M.res.pr = o.pr || 2600;
  M.well.strings.push(clone(CSG_7_FULL));
  M.lift = { type: 'gaslift', gl: { qinj_Mscfd: o.qinj || 600, pinj_psig: o.pinj || 1100, sginj: 0.65, dpValve: o.dpv == null ? 250 : o.dpv, packerMd: 7900, qinjList_Mscfd: [],
    design: { pko_psig: null, gs: null, ftub: null, minsp: null, dpdrop: null, port64: o.port || 12, R: null, qL: null, dmaxMd: null }, valves: [] }, esp: null };
  return M;
}
// WTS_wp_gl.valvesFromDesign(WTS_wp_gl.design(gasLiftBase(), solve)) — pinned at 4.6.1 (welldyn-shapes WS3 re-runs the design and compares)
const GL_VALVES = [
  { md: 1970, port: 12, ptro: 999, R: 0.0359, kind: 'ipo' }, { md: 2956, port: 12, ptro: 984, R: 0.0359, kind: 'ipo' },
  { md: 3709, port: 12, ptro: 966, R: 0.0359, kind: 'ipo' }, { md: 4334, port: 12, ptro: 948, R: 0.0359, kind: 'ipo' }
];
function gasLift() { const M = gasLiftBase(); M.lift.gl.valves = clone(GL_VALVES); return M; }
function espBase(o) {
  o = o || {};
  const M = WP.FIX.oilWell;
  Object.assign(M.fluid, { wc: o.wc == null ? 0.8 : o.wc, gor: o.gor || 100 });
  M.res.pr = o.pr || 2500;
  if (o.J) M.res.params = { J: o.J };
  M.well.strings.push(clone(CSG_7_FULL));
  M.surface.choke.bean64 = o.bean || 20;
  M.lift = { type: 'esp', gl: {}, esp: { pump: null, pumpMd: 7500, freq: o.freq || 60, stages: o.stages || 224, natSep: !!o.natSep, visc: false } };
  return M;
}
// WTS_wp_esp.example() — pinned at 4.6.1 (WS3 compares with the shipped example)
const ESP_PUMP = { v: 1, name: 'Example pump (generic, 60 Hz)', f0: 60,
  rows: [[0, 31, 0, 0.17], [300, 30.51, 22.4, 0.301], [600, 29.36, 40, 0.325], [900, 27.55, 52.7, 0.346], [1200, 25.07, 60.7, 0.365], [1500, 21.93, 63.9, 0.379],
    [1800, 18.13, 62.3, 0.386], [2100, 13.66, 55.9, 0.378], [2400, 8.53, 44.8, 0.337], [2700, 2.73, 28.8, 0.189]],
  qMin: 1000, qMax: 2100, od_in: 4, example: true };
function esp() { const M = espBase(); M.lift.esp.pump = clone(ESP_PUMP); return M; }
// 4.6.1 (§11.7, §4.13): casing heading. The gasLift well with one orifice valve (20/64 in) at 3,000 ft MD, the packer at 3,100 ft, lift gas
// 200 Mscf/d at 750 psig (kick-off 850 psig) — a low injection into a 7" annulus through an orifice that stays below the critical pressure
// ratio. The model, not an imposed signal, cycles: the annulus blows down through the orifice, the tubing loads up and the well stops, the
// annulus recharges until the casing pressure at the orifice passes the tubing pressure, gas enters and the well unloads (period ≈ 75 min,
// THP ≈ 100 ↔ 250 psig at 60 cells). The nodal solve has a stable root (57 STB/d) and the Asheim screening says 'ok' (F2 0.31) — the
// transient does not settle on it (recorded in §11.7).
function heading() {
  const M = gasLiftBase({ qinj: 200, pinj: 750 });
  M.lift.gl.packerMd = 3100;
  M.lift.gl.valves = [{ md: 3000, port: 20, kind: 'orifice' }];
  return M;
}
const RES_BUILDUP = { mode: 'transient', k: 50, h: 50, phi: 0.2, ct: 1.5e-5, rw: 0.354, re: 1500, S: 2, prior: { kind: 'steady', t_h: 720 } };

const MAKERS = { gasVert, gasLoad, gasHz, oilVert, oilVertTuned, oilDev, gasLift, esp, staticOil: oilVert, buildup, heading };
const FIX = {};
Object.keys(MAKERS).forEach((k) => Object.defineProperty(FIX, k, { enumerable: true, get: () => clone(MAKERS[k]()) }));

// the steady reference of WTS_wp_system.solve on each fixture (pinned at 4.6.1, 7 significant digits; WS2 re-solves and compares within 1e-6).
// gasLoad's nodal choke is sub-critical (§11.1: the loading fixture is not a gate fixture); the heading fixture's is 'subcritical-bound'
const EXPECT = {
  gasVert: { q: 4988.156, pwf: 2917.505, thp: 1891.957, regime: 'critical' },
  gasLoad: { q: 1181.018, pwf: 1140.066, thp: 369.5708, regime: 'subcritical' },
  gasHz: { q: 8248.746, pwf: 4180.136, thp: 3143.44, regime: 'critical' },
  oilVert: { q: 913.8744, pwf: 2543.063, thp: 335.1041, regime: 'critical' },
  oilVertTuned: { q: 759.1965, pwf: 2620.402, thp: 280.8734, regime: 'critical' },
  oilDev: { q: 875.9212, pwf: 3062.039, thp: 321.7975, regime: 'critical' },
  gasLift: { q: 460.2956, pwf: 2369.852, thp: 356.4936, regime: 'critical', injMd: 4562.046 },
  esp: { q: 1501.613, pwf: 1749.194, thp: 282.8986, regime: 'critical', pInt: 1533.434 },
  staticOil: { q: 913.8744, pwf: 2543.063, thp: 335.1041, regime: 'critical' },
  buildup: { q: 978.8235, pwf: 2596.258, thp: 357.8755, regime: 'critical' },
  heading: { q: 57.28707, pwf: 2571.356, thp: 197.2582, regime: 'subcritical-bound', injMd: 3033.421 }
};

// ── scenarios (§3.9 FIX.scenarios as shipped), durations s ───────────────────────────────────────────────────────────────
const SCEN = {
  beanUp: { fix: 'oilVert', opts: { events: [{ t: 0, type: 'bean', args: { bean64: 16 } }, { t: 1 * H, type: 'bean', args: { bean64: 24 } }, { t: 2 * H, type: 'bean', args: { bean64: 32 } }] }, duration_s: 4 * H },
  shutInBuildup: { fix: 'buildup', opts: { reservoir: RES_BUILDUP, events: [{ t: 2 * H, type: 'shutin' }] }, duration_s: 10 * H },
  gasLoadDown: { fix: 'gasLoad', opts: { fallback: true, events: [{ t: 1 * H, type: 'bean', args: { bean64: 16 } }] }, duration_s: 8 * H },
  levelSettle: { fix: 'staticOil', opts: { start: 'static', static: { kind: 'level', liquidTopMd: 4000, liquid: 'oil' }, reservoir: { prior: { kind: 'none' } } }, duration_s: 8 * H },
  killColumn: { fix: 'gasVert', opts: { start: 'static', static: { kind: 'liquid', liquid: 'water' }, reservoir: { prior: { kind: 'none' } } }, duration_s: 2 * H },
  staticOil: { fix: 'staticOil', opts: { start: 'static', static: { kind: 'liquid', liquid: 'oil' }, reservoir: { prior: { kind: 'none' } }, events: [{ t: 60, type: 'open' }] }, duration_s: 2 * H },
  // lift (§11.4): the full kill column of §3.9; welldyn-validate and welldyn-lift start glUnload from the balance level (WTS_wd_lift.balanceLevel)
  glUnload: { fix: 'gasLift', opts: { start: 'static', static: { kind: 'liquid', liquid: 'water' }, reservoir: { prior: { kind: 'none' } },
    events: [{ t: 0, type: 'open' }, { t: 0, type: 'gl', args: { qinj_Mscfd: 600, mode: 'valves' } }] }, duration_s: 12 * H },
  espStart: { fix: 'esp', opts: { start: 'static', static: { kind: 'liquid', liquid: 'water' }, reservoir: { prior: { kind: 'none' } },
    events: [{ t: 0, type: 'open' }, { t: 0, type: 'esp', args: { on: true, freq: 60, ramp_Hz_s: 1 } }] }, duration_s: 2 * H },
  cycleTimer: { fix: 'gasLoad', opts: { fallback: true, events: [{ t: 0, type: 'cycle', args: { mode: 'timer', open_h: 2, shut_h: 2, cycles: 3 } }] }, duration_s: 12 * H },
  // 4.6.1: casing heading from the steady start (default options); the detector reads the last 3 h (1.5 – 4.5 h)
  casingHeading: { fix: 'heading', opts: {}, duration_s: 4.5 * H }
};
// the extension each lift scenario needs (welldyn-validate skips a scenario whose extension is not loaded)
const SCEN_EXT = { glUnload: 'gaslift', espStart: 'esp', cycleTimer: 'cycle', casingHeading: 'gaslift' };
const GATE = ['gasVert', 'gasHz', 'oilVert', 'oilVertTuned', 'oilDev'];
const GATE4 = { gasLift: { ext: { gaslift: { mode: 'nodal' } } }, esp: {} };
const GATE_OPTS = { start: 'steady', reservoir: { mode: 'ipr' }, closure: 'corr', temperature: 'frozen', cells: 60 };
const TOL = { q: 0.02, pwf: 0.01, thpRel: 0.01, thpAbs: 3, ampQ: 0.005, ampP: 2 };
// the heading criterion of the task (§4.13 detector): ≥ 3 THP peak pairs in the last 3 h, the last peak-to-peak ≥ 0.8 × the first
const HEADING = { window_s: 3 * H, pairs: 3, sustain: 0.8 };

// ── frozen orders (C9) ─────────────────────────────────────────────────────────────────────────────────────────────────────
const ORDER = Object.freeze({
  COMP: Object.freeze(['G', 'O', 'W', 'I', 'F']),
  STATES: Object.freeze(['stable', 'startup', 'unloading', 'marginal', 'loading', 'heading', 'dying', 'dead', 'shutin', 'gl_unloading', 'gl_lifting',
    'gl_multipoint', 'esp_off', 'esp_ramp', 'esp_running', 'esp_pumpoff', 'esp_gaslock', 'esp_tripped']),
  CHANNELS: Object.freeze(['t', 'thp', 'tht', 'pwf', 'pr', 'pcs', 'qo', 'qw', 'qL', 'qg', 'qo_res', 'qw_res', 'qg_res', 'gor', 'wc', 'bean', 'open', 'state', 'lratio',
    'qc', 'liq', 'gascap', 'qinj', 'opValve', 'pint', 'freq', 'load', 'foam', 'dt', 'massErr', 'qgForm', 'gorForm', 'qvent', 'liftgas', 'qcVert', 'qcBelfroid']),
  REGIMES: Object.freeze(['liquid', 'bubble', 'slug', 'churn', 'annular', 'mist', 'stratified', 'segregated', 'gas', 'unknown'])
});

// ── shapes (§3.1 – §3.8 as shipped; 'x?' = may be null / absent, 'typed' = a Float64Array / Uint8Array) ─────────────────────
const SHAPE_SPECS = {
  Sim: { ok: 'bool', version: 'str', engineId: 'str', M: 'obj', R0: 'obj', C: 'obj', ref: 'obj', mHash: 'str', opts: 'obj', grid: 'obj', n: 'num', state: 'obj',
    step: 'fn', run: 'fn', snapshot: 'fn', restore: 'fn', schedule: 'fn', setChoke: 'fn', shutIn: 'fn', open: 'fn', setSeparator: 'fn', setFoamer: 'fn', setLift: 'fn',
    steadyCheck: 'fn', on: 'fn', off: 'fn', dispose: 'fn' },
  State: { t: 'num', dt: 'num', n: 'num', open: 'num', bean64: 'num', beanEff: 'num', psep_psig: 'num', tOpen: 'num', qRef: 'num',
    cells: { p: 'typed', T: 'typed', ag: 'typed', ao: 'typed', aw: 'typed', mG: 'typed', mO: 'typed', mW: 'typed', mI: 'typed', mF: 'typed', vg: 'typed', vl: 'typed', vm: 'typed',
      rhoM: 'typed', vc: 'typed', sigF: 'typed', regime: 'typed' },
    faces: { Q: 'typed', jg: 'typed', jo: 'typed', jw: 'typed', xI: 'typed', vd: 'typed', c0: 'typed', w: 'typed' },
    surface: { thp: 'num', thp_psig: 'num', tht: 'num', pDn_psig: 'num', qo: 'num', qw: 'num', qL: 'num', qg: 'num', qgForm: 'num', qinj: 'num', qvent: 'num', glr: 'num?',
      gor: 'num?', gorForm: 'num?', wc: 'num?', regime: 'str', y: 'num?', yc: 'num?' },
    bottom: { pwf: 'num', pr: 'num', qo: 'num', qw: 'num', qg: 'num', drawdown: 'num' },
    well: { state: 'str', since: 'num', reason: 'str?', prev: 'str?' },
    loading: { method: 'str?', both: 'bool', liquid: 'str?', qc_MMscfd: 'num?', qcVert_MMscfd: 'num?', qcBelfroid_MMscfd: 'num?', belfroid: 'bool', limitingMd: 'num?',
      limitingTvd: 'num?', ratio: 'num?', vRatioMin: 'num?', belowEot: 'bool?' },
    inventory: { liq_bbl: 'num', liqTubing_bbl: 'num', gas_Mscf: 'num', liftGas_Mscf: 'num', liquidTopMd: 'num?', gasCapBottomMd: 'num?' },
    balance: { m: 'obj', cumIn: 'obj', cumOut: 'obj', errStep: 'num', errCum: 'num', volDrift: 'num' },
    lift: { gl: 'obj?', esp: 'obj?' }, foamer: { on: 'bool', ppm: 'num', eff: 'num' }, res: { mode: 'str', backflow: 'bool' }, flags: 'arr', provisional: 'arr' },
  StepInfo: { ok: 'bool', t: 'num', dt: 'num', iters: 'num', sweeps: 'num', rejects: 'num', massErr: { G: 'num', O: 'num', W: 'num', I: 'num' }, applied: 'arr' },
  Snap: { kind: 'str', v: 'num', engine: 'str', engineId: 'str', mHash: 'str', n: 'num', t: 'num', steps: 'num', dtPrev: 'num',
    cells: { mG: 'arr', mO: 'arr', mW: 'arr', mI: 'arr', mF: 'arr', T: 'arr', p: 'arr' },
    faces: { Q: 'arr', jg: 'arr', jo: 'arr', jw: 'arr', xI: 'arr', vd: 'arr', c0: 'arr', w: 'arr' },
    ctl: { open: 'num', bean64: 'num', beanEff: 'num', strokeLeft_s: 'num', psep_psig: 'num', tOpen: 'num', qRef: 'num' },
    line: { refGor: 'num?', refWc: 'num?', q: 'arr', pdn: 'arr' }, res: { mode: 'str' },
    labels: { state: 'str', since: 'num', prev: 'str?', reason: 'str?', pending: 'obj?', ringT: 'arr', ringLiq: 'arr', ringQ: 'arr', ringP: 'arr', dying: 'obj?', heading: 'obj?' },
    steady: { ringT: 'arr', ringQ: 'arr', ringPwf: 'arr', ringThp: 'arr' }, pend: 'arr', log: 'arr', ext: 'obj',
    bal: { m0: 'obj', cumIn: 'obj', cumOut: 'obj' }, prov: 'arr', flags: 'arr' },
  Event: { t: 'num', type: 'str', args: 'obj?', src: 'str?' },
  Rec: { attach: 'fn', sample: 'fn', channels: 'fn', times: 'fn', series: 'fn', at: 'fn', snapAt: 'fn', truncate: 'fn', mark: 'fn', marks: 'fn', unmark: 'fn', events: 'fn',
    csv: 'fn', toFile: 'fn', bytes: 'fn', clear: 'fn' },
  RunFile: { format: 'str', v: 'num', app: 'str?', created: 'str', engine: 'str', engineId: 'str', well: 'obj', model: { scalars: 'obj', tables: 'obj' }, settings: 'obj',
    events: 'arr', duration_s: 'num', rec: { every_s: 'num', t: 'arr', ch: 'obj', marks: 'arr' }, snaps: 'obj?', summary: 'obj?', hash: 'str' },
  Case: { id: 'str', name: 'str?', created: 'str?', settings: 'obj', events: 'arr', duration_s: 'num', summary: 'obj?', note: 'str?' },
  Summary: { duration_s: 'num', endState: 'str?', states: 'arr', qo: 'num?', qw: 'num?', qg: 'num?', qgForm: 'num?', gorForm: 'num?', prior: 'obj?', thp_psig: 'num?',
    pwf: 'num?', qMax: 'num?', qMin: 'num?', thpMax_psig: 'num?', pwfMax: 'num?', liqMax_bbl: 'num?', tLoading_h: 'num?', tDead_h: 'num?', cumO_STB: 'num?', cumW_STB: 'num?',
    cumG_MMscf: 'num?', buildup: 'obj?', gate: 'obj?', provisional: 'arr', massErr: 'num?', engineId: 'str' },
  Ext: { key: 'str', verified: 'bool', provisional: 'str', applies: 'fn', init: 'fn', snapshot: 'fn', restore: 'fn' }
};
const _isTyped = (v) => !!v && typeof v === 'object' && ArrayBuffer.isView(v) && !(v instanceof DataView);
function chk(spec, v, p, errs) {
  if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
    if (!v || typeof v !== 'object') { errs.push(p + ': object expected'); return; }
    Object.keys(spec).forEach((k) => chk(spec[k], v[k], p + '.' + k, errs));
    return;
  }
  const opt = /\?$/.test(spec), t = String(spec).replace(/\?$/, '');
  if (v == null) { if (!opt) errs.push(p + ': missing'); return; }
  const ok = t === 'num' ? typeof v === 'number' : t === 'str' ? typeof v === 'string' : t === 'bool' ? typeof v === 'boolean' : t === 'fn' ? typeof v === 'function'
    : t === 'arr' ? Array.isArray(v) : t === 'typed' ? _isTyped(v) : t === 'obj' ? typeof v === 'object' : false;
  if (!ok) errs.push(p + ': ' + t + ' expected, got ' + (Array.isArray(v) ? 'array' : typeof v));
}
function checkShape(name, obj) {
  const spec = SHAPE_SPECS[name];
  if (!spec) return { ok: false, errors: ['unknown shape ' + name] };
  const errors = []; chk(spec, obj, name, errors);
  return { ok: errors.length === 0, errors };
}

// ── app-dependent variants (the design and the example pump come from the app) ─────────────────────────────────────────────
const _cache = new Map();
function FIXL(g) {
  const run = (job) => { let s, n = 0; do { s = job.step(); n++; } while (!s.done && n < 500); return job.result(); };
  const design = (o) => {
    const key = 'gl' + JSON.stringify(o || {});
    if (!_cache.has(key)) {
      const M = gasLiftBase(o), R = g.WTS_wp_system.solve(M), D = run(g.WTS_wp_gl.design(M, R));
      _cache.set(key, { valves: D && D.ok ? g.WTS_wp_gl.valvesFromDesign(D) : [], D });
    }
    return _cache.get(key);
  };
  const out = {};
  out.gasLiftNoValves = (o) => gasLiftBase(o);
  // no options: the pinned fixture (no design run); options: the design re-run on the changed model
  out.gasLift = (o) => { if (!o || !Object.keys(o).length) return FIX.gasLift; const M = gasLiftBase(o); M.lift.gl.valves = clone(design(o).valves); return M; };
  out.gasLiftDesign = (o) => design(o).D;
  out.designValves = (o) => clone(design(o).valves);
  out.esp = (o) => { if (!o || !Object.keys(o).length) return FIX.esp; const M = espBase(o); M.lift.esp.pump = g.WTS_wp_esp.example(); return M; };
  return out;
}

// ── app and storage helpers ───────────────────────────────────────────────────────────────────────────────────────────────
// the R5 export WTS_flowline_gradAt is shipped since 4.6 (§11.7), so no source override is needed; kept for callers of the lane helpers
function sourceOverrides() { return {}; }
let _shared = null;
function sharedApp(ctx, opts) {
  if (!ctx || typeof ctx.loadApp !== 'function') throw new Error('_welldyn-shapes.sharedApp: needs the accept-test ctx (ctx.loadApp)');
  const key = String(ctx.mode) + JSON.stringify(opts || {});
  if (_shared && _shared.key === key) return _shared.app;
  _shared = { key, app: ctx.loadApp(opts || {}) };
  return _shared.app;
}
// clears the page autosave, the dyn key of the well model, WTS_state.welldyn and the device prefs wtspref_wd_*
function resetWellDyn(app) {
  const st = app.storage, del = [];
  for (let i = 0; i < st.length; i++) { const k = st.key(i); if (k === 'wts_page_welldyn' || /^wtspref_wd_/.test(k)) del.push(k); }
  del.forEach((k) => st.removeItem(k));
  const W = app.win.WTS_wp_model;
  if (W && typeof W.write === 'function') { try { W.write({ dyn: null }); } catch (e) { /* no dyn key yet */ } }
  if (app.win.WTS_state) delete app.win.WTS_state.welldyn;
}
// writes the fixture's tables through WTS_wp_model.write (survey, strings, flowline, geo; the scalars are the page's controls — the
// caller passes them, e.g. as wts_page_wellperf {f: {...}}, since the model has no inverse scalar map)
function loadFix(app, key, scalars) {
  const M = FIX[key], W = app.win.WTS_wp_model;
  const r = W.write({ survey: M.well.survey, strings: M.well.strings, flowline: M.surface.flowline, geo: M.well.geo });
  if (scalars) app.storage.setItem('wts_page_wellperf', JSON.stringify({ f: scalars }));
  return { ok: !!(r && r.ok), M, code: r && r.code };
}
// every Well Dynamics file the naming rule covers (welldyn-int INT2)
function files() {
  const out = [];
  fs.readdirSync(BUILD).forEach((f) => { if (/^49-calc-(wd-[a-z]+|welldyn)\.js$/.test(f) || f === 'welldyn-validate.js') out.push(path.join(BUILD, f)); });
  fs.readdirSync(__dirname).forEach((f) => { if (/^(welldyn-.*\.test\.js|_welldyn-.*\.js|_wd3-mock\.js)$/.test(f)) out.push(path.join(__dirname, f)); });
  out.push(path.join(REPO, 'docs', 'WELL-DYNAMICS-PLAN.md'));
  return out;
}
// WD0 stubs: none — WD0's stub layer was never built (the lanes shipped the real engines; §11.7)
const STUBS = {};
// the WD1 timing baseline (§11.1, Node, this container) — welldyn-validate --time fails only above 2 × these
const BASELINE = {
  createCold: { gasVert: 513, oilVert: 485, gasHz: 679 }, createRef: { gasVert: 27.6, oilVert: 33.3, gasHz: 27.9 },
  stepFlow: { gasVert: 3.46, oilVert: 3.64, gasHz: 3.41 }, stepShut: { gasVert: 4.7, oilVert: 4.2, gasHz: 3.8 },
  speedFlow: { gasVert: 1600, oilVert: 1900, gasHz: 464 }, speedShut: { gasVert: 5700, oilVert: 5800, gasHz: 4700 },
  snapshot: 0.33, restore: 3.3,
  scen: { gasLoadDown: 12700, levelSettle: 1300, shutInBuildup: 10300, killColumn: 4000, staticOil: 5400 }
};

// ── runners ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
// run until the §5.1 time-mean criterion holds (two consecutive windows), capped
function runSteady(sim, o) {
  o = o || {};
  const win = o.win_s || 600, cap = o.cap_s || 6 * H, chunk = o.chunk_s || 300;
  let chk2 = null;
  while (sim.state.t < cap) {
    const r = sim.run(chunk);
    if (!r.ok) return { ok: false, code: r.code, t: sim.state.t };
    if (sim.state.t >= 2 * win + (o.after_s || 0)) { chk2 = sim.steadyCheck(win); if (chk2.steady) break; }
  }
  return { ok: true, chk: chk2 || sim.steadyCheck(win), t: sim.state.t };
}
const _memo = new Map();
function memo(key, fn) { if (!_memo.has(key)) _memo.set(key, fn()); return _memo.get(key); }
// run a scenario and keep what the tests read: step infos (dt, massErr, rejects), states, the post-shut-in build-up samples, a 30 s THP ring
function runScenario(g, name, o) {
  o = o || {};
  const sc = SCEN[name], opts = clone(sc.opts);
  if (o.opts) Object.assign(opts, o.opts);
  const sim = g.WTS_wd_engine.create(FIX[sc.fix], opts);
  if (!sim.ok) return { ok: false, code: sim.code, sim };
  const st = sim.state, out = { ok: true, sim, steps: [], states: [], bu: [], ring: [], res: sim.res, I: sim.C.I, maxErrStep: 0, wallMs: 0 };
  const tShut = (opts.events || []).filter((e) => e.type === 'shutin').map((e) => e.t)[0];
  let nextBu = null, nextRing = 0;
  sim.on('step', (i) => {
    const e = Math.max(i.massErr.G, i.massErr.O, i.massErr.W, i.massErr.I);
    if (e > out.maxErrStep) out.maxErrStep = e;
    out.steps.push({ t: i.t, dt: i.dt, rejects: i.rejects, iters: i.iters, errCum: st.balance.errCum, qs: sim.gasWell() ? st.surface.qgForm : st.surface.qL,
      qres: sim.gasWell() ? st.bottom.qg : st.bottom.qo + st.bottom.qw, pwf: st.bottom.pwf, thp: st.surface.thp, liqTop: st.inventory.liquidTopMd, liq: st.inventory.liqTubing_bbl,
      ratio: st.loading.ratio, qc: st.loading.qc_MMscfd, state: st.well.state });
    if (st.t >= nextRing) { out.ring.push([st.t, st.surface.thp_psig, st.surface.qL, st.lift.gl ? st.lift.gl.pcs_psig : NaN]); nextRing = st.t + 30; }
    if (tShut != null && st.t > tShut + 1e-9) {
      if (nextBu == null) { nextBu = tShut + 10; out.qShut = out.qShut != null ? out.qShut : out.lastQres; }
      if (st.t >= nextBu) { out.bu.push({ dt: st.t - tShut, p: st.bottom.pwf }); nextBu = tShut + (st.t - tShut) * 1.03; }
    } else out.lastQres = sim.gasWell() ? st.bottom.qg : st.bottom.qo + st.bottom.qw;
  });
  sim.on('state', (e) => out.states.push(e));
  const t0 = Date.now();
  const r = sim.run(o.duration_s || sc.duration_s);
  out.wallMs = Date.now() - t0;
  if (!r.ok) { out.ok = false; out.code = r.code; }
  if (out.qShut == null) out.qShut = out.lastQres;
  return out;
}
// a gate-default steady run of a fixture, memoised per process: {sim, rs}
function steadySim(g, key, opts) {
  return memo('steady:' + key + JSON.stringify(opts || {}), () => {
    const sim = g.WTS_wd_engine.create(FIX[key], Object.assign({}, GATE_OPTS, opts || {}));
    return { sim, rs: sim.ok ? runSteady(sim, { cap_s: 3 * H }) : { ok: false, code: sim.code } };
  });
}
// the heading reading of a THP ring [[t, thp_psig, …]] over its last window: the shipped detector (WTS_wd_lift.headingOf) and, independently,
// the main cycles (upward crossings of the mid level between the window's minimum and maximum) with their period and swings
function headingRead(g, ring, o) {
  o = o || {};
  const win = o.window_s || HEADING.window_s, tEnd = ring.length ? ring[ring.length - 1][0] : 0;
  const R = ring.filter((r) => r[0] >= tEnd - win), T = R.map((r) => r[0]), P = R.map((r) => r[1]);
  const det = g.WTS_wd_lift.headingOf(T, P);
  const lo = Math.min(...P), hi = Math.max(...P), mid = lo + 0.5 * (hi - lo), up = [];
  for (let i = 1; i < P.length; i++) if (P[i - 1] < mid && P[i] >= mid) up.push(T[i]);
  const swings = [];
  for (let k = 0; k + 1 < up.length; k++) { const seg = P.filter((_, i) => T[i] >= up[k] && T[i] < up[k + 1]); swings.push(Math.max(...seg) - Math.min(...seg)); }
  const periods = []; for (let k = 1; k < up.length; k++) periods.push(up[k] - up[k - 1]);
  return { det, lo, hi, up, periods, swings, n: T.length };
}

module.exports = { FIX, EXPECT, SCEN, SCEN_EXT, GATE, GATE4, GATE_OPTS, TOL, HEADING, RES_BUILDUP, ORDER, SHAPE_SPECS, SHAPES: Object.keys(SHAPE_SPECS), checkShape,
  FIXL, gasLiftBase, espBase, GL_VALVES, ESP_PUMP, sourceOverrides, sharedApp, resetWellDyn, loadFix, files, STUBS, BASELINE,
  runSteady, runScenario, steadySim, memo, headingRead, H, BUILD, REPO };
