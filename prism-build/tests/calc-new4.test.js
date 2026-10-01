// New calculator #4 — H2S Exposure & Scavenger (route `h2sroe`, file
// prism-build/44-calc-h2sroe.js, Round-9 plug-in registry), driven through the
// real page: host nav → set inputs → click Calculate → read result rows.
//
// Expected values are NEW-CALCS-SPEC.md §4.3 (cases H1-H3, SO2a-c, S1-S3), which
// follow 16 TAC §3.36(c) (Texas Statewide Rule 36) for the radius of exposure,
// H2S → SO2 stoichiometry for flaring, and an H2S mass balance for scavenger
// dosing (379.48 scf/lb-mol, M(H2S) 34.081, M(SO2) 64.064).
'use strict';

const WP = 'NEW4';

function rows(app, resId) {
  return app.findAll('#' + resId + ' .rrow').map((r) => {
    const l = r.querySelector('.rl'), v = r.querySelector('.rv');
    return { l: String(l ? l.textContent : '').trim(), v: String(v ? v.textContent : '').trim() };
  });
}
function rv(app, resId, label, nth) {
  const r = rows(app, resId).find((x) => x.l === label);
  if (!r) throw new Error('no result row "' + label + '" in #' + resId + ': ' + JSON.stringify(rows(app, resId)));
  const nums = r.v.replace(/,/g, '').match(/-?\d+(\.\d+)?(e[-+]?\d+)?/gi);
  if (!nums || nums[nth || 0] == null) throw new Error('row "' + label + '" has no number #' + (nth || 0) + ': ' + r.v);
  return parseFloat(nums[nth || 0]);
}
function txt(app, id) { const e = app.el(id); return String(e ? e.textContent : '').trim(); }
function errText(app, resId) { return app.findAll('#' + resId + ' .val-error').map((e) => e.textContent).join(' | '); }
function noBadNumbers(assert, app, where) {
  const t = String(app.el('pgBody').textContent || '');
  assert.ok(!/NaN|Infinity|∞|undefined/.test(t), where + ': page shows NaN/Infinity/undefined');
}
function set(app, vals) {
  for (const k of Object.keys(vals)) {
    if (!app.el(k)) throw new Error('no input #' + k);
    app.input(k, String(vals[k]));
  }
}
function open(app) {
  const b = app.find('.nav-btn[data-p="h2sroe"]');
  if (!b) throw new Error('no h2sroe nav button');
  app.click(b);
  if (!app.el('hs_root')) throw new Error('h2sroe page did not render');
}
const calc = (app) => app.click('hs_calc');
const S = (app) => app.win.WTS_state.h2sroe;

module.exports = [
  {
    name: 'NEW4 compute: radius of exposure, SO2 and scavenger match the spec cases',
    wp: WP,
    run(app, assert) {
      const W = app.win;
      ['renderH2SSafety', 'calcH2S', 'WTS_h2s_roe', 'WTS_h2s_so2', 'WTS_h2s_scavenger', 'WTS_h2sroe_compute']
        .forEach((f) => assert.strictEqual(typeof W[f], 'function', f));
      const cases = [
        [W.WTS_h2s_roe(10, 10000), { mf: 0.01, x100_ft: 1798.3, x500_ft: 821.8, x100_m: 548.1, x500_m: 250.5, h2s_lbd: 8981.0, h2s_kgd: 4073.7 }],
        [W.WTS_h2s_roe(0.5, 100), { x100_ft: 15.46, x500_ft: 7.06, h2s_lbd: 4.490 }],
        [W.WTS_h2s_roe(25, 50000), { x100_ft: 8735.9, x500_ft: 3992.0, x100_m: 2662.7, x500_m: 1216.8, h2s_lbd: 112262 }],
        [W.WTS_h2s_so2(5, 10000, 98), { so2_lbhr: 344.68, so2_kghr: 156.34, so2_td: 3.752, h2s_lbhr: 3.742, h2s_kghr: 1.697 }],
        [W.WTS_h2s_so2(10, 1000, 99), { so2_lbhr: 69.64, so2_kghr: 31.59, so2_td: 0.7581, h2s_lbhr: 0.3742 }],
        [W.WTS_h2s_so2(25, 50000, 98), { so2_lbhr: 8616.9, so2_td: 93.81, h2s_lbhr: 93.55 }],
        [W.WTS_h2s_scavenger(5, 50, 4, 1.5), { lb_d: 20.656, kg_d: 9.3695, gr_in: 3.143, gr_out: 0.2515, gal_d: 30.98, L_d: 117.29, L_hr: 4.887 }],
        [W.WTS_h2s_scavenger(20, 300, 4, 1.2), { lb_d: 531.67, kg_d: 241.16, gr_in: 18.86, gr_out: 0.2515, gal_d: 638.0, L_d: 2415.1, L_hr: 100.63 }],
        [W.WTS_h2s_scavenger(1, 1000, 16, 2.0), { lb_d: 88.373, gr_out: 1.006, gal_d: 176.75, L_d: 669.05, L_hr: 27.88 }],
      ];
      cases.forEach(([r, exp], i) => {
        assert.ok(r.ok, 'case ' + i + ' ok');
        for (const k of Object.keys(exp)) assert.rel(r[k], exp[k], 1e-3, 'case ' + i + ' ' + k);
      });
      // SO2a is 10x Flare Emissions F1 (0.3752 t/d)
      assert.rel(W.WTS_h2s_so2(5, 1000, 98).so2_td, 0.3752, 1e-3, 'F1 consistency');
      // Validation returns errors, never NaN
      const bad = [W.WTS_h2s_roe(0, 100), W.WTS_h2s_roe(10001, 100), W.WTS_h2s_roe(10, 0), W.WTS_h2s_so2(5, 100, 49),
        W.WTS_h2s_so2(501, 100, 98), W.WTS_h2s_scavenger(5, 50, 50, 1.5), W.WTS_h2s_scavenger(5, 50, 4, 0.05), W.WTS_h2s_scavenger(5, 0, 0, 1)];
      bad.forEach((r, i) => { assert.strictEqual(r.ok, false, 'bad ' + i); assert.ok(r.errors.length > 0, 'bad ' + i + ' has errors'); });
      assert.ok(W.WTS_h2s_so2(5, 0, 98).ok, 'zero H2S in flared gas is allowed');
      const all = W.WTS_h2sroe_compute({ q: 10, ppm: 10000, fq: 5, fppm: 10000, fce: 98, sq: 5, sin: 50, sout: 4, ratio: 1.5 });
      assert.ok(all.ok && all.roe.ok && all.so2.ok && all.scav.ok, 'combined compute');
    },
  },
  {
    name: 'NEW4 page: registry nav in Test System Safety, defaults compute, cases H1-H3 / SO2 / S1-S3 through the DOM',
    wp: WP,
    run(app, assert) {
      const b = app.find('.nav-btn[data-p="h2sroe"]');
      assert.ok(b, 'sidebar button');
      const g = b.closest('.nav-group').querySelector('.nav-group-label');
      assert.strictEqual(String(g.textContent).trim(), 'Test System Safety');
      open(app);
      assert.strictEqual(txt(app, 'pgTitle'), 'H2S Exposure & Scavenger');
      assert.match(txt(app, 'pgSub'), /Radius of exposure for 100 and 500 ppm H2S/);
      // Defaults = H1, SO2a, S1
      assert.rel(S(app).x100_ft, 1798.3, 1e-3, 'default X100');
      assert.rel(S(app).so2_lbhr, 344.68, 1e-3, 'default SO2');
      assert.rel(S(app).scav_gal_d, 30.98, 1e-3, 'default product');
      assert.rel(rv(app, 'hs_roe_res', '100 ppm radius of exposure', 0), 1798.3, 1e-3, 'row ft');
      assert.rel(rv(app, 'hs_roe_res', '100 ppm radius of exposure', 1), 548.1, 1e-3, 'row m');
      assert.rel(rv(app, 'hs_roe_res', 'H2S release', 0), 8981, 1e-3, 'release row');
      assert.rel(rv(app, 'hs_roe_res', 'Escape rate', 0), 1e7, 1e-9, 'escape rate row');
      const roeTxt = txt(app, 'hs_roe_res');
      assert.includes(roeTxt, '⚠ 100 ppm radius of exposure is 1,798.3 ft');
      assert.includes(roeTxt, '⚠ 500 ppm radius of exposure is 821.8 ft');
      assert.ok(roeTxt.indexOf('exceeds 3,000 ft') === -1, 'no >3000 ft verdict for H1');
      // H2
      set(app, { hs_q: 0.5, hs_ppm: 100 }); calc(app);
      assert.rel(S(app).x100_ft, 15.46, 1e-3); assert.rel(S(app).x500_ft, 7.06, 1e-3);
      assert.includes(txt(app, 'hs_roe_res'), '✓ 100 ppm radius of exposure is under 50 ft.');
      // H3
      set(app, { hs_q: 25, hs_ppm: 50000 }); calc(app);
      assert.rel(S(app).x100_ft, 8735.9, 1e-3); assert.rel(S(app).x500_ft, 3992.0, 1e-3);
      assert.includes(txt(app, 'hs_roe_res'), '⚠ 100 ppm radius of exposure exceeds 3,000 ft.');
      // SO2b, SO2c
      set(app, { hs_fq: 10, hs_fppm: 1000, hs_fce: 99 }); app.click('hs_calc2');
      assert.rel(S(app).so2_lbhr, 69.64, 1e-3);
      assert.rel(rv(app, 'hs_so2_res', 'SO2 per day'), 0.7581, 1e-3);
      assert.rel(rv(app, 'hs_so2_res', 'Unburned H2S'), 0.3742, 1e-3);
      set(app, { hs_fq: 25, hs_fppm: 50000, hs_fce: 98 }); app.click('hs_calc2');
      assert.rel(rv(app, 'hs_so2_res', 'SO2', 0), 8616.9, 1e-3);
      assert.rel(rv(app, 'hs_so2_res', 'SO2 per day'), 93.81, 1e-3);
      // S2 ✓, S3 ⚠
      set(app, { hs_sq: 20, hs_sin: 300, hs_sout: 4, hs_ratio: 1.2 }); app.click('hs_calc3');
      assert.rel(rv(app, 'hs_scv_res', 'H2S removed', 0), 531.67, 1e-3);
      assert.rel(rv(app, 'hs_scv_res', 'Product', 0), 638.0, 1e-3);
      assert.rel(rv(app, 'hs_scv_res', 'Product', 1), 2415.1, 1e-3);
      assert.rel(rv(app, 'hs_scv_res', 'Injection rate', 0), 100.63, 1e-3);
      assert.rel(rv(app, 'hs_scv_res', 'Inlet H2S', 1), 18.86, 1e-3);
      assert.includes(txt(app, 'hs_scv_res'), '✓ Outlet target meets a 4 ppm (0.25 gr/100 scf) limit.');
      set(app, { hs_sq: 1, hs_sin: 1000, hs_sout: 16, hs_ratio: 2 }); app.click('hs_calc3');
      assert.rel(S(app).scav_gal_d, 176.75, 1e-3);
      assert.rel(rv(app, 'hs_scv_res', 'Outlet H2S', 1), 1.006, 1e-3);
      assert.includes(txt(app, 'hs_scv_res'), '⚠ Outlet target is above the common 4 ppm (0.25 gr/100 scf) sales-gas limit.');
      noBadNumbers(assert, app, 'cases');
    },
  },
  {
    name: 'NEW4 validation: one bad card shows a message, flags the input, never NaN, and does not block the others',
    wp: WP,
    run(app, assert) {
      open(app);
      set(app, { hs_q: 0 }); calc(app);
      assert.includes(errText(app, 'hs_roe_res'), 'Maximum escape rate must be above 0');
      assert.ok(app.el('hs_q').classList.contains('input-err'), 'hs_q flagged');
      assert.strictEqual(S(app).x100_ft, null);
      assert.rel(S(app).so2_lbhr, 344.68, 1e-3, 'SO2 card still computes');
      assert.rel(S(app).scav_gal_d, 30.98, 1e-3, 'scavenger card still computes');
      assert.ok(app.findAll('#hs_so2_res .rrow').length === 3 && app.findAll('#hs_scv_res .rrow').length === 5, 'other cards painted');
      set(app, { hs_q: '', hs_fce: 40, hs_sout: 60, hs_ratio: 12 }); calc(app);
      assert.includes(errText(app, 'hs_so2_res'), 'Combustion efficiency must be between 50 and 100');
      assert.includes(errText(app, 'hs_scv_res'), 'below the inlet H2S');
      assert.includes(errText(app, 'hs_scv_res'), 'between 0.1 and 10 US gal');
      ['hs_q', 'hs_fce', 'hs_sout', 'hs_ratio'].forEach((id) => assert.ok(app.el(id).classList.contains('input-err'), id + ' flagged'));
      assert.ok(!app.el('hs_sin').classList.contains('input-err'), 'valid input not flagged');
      noBadNumbers(assert, app, 'validation');
      set(app, { hs_q: 10, hs_fce: 98, hs_sout: 4, hs_ratio: 1.5 }); calc(app);
      assert.strictEqual(app.findAll('#hs_root .input-err').length, 0, 'flags cleared');
      assert.strictEqual(app.findAll('#hs_root .val-error').length, 0, 'errors cleared');
    },
  },
  {
    name: 'NEW4 Use AOF: warns without Gas Deliverability, copies aofCn/1000 into the escape rate (imperial and metric)',
    wp: WP,
    run(app, assert) {
      open(app);
      const W = app.win;
      if (W.WTS_state.gasdeliv) delete W.WTS_state.gasdeliv;
      app.click('hs_useaof');
      assert.includes(txt(app, 'hs_roe_res'), '⚠ Open Gas Deliverability & AOF and calculate first.');
      W.WTS_state.gasdeliv = { aofCn: 9033.5 };
      app.click('hs_useaof');
      assert.rel(parseFloat(app.el('hs_q').value), 9.0335, 1e-9, 'hs_q set');
      const ref = W.WTS_h2s_roe(9.0335, 10000);
      assert.rel(S(app).x100_ft, ref.x100_ft, 1e-9, 'X100 from AOF');
      assert.rel(S(app).x100_ft, 1687, 2e-3, '≈ 1,687 ft');
      // Metric: the canonical assignment is shown converted, the calc stays imperial
      const U = W.WTS_units;
      app.flush(10);
      U.setSystem('metric');
      try {
        W.WTS_state.gasdeliv = { aofCn: 12000 };
        app.click('hs_useaof');
        assert.rel(parseFloat(U.displayValue(app.el('hs_q'))), 12 * 28316.8 / 1000, 1e-4, 'shown in 10³ m³/d');
        assert.rel(S(app).x100_ft, W.WTS_h2s_roe(12, 10000).x100_ft, 1e-6, 'metric AOF → imperial calc');
      } finally { U.setSystem('imperial'); }
      assert.rel(parseFloat(app.el('hs_q').value), 12, 1e-6, 'back in MMSCFD');
    },
  },
  {
    name: 'NEW4 metric: tagged labels switch, state equals the imperial run, unit flip recalculates',
    wp: WP,
    run(app, assert) {
      open(app);
      const imp = Object.assign({}, S(app));
      const U = app.win.WTS_units;
      app.flush(10);
      U.setSystem('metric');
      try {
        open(app);
        const lab = app.el('hs_q').closest('.fg-item').querySelector('label');
        assert.match(String(lab.textContent), /Maximum escape rate \(10³ m³\/d\)/, 'gasRate label');
        const lab2 = app.el('hs_fce').closest('.fg-item').querySelector('label');
        assert.match(String(lab2.textContent), /\(%\)/, 'percent label');
        ['x100_ft', 'x500_ft', 'so2_lbhr', 'scav_gal_d'].forEach((k) => assert.rel(S(app)[k], imp[k], 1e-6, 'metric ' + k));
        assert.rel(parseFloat(U.displayValue(app.el('hs_q'))), 283.168, 1e-3, '10 MMSCFD shown as 10³ m³/d (display rounding)');
        app.input('hs_q', '141.584'); calc(app);       // = 5 MMSCFD
        assert.rel(S(app).x100_ft, app.win.WTS_h2s_roe(5, 10000).x100_ft, 1e-6, 'metric entry converted');
        set(app, { hs_q: 0 }); calc(app);
        assert.includes(errText(app, 'hs_roe_res'), '10³ m³/d', 'limit shown in display units');
        set(app, { hs_q: 283.168 }); calc(app);
      } finally { U.setSystem('imperial'); }
      assert.rel(S(app).x100_ft, imp.x100_ft, 1e-6, 'recalc after flip keeps the physical value');
      assert.match(String(app.el('hs_q').closest('.fg-item').querySelector('label').textContent), /\(MMSCFD\)/);
    },
  },
  {
    name: 'NEW4 report + persistence: page report sections, PDF, Quick Report, autosave restore after reload, no timers',
    wp: WP,
    run(app, assert) {
      open(app);
      set(app, { hs_q: 25, hs_ppm: 50000 }); calc(app);
      const model = app.win.collectPageReport(app.el('pgBody'), { charts: false });
      const s = JSON.stringify(model);
      assert.ok(model.inputs.length >= 3, 'three input sections: ' + model.inputs.map((x) => x.title).join(' | '));
      const rt = model.results.map((x) => x.title);
      ['Radius of Exposure', 'SO2 Generation', 'Scavenger Requirement'].forEach((t) => assert.ok(rt.indexOf(t) !== -1, 'results section ' + t + ': ' + rt.join(' | ')));
      const roeSec = model.results.find((x) => x.title === 'Radius of Exposure');
      assert.ok(roeSec.items.some((i) => i.verdict && /exceeds 3,000 ft/.test(i.text)), 'verdict captured in results');
      assert.ok(roeSec.items.some((i) => i.type === 'note' && i.title === 'Notes'), 'notes captured');
      ['Maximum escape rate', 'Product consumption per H2S removed (US gal/lb)', '8,735.9'].forEach((n) => assert.includes(s, n));
      const n0 = app.opened.length;
      app.win.exportPagePDF();
      const pdf = app.opened[n0] && app.opened[n0].html();
      assert.ok(pdf && pdf.indexOf('H2S Exposure') !== -1 && pdf.indexOf('Scavenger Requirement') !== -1 && pdf.indexOf('exceeds 3,000 ft') !== -1, 'PDF has title, sections, verdict');
      app.flush(1200);
      const rec = JSON.parse(app.storage.getItem('wts_page_h2sroe') || 'null');
      assert.ok(rec && rec.f && rec.f.hs_q === '25' && rec.f.hs_ppm === '50000', 'autosaved: ' + JSON.stringify(rec));
      const n1 = app.opened.length;
      app.win.WTS_exportJobReport();
      const job = app.opened[n1] && app.opened[n1].html();
      assert.ok(job && job.indexOf('H2S Exposure') !== -1 && job.indexOf('8,735.9') !== -1, 'Quick Report includes the page');
      app.flushUntilIdle(10000);
      assert.strictEqual(app.pendingTimers(), 0, 'no timers left');
      const app2 = app.reload();
      try {
        open(app2);
        assert.strictEqual(app2.el('hs_q').value, '25', 'restored');
        assert.rel(app2.win.WTS_state.h2sroe.x100_ft, 8735.9, 1e-3, 'recalculated on restore');
        app2.flushUntilIdle(10000);
        assert.strictEqual(app2.pendingTimers(), 0, 'no timers after reload');
      } finally { app2.dispose(); }
    },
  },
  {
    name: 'NEW4 phone: renders at 375 px with every result card and tile on the dashboard',
    wp: WP,
    opts: { viewport: { width: 375, height: 812 } },
    run(app, assert) {
      const b = app.find('.nav-btn[data-p="h2sroe"]');
      assert.ok(b && b.closest('#sidebar'), 'button in the mobile sidebar');
      open(app);
      ['hs_roe_res', 'hs_so2_res', 'hs_scv_res'].forEach((id) => assert.ok(app.el(id).querySelector('.rrow'), id + ' rendered'));
      assert.ok(!/width:\s*[4-9]\d\dpx|width:\s*\d{4,}px/.test(app.el('pgBody').innerHTML), 'no fixed widths above 340 px');
      app.hook.nav('home');
      const titles = app.findAll('.dash-card').map((c) => String(c.querySelector('h3').textContent).trim());
      assert.ok(titles.indexOf('H2S Exposure & Scavenger') !== -1, 'dashboard tile');
    },
  },
];
