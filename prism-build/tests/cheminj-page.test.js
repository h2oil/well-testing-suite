// Chemical Injection (v3.2a) — page tests for prism-build/49-calc-cheminj.js (route `cheminj`,
// ids cj_*), docs/CHEMICAL-INJECTION-PLAN.md §2 and §7.3 (UI 1–10):
//   render + one calc on open, H1 defaults with no NaN/undefined, chip, both charts, Design basis,
//   six Notes boxes; dropdown presets (chemical / pump, data-prev, point never changed); line-count
//   select; Metric mode (labels, values, preset written canonically, flip back); report capture;
//   silent restore (exactly one calc, show/hide state); sidebar position (8th row of Test System
//   Safety, after Hydrate Management); Quick Report entries; Hydrate-page banner and Chemical &
//   Dosage cross-link; calibration card; validation messages.
// Expected numbers are the plan's worked example H1 (§4.13); the engine itself is covered by
// cheminj-engine.test.js and cheminj-foundation.test.js.
'use strict';

const WP = 'CHEM';
const BAD = /NaN|undefined|Infinity|\bnull\b|\[object Object\]/;
const txt = (e) => String(e && e.textContent || '').replace(/\s+/g, ' ').trim();

function open(app) { app.hook.nav('cheminj'); app.flush(20); return app.el('cj_root'); }
function calcs(app) { return app.win.WTS_cheminj.pageCalcs(); }
function rows(app, boxId) {
  return app.findAll('#' + boxId + ' .rrow').map((r) => ({ l: txt(r.querySelector('.rl')), v: txt(r.querySelector('.rv')) }));
}
function row(app, boxId, label) {
  const r = rows(app, boxId).find((x) => x.l.indexOf(label) === 0);
  if (!r) throw new Error('no row "' + label + '" in #' + boxId + ': ' + rows(app, boxId).map((x) => x.l).join(' | '));
  return r.v;
}
const num = (s) => parseFloat(String(s).replace(/,/g, ''));
const shown = (app, id) => {
  for (let e = app.el(id); e; e = e.parentElement) if (e.style && e.style.display === 'none') return false;
  return true;
};
const verdicts = (app, sel) => app.findAll(sel + ' .cj-v').map(txt);
const S = (app) => app.win.WTS_state.cheminj;

module.exports = [
  {
    name: 'CHEM page: registry entry, opens with one calc, H1 defaults (159.95 gal/d, air 45.6 psig, rating 3,905 psig), chip, Design basis, node table, both charts, six Notes, no NaN',
    wp: WP,
    run(app, assert) {
      const e = app.win.WTS_calcRegistry.cheminj;
      assert.ok(e && e.key === 'cheminj' && e.group === 'Test System Safety' && e.hooks && e.hooks.silent === true, 'registry entry');
      assert.strictEqual(e.title, 'Chemical Injection');
      const n0 = calcs(app);
      open(app);
      assert.strictEqual(calcs(app) - n0, 1, 'exactly one calc when the page opens');
      assert.strictEqual(txt(app.el('pgTitle')), 'Chemical Injection');
      assert.match(txt(app.el('pgSub')), /pump settings/);
      assert.strictEqual(app.el('cj_res').getAttribute('data-done'), '1');
      assert.ok(!BAD.test(txt(app.el('pgBody'))), 'no NaN / undefined / Infinity / null on the page');
      // H1 headline numbers
      const st = S(app);
      assert.ok(st && st.ok, 'WTS_state.cheminj published');
      assert.near(st.lines[0].gal_d, 159.95, 0.8, 'methanol gal/d');
      assert.near(st.hydrate.XR, 38.14, 0.05, 'rich wt %');
      assert.strictEqual(st.hydrate.controlNode, 'ck');
      assert.match(row(app, 'cj_rb_line_1', 'Chemical rate'), /^159\.9\d gal\/d · 605\.\d L\/d · 25\.2\d L\/h · 420\.\d mL\/min$/);
      assert.match(row(app, 'cj_rb_line_1', 'Air pressure setting'), /^45\.6 psig · 63\.9 psig$/);
      assert.match(row(app, 'cj_rb_line_1', 'Flow at the required pressure'), /^464\.4 gal\/d at 3,550 psig$/);
      assert.strictEqual(row(app, 'cj_rb_line_1', 'Minimum discharge-circuit rating'), '3,905 psig');
      assert.match(row(app, 'cj_rb_line_1', 'Blocked-in pressure rise'), /^77 psi per °F/);
      assert.strictEqual(row(app, 'cj_rb_line_1', 'Calibration cylinder'), '2,000 mL');
      assert.strictEqual(row(app, 'cj_rb_line_1', 'Totes on site'), '4 · 3');
      // chip (rp-skip, outside the card title)
      const chip = app.el('cj_chip_1');
      assert.match(txt(chip), /^Methanol · Upstream of choke · 1(59\.9|60\.0) gal\/d · air 45\.6 psig$/);
      assert.ok(chip.classList.contains('rp-skip') && !chip.closest('.card-title'), 'chip is rp-skip, not in the card title');
      // design basis + spread
      assert.strictEqual(row(app, 'cj_rb_basis', 'Hydrate design margin'), '10 °F');
      assert.match(row(app, 'cj_rb_basis', 'Choke outlet temperature'), /× 1\.10/);
      assert.strictEqual(txt(app.find('#cj_rb_spread .rbox-title')), 'Spread hydrate check (margin 10 °F, J-T × 1.10)');
      const nodeRows = app.findAll('#cj_rb_spread table tbody tr').map((tr) => Array.from(tr.querySelectorAll('td')).map(txt));
      const ck = nodeRows.find((r) => r[0] === 'Downstream of choke'), fh = nodeRows.find((r) => r[0] === 'Flowhead (flowing)');
      assert.ok(ck && /✗/.test(ck[5]) && /^34\.6/.test(ck[2]), 'choke outlet at risk, 34.6 °F: ' + (ck || []).join(' | '));
      assert.ok(fh && /✓/.test(fh[5]), 'flowhead no risk');
      assert.match(row(app, 'cj_rb_spread', 'Required depression'), /^38\.57 °F$/);
      // verdicts: headline first, then the planning disclaimer
      const top = Array.from(app.el('cj_res').children).filter((c) => c.classList.contains('cj-v')).map(txt);
      assert.match(top[0], /^⚠ Line 1: Methanol upstream of choke/);
      assert.match(top[1], /^⚠ Planning estimate\./);
      assert.ok(top.every((t) => t.length < 300), 'verdicts under 300 characters');
      // charts drawn once, with data
      assert.ok(app.canvasLog('cj_chart_hyd', 'lineTo').length > 40, 'hydrate chart drawn');
      assert.ok(app.canvasLog('cj_chart_pump', 'lineTo').length > 10, 'pump chart drawn');
      assert.ok(app.canvasTexts('cj_chart_hyd').some((t) => /Temperature \(°F\)/.test(t)), 'hydrate chart axis label');
      // six flat Notes boxes ≤ 600 characters
      const notes = app.findAll('#cj_notes_res .cj-note');
      assert.strictEqual(notes.length, 6);
      notes.forEach((n) => { assert.strictEqual(txt(n.firstElementChild), 'Notes'); assert.ok(txt(n).length <= 600, txt(n).length + ' chars'); });
      assert.includes(txt(notes[0]), 'J-T cooling × 1.10');
      assert.strictEqual(app.pendingTimers() >= 0, true);
    },
  },
  {
    name: 'CHEM page dropdowns: chemical presets its property fields once (data-prev) and never moves the point; pump type shows its own fields and presets them; every change recalculates',
    wp: WP,
    run(app, assert) {
      open(app);
      let n = calcs(app);
      app.select('cj_chem_1', 'meg');
      assert.strictEqual(calcs(app), n + 1, 'chemical change recalculates');
      assert.strictEqual(app.el('cj_pt_1').value, 'wh', 'point unchanged');
      assert.strictEqual(app.el('cj_lean_1').value, '80', 'MEG lean 80 wt %');
      assert.strictEqual(app.el('cj_sgc_1').value, '1.116', 'MEG SG');
      assert.strictEqual(app.el('cj_basis_1').value, 'wt_water');
      assert.strictEqual(app.el('cj_chem_1').getAttribute('data-prev'), 'meg');
      assert.match(txt(app.el('cj_chip_1')), /^MEG · Upstream of choke · 2\d\d\.\d gal\/d/);
      // a user edit is kept: an unrelated change does not re-preset
      app.input('cj_lean_1', '90');
      app.select('cj_pt_1', 'dsch');
      assert.strictEqual(app.el('cj_lean_1').value, '90', 'user lean kept');
      assert.ok(verdicts(app, '#cj_rb_line_1').some((v) => /choke body and bean are not protected/.test(v)), 'downstream-of-choke ⚠');
      // a ppm chemical: dose basis and dose from the library, lean hidden
      app.select('cj_pt_1', 'wh');
      app.select('cj_chem_1', 'ci_film_liq');
      assert.strictEqual(app.el('cj_basis_1').value, 'ppmv_liq');
      assert.strictEqual(app.el('cj_dose_1').value, '25');
      assert.ok(!shown(app, 'cj_lean_1'), 'lean hidden for a ppm chemical');
      assert.match(txt(app.el('cj_dose_1').closest('.fg-item').querySelector('label')), /^Dose \(ppm v\)$/);
      // pump kinds: plunger fields, metering fields, air-driven fields
      app.select('cj_chem_1', 'meoh');
      assert.ok(shown(app, 'cj_q0_1') && !shown(app, 'cj_plg_1') && !shown(app, 'cj_qrated_1'), 'air-driven fields only');
      n = calcs(app);
      app.select('cj_pump_1', 'pneu_plunger');
      assert.strictEqual(calcs(app), n + 1);
      assert.ok(shown(app, 'cj_plg_1') && shown(app, 'cj_stk_1') && shown(app, 'cj_heads_1') && !shown(app, 'cj_q0_1'), 'plunger fields');
      assert.strictEqual(app.el('cj_plg_1').value, '0.5', 'pneumatic preset plunger 1/2 in');
      assert.ok(verdicts(app, '#cj_rb_line_1').some((v) => /^✗ /.test(v)), 'no pneumatic option can do H1 (✗)');
      app.select('cj_pump_1', 'elec_hyd_diaph');
      assert.ok(shown(app, 'cj_qrated_1') && shown(app, 'cj_pmax_1') && !shown(app, 'cj_plg_1'), 'metering fields');
      assert.strictEqual(app.el('cj_qrated_1').value, '5');
      assert.strictEqual(app.el('cj_pmax_1').value, '3000');
      app.select('cj_pump_1', 'elec_plunger');
      assert.ok(verdicts(app, '#cj_rb_line_1').some((v) => /certified for the zone/.test(v)), 'electric pump in a classified area ⚠');
      assert.match(row(app, 'cj_rb_line_1', 'Setting'), /^39\.5 % stroke at 120 SPM$/);
      // advanced toggle and design-basis toggle
      assert.ok(!shown(app, 'cj_ve_1'));
      app.check('cj_adv_1', true);
      assert.ok(shown(app, 'cj_ve_1') && shown(app, 'cj_rod_1') && !shown(app, 'cj_actd_1'), 'advanced: electric plunger fields');
      app.check('cj_adv_basis', true);
      assert.ok(shown(app, 'cj_fc'), 'advanced design basis shown');
      // choke temperature from the user, heater off
      app.select('cj_jt', 'user');
      assert.ok(shown(app, 'cj_tck'));
      app.select('cj_htr', 'no');
      assert.ok(!shown(app, 'cj_thtr'));
      assert.ok(!BAD.test(txt(app.el('pgBody'))));
    },
  },
  {
    name: 'CHEM page line count: six lines show six cards, six result boxes and six summary rows; back to one hides lines 2–6 as whole cards and drops them from the report',
    wp: WP,
    run(app, assert) {
      open(app);
      app.select('cj_nlines', '6');
      for (let n = 1; n <= 6; n++) assert.ok(shown(app, 'cj_line_' + n), 'line card ' + n);
      assert.strictEqual(app.findAll('#cj_res .rbox[id^="cj_rb_line_"]').length, 6);
      assert.strictEqual(app.findAll('#cj_rb_summary tbody tr').length, 6);
      assert.ok(txt(app.el('cj_chip_5')).length > 0, 'chip on line 5');
      assert.ok(!BAD.test(txt(app.el('pgBody'))));
      app.select('cj_chart_line', '4');
      assert.match(txt(app.el('cj_chart_pump_t')), /line 4: Solenoid metering pump/);
      app.select('cj_nlines', '1');
      for (let n = 2; n <= 6; n++) assert.ok(!shown(app, 'cj_line_' + n), 'line ' + n + ' hidden');
      assert.strictEqual(txt(app.el('cj_chip_3')), '');
      assert.match(txt(app.el('cj_chart_pump_t')), /line 1 \(line 4 is not in use\)/);
      const m = app.win.collectPageReport(app.el('pgBody'), { charts: false });
      const titles = m.inputs.concat(m.results).map((s) => s.title);
      assert.ok(titles.indexOf('Injection line 1') !== -1 && !titles.some((t) => /Injection line [2-6]|^Line [2-6] —/.test(t)), titles.join(' | '));
    },
  },
  {
    name: 'CHEM page Metric: labels and results in SI, no imperial unit in labels / rows / tables, preset written canonically (q0 113.6 L/h), flip back gives the same numbers',
    wp: WP,
    run(app, assert) {
      open(app);
      const imp = S(app).lines[0].gal_d;
      const U = app.win.WTS_units;
      U.setSystem('metric');
      try {
        app.flush(20);
        const lab = (id) => txt(app.el(id).closest('.fg-item').querySelector('label'));
        assert.match(lab('cj_sithp'), /\(kPa\(g\)\)$/);
        assert.match(lab('cj_fwht'), /\(°C\)$/);
        assert.match(lab('cj_margin'), /\(°C\)$/);
        assert.match(lab('cj_q0_1'), /\(L\/h\)$/);
        assert.match(lab('cj_tank_1'), /\(L\)$/);
        assert.match(lab('cj_vcyc_1'), /\(mL\)$/);
        assert.strictEqual(U.displayValue(app.el('cj_tank_1')), '1041');
        assert.rel(S(app).lines[0].gal_d, imp, 1e-6, 'same answer in Metric');
        assert.match(txt(app.el('cj_chip_1')), /605\.5 L\/d · air 315 kPa\(g\)$/);
        assert.match(row(app, 'cj_rb_line_1', 'Chemical rate'), /^605\.5 L\/d · 25\.23 L\/h · 420\.5 mL\/min$/);
        assert.match(txt(app.find('#cj_rb_spread .rbox-title')), /margin 5\.6 °C, J-T × 1\.10/);
        assert.match(row(app, 'cj_rb_line_1', 'Totes on site'), /^4 · 3$/);
        assert.ok(rows(app, 'cj_rb_line_1').some((r) => /1,041 L totes/.test(r.l)), 'tote size in litres');
        const RX = /(^|[\s(\/\[·,])(psi[ag]?|°F|ft|bbl\/d|bbl|BPD|lbm?|gal|gpm|MMSCF\/d|scf)(?=$|[\s)\/\]·,.:;])/;
        const hits = app.findAll('#pgBody .rrow, #pgBody .rbox-title, #pgBody table.dtable th, #pgBody table.dtable td, #pgBody .card-title, #pgBody label')
          .filter((e) => { for (let p = e; p; p = p.parentElement) if (p.style && p.style.display === 'none') return false; return true; })
          .map(txt).filter((t) => RX.test(t));
        assert.deepStrictEqual(hits, [], 'imperial units in Metric');
        // pump change in Metric: preset written canonically
        app.select('cj_pump_1', 'elec_hyd_diaph');
        assert.strictEqual(U.displayValue(app.el('cj_qrated_1')), '18.9271', '5 gal/h shown in L/h');
        app.select('cj_pump_1', 'air_liquid');
        assert.strictEqual(U.displayValue(app.el('cj_q0_1')), '113.6', '30 gal/h shown as 113.6 L/h');
        assert.near(S(app).result.lines[0].pump.airDesign, 45.64, 0.05, 'air setting unchanged by the round trip');
      } finally { U.setSystem('imperial'); }
      app.flush(20);
      assert.rel(S(app).lines[0].gal_d, imp, 1e-6, 'flip back');
      assert.strictEqual(app.el('cj_q0_1').value, '30');
      assert.strictEqual(app.el('cj_tank_1').value, '275');
    },
  },
  {
    name: 'CHEM page report: results carry the headline, disclaimer, Design basis, node table, line rows and verdicts and six Notes; no chip, toggle or hidden line; snapshot and PDF',
    wp: WP,
    run(app, assert) {
      open(app);
      app.input('cj_days', '7');
      const m = app.win.collectPageReport(app.el('pgBody'), { charts: false });
      const res = m.results, titles = res.map((s) => s.title);
      ['Design basis', 'Spread hydrate check (margin 10 °F, J-T × 1.10)', 'Line 1 — Methanol · Upstream of choke', 'Summary', 'Notes and assumptions']
        .forEach((t) => assert.ok(titles.indexOf(t) !== -1, t + ' in ' + titles.join(' | ')));
      const all = JSON.stringify(m);
      assert.includes(all, 'Planning estimate. Confirm doses');
      const notes = res.find((s) => s.title === 'Notes and assumptions').items.filter((i) => i.type === 'note' && i.title === 'Notes');
      assert.strictEqual(notes.length, 6, 'six Notes boxes captured');
      const spread = res.find((s) => /^Spread hydrate check/.test(s.title));
      assert.ok(spread.items.some((i) => i.type === 'table' && i.rows.some((r) => r[0].t === 'Downstream of choke')), 'node table captured');
      const line = res.find((s) => /^Line 1 —/.test(s.title));
      assert.ok(line.items.some((i) => i.type === 'kv' && i.label === 'Air pressure setting at the shut-in design pressure: design · peak'), 'line rows');
      assert.ok(line.items.some((i) => i.type === 'kv' && i.label === 'Operating air setting while flowing (3,050 psig): design · peak'), 'operating air row');
      assert.ok(line.items.some((i) => i.type === 'note' && i.verdict && /drawdown cylinder/.test(i.text)), 'line verdicts');
      assert.ok(!/Methanol · Upstream of choke · 1/.test(titles.join('|')), 'chip text in no section title');
      assert.ok(!/Advanced settings|Advanced design basis|Pump chart for line|Jump to/.test(all), 'toggles, chart selector and jump bar are not captured');
      assert.ok(m.inputs.some((s) => s.title === 'Design basis' && s.items.some((i) => i.label === 'Test duration (d)' && i.value === '7')), 'inputs captured');
      // key result in the job-report summary = the headline verdict
      const first = res[0].items.find((i) => i.type === 'note' && i.verdict);
      assert.match(first.text, /^⚠ Line 1: Methanol upstream of choke/);
      app.flush(1200);
      const snaps = JSON.parse(app.storage.getItem('wts_report_snapshots') || '{}');
      assert.ok(snaps.cheminj && snaps.cheminj.title === 'Chemical Injection', 'Quick Report snapshot');
      const k = app.opened.length;
      app.win.exportPagePDF();
      const pdf = app.opened[k] && app.opened[k].html();
      assert.ok(pdf && pdf.indexOf('Chemical Injection') !== -1 && pdf.indexOf('Spread hydrate check') !== -1, 'PDF export');
    },
  },
  {
    name: 'CHEM page restore: saved values come back with exactly one calc, the show/hide state follows them, and the user values are kept',
    wp: WP,
    run(app, assert) {
      open(app);
      app.select('cj_nlines', '2');
      app.select('cj_chem_2', 'meg');
      app.select('cj_pump_2', 'elec_hyd_diaph');
      app.input('cj_lean_2', '75');
      app.check('cj_adv_1', true);
      app.input('cj_qw', '5');
      app.flush(1200);
      const rec = JSON.parse(app.storage.getItem('wts_page_cheminj') || 'null');
      assert.ok(rec && rec.f && rec.f.cj_chem_2 === 'meg' && rec.f.cj_lean_2 === '75' && rec.f.cj_adv_1 === true, 'autosaved');
      const gal = S(app).lines[1].gal_d;
      app.flushUntilIdle(10000);
      const app2 = app.reload();
      try {
        const n0 = app2.win.WTS_cheminj.pageCalcs();
        app2.hook.nav('cheminj'); app2.flush(20);
        assert.strictEqual(app2.win.WTS_cheminj.pageCalcs() - n0, 1, 'one calc on restore');
        assert.strictEqual(app2.el('cj_chem_2').value, 'meg');
        assert.strictEqual(app2.el('cj_lean_2').value, '75', 'user lean kept (no preset on restore)');
        assert.strictEqual(app2.el('cj_chem_2').getAttribute('data-prev'), 'meg', 'data-prev re-synced');
        assert.ok(shown(app2, 'cj_line_2') && shown(app2, 'cj_qrated_2') && !shown(app2, 'cj_plg_2'), 'line 2 shown with its metering fields');
        assert.ok(shown(app2, 'cj_q0_1') && shown(app2, 'cj_advbox_1'), 'line 1: air-driven fields and the advanced box');
        assert.rel(app2.win.WTS_state.cheminj.lines[1].gal_d, gal, 1e-9, 'same result after reload');
        app2.flushUntilIdle(10000);
        assert.strictEqual(app2.pendingTimers(), 0, 'no timers left');
      } finally { app2.dispose(); }
    },
  },
  {
    name: 'CHEM page sidebar + Quick Report: 8th row of Test System Safety right after Hydrate Management; final report ends its safety checks with it; daily report has a Chemical injection section',
    wp: WP,
    run(app, assert) {
      const g = app.findAll('#sidebar .nav-group').find((x) => txt(x.querySelector('.nav-group-label')) === 'Test System Safety');
      const rws = Array.from(g.querySelectorAll('.nav-btn')).filter((b) => !b.classList.contains('nav-hub-member'))
        .map((b) => b.getAttribute('data-p') || 'hub:' + b.getAttribute('data-hub'));
      assert.deepStrictEqual(rws, ['hub:esd', 'hydrate', 'cheminj', 'liquidline', 'pipelife', 'h2sroe', 'wellkill', 'complfluids']);
      assert.strictEqual(rws.length, 8, '8 rows (the sidebar limit)');
      const b = app.find('#sidebar .nav-btn[data-p="cheminj"]');
      assert.match(txt(b), /Chemical Injection/);
      app.click(b);
      assert.strictEqual(app.hook.page(), 'cheminj');
      const T = app.win.WTS_reportTemplates;
      const fin = T.get('final').sections.find((s) => s.heading === 'Safety checks');
      assert.strictEqual(fin.pages[fin.pages.length - 1], 'cheminj', 'appended at the end of Safety checks');
      assert.deepStrictEqual(Array.from(fin.pages).slice(0, 6), ['esdhi', 'esdlo', 'hydrate', 'liquidline', 'pipelife', 'h2sroe']);
      const daily = T.get('daily').sections.find((s) => s.heading === 'Chemical injection');
      assert.ok(daily && daily.type === 'pages' && daily.pages[0] === 'cheminj' && daily.detail === 'results', 'daily section');
      // captured page appears in the final report
      app.input('cj_qw', '3');
      app.flush(1200);
      const k = app.opened.length;
      app.win.WTS_reportTemplates.generate('final');
      const html = app.opened[k] && app.opened[k].html();
      assert.ok(html && html.indexOf('Safety checks') !== -1 && html.lastIndexOf('Chemical Injection') > html.indexOf('Safety checks'), 'final report carries the page');
      assert.ok(/Not captured yet: ESD Hi-Pilot, ESD Lo-Pilot, Hydrate Management/.test(html), 'existing missing-page note unchanged');
    },
  },
  {
    name: 'CHEM page links: Hydrate Management shows the rp-skip screening banner (numbers unchanged, not in its report) and Chemical & Dosage links to Chemical Injection',
    wp: WP,
    run(app, assert) {
      app.hook.nav('hydrate'); app.flush(20);
      const ban = app.el('wts_hydrate_cjlink');
      assert.ok(ban && ban.classList.contains('rp-skip'), 'banner, rp-skip');
      assert.includes(txt(ban), 'Screening estimate: free water only, +30 % methanol vapour allowance, 5 °F default margin.');
      const m = app.win.collectPageReport(app.el('pgBody'), { charts: false });
      assert.ok(JSON.stringify(m).indexOf('Screening estimate') === -1, 'banner not in the report');
      assert.ok(app.findAll('#wts_hydrate_summary table tr').length > 1, 'hydrate summary still computed');
      app.click('wts_hydrate_gocj');
      assert.strictEqual(app.hook.page(), 'cheminj', 'banner opens Chemical Injection');
      app.hook.nav('chem'); app.flush(20);
      const ln = app.el('ch_cjlink');
      assert.ok(ln && ln.classList.contains('rp-skip'));
      assert.includes(txt(ln), 'Injection point, pump stroke and hydrate / H2S dosing');
      app.click(ln.querySelector('button'));
      assert.strictEqual(app.hook.page(), 'cheminj', 'cross-link opens Chemical Injection');
    },
  },
  {
    name: 'CHEM page calibration and validation: drawdown check on the air-driven line (air field), SPM on a plunger line; blank or out-of-range inputs list labelled errors and mark the field',
    wp: WP,
    run(app, assert) {
      open(app);
      assert.ok(shown(app, 'cj_cal_air') && !shown(app, 'cj_cal_set'), 'air pressure field for the air-driven line');
      app.input('cj_cal_ml', '380');
      app.input('cj_cal_s', '60');
      app.input('cj_cal_air', '45.6');
      assert.match(txt(app.find('#cj_rb_cal .rbox-title')), /^Field calibration check, line 1$/);
      assert.match(row(app, 'cj_rb_cal', 'Measured rate'), /^144\.5\d gal\/d \(380\.0 mL\/min\)$/);
      // Re-fitted at the flowing discharge pressure FWHP + allowance = 3,050 psig (not the 3,550 psig shut-in case):
      // Q₀ = 144.57 / (1 − 3050/4560) = 436.6 gal/d → air = 3050 / (100·(1 − 159.95/436.6)) = 48.1 psig.
      assert.ok(shown(app, 'cj_cal_pd'), 'test discharge-pressure field for the air-driven line');
      assert.strictEqual(row(app, 'cj_rb_cal', 'Discharge pressure during the test'), '3,050 psig (flowing line pressure + allowance)');
      assert.match(row(app, 'cj_rb_cal', 'Free flow re-fitted to the test'), /^436\.\d\d gal\/d$/);
      assert.match(row(app, 'cj_rb_cal', 'Corrected setting'), /^air 48\.1 psig$/);
      assert.ok(verdicts(app, '#cj_rb_cal').some((v) => /^⚠ Calibration reads -9\.6 % from target: reset to air 48\.1 psig/.test(v)), verdicts(app, '#cj_rb_cal').join(' | '));
      // A test taken with the line at the shut-in pressure: enter it.
      app.input('cj_cal_pd', '3550');
      assert.strictEqual(row(app, 'cj_rb_cal', 'Discharge pressure during the test'), '3,550 psig (entered)');
      assert.match(row(app, 'cj_rb_cal', 'Corrected setting'), /^air 4[67](\.\d)? psig$/);
      app.input('cj_cal_pd', '');
      // plunger line: SPM setting field; a half-filled entry is a note in the box, never a page error
      app.select('cj_pump_1', 'pneu_plunger');
      assert.ok(shown(app, 'cj_cal_set') && !shown(app, 'cj_cal_air'));
      assert.match(txt(app.el('cj_cal_set').closest('.fg-item').querySelector('label')), /\(SPM\)$/);
      assert.ok(S(app).ok && !app.find('#cj_res .val-error'), 'results still shown');
      assert.ok(verdicts(app, '#cj_rb_cal').some((v) => /^⚠ Enter the measured volume, the time and the pump setting/.test(v)), 'incomplete-entry note');
      app.input('cj_cal_set', '160');   // 380 mL in 60 s against 160 × 3.218 mL swept → ηv 0.738
      assert.match(row(app, 'cj_rb_cal', 'Measured volumetric efficiency'), /^0\.\d{3}$/);
      assert.match(row(app, 'cj_rb_cal', 'Corrected setting'), /^\d+\.\d\d SPM$/);
      app.input('cj_cal_ml', '');
      assert.ok(!app.el('cj_rb_cal'), 'no calibration box without a measurement');
      // validation
      app.input('cj_sg', '');
      const err = txt(app.find('#cj_res .val-error'));
      assert.includes(err, 'Enter a value for gas gravity');
      assert.ok(app.el('cj_sg').classList.contains('input-err'), 'field marked');
      assert.ok(!shown(app, 'cj_charts'), 'charts hidden while the inputs are invalid');
      app.input('cj_sg', '0.65');
      app.input('cj_qg', '900');
      assert.includes(txt(app.find('#cj_res .val-error')), 'Gas rate must be between 0 and 500 MMSCFD');
      app.input('cj_qg', '10');
      assert.strictEqual(app.findAll('#cj_root .input-err').length, 0, 'cleared');
      assert.ok(S(app).ok && shown(app, 'cj_charts'));
    },
  },
];
