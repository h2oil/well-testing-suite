// Well Test Simulator — T-202 second surge tank (docs/SIM-EQUIPMENT-PLAN.md §5, §9.2 "wts-surge2"; WP-E2).
// The engine (prism-build/31-wts-sim.js, self-test stripped) runs in its own vm context through _wts-equip-shapes.loadEngine;
// the last test checks the same engine inside the app built from sources. Expected values are plan constants (§5, §6), the
// LCV-202 law q = Cv·√(ΔP/SG) of §5.4, conservation (balances) or comparisons between two runs of the same engine.
'use strict';

const X = require('./_wts-equip-shapes');

const WP = 'WTSS2';
const J = (o) => JSON.parse(JSON.stringify(o));
const GPM_BPD = 34.2857;
let S0 = null;
function eng() { if (!S0) S0 = X.loadEngine('work'); return S0; }
function flow(o) {
  const f = J(eng().SAMPLE_FLOW);
  Object.keys(o || {}).forEach((k) => { f.sim[k] = o[k]; });
  return f;
}
function mk(o) {
  o = o || {};
  return eng().create(flow(o.sim), Object.assign({ seed: o.seed || 3, rigup: Object.assign({ surge2: true }, o.rigup || {}) }, o.config ? { config: o.config } : {}));
}
const st = (sim) => J(sim.getState());
// advance in steps of dt (s); cb(state) → true stops early (returns true)
function run(sim, secs, dt, cb) {
  const n = Math.round(secs / dt);
  for (let i = 0; i < n; i++) { sim.advance(dt); if (cb && cb(st(sim))) return true; }
  return false;
}
const active = (s, id) => s.alarms.some((a) => a.id === id);
const logged = (s, id) => s.alarmLog.some((a) => a.id === id);
function balanced(assert, s, tol, tag) {
  const m = s.health.massErr;
  assert.ok(Math.abs(m.oil) < tol && Math.abs(m.water) < tol && Math.abs(m.gas) < tol, tag + ' balances ' + JSON.stringify(m));
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

module.exports = [
  {
    name: 'WTSS2 T-202 enters the rig-up empty with XV-202 shut; standby snapshot matches the contract example (§5.1, §6.4)',
    wp: WP, opts: false,
    run(app, assert) {
      const sim = mk(), s = st(sim);
      const r = X.checkShape('surge2', s.surge2, { strict: true });
      assert.ok(r.ok, r.errors.join('; '));
      const E = X.EXAMPLES.surge2;
      assert.ok(s.surge2.inRig && !s.surge2.inlet && s.surge2.pos === 0 && s.surge2.frac === 0 && s.surge2.Vo_bbl === 0 && s.surge2.route === 'surge', 'standby');
      ['SP', 'SPeff', 'psh', 'pshh', 'mawp', 'cap_bbl', 'D', 'lsll', 'lsl', 'lsh', 'lshh'].forEach((k) => assert.strictEqual(s.surge2[k], E[k], k));
      assert.near(s.surge2.P, E.P, 0.01, 'P at the set pressure');
      assert.near(s.surge2.H, E.H, 1e-3, 'H');
      assert.near(s.surge2.transfer.design_bpd, E.transfer.design_bpd, 1, 'LCV-202 design');
      assert.near(s.surge2.transfer.dPdesign_psi, E.transfer.dPdesign_psi, 0.05, 'LCV-202 design ΔP');
      assert.near(s.surge2.transfer.Cv, E.transfer.Cv, 0.01, 'LCV-202 Cv');
      assert.strictEqual(s.surge2.tFull_s, null); assert.strictEqual(s.surge2.transfer.trip, null);
      assert.strictEqual(s.nodes.surge2.P, s.surge2.P); assert.strictEqual(s.nodes.surge2.T, s.surge2.T);
      ['sep_surge2', 'surge2_gauge', 'surge2_vent', 'blanket2', 'psv_surge2'].forEach((k) => assert.strictEqual(s.lines[k].active, false, k + ' idle'));
      // added later from the card: same (empty, shut); with T-201 out it is out too (D11)
      const b = eng().create(eng().SAMPLE_FLOW, { seed: 3 });
      b.advance(600);
      assert.strictEqual(b.setRigup({ surge2: true }), true);
      const sb = st(b);
      assert.ok(sb.surge2.inRig && !sb.surge2.inlet && sb.surge2.frac === 0 && sb.rigup.sig === '1111111101', 'added from the card ' + sb.rigup.sig);
      assert.strictEqual(b.setRigup({ surge: false }), true);
      assert.ok(!st(b).surge2.inRig && b.setSurgeRoute('surge2').ok === false && b.setValve('surge2', 0, true) === false, 'T-201 out → T-202 out, refused');
    },
  },
  {
    name: 'WTSS2 routes: make-before-break T-201 → T-202 → both → T-201 with no SURGE_BLOCKED during a switch; refused when out or at LSHH-202',
    wp: WP, opts: false,
    run(app, assert) {
      const out = eng().create(eng().SAMPLE_FLOW, { seed: 3 });
      assert.strictEqual(out.setSurgeRoute('surge2').ok, false, 'T-202 out → refused');
      const sim = mk();
      run(sim, 300, 10);
      const evs = [];
      sim.on('control', (e) => { if (e.eq === 'surge2') evs.push(e.what); });
      let r = sim.setSurgeRoute('surge2');
      assert.ok(r.ok && /routed to T-202/.test(r.msg), r.msg);
      let s = st(sim);
      assert.ok(s.surge2.inlet && s.surge.comps[0].inlet && s.surge.comps[1].inlet, 'XV-201A/B stay open until XV-202 is fully open');
      let blocked = false, minPos = 1;
      run(sim, 20, 0.5, (x) => { if (active(x, 'SURGE_BLOCKED')) blocked = true; if (x.surge2.pos < 1) minPos = Math.min(minPos, x.surge.comps[0].pos); return false; });
      s = st(sim);
      assert.ok(!blocked && minPos === 1, 'no SURGE_BLOCKED, T-201 inlets fully open while XV-202 travels');
      assert.ok(s.surge2.pos === 1 && !s.surge.comps[0].inlet && !s.surge.comps[1].inlet && s.surge2.route === 'surge2', 'route T-202 ' + s.surge2.route);
      r = sim.setSurgeRoute('both');
      assert.ok(r.ok && st(sim).surge2.route === 'both', 'both');
      run(sim, 20, 0.5, (x) => { if (active(x, 'SURGE_BLOCKED')) blocked = true; return false; });
      r = sim.setSurgeRoute('surge');
      assert.ok(r.ok, r.msg);
      run(sim, 20, 0.5, (x) => { if (active(x, 'SURGE_BLOCKED')) blocked = true; return false; });
      s = st(sim);
      assert.ok(!blocked && s.surge2.route === 'surge' && s.surge2.pos === 0 && s.surge.comps[0].pos === 1, 'back to T-201');
      assert.ok(evs.filter((w) => w === 'route').length === 3, 'route control events ' + evs.join());
      assert.ok(s.alarmLog.some((l) => l.id === 'ROUTE' && /routed to T-202/.test(l.msg)), 'ROUTE logged');
      assert.strictEqual(sim.setSurgeRoute('nowhere').ok, false, 'unknown route');
      balanced(assert, s, 1e-9, 'routes');
    },
  },
  {
    name: 'WTSS2 single valve commands are make-before-break too: XV-202 shut while XV-201 opens is held; the last XV-201 shut while XV-202 opens is held',
    wp: WP, opts: false,
    run(app, assert) {
      const sim = mk();
      sim.setSurgeRoute('surge2'); run(sim, 30, 1);
      assert.strictEqual(st(sim).surge2.route, 'surge2');
      // reopen XV-201A, then shut XV-202 at once: XV-202 stays open until XV-201A reaches its open limit
      assert.ok(sim.setValve('surge', 0, true) && sim.setValve('surge2', 0, false), 'commands');
      let blocked = false, held = false;
      run(sim, 15, 0.5, (x) => { if (active(x, 'SURGE_BLOCKED')) blocked = true; if (x.surge.comps[0].pos < 1 && x.surge2.pos === 1) held = true; return false; });
      let s = st(sim);
      assert.ok(held && !blocked && s.surge2.pos === 0 && s.surge.comps[0].pos === 1, 'XV-202 held, then shut');
      // now open XV-202 and shut XV-201A (the last T-201 inlet): XV-201A is held open until XV-202 is fully open
      assert.ok(sim.setValve('surge2', 0, true) && sim.setValve('surge', 0, false), 'commands 2');
      held = false;
      run(sim, 15, 0.5, (x) => { if (active(x, 'SURGE_BLOCKED')) blocked = true; if (x.surge2.pos < 1 && x.surge.comps[0].pos === 1) held = true; return false; });
      s = st(sim);
      assert.ok(held && !blocked && s.surge2.pos === 1 && s.surge.comps[0].pos === 0, 'XV-201A held, then shut');
      balanced(assert, s, 1e-9, 'holds');
    },
  },
  {
    name: 'WTSS2 pressure-driven split: equal pressures share ≈ 50/50; PCV-203 stuck closed on route both moves the dumps to T-201 (check valves, Ph ≥ min P)',
    wp: WP, opts: false,
    run(app, assert) {
      const sim = mk({ config: { noise: { on: false } } });
      sim.setSurgeRoute('both');
      const shares = [];
      run(sim, 1800, 5, (x) => { if (x.surge2.fill_bpd > 0 || x.lines.sep_surge2.q > 0) shares.push(x.surge2.share); return false; });
      const avg = shares.reduce((a, b) => a + b, 0) / shares.length;
      assert.ok(shares.length > 10 && Math.abs(avg - 0.5) < 0.1, 'mean share ' + avg);
      const sim2 = mk({ config: { noise: { on: false } } });
      sim2.setFault('bpv2StuckClosed', true); sim2.setSurgeRoute('both');
      let neg = false, lowPh = false, early = [], late = [];
      run(sim2, 3600, 2, (x) => {
        if (x.surge2.share < 0 || x.surge2.share > 1 || x.lines.sep_surge2.q < 0) neg = true;
        // (Ph is the header pressure of the last substep; the vessel pressures moved on by < 0.01 psi since)
        if (x.surge2.route === 'both' && x.surge2.Ph < Math.min(x.surge.P, x.surge2.P) - 0.01) lowPh = true;
        if (x.lines.sep_surge2.q > 0 || x.surge2.share > 0) (x.t < 900 ? early : late).push({ s: x.surge2.share, P: x.surge2.P });
        return x.esd.tripped;
      });
      const m = (a) => a.reduce((p, c) => p + c.s, 0) / Math.max(1, a.length);
      assert.ok(!neg && !lowPh, 'shares in [0, 1], branch flows ≥ 0, Ph ≥ min(P_k)');
      assert.ok(late.length > 0 && m(late) < m(early) - 0.05, 'T-202 share falls as its pressure rises: ' + m(early).toFixed(3) + ' → ' + m(late).toFixed(3));
      assert.ok(late[late.length - 1].P > early[0].P + 3, 'Pu2 rose');
    },
  },
  {
    name: 'WTSS2 LCV-202: q = Cv·√(ΔP/SG) on T-202 pressure, on at LSH 70 %, off at LSL 25 %; T-301 receives LCV-201 + LCV-202',
    wp: WP, opts: false,
    run(app, assert) {
      const sim = mk({ sim: { surge2Cap_bbl: 40 }, config: { noise: { on: false } } });
      sim.setSurgeRoute('surge2');
      let on = null, off = null, law = 0, cycles = 0, last = false;
      run(sim, 4 * 3600, 2, (x) => {
        const tr = x.surge2.transfer;
        if (tr.on && !last) { cycles++; if (on === null) on = x.surge2.frac; }
        if (!tr.on && last && off === null) off = x.surge2.frac;
        if (tr.on && tr.q_bpd > 0) {
          const q = tr.Cv * Math.sqrt(tr.dP_psi / Math.max(tr.sg, 0.1)) * GPM_BPD;
          law = Math.max(law, Math.abs(q - tr.q_bpd) / q);
        }
        last = tr.on; return false;
      });
      assert.ok(on !== null && on >= 0.70 - 0.01 && on < 0.72, 'on at LSH ' + on);
      assert.ok(off !== null && off <= 0.25 + 0.01 && off > 0.23, 'off at LSL ' + off);
      assert.ok(cycles >= 2 && law < 0.05, 'cycles ' + cycles + ', law error ' + law);
      // T-201 (LCV-201) and T-202 (LCV-202) both feeding T-301: the gauge inflow is the sum
      // (T-201 starts transferring at 55 % and drains to a low LSL while a small T-202 fills to LSH)
      const s2 = mk({ sim: { surge2Cap_bbl: 20 }, config: { noise: { on: false }, surge: { lsl: 0.05 } } });
      s2.setSurgeRoute('surge2');
      let both = false;
      run(s2, 3600, 2, (x) => {
        if (x.surge.transfer.on && x.surge2.transfer.on && x.surge.transfer.q_bpd > 0 && x.surge2.transfer.q_bpd > 0) {
          const sum = x.surge.transfer.q_bpd + x.surge2.transfer.q_bpd;
          if (Math.abs(x.lines.surge_gauge.q + x.lines.surge2_gauge.q - sum) < 1e-6 * sum) both = true;
        }
        return both;
      });
      assert.ok(both, 'both transfers at once');
      const c = st(s2);
      balanced(assert, c, 1e-9, 'two transfers');
      assert.ok(c.cum.gaugeOil_stb > 0, 'gauge tank filled');
    },
  },
  {
    name: 'WTSS2 LSHH-202 closes XV-202 with no ESD: on route both the dumps carry on into T-201; on route T-202 the chain SURGE_BLOCKED → LSHH-102 shuts the well in',
    wp: WP, opts: false,
    run(app, assert) {
      const sim = mk({ sim: { surge2Cap_bbl: 20 } });
      sim.setFault('xfer2StuckClosed', true); sim.setSurgeRoute('both');
      assert.ok(run(sim, 4 * 3600, 5, (x) => active(x, 'LSHH_SURGE2')), 'LSHH-202 reached');
      run(sim, 300, 5);
      let s = st(sim);
      assert.ok(!s.surge2.inlet && s.surge2.pos === 0 && s.surge2.route === 'surge' && !s.esd.tripped, 'XV-202 shut, no ESD');
      assert.ok(s.esd.blocking.indexOf('LSHH_SURGE2') < 0, 'LSHH-202 does not block the ESD reset');
      assert.ok(s.alarmLog.some((l) => l.id === 'LSHH_SURGE2' && /XV-202 closed/.test(l.msg)), 'alarm text');
      const v0 = s.surge.comps[0].Vo_bbl + s.surge.comps[1].Vo_bbl + s.surge.comps[0].Vw_bbl + s.surge.comps[1].Vw_bbl;
      assert.strictEqual(sim.setValve('surge2', 0, true), false, 'reopen refused at LSHH-202');
      assert.strictEqual(sim.setSurgeRoute('surge2').ok, false, 'route into T-202 refused at LSHH-202');
      run(sim, 600, 5);
      s = st(sim);
      assert.ok(!s.esd.tripped && s.cum.oilIn_stb > 0 && !active(s, 'SURGE_BLOCKED'), 'dumps carry on into T-201');
      const s2 = mk({ sim: { surge2Cap_bbl: 20 } });
      s2.setFault('xfer2StuckClosed', true); s2.setSurgeRoute('surge2');
      assert.ok(run(s2, 4 * 3600, 5, (x) => x.esd.tripped), 'ESD on the only route');
      const e = st(s2);
      assert.ok(logged(e, 'LSHH_SURGE2') && logged(e, 'SURGE_BLOCKED') && e.esd.cause === 'LSHH_SEP', 'chain ' + e.esd.cause);
      balanced(assert, e, 1e-9, 'LSHH-202');
      assert.ok(v0 >= 0);
    },
  },
  {
    name: 'WTSS2 LSLL-202 latches XFER2_DRYRUN (LCV-202 shut, no ESD, never blocks the ESD reset); resetTrip once above LSL; LSHH-301 shuts LCV-201 and LCV-202',
    wp: WP, opts: false,
    run(app, assert) {
      // LSL below LSLL keeps LCV-202 open down to LSLL (the low-low protection then latches it shut)
      const sim = mk({ config: { surge2: { lsl: 0.02 }, noise: { on: false } } });
      sim.setSurgeRoute('surge2');
      assert.ok(run(sim, 4 * 3600, 2, (x) => x.surge2.transfer.tripped), 'XFER2_DRYRUN latched');
      let s = st(sim);
      assert.ok(active(s, 'XFER2_DRYRUN') && s.surge2.transfer.trip === 'XFER2_DRYRUN' && !s.esd.tripped && s.surge2.transfer.q_bpd === 0, 'latched, no ESD');
      assert.ok(s.esd.blocking.length === 0, 'blocking empty ' + s.esd.blocking);
      sim.tripESD('test'); run(sim, 30, 5);
      const re = J(sim.resetESD());
      assert.ok(re.ok, 'resetESD succeeds with XFER2_DRYRUN latched ' + JSON.stringify(re));
      run(sim, 120, 5);
      s = st(sim);
      assert.ok(s.surge2.transfer.tripped && s.surge2.transfer.q_bpd === 0, 'still latched');
      const rt = J(sim.resetTrip('XFER2_DRYRUN'));
      assert.ok(rt.ok && rt.reset.indexOf('XFER2_DRYRUN') >= 0, 'reset ' + JSON.stringify(rt));
      s = st(sim);
      assert.ok(!s.surge2.transfer.tripped && !active(s, 'XFER2_DRYRUN'), 'back on level control');
      // reset refused while still at or below LSL (default LSL 25 %)
      const b = mk({ config: { noise: { on: false } } });
      b.setSurgeRoute('surge2');
      run(b, 1200, 5);
      b.setConfig({ surge2: { lsl: 0.02 } });
      assert.ok(run(b, 4 * 3600, 2, (x) => x.surge2.transfer.tripped), 'latched (2)');
      b.setConfig({ surge2: { lsl: 0.25 } });
      const rb = J(b.resetTrip('XFER2_DRYRUN'));
      assert.ok(!rb.ok && /T-202 \d+% ≤ LSL 25%/.test(rb.blocking.join()), 'refused below LSL ' + JSON.stringify(rb));
      // LSHH-301 (gauge tank full: P-201 failed, nothing drains) shuts both transfers
      const g = mk({ sim: { gaugeCap_bbl: 20 }, config: { noise: { on: false } } });
      g.setSurgeRoute('both'); g.setFault('surgePumpFail', true);
      assert.ok(run(g, 8 * 3600, 5, (x) => active(x, 'LSHH_GT')), 'LSHH-301');
      run(g, 30, 5);
      s = st(g);
      assert.ok(s.surge.transfer.q_bpd === 0 && s.surge2.transfer.q_bpd === 0 && !s.surge2.transfer.on && s.surge2.transfer.trip === 'LSHH_GT', 'both LCVs shut ' + s.surge2.transfer.trip);
    },
  },
  {
    name: 'WTSS2 oil / water / gas balances < 1e-6 over 4 h with route switches, auto route, a removal and a re-entry',
    wp: WP, opts: false, timeoutMs: 300000,
    run(app, assert) {
      const sim = mk({ seed: 11 });
      const plan = [[600, (s) => s.setSurgeRoute('both')], [3600, (s) => s.setSurgeRoute('surge2')], [5400, (s) => s.setAutoDivert('surge2', true)],
        [7200, (s) => s.setSurgeRoute('surge')], [9000, (s) => s.setRigup({ surge2: false })], [10800, (s) => s.setRigup({ surge2: true })],
        [11000, (s) => s.setSurgeRoute('both')]];
      let t = 0, worst = 0;
      plan.forEach(([at, fn]) => {
        while (t < at) { sim.advance(10); t += 10; const m = sim.getState().health.massErr; worst = Math.max(worst, Math.abs(m.oil), Math.abs(m.water), Math.abs(m.gas)); }
        fn(sim);
      });
      while (t < 4 * 3600) { sim.advance(10); t += 10; const m = sim.getState().health.massErr; worst = Math.max(worst, Math.abs(m.oil), Math.abs(m.water), Math.abs(m.gas)); }
      assert.ok(worst < 1e-6, 'worst balance ' + worst);
      const s = st(sim);
      const bad = finiteBad(s, J(eng().NULLABLE));
      assert.ok(bad.length === 0, 'finite ' + bad.slice(0, 5).join(', '));
      assert.ok(X.checkShape('surge2', s.surge2, { strict: true }).ok, 'shape');
    },
  },
  {
    name: 'WTSS2 gas accounting: GOR on route T-202 within 1 % of route T-201 at equal set points; gauge flash = Σ po_k·Rs(P_k); shrink uses the transfer-weighted Bo',
    wp: WP, opts: false, timeoutMs: 300000,
    run(app, assert) {
      const cfg = { noise: { on: false } };
      const a = mk({ config: cfg }), b = mk({ config: cfg }), c = mk({ config: cfg });
      b.setSurgeRoute('surge2'); c.setSurgeRoute('both');
      // the metered GOR follows the on/off dump and transfer cycles: compare its mean over hours 1-4
      const g = [0, 0, 0];
      for (let i = 0; i < 4 * 360; i++) {
        a.advance(10); b.advance(10); c.advance(10);
        if (i >= 360) [a, b, c].forEach((x, k) => { g[k] += x.getState().rates.gor_scf_stb; });
      }
      const sa = st(a), sb = st(b), sc = st(c);
      assert.ok(g[0] > 0 && Math.abs(g[1] / g[0] - 1) < 0.01, 'mean GOR ' + g[0] / 1080 + ' vs ' + g[1] / 1080);
      assert.ok(Math.abs(g[2] / g[0] - 1) < 0.01, 'mean GOR both ' + g[2] / 1080);
      // flash at the vessels: the T-202 route flashes as much as the T-201 route (same set point, same oil)
      assert.ok(sb.cum.flash_mscf > 0 && Math.abs(sb.cum.flash_mscf / sa.cum.flash_mscf - 1) < 0.02, 'vessel flash ' + sa.cum.flash_mscf + ' / ' + sb.cum.flash_mscf);
      // gauge-tank flash: the oil LCV-202 transfers flashes at T-301 (cum.gaugeFlash / gaugeVent and the gauge vent line)
      const gf = (x) => x.cum.gaugeFlash_mscf / x.cum.gaugeOil_stb;
      assert.ok(sb.cum.gaugeFlash_mscf > 0 && Math.abs(gf(sb) / gf(sa) - 1) < 0.02, 'gauge flash per STB ' + gf(sa) + ' / ' + gf(sb));
      // direct rate check on route T-202 once LCV-201 has stopped: gauge_vent = po2·Rs(Pu2) (only T-202 transfers)
      let checked = 0;
      const d = mk({ config: cfg });
      d.setFault('xferStuckClosed', true); d.setSurgeRoute('surge2');
      for (let i = 0; i < 4 * 360; i++) {
        d.advance(10);
        const x = d.getState();
        if (x.surge2.transfer.q_bpd > 0 && x.surge.transfer.q_bpd === 0 && x.lines.gauge_vent.q > 0) checked++;
      }
      const sd = st(d);
      assert.ok(checked > 10, 'LCV-202 alone feeds the gauge vent (' + checked + ' samples)');
      balanced(assert, sd, 1e-9, 'gas');
      const I = J(c._internal()).surge2;
      assert.ok(I.cum.xo1 > 0 && I.cum.xo2 > 0, 'transfer totals ' + JSON.stringify(I.cum));
      assert.ok(sc.rates.shrink_pct !== null && isFinite(sc.rates.shrink_pct) && Math.abs(sc.rates.shrink_pct - sa.rates.shrink_pct) < 0.5, 'shrink ' + sa.rates.shrink_pct + ' / ' + sc.rates.shrink_pct);
    },
  },
  {
    name: 'WTSS2 PCV-203 holds the set point ± 1 psi; the flare header gets PCV-203 + PSV-202 (flare node, cum.flare, qgFlare trend)',
    wp: WP, opts: false,
    run(app, assert) {
      const sim = mk({ config: { noise: { on: false } } });
      sim.setSurgeRoute('surge2');
      run(sim, 1800, 5);
      // PCV-203 against the dump cycles: mean deviation within 1 psi, peak no worse than PCV-201 on T-201 (+0.5 psi)
      const ref = mk({ config: { noise: { on: false } } });
      run(ref, 1800, 5);
      let dev = 0, sum = 0, n = 0, vent = 0, dev1 = 0;
      for (let i = 0; i < 720; i++) {
        sim.advance(5); ref.advance(5);
        const x = sim.getState(), y = ref.getState(), d = Math.abs(x.surge2.P - x.surge2.SPeff);
        dev = Math.max(dev, d); sum += d; n++; vent = Math.max(vent, x.lines.surge2_vent.q);
        dev1 = Math.max(dev1, Math.abs(y.surge.P - y.surge.SPeff));
      }
      assert.ok(sum / n <= 1 && dev <= dev1 + 0.5, 'mean deviation ' + sum / n + ', peak ' + dev + ' (T-201 ' + dev1 + ')');
      assert.ok(vent > 0, 'PCV-203 vents');
      const s = st(sim);
      assert.ok(s.nodes.flare.qMMscfd >= s.lines.surge2_vent.q - 1e-12, 'flare node includes PCV-203');
      const h = J(sim.getHistory('qgFlare'));
      assert.ok(h.y.length > 0 && h.y.every((y) => isFinite(y)), 'qgFlare');
      balanced(assert, s, 1e-9, 'PCV-203');
    },
  },
  {
    name: 'WTSS2 PCV-203 stuck closed: PAH-202 → PSHH-202 closes XV-202, holds PCV-204 shut, trips the ESD (and blocks its reset); removal while tripped lets resetESD succeed',
    wp: WP, opts: false,
    run(app, assert) {
      const sim = mk();
      sim.setFault('bpv2StuckClosed', true); sim.setSurgeRoute('surge2');
      const seen = {};
      assert.ok(run(sim, 4 * 3600, 2, (x) => { x.alarms.forEach((a) => { if (!(a.id in seen)) seen[a.id] = x.t; }); return x.esd.tripped; }), 'ESD');
      let s = st(sim);
      assert.ok(seen.PSH_SURGE2 < seen.PSHH_SURGE2, 'PAH-202 before PSHH-202 ' + JSON.stringify(seen));
      assert.strictEqual(s.esd.cause, 'PSHH_SURGE2');
      assert.ok(!s.surge2.inlet && s.surge2.blanket.held && s.surge2.blanket.u === 0, 'XV-202 shut, PCV-204 held shut');
      assert.ok(s.alarmLog.some((l) => /PSHH-202 trip, fail-safe/.test(l.msg)), 'logged fail-safe');
      assert.ok(s.esd.blocking.indexOf('PSHH_SURGE2') >= 0, 'PSHH-202 blocks the reset while active');
      assert.strictEqual(J(sim.resetESD()).ok, false, 'reset refused while PSHH-202 is active');
      assert.strictEqual(sim.setRigup({ surge2: false }), true, 'T-202 removed');
      s = st(sim);
      assert.ok(!active(s, 'PSHH_SURGE2') && s.esd.blocking.indexOf('PSHH_SURGE2') < 0, 'released on removal');
      run(sim, 30, 5);
      const r = J(sim.resetESD());
      assert.ok(r.ok, 'resetESD after the removal ' + JSON.stringify(r));
      balanced(assert, st(sim), 1e-9, 'PSHH-202');
    },
  },
  {
    name: 'WTSS2 PSV-202: Cv_psvU2 relieves every sizing case at 1.10·MAWP; oilDumpStuckOpen on route T-202 keeps Pu2 ≤ 1.10·MAWP throughout',
    wp: WP, opts: false,
    run(app, assert) {
      const sim = mk();
      const I = J(sim._internal()).surge2, P = I.psv;
      assert.ok(P && P.capAtRelief > 0, 'sizing case ' + JSON.stringify(P));
      assert.strictEqual(P.Qreq, Math.max(P.blowby, P.blanket, P.flash, P.min), 'Qreq = the largest case');
      ['blowby', 'blanket', 'flash', 'min'].forEach((k) => assert.ok(P.capAtRelief >= P[k] * (1 - 1e-9), k + ' relieved'));
      assert.near(P.Prel_psia, 1.10 * P.mawp + 14.696, 1e-9, 'relief pressure');
      assert.strictEqual(st(sim).surge2.psv.Cv, J(sim._internal()).Cv.psvU2, 'snapshot Cv');
      const s2 = mk();
      s2.setFault('oilDumpStuckOpen', true); s2.setFault('bpv2StuckClosed', true); s2.setSurgeRoute('surge2');
      let maxR = 0, lifted = false;
      run(s2, 2 * 3600, 1, (x) => { maxR = Math.max(maxR, x.surge2.P / (1.10 * x.surge2.mawp)); if (x.surge2.psv.lifting) lifted = true; return false; });
      assert.ok(maxR <= 1, 'Pu2 / (1.10·MAWP) ≤ 1: ' + maxR);
      assert.ok(lifted || st(s2).esd.tripped, 'PSV-202 lifted or PSHH-202 stopped the inflow');
      balanced(assert, st(s2), 1e-9, 'PSV-202');
    },
  },
  {
    name: 'WTSS2 faults: xfer2StuckClosed → XFER2_FAIL; FAULTS lists both T-202 faults with their labels',
    wp: WP, opts: false,
    run(app, assert) {
      const S = eng();
      const f = J(S.FAULTS);
      assert.strictEqual(f.find((x) => x.id === 'xfer2StuckClosed').label, 'LCV-202 stuck closed');
      assert.strictEqual(f.find((x) => x.id === 'bpv2StuckClosed').label, 'PCV-203 stuck closed');
      const sim = mk({ sim: { surge2Cap_bbl: 20 } });
      sim.setFault('xfer2StuckClosed', true); sim.setSurgeRoute('surge2');
      assert.ok(run(sim, 3600, 5, (x) => active(x, 'XFER2_FAIL')), 'XFER2_FAIL');
      const s = st(sim);
      assert.ok(s.surge2.transfer.failed && s.surge2.transfer.q_bpd === 0 && s.surge2.frac >= 0.69, 'stuck: no flow at LSH');
      sim.setFault('xfer2StuckClosed', false);
      run(sim, 120, 5);
      assert.ok(!active(st(sim), 'XFER2_FAIL') && st(sim).surge2.transfer.q_bpd > 0, 'cleared');
    },
  },
  {
    name: 'WTSS2 out of the rig-up with liquid: inventory frozen, balances hold, back in with the same inventory (XV-202 shut)',
    wp: WP, opts: false,
    run(app, assert) {
      const sim = mk({ config: { noise: { on: false } } });
      sim.setFault('xfer2StuckClosed', true); sim.setSurgeRoute('both');
      run(sim, 1800, 5);
      sim.setSurgeRoute('surge'); run(sim, 60, 5);
      const before = J(sim._internal()).surge2.inv;
      assert.ok(before.oil > 0, 'T-202 holds oil');
      assert.strictEqual(sim.setRigup({ surge2: false }), true);
      let s = st(sim);
      assert.ok(!s.surge2.inRig && s.surge2.frac === 0 && s.surge2.route === 'surge', 'static values while out');
      run(sim, 1800, 10);
      s = st(sim);
      balanced(assert, s, 1e-9, 'out');
      assert.deepStrictEqual(J(sim._internal()).surge2.inv, before, 'inventory frozen');
      assert.strictEqual(sim.setRigup({ surge2: true }), true);
      s = st(sim);
      assert.ok(s.surge2.inRig && !s.surge2.inlet && Math.abs(s.surge2.Vo_stb - before.oil) < 1e-12, 'back with the same inventory, XV-202 shut');
      run(sim, 600, 10);
      balanced(assert, st(sim), 1e-9, 'back in');
    },
  },
  {
    name: 'WTSS2 T-202 leaving as the only route snaps XV-201A/B open (logged); with both T-201 compartments at LSHH-201 the removal is refused with the note',
    wp: WP, opts: false,
    run(app, assert) {
      const sim = mk();
      sim.setSurgeRoute('surge2'); run(sim, 60, 5);
      assert.strictEqual(st(sim).surge2.route, 'surge2');
      const ev = []; sim.on('rigup', (e) => ev.push(e.msg));
      assert.strictEqual(sim.setRigup({ surge2: false }), true);
      let s = st(sim);
      assert.ok(s.surge.comps[0].inlet && s.surge.comps[1].inlet && s.surge.comps[0].pos === 1, 'XV-201A/B snapped open');
      assert.ok(ev.length === 1 && ev[0].indexOf(X.RIG_NOTES.surge2LeftLog) >= 0, 'rig-up message ' + ev[0]);
      assert.ok(s.alarmLog.some((l) => l.id === 'ROUTE' && l.msg === X.RIG_NOTES.surge2LeftLog), 'ROUTE log');
      run(sim, 300, 5);
      assert.ok(!active(st(sim), 'SURGE_BLOCKED'), 'dumps into T-201');
      // both compartments at LSHH-201 (LCV-201 stuck, small T-201): LSHH-201 shuts XV-201A/B and the well; T-202 the only route
      const b = mk({ sim: { surgeCap_bbl: 20 } });
      b.setFault('xferStuckClosed', true); b.setSurgeRoute('both');
      assert.ok(run(b, 4 * 3600, 5, (x) => !x.surge.comps[0].inlet && !x.surge.comps[1].inlet), 'T-201 inlets shut at LSHH-201');
      s = st(b);
      assert.ok(s.surge2.inlet, 'XV-202 still open');
      assert.strictEqual(b.setRigup({ surge2: false }), false, 'refused');
      s = st(b);
      assert.ok(s.surge2.inRig && s.rigup.refused === X.RIG_NOTES.surge2OnlyRouteRefused, 'refused note ' + s.rigup.refused);
      assert.ok(s.alarmLog.some((l) => l.id === 'RIGUP' && /refused/.test(l.msg)), 'refusal logged');
      // opening the way (XV-202 shut by the operator) clears the refusal note on the next refresh
      b.setValve('surge2', 0, false); b.advance(10);
      assert.strictEqual(st(b).rigup.refused, '', 'refusal no longer applies');
    },
  },
  {
    name: 'WTSS2 auto route at SP: T-201 full → T-202; T-202 full → back to T-201 with room; LAH_SURGE_BOTH suppressed while the auto route has room; LAH_SURGE_ALL when all are high',
    wp: WP, opts: false, timeoutMs: 300000,
    run(app, assert) {
      const sim = mk({ sim: { surgeCap_bbl: 20 }, config: { noise: { on: false } } });
      sim.setFault('xferStuckClosed', true);
      assert.ok(sim.setAutoDivert('surge2', true) && sim.setAutoDivert('surge', true), 'auto on');
      assert.strictEqual(st(sim).surge2.auto.on, true);
      const ev = []; sim.on('divert', (e) => { if (e.eq === 'surge2') ev.push(e.to); });
      let both = false;
      assert.ok(run(sim, 3 * 3600, 5, (x) => { if (active(x, 'LAH_SURGE_BOTH')) both = true; return x.surge2.route === 'surge2'; }), 'routed to T-202');
      assert.ok(ev[0] === 'surge2' && !both, 'auto route event, LAH_SURGE_BOTH suppressed ' + ev.join());
      // back: LCV-201 works again (T-201 drains), LCV-202 stuck (T-202 fills to SP)
      sim.setFault('xferStuckClosed', false); sim.setFault('xfer2StuckClosed', true);
      assert.ok(run(sim, 4 * 3600, 5, (x) => x.surge2.route === 'surge'), 'routed back to T-201');
      assert.strictEqual(ev[ev.length - 1], 'surge');
      // all high: T-201 and T-202 full and nowhere to go
      const a = mk({ sim: { surgeCap_bbl: 20, surge2Cap_bbl: 20 }, config: { noise: { on: false } } });
      a.setFault('xferStuckClosed', true); a.setFault('xfer2StuckClosed', true);
      a.setAutoDivert('surge', true); a.setAutoDivert('surge2', true, { sp: 0.6 });
      assert.ok(run(a, 4 * 3600, 5, (x) => active(x, 'LAH_SURGE_ALL')), 'LAH_SURGE_ALL');
      const s = st(a);
      assert.ok(s.alarms.find((x) => x.id === 'LAH_SURGE_ALL').tag === 'LAH-202', 'tag');
      // with the auto route off, LAH_SURGE_BOTH suggests routing to T-202
      const o = mk({ sim: { surgeCap_bbl: 20 }, config: { noise: { on: false } } });
      o.setFault('xferStuckClosed', true); o.setAutoDivert('surge', true);
      assert.ok(run(o, 3 * 3600, 5, (x) => active(x, 'LAH_SURGE_BOTH')), 'LAH_SURGE_BOTH');
      assert.ok(/route the dumps to T-202/.test(st(o).alarms.find((x) => x.id === 'LAH_SURGE_BOTH').msg), 'text');
    },
  },
  {
    name: 'WTSS2 controls: v3.3 prefs keep the defaults; saved inlet:true restores XV-202 open at session start; adding T-202 from the card snaps it shut',
    wp: WP, opts: false,
    run(app, assert) {
      const S = eng();
      const a = mk();
      a.setControls({ surge: X.CONTROLS_DEFAULT.surge, gauge: X.CONTROLS_DEFAULT.gauge, v: 1 }, { initial: true });
      assert.strictEqual(JSON.stringify(a.getControls()), X.CONTROLS_DEFAULT_JSON, 'v3.3 prefs');
      const c = J(a.getControls()); c.surge2.inlet = true; c.surge2.strokeS = 4;
      const b = mk();
      b.setControls(c, { initial: true });
      let s = st(b);
      assert.ok(s.surge2.inlet && s.surge2.pos === 1 && s.surge2.route === 'both' && s.surge2.strokeS === 4, 'restored open ' + s.surge2.route);
      assert.deepStrictEqual(J(b.getControls()), c, 'round trip');
      const d = S.create(S.SAMPLE_FLOW, { seed: 3 });
      d.setControls(c, { initial: true });
      d.advance(60);
      assert.strictEqual(d.setRigup({ surge2: true }), true);
      s = st(d);
      assert.ok(s.surge2.inRig && !s.surge2.inlet && s.surge2.pos === 0, 'added from the card: XV-202 shut');
      // later setControls (not initial) operates XV-202 through its valve
      assert.ok(d.setControls({ surge2: { inlet: true } }) && st(d).surge2.inlet, 'setControls opens XV-202');
      // XV-202 options
      assert.ok(d.setValveOptions('surge2', { strokeS: 0 }) && st(d).surge2.pos === 1, 'stroke 0 snaps');
      assert.strictEqual(d.setValveOptions('surge2', { strokeS: 0 }), false, 'unchanged');
    },
  },
  {
    name: 'WTSS2 no gauge tank in the rig-up: LCV-202 transfers to the export line',
    wp: WP, opts: false,
    run(app, assert) {
      const sim = mk({ rigup: { gauge: false }, sim: { surge2Cap_bbl: 20 } });
      sim.setSurgeRoute('surge2');
      let q = 0;
      run(sim, 3600, 5, (x) => { q = Math.max(q, x.surge2.transfer.q_bpd); return false; });
      const s = st(sim);
      assert.ok(s.surge2.transfer.dest === 'export' && q > 0, 'export ' + q);
      assert.ok(s.cum.drainedOil_stb > 0 && s.cum.gaugeOil_stb === 0, 'to export');
      balanced(assert, s, 1e-9, 'export');
    },
  },
  {
    name: 'WTSS2 resize (setConfig surge2.cap_bbl) keeps the fraction and pressure; history keys surge2Frac / surge2P follow T-202 and read 0 while out',
    wp: WP, opts: false,
    run(app, assert) {
      const sim = mk({ config: { noise: { on: false } } });
      sim.setFault('xfer2StuckClosed', true); sim.setSurgeRoute('surge2');
      run(sim, 900, 5);
      const s0 = st(sim);
      sim.setConfig({ surge2: { cap_bbl: 200 } });
      const s1 = st(sim);
      assert.ok(s1.surge2.cap_bbl === 200 && Math.abs(s1.surge2.frac - s0.surge2.frac) < 1e-9 && Math.abs(s1.surge2.P - s0.surge2.P) < 0.05, 'resize ' + s0.surge2.frac + ' → ' + s1.surge2.frac);
      run(sim, 300, 5);
      const h = J(sim.getHistory('surge2Frac')), p = J(sim.getHistory('surge2P'));
      assert.ok(h.y[h.y.length - 1] > 0 && Math.abs(p.y[p.y.length - 1] - st(sim).surge2.P) < 1, 'history follows T-202');
      sim.setSurgeRoute('surge'); run(sim, 60, 5);
      sim.setRigup({ surge2: false }); run(sim, 120, 5);
      const h2 = J(sim.getHistory('surge2Frac'));
      assert.strictEqual(h2.y[h2.y.length - 1], 0, 'out → 0');
    },
  },
  {
    name: 'WTSS2 T-202 in standby (XV-202 shut) leaves the T-201 / separator numbers as with T-202 out',
    wp: WP, opts: false,
    run(app, assert) {
      const S = eng();
      const a = S.create(S.SAMPLE_FLOW, { seed: 5 }), b = mk({ seed: 5 });
      for (let i = 0; i < 360; i++) { a.advance(10); b.advance(10); }
      const sa = st(a), sb = st(b);
      assert.near(sb.surge.P, sa.surge.P, 0.01, 'T-201 pressure');
      assert.near(sb.sep.P, sa.sep.P, 0.01, 'separator pressure');
      assert.near(sb.cum.gaugeOil_stb, sa.cum.gaugeOil_stb, 1e-6 * Math.max(1, sa.cum.gaugeOil_stb), 'gauge oil');
      assert.near(sb.cum.flare_mmscf, sa.cum.flare_mmscf, 1e-6 * sa.cum.flare_mmscf, 'flare');
    },
  },
  {
    name: 'WTSS2 in the app built from sources: T-202 routes, snapshot shape and balances',
    wp: WP,
    run(app, assert) {
      const S = app.win.WTS_sim;
      const sim = S.create(S.SAMPLE_FLOW, app.toWin({ seed: 2, rigup: { surge2: true } }));
      assert.ok(sim.setSurgeRoute('both').ok, 'route both');
      for (let i = 0; i < 180; i++) sim.advance(10);
      const s = J(sim.getState());
      assert.ok(s.surge2.route === 'both' && s.surge2.frac > 0, 'filling');
      assert.ok(X.checkShape('surge2', s.surge2, { strict: true }).ok, 'shape');
      balanced(assert, s, 1e-9, 'app');
    },
  },
];
