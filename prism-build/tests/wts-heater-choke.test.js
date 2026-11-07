// Well Test Simulator follow-up — CK-102 heater inlet choke (docs/SIM-FOLLOWUP-PLAN.md §5, §9.2 "tests/wts-heater-choke.test.js").
// Engine group (WP-E1): the working engine 31 with flow.ck2 blocks built from the contract fixture (tests/_wts-fu-shapes.js
// ANCHORS_CK2 / EXAMPLES.flowCk2) on WTS_sim.SAMPLE_FLOW (= the page defaults), so the engine is tested against the frozen
// block shape whatever the host walk (WP-C) publishes:
//   • steady values from the block: CK-101 outlet = Pm + seg-3 loss, the CK-102 node (inlet, outlet, J-T, hydrate), history Pck2;
//   • alarms CHOKE2_LIMIT (CHOKE_LIMIT suppressed), CK1_SUBCRIT only when the base was critical, PAH_CK2 on a live pinch (U7),
//     HYD_heaterChoke, texts by limiter and position, release by quiet(Q_CK2);
//   • the 5 s ΔP lag: heater bypass and rig in / out without a step (U3), derive-survival through a bean2 change and a Thtr
//     change during a transient (U2), the cumulative J-T cap (D10), determinism, dt 1 vs dt 10, old flows.
// The host group (WP-C: flow.ck2 = ANCHORS_CK2, warnings, calcWTS never reads wts_sim_rigup) is added by WP-C.
// Expected values: the fixture (anchors, texts, shapes), the plan's laws of §5.3 evaluated on the block, or the v1.4.0 law.
'use strict';

const X = require('./_wts-fu-shapes');

const WP = 'WTSHC';
const J = (x) => JSON.parse(JSON.stringify(x));
const NZ = { noise: { on: false } };
const A = {}; X.ANCHORS_CK2.forEach((a) => { A[a.id] = a; });

// ── flow.ck2 blocks from the anchors (the example block at 48/64 inlet; other numbers consistent with §4.3 at the defaults) ──
function block(id, edit) {
  const b = X.EXAMPLES.flowCk2, a = A[id] || {};
  if (id === 'bean32') {
    Object.assign(b, { bean: 32, regime: 'Critical', flowLimited: true, limiter: 'CK-102', QmaxMMscfd: a.QmaxPair, Pin: a.Pm, dP: a.Pm - b.Pout,
      Tin: 170.4, dTjt: 101.7 });
    Object.assign(b.ck1, { regime: 'Subcritical', Pout: a.Pm + 0.25, ratio: a.ratio, QmaxMMscfd: a.QmaxPair, Tout: 170.4, dTjt: 9.6 });
    b.nodes.choke = { P: a.Pm + 0.25, T: 170.4 }; b.nodes.heaterChoke.Pin = a.Pm; b.nodes.heaterChoke.Tin = 170.4;
  } else if (id === 'bean40') {
    Object.assign(b, { bean: 40, regime: 'Critical', flowLimited: false, limiter: 'CK-102', QmaxMMscfd: a.QmaxPair, Pin: a.Pm, dP: a.Pm - b.Pout, Tin: a.Tco2 });
    Object.assign(b.ck1, { regime: 'Subcritical', Pout: a.Pm + 0.25, ratio: a.ratio, QmaxMMscfd: a.QmaxPair, Tout: a.Tco2 });
  } else if (id === 'bean4' || id === 'bean24') {
    Object.assign(b, { bean: id === 'bean4' ? 4 : 24, regime: 'No Flow', noFlow: true, flowLimited: true, limiter: 'CK-102', QmaxMMscfd: a.QmaxPair, Pin: 2998.76, dP: 2842.75 });
    Object.assign(b.ck1, { regime: 'Subcritical', Pout: 2998.76, ratio: 0.9998, QmaxMMscfd: a.QmaxPair });
  } else if (id === 'bean48mid') {
    Object.assign(b, { pos: 'midcoil', Tin: a.TmIn, Tout: a.TmOut });
  }
  if (edit) edit(b);
  return b;
}
function flowWith(S, blk, edit) { const f = J(S.SAMPLE_FLOW); if (blk) f.ck2 = blk; if (edit) edit(f); return f; }
function mk(S, flow, o) {
  o = o || {};
  return S.create(flow, { seed: o.seed == null ? 21 : o.seed, config: o.cfg || NZ, rigup: o.rig === undefined ? { heaterChoke: true } : o.rig });
}
function adv(sim, secs, dt) { dt = dt || 1; const n = Math.round(secs / dt); for (let i = 0; i < n; i++) sim.advance(dt); }
function ids(st) { return st.alarms.map((a) => a.id); }
function alarm(st, id) { return st.alarms.filter((a) => a.id === id)[0] || null; }
function fu(sim) { return sim._internal().fu; }
// every number finite; null only on a NULLABLE path; never undefined
function finiteBad(o, nullable, p, bad) {
  p = p || ''; bad = bad || [];
  if (o === null) { if (nullable.indexOf(p.replace(/\[\d+\]/g, '[*]')) < 0) bad.push(p + '=null'); return bad; }
  if (o === undefined) { bad.push(p + '=undefined'); return bad; }
  if (typeof o === 'number') { if (!isFinite(o)) bad.push(p + '=' + o); return bad; }
  if (Array.isArray(o)) { o.forEach((v, i) => finiteBad(v, nullable, p + '[' + i + ']', bad)); return bad; }
  if (typeof o === 'object') Object.keys(o).forEach((k) => finiteBad(o[k], nullable, p ? p + '.' + k : k, bad));
  return bad;
}
// largest |Δ| of the CK-101 outlet over one 1 s step at dt 0.05 s (no jump inside the step)
function maxJump(sim, key) {
  let prev = sim.getState().nodes.choke[key || 'P'], m = 0;
  for (let i = 0; i < 20; i++) { sim.advance(0.05); const v = sim.getState().nodes.choke[key || 'P']; m = Math.max(m, Math.abs(v - prev)); prev = v; }
  return m;
}

module.exports = [
  {
    name: 'WTSHC E1 steady values from flow.ck2 (48/64 inlet): CK-101 outlet = Pm + seg-3 loss, CK-102 node = the block, J-T per stage, history Pck2, node shape',
    wp: WP,
    opts: false,
    run(app, assert) {
      const S = X.loadEngine('work'), b = block('bean48'), a = A.bean48;
      const sim = mk(S, flowWith(S, b));
      for (const when of ['t = 0', 'after 1 h']) {
        if (when !== 't = 0') adv(sim, 3600, 10);
        const st = J(sim.getState()), nk = st.nodes.heaterChoke, f = fu(sim);
        assert.ok(f.sel === 'ck2' && f.CK2.act === true && f.CK2.note === '', when + ': in line ' + JSON.stringify(f.CK2));
        assert.ok(nk.inRig && nk.active && !nk.bypassed && nk.note === '', when + ': node active');
        assert.near(nk.Pin, a.Pm, 0.005 * a.Pm, when + ': Pm (CK-102 inlet)');
        assert.near(nk.P, a.Pout, 1, when + ': CK-102 outlet');
        assert.near(st.nodes.choke.P, nk.Pin + st.segs[2].dP, 1e-6, when + ': CK-101 outlet = Pm + seg-3 loss');
        assert.near(st.nodes.choke.P, b.ck1.Pout, 0.005 * b.ck1.Pout, when + ': CK-101 outlet = ck1.Pout');
        assert.ok(nk.regime === 'Critical' && nk.limiter === 'CK-101' && nk.bean === 48 && nk.pos === 'inlet' && !nk.flowLimited, when + ': regime / limiter / bean');
        assert.near(nk.QmaxMMscfd, a.QmaxPair, 1e-9, when + ': pair capacity');
        assert.near(nk.dTjt, a.dT2, 0.2, when + ': CK-102 J-T stage');
        assert.near(st.nodes.choke.dTjt, a.dT1, 0.2, when + ': CK-101 J-T stage');
        assert.near(nk.Tin, a.TmIn, 0.05, when + ': CK-102 inlet T (= T3)'); assert.near(nk.T, a.TmOut, 0.2, when + ': CK-102 outlet T');
        assert.near(st.nodes.heater.Tin, a.TmOut, 0.05, when + ': H-101 inlet = CK-102 outlet');
        assert.ok(nk.hyd === false && nk.th > 0 && nk.th < nk.T, when + ': hydrate margin ' + nk.th);
        assert.ok(nk.designP_psig === X.DESIGN_P_CK2 && st.inputs.bean2 === 48 && st.inputs.ck2Pos === 'inlet', when + ': inputs');
        const r = X.checkShape('nodes.heaterChoke', nk, { strict: true }); assert.ok(r.ok, when + ': ' + r.errors.join('; '));
        assert.deepStrictEqual(finiteBad(st, J(S.NULLABLE)), [], when + ': finite snapshot');
        assert.deepStrictEqual(J(ids(st).filter((id) => X.Q_CK2.indexOf(id) >= 0)), [], when + ': no CK-102 alarm at 48/64');
      }
      const h = sim.getHistory('Pck2'), hp = sim.getHistory('Pchoke'), n = h.y.length - 1;
      assert.near(h.y[n], A.bean48.Pm, 0.005 * A.bean48.Pm, 'history Pck2 = Pm');
      assert.near(hp.y[n] - h.y[n], sim.getState().segs[2].dP, 0.05, 'history Pchoke − Pck2 = seg-3 loss');
      const m = sim.getState().health.massErr;
      assert.ok(Math.abs(m.oil) < 1e-9 && Math.abs(m.water) < 1e-9 && Math.abs(m.gas) < 1e-9, 'mass balance ' + JSON.stringify(m));
    },
  },
  {
    name: 'WTSHC E1 midcoil: same pressures, CK-102 inlet at the pass-1 temperature (Tp1 ≤ Tho − 25), outlet T and hydrate from it; PAH text by position',
    wp: WP,
    opts: false,
    run(app, assert) {
      const S = X.loadEngine('work'), a = A.bean48mid;
      const si = mk(S, flowWith(S, block('bean48'))), sm = mk(S, flowWith(S, block('bean48mid')));
      adv(si, 600, 10); adv(sm, 600, 10);
      const ni = si.getState().nodes.heaterChoke, nm = sm.getState().nodes.heaterChoke;
      assert.ok(nm.pos === 'midcoil' && sm.getState().inputs.ck2Pos === 'midcoil', 'position');
      assert.near(nm.Pin, ni.Pin, 1e-9, 'same CK-102 inlet'); assert.near(nm.P, ni.P, 1e-9, 'same outlet');
      assert.near(sm.getState().nodes.choke.P, si.getState().nodes.choke.P, 1e-9, 'same CK-101 outlet');
      assert.near(nm.Tin, a.TmIn, 0.05, 'CK-102 inlet = Tp1'); assert.ok(nm.Tin <= 150 - a.Tp1MaxBelowTho + 1e-6, 'Tp1 ≤ Tho − 25');
      assert.near(nm.T, a.TmOut, 0.2, 'CK-102 outlet T (pass-1 heat, then its J-T)');
      assert.near(nm.dTjt, ni.dTjt, 1e-9, 'same J-T stage'); assert.ok(nm.T - ni.T > 15, 'outlet warmer by the pass-1 heat');
      assert.near(sm.getState().nodes.heater.dutyMMBtuHr, si.getState().nodes.heater.dutyMMBtuHr, 0.005 * si.getState().nodes.heater.dutyMMBtuHr, 'same duty');
      // PAH-102 texts by position at a high pressure between the chokes (a block with Pm above 90 % of the design pressure)
      for (const pos of ['inlet', 'midcoil']) {
        const s = mk(S, flowWith(S, block('bean40', (b) => { b.pos = pos; })));
        adv(s, 60, 1);
        const al = alarm(s.getState(), 'PAH_CK2');
        assert.ok(al && al.sev === 'warn' && al.tag === 'PAH-102' && al.eq === 'heaterChoke', pos + ': PAH-102 ' + JSON.stringify(al));
        assert.match(al.msg, X.textRe(X.ALARM_TEXTS['PAH_CK2_' + pos]), pos + ' text');
      }
    },
  },
  {
    name: 'WTSHC E1 alarms: CHOKE2_LIMIT (CHOKE_LIMIT suppressed) by limiter, CK1_SUBCRIT only when the base was critical, HYD_heaterChoke, released when CK-102 leaves',
    wp: WP,
    opts: false,
    run(app, assert) {
      const S = X.loadEngine('work');
      // 32/64: pair flow-limited by CK-102, CK-101 subcritical with a critical base walk
      const s = mk(S, flowWith(S, block('bean32')));
      adv(s, 120, 1);
      let st = s.getState(), c2 = alarm(st, 'CHOKE2_LIMIT'), sub = alarm(st, 'CK1_SUBCRIT');
      assert.ok(c2 && c2.sev === 'alarm' && c2.tag === 'CK-102' && c2.eq === 'heaterChoke', 'CHOKE2_LIMIT ' + JSON.stringify(c2));
      assert.match(c2.msg, X.textRe(X.ALARM_TEXTS.CHOKE2_LIMIT), 'CK-102 text');
      assert.ok(c2.msg.indexOf('bean 32/64 passes 8.92 of 10.00 MMscf/d') >= 0, c2.msg);
      assert.ok(ids(st).indexOf('CHOKE_LIMIT') < 0, 'CHOKE_LIMIT suppressed while CHOKE2_LIMIT is raised');
      assert.ok(sub && sub.sev === 'warn' && sub.tag === 'CK-101' && sub.eq === 'choke' && sub.msg === X.ALARM_TEXTS.CK1_SUBCRIT, 'CK1_SUBCRIT ' + JSON.stringify(sub));
      assert.near(st.f, A.bean32.QmaxPair / 10, 0.002, 'rate at the pair capacity');
      assert.ok(st.nodes.heaterChoke.flowLimited && st.nodes.heaterChoke.limiter === 'CK-102' && st.nodes.choke.regime === 'Subcritical', 'node flags');
      // flow-limited rate, critical CK-102: Pm = max(Phi + (Pm_ss − Phi_ss)·f², (Pm_ss + 14.696)·f − 14.696)
      const f = st.fInst, nk = st.nodes.heaterChoke, PmT = Math.max(nk.P + (A.bean32.Pm - X.EXAMPLES.flowCk2.Pout) * f * f, (A.bean32.Pm + 14.696) * f - 14.696);
      assert.near(nk.Pin, PmT, 0.5, 'live Pm at the limited rate');
      // the CK-101-only walk subcritical: no CK1_SUBCRIT
      const s2 = mk(S, flowWith(S, block('bean32'), (fl) => { fl.choke.regime = 'Subcritical'; }));
      adv(s2, 30, 1);
      assert.ok(ids(s2.getState()).indexOf('CK1_SUBCRIT') < 0 && ids(s2.getState()).indexOf('CHOKE2_LIMIT') >= 0, 'base subcritical: no CK1_SUBCRIT');
      // limiter 'both': the pair text
      const s3 = mk(S, flowWith(S, block('bean32', (b) => { b.limiter = 'both'; b.QmaxMMscfd = 8.8438; })));
      adv(s3, 30, 1);
      const c3 = alarm(s3.getState(), 'CHOKE2_LIMIT');
      assert.ok(c3 && c3.msg.indexOf('CK-101 and CK-102 together pass 8.84 of 10.00 MMscf/d') === 0, c3 && c3.msg);
      assert.match(c3.msg, X.textRe(X.ALARM_TEXTS.CHOKE2_LIMIT_both), 'both text');
      // limiter CK-101 and flow-limited: CHOKE_LIMIT as today, no CHOKE2_LIMIT
      const s4 = mk(S, flowWith(S, block('bean48', (b) => { b.flowLimited = true; b.QmaxMMscfd = 9; b.ck1.QmaxMMscfd = 9; })));
      adv(s4, 30, 1);
      assert.ok(ids(s4.getState()).indexOf('CHOKE_LIMIT') >= 0 && ids(s4.getState()).indexOf('CHOKE2_LIMIT') < 0, 'limiter CK-101: CHOKE_LIMIT');
      // CK-102 hydrate at its outlet: a cold CK-102 inlet (T3 50 °F; the outlet 38 °F colder, below the hydrate line)
      const s5 = mk(S, flowWith(S, block('bean48', (b) => { b.Tin = 50; b.Tout = 11.7; })));
      adv(s5, 30, 1);
      const hy = alarm(s5.getState(), 'HYD_heaterChoke'), n5 = s5.getState().nodes.heaterChoke;
      assert.ok(n5.hyd && n5.T < n5.th && hy && hy.sev === 'hyd' && hy.tag === 'CK-102' && hy.eq === 'heaterChoke', 'HYD_heaterChoke ' + JSON.stringify(hy));
      assert.ok(/^Heater inlet choke \(CK-102\) outlet: .+ below hydrate .+ at .+/.test(hy.msg), hy.msg);
      // every CK-102 alarm id is in Q_CK2; leaving the rig-up releases them (and CHOKE_LIMIT takes over for the base flow)
      [s, s5].forEach((x) => ids(x.getState()).filter((id) => /CHOKE2|CK1_SUB|PAH_CK2|HYD_heaterChoke/.test(id)).forEach((id) => assert.ok(X.Q_CK2.indexOf(id) >= 0, id)));
      assert.strictEqual(s.setRigup({ heaterChoke: false }), true);
      adv(s, 5, 1);
      st = s.getState();
      assert.deepStrictEqual(J(ids(st).filter((id) => X.Q_CK2.indexOf(id) >= 0)), [], 'released by quiet(Q_CK2)');
      assert.ok(!st.nodes.heaterChoke.active && !st.nodes.heaterChoke.inRig, 'out');
      assert.strictEqual(s5.setRigup({ heaterChoke: false }), true); adv(s5, 2, 1);
      assert.ok(ids(s5.getState()).indexOf('HYD_heaterChoke') < 0, 'hydrate alarm released');
    },
  },
  {
    name: 'WTSHC E1 U7: a live pinch of CK-102 (No Flow block: 24/64, and 4/64) at WHP 3,000 raises PAH-102 from the live Pm; opening to 48/64 clears it; no throw, finite',
    wp: WP,
    opts: false,
    run(app, assert) {
      const S = X.loadEngine('work');
      // 4/64 (pair capacity 0.167 MMscf/d): PAH-102 within the first second of the pinch. (The rate cut to 1.7 % then trips
      // PSHH-101 / ESD through the separator PCV re-sizing, as a CK-101-only flow limited to 0.167 does in v3.3.1.)
      const q = mk(S, flowWith(S, block('bean48')));
      adv(q, 300, 1);
      q.setFlow(flowWith(S, block('bean4')));
      adv(q, 1, 1);
      const q1 = q.getState(), qa = alarm(q1, 'PAH_CK2');
      assert.ok(qa && qa.value >= 0.9 * X.DESIGN_P_CK2, '4/64: PAH-102 after 1 s ' + JSON.stringify(qa));
      adv(q, 120, 1);
      assert.deepStrictEqual(finiteBad(J(q.getState()), J(S.NULLABLE)), [], '4/64: finite');
      // 24/64 (pair capacity 5.69): the sustained case
      const s = mk(S, flowWith(S, block('bean48')));
      adv(s, 300, 1);
      assert.ok(ids(s.getState()).indexOf('PAH_CK2') < 0, 'no PAH-102 at 48/64');
      const p0 = s.getState().nodes.choke.P;
      s.setFlow(flowWith(S, block('bean24')));                      // bean2 24/64: setHostInput → calcWTS → setFlow
      const st0 = s.getState();
      assert.near(st0.nodes.choke.P, p0, 0.01, 'no step at the bean change (the ΔP lag holds)');
      let raised = -1;
      for (let t = 1; t <= 300; t++) {
        s.advance(1);
        if (raised < 0 && ids(s.getState()).indexOf('PAH_CK2') >= 0) raised = t;
      }
      const st = s.getState(), pah = alarm(st, 'PAH_CK2'), nk = st.nodes.heaterChoke;
      assert.ok(raised > 0 && raised <= 5 && pah, 'PAH-102 raised after ' + raised + ' s and held');
      assert.ok(ids(st).indexOf('ESD_TRIPPED') < 0, 'no ESD');
      assert.match(pah.msg, X.textRe(X.ALARM_TEXTS.PAH_CK2_inlet), 'inlet text');
      assert.ok(pah.tag === 'PAH-102' && pah.value >= 0.9 * X.DESIGN_P_CK2 && pah.limit === 0.9 * X.DESIGN_P_CK2, 'value / limit');
      assert.ok(nk.regime === 'No Flow' && nk.flowLimited && nk.limiter === 'CK-102', 'No Flow block');
      assert.ok(nk.Pin <= st.nodes.choke.Pin + 1e-9 && nk.Pin > 0.95 * st.nodes.choke.Pin, 'Pm at the CK-101 inlet (infeasible edge), never above it: ' + nk.Pin + ' / ' + st.nodes.choke.Pin);
      assert.near(st.f, A.bean24.QmaxPair / 10, 0.002, 'rate at the pair capacity');
      assert.ok(ids(st).indexOf('CHOKE2_LIMIT') >= 0 && ids(st).indexOf('CHOKE_LIMIT') < 0, 'CHOKE2_LIMIT (CHOKE_LIMIT suppressed)');
      assert.deepStrictEqual(finiteBad(J(st), J(S.NULLABLE)), [], 'finite');
      assert.ok(st.nodes.choke.dTjt + nk.dTjt <= 150 + 1e-9, 'cumulative J-T cap');
      // open again: Pm falls through the lag, PAH-102 clears (2 % below the limit)
      s.setFlow(flowWith(S, block('bean48')));
      adv(s, 300, 1);
      assert.ok(ids(s.getState()).indexOf('PAH_CK2') < 0 && ids(s.getState()).indexOf('CHOKE2_LIMIT') < 0, 'cleared');
      assert.near(s.getState().nodes.heaterChoke.Pin, A.bean48.Pm, 0.005 * A.bean48.Pm, 'back to 48/64');
    },
  },
  {
    name: 'WTSHC E1 U3: heater bypass takes CK-102 out of line (bypassed, alarms released) without a step; the ΔP decays on its 5 s lag; rig out / in continuous',
    wp: WP,
    opts: false,
    run(app, assert) {
      const S = X.loadEngine('work');
      const base = mk(S, flowWith(S, null), { rig: {} });
      adv(base, 600, 1);
      const seg3Base = base.getState().segs[2].dP, seg3Blk = X.EXAMPLES.flowCk2.segs[0].dP, swap = Math.abs(seg3Base - seg3Blk);
      // heater bypass (host input wts_bypass → setFlow) with CK-102 pinched to 32/64 (alarms raised)
      const s = mk(S, flowWith(S, block('bean32')));
      adv(s, 600, 1);
      assert.ok(ids(s.getState()).indexOf('CHOKE2_LIMIT') >= 0, 'alarm before');
      const before = s.getState(), dP0 = fu(s).ck2dP, fi2 = before.fInst * before.fInst;
      s.setFlow(flowWith(S, block('bean32'), (f) => { f.inputs.bypass = true; f.heater.bypass = true; }));
      const after = s.getState(), nk = after.nodes.heaterChoke;
      assert.ok(nk.inRig && nk.bypassed && !nk.active && fu(s).CK2.act === false && fu(s).sel === 'base', 'bypassed with H-101');
      assert.strictEqual(fu(s).ck2dP, dP0, 'X.ck2dP kept through derive()');
      assert.ok(Math.abs(after.nodes.choke.P - before.nodes.choke.P) <= swap * fi2 + 1e-6, 'no step: only the seg-3 loss swaps (' +
        (after.nodes.choke.P - before.nodes.choke.P).toFixed(3) + ' psi, seg 3 ' + seg3Blk + ' → ' + seg3Base.toFixed(3) + ')');
      assert.deepStrictEqual(J(ids(after).filter((id) => X.Q_CK2.indexOf(id) >= 0)), [], 'alarms released (quiet Q_CK2)');
      assert.ok(maxJump(s) < 0.2 * dP0, 'no jump inside the next second');
      assert.near(fu(s).ck2dP, dP0 * Math.exp(-1 / 5), 0.01 * dP0, 'ΔP decays with τ 5 s');
      adv(s, 200, 1);
      assert.strictEqual(fu(s).ck2dP, 0, 'decayed to exactly 0');
      assert.near(s.getState().nodes.choke.P, base.getState().nodes.choke.P, 0.5, 'CK-101 outlet back on the CK-101-only law');
      // un-bypass: back in line, the lag rises from 0 (no step) to the steady ΔP
      const p1 = s.getState().nodes.choke.P;
      s.setFlow(flowWith(S, block('bean48')));
      assert.ok(Math.abs(s.getState().nodes.choke.P - p1) <= swap + 1e-6, 'back in line without a step');
      adv(s, 120, 1);
      assert.near(s.getState().nodes.heaterChoke.Pin, A.bean48.Pm, 0.005 * A.bean48.Pm, 'steady again');
      // rig out, then in again while the ΔP still decays: continuous both ways
      const q0 = s.getState().nodes.choke.P;
      assert.strictEqual(s.setRigup({ heaterChoke: false }), true);
      assert.ok(Math.abs(s.getState().nodes.choke.P - q0) <= swap + 1e-6, 'rig out: no step');
      adv(s, 2, 1);
      const q1 = s.getState().nodes.choke.P, d1 = fu(s).ck2dP;
      assert.ok(d1 > 0.5 * (A.bean48.Pm - X.EXAMPLES.flowCk2.Pout), 'still decaying ' + d1);
      assert.strictEqual(s.setRigup({ heaterChoke: true }), true);
      assert.ok(fu(s).ck2dP === d1 && Math.abs(s.getState().nodes.choke.P - q1) <= swap + 1e-6, 'rig in mid-decay: continues from the present ΔP');
      assert.ok(maxJump(s) < 0.2 * d1, 'no jump inside the next second');
      adv(s, 120, 1);
      assert.near(s.getState().nodes.heaterChoke.Pin, A.bean48.Pm, 0.005 * A.bean48.Pm, 'steady after re-entry');
      const m = s.getState().health.massErr;
      assert.ok(Math.abs(m.oil) < 1e-9 && Math.abs(m.water) < 1e-9 && Math.abs(m.gas) < 1e-9, 'mass balance ' + JSON.stringify(m));
    },
  },
  {
    name: 'WTSHC E1 U2 derive-survival: a bean2 change and then a Thtr change during the CK-102 transient keep X.ck2dP (no step); the pressure between the chokes rises smoothly',
    wp: WP,
    opts: false,
    run(app, assert) {
      const S = X.loadEngine('work');
      const s = mk(S, flowWith(S, block('bean48')));
      adv(s, 300, 1);
      const p0 = s.getState().nodes.choke.P, d0 = fu(s).ck2dP;
      s.setFlow(flowWith(S, block('bean40')));                      // bean2 48 → 40 (−4/64 twice)
      assert.ok(fu(s).ck2dP === d0 && Math.abs(s.getState().nodes.choke.P - p0) < 0.01, 'bean change: lag kept, no step');
      adv(s, 2, 1);
      const d1 = fu(s).ck2dP, p1 = s.getState().nodes.choke.P;
      assert.ok(d1 > d0, 'rising ' + d0 + ' → ' + d1);
      s.setFlow(flowWith(S, block('bean40'), (f) => { f.inputs.Thtr = 140; f.heater.Tout = 140; }));   // another host input
      assert.ok(fu(s).ck2dP === d1 && Math.abs(s.getState().nodes.choke.P - p1) < 0.01, 'Thtr change: lag kept, no step');
      let prev = s.getState().nodes.heaterChoke.Pin, mono = true;
      for (let i = 0; i < 60; i++) { s.advance(1); const v = s.getState().nodes.heaterChoke.Pin; if (v < prev - 1e-6) mono = false; prev = v; }
      assert.ok(mono, 'monotone rise to the new steady value');
      assert.near(prev, A.bean40.Pm, 0.005 * A.bean40.Pm, 'Pm at 40/64');
      assert.ok(ids(s.getState()).indexOf('CK1_SUBCRIT') >= 0 && ids(s.getState()).indexOf('PAH_CK2') >= 0, 'CK-101 subcritical, PAH-102 (1,660 ≥ 1,296 psig)');
      assert.ok(ids(s.getState()).indexOf('CHOKE2_LIMIT') < 0, '40/64 passes 10.66 > 10.1: not limited');
    },
  },
  {
    name: 'WTSHC E1 cumulative J-T cap (D10): dry gas (wJT 1) — CK-101 + CK-102 stages ≤ 150 °F at every sample, 150 at steady; heater inlet as the CK-101-only walk',
    wp: WP,
    opts: false,
    run(app, assert) {
      const S = X.loadEngine('work'), a = A.dryGas48;
      const dry = (f) => { f.inputs.Qo = 0; f.inputs.Qw = 0; f.choke.wJT = 1; f.choke.dTjt = 150; f.heater.Tin = a.baseTin; f.nodes[2].T = a.baseTin; f.heater.dutyMMBtuHr = a.baseDuty; };
      const b = block('bean48', (x) => { Object.assign(x, { Pin: a.Pm, dP: a.Pm - x.Pout, dTjt: a.dT2, Tin: 180 - a.dT1, Tout: a.TmOut });
        Object.assign(x.ck1, { Pout: a.Pm + 0.25, ratio: a.ratio, Tout: 180 - a.dT1, dTjt: a.dT1, wJT: 1 }); x.heater.dutyMMBtuHr = a.duty; });
      const s = mk(S, flowWith(S, b, dry), { cfg: { noise: { on: false } } });
      let worst = 0;
      for (let i = 0; i < 120; i++) { s.advance(5); const n = s.getState().nodes; worst = Math.max(worst, n.choke.dTjt + n.heaterChoke.dTjt); }
      const n = s.getState().nodes;
      assert.ok(worst <= 150 + 1e-9, 'cap ' + worst);
      assert.near(n.choke.dTjt + n.heaterChoke.dTjt, a.dTsum, 0.05, 'stages ' + n.choke.dTjt.toFixed(2) + ' + ' + n.heaterChoke.dTjt.toFixed(2));
      assert.near(n.choke.dTjt, a.dT1, 0.5, 'CK-101 stage'); assert.near(n.heaterChoke.dTjt, a.dT2, 0.5, 'CK-102 stage (the rest of the cap)');
      assert.near(n.heater.Tin, a.baseTin, a.tolTinAbs, 'heater inlet T = CK-101-only walk within 0.5 °F');
      // an empty start (rate ramps up from 0): the cap holds through the transient too
      const u = S.create(flowWith(S, b, dry), { seed: 3, config: NZ, rigup: { heaterChoke: true }, mode: 'empty' });
      let w2 = 0; for (let i = 0; i < 400; i++) { u.advance(2); const m = u.getState().nodes; w2 = Math.max(w2, m.choke.dTjt + m.heaterChoke.dTjt); }
      assert.ok(w2 <= 150 + 1e-9, 'empty-start cap ' + w2);
    },
  },
  {
    name: 'WTSHC E1 determinism (same seed → same state, noise on) and dt 1 vs dt 10 over a bean2 pinch (self-test 6 tolerances)',
    wp: WP,
    opts: false,
    timeoutMs: 300000,
    run(app, assert) {
      const S = X.loadEngine('work');
      const run = (dt, cfg) => {
        const s = mk(S, flowWith(S, block('bean48')), { seed: 99, cfg: cfg || NZ });
        adv(s, 600, dt); s.setFlow(flowWith(S, block('bean32'))); adv(s, 1200, dt);
        s.setFlow(flowWith(S, block('bean48'), (f) => { f.inputs.bypass = true; })); adv(s, 600, dt);
        return s;
      };
      const a = run(2, {}), b = run(2, {});
      assert.strictEqual(JSON.stringify(a.getState()), JSON.stringify(b.getState()), 'bit-identical with noise on');
      const s1 = run(1), s10 = run(10), x = s1.getState(), y = s10.getState();
      assert.near(x.t, y.t, 1e-6, 'clock');
      assert.near(y.cum.oilIn_stb / x.cum.oilIn_stb, 1, 1e-3, 'cum oil');
      assert.near(x.sep.P, y.sep.P, 1, 'Psep');
      assert.near(x.nodes.choke.P, y.nodes.choke.P, 1, 'CK-101 outlet');
      assert.near(fu(s1).ck2dP, fu(s10).ck2dP, 1e-6 + 0.001 * fu(s1).ck2dP, 'ΔP lag');
      // mid-transient check (dt 1 vs dt 10 at the same clock, 30 s after the pinch)
      const m1 = mk(S, flowWith(S, block('bean48'))), m10 = mk(S, flowWith(S, block('bean48')));
      adv(m1, 600, 1); adv(m10, 600, 10);
      m1.setFlow(flowWith(S, block('bean32'))); m10.setFlow(flowWith(S, block('bean32')));
      adv(m1, 30, 1); adv(m10, 30, 10);
      assert.near(m10.getState().nodes.heaterChoke.Pin, m1.getState().nodes.heaterChoke.Pin, 0.01 * m1.getState().nodes.heaterChoke.Pin, 'Pm 30 s after the pinch');
      assert.deepStrictEqual(J(ids(m10.getState()).sort()), J(ids(m1.getState()).sort()), 'same alarms');
    },
  },
  {
    name: 'WTSHC E1 old flows: CK-102 in without flow.ck2 (note, ΔP 0), a skipped block (no gas rate), a malformed block — no throw, finite, v1.4.0 law',
    wp: WP,
    opts: false,
    run(app, assert) {
      const S = X.loadEngine('work');
      const ref = mk(S, flowWith(S, null), { rig: {} }); adv(ref, 600, 10);
      const cases = [['no block', null, X.RIG_NOTES.ck2NoBlock], ['skipped', X.EXAMPLES.flowCk2Skipped, X.RIG_NOTES.ck2SkippedNote]];
      cases.forEach(([nm, blk, note]) => {
        const s = mk(S, flowWith(S, blk)); adv(s, 600, 10);
        const st = J(s.getState()), nk = st.nodes.heaterChoke;
        assert.ok(nk.inRig && !nk.active && nk.note === note && fu(s).CK2.act === false && fu(s).ck2dP === 0, nm + ': ' + JSON.stringify(nk));
        assert.strictEqual(st.nodes.choke.P, ref.getState().nodes.choke.P, nm + ': CK-101 outlet = v1.4.0 law');
        assert.deepStrictEqual(finiteBad(st, J(S.NULLABLE)), [], nm + ': finite');
        assert.ok(X.checkShape('nodes.heaterChoke', nk, { strict: true }).ok, nm + ': shape');
      });
      [{}, { v: 1, bean: 'x', Pin: 'y', segs: 'z', nodes: 3, ck1: null }, { v: 1, regime: 'No Flow', noFlow: true }].forEach((blk, i) => {
        const s = mk(S, flowWith(S, blk)); adv(s, 300, 10);
        const st = J(s.getState());
        assert.deepStrictEqual(finiteBad(st, J(S.NULLABLE)), [], 'malformed ' + i + ': finite');
        assert.ok(st.nodes.heaterChoke.Pin >= st.nodes.heaterChoke.P - 1e-9 && st.nodes.heaterChoke.Pin <= st.nodes.choke.Pin + 1e-9, 'malformed ' + i + ': Phi ≤ Pm ≤ PB');
      });
      // the flow changes from a block to none while in line: the lag decays to 0, the note appears
      const s = mk(S, flowWith(S, block('bean48'))); adv(s, 300, 10);
      s.setFlow(flowWith(S, null));
      assert.ok(fu(s).CK2.act === false && s.getState().nodes.heaterChoke.note === X.RIG_NOTES.ck2NoBlock && fu(s).ck2dP > 0, 'block gone: note, lag decaying');
      adv(s, 300, 10);
      assert.strictEqual(fu(s).ck2dP, 0);
    },
  },
];
