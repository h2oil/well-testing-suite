// Well Dynamics — the consistency gate (WD-D5), lane WD1: G1–G4 and G7. docs/WELL-DYNAMICS-PLAN.md §5.1.
// WD4 appends G5 (gas lift, nodal mode) and G6 (ESP).
//
// A steady flowing run (start 'steady', reservoir 'ipr', closure 'corr', temperature 'frozen', 60 cells, every other option at its default)
// must settle on WTS_wp_system.solve for the same model. Steady = the means of q, p_wf and THP over two consecutive 600 s windows differ by
// |Δq̄|/q̄ < 1e-3, |Δp̄_wf| < 0.05 psi, |ΔTHP̄| < 0.05 psi (capped at 6 h); a bounded oscillation is allowed up to 0.5 % of q̄ and 2 psi in p_wf.
// Then, on the time-means of the last window: rate ≤ 2 % of R.op.q, BHP ≤ 1 % of R.pwf, THP ≤ max(1 %, 3 psi), the choke regime equal to
// R.surface.choke.regime. The q compared is the IPR basis rate of the model (liquid STB/d for oil, formation gas Mscf/d for gas).
//
// G1 gasVert · G2 gasHz · G3 oilVert · G4 oilVertTuned (VLP multipliers m_h 1.10, m_f 0.90) · G7 oilDev (the S-shaped survey)
// G8 (WD1 extra) the static-start companion: staticOil opened from a static oil column settles on the same nodal point
// G9 (WD1 extra) grid convergence (C12): oilVert BHP(60) vs BHP(120) ≤ 0.5 %, and 30 cells within 1 %
'use strict';

const W = require('./_welldyn-wd1');

const WP = 'WD1';
const G = (ctx) => W.sharedApp(ctx).win;

function gate(ctx, assert, key, opts) {
  const g = G(ctx), m = W.steadySim(g, key, opts), sim = m.sim;
  assert.ok(sim.ok, 'create ' + key + ': ' + (sim.code || ''));
  const R = sim.R0, rs = m.rs;
  assert.ok(rs.ok, 'run ' + key + ': ' + (rs.code || ''));
  const c = rs.chk;
  assert.ok(c.steady, key + ' steady within the cap (Δq̄ ' + c.dq + ', Δp̄ ' + c.dp + ')');
  assert.ok(c.ampQ <= W.TOL.ampQ * c.qMean, key + ' oscillation amplitude in q ' + c.ampQ);
  assert.ok(c.ampP <= W.TOL.ampP, key + ' oscillation amplitude in p_wf ' + c.ampP);
  assert.rel(c.qMean, R.op.q, W.TOL.q, key + ' rate');
  assert.rel(c.pwfMean, R.pwf, W.TOL.pwf, key + ' BHP');
  assert.ok(Math.abs(c.thpMean - R.surface.thp) <= Math.max(W.TOL.thpRel * R.surface.thp, W.TOL.thpAbs), key + ' THP ' + c.thpMean.toFixed(2) + ' vs ' + R.surface.thp.toFixed(2));
  assert.strictEqual(sim.state.surface.regime, R.surface.choke.regime, key + ' choke regime');
  // the D17 rule of the gate: no method marked "never a default" is active in a default run
  ['res_sup', 'choke_sub', 'belfroid', 'fallback', 'temp_relax'].forEach((k) => assert.ok(sim.state.provisional.indexOf(k) === -1, key + ': ' + k + ' active in a default run'));
  // mass balance to round-off
  assert.ok(sim.state.balance.errCum <= 1e-8, key + ' cumulative mass balance ' + sim.state.balance.errCum);
  return { sim, R, c };
}

module.exports = [
  { name: 'G1 gasVert: a steady run settles on the nodal operating point (rate 2 %, BHP 1 %, THP max(1 %, 3 psi), critical choke)', wp: WP, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) { gate(ctx, assert, 'gasVert'); } },
  { name: 'G2 gasHz (vertical, 8°/100 ft build, 2,000 ft lateral with a 4-1/2" liner): settles on the nodal operating point', wp: WP, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const { sim } = gate(ctx, assert, 'gasHz');
      // horizontal cells: θ = 0° from horizontal on the marcher segment, ΔZ ≈ 0 (gravity vanishes), the lateral is liner
      // (the flow path starts at the mid-perforations, the lateral's midpoint: half the lateral is in the path)
      const lat = sim.grid.cells.filter((c) => c.kind === 'liner');
      assert.ok(lat.length >= 2, 'lateral cells: ' + lat.length);
      lat.forEach((c) => { assert.ok(c.inc > 85, 'inclination ' + c.inc); assert.ok(Math.abs(c.dz) <= 0.02 * c.len, 'ΔZ of a near-horizontal cell'); assert.ok(Math.abs(sim.grid.segs[c.seg].theta) < 2, 'θ from horizontal'); });
      assert.ok(lat.some((c) => Math.abs(sim.grid.segs[c.seg].theta) < 1e-9), 'a horizontal segment (θ = 0)');
    } },
  { name: 'G3 oilVert: settles on the nodal operating point; every face carries the correlation closure (w = 1)', wp: WP, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const { sim } = gate(ctx, assert, 'oilVert');
      for (let f = 1; f <= sim.n; f++) assert.strictEqual(sim.state.faces.w[f], 1, 'w at face ' + f);
    } },
  { name: 'G4 oilVertTuned (m_h 1.10, m_f 0.90 through WTS_flowline_gradAt): settles on the tuned nodal operating point', wp: WP, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const { sim, R } = gate(ctx, assert, 'oilVertTuned');
      assert.deepStrictEqual(JSON.parse(JSON.stringify(sim.gopt.mult)), { hl: 1.1, f: 0.9 }, 'the solve\'s multipliers reach the closure');
      const plain = W.FIX.oilVert, R0 = G(ctx).WTS_wp_system.solve(plain);
      assert.ok(Math.abs(R.op.q - R0.op.q) / R0.op.q > 0.05, 'the tuned reference differs from the untuned one (the gate checks the tuning)');
    } },
  { name: 'G7 oilDev (S-shaped survey, 9,950 ft MD): settles on the nodal operating point', wp: WP, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const { sim } = gate(ctx, assert, 'oilDev');
      assert.ok(sim.grid.cells.some((c) => c.inc > 25), 'deviated cells');
      let tvd = 0; sim.grid.cells.forEach((c) => { tvd += c.dz; });
      assert.rel(tvd, sim.C.W.nodes.midPerfTvd, 1e-9, 'Σ ΔZ = TVD of the mid-perforations');
    } },
  { name: 'G8 static companion: staticOil opened from a static oil column (prior none) settles on the same nodal point', wp: WP, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const g = G(ctx), sc = W.SCEN.staticOil, sim = g.WTS_wd_engine.create(W.FIX.staticOil, JSON.parse(JSON.stringify(sc.opts)));
      assert.ok(sim.ok);
      assert.strictEqual(sim.state.well.state, 'shutin');
      const rs = W.runSteady(sim, { after_s: 3600 });
      assert.ok(rs.ok && rs.chk.steady, 'steady');
      const R = sim.R0;
      assert.rel(rs.chk.qMean, R.op.q, W.TOL.q, 'rate'); assert.rel(rs.chk.pwfMean, R.pwf, W.TOL.pwf, 'BHP');
    } },
  { name: 'G9 grid convergence (C12): oilVert BHP with 60 vs 120 cells within 0.5 %, 30 cells within 1 %', wp: WP, opts: false, timeoutMs: 180000, integration: true,
    run(_a, assert, ctx) {
      const g = G(ctx), bhp = {};
      [30, 60, 120].forEach((n) => {
        const m = W.steadySim(g, 'oilVert', n === 60 ? undefined : { cells: n }), rs = m.rs;
        assert.ok(m.sim.ok && m.sim.n >= n);
        assert.ok(rs.ok, 'run ' + n);
        bhp[n] = rs.chk.pwfMean;
      });
      assert.rel(bhp[60], bhp[120], 0.005, '60 vs 120');
      assert.rel(bhp[30], bhp[120], 0.01, '30 vs 120');
    } },
];

// ── WD4 (appended, §5.1): G5 gas lift in nodal mode, G6 ESP — fixtures of tests/_welldyn-wd4.js (§11.4) ─────────────────────
const L4 = require('./_welldyn-wd4');
function gate4(ctx, assert, key) {
  const g = G(ctx), M = key === 'esp' ? L4.FIXL(g).esp() : L4.FIXL(g).gasLift();
  const m = W.memo('lift:gate:' + key, () => { const sim = g.WTS_wd_engine.create(M, Object.assign({}, W.GATE_OPTS, L4.GATE4[key])); return { sim, rs: sim.ok ? W.runSteady(sim, { cap_s: 3 * 3600 }) : { ok: false, code: sim.code } }; });
  const sim = m.sim; assert.ok(sim.ok, 'create ' + key + ': ' + (sim.code || ''));
  const R = sim.R0, c = m.rs.chk;
  assert.ok(m.rs.ok && c.steady, key + ' steady (Δq̄ ' + c.dq + ', Δp̄ ' + c.dp + ')');
  assert.ok(c.ampQ <= W.TOL.ampQ * c.qMean && c.ampP <= W.TOL.ampP, key + ' oscillation amplitude');
  assert.rel(c.qMean, R.op.q, W.TOL.q, key + ' rate'); assert.rel(c.pwfMean, R.pwf, W.TOL.pwf, key + ' BHP');
  assert.ok(Math.abs(c.thpMean - R.surface.thp) <= Math.max(W.TOL.thpRel * R.surface.thp, W.TOL.thpAbs), key + ' THP ' + c.thpMean.toFixed(2) + ' vs ' + R.surface.thp.toFixed(2));
  assert.strictEqual(sim.state.surface.regime, R.surface.choke.regime, key + ' choke regime');
  ['res_sup', 'choke_sub', 'belfroid', 'fallback', 'temp_relax'].forEach((k) => assert.ok(sim.state.provisional.indexOf(k) === -1, key + ': ' + k + ' active in a default run'));
  assert.ok(sim.state.balance.errCum <= 1e-8, key + ' cumulative mass balance ' + sim.state.balance.errCum);
  return { sim, R };
}
module.exports.push(
  { name: 'G5 gasLift (nodal injection): settles on the gas-lifted nodal operating point; injection cell above the R.lift.injMd break, q_inj equal', wp: 'WD4', opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const { sim, R } = gate4(ctx, assert, 'gasLift');
      assert.near(sim.grid.cells[sim.grid.injCell].md0, R.lift.injMd, 1e-6, 'injection cell');
      assert.rel(sim.state.surface.qinj, R.lift.qinj, 1e-12, 'q_inj');
      assert.ok(sim.state.provisional.indexOf('gl_valves') === -1, 'nodal mode: no valve model');
    } },
  { name: 'G6 esp: settles on the pumped nodal operating point; pump intake within 1 %', wp: 'WD4', opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const { sim, R } = gate4(ctx, assert, 'esp');
      assert.rel(sim.state.lift.esp.pint, R.lift.pInt, 0.01, 'pump intake');
      assert.strictEqual(sim.state.well.state, 'esp_running');
    } }
);
