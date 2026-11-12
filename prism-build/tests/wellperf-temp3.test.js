// Well Performance WP22 — enthalpy-balance flowing temperature, increment B (docs/WELL-PERFORMANCE-PLAN.md §4.6 "B", §15.1 gate,
// §16 budgets, §18.3, record §18.3.x: wellperf-temp3).
//
// TH1 identity: WTS_wellbore.flowingTemp without layers / src is the v4.4 result; a zero source and one full-length layer with the scalar U
//     and k_e reproduce it to 1e-12; relax() on the fixtures carries no layer keys unless asked
// TH2 reference profile with a source: closed form T = T_ei + (T_in − T_ebh)e^(−z/A) + (ψ + g_G sinθ)A(1 − e^(−z/A)) on vertical and
//     inclined holes; RK4 of dT/dz = (T_ei − T)/A_k + ψ(z) with a step source and two U layers on the deviated FIX.gasWell path < 0.02 °F;
//     adiabatic limit (U → 0) with the gravity term alone = the lapse TVD / (J c_p)
// TH3 the liquid identity: for a hydrostatic single-phase water column the J-T and gravity terms add to −β T_R sinθ / (J c_p) exactly
//     (the adiabatic expansion of a liquid), so with β = 0 the enthalpy balance is the relaxation; η_water against −(1 − βT)·144/(ρ J c_p)
// TH4 gas: mixture η of a free-gas stream = the real-gas μ_JT of WTS_gaspvt_state (≤ 0.5 %) and of the isenthalp (≤ 3 %); the gas well cools
//     below the relaxation; the energy budget closes exactly (T_in + loss + J-T + gravity + kinetic = THT)
// TH5 layered U: piece cuts and A per layer; a hot / cold layer moves the THT the right way; the model round trip of geo.layers
//     (validate drops bad rows, M.well.heat.layers), the schematic layers with MD and TVD
// TH6 the solver in the enthalpy mode: R.heat (thtRelax, dT, budget, eta, passCheck, layers), traverse tRelax, THT = the profile at the
//     operating rate, the hydrate check takes it as it is (verdict 'enthalpy'), PROVISIONAL_TEMP flag, evaluation budget (pred ¼ E each),
//     warm = cold; gas lift and no-geotherm fall back
// TH7 p_out(q) smooth on the frozen grids in the enthalpy mode (second differences < 0.01 psi) and the pass check < 0.5 °F on both fixtures
// TH8 U fit in the enthalpy mode holds the J-T source (fitU {rows}, WTS_wp_match.thtFit row.model 'enthalpy') and reproduces the THT
// TH9 gate (§15.1, D17): BENCH 'temp enthalpy' pending, never the default; the model default stays linear
// TH10 page: the option, the enthalpy box (KPI cells, energy-budget waterfall), traverse with the relaxation comparison and the U / TIME rails,
//     KPI chip, schematic J-T colouring and the layer sleeves (keyboard / click edit), the layers table with TVD columns, checks / case /
//     Notes captured inside #wp_res, no NaN, phone width
'use strict';

const S = require('./_wellperf-shapes');

const WP = 'WP22';
const BAD = /NaN|undefined|Infinity|\[object Object\]/;
const txt = (e) => String(e && e.textContent || '').replace(/\s+/g, ' ').trim();
const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const app = (ctx) => S.sharedApp(ctx);
const near = (assert, a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, what + ': ' + a + ' vs ' + b + ' (tol ' + tol + ')');
const P = (A) => A.win.WTS_wellperf_page;
const J = 778.17;

const straight = (WB, incDeg, td) => WB.column({ datumTvd: td * Math.cos(incDeg * Math.PI / 180), survey: incDeg ? [[0, incDeg, 0], [td, incDeg, 0]] : [[0, 0], [td, td]],
  strings: [{ id: 2.441, od: 2.875, topMd: 0, botMd: td }, { id: 6.276, od: 7, topMd: 0, botMd: td }] });
const BASE = { w: 12000, cp: 0.55, U_to: 2, r_to: 2.875 / 24, ke: 1.4, alpha: 0.04, rwb: 8.5 / 24, t_hr: 720, geo: { surfF: 60, gradFper100: 1.6 } };
const enth = (M) => { M.well.heat.mode = 'enthalpy'; return M; };
const build = (G, M) => ({ F: G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F, table: true }), W: G.WTS_wp_well.build(M.well, { res: M.res, fluidType: M.fluid.type, tests: M.tests, surface: M.surface }) });

function page(ctx) {
  const A = app(ctx);
  S.resetWellPerf(A); P(A).resetJobs(); P(A).budget(1e6);
  A.hook.nav('wellperf'); A.flush(30);
  A.click(A.find('[data-act="example"][data-ex="gas"]')); A.flush(30);
  return A;
}

module.exports = [
  {
    name: 'TH1 identity: flowingTemp without layers / src is the v4.4 result; a zero source and one full-length layer at the scalar U reproduce it; relax() without layers has none',
    wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, WB = G.WTS_wellbore;
      [[0, 9000], [55, 11000]].forEach(([inc, td]) => {
        const c = straight(WB, inc, td), o = Object.assign({}, BASE, { Tin: 210 });
        const a = WB.flowingTemp(c, o);
        assert.ok(a.ok && a.layers === undefined && a.src === undefined && !('psi' in a.profile[1]), 'no new keys without the options');
        const b = WB.flowingTemp(c, Object.assign({}, o, { src: () => 0, layers: [{ topMd: -10, botMd: td + 10, U_to: 2, ke: 1.4 }] }));
        let worst = 0; [0, 1234, td / 2, td - 1, td].forEach((md) => { worst = Math.max(worst, Math.abs(a.tAt(md) - b.tAt(md))); });
        assert.ok(worst < 1e-12 && Math.abs(a.tOut - b.tOut) < 1e-12 && Math.abs(a.offsetOut - b.offsetOut) < 1e-12, 'zero source + equal layer: ' + worst);
        assert.ok(b.src === true && b.layers.length === 1, 'flags on the result');
      });
      const M = S.FIX.oilWell; M.well.heat.mode = 'relax';
      const { F, W } = build(G, M), r = G.WTS_wp_well.relax(W, F, 900);
      assert.ok(r.ok && r.layers === null, 'relax without layers: layers null');
      assert.strictEqual(G.WTS_wp_model.DEFAULTS.well.heat.layers, undefined, 'the default model has no layers key (shape unchanged)');
    },
  },
  {
    name: 'TH2 reference profile with a source: closed form on straight holes, RK4 with a step source and two U layers on the deviated FIX.gasWell path, the adiabatic gravity lapse',
    wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, WB = G.WTS_wellbore;
      [[0, 9000], [60, 12000]].forEach(([inc, td]) => {
        const psi = -0.0031, c = straight(WB, inc, td), r = WB.flowingTemp(c, Object.assign({}, BASE, { Tin: 215, src: () => psi }));
        const sinT = Math.cos(inc * Math.PI / 180), g = 0.016, tebh = 60 + g * td * sinT, A = r.A;
        [0, 0.2, 0.55, 1].forEach((f) => {
          const z = f * td, md = td - z, tei = tebh - g * z * sinT;
          near(assert, r.tAt(md), tei + (215 - tebh) * Math.exp(-z / A) + (psi + g * sinT) * A * (1 - Math.exp(-z / A)), 1e-9, 'closed form at z ' + z + ' (inc ' + inc + ')');
        });
      });
      const M = S.FIX.gasWell, W = G.WTS_wp_well.build(M.well, { res: M.res }), mid = W.nodes.midPerfMd;
      const geo = { points: [[0, 70], [4000, 120], [9300, 230]] };
      const col = { tvdAt: W.tvdAt, mdAt: W.mdAt, datumMd: mid, survey: W.stations.map((s) => [s.md, s.tvd]), segments: [{ od: 7 }] };
      const layers = [{ topMd: 0, botMd: 2500, U_to: 12, ke: 1.1 }, { topMd: 6000, botMd: 7000, U_to: 0.3 }];
      const psiAt = (md) => (md < 3000 ? 0.012 : md < 6500 ? -0.004 : 0.0021);
      const r = WB.flowingTemp(col, Object.assign({}, BASE, { geo, Tin: 240, layers, src: (a, b) => psiAt(0.5 * (a + b)), srcCuts: [3000, 6500] }));
      assert.ok(r.ok && r.layers.length === 2 && r.Amin < r.A && r.Amax > r.A, 'A per layer: ' + r.Amin + ' < ' + r.A + ' < ' + r.Amax);
      const Aof = (md) => { const L = md <= 2500 ? layers[0] : (md >= 6000 && md <= 7000 ? layers[1] : null); if (!L) return r.A; const ke = L.ke || BASE.ke; return (BASE.w * BASE.cp / (2 * Math.PI)) * (ke + BASE.r_to * L.U_to * r.fTD) / (BASE.r_to * L.U_to * ke); };
      const geoF = (tvd) => (tvd <= 4000 ? 70 + 50 * tvd / 4000 : 120 + 110 * (tvd - 4000) / 5300);
      const f = (md, T) => (geoF(W.tvdAt(md)) - T) / Aof(md) + psiAt(md);
      let T = 240, md = mid, h = 1, worst = 0;
      while (md > 1e-9) {
        const hh = Math.min(h, md), k1 = f(md, T), k2 = f(md - hh / 2, T + hh * k1 / 2), k3 = f(md - hh / 2, T + hh * k2 / 2), k4 = f(md - hh, T + hh * k3);
        T += hh * (k1 + 2 * k2 + 2 * k3 + k4) / 6; md -= hh;
        if (Math.abs(md - Math.round(md / 500) * 500) < 1e-6) worst = Math.max(worst, Math.abs(r.tAt(md) - T));
      }
      worst = Math.max(worst, Math.abs(r.tOut - T));
      assert.ok(worst < 0.02, 'piecewise-exact march vs RK4 (step source, two layers, deviated): ' + worst + ' °F');
      // adiabatic (U → 0) with the gravity term alone: the fluid cools by TVD / (J c_p) on the way up, whatever the path
      const ad = WB.flowingTemp(col, Object.assign({}, BASE, { geo, Tin: 240, U_to: 1e-9, src: (a, b) => -((W.tvdAt(b) - W.tvdAt(a)) / (b - a)) / (J * BASE.cp) }));
      near(assert, ad.tOut, 240 - W.nodes.midPerfTvd / (J * BASE.cp), 1e-3, 'adiabatic gravity lapse');
    },
  },
  {
    name: 'TH3 liquid identity: in a hydrostatic water column J-T + gravity = −β T_R sinθ / (J c_p) exactly (β = 0 → the relaxation); η_water = −(1 − βT)·144 / (ρ J c_p)',
    wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, N = G.WTS_wp_well, B = N.ENTH.beta.water;
      const M = S.FIX.oilWell; M.fluid.wc = 1; M.fluid.gor = 0;
      const { F } = build(G, M), hf = N.heatFlow(F, 1000, { T: 150, p: 2000 });
      assert.ok(hf.ok && hf.frac.water > 0.999, 'single-phase water stream');
      [[3000, 200], [800, 90], [5000, 250]].forEach(([p, T]) => {
        const jm = N.jtMix(F, 1000, p, T, hf), ff = G.WTS_wp_fluid.flowlineFluid(F, 1000), pr = G.WTS_flowline_props(ff, p, T);
        assert.ok(jm.ok && jm.x.water > 0.999, 'water fraction');
        const TR = T + 459.67, ew = -(1 - B * TR) * 144 / (pr.rhoW * J * hf.cpParts.water);
        near(assert, jm.etaWater, ew, 1e-15, 'η_water at ' + p + ' psia, ' + T + ' °F');
        assert.ok(jm.eta > -0.003 && jm.eta < -0.0015, 'water warms by ≈ 0.002–0.003 °F per psi of pressure drop: ' + jm.eta);
        // hydrostatic dp/dz = −ρ sinθ / 144 (psi/ft, z up): ψ_JT + ψ_G = η·dp/dz − sinθ/(J c_p) = −β T_R sinθ / (J c_p)
        [1, 0.5].forEach((sinT) => {
          const psi = jm.eta * (-pr.rhoW * sinT / 144) - sinT / (J * hf.cp);
          near(assert, psi, -B * TR * sinT / (J * hf.cp), 1e-15, 'adiabatic liquid lapse (sinθ ' + sinT + ')');
        });
      });
    },
  },
  {
    name: 'TH4 gas: η = the real-gas μ_JT (state ≤ 0.5 %, isenthalp ≤ 3 %); the gas well cools below the relaxation; the energy budget closes exactly',
    wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, N = G.WTS_wp_well, M = enth(S.FIX.gasWell), { F, W } = build(G, M);
      const hf = N.heatFlow(F, 7400, { T: 160, p: 2500 });
      [[1200, 120], [2500, 160], [4500, 210]].forEach(([p, T]) => {
        const jm = N.jtMix(F, 7400, p, T, hf);
        assert.ok(jm.ok && jm.x.gas > 0.8 && /real-gas Z/.test(jm.gasSource), 'gas-dominated stream');
        const st = G.WTS_gaspvt_state(F.sgg, p, T, 0, 0, 0), ise = G.WTS_gaspvt_isenthalpic({ sg: F.sgg, p1: p, t1: T, p2: p });
        const cpg = hf.cpParts.gas, stateCp = st.cpReal / 4.1868 / st.M;
        near(assert, jm.etaGas * cpg / stateCp, st.muJT, 0.005 * Math.abs(st.muJT), 'η_gas vs WTS_gaspvt_state at ' + p);
        assert.ok(Math.abs(jm.etaGas * cpg / stateCp - ise.muJT1_Fpsi) < 0.03 * Math.abs(ise.muJT1_Fpsi), 'vs the isenthalp');
        assert.ok(jm.etaGas > 0.005, 'gas cools on expansion');
      });
      const I = G.WTS_wp_ipr.curve(M.res, F), q = 7400, rx = N.relax(W, F, q);
      const tr = G.WTS_wp_vlp.traverse(F, W, q, { from: 'bottom', p0: I.pwfAt(q), stepFt: 200, tProfile: rx.tAt });
      const e = N.enthalpy(W, F, q, { rows: tr.profile, budget: true });
      assert.ok(e.ok && e.mode === 'enthalpy' && e.verified === false && /provisional/.test(e.provisional), 'ok, provisional');
      assert.ok(e.tht < e.thtRelax - 5 && e.dT < 0, 'J-T and gravity cool the gas: ' + e.dT);
      const b = e.budget;
      near(assert, b.tIn + b.loss + b.jt + b.grav + b.kin, e.tht, 1e-9, 'budget closes');
      assert.ok(b.jt < 0 && b.grav < 0 && Math.abs(b.kin) < 0.5 && b.loss < 0, 'signs: ' + JSON.stringify(b));
      near(assert, e.thtRelax, rx.tht, 1e-9, 'thtRelax = relax() at the same rate');
      assert.strictEqual(N.enthalpy(W, F, q, { rows: [] }).code, 'NO_PROFILE');
    },
  },
  {
    name: 'TH5 layered U: piece cuts and A per layer, the THT moves the right way, geo.layers round trip (validate, M.well.heat.layers), schematic layers with MD and TVD',
    wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const A = app(ctx), G = A.win, N = G.WTS_wp_well, Mm = G.WTS_wp_model;
      const M = S.FIX.gasWell; M.well.heat.mode = 'relax';
      const { F, W } = build(G, M), r0 = N.relax(W, F, 7400);
      const tht = (layers) => { const M2 = S.FIX.gasWell; M2.well.heat.mode = 'relax'; M2.well.heat.layers = layers; const b = build(G, M2); return N.relax(b.W, b.F, 7400); };
      const hot = tht([{ topMd: 0, botMd: 3000, U: 0.2 }]), cold = tht([{ topMd: 0, botMd: 3000, U: 30, ke: 2 }]), same = tht([{ topMd: 0, botMd: 20000, U: M.well.heat.U_to }]);
      assert.ok(hot.tht > r0.tht + 0.5 && cold.tht < r0.tht - 0.5, 'insulated top warmer, high-U top colder: ' + [cold.tht, r0.tht, hot.tht].join(' / '));
      near(assert, same.tht, r0.tht, 1e-9, 'a layer at the scalar U changes nothing');
      assert.ok(hot.layers.length === 1 && hot.Amax > hot.A, 'layers and A range reported');
      // the model: geo.layers [[top, bot, U, ke]] → M.well.heat.layers; bad rows dropped
      S.resetWellPerf(A);
      const v = Mm.validate({ geo: { points: [[0, 60]], layers: [[0, 2000, 5, null], [3000, 2500, 1], [100, 200, -1], [4000, 4500, 0.5, 1.2]] } });
      assert.deepStrictEqual(plain(v.rec.geo.layers), [[0, 2000, 5, null], [4000, 4500, 0.5, 1.2]], 'validated rows');
      assert.ok(v.warnings.some((w) => /heat layers: 2 row/.test(w.msg)), 'drop warning');
      Mm.write({ geo: { points: [[0, 60], [9000, 220]], layers: [[0, 2000, 5, null]] } });
      const Mr = Mm.read();
      assert.deepStrictEqual(plain(Mr.well.heat.layers), [{ topMd: 0, botMd: 2000, U: 5, ke: null }], 'read back');
      assert.deepStrictEqual(plain(Mr.well.geo.points), [[0, 60], [9000, 220]], 'geo points kept');
      assert.strictEqual(Mm.validate({ geo: { points: [] } }).rec.geo.layers, undefined, 'no layers → no key');
      assert.ok(Mm.SCALARS.wp_heat.enumv.indexOf('enthalpy') !== -1, 'wp_heat accepts enthalpy');
      // schematic
      const M3 = S.FIX.gasWell; M3.well.heat.layers = [{ topMd: 1000, botMd: 4000, U: 0.4, ke: null }];
      const W3 = N.build(M3.well, { res: M3.res }), sc = N.schematic(W3, null);
      assert.ok(sc.ok && sc.heatLayers.length === 1 && sc.heatLayers[0].topTvd < sc.heatLayers[0].botTvd && Math.abs(sc.heatLayers[0].botTvd - W3.tvdAt(4000)) < 1e-9, 'schematic layer with TVD');
      S.resetWellPerf(A);
    },
  },
  {
    name: 'TH6 solver in the enthalpy mode: R.heat, traverse tRelax, THT = profile, hydrate verdict, PROVISIONAL_TEMP, evaluation budget, warm = cold; gas lift and no-geotherm fall back',
    wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, SY = G.WTS_wp_system;
      ['oilWell', 'gasWell'].forEach((k) => {
        const Mr = S.FIX[k]; Mr.well.heat.mode = 'relax';
        const Rr = SY.solve(Mr), R = SY.solve(enth(S.FIX[k])), h = R.heat;
        assert.ok(R.ok && h.mode === 'enthalpy' && h.verified === false && /provisional/.test(h.provisional), k + ' enthalpy solve');
        ['thtRelax', 'dT', 'passCheck', 'A', 'U', 'tProd_d'].forEach((f) => assert.ok(Number.isFinite(h[f]), k + ' R.heat.' + f));
        assert.ok(h.budget && Number.isFinite(h.budget.jt) && h.eta && Number.isFinite(h.eta.top) && h.intervals.length > 5, k + ' budget, η, intervals');
        near(assert, h.budget.tIn + h.budget.loss + h.budget.jt + h.budget.grav + h.budget.kin, h.budget.tOut, 1e-9, k + ' budget closes');
        near(assert, R.surface.tht, h.tht, 1e-12, k + ' THT = the profile');
        assert.strictEqual(R.surface.thtVerdict, 'enthalpy', k + ' hydrate verdict');
        near(assert, R.surface.thtHyd, R.surface.tht, 1e-12, k + ' the hydrate check takes the enthalpy THT as it is');
        assert.ok(R.traverse.profile.filter((r) => !r.restr).every((r) => Number.isFinite(r.tRelax) && Number.isFinite(r.te)), k + ' traverse rows tRelax / te');
        assert.ok(R.flags.some((f) => f.code === 'PROVISIONAL_TEMP' && /enthalpy balance/.test(f.msg)), k + ' flag');
        assert.ok(R.counts.pred > 0 && !('pred' in Rr.counts), k + ' predictor count (enthalpy only)');
        assert.ok(R.evals <= Rr.evals + 0.25 * R.counts.pred + 2 && R.evals <= 1.5 * Rr.evals, k + ' budget: ' + R.evals + ' E vs relaxation ' + Rr.evals + ' E (' + R.counts.pred + ' predictors)');
        const Rw = SY.solve(enth(S.FIX[k]), { warm: R.grid });
        assert.strictEqual(Rw.op.q, R.op.q, k + ' warm = cold');
        assert.ok(R.grid.pred, k + ' predictor grid in R.grid');
      });
      // the hydrate THT of the gas well: the relaxation mode subtracts μ_JT·Δp from its THT; the enthalpy mode has it in the profile
      const Rg = SY.solve(enth(S.FIX.gasWell));
      assert.ok(Rg.heat.budget.jt < -3, 'J-T cooling in the tubing ' + Rg.heat.budget.jt);
      // gas lift: relaxation with ENTH_FALLBACK; no geotherm: linear with the fallback flag
      const Mg = enth(S.FIX.oilWell); Mg.lift = { type: 'gaslift', gl: { qinj_Mscfd: 400, pinj_psig: 1200, sginj: 0.65, dpValve: 100, packerMd: 7500 } };
      const Rl = SY.solve(Mg);
      assert.ok(Rl.ok && Rl.heat.mode === 'relax' && plain(Rl.warnings).some((w) => w.code === 'ENTH_FALLBACK'), 'gas lift → relaxation');
      const Mn = enth(S.FIX.oilWell); Mn.well.geo = { surfT_F: null, points: [] };
      const Rn = SY.solve(Mn);
      assert.ok(Rn.ok && Rn.heat.mode !== 'enthalpy' && Rn.heat.fallback && Rn.heat.enthFallback, 'no geotherm → linear');
    },
  },
  {
    name: 'TH7 p_out(q) smooth on the frozen grids in the enthalpy mode (second differences < 0.01 psi); pass check < 0.5 °F on both fixtures',
    wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const SY = app(ctx).win.WTS_wp_system;
      [['gasWell', 7000, 20], ['oilWell', 900, 5]].forEach(([k, q0, dq]) => {
        const M = enth(S.FIX[k]); if (k === 'oilWell') M.system.corr.well = 'nsl';
        M.surface.choke.present = false; M.surface.flowline = []; M.system.thp_psig = 400;
        const g = SY.evalAt(M, q0).grid, p = [];
        assert.ok(g.pred, k + ' predictor grid frozen');
        for (let i = 0; i < 10; i++) p.push(SY.evalAt(M, q0 + i * dq, { grid: g }).pOut);
        let m = 0; for (let i = 1; i < p.length - 1; i++) m = Math.max(m, Math.abs(p[i + 1] - 2 * p[i] + p[i - 1]));
        assert.ok(m < 0.01, k + ': max |Δ²p_out| = ' + m.toExponential(2));
        const R = SY.solve(enth(S.FIX[k]));
        assert.ok(R.heat.passCheck < 0.5, k + ' pass check ' + R.heat.passCheck);
      });
    },
  },
  {
    name: 'TH8 U fit in the enthalpy mode holds the J-T source (fitU {rows}; thtFit row.model enthalpy) and reproduces the target',
    wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, N = G.WTS_wp_well, M = enth(S.FIX.gasWell), { F, W } = build(G, M), q = 7400;
      const I = G.WTS_wp_ipr.curve(M.res, F), rx = N.relax(W, F, q);
      const rows = G.WTS_wp_vlp.traverse(F, W, q, { from: 'bottom', p0: I.pwfAt(q), stepFt: 400, refine: false, tProfile: rx.tAt }).profile;
      const T0 = N.enthalpy(W, F, q, { rows, heat: { U_to: 3.5 } }).tht, fu = N.fitU(W, F, q, T0, { rows });
      assert.ok(fu.ok && fu.model === 'enthalpy' && Math.abs(fu.U / 3.5 - 1) < 1e-3, 'U 3.5 recovered with the source (η on the relaxation temperatures, one fixed-point pass): ' + fu.U);
      const fr = N.fitU(W, F, q, T0);
      assert.ok(fr.ok && fr.model === 'relax' && fr.U > 3.5 * 1.5, 'without the J-T and gravity cooling the relaxation fit needs a much higher U for the same (cooler) THT: ' + fr.U);
      const Mt = enth(S.FIX.oilWell); Mt.tests = [S.FIX.test1];
      const tf = G.WTS_wp_match.thtFit(Mt, Mt.tests);
      assert.ok(tf.ok && tf.rows[0].model === 'enthalpy', 'thtFit uses the enthalpy source: ' + JSON.stringify(plain(tf.rows[0])));
    },
  },
  {
    name: 'TH9 gate (§15.1, D17): BENCH temp enthalpy pending (no verifiable published example, Q9); the model default stays linear',
    wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, VAL = require('../wellperf-validate.js');
      const b = VAL.BENCH.find((x) => x.kind === 'temp' && x.key === 'enthalpy');
      assert.ok(b && b.status === 'pending' && /Alves/.test(b.source), 'BENCH entry pending: ' + JSON.stringify(b));
      assert.strictEqual(G.WTS_wp_model.DEFAULTS.well.heat.mode, 'linear', 'never the default');
      assert.strictEqual(G.WTS_wp_well.ENTH.label, 'provisional — not verified against a published example');
    },
  },
  {
    name: 'TH10 page: option, enthalpy box + budget waterfall, traverse comparison + rails, KPI, schematic J-T colouring and layer sleeves, layers table with TVD, report text in #wp_res, no NaN, phone width',
    wp: WP,
    run(_a, assert, ctx) {
      const A = page(ctx);
      const opt = Array.prototype.map.call(A.el('wp_heat').options || [], (o) => o.value);
      assert.ok(opt.indexOf('enthalpy') !== -1, 'option offered: ' + opt.join(','));
      A.change('wp_heat', 'enthalpy'); A.flush(1200);
      const st = A.win.WTS_state.wellperf;
      assert.ok(st.ok, 'solved');
      assert.ok(!/wp-off/.test(A.el('wp_Uto').closest('.fg-item').className), 'U input shown in the enthalpy mode');
      const hb = txt(A.el('wp_heatbox'));
      ['Enthalpy balance at the operating point', 'Against the relaxation', 'J-T coefficient, perforations', 'Energy budget', 'Relaxation at the operating point', 'THT without J-T'].forEach((k) => assert.ok(hb.indexOf(k) !== -1, 'heat box: ' + k));
      assert.ok(/class="wp-bud"/.test(A.el('wp_heatbox').innerHTML) && /Joule-Thomson/.test(A.el('wp_heatbox').innerHTML), 'budget waterfall');
      const kp = A.findAll('#wp_kpis .kpi').find((k) => txt(k.querySelector('.kpi-l')) === 'THT');
      assert.match(txt(kp), /enthalpy · J-T etc\. −/);
      const tr = A.el('wp_cv_tr')._wp.spec, keys = tr.series.map((s) => s.key);
      ['t', 'trx', 'te'].forEach((k) => assert.ok(keys.indexOf(k) !== -1, 'traverse series ' + k + ' in ' + keys.join(',')));
      assert.deepStrictEqual(plain(tr.handles.map((h) => h.key)), ['hU', 'hT'], 'U and TIME rails');
      assert.match(txt(A.el('wp_trleg')), /Enthalpy balance: THT .* against the relaxation \(J-T −/);
      const tht0 = A.win.WTS_state.wellperf.surface.tht;
      P(A).handle('hU', Math.log10(8), 'end'); A.flush(1200);
      assert.ok(A.win.WTS_state.wellperf.surface.tht < tht0 - 1, 'U rail re-solves the enthalpy profile');
      // layers table (TVD columns) → schematic sleeve; click it → step ③ row
      assert.ok(A.el('wp_tbl_layers'), 'layers table');
      A.win.WTS_wp_model.write({ geo: { points: plain(A.win.WTS_wp_model.read().well.geo.points), layers: [[500, 3500, 0.3, null]] } }); A.flush(1200);
      P(A).recalc && P(A).recalc(); A.flush(1200);
      const lt = txt(A.el('wp_tbl_layers'));
      assert.ok(/Top TVD/.test(lt), 'TVD columns in the layers table');
      const li = A.el('wp_tbl_layers').querySelectorAll('input');
      assert.ok(li.length >= 4 && li[0].value === '500' && li[1].value === '3500' && li[2].value === '0.3', 'the written layer shows in the table');
      assert.ok(A.win.WTS_state.wellperf.ok, 'solved with a layer');
      const sch = A.el('wp_sch').innerHTML;
      assert.ok(/data-comp="layer:0"/.test(sch) && /U 0\.3/.test(sch), 'layer sleeve on the schematic');
      A.click(A.find('#wp_sch [data-comp="layer:0"]')); A.flush(10);
      A.change('wpv_prop', 'jt'); A.flush(10);
      assert.match(A.el('wp_sch').innerHTML, /Enthalpy − relaxation/);
      // report text inside #wp_res
      assert.match(txt(A.el('wp_verd')), /enthalpy balance \(Joule-Thomson, gravity and kinetic terms\).*provisional/);
      assert.match(txt(A.el('wp_case')), /Temperature ?enthalpy balance/);
      assert.match(txt(A.el('wp_notesbox')), /steady enthalpy balance per rate/);
      ['wp_res', 'wp_step_3'].forEach((id) => assert.ok(!BAD.test(txt(A.el(id))), id + ' clean: ' + (txt(A.el(id)).match(BAD) || [''])[0]));
      assert.strictEqual(A.consoleErrors().length, 0, 'no console errors');
      // Metric display: the J-T coefficient in °C/bar, temperatures in °C, the same canonical answer
      const qI = A.win.WTS_state.wellperf.op.q;
      A.win.WTS_units.setSystem('metric');
      try {
        A.flush(60);
        const hm = txt(A.el('wp_heatbox'));
        assert.ok(/°C\/bar/.test(hm) && /°C/.test(hm) && !/°F\/psi/.test(hm) && !BAD.test(hm), 'heat box in SI: ' + hm.slice(0, 160));
        assert.ok(Math.abs(A.win.WTS_state.wellperf.op.q / qI - 1) < 1e-9, 'canonical engines');
      } finally { A.win.WTS_units.setSystem('imperial'); A.flush(60); }
      A.resize(390, 844); A.change('wp_Uto', '3'); A.flush(1200);
      assert.deepStrictEqual(plain(A.el('wp_cv_tr')._wp.spec.handles.map((h) => h.key + ':' + h.rail.join('-'))), ['hU:0-1'], 'one full-width rail at 390 px');
      assert.ok(!BAD.test(txt(A.el('wp_heatbox'))), 'heat box clean at 390 px');
      A.resize(1280, 800);
      A.win.WTS_wp_model.write({ geo: { points: plain(A.win.WTS_wp_model.read().well.geo.points), layers: [] } });
      A.change('wp_heat', 'linear'); A.flush(1200);
    },
  },
];
