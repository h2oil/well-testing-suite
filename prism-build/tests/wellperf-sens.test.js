// Well Performance sensitivity — docs/WELL-PERFORMANCE-PLAN.md §3.6, §6, §15.2, §16, §17.1 (WP6).
//
// WSE1 matrix: full factorial, duplicates dropped, validity ranges, unknown keys, ≤ 4 variables / ≤ 1,000 cases, a tubing catalogue
//      key; vars() applicability by fluid type and inflow model; suggest() inside the range with the model value; stubs gone
// WSE2 Job via PRiSM_autoInterp.drive: SHAPE.Job, progress and labels, rates monotone in p̄r and bean, inflow / outflow families,
//      the §16 budget (10 cases ≤ 80 E) on FIX.oilWell
// WSE3 cancel within one case: drive rejects CANCELLED, the result is discarded; a direct cancel() too
// WSE4 the base case equals the single solve exactly (q, pwf, THP); a tracked case equals a cold solve within the root tolerance;
//      a list without the model value says so; a variable that does not apply refuses the Job
// WSE5 table and CSV (field units, quoting, family curves in long form); the page: Run sensitivity on the real engines fills the
//      table, WTS_state.wellperf.sens, the rate-vs-parameter plot, the system-plot families and the CSV bundle; Metric entries are
//      converted to field units
'use strict';

const S = require('./_wellperf-shapes');

const WP = 'WP6';
const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const app = (ctx) => S.sharedApp(ctx);
const run = (job) => { let s, n = 0; do { s = job.step(); n++; } while (!s.done && n < 500); return job.result(); };
const _memo = new Map();
const sens = (G, M, vars, o) => { const k = JSON.stringify([M, vars, o || null]); if (!_memo.has(k)) _memo.set(k, run(G.WTS_wp_sens.job(M, vars, o))); return _memo.get(k); };
const WC10 = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90];

module.exports = [
  {
    name: 'WSE1 matrix: full factorial, duplicates dropped, ranges and unknown keys refused, ≤ 4 variables / ≤ 1,000 cases, tubing catalogue key; vars() and suggest(); WP6 stubs gone',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, SN = G.WTS_wp_sens;
      S.STUBS.WP6.forEach((n) => assert.ok((G.__WP_STUBS || []).indexOf(n) === -1, n + ' left __WP_STUBS'));
      let m = SN.matrix([{ key: 'wc', values: [0, 20, '20', 40] }]);
      assert.ok(m.ok && m.cases.length === 3, 'duplicates dropped: ' + JSON.stringify(plain(m)));
      assert.deepStrictEqual(plain(m.cases.map((c) => c.values.wc)), [0, 20, 40]);
      m = SN.matrix([{ key: 'wc', values: [0, 50] }, { key: 'pr', values: [2000, 2500, 3000] }, { key: 'bean', values: [16, 32] }]);
      assert.strictEqual(m.cases.length, 12, 'full factorial 2 × 3 × 2');
      const keys = new Set(m.cases.map((c) => JSON.stringify(c.values)));
      assert.strictEqual(keys.size, 12, 'every combination once');
      assert.ok(!SN.matrix([{ key: 'nope', values: [1] }]).ok, 'unknown key refused');
      const r1 = SN.matrix([{ key: 'wc', values: [-5, 120] }]);
      assert.ok(!r1.ok && /outside/.test(r1.errors.join(' ')), 'out of range refused: ' + r1.errors.join('; '));
      assert.ok(!SN.matrix([{ key: 'wc', values: [1] }, { key: 'wc', values: [2] }]).ok, 'a variable twice refused');
      assert.ok(!SN.matrix([{ key: 'wc', values: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }]).ok, 'more than 10 values refused (Appendix B)');
      const five = ['pr', 'wc', 'gor', 'bean', 'psep'].map((k, i) => ({ key: k, values: [[2000], [10], [500], [32], [100]][i] }));
      assert.ok(!SN.matrix(five).ok, 'more than 4 variables refused');
      const big = SN.matrix(['pr', 'wc', 'bean', 'psep'].map((k) => ({ key: k, values: Array.from({ length: 10 }, (_, i) => ({ pr: 2000 + 100 * i, wc: i * 5, bean: 16 + 4 * i, psep: 50 + 10 * i })[k]) })));
      assert.ok(!big.ok && /1000 cases/.test(big.errors.join(' ')), '10 000 cases refused');
      const tk = G.WTS_tubulars.tubing.find((t) => t.od === 3.5) || G.WTS_tubulars.tubing[0];
      const mt = SN.matrix([{ key: 'tubingId', values: [2.441, tk.key] }]);
      assert.ok(mt.ok && mt.cases[1].values.tubingId === tk.id && mt.cases[1].label === tk.key, 'tubing catalogue key → its ID: ' + JSON.stringify(plain(mt.cases)));
      // vars() and suggest()
      const vo = SN.vars(S.FIX.oilWell), vg = SN.vars(S.FIX.gasWell), by = (l, k) => l.find((x) => x.key === k);
      assert.ok(by(vo, 'wc').applicable && by(vo, 'J').applicable && !by(vo, 'wgr').applicable && !by(vo, 'skin').applicable, 'oil: WC, J yes; WGR, skin (pi model) no');
      assert.ok(by(vg, 'wgr').applicable && !by(vg, 'wc').applicable && !by(vg, 'J').applicable, 'gas: WGR yes; WC, J no');
      assert.strictEqual(by(vo, 'wc').base, 30, 'WC base in %');
      assert.strictEqual(by(vo, 'pr').base, S.FIX.oilWell.res.pr, 'p̄r base');
      ['pr', 'wc', 'bean', 'thp', 'gor', 'psep', 'J', 'tubingId'].forEach((k) => {
        const sg = SN.suggest(S.FIX.oilWell, k, 5), d = SN.VARS[k];
        assert.ok(sg.ok && sg.values.length >= 2 && sg.values.length <= 10 && sg.values.every((v) => v >= d.lo && v <= d.hi), k + ' suggestions in range: ' + JSON.stringify(plain(sg.values)));
        assert.ok(SN.matrix([{ key: k, values: sg.values }]).ok, k + ' suggestions form a valid matrix');
      });
      assert.ok(SN.suggest(S.FIX.oilWell, 'pr').values.indexOf(S.FIX.oilWell.res.pr) !== -1, 'the model p̄r is among the suggestions');
    },
  },
  {
    name: 'WSE2 Job via PRiSM_autoInterp.drive: SHAPE.Job, progress, monotone rates in p̄r and bean, inflow / outflow families, 10 cases ≤ 80 E (§16)',
    wp: WP, opts: false,
    async run(_a, assert, ctx) {
      const A = app(ctx), G = A.win, SN = G.WTS_wp_sens, AI = G.PRiSM_autoInterp;
      const M = S.FIX.oilWell, job = SN.job(M, [{ key: 'pr', values: [3200, 2600, 3000, 2800] }]);
      const sh = S.checkShape('Job', job);
      assert.ok(sh.ok, sh.errors.join('; '));
      assert.ok(AI && typeof AI.drive === 'function', 'PRiSM_autoInterp.drive present');
      const prog = [];
      const p = AI.drive(job, { onProgress: (pr, l) => prog.push([pr, l]) });
      for (let i = 0; i < 40 && !job.done(); i++) await A.flushAsync(1);
      const r = await p;
      assert.ok(r.ok && r.cases.length === 4, 'drive resolved with every case: ' + JSON.stringify(plain(r.errors)));
      assert.ok(prog.length === 4 && prog.every((x, i) => i === 0 || x[0] >= prog[i - 1][0]) && prog[3][0] === 1, 'progress monotone to 1: ' + JSON.stringify(prog));
      assert.match(prog[0][1], /Reservoir pressure/);
      const qs = r.cases.map((c) => c.R.q);
      assert.deepStrictEqual(plain(r.cases.map((c) => c.values.pr)), [2600, 2800, 3000, 3200], 'cases sorted by value');
      assert.ok(qs.every((q, i) => q > 0 && (i === 0 || q > qs[i - 1])), 'rate rises with p̄r: ' + qs.join(', '));
      assert.strictEqual(r.family, 'ipr');
      r.cases.forEach((c) => {
        assert.ok(c.R.curve.length > 20, 'one IPR per value');
        assert.near(c.R.curve[0].p, c.values.pr, 1e-6, 'IPR starts at p̄r');
        ['q', 'qo', 'qw', 'qg', 'pwf', 'thp', 'tht'].forEach((k) => assert.ok(isFinite(c.R[k]), k + ' finite'));
      });
      // bean: outflow family through the operating point; budget on 10 WC cases
      const rb = sens(G, M, [{ key: 'bean', values: [16, 24, 32, 40, 48] }]);
      const qb = rb.cases.map((c) => c.R.q);
      assert.ok(qb.every((q, i) => i === 0 || q > qb[i - 1]), 'rate rises with the bean: ' + qb.join(', '));
      assert.strictEqual(rb.family, 'vlp');
      rb.cases.forEach((c) => {
        assert.ok(c.R.curve.length >= 4, 'one outflow curve per value');
        const k = c.R.curve.find((pt) => Math.abs(pt.q - c.R.op.q) < 1e-9);
        assert.ok(k && Math.abs(k.p - c.R.op.p) < 1e-9 || !c.R.tracked, 'the family passes through the operating point');
      });
      const rw = sens(G, M, [{ key: 'wc', values: WC10 }]);
      assert.ok(rw.evals <= 80, '10 WC cases within 80 E: ' + rw.evals);
      assert.ok(rw.cases.filter((c) => c.R.tracked).length >= 5, 'neighbouring cases are tracking solves');
      const qw = rw.cases.filter((c) => c.R.ok).map((c) => c.R.q);
      assert.ok(qw.length >= 5 && qw.every((q, i) => i === 0 || q < qw[i - 1]), 'rate falls with water cut: ' + qw.join(', '));
      rw.cases.filter((c) => !c.R.ok).forEach((c) => assert.ok(c.R.code && c.R.error, 'a non-flowing case carries its code and reason'));
    },
  },
  {
    name: 'WSE3 cancel within one case: drive rejects CANCELLED and the result is discarded; a direct cancel() stops the Job',
    wp: WP, opts: false,
    async run(_a, assert, ctx) {
      const A = app(ctx), G = A.win, SN = G.WTS_wp_sens, AI = G.PRiSM_autoInterp;
      const job = SN.job(S.FIX.oilWell, [{ key: 'bean', values: [16, 24, 32, 40, 48, 56] }]);
      let steps = 0, err = null, res = null;
      const p = AI.drive(job, { shouldCancel: () => steps >= 2, onProgress: () => { steps++; } }).then((r) => { res = r; }, (e) => { err = e; });
      for (let i = 0; i < 20 && !err && !res; i++) await A.flushAsync(1);
      await p;
      assert.ok(err && err.code === 'CANCELLED' && !res, 'drive rejected CANCELLED: ' + JSON.stringify(err));
      assert.strictEqual(steps, 2, 'stopped after the case in progress');
      const r = job.result();
      assert.ok(r.cancelled && r.code === 'CANCELLED' && r.cases.length === 0, 'results discarded');
      assert.ok(job.done(), 'done after cancel');
      const j2 = SN.job(S.FIX.oilWell, [{ key: 'psep', values: [50, 100, 150] }]);
      j2.step(); j2.cancel();
      const s2 = j2.step();
      assert.ok(s2.done && j2.result().cancelled, 'direct cancel: the next step ends the Job');
    },
  },
  {
    name: 'WSE4 base case = the single solve exactly; a tracked case = a cold solve within the root tolerance; no base case is reported; a variable that does not apply refuses the Job',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, SN = G.WTS_wp_sens, SY = G.WTS_wp_system;
      const M = S.FIX.oilWell, R = SY.solve(M), r = sens(G, M, [{ key: 'wc', values: WC10 }]);
      const b = r.cases.find((c) => c.values.wc === 30);
      assert.ok(r.base.inList && r.base.value === 30 && r.start === 30, 'the model WC is the start case');
      assert.strictEqual(b.R.q, R.op.q, 'q identical');
      assert.strictEqual(b.R.pwf, R.pwf, 'pwf identical');
      assert.strictEqual(b.R.thp, R.surface.thp_psig, 'THP identical');
      assert.ok(!b.R.tracked && b.R.qs && b.R.qs.q === R.qs.q, 'full solve with q_s');
      // a tracked case against its own cold solve
      const c = r.cases.find((x) => x.values.wc === 40), Mc = S.FIX.oilWell; Mc.fluid.wc = 0.4;
      const Rc = SY.solve(Mc);
      assert.ok(c.R.tracked, 'WC 40 % tracked from 30 %');
      assert.ok(Math.abs(c.R.q - Rc.op.q) <= Math.max(1e-3 * Rc.op.q, 0.5), 'tracked = cold within the root tolerance: ' + c.R.q + ' vs ' + Rc.op.q);
      assert.ok(Math.abs(c.R.pwf - Rc.pwf) < 0.5, 'pwf within 0.5 psi');
      // gas well: the base case too
      const Mg = S.FIX.gasWell, Rg = SY.solve(Mg), rg = sens(G, Mg, [{ key: 'bean', values: [16, Mg.surface.choke.bean64, 40] }]);
      assert.strictEqual(rg.cases.find((x) => x.values.bean === Mg.surface.choke.bean64).R.q, Rg.op.q, 'gas base case identical');
      // no base case
      const rn = sens(G, M, [{ key: 'pr', values: [2900, 3100] }]);
      assert.ok(!rn.base.inList && rn.warnings.some((w) => w.code === 'NO_BASE_CASE'), 'no base case reported');
      // not applicable
      const jn = SN.job(M, [{ key: 'skin', values: [0, 5] }]);
      const rr = run(jn);
      assert.ok(!rr.ok && rr.code === 'NOT_APPLICABLE' && /Darcy/.test(rr.errors[0]), 'skin needs a Darcy model: ' + JSON.stringify(plain(rr.errors)));
      // A2 (WP16): two variables run (wellperf-sens2); B (WP27): three and four variables run (wellperf-tornado)
      const j3 = run(SN.job(M, [{ key: 'wc', values: [0, 50] }, { key: 'pr', values: [2800, 3000] }, { key: 'gor', values: [500] }]));
      assert.ok(j3.ok && j3.nd && j3.cases.length === 4, 'three variables: the matrix (B)');
    },
  },
  {
    name: 'WSE5 table and CSV (field units, families); the page runs the sensitivity on the real engines: table, WTS_state.wellperf.sens, plots, CSV bundle; Metric entries converted to field units',
    wp: WP, opts: false,
    async run(_a, assert, ctx) {
      const A = app(ctx), G = A.win, SN = G.WTS_wp_sens, txt = (e) => String(e && e.textContent || '').replace(/\s+/g, ' ').trim(), BAD = /NaN|undefined|Infinity|\[object Object\]/;
      const r = sens(G, S.FIX.oilWell, [{ key: 'wc', values: WC10 }]);
      const t = SN.table(r);
      assert.strictEqual(t.rows.length, 10);
      assert.match(t.head[0], /Water cut \(%\)/); assert.match(t.head[1], /STB\/d/);
      ['pwf (psia)', 'THP (psig)', 'THT (°F)', 'Stable', 'Loading margin (%)'].forEach((h) => assert.ok(t.head.indexOf(h) !== -1, 'column ' + h));
      const csv = SN.csv(r), lines = csv.split('\n');
      assert.match(lines[0], /^Well Performance sensitivity: Water cut \(%\)/);
      assert.ok(lines.indexOf(t.head.join(',')) !== -1 || lines.some((l) => /^"?Water cut \(%\)"?,Rate/.test(l)), 'header row');
      assert.ok(/Family curves \(outflow/.test(csv), 'families in long form');
      const row30 = lines.find((l) => /^30,/.test(l));
      assert.ok(row30 && Math.abs(+row30.split(',')[1] - r.cases[3].R.q) < 1e-3, 'the 30 % row carries the rate');
      assert.ok(lines.some((l) => /^70,.*,"?The outflow curve/.test(l) || /^70,.*NO_FLOW|^70,.*does not flow/.test(l)), 'a non-flowing row carries its reason');
      assert.strictEqual(SN.csv({}), '', 'no result → empty CSV');
      // the page
      if (G.__WP_MOCK) return assert.ok(true, 'mock installed in this app');
      S.resetWellPerf(A);
      A.hook.nav('wellperf'); A.flush(30);
      A.click(A.find('[data-act="example"][data-ex="oil"]')); A.flush(30);
      const sel = A.el('wpv_svar');
      assert.ok(sel && /Reservoir pressure/.test(txt(sel)) && /Tubing ID/.test(txt(sel)), 'every A1 variable offered');
      sel.value = 'pr'; A.fire(sel, 'change'); A.flush(5);
      assert.match(A.el('wpv_svals').value, /\d/, 'suggested values filled');
      A.el('wpv_svals').value = '2800 3000 3200';
      A.click(A.find('[data-act="sens"]'));
      for (let i = 0; i < 40 && !(G.WTS_state.wellperf && G.WTS_state.wellperf.sens); i++) await A.flushAsync(1);
      const st = G.WTS_state.wellperf;
      assert.ok(st.sens && st.sens.ok && st.sens.cases.length === 3 && st.sens.key === 'pr', 'WTS_state.wellperf.sens: ' + JSON.stringify(plain(st.sens && st.sens.errors)));
      const tb = txt(A.el('wp_senstbl'));
      assert.match(tb, /Reservoir pressure/); assert.match(tb, /3 of 3 cases flow/); assert.match(tb, /\(model\)/);
      assert.ok(!BAD.test(tb), 'table clean');
      const cvS = A.el('wp_cv_sys');
      assert.ok(cvS._wp && cvS._wp.spec.series.filter((s) => /^sens/.test(s.key)).length === 3, 'three inflow families on the system plot');
      const cvT = A.el('wp_cv_tr');
      assert.ok(cvT._wp && cvT._wp.spec.series.find((s) => s.key === 'q').pts.length === 3, 'rate vs p̄r plot');
      const bundle = G.WTS_wellperf_page.csv();
      assert.match(bundle, /Sensitivity: Reservoir pressure/); assert.match(bundle, /Sensitivity family curves \(inflow\)/);
      // Metric: values typed in bar reach the engine in psia
      const U = G.WTS_units;
      U.setSystem('metric'); A.flush(30);
      try {
        const s2 = A.el('wpv_svar'); s2.value = 'pr'; A.fire(s2, 'change'); A.flush(5);
        const kv = [2900, 3100].map((x) => Math.round(U.convertCategory(x, 'pressure', 'imperial', 'metric')));
        A.el('wpv_svals').value = kv.join(' ');
        G.WTS_state.wellperf.sens = null;
        A.click(A.find('[data-act="sens"]'));
        for (let i = 0; i < 40 && !(G.WTS_state.wellperf && G.WTS_state.wellperf.sens); i++) await A.flushAsync(1);
        const sv = G.WTS_state.wellperf.sens;
        assert.ok(sv && sv.cases.length === 2, 'metric run done');
        assert.near(sv.cases[0].values.pr, U.convertCategory(kv[0], 'pressure', 'metric', 'imperial'), 1e-6, 'metric entry → psia in the engine');
        assert.ok(sv.cases.every((c) => c.R.ok), 'both metric cases flow');
        const lab = U.CATEGORIES.pressure.metric.label, t2 = txt(A.el('wp_senstbl'));
        assert.ok(t2.indexOf('(' + lab + ')') !== -1 && !/psia/.test(t2), 'table in metric units: ' + t2.slice(0, 160));
      } finally { U.setSystem('imperial'); A.flush(30); }
      assert.strictEqual(A.consoleErrors().length, 0, 'no console errors');
    },
  },
];
