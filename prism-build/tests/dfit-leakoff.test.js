// DFIT — WP4 leak-off mini-model (docs/DFIT-PLAN.md §5, §6.1, §9 WP4). Pure engine, one shared app per file (opts:false).
//
//   L1–L14  the §5.4 acceptance vectors V1–V14 (V11 / V12 here in a light form; the noisy history matches are LF1 / LF2)
//   L15     quick table on the base case (q_L 0.586 / 0.262 / 0.135 / 0.070 bbl/min, η 0.892, Δt_c 307.1 min, ± 2 %)
//   L16     lkSolveCL: 1.863e-4 ± 2 % for Δt_c 307.1 min (wall-only) and the matching k for the reservoir-controlled case
//   L17     the volume partition (fracture + formation + wellbore) sums to V_i within 1e-6
//   L18     simulate and fit leave localStorage, PRiSM_state and the event log unchanged (pure)
//
// 56's G functions are stubbed (closed forms, §4.5) through sourceOverrides until WP2 merges (plan §2.12 rule 4): the stub
// replaces PRiSM_dfit_g / G / Ginv only while they are still the WP0 NOT_IMPLEMENTED stubs.
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
function app(ctx) { const a = S.sharedApp(ctx, OPTS); S.resetDfit(a); return a.win; }

const TP = 5 / 60;
function base(W, o) { const c = W.PRiSM_dfit_lkDefaults(); Object.keys(o || {}).forEach((k) => { c[k] = o[k]; }); return c; }
const relErr = (a, b) => Math.abs(a - b) / Math.abs(b);
function within(assert, a, b, rel, what) { assert(typeof a === 'number' && relErr(a, b) <= rel, what + ': ' + a + ' vs ' + b + ' (± ' + (rel * 100) + ' %)'); }
function verify(W, id) { const v = W.PRiSM_dfit_lkVerify({ only: [id] }); if (!v || v.ok !== true || !v[id]) throw new Error('lkVerify ' + id + ' failed: ' + JSON.stringify(v).slice(0, 300)); return v[id]; }

module.exports = [
  {
    name: 'DFIT L1 (V1a): Nolte falloff α = 1 — V_L, p = ISIP − m_G0·G, ISIP 7,610.003, η 0.91513, G_c 18.306', wp: WP, opts: false,
    run(_a, assert, ctx) {
      const W = app(ctx);
      assert(W._dfitGStubbedForWP4 === true || (W.PRiSM_dfit_G && !W.PRiSM_dfit_G._dfitStub), '56 G functions available (stub or real)');
      const v = verify(W, 'V1a');
      assert(v.maxRelErrVL <= 1e-10, 'V_L rel err ' + v.maxRelErrVL);
      assert(v.maxDevP <= 1e-6, '|p − (ISIP − m_G0·G)| ' + v.maxDevP);
      assert.near(v.isip, 7610.003, 0.001, 'ISIP'); assert.near(v.eta, 0.91513, 1e-5, 'η'); assert.near(v.Gc, 18.306, 1e-3, 'G_c');
      // the LkResult shape on a full run
      const r = W.PRiSM_dfit_lkSimulate(base(W, {}), { grid: 'fit' });
      assert.strictEqual(r.ok, true, 'base run ok');
      const sh = S.checkShape('LkResult', r); assert(sh.ok, 'LkResult shape: ' + sh.errors.slice(0, 4).join('; '));
      const cs = S.checkShape('LkConfig', W.PRiSM_dfit_lkDefaults()); assert(cs.ok, 'LkConfig shape: ' + cs.errors.slice(0, 4).join('; '));
    },
  },
  {
    name: 'DFIT L2 (V1b): α = ½ — V_L rel err ≤ 1e-4, |p − line| ≤ 0.01 psi, ISIP 7,599.93, η 0.90002, G_c 18.0039, Δt_c 305.2 min, m_G0 33.322', wp: WP, opts: false,
    run(_a, assert, ctx) {
      const v = verify(app(ctx), 'V1b');
      assert(v.maxRelErrVL <= 1e-4, 'V_L rel err ' + v.maxRelErrVL);
      assert(v.maxDevP <= 0.01, '|p − line| ' + v.maxDevP);
      assert.near(v.isip, 7599.93, 0.01, 'ISIP'); assert.near(v.eta, 0.90002, 1e-4, 'η'); assert.near(v.Gc, 18.0039, 1e-4, 'G_c');
      assert.near(v.dtcMin, 305.2, 0.1, 'Δt_c'); assert.near(v.mG0, 33.322, 1e-3, 'm_G0');
    },
  },
  {
    name: 'DFIT L3 (V1c): grid independence — G_c = 18.00394 from 117 to 3,301 steps', wp: WP, opts: false,
    run(_a, assert, ctx) {
      const v = verify(app(ctx), 'V1c');
      assert.strictEqual(v.grids[0].N, 117, 'coarsest grid 117 steps'); assert.strictEqual(v.grids[v.grids.length - 1].N, 3301, 'finest 3,301');
      v.grids.forEach((g) => assert.near(g.Gc, 18.00394, 1e-4, 'G_c at N ' + g.N));
      assert(Math.abs(v.grids[0].Gc - v.grids[3].Gc) <= 1e-5 * 18, 'spread across grids');
    },
  },
  {
    name: 'DFIT L4 (V1d): storage in the G slope — ISIP 7,586.07, G_c = pn·(1 + V_w·c_w/(A_f·c_f))/m_G0', wp: WP, opts: false,
    run(_a, assert, ctx) {
      const v = verify(app(ctx), 'V1d');
      assert.near(v.isip, 7586.07, 0.01, 'ISIP'); assert.near(v.Gc, v.GcExpected, 1e-3, 'G_c vs storage formula'); assert.near(v.Gc, 18.0040, 1e-3, 'G_c');
    },
  },
  {
    name: 'DFIT L5 (V2): Carter area at constant net pressure — five (CL, S_p) cases to 1e-4', wp: WP, opts: false,
    run(_a, assert, ctx) {
      const v = verify(app(ctx), 'V2'), want = [68890.1, 47998.1, 33134.4, 22044.7, 8992.5];
      v.cases.forEach((c, i) => { within(assert, c.A, want[i], 1e-4, 'A(30 min) case ' + i); assert(c.maxRelErr <= 1e-4, 'history rel err ' + c.maxRelErr); within(assert, c.A, c.Acarter, 1e-5, 'A vs closed form'); });
    },
  },
  {
    name: 'DFIT L6 (V3): no-leak-off growth laws — exponents and L(5 min) 468.29 / 317.98 / 165.02 / 573.01 / 192.54 ft, η = 1', wp: WP, opts: false,
    run(_a, assert, ctx) {
      const v = verify(app(ctx), 'V3'), L = [468.29, 317.98, 165.02, 573.01, 192.54], ex = [0.8, 2 / 3, 4 / 9, 2 / 3, 0.4];
      v.cases.forEach((c, i) => {
        within(assert, c.L5, L[i], 1e-4, c.geometry + ' ' + c.vertex + ' L(5 min)');
        assert.near(c.exponent, ex[i], 1e-4, c.geometry + ' ' + c.vertex + ' exponent');
        assert.near(c.eta, 1, 1e-5, 'η'); assert(c.maxLawDev <= 1e-4, 'L/law deviation ' + c.maxLawDev);
      });
      assert.near(v.prefKGD, 0.9324, 1e-4, 'KGD toughness prefactor'); assert.near(v.prefRadial, 0.8546, 1e-4, 'radial toughness prefactor');
    },
  },
  {
    name: 'DFIT L7 (V4): efficiency limits — α_A → 0.800 / 0.502, η_s → 0.998 / 0.0049, η from G_c with the model α within 5e-4', wp: WP, opts: false,
    run(_a, assert, ctx) {
      const v = verify(app(ctx), 'V4'), lo = v.cases[0], hi = v.cases[v.cases.length - 1];
      assert.near(lo.alphaA, 0.800, 1e-3, 'α_A low CL'); assert.near(hi.alphaA, 0.502, 1e-3, 'α_A high CL');
      assert.near(lo.etaS, 0.998, 1e-3, 'η_s low CL'); assert.near(hi.etaS, 0.0049, 1e-3, 'η_s high CL');
      v.cases.filter((c) => c.etaG != null).forEach((c) => assert.near(c.etaG, c.etaS, 5e-4, 'η(G_c, α) vs η_s at CL ' + c.CL));
    },
  },
  {
    name: 'DFIT L8 (V5): storage ramp before breakdown — dp/dt = q/(V_w·c_w) = 5,637.1 psi/min', wp: WP, opts: false,
    run(_a, assert, ctx) {
      const v = verify(app(ctx), 'V5');
      assert(v.ok, 'run ok'); within(assert, v.dpdt, 5637.1, 1e-5, 'ramp'); within(assert, v.dpdt, v.expected, 1e-6, 'ramp vs q/(V_w·c_w)');
    },
  },
  {
    name: 'DFIT L9 (V6): after-closure linear asymptote — ratio 1.0165 / 1.0059 / 1.0039, slope −0.5 ± 0.01 late', wp: WP, opts: false,
    run(_a, assert, ctx) {
      const v = verify(app(ctx), 'V6'), byT = {};
      v.points.forEach((p) => { byT[p.tH] = p; });
      assert.near(byT[20].ratio, 1.0165, 1e-3, 'ratio 20 h'); assert.near(byT[100].ratio, 1.0059, 1e-3, 'ratio 100 h'); assert.near(byT[200].ratio, 1.0039, 1e-3, 'ratio 200 h');
      assert.near(byT[20].slope, -0.506, 2e-3, 'slope 20 h');
      [50, 100, 200].forEach((t) => assert.near(byT[t].slope, -0.5, 0.01, 'slope ' + t + ' h'));
    },
  },
  {
    name: 'DFIT L10 (V7): volume balance with breakdown, PDL, contact, spurt, friction — |error| ≤ 1e-6·V_i', wp: WP, opts: false,
    run(_a, assert, ctx) {
      const v = verify(app(ctx), 'V7');
      assert(v.ok, 'run ok'); assert(v.balanceErr <= 1e-6 * v.Vi, 'balance ' + v.balanceErr + ' bbl of ' + v.Vi);
    },
  },
  {
    name: 'DFIT L11 (V8 + V11 light): pre-closure cross-check within 3 %; a 3-parameter match {k, σ_c, p_r} recovers the truth', wp: WP, opts: false,
    run(_a, assert, ctx) {
      const W = app(ctx), v = verify(W, 'V8');
      within(assert, v.xf, v.ref.xf, 0.03, 'xf'); within(assert, v.pn, v.ref.pn, 0.03, 'pn'); within(assert, v.eta, v.ref.eta, 0.03, 'η'); within(assert, v.dtc, v.ref.dtc, 0.03, 'Δt_c');
      within(assert, v.xf, 133.8, 1e-3, 'xf 133.8'); within(assert, v.pn, 596.3, 1e-3, 'pn 596.3'); assert.near(v.eta, 0.892, 1e-3, 'η 0.892'); assert.near(v.dtc, 307.1, 0.1, 'Δt_c 307.1');
      if (typeof W.PRiSM_dfit_lkFit !== 'function' || W.PRiSM_dfit_lkFit._dfitStub) return;
      // noise-free reservoir-controlled record to 20 h, start ×1.5 / +150 / −200 (the noisy version is LF1)
      const truth = base(W, { Cw: 0, k: 3.308e-3, aperture: { law: 'hyp', sh: 60, sc: 100, fres: 0.1, sr: null }, tEnd: TP + 20.5 });
      const rs = W.PRiSM_dfit_lkSimulate(truth, { grid: 'fit' }), t = [];
      for (let i = 0; i < 120; i++) t.push(TP + Math.exp(Math.log(10 / 3600) + (Math.log(20) - Math.log(10 / 3600)) * i / 119));
      const p = W.PRiSM_dfit_lkSample(rs, t), c0 = JSON.parse(JSON.stringify(truth));
      c0.k = 3.308e-3 * 1.5; c0.sigmaC = 7150; c0.pr = 4300;
      const f = W.PRiSM_dfit_lkFit({ t, p }, c0, 'falloff', { free: ['k', 'sigmaC', 'pr'], sigmaP: 0.5 });
      assert.strictEqual(f.ok, true, 'fit ok: ' + JSON.stringify(f).slice(0, 200));
      within(assert, f.params.k, 3.308e-3, 0.01, 'k'); assert.near(f.params.sigmaC, 7000, 1, 'σ_c'); assert.near(f.params.pr, 4500, 2, 'p_r');
    },
  },
  {
    name: 'DFIT L12 (V9 + V12 light): 2-D far-field slopes −0.653 … −0.940, radial impulse 0.955 / 0.977; Γ_PKN = 14.904 on the truth', wp: WP, opts: false,
    run(_a, assert, ctx) {
      const W = app(ctx), v = verify(W, 'V9');
      assert.near(v.xe, 170.7, 0.1, 'x_e');
      const want = [-0.653, -0.845, -0.911, -0.928, -0.940];
      v.points.forEach((p, i) => assert.near(p.slope, want[i], 2e-3, 'slope at t_D ' + p.tD.toFixed(2)));
      v.points.filter((p) => p.tD > 1.5).forEach((p) => assert(p.slope < -0.9, 'slope < −0.9 at t_D ' + p.tD.toFixed(2)));
      assert.near(v.points[2].dpOverRadial, 0.955, 2e-3, 'Δp / radial impulse at 1.5'); assert.near(v.points[3].dpOverRadial, 0.977, 2e-3, 'at 3.0');
      const g = W.PRiSM_dfit_lkGroups(base(W, {}));
      assert.strictEqual(g.ok, true, 'groups ok');
      assert.near(g.GammaPKN, 14.904, 1e-3, 'Γ_PKN'); assert.near(g.Gamma, (2 / Math.PI) * g.GammaPKN * g.Rvis, 1e-6, 'Γ = (2/π)·Γ_PKN·R_vis');
      assert(/psi\/√min/.test(g.text) && g.text.length < 300, 'group sentence');
    },
  },
  {
    name: 'DFIT L13 (V10 + V13): model-derived G — dP/dG_gen constant −32.487 while dP/dG(α = ½) drifts; g = B_w/(A_L,s·√tp) closed forms', wp: WP, opts: false,
    run(_a, assert, ctx) {
      const W = app(ctx), v = verify(W, 'V10');
      v.points.forEach((p) => assert.near(p.dPdGgen, -32.487, 1e-3, 'dP/dG_gen at ' + p.dtMin + ' min'));
      assert.near(v.points[0].dPdGa05, -37.3, 0.05, 'α = ½ early'); assert.near(v.points[v.points.length - 1].dPdGa05, -32.56, 0.05, 'α = ½ late');
      const w = verify(W, 'V13');
      w.cases.forEach((c) => assert(c.maxRelErr <= 1e-6, 'g closed form ' + c.alpha + ': ' + c.maxRelErr));
    },
  },
  {
    name: 'DFIT L14 (V14): aperture laws stay positive to 3,000 psi below σ_c; hydraulic closure 0.801·s_c (0.811 limit) and s_h·(√2 − 1)', wp: WP, opts: false,
    run(_a, assert, ctx) {
      const v = verify(app(ctx), 'V14');
      assert(v.minW > 0, 'w > 0'); assert(v.minC >= 0, 'c ≥ 0');
      within(assert, v.hydExp, 0.801, 1e-3, 'exp'); within(assert, v.hydExpInf, 0.811, 1e-3, 'exp, s_r → ∞'); within(assert, v.hydHyp, v.hydHypExpected, 1e-3, 'hyp');
    },
  },
  {
    name: 'DFIT L15: quick table on the base case — q_L 0.586 / 0.262 / 0.135 / 0.070 bbl/min, η 0.892, Δt_c 307.1 min (± 2 %)', wp: WP, opts: false,
    run(_a, assert, ctx) {
      const W = app(ctx), q = W.PRiSM_dfit_lkQuick(W.PRiSM_dfit_lkDefaults());
      assert.strictEqual(q.ok, true, 'quick ok');
      const want = [0.586, 0.262, 0.135, 0.070];
      want.forEach((x, i) => within(assert, q.rows[i].qL, x, 0.02, q.rows[i].label));
      within(assert, q.eta, 0.892, 0.02, 'η'); within(assert, q.tc * 60, 307.1, 0.02, 'Δt_c');
      assert(q.rows.length === 5 && q.rows[4].label === 'At closure', 'closure row');
      within(assert, q.xf, 133.8, 0.02, 'xf'); assert(q.wAvg > 0 && q.wMax > q.wAvg, 'widths');
      assert.near(q.partition.frac + q.partition.form + q.partition.wb, 1, 1e-6, 'partition at shut-in');
    },
  },
  {
    name: 'DFIT L16: lkSolveCL — 1.863e-4 ± 2 % for Δt_c 307.1 min (wall-only) and the matching k (reservoir-controlled)', wp: WP, opts: false,
    run(_a, assert, ctx) {
      const W = app(ctx);
      const s = W.PRiSM_dfit_lkSolveCL(base(W, { Cw: 4e-4 }), 307.1 / 60);
      assert.strictEqual(s.ok, true, 'wall solve ok'); within(assert, s.CL, 1.863e-4, 0.02, 'CL'); assert(s.runs <= 30, 'runs ' + s.runs);
      const truth = base(W, { Cw: 0, k: 3.308e-3 }), r = W.PRiSM_dfit_lkSimulate(truth, { grid: 'fit' }), dtc = r.events.tcMech - r.events.ts;
      const s2 = W.PRiSM_dfit_lkSolveCL(base(W, { Cw: 0, k: 1e-2 }), dtc);
      assert.strictEqual(s2.ok, true, 'k solve ok'); within(assert, s2.k, 3.308e-3, 0.02, 'k'); assert(s2.runs <= 30, 'runs ' + s2.runs);
      within(assert, s2.CL, r.CLeq, 0.02, 'CL equivalent at Δp_CL');
      const bad = W.PRiSM_dfit_lkSolveCL(base(W, {}), -1);
      assert(bad.ok === false && S.checkShape('Failure', bad).ok, 'invalid input → failure form');
    },
  },
  {
    name: 'DFIT L17: volume partition — fracture + formation + wellbore = V_i to 1e-6 on every step (breakdown run)', wp: WP, opts: false,
    run(_a, assert, ctx) {
      const W = app(ctx), r = W.PRiSM_dfit_lkSimulate(base(W, { pBd: 9500, p0: 4500, aperture: { law: 'hyp', sh: 60, sc: 100, fres: 0.1, sr: null } }), { grid: 'fit' });
      assert.strictEqual(r.ok, true, 'run ok');
      const n = r.t.length, Vi = r.Vi[n - 1];
      let worst = 0;
      for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(r.Vf[i] + r.VL[i] + r.Vw[i] - r.Vi[i]));
      assert(worst <= 1e-6 * Vi, 'partition error ' + worst);
      for (let i = 0; i < n; i++) assert(Math.abs(r.VL[i] - (r.VLw[i] + r.VLc[i] + r.VS[i])) <= 1e-9 * Vi, 'leak-off parts at ' + i);
      const iS = r.t.findIndex((x) => x >= r.events.ts - 1e-12);
      assert(r.Vf[iS] / r.ViFrac[iS] > r.Vf[iS] / r.Vi[iS], 'η of the fracture volume exceeds η of the pumped volume');
      const sh = S.checkShape('LkResult', r); assert(sh.ok, 'shape: ' + sh.errors.slice(0, 3).join('; '));
    },
  },
  {
    name: 'DFIT L18: simulate, quick, solve and fit are pure — storage, PRiSM_state and the event log unchanged', wp: WP, opts: false,
    run(_a, assert, ctx) {
      const A = S.sharedApp(ctx, OPTS); S.resetDfit(A);
      const W = A.win, st = A.storage;
      const snapStore = () => { const o = {}; for (let i = 0; i < st.length; i++) { const k = st.key(i); o[k] = st.getItem(k); } return JSON.stringify(o); };
      const snapState = () => JSON.stringify(W.PRiSM_state || null, (k, v) => (typeof v === 'function' ? undefined : v));
      const events = [];
      const rec = (e) => events.push(e && e.type);
      const doc = W.document;
      const origW = W.dispatchEvent, origD = doc && doc.dispatchEvent;
      W.dispatchEvent = function (e) { rec(e); return origW ? origW.apply(this, arguments) : true; };
      if (doc) doc.dispatchEvent = function (e) { rec(e); return origD ? origD.apply(this, arguments) : true; };
      const s0 = snapStore(), p0 = snapState(), timers0 = A.pendingTimers ? A.pendingTimers() : 0;
      try {
        const c = W.PRiSM_dfit_lkDefaults();
        W.PRiSM_dfit_lkSimulate(c, { grid: 'coarse' }); W.PRiSM_dfit_lkQuick(c); W.PRiSM_dfit_lkGroups(c);
        if (typeof W.PRiSM_dfit_lkFit === 'function' && !W.PRiSM_dfit_lkFit._dfitStub) {
          const r = W.PRiSM_dfit_lkSimulate(c, { grid: 'fit' }), t = [TP + 0.01, TP + 0.5, TP + 1, TP + 2, TP + 3, TP + 4];
          W.PRiSM_dfit_lkFit({ t, p: W.PRiSM_dfit_lkSample(r, t) }, c, 'falloff', { free: ['Cw', 'sigmaC'], maxRuns: 12 });
        }
      } finally { W.dispatchEvent = origW; if (doc) doc.dispatchEvent = origD; }
      assert.strictEqual(snapStore(), s0, 'storage unchanged'); assert.strictEqual(snapState(), p0, 'PRiSM_state unchanged');
      assert.deepStrictEqual(events, [], 'no events'); if (A.pendingTimers) assert.strictEqual(A.pendingTimers(), timers0, 'no timers');
      const src = fs.readFileSync(path.join(__dirname, '..', '58-prism-dfit-leakoff.js'), 'utf8');
      assert(!/Math\.random/.test(src), 'no Math.random in 58');
      assert(!/setTimeout|setInterval|localStorage|document\./.test(src.split('// === SELF-TEST ===')[0]), 'no timers, storage or DOM in 58');
    },
  },
];
