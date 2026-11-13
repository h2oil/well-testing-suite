// Well Dynamics — integration wave 1 (docs/WELL-DYNAMICS-PLAN.md §9.1, §11.4): PG25–PG28, real runs of the gate / scenario fixtures
// through the page with the WD1 engine (no stand-in), plus the engine ↔ page / recorder contract seams found at the merge.
//
// PG25 gas loading: FIX.gasLoad, preset "gas loading" (bean 32 → 16 at 1 h) reaches LOADING; the bean set back to 32 on the toolbar
//      unloads the well (unloading, then marginal / stable); the CSV of the run has the engine's channel keys
// PG26 shut-in build-up: FIX.buildup with its dyn.res — the preset switches to the transient reservoir without asking for μ / B,
//      the BHP builds up below p̄r (line source, not the instantaneous IPR)
// PG27 horizontal gas well (FIX.gasHz): a steady run settles stable on the nodal rate (2 %) and BHP (1 %)
// PG28 oil natural-flow start-up from a static oil column: Open on the toolbar → start-up → stable on the nodal rate
// INT2 the banned-name scan of wellperf-names over every Well Dynamics file (until WD0's welldyn-names lands)
// INT1 the recorder keys follow the engine's CHANNELS objects (no "[object Object]" columns); the view's state labels are the engine's
'use strict';

const W = require('./_welldyn-wd1');

const WPK = 'WDI';
const BAD = /NaN|undefined|Infinity|\[object Object\]/;
const clone = (o) => JSON.parse(JSON.stringify(o));
let _shared = null;
function app0(ctx) {
  const key = String(ctx.mode);
  if (_shared && _shared.key === key) return _shared.app;
  const app = ctx.loadApp({ sourceOverrides: W.sourceOverrides() });
  const Wm = app.win.WTS_wp_model, read0 = Wm.read;
  // the fixtures are whole models M (tables and scalars); the page reads them through WTS_wp_model.read as it reads a stored well
  app._fix = null;
  Wm.read = function (o) {
    if (!app._fix) return read0.call(Wm, o);
    const M = app.toWin(clone(app._fix)); M.meta = { status: 'ok', readOnly: false, notes: [] }; return M;
  };
  _shared = { key, app };
  return app;
}
const P = (app) => app.win.WTS_welldyn_page;
function openFix(app, M) {
  app._fix = M;
  const p = P(app); if (p) p.pause();
  app.storage.removeItem('wts_page_welldyn');
  app.hook.nav('home'); app.flush(10);
  app.hook.nav('welldyn'); app.flush(30);
  P(app).build();
}
let TS = 1000;
function playTo(app, tEnd) {
  const p = P(app); p.speed(1000); p.play();
  for (let g = 0; g < 20000 && p.sim().state.t < tEnd; g++) { TS += 50; p.frame(TS); }
  p.pause();
}
function track(app) { const out = []; const s = P(app).sim(); s.on('state', (e) => out.push(e.to || e.state)); return out; }
function clean(app, assert) { const t = String(app.el('wd_root').textContent || ''); const m = t.match(BAD); assert.ok(!m, 'page text: ' + (m && t.slice(Math.max(0, m.index - 40), m.index + 30))); }

module.exports = [
  {
    name: 'PG25 gas loading through the page (real engine): bean 32 → 16 reaches LOADING; bean 32 on the toolbar unloads it; CSV columns are the engine channel keys',
    wp: WPK, integration: true,
    run(_a, assert, ctx) {
      const app = app0(ctx);
      openFix(app, W.FIX.gasLoad);
      const r = P(app).scenario('gasload');
      assert.ok(r.ok && r.note === '', 'a gas well: no note');
      const st = track(app);
      playTo(app, 3 * 3600);
      const S = P(app).sim().state;
      assert.strictEqual(S.well.state, 'loading', 'loading after the choke-back: ' + st.join(' → '));
      assert.ok(S.loading.ratio < 0.8, 'rate below the critical rate: ' + S.loading.ratio);
      app.el('wd_bean').value = '32'; app.el('wd_bean_go').click();
      playTo(app, 8 * 3600);
      const k = st.indexOf('unloading');
      assert.ok(k > st.indexOf('loading'), 'unloading after the bean-up: ' + st.join(' → '));
      assert.ok(['marginal', 'stable', 'unloading'].indexOf(P(app).sim().state.well.state) !== -1, 'recovered: ' + P(app).sim().state.well.state);
      assert.ok(P(app).sim().state.loading.ratio > 0.9, 'back near the critical rate');
      const csv = P(app).csv({ cols: ['thp', 'qg', 'state'] });
      const head = String((csv && (csv.text || csv)) || '').split(/\r?\n/).filter((l) => l && l[0] !== '#')[0] || '';
      assert.ok(!/object/.test(head) && /THP/.test(head), 'CSV header: ' + head);
      clean(app, assert);
    },
  },
  {
    name: 'PG26 shut-in build-up through the page (real engine): the transient reservoir from dyn.res (μ from the fluid), BHP builds below p̄r',
    wp: WPK, integration: true,
    run(_a, assert, ctx) {
      const app = app0(ctx);
      openFix(app, W.FIX.buildup);
      const r = P(app).scenario('shutin');
      assert.strictEqual(r.note, '', 'nothing missing: ' + r.note);
      assert.strictEqual(P(app).sim().opts.reservoir.mode, 'transient');
      playTo(app, 2 * 3600 - 60);
      const p0 = P(app).sim().state.bottom.pwf;
      playTo(app, 2 * 3600 + 600);
      const p1 = P(app).sim().state.bottom.pwf;
      playTo(app, 10 * 3600);
      const p2 = P(app).sim().state.bottom.pwf, pr = P(app).sim().M.res.pr;
      assert.strictEqual(P(app).sim().state.well.state, 'shutin');
      assert.ok(p1 > p0 + 100 && p2 > p1 && p2 < pr - 5, 'build-up ' + [p0, p1, p2, pr].map((x) => x.toFixed(1)).join(' < '));
      clean(app, assert);
    },
  },
  {
    name: 'PG27 horizontal gas well through the page (real engine): steady, stable, on the nodal operating point (rate 2 %, BHP 1 %)',
    wp: WPK, integration: true,
    run(_a, assert, ctx) {
      const app = app0(ctx);
      openFix(app, W.FIX.gasHz);
      P(app).scenario('steady');
      playTo(app, 2 * 3600);
      const s = P(app).sim(), chk = s.steadyCheck();
      assert.ok(chk.steady, 'steady');
      assert.strictEqual(s.state.well.state, 'stable');
      const R = s.R0;                                   // the engine's own WTS_wp_system.solve of the same model
      assert.ok(R && R.op, 'nodal operating point');
      const q = R.op.q, pwf = R.pwf;
      assert.ok(Math.abs(chk.qMean / q - 1) < 0.02, 'rate ' + chk.qMean + ' vs ' + q);
      assert.ok(Math.abs(chk.pwfMean / pwf - 1) < 0.01, 'BHP ' + chk.pwfMean + ' vs ' + pwf);
      clean(app, assert);
    },
  },
  {
    name: 'PG28 oil start-up from a static oil column through the page (real engine): Open → start-up → stable at the nodal rate',
    wp: WPK, integration: true,
    run(_a, assert, ctx) {
      const app = app0(ctx);
      openFix(app, W.FIX.oilVert);
      P(app).scenario('steady');
      app.el('wd_start').value = 'static'; app.el('wd_static').value = 'liquid'; app.el('wd_liquid').value = 'oil'; app.el('wd_prior').value = 'none';
      P(app).build();
      assert.ok(!P(app).sim().state.open, 'a static start is shut');
      assert.strictEqual(app.el('wd_shut').textContent, 'Open');
      P(app).shut();
      const st = track(app);
      playTo(app, 2 * 3600);
      const s = P(app).sim(), chk = s.steadyCheck();
      assert.strictEqual(st[0], 'startup', st.join(' → '));
      assert.strictEqual(s.state.well.state, 'stable', st.join(' → '));
      const R = s.R0;
      assert.ok(R && R.op, 'nodal operating point');
      const q = R.op.q;
      assert.ok(Math.abs(chk.qMean / q - 1) < 0.02, 'rate ' + chk.qMean + ' vs ' + q);
      clean(app, assert);
      app._fix = null;
    },
  },
  {
    name: 'INT1 seams: recorder keys = the engine CHANNELS keys; the view state labels = the engine labels; WTS_flowline_gradAt shipped',
    wp: WPK,
    run(_a, assert, ctx) {
      const app = ctx.loadApp({});
      const g = app.win;
      assert.strictEqual(typeof g.WTS_flowline_gradAt, 'function', 'the R5 export is in the build');
      const keys = g.WTS_wd_rec.channelKeys();
      assert.deepStrictEqual(JSON.parse(JSON.stringify(keys)), JSON.parse(JSON.stringify(g.WTS_wd_engine.CHANNELS.map((c) => c.key))));
      g.WTS_wd_engine.STATE_ORDER.forEach((k) => assert.strictEqual(g.WTS_wd_view.STATE_LABELS[k], g.WTS_wd_engine.STATES[k].label, k));
    },
  },
  {
    name: 'INT2 names: the wellperf-names banned list finds nothing in the Well Dynamics engines, page, view, recorder, tests or plan',
    wp: WPK,
    run(_a, assert) {
      const fs = require('fs'), path = require('path');
      const src = fs.readFileSync(path.join(__dirname, 'wellperf-names.test.js'), 'utf8');
      const head = src.slice(0, src.indexOf('module.exports'));
      const rq = (p) => require(p.startsWith('./') ? path.join(__dirname, p) : p);
      const N = new Function('require', 'module', head + '; return { patterns, scan };')(rq, {});
      const B = path.resolve(__dirname, '..');
      const files = fs.readdirSync(B).filter((f) => /^49-calc-(wd-[a-z]+|welldyn)\.js$/.test(f)).map((f) => path.join(B, f))
        .concat(fs.readdirSync(__dirname).filter((f) => /^(welldyn-.*\.test\.js|_welldyn-.*\.js|_wd3-mock\.js)$/.test(f) && f !== 'welldyn-int.test.js').map((f) => path.join(__dirname, f)))
        .concat([path.join(B, '..', 'docs', 'WELL-DYNAMICS-PLAN.md')]);
      assert.ok(files.length >= 13, 'file list ' + files.length);
      const bad = [];
      files.forEach((f) => { const h = N.scan(fs.readFileSync(f, 'utf8'), N.patterns()); if (h.length) bad.push(path.basename(f) + ': ' + h.length); });
      assert.deepStrictEqual(bad, []);
    },
  },
];
