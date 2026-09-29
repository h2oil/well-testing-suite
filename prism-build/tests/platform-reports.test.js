// P4 report templates — host WTS_reportTemplates / WTS_exportJobReport
// (well-testing-app.html, "Report templates (P4)") and the header "▾" picker
// mounted by 30-quick-report.js.
//   • the default Quick Report ("All captured pages") is unchanged;
//   • Daily and Final built-ins: cover title, section order, client info,
//     events, rates, cumulative volumes, PRiSM fragment, "not captured" notes;
//   • user templates: picker editor → localStorage 'wts_report_templates'
//     (travels in project files), default for the Quick Report button,
//     sanitising + escaping of stored templates.
'use strict';

const WP = 'P4RPT';

function go(app, key) {
  const b = app.find('.nav-btn[data-p="' + key + '"]');
  if (!b) throw new Error('no sidebar button ' + key);
  app.click(b);
}
// Capture a page snapshot the way a user does: interact, wait for the debounce.
function capture(app, key, act) {
  go(app, key);
  act();
  app.flush(1200);
  const snaps = JSON.parse(app.storage.getItem('wts_report_snapshots') || '{}');
  if (!snaps[key]) throw new Error('page ' + key + ' not captured');
}
function report(app, fn) {
  const n = app.opened.length;
  const ret = fn();
  const w = app.opened[n];
  return { ret, html: w ? w.html() : null };
}
const pos = (h, s) => { const i = h.indexOf(s); if (i < 0) throw new Error('report lacks "' + s + '"'); return i; };
// Each string must appear after the previous one (searching on from there).
function inOrder(assert, html, list) {
  let at = 0;
  list.forEach((s) => { const i = html.indexOf(s, at); assert.ok(i !== -1, '"' + s + '" missing or out of order'); at = i + s.length; });
}
const setClient = (app, o) => app.storage.setItem('h2oil_client_info', JSON.stringify(o));

module.exports = [
  {
    name: 'default Quick Report = "All captured pages", unchanged; the three built-ins are listed',
    wp: WP,
    run(app, assert) {
      const T = app.win.WTS_reportTemplates;
      assert.deepStrictEqual(Array.from(T.list()).map((t) => t.id), ['all', 'daily', 'final']);
      assert.strictEqual(T.getDefault(), 'all');
      capture(app, 'flareghg', () => app.input('fe_qg', '7.5'));
      capture(app, 'gasdeliv', () => app.click('gd_go'));
      const { html } = report(app, () => app.win.WTS_exportJobReport());
      assert.ok(html, 'report opened');
      assert.ok(pos(html, '<title>Well Test Job Report</title>') >= 0);
      const sum = pos(html, '<span>00</span>Summary'), cit = pos(html, 'Calculators in this report');
      const gd = pos(html, '<span>01</span>Gas Deliverability'), fe = pos(html, '<span>02</span>Flare Emissions');
      assert.ok(sum < cit && cit < gd && gd < fe, 'summary first, then pages in sidebar order');
    },
  },
  {
    name: 'Daily well-test report: client info, events, rates, cumulative volumes and flare emissions in template order',
    wp: WP,
    run(app, assert) {
      setClient(app, { client: 'Acme Energy', well: 'W-7', field: 'North Block' });
      capture(app, 'oilgas', () => app.click(app.find('#pgBody .btn-primary')));
      capture(app, 'flareghg', () => app.input('fe_qg', '7.5'));
      const w = app.win;
      const og = w.WTS_state.oilgas;
      assert.ok(og && og.ok && og.oil_stbd > 0, 'Oil & Gas publishes WTS_state.oilgas');
      w.WTS_state.events = app.toWin([{ time: '06:00', tag: 'CK-101', msg: 'Opened well on 24/64 in choke' }, { time: '07:30', tag: 'SEP', msg: 'Diverted to separator' }]);
      w.WTS_state.sim = app.toWin({ elapsed_h: 2.5, cum: { oil_stb: 120.5, water_bbl: 3.25, gas_mmscf: 0.4125, flared_mmscf: 0.4 },
        rates: { gas_mmscfd: 4, oil_stbd: 1150, water_bpd: 30, gor: 3478, bsw_pct: 2.5 } });
      const { ret, html } = report(app, () => w.WTS_reportTemplates.generate('daily'));
      assert.strictEqual(ret, true);
      assert.ok(pos(html, '<title>Daily Well Test Report</title>') >= 0, 'cover title');
      const order = ['Client &amp; well information', 'Acme Energy', 'Sequence of events', 'Opened well on 24/64 in choke',
        '<span>03</span>Rates', 'Oil &amp; Gas Rate', 'Well Test Simulator (T+02:30:00)', 'Rate calculations',
        'Cumulative volumes', 'Cumulative oil', 'Flare emissions'];
      inOrder(assert, html, order);
      // rates row: the Oil & Gas oil rate formatted as on the page (1 dp, BPD)
      const oilTxt = Number(og.oil_stbd).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 1 }) + ' BPD';
      assert.ok(html.indexOf(oilTxt) !== -1, 'oil rate ' + oilTxt);
      assert.ok(html.indexOf('120.5 STB') !== -1 && html.indexOf('0.4125 MMSCF') !== -1, 'cumulative volumes from the simulator');
      assert.ok(/Not captured yet: AGA-3/.test(html), 'missing AGA-3 page is named');
      assert.ok(html.indexOf('W-7 · Daily well-test report') !== -1, 'subtitle names the well and template');
    },
  },
  {
    name: 'Final well-test report: summary, deliverability/IPR, PRiSM fragment, emissions and safety checks',
    wp: WP,
    run(app, assert) {
      capture(app, 'gasdeliv', () => app.click('gd_go'));
      capture(app, 'oilipr', () => app.click('oi_go'));
      capture(app, 'flareghg', () => app.input('fe_qg', '5'));
      const w = app.win;
      w.PRiSM_getLastFit = () => app.toWin({ phys: { k: 12.34, S: 1.5 }, modelKey: 'homogeneous' });
      w.PRiSM_buildReportHTML = () => '<section class="rp-sec"><h2>PRISM-FRAGMENT-MARK</h2></section>';
      const { html } = report(app, () => w.WTS_exportJobReport({ template: 'final' }));
      assert.ok(pos(html, '<title>Final Well Test Report</title>') >= 0);
      const order = ['Test summary', 'Pages in this report', 'Deliverability &amp; inflow performance', 'Gas Deliverability', 'Oil Well IPR',
        'Pressure-transient analysis (PRiSM)', 'PRISM-FRAGMENT-MARK', 'Emissions', 'Flare Emissions', 'Safety checks'];
      inOrder(assert, html, order);
      assert.ok(html.indexOf('homogeneous · k = 12.3 md, S = 1.50') !== -1, 'PRiSM row in the summary table');
      assert.ok(/Not captured yet: ESD Hi-Pilot, ESD Lo-Pilot, Hydrate Management/.test(html), 'missing safety pages named');
      // results-only detail: a user template that drops the inputs
      const id = w.WTS_reportTemplates.save(app.toWin({ id: 'uresults', name: 'Results only', title: 'Results', sections: [{ type: 'pages', pages: ['gasdeliv'], detail: 'results' }] }));
      assert.strictEqual(id, 'uresults');
      const r2 = report(app, () => w.WTS_exportJobReport({ template: 'uresults' })).html;
      assert.ok(r2.indexOf('AOF') !== -1 && r2.indexOf('Test Type &amp; Reservoir') === -1, 'inputs left out');
    },
  },
  {
    name: 'picker: duplicate a built-in, add/move/remove sections, save, make it the Quick Report default; survives reload + project file',
    wp: WP,
    run(app, assert) {
      capture(app, 'flareghg', () => app.input('fe_qg', '6'));
      app.flush(10);
      const btn = app.find('[data-wts-qr-tpl]');
      assert.ok(btn, 'template button next to Quick Report');
      app.click(btn);
      const ov = app.el('wts_rt_ov');
      assert.ok(ov && ov.querySelector('[role="dialog"]'), 'dialog open');
      const q = (sel) => app.el('wts_rt_box').querySelector(sel);
      app.check(q('input[name="wts_rt_pick"][value="daily"]'), true);
      assert.ok(/Sections of “Daily well-test report”/.test(app.el('wts_rt_box').textContent), 'preview follows the selection');
      app.click(q('[data-rt="edit"]'));
      assert.ok(q('[data-rt-f="name"]').value === 'Daily well-test report (copy)', 'duplicate of the built-in');
      app.input(q('[data-rt-f="name"]'), 'Rig daily');
      app.input(q('[data-rt-f="title"]'), 'Rig Daily Report');
      app.select(q('[data-rt-f="add"]'), 't:notes');
      app.click(q('[data-rt="add"]'));
      const n = app.el('wts_rt_box').querySelectorAll('[data-rt-h]').length;
      assert.strictEqual(n, 7, 'six built-in sections + notes');
      app.input(q('[data-rt-x="6"]'), 'Night shift: no incidents.');
      app.click(q('[data-rt="up"][data-i="6"]'));           // notes → position 6
      app.click(q('[data-rt="rm"][data-i="0"]'));           // drop client info
      app.click(q('[data-rt="save"]'));
      const st = JSON.parse(app.storage.getItem('wts_report_templates'));
      assert.strictEqual(st.templates.length, 1);
      const t = st.templates[0];
      assert.ok(/^u/.test(t.id) && t.name === 'Rig daily' && t.title === 'Rig Daily Report');
      assert.deepStrictEqual(t.sections.map((s) => s.type), ['events', 'rates', 'pages', 'sim', 'notes', 'pages']);
      assert.strictEqual(t.sections[4].text, 'Night shift: no incidents.');
      // make it the default → the plain Quick Report now uses it
      app.click(q('[data-rt="default"]'));
      assert.strictEqual(app.win.WTS_reportTemplates.getDefault(), t.id);
      app.click(q('[data-rt="close"]'));
      assert.ok(!app.el('wts_rt_ov'), 'closed');
      const { html } = report(app, () => app.win.WTS_exportJobReport());
      assert.ok(pos(html, '<title>Rig Daily Report</title>') >= 0, 'user template used by the Quick Report');
      inOrder(assert, html.slice(html.indexOf('<div class="rp-part')), ['Rate calculations', 'Not captured yet: Oil &amp; Gas Rate, AGA-3 Gas Metering',
        'Notes', 'Night shift: no incidents.', 'Flare emissions', 'Tier-1 reference']);
      assert.ok(html.indexOf('Client &amp; well information') === -1, 'removed section left out');
      // project file carries the key; reload keeps it
      const payload = JSON.stringify(app.win.WTS_project._buildPayload());
      assert.ok(payload.indexOf('wts_report_templates') !== -1 && payload.indexOf('Rig daily') !== -1, 'in the project payload');
      const app2 = app.reload();
      try {
        assert.ok(Array.from(app2.win.WTS_reportTemplates.list()).some((x) => x.name === 'Rig daily'), 'after reload');
        assert.strictEqual(app2.win.WTS_reportTemplates.getDefault(), t.id);
        app2.flushUntilIdle(10000);
        assert.strictEqual(app2.pendingTimers(), 0, 'no timers left');
      } finally { app2.dispose(); }
    },
  },
  {
    name: 'stored templates are sanitised and every string is escaped; empty reports explain what is missing',
    wp: WP,
    run(app, assert) {
      app.storage.setItem('wts_report_templates', JSON.stringify({ v: 1, defaultId: 'uevil', templates: [
        { id: 'uevil', name: '<img src=x onerror=alert(1)>', title: '</title><script>alert(2)</script>',
          sections: [{ type: 'notes', heading: '<b>h</b>', text: '<svg onload=alert(3)>' }, { type: 'script' }, { type: 'allPages', detail: 'x' }] },
        { id: 'daily', name: 'Hijack built-in', sections: [] },
        { id: 'u2', name: 'no pages', sections: [{ type: 'pages', pages: ['../x', 'Bad Key'] }] },
      ] }));
      const T = app.win.WTS_reportTemplates;
      const list = Array.from(T.list());
      assert.deepStrictEqual(list.map((x) => x.id), ['all', 'daily', 'final', 'uevil', 'u2'], 'built-in ids cannot be overridden');
      assert.strictEqual(T.get('daily').name, 'Daily well-test report');
      assert.strictEqual(T.get('uevil').sections.length, 2, 'unknown section type dropped');
      assert.strictEqual(T.get('u2').sections.length, 0, 'invalid page keys dropped');
      // nothing captured: explained, no report
      const e = report(app, () => app.win.WTS_exportJobReport({ template: 'daily' }));
      assert.strictEqual(e.ret, false);
      assert.ok(!e.html, 'no report opened');
      assert.ok(app.dialogs.some((d) => /Nothing captured yet for the "Daily well-test report" template/.test(d.message || d.text || String(d))), 'explained: ' + JSON.stringify(app.dialogs));
      capture(app, 'flareghg', () => app.input('fe_qg', '6'));
      const { html } = report(app, () => app.win.WTS_exportJobReport());
      assert.ok(html.indexOf('&lt;img src=x') !== -1 || html.indexOf('&lt;/title&gt;&lt;script&gt;') !== -1, 'escaped');
      assert.ok(html.indexOf('<img src=x') === -1 && html.indexOf('<script>alert(2)') === -1 && html.indexOf('<svg onload') === -1, 'no raw markup from storage');
      assert.ok(html.indexOf('&lt;svg onload=alert(3)&gt;') !== -1, 'notes text escaped');
    },
  },
];
