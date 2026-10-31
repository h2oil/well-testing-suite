// prism-build/tests/buildup-engine-b.test.js — WP1 automatic interpretation engine, EN12–EN22
// (docs/BUILDUP-SURVEILLANCE-PLAN.md §9 WP1). One fresh app per test.
// The synthetic generator is the same as in buildup-engine-a.test.js (registry kernels on a fine table,
// full rate history), copied so each file stands alone.
'use strict';
const fs = require('fs');
const path = require('path');
const shapes = require('./_buildup-shapes');

function lcg(seed) {
  let s = seed >>> 0;
  const u = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
  return { u, n: () => { const a = u(), b = u(); return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b); } };
}
const WELL = { h: 50, phi: 0.2, mu: 1, B: 1.2, ct: 1e-5, rw: 0.354 };
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
  return { spec, truth: { k: o.k, S: o.S, C: o.C, Cd, Bt, A1, pi, pd } };
}
const AIof = (app) => app.win.PRiSM_autoInterp;
const prepOf = (app, spec) => AIof(app).prepare(app.toWin(spec));
const run = (app, spec, opts) => JSON.parse(JSON.stringify(AIof(app).interpret(app.toWin(spec), app.toWin(opts || {}))));
function shapeOk(assert, name, obj) {
  const r = shapes.checkShape(name, JSON.parse(JSON.stringify(obj)));
  assert.ok(r.ok, name + ' shape: ' + r.errors.slice(0, 6).join(' | '));
}
const REF = { k: 45, S: 5, C: 0.02, q: 800, tp: 720 };
const runJob = (job) => { let s; do { s = job.step(); } while (!s.done); return job.result(); };
// A complete EvidenceVector with every rule satisfied for HIGH (free result)
const EV_HIGH = () => ({
  grade: 'good', noiseWidened: false, span: 1.2, pointSkinSpread: 0.1, agree: true, agreeMode: 'raw', dkPct: 1, dS: 0.1, sErr: 0.3, sErrMode: 'line',
  unitSlope: true, cheldRejectedBoth: false, rateSource: 'allocation', r3: 1.02, r3Status: 'pass', r4: 1.03, r4Status: 'pass', dqKnown: true, fRate: 1,
  equalRateAssumed: false, snrD: 60, rDrift: 0.01, rTide: 0.02, tideRemoved: false, flags: [], distractorAtOrBeforeIarf: false, humpAfterIarf: false,
  dtEnd_h: 72, dteEnd_h: 65, t10_h: 8, t5_h: 13, historySensitive: false, outsideEnvelope: false, kHeld: false, kHeldConverged: null, kHeldCorrCS: null,
  kHeldRmsRatio: null, partialSuspect: null, windowLevelInconsistent: null, chosenKey: 'homogeneous', chosenFullySeen: 'n/a', triggers: [],
  dBicChosen: 0, dBicNext: null, boundaryDepends: null,
});

module.exports = [
  {
    name: 'EN12 S_err: noise-free → 0.2 (driver floor); reference 72 h → S_win ≤ 0.15, one-sided when only the early shift fits; pwf0SE 0.5 psi at m 1.56 psi/cycle → S_pwf 0.37 (driver pwf)',
    wp: 'WP1',
    run(app, assert) {
      const AI = AIof(app);
      const nf = run(app, synth(app.win, { k: 45, S: 0, C: 0.002, q: 800, dtEnd: 400, steps: [{ t: 0, q: 800 }, { t: 2000, q: 0 }] }).spec);
      shapeOk(assert, 'BuildupResult', nf);
      assert.near(nf.sErr.value, 0.2, 1e-12); assert.equal(nf.sErr.driver, 'floor'); assert.equal(nf.sErr.mode, 'line');
      const ref = run(app, synth(app.win, Object.assign({ dtEnd: 72 }, REF)).spec);
      assert.ok(ref.sErr.sWin <= 0.15, 'S_win ' + ref.sErr.sWin);
      assert.equal(ref.line.shifts.length, 1, 'only the earlier shift fits before the last full-window bin');
      assert.ok(ref.line.shifts[0].dX < 0);
      assert.near(ref.sErr.sWin, Math.abs(ref.line.shifts[0].S - ref.line.S), 1e-9, 'one-sided S_win (raw agreement)');
      assert.near(ref.sErr.dLineMatch, Math.abs(ref.line.S - ref.models[0].phys.S), 1e-9);
      // kh = 100,000 md·ft, m = 162.6·800·1.2/1e5 = 1.56 psi/cycle, pwf0SE 0.5 psi → 0.37
      const hk = run(app, synth(app.win, { k: 2000, S: 0, C: 0.002, q: 800, dtEnd: 200, steps: [{ t: 0, q: 800 }, { t: 2000, q: 0 }], pwf0SE: 0.5 }).spec);
      assert.near(hk.final.m, 1.561, 0.002);
      assert.near(hk.sErr.sPwf, 0.37, 0.01); assert.equal(hk.sErr.driver, 'pwf');
      // the composition rule itself (D10): value = max of the terms, ext with S_C, sAbs with S_sens
      const e = AI.sErr(app.toWin({ mode: 'line', floor: 0.2, seS: 0.1, sLine: 4, sMatch: 4.3, sWin: 0.12, sTc: 0.05, sPwf: 0.01, sC: 0.6, sSens: 0.4 }));
      shapeOk(assert, 'BuildupResult', Object.assign({}, nf, { sErr: AI.clean(e) }));
      assert.near(e.value, 0.3, 1e-12); assert.equal(e.driver, 'lineMatch');
      assert.near(e.ext.value, 0.6, 1e-12); assert.near(e.sAbs, 0.5, 1e-12);
      const k1 = AI.sErr(app.toWin({ mode: 'kHeld', floor: 0.2, seS: 0.1, sK: 0.55, sTc: 0, sPwf: 0 }));
      assert.equal(k1.driver, 'kHeld'); assert.equal(k1.dLineMatch, null); assert.equal(k1.sWin, null);
    },
  },
  {
    name: 'EN13 sensitivity: Appendix A.2 values to 1e-3; μ ΔS = 0; dominant inputs (requirement: k → h, S → rw; typical: k → h, S → ct)',
    wp: 'WP1',
    run(app, assert) {
      const AI = AIof(app);
      const s = AI.sensitivity(app.toWin({ k: 45, S: 5 }), app.toWin({ sens: { h: 0.2, phi: 0.1, ct: 0.3, rw: 0.05, B: 0.05, mu: 0.2, q: 0.1 } }));
      const row = (tbl, inp, f) => tbl.find((r) => r.input === inp && Math.abs(r.f - f) < 1e-12);
      assert.near(row(s.req, 'h', 1.2).dkPct, -16.667, 1e-3); assert.near(row(s.req, 'h', 1.2).dS, 0.091, 1e-3);
      assert.near(row(s.req, 'h', 0.8).dkPct, 25.0, 1e-3); assert.near(row(s.req, 'h', 0.8).dS, -0.112, 1e-3);
      assert.near(row(s.req, 'phi', 1.2).dS, 0.091, 1e-3); assert.near(row(s.req, 'ct', 0.8).dS, -0.112, 1e-3);
      assert.near(row(s.req, 'rw', 1.2).dS, 0.182, 1e-3); assert.near(row(s.req, 'rw', 0.8).dS, -0.223, 1e-3);
      assert.near(row(s.req, 'B', 1.2).dkPct, 20, 1e-3); assert.near(row(s.req, 'B', 1.2).dS, -0.091, 1e-3);
      assert.near(row(s.req, 'mu', 0.8).dkPct, -20, 1e-3); assert.equal(row(s.req, 'mu', 0.8).dS, 0);
      assert.near(row(s.req, 'q', 1.1).dkPct, 10, 1e-3); assert.near(row(s.req, 'q', 1.1).dS, -0.048, 1e-3);
      assert.near(row(s.req, 'q', 0.9).dS, 0.053, 1e-3);
      assert.near(row(s.typ, 'ct', 1.3).dS, 0.131, 1e-3); assert.near(row(s.typ, 'ct', 0.7).dS, -0.178, 1e-3);
      s.req.concat(s.typ).filter((r) => r.input === 'mu').forEach((r) => assert.equal(r.dS, 0, 'μ has no effect on S'));
      assert.equal(s.muNoEffectOnS, true);
      assert.deepEqual(JSON.parse(JSON.stringify(s.dominantK)), { req: 'h', typ: 'h' });
      assert.deepEqual(JSON.parse(JSON.stringify(s.dominantS)), { req: 'rw', typ: 'ct' });
      const exp = Math.sqrt([0.112, 0.053, 0.178, 0.051, 0.026, 0, 0.053].reduce((a, v) => a + v * v, 0));
      assert.near(s.sSens, exp, 0.003, 'S_sens = RSS of the larger |ΔS| (typical ranges)');
    },
  },
  {
    name: 'EN14 confidence: every KL, KK, KC and KH rule fires on a crafted vector with ids; r3 n/a passes KH5 without KC4; k-held vectors skip KL1, KL2, KL5–KL8',
    wp: 'WP1',
    run(app, assert) {
      const AI = AIof(app);
      const cal = app.toWin(shapes.FIX.cal);
      const conf = (patch, c) => JSON.parse(JSON.stringify(AI.confidence(app.toWin(Object.assign(EV_HIGH(), patch)), c === undefined ? cal : c)));
      const hi = conf({});
      shapes.checkShape('Confidence', hi).ok || assert.fail('Confidence shape');
      assert.equal(hi.ks, 'high', JSON.stringify(hi.reasons)); assert.equal(hi.model, 'high'); assert.equal(hi.headline, 'high');
      assert.ok(hi.rates && hi.rates.ks.rate > 0.9, 'calibrated rate quoted');
      const fired = (r, id) => r.reasons.some((x) => x.rule === id);
      const cases = [
        ['KL1', { grade: 'none', chosenFullySeen: 'n/a' }, 'low'], ['KL2', { sErr: 1.2 }, 'low'], ['KL3', { r3Status: 'fail', r3: 1.4 }, 'low'],
        ['KL3', { dqKnown: false }, 'low'], ['KL4', { humpAfterIarf: true, flags: ['humpDp'] }, 'low'], ['KL5', { snrD: 3 }, 'low'],
        ['KL6', { agree: false, agreeMode: 'none', dS: 1.4 }, 'low'], ['KL7', { dteEnd_h: 20, t10_h: 8 }, 'low'], ['KL8', { partialSuspect: true }, 'low'],
        ['KL9', { distractorAtOrBeforeIarf: true, flags: ['valley'] }, 'low'],
        ['KC1', { historySensitive: true }, 'medium'], ['KC2', { outsideEnvelope: true }, 'medium'], ['KC4', { r3Status: 'unavailable', r3: null }, 'medium'],
        ['KC4', { equalRateAssumed: true }, 'medium'], ['KC5', { windowLevelInconsistent: true }, 'medium'], ['KC6', { fRate: 0.92 }, 'medium'],
        ['KH1', { grade: 'fair', span: 0.6 }, 'medium'], ['KH2', { agree: false, agreeMode: 'none', dS: 0.6 }, 'medium'], ['KH3', { sErr: 0.7 }, 'medium'],
        ['KH4', { unitSlope: false }, 'medium'], ['KH5', { r4Status: 'fail', r4: 1.2 }, 'medium'], ['KH6', { snrD: 15 }, 'medium'],
        ['KH6', { flags: ['negLate'] }, 'medium'],
      ];
      cases.forEach(([id, patch, lvl]) => {
        const r = conf(patch);
        assert.ok(fired(r, id), id + ' fires for ' + JSON.stringify(patch) + ' → ' + JSON.stringify(r.reasons.map((x) => x.rule)));
        assert.equal(r.ks, lvl, id + ' label');
        const it = r.reasons.find((x) => x.rule === id);
        assert.ok(it.ev.length && it.ev.every((e) => /^[QDRWILMACUKTVO]\d+$/.test(e)), id + ' evidence ids');
        assert.ok(it.text.length > 0 && it.text.length < 300);
      });
      // KC2 when not calibrated (no table)
      const nc = conf({}, null);
      assert.equal(nc.ks, 'medium'); assert.ok(fired(nc, 'KC2')); assert.equal(nc.calibrated, false);
      // r3 'n/a' (tabled rates) passes KH5 and never fires KC4
      const na = conf({ r3Status: 'n/a', r3: null, r4Status: 'n/a', r4: null, rateSource: 'table' });
      assert.equal(na.ks, 'high'); assert.ok(!fired(na, 'KC4') && !fired(na, 'KH5'));
      // k-held vectors: KK1–KK4 fire; KL1, KL2, KL5–KL8 never; label ≤ medium
      const kh = (patch) => conf(Object.assign({ kHeld: true, grade: 'none', kHeldConverged: true, kHeldCorrCS: 0.5, kHeldRmsRatio: 1, sErr: 0.6, sErrMode: 'kHeld',
                                                 snrD: 1, agree: false, dS: 3, dteEnd_h: 5, t10_h: 8, partialSuspect: true, chosenFullySeen: 'n/a' }, patch));
      const k0 = kh({});
      assert.equal(k0.ks, 'medium'); assert.ok(fired(k0, 'KC3'));
      ['KL1', 'KL2', 'KL5', 'KL6', 'KL7', 'KL8'].forEach((id) => assert.ok(!fired(k0, id), id + ' skipped for k-held'));
      [['KK1', { kHeldConverged: false }], ['KK2', { kHeldCorrCS: -0.97 }], ['KK3', { kHeldRmsRatio: 4 }], ['KK4', { sErr: 1.3 }]].forEach(([id, p]) => {
        const r = kh(p); assert.ok(fired(r, id), id); assert.equal(r.ks, 'low', id + ' low');
      });
      // KL4 (k-held) only for a hump / steep-storage flag at or after the k-held fit start
      assert.ok(fired(kh({ flags: ['humpDp'] }), 'KL4'), 'KL4 on a hump flag when the fit start is unknown');
      assert.ok(!fired(kh({ flags: ['humpDp'], humpAfterFitStart: false }), 'KL4'), 'no KL4: the fit starts after the hump (pass-1 rule)');
      assert.ok(fired(kh({ flags: ['humpDp'], humpAfterFitStart: false, kHeldHumpAfterStart: true }), 'KL4'), 'KL4: the k-held fit includes the hump');
      assert.ok(!fired(kh({ flags: ['steepStorage'], kHeldHumpAfterStart: false }), 'KL4'), 'no KL4: the k-held fit starts after it');
      // model label rules
      assert.equal(conf({ chosenKey: 'linearBoundary', dBicChosen: 25, dBicNext: 15, chosenFullySeen: 'full', triggers: ['T-up'] }).model, 'high');
      assert.equal(conf({ chosenKey: 'linearBoundary', dBicChosen: 25, dBicNext: 15, chosenFullySeen: 'partial', triggers: ['T-up'] }).model, 'medium');
      assert.equal(conf({ triggers: ['T-up'] }).model, 'medium', 'homogeneous with a trigger');
      assert.equal(conf({ grade: 'none', triggers: ['T-none'], chosenFullySeen: 'not', chosenKey: 'closedCircle' }).model, 'low');
      assert.equal(conf({ boundaryDepends: true }).model, 'low');
      const capped = conf({ sErr: 1.2 });
      assert.equal(capped.model, 'low', 'K2 ≤ K1'); assert.equal(capped.headline, 'low');
    },
  },
  {
    name: 'EN15 fall-off: synthetic injector → sign −1, k and S within 2 % and 0.1',
    wp: 'WP1',
    run(app, assert) {
      const s = synth(app.win, { k: 45, S: 2, C: 0.01, q: 1500, dtEnd: 100, steps: [{ t: 0, q: 1500 }, { t: 1000, q: 0 }], falloff: true,
                                 well: { mu: 0.5, B: 1.02 }, qUnit: 'bbl/d', fluid: 'water_inj' });
      assert.ok(s.spec.p[s.spec.p.length - 1] < s.spec.pwf0, 'pressure falls after the closing');
      const prep = prepOf(app, s.spec);
      assert.equal(prep.sign, -1); assert.equal(prep.adata.sign, -1); assert.equal(prep.adata.testType, 'falloff');
      assert.ok(prep.adata.rateHistory.every((r) => r.q <= 0), 'injection rates signed negative for PRiSM');
      const r = run(app, s.spec);
      shapeOk(assert, 'BuildupResult', r);
      assert.equal(r.testType, 'falloff');
      assert.ok(r.bins.dp.every((v) => v > 0), 'sign-aware Δp');
      assert.rel(r.final.k, 45, 0.02); assert.near(r.final.S, 2, 0.1);
      assert.ok(r.final.piModel < s.spec.pwf0, 'initial pressure below the injection pressure');
    },
  },
  {
    name: 'EN16 gas: pseudo-pressure build-up → k within 2 %, S′ within 0.1; impurityAware when WTS_gaspvt_z exists',
    wp: 'WP1',
    run(app, assert) {
      const AI = AIof(app), W = app.win;
      const gas = { sg: 0.65, T_F: 200, co2: 2, h2s: 1, n2: 1, pseudoTime: false, pdew: null };
      const piP = 4000, k = 10, S = 3, C = 0.01, q = 5000;
      let pr = 3200, s = null, tbl = null;
      for (let it = 0; it < 3; it++) {
        tbl = AI.gasTable(app.toWin(Object.assign({ pmax: 6000 }, gas)));
        assert.ok(tbl.ok, 'gas table');
        tbl.setRef(pr);
        const ref = tbl.ref;
        s = synth(W, { k, S, C, q, steps: [{ t: 0, q }, { t: 500, q: 0 }], dtEnd: 72, pi: tbl.pn(piP), well: { mu: ref.mu, B: ref.Bg }, qUnit: 'Mscf/d', fluid: 'gas', gas });
        s.spec.p = s.spec.p.map((v) => tbl.pOfPn(v));
        s.spec.pwf0 = tbl.pOfPn(s.spec.pwf0);
        pr = 0.5 * (s.spec.pwf0 + s.spec.p[s.spec.p.length - 1]);
      }
      if (typeof W.WTS_gaspvt_z === 'function') assert.equal(tbl.impurityAware, true, 'impurity-aware z');
      const r = run(app, s.spec);
      shapeOk(assert, 'BuildupResult', r);
      assert.rel(r.final.k, k, 0.02, 'k');
      assert.ok(r.final.gas, 'gas block');
      assert.near(r.final.gas.Sprime, S, 0.1, 'S′');
      assert.ok(r.final.gas.dpSkin_psi > 0 && r.final.dpSkin_psi === r.final.gas.dpSkin_psi, 'Δp_skin converted back to psi');
    },
  },
  {
    name: 'EN17 determinism: interpret vs drive identical; zero pending timers; no Math.random in 53; storage, PRiSM_state and events untouched; a decision input 1e-12 from a threshold gives the same result',
    wp: 'WP1',
    async run(app, assert) {
      const AI = AIof(app), W = app.win;
      const src = fs.readFileSync(path.join(__dirname, '..', '53-prism-autointerp.js'), 'utf8');
      assert.ok(!/Math\.random/.test(src), 'no Math.random in 53');
      app.openPRiSM();
      app.flush(2000);
      const snapLS = () => { const o = {}; for (let i = 0; i < app.storage.length; i++) { const k = app.storage.key(i); o[k] = app.storage.getItem(k); } return JSON.stringify(o); };
      const ls0 = snapLS(), st0 = JSON.stringify(W.PRiSM_state || null), ds0 = W.PRiSM_dataset;
      app.evalInApp("window.__ev = 0; ['prism:dataset-loaded','prism:well-changed','prism:fit-updated','prism:model-changed','prism:period-changed','prism:step-changed'].forEach(function (n) { window.addEventListener(n, function () { window.__ev++; }); });");
      const { spec } = synth(W, Object.assign({ dtEnd: 72, sigma: 0.01, seed: 9 }, REF));
      const a = JSON.stringify(AI.interpret(app.toWin(spec)));
      let prog = 0;
      const p = AI.drive(AI.interpretJob(app.toWin(spec)), { onProgress: () => { prog++; } });
      await app.flushAsync(5000);
      const b = JSON.stringify(await p);
      assert.equal(a, b, 'interpret and drive give identical JSON');
      assert.ok(prog > 3, 'progress reported');
      app.flush(5000);
      assert.equal(app.pendingTimers(), 0, 'no pending timers after drive');
      assert.equal(W.__ev, 0, 'no PRiSM events fired');
      assert.equal(snapLS(), ls0, 'localStorage untouched');
      assert.equal(JSON.stringify(W.PRiSM_state || null), st0, 'PRiSM_state untouched');
      assert.equal(W.PRiSM_dataset, ds0, 'dataset untouched');
      // cancel → CANCELLED, no timer left
      let cancelled = false;
      const pc = AI.drive(AI.interpretJob(app.toWin(spec)), { shouldCancel: () => cancelled });
      cancelled = true;
      let code = null;
      pc.catch((e) => { code = e && e.code; });
      await app.flushAsync(100);
      assert.equal(code, 'CANCELLED');
      app.flush(1000);
      assert.equal(app.pendingTimers(), 0);
      // failures keep prepare's bad fields; a spec without an id is 'B?' (never a banned word)
      const bw = JSON.parse(JSON.stringify(spec)); bw.well.h = 0;
      const fb = JSON.parse(JSON.stringify(AI.interpret(app.toWin(bw))));
      assert.equal(fb.ok, false); assert.equal(fb.code, 'BAD_WELL'); assert.deepEqual(fb.bad, ['h'], 'bad fields kept');
      const noId = JSON.parse(JSON.stringify(spec)); delete noId.id;
      const rn = JSON.stringify(AI.interpret(app.toWin(noId)));
      assert.equal(JSON.parse(rn).id, 'B?'); assert.ok(!/undefined/.test(rn), 'no banned word');
      // the input hash is computed inside the work units, one 2000-sample block per unit
      const big = synth(W, Object.assign({}, REF, { dtEnd: 72, perCycle: 1000 })).spec;
      assert.ok(big.dt.length > 4000, big.dt.length + ' raw samples');
      const jb = AI.interpretJob(app.toWin(big)), labels = [];
      for (let i = 0; i < 4; i++) labels.push(jb.step().label);
      assert.ok(labels.slice(0, 3).every((l) => /input hash/.test(l)), 'hash units first: ' + labels.join(' | '));
      let sb; do { sb = jb.step(); } while (!sb.done);
      assert.ok(/^[0-9a-f]{16}$/.test(jb.result().inputHash), 'inputHash');
      assert.equal(jb.result().inputHash, AI.interpret(app.toWin(big)).inputHash, 'same hash from interpret');
      // decisions use rounded inputs (D27): 1e-12 either side of a threshold gives the same label / choice
      const cal = app.toWin(shapes.FIX.cal);
      const ev = (x) => app.toWin(Object.assign(EV_HIGH(), { sErr: x }));
      assert.equal(AI.confidence(ev(0.5 + 1e-12), cal).ks, AI.confidence(ev(0.5 - 1e-12), cal).ks, 'KH3 at the threshold');
      const prep = prepOf(app, spec);
      const n = 40, base = Array.from({ length: n }, (_, i) => 0.01 * Math.sin(i));
      const mk = (key, p, scale) => ({ key, ok: true, p, ssrLog: base.reduce((s2, v) => s2 + v * v * scale * scale, 0), _res: base.map((v) => v * scale), _floor: 0, se: {}, phys: {}, eligible: true, why: [] });
      const hom = mk('homogeneous', 3, 1), nEff = AI.bic(prep, app.toWin([hom])).nEff;
      const need = (10 + Math.log(nEff)) / nEff;   // ΔBIC = 10 exactly
      [1e-12, -1e-12].forEach((eps) => {
        const sc = Math.exp(-(need + eps / nEff) / 2);
        const t = AI.bic(prep, app.toWin([mk('homogeneous', 3, 1), mk('linearBoundary', 4, sc)]));
        assert.equal(t.chosen, 'homogeneous', 'ΔBIC 10 ± 1e-12 rounds to 10.0, not above τ');
      });
    },
  },
  {
    name: 'EN18 k-held: S recovered with k at the truth; a 5 % k offset gives |ΔS| 0.5–0.6 and S_err ≥ |ΔS|; S_k within 20 % of S_kAnalytic; KK rules; label ≤ medium',
    wp: 'WP1',
    run(app, assert) {
      const AI = AIof(app);
      const { spec } = synth(app.win, Object.assign({ dtEnd: 12 }, REF));
      const prep = prepOf(app, spec);
      const k0 = runJob(AI.kHeldJob(prep, app.toWin({ k: 45, delta: 0.05 })));
      shapeOk(assert, 'KHeld', AI.clean(k0));
      assert.equal(k0.window, null, 'no anomaly: the k-held fit uses every fit point'); assert.equal(k0.humpAfterFitStart, false);
      assert.ok(k0.converged); assert.near(k0.fit.phys.S, 5, 0.05, 'S with k at the truth'); assert.equal(k0.fit.phys.k, 45);
      const k1 = runJob(AI.kHeldJob(prep, app.toWin({ k: 45 * 1.05, delta: 0.05 })));
      const dS = Math.abs(k1.fit.phys.S - 5);
      assert.within(dS, 0.5, 0.6, '|ΔS| for a 5 % k offset');
      assert.ok(Math.abs(k1.S_k / k1.S_kAnalytic - 1) <= 0.2, 'S_k ' + k1.S_k + ' vs analytic ' + k1.S_kAnalytic);
      // the k-held fit's se is inflated once by √(n/n_eff) and carries ci95 (the value S_err uses, §3.1)
      assert.ok(k1.n > 0 && k1.nEff > 0 && k1.nEff <= k1.n, 'n and n_eff reported (' + k1.n + ', ' + k1.nEff + ')');
      const seRaw = Math.abs(k1.fit._fr.stderr.S);
      assert.rel(k1.fit.se.S, seRaw * Math.sqrt(k1.n / k1.nEff), 1e-9, 'se.S inflated by √(n/n_eff)');
      assert.ok(k1.fit.ci95.S && k1.fit.ci95.S.length === 2, 'ci95.S set');
      assert.near(k1.fit.ci95.S[1] - k1.fit.ci95.S[0], 2 * 1.96 * k1.fit.se.S, 1e-9, 'ci95.S = S ± 1.96·se');
      assert.equal(k1.fit.ci95.k, null, 'k frozen: no ci95.k');
      const se = AI.sErr(app.toWin({ mode: 'kHeld', floor: 0.2, seS: k1.fit.se.S || 0, sK: k1.S_k, sTc: 0, sPwf: 0 }));
      assert.ok(se.value >= dS, 'S_err ' + se.value + ' ≥ |ΔS| ' + dS);
      assert.equal(se.driver, 'kHeld');
      const ev = Object.assign({}, EV_HIGH(), { kHeld: true, grade: 'none', sErr: se.value, sErrMode: 'kHeld', kHeldConverged: k1.converged,
                                                kHeldCorrCS: k1.corrCS, kHeldRmsRatio: 1 });
      const c = AI.confidence(app.toWin(ev), app.toWin(shapes.FIX.cal));
      assert.ok(c.ks !== 'high' && c.reasons.some((x) => x.rule === 'KC3'), 'k-held label ≤ medium');
    },
  },
  {
    name: 'EN19 two-zone kernel vs radialComposite ≤ 0.5 % (pd and pd′, tD 1e2–1e8, three sets with M > 1 and three with M < 1)',
    wp: 'WP1',
    run(app, assert) {
      const AI = AIof(app), M = app.win.PRiSM_MODELS;
      const sets = [{ M: 2, R: 100 }, { M: 5, R: 300 }, { M: 10, R: 50 }, { M: 0.5, R: 100 }, { M: 0.2, R: 300 }, { M: 0.1, R: 1000 }];
      const td = [1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8];
      sets.forEach((st, i) => {
        const p = { Cd: 100, S: i % 2 ? -1 : 3, M: st.M, F: 1, R: st.R };
        const reg = M.radialComposite.pd(app.toWin(td), app.toWin(p)), regd = M.radialComposite.pdPrime(app.toWin(td), app.toWin(p));
        td.forEach((t, j) => {
          const pr = AI.kernels.pair('composite2', t, app.toWin(p));
          assert.rel(pr[0], reg[j], 0.005, 'pd set ' + i + ' tD ' + t);
          assert.rel(pr[1], regd[j], 0.005, 'pd′ set ' + i + ' tD ' + t);
        });
      });
      // the outer derivative level is 0.5·M (direction of the rise / fall)
      assert.rel(AI.kernels.pair('composite2', 1e10, app.toWin({ Cd: 0, S: 0, M: 4, F: 1, R: 50 }))[1], 2, 0.01);
    },
  },
  {
    name: 'EN20 slicing: count-only budget (frozen vs advancing clock identical); sliced = unsliced within 1e-9 (parameters, iterations, stop reason, pauses inside the trial loop, lambda-max); plateau counter carried across slices; evals per slice follow §4.8 (11 at 65 points, S ≥ 0)',
    wp: 'WP1',
    run(app, assert) {
      const AI = AIof(app), W = app.win;
      assert.equal(AI.evalsPerSlice('homogeneous', 2, 65, 3), 11, '4 ms × 65/60 → 11 evaluations');
      assert.equal(AI.evalsPerSlice('homogeneous', -1, 65, 3), 5, 'S < 0 → 5');
      assert.equal(AI.evalsPerSlice('linearBoundary', 2, 65, 4), 5, 'fault (9 ms, 4 free) → 5');
      assert.equal(AI.evalsPerSlice('closedCircle', 2, 60, 4), 24, 'capped at 24');
      const { spec } = synth(W, Object.assign({ dtEnd: 72, sigma: 0.02, seed: 21 }, REF));
      const prep = prepOf(app, spec);
      const start = { k: 30, S: 2, C: 0.03 };
      AI.resetStats();
      const fA = AI.fit('homogeneous', prep, app.toWin({ start }));
      const stA = AI.stats();
      assert.equal(fA.evalsPerSlice, AI.evalsPerSlice('homogeneous', start.S, fA.gridPoints, 3), 'the fit uses the §4.8 rule');
      assert.ok(fA.slices >= 2, 'several slices (' + fA.slices + ')');
      assert.ok(stA.evals <= fA.slices * (fA.evalsPerSlice + 4) + 10, 'slices respect the budget');
      // an advancing clock (1 s per Date.now call) changes nothing: the budget counts evaluations only
      const keep = W.Date.now;
      let clock = keep.call(W.Date);
      W.Date.now = function () { clock += 1000; return clock; };
      let fB;
      try { fB = AI.fit('homogeneous', prep, app.toWin({ start })); } finally { W.Date.now = keep; }
      assert.deepEqual(JSON.parse(JSON.stringify(fB.phys)), JSON.parse(JSON.stringify(fA.phys)), 'identical under an advancing clock');
      assert.equal(fB.nEval, fA.nEval); assert.equal(fB.slices, fA.slices);
      // the same fit unsliced (one fitPhysical call, no budget)
      const ent = AI.gridEntry('homogeneous', prep);
      const fU = W.PRiSM_fitPhysical('homogeneous', prep.adata, prep.well, { entry: ent, isolated: true, mode: 'physical', dataset: { t: [], p: [] }, singleStart: true, start: app.toWin(start), maxIter: 40 });
      ['k', 'S', 'C'].forEach((k) => assert.rel(fA.phys[k], fU.phys[k], 1e-9, 'sliced = unsliced: ' + k));
      assert.equal(fA.iterations, fU.iterations, 'sliced = unsliced: iterations (a pause is not an iteration)');
      // a fit that pauses inside its trial loop and ends on lambda-max (a parameter-hash jitter of 3e-6 in pD spoils
      // the forward-difference Jacobian near the optimum): the slices carry the normal equations, so the sliced
      // path equals the unsliced one in parameters, iterations and stop reason, and λ > λmax ends it in either form
      const jit = (p) => { const x = Math.sin(12345.678 * (Math.log(p.Cd) + 7 * p.S)) * 43758.5453; return 3e-6 * (x - Math.floor(x)); };
      const ej = Object.assign({}, ent, { pd: (td, p) => { const v = ent.pd(td, p), j = jit(p); return typeof v === 'number' ? v + j : Array.from(v, (x) => x + j); } });
      const bj = { entry: ej, isolated: true, mode: 'physical', dataset: { t: [], p: [] }, singleStart: true, start: app.toWin(start) };
      const uJ = W.PRiSM_fitPhysical('homogeneous', prep.adata, prep.well, Object.assign({}, bj, { maxIter: 40 }));
      assert.equal(uJ.stopReason, 'lambda-max', 'the jittered fit ends on lambda-max');
      let lmJ = null, itJ = 0, slJ = 0, pausedJ = 0;
      while (slJ < 100) {
        const r = W.PRiSM_fitPhysical('homogeneous', prep.adata, prep.well, Object.assign({}, bj, { evalBudget: 5, lmState: lmJ || undefined, slice: true, maxIter: Math.max(1, 40 - itJ) }));
        itJ += r.iterations; slJ++; lmJ = r.lmState; if (lmJ.jac) pausedJ++;
        if (lmJ.done || itJ >= 40) break;
      }
      assert.ok(pausedJ >= 1, 'at least one slice paused inside the trial loop (' + pausedJ + ')');
      assert.equal(lmJ.stopReason, 'lambda-max', 'sliced: λ past λmax stops (not another budget pause)');
      assert.equal(itJ, uJ.iterations, 'sliced = unsliced: iterations');
      const fJ = W.PRiSM_fitPhysical('homogeneous', prep.adata, prep.well, Object.assign({}, bj, { lmState: lmJ, maxIter: 1 }));
      ['k', 'S', 'C'].forEach((k) => assert.rel(fJ.phys[k], uJ.phys[k], 1e-12, 'jittered sliced = unsliced: ' + k));
      // plateau counter: an objective whose accepted steps each change the SSR by < 1e-12 (relative)
      const fn = (t, p) => t.map((ti) => (ti === 0 ? 1e10 : Math.exp(p.a) - Math.exp(5)));
      const data = app.toWin({ t: [0, 1], p: [0, 0] }), bnd = app.toWin({ a: [0, 20] });
      const r0 = W.PRiSM_lm(fn, data, app.toWin({ a: 8.87 }), bnd, null, app.toWin({ maxIter: 40, tolerance: 0 }));
      const r1 = W.PRiSM_lm(fn, data, app.toWin({ a: 8.87 }), bnd, null, app.toWin({ maxIter: 40, tolerance: 0, stagnant0: 4 }));
      assert.ok(r0.stopReason !== 'plateau' && r0.stagnantSteps === 4, 'four stagnant steps alone: ' + r0.stopReason);
      assert.equal(r1.stopReason, 'plateau', 'resumed with the carried counter, the fifth stagnant step stops');
      assert.equal(r1.iterations, 1);
      // the same stop through one-iteration slices carrying p / y / SSR / λ / counter
      const full = W.PRiSM_lm(fn, data, app.toWin({ a: 9.2 }), bnd, null, app.toWin({ maxIter: 40, tolerance: 0 }));
      assert.equal(full.stopReason, 'plateau');
      let st = null, last = null, slices = 0;
      while (slices < 20) {
        const o = { maxIter: 1, tolerance: 0, skipFinal: true };
        if (st) Object.assign(o, { p0: st.pInt, y0: st.y, ssr0: st.ssr, lambda0: st.lambda, stagnant0: st.stagnantSteps });
        last = W.PRiSM_lm(fn, data, app.toWin({ a: 9.2 }), bnd, null, app.toWin(o));
        slices++; st = last;
        if (last.stopReason !== 'maxIter') break;
      }
      assert.equal(last.stopReason, 'plateau', 'the plateau stop fires across slices');
      assert.equal(slices, full.iterations, 'after the same number of iterations');
      assert.near(last.params.a, full.params.a, 1e-12);
      assert.ok(typeof r1.stagnantSteps === 'number' && typeof r1.lambda === 'number' && r1.nEval > 0, 'PRiSM_lm reports λ, nEval and the counter');
      const sl = W.PRiSM_fitPhysical('homogeneous', prep.adata, prep.well, { entry: ent, isolated: true, mode: 'physical', dataset: { t: [], p: [] }, singleStart: true, start: app.toWin(start), evalBudget: 5, slice: true, maxIter: 40 });
      assert.ok(sl.sliced && sl.lmState && typeof sl.lmState.stagnant === 'number' && sl.lmState.done === false, 'a slice returns its state');
      assert.ok(sl.nEval <= 5 + 4, 'one slice stays within its budget plus one iteration');
      // an early return (no free parameter) carries the resume fields too
      const e0 = W.PRiSM_lm(fn, data, app.toWin({ a: 8.87 }), bnd, app.toWin({ a: true }), app.toWin({ maxIter: 10 }));
      assert.equal(e0.stopReason, 'no-free-params');
      assert.ok(typeof e0.lambda === 'number' && typeof e0.nEval === 'number' && e0.stagnantSteps === 0 && e0.pInt && Array.isArray(e0.y), 'resume fields on the early return');
      // maxIterTotal counts both starts: a fit that misses convergence never runs more than the total
      const capped = AI.fit('homogeneous', prep, app.toWin({ start: { k: 3, S: 25, C: 0.3 }, maxIterTotal: 6 }));
      assert.ok(capped.iterations <= 6, 'iterations ' + capped.iterations + ' ≤ 6 across both starts');
    },
  },
  {
    name: 'EN21 PRiSM_openExternalBuildup: dataset, paste text and multi-rate written; water_inj → water/falloff; activePeriod contains tShut; model adopted before setLastFit; composite2 → radialComposite; survives reload',
    wp: 'WP1',
    run(app, assert, ctx) {
      const W = app.win;
      app.openPRiSM(); app.flush(1000);
      const t = [], p = [];
      for (let i = 0; i <= 40; i++) { t.push(i * 0.25); p.push(3000 + i * 0.5); }          // injecting, 10 h
      for (let i = 1; i <= 60; i++) { const dt = 0.01 * Math.pow(10, i / 20); t.push(10 + dt); p.push(3020 - 30 * Math.log10(1 + dt * 50)); }   // fall-off
      const pasteText = 't_hr,p_psia\n' + t.map((v, i) => v.toFixed(6) + ',' + p[i].toFixed(3)).join('\n');
      const ds = { t, p, q: null, name: 'Build-up B3' };
      const fitC4 = { modelKey: 'composite2', params: { Cd: 1500, S: 2, M: 0.5, F: 1, R: 2000 }, phys: { k: 40, S: 2, C: 0.01, M: 0.5, F: 1, R_ft: 708, kh: 2000 }, r2: 0.999, converged: true, kind: 'pressure', source: 'buildup' };
      app.evalInApp("window.__seen = null; window.addEventListener('prism:fit-updated', function () { var st = window.PRiSM_state; window.__seen = { model: st.model, M: st.params && st.params.M, last: st.lastFit && st.lastFit.modelKey }; });");
      const r = W.PRiSM_openExternalBuildup(app.toWin({ ds, pasteText, multiRate: [{ t: -500, q: 1200 }, { t: 0, q: 1500 }, { t: 10, q: 0 }],
        well: { q: 1500, B: 1.02, mu: 0.5, ct: 5e-6, h: 40, phi: 0.18, rw: 0.354, fluid: 'water_inj', testType: 'falloff' }, tShut: 10, pwf0: 3020, modelKey: 'composite2', fitC4 }));
      assert.ok(r.ok, r.reason);
      assert.equal(W.PRiSM_dataset.t.length, t.length, 'dataset committed');
      assert.equal(JSON.parse(app.storage.getItem('wts_prism')).prism_data_paste, pasteText, 'paste text persisted');
      assert.deepEqual(JSON.parse(app.storage.getItem('wts_prism_mrate')), [{ t: -500, q: 1200 }, { t: 0, q: 1500 }, { t: 10, q: 0 }], 'multi-rate persisted');
      assert.equal(W.PRiSM.multiRate.length, 3);
      assert.equal(W.PRiSM_pvt.fluidType, 'water'); assert.equal(W.PRiSM_pvt.testType, 'falloff');
      const per = W.PRiSM_rateHistory(W.PRiSM_dataset).periods[W.PRiSM_state.activePeriod];
      assert.ok(per && per.t0 <= 10 + 1e-9 && (per.t1 === undefined || per.t1 === null || per.t1 > 10), 'active period contains tShut');
      assert.equal(r.period, W.PRiSM_state.activePeriod);
      assert.equal(W.PRiSM_state.model, 'radialComposite', 'composite2 → radialComposite');
      assert.equal(W.PRiSM_state.params.F, 1);
      assert.deepEqual(JSON.parse(JSON.stringify(W.__seen)), { model: 'radialComposite', M: 0.5, last: 'radialComposite' }, 'a fit-updated listener sees a consistent state');
      const ad = W.PRiSM_getAnalysisData();
      assert.ok(ad.ok && ad.testType === 'falloff', 'PRiSM analyses the fall-off period: ' + JSON.stringify({ ok: ad.ok, reason: ad.reason, tt: ad.testType, per: ad.periodIndex, n: ad.n, w: ad.warnings }));
      // reload: PRiSM re-reads the paste box, the multi-rate table and the saved state
      const app2 = ctx.loadApp({ storage: app.storage });
      try {
        app2.openPRiSM(); app2.flush(2000);
        const W2 = app2.win;
        assert.ok(W2.PRiSM_dataset && W2.PRiSM_dataset.t.length === t.length, 'dataset restored after reload');
        assert.equal(W2.PRiSM.multiRate.length, 3, 'multi-rate restored');
        assert.equal(W2.PRiSM_state.model, 'radialComposite');
        assert.equal(W2.PRiSM_state.activePeriod, r.period, 'period kept: ' + JSON.stringify({ a: W2.PRiSM_state.activePeriod, r: r.period, saved: JSON.parse(app.storage.getItem('wts_prism_state') || '{}').activePeriod, per: W2.PRiSM_rateHistory(W2.PRiSM_dataset).periods.map((x) => [x.t0, x.t1, x.n]) }));
        const per2 = W2.PRiSM_rateHistory(W2.PRiSM_dataset).periods[W2.PRiSM_state.activePeriod];
        assert.ok(per2 && per2.t0 <= 10 + 1e-9, 'PRiSM still shows the build-up period');
      } finally { app2.dispose(); }
    },
  },
  {
    name: 'EN22 reach and p*: numeric t_5 % 13.2 h ± 5 % (= a direct scan; the A.1 correlation gives 15.5 h), reach.fair 52.7 h, reach.good 167 h; 24 h without IARF fits no rival, "too short"; an estimated history within the ×10 cover brackets the true p*',
    wp: 'WP1', timeoutMs: 120000,
    run(app, assert) {
      const AI = AIof(app), W = app.win;
      const r = run(app, synth(W, Object.assign({ dtEnd: 72 }, REF)).spec);
      shapeOk(assert, 'Reach', r.reach);
      // independent scan of the registry derivative (drawdown, homogeneous): last Δt with |Δp′/m′ − 1| > 5 %
      const Cd = 0.8936 * 0.02 / (0.2 * 1e-5 * 50 * 0.354 * 0.354), Bt = 0.0002637 * 45 / (0.2 * 1 * 1e-5 * 0.354 * 0.354);
      const ts = []; for (let i = 0; i <= 400; i++) ts.push(Math.pow(10, -1 + i / 100));
      const pdp = W.PRiSM_MODELS.homogeneous.pdPrime(app.toWin(ts.map((x) => Bt * x)), app.toWin({ Cd, S: 5 }));
      let t5 = null; for (let i = ts.length - 1; i >= 0; i--) if (Math.abs(2 * pdp[i] - 1) > 0.05) { t5 = ts[i]; break; }
      assert.rel(r.reach.t5_h, t5, 0.05, 'numeric t5 % (' + r.reach.t5_h + ' h vs scan ' + t5 + ' h)');
      // Resolved numbers (deviation from the plan's 15.5 / 62 / 196 h, which are the Appendix A.1 correlation values;
      // A.1 itself says the reach is computed numerically): t5 13.23 h, fair 52.7 h, good 166.6 h.
      assert.rel(r.reach.t5_h, 13.23, 0.05, 't5 % ' + r.reach.t5_h.toFixed(2) + ' h');
      assert.rel(r.reach.fair_h, 52.7, 0.05, 'reach.fair ' + r.reach.fair_h.toFixed(1) + ' h');
      assert.rel(r.reach.good_h, 166.6, 0.05, 'reach.good ' + r.reach.good_h.toFixed(1) + ' h');
      assert.rel(r.reach.fair_h, Math.pow(10, 0.6) * r.reach.t5_h, 1e-9); assert.rel(r.reach.good_h, Math.pow(10, 1.1) * r.reach.t5_h, 1e-9);
      assert.ok(r.reach.t10_h < r.reach.t5_h);
      assert.ok(r.reach.reachable && r.reach.fairShut_h > r.reach.fair_h, 'shut-in hours from Δt_e');
      // 24 h: no IARF, no rival, too short
      const s24 = run(app, synth(W, Object.assign({ dtEnd: 24 }, REF)).spec);
      assert.equal(s24.iarf.found, false); assert.equal(s24.iarf.status, 'tooShort');
      assert.equal(s24.triggers.noneSkipped, true); assert.equal(s24.triggers.none, false);
      assert.equal(s24.models.length, 1, 'no rival fitted'); assert.equal(s24.reason, 'NO_IARF_TOO_SHORT');
      assert.includes(s24.iarf.reason, 'too short');
      assert.equal(s24.final.pExtSource, 'model', 'no line: p_ext from the model'); assert.equal(s24.final.pExtKind, 'pStar');
      assert.ok(s24.warnings.some((w) => w.code === 'PEXT_MODEL'), 'noted in the warnings');
      assert.equal(r.final.pExtSource, 'line');
      // estimated history: true production 1 year, 90 days known + the default 30-day prepend. The p* range re-evaluates
      // the line with the prepend ×0.5, ×2 and ×10, so it covers a true history up to 90 + 300 days; the plan's 5-year
      // case (range [4920, 4960] psia against a true p* of 5006) is outside that cover (deviation for the lead).
      const tc = 365 * 24, truth = synth(W, { k: 45, S: 5, C: 0.02, q: 800, steps: [{ t: 0, q: 800 }, { t: tc, q: 0 }], dtEnd: 72 });
      const rt = run(app, truth.spec);
      const est = JSON.parse(JSON.stringify(truth.spec));
      est.steps = [{ t: tc - 90 * 24 - 720, q: 800 }, { t: tc, q: 0 }];
      est.history = { estimated: true, tPrepend_h: 720, source: 'default' };
      const re = run(app, est);
      const rg = re.final.pStarRange;
      assert.ok(rg && rg.lo < rg.hi, 'p* reported as a range');
      assert.ok(rg.lo <= rt.final.pStar && rt.final.pStar <= rg.hi, 'range [' + rg.lo + ', ' + rg.hi + '] brackets the true p* ' + rt.final.pStar);
      assert.near(re.final.S, rt.final.S, 0.1, 'S cancels to first order');
      assert.equal(re.history.estimated, true); assert.ok(Number.isFinite(re.history.dDerivPct));
    },
  },
];
