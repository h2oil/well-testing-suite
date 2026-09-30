// Well Test Simulator — rig-up configuration and the pressure-driven surge → gauge transfer (Round-7: 31-wts-sim,
// 32-wts-3d, 38-wts-live).
//   • T-201 → T-301 has no pump: LCV-201 passes q = Cv·√(ΔP/SG) with ΔP = surge tank pressure + liquid head over the
//     outlet − lift to the gauge tank's top inlet (atmospheric). No flow when the vessel pressure cannot lift the liquid.
//   • P-201 sits downstream of the gauge tank (T-301 → export / burner); without it the compartments drain by gravity.
//   • Rig-up: heater, separator, surge tank, gauge tank, P-201 and the flare can be taken out; the flow path, process
//     calculations, alarms and the snapshot follow, with an explanatory note for every resolved combination; SDV-101
//     and CK-101 stay in (safety-critical / required). Exact mass balance in every configuration.
//   • Live view: a Rig-up card (switches) below the view, persisted in localStorage 'wts_sim_rigup' (travels in project
//     files), shown on the 2D schematic and in the page report.
// Expected values are configuration set points, conservation, hand calculations (valve equation, hydrostatic head,
// heater temperature rise from the steady flow) or event order — never numbers taken from the code under test.
'use strict';

const WP = 'WTSRIG';
const NOISE_OFF = { noise: { on: false } };
const WGRAD = 0.4331;                  // psi/ft of fresh water
const GPM_BPD = 34.2857;               // 1 US gal/min = 34.2857 bbl/d

function sim(app, o, flow) { const S = app.win.WTS_sim; if (!S) throw new Error('WTS_sim missing (round 7 not built?)'); return S.create(flow || S.SAMPLE_FLOW, app.toWin(Object.assign({ seed: 7 }, o || {}))); }
function run(s, secs, dt, cb) { const n = Math.round(secs / dt); for (let i = 0; i < n; i++) { s.advance(dt); if (cb && cb(s.getState(), i) === false) return false; } return true; }
function runUntil(s, maxSec, dt, pred) { for (let i = 0; i < Math.ceil(maxSec / dt); i++) { s.advance(dt); if (pred(s.getState())) return true; } return false; }
function alarmIds(st) { return st.alarms.map((a) => a.id); }
function balanced(assert, st, where) {
  const m = st.health.massErr;
  assert.ok(Math.abs(m.oil) < 1e-9 && Math.abs(m.water) < 1e-9 && Math.abs(m.gas) < 1e-9, where + ': mass balance ' + JSON.stringify(m));
}
function inv(st) {
  return { sepO: st.sep.c1.Vo_stb + st.sep.bucket.Vo_stb, sepW: st.sep.c1.Vw_bbl + st.sep.bucket.Vw_bbl, suO: st.surge.Vo_stb, suW: st.surge.Vw_bbl,
    gO: st.gauge.tanks[0].Vo_stb + st.gauge.tanks[1].Vo_stb, gW: st.gauge.tanks[0].Vw_bbl + st.gauge.tanks[1].Vw_bbl };
}
function openWts(app) {
  const b = app.find('.nav-btn[data-p="wts"]');
  if (!b) throw new Error('no Well Test Simulator sidebar button');
  app.click(b); app.flush(500);
  const L = app.win.WTS_live, s = L && L.getSim && L.getSim();
  if (!s) throw new Error('live simulator did not start');
  return s;
}

module.exports = [
  {
    name: 'WTSRIG LCV-201 surge → gauge transfer runs on the surge tank pressure (no pump): valve equation and hydrostatic ΔP by hand',
    wp: WP,
    run(app, assert) {
      const s = sim(app, { config: NOISE_OFF });
      let st = s.getState();
      assert.strictEqual(st.surge.transfer, st.surge.pump, 'surge.transfer is the legacy surge.pump object');
      assert.strictEqual(st.surge.transfer.tag, 'LCV-201'); assert.strictEqual(st.surge.transfer.mode, 'pressure');
      assert.strictEqual(st.gauge.pump.tag, 'P-201', 'P-201 is downstream of the gauge tank'); assert.strictEqual(st.gauge.pump.dest, 'export');
      assert.ok(runUntil(s, 3600, 5, (x) => x.surge.transfer.q_bpd > 0), 'transfer passes');
      st = s.getState();
      const p = st.surge.transfer;
      // q = Cv·√(ΔP/SG) in gal/min → bbl/d
      assert.near(p.q_bpd, p.Cv * Math.sqrt(p.dP_psi / p.sg) * GPM_BPD, 1e-6 * p.q_bpd, 'valve equation');
      // ΔP = P_surge + ρg·(h_liquid − H_T301 inlet)  (suction A + B: the tank level; the gauge tank is filled from the top)
      const hand = st.surge.P + WGRAD * p.sg * (st.surge.frac * st.surge.H - st.gauge.tanks[0].H);
      assert.near(p.dP_psi, hand, 0.1, 'hydrostatic ΔP by hand (' + hand.toFixed(2) + ' psi)');
      assert.ok(p.dP_psi > 0.9 * st.surge.P, 'most of the driving pressure is the vessel pressure');
      // the discharge reaches the gauge tank (no pump in between) and the batch cycle keeps working
      assert.ok(st.gauge.tanks[0].fill_bpd + st.gauge.tanks[1].fill_bpd > 0, 'gauge tank fills from LCV-201');
      const bs = []; s.on('batch', (b) => bs.push(b));
      run(s, 4 * 3600, 10);
      assert.ok(bs.length >= 1, 'batches recorded: ' + bs.length);
      balanced(assert, s.getState(), 'pressure transfer');
    }
  },
  {
    name: 'WTSRIG no flow when the surge tank pressure cannot lift the liquid to the gauge tank: LCV-201 open, 0 BPD, XFER_LOW_DP; flow resumes once the head is enough',
    wp: WP,
    run(app, assert) {
      const S = app.win.WTS_sim;
      // surge set pressure 0 psig, level control LSH 45 % (below the gauge tank inlet height) → nothing to lift the liquid
      const s = sim(app, { config: Object.assign({ surge: { lsh: 0.45, lsl: 0.2 } }, NOISE_OFF), seed: 9 }, S.flowFromInputs(app.toWin({}), app.toWin({ surgeP_psig: 0 })));
      let st = s.getState();
      const H = st.surge.H, Hg = st.gauge.tanks[0].H;
      assert.ok(0.45 * H < Hg, 'LSH (' + (0.45 * H).toFixed(1) + ' ft) is below the gauge tank inlet (' + Hg.toFixed(1) + ' ft)');
      assert.ok(runUntil(s, 4 * 3600, 5, (x) => x.surge.transfer.x === 1 && x.surge.transfer.q_bpd === 0 && alarmIds(x).indexOf('XFER_LOW_DP') >= 0), 'open, no flow, XFER_LOW_DP');
      st = s.getState();
      const p = st.surge.transfer;
      assert.ok(p.dP_psi <= 0, 'ΔP ≤ 0: ' + p.dP_psi); assert.ok(p.lowDP === true, 'snapshot lowDP');
      assert.ok(/too low/.test(st.alarms.find((a) => a.id === 'XFER_LOW_DP').msg), 'alarm text explains it');
      // with no outflow the surge tank keeps filling until its head alone lifts the liquid: q > 0 only once
      // P_surge + ρg·h > ρg·H_T301  (hand: h > H_T301 − P/(ρg))
      const f0 = st.surge.frac;
      let first = null;
      run(s, 4 * 3600, 5, (x) => { if (x.surge.transfer.q_bpd > 0 && !first) { first = { f: x.surge.frac, P: x.surge.P, sg: x.surge.transfer.sg }; return false; } });
      assert.ok(first, 'flow resumes on head alone');
      assert.ok(first.f > f0, 'the level rose while no liquid could leave');
      const hNeed = Hg - first.P / (WGRAD * first.sg);
      assert.ok(first.f * H >= hNeed - 0.05, 'flow starts only once the head can lift the liquid (' + (first.f * H).toFixed(2) + ' ≥ ' + hNeed.toFixed(2) + ' ft)');
      balanced(assert, s.getState(), 'low ΔP');
    }
  },
  {
    name: 'WTSRIG rig-up rules: SDV-101 / CK-101 always in, flare kept when the separator is out, P-201 needs the gauge tank; notes explain every resolved combination',
    wp: WP,
    run(app, assert) {
      const S = app.win.WTS_sim;
      assert.deepStrictEqual(JSON.parse(JSON.stringify(S.RIG_KEYS)), ['esd', 'choke', 'heater', 'separator', 'surge', 'gauge', 'pump', 'flare']);
      assert.ok(S.RIGUP.filter((it) => it.locked).map((it) => it.key).join() === 'esd,choke', 'locked items');
      const n = S.normRigup(app.toWin({ esd: false, choke: false, separator: false, flare: false, gauge: false }));
      assert.ok(n.rig.esd && n.rig.choke, 'ESD and choke stay in');
      assert.ok(n.rig.flare && !n.rig.separator, 'flare kept: the well stream needs somewhere to go');
      assert.ok(!n.rig.gauge && !n.rig.pump, 'P-201 is out with the gauge tank');
      const txt = n.notes.join(' | ');
      assert.ok(/safety-critical/.test(txt) && /nowhere to go/.test(txt) && /only empties the gauge tank/.test(txt) && /straight to the flare/.test(txt), txt);
      const s = sim(app, { config: NOISE_OFF });
      assert.strictEqual(s.setRigup(app.toWin({ esd: false })), true, 'request recorded');
      let st = s.getState();
      assert.strictEqual(st.rigup.esd, true, 'effective ESD stays in'); assert.strictEqual(s.getRigup().esd, false, 'request kept');
      assert.strictEqual(st.rigup.full, true, 'still the full rig-up');
      assert.strictEqual(s.setRigup(app.toWin({ esd: null })), true, 'null restores an item');
      assert.strictEqual(s.setRigup(app.toWin({ esd: true })), false, 'no change → false');
      assert.strictEqual(s.setRigup(null), false, 'bad input ignored');
      // default = full rig-up, no notes (existing behaviour)
      st = s.getState();
      assert.ok(st.rigup.full && st.rigup.sig === '11111111' && st.rigup.notes.length === 0 && st.rates.separated === true, 'default full rig-up');
    }
  },
  {
    name: 'WTSRIG separator out: the well stream goes to the flare / burner, no separation readings, the tanks receive nothing; exact balance',
    wp: WP,
    run(app, assert) {
      const S = app.win.WTS_sim, F = S.SAMPLE_FLOW;
      const s = sim(app, { config: NOISE_OFF, rigup: { separator: false } });
      run(s, 600, 5);
      const a = inv(s.getState()), c0 = s.getState().cum;
      const l0 = c0.liquidToFlareOil_stb, oi0 = c0.oilIn_stb, s0 = s.getState().surge;
      run(s, 1800, 5);
      const st = s.getState(), b = inv(st);
      assert.strictEqual(st.rates.separated, false, 'rates flagged as not separated');
      assert.strictEqual(st.sep.gasIn_mmscfd, 0, 'nothing enters V-101');
      assert.near(b.sepO, a.sepO, 1e-9, 'V-101 oil blocked in'); assert.near(b.sepW, a.sepW, 1e-9, 'V-101 water blocked in');
      assert.near(st.cum.liquidToFlareOil_stb - l0, st.cum.oilIn_stb - oi0, 1e-6, 'all well oil to the burner');
      assert.near(st.nodes.flare.qMMscfd, F.inputs.Qg * st.f, 0.02 * F.inputs.Qg, 'flare takes the well gas');
      assert.ok(st.surge.comps.every((c) => c.fill_bpd === 0), 'no liquid reaches T-201');
      assert.ok(st.surge.Vo_stb <= s0.Vo_stb + 1e-9, 'surge tank only empties');
      assert.ok(!st.esd.tripped, 'no trip');
      assert.ok(st.rigup.notes.some((m) => /straight to the flare/.test(m)), 'note explains the clean-up routing');
      assert.ok(st.nodes.choke.P < 100, 'choke outlet now sees the flare line pressure (' + st.nodes.choke.P.toFixed(1) + ' psig)');
      balanced(assert, st, 'separator out');
    }
  },
  {
    name: 'WTSRIG surge tank out: V-101 dumps straight into the atmospheric gauge tank (flash vents there); gauge tank out: LCV-201 to the export line; both out: dumps to export',
    wp: WP,
    run(app, assert) {
      // surge out
      let s = sim(app, { config: NOISE_OFF, rigup: { surge: false } });
      run(s, 300, 5);
      let a = inv(s.getState()), c = s.getState().cum;
      const gv0 = c.gaugeVent_mscf, go0 = c.gaugeOil_stb;
      const bs = []; s.on('batch', (p) => bs.push(p));
      run(s, 3 * 3600, 10);
      let st = s.getState(), b = inv(st);
      assert.near(b.suO, a.suO, 1e-9, 'T-201 oil unchanged'); assert.near(b.suW, a.suW, 1e-9, 'T-201 water unchanged');
      assert.ok(st.cum.gaugeOil_stb - go0 > 100, 'gauge tank receives the separator oil');
      assert.ok(st.cum.gaugeVent_mscf > gv0, 'solution gas vents at the gauge tank');
      assert.ok(bs.length >= 1, 'batches still recorded');
      assert.strictEqual(st.surge.transfer.inRig, false); assert.strictEqual(st.surge.transfer.q_bpd, 0, 'no transfer');
      assert.ok(!st.esd.tripped, 'no trip: ' + st.esd.cause);
      assert.ok(st.rigup.notes.some((m) => /atmospheric gauge tank/.test(m)), 'note');
      balanced(assert, st, 'surge out');
      // gauge out
      s = sim(app, { config: NOISE_OFF, rigup: { gauge: false } });
      a = inv(s.getState()); c = s.getState().cum;
      const d0 = c.drainedOil_stb, n0 = s.getState().gauge.batches.length;
      run(s, 3 * 3600, 10);
      st = s.getState(); b = inv(st);
      assert.near(b.gO, a.gO, 1e-9, 'gauge tank oil frozen'); assert.near(b.gW, a.gW, 1e-9, 'gauge tank water frozen');
      assert.ok(st.cum.drainedOil_stb - d0 > 100, 'LCV-201 transfers to the export / burner line');
      assert.strictEqual(st.surge.transfer.dest, 'export');
      assert.strictEqual(st.gauge.batches.length, n0, 'no tank batches');
      assert.strictEqual(st.gauge.pump.mode, 'none'); assert.strictEqual(st.rigup.pump, false, 'P-201 out with the gauge tank');
      assert.ok(!st.esd.tripped, 'no trip: ' + st.esd.cause);
      balanced(assert, st, 'gauge out');
      // both out
      s = sim(app, { config: NOISE_OFF, rigup: { surge: false, gauge: false } });
      c = s.getState().cum;
      const e0 = c.drainedOil_stb, i0 = c.oilIn_stb;
      run(s, 2 * 3600, 10);
      st = s.getState();
      assert.ok(st.cum.drainedOil_stb - e0 > 0.8 * (st.cum.oilIn_stb - i0), 'separator oil goes to the export line');
      assert.ok(!st.esd.tripped, 'no trip: ' + st.esd.cause);
      assert.ok(st.rigup.notes.some((m) => /No surge or gauge tank/.test(m)), 'note');
      balanced(assert, st, 'both tanks out');
    }
  },
  {
    name: 'WTSRIG heater out (no temperature rise — hand check from the steady flow), P-201 out (gravity drain ∝ √level), flare out (no flame, gas to export)',
    wp: WP,
    run(app, assert) {
      const S = app.win.WTS_sim, F = S.SAMPLE_FLOW;
      // heater: separator temperature falls by the heater rise (steady flow: heater Tout − Tin)
      const s0 = sim(app, { config: NOISE_OFF }), s1 = sim(app, { config: NOISE_OFF, rigup: { heater: false } });
      const t0 = s0.getState().sep.T, t1 = s1.getState().sep.T, rise = F.heater.Tout - F.heater.Tin;
      assert.near(t0 - t1, rise, 1e-6, 'separator T drops by the heater rise (' + rise.toFixed(2) + ' °F)');
      let st = s1.getState();
      assert.strictEqual(st.nodes.heater.bypass, true, 'heater node bypassed'); assert.strictEqual(st.nodes.heater.dutyMMBtuHr, 0, 'no duty');
      run(s1, 1800, 10); balanced(assert, s1.getState(), 'heater out');
      // P-201 out: a draining compartment empties by gravity at gravityFrac · design · √level
      const s = sim(app, { config: NOISE_OFF, rigup: { pump: false } });
      const G = S.DEFAULTS.gauge.gravityFrac;
      let seen = null;
      run(s, 5 * 3600, 5, (x) => { const k = x.gauge.tanks.findIndex((t) => t.state === 'draining' && t.drain_bpd > 0); if (k >= 0 && x.gauge.tanks[k].frac > 0.3) { seen = { t: x.gauge.tanks[k], d: x.gauge.pump.design_bpd }; return false; } });
      assert.ok(seen, 'a compartment drains');
      assert.strictEqual(s.getState().gauge.pump.mode, 'gravity');
      assert.near(seen.t.drain_bpd, G * seen.d * Math.sqrt(seen.t.frac), 0.02 * seen.t.drain_bpd, 'gravity drain rate');
      assert.ok(seen.t.drain_bpd < seen.d, 'slower than P-201');
      balanced(assert, s.getState(), 'pump out');
      // flare out
      const sf = sim(app, { config: NOISE_OFF, rigup: { flare: false } });
      run(sf, 600, 10);
      st = sf.getState();
      assert.strictEqual(st.nodes.flare.flame, 0, 'no flame'); assert.ok(st.nodes.flare.qMMscfd > 0.5 * F.inputs.Qg, 'gas still leaves (export line)');
      assert.ok(st.rigup.notes.some((m) => /export \/ sales gas line/.test(m)), 'note');
    }
  },
  {
    name: 'WTSRIG changing the rig-up mid-test: event + log, alarms of the removed equipment clear, latched LSHH-301 released with the gauge tank, exact balance throughout',
    wp: WP,
    run(app, assert) {
      const s = sim(app, { config: Object.assign({ gauge: { settleS: 14400 } }, NOISE_OFF), seed: 11 });
      const ev = []; s.on('rigup', (p) => ev.push(p));
      assert.ok(runUntil(s, 6 * 3600, 10, (x) => alarmIds(x).indexOf('LSHH_GT') >= 0), 'LSHH-301 latched');
      assert.strictEqual(s.getState().surge.transfer.trip, 'LSHH_GT');
      assert.strictEqual(s.setRigup(app.toWin({ gauge: false })), true);
      let st = s.getState();
      assert.strictEqual(ev.length, 1, 'rigup event'); assert.ok(/T-301 out of the rig-up/.test(ev[0].msg) && /LSHH-301 latch released/.test(ev[0].msg), ev[0].msg);
      assert.strictEqual(st.surge.transfer.trip, null, 'transfer no longer held by a tank that left the rig-up');
      assert.ok(['LSHH_GT', 'LAH_GT', 'LAH_GT_BOTH'].every((id) => alarmIds(st).indexOf(id) < 0), 'gauge alarms cleared: ' + alarmIds(st));
      assert.ok(st.alarmLog.some((e) => e.id === 'RIGUP'), 'logged');
      run(s, 1800, 10);
      st = s.getState();
      assert.ok(!st.esd.tripped, 'the transfer to export keeps the surge tank in hand: ' + st.esd.cause);
      balanced(assert, st, 'gauge out mid-test');
      // separator out and back in
      s.setRigup(app.toWin({ separator: false })); run(s, 900, 10);
      s.setRigup(app.toWin({ separator: true, gauge: true })); run(s, 1800, 10);
      st = s.getState();
      assert.ok(st.rigup.full, 'back to the full rig-up'); assert.strictEqual(st.rates.separated, true);
      assert.ok(st.rates.oil_stbd > 0, 'meters read again');
      balanced(assert, st, 'separator out and back');
      // reset keeps the rig-up
      s.setRigup(app.toWin({ heater: false })); s.reset('steady');
      assert.strictEqual(s.getState().rigup.heater, false, 'rig-up kept across reset');
    }
  },
  {
    name: 'WTSRIG live view: Rig-up card switches drive the sim, the 2D schematic shows the bypass, the page report lists the rig-up; saved in wts_sim_rigup and restored after reload',
    wp: WP,
    integration: true,
    run(app, assert, ctx) {
      const live = openWts(app);
      const card = app.el('wtsl_rigup');
      assert.ok(card && card.classList.contains('card'), 'Rig-up card below the live view');
      const sw = (k) => card.querySelector('[data-rig="' + k + '"]');
      ['esd', 'choke', 'heater', 'separator', 'surge', 'gauge', 'pump', 'flare'].forEach((k) => assert.ok(sw(k), 'switch ' + k));
      assert.ok(sw('esd').disabled && sw('choke').disabled, 'ESD / choke locked');
      assert.ok(!sw('heater').disabled && sw('heater').getAttribute('aria-checked') === 'true', 'heater on by default');
      assert.ok(/no pump between the surge tank and the gauge tank/i.test(card.textContent), 'transfer explained');
      // heater and surge tank out from the card
      app.click(sw('heater')); app.click(card.querySelector('[data-rig="surge"]'));
      let st = live.getState();
      assert.strictEqual(st.rigup.heater, false); assert.strictEqual(st.rigup.surge, false);
      assert.strictEqual(st.nodes.heater.bypass, true, 'sim bypasses the heater');
      assert.strictEqual(card.querySelector('[data-rig="heater"]').getAttribute('aria-checked'), 'false', 'switch state');
      const saved = JSON.parse(app.win.localStorage.getItem('wts_sim_rigup') || '{}');
      assert.ok(saved.heater === false && saved.surge === false, 'saved: ' + JSON.stringify(saved));
      assert.ok(card.querySelectorAll('.wtsl-rig-note').length >= 2, 'notes shown');
      // 2D schematic
      const cv = app.el('wts_viz').querySelector('canvas');
      live.advance(5); app.flush(500);
      const texts = app.canvasTexts(cv).join(' | ');
      assert.ok(/NOT IN RIG-UP/.test(texts), '2D shows the removed equipment: ' + texts.slice(0, 300));
      assert.ok(/DUMPS → T-301/.test(texts), '2D draws the bypass');
      // page report: the card is a results section with one row per item
      const model = app.win.collectPageReport(app.el('pgBody'), { charts: false });
      const sec = model.results.concat(model.inputs).find((x) => x.title === 'Rig-up');
      assert.ok(sec, 'report section Rig-up: ' + model.results.map((x) => x.title).join(','));
      const kv = sec.items.filter((i) => i.type === 'kv');
      assert.ok(kv.some((i) => /H-101/.test(i.label) && /Bypassed/.test(i.value)) && kv.some((i) => /T-201/.test(i.label) && /Out of rig-up/.test(i.value)), 'report rows: ' + JSON.stringify(kv));
      // reload: restored
      const app2 = ctx.loadApp({ storage: app.storage });
      try {
        const live2 = openWts(app2);
        const st2 = live2.getState();
        assert.ok(st2.rigup.heater === false && st2.rigup.surge === false && st2.rigup.gauge === true, 'restored after reload');
        const c2 = app2.el('wtsl_rigup');
        app2.click(c2.querySelector('[data-rig-act="all"]'));
        assert.ok(live2.getState().rigup.full, 'restore full rig-up');
        assert.strictEqual(app2.win.localStorage.getItem('wts_sim_rigup'), null, 'full rig-up = no saved key');
      } finally { if (app2.dispose) app2.dispose(); }
      assert.strictEqual(app.consoleErrors().length, 0, 'no console errors: ' + app.consoleErrors().join(' | '));
    }
  }
];
