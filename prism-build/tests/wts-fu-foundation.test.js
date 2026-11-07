// Well Test Simulator follow-up — WP-E0 foundation (docs/SIM-FOLLOWUP-PLAN.md §3, §5.1-5.2, §6.1, §7, §8.3 first bullet).
// The working engine (31) and the live controller (38) against the frozen contract tests/_wts-fu-shapes.js:
//   • rig-up: the CK-102 item, its rules and notes, the 11-character signature, step numbers, strict-true;
//   • the destination rule (V-101 + FS-401 out only to a production line) on every path that changes the destination
//     (setConfig, setFlow), with the line / vent sinks in the mass balance;
//   • the steady-case selection (pickSteadyBlock): base / ck2 / sepBy / sepBy+ck2 / skipped, from flow blocks built on the
//     fixture examples (the host publishes none before WP-C);
//   • registries, DEFAULTS, features, snapshot blocks with static values, history keys, the cushion API stubs;
//   • 38: constants, liveNodes (11), inputsDiff entries, the cushion prefs block, the display-only host hook.
// Expected values: the fixture (plan constants), the engine's own steady inputs, or the v1.4.0 behaviour (identity).
'use strict';

const X = require('./_wts-fu-shapes');
const EQ = require('./_wts-equip-shapes');

const WP = 'WTSFU';
const J = (x) => JSON.parse(JSON.stringify(x));
const NOISE_OFF = { noise: { on: false } };
function fill(t, P) { return t.replace('{P}', String(P)); }
function balanced(assert, st, where) {
  const m = st.health.massErr;
  assert.ok(Math.abs(m.oil) < 1e-9 && Math.abs(m.water) < 1e-9 && Math.abs(m.gas) < 1e-9, where + ': mass balance ' + JSON.stringify(m));
}
// SAMPLE_FLOW with the fixture's flow blocks (illustrative values, consistent with the prototype at the defaults)
function blockFlow(S, o) {
  const f = J(S.SAMPLE_FLOW);
  if (o.ck2) f.ck2 = X.EXAMPLES.flowCk2;
  if (o.skipped) f.ck2 = X.EXAMPLES.flowCk2Skipped;
  if (o.sepBy) { f.sepBy = X.EXAMPLES.flowSepBy; if (o.sepByCk2) f.sepBy.ck2 = X.EXAMPLES.flowCk2; }
  if (o.dest) f.sim.sepByDest = o.dest;
  if (typeof o.P === 'number') f.sim.sepByP_psig = o.P;
  return f;
}

module.exports = [
  {
    name: 'WTSFU E0 rig-up model: CK-102 item (optional, out by default, needs H-101), 11-character signature, notes, step numbers, strict true, RIG_TXT',
    wp: WP,
    opts: false,
    run(app, assert) {
      const S = X.loadEngine('work');
      assert.strictEqual(S.VERSION, X.VERSION_NEW);
      assert.deepStrictEqual(J(S.RIG_KEYS), X.RIG_KEYS);
      assert.deepStrictEqual(J(S.RIGUP.map((it) => it.key)), X.RIG_ORDER, 'display order = process order');
      assert.deepStrictEqual(J(S.RIGUP.find((it) => it.key === 'heaterChoke')), X.RIG_ITEM_NEW, 'RIG_ITEMS row');
      assert.deepStrictEqual(J(S.RIG_DEFAULTS), X.RIG_DEFAULTS); assert.deepStrictEqual(J(S.RIG_OPTIONAL), X.RIG_OPTIONAL);
      const d = S.normRigup({});
      assert.ok(d.sig === X.SIG_DEFAULT && d.full && d.notes.length === 0 && d.extras.length === 0, 'default ' + d.sig);
      ['yes', 1, 'true', {}, null].forEach((v) => assert.strictEqual(S.normRigup({ heaterChoke: v }).sig, X.SIG_DEFAULT, 'strict true: ' + JSON.stringify(v)));
      const k = S.normRigup({ heaterChoke: true });
      assert.ok(k.sig === '11111111001' && k.full && J(k.extras).join() === 'heaterChoke', 'CK-102 in: ' + k.sig);
      const kh = S.normRigup({ heaterChoke: true, heater: false });
      assert.ok(kh.rig.heaterChoke === false && kh.notes.indexOf(X.RIG_NOTES.heaterChokeNeedsHeater) >= 0, 'needs H-101: ' + kh.notes.join(' | '));
      // V-101 and FS-401 out: forced back in for the burner line (the v1.4.0 rule and note), allowed for a production line
      const f0 = S.normRigup({ separator: false, flare: false }), f1 = S.normRigup({ separator: false, flare: false }, { sepByDest: 'flare', P: 300 });
      assert.ok(f0.rig.flare && f0.notes.indexOf(X.RIG_NOTES.forcedFlare) >= 0 && JSON.stringify(f0) === JSON.stringify(f1), 'dest flare = no option');
      const l = S.normRigup({ separator: false, flare: false }, { sepByDest: 'line', P: 300 });
      assert.ok(l.rig.flare === false && l.rig.separator === false && l.notes.indexOf(fill(X.RIG_NOTES.sepFlareOutLine, 300)) >= 0, 'line: ' + l.notes.join(' | '));
      assert.ok(!l.notes.some((n) => /No flare: separator gas goes to the export/.test(n)), 'the no-flare note is replaced by the line note');
      const l2 = S.normRigup({ separator: false }, { sepByDest: 'line', P: 150 });
      assert.ok(l2.rig.flare && l2.notes.some((n) => /production line at 150 psig through NRV-501 \/ XV-501/.test(n)), 'V-101 note by destination');
      // step numbers (§3.5)
      X.STEP_COMBOS.forEach((c) => assert.deepStrictEqual(J(S.stepFor(c.rig)), c.step, 'stepFor ' + c.name));
      assert.deepStrictEqual(J(S.stepFor({ heaterChoke: 'yes' })), X.STEP_V331, 'stepFor strict true');
      // instance: getRigup 11 keys; entering / leaving texts; H-101 out takes CK-102 out (request kept)
      const sim = S.create(S.SAMPLE_FLOW, { seed: 2, config: NOISE_OFF });
      assert.strictEqual(JSON.stringify(sim.getRigup()), X.GETRIGUP_DEFAULT_JSON);
      assert.ok(EQ.checkShape('rigup', J(sim.getState().rigup), { strict: true, rigKeys: X.RIG_KEYS }).ok, 'rigup shape');
      const msgs = []; sim.on('rigup', (p) => msgs.push(p.msg));
      assert.strictEqual(sim.setRigup({ heaterChoke: true }), true);
      assert.ok(msgs[0].indexOf('CK-102 ' + X.RIG_TXT_NEW.heaterChoke[2]) >= 0, msgs[0]);
      assert.strictEqual(sim.getState().rigup.sig, '11111111001');
      assert.strictEqual(sim.setRigup({ heater: false }), true);
      let st = sim.getState();
      assert.ok(st.rigup.heaterChoke === false && sim.getRigup().heaterChoke === true && st.nodes.heaterChoke.inRig === false, 'H-101 out: CK-102 out, request kept');
      assert.ok(msgs[1].indexOf('CK-102 ' + X.RIG_TXT_NEW.heaterChoke[1]) >= 0, msgs[1]);
      assert.strictEqual(sim.setRigup({ heater: true, heaterChoke: null }), true);
      assert.strictEqual(JSON.stringify(sim.getRigup()), X.GETRIGUP_DEFAULT_JSON, 'null → default');
      st = sim.getState(); assert.ok(st.rigup.sig === X.SIG_DEFAULT && st.rigup.full, 'back to the default');
    },
  },
  {
    name: 'WTSFU E0 contract: TAGS / NAMES / NULLABLE / HIST_KEYS / NODE_IDS / DEFAULTS / features / SAMPLE_FLOW.sim; static snapshot blocks match the fixture shapes; cushion API stubs',
    wp: WP,
    opts: false,
    run(app, assert) {
      const S = X.loadEngine('work');
      Object.keys(X.TAGS_NEW).forEach((k) => assert.strictEqual(S.TAGS[k], X.TAGS_NEW[k], 'TAGS.' + k));
      Object.keys(X.NAMES_NEW).forEach((k) => assert.strictEqual(S.NAMES[k], X.NAMES_NEW[k], 'NAMES.' + k));
      X.NULLABLE_NEW.forEach((p) => assert.ok(S.NULLABLE.indexOf(p) >= 0, 'NULLABLE ' + p));
      assert.deepStrictEqual(J(S.HIST_KEYS), X.HIST_KEYS, 'HIST_KEYS (+2)');
      assert.deepStrictEqual(J(S.NODE_IDS), X.NODE_IDS, 'NODE_IDS (heaterChoke = 10)');
      assert.deepStrictEqual(J(S.DEFAULTS.heaterChoke), X.DEFAULTS_NEW.heaterChoke);
      assert.deepStrictEqual(J(S.DEFAULTS.sep.bypass), X.DEFAULTS_NEW.sepBypass);
      assert.deepStrictEqual(J(S.DEFAULTS.cushion), X.DEFAULTS_NEW.cushion);
      assert.deepStrictEqual(J(S.features), X.FEATURES, 'features (D14)');
      X.API_STATIC_NEW.forEach((k) => assert.ok(k in S, 'WTS_sim.' + k));
      assert.deepStrictEqual(Object.keys(J(S.SAMPLE_FLOW.sim)).slice(5), X.SAMPLE_FLOW_SIM_KEYS, 'SAMPLE_FLOW.sim: the five, the seven, the two');
      assert.deepStrictEqual([S.SAMPLE_FLOW.sim.sepByDest, S.SAMPLE_FLOW.sim.sepByP_psig], [X.SAMPLE_FLOW_SIM_NEW.sepByDest, X.SAMPLE_FLOW_SIM_NEW.sepByP_psig]);
      assert.ok(!('ck2' in S.SAMPLE_FLOW) && !('sepBy' in S.SAMPLE_FLOW), 'SAMPLE_FLOW has no flow block (D3)');
      const sim = S.create(S.SAMPLE_FLOW, { seed: 4 });
      sim.advance(600);
      const st = J(sim.getState());
      assert.deepStrictEqual(Object.keys(st.nodes), X.NODE_IDS, 'node order');
      assert.strictEqual(st.segs.length, X.SEG_COUNT);
      [['nodes.heaterChoke', st.nodes.heaterChoke], ['sepBy', st.sepBy], ['cushion', st.cushion]].forEach(([n, v]) => {
        const r = X.checkShape(n, v, { strict: true }); assert.ok(r.ok, n + ': ' + r.errors.join('; '));
      });
      const nk = st.nodes.heaterChoke;
      assert.ok(!nk.inRig && !nk.active && !nk.bypassed && nk.P === st.nodes.choke.P && nk.Pin === st.nodes.choke.P && nk.T === st.nodes.choke.T &&
        nk.dTjt === 0 && nk.regime === '' && nk.limiter === '' && nk.bean === 0 && nk.pos === 'inlet' && nk.designP_psig === X.DESIGN_P_CK2, 'static CK-102 node');
      assert.ok(st.inputs.bean2 === null && st.inputs.ck2Pos === null, 'no block → null inputs');
      assert.deepStrictEqual(st.sepBy, X.EXAMPLES.sepBy, 'snap.sepBy default (burner line, V-101 in)');
      assert.deepStrictEqual(st.cushion, X.EXAMPLES.cushionOff, 'snap.cushion off');
      X.SNAP_CUM_NEW.forEach((k) => assert.strictEqual(st.cum[k], 0, 'cum.' + k));
      X.HIST_KEYS_NEW.forEach((k) => { const h = sim.getHistory(k); assert.ok(h.t.length > 0 && h.y.every((y) => isFinite(y)), 'history ' + k); });
      const pc = sim.getHistory('Pchoke').y, p2 = sim.getHistory('Pck2').y;
      assert.ok(p2.every((y, i) => y === pc[i]) && sim.getHistory('cushionLeft').y.every((y) => y === 0), 'Pck2 = CK-101 outlet while CK-102 is out; cushionLeft 0');
      X.API_INSTANCE_NEW.forEach((k) => assert.strictEqual(typeof sim[k], 'function', 'api ' + k));
      // WP-E2 replaced the E0 stubs (refused, 'not available yet'): the cushion engine is tested in wts-bypass-cushion
      assert.strictEqual(sim.stopCushion(), false, 'stopCushion with no cushion');
      const r = sim.startCushion({});
      assert.ok(r && r.ok === true && typeof r.msg === 'string' && typeof r.warn === 'string', 'startCushion: ' + JSON.stringify(r));
      assert.strictEqual(sim.stopCushion(), true);
      assert.deepStrictEqual(J(sim.getCushion()), X.EXAMPLES.cushionOff, 'getCushion copy');
      assert.ok(sim.getCushion() !== sim.getState().cushion, 'getCushion is a copy');
    },
  },
  {
    name: 'WTSFU E0 destination rule (D4, §3.3): line → flare re-forces FS-401 through setConfig and through setFlow; BYPASS_DEST logged; line / vent sinks balance',
    wp: WP,
    opts: false,
    run(app, assert) {
      const S = X.loadEngine('work');
      // setConfig path
      const sim = S.create(S.SAMPLE_FLOW, { seed: 30, config: NOISE_OFF, rigup: { separator: false, flare: false } }), ev = [];
      sim.on('rigup', (p) => ev.push(p));
      let st = sim.getState();
      assert.ok(st.rigup.flare === true && st.sepBy.active && !st.sepBy.vent, 'dest flare: FS-401 forced in');
      sim.setConfig({ sep: { bypass: { dest: 'line', P_psig: 300 } } });
      st = sim.getState();
      assert.ok(st.rigup.flare === false && st.sepBy.dest === 'line' && st.sepBy.P_psig === 300 && st.sepBy.vent === true && ev.length === 1, 'line: FS-401 out');
      assert.ok(st.rigup.notes.indexOf(fill(X.RIG_NOTES.sepFlareOutLine, 300)) >= 0, 'line note in the snapshot');
      assert.ok(st.alarmLog.some((e) => e.id === 'BYPASS_DEST' && /production line at 300 psig/.test(e.msg)), 'BYPASS_DEST logged');
      for (let i = 0; i < 60; i++) sim.advance(10);
      st = sim.getState();
      assert.ok(st.cum.toLine_gas_mscf > 0 && st.cum.toLine_oil_stb > 0 && st.cum.toLine_water_bbl > 0, 'line totals ' + JSON.stringify([st.cum.toLine_gas_mscf, st.cum.toLine_oil_stb]));
      balanced(assert, st, 'to the line, FS-401 out');
      const fl0 = st.cum.flare_mmscf;
      const nDest = (s) => s.getState().alarmLog.filter((e) => e.id === 'BYPASS_DEST').length, nd0 = nDest(sim);
      sim.setConfig({ sep: { bypass: { P_psig: 250 } } });
      assert.ok(ev.length === 1 && sim.getState().rigup.notes.indexOf(fill(X.RIG_NOTES.sepFlareOutLine, 250)) >= 0, 'P change: notes follow, no rigup event');
      // BYPASS_DEST rule (pinned): logged only when the destination itself changes ('flare' <-> 'line'), never on a line pressure
      assert.strictEqual(nDest(sim), nd0, 'P change: no BYPASS_DEST entry');
      sim.setConfig({ sep: { bypass: { dest: 'flare' } } });
      st = sim.getState();
      assert.ok(st.rigup.flare === true && ev.length === 2 && /FS-401 back in the rig-up/.test(ev[1].msg) && sim.getRigup().flare === false, 'line → flare re-forces FS-401: ' + (ev[1] && ev[1].msg));
      for (let i = 0; i < 30; i++) sim.advance(10);
      st = sim.getState();
      assert.ok(st.cum.flare_mmscf > fl0, 'burner line again');
      balanced(assert, st, 'back to the burner line');
      // setFlow path (the page: destination changed → calcWTS → setFlow)
      const s2 = S.create(S.SAMPLE_FLOW, { seed: 31, config: NOISE_OFF, rigup: { separator: false, flare: false } }), ev2 = [];
      s2.on('rigup', (p) => ev2.push(p));
      s2.setFlow(blockFlow(S, { dest: 'line' }));
      assert.ok(s2.getState().rigup.flare === false && ev2.length === 1, 'setFlow → line');
      s2.setFlow(blockFlow(S, { dest: 'line' }));
      assert.strictEqual(ev2.length, 1, 'same destination: no re-normalisation');
      s2.setFlow(blockFlow(S, { dest: 'flare' }));
      assert.ok(s2.getState().rigup.flare === true && ev2.length === 2, 'setFlow line → flare re-forces FS-401');
      // a flow without the new keys (old flow) keeps the configured destination
      const old = J(S.SAMPLE_FLOW); delete old.sim.sepByDest; delete old.sim.sepByP_psig;
      const s3 = S.create(old, { seed: 32, config: { sep: { bypass: { dest: 'line' } } }, rigup: { separator: false, flare: false } });
      assert.strictEqual(s3.getState().rigup.flare, false, 'setConfig destination with an old flow');
      // V-101 in: the destination changes nothing in the rig-up
      const s4 = S.create(S.SAMPLE_FLOW, { seed: 33 }), sig4 = s4.getState().rigup.sig;
      s4.setConfig({ sep: { bypass: { dest: 'line' } } });
      assert.ok(s4.getState().rigup.sig === sig4 && s4.getState().sepBy.active === false && s4.getState().sepBy.P0_psig === 150, 'V-101 in: rig-up unchanged');
      // typing the line pressure on the page (one setFlow per keystroke, dest 'line', V-101 in): one BYPASS_DEST at most
      const s5 = S.create(S.SAMPLE_FLOW, { seed: 34, config: NOISE_OFF });
      [1, 15, 150, 1500].forEach((P) => s5.setFlow(blockFlow(S, { dest: 'line', P: P })));
      const d5 = s5.getState().alarmLog.filter((e) => e.id === 'BYPASS_DEST');
      assert.ok(d5.length === 1 && /production line/.test(d5[0].msg), 'keystrokes: one BYPASS_DEST (' + d5.length + ')');
      [10, 20].forEach((P) => s5.setConfig({ sep: { bypass: { P_psig: P } } }));
      assert.strictEqual(s5.getState().alarmLog.filter((e) => e.id === 'BYPASS_DEST').length, 1, 'setConfig P only: no entry');
      s5.setConfig({ sep: { bypass: { dest: 'flare' } } });
      assert.strictEqual(s5.getState().alarmLog.filter((e) => e.id === 'BYPASS_DEST').length, 2, 'destination change: logged');
      // V-101 out on the legacy path (no flow.sepBy): the flare node shows the burner-line inlet pDown uses (P_flare_psig)
      const s6 = S.create(S.SAMPLE_FLOW, { seed: 35, config: Object.assign({}, NOISE_OFF, { sep: { pcv: { P2_psig: 20 } } }), rigup: { separator: false } });
      for (let i = 0; i < 30; i++) s6.advance(10);
      const n6 = s6.getState();
      assert.ok(n6.nodes.flare.P === S.DEFAULTS.sep.bypass.P_flare_psig && n6.nodes.flare.Pline === n6.nodes.flare.P && n6.sepBy.P0_psig === n6.nodes.flare.P,
        'legacy V-101 out: flare P ' + n6.nodes.flare.P + ' / Pline ' + n6.nodes.flare.Pline + ' = P0 ' + n6.sepBy.P0_psig);
    },
  },
  {
    name: 'WTSFU E0 steady-case selection (pickSteadyBlock, §5.2): base / ck2 / sepBy / sepBy+ck2 / skipped; a block never moves the default spread',
    wp: WP,
    opts: false,
    run(app, assert) {
      const S = X.loadEngine('work');
      const mk = (flow, rigup) => S.create(flow, { seed: 40, config: NOISE_OFF, rigup: rigup || {} });
      // CK-102 out: a flow carrying both blocks runs exactly as one without them (only inputs.bean2 / ck2Pos come from the block)
      const a = mk(S.SAMPLE_FLOW), b = mk(blockFlow(S, { ck2: true, sepBy: true }));
      for (let i = 0; i < 90; i++) { a.advance(10); b.advance(10); }
      const sa = J(a.getState()), sb = J(b.getState());
      assert.ok(sb.inputs.bean2 === 48 && sb.inputs.ck2Pos === 'inlet' && sb.nodes.heaterChoke.bean === 48, 'inputs from the block');
      sb.inputs.bean2 = null; sb.inputs.ck2Pos = null; sb.nodes.heaterChoke.bean = 0;
      assert.deepStrictEqual(sb, sa, 'blocks present, CK-102 out, V-101 in: the default spread');
      assert.strictEqual(b._internal().fu.sel, 'base');
      // CK-102 in with flow.ck2: the CK-101 outlet, heater and segs 3-4 come from the block (steady at t = 0, noise off)
      const ex = X.EXAMPLES.flowCk2;
      const c = mk(blockFlow(S, { ck2: true }), { heaterChoke: true }), ci = c._internal().fu, cs = c.getState();
      assert.ok(ci.sel === 'ck2' && ci.ck2Act === true && ci.Pck_ss === ex.ck1.Pout && ci.Ph_ss === ex.nodes.heater.P && ci.Phi_ss === ex.Pout, 'ck2 selection ' + JSON.stringify(ci));
      assert.ok(Math.abs(cs.nodes.choke.P - ex.ck1.Pout) < 0.05, 'choke outlet = CK-101 outlet of the block ' + cs.nodes.choke.P);
      assert.ok(Math.abs(cs.segs[2].dP - ex.segs[0].dP) < 1e-9, 'seg 3 from the block');
      assert.strictEqual(cs.nodes.heaterChoke.inRig, true);
      // heater bypassed: CK-102 not in line → base again, the node greyed (bypassed)
      const cf = blockFlow(S, { ck2: true }); cf.inputs.bypass = true;
      const cb = mk(cf, { heaterChoke: true });
      assert.ok(cb._internal().fu.sel === 'base' && cb.getState().nodes.heaterChoke.bypassed === true && cb.getState().nodes.heaterChoke.active === false, 'bypassed');
      // a skipped block (no gas rate) counts as none, with its note
      const ck = mk(blockFlow(S, { skipped: true }), { heaterChoke: true }), kst = ck.getState();
      assert.ok(ck._internal().fu.sel === 'base' && kst.nodes.heaterChoke.note === X.RIG_NOTES.ck2SkippedNote && ck._internal().fu.CK2.note === X.RIG_NOTES.ck2SkippedNote, 'skipped: ' + kst.nodes.heaterChoke.note);
      // CK-102 in, no block: in line with ΔP 0 and the note
      const cn = mk(S.SAMPLE_FLOW, { heaterChoke: true });
      assert.ok(cn._internal().fu.sel === 'base' && cn._internal().fu.CK2.note === X.RIG_NOTES.ck2NoBlock, 'no block note');
      // V-101 out with flow.sepBy: walk from the destination, P0 from the block
      const sx = X.EXAMPLES.flowSepBy, vf = blockFlow(S, { sepBy: true });
      sx.surgeP_psig = 12; vf.sepBy.surgeP_psig = 12;                      // differs from the flow's Surge Tank Pressure (25)
      const v = mk(vf, { separator: false }), vi = v._internal().fu, vs = v.getState();
      assert.ok(vi.sel === 'sepBy' && vi.P0 === sx.P0_psig && vi.bypP0 === sx.P0_psig && vi.bypDP === sx.segs[2].dP && vi.Psep_ss === sx.nodes.sep.P, 'sepBy selection ' + JSON.stringify(vi));
      const Pdn = sx.P0_psig + sx.segs[2].dP;                               // fg = 1 at t = 0 (steady)
      assert.ok(Math.abs(vs.nodes.choke.P - (Pdn + sx.nodes.choke.P - sx.nodes.sep.P)) < 0.05, 'choke outlet from the destination ' + vs.nodes.choke.P);
      assert.ok(vs.sepBy.active && vs.sepBy.P0_psig === sx.P0_psig && vs.sepBy.note === '', 'snap.sepBy with the block');
      assert.strictEqual(v._internal().cfg.surge.Psp, 25, 'cfg untouched'); assert.strictEqual(vs.surge.SP, sx.surgeP_psig, 'surge set point from the block (no Psep − 10 bound)');
      for (let i = 0; i < 60; i++) v.advance(10);
      balanced(assert, v.getState(), 'V-101 out with the block');
      // V-101 out without a block: the legacy law, with the note
      const w = mk(S.SAMPLE_FLOW, { separator: false });
      assert.ok(w._internal().fu.sel === 'base' && /no bypass-destination data/.test(w.getState().sepBy.note), 'legacy note');
      // both: sepBy + ck2
      const z = mk(blockFlow(S, { sepBy: true, sepByCk2: true }), { separator: false, heaterChoke: true });
      assert.ok(z._internal().fu.sel === 'sepBy+ck2' && z._internal().fu.Pck_ss === ex.ck1.Pout, 'sepBy+ck2');
      // a CK-102 rig toggle keeps the state finite and balanced. WP-E1: the lag holds the CK-102 ΔP (≈ 979 psi) and decays
      // with τ 5 s after CK-102 leaves, reaching exactly 0 (the 1e-9 psi snap) after about 28 τ
      c.advance(300); c.setRigup({ heaterChoke: false }); c.advance(200);
      const cz = c.getState();
      assert.ok(c._internal().fu.ck2dP === 0 && cz.nodes.heaterChoke.inRig === false, 'out again');
      balanced(assert, cz, 'CK-102 toggled');
    },
  },
  {
    name: 'WTSFU E0 38 foundation: constants, RIG_FALLBACK, liveNodes 11, inputsDiff (bean2 / position / destination / line pressure), cushion prefs block, display-only host hook',
    wp: WP,
    run(app, assert) {
      const L = app.win.WTS_live, I = L && L._internals, S = app.win.WTS_sim;
      assert.ok(I, 'WTS_live._internals');
      assert.ok(I.EQ_IDS.indexOf('heaterChoke') >= 0 && I.TAG.heaterChoke === 'CK-102' && I.NAME.heaterChoke === X.LABELS.rigItem && I.EQ_ABBR.heaterChoke === 'CK2', 'constants');
      assert.ok(I.HOST_NM[10] === 'Heater Choke' && I.NODE_KEYS[10] === 'heaterChoke' && I.INPUT_FOR.heaterChoke === 'wts_bean2', 'node 10, input');
      assert.deepStrictEqual(J(I.rigItems().map((it) => it.key)), X.RIG_ORDER, 'rig items in process order');
      const n = L.liveNodes(J(S.create(S.SAMPLE_FLOW, app.toWin({ seed: 1, rigup: { heaterChoke: true } })).getState()));
      assert.ok(n.length === 11 && n[10].nm === 'Heater Choke' && isFinite(n[10].P) && isFinite(n[10].Pin) && n[10].active === false, 'liveNodes 11');
      // inputsDiff: logged only when both flows carry the field
      const a = J(S.SAMPLE_FLOW), b = J(S.SAMPLE_FLOW);
      a.ck2 = X.EXAMPLES.flowCk2; b.ck2 = X.EXAMPLES.flowCk2; b.ck2.bean = 32; b.ck2.pos = 'midcoil'; b.sim.sepByDest = 'line'; b.sim.sepByP_psig = 300;
      const d = J(I.inputsDiff(app.toWin(a), app.toWin(b)));
      assert.deepStrictEqual(d.map((x) => x[1]), ['CK-102', 'CK-102', 'V-101', 'V-101'], 'tags: ' + JSON.stringify(d));
      assert.ok(/48→32/.test(d[0][0]) && /between the coil passes/.test(d[1][0]) && /production line/.test(d[2][0]) && /150→300/.test(d[3][0]), JSON.stringify(d));
      const old = J(S.SAMPLE_FLOW); delete old.sim.sepByDest; delete old.sim.sepByP_psig;
      assert.strictEqual(I.inputsDiff(app.toWin(old), app.toWin(b)).length, 0, 'an old flow logs nothing new');
      // cushion prefs: defaults, clamps, tubing ids, anything else → defaults
      const D = { V: 50, SG: 1.03, q: 1500, tbg: '3-1/2', depth: 10000 };
      assert.deepStrictEqual(J(I.cushionPrefs(null)), D);
      assert.deepStrictEqual(J(I.cushionPrefs(app.toWin({ V: 1e9, SG: 0.1, q: 'x', tbg: '9-5/8', depth: -5 }))), { V: 500, SG: 0.8, q: 1500, tbg: '3-1/2', depth: 500 }, 'clamped');
      assert.deepStrictEqual(J(I.cushionPrefs(app.toWin({ V: 150, tbg: '2-7/8', depth: 25000 }))), { V: 150, SG: 1.03, q: 1500, tbg: '2-7/8', depth: 25000 });
      assert.strictEqual(I.cushionCap('2-7/8'), X.CUSHION_TUBING[1].cap); assert.deepStrictEqual(J(I.CUSH_TBG.map((t) => t[0])), X.CUSHION_TUBING.map((t) => t.id));
      const ls = app.win.localStorage;
      ls.setItem(I.PREFS_KEY, JSON.stringify({ mode: '2d', cushion: { V: 80, SG: 9, tbg: '4-1/2' } }));
      const p = I.readPrefs();
      assert.ok(p.mode === '2d' && J(p.cushion).V === 80 && p.cushion.SG === 1.5 && p.cushion.tbg === '4-1/2', 'readPrefs cushion ' + JSON.stringify(p.cushion));
      p.cushion = app.toWin({ V: -1, depth: 'deep' }); I.writePrefs(p);
      assert.deepStrictEqual(JSON.parse(ls.getItem(I.PREFS_KEY)).cushion, { V: 1, SG: 1.03, q: 1500, tbg: '3-1/2', depth: 10000 }, 'writePrefs validates');
      // the display-only host hook: absent → nothing; present → called with the flow and a copy of the rig-up
      const keepL = app.win.WTS_lastCalc, keepF = app.win.wtsRenderResults;
      try {
        app.win.wtsRenderResults = undefined;
        assert.strictEqual(I.hostResults(app.toWin({ heaterChoke: true })), false, 'no host hook (before WP-C)');
        const calls = [], flow = app.toWin({ v: 1 });
        app.win.WTS_lastCalc = app.toWin({}); app.win.WTS_lastCalc.flow = flow;
        app.win.wtsRenderResults = function (f, r) { calls.push([f, r]); };
        const rig = app.toWin({ heaterChoke: true, separator: false });
        assert.strictEqual(I.hostResults(rig), true);
        assert.ok(calls.length === 1 && calls[0][0] === flow && calls[0][1] !== rig && calls[0][1].heaterChoke === true, 'called with the flow and a rig copy');
        app.win.wtsRenderResults = function () { throw new Error('host'); };
        assert.strictEqual(I.hostResults(rig), false, 'a throwing host hook is contained');
      } finally { app.win.WTS_lastCalc = keepL; app.win.wtsRenderResults = keepF; }
    },
  },
  {
    name: 'WTSFU E0 live rig-up: the CK-102 switch adds it (row rp-skip while out); the rigup handler calls wtsRenderResults, never calcWTS (flowSeq unchanged)',
    wp: WP,
    integration: true,
    run(app, assert) {
      const b = app.find('.nav-btn[data-p="wts"]'); if (!b) throw new Error('no Well Test Simulator sidebar button');
      app.click(b); app.flush(500);
      const live = app.win.WTS_live && app.win.WTS_live.getSim && app.win.WTS_live.getSim();
      assert.ok(live, 'live simulator');
      const card = app.el('wtsl_rigup'), sw = card && card.querySelector('[data-rig="heaterChoke"]');
      assert.ok(sw && sw.getAttribute('aria-checked') === 'false' && sw.closest('.rrow').classList.contains('rp-skip'), 'CK-102 switch present, off, row rp-skip');
      const calls = [], keep = app.win.wtsRenderResults, keepCalc = app.win.calcWTS;
      let calcs = 0;
      app.win.wtsRenderResults = function (f, r) { calls.push(r); };
      app.win.calcWTS = function () { calcs++; return keepCalc.apply(this, arguments); };
      try {
        const seq0 = live.getState().flowSeq;
        app.click(sw); app.flush(100);
        assert.strictEqual(live.getState().rigup.heaterChoke, true, 'sim has CK-102');
        assert.strictEqual(JSON.parse(app.win.localStorage.getItem('wts_sim_rigup') || '{}').heaterChoke, true, 'saved');
        assert.ok(calls.length >= 1 && calls[calls.length - 1].heaterChoke === true, 'wtsRenderResults called with the rig-up');
        assert.ok(calcs === 0 && live.getState().flowSeq === seq0, 'no calcWTS, no setFlow');
      } finally { app.win.wtsRenderResults = keep; app.win.calcWTS = keepCalc; }
      assert.strictEqual(app.consoleErrors().length, 0, 'no console errors: ' + app.consoleErrors().join(' | '));
    },
  },
];
