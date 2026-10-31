// prism-build/tests/prism-closedcircle.test.js — PRiSM_MODELS.closedCircle (53-prism-autointerp.js), CC1–CC5
// (docs/BUILDUP-SURVEILLANCE-PLAN.md §3.3, §4.6 kernels, §9 WP1).
'use strict';

const WELL = { h: 50, phi: 0.2, mu: 1, B: 1.2, ct: 1e-5, rw: 0.354 };
// Synthetic closed-circle build-up from the registry model on a fine 40-per-decade table of the bounded
// function pD − 2tD/reD² (the linear term added exactly), superposed over the full history.
function synthClosed(W, o) {
  const M = W.PRiSM_MODELS, well = WELL;
  const Cd = 0.8936 * o.C / (well.phi * well.ct * well.h * well.rw * well.rw);
  const Bt = 0.0002637 * o.k / (well.phi * well.mu * well.ct * well.rw * well.rw);
  const A1 = 141.2 * well.B * well.mu / (o.k * well.h);
  const params = { Cd, S: o.S, reD: o.reD };
  const steps = o.steps, tc = steps[steps.length - 1].t, dtEnd = o.dtEnd, per = 40;
  const dts = []; for (let i = 0; ; i++) { const x = 0.001 * Math.pow(10, i / per); if (x > dtEnd) break; dts.push(x); }
  const j0 = Math.floor(Math.log10(Bt * dts[0] / 2) * 40) - 2, j1 = Math.ceil(Math.log10(Bt * (tc - steps[0].t + dtEnd) * 2) * 40) + 2;
  const tds = []; for (let j = j0; j <= j1; j++) tds.push(Math.pow(10, j / 40));
  const lin = 2 / (o.reD * o.reD), pdv = M.closedCircle.pd(tds, params), pdp = M.closedCircle.pdPrime(tds, params);
  const g = tds.map((t, i) => pdv[i] - lin * t), gp = tds.map((t, i) => pdp[i] - lin * t), H = Math.LN10 / 40;
  const pd = (td) => {
    const u = Math.log10(td) * 40, jf = Math.floor(u), tau = u - jf; let ix = Math.max(0, Math.min(g.length - 2, jf - j0));
    const t2 = tau * tau, t3 = t2 * tau;
    return (2 * t3 - 3 * t2 + 1) * g[ix] + (t3 - 2 * t2 + tau) * H * gp[ix] + (-2 * t3 + 3 * t2) * g[ix + 1] + (t3 - t2) * H * gp[ix + 1] + lin * td;
  };
  const dq = steps.map((s, i) => s.q - (i ? steps[i - 1].q : 0));
  let D0 = 0; for (let i = 0; i < steps.length - 1; i++) D0 += dq[i] * pd(Bt * (tc - steps[i].t));
  const p = dts.map((dt) => { let D = 0; for (let i = 0; i < steps.length; i++) if (dq[i]) D += dq[i] * pd(Bt * (tc + dt - steps[i].t)); return 5000 - A1 * D; });
  return {
    id: 'B1', testType: 'buildup', tc_h: tc, dtc_h: 0, pwf0: 5000 - A1 * D0, pwf0SE: 0, dpdt_flow: 0, dt: dts, p, n: null, steps, qUnit: 'STB/d',
    Dq: steps[steps.length - 2].q, fRate: 1,
    rateQC: { source: 'table', r3: null, r3Status: 'n/a', r4: null, r4Status: 'n/a', dqKnown: true, dqSource: 'table', equalRateAssumed: false, ignoresShutin: false, allocAccPct: 5 },
    well: Object.assign({ fluid: 'oil', T_R: null, re_ft: null, defaulted: [] }, well), gas: null, sigma_psi: 0, sigmaFlow_psi: 0, sigmaLF_psi: 0,
    dtSample_h: 1 / 60, driftPsiPerDay: 0.01, history: { estimated: false, tPrepend_h: 0, source: 'data' },
    overrides: { window: null, model: null, excludeRivals: [] }, opts: { Lcyc: 0.1, binsPerCycle: 20, fitBinsPerCycle: 12, rivals: 'auto', cheld: 'auto', tide: 'auto' },
  };
}

module.exports = [
  {
    name: 'CC1 closed circle: late pD′ = 2tD/reD² within 0.5 %',
    wp: 'WP1',
    run(app, assert) {
      const M = app.win.PRiSM_MODELS.closedCircle;
      [500, 2000, 10000].forEach((reD) => {
        const td = [0.5, 1, 3, 10].map((tDA) => tDA * Math.PI * reD * reD);
        const v = M.pdPrime(app.toWin(td), app.toWin({ Cd: 0, S: 0, reD }));
        td.forEach((t, i) => assert.rel(v[i], 2 * t / (reD * reD), 0.005, 'reD ' + reD + ' tD ' + t));
      });
      const w = M.pdPrime(app.toWin([3 * Math.PI * 1e6]), app.toWin({ Cd: 1000, S: 5, reD: 1000 }));
      assert.rel(w[0], 2 * 3 * Math.PI, 0.005, 'with storage and skin');
      const neg = M.pdPrime(app.toWin([3 * Math.PI * 1e6]), app.toWin({ Cd: 100, S: -3, reD: 1000 }));
      assert.rel(neg[0], 2 * 3 * Math.PI, 0.005, 'negative skin (effective-radius transform scales reD)');
    },
  },
  {
    name: 'CC2 closed circle: IARF (0.5) before the boundary; equal to homogeneous before the boundary within 0.1 %',
    wp: 'WP1',
    run(app, assert) {
      const M = app.win.PRiSM_MODELS;
      const reD = 20000, p = { Cd: 100, S: 2, reD };
      const td = []; for (let i = 0; i <= 28; i++) td.push(Math.pow(10, 1 + i * 0.25));   // 1e1 … 1e8
      const early = td.filter((t) => t <= 0.01 * Math.PI * reD * reD);
      const cc = M.closedCircle.pd(app.toWin(early), app.toWin(p)), hm = M.homogeneous.pd(app.toWin(early), app.toWin({ Cd: 100, S: 2 }));
      early.forEach((t, i) => assert.rel(cc[i], hm[i], 0.001, 'pd at tD ' + t));
      const iarf = td.filter((t) => t >= 3e5 && t <= 0.005 * Math.PI * reD * reD);
      assert.ok(iarf.length >= 2, 'an IARF interval exists');
      const d = M.closedCircle.pdPrime(app.toWin(iarf), app.toWin(p));
      d.forEach((v, i) => assert.rel(v, 0.5, 0.01, 'IARF pd′ at tD ' + iarf[i]));
    },
  },
  {
    name: 'CC3 a seeded closed-circle fit recovers r_e within 5 %',
    wp: 'WP1', timeoutMs: 60000,
    run(app, assert) {
      const AI = app.win.PRiSM_autoInterp;
      const re = 2500, spec = synthClosed(app.win, { k: 45, S: 0, C: 0.002, reD: re / 0.354, steps: [{ t: 0, q: 800 }, { t: 2000, q: 0 }], dtEnd: 400 });
      const prep = AI.prepare(app.toWin(spec));
      assert.ok(prep.ok);
      const f = AI.fit('closedCircle', prep, app.toWin({ start: { k: 40, S: 0.5, C: 0.0022, reD: 1.4 * re / 0.354 } }));
      assert.ok(f.ok && f.converged, 'converged: ' + f.stopReason);
      assert.rel(f.phys.re_ft, re, 0.05, 're ' + f.phys.re_ft);
      assert.rel(f.phys.k, 45, 0.03);
      const pStarM = AI.pExt(prep, f, 'infinite'), pBar = AI.pExt(prep, f, 'closed');
      assert.ok(Number.isFinite(pStarM) && Number.isFinite(pBar) && pBar < pStarM, 'p̄ (closed family) below the model p* (' + pBar + ' < ' + pStarM + ')');
      // and through the full interpretation: chosen, fully seen, wording lists the alternatives
      const r = JSON.parse(JSON.stringify(AI.interpret(app.toWin(spec))));
      assert.equal(r.chosen.key, 'closedCircle');
      assert.equal(r.chosen.fullySeen.status, 'full');
      assert.includes(r.chosen.fullySeen.text, 'constant-pressure boundary, interference or depletion');
      assert.rel(r.final.distances.re_ft, re, 0.05);
      assert.ok(r.fitC4.modelKey === 'closedCircle' && r.fitC4.params.reD > 0);
    },
  },
  {
    name: 'CC4 bounded grid form on the compacted history vs direct Stehfest superposition over the full 365 daily steps (r_e = 0.9·r_inv): ≤ 0.05 psi',
    wp: 'WP1', timeoutMs: 60000,
    run(app, assert) {
      const AI = app.win.PRiSM_autoInterp, W = app.win;
      const k = 45, steps = [];
      for (let d = 0; d < 365; d++) steps.push({ t: d * 24, q: 800 * (1 + 0.1 * Math.sin(d * 0.37)) });
      steps.push({ t: 365 * 24, q: 0 });
      const rinv = 0.0325 * Math.sqrt(k * 365 * 24 / (WELL.phi * WELL.mu * WELL.ct));
      const reD = 0.9 * rinv / WELL.rw;
      const spec = synthClosed(W, { k, S: 2, C: 0.02, reD, steps, dtEnd: 48 });
      const prep = AI.prepare(app.toWin(spec));
      const ent = AI.gridEntry('closedCircle', prep);
      const ph = app.toWin({ k, C: 0.02, S: 2, reD });
      // the engine's form: grid entry on the compacted history (last 10·Δt_end exact + one volume-mean block)
      assert.ok(prep.histFit.nLumped > 300 && prep.histFit.steps.length < 40, 'compacted history (' + prep.histFit.steps.length + ' steps)');
      const pmG = W.PRiSM_physicalModel('closedCircle', prep.well, prep.adata, { entry: ent, isolated: true });
      // the reference: the registry kernel (direct Stehfest) superposed over all 365 daily steps
      const full = AI.clean(prep.adata);
      full.rateHistory = app.toWin(prep.histFull.steps.map((x) => ({ t: x.t, q: x.q })));
      assert.equal(full.rateHistory.length, 366, 'full history');
      const pmR = W.PRiSM_physicalModel('closedCircle', prep.well, full, app.toWin({ isolated: true }));
      const t = prep.adata.t.filter((v, i) => i % 3 === 0);
      const a = pmG.dp(app.toWin(t), ph), b = pmR.dp(app.toWin(t), ph);
      let mx = 0; for (let i = 0; i < a.length; i++) mx = Math.max(mx, Math.abs(a[i] - b[i]));
      assert.ok(mx <= 0.05, 'bounded grid + compaction vs direct Stehfest over the full history: ' + mx.toFixed(4) + ' psi');
      assert.ok(b[b.length - 1] > 50, 'a real build-up (Δp ' + b[b.length - 1].toFixed(1) + ' psi)');
    },
  },
  {
    name: 'CC5 registry metadata: kind pressure (smoke C3), timeInput td, defaultFrozen [], name, a default on every paramSpec item',
    wp: 'WP1',
    run(app, assert) {
      const M = app.win.PRiSM_MODELS, e = M.closedCircle;
      assert.ok(e, 'registered');
      assert.ok(e.kind === 'pressure' || e.kind === 'rate', 'smoke C3: kind pressure|rate');
      assert.equal(e.kind, 'pressure'); assert.equal(e.timeInput, 'td'); assert.equal(e.refLength, 'rw');
      assert.deepEqual(Array.from(e.defaultFrozen), []); assert.equal(e.name, 'Closed circle'); assert.equal(e.category, 'boundary');
      assert.equal(e.evalCostMs, 1.5);
      assert.deepEqual(JSON.parse(JSON.stringify(e.defaults)), { Cd: 100, S: 0, reD: 5000 });
      e.paramSpec.forEach((s) => assert.ok(s.default !== undefined, 'default on ' + s.key));
      assert.deepEqual(e.paramSpec.map((s) => s.key), ['Cd', 'S', 'reD']);
      assert.ok(typeof e.pd === 'function' && typeof e.pdPrime === 'function');
      assert.ok(Number.isFinite(e.pd(1e4, app.toWin({ Cd: 100, S: 0, reD: 5000 }))), 'scalar input');
      assert.equal(Object.keys(M).length, 46, '46 models');
      const bad = Object.keys(M).filter((k) => k !== 'userDefined' && !(M[k] && (M[k].kind === 'pressure' || M[k].kind === 'rate')));
      assert.deepEqual(bad, [], 'every registry model has a kind');
      assert.ok(typeof app.win.PRiSM_getModelSchematic === 'function' && /<svg/.test(app.win.PRiSM_getModelSchematic('closedCircle')), 'schematic');
    },
  },
];
