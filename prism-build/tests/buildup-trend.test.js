// Build-up Surveillance — WP3 trend and alerts (docs/BUILDUP-SURVEILLANCE-PLAN.md §3.8, §4.7, §9 WP3).
//
//   TR1  baseline: median, σ_base, unstable and provisional rules; a workover date starts a segment; FIX baseline
//   TR2  delta and absolute alerts: raised, confirmed, provisional, possible; immediate (high + 1); plain vs basevar;
//        kHeldOnly; rounded threshold decisions (D27); FIX alerts reproduced
//   TR3  absolute robustness with ±S_sens; basis switches to mechanical when the completion is given     [app]
//   TR4  hinge onset on a synthetic step and a ramp within one interval; CUSUM alarm and onset
//   TR5  Theil–Sen slope and Sen CI against hand values; Mann–Kendall z; n ≤ 4 indicative
//   TR6  forecast hidden when the lower bound ≤ 0; horizon cap; shown date from the Sen line
//   TR7  products: PI ratio 0.865 / 0.509, rate factor 1.698, extra drawdown 374 psi; guard; m; r_inv bounds [app]
//   TR8  k stability: CV, the Appendix A.3 readings, the stage-3 window inconsistency reported
//   TR9  pressure trend: depletion vs none; drift wording; estimated history; the closed family (p̄)
//   TR10 model-free ΔS from TrendTest.bins; FIX T11 reproduced
//   TR11 bubble point: gradient range, levels, Spearman rule, off for gas and injectors, critical only when assessable
//   TR12 gas rate skin: collinear q and t → unresolved; 2.0× spread, 3 + 3 constant-skin tests → D within 10 % [app]
//   TR13 recommendations and limitations: evidence ids, ≤ 600 characters, shut-in length from reachFairShut_h  [app]
//   TR14 trend auto off in table mode and with tests < 1 day apart; on/off overrides; source rules
//   TR15 excludedLow count and S range (T16)
//   TR16 PI cross-check from days[].pwfMean_psia; unavailable with an estimated history or an injector     [app]
//
// PRiSM_skinCheck (54, WP7-M1) is called at call time. Tests marked [app] run in the app built from sources and use
// the real PRiSM_skinCheck when the build has it; otherwise they install skinStub() below (an exact §3.4-shaped stub)
// and print a note. The other tests load 49-calc-buildup-trend.js alone in a bare vm context (self-test stripped as
// Round 9 strips it) with the stub, and assert nothing that depends on the skin module.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const S = require('./_buildup-shapes');
const { stripSelfTest } = require('../concat-round8.js');

const WP = 'BU3';
const FILE = path.join(__dirname, '..', '49-calc-buildup-trend.js');
const DAY = 86400000;
const T0 = Date.UTC(2026, 0, 10, 9);
const EV_ANY = /^(B\d+·)?[QDRWILMACUKTVO]\d+$/;
const BANNED = /\b(null|undefined|NaN|Infinity)\b|\[object Object\]/;
const J = (o) => JSON.parse(JSON.stringify(o));
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const isNum = (v) => typeof v === 'number' && isFinite(v);
const median = (a) => { const s = a.filter(isNum).sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2])) : null; };

// ── §3.4-shaped stand-in for PRiSM_skinCheck (used only when the build has no 54) ──
function skinStub() {
  return {
    _stub: true,
    perforationSkin() { return { ok: false, code: 'UNVERIFIED', errors: ['coefficient table not verified'], bad: [] }; },
    products(i) {
      const m = 162.6 * i.Dq * i.B * i.mu / (i.k * i.h);
      const X = Math.log(i.re_ft / i.rw) - 0.75, guard = X + i.S < 1, rinv = i.reSource === 'rinv', dp = 0.8686 * m * i.S;
      const FE = isNum(i.pbar) && isNum(i.pwf) && i.pbar > i.pwf ? (i.pbar - i.pwf - dp) / (i.pbar - i.pwf) : null;
      return { dpSkin_psi: dp, m, X, reAssumed: rinv, piRatio: guard ? null : X / (X + i.S), piRatioLowerBound: rinv,
               rateAtStakeUpperBound: rinv, FE, DR: FE ? 1 / FE : null, guard };
    },
    mechanicalSkin(i) {
      const c = i && i.completion;
      const none = { available: false, S_geo: null, S_geo_lo: null, S_geo_hi: null, parts: { pp: null, ppMethod: null, theta: null, perf: null },
                     S_mech: null, S_mech_err: null, S_d_local: null, validity: [], warnings: [] };
      if (!c || !(c.hp_ft > 0) || !(i.h > 0) || !(i.rw > 0)) return none;
      const pp = (kv) => (c.hp_ft >= i.h ? 0 : (i.h / c.hp_ft - 1) * (Math.log((i.h / i.rw) * Math.sqrt(1 / kv)) - 2));
      const a = pp(c.kvkh[0]), b = pp(c.kvkh[1]), g = pp(Math.sqrt(c.kvkh[0] * c.kvkh[1]));
      const dq = isNum(i.D) && isNum(i.q) ? i.D * i.q : 0, Sm = i.S_total - g - dq;
      return { available: true, S_geo: g, S_geo_lo: Math.min(a, b), S_geo_hi: Math.max(a, b), parts: { pp: g, ppMethod: 'stub', theta: 0, perf: null },
               S_mech: Sm, S_mech_err: Math.sqrt(i.Serr * i.Serr + Math.pow(Math.abs(a - b) / 2, 2)), S_d_local: Sm * c.hp_ft / i.h, validity: [], warnings: [] };
    },
    rateSkin(rows, opts) {
      opts = opts || {};
      let r = (rows || []).filter((x) => isNum(x.q) && x.q > 0 && isNum(x.S) && isNum(x.Serr) && x.Serr > 0 && isNum(x.t_days));
      const out = { resolved: false, S: null, D: null, seD: null, n: r.length, qRatio: null, joint: null, expectedD: null, consistent: null, reason: '', ev: ['T15'] };
      if (r.length) { const tEnd = Math.max(...r.map((x) => x.t_days)); r = r.filter((x) => tEnd - x.t_days <= (opts.maxDays || 60)); }
      out.n = r.length;
      if (r.length < 3) { out.reason = 'Fewer than 3 tests within the window.'; return out; }
      const qs = r.map((x) => x.q); out.qRatio = Math.max(...qs) / Math.min(...qs);
      if (out.qRatio < (opts.qRatioMin || 1.5)) { out.reason = 'Rate spread below 1.5 times.'; return out; }
      const w = r.map((x) => 1 / (x.Serr * x.Serr)), Sw = w.reduce((a, b) => a + b, 0);
      const qb = r.reduce((a, x, k) => a + w[k] * x.q, 0) / Sw, sb = r.reduce((a, x, k) => a + w[k] * x.S, 0) / Sw;
      const Sxx = r.reduce((a, x, k) => a + w[k] * (x.q - qb) * (x.q - qb), 0), Sxy = r.reduce((a, x, k) => a + w[k] * (x.q - qb) * (x.S - sb), 0);
      const D = Sxy / Sxx, S0 = sb - D * qb;
      const chi2 = r.reduce((a, x, k) => a + w[k] * Math.pow(x.S - S0 - D * x.q, 2), 0);
      const seD = Math.max(1, Math.sqrt(chi2 / (r.length - 2))) / Math.sqrt(Sxx);
      Object.assign(out, { S: S0, D, seD, resolved: Math.abs(D) / seD >= (opts.dseMin || 2), reason: 'Weighted fit of S′ = S + D·q.' });
      return out;
    },
  };
}

// The trend module alone in a bare context (no document, no PRiSM), with the stub.
function vmTrend() {
  const src = stripSelfTest(fs.readFileSync(FILE, 'utf8'), '49-calc-buildup-trend.js', { log() {}, warn() {} });
  const errors = [];
  const ctx = { console: { log() {}, warn() {}, error: (...a) => errors.push(a.join(' ')) } };
  ctx.window = ctx;
  vm.createContext(ctx);
  ctx.PRiSM_skinCheck = skinStub();
  vm.runInContext(src, ctx, { filename: FILE });
  if (errors.length) throw new Error('module load errors: ' + errors.join('; '));
  return ctx.WTS_buildup.trend;
}
// The trend module inside the app built from sources; installs the stub when the build has no PRiSM_skinCheck.
let _noted = false;
function appTrend(app, assert) {
  const w = app.win;
  assert(w.WTS_buildup && w.WTS_buildup.trend && typeof w.WTS_buildup.trend.compute === 'function', 'Round 9 carries WTS_buildup.trend');
  const sc = w.PRiSM_skinCheck;
  const need = ['mechanicalSkin', 'rateSkin', 'products'];
  if (!sc || need.some((k) => typeof sc[k] !== 'function')) {
    const stub = skinStub();
    w.PRiSM_skinCheck = sc || {};
    need.forEach((k) => { if (typeof w.PRiSM_skinCheck[k] !== 'function') w.PRiSM_skinCheck[k] = stub[k]; });
    w.PRiSM_skinCheck._stub = true;
    if (!_noted) { _noted = true; console.log('      note: PRiSM_skinCheck is not in this build; [app] tests use the §3.4 stub (re-run after WP7-M1 merges)'); }
  }
  return w.WTS_buildup.trend;
}

// ── fixtures ──
const WELL = { fluid: 'oil', h: 50, phi: 0.2, mu: 1, B: 1.2, ct: 1e-5, rw: 0.354, re_ft: 1500, Pb: 2500, Rs: 450, gas: null, Bw: 1.02, muw: 0.5,
               allocAccPct: 5, driftPsiPerDay: 0.01, defaulted: [], sens: { h: 0.2, phi: 0.1, ct: 0.3, rw: 0.05, B: 0.05, mu: 0.2, q: 0.1 } };
const SETTINGS = { detect: { winMin: 5, riseMin: 5, riseSig: 10, persistMin: 30, minDur_h: 2, gapN: 5, spike: 'off', partial: true },
                   interp: { Lcyc: 0.1, band: 0.10, slope: 0.03, minCycles: 0.5, rivals: 'auto', cheld: 'auto', kHeld: 'auto', tide: 'auto' },
                   trend: { baseN: 3, delta: 2, abs: 5, basevar: false, confirm: 'next', price: null, enabled: 'auto' }, report: { detail: 'selected' } };
const logTerm = (k, w) => Math.log10(k / (w.phi * w.mu * w.ct * w.rw * w.rw)) - 3.2275;
// TrendTest builder. o: {id, d (tDays), S, E, k, q, ks, kHeld, excluded, pStar, pExt, pExtKind, pwf0, chosen, iarf, iarfDt0,
//   dtEnd, tp, binS, reachFair, reachFairShut, gasSprime, qUnit, sSens, wli, pStarRange}
function tt(o, well) {
  well = well || WELL;
  const k = o.k != null ? o.k : 45, q = o.q != null ? o.q : 800, h = well.h;
  const m = 162.6 * q * well.B * well.mu / (k * h);
  const tp = o.tp != null ? o.tp : 480, dtEnd = o.dtEnd != null ? o.dtEnd : 72, dteEnd = tp * dtEnd / (tp + dtEnd);
  const sBins = o.binS != null ? o.binS : o.S;
  const dte = []; for (let x = 0.5; x < dteEnd * (1 - 1e-9); x *= Math.pow(10, 0.1)) dte.push(x); dte.push(dteEnd);
  const dp = dte.map((x) => m * (Math.log10(x) + logTerm(k, well) + 0.8686 * sBins));
  const t_ms = T0 + o.d * DAY, ks = o.ks || 'medium', E = o.E != null ? o.E : 0.3;
  const pStar = o.pStar !== undefined ? o.pStar : 4000 - 0.01 * o.d;
  const t = {
    id: o.id, t_ms, tDays: o.d, date: iso(t_ms), S: o.S, Serr: E, SerrExt: E, SerrMode: o.kHeld ? 'kHeld' : 'line',
    k, kh: k * h, C: 0.02, m, mPrime: m / Math.LN10, pStarDatum: pStar, pStarRangeDatum: o.pStarRange || null,
    pExtDatum: o.pExt !== undefined ? o.pExt : pStar, pExtKind: o.pExtKind || 'pStar', piModelDatum: null,
    pwf0Datum: o.pwf0 != null ? o.pwf0 : 3400, Dq: q, qUnit: o.qUnit || 'STB/d', rinv_ft: 0.0325 * Math.sqrt(k * dtEnd / (well.phi * well.mu * well.ct)),
    dpSkin_psi: 0.8686 * m * o.S, conf: { ks, model: ks, headline: ks }, chosen: o.chosen || 'homogeneous',
    fullySeen: o.chosen && o.chosen !== 'homogeneous' ? 'full' : 'n/a', kHeld: !!o.kHeld, excluded: !!o.excluded,
    excludedReason: o.excluded ? 'Excluded by override O1: the gauge was swapped.' : null, gasSprime: o.gasSprime != null ? o.gasSprime : null,
    partialSuspect: false, iarfDt0_h: o.iarf === false ? null : (o.iarfDt0 != null ? o.iarfDt0 : 15.5), dtEnd_h: dtEnd, dteEnd_h: dteEnd,
    reachFair_h: o.reachFair != null ? o.reachFair : 62, reachGood_h: 196, reachFairShut_h: o.reachFairShut !== undefined ? o.reachFairShut : 70,
    reachGoodShut_h: null, bins: { dte, dp },
  };
  if (o.sSens != null) t.sSens = o.sSens;
  if (o.wli) t.windowLevelInconsistent = true;
  return t;
}
function series(list, well) { return list.map((o) => tt(o, well)); }
function ctxOf(o) {
  return Object.assign({ well: WELL, completion: null, depth: null, settings: J(SETTINGS), days: [], workovers: [], fluid: 'oil', firstTest_ms: T0, mode: 'daily',
                         phaseBasis: { used: 'oil', wcMax: 0, gorRatioMax: 1, twoPhaseCt: false }, start: { source: 'date', prepend_h: 1000, q: 800, flag: false },
                         historyEstimated: false, baseline: null }, o || {});
}
function trendSet(patch) { const s = J(SETTINGS); Object.assign(s.trend, patch); return s; }
function fixCtx(an) {
  return { well: an.well, completion: an.completion, depth: an.depth, settings: an.settings, days: an.rates.days, workovers: [], fluid: an.well.fluid,
           firstTest_ms: an.tests[0].tc_ms, mode: an.rates.mode, phaseBasis: an.rates.phaseBasis, start: an.rates.start, historyEstimated: false, baseline: an.baseline };
}
function shapeOk(assert, out, label) {
  const r = S.checkShape('Trend', J(out));
  assert(r.ok, (label || 'Trend') + ' passes checkShape: ' + JSON.stringify(r.errors.slice(0, 6)));
}
function near(assert, a, b, tol, what) { assert(isNum(a) && Math.abs(a - b) <= tol, what + ': got ' + a + ', expected ' + b + ' ± ' + tol); }
const baseS = (S0, E) => [{ id: 'B1', d: 0, S: S0[0], E }, { id: 'B2', d: 20, S: S0[1], E }, { id: 'B3', d: 40, S: S0[2], E }];
// piecewise-linear interpolation (constant outside) — test-side copy for independent recomputation
function lin(kn, x) {
  if (x <= kn[0][0]) return kn[0][1];
  for (let i = 1; i < kn.length; i++) if (x <= kn[i][0]) return kn[i - 1][1] + (kn[i][1] - kn[i - 1][1]) * (x - kn[i - 1][0]) / (kn[i][0] - kn[i - 1][0]);
  return kn[kn.length - 1][1];
}
// S(t) knots as §4.7 defines them (used tests, onset knot (τ̂, S_base) inserted between tests)
function sKnotsOf(out, tests) {
  const used = tests.filter((t) => out.series.find((s) => s.id === t.id).used.trend);
  const vals = used.map((t) => [t.tDays, t.S]), tau = out.onset.tauDays, Sb = out.baseline.S;
  if (tau == null || vals.some((k) => Math.abs(k[0] - tau) < 1e-9)) return vals;
  return vals.filter((k) => k[0] < tau).concat([[tau, Sb]]).concat(vals.filter((k) => k[0] > tau));
}

module.exports = [
  {
    name: 'TR1 baseline: median of the first 3 used tests, σ_base, unstable and provisional; a workover date starts a segment; FIX baseline',
    wp: WP, opts: false,
    run(app, assert) {
      const T = vmTrend();
      const five = series(baseS([1.0, 1.4, 1.2], 0.3).concat([{ id: 'B4', d: 60, S: 1.3 }, { id: 'B5', d: 80, S: 1.1 }]));
      let out = T.compute(five, ctxOf());
      shapeOk(assert, out);
      assert.strictEqual(out.baseline.S, 1.2, 'S_base = median of B1–B3');
      assert.deepStrictEqual(J(out.baseline.tests), ['B1', 'B2', 'B3']);
      near(assert, out.baseline.sigma, 0.3, 1e-12, 'σ_base = median S_err (1.4826·MAD/√n = 0.171 is smaller)');
      assert(!out.baseline.unstable && !out.baseline.provisional, 'stable, not provisional');
      assert.deepStrictEqual(J(out.series.map((s) => s.used.baseline)), [true, true, true, false, false], 'used.baseline flags');
      // σ from the MAD when it is the larger term
      out = T.compute(series(baseS([1.0, 1.4, 1.2], 0.1)), ctxOf());
      near(assert, out.baseline.sigma, 1.4826 * 0.2 / Math.sqrt(3), 1e-12, 'σ_base = 1.4826·MAD/√n');
      // unstable: range > 2·max S_err
      out = T.compute(series(baseS([0.5, 2.0, 1.0], 0.3)), ctxOf());
      assert.strictEqual(out.baseline.unstable, true, 'range 1.5 > 0.6 → unstable');
      assert.strictEqual(out.baseline.S, 1.0);
      // provisional: fewer than 3 used tests, or a k-held baseline test
      out = T.compute(series(baseS([1.0, 1.4, 1.2], 0.3).slice(0, 2)), ctxOf());
      assert.strictEqual(out.baseline.provisional, true, '2 tests → provisional');
      out = T.compute(series([{ id: 'B1', d: 0, S: 1.0 }, { id: 'B2', d: 20, S: 1.2, kHeld: true }, { id: 'B3', d: 40, S: 1.1 }]), ctxOf());
      assert.strictEqual(out.baseline.provisional, true, 'k-held baseline test → provisional');
      // low and excluded tests are not baseline tests
      out = T.compute(series([{ id: 'B1', d: 0, S: 3, ks: 'low' }, { id: 'B2', d: 10, S: 3, excluded: true }, { id: 'B3', d: 20, S: 1.1 },
                              { id: 'B4', d: 40, S: 1.2 }, { id: 'B5', d: 60, S: 1.3 }]), ctxOf());
      assert.deepStrictEqual(J(out.baseline.tests), ['B3', 'B4', 'B5'], 'low B1 and excluded B2 skipped');
      assert.strictEqual(out.baseline.S, 1.2);
      assert.deepStrictEqual(J(out.series[0].used), { baseline: false, trend: false, alert: false }, 'a low test is not used');
      assert.strictEqual(out.nUsed, 3);
      // workover date: a new segment, a new baseline and no alert carried across it
      const wo = [{ id: 'B1', d: 0, S: 1.2 }, { id: 'B2', d: 20, S: 1.3 }, { id: 'B3', d: 40, S: 1.1 }, { id: 'B4', d: 60, S: 5.0 }, { id: 'B5', d: 80, S: 5.2 }, { id: 'B6', d: 100, S: 4.9 }];
      const woDate = iso(T0 + 50 * DAY);
      out = T.compute(series(wo), ctxOf({ workovers: [woDate] }));
      shapeOk(assert, out, 'with workover');
      assert.strictEqual(out.baseline.segments.length, 2, 'two segments');
      assert.strictEqual(out.baseline.segments[1].from, woDate, 'the second segment starts at the workover date');
      assert.deepStrictEqual(J(out.baseline.segments[0].tests), ['B1', 'B2', 'B3']);
      assert.strictEqual(out.baseline.S, 5.0, 'current baseline = median of B4–B6');
      assert.strictEqual(out.alerts.delta.status, 'none', 'no delta alert inside the new segment');
      out = T.compute(series(wo), ctxOf());
      assert.strictEqual(out.alerts.delta.raisedAt, 'B4', 'without the workover date the rise raises at B4');
      assert.strictEqual(out.alerts.delta.status, 'confirmed');
      // the helper itself (stage 2 calls it with pass-1 tests)
      const b = T.baseline(five, 2, { workovers: [] });
      assert.deepStrictEqual(J(b.tests), ['B1', 'B2'], 'n = 2');
      assert.strictEqual(b.provisional, true, 'fewer than 3 → provisional');
      assert.strictEqual(b.k, 45); assert.strictEqual(b.cvK, 0); assert.strictEqual(b.kh, 2250);
      assert.strictEqual(T.baseline(five, 3, []).S, 1.2, 'array form of the workovers option');
      // FIX: baseline reproduced from the stored inputs
      const an = S.FIX.analysis;
      out = T.compute(S.FIX.samples.TrendTests, fixCtx(an));
      shapeOk(assert, out, 'FIX');
      ['S', 'sigma', 'tests', 'unstable', 'provisional'].forEach((k) => assert.deepStrictEqual(J(out.baseline[k]), J(an.trend.baseline[k]), 'FIX baseline.' + k));
      assert.deepStrictEqual(J(out.baseline.segments.map((g) => ({ from: g.from, S: g.S, tests: g.tests }))), J(an.trend.baseline.segments), 'FIX segments');
      assert.deepStrictEqual(J(out.series.map((s) => s.used)), J(an.trend.series.map((s) => s.used)), 'FIX used flags');
    },
  },

  {
    name: 'TR2 delta and absolute alerts: raised, confirmed, provisional, possible; immediate (high + 1); plain vs basevar; kHeldOnly; D27; FIX',
    wp: WP, opts: false,
    run(app, assert) {
      const T = vmTrend();
      const base = baseS([1.2, 1.3, 1.1], 0.3);
      // raised at B4, confirmed at the next used test that meets it
      let out = T.compute(series(base.concat([{ id: 'B4', d: 60, S: 4.0, E: 0.4 }, { id: 'B5', d: 80, S: 4.5, E: 0.4 }])), ctxOf());
      shapeOk(assert, out);
      assert.deepStrictEqual([out.alerts.delta.raisedAt, out.alerts.delta.confirmedAt, out.alerts.delta.status], ['B4', 'B5', 'confirmed']);
      assert.strictEqual(out.alerts.delta.form, 'plain'); assert.strictEqual(out.alerts.delta.threshold, 2); assert.strictEqual(out.alerts.delta.inputRobust, true);
      // provisional: no confirming test yet
      out = T.compute(series(base.concat([{ id: 'B4', d: 60, S: 4.0, E: 0.4 }, { id: 'B5', d: 80, S: 1.4 }])), ctxOf());
      assert.deepStrictEqual([out.alerts.delta.raisedAt, out.alerts.delta.confirmedAt, out.alerts.delta.status], ['B4', null, 'provisional']);
      // possible: only a test labelled low exceeds the threshold
      out = T.compute(series(base.concat([{ id: 'B4', d: 60, S: 4.0, E: 0.4, ks: 'low' }])), ctxOf());
      assert.deepStrictEqual([out.alerts.delta.raisedAt, out.alerts.delta.status], [null, 'possible'], 'excluded low test above the threshold → possible');
      assert.strictEqual(out.excludedLow.n, 1);
      // immediate confirmation: the raising test is high and exceeds the threshold by ≥ 1 (4.6 − 0.4 − 1.2 − 2 = 1.0)
      out = T.compute(series(base.concat([{ id: 'B4', d: 60, S: 4.6, E: 0.4, ks: 'high' }])), ctxOf());
      assert.deepStrictEqual([out.alerts.delta.raisedAt, out.alerts.delta.confirmedAt, out.alerts.delta.status], ['B4', 'B4', 'confirmed'], 'high + 1');
      out = T.compute(series(base.concat([{ id: 'B4', d: 60, S: 4.5, E: 0.4, ks: 'high' }])), ctxOf());
      assert.strictEqual(out.alerts.delta.status, 'provisional', 'high but only 0.9 above → provisional');
      out = T.compute(series(base.concat([{ id: 'B4', d: 60, S: 4.6, E: 0.4, ks: 'medium' }])), ctxOf());
      assert.strictEqual(out.alerts.delta.status, 'provisional', 'medium label → no immediate confirmation');
      out = T.compute(series(base.concat([{ id: 'B4', d: 60, S: 4.0, E: 0.4 }])), ctxOf({ settings: trendSet({ confirm: 'immediate' }) }));
      assert.strictEqual(out.alerts.delta.confirmedAt, 'B4', "confirm 'immediate' setting");
      // plain vs basevar: σ_base 0.5, S_err 0.3, S 3.6 → plain 2.1 > 2, basevar 3.6 − √(0.09 + 0.25) − 1.2 = 1.82
      const bv = baseS([1.2, 1.3, 1.1], 0.5).concat([{ id: 'B4', d: 60, S: 3.6, E: 0.3 }]);
      out = T.compute(series(bv), ctxOf());
      assert.deepStrictEqual([out.alerts.delta.form, out.alerts.delta.status], ['plain', 'provisional']);
      out = T.compute(series(bv), ctxOf({ settings: trendSet({ basevar: true }) }));
      assert.deepStrictEqual([out.alerts.delta.form, out.alerts.delta.status], ['basevar', 'none'], 'basevar form is wider');
      // kHeldOnly: every contributing test is k-held
      out = T.compute(series(base.concat([{ id: 'B4', d: 60, S: 4.0, E: 0.6, kHeld: true }, { id: 'B5', d: 80, S: 4.4, E: 0.6, kHeld: true }])), ctxOf());
      assert.deepStrictEqual([out.alerts.delta.status, out.alerts.delta.kHeldOnly], ['confirmed', true], 'k-held tests raise and confirm with their own S_err');
      out = T.compute(series(base.concat([{ id: 'B4', d: 60, S: 4.0, E: 0.6, kHeld: true }, { id: 'B5', d: 80, S: 4.4, E: 0.3 }])), ctxOf());
      assert.strictEqual(out.alerts.delta.kHeldOnly, false, 'a free-k test contributes');
      out = T.compute(series(base.concat([{ id: 'B4', d: 60, S: 3.9, E: 0.9, kHeld: true }])), ctxOf());
      assert.strictEqual(out.alerts.delta.status, 'none', 'a large k-held S_err (incl. S_k) does not raise: 3.9 − 0.9 − 1.2 < 2');
      // D27: S − S_err − S_base = 2 + 1e-10 rounds to exactly 2.00 → not above the threshold
      out = T.compute(series(base.concat([{ id: 'B4', d: 60, S: 3.5 + 1e-10, E: 0.3 }])), ctxOf());
      assert.strictEqual(out.alerts.delta.status, 'none', 'decision on values rounded to display precision');
      // absolute alert on the total skin: S − S_err > 5
      out = T.compute(series(base.concat([{ id: 'B4', d: 60, S: 5.2, E: 0.3 }, { id: 'B5', d: 80, S: 6.0, E: 0.3 }, { id: 'B6', d: 100, S: 6.5, E: 0.3 }])), ctxOf());
      const a = out.alerts.absolute;
      assert.deepStrictEqual([a.basis, a.threshold, a.raisedAt, a.confirmedAt, a.status], ['total', 5, 'B5', 'B6', 'confirmed']);
      out = T.compute(series(base.concat([{ id: 'B4', d: 60, S: 5.6, E: 0.3, ks: 'low' }])), ctxOf());
      assert.strictEqual(out.alerts.absolute.status, 'possible', 'absolute: only a low test exceeds → possible');
      // FIX: alerts reproduced
      const an = S.FIX.analysis;
      out = T.compute(S.FIX.samples.TrendTests, fixCtx(an));
      assert.deepStrictEqual(J(out.alerts), J(an.trend.alerts), 'FIX alerts');
    },
  },

  {
    name: 'TR3 absolute robustness with ±S_sens; basis switches to mechanical when the completion is given',
    wp: WP,
    run(app, assert) {
      const T = appTrend(app, assert);
      const base = baseS([1.2, 1.2, 1.2], 0.2);
      // nominal: raised B5 (5.4 − 0.3), confirmed B6; S_sens 0.23 (typical ranges) moves both ends
      const mv = series(base.concat([{ id: 'B4', d: 60, S: 5.0, E: 0.2 }, { id: 'B5', d: 80, S: 5.4, E: 0.3 }, { id: 'B6', d: 100, S: 6.0, E: 0.3 }]));
      let out = T.compute(app.toWin(mv), app.toWin(ctxOf()));
      shapeOk(assert, out);
      let a = out.alerts.absolute;
      assert.deepStrictEqual([a.raisedAt, a.confirmedAt, a.status], ['B5', 'B6', 'confirmed']);
      near(assert, T.sSensOf(WELL.sens), 0.2304, 5e-4, 'S_sens from the typical ranges (Appendix A.2)');
      assert.deepStrictEqual(J(a.robustness), { lo: null, hi: 'B5', unchanged: false }, 'S − S_sens: no confirmed alert; S + S_sens: confirmed at B5');
      // unchanged when the rise is far above the threshold
      const far = series(base.concat([{ id: 'B4', d: 60, S: 8.0 }, { id: 'B5', d: 80, S: 9.0 }]));
      out = T.compute(app.toWin(far), app.toWin(ctxOf()));
      assert.deepStrictEqual(J(out.alerts.absolute.robustness), { lo: 'B5', hi: 'B5', unchanged: true }, 'first confirmed test unchanged');
      // TrendTest.sSens (= result.sErr.sSens) is used when given
      out = T.compute(app.toWin(far.map((t) => Object.assign({}, t, { sSens: 3 }))), app.toWin(ctxOf()));
      assert.strictEqual(out.alerts.absolute.robustness.unchanged, false, 'S_sens 3 moves the confirmed test');
      // mechanical basis: S_mech = S − S_geo − D·q (pressure-drop basis; oil → D null)
      const rise = series(baseS([1.2, 1.3, 1.1], 0.3).concat([{ id: 'B4', d: 60, S: 6.5 }, { id: 'B5', d: 80, S: 8.0 }, { id: 'B6', d: 100, S: 10.0 }]));
      const tot = T.compute(app.toWin(rise), app.toWin(ctxOf()));
      assert.strictEqual(tot.alerts.absolute.basis, 'total', 'no completion → total skin');
      assert.strictEqual(tot.mech.available, false);
      const completion = { hp_ft: 30, htop_ft: 10, theta_deg: 0, kvkh: [0.1, 0.5], perf: null };
      out = T.compute(app.toWin(rise), app.toWin(ctxOf({ completion })));
      shapeOk(assert, out, 'mechanical');
      assert.strictEqual(out.mech.available, true, 'completion → mechanical skin available');
      assert.strictEqual(out.mech.basis, 'pressureDrop');
      assert.strictEqual(out.alerts.absolute.basis, 'mechanical', 'absolute alert on the mechanical skin');
      assert(isNum(out.mech.Sgeo) && out.mech.SgeoRange[0] <= out.mech.Sgeo + 1e-9 && out.mech.Sgeo <= out.mech.SgeoRange[1] + 1e-9, 'S_geo inside its range');
      out.series.forEach((s) => near(assert, s.Smech, s.S - out.mech.Sgeo, 1e-6, s.id + ' S_mech = S − S_geo'));
      // the raise follows S_mech − S_mech_err > 5 (rounded to 2 dp) on the used tests
      const h = (x) => Math.round(x * 100);
      const exp = out.series.find((s) => s.used.alert && h(s.Smech) - h(s.SmechErr) - 500 > 0);
      assert.strictEqual(out.alerts.absolute.raisedAt, exp ? exp.id : null, 'absolute raise on the mechanical basis');
      assert.deepStrictEqual(J(out.alerts.delta), J(tot.alerts.delta), 'the delta alert stays on the total skin');
      assert(out.limitations.some((l) => l.code === 'totalSkin' && /mechanical/.test(l.text)), 'limitation states the mechanical basis');
    },
  },

  {
    name: 'TR4 hinge onset on a synthetic step and a ramp within one test interval; CUSUM alarm and onset',
    wp: WP, opts: false,
    run(app, assert) {
      const T = vmTrend();
      const days = [0, 10, 20, 30, 40, 50, 60, 70];
      // step: S 1 → 6 between day 30 and day 40
      const step = series(days.map((d, i) => ({ id: 'B' + (i + 1), d, S: i < 4 ? 1.0 + [0, 0.05, -0.05, 0][i] : 6.0 + [0, 0.1, -0.1, 0][i - 4], E: 0.3 })));
      let out = T.compute(step, ctxOf());
      shapeOk(assert, out);
      const o = out.onset;
      assert.deepStrictEqual([o.model, o.shape], ['hinge', 'step']);
      assert(Math.abs(o.tauDays - 35) <= 10, 'step onset within one interval of the step (day 35): ' + o.tauDays);
      assert(o.interval[0] <= o.tauDays && o.tauDays <= o.interval[1], 'profile interval contains τ̂');
      assert.strictEqual(o.date, iso(T0 + o.tauDays * DAY), 'onset date = first test + τ̂');
      assert.deepStrictEqual(J(o.cusum), { alarmAt: 'B5', onsetAt: 'B4' }, 'CUSUM alarm at the first high test, onset after the last baseline-level test');
      assert.strictEqual(o.indicative, false, 'n = 8 ≥ 6');
      assert.deepStrictEqual([out.alerts.delta.raisedAt, out.alerts.delta.confirmedAt], ['B5', 'B6']);
      // ramp: S = 1 until day 30, then +0.1 per day
      const ramp = series(days.map((d, i) => ({ id: 'B' + (i + 1), d, S: d <= 30 ? 1.0 + [0, 0.05, -0.05, 0][i] : 1.0 + 0.1 * (d - 30), E: 0.3 })));
      out = T.compute(ramp, ctxOf());
      assert.deepStrictEqual([out.onset.model, out.onset.shape], ['hinge', 'ramp']);
      assert(Math.abs(out.onset.tauDays - 30) <= 10, 'ramp onset within one interval of day 30: ' + out.onset.tauDays);
      // helpers: constant / line / hinge by BIC; the window restriction; indicative below 6 tests
      const w = days.map(() => 1 / 0.09);
      assert.strictEqual(T.hinge(days, [1, 1.1, 0.9, 1.0, 1.05, 0.95, 1.0, 1.1], w).model, 'constant', 'flat → constant');
      assert.strictEqual(T.hinge(days, days.map((d) => 1 + 0.05 * d), w).model, 'line', 'straight rise → line');
      const hr = T.hinge(days, days.map((d) => (d <= 30 ? 1 : 1 + 0.1 * (d - 30))), w);
      assert.deepStrictEqual([hr.model, hr.tau], ['hinge', 30], 'exact ramp → τ̂ = 30');
      assert.strictEqual(hr.shape, 'ramp');
      const hs = T.hinge(days, [1, 1, 1, 1, 6, 6, 6, 6], w);
      assert.deepStrictEqual([hs.model, hs.shape, hs.tau], ['hinge', 'step', 35], 'step: τ̂ midway between the bracketing tests');
      near(assert, hs.jump, 5, 1e-9, 'step size'); near(assert, hs.b, 0, 1e-9, 'flat after the step');
      assert(hs.interval[0] >= 30 && hs.interval[1] < 40, 'step interval inside the bracketing tests: ' + hs.interval);
      assert.strictEqual(T.hinge(days.slice(0, 5), [1, 1, 1, 2, 3], w.slice(0, 5)).indicative, true, 'n < 6 → indicative');
      // CUSUM helper: alarm at the first C > h, onset at the last C = 0 before it
      const c = T.cusum([0, 0.1, -0.2, 0.05, 15, 16], 0.5, 4);
      assert.deepStrictEqual([c.alarm, c.onset], [4, 3]);
      assert.deepStrictEqual(J(T.cusum([0.6, 0.7, 5], 0.5, 4)).onset, null, 'C never 0 before the alarm → onset unknown');
      // no change → constant, no onset
      out = T.compute(series(days.map((d, i) => ({ id: 'B' + (i + 1), d, S: 1.0 + [0, 0.1, -0.1, 0.05, -0.05, 0.1, 0, -0.1][i] }))), ctxOf());
      assert.deepStrictEqual([out.onset.model, out.onset.tauDays, out.onset.date, out.onset.cusum.alarmAt], ['constant', null, null, null]);
    },
  },

  {
    name: 'TR5 Theil–Sen slope and Sen CI against hand values; Mann–Kendall z; recent trend n ≤ 4 indicative',
    wp: WP, opts: false,
    run(app, assert) {
      const T = vmTrend();
      // hand values: slopes of (0,1)(1,3)(2,2)(3,5)(4,4) sorted −1 −1 ⅓ ½ ¾ 1 1 4⁄3 2 3 → median 0.875; intercept median(y − 0.875t) = 1
      let ts = T.theilSen([0, 1, 2, 3, 4], [1, 3, 2, 5, 4]);
      near(assert, ts.slope, 0.875, 1e-12, 'Theil–Sen slope'); near(assert, ts.intercept, 1, 1e-12, 'intercept');
      // Sen CI: N = 10, Var(S) = 5·4·15/18, C = 1.96·√Var = 8.0016 → M1 = 0.999 (rank 1 → −1), M2 + 1 = 10.0008 (rank 10 → 3)
      assert.deepStrictEqual([ts.lo, ts.hi, ts.nPairs], [-1, 3, 10], 'Sen CI clamps to the extreme slopes');
      // a 10-point case against an independent rank computation
      const t10 = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], y10 = t10.map((x, i) => x + [0.3, -0.2, 0.1, -0.4, 0.2, 0, -0.1, 0.4, -0.3, 0.1][i]);
      const sl = []; for (let i = 0; i < 10; i++) for (let j = i + 1; j < 10; j++) sl.push((y10[j] - y10[i]) / (t10[j] - t10[i]));
      sl.sort((p, q) => p - q);
      const C = 1.959964 * Math.sqrt(10 * 9 * 25 / 18), M1 = (45 - C) / 2, M2 = (45 + C) / 2 + 1;
      const at = (r) => sl[Math.floor(r) - 1] + (r - Math.floor(r)) * (sl[Math.floor(r)] - sl[Math.floor(r) - 1]);
      ts = T.theilSen(t10, y10);
      near(assert, ts.slope, sl[22], 1e-12, 'slope = median of 45 slopes');
      near(assert, ts.lo, at(M1), 1e-12, 'Sen lower limit (rank M1)'); near(assert, ts.hi, at(M2), 1e-12, 'Sen upper limit (rank M2 + 1)');
      // Mann–Kendall: S = 6, Var = 50/3, z = 5/√(50/3) = 1.2247, p = 0.2207; ties: Var = (4·3·13 − 2·1·9)/18
      const mk = T.mannKendall([1, 3, 2, 5, 4]);
      assert.strictEqual(mk.S, 6); near(assert, mk.varS, 50 / 3, 1e-12, 'Var(S)');
      near(assert, mk.z, 5 / Math.sqrt(50 / 3), 1e-12, 'z'); near(assert, mk.p, 0.22067, 2e-5, 'two-sided p');
      near(assert, T.mannKendall([1, 2, 2, 3]).varS, (156 - 18) / 18, 1e-12, 'tie-corrected Var(S)');
      // the recent trend in compute: Theil–Sen ×30 over the tests after τ̂; n = 4 → indicative, n = 5 → not
      const mkSet = (n) => series([0, 10, 20, 30].map((d, i) => ({ id: 'B' + (i + 1), d, S: 1.0, E: 0.3 }))
        .concat(Array.from({ length: n }, (_, i) => ({ id: 'B' + (5 + i), d: 40 + 10 * i, S: 2.0 + i + [0.05, -0.05, 0.04, -0.04, 0.02][i], E: 0.3 }))));
      let out = T.compute(mkSet(4), ctxOf());
      shapeOk(assert, out);
      assert.strictEqual(out.onset.model, 'hinge'); near(assert, out.onset.tauDays, 30, 1e-9, 'τ̂ = day 30');
      const r4 = out.recent, p4 = out.series.filter((s) => s.tDays > 30);
      const ts4 = T.theilSen(p4.map((s) => s.tDays), p4.map((s) => s.S));
      assert.strictEqual(r4.n, 4); assert.strictEqual(r4.indicative, true, 'n = 4 → indicative');
      near(assert, r4.slopePer30d, 30 * ts4.slope, 1e-12, 'slope per 30 days'); near(assert, r4.ci[0], 30 * ts4.lo, 1e-12, 'CI lo');
      near(assert, r4.mkZ, T.mannKendall(p4.map((s) => s.S)).z, 1e-12, 'MK z over the recent tests');
      out = T.compute(mkSet(5), ctxOf());
      assert.deepStrictEqual([out.recent.n, out.recent.indicative], [5, false], 'n = 5 → significant form');
      assert(isNum(out.recent.wlsSlopePer30d) && out.recent.disagree === false, 'WLS slope agrees with Theil–Sen');
    },
  },

  {
    name: 'TR6 forecast: shown from the Sen line, hidden when the lower bound ≤ 0, horizon cap',
    wp: WP, opts: false,
    run(app, assert) {
      const T = vmTrend();
      const base4 = (E) => [0, 10, 20, 30].map((d, i) => ({ id: 'B' + (i + 1), d, S: 1.0, E }));
      // rising 0.05 per day after day 30 → crossing of S − S_err = 5 within the horizon
      const rise = series(base4(0.3).concat([40, 50, 60, 70, 80].map((d, i) => ({ id: 'B' + (5 + i), d, S: 1.0 + 0.05 * (d - 30) + [0.02, -0.02, 0.01, -0.01, 0][i], E: 0.3 }))));
      let out = T.compute(rise, ctxOf());
      shapeOk(assert, out);
      const f = out.forecast;
      assert.strictEqual(f.show, true, 'shown: ' + f.reason);
      const post = out.series.filter((s) => s.tDays > out.onset.tauDays), ts = T.theilSen(post.map((s) => s.tDays), post.map((s) => s.S));
      const tLast = post[post.length - 1].tDays, target = 5 + median(post.map((s) => s.Serr));
      const tc = tLast + (target - (ts.intercept + ts.slope * tLast)) / ts.slope;
      assert.strictEqual(f.date, iso(T0 + tc * DAY), 'crossing date from the Sen line');
      assert(f.earliest <= f.date && (f.latest === null || f.latest >= f.date), 'range from the slope bounds');
      assert(f.reason.length > 0 && f.reason.length < 300 && !BANNED.test(f.reason));
      // lower bound ≤ 0: a weak, insignificant rise (no onset; recent = all tests)
      out = T.compute(series([1.0, 1.2, 0.9, 1.25, 1.0, 1.3].map((s, i) => ({ id: 'B' + (i + 1), d: 10 * i, S: s }))), ctxOf());
      assert(out.recent.slopePer30d > 0 && out.recent.ci[0] <= 0, 'positive slope, lower bound ≤ 0');
      assert.strictEqual(out.forecast.show, false);
      assert(/lower bound/.test(out.forecast.reason), 'reason names the lower bound: ' + out.forecast.reason);
      // horizon: 0.01 per day from 1.5 → 5.05 is 355 days away, beyond 2 × the 50-day post-onset span
      const slow = series(base4(0.05).concat([40, 50, 60, 70, 80].map((d, i) => ({ id: 'B' + (5 + i), d, S: 1.0 + 0.01 * (d - 30), E: 0.05 }))));
      out = T.compute(slow, ctxOf());
      assert(out.recent.ci[0] > 0, 'significant slow rise');
      assert.strictEqual(out.forecast.show, false);
      assert(/beyond/.test(out.forecast.reason), 'horizon cap: ' + out.forecast.reason);
      assert.deepStrictEqual([out.forecast.date, out.forecast.earliest, out.forecast.latest], [null, null, null]);
      // trend off → hidden with a reason
      out = T.compute(rise, ctxOf({ settings: trendSet({ enabled: 'off' }) }));
      assert.strictEqual(out.forecast.show, false); assert(out.forecast.reason.length > 0);
    },
  },

  {
    name: 'TR7 products: PI ratio 0.865 / 0.509, rate factor 1.698, extra drawdown 374 psi; guard; m; r_inv bounds; FIX T7/T8',
    wp: WP,
    run(app, assert) {
      const T = appTrend(app, assert);
      assert(!(app.win.WTS_calcRegistry || {}).trend && !(app.win.WTS_calcRegistry || {}).buildup_trend, 'the helper module adds no page');
      // X = 7.68: re = rw·e^(7.68 + 0.75); q 800, B 1.2, μ 1, k 45, h 50 → 141.2·qBμ/kh = 60.25 psi per unit skin
      const well = Object.assign({}, WELL, { re_ft: WELL.rw * Math.exp(7.68 + 0.75) });
      const list = series(baseS([1.2, 1.2, 1.2], 0.3).concat([{ id: 'B4', d: 60, S: 7.4 }]), well);
      let out = T.compute(app.toWin(list), app.toWin(ctxOf({ well })));
      shapeOk(assert, out);
      const pi = out.pi;
      near(assert, pi.X, 7.68, 1e-9, 'X'); assert.strictEqual(pi.reSource, 'input');
      near(assert, pi.ratioBase, 0.865, 5e-4, 'PI ratio at the baseline'); near(assert, pi.ratioNow, 0.509, 5e-4, 'PI ratio now');
      near(assert, pi.rateAtStake / 800 + 1, 1.698, 5e-4, 'rate factor (X + S_now)/(X + S_base)');
      near(assert, pi.rateAtStake, 800 * (15.08 / 8.88 - 1), 1e-6, 'rate at stake (constant drawdown)');
      near(assert, pi.extraDrawdown_psi / 6.2, 141.2 * 800 * 1.2 * 1 / (45 * 50), 1e-9, 'extra drawdown per unit skin = 141.2·qBμ/kh');
      near(assert, pi.extraDrawdown_psi, 374, 0.5, 'extra drawdown (constant rate)');
      assert.deepStrictEqual([pi.ratioLowerBound, pi.atStakeUpperBound, pi.guard, pi.rateUnit, pi.cumUnit], [false, false, false, 'STB/d', 'STB']);
      // m = 162.6·Δq·B·μ/(k·h) from the skin module, as the trend passes it
      const pr = app.win.PRiSM_skinCheck.products(app.toWin({ S: 7.4, k: 45, h: 50, B: 1.2, mu: 1, q: 800, Dq: 800, rw: well.rw, re_ft: well.re_ft, reSource: 'input', pbar: null, pwf: 3400 }));
      near(assert, pr.m, 162.6 * 800 * 1.2 / (45 * 50), 1e-9, 'products().m'); near(assert, pr.dpSkin_psi, 0.8686 * pr.m * 7.4, 1e-6, 'products().dpSkin');
      // T7: Δp across the skin per test (0.8686·m·S), never equated with the extra drawdown
      out.skinDp.forEach((r, i) => near(assert, r.dpSkin_psi, list[i].dpSkin_psi, 1e-9, r.id + ' Δp_skin'));
      // guard: X + S < 1 → not computable
      const neg = series(baseS([-6.9, -6.9, -6.9], 0.3).concat([{ id: 'B4', d: 60, S: -7.0 }]), well);
      out = T.compute(app.toWin(neg), app.toWin(ctxOf({ well })));
      shapeOk(assert, out, 'guard');
      assert.deepStrictEqual([out.pi.guard, out.pi.ratioNow, out.pi.rateAtStake, out.pi.cumAtStake], [true, null, null, null], 'guard → not computable');
      assert(out.limitations.some((l) => l.code === 'negSkin' && /strongly negative/.test(l.text)), 'guard stated');
      // r_e unknown → r_inv: PI ratio a lower bound, production at stake an upper bound
      const noRe = Object.assign({}, WELL, { re_ft: null });
      out = T.compute(app.toWin(series(baseS([1.2, 1.2, 1.2], 0.3).concat([{ id: 'B4', d: 60, S: 4.0 }]), noRe)), app.toWin(ctxOf({ well: noRe })));
      shapeOk(assert, out, 'rinv');
      assert.deepStrictEqual([out.pi.reSource, out.pi.ratioLowerBound, out.pi.atStakeUpperBound], ['rinv', true, true]);
      near(assert, out.pi.re_ft, Math.max(...out.series.map((s, i) => 0.0325 * Math.sqrt(45 * 72 / (0.2 * 1 * 1e-5)))), 1e-9, 'r_e = max r_inv');
      const pss = out.limitations.find((l) => l.code === 'pss');
      assert(pss && /lower bound/.test(pss.text) && /upper bound/.test(pss.text), '"lower bound" and "upper bound" labels');
      // FIX: T7 and T8 (the cumulative recomputed with this run's onset, §4.7)
      const an = S.FIX.analysis, tts = S.FIX.samples.TrendTests;
      out = T.compute(app.toWin(tts), app.toWin(fixCtx(an)));
      assert.deepStrictEqual(J(out.skinDp), J(an.trend.skinDp), 'FIX skinDp');
      ['X', 're_ft', 'reSource', 'ratioNow', 'ratioBase', 'ratioLowerBound', 'rateAtStake', 'rateUnit', 'cumUnit', 'atStakeUpperBound', 'value', 'guard'].forEach((k) =>
        assert(S.nearDisplay(k, out.pi[k], an.trend.pi[k]) || out.pi[k] === an.trend.pi[k], 'FIX pi.' + k + ': ' + out.pi[k] + ' vs ' + an.trend.pi[k]));
      near(assert, out.pi.extraDrawdown_psi, an.trend.pi.extraDrawdown_psi, 1e-6, 'FIX extra drawdown');
      const kn = sKnotsOf(out, tts), X = S.FORMULAS.X(an.well.re_ft, an.well.rw), first = an.tests[0].tc_ms;
      let cum = 0;
      an.rates.days.forEach((d) => { const td = (0.5 * (d.t0_ms + d.t1_ms) - first) / DAY; if (td >= out.onset.tauDays) cum += S.FORMULAS.atStakeDay(d.q, X, lin(kn, td), out.baseline.S); });
      near(assert, out.pi.cumAtStake, cum, 1e-6 * Math.abs(cum), 'cumulative since τ̂ (q_d per day)');
    },
  },

  {
    name: 'TR8 k stability: CV, the Appendix A.3 readings and the stage-3 window inconsistency reported',
    wp: WP, opts: false,
    run(app, assert) {
      const T = vmTrend();
      const mk = (ks, Ss, qs) => series(ks.map((k, i) => ({ id: 'B' + (i + 1), d: 20 * i, k, S: Ss[i], q: qs ? qs[i] : 800 })));
      const rising = [1.2, 1.3, 1.1, 4.0, 4.6], flat = [1.2, 1.3, 1.1, 1.25, 1.15];
      // stable k (CV = 1.4826·0.5/45 = 0.0165) with rising skin → near-well change
      let out = T.compute(mk([45, 46, 44, 45.5, 44.5], rising), ctxOf());
      shapeOk(assert, out);
      near(assert, out.kStability.cv, 1.4826 * 0.5 / 45, 1e-12, 'CV_k = 1.4826·MAD/median');
      assert.deepStrictEqual([out.kStability.stable, out.kStability.reading, out.kStability.allocAccPct], [true, 'nearWell', 5]);
      out = T.compute(mk([45, 46, 44, 45.5, 44.5], flat), ctxOf());
      assert.strictEqual(out.kStability.reading, 'none', 'stable k, stable skin → no change');
      // falling k with rising skin → mobility change
      out = T.compute(mk([45, 44, 40, 35, 30], rising), ctxOf());
      assert.deepStrictEqual([out.kStability.stable, out.kStability.reading, out.kStability.falling], [false, 'mobility', true]);
      // k drifting with the allocated rate, skin stable → allocation
      const qs = [800, 900, 700, 1000, 600];
      out = T.compute(mk(qs.map((q) => 45 * q / 800), flat, qs), ctxOf());
      assert.deepStrictEqual([out.kStability.stable, out.kStability.reading], [false, 'allocation']);
      // tolerance = max(5 %, allocation accuracy)
      out = T.compute(mk([45, 44, 40, 35, 30], flat), ctxOf({ well: Object.assign({}, WELL, { allocAccPct: 20 }) }));
      assert.deepStrictEqual([out.kStability.stable, out.kStability.allocAccPct], [true, 20], 'CV 0.185 ≤ 20 %');
      // k-held tests do not enter CV_k
      out = T.compute(series([{ id: 'B1', d: 0, S: 1.2, k: 45 }, { id: 'B2', d: 20, S: 1.3, k: 45 }, { id: 'B3', d: 40, S: 1.1, k: 45 }, { id: 'B4', d: 60, S: 3, k: 90, kHeld: true }]), ctxOf());
      assert.strictEqual(out.kStability.cv, 0, 'k-held k excluded');
      // stage-3 window-level inconsistency: reported from ctx and from the test flag
      out = T.compute(series([{ id: 'B1', d: 0, S: 1.2 }, { id: 'B2', d: 20, S: 1.3 }, { id: 'B3', d: 40, S: 1.1 }, { id: 'B4', d: 60, S: 1.2, wli: true }]),
                      ctxOf({ windowLevelInconsistent: ['B2'] }));
      assert.deepStrictEqual(J(out.crossTest.windowLevelInconsistent), ['B2', 'B4']);
      const an = S.FIX.analysis;
      out = T.compute(S.FIX.samples.TrendTests, fixCtx(an));
      ['cv', 'stable', 'allocAccPct', 'reading'].forEach((k) => assert.deepStrictEqual(out.kStability[k], an.trend.kStability[k], 'FIX kStability.' + k));
    },
  },

  {
    name: 'TR9 pressure trend: depletion vs none; drift wording; estimated history not assessable; the closed family (p̄)',
    wp: WP, opts: false,
    run(app, assert) {
      const T = vmTrend();
      const mk = (ps, extra) => series(ps.map((p, i) => Object.assign({ id: 'B' + (i + 1), d: 20 * i, S: 1.2 + 0.05 * (i % 2), pStar: p }, extra ? extra(i) : {})));
      // depletion: −0.5 psi/day, well beyond the 0.01 psi/day drift input
      let out = T.compute(mk([0, 20, 40, 60, 80].map((d) => 4000 - 0.5 * d)), ctxOf());
      shapeOk(assert, out);
      let p = out.pTrend;
      assert.deepStrictEqual([p.quantity, p.assessable, p.depletion], ['pStar', true, true]);
      near(assert, p.slopePer30d, -15, 1e-9, 'Theil–Sen p* slope per 30 days'); near(assert, p.scatter, 0, 1e-9, 'scatter');
      assert(/^Depletion:/.test(p.label) && !/drift/.test(p.label.replace('gauge drift alone cannot explain it', '')), 'depletion wording: ' + p.label);
      // a decline the drift input could explain
      out = T.compute(mk([0, 20, 40, 60, 80].map((d) => 4000 - 0.008 * d)), ctxOf());
      assert.strictEqual(out.pTrend.label, 'Depletion or gauge drift (the drift input could explain it).');
      // no trend
      out = T.compute(mk([4000, 4001, 3999.5, 4000.5, 3999.8]), ctxOf());
      assert.deepStrictEqual([out.pTrend.assessable, out.pTrend.depletion], [true, false]);
      assert(/No significant/.test(out.pTrend.label));
      // estimated history: not assessable, no closedWithoutDepletion even with closed-circle tests
      const closed = (i) => (i < 3 ? { chosen: 'closedCircle', pExtKind: 'pbar', pExt: 3500 } : { pExtKind: 'pbar', pExt: 3500 });
      out = T.compute(mk([4000, 4000, 4000, 4000, 4000], closed), ctxOf({ historyEstimated: true }));
      shapeOk(assert, out, 'estimated');
      p = out.pTrend;
      assert.deepStrictEqual([p.assessable, p.depletion, p.slopePer30d], [false, null, null]);
      assert(p.reason && /estimated/.test(p.reason) && /cannot be assessed/.test(p.label));
      assert.deepStrictEqual(J(out.crossTest.closedWithoutDepletion), []);
      // closed family: closed circle chosen on ≥ half of the used tests → p̄; flat p̄ → closed without depletion
      out = T.compute(mk([4000, 4000, 4000, 4000, 4000], closed), ctxOf());
      assert.strictEqual(out.pTrend.quantity, 'pbar', 'closed family');
      assert.deepStrictEqual([out.pTrend.assessable, out.pTrend.depletion], [true, false]);
      assert.deepStrictEqual(J(out.crossTest.closedWithoutDepletion), ['B1', 'B2', 'B3'], 'V18 candidates');
      assert.strictEqual(T.pFamily(mk([1, 2, 3, 4, 5], (i) => (i < 2 ? { chosen: 'closedCircle' } : {}))), 'infinite', '2 of 5 → infinite');
      assert.strictEqual(T.pFamily(mk([1, 2, 3, 4], (i) => (i < 2 ? { chosen: 'closedCircle' } : {}))), 'closed', '2 of 4 → closed');
      // fewer than 3 tests
      out = T.compute(mk([4000, 3990]), ctxOf());
      assert.deepStrictEqual([out.pTrend.assessable, out.pTrend.depletion], [false, null]);
      const an = S.FIX.analysis;
      out = T.compute(S.FIX.samples.TrendTests, fixCtx(an));
      ['quantity', 'assessable', 'depletion', 'label'].forEach((k) => assert.deepStrictEqual(out.pTrend[k], an.trend.pTrend[k], 'FIX pTrend.' + k));
      near(assert, out.pTrend.slopePer30d, an.trend.pTrend.slopePer30d, 1e-9, 'FIX p* slope');
    },
  },

  {
    name: 'TR10 model-free ΔS from TrendTest.bins at the common Δt_ref; agreement within max(0.3, S_err); FIX T11',
    wp: WP, opts: false,
    run(app, assert) {
      const T = vmTrend();
      const list = series([{ id: 'B1', d: 0, S: 1.2, q: 800 }, { id: 'B2', d: 20, S: 2.0, q: 900 }, { id: 'B3', d: 40, S: 3.5, q: 750, dtEnd: 48, iarfDt0: 10 },
                           { id: 'B4', d: 60, S: 4.0, kHeld: true, iarf: false, dtEnd: 12 }, { id: 'B5', d: 80, S: 5.0, q: 820, binS: 3.8 }]);
      let out = T.compute(list, ctxOf());
      shapeOk(assert, out);
      const mf = out.modelFree;
      assert.deepStrictEqual(J(mf.map((r) => [r.id, r.refId])), [['B2', 'B1'], ['B3', 'B1'], ['B5', 'B1']], 'reference = the first used test with IARF; k-held without IARF skipped');
      // the bins follow the IARF line, so ΔS_model-free = 1.1513·0.8686·ΔS_fitted
      near(assert, mf[0].dS, 1.1513 * 0.8686 * 0.8, 1e-9, 'B2 ΔS'); assert.strictEqual(mf[0].fittedDS, 2.0 - 1.2); assert.strictEqual(mf[0].agrees, true);
      near(assert, mf[1].dS, 1.1513 * 0.8686 * 2.3, 1e-9, 'B3 ΔS (Δt_ref = 15.5 h ≤ the shortest Δt_end 48 h)');
      // B5's bins carry S = 3.8 while its fitted S is 5.0: 1.2 apart > max(0.3, 0.3) → disagrees
      near(assert, mf[2].dS, 1.1513 * 0.8686 * 2.6, 1e-9, 'B5 ΔS from the bins'); assert.strictEqual(mf[2].agrees, false, 'model-free and fitted ΔS disagree');
      const an = S.FIX.analysis;
      out = T.compute(S.FIX.samples.TrendTests, fixCtx(an));
      assert.deepStrictEqual(J(out.modelFree), J(an.trend.modelFree), 'FIX modelFree');
    },
  },

  {
    name: 'TR11 bubble point: sandface range from the gradient ±20 %, levels, Spearman rule, off for gas and injectors, critical only when assessable',
    wp: WP, opts: false,
    run(app, assert) {
      const T = vmTrend();
      const depth = { gaugeTVD: 9000, datumTVD: 9500, grad: 0.35, gradFlow: 0.30 };
      const mk = (rows) => series(rows.map((r, i) => Object.assign({ id: 'B' + (i + 1), d: 20 * i, S: 1.2 }, r)));
      // sandface pwf = pwf0_datum + (G_flow·(1 ∓ 0.2) − G)·Δz: −55 / +5 psi; levels on the low end vs Pb 2500
      let out = T.compute(mk([{ pwf0: 2700 }, { pwf0: 2600 }, { pwf0: 2520 }]), ctxOf({ depth }));
      shapeOk(assert, out);
      const rows = out.bubble.rows;
      near(assert, rows[0].pwfSand_lo, 2645, 1e-9, 'lo'); near(assert, rows[0].pwfSand_hi, 2705, 1e-9, 'hi'); near(assert, rows[0].margin, 145, 1e-9, 'margin');
      assert.deepStrictEqual(J(rows.map((r) => r.level)), ['ok', 'minor', 'major']);
      // critical: p_ext below Pb when the pressure trend is assessable; with an estimated history at most major
      const crit = [{ pwf0: 2700 }, { pwf0: 2700 }, { pwf0: 2600, pExt: 2450 }];
      out = T.compute(mk(crit), ctxOf({ depth }));
      assert.strictEqual(out.pTrend.assessable, true); assert.strictEqual(out.bubble.rows[2].level, 'critical');
      out = T.compute(mk(crit.map((r, i) => Object.assign({}, r, i === 2 ? { pStarRange: { lo: 2300, hi: 2480 } } : {}))), ctxOf({ depth, historyEstimated: true }));
      assert.strictEqual(out.bubble.rows[2].level, 'major', 'estimated history: the p* range upper end below Pb → major, never critical');
      // Spearman ρ(S, max(0, Pb − pwf)) ≥ 0.7 over ≥ 4 tests → recommendation (rule V12)
      out = T.compute(mk([{ pwf0: 2700, S: 1.0 }, { pwf0: 2550, S: 1.5 }, { pwf0: 2450, S: 2.5 }, { pwf0: 2350, S: 3.5 }, { pwf0: 2250, S: 4.5 }]), ctxOf({ depth }));
      assert(out.bubble.spearman >= 0.7, 'Spearman ' + out.bubble.spearman);
      assert(out.recommendations.some((r) => r.code === 'bubble'), 'bubble-point recommendation');
      assert.strictEqual(T.compute(mk([{ pwf0: 2700 }, { pwf0: 2600 }, { pwf0: 2500 }]), ctxOf({ depth })).bubble.spearman, null, 'fewer than 4 tests → no Spearman');
      // no depth: the range collapses to pwf0_datum
      out = T.compute(mk([{ pwf0: 2700 }]), ctxOf());
      assert.deepStrictEqual([out.bubble.rows[0].pwfSand_lo, out.bubble.rows[0].pwfSand_hi], [2700, 2700]);
      // off for gas and injectors
      ['gas', 'water_inj'].forEach((fl) => {
        const w = Object.assign({}, WELL, { fluid: fl });
        out = T.compute(mk([{ pwf0: 2400 }, { pwf0: 2300 }, { pwf0: 2200 }, { pwf0: 2100 }]), ctxOf({ well: w, fluid: fl }));
        shapeOk(assert, out, fl);
        assert.deepStrictEqual([out.bubble.rows.length, out.bubble.spearman], [0, null], fl + ': bubble point off');
      });
      const an = S.FIX.analysis;
      out = T.compute(S.FIX.samples.TrendTests, fixCtx(an));
      assert.deepStrictEqual(J(out.bubble), J(an.trend.bubble), 'FIX bubble');
    },
  },

  {
    name: 'TR12 gas rate skin: collinear q and t → unresolved; 2.0× spread with 3 + 3 constant-skin tests → D within 10 %, D/se ≥ 2',
    wp: WP,
    run(app, assert) {
      const T = appTrend(app, assert);
      const gw = Object.assign({}, WELL, { fluid: 'gas', mu: 0.02, B: 0.8, Pb: null, gas: { sg: 0.65, T_F: 200, co2: 1, h2s: 0, n2: 1, pseudoTime: false, pdew: null, apiCond: null, Mo: null } });
      const D = 2e-4, Strue = 1.0;
      const gas = (qs, noise) => series(qs.map((q, i) => {
        const Sp = Strue + D * q + (noise ? noise[i] : 0);
        return { id: 'B' + (i + 1), d: 10 * i, q, S: Sp, gasSprime: Sp, E: 0.2, qUnit: 'Mscf/d' };
      }), gw);
      const gctx = (o) => ctxOf(Object.assign({ well: gw, fluid: 'gas', phaseBasis: { used: 'gas', wcMax: null, gorRatioMax: null, twoPhaseCt: false } }, o || {}));
      // collinear: the rate rises with time
      let out = T.compute(app.toWin(gas([4000, 5000, 6000, 7000, 8000, 9000])), app.toWin(gctx()));
      shapeOk(assert, out);
      assert.strictEqual(out.rateSkin.resolved, false, 'collinear q and t → unresolved');
      assert.deepStrictEqual([out.rateSkin.D, out.rateSkin.seD], [null, null]);
      assert(out.rateSkin.reason.length > 0 && out.rateSkin.reason.length < 300 && !BANNED.test(out.rateSkin.reason), 'reason: ' + out.rateSkin.reason);
      assert.strictEqual(out.corrected, false);
      assert(out.recommendations.some((r) => r.code === 'nonDarcy' && r.ev.indexOf('T15') !== -1), 'non-Darcy multi-rate recommendation');
      // 3 tests at 5,000 and 3 at 10,000 Mscf/d (alternating), constant skin: D resolved
      const qs = [5000, 10000, 5000, 10000, 5000, 10000];
      out = T.compute(app.toWin(gas(qs, [0.02, -0.02, 0.01, -0.01, 0, 0])), app.toWin(gctx()));
      shapeOk(assert, out, 'resolved');
      const rs = out.rateSkin;
      assert.strictEqual(rs.resolved, true, 'D resolved: ' + rs.reason);
      assert(Math.abs(rs.D / D - 1) <= 0.10, 'D within 10 %: ' + rs.D);
      assert(Math.abs(rs.D) / rs.seD >= 2, 'D/se ≥ 2');
      assert.strictEqual(out.corrected, true, 'alerts on the rate-corrected skin');
      assert.strictEqual(out.alerts.delta.status, 'none', 'constant-S gas well: no delta alert once D is resolved');
      assert.strictEqual(out.onset.model, 'constant', 'no onset from rate changes');
      near(assert, rs.dqEffect, rs.D * (10000 - 5000), 1e-9, 'D·Δq between the latest test and the baseline rate');
      assert(!out.recommendations.some((r) => r.code === 'nonDarcy'), 'no multi-rate recommendation once resolved');
      // oil wells: not assessed
      out = T.compute(app.toWin(series(baseS([1.2, 1.3, 1.1], 0.3))), app.toWin(ctxOf()));
      assert.deepStrictEqual([out.rateSkin.resolved, out.rateSkin.reason], [false, 'Oil well: rate-dependent skin is not assessed.']);
    },
  },

  {
    name: 'TR13 recommendations and limitations carry evidence ids and ≤ 600 characters; the shut-in length comes from reachFairShut_h',
    wp: WP,
    run(app, assert) {
      const T = appTrend(app, assert);
      const well = Object.assign({}, WELL, { defaulted: ['h', 'mu'], Pb: 3500 });
      const shut = [50, 52.3, 54, 52.3, 60, 51];
      const list = series([1.2, 1.3, 1.1, 4.0, 4.6, 1.0].map((s, i) => ({ id: 'B' + (i + 1), d: 20 * i, S: s, dtEnd: 24, reachFair: 40, reachFairShut: shut[i], pwf0: 3400 })), well);
      const ctx = ctxOf({ well, historyEstimated: true, phaseBasis: { used: 'total', wcMax: 0.12, gorRatioMax: 1.0, twoPhaseCt: false } });
      const out = T.compute(app.toWin(list), app.toWin(ctx));
      shapeOk(assert, out);
      const codes = out.recommendations.map((r) => r.code);
      ['stimReview', 'verifyInputs', 'bubble', 'wcGor', 'longerShutins', 'prodStart', 'workover'].forEach((c) => assert(codes.indexOf(c) !== -1, 'recommendation ' + c + ' in ' + codes.join(',')));
      out.recommendations.forEach((r) => {
        assert(Array.isArray(r.ev) && r.ev.length > 0, r.code + ' carries evidence');
        r.ev.forEach((id) => assert(EV_ANY.test(id), r.code + ' evidence id ' + id));
        assert(typeof r.text === 'string' && r.text.length <= 600 && !BANNED.test(r.text), r.code + ' text');
      });
      const ls = out.recommendations.find((r) => r.code === 'longerShutins');
      near(assert, ls.values.shut_h, median(shut), 1e-12, 'X = median reachFairShut_h');
      assert(/at least 53 h/.test(ls.text), 'text: ' + ls.text);
      assert(!/40 h/.test(ls.text), 'not the Δt_e reach');
      assert.deepStrictEqual(J(ls.ev), ['B1·W4', 'B2·W4', 'B3·W4', 'B4·W4', 'B5·W4', 'B6·W4'], 'evidence = the tests short of the reach');
      const vi = out.recommendations.find((r) => r.code === 'verifyInputs');
      assert(/h, mu/.test(vi.text), 'names the defaulted inputs');
      // limitations: fixed list plus case items, plain text ≤ 600
      const lc = out.limitations.map((l) => l.code);
      ['models', 'singlePhase', 'inputs', 'allocation', 'totalSkin', 'pss', 'partialCuts', 'storage', 'gradient', 'iarfEarliest', 'pStarEstimated'].forEach((c) => assert(lc.indexOf(c) !== -1, 'limitation ' + c));
      out.limitations.forEach((l) => assert(typeof l.text === 'string' && l.text.length > 0 && l.text.length <= 600 && !BANNED.test(l.text), l.code + ' text'));
      assert(out.pTrend.assessable === false, 'estimated history → no pressure trend');
      // a well with nothing to flag gets no recommendation and no case limitations
      const quiet = T.compute(app.toWin(series(baseS([1.2, 1.3, 1.1], 0.3).concat([{ id: 'B4', d: 60, S: 1.25 }]))), app.toWin(ctxOf()));
      assert.deepStrictEqual(J(quiet.recommendations), [], 'no recommendation');
      assert(!quiet.limitations.some((l) => ['pStarEstimated', 'trendOff', 'negSkin'].indexOf(l.code) !== -1), 'no case limitations');
    },
  },

  {
    name: 'TR14 trend auto is off in table mode and with tests < 1 day apart; on/off override; source rules (no Math.random, no timers, no page)',
    wp: WP, opts: false,
    run(app, assert) {
      const T = vmTrend();
      const rise = baseS([1.2, 1.3, 1.1], 0.3).concat([{ id: 'B4', d: 60, S: 4.0 }, { id: 'B5', d: 80, S: 4.5 }]);
      let out = T.compute(series(rise), ctxOf({ mode: 'table' }));
      shapeOk(assert, out);
      assert.strictEqual(out.enabled, false);
      assert(/Rate-table/.test(out.disabledReason) && out.disabledReason.length < 300, out.disabledReason);
      assert.deepStrictEqual([out.alerts.delta.status, out.alerts.absolute.status, out.onset.model, out.forecast.show], ['none', 'none', 'constant', false]);
      assert(out.series.every((s) => s.used.alert === false && s.used.trend === false), 'no test used for an alert');
      assert(out.limitations.some((l) => l.code === 'trendOff'));
      out = T.compute(series(rise), ctxOf({ mode: 'table', settings: trendSet({ enabled: 'on' }) }));
      assert.deepStrictEqual([out.enabled, out.alerts.delta.status], [true, 'confirmed'], "'on' overrides");
      // tests half a day apart
      const close = rise.map((r, i) => Object.assign({}, r, { d: 0.5 * i }));
      out = T.compute(series(close), ctxOf());
      assert.strictEqual(out.enabled, false);
      assert(/less than 1 day apart/.test(out.disabledReason), out.disabledReason);
      out = T.compute(series(close), ctxOf({ settings: trendSet({ enabled: 'on' }) }));
      assert.strictEqual(out.enabled, true);
      out = T.compute(series(rise), ctxOf({ settings: trendSet({ enabled: 'off' }) }));
      assert.deepStrictEqual([out.enabled, out.alerts.delta.status], [false, 'none'], "'off'");
      // no tests: a complete, well-formed Trend
      out = T.compute([], {});
      shapeOk(assert, out, 'empty');
      assert.deepStrictEqual([out.ok, out.n, out.enabled], [false, 0, false]);
      // source rules: pure engine, helper module
      const src = fs.readFileSync(FILE, 'utf8');
      assert(!/Math\.random/.test(src), 'no Math.random in the engine file');
      assert(!/\b(setTimeout|setInterval|localStorage|indexedDB|addEventListener|dispatchEvent|getElementById)\b/.test(src), 'no timers, storage, DOM or events');
      assert(/helper module: does not add a page to window\.WTS_calcRegistry/.test(src), 'helper-module header line');
      assert(!/WTS_calcRegistry\s*[.[=]/.test(src.replace(/^\s*\/\/.*$/gm, '')), 'does not register a page');
      assert.strictEqual((src.match(/\/\/ === SELF-TEST ===/g) || []).length, 1, 'exactly one self-test marker');
    },
  },

  {
    name: 'TR15 excludedLow: count, ids and S range of the tests excluded as low (T16)',
    wp: WP, opts: false,
    run(app, assert) {
      const T = vmTrend();
      const list = series([{ id: 'B1', d: 0, S: 1.2 }, { id: 'B2', d: 20, S: 3.4, ks: 'low' }, { id: 'B3', d: 40, S: 1.1 }, { id: 'B4', d: 60, S: 9.0, ks: 'low', excluded: true },
                           { id: 'B5', d: 80, S: 1.3 }, { id: 'B6', d: 100, S: 5.1, ks: 'low' }]);
      const out = T.compute(list, ctxOf());
      shapeOk(assert, out);
      assert.deepStrictEqual(J(out.excludedLow), { n: 2, ids: ['B2', 'B6'], S: [3.4, 5.1], ev: ['T16'] }, 'the override-excluded B4 is not "excluded as low"');
      assert.strictEqual(out.nUsed, 3);
      assert.deepStrictEqual(J(out.baseline.tests), ['B1', 'B3', 'B5']);
      assert.strictEqual(out.alerts.delta.status, 'possible', 'B6 (low) exceeds the delta threshold: 5.1 − 0.3 − 1.2 > 2');
      assert.deepStrictEqual(J(T.compute(series([{ id: 'B1', d: 0, S: 1 }]), ctxOf()).excludedLow), { n: 0, ids: [], S: null, ev: ['T16'] });
    },
  },

  {
    name: 'TR16 PI cross-check: J_obs from days[].pwfMean_psia vs J_pred(k_base, S(t)); unavailable with an estimated history or an injector',
    wp: WP,
    run(app, assert) {
      const T = appTrend(app, assert);
      const an = S.FIX.analysis, tts = S.FIX.samples.TrendTests, ctx = fixCtx(an);
      let out = T.compute(app.toWin(tts), app.toWin(ctx));
      shapeOk(assert, out);
      const pc = out.piCheck;
      assert.strictEqual(pc.available, true);
      assert.deepStrictEqual(J(pc.rows.map((r) => [r.from, r.to])), J(an.trend.piCheck.rows.map((r) => [r.from, r.to])), 'one row per interval between consecutive used tests');
      // independent recomputation (§4.7 T13): clean days strictly between the tests, p_ref interpolated between the used p_ext
      const used = tts.filter((t) => out.series.find((s) => s.id === t.id).used.trend);
      const kn = sKnotsOf(out, tts), X = S.FORMULAS.X(an.well.re_ft, an.well.rw), first = an.tests[0].tc_ms;
      const pKn = used.filter((t) => t.pExtDatum != null).map((t) => [t.t_ms, t.pExtDatum]);
      used.slice(1).forEach((b, i) => {
        const a = used[i], ratios = [];
        an.rates.days.forEach((d) => {
          const mid = 0.5 * (d.t0_ms + d.t1_ms);
          if (d.cls !== 'clean' || d.pwfMean_psia == null || !(mid > a.t_ms && mid < b.t_ms)) return;
          ratios.push(S.FORMULAS.jObs(d.q, lin(pKn, mid), d.pwfMean_psia) /
                      S.FORMULAS.jPred(an.baseline.k, an.well.h, an.well.B, an.well.mu, X, lin(kn, (mid - first) / DAY)));
        });
        near(assert, pc.rows[i].RJ, median(ratios), 1e-9, a.id + '→' + b.id + ' R_J');
      });
      assert.strictEqual(pc.consistent, pc.rows.every((r) => r.RJ >= 0.8 && r.RJ <= 1.25), 'consistent = every R_J in [0.8, 1.25]');
      // the datum copy is optional: without it the same rows come from pwfMean_psia
      const noDatum = J(ctx); noDatum.days.forEach((d) => { d.pwfMeanDatum_psia = null; });
      const out2 = T.compute(app.toWin(tts), app.toWin(noDatum));
      assert.deepStrictEqual(J(out2.piCheck.rows), J(pc.rows), 'pwfMean_psia read');
      // a day's pwfMean moves its interval's R_J
      const moved = J(noDatum); const day = moved.days.find((d) => d.cls === 'clean' && 0.5 * (d.t0_ms + d.t1_ms) > used[0].t_ms && 0.5 * (d.t0_ms + d.t1_ms) < used[1].t_ms);
      day.pwfMean_psia -= 200;
      const out3 = T.compute(app.toWin(tts), app.toWin(moved));
      assert(out3.piCheck.rows[0].RJ !== pc.rows[0].RJ || out3.piCheck.rows[0].nDays > 1, 'R_J responds to pwfMean_psia');
      // estimated history / injector → unavailable
      out = T.compute(app.toWin(tts), app.toWin(Object.assign({}, ctx, { historyEstimated: true })));
      shapeOk(assert, out, 'estimated');
      assert.deepStrictEqual([out.piCheck.available, out.piCheck.rows.length, out.piCheck.consistent], [false, 0, null]);
      assert(/estimated/.test(out.piCheck.reason), out.piCheck.reason);
      const inj = Object.assign({}, an.well, { fluid: 'water_inj' });
      out = T.compute(app.toWin(tts), app.toWin(Object.assign({}, ctx, { well: inj, fluid: 'water_inj' })));
      assert.deepStrictEqual([out.piCheck.available, out.piCheck.rows.length], [false, 0], 'injector: off');
    },
  },
];
