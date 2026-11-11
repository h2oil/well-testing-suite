// Well Performance contract fixtures — docs/WELL-PERFORMANCE-PLAN.md §3.12 (WP0, FROZEN: changes go through the lead).
//
// Exports
//   FIX.oilWell        vertical 8,000 ft oil well, 2-7/8" tubing, 35 °API, GOR 500, WC 30 %, p̄r 3,000 psia, PI 2 STB/d/psi,
//                      separator 100 psig, flowline 2,000 ft × 3", bean 32/64 — a complete model M (§3.1)
//   FIX.gasWell        10,000 ft deviated wet-gas well (S-shaped survey, MD / inclination / azimuth), 3-1/2" × 2-7/8" tapered
//                      tubing, separator gas sg 0.65, CGR 20 STB/MMscf, WGR 2 STB/MMscf, LIT (p²) a / b — a complete M
//   FIX.devSurvey      {rows: [[md, inc, azi]], expect: [{md, tvd, n, e, dep, dls}]}: a vertical section then one constant-curvature
//                      build at 3°/100 ft (azimuth 45°) — minimum curvature is exact on a circular arc, so the answers are closed form
//   FIX.fallingBranch  an oil well (large tubing, low PI, fixed THP) designed so its stable operating point sits on the falling
//                      branch of the VLP (left of the tubing-curve minimum) and right of q_s; WP5 confirms it with the engine
//   FIX.test1          one production test on FIX.oilWell (q, THP, THT, gauge)
//   FIX.dfitGeometry   a minimal PRiSM_state.dfit test record with a survey and strings, and the model patch it maps to
//   SHAPES / checkShape(name, obj)   SHAPE.R, SHAPE.I, SHAPE.G, SHAPE.SkinTable, SHAPE.Job, SHAPE.M  → {ok, errors[]}
//   STUBS              the WP0 stub names per file (each WP removes its own names from window.__WP_STUBS)
//   BASELINE           the WP0 timing baseline of the existing marcher (§16), container ms
//   sharedApp(ctx, opts?)  one app per test file; resetWellPerf(app) clears the module's storage keys and WTS_state.wellperf
//   files()            every Well Performance file the naming rule covers (wellperf-names)
//
// Conventions (§3.0): field units; psia inside engines, psig at surface inputs (*_psig); °F; ft; diameters and roughness in;
// STB/d, BWPD, Mscf/d (MMscf/d inside the flowline fluid); scf/STB; fractions 0..1 in the model (the page's WC control is in %).
'use strict';

const fs = require('fs');
const path = require('path');

const BUILD = path.resolve(__dirname, '..');
const REPO = path.resolve(BUILD, '..');
const clone = (o) => JSON.parse(JSON.stringify(o));
const deg = Math.PI / 180;

// ── a complete model M with the WTS_wp_model defaults (kept in step with 49-calc-wp-model.js _defaults) ─────────────
function baseM() {
  return {
    v: 1,
    fluid: { type: 'oil', api: 35, sgg: 0.65, sggBasis: 'separator', psep_psig: 100, tsep_F: 80, gor: 500, cgr: 0, wgr: 0, wc: 0,
      sgw: 1.07, salinity_ppm: 0, yN2: 0, yCO2: 0, yH2S: 0, pbUser: null,
      corr: { pb: 'standing', rs: 'standing', bo: 'standing', muod: 'beggsRobinson', muo: 'beggsRobinson', muou: 'vasquezBeggs',
        co: 'vasquezBeggs', z: 'dranchukAbouKassem', mug: 'leeGonzalezEakin', sigma: 'bakerSwerdloff' },
      match: null, bc: 1.0 },
    res: { model: 'pi', pr: null, T_F: 200, pb: null, params: {}, points: [], layers: [], provenance: {} },
    well: { datum: 'RKB', datumOffset_ft: 0, survey: [], perfTopMd: null, perfBotMd: null, midPerfMd: null, strings: [], path: 'tubing',
      restrictions: [], geo: { surfT_F: 60, points: [] },
      heat: { mode: 'linear', tht_F: null, thtMeasured: false, U_to: 2, tProd_d: 30, ke: 1.4, alpha: 0.04 } },
    surface: { choke: { present: true, bean64: 32, corr: 'gilbert', cd: 0.75 }, flowline: [], psep_psig: 100, ambient_F: 60,
      rating: { wellhead_psi: null, tht_max_F: null }, beans: [16, 20, 24, 32, 40, 48] },
    lift: { type: 'none', gl: { packerMd: null, qinjList_Mscfd: [], sginj: 0.65, pinj_psig: null, dpValve: 100 }, esp: null },
    system: { node: 'bottom', mode: 'rate', thp_psig: null, target: { kind: 'bean', q: null }, corr: { well: null, line: 'bb' }, mult: { hl: 1, f: 1 },
      eroC: 100, stepFt: 100, stepFtLine: 50, refine: true },
    tests: [],
    cases: [],
  };
}

const TUB_2_7_8 = { id: 2.441, od: 2.875, wall: 0.217 };     // 6.5 lb/ft
const TUB_3_1_2 = { id: 2.992, od: 3.5, wall: 0.254 };       // 9.3 lb/ft
const CSG_7 = { id: 6.276, od: 7.0, wall: 0.362 };           // 26 lb/ft

function oilWell() {
  const M = baseM();
  Object.assign(M.fluid, { type: 'oil', api: 35, sgg: 0.65, gor: 500, wc: 0.30, sgw: 1.07 });
  Object.assign(M.res, { model: 'pi', pr: 3000, T_F: 200, params: { J: 2 } });
  Object.assign(M.well, { survey: [[0, 0], [8000, 8000]], perfTopMd: 7980, perfBotMd: 8020, midPerfMd: 8000,
    strings: [Object.assign({ kind: 'tubing', tubKey: null, rough: 0.0006, topMd: 0, botMd: 7950 }, TUB_2_7_8),
      Object.assign({ kind: 'casing', tubKey: null, rough: 0.0006, topMd: 7950, botMd: 8100 }, CSG_7)],
    geo: { surfT_F: 60, points: [[0, 60], [8000, 200]] } });
  M.well.heat.tht_F = 120;
  Object.assign(M.surface, { choke: { present: true, bean64: 32, corr: 'gilbert', cd: 0.75 }, psep_psig: 100,
    flowline: [{ name: 'Flowline', len: 2000, id: 3.0, dz: 0 }] });
  return M;
}
function gasWell() {
  const M = baseM();
  Object.assign(M.fluid, { type: 'condensate', api: 55, sgg: 0.65, sggBasis: 'separator', gor: 0, cgr: 20, wgr: 2, wc: 0, sgw: 1.07 });
  // LIT in p²: p̄r² − pwf² = a·q + b·q², q Mscf/d (AOF ≈ 17,900 Mscf/d)
  Object.assign(M.res, { model: 'litP2', pr: 5000, T_F: 230, params: { a: 500, b: 0.05 } });
  Object.assign(M.well, { survey: GAS_SURVEY.map((r) => r.slice()), perfTopMd: 9900, perfBotMd: 10000, midPerfMd: 9950,
    strings: [Object.assign({ kind: 'tubing', tubKey: null, rough: 0.0006, topMd: 0, botMd: 5000 }, TUB_3_1_2),
      Object.assign({ kind: 'tubing', tubKey: null, rough: 0.0006, topMd: 5000, botMd: 9850 }, TUB_2_7_8),
      Object.assign({ kind: 'casing', tubKey: null, rough: 0.0006, topMd: 9850, botMd: 10100 }, CSG_7)],
    geo: { surfT_F: 70, points: [[0, 70], [9300, 230]] } });
  M.well.heat.tht_F = 140;
  Object.assign(M.surface, { choke: { present: true, bean64: 24, corr: 'gilbert', cd: 0.75 }, psep_psig: 800,
    flowline: [{ name: 'Flowline', len: 1500, id: 3.0, dz: 0 }] });
  M.system.corr.well = null;   // the default by fluid type: Gray (D5)
  return M;
}
// S-shaped: vertical to 2,000 ft, build 2°/100 ft to 30° at 3,500 ft, hold to 6,000 ft, drop 2°/100 ft to 0° at 7,500 ft,
// vertical to 10,000 ft MD; azimuth 120°. TVD at TD = 10,000 − 2·[1,500 − R sin30°]... computed by minimum curvature (WP4).
const GAS_SURVEY = [[0, 0, 0], [2000, 0, 120], [2500, 10, 120], [3000, 20, 120], [3500, 30, 120], [6000, 30, 120], [6500, 20, 120],
  [7000, 10, 120], [7500, 0, 120], [10000, 0, 120]];

// Closed-form minimum curvature on a circular arc: R = 18,000 / (π·BUR) ft for BUR in °/100 ft.
function devSurvey() {
  const BUR = 3, R = 18000 / (Math.PI * BUR), KOP = 1000, az = 45;
  const rows = [[0, 0, az], [KOP, 0, az]], expect = [{ md: 0, tvd: 0, n: 0, e: 0, dep: 0, dls: 0 }, { md: KOP, tvd: KOP, n: 0, e: 0, dep: 0, dls: 0 }];
  [30, 60, 90].forEach((incDeg) => {
    const th = incDeg * deg, md = KOP + R * th, dep = R * (1 - Math.cos(th));
    rows.push([md, incDeg, az]);
    expect.push({ md, tvd: KOP + R * Math.sin(th), n: dep * Math.cos(az * deg), e: dep * Math.sin(az * deg), dep, dls: BUR });
  });
  // a 500 ft horizontal hold at the end (inc 90°): TVD constant, departure +500
  const last = expect[expect.length - 1];
  rows.push([last.md + 500, 90, az]);
  expect.push({ md: last.md + 500, tvd: last.tvd, n: last.n + 500 * Math.cos(az * deg), e: last.e + 500 * Math.sin(az * deg), dep: last.dep + 500, dls: 0 });
  return { rows, expect, R, bur: BUR, tol: { ft: 0.01 } };
}

function fallingBranch() {
  const M = oilWell();
  Object.assign(M.fluid, { gor: 300, wc: 0.5 });
  Object.assign(M.res, { model: 'pi', pr: 3200, params: { J: 0.3 } });
  M.well.strings[0] = Object.assign({ kind: 'tubing', tubKey: null, rough: 0.0006, topMd: 0, botMd: 7950 }, TUB_3_1_2);
  Object.assign(M.surface, { choke: { present: false, bean64: null, corr: 'gilbert', cd: 0.75 }, psep_psig: 100, flowline: [] });
  Object.assign(M.system, { node: 'bottom', mode: 'rate', thp_psig: 100 });   // no choke: fixed THP 100 psig
  M.expect = { opLeftOfVlpMin: true, opRightOfQs: true, stable: true, confirmedBy: 'WP5' };
  return M;
}

function test1() {
  return { id: 'T1', date: '2026-11-01', q_o: 700, q_w: 300, q_g: 350, thp_psig: 250, tht_F: 120, bean64: 32, gaugeMd: 7900,
    gauge_psia: 2500, chp_psig: null, qinj_Mscfd: null, use: true, note: 'fixture' };
}

function dfitGeometry() {
  const test = { id: 't1', zone: 'Zone A', dsRef: null, summary: null,
    inputs: { datumTvd: 9000, datumMd: 9500, survey: [[0, 0], [3000, 3000], [9500, 9000]],
      strings: [{ tubKey: null, id: 2.992, od: 3.5, wall: 0.254, topMd: 0, botMd: 9400 },
        { tubKey: null, id: 6.184, od: 7, wall: 0.408, topMd: 9400, botMd: 9600 }] } };
  const expect = { ok: true, patch: { survey: [[0, 0], [3000, 3000], [9500, 9000]],
    strings: [{ kind: 'tubing', tubKey: null, id: 2.992, od: 3.5, wall: 0.254, rough: null, topMd: 0, botMd: 9400 },
      { kind: 'casing', tubKey: null, id: 6.184, od: 7, wall: 0.408, rough: null, topMd: 9400, botMd: 9600 }] },
  scalars: { wp_midPerf: 9500 } };
  return { state: { v: 2, active: 't1', tests: [test], plan: null, live: null }, test, expect };
}

const FIX = {};
[['oilWell', oilWell], ['gasWell', gasWell], ['devSurvey', devSurvey], ['fallingBranch', fallingBranch], ['test1', test1],
  ['dfitGeometry', dfitGeometry]].forEach(([k, f]) => Object.defineProperty(FIX, k, { enumerable: true, get: () => clone(f()) }));

// ── shapes ────────────────────────────────────────────────────────────────────────────────────────────────────────
// Spec language: 'num' (finite), 'num?' (finite or null), 'pos', 'int', 'str', 'str?', 'bool', 'fn', 'obj', 'arr', 'any';
// "'a'|'b'" enumerations; {…} nested objects (extra keys allowed); [spec] arrays of spec; {$orNull: spec}.
const SHAPES = {
  M: {
    v: 'int',
    fluid: { type: "'oil'|'gas'|'condensate'|'water'|'gasinj'|'waterinj'", api: 'num?', sgg: 'num?', sggBasis: "'total'|'separator'",
      gor: 'num?', cgr: 'num?', wgr: 'num?', wc: 'num?', corr: 'obj' },
    res: { model: 'str', pr: 'num?', T_F: 'num?', params: 'obj', points: 'arr' },
    well: { survey: 'arr', strings: [{ id: 'pos', od: 'pos', topMd: 'num', botMd: 'num' }], path: "'tubing'|'annulus'", restrictions: 'arr',
      geo: { surfT_F: 'num?', points: 'arr' }, heat: { mode: "'linear'|'relax'" } },
    surface: { choke: { present: 'bool', bean64: 'num?' }, flowline: 'arr', psep_psig: 'num?', rating: 'obj', beans: ['num'] },
    lift: { type: "'none'|'gaslift'|'esp'" },
    system: { node: "'bottom'|'wellhead'|'separator'", mode: "'rate'|'pressure'|'max'|'design'", thp_psig: 'num?', corr: 'obj', mult: { hl: 'num', f: 'num' },
      eroC: 'pos', stepFt: 'pos', refine: 'bool' },
    tests: 'arr',
  },
  I: { ok: 'bool', kind: "'oil'|'gas'", pr: 'num', pb: 'num?', aof: 'num?', J: 'num?', qAt: 'fn', pwfAt: 'fn', curve: [{ q: 'num', pwf: 'num' }],
    skin: 'any', warnings: 'arr' },
  // a correlation result (the shape WTS_flowline_bb returns, §3.4)
  G: { hl: 'num', lambdaL: 'num', pattern: 'str', rhoS: 'num', rhoN: 'num', grad: 'num', gradEl: 'num', gradF: 'num', gradAcc: 'num', Ek: 'num',
    vm: 'num', vsl: 'num', vsg: 'num' },
  SkinTable: { parts: [{ key: 'str', label: 'str', S: 'num', basis: "'h'|'hp'", source: 'str' }], total: 'num', dpSkin: 'fn', FE: 'num?' },
  Job: { step: 'fn', done: 'fn', result: 'fn' },
  R: { ok: 'bool', node: "'bottom'|'wellhead'|'separator'", roots: [{ q: 'num', p: 'num', stable: 'bool', dDdq: 'num' }],
    op: { $orNull: { q: 'num', p: 'num', stable: 'bool' } }, qs: { $orNull: { q: 'num', p: 'num' } }, vlpMin: { $orNull: { q: 'num', p: 'num' } },
    traverse: { $orNull: { profile: [{ md: 'num', tvd: 'num', inc: 'num', p: 'num', t: 'num' }] } }, breakdown: [{ key: 'str', dp: 'num' }],
    surface: 'obj', rates: 'obj', flags: 'arr', discontinuities: 'arr', warnings: 'arr', evals: 'num' },
};
const isNum = (v) => typeof v === 'number' && isFinite(v);
function chk(spec, v, p, errs) {
  if (errs.length > 200) return;
  if (spec && typeof spec === 'object' && !Array.isArray(spec) && '$orNull' in spec) { if (v === null) return; return chk(spec.$orNull, v, p, errs); }
  if (Array.isArray(spec)) {
    if (!Array.isArray(v)) { errs.push(p + ': expected an array'); return; }
    v.forEach((x, i) => chk(spec[0], x, p + '[' + i + ']', errs));
    return;
  }
  if (spec && typeof spec === 'object') {
    if (!v || typeof v !== 'object' || Array.isArray(v)) { errs.push(p + ': expected an object'); return; }
    Object.keys(spec).forEach((k) => chk(spec[k], v[k], p ? p + '.' + k : k, errs));
    return;
  }
  const s = String(spec);
  if (s.indexOf("'") === 0) { const opts = s.split('|').map((x) => x.replace(/'/g, '')); if (opts.indexOf(v) === -1) errs.push(p + ': expected one of ' + opts.join(', ') + ', got ' + JSON.stringify(v)); return; }
  const ok = {
    num: isNum(v), 'num?': v === null || isNum(v), pos: isNum(v) && v > 0, int: Number.isInteger(v), str: typeof v === 'string',
    'str?': v === null || typeof v === 'string', bool: typeof v === 'boolean', fn: typeof v === 'function', obj: !!v && typeof v === 'object' && !Array.isArray(v),
    arr: Array.isArray(v), any: true,
  }[s];
  if (ok === undefined) errs.push(p + ': unknown spec ' + s);
  else if (!ok) errs.push(p + ': expected ' + s + ', got ' + (v === undefined ? 'undefined' : JSON.stringify(v)).slice(0, 60));
}
function checkShape(name, obj) {
  if (!SHAPES[name]) return { ok: false, errors: ['unknown shape ' + name] };
  const errors = [];
  chk(SHAPES[name], obj, '', errors);
  return { ok: errors.length === 0, errors };
}

// ── WP0 stubs (window.__WP_STUBS), per owning work package ──────────────────────────────────────────────────────────
const STUBS = {
  WP1: ['WTS_wp_fluid.build', 'WTS_wp_fluid.table', 'WTS_wp_fluid.check', 'WTS_wp_fluid.recombine', 'WTS_wp_fluid.flowlineFluid'],
  WP2: ['WTS_wp_ipr.curve', 'WTS_wp_ipr.fit', 'WTS_wp_ipr.fromWell', 'WTS_wp_ipr.skin'],
  WP3: ['WTS_wp_vlp.traverse', 'WTS_wp_vlp.curve', 'WTS_wp_vlp.family', 'WTS_wp_vlp.gasDry', 'WTS_wp_vlp.singlePhase'],
  WP4: ['WTS_wp_well.build', 'WTS_wp_well.segmentsFor', 'WTS_wp_well.restrictions', 'WTS_wp_well.temperature', 'WTS_wp_well.schematic'],
  WP5: ['WTS_wp_system.solve', 'WTS_wp_system.designFor', 'WTS_wp_system.maxRate', 'WTS_wp_system.shutIn', 'WTS_wp_system.beanSchedule',
    'WTS_wp_loading', 'WTS_wp_check'],
  WP6: ['WTS_wp_sens.matrix', 'WTS_wp_sens.job', 'WTS_wp_sens.table', 'WTS_wp_sens.csv'],
  WP7: ['WTS_wp_match.compare', 'WTS_wp_match.iprFromTest', 'WTS_wp_match.tune', 'WTS_wp_qc'],
};

// ── WP0 timing baseline of the existing marcher (container, node 22, test harness; §16) ────────────────────────────
// 8,000 ft vertical, 2.441 in, Beggs & Brill, Standing / DAK props, 700 STB/d oil + 300 BWPD + 0.35 MMscf/d, THP 250 psig, reverse:
// 160 steps of 50 ft. Measured 2026-11-11 on master a3e87c3 (before WP0b) and re-measured after WP0b at stepFt 100.
const BASELINE = {
  measured: '2026-11-11', node: 'v22',
  traverse8000ft_50ft_ms: 17.0, msPerStep: 0.106, traverse10000ft_50ft_ms: 22.3,
  // one fine evaluation E (§16): 10,000 ft at 100 ft steps (WP0b stepFt), Beggs & Brill — see wellperf-identity FI-T
  E_ms: 10.1,
};

// ── shared app per test file + reset ─────────────────────────────────────────────────────────────────────────────
let _shared = null;
function callerFile() {
  const st = String(new Error().stack || '').split('\n');
  for (const ln of st) { const m = /\(?([^()\s]+\.test\.js):\d+:\d+\)?/.exec(ln); if (m) return path.basename(m[1]); }
  return '(unknown)';
}
function sharedApp(ctx, opts) {
  if (!ctx || typeof ctx.loadApp !== 'function') throw new Error('_wellperf-shapes.sharedApp: needs the accept-test ctx (ctx.loadApp)');
  const key = callerFile() + '|' + ctx.mode + '|' + JSON.stringify(opts || null, (k, v) => (k === 'sourceOverrides' && v ? Object.keys(v).map((f) => f + ':' + String(v[f]).length) : v));
  if (_shared && _shared.key === key) return _shared.app;
  if (_shared && _shared.app && typeof _shared.app.dispose === 'function') { try { _shared.app.dispose(); } catch (_) { /* ignore */ } }
  _shared = { key, app: ctx.loadApp(opts || {}) };
  return _shared.app;
}
function resetWellPerf(app) {
  const g = app && (app.win || app.window);
  if (!g) return;
  if (app.timersMode === 'manual' && typeof app.flush === 'function') { try { app.flush(400); } catch (_) { /* ignore */ } }
  if (g.WTS_state && typeof g.WTS_state === 'object') delete g.WTS_state.wellperf;
  const s = app.storage;
  if (s && typeof s.length === 'number' && typeof s.key === 'function') {
    const keys = [];
    for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k === 'wts_wellperf_model' || k === 'wts_page_wellperf' || /^wtspref_wp_/.test(k)) keys.push(k); }
    keys.forEach((k) => s.removeItem(k));
  }
}

// ── the files the naming rule covers (§2.11) ─────────────────────────────────────────────────────────────────────
function files() {
  const out = [];
  fs.readdirSync(BUILD).forEach((f) => {
    if (/^4\d-calc-(wp-.*|wellperf|help-wellperf)\.js$/.test(f) || f === 'wellperf-validate.js') out.push(path.join('prism-build', f));
  });
  fs.readdirSync(__dirname).forEach((f) => { if (/^(wellperf-.*\.test\.js|_wellperf-shapes\.js)$/.test(f)) out.push(path.join('prism-build', 'tests', f)); });
  ['docs/WELL-PERFORMANCE-PLAN.md'].forEach((f) => { if (fs.existsSync(path.join(REPO, f))) out.push(f); });
  return out.sort();
}

module.exports = { FIX, SHAPES: Object.keys(SHAPES), SHAPE_SPECS: SHAPES, checkShape, STUBS, BASELINE, sharedApp, resetWellPerf, files, REPO, BUILD };
