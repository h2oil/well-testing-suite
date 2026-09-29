// P7 — global standard (base) conditions + Round-5 units manifests.
//
//   • WTS_baseConditions (prism-build/22-units.js): get / set / resolve, the
//     header "Std" selector, the wts:base-conditions-changed event, the
//     wts_base_conditions key in project files.
//   • Every gas-volume calculator follows the setting by the exact Pb / Tb
//     ratio (AGA-3 and Flare Emissions through their base fields, Oil & Gas
//     orifice gas, gas FVF, dual choke gas, H2S safety, ESD hi / lo pilot,
//     pipe-life velocity); the default ("calculator default") leaves every
//     result as it was.
//   • Round-5 pages (esdhi, esdlo, hydrate, liquidline, pipelife): inputs are
//     tagged, results display in metric, and the same physical case typed in
//     metric gives the same physical answer.
'use strict';

const WP = 'P7';

function rows(app, resId) {
  return app.findAll('#' + resId + ' .rrow').map((r) => {
    const l = r.querySelector('.rl'), v = r.querySelector('.rv');
    return { l: String(l ? l.textContent : '').trim(), v: String(v ? v.textContent : '').trim() };
  });
}
function num(s) {
  const m = String(s).replace(/,/g, '').match(/-?\d+(\.\d+)?(e[-+]?\d+)?/i);
  if (!m) throw new Error('no number in: ' + s);
  return parseFloat(m[0]);
}
function rvText(app, resId, label) {
  const r = rows(app, resId).find((x) => x.l.indexOf(label) === 0);
  if (!r) throw new Error('no result row "' + label + '" in #' + resId + ': ' + JSON.stringify(rows(app, resId)).slice(0, 400));
  return r.v;
}
const rv = (app, resId, label) => num(rvText(app, resId, label));
function trow(app, rootId, first) {
  const tr = app.findAll('#' + rootId + ' tr').find((r) => {
    const c = r.querySelector('td'); return c && String(c.textContent).trim().indexOf(first) === 0;
  });
  if (!tr) throw new Error('no table row "' + first + '" in #' + rootId);
  return Array.prototype.map.call(tr.querySelectorAll('td'), (c) => String(c.textContent).trim());
}
function set(app, vals) { for (const k of Object.keys(vals)) app.input(k, String(vals[k])); }
const B = (app) => app.win.WTS_baseConditions;
const setBase = (app, key) => { B(app).set(key); app.flush(40); };
const setMetric = (app, on) => app.win.WTS_units.setSystem(on ? 'metric' : 'imperial');
// Metric text of an imperial value, with the units layer's own factors.
const met = (app, v, cat) => String(app.win.WTS_units.convertCategory(v, cat, 'imperial', 'metric'));
const shown = (app, id) => parseFloat(app.win.WTS_units.displayValue(app.el(id)));
const label = (app, id) => { const e = app.el(id); const it = e && e.parentNode; const l = it && it.querySelector('label'); return l ? String(l.textContent) : ''; };
const ATM = 101.325 / 6.894757293168;          // 14.6959488 psia
// scf at basis a → scf at basis b
const vf = (a, b) => (a.P / b.P) * ((b.T + 459.67) / (a.T + 459.67));
// v3.0 AGA-3 (Fpv = √(Zb/Zf), real gravity): the orifice passes the same MASS at a given hw, so the
// standard volume is m/ρb, ρb = Pb·M/(Zb·R·Tb), and m ∝ √(ρf) ∝ √(Gi/Zf). With a real gravity Gr entered,
// Gi = Gr·Zb/0.99959 (AGA-3 Part 3) depends on the base, so Qb ∝ Zb·Tb/(Pb·√(Gi·Zf)). Independent DAK
// (bisection) on Standing + Wichert–Aziz pseudo-criticals.
function dakZ(Tpr, Ppr) {
  const A = [0, 0.3265, -1.07, -0.5339, 0.01569, -0.05165, 0.5475, -0.7361, 0.1844, 0.1056, 0.6134, 0.7210];
  const Zof = (r) => 1 + (A[1] + A[2] / Tpr + A[3] / Tpr ** 3 + A[4] / Tpr ** 4 + A[5] / Tpr ** 5) * r
    + (A[6] + A[7] / Tpr + A[8] / Tpr ** 2) * r * r - A[9] * (A[7] / Tpr + A[8] / Tpr ** 2) * r ** 5
    + A[10] * (1 + A[11] * r * r) * (r * r / Tpr ** 3) * Math.exp(-A[11] * r * r);
  let lo = 1e-9, hi = 3;
  for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; if (Zof(m) - 0.27 * Ppr / (m * Tpr) > 0) hi = m; else lo = m; }
  return 0.27 * Ppr / (((lo + hi) / 2) * Tpr);
}
function qbRel(b, g) {   // relative standard volume at basis b for gas g {SG, co2, h2s, Pf, TfF}
  const A = (g.co2 + g.h2s) / 100, Bh = g.h2s / 100, eps = 120 * (A ** 0.9 - A ** 1.6) + 15 * (Bh ** 0.5 - Bh ** 4);
  const crit = (s) => { const T = 168 + 325 * s - 12.5 * s * s, P = 677 + 15 * s - 37.5 * s * s, T2 = T - eps; return { T: T2, P: P * T2 / (T + Bh * (1 - Bh) * eps) }; };
  const Tb = b.T + 459.67;
  let Gi = g.SG, c = crit(Gi), Zb = dakZ(Tb / c.T, b.P / c.P);
  for (let i = 0; i < 60; i++) { Gi = g.SG * Zb / 0.99959; c = crit(Gi); Zb = dakZ(Tb / c.T, b.P / c.P); }
  const Zf = dakZ((g.TfF + 459.67) / c.T, g.Pf / c.P);
  return Zb * Tb / (b.P * Math.sqrt(Gi * Zf));
}
const vfReal = (a, b, g) => qbRel(b, g) / qbRel(a, g);
const GAS_AGA = { SG: 0.65, co2: 0.5, h2s: 0, Pf: 514.696, TfF: 80 };   // AGA-3 page defaults
const GAS_OG = { SG: 0.75, co2: 0, h2s: 0, Pf: 514.696, TfF: 100 };     // Oil & Gas page defaults

module.exports = [
  // ── The setting itself ───────────────────────────────────────────────
  {
    name: 'P7 base API: default = calculator default; set() persists, fires the event, drives the header selector and travels in project files',
    wp: WP,
    run(app, assert) {
      app.flush(50);
      const bc = B(app);
      assert.ok(bc && typeof bc.get === 'function' && typeof bc.set === 'function', 'WTS_baseConditions');
      assert.strictEqual(bc.get().key, 'calc');
      assert.strictEqual(bc.isSet(), false);
      const r0 = bc.resolve(60, 14.73);
      assert.ok(r0.Pb_psia === 14.73 && r0.Tb_R === 519.67 && !r0.fromSetting, 'calculator default kept');
      const seen = [];
      app.document.addEventListener('wts:base-conditions-changed', (e) => seen.push(e.detail.key));
      assert.ok(bc.set('15C_101.325'));
      assert.deepEqual(seen, ['15C_101.325']);
      assert.strictEqual(app.storage.getItem('wts_base_conditions'), '15C_101.325');
      const g = bc.get();
      assert.near(g.Tb_F, 59, 1e-12); assert.near(g.Tb_C, 15, 1e-12);
      assert.near(g.Pb_kPa, 101.325, 1e-9); assert.near(g.Pb_psia, ATM, 1e-9);
      const r1 = bc.resolve(60, 14.73);
      assert.ok(r1.fromSetting && r1.label === '15 °C / 101.325 kPa', JSON.stringify(r1));
      assert.near(bc.molarVolume({ Tb_F: 60, Pb_psia: 14.696 }), 379.48, 0.01);
      // Header selector (inside the unit toggle)
      const sel = app.el('wts_base_select');
      assert.ok(sel, 'header selector mounted');
      assert.strictEqual(sel.value, '15C_101.325');
      app.select('wts_base_select', '60F_14.65');
      assert.strictEqual(bc.get().key, '60F_14.65');
      assert.deepEqual(seen, ['15C_101.325', '60F_14.65']);
      // Unknown keys are refused; same key = no event
      assert.strictEqual(bc.set('nope'), false);
      bc.set('60F_14.65');
      assert.strictEqual(seen.length, 2);
      // Project file carries the key (wts_* storage module)
      const payload = JSON.stringify(app.win.WTS_project._buildPayload());
      assert.includes(payload, 'wts_base_conditions');
      // Back to calculator default removes the key
      bc.set('calc');
      assert.strictEqual(app.storage.getItem('wts_base_conditions'), null);
      assert.strictEqual(sel.value, 'calc');
      assert.deepEqual(app.consoleErrors(), []);
    },
  },

  // ── AGA-3: base fields follow the setting unless overridden ──────────
  {
    name: 'P7 aga3: Tb/Pb default from the setting; rate scales by the real-gas base ratio (Pb/Tb × Zb, v3.0); user override kept; shown result re-runs',
    wp: WP,
    run(app, assert) {
      app.hook.nav('aga3'); app.flush(50);
      assert.strictEqual(app.el('a_Pb').value, '14.696');
      app.win.calcAGA3();
      const q0 = rv(app, 'a_res', 'Gas Rate (SCF/hr)');
      app.hook.nav('home'); setBase(app, '60F_14.73'); app.hook.nav('aga3'); app.flush(50);
      assert.near(parseFloat(app.el('a_Pb').value), 14.73, 1e-12);
      assert.near(parseFloat(app.el('a_Tb').value), 60, 1e-12);
      app.win.calcAGA3();
      const q1 = rv(app, 'a_res', 'Gas Rate (SCF/hr)');
      assert.rel(q1 / q0, vfReal({ T: 60, P: 14.696 }, { T: 60, P: 14.73 }, GAS_AGA), 2e-6, '14.73 psia basis');
      assert.rel(q1 / q0, 14.696 / 14.73, 1e-5, 'within 0.001 % of the ideal-gas ratio');
      // Setting changed while the result is on screen: fields follow and it re-runs.
      setBase(app, '15C_101.325');
      assert.near(parseFloat(app.el('a_Tb').value), 59, 1e-9);
      assert.near(parseFloat(app.el('a_Pb').value), ATM, 1e-6);
      const q2 = rv(app, 'a_res', 'Gas Rate (SCF/hr)');
      assert.rel(q2 / q0, vfReal({ T: 60, P: 14.696 }, { T: 59, P: ATM }, GAS_AGA), 2e-6, '15 °C / 101.325 kPa basis');
      // A typed contract basis is the user's: the setting no longer moves it.
      app.input('a_Pb', '15.025');
      setBase(app, '60F_14.65');
      assert.strictEqual(app.el('a_Pb').value, '15.025');
      assert.near(parseFloat(app.el('a_Tb').value), 59, 1e-9);
      // Survives a revisit too.
      app.hook.nav('home'); app.hook.nav('aga3'); app.flush(50);
      assert.strictEqual(app.el('a_Pb').value, '15.025');
      assert.deepEqual(app.consoleErrors(), []);
    },
  },
  {
    name: 'P7 aga3 metric: basis fields show °C / kPa and still read canonical °F / psia',
    wp: WP,
    run(app, assert) {
      setMetric(app, true); setBase(app, '15C_101.325');
      app.hook.nav('aga3'); app.flush(50);
      assert.near(shown(app, 'a_Tb'), 15, 1e-3);
      assert.near(shown(app, 'a_Pb'), 101.325, 1e-9);
      app.win.WTS_units.runCanonical(() => {
        assert.near(parseFloat(app.el('a_Tb').value), 59, 1e-9);
        assert.near(parseFloat(app.el('a_Pb').value), ATM, 1e-6);
      });
      app.win.calcAGA3();
      assert.includes(app.el('a_res').textContent, 'Sm');
    },
  },

  // ── Host gas-volume calculators ──────────────────────────────────────
  {
    name: 'P7 oilgas: orifice gas rate follows the basis (14.73 psia default → 14.65 psia = ×14.73/14.65); GOR follows; basis row shown',
    wp: WP,
    run(app, assert) {
      app.hook.nav('oilgas'); app.flush(20);
      app.win.calcOilGas();
      const g0 = rv(app, 'og_res', 'Gas Rate'), gor0 = rv(app, 'og_res', 'GOR');
      assert.includes(rvText(app, 'og_res', 'Gas volume basis'), '60 °F / 14.73 psia');
      setBase(app, '60F_14.65');                     // re-runs the shown result
      const g1 = rv(app, 'og_res', 'Gas Rate'), gor1 = rv(app, 'og_res', 'GOR');
      assert.rel(g1 / g0, vfReal({ T: 60, P: 14.73 }, { T: 60, P: 14.65 }, GAS_OG), 2e-4);
      assert.rel(g1 / g0, 14.73 / 14.65, 2e-4, 'still ≈ ×14.73/14.65');
      assert.rel(gor1 / gor0, 14.73 / 14.65, 2e-3);
      assert.includes(rvText(app, 'og_res', 'Gas volume basis'), '60 °F / 14.65 psia');
      setBase(app, '0C_101.325');
      assert.rel(rv(app, 'og_res', 'Gas Rate') / g0, vfReal({ T: 60, P: 14.73 }, { T: 32, P: ATM }, GAS_OG), 2e-4);
    },
  },
  {
    name: 'P7 gascalc: Bg uses Pb/Tb of the setting (default 0.02833); ratio between settings is exact',
    wp: WP,
    run(app, assert) {
      app.hook.nav('gascalc'); app.flush(20);
      set(app, { gv_z: 1, gv_t: 60, gv_p: 14.7, gv_q: 1000, gv_d: 2 });
      app.win.calcGasVel();
      assert.near(rv(app, 'gv_res', 'Bg'), 0.02833 * 520 / 14.7, 2e-6);
      setBase(app, '60F_14.73');
      const b73 = rv(app, 'gv_res', 'Bg');
      assert.near(b73, 14.73 / 519.67 * 520 / 14.7, 2e-6);
      setBase(app, '60F_14.65');
      assert.rel(rv(app, 'gv_res', 'Bg') / b73, 14.65 / 14.73, 2e-6);
      assert.includes(rvText(app, 'gv_res', 'Gas volume basis'), '14.65 psia');
    },
  },
  {
    name: 'P7 dual choke gas: Thornhill-Craver rate re-referred from 60 °F / 14.7 psia to the setting',
    wp: WP,
    run(app, assert) {
      app.hook.nav('choke'); app.flush(20);
      app.win.calcChoke();
      const q0 = rv(app, 'c_res', 'Gas Rate'), p2 = rv(app, 'c_res', 'Intermediate Pressure');
      setBase(app, '60F_14.65');
      assert.rel(rv(app, 'c_res', 'Gas Rate') / q0, 14.7 / 14.65, 1e-4);
      assert.near(rv(app, 'c_res', 'Intermediate Pressure'), p2, 1e-9, 'P2 does not depend on the basis');
      assert.includes(app.el('c_res').textContent, '60 °F / 14.65 psia');
    },
  },

  // ── Plug-in calculators ──────────────────────────────────────────────
  {
    name: 'P7 flareghg: base fields follow the setting → moles / CO2 scale by Pb/Tb; volume basis in the Notes',
    wp: WP,
    run(app, assert) {
      app.hook.nav('flareghg'); app.flush(50);
      app.win.calcFlareGHG();
      const c0 = app.win.WTS_state.flareghg.co2_t;
      setBase(app, '15C_101.325');
      assert.near(parseFloat(app.el('fe_tb').value), 59, 1e-9);
      assert.near(parseFloat(app.el('fe_pbase').value), ATM, 1e-6);
      const c1 = app.win.WTS_state.flareghg.co2_t;
      assert.rel(c1 / c0, (ATM / 14.696) * (519.67 / 518.67), 1e-6);
      assert.includes(app.el('fe_res').textContent, '15 °C / 101.325 kPa');
    },
  },
  {
    name: 'P7 h2sroe: moles from the setting\'s molar volume; ROE escape rate re-referred to 14.65 psia; gasdeliv states the basis',
    wp: WP,
    run(app, assert) {
      const so2 = (q) => app.win.WTS_h2s_so2(q, 1000, 98).so2_lbhr;
      const roe = (q) => app.win.WTS_h2s_roe(q, 1000).x100_ft;
      const s0 = so2(10), x0 = roe(10);
      setBase(app, '60F_14.73');
      assert.rel(so2(10) / s0, 14.73 / 14.696, 1e-5);
      assert.rel(roe(10) / x0, Math.pow(14.73 / 14.65, 0.6258), 1e-9);
      assert.rel(app.win.WTS_h2s_scavenger(10, 100, 4, 1.5).gr_in / (100 * 0.062867), 14.73 / 14.696, 1e-4);
      app.hook.nav('h2sroe'); app.flush(50); app.win.calcH2S();
      assert.includes(app.el('hs_roe_res').textContent, '60 °F / 14.73 psia (app setting');
      app.hook.nav('gasdeliv'); app.flush(50); app.win.calcGasDeliv();
      assert.includes(app.el('gd_res').textContent, 'standard volumes at 60 °F / 14.73 psia');
    },
  },

  // ── Round-5 pages: basis + metric parity ─────────────────────────────
  {
    name: 'P7 esdhi: t_fill scales with the scf basis; metric-typed case = imperial case; results in m³ / kPa(g) / Sm³',
    wp: WP,
    run(app, assert) {
      const IN = { sectionVolume_ft3: 292, sectionGasTemp_F: 23, gasFlowRate_MMscfd: 1, gasSG: 0.78,
        esdResponseTime_s: 5, hiPilotSetting_psig: 130, rdSetting_psig: 135, mawp_psig: 125 };
      const ref = app.win.WTS_esdHiPilot_compute(app.toWin(IN));
      setBase(app, '60F_14.65');
      assert.rel(app.win.WTS_esdHiPilot_compute(app.toWin(IN)).timeToReachRV_s / ref.timeToReachRV_s, 14.7 / 14.65, 1e-12);
      setBase(app, 'calc');
      // Metric page, same physical case typed in SI
      setMetric(app, true); app.hook.nav('esdhi'); app.flush(20);
      assert.includes(label(app, 'wts_esdhi_volume'), 'm³');
      assert.includes(label(app, 'wts_esdhi_hp'), 'kPa');
      set(app, { wts_esdhi_volume: met(app, 292, 'volumeFt3'), wts_esdhi_temp: met(app, 23, 'temperature'),
        wts_esdhi_q: met(app, 1, 'gasRate'), wts_esdhi_sg: 0.78, wts_esdhi_tresp: 5,
        wts_esdhi_hp: met(app, 130, 'pressureG'), wts_esdhi_rd: met(app, 135, 'pressureG'), wts_esdhi_mawp: met(app, 125, 'pressureG') });
      app.click('wts_esdhi_calc');
      const r = app.win.WTS_state.esdHiPilot;
      assert.rel(r.timeToReachRV_s, ref.timeToReachRV_s, 1e-9);
      assert.rel(r.inventoryAtHiPilot_scf, ref.inventoryAtHiPilot_scf, 1e-9);
      const cell = (l) => trow(app, 'wts_esdhi_results', l)[1];
      assert.includes(cell('Inventory @ Hi-Pilot'), 'Sm³');
      assert.near(num(cell('Gas released')), ref.gasReleasedToAtmosphere_scf * 0.028316846592, 1);
      assert.includes(cell('Hi-Pilot Setting'), 'kPa');
      assert.near(num(cell('Hi-Pilot Setting')), 130 * 6.89476, 1);
      assert.includes(cell('Section Volume'), 'm³');
      // Flip back: the page re-runs in imperial with the same answer.
      setMetric(app, false); app.flush(10);
      assert.includes(cell('Inventory @ Hi-Pilot'), 'scf');
      assert.rel(app.win.WTS_state.esdHiPilot.timeToReachRV_s, ref.timeToReachRV_s, 1e-9);
      assert.near(parseFloat(app.el('wts_esdhi_volume').value), 292, 1e-6);
      assert.deepEqual(app.consoleErrors(), []);
    },
  },
  {
    name: 'P7 esdlo: ΔP ∝ standard pressure; metric-typed case = imperial case; kPa results',
    wp: WP,
    run(app, assert) {
      const IN = { sectionVolume_ft3: 4.36, sectionFlowingPressure_psig: 1971, detectableLeakRate_MMscfd: 0.05,
        whsip_psig: 1500, esdResponseTime_s: 5, safetyMargin_psig: 5 };
      const ref = app.win.WTS_esdLoPilot_compute(app.toWin(IN));
      setBase(app, '0C_101.325');
      // Ideal gas: moles per scf ∝ Pb/Tb, so ΔP scales by (Pb/Tb)/(14.7/519.67)
      // (review-metering fix: Tb was ignored).
      assert.rel(app.win.WTS_esdLoPilot_compute(app.toWin(IN)).pressureDrop_psi / ref.pressureDrop_psi, (ATM / 491.67) / (14.7 / 519.67), 1e-12);
      setBase(app, 'calc');
      setMetric(app, true); app.hook.nav('esdlo'); app.flush(20);
      set(app, { wts_esdlo_volume: met(app, 4.36, 'volumeFt3'), wts_esdlo_pflow: met(app, 1971, 'pressureG'),
        wts_esdlo_qleak: met(app, 0.05, 'gasRate'), wts_esdlo_whsip: met(app, 1500, 'pressureG'),
        wts_esdlo_tresp: 5, wts_esdlo_margin: met(app, 5, 'pressure') });
      app.click('wts_esdlo_calc_btn');
      const r = app.win.WTS_state.esdLoPilot;
      assert.rel(r.pressureDrop_psi, ref.pressureDrop_psi, 1e-9);
      assert.rel(r.psl_target_psig, ref.psl_target_psig, 1e-9);
      assert.near(num(trow(app, 'wts_esdlo_results', 'Pressure drop')[1]), ref.pressureDrop_psi * 6.89476, 0.01);
      assert.includes(trow(app, 'wts_esdlo_results', 'Pressure drop')[1], 'kPa');
      const psl = rows(app, 'wts_esdlo_results').find((x) => x.l.indexOf('Recommended PSL') === 0);
      assert.near(num(psl.v), ref.psl_target_psig * 6.89476, 0.6);
      assert.includes(psl.v, 'kPa');
      assert.includes(app.el('wts_esdlo_status').textContent, 'kPa');
    },
  },
  {
    name: 'P7 hydrate: inputs tagged (kPa(g), °C, m³/d, Δ°C); metric-typed case gives the same T_hyd / ΔT (shown in °C)',
    wp: WP,
    run(app, assert) {
      setMetric(app, true); app.hook.nav('hydrate'); app.flush(20);
      assert.includes(label(app, 'hy_dn_P_1'), 'kPa');
      assert.includes(label(app, 'hy_dn_T_1'), '°C');
      assert.includes(label(app, 'wts_hydrate_qw'), 'm³/d');
      assert.near(shown(app, 'hy_dn_P_1'), 885 * 6.89476, 0.06);
      set(app, { wts_hydrate_sg: 0.65, wts_hydrate_qw: met(app, 400, 'liquidRate'), wts_hydrate_safety: met(app, 5, 'tempDelta'),
        hy_dn_P_1: met(app, 885, 'pressureG'), hy_dn_T_1: met(app, 41, 'temperature') });
      for (let i = 0; i < 4; i++) set(app, { ['wts_hydrate_inj_' + i]: 0 });
      app.click('wts_hydrate_run');
      const P = 885 + 14.696, a = Math.log(P), b = Math.log(0.65);
      const TH = 13.47 * a + 34.27 * b - 1.675 * a * b - 20.35;
      const dT = TH - (41 - 5);
      const r = trow(app, 'wts_hydrate_summary', 'WH Choke → Heater Inlet');
      assert.near(num(r[1]), (TH - 32) / 1.8, 0.06);
      assert.near(num(r[2]), 5, 0.06);
      assert.near(num(r[3]), dT / 1.8, 0.06);
      const W = dT * 32 * 100 / (2335 + dT * 32);
      assert.near(num(r[4]), W, 0.06);
      assert.includes(app.el('wts_hydrate_summary').textContent, '(°C)');
      assert.includes(app.el('hy_thyd_1').textContent, '°C');
      // Imperial again: same physics in °F.
      setMetric(app, false); app.flush(10);
      assert.near(num(trow(app, 'wts_hydrate_summary', 'WH Choke → Heater Inlet')[1]), TH, 0.06);
      assert.near(parseFloat(app.el('hy_dn_P_1').value), 885, 1e-6);
      assert.deepEqual(app.consoleErrors(), []);
    },
  },
  {
    name: 'P7 liquidline: metric page shows 10³ m³/d / kPa(g) / m and a metric-typed case matches the imperial compute',
    wp: WP,
    run(app, assert) {
      const ref = app.win.WTS_liquidline_compute(app.toWin({ sepDesignPressure_psig: 1200, oilRate_bpd: 2500, oilSG: 0.85,
        gasSG: 0.7, gasFlowRate_MMscfd: 25, gasTemp_F: 80, lcv_size_in: 4, ro_size_64ths: 58, vent_NPS: 6, vent_sch: 40,
        vent_length_ft: 150, tank_design_pressure_psig: 50, wind_mph: 15 }));
      setMetric(app, true); app.hook.nav('liquidline'); app.flush(20);
      assert.includes(label(app, 'wts_ll_wind'), 'm/s');
      assert.includes(label(app, 'wts_ll_vent_len'), '(m)');
      set(app, { wts_ll_sep_p: met(app, 1200, 'pressureG'), wts_ll_sg_gas: 0.7, wts_ll_t_oil: met(app, 80, 'temperature'),
        wts_ll_vent_len: met(app, 150, 'length'), wts_ll_wind: met(app, 15, 'windSpeed') });
      app.click('wts_ll_calc_btn');
      const cell = (l) => trow(app, 'wts_ll_results', l)[1];
      assert.includes(cell('Max Gas Rate Through LCV'), '10³ m³/d');
      assert.near(num(cell('Max Gas Rate Through LCV')), ref.max_gas_through_lcv_MMscfd * 28.3168, 0.06);
      assert.near(num(cell('Vent Line Max Capacity')), ref.vent_max_capacity_MMscfd * 28.3168, 0.06);
      assert.near(num(cell('P downstream of RO')), ref.p_downstream_ro_psig * 6.89476, 0.6);
      assert.near(num(trow(app, 'wts_ll_results', 'Vertical (y)')[1]), ref.flammability.y_ft * 0.3048, 0.06);
      // GOR (read-only, derived) shows sm³/sm³ for the default 25 MMscfd / 2500 bpd
      assert.near(shown(app, 'wts_ll_gor'), 10000 * 0.178108, 0.5);
      setMetric(app, false); app.flush(10);
      assert.near(num(cell('Max Gas Rate Through LCV')), ref.max_gas_through_lcv_MMscfd, 0.006);
      assert.deepEqual(app.consoleErrors(), []);
    },
  },
  {
    name: 'P7 pipelife: tagged segment table + captions; metric results (m/s, mm/y, kPa); typed metric = imperial; velocity follows the basis',
    wp: WP,
    run(app, assert) {
      app.storage.removeItem && app.storage.removeItem('wts_pipelife');
      app.hook.nav('pipelife'); app.flush(500);
      const R0 = app.win.WTS_pipelife_lastReport.segments.map((s) => s.mixture_velocity_fps);
      const mawp1 = num(app.el('wts_pl_seg1_mawp').textContent);
      setMetric(app, true); app.flush(500);
      // Same physics, shown in metric
      const R1 = app.win.WTS_pipelife_lastReport.segments.map((s) => s.mixture_velocity_fps);
      R1.forEach((v, i) => assert.rel(v, R0[i], 1e-9, 'seg ' + i + ' velocity unchanged by the flip'));
      assert.near(num(app.el('wts_pl_seg3_vel').textContent), R0[3] * 0.3048, 0.06);
      assert.near(num(app.el('wts_pl_seg1_mawp').textContent), mawp1 * 6.89476, 7);
      assert.near(shown(app, 'wts_pl_seg1_meas'), 0.337 * 25.4, 1e-3);
      const caps = app.findAll('[data-pl-unit]').map((e) => String(e.textContent));
      assert.ok(caps.indexOf('m/s') !== -1 && caps.indexOf('mm/y') !== -1 && caps.indexOf('mm') !== -1, caps.join(','));
      // Metric-typed gas rate (20 MMscfd) and flowing P of segment 3 (400 psig)
      set(app, { wts_pl_qg: met(app, 20, 'gasRate'), wts_pl_seg3_pseg: met(app, 400, 'pressureG') });
      app.flush(300);
      const seg3 = app.win.WTS_pipelife_lastReport.segments[3];
      const sys = { gas_rate_MMscfd: 20, oil_rate_bpd: 1000, water_rate_bpd: 200 };
      const segIn = Object.assign({}, app.win.WTS_PIPELIFE_DEFAULT_SEGMENTS[3], { p_seg_psig: 400 });
      const vRef = app.win.WTS_pipelife_mixture_velocity(app.toWin(segIn), app.toWin(sys));
      assert.rel(seg3.mixture_velocity_fps, vRef, 1e-8);
      // Stored state is canonical imperial
      const saved = JSON.parse(app.storage.getItem('wts_pipelife'));
      assert.near(parseFloat(saved.wts_pl_qg), 20, 1e-6);
      // Velocity follows the standard-conditions basis (gas term only)
      const gasOnly = { gas_rate_MMscfd: 10, oil_rate_bpd: 0, water_rate_bpd: 0 };
      const v0 = app.win.WTS_pipelife_mixture_velocity(app.toWin(segIn), app.toWin(gasOnly));
      setBase(app, '60F_14.73');
      const v1 = app.win.WTS_pipelife_mixture_velocity(app.toWin(segIn), app.toWin(gasOnly));
      assert.rel(v1 / v0, 14.73 / 14.696, 1e-12);
      assert.includes(app.el('wts_pl_basis').textContent, '14.73 psia');
      assert.deepEqual(app.consoleErrors(), []);
    },
  },
  {
    name: 'P7 default basis leaves every Round-5 and gas result unchanged (no key → calculator default)',
    wp: WP,
    run(app, assert) {
      assert.strictEqual(app.storage.getItem('wts_base_conditions'), null);
      const r = app.win.WTS_esdHiPilot_compute(app.toWin({ sectionVolume_ft3: 292, sectionGasTemp_F: 23, gasFlowRate_MMscfd: 39.28,
        gasSG: 0.78, esdResponseTime_s: 5, hiPilotSetting_psig: 130, rdSetting_psig: 135, mawp_psig: 125 }));
      const Vstd = 292 * 519.67 / (23 + 459.67);
      assert.rel(r.inventoryAtHiPilot_scf, Vstd * 144.7 / 14.7, 1e-12);
      assert.strictEqual(app.win.WTS_h2s_so2(10, 1000, 98).lbmol_hr, 10e6 / 379.48 / 24);
      const f = app.win.WTS_flareghg_compute(app.toWin({ qg: 5, hrs: 24, ce: 98, ox1: false, gwp: 'ar5', tb: 60, pbase: 14.696,
        y: { c1: 100 }, c7n: 7, qo: 0, api: 40, wc: 85 }));
      assert.rel(f.Vm, 379.48, 1e-4);
    },
  },
];
