// DFIT — WP3 after-closure analysis, pipeline and results layer (docs/DFIT-PLAN.md §4.12, §4.13, §6.4, §6.8, §3.3a; §9 WP3).
//
//   A1  constants: 250,856 / 4,181 / 1,694.5 / 97.54 / 29,437 / 845.50 / 109.15 / 1.1827e-3 / 2.63679e-4 from first principles
//   A2  Nolte vs impulse: exact Carter radial = m_R·F_Rc, F_R line vs the centroid impulse within 0.1 % late; Carter linear =
//       m_L·F_L with V = 8·CL·h·L·√t_c
//   A3  kernel slopes: uniform flux −0.950 (t_DL 1.60), −0.980 (4.10); penny −1.00 (ηt/R² 0.199)
//   A3b s_D trajectories (uniform flux, penny) through PRiSM_dfit_acaDiag
//   A4  F_R/F_Rc 0.9538 at 2 t_c; F_L(2 t_c) = 0.5
//   A5  example A (radial): F_R 100–300 h p_r and kh/μ, 20–300 h reads high, bracket contains 4,500 from 1.2 t_c
//   A6  example B (tight, linear): F_L 5–30 h p_r and k from CL, centroid impulse k, F_R / F_L line sides
//   A7  trend bounds and the k interval of example B
//   A8  origin table (since closure −0.52 / −0.65; centroid within 3 % from 3 t_c)
//   A9  gas: p_i converges in ≤ 3 passes, late radial kh/μ_i within 2 % at 5,000 psi
//   A10–A12 constant-rate transform and the model-library match (infiniteFrac on B, BIC → homogeneous on A late data)
//   A13, A13b, A14, A14b, A14c, A15  leak budget rule and leak plot (A14c: not separable → no corrected p_i; default window)
//   A16 p_i labels; A17 gas details; A18 the uniform-flux hump is not storage; A19 a storage case withholds the lines
//   A20 PRiSM_dfit_pipeline sync = job, fast mode; A21 summarise passes checkShape; A22 the Δp_CL convention
//
// Examples A and B are built inline from the closed-form Carter-source convolution of the uniform-flux impulse kernel
// (pD′ = (√(πtD)/2)·erf(1/(2√tD))), independently of 57's own kernels; example B is checked against the committed
// prototype columns of _dfit-shapes (EXB via FIX.aca). Example A's parameters are not in the plan: it is example B with
// k = 1 md (kh/μ = 50 md·ft/cp).
'use strict';

const S = require('./_dfit-shapes');

const WP = 'DF3';
const near = (assert, a, b, tol, what) => assert(typeof a === 'number' && isFinite(a) && Math.abs(a - b) <= tol, what + ': ' + a + ' vs ' + b + ' (± ' + tol + ')');
const rel = (assert, a, b, f, what) => near(assert, a, b, Math.abs(b) * f, what);
function app0(ctx) { const a = S.sharedApp(ctx); S.resetDfit(a); return a; }

// ── independent generator ──
function erfT(x) {                    // Abramowitz–Stegun 7.1.26 refined by one Newton step on the Chebyshev form
  const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? 1 - r : r - 1;
}
function glNodes(n) {
  const x = [], w = [];
  for (let i = 1; i <= n; i++) {
    let z = Math.cos(Math.PI * (i - 0.25) / (n + 0.5)), z1, pp;
    do { let p1 = 1, p2 = 0; for (let j = 1; j <= n; j++) { const p3 = p2; p2 = p1; p1 = ((2 * j - 1) * z * p2 - (j - 1) * p3) / j; } pp = n * (z * p1 - p2) / (z * z - 1); z1 = z; z = z1 - p1 / pp; } while (Math.abs(z - z1) > 1e-15);
    x.push(z); w.push(2 / ((1 - z * z) * pp * pp));
  }
  return { x, w };
}
const GL = glNodes(48);
const ETA = 0.0002637;
const EXB_P = { V: 15, tc: 2, te: 5 / 60, k: 0.01, h: 40, mu: 0.8, phi: 0.12, ct: 1.2e-5, L: 50, pi: 4500 };
const EXA_P = Object.assign({}, EXB_P, { k: 1 });
function impUF(t, P) { const tD = ETA * P.k * t / (P.phi * P.mu * P.ct * P.L * P.L); return 24 * P.V * 141.2 * P.mu / (P.k * P.h) * 0.5 * Math.sqrt(Math.PI * tD) * erfT(1 / (2 * Math.sqrt(tD))) / t; }
function pdUF(tD) { // pD with the E1 term by series / continued fraction
  const x = 1 / (4 * tD); let e1;
  if (x <= 1) { let s = 0, term = 1; for (let k = 1; k < 40; k++) { term *= -x / k; s += -term / k; } e1 = -0.5772156649 - Math.log(x) + s; }
  else { let b = x + 1, c = 1e300, d = 1 / b, h = d; for (let i = 1; i < 200; i++) { const an = -i * i; b += 2; d = 1 / (an * d + b); c = b + an / c; const del = c * d; h *= del; if (Math.abs(del - 1) < 1e-15) break; } e1 = h * Math.exp(-x); }
  return Math.sqrt(Math.PI * tD) * erfT(1 / (2 * Math.sqrt(tD))) + 0.5 * e1;
}
function rateUF(t, P) { return 141.2 * P.mu / (P.k * P.h) * pdUF(ETA * P.k * t / (P.phi * P.mu * P.ct * P.L * P.L)); }
function carterT(f, t, tc) { let s = 0; const N = 8; for (let k = 0; k < N; k++) { const a = k / N, b = (k + 1) / N; for (let i = 0; i < GL.x.length; i++) { const u = (a + b) / 2 + (b - a) / 2 * GL.x[i]; s += (b - a) / 2 * GL.w[i] * f(t - tc * u * u); } } return s; }
// after-closure record on the injection clock, log-spaced from 1.02 t_c to tEnd; optional leak (bbl/d, from t = 0), drift (psi/d), noise
function mkData(P, o) {
  o = o || {};
  const n = o.n || 220, t0 = P.tc * 1.02, tEnd = o.tEnd || 300, t = [], p = [];
  const r = o.sigma ? S.rng(o.seed || 1) : null;
  const g = () => { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
  for (let i = 0; i < n; i++) {
    const ti = t0 * Math.pow(tEnd / t0, i / (n - 1));
    let pv = P.pi + carterT((x) => impUF(x, P), ti, P.tc);
    if (o.leak) pv -= o.leak * rateUF(ti, P);
    if (o.drift) pv += o.drift / 24 * (ti - P.tc / 3);
    if (r) pv += o.sigma * g();
    t.push(ti); p.push(pv);
  }
  return { t, p };
}
// a minimal run for PRiSM_dfit_aca: the record starts at the pump start (t = 0), shut-in at t_e, closure at t_c
function mkRun(P, d, o) {
  o = o || {};
  // σ_c 7,520 psia with ISIP 7,600: ½·(ISIP + σ_c) − p_i ≈ m_L of example B (reservoir-controlled leak-off, λ ≈ 1)
  const pre = [], ppre = [], ts = P.te, pc = o.pc || 7520;
  pre.push(0); ppre.push(P.pi);
  for (let i = 1; i <= 10; i++) { pre.push(ts * i / 10); ppre.push(7600 + 3 * i); }
  for (let i = 1; i <= 20; i++) { const tt = ts + (P.tc - ts) * i / 20.5; pre.push(tt); ppre.push(7600 - (7600 - pc) * Math.sqrt(i / 20.5)); }
  const CL = P.V * 5.614583 / (8 * P.h * P.L * Math.sqrt(P.tc * 60));
  return {
    prep: { ok: true, t: pre.concat(d.t), pw: ppre.concat(d.p), sigma: o.sigma || 0, src: 'bh' },
    events: { ok: true, tStart: 0, ts, Vi: P.V, Vfb: 0, VwCwMeasured: 7.9e-4 },
    isip: { ok: true, value: 7600, spread: 5 },
    frac: { chosen: { pClosure: pc, dtc: P.tc - ts, VwCw: 7.9e-4, geometry: { model: 'PKN', byModel: { PKN: { xf: P.L, CL } } } }, byFamily: {} },
    consensus: null,
  };
}
function wellOf(P, extra) { return Object.assign({ mu: P.mu, phi: P.phi, ct: P.ct, h: P.h }, extra || {}); }
const INP = { rock: { hp: 40 }, options: { aca: { origin: 'centroid', LB: 0.25, carterExactFR: false, tideRemove: 'off' } } };

// ── fake engines for the pipeline tests (WP2 / WPT / WP1 not merged: stubs installed on the shared app, §2.12 rule 4) ──
function installFakes(win, F) {
  const saved = {};
  const set = (k, fn) => { saved[k] = win[k]; win[k] = fn; };
  const R = F.run;
  set('PRiSM_dfit_prepare', () => JSON.parse(JSON.stringify(R.prep)));
  set('PRiSM_dfit_events', () => JSON.parse(JSON.stringify(R.events)));
  set('PRiSM_dfit_derivs', () => JSON.parse(JSON.stringify(R.derivs)));
  set('PRiSM_dfit_isip', () => JSON.parse(JSON.stringify(R.isip)));
  set('PRiSM_dfit_closurePicks', () => JSON.parse(JSON.stringify(R.picks)));
  set('PRiSM_dfit_consensus', () => JSON.parse(JSON.stringify(R.consensus)));
  set('PRiSM_dfit_consensusJob', () => { let k = 0; return { step: () => { k++; return { done: k >= 3, progress: k / 3, label: 'grid' }; }, result: () => JSON.parse(JSON.stringify(R.consensus)), cancel() {} }; });
  set('PRiSM_dfit_consensusLite', () => JSON.parse(JSON.stringify(R.consensusLite)));
  set('PRiSM_dfit_classify', () => JSON.parse(JSON.stringify(R.classification)));
  set('PRiSM_dfit_frac', (pc, d, c) => { const o = F.ref.chain(pc, { family: c && c.family || null, method: c && c.method || null }); return o; });
  set('PRiSM_dfit_whatIf', (cands) => cands.map((c) => Object.assign({ label: c.label }, F.ref.chain(c.p, { family: c.family || null, method: c.method || null }))));
  set('PRiSM_dfit_triage', () => JSON.parse(JSON.stringify(R.triage)));
  set('PRiSM_dfit_grade', () => JSON.parse(JSON.stringify(R.grade)));
  return () => Object.keys(saved).forEach((k) => { win[k] = saved[k]; });
}

module.exports = [
  {
    name: 'A1 constants from first principles (250,856, 4,181, 1,694.5, 97.54, 29,437, 845.50 / 109.15, 1.1827e-3, 2.63679e-4)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const K = app0(ctx).win.PRiSM_dfit_acaKernels.K, chi = 16 / (Math.PI * Math.PI), bbl = 5.614583, eta = K.etaC;
      near(assert, eta, 2.63679e-4, 1e-9, 'η_c');
      rel(assert, bbl / (4 * Math.PI * eta), K.rad, 1e-3, 'radial 1,694.5 = 5.6146/(4π·η_c)');
      rel(assert, 24 * 141.2 / 2, K.rad, 1e-3, 'radial = 24·70.6');
      rel(assert, bbl / Math.sqrt(4 * Math.PI * eta), K.lin, 1e-3, 'linear 97.54');
      rel(assert, bbl / Math.pow(4 * Math.PI * eta, 1.5), K.sph, 1e-3, 'spherical 29,437');
      rel(assert, 4 * K.rad / chi, K.khmuH, 1e-3, '4,181 = 4·1,694.5/χ');
      rel(assert, 60 * K.khmuH, 250856, 1e-3, '250,856 (t_c in min)');
      rel(assert, K.lin * Math.PI / 2 * 4 * Math.sqrt(60) / bbl, K.mLmin, 1e-3, 'm_L 845.5 (CL ft/√min)');
      rel(assert, K.mLmin / Math.sqrt(60), 109.15, 1e-3, '109.15 (ft/√h)');
      rel(assert, 1 / K.mLmin, 1.1827e-3, 1e-3, '1.1827e-3');
      [K.rad, K.lin, K.sph, K.khmuH, K.khmuMin, K.mLmin, K.mLh, K.invmL].forEach((v) => assert(v > 0, 'positive constant'));
      rel(assert, K.khmuMin, 250856, 1e-6, 'khmuMin');
    },
  },
  {
    name: 'A2 Nolte vs impulse: exact Carter radial = m_R·F_Rc; F_R vs centroid impulse within 0.1 % late; Carter linear = m_L·F_L with V = 8·CL·h·L·√t_c',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win, K = win.PRiSM_dfit_acaKernels, tc = 2, V = 15, mu = 0.8, kh = 40, k = 0.01, phi = 0.12, ct = 1.2e-5, h = 40, L = 50;
      const mR = K.K.khmuH * V / ((kh / mu) * tc);
      [1.3, 2, 5, 20].forEach((f) => {
        const t = f * tc, dpC = K.carter((x) => K.K.rad * V * mu / (kh * x), t, tc, 8), FRc = win.PRiSM_dfit_timeFns([t], tc).FRc[0];
        rel(assert, dpC, mR * FRc, 1e-4, 'Carter radial at ' + f + ' t_c = m_R·F_Rc');
      });
      [10, 30, 100].forEach((f) => {
        const t = f * tc, tf = win.PRiSM_dfit_timeFns([t], tc);
        rel(assert, mR * tf.FRc[0], K.K.rad * V * mu / (kh * (t - tc / 3)), 1e-3, 'Nolte radial (F_Rc) vs the centroid impulse at ' + f + ' t_c');
        assert(tf.FR[0] < tf.FRc[0] && tf.FR[0] / tf.FRc[0] > 0.98, 'F_R (log form) approaches F_Rc from below late: ' + tf.FR[0] / tf.FRc[0]);
      });
      const r100 = win.PRiSM_dfit_timeFns([200], 2);
      assert(r100.FR[0] / r100.FRc[0] > 0.998, 'F_R/F_Rc at 100 t_c > 0.998');
      const CL = V * 5.614583 / (8 * h * L * Math.sqrt(tc * 60)), A = 2 * L * h;
      const mL = K.K.mLmin * CL * Math.sqrt(mu / (k * phi * ct));
      [1.2, 2, 10, 100].forEach((f) => {
        const t = f * tc, dpC = K.carter((x) => K.K.lin * (V / A) * Math.sqrt(mu / (k * phi * ct)) / Math.sqrt(x), t, tc, 16);
        rel(assert, dpC, mL * win.PRiSM_dfit_timeFns([t], tc).FL[0], 1e-3, 'Carter linear at ' + f + ' t_c = m_L·F_L');
      });
    },
  },
  {
    name: 'A3 kernel slopes: uniform flux −0.950 at t_DL 1.60 and −0.980 at 4.10; penny −1.00 at ηt/R² 0.199',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const K = app0(ctx).win.PRiSM_dfit_acaKernels;
      const sl = (f, x) => { const e = 1e-4; return (Math.log(f(x * Math.exp(e))) - Math.log(f(x * Math.exp(-e)))) / (2 * e); };
      near(assert, sl(K.ufShape, 1.6), -0.950, 0.002, 'uniform flux Δp slope at 1.60');
      near(assert, sl(K.ufShape, 4.1), -0.980, 0.002, 'uniform flux Δp slope at 4.10');
      near(assert, sl(K.pennyShape, 0.199), -1.00, 0.002, 'penny Δp slope at 0.199');
      near(assert, sl(K.ufShape, 0.01), -0.5, 0.002, 'uniform flux early slope −½');
    },
  },
  {
    name: 'A3b s_D trajectories through PRiSM_dfit_acaDiag (uniform flux −0.50 … −0.30 max at 0.10 … −0.90 at 1.6 … −0.93 at 2.32; penny −1.0 at 0.39, −1.1 at 0.49)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win, K = win.PRiSM_dfit_acaKernels;
      const grid = (f, a, b, n) => { const t = [], p = []; for (let i = 0; i < n; i++) { const x = a * Math.pow(b / a, i / (n - 1)); t.push(x); p.push(1000 + 100 * f(x)); } return { t, p }; };
      const at = (dg, x) => { let best = 0; dg.x.forEach((v, i) => { if (Math.abs(Math.log(v / x)) < Math.abs(Math.log(dg.x[best] / x))) best = i; }); return dg.sD[best]; };
      const u = grid(K.ufShape, 0.003, 30, 1600), du = win.PRiSM_dfit_acaDiag(u.t, u.p, { t0: 0, LB: 0.02 });
      assert(du.ok !== false, 'diag ok');
      [[0.01, -0.50], [0.03, -0.50], [0.10, -0.30], [1.6, -0.90], [2.32, -0.93], [0.2, -0.43], [0.77, -0.80]].forEach(([x, s]) => near(assert, at(du, x), s, 0.01, 'uniform flux s_D at ' + x));
      let mx = -9, xm = 0; du.sD.forEach((s, i) => { if (s != null && du.x[i] > 0.04 && du.x[i] < 0.5 && s > mx) { mx = s; xm = du.x[i]; } });
      near(assert, mx, -0.30, 0.01, 'hump maximum'); near(assert, Math.log10(xm), -1, 0.1, 'hump maximum at t_DL ≈ 0.10');
      const pn = grid(K.pennyShape, 0.01, 10, 1600), dp = win.PRiSM_dfit_acaDiag(pn.t, pn.p, { t0: 0, LB: 0.02 });
      near(assert, at(dp, 0.39), -1.0, 0.01, 'penny s_D at 0.39'); near(assert, at(dp, 0.49), -1.1, 0.01, 'penny s_D at 0.49');
      near(assert, at(dp, 2.1), -1.4, 0.01, 'penny s_D at 2.1');
    },
  },
  {
    name: 'A4 F_R/F_Rc = 0.9538 at 2 t_c and F_L(2 t_c) = 0.5; carterExact swaps F_R for F_Rc',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win, tf = win.PRiSM_dfit_timeFns([4, 1, 10], 2);
      assert(tf.ok === true, 'timeFns ok');
      near(assert, tf.FR[0] / tf.FRc[0], 0.9538, 2e-4, 'F_R/F_Rc at 2 t_c'); near(assert, tf.FL[0], 0.5, 1e-12, 'F_L(2 t_c)');
      assert(tf.FR[1] === null && tf.FRc[1] === null, 'no F_R before closure');
      const ex = win.PRiSM_dfit_timeFns([4], 2, { carterExact: true });
      near(assert, ex.FR[0], tf.FRc[0], 1e-12, 'carterExact');
      near(assert, win.PRiSM_dfit_centroid({ tcInj: 6 }), 2, 1e-12, 'Carter centroid t_c/3');
      const tau = [], q = []; for (let i = 1; i <= 2000; i++) { const t = 6 * Math.pow(i / 2000, 2); tau.push(t); q.push(1 / Math.sqrt(t)); }
      near(assert, win.PRiSM_dfit_centroid({ tau, qL: q }), 2, 0.02, 'centroid of a 1/√τ history');
    },
  },
  {
    name: 'A5 example A (radial): F_R 100–300 h p_r 4,500.02 ± 0.05, kh/μ 50.5 ± 0.3; 20–300 h reads high; bracket contains 4,500 from 1.2 t_c',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win, P = EXA_P, d = mkData(P);
      const nl = win.PRiSM_dfit_nolte({ tInj: d.t, p: d.p, tcInj: P.tc, V: P.V, radWin: [100, 300], mu: P.mu, h: P.h });
      assert(nl.ok && nl.rad, 'radial line');
      near(assert, nl.rad.pr, 4500.02, 0.05, 'p_r (F_R 100–300 h)'); near(assert, nl.rad.khmu, 50.5, 0.3, 'kh/μ (F_R 100–300 h)');
      const n2 = win.PRiSM_dfit_nolte({ tInj: d.t, p: d.p, tcInj: P.tc, V: P.V, radWin: [20, 300], mu: P.mu, h: P.h });
      assert(n2.rad.khmu > nl.rad.khmu && n2.rad.khmu > 50, 'an earlier window reads kh/μ higher (bias upper): ' + n2.rad.khmu);
      near(assert, n2.rad.khmu, 51.97, 0.6, 'kh/μ (F_R 20–300 h)');
      const dg = win.PRiSM_dfit_acaDiag(d.t, d.p, { t0: P.tc / 3, LB: 0.25 });
      let nIn = 0;
      dg.x.forEach((x, i) => {
        const t = x + P.tc / 3; if (t < 1.2 * P.tc) return;
        if (dg.piLo[i] == null) { assert(t < 2 * P.tc, 'bracket withheld only next to closure (t ' + t.toFixed(2) + ')'); return; }
        nIn++; assert(dg.piLo[i] <= 4500 && 4500 <= dg.piHi[i], 'bracket contains 4,500 at t ' + t.toFixed(2) + ': [' + dg.piLo[i] + ', ' + dg.piHi[i] + ']');
      });
      assert(nIn > 150, 'bracket carried at most points: ' + nIn);
    },
  },
  {
    name: 'A6 example B (tight): F_L 5–30 h p_r 4,500.00 ± 0.05, k 0.0100 ± 1 %; centroid impulse 10–55 h k within 2 %; F_R line above, late F_L line below 4,500',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win, P = EXB_P, d = mkData(P);
      // the generator against the committed prototype columns (FIX.aca = example B)
      const FB = S.FIX.aca;
      [[2.5, 6634.326], [5.70715, 5721.261], [25.2164, 5050.355], [300, 4629.72]].forEach(([t, pw]) => near(assert, P.pi + carterT((x) => impUF(x, P), t, P.tc), pw, 0.02, 'generator vs prototype at ' + t + ' h'));
      near(assert, FB.diag.x[FB.diag.x.length - 1], 300 - 2 / 3, 1e-3, 'fixture clock');
      const CL = P.V * 5.614583 / (8 * P.h * P.L * Math.sqrt(P.tc * 60));
      const nl = win.PRiSM_dfit_nolte({ tInj: d.t, p: d.p, tcInj: P.tc, V: P.V, linWin: [5, 30], CL, mu: P.mu, phi: P.phi, ct: P.ct, h: P.h });
      assert(nl.ok && nl.lin, 'linear line');
      near(assert, nl.lin.pr, 4500.00, 0.05, 'p_r (F_L 5–30 h)'); rel(assert, nl.lin.k, 0.0100, 0.01, 'k from CL');
      const im = win.PRiSM_dfit_impulseLines({ t: d.t, p: d.p, t0: P.tc / 3, V: P.V, win: [10, 55], regime: 'linear', A: 2 * P.L * P.h, mu: P.mu, phi: P.phi, ct: P.ct, h: P.h });
      assert(im.ok && im.group === 'Ask', 'impulse line'); rel(assert, im.k, 0.0100, 0.02, 'centroid impulse k');
      const fr = win.PRiSM_dfit_nolte({ tInj: d.t, p: d.p, tcInj: P.tc, V: P.V, radWin: [3, 10], mu: P.mu, h: P.h });
      assert(fr.rad.pr > 4500, 'F_R line on 3–10 h above 4,500: ' + fr.rad.pr);
      const fl = win.PRiSM_dfit_nolte({ tInj: d.t, p: d.p, tcInj: P.tc, V: P.V, linWin: [20, 300] });
      assert(fl.lin.pr < 4500, 'F_L line on 20–300 h below 4,500: ' + fl.lin.pr);
    },
  },
  {
    name: 'A7 example B trend bounds 0.653 / 0.854 md·ft/cp and an interval [k_lo, k_hi] containing 0.01 md with the 1.6 constant',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win, P = EXB_P, d = mkData(P), t0 = P.tc / 3;
      const dg = win.PRiSM_dfit_acaDiag(d.t, d.p, { t0, LB: 0.25 });
      const im = win.PRiSM_dfit_impulseLines({ t: d.t, p: d.p, t0, V: P.V, win: [6, 40], regime: 'linear', mu: P.mu, phi: P.phi, ct: P.ct, h: P.h });
      const b = win.PRiSM_dfit_acaBounds({ diag: dg, Lmax: 80, Amax: 2 * 80 * P.h, piLo: 4442, piHi: 4500, tEnd: 300, t0,
                                           mImpLin: im.m, phi: P.phi, mu: P.mu, ct: P.ct, h: P.h, V: P.V });
      assert(b.ok, 'bounds ok');
      near(assert, b.trend.khmuPi, 0.653, 0.005, 'trend bound with p_i'); near(assert, b.trend.khmuD, 0.854, 0.008, 'p_i-free trend bound');
      assert(b.kLo <= 0.01 && 0.01 <= b.kHi, 'interval contains 0.01 md: [' + b.kLo + ', ' + b.kHi + ']');
      near(assert, b.kLo, 0.0039, 0.0002, 'k_lo (A_max)'); near(assert, b.kHi, 0.0131, 0.0003, 'k_hi (trend)');
      assert(b.binding.some((x) => x.edge === 'lo' && x.rule === 'linear-Amax') && b.binding.some((x) => x.edge === 'hi' && /trend/.test(x.rule)), 'binding constraints named');
      const rnr = b.candidates.hi.find((x) => x.rule === 'radial-not-reached');
      assert(rnr && rnr.k > 0.01, 'the radial-not-reached bound (1.6 constant) only widens: ' + (rnr && rnr.k));
      near(assert, rnr.k, 1.6 * P.phi * P.mu * P.ct * 6400 / (0.000263679 * (300 - t0)), 1e-9, '1.6·φμc_t·L²/(η_c·t′)');
    },
  },
  {
    name: 'A8 origin table: since closure −0.52 at 1.5 t_c and −0.65 at 2 t_c; the centroid origin within 3 % from 3 t_c',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const K = app0(ctx).win.PRiSM_dfit_acaKernels;
      near(assert, K.originSlope('sinceClosure', 1.5), -0.52, 0.005, 'since closure at 1.5 t_c');
      near(assert, K.originSlope('sinceClosure', 2), -0.65, 0.005, 'since closure at 2 t_c');
      [3, 5, 10, 30].forEach((f) => assert(Math.abs(K.originSlope('centroid', f) + 1) <= 0.03, 'centroid within 3 % at ' + f + ' t_c: ' + K.originSlope('centroid', f)));
      assert(Math.abs(K.originSlope('total', 3) + 1) > Math.abs(K.originSlope('centroid', 3) + 1), 'total time is worse than the centroid at 3 t_c');
    },
  },
  {
    name: 'A9 gas: p_i converges in ≤ 3 passes and the late radial kh/μ_i changes < 2 % at 5,000 psi',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      // gas-consistent data: the liquid kernels hold in the adjusted variables (p_a, t_a) at p_i = 5,000 psia; the record is
      // mapped back to real p (pseudo-pressure inverse) and real t (pseudo-time inverse, fixed point) before the analysis
      const win = app0(ctx).win, P = Object.assign({}, EXA_P, { pi: 5000 }), d = mkData(P), adj = mkRun(P, d, { pc: 7500 });
      const T_F = 200, SG_g = 0.65, ct = 1.2e-5, tbl = win.PRiSM_mpTable({ T_F, SG_g, pi: 5000, pmax: 9500 });
      const mi = tbl.mOf(5000), dm = (tbl.mOf(5000.5) - tbl.mOf(4999.5));
      const ta = adj.prep.t.slice(1), pReal = adj.prep.pw.slice(1).map((pa) => tbl.pOf(mi + (pa - 5000) * dm));
      let tr = ta.slice();
      for (let it = 0; it < 30; it++) {
        const r = win.PRiSM_gasPseudoTime(tr, pReal, { T_F, SG_g, pNorm: 5000, p0: pReal[0], ct });
        assert(r.ok, 'pseudo-time');
        tr = tr.map((t, i) => t * ta[i] / r.ta[i]);
      }
      const itp = (xs, ys, x) => { let i = 1; while (i < xs.length - 1 && xs[i] < x) i++; return ys[i - 1] + (x - xs[i - 1]) / (xs[i] - xs[i - 1]) * (ys[i] - ys[i - 1]); };
      const tsR = itp(ta, tr, P.te), tcR = itp(ta, tr, P.tc);
      const real = JSON.parse(JSON.stringify(adj));
      real.prep.t = [0].concat(tr); real.prep.pw = [adj.prep.pw[0]].concat(pReal);
      real.events.ts = tsR; real.frac.chosen.dtc = tcR - tsR;
      const liq = win.PRiSM_dfit_aca(adj, { well: wellOf(P), inputs: INP });
      const gas = win.PRiSM_dfit_aca(real, { well: wellOf(P, { fluid: 'gas', T_F, SG_g }), inputs: INP });
      assert(liq.ok && gas.ok, 'both runs ok: ' + JSON.stringify(gas.errors || ''));
      assert(gas.gas && gas.gas.iterations <= 3 && gas.gas.converged === true, 'converged in ≤ 3 passes: ' + JSON.stringify(gas.gas));
      assert(liq.kh && gas.kh, 'late radial kh/μ in both');
      rel(assert, gas.kh.khmu, liq.kh.khmu, 0.02, 'kh/μ_i (gas, adjusted variables) vs the liquid analysis of the adjusted record');
      near(assert, gas.pi.value, 5000, 3, 'gas p_i');
      assert(gas.warnings.some((w) => /water invasion/.test(w.text)), 'effective gas permeability label');
      assert(S.checkShape('AcaResult', gas).ok, 'gas AcaResult shape: ' + JSON.stringify(S.checkShape('AcaResult', gas).errors.slice(0, 3)));
    },
  },
  {
    name: 'A10 the constant-rate transform reproduces 1,694.5 on example A late data (± 0.5 %)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win, P = EXA_P, d = mkData(P), cr = win.PRiSM_dfit_crTransform(d.t, d.p, { t0: P.tc / 3, V: P.V, pi: P.pi });
      assert(cr.ok, 'transform ok');
      const late = cr.t.map((x, i) => [x, cr.y[i], cr.yPiFree[i]]).filter((r) => r[0] >= 200);
      const y = late.reduce((a, r) => a + r[1], 0) / late.length, khmu = P.k * P.h / P.mu;
      rel(assert, 24 * y * khmu, 1694.5, 0.005, 'flat y = 70.6·μ/(kh): 24·y·kh/μ');
      const yp = late.reduce((a, r) => a + r[2], 0) / late.length;
      rel(assert, 24 * yp * khmu, 1694.5, 0.02, 'p_i-free form');
    },
  },
  {
    name: 'A11 infiniteFrac match on example B recovers k 0.0100 ± 5 % and L 50 ± 10 ft and keeps p_i inside the bracket',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win, P = EXB_P, d = mkData(P), br = [4442, 4524];
      const m = win.PRiSM_dfit_acaMatch({ t: d.t, p: d.p, t0: P.tc / 3, V: P.V, mu: P.mu, phi: P.phi, ct: P.ct, h: P.h, tcInj: P.tc, kInit: 0.003, LInit: 80 }, { models: ['infiniteFrac'], piBracket: br });
      assert(m.ok, 'match ok: ' + JSON.stringify(m.errors || ''));
      rel(assert, m.best.k, 0.0100, 0.05, 'k'); near(assert, m.best.L, 50, 10, 'L');
      assert(m.best.pi >= br[0] && m.best.pi <= br[1], 'p_i inside the bracket: ' + m.best.pi);
      const j = win.PRiSM_dfit_acaMatchJob({ t: d.t, p: d.p, t0: P.tc / 3, V: P.V, mu: P.mu, phi: P.phi, ct: P.ct, h: P.h, tcInj: P.tc, kInit: 0.003, LInit: 80 }, { models: ['infiniteFrac'], piBracket: br });
      let g = 0; while (!j.step().done && g++ < 10);
      near(assert, j.result().best.k, m.best.k, 1e-12, 'job = sync');
    },
  },
  {
    name: 'A12 BIC picks homogeneous on example A late data',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win, P = EXA_P, d = mkData(P, { sigma: 0.02, seed: 3 });
      const late = { t: [], p: [] }; d.t.forEach((t, i) => { if (t >= 150) { late.t.push(t); late.p.push(d.p[i]); } });
      const m = win.PRiSM_dfit_acaMatch({ t: late.t, p: late.p, t0: P.tc / 3, V: P.V, mu: P.mu, phi: P.phi, ct: P.ct, h: P.h, tcInj: P.tc, kInit: 0.5, LInit: 50 }, { models: ['homogeneous', 'infiniteFrac'], piBracket: [4490, 4510] });
      assert(m.ok, 'match ok: ' + JSON.stringify(m.errors || ''));
      assert(m.best.model === 'homogeneous', 'BIC picks homogeneous: ' + JSON.stringify(m.candidates));
      rel(assert, m.best.k, 1.0, 0.05, 'k from the homogeneous match');
    },
  },
  {
    name: 'A13 leak budget: the linear rule q_k,max = ε·V/(Θ·t) matches the simulated bias within 15 %',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const K = app0(ctx).win.PRiSM_dfit_acaKernels, P = EXB_P, tEnd = 30;
      const qk = K.qkMax(0.05, P.V, 2, tEnd);
      near(assert, K.qkMax(0.05, 25, 2, 300), 0.05, 1e-9, 'reference: 25 bbl, 300 h → 0.050 bbl/d');
      const dp0 = carterT((x) => impUF(x, P), tEnd, P.tc), bias = qk * rateUF(tEnd, P) / dp0;
      rel(assert, bias, 0.05, 0.15, 'simulated relative bias at q_k,max');
    },
  },
  {
    name: 'A13b radial: Θ(t_DL 5) = 4.509 ± 1 % and the simulated bias of 0.02 bbl/d equals Θ·q_k·t/V within 15 %',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const K = app0(ctx).win.PRiSM_dfit_acaKernels, P = EXA_P;
      rel(assert, K.theta(5), 4.509, 0.01, 'Θ(5)');
      near(assert, K.theta(0.05), 2.0, 0.02, 'Θ → 2 in linear flow');
      const t = 5 * P.L * P.L * P.phi * P.mu * P.ct / (ETA * P.k), q = 0.02;
      const bias = q * rateUF(t, P) / carterT((x) => impUF(x, P), t, P.tc);
      rel(assert, bias, K.theta(5) * (q / 24) * t / P.V, 0.15, 'simulated bias vs Θ·q_k·t/V');
    },
  },
  {
    name: 'A14 the leak plot recovers 0.07 bbl/d within ± 0.02 after the baseline and reports the floor',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win, P = EXB_P, wl = wellOf(P);
      const base = win.PRiSM_dfit_aca(mkRun(P, mkData(P, { sigma: 0.01, seed: 5 }), { sigma: 0.01 }), { well: wl, inputs: INP });
      const leak = win.PRiSM_dfit_aca(mkRun(P, mkData(P, { sigma: 0.01, seed: 5, leak: 0.07 }), { sigma: 0.01 }), { well: wl, inputs: INP });
      assert(base.ok && leak.ok, 'aca ok');
      const o = { win: [5, 30], driftSpec: 0.02, sigma: 0.01, seed: 1, nBoot: 80 };
      const lb = win.PRiSM_dfit_leakPlot(base, o), ll = win.PRiSM_dfit_leakPlot(leak, o);
      assert(lb.ok && ll.ok, 'leak plots ok: ' + JSON.stringify(ll.errors || ''));
      assert(S.checkShape('LeakPlot', ll).ok, 'LeakPlot shape: ' + JSON.stringify(S.checkShape('LeakPlot', ll).errors.slice(0, 3)));
      near(assert, ll.qk - lb.qk, 0.07, 0.02, 'q_k after the baseline');
      assert(ll.floor >= 0 && isFinite(ll.floor) && /floor/.test(ll.windowBiasNote), 'floor reported: ' + ll.floor);
      assert(ll.form === 'linear' && ll.theta === 2 && ll.qkMax > 0, 'linear form, Θ 2, q_k,max');
      assert(ll.qkCI[0] <= ll.qk && ll.qk <= ll.qkCI[1], 'interval brackets q_k');
    },
  },
  {
    name: 'A14b drift only (d at the spec, no leak): the verdict is none, below-floor or leak-or-drift — never leak',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win, P = EXB_P, wl = wellOf(P);
      [1, 2, 3].forEach((seed) => {
        const aca = win.PRiSM_dfit_aca(mkRun(P, mkData(P, { sigma: 0.01, seed, drift: 0.02 }), { sigma: 0.01 }), { well: wl, inputs: INP });
        const lp = win.PRiSM_dfit_leakPlot(aca, { win: [5, 30], driftSpec: 0.02, sigma: 0.01, seed, nBoot: 60 });
        assert(lp.ok && lp.verdict !== 'leak', 'seed ' + seed + ': verdict ' + lp.verdict + ' (q_k ' + lp.qk + ', floor ' + lp.floor + ')');
      });
    },
  },
  {
    name: 'A14c not separable (corr(B, d) > 0.95): leak or drift, no corrected p_i (piCorr = piUncorr); the default window starts at t′ ≥ 2 t_c',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win, P = EXB_P;
      const aca = win.PRiSM_dfit_aca(mkRun(P, mkData(P, { sigma: 0.01, seed: 3, leak: 0.2, drift: 0.05 }), { sigma: 0.01 }), { well: wellOf(P), inputs: INP });
      // a weak drift prior (1 psi/d) over a short window: B and d are collinear
      const lp = win.PRiSM_dfit_leakPlot(aca, { win: [5, 30], driftSpec: 1, sigma: 0.01, seed: 1, nBoot: 20 });
      assert(lp.ok && S.checkShape('LeakPlot', lp).ok, 'leak plot ok and shaped');
      assert(lp.separable === false && Math.abs(lp.corrBd) > 0.95, 'not separable: corr ' + lp.corrBd);
      assert(lp.verdict === 'leak-or-drift', 'verdict leak or drift: ' + lp.verdict);
      assert(lp.piCorr === lp.piUncorr, 'no corrected p_i is offered: ' + lp.piCorr + ' vs ' + lp.piUncorr);
      assert(/not separable/.test(lp.windowBiasNote) && /no leak correction/.test(lp.windowBiasNote), 'the note says so: ' + lp.windowBiasNote);
      const d = win.PRiSM_dfit_leakPlot(aca, { driftSpec: 0.02, sigma: 0.01, seed: 1, nBoot: 0 });
      assert(d.ok, 'default window ok');
      const tMin = Math.min.apply(null, d.piCorrSeries.t);
      assert(tMin - aca.t0 >= 2 * aca.tcInj - 1e-9, 'default window t′ ≥ 2 t_c: t′_min ' + (tMin - aca.t0) + ' vs ' + 2 * aca.tcInj);
    },
  },
  {
    name: 'A15 the leak-corrected p_i lies within 10 psi of the truth at 0.2 bbl/d',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win, P = EXB_P;
      const aca = win.PRiSM_dfit_aca(mkRun(P, mkData(P, { sigma: 0.01, seed: 7, leak: 0.2 }), { sigma: 0.01 }), { well: wellOf(P), inputs: INP });
      const lp = win.PRiSM_dfit_leakPlot(aca, { win: [5, 30], driftSpec: 0.02, sigma: 0.01, seed: 1, nBoot: 60 });
      assert(lp.ok, 'leak plot ok');
      near(assert, lp.piCorr, 4500, 10, 'corrected p_i'); assert(Math.abs(lp.piCorr - 4500) < Math.abs(lp.piUncorr - 4500), 'better than the uncorrected ' + lp.piUncorr);
      assert(lp.verdict === 'leak' || lp.verdict === 'leak-or-drift', 'a 0.2 bbl/d leak is seen: ' + lp.verdict);
    },
  },
  {
    name: 'A16 p_i labels: high on example A, medium on example B at 300 h',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win;
      const a = win.PRiSM_dfit_aca(mkRun(EXA_P, mkData(EXA_P)), { well: wellOf(EXA_P), inputs: INP });
      const b = win.PRiSM_dfit_aca(mkRun(EXB_P, mkData(EXB_P)), { well: wellOf(EXB_P), inputs: INP });
      [a, b].forEach((r, i) => { assert(r.ok === true, 'aca ' + i + ' ok'); const sh = S.checkShape('AcaResult', r); assert(sh.ok, 'AcaResult shape ' + i + ': ' + JSON.stringify(sh.errors.slice(0, 4))); });
      assert(a.pi.label === 'high', 'example A p_i label high: ' + a.pi.label + ' ' + JSON.stringify(a.pi.reasons));
      assert(b.pi.label === 'medium', 'example B p_i label medium: ' + b.pi.label);
      near(assert, a.pi.value, 4500, 3, 'example A p_i'); near(assert, b.pi.value, 4500, 5, 'example B p_i');
      assert(a.regimeSummary === 'radial' || a.regimeSummary === 'linear-radial', 'example A reaches radial flow: ' + a.regimeSummary);
      assert(b.regimeSummary === 'linear' && b.kh === null && b.bounds && b.bounds.kLo <= 0.01 && 0.01 <= b.bounds.kHi, 'example B: linear only, bounds contain 0.01 md');
      rel(assert, a.kh.khmu, 50, 0.04, 'example A kh/μ'); assert(a.kh.biasDirection === 'upper', 'bias direction');
    },
  },
  {
    name: 'A17 gas details: p_a(p_i) = p_i (intercepts in psia) and k_lo at the lower bracket edge ≤ k_lo at the upper edge',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win, K = win.PRiSM_dfit_acaKernels, well = { T_F: 200, SG_g: 0.65 };
      const t = [0.5, 1, 2, 4, 8], p = [7000, 6000, 5000, 5200, 4800];
      const g = win.PRiSM_dfit_gasAdjust(t, p, { pi: 5000, T_F: 200, SG_g: 0.65, ct: 1.2e-5 });
      assert(g.ok, 'gas adjust ok: ' + JSON.stringify(g.errors || ''));
      near(assert, g.pa[2], 5000, 1e-6, 'p_a(p_i) = p_i');
      assert(g.pa[0] > 5000 && g.pa[4] < 5000 && g.ta.every((x, i) => i === 0 || x > g.ta[i - 1]), 'monotone p_a and t_a');
      const P = EXB_P, d = mkData(P), dg = win.PRiSM_dfit_acaDiag(d.t, d.p, { t0: P.tc / 3, LB: 0.25 });
      const props = (pp) => { const r = K.gasProps(pp, well); return { mu: r.mu, ct: 1.2e-5 }; };
      const kAt = (piLo) => win.PRiSM_dfit_acaBounds({ diag: dg, CL: 4.8e-4, pMidHi: 7300, piLo, tEnd: 300, t0: P.tc / 3, phi: P.phi, mu: P.mu, ct: P.ct, h: P.h, V: P.V, props })
        .candidates.lo.find((x) => x.rule === 'leakoff-limit').k;
      const lo = kAt(4442), hi = kAt(4524);
      assert(lo <= hi, 'k_lo at the lower edge ' + lo + ' ≤ at the upper edge ' + hi);
      assert(K.gasProps(4442, well).mu < K.gasProps(4524, well).mu, 'gas μ rises with p');
    },
  },
  {
    name: 'A18 the uniform-flux hump (t_DL 0.06–0.18) is not storage, the bracket contains p_i through it, and piPoint is null there',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win, K = win.PRiSM_dfit_acaKernels, pi = 4500;
      const t = [], p = []; for (let i = 0; i < 500; i++) { const x = 0.005 * Math.pow(2000, i / 499); t.push(x); p.push(pi + 300 * K.ufShape(x)); }
      const dg = win.PRiSM_dfit_acaDiag(t, p, { t0: 0, LB: 0.25 });
      assert(dg.storage === false && !dg.regimes.some((r) => r.kind === 'storage'), 'not called storage');
      let n = 0;
      dg.x.forEach((x, i) => {
        if (x < 0.06 || x > 0.18) return;
        n++;
        assert(dg.piLo[i] != null && dg.piLo[i] <= pi && pi <= dg.piHi[i], 'bracket contains p_i at t_DL ' + x.toFixed(3));
        assert(dg.piPoint[i] === null, 'no point estimate in the hump at t_DL ' + x.toFixed(3));
      });
      assert(n > 20, 'hump points: ' + n);
      assert(dg.piPoint.some((v, i) => v != null && dg.x[i] < 0.03), 'point estimates exist in pure linear flow');
      assert(S.checkShape('AcaDiag', dg).ok, 'AcaDiag shape');
    },
  },
  {
    name: 'A19 a storage case (s_D > −0.4 before any −0.5 segment) is called storage and the lines are withheld',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win, P = EXB_P, d = { t: [], p: [] };
      for (let i = 0; i < 200; i++) { const t = P.tc * 1.02 * Math.pow(300 / (P.tc * 1.02), i / 199); d.t.push(t); d.p.push(4500 + 900 * Math.pow(t - P.tc / 3, -0.22)); }
      const r = win.PRiSM_dfit_aca(mkRun(P, d), { well: wellOf(P), inputs: INP });
      assert(r.ok === true, 'aca ok');
      assert(r.regimeSummary === 'storage', 'storage: ' + r.regimeSummary);
      assert(r.nolte.lin === null && r.nolte.rad === null && r.impulse.lin === null && r.impulse.rad === null, 'lines withheld');
      assert(r.pi.label === 'low' && r.pi.reasons.some((x) => /storage/.test(x)), 'p_i label low with the storage reason');
      assert(r.warnings.some((w) => w.code === 'ACA_STORAGE'), 'storage warning');
    },
  },
  {
    name: 'A20 PRiSM_dfit_pipeline sync = job on FIX.ds; opts.fast skips the grid and the uncertainty (counts) [fake 56 engines]',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win, F = S.FIX, restore = installFakes(win, F);
      try {
        const inputs = F.state.tests[0].inputs, well = { mu: 0.5, phi: 0.06, ct: 1e-5, h: 40, fluid: 'water' }, picks = F.state.tests[0].picks;
        const o = { seed: 1, uncN: 200, at: '2026-11-07T10:00:00Z' };
        const a = win.PRiSM_dfit_pipeline(F.ds, inputs, well, picks, o);
        assert(a.ok === true, 'pipeline ok: ' + JSON.stringify(a.errors || a.warnings));
        const sh = S.checkShape('DfitRun', a); assert(sh.ok, 'DfitRun shape: ' + JSON.stringify(sh.errors.slice(0, 6)));
        const job = win.PRiSM_dfit_pipelineJob(F.ds, inputs, well, picks, o);
        let n = 0, last = null; while (!(last = job.step()).done && n++ < 200) assert(last.progress >= 0 && last.progress <= 1, 'progress');
        assert(n > 3, 'the job has several work units: ' + n);
        const b = job.result();
        assert.deepStrictEqual(JSON.parse(JSON.stringify(b)), JSON.parse(JSON.stringify(a)), 'job result = sync result');
        const f = win.PRiSM_dfit_pipeline(F.ds, inputs, well, picks, Object.assign({}, o, { fast: true }));
        assert(f.ok === true && f.fast === true && f.unc === null && f.consensus === null && f.counts.draws === 0, 'fast: no grid, no uncertainty');
        assert(a.counts.draws === 200 && a.unc && a.unc.n === 200, 'full run draws ' + a.counts.draws);
        assert(S.checkShape('DfitRun', f).ok, 'fast DfitRun shape: ' + JSON.stringify(S.checkShape('DfitRun', f).errors.slice(0, 4)));
        assert(a.dsHash === S.dsHash(F.ds) && a.inputsHash === S.inputHash(win.PRiSM_dfit_inputRanges.clamp(inputs).inputs) && a.picksHash === S.picksHash(picks), 'frozen hash definitions');
        const c = job; c.cancel(); assert(c.step().done === true, 'cancel ends the job');
      } finally { restore(); }
    },
  },
  {
    name: 'A21 PRiSM_dfit_summarise(FIX.run) passes checkShape and keeps the frozen resultHash definition',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win, run = S.FIX.run;
      const s = win.PRiSM_dfit_summarise(run, { at: '2026-11-07T10:00:00Z' });
      const sh = S.checkShape('Summary', s); assert(sh.ok, 'Summary shape: ' + JSON.stringify(sh.errors.slice(0, 5)));
      assert(s.resultHash === S.resultHash(s), 'resultHash = hash16(canon(result fields, display))');
      assert(s.closure.mode === 'single' && s.closure.value === run.consensus.value && s.isip.value === run.isip.value, 'closure and ISIP');
      assert(s.pi.value === run.aca.pi.value && s.triage === 'green' && s.grade === 'A', 'p_i, triage, grade');
      assert(s.gdpdgN.x.length <= 60 && s.gdpdgN.x.length > 10, 'normalised G·dP/dG ≤ 60 points');
      const r2 = S.FIX.run; r2.consensus.mode = 'range'; r2.consensus.value = null; r2.consensus.confidence = 'medium';
      r2.consensus.range = { lo: 6495, hi: 7004, medians: { low: 6507, high: 6998 }, lowFamily: 'F2', highFamily: 'F1' };
      const s2 = win.PRiSM_dfit_summarise(r2, { at: '2026-11-07T10:00:00Z' });
      assert(S.checkShape('Summary', s2).ok && s2.closure.mode === 'range' && s2.closure.value === null && s2.closure.lo === 6495, 'range summary');
    },
  },
  {
    name: 'A22 the Δp_CL convention ½·(ISIP + σ_c) − p_r is identical in frac.kBefore, acaBounds and the leak-off model report',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win, run = S.FIX.run, F = S.FIX;
      const c = run.frac.chosen, pr = F.ref.REF.pr;
      const conv = 0.5 * (run.isip.value + c.pClosure) - pr;
      near(assert, c.kBefore.kCL.dpCL, conv, 0.05, 'frac.kBefore.kCL.dpCL');
      near(assert, F.samples.LkResult.dpCL, conv, 0.05, 'leak-off model report dpCL');
      const d = mkData(EXB_P), dg = win.PRiSM_dfit_acaDiag(d.t, d.p, { t0: 2 / 3 });
      const b = win.PRiSM_dfit_acaBounds({ diag: dg, CL: 1.903e-4, pMidHi: 0.5 * (run.isip.value + c.pClosure), piLo: pr, tEnd: 300, t0: 2 / 3, phi: 0.06, mu: 0.5, ct: 1e-5, h: 40, V: 25 });
      near(assert, b.dpCL, conv, 1e-9, 'acaBounds Δp_hi at the central values');
      const rm = win.PRiSM_dfit_reportModel(run, {});
      assert(rm && rm.sections && JSON.stringify(rm).indexOf('½·(ISIP + σ_c) − p_r') >= 0, 'the report states the same convention');
    },
  },
];
module.exports._gen = { mkData, mkRun, wellOf, INP, EXA_P, EXB_P, carterT, impUF, rateUF };
