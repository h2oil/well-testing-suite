// Well Performance A2, WP16 — two-variable sensitivity Jobs and the tubing-size design mode. docs/WELL-PERFORMANCE-PLAN.md §3.5
// (designFor {tubingId: q}), §3.6, §4.9 (tubing ID from the catalogue as a discrete scan), §6, §15.2, §16 (2 × 10 ≤ 160 E), §17.2.
//
// WSN1 two variables: full factorial, the 2-D grid (rows = the second variable), the start cell = the single solve exactly, every
//      other cell a tracking solve from a solved neighbour; 2 × 10 within the §16 budget (≤ 160 E)
// WSN2 each row equals the one-variable sensitivity at that value of the second variable (same rates within the root tolerance);
//      pairs that set the same input are refused (also among three variables, B: WP27), applicability is checked
// WSN3 table and CSV: both variable columns, the 2-D rate block; cancel discards the result
// WSN4 tubing-size design: the smallest catalogue size whose stable rate reaches the target, every size listed (rate, stability,
//      loading margin, erosion), sizes that do not fit the casing left out, an unreachable target says why
// WSN5 the page: second variable + values, the heat-map table (cells coloured by rate, select → ringed marker on the rate plot,
//      "Use these values"), the rate lines per second value, the CSV block; the tubing design table, chart and "Use"
'use strict';

const S = require('./_wellperf-shapes');

const WP = 'WP16';
const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const app = (ctx) => S.sharedApp(ctx);
const run = (job) => { let s, n = 0; do { s = job.step(); n++; } while (!s.done && n < 500); return job.result(); };
const _memo = new Map();
const job = (SN, M, vars) => { const k = JSON.stringify([M, vars]); if (!_memo.has(k)) _memo.set(k, run(SN.job(M, vars))); return _memo.get(k); };
const WC10 = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90];

module.exports = [
  {
    name: 'WSN1 two variables: factorial grid, start cell = the single solve exactly, tracked neighbours, 2 × 10 ≤ 160 E',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, SN = G.WTS_wp_sens, SY = G.WTS_wp_system;
      const r = job(SN, S.FIX.oilWell, [{ key: 'wc', values: WC10 }, { key: 'pr', values: [3000, 2600] }]);
      assert.ok(r.ok && r.two && r.key === 'wc' && r.key2 === 'pr', JSON.stringify(plain(r.errors)));
      assert.deepStrictEqual(plain(r.grid.x), WC10); assert.deepStrictEqual(plain(r.grid.y), [2600, 3000], 'sorted');
      assert.strictEqual(r.cases.length, 20); assert.strictEqual(r.grid.q.length, 2); assert.strictEqual(r.grid.q[0].length, 10);
      assert.ok(r.base.inList && r.base2.inList && r.start.x === 30 && r.start.y === 3000, 'start at the model values');
      const R = SY.solve(S.FIX.oilWell), c0 = r.cases.find((c) => c.values.wc === 30 && c.values.pr === 3000);
      assert.ok(!c0.R.tracked && c0.R.q === R.op.q && c0.R.pwf === R.pwf, 'start cell = the single solve exactly (§15.2)');
      const others = r.cases.filter((c) => c !== c0 && c.R.ok);
      assert.ok(others.length >= 10 && others.filter((c) => c.R.tracked).length >= others.length - 2, 'tracked neighbours: ' + others.filter((c) => c.R.tracked).length + ' of ' + others.length);
      r.cases.forEach((c) => { assert.strictEqual(r.grid.q[c.j][c.i], c.R.ok ? c.R.q : null); });
      // physics: the rate falls with water cut and rises with p̄r on every column that flows in both rows
      for (let i = 1; i < 10; i++) if (r.grid.q[1][i] != null && r.grid.q[1][i - 1] != null) assert.ok(r.grid.q[1][i] < r.grid.q[1][i - 1], 'falls with WC');
      r.grid.x.forEach((x, i) => { if (r.grid.q[0][i] != null) assert.ok(r.grid.q[1][i] > r.grid.q[0][i], 'rises with p̄r at WC ' + x); });
      assert.ok(r.evals <= 160, '2 × 10 within the §16 budget: ' + r.evals + ' E');
      assert.ok(r.cases.every((c) => Array.isArray(c.R.curve) && c.R.curve.length === 0), 'rates only (no family curves)');
    },
  },
  {
    name: 'WSN2 each row = the one-variable sensitivity at that second value; refused pairs (also with three variables), applicability',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, SN = G.WTS_wp_sens;
      const r = job(SN, S.FIX.oilWell, [{ key: 'wc', values: WC10 }, { key: 'pr', values: [3000, 2600] }]);
      const M26 = S.FIX.oilWell; M26.res.pr = 2600;
      const r1 = job(SN, M26, [{ key: 'wc', values: WC10 }]);
      r1.cases.forEach((c) => {
        const q2 = r.grid.q[0][WC10.indexOf(c.values.wc)];
        if (c.R.ok) assert.ok(q2 != null && Math.abs(q2 / c.R.q - 1) < 1e-3, 'WC ' + c.values.wc + ': ' + q2 + ' vs ' + c.R.q);
        else assert.strictEqual(q2, null, 'no flow in both at WC ' + c.values.wc);
      });
      const bad = (vars, code) => { const j = SN.job(S.FIX.oilWell, vars); const x = run(j); assert.ok(!x.ok && x.code === code, code + ': ' + JSON.stringify(plain(x.errors))); };
      bad([{ key: 'thp', values: [200, 300] }, { key: 'bean', values: [24, 32] }], 'BAD_PAIR');
      bad([{ key: 'gor', values: [400, 600] }, { key: 'glr', values: [300, 500] }], 'BAD_PAIR');
      bad([{ key: 'wc', values: [10] }, { key: 'pr', values: [3000] }, { key: 'gor', values: [500] }, { key: 'glr', values: [400] }], 'BAD_PAIR');   // B (WP27): three and four variables run (wellperf-tornado)
      bad([{ key: 'wc', values: [10, 20] }, { key: 'cgr', values: [10, 20] }], 'NOT_APPLICABLE');
      // a gas well: bean × WGR
      const g = job(SN, S.FIX.gasWell, [{ key: 'bean', values: [20, 24, 28] }, { key: 'wgr', values: [2, 20] }]);
      assert.ok(g.ok && g.grid.q.every((row) => row.every((q) => q > 0)), 'gas bean × WGR flows');
      assert.ok(g.cases.every((c) => c.R.ok && (c.R.loadingMargin == null || isFinite(c.R.loadingMargin))), 'loading margins');
      for (let j = 0; j < 2; j++) assert.ok(g.grid.q[j][2] > g.grid.q[j][0], 'larger bean, higher rate');
    },
  },
  {
    name: 'WSN3 table and CSV carry both variables and the 2-D block; cancel discards the result',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, SN = G.WTS_wp_sens;
      const r = job(SN, S.FIX.oilWell, [{ key: 'wc', values: WC10 }, { key: 'pr', values: [3000, 2600] }]);
      const t = SN.table(r);
      assert.ok(/Water cut/.test(t.head[0]) && /Reservoir pressure/.test(t.head[1]) && /Rate/.test(t.head[2]), t.head.slice(0, 3).join(' | '));
      assert.strictEqual(t.rows.length, 20);
      const csv = SN.csv(r).split('\n');
      const i = csv.findIndex((l) => /^"?Rate \(STB\/d liquid\): rows Reservoir pressure/.test(l));
      assert.ok(i > 0, 'the 2-D block');
      assert.strictEqual(csv[i + 1], ',' + WC10.join(','), 'columns = the primary values');
      assert.ok(/^2600,/.test(csv[i + 2]) && /^3000,/.test(csv[i + 3]), 'rows = the second values');
      const j = SN.job(S.FIX.oilWell, [{ key: 'wc', values: [10, 20, 30] }, { key: 'pr', values: [2800, 3000] }]);
      j.step(); j.cancel();
      const x = j.result();
      assert.ok(!x.ok && x.cancelled && x.cases.length === 0, 'cancelled');
    },
  },
  {
    name: 'WSN4 tubing-size design: the smallest catalogue size that reaches the target, every fitting size listed, unreachable says why',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, SY = G.WTS_wp_system, T = G.WTS_tubulars;
      const d = run(SY.designFor(S.FIX.oilWell, { tubingId: 880 }));
      assert.ok(d.ok && d.kind === 'tubingId', JSON.stringify(plain(d.errors)));
      const ids = d.rows.map((x) => x.id);
      assert.deepStrictEqual(ids, ids.slice().sort((a, b) => a - b), 'smallest first');
      assert.ok(d.rows.every((x) => x.od < 6.276 - 0.25), 'only sizes that fit the 7 in casing');
      assert.ok(d.rows.length >= 8 && T.list('tubing').length >= d.rows.length, 'catalogue scan: ' + d.rows.length);
      const hit = d.rows.filter((x) => x.ok && x.stable && x.q >= 880 * 0.999);
      assert.strictEqual(d.tubKey, hit[0].key, 'the smallest size that reaches the target');
      assert.ok(d.rows.filter((x) => x.id < d.tubingId).every((x) => !x.ok || x.q < 880), 'every smaller size falls short');
      const M = S.FIX.oilWell; M.well.strings.forEach((x) => { if (x.kind === 'tubing') { const e = T.find(d.tubKey); x.id = e.id; x.od = e.od; } });
      const R = SY.solve(M);
      assert.ok(R.ok && Math.abs(R.op.q / d.q - 1) < 1e-3 && R.op.q >= 880 * 0.999, 'solving at the chosen size gives the target: ' + R.op.q);
      assert.ok(d.rows.every((x) => !x.ok || (isFinite(x.q) && isFinite(x.ero))), 'rate and erosion per size');
      const g = run(SY.designFor(S.FIX.gasWell, { tubingId: 50000 }));
      assert.ok(!g.ok && g.code === 'NOT_REACHABLE' && g.best && /largest rate/.test(g.errors.join(' ')), JSON.stringify(plain(g.errors)));
      assert.ok(g.rows.some((x) => x.ok && isFinite(x.loadingMargin)), 'gas: loading margin per size');
      const Mn = S.FIX.oilWell; Mn.well.strings = Mn.well.strings.filter((x) => x.kind !== 'tubing');
      assert.strictEqual(run(SY.designFor(Mn, { tubingId: 500 })).code, 'NO_TUBING');
    },
  },
  {
    name: 'WSN5 page: second variable, heat-map cells (select → marker, Use these values), rate lines per second value, CSV; tubing design table, chart and Use',
    wp: WP, opts: false,
    async run(_a, assert, ctx) {
      const A = app(ctx), G = A.win, txt = (e) => String(e && e.textContent || '').replace(/\s+/g, ' ').trim(), BAD = /NaN|undefined|Infinity|\[object Object\]/;
      if (G.__WP_MOCK) return assert.ok(true, 'mock installed in this app');
      S.resetWellPerf(A); G.WTS_wellperf_page.resetJobs();
      A.hook.nav('wellperf'); A.flush(30);
      A.click(A.find('[data-act="example"][data-ex="oil"]')); A.flush(30);
      G.WTS_wellperf_page.goStep(5); A.flush(5);
      const off = (id) => /wp-off/.test(A.el(id).closest('.fg-item').className);
      assert.ok(off('wpv_svals2'), 'second values hidden without a second variable');
      A.select('wpv_svar', 'wc'); A.flush(5);
      A.change('wpv_svals', '0 20 40 60'); A.flush(5);
      A.select('wpv_svar2', 'pr'); A.flush(5);
      assert.ok(!off('wpv_svals2') && A.el('wpv_svals2').value.split(' ').length >= 3, 'second values suggested: ' + A.el('wpv_svals2').value);
      A.change('wpv_svals2', '2600 3000'); A.flush(5);
      const st = G.WTS_wellperf_page.state();
      A.click(A.find('[data-act="sens"]'));
      for (let i = 0; i < 80 && !(st.sens && st.sens.two); i++) await A.flushAsync(1);
      assert.ok(st.sens && st.sens.two && st.sens.cases.length === 8, 'two-variable result on the page');
      const cells = A.findAll('#wp_senstbl .wp-heat [data-act="sens2cell"]');
      assert.strictEqual(cells.length, 8, '2 × 4 heat-map cells');
      { const sty = String(A.find('#wp_senstbl td.wp-hc').getAttribute('style') || ''); assert.ok(/rgba?\(/.test(sty), 'cells coloured by rate: ' + sty); }
      const cv = A.el('wp_cv_tr'), sp = cv._wp.spec;
      assert.ok(/^sens2:/.test(sp.key) && sp.series.filter((s) => s.legend !== false && s.label).length === 2, 'one rate line per p̄r value');
      A.click(cells[5]); A.flush(5);
      assert.ok(st.sensSel && st.sensSel.i === 1 && st.sensSel.j === 1, 'cell selected');
      assert.ok(cv._wp.spec.markers.some((m) => m.halo), 'ringed marker on the rate plot');
      assert.match(txt(A.el('wp_senstbl')), /Selected case/);
      const use = A.find('#wp_senstbl [data-act="adopt"]');
      assert.ok(use && /wp_wc/.test(use.getAttribute('data-ids')) && /wp_pr/.test(use.getAttribute('data-ids')), 'Use these values');
      A.click(use); A.flush(30);
      assert.ok(A.el('wp_wc').value === '20' && +A.el('wp_pr').value === 3000, 'inputs adopted: WC ' + A.el('wp_wc').value + ', p̄r ' + A.el('wp_pr').value);
      const csv = G.WTS_wellperf_page.csv();
      assert.ok(/Sensitivity: rate \(STB\/d\), rows Reservoir pressure/.test(csv), 'CSV 2-D block');
      assert.ok(!BAD.test(txt(A.el('wp_step_5'))), 'step 5 clean');
      // tubing-size design
      A.select('wp_mode', 'design'); A.flush(30);
      A.select('wp_tkind', 'tubingId'); A.change('wp_tq', ''); A.flush(30);
      // review fix: the missing-target message sits next to the design button, not in the Studies box
      A.click(A.find('[data-act="design"]')); A.flush(5);
      assert.match(txt(A.el('wp_designmsg')), /Enter the target rate first/);
      assert.ok(!/Enter the target rate first/.test(txt(A.el('wp_jobbox'))), 'not in the Studies box');
      A.change('wp_tq', '800'); A.flush(30);
      st.design = null;
      A.click(A.find('[data-act="design"]'));
      for (let i = 0; i < 80 && !st.design; i++) await A.flushAsync(1);
      const dz = A.el('wp_design');
      assert.match(txt(dz), /smallest catalogue tubing that gives the target rate/);
      assert.ok(A.findAll('#wp_design table tbody tr').length >= 8 && A.el('wp_cv_tub')._wp, 'table and chart');
      assert.strictEqual(txt(A.el('wp_designmsg')), '', 'message cleared');
      // review fix: no Use button on the current size; erosion ratio with two decimals on every row
      A.findAll('#wp_design table tbody tr').forEach((tr) => {
        const cells = tr.querySelectorAll('td'), now = /\(now\)/.test(txt(cells[0]));
        if (now) assert.ok(!tr.querySelector('[data-act="usetub"]'), 'no Use on the current size');
        const er = txt(cells[cells.length - 2]);
        assert.ok(er === '—' || /^\d+\.\d{2}$/.test(er), 'erosion ratio 2 dp: ' + er);
      });
      const ub = A.findAll('#wp_design [data-act="usetub"]')[0];
      A.click(ub); A.flush(30);
      const rec = JSON.parse(A.storage.getItem('wts_wellperf_model'));
      assert.ok(rec.strings.filter((x) => x.kind === 'tubing').every((x) => x.tubKey === ub.getAttribute('data-key')), 'strings written');
      assert.strictEqual(A.consoleErrors().length, 0, 'no console errors');
      A.select('wp_mode', 'rate'); A.select('wpv_svar2', ''); A.flush(30);
    },
  },
  {
    name: 'WSN6 review fix: loading an example suggests the sensitivity values again (p̄r values from the empty model are replaced) so Run sensitivity flows; a restore with stale p̄r values (< 0.3 × the model p̄r) is refreshed',
    wp: WP, opts: false,
    async run(_a, assert, ctx) {
      const A = app(ctx), G = A.win;
      if (G.__WP_MOCK) return assert.ok(true, 'mock installed in this app');
      S.resetWellPerf(A); G.WTS_wellperf_page.resetJobs();
      A.hook.nav('wellperf'); A.flush(30);
      G.WTS_wellperf_page.goStep(5); A.flush(5);
      A.select('wpv_svar', 'pr'); A.flush(5);
      A.el('wpv_svals').value = '15 50 86 120 160';
      A.click(A.find('[data-act="example"][data-ex="oil"]')); A.flush(30);
      const vals = A.el('wpv_svals').value.split(' ').map(Number);
      assert.ok(vals.length >= 3 && vals.every((v) => v > 900), 'suggested for p̄r 3,000: ' + A.el('wpv_svals').value);
      const st = G.WTS_wellperf_page.state();
      A.click(A.find('[data-act="sens"]'));
      for (let i = 0; i < 80 && !st.sens; i++) await A.flushAsync(1);
      assert.ok(st.sens && st.sens.cases.some((c) => c.R && c.R.ok), 'cases flow');
      // the silent restore (project open / well switch) refreshes stale values
      A.el('wpv_svals').value = '15 50 86';
      G.WTS_calcRegistry.wellperf.hooks.after(); A.flush(30);
      assert.ok(A.el('wpv_svals').value.split(' ').map(Number).every((v) => v > 900), 'refreshed on restore: ' + A.el('wpv_svals').value);
      A.el('wpv_svals').value = '2000 2500 3000';
      G.WTS_calcRegistry.wellperf.hooks.after(); A.flush(30);
      assert.strictEqual(A.el('wpv_svals').value, '2000 2500 3000', 'values that fit are kept');
      A.select('wpv_svar', 'wc'); A.flush(5);
      G.WTS_wellperf_page.resetJobs();
    },
  },
];
