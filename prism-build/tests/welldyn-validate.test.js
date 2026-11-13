// Well Dynamics — the validation tool (lane WD5): the --gate method table, the --check quick subset and the --time step counts.
// docs/WELL-DYNAMICS-PLAN.md §4.14, §5.1, §5.5, §5.6, §11.5. The full tool (all of X1–X18, the scenario budgets, the browser report) is
// `node prism-build/welldyn-validate.js [--html]`; these tests run its functions on the shared app with short runs.
//
// VA1 the D17 table of the tool = WTS_wd_engine.METHODS (keys and verified flags); the "never a default" keys are verified:false
// VA2 --gate (quick): every provisional control is labelled, the summary lists the engine's keys, no "never a default" key in a default run
// VA3 --check X1 (G3 oilVert): the steady run settles on WTS_wp_system.solve; the C2 diagnostic (march at the cell length) is reported
// VA4 --check X3 / X7 / X8 / X18: static columns, E1 vs PRiSM #1, the foamer σ factor (sigF^¼), the loading rule = the nodal rule
// VA5 --check X10 / X17: determinism + restore, and the replay round trip (file → fromFile → re-run identical → continue from a snapshot)
// VA7 the banned-name scan (wellperf-names) over the tool and this file
// VA6 --time (quick): the step counts and mean Δt of the flowing and shut-in rows are consistent (steps × Δt = simulated time; flowing
//     oil Δt in the §5.6 band), every row has a value, the baseline table is the §11.1 record
'use strict';

const W = require('./_welldyn-wd1');
const V = require('../welldyn-validate');

const WP = 'WD5';
const G = (ctx) => W.sharedApp(ctx).win;
const row = (res, id) => res.rows.filter((r) => r.id === id);

module.exports = [
  {
    name: 'VA1 the D17 method table of welldyn-validate equals WTS_wd_engine.METHODS (keys, verified flags); "never a default" keys are provisional',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const E = G(ctx).WTS_wd_engine;
      assert.deepStrictEqual(V.METHOD_TABLE.map((m) => m.key).sort(), Object.keys(E.METHODS).sort(), 'the same keys');
      V.METHOD_TABLE.forEach((m) => assert.strictEqual(E.METHODS[m.key].verified, m.verified, m.key));
      V.NEVER_DEFAULT.forEach((k) => assert.strictEqual(E.METHODS[k].verified, false, k + ' never a default → verified:false'));
      ['res_sup', 'choke_sub', 'belfroid', 'fallback', 'temp_relax', 'foamer'].forEach((k) => assert.ok(V.NEVER_DEFAULT.indexOf(k) !== -1, k));
      assert.strictEqual(E.PROVISIONAL, V.PROVISIONAL);
    },
  },
  {
    name: 'VA2 --gate (quick): provisional controls labelled, the run summary lists the engine\'s provisional keys, no "never a default" key active by default',
    wp: WP, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const g = V.gate(G(ctx), { quick: true });
      assert.deepStrictEqual(g.errors, [], 'gate errors');
      assert.ok(g.ok);
      assert.strictEqual(g.runs.length, 2);
      g.runs.forEach((r) => V.NEVER_DEFAULT.forEach((k) => assert.ok(r.active.indexOf(k) === -1, r.fixture + ': ' + k)));
      assert.ok(g.rows.filter((r) => r.ui).length >= 4, 'user-selectable provisional methods checked');
    },
  },
  {
    name: 'VA3 --check X1 (G3 oilVert): the steady run settles on WTS_wp_system.solve within the §5.1 tolerances; the C2 diagnostic is reported',
    wp: WP, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const c = V.checks(G(ctx), { quick: true, only: ['X1'] }), r = row(c, 'X1');
      assert.strictEqual(r.length, 1, 'quick: oilVert only');
      assert.ok(r[0].ok, r[0].note);
      assert.ok(Math.abs(r[0].dq) <= 0.02 && Math.abs(r[0].dp) <= 0.01, 'rate ' + r[0].dq + ', BHP ' + r[0].dp);
      assert.strictEqual(r[0].regime, 'critical');
      assert.ok(r[0].diag && r[0].diag.stepFt > 100 && r[0].diag.stepFt < 200, 'C2 diagnostic at the cell length');
      assert.ok(Math.abs(r[0].diag.dqCell) <= 0.02, 'gate distance against the cell-length march');
    },
  },
  {
    name: 'VA4 --check X3 / X7 / X8 / X18: static columns vs shutIn, E1 vs PRiSM #1, the foamer factor sigF^¼, the loading rule = the nodal rule',
    wp: WP, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const c = V.checks(G(ctx), { quick: true, only: ['X3', 'X7', 'X8', 'X18'] });
      assert.strictEqual(c.rows.length, 4);
      c.rows.forEach((r) => { assert.ok(r.ok, r.id + ': ' + r.note); assert.ok(!r.skip, r.id + ' ran'); });
      assert.ok(row(c, 'X8')[0].value <= 1e-9, 'σ factor exact');
    },
  },
  {
    name: 'VA5 --check X10 / X17: determinism and restore bit-identical; replay file round trip, re-run identical, continuation from a file snapshot',
    wp: WP, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const c = V.checks(G(ctx), { quick: true, only: ['X10', 'X17'] });
      assert.strictEqual(c.rows.length, 2);
      c.rows.forEach((r) => assert.ok(r.ok, r.id + ': ' + r.note));
      assert.match(row(c, 'X17')[0].note, /series identical, re-run identical, continuation identical/);
    },
  },
  {
    name: 'VA6 --time (quick): step counts and mean Δt consistent (steps × Δt = simulated time; flowing oil Δt in the §5.6 band); baseline = §11.1',
    wp: WP, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const t = V.timing(G(ctx), { quick: true });
      const flow = t.rows.find((r) => r.op.indexOf('flowing step') === 0 && r.fixture === 'oilVert');
      assert.ok(flow && flow.steps > 0 && flow.v > 0, 'flowing step row');
      assert.ok(Math.abs(flow.steps * flow.dt - 900) < 1e-6, 'steps × Δt = 900 s');
      assert.ok(flow.dt >= 4 && flow.dt <= 15, 'flowing oil Δt ' + flow.dt.toFixed(2) + ' s (§5.6: 4–15 s)');
      const shut = t.rows.find((r) => r.op.indexOf('shut-in, first hour') === 0);
      assert.ok(shut && shut.steps > 0 && shut.dt > flow.dt, 'shut-in steps longer than flowing ones');
      t.rows.forEach((r) => assert.ok(r.v == null || isFinite(r.v), r.op));
      assert.ok(t.rows.some((r) => /^scenario levelSettle/.test(r.op)), 'a scenario row');
      assert.strictEqual(V.BASELINE.stepFlow.oilVert, 3.64, 'the WD1 record');
      assert.strictEqual(V.BUDGET.stepFlow, 2.5, 'the §5.6 budget');
    },
  },
  {
    name: 'VA7 names: the wellperf-names banned list finds nothing in welldyn-validate.js and this test file',
    wp: WP,
    run(_a, assert) {
      const fs = require('fs'), path = require('path');
      const src = fs.readFileSync(path.join(__dirname, 'wellperf-names.test.js'), 'utf8');
      const head = src.slice(0, src.indexOf('module.exports'));
      const rq = (p) => require(p.startsWith('./') ? path.join(__dirname, p) : p);
      const N = new Function('require', 'module', head + '; return { patterns, scan };')(rq, {});
      const bad = [];
      [path.join(__dirname, '..', 'welldyn-validate.js'), __filename].forEach((f) => { const h = N.scan(fs.readFileSync(f, 'utf8'), N.patterns()); if (h.length) bad.push(path.basename(f) + ': ' + JSON.stringify(h).slice(0, 200)); });
      assert.deepStrictEqual(bad, []);
    },
  },
];
