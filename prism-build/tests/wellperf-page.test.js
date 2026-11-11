// Well Performance page (WP9) — docs/WELL-PERFORMANCE-PLAN.md §2.6–§2.10, §3.10, §10, §12, §13, §17.1 (wellperf-page, 14 tests)
// and the owner GUI requirement of 2026-11-11 (deviation first class, interactive schematic, drag handles, KPI strip, drawer).
//
// The engines (WP1–WP7) are replaced here by the test double tests/_wellperf-mock.js, which returns the contract shapes; the page
// is tested for what it does with them: markup, report capture, restore, events, units, interactivity. Engine numbers are the
// engines' own tests.
//   WPG1 render · WPG2 silent restore = one calc · WPG3 multi-well switch re-reads the model · WPG4 project round trip ·
//   WPG5 units switch · WPG6 compact block captured, .rp-skip parts not · WPG7 hidden canvases drawn at size ·
//   WPG8 Quick Report snapshot ≤ 60 kB + disclaimer and validity verdicts · WPG9 events · WPG10 hub navigation and home tile ·
//   WPG11 Solve-button fallback · WPG12 drag handles (pointer + keyboard) re-solve live · WPG13 deviated schematic: hover readout
//   (MD / TVD / inclination / p / T / holdup), click-to-edit, heat-map property · WPG14 tables: survey paste, TVD columns, DFIT
//   import, stub state without engines.
'use strict';

const S = require('./_wellperf-shapes');
const { installWellPerfMock } = require('./_wellperf-mock');

const WP = 'WP9';
const BAD = /NaN|undefined|Infinity|\[object Object\]/;
const txt = (e) => String(e && e.textContent || '').replace(/\s+/g, ' ').trim();
const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));

function app0(ctx) {
  const app = S.sharedApp(ctx);
  if (!app.win.__WP_MOCK) installWellPerfMock(app.win);
  return app;
}
function open(app) { app.hook.nav('wellperf'); app.flush(30); return app.el('wp_root'); }
function example(app, k) { app.click(app.find('[data-act="example"][data-ex="' + (k || 'oil') + '"]')); app.flush(30); }
const P = (app) => app.win.WTS_wellperf_page;
const ST = (app) => app.win.WTS_state.wellperf;
function fresh(app) { S.resetWellPerf(app); P(app).resetJobs(); P(app).budget(300); }

module.exports = [
  {
    name: 'WPG1 render: step strip, KPI strip (10 KPIs with chips), schematic SVG, system plot with handles, operating point, breakdown, checks, validity, Notes; no NaN',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx); fresh(app);
      open(app); example(app, 'oil');
      ['wp_steps', 'wp_res', 'wp_kpis', 'wp_sch', 'wp_cv_sys', 'wp_op', 'wp_cv_bd', 'wp_verd', 'wp_valid', 'wp_cv_tr', 'wp_drawer', 'wp_notesbox'].forEach((id) => assert.ok(app.el(id), '#' + id));
      for (let n = 1; n <= 7; n++) assert.ok(app.el('wp_step_' + n) && app.find('#wp_steps [data-step="' + n + '"]'), 'step ' + n);
      const k = app.findAll('#wp_kpis .kpi');
      assert.strictEqual(k.length, 10, 'ten KPIs for an oil well');
      const labels = k.map((x) => txt(x.querySelector('.kpi-l')));
      ['Liquid rate', 'Flowing BHP', 'THP', 'THT', 'Drawdown', 'GOR', 'Water cut', 'Loading margin', 'Erosion ratio', 'Hydrate margin'].forEach((l) => assert.ok(labels.indexOf(l) !== -1, l));
      assert.match(txt(k[0]), /1,1\d\d STB\/d/, 'rate from the solve');
      assert.ok(/st-ok/.test(k[0].className), 'stable → ✓ chip');
      assert.ok(ST(app).ok && ST(app).op.stable && ST(app).v === 1);
      assert.ok(/<svg/.test(app.el('wp_sch').innerHTML) && /data-comp="string:0"/.test(app.el('wp_sch').innerHTML), 'schematic with clickable strings');
      const cv = app.el('wp_cv_sys');
      assert.ok(cv._wp && cv._wp.spec.handles.map((h) => h.key).join(',') === 'pr,bean,wc', 'handles: p̄r, bean, WC');
      assert.ok(cv._wp.spec.markers.some((m) => m.kind === 'filled') && cv._wp.spec.markers.some((m) => m.kind === 'hollow'), 'stable + unstable roots');
      assert.ok(cv._wp.spec.bands.length === 1 && /q < q_s/.test(cv._wp.spec.bands[0].label), 'unstable range shaded');
      assert.match(txt(app.el('wp_verd')), /✓ Stable operating point/);
      assert.match(txt(app.el('wp_valid')), /provisional — not verified against a published example/);
      assert.match(txt(app.el('wp_notesbox')), /^Notes /);
      ['wp_res', 'wp_steps', 'wp_step_1'].forEach((id) => assert.ok(!BAD.test(txt(app.el(id))), id + ' clean: ' + (txt(app.el(id)).match(BAD) || [''])[0]));
      assert.strictEqual(app.consoleErrors().length, 0, 'no console errors');
    },
  },
  {
    name: 'WPG2 silent restore: saved values come back with exactly one calc and the show/hide state follows them',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx); fresh(app);
      open(app); example(app, 'gas');
      app.change('wp_bean', '28'); app.flush(1200);
      const rec = JSON.parse(app.storage.getItem('wts_page_wellperf') || 'null');
      assert.ok(rec && rec.f && rec.f.wp_bean === '28' && rec.f.wp_ftype === 'condensate', 'autosaved');
      const q = ST(app).op.q;
      app.flushUntilIdle(10000);
      const app2 = app.reload();
      try {
        installWellPerfMock(app2.win);
        const n0 = app2.win.WTS_wellperf_page.calcs();
        app2.hook.nav('wellperf'); app2.flush(30);
        assert.strictEqual(app2.win.WTS_wellperf_page.calcs() - n0, 1, 'one calc on restore');
        assert.strictEqual(app2.el('wp_bean').value, '28');
        assert.ok(app2.el('wp_ipr').value === 'litP2' && !/wp-off/.test(app2.find('[data-ip="a"]').className) && /wp-off/.test(app2.find('[data-ip="J"]').className), 'IPR parameter fields follow the model');
        assert.ok(/wp-off/.test(app2.find('[data-for="oil"]').className), 'oil-only fields hidden for a condensate well');
        assert.rel(app2.win.WTS_state.wellperf.op.q, q, 1e-9, 'same answer after the reload');
        app2.flushUntilIdle(10000);
        assert.strictEqual(app2.pendingTimers(), 0, 'no timers left');
      } finally { app2.dispose(); }
    },
  },
  {
    name: 'WPG3 multi-well switch: the page re-reads the model of the new well (no cache) with one calc per event',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx); fresh(app);
      open(app); example(app, 'gas');
      const rows = () => app.findAll('#wp_tbl_survey tbody tr').filter((tr) => tr.querySelector('input').value !== '').length;
      assert.strictEqual(rows(), 10, 'gas survey: 10 stations');
      const n0 = P(app).calcs();
      app.storage.setItem('wts_wellperf_model', JSON.stringify({ v: 1, survey: [[0, 0], [5000, 5000]] }));      // the next well's record
      app.document.dispatchEvent(new app.win.CustomEvent('wts:well-changed', { detail: {} }));
      assert.strictEqual(P(app).calcs() - n0, 1, 'one calc');
      assert.strictEqual(rows(), 2, 'the new well\'s survey is shown');
      assert.strictEqual(app.findAll('#wp_tbl_survey thead th').length, 2 + 2 + 1, 'MD / TVD form with inclination and departure columns');
      assert.deepStrictEqual(plain(P(app).state().M.well.survey), [[0, 0], [5000, 5000]]);
      fresh(app);
    },
  },
  {
    name: 'WPG4 project round trip: both wts_ keys travel in a project file and a project open re-reads them',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx); fresh(app);
      open(app); example(app, 'oil');
      app.flush(1200);
      const model = app.storage.getItem('wts_wellperf_model'), page = app.storage.getItem('wts_page_wellperf');
      assert.ok(model && page, 'both keys stored');
      assert.ok(/^wts_/.test('wts_wellperf_model') && /^wts_/.test('wts_page_wellperf'), 'wts_ prefix: carried by the project storage module');
      app.storage.setItem('wts_wellperf_model', JSON.stringify({ v: 1, survey: [[0, 0, 0], [3000, 0, 0], [6000, 40, 90]] }));
      const n0 = P(app).calcs();
      app.document.dispatchEvent(new app.win.CustomEvent('wts:project-loaded', { detail: {} }));
      assert.strictEqual(P(app).calcs() - n0, 1);
      assert.strictEqual(P(app).state().M.well.survey.length, 3, 're-read after the project open');
      app.storage.setItem('wts_wellperf_model', model);
      app.document.dispatchEvent(new app.win.CustomEvent('wts:project-loaded', { detail: {} }));
      assert.strictEqual(P(app).state().M.well.survey.length, 3, 'oil example survey back');
      assert.strictEqual(JSON.parse(app.storage.getItem('wts_wellperf_model')).flowline[0].len, 2000);
      fresh(app);
    },
  },
  {
    name: 'WPG5 units: Metric shows SI in the KPI strip, the plots and the tables; engines stay canonical (same answer); flip back',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx); fresh(app);
      open(app); example(app, 'oil');
      const q = ST(app).op.q, U = app.win.WTS_units;
      U.setSystem('metric');
      try {
        app.flush(30);
        const k = txt(app.el('wp_kpis'));
        assert.ok(/m³\/d/.test(k) && /kPa/.test(k) && !/psia|STB\/d/.test(k), 'KPI strip in SI: ' + k.slice(0, 200));
        assert.rel(ST(app).op.q, q, 1e-9, 'canonical engines: same answer');
        assert.match(app.el('wp_cv_sys')._wp.spec.y.label, /kPa/);
        assert.match(txt(app.find('#wp_tbl_survey thead')), /\(m\)/, 'survey table in metres');
        const md = app.findAll('#wp_tbl_strings tbody tr')[0].querySelector('[data-c="botMd"]').value;
        assert.rel(+md, 7950 * 0.3048, 1e-4, 'table cells converted');
        assert.ok(!BAD.test(txt(app.el('wp_res'))));
      } finally { U.setSystem('imperial'); }
      app.flush(30);
      assert.match(txt(app.el('wp_kpis')), /STB\/d/);
      fresh(app);
    },
  },
  {
    name: 'WPG6 report capture: the compact block (KPIs, schematic SVG, system plot, operating point, breakdown, checks, validity, traverse, Notes) is captured; strip, drawer, editors and buttons are not',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx); fresh(app);
      open(app); example(app, 'oil');
      const m = app.win.collectPageReport(app.el('pgBody'), { charts: false });
      const flat = JSON.stringify(m);
      ['Operating point', 'Checks', 'Correlation validity', 'Liquid rate', 'Flowing BHP', 'Stable operating point', 'Steady-state nodal analysis'].forEach((t) => assert.includes(flat, t));
      ['Full results', 'Paste from a spreadsheet', 'Drag a handle', 'Examples:', 'Run sensitivity', 'Replace the table'].forEach((t) => assert.ok(flat.indexOf(t) === -1, t + ' not captured'));
      assert.ok(m.inputs.some((s) => s.items.some((i) => /Fluid type/.test(i.label))), 'step ① inputs captured while it is the active step');
      ['wp_cv_sys', 'wp_cv_bd', 'wp_cv_tr'].forEach((id) => { app.el(id).__h2oilSnapshot = () => 'data:image/png;base64,AAAA'; });
      const mc = app.win.collectPageReport(app.el('pgBody'), { charts: true });
      const charts = mc.results.reduce((a, s) => a.concat(s.items.filter((i) => i.type === 'chart')), []);
      assert.strictEqual(charts.length, 3, 'system plot, breakdown and traverse canvases: ' + JSON.stringify(charts.map((c) => [c.w, c.h])));
      // the schematic SVG sits in the reported block (not .rp-skip); its image capture (host _svgItem) is checked in the browser run
      const svg = app.find('#wp_sch svg');
      assert.ok(svg && !svg.closest('.rp-skip') && svg.closest('#wp_res'), 'schematic SVG inside the compact block');
      fresh(app);
    },
  },
  {
    name: 'WPG7 hidden steps: the IPR canvas of step ② is drawn at its fixed size while hidden, but is left out of the report',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx); fresh(app);
      open(app); example(app, 'oil');
      P(app).goStep(1);
      assert.strictEqual(app.el('wp_step_2').style.display, 'none');
      const cv = app.el('wp_cv_ipr');
      assert.ok(cv.width >= 400 && cv.height >= 220, 'sized: ' + cv.width + '×' + cv.height);
      assert.ok(app.canvasLog(cv, 'lineTo').length > 10, 'IPR curve drawn');
      cv.__h2oilSnapshot = () => 'data:image/png;base64,AAAA';
      const m = app.win.collectPageReport(app.el('pgBody'), { charts: true });
      assert.ok(!/Inflow performance/.test(JSON.stringify(m)), 'hidden step not in the report');
      P(app).goStep(2);
      assert.ok(/Inflow performance/.test(JSON.stringify(app.win.collectPageReport(app.el('pgBody'), { charts: false }))), 'shown when it is the active step');
      P(app).goStep(1);
      fresh(app);
    },
  },
  {
    name: 'WPG8 Quick Report snapshot ≤ 60 kB with the validity verdicts; the PDF carries the disclaimer and the validity verdicts',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx); fresh(app);
      open(app); example(app, 'gas');
      app.change('wp_psep', '820'); app.flush(1200);
      const snaps = JSON.parse(app.storage.getItem('wts_report_snapshots') || '{}');
      assert.ok(snaps.wellperf, 'snapshot taken');
      const n = JSON.stringify(snaps.wellperf).length;
      assert.ok(n <= 60 * 1024, 'snapshot ' + n + ' bytes ≤ 60 kB');
      assert.includes(JSON.stringify(snaps.wellperf), 'Gray: v_m < 50 ft/s');
      const k = app.opened.length;
      app.win.exportPagePDF();
      const pdf = app.opened[k] && app.opened[k].html();
      assert.ok(pdf && pdf.indexOf('Well Performance') !== -1 && pdf.indexOf('Correlation validity') !== -1, 'PDF export');
      assert.ok(pdf.indexOf('Results are engineering estimates') !== -1, 'disclaimer in the PDF');
      fresh(app);
    },
  },
  {
    name: 'WPG9 events: wts:wellperf-solved after each solve; a table write fires wts:wellperf-model-changed and solves once; WTS_state.wellperf contract',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx); fresh(app);
      open(app); example(app, 'oil');
      const ev = [], mc = [];
      app.document.addEventListener('wts:wellperf-solved', (e) => ev.push(plain(e.detail)));
      app.document.addEventListener('wts:wellperf-model-changed', (e) => mc.push(plain(e.detail)));
      app.change('wp_pr', '3100');
      assert.deepStrictEqual(ev, [{ ok: true }]);
      const n0 = P(app).calcs();
      const inp = app.findAll('#wp_tbl_flowline tbody tr')[0].querySelector('[data-c="len"]');
      app.change(inp, '3000');
      assert.strictEqual(P(app).calcs() - n0, 1, 'one solve after a table edit');
      assert.deepStrictEqual(mc.map((d) => d.keys.join(',')), ['flowline']);
      assert.strictEqual(P(app).state().M.surface.flowline[0].len, 3000);
      const s = ST(app);
      ['v', 'ok', 'op', 'roots', 'qs', 'vlpMin', 'traverse', 'breakdown', 'shutIn', 'flags', 'loading', 'sens', 'match'].forEach((k) => assert.ok(k in s, 'WTS_state.wellperf.' + k));
      const R = app.win.WTS_wp_system.solve(P(app).state().M);
      const c = S.checkShape('R', R); assert.ok(c.ok, 'the double honours SHAPE.R: ' + c.errors.join('; '));
      fresh(app);
    },
  },
  {
    name: 'WPG10 hub: the Well Performance hub row opens the nodal page first, #hubTabs links the four members, and the home page shows its tile',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx); fresh(app);
      try { app.storage.removeItem('wts_ui_hub_last'); } catch (e) { /* ignore */ }
      app.hook.nav('home'); app.flush(30);
      assert.ok(app.findAll('.dash-card').some((c) => /Well Performance \(Nodal Analysis\)|Nodal Analysis/.test(txt(c))), 'home tile');
      const hub = app.find('#sidebar .nav-btn.nav-hub[data-hub="perf"]');
      assert.ok(hub, 'hub row');
      app.click(hub); app.flush(30);
      assert.strictEqual(app.hook.page(), 'wellperf', 'first click opens the nodal page');
      const tabs = app.el('hubTabs');
      assert.ok(tabs && ['Nodal Analysis', 'Oil Well IPR', 'Gas Deliverability', 'Gas Lift'].every((t) => txt(tabs).indexOf(t) !== -1), 'hub tabs: ' + txt(tabs));
      fresh(app);
    },
  },
  {
    name: 'WPG11 Solve-button fallback: a solve slower than the interactive budget switches to the Solve button; changes wait; Solve runs one solve',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx); fresh(app);
      open(app); example(app, 'oil');
      P(app).budget(-1);                     // every solve now counts as slow
      app.change('wp_pr', '3050');
      assert.ok(ST(app).slow && app.el('wp_solve'), 'Solve button shown: ' + txt(app.el('wp_banner')));
      const c0 = app.win.__WP_MOCK.calls.solve;
      app.change('wp_pr', '2950');
      assert.strictEqual(app.win.__WP_MOCK.calls.solve, c0, 'no solve on change');
      assert.ok(/wp-stale/.test(app.el('wp_root').className) && /press Solve|Solve button/.test(txt(app.el('wp_banner'))), 'stale state');
      assert.ok(ST(app).stale, 'WTS_state marks stale');
      app.click('wp_solve');
      assert.strictEqual(app.win.__WP_MOCK.calls.solve, c0 + 1, 'one solve');
      assert.strictEqual(P(app).state().M.res.pr, 2950);
      P(app).budget(300); app.change('wp_pr', '3000');
      assert.ok(!ST(app).slow && !ST(app).stale);
      fresh(app);
    },
  },
  {
    name: 'WPG12 drag handles: pointer drag of p̄r re-solves on every move (live), commits on release (autosave), axes stay still; keyboard [ ] + arrows move the bean',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx); fresh(app);
      open(app); example(app, 'oil');
      const cv = app.el('wp_cv_sys'), st = cv._wp, A = cv._wpAxes, h = st.handleHits.find((x) => x.i === 0);
      const r = cv.getBoundingClientRect(), sx = r.width / A.w, sy = r.height / A.h;
      const pe = (type, x, y) => cv.dispatchEvent(new app.win.PointerEvent(type, { bubbles: true, clientX: r.left + x * sx, clientY: r.top + y * sy, pointerId: 7 }));
      const yr0 = A.yr.slice(), n0 = app.win.__WP_MOCK.calls.solve, q0 = ST(app).op.q;
      pe('pointerdown', h.x, h.y);
      pe('pointermove', h.x, h.y - 20);
      pe('pointermove', h.x, h.y - 40);
      assert.ok(app.win.__WP_MOCK.calls.solve >= n0 + 2, 'live solves during the drag');
      assert.deepStrictEqual(cv._wpAxes.yr, yr0, 'axes locked while dragging');
      const pr = +app.el('wp_pr').value;
      assert.ok(pr > 3000, 'p̄r raised: ' + pr);
      assert.ok(ST(app).op.q > q0, 'more rate with more p̄r');
      pe('pointerup', h.x, h.y - 40);
      app.flush(1200);
      assert.strictEqual(String(JSON.parse(app.storage.getItem('wts_page_wellperf')).f.wp_pr), String(pr), 'committed value autosaved');
      // keyboard: ] picks the next handle (bean), ArrowRight moves it one step and solves
      cv.focus && cv.focus();
      const key = (k) => cv.dispatchEvent(new app.win.KeyboardEvent('keydown', { key: k, bubbles: true }));
      st.focusHandle = 0; key(']');
      assert.strictEqual(st.spec.handles[st.focusHandle].key, 'bean');
      key('ArrowRight'); key('Enter');
      assert.strictEqual(app.el('wp_bean').value, '33', 'bean 32 → 33');
      assert.strictEqual(P(app).state().M.surface.choke.bean64, 33);
      // THP rail when the choke is out of line
      app.check('wp_choke', false); app.change('wp_thp', '150'); app.flush(10);
      assert.ok(cv._wp.spec.handles.some((x) => x.key === 'thp' && x.kind === 'railY'), 'THP rail without a choke');
      P(app).handle('thp', cv._wp.spec.handles.find((x) => x.key === 'thp').value + 50, 'end');
      assert.strictEqual(P(app).state().M.system.thp_psig, 200, 'THP 150 → 200 psig');
      // zoom / pan / reset
      cv.dispatchEvent(new app.win.WheelEvent('wheel', { bubbles: true, deltaY: -100, clientX: r.left + 200 * sx, clientY: r.top + 150 * sy }));
      assert.ok(cv._wp.view, 'zoomed'); cv.dispatchEvent(new app.win.MouseEvent('dblclick', { bubbles: true }));
      assert.strictEqual(cv._wp.view, null, 'double-click resets');
      fresh(app);
    },
  },
  {
    name: 'WPG13 deviated schematic: S-shaped gas well drawn on the vertical section and plan view; hover reads MD / TVD / inclination / p / T / holdup; click edits; colour property switches',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx); fresh(app);
      open(app); example(app, 'gas');
      const sch = app.el('wp_sch').innerHTML;
      assert.ok(/PLAN VIEW/.test(sch) && /data-comp="restr:0"/.test(sch) && /data-comp="perf"/.test(sch) && /data-comp="choke"/.test(sch) && /data-comp="gauge:0"/.test(sch), 'components drawn');
      const pts = P(app).state().schPts;
      const xs = pts.map((p) => p.x);
      assert.ok(Math.max.apply(null, xs) - Math.min.apply(null, xs) > 20, 'the path departs from vertical (S shape)');
      // hover the station nearest 4,000 ft MD
      const p = pts.reduce((a, b) => (Math.abs(b.md - 4000) < Math.abs(a.md - 4000) ? b : a));
      const svg = app.find('#wp_sch svg'), r = svg.getBoundingClientRect(), st = P(app).state();
      app.el('wp_schw').dispatchEvent(new app.win.PointerEvent('pointermove', { bubbles: true, clientX: r.left + p.x * r.width / st.schW, clientY: r.top + p.y * r.height / st.schH }));
      const tip = txt(app.el('wp_tip'));
      ['MD', 'TVD', 'Inclination', 'Pressure', 'Temperature', 'Holdup'].forEach((w) => assert.includes(tip, w));
      assert.match(tip, /Inclination 30(\.0)?°/, 'hold section at 30°: ' + tip);
      assert.ok(/on/.test(app.el('wp_tip').className));
      // heat-map property
      app.select('wpv_prop', 'pattern'); app.flush(5);
      assert.ok(/Flow pattern/.test(app.el('wp_sch').innerHTML), 'colour bar follows the property');
      assert.strictEqual(JSON.parse(app.storage.getItem('wtspref_wp_plots')).prop, 'pattern', 'device pref');
      // click a restriction → step ③ with the row highlighted
      app.click(app.find('#wp_sch [data-comp="restr:1"]'));
      assert.strictEqual(app.el('wp_step_3').style.display, '', 'step ③ shown');
      assert.ok(/wp-flash/.test(app.find('#wp_tbl_restrictions tr[data-r="1"]').className), 'row highlighted');
      app.click(app.find('#wp_sch [data-comp="choke"]'));
      assert.strictEqual(app.el('wp_step_5').style.display, '', 'choke → step ⑤');
      // traverse: TVD / MD toggle, pattern bands, hydrate line
      app.click(app.find('#wp_depthseg [data-depth="md"]'));
      const tr = app.el('wp_cv_tr')._wp.spec;
      assert.ok(/^MD/.test(tr.y.label) && tr.hbands.length >= 1 && tr.series.some((s) => s.key === 'thyd'), 'MD axis, pattern bands, hydrate line');
      app.click(app.find('#wp_depthseg [data-depth="tvd"]'));
      fresh(app);
    },
  },
  {
    name: 'WPG14 tables and imports: survey pasted from a spreadsheet (header skipped), TVD / departure / DLS columns, DFIT geometry import, PRiSM import with provenance chips; without engines the page shows its waiting state',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx); fresh(app);
      open(app); example(app, 'oil');
      P(app).goStep(3);
      app.click(app.find('[data-act="paste"][data-t="survey"]'));
      app.el('wp_pastet_survey').value = 'MD\tInc\tAzi\n0\t0\t0\n1000\t0\t45\n1500\t15\t45\n2000\t30\t45\n3000\t30\t45';
      app.click(app.find('[data-act="pasteok"][data-t="survey"]'));
      assert.deepStrictEqual(plain(P(app).state().M.well.survey), [[0, 0, 0], [1000, 0, 45], [1500, 15, 45], [2000, 30, 45], [3000, 30, 45]]);
      const last = app.findAll('#wp_tbl_survey tbody tr')[4], ro = Array.from(last.querySelectorAll('td.ro')).map(txt);
      assert.strictEqual(ro.length, 3, 'TVD, departure, DLS');
      assert.ok(+ro[0].replace(/,/g, '') < 3000 && +ro[1].replace(/,/g, '') > 300, 'TVD below MD, departure: ' + ro.join(' | '));
      // DFIT import
      const dg = S.FIX.dfitGeometry;
      app.win.PRiSM_state = app.win.PRiSM_state || {};
      const saved = app.win.PRiSM_state.dfit;
      app.win.PRiSM_state.dfit = app.toWin(dg.state);
      try {
        app.document.dispatchEvent(new app.win.CustomEvent('wts:project-loaded', { detail: {} }));
        assert.match(txt(app.el('wpv_dfit')), /t1/);
        app.click(app.find('[data-act="dfit"]'));
        assert.deepStrictEqual(plain(P(app).state().M.well.survey), dg.expect.patch.survey, 'survey from the DFIT test');
        assert.strictEqual(P(app).state().M.well.midPerfMd, 9500, 'mid-perf from the DFIT datum');
        assert.match(txt(app.el('wp_dfitmsg')), /imported from DFIT test t1/);
      } finally { app.win.PRiSM_state.dfit = saved; }
      // PRiSM import (fromWell): values + provenance chips, p̄r left empty when its provenance is default
      const keepFW = app.win.WTS_wp_ipr.fromWell;
      app.win.WTS_wp_ipr.fromWell = () => app.toWin({ ok: true, spec: { model: 'pi', pr: null, T_F: 210, params: { J: 3.1 } }, provenance: { T_F: 'PRiSM', J: 'PRiSM fit' } });
      P(app).goStep(2);
      app.click(app.find('[data-act="prism"]'));
      assert.strictEqual(app.el('wp_ip_J').value, '3.1');
      assert.match(txt(app.find('label[for="wp_ip_J"]')), /PRiSM fit/, 'provenance chip');
      assert.match(txt(app.el('wp_prismmsg')), /p̄r was not imported/);
      app.win.WTS_wp_ipr.fromWell = keepFW;
      // without engines: the WP0 stubs → waiting state, no exception
      const keep = app.win.WTS_wp_system.solve;
      app.win.WTS_wp_system.solve = () => app.toWin({ ok: false, code: 'STUB', name: 'WTS_wp_system.solve', wp: 'WP5', errors: ['not built'], warnings: [] });
      try {
        app.change('wp_pr', '3000');
        assert.ok(!ST(app).ok && ST(app).stubs.indexOf('WTS_wp_system.solve') !== -1);
        assert.match(txt(app.el('wp_banner')), /engines of this module are being installed/);
        assert.ok(!BAD.test(txt(app.el('wp_res'))), 'clean waiting state');
      } finally { app.win.WTS_wp_system.solve = keep; }
      P(app).goStep(1);
      fresh(app);
    },
  },
];
