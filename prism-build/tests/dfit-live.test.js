// DFIT — WP3 live engine and replay (docs/DFIT-PLAN.md §6.9; §9 WP3).
//
//   V1  replay of a noisy reference-like falloff: the provisional call comes after closure and within 2 % of t_c of it, its
//       closure estimate is within 2 % of t_c, the confirmation comes before 1.5 t_c; no radial flow is called on the pure
//       Carter-linear after-closure signal (negative case of radialSeen)
//   V1b no event overrides: FIX.ds and the V1 data replayed with the pump start detected from the record (pressure ramp
//       between the last zero-rate and the first pumping sample) give the provisional call after t_c and the right closure
//   V1c uniformly sampled data (0.1 Hz) give no call before t_c; the timing on such data is a 3.4b calibration item
//   V8  the session is incremental: in-order samples are appended (no splice), the work counts grow linearly with the record
//       (24 h at 0.05 and 0.1 Hz) and a 24 h, 0.1 Hz replay with 10-minute blocks stays well inside the budget
//   V9  families: a stiffening hump (dP/dG rising after the F1 departure, then falling below the tangent) gives a confirmed F2
//       end-of-stiffening reading and a two-family tile (closure range); on the reference signal the families agree
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
  const sig = o.sigma == null ? 0.01 : o.sigma, rho = o.rho || 0, tEnd = o.tEnd || 24, pf = o.pf || pFall;
  let e = 0;
  const one = (dt) => { e = rho * e + sig * Math.sqrt(1 - rho * rho) * g(); t.push(REF.ts + dt); p.push(pf(dt) + e); q.push(0); };
  if (o.uniform) for (let k = 1; k * o.uniform <= tEnd; k++) one(k * o.uniform);
  else for (let dt = 1 / 3600; dt <= tEnd; dt *= 1.01) one(dt);
  return { t, p, q };
}
// a stiffening hump in G (§4.7 contact signature): the early line to G 10, dP/dG rising linearly to 1.5·m_G at G 16, then
// back to m_G (below the 1.5·m_G tangent; the departure from the early line is held): F1 (contact) at G 10 = 7,266.7 psia, F2 (end of stiffening) at G 16 = 7,016.7 psia
function pHump(dt) {
  const Gv = S.G.G(dt / REF.tp, 0.5), m = REF.mG, p10 = REF.isip - 10 * m, p16 = p10 - m * (6 + 0.5 * 6 / 2);
  if (Gv <= 10) return REF.isip - m * Gv;
  if (Gv <= 16) { const x = Gv - 10; return p10 - m * (x + 0.5 * x * x / 12); }
  return p16 - m * (Gv - 16);
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
      assert(f.closureProvisional - TC <= 0.02 * REF.dtc, 'provisional within 2 % of t_c after closure: ' + (f.closureProvisional - TC) + ' h (2 % = ' + 0.02 * REF.dtc + ' h)');
      assert(f.radialSeen === null, 'no radial flow on the Carter-linear after-closure signal: ' + f.radialSeen);
      const fam = rp.verdict.families || [];
      assert(fam.length === 2 && fam[0].family === 'F1' && fam[1].family === 'F2' && !rp.verdict.range, 'families listed, no range on the reference signal: ' + JSON.stringify(fam));
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
    name: 'V1b no event overrides: FIX.ds and the V1 data with the pump start from the record give the provisional call after t_c and the right closure',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win;
      const auto = () => { const T = S.FIX.state.tests[0]; assert(T.inputs.events.tStart === null, 'no logged pump start'); T.inputs.priors.sigmaGrad = 0.70; return T; };
      [['FIX.ds (no noise)', S.FIX.ds, 0], ['V1 data (σ 0.01)', mkDs({ seed: 2, sigma: 0.01, tEnd: 24 }), 0.01], ['V1 data (σ 0.05)', mkDs({ seed: 2, sigma: 0.05, tEnd: 24 }), 0.05]].forEach(([lab, ds, sig]) => {
        const rp = win.PRiSM_dfit_replay(ds, { test: auto(), sigma: sig, block: 40 });
        assert(rp.ok === true, lab + ': replay ok');
        near(assert, rp.events.tStart, REF.tStart, 1e-6, lab + ': pump start from the pressure ramp');
        assert(rp.events.source === 'ramp', lab + ': source ' + rp.events.source);
        const f = rp.firsts;
        assert(f.closureProvisional != null && f.closureProvisional >= TC, lab + ': provisional after t_c: ' + f.closureProvisional + ' vs ' + TC);
        near(assert, rp.closure.dt, REF.dtc, 0.02 * REF.dtc, lab + ': closure Δt_c');
        near(assert, rp.closure.p, 7000, 10, lab + ': closure pressure');
      });
      // the midpoint fallback (no usable ramp): the nuisance tp search inside the bracket keeps the call after t_c
      const ds = mkDs({ seed: 2, sigma: 0.01, tEnd: 10 }); ds.p[10] = 4500; ds.p[11] = 4500;      // no pressure rise on the first two pumping samples
      const rp = win.PRiSM_dfit_replay(ds, { test: auto(), sigma: 0.01, block: 40 });
      assert(rp.ok && rp.events.source === 'midpoint' && rp.stats && rp.stats.tpRefined === true, 'midpoint start with a refined tp: ' + JSON.stringify(rp.events) + ' ' + JSON.stringify(rp.stats && rp.stats.tp));
      assert(rp.firsts.closureProvisional == null || rp.firsts.closureProvisional >= TC, 'midpoint start: no call before t_c (' + rp.firsts.closureProvisional + ')');
    },
  },
  {
    name: 'V1c uniformly sampled data (0.1 Hz): no call before t_c (timing on such data is a 3.4b calibration item)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win;
      [1, 2, 3].forEach((seed) => {
        const rp = win.PRiSM_dfit_replay(mkDs({ seed, sigma: 0.01, tEnd: 8, uniform: 10 / 3600 }), { test: testOf(), sigma: 0.01, block: 60 });
        assert(rp.ok && rp.firsts.closureProvisional != null && rp.firsts.closureProvisional >= TC, 'seed ' + seed + ': provisional after t_c (' + rp.firsts.closureProvisional + ')');
        assert(rp.firsts.closureProvisional - TC <= 0.25 * REF.dtc, 'seed ' + seed + ': provisional within 25 % of t_c after closure');
      });
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
  {
    name: 'V8 incremental session: appends without splices, linear work counts (24 h at 0.05 and 0.1 Hz), a 24 h 0.1 Hz replay inside the budget',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win, T = testOf();
      const a = mkDs({ seed: 7, sigma: 0.01, tEnd: 24, uniform: 20 / 3600 }), b = mkDs({ seed: 7, sigma: 0.01, tEnd: 24, uniform: 10 / 3600 });
      const t0 = Date.now();
      const ra = win.PRiSM_dfit_replay(a, { test: T, sigma: 0.01, block: 30 }), rb = win.PRiSM_dfit_replay(b, { test: T, sigma: 0.01, block: 60 });   // 10-min blocks
      const ms = Date.now() - t0;
      assert(ra.ok && rb.ok, 'replays ok');
      const ca = ra.counts, cb = rb.counts, work = (c) => c.resampled + c.candidates + c.derivs + c.acaPoints + c.tpSearch;
      assert(ca.splices === 0 && cb.splices === 0 && cb.appends === b.t.length, 'in-order samples are appended: ' + JSON.stringify(cb));
      assert(cb.rebuilds === 1 && cb.eventScans <= 5, 'one build of the derived state, few event scans: ' + cb.rebuilds + ' / ' + cb.eventScans);
      const nr = b.t.length / a.t.length, wr = work(cb) / work(ca);
      assert(wr < 1.3 * nr, 'work grows linearly: ×' + wr.toFixed(2) + ' for ×' + nr.toFixed(2) + ' samples');
      assert(cb.acaDiag <= 250 && cb.acaPoints <= 250 * 600, 'after-closure diagnosis on the decimated series: ' + cb.acaDiag + ' calls, ' + cb.acaPoints + ' points');
      assert(cb.candidates < 1000, 'candidate evaluations are not repeated across runs: ' + cb.candidates);
      assert(ms < 1500, 'two 24 h replays (' + (a.t.length + b.t.length) + ' samples) in ' + ms + ' ms');
      assert(rb.firsts.closureProvisional >= TC, 'and the call is still after t_c');
    },
  },
  {
    name: 'V9 families: a stiffening hump gives a confirmed F2 reading and a two-family tile; on the reference signal the families agree',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const win = app0(ctx).win;
      const rp = win.PRiSM_dfit_replay(mkDs({ seed: 3, sigma: 0.01, tEnd: 24, pf: pHump }), { test: testOf(), sigma: 0.01, block: 40 });
      assert(rp.ok, 'replay ok');
      near(assert, rp.closure.p, 7266.7, 15, 'F1 contact reading at the start of the hump');
      assert(rp.f2 && rp.f2.state === 'confirmed', 'F2 confirmed: ' + JSON.stringify(rp.f2));
      // the end of stiffening is read from the windowed dP/dG (L = 0.1 in ln G): between G 16·e^(−L) (7,089.6 psia) and G 16 (7,016.7)
      assert(rp.f2.p >= 7016.7 - 10 && rp.f2.p <= 7089.6 + 10 && rp.f2.G >= 16 * Math.exp(-0.1) - 0.3 && rp.f2.G <= 16.3, 'F2 end-of-stiffening reading within one window of G 16: ' + rp.f2.p + ' psia at G ' + rp.f2.G);
      const v = rp.verdict, fam = v.families || [];
      assert(v.range && v.range.lo < v.range.hi && Math.abs(v.range.hi - rp.closure.p) < 1e-9, 'two-family range: ' + JSON.stringify(v.range));
      assert(fam[0].family === 'F1' && fam[0].state === 'confirmed' && fam[1].family === 'F2' && fam[1].state === 'confirmed' && fam[1].sameAsF1 === false, 'both families confirmed: ' + JSON.stringify(fam));
      assert(/family F1\) confirmed/.test(v.text) && /family F2\) confirmed/.test(v.text) && /closure range/.test(v.text), 'the tile names both: ' + v.text);
      assert(S.checkShape('LiveVerdict', v).ok, 'LiveVerdict shape');
      // the reference signal: the after-closure rise of dP/dG starts at the F1 departure, so the readings coincide
      const r0 = win.PRiSM_dfit_replay(mkDs({ seed: 2, sigma: 0.01, tEnd: 24 }), { test: testOf(), sigma: 0.01, block: 40 });
      const f0 = r0.verdict.families || [];
      assert(f0[1] && f0[1].sameAsF1 === true && f0[1].p === f0[0].p && !r0.verdict.range, 'reference: F2 = F1, single reading: ' + JSON.stringify(f0));
    },
  },
];
