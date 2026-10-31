// Chemical Injection (v3.2a) — regression tests for the review findings on
// prism-build/49-calc-cheminj.js (and the Hydrate-page banner in 25-hydrate.js):
//   R1  liquids in the choke: ⚠ with the plan §4.1.5 mixture estimate, Notes say "gas only"
//   R2  air-driven calibration re-fitted at the discharge pressure during the test; operating air while flowing
//   R3  separator water basis capped at the flowhead water content
//   R4  total-liquid ppm on the phases present at the point
//   R5  blank MAWP = the pump's pressure rating (body rating for pneumatic / air-driven pumps)
//   R6  Metric verdict text (engine strings, pump-options verdict cell, J-T rule rows, Hydrate banner)
//   R7  sour-gas water-content ⚠
//   R9  refused sour correlation: no node status, no shut-in / start-up wt %, margin never falls
//   R10 a THI line protects a node only with the design dose and a pump that can deliver it
//   R11 drive-gas verdicts on every pneumatic / air-driven line, whatever the rate
//   R12 air-operated diaphragm pump ignores a left-over pressure ratio
//   R13 a refused / no-rate line says so instead of "no flow required"
//   R14 the next-plunger suggestion is itself feasible
//   R15 low-rate and pressure advice match the case
'use strict';

const WP = 'CHEM';
const codes = (vs) => Array.from(vs || []).map((v) => v.code);
const txt = (e) => String(e && e.textContent || '').replace(/\s+/g, ' ').trim();
const BAD = /NaN|undefined|Infinity|\bnull\b|\[object Object\]/;
const IMP = /(^|[\s(\/\[·,])(psi[ag]?|°F|ft|bbl\/d|bbl|BPD|lbm?|gal|gpm|MMSCF\/d|scf)(?=$|[\s)\/\]·,.:;])/;

function C(app) { return app.win.WTS_cheminj; }
function compute(app, inp, opts) {
  const r = app.win.WTS_cheminj_compute(inp || {}, opts);
  if (!r || !r.ok) throw new Error('compute failed: ' + (r && r.errors ? r.errors.join(' | ') : 'no result'));
  return r;
}
function open(app) { app.hook.nav('cheminj'); app.flush(20); return app.el('cj_root'); }
function rows(app, boxId) {
  return app.findAll('#' + boxId + ' .rrow').map((r) => ({ l: txt(r.querySelector('.rl')), v: txt(r.querySelector('.rv')) }));
}
function row(app, boxId, label) {
  const r = rows(app, boxId).find((x) => x.l.indexOf(label) === 0);
  if (!r) throw new Error('no row "' + label + '" in #' + boxId + ': ' + rows(app, boxId).map((x) => x.l).join(' | '));
  return r.v;
}
const shownEl = (e) => { for (let p = e; p; p = p.parentElement) if (p.style && p.style.display === 'none') return false; return true; };

module.exports = [
  {
    name: 'CHEM review R1: oil / water through the choke — ⚠ "computed for the gas only" with the §4.1.5 mixture estimate (100.1 °F); none for H1 or a user choke temperature',
    wp: WP,
    run(app, assert) {
      const r = compute(app, { stream: { qg: 3, qo: 3000, qw: 500 } });
      const v = r.hydrate.verdicts.find((x) => x.code === 'jt_liquids');
      assert.ok(v && v.level === 'warn', 'liquids ⚠ in the hydrate block');
      assert.includes(v.text, 'computed for the gas only');
      assert.includes(v.text, 'may be far too high');
      // gas 148,858 lb/d × 0.6, oil 819,063 × 0.5, water 183,855 × 1.0 → gas share 0.1308; ΔT 75.44 × 0.1308 = 9.87 °F
      assert.near(r.spread.jt.liquids.gasFrac, 0.1308, 0.002, 'gas share of the heat capacity');
      assert.near(r.spread.jt.liquids.tMix, 100.1, 0.2, 'mixture estimate at the choke');
      assert.includes(v.text, 'mixture estimate 100.1 °F against 34.6 °F');
      assert.ok(v.text.length < 299, 'verdict under 299 characters');
      const h1 = compute(app, {});
      assert.ok(codes(h1.hydrate.verdicts).indexOf('jt_liquids') === -1, 'H1 (2 bbl/d water) has no liquids ⚠');
      assert.ok(h1.spread.jt.liquids.gasFrac > 0.99, 'H1 gas carries > 99 % of the heat capacity');
      assert.near(h1.spread.jt.choke.t, 34.56, 0.05, 'H1 choke temperature unchanged (correction not applied in 3.2a)');
      const user = compute(app, { stream: { qg: 3, qo: 3000, qw: 500 }, spread: { jt: 'user', tck: 40 } });
      assert.ok(codes(user.hydrate.verdicts).indexOf('jt_liquids') === -1, 'no ⚠ when the choke temperature is entered');
      // page: the Notes and the Design basis say "gas only"
      open(app);
      assert.includes(txt(app.findAll('#cj_notes_res .cj-note')[0]), 'for the gas only (liquids reduce the cooling)');
      assert.ok(app.findAll('#cj_notes_res .cj-note').every((n) => txt(n).length <= 600), 'Notes boxes still ≤ 600 characters');
      assert.includes(row(app, 'cj_rb_basis', 'Choke outlet temperature'), 'gas only');
    },
  },
  {
    name: 'CHEM review R2: air-driven calibration at the flowing discharge pressure (3,050 psig) — 627.8 mL / 60 s at 45.64 psig air → Q₀ 720 gal/d, air 39.21 psig; operating air row',
    wp: WP,
    run(app, assert) {
      const r = compute(app, { cal: { line: 1, mL: 627.8, s: 60, setting: 45.64 } });
      const ln = r.lines[0], c = r.calibration;
      assert.strictEqual(ln.pressure.pReq, 3550, 'P_req stays the shut-in case');
      assert.strictEqual(ln.pressure.pReqShutin, 3550);
      assert.strictEqual(ln.pressure.pReqFlow, 3050, 'FWHP + allowance while flowing');
      assert.near(ln.pump.airDesign, 45.64, 0.05, 'design air at the shut-in pressure unchanged (plan H1)');
      assert.near(ln.pump.airFlow, 39.21, 0.05, 'operating air while flowing');
      assert.near(ln.pump.airFlowPeak, 54.89, 0.05, 'operating peak air while flowing');
      assert.strictEqual(c.pTest, 3050);
      assert.near(c.q0Refit_gal_d, 720.0, 0.5, 'free flow re-fitted to the true 720 gal/d');
      assert.near(c.newSetting, 39.21, 0.05, 'corrected air');
      // the corrected setting gives the target on the real pump (Q₀ 720, ratio 100) at 3,050 psig
      assert.near(720 * (1 - 3050 / (100 * c.newSetting)), ln.rate.gal_d, 0.2, 'one correction reaches the target');
      // a test at the shut-in pressure: enter it
      const s = compute(app, { cal: { line: 1, mL: 627.8, s: 60, setting: 45.64, pd: 3550 } }).calibration;
      assert.strictEqual(s.pTest, 3550); assert.ok(s.pTestEntered, 'entered');
      assert.near(s.q0Refit_gal_d, 1074.9, 0.5);
      const bad = app.win.WTS_cheminj_compute({ cal: { line: 1, mL: 627.8, s: 60, setting: 45.64, pd: -5 } });
      assert.ok(!bad.ok && Array.from(bad.bad).indexOf('cj_cal_pd') !== -1, 'negative test pressure refused');
      // downstream of the choke: no shut-in case, the flowing and design pressures are the same
      const ds = compute(app, { lines: [{ point: 'dsch' }] }).lines[0];
      assert.strictEqual(ds.pressure.pReqFlow, ds.pressure.pReq);
      // page: the operating row in imperial and Metric
      open(app);
      assert.match(row(app, 'cj_rb_line_1', 'Air pressure setting at the shut-in design pressure'), /^45\.6 psig · 63\.9 psig$/);
      assert.match(row(app, 'cj_rb_line_1', 'Operating air setting while flowing (3,050 psig)'), /^39\.2 psig · 54\.9 psig$/);
      const U = app.win.WTS_units;
      U.setSystem('metric');
      try {
        app.flush(20);
        assert.match(row(app, 'cj_rb_line_1', 'Operating air setting while flowing (21,029 kPa(g))'), /^270 kPa\(g\) · 378 kPa\(g\)$/);
        assert.ok(shownEl(app.el('cj_cal_pd')), 'test pressure field shown for the air-driven line');
        assert.match(txt(app.el('cj_cal_pd').closest('.fg-item').querySelector('label')), /\(kPa\(g\)\)$/);
      } finally { U.setSystem('imperial'); }
      app.flush(20);
    },
  },
  {
    name: 'CHEM review R3: water measured at the separator never credits more condensed water than the gas carries (W_sep capped at W_in: 317.4 lb/d, 1061.4 lb/d)',
    wp: WP,
    run(app, assert) {
      // H1 with the heater at 90 °F: W_in(3014.7, 110) 39.18 < W_sep(1014.7, 90) 44.83 lb/MMscf
      const h = compute(app, { stream: { wbasis: 'sep' } }).lines[0].hydrate;
      assert.near(h.water.Win, 39.18, 0.02); assert.near(h.water.Wsep, 44.83, 0.02);
      assert.near(h.water.cond, 10 * (39.18 - 7.44), 0.5, 'condensed = q_g·(min(W_in, W_sep) − W_ctrl)');
      assert.ok(h.water.cond <= 10 * h.water.Win + 1e-9, 'never more than the gas carries');
      assert.near(h.inh.solution_lb_d, 1061.4, 1.0, 'total methanol');
      const all = compute(app, { stream: { wbasis: 'sep' }, basis: { cond: 'all' } }).lines[0].hydrate;
      assert.near(all.water.cond, 10 * all.water.Win, 0.01, "'all' condensed with the separator basis: q_g·min(W_in, W_sep)");
      // a cold separator (heater off) still subtracts the water that condensed upstream of it
      const cold = compute(app, { stream: { wbasis: 'sep' }, spread: { htr: 'no' } }).lines[0].hydrate;
      assert.ok(cold.water.Wsep < cold.water.Win, 'cold separator');
      assert.near(cold.water.cond, 10 * Math.max(0, cold.water.Wsep - cold.water.Wout), 1e-6);
    },
  },
  {
    name: 'CHEM review R4: ppm on total liquid uses the phases at the point — film-forming CI 25 ppm v: wellhead 8.4, separator oil outlet 3.15, water outlet 5.25 gal/d',
    wp: WP,
    run(app, assert) {
      const r = compute(app, { stream: { qo: 3000, qw: 5000 }, nlines: 3, lines: [
        { point: 'wh', chem: 'ci_film_liq', pump: 'elec_plunger' },
        { point: 'sepoil', chem: 'ci_film_liq', pump: 'elec_plunger' },
        { point: 'sepwat', chem: 'ci_film_liq', pump: 'elec_plunger' }] });
      assert.near(r.lines[0].rate.gal_d, 42 * 8000 * 25e-6, 1e-9, 'oil + water upstream');
      assert.near(r.lines[1].rate.gal_d, 42 * 3000 * 25e-6, 1e-9, 'oil only at the oil outlet');
      assert.near(r.lines[2].rate.gal_d, 42 * 5000 * 25e-6, 1e-9, 'water only at the water outlet');
      // the engine function without a point keeps the plain q_o + q_w (host chem-page identity)
      assert.near(C(app).doseRate({ basis: 'ppmv_liq', dose: 25, qo: 3000, qw: 5000 }).gal_d, 8.4, 1e-9);
      assert.near(C(app).doseRate({ basis: 'ppmv_liq', dose: 25, qo: 3000, qw: 5000, phases: { oil: true, water: false } }).gal_d, 3.15, 1e-9);
    },
  },
  {
    name: 'CHEM review R5: blank MAWP = the pump rating — pneumatic 3/4 in on 4 in keeps its 10,000 psi body (no circuit ✗, band 3,905–10,000), only the capability ✗; metering pump uses its nameplate',
    wp: WP,
    run(app, assert) {
      const ln = compute(app, { lines: [{ pump: 'pneu_plunger', plunger: 0.75, actd: 4 }] }).lines[0];
      assert.near(ln.pump.pMax, 2276, 1, 'drive-limited output');
      assert.strictEqual(ln.pump.pumpRating, 10000, 'body rating');
      assert.strictEqual(ln.pressure.mawp, 10000);
      assert.ok(ln.pressure.psvBand.ok === true && ln.pressure.psvBand.hi === 10000, 'relief band 3,905 to 10,000 psig');
      const cs = codes(ln.verdicts);
      ['below_sithp', 'below_rating', 'psv_band'].forEach((k) => assert.ok(cs.indexOf(k) === -1, 'no ' + k));
      assert.ok(cs.indexOf('pressure') !== -1, 'capability ✗ still shown');
      const air = compute(app, {}).lines[0];
      assert.strictEqual(air.pressure.mawp, 10000, 'air-driven pump body');
      const met = compute(app, { lines: [{ pump: 'elec_hyd_diaph' }] }).lines[0];
      assert.strictEqual(met.pressure.mawp, 3000, 'metering pump nameplate');
      assert.ok(codes(met.verdicts).indexOf('below_sithp') !== -1, 'a 3,000 psi metering pump is below SITHP');
      const el = compute(app, { lines: [{ pump: 'elec_plunger' }] }).lines[0];
      assert.near(el.pressure.mawp, 4158, 1, 'electric plunger: rod-load rating at 7/8 in');
      const m = compute(app, { lines: [{ pump: 'pneu_plunger', plunger: 0.75, actd: 4, mawp: 3000 }] }).lines[0];
      assert.strictEqual(m.pressure.mawp, 3000, 'an entered MAWP wins');
      assert.ok(codes(m.verdicts).indexOf('below_sithp') !== -1);
    },
  },
  {
    name: 'CHEM review R6: Metric — verdict divs, pump-options verdict cell, J-T rule rows and the Hydrate banner carry no imperial unit (default, infeasible pumps, rule, flare, tank)',
    wp: WP,
    run(app, assert) {
      open(app);
      const U = app.win.WTS_units;
      U.setSystem('metric');
      const scan = (what) => {
        app.flush(20);
        const hits = app.findAll('#pgBody .cj-v, #pgBody .rrow, #pgBody .rbox-title, #pgBody table.dtable td, #pgBody table.dtable th')
          .filter(shownEl).map(txt).filter((t) => IMP.test(t));
        assert.deepStrictEqual(hits, [], 'imperial units in Metric (' + what + ')');
        assert.ok(!BAD.test(txt(app.el('pgBody'))), 'no NaN (' + what + ')');
      };
      try {
        scan('default');
        assert.ok(app.findAll('#cj_rb_spread .cj-v').some((e) => /below the 15\.6 °C limit of the Bukacek correlation/.test(txt(e))), 'Bukacek limit in °C');
        app.select('cj_pump_1', 'elec_hyd_diaph');
        scan('hydraulic-diaphragm pump at the wellhead');
        const cur = app.findAll('#cj_rb_line_1 table.dtable tbody tr').map((tr) => Array.from(tr.querySelectorAll('td')).map(txt)).find((r) => r[0] === 'Current');
        assert.ok(cur && /maximum 20,684 kPa\(g\)/.test(cur[5]), 'options verdict cell in kPa(g): ' + (cur || []).join(' | '));
        app.select('cj_pump_1', 'pneu_plunger');
        app.select('cj_plg_1', '0.75');
        scan('pneumatic 3/4 in plunger');
        app.select('cj_jt', 'rule');
        scan('7 °F/100 psi rule');
        assert.match(row(app, 'cj_rb_basis', 'Choke outlet temperature'), /0\.56 °C per bar/);
        assert.ok(app.findAll('#cj_rb_spread .cj-v').some((e) => /Choke outlet uses 0\.56 °C per bar/.test(txt(e))), 'rule verdict in °C per bar');
        app.select('cj_jt', 'ise');
        app.select('cj_chem_1', 'ci_film_liq');
        app.select('cj_pt_1', 'flare');
        scan('flare line, blank back-pressure');
        app.select('cj_pt_1', 'tank');
        scan('tank');
        assert.ok(app.findAll('#cj_rb_line_1 .cj-v').some((e) => /at least 172 kPa above the suction head/.test(txt(e))), 'anti-siphon allowance in kPa');
        // Hydrate page banner
        app.hook.nav('hydrate'); app.flush(20);
        assert.includes(txt(app.el('wts_hydrate_cjlink')), '2.8 °C default margin');
      } finally { U.setSystem('imperial'); }
      app.flush(20);
      assert.includes(txt(app.el('wts_hydrate_cjlink')), '5 °F default margin', 'banner follows the flip back');
    },
  },
  {
    name: 'CHEM review R7: sour gas (H2S above 1,000 ppm or acid gas above 5 mol %) warns that Bukacek under-estimates the water; sweet gas does not',
    wp: WP,
    run(app, assert) {
      const RX = /Sour gas holds more water than the sweet-gas Bukacek correlation/;
      const has = (inp) => compute(app, inp).lines[0].hydrate.warnings.some((w) => RX.test(w));
      assert.ok(has({ stream: { h2s: 20000 } }), '2 mol % H2S');
      assert.ok(has({ stream: { co2: 6 } }), '6 mol % CO2');
      assert.ok(has({ stream: { h2s: 5000, co2: 4.6 } }), 'acid gas 5.1 mol %');
      assert.ok(!has({}), 'sweet H1');
      assert.ok(!has({ stream: { h2s: 1000, co2: 3 } }), '1,000 ppm H2S + 3 % CO2');
    },
  },
  {
    name: 'CHEM review R9: H2S above 3 mol % — margin keeps the 3 × sour adder (never falls), nodes "refused", no ✓ no-risk, no correlation shut-in / start-up wt %',
    wp: WP,
    run(app, assert) {
      const a = compute(app, { stream: { h2s: 29000 }, spread: { fwht: 95 } });
      const b = compute(app, { stream: { h2s: 31000 }, spread: { fwht: 95 } });
      assert.near(a.spread.margin.used, 24.5, 1e-9);
      assert.near(b.spread.margin.used, 25, 1e-9, '10 + 3 × 5 °F');
      assert.ok(b.spread.margin.used >= a.spread.margin.used, 'margin never falls as H2S rises');
      assert.ok(b.spread.margin.refused);
      b.spread.nodes.concat([b.spread.shutin, b.spread.startup]).forEach((n) => assert.strictEqual(n.status, 'refused', n.key));
      const all = [].concat(b.hydrate.verdicts, b.lines[0].verdicts);
      ['no_risk', 'node_protected', 'node_risk', 'node_margin', 'shutin_req', 'startup_req'].forEach((k) => assert.ok(codes(all).indexOf(k) === -1, 'no ' + k));
      assert.ok(codes(b.hydrate.verdicts).indexOf('sour_refused') !== -1);
      const hd = b.lines[0].hydrate;
      assert.strictEqual(hd.shutin.XR, null); assert.strictEqual(hd.startup.XR, null);
      assert.strictEqual(hd.shutin.level, 'bad'); assert.includes(hd.shutin.text, 'not assessed');
      // CO2 above 20 mol %: refused too, the flat adder kept
      const c = compute(app, { stream: { co2: 25 } });
      assert.ok(c.spread.margin.refused && c.spread.margin.used === 15, 'CO2 refused, margin 15 °F');
      // page: node status and the requirement rows
      open(app);
      app.input('cj_h2s', '40000');
      const st = app.findAll('#cj_rb_spread table tbody tr').map((tr) => txt(tr.querySelectorAll('td')[5]));
      assert.ok(st.length === 5 && st.every((s) => /^✗ refused/.test(s)), 'every node refused: ' + st.join(' | '));
      assert.match(row(app, 'cj_rb_spread', 'Shut-in requirement'), /^Not assessed/);
      assert.match(row(app, 'cj_rb_spread', 'Start-up requirement'), /^Not assessed/);
      assert.ok(!/32\.27 wt %/.test(txt(app.el('cj_res'))), 'no sweet-gas shut-in figure');
    },
  },
  {
    name: 'CHEM review R10: no ✓ "protected" for an under-dosed override (5 wt %) or a pump that cannot deliver; ✗ override below the design; a higher override still protects',
    wp: WP,
    run(app, assert) {
      const lo = compute(app, { lines: [{ dose: 5 }] });
      assert.ok(codes(lo.lines[0].verdicts).indexOf('override_low') !== -1 && lo.lines[0].level === 'bad', '✗ override below the design');
      assert.includes(lo.lines[0].verdicts.find((v) => v.code === 'override_low').text, 'below the required 38.14 wt %');
      assert.ok(codes(lo.hydrate.verdicts).indexOf('node_protected') === -1, 'no ✓ protected');
      const nu = lo.hydrate.verdicts.find((v) => v.code === 'node_unprotected');
      assert.ok(nu && nu.level === 'bad' && /Downstream of choke is not protected: line 1 rich 5\.00 wt %/.test(nu.text), nu && nu.text);
      const met = compute(app, { lines: [{ pump: 'elec_hyd_diaph' }] });
      assert.strictEqual(met.lines[0].pump.deliverable, false, '3,000 psi pump at 3,550 psig');
      assert.ok(codes(met.hydrate.verdicts).indexOf('node_protected') === -1);
      assert.ok(codes(met.hydrate.verdicts).indexOf('node_unprotected') !== -1, 'pump cannot deliver → not protected');
      const hi = compute(app, { lines: [{ dose: 45 }] });
      assert.ok(codes(hi.lines[0].verdicts).indexOf('override_low') === -1, 'override above the design');
      assert.ok(codes(hi.hydrate.verdicts).indexOf('node_protected') !== -1, 'protected');
      assert.ok(hi.lines[0].hydrate.warnings.some((w) => /not the design value/.test(w)));
      const h1 = compute(app, {});
      assert.ok(codes(h1.hydrate.verdicts).indexOf('node_protected') !== -1 && h1.lines[0].pump.deliverable, 'H1 air-driven line protects');
      // rule 8 uses the same test: an aqueous line upstream with an under-dosed THI line gets the ⚠
      const aq = compute(app, { nlines: 2, lines: [{ dose: 5 }, { point: 'wh', chem: 'h2s_mea_triazine', pump: 'air_liquid' }], stream: { h2s: 50 } });
      assert.ok(codes(aq.lines[1].verdicts).indexOf('aq_hydrate') !== -1, 'aqueous chemical ⚠ when the THI line does not protect');
    },
  },
  {
    name: 'CHEM review R11: sour produced drive gas ✗ (and the stall ✗) on a pneumatic / air-driven line with no steady rate — refused dose, line not required',
    wp: WP,
    run(app, assert) {
      const a = compute(app, { stream: { h2s: 40000 }, spread: { supgas: 'well' } }).lines[0];
      assert.strictEqual(a.rate.gal_d, 0);
      assert.ok(codes(a.verdicts).indexOf('sour_drive') !== -1, 'sour drive ✗ on a refused line');
      const b = compute(app, { stream: { h2s: 50 }, spread: { supgas: 'well', fwht: 250 } }).lines[0];
      assert.strictEqual(b.rate.gal_d, 0); assert.ok(codes(b.verdicts).indexOf('not_required') !== -1);
      assert.ok(codes(b.verdicts).indexOf('sour_drive') !== -1, 'sour drive ✗ on a line not required for steady flow');
      const w = compute(app, { spread: { supgas: 'well', fwht: 250 } }).lines[0];
      assert.ok(codes(w.verdicts).indexOf('well_drive') !== -1, 'sweet produced gas ⚠ at zero rate');
      const st = compute(app, { spread: { fwht: 250 }, basis: { psup: 10 }, lines: [{ pump: 'pneu_plunger' }] }).lines[0];
      assert.ok(codes(st.verdicts).indexOf('gas_stall') !== -1, 'stall ✗ at zero rate');
      const el = compute(app, { stream: { h2s: 40000 }, spread: { supgas: 'well' }, lines: [{ pump: 'elec_plunger' }] }).lines[0];
      assert.ok(codes(el.verdicts).indexOf('sour_drive') === -1, 'no drive gas on an electric pump');
    },
  },
  {
    name: 'CHEM review R12: air-operated diaphragm pump is 1:1 whatever cj_ratio holds — 100 psig maximum, pressure ✗; pump change clears the hidden ratio; drive-gas reason',
    wp: WP,
    run(app, assert) {
      const ln = compute(app, { lines: [{ pump: 'air_diaph', ratio: 100 }] }).lines[0];
      assert.strictEqual(ln.pump.pMax, 100, 'ratio 1 × 100 psig air');
      assert.ok(ln.pump.why.indexOf('pressure') !== -1 && codes(ln.verdicts).indexOf('pressure') !== -1, 'pressure ✗');
      // low-pressure separator: demulsifier at the oil outlet, separator 50 psig, relief valve 150 psig
      const lp = compute(app, { spread: { psep: 50, psvsep: 150, pck: 100 }, lines: [{ point: 'sepoil', chem: 'demulsifier', pump: 'air_diaph', ratio: 100 }], stream: { qo: 3000 } }).lines[0];
      assert.strictEqual(lp.pump.pMax, 100); assert.ok(codes(lp.verdicts).indexOf('pressure') !== -1, '250 psig rating not reached');
      const dg = C(app).pumpSetting({ pump: 'air_diaph', rate_gal_d: 100, pReq: 120, pRating: 130, psup: 100 });
      assert.ok(dg.why.indexOf('drivegas') !== -1, 'drive gas below the discharge pressure');
      // page: the hidden ratio and displacement are cleared on the change
      open(app);
      assert.strictEqual(app.el('cj_ratio_1').value, '100');
      app.select('cj_pump_1', 'air_diaph');
      assert.strictEqual(app.el('cj_ratio_1').value, '', 'ratio cleared');
      assert.strictEqual(app.el('cj_vcyc_1').value, '', 'displacement cleared');
      assert.match(row(app, 'cj_rb_line_1', 'Pump pressure capability'), /^100 psig ✗$/);
      app.select('cj_pump_1', 'air_liquid');
      assert.strictEqual(app.el('cj_ratio_1').value, '100', 'air-driven preset back');
    },
  },
  {
    name: 'CHEM review R13: refused / no-rate lines say so in the headline, chip, rate row, pump row and Summary instead of "no flow required"',
    wp: WP,
    run(app, assert) {
      const r = compute(app, { stream: { h2s: 40000 } }).lines[0];
      assert.strictEqual(r.zero, 'refused'); assert.ok(r.noRate);
      assert.strictEqual(r.chip, 'Methanol · Upstream of choke · refused: enter a lab hydrate temperature');
      const n = compute(app, { stream: { qw: 0 }, spread: { fwht: 40 } }).lines[0];
      assert.strictEqual(n.zero, 'norate'); assert.match(n.chip, /no rate given: see ✗$/);
      const nd = compute(app, { lines: [{ chem: 'custom', pump: 'elec_solenoid', point: 'tank' }] }).lines[0];
      assert.strictEqual(nd.zero, 'nodose'); assert.match(nd.chip, /no dose entered/);
      const z = compute(app, { stream: { qw: 0, qg: 0 } }).lines[0];
      assert.strictEqual(z.zero, null, 'no water: a real zero demand'); assert.match(z.chip, /no flow$/);
      open(app);
      app.input('cj_h2s', '40000');
      const head = txt(Array.from(app.el('cj_res').children).find((c) => c.classList.contains('cj-v')));
      assert.strictEqual(head, '✗ Line 1: Methanol upstream of choke, refused: enter a lab hydrate temperature.');
      assert.strictEqual(row(app, 'cj_rb_line_1', 'Chemical rate'), 'Refused: enter a lab hydrate temperature');
      assert.strictEqual(row(app, 'cj_rb_line_1', 'Pump setting'), 'Refused: enter a lab hydrate temperature');
      const sum = app.findAll('#cj_rb_summary table tbody tr')[0];
      assert.strictEqual(txt(sum.querySelectorAll('td')[6]), 'refused: enter a lab hydrate temperature');
      assert.ok(!/no flow required/i.test(txt(app.el('cj_res'))), 'no "no flow required" anywhere');
      app.input('cj_h2s', '0'); app.input('cj_qw', '0'); app.input('cj_fwht', '40');
      assert.match(txt(Array.from(app.el('cj_res').children).find((c) => c.classList.contains('cj-v'))), /no rate given: see ✗\.$/);
    },
  },
  {
    name: 'CHEM review R14: next plunger is feasible itself (peak ≤ 85 %, stable minimum, pressure, drive gas) or none; CI 52.5 gal/d on 3/16 × 1/4 in gets no infeasible 1 in suggestion',
    wp: WP,
    run(app, assert) {
      const E = C(app);
      const base = { pump: 'pneu_plunger', plunger_in: 0.1875, stroke_in: 0.25, actD_in: 8, rate_gal_d: 52.5, pReq: 1050, pRating: 1584, psup: 100, peakF: 1.25, eta: 0.9 };
      const o = E.pumpSetting(base);
      assert.ok(codes(o.verdicts).indexOf('spm_over') !== -1);
      if (o.nextPlunger) {
        const r = E.pumpSetting(Object.assign({}, base, { plunger_in: o.nextPlunger.plunger_in }));
        assert.ok(r.feasible, 'suggested plunger is feasible');
      } else assert.ok(!/Next plunger/.test(o.verdicts.find((v) => v.code === 'spm_over').text), 'no suggestion text without a feasible plunger');
      // 1 in × 1/4 in: 47.7 SPM = 79.4 %, peak 99.3 % → not a valid suggestion
      const one = E.pumpSetting(Object.assign({}, base, { plunger_in: 1 }));
      assert.ok(!one.feasible && one.peakPct > 85, '1 in peaks above 85 %');
      assert.ok(!o.nextPlunger || o.nextPlunger.plunger_in !== 1, 'never the infeasible 1 in');
      // every suggestion over a sweep of rates is feasible
      [5, 20, 30, 60, 120].forEach((q) => {
        const s = E.pumpSetting({ pump: 'pneu_plunger', plunger_in: 0.25, stroke_in: 1, actD_in: 4, rate_gal_d: q, pReq: 1000, pRating: 1100, psup: 100, peakF: 1.25, eta: 0.9 });
        if (s.nextPlunger) assert.ok(E.pumpSetting({ pump: 'pneu_plunger', plunger_in: s.nextPlunger.plunger_in, stroke_in: 1, actD_in: 4, rate_gal_d: q, pReq: 1000, pRating: 1100, psup: 100, peakF: 1.25, eta: 0.9 }).feasible, q + ' gal/d');
      });
    },
  },
  {
    name: 'CHEM review R15: below-turndown doses get dilution advice (not "two pumps in parallel"); metering / transfer / electric plunger pressure advice has no actuator wording',
    wp: WP,
    run(app, assert) {
      const E = C(app);
      const lo = E.pumpOptions({ rate_gal_d: 0.105, pReq: 1050, pRating: 1584, psup: 100, peakF: 1.25, pump: 'elec_solenoid', haz: 'yes' });
      assert.strictEqual(lo.ranked.length, 0);
      assert.includes(lo.reason, 'below turndown: dilute');
      assert.ok(!/rate-limited|two pumps in parallel/.test(lo.reason), lo.reason);
      const hi = E.pumpOptions({ rate_gal_d: 5000, pReq: 3550, pRating: 3905, psup: 100, peakF: 2, eta: 0.9, haz: 'yes', pump: 'pneu_plunger' });
      assert.includes(hi.reason, 'rate-limited'); assert.ok(!/below turndown/.test(hi.reason));
      const sol = E.pumpSetting({ pump: 'elec_solenoid', rate_gal_d: 10, pReq: 3550, pRating: 3905, peakF: 1.25 });
      const sv = sol.verdicts.find((v) => v.code === 'pressure');
      assert.ok(sv && !/plunger,|actuator/.test(sv.text) && /rated for at least 3,905 psig/.test(sv.text), sv && sv.text);
      const aod = E.pumpSetting({ pump: 'air_diaph', rate_gal_d: 100, pReq: 50, pRating: 150, psup: 100, peakF: 1.25 });
      const av = aod.verdicts.find((v) => v.code === 'pressure');
      assert.ok(av && !/plunger,|actuator/.test(av.text), av && av.text);
      const ep = E.pumpSetting({ pump: 'elec_plunger', plunger_in: 1.25, rate_gal_d: 100, pReq: 3550, pRating: 3905, peakF: 1.25 });
      const ev = ep.verdicts.find((v) => v.code === 'pressure');
      assert.ok(ev && /rod-load maximum/.test(ev.text) && !/actuator/.test(ev.text), ev && ev.text);
    },
  },
];
