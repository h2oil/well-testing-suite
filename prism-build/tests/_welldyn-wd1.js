// Well Dynamics lane WD1 — test helper (engine + reservoir). docs/WELL-DYNAMICS-PLAN.md §3.9, §5.1, §5.2, §11.1.
//
// The WD0 contract files (tests/_welldyn-shapes.js, tests/_welldyn-mock.js) and the WD0 export WTS_flowline_gradAt were not on wd/int
// when this lane started, so WD1 tests run against:
//   • sourceOverrides()  the in-memory 49-calc-flowline.js with the one additive export of the plan §2.5 (R5):
//       G.WTS_flowline_gradAt = function (fluid, p, T, seg, opt) { return _gAt(fluid, p, T, seg, opt || {}); };
//     added next to the other exports only when the file does not have it yet (a no-op once WD0 is merged);
//   • FIX                the gate and scenario fixtures of §3.9 built from the Well Performance fixtures (the WD1 subset: gasVert, gasLoad,
//                        gasHz, oilVert, oilVertTuned, oilDev, staticOil, buildup) with the scenario event lists. WD0's frozen file
//                        replaces this at integration (the numbers here are the §3.9 values; nothing is tuned beyond the table).
//   • sharedApp(ctx)     one app per test file (the harness build with the override).
'use strict';

const fs = require('fs');
const path = require('path');
const WP = require('./_wellperf-shapes');

const BUILD = path.resolve(__dirname, '..');
const clone = (o) => JSON.parse(JSON.stringify(o));

let _ov = null;
function sourceOverrides() {
  if (_ov) return _ov;
  const f = path.join(BUILD, '49-calc-flowline.js');
  let s = fs.readFileSync(f, 'utf8');
  if (s.indexOf('WTS_flowline_gradAt') === -1) {
    const anchor = 'G.WTS_flowline_compute = compute;';
    if (s.indexOf(anchor) === -1) throw new Error('_welldyn-wd1: export anchor not found in 49-calc-flowline.js');
    s = s.replace(anchor, anchor + '\n    G.WTS_flowline_gradAt = function (fluid, p, T, seg, opt) { return _gAt(fluid, p, T, seg, opt || {}); };');
    _ov = { '49-calc-flowline.js': s };
  } else _ov = {};
  return _ov;
}

const TUB_2_7_8 = { id: 2.441, od: 2.875, wall: 0.217 };
const CSG_7 = { id: 6.276, od: 7.0, wall: 0.362 };
const LNR_4_5 = { id: 3.958, od: 4.5, wall: 0.271 };

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
function gasLoad() {
  const M = gasVert();
  // §3.9: p̄r 1,200 psia leaves the bean-32 loading margin at −0.63 (the bean alone cannot reach [−0.05, +0.10]); p̄r 1,400 psia gives
  // +0.015 at bean 32 and −0.66 at bean 16 — recorded in §11.1 for WD0's pinned fixture
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
  const mid = heel + 1000;
  Object.assign(M.well, { perfTopMd: heel + 50, perfBotMd: toe - 50, midPerfMd: mid });
  M.well.strings = [Object.assign({ kind: 'tubing', tubKey: null, rough: 0.0006, topMd: 0, botMd: heel }, TUB_2_7_8),
    Object.assign({ kind: 'liner', tubKey: null, rough: 0.0006, topMd: heel, botMd: toe }, LNR_4_5)];
  M.surface.choke.bean64 = 24;
  return M;
}
function oilVert() { return WP.FIX.oilWell; }
function oilVertTuned() { const M = oilVert(); M.system.mult = { hl: 1.10, f: 0.90 }; return M; }
function oilDev() {
  const M = WP.FIX.oilWell, g = WP.FIX.gasWell;
  M.well.survey = g.well.survey;
  Object.assign(M.well, { perfTopMd: 9900, perfBotMd: 10000, midPerfMd: 9950 });
  M.well.strings = [Object.assign({ kind: 'tubing', tubKey: null, rough: 0.0006, topMd: 0, botMd: 9850 }, TUB_2_7_8),
    Object.assign({ kind: 'casing', tubKey: null, rough: 0.0006, topMd: 9850, botMd: 10100 }, CSG_7)];
  M.well.geo = { surfT_F: 60, points: [[0, 60], [9300, 200]] };
  // §3.9 gives no (tune) number here, but at the S-survey's 9,480 ft TVD p̄r 3,000 psia has no nodal root (NO_FLOW): 3,500 psia is used
  // (critical choke, y = 0.418) — recorded in §11.1 for WD0's pinned fixture
  M.res.pr = 3500;
  return M;
}
function buildup() {
  const M = oilVert();
  Object.assign(M.res, { model: 'darcyOil', params: { k: 50, h: 50, rw: 0.354, re: 1500, S: 2 } });
  M.dyn = { v: 1, res: { k: 50, h: 50, phi: 0.2, ct: 1.5e-5, rw: 0.354, re: 1500, S: 2 } };
  return M;
}
const RES_BUILDUP = { mode: 'transient', k: 50, h: 50, phi: 0.2, ct: 1.5e-5, rw: 0.354, re: 1500, S: 2, prior: { kind: 'steady', t_h: 720 } };

const MAKERS = { gasVert, gasLoad, gasHz, oilVert, oilVertTuned, oilDev, staticOil: oilVert, buildup };
const FIX = {};
Object.keys(MAKERS).forEach((k) => Object.defineProperty(FIX, k, { enumerable: true, get: () => clone(MAKERS[k]()) }));
// scenario event lists (§3.9 FIX.scenarios; the WD1 subset), durations s
const H = 3600;
const SCEN = {
  beanUp: { fix: 'oilVert', opts: { events: [{ t: 0, type: 'bean', args: { bean64: 16 } }, { t: 1 * H, type: 'bean', args: { bean64: 24 } }, { t: 2 * H, type: 'bean', args: { bean64: 32 } }] }, duration_s: 4 * H },
  shutInBuildup: { fix: 'buildup', opts: { reservoir: RES_BUILDUP, events: [{ t: 2 * H, type: 'shutin' }] }, duration_s: 10 * H },
  gasLoadDown: { fix: 'gasLoad', opts: { fallback: true, events: [{ t: 1 * H, type: 'bean', args: { bean64: 16 } }] }, duration_s: 8 * H },
  levelSettle: { fix: 'staticOil', opts: { start: 'static', static: { kind: 'level', liquidTopMd: 4000, liquid: 'oil' }, reservoir: { prior: { kind: 'none' } } }, duration_s: 8 * H },
  killColumn: { fix: 'gasVert', opts: { start: 'static', static: { kind: 'liquid', liquid: 'water' }, reservoir: { prior: { kind: 'none' } } }, duration_s: 2 * H },
  staticOil: { fix: 'staticOil', opts: { start: 'static', static: { kind: 'liquid', liquid: 'oil' }, reservoir: { prior: { kind: 'none' } }, events: [{ t: 60, type: 'open' }] }, duration_s: 2 * H }
};
const GATE = ['gasVert', 'gasHz', 'oilVert', 'oilVertTuned', 'oilDev'];
const TOL = { q: 0.02, pwf: 0.01, thpRel: 0.01, thpAbs: 3, ampQ: 0.005, ampP: 2 };

let _shared = null;
function sharedApp(ctx) {
  const key = String(ctx.mode);
  if (_shared && _shared.key === key) return _shared.app;
  _shared = { key, app: ctx.loadApp({ sourceOverrides: sourceOverrides() }) };
  return _shared.app;
}
// run until the §5.1 time-mean criterion holds (two consecutive windows), capped
function runSteady(sim, o) {
  o = o || {};
  const win = o.win_s || 600, cap = o.cap_s || 6 * 3600, chunk = o.chunk_s || 300;
  let chk = null;
  while (sim.state.t < cap) {
    const r = sim.run(chunk);
    if (!r.ok) return { ok: false, code: r.code, t: sim.state.t };
    if (sim.state.t >= 2 * win + (o.after_s || 0)) { chk = sim.steadyCheck(win); if (chk.steady) break; }
  }
  return { ok: true, chk: chk || sim.steadyCheck(win), t: sim.state.t };
}
// one memo per process (the engine runs are shared by welldyn-engine / -res / -gate when they run in one accept-test process)
const _memo = new Map();
function memo(key, fn) { if (!_memo.has(key)) _memo.set(key, fn()); return _memo.get(key); }
// run a §3.9 scenario and keep what the tests read: step infos (dt, massErr, rejects), states, the post-shut-in build-up samples
function runScenario(g, name, o) {
  o = o || {};
  const sc = SCEN[name], opts = clone(sc.opts);
  if (o.opts) Object.assign(opts, o.opts);
  const sim = g.WTS_wd_engine.create(FIX[sc.fix], opts);
  if (!sim.ok) return { ok: false, code: sim.code, sim };
  const st = sim.state, out = { ok: true, sim, steps: [], states: [], bu: [], res: sim.res, I: sim.C.I, maxErrStep: 0, wallMs: 0 };
  const tShut = (opts.events || []).filter((e) => e.type === 'shutin').map((e) => e.t)[0];
  let nextBu = null;
  sim.on('step', (i) => {
    const e = Math.max(i.massErr.G, i.massErr.O, i.massErr.W, i.massErr.I);
    if (e > out.maxErrStep) out.maxErrStep = e;
    out.steps.push({ t: i.t, dt: i.dt, rejects: i.rejects, iters: i.iters, errCum: st.balance.errCum, qs: sim.gasWell() ? st.surface.qgForm : st.surface.qL,
      qres: sim.gasWell() ? st.bottom.qg : st.bottom.qo + st.bottom.qw, pwf: st.bottom.pwf, thp: st.surface.thp, liqTop: st.inventory.liquidTopMd, liq: st.inventory.liqTubing_bbl,
      ratio: st.loading.ratio, qc: st.loading.qc_MMscfd, state: st.well.state });
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
const GATE_OPTS = { start: 'steady', reservoir: { mode: 'ipr' }, closure: 'corr', temperature: 'frozen', cells: 60 };
function steadySim(g, key, opts) {
  return memo('steady:' + key + JSON.stringify(opts || {}), () => {
    const sim = g.WTS_wd_engine.create(FIX[key], Object.assign({}, GATE_OPTS, opts || {}));
    return { sim, rs: sim.ok ? runSteady(sim, { cap_s: 3 * 3600 }) : { ok: false, code: sim.code } };
  });
}
function files() {
  const out = [];
  fs.readdirSync(BUILD).forEach((f) => { if (/^49-calc-wd-(engine|res)\.js$/.test(f)) out.push(path.join(BUILD, f)); });
  fs.readdirSync(__dirname).forEach((f) => { if (/^welldyn-(engine|res|gate)\.test\.js$/.test(f) || f === '_welldyn-wd1.js') out.push(path.join(__dirname, f)); });
  return out;
}
module.exports = { FIX, SCEN, GATE, TOL, RES_BUILDUP, sourceOverrides, sharedApp, runSteady, runScenario, memo, steadySim, GATE_OPTS, files, BUILD };
