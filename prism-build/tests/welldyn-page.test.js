// Well Dynamics WD3 — the page (docs/WELL-DYNAMICS-PLAN.md §2.1, §6, §7; PG1–PG24 on the stand-in engine tests/_wd3-mock.js).
// PG25–PG28 (a real 10-minute run of each fixture through the page) need the WD1 engine and are added at integration.
//
// PG1  registry entry, its own sidebar row in Production & Reservoir after the Well Performance hub row (not a hub member), the tile
// PG2  render + silent restore: one calc per open, the wd_* scenario values restored from the autosave, the page opens paused
// PG3  one shared model: read through WTS_wp_model (no copy), a Well Performance change is picked up; the page writes only dyn
// PG4  a well switch / project open stops and discards the run
// PG5  wts:wellperf-model-changed → "the well model changed — Rebuild" banner when a run has data; keys ['dyn'] ignored
// PG6  no auto-play, no timers: nothing pending after open and 5 s idle; refusals shown (no p̄r, NO_STEADY, missing engine)
// PG7  play / pause / step through frame(ts): simulated time = speed × wall; one requestAnimationFrame at a time
// PG8  stops on leaving the page and when hidden (paused, state kept); visible does not resume
// PG9  speed ×1–×1000 (+ / −, pref) and the achieved-speed note ("running slower than ×N")
// PG10 controls become events at the current time: bean, shut in / open, separator, foamer, lift
// PG11 scenario presets (steady, bean-up, shut-in build-up incl. the missing-parameter note, gas loading, foamer, intermittent,
//      gas-lift unloading, ESP start)
// PG12 events editor: future events only; a past time refused; delete
// PG13 scrub shows a recorded moment without touching the engine; Continue from here truncates and restores
// PG14 marks (button and M key), shown under the timeline, exported alone
// PG15 CSV dialog: columns (remembered), range, every, units; the download
// PG16 replay file save / open: the run is shown as stored, the stored well model is not changed; names escaped
// PG17 cases through the page: save with the well, list, load, delete
// PG18 cross-links both ways: #wd_go_wellperf → Well Performance; #wp_go_welldyn (step ⑤) and #wp_go_welldyn_k → Well Dynamics
// PG19 KPI strip per well type: oil, gas (rate / critical rate with both q_c), gas lift (casing pressure), ESP (pump intake)
// PG20 the report block (#wd_res) and the Quick Report snapshot ≤ 60 kB; PDF export with the disclaimer
// PG21 Metric mode: readouts and the CSV in metric units
// PG22 decimal comma: the CSV uses ';' and decimal commas
// PG23 keyboard map and ARIA: toolbar role, Play aria-pressed, the slider aria-valuetext, live region (state changes only), canvases role img
// PG24 phone layout rules at 390 px (one column, the chart select, toolbar options hidden) and no NaN / undefined in the page text
'use strict';

const { installWellDynMock } = require('./_wd3-mock');

const WP = 'WD3';
const BAD = /NaN|undefined|Infinity|\[object Object\]/;
const txt = (e) => String(e && e.textContent || '').replace(/\s+/g, ' ').trim();
const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
let _shared = null;
function app0(ctx, o) {
  const key = ctx.mode + JSON.stringify(o || null);
  if (_shared && _shared.key === key) return _shared.app;
  if (_shared && _shared.app && _shared.app.dispose) { try { _shared.app.dispose(); } catch (_) { /* ignore */ } }
  const app = ctx.loadApp({});
  installWellDynMock(app.win, o);
  _shared = { key, app };
  return app;
}
function loadWell(app, k) {
  const ex = app.win.WTS_wellperf_page.examples()[k || 'oil'];
  const tb = JSON.parse(JSON.stringify(ex.tables));
  if (tb.pump === 'example') tb.pump = plain(app.win.WTS_wp_esp.example());
  app.storage.removeItem('wts_wellperf_model');
  app.win.WTS_wp_model.write(app.toWin(tb));
  app.storage.setItem('wts_page_wellperf', JSON.stringify({ f: ex.scalars }));
}
function fresh(app) {
  const P = app.win.WTS_welldyn_page;
  if (P) P.pause();
  ['wts_page_welldyn', 'wtspref_wd_speed', 'wtspref_wd_tab', 'wtspref_wd_layer', 'wtspref_wd_cols'].forEach((k) => app.storage.removeItem(k));
  if (app.win.WTS_state) delete app.win.WTS_state.welldyn;
}
// open(app, k): load the example well k and start from a fresh simulator; open(app, null): re-open as the user would (a run in memory is kept)
function open(app, k) {
  if (k !== null) loadWell(app, k || 'oil');
  app.hook.nav('welldyn'); app.flush(30);
  if (k !== null) app.win.WTS_welldyn_page.build();
  return app.el('wd_root');
}
const P = (app) => app.win.WTS_welldyn_page;
function play(app, frames, dtMs) { P(app).play(); let ts = 1000; for (let i = 0; i < (frames || 30); i++) { ts += (dtMs || 50); P(app).frame(ts); } P(app).pause(); }
function leave(app) { P(app).pause(); app.hook.nav('home'); app.flush(30); }

module.exports = [
  {
    name: 'PG1 registry entry; its own row in Production & Reservoir right after the Well Performance hub row (not a hub member); a dashboard tile',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx);
      const e = app.win.WTS_calcRegistry.welldyn;
      assert.ok(e && e.key === 'welldyn' && e.title === 'Well Dynamics' && e.group === 'Production & Reservoir' && e.icon === '&#8767;' && e.hooks.silent === true);
      const b = app.find('#sidebar .nav-btn[data-p="welldyn"]');
      assert.ok(b && !b.classList.contains('nav-hub-member'), 'a sidebar row, not a hub member');
      const g = b.closest('.nav-group');
      const rows = Array.from(g.querySelectorAll('.nav-btn')).filter((x) => !x.classList.contains('nav-hub-member')).map((x) => x.getAttribute('data-p') || 'hub:' + x.getAttribute('data-hub'));
      assert.deepStrictEqual(rows, ['prism', 'oilgas', 'solgor', 'hub:perf', 'welldyn', 'buildup']);
      assert.ok(rows.length <= 8, 'group within 8 rows');
      app.hook.nav('home'); app.flush(30);
      const titles = app.findAll('.dash-card').map((c) => txt(c.querySelector('h3')));
      const i = titles.indexOf('Well Dynamics');
      assert.ok(i !== -1, 'home tile');
      assert.ok(i > titles.findIndex((x) => /Nodal Analysis/.test(x)) && i < titles.findIndex((x) => /Build-up Surveillance/.test(x)), 'tile in sidebar order: ' + titles.slice(i - 1, i + 2).join(' | '));
    },
  },
  {
    name: 'PG2 render and silent restore: one calc per open, the scenario values come back from the autosave, the page opens paused',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx); fresh(app);
      open(app);
      ['wd_toolbar', 'wd_timeline', 'wd_scrub', 'wd_kpis', 'wd_cv_well', 'wd_cv_nav', 'wd_tabs', 'wd_res', 'wd_rsum', 'wd_rinp', 'wd_cv_rwell', 'wd_cv_rtrend', 'wd_notesbox', 'wd_scen', 'wd_casecard', 'wd_go_wellperf'].forEach((id) => assert.ok(app.el(id), '#' + id));
      assert.ok(P(app).sim(), 'simulator built at open (paused)');
      assert.strictEqual(P(app).state().playing, false);
      assert.strictEqual(app.win.WTS_state.welldyn.playing, false);
      app.change('wd_dur', '6'); app.change('wd_cells', '80'); app.flush(1000);
      leave(app);
      const n0 = P(app).calcs();
      open(app, null);
      assert.strictEqual(P(app).calcs() - n0, 1, 'one calc per open');
      assert.strictEqual(app.el('wd_dur').value, '6'); assert.strictEqual(app.el('wd_cells').value, '80');
      assert.strictEqual(P(app).sim().grid.n, 80, 'the restored settings built the simulator');
      leave(app); fresh(app);
    },
  },
  {
    name: 'PG3 one shared model: read through WTS_wp_model (no copy); a Well Performance change is picked up; the page writes only the dyn key',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx); fresh(app);
      open(app);
      const M = P(app).sim().M;
      assert.strictEqual(M.res.pr, 3000); assert.strictEqual(M.fluid.gor, 500);
      const before = app.storage.getItem('wts_wellperf_model');
      play(app, 20);
      assert.strictEqual(app.storage.getItem('wts_wellperf_model'), before, 'running never writes the model');
      leave(app);
      const sc = JSON.parse(app.storage.getItem('wts_page_wellperf')); sc.f.wp_pr = 3200; app.storage.setItem('wts_page_wellperf', JSON.stringify(sc));
      open(app, null);
      assert.strictEqual(P(app).sim().M.res.pr, 3000, 'the recorded run keeps its frozen model');
      assert.match(txt(app.el('wd_banner')), /The well model changed in Well Performance/);
      app.click(app.find('#wd_banner [data-act="rebuild"]'));
      assert.strictEqual(P(app).sim().M.res.pr, 3200, 'the new p̄r is read');
      assert.match(txt(app.el('wd_model')), /✓ from Well Performance/);
      leave(app); fresh(app);
    },
  },
  {
    name: 'PG4 a well switch or a project open stops and discards the run',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx); fresh(app);
      open(app); play(app, 20);
      assert.ok(P(app).rec().count() > 2);
      P(app).play();
      app.fire('document', 'wts:well-changed', { id: 'w2' });
      assert.strictEqual(P(app).state().playing, false, 'stopped');
      assert.strictEqual(P(app).sim(), null, 'run discarded');
      open(app, null);
      assert.ok(P(app).sim() && P(app).sim().state.t === 0, 'a fresh simulator on the re-render');
      play(app, 10);
      app.fire('document', 'wts:project-loaded', { loaded: true });
      assert.strictEqual(P(app).sim(), null);
      leave(app); fresh(app);
    },
  },
  {
    name: 'PG5 the model changed in Well Performance → a Rebuild banner while a run has data (the run keeps its frozen model); keys [\'dyn\'] are ignored',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx); fresh(app);
      open(app); play(app, 20);
      const sim = P(app).sim();
      app.fire('document', 'wts:wellperf-model-changed', { keys: ['dyn'] });
      assert.ok(!/well model changed/.test(txt(app.el('wd_banner'))), 'dyn ignored');
      app.fire('document', 'wts:wellperf-model-changed', { keys: ['survey'] });
      assert.match(txt(app.el('wd_banner')), /The well model changed in Well Performance/);
      assert.strictEqual(P(app).sim(), sim, 'the run is kept');
      app.click(app.find('#wd_banner [data-act="rebuild"]'));
      assert.ok(P(app).sim() !== sim && P(app).sim().state.t === 0 && !/well model changed/.test(txt(app.el('wd_banner'))), 'rebuilt');
      // without data the page rebuilds on its own
      app.fire('document', 'wts:wellperf-model-changed', { keys: ['strings'] });
      assert.ok(!/well model changed/.test(txt(app.el('wd_banner'))));
      leave(app); fresh(app);
    },
  },
  {
    name: 'PG6 no auto-play and no timers: nothing pending after the open and 5 s idle; refusals are shown (p̄r missing, no steady root)',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx); fresh(app);
      open(app);
      app.flush(5000);
      assert.strictEqual(app.pendingTimers(), 0, 'no pending timers: ' + JSON.stringify(app.timers().map((t) => t.where)));
      assert.strictEqual(P(app).sim().state.t, 0, 'not started');
      leave(app);
      const sc = JSON.parse(app.storage.getItem('wts_page_wellperf')); delete sc.f.wp_pr; app.storage.setItem('wts_page_wellperf', JSON.stringify(sc));
      open(app, null);
      assert.match(txt(app.el('wd_banner')), /Set up this well in Well Performance first: average reservoir pressure p̄r needed/);
      assert.ok(app.find('#wd_banner [data-act="gowp"]'), 'a link to Well Performance');
      assert.match(txt(app.el('wd_model')), /✗ set up in Well Performance/);
      assert.strictEqual(app.consoleErrors().length, 0);
      leave(app); fresh(app);
    },
  },
  {
    name: 'PG7 play / pause / step through frame(ts): simulated time follows speed × wall time; Step advances one engine step; one frame request at a time',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx); fresh(app);
      open(app);
      P(app).speed(60);
      P(app).play();
      assert.strictEqual(app.el('wd_play').getAttribute('aria-pressed'), 'true');
      assert.strictEqual(app.pendingTimers(), 1, 'one requestAnimationFrame');
      let ts = 1000; P(app).frame(ts);
      for (let i = 0; i < 40; i++) { ts += 50; P(app).frame(ts); }
      assert.strictEqual(app.pendingTimers(), 1, 'still one');
      const t = P(app).sim().state.t;
      assert.within(t, 60 * 2 - 10, 60 * 2 + 10, 'about 120 s simulated in 2 s at ×60: ' + t);
      P(app).pause();
      assert.strictEqual(app.pendingTimers(), 0, 'no frame requested when paused');
      assert.strictEqual(app.el('wd_play').getAttribute('aria-pressed'), 'false');
      const t1 = P(app).sim().state.t;
      app.click('wd_step');
      assert.ok(P(app).sim().state.t > t1, 'one step');
      app.click('wd_play'); assert.ok(P(app).state().playing); app.click('wd_play'); assert.ok(!P(app).state().playing, 'the button toggles');
      leave(app); fresh(app);
    },
  },
  {
    name: 'PG8 leaving the page or hiding it stops the loop (paused, state kept); visible again does not resume',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx); fresh(app);
      open(app);
      P(app).play(); P(app).frame(1000); P(app).frame(1050);
      const t = P(app).sim().state.t;
      app.hook.nav('home'); app.flush(30);
      P(app).frame(1100);
      assert.strictEqual(app.pendingTimers(), 0, 'no frame requested off the page');
      open(app, null);
      P(app).play(); P(app).frame(2000);
      Object.defineProperty(app.document, 'hidden', { value: true, configurable: true });
      app.fire('document', 'visibilitychange', null);
      assert.strictEqual(P(app).state().playing, false, 'paused when hidden');
      assert.match(txt(app.el('wd_note')), /Paused: the page was hidden/);
      Object.defineProperty(app.document, 'hidden', { value: false, configurable: true });
      app.fire('document', 'visibilitychange', null);
      assert.strictEqual(P(app).state().playing, false, 'visible does not resume');
      assert.strictEqual(app.pendingTimers(), 0);
      assert.ok(t >= 0);
      leave(app); fresh(app);
    },
  },
  {
    name: 'PG9 speed ×1–×1000 (select, + / −, remembered per device) and the achieved-speed note when the engine is slower',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx, { slow: 20 }); fresh(app);
      open(app);
      assert.deepStrictEqual(Array.from(app.el('wd_speed').options).map((o) => o.value), ['1', '10', '60', '300', '1000']);
      app.change('wd_speed', '1000');
      assert.strictEqual(app.storage.getItem('wtspref_wd_speed'), '1000');
      app.key('wd_root', '-'); assert.strictEqual(P(app).state().speed, 300);
      app.key('wd_root', '+'); assert.strictEqual(P(app).state().speed, 1000);
      P(app).play();
      let ts = 1000; for (let i = 0; i < 40; i++) { ts += 30; P(app).frame(ts); }
      const ach = P(app).state().ach.val;
      assert.ok(Number.isFinite(ach) && ach < 800, 'achieved speed measured: ' + ach);
      P(app).frame(ts + 30); for (let i = 0; i < 6; i++) { ts += 30; P(app).frame(ts); }
      assert.match(txt(app.el('wd_kpis')), /running slower than ×1000/);
      P(app).pause();
      leave(app); fresh(app);
    },
  },
  {
    name: 'PG10 controls become events at the current time: bean, shut in / open, separator, foamer and lift (source user)',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx); fresh(app);
      open(app); play(app, 10);
      const t0 = P(app).sim().state.t;
      app.change('wd_bean', '24'); app.click('wd_bean_go');
      app.click('wd_shut'); assert.strictEqual(txt(app.el('wd_shut')), 'Open');
      app.input('wd_psep', '150'); app.click('wd_psep_go');
      P(app).step();
      const ev = P(app).rec().events();
      assert.deepStrictEqual(plain(ev.map((e) => e.type)), ['bean', 'shutin', 'psep']);
      ev.forEach((e) => { assert.strictEqual(e.src, 'user'); assert.strictEqual(e.t, t0); });
      assert.strictEqual(ev[0].args.bean64, 24); assert.strictEqual(ev[2].args.psig, 150);
      assert.strictEqual(P(app).sim().state.open, false);
      app.click('wd_shut'); P(app).step();
      assert.strictEqual(P(app).sim().state.open, true, 'opened again');
      leave(app);
      // gas well: foamer
      open(app, 'gas');
      assert.ok(app.el('wd_foam_w').style.display !== 'none', 'foamer shown for a gas well');
      app.click('wd_foam_on'); P(app).step();
      assert.strictEqual(P(app).rec().events().slice(-1)[0].type, 'foamer');
      leave(app);
      // gas lift: lift-gas rate
      open(app, 'gl');
      assert.ok(app.el('wd_lift_gl').style.display !== 'none' && app.el('wd_lift_esp').style.display === 'none');
      app.input('wd_glq', '900'); app.click('wd_lift_go'); P(app).step();
      const e = P(app).rec().events().slice(-1)[0];
      assert.strictEqual(e.type, 'gl'); assert.strictEqual(e.args.qinj_Mscfd, 900);
      leave(app); fresh(app);
    },
  },
  {
    name: 'PG11 scenario presets set the start, options and events; the shut-in build-up preset names the missing reservoir values or switches to transient',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx); fresh(app);
      open(app);
      const PR = (k) => P(app).scenario(k);
      let r = PR('beanup');
      assert.deepStrictEqual(plain(r.events.map((e) => [e.t, e.type])), [[0, 'bean'], [3600, 'bean'], [7200, 'bean']]);
      assert.strictEqual(r.events[2].args.bean64, 32, 'back to the model bean');
      assert.strictEqual(app.el('wd_dur').value, '4');
      r = PR('shutin');
      assert.match(r.note, /Transient reservoir needs k, h, phi, ct, rw, re/);
      assert.strictEqual(app.el('wd_resmode').value, 'ipr');
      ['wd_k', 'wd_h', 'wd_phi', 'wd_ct', 'wd_mu', 'wd_B', 'wd_rw', 'wd_re'].forEach((id, i) => { app.el(id).value = String([50, 50, 0.2, 1.5e-5, 1, 1.2, 0.354, 1500][i]); });
      r = PR('shutin');
      assert.strictEqual(app.el('wd_resmode').value, 'transient'); assert.strictEqual(r.note, '');
      assert.strictEqual(P(app).sim().opts.reservoir.mode, 'transient');
      assert.strictEqual(P(app).sim().opts.reservoir.prior.kind, 'steady');
      r = PR('gasload'); assert.ok(app.el('wd_fallback').checked && /meant for a gas well/.test(r.note));
      r = PR('foamer'); assert.strictEqual(r.events[0].type, 'foamer'); assert.strictEqual(r.events[0].args.ppm, 1000);
      r = PR('cycle'); assert.deepStrictEqual(plain(r.events[0].args), { mode: 'timer', open_h: 2, shut_h: 2, cycles: 3 });
      r = PR('glunload'); assert.strictEqual(app.el('wd_start').value, 'static'); assert.strictEqual(P(app).sim().opts.reservoir.prior.kind, 'none');
      assert.match(r.note, /Set gas lift/);
      // WD4: the static-start lift presets open the well at t = 0 (a static start is shut in), then the lift command
      assert.deepStrictEqual(plain(r.events.map((e) => e.type)), ['open', 'gl'], 'gas-lift unloading opens the well with the lift gas on');
      r = PR('espstart'); assert.deepStrictEqual(plain(r.events.map((e) => e.type)), ['open', 'esp']);
      r = PR('steady'); assert.strictEqual(r.events.length, 0); assert.strictEqual(app.el('wd_start').value, 'steady');
      assert.ok(app.el('wd_evbody').querySelectorAll('tr').length >= 1);
      leave(app); fresh(app);
    },
  },
  {
    name: 'PG12 events editor: future events only (a past time is refused), listed with the applied log; delete',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx); fresh(app);
      open(app);
      app.input('wd_ev_t', '0.5'); app.select('wd_ev_type', 'bean'); app.input('wd_ev_v', '24');
      app.click(app.find('[data-act="evadd"]'));
      assert.strictEqual(P(app).state().events.length, 1);
      assert.match(txt(app.el('wd_evbody')), /0:30:00\s*Bean 24\/64/);
      app.input('wd_ev_t', '2'); app.select('wd_ev_type', 'shutin'); app.click(app.find('[data-act="evadd"]'));
      assert.strictEqual(P(app).state().events.length, 2);
      const del = app.findAll('#wd_evbody [data-act="evdel"]');
      app.click(del[del.length - 1]);
      assert.strictEqual(P(app).state().events.length, 1, 'deleted');
      assert.ok(!/Shut in/.test(txt(app.el('wd_evbody'))));
      play(app, 25, 100);                                  // 25 × 0.1 s × 60 → 150 s
      app.input('wd_ev_t', '0.01'); app.click(app.find('[data-act="evadd"]'));
      assert.match(txt(app.el('wd_note')), /Events in the past cannot be added/);
      assert.strictEqual(P(app).state().events.length, 1);
      app.input('wd_ev_t', '1'); app.select('wd_ev_type', 'shutin'); app.click(app.find('[data-act="evadd"]'));
      assert.strictEqual(P(app).state().events.length, 2);
      P(app).sim().run(3700); app.win.calcWellDyn();
      assert.deepStrictEqual(plain(P(app).rec().events().map((e) => e.type)), ['bean', 'shutin'], 'both applied');
      assert.match(txt(app.el('wd_evbody')), /applied/);
      assert.ok(!app.find('#wd_evbody [data-act="evdel"]'), 'applied events are read-only');
      leave(app); fresh(app);
    },
  },
  {
    name: 'PG13 scrub shows a recorded moment (the engine is not touched); Continue from here truncates the recording and restores the engine',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx); fresh(app);
      open(app);
      P(app).sim().schedule(app.toWin([{ t: 600, type: 'shutin', args: {} }]));
      P(app).sim().run(1800);
      const tEnd = P(app).sim().state.t;
      P(app).scrub(300);
      assert.strictEqual(P(app).sim().state.t, tEnd, 'engine untouched');
      assert.match(txt(app.el('wd_kpis')), /0:05:00/);
      assert.match(txt(app.el('wd_kpis')), /recorded moment/);
      assert.ok(app.el('wd_cont').style.display !== 'none', 'Continue shown');
      assert.match(app.el('wd_scrub').getAttribute('aria-valuetext'), /^5 min — /);
      const n0 = app.dialogs.length;
      app.click('wd_cont');
      assert.ok(app.dialogs.length > n0 && /Continue from 0:05:00/.test(app.dialogs[app.dialogs.length - 1].message), 'confirmed (later data exist)');
      assert.strictEqual(P(app).sim().state.t, 300); assert.ok(P(app).rec().span()[1] <= 300);
      assert.strictEqual(P(app).state().scrubT, null);
      assert.strictEqual(P(app).rec().events().length, 0, 'the later shut-in left the log');
      P(app).sim().run(600);
      assert.ok(P(app).sim().state.t >= 900);
      app.key('wd_root', 'Home'); assert.strictEqual(P(app).state().scrubT, P(app).rec().span()[0]);
      app.key('wd_root', 'End'); assert.strictEqual(P(app).state().scrubT, null);
      leave(app); fresh(app);
    },
  },
  {
    name: 'PG14 marks with the button and the M key: listed under the timeline, removed, exported alone',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx); fresh(app);
      open(app); P(app).sim().run(600); P(app).sim().state; app.win.calcWellDyn();
      app.click('wd_mark'); assert.strictEqual(app.el('wd_mark').getAttribute('aria-pressed'), 'true');
      P(app).sim().run(600); app.click('wd_mark');
      app.key('wd_root', 'm'); P(app).sim().run(300); app.key('wd_root', 'M');
      const mk = P(app).rec().marks();
      assert.strictEqual(mk.length, 2);
      assert.strictEqual(mk[0].t0, 600); assert.strictEqual(mk[0].t1, 1200);
      assert.match(txt(app.el('wd_marks')), /Mark 1 0:10:00–0:20:00/);
      const nd = app.downloads.length;
      app.click(app.find('#wd_marks [data-act="csvmark"]'));
      const d = app.downloads[nd];
      assert.ok(d && /\.csv$/.test(d.filename), 'CSV of the window');
      const rows = String(d.content).split('\r\n').filter((l) => /^\d/.test(l));
      assert.ok(rows.every((l) => +l.split(',')[0] >= 600 && +l.split(',')[0] <= 1200), 'only the window');
      app.click(app.find('#wd_marks [data-act="unmark"]'));
      assert.strictEqual(P(app).rec().marks().length, 1);
      leave(app); fresh(app);
    },
  },
  {
    name: 'PG15 CSV dialog: columns (remembered per device), range, every, units; the download',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx); fresh(app);
      open(app); P(app).sim().run(1800);
      app.click(app.find('[data-act="csvopen"]'));
      assert.ok(app.el('wd_csvbox').style.display !== 'none');
      app.findAll('#wd_csvcols input').forEach((c) => { c.checked = ['thp', 'qL'].indexOf(c.getAttribute('data-col')) !== -1; });
      app.input('wd_csv_from', '0.1'); app.input('wd_csv_to', '0.3'); app.input('wd_csv_every', '120');
      const nd = app.downloads.length;
      app.click(app.find('[data-act="csvgo"]'));
      const d = app.downloads[nd];
      assert.ok(d && /^well_dynamics_.*\.csv$/.test(d.filename), 'downloaded: ' + (d && d.filename));
      const L = String(d.content).split('\r\n');
      assert.strictEqual(L[1], 'Time (s),THP (psig),Liquid rate (STB/d),Time (h:mm:ss)');
      const rows = L.filter((l) => /^\d/.test(l));
      assert.ok(rows.length >= 5 && rows.length <= 7 && +rows[0].split(',')[0] === 360, 'range and every: ' + rows.map((r) => r.split(',')[0]).join(' '));
      assert.strictEqual(app.storage.getItem('wtspref_wd_cols'), 'thp,qL');
      app.click(app.find('[data-act="csvclose"]'));
      assert.strictEqual(app.el('wd_csvbox').style.display, 'none');
      leave(app); fresh(app);
    },
  },
  {
    name: 'PG16 replay file: Save downloads a .wdrun; Open shows the run as stored without changing the stored well model; names are escaped',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx); fresh(app);
      open(app); P(app).sim().run(1200);
      const nd = app.downloads.length;
      app.click(app.find('[data-act="saverun"]'));
      const d = app.downloads[nd];
      assert.ok(d && /\.wdrun$/.test(d.filename) && d.type === 'application/json', 'saved: ' + (d && d.filename));
      const run = JSON.parse(d.content);
      assert.strictEqual(run.format, 'wts-welldyn-run');
      assert.ok(run.model.scalars.wp_pr === 3000 && run.model.tables.survey.length === 3, 'the model travels as scalars + tables');
      run.well.name = '<img src=x onerror=alert(1)>';
      const before = app.storage.getItem('wts_wellperf_model') + app.storage.getItem('wts_page_wellperf');
      const r = P(app).load(JSON.stringify(run));
      assert.ok(r.ok);
      assert.strictEqual(app.storage.getItem('wts_wellperf_model') + app.storage.getItem('wts_page_wellperf'), before, 'stored model unchanged');
      assert.ok(!app.find('#wd_root img'), 'the name is text, not markup');
      assert.match(txt(app.el('wd_model')), /<img src=x/);
      assert.match(txt(app.el('wd_banner')), /Replay of "<img/);
      assert.ok(P(app).state().scrubT === 1200 && /0:20:00/.test(txt(app.el('wd_kpis'))), 'shown at its end');
      assert.ok(app.el('wd_play').disabled, 'a replay is not played; Continue from here or Re-run');
      P(app).scrub(600); app.click('wd_cont');
      assert.ok(P(app).sim() && P(app).sim().state.t === 600, 'continued from the file snapshot');
      app.click(app.find('[data-act="closerun"]'));
      assert.strictEqual(P(app).state().run, null);
      const bad = P(app).load('{"format":"other"}');
      assert.ok(!bad.ok && /could not be opened/.test(txt(app.el('wd_note'))));
      leave(app); fresh(app);
    },
  },
  {
    name: 'PG17 cases through the page: saved with the well (dyn key), listed, loaded, deleted',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx); fresh(app);
      open(app);
      P(app).scenario('beanup'); P(app).sim().run(600);
      app.input('wd_case_name', 'Bean-up <b>');
      app.click(app.find('[data-act="casesave"]'));
      assert.match(txt(app.el('wd_note')), /Case "Bean-up <b>" saved with this well/);
      const M = app.win.WTS_wp_model.read();
      assert.strictEqual(M.dyn.cases.length, 1);
      assert.ok(M.dyn.cases[0].summary && M.dyn.cases[0].events.length === 3);
      assert.ok(!app.find('#wd_cases b'), 'escaped');
      assert.match(txt(app.el('wd_cases')), /Bean-up <b>/);
      P(app).scenario('steady');
      assert.strictEqual(P(app).state().events.length, 0);
      app.click(app.find('#wd_cases [data-act="caseload"]'));
      assert.strictEqual(P(app).state().events.length, 3, 'events back');
      assert.strictEqual(app.el('wd_dur').value, '4');
      app.click(app.find('#wd_cases [data-act="casedel"]'));
      assert.strictEqual(app.win.WTS_wp_model.read().dyn.cases.length, 0);
      leave(app); fresh(app);
    },
  },
  {
    name: 'PG18 cross-links both ways: Back to nodal analysis → wellperf; ▶ Play in time (step ⑤ and by the KPI strip) → welldyn',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx); fresh(app);
      open(app);
      app.click('wd_go_wellperf'); app.flush(30);
      assert.ok(app.el('wp_root'), 'on Well Performance');
      const b = app.el('wp_go_welldyn'), k = app.el('wp_go_welldyn_k');
      assert.ok(b && b.classList.contains('rp-skip') && b.closest('#wp_step_5'), 'in the step ⑤ header');
      assert.ok(k && k.closest('.rp-skip'), 'by the KPI strip');
      app.click(k); app.flush(30);
      assert.ok(app.el('wd_root'), 'on Well Dynamics');
      app.click('wd_go_wellperf'); app.flush(30); app.click('wp_go_welldyn'); app.flush(30);
      assert.ok(app.el('wd_root'));
      leave(app); fresh(app);
    },
  },
  {
    name: 'PG19 KPI strip per well type: oil (liquid rate), gas (rate / critical rate with both q_c), gas lift (casing pressure), ESP (pump intake)',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx); fresh(app);
      const labels = () => app.findAll('#wd_kpis .kpi-l').map(txt);
      open(app, 'oil');
      assert.deepStrictEqual(labels(), ['Well state', 'Liquid rate', 'THP', 'BHP', 'Liquid in the well', 'Time']);
      leave(app);
      open(app, 'gas');
      assert.deepStrictEqual(labels(), ['Well state', 'Gas rate', 'THP', 'BHP', 'Rate / critical rate', 'Liquid in the well', 'Time']);
      const kk = app.findAll('#wd_kpis .kpi')[4];
      assert.match(txt(kk), /vertical · .* Belfroid/);
      assert.ok(!/in use/.test(txt(kk)), 'Belfroid off by default');
      leave(app);
      open(app, 'gl');
      assert.ok(labels().indexOf('Casing pressure') !== -1);
      leave(app);
      open(app, 'esp');
      assert.ok(labels().indexOf('Pump intake') !== -1);
      assert.ok(app.el('wd_lift_esp').style.display !== 'none');
      app.findAll('#wd_kpis').forEach((e) => assert.ok(!BAD.test(txt(e)), txt(e)));
      leave(app); fresh(app);
    },
  },
  {
    name: 'PG20 the report block (#wd_res): inputs, run summary, KPI chips, the two canvases at fixed sizes, states, checks, provisional list, Notes; Quick Report ≤ 60 kB; PDF with the disclaimer',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx); fresh(app);
      open(app);
      P(app).sim().schedule(app.toWin([{ t: 1800, type: 'shutin', args: {} }]));
      play(app, 60, 100);
      P(app).sim().run(3600); app.click('wd_step');
      P(app).pause();
      const res = app.el('wd_res');
      assert.match(txt(app.el('wd_rinp')), /Inputs\s*Well.*Start\s*steady flow at the nodal operating point.*Nodal operating point\s*914 STB\/d at 2,543 psia/);
      assert.match(txt(app.el('wd_rsum')), /Run summary\s*Duration\s*1 h \d+ min\s*State at the end\s*Shut in/);
      assert.match(txt(app.el('wd_rstates')), /Start-up.*Shut in/);
      assert.match(txt(app.el('wd_rprov')), /provisional — not verified against a published example/);
      assert.match(txt(app.el('wd_rverd')), /Mass balance error/);
      assert.match(txt(app.el('wd_notesbox')), /^Notes /);
      assert.ok(!res.classList.contains('rp-skip') && !res.closest('.rp-skip'), 'the report block is reported');
      assert.ok(app.el('wd_toolbar').classList.contains('rp-skip') && app.el('wd_timeline').classList.contains('rp-skip'));
      const m = app.win.collectPageReport(app.el('pgBody'), { charts: true });
      const js = JSON.stringify(m);
      assert.ok(js.indexOf('Run summary') !== -1 && js.indexOf('Inputs') !== -1 && js.indexOf('Notes') !== -1);
      assert.ok(js.indexOf('wd_toolbar') === -1 && js.indexOf('Apply preset') === -1, 'controls skipped');
      const snaps = JSON.parse(app.storage.getItem('wts_report_snapshots') || '{}');
      assert.ok(snaps.welldyn, 'Quick Report snapshot taken on pause');
      const n = JSON.stringify(snaps.welldyn).length;
      assert.ok(n <= 60 * 1024, 'snapshot ' + n + ' bytes ≤ 60 kB');
      const k = app.opened.length;
      app.win.exportPagePDF();
      const pdf = app.opened[k] && app.opened[k].html();
      assert.ok(pdf && pdf.indexOf('Well Dynamics') !== -1 && pdf.indexOf('Run summary') !== -1, 'PDF export');
      assert.ok(pdf.indexOf('Results are engineering estimates') !== -1, 'disclaimer');
      leave(app); fresh(app);
    },
  },
  {
    name: 'PG21 Metric mode: KPIs, the run summary and the CSV in metric units; back to field units',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx); fresh(app);
      const U = app.win.WTS_units;
      open(app); P(app).sim().run(600); app.win.calcWellDyn();
      try {
        U.setSystem('metric'); app.fire('document', 'wts:unit-system-changed', {});
        const k = txt(app.el('wd_kpis'));
        assert.ok(k.indexOf(U.CATEGORIES.pressureG.metric.label) !== -1 && k.indexOf(U.CATEGORIES.liquidRate.metric.label) !== -1, 'metric KPIs: ' + k);
        assert.ok(!/psig|STB\/d/.test(k), 'no field labels');
        assert.ok(txt(app.el('wd_rsum')).indexOf(U.CATEGORIES.pressure.metric.label) !== -1);
        app.click(app.find('[data-act="csvopen"]'));
        assert.strictEqual(app.el('wd_csv_sys').value, 'field', 'the select was rendered in field mode');
        app.select('wd_csv_sys', 'metric');
        const c = P(app).csv();
        assert.ok(c.split('\r\n')[1].indexOf(U.CATEGORIES.pressureG.metric.label) !== -1);
        assert.ok(!BAD.test(txt(app.el('wd_root'))));
      } finally { U.setSystem('imperial'); app.fire('document', 'wts:unit-system-changed', {}); }
      assert.match(txt(app.el('wd_kpis')), /psig/);
      leave(app); fresh(app);
    },
  },
  {
    name: 'PG22 decimal comma: the page CSV uses ";" separators and decimal commas',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx); fresh(app);
      open(app); P(app).sim().run(300);
      const A = app.win.WTS_a11y;
      try {
        A.decimalComma(true);
        const L = P(app).csv({ cols: ['thp', 'pwf'] }).split('\r\n');
        assert.strictEqual(L[1], 'Time (s);THP (psig);BHP (psia);Time (h:mm:ss)');
        assert.ok(/^\d+;\d+,\d;\d+,\d;\d+:\d\d:\d\d$/.test(L[2]), L[2]);
      } finally { A.decimalComma(false); }
      leave(app); fresh(app);
    },
  },
  {
    name: 'PG23 keyboard and ARIA: Space / . / ← → / [ ] / S; toolbar role, Play aria-pressed, slider aria-valuetext, a live region for state changes only, canvases role img',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx); fresh(app);
      open(app);
      assert.strictEqual(app.el('wd_toolbar').getAttribute('role'), 'toolbar');
      assert.ok(app.el('wd_play').hasAttribute('aria-keyshortcuts'));
      ['wd_cv_well', 'wd_cv_nav', 'wd_cv_rwell', 'wd_cv_rtrend'].forEach((id) => assert.strictEqual(app.el(id).getAttribute('role'), 'img', id));
      assert.strictEqual(app.el('wd_live').getAttribute('aria-live'), 'polite');
      app.key('wd_root', ' '); assert.ok(P(app).state().playing, 'Space plays');
      app.key('wd_root', ' '); assert.ok(!P(app).state().playing, 'Space pauses');
      app.key('wd_root', '.'); const t1 = P(app).sim().state.t; assert.ok(t1 > 0, '. steps');
      P(app).sim().run(900); app.win.calcWellDyn();
      assert.match(txt(app.el('wd_live')), /Well state: Stable at 0:10:\d\d/, 'the state change announced');
      const live0 = txt(app.el('wd_live')); P(app).sim().run(60); assert.strictEqual(txt(app.el('wd_live')), live0, 'nothing announced without a state change');
      app.key('wd_root', 'ArrowLeft');
      assert.ok(P(app).state().scrubT !== null, '← scrubs back');
      app.key('wd_root', ']'); assert.strictEqual(P(app).state().tab, 'press');
      app.key('wd_root', '['); assert.strictEqual(P(app).state().tab, 'rates');
      app.key('wd_root', 's'); assert.strictEqual(txt(app.el('wd_shut')), 'Open');
      assert.ok(app.findAll('#wd_tabs [role="tab"]').length === 7);
      leave(app); fresh(app);
    },
  },
  {
    name: 'PG24 phone layout rules (≤ 600 px: one column, chart select, less-used toolbar items hidden); page text clean of NaN / undefined',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx); fresh(app);
      open(app, 'gas'); P(app).sim().run(900); app.win.calcWellDyn();
      const css = app.find('#wd_root').parentNode.querySelector('style').textContent;
      assert.ok(/@media \(max-width:600px\)\{#wd_root \.wd-tb\{padding:6px\}#wd_root \.wd-tb \.wd-opt\{display:none\}/.test(css), 'toolbar options hidden on a phone');
      assert.ok(/#wd_root \.wd-tabsel\{display:block;width:100%\}/.test(css), 'the chart tabs become a select');
      assert.ok(/@media \(max-width:1100px\)\{#wd_root \.wd-main,#wd_root \.wd-cards,#wd_root \.wd-rgrid\{grid-template-columns:minmax\(0,1fr\)\}/.test(css), 'one column');
      assert.ok(/\.wd-tw\{overflow-x:auto;max-width:100%\}/.test(css), 'tables scroll inside their cards');
      app.resize(390, 844);
      app.win.calcWellDyn();
      ['wd_root'].forEach((id) => assert.ok(!BAD.test(txt(app.el(id))), id + ': ' + (txt(app.el(id)).match(BAD) || [''])[0]));
      app.select('wd_tabsel', 'press'); assert.strictEqual(P(app).state().tab, 'press');
      app.resize(1280, 800);
      assert.strictEqual(app.consoleErrors().length, 0, JSON.stringify(app.consoleErrors()).slice(0, 300));
      leave(app); fresh(app);
    },
  },
];
