// Review of the metering batch (AGA-3 engine, Oil & Gas, Orifice Plate
// Selection, P7 standard-conditions setting) — one regression test per
// confirmed defect. Expected values are independent hand calculations
// (ideal-gas mole balance, exact unit factors), not the code under test.
//
//   1. ESD lo-pilot ΔP ignored the base TEMPERATURE of the scf basis
//      (0 °C basis read 5.4 % low).
//   2. Base (standard) pressure showed 101.3 kPa for 101.325 kPa in Metric
//      (generic ≥ 100 → 1 dp rule) on AGA-3, Flare Emissions and Orifice.
//   3. Orifice Plate Selection ignored the header Std setting (AGA-3 page
//      followed it, so the two AGA-3 pages disagreed).
//   4. Orifice verdict blamed the meter run size when the only problem was a
//      window narrower than the 0.125" plate step.
//   5. Oil & Gas "How it works" stated a fixed 60 °F / 14.73 psia basis.
'use strict';

const WP = 'REVIEW-METER';
const ATM = 101.325 / 6.894757293168;   // psia (101.325 kPa, exact psi definition)
const B = (app) => app.win.WTS_baseConditions;
const setBase = (app, key) => { B(app).set(key); app.flush(40); };
const shownText = (app, id) => String(app.win.WTS_units.displayValue(app.el(id)));
const labelOf = (app, id) => { const e = app.el(id); const it = e && e.parentNode; const l = it && it.querySelector('label'); return l ? String(l.textContent) : ''; };
const S = (app) => app.win.WTS_state.orifice;
const canon = (app, id) => app.win.WTS_units.runCanonical(() => parseFloat(app.el(id).value));

module.exports = [
  {
    name: 'REVIEW esdlo: ΔP = V_std·Pb/V·(519.67/Tb) — default unchanged, 15 °C and 0 °C bases scale by the mole ratio',
    wp: WP,
    run(app, assert) {
      const IN = { sectionVolume_ft3: 4.36, sectionFlowingPressure_psig: 1971, detectableLeakRate_MMscfd: 0.05,
        whsip_psig: 1500, esdResponseTime_s: 5, safetyMargin_psig: 5 };
      // Hand calc: released = 0.05e6 scf/d / 86400 · 5 s = 2.893519 scf.
      const scf = 0.05e6 / 86400 * 5;
      const hand = (Pb, TbR) => scf * Pb / 4.36 * (519.67 / TbR);   // section gas at 60 °F
      const f = () => app.win.WTS_esdLoPilot_compute(app.toWin(IN));
      assert.rel(f().pressureDrop_psi, 9.755670, 1e-6, 'default basis 60 °F / 14.7 psia (unchanged)');
      assert.rel(f().pressureDrop_psi, hand(14.7, 519.67), 1e-12);
      setBase(app, '15C_101.325');
      assert.rel(f().pressureDrop_psi, hand(ATM, 518.67), 1e-9, '15 °C / 101.325 kPa');
      setBase(app, '0C_101.325');
      assert.rel(f().pressureDrop_psi, hand(ATM, 491.67), 1e-9, '0 °C / 101.325 kPa (was 9.7530, 5.4 % low)');
      assert.rel(f().pressureDrop_psi, 10.308402, 1e-6);
      setBase(app, '60F_14.73');
      assert.rel(f().pressureDrop_psi, hand(14.73, 519.67), 1e-9, '60 °F / 14.73 psia');
      // Consistent with the hi-pilot page (which already applied Tb): both are pure mole balances.
      // v3.0 trip criterion: recommended PSL = Pflow − false-trip margin (was Pflow − ΔP − margin
      // = 1956.22 psig, a setting the leak does not reach within the window); the time to reach
      // it is margin / (dP/dt) = 5 / (ΔP/5 s).
      assert.rel(f().psl_target_psig, 1971 - 5, 1e-12, 'PSL = Pflow − margin');
      assert.rel(f().timeToTrip_s, 5 / (hand(14.73, 519.67) / 5), 1e-9, 't_trip = margin / rate');
    },
  },
  {
    name: 'REVIEW base pressure display: 101.325 kPa shows as 101.325 (not 101.3) on AGA-3, Flare Emissions and Orifice; labels keep psia',
    wp: WP,
    run(app, assert) {
      app.hook.nav('aga3'); app.flush(40);
      assert.match(labelOf(app, 'a_Pb'), /\(psia\)/, 'imperial label keeps psia');
      assert.strictEqual(app.el('a_Pb').value, '14.696');
      setBase(app, '15C_101.325');
      app.win.WTS_units.setSystem('metric'); app.flush(40);
      try {
        for (const [route, id] of [['aga3', 'a_Pb'], ['flareghg', 'fe_pbase'], ['orifice', 'op_Pb']]) {
          app.hook.nav(route); app.flush(40);
          assert.strictEqual(shownText(app, id), '101.325', route + ' shows 101.325 kPa');
          assert.match(labelOf(app, id), /\(kPa\)/, route + ' label kPa');
          assert.rel(canon(app, id), ATM, 1e-6, route + ' canonical psia');
        }
        // 14.73 psia × 6.89476 = 101.5598 kPa → 3 dp
        setBase(app, '60F_14.73');
        app.hook.nav('aga3'); app.flush(40);
        assert.strictEqual(shownText(app, 'a_Pb'), '101.56');
        assert.near(canon(app, 'a_Pb'), 14.73, 1e-9, 'memo keeps the exact canonical value');
        // A metric user typing the standard atmosphere gets 14.6959 psia, not 14.692.
        app.input('a_Pb', '101.325');
        assert.near(canon(app, 'a_Pb'), 101.325 / 6.89476, 1e-9);
      } finally { app.win.WTS_units.setSystem('imperial'); }
      assert.deepEqual(app.consoleErrors(), []);
    },
  },
  {
    name: 'REVIEW orifice follows the Std setting like the AGA-3 page; rates scale by exactly Pb/Tb; typed basis kept; default unchanged',
    wp: WP,
    run(app, assert) {
      app.hook.nav('orifice'); app.flush(40);
      assert.strictEqual(app.el('op_Tb').value, '60');
      assert.strictEqual(app.el('op_Pb').value, '14.696');
      app.click('op_calc');
      const r0 = JSON.parse(JSON.stringify(S(app)));
      // "Calculator default" = the page's own 60 °F / 14.696 psia (identical to the pure compute).
      const pure = app.win.WTS_orifice_compute(app.toWin({ q: 5000, D: 4.026, Ps: 500, TfF: 80, SG: 0.65, co2: 0.5, n2: 1, h2s: 0, urv: 200 }));
      assert.strictEqual(r0.qLo, pure.chosen.qLo, 'default basis unchanged');
      // Setting chosen while the result is on screen: fields follow and the page re-runs.
      setBase(app, '15C_101.325');
      assert.near(canon(app, 'op_Tb'), 59, 1e-9);
      assert.rel(canon(app, 'op_Pb'), ATM, 1e-7);
      const r1 = S(app);
      assert.ok(r1.ts !== undefined && r1.qLo !== r0.qLo, 're-ran on the new basis');
      // Standard volume at basis b ∝ Tb/Pb for the same mass (Re_D depends on Qv·Pb/Tb only).
      const vf = (14.696 / ATM) * (518.67 / 519.67);
      // (the base field holds Pb to 9 significant digits: 14.6959488 psia)
      assert.rel(r1.qLo / r0.qLo, vf, 1e-8, 'rate at low % scales by Pb/Tb');
      assert.rel(r1.qHi / r0.qHi, vf, 1e-8, 'rate at high % scales by Pb/Tb');
      // Same basis → same rate as the AGA-3 page engine at that plate and differential.
      const aga = app.win.WTS_aga3_compute(app.toWin({ D: 4.026, d: r1.d, hw: 200 * 0.2, Ps: 500, TfF: 80, SG: 0.65, co2: 0.5, h2s: 0, TbF: 59, Pb: canon(app, 'op_Pb') }));
      assert.rel(r1.qLo, aga.Qmscfd, 1e-9, 'orifice = AGA-3 engine on the 15 °C basis');
      // A typed contract basis is the user's.
      app.input('op_Pb', '15.025'); app.click('op_calc');
      setBase(app, '60F_14.65');
      assert.strictEqual(app.el('op_Pb').value, '15.025');
      assert.deepEqual(app.consoleErrors(), []);
    },
  },
  {
    name: 'REVIEW orifice verdict: a window narrower than the plate step is reported as such, not as a meter-run problem',
    wp: WP,
    run(app, assert) {
      const r = app.win.WTS_orifice_compute(app.toWin({ q: 5000, D: 4.026, Ps: 500, TfF: 80, SG: 0.65, co2: 0.5, n2: 1, h2s: 0,
        urv: 200, lo: 49, hi: 51, des: 50 }));
      assert.ok(r.ok && !r.inWindow, 'no plate inside 49–51 %');
      assert.ok(r.dStar > 0.1 * 4.026 && r.dStar < 0.75 * 4.026, 'exact bore exists within β limits');
      // Independent check: no 0.125" plate within ±1 % of the design DP (bores step 0.125" around d* ≈ 1.861").
      r.candidates.forEach((c) => assert.ok(!(c.pct >= 49 && c.pct <= 51), c.bore + ' outside window'));
      const t = r.verdicts.map((v) => v.text).join(' ');
      assert.includes(t, 'widen the window');
      assert.ok(!/meter run/.test(t), 'does not blame the meter run: ' + t);
      assert.ok(t.length < 300, 'verdict under 300 characters');
      // Genuine β-limit cases keep their advice.
      const hi = app.win.WTS_orifice_compute(app.toWin({ q: 60000, D: 4.026, Ps: 500, TfF: 80, SG: 0.65, urv: 200 }));
      assert.ok(hi.ok && !hi.inWindow && hi.dStarFlag === 'high');
      assert.includes(hi.verdicts[0].text, 'larger meter run');
    },
  },
  {
    name: 'REVIEW oilgas: the How-it-works text names the Std setting; calculator default still = AGA-3 at 60 °F / 14.73 psia',
    wp: WP,
    run(app, assert) {
      app.hook.nav('oilgas'); app.flush(40);
      const info = String(app.el('pgBody').textContent);
      assert.includes(info, 'the header "Std" setting');
      app.win.calcOilGas();
      const row = app.findAll('#og_res .rrow').find((x) => String(x.querySelector('.rl').textContent).trim() === 'Gas Rate');
      const q = parseFloat(String(row.querySelector('.rv').textContent).replace(/,/g, ''));
      const g = app.win.WTS_aga3_compute(app.toWin({ D: 4, d: 2, hw: 50, Ps: 500, TfF: 100, SG: 0.75, co2: 0, h2s: 0, TbF: 60, Pb: 14.73, tap: 'flange' }));
      assert.near(q, g.Qmscfd, 0.0006, 'default basis 60 °F / 14.73 psia');
    },
  },
];
