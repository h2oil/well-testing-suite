// WP15 — gas & deliverability in PRiSM (52-prism-gas.js, 33/34/36 gas paths).
//
// Every expected value is computed here, independently of the code under test:
//   • m(p) = 2∫₀ᵖ p/(μZ) dp by the trapezoidal rule on a 0.5 psi grid, with
//     the same PVT (Dranchuk & Abou-Kassem Z, Lee-Gonzalez-Eakin μg) and the
//     Sutton (1985) pseudo-criticals restated here; p(m) by inverting that table.
//   • Synthetic gas tests are written directly in m(p) with the radial-flow
//     semilog solution (Lee, Rollins & Spivey 2003, SPE Textbook 9, §3):
//       m(pwf) = m(pi) − m′·[log10(k·t/(φ μ ct rw²)) − 3.2275 + 0.8686·S],
//       m′ = 1637·q·T/(k·h); build-up m_ws = m(pi) − m′·log10((tp+Δt)/Δt).
//     So p* = pi exactly, Δm_S = 0.8686·m′·S, FE = (Δm_dd − Δm_S)/Δm_dd.
//   • Pseudo-time t_a = ∫ (μ ct)ref/(μ ct) dt with ct = ct_ref + Sg·(cg − cg_ref),
//     cg = 1/p − (1/Z)dZ/dp by a central difference here, integrated with
//     40 sub-steps per sample interval (p linear in time between samples).
//   • Rate-dependent skin: superposed log-approximation drawdowns with
//     S′ = S + D·q_n at each rate (ERCB 1975) → S = 2, D = 1e-3 per STB/d.
//   • AOF: points built from q = C(p̄r² − pwf²)ⁿ (C = 0.1, n = 0.75) and from
//     Δ = a·q + b·q² (a = 100, b = 0.1; modified isochronal a_stab = 150),
//     AOF = C(p̄r² − 14.65²)ⁿ and (−a + √(a² + 4bΔ))/(2b), Δ = p̄r² − 14.65².
//   • Oil IPR: composite (Brown): J = q/(p̄r − pwf), qb = J(p̄r − pb),
//     qmax = qb + J·pb/1.8 → J = 1.5, qmax = 3916.667 STB/d.
'use strict';

const GAS = { T: 200, sg: 0.7, pi: 5000, h: 30, phi: 0.15, rw: 0.3, Sw: 0.25, q: 5000, k: 10, S: 3 };

function freshWell(app) {
  const pvt = app.win.PRiSM_pvt;
  if (pvt && pvt.provenance) for (const k of Object.keys(pvt.provenance)) pvt.provenance[k] = 'default';
  if (pvt) pvt.testType = 'auto';
}
function setGasWell(app, extra) {
  freshWell(app);
  app.win.PRiSM_setWell(app.toWin(Object.assign({ fluid: 'gas', p_res: GAS.pi, T_res: GAS.T, SG_g: GAS.sg, h: GAS.h, phi: GAS.phi,
    rw: GAS.rw, Sw: GAS.Sw, testType: 'auto' }, extra || {})), { source: 'user' });
}
function logspace(a, b, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(Math.pow(10, Math.log10(a) + (Math.log10(b) - Math.log10(a)) * i / (n - 1)));
  return out;
}

// Independent m(p) table (trapezoid, 0.5 psi) + inverse.
function mTable(W, T_F, sg, pmax) {
  const C = W.PRiSM_pvt_correlations;
  const Tpc = 169.2 + 349.5 * sg - 74.0 * sg * sg;            // Sutton (1985)
  const Ppc = 756.8 - 131.0 * sg - 3.6 * sg * sg;
  const Tpr = (T_F + 459.67) / Tpc;
  const dp = 0.5, n = Math.ceil(pmax / dp);
  const P = new Float64Array(n + 1), M = new Float64Array(n + 1);
  const f = (p) => { if (p <= 0) return 0; const Z = C.Z_dranchukAbouKassem(Tpr, p / Ppc); const mu = C.mu_g_leeGonzalezEakin(sg, T_F, Z, p); return 2 * p / (mu * Z); };
  let fPrev = 0;
  for (let i = 1; i <= n; i++) { P[i] = i * dp; const fi = f(P[i]); M[i] = M[i - 1] + 0.5 * (fPrev + fi) * dp; fPrev = fi; }
  const mOf = (p) => { const j = Math.min(n - 1, Math.floor(p / dp)); const u = (p - P[j]) / dp; return M[j] + u * (M[j + 1] - M[j]); };
  const pOf = (m) => { let lo = 0, hi = n; while (hi - lo > 1) { const md = (lo + hi) >> 1; if (M[md] <= m) lo = md; else hi = md; } return P[lo] + (m - M[lo]) / (M[lo + 1] - M[lo]) * dp; };
  const props = (p) => { const Z = C.Z_dranchukAbouKassem(Tpr, p / Ppc); return { Z, mu: C.mu_g_leeGonzalezEakin(sg, T_F, Z, p), dZdp: (C.Z_dranchukAbouKassem(Tpr, (p + 1) / Ppc) - C.Z_dranchukAbouKassem(Tpr, (p - 1) / Ppc)) / 2 }; };
  return { mOf, pOf, props };
}

// Gas build-up after tp hours at q (log-approximation superposition in m(p)).
function gasBuildup(W, tbl, well, tp) {
  const TR = GAS.T + 459.67;
  const mSlope = 1637 * GAS.q * TR / (GAS.k * GAS.h);
  const grp = GAS.phi * well.mu * well.ct * GAS.rw * GAS.rw;
  const mi = tbl.mOf(GAS.pi);
  const mFlow = (t) => mi - mSlope * (Math.log10(GAS.k * t / grp) - 3.2275 + 0.8686 * GAS.S);
  const t = [0], p = [GAS.pi], q = [GAS.q];
  logspace(0.01, tp, 30).forEach((tt, i, arr) => { const x = i === arr.length - 1 ? tp : tt; t.push(x); p.push(tbl.pOf(mFlow(x))); q.push(GAS.q); });
  logspace(0.005, 100, 60).forEach((dt) => { t.push(tp + dt); p.push(tbl.pOf(mi - mSlope * Math.log10((tp + dt) / dt))); q.push(0); });
  return { ds: { t, p, q }, mSlope, mi, mwf0: mFlow(tp), pwf0: tbl.pOf(mFlow(tp)), grp };
}

module.exports = [
  {
    name: 'm(p) table and C2 Δm(p) equal an independent trapezoidal integral of 2p/(μZ) (same PVT)',
    wp: 'WP15',
    run(app, assert) {
      const W = app.win;
      const ref = mTable(W, GAS.T, GAS.sg, 6200);
      const tbl = W.PRiSM_mpTable(app.toWin({ T_F: GAS.T, SG_g: GAS.sg, pmax: 6000 }));
      [500, 1000, 3000, 5000].forEach((p) => assert.rel(tbl.mOf(p), ref.mOf(p), 2e-5, 'm(' + p + ')'));
      assert.rel(tbl.pOf(ref.mOf(3456.7)), 3456.7, 1e-6, 'p(m) inverse');
      // A gas drawdown dataset: C2 Δm = m(pi) − m(p).
      setGasWell(app);
      const t = logspace(0.1, 50, 25), p = t.map((x) => 4900 - 40 * Math.log10(x / 0.1)), q = t.map(() => 3000);
      W.PRiSM_dataset = app.toWin({ t: [0].concat(t), p: [5000].concat(p), q: [3000].concat(q) });
      const ad = W.PRiSM_getAnalysisData();
      assert.ok(ad.ok && ad.pseudo && ad.dpUnit === 'psi²/cp', ad.reason);
      assert.equal(ad.pRefSource, 'pi');
      assert.near(ad.pRefPressure, 5000, 1e-9);
      assert.rel(ad.dp[10], ref.mOf(5000) - ref.mOf(ad.p[10]), 2e-4, 'Δm at sample 10');
    },
  },
  {
    name: 'gas build-up in m(p): kh, S, p* = pi and p1hr in psia (converted back from m*), ΔpS and FE from m(p) drawdowns',
    wp: 'WP15',
    run(app, assert) {
      const W = app.win;
      setGasWell(app);
      const well = W.PRiSM_getWell();
      assert.equal(well.fluid, 'gas');
      const ref = mTable(W, GAS.T, GAS.sg, 7000);
      const tp = 50;
      const b = gasBuildup(W, ref, well, tp);
      W.PRiSM_dataset = app.toWin(b.ds);
      const ad = W.PRiSM_getAnalysisData();
      assert.ok(ad.ok, ad.reason);
      assert.equal(ad.testType, 'buildup');
      assert.near(ad.tp, tp, 1e-6);
      const r = W.PRiSM_semilogAnalysis(ad, well, {});
      assert.ok(r.ok, r.reason);
      assert.equal(r.method, 'horner');
      assert.rel(r.m, b.mSlope, 2e-3, 'semilog slope in m(p)');
      assert.rel(r.k, GAS.k, 3e-3, 'k');
      assert.near(r.S, GAS.S, 0.03, 'S');
      assert.ok(r.gasConverted, 'converted with the m(p) table');
      assert.near(r.pStar, GAS.pi, 1.0, 'p* = pi (infinite acting)');
      // p1hr on the Horner line: m1hr = m_i − m′·log10(tp + 1)  (Δt = 1 h, from the m* intercept)
      assert.near(r.p1hr, ref.pOf(b.mi - b.mSlope * Math.log10(tp + 1)), 1.0, 'p1hr in psia');
      const dmS = 0.8686 * b.mSlope * GAS.S;
      assert.rel(r.dmS, dmS, 0.01, 'Δm_S');
      assert.near(r.dpS, ref.pOf(b.mwf0 + dmS) - b.pwf0, 2.0, 'ΔpS (psi) from m(p)');
      const ddm = b.mi - b.mwf0;
      assert.near(r.FE, (ddm - dmS) / ddm, 0.005, 'FE from m(p) drawdowns');
      assert.ok(!r.warnings.some((w) => /in Δm\(p\) units/.test(w)), 'no "Δm(p) units" limitation left');
      // Report: the reference pressure is quoted in psia (not m(p)), gas skin block in psi.
      W.PRiSM_state.semilog = r;
      const m = W.PRiSM_reportData();
      assert.near(m.data.pRef, b.pwf0, 0.5, 'report reference pressure = pwf0 psia');
    },
  },
  {
    name: 'gas drawdown: p1hr from the m(p) line in psia',
    wp: 'WP15',
    run(app, assert) {
      const W = app.win;
      setGasWell(app);
      const well = W.PRiSM_getWell();
      const ref = mTable(W, GAS.T, GAS.sg, 7000);
      const TR = GAS.T + 459.67, mSlope = 1637 * GAS.q * TR / (GAS.k * GAS.h);
      const grp = GAS.phi * well.mu * well.ct * GAS.rw * GAS.rw, mi = ref.mOf(GAS.pi);
      const m = (t) => mi - mSlope * (Math.log10(GAS.k * t / grp) - 3.2275 + 0.8686 * GAS.S);
      const t = logspace(0.01, 100, 50);
      W.PRiSM_dataset = app.toWin({ t: [0].concat(t), p: [GAS.pi].concat(t.map((x) => ref.pOf(m(x)))), q: [GAS.q].concat(t.map(() => GAS.q)) });
      const r = W.PRiSM_semilogAnalysis(W.PRiSM_getAnalysisData(), well, {});
      assert.ok(r.ok, r.reason);
      assert.equal(r.method, 'mdh');
      assert.rel(r.k, GAS.k, 3e-3, 'k');
      assert.near(r.S, GAS.S, 0.03, 'S');
      assert.near(r.p1hr, ref.pOf(m(1)), 1.0, 'p1hr psia');
      assert.ok(!isFinite(r.pStar), 'no p* for a drawdown');
    },
  },
  {
    name: 'pseudo-time: C2 replaces Δt by t_a = ∫(μct)ref/(μct)dt (normalised at p_res); independent sub-stepped integral',
    wp: 'WP15',
    run(app, assert) {
      const W = app.win;
      setGasWell(app);
      const well = W.PRiSM_getWell();
      const ref = mTable(W, GAS.T, GAS.sg, 7000);
      const b = gasBuildup(W, ref, well, 50);
      W.PRiSM_dataset = app.toWin(b.ds);
      const ad0 = W.PRiSM_getAnalysisData();
      const ad = W.PRiSM_getAnalysisData(null, app.toWin({ pseudoTime: true }));
      assert.ok(ad.ok && ad.pseudoTime, ad.reason + ' ' + (ad.warnings || []).join(' | '));
      assert.equal(ad.n, ad0.n);
      // Independent integral.
      const Sg = 1 - GAS.Sw;
      const pr = ref.props(GAS.pi);
      const cg = (p, pp) => 1 / p - pp.dZdp / pp.Z;
      const cgRef = cg(GAS.pi, pr);
      const ctRef = well.ct;
      const ratio = (p) => { const x = ref.props(p); return (pr.mu * ctRef) / (x.mu * (ctRef + Sg * (cg(p, x) - cgRef))); };
      let tPrev = 0, pPrev = ad.pRefPressure, acc = 0;
      const exp = [];
      for (let i = 0; i < ad0.t.length; i++) {
        const t1 = ad0.t[i], p1 = ad0.p[i], N = 40;
        for (let k = 0; k < N; k++) {
          const a = tPrev + (t1 - tPrev) * k / N, c = tPrev + (t1 - tPrev) * (k + 1) / N;
          const pa = pPrev + (p1 - pPrev) * k / N, pc = pPrev + (p1 - pPrev) * (k + 1) / N;
          acc += 0.5 * (ratio(pa) + ratio(pc)) * (c - a);
        }
        exp.push(acc); tPrev = t1; pPrev = p1;
      }
      [5, 20, 40, ad.n - 1].forEach((i) => assert.rel(ad.t[i], exp[i], 2e-3, 't_a[' + i + ']'));
      assert.ok(ad.t[ad.n - 1] !== ad0.t[ad0.n - 1], 'pseudo-time differs from real time');
      assert.ok(ad.tReal && Math.abs(ad.tReal[3] - ad0.t[3]) < 1e-12, 'real Δt kept in tReal');
      // Store option + panel.
      assert.ok(W.PRiSM_setGasOption('pseudoTime', true));
      assert.ok(W.PRiSM_getAnalysisData().pseudoTime, 'st.gasOpts.pseudoTime drives C2');
      W.PRiSM_setGasOption('pseudoTime', false);
      assert.ok(!W.PRiSM_getAnalysisData().pseudoTime);
      // Oil: request ignored with a warning.
      setGasWell(app, { fluid: 'oil' });
      const adOil = W.PRiSM_getAnalysisData(null, app.toWin({ pseudoTime: true }));
      assert.ok(!adOil.pseudoTime && adOil.warnings.some((w) => /Pseudo-time applies to gas/.test(w)));
    },
  },
  {
    name: 'rate-dependent skin from three flow periods: S′ = S + D·q gives S = 2, D = 1e-3 per STB/d',
    wp: 'WP15',
    run(app, assert) {
      const W = app.win;
      freshWell(app);
      const w = { B: 1.2, mu: 0.8, h: 40, k: 60, phi: 0.2, ct: 1e-5, rw: 0.3, pi: 4000 };
      W.PRiSM_setWell(app.toWin({ fluid: 'oil', p_res: w.pi, B: w.B, mu: w.mu, ct: w.ct, h: w.h, phi: w.phi, rw: w.rw, testType: 'auto' }), { source: 'user' });
      const S = 2, Dn = 1e-3, m1 = 162.6 * w.B * w.mu / (w.k * w.h), lk = Math.log10(w.k / (w.phi * w.mu * w.ct * w.rw * w.rw)) - 3.2275;
      const rates = [1000, 2000, 3000], starts = [0, 20, 40];
      const t = [0], p = [w.pi], q = [rates[0]];
      rates.forEach((qn, n) => {
        logspace(0.005, 20, 30).forEach((dt, i, arr) => {
          const T = starts[n] + (i === arr.length - 1 ? 20 : dt);
          let dp = 0;
          for (let j = 0; j <= n; j++) dp += (rates[j] - (j ? rates[j - 1] : 0)) * m1 * (Math.log10(T - starts[j]) + lk);
          dp += 0.8686 * m1 * qn * (S + Dn * qn);
          t.push(T); p.push(w.pi - dp); q.push(qn);
        });
      });
      W.PRiSM_dataset = app.toWin({ t, p, q });
      const r = W.PRiSM_skinVsRate(app.toWin({ include: 'flow' }));
      assert.ok(r.ok, r.reason + ' ' + JSON.stringify(r.skipped));
      assert.equal(r.rows.length, 3);
      r.rows.forEach((x, i) => assert.near(x.S, S + Dn * rates[i], 0.03, 'S′ period ' + (i + 1)));
      assert.near(r.fit.S, S, 0.05, 'S');
      assert.rel(r.fit.D, Dn, 0.03, 'D');
      assert.near(W.PRiSM_state.rateSkin.D, r.fit.D, 1e-15, 'stored in st.rateSkin (report / skin decomposition)');
      const sec = W.PRiSM_reportData().extra.find((s) => s.id === 'rateSkin');
      assert.ok(sec && sec.table.rows.length === 3, 'report section');
    },
  },
  {
    name: 'AOF from flow-after-flow periods through WTS_gasdeliv_compute: C = 0.1, n = 0.75 and LIT a = 100, b = 0.1',
    wp: 'WP15',
    run(app, assert) {
      const W = app.win;
      assert.fn(W.WTS_gasdeliv_compute, 'calculator engine exported');
      setGasWell(app, { p_res: 3000 });
      const pr = 3000, rates = [2000, 4000, 6000, 8000];
      function build(pwfOf) {
        const t = [0], p = [pr], q = [rates[0]];
        rates.forEach((qn, n) => {
          [0.5, 2, 4, 6].forEach((dt) => { t.push(n * 6 + dt); p.push(pwfOf(qn)); q.push(qn); });
        });
        return { t, p, q };
      }
      const C = 0.1, n = 0.75;
      W.PRiSM_dataset = app.toWin(build((qq) => Math.sqrt(pr * pr - Math.pow(qq / C, 1 / n))));
      const pts = W.PRiSM_deliverabilityPoints();
      assert.ok(pts.ok, pts.reason);
      assert.equal(pts.type, 'faf');
      assert.equal(pts.points.length, 4);
      assert.near(pts.pr, pr, 1e-9);
      const r = W.PRiSM_gasDeliverability();
      assert.ok(r.ok, r.reason);
      assert.rel(r.result.cn.n, n, 1e-6, 'n');
      assert.rel(r.result.cn.C, C, 1e-5, 'C');
      const dAOF = pr * pr - 14.65 * 14.65;
      assert.rel(r.result.cn.aof, C * Math.pow(dAOF, n), 1e-5, 'AOF back-pressure');
      assert.equal(W.PRiSM_state.deliverability.kind, 'gas');
      // LIT data.
      const a = 100, b = 0.1;
      W.PRiSM_dataset = app.toWin(build((qq) => Math.sqrt(pr * pr - (a * qq + b * qq * qq))));
      const r2 = W.PRiSM_gasDeliverability();
      assert.ok(r2.ok && r2.result.lit.ok, r2.reason);
      assert.rel(r2.result.lit.a, a, 1e-6, 'LIT a');
      assert.rel(r2.result.lit.b, b, 1e-6, 'LIT b');
      assert.rel(r2.result.lit.aof, (-a + Math.sqrt(a * a + 4 * b * dAOF)) / (2 * b), 1e-6, 'AOF LIT');
      const sec = W.PRiSM_reportData().extra.find((s) => s.id === 'deliverability');
      assert.ok(sec && /AOF/.test(sec.title), 'report section');
    },
  },
  {
    name: 'modified isochronal periods: pws from the preceding shut-ins, extended last flow is the stabilised point; LIT AOF with a_stab',
    wp: 'WP15',
    run(app, assert) {
      const W = app.win;
      setGasWell(app, { p_res: 3000 });
      const pr = 3000, aT = 100, aS = 150, b = 0.1, qs = [2000, 3000, 4000], qStab = 5000;
      const t = [0], p = [pr], q = [qs[0]];
      let T = 0;
      qs.forEach((qn) => {
        [0.25, 0.5, 1].forEach((dt) => { t.push(T + dt); p.push(Math.sqrt(pr * pr - (aT * qn + b * qn * qn))); q.push(qn); });
        T += 1;
        [0.25, 0.5, 1].forEach((dt) => { t.push(T + dt); p.push(pr - 0.5 + 0.5 * dt); q.push(0); });   // recovers to p̄r
        T += 1;
      });
      [1, 5, 10].forEach((dt) => { t.push(T + dt); p.push(Math.sqrt(pr * pr - (aS * qStab + b * qStab * qStab))); q.push(qStab); });
      W.PRiSM_dataset = app.toWin({ t, p, q });
      const pts = W.PRiSM_deliverabilityPoints();
      assert.ok(pts.ok, pts.reason);
      assert.equal(pts.type, 'miso');
      assert.deepEqual(pts.points.map((x) => x.kind), ['trans', 'trans', 'trans', 'stab']);
      assert.near(pts.points[1].pws, pr, 1e-9, 'pws = last shut-in pressure');
      const r = W.PRiSM_gasDeliverability();
      assert.ok(r.ok && r.result.lit.ok, r.reason);
      assert.rel(r.result.lit.b, b, 1e-6, 'b from the transient points');
      assert.rel(r.result.lit.a, aS, 1e-6, 'a from the stabilised point');
      const dAOF = pr * pr - 14.65 * 14.65;
      assert.rel(r.result.lit.aof, (-aS + Math.sqrt(aS * aS + 4 * b * dAOF)) / (2 * b), 1e-6, 'AOF LIT');
    },
  },
  {
    name: 'oil IPR inside PRiSM through WTS_oilipr_compute: composite J = 1.5, qmax = 3916.667 STB/d',
    wp: 'WP15',
    run(app, assert) {
      const W = app.win;
      freshWell(app);
      W.PRiSM_setWell(app.toWin({ fluid: 'oil', p_res: 3500, Pb: 2000, testType: 'auto' }), { source: 'user' });
      const t = [0, 1, 5, 10, 24], p = [3500, 2700, 2600, 2550, 2500], q = [1500, 1500, 1500, 1500, 1500];
      W.PRiSM_dataset = app.toWin({ t, p, q });
      const r = W.PRiSM_oilDeliverability(app.toWin({ fe: 1 }));
      assert.ok(r.ok, r.reason);
      assert.equal(r.result.mode, 'composite');
      assert.near(r.input.pr, 3500, 1e-9);
      assert.near(r.input.points[0].pwf, 2500, 1e-9, 'last flowing pressure');
      assert.rel(r.result.J, 1.5, 1e-9, 'J');
      assert.rel(r.result.qb, 2250, 1e-9, 'qb');
      assert.rel(r.result.qmax, 2250 + 1.5 * 2000 / 1.8, 1e-9, 'qmax');
      const d = W.PRiSM_deliverability(app.toWin({ fe: 1 }));
      assert.equal(d.kind, 'oil');
    },
  },
  {
    name: 'gas panels mount on Tab 2 (basis, rate skin, deliverability) and the report carries the gas basis section',
    wp: 'WP15',
    run(app, assert) {
      const W = app.win;
      app.openPRiSM();
      setGasWell(app);
      const well = W.PRiSM_getWell();
      const ref = mTable(W, GAS.T, GAS.sg, 7000);
      const b = gasBuildup(W, ref, well, 50);
      W.PRiSM_dataset = app.toWin(b.ds);
      app.renderTab(2);
      app.flush(50);
      const ids = (W.PRiSM_tabPanels[2] || []).map((x) => x.id);
      ['prism_gas_basis', 'prism_rate_skin', 'prism_deliverability'].forEach((id) => assert.ok(ids.indexOf(id) !== -1, id + ' registered'));
      const host = app.document.createElement('div');
      W.PRiSM_renderGasPanel(host);
      assert.includes(host.innerHTML, 'm(p) at pi');
      W.PRiSM_semilogAnalysis(W.PRiSM_getAnalysisData(), well, app.toWin({ store: true }));
      const m = W.PRiSM_reportData();
      const sec = m.extra.find((s) => s.id === 'gas');
      assert.ok(sec, 'gas basis section');
      assert.ok(sec.kv.some((kv) => /p\* \(from m\*\)/.test(kv[0])), 'p* row');
      const html = W.PRiSM_buildReportHTML();
      assert.includes(String(html && (html.html || html)), 'Gas analysis basis');
      assert.equal(app.consoleErrors().length, 0, app.consoleErrors().join(' | '));
    },
  },
];
