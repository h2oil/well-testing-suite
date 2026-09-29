// WP1 — Well & Test inputs + PTA core (16-pvt.js, 33-pta-core.js).
// Acceptance a–j from the gap-closure plan plus card / scale-mode / multi-rate checks.
'use strict';

// Default-sample metadata (contract C1). WP8 publishes it as
// window.PRiSM_DEFAULT_SAMPLE_META; these tests fall back to the same values.
const META = { pi: 4200, testType: 'drawdown', q: 850, Bo: 1.25, mu_o: 1.1, ct: 1.2e-5,
               h: 35, phi: 0.18, rw: 0.354, fluidType: 'oil' };
const TRUTH = { k: 45, Cd: 80, S: 2.5, C: 8.48e-4, pi: 4200, q: 850, B: 1.25, mu: 1.1, h: 35, phi: 0.18, ct: 1.2e-5, rw: 0.354 };
const A1 = 141.2 * TRUTH.B * TRUTH.mu / (TRUTH.k * TRUTH.h);                        // psi per (STB/d · pD)
const BT = 0.0002637 * TRUTH.k / (TRUTH.phi * TRUTH.mu * TRUTH.ct * TRUTH.rw * TRUTH.rw); // tD per hour

function meta(app) {
  const m = app.win.PRiSM_DEFAULT_SAMPLE_META;
  return m && m.pi ? Object.assign({}, m) : Object.assign({}, META);
}
function seedWithMeta(app, extra) {
  app.seedSample();
  app.win.PRiSM_setWell(app.toWin(Object.assign(meta(app), extra || {})), app.toWin({ source: 'sample' }));
  return app.win;
}
// The sample dataset without the seeding side effects (no META applied).
function plainSample(app) {
  const lines = String(app.win.PRiSM_DEFAULT_SAMPLE_CSV).trim().split(/\r?\n/).slice(1);
  const t = [], p = [], q = [];
  lines.forEach((ln) => { const c = ln.split(','); t.push(+c[0]); p.push(+c[1]); q.push(+c[2]); });
  app.win.PRiSM_dataset = app.toWin({ t, p, q });
  return app.win.PRiSM_dataset;
}
function logspace(lo, hi, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(Math.pow(10, lo + (hi - lo) * i / (n - 1)));
  return out;
}
function median(a) {
  const b = a.filter(Number.isFinite).sort((x, y) => x - y);
  const m = b.length >> 1;
  return b.length % 2 ? b[m] : 0.5 * (b[m - 1] + b[m]);
}
// Independent superposition (test side): D(T) = A1 Σ Δq_i pd(BT (T − t_i)).
function drawdownD(app, steps, T, params) {
  const pd = app.win.PRiSM_MODELS.homogeneous.pd;
  const out = T.map(() => 0);
  for (let i = 0; i < steps.length; i++) {
    const dq = steps[i].q - (i ? steps[i - 1].q : 0);
    if (!dq) continue;
    const idx = [], td = [];
    T.forEach((t, j) => { if (t > steps[i].t) { idx.push(j); td.push(BT * (t - steps[i].t)); } });
    if (!td.length) continue;
    const v = pd(td, params || { Cd: TRUTH.Cd, S: TRUTH.S });
    idx.forEach((j, k) => { out[j] += A1 * dq * v[k]; });
  }
  return out;
}
// Synthetic single-rate buildup: q = 850 for 24 h, then shut in; Δt 0.001–72 h.
function buildupDataset(app) {
  const tDD = logspace(-3, Math.log10(24), 60); tDD[tDD.length - 1] = 24;
  const tBU = logspace(-3, Math.log10(72), 80).map((d) => 24 + d);
  const T = tDD.concat(tBU);
  const q = tDD.map(() => 850).concat(tBU.map(() => 0));
  const D = drawdownD(app, [{ t: 0, q: 850 }, { t: 24, q: 0 }], T);
  const p = D.map((d) => TRUTH.pi - d);
  return { t: T, p, q, pwf24: p[tDD.length - 1] };
}
function interpAt(t, y, t0) {
  for (let i = 1; i < t.length; i++) {
    if (t[i] >= t0 && Number.isFinite(y[i]) && Number.isFinite(y[i - 1])) {
      const f = (Math.log(t0) - Math.log(t[i - 1])) / (Math.log(t[i]) - Math.log(t[i - 1]));
      return y[i - 1] + f * (y[i] - y[i - 1]);
    }
  }
  return NaN;
}

module.exports = [
  {
    name: 'a. default sample + META → Δp from pi, 55 points, derivative plateau 52.4',
    wp: 'WP1',
    run(app, assert) {
      const w = seedWithMeta(app);
      const ad = w.PRiSM_getAnalysisData();
      assert.ok(ad.ok, ad.reason);
      assert.equal(ad.pRefSource, 'pi');
      assert.equal(ad.pRef, 4200);
      assert.equal(ad.n, 55);
      assert.equal(ad.testType, 'drawdown');
      assert.equal(ad.sign, -1);
      assert.equal(ad.timeFn, 'dt');
      assert.near(ad.dp[0], 338.6, 0.1, 'dp[0]');
      assert.near(ad.dp[54], 1110.2, 0.1, 'dp[end]');
      const late = ad.deriv.filter((d, i) => ad.t[i] >= 10);
      assert.near(median(late), 52.4, 1.0, 'late derivative');
      assert.ok(ad.dp.every((v) => v > 0), 'all Δp positive');
      assert.equal(ad.qRef, 850);
      // Auto test type resolves the same way from the rate column.
      w.PRiSM_setWell(app.toWin({ testType: 'auto' }));
      const ad2 = w.PRiSM_getAnalysisData();
      assert.equal(ad2.testType, 'drawdown');
      assert.equal(ad2.n, 55);
    },
  },
  {
    name: 'b. pi provenance default → estimated pRef, skin-bias warning',
    wp: 'WP1',
    run(app, assert) {
      const w = seedWithMeta(app);
      w.PRiSM_setWell(app.toWin({ pi: 4200 }), app.toWin({ source: 'default' }));
      assert.equal(w.PRiSM_getWell().pi, null, 'defaulted pi is not trusted');
      const ad = w.PRiSM_getAnalysisData();
      assert.ok(ad.ok);
      assert.ok(ad.pRefSource === 'extrapolated' || ad.pRefSource === 'first-sample', ad.pRefSource);
      assert.ok(ad.warnings.join(' ').indexOf('skin') !== -1, 'warning mentions skin');
      assert.ok(ad.dp.every((v) => v > 0));
    },
  },
  {
    name: 'c. synthetic buildup (tp 24 h): auto-detect, tp, pwf0, superposition derivative 52.4',
    wp: 'WP1',
    run(app, assert) {
      const w = seedWithMeta(app, { testType: 'auto' });
      const bu = buildupDataset(app);
      w.PRiSM_dataset = app.toWin({ t: bu.t, p: bu.p, q: bu.q });
      const ad = w.PRiSM_getAnalysisData();
      assert.ok(ad.ok, ad.reason);
      assert.equal(ad.testType, 'buildup');
      assert.equal(ad.sign, 1);
      assert.near(ad.tShut, 24, 1e-9, 'tShut');
      assert.near(ad.tp, 24, 0.01, 'tp');
      assert.near(ad.pwf0, bu.pwf24, 0.5, 'pwf0');
      assert.equal(ad.pRefSource, 'pwf0');
      assert.equal(ad.timeFn, 'superposition');
      assert.equal(ad.n, 80);
      // Δt ≥ 1 h: median on the plateau; every point once the storage-hump tail has
      // decayed (the exact model derivative is still 54.1 psi at Δt = 1 h for CD·e^2S ≈ 1.2e4).
      const late = ad.deriv.filter((d, i) => ad.t[i] >= 1 && Number.isFinite(d));
      assert.ok(late.length > 20);
      assert.near(median(late), 52.4, 1.0, 'median superposition derivative, Δt ≥ 1 h');
      ad.deriv.filter((d, i) => ad.t[i] >= 3 && Number.isFinite(d))
        .forEach((d) => assert.near(d, 52.4, 1.0, 'superposition derivative, Δt ≥ 3 h'));
      // Old behaviour (derivative on Δt) documents the false boundary.
      const adDt = w.PRiSM_getAnalysisData(null, app.toWin({ timeFn: 'dt' }));
      assert.equal(adDt.timeFn, 'dt');
      const d30 = interpAt(adDt.t, adDt.deriv, 30);
      assert.ok(d30 < 45, 'Δt derivative at 30 h is ' + d30);
      // Agarwal time: tp·Δt/(tp+Δt).
      const adAg = w.PRiSM_getAnalysisData(null, app.toWin({ timeFn: 'agarwal' }));
      assert.equal(adAg.timeFn, 'agarwal');
      assert.near(adAg.x[adAg.n - 1], 24 * 72 / 96, 1e-6);
    },
  },
  {
    name: 'd. physical model reproduces the sample (< 0.6 psi) and the buildup (< 0.01 psi)',
    wp: 'WP1',
    run(app, assert) {
      const w = seedWithMeta(app);
      const well = w.PRiSM_getWell();
      assert.ok(well.complete, 'well complete: missing ' + well.missing);
      const ad = w.PRiSM_getAnalysisData();
      const pm = w.PRiSM_physicalModel('homogeneous', well, ad);
      assert.ok(pm.ok, pm.reason);
      assert.equal(pm.mode, 'physical');
      assert.deepEqual(Array.from(pm.keys), ['k', 'C', 'S']);
      const phys = app.toWin({ k: 45, C: 8.48e-4, S: 2.5 });
      const dp = pm.dp(ad.t, phys);
      let worst = 0;
      for (let i = 0; i < ad.n; i++) worst = Math.max(worst, Math.abs(4200 - ad.p[i] - dp[i]));
      assert.ok(worst < 0.6, 'max |4200 − p − dp| = ' + worst);
      const der = pm.deriv(ad.t, phys);
      assert.near(der[ad.n - 1], 52.39, 0.1, 'model derivative plateau');
      const pAbs = pm.p(ad.t, phys);
      assert.near(pAbs[ad.n - 1], ad.p[ad.n - 1], 0.6);
      const dv = pm.derived(phys);
      assert.near(dv.Cd, 79.98, 0.1);
      assert.near(dv.A, 104.78, 0.05);
      assert.near(dv.B, 39854, 20);
      assert.near(dv.rinv, 1548, 2);
      assert.near(dv.kh, 1575, 1e-9);
      // Seed lands near the truth.
      const s0 = pm.seed();
      assert.rel(s0.k, 45, 0.05, 'seed k');
      assert.near(s0.S, 2.5, 1.0, 'seed S');
      assert.ok(s0.C > 0);
      // Float pi: same Δp at the true pi.
      const pmF = w.PRiSM_physicalModel('homogeneous', well, ad, app.toWin({ floatPi: true }));
      assert.ok(pmF.keys.indexOf('pi') !== -1);
      const dpF = pmF.dp(ad.t, app.toWin({ k: 45, C: 8.48e-4, S: 2.5, pi: 4200 }));
      for (let i = 0; i < ad.n; i++) assert.near(dpF[i], dp[i], 1e-9);

      // Buildup: exact reproduction through superposition.
      const bu = buildupDataset(app);
      w.PRiSM_setWell(app.toWin({ testType: 'auto' }));
      w.PRiSM_dataset = app.toWin({ t: bu.t, p: bu.p, q: bu.q });
      const adB = w.PRiSM_getAnalysisData();
      const pmB = w.PRiSM_physicalModel('homogeneous', w.PRiSM_getWell(), adB);
      assert.ok(pmB.ok && !pmB.simple);
      const physB = app.toWin({ k: 45, C: TRUTH.Cd * TRUTH.phi * TRUTH.ct * TRUTH.h * TRUTH.rw * TRUTH.rw / 0.8936, S: 2.5 });
      const dpB = pmB.dp(adB.t, physB);
      let worstB = 0;
      for (let i = 0; i < adB.n; i++) worstB = Math.max(worstB, Math.abs(adB.dp[i] - dpB[i]));
      assert.ok(worstB < 0.01, 'buildup max |Δp − model| = ' + worstB);
      const pB = pmB.p(adB.t, physB);
      for (let i = 0; i < adB.n; i++) assert.near(pB[i], adB.p[i], 0.01);
      const derB = pmB.deriv(adB.t, physB);
      assert.near(derB[adB.n - 1], 52.39, 0.5, 'buildup model derivative (superposition time)');
      const sB = pmB.seed();
      assert.rel(sB.k, 45, 0.05, 'buildup seed k');
    },
  },
  {
    name: 'e. conversions: A, B, Cd, rinv, C from T',
    wp: 'WP1',
    run(app, assert) {
      const C = app.win.PRiSM_convert;
      const W = app.toWin({ q: 850, B: 1.25, mu: 1.1, h: 35, phi: 0.18, ct: 1.2e-5, rw: 0.354 });
      assert.near(C.A(W, { k: 45 }), 104.78, 0.05);
      assert.near(C.B(W, { k: 45 }), 39854, 20);
      assert.near(C.Cd(W, { C: 8.48e-4 }), 79.98, 0.1);
      assert.near(C.rinv(W, { k: 45, t: 120 }), 1548, 2);
      assert.rel(C.C(W, { Cd: 79.98 }), 8.48e-4, 1e-3);
      assert.near(C.kh(W, { A: 104.78 }), 1575, 1);
      assert.near(C.plateau(W, { k: 45 }), 52.39, 0.01);
      assert.near(C.semilogSlope(W, { k: 45 }), 120.66, 0.02);
      const Bt = C.B(W, { k: 45 });
      assert.rel(C.CfromT(W, { kh: 1575, T: Bt / 80 }), 8.48e-4, 0.002);
      assert.near(C.distance({ D: 1000, rw: 0.354 }), 354, 1e-9);
    },
  },
  {
    name: 'f. matchToPhysical: truth match and (Cd, S) degeneracy correction',
    wp: 'WP1',
    run(app, assert) {
      const w = seedWithMeta(app);
      const well = w.PRiSM_getWell();
      const m1 = w.PRiSM_matchToPhysical(app.toWin({ logPM: Math.log10(1 / 104.78), logTM: Math.log10(39854) }),
                                         'homogeneous', app.toWin({ Cd: 80, S: 2.5 }), well);
      assert.ok(m1.ok, m1.reason);
      assert.near(m1.k, 45.0, 0.1);
      assert.rel(m1.C, 8.48e-4, 0.01);
      assert.near(m1.S, 2.5, 0.01);
      assert.ok(m1.consistent);
      const m2 = w.PRiSM_matchToPhysical(app.toWin({ logPM: Math.log10(1 / 104.78), logTM: Math.log10(39854) + 1 }),
                                         'homogeneous', app.toWin({ Cd: 800, S: 2.5 - 0.5 * Math.LN10 }), well);
      assert.near(m2.k, 45.0, 0.1);
      assert.rel(m2.C, 8.48e-4, 0.01);
      assert.near(m2.S, 2.5, 0.01);
      assert.near(m2.Cd, 80, 0.2);
      assert.near(m2.params.S, 2.5, 0.01);
      // Overlay mapping: Δp = pd/PM at t = td/TM.
      const ov = w.PRiSM_applyTypeCurveMatch(app.toWin({ td: [39854, 398540], pd: [1, 2], pdPrime: [0.5, 0.5] }),
                                             app.toWin({ logPM: Math.log10(1 / 104.78), logTM: Math.log10(39854) }));
      assert.near(ov.t[0], 1, 1e-9);
      assert.near(ov.dp[1], 2 * 104.78, 1e-6);
      assert.near(ov.deriv[0], 52.39, 1e-6);
    },
  },
  {
    name: 'g. dimensionalize: least-squares k from all points, rinv (948)',
    wp: 'WP1',
    run(app, assert) {
      const w = seedWithMeta(app);
      w.PRiSM_state.lastFit = undefined;
      w.PRiSM_state.semilog = undefined;
      const d = w.PRiSM_dimensionalize('homogeneous', app.toWin({ Cd: 80, S: 2.5 }));
      assert.ok(d.ok, (d.caveats || []).join(' '));
      assert.near(d.k, 45, 0.5, 'k');
      assert.near(d.rinv, 1548, 2, 'rinv');
      assert.ok(/least squares/.test(d.kSource), d.kSource);
      assert.equal(d.pRefSource, 'pi');
      assert.rel(d.C, 8.48e-4, 0.01);
      // A physical fit result takes precedence.
      w.PRiSM_setLastFit(app.toWin({ modelKey: 'homogeneous', params: { Cd: 80, S: 2.5 }, phys: { k: 44 } }));
      const d2 = w.PRiSM_dimensionalize('homogeneous', app.toWin({ Cd: 80, S: 2.5 }));
      assert.equal(d2.k, 44);
      assert.ok(/fit/.test(d2.kSource));
      // Semilog kh when no physical fit exists.
      w.PRiSM_state.lastFit = undefined;
      w.PRiSM_state.semilog = app.toWin({ m: 120.66 });
      const d3 = w.PRiSM_dimensionalize('homogeneous', app.toWin({ Cd: 80, S: 2.5 }));
      assert.near(d3.k, 45, 0.05);
      assert.equal(d3.kSource, 'semilog');
    },
  },
  {
    name: 'h. gas: Bg in RB/Mscf, m(p) table strictly increasing, Δm analysis data',
    wp: 'WP1',
    run(app, assert) {
      const w = app.win;
      app.seedSample();                      // (seeding may apply the oil sample META)
      const cor = w.PRiSM_pvt_correlations;
      const Z = cor.Z_dranchukAbouKassem((180 + 459.67) / cor.Tpc_sutton(0.65), 4000 / cor.Ppc_sutton(0.65));
      assert.near(cor.Bg(4000, 180, Z), 0.750, 0.01, 'Bg');
      w.PRiSM_setWell(app.toWin({ fluidType: 'gas', pi: 4000, T_res: 180, SG_g: 0.65 }));
      const eff = w.PRiSM_pvt_effective();
      assert.near(eff.B, 0.750, 0.01, 'effective Bg at pi');
      const tbl = w.PRiSM_mpTable(app.toWin({ T_F: 180, SG_g: 0.65, pi: 4000 }));
      assert.equal(tbl.m.length, 200);
      assert.near(tbl.pmin, 14.7, 1e-9);
      assert.near(tbl.pmax, 4800, 1e-9);
      for (let i = 1; i < tbl.m.length; i++) assert.ok(tbl.m[i] > tbl.m[i - 1], 'm strictly increasing at ' + i);
      let prev = -Infinity;
      for (let p = 20; p < 6000; p += 7.3) { const m = tbl.mOf(p); assert.ok(m > prev, 'mOf increasing at ' + p); prev = m; }
      assert.rel(tbl.mOf(4000), cor.m_p(4000, 180, 0.65), 1e-3);
      assert.near(tbl.pOf(tbl.mOf(2500)), 2500, 1e-3);
      assert.strictEqual(w.PRiSM_mpTable(app.toWin({ T_F: 180, SG_g: 0.65, pi: 4000 })), tbl, 'cached');
      // Analysis data in Δm.
      w.PRiSM_setWell(app.toWin({ pi: 4200, h: 35, phi: 0.18, rw: 0.354 }), app.toWin({ source: 'sample' }));
      const ad = w.PRiSM_getAnalysisData();
      assert.ok(ad.ok && ad.pseudo, 'pseudo-pressure used for gas');
      assert.equal(ad.dpUnit, 'psi²/cp');
      assert.ok(ad.dp.every((v, i) => v > 0 && (i === 0 || v > ad.dp[i - 1])));
      const pm = w.PRiSM_physicalModel('homogeneous', w.PRiSM_getWell(), ad);
      assert.ok(pm.ok && pm.pseudo);
      assert.near(pm.coef, 1422 * (180 + 459.67), 1e-6);
    },
  },
  {
    name: 'i. setLastFit normalises aliases and fires prism:fit-updated',
    wp: 'WP1',
    run(app, assert) {
      const w = app.win;
      app.evalInApp("window.__wp1fits = 0; window.addEventListener('prism:fit-updated', function (e) { window.__wp1fits++; window.__wp1src = e.detail && e.detail.source; });");
      w.PRiSM_setLastFit(app.toWin({ R2: 0.9, RMSE: 1, AIC: 3, modelKey: 'x' }));
      const f = w.PRiSM_getLastFit();
      assert.equal(f.r2, 0.9);
      assert.equal(f.rmse, 1);
      assert.equal(f.aic, 3);
      assert.equal(f.model, 'x');
      assert.equal(f.modelKey, 'x');
      assert.equal(f.source, 'regression');
      assert.equal(w.__wp1fits, 1);
      assert.equal(w.__wp1src, 'regression');
      assert.deepEqual(JSON.parse(JSON.stringify(w.PRiSM_state.match)), { timeShift: 0, pressShift: 0 }, 'st.match untouched');
      // Stale flag when the dataset changes.
      app.seedSample();
      w.PRiSM_setLastFit(app.toWin({ r2: 0.99, modelKey: w.PRiSM_state.model }));
      assert.equal(w.PRiSM_getLastFit().stale, false);
      w.PRiSM_dataset = app.toWin({ t: [1, 2, 3], p: [3, 2, 1], q: null });
      assert.equal(w.PRiSM_getLastFit().stale, true);
      // semilog exposed through getLastFit
      w.PRiSM_state.semilog = app.toWin({ m: 120.7 });
      assert.near(w.PRiSM_getLastFit().semilog.m, 120.7, 1e-9);
    },
  },
  {
    name: 'j. persistence: wts_prism_state + wts_prism_pvt round-trip between sessions',
    wp: 'WP1',
    run(app, assert, ctx) {
      const w = seedWithMeta(app);
      const st = w.PRiSM_state;
      st.model = 'homogeneous';
      st.params = app.toWin({ Cd: 80, S: 2.5 });
      st.paramFreeze = app.toWin({ Cd: true });
      st.tcMatch = app.toWin({ logPM: -2.0203, logTM: 4.6005, source: 'match' });
      st.bourdetL = 0.2;
      st.timeFn = 'superposition';
      st.activePeriod = 0;
      w.PRiSM_setLastFit(app.toWin({ modelKey: 'homogeneous', r2: 0.9999, params: { Cd: 80, S: 2.5 },
                                      phys: { k: 45, C: 8.48e-4, S: 2.5 }, converged: true }));
      w.PRiSM_saveState();
      const raw = app.storage.getItem('wts_prism_state');
      assert.ok(raw && JSON.parse(raw).tcMatch, 'state saved');

      const b = ctx.loadApp({ storage: app.storage });
      const sb = b.win.PRiSM_state;
      assert.deepEqual(JSON.parse(JSON.stringify(sb.tcMatch)), { logPM: -2.0203, logTM: 4.6005, source: 'match' });
      assert.equal(sb.model, 'homogeneous');
      assert.equal(sb.params.S, 2.5);
      assert.equal(sb.paramFreeze.Cd, true);
      assert.equal(sb.bourdetL, 0.2);
      assert.equal(sb.timeFn, 'superposition');
      assert.equal(sb.activePeriod, 0);
      assert.equal(sb.lastFit.phys.k, 45);
      assert.equal(b.win.PRiSM_getLastFit().r2, 0.9999);
      assert.deepEqual(JSON.parse(JSON.stringify(sb.match)), { timeShift: 0, pressShift: 0 });
      // The Well & Test store round-trips with its provenance.
      const pv = b.win.PRiSM_pvt;
      assert.equal(pv.p_res, 4200);
      assert.equal(pv.provenance.p_res, 'sample');
      assert.equal(pv.ct, 1.2e-5);
      assert.equal(b.win.PRiSM_getWell(null).pi, 4200);
    },
  },
  {
    name: 'j2. debounced state save on events (one-shot timer, no perpetual timers from WP1)',
    wp: 'WP1',
    run(app, assert) {
      const w = seedWithMeta(app);
      w.PRiSM_state.tcMatch = app.toWin({ logPM: -2, logTM: 4.6 });
      app.fire('window', 'prism:model-changed', {});
      app.fire('window', 'prism:plot-changed', {});
      app.flush(299);
      const before = app.storage.getItem('wts_prism_state');
      assert.ok(!before || !JSON.parse(before).tcMatch, 'not saved before 300 ms');
      app.flush(10);
      const after = JSON.parse(app.storage.getItem('wts_prism_state'));
      assert.equal(after.tcMatch.logPM, -2);
      app.flush(2000);
      const mine = app.timers().filter((t) => /16-pvt|33-pta-core/.test(t.where || ''));
      assert.equal(mine.length, 0, 'WP1 timers pending: ' + mine.map((t) => t.where).join(' | '));
    },
  },
  {
    name: 'k. getWell: provenance, missing/defaulted, q from data, alias writes',
    wp: 'WP1',
    run(app, assert) {
      const w = app.win;
      plainSample(app);
      let well = w.PRiSM_getWell();
      assert.equal(well.pi, null, 'default pi not trusted');
      assert.ok(well.defaulted.indexOf('pi') !== -1 && well.defaulted.indexOf('h') !== -1);
      assert.equal(well.q, 850, 'q from the dataset rate column');
      assert.equal(well.provenance.q, 'dataset');
      w.PRiSM_setWell(app.toWin(meta(app)), app.toWin({ source: 'sample' }));
      well = w.PRiSM_getWell();
      assert.equal(well.complete, true);
      assert.deepEqual(Array.from(well.missing), []);
      assert.deepEqual(Array.from(well.defaulted), []);
      assert.equal(well.B, 1.25); assert.equal(well.mu, 1.1); assert.equal(well.ct, 1.2e-5);
      assert.equal(well.provenance.B, 'sample');
      assert.equal(well.testType, 'drawdown');
      // q typed by hand overrides the data rate when "from data" is off.
      w.PRiSM_setWell(app.toWin({ qFromData: false, q: 900 }));
      well = w.PRiSM_getWell();
      assert.equal(well.q, 900);
      const ad = w.PRiSM_getAnalysisData();
      assert.equal(ad.qFlow, 900);
      // Clearing a direct entry returns to the correlation value.
      w.PRiSM_setWell(app.toWin({ ct: null }));
      well = w.PRiSM_getWell();
      assert.ok(well.ct > 0 && well.ct !== 1.2e-5);
      assert.notEqual(well.provenance.ct, 'sample');
      // Missing input → incomplete.
      w.PRiSM_setWell(app.toWin({ h: 0 }));
      assert.deepEqual(Array.from(w.PRiSM_getWell().missing), ['h']);
    },
  },
  {
    name: 'l. scale mode (incomplete well): kh and C from A, T; S not identifiable',
    wp: 'WP1',
    run(app, assert) {
      const w = seedWithMeta(app);
      w.PRiSM_setWell(app.toWin({ h: 0 }));
      const well = w.PRiSM_getWell();
      assert.equal(well.complete, false);
      const pm = w.PRiSM_physicalModel('homogeneous', well, w.PRiSM_getAnalysisData());
      assert.ok(pm.ok);
      assert.equal(pm.mode, 'scale');
      assert.deepEqual(Array.from(pm.keys), ['A', 'T', 'CDe2S']);
      assert.equal(pm.identifiable.S, false);
      const d = pm.derived(app.toWin({ A: 104.78, T: 39854 / 80, CDe2S: 80 * Math.exp(5) }));
      assert.near(d.kh, 1575, 1);
      assert.equal(d.k, null);
      assert.rel(d.C, 8.48e-4, 0.005);
      assert.equal(d.S, null);
      const s0 = pm.seed();
      assert.rel(s0.A, 104.78, 0.05, 'seed A');
      assert.ok(pm.warnings.join(' ').indexOf('scale mode') !== -1);
      const dp = pm.dp(w.PRiSM_getAnalysisData().t, app.toWin({ A: 104.78, T: 39854 / 80, CDe2S: 80 * Math.exp(5) }));
      assert.ok(dp.every(Number.isFinite));
    },
  },
  {
    name: 'm. two-rate drawdown: superposition time, qRef = Δq, model reproduces data',
    wp: 'WP1',
    run(app, assert) {
      const w = seedWithMeta(app, { testType: 'auto' });
      const t1 = logspace(-2, 1, 40); t1[t1.length - 1] = 10;
      const t2 = logspace(-2, Math.log10(90), 50).map((d) => 10 + d);
      const T = t1.concat(t2);
      const q = t1.map(() => 500).concat(t2.map(() => 850));
      const D = drawdownD(app, [{ t: 0, q: 500 }, { t: 10, q: 850 }], T);
      w.PRiSM_dataset = app.toWin({ t: T, p: D.map((d) => 4200 - d), q });
      const ad = w.PRiSM_getAnalysisData();
      assert.ok(ad.ok, ad.reason);
      assert.equal(ad.periods.length, 2);
      assert.equal(ad.periodIndex, 1);
      assert.equal(ad.testType, 'drawdown');
      assert.equal(ad.timeFn, 'superposition');
      assert.equal(ad.pRefSource, 'pi');
      assert.near(ad.qRef, 350, 1e-9);
      assert.near(ad.qFlow, 850, 1e-9);
      const late = ad.deriv.filter((d, i) => ad.t[i] >= 5 && Number.isFinite(d));
      const plateau = 70.6 * 350 * 1.25 * 1.1 / 1575;
      late.forEach((d) => assert.near(d, plateau, 0.5));
      const pm = w.PRiSM_physicalModel('homogeneous', w.PRiSM_getWell(), ad);
      const phys = app.toWin({ k: 45, C: TRUTH.Cd * TRUTH.phi * TRUTH.ct * TRUTH.h * TRUTH.rw * TRUTH.rw / 0.8936, S: 2.5 });
      const dp = pm.dp(ad.t, phys);
      for (let i = 0; i < ad.n; i++) assert.near(dp[i], ad.dp[i], 0.01);
      // The first period can be selected explicitly (Δt re-zeroed).
      const ad0 = w.PRiSM_getAnalysisData(null, app.toWin({ period: 0 }));
      assert.equal(ad0.periodIndex, 0);
      assert.equal(ad0.timeFn, 'dt');
      assert.ok(ad0.t[0] < 0.02 && ad0.n === 40);
      assert.notDeepEqual(Array.from(ad0.dp), Array.from(ad.dp));
    },
  },
  {
    name: 'n. injection falloff with positive rates: sign rule, Δp > 0, model reproduces data',
    wp: 'WP1',
    run(app, assert) {
      const w = seedWithMeta(app, { testType: 'falloff' });
      const tI = logspace(-3, Math.log10(24), 40); tI[tI.length - 1] = 24;
      const tF = logspace(-3, Math.log10(48), 60).map((d) => 24 + d);
      const T = tI.concat(tF);
      const q = tI.map(() => 850).concat(tF.map(() => 0));
      const D = drawdownD(app, [{ t: 0, q: -850 }, { t: 24, q: 0 }], T);
      w.PRiSM_dataset = app.toWin({ t: T, p: D.map((d) => 4200 - d), q });
      const ad = w.PRiSM_getAnalysisData();
      assert.ok(ad.ok, ad.reason);
      assert.equal(ad.testType, 'falloff');
      assert.equal(ad.sign, -1);
      assert.ok(ad.dp.every((v) => v > 0));
      const late = ad.deriv.filter((d, i) => ad.t[i] >= 2 && Number.isFinite(d));
      late.forEach((d) => assert.near(d, 52.4, 1.0));
      const pm = w.PRiSM_physicalModel('homogeneous', w.PRiSM_getWell(), ad);
      const phys = app.toWin({ k: 45, C: TRUTH.Cd * TRUTH.phi * TRUTH.ct * TRUTH.h * TRUTH.rw * TRUTH.rw / 0.8936, S: 2.5 });
      const dp = pm.dp(ad.t, phys);
      for (let i = 0; i < ad.n; i++) assert.near(dp[i], ad.dp[i], 0.01);
    },
  },
  {
    name: 'o. buildup-only file + entered tp/q: synthesised history',
    wp: 'WP1',
    run(app, assert) {
      const w = seedWithMeta(app, { testType: 'buildup', tp: 24 });
      const bu = buildupDataset(app);
      const n0 = bu.t.findIndex((t) => t > 24);
      // Buildup samples only, time from shut-in, no rate column; pwf0 entered.
      w.PRiSM_dataset = app.toWin({ t: bu.t.slice(n0).map((t) => t - 24), p: bu.p.slice(n0), q: null });
      w.PRiSM_setWell(app.toWin({ pwf0: bu.pwf24 }));
      const ad = w.PRiSM_getAnalysisData();
      assert.ok(ad.ok, ad.reason);
      assert.equal(ad.testType, 'buildup');
      assert.equal(ad.rateSource, 'synthesised');
      assert.near(ad.tp, 24, 1e-9);
      assert.equal(ad.pRefSource, 'pwf0');
      assert.equal(ad.timeFn, 'superposition');
      ad.deriv.filter((d, i) => ad.t[i] >= 3 && Number.isFinite(d)).forEach((d) => assert.near(d, 52.4, 1.0));
    },
  },
  {
    name: 'p. Well & Test card: ids, chip, amber default badges, Accept, change → setWell (375 px)',
    wp: 'WP1',
    opts: { viewport: { width: 375, height: 812 } },
    run(app, assert) {
      const w = app.win;
      plainSample(app);
      const host = app.document.createElement('div');
      app.document.body.appendChild(host);
      w.PRiSM_renderPVTPanel(host);
      ['testType', 'pi', 'tp', 'tShut', 'pwf0', 'q', 'rw', 'h', 'phi', 'fluidType', 'B', 'mu', 'ct',
       'testtype_chip', 'summary', 'pvt_btn', 'q_fromdata', 'pvt_drawer'].forEach((k) => {
        assert.ok(app.el('prism_well_' + k), 'prism_well_' + k);
      });
      assert.equal(app.el('prism_well_testtype_chip').getAttribute('data-testtype'), 'drawdown');
      assert.ok(/Drawdown/.test(app.el('prism_well_testtype_chip').textContent));
      // Defaults are amber with an Accept action.
      const hBadge = host.querySelector('[data-badge-for="h"] .prism-prov--default');
      assert.ok(hBadge, 'h shows a default badge');
      assert.ok(/--yellow/.test(hBadge.getAttribute('style')), 'amber badge');
      assert.ok(host.querySelector('[data-well-accept="h"]'));
      assert.ok(/default/.test(app.el('prism_well_summary').textContent));
      // No fixed widths wider than a 375 px phone.
      const widths = (host.innerHTML.match(/(?:^|[;\s"])(?:min-)?width:\s*(\d+)px/g) || [])
        .map((s) => +s.replace(/\D+/g, ''));
      assert.ok(widths.every((v) => v <= 343), 'fixed widths: ' + widths);
      // Accept one default.
      app.evalInApp("window.__wp1well = []; window.addEventListener('prism:well-changed', function (e) { window.__wp1well.push(e.detail); });");
      app.click(host.querySelector('[data-well-accept="h"]'));
      assert.equal(w.PRiSM_pvt.provenance.h, 'user');
      assert.equal(host.querySelector('[data-badge-for="h"]').innerHTML, '', 'badge cleared');
      // Edit pi → user provenance, event, getWell().pi.
      app.input('prism_well_pi', '4200');
      assert.equal(w.PRiSM_pvt.p_res, 4200);
      assert.equal(w.PRiSM_pvt.provenance.p_res, 'user');
      assert.equal(w.PRiSM_getWell().pi, 4200);
      assert.ok(w.__wp1well.length >= 2);
      assert.equal(w.__wp1well[w.__wp1well.length - 1].source, 'user');
      // Test type select re-renders the chip.
      app.select('prism_well_testType', 'buildup');
      assert.equal(w.PRiSM_pvt.testType, 'buildup');
      assert.equal(app.el('prism_well_testType').value, 'buildup');
      // Accept all.
      app.click('prism_well_accept_all');
      assert.equal(w.PRiSM_getWell().defaulted.length, 0);
      assert.ok(/complete/.test(app.el('prism_well_summary').textContent));
    },
  },
  {
    name: 'q. Estimate from PVT… drawer: toggle, compute, use estimates (provenance PVT)',
    wp: 'WP1',
    run(app, assert) {
      const w = app.win;
      app.seedSample();
      const host = app.document.createElement('div');
      app.document.body.appendChild(host);
      w.PRiSM_renderPVTPanel(host);
      assert.equal(app.el('prism_well_pvt_drawer').style.display, 'none');
      app.click('prism_well_pvt_btn');
      assert.notEqual(app.el('prism_well_pvt_drawer').style.display, 'none');
      app.click(host.querySelector('[data-pvt-act="compute"]'));
      assert.ok(/compressibility/.test(host.querySelector('[data-pvt-computed]').textContent));
      app.click('prism_well_pvt_use');
      const well = w.PRiSM_getWell();
      assert.equal(well.provenance.B, 'correlation');
      assert.equal(well.provenance.ct, 'correlation');
      assert.ok(well.B > 1 && well.mu > 0 && well.ct > 0);
      assert.equal(Number(app.el('prism_well_B').value), w.PRiSM_pvt.Bo);
      // Drawer input edit (temperature) commits through setWell.
      const tInp = host.querySelector('[data-pvt-field="T_res"]');
      app.input(tInp, '200');
      assert.equal(w.PRiSM_pvt.T_res, 200);
      // Convert current fit.
      w.PRiSM_setWell(app.toWin(meta(app)), app.toWin({ source: 'sample' }));
      app.click(host.querySelector('[data-pvt-act="apply"]'));
      assert.ok(/md/.test(host.querySelector('[data-pvt-dim]').textContent));
    },
  },
  {
    name: 'r. the card is registered as a Tab 1 panel (C7 registry, order 10)',
    wp: 'WP1',
    run(app, assert) {
      const reg = app.win.PRiSM_tabPanels;
      const list = reg && (reg[1] || reg['1']);
      assert.ok(list && list.length, 'tab 1 panel list');
      const p = Array.from(list).find((x) => x && x.id === 'prism_well_test');
      assert.ok(p, 'Well & Test panel registered');
      assert.equal(p.order, 10);
      assert.equal(p.title, 'Well & Test');
      const host = app.document.createElement('div');
      app.document.body.appendChild(host);
      p.render(host);
      assert.ok(host.querySelector('#prism_well_card'));
    },
  },
  {
    name: 'r2. (integration) Tab 1 mounts the Well & Test card; sample META applied on seed',
    wp: 'WP1',
    integration: true,
    run(app, assert) {
      app.openPRiSM();
      app.renderTab(1);
      assert.ok(app.find('#prism_tab_1_panels #prism_well_card'), 'card mounted in tab 1');
      const well = app.win.PRiSM_getWell();
      assert.equal(well.pi, 4200, 'sample META applied with source sample');
      assert.equal(well.provenance.pi, 'sample');
      assert.ok(/sample/.test(app.find('#prism_tab_1_panels #prism_well_card').innerHTML));
    },
  },
];
