// Well Test Simulator — DS-101 cyclonic wellhead desander, sand in the well stream and the choke erosion indicator
// (docs/SIM-EQUIPMENT-PLAN.md §4, WP-E1; §9.2 "tests/wts-desander.test.js").
// Expected values: the research checks and worked numbers of plan §4.9 (simeq/anchors.js, anchors-rev.js), the plan's own
// formulas (dump durations τ·ln(P/50), equalise τ·ln(PB/75), flow-back scaling min(1.5, fI)^1.5), the Lee-Gonzalez-Eakin
// function of 16-pvt.js, and the frozen v3.3 engine (tests/_wts-sim-v33.js) for the identity check with DS-101 out.
// Every test builds Round 7 in memory from 31/32/38 (accept-test.js --sources).
'use strict';

const X = require('./_wts-equip-shapes');

const WP = 'WTSDS';
const J = (x) => JSON.parse(JSON.stringify(x));
const NZ = { noise: { on: false } };
const SAND10 = { noise: { on: false }, sand: { pptb: 10 } };

// a sim in the app realm; o = {rig, cfg, flow (test-realm object), seed, edit(flowInAppRealm)}
function mk(app, o) {
  o = o || {};
  const S = app.win.WTS_sim;
  const fl = app.toWin(o.flow || J(S.SAMPLE_FLOW));
  if (o.edit) o.edit(fl);
  return S.create(fl, app.toWin({ seed: o.seed == null ? 3 : o.seed, rigup: o.rig || {}, config: o.cfg || NZ }));
}
function flowOf(app, fn) { const f = J(app.win.WTS_sim.SAMPLE_FLOW); fn(f); return f; }
function adv(sim, secs, dt) { dt = dt || 1; const n = Math.round(secs / dt); for (let i = 0; i < n; i++) sim.advance(dt); }
function ids(st) { return st.alarms.map((a) => a.id); }
function alarm(st, id) { return st.alarms.filter((a) => a.id === id)[0] || null; }
function logOf(st, id) { return st.alarmLog.filter((e) => e.id === id); }
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
// a high-pressure copy of SAMPLE_FLOW (wellhead / ESD / choke inlet near P psig)
function hpFlow(app, P) {
  return flowOf(app, (f) => {
    f.inputs.Pwh = P + 50; f.nodes[0].P = P + 50; f.nodes[1].P = P + 49.5; f.nodes[2].Pci = P + 49; f.choke.Pin = P + 49; f.segs[1].P0 = P + 49.5;
  });
}
// record the 'dump' events of a sim
function dumps(sim) { const ev = []; sim.on('dump', (p) => ev.push({ t: p.t, phase: p.phase, msg: p.msg, auto: p.auto })); return ev; }
function sandIdentities(assert, st, tag) {
  const c = st.sand.cum, d = st.desander.sand, tol = 1e-9 * Math.max(1, c.in_lb);
  assert.near(c.in_lb, c.capt_lb + c.toChoke_lb, tol, tag + ': in = caught + to the choke');
  assert.near(c.capt_lb, d.acc_lb + d.buf_lb + c.dumped_lb, tol, tag + ': caught = accumulator + buffer + dumped');
  assert.near(c.toChoke_lb, c.toSep_lb + c.toFlare_lb, tol, tag + ': to the choke = to V-101 + to the flare');
  assert.ok(st.health.massErr.sand < 1e-9, tag + ': massErr.sand ' + st.health.massErr.sand);
}

module.exports = [
  // ── pure helpers (WTS_sim.sand) against the research checks ──
  {
    name: 'WTSDS helpers: capture table cells, ΔP velocity head, DNV reducer example, C2, mixture sound speed, liquid viscosities',
    wp: WP,
    run(app, assert) {
      const H = app.win.WTS_sim.sand;
      assert.ok(H && Object.isFrozen(H), 'WTS_sim.sand frozen');
      ['etot', 'cut', 'dp', 'erosionReducer', 'muDeadOil', 'muGas', 'c2', 'mixSound'].forEach((k) => assert.fn(H[k], 'sand.' + k));
      // research table (formation PSD 150 µm, σg 2.0, m 2): d50c 25 → 0.985, 40 → 0.945, 75 → 0.803 (± 0.2 %)
      assert.rel(H.etot(25, 150, 2, 2), 0.985, 0.002, 'E(25 µm)');
      assert.rel(H.etot(40, 150, 2, 2), 0.945, 0.002, 'E(40 µm)');
      assert.rel(H.etot(75, 150, 2, 2), 0.803, 0.002, 'E(75 µm)');
      assert.ok(H.etot(1e6, 150, 2, 2) < 1e-3 && H.etot(1e-3, 150, 2, 2) > 0.999, 'E limits');
      assert.rel(H.dp(14.17, 20.7), 3.93, 0.005, 'dp(14.17 lb/ft³, 20.7 ft/s)');
      assert.rel(H.dp(55, 30), 32.1, 0.005, 'dp(55, 30)');
      assert.rel(H.dp(55, 30, 3), 32.1 / 2, 0.005, 'dp with K 3');
      // DNV-RP-O501 reducer: 3-in → 0.5-in, 60 m/s, 150 µm, 300 kg/m³, 100 lb/d → 8.72 mm/yr (research 8.7), ± 1 %
      assert.rel(H.erosionReducer(100, 60, 3 * 0.0254, 0.5 * 0.0254, 150, 300), 8.72, 0.01, 'DNV reducer example');
      assert.strictEqual(H.erosionReducer(0, 60, 0.0762, 0.0127, 150, 300), 0, 'no sand → 0');
      assert.strictEqual(H.erosionReducer(100, 60, 0.0127, 0.0127, 150, 300), 0, 'no area reduction → 0');
      assert.rel(H.c2(150, 300), 150 / (30 * Math.sqrt(300)), 1e-12, 'C2(150 µm, 300 kg/m³)');
      assert.strictEqual(H.c2(5000, 300), 1, 'C2 capped at 1');
      assert.rel(H.cut(1, 103, 30), 25, 1e-12, 'cut size at the reference point = 25 µm');
      assert.rel(H.cut(4, 103, 30), 50, 1e-12, 'cut size ∝ √μ');
      // no liquid term at GVF 1: the gas speed of sound itself; GVF 0: the liquid's
      assert.rel(H.mixSound(1, 5, 1300, 55, 4000), 1300, 1e-12, 'mixSound GVF 1');
      assert.rel(H.mixSound(0, 5, 1300, 55, 4000), 4000, 1e-12, 'mixSound GVF 0');
      const cm = H.mixSound(0.5, 5, 1300, 55, 4000);
      assert.ok(cm > 0 && cm < 1300, 'a bubbly mixture is slower than either phase: ' + cm);
      // §4.9: μo 2.18 cP (API 35, 180 °F), μw 0.36 cP (not exported: the blend 1.88 cP is checked on the sample below)
      assert.rel(H.muDeadOil(35, 180), 2.18, 0.01, 'dead-oil viscosity');
      assert.ok(isFinite(H.muDeadOil(10, -400)) && isFinite(H.muDeadOil(60, 5000)), 'dead-oil viscosity finite at extreme inputs');
    },
  },
  {
    name: 'WTSDS helpers: gas viscosity equals the 16-pvt.js Lee-Gonzalez-Eakin function (three reference states)',
    wp: WP,
    run(app, assert) {
      const H = app.win.WTS_sim.sand, P = app.win.PRiSM_pvt_correlations;
      assert.ok(P && typeof P.mu_g_leeGonzalezEakin === 'function', 'PRiSM_pvt_correlations.mu_g_leeGonzalezEakin');
      [[0.65, 180, 0.904, 3014.7], [0.8, 100, 0.85, 1500], [0.6, 250, 0.97, 400]].forEach((c) => {
        const ref = P.mu_g_leeGonzalezEakin(c[0], c[1], c[2], c[3]);
        assert.ok(ref > 0.005 && ref < 0.05, 'reference value plausible: ' + ref);
        assert.rel(H.muGas(c[0], c[1], c[2], c[3]), ref, 1e-12, 'muGas ' + c.join('/'));
      });
    },
  },
  // ── §4.9 worked numbers on SAMPLE_FLOW ──
  {
    name: 'WTSDS anchors (§4.9): DS-101 in, 10 pptb — v_in, GVF, ρ, ΔP 3.93 psi, μ, cut size 39.8 µm, capture 0.946, C2 passed 0.110, Up 888 ft/s, 23.6 mpy (ok)',
    wp: WP,
    run(app, assert) {
      const sim = mk(app, { rig: { desander: true }, cfg: SAND10 });
      adv(sim, 600, 10);
      const st = J(sim.getState()), d = st.desander, sd = st.sand;
      assert.ok(d.inRig && st.rigup.desander && st.rigup.sig === X.SIG_DEFAULT.slice(0, 8) + '1' + X.SIG_DEFAULT.slice(9), 'DS-101 in: ' + st.rigup.sig);
      assert.rel(d.vIn_fts, 20.7, 0.005, 'v_in');
      assert.near(d.gvf, 0.890, 0.001, 'GVF');
      assert.near(d.rhoMix, 14.17, 0.01, 'ρmix');
      assert.rel(d.dP_psi, 3.93, 0.02, 'ΔP clean');
      assert.rel(d.dPclean_psi, 3.93, 0.02, 'ΔP clean (snapshot)');
      assert.strictEqual(d.carrier, 'liquid', 'liquid carrier');
      assert.near(d.mu_cp, 1.88, 0.01, 'blended carrier viscosity');
      assert.near(d.d50c_um, 39.8, 1, 'cut size');
      assert.near(d.eff, 0.946, 0.005, 'capture (formation PSD)');
      assert.strictEqual(d.rate, 'ok', 'inlet velocity inside the turndown band');
      assert.near(d.sand.in_lbd, 12.0, 1e-9, 'sand in 12.0 lb/d');
      assert.near(d.sand.capt_lbd, 11.35, 0.06, 'caught 11.35 lb/d');
      assert.near(d.sand.out_lbd, 0.646, 0.03, 'to the choke 0.646 lb/d');
      assert.rel(d.sand.cap_lb, 663, 0.002, 'accumulator capacity');
      assert.rel(d.sand.bufCap_lb, 265, 0.002, 'buffer capacity');
      assert.rel(sd.choke.C2, 0.110, 0.03, 'C2 of the passed sand');
      assert.rel(sd.choke.Up_fts, 888, 0.03, 'bean impact velocity');
      assert.rel(sd.choke.erosion_mpy, 23.6, 0.05, 'steel-equivalent erosion, DS-101 in');
      assert.strictEqual(sd.choke.band, 'ok', 'band ok');
      assert.near(sd.choke.warn_mild, 2.0833, 1e-3, 'warn limit 2.08 mil/d');
      assert.near(sd.choke.high_mild, 20.833, 1e-3, 'high limit 20.8 mil/d');
      assert.rel(d.sithp_psi, 3600, 1e-9, 'SITHP estimate 1.2 × 3,000');
      assert.ok(d.sithpEst && d.ratingOK && d.tempOK && d.rating_psi === 10000 && d.tempMax_F === 350, 'rating / temperature class ✓');
      assert.ok(ids(st).filter((i) => /^DES_|^SAND_|^HYD_ds/.test(i)).length === 0, 'no desander / sand alarm on the sample: ' + ids(st).join(','));
      assert.ok(!st.esd.tripped, 'no trip');
    },
  },
  {
    name: 'WTSDS anchors (§4.9): DS-101 out, 10 pptb — all sand to the choke, inlet C2 0.400, 1,594 mpy = 4.36 mil/d (warn), ≈ 68 × the DS-101 case',
    wp: WP,
    run(app, assert) {
      const out = mk(app, { cfg: SAND10 }), inn = mk(app, { rig: { desander: true }, cfg: SAND10 });
      adv(out, 600, 10); adv(inn, 600, 10);
      const so = J(out.getState()), si = J(inn.getState());
      assert.ok(!so.desander.inRig && so.sand.on, 'DS-101 out, sand on');
      assert.near(so.sand.toChoke_lbd, 12, 1e-9, 'all sand to the choke');
      assert.rel(so.sand.choke.C2, 0.400, 0.01, 'inlet mass-weighted C2');
      assert.rel(so.sand.choke.erosion_mpy, 1594, 0.05, 'erosion, DS-101 out');
      assert.rel(so.sand.choke.erosion_mild, 4.36, 0.05, 'mil/d');
      assert.strictEqual(so.sand.choke.band, 'warn', 'band warn');
      assert.within(so.sand.choke.erosion_mpy / si.sand.choke.erosion_mpy, 60, 76, 'ratio out / in');
      assert.ok(so.sand.choke.loss_mil > si.sand.choke.loss_mil && si.sand.choke.loss_mil > 0, 'cumulative loss');
      assert.ok(ids(so).indexOf('SAND_CHOKE') >= 0 && alarm(so, 'SAND_CHOKE').sev === 'warn', 'SAND_CHOKE warn (12 lb/d > 5)');
      assert.strictEqual(so.desander.dP_psi, 0, 'no desander ΔP while out');
    },
  },
  {
    name: 'WTSDS anchors (§4.9): flow-back proppant (400 µm, σg 1.5) — capture 0.99998, inlet C2 0.822 out, passed C2 0.230 in',
    wp: WP,
    run(app, assert) {
      const inn = mk(app, { rig: { desander: true } }), out = mk(app, {});
      inn.setFault('sandFlowback', true); out.setFault('sandFlowback', true);
      adv(inn, 60, 10); adv(out, 60, 10);
      const si = J(inn.getState()), so = J(out.getState());
      assert.near(si.desander.eff, 0.99998, 2e-5, 'flow-back capture');
      assert.rel(so.sand.choke.C2, 0.822, 0.01, 'inlet C2 (flow-back)');
      assert.rel(si.sand.choke.C2, 0.230, 0.03, 'passed C2 (flow-back)');
      assert.ok(si.sand.flowback.on && si.sand.flowback.d50_um === 400 && si.sand.flowback.sigmaG === 1.5, 'flow-back block');
      assert.near(si.sand.flowback.t_h, 60 / 3600, 1e-9, 'flow-back clock');
      assert.ok(si.sand.choke.band === 'ok' && so.sand.choke.band === 'high', 'bands in ' + si.sand.choke.band + ' / out ' + so.sand.choke.band);
    },
  },
  // ── robustness ──
  {
    name: 'WTSDS finite walk: dry gas (Qo = Qw = 0, 5 lb/MMscf) uses the gas carrier, nothing non-finite anywhere',
    wp: WP,
    run(app, assert) {
      const S = app.win.WTS_sim;
      const sim = mk(app, { rig: { desander: true }, cfg: { noise: { on: false }, sand: { lbPerMMscf: 5 } }, flow: flowOf(app, (f) => { f.inputs.Qo = 0; f.inputs.Qw = 0; }) });
      sim.setFault('sandFlowback', true);
      for (let i = 0; i < 72; i++) {
        sim.advance(50);
        const bad = finiteBad(J(sim.getState()), J(S.NULLABLE));
        assert.ok(bad.length === 0, 'finite at ' + (i + 1) * 50 + ' s: ' + bad.slice(0, 5).join(', '));
      }
      const st = J(sim.getState());
      assert.strictEqual(st.desander.carrier, 'gas', 'gas carrier');
      assert.within(st.desander.mu_cp, 0.01, 0.04, 'gas viscosity');
      assert.within(st.desander.eff, 0, 1, 'capture');
      assert.near(st.desander.gvf, 1, 1e-12, 'GVF 1');
      assert.ok(st.sand.in_lbd > 50, 'gas sand term 5 lb/MMscf × 10 MMscf/d + flow-back: ' + st.sand.in_lbd);
      sandIdentities(assert, st, 'dry gas');
    },
  },
  {
    name: 'WTSDS finite walk: zero rate (segs[1].vel = 0) skips the desander block (ΔP 0, capture 0); 1e400 in flow.sim and huge setConfig values are clamped',
    wp: WP,
    run(app, assert) {
      const S = app.win.WTS_sim;
      const z = mk(app, { rig: { desander: true }, cfg: SAND10, flow: flowOf(app, (f) => { f.segs[1].vel = 0; }) });
      z.setFault('sandFlowback', true);
      adv(z, 1200, 10);
      const sz = J(z.getState());
      assert.ok(finiteBad(sz, J(S.NULLABLE)).length === 0, 'finite: ' + finiteBad(sz, J(S.NULLABLE)).slice(0, 5).join(', '));
      assert.ok(sz.desander.dP_psi === 0 && sz.desander.eff === 0 && sz.desander.vIn_fts === 0, 'ΔP / capture / velocity 0');
      assert.strictEqual(sz.sand.in_lbd, 0, 'nothing flows through the skipped block');
      // Infinity (typed as 1e400) through flow.sim never gets through
      const inf = mk(app, { rig: { desander: true }, edit: (f) => { f.sim.sand_pptb = Infinity; f.sim.desAcc_gal = Infinity; f.sim.sithp_psig = Infinity; f.sim.sand_d50_um = Infinity; } });
      adv(inf, 60, 10);
      const si = J(inf.getState());
      assert.ok(finiteBad(si, J(S.NULLABLE)).length === 0, 'finite with Infinity inputs');
      assert.ok(si.sand.pptb >= 0 && si.sand.pptb <= 500 && si.sand.d50_um >= 20 && si.sand.d50_um <= 1000, 'sand inputs in range');
      assert.within(si.desander.sand.cap_lb, 10 * 0.133681 * 99.24 - 1, 200 * 0.133681 * 99.24 + 1, 'accumulator in range');
      // setConfig values are clamped to the §6.3 ranges in derive()
      const c = mk(app, { rig: { desander: true } });
      c.setConfig(app.toWin({ sand: { pptb: 1e6, d50_um: 5, lbPerMMscf: -3 }, desander: { acc_gal: 1e4, rating_psi: 7000, sithp_psig: 1e9 } }));
      adv(c, 20, 10);
      const sc = J(c.getState());
      assert.strictEqual(sc.sand.pptb, 500, 'pptb clamped to 500');
      assert.strictEqual(sc.sand.d50_um, 20, 'd50 clamped to 20 µm');
      assert.strictEqual(sc.sand.lbPerMMscf, 0, 'gas sand rate clamped to 0');
      assert.rel(sc.desander.sand.cap_lb, 200 * 0.133681 * 165.4 * 0.6, 1e-9, 'accumulator clamped to 200 gal');
      assert.strictEqual(sc.desander.rating_psi, 10000, 'a rating outside the three classes → 10,000');
      assert.strictEqual(sc.desander.sithp_psi, 20000, 'SITHP clamped to 20,000 psig');
    },
  },
  // ── pressures ──
  {
    name: 'WTSDS pressures: choke inlet = ESD node − ΔP (± 0.05 psi after 60 s), segs[1].P0 = ESD node, no ESD-node spike when the bypass toggles (< 0.1 psi)',
    wp: WP,
    run(app, assert) {
      const sim = mk(app, { rig: { desander: true }, cfg: SAND10 });
      adv(sim, 60, 1);
      let st = J(sim.getState());
      assert.near(st.nodes.esd.P - st.nodes.choke.Pin, st.desander.dP_psi, 0.05, 'ESD − choke inlet = ΔP');
      assert.ok(st.desander.dP_psi > 3.5, 'ΔP established: ' + st.desander.dP_psi);
      assert.strictEqual(st.segs[1].P0, st.nodes.esd.P, 'segs[1].P0 = ESD node');
      assert.strictEqual(st.nodes.desander.Pin, st.nodes.esd.P, 'desander inlet = ESD node');
      assert.strictEqual(st.nodes.desander.P, st.nodes.choke.Pin, 'desander outlet = choke inlet');
      assert.near(st.desander.Pin - st.desander.Pout, st.desander.dP_psi, 1e-9, 'Pin − Pout = ΔP');
      // the out case: the ESD node of the legacy law equals the DS-101 case's upstream node (same law)
      const out = mk(app, { cfg: SAND10 }); adv(out, 60, 1);
      assert.near(J(out.getState()).nodes.esd.P, st.nodes.esd.P, 1e-6, 'ESD node unchanged by DS-101');
      const e0 = st.nodes.esd.P;
      let mx = 0, ckMin = Infinity, ckMax = -Infinity;
      assert.strictEqual(sim.setDesander(app.toWin({ bypass: true })), true, 'bypass on');
      for (let i = 0; i < 120; i++) { sim.advance(1); st = sim.getState(); mx = Math.max(mx, Math.abs(st.nodes.esd.P - e0)); ckMin = Math.min(ckMin, st.nodes.choke.Pin); ckMax = Math.max(ckMax, st.nodes.choke.Pin); }
      assert.ok(J(sim.getState()).desander.dP_psi < 1e-6, 'bypassed: ΔP → 0');
      assert.strictEqual(sim.setDesander(app.toWin({ bypass: false })), true, 'bypass off');
      for (let i = 0; i < 120; i++) { sim.advance(1); st = sim.getState(); mx = Math.max(mx, Math.abs(st.nodes.esd.P - e0)); }
      assert.ok(mx < 0.1, 'ESD node deviation ' + mx);
      assert.ok(ckMax - ckMin > 3 && ckMax - ckMin < 4.5, 'the choke inlet moves smoothly by the ΔP: ' + (ckMax - ckMin));
      assert.rel(J(sim.getState()).desander.dP_psi, 3.93, 0.02, 'back in line');
    },
  },
  // ── sand accounting ──
  {
    name: 'WTSDS sand balance: three identities exact through flow-back, a dump and a bypass; flow-back reaches LAH-103 at 3.50 h ± 5 %',
    wp: WP,
    timeoutMs: 300000,
    run(app, assert) {
      const sim = mk(app, { rig: { desander: true }, cfg: SAND10 });
      let tLAH = null;
      sim.on('alarm', (p) => { if (p.id === 'DES_LAH' && tLAH === null) tLAH = p.t; });
      sim.setFault('sandFlowback', true);
      for (let i = 0; i < 4 * 36; i++) { sim.advance(100); if (i % 12 === 0) sandIdentities(assert, J(sim.getState()), 't ' + sim.getState().t); }
      assert.ok(tLAH !== null, 'LAH-103 raised');
      assert.rel(tLAH / 3600, 3.5, 0.05, 'time to LAH-103 (h)');
      let st = J(sim.getState());
      assert.ok(alarm(st, 'DES_LAH').sev === 'alarm' && !st.esd.tripped, 'LAH-103 is an alarm, no trip');
      assert.strictEqual(sim.dumpDesander().ok, true, 'dump');
      adv(sim, 600, 5);
      sim.setDesander(app.toWin({ bypass: true }));
      adv(sim, 900, 5);
      st = J(sim.getState());
      assert.strictEqual(st.desander.dump.count, 1, 'dump completed while bypassed (the dump continues; nothing is captured)');
      assert.ok(st.sand.cum.dumped_lb > 500, 'dumped ' + st.sand.cum.dumped_lb);
      sandIdentities(assert, st, 'after the dump and the bypass');
      const sb = mk(app, { cfg: SAND10, rig: { separator: false } });
      sb.setFault('sandFlowback', true); adv(sb, 1800, 10);
      const s2 = J(sb.getState());
      assert.ok(s2.sand.cum.toFlare_lb > 0 && s2.sand.cum.toSep_lb === 0, 'separator out: sand goes on to the flare line');
      sandIdentities(assert, s2, 'separator out');
    },
  },
  {
    name: 'WTSDS sand rate: flow-back term × min(1.5, fI)^1.5 (× 0.354 at fI 0.5), formation term × fI^1.5; flow-back clock restarts when switched on',
    wp: WP,
    run(app, assert) {
      const half = flowOf(app, (f) => { f.choke.flowLimited = true; f.choke.QmaxMMscfd = 5; f.nodes[2].flowLimited = true; });
      const h = mk(app, { flow: half }), f = mk(app, {});
      h.setFault('sandFlowback', true); f.setFault('sandFlowback', true);
      h.advance(10); f.advance(10);
      assert.near(h.getState().fInst, 0.5, 1e-9, 'fI 0.5');
      assert.rel(h.getState().sand.in_lbd / f.getState().sand.in_lbd, Math.pow(0.5, 1.5), 1e-9, 'flow-back × 0.354');
      assert.rel(f.getState().sand.in_lbd, 4800 * Math.exp(-10 / (6 * 3600)), 2e-5, 'flow-back 200 lb/h at fI 1 (rate of the last substep)');
      const h2 = mk(app, { flow: half, cfg: SAND10 }); h2.advance(10);
      assert.rel(h2.getState().sand.in_lbd, 10 * 1200 / 1000 * Math.pow(0.5, 1.5), 1e-9, 'formation term W_ss (10 pptb × 1,200 bbl/d) × fI^1.5');
      adv(f, 3600, 100);
      assert.near(f.getState().sand.flowback.t_h, 3610 / 3600, 1e-9, 'clock');
      f.setFault('sandFlowback', false); f.setFault('sandFlowback', true); f.advance(1);
      assert.near(f.getState().sand.flowback.t_h, 1 / 3600, 1e-9, 'switching on again restarts the clock');
    },
  },
  {
    name: 'WTSDS determinism (§7): dt 1 s vs dt 10 s over 2 h of flow-back with DS-101 in — sand totals within 1 %',
    wp: WP,
    timeoutMs: 300000,
    run(app, assert) {
      const a = mk(app, { rig: { desander: true }, cfg: SAND10 }), b = mk(app, { rig: { desander: true }, cfg: SAND10 });
      a.setFault('sandFlowback', true); b.setFault('sandFlowback', true);
      adv(a, 7200, 1); adv(b, 7200, 10);
      const sa = J(a.getState()), sb = J(b.getState());
      assert.near(sa.t, sb.t, 1e-6, 'same clock');
      ['in_lb', 'capt_lb', 'toChoke_lb', 'toSep_lb'].forEach((k) => {
        assert.ok(sa.sand.cum[k] > 0, k + ' > 0');
        assert.rel(sb.sand.cum[k], sa.sand.cum[k], 0.01, 'sand.cum.' + k + ' dt 10 vs dt 1');
      });
      assert.rel(sb.desander.sand.acc_lb + sb.desander.sand.buf_lb + sb.sand.cum.dumped_lb,
        sa.desander.sand.acc_lb + sa.desander.sand.buf_lb + sa.sand.cum.dumped_lb, 0.01, 'caught inventory dt 10 vs dt 1');
      sandIdentities(assert, sa, 'dt 1'); sandIdentities(assert, sb, 'dt 10');
    },
  },
  // ── dump sequence ──
  {
    name: 'WTSDS dump: isolate → bleed → flush → equalise → reopen; flush at 8 + 307 ± 2 s (interlock 1), total 1,043 ± 3 s, accumulator → 0, events, log, XV-103 line',
    wp: WP,
    run(app, assert) {
      const sim = mk(app, { rig: { desander: true }, cfg: SAND10 });
      adv(sim, 3600, 10);
      const acc0 = sim.getState().desander.sand.acc_lb, ev = dumps(sim), t0 = sim.getState().t;
      assert.ok(acc0 > 0.4, 'sand in the accumulator: ' + acc0);
      const r = sim.dumpDesander();
      assert.ok(r.ok && /dump started/.test(r.msg), JSON.stringify(r));
      let flushOpen = false, lineMax = 0, minPflush = Infinity, pPhase = '';
      for (let i = 0; i < 1100; i++) {
        sim.advance(1);
        const d = sim.getState().desander.dump, L = sim.getState().lines.ds_dump;
        if (d.phase === 'flush') { minPflush = Math.min(minPflush, d.Pacc); if (d.open) flushOpen = true; lineMax = Math.max(lineMax, L.q); assert.ok(L.active === d.open, 'line active = XV-103 open'); }
        else assert.ok(!d.open && !L.active, 'XV-103 shut outside the flush (' + d.phase + ')');
        if (d.phase !== pPhase && d.phase !== 'idle') assert.ok(d.left_s > 0, 'time left in ' + d.phase);
        pPhase = d.phase;
      }
      const ph = ev.map((e) => e.phase);
      assert.deepStrictEqual(ph, ['isolate', 'bleed', 'flush', 'equalise', 'reopen', 'idle'], 'phase order: ' + ph.join(' → '));
      const at = (p) => ev.filter((e) => e.phase === p)[0].t - t0;
      assert.near(at('isolate'), 0, 1e-9, 'start');
      assert.near(at('bleed'), 8, 0.05, 'isolate 8 s');
      assert.near(at('flush'), 8 + 307, 2, 'flush starts once bled below 50 psig');
      assert.near(at('equalise'), 8 + 307 + 600, 2, 'flush 600 s');
      assert.near(at('reopen') - at('equalise'), 120, 1, 'equalise 120 s (|PB − P_acc| < 75 psi already)');
      assert.near(at('idle'), 1043, 3, 'total');
      assert.ok(flushOpen && minPflush < 50, 'XV-103 opened only below 50 psig (min ' + minPflush + ')');
      assert.ok(lineMax > 0, 'ds_dump line carried sand: ' + lineMax);
      const st = J(sim.getState()), d = st.desander;
      assert.ok(d.dump.phase === 'idle' && d.dump.count === 1 && !d.dump.failed, 'complete');
      assert.near(d.dump.lastT, t0 + 1043, 3, 'lastT = end of the sequence');
      assert.near(d.dump.Pacc, st.nodes.choke.Pin, 1e-6, 'accumulator back at the desander pressure');
      assert.ok(d.sand.acc_lb < 0.2 && d.sand.buf_lb === 0, 'accumulator emptied (only the sand caught after the reopen): ' + d.sand.acc_lb);
      assert.near(st.sand.cum.dumped_lb, acc0, 0.05, 'dumped = what was in the accumulator');
      assert.ok(ev.every((e) => e.auto === false), 'manual dump');
      assert.ok(logOf(st, 'DS_DUMP').length >= 5 && logOf(st, 'DS_DUMP').every((e) => e.type === 'event'), 'DS_DUMP event log entries');
      sandIdentities(assert, st, 'dump');
      assert.ok(!st.esd.tripped, 'the well kept flowing');
    },
  },
  {
    name: 'WTSDS dump at PB 10,000 psig (15,000 psi rating): bleed 397 ± 3 s, equalise 147 ± 3 s (interlock 2)',
    wp: WP,
    run(app, assert) {
      const sim = mk(app, { rig: { desander: true }, cfg: { noise: { on: false }, desander: { rating_psi: 15000 } }, flow: hpFlow(app, 10000) });
      adv(sim, 300, 10);
      const PB = sim.getState().nodes.choke.Pin;
      assert.near(PB, 10000, 60, 'PB ≈ 10,000 psig: ' + PB);
      const ev = dumps(sim), t0 = sim.getState().t;
      assert.ok(sim.dumpDesander('start').ok, 'start');
      adv(sim, 1300, 1);
      const at = (p) => ev.filter((e) => e.phase === p)[0].t - t0;
      assert.near(at('flush') - at('bleed'), 75 * Math.log(PB / 50), 2, 'bleed τ·ln(PB/50)');
      assert.near(at('flush') - at('bleed'), 397, 3, 'bleed 397 s');
      assert.near(at('reopen') - at('equalise'), 30 * Math.log(PB / 75), 2, 'equalise τ·ln(PB/75)');
      assert.near(at('reopen') - at('equalise'), 147, 3, 'equalise 147 s');
      assert.ok(!sim.getState().esd.tripped && sim.getState().desander.dump.count === 1, 'complete, no trip');
    },
  },
  {
    name: 'WTSDS dump commands: refused while out / running / held / ESD tripped / unknown; rig-out aborts a running dump (buffer → accumulator capped, alarms released)',
    wp: WP,
    run(app, assert) {
      const out = mk(app, { cfg: SAND10 });
      let r = out.dumpDesander();
      assert.ok(!r.ok && /out of the rig-up/.test(r.msg), 'out: ' + r.msg);
      assert.strictEqual(out.setDesander(app.toWin({ bypass: true })), false, 'setDesander refused while out');
      const sim = mk(app, { rig: { desander: true } });
      sim.setFault('sandFlowback', true);
      adv(sim, 1800, 10);
      assert.ok(!sim.dumpDesander('resume').ok, 'nothing to resume');
      assert.ok(!sim.dumpDesander('abort').ok, 'nothing to abort');
      assert.ok(!sim.dumpDesander('purge').ok, 'unknown command');
      assert.ok(sim.dumpDesander().ok, 'start');
      r = sim.dumpDesander();
      assert.ok(!r.ok && /already running/.test(r.msg), 'running: ' + r.msg);
      adv(sim, 200, 5);
      const s1 = J(sim.getState());
      assert.ok(s1.desander.dump.phase === 'bleed' && s1.desander.sand.buf_lb > 0, 'bleeding, caught sand goes to the buffer: ' + s1.desander.sand.buf_lb);
      const acc = s1.desander.sand.acc_lb, buf = s1.desander.sand.buf_lb, cap = s1.desander.sand.cap_lb, esd1 = s1.nodes.esd.P;
      assert.ok(s1.nodes.esd.P - s1.nodes.choke.Pin > 0.5, 'DS-101 in: choke inlet below the ESD node by the desander ΔP');
      let ab = null; sim.on('dump', (p) => { if (/aborted/.test(p.msg)) ab = p; });
      assert.strictEqual(sim.setRigup(app.toWin({ desander: false })), true, 'DS-101 out of the rig-up');
      const s2 = J(sim.getState());
      assert.ok(ab && ab.phase === 'idle', 'dump aborted event');
      assert.ok(logOf(s2, 'DS_DUMP').some((e) => /dump aborted: DS-101 out of the rig-up/.test(e.msg)), 'logged');
      assert.ok(s2.desander.dump.phase === 'idle' && !s2.desander.inRig, 'idle, out');
      assert.near(s2.desander.sand.acc_lb, Math.min(cap, acc + buf), 1e-6, 'buffer moved into the accumulator (capped)');
      assert.strictEqual(s2.desander.dP_psi, 0, 'no ΔP while out');
      assert.strictEqual(s2.nodes.esd.P, esd1, 'rig-out: the ESD node is continuous (X.PB carries PBu, plan §6.4)');
      assert.strictEqual(s2.nodes.choke.Pin, esd1, 'rig-out: the choke inlet loses the desander ΔP');
      adv(sim, 1, 1);
      assert.ok(Math.abs(J(sim.getState()).nodes.esd.P - esd1) < 1, 'ESD node: no step in the first second after the rig-out');
      assert.ok(ids(s2).filter((i) => /^DES_|^HYD_ds|HYD_desander/.test(i)).length === 0, 'Q_DES released');
      adv(sim, 60, 1);
      const s3 = J(sim.getState());
      assert.strictEqual(s3.nodes.esd.P, s3.nodes.choke.Pin, 'legacy PB law from the current X.PB');
      // ESD tripped
      const t = mk(app, { rig: { desander: true } });
      adv(t, 60, 10); t.tripESD('test');
      r = t.dumpDesander();
      assert.ok(!r.ok && /ESD tripped/.test(r.msg), 'ESD tripped: ' + r.msg);
      assert.ok(J(t.getState()).alarmLog.some((e) => e.id === 'DS_DUMP' && /refused/.test(e.msg)), 'refusal logged');
    },
  },
  {
    name: 'WTSDS dump fault desanderIsoPassing: P_acc settles ≈ 0.71·PB, never < 50 psig — DES_DUMP_FAIL "accumulator not bled", no flush, nothing removed',
    wp: WP,
    run(app, assert) {
      const sim = mk(app, { rig: { desander: true }, cfg: SAND10 });
      adv(sim, 1800, 10);
      sim.setFault('desanderIsoPassing', true);
      const acc0 = sim.getState().desander.sand.acc_lb, ev = dumps(sim);
      assert.ok(sim.dumpDesander().ok, 'start');
      let mn = Infinity, last = 0;
      for (let i = 0; i < 1400; i++) {
        sim.advance(1);
        const d = sim.getState().desander.dump;
        if (d.phase === 'bleed') { mn = Math.min(mn, d.Pacc); last = d.Pacc; }
        assert.ok(!d.open, 'XV-103 never opens');
      }
      const st = J(sim.getState()), PB = st.nodes.choke.Pin;
      assert.ok(mn >= 50, 'P_acc never below 50 psig: ' + mn);
      assert.near(last / PB, 0.714, 0.02, 'equilibrium ≈ 0.71·PB');
      assert.ok(ev.map((e) => e.phase).indexOf('flush') < 0, 'no flush');
      assert.ok(st.desander.dump.failed && /accumulator not bled/.test(st.desander.dump.failMsg), 'failed: ' + st.desander.dump.failMsg);
      assert.ok(ids(st).indexOf('DES_DUMP_FAIL') >= 0 && /accumulator not bled/.test(alarm(st, 'DES_DUMP_FAIL').msg), 'DES_DUMP_FAIL');
      assert.strictEqual(st.sand.cum.dumped_lb, 0, 'nothing released');
      assert.ok(st.desander.sand.acc_lb >= acc0, 'accumulator kept its sand');
      assert.strictEqual(st.desander.dump.count, 0, 'not counted as a dump');
      assert.ok(st.desander.auto.blocked, 'auto-dump blocked after a failed dump');
      assert.ok(!st.esd.tripped, 'no trip');
      sandIdentities(assert, st, 'iso passing');
    },
  },
  {
    name: 'WTSDS dump fault desanderDumpStuck: DES_DUMP_FAIL "dump valve did not open", auto-dump blocked until the next manual start (which clears the alarm)',
    wp: WP,
    run(app, assert) {
      const sim = mk(app, { rig: { desander: true } });
      sim.setFault('sandFlowback', true);
      adv(sim, 2 * 3600, 20);
      sim.setFault('desanderDumpStuck', true);
      assert.ok(sim.dumpDesander().ok, 'start');
      adv(sim, 1100, 2);
      let st = J(sim.getState());
      assert.ok(st.desander.dump.failed && /dump valve did not open/.test(st.desander.dump.failMsg), st.desander.dump.failMsg);
      assert.ok(ids(st).indexOf('DES_DUMP_FAIL') >= 0, 'DES_DUMP_FAIL');
      assert.strictEqual(st.sand.cum.dumped_lb, 0, 'nothing removed');
      // auto on with a set point already exceeded: blocked, nothing starts
      assert.ok(sim.setDesander(app.toWin({ auto: { on: true, sp: 0.5 } })), 'auto on, SP 50 %');
      const ev = dumps(sim);
      adv(sim, 3600, 20);
      st = J(sim.getState());
      assert.ok(st.desander.sand.acc_frac > 0.5 && ev.length === 0 && st.desander.auto.blocked, 'auto-dump blocked: frac ' + st.desander.sand.acc_frac);
      assert.ok(sim.dumpDesander().ok, 'manual start re-arms');
      adv(sim, 5, 1);
      st = J(sim.getState());
      assert.ok(!st.desander.auto.blocked && !st.desander.dump.failed && ids(st).indexOf('DES_DUMP_FAIL') < 0, 'alarm cleared, auto re-armed');
    },
  },
  {
    name: 'WTSDS auto-dump: starts at the set point (event auto), runs the interlocked sequence, never starts while the ESD is tripped',
    wp: WP,
    run(app, assert) {
      const sim = mk(app, { rig: { desander: true } });
      sim.setFault('sandFlowback', true);
      const ev = dumps(sim);
      assert.ok(sim.setDesander(app.toWin({ auto: { on: true, sp: 0.5 } })), 'auto on');
      assert.strictEqual(sim.getControls().desander.auto, true, 'controls carry auto');
      assert.strictEqual(sim.getControls().desander.sp, 0.5, 'controls carry sp');
      adv(sim, 3 * 3600, 20);
      const st = J(sim.getState());
      assert.ok(ev.length >= 6 && ev[0].auto === true && ev[0].phase === 'isolate', 'auto dump started: ' + ev.map((e) => e.phase).join(','));
      assert.ok(st.desander.dump.count >= 1, 'completed: ' + st.desander.dump.count);
      sandIdentities(assert, st, 'auto');
      // ESD tripped: no auto start
      const t = mk(app, { rig: { desander: true } });
      t.setFault('sandFlowback', true);
      adv(t, 3600, 20);
      t.tripESD('test');
      const ev2 = dumps(t);
      t.setDesander(app.toWin({ auto: { on: true, sp: 0.5 } }));
      adv(t, 600, 10);
      assert.strictEqual(ev2.length, 0, 'no auto dump while the ESD is tripped');
      // sp clamped 0.5–0.95
      t.setDesander(app.toWin({ auto: { sp: 0.1 } }));
      assert.strictEqual(t.getControls().desander.sp, 0.5, 'sp clamped to 0.5');
    },
  },
  {
    name: 'WTSDS overflow: stuck dump valve + three dumps in flow-back — accumulator ≤ cap, buffer ≤ its cap, capture ≥ 0 every second, LAHH lowers capture, balance exact',
    wp: WP,
    timeoutMs: 300000,
    run(app, assert) {
      const sim = mk(app, { rig: { desander: true } });
      sim.setFault('sandFlowback', true); sim.setFault('desanderDumpStuck', true);
      let prevCapt = 0, starts = 0, lahh = false, effFull = null, effClean = null;
      for (let i = 0; i < 6 * 3600; i++) {
        sim.advance(1);
        const s = sim.getState(), d = s.desander, ds = d.sand;
        assert.ok(ds.acc_lb <= ds.cap_lb + 1e-9 && ds.acc_lb >= 0, 'acc ≤ cap at ' + s.t);
        assert.ok(ds.buf_lb <= ds.bufCap_lb + 1e-9 && ds.buf_lb >= 0, 'buf ≤ cap at ' + s.t);
        assert.ok(s.sand.cum.capt_lb >= prevCapt - 1e-12 && ds.capt_lbd >= 0, 'capture ≥ 0 at ' + s.t);
        prevCapt = s.sand.cum.capt_lb;
        if (i > 3 * 3600 && d.dump.phase === 'idle' && starts < 3) { if (sim.dumpDesander().ok) starts++; }
        if (ids(s).indexOf('DES_LAHH') >= 0) lahh = true;
        if (d.dump.phase === 'idle' && ds.acc_frac > 0.97 && effFull === null) { effFull = d.eff; effClean = d.effClean; }
      }
      const st = J(sim.getState());
      assert.strictEqual(starts, 3, 'three dumps started');
      assert.ok(lahh, 'LAHH-103 raised');
      assert.ok(effFull !== null && effFull < 0.5 * effClean, 'capture falls as the accumulator fills (' + effFull + ' vs clean ' + effClean + ')');
      assert.strictEqual(st.sand.cum.dumped_lb, 0, 'stuck valve: nothing dumped');
      assert.ok(st.desander.sand.acc_lb > 0.98 * st.desander.sand.cap_lb, 'accumulator full (capture tapers to 0 at 100 %): ' + st.desander.sand.acc_lb);
      assert.ok(st.sand.toChoke_lbd > 1000, 'sand carried to the choke: ' + st.sand.toChoke_lbd);
      sandIdentities(assert, st, 'overflow');
    },
  },
  {
    name: 'WTSDS ESD hold: ESD mid-flush → held (XV-103 and bleed shut); resume refused before the reset and completes after it; abort returns the buffer (capped)',
    wp: WP,
    run(app, assert) {
      const go = () => {
        const s = mk(app, { rig: { desander: true }, cfg: SAND10 });
        s.setFault('sandFlowback', true);
        adv(s, 1800, 10);
        assert.ok(s.dumpDesander().ok, 'start');
        adv(s, 400, 1);
        assert.strictEqual(s.getState().desander.dump.phase, 'flush', 'flushing');
        s.tripESD('test');
        adv(s, 5, 1);
        return s;
      };
      const a = go();
      let st = J(a.getState());
      assert.ok(st.desander.dump.phase === 'held' && st.desander.dump.heldFrom === 'flush' && !st.desander.dump.open, 'held at flush, XV-103 shut');
      assert.ok(!st.lines.ds_dump.active, 'no dump flow while held');
      const Ph = st.desander.dump.Pacc;
      let r = a.dumpDesander('resume');
      assert.ok(!r.ok && /ESD/.test(r.msg), 'resume refused before the reset');
      assert.ok(!a.dumpDesander('abort').ok, 'abort refused before the reset');
      r = a.dumpDesander('start');
      assert.ok(!r.ok, 'start refused while held');
      adv(a, 120, 1);
      assert.near(a.getState().desander.dump.Pacc, Ph, 1e-9, 'accumulator isolated: P_acc holds');
      assert.ok(a.resetESD().ok, 'ESD reset');
      r = a.dumpDesander('start');
      assert.ok(!r.ok && /held/.test(r.msg), 'start refused: a dump is held');
      assert.ok(a.dumpDesander('resume').ok, 'resume');
      adv(a, 1000, 1);
      st = J(a.getState());
      assert.ok(st.desander.dump.phase === 'idle' && st.desander.dump.count === 1, 'resumed dump completed');
      assert.ok(st.sand.cum.dumped_lb > 0, 'sand dumped');
      sandIdentities(assert, st, 'resume');
      const b = go();
      assert.ok(b.resetESD().ok, 'ESD reset');
      adv(b, 600, 1);                               // the buffer collects while the well comes back
      const sb = J(b.getState());
      const acc = sb.desander.sand.acc_lb, buf = sb.desander.sand.buf_lb, cap = sb.desander.sand.cap_lb;
      assert.ok(buf > 0, 'buffer holds sand: ' + buf);
      const ev = dumps(b);
      assert.ok(b.dumpDesander('abort').ok, 'abort');
      adv(b, 400, 1);
      const s2 = J(b.getState());
      assert.deepStrictEqual(ev.map((e) => e.phase), ['equalise', 'reopen', 'idle'], 'abort → equalise → reopen → idle');
      assert.ok(s2.desander.dump.count === 0 && s2.desander.dump.phase === 'idle', 'aborted dump not counted');
      assert.ok(s2.desander.sand.buf_lb < buf && s2.desander.sand.acc_lb <= cap, 'buffer moved into the accumulator, capped');
      assert.ok(s2.desander.sand.acc_lb >= Math.min(cap, acc + buf) - 1e-6 || s2.desander.sand.acc_lb >= cap - 1e-6, 'moved min(buf, cap − acc)');
      sandIdentities(assert, s2, 'abort');
    },
  },
  // ── faults and alarms ──
  {
    name: 'WTSDS liner faults on SAMPLE_FLOW: plugged → PDAH-103 within 60 s; washed out → PDAL-103; HV-104 passing → capture × 0.9, ΔP × 0.81, no PDAL',
    wp: WP,
    run(app, assert) {
      const p = mk(app, { rig: { desander: true } });
      adv(p, 300, 10);
      const t0 = p.getState().t;
      let tH = null; p.on('alarm', (x) => { if (x.id === 'DES_DP_HIGH' && tH === null) tH = x.t; });
      p.setFault('desanderPlugged', true);
      adv(p, 60, 1);
      let st = J(p.getState());
      assert.ok(tH !== null && tH - t0 <= 60, 'PDAH-103 within 60 s: ' + (tH - t0));
      assert.rel(st.desander.dP_psi, 11.8, 0.02, 'plugged ΔP');
      const A = alarm(st, 'DES_DP_HIGH');
      assert.ok(A.tag === 'PDAH-103' && A.sev === 'alarm' && /× clean/.test(A.msg) && /plugged liner/.test(A.msg), A.msg);
      assert.near(A.limit, 8.93, 0.05, 'threshold max(2·exp, exp + 5)');
      p.setFault('desanderPlugged', false); adv(p, 120, 1);
      assert.ok(ids(J(p.getState())).indexOf('DES_DP_HIGH') < 0, 'clears when the fault goes');
      const w = mk(app, { rig: { desander: true } });
      adv(w, 300, 10); w.setFault('desanderWashout', true); adv(w, 60, 1);
      st = J(w.getState());
      assert.rel(st.desander.dP_psi, 1.18, 0.02, 'washed-out ΔP');
      assert.ok(ids(st).indexOf('DES_DP_LOW') >= 0 && alarm(st, 'DES_DP_LOW').sev === 'warn' && alarm(st, 'DES_DP_LOW').tag === 'PDAL-103', 'PDAL-103 warn');
      const ref = mk(app, { rig: { desander: true }, cfg: SAND10 }), bp = mk(app, { rig: { desander: true }, cfg: SAND10 });
      adv(ref, 300, 10); adv(bp, 300, 10);
      bp.setFault('desanderBypassPassing', true);
      adv(ref, 120, 1); adv(bp, 120, 1);
      const sr = J(ref.getState()), sb = J(bp.getState());
      assert.rel(sb.desander.eff / sr.desander.eff, 0.9, 1e-6, 'capture × 0.9');
      assert.rel(sb.desander.dP_psi / sr.desander.dP_psi, 0.81, 1e-3, 'ΔP × 0.81');
      assert.ok(ids(sb).indexOf('DES_DP_LOW') < 0, 'no PDAL (hidden failure)');
      assert.ok(sb.sand.toChoke_lbd > 2 * sr.sand.toChoke_lbd, 'seen only in the sand to the choke');
      [p, w, bp].forEach((s) => assert.ok(!s.getState().esd.tripped, 'no trip'));
    },
  },
  {
    name: 'WTSDS bypass line-up: ΔP 0, capture 0, all sand to the choke (SAND_CHOKE), logged DS_BYPASS; back in line the sand to the choke falls',
    wp: WP,
    run(app, assert) {
      const sim = mk(app, { rig: { desander: true }, cfg: SAND10 });
      adv(sim, 600, 10);
      assert.ok(sim.setDesander(app.toWin({ bypass: true })), 'bypass');
      assert.strictEqual(sim.setDesander(app.toWin({ bypass: true })), false, 'no change → false');
      adv(sim, 120, 1);
      let st = J(sim.getState());
      assert.ok(st.desander.bypass && st.desander.dP_psi < 1e-6 && st.desander.eff === 0 && st.desander.sand.capt_lbd === 0, 'bypassed');
      assert.near(st.sand.toChoke_lbd, 12, 1e-9, 'all sand to the choke');
      assert.ok(ids(st).indexOf('SAND_CHOKE') >= 0, 'SAND_CHOKE');
      assert.strictEqual(st.sand.choke.band, 'warn', 'band warn');
      assert.ok(logOf(st, 'DS_BYPASS').some((e) => /HV-104 open, DS-101 blocked in/.test(e.msg)), 'logged');
      assert.ok(sim.getControls().desander.bypass === true, 'controls carry the bypass');
      assert.ok(st.desander.dump.Pacc > 2900, 'DS-101 stays pressurised while bypassed');
      sim.setDesander(app.toWin({ bypass: false }));
      adv(sim, 120, 1);
      st = J(sim.getState());
      assert.ok(st.sand.toChoke_lbd < 1 && st.sand.choke.band === 'ok', 'back in line');
      adv(sim, 30, 1);
      assert.ok(ids(J(sim.getState())).indexOf('SAND_CHOKE') < 0, 'SAND_CHOKE clears');
      // setControls (not initial) applies the bypass line-up with the log
      sim.setControls(app.toWin({ desander: { bypass: true } }));
      assert.ok(J(sim.getState()).alarmLog.filter((e) => e.id === 'DS_BYPASS').length >= 3, 'setControls logs the line-up');
    },
  },
  {
    name: 'WTSDS flow-back bypassed: erosion band high, SAND_CHOKE alarm, SAND_SEP once the bulk volume passes 10 %; sand off clears both at once',
    wp: WP,
    run(app, assert) {
      const sim = mk(app, { rig: { desander: true } });
      sim.setFault('sandFlowback', true);
      sim.setDesander(app.toWin({ bypass: true }));
      let tS = null; sim.on('alarm', (x) => { if (x.id === 'SAND_SEP' && tS === null) tS = x.t; });
      adv(sim, 3600, 10);
      let st = J(sim.getState());
      assert.strictEqual(st.sand.choke.band, 'high', 'band high');
      assert.ok(st.sand.choke.erosion_mild > 1000, 'flow-back peak bypassed ≈ 3,600 mil/d: ' + st.sand.choke.erosion_mild);
      assert.ok(alarm(st, 'SAND_CHOKE').sev === 'alarm', 'SAND_CHOKE alarm above 50 lb/d');
      assert.ok(tS !== null && st.sand.sep.frac >= 0.1, 'SAND_SEP: ' + st.sand.sep.frac);
      assert.ok(alarm(st, 'SAND_SEP').eq === 'separator' && alarm(st, 'SAND_SEP').sev === 'warn', 'SAND_SEP warn on V-101');
      assert.near(st.sand.sep.lb, st.sand.cum.toSep_lb, 1e-9, 'sand in V-101');
      sim.setFault('sandFlowback', false);
      st = J(sim.getState());
      assert.ok(ids(st).indexOf('SAND_CHOKE') < 0 && ids(st).indexOf('SAND_SEP') < 0, 'cleared at once: ' + ids(st).join(','));
      assert.ok(!st.sand.on, 'sand off');
      // the setConfig path (sand rate to 0)
      const c = mk(app, { cfg: SAND10 });
      adv(c, 60, 10);
      assert.ok(ids(J(c.getState())).indexOf('SAND_CHOKE') >= 0, 'SAND_CHOKE with DS-101 out');
      c.setConfig(app.toWin({ sand: { pptb: 0 } }));
      assert.ok(ids(J(c.getState())).indexOf('SAND_CHOKE') < 0, 'setConfig sand 0 clears SAND_CHOKE');
    },
  },
  {
    name: 'WTSDS rating (D4): 5,000 psi + SITHP 5,200 → DES_RATING alarm; FWHT 260 °F → temperature text; blank SITHP → 1.2 × WHP "(estimated)"; PSHH-103 trips the ESD',
    wp: WP,
    run(app, assert) {
      const a = mk(app, { rig: { desander: true }, cfg: { noise: { on: false }, desander: { rating_psi: 5000, sithp_psig: 5200 } } });
      adv(a, 30, 1);
      let st = J(a.getState()), A = alarm(st, 'DES_RATING');
      assert.ok(A && A.sev === 'alarm' && /rating below the maximum shut-in wellhead pressure/.test(A.msg) && /no relief valve/.test(A.msg), A && A.msg);
      assert.ok(!/estimated/.test(A.msg) && !st.desander.ratingOK && !st.desander.sithpEst, 'given SITHP');
      assert.ok(!st.esd.tripped, 'design alarm, no trip');
      const t = mk(app, { rig: { desander: true }, cfg: { noise: { on: false }, desander: { rating_psi: 5000 } },
        flow: flowOf(app, (f) => { f.inputs.Twh = 260; f.nodes[0].T = 260; f.nodes[1].T = 260; }) });
      adv(t, 30, 1);
      st = J(t.getState()); A = alarm(st, 'DES_RATING');
      assert.ok(A && /well temperature outside the desander temperature class/.test(A.msg) && !st.desander.tempOK && st.desander.ratingOK, A && A.msg);
      assert.strictEqual(st.desander.tempMax_F, 250, '5,000 psi class: 250 °F');
      const e = mk(app, { rig: { desander: true }, cfg: { noise: { on: false }, desander: { rating_psi: 5000 } }, flow: hpFlow(app, 4500) });
      adv(e, 30, 1);
      st = J(e.getState()); A = alarm(st, 'DES_RATING');
      assert.ok(st.desander.sithpEst && Math.abs(st.desander.sithp_psi - 1.2 * 4550) < 1e-6, 'estimated SITHP ' + st.desander.sithp_psi);
      assert.ok(A && /SITHP estimated as 1\.2 × WHP/.test(A.msg), A && A.msg);
      assert.ok(!st.esd.tripped, 'still flowing (inlet below the rating)');
      // PSHH-103: flowing with the inlet at the rating
      const p = mk(app, { rig: { desander: true }, cfg: { noise: { on: false }, desander: { rating_psi: 5000, sithp_psig: 6000 } }, flow: hpFlow(app, 5150) });
      let trip = null; p.on('trip', (x) => { if (!trip) trip = x; });
      adv(p, 30, 1);
      st = J(p.getState());
      assert.ok(st.esd.tripped && st.esd.cause === 'DES_PSHH', 'ESD by PSHH-103: ' + st.esd.cause);
      assert.ok(trip && trip.tag === 'PSHH-103' && /SDV-101/.test(trip.msg), trip && trip.msg);
      adv(p, 120, 1);
      assert.ok(ids(J(p.getState())).indexOf('DES_PSHH') < 0, 'PSHH-103 clears once shut in (not flowing)');
      // only PSHH-103 trips: every other desander alarm definition has a non-trip severity
      const sevs = {};
      [a, t, e, p].forEach((s) => J(s.getState()).alarmLog.filter((x) => x.type === 'raise').forEach((x) => { sevs[x.id] = x.sev; }));
      Object.keys(sevs).filter((k) => /^DES_|^HYD_ds|HYD_desander/.test(k) && k !== 'DES_PSHH').forEach((k) => assert.notStrictEqual(sevs[k], 'trip', k + ' is not a trip'));
    },
  },
  {
    name: 'WTSDS DES_RATE: below turndown (30 % velocity) raised only after the start-up grace (180 s), with the rate state "low"',
    wp: WP,
    run(app, assert) {
      const sim = mk(app, { rig: { desander: true }, flow: flowOf(app, (f) => { f.segs[1].vel *= 0.3; }) });
      let tR = null; sim.on('alarm', (x) => { if (x.id === 'DES_RATE' && tR === null) tR = x.t; });
      adv(sim, 170, 1);
      assert.strictEqual(tR, null, 'not during start-up');
      adv(sim, 60, 1);
      const st = J(sim.getState());
      assert.ok(tR !== null && tR >= 180, 'raised after the grace: ' + tR);
      assert.ok(st.desander.rate === 'low' && st.desander.vIn_fts < 10, 'low: ' + st.desander.vIn_fts);
      assert.ok(/below turndown — weak swirl/.test(alarm(st, 'DES_RATE').msg) && alarm(st, 'DES_RATE').sev === 'warn', alarm(st, 'DES_RATE').msg);
      const hi = mk(app, { rig: { desander: true }, flow: flowOf(app, (f) => { f.segs[1].vel *= 3.2; }) });
      adv(hi, 240, 1);
      const sh = J(hi.getState());
      assert.ok(sh.desander.rate === 'high' && /over-rate — carry-over/.test(alarm(sh, 'DES_RATE').msg), 'over-rate');
    },
  },
  {
    name: 'WTSDS hydrates and temperatures: bleed-line flag at Twh 120 °F (not on the sample), accumulator dead leg at cold ambient, outlet J-T drop, vessel lag 3 × warmTau',
    wp: WP,
    run(app, assert) {
      const cold = flowOf(app, (f) => { f.inputs.Twh = 120; f.nodes[0].T = 120; f.nodes[1].T = 120; });
      const k = mk(app, { rig: { desander: true }, cfg: SAND10, flow: cold });
      adv(k, 600, 10); k.dumpDesander(); adv(k, 20, 1);
      let st = J(k.getState());
      assert.ok(ids(st).indexOf('HYD_dsBleed') >= 0 && alarm(st, 'HYD_dsBleed').tag === 'XV-103' && /inject methanol/.test(alarm(st, 'HYD_dsBleed').msg), 'bleed-line flag');
      adv(k, 1100, 2);
      assert.ok(ids(J(k.getState())).indexOf('HYD_dsBleed') < 0, 'held to the end of the dump, then cleared');
      const s = mk(app, { rig: { desander: true }, cfg: SAND10 });
      adv(s, 600, 10); s.dumpDesander(); adv(s, 20, 1);
      assert.ok(ids(J(s.getState())).indexOf('HYD_dsBleed') < 0, 'sample: bleed 65 °F, above the hydrate line');
      const amb = mk(app, { rig: { desander: true }, cfg: { noise: { on: false }, ambientT: 20 } });
      adv(amb, 60, 10);
      st = J(amb.getState());
      assert.ok(ids(st).indexOf('HYD_dsAcc') >= 0 && alarm(st, 'HYD_dsAcc').tag === 'DS-101A', 'accumulator dead leg at ambient');
      assert.strictEqual(st.nodes.desander.Tacc, 20, 'accumulator node at ambient');
      // outlet temperature: inlet minus 0.07·wJT·ΔP
      const o = mk(app, { rig: { desander: true } }); adv(o, 300, 10);
      st = J(o.getState());
      const wJT = app.win.WTS_sim.SAMPLE_FLOW.choke.wJT;
      assert.near(st.nodes.desander.T - st.nodes.desander.Tout, 0.07 * wJT * st.desander.dP_psi, 1e-9, 'outlet J-T drop');
      assert.near(st.desander.Tout, st.nodes.desander.Tout, 1e-12, 'snapshot copy');
      // vessel lag: after a shut-in the desander cools ≈ 3 × slower than the pipe
      o.tripESD('test'); adv(o, 900, 10);
      st = J(o.getState());
      const Tw = app.win.WTS_sim.SAMPLE_FLOW.nodes[1].T, Ta = 80;
      const fE = (st.nodes.esd.T - Ta) / (Tw - Ta), fD = (st.nodes.desander.T - Ta) / (Tw - Ta);
      assert.ok(fD > fE + 0.05 && fD < 1, 'desander keeps more heat than the ESD node: ' + fD + ' vs ' + fE);
      // HYD_desander on the outlet temperature (the generic node check): cold ambient, no flow heat
      const hy = mk(app, { rig: { desander: true }, cfg: { noise: { on: false }, ambientT: 30 }, flow: flowOf(app, (f) => { f.inputs.Twh = 60; f.nodes[0].T = 60; f.nodes[1].T = 60; }) });
      adv(hy, 300, 10);
      st = J(hy.getState());
      assert.ok(st.nodes.desander.hyd && ids(st).indexOf('HYD_desander') >= 0, 'HYD_desander on a cold well: ' + st.nodes.desander.Tout + ' vs ' + st.nodes.desander.th);
      assert.ok(alarm(st, 'HYD_desander').value === st.nodes.desander.Tout, 'judged on the outlet temperature');
    },
  },
  // ── choke capacity coupling (§4.6) ──
  {
    name: 'WTSDS choke coupling: a plugged DS-101 on a subcritical (liquid-type) choke scales the rate by √(1 − PD/ΔPchoke); qgE/qoE/qwE untouched; legacy path with DS-101 out',
    wp: WP,
    run(app, assert) {
      const sub = flowOf(app, (f) => { f.choke.regime = 'Subcritical'; f.nodes[2].regime = 'Subcritical'; f.nodes[2].P = f.nodes[2].Pci - 20; f.choke.Pout = f.nodes[2].P; });
      const q = mk(app, { rig: { desander: true }, flow: sub });
      adv(q, 600, 10);
      const qE = J(q._internal().des.qE);
      q.setFault('desanderPlugged', true);
      for (let i = 0; i < 1000; i++) q.advance(10);            // ≥ 10,000 substeps
      const I = J(q._internal().des), st = J(q.getState());
      assert.deepStrictEqual(I.qE, qE, 'qgE/qoE/qwE unchanged');
      const r = Math.sqrt(1 - I.PD / (I.Pci - I.Pck));
      assert.ok(r < 0.98, 'coupling active: r ' + r);
      assert.near(st.f, r, 1e-3, 'rate scaled by √ΔP');
      assert.ok(st.nodes.choke.flowLimited && ids(st).indexOf('CHOKE_LIMIT') >= 0 && /DS-101 ΔP/.test(alarm(st, 'CHOKE_LIMIT').msg), 'CHOKE_LIMIT from the dynamic flag');
      const o = mk(app, { flow: sub });
      adv(o, 600, 10); const f0 = o.getState().f;
      o.setFault('desanderPlugged', true); adv(o, 600, 10);
      assert.strictEqual(o.getState().f, f0, 'DS-101 out: the plugged fault changes nothing (legacy path)');
      assert.ok(!o.getState().nodes.choke.flowLimited, 'no flow limit');
      const n = mk(app, { rig: { desander: true }, flow: sub, cfg: { noise: { on: false }, desander: { chokeCoupling: false } } });
      n.setFault('desanderPlugged', true); adv(n, 600, 10);
      assert.strictEqual(n.getState().f, f0, 'chokeCoupling false: no coupling');
    },
  },
  {
    name: 'WTSDS choke coupling near the gas limit: flowLimited sets with 1 % hysteresis — no flicker in 1,200 s with noise on; default gas sample needs ≈ 200 psi',
    wp: WP,
    run(app, assert) {
      const near = flowOf(app, (f) => { f.choke.QmaxMMscfd = 10.035; f.nodes[2].Qmax = 10035; });
      const g = app.win.WTS_sim.create(app.toWin(near), app.toWin({ seed: 9, rigup: { desander: true }, config: { desander: { plugFactor: 12 } } }));
      adv(g, 300, 10);
      g.setFault('desanderPlugged', true);
      let changes = 0, raises = 0, last = null;
      g.on('alarm', (x) => { if (x.id === 'CHOKE_LIMIT') raises++; });
      for (let i = 0; i < 1200; i++) { g.advance(1); const fl = g._internal().des.flowLim; if (last !== null && fl !== last) changes++; last = fl; }
      assert.ok(last === true, 'flow-limited');
      assert.ok(changes <= 1 && raises === 1, 'no flicker: ' + changes + ' changes, ' + raises + ' raises');
      const s = g._internal().des.s;
      assert.ok(s < 0.995 && s > 0.95, 'scale ' + s);
      // the default sample (Qmax 10.71 vs 10 MMscf/d): a plugged liner (11.8 psi) does not limit the flow
      const d = mk(app, { rig: { desander: true } });
      d.setFault('desanderPlugged', true); adv(d, 600, 10);
      assert.strictEqual(d._internal().des.s, 1, 'no coupling on the default sample');
      assert.ok(!d.getState().nodes.choke.flowLimited, 'not flow-limited');
    },
  },
  // ── history, snapshot, controls, identity ──
  {
    name: 'WTSDS history and snapshot: dsAccFrac / dsDP / sandChoke follow the item; 0 while out; snapshot shape strict; controls round trip with v3.3 prefs',
    wp: WP,
    run(app, assert) {
      const sim = mk(app, { rig: { desander: true }, cfg: SAND10 });
      adv(sim, 1200, 10);
      const hd = J(sim.getHistory('dsDP')), ha = J(sim.getHistory('dsAccFrac')), hs = J(sim.getHistory('sandChoke'));
      const lastOf = (h) => { const v = h.v || h.values || h.y || h; return Array.isArray(v) ? v[v.length - 1] : (v && v.length ? v[v.length - 1] : null); };
      const st = J(sim.getState());
      assert.rel(lastOf(hd), st.desander.dP_psi, 0.01, 'dsDP history');
      assert.ok(lastOf(ha) > 0 && lastOf(ha) < 0.01, 'dsAccFrac history');
      assert.rel(lastOf(hs), st.sand.toChoke_lbd, 0.01, 'sandChoke history');
      ['desander', 'sand'].forEach((n) => assert.ok(X.checkShape(n, st[n], { strict: true }).ok, n + ' shape: ' + JSON.stringify(X.checkShape(n, st[n], { strict: true }))));
      sim.setRigup(app.toWin({ desander: false }));
      adv(sim, 60, 10);
      assert.strictEqual(lastOf(J(sim.getHistory('dsDP'))), 0, 'dsDP 0 while out');
      const c = mk(app, {});
      c.setControls(app.toWin({ surge: { inlet: [true, false] }, gauge: { inlet: [true, false] } }), app.toWin({ initial: true }));
      assert.deepStrictEqual(J(c.getControls().desander), { bypass: false, auto: false, sp: 0.8 }, 'v3.3 prefs keep the defaults');
      const d = mk(app, { rig: { desander: true } });
      d.setControls(app.toWin({ desander: { bypass: true, auto: true, sp: 0.7 } }), app.toWin({ initial: true }));
      const sd = J(d.getState());
      assert.ok(sd.desander.bypass && sd.desander.auto.on && sd.desander.auto.sp === 0.7, 'saved line-up restored at session start');
      assert.strictEqual(sd.desander.dP_psi, 0, 'bypassed from t = 0');
      assert.strictEqual(sd.alarmLog.filter((e) => e.id === 'DS_BYPASS').length, 0, 'initial restore: no events');
    },
  },
  {
    name: 'WTSDS identity: DS-101 out with a small sand rate (3 pptb, no alarm) — every v3.3 path equals the frozen v3.3 engine (sand is accounting only)',
    wp: WP,
    opts: false,
    timeoutMs: 300000,
    run(app, assert) {
      const A = X.loadEngine('v33'), B = X.loadEngine('work');
      const a = A.create(A.SAMPLE_FLOW, { seed: 7 }), b = B.create(B.SAMPLE_FLOW, { seed: 7, config: { sand: { pptb: 3 } } });
      b.setFault('sandFlowback', false);
      for (let i = 1; i <= 720; i++) {
        a.advance(10); b.advance(10);
        if (i % 120 === 0) {
          const sb = J(b.getState());
          const d = X.identityDiff(J(a.getState()), sb, 5);
          assert.ok(d.length === 0, 't ' + i * 10 + ': ' + d.join('; '));
          assert.ok(sb.sand.on && sb.sand.cum.in_lb > 0 && !sb.desander.inRig, 'sand on, DS-101 out');
        }
      }
    },
  },
  // ── review fixes (sim-equip review round) ──
  {
    name: 'WTSDS review: a dump held while reopening goes back to equalising on resume — interlock 2 (|PB − Pacc| < 75 psi) holds before the isolation reopens',
    wp: WP,
    run(app, assert) {
      const s = mk(app, { rig: { desander: true }, seed: 1, cfg: SAND10 });
      adv(s, 60, 1);
      assert.ok(s.dumpDesander('start').ok, 'start');
      let n = 0;
      while (s.getState().desander.dump.phase !== 'reopen' && n++ < 6000) s.advance(0.5);
      assert.strictEqual(s.getState().desander.dump.phase, 'reopen', 'dump reached reopen');
      s.tripESD('test');
      adv(s, 1800, 10);
      let st = J(s.getState());
      assert.ok(st.desander.dump.phase === 'held' && st.desander.dump.heldFrom === 'reopen', 'held at reopen');
      assert.ok(s.resetESD().ok, 'ESD reset');
      s.advance(1);
      st = J(s.getState());
      assert.ok(Math.abs(st.desander.Pout - st.desander.dump.Pacc) > 1000, 'DS-101 and the accumulator far apart after the shut-in: ' +
        st.desander.Pout.toFixed(0) + ' / ' + st.desander.dump.Pacc.toFixed(0));
      const r = s.dumpDesander('resume');
      assert.ok(r.ok && /equalise/.test(r.msg), 'resumed into equalise: ' + r.msg);
      let prev = J(s.getState()), first = null;
      for (let i = 0; i < 4000 && !first; i++) {
        s.advance(0.25);
        const x = J(s.getState());
        if (x.desander.dump.phase === 'reopen') first = prev; else prev = x;
      }
      assert.ok(first && first.desander.dump.phase === 'equalise', 'the step before the reopen was equalising');
      assert.ok(Math.abs(first.desander.Pout - first.desander.dump.Pacc) < 75 + 5, 'interlock 2 before the reopen (PB still rising after the restart: ± 5 psi in one 0.25 s step): |PB − Pacc| ' +
        (first ? Math.abs(first.desander.Pout - first.desander.dump.Pacc).toFixed(1) : '—'));
      adv(s, 30, 1);
      assert.strictEqual(s.getState().desander.dump.phase, 'idle', 'dump completes');
    },
  },
  {
    name: 'WTSDS review: an entered SITHP drives the wellhead shut-in build-up (5,200 psig, not 1.2 × WHP); 6,000 psig on a 5,000 psi DS-101 trips PSHH-103 on the restart',
    wp: WP,
    run(app, assert) {
      const s = mk(app, { rig: { desander: true }, cfg: { noise: { on: false }, desander: { rating_psi: 5000, sithp_psig: 5200 } } });
      adv(s, 60, 1);
      s.tripESD('test');
      adv(s, 4 * 3600, 20);
      const st = J(s.getState());
      assert.within(st.nodes.wellhead.P, 5100, 5200, 'WHP builds towards the entered SITHP: ' + st.nodes.wellhead.P);
      const b = mk(app, { rig: { desander: true }, cfg: { noise: { on: false } } });
      adv(b, 60, 1); b.tripESD('test'); adv(b, 4 * 3600, 20);
      assert.within(J(b.getState()).nodes.wellhead.P, 3500, 3600, 'blank SITHP: legacy 1.2 × WHP build-up');
      const p = mk(app, { rig: { desander: true }, cfg: { noise: { on: false }, desander: { rating_psi: 5000, sithp_psig: 6000 } } });
      adv(p, 60, 1); p.tripESD('test'); adv(p, 4 * 3600, 20);
      assert.ok(p.resetESD().ok, 'ESD reset');
      let trip = null; p.on('trip', (x) => { if (!trip) trip = x; });
      adv(p, 120, 0.5);
      const sp = J(p.getState());
      assert.ok(sp.esd.tripped && sp.esd.cause === 'DES_PSHH' && trip && trip.tag === 'PSHH-103', 'PSHH-103 on the restart: ' + sp.esd.cause);
    },
  },
  {
    name: 'WTSDS review: PSHH-103 trips at 0.95 × rating (clears below 0.94 ×) whenever SDV-101 is open, also with a zero design velocity',
    wp: WP,
    run(app, assert) {
      // inlet ≈ 4,800 psig: above 0.95 × 5,000 = 4,750, below the rating
      const p = mk(app, { rig: { desander: true }, cfg: { noise: { on: false }, desander: { rating_psi: 5000, sithp_psig: 6000 } }, flow: hpFlow(app, 4800) });
      adv(p, 30, 1);
      let st = J(p.getState());
      assert.ok(st.esd.tripped && st.esd.cause === 'DES_PSHH', 'trip below the rating: ' + st.esd.cause);
      const A = st.alarmLog.filter((e) => e.id === 'DES_PSHH' && e.type === 'raise')[0];
      assert.ok(A && /set point 4750 psig \(95 % of the 5,?000 psi rating\)/.test(A.msg), A && A.msg);
      const q = mk(app, { rig: { desander: true }, cfg: { noise: { on: false }, desander: { rating_psi: 5000, sithp_psig: 6000 } }, flow: hpFlow(app, 4650) });
      adv(q, 60, 1);
      assert.ok(!J(q.getState()).esd.tripped, 'no trip at 4,700 psig (below 0.95 × rating)');
      // zero design velocity (DD.ok false): PSHH-103 still evaluates while SDV-101 is open
      const z = mk(app, { rig: { desander: true }, cfg: { noise: { on: false }, desander: { rating_psi: 5000, sithp_psig: 6000 } },
        flow: hpFlow(app, 5150), edit: (f) => { f.segs[1].vel = 0; } });
      adv(z, 30, 1);
      st = J(z.getState());
      assert.ok(!st.desander.flowing && st.esd.tripped && st.esd.cause === 'DES_PSHH', 'trip with no design flow: ' + st.esd.cause);
    },
  },
  {
    name: 'WTSDS review: the cut-size carrier is blended by GVF — a trace of liquid in a dry-gas well (Qo 0 → 1e-5 bbl/d) moves capture by < 0.01; the SAMPLE_FLOW anchors stay liquid',
    wp: WP,
    run(app, assert) {
      const one = (qo) => {
        const s = mk(app, { rig: { desander: true }, seed: 1, cfg: { noise: { on: false }, sand: { lbPerMMscf: 1 } }, flow: flowOf(app, (f) => { f.inputs.Qo = qo; f.inputs.Qw = 0; }) });
        adv(s, 600, 10);
        return J(s.getState());
      };
      const a = one(0), b = one(1e-5);
      assert.strictEqual(a.desander.carrier, b.desander.carrier, 'same carrier: ' + a.desander.carrier + ' / ' + b.desander.carrier);
      assert.ok(Math.abs(a.desander.eff - b.desander.eff) < 0.01, 'capture ' + a.desander.eff + ' → ' + b.desander.eff);
      assert.rel(b.desander.d50c_um, a.desander.d50c_um, 0.01, 'cut size continuous');
      assert.ok(b.sand.toChoke_lbd < 1e-3, 'sand to the choke stays a trace: ' + b.sand.toChoke_lbd);
      // a sweep through the blend band (GVF 0.95 … 0.995) has no step: neighbouring rates move capture by < 0.05
      let last = null;
      [0, 1, 30, 60, 100, 150, 200, 300, 500].forEach((qo) => {
        const e = one(qo).desander.eff;
        if (last !== null) assert.ok(Math.abs(e - last) < 0.05, 'no step at Qo ' + qo + ': ' + last + ' → ' + e);
        last = e;
      });
    },
  },
];
