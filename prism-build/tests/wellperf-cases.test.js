// Well Performance B, WP27 — cases and the depletion forecast (49-calc-wp-cases.js). docs/WELL-PERFORMANCE-PLAN.md §1.3 US18, §2.8,
// §8, §15.2, §16, §17.3 (wellperf-cases), D17. No published example is available (Q9): the tank models are checked against their own
// closed forms and the material balance identity (not a verification — they ship provisional, wellperf-validate gate).
//
// WCA1 cases: make (name, kind, scalar contract filter, tables), add (replace by name keeps the id, cap 20), rename, remove, diff
// WCA2 model(c) is the page's model: the case of the Oil example solves to the page's operating point exactly; compare Job (reference,
//      Δ %, the inputs that differ, curves), cancel; CSV
// WFC1 p̄r steps: the first step = the single solve exactly, later steps tracked; the rate falls with p̄r; lift needed at the first step
//      without a stable root; WC per step; abandonment pressure; NO_STEPS
// WFC2 gas tank: p/Z = (p_i/Z_i)(1 − G_p/G) at every row (closed form), p(0) = p_i, the wet-gas well-stream factor on the gas rate;
//      liquid-loading onset with MD · TVD = the solver's limiting depth at that p̄r (margin < 0 there, ≥ 0 the step before)
// WFC3 oil tank: N·E_t − F = 0 at every row (Havlena-Odeh identity), G_p = N_p·R_si above p_b, S_g ≤ S_gc → producing GOR = R_s,
//      the retained option holds R_p; Corey GOR rises once S_g > S_gc
// WFC4 explicit stepping converges at first order (12 / 24 / 48 steps); 24 steps ≤ 160 E on both fixtures; provisional label and
//      verified:false; the decline cross-check reads PRiSM_declineResults; CSV; cancel discards
'use strict';

const S = require('./_wellperf-shapes');

const WP = 'WP27';
const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const app = (ctx) => S.sharedApp(ctx);
const run = (job) => { let s, n = 0; do { s = job.step(); n++; } while (!s.done && n < 2000); return job.result(); };
const _memo = new Map();
const fc = (G, M, spec) => { const k = JSON.stringify([M, spec]); if (!_memo.has(k)) _memo.set(k, run(G.WTS_wp_forecast.job(M, spec))); return _memo.get(k); };
const GAS10 = { mode: 'tank', tank: { G_Bscf: 20 }, horizon_d: 3650, n: 24 };

module.exports = [
  {
    name: 'WCA1 cases: make / add (replace by name, cap 20) / rename / remove / diff',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, C = G.WTS_wp_cases;
      const bad = C.make({ name: '  ', scalars: { wp_pr: 3000 } });
      assert.ok(!bad.ok && /name/.test(bad.errors[0]), 'a name is needed');
      const m = C.make({ name: 'Base <b>case</b>', kind: 'base', scalars: { wp_pr: 3000, wp_wc: 30, wp_ip_J: 2, junk: 'x', wpv_x: 1 }, tables: { survey: [[0, 0], [8000, 8000]], tests: [{}] } });
      assert.ok(m.ok && m.case.name === 'Base b case /b', 'sanitised name: ' + m.case.name);
      assert.deepStrictEqual(Object.keys(m.case.scalars).sort(), ['wp_ip_J', 'wp_pr', 'wp_wc'], 'only the scalar contract');
      assert.ok(m.case.tables.survey && !m.case.tables.tests, 'tables without the tests');
      assert.strictEqual(m.case.kind, 'base');
      let L = C.add([], m.case).list;
      const r2 = C.add(L, Object.assign({}, m.case, { id: 'zz', scalars: { wp_pr: 2500 } }));
      assert.ok(r2.ok && r2.replaced && r2.list.length === 1 && r2.list[0].id === m.case.id && r2.list[0].scalars.wp_pr === 2500, 'replace by name keeps the id');
      L = r2.list;
      for (let i = 0; i < 19; i++) L = C.add(L, C.make({ name: 'c' + i, scalars: { wp_pr: 1000 + i } }).case).list;
      assert.strictEqual(L.length, 20);
      const full = C.add(L, C.make({ name: 'one more', scalars: { wp_pr: 1 } }).case);
      assert.ok(!full.ok && full.code === 'FULL', 'cap 20');
      const rn = C.rename(L, L[1].id, 'c5');
      assert.ok(!rn.ok, 'a duplicate name is refused');
      assert.strictEqual(C.rename(L, L[1].id, 'Renamed').list[1].name, 'Renamed');
      assert.strictEqual(C.remove(L, L[0].id).list.length, 19);
      const d = C.diff({ scalars: { wp_pr: 3000, wp_wc: 30, wp_ftype: 'oil' }, tables: { survey: [[0, 0]] } }, { scalars: { wp_pr: 3000.0000001, wp_wc: 40, wp_ftype: 'oil' }, tables: { survey: [[0, 0], [1, 1]] } });
      assert.deepStrictEqual(plain(d), { scalars: [{ id: 'wp_wc', a: 30, b: 40 }], tables: [{ key: 'survey', a: 1, b: 2 }] });
    },
  },
  {
    name: 'WCA2 model(c) = the page model (same operating point exactly); compare Job: reference, Δ %, inputs that differ, curves; cancel; CSV',
    wp: WP, opts: false,
    async run(_a, assert, ctx) {
      const A = app(ctx), G = A.win, C = G.WTS_wp_cases, SY = G.WTS_wp_system;
      if (G.__WP_MOCK) return assert.ok(true, 'mock installed in this app');
      S.resetWellPerf(A); G.WTS_wellperf_page.resetJobs();
      A.hook.nav('wellperf'); A.flush(30);
      A.click(A.find('[data-act="example"][data-ex="oil"]')); A.flush(30);
      const ui = G.WTS_wellperf_page.ui(), raw = G.WTS_wp_model.readRaw(), tables = {};
      C.TABLES.forEach((k) => { if (raw.rec[k] !== undefined) tables[k] = raw.rec[k]; });
      const c1 = C.make({ name: 'Base', kind: 'base', scalars: ui.liveScalars(), tables, R: ui.ST.R }).case;
      const M1 = C.model(c1);
      assert.ok(M1 && Object.isFrozen(M1), 'a frozen model');
      const R1 = SY.solve(M1);
      assert.strictEqual(R1.op.q, ui.ST.R.op.q, 'the case solves to the page operating point exactly');
      assert.strictEqual(c1.summary.q, ui.ST.R.op.q, 'summary at save');
      const sc2 = Object.assign({}, c1.scalars, { wp_bean: 40 });
      const c2 = C.make({ name: 'Bean 40', kind: 'proposed', scalars: sc2, tables }).case;
      const r = run(C.compare([c1, c2]));
      assert.ok(r.ok && r.ref === c1.id && r.rows.length === 2, JSON.stringify(plain(r.errors)));
      assert.ok(r.rows[1].R.q > r.rows[0].R.q && Math.abs(r.rows[1].dqPct - 100 * (r.rows[1].R.q / r.rows[0].R.q - 1)) < 1e-9, 'Δ %');
      assert.deepStrictEqual(plain(r.rows[1].diff.scalars.map((d) => d.id)), ['wp_bean'], 'only the bean differs');
      assert.ok(r.rows.every((x) => x.curves.ipr.length > 5 && x.curves.vlp.length > 5), 'curves per case');
      assert.ok(r.evals > 0 && r.evals <= 2 * 24, 'one cold solve per case: ' + r.evals + ' E');
      const csv = C.csv(r).split('\n');
      assert.ok(/reference: Base/.test(csv[0]) && csv.length === 4 && /^Bean 40,proposed,/.test(csv[3]) && /wp_bean/.test(csv[3]), 'CSV');
      const j = C.compare([c1, c2]); j.step(); j.cancel();
      assert.ok(j.result().cancelled, 'cancel');
      assert.strictEqual(run(C.compare([])).code, 'NO_CASES');
    },
  },
  {
    name: 'WFC1 p̄r steps: first = the single solve, later tracked, rate falls with p̄r, lift needed, WC per step, abandonment, NO_STEPS',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, SY = G.WTS_wp_system;
      const r = fc(G, S.FIX.oilWell, { mode: 'steps', steps: [3000, 2850, 2700, 2400, 2100], pAband: 2100 });
      assert.ok(r.ok && r.mode === 'steps' && r.rows.length === 5, JSON.stringify(plain(r.errors)));
      const R0 = SY.solve(S.FIX.oilWell);
      assert.ok(r.rows[0].q === R0.op.q && r.rows[0].pwf === R0.pwf && !r.rows[0].tracked, 'step 1 = the single solve exactly');
      assert.ok(r.rows[1].tracked && r.rows[2].tracked, 'later steps tracked');
      assert.ok(r.rows[1].q < r.rows[0].q && r.rows[2].q < r.rows[1].q, 'the rate falls with p̄r');
      const M2 = S.FIX.oilWell; M2.res.pr = 2700; const R2 = SY.solve(M2);
      assert.ok(Math.abs(r.rows[2].q / R2.op.q - 1) < 1e-3, 'a tracked step = a cold solve within the root tolerance: ' + r.rows[2].q + ' / ' + R2.op.q);
      assert.ok(r.events.lift && r.events.lift.i === 3 && r.rows[3].phase === 'dead', 'lift needed at p̄r 2,400: ' + JSON.stringify(plain(r.events.lift)));
      assert.ok(r.events.abandon && r.events.abandon.i === 4, 'abandonment pressure');
      const w = fc(G, S.FIX.oilWell, { mode: 'steps', steps: [{ pr: 3000 }, { pr: 3000, wc: 50 }] });
      assert.ok(w.rows[1].q < w.rows[0].q && w.rows[1].wc === 50, 'water cut per step');
      const M5 = S.FIX.oilWell; M5.fluid.wc = 0.5; assert.ok(Math.abs(w.rows[1].q / SY.solve(M5).op.q - 1) < 1e-3, 'WC 50 % step = that solve');
      assert.strictEqual(run(G.WTS_wp_forecast.job(S.FIX.oilWell, { mode: 'steps', steps: [] })).code, 'NO_STEPS');
      assert.strictEqual(r.verified, null, 'steps mode is the solver alone (no tank model)');
    },
  },
  {
    name: 'WFC2 gas tank: p/Z line at every row, p(0) = p_i, wet-gas factor; loading onset MD · TVD = the solver\'s limiting depth',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, FC = G.WTS_wp_forecast, SY = G.WTS_wp_system;
      const T = FC.tank(S.FIX.gasWell, { G_Bscf: 20 });
      assert.ok(T.ok && T.kind === 'gas' && T.verified === false && /provisional/.test(T.provisional), 'tank');
      assert.ok(Math.abs(T.pAt(0) - 5000) < 1e-3, 'p(0) = p_i');
      assert.ok(T.wellGasFactor > 1 && T.wellGasFactor < 1.05, 'the condensate vapour equivalent: ' + T.wellGasFactor);
      [1e6, 5e6, 1e7, 1.5e7].forEach((gp) => { const p = T.pAt(gp), a = T.at(p); assert.ok(Math.abs(a.poz / (T.piz * (1 - gp / T.G)) - 1) < 1e-6, 'p/Z closed form at ' + gp); });
      assert.ok(T.pAt(1e6) > T.pAt(5e6), 'monotone');
      const r = fc(G, S.FIX.gasWell, GAS10);
      assert.ok(r.ok && r.rows.length >= 12, JSON.stringify(plain(r.errors)));
      r.rows.forEach((x) => { assert.ok(Math.abs(x.mb.poz / (T.piz * (1 - x.Gp / T.G)) - 1) < 1e-6, 'row ' + x.i + ' on the p/Z line'); });
      for (let i = 1; i < r.rows.length; i++) {
        const prev = r.rows[i - 1], x = r.rows[i];
        assert.ok(Math.abs(x.Gp - prev.Gp - prev.qg * T.wellGasFactor * r.dt) < 1e-6 * Math.max(1, x.Gp), 'explicit step: G_p += q_g·f·Δt');
      }
      const L = r.events.loading, k = L.i;
      assert.ok(L && isFinite(L.md) && isFinite(L.tvd) && r.rows[k].loadingMargin < 0 && r.rows[k - 1].loadingMargin >= 0, 'onset at the first negative margin');
      const M = S.FIX.gasWell; M.res.pr = r.rows[k].pr; const R = SY.solve(M);
      assert.ok(Math.abs(R.loading.limitingMd - L.md) < 1 && Math.abs(R.loading.limitingTvd - L.tvd) < 1 && R.loading.margin < 0, 'MD ' + L.md + ' / ' + R.loading.limitingMd);
      assert.ok(r.events.lift && r.rows[r.rows.length - 1].phase === 'dead', 'the well stops within ten years');
      assert.ok(r.totals.produced > 0 && r.tank.recovery > 0.3 && r.tank.recovery < 0.9, 'recovery ' + r.tank.recovery);
      assert.ok(!FC.tank(S.FIX.gasWell, {}).ok && FC.tank(S.FIX.gasWell, { G_Bscf: 1, cum0: 5e6 }).errors.length, 'G needed; cumulative needs p_i');
    },
  },
  {
    name: 'WFC3 oil tank: Havlena-Odeh N·E_t = F at every row; G_p = N_p·R_si above p_b; S_g ≤ S_gc → GOR = R_s; retained holds R_p',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, FC = G.WTS_wp_forecast;
      const T = FC.tank(S.FIX.oilWell, { N_MMstb: 20 });
      assert.ok(T.ok && T.kind === 'oil' && T.verified === false && T.gas === 'corey' && T.pb > 2400 && T.pb < 2600, 'tank, p_b ' + T.pb);
      // above the bubble point: one step of oil, the compressibility balance N·(B_o − B_oi + c_eff Δp) = N_p·B_o, gas = N_p·R_si
      const a = T.step({ p: T.pi, cum: 0, gp: 0, wp: 0 }, 50000, 0);
      assert.ok(a.p < T.pi && a.p > T.pb && Math.abs(a.gp - 50000 * T.Rsi) < 1e-6, 'undersaturated step: p ' + a.p);
      const t1 = T.at(a.p, a.cum, a.gp, 0);
      assert.ok(Math.abs(t1.N * t1.Et - t1.F) < 1e-6 * t1.F, 'identity above p_b');
      const r = fc(G, S.FIX.oilWell, { mode: 'tank', tank: { N_MMstb: 20 }, horizon_d: 3650, n: 24 });
      assert.ok(r.ok && r.rows.length > 3 && r.provisional, JSON.stringify(plain(r.errors)));
      r.rows.forEach((x) => { if (x.mb) assert.ok(Math.abs(20e6 * x.mb.Et - x.mb.F) < 1e-5 * Math.max(1, x.mb.F), 'row ' + x.i + ': N·E_t − F = ' + (20e6 * x.mb.Et - x.mb.F)); });
      const below = r.rows.filter((x) => x.pr < T.pb && x.sg <= T.sgc && x.i > 0);
      assert.ok(below.length && below.every((x) => x.gor == null || x.gor <= T.Rsi + 1e-6), 'free gas below S_gc stays: GOR ≤ R_si');
      // retained: R_p held at the model GOR → the free gas supports the pressure
      const rr = fc(G, S.FIX.oilWell, { mode: 'tank', tank: { N_MMstb: 2, gas: 'retained' }, horizon_d: 365, n: 6 });
      assert.ok(rr.ok && rr.rows.length >= 2 && rr.rows.every((x) => x.mb == null || Math.abs(2e6 * x.mb.Et - x.mb.F) < 1e-5 * Math.max(1, x.mb.F)), 'retained identity');
      // Corey: on a small tank the saturation passes S_gc and the producing GOR rises above R_si
      const T2 = FC.tank(S.FIX.oilWell, { N_MMstb: 2 });
      let st = { p: T2.pi, cum: 0, gp: 0, wp: 0 }, maxGor = 0;
      for (let i = 0; i < 8; i++) { const n = T2.step(st, 60000, 20000); if (!n) break; st = n; maxGor = Math.max(maxGor, n.gor || 0); }
      assert.ok(st.sg > T2.sgc && maxGor > T2.Rsi * 1.5, 'GOR rises once S_g > S_gc: ' + maxGor);
      assert.ok(!FC.tank(S.FIX.oilWell, {}).ok, 'N needed');
    },
  },
  {
    name: 'WFC4 first-order convergence (12 / 24 / 48 steps), 24 steps ≤ 160 E, provisional, decline cross-check, CSV, cancel',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, FC = G.WTS_wp_forecast;
      const c = [12, 24, 48].map((n) => fc(G, S.FIX.gasWell, { mode: 'tank', tank: { G_Bscf: 20 }, horizon_d: 1825, n }).totals.produced);
      const e1 = Math.abs(c[0] - c[1]), e2 = Math.abs(c[1] - c[2]);
      assert.ok(e2 < 0.6 * e1 && e2 / c[2] < 0.025, 'first order: ' + c.map((x) => (x / 1e6).toFixed(3)).join(' / ') + ' Bscf');
      const g = fc(G, S.FIX.gasWell, GAS10), o = fc(G, S.FIX.oilWell, { mode: 'tank', tank: { N_MMstb: 20 }, horizon_d: 3650, n: 24 });
      assert.ok(g.evals <= 160 && o.evals <= 160, 'budget: gas ' + g.evals + ' E, oil ' + o.evals + ' E');
      assert.ok(g.verified === false && g.warnings.some((w) => w.code === 'PROVISIONAL' && /provisional — not verified against a published example/.test(w.msg)), 'provisional label');
      assert.ok(FC.DEFAULT_MODE === 'steps', 'the tank is never the default mode (D17)');
      // decline cross-check
      const keep = G.PRiSM_declineResults;
      G.PRiSM_declineResults = () => ({ ok: true, modelName: 'Arps hyperbolic', eur: 2e7, remaining: 1e7, units: { vol: 'Mscf' } });
      try {
        const d = run(FC.job(S.FIX.gasWell, { mode: 'tank', tank: { G_Bscf: 20 }, horizon_d: 365, n: 3 }));
        assert.ok(d.decline && d.decline.ok && d.decline.remaining === 1e7 && Math.abs(d.decline.ratio - d.totals.produced / 1e7) < 1e-12, 'decline cross-check');
      } finally { G.PRiSM_declineResults = keep; }
      const csv = FC.csv(g).split('\n');
      assert.ok(/tank, gas, provisional/.test(csv[0]) && csv.length === g.rows.length + 2 && /,dead,/.test(csv[csv.length - 1]), 'CSV');
      const j = FC.job(S.FIX.gasWell, GAS10); j.step(); j.cancel();
      assert.ok(j.result().cancelled && j.result().rows.length === 0, 'cancel discards');
    },
  },
];
