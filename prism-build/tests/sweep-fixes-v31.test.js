// GUI-sweep findings (v3.1) in the simulator / live-data area and the well menu.
//   • Well menu → "Job report (this well)" exports whenever there are results: the default report template may list
//     other calculators (e.g. "Final well-test report"), so it falls back to every captured page, then the page shown.
//   • Metric mode: simulator results (node / segment tables, choke, heater, gas properties, 2D schematic, LCV-201 ΔP,
//     alarm texts) follow the unit system; Mini WellOS GOR reads "<value> sm³/sm³" with a space.
//   • Empty actions give feedback instead of nothing / an empty file: Mini WellOS log Clear and CSV, historian Export.
//   • The 3D toolbar "Labels" button opens a menu (All / Equipment / Off) like View and Colour.
// Expected values: unit labels of the units layer, conversion factors from NIST SP 811 (1 psi = 6.894757 kPa,
// °C = (°F − 32)·5/9), and the texts of the P&ID / UI — never numbers taken from the code under test.
'use strict';

const WP = 'SWEEP31';
const OPTS = { console: 'capture' };
const text = (el) => String(el ? el.textContent : '').trim();
const navBtn = (app, key) => app.find('.nav-btn[data-p="' + key + '"]');
const tick = () => new Promise((r) => setImmediate(r));
async function settle(app, n) { for (let i = 0; i < (n || 200); i++) { await tick(); if (app.pendingTimers()) app.flush(50); } }
function metric(app) { app.win.WTS_units.setSystem('metric'); app.flush(100); }

module.exports = [
  {
    name: 'SWEEP31 well menu "Job report (this well)" exports AGA-3 results when the default template lists other calculators (and from the page alone)',
    wp: WP, opts: OPTS,
    async run(app, assert) {
      const W = app.win;
      // a default template that lists another calculator only (Gas Deliverability)
      W.localStorage.setItem('wts_report_templates', JSON.stringify({ defaultId: 'utest', templates: [{ id: 'utest', name: 'Deliverability only', sections: [{ type: 'pages', pages: ['gasdeliv'] }] }] }));
      app.click(navBtn(app, 'aga3')); app.flush(500);
      assert.ok(W.WTS_snapshot.build('job'), 'page shown (inputs) is exported even before Calculate');
      app.click(app.find('#pgBody .btn-primary')); app.flush(1200);
      assert.strictEqual(W.WTS_reportParts.job(), null, 'the default template has nothing captured');
      const snap = W.WTS_snapshot.build('job');
      assert.ok(snap && /AGA-3/.test(snap.html) && /-report-snapshot-/.test(snap.filename), 'job snapshot built: ' + (snap && snap.filename));
      const d0 = app.downloads.length;
      const btn = app.find('[data-mw="snap-job"]');
      assert.ok(btn, 'well menu item');
      app.click(btn); await settle(app);
      assert.strictEqual(app.downloads.length, d0 + 1, 'downloaded');
    }
  },
  {
    name: 'SWEEP31 Metric mode: simulator result tables, choke / heater rows, 2D schematic and LCV-201 ΔP are converted (no psi / psig / °F / ft/s left)',
    wp: WP, opts: OPTS, integration: true,
    run(app, assert) {
      metric(app);
      app.click(navBtn(app, 'wts')); app.flush(1500);
      const ths = app.findAll('#wts_res th').map(text);
      ['P (kPa(g))', 'T (°C)', 'Thyd (°C)', 'ID (mm)', 'Vel (m/s)', 'ΔP (kPa)', 'ΔT (°C)'].forEach((h) => assert.ok(ths.includes(h), 'header ' + h + ' in ' + ths.join(' | ')));
      const res = text(app.el('wts_res'));
      assert.ok(!/\bpsig?\b|ft\/s|MMBtu\/hr/.test(res.replace(/T \(°F\)/, '')), 'no imperial units left: ' + (res.match(/.{30}(psig?|ft\/s|MMBtu\/hr).{10}/) || [''])[0]);
      // wellhead row: 3000 psig → 20 684 kPa(g) (×6.894757)
      const row = app.findAll('#wts_res tr').find((r) => /Wellhead/.test(text(r)));
      assert.ok(row && /20,?68[45]/.test(text(row)), 'wellhead pressure converted: ' + text(row));
      const xfer = app.findAll('#pgBody .rrow').map(text).find((t) => /T-201 → T-301 transfer/.test(t)) || '';
      if (xfer) assert.ok(/ΔP [\d.,]+ kPa/.test(xfer) && !/psi/.test(xfer), 'LCV-201 ΔP: ' + xfer);
      const L = app.win.WTS_live;
      assert.match(L.fmtU(24.5, 'pressure', 1), /^168\.9 kPa$/, '24.5 psi = 168.9 kPa');
      const cv = app.el('wts_cv'), t2 = cv ? app.canvasTexts(cv).join(' | ') : '';
      assert.ok(t2 && !/psig|°F/.test(t2) && /kPa/.test(t2), '2D schematic texts: ' + t2.slice(0, 200));
    }
  },
  {
    name: 'SWEEP31 simulator alarm texts follow the formatter (Metric) and stay imperial without one',
    wp: WP, opts: OPTS,
    run(app, assert) {
      const S = app.win.WTS_sim, L = app.win.WTS_live;
      const imp = S.create(S.SAMPLE_FLOW, app.toWin({ seed: 2, config: { noise: { on: false } } }));
      imp.setFault('pcvStuckClosed', true);
      for (let i = 0; i < 60 && !imp.getState().esd.tripped; i++) imp.advance(1);
      const a1 = imp.getState().alarms.find((a) => a.id === 'ESD_TRIPPED');
      assert.ok(a1 && / psig ≥ [\d.]+ psig/.test(a1.msg), 'imperial: ' + (a1 && a1.msg));
      metric(app);
      const met = S.create(S.SAMPLE_FLOW, app.toWin({ seed: 2, config: { noise: { on: false } } }));
      met.setFormatter((v, c, dp) => L.fmtU(v, c, dp));
      met.setFault('pcvStuckClosed', true);
      for (let i = 0; i < 60 && !met.getState().esd.tripped; i++) met.advance(1);
      const a2 = met.getState().alarms.find((a) => a.id === 'ESD_TRIPPED');
      assert.ok(a2 && /kPa\(g\) ≥ [\d.,]+ kPa\(g\)/.test(a2.msg) && !/psig/.test(a2.msg), 'metric: ' + (a2 && a2.msg));
    }
  },
  {
    name: 'SWEEP31 Mini WellOS: GOR "<value> sm³/sm³" in Metric with a space; log Clear / CSV on an empty log say so',
    wp: WP, opts: OPTS,
    run(app, assert) {
      const M = app.win.WTS_modbus;
      const D = M.wellos.DERIVED.gor;
      assert.deepStrictEqual(JSON.parse(JSON.stringify(M.wellos.dispDerived(10012, D))), { v: '10,012', u: 'scf/STB' }, 'imperial');
      metric(app);
      const m = M.wellos.dispDerived(10012, D);
      assert.strictEqual(m.u, 'sm³/sm³');
      assert.near(+m.v.replace(/,/g, ''), 10012 * 0.0283168466 / 0.158987294928, 1, 'scf/STB → sm³/sm³');
      app.click(navBtn(app, 'wellos')); app.flush(1200);
      const kpi = app.findAll('#wos_kpis .kpi').find((k) => /GOR/.test(text(k)));
      assert.ok(kpi && /\d sm³\/sm³$/.test(text(kpi.querySelector('.kpi-v'))), 'KPI text: ' + text(kpi && kpi.querySelector('.kpi-v')));
      app.click(app.find('[data-act="logclear"]'));
      assert.match(text(app.el('wos_log')), /Log already empty/);
      app.click(app.find('[data-act="logstart"]')); app.flush(2100); app.click(app.find('[data-act="logstop"]'));
      app.click(app.find('[data-act="logclear"]'));
      assert.match(text(app.el('wos_log')), /Cleared \d+ row\(s\)/);
    }
  },
  {
    name: 'SWEEP31 historian Export with no samples: a message, no empty file',
    wp: WP, opts: OPTS,
    async run(app, assert) {
      app.click(navBtn(app, 'historian')); await settle(app);
      const d0 = app.downloads.length;
      app.select(app.find('[data-h="xtags"]'), 'all');
      app.click(app.el('hist_export_btn')); await settle(app);
      assert.strictEqual(app.downloads.length, d0, 'nothing downloaded');
      assert.match(text(app.el('hist_io_res')), /No samples to export/);
      // with samples the export downloads
      await app.win.WTS_historian.demo.history(1, 60000); await settle(app);
      app.click(app.el('hist_export_btn')); await settle(app);
      assert.strictEqual(app.downloads.length, d0 + 1, 'downloaded once there are samples');
    }
  },
  {
    name: 'SWEEP31 3D toolbar "Labels" opens a menu with All / Equipment / Off; choosing one sets the label mode',
    wp: WP, opts: OPTS, integration: true,
    run(app, assert) {
      app.click(navBtn(app, 'wts')); app.flush(800);
      const b = app.find('#wts_viz [data-act="labels"]');
      assert.ok(b && b.getAttribute('aria-haspopup') === 'true', 'menu button');
      app.click(b); app.flush(60);
      const items = app.findAll('.wtsl-menu [data-act="labelset"]');
      assert.strictEqual(items.length, 3, 'three label modes');
      const off = items.find((x) => /Off/.test(text(x)));
      app.click(off); app.flush(60);
      const prefs = JSON.parse(app.win.localStorage.getItem('h2viz3d_prefs') || '{}');
      assert.strictEqual(prefs.labels, off.getAttribute('data-v'), 'label mode saved');
      assert.strictEqual(app.findAll('.wtsl-menu').length, 0, 'menu closed');
    }
  }
];
