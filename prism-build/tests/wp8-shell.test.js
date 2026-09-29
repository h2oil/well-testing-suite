// WP8 — Shell (five-step workflow, C7 registries) + Tab 1 data flow (01, 07, 12).
//
// Unit tests stub other work packages' window APIs (PRiSM_renderRail,
// PRiSM_analyse, PRiSM_setWell, …) so they test the shell on its own;
// tests that rely on another WP's real code are marked integration:true.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const OWN_FILES = /prism-build\/(01-foundation|07-data-enhancements|12-data-crop)\.js/;
const SAMPLE_P0 = 3861.4;

// Errors thrown by WP8 code (top stack frame mapped to a source file).
function ownErrors(app, ctx) {
  return app.errors.filter((e) => {
    const m = /wts-main\.js:(\d+)/.exec(String(e.stack || ''));
    if (!m) return false;
    return OWN_FILES.test(ctx.harness.fileAtLine(app.mainScript, +m[1]));
  });
}

// Record window CustomEvents of the given types in the app realm.
function recordEvents(app, types) {
  app.evalInApp('window.__wp8ev = window.__wp8ev || {};');
  types.forEach((t) => {
    app.evalInApp("window.__wp8ev['" + t + "'] = []; window.addEventListener('" + t + "', function (e) { window.__wp8ev['" + t + "'].push(e.detail || null); });");
  });
  return (t) => app.win.__wp8ev[t];
}

function visible(app, id) {
  const e = app.el(id);
  return !!e && e.style.display !== 'none';
}

function setText(app, text) {
  app.el('prism_data_paste').value = text;
}

// Load 01-foundation.js on its own (no host) to reach the model functions.
function loadFoundation() {
  const src = fs.readFileSync(path.join(__dirname, '..', '01-foundation.js'), 'utf8');
  const sandbox = { console: { log() {}, error() {}, warn() {} } };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: '01-foundation.js' });
  return vm.runInContext('({ pd: PRiSM_model_homogeneous, dpd: PRiSM_model_homogeneous_pd_prime })', sandbox);
}

module.exports = [
  // ── (a) enhanced Data tab everywhere ─────────────────────────────────────
  {
    name: 'a. enhanced Tab 1 on first render, after setMode, after re-navigation and after 40 s idle',
    wp: 'WP8',
    run(app, assert) {
      app.openPRiSM();
      assert.ok(app.el('prism_units_card'), 'first render: #prism_units_card');
      assert.ok(app.el('prism_crop_tool_host'), 'crop tool host mounted');
      assert.ok(app.el('prism_tab_1_panels').contains(app.el('prism_crop_tool_host')), 'crop is a Tab 1 panel');
      assert.ok(visible(app, 'prism_tab_1'), 'step 1 shows tab 1');

      // A wrapper around setTab survives re-renders (setTab is not re-created).
      const orig = app.win.PRiSM.setTab;
      let wrapped = 0;
      app.win.PRiSM.setTab = function (n) { wrapped++; return orig(n); };
      app.win.PRiSM.setMode('combined');
      app.win.PRiSM.setTab(1);
      assert.equal(wrapped, 1, 'setTab wrapper kept across setMode');

      app.win.PRiSM.setMode('decline');
      assert.equal(app.win.PRiSM.mode, 'decline');
      assert.ok(app.el('prism_units_card'), 'after setMode(decline)');
      assert.equal(app.el('prism_data_parse').onclick, app.win.PRiSM_doParseData);

      app.hook.nav('home');
      assert.ok(!app.el('prism_shell'), 'left PRiSM');
      app.openPRiSM();
      assert.ok(app.el('prism_units_card'), 'after re-navigation');

      app.flush(40000);
      assert.ok(app.el('prism_units_card'), 'after 40 s idle');
      assert.ok(app.el('prism_tab_1').innerHTML.indexOf('prism_units_card') !== -1);
      assert.equal(app.el('prism_data_parse').onclick, app.win.PRiSM_doParseData, 'Parse still bound to the enhanced function');
      assert.ok(app.el('prism_crop_tool_host'));
    },
  },

  // ── (b) reload restores the dataset without clicking anything ────────────
  {
    name: 'b. reload: dataset auto-promoted from the persisted text (55 points), Tab 2 has data',
    wp: 'WP8',
    run(app, assert, ctx) {
      app.openPRiSM();
      app.flush(1000);
      assert.equal(app.win.PRiSM_dataset.t.length, 55);

      const b = ctx.loadApp({ storage: app.storage });
      assert.ok(!b.win.PRiSM_dataset, 'fresh session starts empty');
      b.openPRiSM();
      const ds = b.win.PRiSM_dataset;
      assert.ok(ds && ds.t && ds.t.length === 55, 'dataset restored without clicking');
      assert.near(ds.p[0], SAMPLE_P0, 1e-9);
      assert.equal(ds.name, 'Demo data');
      assert.equal(ds.source, 'sample');
      b.win.PRiSM_gotoStep(3);
      const html = b.el('prism_tab_2').innerHTML;
      assert.ok(html.indexOf('No data loaded') === -1 && html.indexOf('No dataset') === -1, 'Tab 2 has no "no data" banner');
    },
  },
  {
    name: 'b2. reload keeps a loaded file (name, rate-only shape) and never re-seeds over it',
    wp: 'WP8',
    timeoutMs: 60000,
    async run(app, assert, ctx) {
      const text = 'Date,Production\n2024-01-01,1000\n2024-01-02,950\n2024-01-03,905\n2024-01-04,870\n';
      const file = new app.win.File([text], 'field.csv');
      const pr = app.win.PRiSM_loadFile(file);        // no Data tab on screen
      await app.flushAsync(10);
      const ds = await pr;
      assert.ok(ds && ds.t.length === 4, 'loadFile commits without the tab on screen');
      assert.equal(ds.name, 'field.csv');
      assert.equal(ds.p, null);
      assert.deepEqual(Array.from(ds.t), [0, 24, 48, 72]);
      assert.equal(app.win.PRiSM_dataset, ds);

      const b = ctx.loadApp({ storage: app.storage });
      b.openPRiSM();
      const r = b.win.PRiSM_dataset;
      assert.ok(r && r.t.length === 4, 'restored');
      assert.equal(r.name, 'field.csv');
      assert.equal(r.p, null);
      assert.near(r.q[3], 870, 1e-9);
    },
  },

  // ── (c) wiring: Parse = commit ───────────────────────────────────────────
  {
    name: 'c. Parse button is window.PRiSM_doParseData; message "Parsed 55 rows (3 cols)"; one dataset-loaded',
    wp: 'WP8',
    run(app, assert, ctx) {
      app.openPRiSM();
      const ev = recordEvents(app, ['prism:dataset-loaded']);
      assert.equal(app.el('prism_data_parse').onclick, app.win.PRiSM_doParseData);
      app.click('prism_data_parse', { allowErrors: true });
      assert.includes(app.el('prism_data_msg').textContent, 'Parsed 55 rows (3 cols)');
      assert.equal(ev('prism:dataset-loaded').length, 1, 'fired exactly once on Parse');
      const d = ev('prism:dataset-loaded')[0];
      assert.equal(d.dataset, app.win.PRiSM_dataset);
      assert.equal(app.win.PRiSM_dataset.t.length, 55);
      assert.equal(app.win.PRiSM_dataset.timeUnit, 'h');
      // The API commit (doUseData) also fires once.
      app.win.PRiSM_doUseData();
      assert.equal(ev('prism:dataset-loaded').length, 2);
      assert.ok(!app.el('prism_data_use'), 'no separate "use this data" button');
      assert.equal(ownErrors(app, ctx).length, 0);
    },
  },

  // ── (d) column mapping ───────────────────────────────────────────────────
  {
    name: 'd. mapping: time,rate / days,oil_rate / time,oil,gas / Date,Production / time,pressure,rate',
    wp: 'WP8',
    run(app, assert, ctx) {
      const W = app.win;
      const map = (text) => { const r = W.PRiSM_parseTextEnhanced(text); return Array.from(W.PRiSM_autoMapColumns(r.headers, r.rows, r.dateCols)); };
      assert.deepEqual(map('time,rate\n0,500\n1,480\n2,470\n3,460\n4,450\n'), ['time', 'rate']);
      assert.deepEqual(map('days,oil_rate\n1,900\n2,850\n3,810\n'), ['time', 'rate_o']);
      assert.deepEqual(map('time,oil,gas\n1,900,1500\n2,850,1450\n'), ['time', 'rate_o', 'rate_g']);
      assert.deepEqual(map('Date,Production\n2024-01-01,900\n2024-02-01,850\n'), ['time', 'rate']);
      assert.deepEqual(map(W.PRiSM_DEFAULT_SAMPLE_CSV), ['time', 'pressure', 'rate']);
      assert.deepEqual(map('0.01,3861.4,850\n0.02,3705,850\n0.03,3600,850\n'), ['time', 'pressure', 'rate'], 'header-less keeps t,p,q');

      // End to end through the Data tab.
      app.openPRiSM();
      const parse = (text) => { setText(app, text); app.click('prism_data_parse', { allowErrors: true }); return W.PRiSM_dataset; };
      let ds = parse('time,rate\n0,500\n1,480\n2,470\n3,460\n4,450\n');
      assert.equal(ds.p, null, 'time,rate → no pressure');
      assert.deepEqual(Array.from(ds.q), [500, 480, 470, 460, 450]);
      ds = parse('days,oil_rate\n1,900\n2,850\n3,810\n');
      assert.deepEqual(Array.from(ds.q), [900, 850, 810], 'ds.q filled from oil');
      assert.deepEqual(Array.from(ds.t), [24, 48, 72], 'days → hours');
      assert.equal(ds.timeUnitOriginal, 'd');
      assert.equal(ds.ratePhase, 'oil');
      ds = parse('time,oil,gas\n1,900,1500\n2,850,1450\n3,800,1400\n');
      assert.deepEqual(Array.from(ds.q), [900, 850, 800], 'ds.q = oil');
      assert.deepEqual(Array.from(ds.phases.gas), [1500, 1450, 1400]);
      ds = parse('Date,Production\n2024-01-01,900\n2024-01-02,850\n2024-01-03,800\n');
      assert.deepEqual(Array.from(ds.t), [0, 24, 48], 'dates → hours from the first stamp');
      assert.deepEqual(Array.from(ds.q), [900, 850, 800]);
      ds = parse(W.PRiSM_DEFAULT_SAMPLE_CSV);
      assert.equal(ds.t.length, 55);
      assert.near(ds.p[0], SAMPLE_P0, 1e-9);
      assert.ok(Array.from(ds.q).every((q) => q === 850));
      assert.equal(ownErrors(app, ctx).length, 0);
    },
  },
  {
    name: 'd2. units: psig offset, gas MMscf/d → Mscf/d, rate phase picker, GOR/water cut ignored',
    wp: 'WP8',
    run(app, assert) {
      const W = app.win;
      app.openPRiSM();
      let ds = W.PRiSM_datasetFromText('time (hr),BHP (psig),gas rate (MMscf/d)\n1,2000,1.5\n2,1990,1.5\n3,1985,1.5\n');
      assert.near(ds.p[0], 2014.696, 1e-9, 'psig → psia');
      assert.near(ds.q[0], 1500, 1e-9, 'MMscf/d → Mscf/d');
      assert.equal(ds.rateUnit, 'Mscf/d');
      ds = W.PRiSM_datasetFromText('time,pressure,oil rate,water cut,GOR\n1,3000,500,0.1,800\n2,2990,500,0.1,800\n');
      assert.deepEqual(Array.from(W.PRiSM_dataTabState().mapping), ['time', 'pressure', 'rate_o', '', '']);
      assert.deepEqual(Array.from(ds.q), [500, 500]);
      // Two rate columns → picker offered; choosing gas switches ds.q.
      W.PRiSM_datasetFromText('time,pressure,oil,gas\n1,3000,500,900\n2,2990,500,910\n');
      assert.ok(visible(app, 'prism_rate_phase_item'), 'rate phase picker shown');
      app.select('prism_rate_phase', 'gas', { allowErrors: true });
      assert.deepEqual(Array.from(W.PRiSM_dataset.q), [900, 910]);
      assert.equal(W.PRiSM_dataset.rateUnit, 'Mscf/d');
    },
  },
  {
    name: 'd4. parser: empty fields keep columns aligned; semicolon files with decimal commas; newest-first rows sorted',
    wp: 'WP8',
    run(app, assert) {
      const W = app.win;
      app.openPRiSM();
      let ds = W.PRiSM_datasetFromText('time,pressure,rate\n1,3000,\n2,2990,500\n3,2985,500\n');
      assert.deepEqual(Array.from(ds.p), [3000, 2990, 2985], 'blank rate does not shift pressure');
      assert.ok(isNaN(ds.q[0]) && ds.q[1] === 500);
      ds = W.PRiSM_datasetFromText('time;pressure\n0,01;3861,4\n0,02;3705,0\n0,03;3600,5\n');
      assert.deepEqual(Array.from(ds.t), [0.01, 0.02, 0.03]);
      assert.deepEqual(Array.from(ds.p), [3861.4, 3705.0, 3600.5]);
      ds = W.PRiSM_datasetFromText('time,pressure\n3,2985\n2,2990\n1,3000\n');
      assert.deepEqual(Array.from(ds.t), [1, 2, 3], 'sorted by time');
      assert.deepEqual(Array.from(ds.p), [3000, 2990, 2985]);
      ds = W.PRiSM_datasetFromText('"Time","Pressure"\n"1,000","3,500.5"\n"2,000","3,400.0"\n');
      assert.deepEqual(Array.from(ds.t), [1000, 2000], 'quoted thousands separators');
      assert.deepEqual(Array.from(ds.p), [3500.5, 3400]);
    },
  },
  {
    name: 'd5. "Load data" after a workbook uses newly pasted text; demo data leaves rate-only mode',
    wp: 'WP8',
    run(app, assert) {
      const W = app.win;
      app.openPRiSM();
      // Simulate an adopted workbook (the XLSX reader itself needs the network).
      const st = W.PRiSM_dataTabState();
      st.source = 'workbook';
      st.workbook = app.toWin({ sheets: [{ name: 'S1', rows: [[1, 3000, 500], [2, 2990, 500]], headers: ['time', 'pressure', 'rate'], dateCols: null }], defaultIdx: 0 });
      st.wbCsvHash = 'x';
      setText(app, 'time,pressure\n5,2000\n6,1990\n7,1985\n');
      app.click('prism_data_parse', { allowErrors: true });
      assert.deepEqual(Array.from(W.PRiSM_dataset.t), [5, 6, 7], 'pasted text wins over the old workbook');
      assert.equal(W.PRiSM_dataTabState().source, 'paste');
      // Demo data from rate-only mode returns to pressure-transient mode.
      W.PRiSM.setMode('decline');
      app.click('prism_data_demo', { allowErrors: true });
      assert.equal(W.PRiSM.mode, 'transient');
      assert.equal(app.el('prism_testtype').value !== 'rate', true);
    },
  },
  {
    name: 'd3. rate-only file shows the decline banner; the button switches to rate-only mode',
    wp: 'WP8',
    run(app, assert, ctx) {
      app.openPRiSM();
      setText(app, 'time,rate\n0,1000\n24,950\n48,905\n72,870\n');
      app.click('prism_data_parse', { allowErrors: true });
      assert.equal(app.win.PRiSM_dataset.p, null);
      assert.ok(visible(app, 'prism_rateonly_banner'), 'banner shown');
      app.click('prism_rateonly_switch', { allowErrors: true });
      assert.equal(app.win.PRiSM.mode, 'decline');
      assert.equal(app.el('prism_testtype').value, 'rate', 'chip shows rate-only');
      assert.ok(!visible(app, 'prism_rateonly_banner'), 'banner hidden in decline mode');
      assert.equal(ownErrors(app, ctx).length, 0);
    },
  },

  // ── (e) homogeneous negative skin ────────────────────────────────────────
  {
    name: 'e. homogeneous S<0: S=-3 Cd=100 monotone, late pd = 0.5(ln td+0.80907)-3; S=-7 Cd=1e4 finite',
    wp: 'WP8',
    opts: false,
    run(app, assert) {
      const F = loadFoundation();
      const tds = [];
      for (let e = 0; e <= 7; e += 0.25) tds.push(Math.pow(10, e));
      const pd = F.pd(tds, { Cd: 100, S: -3 });
      pd.forEach((v, i) => { assert.finite(v); if (i) assert.ok(v > pd[i - 1], 'monotone at td=' + tds[i]); });
      for (const td of [1e6, 3e6, 1e7]) {
        assert.near(F.pd(td, { Cd: 100, S: -3 }), 0.5 * (Math.log(td) + 0.80907) - 3, 0.01, 'late pd at ' + td);
        assert.near(F.dpd(td, { Cd: 100, S: -3 }), 0.5, 0.01, 'late derivative at ' + td);
      }
      const t7 = [1, 2, 5, 10, 15, 20, 30, 50, 100, 1e3, 1e4, 1e5, 1e6];
      const p7 = F.pd(t7, { Cd: 1e4, S: -7 });
      const d7 = F.dpd(t7, { Cd: 1e4, S: -7 });
      p7.forEach((v, i) => { assert.finite(v, 'pd S=-7 td=' + t7[i]); assert.ok(v > 0); });
      d7.forEach((v, i) => assert.finite(v, 'pd\' S=-7 td=' + t7[i]));
      // Same answer as S = 0 at the effective-wellbore-radius scaling.
      const f = Math.exp(-3);
      assert.near(F.pd(200, { Cd: 50, S: -1.5 }), F.pd(200 * f, { Cd: 50 * f, S: 0 }), 1e-9);
      // S >= 0 path untouched.
      assert.near(F.pd(1e7, { Cd: 100, S: 2.5 }), 0.5 * (Math.log(1e7) + 0.80907) + 2.5, 0.01);
      assert.throws(() => F.pd(0, { Cd: 100, S: -3 }), /td must be > 0/);
    },
  },

  // ── (f) no perpetual timers ─────────────────────────────────────────────
  {
    name: 'f. no timers left by WP8 files after 5 s idle (no polling installers)',
    wp: 'WP8',
    run(app, assert) {
      app.openPRiSM();
      app.win.PRiSM_gotoStep(3);
      app.win.PRiSM_gotoStep(1);
      app.flush(5000);
      const mine = app.timers().filter((t) => OWN_FILES.test(String(t.where).split('|')[0]));
      assert.equal(mine.length, 0, 'pending WP8 timers: ' + mine.map((t) => t.kind + ' ' + t.where).join('; '));
      const src = ['01-foundation.js', '07-data-enhancements.js', '12-data-crop.js']
        .map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
      assert.ok(!/setInterval\s*\(/.test(src), 'no setInterval in WP8 sources');
      assert.ok(src.indexOf('_installTab1Hook') === -1 && src.indexOf('_wrapDataRender') === -1, 'wrapper installers removed');
    },
  },

  // ── C9 shell ─────────────────────────────────────────────────────────────
  {
    name: 'C9. shell DOM: header, five steps, workspace, rail, sub-tab strip',
    wp: 'WP8',
    run(app, assert) {
      app.openPRiSM();
      ['prism_header', 'prism_steps', 'prism_workspace', 'prism_rail', 'prism_analyse_btn', 'prism_undo', 'prism_redo',
        'prism_tools_btn', 'prism_export_btn', 'prism_testtype', 'prism_tabs', 'prism_step2'].forEach((id) => assert.ok(app.el(id), '#' + id));
      assert.includes(app.el('prism_analyse_btn').textContent, '▶ Analyse');
      assert.equal(app.el('prism_tools_btn').textContent, 'Tools');
      const steps = app.findAll('#prism_steps [data-prism-step]').map((b) => b.textContent.replace(/✓/g, '').trim());
      assert.deepEqual(steps, ['①Data', '②Flow periods', '③Diagnose', '④Model & fit', '⑤Report']);
      const sub = app.findAll('#prism_tabs [data-prism-tab]').map((b) => b.textContent);
      assert.deepEqual(sub, ['Model', 'Parameters', 'Type-curve match', 'Regression']);
      for (let n = 1; n <= 7; n++) assert.ok(app.el('prism_tab_' + n) && app.el('prism_tab_' + n + '_panels'), 'tab host ' + n);
      assert.ok(app.el('prism_workspace').contains(app.el('prism_tab_4')));
      assert.equal(app.el('prism_rail').parentNode.id, 'prism_railwrap');
      assert.fn(app.win.PRiSM_gotoStep); assert.fn(app.win.PRiSM_currentStep); assert.fn(app.win.PRiSM_renderTab);
      assert.fn(app.win.PRiSM_registerTabPanel); assert.fn(app.win.PRiSM_seedDefaultSample);
      assert.equal(typeof app.win.PRiSM_DEFAULT_SAMPLE_META, 'object');
      assert.equal(app.win.PRiSM_DEFAULT_SAMPLE_META.pi, 4200);
      assert.ok(Array.isArray(app.win.PRiSM_tabHooks.any) && Array.isArray(app.win.PRiSM_postDrawHooks));
    },
  },
  {
    name: 'C9. gotoStep / setTab mapping, sub-tabs, prism:step-changed, PRiSM_renderTab still works',
    wp: 'WP8',
    run(app, assert, ctx) {
      app.openPRiSM();
      const W = app.win;
      const ev = recordEvents(app, ['prism:step-changed', 'prism:tab-open']);
      const onlyTab = (n) => { for (let i = 1; i <= 7; i++) assert.equal(visible(app, 'prism_tab_' + i), i === n, 'tab ' + i + ' visibility (want ' + n + ')'); };
      assert.equal(W.PRiSM_currentStep(), 1);
      onlyTab(1);

      W.PRiSM_gotoStep(3);
      assert.equal(W.PRiSM_currentStep(), 3);
      onlyTab(2);
      assert.ok(!visible(app, 'prism_tabs'), 'sub-tabs hidden outside step 4');
      assert.deepEqual(JSON.parse(JSON.stringify(ev('prism:step-changed').slice(-1)[0])), { step: 3, prev: 1, tab: 2 });

      W.PRiSM_gotoStep(4);
      onlyTab(3);
      assert.ok(visible(app, 'prism_tabs'), 'sub-tab strip on step 4');
      app.click(app.find('#prism_tabs [data-prism-tab="5"]'), { allowErrors: true });
      onlyTab(5);
      assert.equal(W.PRiSM.tab, 5);
      assert.ok(app.find('#prism_tabs [data-prism-tab="5"]').classList.contains('active'));
      W.PRiSM_gotoStep(5);
      onlyTab(7);
      W.PRiSM_gotoStep(4);
      onlyTab(5), assert.equal(W.PRiSM.tab, 5, 'step 4 remembers its sub-tab');

      W.PRiSM.setTab(2);
      assert.equal(W.PRiSM_currentStep(), 3);
      W.PRiSM.setTab(6);
      assert.equal(W.PRiSM_currentStep(), 4);
      onlyTab(6);
      W.PRiSM.setTab(1);
      assert.equal(W.PRiSM_currentStep(), 1);

      W.PRiSM_gotoStep(2);
      assert.ok(visible(app, 'prism_step2'));
      for (let i = 1; i <= 7; i++) assert.ok(!visible(app, 'prism_tab_' + i));
      assert.ok(app.el('prism_step2').innerHTML.length > 0, 'step 2 has content');

      const opens = ev('prism:tab-open').map((d) => d.tab);
      assert.ok(opens.indexOf(2) !== -1 && opens.indexOf(5) !== -1 && opens.indexOf(7) !== -1, 'tab-open fired: ' + opens);
      // The public renderer still renders a tab directly.
      W.PRiSM_renderTab(3);
      assert.ok(app.el('prism_tab_3').innerHTML.length > 0);
      assert.equal(W.PRiSM.getState().step, 2);
      assert.equal(ownErrors(app, ctx).length, 0);
    },
  },
  {
    name: 'C9. step ② uses PRiSM_stepViews[2] when registered; the step bar and compact header navigate',
    wp: 'WP8',
    run(app, assert) {
      const W = app.win;
      let hostSeen = null;
      W.PRiSM_stepViews[2] = (host) => { hostSeen = host; host.innerHTML = '<div id="wp8_step2_view">periods</div>'; };
      app.openPRiSM();
      app.click('prism_step_btn_2', { allowErrors: true });
      assert.equal(W.PRiSM_currentStep(), 2);
      assert.equal(hostSeen && hostSeen.id, 'prism_step2');
      assert.ok(app.el('wp8_step2_view'));
      // Without the view: a fallback note that links to the crop tool.
      W.PRiSM_stepViews[2] = undefined;
      W.PRiSM_gotoStep(3);
      W.PRiSM_gotoStep(2);
      assert.ok(app.el('prism_step2_crop'), 'fallback offers the crop tool');
      app.click('prism_step2_crop', { allowErrors: true });
      assert.equal(W.PRiSM_currentStep(), 1);
      // Compact header label (shown on narrow screens) advances a step.
      W.PRiSM_gotoStep(3);
      assert.equal(app.el('prism_step_compact').textContent, '③ Diagnose · 3/5 ›');
      app.click('prism_step_compact', { allowErrors: true });
      assert.equal(W.PRiSM_currentStep(), 4);
    },
  },
  {
    name: 'C9. step ticks: ① data, ② single period / active period, ③ analysis data ok, ④ converged fit, ⑤ always',
    wp: 'WP8',
    run(app, assert) {
      const W = app.win;
      W.PRiSM_getAnalysisData = () => ({ ok: false });
      W.PRiSM_getLastFit = () => null;
      app.openPRiSM();
      const ticks = () => [1, 2, 3, 4, 5].map((n) => app.el('prism_step_tick_' + n).textContent === '✓');
      assert.deepEqual(ticks(), [true, true, false, false, false]);
      assert.deepEqual(JSON.parse(JSON.stringify(W.PRiSM_stepStatus())), { 1: true, 2: true, 3: false, 4: false, 5: true });

      W.PRiSM_getAnalysisData = () => ({ ok: true, testType: 'drawdown' });
      W.PRiSM_getLastFit = () => ({ modelKey: 'homogeneous', converged: true, r2: 0.9999, phys: { k: 45, S: 2.5 } });
      app.fire('window', 'prism:well-changed', { source: 'test' }, { allowErrors: true });
      app.fire('window', 'prism:fit-updated', { source: 'test' }, { allowErrors: true });
      assert.deepEqual(ticks(), [true, true, true, true, false]);
      W.PRiSM_getLastFit = () => ({ modelKey: 'homogeneous', converged: false });
      app.fire('window', 'prism:fit-updated', { source: 'test' }, { allowErrors: true });
      assert.equal(ticks()[3], false, 'non-converged fit gets no tick');

      // Multi-rate data: ② needs an active period.
      W.PRiSM_commitDataset(app.toWin({ t: [1, 2, 3, 4], p: [3000, 2990, 3100, 3150], q: [500, 500, 0, 0] }), { source: 'test' });
      assert.equal(ticks()[1], false, 'two periods, none chosen');
      assert.includes(app.el('prism_crumb_period').textContent, '2 flow periods');
      W.PRiSM_state = W.PRiSM_state || {};
      W.PRiSM_state.activePeriod = 1;
      app.fire('window', 'prism:period-changed', { period: 1 }, { allowErrors: true });
      assert.equal(ticks()[1], true, 'period chosen');
      assert.includes(app.el('prism_crumb_period').textContent, 'Period 2 of 2');
      assert.ok(app.el('prism_step_btn_5').title.indexOf('Report') === 0);
    },
  },
  {
    name: 'C9. rail: PRiSM_renderRail(railEl) after render and on fit / well / step / dataset events; fallback without it',
    wp: 'WP8',
    run(app, assert, ctx) {
      const W = app.win;
      const calls = [];
      W.PRiSM_renderRail = (el) => { calls.push(el.id); el.innerHTML = '<div id="wp8_rail_stub">rail</div>'; };
      app.openPRiSM();
      assert.ok(calls.length >= 1, 'called after render');
      assert.ok(calls.every((id) => id === 'prism_rail'));
      assert.ok(app.el('wp8_rail_stub'));
      for (const t of ['prism:fit-updated', 'prism:well-changed', 'prism:step-changed', 'prism:dataset-loaded']) {
        const n0 = calls.length;
        app.fire('window', t, { source: 'test', dataset: W.PRiSM_dataset, step: W.PRiSM_currentStep() }, { allowErrors: true });
        assert.ok(calls.length > n0, 'rail refreshed on ' + t);
      }
      const n1 = calls.length;
      W.PRiSM_gotoStep(3);
      assert.equal(calls.length, n1 + 1, 'exactly one rail render per navigation');

      // Fallback rail when the rail module is missing.
      const b = ctx.loadApp({});
      b.win.PRiSM_renderRail = undefined;
      b.win.PRiSM_getLastFit = () => ({ modelKey: 'homogeneous', converged: true, r2: 0.99995, phys: { k: 45.02, kh: 1575.7, S: 2.5, C: 8.48e-4 } });
      b.openPRiSM();
      const txt = b.el('prism_rail').textContent;
      assert.includes(txt, 'Demo data · 55 pts');
      assert.includes(txt, '45.02 md');
      assert.includes(txt, 'homogeneous');
    },
  },
  {
    name: 'C9. header actions: Analyse, undo/redo, Tools, Export call the workflow APIs and fall back when absent',
    wp: 'WP8',
    run(app, assert, ctx) {
      const W = app.win;
      const log = [];
      W.PRiSM_analyse = () => { log.push('analyse'); return Promise.resolve({ ok: true }); };
      W.PRiSM_undo = () => log.push('undo');
      W.PRiSM_redo = () => log.push('redo');
      W.PRiSM_canUndo = () => true;
      W.PRiSM_canRedo = () => false;
      W.PRiSM_openTools = () => log.push('tools');
      app.openPRiSM();
      assert.equal(app.el('prism_undo').disabled, false);
      assert.equal(app.el('prism_redo').disabled, true, 'redo disabled when nothing to redo');
      app.click('prism_analyse_btn', { allowErrors: true });
      app.click('prism_undo', { allowErrors: true });
      app.click('prism_tools_btn', { allowErrors: true });
      assert.deepEqual(log, ['analyse', 'undo', 'tools']);
      // Export menu → report step.
      app.click('prism_export_btn', { allowErrors: true });
      assert.ok(!app.el('prism_menu').hasAttribute('hidden'), 'export menu open');
      const item = app.findAll('#prism_menu button').find((b) => /report/i.test(b.textContent));
      app.click(item, { allowErrors: true });
      assert.equal(W.PRiSM_currentStep(), 5);
      assert.ok(app.el('prism_menu').hasAttribute('hidden'));

      // Fallbacks: no workflow module at all.
      const b = ctx.loadApp({});
      ['PRiSM_analyse', 'PRiSM_undo', 'PRiSM_redo', 'PRiSM_canUndo', 'PRiSM_canRedo', 'PRiSM_openTools'].forEach((k) => { b.win[k] = undefined; });
      b.openPRiSM();
      assert.equal(b.el('prism_undo').disabled, true);
      b.click('prism_analyse_btn', { allowErrors: true });
      assert.equal(b.win.PRiSM_currentStep(), 4);
      assert.ok(visible(b, 'prism_tab_6'), 'Analyse falls back to the regression view');
      b.click('prism_tools_btn', { allowErrors: true });
      const crop = b.findAll('#prism_menu button').find((x) => /crop/i.test(x.textContent));
      assert.ok(crop, 'tools menu offers the crop tool');
      b.click(crop, { allowErrors: true });
      assert.equal(b.win.PRiSM_currentStep(), 1);
      assert.equal(ownErrors(app, ctx).length + ownErrors(b, ctx).length, 0);
    },
  },
  {
    name: 'C9. test-type chip → PRiSM_setWell({testType}); rate-only / combined switch mode and keep the step',
    wp: 'WP8',
    run(app, assert) {
      const W = app.win;
      const rec = [];
      W.PRiSM_setWell = (patch, opts) => { rec.push([JSON.parse(JSON.stringify(patch)), JSON.parse(JSON.stringify(opts || {}))]); };
      W.PRiSM_getWell = () => ({ testType: 'auto', missing: [], defaulted: [] });
      app.openPRiSM();
      W.PRiSM_gotoStep(4, { tab: 5 });
      app.select('prism_testtype', 'buildup', { allowErrors: true });
      assert.deepEqual(rec.slice(-1)[0], [{ testType: 'buildup' }, { source: 'user' }]);
      app.select('prism_testtype', 'rate', { allowErrors: true });
      assert.equal(W.PRiSM.mode, 'decline');
      assert.equal(app.el('prism_testtype').value, 'rate');
      assert.equal(W.PRiSM_currentStep(), 4, 'step kept across the mode switch');
      assert.equal(W.PRiSM.tab, 5);
      assert.ok(app.el('prism_units_card'), 'Tab 1 still enhanced after the mode switch');
      app.select('prism_testtype', 'combined', { allowErrors: true });
      assert.equal(W.PRiSM.mode, 'combined');
      app.select('prism_testtype', 'drawdown', { allowErrors: true });
      assert.equal(W.PRiSM.mode, 'transient');
    },
  },
  {
    name: 'C9. phone 375 px: rail is a bottom sheet, compact header, no fixed widths over 375 px; back to desktop',
    wp: 'WP8',
    opts: { viewport: { width: 375, height: 812 } },
    run(app, assert) {
      app.win.PRiSM_renderRail = undefined;     // shell fallback sheet
      app.openPRiSM();
      const rail = app.el('prism_rail');
      assert.ok(rail.classList.contains('prism-rail--sheet'), 'rail → bottom sheet');
      assert.ok(app.el('prism_railwrap').classList.contains('prism-railwrap--sheet'));
      assert.ok(app.el('prism_body').classList.contains('prism-body--narrow'));
      assert.equal(app.el('prism_step_compact').style.display, '', 'compact label shown');
      assert.equal(app.el('prism_crumb').style.display, 'none', 'breadcrumb hidden');
      app.win.PRiSM_gotoStep(3);
      assert.equal(app.el('prism_step_compact').textContent, '③ Diagnose · 3/5 ›');
      // Sheet collapses / expands.
      assert.ok(app.el('prism_rail_sheetbar'));
      assert.equal(app.el('prism_rail_body').style.display, 'none');
      app.click('prism_rail_sheetbar');
      assert.equal(app.el('prism_rail_body').style.display, 'block');
      // No inline fixed width wider than the phone in the shell, Tab 1 or the crop tool.
      app.win.PRiSM_gotoStep(1);
      const roots = ['prism_header', 'prism_steps', 'prism_railwrap', 'prism_tab_1', 'prism_crop_tool_host'].map((id) => app.el(id));
      const tooWide = [];
      roots.forEach((r) => [r].concat(Array.from(r.querySelectorAll('*'))).forEach((e) => {
        ['width', 'minWidth'].forEach((k) => {
          const m = /^([\d.]+)px$/.exec(e.style[k] || '');
          if (m && +m[1] > 375) tooWide.push((e.id || e.localName) + ' ' + k + '=' + e.style[k]);
        });
      }));
      assert.deepEqual(tooWide, []);
      const cc = app.el('prism_crop_canvas');
      assert.ok(parseFloat(cc.style.width) <= 343, 'crop canvas fits the phone: ' + cc.style.width);

      app.resize(1280, 800);
      assert.ok(!rail.classList.contains('prism-rail--sheet'), 'desktop → column');
      assert.equal(app.el('prism_step_compact').style.display, 'none');
      assert.equal(app.el('prism_crumb').style.display, '');
    },
  },

  // ── C7 registries ───────────────────────────────────────────────────────
  {
    name: 'C7. panels: order, error isolation, lazy collapsed render, live registration; tab hooks + tab-open',
    wp: 'WP8',
    run(app, assert) {
      const W = app.win;
      let lazyCalls = 0;
      const hookLog = [];
      W.PRiSM_registerTabPanel(1, { id: 'wp8_bad', title: 'Bad panel', order: 1, render() { throw new Error('boom-wp8'); } });
      W.PRiSM_registerTabPanel(1, { id: 'wp8_lazy', title: 'Lazy', order: 2, collapsed: true, render(h) { lazyCalls++; h.innerHTML = '<i id="wp8_lazy_body">ok</i>'; } });
      W.PRiSM_registerTabPanel(3, { id: 'wp8_when', title: 'Hidden', when: () => false, render(h) { h.innerHTML = 'x'; } });
      W.PRiSM_tabHooks.any.push((n) => hookLog.push('any' + n));
      W.PRiSM_tabHooks[3] = [(n) => hookLog.push('t' + n)];
      app.openPRiSM();
      const ids = app.findAll('#prism_tab_1_panels .prism-panel').map((e) => e.getAttribute('data-panel-id'));
      assert.deepEqual(ids.slice(0, 2), ['wp8_bad', 'wp8_lazy'], 'sorted by order');
      assert.ok(ids.indexOf('crop') > 1);
      assert.includes(app.el('prism_panel_1_wp8_bad').textContent, 'boom-wp8', 'inline error, other panels still render');
      assert.ok(app.el('prism_crop_tool_host'), 'crop rendered despite the failing panel');
      assert.equal(lazyCalls, 0, 'collapsed panel not rendered yet');
      app.click('prism_panel_1_wp8_lazy_head');
      assert.equal(lazyCalls, 1);
      assert.ok(app.el('wp8_lazy_body'));
      app.click('prism_panel_1_wp8_lazy_head');
      assert.equal(app.el('prism_panel_1_wp8_lazy_body').style.display, 'none');
      // Same id replaces in place; a registration while the tab is on screen mounts at once.
      W.PRiSM_registerTabPanel(1, { id: 'wp8_bad', title: 'Fixed', order: 1, render(h) { h.innerHTML = '<b id="wp8_fixed">fixed</b>'; } });
      assert.ok(app.el('wp8_fixed'));
      assert.equal(W.PRiSM_tabPanels[1].filter((p) => p.id === 'wp8_bad').length, 1);
      W.PRiSM_gotoStep(4);
      assert.ok(!app.el('prism_panel_3_wp8_when'), 'when() → false hides the panel');
      assert.ok(hookLog.indexOf('any3') !== -1 && hookLog.indexOf('t3') !== -1, 'hooks: ' + hookLog);
    },
  },
  {
    name: 'C7. a failing or missing tab renderer gives an error card with the message (no "Coming soon")',
    wp: 'WP8',
    run(app, assert) {
      const W = app.win;
      W.PRiSM_renderModelTab = () => { throw new Error('model-tab-kaboom'); };
      W.PRiSM_renderReportTab = undefined;
      app.openPRiSM();
      W.PRiSM_gotoStep(4, { tab: 3 });
      const h3 = app.el('prism_tab_3').textContent;
      assert.includes(h3, 'model-tab-kaboom');
      assert.includes(h3, 'could not be displayed');
      W.PRiSM_gotoStep(5);
      assert.includes(app.el('prism_tab_7').textContent, 'not loaded');
      for (let n = 1; n <= 7; n++) assert.ok(app.el('prism_tab_' + n).textContent.indexOf('Coming soon') === -1);
      // Tab 1 falls back to the basic renderer when the enhanced one throws.
      W.PRiSM_renderDataTabEnhanced = () => { throw new Error('enh-broken'); };
      W.PRiSM_gotoStep(1);
      assert.ok(app.el('prism_data_demo') && app.el('prism_data_stats'), 'basic Data tab rendered');
    },
  },

  // ── Tab 1 flows ─────────────────────────────────────────────────────────
  {
    name: '8.3 Try demo data after Clear: sample + META through PRiSM_setWell(source "sample")',
    wp: 'WP8',
    run(app, assert, ctx) {
      const W = app.win;
      const rec = [];
      W.PRiSM_setWell = (patch, opts) => { rec.push([JSON.parse(JSON.stringify(patch)), JSON.parse(JSON.stringify(opts || {}))]); };
      app.openPRiSM();
      assert.equal(rec.length, 1, 'META applied once when the sample was seeded');
      assert.deepEqual(rec[0][1], { source: 'sample' });
      assert.deepEqual(rec[0][0], { pi: 4200, testType: 'drawdown', q: 850, Bo: 1.25, mu_o: 1.1, ct: 1.2e-5, h: 35, phi: 0.18, rw: 0.354, fluidType: 'oil' });
      const ev = recordEvents(app, ['prism:dataset-cleared', 'prism:dataset-loaded']);
      app.click('prism_data_clear', { allowErrors: true });
      assert.equal(W.PRiSM_dataset, null);
      assert.equal(app.storage.getItem('wts_prism_sample_suppress'), '1');
      assert.equal(ev('prism:dataset-cleared').length, 1);
      assert.equal(app.el('prism_step_tick_1').textContent, '', 'step ① unticked');
      // A reload now stays empty (the user cleared it).
      const b = ctx.loadApp({ storage: app.storage });
      b.openPRiSM();
      assert.ok(!(b.win.PRiSM_dataset && b.win.PRiSM_dataset.t && b.win.PRiSM_dataset.t.length), 'no re-seed after Clear');

      app.click('prism_data_demo', { allowErrors: true });
      const ds = W.PRiSM_dataset;
      assert.ok(ds && ds.t.length === 55);
      assert.equal(ds.source, 'sample');
      assert.equal(ds.name, 'Demo data');
      assert.equal(ev('prism:dataset-loaded').length, 1);
      assert.equal(app.storage.getItem('wts_prism_sample_suppress'), null);
      assert.includes(app.el('prism_data_paste').value, '3861.4');
      assert.includes(app.el('prism_data_msg').textContent, 'Demo data loaded');
      assert.equal(rec.length, 2);
      assert.equal(app.el('prism_crumb_ds').textContent, 'Demo data · 55 pts');
      assert.equal(ownErrors(app, ctx).length, 0);
    },
  },
  {
    name: '8.8 crop: Tab 1 panel; apply → one dataset-loaded {source:"crop"}, absolute t, redraw; snapshot survives re-render',
    wp: 'WP8',
    run(app, assert, ctx) {
      const W = app.win;
      let draws = 0;
      W.PRiSM_drawActivePlot = () => { draws++; };
      app.openPRiSM();
      const ev = recordEvents(app, ['prism:dataset-loaded', 'prism:dataset-cropped']);
      const res = W.PRiSM_applyCrop(1, 10);
      assert.equal(ev('prism:dataset-loaded').length, 1);
      assert.equal(ev('prism:dataset-loaded')[0].source, 'crop');
      assert.equal(ev('prism:dataset-cropped').length, 1);
      assert.equal(W.PRiSM_dataset, res);
      assert.ok(res.t[0] >= 1 && res.t[res.t.length - 1] <= 10, 'absolute times kept');
      assert.near(res.t[0], 1.095, 1e-12);
      assert.equal(res.name, 'Demo data');
      assert.equal(draws, 1);
      // Re-render Tab 1 → the full record is still the snapshot.
      W.PRiSM_gotoStep(3);
      W.PRiSM_gotoStep(1);
      assert.equal(W.PRiSM_dataset, res, 're-render does not re-commit the full parse');
      assert.equal(W.PRiSM_cropState.fullDataset.t.length, 55);
      const back = W.PRiSM_resetCrop();
      assert.equal(back.t.length, 55);
      assert.equal(W.PRiSM_dataset.t.length, 55);
      assert.equal(ev('prism:dataset-loaded').length, 2);
      // A new dataset from elsewhere starts a new snapshot.
      setText(app, 'time,pressure\n1,3000\n2,2990\n3,2985\n');
      app.click('prism_data_parse', { allowErrors: true });
      assert.equal(W.PRiSM_cropState.fullDataset.t.length, 3);
      assert.equal(ownErrors(app, ctx).length, 0);
    },
  },
  {
    name: '8.6 file loader: CSV via the file input commits and names the dataset',
    wp: 'WP8',
    timeoutMs: 60000,
    async run(app, assert, ctx) {
      app.openPRiSM();
      const ev = recordEvents(app, ['prism:dataset-loaded']);
      const f = new app.win.File(['t (hr),Pwf (psia),q (STB/d)\n0.5,3500,600\n1,3450,600\n2,3420,600\n'], 'well-7.csv');
      const inp = app.el('prism_data_file');
      Object.defineProperty(inp, 'files', { value: [f], configurable: true });
      app.fire('prism_data_file', 'change', {}, { allowErrors: true });
      await app.flushAsync(20);
      await app.flushAsync(20);
      const ds = app.win.PRiSM_dataset;
      assert.ok(ds && ds.t.length === 3, 'committed');
      assert.equal(ds.name, 'well-7.csv');
      assert.deepEqual(Array.from(ds.p), [3500, 3450, 3420]);
      assert.equal(ev('prism:dataset-loaded').length, 1);
      assert.equal(app.el('prism_data_filename').textContent, 'well-7.csv');
      assert.equal(app.el('prism_crumb_ds').textContent, 'well-7.csv · 3 pts');
      assert.equal(ownErrors(app, ctx).length, 0);
    },
  },
  {
    name: '8.5 re-render keeps a user dataset; the multi-rate table has no placeholder row',
    wp: 'WP8',
    run(app, assert, ctx) {
      const W = app.win;
      app.openPRiSM();
      setText(app, 'time,pressure,rate\n1,3000,500\n2,2990,500\n3,2985,500\n');
      app.click('prism_data_parse', { allowErrors: true });
      const ds = W.PRiSM_dataset;
      W.PRiSM.setMode('combined');
      W.PRiSM_gotoStep(1);
      assert.equal(W.PRiSM_dataset, ds, 'no re-commit on re-render / mode switch');
      assert.equal(W.PRiSM.multiRate.length, 0, 'no {t:0,q:0} placeholder');
      assert.includes(app.el('prism_mrate_body').textContent, 'No rate changes');
      app.click('prism_mrate_add', { allowErrors: true });
      assert.equal(W.PRiSM.multiRate.length, 1);
      assert.equal(app.storage.getItem('wts_prism_mrate'), '[{"t":0,"q":0}]');
      // A legacy lone placeholder in storage is not read back as a schedule.
      const b = ctx.loadApp({ storage: app.storage });
      b.openPRiSM();
      assert.equal(b.win.PRiSM.multiRate.length, 0);
      // A real schedule is restored after a reload, even when another layer
      // created window.PRiSM (with an empty table) before the shell opened.
      app.storage.setItem('wts_prism_mrate', '[{"t":0,"q":850},{"t":24,"q":0}]');
      const c = ctx.loadApp({ storage: app.storage });
      c.win.PRiSM = c.toWin({ mode: 'transient', tab: 1, multiRate: [] });
      c.openPRiSM();
      assert.deepEqual(JSON.parse(JSON.stringify(c.win.PRiSM.multiRate)), [{ t: 0, q: 850 }, { t: 24, q: 0 }]);
      assert.equal(c.findAll('#prism_mrate_body input[data-mrate-k="q"]').length, 2);
    },
  },

  // ── integration (needs WP1 / WP13 code) ─────────────────────────────────
  {
    name: 'I1. sample META reaches the Well & Test store (pi 4200, sample provenance); step ③ ticks from getAnalysisData',
    wp: 'WP8',
    integration: true,
    run(app, assert) {
      const W = app.win;
      assert.fn(W.PRiSM_setWell, 'WP1 setWell');
      assert.fn(W.PRiSM_getWell, 'WP1 getWell');
      app.openPRiSM();
      const w = W.PRiSM_getWell();
      assert.near(w.pi, 4200, 1e-9);
      assert.near(w.q, 850, 1e-9);
      assert.equal(w.testType === 'drawdown' || w.testType === 'auto', true);
      const a = W.PRiSM_getAnalysisData();
      assert.ok(a && a.ok, 'analysis data ok');
      assert.equal(app.el('prism_step_tick_3').textContent, '✓');
      assert.ok(app.el('prism_panel_1_prism_well_test') || app.find('#prism_tab_1_panels [data-panel-id]'), 'Well & Test panel on Tab 1');
    },
  },
  {
    name: 'I2. workflow rail (WP13) renders into #prism_rail and as a bottom sheet on a phone',
    wp: 'WP8',
    integration: true,
    opts: { viewport: { width: 375, height: 812 } },
    run(app, assert) {
      assert.fn(app.win.PRiSM_renderRail, 'WP13 rail');
      app.openPRiSM();
      assert.ok(app.el('prism_rail').classList.contains('prism-rail--sheet'));
      assert.ok(app.el('prism_rail_sheetbar'), 'sheet bar from the rail module');
      app.resize(1280, 800);
      assert.ok(app.el('prism_rail_body'));
      assert.ok(!app.el('prism_rail_sheetbar'), 'desktop column after resize');
    },
  },
];
