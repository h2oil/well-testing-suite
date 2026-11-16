// Well Dynamics WD0 contracts — docs/WELL-DYNAMICS-PLAN.md §3.9 (welldyn-shapes, 5 tests; written at 4.6.1 with tests/_welldyn-shapes.js).
//
// WS1 fixtures frozen (hash pin), complete models (the Well Performance SHAPE.M), fresh copies; the frozen orders equal the engine's
// WS2 the steady reference of every fixture: WTS_wp_system.solve = EXPECT (q, pwf, thp within 1e-6, choke regime, injection MD / intake)
// WS3 the pinned lift data: the gas-lift valve rows = WTS_wp_gl.design → valvesFromDesign on the base model; the pump = WTS_wp_esp.example()
// WS4 the shapes of §3 on live objects (Sim, State, StepInfo, Snap, Event, Rec, RunFile, Case, Summary, Ext), and the checker bites
// WS5 helpers: resetWellDyn, loadFix, files() (the naming rule's list), STUBS, BASELINE = the validate tool's
'use strict';

const crypto = require('crypto');
const S = require('./_welldyn-shapes');
const WPS = require('./_wellperf-shapes');

const WP = 'WD0';
// sha256 (first 16 hex) of JSON.stringify of [every fixture in FIX order, SCEN, EXPECT, ORDER] — bump only through the lead (frozen)
const FIX_HASH = '73275ae7d137e57e';
const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const fixHash = () => crypto.createHash('sha256').update(JSON.stringify([Object.keys(S.FIX).map((k) => S.FIX[k]), S.SCEN, S.EXPECT, S.ORDER])).digest('hex').slice(0, 16);
const G = (ctx) => S.sharedApp(ctx).win;

module.exports = [
  {
    name: 'WS1 fixtures: frozen (hash pin), complete models, fresh copies; ORDER = the engine\'s COMP / STATE_ORDER / CHANNELS / REGIMES',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      assert.strictEqual(fixHash(), FIX_HASH, 'fixtures changed — they are frozen (lead only)');
      const keys = Object.keys(S.FIX);
      assert.deepStrictEqual(keys, ['gasVert', 'gasLoad', 'gasHz', 'oilVert', 'oilVertTuned', 'oilDev', 'gasLift', 'esp', 'staticOil', 'buildup', 'heading']);
      keys.forEach((k) => { const r = WPS.checkShape('M', S.FIX[k]); assert.ok(r.ok, k + ': ' + r.errors.join('; ')); });
      assert.ok(S.FIX.oilVert !== S.FIX.oilVert, 'each read is a fresh copy');
      assert.deepStrictEqual(Object.keys(S.EXPECT), keys, 'a pinned reference per fixture');
      Object.keys(S.SCEN).forEach((n) => assert.ok(S.SCEN[n].fix in S.FIX && S.SCEN[n].duration_s > 0, 'scenario ' + n));
      Object.keys(S.SCEN_EXT).forEach((n) => assert.ok(n in S.SCEN, 'SCEN_EXT ' + n));
      S.GATE.concat(Object.keys(S.GATE4)).forEach((k) => assert.ok(k in S.FIX, 'gate fixture ' + k));
      const E = G(ctx).WTS_wd_engine;
      assert.deepStrictEqual(plain(E.COMP), plain(S.ORDER.COMP), 'COMP');
      assert.deepStrictEqual(plain(E.STATE_ORDER), plain(S.ORDER.STATES), 'STATE_ORDER (C9)');
      assert.deepStrictEqual(plain(E.CHANNELS.map((c) => c.key)), plain(S.ORDER.CHANNELS), 'CHANNELS (C9)');
      assert.deepStrictEqual(plain(E.REGIMES), plain(S.ORDER.REGIMES), 'REGIMES');
      assert.strictEqual(S.SHAPES.join(','), 'Sim,State,StepInfo,Snap,Event,Rec,RunFile,Case,Summary,Ext');
    },
  },
  {
    name: 'WS2 steady references: WTS_wp_system.solve on every fixture = EXPECT (q, p_wf, THP within 1e-6; choke regime; injection MD / pump intake)',
    wp: WP, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const g = G(ctx);
      Object.keys(S.FIX).forEach((k) => {
        const R = g.WTS_wp_system.solve(S.FIX[k]), e = S.EXPECT[k];
        assert.ok(R && R.ok && R.op, k + ': a stable root');
        assert.rel(R.op.q, e.q, 1e-6, k + ' q'); assert.rel(R.pwf, e.pwf, 1e-6, k + ' pwf'); assert.rel(R.surface.thp, e.thp, 1e-6, k + ' thp');
        assert.strictEqual(R.surface.choke.regime, e.regime, k + ' choke regime');
        if (e.injMd != null) assert.rel(R.lift.injMd, e.injMd, 1e-6, k + ' injection MD');
        if (e.pInt != null) assert.rel(R.lift.pInt, e.pInt, 1e-6, k + ' pump intake');
      });
    },
  },
  {
    name: 'WS3 pinned lift data: the gasLift valve rows = the design on the base model (WTS_wp_gl.design → valvesFromDesign); the esp pump = WTS_wp_esp.example()',
    wp: WP, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const g = G(ctx), FL = S.FIXL(g);
      assert.deepStrictEqual(plain(FL.designValves({})), plain(S.GL_VALVES), 'valve rows');
      assert.deepStrictEqual(plain(S.FIX.gasLift.lift.gl.valves), plain(S.GL_VALVES));
      assert.deepStrictEqual(plain(g.WTS_wp_esp.example()), plain(S.ESP_PUMP), 'pump record');
      assert.deepStrictEqual(plain(FL.gasLift()), plain(S.FIX.gasLift), 'no options: the pinned fixture');
      assert.deepStrictEqual(plain(FL.esp()), plain(S.FIX.esp));
      const v = FL.gasLift({ dpv: 100, port: 16 });
      assert.ok(v.lift.gl.design.port64 === 16 && v.lift.gl.valves.length > 0, 'a variant re-runs the design');
    },
  },
  {
    name: 'WS4 shapes on live objects: Sim, State, StepInfo, Snap, Event, Rec, RunFile, Case, Summary, Ext; the checker reports a missing field',
    wp: WP, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const g = G(ctx), E = g.WTS_wd_engine, ok = (name, o) => { const r = S.checkShape(name, o); assert.ok(r.ok, name + ': ' + r.errors.slice(0, 6).join('; ')); };
      const sim = E.create(S.FIX.oilVert, {});
      ok('Sim', sim); ok('State', sim.state);
      const rec = g.WTS_wd_rec.create({}); ok('Rec', rec); rec.attach(sim);
      ok('StepInfo', sim.step());
      sim.setChoke(28); sim.run(900);
      assert.ok(sim.log.length >= 1, 'the bean change is an event'); sim.log.forEach((e) => ok('Event', e));
      ok('Snap', sim.snapshot());
      const sum = g.WTS_wd_rec.summarize(rec, sim); ok('Summary', sum);
      const rf = rec.toFile({ well: { name: 'Test well' } }); ok('RunFile', Object.assign({}, rf, { summary: rf.summary || sum }));
      ok('Case', g.WTS_wd_cases.make({ name: 'Bean 28', settings: {}, events: plain(sim.log), duration_s: 900, summary: sum }));
      Object.keys(E.ext).forEach((k) => { ok('Ext', E.ext[k]); assert.strictEqual(E.ext[k].key, k); });
      if (typeof rec.detach === 'function') rec.detach();
      // the checker bites
      const st = plain(sim.snapshot()); delete st.cells.mI;
      const bad = S.checkShape('Snap', st);
      assert.ok(!bad.ok && bad.errors.some((x) => /cells\.mI/.test(x)), 'missing field reported: ' + bad.errors.join('; '));
      assert.ok(!S.checkShape('Nope', {}).ok);
    },
  },
  {
    name: 'WS5 helpers: resetWellDyn clears the module\'s storage, loadFix writes the tables, files() lists every Well Dynamics file, STUBS empty, BASELINE = welldyn-validate',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const app = S.sharedApp(ctx), st = app.storage;
      st.setItem('wts_page_welldyn', '{"f":{}}'); st.setItem('wtspref_wd_tab', 'trend');
      app.win.WTS_state = app.win.WTS_state || {}; app.win.WTS_state.welldyn = { x: 1 };
      S.resetWellDyn(app);
      assert.strictEqual(st.getItem('wts_page_welldyn'), null); assert.strictEqual(st.getItem('wtspref_wd_tab'), null);
      assert.strictEqual(app.win.WTS_state.welldyn, undefined);
      const r = S.loadFix(app, 'oilDev');
      assert.ok(r.ok, 'tables written ' + (r.code || ''));
      assert.deepStrictEqual(plain(app.win.WTS_wp_model.read().well.survey), plain(S.FIX.oilDev.well.survey), 'survey stored');
      const f = S.files().map((x) => x.replace(/\\/g, '/'));
      ['49-calc-wd-engine.js', '49-calc-wd-lift.js', '49-calc-welldyn.js', 'welldyn-validate.js', 'tests/_welldyn-shapes.js', 'tests/welldyn-shapes.test.js', 'docs/WELL-DYNAMICS-PLAN.md']
        .forEach((x) => assert.ok(f.some((y) => y.endsWith(x)), 'files(): ' + x));
      assert.ok(!f.some((y) => /_welldyn-wd[14]\.js$/.test(y)), 'the lane stand-ins are retired');
      assert.deepStrictEqual(S.STUBS, {});
      assert.deepStrictEqual(plain(S.BASELINE), plain(require('../welldyn-validate').BASELINE));
      app.win.WTS_wp_model.write({ survey: [], strings: [], flowline: [], geo: null });
    },
  },
];
