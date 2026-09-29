// Review batch 2 — units, reports, privacy: regression tests for the confirmed defects.
//
//   1. 22-units.js _updateLabelText: the metric gauge label "kPa(g)" nests a
//      parenthesis, so flipping back to Imperial rewrote "(kPa(g))" as
//      "(kPa(psig))" (and "(kPa(kPa(g)))" on the next flip) on every psig field;
//      a label whose first parenthetical is not the unit ("Static (line)
//      pressure (psig)") lost "(line)" instead of its unit.
//   2. Host pages whose results use _uFmt (casing, bottoms up, solution GOR, …)
//      kept the result of the other unit system on screen after a flip.
//   3. PRV gas / steam / liquid results showed psia / psig / in² in Metric mode,
//      next to kPa(g) inputs.
//   4. Well Kill "Overbalance as density" and the brine verdict were ppg only
//      in Metric mode (every other density on the page carries kg/m³).
//
// Expected values are hand calculations: 1 psi = 6.894757293168 kPa,
// 1 bbl = 0.158987294928 m³, 1 in² = 645.16 mm², 1 ppg = 119.826 kg/m³,
// casing capacity = ID² / 1029.4 bbl/ft (API tubular tables).
'use strict';

const WP = 'R24';
const PSI_KPA = 6.894757293168, BBL_M3 = 0.158987294928, IN2_MM2 = 645.16, PPG_KGM3 = 119.826;

function go(app, route) { app.hook.nav(route); app.flush(50); }
function sys(app, s) { app.win.WTS_units.setSystem(s); app.flush(20); }
function label(app, id) {
  const e = app.el(id);
  const it = e && e.closest('.fg-item');
  const l = it && it.querySelector('label');
  return l ? String(l.textContent).trim() : '';
}
function num(s) {
  const m = String(s).replace(/,/g, '').match(/-?\d+(\.\d+)?(e[-+]?\d+)?/i);
  if (!m) throw new Error('no number in: ' + s);
  return parseFloat(m[0]);
}
function rvText(app, resId, lab, nth) {
  const rows = app.findAll('#' + resId + ' .rrow').filter((r) => {
    const l = r.querySelector('.rl'); return l && String(l.textContent).trim().indexOf(lab) === 0;
  });
  const r = rows[nth || 0];
  if (!r) throw new Error('no row "' + lab + '" in #' + resId + ': ' + (app.el(resId) ? app.el(resId).textContent : '(none)'));
  return String(r.querySelector('.rv').textContent).trim();
}
function calcBtn(app, fn) {
  const b = app.findAll('#pgBody button').find((x) => (x.getAttribute('onclick') || '').indexOf(fn + '(') === 0);
  if (!b) throw new Error('no button ' + fn);
  app.click(b); app.flush(20);
}

module.exports = [
  {
    name: 'units labels: psig ↔ kPa(g) round trips never nest ("kPa(psig)"), on host, Round-5 and plug-in pages',
    wp: WP,
    run(app, assert) {
      const cases = [
        ['aga3', 'a_Ps', 'Static Pressure'],
        ['choke', 'c_P1', 'Upstream Pressure'],
        ['solgor', 'sg_psep', 'Gas-Gravity Separator Pressure'],
        ['esdhi', 'wts_esdhi_hp', 'Hi-Pilot Setting'],
        ['wellkill', 'wk_gp', 'Known pressure'],
      ];
      for (const [route, id, text] of cases) {
        go(app, route);
        assert.equal(label(app, id), text + ' (psig)', route + ' imperial');
        sys(app, 'metric');
        assert.equal(label(app, id), text + ' (kPa(g))', route + ' metric');
        sys(app, 'imperial');
        assert.equal(label(app, id), text + ' (psig)', route + ' back to imperial');
        sys(app, 'metric');
        assert.equal(label(app, id), text + ' (kPa(g))', route + ' metric again');
        sys(app, 'imperial');
      }
      assert.deepEqual(app.consoleErrors(), []);
    },
  },
  {
    name: 'units labels: the unit group is rewritten, not the first parenthetical (orifice "Static (line) pressure")',
    wp: WP,
    run(app, assert) {
      go(app, 'orifice');
      assert.equal(label(app, 'op_P'), 'Static (line) pressure (psig)');
      sys(app, 'metric');
      assert.equal(label(app, 'op_P'), 'Static (line) pressure (kPa(g))');
      sys(app, 'imperial');
      assert.equal(label(app, 'op_P'), 'Static (line) pressure (psig)');
      // Direct: a known unit anywhere wins; with no unit group the first group is used (unchanged rule).
      const U = app.win.WTS_units, doc = app.document;
      const mk = (t) => { const l = doc.createElement('label'); l.textContent = t; return l; };
      sys(app, 'metric');
      const a = mk('Rate (net) (BPD)'); U._updateLabelText(a, 'liquidRate');
      assert.equal(String(a.textContent), 'Rate (net) (m³/d)');
      const b = mk('Depth (MD) (ft) note'); U._updateLabelText(b, 'length');
      assert.equal(String(b.textContent), 'Depth (MD) (m) note');
      const c = mk('Size (nominal)'); U._updateLabelText(c, 'length');
      assert.equal(String(c.textContent), 'Size (m)', 'no unit group → first group (legacy rule)');
      const d = mk('Line pressure'); U._updateLabelText(d, 'pressureG');
      assert.equal(String(d.textContent), 'Line pressure (kPa(g))', 'no group → appended');
      sys(app, 'imperial');
      U._updateLabelText(d, 'pressureG');
      assert.equal(String(d.textContent), 'Line pressure (psig)');
    },
  },
  {
    name: 'host _uFmt pages re-run the shown result on a unit flip (casing, bottoms up, solution GOR)',
    wp: WP,
    run(app, assert) {
      // Casing & Tubing: 4½" 9.5 lb/ft, ID 4.09" → 4.09²/1029.4 bbl/ft × 10,000 ft = 162.50 bbl
      go(app, 'casing');
      assert.equal(parseFloat(app.el('ct_cl').value), 10000, 'default casing length');
      calcBtn(app, 'calcCasing');
      const vBbl = 4.09 * 4.09 / 1029.4 * 10000;
      assert.near(num(rvText(app, 'ct_res', 'Total Volume')), vBbl, 0.06);
      assert.includes(rvText(app, 'ct_res', 'Total Volume'), 'bbls');
      sys(app, 'metric');
      assert.near(num(rvText(app, 'ct_res', 'Total Volume')), vBbl * BBL_M3, 0.01, 'metric volume after flip');
      assert.includes(rvText(app, 'ct_res', 'Total Volume'), 'm³');
      assert.near(num(rvText(app, 'ct_res', 'ID')), 4.09 * 25.4, 0.06, 'ID in mm after flip');
      sys(app, 'imperial');
      assert.includes(rvText(app, 'ct_res', 'Total Volume'), 'bbls', 'back to bbls');
      // Bottoms Up: 5000 BPD = 3.4722 bbl/min = 0.55204 m³/min
      go(app, 'bottomsup');
      calcBtn(app, 'calcBottomsUp');
      assert.near(num(rvText(app, 'bu_res', 'Flow Rate')), 5000 / 1440, 1e-4);
      sys(app, 'metric');
      assert.near(num(rvText(app, 'bu_res', 'Flow Rate')), 5000 / 1440 * BBL_M3, 6e-4);
      assert.includes(rvText(app, 'bu_res', 'Flow Rate'), 'm³');
      sys(app, 'imperial');
      // Solution GOR: result computed in Metric, then flipped → scf/stbbl (not sm³/sm³ next to psig inputs)
      go(app, 'solgor');
      sys(app, 'metric');
      calcBtn(app, 'calcSolGOR');
      const rsMet = num(rvText(app, 'sg_res', 'Rs (Standing)'));
      assert.includes(rvText(app, 'sg_res', 'Rs (Standing)'), 'sm³/sm³');
      sys(app, 'imperial');
      assert.includes(rvText(app, 'sg_res', 'Rs (Standing)'), 'scf/stbbl');
      // 1 sm³/sm³ = 0.158987294928 / 0.028316846592 = 5.6146 scf/STB
      assert.near(num(rvText(app, 'sg_res', 'Rs (Standing)')), rsMet * BBL_M3 / 0.028316846592, 0.06);
      assert.deepEqual(app.consoleErrors(), []);
    },
  },
  {
    name: 'PRV results in Metric: kPa(a) / kPa(g) / mm² (gas, liquid); imperial text unchanged; flip re-runs',
    wp: WP,
    run(app, assert) {
      // Gas defaults: Ps 250 psig, 10 % OP → P1 = 250·1.1 + 14.7 = 289.7 psia; Pb 30 psig → P2 = 44.7 psia;
      // Pcf = P1·(2/(k+1))^(k/(k−1)), k = 1.4 → 0.528282·289.7 = 153.04 psia
      go(app, 'prv');
      app.win.calcPRVgas(); app.flush(10);
      const P1 = 289.7, P2 = 44.7, Pcf = P1 * Math.pow(2 / 2.4, 1.4 / 0.4);
      assert.equal(rvText(app, 'pg_res', 'Relieving Pressure P₁'), '289.7 psia');
      const aIn2 = num(rvText(app, 'pg_res', 'Required Area A'));
      assert.includes(rvText(app, 'pg_res', 'Required Area A'), 'in²');
      assert.includes(rvText(app, 'pg_res', 'Selected API 526 Orifice'), 'L (2.853 in²)');
      sys(app, 'metric');
      assert.near(num(rvText(app, 'pg_res', 'Relieving Pressure P₁')), P1 * PSI_KPA, 1);
      assert.includes(rvText(app, 'pg_res', 'Relieving Pressure P₁'), 'kPa(a)');
      assert.near(num(rvText(app, 'pg_res', 'Back Pressure P₂')), P2 * PSI_KPA, 1);
      assert.near(num(rvText(app, 'pg_res', 'Critical Flow Pressure Pcf')), Pcf * PSI_KPA, 1);
      assert.near(num(rvText(app, 'pg_res', 'Required Area A')), aIn2 * IN2_MM2, 1);
      assert.includes(rvText(app, 'pg_res', 'Required Area A'), 'mm²');
      assert.includes(rvText(app, 'pg_res', 'Selected API 526 Orifice'), 'L (1,841 mm²)');   // 2.853 × 645.16 = 1840.6
      // Liquid, certified defaults: Ps 300 psig, Pb 30 psig, 10 % OP → P1 = 330 psig
      app.click('prvt3'); app.flush(10);
      app.win.calcPRVliquid(); app.flush(10);
      assert.near(num(rvText(app, 'pl_res', 'Relieving Pressure (P₁)')), 330 * PSI_KPA, 1);
      assert.includes(rvText(app, 'pl_res', 'Relieving Pressure (P₁)'), 'kPa(g)');
      assert.near(num(rvText(app, 'pl_res', 'Back Pressure (P₂)')), 30 * PSI_KPA, 1);
      assert.includes(rvText(app, 'pl_res', 'Required Area A'), 'mm²');
      sys(app, 'imperial');
      assert.equal(rvText(app, 'pl_res', 'Relieving Pressure (P₁)'), '330 psig');
      assert.includes(rvText(app, 'pl_res', 'Required Area A'), 'in²');
      assert.deepEqual(app.consoleErrors(), []);
    },
  },
  {
    name: 'Well Kill Metric: overbalance density and brine verdict carry kg/m³ (imperial text unchanged)',
    wp: WP,
    run(app, assert) {
      go(app, 'wellkill');
      const btn = app.el('wk_calc') || app.findAll('#pgBody button').find((b) => /calc/i.test(b.getAttribute('onclick') || b.id || ''));
      if (btn) { app.click(btn); app.flush(20); }
      const ob = rvText(app, 'wk_res', 'Overbalance as density');
      assert.match(ob, /^\d+\.\d\d ppg$/, 'imperial: ppg only');
      const verdictImp = app.findAll('#wk_res *').map((e) => String(e.textContent)).find((t) => /Clear brines that reach|No clear brine/.test(t) && t.length < 300);
      assert.ok(verdictImp && !/kg\/m³/.test(verdictImp), 'imperial verdict unchanged: ' + verdictImp);
      sys(app, 'metric');
      const obM = rvText(app, 'wk_res', 'Overbalance as density');
      // Metric overbalance is kg/L like the page's other densities (review-pvt-wellkill fix).
      assert.ok(/kg\/L/.test(obM) && !/ppg/.test(obM), 'metric overbalance: ' + obM);
      assert.near(parseFloat(obM), parseFloat(ob) * PPG_KGM3 / 1000, 0.002);
      const verdict = app.findAll('#wk_res *').map((e) => String(e.textContent)).find((t) => /Clear brines that reach|No clear brine/.test(t) && t.length < 300);
      assert.ok(verdict && /ppg \([\d,]+ kg\/m³\)/.test(verdict), 'metric brine verdict: ' + verdict);
      sys(app, 'imperial');
      assert.deepEqual(app.consoleErrors(), []);
    },
  },
];
