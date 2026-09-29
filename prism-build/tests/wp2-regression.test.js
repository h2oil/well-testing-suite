// WP2 — regression engine acceptance tests (05-regression.js).
//
// Unit tests (integration:false) switch OFF the core-layer contracts
// (PRiSM_getWell / getAnalysisData / physicalModel / setLastFit) so they
// exercise 05's own local fallbacks deterministically. Integration tests run
// the same fits through the core layer (WP1, 33-pta-core.js) and the model
// kernels (WP4a) once those have landed.
'use strict';

const SAMPLE_WELL = {
  q: 850, B: 1.25, mu: 1.1, h: 35, phi: 0.18, ct: 1.2e-5, rw: 0.354,
  pi: 4200, testType: 'drawdown', fluid: 'oil',
};
const A_TRUE = 141.2 * 850 * 1.25 * 1.1 / (45 * 35);                    // 104.78 psi
const B_TRUE = 0.0002637 * 45 / (0.18 * 1.1 * 1.2e-5 * 0.354 * 0.354);  // 39854 1/hr
const CD_PER_C = 0.8936 / (0.18 * 1.2e-5 * 35 * 0.354 * 0.354);         // Cd per bbl/psi

function useLocalFallbacks(app) {
  const w = app.win;
  ['PRiSM_getAnalysisData', 'PRiSM_physicalModel', 'PRiSM_getWell', 'PRiSM_setLastFit']
    .forEach((k) => { w[k] = undefined; });
}

// Put the sample well into the C1 store (PRiSM_setWell when present, else the
// PRiSM_pvt fields + provenance directly).
function setStoreWell(app, patch, source) {
  const w = app.win;
  const base = { fluidType: 'oil', q: 850, Bo: 1.25, mu_o: 1.1, ct: 1.2e-5, h: 35, phi: 0.18, rw: 0.354 };
  const all = Object.assign({}, base, patch || {});
  if (typeof w.PRiSM_setWell === 'function') { w.PRiSM_setWell(app.toWin(all), app.toWin({ source: source || 'user' })); return; }
  const pv = w.PRiSM_pvt = w.PRiSM_pvt || {};
  pv.provenance = pv.provenance || {};
  Object.keys(all).forEach((k) => { pv[k] = all[k]; pv.provenance[k] = source || 'user'; });
  if (typeof w.PRiSM_pvt_compute === 'function') { try { w.PRiSM_pvt_compute(); } catch (e) { /* ignore */ } }
}

function logspace(a, b, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(Math.pow(10, a + (b - a) * i / (n - 1)));
  return out;
}

function wellCopy(extra) { return Object.assign({}, SAMPLE_WELL, extra || {}); }

// Synthetic pressures from a registry model: p = pi − (A/q)·Σ Δq·pd(B·(t − ti)).
function synthPressure(app, modelKey, params, rateHistory, tAbs, pi) {
  const w = app.win;
  const pd = w.PRiSM_MODELS[modelKey].pd;
  const unit = A_TRUE / 850;
  const s = w.PRiSM_superposition(pd, app.toWin(rateHistory), app.toWin(tAbs), app.toWin(params),
    (dt) => B_TRUE * dt);
  return tAbs.map((_, i) => pi - unit * s[i]);
}

function buildupDataset(app) {
  const tDD = logspace(-2, Math.log10(24), 30);
  tDD[tDD.length - 1] = 24;
  const tBU = logspace(-3, Math.log10(72), 60).map((d) => 24 + d);
  const t = tDD.concat(tBU);
  const q = t.map((v) => (v <= 24 ? 850 : 0));
  const p = synthPressure(app, 'homogeneous', { Cd: 80, S: 2.5 },
    [{ t_start: 0, q: 850 }, { t_start: 24, q: 0 }], t, 4200);
  return { t, p, q };
}

module.exports = [
  // ---------------------------------------------------------------- 2.1 LM
  {
    name: 'LM: log keys, relative FD step for tiny parameters, Student-t CIs, corr, identifiability',
    wp: 'WP2',
    run(app, assert) {
      const w = app.win;
      // y = a·exp(−λ·x) with λ ~ 1e-6: the old max(|p|,1) step (1e-4) was 100× λ.
      const x = []; for (let i = 0; i <= 40; i++) x.push(i * 5e4);
      const truth = { a: 3, lam: 1.2e-6 };
      const y = x.map((v) => truth.a * Math.exp(-truth.lam * v));
      const f = (t, p) => t.map((v) => p.a * Math.exp(-p.lam * v));
      const r = w.PRiSM_lm(f, { t: x, p: y }, { a: 2, lam: 3e-6 }, { a: [0, 100], lam: [1e-9, 1e-2] }, null,
        { maxIter: 200, tolerance: 1e-10 });
      assert.ok(r.converged, 'converged (' + r.stopReason + ')');
      assert.rel(r.params.lam, truth.lam, 1e-6);
      assert.rel(r.params.a, truth.a, 1e-6);
      // Same problem with λ in log space.
      const r2 = w.PRiSM_lm(f, { t: x, p: y }, { a: 2, lam: 3e-6 }, { a: [0, 100], lam: [1e-9, 1e-2] }, null,
        { maxIter: 200, tolerance: 1e-10, logKeys: ['lam'] });
      assert.ok(r2.converged);
      assert.rel(r2.params.lam, truth.lam, 1e-6);
      assert.deepEqual(Array.from(r2.logKeys), ['lam']);
      // Noisy copy → CI uses the t quantile and covers the truth; corr matrix is symmetric with unit diagonal.
      let s = 7;
      const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
      const yn = y.map((v) => v * (1 + 0.01 * rnd()));
      const r3 = w.PRiSM_lm(f, { t: x, p: yn }, { a: 2, lam: 3e-6 }, { lam: [1e-9, 1e-2] }, null,
        { maxIter: 200, logKeys: ['lam'] });
      assert.near(r3.tQuantile, w.PRiSM_tQuantile975(r3.dof), 1e-12);
      assert.near(r3.tQuantile, 2.0227, 2e-3);          // ν = 39
      assert.ok(r3.ci95.lam[0] < truth.lam && r3.ci95.lam[1] > truth.lam, 'λ CI covers truth');
      assert.ok(r3.ci95.lam[0] > 0, 'log-space CI stays positive');
      assert.near(r3.corr[0][0], 1, 1e-12);
      assert.near(r3.corr[0][1], r3.corr[1][0], 1e-12);
      assert.ok(r3.identifiable.a && r3.identifiable.lam);
      // σ² is the weighted SSR over n − p.
      assert.rel(r3.sigma2, r3.ssr / (x.length - 2), 1e-12);
      // '__' keys are never fitted.
      const r4 = w.PRiSM_lm((t, p) => t.map((v) => p.a * v + p.__h), { t: [1, 2, 3], p: [2, 4, 6] }, { a: 1, __h: 0 });
      assert.deepEqual(Array.from(r4.freeKeys), ['a']);
    },
  },
  {
    name: 'LM: honest convergence — maxIter stop is not converged; bound-pinned key is flagged',
    wp: 'WP2',
    run(app, assert) {
      const w = app.win;
      const x = [1, 2, 3, 4, 5, 6];
      const y = x.map((v) => 2 * v + 1);
      const f = (t, p) => t.map((v) => p.m * v + p.b);
      const r = w.PRiSM_lm(f, { t: x, p: y }, { m: 50, b: -40 }, null, null, { maxIter: 1, lambda0: 1e3 });
      assert.equal(r.converged, false);
      assert.equal(r.stopReason, 'maxIter');
      // Truth m = 2 lies outside [3, 10] → m pinned at 3 → not identifiable.
      const r2 = w.PRiSM_lm(f, { t: x, p: y }, { m: 5, b: 0 }, { m: [3, 10] }, null, { maxIter: 100 });
      assert.near(r2.params.m, 3, 1e-12);
      assert.equal(r2.atBound.m, true);
      assert.equal(r2.identifiable.m, false);
      assert.ok(r2.converged, 'constrained minimum recognised (' + r2.stopReason + ')');
    },
  },
  {
    name: 'LM: a log-scale key stopping a hair inside its bound (xf = 1.00002 on a 1 ft floor) is flagged atBound',
    wp: 'WP2',
    run(app, assert) {
      // Browser ▶ Analyse runs the race under a wall-clock budget, so a fit
      // converging onto xf's lower bound can stop at 1.00002 ft instead of 1.
      // It must still count as at-bound, or a degenerate fracture fit is
      // committed for a homogeneous well.
      const w = app.win;
      const x = []; for (let i = 1; i <= 30; i++) x.push(i * 0.1);
      const y = x.map((v) => Math.exp(-v / 0.5));            // optimum xf = 0.5, below the floor
      const f = (t, p) => t.map((v) => Math.exp(-v / p.xf));
      const r = w.PRiSM_lm(f, { t: x, p: y }, { xf: 1.00002 }, { xf: [1, 1e4] }, null,
        { maxIter: 1, lambda0: 1e6, logKeys: ['xf'] });
      assert.ok(r.params.xf >= 1 && r.params.xf < 1.001, 'stayed at the floor (xf = ' + r.params.xf + ')');
      assert.equal(r.atBound.xf, true);
      // An interior optimum well away from the bound is not flagged.
      const y2 = x.map((v) => Math.exp(-v / 3));
      const r2 = w.PRiSM_lm(f, { t: x, p: y2 }, { xf: 2 }, { xf: [1, 1e4] }, null, { maxIter: 100, logKeys: ['xf'] });
      assert.rel(r2.params.xf, 3, 1e-6);
      assert.equal(r2.atBound.xf, false);
    },
  },
  // -------------------------------------------------------- 2.2 acceptance a
  {
    name: 'a. default sample, homogeneous, sample well → k 45.0, S 2.50, Cd 80; st.match untouched',
    wp: 'WP2',
    run(app, assert) {
      useLocalFallbacks(app);
      app.openPRiSM();
      const w = app.win;
      assert.equal(w.PRiSM_dataset.t.length, 55);
      w.PRiSM_state.model = 'homogeneous';
      const matchBefore = JSON.parse(JSON.stringify(w.PRiSM_state.match));
      const f = w.PRiSM_runRegression({ well: wellCopy() });
      assert.ok(f.ok, f.reason);
      assert.equal(f.kind, 'pressure');
      assert.equal(f.source, 'regression');
      assert.equal(f.pRefSource, 'pi');
      assert.near(f.phys.k, 45.0, 0.5);
      assert.near(f.phys.S, 2.50, 0.05);
      assert.near(f.phys.Cd, 80, 3);
      assert.rel(f.phys.C, 8.48e-4, 0.03);
      assert.near(f.phys.kh, 45 * 35, 20);
      assert.near(f.phys.rinv, 1548, 20);
      assert.equal(f.converged, true);
      assert.ok(f.r2 > 0.9999, 'R² ' + f.r2);
      assert.ok(f.rmse < 1, 'RMSE ' + f.rmse);
      assert.ok((f.ci95.S[1] - f.ci95.S[0]) / 2 < 0.05, 'S CI half-width ' + (f.ci95.S[1] - f.ci95.S[0]) / 2);
      assert.ok(f.ci95.k[0] < 45 && f.ci95.k[1] > 45);
      assert.ok(f.identifiable.k && f.identifiable.S && f.identifiable.C);
      // Dimensionless registry params + scales + adoption.
      assert.near(f.params.Cd, 80, 3);
      assert.near(f.params.S, 2.5, 0.05);
      assert.ok(!('__h_rw' in f.params), 'injected keys are not reported');
      assert.rel(f.scales.A, A_TRUE, 0.02);
      assert.rel(f.scales.B, B_TRUE, 0.02);
      assert.equal(f.adopted, true);
      const st = w.PRiSM_state;
      assert.deepEqual(JSON.parse(JSON.stringify(st.match)), matchBefore);
      assert.deepEqual(JSON.parse(JSON.stringify(st.match)), { timeShift: 0, pressShift: 0 });
      assert.near(st.params.S, 2.5, 0.05);
      assert.near(st.phys.k, 45, 0.5);
      assert.near(st.tcMatch.logPM, -2.020, 0.01);
      assert.near(st.tcMatch.logTM, 4.600, 0.02);
      assert.equal(st.lastFit.modelKey, 'homogeneous');     // fallback store (no setLastFit)
    },
  },
  {
    name: 'a2. derivative modes agree; Δp-only objective also recovers the truth',
    wp: 'WP2',
    run(app, assert) {
      useLocalFallbacks(app);
      app.seedSample();
      const w = app.win;
      const fa = w.PRiSM_fitPhysical('homogeneous', null, wellCopy(), { derivMode: 'analytic' });
      assert.ok(fa.ok && fa.converged);
      assert.near(fa.phys.k, 45, 0.5);
      assert.near(fa.phys.S, 2.5, 0.05);
      const fd = w.PRiSM_fitPhysical('homogeneous', null, wellCopy(), { objective: 'dp' });
      assert.ok(fd.ok && fd.converged);
      assert.equal(fd.objective, 'dp');
      assert.near(fd.phys.k, 45, 0.5);
      assert.near(fd.phys.S, 2.5, 0.05);
      assert.equal(fd.nPoints.deriv, 0);
      // Fit window restricts the points used.
      const fw = w.PRiSM_fitPhysical('homogeneous', null, wellCopy(), { window: { tmin: 0.05, tmax: 50 } });
      assert.ok(fw.ok);
      assert.ok(fw.nPoints.dp < 55);
      assert.ok(fw.window.tmin >= 0.05 && fw.window.tmax <= 50);
    },
  },
  // -------------------------------------------------------- acceptance b
  {
    name: 'b. pi floated from a 4100 start → pi 4200, k 45, S 2.5',
    wp: 'WP2',
    run(app, assert) {
      useLocalFallbacks(app);
      app.seedSample();
      const w = app.win;
      const f = w.PRiSM_fitPhysical('homogeneous', null, wellCopy({ pi: 4100 }), { floatPi: true });
      assert.ok(f.ok, f.reason);
      assert.equal(f.floatPi, true);
      assert.equal(f.pRefSource, 'fitted');
      assert.near(f.phys.pi, 4200, 2);
      assert.near(f.phys.k, 45, 0.5);
      assert.near(f.phys.S, 2.5, 0.1);
      assert.ok(f.converged);
      // Without pi, floatPi defaults on (pRef is extrapolated) and a skin-bias warning travels with the fit.
      const f2 = w.PRiSM_fitPhysical('homogeneous', null, wellCopy({ pi: null }));
      assert.ok(f2.ok, f2.reason);
      assert.equal(f2.floatPi, true);
      assert.near(f2.phys.pi, 4200, 2);
      assert.near(f2.phys.S, 2.5, 0.1);
      assert.ok(f2.warnings.some((s) => /skin/i.test(s)), 'skin-bias warning carried');
    },
  },
  // -------------------------------------------------------- acceptance c
  {
    name: 'c. synthetic buildup (tp 24 h) → k 45, S 2.50 via superposition; drawdown-only model is biased',
    wp: 'WP2',
    run(app, assert) {
      useLocalFallbacks(app);
      app.seedSample();
      const w = app.win;
      w.PRiSM_dataset = app.toWin(buildupDataset(app));
      const f = w.PRiSM_fitPhysical('homogeneous', null, wellCopy({ pi: null, testType: 'auto' }));
      assert.ok(f.ok, f.reason);
      assert.equal(f.testType, 'buildup');
      assert.equal(f.timeFn, 'superposition');
      assert.equal(f.pRefSource, 'pwf0');
      assert.equal(f.floatPi, false);
      assert.near(f.phys.k, 45, 0.5);
      assert.near(f.phys.S, 2.5, 0.05);
      assert.near(f.phys.Cd, 80, 3);
      assert.ok(f.converged);
      assert.ok(f.r2 > 0.9999);
      // Same buildup Δp treated as a single drawdown (no superposition) → biased k and S.
      const a = w.PRiSM_regressionInternals.analysisData(w.PRiSM_dataset, wellCopy({ pi: null, testType: 'auto' }), {});
      const dd = Object.assign({}, a, {
        rateHistory: [{ t: a.tStart, q: 850 }], timeFn: 'dt', x: a.t.slice(),
      });
      dd.deriv = w.PRiSM_regressionInternals.bourdet(dd.x, dd.dp, a.L);
      const g = w.PRiSM_fitPhysical('homogeneous', app.toWin(dd), wellCopy({ pi: null }), {});
      assert.ok(g.ok, g.reason);
      assert.ok(g.phys.k > 48 || Math.abs(g.phys.S - 2.5) > 0.5,
        'drawdown-only fit is biased (k ' + g.phys.k.toFixed(1) + ', S ' + g.phys.S.toFixed(2) + ')');
    },
  },
  // -------------------------------------------------------- acceptance e
  {
    name: 'e. doublePorosity (Cd 100, S 0, ω 0.1, λ 1e-6, all free) → ω, λ within 5%, stderr(λ) < λ',
    wp: 'WP2',
    timeoutMs: 60000,
    run(app, assert) {
      useLocalFallbacks(app);
      app.seedSample();
      const w = app.win;
      const truth = { Cd: 100, S: 0, omega: 0.1, lambda: 1e-6, interporosityMode: 'pss' };
      const t = logspace(-3, 3, 70);
      const p = synthPressure(app, 'doublePorosity', truth, [{ t_start: 0, q: 850 }], t, 4200);
      w.PRiSM_dataset = app.toWin({ t, p, q: t.map(() => 850) });
      const f = w.PRiSM_fitPhysical('doublePorosity', null, wellCopy(),
        { params0: { omega: 0.2, lambda: 1e-5, interporosityMode: 'pss' } });
      assert.ok(f.ok, f.reason);
      assert.ok(f.converged, 'converged (' + f.stopReason + ')');
      assert.rel(f.phys.omega, 0.1, 0.05);
      assert.rel(f.phys.lambda, 1e-6, 0.05);
      assert.ok(f.stderr.lambda < f.phys.lambda, 'stderr(λ) ' + f.stderr.lambda);
      assert.near(f.phys.k, 45, 0.5);
      assert.near(f.phys.S, 0, 0.05);
      assert.equal(f.params.interporosityMode, 'pss');
    },
  },
  // -------------------------------------------------------- acceptance f
  {
    name: 'f. Arps {t,q} dataset from t = 0 → qi, Di (1/d), b to 1e-4; no throw',
    wp: 'WP2',
    run(app, assert) {
      useLocalFallbacks(app);
      const w = app.win;
      const tDays = []; for (let d = 0; d <= 1500; d += 15) tDays.push(d);
      const q = tDays.map((d) => 1000 * Math.pow(1 + 0.5 * 0.01 * d, -1 / 0.5));
      const ds = app.toWin({ t: tDays.map((d) => d * 24), q });         // hours, no p column
      const f = w.PRiSM_fitRate('arps', ds);
      assert.ok(f.ok, f.reason);
      assert.equal(f.kind, 'rate');
      assert.equal(f.timeUnit, 'd');
      assert.rel(f.params.qi, 1000, 1e-4);
      assert.rel(f.params.Di, 0.01, 1e-4);
      assert.rel(f.params.b, 0.5, 1e-4);
      assert.ok(f.converged);
      assert.ok(f.r2 > 0.999999);
      assert.near(f.phys.Di_yr, 3.65, 1e-3);
      // Same data in days, via runRegression (dispatch on kind:'rate'), with a p-less dataset.
      w.PRiSM_dataset = app.toWin({ t: tDays, q, timeUnit: 'd' });
      w.PRiSM_state.model = 'arps';
      const matchBefore = JSON.stringify(w.PRiSM_state.match);
      const g = w.PRiSM_runRegression();
      assert.ok(g.ok, g.reason);
      assert.rel(g.params.Di, 0.01, 1e-4);
      assert.equal(g.adopted, true);
      assert.rel(w.PRiSM_state.params.b, 0.5, 1e-4);
      assert.equal(JSON.stringify(w.PRiSM_state.match), matchBefore);
      // Rate model refused by the pressure fitter, pressure model refused by the rate fitter.
      assert.equal(w.PRiSM_fitPhysical('arps', null, wellCopy()).ok, false);
      assert.equal(w.PRiSM_fitRate('homogeneous', ds).ok, false);
    },
  },
  {
    name: 'f2. Duong drops t = 0; SEPD fits in days',
    wp: 'WP2',
    run(app, assert) {
      useLocalFallbacks(app);
      const w = app.win;
      const tDays = []; for (let d = 0; d <= 1000; d += 10) tDays.push(d);
      const qS = tDays.map((d) => 800 * Math.exp(-Math.pow(d / 200, 0.4)));
      const fs = w.PRiSM_fitRate('sepd', app.toWin({ t: tDays, q: qS, timeUnit: 'd' }));
      assert.ok(fs.ok, fs.reason);
      assert.rel(fs.params.qi, 800, 1e-3);
      assert.rel(fs.params.tau, 200, 1e-3);
      assert.rel(fs.params.n, 0.4, 1e-3);
      const qD = tDays.map((d) => (d > 0 ? 500 * Math.pow(d, -1.1) * Math.exp(0.9 / (1 - 1.1) * (Math.pow(d, 1 - 1.1) - 1)) : 0));
      qD[0] = 700;                                   // a t = 0 row must be dropped, not thrown on
      const fdu = w.PRiSM_fitRate('duong', app.toWin({ t: tDays, q: qD, timeUnit: 'd' }));
      assert.ok(fdu.ok, fdu.reason);
      assert.equal(fdu.nPoints.q, tDays.length - 1);
      assert.rel(fdu.params.m, 1.1, 1e-3);
      assert.rel(fdu.params.a, 0.9, 1e-3);
    },
  },
  // -------------------------------------------------------- acceptance g
  {
    name: 'g. Agarwal equivalent time: single rate tp = 100 and multi-rate history',
    wp: 'WP2',
    run(app, assert) {
      const w = app.win;
      const rh = app.toWin([{ t: 0, q: 850 }, { t: 100, q: 0 }]);
      assert.near(w.PRiSM_agarwalTime(0.24, rh), 0.2394, 1e-4);
      assert.near(w.PRiSM_agarwalTime(100, rh), 50.0, 1e-9);
      // Sampled data: the rate on a row applies up to that row → the step is at t = 100.
      const t = [10, 50, 100, 100.24, 150, 200];
      const q = [850, 850, 850, 0, 0, 0];
      const p = [3900, 3850, 3800, 3900, 3990, 4000];
      const c = w.PRiSM_sandface_convolution(app.toWin({ t, p, q }));
      assert.equal(c.tShut, 100);
      assert.near(c.tp, 100, 1e-12);
      assert.near(c.teq[3], 0.2394, 1e-4);
      assert.near(c.teq[5], 50.0, 1e-9);
      assert.ok(Number.isNaN(c.teq[1]), 'no equivalent time before shut-in');
      assert.near(c.dp_eff[5], 200, 1e-9);           // |p − p(Δt=0)|
      // Two rates: ln Δte = Σ (Δq_i/q_{n−1}) ln[(ts_n − ts_i)Δt/(ts_n − ts_i + Δt)]
      const rh2 = app.toWin([{ t: 0, q: 500 }, { t: 50, q: 1000 }, { t: 80, q: 0 }]);
      const dt = 7;
      const expected = Math.exp(0.5 * Math.log(80 * dt / (80 + dt)) + 0.5 * Math.log(30 * dt / (30 + dt)));
      assert.rel(w.PRiSM_agarwalTime(dt, rh2), expected, 1e-12);
      // tp = Np / q_{n-1} = (500·50 + 1000·30) / 1000 = 55
      const c2 = w.PRiSM_sandface_convolution(app.toWin({ t: [10, 60, 80, 87], p: [1, 2, 3, 4], rateHistory: rh2 }));
      assert.near(c2.tp, 55, 1e-12);
      assert.rel(c2.teq[3], expected, 1e-12);
    },
  },
  // -------------------------------------------------------- acceptance h
  {
    name: 'h. uniform vs inverse_p weighting → S CIs within 10% (weighted σ²)',
    wp: 'WP2',
    run(app, assert) {
      const w = app.win;
      const pd = w.PRiSM_MODELS.homogeneous.pd;
      const td = logspace(3, 6, 40);
      const y = pd(app.toWin(td), app.toWin({ Cd: 100, S: 2 }));
      let s = 11;
      const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
      const yn = y.map((v) => v * (1 + 0.004 * rnd()));
      const run = (mode) => w.PRiSM_lm(pd, app.toWin({ t: td, p: yn }), app.toWin({ Cd: 100, S: 2 }),
        app.toWin({ Cd: [1, 1e6], S: [-7, 50] }), null, app.toWin({ weightingMode: mode, logKeys: ['Cd'], maxIter: 60 }));
      const u = run('uniform'), ip = run('inverse_p');
      const hu = (u.ci95.S[1] - u.ci95.S[0]) / 2, hi = (ip.ci95.S[1] - ip.ci95.S[0]) / 2;
      assert.ok(hu > 0 && hi > 0);
      assert.ok(Math.abs(hu - hi) / Math.max(hu, hi) < 0.10, 'S CI half-widths ' + hu + ' vs ' + hi);
    },
  },
  // -------------------------------------------------------- acceptance i
  {
    name: 'i. failed fit (garbage start, maxIter 3) leaves st.params unchanged, converged:false',
    wp: 'WP2',
    run(app, assert) {
      useLocalFallbacks(app);
      app.openPRiSM();
      const w = app.win;
      w.PRiSM_state.model = 'homogeneous';
      w.PRiSM_state.params = app.toWin({ Cd: 123, S: 4.5 });
      w.PRiSM_state.phys = app.toWin({ k: 7 });
      const before = JSON.stringify(w.PRiSM_state.params);
      const f = w.PRiSM_runRegression({ well: wellCopy(), start: { k: 5e4, C: 5, S: 45 }, maxIter: 3 });
      assert.equal(f.converged, false);
      assert.equal(f.adopted, false);
      assert.ok(f.warnings.some((m) => /not adopted/i.test(m)));
      assert.equal(JSON.stringify(w.PRiSM_state.params), before);
      assert.equal(w.PRiSM_state.phys.k, 7);
      assert.deepEqual(JSON.parse(JSON.stringify(w.PRiSM_state.match)), { timeShift: 0, pressShift: 0 });
      // Hard failures return a status object instead of throwing.
      const g = w.PRiSM_runRegression({ modelKey: 'no_such_model' });
      assert.equal(g.ok, false);
      assert.equal(g.converged, false);
    },
  },
  {
    name: 'incomplete well → scale mode with a warning; kh and C still reported when q, B, μ known',
    wp: 'WP2',
    run(app, assert) {
      useLocalFallbacks(app);
      app.seedSample();
      const w = app.win;
      const well = wellCopy({ phi: null, ct: null, rw: null });
      const f = w.PRiSM_runRegression({ well, modelKey: 'homogeneous' });
      assert.ok(f.ok, f.reason);
      assert.equal(f.mode, 'scale');
      assert.ok(f.warnings.some((m) => /scale mode/i.test(m)));
      assert.equal(f.identifiable.S, false);
      assert.rel(f.phys.kh, 45 * 35, 0.02);
      assert.rel(f.phys.C, 8.48e-4, 0.05);
      assert.ok(f.r2 > 0.999);
    },
  },
  {
    name: 'bootstrap attaches P10/P50/P90 per parameter',
    wp: 'WP2',
    timeoutMs: 60000,
    run(app, assert) {
      useLocalFallbacks(app);
      const w = app.win;
      const tDays = []; for (let d = 0; d <= 900; d += 30) tDays.push(d);
      let s = 3;
      const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
      const q = tDays.map((d) => 1000 * Math.pow(1 + 0.5 * 0.01 * d, -2) * (1 + 0.02 * rnd()));
      const f = w.PRiSM_fitRate('arps', app.toWin({ t: tDays, q, timeUnit: 'd' }), { bootstrap: 40, seed: 5 });
      assert.ok(f.ok && f.bootstrap);
      const pc = f.bootstrap.percentiles.qi;
      assert.ok(pc.p10 <= pc.p50 && pc.p50 <= pc.p90);
      assert.ok(pc.p10 < f.params.qi * 1.05 && pc.p90 > f.params.qi * 0.95);
      assert.ok(f.bootstrap.percentiles.Di && f.bootstrap.percentiles.b);
    },
  },
  // ------------------------------------------------------ integration tests
  {
    name: 'integration: default sample through the core layer (well store + analysis data + setLastFit)',
    wp: 'WP2',
    integration: true,
    run(app, assert) {
      const w = app.win;
      assert.fn(w.PRiSM_getAnalysisData, 'WP1 getAnalysisData');
      assert.fn(w.PRiSM_physicalModel, 'WP1 physicalModel');
      assert.fn(w.PRiSM_setLastFit, 'WP1 setLastFit');
      app.openPRiSM();
      app.seedSample();
      setStoreWell(app, { p_res: 4200, testType: 'drawdown' }, 'sample');
      w.PRiSM_state.model = 'homogeneous';
      let events = 0;
      w.addEventListener('prism:fit-updated', () => { events++; });
      const f = w.PRiSM_runRegression();
      assert.ok(f.ok, f.reason);
      assert.near(f.phys.k, 45, 0.5);
      assert.near(f.phys.S, 2.5, 0.05);
      assert.near(f.phys.Cd, 80, 3);
      assert.ok(f.converged && f.r2 > 0.9999 && f.rmse < 1);
      assert.ok(events >= 1, 'prism:fit-updated fired');
      const lf = w.PRiSM_getLastFit();
      assert.equal(lf.source, 'regression');
      assert.near(lf.phys.k, 45, 0.5);
      assert.deepEqual(JSON.parse(JSON.stringify(w.PRiSM_state.match)), { timeShift: 0, pressShift: 0 });
    },
  },
  {
    name: 'integration: pi floated through the core layer (no pi entered) → pi 4200, k 45, S 2.5',
    wp: 'WP2',
    integration: true,
    run(app, assert) {
      const w = app.win;
      assert.fn(w.PRiSM_physicalModel);
      app.seedSample();
      setStoreWell(app, { testType: 'drawdown' }, 'user');
      const f = w.PRiSM_fitPhysical('homogeneous', null, null, { floatPi: true });
      assert.ok(f.ok, f.reason);
      assert.equal(f.floatPi, true);
      assert.near(f.phys.pi, 4200, 2);
      assert.near(f.phys.k, 45, 0.5);
      assert.near(f.phys.S, 2.5, 0.1);
    },
  },
  {
    name: 'integration: d. synthetic S = −3, Cd = 80 drawdown → k 45, S −3.00 (negative-skin kernel)',
    wp: 'WP2',
    integration: true,
    run(app, assert) {
      const w = app.win;
      app.seedSample();
      const t = logspace(-2, Math.log10(120), 55);
      const p = synthPressure(app, 'homogeneous', { Cd: 80, S: -3 }, [{ t_start: 0, q: 850 }], t, 4200);
      assert.ok(p.every((v) => Number.isFinite(v)), 'kernel finite at S = −3');
      w.PRiSM_dataset = app.toWin({ t, p, q: t.map(() => 850) });
      setStoreWell(app, { p_res: 4200, testType: 'drawdown' }, 'user');
      const f = w.PRiSM_fitPhysical('homogeneous', null, null);
      assert.ok(f.ok, f.reason);
      assert.equal(f.pRefSource, 'pi');
      assert.near(f.phys.k, 45, 0.5);
      assert.near(f.phys.S, -3, 0.05);
    },
  },
  {
    name: 'integration: buildup through the core layer (superposition analysis data + physical model)',
    wp: 'WP2',
    integration: true,
    run(app, assert) {
      const w = app.win;
      assert.fn(w.PRiSM_getAnalysisData);
      assert.fn(w.PRiSM_physicalModel);
      app.seedSample();
      w.PRiSM_dataset = app.toWin(buildupDataset(app));
      setStoreWell(app, { testType: 'auto' }, 'user');
      const f = w.PRiSM_fitPhysical('homogeneous', null, null);
      assert.ok(f.ok, f.reason);
      assert.near(f.phys.k, 45, 0.5);
      assert.near(f.phys.S, 2.5, 0.05);
    },
  },
];
