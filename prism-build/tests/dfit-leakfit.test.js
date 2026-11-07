// DFIT — WP4 history match, identifiability and "what this test can tell you" (docs/DFIT-PLAN.md §5.7, §6.7, §9 WP4).
// Pure engine, one shared app per file (opts:false). Synthetic records: the §5.4 base case with reservoir-controlled
// leak-off (k 3.308e-3 md = CL 1.863e-4 ft/√min at σ_c − p_r = 2,500 psi), asperity contact (hyp, s_h 60 psi), spurt
// 1 gal/100 ft², 250 log-spaced points to 100 h, σ_p 0.5 psi (seeded mulberry32, seed 1), generated on the display grid.
//
//   LF1  run A {k, σ_c, p_r} from ×1.5 / +150 / −200 psi: truth inside the 95 % CI in ≤ 40 runs; Job = sync; the optional
//        derivative residuals on ln(G·dP/dG) (weight 0.2); the on-demand σ_c profile in identify (10 refits) agrees with the
//        linearised interval; lkProfileJob = lkProfile
//   LF2  Γ_PKN conserved: 14.904 to 1e-3 (relative) for the wall-only truth (runs B_w {C_w, σ_c, E′, h_f} and G_w
//        {C_w, σ_c, K_Ic, E′}) and, reservoir-controlled, run B {k, σ_c, p_r, E′, h_f} equal to run A to 1e-3
//   LF3  run J (h_f wrong at 40 ft, E′ fixed): rmse ≈ 19.6 psi, σ_c bias ≈ −78 psi, the geometry warning fires
//   LF4  run B_w: the group sentence with Γ in psi/√min and Γ_PKN = 14.904 ± 1e-3; E′ and h_f "determined only as a group"
//   LF5  the extension table: σ(p_i) ±7.9 / 2.8 / 1.5 / 0.9 / 0.56 / 0.39 psi at 1.5 / 2 / 3 / 5 / 10 / 20 t_c (± 10 %)
//   LF6  the next-best-information ranking puts "longer shut-in" first for run F (data to 1.5 t_c)
//   LF7  n_eff inflation ≈ × 4.4 for AR(1) residuals with ρ1 0.9; the fit's inflated intervals use it
//   LF8  with log k as the parameter, moving σ_c or p_r by ± 200 psi leaves κ_k (the k column of the parameter map)
//        unchanged to 1e-6 and the reported CL equivalent follows Δp_CL
'use strict';

const fs = require('fs');
const path = require('path');
const S = require('./_dfit-shapes');

const WP = 'DF4';
const SRC56 = '56-prism-dfit-core.js';
const G_STUB = [
  '(function () {',
  "    'use strict';",
  "    var G = (typeof window !== 'undefined') ? window : globalThis;",
  '    function g(d, a) { return a === 1 ? (4 / 3) * (Math.pow(1 + d, 1.5) - Math.pow(d, 1.5)) : (1 + d) * Math.asin(1 / Math.sqrt(1 + d)) + Math.sqrt(d); }',
  '    function Gf(d, a) { a = (a === 1) ? 1 : 0.5; return (4 / Math.PI) * (g(d, a) - g(0, a)); }',
  '    function Ginv(v, a) { var lo = 1e-12, hi = 1e9; for (var i = 0; i < 200; i++) { var m = Math.sqrt(lo * hi); if (Gf(m, a) < v) lo = m; else hi = m; } return Math.sqrt(lo * hi); }',
  "    if (!G.PRiSM_dfit_G || G.PRiSM_dfit_G._dfitStub) { G.PRiSM_dfit_g = function (d, a) { return g(d, a === 1 ? 1 : 0.5); }; G.PRiSM_dfit_G = Gf; G.PRiSM_dfit_Ginv = Ginv; G._dfitGStubbedForWP4 = true; }",
  '})();',
  '',
].join('\n');
function src56WithGStub() {
  const src = fs.readFileSync(path.join(__dirname, '..', SRC56), 'utf8');
  const i = src.lastIndexOf('// === SELF-TEST ===');
  return src.slice(0, i) + G_STUB + src.slice(i);
}
const OPTS = { sourceOverrides: { [SRC56]: src56WithGStub() } };
let CACHE = { app: null };
function app(ctx) {
  const a = S.sharedApp(ctx, OPTS); S.resetDfit(a);
  if (CACHE.app !== a) CACHE = { app: a };
  return a.win;
}

const TP = 5 / 60, K_TRUE = 3.3082e-3, CW_TRUE = 1.863e-4;
const clone = (o) => JSON.parse(JSON.stringify(o));
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function gauss(r) { return () => { const u = r() || 1e-12, v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }; }
function truth(W, o) {
  const c = W.PRiSM_dfit_lkDefaults();
  Object.assign(c, { Cw: 0, k: K_TRUE, Sp: 1, aperture: { law: 'hyp', sh: 60, sc: 100, fres: 0.1, sr: null } }, o || {});
  return c;
}
function makeData(W, cfg, tEndData, n, noise, seed, rho) {
  const c = clone(cfg); c.tEnd = TP + tEndData * 1.0001;
  const r = W.PRiSM_dfit_lkSimulate(c, { grid: 'display' }), t = [];
  for (let k = 0; k < n; k++) t.push(TP + Math.exp(Math.log(10 / 3600) + (Math.log(tEndData) - Math.log(10 / 3600)) * k / (n - 1)));
  const p = W.PRiSM_dfit_lkSample(r, t), g = gauss(mulberry(seed || 1));
  let prev = 0;
  return { t, p: p.map((v) => { const e = g(); prev = rho ? rho * prev + Math.sqrt(1 - rho * rho) * e : e; return v + noise * prev; }), tc: r.events.tcMech - r.events.ts };
}
function cached(key, fn) { if (!(key in CACHE)) CACHE[key] = fn(); return CACHE[key]; }
const dataA = (W) => cached('dataA', () => makeData(W, truth(W), 100, 250, 0.5, 1));
const dataW = (W) => cached('dataW', () => makeData(W, truth(W, { Cw: CW_TRUE, k: null }), 100, 250, 0.5, 1));
function startA(W, o) { return Object.assign(truth(W), { k: K_TRUE * 1.5, sigmaC: 7150, pr: 4300 }, o || {}); }
function startW(W, o) { return Object.assign(truth(W, { Cw: CW_TRUE, k: null }), { Cw: 2.8e-4, sigmaC: 7150, Ep: 7e6 }, o || {}); }
const fitA = (W) => cached('fitA', () => W.PRiSM_dfit_lkFit(dataA(W), startA(W), 'full', { free: ['k', 'sigmaC', 'pr'] }));
const fitBw = (W) => cached('fitBw', () => W.PRiSM_dfit_lkFit(dataW(W), startW(W, { hf: 40 }), 'full', { free: ['Cw', 'sigmaC', 'Ep', 'hf'] }));
const fitF = (W) => cached('fitF', () => {
  const d = makeData(W, truth(W), 1.5 * dataA(W).tc, 150, 0.5, 1);
  return W.PRiSM_dfit_lkFit(d, startA(W, { aperture: { law: 'hyp', sh: 100, sc: 100, fres: 0.1, sr: null } }), 'full', { free: ['k', 'sigmaC', 'pr', 'sh'] });
});
function okFit(assert, f, what) {
  assert.strictEqual(f.ok, true, what + ' ok: ' + JSON.stringify(f).slice(0, 200));
  const sh = S.checkShape('LkFit', f); assert(sh.ok, what + ' LkFit shape: ' + sh.errors.slice(0, 4).join('; '));
}
const inside = (ci, v) => ci && ci[0] <= v && v <= ci[1];
const rel = (a, b) => Math.abs(a - b) / Math.abs(b);

module.exports = [
  {
    name: 'DFIT LF1: run A {k, σ_c, p_r} — truth inside the 95 % CI in ≤ 40 runs from one start; Job stepped = sync result', wp: WP, opts: false,
    run(_a, assert, ctx) {
      const W = app(ctx), f = fitA(W);
      okFit(assert, f, 'run A');
      assert(f.runs <= 40, 'runs ' + f.runs);
      assert(inside(f.ci95.k, K_TRUE), 'k ' + JSON.stringify(f.ci95.k)); assert(inside(f.ci95.sigmaC, 7000), 'σ_c ' + JSON.stringify(f.ci95.sigmaC)); assert(inside(f.ci95.pr, 4500), 'p_r ' + JSON.stringify(f.ci95.pr));
      assert.strictEqual(f.stopReason, 'converged', 'converged'); assert(f.rmse < 0.6, 'rmse ' + f.rmse);
      assert(f.starts.n === 1 && f.starts.converged === 1, 'one start');
      const job = W.PRiSM_dfit_lkFitJob(dataA(W), startA(W), 'full', { free: ['k', 'sigmaC', 'pr'] });
      assert(S.checkShape('Job', job).ok, 'Job shape');
      let s, n = 0, lastP = -1;
      do { s = job.step(); n++; assert(s.progress >= lastP - 1e-12 && s.progress <= 1, 'progress monotone'); lastP = s.progress; assert(typeof s.label === 'string', 'label'); } while (!s.done && n < 500);
      const jr = job.result();
      assert.strictEqual(jr.ok, true, 'job ok'); assert(n > 2, 'one LM iteration per step (' + n + ' steps)');
      assert.deepStrictEqual(jr.params, f.params, 'job = sync parameters'); assert.strictEqual(jr.runs, f.runs, 'job = sync runs');
      const jc = W.PRiSM_dfit_lkFitJob(dataA(W), startA(W), 'full', { free: ['k', 'sigmaC', 'pr'] }); jc.step(); jc.cancel();
      const cs = jc.step(); assert(cs.done && jc.result().code === 'CANCELLED', 'cancel');
      const bad = W.PRiSM_dfit_lkFit({ t: [1], p: [1, 2] }, startA(W), 'full');
      assert(bad.ok === false && S.checkShape('Failure', bad).ok, 'bad data → failure form');
      // optional derivative residuals on ln(G·dP/dG) (weight 0.2, same Bourdet engine and L on data and model)
      const fd = W.PRiSM_dfit_lkFit(dataA(W), startA(W), 'full', { free: ['k', 'sigmaC', 'pr'], deriv: true });
      okFit(assert, fd, 'run A with derivative residuals');
      assert(fd.deriv && fd.deriv.weight === 0.2 && fd.deriv.L === 0.1 && fd.deriv.n > 150, 'derivative residuals used: ' + JSON.stringify(fd.deriv));
      assert(f.deriv === null, 'off by default');
      assert(inside(fd.ci95.sigmaC, 7000) && inside(fd.ci95.pr, 4500) && rel(fd.params.k, K_TRUE) < 0.01, 'truth recovered with derivative residuals');
      assert(fd.S > fd.Sd && Math.abs(f.S - f.Sd) < 1e-9, 'derivative pseudo-residuals enter the objective only');
      assert(rel(fd.rmse, f.rmse) < 0.05, 'pressure rmse unchanged (' + fd.rmse.toFixed(3) + ' vs ' + f.rmse.toFixed(3) + ')');
      // profile likelihood (on demand): the 1-D σ_c profile in identify checks the linearised interval; Job = sync
      const id = W.PRiSM_dfit_identify(f, { extendTimesH: [24], profile: true }), pf = id.profile;
      assert(pf && pf.ok === true && pf.key === 'sigmaC' && pf.refits === 10, 'σ_c profile of 10 refits');
      assert(pf.values.length === 11 && pf.dchi2.every((v, i) => v >= -1e-6 && (i === 0 || pf.values[i] > pf.values[i - 1])), 'profile values sorted, Δχ² ≥ 0');
      const hwP = (pf.ci95[1] - pf.ci95[0]) / 2, hwL = (f.ci95.sigmaC[1] - f.ci95.sigmaC[0]) / 2;
      assert(rel(hwP, hwL) < 0.1 && pf.agree === true && /linearised interval holds/.test(pf.text) && pf.text.length < 300, 'profile ±' + hwP.toFixed(4) + ' vs linear ±' + hwL.toFixed(4));
      const pj = W.PRiSM_dfit_lkProfileJob(f, 'pr', { n: 4 }); assert(S.checkShape('Job', pj).ok, 'profile Job shape');
      let ps, pn = 0; do { ps = pj.step(); pn++; } while (!ps.done && pn < 50);
      assert(pn >= 4, 'one refit per step');
      assert.deepStrictEqual(pj.result(), W.PRiSM_dfit_lkProfile(f, 'pr', { n: 4 }), 'profile Job = sync');
      assert(inside(pj.result().ci95, 4500), 'p_r profile interval holds the truth');
      assert(W.PRiSM_dfit_lkProfile(f, 'Ep').code === 'NOT_FREE', 'only a free parameter can be profiled');
    },
  },
  {
    name: 'DFIT LF2: Γ_PKN conserved — 14.904 to 1e-3 for the wall-only truth (B_w, G_w); run B (reservoir) equals run A to 1e-3', wp: WP, opts: false,
    run(_a, assert, ctx) {
      const W = app(ctx), b = fitBw(W);
      okFit(assert, b, 'run B_w');
      const g = W.PRiSM_dfit_lkFit(dataW(W), startW(W), 'full', { free: ['Cw', 'sigmaC', 'KIc', 'Ep'] });
      okFit(assert, g, 'run G_w');
      assert(rel(b.groups.GammaPKN, 14.904) <= 1e-3, 'B_w Γ_PKN ' + b.groups.GammaPKN);
      assert(rel(g.groups.GammaPKN, 14.904) <= 1e-3, 'G_w Γ_PKN ' + g.groups.GammaPKN);
      assert(rel(b.params.Ep, 5e6) > rel(b.groups.GammaPKN, 14.904) * 5, 'E′ itself moves more than the group');
      const a = fitA(W), rb = W.PRiSM_dfit_lkFit(dataA(W), startA(W, { Ep: 7e6, hf: 40 }), 'full', { free: ['k', 'sigmaC', 'pr', 'Ep', 'hf'] });
      okFit(assert, rb, 'run B');
      assert(rel(rb.groups.GammaPKN, a.groups.GammaPKN) <= 1e-3, 'run B vs run A Γ_PKN ' + rb.groups.GammaPKN + ' / ' + a.groups.GammaPKN);
      assert(rel(rb.groups.Gamma, a.groups.Gamma) <= 1e-3, 'Γ');
      assert(b.warnings.some((w) => w.code === 'GROUP_FREE'), 'E′ and h_f both free is flagged');
      // a MAP prior on h_f (log-derived height ± 2 %) pins the group member and keeps Γ_PKN
      const bp = W.PRiSM_dfit_lkFit(dataW(W), startW(W, { hf: 40 }), 'full', { free: ['Cw', 'sigmaC', 'Ep', 'hf'], priors: { hf: { value: 50, sdLn: 0.02 } } });
      okFit(assert, bp, 'run B_w with a height prior');
      assert(rel(bp.params.hf, 50) <= 0.03 && rel(bp.params.Ep, 5e6) <= 0.06, 'prior pins h_f (' + bp.params.hf.toFixed(2) + ') and E′ (' + bp.params.Ep.toPrecision(4) + ')');
      assert(rel(bp.groups.GammaPKN, 14.904) <= 1e-3 && bp.priors.length === 1, 'Γ_PKN with the prior');
    },
  },
  {
    name: 'DFIT LF3: run J (h_f wrong at 40 ft, E′ fixed) — rmse ≈ 19.6 psi, σ_c bias ≈ −78 psi, geometry warning', wp: WP, opts: false,
    run(_a, assert, ctx) {
      const W = app(ctx), f = W.PRiSM_dfit_lkFit(dataA(W), startA(W, { hf: 40 }), 'full', { free: ['k', 'sigmaC', 'pr'] });
      okFit(assert, f, 'run J');
      assert(rel(f.rmse, 19.6) <= 0.05, 'rmse ' + f.rmse);
      assert.near(f.params.sigmaC - 7000, -78, 6, 'σ_c bias');
      const w = f.warnings.find((x) => x.code === 'FIT_MISFIT');
      assert(w && /E′|height|h_f/.test(w.text) && w.text.length < 300, 'geometry warning');
      assert(f.inflation > 3, 'strongly correlated residuals inflate the intervals (× ' + f.inflation.toFixed(1) + ')');
    },
  },
  {
    name: 'DFIT LF4: run B_w — group sentence with Γ in psi/√min, Γ_PKN = 14.904 ± 1e-3; E′ and h_f determined only as a group', wp: WP, opts: false,
    run(_a, assert, ctx) {
      const W = app(ctx), b = fitBw(W), id = W.PRiSM_dfit_identify(b, { extendTimesH: [24, 72] });
      assert.strictEqual(id.ok, true, 'identify ok');
      const sh = S.checkShape('Identify', id); assert(sh.ok, 'Identify shape: ' + sh.errors.slice(0, 4).join('; '));
      assert(/E′ and fracture height cannot be separated/.test(id.sloppyText), 'sloppy sentence: ' + id.sloppyText);
      assert(/Γ = [0-9.]+ psi\/√min/.test(id.sloppyText), 'Γ quoted in psi/√min');
      const m = /r_p·CL·E′\/h_f = ([0-9.]+)/.exec(id.sloppyText); assert(m && Math.abs(+m[1] - 14.9) < 0.051, 'Γ_PKN in the sentence');
      assert(rel(b.groups.GammaPKN, 14.904) <= 1e-3, 'Γ_PKN ' + b.groups.GammaPKN);
      const st = {}; id.rows.forEach((r) => { st[r.param] = r.status; });
      assert.strictEqual(st.Ep, 'group', 'E′ row'); assert.strictEqual(st.hf, 'group', 'h_f row'); assert.strictEqual(st.sigmaC, 'determined', 'σ_c row');
      assert(id.rows.every((r) => r.text.length < 300 && !/null|undefined|NaN|Infinity/.test(r.text)), 'plain row text');
      assert(b.sloppy.length >= 1 && Math.abs(b.sloppy[0].vec.Ep) > 0.3, 'sloppy vector loads on E′');
    },
  },
  {
    name: 'DFIT LF5: extension table — σ(p_i) ±7.9 / 2.8 / 1.5 / 0.9 / 0.56 / 0.39 psi at 1.5 / 2 / 3 / 5 / 10 / 20 t_c (± 10 %)', wp: WP, opts: false,
    run(_a, assert, ctx) {
      const W = app(ctx), tr = truth(W), tc = 4.75, want = [7.9, 2.8, 1.5, 0.9, 0.56, 0.39], mult = [1.5, 2, 3, 5, 10, 20];
      // the design study of §6.5: free {k, σ_c, p_r, s_h, C_w}, σ 0.5 psi, 250 log-spaced points from 10 s
      mult.forEach((m, i) => {
        const f = W.PRiSM_dfit_lkFisher(tr, { tEnd: TP + m * tc, sigma: 0.5, nPts: 250, free: ['k', 'sigmaC', 'pr', 'sh', 'Cw'] });
        assert.strictEqual(f.ok, true, 'Fisher ok at ' + m + ' t_c');
        assert(rel(1.96 * f.sd.pr, want[i]) <= 0.10, 'σ(p_i) at ' + m + ' t_c: ±' + (1.96 * f.sd.pr).toFixed(3) + ' vs ±' + want[i]);
      });
      // identify builds its extension table with the same Fisher (on the match's free set), inflated by √(n/n_eff)
      const F = fitF(W), id = W.PRiSM_dfit_identify(F, { extendTimesH: mult.map((m) => m * tc) });
      assert.strictEqual(id.ok, true, 'identify ok');
      for (let i = 1; i < id.extend.length; i++) assert(id.extend[i].sdPi < id.extend[i - 1].sdPi, 'σ(p_i) falls with the shut-in');
      const f1 = W.PRiSM_dfit_lkFisher(F.cfg, { tEnd: TP + 3 * tc, sigma: F.sigmaP, nPts: F.design.t.length, free: F.free });
      assert(rel(id.extend[2].sdPi, f1.sd.pr * F.inflation) <= 1e-9, 'table = Fisher × inflation');
      assert(id.extend.every((r) => r.kRange && r.kRange[0] < F.params.k && r.kRange[1] > F.params.k), 'k range brackets the fit');
      assert(typeof id.keepText === 'string' && id.keepText.length < 300, 'keep-or-pull sentence');
    },
  },
  {
    name: 'DFIT LF6: run F (data to 1.5 t_c) — p_r ± 9 psi and "longer shut-in" ranked first', wp: WP, opts: false,
    run(_a, assert, ctx) {
      const W = app(ctx), F = fitF(W);
      okFit(assert, F, 'run F');
      const hw = (F.ci95.pr[1] - F.ci95.pr[0]) / 2; assert(hw > 5 && hw < 14, 'p_r half-width ' + hw.toFixed(2) + ' (≈ ± 9 psi)');
      const id = W.PRiSM_dfit_identify(F, { extendTimesH: [12, 48] });
      assert.strictEqual(id.ok, true, 'identify ok');
      assert.strictEqual(id.voi[0].source, 'longer shut-in', 'ranking: ' + id.voi.map((v) => v.source + ' ' + v.reduction.toFixed(2)).join(', '));
      for (let i = 1; i < id.voi.length; i++) assert(id.voi[i].reduction <= id.voi[i - 1].reduction, 'sorted');
      assert(id.voi.some((v) => v.source === 'gauge with half the noise' && Math.abs(v.reduction - 0.75) < 0.01), 'a gauge with half the noise cuts every variance by 4');
    },
  },
  {
    name: 'DFIT LF7: n_eff — AR(1) residuals with ρ1 0.9 inflate the intervals ≈ × 4.4; the fit uses √(n/n_eff)', wp: WP, opts: false,
    run(_a, assert, ctx) {
      const W = app(ctx), H = W._PRiSM_dfit_lk, g = gauss(mulberry(7)), e = [];
      let prev = 0; for (let i = 0; i < 4000; i++) { prev = 0.9 * prev + Math.sqrt(1 - 0.81) * g(); e.push(prev); }
      const r = H.neff(e);
      assert.near(r.rho1, 0.9, 0.02, 'ρ1'); assert(rel(r.inflation, Math.sqrt(19)) <= 0.10, 'inflation ' + r.inflation.toFixed(2) + ' ≈ 4.4');
      const w = []; for (let i = 0; i < 400; i++) w.push(g()); assert(H.neff(w).inflation < 1.15, 'white residuals ≈ × 1');
      const d = makeData(W, truth(W), 100, 250, 0.5, 3, 0.9), f = W.PRiSM_dfit_lkFit(d, truth(W), 'full', { free: ['k', 'sigmaC', 'pr'] });
      okFit(assert, f, 'AR(1) fit');
      assert(f.rho1 > 0.5 && f.inflation > 2, 'correlated residuals detected (ρ1 ' + f.rho1.toFixed(2) + ', × ' + f.inflation.toFixed(2) + ')');
      assert.near(f.inflation, Math.sqrt(250 / f.nEff), 1e-9, 'inflation = √(n/n_eff)');
      const wd = (c) => c[1] - c[0];
      assert(rel(wd(f.ci95Inflated.sigmaC) / wd(f.ci95.sigmaC), f.inflation) <= 1e-9, 'inflated σ_c interval');
    },
  },
  {
    name: 'DFIT LF8: log k parameterisation — σ_c or p_r ± 200 psi leaves κ_k unchanged to 1e-6; CL equivalent follows Δp_CL', wp: WP, opts: false,
    run(_a, assert, ctx) {
      const W = app(ctx), c = truth(W, { aperture: { law: 'none', sh: 60, sc: 100, fres: 0.1, sr: null }, Sp: 0 });
      const kap = (o) => { const e = W.PRiSM_dfit_lkToEngine(Object.assign(clone(c), o)); assert(e.ok, 'engine config'); return e.e.kap; };
      const k0 = kap({});
      [{ sigmaC: 7200 }, { sigmaC: 6800 }, { pr: 4700 }, { pr: 4300 }].forEach((o) => assert(rel(kap(o), k0) <= 1e-6, 'κ_k unchanged for ' + JSON.stringify(o)));
      assert(rel(kap({ k: 2 * K_TRUE }), Math.SQRT2 * k0) <= 1e-12, 'κ_k ∝ √k');
      [{}, { sigmaC: 7200 }, { pr: 4300 }].forEach((o) => {
        const r = W.PRiSM_dfit_lkSimulate(Object.assign(clone(c), o, { tEnd: TP + 10 }), { grid: 'coarse' });
        assert.strictEqual(r.ok, true, 'run ok');
        const u = W._PRiSM_dfit_lk.units();
        assert(rel(r.CLeq, k0 * r.dpCL / u.sqmin) <= 1e-9, 'CL_eq = κ_k·Δp_CL for ' + JSON.stringify(o));
        assert.near(r.dpCL, 0.5 * (r.events.isip + r.sigmaC) - r.pr, 1e-9, 'Δp_CL convention');
      });
      // the fit moves σ_c and p_r without dragging k: the k step of the forward Jacobian is a pure log-k step
      const conv = W.PRiSM_dfit_lkToEngine(Object.assign(clone(c), { CL: 1.863e-4, wc: 1, dpRef: 2500, k: null }));
      assert(conv.ok && conv.e.fromCL, 'CL / w_c inputs convert once, never as fit parameters');
    },
  },
];
