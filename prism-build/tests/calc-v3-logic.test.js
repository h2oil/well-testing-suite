// v3.0 whole-app logic audit — regression tests for the confirmed defects.
//
//   turbmeter   wide Qmin–Qmax range picked the 8" meter and called Qmax over-range
//   analogsig   NAMUR NE 43 fault bands applied to process-value / voltage inputs
//   tank/mcfshr results stayed in the old unit system after the Units switch
//   chokecnv    clearing a field left the other two converting the previous size
//   (host)      edited inputs on Calculate-button pages were reported next to the
//               previous result (page PDF / Quick Report snapshot)
//   (report)    the Quick Report summary hid a FAIL verdict carried in a box title
//   h2sroe      stale "dispersion tool is planned" note; ROE verdicts in ft only
//   prism SOE   "comes before any open event" warning after a close
//   solgor      Rs unit label "scf/stbbl" (scf/STB everywhere else)
//
// Every expected number is an independent hand calculation written out below,
// not a value read back from the code under test.
'use strict';

function go(app, route, metric) {
  if (metric) app.win.WTS_units.setSystem('metric');
  app.hook.nav(route);
  app.flush(50);
}
function setv(app, id, v) {
  const el = app.el(id);
  if (!el) throw new Error('missing input #' + id);
  if (el.tagName === 'SELECT') app.select(el, String(v)); else app.input(el, String(v));
}
function setAll(app, map) { Object.keys(map).forEach((k) => setv(app, k, map[k])); }
function press(app, fnName) {
  const btn = app.findAll('#pgBody button').find((b) => (b.getAttribute('onclick') || '').indexOf(fnName + '(') === 0);
  if (!btn) throw new Error('no button for ' + fnName);
  app.click(btn);
  app.flush(20);
}
function text(app, id) { const el = app.el(id); return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''; }
function rowNum(app, resId, label, nth) {
  const rows = app.findAll('#' + resId + ' .rrow').filter((r) => { const l = r.querySelector('.rl'); return l && l.textContent.replace(/\s+/g, ' ').indexOf(label) !== -1; });
  const row = rows[nth || 0];
  if (!row) throw new Error('row "' + label + '" not found in #' + resId + ': ' + text(app, resId).slice(0, 300));
  const m = /-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/i.exec(row.querySelector('.rv').textContent.replace(/,/g, ''));
  return m ? parseFloat(m[0]) : NaN;
}
function rowText(app, resId, label) {
  const row = app.findAll('#' + resId + ' .rrow').find((r) => { const l = r.querySelector('.rl'); return l && l.textContent.indexOf(label) !== -1; });
  return row ? row.querySelector('.rv').textContent.replace(/\s+/g, ' ').trim() : '';
}
function errs(app, resId) { return app.findAll('#' + resId + ' .val-error').map((e) => e.textContent); }
function clean(assert, app, resId) {
  const t = text(app, resId);
  assert(!/NaN|Infinity|undefined/.test(t), '#' + resId + ' shows NaN/Infinity/undefined: ' + t.slice(0, 200));
  assert.deepStrictEqual(app.consoleErrors().map(String), [], 'no console errors');
}

const BBL_M3 = 0.158987294928, IN3_M3 = 1.6387064e-5;

module.exports = [
  {
    name: 'v3 turbmeter: 100–8,000 BPD selects the 3" meter (not 8" "over-range"); Qmin note asks for a second run',
    wp: 'V3L',
    run(app, assert) {
      go(app, 'turbmeter');
      setAll(app, { tm_liq: 'oil', tm_api: 35, tm_t: 40, tm_mu: 5, tm_qmin: 100, tm_qmax: 8000, tm_p: 500 });
      press(app, 'calcTurbMeter');
      const t = text(app, 'tm_res');
      assert.includes(t, 'Selected Meter: 3"');
      assert(t.indexOf('exceeds the largest meter') === -1, 'Qmax 8,000 BPD is inside the 3" rating — no over-range note: ' + t.slice(0, 300));
      assert.includes(t, 'below the 3" meter\'s rated minimum');
      assert.includes(t, 'wider than one meter covers');
      // 3" bore 0.0779 m: A = π·0.0779²/4 = 4.76612e-3 m²; q = BPD·0.158987/86400
      const A = Math.PI * 0.0779 * 0.0779 / 4;
      assert.near(rowNum(app, 'tm_res', 'Velocity @ Q', 0), 100 * BBL_M3 / 86400 / A, 6e-4, 'v @ Qmin (0.0386 m/s)');
      assert.near(rowNum(app, 'tm_res', 'Velocity @ Q', 1), 8000 * BBL_M3 / 86400 / A, 6e-3, 'v @ Qmax (3.089 m/s)');
      clean(assert, app, 'tm_res');
    },
  },
  {
    name: 'v3 turbmeter: Qmax above the 8" rating (65,000 BPD) is still reported as over-range',
    wp: 'V3L',
    run(app, assert) {
      go(app, 'turbmeter');
      setAll(app, { tm_liq: 'water', tm_t: 20, tm_mu: 1, tm_qmin: 6000, tm_qmax: 70000, tm_p: 100 });
      press(app, 'calcTurbMeter');
      const t = text(app, 'tm_res');
      assert.includes(t, 'Selected Meter: 8"');
      assert.includes(t, 'exceeds the largest meter');
      clean(assert, app, 'tm_res');
    },
  },
  {
    name: 'v3 analogsig: NAMUR fault bands apply to a mA input only; PV / V over-range is an over-range note',
    wp: 'V3L',
    run(app, assert) {
      go(app, 'analogsig');
      // PV 110 on 0–100: pct = 1.10 → mA = 4 + 16·1.10 = 21.6, V = 11.0
      setAll(app, { as_type: 'PV', as_val: 110, as_lo: 0, as_hi: 100 });
      press(app, 'calcAnalogSig');
      assert.deepStrictEqual(errs(app, 'as_res'), [], 'no transmitter-fault error for a process value');
      assert.includes(text(app, 'as_res'), 'over-range, 110 %');
      assert.near(rowNum(app, 'as_res', 'Current'), 21.6, 1e-9);
      assert.near(rowNum(app, 'as_res', 'Voltage'), 11.0, 1e-9);
      // 10.5 V on a 0–10 V signal: 105 %, no NAMUR message
      setAll(app, { as_type: 'V', as_val: 10.5 });
      press(app, 'calcAnalogSig');
      assert.deepStrictEqual(errs(app, 'as_res'), []);
      assert.includes(text(app, 'as_res'), 'over-range, 105 %');
      // A measured 22 mA is in the NAMUR NE 43 failure band (≥ 21 mA)
      setAll(app, { as_type: 'mA', as_val: 22 });
      press(app, 'calcAnalogSig');
      assert(errs(app, 'as_res').some((e) => e.indexOf('failure band') !== -1), 'mA 22 → failure band');
      // 3.9 mA: inside the NAMUR measuring range (3.8–20.5) but below 4 mA → under-range note
      setAll(app, { as_val: 3.9 });
      press(app, 'calcAnalogSig');
      assert.deepStrictEqual(errs(app, 'as_res'), []);
      assert.includes(text(app, 'as_res'), 'under-range');
      clean(assert, app, 'as_res');
    },
  },
  {
    name: 'v3 tank + mcfshr: results on screen follow a Units switch (were left in bbl)',
    wp: 'V3L',
    run(app, assert) {
      go(app, 'tank');
      setAll(app, { tr_h: 48, tr_l: 120, tr_w: 60, tr_fl: 24, tk_v1: 0, tk_v2: 5.2, tk_t1: 0, tk_t2: 1 });
      press(app, 'calcRectTank');
      press(app, 'calcTankRate');
      assert.includes(rowText(app, 'tr_res', 'Total Capacity'), 'bbls');
      app.win.WTS_units.setSystem('metric'); app.flush(50);
      // 48 × 120 × 60 in³ = 345,600 in³ = 5.6634 m³; half full = 2.8317 m³
      assert.includes(rowText(app, 'tr_res', 'Total Capacity'), 'm³');
      assert.near(rowNum(app, 'tr_res', 'Total Capacity'), 345600 * IN3_M3, 6e-4);
      assert.near(rowNum(app, 'tr_res', 'Fluid Volume'), 172800 * IN3_M3, 6e-4);
      // 5.2 bbl in 1 h = 0.8267 m³/h
      assert.near(rowNum(app, 'tk_res', 'Rate'), 5.2 * BBL_M3, 6e-4);
      assert.includes(rowText(app, 'tk_res', 'Rate'), 'm³/h');
      clean(assert, app, 'tr_res');

      app.win.WTS_units.setSystem('imperial');
      go(app, 'mcfshr');
      setAll(app, { ms_ti: 1000, ms_tf: 1010, ms_si: 50, ms_sf: 60, ms_ss: 58.5 });
      press(app, 'calcMCFShr');
      assert.includes(rowText(app, 'ms_res', 'Metered Volume'), 'bbl');
      app.win.WTS_units.setSystem('metric'); app.flush(50);
      assert.includes(rowText(app, 'ms_res', 'Metered Volume'), 'm³');
      assert.near(rowNum(app, 'ms_res', 'Metered Volume'), 10 * BBL_M3, 6e-3);   // 1.590 m³
      assert.near(rowNum(app, 'ms_res', 'MCF'), 1, 1e-9);                        // 10 / 10
      clean(assert, app, 'ms_res');
    },
  },
  {
    name: 'v3 chokecnv: 32/64 = 0.5 in = 12.70 mm; clearing the field clears the other two',
    wp: 'V3L',
    run(app, assert) {
      go(app, 'chokecnv');
      setv(app, 'cc_64', 32);
      assert.strictEqual(app.el('cc_in').value, '0.5000');
      assert.strictEqual(app.el('cc_mm').value, '12.70');
      setv(app, 'cc_64', '');
      assert.strictEqual(app.el('cc_in').value, '', 'decimal inches cleared');
      assert.strictEqual(app.el('cc_mm').value, '', 'millimetres cleared');
      setv(app, 'cc_mm', 25.4);
      assert.strictEqual(app.el('cc_64').value, '64.00');
      assert.strictEqual(app.el('cc_in').value, '1.0000');
    },
  },
  {
    name: 'v3 stale results: an edited input dims the old result and keeps it out of the report until Calculate',
    wp: 'V3L',
    run(app, assert) {
      go(app, 'tank');
      setAll(app, { tr_h: 48, tr_l: 120, tr_w: 60, tr_fl: 24 });
      press(app, 'calcRectTank');
      app.flush(1000);
      // 48·120·60 / 9702 = 35.622 bbl
      assert.near(rowNum(app, 'tr_res', 'Total Capacity'), 48 * 120 * 60 / 9702, 6e-4);
      setv(app, 'tr_h', 96);
      app.flush(1000);                                     // past the 900 ms report-snapshot debounce
      const box = app.el('tr_res').firstElementChild;
      assert(box && box.classList.contains('wts-stale') && box.classList.contains('rp-skip'), 'old result marked stale');
      const model = app.win.collectPageReport(app.el('pgBody'), { charts: false });
      const resText = JSON.stringify(model.results);
      assert(resText.indexOf('35.622') === -1, 'stale 48 in capacity is not in the page report: ' + resText.slice(0, 300));
      // The Quick Report snapshot never pairs Height 96 with the 48 in capacity.
      const snap = JSON.parse(app.storage.getItem('wts_report_snapshots') || '{}').tank;
      if (snap) {
        const s = JSON.stringify(snap);
        assert(!(s.indexOf('"value":"96"') !== -1 && s.indexOf('35.622') !== -1), 'snapshot mixes new input and old result');
      }
      press(app, 'calcRectTank');
      assert.strictEqual(app.findAll('#tr_res .wts-stale').length, 0, 'fresh result is not stale');
      assert.near(rowNum(app, 'tr_res', 'Total Capacity'), 96 * 120 * 60 / 9702, 6e-4);   // 71.243 bbl
      const m2 = app.win.collectPageReport(app.el('pgBody'), { charts: false });
      assert.includes(JSON.stringify(m2.results), '71.243');
      clean(assert, app, 'tr_res');
    },
  },
  {
    name: 'v3 Quick Report summary shows the Separator Rating FAIL verdict (retention 2.07 < 3 min)',
    wp: 'V3L',
    run(app, assert) {
      go(app, 'seprate');
      setAll(app, { sr_orient: 'H', sr_id: 36, sr_len: 10, sr_nll: 50, sr_p: 500, sr_t: 100, sr_qo: 3000, sr_qg: 5, sr_api: 35, sr_gsg: 0.75, sr_bsw: 5, sr_foam: 'low' });
      press(app, 'calcSepRate');
      // Horizontal 36 in × 10 ft at 50 % NLL: A = π·3²/4 ft², liquid = A·0.5·10·0.85 (usable)·0.85 (low foam);
      // q = 3000/(1 − 0.05) BPD → retention = V / (q/1440)
      const A = Math.PI * 9 / 4, Vbbl = A * 0.5 * 10 * 0.85 * 0.85 * 7.48052 / 42, ret = Vbbl / (3000 / 0.95 / 1440);
      assert.near(rowNum(app, 'sr_res', 'Retention Time'), ret, 0.006);              // 2.074 min < 3 → FAIL
      app.flush(1000);
      go(app, 'home');
      let html = '';
      app.win.__reportOverride = (t, c) => { html = c; };
      app.win.WTS_exportJobReport({ template: 'all' });
      // The summary table is the first table of the report ("Calculators in this report").
      const tbl = (/<table[\s\S]*?<\/table>/.exec(html) || [''])[0];
      const summary = tbl.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      assert.includes(summary, 'Key result');
      assert.includes(summary, 'Separator Rating — FAIL');
    },
  },
  {
    name: 'v3 h2sroe: ROE verdicts carry metres; the SO2 note points to the dispersion page (no "planned")',
    wp: 'V3L',
    run(app, assert) {
      go(app, 'h2sroe');
      setAll(app, { hs_q: 10, hs_ppm: 10000 });
      app.flush(50);
      // Texas Rule 36: X100 = (1.589·mf·Q)^0.6258 ft, X500 = (0.4546·mf·Q)^0.6258 ft; mf 0.01, Q 1e7 scf/d
      const x100 = Math.pow(1.589 * 0.01 * 1e7, 0.6258), x500 = Math.pow(0.4546 * 0.01 * 1e7, 0.6258);
      const m1 = (x100 * 0.3048).toFixed(1), m5 = (x500 * 0.3048).toFixed(1);   // 548.1 m, 250.5 m
      const t = text(app, 'pgBody');
      assert.includes(t, '100 ppm radius of exposure is ' + x100.toLocaleString(undefined, { maximumFractionDigits: 1, minimumFractionDigits: 1 }) + ' ft (' + m1 + ' m)');
      assert.includes(t, '500 ppm radius of exposure is ' + x500.toLocaleString(undefined, { maximumFractionDigits: 1, minimumFractionDigits: 1 }) + ' ft (' + m5 + ' m)');
      assert(t.indexOf('is planned') === -1, 'stale "planned" note removed');
      assert.includes(t, 'SO2 / H2S Dispersion Screening');
      clean(assert, app, 'pgBody');
    },
  },
  {
    name: 'v3 PRiSM events: a rate after a close is described as such (not "before any open event")',
    wp: 'V3L',
    run(app, assert) {
      const f = app.win.PRiSM_eventsToRateSchedule;
      assert.fn(f);
      const r = f(app.toWin([{ type: 'open', t: 0, q: 500 }, { type: 'close', t: 10 }, { type: 'rate', t: 12, q: 300 }, { type: 'close', t: 20 }]));
      assert(r.ok);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(r.rows)), [{ t: 0, q: 500 }, { t: 10, q: 0 }, { t: 12, q: 300 }, { t: 20, q: 0 }]);
      assert.strictEqual(r.warnings.length, 1);
      assert.includes(r.warnings[0], 'after a close with no new open event');
      const r2 = f(app.toWin([{ type: 'rate', t: 1, q: 400 }, { type: 'close', t: 5 }]));
      assert.includes(r2.warnings[0], 'before any open event');
      assert.deepStrictEqual(JSON.parse(JSON.stringify(r2.rows)), [{ t: 1, q: 400 }, { t: 5, q: 0 }]);
    },
  },
  {
    name: 'v3 solgor: Rs label is scf/STB; Standing Rs = 102.7 scf/STB at 500 psig, 150 °F, γg 0.75, 35 °API',
    wp: 'V3L',
    run(app, assert) {
      go(app, 'solgor');
      setAll(app, { sg_p: 500, sg_t: 150, sg_gg: 0.75, sg_api: 35, sg_psep: '', sg_tsep: '' });
      press(app, 'calcSolGOR');
      // Standing (1947): Rs = γg·[((p+14.7)/18.2 + 1.4)·10^(0.0125·API − 0.00091·T)]^1.2048
      const rs = 0.75 * Math.pow(((500 + 14.7) / 18.2 + 1.4) * Math.pow(10, 0.0125 * 35 - 0.00091 * 150), 1.2048);
      assert.near(rowNum(app, 'sg_res', 'Rs (Standing)'), rs, 0.06);
      assert.includes(rowText(app, 'sg_res', 'Rs (Standing)'), 'scf/STB');
      assert.includes(rowText(app, 'sg_res', 'Rs (Vasquez'), 'scf/STB');
      clean(assert, app, 'sg_res');
    },
  },
];
