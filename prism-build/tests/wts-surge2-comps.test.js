// Well Test Simulator — release 4.1 (WTS_sim code comments v1.7.0): T-202 with two compartments A | B like T-201 (t202 design,
// INTEGRATION step E2). (a) The refactored T-201 compartment logic (the shared tk* kernel) is bit-identical to the frozen v3.4.1
// engine on the v1.6.0 default line-up (T-202 out); (b) the single-compartment T-202 (cfg.surge2.compartments 1) is bit-identical
// to v3.4.1; (c) the dual behaviour: standby start, the route opens the fill line-up, compartment auto-divert, LCV-202 suction,
// LSHH-202 per compartment, PSHH-202, make-before-break, the auto route, controls, balances and the snapshot null rule.
// Engines run in their own vm contexts (tests/_wts-equip-shapes.js loadEngine); the frozen side ignores the pin keys.
'use strict';

const X = require('./_wts-equip-shapes');
const { v341Opts } = require('./_wts-lineup-pin.js');

const WP = 'WTSS2C';
const J = (o) => JSON.parse(JSON.stringify(o));
let W0 = null, F0 = null;
const work = () => (W0 = W0 || X.loadEngine('work'));
const frozen = () => (F0 = F0 || X.loadEngine('v341'));
const st = (sim) => J(sim.getState());
function run(sim, secs, dt, cb) {
  const n = Math.round(secs / dt);
  for (let i = 0; i < n; i++) { sim.advance(dt); if (cb && cb(st(sim), i)) return true; }
  return false;
}
const active = (s, id) => s.alarms.some((a) => a.id === id);
const logged = (s, id) => s.alarmLog.some((a) => a.id === id);
// every path of the old snapshot a must be === in b (NaN = NaN); new keys of b are ignored
function oldPathsDiff(a, b, p, out) {
  if (out.length > 6) return out;
  if (a === null || typeof a !== 'object') {
    if (!(a === b || (typeof a === 'number' && a !== a && b !== b))) out.push(p + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b));
    return out;
  }
  if (b === null || typeof b !== 'object') { out.push(p + ': not an object'); return out; }
  if (Array.isArray(a) && (!Array.isArray(b) || a.length !== b.length)) { out.push(p + ': length ' + a.length + ' vs ' + (b && b.length)); return out; }
  Object.keys(a).forEach((k) => oldPathsDiff(a[k], b[k], p + '.' + k, out));
  return out;
}
function evRec(sim, out) {
  ['divert', 'suction', 'control', 'alarm', 'clear', 'trip', 'pumpTrip', 'rigup'].forEach((n) => sim.on(n, (p) => out.push(n + '|' + p.t + '|' + (p.msg || '') + '|' + (p.from === undefined ? '' : p.from) + '|' + (p.to === undefined ? '' : p.to))));
}
// pair: frozen v3.4.1 and the working engine (v341Opts: compartments 1, vent hp, routing v341; T-201 line-up NOT pinned)
function pair(opts, setup, secs, dt, every, assert, tag) {
  const A = frozen(), B = work();
  const a = A.create(A.SAMPLE_FLOW, Object.assign({ seed: 14 }, opts || {})), b = B.create(B.SAMPLE_FLOW, v341Opts(Object.assign({ seed: 14 }, opts || {})));
  const ea = [], eb = [];
  evRec(a, ea); evRec(b, eb);
  if (setup) { setup(a, 'a'); setup(b, 'b'); }
  const n = Math.round(secs / dt), k = Math.max(1, Math.round(every / dt));
  for (let i = 1; i <= n; i++) {
    a.advance(dt); b.advance(dt);
    if (i % k === 0 || i === n) {
      const d = oldPathsDiff(J(a.getState()), J(b.getState()), '', []);
      assert.ok(d.length === 0, tag + ' at t = ' + (i * dt) + ' s: ' + d.join(' | '));
    }
  }
  assert.strictEqual(eb.join('\n'), ea.join('\n'), tag + ': events (msg / from / to)');
  assert.strictEqual(J(b.getState()).alarmLog.map((e) => e.msg).join('\n'), J(a.getState()).alarmLog.map((e) => e.msg).join('\n'), tag + ': alarm log');
  return { a, b };
}
function finiteBad(o, nullable, p, bad) {
  p = p || ''; bad = bad || [];
  if (o === null) { if (nullable.indexOf(p.replace(/\[\d+\]/g, '[*]')) < 0) bad.push(p + '=null'); return bad; }
  if (o === undefined) { bad.push(p + '=undefined'); return bad; }
  if (typeof o === 'number') { if (!isFinite(o)) bad.push(p + '=' + o); return bad; }
  if (Array.isArray(o)) { o.forEach((v, i) => finiteBad(v, nullable, p + '[' + i + ']', bad)); return bad; }
  if (typeof o === 'object') Object.keys(o).forEach((k) => finiteBad(o[k], nullable, p ? p + '.' + k : k, bad));
  return bad;
}
// a dual T-202 in the rig-up on the working engine (the default: compartments 2)
function dual(o) {
  o = o || {};
  const S = work(), f = J(S.SAMPLE_FLOW);
  Object.keys(o.sim || {}).forEach((k) => { f.sim[k] = o.sim[k]; });
  return S.create(f, Object.assign({ seed: o.seed || 5, rigup: Object.assign({ surge2: true }, o.rigup || {}) }, o.config ? { config: o.config } : {}));
}
const inletOk = (sim) => { const c = sim.getControls().surge2; return c.inlet === !!(c.comp.inlet[0] || c.comp.inlet[1]); };
const comps = (s) => s.surge2.comps;

module.exports = [
  // ── (a) T-201 refactor vs the frozen v3.4.1 engine (v1.6.0 default line-up, T-202 out) ──
  {
    name: 'WTSS2C (a) T-201 on the v1.6.0 default line-up is bit-identical to v3.4.1: 4 h default, 3 h at dt 60 with A↔B diverts, SP 0.6 below LSH (the kick)',
    wp: WP, opts: false, timeoutMs: 300000,
    run(app, assert) {
      pair({}, null, 4 * 3600, 10, 600, assert, 'default 4 h');
      const r = pair({}, null, 3 * 3600, 60, 600, assert, 'dt 60');
      assert.ok(r.b.getState().alarmLog.some((e) => e.id === 'AUTO_DIVERT'), 'several A↔B diverts happened');
      pair({}, (s) => s.setAutoDivert('surge', true, { sp: 0.6 }), 2 * 3600, 10, 300, assert, 'SP 0.6');
    },
  },
  {
    name: 'WTSS2C (a) T-201 identity: auto-divert off (LAH-201 A / B texts), suction low-low auto-switch, LSHH-201 ESD and reset, gauge auto-divert',
    wp: WP, opts: false, timeoutMs: 300000,
    run(app, assert) {
      pair({}, (s) => s.setAutoDivert('surge', false), 3 * 3600, 10, 600, assert, 'auto-divert off');
      // low-low on the single suction: LCV-201 stuck closed fills B? — force the draw-down with a small tank and LCV-201 stuck, then clear
      pair({}, (s) => { s.setConfig({ surge: { lsll: 0.30, lsl: 0.32 } }); }, 3600, 10, 300, assert, 'suction low-low auto-switch');
      pair({}, (s) => { s.setFault('xferStuckClosed', true); }, 3 * 3600, 10, 600, assert, 'LCV-201 stuck → LSHH-201 ESD');
      const r = pair({}, (s) => { s.setFault('xferStuckClosed', true); s.setAutoDivert('gauge', true); }, 2 * 3600, 10, 600, assert, 'gauge auto');
      r.a.setFault('xferStuckClosed', false); r.b.setFault('xferStuckClosed', false);
      r.a.resetESD(); r.b.resetESD();
      for (let i = 0; i < 120; i++) { r.a.advance(10); r.b.advance(10); }
      assert.deepStrictEqual(oldPathsDiff(J(r.a.getState()), J(r.b.getState()), '', []), [], 'after reset');
    },
  },
  // ── (b) the single-compartment T-202 (compartments 1) vs v3.4.1 ──
  {
    name: 'WTSS2C (b) T-202 single compartment (compartments 1) is bit-identical to v3.4.1: routes both / T-202, auto route, LCV-202 stuck → LSHH-202, PCV-203 stuck → PSHH-202 ESD',
    wp: WP, opts: false, timeoutMs: 300000,
    run(app, assert) {
      const R = { rigup: { surge2: true } };
      pair(R, (s) => s.setSurgeRoute('both'), 3 * 3600, 10, 600, assert, 'route both');
      pair(R, (s) => s.setSurgeRoute('surge2'), 3 * 3600, 10, 600, assert, 'route surge2');
      pair(R, (s) => s.setAutoDivert('surge2', true, { sp: 0.6 }), 3 * 3600, 10, 600, assert, 'auto route');
      pair(R, (s) => { s.setSurgeRoute('surge2'); s.setFault('xfer2StuckClosed', true); }, 3 * 3600, 10, 600, assert, 'LCV-202 stuck');
      pair(R, (s) => { s.setSurgeRoute('surge2'); s.setFault('bpv2StuckClosed', true); }, 1800, 5, 300, assert, 'PCV-203 stuck');
    },
  },
  {
    name: 'WTSS2C (b) T-202 single compartment: removed while it is the only route, resized through setConfig, controls round trip — identical to v3.4.1',
    wp: WP, opts: false, timeoutMs: 300000,
    run(app, assert) {
      const R = { rigup: { surge2: true } };
      const r = pair(R, (s) => s.setSurgeRoute('surge2'), 1800, 10, 300, assert, 'T-202 only');
      r.a.setRigup({ surge2: false }); r.b.setRigup({ surge2: false });
      for (let i = 0; i < 180; i++) { r.a.advance(10); r.b.advance(10); }
      assert.deepStrictEqual(oldPathsDiff(J(r.a.getState()), J(r.b.getState()), '', []), [], 'after removal');
      const q = pair(R, (s) => s.setSurgeRoute('both'), 1800, 10, 300, assert, 'before resize');
      q.a.setConfig({ surge2: { cap_bbl: 150 } }); q.b.setConfig({ surge2: { cap_bbl: 150 } });
      for (let i = 0; i < 180; i++) { q.a.advance(10); q.b.advance(10); }
      assert.deepStrictEqual(oldPathsDiff(J(q.a.getState()), J(q.b.getState()), '', []), [], 'after resize');
      const cb = J(q.b.getControls()), ca = J(q.a.getControls());
      assert.deepStrictEqual(Object.assign({}, cb.surge2, { comp: undefined }), Object.assign({}, ca.surge2, { comp: undefined }), 'controls (old keys)');
      assert.strictEqual(q.b.getState().surge2.compartments, 1, 'compartments 1');
      assert.strictEqual(q.b.getState().surge2.valveTag, 'XV-202', 'valveTag single');
    },
  },
  // ── (c) dual behaviour (working engine default) ──
  {
    name: 'WTSS2C (c) dual T-202 starts empty on standby (XV-202A/B shut, A lined up to fill, B on LCV-202, auto-divert on); the route opens XV-202A only',
    wp: WP, opts: false,
    run(app, assert) {
      const S = work();
      assert.strictEqual(S.SURGE2_COMP_DEF, 2); assert.deepStrictEqual(J(S.SURGE2_LINEUP), { inlet: [true, false], suction: 'B', auto: true, initFrac: [0, 0] });
      assert.strictEqual(S.features.surge2Comps, true);
      const sim = dual({ config: { surge2: { xvStrokeS: 6 } } });
      let s = st(sim);
      assert.ok(s.surge2.compartments === 2 && s.surge2.comps.length === 2 && !comps(s)[0].inlet && !comps(s)[1].inlet && !s.surge2.inlet, 'standby');
      assert.deepStrictEqual(s.surge2.fill, [true, false]); assert.strictEqual(s.surge2.suction, 'B'); assert.strictEqual(s.surge2.divert.on, true);
      assert.ok(comps(s)[0].tag === 'T-202A' && comps(s)[1].tag === 'T-202B' && comps(s)[0].valveTag === 'XV-202A' && s.surge2.valveTag === 'XV-202A/B', 'tags');
      assert.ok(s.surge2.frac === 0 && comps(s)[0].frac === 0 && comps(s)[1].frac === 0, 'empty');
      assert.ok(inletOk(sim), 'derived inlet');
      const r = sim.setSurgeRoute('surge2');
      assert.ok(r.ok && /XV-202A OPEN · XV-202B CLOSED/.test(r.msg), r.msg);
      s = st(sim);
      assert.ok(comps(s)[0].inlet && !comps(s)[1].inlet && s.surge2.inlet && inletOk(sim), 'XV-202A commanded open only');
      assert.ok(s.surge.comps[0].inlet, 'XV-201A still open until XV-202A reaches its open limit');
      run(sim, 10, 1);
      s = st(sim);
      assert.ok(!s.surge.comps[0].inlet && !s.surge.comps[1].inlet && s.surge2.route === 'surge2', 'XV-201A closed at the open limit: ' + s.surge2.route);
      run(sim, 600, 10);
      s = st(sim);
      assert.ok(comps(s)[0].frac > 0.05 && comps(s)[1].frac === 0 && comps(s)[0].fill_bpd > 0, 'A fills, B empty');
    },
  },
  {
    name: 'WTSS2C (c) compartment auto-divert at 80 %: A → B, LCV-202 suction → A and LCV-202 opens; the divert event has kind comp and numeric from / to',
    wp: WP, opts: false, timeoutMs: 120000,
    run(app, assert) {
      const sim = dual(), ev = [];
      sim.on('divert', (p) => ev.push(J(p)));
      sim.setSurgeRoute('surge2');
      assert.ok(run(sim, 3 * 3600, 10, (s) => ev.length > 0), 'a divert happened');
      const e = ev[0], s = st(sim);
      assert.ok(e.eq === 'surge2' && e.kind === 'comp' && e.from === 0 && e.to === 1 && e.auto === true, JSON.stringify(e));
      assert.ok(/T-202 auto-divert: T-202A at 80% → inlet to T-202B \(XV-202B open, XV-202A closed\) · LCV-202 suction → T-202A/.test(e.msg), e.msg);
      assert.ok(s.surge2.suction === 'A' && comps(s)[1].inlet && inletOk(sim), 'B fills, A on the suction');
      run(sim, 120, 10);
      assert.ok(st(sim).surge2.transfer.on, 'LCV-202 transfers from A (A ≥ LSH)');
      assert.deepStrictEqual(J(sim.getControls().surge2.comp.fill), [false, true], 'fill line-up follows the divert');
    },
  },
  {
    name: 'WTSS2C (c) LAH_SURGE2_BOTH: B at 80 % with A above its room level → no divert, alarm; auto-divert off → the uncontrolled-compartment text (A high)',
    wp: WP, opts: false, timeoutMs: 300000,
    run(app, assert) {
      const sim = dual({ config: { noise: { on: false } } });
      sim.setFault('xfer2StuckClosed', true);           // nothing leaves T-202: both compartments fill
      sim.setSurgeRoute('surge2');
      assert.ok(run(sim, 6 * 3600, 10, (s) => active(s, 'LAH_SURGE2_BOTH')), 'LAH_SURGE2_BOTH raised');
      const a = st(sim).alarms.find((x) => x.id === 'LAH_SURGE2_BOTH');
      assert.ok(a.tag === 'LAH-202' && /LAH-202 both T-202 compartments high/.test(a.msg) && /route the dumps to T-201/.test(a.msg), a.msg);
      // auto-divert off with the inlet compartment off the suction
      const o = dual({ config: { noise: { on: false } } });
      o.setAutoDivert('surge2', false, { divert: true });
      assert.strictEqual(o.getControls().surge2.comp.auto, false);
      o.setSurgeRoute('surge2');                         // A fills, the suction stays on B
      assert.ok(run(o, 3 * 3600, 10, (s) => active(s, 'LAH_SURGE2_BOTH')), 'uncontrolled A raised');
      assert.ok(/LAH-202 T-202A high .* not on the LCV-202 suction and auto-divert off/.test(st(o).alarms.find((x) => x.id === 'LAH_SURGE2_BOTH').msg), 'A-high text');
    },
  },
  {
    name: 'WTSS2C (c) LCV-202 low-low on the suction: auto-divert on → the suction auto-switches (event eq surge2); off → XFER2_DRYRUN latches with the side tag',
    wp: WP, opts: false, timeoutMs: 300000,
    run(app, assert) {
      // LSLL above LSL so an open LCV-202 reaches it before level control shuts it: the suction moves to the other compartment (above LSL)
      const sim = dual({ config: { noise: { on: false }, surge2: { lsll: 0.45, lsl: 0.30, lineup: { initFrac: [0.6, 0.75] } } } });
      sim.reset('steady');
      const sev = [];
      sim.on('suction', (p) => sev.push(J(p)));
      sim.setSurgeRoute('surge2');
      assert.ok(run(sim, 2 * 3600, 5, () => sev.length > 0), 'suction auto-switch');
      assert.ok(sev[0].eq === 'surge2' && /LCV-202 suction auto-switched T-202B .* → T-202A/.test(sev[0].msg), sev[0].msg);
      const o = dual({ config: { noise: { on: false }, surge2: { lsll: 0.45, lsl: 0.30, lineup: { initFrac: [0.6, 0.75] } } } });
      o.reset('steady');
      o.setAutoDivert('surge2', false, { divert: true });
      o.setSurgeRoute('surge2');
      assert.ok(run(o, 2 * 3600, 5, (s) => active(s, 'XFER2_DRYRUN')), 'XFER2_DRYRUN');
      const s = st(o);
      assert.ok(/suction T-202B level/.test(s.alarms.find((x) => x.id === 'XFER2_DRYRUN').msg), 'side tag in the trip text');
      assert.ok(s.surge2.transfer.tripped && s.surge2.transfer.canReset, 'latched; resettable above LSL');
      o.setConfig({ surge2: { lsl: 0.6 } });               // the suction now below LSL: the reset permissive names the side
      assert.ok(/^T-202B \d+% ≤ LSL 60%/.test(st(o).surge2.transfer.resetBlock), 'reset block text: ' + st(o).surge2.transfer.resetBlock);
    },
  },
  {
    name: 'WTSS2C (c) LSHH-202 closes only the high compartment\'s inlet; both closed on route T-202 → SURGE_BLOCKED → LSHH-102 ESD; PSHH-202 closes both',
    wp: WP, opts: false, timeoutMs: 300000,
    run(app, assert) {
      const sim = dual({ config: { noise: { on: false } } });
      sim.setFault('xfer2StuckClosed', true); sim.setAutoDivert('surge2', false, { divert: true }); sim.setSuction('A', 'surge2');
      sim.setSurgeRoute('surge2');
      sim.setValve('surge2', 1, true);                   // both compartments fill
      assert.ok(run(sim, 6 * 3600, 10, (s) => logged(s, 'LSHH_SURGE2')), 'LSHH-202');
      let s = st(sim);
      const hiK = comps(s)[0].frac >= comps(s)[1].frac ? 0 : 1;
      assert.ok(!comps(s)[hiK].inlet && inletOk(sim), 'high compartment closed');
      assert.strictEqual(sim.setValve('surge2', hiK, true), false, 'open refused at LSHH-202 per compartment');
      assert.ok(/XV-202[AB] open refused — T-202[AB] at LSHH-202/.test(st(sim).alarmLog.map((e) => e.msg).join('\n')), 'refusal logged');
      assert.ok(run(sim, 6 * 3600, 10, (x) => x.esd.tripped), 'ESD in the end');
      s = st(sim);
      assert.ok(logged(s, 'SURGE_BLOCKED') && /XV-202A \/ XV-202B closed/.test(s.alarmLog.filter((e) => e.id === 'SURGE_BLOCKED')[0].msg), 'SURGE_BLOCKED text');
      assert.strictEqual(s.esd.cause, 'LSHH_SEP', 'LSHH-102');
      const p = dual({ config: { noise: { on: false } } });
      p.setSurgeRoute('surge2'); p.setValve('surge2', 1, true); p.setFault('bpv2StuckClosed', true);
      assert.ok(run(p, 3600, 2, (x) => x.esd.tripped), 'PSHH-202 ESD');
      s = st(p);
      assert.ok(s.esd.cause === 'PSHH_SURGE2' && !comps(s)[0].inlet && !comps(s)[1].inlet && inletOk(p), 'both closed');
    },
  },
  {
    name: 'WTSS2C (c) make-before-break: hand-close XV-202A while B opens is held; route T-201 closes both XV-202 at the T-201 open limit; the next route reopens the last line-up; stroke 0',
    wp: WP, opts: false,
    run(app, assert) {
      const sim = dual();
      sim.setSurgeRoute('surge2'); run(sim, 10, 1);
      sim.setValve('surge2', 1, true); sim.setValve('surge2', 0, false);
      let s = st(sim);
      assert.ok(comps(s)[0].hold && comps(s)[0].pos === 1 && !comps(s)[0].inlet, 'XV-202A held open while XV-202B opens');
      run(sim, 14, 1); s = st(sim);
      assert.ok(!comps(s)[0].hold && comps(s)[0].pos === 0 && comps(s)[1].pos === 1, 'A closed after B reached its open limit');
      assert.ok(sim.setSurgeRoute('surge').ok); s = st(sim);
      assert.ok(comps(s)[1].inlet, 'XV-202B still open until a T-201 inlet reaches its open limit');
      run(sim, 10, 1); s = st(sim);
      assert.ok(!comps(s)[0].inlet && !comps(s)[1].inlet && s.surge2.route === 'surge' && inletOk(sim), 'back to T-201');
      assert.deepStrictEqual(s.surge2.fill, [false, true], 'fill line-up remembered (B)');
      sim.setSurgeRoute('surge2'); s = st(sim);
      assert.ok(!comps(s)[0].inlet && comps(s)[1].inlet, 'the route reopens B');
      // stroke 0: everything snaps, no lasting hold
      const z = dual({ config: { surge2: { xvStrokeS: 0 }, surge: { xvStrokeS: 0 } } });
      z.setSurgeRoute('surge2'); z.setValve('surge2', 1, true); z.setValve('surge2', 0, false); s = st(z);
      assert.ok(!comps(s)[0].hold && comps(s)[0].pos === 0 && comps(s)[1].pos === 1 && s.surge2.route === 'surge2', 'stroke 0');
      // fill compartment at LSHH-202: the route opens the other side
      const h = dual({ config: { noise: { on: false }, surge2: { lineup: { initFrac: [0.93, 0] } } } });
      h.reset('steady');
      const r = h.setSurgeRoute('surge2'); s = st(h);
      assert.ok(r.ok && !comps(s)[0].inlet && comps(s)[1].inlet, 'fill at LSHH-202 → other side: ' + r.msg);
    },
  },
  {
    name: 'WTSS2C (c) auto route T-201 → T-202 opens the roomy side; T-202 → T-201 only when every open T-202 compartment is at the route SP after its own divert had no room',
    wp: WP, opts: false, timeoutMs: 300000,
    run(app, assert) {
      const sim = dual({ config: { noise: { on: false } } }), ev = [];
      sim.on('divert', (p) => ev.push(J(p)));
      sim.setFault('xferStuckClosed', true); sim.setFault('xfer2StuckClosed', true);
      sim.setAutoDivert('surge2', true, { sp: 0.7 });
      assert.ok(run(sim, 6 * 3600, 10, () => ev.some((e) => e.eq === 'surge2' && e.to === 'surge2')), 'auto route to T-202');
      let s = st(sim);
      assert.ok(comps(s)[0].inlet || comps(s)[1].inlet, 'a T-202 side opened');
      const iRoute = ev.findIndex((e) => e.eq === 'surge2' && e.to === 'surge2');
      run(sim, 6 * 3600, 10, () => ev.slice(iRoute + 1).some((e) => e.eq === 'surge2' && typeof e.to === 'string'));
      const later = ev.slice(iRoute + 1), iComp = later.findIndex((e) => e.kind === 'comp' && e.eq === 'surge2'), iBack = later.findIndex((e) => e.eq === 'surge2' && typeof e.to === 'string');
      assert.ok(iComp >= 0, 'T-202 compartment divert first');
      if (iBack >= 0) assert.ok(iComp < iBack, 'divert before the route back');
    },
  },
  {
    name: 'WTSS2C (c) API: setSuction(both, surge2), setAutoDivert divert clamps, old prefs {surge2:{inlet:true}} open the fill line-up, getControls round trip; inlet derived after every call',
    wp: WP, opts: false,
    run(app, assert) {
      const sim = dual();
      assert.strictEqual(sim.setSuction('both', 'surge2'), true); assert.ok(inletOk(sim));
      assert.strictEqual(st(sim).surge2.suction, 'both');
      assert.strictEqual(sim.setSuction('both', 'surge2'), false, 'no change');
      assert.strictEqual(sim.setAutoDivert('surge2', true, { divert: true, sp: 0.99, hyst: 0.001 }), true);
      const cp = sim.getControls().surge2.comp;
      assert.ok(Math.abs(cp.sp - 0.88) < 1e-12 && cp.hyst === 0.02, 'clamped ' + JSON.stringify(cp));
      assert.strictEqual(sim.getControls().surge2.auto, false, 'the auto route is unchanged');
      assert.ok(inletOk(sim));
      const c = J(sim.getControls());
      const b = dual();
      b.setControls(c, { initial: true });
      assert.deepStrictEqual(J(b.getControls()), c, 'round trip');
      const o = dual();
      o.setControls({ surge2: { inlet: true } }, { initial: true });
      assert.ok(o.getControls().surge2.comp.inlet[0] === true && o.getControls().surge2.comp.inlet[1] === false && inletOk(o), 'old prefs open the fill line-up');
      const p = dual();
      p.setControls({ surge2: { inlet: true } });
      assert.ok(p.getControls().surge2.comp.inlet[0] && inletOk(p), 'later: route-style open');
      p.setControls({ surge2: { inlet: false } });
      assert.ok(!p.getControls().surge2.comp.inlet[0] && !p.getControls().surge2.comp.inlet[1] && inletOk(p), 'later: close all');
      // single mode refuses the dual-only calls
      const one = work().create(work().SAMPLE_FLOW, { seed: 1, rigup: { surge2: true }, config: { surge2: { compartments: 1 } } });
      assert.strictEqual(one.setSuction('B', 'surge2'), false); assert.strictEqual(one.setAutoDivert('surge2', true, { divert: true }), false);
    },
  },
  {
    name: 'WTSS2C (c) balances < 1e-9 over 4 h with routes and diverts; snapshot null rule; comps fixed length 2 in both modes; history keys',
    wp: WP, opts: false, timeoutMs: 300000,
    run(app, assert) {
      const S = work(), sim = dual({ seed: 9 });
      sim.setSurgeRoute('surge2');
      run(sim, 3600, 10); sim.setSurgeRoute('both'); run(sim, 3600, 10); sim.setSurgeRoute('surge'); run(sim, 1800, 10); sim.setSurgeRoute('surge2'); run(sim, 5400, 10);
      const s = st(sim), m = s.health.massErr;
      assert.ok(Math.abs(m.oil) < 1e-9 && Math.abs(m.water) < 1e-9 && Math.abs(m.gas) < 1e-9, 'balances ' + JSON.stringify(m));
      const bad = finiteBad(s, J(S.NULLABLE));
      assert.ok(bad.length === 0, 'finite: ' + bad.slice(0, 6).join(', '));
      assert.ok(X.checkShape('surge2', s.surge2, { strict: true, engine: 'work' }).ok, X.checkShape('surge2', s.surge2, { strict: true, engine: 'work' }).errors.join('; '));
      const one = S.create(S.SAMPLE_FLOW, { seed: 1, rigup: { surge2: true }, config: { surge2: { compartments: 1 } } });
      one.setSurgeRoute('both'); run(one, 600, 10);
      const s1 = st(one);
      assert.ok(s1.surge2.comps.length === 2 && s1.surge2.compartments === 1 && s1.surge2.comps[0].tag === 'T-202' && s1.surge2.comps[1].cap_bbl === 0, 'single comps');
      assert.ok(Math.abs(s1.surge2.comps[0].frac - s1.surge2.frac) < 1e-12, 'single comps[0] = the whole tank');
      const out = S.create(S.SAMPLE_FLOW, { seed: 1 });
      assert.ok(st(out).surge2.comps.length === 2 && finiteBad(st(out), J(S.NULLABLE)).length === 0, 'out: static, finite');
      ['surge2FracA', 'surge2FracB'].forEach((k) => { const h = sim.getHistory(k); assert.ok(h.y.length > 0 && h.y.every(isFinite) && h.y.some((y) => y > 0), 'history ' + k); });
    },
  },
  {
    name: 'WTSS2C (d) 4.1 review: checkShape requires the 4.1 keys of a working-engine snapshot (engine work; a partly missing set always fails) and excuses them only for an old object (all missing, or legacy)',
    wp: WP, opts: false,
    run(app, assert) {
      const FU = require('./_wts-fu-shapes');
      const S = work(), sim = S.create(S.SAMPLE_FLOW, { seed: 3, rigup: { surge2: true }, config: { noise: { on: false } } });
      run(sim, 60, 10);
      const s = st(sim);
      assert.ok(X.checkShape('surge2', s.surge2, { strict: true, engine: 'work' }).ok && X.checkShape('rigup', s.rigup, { strict: true, engine: 'work', rigKeys: FU.RIG_KEYS }).ok, 'complete snapshot');
      // one key dropped (a regression of the 4.1 snapshot): fails with and without engine 'work'
      const one = J(s.surge2); delete one.comps;
      assert.ok(!X.checkShape('surge2', one, { strict: true, engine: 'work' }).ok && !X.checkShape('surge2', one, { strict: true }).ok && !X.checkShape('surge2', one).ok, 'surge2.comps missing');
      const r1 = J(s.rigup); delete r1.routes;
      assert.ok(!X.checkShape('rigup', r1, { strict: true, rigKeys: FU.RIG_KEYS }).ok, 'rigup.routes missing');
      // every 4.1 key dropped (the review's reproduction): an old-looking object — fails for the working engine, passes as legacy
      const all = J(s.surge2);
      ['comps', 'compartments', 'suction', 'divert', 'fill', 'wellStream'].forEach((k) => delete all[k]); delete all.transfer.suction; delete all.transfer.T;
      assert.ok(!X.checkShape('surge2', all, { strict: true, engine: 'work' }).ok, 'working engine: all 4.1 keys required');
      assert.ok(X.checkShape('surge2', all, { strict: true, legacy: true }).ok && X.checkShape('surge2', all, { strict: true }).ok, 'an old object passes');
      const ra = J(s.rigup); delete ra.routing; delete ra.routes; delete ra.dest;
      assert.ok(!X.checkShape('rigup', ra, { strict: true, engine: 'work', rigKeys: FU.RIG_KEYS }).ok && X.checkShape('rigup', ra, { strict: true, legacy: true, rigKeys: FU.RIG_KEYS }).ok, 'rigup all three');
      // _wts-fu-shapes: sepBy.recv / gasCap_mmscfd, cushion.out.surge
      const sb = J(s.sepBy); delete sb.recv;
      assert.ok(FU.checkShape('sepBy', s.sepBy, { strict: true, engine: 'work' }).ok && !FU.checkShape('sepBy', sb, { strict: true }).ok, 'sepBy.recv missing');
      delete sb.gasCap_mmscfd;
      assert.ok(!FU.checkShape('sepBy', sb, { strict: true }).ok, 'sepBy: round-2 gasCap1 / gasCap2 still there (partly missing)');
      delete sb.gasCap1_mmscfd; delete sb.gasCap2_mmscfd;   // 4.1 round 2 keys
      assert.ok(!FU.checkShape('sepBy', sb, { strict: true, engine: 'work' }).ok && FU.checkShape('sepBy', sb, { strict: true }).ok && FU.checkShape('sepBy', sb, { legacy: true }).ok, 'sepBy old / working');
      // a frozen v3.4.1 snapshot still passes (no 4.1 key at all)
      const F = frozen(), fs = J(F.create(F.SAMPLE_FLOW, { seed: 3, rigup: { surge2: true } }).getState());
      assert.ok(X.checkShape('surge2', fs.surge2, { strict: true }).ok && X.checkShape('rigup', fs.rigup, { strict: true, rigKeys: FU.RIG_KEYS }).ok, 'v3.4.1 snapshot');
    },
  },
];
