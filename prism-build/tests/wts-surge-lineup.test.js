// Well Test Simulator — T-201 two-compartment default line-up and the CK-101 manifold legs in the snapshot (WTS_sim 1.6.0).
//   • Default operator line-up: XV-201A open, XV-201B shut, LCV-201 suction from B, auto-divert ON (SP 0.80, hysteresis 0.10).
//     A fills while B transfers to the gauge tank; at 80 % auto-divert opens B, shuts A and moves the suction to A.
//     Steady start A 0.35 / B 0.60 of a compartment (the v3.3.1 oil / water split), transfer running; cold start both empty.
//   • cfg.surge.lineup = { inlet:[a,b], suction, auto, initFrac:[a,b] } overrides it per key; the v3.3.1 line-up pinned there
//     makes the engine exactly the frozen v3.3.1 engine (tests/_wts-sim-v331.js).
//   • nodes.choke gains leg / beanAdj / beanFix (append-only) from flow.ck1; without a block: 'adj', inputs.bean, null.
// The engine runs in its own vm context (_wts-equip-shapes.loadEngine); the last test checks the engine inside the app.
'use strict';

const X = require('./_wts-equip-shapes');
const { LEGACY_LINEUP, legacyOpts } = require('./_wts-lineup-pin.js');

const WP = 'WTSLU';
const J = (o) => JSON.parse(JSON.stringify(o));
const NOISE_OFF = { noise: { on: false } };

let W0 = null, F0 = null;
function eng() { if (!W0) W0 = X.loadEngine('work'); return W0; }
function v331() { if (!F0) F0 = X.loadEngine('v331'); return F0; }
function mk(o) { const S = eng(); return S.create(S.SAMPLE_FLOW, Object.assign({ seed: 7 }, o || {})); }
const st = (sim) => J(sim.getState());
const comp = (s, k) => s.surge.comps[k];
function balanced(assert, s, where) {
  const m = s.health.massErr;
  assert.ok(Math.abs(m.oil) < 1e-9 && Math.abs(m.water) < 1e-9 && Math.abs(m.gas) < 1e-9, where + ': mass balance ' + JSON.stringify(m));
}

module.exports = [
  {
    name: 'WTSLU default line-up: XV-201A open, XV-201B shut, suction B, auto-divert on; steady A 0.35 / B 0.60 (v3.3.1 oil / water split), transfer running; cold start empty',
    wp: WP, opts: false,
    run(app, assert) {
      const S = eng();
      assert.deepStrictEqual(J(S.SURGE_LINEUP), { inlet: [true, false], suction: 'B', auto: true, initFrac: [0.35, 0.60] }, 'exported default');
      assert.deepStrictEqual(J(S.SURGE_LINEUP_V331), J(LEGACY_LINEUP), 'exported v3.3.1 line-up = the test pin');
      const sim = mk({ config: NOISE_OFF });
      const c = J(sim.getControls()).surge;
      assert.deepStrictEqual(c, { inlet: [true, false], suction: 'B', auto: true, sp: 0.8, hyst: 0.1, strokeS: 6 }, 'controls ' + JSON.stringify(c));
      const s = st(sim);
      assert.ok(comp(s, 0).inlet && !comp(s, 1).inlet && comp(s, 0).pos === 1 && comp(s, 1).pos === 0, 'XV-201A open, XV-201B shut at t = 0');
      assert.ok(!comp(s, 0).suction && comp(s, 1).suction && s.surge.suction === 'B' && s.surge.auto.on === true, 'suction B, auto on');
      assert.near(comp(s, 0).frac, 0.35, 1e-12, 'A steady fraction');
      assert.near(comp(s, 1).frac, 0.60, 1e-12, 'B steady fraction');
      // oil / water split of each compartment = the v3.3.1 steady split (frozen engine, both at 0.55)
      const L = J(v331().create(v331().SAMPLE_FLOW, { seed: 7, config: NOISE_OFF }).getState());
      const wcut = (cp) => cp.fracW / cp.frac;
      assert.near(wcut(comp(s, 0)), wcut(L.surge.comps[0]), 1e-12, 'A water share = v3.3.1');
      assert.near(wcut(comp(s, 1)), wcut(L.surge.comps[0]), 1e-12, 'B water share = v3.3.1');
      assert.near(s.surge.P, L.surge.P, 1e-6, 'T-201 at its set point as in v3.3.1');
      assert.ok(s.surge.pump.on && s.surge.pump.q_bpd > 0 && s.surge.pump.suction === 'B', 'LCV-201 transferring from B: ' + s.surge.pump.q_bpd);
      assert.strictEqual(s.alarms.length, 0, 'no alarm at t = 0: ' + s.alarms.map((a) => a.id).join());
      balanced(assert, s, 't = 0');
      // cold start: both compartments empty, same line-up
      sim.reset('empty');
      const e = st(sim);
      assert.ok(comp(e, 0).frac === 0 && comp(e, 1).frac === 0 && comp(e, 0).inlet && !comp(e, 1).inlet && e.surge.suction === 'B', 'cold start empty, line-up kept');
    },
  },
  {
    name: 'WTSLU independent filling at ×10: over 30 min A rises (XV-201A open) while B (inlet shut) only falls, until auto-divert',
    wp: WP, opts: false,
    run(app, assert) {
      const sim = mk({ seed: 11 });
      sim.setSpeed(10);
      assert.strictEqual(sim.getSpeed(), 10, 'speed ×10');
      const inv = (cp) => cp.Vo_stb + cp.Vw_bbl;           // a compartment's inventory (STB oil + bbl water: no Bo swell in it)
      let s = st(sim), lastA = inv(comp(s, 0)), lastB = inv(comp(s, 1)), tDiv = null, risesA = 0, samples = 0;
      const A0 = comp(s, 0).frac, B0 = comp(s, 1).frac, B0i = lastB;
      sim.on('divert', (e) => { if (tDiv === null && e.eq === 'surge') tDiv = e.t; });
      for (let i = 1; i <= 1800; i++) {                   // 1800 real-time steps of 0.1 s at ×10 = 30 min of test time
        sim.step(0.1);
        if (i % 30 !== 0) continue;                       // every 30 s of test time
        s = st(sim);
        if (tDiv !== null) break;
        samples++;
        const a = inv(comp(s, 0)), b = inv(comp(s, 1));
        assert.ok(a >= lastA - 1e-9, 't ' + s.t.toFixed(0) + ': A (not on the suction) never falls (' + lastA + ' → ' + a + ')');
        assert.ok(!comp(s, 1).inlet && comp(s, 1).fill_bpd === 0, 't ' + s.t.toFixed(0) + ': B receives nothing while XV-201B is shut');
        assert.ok(b <= lastB + 1e-9, 't ' + s.t.toFixed(0) + ': B never rises with its inlet shut (' + lastB + ' → ' + b + ')');
        if (a > lastA) risesA++;
        lastA = a; lastB = b;
      }
      assert.ok(samples >= 40, 'at least 20 min before the first divert: ' + samples + ' samples, divert at ' + tDiv);
      assert.ok(risesA >= samples / 2, 'A rises over most 30 s samples (the separator dumps cycle): ' + risesA + ' / ' + samples);
      assert.ok(comp(s, 0).frac > A0 + 0.3, 'A filled from ' + A0 + ' to ' + comp(s, 0).frac);
      assert.ok(comp(s, 1).frac < B0 - 0.3 && lastB < B0i, 'B transferred from ' + B0 + ' to ' + comp(s, 1).frac);
      balanced(assert, st(sim), '30 min');
    },
  },
  {
    name: 'WTSLU auto-divert at 80 %: A full → XV-201B opens, XV-201A shuts (after XV-201B is open), LCV-201 suction moves to A; then B full → back to A',
    wp: WP, opts: false,
    run(app, assert) {
      const sim = mk({ config: NOISE_OFF });
      const evs = [];
      sim.on('divert', (e) => evs.push(J(e)));
      let s = null, at = null;
      for (let i = 0; i < 3600 && !evs.length; i++) { sim.advance(1); }
      assert.strictEqual(evs.length, 1, 'one divert in the first hour');
      const e = evs[0];
      assert.ok(e.eq === 'surge' && e.from === 0 && e.to === 1 && e.auto === true, 'A → B ' + JSON.stringify(e));
      assert.ok(/T-201A at 80%/.test(e.msg) && /XV-201B open, XV-201A closed/.test(e.msg) && /LCV-201 suction → T-201A/.test(e.msg), e.msg);
      s = st(sim); at = s.t;
      assert.ok(comp(s, 0).frac >= 0.8 - 1e-3 && comp(s, 0).frac < 0.81, 'A at the set point: ' + comp(s, 0).frac);
      assert.ok(!comp(s, 0).inlet && comp(s, 1).inlet, 'commands: A shut, B open');
      assert.strictEqual(s.surge.suction, 'A', 'suction moved to the full compartment');
      let blocked = false, mbb = true;                    // make-before-break: XV-201A stays fully open until XV-201B is fully open
      for (let i = 0; i < 40; i++) {                      // 20 s ≥ two 6 s strokes
        sim.advance(0.5);
        const x = st(sim);
        if (x.alarms.some((a) => a.id === 'SURGE_BLOCKED')) blocked = true;
        if (comp(x, 1).pos < 1 && comp(x, 0).pos < 1) mbb = false;
      }
      assert.ok(mbb, 'XV-201A held open while XV-201B strokes');
      s = st(sim);
      assert.ok(comp(s, 0).pos === 0 && comp(s, 1).pos === 1 && !blocked, 'after the stroke: A shut, B open, never blocked');
      assert.ok(s.surge.pump.on && s.surge.pump.suction === 'A', 'transferring from A');
      // B now fills, A drains; at 80 % in B the inlet and suction swap back
      for (let i = 0; i < 7200 && evs.length < 2; i++) sim.advance(1);
      assert.strictEqual(evs.length, 2, 'second divert');
      assert.ok(evs[1].from === 1 && evs[1].to === 0 && evs[1].t > at, 'B → A ' + JSON.stringify(evs[1]));
      s = st(sim);
      assert.strictEqual(s.surge.suction, 'B', 'suction back to B');
      balanced(assert, s, 'after two diverts');
    },
  },
  {
    name: 'WTSLU cfg.surge.lineup: per-key override, the operator line-up persists across reset, and the v3.3.1 pin is exactly the frozen v3.3.1 engine',
    wp: WP, opts: false,
    run(app, assert) {
      // partial override: only the suction changes
      let sim = mk({ config: { surge: { lineup: { suction: 'both' } } } });
      let c = J(sim.getControls()).surge;
      assert.ok(c.inlet[0] === true && c.inlet[1] === false && c.suction === 'both' && c.auto === true, 'partial ' + JSON.stringify(c));
      sim = mk({ config: { surge: { lineup: { initFrac: [0.2, 0.7] } } } });
      let s = st(sim);
      assert.near(comp(s, 0).frac, 0.2, 1e-12, 'initFrac A'); assert.near(comp(s, 1).frac, 0.7, 1e-12, 'initFrac B');
      // the operator line-up persists across reset (as before 1.6.0)
      sim = mk({ config: NOISE_OFF });
      sim.advance(120);
      assert.ok(sim.setValve('surge', 1, true) && sim.setSuction('both') && sim.setAutoDivert('surge', false), 'operator changes');
      sim.reset();
      s = st(sim); c = J(sim.getControls()).surge;
      assert.ok(c.inlet[0] && c.inlet[1] && c.suction === 'both' && c.auto === false, 'kept across reset ' + JSON.stringify(c));
      assert.ok(comp(s, 0).pos === 1 && comp(s, 1).pos === 1 && s.t === 0, 'valves at their commands at t = 0');
      assert.near(comp(s, 0).frac, 0.35, 1e-12, 'reset fills from initFrac'); assert.near(comp(s, 1).frac, 0.60, 1e-12, 'reset B');
      // the v3.3.1 pin: identity with the frozen engine (state and history, 2 h at dt 10 with an operator divert and a reset)
      const F = v331(), W = eng();
      const a = F.create(F.SAMPLE_FLOW, { seed: 5 }), b = W.create(W.SAMPLE_FLOW, legacyOpts({ seed: 5 }));
      assert.deepStrictEqual(J(b.getControls()).surge, J(a.getControls()).surge, 'pinned controls = v3.3.1');
      for (let i = 1; i <= 720; i++) {
        if (i === 200) { a.setValve('surge', 1, false); b.setValve('surge', 1, false); }
        if (i === 500) { a.reset(); b.reset(); }
        a.advance(10); b.advance(10);
        if (i % 60 === 0) {
          const d = X.identityDiff(J(a.getState()), J(b.getState()), 5);
          assert.ok(d.length === 0, 't ' + i * 10 + ': ' + d.join('; '));
        }
      }
      const dh = X.identityDiff(J(['surgeFracA', 'surgeFracB', 'surgeP'].map((k) => a.getHistory(k))), J(['surgeFracA', 'surgeFracB', 'surgeP'].map((k) => b.getHistory(k))), 5);
      assert.ok(dh.length === 0, 'history ' + dh.join('; '));
    },
  },
  {
    name: 'WTSLU nodes.choke leg / beanAdj / beanFix: appended after dTjt; no flow.ck1 → adj, inputs.bean, null (NULLABLE); with ck1 → the block; setFlow updates them',
    wp: WP, opts: false,
    run(app, assert) {
      const S = eng();
      assert.ok(S.NULLABLE.indexOf('nodes.choke.beanFix') >= 0, 'nodes.choke.beanFix is NULLABLE');
      const sim = mk({ config: NOISE_OFF });
      let n = st(sim).nodes.choke;
      const keys = Object.keys(n);
      assert.deepStrictEqual(keys.slice(-4), ['dTjt', 'leg', 'beanAdj', 'beanFix'], 'append-only key order ' + keys.join());
      assert.ok(n.leg === 'adj' && n.beanAdj === 32 && n.bean === 32 && n.beanFix === null, 'no block ' + JSON.stringify(n));
      // the v3.3.1 keys of the node are unchanged (frozen engine key list is a prefix)
      const k331 = Object.keys(J(v331().create(v331().SAMPLE_FLOW, { seed: 7 }).getState()).nodes.choke);
      assert.deepStrictEqual(keys.slice(0, k331.length), k331, 'v3.3.1 keys first');
      // a flow with the positive leg in service
      const f = J(S.SAMPLE_FLOW);
      f.inputs.bean = 24; f.chokeBean = 24;
      f.ck1 = { v: 1, leg: 'fixed', beanAdj: 40, beanFix: 24, bean: 24 };
      sim.setFlow(f);
      n = st(sim).nodes.choke;
      assert.ok(n.leg === 'fixed' && n.beanAdj === 40 && n.beanFix === 24 && n.bean === 24, 'fixed leg ' + JSON.stringify(n));
      // back to the adjustable leg
      f.inputs.bean = 40; f.chokeBean = 40; f.ck1 = { v: 1, leg: 'adj', beanAdj: 40, beanFix: 24, bean: 40 };
      sim.setFlow(f);
      n = st(sim).nodes.choke;
      assert.ok(n.leg === 'adj' && n.beanAdj === 40 && n.beanFix === 24 && n.bean === 40, 'adjustable leg ' + JSON.stringify(n));
      // a block with gaps: unknown leg → 'adj', missing beanAdj → inputs.bean, missing beanFix → null
      f.ck1 = { v: 1, leg: 'other' };
      sim.setFlow(f);
      n = st(sim).nodes.choke;
      assert.ok(n.leg === 'adj' && n.beanAdj === 40 && n.beanFix === null, 'gaps ' + JSON.stringify(n));
      // a flow without the block again
      delete f.ck1;
      const s2 = S.create(f, { seed: 7 });
      n = st(s2).nodes.choke;
      assert.ok(n.leg === 'adj' && n.beanAdj === 40 && n.beanFix === null, 'no block after a block ' + JSON.stringify(n));
      // created on a ck1 flow
      f.ck1 = { v: 1, leg: 'fixed', beanAdj: 48, beanFix: 20, bean: 20 }; f.inputs.bean = 20;
      n = st(S.create(f, { seed: 7 })).nodes.choke;
      assert.ok(n.leg === 'fixed' && n.beanAdj === 48 && n.beanFix === 20 && n.bean === 20, 'created on ck1 ' + JSON.stringify(n));
    },
  },
  {
    // T-202 route 'both' under the default line-up. The split is pressure-driven (check-valved branches into two gas spaces, §5.2):
    // while LCV-201 transfers, T-201 is drawn below its set point (PCV-201 shut, PCV-202 blanket P-only band), so the small water
    // dumps and the blow-by go to T-201 and the instantaneous share reads 0 between the oil dumps; the oil-dump slugs still split.
    // That is physical and the same with the v3.3.1 line-up; the default only runs the transfer after each auto-divert (≈ hourly),
    // so a single sample at ≈ 1 h can read 0. Over 2 h the dump-volume share stays shared and never sticks at 0.
    name: 'WTSLU T-202 route both under the default line-up: dump share stays shared over 2 h (20-min windows, overall = v3.3.1 line-up), never stuck at 0',
    wp: WP, opts: false,
    run(app, assert) {
      function runBoth(legacy) {
        const S = eng(), o = { seed: 7, rigup: { surge2: true }, config: NOISE_OFF };
        const sim = S.create(S.SAMPLE_FLOW, legacy ? legacyOpts(o) : o);
        assert.ok(sim.setSurgeRoute('both').ok, 'route both');
        const r = { wins: [], v1: 0, v2: 0, run0: 0, max0: 0, xferLow: 0, diverts: 0, s: null };
        sim.on('divert', (e) => { if (e.eq === 'surge') r.diverts++; });
        let w1 = 0, w2 = 0;
        for (let t = 5; t <= 7200; t += 5) {
          sim.advance(5);
          const s = st(sim), f1 = comp(s, 0).fill_bpd + comp(s, 1).fill_bpd, f2 = s.surge2.fill_bpd;
          assert.ok(s.surge2.route === 'both' && s.surge2.share >= 0 && s.surge2.share <= 1, 't ' + t + ': route ' + s.surge2.route + ', share ' + s.surge2.share);
          w1 += f1; w2 += f2;
          if (s.surge2.share < 0.05) { r.run0 += 5; r.max0 = Math.max(r.max0, r.run0); } else r.run0 = 0;
          if (s.surge.pump.on && s.surge.pump.q_bpd > 0 && s.surge.P < s.surge2.P - 0.5) r.xferLow++;
          if (t % 1200 === 0) { r.wins.push(w2 / (w1 + w2)); r.v1 += w1; r.v2 += w2; w1 = 0; w2 = 0; }
          r.s = s;
        }
        r.share = r.v2 / (r.v1 + r.v2);
        return r;
      }
      const n = runBoth(false), l = runBoth(true), f = (x) => x.toFixed(3);
      assert.strictEqual(n.wins.length, 6, 'six 20-min windows');
      n.wins.forEach((w, i) => assert.ok(w > 0.35 && w < 0.6, 'default line-up window ' + i + ': T-202 share of the dumped volume ' + f(w)));
      assert.ok(n.share > 0.43 && n.share < 0.53, 'default line-up 2 h share ' + f(n.share));
      assert.ok(Math.abs(n.share - l.share) < 0.03, 'default ' + f(n.share) + ' vs v3.3.1 line-up ' + f(l.share));
      assert.ok(n.diverts >= 1 && n.xferLow > 0, 'T-201 transferred below T-202 (auto-divert ' + n.diverts + ', samples ' + n.xferLow + ')');
      assert.ok(n.max0 <= 600, 'instantaneous share never stuck at 0: longest ' + n.max0 + ' s (v3.3.1 line-up ' + l.max0 + ' s)');
      assert.ok(!n.s.esd.tripped && !l.s.esd.tripped, 'no ESD');
      balanced(assert, n.s, 'default line-up, route both, 2 h');
    },
  },
  {
    // review [engine 0]: a set point below LSH (0.70) used to move the suction to the compartment at SP and leave LCV-201 shut
    // (level control starts at LSH), ending in LSHH-201 → ESD. The transfer now starts with the move.
    name: 'WTSLU auto-divert SP below LSH (0.65, 0.50, 0.40, 0.34, 0.30): 4 h under the default line-up with no ESD; LCV-201 starts on the compartment the divert moved the suction to',
    wp: WP, opts: false,
    run(app, assert) {
      // 0.34 / 0.30: SP − hyst at or below LSL — the single suction parks at LSL and must still count as having room (review round 2)
      [0.65, 0.50, 0.40, 0.34, 0.30].forEach((sp) => {
        const sim = mk({ config: NOISE_OFF });
        assert.ok(sim.setControls({ surge: { sp } }), 'sp ' + sp);
        assert.strictEqual(J(sim.getControls()).surge.sp, sp, 'sp applied');
        const dv = [], raised = [];
        let afterMove = 0, checked = 0;
        sim.on('divert', (e) => { if (e.eq === 'surge') dv.push(J(e)); });
        sim.on('alarm', (e) => raised.push(e.id));
        let nDv = 0;
        for (let i = 0; i < 1440; i++) {
          sim.advance(10);
          if (dv.length > nDv) {                          // just after a divert: the transfer runs from the moved-to compartment
            nDv = dv.length;
            const s = st(sim);
            checked++;
            if (s.surge.pump.on && s.surge.pump.q_bpd > 0 && s.surge.pump.suction === s.surge.suction) afterMove++;
          }
        }
        const s = st(sim);
        assert.ok(!s.esd.tripped, 'sp ' + sp + ': no ESD in 4 h (alarms ' + raised.join() + ')');
        assert.ok(raised.indexOf('LSHH_SURGE') < 0, 'sp ' + sp + ': no LSHH-201: ' + raised.join());
        // below SP 0.50 the filling side can reach SP before the transferring side is drawn below its room level: LAH-201
        // (auto-divert has no room yet) is a true alarm there; from 0.50 up it never fires
        if (sp >= 0.5) assert.ok(raised.indexOf('LAH_SURGE_BOTH') < 0, 'sp ' + sp + ': no LAH-201: ' + raised.join());
        assert.ok(dv.length >= 4, 'sp ' + sp + ': the inlet keeps diverting (' + dv.length + ' diverts)');
        assert.ok(dv.every((e) => /LCV-201 suction →/.test(e.msg)), 'sp ' + sp + ': every divert moved the suction');
        assert.ok(checked >= 4 && afterMove === checked, 'sp ' + sp + ': LCV-201 transferring after each divert (' + afterMove + ' / ' + checked + ')');
        const mx = Math.max(comp(s, 0).frac, comp(s, 1).frac);
        assert.ok(mx < sp + 0.03, 'sp ' + sp + ': levels held near the set point (max ' + mx.toFixed(3) + ')');
        balanced(assert, s, 'sp ' + sp + ' 4 h');
      });
      // SP ≥ LSH is unchanged: the default 0.80 still diverts about every 30 min with no alarm
      const d = mk({ config: NOISE_OFF });
      let n = 0, al = 0;
      d.on('divert', (e) => { if (e.eq === 'surge') n++; });
      d.on('alarm', () => al++);
      for (let i = 0; i < 1440; i++) d.advance(10);
      assert.ok(n >= 6 && al === 0 && !st(d).esd.tripped, 'sp 0.80: ' + n + ' diverts, ' + al + ' alarms');
    },
  },
  {
    // review [engine 1]: with auto-divert off the inlet-open compartment that is not on the LCV-201 suction has no level control;
    // LAH-201 now alarms on it at the auto set point, well before LSHH-201. Suction 'both' (the v3.3.1 line-up) never raises it.
    name: 'WTSLU auto-divert off: LAH-201 on the uncontrolled inlet compartment (at the auto SP) raised before LSHH-201; the v3.3.1 pin stays silent',
    wp: WP, opts: false,
    run(app, assert) {
      const sim = mk({ config: NOISE_OFF });
      assert.ok(sim.setControls({ surge: { auto: false } }), 'auto off');
      const ev = [];
      sim.on('alarm', (e) => ev.push(J(e)));
      for (let i = 0; i < 1440 && !st(sim).esd.tripped; i++) sim.advance(10);
      const ids = ev.map((e) => e.id), iL = ids.indexOf('LAH_SURGE_BOTH'), iH = ids.indexOf('LSHH_SURGE');
      assert.ok(iL >= 0, 'LAH-201 raised: ' + ids.join());
      assert.ok(iH < 0 || (iL < iH && ev[iH].t - ev[iL].t >= 240), 'LAH-201 at least 4 min before LSHH-201 (' + (iH >= 0 ? (ev[iH].t - ev[iL].t).toFixed(0) + ' s' : 'no LSHH') + ')');
      const a = ev[iL];
      assert.ok(a.tag === 'LAH-201' && /^LAH-201 T-201A high \(80(\.\d)?% ≥ 80(\.0)?%\)/.test(a.msg) && /not on the LCV-201 suction/.test(a.msg) && /auto-divert off/.test(a.msg), a.msg);
      assert.ok(a.value >= 80 && a.value < 81 && a.limit === 80, 'value / limit ' + a.value + ' / ' + a.limit);
      // moving the suction to the filling compartment clears it (that compartment is under level control again)
      const b = mk({ config: NOISE_OFF });
      b.setControls({ surge: { auto: false } });
      for (let i = 0; i < 1440 && !st(b).alarms.some((x) => x.id === 'LAH_SURGE_BOTH'); i++) b.advance(10);
      assert.ok(st(b).alarms.some((x) => x.id === 'LAH_SURGE_BOTH'), 'raised on the second run');
      assert.ok(b.setSuction('A'), 'suction A');
      for (let i = 0; i < 360; i++) b.advance(10);
      const sb = st(b);
      assert.ok(!sb.alarms.some((x) => x.id === 'LAH_SURGE_BOTH') && !sb.esd.tripped, 'cleared with the suction on A: ' + sb.alarms.map((x) => x.id).join());
      // the v3.3.1 pin (both inlets, suction both, auto off): 4 h, no alarm at all (suction 'both' never takes this LAH-201 path)
      const S = eng(), q = S.create(S.SAMPLE_FLOW, legacyOpts({ seed: 7, config: NOISE_OFF })), seen = [];
      q.on('alarm', (e) => seen.push(e.id));
      for (let i = 0; i < 1440; i++) q.advance(10);
      assert.ok(seen.length === 0 && !st(q).esd.tripped, 'v3.3.1 pin: ' + seen.join());
    },
  },
  {
    // review [ux 0]: the CK-101 flow-limited alarm refreshes its value, limit and text while raised; the positive leg is named only
    // while it is in service (the adjustable leg / no flow.ck1 keeps the v3.3.1 text)
    name: 'WTSLU CHOKE_LIMIT text follows a bean change and a leg switch while raised; positive leg named only while in service',
    wp: WP, opts: false,
    run(app, assert) {
      const S = eng();
      const fl = (b, q, leg, ba, bf) => {
        const f = J(S.SAMPLE_FLOW);
        f.inputs.bean = b; f.chokeBean = b; f.choke.flowLimited = true; f.choke.QmaxMMscfd = q;
        if (leg) f.ck1 = { v: 1, leg, beanAdj: ba, beanFix: bf, bean: b };
        return f;
      };
      const sim = mk({ config: NOISE_OFF });
      let raises = 0;
      sim.on('alarm', (e) => { if (e.id === 'CHOKE_LIMIT') raises++; });
      const cur = () => { const s = st(sim); return { a: s.alarms.find((x) => x.id === 'CHOKE_LIMIT'), v: s.alarmVersion }; };
      // positive leg at 24/64
      sim.setFlow(fl(24, 6.02, 'fixed', 32, 24)); sim.advance(30);
      let c = cur();
      assert.ok(c.a && c.a.msg === 'CK-101 positive leg flow-limited — bean 24/64″ passes 6.02 MMSCFD of 10.00 MMSCFD requested', c.a && c.a.msg);
      assert.ok(c.a.value === 10 && c.a.limit === 6.02, 'value / limit');
      // positive bean 24 → 30 while raised: refreshed, not re-raised, banner version bumped
      const v0 = c.v;
      sim.setFlow(fl(30, 9.41, 'fixed', 32, 30)); sim.advance(30);
      c = cur();
      assert.ok(c.a.msg === 'CK-101 positive leg flow-limited — bean 30/64″ passes 9.41 MMSCFD of 10.00 MMSCFD requested', c.a.msg);
      assert.ok(c.a.limit === 9.41 && c.v > v0 && raises === 1, 'limit ' + c.a.limit + ', version ' + v0 + ' → ' + c.v + ', raises ' + raises);
      // a steady flow does not bump the version again
      const v1 = c.v; sim.advance(60);
      assert.strictEqual(cur().v, v1, 'no refresh without a change');
      // switch to the adjustable leg (20/64): the v3.3.1 text
      sim.setFlow(fl(20, 4.2, 'adj', 20, 30)); sim.advance(30);
      c = cur();
      assert.ok(c.a.msg === 'CK-101 flow-limited — bean 20/64″ passes 4.20 MMSCFD of 10.00 MMSCFD requested' && c.a.limit === 4.2, c.a.msg);
      // no flow.ck1 block: the v3.3.1 text as well (the frozen v3.3.1 engine raises the same string)
      const q = mk({ config: NOISE_OFF }), F = v331(), r = F.create(F.SAMPLE_FLOW, { seed: 7, config: NOISE_OFF });
      q.setFlow(fl(24, 6.02)); r.setFlow(fl(24, 6.02)); q.advance(30); r.advance(30);
      const m1 = J(q.getState()).alarms.find((x) => x.id === 'CHOKE_LIMIT'), m0 = J(r.getState()).alarms.find((x) => x.id === 'CHOKE_LIMIT');
      assert.ok(m1 && m0 && m1.msg === m0.msg && m1.value === m0.value && m1.limit === m0.limit, 'no ck1 = v3.3.1: ' + (m1 && m1.msg) + ' | ' + (m0 && m0.msg));
      // cleared once not flow-limited
      const ok = fl(32, 10.71, 'adj', 32, 30); ok.choke.flowLimited = false;
      sim.setFlow(ok); sim.advance(60);
      assert.ok(!cur().a, 'cleared');
    },
  },
  {
    name: 'WTSLU in the app built from sources: default line-up, snapshot shape (strict) and the choke keys',
    wp: WP,
    run(app, assert) {
      const S = app.win.WTS_sim;
      const sim = S.create(S.SAMPLE_FLOW, app.toWin({ seed: 2 }));
      const s = J(sim.getState());
      assert.ok(s.surge.comps[0].inlet && !s.surge.comps[1].inlet && s.surge.suction === 'B' && s.surge.auto.on, 'default line-up in the app');
      assert.ok(s.nodes.choke.leg === 'adj' && s.nodes.choke.beanFix === null, 'choke keys in the app');
      for (let i = 0; i < 90; i++) sim.advance(10);
      balanced(assert, J(sim.getState()), 'app 15 min');
    },
  },
];
