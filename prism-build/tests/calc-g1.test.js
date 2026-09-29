// Calculator audit G1 — Metering & chokes, driven through the real page
// (host nav → set inputs → click Calculate → read result rows).
//
//   aga3 · choke (dual) · chokeflow · chokecnv · turbmeter · mcfshr · gascalc
//
// Expected values are independent hand calculations (not the app's own code):
//   • AGA-3 / API MPMS 14.3.1 RG flange-tap Cd (constants 0.5961, 0.0291, −0.2290,
//     0.000511, 0.0210, 0.0049 + tap term) with Re_D iteration, Y1 = 1 −
//     (0.41+0.35β⁴)·hw/(27.707·Pf1·1.3), Z from Dranchuk–Abou-Kassem (bisection) on
//     Standing (1977) + Wichert–Aziz pseudo-criticals — flow solved in SI mass-flow form
//     qm = Cd·Ev·Y·πd²/4·√(2ρΔP), Qv = qm/ρb (Zb = 1). Qv = qm/ρb carries the base
//     temperature independently of the app's Ftb factor (ρb ∝ Pb/Tb).
//   • Dual choke gas: SI nozzle equation ṁ = C·A·√(2ρ1p1·k/(k−1)·(r^(2/k) − r^((k+1)/k)))
//     on both chokes (k = 1.28, Papay Z), P2 by bisection so q1 = q2.
//   • Gilbert (1954) q = P·S^1.89/(435·GLR^0.546) (GLR Mscf/bbl, P psig);
//     Ros (1960) q = P·S²/(17.4·GLR^0.5) (GLR scf/bbl).
//   • Fixed-choke coefficient method Q = C·Pabs/√(SG·Tabs).
//   • Gas velocity V = Q·1000·Bg/86400/(π/4·(D/12)²); static gas column
//     Pws = Pwh·exp(0.01875·SG·H/(Z·T)); gradient 0.01875·SG·P/(Z·T).
// Metric-mode tests enter the same physical case in metric units and expect the
// same physical answer.
'use strict';

const WP = 'G1';

function rows(app, resId) {
  return app.findAll('#' + resId + ' .rrow').map((r) => {
    const l = r.querySelector('.rl'), v = r.querySelector('.rv');
    return { l: String(l ? l.textContent : '').trim(), v: String(v ? v.textContent : '').trim() };
  });
}
function rv(app, resId, label, nth) {
  const hits = rows(app, resId).filter((r) => r.l.indexOf(label) !== -1);
  const r = hits[nth || 0];
  if (!r) throw new Error('no result row "' + label + '" in #' + resId + ': ' + JSON.stringify(rows(app, resId)));
  const m = r.v.replace(/,/g, '').match(/-?\d+(\.\d+)?(e[-+]?\d+)?/i);
  if (!m) throw new Error('row "' + label + '" has no number: ' + r.v);
  return parseFloat(m[0]);
}
function rvText(app, resId, label) {
  const r = rows(app, resId).find((x) => x.l.indexOf(label) !== -1);
  return r ? r.v : null;
}
function errText(app, resId) {
  return app.findAll('#' + resId + ' .val-error').map((e) => e.textContent).join(' | ');
}
function noBadNumbers(assert, app, where) {
  const t = String(app.el('pgBody').textContent || '');
  assert.ok(!/NaN|Infinity|∞|undefined/.test(t), where + ': page shows NaN/Infinity/undefined');
}
function set(app, vals) {
  for (const k of Object.keys(vals)) {
    const e = app.el(k);
    if (!e) throw new Error('no input #' + k);
    if (String(e.tagName).toUpperCase() === 'SELECT') app.select(k, String(vals[k])); else app.input(k, String(vals[k]));
  }
}
function setMetric(app, on) {
  const U = app.win.WTS_units;
  if (!U || typeof U.setSystem !== 'function') throw new Error('WTS_units.setSystem missing');
  U.setSystem(on ? 'metric' : 'imperial');
}
function reportHas(app, assert, needles) {
  const model = app.win.collectPageReport(app.el('pgBody'), { charts: false });
  const s = JSON.stringify(model);
  for (const n of needles) assert.includes(s, n, 'page report contains ' + n);
  assert.ok(model.inputs.length > 0, 'report has input sections');
  assert.ok(model.results.length > 0, 'report has result sections');
}

// ── Independent references ───────────────────────────────────────────────
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
  const Tpc = 168 + 325 * SG - 12.5 * SG * SG, Ppc = 677 + 15 * SG - 37.5 * SG * SG;
  const A = (co2 + h2s) / 100, B = h2s / 100, eps = 120 * (A ** 0.9 - A ** 1.6) + 15 * (B ** 0.5 - B ** 4);
  const Tpc2 = Tpc - eps, Ppc2 = Ppc * Tpc2 / (Tpc + B * (1 - B) * eps);
  const Z = dakZ(Tf / Tpc2, Pf / Ppc2);
  const Y = 1 - (0.41 + 0.35 * b4) * hw / (27.707 * Pf) / 1.3;
  const dm = d * 0.0254, Dm = D * 0.0254, dP = hw * 248.84, M = 28.9625e-3 * SG, R = 8.314462;
  const rho = Pf * 6894.757 * M / (Z * R * Tf * 5 / 9), rhob = Pb * 6894.757 * M / (R * Tb * 5 / 9);
  const L = 1 / D, M2 = 2 * L / (1 - beta), M1 = Math.max(2.8 - D, 0);
  let Re = 1e6, Cd = 0.6, qm = 0;
  for (let i = 0; i < 60; i++) {
    const Aa = (19000 * beta / Re) ** 0.8, C = (1e6 / Re) ** 0.35;
    Cd = 0.5961 + 0.0291 * beta ** 2 - 0.2290 * beta ** 8 + 0.003 * (1 - beta) * M1
      + (0.0433 + 0.0712 * Math.exp(-8.5 * L) - 0.1145 * Math.exp(-6 * L)) * (1 - 0.23 * Aa) * b4 / (1 - b4)
      - 0.0116 * (M2 - 0.52 * M2 ** 1.3) * beta ** 1.1 * (1 - 0.14 * Aa)
      + 0.000511 * (1e6 * beta / Re) ** 0.7 + (0.0210 + 0.0049 * Aa) * b4 * C;
    qm = Cd * Ev * Y * Math.PI / 4 * dm * dm * Math.sqrt(2 * rho * dP);
    Re = 4 * qm / (Math.PI * mu * 1e-3 * Dm);
  }
  return { Z, Cd, Qv: qm / rhob / 0.0283168466 * 3600 };
}
function papay(p, SG, TR) {
  const Ppc = 756.8 - 131 * SG - 3.6 * SG * SG, Tpc = 169.2 + 349.5 * SG - 74 * SG * SG, pr = p / Ppc, tr = TR / Tpc;
  return Math.max(0.3, Math.min(1.2, 1 - 3.52 * pr / 10 ** (0.9813 * tr) + 0.274 * pr * pr / 10 ** (0.8157 * tr)));
}
function nozzleMscfd(CA, pu, pd, SG, TR, k) {
  const rc = (2 / (k + 1)) ** (k / (k - 1)), r = Math.max(pd / pu, rc);
  const p = pu * 6894.757, A = CA * 6.4516e-4, M = 0.0289625 * SG, R = 8.314462, T = TR * 5 / 9;
  const rho = p * M / (papay(pu, SG, TR) * R * T);
  const mdot = A * Math.sqrt(2 * rho * p * (k / (k - 1)) * (r ** (2 / k) - r ** ((k + 1) / k)));
  const rhosc = 14.696 * 6894.757 * M / (R * 519.67 * 5 / 9);
  return mdot / rhosc / 0.0283168466 * 86400 / 1000;
}
function dualGasRef(P1, P3, s1, s2, cd1, cd2, SG, T) {
  const A1 = Math.PI / 4 * (s1 / 64) ** 2, A2 = Math.PI / 4 * (s2 / 64) ** 2, P1a = P1 + 14.696, P3a = P3 + 14.696, TR = T + 459.67;
  const q = (CA, pu, pd) => nozzleMscfd(CA, pu, pd, SG, TR, 1.28);
  let lo = P3a, hi = P1a;
  for (let i = 0; i < 100; i++) { const m = (lo + hi) / 2; if (q(cd1 * A1, P1a, m) > q(cd2 * A2, m, P3a)) lo = m; else hi = m; }
  const P2a = (lo + hi) / 2;
  return { P2: P2a - 14.696, Q: q(cd1 * A1, P1a, P2a) };
}

module.exports = [
  // ── AGA-3 ──────────────────────────────────────────────────────────────
  {
    name: 'G1 aga3: default 4.026"/2.0" 50 inH2O 500 psig 80°F SG 0.65 matches AGA-3 RG + DAK reference; sour 8" case',
    wp: WP,
    run(app, assert) {
      app.hook.nav('aga3');
      set(app, { a_pD: 4.026, a_oD: 2.0, a_tap: 'flange', a_dP: 50, a_Ps: 500, a_Tf: 80, a_SG: 0.65, a_CO2: 0.5, a_H2S: 0, a_N2: 1, a_Tb: 60, a_Pb: 14.696 });
      app.win.calcAGA3();
      const ref = agaRef({ D: 4.026, d: 2, hw: 50, Ps: 500, TfF: 80, SG: 0.65, co2: 0.5 });   // 172,086 scf/h, Z 0.9150, Cd 0.60310
      assert.rel(rv(app, 'a_res', 'Gas Rate (SCF/hr)'), ref.Qv, 1e-3, 'SCF/hr');
      assert.rel(rv(app, 'a_res', 'Gas Rate (MSCF/D)'), ref.Qv * 24 / 1000, 1e-3, 'MSCF/D');
      assert.near(rv(app, 'a_res', 'Z-Factor'), ref.Z, 2e-4, 'DAK Z (old garbled fit gave 0.9219)');
      assert.near(rv(app, 'a_res', 'Discharge Coeff'), ref.Cd, 2e-5, 'RG flange-tap Cd');
      noBadNumbers(assert, app, 'aga3 default');
      reportHas(app, assert, ['Pipe Internal Dia', 'Gas Rate (MSCF/D)', 'Discharge Coeff']);
      // sour, higher pressure: old Z was 0.8238 vs DAK 0.7274 (≈ −6 % rate error)
      set(app, { a_pD: 8.071, a_oD: 4, a_dP: 150, a_Ps: 1500, a_Tf: 70, a_SG: 0.7, a_CO2: 2, a_H2S: 1 });
      app.win.calcAGA3();
      const ref2 = agaRef({ D: 8.071, d: 4, hw: 150, Ps: 1500, TfF: 70, SG: 0.7, co2: 2, h2s: 1 });
      assert.rel(rv(app, 'a_res', 'Gas Rate (SCF/hr)'), ref2.Qv, 1e-3, 'sour case SCF/hr');
      assert.near(rv(app, 'a_res', 'Z-Factor'), ref2.Z, 2e-4, 'sour case Z');
    },
  },
  {
    name: 'G1 aga3: validation (orifice ≥ pipe, blank, T below absolute zero) and applicability notes',
    wp: WP,
    run(app, assert) {
      app.hook.nav('aga3');
      set(app, { a_pD: 4.026, a_oD: 4.5 });
      app.win.calcAGA3();
      assert.includes(errText(app, 'a_res'), 'Orifice diameter must be smaller');
      set(app, { a_oD: 2, a_dP: '' });
      app.win.calcAGA3();
      assert.includes(errText(app, 'a_res'), 'Differential Pressure is required');
      set(app, { a_dP: 50, a_Tf: -500 });
      app.win.calcAGA3();
      assert.includes(errText(app, 'a_res'), 'Flowing Temperature must be at least');
      set(app, { a_Tf: 80, a_tap: 'pipe', a_oD: 3.5 });
      app.win.calcAGA3();
      const notes = String(app.el('a_notes') ? app.el('a_notes').textContent : '');
      assert.includes(notes, 'flange taps only');
      assert.includes(notes, 'outside the AGA-3 RG range');
      noBadNumbers(assert, app, 'aga3 notes');
    },
  },
  {
    name: 'G1 aga3: Metric mode (mm, mbar, kPa(g), °C) gives the same physical rate as Imperial',
    wp: WP,
    run(app, assert) {
      setMetric(app, true);
      app.hook.nav('aga3');
      set(app, { a_pD: 4.026 * 25.4, a_oD: 2 * 25.4, a_tap: 'flange', a_dP: 50 * 2.49089, a_Ps: 500 * 6.89476, a_Tf: (80 - 32) * 5 / 9,
        a_SG: 0.65, a_CO2: 0.5, a_H2S: 0, a_Tb: (60 - 32) * 5 / 9, a_Pb: 14.696 * 6.89476 });
      app.win.calcAGA3();
      const ref = agaRef({ D: 4.026, d: 2, hw: 50, Ps: 500, TfF: 80, SG: 0.65, co2: 0.5 });
      assert.rel(rv(app, 'a_res', 'Gas Rate (SCF/hr)'), ref.Qv, 1.5e-3, 'metric input → same SCF/hr');
      noBadNumbers(assert, app, 'aga3 metric');
    },
  },
  {
    name: 'G1 aga3: base temperature ≠ 60 °F — Ftb = Tb/519.67 (100 °F base reads 1.0770× the 60 °F rate; 32 °F 0.9461×)',
    wp: WP,
    run(app, assert) {
      // Verifier case: 6.065"/3.0" flange, 80 inH2O, 800 psig, 100 °F, SG 0.75, 1 % CO2, Pb 14.73.
      // The inverted factor (519.67/Tb) gave 542,530 at a 100 °F base (−13.8 %).
      app.hook.nav('aga3');
      const base = { a_pD: 6.065, a_oD: 3.0, a_tap: 'flange', a_dP: 80, a_Ps: 800, a_Tf: 100, a_SG: 0.75, a_CO2: 1, a_H2S: 0, a_N2: 0, a_Pb: 14.73 };
      const q = {};
      for (const TbF of [60, 100, 32]) {
        set(app, Object.assign({}, base, { a_Tb: TbF }));
        app.win.calcAGA3();
        q[TbF] = rv(app, 'a_res', 'Gas Rate (SCF/hr)');
        const ref = agaRef({ D: 6.065, d: 3, hw: 80, Ps: 800, TfF: 100, SG: 0.75, co2: 1, TbF, Pb: 14.73 });
        assert.rel(q[TbF], ref.Qv, 1e-3, 'Tb ' + TbF + ' °F SCF/hr vs mass-flow reference');
      }
      assert.rel(q[100] / q[60], 559.67 / 519.67, 1e-6, '100 °F / 60 °F rate ratio = 1.0770');
      assert.rel(q[32] / q[60], 491.67 / 519.67, 1e-6, '32 °F / 60 °F rate ratio = 0.9461');
      noBadNumbers(assert, app, 'aga3 base temperature');
    },
  },
  {
    name: 'G1 aga3: Metric at the 15 °C / 101.325 kPa base — rate matches the reference and Sm³ rows are shown',
    wp: WP,
    run(app, assert) {
      setMetric(app, true);
      app.hook.nav('aga3');
      set(app, { a_pD: 6.065 * 25.4, a_oD: 3 * 25.4, a_tap: 'flange', a_dP: 80 * 2.49089, a_Ps: 800 * 6.89476, a_Tf: (100 - 32) * 5 / 9,
        a_SG: 0.75, a_CO2: 1, a_H2S: 0, a_N2: 0, a_Tb: 15, a_Pb: 101.325 });
      app.win.calcAGA3();
      const ref = agaRef({ D: 6.065, d: 3, hw: 80, Ps: 800, TfF: 100, SG: 0.75, co2: 1, TbF: 59, Pb: 101.325 / 6.89476 });
      assert.rel(rv(app, 'a_res', 'Gas Rate (SCF/hr)'), ref.Qv, 1.5e-3, 'metric 15 °C base SCF/hr (was +0.36 % with inverted Ftb)');
      assert.rel(rv(app, 'a_res', 'Gas Rate (Sm³/d)'), ref.Qv * 24 * 0.0283168466, 1.5e-3, 'Sm³/d row');
      assert.rel(rv(app, 'a_res', 'Gas Rate (Sm³/h)'), ref.Qv * 0.0283168466, 1.5e-3, 'Sm³/h row');
      assert.ok(rows(app, 'a_res').some((r) => r.l.indexOf('kg/m³') !== -1), 'density shown in kg/m³');
      setMetric(app, false);
      app.hook.nav('aga3');
      app.win.calcAGA3();
      assert.ok(!rows(app, 'a_res').some((r) => r.l.indexOf('Sm³') !== -1), 'no Sm³ rows in Imperial');
    },
  },
  // ── Dual choke ─────────────────────────────────────────────────────────
  {
    name: 'G1 choke: gas 1500→500 psig, 32/64 + 24/64 — P2 and rate from a two-choke nozzle balance (larger bean takes the smaller ΔP)',
    wp: WP,
    run(app, assert) {
      app.hook.nav('choke');
      set(app, { c_P1: 1500, c_P3: 500, c_ft: 'gas', c_T: 150, c_s1: 32, c_cd1: 0.85, c_s2: 24, c_cd2: 0.85, c_SG: 0.65, c_API: 35, c_GOR: 800, c_WC: 10 });
      app.win.calcChoke();
      const ref = dualGasRef(1500, 500, 32, 24, 0.85, 0.85, 0.65, 150);   // P2 ≈ 1400.7 psig, Q ≈ 4146 MSCF/D
      const P2 = rv(app, 'c_res', 'Intermediate Pressure');
      assert.near(P2, ref.P2, 0.5, 'P2 psig (old swapped weights gave 854.8)');
      assert.rel(rv(app, 'c_res', 'Gas Rate'), ref.Q, 2e-3, 'gas rate MSCF/D (old 5,592.7)');
      assert.ok(rv(app, 'c_res', 'ΔP Choke 1') < rv(app, 'c_res', 'ΔP Choke 2'), 'bigger choke 1 takes the smaller ΔP');
      assert.includes(rvText(app, 'c_res', 'Choke 2 Critical'), 'YES');
      assert.near(rv(app, 'c_res', 'Equivalent Choke Size'), 22.41, 0.05, 'geometric equivalent bean (1/d⁴ = Σ1/dᵢ⁴)');
      noBadNumbers(assert, app, 'choke gas');
      reportHas(app, assert, ['Upstream Pressure', 'Intermediate Pressure (P2)', 'Gas Rate']);
      // both chokes critical
      set(app, { c_P1: 3000, c_P3: 100, c_s1: 24, c_s2: 48 });
      app.win.calcChoke();
      const ref2 = dualGasRef(3000, 100, 24, 48, 0.85, 0.85, 0.65, 150);  // Q ≈ 8857
      assert.rel(rv(app, 'c_res', 'Gas Rate'), ref2.Q, 2e-3, 'both-critical gas rate');
      assert.near(rv(app, 'c_res', 'Intermediate Pressure'), ref2.P2, 0.5);
    },
  },
  {
    name: 'G1 choke: multiphase Gilbert uses GLR = GOR·(1−WC) through the geometric equivalent bean; GOR 0 rejected',
    wp: WP,
    run(app, assert) {
      app.hook.nav('choke');
      set(app, { c_P1: 1500, c_P3: 500, c_ft: 'multi', c_T: 150, c_s1: 32, c_cd1: 0.85, c_s2: 24, c_cd2: 0.85, c_SG: 0.65, c_GOR: 800, c_WC: 10 });
      app.win.calcChoke();
      const S = 64 * Math.pow(1 / (1 / Math.pow(32 / 64, 4) + 1 / Math.pow(24 / 64, 4)), 0.25);   // 22.406
      const ql = 1500 * Math.pow(S, 1.89) / (435 * Math.pow(0.72, 0.546));                     // 1471.2
      assert.rel(rv(app, 'c_res', 'Liquid Rate'), ql, 1e-3, 'Gilbert liquid rate');
      assert.rel(rv(app, 'c_res', 'Oil Rate'), ql * 0.9, 1e-3, 'oil = liquid·(1−WC)');
      // subcritical quadratic balance in absolute pressure: P2² = (CA1²P1² + CA2²P3²)/(CA1²+CA2²)
      const w1 = Math.pow(32, 4), w2 = Math.pow(24, 4), P1a = 1514.696, P3a = 514.696;
      assert.near(rv(app, 'c_res', 'Intermediate Pressure'), Math.sqrt((w1 * P1a * P1a + w2 * P3a * P3a) / (w1 + w2)) - 14.696, 0.1);
      set(app, { c_GOR: 0 });
      app.win.calcChoke();
      assert.includes(errText(app, 'c_res'), 'GOR must be greater than zero');
      set(app, { c_GOR: 800, c_P3: 1600 });
      app.win.calcChoke();
      assert.includes(errText(app, 'c_res'), 'Downstream pressure must be less');
      noBadNumbers(assert, app, 'choke multi');
    },
  },
  {
    name: 'G1 choke: Metric (kPa(g), °C) gives the same gas rate; pressure labels are gauge',
    wp: WP,
    run(app, assert) {
      setMetric(app, true);
      app.hook.nav('choke');
      const lbl = app.findAll('#pgBody label').map((l) => l.textContent).join(' | ');
      assert.includes(lbl, 'Upstream Pressure (kPa(g))');
      set(app, { c_P1: 1500 * 6.89476, c_P3: 500 * 6.89476, c_ft: 'gas', c_T: (150 - 32) * 5 / 9, c_s1: 32, c_cd1: 0.85, c_s2: 24, c_cd2: 0.85, c_SG: 0.65 });
      app.win.calcChoke();
      const ref = dualGasRef(1500, 500, 32, 24, 0.85, 0.85, 0.65, 150);
      assert.rel(rv(app, 'c_res', 'Gas Rate'), ref.Q, 2e-3);
      // Metric companions (verifier minor): P2 in kPa(g), ΔP in kPa, rate in Sm³/d.
      const metricOf = (label, unit) => {
        const t = rvText(app, 'c_res', label) || '';
        const m = t.replace(/,/g, '').match(new RegExp('\\((-?[\\d.]+) ' + unit.replace(/[()]/g, '\\$&') + '\\)'));
        if (!m) throw new Error('row "' + label + '" has no ' + unit + ' companion: ' + t);
        return parseFloat(m[1]);
      };
      assert.near(metricOf('Intermediate Pressure', 'kPa(g)'), ref.P2 * 6.89476, 5, 'P2 kPa(g)');
      assert.near(metricOf('ΔP Choke 1', 'kPa'), (1500 - ref.P2) * 6.89476, 5, 'ΔP1 kPa');
      assert.rel(metricOf('Gas Rate', 'Sm³/d'), ref.Q * 28.3168466, 2e-3, 'gas rate Sm³/d');
      setMetric(app, false);
      app.hook.nav('choke');
      app.win.calcChoke();
      assert.ok(!/kPa|Sm³/.test(app.el('c_res').textContent), 'no metric companions in Imperial');
      setMetric(app, false);
      app.hook.nav('choke');
      const lblI = app.findAll('#pgBody label').map((l) => l.textContent).join(' | ');
      assert.includes(lblI, 'Upstream Pressure (psig)');
    },
  },
  // ── Choke flow rates ───────────────────────────────────────────────────
  {
    name: 'G1 chokeflow: coefficient method 32/64 3000 psig 120°F SG 0.7 = 16,865 MSCF/D; Gilbert 3,521 / Ros 3,948 BPD; range checks',
    wp: WP,
    run(app, assert) {
      app.hook.nav('chokeflow');
      set(app, { cf_cs: 32, cf_whp: 3000, cf_wht: 120, cf_sg: 0.7 });
      app.win.calcChokeGas();
      assert.rel(rv(app, 'cf_gres', 'Gas Rate'), 112.72 * 3014.7 / Math.sqrt(0.7 * 580), 1e-4);
      set(app, { cf_cs: 34 });                       // linear between 32 (112.72) and 36 (144.18)
      app.win.calcChokeGas();
      assert.near(rv(app, 'cf_gres', 'Choke Coefficient'), 128.45, 1e-3);
      set(app, { cf_cs: 1 });
      app.win.calcChokeGas();
      assert.includes(errText(app, 'cf_gres'), 'Choke Size must be at least 2');
      set(app, { cf_cs: 32, cf_wht: '' });
      app.win.calcChokeGas();
      assert.includes(errText(app, 'cf_gres'), 'Wellhead Temp is required');
      set(app, { cf_op: 1500, cf_ocs: 32, cf_gor: 500 });
      app.win.calcChokeOil();
      assert.rel(rv(app, 'cf_ores', 'Gilbert'), 1500 * Math.pow(32, 1.89) / (435 * Math.pow(0.5, 0.546)), 1e-4);
      assert.rel(rv(app, 'cf_ores', 'Ros'), 1500 * 1024 / (17.4 * Math.sqrt(500)), 1e-4);
      set(app, { cf_gor: 0 });
      app.win.calcChokeOil();
      assert.includes(errText(app, 'cf_ores'), 'GOR must be greater than zero');
      noBadNumbers(assert, app, 'chokeflow');
    },
  },
  {
    name: 'G1 chokeflow: Metric (kPa(g), °C) gives the same coefficient-method rate',
    wp: WP,
    run(app, assert) {
      setMetric(app, true);
      app.hook.nav('chokeflow');
      set(app, { cf_cs: 32, cf_whp: 3000 * 6.89476, cf_wht: (120 - 32) * 5 / 9, cf_sg: 0.7 });
      app.win.calcChokeGas();
      assert.rel(rv(app, 'cf_gres', 'Gas Rate'), 112.72 * 3014.7 / Math.sqrt(0.7 * 580), 1e-4);
    },
  },
  // ── Choke conversions ──────────────────────────────────────────────────
  {
    name: 'G1 chokecnv: 32/64 = 0.5000 in = 12.70 mm; 25.4 mm = 64/64; negative ignored',
    wp: WP,
    run(app, assert) {
      app.hook.nav('chokecnv');
      app.input('cc_64', '32'); app.win.calcChokeCnv('64');
      assert.equal(app.el('cc_in').value, '0.5000');
      assert.equal(app.el('cc_mm').value, '12.70');
      app.input('cc_mm', '25.4'); app.win.calcChokeCnv('mm');
      assert.equal(app.el('cc_64').value, '64.00');
      assert.equal(app.el('cc_in').value, '1.0000');
      app.input('cc_in', '-1'); app.win.calcChokeCnv('in');
      assert.equal(app.el('cc_64').value, '64.00', 'negative size leaves the other fields unchanged');
      noBadNumbers(assert, app, 'chokecnv');
    },
  },
  // ── Gas calculations ───────────────────────────────────────────────────
  {
    name: 'G1 gascalc: velocity 40,000 MSCF/D in 2.85" at 4000 psia = 38.9 ft/s; quick estimate 18 MMSCF/D; gradient & BHP',
    wp: WP,
    run(app, assert) {
      app.hook.nav('gascalc');
      set(app, { gv_z: 0.9727, gv_t: 80, gv_p: 4000, gv_q: 40000, gv_d: 2.85 });
      app.win.calcGasVel();
      const Bg = 0.02833 * 0.9727 * 540 / 4000;
      const V = 40000 * 1000 * Bg / 86400 / (Math.PI / 4 * Math.pow(2.85 / 12, 2));   // 38.88 ft/s
      assert.rel(rv(app, 'gv_res', 'Gas Velocity'), V, 2e-3, 'velocity (old 38,875 ft/s)');
      set(app, { gv_d: 0 });
      app.win.calcGasVel();
      assert.includes(errText(app, 'gv_res'), 'Line ID must be greater than zero');
      set(app, { gq_p: 3000, gq_d: 32 });
      app.win.calcGasQuick();
      assert.near(rv(app, 'gq_res', 'Gas Volume', 1), 18.0, 1e-3, '24·P·d² = 24·3000·0.25/1000 MMSCF/D');
      set(app, { gg_pwh: 2500, gg_sg: 0.7, gg_d: 13650, gg_t: 600, gg_z: 0.831 });
      app.win.calcGasGrad();
      assert.rel(rv(app, 'gg_res', 'BHP (exponential)'), 2500 * Math.exp(0.01875 * 0.7 * 13650 / (0.831 * 600)), 1e-4);
      assert.near(rv(app, 'gg_res', 'BHP (rule-of-thumb)'), 2500 + 0.25 * 25 * 136.5, 0.1);
      set(app, { gs_p: 3731, gs_sg: 0.7, gs_t: 600, gs_z: 0.91 });
      app.win.calcGasGradSimple();
      assert.near(rv(app, 'gs_res', 'Gas Gradient'), 0.01875 * 0.7 * 3731 / (0.91 * 600), 1e-4);
      set(app, { gs_z: '' });
      app.win.calcGasGradSimple();
      assert.includes(errText(app, 'gs_res'), 'Z-factor is required');
      noBadNumbers(assert, app, 'gascalc');
      reportHas(app, assert, ['Gas Velocity', 'Line ID']);
    },
  },
  {
    name: 'G1 gascalc: Metric (kPa, °C, m³/d, mm, m, K) gives the same velocity and BHP',
    wp: WP,
    run(app, assert) {
      setMetric(app, true);
      app.hook.nav('gascalc');
      set(app, { gv_z: 0.9727, gv_t: (80 - 32) * 5 / 9, gv_p: 4000 * 6.89476, gv_q: 40000 * 28.3168, gv_d: 2.85 * 25.4 });
      app.win.calcGasVel();
      const Bg = 0.02833 * 0.9727 * 540 / 4000;
      assert.rel(rv(app, 'gv_res', 'Gas Velocity'), 40000 * 1000 * Bg / 86400 / (Math.PI / 4 * Math.pow(2.85 / 12, 2)), 3e-3);
      set(app, { gg_pwh: 2500 * 6.89476, gg_sg: 0.7, gg_d: 13650 * 0.3048, gg_t: 600 * 5 / 9, gg_z: 0.831 });
      app.win.calcGasGrad();
      assert.rel(rv(app, 'gg_res', 'BHP (exponential)'), 2500 * Math.exp(0.01875 * 0.7 * 13650 / (0.831 * 600)), 1e-3);
      noBadNumbers(assert, app, 'gascalc metric');
    },
  },
  // ── MCF & shrinkage ────────────────────────────────────────────────────
  {
    name: 'G1 mcfshr: meter factor = tank/meter volume, shrinkage = (final−stabilised)/(final−initial); bad readings rejected',
    wp: WP,
    run(app, assert) {
      app.hook.nav('mcfshr');
      set(app, { ms_ti: 1000, ms_tf: 1010, ms_si: 50, ms_sf: 60, ms_ss: 58.5 });
      app.win.calcMCFShr();
      assert.near(rv(app, 'ms_res', 'MCF'), 1, 1e-9);
      assert.near(rv(app, 'ms_res', 'Shrinkage'), 15, 1e-9);
      set(app, { ms_tf: 1010.5 });
      app.win.calcMCFShr();
      assert.near(rv(app, 'ms_res', 'MCF'), 10 / 10.5, 1e-6);
      assert.includes(rvText(app, 'ms_res', 'Metered Volume'), 'bbl');
      set(app, { ms_sf: 40 });
      app.win.calcMCFShr();
      assert.includes(errText(app, 'ms_res'), 'final level must be above');
      set(app, { ms_sf: 60, ms_ss: 61 });
      app.win.calcMCFShr();
      assert.includes(errText(app, 'ms_res'), 'Stabilized level must lie between');
      set(app, { ms_ss: '' });
      app.win.calcMCFShr();
      assert.includes(errText(app, 'ms_res'), 'is required');
      noBadNumbers(assert, app, 'mcfshr');
    },
  },
  {
    name: 'G1 mcfshr: Metric — volume rows are labelled and shown in m³',
    wp: WP,
    run(app, assert) {
      setMetric(app, true);
      app.hook.nav('mcfshr');
      set(app, { ms_ti: 100, ms_tf: 102, ms_si: 5, ms_sf: 7, ms_ss: 6.8 });
      app.win.calcMCFShr();
      assert.near(rv(app, 'ms_res', 'Metered Volume'), 2, 1e-3);
      assert.includes(rvText(app, 'ms_res', 'Metered Volume'), 'm³');
      assert.near(rv(app, 'ms_res', 'MCF'), 1, 1e-6);
      assert.near(rv(app, 'ms_res', 'Shrinkage'), 10, 1e-3);
    },
  },
  // ── Turbine meter ──────────────────────────────────────────────────────
  {
    name: 'G1 turbmeter: 35 °API 40 °C 5 cP 500–8000 BPD → 3" meter, Re 2,511, ρ 834.9; water vapour pressure; validation',
    wp: WP,
    run(app, assert) {
      app.hook.nav('turbmeter');
      set(app, { tm_liq: 'oil', tm_api: 35, tm_t: 40, tm_mu: 5, tm_qmin: 500, tm_qmax: 8000, tm_p: 500 });
      app.win.calcTurbMeter();
      const rho = 141.5 / 166.5 * 999 / (1 + 0.00069 * (40 - 15.56));
      const A = Math.PI * 0.0779 * 0.0779 / 4, Vmin = 500 * 0.158987 / 86400 / A;
      assert.includes(app.el('tm_res').textContent, 'Selected Meter: 3"');
      assert.near(rv(app, 'tm_res', 'Density'), rho, 0.06);
      assert.near(rv(app, 'tm_res', 'Velocity @ Q'), Vmin, 5e-4);
      assert.rel(rv(app, 'tm_res', 'Re @ Q'), rho * Vmin * 0.0779 / 0.005, 2e-3);
      assert.includes(app.el('tm_res').textContent, 'below the 3" meter');
      // water @ 40 °C: Antoine P = 55.3 mmHg = 1.07 psia → margin 514.696 − 1.07
      set(app, { tm_liq: 'water' });
      app.win.calcTurbMeter();
      const pv = Math.pow(10, 8.07131 - 1730.63 / 273.426) / 51.7149;
      assert.near(rv(app, 'tm_res', 'Cavitation Margin'), 514.7 - pv, 0.06);
      set(app, { tm_qmin: 9000 });
      app.win.calcTurbMeter();
      assert.includes(errText(app, 'tm_res'), 'Qmax must be greater');
      set(app, { tm_qmin: '' });
      app.win.calcTurbMeter();
      assert.includes(errText(app, 'tm_res'), 'Qmin is required');
      set(app, { tm_qmin: 500, tm_mu: 40 });
      app.win.calcTurbMeter();
      assert.includes(errText(app, 'tm_res'), 'NOT suitable');
      noBadNumbers(assert, app, 'turbmeter');
    },
  },
  {
    name: 'G1 turbmeter: Metric (m³/d, kPa(g)) gives the same Reynolds number',
    wp: WP,
    run(app, assert) {
      setMetric(app, true);
      app.hook.nav('turbmeter');
      set(app, { tm_liq: 'oil', tm_api: 35, tm_t: 40, tm_mu: 5, tm_qmin: 500 * 0.158987, tm_qmax: 8000 * 0.158987, tm_p: 500 * 6.89476 });
      app.win.calcTurbMeter();
      const rho = 141.5 / 166.5 * 999 / (1 + 0.00069 * (40 - 15.56));
      const A = Math.PI * 0.0779 * 0.0779 / 4, Vmin = 500 * 0.158987 / 86400 / A;
      assert.rel(rv(app, 'tm_res', 'Re @ Q'), rho * Vmin * 0.0779 / 0.005, 3e-3);
      assert.includes(app.el('tm_res').textContent, 'Selected Meter: 3"');
    },
  },
  {
    name: 'G1 turbmeter (ROADMAP 1.5): vapour pressure is an input — blank = per-liquid default, entered TVP drives the margin',
    wp: WP,
    run(app, assert) {
      app.hook.nav('turbmeter');
      set(app, { tm_liq: 'oil', tm_api: 35, tm_t: 40, tm_mu: 5, tm_qmin: 500, tm_qmax: 8000, tm_p: 500, tm_pv: '' });
      app.win.calcTurbMeter();
      // default stabilised-crude screening value 0.3 psia → margin 514.7 − 0.3 = 514.4 psi, with the live-crude note
      assert.near(rv(app, 'tm_res', 'Vapour Pressure'), 0.3, 1e-9);
      assert.near(rv(app, 'tm_res', 'Cavitation Margin'), 514.4, 0.06);
      assert.includes(app.el('tm_res').textContent, 'bubble point');
      // live crude off a 500 psig separator: TVP ≈ 514.7 psia; meter at 510 psig → margin 524.7 − 514.7 = 10.0 psi
      set(app, { tm_pv: 514.7, tm_p: 510 }); app.win.calcTurbMeter();
      assert.near(rv(app, 'tm_res', 'Vapour Pressure'), 514.7, 1e-9);
      assert.near(rv(app, 'tm_res', 'Cavitation Margin'), 10.0, 0.051);
      assert.includes(rvText(app, 'tm_res', 'Cavitation Margin'), 'OK');
      assert.ok(!/bubble point/.test(app.el('tm_res').textContent), 'no default-TVP note once a TVP is entered');
      // 2 psi above TVP → below the 3 psi hard stop
      set(app, { tm_p: 502 }); app.win.calcTurbMeter();
      assert.near(rv(app, 'tm_res', 'Cavitation Margin'), 2.0, 0.051);
      assert.includes(rvText(app, 'tm_res', 'Cavitation Margin'), 'LOW');
      // diesel default 0.05 psia; water default Antoine at 40 °C (1.070 psia)
      set(app, { tm_liq: 'diesel', tm_pv: '', tm_p: 500 }); app.win.calcTurbMeter();
      assert.near(rv(app, 'tm_res', 'Vapour Pressure'), 0.05, 1e-9);
      set(app, { tm_liq: 'water' }); app.win.calcTurbMeter();
      assert.near(rv(app, 'tm_res', 'Vapour Pressure'), Math.pow(10, 8.07131 - 1730.63 / 273.426) / 51.7149, 0.006);
      assert.includes(rvText(app, 'tm_res', 'Vapour Pressure') === null ? '' : rows(app, 'tm_res').find((r) => r.l.indexOf('Vapour') !== -1).l, 'Antoine');
      set(app, { tm_pv: -1 }); app.win.calcTurbMeter();
      assert.includes(errText(app, 'tm_res'), 'Vapour pressure');
      assert.includes(String(app.el('pgBody').textContent), 'Vapour Pressure Basis');
      noBadNumbers(assert, app, 'turbmeter pv');
      assert.deepEqual(app.consoleErrors(), []);
    },
  },
  {
    name: 'G1 turbmeter (ROADMAP 1.5): metric vapour pressure in kPa gives the same margin',
    wp: WP,
    run(app, assert) {
      setMetric(app, true);
      app.hook.nav('turbmeter');
      set(app, { tm_liq: 'oil', tm_api: 35, tm_t: 40, tm_mu: 5, tm_qmin: 500 * 0.158987, tm_qmax: 8000 * 0.158987,
        tm_p: 510 * 6.89476, tm_pv: 514.7 * 6.89476 });
      app.win.calcTurbMeter();
      assert.near(rv(app, 'tm_res', 'Vapour Pressure'), 514.7 * 6.89476, 0.6);   // kPa
      assert.near(rv(app, 'tm_res', 'Cavitation Margin'), 10.0, 0.051);
      assert.includes(app.el('tm_pv').parentNode.querySelector('label').textContent, 'kPa');
    },
  },
  {
    name: 'G1 chokeflow (ROADMAP 1.5): 7/64 and 20/64 coefficients flagged as out of line (values unchanged, caution shown)',
    wp: WP,
    run(app, assert) {
      app.hook.nav('chokeflow');
      const t = String(app.el('pgBody').textContent);
      assert.includes(t, 'out of line with their neighbours');
      assert.includes(t, '43.64 *');
      assert.includes(t, '5.166 *');
      // values kept as tabulated: 20/64, 3000 psig, 120 °F, SG 0.7 → 43.64·3014.7/√(0.7·580)
      set(app, { cf_cs: 20, cf_whp: 3000, cf_wht: 120, cf_sg: 0.7 });
      app.win.calcChokeGas();
      assert.rel(rv(app, 'cf_gres', 'Gas Rate'), 43.64 * 3014.7 / Math.sqrt(0.7 * 580), 1e-4);
      assert.includes(app.el('cf_gres').textContent, '20/64 table coefficient');
      // neighbour-consistent C/S² at 20/64 ≈ 0.10568 → C ≈ 42.27; the tabulated value is 3.2 % higher
      const cs2 = (37.98 / 361 + 46.818 / 441) / 2;
      assert.near(cs2 * 400, 42.27, 0.01);
      set(app, { cf_cs: 7 }); app.win.calcChokeGas();
      assert.includes(app.el('cf_gres').textContent, '7/64 table coefficient');
      set(app, { cf_cs: 32 }); app.win.calcChokeGas();
      assert.ok(!/table coefficient/.test(app.el('cf_gres').textContent), 'no caution at 32/64');
      noBadNumbers(assert, app, 'chokeflow suspect');
    },
  },
  // ── Console hygiene over every G1 page ─────────────────────────────────
  {
    name: 'G1 all pages: default Calculate on every page raises no console errors and shows no NaN/Infinity',
    wp: WP,
    run(app, assert) {
      const pages = [['aga3', 'calcAGA3'], ['choke', 'calcChoke'], ['chokeflow', 'calcChokeGas'], ['chokeflow', 'calcChokeOil'],
        ['gascalc', 'calcGasVel'], ['gascalc', 'calcGasQuick'], ['gascalc', 'calcGasGrad'], ['gascalc', 'calcGasGradSimple'],
        ['mcfshr', 'calcMCFShr'], ['turbmeter', 'calcTurbMeter'], ['chokecnv', null]];
      for (const [route, fn] of pages) {
        app.hook.nav(route);
        if (fn) app.win[fn]();
        noBadNumbers(assert, app, route + (fn ? '/' + fn : ''));
      }
      assert.deepEqual(app.consoleErrors(), [], 'no console errors');
    },
  },
];
