// Well Dynamics lane WD4 — test helper (lift transients + oil heading). docs/WELL-DYNAMICS-PLAN.md §3.9, §5.1, §5.3, §11.4.
//
// WD0's frozen fixture file (tests/_welldyn-shapes.js) was never written, so the lift fixtures of §3.9 are built here the same way as the
// WD1 helper (tests/_welldyn-wd1.js, whose fixtures, gate options and runners this file re-uses). The integrator folds them into WD0's
// file when it lands. Numbers changed from the §3.9 table (recorded in §11.4):
//   gasLift  p̄r 2,600 psia (the (tune) number; 2,400 leaves the unloading spacing short of the injection point), valve ΔP 250 psi and
//            design port 12/64 in (with 100 psi / 16/64 in the Asheim injection loop gain F2 ≈ 2: screen (c) fails); a full 7" casing to
//            the packer (the annulus); glValves = WTS_wp_gl.valvesFromDesign of the design on this model (pinned below, checked by LF5)
//   esp      bean 20/64 in (at 32 the nodal choke is sub-critical — screen (a)); stages from sizeStages at 1,500 STB/d at bean 20 (224,
//            pinned); a full 7" casing to the pump
'use strict';

const W = require('./_welldyn-wd1');
const WP = require('./_wellperf-shapes');

const clone = (o) => JSON.parse(JSON.stringify(o));
const CSG_7_FULL = { kind: 'casing', tubKey: null, rough: 0.0006, topMd: 0, botMd: 7950, id: 6.276, od: 7.0, wall: 0.362 };
// the pinned design of the gasLift fixture (WTS_wp_gl.design → valvesFromDesign at the values below; LF5 re-runs the design)
const GL_VALVES = null;   // filled by pin() on first use (the design is deterministic; LF5 compares)

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
// the fixtures need the app (the example pump record and the design): FIXL(g).gasLift / .esp
const _cache = new Map();
function FIXL(g) {
  const run = (job) => { let s, n = 0; do { s = job.step(); n++; } while (!s.done && n < 500); return job.result(); };
  const out = {};
  out.gasLiftNoValves = (o) => gasLiftBase(o);
  out.gasLift = (o) => {
    const key = 'gl' + JSON.stringify(o || {});
    if (!_cache.has(key)) {
      const M = gasLiftBase(o), R = g.WTS_wp_system.solve(M), D = run(g.WTS_wp_gl.design(M, R));
      _cache.set(key, { valves: D && D.ok ? g.WTS_wp_gl.valvesFromDesign(D) : [], D });
    }
    const M = gasLiftBase(o); M.lift.gl.valves = clone(_cache.get(key).valves);
    return M;
  };
  out.gasLiftDesign = (o) => { out.gasLift(o); return _cache.get('gl' + JSON.stringify(o || {})).D; };
  out.esp = (o) => { const M = espBase(o); M.lift.esp.pump = g.WTS_wp_esp.example(); return M; };
  return out;
}
const H = 3600;
const SCEN4 = {
  glUnload: { fix: 'gasLift', opts: { start: 'static', static: { kind: 'liquid', liquid: 'water' }, reservoir: { prior: { kind: 'none' } },
    events: [{ t: 0, type: 'open' }, { t: 0, type: 'gl', args: { qinj_Mscfd: 600, mode: 'valves' } }] }, duration_s: 12 * H },
  espStart: { fix: 'esp', opts: { start: 'static', static: { kind: 'liquid', liquid: 'water' }, reservoir: { prior: { kind: 'none' } },
    events: [{ t: 0, type: 'open' }, { t: 0, type: 'esp', args: { on: true, freq: 60, ramp_Hz_s: 1 } }] }, duration_s: 2 * H },
  cycleTimer: { fix: 'gasLoad', opts: { fallback: true, events: [{ t: 0, type: 'cycle', args: { mode: 'timer', open_h: 2, shut_h: 2, cycles: 3 } }] }, duration_s: 12 * H }
};
const GATE4 = { gasLift: { ext: { gaslift: { mode: 'nodal' } } }, esp: {} };

function files() {
  const fs = require('fs'), path = require('path'), out = [];
  [path.join(W.BUILD, '49-calc-wd-lift.js')].forEach((f) => { if (fs.existsSync(f)) out.push(f); });
  fs.readdirSync(__dirname).forEach((f) => { if (f === 'welldyn-lift.test.js' || f === '_welldyn-wd4.js') out.push(path.join(__dirname, f)); });
  return out;
}
module.exports = { W, FIXL, SCEN4, GATE4, gasLiftBase, espBase, files, H, GL_VALVES };
