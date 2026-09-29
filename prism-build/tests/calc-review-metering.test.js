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

// Independent AGA-3 reference in SI mass-flow form (same method as calc-g1 agaRef): Standing +
// Wichert–Aziz pseudo-criticals on the ideal gravity, DAK Z by bisection, RG flange-tap Cd with Re
// iteration; v3.0 real base density ρb = Pb·M/(Zb·R·Tb) with Zb = DAK at the base, and the entered
// gravity taken as real: Gi = Gr·Zb/0.99959 (AGA-3 Part 3, Zb_air = 0.99959).
function dakZ(Tpr, Ppr) {
  const A = [0, 0.3265, -1.07, -0.5339, 0.01569, -0.05165, 0.5475, -0.7361, 0.1844, 0.1056, 0.6134, 0.7210];
  const Zof = (r) => 1 + (A[1] + A[2] / Tpr + A[3] / Tpr ** 3 + A[4] / Tpr ** 4 + A[5] / Tpr ** 5) * r
    + (A[6] + A[7] / Tpr + A[8] / Tpr ** 2) * r * r - A[9] * (A[7] / Tpr + A[8] / Tpr ** 2) * r ** 5
    + A[10] * (1 + A[11] * r * r) * (r * r / Tpr ** 3) * Math.exp(-A[11] * r * r);
  let lo = 1e-9, hi = 3;
  for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; if (Zof(m) - 0.27 * Ppr / (m * Tpr) > 0) hi = m; else lo = m; }
  return 0.27 * Ppr / (((lo + hi) / 2) * Tpr);
}
function agaRef(o) {
  const { D, d, hw, Ps, TfF, SG, co2 = 0, h2s = 0, TbF = 60, Pb = 14.696, mu = 0.012 } = o;
  const beta = d / D, b4 = beta ** 4, Ev = 1 / Math.sqrt(1 - b4);
  const Pf = Ps + 14.696, Tf = TfF + 459.67, Tb = TbF + 459.67;
  const A = (co2 + h2s) / 100, B2 = h2s / 100, eps = 120 * (A ** 0.9 - A ** 1.6) + 15 * (B2 ** 0.5 - B2 ** 4);
  const crit = (g) => { const Tpc = 168 + 325 * g - 12.5 * g * g, Ppc = 677 + 15 * g - 37.5 * g * g, T2 = Tpc - eps; return { T: T2, P: Ppc * T2 / (Tpc + B2 * (1 - B2) * eps) }; };
  let Gi = SG, c = crit(Gi), Zb = dakZ(Tb / c.T, Pb / c.P);
  for (let i = 0; i < 60; i++) { Gi = SG * Zb / 0.99959; c = crit(Gi); Zb = dakZ(Tb / c.T, Pb / c.P); }
  const Z = dakZ(Tf / c.T, Pf / c.P);
  const Y = 1 - (0.41 + 0.35 * b4) * hw / (27.707 * Pf) / 1.3;
  const dm = d * 0.0254, Dm = D * 0.0254, dP = hw * 248.84, M = 28.9625e-3 * Gi, R = 8.314462;
  const rho = Pf * 6894.757 * M / (Z * R * Tf * 5 / 9), rhob = Pb * 6894.757 * M / (Zb * R * Tb * 5 / 9);
  const L = 1 / D, M2 = 2 * L / (1 - beta), M1 = Math.max(2.8 - D, 0);
  let Re = 1e6, qm = 0;
  for (let i = 0; i < 60; i++) {
    const Aa = (19000 * beta / Re) ** 0.8, C = (1e6 / Re) ** 0.35;
    const Cd = 0.5961 + 0.0291 * beta ** 2 - 0.2290 * beta ** 8 + 0.003 * (1 - beta) * M1
      + (0.0433 + 0.0712 * Math.exp(-8.5 * L) - 0.1145 * Math.exp(-6 * L)) * (1 - 0.23 * Aa) * b4 / (1 - b4)
      - 0.0116 * (M2 - 0.52 * M2 ** 1.3) * beta ** 1.1 * (1 - 0.14 * Aa)
      + 0.000511 * (1e6 * beta / Re) ** 0.7 + (0.0210 + 0.0049 * Aa) * b4 * C;
    qm = Cd * Ev * Y * Math.PI / 4 * dm * dm * Math.sqrt(2 * rho * dP);
    Re = 4 * qm / (Math.PI * mu * 1e-3 * Dm);
  }
  return { Zb, mscfd: qm / rhob / 0.0283168466 * 3600 * 24 / 1000 };
}

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
      assert.rel(f().psl_target_psig, 1971 - hand(14.73, 519.67) - 5, 1e-9, 'PSL = Pflow − ΔP − margin');
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
      // Standard volume at basis b = mass / ρb, ρb = Pb·M/(Zb·R·Tb): the ideal-gas Pb/Tb scaling times
      // the real-gas Zb effect (v3.0: was exactly Pb/Tb with Zb = 1). Ratio from the independent reference.
      const vf = (14.696 / ATM) * (518.67 / 519.67);
      const g0 = { D: 4.026, d: r0.d, Ps: 500, TfF: 80, SG: 0.65, co2: 0.5 };
      const refRatio = (hw) => agaRef(Object.assign({ hw, TbF: 59, Pb: canon(app, 'op_Pb') }, g0)).mscfd / agaRef(Object.assign({ hw, TbF: 60, Pb: 14.696 }, g0)).mscfd;
      assert.rel(r1.qLo / r0.qLo, refRatio(40), 2e-5, 'rate at low % scales by the real-gas base ratio');
      assert.rel(r1.qHi / r0.qHi, refRatio(160), 2e-5, 'rate at high % scales by the real-gas base ratio');
      assert.ok(Math.abs(r1.qLo / r0.qLo / vf - 1) < 2e-4, 'within 0.02 % of the ideal-gas Pb/Tb ratio');
      // Same basis → same rate as the AGA-3 page engine at that plate and differential.
      const aga = app.win.WTS_aga3_compute(app.toWin({ D: 4.026, d: r1.d, hw: 200 * 0.2, Ps: 500, TfF: 80, SG: 0.65, sgBasis: 'real', co2: 0.5, h2s: 0, TbF: 59, Pb: canon(app, 'op_Pb') }));
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
      // v3.0: Fpv = √(Zb/Zf) — independent reference 3,792.6 MSCFD (was 3,800.65 with Zb = 1)
      assert.rel(q, agaRef({ D: 4, d: 2, hw: 50, Ps: 500, TfF: 100, SG: 0.75, TbF: 60, Pb: 14.73 }).mscfd, 5e-4, 'reference with Zb');
    },
  },
];
