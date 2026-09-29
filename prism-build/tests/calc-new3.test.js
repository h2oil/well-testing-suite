// NEW3 — Flare Emissions plug-in calculator (prism-build/43-calc-flareghg.js).
//
//   route    flareghg  (window.WTS_calcRegistry.flareghg, group "Safety & Process")
//   render   window.renderFlareEmissions(body)
//   calc     window.calcFlareGHG()
//   compute  window.WTS_flareghg_compute(input)   — pure, field units
//
// Verification cases F1–F3 from NEW-CALCS-SPEC §3.7 (reference-script values),
// then the page driven through the harness (sources mode builds Round-9 from
// every prism-build/4N-calc-*.js): sidebar + route, Calculate button, result
// rows and verdicts, validation messages (no NaN), metric units, autosave +
// reload, PDF / Quick Report capture, 375 px and no pending timers.
'use strict';

const WP = 'NEW3';
const KEY = 'flareghg';

const Y = { c1: 85, c2: 6, c3: 3, ic4: 0.6, nc4: 0.8, ic5: 0.3, nc5: 0.3, c6: 0.2, c7: 0.2, co2: 2, n2: 1.5, h2s: 0.1 };
const BASE = { qg: 5, hrs: 24, ce: 98, ox1: false, gwp: 'ar5', tb: 60, pbase: 14.696, y: Y, c7n: 7, qo: 0, api: 40, wc: 85 };
const mk = (o) => Object.assign({}, BASE, o);

// ── page helpers ────────────────────────────────────────────────────────────
const text = (el) => String(el ? el.textContent : '').replace(/\s+/g, ' ').trim();
const navBtn = (app) => app.find('.nav-btn[data-p="' + KEY + '"]');
function go(app) {
  const b = navBtn(app);
  if (!b) throw new Error('no sidebar button for ' + KEY);
  app.click(b);
  app.flush(20);
}
function press(app) {
  const btn = app.findAll('#fe_root button').find((b) => (b.getAttribute('onclick') || '').indexOf('calcFlareGHG(') === 0);
  if (!btn) throw new Error('no Calculate button');
  app.click(btn);
  app.flush(20);
}
function rowText(app, label) {
  const rows = app.findAll('#fe_res .rrow');
  const row = rows.find((r) => text(r.querySelector('.rl')).indexOf(label) === 0);
  if (!row) throw new Error('row "' + label + '" not found: ' + text(app.el('fe_res')).slice(0, 300));
  return text(row.querySelector('.rv'));
}
const firstNum = (s) => parseFloat(String(s).replace(/,/g, '').match(/-?\d+(\.\d+)?(e[-+]?\d+)?/i)[0]);
const STATE_KEYS = ['V_scf', 'E_MMBtu', 'co2_t', 'ch4_t', 'n2o_kg', 'so2_t', 'co2e_t', 'co2oil_t'];

module.exports = [
  {
    name: 'compute: F1 (defaults), F2 (pure methane), F3 (oxidation factor 1 + liquid burner, AR6)',
    wp: WP,
    run(app, assert) {
      const f = app.win.WTS_flareghg_compute;
      assert.strictEqual(typeof f, 'function', 'WTS_flareghg_compute');
      const a = f(app.toWin(BASE));
      assert(a.ok, 'F1 ok: ' + a.errors.join('; '));
      assert.rel(a.Vm, 379.48, 1e-4, 'F1 Vm');
      assert.rel(a.Vscf, 5e6, 1e-9, 'F1 V');
      assert.rel(a.nmol, 13175.8, 1e-3, 'F1 n');
      assert.rel(a.MW, 19.718, 1e-3, 'F1 MW');
      assert.rel(a.SG, 0.6807, 1e-3, 'F1 SG');
      assert.rel(a.HHV, 1131.0, 1e-3, 'F1 HHV');
      assert.rel(a.E_MMBtu, 5654.7, 1e-3, 'F1 E');
      assert.rel(a.E_GJ, 5966.1, 1e-3, 'F1 E GJ');
      assert.rel(a.co2_t, 307.36, 1e-3, 'F1 CO2');
      assert.rel(a.ch4_t, 1.630, 1e-3, 'F1 CH4');
      assert.rel(a.n2o_kg, 0.565, 2e-3, 'F1 N2O');
      assert.rel(a.so2_t, 0.3752, 1e-3, 'F1 SO2');
      assert.rel(a.h2sUnburned_kg, 4.07, 2e-3, 'F1 unburned H2S');
      assert.rel(a.co2e_t, 353.15, 1e-3, 'F1 CO2e');
      assert.rel(a.co2ePerDay_t, 353.15, 1e-3, 'F1 CO2e/d');
      assert.rel(a.intensity, 70.63, 1e-3, 'F1 intensity');
      assert.rel(a.Nm3, 133955.8, 1e-3, 'F1 Nm3');
      assert.rel(a.tier1_t, 526.45, 1e-3, 'F1 Tier-1');
      assert.strictEqual(a.gwpCH4, 28); assert.strictEqual(a.gwpN2O, 265);

      const b = f(app.toWin(mk({ qg: 1, y: { c1: 100 } })));
      assert(b.ok, 'F2 ok');
      assert.rel(b.nmol, 2635.16, 1e-3, 'F2 n');
      assert.rel(b.co2_t, 51.553, 1e-3, 'F2 CO2');
      assert.rel(b.co2_t, 1e6 * 0.98 * 0.0526 / 1000, 2e-3, 'F2 = Subpart W density form');
      assert.rel(b.ch4_t, 0.3835, 1e-3, 'F2 CH4');
      assert.rel(b.E_MMBtu, 1010.0, 1e-3, 'F2 E');
      assert.rel(b.co2e_t, 62.318, 1e-3, 'F2 CO2e');
      assert.rel(b.Nm3, 26791.2, 1e-3, 'F2 Nm3');
      assert.rel(b.tier1_t, 105.29, 1e-3, 'F2 Tier-1');

      const c = f(app.toWin(mk({ qg: 2, hrs: 12, ox1: true, gwp: 'ar6', qo: 1000, api: 35, wc: 85 })));
      assert(c.ok, 'F3 ok');
      assert.rel(c.Vscf, 1e6, 1e-9, 'F3 V');
      assert.rel(c.co2_t, 62.705, 1e-3, 'F3 CO2 gas');
      assert.strictEqual(c.ch4_t, 0, 'F3 CH4');
      assert.strictEqual(c.h2sUnburned_kg, 0, 'F3 unburned H2S');
      assert.rel(c.so2_t, 0.07657, 1e-3, 'F3 SO2');
      assert.rel(c.n2o_kg, 0.1131, 1e-3, 'F3 N2O');
      assert.rel(c.oilMass_lb, 148791.7, 1e-3, 'F3 liquid mass');
      assert.rel(c.oilSG, 0.8498, 1e-3, 'F3 SG');
      assert.rel(c.co2oil_t, 210.20, 1e-3, 'F3 CO2 liquid');
      assert.rel(c.co2e_t, 272.94, 1e-3, 'F3 CO2e');
      assert.rel(c.co2ePerDay_t, 545.87, 1e-3, 'F3 CO2e/d');
    },
  },
  {
    name: 'compute: validation returns messages (never NaN) for every rule in §3.4',
    wp: WP,
    run(app, assert) {
      const f = (o) => app.win.WTS_flareghg_compute(app.toWin(mk(o)));
      const bad = [
        [{ qg: -1 }, /Gas to flare must be between/],
        [{ qg: 501 }, /Gas to flare must be between/],
        [{ qg: 0, qo: 0 }, /gas rate or a liquid-to-burner rate/],
        [{ hrs: 0 }, /Flaring duration/],
        [{ hrs: 9000 }, /8,760/],
        [{ ce: 40 }, /Combustion efficiency must be between 50 and 100/],
        [{ y: Object.assign({}, Y, { c2: -1 }) }, /Ethane C2 must be between 0 and 100/],
        [{ y: Object.assign({}, Y, { c1: 120 }) }, /Methane C1 must be between 0 and 100/],
        [{ y: { c1: 40 } }, /between 50 and 150/],
        [{ c7n: 5 }, /carbon number must be between 7 and 30/],
        [{ qo: -5 }, /Liquid to burner must be between/],
        [{ qo: 100, api: 2 }, /Liquid gravity must be between 5 and 90/],
        [{ qo: 100, wc: 95 }, /Carbon content must be between 80 and 90/],
        [{ tb: 20 }, /Base temperature must be between/],
        [{ pbase: 16 }, /Base pressure must be between/],
        [{ gwp: 'ar9' }, /GWP basis/],
        [{ qg: NaN }, /Gas to flare is required/],
      ];
      bad.forEach(([o, re]) => {
        const r = f(o);
        assert.strictEqual(r.ok, false, JSON.stringify(o) + ' should fail');
        assert(re.test(r.errors.join(' | ')), JSON.stringify(o) + ' → ' + r.errors.join(' | '));
        assert(!/NaN/.test(r.errors.join(' ')), 'no NaN in messages');
      });
      // Liquid-only burn is valid; composition totals ≠ 100 are normalised with a ⚠ verdict.
      const lo = f({ qg: 0, qo: 500, api: 35 });
      assert(lo.ok && lo.co2_t === 0 && lo.co2oil_t > 0 && lo.intensity === null, 'liquid-only burn');
      const n = f({ y: Object.assign({}, Y, { c1: 95 }) });   // total 110
      assert(n.ok && n.verdicts.some((v) => v.level === 'warn' && /normalised to 100/.test(v.text)), 'normalisation verdict');
      const lean = f({ y: { c1: 20, n2: 80 } });              // HHV 202 Btu/scf
      assert(lean.ok && lean.verdicts.some((v) => /below 300/.test(v.text)), 'low-HHV verdict');
    },
  },
  {
    name: 'page: sidebar button in Safety & Process, defaults calculate, F3 through the inputs + Calculate',
    wp: WP,
    run(app, assert) {
      const W = app.win;
      assert.strictEqual(typeof W.renderFlareEmissions, 'function');
      assert.strictEqual(typeof W.calcFlareGHG, 'function');
      assert(W.WTS_calcRegistry && W.WTS_calcRegistry[KEY], 'registered');
      const b = navBtn(app);
      assert(b, 'nav button');
      const lab = b.closest('.nav-group').querySelector('.nav-group-label');
      assert.strictEqual(text(lab), 'Safety & Process');
      go(app);
      assert.strictEqual(app.hook.page(), KEY);
      assert.strictEqual(text(app.el('pgTitle')), 'Flare Emissions');
      assert(/Flared gas volume, heat released/.test(text(app.el('pgSub'))));
      const res = app.el('fe_res');
      assert.strictEqual(res.getAttribute('data-done'), '1', 'defaults calculated on render');
      assert.rel(W.WTS_state.flareghg.co2_t, 307.36, 1e-3, 'F1 on the page');
      assert.rel(firstNum(rowText(app, 'CO2 from gas')), 307.36, 1e-3);
      assert.rel(firstNum(rowText(app, 'Total CO2e (IPCC AR5)')), 353.15, 1e-3);
      assert.rel(firstNum(rowText(app, 'Heating value HHV')), 1131.0, 1e-3);
      assert(/✓ Combustion efficiency 98 % applied/.test(text(res)), 'CE verdict');
      assert(/Notes/.test(text(res)));
      assert.strictEqual(app.findAll('#fe_res .rrow').filter((r) => /liquid/i.test(text(r))).length, 0, 'no liquid rows when q_o = 0');
      // F3 through the UI
      app.input('fe_qg', '2'); app.input('fe_hrs', '12');
      app.check('fe_ox1', true);
      app.select('fe_gwp', 'ar6');
      app.input('fe_qo', '1000'); app.input('fe_api', '35'); app.input('fe_wc', '85');
      press(app);
      const s = W.WTS_state.flareghg;
      assert.rel(s.co2_t, 62.705, 1e-3, 'F3 CO2 gas');
      assert.rel(s.co2oil_t, 210.20, 1e-3, 'F3 CO2 liquid');
      assert.rel(s.co2e_t, 272.94, 1e-3, 'F3 CO2e');
      assert.strictEqual(s.ch4_t, 0);
      assert.strictEqual(s.gwp, 'ar6');
      assert.rel(firstNum(rowText(app, 'CO2 from liquid burner')), 210.20, 1e-3);
      assert.rel(firstNum(rowText(app, 'CO2e per day')), 545.87, 1e-3);
      assert(/✓ Oxidation factor 1/.test(text(res)), 'ox1 verdict');
      assert(/Total CO2e \(IPCC AR6\)/.test(text(res)));
    },
  },
  {
    name: 'page: validation error card + input-err, cleared on the next good calc; no NaN anywhere',
    wp: WP,
    run(app, assert) {
      go(app);
      app.input('fe_ce', '40');
      app.input('fe_c7n', '3');
      press(app);
      const res = app.el('fe_res');
      assert(res.querySelector('.val-error'), 'error card');
      assert(/Please fix the following/.test(text(res)));
      assert(/Combustion efficiency must be between 50 and 100/.test(text(res)));
      assert(/carbon number must be between 7 and 30/.test(text(res)));
      assert(app.el('fe_ce').classList.contains('input-err') && app.el('fe_c7n').classList.contains('input-err'));
      assert(!res.querySelector('.rrow'), 'no results with errors');
      assert(res.getAttribute('data-done') !== '1');
      assert(!/NaN/.test(text(res)));
      app.input('fe_ce', '98'); app.input('fe_c7n', '7');
      press(app);
      assert(!res.querySelector('.val-error') && res.querySelector('.rrow'), 'results back');
      assert.strictEqual(app.findAll('#fe_root .input-err').length, 0, 'input-err cleared');
      // Blank a required field: message, not NaN
      app.input('fe_hrs', '');
      press(app);
      assert(/Flaring duration is required/.test(text(res)));
      assert(!/NaN/.test(text(app.el('fe_root'))));
    },
  },
  {
    name: 'metric: tagged labels show kPa / °C / Mm³/d, results equal the imperial run',
    wp: WP,
    run(app, assert) {
      const U = app.win.WTS_units;
      app.flush(10);
      go(app);
      const imp = Object.assign({}, app.win.WTS_state.flareghg);
      U.setSystem('metric');
      try {
        app.hook.nav('home'); app.flush(10);
        go(app);
        const lbl = (id) => text(app.el(id).closest('.fg-item').querySelector('label'));
        assert(/\(kPa\)/.test(lbl('fe_pbase')), lbl('fe_pbase'));
        assert(/\(°C\)/.test(lbl('fe_tb')), lbl('fe_tb'));
        assert(/\(Mm³\/d\)/.test(lbl('fe_qg')), lbl('fe_qg'));
        assert(/\(m³\/d\)/.test(lbl('fe_qo')), lbl('fe_qo'));
        const met = app.win.WTS_state.flareghg;
        STATE_KEYS.forEach((k) => {
          if (imp[k] === 0) assert.strictEqual(met[k], 0, k);
          else assert.rel(met[k], imp[k], 1e-6, 'metric ' + k);
        });
        assert(/MJ\/m³/.test(rowText(app, 'Heating value HHV')), 'HHV in MJ/m³');
        assert.rel(firstNum(rowText(app, 'Heating value HHV')), 1131.0 * 0.0372589, 2e-3);
        // Metric entry: 100 Mm³/d = 3.5315 MMSCFD
        app.input('fe_qg', '100');
        assert.rel(app.win.WTS_state.flareghg.V_scf, 100 * 1000 / 28316.8 * 1e6, 1e-4, 'metric entry converted');
      } finally { U.setSystem('imperial'); }
      app.flush(10);
      assert.rel(app.win.WTS_state.flareghg.V_scf, 100 * 1000 / 28316.8 * 1e6, 1e-4, 'unit flip keeps the physical value');
      assert(/MMSCF/.test(rowText(app, 'Volume flared')));
    },
  },
  {
    name: 'autosave → reload restores inputs and results; PDF + Quick Report capture; no pending timers',
    wp: WP,
    run(app, assert) {
      go(app);
      app.input('fe_qg', '7.5');
      app.check('fe_ox1', true);
      app.select('fe_gwp', 'ar4');
      const want = Object.assign({}, app.win.WTS_state.flareghg);
      assert.rel(want.V_scf, 7.5e6, 1e-9);
      app.flush(1200);
      const rec = JSON.parse(app.storage.getItem('wts_page_' + KEY) || 'null');
      assert(rec && rec.f && rec.f.fe_qg === '7.5' && rec.f.fe_ox1 === true && rec.f.fe_gwp === 'ar4', 'autosaved: ' + JSON.stringify(rec && rec.f));
      // Page PDF: inputs, results, verdict
      const n0 = app.opened.length;
      app.win.exportPagePDF();
      const pdf = app.opened[n0] && app.opened[n0].html();
      assert(pdf, 'PDF window opened');
      ['Flare Emissions', 'Gas to flare', 'Methane C1', 'Total CO2e', 'Oxidation factor 1', 'Tier-1 reference'].forEach((s) =>
        assert(pdf.indexOf(s) !== -1, 'PDF has ' + s));
      const snaps = JSON.parse(app.storage.getItem('wts_report_snapshots') || '{}');
      assert(snaps[KEY] && snaps[KEY].title === 'Flare Emissions', 'report snapshot');
      const n1 = app.opened.length;
      app.win.WTS_exportJobReport();
      const job = app.opened[n1] && app.opened[n1].html();
      assert(job && job.indexOf('Flare Emissions') !== -1 && job.indexOf('CO2 from gas') !== -1, 'Quick Report includes the page');
      app.flushUntilIdle(10000);
      assert.strictEqual(app.pendingTimers(), 0, 'no timers left');
      const app2 = app.reload();
      try {
        go(app2);
        assert.strictEqual(app2.el('fe_qg').value, '7.5', 'restored qg');
        assert.strictEqual(app2.el('fe_ox1').checked, true, 'restored checkbox');
        assert.strictEqual(app2.el('fe_gwp').value, 'ar4', 'restored select');
        const got = app2.win.WTS_state.flareghg;
        STATE_KEYS.forEach((k) => { if (want[k] === 0) assert.strictEqual(got[k], 0, k); else assert.rel(got[k], want[k], 1e-9, 'reload ' + k); });
        assert.strictEqual(got.gwp, 'ar4');
        app2.flushUntilIdle(10000);
        assert.strictEqual(app2.pendingTimers(), 0, 'no timers after reload');
      } finally { app2.dispose(); }
    },
  },
  {
    name: '375 px: page renders from the mobile sidebar, tables/inputs have no fixed widths over 340 px',
    wp: WP,
    opts: { viewport: { width: 375, height: 812 } },
    run(app, assert) {
      const b = navBtn(app);
      assert(b && b.closest('#sidebar'), 'button in the mobile sidebar');
      go(app);
      assert(app.el('fe_res').querySelector('.rrow'), 'rendered at 375 px');
      const html = app.el('fe_root').innerHTML;
      const widths = (html.match(/(?:min-)?width:\s*(\d+)px/g) || []).map((s) => parseInt(s.replace(/\D+/g, ''), 10));
      assert(widths.every((w) => w <= 340), 'fixed widths: ' + widths.join(','));
      assert(app.el('fe_root').querySelector('.cols-2'), 'collapsing grid');
    },
  },
];
