// Well Performance B, WP27 — tornado and the three / four-variable sensitivity matrix (49-calc-wp-sens.js). docs/WELL-PERFORMANCE-PLAN.md
// §3.6, §6 (≤ 4 variables, ≤ 1,000 cases, tornado), §15.2 (the base case = the single solve), §16.
//
// WTN1 tornado: the base = the single solve exactly; each low / high case = a cold solve at that value (root tolerance); bars sorted by
//      swing; the default ranges (p̄r ±10 %, WC ±10 points, bean ±8/64, the neighbouring catalogue tubing sizes); NO_VARS; CSV; cancel
// WTN2 three variables: the start cell = the single solve exactly; every cell = the two-variable grid at that third value (root
//      tolerance); breadth-first warm starts (tracked); flat indexing by strides; table and CSV carry every variable
// WTN3 four variables (3 × 3 × 3 × 3 = 81 cases) within the budget (≤ 500 E); refused pairs; more than 1,000 cases refused
'use strict';

const S = require('./_wellperf-shapes');

const WP = 'WP27';
const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const app = (ctx) => S.sharedApp(ctx);
const run = (job) => { let s, n = 0; do { s = job.step(); n++; } while (!s.done && n < 3000); return job.result(); };
const _memo = new Map();
const memo = (k, f) => { if (!_memo.has(k)) _memo.set(k, f()); return _memo.get(k); };

module.exports = [
  {
    name: 'WTN1 tornado: base = the single solve, each case = a cold solve, sorted by swing, default ranges, NO_VARS, CSV, cancel',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, SN = G.WTS_wp_sens, SY = G.WTS_wp_system;
      const r = memo('t-oil', () => run(SN.tornado(S.FIX.oilWell)));
      const R = SY.solve(S.FIX.oilWell);
      assert.ok(r.ok && r.q0 === R.op.q && r.base.pwf === R.pwf, 'base = the single solve exactly');
      const keys = r.bars.map((b) => b.key);
      ['pr', 'wc', 'gor', 'bean', 'J', 'psep', 'tubingId'].forEach((k) => assert.ok(keys.indexOf(k) !== -1, k + ' in the tornado'));
      for (let i = 1; i < r.bars.length; i++) assert.ok(r.bars[i].swing <= r.bars[i - 1].swing + 1e-9, 'sorted by swing');
      const by = {}; r.bars.forEach((b) => { by[b.key] = b; });
      assert.ok(by.pr.lo === 2700 && by.pr.hi === 3300 && by.wc.lo === 20 && by.wc.hi === 40 && by.bean.lo === 24 && by.bean.hi === 40, 'default ranges');
      assert.ok(by.tubingId.lo < 2.441 && by.tubingId.hi > 2.441, 'neighbouring tubing sizes: ' + by.tubingId.lo + ' / ' + by.tubingId.hi);
      [['wc', 'hi', (M) => { M.fluid.wc = 0.4; }], ['pr', 'lo', (M) => { M.res.pr = 2700; }], ['bean', 'hi', (M) => { M.surface.choke.bean64 = 40; }]].forEach(([k, side, f]) => {
        const M = S.FIX.oilWell; f(M); const q = SY.solve(M).op.q, t = side === 'hi' ? by[k].qHi : by[k].qLo;
        assert.ok(Math.abs(t / q - 1) < 1e-3, k + ' ' + side + ': ' + t + ' / ' + q);
      });
      assert.ok(by.psep.swing < 1e-6, 'critical choke: the separator pressure has no effect');
      const g = memo('t-gas', () => run(SN.tornado(S.FIX.gasWell, { vars: [{ key: 'bean' }, { key: 'pr', lo: 4000, hi: 5500 }, { key: 'wc' }] })));
      assert.ok(g.ok && g.bars.length === 2 && g.bars.find((b) => b.key === 'pr').lo === 4000, 'explicit ranges; inapplicable variables left out');
      assert.strictEqual(run(SN.tornado(S.FIX.gasWell, { vars: [{ key: 'J' }] })).code, 'NO_VARS');
      const csv = SN.tornadoCsv(r).split('\n');
      assert.ok(/tornado/.test(csv[0]) && csv.length === r.bars.length + 2, 'CSV');
      const j = SN.tornado(S.FIX.oilWell); j.step(); j.cancel();
      assert.ok(j.result().cancelled, 'cancel');
      assert.ok(r.evals <= 22 + 2 * r.bars.length * 8, 'budget: ' + r.evals + ' E for ' + r.bars.length + ' variables');
    },
  },
  {
    name: 'WTN2 three variables: start cell = the single solve, cells = the two-variable grid, warm starts, strides, table / CSV',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, SN = G.WTS_wp_sens, SY = G.WTS_wp_system;
      const vars = [{ key: 'wc', values: [20, 30, 40] }, { key: 'pr', values: [2800, 3000] }, { key: 'bean', values: [24, 32, 40] }];
      const r = memo('m3', () => run(SN.job(S.FIX.oilWell, vars)));
      assert.ok(r.ok && r.nd && r.cases.length === 18 && plain(r.keys).join() === 'wc,pr,bean', JSON.stringify(plain(r.errors)));
      assert.deepStrictEqual(plain(r.strides), [6, 3, 1]);
      const R = SY.solve(S.FIX.oilWell), c0 = r.cases.find((c) => c.values.wc === 30 && c.values.pr === 3000 && c.values.bean === 32);
      assert.ok(c0.R.q === R.op.q && !c0.R.tracked, 'start cell = the single solve exactly');
      assert.ok(r.cases.filter((c) => c !== c0 && c.R.tracked).length >= 15, 'warm starts');
      r.cases.forEach((c, f) => { assert.strictEqual(r.q[f], c.R.ok ? c.R.q : null); const ix = c.idx; assert.strictEqual(ix[0] * 6 + ix[1] * 3 + ix[2], f); });
      [24, 40].forEach((bean) => {
        const M = S.FIX.oilWell; M.surface.choke.bean64 = bean;
        const r2 = memo('m2-' + bean, () => run(SN.job(M, [{ key: 'wc', values: [20, 30, 40] }, { key: 'pr', values: [2800, 3000] }])));
        r2.cases.forEach((c2) => {
          const c3 = r.cases.find((c) => c.values.wc === c2.values.wc && c.values.pr === c2.values.pr && c.values.bean === bean);
          assert.ok(c2.R.ok === c3.R.ok && (!c2.R.ok || Math.abs(c3.R.q / c2.R.q - 1) < 1e-3), 'bean ' + bean + ' WC ' + c2.values.wc + ' p̄r ' + c2.values.pr + ': ' + c3.R.q + ' / ' + c2.R.q);
        });
      });
      const t = SN.table(r);
      assert.ok(/Water cut/.test(t.head[0]) && /Reservoir pressure/.test(t.head[1]) && /Choke bean/.test(t.head[2]) && /Rate/.test(t.head[3]) && t.rows.length === 18, 'table');
      const csv = SN.csv(r).split('\n');
      assert.ok(/sensitivity matrix: Water cut × Reservoir pressure p̄r × Choke bean/.test(csv[0]) && csv.length === 20, 'CSV');
    },
  },
  {
    name: 'WTN3 four variables (81 cases) within the budget; refused pairs; > 1,000 cases refused',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, SN = G.WTS_wp_sens;
      const r = run(SN.job(S.FIX.oilWell, [{ key: 'wc', values: [20, 30, 40] }, { key: 'pr', values: [2800, 3000, 3200] }, { key: 'bean', values: [24, 32, 40] }, { key: 'gor', values: [400, 500, 600] }]));
      assert.ok(r.ok && r.nd && r.cases.length === 81 && r.keys.length === 4, JSON.stringify(plain(r.errors)));
      assert.ok(r.evals <= 500, '81 cases: ' + r.evals + ' E');
      assert.ok(r.cases.filter((c) => c.R.ok).length >= 70, 'most cases flow');
      const bad = (vars, code) => { const x = run(SN.job(S.FIX.oilWell, vars)); assert.ok(!x.ok && x.code === code, code + ': ' + JSON.stringify(plain(x.errors))); };
      bad([{ key: 'wc', values: [10] }, { key: 'thp', values: [200] }, { key: 'bean', values: [24] }], 'BAD_PAIR');
      const v10 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      bad([{ key: 'wc', values: v10 }, { key: 'pr', values: v10.map((x) => 2000 + 100 * x) }, { key: 'bean', values: v10.map((x) => 20 + x) }, { key: 'gor', values: [400, 500] }], 'BAD_VARS');
      bad([{ key: 'wc', values: [10] }, { key: 'pr', values: [3000] }, { key: 'cgr', values: [5] }], 'NOT_APPLICABLE');
    },
  },
];
