// DFIT — WP2 pre-closure core (docs/DFIT-PLAN.md §4.1, §4.3–§4.11, §4.21, §6.12, §9 WP2 "dfit-preclosure").
//
// Reference data: FIX.ds (the §4.21 well, tests/_dfit-shapes.js) and G-domain signals from PRiSM_dfit_vcModel on the same
// well. §4.21 convention: the 25 bbl is V_i* (frac is given ViStar 25 where the reference numbers are quoted); an engine
// run on FIX.ds computes V_i* = V_i − V_w·c_w·(σ_c − p_start) = 23.02 bbl (P1). Stubs (plan §2.12 rule 4, until the owning
// WP merges): WTS_wellbore.hammerQuick / stepDown results are passed as Hammer- / StepDown-shaped objects built in the test
// (P3b), and PRiSM_dfit_lkDefaults / lkSimulate (WP4) are replaced for P13 by a w_c = 1 run generated with vcModel.
//
//   P1  events on FIX.ds: t_s within 1 s, tp choices, V_i 25, V_i* 23.02 at σ_c 7,000, q_eq 5, V_w·c_w from the ramp
//   P2  resampler: 10⁶ samples in one pass (operation count linear), 40 per decade
//   P3a reconciliation arithmetic: 7,605 / 7,600.0 / 7,595.5 / 7,599.4 → 7,600 ± 5, high
//   P3b inline bleed-off simulation (§4.4): each accepted family within 5 psi; the viscous term subtracted from ISIP_lp;
//       a linear midline reads ≥ 20 psi high; the wave estimate is "upper" when the bleed term is off
//   P4  √t extrapolation reads 22–28 psi high on FIX.ds (G is used for the ISIP)
//   P5  Bourdet G·dP/dG = m_G·G on Nolte data within 0.5 %
//   P6  D_ref on Δt (no superposition switch)
//   P7  geometry with storage: xf 131.2 / 57.3 / 57.8 ft; CL 1.903e-4 / 4.361e-4 / 4.409e-4; r_p 0.4315; C_sys 0.2105,
//       A_f·c_f 0.2061 ft³/psi
//   P8  V_L during pumping 14.04 ft³
//   P9  q_L 0.500 → 0.0405 bbl/min and 22.5 bbl after shut-in
//   P10 k from CL 2.75e-3 md at Δp_CL 2,800 psi
//   P11 closure forecast 2.46 / 8.63 h for σ 7,200 / 6,800
//   P12 C_d 0.0040 ± 0.0002 (fissure PDL)
//   P13 κ_exp from a stubbed w_c = 1 run and the matrix classification
//   P14 R_vis 0.979 (water) / 0.54 (gas-filled, C_sys 0.388 ft³/psi)
//   P15 classifier: normal and matrix signatures
//   P16 classifier: PDL, contact / height recession (hr-contact), tip extension
//   P17 classifier: storage with a pressure-dependent wellbore; constant C_sys with R_vis > 0.7 not storage; a constant
//       sink raises unitSlopeSink
//   P18 storage chain: V_w·c_w 0.178 and A_f·c_f 0.2105 ft³/psi → R_vis 0.542 ± 0.01, A_f·c_f within 1 %
//   P19 stress-log offset 667 psi and pad fraction 0.053–0.010
//   P20 h-function (gate G6): not verified in 3.4a → hFn null, kH null, far-field null
//   P21 masked samples never reach a derivative as null (no spike at the mask edge)
//   P22 the frictional check uses p_p at the lower bracket edge and S_v 0.9 psi/ft for the veto
'use strict';

const S = require('./_dfit-shapes');

const WP = 'DF2';
const BBL = 5.614583;
const REF = S.FIX.ref.REF;
const near = (assert, a, b, tol, what) => assert(typeof a === 'number' && Math.abs(a - b) <= tol, what + ': ' + a + ' vs ' + b + ' (± ' + tol + ')');
const okShape = (assert, name, obj, what) => { const r = S.checkShape(name, obj); assert(r.ok, (what || name) + ' shape: ' + JSON.stringify(r.errors.slice(0, 4))); };
function app(ctx) { const a = S.sharedApp(ctx); S.resetDfit(a); return a.win; }
const WELL = { pi: 4500, mu: 0.5, phi: 0.06, ct: 1e-5 };
const inputsRef = () => S.FIX.state.tests[0].inputs;
function fixRun(G, o) {
  o = o || {};
  const I = o.inputs || inputsRef(), ds = o.ds || S.FIX.ds;
  const prep = G.PRiSM_dfit_prepare(ds, I, WELL), ev = G.PRiSM_dfit_events(prep, I.events, o.evOpts || {});
  const d = G.PRiSM_dfit_derivs(prep, ev, Object.assign({ alpha: 0.5, L: 0.1 }, o.dOpts || {}));
  return { I, prep, ev, d };
}
const fracRef = (G, r, pc, extra) => G.PRiSM_dfit_frac(pc, r.d, Object.assign({ events: r.ev, isip: 7600, inputs: r.I, ViStar: 25, VwCw: REF.VwCw, well: WELL }, extra || {}));

const AfCf = 0.2061 / BBL, VwCw = REF.VwCw;
const BASE = { isip: 7600, sigmaC: 7000, law: 'none', sc: 100, fres: 0.1, sr: null, pr: 4500, AfCf, VwCw, K: (600 / 18) * (AfCf + VwCw) };
function synth(G, P, o) {
  o = o || {};
  const tp = 5 / 60, tS = 2 / 60, ts = tS + tp, per = o.perDecade || 120, tEnd = o.tEnd || 24;
  const t = [], p = [], q = [];
  for (let i = 0; i < 10; i++) { t.push(i * 12 / 3600); p.push(4500); q.push(0); }
  for (let i = 1; i <= 120; i++) { const tt = tS + i * 2.5 / 3600; t.push(tt); p.push(Math.min(4500 + 6323 * (tt - tS) * 60, o.pPump || 7950)); q.push(7200); }
  const dts = []; for (let k = 0; ; k++) { const dt = (1 / 3600) * Math.pow(10, k / per); if (dt > tEnd) break; dts.push(dt); }
  const pf = o.pfun ? dts.map(o.pfun) : G.PRiSM_dfit_vcModel(dts.map((dt) => G.PRiSM_dfit_G(dt / tp, 0.5)), P, { maxStep: 0.01 });
  dts.forEach((dt, k) => { t.push(ts + dt); p.push(+pf[k].toFixed(3)); q.push(0); });
  return { t, p, q, name: 'synthetic', source: 'test', timeUnit: 'h', rateUnit: 'bbl/d', meta: { psigConverted: {} } };
}
function synthRun(G, P, o) { return fixRun(G, Object.assign({}, o, { ds: synth(G, P, o) })); }
function classify(G, r, extra) {
  return G.PRiSM_dfit_classify(r.d, Object.assign({ inputs: r.I, isip: r.d.isip, pr: 4500, well: WELL }, extra || {}));
}

module.exports = [
  {
    name: 'P1 events on FIX.ds: t_s within 1 s, tp choices, V_i 25, V_i* 23.02 at σ_c 7,000, q_eq 5, V_w·c_w from the ramp',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx), r = fixRun(G, { evOpts: { sigmaC: 7000 } }), ev = r.ev;
      assert(r.prep.ok === true && ev.ok === true, 'prepare and events ok'); okShape(assert, 'Prepared', r.prep); okShape(assert, 'Events', ev);
      near(assert, ev.ts * 3600, 7 * 60, 1, 't_s (s)'); near(assert, ev.tStart * 3600, 120, 1, 't_start (s)');
      near(assert, ev.tp.pump * 60, 5.0, 1 / 60, 'tp pump (min)'); near(assert, ev.tp.veq * 60, 5.0, 1e-3, 'tp volume-equivalent (min)');
      near(assert, ev.tb * 3600, 120 + 35, 1, 'breakdown 35 s after the pump start'); near(assert, ev.pb, 8188.42, 0.01, 'breakdown pressure');
      near(assert, ev.tp.breakdown * 60, 5 - 35 / 60, 1 / 60, 'tp breakdown (min)');
      near(assert, ev.Vi, 25, 1e-4, 'V_i (bbl)'); near(assert, ev.ViStar, 23.02, 0.01, 'V_i* at σ_c 7,000 psia'); near(assert, ev.qEq, 5, 1e-4, 'q_eq (bbl/min)');
      near(assert, ev.VwCwMeasured, 7.908e-4, 2e-6, 'V_w·c_w from the pre-breakdown ramp (bbl/psi)');
      near(assert, ev.qMax, 5, 1e-9, 'q_max'); assert(ev.Vfill === 0 && ev.Vfb === 0 && ev.steps.length === 0 && ev.cycles.length === 1, 'no fill, flowback or steps; one cycle');
      assert(ev.schedule.length === 2 && Math.abs(ev.schedule[0].q - 5) < 1e-9 && ev.schedule[1].q === 0, 'idealised schedule');
      // a user override of the shut-in time
      const I = inputsRef(); I.events.ts = 0.1168;
      const e2 = G.PRiSM_dfit_events(G.PRiSM_dfit_prepare(S.FIX.ds, I, WELL), I.events, {});
      assert(e2.source.ts === 'user' && e2.ts === 0.1168, 'user shut-in override');
      assert(G.PRiSM_dfit_dsHash(S.FIX.ds) === S.dsHash(S.FIX.ds), 'dsHash = the frozen hash definition');
    },
  },
  {
    name: 'P2 resampler: 10⁶ samples in one pass (operation count linear), 40 per decade',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx);
      function make(n) {
        const t = new Array(n), p = new Array(n), ts = 0.1, nP = 3000, tE = 72;
        for (let i = 0; i < n; i++) {
          if (i < nP) { t[i] = ts * i / nP; p[i] = 7000 + 900 * i / nP; continue; }
          const dt = (tE / (n - nP)) * (i - nP + 1); t[i] = ts + dt; p[i] = 7600 - 33.333 * G.PRiSM_dfit_G(dt / (5 / 60), 0.5);
        }
        return { t, p, ts };
      }
      const a = make(1000000), b = make(500000);
      const ra = G.PRiSM_dfit_resample(a.t, a.p, a.ts, { perDecade: 40, dpMin: 1e9 }), rb = G.PRiSM_dfit_resample(b.t, b.p, b.ts, { perDecade: 40, dpMin: 1e9 });
      assert(ra.ok === true && rb.ok === true, 'resample ok');
      assert(ra.ops / rb.ops < 2.2, 'operation count linear: ' + ra.ops + ' / ' + rb.ops);
      // per decade where the source is dense enough (Δt ≥ 0.1 h; the record is uniform at 0.26 s)
      const fall = ra.t.filter((x) => x - a.ts >= 0.1), first = fall[0] - a.ts, last = fall[fall.length - 1] - a.ts, dec = Math.log10(last / first);
      near(assert, (fall.length - 1) / dec, 40, 2, 'falloff samples per decade');
      assert(ra.t.filter((x) => x <= a.ts).length <= 2000, 'pumping kept to ≤ 2,000 (bin extremes)');
      for (let i = 1; i < ra.t.length; i++) if (!(ra.t[i] > ra.t[i - 1])) { assert.fail('resampled time not ascending at ' + i); break; }
      // the pressure-increment rule adds samples where the pressure moves fast
      const rc = G.PRiSM_dfit_resample(b.t, b.p, b.ts, { perDecade: 40, dpMin: 5 });
      assert(rc.t.length > rb.t.length, 'dpMin keeps more samples (' + rc.t.length + ' > ' + rb.t.length + ')');
    },
  },
  {
    name: 'P3a reconciliation arithmetic: 7,605 / 7,600.0 / 7,595.5 / 7,599.4 → 7,600 ± 5, high',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx), cand = S.FIX.run.isip.candidates;            // the §4.4 given numbers (FIX.run)
      const r = G.PRiSM_dfit_isip.reconcile(cand, { pn: 600 });
      near(assert, r.value, 7600.0, 0.05, 'inverse-variance mean over families'); near(assert, r.spread, 9.5, 1e-9, 'spread (max − min of family values)');
      assert.strictEqual(r.confidence, 'high', 'label high (within max(10 psi, 2 % pn) = 12 psi)');
      // the same through PRiSM_dfit_isip on FIX.ds: the early-G member 7,600.0 is computed, the others are given
      const f = fixRun(G), res = G.PRiSM_dfit_isip(f.prep, f.ev, f.d, { candidates: cand.filter((c) => c.method !== 'g'), pn: 600 });
      assert(res.ok === true, 'isip ok'); okShape(assert, 'IsipResult', res);
      near(assert, res.candidates.filter((c) => c.method === 'g')[0].value, 7600.0, 0.05, 'early-G extrapolation on FIX.ds');
      near(assert, res.value, 7600, 0.5, 'reconciled ISIP'); assert.strictEqual(res.confidence, 'high', 'high'); near(assert, res.spread, 9.5, 0.05, 'spread');
      assert(res.loglogCheck.ok === true, 'log-log check agrees');
    },
  },
  {
    name: 'P3b inline bleed-off simulation: each accepted family within 5 psi; lp less the viscous term; linear midline ≥ 20 high; wave upper without the bleed term',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx);
      // §4.21 tortuosity 315 psi at 5 bbl/min (b = 140.9, β ½), V_w·c_w 4.44e-3 ft³/psi: 1/Δ = 1/Δ0 + t/(b²·V_w·c_w)
      const tp = 5 / 60, b = 315 / Math.sqrt(5), bVc = b * b * VwCw;          // psi·min
      const bleed = (dt) => 1 / (1 / 315 + dt * 60 / bVc);
      near(assert, bleed(6 / 3600), 105, 1, 'Δ at 6 s'); near(assert, bleed(30 / 3600), 28.6, 0.3, 'Δ at 30 s');
      const pFall = (dt) => 7600 - (600 / 18) * G.PRiSM_dfit_G(dt / tp, 0.5) + bleed(dt);
      // 50 Hz for the first 120 s, then log-spaced; last pump pressure = ISIP + perforation + tortuosity + viscous 35 psi
      const ds0 = synth(G, null, { pfun: pFall, perDecade: 60, pPump: 7600 + 37.6 + 315 + 35 });
      const ts = 7 / 60, t = [], p = [], q = [];
      ds0.t.forEach((tt, i) => { if (tt <= ts || tt - ts > 120 / 3600) { t.push(tt); p.push(ds0.p[i]); q.push(ds0.q[i]); } });
      const hf = []; for (let k = 1; k <= 6000; k++) hf.push(ts + k * 0.02 / 3600);
      const ds = { t: [], p: [], q: [], timeUnit: 'h', rateUnit: 'bbl/d', meta: { psigConverted: {} } };
      const all = t.map((tt, i) => [tt, p[i], q[i]]).concat(hf.map((tt) => [tt, +pFall(tt - ts).toFixed(3), 0])).sort((x, y) => x[0] - y[0]);
      all.forEach((r) => { ds.t.push(r[0]); ds.p.push(r[1]); ds.q.push(r[2]); });
      const I = inputsRef(), prep = G.PRiSM_dfit_prepare(ds, I, WELL), ev = G.PRiSM_dfit_events(prep, I.events, {});
      const d = G.PRiSM_dfit_derivs(prep, ev, { alpha: 0.5, bleed: { curve: bleed } });
      assert(d.ok === true && d.gMinWhy === 'bleed-off', 'G_min moved past the predicted bleed-off end (' + d.gMinWhy + ', G ' + d.gMin + ')');
      // a linear-in-time midline over the first 30 s reads high by tens of psi
      let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
      d.dt.forEach((dt, i) => { if (dt <= 30 / 3600) { n++; sx += dt; sy += d.p[i]; sxx += dt * dt; sxy += dt * d.p[i]; } });
      const bb = (n * sxy - sx * sy) / (n * sxx - sx * sx), midline = (sy - bb * sx) / n;
      assert(midline - 7600 >= 20, 'linear midline reads ' + (midline - 7600).toFixed(1) + ' psi high');
      // stubs (WP1 not merged): the bleed-aware hammer midline = the early-window line of p − Δ_bleed on G; the step-down
      let m2 = 0, gx = 0, gy = 0, gxx = 0, gxy = 0;
      d.dt.forEach((dt, i) => { if (dt <= 30 / 3600) { const yv = d.p[i] - bleed(dt); m2++; gx += d.G[i]; gy += yv; gxx += d.G[i] * d.G[i]; gxy += d.G[i] * yv; } });
      const gb = (m2 * gxy - gx * gy) / (m2 * gxx - gx * gx), whFit = (gy - gb * gx) / m2;
      const hammer = (fitted, v) => ({ ok: true, why: null, c: 4539, cSource: 'korteweg', T: 8.81, tau: 3, delta: 0.1, A: 50, phi: 0, isip: v, regime: 'ringing', Lquarter: 10000, Lhalf: 20000,
        reflectorMatch: 'perfs', gammaDecay: 0.6, joukowsky: { expected: 232, measured: 230, ratio: 0.99 }, VwCwHammer: VwCw, tEnd: ts + 30 / 3600, sampling: { hz: 50, per2Lc: 440, ok: true }, bleedFitted: fitted });
      const stepDown = { ok: true, pFrac: 7598.5, se: { pFrac: 3, a: 0.1, b: 2 }, a: 1.504, b: 140.9, beta: 0.5, drift: 0, nOpen: 11.9, nOpenBand: { p10: 8.9, p50: 11.7, p90: 16.0, driver: 'C_d' },
        at: { dpPerf: 37.6, dpNwb: 315, dpPipe: 0 }, label: 'high', refused: null, resid: [], corr: null };
      okShape(assert, 'Hammer', hammer(true, whFit), 'stub Hammer'); okShape(assert, 'StepDown', stepDown, 'stub StepDown');
      const res = G.PRiSM_dfit_isip(prep, ev, d, { hammer: hammer(true, whFit), stepDown, bleed: { curve: bleed }, lumped: { lambda: 2, pVisc: 35 } });
      assert(res.ok === true, 'isip ok'); okShape(assert, 'IsipResult', res);
      const byM = {}; res.candidates.forEach((c) => { byM[c.method] = c; });
      ['wh', 'g', 'sd', 'lp'].forEach((m) => { assert(byM[m] && byM[m].upper === false, m + ' accepted'); near(assert, byM[m].value, 7600, 5, 'family member ' + m); });
      near(assert, byM.lp.viscCorr, 35, 1e-9, 'the in-fracture viscous term is subtracted from ISIP_lp');
      near(assert, res.value, 7600, 5, 'reconciled ISIP');
      // the bleed term switched off: the wave estimate is an upper estimate and does not enter the reconciliation
      const res2 = G.PRiSM_dfit_isip(prep, ev, d, { hammer: hammer(false, midline), stepDown, bleed: { curve: bleed }, lumped: { lambda: 2, pVisc: 35 } });
      const wh2 = res2.candidates.filter((c) => c.method === 'wh')[0];
      assert(wh2.upper === true && wh2.bleedAtEnd > 2, 'wave estimate flagged upper (bleed at the window end ' + wh2.bleedAtEnd + ' psi)');
      near(assert, res2.value, 7600, 5, 'the upper estimate does not move the ISIP');
      const res3 = G.PRiSM_dfit_isip(prep, ev, d, { stepDown });
      assert(res3.candidates.filter((c) => c.method === 'lp')[0].upper === true, 'without the viscous term lp is a fracture-entrance upper estimate');
    },
  },
  {
    name: 'P4 √t extrapolation reads 22–28 psi high on FIX.ds (the ISIP uses G)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx), r = fixRun(G), d = r.d;
      const isip = G.PRiSM_dfit_isip(r.prep, r.ev, d, {});
      near(assert, isip.candidates.filter((c) => c.method === 'g')[0].value, 7600.0, 0.05, 'early-G extrapolation');
      let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
      d.G.forEach((g, i) => { if (g >= d.earlyWin[0] && g <= d.earlyWin[1]) { const x = Math.sqrt(d.dt[i]); n++; sx += x; sy += d.p[i]; sxx += x * x; sxy += x * d.p[i]; } });
      const b = (n * sxy - sx * sy) / (n * sxx - sx * sx), a = (sy - b * sx) / n;
      assert(a - 7600 >= 22 && a - 7600 <= 28, '√t extrapolation over the same window reads ' + (a - 7600).toFixed(1) + ' psi high');
    },
  },
  {
    name: 'P5 Bourdet G·dP/dG equals the analytic m_G·G on Nolte data within 0.5 %',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx), d = fixRun(G).d;
      near(assert, d.mG, REF.mG, 1e-3, 'm_G from the early window');
      let worst = 0, cnt = 0;
      d.G.forEach((g, i) => { if (d.usable[i] && g >= 0.5 && g <= 18 * Math.exp(-2 * d.L)) { cnt++; worst = Math.max(worst, Math.abs(d.GdPdG[i] / (REF.mG * g) - 1)); } });
      assert(cnt > 50 && worst <= 0.005, cnt + ' samples, worst relative difference ' + worst.toFixed(5));
      okShape(assert, 'Derivs', d); assert(d.ok === true && d.gType === 'a05', 'Derivs ok, α ½');
      // the derivative does not depend on the ISIP value
      const r2 = fixRun(G, { dOpts: { isip: 7650 } });
      const i = r2.d.G.findIndex((g) => g > 5);
      near(assert, r2.d.GdPdG[i], d.GdPdG[i], 1e-9, 'G·dP/dG independent of the ISIP');
    },
  },
  {
    name: 'P6 D_ref on Δt (no superposition switch): D = Δt·dp/dΔt and D ≈ D_ref = m_G·ΔtD·G′ before closure',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx), d = fixRun(G).d;
      let worst = 0, cnt = 0;
      d.G.forEach((g, i) => {
        if (!d.usable[i] || d.D[i] === null || g < 0.5 || g > 18 * Math.exp(-2 * d.L)) return;
        cnt++;
        near(assert, d.Dref[i], d.mG * d.dtD[i] * 4 / Math.PI * G.PRiSM_dfit_gPrime(d.dtD[i], 0.5), 1e-9 * d.Dref[i], 'D_ref definition');
        near(assert, d.D[i], d.dt[i] * d.ppd[i], 1e-9 * d.D[i], 'D = Δt·dp/dΔt'); near(assert, d.sdPds[i], 2 * d.D[i], 1e-9 * d.D[i], '√t·dP/d√t = 2D');
        worst = Math.max(worst, Math.abs(d.D[i] / d.Dref[i] - 1));
      });
      assert(cnt > 50 && worst < 0.01, 'D/D_ref within 1 % before closure (worst ' + worst.toFixed(4) + ')');
    },
  },
  {
    name: 'P7 geometry with storage: xf 131.2 / 57.3 / 57.8 ft; CL 1.903e-4 / 4.361e-4 / 4.409e-4; r_p 0.4315; C_sys 0.2105, A_f·c_f 0.2061',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx), r = fixRun(G), f = fracRef(G, r, 7000), P = f.geometry.byModel;
      assert(f.ok !== false, 'frac ok'); okShape(assert, 'FracOutputs', f);
      near(assert, f.Gc, 18.0, 1e-3, 'G_c'); near(assert, f.dtc * 60, 305.1, 0.05, 'Δt_c (min)'); near(assert, f.eta.a05, 0.900, 5e-4, 'η_G α ½'); near(assert, f.eta.a1, 0.915, 5e-4, 'η_G α 1');
      near(assert, f.eta.etaF, 0.898, 5e-4, 'η_f'); near(assert, f.pn, 600, 1e-6, 'pn'); near(assert, f.chi, 1.00, 5e-3, 'χ');
      near(assert, f.Csys * BBL, 0.2105, 5e-5, 'C_sys (ft³/psi)'); near(assert, f.AfCf * BBL, 0.2061, 5e-5, 'A_f·c_f (ft³/psi)');
      near(assert, P.PKN.xf, 131.2, 0.05, 'PKN xf'); near(assert, P.PKN.Af, 13121, 2, 'PKN A_f'); near(assert, P.PKN.wAvg, 0.113, 5e-4, 'PKN w̄ (in)');
      near(assert, P.PKN.CL, 1.903e-4, 2e-7, 'PKN CL'); near(assert, P.KGD.xf, 57.3, 0.05, 'KGD xf'); near(assert, P.KGD.CL, 4.361e-4, 3e-7, 'KGD CL');
      near(assert, P.radial.R, 57.8, 0.05, 'radial R'); near(assert, P.radial.CL, 4.409e-4, 3e-7, 'radial CL'); near(assert, P.radial.rp, 0.4315, 5e-4, 'radial r_p');
      near(assert, P.PKN.Vf, 22.0, 0.05, 'V_f (bbl)'); near(assert, f.gradClosure, 0.700, 1e-6, 'closure gradient'); near(assert, f.gradIsip, 0.760, 1e-6, 'ISIP gradient');
      assert(f.geometry.model === 'PKN' && f.geometry.consistent === true && f.geometry.msgs.some((m) => /115\.6 ft/.test(m)), 'PKN chosen; radial 2R 115.6 ft > 50 ft barriers');
      near(assert, f.Gamma, 9.49, 5e-3, 'Γ (psi/√min)'); near(assert, f.GammaPKN, 15.2, 0.05, 'Γ_PKN');
    },
  },
  {
    name: 'P8 V_L during pumping 14.04 ft³ (all geometries)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx), f = fracRef(G, fixRun(G), 7000);
      ['PKN', 'KGD', 'radial'].forEach((m) => near(assert, f.geometry.byModel[m].VLpump * BBL, 14.04, 0.01, m + ' V_L pumping (ft³)'));
    },
  },
  {
    name: 'P9 q_L 0.500 → 0.0405 bbl/min from shut-in to closure; 22.5 bbl leaked after shut-in (25 bbl in total)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx), r = fixRun(G), f = fracRef(G, r, 7000), lr = G.PRiSM_dfit_leakoffRate(r.d, f);
      assert(lr.ok === true, 'leak-off rate ok');
      near(assert, lr.qL[0], 0.500, 5e-4, 'q_L at shut-in'); near(assert, lr.qL[lr.qL.length - 1], 0.0405, 2e-4, 'q_L at closure');
      near(assert, lr.VL[lr.VL.length - 1] - lr.VL[0], 22.5, 0.05, 'leaked after shut-in (bbl)'); near(assert, lr.VL[lr.VL.length - 1], 25, 0.05, 'leaked in total');
      near(assert, lr.Vf[0], f.AfCf * 600, 1e-3, 'V_f at shut-in'); assert(lr.Vf[lr.Vf.length - 1] === 0, 'V_f = 0 at closure');
      for (let i = 1; i < lr.qL.length; i++) if (!(lr.qL[i] <= lr.qL[i - 1] + 1e-12)) { assert.fail('q_L not decreasing at ' + i); break; }
    },
  },
  {
    name: 'P10 k from CL 2.75e-3 md at Δp_CL 2,800 psi (÷ 2 correction shown)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx), f = fracRef(G, fixRun(G), 7000), k = f.kBefore.kCL;
      near(assert, k.k, 2.75e-3, 5e-6, 'k from CL (md)'); near(assert, k.dpCL, 2800, 1e-6, 'Δp_CL = ½(ISIP + σ_c) − p_r');
      assert(k.factor === 2 && Math.abs(k.kCorr - k.k / 2) < 1e-12, 'the practice correction ÷ 2 (reads high)');
    },
  },
  {
    name: 'P11 closure forecast: σ 7,200 → 2.46 h, 6,800 → 8.63 h (and the ±0.02 psi/ft prior band)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx), d = fixRun(G).d;
      const fc = G.PRiSM_dfit_forecastClosure(d, { isip: 7600 }, [7200, 6800]);
      near(assert, fc[0].dtc, 2.46, 5e-3, 'σ 7,200'); near(assert, fc[1].dtc, 8.63, 5e-3, 'σ 6,800'); near(assert, fc[0].Gc, 12, 1e-3, 'G_c,f');
      const I = inputsRef(); I.priors.sigmaGrad = 0.70; I.priors.sigmaGradSd = 0.02;
      const fb = G.PRiSM_dfit_forecastClosure(d, { isip: 7600, inputs: I });
      assert(fb.length === 3 && Math.abs(fb[0].dtc - 2.46) < 5e-3 && Math.abs(fb[2].dtc - 8.63) < 5e-3, 'prior band brackets closure between 2.46 and 8.63 h');
    },
  },
  {
    name: 'P12 fissure PDL: C_d 0.0040 ± 0.0002 recovered over the hump',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx), r = synthRun(G, Object.assign({}, BASE, { Cd: 0.004, pfo: 7350 }));
      const c = classify(G, r);
      assert(c.ok === true && c.type === 'pdl' && c.pdl, 'PDL classified with a pdl block'); okShape(assert, 'Classification', c);
      near(assert, c.pdl.Cd, 0.0040, 0.0002, 'C_d'); near(assert, c.pdl.pfo, 7350, 15, 'p_fo');
      near(assert, c.pdl.multAtIsip, Math.exp(c.pdl.Cd * (r.d.isip - c.pdl.pfo)), 1e-3, 'multiplier at the ISIP');
    },
  },
  {
    name: 'P13 κ_exp from a stubbed w_c = 1 run (58 not merged) and the matrix classification',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx), P = Object.assign({}, BASE, { nMat: 1 }), r = synthRun(G, P);
      const fc = G.PRiSM_dfit_frac(7000, r.d, { events: r.ev, isip: r.d.isip, inputs: r.I, ViStar: 25, VwCw });
      // stub of PRiSM_dfit_lkSimulate (WP4): a w_c = 1 run with the same reservoir-controlled decline, on its own G grid
      const prevS = G.PRiSM_dfit_lkSimulate, prevD = G.PRiSM_dfit_lkDefaults;
      let calls = 0;
      try {
        G.PRiSM_dfit_lkDefaults = () => ({ mode: 'propagate', geometry: 'PKN', schedule: [{ t: 0, q: 5 }], sigmaC: 7000, pr: 4500 });
        G.PRiSM_dfit_lkSimulate = (cfg, opts) => {
          calls++;
          assert(cfg.wc === 1 && opts.grid === 'coarse' && cfg.sigmaC === 7000 && cfg.pr === 4500, 'a coarse w_c = 1 run on the case values');
          const Gg = [], t = [], pw = [];
          for (let k = 0; k <= 200; k++) { const g = 25 * k / 200; Gg.push(g); t.push(0.1 + g); }
          const pm = G.PRiSM_dfit_vcModel(Gg, P, {});
          pm.forEach((v) => pw.push(v));
          return { ok: true, t, pw, Ggen: Gg, events: { ts: 0.05 } };
        };
        const c = classify(G, r, { frac: fc, Gc: fc.Gc });
        assert(calls === 1, 'one coarse run');
        assert(c.ok === true && c.curvExpSource === 'model', 'κ_exp read from the model run');
        near(assert, c.features.curvExp, c.features.curv, 0.03, 'κ_exp ≈ κ (reservoir-controlled decline)');
        assert(c.features.curv < -0.1, 'dP/dG falls ' + (-c.features.curv * 100).toFixed(0) + ' % to closure');
        assert(c.type === 'matrix' || c.alt.indexOf('matrix') >= 0, 'matrix classification (got ' + c.type + ')');
      } finally { G.PRiSM_dfit_lkSimulate = prevS; G.PRiSM_dfit_lkDefaults = prevD; }
      // without 58 the quasi-static form is used and flagged
      const c2 = classify(G, r, { frac: fc, Gc: fc.Gc });
      assert(c2.curvExpSource === 'quasi-static' && Math.abs(c2.features.curvExp - ((7000 - 4500) / (r.d.isip - 4500) - 1)) < 1e-3, 'quasi-static fallback');
    },
  },
  {
    name: 'P14 R_vis 0.979 (water-filled) / 0.54 (gas-filled wellbore, C_sys 0.388 ft³/psi)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx), r = fixRun(G);
      near(assert, fracRef(G, r, 7000).Rvis, 0.979, 5e-4, 'water-filled');
      const VwG = (0.388 - 0.2105) / BBL, ViStar = (0.388 / BBL) * 600 / G.PRiSM_dfit_eta(18, 0.5);
      const fg = fracRef(G, r, 7000, { VwCw: VwG, ViStar });
      near(assert, fg.Csys * BBL, 0.388, 5e-4, 'C_sys'); near(assert, fg.Rvis, 0.54, 0.005, 'gas-filled');
      assert(fg.eta.etaF < fg.eta.matched, 'η_f shown below η_G when R_vis < 0.95');
    },
  },
  {
    name: 'P15 classifier on vcModel signatures: normal and matrix',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx);
      const rn = synthRun(G, BASE), cn = classify(G, rn, { frac: G.PRiSM_dfit_frac(7000, rn.d, { events: rn.ev, isip: rn.d.isip, inputs: rn.I, ViStar: 25, VwCw }) });
      assert(cn.ok === true && cn.type === 'normal', 'normal (got ' + cn.type + ')'); okShape(assert, 'Classification', cn);
      assert(Math.abs(cn.features.iota) < 0.05 && Math.abs(cn.features.curv) < 0.05 && cn.features.unitSlopeSink === false, 'normal features');
      assert(cn.evidence[0].length < 300 && /classified normal/.test(cn.evidence[0]), 'evidence sentence with computed numbers');
      const P = Object.assign({}, BASE, { nMat: 1 }), rm = synthRun(G, P);
      const fm = G.PRiSM_dfit_frac(7000, rm.d, { events: rm.ev, isip: rm.d.isip, inputs: rm.I, ViStar: 25, VwCw });
      const cm = classify(G, rm, { frac: fm, Gc: fm.Gc });
      assert(cm.type === 'matrix' || cm.alt.indexOf('matrix') >= 0, 'matrix (got ' + cm.type + ', alt ' + cm.alt + ')');
      assert(cm.type !== 'normal', 'not normal');
    },
  },
  {
    name: 'P16 classifier on vcModel signatures: PDL, contact / height recession (hr-contact), tip extension',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx);
      const rp = synthRun(G, Object.assign({}, BASE, { Cd: 0.004, pfo: 7350 })), cp = classify(G, rp);
      assert(cp.type === 'pdl' && cp.features.H > 0.05, 'PDL (got ' + cp.type + ')');
      const toy = Object.assign({}, BASE, { law: 'exp', sc: 100, fres: 0.1 });
      const rc = synthRun(G, toy), cc = classify(G, rc);
      assert(cc.type === 'hr-contact' || cc.alt.indexOf('hr-contact') >= 0, 'asperity contact → hr-contact (got ' + cc.type + ')');
      assert(cc.features.curv > 0.1 && cc.hr && cc.hr.Rs > 1, 'stiffening: κ > 0.1, R_s > 1');
      const rh = synthRun(G, Object.assign({}, BASE, { hrStep: 300, hrFrac: 0.5 })), ch = classify(G, rh);
      assert(ch.type === 'hr-contact' || ch.alt.indexOf('hr-contact') >= 0, 'height recession → hr-contact (got ' + ch.type + ')');
      const rt = synthRun(G, Object.assign({}, BASE, { tipA: 0.3 }));
      const ft = G.PRiSM_dfit_frac(7000, rt.d, { events: rt.ev, isip: rt.d.isip, inputs: rt.I, ViStar: 25, VwCw });
      const ct = classify(G, rt, { frac: ft, Gc: ft.Gc });
      assert(ct.type === 'tip' || ct.alt.indexOf('tip') >= 0, 'tip extension (got ' + ct.type + ')');
      assert(ct.evidence.some((e) => /Alternatives to tip extension/.test(e)) || ct.type !== 'tip', 'alternative causes listed for tip extension');
    },
  },
  {
    name: 'P17 storage with a pressure-dependent wellbore; constant C_sys with R_vis > 0.7 is not storage; a constant sink raises unitSlopeSink',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx);
      const Vg = 0.6 / BBL, Pg = Object.assign({}, BASE, { VwCw: Vg, cwOfP: 'gas', phiGas: 0.6, K: (600 / 18) * (AfCf + Vg) });
      const rg = synthRun(G, Pg);
      const ViS = (AfCf + Vg) * 600 / G.PRiSM_dfit_eta(18, 0.5);
      const fg = G.PRiSM_dfit_frac(7000, rg.d, { events: rg.ev, isip: rg.d.isip, inputs: rg.I, ViStar: ViS, VwCw: Vg });
      const cg = classify(G, rg, { frac: fg, VwCwOfP: (p) => Vg * (0.4 + 0.6 * 7600 / p), VwCwTheory: Vg, VwCwMeasured: Vg * 2.5 });
      assert(cg.type === 'storage', 'pressure-dependent wellbore with R_vis ' + cg.features.Rvis + ' → storage (got ' + cg.type + ')');
      assert(cg.features.curvWb < 0 && cg.features.VwCwRatio === 2.5, 'κ_wb from C_sys(p) and the measured/theory ratio');
      // constant C_sys, R_vis 0.8: storage rescales m_G but not the shape → not storage
      const Vc = AfCf / 4, Pc = Object.assign({}, BASE, { VwCw: Vc, K: (600 / 18) * (AfCf + Vc) }), rcs = synthRun(G, Pc);
      const fc = G.PRiSM_dfit_frac(7000, rcs.d, { events: rcs.ev, isip: rcs.d.isip, inputs: rcs.I, ViStar: (AfCf + Vc) * 600 / G.PRiSM_dfit_eta(18, 0.5), VwCw: Vc });
      const cc = classify(G, rcs, { frac: fc });
      near(assert, cc.features.Rvis, 0.8, 0.01, 'R_vis'); assert(cc.type !== 'storage' && cc.alt.indexOf('storage') < 0, 'not storage (got ' + cc.type + ')');
      // a near-constant-rate sink: p falls linearly in time (log-log slope 1 past ΔtD 1)
      const rs = synthRun(G, null, { pfun: (dt) => 7600 - 40 * dt, tEnd: 8 });
      const cs = classify(G, rs);
      assert(cs.features.unitSlopeSink === true && cs.evidence.some((e) => /constant-rate sink/.test(e)), 'unitSlopeSink raised');
      assert(cs.type !== 'storage', 'a unit slope is not a storage class');
    },
  },
  {
    name: 'P18 storage chain: V_w·c_w 0.178 and A_f·c_f 0.2105 ft³/psi → R_vis 0.542 ± 0.01 and A_f·c_f within 1 %',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx), Af = 0.2105 / BBL, Vw = 0.178 / BBL;
      const P = Object.assign({}, BASE, { AfCf: Af, VwCw: Vw, K: (600 / 18) * (Af + Vw) }), r = synthRun(G, P);
      const picks = G.PRiSM_dfit_closurePicks(r.d, { inputs: r.I, isipValue: r.d.isip, varcomp: false });
      const comp = picks.filter((p) => p.method === 'compliance')[0];
      near(assert, comp.p, 7000, 5, 'closure found on the storage-affected data');
      near(assert, r.d.mG, 600 / 18, 0.01, 'm_G = X/C_sys from the data');
      // V_i* consistent with the closure balance η_G·V_i* = C_sys·p_n of the model
      const ViStar = (Af + Vw) * 600 / G.PRiSM_dfit_eta(18, 0.5);
      const f = G.PRiSM_dfit_frac(comp.p, r.d, { events: r.ev, isip: r.d.isip, inputs: r.I, ViStar, VwCw: Vw });
      near(assert, f.Rvis, 0.542, 0.01, 'R_vis'); assert(Math.abs(f.AfCf / Af - 1) < 0.01, 'A_f·c_f within 1 %: ' + (f.AfCf * BBL).toFixed(4) + ' ft³/psi');
      near(assert, f.X, (Af + Vw) * (600 / 18), 0.01 * (Af + Vw) * (600 / 18), 'X = C_sys·m_G (leak-off per unit G)');
      assert(f.geometry.byModel.PKN.xf < 131.2 * 1.05 && f.geometry.byModel.PKN.xf > 131.2 * 1.0, 'xf from A_f·c_f, not from C_sys (no 1/R_vis inflation)');
    },
  },
  {
    name: 'P19 stress-log calibration offset 667 psi and pad fraction 0.053–0.010 on the reference',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx), f = fracRef(G, fixRun(G), 7000);
      near(assert, f.stressCal.dSigmaTect, 666.7, 0.1, 'Δσ_tect = 7,000 − [(1/3)·5,500 + 4,500]');
      near(assert, f.stressCal.sigmaModel, 6333.3, 0.1, 'model stress'); assert(f.stressCal.biot === 1, 'Biot 1');
      near(assert, f.padFraction.hi, 0.053, 5e-4, '(1 − η)/(1 + η)'); near(assert, f.padFraction.lo, 0.010, 5e-4, '(1 − η)²');
    },
  },
  {
    name: 'P20 h-function (gate G6): not verified in 3.4a → hFn null, kH null, far-field null (moved to 3.4b)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx), r = fixRun(G), f = fracRef(G, r, 7000);
      assert(G.PRiSM_dfit_hFn(1, {}) === null && G.PRiSM_dfit_hFn.gate.verified === false, 'hFn returns null until gate G6');
      assert(r.d.h === null && f.kBefore.kH === null && f.farField === null, 'Derivs.h, kH and the far-field reading are null');
      assert(G.PRiSM_dfit_farField(r.d, r.ev, {}) === null, 'farField null');
    },
  },
  {
    name: 'P21 masked samples never reach a derivative as null (no spike at the mask edge)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx), I = inputsRef();
      I.channels.mask = [[1.0, 1.5, 'vacuum']];
      const r = fixRun(G, { inputs: I });
      assert(r.prep.applied.masked > 0 && r.prep.t.every((t) => t < 1.0 || t > 1.5), 'masked samples removed (' + r.prep.applied.masked + ')');
      okShape(assert, 'Prepared', r.prep); okShape(assert, 'Derivs', r.d);
      const d = r.d, edge = d.dt.findIndex((dt) => dt + d.ts > 1.5);
      let worst = 0;
      for (let i = Math.max(0, edge - 3); i <= edge + 3; i++) if (d.usable[i]) worst = Math.max(worst, Math.abs(d.GdPdG[i] / (REF.mG * d.G[i]) - 1));
      assert(worst < 0.01, 'no spike at the mask edge (worst ' + worst.toFixed(4) + ')');
      assert(d.p.every((v) => typeof v === 'number' && isFinite(v)) && d.G.every((v) => typeof v === 'number' && isFinite(v)), 'no null in the numeric arrays');
    },
  },
  {
    name: 'P22 the frictional check uses p_p at the lower bracket edge and S_v 0.9 psi/ft for the veto',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx), I = inputsRef(), f = (mu) => Math.pow(Math.sqrt(mu * mu + 1) + mu, 2);
      const b = G.PRiSM_dfit_bounds(6000, { inputs: I, pi: 4500, piBracket: [4300, 4700], isip: 7600 });
      near(assert, b.frictional.veto, 4300 + (9000 - 4300) / f(1.0), 0.1, 'veto: μ 1.0, p_p 4,300 (lower edge), S_v 9,000');
      near(assert, b.frictional.warn, 4500 + (10000 - 4500) / f(0.6), 0.1, 'warning: μ 0.6, p_p 4,500 (C1), S_v 10,000');
      assert(b.admissible === true && b.warnings.some((w) => w.rule === 'frictional'), '6,000 psia is between the lines: warned, kept');
      const v = G.PRiSM_dfit_bounds(5000, { inputs: I, pi: 4500, piBracket: [4300, 4700], isip: 7600 });
      assert(v.admissible === false && v.vetoes.some((w) => w.rule === 'frictional'), '5,000 psia vetoed');
      const h = G.PRiSM_dfit_bounds(5200, { inputs: I, isip: 7600 });
      near(assert, h.frictional.veto, 0.052 * 8.33 * 10000 + (9000 - 0.052 * 8.33 * 10000) / f(1.0), 0.1, 'p_p hydrostatic when no bracket');
      const o = G.PRiSM_dfit_bounds(7700, { inputs: I, pi: 4500, isip: 7600 });
      assert(o.admissible === false && o.vetoes.some((w) => w.rule === 'order'), 'σ_c ≥ ISIP vetoed (order)');
      [b, v, h, o].forEach((x) => x.vetoes.concat(x.warnings).forEach((w) => assert(w.text.length < 300 && !/\b(null|undefined|NaN|Infinity)\b/.test(w.text), 'plain text')));
    },
  },
];
