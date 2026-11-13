// Well Dynamics — lift transients and oil heading (lane WD4): LF1–LF23. docs/WELL-DYNAMICS-PLAN.md §4.11, §4.12, §4.13, §5.3, §11.4.
//
// LF1  annulus volume (casing ID / tubing OD to the packer)            LF2  casing gas column vs WTS_gaslift_casingP ≤ 0.5 %
// LF3  IPO valve open / close hysteresis on p_vo / p_vc (gauge)         LF4  Thornhill-Craver through WTS_wp_gl.tc (identity)
// LF5  glUnload: valves uncover top-down, lifting ends at the design operating valve, the casing pressure falls at each transfer
// LF6  gas-lift nodal mode: the lift gas enters the cell above the R.lift.injMd break at the nodal q_inj (the G5 sim)
// LF7  the Asheim (1988) screening verdict cross-checked against a transient run (provisional)
// LF8  ESP start-up from a static well: ramp, intake draws down, settles on the pumped root (G6 values)
// LF9  pump-off · LF10 gas lock · LF11 underload trip · LF12 check valve (no back-flow through a stopped pump)
// LF13 foamer transport delay from the injection MD · LF14 foamer: q_c × sigF^¼ (C11) and a loading well recovers to marginal
// LF15 oil heading / stability: right of q_s settles on the nodal root, a bean with no stable root dies; the detector on a signal
// LF16 timer cycle events land exactly · LF17 pressure cycle with minimum times · LF18 liquid removed per cycle reported
// LF19 extension snapshot / restore continues bit-identically · LF20 lift states and labels · LF21 ESP faceDp = the nodal pump node
// LF22 ESP vent gas leaves the cell below the pump and appears in qg, qvent and cumOut · LF23 lift gas: free only, mixed gravity, surface qg
// LFX  (WD4 engine finding) a liquid slug at the wellhead does not chatter the choke (implicit flowline back pressure)
// LF24 page, gas lift: the Lift card (status with the valve table, ESP ramp hidden), the gas-lift unloading preset (balance level, open + gl),
//      the Lift chart keys, Metric display, no NaN
// LF25 page, intermittent: the cycle form schedules a programme (timer and pressure), Stop; the status line; ESP card ramp → setLift
// LF26 page report: the lift rows in the run summary (display units)
'use strict';

const L4 = require('./_welldyn-wd4');
const W = L4.W;

const WPK = 'WD4';
const H = 3600, PATM = 14.696;
const clone = (o) => JSON.parse(JSON.stringify(o));
const G = (ctx) => W.sharedApp(ctx).win;
const F = (ctx) => L4.FIXL(G(ctx));
const memo = (k, fn) => W.memo('lift:' + k, fn);
const tAt = (an, md) => { for (let j = 0; j < an.N; j++) if (an.md[j + 1] >= md) return an.T[j] + (an.T[j + 1] - an.T[j]) * (md - an.md[j]) / (an.md[j + 1] - an.md[j]); return an.T[an.N]; };
const extCtx = (sim, key) => (sim.exts.find((x) => x.key === key) || {}).ctx;
function create(g, M, opts) { const sim = g.WTS_wd_engine.create(M, opts || {}); if (!sim.ok) throw new Error('create: ' + sim.code + ' ' + (sim.errors || []).join('; ')); return sim; }
function track(sim) {
  const out = { states: [], valves: [], trips: [], events: [], steps: 0, minQpump: Infinity };
  sim.on('state', (e) => out.states.push(e)); sim.on('valve', (e) => out.valves.push(e)); sim.on('trip', (e) => out.trips.push(e)); sim.on('event', (e) => out.events.push(e));
  sim.on('step', () => { out.steps++; if (sim.grid.pumpFace >= 0) out.minQpump = Math.min(out.minQpump, sim.fs.Q[sim.grid.pumpFace]); });
  return out;
}
// the glUnload run: the gasLift fixture killed to the static water level of p̄r (WTS_wd_lift.balanceLevel ≈ 2,486 ft MD) in the tubing and the
// annulus (§11.4: a full kill column above the balance level drains into the formation and the engine has no reverse flow through the
// choke), opened with the lift gas on from t = 0
const glOpts = (g, M) => ({ start: 'static', static: { kind: 'level', liquidTopMd: g.WTS_wd_lift.balanceLevel(M).md, liquid: 'water' }, reservoir: { prior: { kind: 'none' } },
  events: [{ t: 0, type: 'open' }, { t: 0, type: 'gl', args: { qinj_Mscfd: 600, mode: 'valves' } }] });
function glUnload(ctx, dur) {
  return memo('glUnload' + dur, () => {
    const g = G(ctx), M = F(ctx).gasLift(), sim = create(g, M, glOpts(g, M)), tr = track(sim), ops = [];
    sim.on('step', () => { const gl = sim.state.lift.gl; if (gl && gl.opValve && (!ops.length || ops[ops.length - 1].op !== gl.opValve)) ops.push({ t: sim.state.t, op: gl.opValve, pcs: gl.pcs_psig }); });
    const t0 = Date.now(), r = sim.run(dur);
    return { sim, tr, ops, r, wallMs: Date.now() - t0 };
  });
}
function espStart(ctx) {
  return memo('espStart', () => {
    const g = G(ctx), sc = L4.SCEN4.espStart, sim = create(g, F(ctx).esp(), clone(sc.opts)), tr = track(sim), pint = [];
    sim.on('step', () => { if (sim.state.lift.esp) pint.push([sim.state.t, sim.state.lift.esp.pint]); });
    const t0 = Date.now(), r = sim.run(sc.duration_s);
    return { sim, tr, pint, r, wallMs: Date.now() - t0 };
  });
}
const gateSim = (ctx, key) => memo('gate:' + key, () => {
  const g = G(ctx), M = key === 'esp' ? F(ctx).esp() : F(ctx).gasLift(), sim = create(g, M, Object.assign({}, W.GATE_OPTS, L4.GATE4[key]));
  return { sim, rs: W.runSteady(sim, { cap_s: 3 * H }) };
});

module.exports = [
  {
    name: 'LF1 annulus: one control volume from the surface to the packer, V = Σ π/4 (ID_csg² − OD_tbg²)/144 · L',
    wp: WPK, opts: false,
    run(_a, assert, ctx) {
      const g = G(ctx), sim = create(g, F(ctx).gasLift(), {}), an = g.WTS_wd_lift.annulus(sim);
      assert.ok(an && an.ok, 'annulus built');
      assert.strictEqual(an.packerMd, 7900, 'the packer MD of the model');
      const A = Math.PI / 4 * (6.276 * 6.276 - 2.875 * 2.875) / 144;
      assert.rel(an.V, A * 7900, 1e-9, 'annulus volume (ft³)');
      assert.strictEqual(extCtx(sim, 'gaslift').mode, 'valves', 'installed valves → valves mode by default');
      // no casing over the tubing → no annulus, nodal injection (stated)
      const M2 = F(ctx).gasLift(); M2.well.strings = M2.well.strings.filter((s) => !(s.kind === 'casing' && s.topMd === 0));
      const s2 = create(g, M2, {}), c2 = extCtx(s2, 'gaslift');
      assert.strictEqual(c2.mode, 'nodal'); assert.ok(c2.notes.some((n) => /annulus/.test(n)), 'the fallback is stated');
    }
  },
  {
    name: 'LF2 casing gas column p_cs·exp(0.01875·γ/z̄·∫dTVD/T) within 0.5 % of WTS_gaslift_casingP at every valve and the packer',
    wp: WPK, opts: false,
    run(_a, assert, ctx) {
      const g = G(ctx), sim = create(g, F(ctx).gasLift(), {}), L = g.WTS_wd_lift, an = L.annulus(sim), sg = 0.65;
      [500, 1100, 1500].forEach((pcsG) => {
        const st = { pcs: pcsG + PATM, zL: an.packerMd, rhoL: 66 };
        [1970, 2956, 3709, 4334, 7900].forEach((md) => {
          const tvd = sim.C.W.tvdAt(md), mine = L.casingP(an, st, sg, md) - PATM;
          const ref = g.WTS_gaslift_casingP(pcsG, tvd, sg, an.T[0], tAt(an, md));
          assert.rel(mine, ref.p, 0.005, 'p_c at ' + md + ' ft MD, p_cs ' + pcsG + ' psig');
        });
      });
      // the gas mass and the surface pressure are inverse of each other (two Z passes)
      const st2 = { pcs: 1114.7, zL: 4000 }, m = L.gasMass(an, sg, st2.pcs, st2.zL);
      assert.rel(L.pcsFromMass(an, sg, m, st2.zL, 800), st2.pcs, 1e-6, 'p_cs from the gas mass');
    }
  },
  {
    name: 'LF3 IPO valve balance in gauge: opens at p_vo = (p_d − R·p_t,g)/(1 − R), stays open down to p_vc = p_d, closes below; orifice / dummy',
    wp: WPK, opts: false,
    run(_a, assert, ctx) {
      const L = G(ctx).WTS_wd_lift, v = { kind: 'ipo', pd: 900, R: 0.0637 }, pt = 600 + PATM, pvo = (900 - 0.0637 * 600) / (1 - 0.0637);
      assert.ok(!L.valveBalance(v, pvo - 0.01 + PATM, pt, false).open, 'closed just below p_vo');
      const b = L.valveBalance(v, pvo + 0.01 + PATM, pt, false);
      assert.ok(b.open, 'opens at p_vo'); assert.near(b.pvo, pvo, 1e-9); assert.strictEqual(b.pvc, 900);
      assert.ok(L.valveBalance(v, 900.5 + PATM, pt, true).open, 'an open valve stays open between p_vc and p_vo (hysteresis)');
      assert.ok(!L.valveBalance(v, 899.5 + PATM, pt, true).open, 'closes below p_vc');
      assert.ok(L.valveBalance({ kind: 'orifice' }, 100, 2000, false).open, 'orifice always open');
      assert.ok(!L.valveBalance({ kind: 'dummy' }, 3000, 100, true).open, 'dummy always shut');
    }
  },
  {
    name: 'LF4 valve gas through WTS_wp_gl.tc (Thornhill-Craver, unchanged): the lifting valve passes throttle × tc(port, p_c, p_t, T, γ) = the injection',
    wp: WPK, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const g = G(ctx), s = glUnload(ctx, 4.5 * H), sim = s.sim, c = extCtx(sim, 'gaslift');
      const op = c.valves.find((v) => v.passing === 'gas');
      assert.ok(op, 'a valve passes gas');
      const t = g.WTS_wp_gl.tc({ port64: op.port, p1: op.pc, p2: op.pt, T: op.T, sg: c.sg });
      assert.ok(t.ok && t.q > 0);
      assert.rel(op.q, op.thr * t.q, 1e-6, 'valve rate = throttle × Thornhill-Craver (Mscf/d)');
      assert.ok(op.thr > 0 && op.thr <= 1, 'throttle in (0, 1]');
      // at the lifting state the valve passes the surface injection (the casing pressure is steady)
      assert.rel(op.q, 600, 0.03, 'valve throughput = the injected 600 Mscf/d');
      // the self-test values of the gas-lift engine are untouched (16/64 in, 1,000 → 400 psia, 150 °F, γ 0.65: critical)
      const ref = g.WTS_wp_gl.tc({ port64: 16, p1: 1000, p2: 400, T: 150, sg: 0.65 });
      assert.ok(ref.ok && ref.critical && ref.q > 0);
    }
  },
  {
    name: 'LF5 glUnload: valves uncover top-down, lifting ends at the design operating valve, the casing pressure falls at each transfer; mass to round-off',
    wp: WPK, opts: false, timeoutMs: 180000,
    run(_a, assert, ctx) {
      const s = glUnload(ctx, 4.5 * H), sim = s.sim, S = sim.state, D = F(ctx).gasLiftDesign();
      assert.ok(s.r.ok, 'run ' + (s.r.code || ''));
      assert.ok(D && D.ok && D.operating, 'the design has an operating valve');
      const nOp = D.valves.findIndex((v) => v.role === 'Operating') + 1;
      assert.ok(s.ops.length >= 2, 'at least one transfer: ' + JSON.stringify(s.ops));
      for (let i = 1; i < s.ops.length; i++) {
        assert.ok(s.ops[i].op > s.ops[i - 1].op, 'top-down: valve ' + s.ops[i - 1].op + ' → ' + s.ops[i].op);
        assert.ok(s.ops[i].pcs < s.ops[i - 1].pcs + 1, 'casing pressure falls at the transfer ' + s.ops[i - 1].pcs.toFixed(1) + ' → ' + s.ops[i].pcs.toFixed(1));
      }
      assert.strictEqual(S.lift.gl.opValve, nOp, 'lifting from the design operating valve (' + nOp + ')');
      assert.ok(S.lift.gl.liqTopMd >= D.operating.md - 30, 'annulus unloaded to the operating valve: liquid top ' + S.lift.gl.liqTopMd);
      const seq = s.tr.states.map((e) => e.to);
      assert.ok(seq.indexOf('gl_unloading') !== -1 && seq.lastIndexOf('gl_lifting') > seq.indexOf('gl_unloading'), 'unloading → lifting: ' + seq.join(' → '));
      assert.strictEqual(S.well.state, 'gl_lifting');
      assert.ok(s.tr.valves.length > 0, "'valve' engine events emitted");
      assert.ok(S.balance.errCum <= 1e-8, 'cumulative mass balance ' + S.balance.errCum);
      assert.ok(S.provisional.indexOf('gl_valves') !== -1, 'gl_valves listed as provisional');
      assert.ok(typeof S.lift.gl.multi === 'boolean', 'multi-pointing flag reported');
    }
  },
  {
    name: 'LF6 gas-lift nodal mode (the gate G5 sim): lift gas only in the cell above the R.lift.injMd break, at the nodal q_inj',
    wp: WPK, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const m = gateSim(ctx, 'gasLift'), sim = m.sim, R = sim.R0, c = extCtx(sim, 'gaslift'), g = sim.grid;
      assert.strictEqual(c.mode, 'nodal');
      assert.near(g.cells[g.injCell].md0, R.lift.injMd, 1e-6, 'injection cell starts at the nodal injection depth');
      const src = sim.exts.find((x) => x.key === 'gaslift').e.sources(sim, c, 1);
      for (let i = 0; i < sim.n; i++) assert.strictEqual(src.I[i] > 0, i === g.injCell, 'I source only in the injection cell (' + i + ')');
      assert.rel(src.I[g.injCell] / sim.k.I * 86400 / 1000, R.lift.qinj, 1e-12, 'q_inj = the nodal rate');
      assert.rel(sim.state.surface.qinj, R.lift.qinj, 1e-12, 'S.surface.qinj');
      assert.strictEqual(sim.state.well.state, 'gl_lifting');
    }
  },
  {
    name: 'LF7 Asheim (1988) screening cross-check (provisional): the verdict-stable fixture settles in valves mode; the verdict is reported for both',
    wp: WPK, opts: false, timeoutMs: 120000, integration: true,
    run(_a, assert, ctx) {
      const g = G(ctx), f = F(ctx);
      [{ o: {}, stable: true }, { o: { dpv: 100, port: 16 }, stable: false }].forEach((x) => {
        const M = f.gasLift(x.o), R = g.WTS_wp_system.solve(M), A = g.WTS_wp_gl.asheim(M, R, { port64: x.o.port || 12 });
        assert.ok(A.ok && A.verified === false, 'Asheim screening provisional');
        assert.strictEqual(A.verdict === 'ok', x.stable, 'screening verdict ' + A.verdict + ' (F2 ' + A.F2 + ')');
        if (!x.stable) return;
        const sim = create(g, M, {}), ring = [];
        sim.on('step', () => ring.push([sim.state.t, sim.state.surface.qL, sim.state.lift.gl.pcs_psig]));
        sim.run(2 * H);
        const last = ring.filter((r) => r[0] > sim.state.t - 1800), amp = (k) => Math.max(...last.map((r) => r[k])) - Math.min(...last.map((r) => r[k]));
        assert.ok(amp(1) <= 0.01 * sim.state.surface.qL + 1 && amp(2) <= 2, 'settled: Δq ' + amp(1).toFixed(2) + ', Δp_cs ' + amp(2).toFixed(2));
      });
    }
  },
  {
    name: 'LF8 ESP start-up from a static water column: ramp 0 → 60 Hz, the intake draws down and the well settles on the pumped nodal root',
    wp: WPK, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const s = espStart(ctx), sim = s.sim, S = sim.state, R = sim.R0;
      assert.ok(s.r.ok, 'run ' + (s.r.code || ''));
      const seq = s.tr.states.map((e) => e.to);
      assert.ok(seq[0] === 'esp_ramp' && seq.indexOf('esp_running') > 0, 'shut in → ramp → running: ' + seq.join(' → '));
      const p0 = s.pint[0][1], pMin = Math.min(...s.pint.map((x) => x[1]));
      assert.ok(pMin < p0 - 400, 'the intake draws down (' + p0.toFixed(0) + ' → ' + pMin.toFixed(0) + ' psia)');
      assert.rel(S.surface.qL, R.op.q, 0.02, 'pumped rate');
      assert.rel(S.lift.esp.pint, R.lift.pInt, 0.01, 'pump intake');
      assert.rel(S.lift.esp.freq, 60, 1e-6);
      assert.ok(S.balance.errCum <= 1e-8);
      ['esp_node', 'esp_start'].forEach((k) => assert.ok(sim.prov[k], k + ' marked'));
      assert.ok(S.provisional.indexOf('esp_start') !== -1 && S.provisional.indexOf('esp_node') === -1, 'esp_start provisional, esp_node an identity');
    }
  },
  {
    name: 'LF9 pump-off: a weak water well ramped to 90 Hz draws the intake below 30 psia — pump-off trip (no restart for 15 min), state esp_pumpoff',
    wp: WPK, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const g = G(ctx), M = F(ctx).esp({ J: 0.15, wc: 1.0, gor: 0 }), sim = create(g, M, { events: [{ t: 300, type: 'esp', args: { on: true, freq: 90, ramp_Hz_s: 1 } }] }), tr = track(sim);
      const r = sim.run(600);
      assert.ok(r.ok, 'run ' + (r.code || ''));
      const po = tr.trips.find((t) => t.kind === 'pumpoff');
      assert.ok(po && po.t > 300, 'pump-off trip after the ramp: ' + JSON.stringify(tr.trips));
      assert.ok(tr.states.some((e) => e.to === 'esp_pumpoff'), 'state esp_pumpoff: ' + tr.states.map((e) => e.to).join(','));
      assert.ok(extCtx(sim, 'esp').locked === 'pumpoff', 'held off');
      assert.ok(sim.state.lift.esp.pint > 150, 'the intake recovers while the pump is off');
    }
  },
  {
    name: 'LF10 gas lock: GOR 1,200 at the intake → intake gas fraction above 30 % for 60 s → esp_gaslock (provisional)',
    wp: WPK, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const g = G(ctx), sim = create(g, F(ctx).esp({ gor: 1200, wc: 0.3 }), {}), tr = track(sim);
      sim.run(900);
      assert.ok(sim.state.lift.esp.gvf > 0.3, 'intake gas fraction ' + sim.state.lift.esp.gvf);
      assert.strictEqual(sim.state.well.state, 'esp_gaslock');
      assert.ok(tr.states.some((e) => e.to === 'esp_gaslock'));
      // at the GOR of the fixture (100) the pump runs without gas
      assert.strictEqual(gateSim(ctx, 'esp').sim.state.well.state, 'esp_running');
    }
  },
  {
    name: 'LF11 underload trip: the choke shut with the pump running → load below 40 % for 30 s → trip, a controller esp {on:false} event, f → 0',
    wp: WPK, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const g = G(ctx), sim = create(g, F(ctx).esp(), { events: [{ t: 600, type: 'shutin' }, { t: 1500, type: 'open' }] }), tr = track(sim);
      sim.run(1400);
      const tp = tr.trips.find((t) => t.kind === 'underload');
      assert.ok(tp && tp.t >= 610 + 30 - 1e-6 && tp.t < 900, 'underload trip 30 s after the load fell: ' + JSON.stringify(tr.trips));
      const ev = sim.log.find((e) => e.type === 'esp' && e.src === 'controller');
      assert.ok(ev && ev.args.on === false && ev.args.trip === 'underload', 'controller event in the log');
      assert.strictEqual(sim.state.lift.esp.freq, 0, 'the drive ramped down');
      sim.run(300);
      assert.strictEqual(sim.state.well.state, 'esp_tripped', 'reopened: the pump stays tripped');
    }
  },
  {
    name: 'LF12 check valve: a stopped pump under a static water column passes no back-flow (≤ 0.2 % of the pumped rate)',
    wp: WPK, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const g = G(ctx), sim = create(g, F(ctx).esp(), { start: 'static', static: { kind: 'liquid', liquid: 'water' }, reservoir: { prior: { kind: 'none' } }, events: [{ t: 0, type: 'open' }] }), tr = track(sim);
      const r = sim.run(1800);
      assert.ok(r.ok);
      const Qop = gateSim(ctx, 'esp').sim.fs.Q[sim.grid.pumpFace];
      assert.ok(tr.minQpump >= -0.002 * Qop, 'pump-face flux ≥ −0.2 % of the pumped flux: ' + tr.minQpump);
      assert.strictEqual(sim.state.well.state, 'esp_off');
    }
  },
  {
    name: 'LF13 foamer transport: dosed at 5,000 ft MD it reaches the top cells only after the liquid travel time, and nothing below the injection point',
    wp: WPK, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const g = G(ctx), sim = create(g, W.FIX.gasVert, { events: [{ t: 0, type: 'foamer', args: { on: true, ppm: 1000, injMd: 5000 } }] });
      const top = sim.n - 1, conc = (i) => sim.cs.mW[i] > 0 ? 1e6 * sim.cs.mF[i] / sim.cs.mW[i] : 0;
      const ic = extCtx; void ic;
      sim.run(30);
      const cell = extCtx(sim, 'foamer').cell;
      assert.ok(sim.grid.cells[cell].md0 >= 5000 && sim.grid.cells[cell].md1 <= 5000, 'dosing cell contains 5,000 ft MD');
      assert.ok(conc(top) < 1, 'not at the top after 30 s');
      // the liquid travel time from the dosing cell to the top cell (Σ ΔL / v_L)
      let tt = 0; for (let i = cell + 1; i <= top; i++) tt += sim.grid.cells[i].len / Math.max(1e-3, sim.cs.vl[i]);
      let tHalf = null;
      while (sim.state.t < Math.min(4 * tt, 6 * H)) { sim.run(60); if (tHalf == null && conc(top) >= 500) tHalf = sim.state.t; if (tHalf != null) break; }
      assert.ok(tHalf != null, 'arrives at the top');
      assert.ok(tHalf >= 0.4 * tt && tHalf <= 2.5 * tt, 'arrival ' + tHalf.toFixed(0) + ' s vs the liquid travel time ' + tt.toFixed(0) + ' s');
      for (let i = 0; i < cell; i++) assert.ok(conc(i) < 10, 'below the injection point: ' + conc(i).toFixed(2) + ' ppm in cell ' + i);
      assert.ok(sim.state.provisional.indexOf('foamer') !== -1);
    }
  },
  {
    name: 'LF14 foamer: q_c × sigF^¼ (C11) on a frozen state; gasLoad at bean 26 loading → marginal after 1,000 ppm',
    wp: WPK, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const g = G(ctx), L = g.WTS_wd_lift;
      assert.near(L.sigmaFactor(1000), 0.6, 1e-12, 'r(1000 ppm) = 0.6·1000/1500 = 0.4');
      const M = W.FIX.gasLoad; M.surface.choke.bean64 = 26;
      const sim = create(g, M, { fallback: true, events: [{ t: 1.5 * H, type: 'foamer', args: { on: true, ppm: 1000, injMd: null } }] }), tr = track(sim);
      sim.run(1.5 * H - 1);
      assert.strictEqual(sim.state.well.state, 'loading', 'loading before the foamer');
      // closed form on the frozen state: the same cells with every water at 1,000 ppm → v_c and q_c × 0.6^¼
      const vc0 = Array.from(sim.cs.vc), qc0 = sim.state.loading.qcVert_MMscfd, mF0 = Array.from(sim.cs.mF), sig0 = Array.from(sim.cs.sigF);
      for (let i = 0; i < sim.n; i++) { sim.cs.mF[i] = 1e-3 * sim.cs.mW[i]; }
      const sa = sim.exts.find((x) => x.key === 'foamer'), ctxF = clone(sa.ctx); ctxF.any = true;
      const sg = sa.e.sigma(sim, ctxF); for (let i = 0; i < sim.n; i++) sim.cs.sigF[i] = sg[i];
      sim._loading();
      for (let i = 0; i < sim.n; i++) if (vc0[i] > 0 && sim.cs.mW[i] > 0) assert.rel(sim.cs.vc[i], vc0[i] * Math.pow(0.6, 0.25), 1e-12, 'v_c cell ' + i);
      assert.rel(sim.state.loading.qcVert_MMscfd, qc0 * Math.pow(0.6, 0.25), 1e-12, 'q_c');
      for (let i = 0; i < sim.n; i++) { sim.cs.mF[i] = mF0[i]; sim.cs.sigF[i] = sig0[i]; }
      sim._loading();
      sim.run(2.5 * H);
      assert.rel(sim.state.loading.qcVert_MMscfd, qc0 * Math.pow(0.6, 0.25), 0.02, 'q_c after the foamer reached the tubing water');
      assert.ok(['marginal', 'stable', 'unloading'].indexOf(sim.state.well.state) !== -1, 'recovered: ' + tr.states.map((e) => e.to).join(' → '));
      assert.ok(sim.state.loading.ratio > 0.9, 'rate / critical rate ' + sim.state.loading.ratio);
    }
  },
  {
    name: 'LF15 oil stability: bean 16 (right of q_s) settles on the nodal root; bean 14 (no stable root) dies; the heading detector on a signal',
    wp: WPK, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const g = G(ctx), runB = (b) => { const sim = create(g, W.FIX.oilVert, { events: [{ t: 600, type: 'bean', args: { bean64: b } }] }), tr = track(sim); sim.run(2.5 * H); return { sim, tr }; };
      const M16 = W.FIX.oilVert; M16.surface.choke.bean64 = 16; const R16 = g.WTS_wp_system.solve(M16);
      assert.ok(R16.ok && R16.op.q > R16.qs.q, 'bean 16: the nodal root lies right of q_s');
      const a = runB(16);
      assert.rel(a.sim.state.surface.qL, R16.op.q, 0.02, 'settles on the nodal root');
      assert.ok(!(a.sim.state.lift.heading && a.sim.state.lift.heading.heading), 'no heading');
      const M14 = W.FIX.oilVert; M14.surface.choke.bean64 = 14; const R14 = g.WTS_wp_system.solve(M14);
      assert.ok(!R14.ok || !R14.op, 'bean 14: no stable nodal root');
      const b = runB(14);
      assert.ok(b.sim.state.surface.qL < 0.3 * R16.op.q, 'bean 14 dies away: ' + b.sim.state.surface.qL.toFixed(1) + ' STB/d');
      assert.ok(b.tr.states.some((e) => e.to === 'dying'), 'dying on the way: ' + b.tr.states.map((e) => e.to).join(','));
      // the detector: ≥ 3 peak pairs above 5 % of the mean with a 20 min period in 3 h → heading; a 10 s ripple or a 2 % wave → not
      const L = g.WTS_wd_lift, T = [], P = [], P2 = [];
      for (let t = 0; t <= 3 * H; t += 30) { T.push(t); P.push(400 + 40 * Math.sin(2 * Math.PI * t / 1200)); P2.push(400 + 8 * Math.sin(2 * Math.PI * t / 1200)); }
      const h = L.headingOf(T, P);
      assert.ok(h.heading && h.pairs >= 3, 'heading: ' + JSON.stringify(h)); assert.rel(h.period_s, 1200, 0.03, 'period');
      assert.ok(!L.headingOf(T, P2).heading, 'a 2 % wave is not heading');
    }
  },
  {
    name: 'LF16 timer cycle (30 min open / 30 min shut × 2 on gasLoad): open / shut-in events land exactly on their times, src controller',
    wp: WPK, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const r = memo('cycle', () => { const g = G(ctx), sim = create(g, W.FIX.gasLoad, { events: [{ t: 0, type: 'cycle', args: { mode: 'timer', open_h: 0.5, shut_h: 0.5, cycles: 2 } }] }); sim.run(2.25 * H); return { sim }; });
      const ev = r.sim.log.filter((e) => e.src === 'controller').map((e) => [e.type, e.t]);
      assert.deepStrictEqual(clone(ev), [['shutin', 0.5 * H], ['open', 1 * H], ['shutin', 1.5 * H], ['open', 2 * H]], 'controller events ' + JSON.stringify(ev));
      assert.strictEqual(r.sim.state.open, 1, 'the programme ends open');
      assert.ok(r.sim.state.provisional.indexOf('states') !== -1);
    }
  },
  {
    name: 'LF17 pressure cycle: shut when THP < p_close after minOpen, reopen when THP ≥ p_open after minShut; ≤ cycles opens',
    wp: WPK, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const g = G(ctx), sim = create(g, W.FIX.gasLoad, {}), thp0 = (sim.run(60), sim.state.surface.thp_psig);
      sim.schedule([{ t: sim.state.t, type: 'cycle', args: { mode: 'pressure', pClose_psig: thp0 + 20, pOpen_psig: thp0 + 150, minOpen_h: 0.25, minShut_h: 0.5, cycles: 2 } }]);
      const t0 = sim.state.t; sim.run(2 * H);
      const ev = sim.log.filter((e) => e.src === 'controller');
      assert.ok(ev.length >= 2 && ev[0].type === 'shutin', 'shut first: ' + JSON.stringify(ev.map((e) => [e.type, Math.round(e.t)])));
      assert.ok(ev[0].t >= t0 + 0.25 * H - 1e-6 && ev[0].t <= t0 + 0.25 * H + 120, 'shut at the minimum open time');
      const op = ev.filter((e) => e.type === 'open');
      assert.ok(op.length >= 1 && op.length <= 2, 'reopens ≤ cycles');
      assert.ok(op[0].t - ev[0].t >= 0.5 * H - 1e-6, 'minimum shut time');
      const shutRec = sim.log.find((e) => e.t === op[0].t && e.type === 'open'); void shutRec;
    }
  },
  {
    name: 'LF18 intermittent gas well: the liquid produced and removed per cycle is reported (S.lift.cycle.hist)',
    wp: WPK, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const r = memo('cycle', () => { const g = G(ctx), sim = create(g, W.FIX.gasLoad, { events: [{ t: 0, type: 'cycle', args: { mode: 'timer', open_h: 0.5, shut_h: 0.5, cycles: 2 } }] }); sim.run(2.25 * H); return { sim }; });
      const c = r.sim.state.lift.cycle;
      assert.ok(c && c.mode === 'timer' && c.hist.length >= 2, 'cycles booked: ' + JSON.stringify(c && c.hist));
      c.hist.forEach((h) => {
        ['liq_bbl', 'gas_Mscf', 'removed_bbl', 'liqStart_bbl', 'liqEnd_bbl'].forEach((k) => assert.ok(Number.isFinite(h[k]), k));
        assert.ok(h.liq_bbl > 0 && h.gas_Mscf > 0, 'liquid and gas produced in the open period');
        assert.near(h.tShut - h.tOpen, 0.5 * H, 30, 'open period 30 min (the 10 s choke stroke and one step)');
      });
      assert.ok(r.sim.exts.find((x) => x.key === 'cycle'), 'cycle extension active');
    }
  },
  {
    name: 'LF19 extension snapshot / restore: a gas-lift unloading and an ESP ramp continue bit-identically from a Snap',
    wp: WPK, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const g = G(ctx), f = F(ctx);
      [[f.gasLift(), glOpts(g, f.gasLift()), 1800, 600], [f.esp(), clone(L4.SCEN4.espStart.opts), 20, 400]].forEach(([M, opts, t1, t2]) => {
        const a = create(g, M, opts); a.run(t1); const snap = JSON.parse(JSON.stringify(a.snapshot())); a.run(t2);
        const b = create(g, M, opts), rr = b.restore(snap); assert.ok(rr.ok, 'restore ' + rr.code); b.run(a.state.t - b.state.t);
        assert.strictEqual(b.state.t, a.state.t, 't');
        assert.deepStrictEqual(Array.from(b.fs.p), Array.from(a.fs.p), 'face pressures');
        assert.deepStrictEqual(Array.from(b.cs.mI), Array.from(a.cs.mI), 'lift gas');
        assert.deepStrictEqual(JSON.parse(JSON.stringify(b.state.lift)), JSON.parse(JSON.stringify(a.state.lift)), 'lift state');
      });
    }
  },
  {
    name: 'LF20 lift states and labels: the engine STATES labels for every lift state; the extensions are provisional (D17) with the label text',
    wp: WPK, opts: false,
    run(_a, assert, ctx) {
      const g = G(ctx), E = g.WTS_wd_engine;
      ['gl_unloading', 'gl_lifting', 'gl_multipoint', 'esp_off', 'esp_ramp', 'esp_running', 'esp_pumpoff', 'esp_gaslock', 'esp_tripped', 'heading'].forEach((k) => assert.ok(E.STATES[k] && E.STATES[k].label, k));
      L4.W; ['foamer', 'cycle', 'heading', 'gaslift', 'esp'].forEach((k) => {
        const x = E.ext[k];
        assert.ok(x && x.verified === false && /provisional — not verified against a published example/.test(x.provisional), k + ' provisional');
        ['applies', 'init', 'snapshot', 'restore'].forEach((fn) => assert.strictEqual(typeof x[fn], 'function', k + '.' + fn));
      });
      assert.deepStrictEqual(clone(g.WTS_wd_lift.EXT), ['foamer', 'cycle', 'heading', 'gaslift', 'esp']);
      // a natural-flow gas well carries no lift extension but the foamer / cycle ones
      const sim = create(g, W.FIX.gasVert, {});
      assert.deepStrictEqual(clone(sim.exts.map((x) => x.key).sort()), ['cycle', 'foamer']);
      assert.ok(Array.isArray(g.WTS_wd_lift.describe(sim)));
    }
  },
  {
    name: 'LF21 ESP faceDp = WTS_wp_esp.pump(...).dp of the nodal pump node at the same intake state (the G6 sim at steady state)',
    wp: WPK, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const g = G(ctx), m = gateSim(ctx, 'esp'), sim = m.sim, R = sim.R0, k = sim.grid.pumpFace, c = extCtx(sim, 'esp'), x = sim.exts.find((e) => e.key === 'esp').e;
      const r = x.faceDp(sim, clone(c), k, sim.fs.Q[k]);
      const st = g.WTS_wp_esp.pump(sim.C.esp, sim.C.F, R.op.q, sim.fs.p[k], sim.cs.T[k - 1]);
      assert.rel(r.dp, st.dp, 2e-3, 'face Δp = nodal pump Δp at the same intake state (stream from the face fluxes vs the basis rate)');
      assert.ok(r.ddpdQ < 0, 'falling head');
      assert.rel(sim.state.lift.esp.dp, R.lift.dp, 0.01, 'pump rise vs the nodal operating point');
      assert.rel(sim.state.lift.esp.pint, R.lift.pInt, 0.01, 'intake');
    }
  },
  {
    name: 'LF22 ESP vent gas (natural separation on, GOR 500): leaves the cell below the pump, appears in qg / qvent and in cumOut',
    wp: WPK, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const g = G(ctx), sim = create(g, F(ctx).esp({ gor: 500, natSep: true }), {});
      sim.run(600);
      const S = sim.state, v = S.surface.qvent, k = sim.grid.pumpFace;
      assert.ok(v > 1, 'vent gas ' + v);
      assert.near(S.surface.qg, S.surface.qgForm + v, 1e-9, 'qg = formation gas through the choke + vent (no lift gas)');
      const src = sim.exts.find((x) => x.key === 'esp').e.sources(sim, extCtx(sim, 'esp'), 1);
      for (let i = 0; i < sim.n; i++) assert.strictEqual(src.G[i] < 0, i === k - 1, 'negative G only in the cell below the pump');
      const before = S.balance.cumOut.G; sim.run(60);
      assert.ok(S.balance.cumOut.G - before > 0.9 * (60 * v * 1000 / 86400 * sim.k.G), 'vent gas booked in cumOut');
      assert.ok(S.balance.errCum <= 1e-8);
    }
  },
  {
    name: 'LF23 lift gas: m_I never dissolves (below the injection point zero, the dissolved ratio unchanged), mixed-gravity gas = the nodal Finj, qg = qgForm + qinj',
    wp: WPK, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const g = G(ctx), m = gateSim(ctx, 'gasLift'), sim = m.sim, S = sim.state, inj = sim.grid.injCell;
      for (let i = 0; i < inj; i++) assert.strictEqual(sim.cs.mI[i], 0, 'no lift gas below the injection cell (' + i + ')');
      for (let i = inj; i < sim.n; i++) assert.ok(sim.cs.mI[i] > 0, 'lift gas above (' + i + ')');
      const i0 = Math.min(sim.n - 1, inj + 3), p = sim.cs.p[i0], T = sim.cs.T[i0];
      // the dissolved ratio of a lifted cell is the formation stream's (the lift gas stays free)
      const u = sim.unit, vf = { qo: u.qo, qw: u.qw, qg: u.qg / 1e6, api: sim.C.F.api, sgg: sim.C.F.sgg, sgw: sim.C.F.sgw, pvt: sim.C.F.pvt }, pr = g.WTS_flowline_props(vf, p, T);
      assert.rel(sim.X.rd[i0], Math.min(pr.rs, u.qg / u.qo), 1e-4, 'dissolved gas ratio of the lifted cell');
      // the mixed-gravity gas of the nodal context at the same (p, T) and stream
      const q = sim.R0.op.q, ff = g.WTS_wp_fluid.flowlineFluid(sim.C.gl.Finj, q), pn = g.WTS_flowline_props(ff, p, T);
      assert.rel(sim.X.rhoG[i0], pn.rhoG, 2e-3, 'free-gas density at the mixed gravity');
      assert.rel(S.surface.qg, S.surface.qgForm + S.surface.qinj, 0.01, 'surface gas = formation + lift gas at steady state');
      assert.ok(S.inventory.liftGas_Mscf > 0, 'lift gas in the tubing');
    }
  },
  {
    name: 'LFX (WD4 engine finding, §11.4) the flowline back pressure at the trial rate: a liquid slug at the wellhead flows on without choke chatter',
    wp: WPK, opts: false, timeoutMs: 180000,
    run(_a, assert, ctx) {
      const s = glUnload(ctx, 4.5 * H), sim = s.sim;
      // the 2–3 h window carries the first liquid to surface; the old lagged p_dn opened / shut the choke every step at dt ≈ 0.01 s
      assert.ok(sim.stats.steps < 6000, 'steps ' + sim.stats.steps);
      assert.ok((sim.stats.rej && sim.stats.rej.NEWTON || 0) === 0, 'no Newton failures');
      assert.ok(sim.state.surface.pDn_psig < sim.state.surface.thp_psig, 'p_dn below the THP while flowing');
    }
  }
];

// ── page tests (WD4 UI on the WD3 page) ─────────────────────────────────────────────────────────────────────────────────────
const BAD = /NaN|undefined|Infinity|\[object Object\]/;
let _pg = null;
function pageApp(ctx) {
  const key = String(ctx.mode);
  if (_pg && _pg.key === key) return _pg.app;
  const app = ctx.loadApp({ sourceOverrides: W.sourceOverrides() });
  const Wm = app.win.WTS_wp_model, read0 = Wm.read;
  app._fix = null;
  Wm.read = function (o) { if (!app._fix) return read0.call(Wm, o); const M = app.toWin(clone(app._fix)); M.meta = { status: 'ok', readOnly: false, notes: [] }; return M; };
  _pg = { key, app };
  return app;
}
const PP = (app) => app.win.WTS_welldyn_page;
function openPage(app, M) {
  app._fix = M;
  const p = PP(app); if (p) p.pause();
  app.storage.removeItem('wts_page_welldyn');
  app.hook.nav('home'); app.flush(10);
  app.hook.nav('welldyn'); app.flush(30);
  PP(app).build();
}
const ptxt = (e) => String(e && e.textContent || '').replace(/\s+/g, ' ').trim();
module.exports.push(
  {
    name: 'LF24 page, gas lift: Lift card with the valve table, the unloading preset (balance level, open + lift gas), the Lift chart, Metric, no NaN',
    wp: WPK, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const app = pageApp(ctx), g = app.win, M = L4.FIXL(g).gasLift();
      openPage(app, M);
      assert.ok(app.el('wd_liftcard'), 'Lift card');
      assert.strictEqual(app.el('wd_ramp_w').style.display, 'none', 'no ESP drive on a gas-lift well');
      const r = PP(app).scenario('glunload');
      assert.strictEqual(r.note, '');
      assert.deepStrictEqual(clone(r.events.map((e) => e.type)), ['open', 'gl']);
      assert.strictEqual(app.el('wd_static').value, 'level');
      assert.near(+app.el('wd_level').value, g.WTS_wd_lift.balanceLevel(M).md, 1, 'killed to the balance level');
      for (let i = 0; i < 40; i++) PP(app).sim().step();
      g.calcWellDyn();
      const st = ptxt(app.el('wd_liftstat'));
      assert.match(st, /installed valves/); assert.match(st, /Casing pressure/);
      assert.strictEqual(app.el('wd_liftstat').querySelectorAll('tbody tr').length, M.lift.gl.valves.length, 'one row per valve');
      PP(app).tab('lift');
      assert.ok(!BAD.test(ptxt(app.el('wd_root'))), 'no NaN / undefined: ' + (ptxt(app.el('wd_root')).match(BAD) || [''])[0]);
      // Metric: the casing pressure in kPa / bar
      if (g.WTS_units && g.WTS_units.setSystem) {
        g.WTS_units.setSystem('metric'); g.calcWellDyn();
        assert.ok(!/psig/.test(ptxt(app.el('wd_liftstat'))), 'Metric readouts: ' + ptxt(app.el('wd_liftstat')).slice(0, 160));
        g.WTS_units.setSystem('imperial'); g.calcWellDyn();
      }
    }
  },
  {
    name: 'LF25 page, intermittent and ESP: the cycle form schedules a timer / pressure programme and Stop; the ESP ramp field reaches setLift',
    wp: WPK, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const app = pageApp(ctx), g = app.win;
      openPage(app, W.FIX.gasLoad);
      app.select('wd_cyc_mode', 'timer'); app.input('wd_cyc_open', '0.5'); app.input('wd_cyc_shut', '0.25'); app.input('wd_cyc_n', '2');
      app.click(app.find('[data-act="cycgo"]'));
      const sim = PP(app).sim();
      sim.run(120); g.calcWellDyn();
      const ce = sim.log.filter((e) => e.type === 'cycle');
      assert.ok(ce.length === 1 && ce[0].args.mode === 'timer' && ce[0].args.open_h === 0.5 && ce[0].args.cycles === 2, 'timer programme ' + JSON.stringify(ce));
      assert.ok(sim.pend.some((e) => e.src === 'controller' && e.type === 'shutin' && Math.abs(e.t - (ce[0].t + 1800)) < 1e-6), 'shut-in scheduled at +30 min');
      assert.match(ptxt(app.el("wd_liftstat")), /Intermittent \(timer\)\s*cycle 1, open · next shut-in at 0:3[01]:00/);
      app.click(app.find('[data-act="cycoff"]')); sim.run(30);
      assert.ok(!sim.pend.some((e) => e.src === 'controller'), 'Stop cancels the scheduled cycle events');
      app.select('wd_cyc_mode', 'pressure'); app.input('wd_cyc_pon', '900'); app.input('wd_cyc_poff', '320');
      app.click(app.find('[data-act="cycgo"]')); sim.run(30);
      const last = sim.log.filter((e) => e.type === 'cycle').pop();
      assert.strictEqual(last.args.mode, 'pressure'); assert.strictEqual(last.args.pOpen_psig, 900); assert.strictEqual(last.args.pClose_psig, 320);
      // the ESP drive ramp on an ESP well
      openPage(app, L4.FIXL(g).esp());
      assert.strictEqual(app.el('wd_ramp_w').style.display, '', 'ESP drive shown');
      app.input('wd_hz', '50'); app.input('wd_ramp', '0.5'); app.click('wd_esp_go');
      const es = PP(app).sim().log.filter((e) => e.type === 'esp').pop();
      assert.ok(es && es.args.freq === 50 && es.args.ramp_Hz_s === 0.5, 'setLift with the ramp: ' + JSON.stringify(es && es.args));
      PP(app).sim().run(20); g.calcWellDyn();
      assert.match(ptxt(app.el('wd_liftstat')), /ESP frequency/);
      assert.ok(!BAD.test(ptxt(app.el('wd_root'))));
    }
  },
  {
    name: 'LF26 page report: the run summary carries the lift rows (casing pressure / valve; frequency / intake / load) in display units',
    wp: WPK, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const app = pageApp(ctx), g = app.win;
      openPage(app, L4.FIXL(g).esp());
      const p = PP(app); p.speed(1000); p.play(); let ts = 1000; for (let i = 0; i < 40; i++) { ts += 50; p.frame(ts); } p.pause();
      const sum = ptxt(app.el('wd_rsum'));
      assert.match(sum, /ESP frequency/); assert.match(sum, /Intake \/ discharge/);
      assert.ok(!BAD.test(sum));
      const rep = g.collectPageReport ? g.collectPageReport(app.el('pgBody')) : null;
      if (rep) assert.ok(JSON.stringify(rep).indexOf('ESP frequency') !== -1, 'captured in the page report');
    }
  }
);
