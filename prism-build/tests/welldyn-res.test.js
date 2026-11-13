// Well Dynamics — the reservoir boundary WTS_wd_res (lane WD1). docs/WELL-DYNAMICS-PLAN.md §4.7, §5.2 RS1–RS12.
//
// RS1  the line-source E1 term vs PRiSM model #1 (homogeneous, Stehfest) within 0.5 % for t_D > 100
// RS2  f(∞) = 1 reproduces the Darcy IPR; the stabilised resistance of darcyOil equals the line-source denominator
// RS3  superposition of two rate steps (oil, linear) = the analytical sum
// RS4  build-up (shutInBuildup, reservoir transient, prior steady 720 h): the derivative of p_ws in the infinite-acting window = 70.6 qBμ/(kh)
//      within 3 % (the engine run is shared with welldyn-engine EN2 / EN8 / EN9 through the helper's memo)
// RS5  transient → IPR after stabilisation (steady start, prior steady): the settled rate within 0.5 % of the IPR-mode run
// RS6  gas p² and m(p) potentials: u(q) = Φ(p̄r) − Φ(pwf(q))
// RS7  the non-Darcy part is instantaneous (b·q² at Δt → 0)
// RS8  term compaction (> 400 rate steps) changes the past sum by ≤ 0.05 psi
// RS9  missing parameters keep the mode 'ipr' with a message
// RS10 horner / derivative helpers (closed form)
// RS11 negative skin S = −4: f > 0 and monotone for all τ > 0 (r_w,eff = r_w e^−S)
// RS12 prior history: 'none' keeps p_wf = p̄r on a shut static start; 'steady' / 'shutin' reproduce the analytical superposition
'use strict';

const W = require('./_welldyn-wd1');

const WP = 'WD1';
const G = (ctx) => W.sharedApp(ctx).win;
const ctxOf = (ctx, key) => { const g = G(ctx), cx = g.WTS_wp_system.context(W.FIX[key]); if (!cx.ok) throw new Error('context ' + key + ' ' + cx.code); return cx.C; };
const P_BU = { k: 50, h: 50, phi: 0.2, ct: 1.5e-5, mu: 1, rw: 0.354, re: 1500, S: 2 };

module.exports = [
  {
    name: 'RS1 line source ½E1(1/(4t_D)) vs PRiSM model #1 (homogeneous, Stehfest, C_D → 0) within 0.5 % for t_D > 100',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const g = G(ctx), pd = g.PRiSM_MODELS.homogeneous.pd;
      [150, 1e3, 1e4, 1e5, 1e6].forEach((tD) => {
        const ls = 0.5 * g.WTS_wd_res.E1(1 / (4 * tD)), st = pd(tD, { Cd: 1e-3, S: 0 });
        assert.rel(ls, st, 0.005, 't_D ' + tD);
      });
      // E1 is PRiSM_E1 when loaded (one implementation in the app)
      assert.strictEqual(g.WTS_wd_res.E1(0.37), g.PRiSM_E1(0.37));
    },
  },
  {
    name: 'RS2 f(∞) = 1: the transient inflow reproduces the darcyOil IPR; its stabilised resistance equals ln(re/rw) − 0.75 + S',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const g = G(ctx), C = ctxOf(ctx, 'buildup'), I = C.I, M = W.FIX.buildup;
      const R = g.WTS_wd_res.create(I, M, Object.assign({ mode: 'transient', F: C.F, prior: { kind: 'none' } }, P_BU, { mu: null }));
      assert.strictEqual(R.mode, 'transient');
      assert.rel(R.f(1e9), 1, 1e-15, 'f(∞)');
      // ln(re/rw) − 0.75 + S of the line source = the darcyOil form's X + S (pss reference, R·form.X)
      assert.rel(R.den, I.form.X + I.params.S, 1e-9, 'denominator = IPR ln-term + S');
      // a long constant-rate history: q at p equals I.qAt(p)
      [2900, 2700, 2400].forEach((p) => {
        const R2 = g.WTS_wd_res.create(I, M, Object.assign({ mode: 'transient', F: C.F, prior: { kind: 'none' } }, P_BU, { mu: null }));
        const q0 = I.qAt(p);
        R2.begin(0, 1e9 * 3600); const q = R2.qAt(p);
        assert.rel(q, q0, 1e-6, 'stabilised q at ' + p);
      });
    },
  },
  {
    name: 'RS3 superposition of two rate steps (oil, linear) equals the analytical sum Δu₁·f(t) + Δu₂·f(t − t₁)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const g = G(ctx), C = ctxOf(ctx, 'buildup'), I = C.I, M = W.FIX.buildup;
      const R = g.WTS_wd_res.create(I, M, Object.assign({ mode: 'transient', F: C.F, prior: { kind: 'none' } }, P_BU, { mu: null }));
      const q1 = 400, q2 = 700, t1 = 3600, t2 = 4 * 3600, dt = 120;
      R.commit(q1, 0); R.commit(q2, t1);
      const u1 = R.uD(q1), u2 = R.uD(q2) - R.uD(q1);
      const pAt = (t) => C.pr - (u1 * R.f(t / 3600) + u2 * R.f((t - t1) / 3600));
      // with the rate held at q2 over [t2, t2 + dt] the step's solution at the analytical pressure is q2
      R.begin(t2, dt);
      assert.rel(R.qAt(pAt(t2 + dt)), q2, 1e-7, 'q at the analytical pressure');
      assert.ok(R.terms().length === 2, 'two terms');
    },
  },
  {
    name: 'RS4 build-up (shutInBuildup, transient, prior steady 720 h): derivative of p_ws in the infinite-acting window = 70.6 qBμ/(kh) ± 3 %',
    wp: WP, opts: false, timeoutMs: 240000,
    run(_a, assert, ctx) {
      const g = G(ctx), run = W.memo('shutInBuildup', () => W.runScenario(g, 'shutInBuildup'));
      assert.ok(run.ok, 'scenario ran: ' + (run.code || ''));
      const P = run.res.params, Bo = run.I.params.Bo, mu = run.I.params.muo;
      const m = 70.6 * run.qShut * Bo * mu / (P.k * P.h);
      // the slope of p_ws against ln Δt over 2 h ≤ Δt ≤ 8 h (10 t_wbs ≲ 1 h, 0.1 t_pss ≈ 16 h; §3.9 C10)
      const pts = run.bu.filter((x) => x.dt >= 2 * 3600 && x.dt <= 8 * 3600);
      assert.ok(pts.length >= 6, 'samples in the window: ' + pts.length);
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      pts.forEach((x) => { const l = Math.log(x.dt); sx += l; sy += x.p; sxx += l * l; sxy += l * x.p; });
      const nP = pts.length, slope = (nP * sxy - sx * sy) / (nP * sxx - sx * sx);
      assert.rel(slope, m, 0.03, 'semilog slope (psi per ln cycle)');
      // and the Bourdet helper on the same samples agrees with the regression slope
      const d = g.WTS_wd_res.derivative(pts.map((x) => x.dt), pts.map((x) => x.p));
      const mid = d.slice(1, -1).reduce((s, v) => s + v, 0) / (d.length - 2);
      assert.rel(mid, m, 0.05, 'mean Bourdet derivative');
    },
  },
  {
    name: 'RS5 transient → IPR: a steady start with prior steady settles within 0.5 % of the IPR-mode rate (buildup fixture)',
    wp: WP, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const g = G(ctx), M = W.FIX.buildup;
      const a = g.WTS_wd_engine.create(M, { reservoir: W.RES_BUILDUP });
      const b = g.WTS_wd_engine.create(M, { reservoir: { mode: 'ipr' } });
      assert.ok(a.ok && b.ok);
      assert.strictEqual(a.res.mode, 'transient'); assert.strictEqual(b.res.mode, 'ipr');
      const ra = W.runSteady(a, { cap_s: 3 * 3600 }), rb = W.runSteady(b, { cap_s: 3 * 3600 });
      assert.ok(ra.ok && rb.ok);
      assert.rel(ra.chk.qMean, rb.chk.qMean, 0.005, 'rate');
      assert.rel(ra.chk.pwfMean, rb.chk.pwfMean, 0.005, 'BHP');
      assert.ok(a.state.provisional.indexOf('res_sup') !== -1 && b.state.provisional.indexOf('res_sup') === -1, 'res_sup listed only in transient mode');
    },
  },
  {
    name: 'RS6 gas potentials: LIT p² → Φ = p² and u(q) = p̄r² − pwf(q)²; LIT m(p) → Φ = m(p) (PRiSM_mpTable)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const g = G(ctx), C = ctxOf(ctx, 'gasVert'), M = W.FIX.gasVert;
      const R = g.WTS_wd_res.create(C.I, M, { mode: 'transient', F: C.F, k: 5, h: 40, phi: 0.12, ct: 2e-4, mu: 0.02, rw: 0.354, re: 2000, S: 1, prior: { kind: 'none' } });
      assert.strictEqual(R.potential, 'p2');
      [1000, 4000, 9000].forEach((q) => { const pw = C.I.pwfAt(q); assert.rel(R.u(q), C.pr * C.pr - pw * pw, 1e-12, 'u at ' + q); });
      // the non-Darcy part of LIT p² is b·q²
      assert.rel(R.uND(3000), C.I.params.b * 3000 * 3000, 1e-12);
      const M2 = W.FIX.gasVert; M2.res.model = 'litMp'; M2.res.params = { a: 0.05, b: 2e-6, sg: 0.65 };
      const cx = g.WTS_wp_system.context(M2);
      assert.ok(cx.ok, 'litMp context');
      const R2 = g.WTS_wd_res.create(cx.C.I, M2, { mode: 'transient', F: cx.C.F, k: 5, h: 40, phi: 0.12, ct: 2e-4, mu: 0.02, rw: 0.354, re: 2000, S: 1 });
      assert.strictEqual(R2.potential, 'mp');
      const tb = g.PRiSM_mpTable({ T_F: M2.res.T_F, sg: 0.65, pmax: Math.max(1.2 * cx.C.pr, cx.C.pr + 500) });
      assert.rel(R2.Phi(2000), tb.mOf(2000), 1e-12, 'Φ = m(p)');
    },
  },
  {
    name: 'RS7 the non-Darcy part acts instantaneously: at Δt → 0 the step rate satisfies Φ(p̄r) − Φ(p) = past + u_ND(q)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const g = G(ctx), C = ctxOf(ctx, 'gasVert'), M = W.FIX.gasVert;
      const R = g.WTS_wd_res.create(C.I, M, { mode: 'transient', F: C.F, k: 5, h: 40, phi: 0.12, ct: 2e-4, mu: 0.02, rw: 0.354, re: 2000, S: 1, prior: { kind: 'none' } });
      // at Δt → 0 only the skin share of f is left (f(0⁺) = S/den: the skin is instantaneous too), the Darcy term of the formation is not
      const dt = 1e-6, f1 = Math.max(R.f(dt / 3600), 1e-3);
      assert.rel(f1, 1 / R.den, 1e-6, 'f(0⁺) = S/den');
      R.begin(0, dt);
      const p = 3000, q = R.qAt(p), rhs = C.pr * C.pr - p * p;
      assert.ok(q > 0, 'rate');
      assert.rel(R.uD(q) * f1 + R.uND(q), rhs, 1e-6, 'u_D·f(Δt) + u_ND = ΔΦ');
      // the non-Darcy share at Δt → 0 exceeds its share at stabilisation (it does not wait for the formation)
      const R2 = g.WTS_wd_res.create(C.I, M, { mode: 'transient', F: C.F, k: 5, h: 40, phi: 0.12, ct: 2e-4, mu: 0.02, rw: 0.354, re: 2000, S: 1, prior: { kind: 'none' } });
      R2.begin(0, 1e9); const qs = R2.qAt(p);
      assert.ok(R.uND(q) / rhs > R2.uND(qs) / rhs + 0.1, 'u_ND share now ' + (R.uND(q) / rhs).toFixed(3) + ' vs stabilised ' + (R2.uND(qs) / rhs).toFixed(3));
    },
  },
  {
    name: 'RS8 term compaction: 1,000 alternating rate steps (capped at 400 terms) move the past sum by ≤ 0.05 psi',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const g = G(ctx), C = ctxOf(ctx, 'buildup'), I = C.I, M = W.FIX.buildup;
      const R = g.WTS_wd_res.create(I, M, Object.assign({ mode: 'transient', F: C.F, prior: { kind: 'none' } }, P_BU, { mu: null }));
      const hist = []; let t = 0;
      for (let i = 0; i < 1000; i++) { const q = 500 + 300 * Math.sin(i / 7) + (i % 2 ? 40 : -40); R.begin(t, 30); R.commit(q, t); hist.push([t, q]); t += 30; }
      assert.ok(R.terms().length <= 400, 'terms ≤ 400: ' + R.terms().length);
      // exact sum at t (all 1,000 terms) vs the compacted one (base + terms)
      const tN = t + 60;
      let exact = 0, prevU = 0;
      hist.forEach(([tj, q]) => { const u = R.uD(q); exact += (u - prevU) * R.f((tN - tj) / 3600); prevU = u; });
      let comp = R.base(); R.terms().forEach(([tj, du]) => { comp += du * R.f((tN - tj) / 3600); });
      assert.ok(Math.abs(comp - exact) <= 0.05, 'Δ = ' + Math.abs(comp - exact).toFixed(4) + ' psi');
    },
  },
  {
    name: 'RS9 a transient reservoir with missing parameters keeps the IPR inflow and says what is missing',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const g = G(ctx), C = ctxOf(ctx, 'oilVert');
      const R = g.WTS_wd_res.create(C.I, W.FIX.oilVert, { mode: 'transient', F: C.F, h: 50 });
      assert.strictEqual(R.mode, 'ipr');
      assert.ok(R.warnings.some((w) => w.code === 'RES_PARAMS_MISSING' && /k/.test(w.msg)), 'warning');
      assert.deepStrictEqual(R.missing.indexOf('k') !== -1, true);
      // the engine passes the message on (flags)
      const sim = g.WTS_wd_engine.create(W.FIX.oilVert, { reservoir: { mode: 'transient', h: 50 } });
      assert.ok(sim.ok && sim.res.mode === 'ipr' && sim.state.flags.some((f) => f.code === 'RES_PARAMS_MISSING'));
    },
  },
  {
    name: 'RS10 helpers: horner (tp + Δt)/Δt and the Bourdet derivative of p = a + b ln t is b',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const g = G(ctx), R = g.WTS_wd_res;
      assert.strictEqual(R.horner(10, 2), 6);
      assert.ok(Number.isNaN(R.horner(10, 0)));
      const t = [], p = [];
      for (let i = 0; i < 30; i++) { const x = Math.pow(10, -1 + i / 8); t.push(x); p.push(1000 + 21.5 * Math.log(x)); }
      R.derivative(t, p).forEach((d, i) => assert.rel(d, 21.5, 1e-9, 'point ' + i));
    },
  },
  {
    name: 'RS11 negative skin S = −4: r_w,eff = r_w·e⁴, S_e = 0; f > 0 and non-decreasing for every τ > 0',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const g = G(ctx), P = Object.assign({}, P_BU, { S: -4 }), K = g.WTS_wd_res.lsConst(P);
      assert.rel(K.rwe, 0.354 * Math.exp(4), 1e-12); assert.strictEqual(K.Se, 0);
      let prev = 0;
      for (let e = -8; e <= 4; e += 0.25) {
        const f = g.WTS_wd_res.f(Math.pow(10, e), P);
        // f > 0 wherever E1 is representable (r_we²/4ητ < 700); below that the exponential underflows to 0 — never negative
        if (e >= -4) assert.ok(f > 0, 'f > 0 at τ = 1e' + e); else assert.ok(f >= 0, 'f ≥ 0 at τ = 1e' + e);
        assert.ok(f >= prev - 1e-15, 'monotone'); prev = f;
      }
    },
  },
  {
    name: 'RS12 prior history: none keeps p_wf = p̄r on a shut static start; steady / shutin reproduce the analytical superposition',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const g = G(ctx), C = ctxOf(ctx, 'buildup'), I = C.I, M = W.FIX.buildup;
      const mk = (prior) => g.WTS_wd_res.create(I, M, Object.assign({ mode: 'transient', F: C.F, prior: prior, qOp: 900 }, P_BU, { mu: null }));
      // none: zero rate at p̄r
      const Rn = mk({ kind: 'none' }); Rn.begin(0, 60);
      assert.ok(Math.abs(Rn.qAt(C.pr)) < 1e-9, 'q(p̄r) = 0 with no prior');
      // steady 720 h at 900: the past sum at t is u_D(900)·f(720 h + t)
      const Rs = mk({ kind: 'steady', t_h: 720 });
      const pS = C.pr - Rs.uD(900) * Rs.f(720 + 60 / 3600);
      Rs.begin(0, 60); assert.rel(Rs.qAt(pS), 900, 1e-7, 'steady prior holds q');
      // shutin: produced 100 h then shut 5 h; at Δt the rate solving a zero-drawdown change is 0 at the analytical p_ws
      const Rz = mk({ kind: 'shutin', t_h: 100, shut_h: 5 });
      const dtS = 120, pWs = C.pr - Rz.uD(900) * (Rz.f(105 + dtS / 3600) - Rz.f(5 + dtS / 3600));
      Rz.begin(0, dtS); assert.ok(Math.abs(Rz.qAt(pWs)) < 1e-6, 'q = 0 at the analytical shut-in pressure');
      assert.deepStrictEqual(Rz.prior.kind, 'shutin');
      // and the engine with a static start (prior none, shut) keeps p_wf at p̄r over 30 min (oil column in equilibrium)
      const sim = g.WTS_wd_engine.create(W.FIX.staticOil, { start: 'static', static: { kind: 'liquid', liquid: 'oil' }, reservoir: { prior: { kind: 'none' } } });
      assert.ok(sim.ok); sim.run(1800);
      assert.ok(Math.abs(sim.state.bottom.pwf - C.pr) < 15, 'p_wf ≈ p̄r: ' + sim.state.bottom.pwf.toFixed(1));
    },
  },
];
