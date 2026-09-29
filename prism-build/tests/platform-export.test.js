// P9 export + "Send to PRiSM rate history", and the P2 service-worker
// registration guard in the app.
//   • header CSV / JSON export of any page (same model as the PDF export);
//   • WTS_sendRateToPRiSM: C2 contract — append-only step in the ① Data
//     multi-rate table, seeded from the dataset's own steps, fluid check,
//     prism:period-changed; the Oil & Gas Rate / AGA-3 page cards;
//   • WTS_offline: registers ./sw.js only on http(s) with service-worker
//     support, never in a native shell; update bar → skip-waiting → reload;
//     the iOS bundle has the block stripped.
// The G1 deliverability values (n = 0.8700, C = 1.700e-2) are the textbook
// flow-after-flow case of calc-new1 (independent reference script).
'use strict';

const fs = require('fs');
const path = require('path');
const WP = 'P9EXP';

function go(app, key) {
  const b = app.find('.nav-btn[data-p="' + key + '"]');
  if (!b) throw new Error('no sidebar button ' + key);
  app.click(b);
}
const lastDownload = (app) => app.downloads[app.downloads.length - 1];

module.exports = [
  {
    name: 'CSV export: long format with part / section / row / item / value / number / unit, BOM, formula-safe cells',
    wp: WP,
    async run(app, assert) {
      app.storage.setItem('h2oil_client_info', JSON.stringify({ client: 'Acme', well: '=W-1' }));
      go(app, 'gasdeliv');
      app.click('gd_go');
      await app.win.exportPageCSV();
      const d = lastDownload(app);
      assert.ok(d && /^Gas_Deliverability.*\.csv$/.test(d.filename), 'file name ' + (d && d.filename));
      assert.strictEqual(d.content.charCodeAt(0), 0xFEFF, 'UTF-8 BOM for spreadsheets');
      const rows = app.win.WTS_csv.parse(d.content).rows.map((r) => Array.from(r));
      assert.deepStrictEqual(rows[0], ['Part', 'Section', 'Row', 'Item', 'Value', 'Number', 'Unit']);
      const find = (pred) => rows.filter(pred)[0];
      const n = find((r) => r[0] === 'Results' && r[3] === 'Exponent n');
      assert.ok(n && n[4] === '0.8700' && Number(n[5]) === 0.87 && n[6] === '', 'n row: ' + JSON.stringify(n));
      const pr = find((r) => r[0] === 'Inputs' && /Average reservoir pressure/.test(r[3]));
      assert.ok(pr && Number(pr[5]) === 1952, 'input row: ' + JSON.stringify(pr));
      const tbl = find((r) => r[1] === 'Deliverability Table' && r[2] === '1' && /^pwf/.test(r[3]));
      assert.ok(tbl && tbl[3] === 'pwf (psia)', 'table cell with its column header: ' + JSON.stringify(tbl));
      const tp = find((r) => r[1] === 'Test Points' && r[2] === '1' && /Rate q/.test(r[3]));
      assert.ok(tp && Number(tp[5]) === 2624.6, 'input table cell: ' + JSON.stringify(tp));
      const well = find((r) => r[0] === 'Client' && r[3] === 'Well');
      assert.strictEqual(well[4], "'=W-1", 'text that looks like a formula is neutralised');
      assert.ok(!rows.some((r) => /Paste \/ import CSV/.test(r.join(' '))), 'import panel not exported');
      // cell rules
      const cell = app.win.WTS_resultsToCSV(app.toWin({ title: 'T', subtitle: '', exported: 'x', unitSystem: 'imperial', client: [],
        inputs: [], results: [{ title: 'S', items: [{ type: 'value', label: 'a,b', value: '-5' }, { type: 'value', label: 'q"x"', value: '@SUM(A1)' }] }] }));
      assert.ok(cell.indexOf('Results,S,,"a,b",-5,-5,') !== -1, 'comma quoted, negative number kept: ' + cell);
      assert.ok(cell.indexOf('"q""x""",\'@SUM(A1),,') !== -1, 'quotes doubled, @ neutralised: ' + cell);
    },
  },
  {
    name: 'JSON export: structured inputs / results with numbers split from units; metric pages export metric text',
    wp: WP,
    async run(app, assert) {
      go(app, 'gasdeliv');
      app.click('gd_go');
      await app.win.exportPageJSON();
      let j = JSON.parse(lastDownload(app).content);
      assert.strictEqual(j.format, 'h2oil-wts-results'); assert.strictEqual(j.version, 1);
      assert.strictEqual(j.page, 'gasdeliv'); assert.strictEqual(j.unitSystem, 'imperial');
      const bp = j.results.filter((s) => /^Back-pressure Equation/.test(s.title))[0];
      const aof = bp.items.filter((i) => i.label === 'AOF')[0];
      assert.ok(aof.type === 'value' && Math.abs(aof.number - 9033.5) < 1 && /^MSCFD/.test(aof.unit), 'AOF: ' + JSON.stringify(aof));
      const tbl = j.results.filter((s) => s.title === 'Deliverability Table')[0].items[0];
      assert.ok(tbl.type === 'table' && tbl.columns[0] === 'pwf (psia)' && tbl.rows.length === 11, 'table');
      assert.ok(j.inputs.some((s) => s.title === 'Test Points'), 'inputs present');
      assert.ok(j.results.some((s) => s.items.some((i) => i.type === 'verdict')), 'verdicts present');
      // metric
      app.win.WTS_units.setSystem('metric');
      try {
        await app.win.exportPageJSON();
        j = JSON.parse(lastDownload(app).content);
        assert.strictEqual(j.unitSystem, 'metric');
        const a2 = j.results.filter((s) => /^Back-pressure/.test(s.title))[0].items.filter((i) => i.label === 'AOF')[0];
        assert.ok(/^m³\/d/.test(a2.unit) && Math.abs(a2.number - 9033.5 * 28.3168) / (9033.5 * 28.3168) < 1e-3, 'metric AOF: ' + JSON.stringify(a2));
      } finally { app.win.WTS_units.setSystem('imperial'); }
      // header buttons exist
      assert.ok(app.find('#exportBtns [onclick="exportPageCSV()"]') && app.find('#exportBtns [onclick="exportPageJSON()"]'), 'CSV + JSON buttons');
    },
  },
  {
    name: 'Send to PRiSM: append-only step through the C2 rate history; seeded from the data; fluid and order checks',
    wp: WP,
    run(app, assert) {
      const w = app.win;
      let r = w.WTS_sendRateToPRiSM({ phase: 'oil', q: 500, t: 130 });
      assert.strictEqual(r.code, 'no-dataset', 'refused without a dataset');
      app.seedSample();                                  // oil well, 850 STB/d from t = 0, data to 120 h
      const before = w.PRiSM_rateHistory();
      assert.strictEqual(before.source, 'dataset');
      const events = [];
      w.addEventListener('prism:period-changed', (e) => events.push(e.detail));
      r = w.WTS_sendRateToPRiSM({ phase: 'gas', q: 500, t: 130 });
      assert.strictEqual(r.code, 'phase', 'gas rate refused for an oil well');
      r = w.WTS_sendRateToPRiSM({ phase: 'oil', q: 0, t: 0 });
      assert.strictEqual(r.code, 'order', 'a step at or before the last one is refused: ' + r.error);
      r = w.WTS_sendRateToPRiSM({ phase: 'oil', q: 855, t: 60 });
      assert.strictEqual(r.code, 'same', 'within 1 % of the previous rate → merged by C2, refused');
      assert.strictEqual(events.length, 0, 'nothing changed yet');
      r = w.WTS_sendRateToPRiSM({ phase: 'oil', q: 0, t: 60 });
      assert.ok(r.ok && r.seeded, JSON.stringify(r));
      assert.deepStrictEqual(JSON.parse(JSON.stringify(w.PRiSM.multiRate)), [{ t: 0, q: 850 }, { t: 60, q: 0 }]);
      assert.deepStrictEqual(JSON.parse(app.storage.getItem('wts_prism_mrate')), [{ t: 0, q: 850 }, { t: 60, q: 0 }], 'persisted');
      const after = w.PRiSM_rateHistory();
      assert.strictEqual(after.source, 'multiRate');
      assert.strictEqual(after.periods.length, before.periods.length + 1, 'one more flow period');
      assert.strictEqual(after.periods[0].t0, before.periods[0].t0, 'earlier period keeps its start (index 0 unchanged)');
      assert.strictEqual(after.periods[1].type, 'shut-in', 'new period is the shut-in');
      assert.strictEqual(events.length, 1, 'prism:period-changed fired');
      assert.strictEqual(events[0].source, 'rate-history');
      r = w.WTS_sendRateToPRiSM({ phase: 'oil', q: 400, t: 150 });
      assert.ok(r.ok && !r.seeded && r.warnings.some((x) => /after the end of the loaded data/.test(x)), 'beyond the data: warned');
      assert.strictEqual(w.PRiSM.multiRate.length, 3);
    },
  },
  {
    name: 'Oil & Gas Rate and AGA-3 pages: the card sends the calculated rate; reports leave the card out',
    wp: WP,
    run(app, assert) {
      const w = app.win;
      app.seedSample();
      go(app, 'oilgas');
      assert.ok(app.el('og_ps_go'), 'card on Oil & Gas Rate');
      app.select('og_ps_ph', 'oil');
      app.input('og_ps_t', '72');
      app.click('og_ps_go');
      const og = w.WTS_state.oilgas;
      assert.ok(og.ok && og.oil_stbd > 0, 'calculated on send');
      assert.ok(/Step added/.test(app.el('og_ps_msg').textContent), app.el('og_ps_msg').textContent);
      const last = w.PRiSM.multiRate[w.PRiSM.multiRate.length - 1];
      assert.strictEqual(last.t, 72);
      assert.rel(last.q, og.oil_stbd, 1e-9, 'the page oil rate in STB/d');
      app.select('og_ps_ph', 'gas');
      app.input('og_ps_t', '80');
      app.click('og_ps_go');
      assert.ok(/only the oil rate/.test(app.el('og_ps_msg').textContent), 'gas refused for the oil well');
      const model = w.collectPageReport(app.el('pgBody'), { charts: false });
      assert.ok(JSON.stringify(model).indexOf('Send to PRiSM') === -1, 'card not in reports');
      // AGA-3 on a gas well
      w.PRiSM_setWell(app.toWin({ fluidType: 'gas' }), app.toWin({ source: 'user' }));
      go(app, 'aga3');
      app.input('a_ps_t', '100');
      app.click('a_ps_go');
      const ag = w.WTS_state.aga3;
      assert.ok(ag.ok && ag.gas_mscfd > 0 && /Step added/.test(app.el('a_ps_msg').textContent), app.el('a_ps_msg').textContent);
      assert.rel(w.PRiSM.multiRate[w.PRiSM.multiRate.length - 1].q, ag.gas_mscfd, 1e-9, 'MSCFD sent');
    },
  },
  {
    name: 'offline: sw.js registered only on http(s) with SW support, never in a native shell; update bar reloads via skip-waiting',
    wp: WP,
    async run(app, assert) {
      const O = app.win.WTS_offline;
      assert.strictEqual(O.state().status, 'off:unsupported', 'harness browser has no service workers');
      const nav = { serviceWorker: { register() {} } };
      assert.strictEqual(O.eligible({ protocol: 'file:' }, nav, {}), 'protocol');
      assert.strictEqual(O.eligible({ protocol: 'capacitor:' }, nav, {}), 'protocol');
      assert.strictEqual(O.eligible({ protocol: 'https:' }, nav, { Capacitor: { isNativePlatform: () => true } }), 'native');
      assert.strictEqual(O.eligible({ protocol: 'https:' }, {}, {}), 'unsupported');
      assert.strictEqual(O.eligible({ protocol: 'https:' }, nav, { Capacitor: { isNativePlatform: () => false } }), '');
      // fake service-worker container
      const L = {}, posted = [], calls = [];
      const waiting = { postMessage: (m) => posted.push(m) };
      const active = { postMessage: (m) => posted.push(m) };
      app.win.navigator.serviceWorker = {
        controller: {},
        addEventListener: (t, fn) => { L[t] = fn; },
        register: (url, o) => { calls.push([url, o && o.scope]); return Promise.resolve({ active, waiting, addEventListener() {} }); },
      };
      let reloads = 0;
      app.win.location.reload = () => { reloads++; };
      assert.strictEqual(O.init(), 'registering');
      await app.flushAsync(0);
      assert.deepStrictEqual(calls, [['sw.js', './']], 'relative sw.js, page-folder scope');
      assert.deepStrictEqual(JSON.parse(JSON.stringify(posted[0])), { type: 'WTS_CACHE_SHELL', url: 'http://localhost:8080/well-testing-app.html' }, 'asks the worker to keep this page');
      assert.ok(app.el('wts_sw_bar'), 'waiting worker → update bar');
      app.click('wts_sw_reload');
      assert.deepStrictEqual(JSON.parse(JSON.stringify(posted[1])), { type: 'WTS_SKIP_WAITING' });
      assert.strictEqual(reloads, 0, 'reload waits for the new worker');
      L.controllerchange();
      assert.strictEqual(reloads, 1, 'reloaded once the new worker took over');
      L.controllerchange();
      assert.strictEqual(reloads, 1, 'only once');
      // page-update notice from the worker (no waiting worker needed)
      app.el('wts_sw_bar').remove();
      L.message({ data: { type: 'WTS_SW_UPDATE' } });
      assert.ok(app.el('wts_sw_bar'), 'page update → bar');
      app.click('wts_sw_later');
      assert.ok(!app.el('wts_sw_bar'), 'dismissed');
    },
  },
  {
    name: 'iOS bundle: the service-worker block is stripped by sync-from-main.js; the web page keeps it',
    wp: WP,
    opts: false,
    run(app, assert) {
      const root = path.resolve(__dirname, '..', '..');
      const web = fs.readFileSync(path.join(root, 'well-testing-app.html'), 'utf8');
      const ios = fs.readFileSync(path.join(root, 'ios-app', 'www', 'index.html'), 'utf8');
      assert.ok(/\/\/ ── SW:START[\s\S]*sw\.register\('sw\.js'[\s\S]*\/\/ ── SW:END ──/.test(web), 'web page registers sw.js');
      assert.ok(ios.indexOf('SW:START') === -1 && ios.indexOf("register('sw.js'") === -1 && ios.indexOf('WTS_offline') === -1, 'no service worker in the iOS bundle');
      assert.ok(ios.indexOf('offline service worker: web only') !== -1, 'strip marker present');
      assert.ok(fs.existsSync(path.join(root, 'sw.js')), 'sw.js next to the web page');
      assert.ok(!fs.existsSync(path.join(root, 'ios-app', 'www', 'sw.js')), 'not copied into www');
    },
  },
];
