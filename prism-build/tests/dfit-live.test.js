// DFIT — WP3 live engine and replay (docs/DFIT-PLAN.md §6.9; §9 WP3).
//
//   V1  replay of a noisy reference-like falloff: the provisional call comes after closure with its closure estimate within
//       2 % of t_c, and the confirmation comes before 1.5 t_c
//   V2  the forecast band before closure brackets the true t_c
//   V3  out-of-order and duplicate samples give the same session state
//   V4  psig samples are converted with the test's atmospheric pressure
//   V7  AR(1) noise with ρ1 0.9: the decimated residuals have lag-1 autocorrelation < 0.3, the prewhitened ones < 0.1, and
//       5 seeds give no provisional call before t_c
//
// The data are built inline from the frozen §4.21 closed form (FIX.ref.pFall: the G-line falloff to closure, then the exact
// Carter linear decline) plus seeded noise. The plan names PRiSM_dfit_vcModel (56, WP2) as the source; it is not merged yet,
// and the closed form is the same reference signature.
'use strict';

const S = require('./_dfit-shapes');

const WP = 'DF3';
const near = (assert, a, b, tol, what) => assert(typeof a === 'number' && isFinite(a) && Math.abs(a - b) <= tol, what + ': ' + a + ' vs ' + b + ' (± ' + tol + ')');
function app0(ctx) { const a = S.sharedApp(ctx); S.resetDfit(a); return a; }
const REF = S.FIX.ref.REF, pFall = S.FIX.ref.pFall;
const TC = REF.ts + REF.dtc;                                  // closure on the record clock (h)
function testOf() {
  const T = S.FIX.state.tests[0];
  T.inputs.priors.sigmaGrad = 0.70; T.inputs.priors.sigmaGradSd = 0.02;
  T.inputs.events.tStart = REF.tStart;          // the logged pump start (the rate record steps between samples); shut-in is detected
  return T;
}
// pumping record of FIX.ds, then a falloff log-spaced at 1 % in Δt from 1 s to tEnd, p from the closed form + noise
function mkDs(o) {
  o = o || {};
  const ds = S.FIX.ds, t = [], p = [], q = [];
  for (let i = 0; i < 130; i++) { t.push(ds.t[i]); p.push(ds.p[i]); q.push(ds.q[i]); }
  const r = S.rng(o.seed || 1), g = () => { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
  const sig = o.sigma == null ? 0.01 : o.sigma, rho = o.rho || 0, tEnd = o.tEnd || 24;
  let e = 0;
  for (let dt = 1 / 3600; dt <= tEnd; dt *= 1.01) {
    e = rho * e + sig * Math.sqrt(1 - rho * rho) * g();
    t.push(REF.ts + dt); p.push(pFall(dt) + e); q.push(0);
  }
  return { t, p, q };
}
function feed(win, ds, ctx, block) {
  const ses = win.PRiSM_dfit_live.create(ctx);
  for (let i = 0; i < ds.t.length; i += block) {
    ses.push(ds.t.slice(i, i + block).map((t, k) => ({ t, p: ds.p[i + k], q: ds.q[i + k] / 1440 })));
    ses.run();
  }
  return ses;
}

module.exports = [
  {
    name: 'V1 replay of a noisy reference-like falloff: provisional after closure (estimate within 2 % of t_c), confirmed before 1.5 t_c',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win, ds = mkDs({ seed: 2, sigma: 0.01, tEnd: 24 });
      const rp = win.PRiSM_dfit_replay(ds, { test: testOf(), sigma: 0.01, block: 40 });
      assert(rp.ok === true, 'replay ok: ' + JSON.stringify(rp.errors || ''));
      const f = rp.firsts;
      assert(f.closureProvisional != null && f.closureProvisional >= TC, 'provisional only after closure: ' + f.closureProvisional + ' vs t_c ' + TC);
      near(assert, rp.closure.dt, REF.dtc, 0.02 * REF.dtc, 'closure estimate Δt_c');
      near(assert, rp.closure.p, 7000, 10, 'closure pressure');
      assert(f.closureConfirmed != null && f.closureConfirmed - REF.ts < 1.5 * REF.dtc, 'confirmed before 1.5 t_c: ' + (f.closureConfirmed - REF.ts) + ' h');
      const states = rp.timeline.map((v) => v.state);
      assert(states.indexOf('continue') < states.indexOf('provisional') && states.indexOf('provisional') < states.indexOf('confirmed'), 'state sequence ' + states.join(' → '));
      rp.timeline.forEach((v, i) => assert(S.checkShape('LiveVerdict', v).ok, 'timeline[' + i + '] LiveVerdict: ' + JSON.stringify(S.checkShape('LiveVerdict', v).errors.slice(0, 3))));
      const j = win.PRiSM_dfit_replayJob(ds, { test: testOf(), sigma: 0.01, block: 40 }); let k = 0; while (!j.step().done && k++ < 1e4);
      assert.deepStrictEqual(j.result().firsts, f, 'replay job = sync');
      // after confirmation the session carries the p_i bracket; the reference falloff reaches only ± 185 psi by 24 h
      const v = rp.verdict;
      assert(v.state === 'confirmed' && v.pi && v.pi.lo <= 4500 && 4500 <= v.pi.hi, 'p_i bracket contains 4,500 at 24 h: ' + JSON.stringify(v.pi));
      assert(f.piW25 === null && v.piHalfWidth > 25, 'not yet ± 25 psi at 24 h (half-width ' + v.piHalfWidth + ')');
    },
  },
  {
    name: 'V2 the forecast band before closure brackets the true t_c',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win, ds = mkDs({ seed: 3, sigma: 0.01, tEnd: 1.5 });
      const ses = feed(win, ds, { test: testOf(), sigma: 0.01 }, 200), v = ses.verdict();
      assert(v.state === 'continue' && v.forecast, 'continue with a forecast: ' + JSON.stringify(v));
      assert(v.forecast.lo <= REF.dtc && REF.dtc <= v.forecast.hi, 'band [' + v.forecast.lo + ', ' + v.forecast.hi + '] h brackets Δt_c ' + REF.dtc);
      near(assert, v.forecast.lo, 2.46, 0.1, 'σ 7,200 → 2.46 h'); near(assert, v.forecast.hi, 8.63, 0.3, 'σ 6,800 → 8.63 h');
      assert(/closure expected/.test(v.text) && S.checkShape('LiveVerdict', v).ok, 'verdict text and shape');
    },
  },
  {
    name: 'V3 out-of-order and duplicate samples give the same session state',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win, ds = mkDs({ seed: 4, sigma: 0.01, tEnd: 10 });
      const rows = ds.t.map((t, i) => ({ t, p: ds.p[i], q: ds.q[i] / 1440 }));
      const a = win.PRiSM_dfit_live.create({ test: testOf(), sigma: 0.01 }); a.push(rows); a.run();
      const r = S.rng(9), sh = rows.slice(); for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const x = sh[i]; sh[i] = sh[j]; sh[j] = x; }
      const b = win.PRiSM_dfit_live.create({ test: testOf(), sigma: 0.01 });
      const half = Math.floor(sh.length / 2);
      b.push(sh.slice(0, half)); b.push(sh.slice(half)); const dup = b.push(rows.slice(100, 400)); b.run();
      assert(dup.added === 0 && dup.changed === false, 'duplicates are not added');
      assert(b.size() === a.size(), 'same sample count ' + b.size());
      assert.deepStrictEqual(b.verdict(), a.verdict(), 'same verdict');
      assert.deepStrictEqual(b.closure(), a.closure(), 'same closure');
    },
  },
  {
    name: 'V4 psig samples are converted with the test atmospheric pressure',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win, ds = mkDs({ seed: 5, sigma: 0.01, tEnd: 10 }), T = testOf();
      const a = feed(win, ds, { test: T, sigma: 0.01 }, 300);
      const b = win.PRiSM_dfit_live.create({ test: T, sigma: 0.01 });
      b.push(ds.t.map((t, i) => ({ t, p: ds.p[i] - 14.696, q: ds.q[i] / 1440, unit: 'psig' }))); b.run();
      near(assert, b.verdict().p, a.verdict().p, 1e-6, 'psig → psia'); assert(b.verdict().state === a.verdict().state, 'same state');
      const T2 = testOf(); T2.inputs.channels.atmPsia = 12.2;
      const c = win.PRiSM_dfit_live.create({ test: T2, sigma: 0.01, psig: true });
      c.push(ds.t.map((t, i) => ({ t, p: ds.p[i] - 12.2, q: ds.q[i] / 1440 }))); c.run();
      near(assert, c.verdict().p, a.verdict().p, 1e-6, 'session-wide psig with atmPsia 12.2');
    },
  },
  {
    name: 'V7 AR(1) noise (ρ1 0.9): decimated lag-1 < 0.3, prewhitened < 0.1, and 5 seeds give no provisional call before t_c',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win;
      [1, 2, 3, 4, 5].forEach((seed) => {
        const ds = mkDs({ seed, sigma: 0.05, rho: 0.9, tEnd: 8 });
        const rp = win.PRiSM_dfit_replay(ds, { test: testOf(), sigma: 0.05, block: 60 });
        assert(rp.ok, 'replay ok');
        assert(rp.firsts.closureProvisional == null || rp.firsts.closureProvisional >= TC, 'seed ' + seed + ': no provisional call before t_c (' + rp.firsts.closureProvisional + ')');
      });
      const ds = mkDs({ seed: 6, sigma: 0.05, rho: 0.9, tEnd: 4 });
      const ses = feed(win, ds, { test: testOf(), sigma: 0.05 }, 2000), st = ses.stats();
      assert(st && st.rho1 > 0.6, 'the lag-1 coefficient is estimated: ' + (st && st.rho1));
      assert(Math.abs(st.decLag1) < 0.3, 'decimated lag-1 ' + st.decLag1);
      assert(Math.abs(st.whiteLag1) < 0.1, 'prewhitened lag-1 ' + st.whiteLag1);
    },
  },
];
