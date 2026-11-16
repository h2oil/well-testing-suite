// Well Performance 4.6.1 follow-up (docs/WELL-PERFORMANCE-PLAN.md §18.4) — the open items of A1 / A2, on the REAL engines.
//
// WFU1 stale study results: a 1-variable sensitivity is marked "previous inputs — re-run" on any input change, also when the page
//      waits for the Solve button (a slow device: marked at once, no solve), stays marked after Solve, and the mark clears on a re-run
// WFU2 two-variable sensitivity (heat map) and the tornado of the Studies card: marked on an input change, cleared on a re-run
// WFU3 all used tests (RMS): WTS_wp_match.compare keeps each test's march per correlation (perTest[].profile) and the test
//      information (perTestInfo: gauge, THP) — the ranking is unchanged; the page draws one traverse plot per test (test picker),
//      measured gauge against every correlation, the legend gives that test's error
// WFU4 the shared (p, T) property tables of the marcher (4.6.1 speed-up) return exactly the cold values: a solve, its repeat and a
//      solve after other fluids filled the registry are equal on every number (Object.is)
'use strict';

const S = require('./_wellperf-shapes');

const WP = 'WP-461';
const txt = (e) => String(e && e.textContent || '').replace(/\s+/g, ' ').trim();
const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const app = (ctx) => S.sharedApp(ctx);
const P = (A) => A.win.WTS_wellperf_page;
const STALE = /previous inputs/i;
async function wait(A, cond, n) { for (let i = 0; i < (n || 300) && !cond(); i++) await A.flushAsync(1); return cond(); }
function page(ctx, ex) {
  const A = app(ctx);
  if (A.win.__WP_MOCK) throw new Error('the test double must not be installed in this app');
  S.resetWellPerf(A); P(A).resetJobs(); P(A).budget(1e6);
  A.hook.nav('wellperf'); A.flush(30);
  if (ex) { A.click(A.find('[data-act="example"][data-ex="' + ex + '"]')); A.flush(30); }
  return A;
}
async function runSens(A, k1, v1, k2, v2) {
  A.select('wpv_svar', k1); A.el('wpv_svals').value = v1;
  A.select('wpv_svar2', k2 || ''); if (k2) A.el('wpv_svals2').value = v2;
  const before = P(A).state().sens;
  A.click(A.find('[data-act="sens"]'));
  return wait(A, () => { const s = P(A).state().sens; return s && s !== before && s.cases; });
}
// deep equality with Object.is on every number
function same(a, b, path, out) {
  if (out.length > 5) return out;
  if (typeof a === 'number' || typeof b === 'number') { if (!Object.is(a, b)) out.push(path + ': ' + a + ' vs ' + b); return out; }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') { if (a !== b && typeof a !== 'function') out.push(path + ': ' + String(a).slice(0, 40) + ' vs ' + String(b).slice(0, 40)); return out; }
  const ka = Object.keys(a).filter((k) => typeof a[k] !== 'function' && k !== 'ms'), kb = Object.keys(b).filter((k) => typeof b[k] !== 'function' && k !== 'ms');
  if (ka.join() !== kb.join()) { out.push(path + ': keys ' + ka.join() + ' vs ' + kb.join()); return out; }
  ka.forEach((k) => same(a[k], b[k], path + '.' + k, out));
  return out;
}

module.exports = [
  {
    name: 'WFU1 1-variable sensitivity: marked "previous inputs — re-run" on an input change, at once when the page waits for Solve (no solve), still after Solve; a re-run clears it',
    wp: WP, opts: false,
    async run(_a, assert, ctx) {
      const A = page(ctx, 'oil');
      assert.ok(await runSens(A, 'wc', '20 30 40'), 'sensitivity ran');
      assert.ok(!P(A).state().sens.stale && !STALE.test(txt(A.el('wp_senstbl'))), 'fresh result: no chip');
      // a normal input change (the page solves at once)
      A.change('wp_pr', '3200'); A.flush(10);
      assert.ok(P(A).state().sens.stale, 'stale after an input change');
      assert.match(txt(A.el('wp_senstbl')), /previous inputs — re-run the sensitivity/);
      assert.ok(A.el('wp_cv_sys')._wp.spec.series.filter((s) => /^sens/.test(s.key)).every((s) => s.stale === true), 'family faint on the system plot');
      // re-run → cleared
      assert.ok(await runSens(A, 'wc', '20 30 40'), 'sensitivity re-run');
      assert.ok(!P(A).state().sens.stale && !STALE.test(txt(A.el('wp_senstbl'))), 're-run clears the mark');
      // a slow device: the page waits for the Solve button — the result is marked at once, without a solve
      P(A).budget(-1);
      A.change('wp_pr', '3150'); A.flush(10);                    // this solve finds the device slow
      assert.ok(P(A).state().slow, 'Solve-button mode');
      assert.ok(await runSens(A, 'wc', '20 30 40'), 'sensitivity run in Solve-button mode');
      assert.ok(!P(A).state().sens.stale, 'fresh');
      const calcs = P(A).calcs(), solved = P(A).state().R;
      A.change('wp_pr', '3100'); A.flush(10);
      assert.ok(P(A).state().stale && P(A).state().R === solved, 'no solve: the page waits for Solve');
      assert.ok(P(A).calcs() > calcs, 'the change reached the page');
      assert.ok(P(A).state().sens.stale, 'stale at once (4.6.1: before, only after the next solve)');
      assert.match(txt(A.el('wp_senstbl')), /previous inputs — re-run the sensitivity/, 'chip shown without a solve');
      A.click('wp_solve'); A.flush(10);
      assert.ok(P(A).state().sens.stale && STALE.test(txt(A.el('wp_senstbl'))), 'still stale after Solve');
      P(A).budget(1e6);
      assert.ok(await runSens(A, 'wc', '20 30 40'), 're-run');
      assert.ok(!P(A).state().sens.stale && !STALE.test(txt(A.el('wp_senstbl'))), 'cleared');
      // an input back to the run's value is not stale (the mark compares the model, not a change counter)
      const pr0 = A.el('wp_pr').value;
      A.change('wp_pr', '2900'); A.flush(10); assert.ok(P(A).state().sens.stale, 'stale');
      A.change('wp_pr', pr0); A.flush(10); assert.ok(!P(A).state().sens.stale, 'same model again: not stale');
      assert.strictEqual(A.consoleErrors().length, 0, 'no console errors');
    },
  },
  {
    name: 'WFU2 two-variable sensitivity (heat map) and the Studies tornado: marked on an input change (also in Solve-button mode), cleared on a re-run',
    wp: WP, opts: false,
    async run(_a, assert, ctx) {
      const A = page(ctx, 'oil'), G = A.win, SX = () => G.WTS_wellperf_ext.studies.state();
      assert.ok(await runSens(A, 'wc', '20 40', 'pr', '2800 3000'), 'two-variable sensitivity ran');
      assert.ok(P(A).state().sens.two && A.find('#wp_senstbl table.wp-heat'), 'heat map drawn');
      assert.ok(!STALE.test(txt(A.el('wp_senstbl'))), 'no chip');
      A.change('wp_gor', '550'); A.flush(10);
      assert.ok(P(A).state().sens.stale && /previous inputs — re-run the sensitivity/.test(txt(A.el('wp_senstbl'))), 'heat map marked');
      assert.ok(await runSens(A, 'wc', '20 40', 'pr', '2800 3000'), 're-run');
      assert.ok(!P(A).state().sens.stale && !STALE.test(txt(A.el('wp_senstbl'))), 'cleared');
      // tornado (Studies card)
      A.click(A.find('#wpb_tabs [data-k="torn"]')); A.flush(5);
      const t0 = SX().torn;
      A.click(A.find('[data-act="b27torn"]'));
      assert.ok(await wait(A, () => SX().torn && SX().torn !== t0), 'tornado ran');
      assert.ok(!STALE.test(txt(A.el('wpb_kpi'))), 'fresh tornado: no chip');
      A.change('wp_gor', '600'); A.flush(10);
      assert.match(txt(A.el('wpb_kpi')), /previous inputs — re-run/, 'tornado marked');
      assert.ok(A.find('#wpb_body .wpb-stale'), 'tornado table dimmed');
      // Solve-button mode: marked at once
      A.click(A.find('[data-act="b27torn"]'));
      const t1 = SX().torn;
      assert.ok(await wait(A, () => SX().torn !== t1 || !STALE.test(txt(A.el('wpb_kpi')))), 'tornado re-run');
      assert.ok(!STALE.test(txt(A.el('wpb_kpi'))), 're-run clears the tornado mark');
      P(A).budget(-1); A.change('wp_gor', '620'); A.flush(10);
      assert.ok(P(A).state().slow, 'Solve-button mode');
      A.click(A.find('[data-act="b27torn"]'));
      const t2 = SX().torn;
      assert.ok(await wait(A, () => SX().torn !== t2), 'tornado in Solve-button mode');
      const solved = P(A).state().R;
      A.change('wp_gor', '640'); A.flush(10);
      assert.ok(P(A).state().R === solved, 'no solve');
      assert.match(txt(A.el('wpb_kpi')), /previous inputs — re-run/, 'tornado marked at once without a solve');
      P(A).budget(1e6);
      assert.strictEqual(A.consoleErrors().length, 0, 'no console errors');
    },
  },
  {
    name: 'WFU3 all used tests (RMS): per-test marches kept (ranking unchanged), one traverse plot per test with its gauge and THP, test picker, error per correlation in the legend',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const A = page(ctx, 'oil'), G = A.win, MT = G.WTS_wp_match;
      // engine: the multi-test result carries each test's march, and the RMS rows are those of the single-test runs
      const M = G.WTS_wellperf_page.state().M, t1 = plain(M.tests[0]), t2 = Object.assign({}, t1, { id: 'T2', gauge_psia: t1.gauge_psia - 40 });
      const keys = ['bb', 'hb', 'gray'];
      const c = MT.compare(M, [t1, t2], keys), c1 = MT.compare(M, t1, keys), c2 = MT.compare(M, t2, keys);
      assert.ok(c.ok && c1.ok && c2.ok, 'compare runs');
      assert.deepStrictEqual(plain(c.perTestInfo.map((x) => x.id)), ['T1', 'T2'], 'perTestInfo in test order');
      assert.ok(Object.is(c.perTestInfo[0].gauge.p, c1.gauge.p) && Object.is(c.perTestInfo[1].thp, c2.thp), 'gauge / THP of each test');
      c.rows.forEach((r) => {
        const r1 = c1.rows.find((x) => x.corr === r.corr), r2 = c2.rows.find((x) => x.corr === r.corr);
        assert.ok(Object.is(r.perTest[0].pCalc, r1.pCalc) && Object.is(r.perTest[1].pCalc, r2.pCalc), r.corr + ': per-test pressures = the single-test runs');
        assert.deepStrictEqual(plain(r.perTest[0].profile), plain(r1.profile), r.corr + ': test 1 march = the single-test traverse');
        assert.deepStrictEqual(plain(r.perTest[1].profile), plain(r2.profile), r.corr + ': test 2 march');
        const rms = Math.sqrt((r1.err * r1.err + r2.err * r2.err) / 2);
        assert.ok(Math.abs(r.err - rms) <= 1e-9 * Math.max(1, rms), r.corr + ': RMS unchanged');
      });
      // page: two tests, all used tests
      const tests = plain(G.WTS_wp_model.read().tests); tests.push(Object.assign({}, tests[0], { id: 'T2', date: '2026-11-03', gauge_psia: tests[0].gauge_psia - 40 }));
      G.WTS_wp_model.write({ tests }); A.flush(30);
      A.click(A.find('#wp_steps [data-step="6"]')); A.flush(2);
      A.el('wpv_mtest').value = 'all';
      A.click(A.find('[data-act="match"]')); A.flush(10);
      const st = G.WTS_state.wellperf.match;
      assert.ok(st.all && st.compare.ok && st.compare.perTestInfo.length === 2, 'all-tests comparison');
      const picks = A.findAll('#wp_mtrav [data-mtrav]');
      assert.deepStrictEqual(picks.map((b) => txt(b)), ['T1', 'T2'], 'a picker button per test');
      let sp = A.el('wp_cv_match')._wp.spec;
      assert.ok(sp.series.length >= 3 && sp.series.every((s) => s.pts.length > 10), 'a traverse per correlation (was an empty plot): ' + sp.series.length);
      assert.ok(sp.series.every((s) => /[+−-]?\d+(\.\d)? %$/.test(s.label)), 'legend carries the test error: ' + sp.series.map((s) => s.label).join(' | '));
      const gm = sp.markers.find((m) => /^Gauge/.test(m.label));
      assert.ok(gm && /T1/.test(gm.label) && sp.markers.some((m) => m.label === 'THP'), 'gauge (T1) and THP markers');
      const g1 = gm.x;
      assert.match(txt(A.el('wp_matchres')), /Traverses against the gauge — test T1/);
      A.click(A.find('#wp_mtrav [data-mtrav="1"]')); A.flush(2);
      sp = A.el('wp_cv_match')._wp.spec;
      const gm2 = sp.markers.find((m) => /^Gauge/.test(m.label));
      assert.ok(gm2 && /T2/.test(gm2.label), 'test 2 shown');
      assert.ok(Math.abs((g1 - gm2.x) - 40) < 0.01, 'its gauge is 40 psi lower: ' + (g1 - gm2.x));
      assert.match(txt(A.el('wp_matchres')), /Traverses against the gauge — test T2/);
      assert.strictEqual(A.find('#wp_mtrav [data-mtrav="1"]').getAttribute('aria-pressed'), 'true', 'picker state');
      A.click(A.find('#wp_mdepth [data-mdepth="md"]')); A.flush(2);
      assert.ok(/MD/.test(A.el('wp_cv_match')._wp.spec.y.label) && A.el('wp_cv_match')._wp.spec.series.length >= 3, 'MD toggle keeps the picked test');
      // one test picked again: no picker, the single-test plot as before
      A.el('wpv_mtest').value = '0';
      A.click(A.find('[data-act="match"]')); A.flush(10);
      assert.ok(!A.find('#wp_mtrav'), 'no picker for one test');
      assert.deepStrictEqual(plain(A.el('wp_cv_match')._wp.spec.markers.map((m) => m.label)), ['Gauge', 'THP', 'pwf'], 'single-test markers unchanged');
      const t = txt(A.el('wp_matchres'));
      assert.ok(!/NaN|undefined|Infinity|\[object Object\]/.test(t), 'clean text');
      assert.strictEqual(A.consoleErrors().length, 0, 'no console errors');
    },
  },
  {
    name: 'WFU4 shared property tables: a cold solve, its repeat and a solve after other fluids filled the table registry are equal on every number (Object.is)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, SY = G.WTS_wp_system;
      const a = plain(SY.solve(S.FIX.gasWell)), b = plain(SY.solve(S.FIX.gasWell));
      // fill the registry with other fluids (more tables than it keeps), then solve again
      for (let i = 0; i < 30; i++) { const M = S.FIX.oilWell; M.fluid.gor = 300 + 10 * i; M.fluid.api = 30 + (i % 7); SY.solve(M); }
      const c = plain(SY.solve(S.FIX.gasWell));
      const d1 = same(a, b, 'R', []), d2 = same(a, c, 'R', []);
      assert.ok(!d1.length, 'repeat: ' + d1.join('; '));
      assert.ok(!d2.length, 'after 30 other fluids: ' + d2.join('; '));
      // a property read outside a march resolves the base conditions and the library as before
      const F = G.WTS_wp_fluid.build(S.FIX.oilWell.fluid, { T_F: 200 });
      const p1 = plain(F.at(1500, 150, 900)), p2 = plain(F.at(1500, 150, 900));
      assert.ok(!same(p1, p2, 'props', []).length && p1.bg > 0, 'props outside a march');
    },
  },
];
