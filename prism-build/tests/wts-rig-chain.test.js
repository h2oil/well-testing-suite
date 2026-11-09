// Well Test Simulator — release 3.4.2 (WTS_sim code comments v1.7.0): the rig-up chain — an item taken out sends its flow to the next
// item downstream (rigup-next design §B–D; INTEGRATION E4, C2, C3, C18). (a) the normRigup chain matrix, (b) 'v341' / no options =
// the frozen v3.4.1 rules, (c)–(k) the engine: V-101 out to the surge tank (low gas, default gas → PSHH-201 ESD, route both, the
// last-inlet refusal, FS-401 out → cold vent, cushion), T-301 out → the P-201 booster, FS-401 out with V-101 in, T-202 for T-201.
'use strict';

const X = require('./_wts-equip-shapes');
const CH = require('./_wts-chain-shapes');

const WP = 'WTSRC';
const J = (o) => JSON.parse(JSON.stringify(o));
let W0 = null;
const work = () => (W0 = W0 || X.loadEngine('work'));
const st = (sim) => J(sim.getState());
function run(sim, secs, dt, cb) {
  const n = Math.round(secs / dt);
  for (let i = 0; i < n; i++) { sim.advance(dt); if (cb && cb(st(sim), i)) return true; }
  return false;
}
const active = (s, id) => s.alarms.some((a) => a.id === id);
const logged = (s, id) => s.alarmLog.some((a) => a.id === id);
function balanced(assert, s, tol, tag) {
  const m = s.health.massErr;
  assert.ok(Math.abs(m.oil) < tol && Math.abs(m.water) < tol && Math.abs(m.gas) < tol, tag + ' balances ' + JSON.stringify(m));
}
function mk(o) {
  o = o || {};
  const S = work(), f = J(S.SAMPLE_FLOW);
  Object.assign(f.inputs, o.inputs || {}); Object.assign(f.sim, o.sim || {});
  const opts = { seed: o.seed || 3 };
  if (o.rigup) opts.rigup = o.rigup;
  if (o.config) opts.config = o.config;
  return S.create(f, opts);
}
const CORE = ['heater', 'separator', 'surge', 'gauge', 'pump', 'flare'];

module.exports = [
  {
    name: 'WTSRC (a) normRigup chain matrix: every core combination × 3 destinations × T-202 in / out — routes name the next item in, the destination falls back with no pressurised tank, FS-401 / P-201 rules',
    wp: WP, opts: false,
    run(app, assert) {
      const S = work();
      assert.strictEqual(S.RIG_ROUTING_DEF, 'chain'); assert.strictEqual(S.features.rigChain, true); assert.strictEqual(J(S.DEFAULTS.rig).routing, 'chain');
      let n = 0;
      for (let m = 0; m < (1 << CORE.length); m++) for (const d of CH.DESTS) for (const t2 of [false, true]) {
        const req = { surge2: t2 }; CORE.forEach((k, i) => { req[k] = !!(m & (1 << i)); });
        const r = S.normRigup(req, { sepByDest: d, P: 150, routing: 'chain' }), g = r.rig, tag = JSON.stringify(req) + ' ' + d;
        n++;
        assert.strictEqual(r.routing, 'chain', tag); assert.ok(CH.DESTS.indexOf(r.dest) >= 0, tag);
        assert.ok(g.esd && g.choke, tag + ' locked');
        assert.strictEqual(g.surge2, t2, tag + ' T-202 kept (chain)');
        const tank = g.surge || g.surge2;
        if (d === 'surge' && !g.separator && !tank) assert.ok(r.dest === 'flare' && r.notes.indexOf(CH.NOTES.noTankFallback) >= 0, tag + ' fallback');
        else assert.strictEqual(r.dest, d, tag + ' dest');
        if (!g.separator && !g.flare) assert.ok(r.dest === 'line' || r.dest === 'surge', tag + ' FS-401 forced in only for flare');
        if (!req.flare && !req.separator && r.dest === 'flare') assert.ok(g.flare, tag + ' FS-401 forced in');
        if (!g.gauge && req.pump) assert.strictEqual(g.pump, tank, tag + ' P-201 booster only with a surge tank');
        CH.ROUTE_KEYS.forEach((k) => {
          const v = r.routes[k];
          assert.strictEqual(typeof v, 'string', tag + ' route ' + k);
          if (g[k] && v !== '') assert.fail(tag + ' route of an item in must be empty: ' + k + ' = ' + v);
        });
        CORE.forEach((k) => { if (!g[k] && k !== 'pump') assert.ok(r.routes[k] !== '', tag + ' receiver of ' + k); });
        if (!g.separator) assert.strictEqual(r.routes.separator, r.dest === 'surge' ? (g.surge ? 'T-201' : 'T-202') : r.dest === 'line' ? 'production line' : 'burner / flare line', tag);
        if (!g.surge) assert.strictEqual(r.routes.surge, g.surge2 ? 'T-202' : (g.gauge ? 'T-301' : 'export / burner line'), tag);
        if (!g.heater) assert.strictEqual(r.routes.heater, g.separator ? 'V-101' : r.routes.separator, tag);
        if (!g.gauge) assert.strictEqual(r.routes.gauge, g.pump ? 'P-201 → export' : 'export / burner line', tag);
        if (!g.flare) assert.strictEqual(r.routes.flare, 'export + vent', tag);
        assert.strictEqual(r.sig.length, 11, tag + ' sig');
      }
      assert.strictEqual(n, 64 * 3 * 2);
      // the one-item-out table of the fixture (dest 'surge')
      const o = { sepByDest: 'surge', P: 150, routing: 'chain' };
      const pick = (r) => { const p = {}; Object.keys(r.routes).forEach((k) => { if (r.routes[k] && !(k in CH.ROUTES_DEFAULT_OPTIONAL)) p[k] = r.routes[k]; }); return p; };
      assert.deepStrictEqual(pick(S.normRigup({ heater: false }, o)), CH.ROUTES.heater);
      assert.deepStrictEqual(pick(S.normRigup({ separator: false }, o)), CH.ROUTES.separator);
      assert.deepStrictEqual(pick(S.normRigup({ surge: false }, o)), CH.ROUTES.surge);
      assert.deepStrictEqual(pick(S.normRigup({ surge: false, surge2: true }, o)), CH.ROUTES.surgeWithT202);
      assert.deepStrictEqual(pick(S.normRigup({ gauge: false }, o)), CH.ROUTES.gauge);
      assert.deepStrictEqual(pick(S.normRigup({ flare: false }, o)), CH.ROUTES.flare);
      assert.ok(S.normRigup({ heater: false }, o).notes.indexOf(CH.NOTES.heater) >= 0, 'H-101 note');
      assert.ok(S.normRigup({ gauge: false }, o).notes.indexOf(CH.NOTES.booster) >= 0, 'booster note');
      assert.ok(S.normRigup({ gauge: false, surge: false }, o).notes.indexOf(CH.NOTES.nothingToPump) >= 0, 'nothing to pump');
      assert.ok(S.normRigup({ separator: false, flare: false }, o).notes.indexOf(CH.NOTES.coldVent) >= 0, 'cold vent note');
      assert.ok(S.normRigup({ separator: false }, o).notes[0].indexOf(CH.NOTES.surgeDestPrefix) === 0, 'surge destination note');
    },
  },
  {
    name: 'WTSRC (b) normRigup with routing v341 and with no options === the frozen v3.4.1 normRigup (rig, notes, sig, full, extras) on every combination',
    wp: WP, opts: false,
    run(app, assert) {
      const S = work(), F = X.loadEngine('v341');
      const keys = CORE.concat(['surge2', 'desander', 'heaterChoke']);
      for (let m = 0; m < (1 << keys.length); m += 3) for (const d of [undefined].concat(CH.DESTS)) {
        const req = {}; keys.forEach((k, i) => { req[k] = !!(m & (1 << i)); });
        const o = d === undefined ? undefined : { sepByDest: d, P: 200, routing: 'v341' };
        const a = J(F.normRigup(req, d === undefined ? undefined : { sepByDest: d, P: 200 })), b = J(S.normRigup(req, o)), tag = JSON.stringify(req) + ' ' + d;
        ['rig', 'notes', 'sig', 'full', 'extras'].forEach((k) => assert.deepStrictEqual(b[k], a[k], tag + ' ' + k));
        assert.strictEqual(b.routing, 'v341', tag);
      }
    },
  },
  {
    name: 'WTSRC (c) V-101 out to the surge tank, low gas (0.05 MMscf/d): no trip, balances < 1e-9, T-301 batches, cum.toSurge_* = the inflow, no well stream at the flare, PCV-201 near SP',
    wp: WP, opts: false, timeoutMs: 300000,
    run(app, assert) {
      const sim = mk(CH.LOW_GAS);
      let s = st(sim), sumP = 0, n = 0;
      assert.ok(s.rigup.dest === 'surge' && s.rigup.routes.separator === 'T-201' && s.sepBy.dest === 'surge' && s.sepBy.recv === 'T-201', 'destination');
      assert.ok(Math.abs(s.sepBy.gasCap_mmscfd / CH.GAS_CAP.lp_mmscfd - 1) < CH.GAS_CAP.rel, 'gas cap ' + s.sepBy.gasCap_mmscfd);
      assert.ok(!active(s, 'SEPBY_SURGE_CAP'), 'low gas: no SEPBY_SURGE_CAP');
      run(sim, 7200, 10, (x) => { sumP += x.surge.P; n++; return false; });
      s = st(sim);
      assert.ok(!s.esd.tripped, 'no trip: ' + s.esd.cause);
      balanced(assert, s, 1e-9, 'surge destination');
      assert.ok(s.gauge.batches.length >= 1, 'T-301 batches');
      assert.ok(Math.abs(s.cum.toSurge_oil_stb - s.cum.oilIn_stb) < 1e-6 && Math.abs(s.cum.toSurge_water_bbl - s.cum.waterIn_bbl) < 1e-6 &&
        Math.abs(s.cum.toSurge_gas_mscf - s.cum.gasIn_mmscf * 1000) < 1e-6, 'toSurge = the inflow');
      assert.ok(s.cum.liquidToFlareOil_stb === 0 && s.cum.flare_mmscf * 1000 <= s.cum.lpGas_mscf + 1e-9, 'no whole stream at the flare (only the LP line gas)');
      assert.ok(Math.abs(sumP / n - 25) < 1.5, 'T-201 near its SP: ' + (sumP / n));
      assert.ok(s.surge.wellStream && s.lines.sepby_surge.active && s.lp.on && s.rates.separated === false && s.rates.gorTot_scf_stb === null, 'flags');
    },
  },
  {
    name: 'WTSRC (d) V-101 out to the surge tank at the default 10 MMscf/d: SEPBY_SURGE_CAP at once, PSHH-201 shuts the well in within 15 s, PSV-201 not lifted',
    wp: WP, opts: false,
    run(app, assert) {
      const sim = mk({ sim: { sepByDest: 'surge' }, rigup: { separator: false }, config: { noise: { on: false } } });
      sim.advance(0.5);
      let s = st(sim);
      assert.ok(active(s, 'SEPBY_SURGE_CAP'), 'SEPBY_SURGE_CAP');
      assert.ok(/Whole stream to T-201: .* gas against PCV-201 capacity .* at PSHH-201 — the well will be shut in/.test(s.alarms.find((a) => a.id === 'SEPBY_SURGE_CAP').msg), 'text');
      let lifted = false;
      assert.ok(run(sim, 15, 0.5, (x) => { lifted = lifted || x.surge.psv.lifting; return x.esd.tripped; }), 'ESD within 15 s');
      s = st(sim);
      assert.ok(s.esd.cause === 'PSHH_SURGE' && !lifted && s.surge.P <= s.surge.mawp, 'PSHH-201 before PSV-201: ' + s.esd.cause);
    },
  },
  {
    name: 'WTSRC (e)+(f) route both doubles the gas capacity and shares the stream; shutting the last open inlet is refused and logged, auto-divert still swaps A / B',
    wp: WP, opts: false, timeoutMs: 300000,
    run(app, assert) {
      const sim = mk(Object.assign({}, CH.LOW_GAS, { rigup: { separator: false, surge2: true } }));
      const c1 = st(sim).sepBy.gasCap_mmscfd;
      assert.ok(sim.setSurgeRoute('both').ok);
      run(sim, 600, 10);
      let s = st(sim);
      assert.ok(Math.abs(s.sepBy.gasCap_mmscfd / c1 - CH.GAS_CAP.bothFactor) < 0.05, 'cap ×2: ' + s.sepBy.gasCap_mmscfd / c1);
      assert.ok(s.sepBy.recv === 'both' && s.surge2.wellStream && s.surge.wellStream && s.surge2.share > 0.2 && s.surge2.share < 0.8, 'shares ' + s.surge2.share);
      balanced(assert, s, 1e-9, 'both');
      const r = mk(CH.LOW_GAS);
      assert.strictEqual(r.setValve('surge', 0, false), false, 'XV-201A close refused');
      assert.ok(st(r).alarmLog.some((e) => e.msg === CH.LOG.refusedClose), 'logged');
      const ev = [];
      r.on('divert', (p) => ev.push(p));
      assert.ok(run(r, 4 * 3600, 10, () => ev.length > 0), 'auto-divert A → B still happens');
      s = st(r);
      assert.ok(s.surge.comps[1].inlet && !s.surge.comps[0].inlet, 'B fills');
    },
  },
  {
    name: 'WTSRC (g)+(h) V-101 and FS-401 out to the surge tank: the tank gas vents (SEPBY_VENT, cum.toVent); a cushion to the surge tank: out.surge, no CUSH_BURNER, the LCV-201 start warning',
    wp: WP, opts: false, timeoutMs: 300000,
    run(app, assert) {
      const v = mk(Object.assign({}, CH.LOW_GAS, { rigup: { separator: false, flare: false } }));
      let s = st(v);
      assert.ok(s.rigup.flare === false && s.rigup.dest === 'surge' && s.lp.to === 'vent' && s.rigup.notes.indexOf(CH.NOTES.coldVent) >= 0, 'cold vent allowed');
      run(v, 3600, 10); s = st(v);
      assert.ok(active(s, 'SEPBY_VENT') && s.cum.toVent_gas_mscf > 0 && s.cum.flare_mmscf === 0, 'vents: ' + s.cum.toVent_gas_mscf);
      balanced(assert, s, 1e-9, 'vent');
      const c = mk({ inputs: { Qg: 0.05 }, sim: { sepByDest: 'surge' }, rigup: { separator: false } });
      const w = c.startCushion({ q: 6000 });
      assert.ok(w.ok && /LCV-201 passes .* bbl\/d at 25 psig: T-201 will fill to LSHH-201/.test(w.warn), 'start warning: ' + w.warn);
      c.stopCushion();
      assert.ok(c.startCushion({ q: 1500 }).ok);
      run(c, 3600, 10); s = st(c);
      assert.ok(s.cushion.out.surge > 0 && s.cushion.out.flare === 0 && !logged(s, 'CUSH_BURNER'), 'cushion to the surge tank: ' + JSON.stringify(s.cushion.out));
    },
  },
  {
    name: 'WTSRC (i) T-301 out: P-201 boosts the T-201 transfer to export (+30 psi, mode booster); P-201 failed → PUMP_FAIL, T-201 fills, LSHH-201 ESD',
    wp: WP, opts: false, timeoutMs: 300000,
    run(app, assert) {
      const sim = mk({ rigup: { gauge: false }, config: { noise: { on: false } } });
      let s = st(sim);
      assert.ok(s.rigup.pump === true && s.rigup.routes.gauge === 'P-201 → export' && s.gauge.pump.mode === 'booster' && s.gauge.pump.suction === 'transfer', 'booster');
      const ref = mk({ rigup: { gauge: false }, config: { noise: { on: false }, rig: { routing: 'v341' } } });
      assert.ok(st(ref).rigup.pump === false, 'v341: P-201 out');
      run(sim, 1800, 10); run(ref, 1800, 10);
      const a = st(sim), b = st(ref);
      assert.ok(Math.abs(a.surge.pump.dP_psi - b.surge.pump.dP_psi - CH.BOOST_HEAD_PSI) < 2, 'ΔP + head: ' + a.surge.pump.dP_psi + ' vs ' + b.surge.pump.dP_psi);
      assert.ok(a.gauge.pump.on && a.cum.drainedOil_stb > 0, 'transfers to export');
      balanced(assert, a, 1e-9, 'booster');
      sim.setFault('surgePumpFail', true);
      assert.ok(run(sim, 6 * 3600, 10, (x) => x.esd.tripped), 'ESD');
      s = st(sim);
      assert.ok(logged(s, 'PUMP_FAIL') && s.esd.cause === 'LSHH_SURGE', 'PUMP_FAIL then LSHH-201: ' + s.esd.cause);
    },
  },
  {
    name: 'WTSRC (j) FS-401 out with V-101 in: separator gas to the export line (cum.toLine), PCV-201 / PSV gas to vent, lp.to vent, balances',
    wp: WP, opts: false, timeoutMs: 300000,
    run(app, assert) {
      const sim = mk({ rigup: { flare: false } });
      run(sim, 3600, 10);
      const s = st(sim);
      assert.ok(s.cum.toLine_gas_mscf > 100 && s.cum.toVent_gas_mscf > 0 && s.cum.flare_mmscf === 0 && s.lp.to === 'vent', 'sinks ' + JSON.stringify([s.cum.toLine_gas_mscf, s.cum.toVent_gas_mscf, s.cum.flare_mmscf]));
      assert.ok(Math.abs(s.cum.toVent_gas_mscf - s.cum.lpGas_mscf) < 1e-6, 'the LP gas is the vent gas (no PSV lift)');
      balanced(assert, s, 1e-9, 'FS-401 out');
    },
  },
  {
    name: 'WTSRC (k) T-201 out with T-202 in: T-202 takes all the dumps (share 1, route surge2), inventory conserved, routes T-201 / T-301 refused, no ESD',
    wp: WP, opts: false, timeoutMs: 300000,
    run(app, assert) {
      const sim = mk({ rigup: { surge: false, surge2: true } });
      let s = st(sim);
      assert.ok(s.rigup.surge2 && !s.rigup.surge && s.rigup.routes.surge === 'T-202' && s.surge2.route === 'surge2' && (s.surge2.comps[0].inlet || s.surge2.comps[1].inlet), 'T-202 lined up at start');
      run(sim, 4 * 3600, 10); s = st(sim);
      assert.ok(!s.esd.tripped && s.surge2.share === 1 && s.surge2.frac > 0.05 && s.lp.on, 'T-202 alone: ' + s.surge2.share);
      balanced(assert, s, 1e-9, 'T-202 alone');
      assert.ok(!sim.setSurgeRoute('both').ok && !sim.setSurgeRoute('surge').ok, 'T-201 routes refused');
      assert.ok(st(sim).alarmLog.some((e) => e.msg === CH.LOG.routeRefused), 'logged');
      const t = mk({ rigup: { surge2: true } }), ev = [];
      t.on('rigup', (p) => ev.push(p.msg));
      assert.strictEqual(t.setRigup({ surge: false }), true);
      s = st(t);
      assert.ok(s.rigup.surge2 && (s.surge2.comps[0].inlet || s.surge2.comps[1].inlet) && ev.some((m) => m.indexOf(CH.LOG.standIn) >= 0), 'toggle: ' + ev.join(' | '));
      run(t, 1800, 10);
      assert.ok(!st(t).esd.tripped && !logged(st(t), 'SURGE_BLOCKED'), 'no dead-head');
      assert.strictEqual(t.setRigup({ surge: true }), true);
      run(t, 600, 10); s = st(t);
      assert.ok(s.rigup.surge && s.surge2.route !== 'none' && !s.esd.tripped, 'T-201 back: route ' + s.surge2.route);
    },
  },
  {
    name: 'WTSRC (l) 3.4.2 review: T-201 out, both T-202 inlets shut → SURGE_BLOCKED names XV-202A / XV-202B and T-202 (tag XV-202, eq surge2), never XV-301 / T-301; the LSHH-102 ESD follows',
    wp: WP, opts: false, timeoutMs: 300000,
    run(app, assert) {
      const sim = mk({ rigup: { surge: false, surge2: true } });
      run(sim, 300, 1);
      sim.setValve('surge2', 0, false); sim.setValve('surge2', 1, false);
      run(sim, 150, 1);
      const s = st(sim), e = s.alarmLog.find((x) => x.id === 'SURGE_BLOCKED');
      assert.ok(e, 'SURGE_BLOCKED raised');
      assert.strictEqual(e.tag, 'XV-202', 'tag');
      assert.strictEqual(e.msg, 'XV-202A / XV-202B closed — separator dumps blocked (no route to T-202)', e.msg);
      assert.ok(!s.alarmLog.some((x) => /XV-301|T-301\)/.test(x.msg) && x.id === 'SURGE_BLOCKED'), 'no gauge-tank wording');
      assert.ok(s.esd.tripped && s.esd.cause === 'LSHH_SEP', 'ESD by LSHH-102: ' + s.esd.cause);
      const pub = J(sim.getState()).alarms.find((a) => a.id === 'SURGE_BLOCKED');
      assert.ok(!pub || pub.eq === 'surge2', 'eq surge2');
    },
  },
  {
    name: 'WTSRC (m) 3.4.2 review: V-101 out to T-202 (T-201 out, or T-201 in with route T-202): SEPBY_SURGE_CAP, the rig note and segment 5 name T-202 / PCV-203 / PSHH-202 and the bypass run (no FI-Sep→Flare); route both names both',
    wp: WP, opts: false, timeoutMs: 300000,
    run(app, assert) {
      // T-201 out: the rig note, the alarm (raised at once), the segment label + the velocity alarm tag
      const a = mk({ sim: { sepByDest: 'surge' }, rigup: { separator: false, surge: false, surge2: true }, config: { noise: { on: false } } });
      let s = st(a);
      const note = s.rigup.notes.find((n) => /^V-101 bypassed/.test(n));
      assert.ok(/surge tank T-202 \(gas through PCV-203 to the LP flare line/.test(note) && /PCV-203 can pass, PSHH-202 shuts the well in\.$/.test(note) && !/PCV-201|PSHH-201/.test(note), note);
      assert.strictEqual(s.segs[4].label, 'V-101 bypass→T-202', 'segment 5 label');
      a.advance(0.5); s = st(a);
      const c = s.alarms.find((x) => x.id === 'SEPBY_SURGE_CAP');
      assert.ok(c && c.tag === 'PCV-203' && /^Whole stream to T-202: .* gas against PCV-203 capacity .* at PSHH-202 — /.test(c.msg), c && c.msg);
      run(a, 20, 0.5);
      s = st(a);
      assert.ok(!s.alarmLog.some((x) => /Sep→Flare/.test(x.tag + ' ' + x.msg)), 'no Sep→Flare alarm on the bypass route');
      // the default 'surge' rig with a segment-5 limit below its velocity (the page's own flow): VEL_sep_flare names the bypass run
      const fv = J(work().SAMPLE_FLOW); fv.segs[4].ve = 50; fv.sim.sepByDest = 'surge';
      const v = work().create(fv, { seed: 3, rigup: { separator: false }, config: { noise: { on: false } } });
      let zV = null;
      run(v, 10, 0.5, (x) => { zV = x.alarms.find((y) => y.id === 'VEL_sep_flare') || zV; return !!zV; });
      assert.ok(zV && zV.tag === 'FI-V-101 bypass→T-201' && /^V-101 bypass→T-201: velocity /.test(zV.msg), 'velocity alarm ' + JSON.stringify(zV));
      // T-201 in, route T-202 (the review case): the text follows the receiving tank once T-201's inlets are shut
      const b = mk({ inputs: { Qg: 0.5 }, sim: { sepByDest: 'surge' }, rigup: { separator: false, surge2: true }, config: { noise: { on: false } } });
      assert.ok(b.setSurgeRoute('surge2').ok);
      run(b, 20, 0.5); s = st(b);
      assert.ok(!s.surge.comps[0].inlet && !s.surge.comps[1].inlet && s.sepBy.recv === 'T-202', 'T-202 receives');
      const d = s.alarms.find((x) => x.id === 'SEPBY_SURGE_CAP');
      assert.ok(d && d.tag === 'PCV-203' && /^Whole stream to T-202: 0\.50 MMSCFD gas against PCV-203 capacity .* at PSHH-202/.test(d.msg), d && d.msg);
      assert.ok(Math.abs(s.sepBy.gasCap_mmscfd - parseFloat(/capacity ([0-9.]+)/.exec(d.msg)[1])) < 0.01, 'text capacity = gasCap ' + s.sepBy.gasCap_mmscfd);
      assert.strictEqual(s.segs[4].label, 'V-101 bypass→T-202');
      // route both: both tanks named
      const c2 = mk({ inputs: { Qg: 0.5 }, sim: { sepByDest: 'surge' }, rigup: { separator: false, surge2: true }, config: { noise: { on: false } } });
      assert.ok(c2.setSurgeRoute('both').ok);
      run(c2, 20, 0.5); s = st(c2);
      const e = s.alarms.find((x) => x.id === 'SEPBY_SURGE_CAP');
      assert.ok(e && /^Whole stream to T-201 and T-202: .* PCV-201 and PCV-203 capacity .* at PSHH-201 and PSHH-202/.test(e.msg) && s.segs[4].label === 'V-101 bypass→T-201 / T-202', e && e.msg);
      // V-101 in: segment 5 keeps its v1.7.0 label
      assert.strictEqual(st(mk({})).segs[4].label, 'Sep→Flare');
    },
  },
  {
    name: 'WTSRC (n) 3.4.2 review: V-101 out to the surge tank at the default 10 MMscf/d — T-201 peaks ≈ 62–64 psig after the PSHH-201 ESD (≈ 125 % of its 50 psig MAWP): OVP_SURGE (> 110 %, marked > 121 %) and SEPBY_PSV_CAP (relief capacity < stream gas); T-202 alone peaks ≈ 54 psig (SEPBY_PSV_CAP, no OVP_SURGE2) and ≈ 67 psig at 20 MMscf/d (OVP_SURGE2); low gas: none',
    wp: WP, opts: false, timeoutMs: 300000,
    run(app, assert) {
      const peak = (o, key) => {
        const sim = mk(o); let pk = 0;
        run(sim, 60, 0.5, (x) => { pk = Math.max(pk, x[key].P); });
        return { pk, s: st(sim) };
      };
      const base = { sim: { sepByDest: 'surge' }, config: { noise: { on: false } } };
      let r = peak(Object.assign({}, base, { rigup: { separator: false } }), 'surge');
      assert.ok(r.pk > 60 && r.pk < 66 && r.s.surge.mawp === 50, 'T-201 peak ' + r.pk);
      assert.ok(r.s.esd.tripped && r.s.esd.cause === 'PSHH_SURGE', 'PSHH-201 ESD');
      let o = r.s.alarmLog.filter((x) => x.id === 'OVP_SURGE');
      assert.ok(o.length >= 1 && o[0].tag === 'T-201' && /^T-201 over-pressure: .* above 110 % of its MAWP 50 psig/.test(o[0].msg), o[0] && o[0].msg);
      assert.ok(o.some((x) => /\(above 121 %, the fire-case limit\)/.test(x.msg)), 'the 121 % mark: ' + o.map((x) => x.msg).join(' | '));
      const last = o[o.length - 1].msg, shown = parseFloat(/over-pressure: ([0-9.]+)/.exec(last)[1]);
      assert.ok(Math.abs(shown - r.pk) < 0.6, 'the text follows the peak: ' + shown + ' vs ' + r.pk);
      assert.ok(!r.s.alarms.some((x) => x.id === 'OVP_SURGE'), 'cleared below 105 % of MAWP');
      ['OVP_SURGE', 'SEPBY_PSV_CAP'].forEach((id) => {
        const e = r.s.alarmLog.find((x) => x.id === id), F = CH.OVP_ALARMS[id] || CH.SEPBY_ALARMS[id];
        assert.ok(e && e.tag === F.tag && e.sev === F.sev && CH.Q_SEPBY.indexOf('SEPBY_PSV_CAP') >= 0, id + ' = the fixture ' + JSON.stringify(e));
      });
      const pc = r.s.alarmLog.find((x) => x.id === 'SEPBY_PSV_CAP');
      assert.ok(pc && pc.tag === 'PSV-201' && /^Whole stream to T-201: 10\.00 MMSCFD gas against a relief capacity of ([0-9.]+) MMSCFD \(PCV-201 \+ PSV-201 at 110 % of MAWP\)/.test(pc.msg), pc && pc.msg);
      r = peak(Object.assign({}, base, { rigup: { separator: false, surge: false, surge2: true } }), 'surge2');
      assert.ok(r.pk > 51 && r.pk < 55 && r.s.esd.cause === 'PSHH_SURGE2', 'T-202 peak ' + r.pk);
      assert.ok(!r.s.alarmLog.some((x) => x.id === 'OVP_SURGE2' || x.id === 'OVP_SURGE'), 'within 110 %: no OVP');
      assert.ok(r.s.alarmLog.some((x) => x.id === 'SEPBY_PSV_CAP' && x.tag === 'PSV-202' && /PCV-203 \+ PSV-202/.test(x.msg)), 'SEPBY_PSV_CAP on T-202');
      r = peak(Object.assign({}, base, { inputs: { Qg: 20 }, rigup: { separator: false, surge: false, surge2: true } }), 'surge2');
      o = r.s.alarmLog.filter((x) => x.id === 'OVP_SURGE2');
      assert.ok(r.pk > 60 && o.length >= 1 && o[0].tag === 'T-202' && /^T-202 over-pressure: .*PSV-202 can relieve$/.test(o[0].msg), r.pk + ' ' + (o[0] && o[0].msg));
      const lo = mk(CH.LOW_GAS);
      run(lo, 600, 5);
      const ls = st(lo);
      assert.ok(!ls.alarmLog.some((x) => /^OVP_|SEPBY_PSV_CAP/.test(x.id)), 'low gas: none');
      // the default rig (V-101 in): the alarm table has neither id until needed
      const d = mk({}); run(d, 600, 10);
      assert.ok(!st(d).alarmLog.some((x) => /^OVP_|SEPBY_PSV_CAP/.test(x.id)), 'default: none');
    },
  },
];
