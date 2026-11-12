// Well Performance B, WP26 — the electrical submersible pump (49-calc-wp-esp.js, the pump node of 49-calc-wp-system.js, the page part
// 49-calc-wp-espui.js). docs/WELL-PERFORMANCE-PLAN.md §1.3 US17, §7.3, §9 (the ESP frequency axis), §15.1 (no verified published example:
// Q9 — the provisional gate), §15.2 identities, §16, §17.3.
//
// ES1  pump record: the example's BEP, the curve through every table row at f0, efficiency from BHP and BHP from efficiency, the
//      assumed ±30 % range, bad records refused (NEEDS_PUMP / BAD_PUMP)
// ES2  affinity laws exactly (q ∝ f, H ∝ f², P ∝ f³) on the curve, the fan and the range
// ES3  viscosity (Turzo et al. 2000): water (1 cSt) is the identity, the raw factors are the published polynomials, the factors fall
//      with viscosity and stay in [0.1, 1], Q* > 40 flagged
// ES4  natural separation (Harmathy rise velocity, E = v∞/(v∞ + v_SL)) and the Turpin φ by hand; separator in series
// ES5  stage by stage: a water pump gives Δp = ρ_w · N · H(Q) / 144 at constant Q (hand), BHP = Q·H·SG/(135,770 η), free gas lowers the
//      mixture density and raises the intake rate
// ES6  the pump in the system: at the operating point the discharge pressure the pump makes = the pressure the tubing needs (≤ 0.1 psi
//      at the root), bottom and wellhead nodes agree (≤ 0.5 % in q), the breakdown closes on p̄r − p_sep with the pump as a gain, the
//      schematic mark and R.lift fields, a non-flowing well flows with the pump
// ES7  top-down without inflow (lift tables): BHP at the operating rate and THP = the bottom-node pwf (≤ 0.15 %), the FREQ lift axis
//      (BHP falls as the frequency rises), no axis keeps the model's pump
// ES8  more frequency or more stages → more rate (monotone); a frequency handle drag equals a typed frequency
// ES9  sizeStages: the stages for a target bracket it (N delivers ≥ the target, N − 1 delivers less); designFor {freq} reaches the rate
// ES10 sweep Job: the row at the model frequency = the single solve (≤ 0.5 %), rows ascending in rate, cancel keeps finished rows
// ES11 motor and cable by hand (load, current, √3·I·R·L at the mean cable temperature, surface voltage, kVA, cooling velocity); flags:
//      overload, range, gas, dogleg at the setting depth on a deviated well
// ES12 model and checks: wp_esp_* scalars → M.lift.esp, the pump table cleaned, check() errors (NEEDS_PUMP, NEEDS_STAGES, ESP_FREQ,
//      gas well), validity rows provisional, the solver refuses a gas well
// ES13 page: the ESP example — step ④ cards, #wp_res card visible with KPI chips, the pump plot (range band, fan, need curve,
//      operating point, FREQ / STAGES rails), schematic ESP mark with stages / Hz and MD · TVD, KPI strip, studies row, report capture,
//      a stages drag re-solves live and commits, the pump table edit writes the model, the device library, CSV and no NaN
'use strict';

const S = require('./_wellperf-shapes');

const WP = 'WP26';
const app = (ctx) => S.sharedApp(ctx);
const run = (job) => { let s, n = 0; do { s = job.step(); n++; } while (!s.done && n < 2000); return job.result(); };
const txt = (e) => String(e && e.textContent || '').replace(/\s+/g, ' ').trim();
const BAD = /NaN|undefined|Infinity|\[object Object\]/;
const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
// FIX.oilWell depleted and wet, a full 7" casing, the generic example pump at 7,900 ft MD
function espWell(G, o) {
  const M = S.FIX.oilWell; M.res.pr = 2200; M.fluid.wc = 0.6;
  M.well.strings.push({ kind: 'casing', tubKey: null, rough: 0.0006, topMd: 0, botMd: 7950, id: 6.276, od: 7, wall: 0.362 });
  M.lift = { type: 'esp', gl: {}, esp: Object.assign({ pump: G.WTS_wp_esp.example(), pumpMd: 7900, freq: 60, stages: 120 }, o || {}) };
  return M;
}
const _memo = new Map();
const solve = (G, M) => { const k = JSON.stringify(M); if (!_memo.has(k)) _memo.set(k, G.WTS_wp_system.solve(M)); return _memo.get(k); };

module.exports = [
  {
    name: 'ES1 pump record: example BEP, curve through the rows, efficiency ↔ BHP fill, assumed range, bad records refused',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const E = app(ctx).win.WTS_wp_esp, ex = E.example(), n = E.normPump(ex);
      assert.ok(n.ok && Math.abs(n.pump.bep.q - 1500) < 60 && n.pump.bep.eff > 0.62, 'BEP ' + n.pump.bep.q + ' / ' + n.pump.bep.eff);
      const c = E.curve(n.pump, 60);
      ex.rows.forEach((r) => { assert.ok(Math.abs(c.head(r[0]) - r[1]) < 1e-9, 'head at ' + r[0]); if (r[2] > 0) assert.ok(Math.abs(c.eff(r[0]) - r[2] / 100) < 1e-9, 'eff at ' + r[0]); });
      assert.ok(Math.abs(c.range.qMin - 1000) < 1e-9 && Math.abs(c.range.qMax - 2100) < 1e-9 && !c.range.assumed, 'table range');
      // efficiency from BHP (and BHP from efficiency): η = q·H / (135,770·BHP)
      const rowsB = ex.rows.map((r) => [r[0], r[1], null, r[3]]), nb = E.normPump({ rows: rowsB });
      assert.ok(nb.ok, plain(nb.errors));
      [600, 1500].forEach((q) => { const r = ex.rows.find((x) => x[0] === q); assert.ok(Math.abs(nb.pump.eff[ex.rows.indexOf(r)] - q * r[1] / (135770 * r[3])) < 1e-12, 'η from BHP at ' + q); });
      const ne = E.normPump({ rows: ex.rows.map((r) => [r[0], r[1], r[2], null]) }), i15 = ex.rows.findIndex((r) => r[0] === 1500);
      assert.ok(Math.abs(ne.pump.bhp[i15] - 1500 * ex.rows[i15][1] / (135770 * ex.rows[i15][2] / 100)) < 1e-12, 'BHP from η');
      assert.ok(ne.pump.range.assumed && Math.abs(ne.pump.range.qMin - 0.7 * ne.pump.bep.q) < 1e-9 && ne.warnings.some((w) => w.code === 'PUMP_RANGE_ASSUMED'), 'assumed range ±30 %');
      assert.strictEqual(E.normPump(null).code, 'NEEDS_PUMP');
      assert.strictEqual(E.normPump({ rows: [[0, 30, 0], [500, 29, 30]] }).code, 'NEEDS_PUMP');
      assert.strictEqual(E.normPump({ rows: [[0, 30], [500, 29], [900, 25]] }).code, 'BAD_PUMP');
    },
  },
  {
    name: 'ES2 affinity laws exact on the curve, the fan and the range (q ∝ f, H ∝ f², P ∝ f³)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const E = app(ctx).win.WTS_wp_esp, P = E.normPump(E.example()).pump, c60 = E.curve(P, 60);
      [40, 50, 70].forEach((f) => {
        const r = f / 60, c = E.curve(P, f);
        [300, 1200, 2100].forEach((q) => {
          assert.ok(Math.abs(c.head(q * r) - r * r * c60.head(q)) < 1e-9, f + ' Hz head at ' + q);
          assert.ok(Math.abs(c.eff(q * r) - c60.eff(q)) < 1e-12, f + ' Hz efficiency at ' + q);
          assert.ok(Math.abs(c.bhp(q * r, 1) - r * r * r * c60.bhp(q, 1)) < 1e-9 * c60.bhp(q, 1) + 1e-12, f + ' Hz BHP at ' + q);
        });
        assert.ok(Math.abs(c.range.qMin - 1000 * r) < 1e-9 && Math.abs(c.bep.q - c60.bep.q * r) < 1e-9, f + ' Hz range and BEP');
      });
      const fan = E.fan(P, [50, 60], 100);
      assert.ok(fan.length === 2 && Math.abs(fan[1].pts[0][1] - 100 * c60.head(0)) < 1e-9, 'fan = stages × head');
      assert.ok(E.METHODS.affinity.verified === true, 'the affinity laws are exact (not a correlation)');
    },
  },
  {
    name: 'ES3 viscosity correction (Turzo et al. 2000): water identity, published polynomials, monotone, clamped, outside flagged',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const E = app(ctx).win.WTS_wp_esp, qBep = 1500, hBep = 22;
      assert.deepStrictEqual(plain(E.turzo(qBep, hBep, 1)), { CQ: 1, CE: 1, CH: [1, 1, 1, 1], Qstar: null, outside: false, normalised: true });
      // the published fit by hand at 100 cSt, normalised by its value at 1 cSt
      const qg = qBep * 42 / 1440, y = -112.1374 + 6.6504 * Math.log(hBep) + 12.8429 * Math.log(qg);
      const Qs = (nu) => Math.exp((39.5276 + 26.5605 * Math.log(nu) - y) / 51.6565), CQ = (q) => 1 - 4.0327e-3 * q - 1.724e-4 * q * q, CE = (q) => 1 - 3.3075e-2 * q + 2.8875e-4 * q * q;
      const t = E.turzo(qBep, hBep, 30);
      assert.ok(Math.abs(t.Qstar - Qs(30)) < 1e-9, 'Q*');
      assert.ok(Math.abs(t.CQ - Math.min(1, Math.max(0.1, CQ(Qs(30)) / CQ(Qs(1))))) < 1e-12 && Math.abs(t.CE - Math.min(1, Math.max(0.1, CE(Qs(30)) / CE(Qs(1))))) < 1e-12, 'C_Q, C_η');
      let prev = { CQ: 1, CE: 1, CH: [1, 1, 1, 1] };
      [5, 20, 60, 200, 1000].forEach((nu) => {
        const f = E.turzo(qBep, hBep, nu);
        assert.ok(f.CQ <= prev.CQ + 1e-12 && f.CE <= prev.CE + 1e-12 && f.CH.every((c, i) => c <= prev.CH[i] + 1e-12), 'monotone at ' + nu + ' cSt');
        assert.ok([f.CQ, f.CE].concat(f.CH).every((c) => c >= 0.1 && c <= 1), 'clamped at ' + nu);
        prev = f;
      });
      assert.ok(E.turzo(qBep, hBep, 1000).outside && !E.turzo(qBep, hBep, 5).outside, 'Q* > 40 flagged');
      assert.ok(E.METHODS.turzo.verified === false, 'provisional (D17)');
    },
  },
  {
    name: 'ES4 natural separation (Harmathy v∞, E = v∞ / (v∞ + v_SL)) and Turpin φ by hand; a separator in series',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, E = G.WTS_wp_esp;
      const o = { qL: 0.1, casingId: 6.276, od: 4.0, rhoL: 60, rhoG: 5, sigma: 25 }, r = E.natSep(o);
      const A = Math.PI / 4 * (6.276 * 6.276 - 16) / 144, vsl = 0.1 / A;
      const vinf = 1.53 * Math.pow(9.81 * 0.025 * 55 * 16.0185 / Math.pow(60 * 16.0185, 2), 0.25) / 0.3048;
      assert.ok(Math.abs(r.vSL - vsl) < 1e-12 && Math.abs(r.vInf - vinf) < 1e-12 && Math.abs(r.E - vinf / (vinf + vsl)) < 1e-12, 'E ' + r.E);
      assert.ok(!E.natSep({ qL: 0.1, casingId: 3, od: 4, rhoL: 60, rhoG: 5, sigma: 25 }).ok, 'no annulus → no separation');
      assert.ok(Math.abs(E.turpin(0.02, 0.1, 400) - 2000 * 0.2 / 1200) < 1e-12, 'Turpin φ');
      // in the solver: E_total = 1 − (1 − E_n)(1 − E_s) and the vented gas = E × the free gas at the intake
      const M = espWell(G), M2 = espWell(G, { sepEff: 0.5 }), R = solve(G, M), R2 = solve(G, M2);
      assert.ok(R.ok && R2.ok && R.lift.En > 0, 'natural separation applied');
      assert.ok(Math.abs(R2.lift.E - (1 - (1 - R2.lift.En) * 0.5)) < 1e-12, 'separator in series');
      assert.ok(Math.abs(R.lift.ventMscfd - R.lift.E * R.lift.freeIn) < 1e-9, 'vented gas');
      assert.ok(R2.lift.gvfIn < R.lift.gvfIn, 'less gas into the pump with a separator');
    },
  },
  {
    name: 'ES5 stage by stage: water pump Δp = ρ·N·H(Q)/144, BHP = Q·H·SG/(135,770 η); free gas lowers the density, raises the rate',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, E = G.WTS_wp_esp, M = espWell(G);
      const W = G.WTS_wp_well.build(M.well, { res: M.res });
      const Mw = JSON.parse(JSON.stringify(M)); Mw.fluid.type = 'water'; Mw.fluid.sgw = 1.0;
      const Fw = G.WTS_wp_fluid.build(Mw.fluid, { T_F: 150, table: false }), P = E.prepare(Mw, W);
      assert.ok(P.ok && P.N === 120 && Math.abs(P.md - 7900) < 1e-9, plain(P.errors));
      const st = E.pump(P, Fw, 1500, 1500, 150), pr = Fw.at(1500, 150, 1500), pr2 = Fw.at(st.pDis, 150, 1500);
      const c = E.curve(P.pump, 60, Math.max(0.5, pr.muL / (pr.rhoL / 62.428)));
      // water is nearly incompressible: Δp within 0.1 % of ρ̄·N·H(Q)/144 at the mean density
      const rho = (pr.rhoL + pr2.rhoL) / 2, Q = pr.qL * 86400 / 5.614583, hand = rho * 120 * c.head(Q) / 144;
      assert.ok(Math.abs(st.dp / hand - 1) < 1e-3, 'Δp ' + st.dp + ' / ' + hand);
      assert.ok(Math.abs(st.bhp - Q * c.head(Q) * 120 * (rho / 62.428) / (135770 * c.eff(Q))) / st.bhp < 2e-3, 'BHP ' + st.bhp);
      assert.ok(st.gvfIn === 0 && st.phi === 0 && st.rangeStatus === 'ok', 'single phase in range');
      const Fo = G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F }), Po = E.prepare(espWell(G, { natSep: false }), W);
      const lo = E.pump(Po, Fo, 900, 300, 180), hi = E.pump(Po, Fo, 900, 2500, 180);
      assert.ok(lo.gvfIn > hi.gvfIn && lo.Qin > hi.Qin && lo.rho < hi.rho, 'free gas at a low intake pressure: ' + lo.gvfIn + ' / ' + hi.gvfIn);
      assert.ok(lo.Qout < lo.Qin, 'the gas dissolves as the pressure rises through the pump');
    },
  },
  {
    name: 'ES6 pump in the system: root consistency, node independence, breakdown closure, R.lift and schematic mark; pumped well flows',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, SY = G.WTS_wp_system, M = espWell(G), R = solve(G, M), L = R.lift;
      const Mn = JSON.parse(JSON.stringify(M)); Mn.lift.type = 'none';
      assert.strictEqual(solve(G, Mn).code, 'NO_FLOW', 'no natural flow');
      assert.ok(R.ok && R.op.stable && L && L.type === 'esp', plain(R.errors));
      assert.ok(Math.abs(L.pDisReq - L.pDis) < 0.5, 'discharge: tubing needs ' + L.pDisReq + ', pump makes ' + L.pDis);
      assert.ok(Math.abs(L.pumpMd - 7900) < 1e-9 && Math.abs(L.pumpTvd - 7900) < 1e-6 && L.stages === 120 && L.freq === 60, 'setting');
      const Mh = JSON.parse(JSON.stringify(M)); Mh.system.node = 'wellhead';
      const Rh = SY.solve(Mh);
      assert.ok(Rh.ok && Math.abs(Rh.op.q / R.op.q - 1) < 0.005, 'node independence ' + Rh.op.q + ' / ' + R.op.q);
      const sum = R.breakdown.reduce((a, b) => a + b.dp, 0);
      assert.ok(Math.abs(sum - (R.pr - (M.surface.psep_psig + 14.696))) < 0.5, 'breakdown closes: ' + sum);
      const pb = R.breakdown.find((b) => b.key === 'pump');
      assert.ok(pb && Math.abs(pb.dp + L.dp) < 1e-9, 'pump as a gain');
      assert.ok(L.marks[0].kind === 'esp' && L.marks[0].md === 7900 && L.marks[0].stages === 120, 'schematic mark');
      assert.ok(R.traverse.profile.some((r) => r.esp === 'intake') && R.traverse.profile.some((r) => r.esp === 'discharge'), 'traverse segments');
      assert.ok(L.curve.length >= 8 && L.curve.every((c) => isFinite(c.tdhReq)), 'system head curve from the scan');
      assert.ok(R.flags.some((f) => f.code === 'ESP_POINT') && R.flags.some((f) => f.code === 'PROVISIONAL_ESP'), 'flags');
      assert.ok(R.evals <= 20, 'evaluation budget ' + R.evals + ' E');
    },
  },
  {
    name: 'ES7 top-down without inflow = the bottom-node pwf; the FREQ lift axis; no axis keeps the pump',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, SY = G.WTS_wp_system, XP = G.WTS_wp_export, M = espWell(G), R = solve(G, M);
      const e = SY.evalAt(M, R.op.q, { outflowOnly: true, thp_psig: R.surface.thp_psig, ctx: SY.context(M, { outflowOnly: true }) });
      assert.ok(e.ok && Math.abs(e.pOut / R.pwf - 1) < 0.0015, 'top-down ' + e.pOut + ' / ' + R.pwf);
      const sp = XP.suggest(M, R);
      assert.ok(sp.alq.type === 'FREQ' && sp.alq.values.indexOf(60) !== -1, JSON.stringify(sp.alq));
      const T = XP.liftTable(M, { flo: { type: 'LIQ', values: [600, 1200] }, thp: [250], wfr: { type: 'WCT', values: [0.6] }, gfr: { type: 'GOR', values: [0.5] }, alq: { type: 'FREQ', values: [50, 60, 70] } });
      assert.ok(T.ok, plain(T.errors));
      const b = T.bhp[0][0][0];
      [0, 1].forEach((k) => assert.ok(b[0][k] > b[1][k] && b[1][k] > b[2][k], 'BHP falls as the frequency rises: ' + JSON.stringify(b)));
      const T0 = XP.liftTable(M, { flo: { type: 'LIQ', values: [1200] }, thp: [250], wfr: { type: 'WCT', values: [0.6] }, gfr: { type: 'GOR', values: [0.5] }, alq: { type: '', values: [0] } });
      assert.ok(T0.ok && Math.abs(T0.bhp[0][0][0][0][0] - b[1][1]) < 0.5 && T0.warnings.some((w) => w.code === 'ALQ_MODEL_ESP'), 'no axis = the model pump');
      const Mn = JSON.parse(JSON.stringify(M)); Mn.lift.type = 'none';
      assert.ok(!XP.liftTable(Mn, { flo: { type: 'LIQ', values: [600] }, thp: [250], wfr: { type: 'WCT', values: [0.6] }, gfr: { type: 'GOR', values: [0.5] }, alq: { type: 'FREQ', values: [60] } }).ok, 'FREQ needs the ESP');
    },
  },
  {
    name: 'ES8 more frequency or stages → more rate; a frequency drag on the solver = the typed frequency',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, SY = G.WTS_wp_system, M = espWell(G), R = solve(G, M);
      const q = (o) => { const r = solve(G, espWell(G, o)); return r.ok ? r.op.q : 0; };
      const qs = [50, 55, 65].map((f) => q({ freq: f }));
      assert.ok(qs[0] < qs[1] && qs[1] < R.op.q && R.op.q < qs[2], 'frequency: ' + qs.join(', ') + ' / ' + R.op.q);
      assert.ok(q({ stages: 100 }) < R.op.q && R.op.q < q({ stages: 140 }), 'stages');
      // the live drag: a tracking solve warm-started from the 60 Hz root equals the cold solve at 65 Hz (§6.3)
      const Rt = SY.solve(espWell(G, { freq: 65 }), { warm: R.grid, track: { q: R.op.q, slope: R.op.dDdq } });
      assert.ok(Rt.ok && Math.abs(Rt.op.q / qs[2] - 1) < 0.002, 'tracking ' + Rt.op.q + ' / ' + qs[2]);
    },
  },
  {
    name: 'ES9 sizeStages brackets the target; designFor {freq} reaches the rate',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, E = G.WTS_wp_esp, SY = G.WTS_wp_system, M = espWell(G);
      const z = E.sizeStages(M, 1100);
      assert.ok(z.ok && z.stages > 100 && z.evals <= 3, JSON.stringify(plain(z)));
      const q = (n) => { const r = solve(G, espWell(G, { stages: n })); return r.ok ? r.op.q : 0; };
      assert.ok(q(z.stages) >= 1100 * 0.995 && q(z.stages - 1) < 1100 * 1.002, 'bracket: ' + q(z.stages - 1) + ' < 1100 ≤ ' + q(z.stages));
      assert.ok(z.tdh > 0 && z.hPerStage > 0 && Math.abs(z.dpPerStage * z.stages - z.dpNeed) <= z.dpPerStage + 1e-9, 'TDH and the rise per stage');
      const d = run(SY.designFor(M, { freq: 750 }));
      assert.ok(d.ok && d.freq > 30 && d.freq < 60, 'designFor freq: ' + JSON.stringify(plain(d.errors)) + ' ' + d.freq);
      const R = solve(G, espWell(G, { freq: d.freq }));
      assert.ok(Math.abs(R.op.q / 750 - 1) < 0.01, 'designed frequency ' + d.freq + ' → ' + R.op.q);
      assert.strictEqual(E.sizeStages(M, 0).code, 'BAD_TARGET');
    },
  },
  {
    name: 'ES10 rate against frequency (a Job): the model row = the single solve, ascending, cancel keeps rows',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, E = G.WTS_wp_esp, M = espWell(G), R = solve(G, M);
      const r = run(E.sweep(M, { freqs: [45, 50, 55, 60, 65] }));
      assert.ok(r.ok && r.rows.length === 5 && r.verified === false, plain(r.errors));
      const r60 = r.rows.find((x) => x.f === 60);
      assert.ok(Math.abs(r60.q / R.op.q - 1) < 0.005, '60 Hz ' + r60.q + ' / ' + R.op.q);
      const ok = r.rows.filter((x) => x.ok);
      assert.ok(ok.every((x, i) => i === 0 || x.qL > ok[i - 1].qL), 'ascending');
      const j = E.sweep(M, { freqs: [50, 60, 70] }); j.step(); j.cancel(); const rc = run(j);
      assert.ok(rc.cancelled && rc.rows.length === 1, 'cancel keeps the finished row');
    },
  },
  {
    name: 'ES11 motor and cable by hand; flags: overload, range, gas, dogleg at the setting depth on a deviated well',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, E = G.WTS_wp_esp, M = espWell(G, { motor: { hp: 60, volt: 2000, amp: 30 }, cable: { awg: '2', len_ft: 8000 } }), R = solve(G, M), L = R.lift, mo = L.motor;
      assert.ok(mo.ok, plain(mo));
      assert.ok(Math.abs(mo.load - L.bhp / 60) < 1e-12 && Math.abs(mo.amps - 30 * Math.max(0.2, mo.load)) < 1e-12, 'load and current');
      const tc = (mo.cable.tMean - 32) * 5 / 9, Rc = 0.1563 * (1 + 0.00393 * (tc - 20)), dV = Math.sqrt(3) * mo.amps * Rc * 8000 / 1000;
      assert.ok(Math.abs(mo.cable.dV - dV) < 1e-9 && Math.abs(mo.vSurf - (2000 + dV)) < 1e-9 && Math.abs(mo.kva - Math.sqrt(3) * mo.vSurf * mo.amps / 1000) < 1e-9, 'cable');
      const A = Math.PI / 4 * (6.276 * 6.276 - 16) / 144;
      assert.ok(Math.abs(mo.vCool - G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F }).at(L.pInt, L.T, R.op.q).qL / A) / mo.vCool < 0.01, 'cooling velocity');
      const fl = (o, code) => { const r = solve(G, espWell(G, o)); return r.ok && r.lift.flags.find((f) => f.code === code); };
      const ov = fl({ motor: { hp: 20, volt: 2000, amp: 30 } }, 'ESP_OVERLOAD');
      assert.ok(ov && ov.sev === 'fail', 'overload');
      const pr = (lo, hi) => Object.assign(G.WTS_wp_esp.example(), { qMin: lo, qMax: hi });
      assert.ok(fl({ pump: pr(500, 800) }, 'ESP_UPTHRUST'), 'upthrust');
      assert.ok(fl({ pump: pr(1500, 2500) }, 'ESP_DOWNTHRUST'), 'downthrust');
      const g = fl({ natSep: false, pumpMd: 5000 }, 'ESP_GVF') || fl({ natSep: false, pumpMd: 5000 }, 'ESP_GAS');
      assert.ok(g, 'free gas flagged at a shallow setting');
      // the deviated well: the pump inside the S-curve build of FIX.gasWell's survey (2°/100 ft is under 3 → no flag; a sharp dogleg flags)
      const Md = espWell(G, { pumpMd: 2600 }); Md.well.survey = [[0, 0, 0], [2000, 0, 120], [2500, 25, 120], [7950, 25, 120], [8100, 25, 120]];
      const Rd = solve(G, Md);
      assert.ok(Rd.ok && Rd.lift.dls > 3 && Rd.lift.flags.some((f) => f.code === 'ESP_DOGLEG') && Math.abs(Rd.lift.pumpTvd - G.WTS_wp_well.build(Md.well, { res: Md.res }).tvdAt(2600)) < 1e-6, 'dogleg ' + Rd.lift.dls);
    },
  },
  {
    name: 'ES12 model scalars and pump table, check() items and provisional validity, gas well refused',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, Mm = G.WTS_wp_model, SY = G.WTS_wp_system;
      const mem = () => { const d = {}; return { getItem: (k) => (k in d ? d[k] : null), setItem: (k, v) => { d[k] = String(v); }, removeItem: (k) => { delete d[k]; } }; };
      const st = mem();
      Mm.write({ pump: { name: 'P<1>', rows: [[0, 30, 0, 0.2], ['500', 28, 'x', null], [1000, 24, 55, 0.3]], f0: 60, qMin: 400 } }, { storage: st });
      const M = Mm.read({ storage: st, scalars: { wp_lift: 'esp', wp_esp_md: '7000', wp_esp_freq: '55', wp_esp_stages: '150', wp_esp_sep: '40', wp_esp_nat: false, wp_esp_hp: '100', wp_esp_awg: '4', wp_esp_clen: '7200' } });
      const e = M.lift.esp;
      assert.ok(M.lift.type === 'esp' && e.pumpMd === 7000 && e.freq === 55 && e.stages === 150 && Math.abs(e.sepEff - 0.4) < 1e-12 && e.natSep === false && e.motor.hp === 100 && e.cable.awg === '4' && e.cable.len_ft === 7200, JSON.stringify(plain(e)));
      assert.ok(e.pump.name === 'P1' && e.pump.rows.length === 3 && e.pump.rows[1][2] === null, 'pump cleaned: ' + JSON.stringify(plain(e.pump)));
      const c = (o) => { const Mx = JSON.parse(JSON.stringify(S.FIX.oilWell)); Mx.lift = { type: 'esp', gl: {}, esp: o }; return G.WTS_wp_check(Mx); };
      const codes = (r) => r.items.map((i) => i.code);
      assert.ok(codes(c({})).indexOf('NEEDS_PUMP') !== -1 && codes(c({})).indexOf('NEEDS_STAGES') !== -1, 'needs pump / stages');
      assert.ok(codes(c({ pump: G.WTS_wp_esp.example(), stages: 100, freq: 95 })).indexOf('ESP_FREQ') !== -1, 'frequency range');
      const v = c({ pump: G.WTS_wp_esp.example(), stages: 100 }).validity.filter((x) => /^esp_/.test(x.corr));
      assert.ok(v.length === 3 && v.every((x) => x.provisional && /provisional — not verified against a published example/.test(x.msg)), 'provisional validity rows');
      const Mg = S.FIX.gasWell; Mg.lift = { type: 'esp', gl: {}, esp: { pump: G.WTS_wp_esp.example(), stages: 100 } };
      assert.strictEqual(SY.solve(Mg).code, 'ESP_NOT_APPLICABLE');
      assert.ok(codes(G.WTS_wp_check(Mg)).indexOf('ESP_NOT_APPLICABLE') !== -1, 'check: gas well');
      const Mo = S.FIX.oilWell; Mo.lift = { type: 'esp', gl: {}, esp: { pump: G.WTS_wp_esp.example() } };
      assert.strictEqual(SY.solve(Mo).code, 'NEEDS_STAGES');
    },
  },
  {
    name: 'ES13 page: ESP example — step ④ cards, #wp_res pump card, plot with rails, schematic mark, KPIs, studies row, report, live drag, table edit, library, CSV',
    wp: WP, opts: false,
    async run(_a, assert, ctx) {
      const A = app(ctx), G = A.win;
      if (G.__WP_MOCK) return assert.ok(true, 'mock installed in this app');
      S.resetWellPerf(A); G.WTS_wellperf_page.resetJobs();
      A.hook.nav('wellperf'); A.flush(30);
      A.click(A.find('[data-act="example"][data-ex="esp"]')); A.flush(30);
      const ST = G.WTS_wellperf_page.state(), R = ST.R;
      assert.ok(R && R.ok && R.lift && R.lift.type === 'esp' && R.lift.stages === 236, 'ESP example solved: ' + (R && (R.errors || [])[0]));
      const card = A.el('wpe_rescard');
      assert.ok(card && A.el('wp_res').contains(card) && !/wp-off/.test(card.className), 'pump card in #wp_res, visible');
      assert.ok(A.findAll('#wpe_kpi .wp-cmpc').length === 8, 'eight KPI chips');
      assert.match(txt(A.el('wpe_kpi')), /inside/);
      const sp = A.el('wp_cv_esp')._wp.spec, keys = sp.series.map((s) => s.key);
      ['range', 'bep', 'pump', 'need'].forEach((k) => assert.ok(keys.indexOf(k) !== -1, 'series ' + k));
      assert.ok(keys.filter((k) => /^fan/.test(k)).length === 6 && sp.series.find((s) => s.key === 'range').kind === 'poly', 'fan and range band');
      assert.ok(sp.handles.map((h) => h.key + ':' + h.kind).join() === 'espF:railX,espN:railX', 'FREQ / STAGES rails');
      assert.ok(sp.markers.some((m) => m.kind === 'filled'), 'operating point');
      const svg = A.el('wp_sch').innerHTML;
      assert.ok(/data-comp="esp"/.test(svg) && /ESP 236 st · 60 Hz · 8,450 ft MD · [\d,]+ ft TVD/.test(svg), 'schematic ESP mark with MD · TVD');
      assert.ok(A.findAll('#wp_kpis .wp-kpi').some((k) => /ESP/.test(txt(k)) && /236 st/.test(txt(k))), 'KPI strip');
      assert.match(txt(A.el('wp_studies')), /ESP\s*236 stages at 60 Hz/);
      assert.match(txt(A.el('wpe_mdinfo')), /8,450 ft MD · [\d,]+ ft TVD/);
      assert.match(txt(A.el('wpe_mdinfo')), /inclination 35/);
      const rep = JSON.stringify(G.collectPageReport(A.el('pgBody'), { charts: false }));
      assert.ok(rep.indexOf('Electrical submersible pump') !== -1 && rep.indexOf('ESP — pump and system head') !== -1, 'report capture');
      // breakdown shows the pump as a gain
      assert.ok(R.breakdown.some((b) => b.key === 'pump' && b.dp < 0), 'breakdown pump');
      // drag STAGES: live tracking solves, the release commits through the normal input path
      const q0 = R.op.q, h = sp.handles.find((x) => x.key === 'espN');
      sp.onHandle('espN', 200, 'move'); A.flush(5);
      const Rl = G.WTS_wellperf_page.state().R;
      assert.ok(Rl.ok && Rl.lift.stages === 200 && Rl.op.q < q0, 'live: ' + Rl.op.q + ' < ' + q0);
      sp.onHandle('espN', 200, 'end'); A.flush(10);
      assert.ok(A.el('wp_esp_stages').value === '200' && !G.WTS_wellperf_page.state().R.tracked, 'committed: ' + A.el('wp_esp_stages').value);
      void h;
      // the pump table: edit a cell → the model is written → one solve
      const inp = A.find('#wpe_tbl tbody tr:nth-child(6) input[data-wpe="1"]');
      A.change(inp, '17'); A.flush(10);
      assert.ok(Math.abs(G.WTS_wp_model.read().lift.esp.pump.rows[5][1] - 17) < 1e-9 && !G.WTS_wp_model.read().lift.esp.pump.example, 'table edit written');
      // library on this device: save, load
      A.click(A.find('[data-act="esplibsave"]')); A.flush(2);
      assert.ok(JSON.parse(A.storage.getItem('wtspref_wp_pumplib') || '[]').length === 1, 'saved to the library');
      A.click(A.find('[data-act="espex"]')); A.flush(10);
      A.click(A.find('[data-act="esplibload"]')); A.flush(10);
      assert.ok(Math.abs(G.WTS_wp_model.read().lift.esp.pump.rows[5][1] - 17) < 1e-9, 'loaded from the library');
      // sweep from the page
      A.click(A.find('[data-act="espsweep"]'));
      for (let i = 0; i < 400 && !G.WTS_wellperf_ext.esp.state().sweep; i++) await A.flushAsync(1);
      assert.ok(G.WTS_wellperf_ext.esp.state().sweep && G.WTS_wellperf_ext.esp.state().sweep.ok, 'sweep');
      assert.ok(A.el('wp_cv_espf')._wp.spec.handles[0].kind === 'lineX', 'frequency line handle');
      const csv = G.WTS_wellperf_page.csv();
      assert.ok(/ESP pump curve/.test(csv) && /ESP at the operating point/.test(csv) && /ESP rate against frequency/.test(csv), 'CSV sections');
      assert.ok(!BAD.test(txt(A.el('wpe_rescard'))) && !BAD.test(txt(A.el('wpe_setcard'))) && !BAD.test(txt(A.el('wpe_frcard'))), 'clean text');
      // another example without a lift type leaves the ESP behind
      A.click(A.find('[data-act="example"][data-ex="oil"]')); A.flush(30);
      assert.ok(A.el('wp_lift').value === 'none' && /wp-off/.test(A.el('wpe_rescard').className), 'Oil example: natural flow, pump card hidden');
      assert.strictEqual(A.consoleErrors().length, 0, 'no console errors: ' + A.consoleErrors().slice(0, 2).join(' | '));
    },
  },
];
