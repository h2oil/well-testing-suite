// Well Performance VLP tuning (WP17, increment A2) — docs/WELL-PERFORMANCE-PLAN.md §3.7, §5.2, §5.3, §5.4, §17.2, D10.
//
// WT1 H_L clamp: inside the one marcher H_L' = clamp(m_h·H_L, λ_L, 1) — scaled, floored at the no-slip holdup, capped at 1
// WT2 gradient rebuild: ρ_s from the scaled holdup, gradEl = ρ_s·sin θ / 144, gradF re-evaluated at the scaled holdup (the
//     correlation's friction hook) and × m_f, grad = (gradEl + gradF)/(1 − Ek); the flowline is never tuned
// WT3 bounds and flags: m_h 0.8–1.25 and m_f 0.7–1.5 (or o.bounds), TUNE_AT_BOUND / TUNE_HL_RANGE / TUNE_F_RANGE / TUNE_RESIDUAL,
//     a self-consistent synthetic set recovers its multipliers, the gradient without holdup refuses (INSENSITIVE), refusals
// WT4 m_h-only rule (D10): tests spanning < 2:1 in rate fit m_h only (TUNE_MH_ONLY) even when m_f is asked; ≥ 2:1 fits both by
//     default; one test → m_h; the tuned multipliers flow into the solve, pwf / IPR from a test (§5.3) and QC_VLP after tuning (§5.4)
// WT5 correlation matrix: 2 × 2, symmetric, unit diagonal; from the LM covariance when both are fitted (separable on a 4:1 set),
//     from the Jacobian of both when m_h alone is fitted (|ρ| > 0.9 → "the two multipliers cannot be separated with these tests");
//     the Job twin gives the same answer as tune()
// WT6 the page, step ⑥ on the real engines: Tune → KPI chips, flags, residual table, correlation cells, tuned / untuned traverses
//     with the m_h / m_f rails (live re-march, release writes the control and re-solves), the objective plot; Apply → the
//     multipliers in the model, the VLP KPI chip, the untuned outflow / traverse / operating point on the system and traverse
//     plots, the verdict and the case row; Reset → 1 / 1; autosave and no NaN
'use strict';

const S = require('./_wellperf-shapes');

const WP = 'WP17';
const PATM = 14.696;
const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const app = (ctx) => S.sharedApp(ctx);
const FAST = { scan: false, profiles: false };          // engine tests that do not read the objective scan or the plot profiles
const codes = (r) => (r.flags || []).map((f) => f.code);
// a test whose gauge is the answer of the correlation at multipliers (mh, mf): a self-consistent synthetic test
function synth(G, M, id, qo, mh, mf, corr) {
  const t = Object.assign(S.FIX.test1, { id, q_o: qo, q_w: qo * 3 / 7, q_g: qo * 0.5 });
  const c = G.WTS_wp_match.compare(M, t, [corr || 'bb'], { mult: { hl: mh, f: mf }, profiles: false });
  t.gauge_psia = c.rows[0].pCalc;
  return t;
}
// one short vertical piece of FIX.oilWell (10 ft at 4,000 ft MD) marched in one step, at multipliers m
function piece(G, mult, corr) {
  const M = S.FIX.oilWell, F = G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F }), W = G.WTS_wp_well.build(M.well, { res: M.res, fluidType: 'oil' });
  const segs = G.WTS_wp_well.segmentsFor(W, { from: 4010, toMd: 4000 });
  const o = { from: 'top', p0: 300, corr: corr || 'bb', stepFt: 10, refine: false };
  if (mult) o.mult = mult;
  const tr = G.WTS_wp_vlp.traverse(F, { ok: true, segments: segs, tAt: W.tAt, nodes: W.nodes }, { qo: 700, qw: 300, qg_Mscfd: 350 }, o);
  return tr.profile[tr.profile.length - 1];
}

module.exports = [
  {
    name: 'WT1 H_L clamp: H_L\' = clamp(m_h·H_L, λ_L, 1) inside the marcher — scaled, floored at the no-slip holdup λ_L, capped at 1',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win;
      ['bb', 'hb'].forEach((corr) => {
        const u = piece(G, null, corr), lam = u.vsl / (u.vsl + u.vsg);
        assert.ok(u.hl > lam && u.hl < 1, corr + ': slip holdup between λ_L and 1 (' + u.hl + ', λ ' + lam + ')');
        const a = piece(G, { hl: 1.1, f: 1 }, corr);
        assert.rel(a.hl, Math.min(1, 1.1 * u.hl), 2e-3, corr + ': m_h 1.1 scales the holdup');
        const lo = piece(G, { hl: 0.05, f: 1 }, corr);
        assert.rel(lo.hl, lam, 2e-3, corr + ': floored at the no-slip holdup λ_L');
        assert.ok(lo.hl >= lam * (1 - 2e-3), corr + ': never below λ_L');
        const hi = piece(G, { hl: 5, f: 1 }, corr);
        assert.near(hi.hl, 1, 1e-12, corr + ': capped at 1');
        const one = piece(G, { hl: 1, f: 1 }, corr);
        assert.near(one.p, u.p, 1e-9, corr + ': multipliers 1 / 1 = the published correlation exactly');
      });
    },
  },
  {
    name: 'WT2 gradient rebuild: ρ_s from the scaled holdup, gradEl = ρ_s/144 (vertical), friction re-evaluated at the scaled holdup and × m_f, grad split consistent; the flowline is not tuned',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win;
      const u = piece(G, null), t = piece(G, { hl: 1.15, f: 1 }), f = piece(G, { hl: 1, f: 1.3 }), b = piece(G, { hl: 1.15, f: 1.3 });
      [u, t, f, b].forEach((r, i) => assert.rel(r.gradEl, r.rhoS / 144, 1e-9, 'row ' + i + ': gradEl = ρ_s·sin 90° / 144'));
      assert.ok(t.rhoS > u.rhoS * 1.02, 'more holdup → denser mixture: ' + u.rhoS + ' → ' + t.rhoS);
      // ρ_s is linear in H_L at the same pressure: ρ_s = ρ_G + (ρ_L − ρ_G)·H_L — two holdups give the same line
      const k = (t.rhoS - u.rhoS) / (t.hl - u.hl), rG = u.rhoS - k * u.hl;
      const lo = piece(G, { hl: 0.85, f: 1 });
      assert.rel(lo.rhoS, rG + k * lo.hl, 2e-3, 'ρ_s rebuilt from the scaled holdup (linear in H_L)');
      assert.rel(f.gradF, 1.3 * u.gradF, 2e-3, 'm_f scales the friction gradient');
      assert.near(f.gradEl, u.gradEl, 1e-3 * u.gradEl, 'm_f leaves the elevation term');
      assert.ok(Math.abs(t.gradF / u.gradF - 1) > 1e-3, 'the friction term is re-evaluated at the scaled holdup (Beggs & Brill S(y))');
      assert.rel(b.gradF, 1.3 * t.gradF, 3e-3, 'both: friction at the scaled holdup × m_f');
      [u, t, f, b].forEach((r, i) => assert.ok(r.gradAcc >= -1e-9 && r.gradAcc < 0.05 * (r.gradEl + r.gradF), 'row ' + i + ': acceleration share small and ≥ 0'));
      // the flowline is never multiplied: the surface boundary of the system is the same with and without multipliers
      const M = S.FIX.oilWell, Mt = S.FIX.oilWell; Mt.system.mult = { hl: 1.2, f: 1.4 };
      const b0 = G.WTS_wp_system.boundary(M, 900), b1 = G.WTS_wp_system.boundary(Mt, 900);
      assert.ok(b0.ok && b1.ok); assert.near(b1.thp, b0.thp, 1e-9, 'THP needed by choke + flowline unchanged by the VLP multipliers');
    },
  },
  {
    name: 'WT3 bounds and flags: synthetic sets recover their multipliers; beyond the bounds → TUNE_AT_BOUND, TUNE_HL_RANGE, TUNE_RESIDUAL; o.bounds; m_f outside 0.9–1.1 → TUNE_F_RANGE; INSENSITIVE and refusals',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, Mt = G.WTS_wp_match, M = S.FIX.oilWell;
      assert.deepStrictEqual(plain(Mt.TUNE.bounds), { hl: [0.8, 1.25], f: [0.7, 1.5] }, 'D10 bounds');
      assert.deepStrictEqual(plain(Mt.TUNE.flag), [0.9, 1.1]);
      // mild: one test made at m_h 1.05 → recovered, no range flag, residual ~ 0
      const r1 = Mt.tune(M, [synth(G, M, 'S1', 700, 1.05, 1)], 'bb');
      assert.ok(r1.ok, JSON.stringify(plain(r1.errors)));
      assert.near(r1.mult.hl, 1.05, 2e-4, 'm_h recovered'); assert.strictEqual(r1.mult.f, 1, 'm_f held');
      assert.ok(r1.rms.tuned < 0.05 && r1.rms.untuned > 20, 'RMS ' + r1.rms.untuned + ' → ' + r1.rms.tuned);
      assert.ok(!codes(r1).includes('TUNE_HL_RANGE') && !codes(r1).includes('TUNE_AT_BOUND') && !codes(r1).includes('TUNE_RESIDUAL'), 'no flag: ' + codes(r1));
      assert.deepStrictEqual(plain(r1.adopt), { wp_mult_hl: +r1.mult.hl.toPrecision(6), wp_mult_f: 1 }, 'adopt map for the page controls');
      assert.ok(r1.residuals.length === 1 && Math.abs(r1.residuals[0].gauge.tvd - 7900) < 1e-6, 'residual row with gauge MD / TVD');
      assert.ok(r1.scan.length === Mt.TUNE.scan && r1.scan.every((s) => s.hl >= 0.8 - 1e-12 && s.hl <= 1.25 + 1e-12), 'objective scan over the bounds');
      const iMin = r1.scan.reduce((a, s, i) => (s.rms < r1.scan[a].rms ? i : a), 0);
      assert.ok(Math.abs(r1.scan[iMin].hl - 1.05) <= (1.25 - 0.8) / (Mt.TUNE.scan - 1), 'scan minimum next to the fit');
      assert.ok(r1.profiles[0].tuned.length > 10 && r1.profiles[0].untuned.length > 10, 'tuned and untuned profiles for the plot');
      // beyond the bound: made at 0.5 → stops at the lower bound 0.8, flags
      const r2 = Mt.tune(M, [synth(G, M, 'S2', 700, 0.5, 1)], 'bb', FAST);
      assert.ok(r2.ok); assert.near(r2.mult.hl, 0.8, 1e-9, 'at the lower bound');
      ['TUNE_AT_BOUND', 'TUNE_HL_RANGE'].forEach((c) => assert.ok(codes(r2).includes(c), c + ' in ' + codes(r2)));
      // two tests at one rate whose gauges are 16 % apart: no pair of multipliers fits both → TUNE_RESIDUAL
      const g0 = synth(G, M, 'R1', 700, 1.05, 1), g1 = Object.assign({}, g0, { id: 'R2', gauge_psia: g0.gauge_psia * 0.92 }); g0.gauge_psia *= 1.08;
      const r2b = Mt.tune(M, [g0, g1], 'bb', FAST);
      assert.ok(r2b.ok && codes(r2b).includes('TUNE_RESIDUAL'), 'inconsistent tests: ' + codes(r2b));
      assert.ok(r2b.rms.tunedPct > 5, 'still > 5 % RMS after tuning');
      assert.ok(r2.flags.filter((f) => f.code === 'TUNE_HL_RANGE')[0].sev === 'warn');
      // o.bounds respected
      const r3 = Mt.tune(M, [synth(G, M, 'S3', 700, 1.05, 1)], 'bb', Object.assign({ bounds: { hl: [0.9, 1.02] } }, FAST));
      assert.near(r3.mult.hl, 1.02, 1e-9, 'custom upper bound'); assert.deepStrictEqual(plain(r3.bounds.hl), [0.9, 1.02]);
      // three tests over 4:1 made at m_h 1.08, m_f 1.25 → both recovered; m_f outside 0.9–1.1 flagged
      const ts = [synth(G, M, 'A', 300, 1.08, 1.25), synth(G, M, 'B', 700, 1.08, 1.25), synth(G, M, 'C', 1200, 1.08, 1.25)];
      const r4 = Mt.tune(M, ts, 'bb', FAST);
      assert.ok(r4.ok && plain(r4.free).join() === 'hl,f', 'both free on a 4:1 set: ' + plain(r4.free));
      assert.near(r4.mult.hl, 1.08, 1e-3); assert.near(r4.mult.f, 1.25, 5e-3);
      assert.ok(codes(r4).includes('TUNE_F_RANGE') && !codes(r4).includes('TUNE_HL_RANGE'), 'm_f flagged: ' + codes(r4));
      assert.ok(r4.lm.converged && r4.lm.iterations >= 1 && r4.lm.nEval > 3, 'LM converged');
      // provisional label for an unverified correlation (D17)
      const r5 = Mt.tune(M, [synth(G, M, 'H', 700, 1.05, 1, 'hb')], 'hb', FAST);
      assert.ok(r5.ok && r5.verified === false && /provisional/.test(r5.provisional) && codes(r5).includes('PROVISIONAL'));
      assert.near(r5.mult.hl, 1.05, 5e-4, 'Hagedorn & Brown holdup tuned through its own friction hook');
      // refusals
      assert.strictEqual(Mt.tune(M, [], 'bb', FAST).code, 'NO_TEST');
      const ng = S.FIX.test1; ng.gauge_psia = null;
      assert.strictEqual(Mt.tune(M, [ng], 'bb', FAST).code, 'NO_GAUGE');
      assert.strictEqual(Mt.tune(M, [S.FIX.test1], 'nope', FAST).code, 'UNKNOWN_CORR');
      const gw = S.FIX.gasWell, gt = Object.assign(S.FIX.test1, { q_o: 0, q_w: 0, q_g: 7000, gaugeMd: 9000, gauge_psia: 2000, thp_psig: 1500, bean64: null });
      const rg = Mt.tune(gw, [gt], 'gasTZ', FAST);
      assert.strictEqual(rg.code, 'INSENSITIVE', 'dry-gas method has no holdup to scale: ' + JSON.stringify(plain(rg.errors)));
      const lmSave = G.PRiSM_lm; G.PRiSM_lm = undefined;
      try { assert.strictEqual(Mt.tune(M, [S.FIX.test1], 'bb', FAST).code, 'MISSING_ENGINE'); } finally { G.PRiSM_lm = lmSave; }
    },
  },
  {
    name: 'WT4 m_h-only rule (D10): < 2:1 → m_h only (TUNE_MH_ONLY) even when m_f is asked; ≥ 2:1 → both; one test → m_h; tuned multipliers flow into the solve, pwf / IPR from a test and QC_VLP after tuning',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, Mt = G.WTS_wp_match, M = S.FIX.oilWell;
      ['WTS_wp_match.tune'].forEach((n) => assert.ok((G.__WP_STUBS || []).indexOf(n) === -1, n + ' left __WP_STUBS'));
      const narrow = [synth(G, M, 'N1', 600, 1.1, 1), synth(G, M, 'N2', 750, 1.1, 1)];
      const a = Mt.tune(M, narrow, 'bb', Object.assign({ free: ['hl', 'f'] }, FAST));
      assert.ok(a.ok && plain(a.free).join() === 'hl' && plain(a.freeAsked).join() === 'hl,f', 'm_f refused on a ' + a.rateSpan.toFixed(2) + ':1 set');
      assert.ok(a.rateSpan < 2 && codes(a).includes('TUNE_MH_ONLY'));
      assert.match(a.flags.filter((f) => f.code === 'TUNE_MH_ONLY')[0].msg, /below 2:1/);
      assert.near(a.mult.hl, 1.1, 5e-4); assert.strictEqual(a.mult.f, 1);
      const wide = [synth(G, M, 'W1', 350, 1.1, 1), synth(G, M, 'W2', 800, 1.1, 1)];
      const b = Mt.tune(M, wide, 'bb', FAST);
      assert.ok(b.rateSpan >= 2 && plain(b.free).join() === 'hl,f' && !codes(b).includes('TUNE_MH_ONLY'), 'auto: both on ' + b.rateSpan.toFixed(2) + ':1');
      const c = Mt.tune(M, wide, 'bb', Object.assign({ free: ['hl'] }, FAST));
      assert.ok(plain(c.free).join() === 'hl', 'm_h only when asked');
      const d = Mt.tune(M, [wide[0]], 'bb', Object.assign({ free: ['hl', 'f'] }, FAST));
      assert.ok(plain(d.free).join() === 'hl' && codes(d).includes('TUNE_MH_ONLY'), 'one test: m_h only');
      // the multipliers flow into the solve and the back-calculations (§5.3), QC_VLP after tuning (§5.4)
      const t = synth(G, M, 'Q1', 700, 1.08, 1), r = Mt.tune(M, [t], 'bb', FAST);
      const Mt2 = S.FIX.oilWell; Mt2.system.mult = { hl: r.mult.hl, f: r.mult.f };
      const R0 = G.WTS_wp_system.solve(M), R1 = G.WTS_wp_system.solve(Mt2);
      assert.ok(R0.ok && R1.ok && R1.op.q < R0.op.q - 5, 'more holdup → heavier column → less rate: ' + R0.op.q.toFixed(0) + ' → ' + R1.op.q.toFixed(0));
      const tGauge = Object.assign({}, t, { gaugeMd: 4000 });
      tGauge.gauge_psia = Mt.compare(M, tGauge, ['bb'], { mult: { hl: r.mult.hl, f: 1 }, profiles: false }).rows[0].pCalc;
      const p0 = Mt.pwfFromTest(M, tGauge), p1 = Mt.pwfFromTest(Mt2, tGauge);
      assert.ok(p0.ok && p1.ok && p0.mult === null && plain(p1.mult).hl === r.mult.hl, 'pwf reports the multipliers it used');
      assert.ok(p1.pwf > p0.pwf + 5, 'tuned VLP marches a heavier column from the gauge to the mid-perforations');
      const ip = Mt.iprFromTest(Mt2, tGauge, 'pr');
      assert.ok(ip.ok && ip.mult && Math.abs(ip.mult.hl - r.mult.hl) < 1e-12 && Math.abs(ip.pwf - p1.pwf) < 1e-9, 'IPR from a test with the tuned VLP');
      // a test 8 % off the untuned correlation: QC_VLP warns untuned, passes after tuning
      const off = synth(G, M, 'Q2', 700, 1.12, 1);
      const qU = G.WTS_wp_qc(M, [off], { corrKeys: ['bb'] }).rows[0].checks.filter((x) => x.code === 'QC_VLP')[0];
      const rt = Mt.tune(M, [off], 'bb', FAST); const Mt3 = S.FIX.oilWell; Mt3.system.mult = rt.mult;
      const qT = G.WTS_wp_qc(Mt3, [off], { corrKeys: ['bb'] }).rows[0].checks.filter((x) => x.code === 'QC_VLP')[0];
      assert.strictEqual(qU.st, 'warn', 'untuned: ' + qU.msg);
      assert.strictEqual(qT.st, 'ok', 'after tuning: ' + qT.msg); assert.match(qT.msg, /after tuning/);
    },
  },
  {
    name: 'WT5 correlation matrix: 2 × 2 symmetric unit diagonal; LM covariance when both are fitted (separable on 4:1), Jacobian of both when m_h alone (|ρ| > 0.9 → cannot be separated); one test |ρ| = 1; the Job twin = tune()',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, Mt = G.WTS_wp_match, M = S.FIX.oilWell;
      const chk = (r, tag) => {
        const m = r.corrMatrix;
        assert.ok(Array.isArray(m) && m.length === 2 && m[0].length === 2, tag + ': 2 × 2');
        assert.strictEqual(m[0][0], 1); assert.strictEqual(m[1][1], 1); assert.strictEqual(m[0][1], m[1][0], tag + ': symmetric');
        assert.ok(Math.abs(m[0][1]) <= 1 + 1e-12 && m[0][1] === r.rho, tag + ': |ρ| ≤ 1');
      };
      const wide = [synth(G, M, 'A', 300, 1.06, 1.15), synth(G, M, 'B', 700, 1.06, 1.15), synth(G, M, 'C', 1200, 1.06, 1.15)];
      const a = Mt.tune(M, wide, 'bb', FAST);
      chk(a, 'both'); assert.strictEqual(a.corrBasis, 'lm');
      assert.ok(Math.abs(a.rho) < Mt.TUNE.rho && a.separable === true && !codes(a).includes('TUNE_INSEPARABLE'), 'separable on 4:1: ρ ' + a.rho);
      const narrow = [synth(G, M, 'N1', 650, 1.06, 1), synth(G, M, 'N2', 720, 1.06, 1)];
      const b = Mt.tune(M, narrow, 'bb', FAST);
      chk(b, 'm_h only'); assert.strictEqual(b.corrBasis, 'jacobian');
      assert.ok(Math.abs(b.rho) > Mt.TUNE.rho && b.separable === false, 'nearly collinear: ρ ' + b.rho);
      const f = b.flags.filter((x) => x.code === 'TUNE_INSEPARABLE')[0];
      assert.ok(f && f.sev === 'info' && f.msg.indexOf('the two multipliers cannot be separated with these tests') !== -1, 'message: ' + (f && f.msg));
      const one = Mt.tune(M, [narrow[0]], 'bb', FAST);
      chk(one, 'one test'); assert.near(Math.abs(one.rho), 1, 1e-9, 'one gauge: the 2 × 2 normal matrix is singular');
      // the Job twin (one stage per step for PRiSM_autoInterp.drive) gives the same answer as tune()
      const job = Mt.tuneJob(M, wide, 'bb'); let s, n = 0, labels = [];
      do { s = job.step(); labels.push(s.label); n++; } while (!s.done && n < 20);
      const jr = job.result();
      assert.ok(s.done && n === 5, 'one stage per step: ' + n);
      assert.deepStrictEqual(plain(jr.mult), plain(a.mult), 'Job twin = tune()');
      assert.ok(labels.some((l) => /Levenberg-Marquardt/.test(l)), 'stage labels for the progress bar');
      const jc = Mt.tuneJob(M, wide, 'bb'); jc.step(); jc.cancel(); const cr = jc.result();
      assert.ok(cr && (cr.ok === false || cr.ok === true), 'cancel leaves a result object');
    },
  },
  {
    name: 'WT6 page step ⑥: Tune → KPI chips, flags, residuals, ρ cells, tuned / untuned traverses with m_h / m_f rails (live re-march, release commits), objective; Apply → model, KPI, untuned curves and op on the system / traverse plots, verdict, case row; Reset; no NaN',
    wp: WP, opts: false,
    async run(_a, assert, ctx) {
      const A = app(ctx), G = A.win, txt = (e) => String(e && e.textContent || '').replace(/\s+/g, ' ').trim(), BAD = /NaN|undefined|Infinity|\[object Object\]/;
      if (G.__WP_MOCK) return assert.ok(true, 'mock installed in this app');
      S.resetWellPerf(A);
      A.hook.nav('wellperf'); A.flush(30);
      G.WTS_wellperf_page.resetJobs(); G.WTS_wellperf_page.budget(5000);
      A.click(A.find('[data-act="example"][data-ex="oil"]')); A.flush(30);
      A.click(A.find('#wp_steps [data-step="6"]')); A.flush(5);
      assert.ok(A.el('wpv_tcorr') && A.el('wpv_tfree') && A.find('[data-act="tune"]'), 'tuning controls in step ⑥');
      assert.match(txt(A.find('label[for="wp_mult_hl"]').parentNode), /fitted to the tests in ⑥ Match/, 'step ⑤ hint points to the tuning');
      A.click(A.find('[data-act="tune"]'));
      for (let i = 0; i < 60 && !(G.WTS_wellperf_page.state().tune); i++) await A.flushAsync(1);
      const P = G.WTS_wellperf_page.state(), r = P.tune;
      assert.ok(r && r.ok, 'tune result: ' + JSON.stringify(plain(r && r.errors)));
      const res = A.el('wp_tuneres'), t = txt(res);
      assert.match(t, /VLP tuning — Beggs & Brill/);
      assert.strictEqual(A.findAll('#wp_tunekpi .kpi').length, 6, 'six KPI chips');
      assert.match(txt(A.el('wp_tunekpi')), /Holdup m_h/); assert.match(txt(A.el('wp_tunekpi')), /RMS error/);
      assert.ok(A.findAll('#wp_tuneres table.dtable').length === 2, 'residual table + correlation cells');
      assert.ok(!BAD.test(t), 'clean: ' + (t.match(BAD) || [''])[0]);
      const cv = A.el('wp_cv_tune'), sp = cv && cv._wp && cv._wp.spec;
      assert.ok(sp && sp.series.some((s) => /untuned/.test(s.label)) && sp.series.some((s) => /tuned \(fitted\)/.test(s.label)), 'tuned and untuned traverses');
      assert.ok(sp.y.invert && /TVD/.test(sp.y.label) && sp.markers.some((m) => /gauge/.test(m.label)), 'depth axis + gauge marker');
      assert.deepStrictEqual(plain(sp.handles.map((h) => h.key)), ['hl', 'f'], 'm_h and m_f rails');
      const ob = A.el('wp_cv_tobj')._wp.spec;
      assert.ok(ob.series[0].pts.length >= 5 && ob.bands.length === 1 && ob.markers[0].label === 'LM optimum', 'objective plot');
      assert.match(txt(A.el('wp_tunebox')), /^$|tuning/i);
      // Apply → controls, one solve, KPI chip, untuned reference on the plots, verdict, case row, provenance chip
      const q0 = G.WTS_state.wellperf.op.q;
      A.click(A.find('[data-act="tuneapply"]')); A.flush(30);
      assert.rel(+A.el('wp_mult_hl').value, r.mult.hl, 1e-5, 'm_h control'); assert.rel(+A.el('wp_mult_f').value, r.mult.f, 1e-9, 'm_f control');
      const st = G.WTS_state.wellperf;
      assert.ok(st.mult && Math.abs(st.mult.hl - r.mult.hl) < 1e-5 && st.tune.applied === true, 'state: multipliers applied');
      assert.ok(Math.abs(st.op.q - q0) > 1, 'the solve uses the multipliers: ' + q0.toFixed(0) + ' → ' + st.op.q.toFixed(0));
      assert.ok(A.findAll('#wp_kpis .kpi').some((k) => /VLP m_h \/ m_f/.test(txt(k))), 'VLP tuning KPI chip'); assert.ok(A.el('wp_kpis').className.indexOf('wp-k11') !== -1, 'eleven chips: six columns');
      const sys = A.el('wp_cv_sys')._wp.spec;
      assert.ok(sys.series.some((s) => s.key === 'vlpU' && s.pts.length > 3), 'untuned outflow on the system plot');
      assert.ok(sys.markers.some((m) => m.untuned === true), 'untuned operating point');
      assert.ok(st.untuned && st.untuned.op && Math.abs(st.untuned.op.q - q0) / q0 < 0.03, 'untuned op ≈ the untuned solve: ' + (st.untuned && st.untuned.op.q) + ' vs ' + q0);
      assert.ok(A.el('wp_cv_tr')._wp.spec.series.some((s) => s.key === 'pu'), 'untuned pressure traverse');
      assert.match(txt(A.el('wp_verd')), /Tuned VLP|VLP multipliers outside/);
      assert.match(txt(A.el('wp_case')), /VLP multipliers.*tuned to/);
      assert.match(txt(A.el('wp_sch_cap')), /VLP tuned: m_h [\d.]+, m_f [\d.]+ \(RMS [\d.]+ psi at the gauge, 7,900 ft MD · 7,900 ft TVD\)/, 'schematic caption');
      assert.ok(A.find('label[for="wp_mult_hl"] .wp-chip'), 'provenance chip');
      // drag the m_h rail: live re-march, then release writes the control and re-solves
      G.WTS_wellperf_page.tuneHandle('hl', 1.2, 'move'); A.flush(2);
      assert.ok(P.tunePrev && P.tunePrev.hl === 1.2 && P.tunePrev.profiles.length === 1 && P.tunePrev.profiles[0].profile.length > 10, 'live preview');
      assert.ok(A.el('wp_cv_tune')._wp.spec.series.some((s) => /^m_h 1\.2(00)?, m_f/.test(s.label)), 'preview curve on the plot');
      assert.match(txt(A.el('wp_tunekpi')), /Plot m_h \/ m_f/);
      G.WTS_wellperf_page.tuneHandle('hl', 1.2, 'end'); A.flush(30);
      assert.strictEqual(+A.el('wp_mult_hl').value, 1.2, 'release writes the control');
      assert.near(G.WTS_state.wellperf.mult.hl, 1.2, 1e-12, 'and the well re-solves with it');
      assert.ok(A.findAll('#wp_kpis .kpi').some((k) => /VLP m_h \/ m_f/.test(txt(k)) && /st-warn/.test(k.className)), '1.2 is outside 0.9–1.1: warning chip');
      // autosave carries the multipliers
      A.flush(1200);
      const saved = JSON.parse(A.storage.getItem('wts_page_wellperf') || '{}');
      assert.strictEqual(String(saved.f && saved.f.wp_mult_hl), '1.2', 'autosaved');
      // Reset → 1 / 1, no tuning chip, untuned curves gone
      A.click(A.find('[data-act="tunereset"]')); A.flush(30);
      assert.strictEqual(+A.el('wp_mult_hl').value, 1); assert.strictEqual(+A.el('wp_mult_f').value, 1);
      assert.ok(!A.findAll('#wp_kpis .kpi').some((k) => /VLP m_h \/ m_f/.test(txt(k))), 'no tuning chip when untuned');
      assert.ok(!A.el('wp_cv_sys')._wp.spec.series.some((s) => s.key === 'vlpU'), 'no untuned overlay');
      assert.rel(G.WTS_state.wellperf.op.q, q0, 1e-6, 'back to the untuned answer');
      assert.ok(!BAD.test(txt(A.el('wp_res'))) && !BAD.test(txt(res)), 'no NaN');
      assert.deepStrictEqual(A.consoleErrors ? A.consoleErrors().filter((e) => !/self-test|WARN/.test(e)) : [], [], 'no console errors');
    },
  },
];
