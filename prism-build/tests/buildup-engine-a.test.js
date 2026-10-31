// prism-build/tests/buildup-engine-a.test.js — WP1 automatic interpretation engine, EN1–EN11
// (docs/BUILDUP-SURVEILLANCE-PLAN.md §9 WP1). One fresh app per test.
//
// Synthetic build-ups come from a small generator in this file: the PRiSM registry kernels on a fine
// 40-per-decade table (cubic Hermite in ln tD with the exact pd′) superposed over the FULL rate history,
// not the engine's 10-per-decade grid or its compacted history.
'use strict';
const shapes = require('./_buildup-shapes');

function lcg(seed) {
  let s = seed >>> 0;
  const u = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
  return { u, n: () => { const a = u(), b = u(); return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b); } };
}
const WELL = { h: 50, phi: 0.2, mu: 1, B: 1.2, ct: 1e-5, rw: 0.354 };
// o: {k, S, C, q, steps|tp, dtEnd, dtFirst, perCycle, model, params, sigma, seed, well, falloff, extra(dt), ...spec overrides}
function synth(W, o) {
  const M = W.PRiSM_MODELS;
  const well = Object.assign({}, WELL, o.well || {});
  const model = o.model || 'homogeneous';
  const Cd = 0.8936 * o.C / (well.phi * well.ct * well.h * well.rw * well.rw);
  const Bt = 0.0002637 * o.k / (well.phi * well.mu * well.ct * well.rw * well.rw);
  const A1 = 141.2 * well.B * well.mu / (o.k * well.h);
  const params = Object.assign({ Cd, S: o.S }, o.params || {});
  const steps = o.steps || [{ t: 0, q: o.q }, { t: o.tp || 720, q: 0 }];
  const tc = steps[steps.length - 1].t;
  const dtEnd = o.dtEnd || 72, dtFirst = o.dtFirst || 0.001, per = o.perCycle || 60;
  const dts = [];
  for (let i = 0; ; i++) { const x = dtFirst * Math.pow(10, i / per); if (x > dtEnd * (1 + 1e-12)) break; dts.push(x); }
  if (dts[dts.length - 1] < dtEnd * (1 - 1e-9)) dts.push(dtEnd);
  const tdMin = Bt * dts[0] / 2, tdMax = Bt * (tc - steps[0].t + dtEnd) * 2, tper = 40;
  const j0 = Math.floor(Math.log10(tdMin) * tper) - 2, j1 = Math.ceil(Math.log10(tdMax) * tper) + 2;
  const tds = []; for (let j = j0; j <= j1; j++) tds.push(Math.pow(10, j / tper));
  const lin = model === 'closedCircle' ? 2 / (params.reD * params.reD) : 0;
  const pdv = M[model].pd(tds, params), pdp = M[model].pdPrime(tds, params);
  const g = tds.map((t, i) => pdv[i] - lin * t), gp = tds.map((t, i) => pdp[i] - lin * t);
  const H = Math.LN10 / tper;
  const pd = (td) => {
    const u = Math.log10(td) * tper, jf = Math.floor(u), tau = u - jf; let ix = jf - j0;
    if (ix < 0) ix = 0; if (ix > g.length - 2) ix = g.length - 2;
    const t2 = tau * tau, t3 = t2 * tau;
    return (2 * t3 - 3 * t2 + 1) * g[ix] + (t3 - 2 * t2 + tau) * H * gp[ix] + (-2 * t3 + 3 * t2) * g[ix + 1] + (t3 - t2) * H * gp[ix + 1] + lin * td;
  };
  const dq = steps.map((s, i) => s.q - (i ? steps[i - 1].q : 0));
  const sgn = o.falloff ? -1 : 1, pi = o.pi || 5000;
  let D0 = 0; for (let i = 0; i < steps.length - 1; i++) if (dq[i]) D0 += dq[i] * pd(Bt * (tc - steps[i].t));
  const pwf0 = pi - sgn * A1 * D0;
  const rng = lcg(o.seed || 1), sig = o.sigma || 0;
  const p = dts.map((dt) => {
    let D = 0; for (let i = 0; i < steps.length; i++) if (dq[i]) D += dq[i] * pd(Bt * (tc + dt - steps[i].t));
    return pi - sgn * A1 * D + (sig ? sig * rng.n() : 0) + (o.extra ? o.extra(dt) : 0);
  });
  const spec = {
    id: o.id || 'B1', testType: o.falloff ? 'falloff' : 'buildup', tc_h: tc, dtc_h: o.dtc_h || 0, pwf0, pwf0SE: o.pwf0SE || 0,
    dpdt_flow: o.dpdt != null ? o.dpdt : 0, dt: dts, p, n: null, steps, qUnit: o.qUnit || 'STB/d', Dq: steps[steps.length - 2].q, fRate: 1,
    rateQC: Object.assign({ source: 'table', r3: null, r3Status: 'n/a', r4: null, r4Status: 'n/a', dqKnown: true, dqSource: 'table',
                            equalRateAssumed: false, ignoresShutin: false, allocAccPct: 5 }, o.rateQC || {}),
    well: Object.assign({ fluid: o.fluid || 'oil', T_R: null, re_ft: null, defaulted: [] }, well),
    gas: o.gas || null, sigma_psi: sig, sigmaFlow_psi: sig, sigmaLF_psi: o.sigmaLF != null ? o.sigmaLF : 0, dtSample_h: 1 / 60,
    driftPsiPerDay: 0.01, history: o.history || { estimated: false, tPrepend_h: 0, source: 'data' },
    overrides: Object.assign({ window: null, model: null, excludeRivals: [] }, o.overrides || {}),
    opts: Object.assign({ Lcyc: 0.1, binsPerCycle: 20, fitBinsPerCycle: 12, rivals: 'auto', cheld: 'auto', tide: 'auto' }, o.opts || {}),
  };
  return { spec, truth: { k: o.k, S: o.S, C: o.C, Cd, Bt, A1, pi, pd, mp: 70.6 * steps[steps.length - 2].q * well.B * well.mu / (o.k * well.h) } };
}
const AIof = (app) => app.win.PRiSM_autoInterp;
const prepOf = (app, spec) => AIof(app).prepare(app.toWin(spec));
const run = (app, spec, opts) => JSON.parse(JSON.stringify(AIof(app).interpret(app.toWin(spec), app.toWin(opts || {}))));
function shapeOk(assert, name, obj) {
  const r = shapes.checkShape(name, JSON.parse(JSON.stringify(obj)));
  assert.ok(r.ok, name + ' shape: ' + r.errors.slice(0, 6).join(' | '));
}
const REF = { k: 45, S: 5, C: 0.02, q: 800, tp: 720 };          // reference case (h 50, μ 1, B 1.2, φ 0.2, ct 1e-5, rw 0.354)
const LONG = (o) => Object.assign({ steps: [{ t: 0, q: 800 }, { t: 2000, q: 0 }], dtEnd: 400 }, o);

module.exports = [
  {
    name: 'EN1 derivative: IARF plateau = 70.6·qBμ/kh within 0.2 %; mask false within L of both ends; negatives in neg, never logged',
    wp: 'WP1',
    run(app, assert) {
      const AI = AIof(app);
      const q = 800, B = 1.2, mu = 1, k = 45, h = 50, m = 162.6 * q * B * mu / (k * h), tp = 720;
      const dte = [], dp = [];
      for (let i = 0; i <= 80; i++) { const dt = 0.01 * Math.pow(10, i / 20); const e = tp * dt / (tp + dt); dte.push(e); dp.push(m * Math.log10(e) + 300); }
      const X = dte.map(Math.log);
      const r = AI.derivative(app.toWin(X), app.toWin(dp), 0.1);
      assert.near(r.L_ln, 0.1 * Math.LN10, 1e-12, 'L in ln units');
      const plateau = 70.6 * q * B * mu / (k * h);
      r.deriv.forEach((v, i) => { if (r.full[i]) assert.rel(v, plateau, 0.002, 'plateau at ' + i); });
      for (let i = 0; i < X.length; i++) {
        const left = X[i] - X[0] < r.L_ln * (1 - 1e-9), right = X[X.length - 1] - X[i] < r.L_ln * (1 - 1e-9);
        if (left || right) { assert.equal(r.full[i], false, 'masked near the ends at ' + i); assert.equal(r.deriv[i], null); }
      }
      const Xu = []; for (let i = 0; i < 30; i++) Xu.push(i * 0.05 * Math.LN10);
      const ru = AI.derivative(app.toWin(Xu), app.toWin(Xu.map((x) => 3 * x)), 0.1);
      assert.equal(ru.full[2], true, 'two bins of 0.05 cycle give a full window at L = 0.1 cycle');
      assert.equal(ru.full[1], false);
      // a falling segment: negative values stay as numbers and are listed in neg
      const dp2 = dp.map((v, i) => (i > 60 ? v - 40 * (i - 60) : v));
      const r2 = AI.derivative(app.toWin(X), app.toWin(dp2), 0.1);
      assert.ok(r2.neg.length > 0, 'negative derivatives listed');
      r2.neg.forEach((i) => { assert.ok(r2.deriv[i] <= 0 && r2.full[i]); });
      assert.ok(r2.deriv.every((v) => v === null || Number.isFinite(v)), 'no NaN (negatives are never logged)');
      // the engine never takes logs of them: a prepared case with a falling tail stays finite
      const { spec } = synth(app.win, Object.assign({}, REF, { extra: (dt) => (dt > 40 ? -3 * (dt - 40) : 0) }));
      const res = run(app, spec, { rivals: 'none' });
      assert.ok(res.ok, 'interpretation ran');
      assert.ok(res.bins.deriv.some((v) => v !== null && v <= 0), 'negative late derivative kept');
      assert.ok(res.flags.some((f) => f.code === 'negLate'), 'negLate flag');
      shapeOk(assert, 'BuildupResult', res);
    },
  },
  {
    name: 'EN2 bin: 20 per cycle, medians, counts; single-sample bins raw; count-weighted re-binning',
    wp: 'WP1',
    run(app, assert) {
      const AI = AIof(app);
      const dt = [], p = [];
      for (let i = 0; i < 200; i++) { dt.push(0.01 * Math.pow(10, i / 100)); p.push(1000 + i); }
      const b = AI.bin(app.toWin(dt), app.toWin(p), app.toWin({ perCycle: 20 }));
      assert.equal(b.dt.length, 40, '2 cycles at 20 per cycle');
      assert.ok(b.n.every((n) => n === 5), 'five samples per bin');
      assert.equal(b.p[0], 1002, 'median of the first bin');
      assert.equal(b.dt[3], dt[17], 'median Δt of bin 3');
      // sparse early samples: each sample is its own bin and keeps its raw value
      const dt2 = [0.001, 0.0013, 0.0019, 0.01, 0.0102, 0.0104], p2 = [5, 6, 7, 8, 9, 30];
      const b2 = AI.bin(app.toWin(dt2), app.toWin(p2), app.toWin({ perCycle: 20 }));
      assert.deepEqual(Array.from(b2.dt.slice(0, 3)), [0.001, 0.0013, 0.0019]);
      assert.deepEqual(Array.from(b2.p.slice(0, 3)), [5, 6, 7]);
      assert.equal(b2.n[3], 3); assert.equal(b2.p[3], 9);
      // pre-binned input with counts: weighted median, counts add up
      const b3 = AI.bin(app.toWin([1, 1.01, 1.02]), app.toWin([10, 20, 30]), app.toWin({ perCycle: 20, counts: [1, 1, 5] }));
      assert.equal(b3.n[0], 7); assert.equal(b3.p[0], 30);
    },
  },
  {
    name: 'EN3 IARF: reference 72 h fair (start ±0.1 cycle of 15.5 h, span 0.5–0.65, longest reported); 400 h good; 600 ft fault → window ends before the 15 % departure, T-up fires',
    wp: 'WP1',
    run(app, assert) {
      const AI = AIof(app);
      const { spec } = synth(app.win, Object.assign({ dtEnd: 72 }, REF));
      const prep = prepOf(app, spec);
      assert.ok(prep.ok);
      const ir = AI.iarf(prep);
      shapeOk(assert, 'Iarf', AI.clean(ir));
      assert.equal(ir.grade, 'fair'); assert.equal(ir.found, true); assert.equal(ir.noiseWidened, false);
      assert.within(Math.log10(ir.dt0_h / 15.5), -0.1, 0.1, 'start within ±0.1 cycle of 15.5 h (' + ir.dt0_h + ')');
      assert.within(ir.cycles, 0.5, 0.65, 'span');
      assert.ok(ir.longest && ir.longest.cycles >= ir.cycles, 'longest qualifying window reported');
      assert.near(ir.X1 - ir.X0, ir.cycles, 1e-9, 'cycles = X1 − X0 (log10 Δt_e)');
      assert.includes(ir.reason, 'earliest plateau');
      // 400 h → good
      const g = run(app, synth(app.win, LONG({ k: 45, S: 5, C: 0.02, q: 800 })).spec);
      assert.equal(g.iarf.grade, 'good', 'long test is good');
      assert.ok(g.iarf.cycles >= 1);
      // sealing fault at 600 ft (short storage so the plateau exists)
      const L = 600, f = synth(app.win, LONG({ k: 45, S: 0, C: 0.002, q: 800, model: 'linearBoundary', params: { dF: L / 0.354, BC: 'noflow' } }));
      const rf = run(app, f.spec);
      assert.ok(rf.iarf.found, 'IARF before the fault');
      const t15 = L * L * 0.2 * 1 * 1e-5 / (0.0002637 * 45 * Math.log(1 / 0.15));   // image term adds 15 %
      const tp = 2000, dteEnd1 = rf.iarf.dt1_h * tp / (tp + rf.iarf.dt1_h);
      assert.ok(dteEnd1 < t15, 'window ends (Δt_e ' + dteEnd1.toFixed(1) + ' h) before the 15 % departure (' + t15.toFixed(1) + ' h)');
      assert.ok(rf.triggers.up && rf.triggers.fired.indexOf('T-up') >= 0, 'T-up fires');
      shapeOk(assert, 'BuildupResult', rf);
    },
  },
  {
    name: 'EN4 composite direction and earliest plateau: M 0.5 → inner level, T-down, composite M < 1; M 2 → T-up, M within 10 %; a dual-porosity valley is never chosen',
    wp: 'WP1', timeoutMs: 180000,
    run(app, assert) {
      const c1 = synth(app.win, LONG({ k: 45, S: 0, C: 0.0005, q: 800, model: 'radialComposite', params: { M: 0.5, F: 1, R: 600 / 0.354 } }));
      const r1 = run(app, c1.spec);
      assert.ok(r1.iarf.found);
      assert.rel(r1.iarf.level_psi, c1.truth.mp, 0.03, 'window on the inner level');
      assert.ok(r1.triggers.down, 'T-down fires');
      const comp1 = r1.models.find((m) => m.key === 'composite2');
      assert.ok(comp1 && comp1.ok && comp1.phys.M < 1, 'composite fitted with M < 1');
      assert.rel(comp1.phys.M, 0.5, 0.1, 'M recovered');
      assert.equal(r1.chosen.key, 'composite2', 'composite chosen');
      assert.ok(r1.iarf.secondLevel || r1.models.some((m) => m.key === 'composite2'), 'outer level evidence');
      const c2 = synth(app.win, LONG({ k: 45, S: 0, C: 0.002, q: 800, model: 'radialComposite', params: { M: 2, F: 1, R: 1000 / 0.354 } }));
      const r2 = run(app, c2.spec);
      assert.ok(r2.triggers.up, 'T-up fires');
      const comp2 = r2.models.find((m) => m.key === 'composite2');
      assert.ok(comp2 && comp2.phys.M > 1, 'composite fitted with M > 1');
      assert.rel(comp2.phys.M, 2, 0.1, 'M within 10 %');
      // dual porosity: the valley is never the IARF window
      const dpz = synth(app.win, LONG({ k: 45, S: 0, C: 0.002, q: 800, model: 'doublePorosity', params: { omega: 0.05, lambda: 1e-6, interporosityMode: 'pss' } }));
      const r3 = run(app, dpz.spec);
      const valley = r3.flags.find((f) => f.code === 'valley');
      assert.ok(valley, 'valley flagged');
      assert.ok(!r3.iarf.found || r3.iarf.dt0_h > valley.dt1_h || r3.iarf.dt1_h < valley.dt0_h, 'window outside the valley');
      assert.rel(r3.iarf.level_psi, dpz.truth.mp, 0.03, 'the late (total-system) plateau is the window');
      assert.equal(r3.confidence.model, 'low', 'distractor → model label low');
    },
  },
  {
    name: 'EN5 noise: σ 0.5 psi at kh 40,000 → widened within caps, fair (noise-widened), noiseLimited, KH1 fails; beyond the caps → none, reason noise; se_s from the noise model only',
    wp: 'WP1', timeoutMs: 120000,
    run(app, assert) {
      const AI = AIof(app);
      const base = { k: 800, S: 2, C: 0.01, q: 800, steps: [{ t: 0, q: 800 }, { t: 2000, q: 0 }], dtEnd: 150, perCycle: 60 };
      const n1 = synth(app.win, Object.assign({}, base, { sigma: 0.5, seed: 11 }));
      const p1 = prepOf(app, n1.spec);
      const i1 = AI.iarf(p1);
      assert.equal(i1.found, true, 'window found: ' + i1.reason);
      assert.equal(i1.noiseWidened, true, 'noise-widened');
      assert.equal(i1.grade, 'fair');
      assert.equal(i1.noiseLimited, true);
      assert.ok(i1.band <= 0.20 + 1e-12 && i1.slopeTol <= 0.06 + 1e-12 && (i1.band > 0.10 || i1.slopeTol > 0.03), 'widened within the caps');
      const ev = { grade: i1.grade, noiseWidened: true, span: i1.cycles, pointSkinSpread: 0.1, agree: true, sErr: 0.3, unitSlope: true, r3Status: 'n/a', r4Status: 'n/a', snrD: 50, rDrift: 0, rTide: null, flags: [], triggers: [], chosenKey: 'homogeneous', chosenFullySeen: 'n/a', dtEnd_h: 150, dteEnd_h: 140, t10_h: 1, kHeld: false };
      const cf = AI.confidence(app.toWin(ev), app.toWin(shapes.FIX.cal));
      assert.ok(cf.reasons.some((r) => r.rule === 'KH1' && r.kind === 'unmet'), 'KH1 fails for a noise-widened window');
      // noise far beyond the caps
      const n2 = synth(app.win, Object.assign({}, base, { sigma: 20, seed: 12 }));
      const i2 = AI.iarf(prepOf(app, n2.spec));
      assert.equal(i2.grade, 'none'); assert.equal(i2.found, false);
      assert.includes(i2.reason, 'noise');
      // se_s comes from the noise model: the same bins and σ with a different curvature give the same slopeSE
      const a = synth(app.win, Object.assign({}, REF, { dtEnd: 72, sigma: 0.012, seed: 3 }));
      const b2 = synth(app.win, Object.assign({}, REF, { dtEnd: 72, sigma: 0.012, seed: 3, extra: (dt) => 2 * Math.log(1 + dt / 30) }));
      const win = app.toWin({ window: { dt0_h: 15, dt1_h: 50 } });
      const sa = AI.iarf(prepOf(app, a.spec), win), sb = AI.iarf(prepOf(app, b2.spec), win);
      assert.ok(sa.slopeSE > 0, 'slopeSE from σ');
      assert.near((sb.slopeSE * sb.level_psi) / (sa.slopeSE * sa.level_psi), 1, 1e-6, 'slopeSE (psi) does not grow with curvature');
      assert.ok(Math.abs(sb.slope - sa.slope) > 0.005, 'the curvature changed the slope (' + sa.slope + ' vs ' + sb.slope + ')');
    },
  },
  {
    name: 'EN6 line: reference 72 h → k −2.6 % ± 0.5, S −0.33 ± 0.1; tp = 1 h single rate → S within 0.05 of the truth (W term)',
    wp: 'WP1',
    run(app, assert) {
      const AI = AIof(app);
      const { spec } = synth(app.win, Object.assign({ dtEnd: 72 }, REF));
      const prep = prepOf(app, spec);
      const ir = AI.iarf(prep), ln = AI.line(prep, ir);
      shapeOk(assert, 'Line', AI.clean(ln));
      assert.equal(ln.method, 'horner');
      assert.within(100 * (ln.k / 45 - 1), -3.1, -2.1, 'k bias');
      assert.within(ln.S - 5, -0.43, -0.23, 'S bias');
      assert.ok(ln.shifts.length >= 1 && ln.shifts.every((s) => Math.abs(Math.abs(s.dX) - Math.min(0.25, 0.2 * ir.cycles)) < 1e-9), 'shifted lines by min(0.25, 0.2·span)');
      assert.ok(ln.plateauCheck && typeof ln.plateauCheck.pass === 'boolean', 'line vs derivative plateau kept');
      // tp = 1 h: the superposition W term keeps S right
      const s2 = synth(app.win, { k: 300, S: 2, C: 0.0002, q: 500, tp: 1, dtEnd: 30, perCycle: 60, dtFirst: 0.0003 });
      const p2 = prepOf(app, s2.spec), i2 = AI.iarf(p2, app.toWin({ window: { dt0_h: 0.6, dt1_h: 25 } }));
      const l2 = AI.line(p2, i2);
      assert.ok(l2, 'line through the late window');
      assert.near(l2.S, 2, 0.05, 'S with tp = 1 h (' + l2.S + ')');
      assert.rel(l2.k, 300, 0.01);
    },
  },
  {
    name: 'EN7 365 daily steps: compaction ≤ 0.1 psi; homogeneous fit k ±0.5 %, S ±0.05, C ±1 %; gridBuilds ≤ 40, slices ≥ 1',
    wp: 'WP1', timeoutMs: 120000,
    run(app, assert) {
      const AI = AIof(app), W = app.win;
      const steps = []; for (let d = 0; d < 365; d++) steps.push({ t: d * 24, q: 800 * (1 + 0.15 * Math.sin(d * 1.7)) }); steps.push({ t: 365 * 24, q: 0 });
      const { spec } = synth(W, { k: 45, S: 5, C: 0.02, q: 800, steps, dtEnd: 72 });
      const prep = prepOf(app, spec);
      assert.ok(prep.ok);
      assert.ok(prep.histFit.nLumped > 300 && prep.histFit.steps.length < 40, 'compacted history');
      // compaction error: full vs compacted history through the registry model
      const full = AI.clean(prep.adata); full.rateHistory = app.toWin(steps.map((s) => ({ t: s.t, q: s.q * spec.Dq / steps[363 + 1].q })));
      const pmF = W.PRiSM_physicalModel('homogeneous', prep.well, app.toWin(full), app.toWin({ isolated: true }));
      const pmC = W.PRiSM_physicalModel('homogeneous', prep.well, prep.adata, app.toWin({ isolated: true }));
      const ph = app.toWin({ k: 45, C: 0.02, S: 5 });
      const a = pmF.dp(prep.adata.t, ph), b = pmC.dp(prep.adata.t, ph);
      let mx = 0; for (let i = 0; i < a.length; i++) mx = Math.max(mx, Math.abs(a[i] - b[i]));
      assert.ok(mx <= 0.1, 'compaction error ' + mx.toFixed(4) + ' psi');
      AI.resetStats();
      const f = AI.fit('homogeneous', prep, app.toWin({ start: { k: 40, S: 4, C: 0.025 } }));
      const st = AI.stats();
      shapeOk(assert, 'ModelFit', AI.clean(f));
      assert.ok(f.converged, 'converged: ' + f.stopReason);
      assert.rel(f.phys.k, 45, 0.005, 'k'); assert.near(f.phys.S, 5, 0.05, 'S'); assert.rel(f.phys.C, 0.02, 0.01, 'C');
      assert.ok(st.gridBuilds <= 40, 'gridBuilds ' + st.gridBuilds);
      assert.ok(st.slices >= 1 && f.slices >= 1);
    },
  },
  {
    name: 'EN8 opts.entry grid vs the registry ≤ 0.02 psi (60 daily steps); opts.isolated ignores PRiSM_state.params (BC constP set; isolated uses noflow)',
    wp: 'WP1',
    run(app, assert) {
      const AI = AIof(app), W = app.win;
      const steps = []; for (let d = 0; d < 60; d++) steps.push({ t: d * 24, q: 800 * (1 + 0.15 * Math.cos(d * 0.9)) }); steps.push({ t: 60 * 24, q: 0 });
      const { spec } = synth(W, { k: 45, S: 5, C: 0.02, q: 800, steps, dtEnd: 72, perCycle: 20 });
      const prep = prepOf(app, spec);
      const ent = AI.gridEntry('homogeneous', prep);
      const ph = app.toWin({ k: 45, C: 0.02, S: 5 });
      const pmG = W.PRiSM_physicalModel('homogeneous', prep.well, prep.adata, { entry: ent, isolated: true });   // (functions do not survive toWin)
      const pmR = W.PRiSM_physicalModel('homogeneous', prep.well, prep.adata, app.toWin({ isolated: true }));
      const a = pmG.dp(prep.adata.t, ph), b = pmR.dp(prep.adata.t, ph);
      let mx = 0; for (let i = 0; i < a.length; i++) mx = Math.max(mx, Math.abs(a[i] - b[i]));
      assert.ok(mx <= 0.02, 'grid vs registry ' + mx.toFixed(5) + ' psi');
      // isolated: categorical keys never come from PRiSM_state
      W.PRiSM_state = W.PRiSM_state || app.toWin({});
      W.PRiSM_state.model = 'linearBoundary';
      W.PRiSM_state.params = app.toWin({ Cd: 100, S: 0, dF: 1000, BC: 'constP' });
      const pmS = W.PRiSM_physicalModel('linearBoundary', prep.well, prep.adata, app.toWin({}));
      const pmI = W.PRiSM_physicalModel('linearBoundary', prep.well, prep.adata, app.toWin({ isolated: true }));
      const phF = app.toWin({ k: 45, C: 0.02, S: 5, dF: 1000 });
      assert.equal(pmS.toModelParams(phF).params.BC, 'constP', 'shared state read without isolated');
      assert.equal(pmI.toModelParams(phF).params.BC, 'noflow', 'isolated uses the default');
      const fit = W.PRiSM_fitPhysical('linearBoundary', prep.adata, prep.well, { entry: AI.gridEntry('linearBoundary', prep), isolated: true, singleStart: true, maxIter: 3, start: { k: 45, C: 0.02, S: 5, dF: 3000 } });
      assert.ok(fit.ok);
      assert.equal(fit.params.BC, 'noflow', 'isolated fit uses noflow');
    },
  },
  {
    name: 'EN8b fitPhysical(\'composite2\', …, {entry}) succeeds while PRiSM_MODELS has no composite2 key',
    wp: 'WP1',
    run(app, assert) {
      const AI = AIof(app), W = app.win;
      assert.equal(W.PRiSM_MODELS.composite2, undefined, 'not registered');
      const { spec } = synth(W, LONG({ k: 45, S: 0, C: 0.002, q: 800, model: 'radialComposite', params: { M: 2, F: 1, R: 1000 / 0.354 }, perCycle: 20 }));
      const prep = prepOf(app, spec);
      const ent = AI.gridEntry('composite2', prep);
      const fit = W.PRiSM_fitPhysical('composite2', prep.adata, prep.well, { entry: ent, isolated: true, singleStart: true, maxIter: 30, freeze: { F: true },
        start: { k: 40, C: 0.002, S: 0.5, M: 1.6, F: 1, R: 2500 } });
      assert.ok(fit.ok, fit.reason);
      assert.equal(fit.modelKey, 'composite2');
      assert.rel(fit.phys.M, 2, 0.05, 'M');
      assert.rel(fit.phys.k, 45, 0.02, 'k');
      assert.ok(fit.lmState && typeof fit.lmState.lambda === 'number' && Number.isFinite(fit.nEval), 'lmState and nEval in the result');
      // the local C3 fallback receives the entry too
      const keep = W.PRiSM_physicalModel;
      W.PRiSM_physicalModel = undefined;
      try {
        const f2 = W.PRiSM_fitPhysical('composite2', prep.adata, prep.well, { entry: ent, isolated: true, singleStart: true, maxIter: 2, mode: 'physical', freeze: { F: true }, start: { k: 45, C: 0.002, S: 0, M: 2, F: 1, R: 2825 } });
        assert.ok(f2.ok, 'fallback path: ' + f2.reason);
      } finally { W.PRiSM_physicalModel = keep; }
    },
  },
  {
    name: 'EN9 BIC on the log-Δp block: homogeneous truth, 6 noisy seeds → no rival chosen; fault seen → fault chosen; ΔBIC finite under 1,000',
    wp: 'WP1', timeoutMs: 240000,
    run(app, assert) {
      for (let s = 1; s <= 6; s++) {
        const { spec } = synth(app.win, Object.assign({ dtEnd: 96, sigma: 0.05, seed: 100 + s, perCycle: 20 }, REF, { S: 3 + s / 2 }));
        const r = run(app, spec, { rivals: s === 1 ? 'all' : 'auto' });   // seed 1 fits every rival; the others only on triggers
        assert.equal(r.chosen.key, 'homogeneous', 'seed ' + s + ' kept homogeneous: ' + JSON.stringify(r.bic.rows.map((x) => [x.key, x.dBicHom])));
        assert.equal(r.bic.basis, 'logDp');
        r.bic.rows.forEach((row) => { if (row.dBicHom !== null) assert.ok(Math.abs(row.dBicHom) < 1000, 'finite ΔBIC'); });
      }
      const f = synth(app.win, LONG({ k: 45, S: 0, C: 0.002, q: 800, sigma: 0.02, seed: 5, perCycle: 30, model: 'linearBoundary', params: { dF: 800 / 0.354, BC: 'noflow' } }));
      const rf = run(app, f.spec);
      assert.equal(rf.chosen.key, 'linearBoundary', 'fault chosen');
      const row = rf.bic.rows.find((x) => x.key === 'linearBoundary');
      assert.ok(row.dBicHom > rf.bic.tau && row.dBicHom < 1000);
      assert.ok(rf.bic.nEff > 0 && rf.bic.nEff <= rf.bic.n);
      assert.rel(rf.final.distances.dF_ft, 800, 0.05, 'fault distance');
    },
  },
  {
    name: 'EN10 agreement: reference 72 h agrees; the bias is explained within 0.1 % and 0.01',
    wp: 'WP1',
    run(app, assert) {
      const { spec } = synth(app.win, Object.assign({ dtEnd: 72 }, REF));
      const r = run(app, spec);
      shapeOk(assert, 'BuildupResult', r);
      assert.equal(r.agreement.agree, true);
      assert.ok(Math.abs(r.agreement.dkPct - r.agreement.biasKPct) <= 0.1, 'k bias explained');
      assert.ok(Math.abs(r.agreement.dS - r.agreement.biasDS) <= 0.01, 'S bias explained');
      assert.ok(r.line.shifts.every((s) => typeof s.bS === 'number'), 'each shifted line has its bias');
      assert.equal(r.final.source, 'match');
    },
  },
  {
    name: 'EN11 C-held: first sample at 0.3 h → triggered with a range; unit slope sampled → not triggered; changing storage → not meaningful; auto runs extended refits only on a non-rejected side',
    wp: 'WP1', timeoutMs: 120000,
    run(app, assert) {
      const AI = AIof(app);
      const late = synth(app.win, Object.assign({ dtEnd: 72, dtFirst: 0.3, sigma: 0.01, seed: 4 }, REF));
      AI.resetStats();
      const r1 = run(app, late.spec);
      const st1 = AI.stats();
      assert.equal(r1.storage.unitSlope, false);
      assert.equal(r1.cheld.triggered, true, 'triggered');
      assert.ok(r1.cheld.refits.length >= 2, 'pair refits ran');
      assert.ok(r1.cheld.range.C[0] <= r1.cheld.range.C[1] && r1.cheld.range.S[0] <= r1.cheld.range.S[1], 'range reported');
      const pair = r1.cheld.refits.slice(0, 2), ext = r1.cheld.refits.slice(2);
      // extended refits only on a side whose pair refit was not rejected
      ext.forEach((e) => {
        const side = e.f < 1 ? 0 : 1;
        assert.equal(pair[side].rejected, false, 'extended refit on a rejected side (f ' + e.f + ')');
      });
      assert.equal(st1.cheldExt, ext.length, 'counter matches');
      if (pair.every((x) => x.rejected)) assert.equal(ext.length, 0);
      const early = run(app, synth(app.win, Object.assign({ dtEnd: 72 }, REF)).spec);
      assert.equal(early.storage.unitSlope, true);
      assert.equal(early.cheld.triggered, false);
      assert.equal(early.cheld.mode, 'pair'); assert.deepEqual(early.cheld.refits, []); assert.equal(early.cheld.S_C, 0);
      // changing storage (a pressure hump) → not meaningful
      const hump = synth(app.win, Object.assign({ dtEnd: 72, dtFirst: 0.3 }, REF, { extra: (dt) => 40 * Math.exp(-Math.pow((dt - 0.8) / 0.15, 2)) }));
      const r3 = run(app, hump.spec);
      assert.ok(r3.flags.some((f) => f.code === 'humpDp'), 'pressure hump flagged');
      assert.equal(r3.cheld.meaningful, false);
    },
  },
];
