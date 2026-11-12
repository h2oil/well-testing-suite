// Well Performance WP14 — flowing-temperature relaxation, A2 (docs/WELL-PERFORMANCE-PLAN.md §4.6, §5.2, §5.4 QC_THT, §15.1, §17.2:
// wellperf-temp2).
//
// TT1 reference profile: WTS_wellbore.flowingTemp equals the closed form T_f = T_ei + (T_bh − T_ebh)e^(−z/A) + g_G A sinθ (1 − e^(−z/A))
//     on a vertical and an inclined straight hole, and an independent RK4 integration of w c_p dT/dz = −(2π r U k/(k + rUf))(T − T_ei)
//     on the deviated FIX.gasWell path (geotherm on TVD, relaxation along MD)
// TT2 f(t_D) both branches (t_D ≤ 1.5 and above) and the long-time line-source limit; A by hand
// TT3 production: THT above the surface geotherm and below the BHT for any U, rate and time; monotone in U and in rate
// TT4 large-z limit: T_f − T_ei → g_G A sinθ (vertical sinθ = 1, a 60° hole sinθ = 0.5)
// TT5 radius basis: a U on the inside radius is converted U_to = U_ti r_ti / r_to (same profile); the page / model Ubasis 'ti'
// TT6 inject direction: closed form T = T_ei + (T_in − T_es)e^(−z/A) − g_G A sinθ (1 − e^(−z/A)); the DFIT pin (Q16): with U → ∞ it is the
//     DFIT-PLAN Ramey form T = g z + T_s − g A + (T_inj − T_s + g A) e^(−z/A), A = w c_p f / (2π k_e); `_ramey` stays undefined
// TT7 U fit: WTS_wellbore.flowingTempFitU reproduces the target, OUT_OF_RANGE with the reachable range; WTS_wp_well.fitU and
//     WTS_wp_match.thtFit on FIX.oilWell; QC_THT against the relaxation estimate with the matched U range (±20 °F)
// TT8 the solver in the relaxation mode: one profile per rate (tProfile), the THT at the rate, R.heat, traverse te, the provisional
//     label (§15.1 gate: Hasan & Kabir example not verifiable — Q9), the linear mode untouched
// TT9 the page: relaxation inputs, the summary box, KPI, traverse (earth, linear, test THT, U / TIME rails that re-solve), schematic
//     earth halo and the fluid − earth colouring, checks / case / Notes captured, U fit + adopt, no NaN
'use strict';

const S = require('./_wellperf-shapes');

const WP = 'WP14';
const BAD = /NaN|undefined|Infinity|\[object Object\]/;
const txt = (e) => String(e && e.textContent || '').replace(/\s+/g, ' ').trim();
const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const app = (ctx) => S.sharedApp(ctx);
const near = (assert, a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, what + ': ' + a + ' vs ' + b + ' (tol ' + tol + ')');
const P = (A) => A.win.WTS_wellperf_page;

// a straight hole at a constant inclination (from vertical) below a short vertical section
const straight = (WB, incDeg, td) => WB.column({ datumTvd: td * Math.cos(incDeg * Math.PI / 180) + (incDeg ? 0 : 0), survey: incDeg ? [[0, incDeg, 0], [td, incDeg, 0]] : [[0, 0], [td, td]],
  strings: [{ id: 2.441, od: 2.875, topMd: 0, botMd: td }, { id: 6.276, od: 7, topMd: 0, botMd: td }] });
const BASE = { w: 12000, cp: 0.55, U_to: 2, r_to: 2.875 / 24, ke: 1.4, alpha: 0.04, rwb: 8.5 / 24, t_hr: 720, geo: { surfF: 60, gradFper100: 1.6 } };

function page(ctx) {
  const A = app(ctx);
  if (A.win.__WP_MOCK) throw new Error('the test double must not be installed in this app');
  S.resetWellPerf(A); P(A).resetJobs(); P(A).budget(1e6);
  A.hook.nav('wellperf'); A.flush(30);
  A.click(A.find('[data-act="example"][data-ex="oil"]')); A.flush(30);
  return A;
}

module.exports = [
  {
    name: 'TT1 flowingTemp reference profile: the closed form on vertical and inclined straight holes; an independent RK4 integration on the deviated FIX.gasWell path (geotherm on TVD, relaxation along MD)',
    wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, WB = G.WTS_wellbore;
      [[0, 9000], [60, 12000]].forEach(([inc, td]) => {
        const c = straight(WB, inc, td), r = WB.flowingTemp(c, Object.assign({}, BASE, { Tin: 215 }));
        assert.ok(r.ok, 'ok ' + inc);
        const sinT = Math.cos(inc * Math.PI / 180), g = 0.016, tebh = 60 + g * td * sinT, A = r.A;
        [0, 0.1, 0.37, 0.8, 1].forEach((f) => {
          const z = f * td, md = td - z, tei = tebh - g * z * sinT;
          const cf = tei + (215 - tebh) * Math.exp(-z / A) + g * A * sinT * (1 - Math.exp(-z / A));
          near(assert, r.tAt(md), cf, 1e-9, 'closed form at z = ' + z + ' (inc ' + inc + '°)');
          near(assert, r.teAt(md), tei, 1e-9, 'earth temperature on TVD');
        });
        near(assert, r.tOut, r.tAt(0), 1e-12, 'tOut = the wellhead value');
        near(assert, r.tAt(td + 500), 215, 1e-12, 'below the inlet: the inlet temperature');
      });
      // deviated S-shaped well (minimum curvature) with a two-segment geotherm: RK4 on dT/dz = (T_ei(z) − T)/A along MD
      const M = S.FIX.gasWell, W = G.WTS_wp_well.build(M.well, { res: M.res }), mid = W.nodes.midPerfMd;
      const geo = { points: [[0, 70], [4000, 120], [9300, 230]] };
      const col = { tvdAt: W.tvdAt, mdAt: W.mdAt, datumMd: mid, survey: W.stations.map((s) => [s.md, s.tvd]), segments: [{ od: 7 }] };
      const r = WB.flowingTemp(col, Object.assign({}, BASE, { geo, Tin: 240 }));
      assert.ok(r.ok && r.pieces > 150, 'pieces at survey stations, the geotherm break and every 50 ft: ' + r.pieces);
      const geoF = (tvd) => (tvd <= 4000 ? 70 + 50 * tvd / 4000 : 120 + 110 * (tvd - 4000) / 5300);
      const f = (md, T) => (geoF(W.tvdAt(md)) - T) / r.A;          // dT/dz with z = mid − md
      let T = 240, md = mid, h = 2, worst = 0;
      while (md > 1e-9) {
        const hh = Math.min(h, md), k1 = f(md, T), k2 = f(md - hh / 2, T + hh * k1 / 2), k3 = f(md - hh / 2, T + hh * k2 / 2), k4 = f(md - hh, T + hh * k3);
        T += hh * (k1 + 2 * k2 + 2 * k3 + k4) / 6; md -= hh;
        if (Math.abs(md - Math.round(md / 500) * 500) < 1e-6) worst = Math.max(worst, Math.abs(r.tAt(md) - T));
      }
      worst = Math.max(worst, Math.abs(r.tOut - T));
      assert.ok(worst < 0.02, 'piecewise-exact march vs RK4 on the deviated path: ' + worst + ' °F');
      assert.ok(Math.abs(W.tvdAt(5000) - 5000) > 100, 'the path is deviated (TVD ≠ MD)');
    },
  },
  {
    name: 'TT2 f(t_D): 1.1281√t_D(1 − 0.3√t_D) for t_D ≤ 1.5, (0.4063 + 0.5 ln t_D)(1 + 0.6/t_D) above; long-time line-source limit; A by hand',
    wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const WB = app(ctx).win.WTS_wellbore, F = WB.flowingTempF;
      [0.01, 0.5, 1, 1.5].forEach((t) => near(assert, F(t), 1.1281 * Math.sqrt(t) * (1 - 0.3 * Math.sqrt(t)), 1e-15, 'short branch ' + t));
      [1.5000001, 3, 100, 1e5].forEach((t) => near(assert, F(t), (0.4063 + 0.5 * Math.log(t)) * (1 + 0.6 / t), 1e-15, 'long branch ' + t));
      assert.ok(Math.abs(F(1.5) - F(1.5000001)) / F(1.5) < 0.03, 'the two branches meet within 3 % at t_D = 1.5');
      // Ramey's line source −ln(r / 2√(αt)) − 0.290 = 0.5 ln t_D + ln 2 − 0.290 at long times
      near(assert, F(1e4), 0.5 * Math.log(1e4) + Math.log(2) - 0.29, 0.01, 'line-source limit');
      assert.ok(Number.isNaN(F(0)) && Number.isNaN(F(-1)), 'undefined for t_D ≤ 0');
      const c = straight(WB, 0, 8000), r = WB.flowingTemp(c, BASE);
      const tD = 0.04 * 720 / Math.pow(8.5 / 24, 2), f = F(tD), rto = 2.875 / 24;
      near(assert, r.tD, tD, 1e-9, 't_D = α t / r_wb²');
      near(assert, r.A, (12000 * 0.55 / (2 * Math.PI)) * (1.4 + rto * 2 * f) / (rto * 2 * 1.4), 1e-9, 'A = (w c_p/2π)(k_e + r_to U f)/(r_to U k_e)');
      const big = WB.flowingTemp(c, Object.assign({}, BASE, { U_to: 1e9 }));
      near(assert, big.A, 12000 * 0.55 * f / (2 * Math.PI * 1.4), 1e-3, 'U → ∞: A = w c_p f / (2π k_e)');
      assert.strictEqual(WB.flowingTemp(c, Object.assign({}, BASE, { w: 0 })).code, 'NO_RATE');
      assert.strictEqual(WB.flowingTemp(c, Object.assign({}, BASE, { U_to: -1 })).code, 'NO_U');
      assert.strictEqual(WB.flowingTemp(null, BASE).code, 'NO_COLUMN');
    },
  },
  {
    name: 'TT3 production: the THT lies above the surface geotherm and below the BHT for every U, rate and producing time; it falls with U and rises with the rate',
    wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const WB = app(ctx).win.WTS_wellbore, c = straight(WB, 0, 9000), Ts = 60, Tbh = 60 + 0.016 * 9000;
      let prevU = Infinity;
      [0.2, 1, 2, 5, 20, 100].forEach((U) => {
        const t = WB.flowingTemp(c, Object.assign({}, BASE, { U_to: U })).tOut;
        assert.ok(t > Ts + 1e-6 && t < Tbh, 'U ' + U + ': ' + t);
        assert.ok(t < prevU, 'falls with U'); prevU = t;
      });
      let prevW = -Infinity;
      [500, 2000, 8000, 30000, 120000].forEach((w) => {
        const t = WB.flowingTemp(c, Object.assign({}, BASE, { w })).tOut;
        assert.ok(t > Ts && t < Tbh && t > prevW, 'w ' + w + ': ' + t); prevW = t;
      });
      [1, 24, 720, 24 * 3650].forEach((h) => { const t = WB.flowingTemp(c, Object.assign({}, BASE, { t_hr: h })).tOut; assert.ok(t > Ts && t < Tbh, 't ' + h + ' h: ' + t); });
      // a longer producing time warms the earth around the well (f grows → A grows → hotter THT)
      assert.ok(WB.flowingTemp(c, Object.assign({}, BASE, { t_hr: 8760 })).tOut > WB.flowingTemp(c, Object.assign({}, BASE, { t_hr: 24 })).tOut, 'hotter with time');
    },
  },
  {
    name: 'TT4 large-z limit: T_f − T_ei → g_G A sinθ far from the inlet (vertical sinθ = 1; a 60° hole sinθ = 0.5)',
    wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const WB = app(ctx).win.WTS_wellbore;
      [[0, 1], [60, 0.5]].forEach(([inc, sinT]) => {
        const td = 20000, c = straight(WB, inc, td), r = WB.flowingTemp(c, Object.assign({}, BASE, { w: 1500, U_to: 20 }));
        assert.ok(td / r.A > 25, 'z ≫ A (' + (td / r.A).toFixed(1) + ' A)');
        near(assert, r.tOut - r.teOut, 0.016 * r.A * sinT, 1e-6, 'offset at ' + inc + '°');
        near(assert, r.offsetOut, 0.016 * r.A * sinT, 1e-9, 'offsetOut = −s A');
      });
    },
  },
  {
    name: 'TT5 radius basis: U on the inside radius is converted U_to = U_ti·r_ti / r_to (identical profile); Ubasis \'ti\' in the model and WTS_wp_well.relax',
    wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, WB = G.WTS_wellbore, c = straight(WB, 0, 8000), rti = 2.441 / 24, rto = 2.875 / 24;
      const a = WB.flowingTemp(c, Object.assign({}, BASE, { U_to: undefined, U_ti: 3, r_ti: rti }));
      const b = WB.flowingTemp(c, Object.assign({}, BASE, { U_to: 3 * rti / rto }));
      assert.strictEqual(a.Ubasis, 'ti');
      near(assert, a.U_to, 3 * rti / rto, 1e-12, 'U_to'); near(assert, a.tOut, b.tOut, 1e-12, 'same THT'); near(assert, a.A, b.A, 1e-9, 'same A');
      assert.strictEqual(WB.flowingTemp(c, Object.assign({}, BASE, { U_to: undefined, U_ti: 3 })).code, 'NO_RADIUS', 'r_ti needed');
      // the module: Ubasis 'ti' converts with the tubing ID / OD of the well
      const M = S.FIX.oilWell, F = G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F });
      M.well.heat.mode = 'relax'; M.well.heat.U_to = 3; M.well.heat.Ubasis = 'ti';
      const W = G.WTS_wp_well.build(M.well, { res: M.res }), r = G.WTS_wp_well.relax(W, F, 900);
      assert.ok(r.ok && r.Ubasis === 'ti');
      near(assert, r.r_ti, 2.441 / 24, 1e-12, 'r_ti from the tubing ID');
      assert.ok(r.r_to > 2.875 / 24 && r.r_to < 7 / 24, 'r_to: the length-weighted OD of the flow conduit (tubing, then casing below the shoe)');
      near(assert, r.U_to, 3 * r.r_ti / r.r_to, 1e-12, 'converted with the well\'s radii');
      const Mm = G.WTS_wp_model;
      assert.ok(Mm.SCALARS.wp_Ubasis && Mm.SCALARS.wp_Ubasis.path === 'well.heat.Ubasis' && Mm.SCALARS.wp_dwb.path === 'well.heat.dwb_in', 'page controls in the model contract');
      assert.strictEqual(Mm.DEFAULTS.well.heat.Ubasis, 'to');
    },
  },
  {
    name: 'TT6 inject direction: closed form with the fluid cooler than the earth by g_G A sinθ at depth; DFIT pin (Q16): U → ∞ reproduces the DFIT-PLAN Ramey form; `_ramey` stays undefined (DFIT 3.4b)',
    wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const WB = app(ctx).win.WTS_wellbore, td = 9000, c = straight(WB, 0, td), g = 0.016;
      const r = WB.flowingTemp(c, Object.assign({}, BASE, { direction: 'inject', Tin: 80 }));
      assert.ok(r.ok && r.direction === 'inject' && r.fromMd === 0 && r.toMd === td);
      [0, 1000, 4500, 9000].forEach((z) => {
        const tei = 60 + g * z, cf = tei + (80 - 60) * Math.exp(-z / r.A) - g * r.A * (1 - Math.exp(-z / r.A));
        near(assert, r.tAt(z), cf, 1e-9, 'inject closed form at ' + z);
      });
      assert.ok(r.tOut < r.teOut, 'the injected fluid arrives cooler than the earth');
      // DFIT-PLAN §(temperature models) (c) Ramey: T = g z + T_s − g A + (T_inj − T_s + g A) e^(−z/A), A = w c_p f(t) / (2π k_e)
      const R = WB.flowingTemp(c, Object.assign({}, BASE, { direction: 'inject', Tin: 75, U_to: 1e12 }));
      const A = 12000 * 0.55 * WB.flowingTempF(R.tD) / (2 * Math.PI * 1.4);
      near(assert, R.A, A, 1e-6, 'earth-limited A');
      [500, 3000, 9000].forEach((z) => near(assert, R.tAt(z), g * z + 60 - g * A + (75 - 60 + g * A) * Math.exp(-z / A), 1e-6, 'DFIT Ramey form at ' + z));
      assert.strictEqual(typeof WB._ramey, 'undefined', '_ramey not defined by the production module');
      const tp = WB.tempProfile(c, { model: 'ramey' });
      assert.ok(tp.ok === false && tp.code === 'NOT_AVAILABLE', 'tempProfile ramey still NOT_AVAILABLE (dfit-wellbore)');
    },
  },
  {
    name: 'TT7 U fit: flowingTempFitU reproduces a target THT (Brent on ln U), OUT_OF_RANGE with the reachable range; WTS_wp_well.fitU and WTS_wp_match.thtFit; QC_THT against the relaxation estimate (±20 °F)',
    wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, WB = G.WTS_wellbore, c = straight(WB, 0, 9000);
      const o = Object.assign({}, BASE); delete o.U_to;
      [3, 0.7, 25].forEach((U) => {
        const T = WB.flowingTemp(c, Object.assign({}, o, { U_to: U })).tOut, f = WB.flowingTempFitU(c, o, { T });
        assert.ok(f.ok && f.evals < 60, 'fit ' + U + ' in ' + f.evals);
        near(assert, f.U_to, U, 1e-6 * U, 'U recovered'); near(assert, f.T, T, 1e-6, 'THT reproduced');
      });
      const hot = WB.flowingTempFitU(c, o, { T: 300 });
      assert.ok(hot.ok === false && hot.code === 'OUT_OF_RANGE' && hot.range.tAtUmin < 300 && hot.nearest === 0.01, 'above the adiabatic limit');
      const cold = WB.flowingTempFitU(c, o, { T: 61 });
      assert.ok(cold.ok === false && cold.code === 'OUT_OF_RANGE' && cold.range.tAtUmax > 61, 'below the earth-resistance limit');
      // the module: the model fluid and well at a rate
      const M = S.FIX.oilWell, F = G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F });
      M.well.heat.mode = 'relax';
      const W = G.WTS_wp_well.build(M.well, { res: M.res });
      const T0 = G.WTS_wp_well.relax(W, F, 900, { heat: { U_to: 4 } }).tht, fu = G.WTS_wp_well.fitU(W, F, 900, T0);
      assert.ok(fu.ok && Math.abs(fu.U - 4) < 1e-5 && Math.abs(fu.tFit - T0) < 1e-6 && fu.provisional, 'fitU recovers U 4');
      const hf = G.WTS_wp_well.heatFlow(F, 900);
      // by hand: oil 630 STB/d (WC 30 %) at 35 °API, water 270 BWPD, gas 315 Mscf/d at sg (FIX)
      const go = 141.5 / (131.5 + M.fluid.api), wHand = (630 * 350.17 * go + 270 * 350.17 * F.sgw + 315e3 * 0.0764 * F.sgg) / 24;
      near(assert, hf.w, wHand, 1e-6 * wHand, 'mass rate');
      near(assert, hf.cpParts.oil, (0.388 + 0.00045 * hf.T) / Math.sqrt(go), 1e-12, 'Gambill oil c_p');
      assert.ok(hf.cp > 0.45 && hf.cp < 0.8 && hf.cpParts.gas > 0.45 && hf.cpParts.gas < 0.7, 'mixture c_p ' + hf.cp + ', gas ' + hf.cpParts.gas);
      // thtFit on the tests, and QC_THT
      const t1 = S.FIX.test1, Mt = S.FIX.oilWell; Mt.well.heat.mode = 'relax'; Mt.tests = [t1];
      const tf = G.WTS_wp_match.thtFit(Mt, Mt.tests);
      assert.ok(tf.ok && tf.n === 1 && tf.uRange[0] === tf.uRange[1] && tf.rows[0].ok, 'one test matched');
      const q1 = G.WTS_wp_qc(Mt, Mt.tests).rows[0].checks.find((x) => x.code === 'QC_THT');
      assert.strictEqual(q1.st, 'ok', 'the matched THT is within 20 °F: ' + q1.msg);
      // a second used test 45 °F hotter at the same rates: outside the band of the first test's U → warn
      const t2 = Object.assign({}, t1, { id: 'T2', tht_F: t1.tht_F + 45 });
      const q2 = G.WTS_wp_qc(Mt, [t1, t2], { uRange: tf.uRange }).rows[1].checks.find((x) => x.code === 'QC_THT');
      assert.strictEqual(q2.st, 'warn', q2.msg); assert.match(q2.msg, /more than 20 °F from the relaxation estimate/);
      // the linear mode keeps the A1 check
      Mt.well.heat.mode = 'linear';
      assert.match(G.WTS_wp_qc(Mt, [t2]).rows[0].checks.find((x) => x.code === 'QC_THT').msg, /below the bottom-hole temperature/);
    },
  },
  {
    name: 'TT8 solver in the relaxation mode: per-rate profile in the march, THT at the rate, R.heat, traverse te, provisional label (§15.1 gate); the linear mode is unchanged',
    wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, SY = G.WTS_wp_system;
      const M0 = S.FIX.oilWell, R0 = SY.solve(M0);
      const M = S.FIX.oilWell; M.well.heat.mode = 'relax';
      const R = SY.solve(M);
      assert.ok(R0.ok && R.ok, 'both solve');
      assert.strictEqual(R0.heat.mode, 'linear'); assert.strictEqual(R0.surface.tht, 120, 'linear: the entered THT');
      assert.ok(R0.traverse.profile.every((r) => typeof r.te === 'number'), 'te on every traverse row (linear too)');
      const h = R.heat;
      assert.ok(h.mode === 'relax' && h.verified === false && /provisional — not verified against a published example/.test(h.provisional), 'R.heat with the label');
      assert.ok(R.flags.some((f) => f.code === 'PROVISIONAL_TEMP' && f.sev === 'info'), 'provisional flag');
      // the march at the operating point runs on the relaxation profile of that rate
      const F = G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F, table: true }), W = G.WTS_wp_well.build(M.well, { res: M.res, fluidType: 'oil', tests: M.tests, surface: M.surface });
      const rx = G.WTS_wp_well.relax(W, F, R.op.q);
      near(assert, R.surface.tht, rx.tht, 1e-9, 'THT = the relaxation wellhead value at the operating rate');
      near(assert, h.tht, rx.tht, 1e-9, 'R.heat.tht');
      let worst = 0; R.traverse.profile.forEach((r) => { if (!r.restr) worst = Math.max(worst, Math.abs(r.t - rx.tAt(r.md))); });
      assert.ok(worst < 1e-9, 'traverse temperature = relaxation profile: ' + worst);
      assert.ok(R.surface.tht > 60 && R.surface.tht < M.res.T_F, 'between the surface geotherm and the BHT');
      assert.ok(Math.abs(R.op.q - R0.op.q) > 1, 'the hotter column changes the operating point');
      assert.ok(R.evals <= (R.roots.length > 1 ? 24 : 20) + 1e-9, 'evaluation budget (§16) unchanged: ' + R.evals + ' with ' + R.roots.length + ' roots');
      // the rate dependence: maxRate's THT is the relaxation THT at the maximum rate (hotter than at the choked rate)
      const mx = SY.maxRate(M);
      assert.ok(mx.ok && mx.tht > R.surface.tht, 'THT rises with the rate: ' + mx.tht + ' > ' + R.surface.tht);
      // no geotherm: the linear profile with a RELAX_FALLBACK warning
      const Mn = S.FIX.oilWell; Mn.well.heat.mode = 'relax'; Mn.well.geo = { surfT_F: null, points: [] };
      const Rn = SY.solve(Mn);
      assert.ok(Rn.ok && Rn.heat.mode !== 'relax' && Rn.heat.fallback && plain(Rn.warnings).some((w) => w.code === 'RELAX_FALLBACK'), 'fallback');
      // a test marched in the relaxation mode passes through its THT (U fitted per test)
      const Mt = S.FIX.oilWell; Mt.well.heat.mode = 'relax'; Mt.tests = [S.FIX.test1];
      const cmp = G.WTS_wp_match.compare(Mt, S.FIX.test1, ['bb']);
      assert.ok(cmp.ok && cmp.rows[0].profile.length, 'compare ok');
      // the gate (wellperf-validate BENCH): the relaxation model is pending (Hasan & Kabir example not verifiable, Q9)
      const VAL = require('../wellperf-validate.js');
      const b = VAL.BENCH.find((x) => x.kind === 'temp' && x.key === 'relax');
      assert.ok(b && b.status === 'pending', 'BENCH entry pending');
    },
  },
  {
    name: 'TT9 page: relaxation inputs and summary, KPI, traverse (earth, linear, test THT, U / TIME rails re-solve), schematic earth halo and fluid − earth colouring, report text, U fit + adopt, no NaN',
    wp: WP,
    run(_a, assert, ctx) {
      const A = page(ctx);
      assert.ok(/wp-off/.test(A.find('[data-heat="relax"]').className), 'relaxation inputs hidden in the linear mode');
      A.change('wp_heat', 'relax'); A.flush(30);
      assert.ok(!/wp-off/.test(A.el('wp_Uto').closest('.fg-item').className) && /wp-off/.test(A.el('wp_tht').closest('.fg-item').className), 'relaxation inputs shown, the THT input hidden');
      const st = A.win.WTS_state.wellperf;
      assert.ok(st.ok, 'solved');
      const hb = txt(A.el('wp_heatbox'));
      ['Relaxation distance A', 'f(t_D)', 'Mass rate w', 'Heat capacity c_p', 'THT at this rate', 'provisional'].forEach((k) => assert.ok(hb.indexOf(k) !== -1, 'heat box: ' + k));
      const kp = A.findAll('#wp_kpis .kpi').find((k) => txt(k.querySelector('.kpi-l')) === 'THT');
      assert.match(txt(kp), /relaxation · U 2/);
      const tr = A.el('wp_cv_tr')._wp.spec;
      const keys = tr.series.map((s) => s.key);
      ['p', 't', 'te', 'tl'].forEach((k) => assert.ok(keys.indexOf(k) !== -1, 'traverse series ' + k));
      assert.deepStrictEqual(plain(tr.handles.map((h) => h.key + ':' + h.kind)), ['hU:railX', 'hT:railX'], 'U and TIME rails');
      assert.match(txt(A.el('wp_trleg')), /Relaxation: A [\d,]+ ft along the hole/);
      // drag U (log scale): the THT falls and the field follows
      const tht0 = st.surface.tht;
      P(A).handle('hU', Math.log10(8), 'move');
      assert.strictEqual(A.el('wp_Uto').value, '8', 'U written while dragging');
      P(A).handle('hU', Math.log10(8), 'end'); A.flush(1200);
      assert.ok(A.win.WTS_state.wellperf.surface.tht < tht0 - 1, 'higher U → cooler THT');
      P(A).handle('hT', Math.log10(365), 'end'); A.flush(1200);
      assert.ok(Math.abs(+A.el('wp_tprod').value / 365 - 1) < 0.05, 'producing time from the log rail: ' + A.el('wp_tprod').value);
      // schematic: earth halo under the temperature colouring; fluid − earth property
      A.change('wpv_prop', 'temperature'); A.flush(10);
      assert.ok(/class="wp-earth"/.test(A.el('wp_sch').innerHTML) && /halo: earth/.test(A.el('wp_sch').innerHTML), 'earth halo + legend');
      A.change('wpv_prop', 'heatloss'); A.flush(10);
      assert.match(A.el('wp_sch').innerHTML, /Fluid − earth/);
      // report text: checks, case summary, Notes
      assert.match(txt(A.el('wp_verd')), /heat-transfer relaxation \(Ramey \/ Hasan-Kabir\).*provisional/);
      assert.match(txt(A.el('wp_case')), /Temperature ?relaxation \(Ramey \/ Hasan-Kabir\), U 8/);
      assert.match(txt(A.el('wp_notesbox')), /geotherm on TVD, relaxation along MD/);
      // U fit to a test THT and adopt
      A.change('wp_tprod', '30'); A.flush(1200);
      A.win.WTS_wp_model.write({ tests: [S.FIX.test1] }); A.flush(30);
      A.click(A.find('#wp_heatbox [data-act="fitU"]')); A.flush(10);
      assert.match(txt(A.el('wp_heatbox')), /reproduces the measured THT/);
      const ad = A.find('#wp_heatbox [data-act="adoptU"]'), uv = +ad.getAttribute('data-v');
      A.click(ad); A.flush(1200);
      assert.ok(Math.abs(+A.el('wp_Uto').value - uv) < 1e-9, 'U adopted');
      near(assert, A.win.WTS_state.wellperf.surface.tht, A.win.WTS_wp_well.relax(A.win.WTS_wp_well.build(A.win.WTS_wp_model.read().well, { res: A.win.WTS_wp_model.read().res }),
        A.win.WTS_wp_fluid.build(A.win.WTS_wp_model.read().fluid, { T_F: A.win.WTS_wp_model.read().res.T_F, table: true }), A.win.WTS_state.wellperf.op.q).tht, 1e-6, 'solved with the adopted U');
      ['wp_res', 'wp_step_3'].forEach((id) => assert.ok(!BAD.test(txt(A.el(id))), id + ' clean: ' + (txt(A.el(id)).match(BAD) || [''])[0]));
      assert.strictEqual(A.consoleErrors().length, 0, 'no console errors');
      // phone width: one rail (U across the chart), the producing time stays a step ③ input
      A.resize(390, 844); A.change('wp_Uto', '3'); A.flush(1200);
      assert.deepStrictEqual(plain(A.el('wp_cv_tr')._wp.spec.handles.map((h) => h.key + ':' + h.rail.join('-'))), ['hU:0-1'], 'one full-width rail at 390 px');
      A.resize(1280, 800); A.change('wp_heat', 'linear'); A.flush(1200);
    },
  },
];
