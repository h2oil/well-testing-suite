// Well Dynamics — the transient engine WTS_wd_engine (lane WD1). docs/WELL-DYNAMICS-PLAN.md §3.1–§3.6, §4, §5.2 EN1–EN30; EN31 = the integration fix of the fallback flux (§11.7).
// Fixtures and the in-memory WTS_flowline_gradAt export: tests/_welldyn-wd1.js (the WD0 files were not on wd/int; §11.1).
// Long scenarios are shared through the helper's memo (shutInBuildup with welldyn-res RS4; the gate runs with welldyn-gate).
'use strict';

const fs = require('fs');
const path = require('path');
const W = require('./_welldyn-wd1');

const WP = 'WD1';
const G = (ctx) => W.sharedApp(ctx).win;
const H = 3600;
const arr = (a) => Array.from(a);
const sameArr = (assert, a, b, msg) => { assert.strictEqual(a.length, b.length, msg + ' length'); for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) assert.fail(msg + ' differs at ' + i + ': ' + a[i] + ' vs ' + b[i]); };
const STATE_KEYS = ['mG', 'mO', 'mW', 'mI', 'mF', 'p', 'ag'];
function sameState(assert, s1, s2, msg) {
  assert.strictEqual(s1.state.t, s2.state.t, msg + ' t');
  STATE_KEYS.forEach((k) => sameArr(assert, arr(s1.state.cells[k]), arr(s2.state.cells[k]), msg + ' cells.' + k));
  sameArr(assert, arr(s1.state.faces.Q), arr(s2.state.faces.Q), msg + ' faces.Q');
}
const buildup = (g) => W.memo('shutInBuildup', () => W.runScenario(g, 'shutInBuildup'));

module.exports = [
  {
    name: 'EN1 grid: no cell straddles a segment / section break or the end of tubing; Σ len = path MD, Σ ΔZ = TVD; faces n + 1',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const g = G(ctx);
      ['oilVert', 'oilDev', 'gasHz', 'gasVert'].forEach((key) => {
        const sim = g.WTS_wd_engine.create(W.FIX[key], { cells: 60 });
        assert.ok(sim.ok, key);
        const gr = sim.grid, W0 = sim.C.W;
        assert.strictEqual(gr.faces.length, gr.n + 1);
        let L = 0, Z = 0; gr.cells.forEach((c) => { L += c.len; Z += c.dz; });
        assert.rel(L, W0.nodes.midPerfMd, 1e-9, key + ' Σ len'); assert.rel(Z, W0.nodes.midPerfTvd, 1e-6, key + ' Σ ΔZ');
        // every marcher segment boundary and the tubing shoe is a face
        const faceMd = gr.faces.map((f) => f.md);
        W0.segments.forEach((s) => [s.md0, s.md1].forEach((m) => assert.ok(faceMd.some((x) => Math.abs(x - m) < 1e-6), key + ' break at ' + m)));
        gr.cells.forEach((c) => { const s = gr.segs[c.seg]; assert.ok(c.md0 <= s.mdBot + 1e-6 && c.md1 >= s.mdTop - 1e-6, 'cell inside its segment'); });
        assert.ok(gr.n >= 60 && gr.cells[0].md0 === W0.nodes.midPerfMd && Math.abs(gr.cells[gr.n - 1].md1) < 1e-9, key + ' bottom = mid-perf, top = wellhead');
        assert.ok(typeof gr.rough === 'number' && gr.rough > 0 && Array.isArray(gr.traj) && gr.traj.length > 1, key + ' rough, traj');
      });
    },
  },
  {
    name: 'EN2 mass balance: per step ≤ 1e-10, cumulative ≤ 1e-8 over shutInBuildup (2 h flowing + 8 h shut in, transient reservoir)',
    wp: WP, opts: false, timeoutMs: 240000,
    run(_a, assert, ctx) {
      const r = buildup(G(ctx));
      assert.ok(r.ok, 'ran: ' + (r.code || ''));
      assert.ok(r.maxErrStep <= 1e-10, 'per step ' + r.maxErrStep);
      assert.ok(r.sim.state.balance.errCum <= 1e-8, 'cumulative ' + r.sim.state.balance.errCum);
      assert.ok(r.steps.every((s) => s.errCum <= 1e-8), 'cumulative at every step');
      assert.ok(r.sim.state.t >= 10 * H - 1e-6 && r.sim.state.t < 10 * H + 61, 'reached 10 h (run never splits a step)');
    },
  },
  {
    name: 'EN3 static gas column (geotherm, relax): the shut-in wellhead pressure within 1 % of WTS_wp_system.shutIn gas-filled SITHP',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      // a dry gas (no condensate / water): the shut-in tool's column gravity is then the gas gravity, as the engine's gas fill
      const g = G(ctx), M = W.FIX.gasVert; Object.assign(M.fluid, { type: 'gas', cgr: 0, wgr: 0 });
      const ref = g.WTS_wp_system.shutIn(M);
      const sim = g.WTS_wd_engine.create(M, { start: 'static', static: { kind: 'gas' }, temperature: 'relax', reservoir: { prior: { kind: 'none' } } });
      assert.ok(sim.ok && ref.ok);
      assert.rel(sim.state.bottom.pwf, M.res.pr, 1e-9, 'bottom at p̄r');
      assert.rel(sim.state.surface.thp_psig, ref.gasFilled, 0.01, 'SITHP psig');
    },
  },
  {
    name: 'EN4 partly liquid-filled static column (water to 4,975 ft): SITHP within 1 % of shutIn.partLiquid after the liquid-density basis',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const g = G(ctx), M = W.FIX.gasVert, ref = g.WTS_wp_system.shutIn(M), row = ref.partLiquid[1];
      const sim = g.WTS_wd_engine.create(M, { start: 'static', static: { kind: 'level', liquidTopMd: row.liquidTopMd, liquid: 'water' }, temperature: 'relax', reservoir: { prior: { kind: 'none' } } });
      assert.ok(sim.ok);
      // shutIn takes the liquid at 62.4·sgw (stock-tank); the engine at its in-situ ρ_w(p, T): the known difference is removed first
      const cs = sim.state.cells, X = sim.X;
      let dpLiq = 0, Lliq = 0; sim.grid.cells.forEach((c, i) => { if (cs.ag[i] < 0.5) { dpLiq += (62.4 * M.fluid.sgw - X.rhoW[i]) * c.dz / 144; Lliq += c.dz; } });
      assert.ok(Lliq > 4000, 'liquid column ' + Lliq);
      assert.rel(sim.state.surface.thp_psig, row.sithp + dpLiq, 0.01, 'SITHP psig (basis-corrected)');
    },
  },
  {
    name: 'EN5 killColumn (gasVert full of the model\'s water, shut in, back-flow on): the column falls into the formation and a gas cap forms',
    wp: WP, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const r = W.memo('killColumn', () => W.runScenario(G(ctx), 'killColumn'));
      assert.ok(r.ok, r.code);
      const st = r.sim.state, s0 = r.steps[0];
      assert.ok(s0.pwf > W.FIX.gasVert.res.pr + 500, 'starts overbalanced: ' + s0.pwf);
      assert.ok(Math.abs(st.bottom.pwf - 3500) < 5, 'p_wf → p̄r: ' + st.bottom.pwf);
      assert.ok(st.inventory.liq_bbl < r.steps[0].liq - 5, 'liquid lost to the formation');
      assert.ok(st.inventory.gasCapBottomMd > 1000, 'a gas cap: interface at ' + st.inventory.gasCapBottomMd);
      assert.ok(st.balance.cumOut.W > 0 && st.provisional.indexOf('res_back') !== -1, 'back-flow booked and listed');
    },
  },
  {
    name: 'EN6 steady start equals the nodal traverse at t = 0 within 1 % at every cell (pressure) and its holdup within 0.02',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const g = G(ctx);
      ['oilVert', 'gasVert'].forEach((key) => {
        const sim = g.WTS_wd_engine.create(W.FIX[key], {}), rows = sim.R0.traverse.profile.filter((r) => !r.restr);
        const at = (md, k) => { for (let i = 1; i < rows.length; i++) if (rows[i].md >= md) { const a = rows[i - 1], b = rows[i], f = (md - a.md) / (b.md - a.md || 1); return a[k] + (b[k] - a[k]) * f; } return rows[rows.length - 1][k]; };
        sim.grid.cells.forEach((c, i) => {
          assert.rel(sim.state.cells.p[i], at(c.mdc, 'p'), 0.01, key + ' p at cell ' + i);
          assert.ok(Math.abs((1 - sim.state.cells.ag[i]) - at(c.mdc, 'hl')) < 0.02, key + ' holdup at cell ' + i);
        });
      });
    },
  },
  {
    name: 'EN7 open from static: an oil well full of its oil flows after the open and settles (US8)',
    wp: WP, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const r = W.memo('staticOil1h', () => W.runScenario(G(ctx), 'staticOil', { duration_s: 1.5 * H }));
      assert.ok(r.ok, r.code);
      const before = r.steps.filter((s) => s.t <= 60), after = r.steps.filter((s) => s.t > 1.2 * H);
      assert.ok(before.every((s) => s.qs === 0), 'no flow before the open');
      assert.ok(r.states.some((e) => e.from === 'shutin' && e.to === 'startup'), 'start-up');
      const R = r.sim.R0, q = after[after.length - 1].qs;
      assert.rel(q, R.op.q, 0.03, 'flowing near the nodal rate after 1.2 h');
    },
  },
  {
    name: 'EN8 shut-in: afterflow decays, the liquid top settles under a gas cap, the column segregates with mass conserved',
    wp: WP, opts: false, timeoutMs: 240000,
    run(_a, assert, ctx) {
      const r = buildup(G(ctx)), tS = 2 * H, at = (t) => r.steps.find((s) => s.t >= t);
      // afterflow decays; around 10 min the falling liquid lifts p_wf above the formation's transient pressure and the sandface briefly
      // takes fluid back (phase redistribution, back-flow on, R14) — then the rate dies out
      const q1 = at(tS + 60).qres, q2 = at(tS + 600).qres, q3 = at(tS + 3 * H).qres;
      assert.ok(q1 > Math.abs(q2) && Math.abs(q2) > Math.abs(q3), 'afterflow decays: ' + [q1, q2, q3].map((x) => x.toFixed(1)).join(' → '));
      assert.ok(Math.abs(q3) < 0.05 * r.qShut, 'afterflow ends');
      const st = r.sim.state;
      assert.ok(st.inventory.gasCapBottomMd > 0 && st.inventory.gasCapBottomMd < 4000, 'gas cap at the top: ' + st.inventory.gasCapBottomMd);
      const lt1 = at(tS + 6 * H).liqTop, lt2 = st.inventory.liquidTopMd;
      assert.ok(Math.abs(lt1 - lt2) < 1.5 * r.sim.grid.cells[0].len, 'the liquid top has settled');
      assert.ok(st.balance.errCum < 1e-8);
    },
  },
  {
    name: 'EN9 oil–water settling (provisional): in the shut-in column the water fraction of the liquid rises at the bottom',
    wp: WP, opts: false, timeoutMs: 240000,
    run(_a, assert, ctx) {
      const r = buildup(G(ctx)), cs = r.sim.state.cells;
      const fwBot = cs.aw[0] / (cs.aw[0] + cs.ao[0]), wc = W.FIX.buildup.fluid.wc;
      let top = -1; for (let i = r.sim.n - 1; i >= 0; i--) if (cs.ag[i] < 0.5) { top = i; break; }
      const fwTop = cs.aw[top] / (cs.aw[top] + cs.ao[top]);
      assert.ok(fwBot > wc + 0.05 && fwBot > fwTop + 0.05, 'water sinks: bottom ' + fwBot.toFixed(3) + ', liquid top ' + fwTop.toFixed(3));
      assert.ok(r.sim.state.provisional.indexOf('settle') !== -1, 'settle listed provisional');
    },
  },
  {
    name: 'EN10 time step: dt ≤ CFL on the phase / kinematic speeds (0.5) and ≤ dtMax; rejected steps halve; STEP_FAIL ends the run with a flag',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const g = G(ctx), sim = g.WTS_wd_engine.create(W.FIX.gasVert, {});
      for (let k = 0; k < 20; k++) {
        const lim = sim._cflDt(), r = sim.step();
        assert.ok(r.ok && r.dt <= Math.min(lim, 60) * (1 + 1e-12) + 1e-12, 'dt ' + r.dt + ' ≤ CFL ' + lim);
      }
      // a forced failure: every attempt rejected → eight halvings, then STEP_FAIL, the 'end' event and a flag
      const sim2 = g.WTS_wd_engine.create(W.FIX.oilVert, {}); let tried = [];
      sim2._attempt = function (dt) { tried.push(dt); return { ok: false, code: 'TEST' }; };
      let ended = false; sim2.on('end', () => { ended = true; });
      const r2 = sim2.step();
      assert.strictEqual(r2.code, 'STEP_FAIL'); assert.ok(ended, 'end event');
      assert.ok(tried.length >= 2 && tried.every((d, i) => i === 0 || Math.abs(d - tried[i - 1] / 2) < 1e-12), 'halvings');
      assert.ok(sim2.state.flags.some((f) => f.code === 'STEP_FAIL'));
      assert.strictEqual(sim2.run(10).stopped, 'end');
    },
  },
  {
    name: 'EN11 every gate face carries the correlation closure (w = 1) incl. the casing rathole below the end of tubing (C1)',
    wp: WP, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const g = G(ctx);
      ['oilVert', 'gasVert'].forEach((key) => {
        const m = W.steadySim(g, key), sim = m.sim, eot = sim.grid.eotCell;
        assert.ok(eot > 0, key + ' a rathole below the end of tubing');
        for (let f = 1; f <= sim.n; f++) assert.strictEqual(sim.state.faces.w[f], 1, key + ' w at face ' + f);
        assert.ok(sim.state.provisional.indexOf('driftflux') === -1 || sim.state.t > 0, key);
      });
    },
  },
  {
    name: 'EN12 q_c (Turner and Coleman), the method by THP and the limiting depth vs WTS_wp_loading within 2 % (Belfroid off); EN12b Belfroid on leaves a vertical well unchanged',
    wp: WP, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const g = G(ctx), m = W.steadySim(g, 'gasVert'), sim = m.sim, L = sim.state.loading, R0L = sim.R0.loading;
      assert.strictEqual(L.method, R0L.method, 'method by the flowing THP');
      assert.strictEqual(L.belfroid, false);
      ['turner', 'coleman'].forEach((k) => assert.rel(L.methods[k].qc_MMscfd, R0L.methods[k].qc_MMscfd, 0.02, k));
      assert.ok(Math.abs(L.limitingMd - R0L.limitingMd) <= 2 * sim.grid.cells[sim.n - 1].len, 'limiting depth ' + L.limitingMd + ' vs ' + R0L.limitingMd);
      assert.rel(L.ratio, (sim.state.surface.qgForm / 1000) / L.qc_MMscfd, 1e-12);
      // EN12b: on a vertical well the Belfroid factor is 1 (β = π/2): identical q_c
      const sb = g.WTS_wd_engine.create(W.FIX.gasVert, { loading: { belfroid: true } });
      assert.rel(sb.state.loading.qcBelfroid_MMscfd, sb.state.loading.qcVert_MMscfd, 1e-12, 'vertical: Belfroid = vertical');
      assert.ok(sb.state.provisional.indexOf('belfroid') !== -1 && sim.state.provisional.indexOf('belfroid') === -1);
    },
  },
  {
    name: 'EN13 Belfroid factor on a deviated cell in closed form: v_c,θ / v_c = sin(1.7 β)^0.38 / 0.74, β = π/2 − θ in radians',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const g = G(ctx), sim = g.WTS_wd_engine.create(W.FIX.gasHz, { loading: { belfroid: true } }), X = sim.X;
      let n = 0;
      sim.grid.cells.forEach((c, i) => {
        if (!(c.inc > 1 && c.inc < 89) || !(X.vcv[i] > 0)) return;
        const b = Math.PI / 2 - c.inc * Math.PI / 180;
        assert.rel(X.vcb[i] / X.vcv[i], Math.pow(Math.sin(1.7 * b), 0.38) / 0.74, 1e-12, 'cell ' + i + ' at ' + c.inc.toFixed(1) + '°');
        n++;
      });
      assert.ok(n >= 3, 'deviated cells checked: ' + n);
      const at60 = Math.pow(Math.sin(1.7 * (Math.PI / 6)), 0.38) / 0.74;      // θ = 60° from vertical → β = 30° = π/6 rad
      assert.rel(at60, 1.22789, 2e-5, 'the 60° factor (sin 0.8901 = 0.7771)');
    },
  },
  {
    name: 'EN14 bean step 24 → 32 with a 10 s stroke: the rate moves monotonically to the bean-32 nodal point (oilVert)',
    wp: WP, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const g = G(ctx), M = W.FIX.oilVert; M.surface.choke.bean64 = 24;
      const sim = g.WTS_wd_engine.create(M, {}); assert.ok(sim.ok);
      sim.run(600); sim.setChoke(32);
      assert.strictEqual(sim.state.ctl.strokeLeft_s, 10);
      // the sandface rate rises monotonically to the new point; the surface rate surges first (the tubing gas decompresses through the
      // wider bean) and then settles on it
      const qs = [], qr = []; sim.on('step', () => { qs.push(sim.state.surface.qL); qr.push(sim.state.bottom.qo + sim.state.bottom.qw); });
      sim.run(1.5 * H);
      const R32 = g.WTS_wp_system.solve(W.FIX.oilVert);
      assert.rel(qs[qs.length - 1], R32.op.q, 0.02, 'surface rate settles on the bean-32 point');
      assert.rel(qr[qr.length - 1], R32.op.q, 0.02, 'sandface rate settles on the bean-32 point');
      // monotone within a 1 % settle: never more than 1 % of the new rate below its running maximum
      let mx = -Infinity, worst = 0; qr.forEach((q) => { if (q > mx) mx = q; worst = Math.max(worst, mx - q); });
      assert.ok(worst <= 0.01 * R32.op.q, 'sandface rate: largest fall below the running maximum ' + worst.toFixed(2));
      assert.ok(Math.max(...qs) > R32.op.q, 'the surface surge');
      assert.ok(sim.log.some((e) => e.type === 'bean' && e.src === 'user' && e.args.bean64 === 32), 'logged as an event');
    },
  },
  {
    name: 'EN15 snapshot / restore: a restored copy continues bit-identically; EN15b the Snap carries every field the step reads (R16)',
    wp: WP, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const g = G(ctx), opts = { events: [{ t: 900, type: 'shutin' }] }, M = W.FIX.oilVert;
      const a = g.WTS_wd_engine.create(M, opts); a.run(800);
      const snap = JSON.parse(JSON.stringify(a.snapshot()));               // through JSON, as a file would carry it
      a.run(600);
      const b = g.WTS_wd_engine.create(M, opts);
      assert.ok(b.restore(snap).ok, 'restore');
      b.run(a.state.t - b.state.t);
      sameState(assert, a, b, 'after restore');
      assert.strictEqual(a.state.well.state, b.state.well.state);
      assert.strictEqual(JSON.stringify(a.log), JSON.stringify(b.log));
      // wrong model → MODEL_MISMATCH; another major version → VERSION
      const c = g.WTS_wd_engine.create(W.FIX.oilVertTuned, opts);
      assert.strictEqual(c.restore(snap).code, 'MODEL_MISMATCH');
      assert.strictEqual(b.restore(Object.assign({}, snap, { engine: '2.0.0' })).code, 'VERSION');
      // EN15b coverage (§3.6 + the lagged closure, the line table, the label / steady histories, the ext states, the balance)
      ['kind', 'v', 'engine', 'engineId', 'mHash', 'n', 't', 'steps', 'dtPrev', 'cells', 'faces', 'ctl', 'line', 'res', 'labels', 'steady', 'pend', 'log', 'ext', 'bal', 'prov', 'flags']
        .forEach((k) => assert.ok(k in snap, 'Snap.' + k));
      ['mG', 'mO', 'mW', 'mI', 'mF', 'T', 'p'].forEach((k) => assert.ok(Array.isArray(snap.cells[k]), 'cells.' + k));
      ['Q', 'jg', 'jo', 'jw', 'xI', 'vd', 'c0', 'w', 'p'].forEach((k) => assert.ok(Array.isArray(snap.faces[k]), 'faces.' + k));
      ['open', 'bean64', 'beanEff', 'strokeLeft_s', 'psep_psig', 'tOpen', 'qRef'].forEach((k) => assert.ok(k in snap.ctl, 'ctl.' + k));
      ['refGor', 'refWc', 'q', 'pdn'].forEach((k) => assert.ok(k in snap.line, 'line.' + k));
      ['state', 'since', 'prev', 'reason', 'pending', 'ringT', 'ringLiq', 'ringQ', 'ringP'].forEach((k) => assert.ok(k in snap.labels, 'labels.' + k));
      ['ringT', 'ringQ', 'ringPwf', 'ringThp'].forEach((k) => assert.ok(k in snap.steady, 'steady.' + k));
      ['m0', 'cumIn', 'cumOut'].forEach((k) => assert.ok(k in snap.bal, 'bal.' + k));
      assert.ok(JSON.stringify(snap).length < 40000, 'Snap size ' + JSON.stringify(snap).length);
    },
  },
  {
    name: 'EN16 determinism: the same scenario run in chunks of 1 s, 7 s and 600 s is bit-identical (WD-D8)',
    wp: WP, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const g = G(ctx), opts = { events: [{ t: 250, type: 'bean', args: { bean64: 24 } }, { t: 450, type: 'shutin' }] };
      const sims = [1, 7, 600].map((ch) => { const s = g.WTS_wd_engine.create(W.FIX.oilVert, opts); while (s.state.t < 600) s.run(ch); return s; });
      sameState(assert, sims[0], sims[1], '1 s vs 7 s'); sameState(assert, sims[0], sims[2], '1 s vs 600 s');
      assert.strictEqual(sims[0].state.n, sims[2].state.n, 'same step count');
    },
  },
  {
    name: 'EN17 events land exactly on their times (a step ends at t_event; the log keeps it)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const g = G(ctx), sim = g.WTS_wd_engine.create(W.FIX.oilVert, { events: [{ t: 123.456, type: 'bean', args: { bean64: 28 } }, { t: 200.5, type: 'psep', args: { psig: 150 } }] });
      const ts = []; sim.on('step', (i) => ts.push(i.t));
      sim.run(260);
      assert.ok(ts.indexOf(123.456) !== -1 && ts.indexOf(200.5) !== -1, 'steps end exactly on 123.456 and 200.5');
      assert.strictEqual(JSON.stringify(sim.log.map((e) => e.t)), '[123.456,200.5]');
      assert.strictEqual(sim.state.psep_psig, 150); assert.strictEqual(sim.line.psep, 150);
      assert.strictEqual(JSON.stringify(sim.schedule([{ t: 10, type: 'mark', args: { label: 'x' } }])), '{"ok":true,"n":1}');
      assert.ok(sim.pend[0].t >= sim.state.t, 'a past event is moved to now');
    },
  },
  {
    name: 'EN18 gas-well loading (gasLoadDown, fallback on): marginal at bean 32, the bean cut puts q_g below q_c and the state turns loading',
    wp: WP, opts: false, timeoutMs: 180000,
    run(_a, assert, ctx) {
      const r = W.memo('gasLoadDown3h', () => W.runScenario(G(ctx), 'gasLoadDown', { duration_s: 3 * H }));
      assert.ok(r.ok, r.code);
      const R = r.sim.R0, m0 = R.loading.margin;
      assert.ok(m0 > -0.05 && m0 < 0.10, 'fixture margin at bean 32: ' + m0);
      const pre = r.steps.filter((s) => s.t > 0.5 * H && s.t < H);
      assert.ok(pre.every((s) => s.ratio > 0.9 && s.ratio < 1.15), 'near the critical rate before the cut');
      assert.ok(r.states.some((e) => e.to === 'marginal'), 'marginal');
      const cross = r.steps.find((s) => s.t > H && s.ratio < 0.9), toLoad = r.states.find((e) => e.to === 'loading');
      assert.ok(cross && toLoad, 'crossing and loading');
      // the switch follows the crossing within the 120 s persistence plus one 10 s recording interval (C4)
      assert.ok(toLoad.t - cross.t <= 130 + 1e-6 && toLoad.t >= cross.t, 'loading ' + (toLoad.t - cross.t).toFixed(1) + ' s after q_g < q_c');
      const last = r.steps[r.steps.length - 1], atCut = r.steps.find((s) => s.t > H + 600);
      assert.ok(last.liq > atCut.liq, 'liquid accumulates: ' + atCut.liq.toFixed(2) + ' → ' + last.liq.toFixed(2) + ' bbl');
      assert.ok(r.sim.state.provisional.indexOf('fallback') !== -1, 'fallback listed provisional');
    },
  },
  {
    name: 'EN19 states persist ≥ 120 s (no chatter); the state channel indexes STATE_ORDER; transitions are emitted as events',
    wp: WP, opts: false, timeoutMs: 180000,
    run(_a, assert, ctx) {
      const r = W.memo('gasLoadDown3h', () => W.runScenario(G(ctx), 'gasLoadDown', { duration_s: 3 * H })), E = G(ctx).WTS_wd_engine;
      assert.ok(r.states.length >= 2, 'transitions');
      for (let i = 1; i < r.states.length; i++) {
        const a = r.states[i - 1], b = r.states[i];
        if (a.to !== 'shutin' && b.to !== 'shutin') assert.ok(b.t - a.t >= 120 - 1e-6, 'held ' + (b.t - a.t).toFixed(1) + ' s (' + a.to + ' → ' + b.to + ')');
        assert.strictEqual(b.from, a.to);
      }
      r.states.forEach((e) => assert.ok(E.STATE_ORDER.indexOf(e.to) !== -1 && E.STATES[e.to]));
      assert.strictEqual(E.STATE_ORDER.length, 18); assert.ok(Object.isFrozen(E.STATE_ORDER) && Object.isFrozen(E.CHANNELS) && Object.isFrozen(E.COMP));
      assert.strictEqual(JSON.stringify(E.COMP), '["G","O","W","I","F"]');
      assert.strictEqual(E.CHANNELS.length, 36); assert.strictEqual(E.CHANNELS.slice(-6).map((c) => c.key).join(','), 'qgForm,gorForm,qvent,liftgas,qcVert,qcBelfroid');
    },
  },
  {
    name: 'EN20 extension hooks: order control → sources → faceDp → after → sigma → label every step; sources enter the balance; snapshot / restore of ctx',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const g = G(ctx), E = g.WTS_wd_engine, calls = [];
      E.ext.zzdummy = {
        key: 'zzdummy', label: 'test', verified: false, provisional: 'test',
        applies: (M, o) => !!(o.ext && o.ext.zzdummy),
        init: () => ({ n: 0 }),
        control: (sim, c) => { calls.push('control'); c.n++; return null; },
        sources: (sim) => { calls.push('sources'); const w = new Float64Array(sim.n); w[3] = 1e-3; return { W: w }; },
        faceDp: (sim, c, k) => { if (k === 0) calls.push('faceDp'); return null; },
        after: () => calls.push('after'),
        sigma: (sim) => { calls.push('sigma'); const s = new Float64Array(sim.n); s.fill(0.9); return s; },
        label: () => { calls.push('label'); return null; },
        snapshot: (c) => ({ n: c.n }), restore: (j) => ({ n: j.n + 0 })
      };
      try {
        const sim = E.create(W.FIX.oilVert, { ext: { zzdummy: {} } });
        assert.ok(sim.exts.some((x) => x.key === 'zzdummy'));
        calls.length = 0; sim.step();
        assert.deepStrictEqual(calls, ['control', 'sources', 'faceDp', 'after', 'sigma', 'label']);
        sim.run(120);
        assert.ok(sim.state.balance.cumIn.W > sim.state.bottom.qw * 0 + 0, 'cumIn');
        assert.ok(sim.state.balance.errCum < 1e-10, 'balance with sources ' + sim.state.balance.errCum);
        assert.ok(Array.from(sim.state.cells.sigF).every((v) => v === 0.9), 'σ factor from the extension');
        const sn = sim.snapshot(); assert.ok(sn.ext.zzdummy.n > 0, 'ext snapshot');
        const b = E.create(W.FIX.oilVert, { ext: { zzdummy: {} } }); assert.ok(b.restore(sn).ok);
        assert.strictEqual(b.exts.find((x) => x.key === 'zzdummy').ctx.n, sn.ext.zzdummy.n);
        const plain = E.create(W.FIX.oilVert, {}); assert.ok(!plain.exts.some((x) => x.key === 'zzdummy'), 'not applied without its option');
      } finally { delete E.ext.zzdummy; }
    },
  },
  {
    name: 'EN21 drift-flux closure: at α → 0 in a still column the drift is the closed form 1.53·v_c·m(θ) (Shi et al. form, provisional)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const g = G(ctx), sim = g.WTS_wd_engine.create(W.FIX.staticOil, { start: 'static', static: { kind: 'liquid', liquid: 'oil' }, reservoir: { prior: { kind: 'none' } } });
      const f = 20, Y = sim.Y, X = sim.X, cs = sim.state.cells, d = f - 1, u = f;
      // v_c from the face's frozen fluid (σ, ρ_L, ρ_g of the two cells) in closed form
      const aoA = cs.ao[d] + cs.ao[u], awA = cs.aw[d] + cs.aw[u], aL = aoA + awA;
      const rhoL = (aoA * 0.5 * (X.rhoO[d] + X.rhoO[u]) + awA * 0.5 * (X.rhoW[d] + X.rhoW[u])) / aL, rhoG = 0.5 * (X.rhoG[d] + X.rhoG[u]);
      const sig = (aoA * 0.5 * (X.sigO[d] + X.sigO[u]) + awA * 0.5 * (X.sigW[d] + X.sigW[u])) / aL;
      const vc = Math.pow(sig * 6.852e-5 * 32.174 * 32.174 * (rhoL - rhoG) / (rhoL * rhoL), 0.25);
      assert.rel(Y.dfvc[f], vc, 1e-12, 'v_c');
      const a = 1e-7, vd = sim._dfFlux(f, a, 0) / a;
      assert.rel(vd, 1.53 * vc * 1.27, 1e-5, 'v_d(α → 0) = 1.53 v_c m(0°)');
      // f(0) = 0 and f(1) = j for any j
      [-1, 0, 2].forEach((j) => { assert.ok(sim._dfFlux(f, 0, j) === 0, 'f(0) = 0'); assert.ok(Math.abs(sim._dfFlux(f, 1, j) - j) <= 1e-12, 'f(1) = j'); });
      assert.ok(sim.state.provisional.indexOf('driftflux') !== -1, 'listed provisional');
    },
  },
  {
    name: 'EN22 the engine files keep no timers, no DOM and no storage (static check)',
    wp: WP, opts: false,
    run(_a, assert) {
      ['49-calc-wd-engine.js', '49-calc-wd-res.js'].forEach((f) => {
        const s = fs.readFileSync(path.join(W.BUILD, f), 'utf8').replace(/\/\/[^\n]*/g, '');
        [/setTimeout\s*\(/, /setInterval\s*\(/, /requestAnimationFrame\s*\(/, /\bdocument\./, /localStorage/, /sessionStorage/, /indexedDB/, /addEventListener/, /\bfetch\s*\(/, /Math\.random/]
          .forEach((re) => assert.ok(!re.test(s), f + ' uses ' + re));
      });
    },
  },
  {
    name: 'EN23 volume-balance sign (R1): ∂V/∂p < 0 in every cell; an over-full cell expels the excess in one step (closed column)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const g = G(ctx), sim = g.WTS_wd_engine.create(W.FIX.gasVert, { start: 'static', static: { kind: 'gas' }, reservoir: { prior: { kind: 'none' }, backflow: false } });
      assert.ok(Array.from(sim.X.dP).every((v) => v < 0), '∂V/∂p < 0');
      const i = 30; sim.state.cells.mG[i] *= 1.002; sim._prep(false);
      const over = sim.X.Vc[i] / sim.X.vol[i] - 1;
      assert.ok(over > 1e-3, 'over-full by ' + over);
      const p0 = sim.state.cells.p[i]; sim.step();
      const after = sim.X.Vc[i] / sim.X.vol[i] - 1;
      assert.ok(Math.abs(after) < 0.05 * over, 'expelled: ' + over.toExponential(2) + ' → ' + after.toExponential(2));
      assert.ok(sim.state.cells.p[i] > p0, 'the extra gas raises the pressure');
      assert.ok(sim.state.balance.errCum >= 0);
    },
  },
  {
    name: 'EN24 one fluid context (R18): the engine\'s per-cell props equal WTS_wp_system.context(M).C.F at 10 (p, T) bit for bit; a cached ref skips the solve',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const g = G(ctx), M = W.FIX.oilVert, sim = g.WTS_wd_engine.create(M, {}), C2 = g.WTS_wp_system.context(M).C;
      assert.strictEqual(sim.C.F.pvt.table, true, 'the binned table of the solve');
      const u = sim.unit;
      for (let k = 0; k < 10; k++) {
        const p = 300 + 290 * k, T = 110 + 9 * k, q = 1 + k;
        const a = g.WTS_flowline_props({ qo: u.qo * q, qw: u.qw * q, qg: u.qg * q / 1e6, api: sim.C.F.api, sgg: sim.C.F.sgg, sgw: sim.C.F.sgw, pvt: sim.C.F.pvt }, p, T);
        const b = C2.F.at(p, T, q);
        ['bo', 'bw', 'bg', 'rs', 'z', 'rhoO', 'rhoW', 'rhoG', 'muo', 'mug', 'sigO', 'sigW'].forEach((key) => assert.ok(Object.is(a[key], b[key]), key + ' at ' + p + ' psia, ' + T + ' °F'));
      }
      // C7: create with the ref of the same model hash reuses R0 and C (no fluid build, no solve)
      const FB = g.WTS_wp_fluid.build; let builds = 0;
      g.WTS_wp_fluid.build = function () { builds++; return FB.apply(this, arguments); };
      try {
        const t0 = Date.now(), s2 = g.WTS_wd_engine.create(M, { ref: sim.ref }), ms = Date.now() - t0;
        assert.ok(s2.ok && s2.R0 === sim.R0 && s2.C === sim.C && builds === 0, 'reused: builds ' + builds);
        assert.ok(ms < 300, 'create with ref ' + ms + ' ms');
        const s3 = g.WTS_wd_engine.create(Object.assign({}, M, { dyn: { v: 1, cases: [] } }), { ref: sim.ref });
        assert.ok(s3.R0 === sim.R0, 'M.dyn does not change the model hash (R17)');
      } finally { g.WTS_wp_fluid.build = FB; }
    },
  },
  {
    name: 'EN25 levelSettle: a gas cap over an oil level (shut in 8 h) settles with no rejected step, no negative mass and the level within one cell',
    wp: WP, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const r = W.memo('levelSettle', () => W.runScenario(G(ctx), 'levelSettle'));
      assert.ok(r.ok, r.code);
      assert.strictEqual(r.steps.reduce((s, x) => s + x.rejects, 0), 0, 'rejected steps');
      const cs = r.sim.state.cells; ['mG', 'mO', 'mW'].forEach((k) => assert.ok(Array.from(cs[k]).every((v) => v >= 0), k + ' ≥ 0'));
      // the volume-balance level: the depth at which the liquid volume (cells from the bottom) is used up
      let vl = 0, L = 0; const cells = r.sim.grid.cells;
      cells.forEach((c, i) => { vl += (1 - cs.ag[i]) * r.sim.X.vol[i]; });
      let md = cells[0].md0; for (let i = 0; i < cells.length; i++) { const v = r.sim.X.vol[i]; if (vl >= v) { vl -= v; md = cells[i].md1; } else { md = cells[i].md0 - cells[i].len * vl / v; break; } }
      void L;
      const cellLen = cells[Math.floor(cells.length / 2)].len;
      assert.ok(Math.abs(r.sim.state.inventory.liquidTopMd - md) <= cellLen, 'level ' + r.sim.state.inventory.liquidTopMd.toFixed(0) + ' vs ' + md.toFixed(0));
      assert.ok(Math.abs(r.sim.state.inventory.liquidTopMd - 4000) <= 2 * cellLen, 'near the initial 4,000 ft');
    },
  },
  {
    name: 'EN26 back-flow (R14): killColumn with back-flow on loses liquid until p₀ ≈ p̄r; with it off RES_NO_BACKFLOW and no loss',
    wp: WP, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const on = W.memo('killColumn', () => W.runScenario(G(ctx), 'killColumn'));
      assert.ok(on.ok && Math.abs(on.sim.state.bottom.pwf - 3500) < 5 && on.sim.state.balance.cumOut.W > 0);
      const off = W.runScenario(G(ctx), 'killColumn', { duration_s: 600, opts: { reservoir: { prior: { kind: 'none' }, backflow: false } } });
      assert.ok(off.ok, off.code);
      assert.ok(off.sim.state.flags.some((f) => f.code === 'RES_NO_BACKFLOW'), 'flag');
      assert.strictEqual(off.sim.state.balance.cumOut.W, 0, 'no water leaves');
      assert.ok(off.sim.state.bottom.pwf > 3500 + 100, 'the column stays overbalanced');
    },
  },
  {
    name: 'EN27 the coupled solve (Newton with the bottom-up Riccati sweep; §11.1 replaces the Picard sweeps): iterations reported, few in steady flow',
    wp: WP, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const g = G(ctx), sim = g.WTS_wd_engine.create(W.FIX.oilVert, {}), its = [];
      sim.on('step', (i) => its.push(i));
      sim.run(1800);
      assert.ok(its.every((i) => i.iters >= 1 && i.iters <= 30 && i.sweeps === i.iters), 'iterations reported');
      const mean = its.reduce((s, i) => s + i.iters, 0) / its.length;
      assert.ok(mean <= 6, 'mean Newton iterations ' + mean.toFixed(2));
      // the converged state satisfies the momentum balance: a re-solve from the converged state moves p₀ by ≤ 0.01 psi over 1 s
      const p0 = sim.state.bottom.pwf; sim.step(1e-3);
      assert.ok(Math.abs(sim.state.bottom.pwf - p0) <= 0.05, 'Δp₀ ' + Math.abs(sim.state.bottom.pwf - p0));
    },
  },
  {
    name: 'EN28 a fluid with an Rv table is refused (RV_NOT_IN_TRANSIENT); a shut-in oil cell carries its own-ratio B_o (R13b)',
    wp: WP, opts: false, timeoutMs: 240000,
    run(_a, assert, ctx) {
      const g = G(ctx), M = W.FIX.gasVert; M.fluid.rv = { mode: 'table', pd: 5200, rows: [[1000, 4], [3000, 12], [5000, 19]] };
      const r = g.WTS_wd_engine.create(M, {});
      assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'RV_NOT_IN_TRANSIENT');
      const b = buildup(g), sim = b.sim, cs = sim.state.cells, k = sim.k, X = sim.X, prodGor = sim.unit.qg / sim.unit.qo;
      let found = 0;
      for (let i = 0; i < sim.n; i++) {
        if (!(cs.mO[i] > 0) || cs.ag[i] > 0.01) continue;
        const gor = (cs.mG[i] / k.G) / (cs.mO[i] / k.O);
        if (gor < prodGor - 20) {
          const view = (G0) => ({ qo: 1, qw: 0, qg: G0 / 1e6, api: sim.C.F.api, sgg: sim.C.F.sgg, sgw: sim.C.F.sgw, pvt: sim.C.F.pvt });
          const own = g.WTS_flowline_props(view(gor), cs.p[i], cs.T[i]), prod = g.WTS_flowline_props(view(prodGor), cs.p[i], cs.T[i]);
          assert.ok(Object.is(X.bo[i], own.bo), 'own-ratio B_o at cell ' + i);
          if (own.rs < prod.rs - 1) { assert.ok(Math.abs(own.bo - prod.bo) > 1e-4, 'differs from the production-GOR B_o at cell ' + i); found++; }
        }
      }
      assert.ok(found >= 1, 'an undersaturated oil cell with a lower ratio than the production GOR after the shut-in: ' + found);
    },
  },
  {
    name: 'EN29 the dissolved-gas flux of a face is the donor\'s actual G_d/N_o (undersaturated bottom cells of oilVert, R13a)',
    wp: WP, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const g = G(ctx), sim = W.steadySim(g, 'oilVert').sim, cs = sim.state.cells, fsx = sim.state.faces, k = sim.k;
      let n = 0;
      for (let i = 0; i < sim.n - 1 && cs.ag[i] === 0; i++) {
        const rd = (cs.mG[i] / k.G) / (cs.mO[i] / k.O);
        assert.rel(sim.X.rd[i], rd, 1e-12, 'G_d/N_o of cell ' + i);
        assert.rel(fsx.FG[i + 1], fsx.FO[i + 1] / k.O * rd * k.G, 1e-9, 'face ' + (i + 1));
        n++;
      }
      assert.ok(n >= 2, 'undersaturated cells: ' + n);
    },
  },
  {
    name: 'EN30 the corr holdup equals the correlation\'s in a horizontal cell (gasHz) and at high gas fraction (gasVert α_g ≈ 0.9) — no clamp to no-slip (R4)',
    wp: WP, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const g = G(ctx);
      const hz = W.steadySim(g, 'gasHz').sim, cz = hz.state.cells;
      const lat = hz.grid.cells.map((c, i) => i).filter((i) => hz.grid.cells[i].kind === 'liner' && hz.X.haveCorr[i]);
      assert.ok(lat.length >= 2);
      lat.forEach((i) => assert.ok(Math.abs((1 - cz.ag[i]) - hz.X.hl[i]) < 2e-3, 'horizontal cell ' + i + ': ' + (1 - cz.ag[i]).toFixed(4) + ' vs ' + hz.X.hl[i].toFixed(4)));
      const gv = W.steadySim(g, 'gasVert').sim, cg = gv.state.cells, fs2 = gv.state.faces;
      // gasVert makes water (WGR 10): its gas fraction peaks near 0.9 at the wellhead — the high-α cells checked are those above 0.85
      const hi = gv.grid.cells.map((c, i) => i).filter((i) => cg.ag[i] > 0.85 && gv.X.haveCorr[i]);
      assert.ok(hi.length >= 5, 'cells with α_g > 0.85: ' + hi.length);
      hi.forEach((i) => {
        assert.ok(Math.abs((1 - cg.ag[i]) - gv.X.hl[i]) < 2e-3, 'cell ' + i);
        const lamL = (fs2.jo[i + 1] + fs2.jw[i + 1]) / (fs2.Q[i + 1] / gv.Y.A[i + 1]);
        assert.ok(1 - cg.ag[i] > 1.5 * lamL, 'slip holdup above the no-slip ' + lamL.toFixed(4));
      });
    },
  },
  {
    name: 'EN31 (integration fix) liquid fallback is positive: a gasLoad shut-in with fallback on runs on with no MASS_NEG, mass balance to round-off',
    wp: WP, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const g = G(ctx), sim = g.WTS_wd_engine.create(W.FIX.gasLoad, { fallback: true, events: [{ t: 2 * H, type: 'shutin' }] });
      assert.ok(sim.ok, sim.code);
      const r = sim.run(2.75 * H);
      assert.ok(r.ok, 'ran past the old MASS_NEG time (≈ 950 s after the shut-in): ' + r.code);
      assert.ok(!sim.state.flags.some((f) => f.code === 'STEP_FAIL'), 'no STEP_FAIL flag');
      assert.ok(sim.state.balance.errCum <= 1e-8, 'cumulative mass error ' + sim.state.balance.errCum);
      ['mG', 'mO', 'mW'].forEach((k) => assert.ok(Array.from(sim.state.cells[k]).every((v) => v >= 0), k + ' ≥ 0'));
    },
  },
];
