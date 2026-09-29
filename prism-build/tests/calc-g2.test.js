// Calculator audit G2 — Well & production calculators, driven through the real
// page (host nav → set inputs → click Calculate → read result rows).
//
//   bottomsup · casing · oilgas · solgor · fluid · tank · analogsig · units
//
// Expected values are independent hand calculations (see the per-test notes):
//   • API MPMS 11.1 (1980) / ASTM D1250 Tables 5A/6A: α60 = 341.0957/ρ60²,
//     VCF = exp[−α60·Δt·(1 + 0.8·α60·Δt)], hydrometer glass correction
//     1 − 1.278e-5·Δt − 6.2e-9·Δt², water 999.012 kg/m³.
//   • Standing (1947) Rs / Pb / Bo; Vasquez & Beggs (1980) Rs and γg normalisation.
//   • AGA-3 / API MPMS 14.3.1 RG flange-tap orifice Cd (oilgas uses the shared AGA-3 engine), solved
//     independently in SI mass-flow form (qm = C/√(1−β⁴)·ε·πd²/4·√(2Δp·ρ)).
//   • API 5CT casing/tubing IDs; capacity = ID²·π/4·12/9702 bbl/ft.
// Metric-mode tests enter the same physical case in metric units and expect the
// same physical answer.
'use strict';

const WP = 'G2';

function rows(app, resId) {
  return app.findAll('#' + resId + ' .rrow').map((r) => {
    const l = r.querySelector('.rl'), v = r.querySelector('.rv');
    return { l: String(l ? l.textContent : '').trim(), v: String(v ? v.textContent : '').trim() };
  });
}
// Numeric value of the first result row whose label contains `label` (n-th match).
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
function setMetric(app, on) {
  const U = app.win.WTS_units;
  assert_(U && typeof U.setSystem === 'function', 'WTS_units.setSystem present');
  U.setSystem(on ? 'metric' : 'imperial');
}
function assert_(c, m) { if (!c) throw new Error(m); }
function set(app, vals) { for (const k of Object.keys(vals)) app.input(k, String(vals[k])); }
function clickIn(app, rootSel, text) {
  const b = app.findAll(rootSel + ' button').find((x) => x.textContent.indexOf(text) !== -1);
  if (!b) throw new Error('no button "' + text + '" in ' + rootSel);
  app.click(b);
}
function reportHas(app, assert, needles) {
  const model = app.win.collectPageReport(app.el('pgBody'), { charts: false });
  const s = JSON.stringify(model);
  for (const n of needles) assert.includes(s, n, 'page report contains ' + n);
  assert.ok(model.inputs.length > 0, 'report has input sections');
  assert.ok(model.results.length > 0, 'report has result sections');
}

// ── Independent references ───────────────────────────────────────────────
// AGA-3 / API MPMS 14.3.1 RG flange-tap Cd + DAK Z (Standing pseudo-criticals), solved in
// SI mass-flow form — independent of the page's field-unit code (same as calc-g1 agaRef).
// Oil & Gas Rate uses the shared WTS_aga3_compute engine at 60 °F / 14.73 psia.
function ogDakZ(Tpr, Ppr) {
  const A = [0, 0.3265, -1.07, -0.5339, 0.01569, -0.05165, 0.5475, -0.7361, 0.1844, 0.1056, 0.6134, 0.7210];
  const Zof = (r) => 1 + (A[1] + A[2] / Tpr + A[3] / Tpr ** 3 + A[4] / Tpr ** 4 + A[5] / Tpr ** 5) * r
    + (A[6] + A[7] / Tpr + A[8] / Tpr ** 2) * r * r - A[9] * (A[7] / Tpr + A[8] / Tpr ** 2) * r ** 5
    + A[10] * (1 + A[11] * r * r) * (r * r / Tpr ** 3) * Math.exp(-A[11] * r * r);
  let lo = 1e-9, hi = 3;
  for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; if (Zof(m) - 0.27 * Ppr / (m * Tpr) > 0) hi = m; else lo = m; }
  return 0.27 * Ppr / (((lo + hi) / 2) * Tpr);
}
function ogAgaRef(D, d, hw, Ps, TfF, SG) {
  const TbF = 60, Pb = 14.73, mu = 0.012;
  const beta = d / D, b4 = beta ** 4, Ev = 1 / Math.sqrt(1 - b4);
  const Pf = Ps + 14.696, Tf = TfF + 459.67, Tb = TbF + 459.67;
  const Tpc = 168 + 325 * SG - 12.5 * SG * SG, Ppc = 677 + 15 * SG - 37.5 * SG * SG;
  const Z = ogDakZ(Tf / Tpc, Pf / Ppc);
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
  return { Z, Cd, mscfd: qm / rhob / 0.0283168466 * 3600 * 24 / 1000 };
}
const OG_DEF = ogAgaRef(4, 2, 50, 500, 100, 0.75);
const RW = 999.012;
function refApi60(api, t) {
  const d = t - 60;
  const r = 141.5 * RW / (api + 131.5) * (1 - 1.278e-5 * d - 6.2e-9 * d * d);
  let r60 = r;
  for (let i = 0; i < 100; i++) { const a = 341.0957 / (r60 * r60); r60 = r / Math.exp(-a * d * (1 + 0.8 * a * d)); }
  return 141.5 * RW / r60 - 131.5;
}
function refVcf(api60, t) {
  const r = 141.5 * RW / (api60 + 131.5), a = 341.0957 / (r * r), d = t - 60;
  return Math.exp(-a * d * (1 + 0.8 * a * d));
}

module.exports = [
  // ── Bottoms up ─────────────────────────────────────────────────────────
  {
    name: 'G2 bottomsup: 25 bbl @ 5000 BPD = 7.2 min (0:07:12); zero/blank rejected; no ":60" seconds',
    wp: WP,
    run(app, assert) {
      app.hook.nav('bottomsup');
      set(app, { bu_q: 5000, bu_vol: 25 });
      app.win.calcBottomsUp();
      assert.near(rv(app, 'bu_res', 'Flow Rate'), 3.4722, 1e-4);           // 5000/1440
      assert.near(rv(app, 'bu_res', 'Bottoms Up Time'), 7.2, 1e-9);        // 25/(5000/1440)
      assert.equal(rvText(app, 'bu_res', 'HH:MM:SS'), '0:07:12');
      // 7.9999 bbl at 1 bbl/min = 479.994 s → 0:08:00 (was "0:07:60")
      set(app, { bu_q: 1440, bu_vol: 7.9999 });
      app.win.calcBottomsUp();
      assert.equal(rvText(app, 'bu_res', 'HH:MM:SS'), '0:08:00');
      // 1000 bbl at 100 BPD = 14400 min = 240:00:00
      set(app, { bu_q: 100, bu_vol: 1000 });
      app.win.calcBottomsUp();
      assert.equal(rvText(app, 'bu_res', 'HH:MM:SS'), '240:00:00');
      set(app, { bu_q: 0, bu_vol: 25 }); app.win.calcBottomsUp();
      assert.match(errText(app, 'bu_res'), /Flow rate/);
      set(app, { bu_q: 5000, bu_vol: '' }); app.win.calcBottomsUp();
      assert.match(errText(app, 'bu_res'), /Tubing volume/);
      noBadNumbers(assert, app, 'bottomsup');
      assert.deepEqual(app.consoleErrors(), []);
    },
  },
  {
    name: 'G2 bottomsup metric: 794.94 m³/d and 3.97468 m³ give the same 7.2 min',
    wp: WP,
    run(app, assert) {
      setMetric(app, true);
      app.hook.nav('bottomsup');
      set(app, { bu_q: 5000 * 0.158987, bu_vol: 25 * 0.158987 });
      clickIn(app, '#pgBody', 'Calculate');
      assert.near(rv(app, 'bu_res', 'Bottoms Up Time'), 7.2, 1e-3);
      reportHas(app, assert, ['Bottoms Up Time', 'Tubing Volume']);
    },
  },

  // ── Casing & tubing ────────────────────────────────────────────────────
  {
    name: 'G2 casing: 4-1/2" 9.5# / 2-3/8" 4.7# capacities; API 5CT IDs; tubing that does not fit is rejected',
    wp: WP,
    run(app, assert) {
      app.hook.nav('casing');
      app.select('ct_cas', '0'); app.select('ct_tub', '0');
      set(app, { ct_cl: 10000, ct_tl: 9800 });
      app.win.calcCasing();
      const cap = (id) => id * id * Math.PI / 4 * 12 / 9702;
      assert.rel(rv(app, 'ct_res', 'Capacity', 0), cap(4.09), 2e-4);            // 0.016250 bbl/ft
      assert.rel(rv(app, 'ct_res', 'Total Volume', 0), cap(4.09) * 10000, 2e-4); // 162.5 bbl
      assert.rel(rv(app, 'ct_res', 'Capacity', 1), cap(1.995), 2e-4);           // 0.003866 bbl/ft
      const ann = cap(4.09) - cap(2.375);                                          // 0.010771 bbl/ft
      assert.rel(rv(app, 'ct_res', 'Annular Capacity', 0), ann, 2e-4);
      assert.rel(rv(app, 'ct_res', 'Annular Capacity', 1), ann * 0.158987294928 / 0.3048, 2e-4); // m³/m
      assert.rel(rv(app, 'ct_res', 'Total Annular Volume'), ann * 9800, 2e-4);
      // API 5CT: 4-1/2" 11.60 lb/ft → ID 4.000", 13.50 lb/ft → 3.920"
      app.select('ct_cas', '1'); app.win.calcCasing();
      assert.near(rv(app, 'ct_res', 'ID', 0), 4.0, 1e-9);
      app.select('ct_cas', '2'); app.win.calcCasing();
      assert.near(rv(app, 'ct_res', 'ID', 0), 3.92, 1e-9);
      // 4-1/2" tubing (OD 4.5) cannot go inside 4-1/2" casing
      const tIdx = app.findAll('#ct_tub option').findIndex((o) => /^4\.5"/.test(o.textContent));
      app.select('ct_tub', String(tIdx)); app.win.calcCasing();
      assert.match(errText(app, 'ct_res'), /does not fit/);
      app.select('ct_tub', '0'); set(app, { ct_cl: '' }); app.win.calcCasing();
      assert.match(errText(app, 'ct_res'), /lengths/);
      noBadNumbers(assert, app, 'casing');
      assert.deepEqual(app.consoleErrors(), []);
    },
  },
  {
    name: 'G2 casing metric: 3048 m of casing = 25.84 m³ (162.5 bbl); IDs in mm, capacities in m³/m',
    wp: WP,
    run(app, assert) {
      setMetric(app, true);
      app.hook.nav('casing');
      app.select('ct_cas', '0'); app.select('ct_tub', '0');
      set(app, { ct_cl: 3048, ct_tl: 2987.04 });
      clickIn(app, '#pgBody', 'Calculate');
      const M3 = 0.158987294928;
      assert.rel(rv(app, 'ct_res', 'Total Volume', 0), 0.0162501 * 10000 * M3, 5e-4);        // 25.84 m³
      assert.rel(rv(app, 'ct_res', 'Total Annular Volume'), 0.0107707 * 9800 * M3, 5e-4);
      assert.rel(rv(app, 'ct_res', 'Capacity', 0), 0.0162501 * M3 / 0.3048, 5e-4);            // m³/m
      assert.near(rv(app, 'ct_res', 'ID', 0), 4.09 * 25.4, 0.051);                             // 103.9 mm
      const t = String(app.el('ct_res').textContent);
      assert.ok(!/bbl/.test(t), 'no bbl in metric casing results: ' + t);
      assert.includes(t, 'm³/m');
      assert.equal(rows(app, 'ct_res').filter((r) => r.l === 'Annular Capacity').length, 1, 'one annular capacity row in metric');
      reportHas(app, assert, ['Casing Length', 'Annular Capacity']);
    },
  },

  // ── Oil & gas rate ─────────────────────────────────────────────────────
  {
    name: 'G2 oilgas: API 35 @ 80°F hydrometer → 33.49 API@60; VCF(120°F) 0.97190; oil 97.72 BPD; AGA-3 gas (shared engine, DAK Z) matches an independent RG + DAK solve',
    wp: WP,
    run(app, assert) {
      app.hook.nav('oilgas');
      set(app, { og_int: 60, og_api: 35, og_ht: 80, og_m0: 1000, og_m1: 1004.5, og_olt: 120, og_bsw: 2, og_mf: 1, og_sf: 0.95,
        og_run: 4, og_plate: 2, og_sp: 500, og_dp: 50, og_gg: 0.75, og_gt: 100 });
      app.win.calcOilGas();
      const api60 = refApi60(35, 80);                     // 33.491
      const vcf = refVcf(api60, 120);                     // 0.971900
      const oil = 4.5 * 24 * 0.95 * 0.98 * vcf;           // 97.723 BPD
      assert.near(rv(app, 'og_res', 'API @ 60'), api60, 0.051);
      assert.near(rv(app, 'og_res', 'VCF'), vcf, 2e-6);
      assert.near(rv(app, 'og_res', 'Oil Rate'), oil, 0.051);
      // Independent SI solve of the AGA-3 RG flange-tap Cd (μ 0.012 cP) with DAK Z and Standing (1977)
      // pseudo-criticals (Tpc 404.7 °R, Ppc 667.2 psia → Tpr 1.383, Ppr 0.7715, Z 0.89999).
      // (ISO 5167-2 Cd gave 3800.75 MSCFD / C 0.60301; Papay Z gave 3792.68.)
      const gas = rv(app, 'og_res', 'Gas Rate');
      assert.rel(gas, OG_DEF.mscfd, 5e-4);
      assert.rel(gas, 3800.75, 3e-3, 'within 0.3 % of the former ISO 5167-2 figure');
      assert.near(rv(app, 'og_res', 'Z-Factor'), 0.89999, 2e-4);
      assert.near(rv(app, 'og_res', 'Discharge Coeff'), OG_DEF.Cd, 2e-5);
      // Same engine as the AGA-3 page: identical rate from WTS_aga3_compute
      const eng = app.win.WTS_aga3_compute({ D: 4, d: 2, hw: 50, Ps: 500, TfF: 100, SG: 0.75, TbF: 60, Pb: 14.73 });
      assert.rel(gas, eng.Qmscfd, 2e-6);
      assert.rel(rv(app, 'og_res', 'GOR'), gas * 1000 / oil, 2e-3);
      assert.rel(rv(app, 'og_res', 'CGR'), oil / (gas / 1000), 2e-3);
      // β = 0.7 (2.8" plate in a 4" run)
      const b7 = ogAgaRef(4, 2.8, 50, 500, 100, 0.75);
      set(app, { og_plate: 2.8 }); app.win.calcOilGas();
      assert.rel(rv(app, 'og_res', 'Gas Rate'), b7.mscfd, 5e-4);
      assert.near(rv(app, 'og_res', 'Discharge Coeff'), b7.Cd, 3e-5);
      // hydrometer at 60°F and oil line at 60°F → no correction at all
      set(app, { og_plate: 2, og_ht: 60, og_olt: 60 }); app.win.calcOilGas();
      assert.near(rv(app, 'og_res', 'VCF'), 1, 1e-9);
      assert.near(rv(app, 'og_res', 'API @ 60'), 35, 1e-9);
      noBadNumbers(assert, app, 'oilgas');
    },
  },
  {
    name: 'G2 oilgas: small 2" run, zero dP and invalid inputs never show NaN/∞',
    wp: WP,
    run(app, assert) {
      app.hook.nav('oilgas');
      set(app, { og_int: 60, og_api: 35, og_ht: 60, og_m0: 0, og_m1: 10, og_olt: 60, og_bsw: 0, og_mf: 1, og_sf: 1,
        og_run: 2.067, og_plate: 1.0, og_sp: 100, og_dp: 25, og_gg: 0.65, og_gt: 80 });
      app.win.calcOilGas();
      // independent AGA-3 RG solve incl. the small-pipe M1 term (D < 2.8 in), DAK Z
      const sm = ogAgaRef(2.067, 1.0, 25, 100, 80, 0.65);
      assert.rel(rv(app, 'og_res', 'Gas Rate'), sm.mscfd, 5e-4);
      assert.near(rv(app, 'og_res', 'Discharge Coeff'), sm.Cd, 3e-5);
      assert.near(rv(app, 'og_res', 'Oil Rate'), 240, 1e-9);                 // 10 bbl/h × 24
      set(app, { og_dp: 0 }); app.win.calcOilGas();
      assert.equal(rv(app, 'og_res', 'Gas Rate'), 0);
      noBadNumbers(assert, app, 'oilgas dp=0');
      set(app, { og_int: 0 }); app.win.calcOilGas();
      assert.match(errText(app, 'og_res'), /interval/);
      set(app, { og_int: 60, og_plate: 4.5, og_run: 4 }); app.win.calcOilGas();
      assert.match(errText(app, 'og_res'), /smaller than the meter run/);
      set(app, { og_plate: 2, og_m1: -5 }); app.win.calcOilGas();
      assert.match(errText(app, 'og_res'), /meter reading/);
      set(app, { og_m1: 10, og_gg: '' }); app.win.calcOilGas();
      assert.match(errText(app, 'og_res'), /Gas gravity/);
      noBadNumbers(assert, app, 'oilgas invalid');
      assert.deepEqual(app.consoleErrors(), []);
    },
  },
  {
    name: 'G2 oilgas metric: same physical case in m³, °C, kPa(g), mm, mbar gives the same rates',
    wp: WP,
    run(app, assert) {
      setMetric(app, true);
      app.hook.nav('oilgas');
      const C = (f) => (f - 32) * 5 / 9;
      set(app, { og_int: 60, og_api: 35, og_ht: C(80), og_m0: 1000 * 0.158987, og_m1: 1004.5 * 0.158987, og_olt: C(120),
        og_bsw: 2, og_mf: 1, og_sf: 0.95, og_run: 101.6, og_plate: 50.8, og_sp: 500 * 6.89476, og_dp: 50 * 68.94757 / 27.707,
        og_gg: 0.75, og_gt: C(100) });
      clickIn(app, '#pgBody', 'Calculate');
      const vcf = refVcf(refApi60(35, 80), 120);
      // Results in metric: oil m³/d, gas m³/d, GOR sm³/sm³, CGR m³/10⁶ m³.
      const oilBpd = 4.5 * 24 * 0.95 * 0.98 * vcf;
      assert.rel(rv(app, 'og_res', 'Oil Rate'), oilBpd * 0.158987, 2e-3);
      assert.rel(rv(app, 'og_res', 'Gas Rate'), OG_DEF.mscfd * 28.3168466, 1.5e-3);
      assert.rel(rv(app, 'og_res', 'GOR'), OG_DEF.mscfd * 1e3 / oilBpd * 0.178108, 2e-3);
      assert.rel(rv(app, 'og_res', 'CGR'), oilBpd / 3.80075 * 5.61458, 2e-3);
      const t = String(app.el('og_res').textContent);
      assert.ok(!/BPD|MSCFD|scf|bbl/.test(t), 'no field units in metric results: ' + t);
      assert.includes(t, 'm³/d'); assert.includes(t, 'sm³/sm³'); assert.includes(t, 'm³/10⁶ m³');
      reportHas(app, assert, ['Oil Rate', 'Gas Rate', 'Hydrometer Temp']);
    },
  },
  {
    name: 'G2 oilgas (fix): GOR/CGR show — when oil or gas rate is zero, never a false 0',
    wp: WP,
    run(app, assert) {
      app.hook.nav('oilgas');
      set(app, { og_int: 60, og_api: 35, og_ht: 80, og_m0: 100, og_m1: 100, og_olt: 120, og_bsw: 2, og_mf: 1, og_sf: 0.95,
        og_run: 4, og_plate: 2, og_sp: 500, og_dp: 50, og_gg: 0.75, og_gt: 100 });
      app.win.calcOilGas();
      assert.equal(rv(app, 'og_res', 'Oil Rate'), 0);
      assert.rel(rv(app, 'og_res', 'Gas Rate'), OG_DEF.mscfd, 1e-3);
      assert.match(rvText(app, 'og_res', 'GOR'), /^—/, 'GOR with no oil is —');
      assert.ok(!/\d/.test(rvText(app, 'og_res', 'GOR')), 'GOR shows no number: ' + rvText(app, 'og_res', 'GOR'));
      assert.equal(rv(app, 'og_res', 'CGR'), 0);                       // 0 bbl/MMscf is real here
      set(app, { og_m1: 104.5, og_dp: 0 }); app.win.calcOilGas();
      assert.equal(rv(app, 'og_res', 'Gas Rate'), 0);
      assert.match(rvText(app, 'og_res', 'CGR'), /^—/, 'CGR with no gas is —');
      assert.ok(!/\d/.test(rvText(app, 'og_res', 'CGR')), 'CGR shows no number');
      assert.equal(rv(app, 'og_res', 'GOR'), 0);                       // 0 scf/bbl is real here
      noBadNumbers(assert, app, 'oilgas zero rates');
      assert.deepEqual(app.consoleErrors(), []);
    },
  },
  {
    name: 'G2 oilgas (fix): How It Works names the shared AGA-3 engine and DAK Z actually used (not ISO 5167-2 / Papay)',
    wp: WP,
    run(app, assert) {
      app.hook.nav('oilgas');
      const t = String(app.el('pgBody').textContent || '');
      assert.includes(t, 'same AGA-3 engine');
      assert.includes(t, 'API MPMS 14.3.1');
      assert.ok(!/ISO 5167-2/.test(t), 'ISO 5167-2 Cd no longer used');
      assert.ok(!/can differ by a fraction/.test(t), 'pages no longer differ');
      assert.includes(t, 'Dranchuk');
      assert.ok(!/Papay/.test(t), 'Papay no longer named on the page');
      assert.includes(t, 'inH2O at 60°F');
      assert.ok(!/Gas rate uses AGA-3 orifice metering/.test(t), 'old AGA-3-only wording removed');
    },
  },
  {
    name: 'G2 oilgas (fix): metric dP uses inH2O @ 60°F — 199.07 mbar = 80 inH2O gives the imperial gas rate',
    wp: WP,
    run(app, assert) {
      const base = { og_int: 60, og_api: 35, og_bsw: 0, og_mf: 1, og_sf: 1, og_gg: 0.75 };
      app.hook.nav('oilgas');
      set(app, Object.assign({}, base, { og_ht: 60, og_m0: 0, og_m1: 10, og_olt: 60, og_run: 4, og_plate: 1.5,
        og_sp: 300, og_dp: 80, og_gt: 80 }));
      app.win.calcOilGas();
      const imp = rv(app, 'og_res', 'Gas Rate');
      assert.equal(app.win.WTS_units.CATEGORIES.pressureSmall60.imperial.factor, 2.48845);
      setMetric(app, true);
      app.hook.nav('oilgas');
      const C = (f) => (f - 32) * 5 / 9;
      set(app, Object.assign({}, base, { og_ht: C(60), og_m0: 0, og_m1: 10 * 0.158987, og_olt: C(60), og_run: 101.6,
        og_plate: 38.1, og_sp: 300 * 6.89476, og_dp: 80 * 68.94757 / 27.707, og_gt: C(80) }));
      clickIn(app, '#pgBody', 'Calculate');
      assert.rel(rv(app, 'og_res', 'Gas Rate'), imp * 28.3168466, 1e-4);  // m³/d; was −5e-4 with the 39.2 °F column
      const lab = app.el('og_dp').parentNode.querySelector('label').textContent;
      assert.includes(lab, 'mbar');
    },
  },

  {
    name: 'G2 oilgas (ROADMAP 1.5): DAK Z above Ppr 3 — 3000 psig gives Z 0.7318 (Papay read 0.7594) and 10,201 MSCFD',
    wp: WP,
    run(app, assert) {
      app.hook.nav('oilgas');
      set(app, { og_int: 60, og_api: 35, og_ht: 60, og_m0: 0, og_m1: 10, og_olt: 60, og_bsw: 0, og_mf: 1, og_sf: 1,
        og_run: 4, og_plate: 2, og_sp: 3000, og_dp: 50, og_gg: 0.75, og_gt: 100 });
      app.win.calcOilGas();
      // Standing pseudo-criticals: Ppr = 3014.696/667.16 = 4.519, Tpr = 559.67/404.72 = 1.383.
      // Independent Newton-on-ρr DAK: Z = 0.73182 (Standing-Katz chart ≈ 0.73). Independent SI
      // AGA-3 RG solve (ISO 5167-2 gave 10,201.3 MSCFD; Papay's 0.75943 under-read the rate by 1.8 %).
      const hp = ogAgaRef(4, 2, 50, 3000, 100, 0.75);
      assert.near(hp.Z, 0.7318, 2e-4, 'reference Z');
      assert.near(rv(app, 'og_res', 'Z-Factor'), 0.7318, 2e-4);
      assert.rel(rv(app, 'og_res', 'Gas Rate'), hp.mscfd, 5e-4);
      assert.near(rv(app, 'og_res', 'Discharge Coeff'), hp.Cd, 3e-5);
      assert.ok(!/outside the Dranchuk/.test(app.el('og_res').textContent), 'inside the DAK range: no caution');
      // Very cold gas: SG 0.75 at −80 °F → Tpr 0.94 < 1.0 → range caution, still a finite rate
      set(app, { og_sp: 500, og_gt: -80 }); app.win.calcOilGas();
      assert.includes(app.el('og_res').textContent, 'outside the Dranchuk');
      noBadNumbers(assert, app, 'oilgas dak');
      assert.deepEqual(app.consoleErrors(), []);
    },
  },

  // ── Solution GOR ───────────────────────────────────────────────────────
  {
    name: 'G2 solgor: 500 psig, 150°F, γg 0.75, 35 API → Standing 102.74, Vasquez-Beggs 104.82 scf/STB (γgs 0.9018)',
    wp: WP,
    run(app, assert) {
      app.hook.nav('solgor');
      set(app, { sg_p: 500, sg_t: 150, sg_gg: 0.75, sg_api: 35 });
      app.win.calcSolGOR();
      // Standing: 0.75·[(514.7/18.2+1.4)·10^(0.4375−0.1365)]^1.2048
      const st = 0.75 * Math.pow((514.7 / 18.2 + 1.4) * Math.pow(10, 0.0125 * 35 - 0.00091 * 150), 1.2048);
      // V&B γg correction to a 100 psig separator (blank separator fields = 500 psig, 150 °F):
      //   γgs = 0.75·[1 + 5.912e-5·35·150·log10(514.7/114.7)] = 0.75·1.20237 = 0.90177
      const ggs = 0.75 * (1 + 5.912e-5 * 35 * 150 * Math.log10(514.7 / 114.7));
      // V&B (API > 30): 0.0178·γgs·514.7^1.187·exp(23.931·35/610) = 104.82 (87.18 with the raw 0.75)
      const vb = 0.0178 * ggs * Math.pow(514.7, 1.187) * Math.exp(23.931 * 35 / 610);
      assert.near(ggs, 0.90177, 1e-5);
      assert.near(rv(app, 'sg_res', 'Standing'), st, 0.051);
      assert.near(rv(app, 'sg_res', 'Vasquez'), vb, 0.051);
      assert.near(rv(app, 'sg_res', 'Gas Gravity (V'), 0.9018, 1e-4);
      assert.near(rv(app, 'sg_res', 'Gas Gravity (Standing)'), 0.75, 1e-9);
      assert.includes(app.el('sg_res').textContent, 'separator pressure and oil line temperature above');
      // Gas gravity measured on a 100 psig separator: log10(1) = 0 → used as entered (87.18)
      set(app, { sg_psep: 100, sg_tsep: 150 }); app.win.calcSolGOR();
      assert.near(rv(app, 'sg_res', 'Vasquez'), 0.0178 * 0.75 * Math.pow(514.7, 1.187) * Math.exp(23.931 * 35 / 610), 0.051);
      assert.near(rv(app, 'sg_res', 'Vasquez'), 87.18, 0.051);
      // 200 psig / 80 °F separator: γgs = 0.75·[1 + 5.912e-5·35·80·log10(214.7/114.7)] = 0.78380 → 91.11
      set(app, { sg_psep: 200, sg_tsep: 80 }); app.win.calcSolGOR();
      assert.near(rv(app, 'sg_res', 'Gas Gravity (V'), 0.7838, 1e-4);
      assert.near(rv(app, 'sg_res', 'Vasquez'), 91.11, 0.051);
      assert.near(rv(app, 'sg_res', 'Standing'), st, 0.051);          // Standing unaffected
      // Heavy oil bracket (API ≤ 30): C1 0.0362, C2 1.0937, C3 25.724; γgs(API 25) = 0.85841
      set(app, { sg_psep: '', sg_tsep: '', sg_api: 25 }); app.win.calcSolGOR();
      const ggs25 = 0.75 * (1 + 5.912e-5 * 25 * 150 * Math.log10(514.7 / 114.7));
      assert.near(rv(app, 'sg_res', 'Vasquez'), 0.0362 * ggs25 * Math.pow(514.7, 1.0937) * Math.exp(25.724 * 25 / 610), 0.051);
      assert.near(rv(app, 'sg_res', 'Vasquez'), 82.39, 0.051);
      set(app, { sg_api: 35, sg_psep: -20 }); app.win.calcSolGOR();
      assert.match(errText(app, 'sg_res'), /separator pressure/);
      set(app, { sg_psep: '' });
      set(app, { sg_t: '' }); app.win.calcSolGOR();
      assert.match(errText(app, 'sg_res'), /temperature/);
      set(app, { sg_t: 150, sg_p: 0 }); app.win.calcSolGOR();
      assert.match(errText(app, 'sg_res'), /Pressure/);
      noBadNumbers(assert, app, 'solgor');
      assert.deepEqual(app.consoleErrors(), []);
    },
  },
  {
    name: 'G2 solgor metric: 3447.38 kPa(g) / 65.56 °C give the same Rs',
    wp: WP,
    run(app, assert) {
      setMetric(app, true);
      app.hook.nav('solgor');
      set(app, { sg_p: 500 * 6.89476, sg_t: (150 - 32) * 5 / 9, sg_gg: 0.75, sg_api: 35 });
      clickIn(app, '#pgBody', 'Calculate');
      assert.near(rv(app, 'sg_res', 'Standing'), 102.74 * 0.178108, 0.011);   // sm³/sm³
      assert.near(rv(app, 'sg_res', 'Vasquez'), 104.82 * 0.178108, 0.011);
      // separator fields in kPa(g)/°C: 100 psig = 689.476 kPa(g), 150 °F = 65.56 °C → raw gravity, 87.18 scf/STB
      set(app, { sg_psep: 100 * 6.89476, sg_tsep: (150 - 32) * 5 / 9 });
      clickIn(app, '#pgBody', 'Calculate');
      assert.near(rv(app, 'sg_res', 'Vasquez'), 87.18 * 0.178108, 0.011);
      assert.near(rv(app, 'sg_res', 'Gas Gravity (V'), 0.75, 1e-4);
      assert.includes(app.el('sg_psep').parentNode.querySelector('label').textContent, 'kPa');
      assert.includes(rvText(app, 'sg_res', 'Standing'), 'sm³/sm³');
      reportHas(app, assert, ['Rs (Standing)', 'Separator Pressure']);
    },
  },

  // ── Fluid properties ───────────────────────────────────────────────────
  {
    name: 'G2 fluid: Table 5A 42.8 API @ 76°F → 41.4; 30.0 @ 100°F → 27.3; SG↔API',
    wp: WP,
    run(app, assert) {
      app.hook.nav('fluid');
      set(app, { fp_api: 42.8, fp_t: 76 }); app.win.calcAPIcorr();
      assert.near(rv(app, 'fp_res', 'API @ 60'), refApi60(42.8, 76), 0.051);   // 41.41
      assert.near(rv(app, 'fp_res', 'SG @ 60'), 141.5 / (refApi60(42.8, 76) + 131.5), 1e-4);
      set(app, { fp_api: 30, fp_t: 100 }); app.win.calcAPIcorr();
      assert.near(rv(app, 'fp_res', 'API @ 60'), 27.3, 0.051);                // 27.29
      set(app, { fp_api: 35, fp_t: 60 }); app.win.calcAPIcorr();
      assert.near(rv(app, 'fp_res', 'API @ 60'), 35, 1e-9);
      assert.near(rv(app, 'fp_res', 'Volume Correction'), 1, 1e-12);
      set(app, { fp_api: '' }); app.win.calcAPIcorr();
      assert.match(errText(app, 'fp_res'), /valid observed API/);
      set(app, { fp_sg: 0.816 }); app.win.sgToAPI();
      assert.near(rv(app, 'fp_res2', 'API Gravity'), 141.5 / 0.816 - 131.5, 0.051);   // 41.9
      set(app, { fp_api2: 10 }); app.win.apiToSG();
      assert.near(rv(app, 'fp_res2', 'Specific Gravity'), 1, 1e-4);
      set(app, { fp_sg: 0 }); app.win.sgToAPI();
      assert.match(errText(app, 'fp_res2'), /greater than zero/);
      noBadNumbers(assert, app, 'fluid api');
    },
  },
  {
    name: 'G2 fluid: Standing bubble point with V&B gravity (psia); separator shrinkage via Standing Rs + Bo',
    wp: WP,
    run(app, assert) {
      app.hook.nav('fluid');
      app.click('flt2');
      set(app, { bp_api: 45, bp_gor: 300, bp_gg: 0.7, bp_st: 110, bp_sp: 500, bp_rt: 440 });
      app.win.calcBubblePoint();
      const ygs = 0.7 * (1 + 5.912e-5 * 45 * 110 * Math.log10(514.7 / 114.7));        // 0.83356
      const pb = 18.2 * (Math.pow(300 / ygs, 0.83) * Math.pow(10, 0.00091 * 440 - 0.0125 * 45) - 1.4); // 1632.6 psia
      assert.near(rv(app, 'bp_res', 'Corrected Gas Gravity'), ygs, 1e-4);
      assert.near(rv(app, 'bp_res', 'Bubble Point Pressure', 0), pb, 0.051);
      assert.near(rv(app, 'bp_res', 'Bubble Point Pressure', 1), pb * 6.89476, 0.051);
      // GOR too low → Pb ≤ 0 is reported, not shown as |Pb|
      set(app, { bp_gor: 2, bp_rt: 100 }); app.win.calcBubblePoint();
      assert.match(errText(app, 'bp_res'), /too low/);
      noBadNumbers(assert, app, 'fluid bp');

      app.click('flt3');
      set(app, { sf_sp: 710, sf_st: 121, sf_gg: 0.751, sf_api: 52 });
      app.win.calcShrinkage();
      const go = 141.5 / 183.5;
      const rs = 0.751 * Math.pow((724.7 / 18.2 + 1.4) * Math.pow(10, 0.0125 * 52 - 0.00091 * 121), 1.2048); // 296.46
      const bo = 0.9759 + 0.00012 * Math.pow(rs * Math.sqrt(0.751 / go) + 1.25 * 121, 1.2);             // 1.15613
      assert.near(rv(app, 'sf_res', 'Solution GOR'), rs, 0.051);
      assert.near(rv(app, 'sf_res', 'Bo (FVF)'), bo, 1e-4);
      assert.near(rv(app, 'sf_res', 'Shrinkage Factor'), 1 / bo, 1e-4);          // 0.865
      // Stock-tank conditions (0 psig, 60°F): Bo stays close to 1
      set(app, { sf_sp: 0, sf_st: 60 }); app.win.calcShrinkage();
      assert.within(rv(app, 'sf_res', 'Bo (FVF)'), 1.0, 1.1);
      set(app, { sf_gg: '' }); app.win.calcShrinkage();
      assert.match(errText(app, 'sf_res'), /Gas gravity/);
      noBadNumbers(assert, app, 'fluid shrinkage');
      assert.deepEqual(app.consoleErrors(), []);
    },
  },
  {
    name: 'G2 fluid metric: 42.8 API at 24.44 °C → 41.4 API@60°F',
    wp: WP,
    run(app, assert) {
      setMetric(app, true);
      app.hook.nav('fluid');
      set(app, { fp_api: 42.8, fp_t: (76 - 32) * 5 / 9 });
      clickIn(app, '#pgBody', 'Correct to 60');
      assert.near(rv(app, 'fp_res', 'API @ 60'), 41.4, 0.051);
      reportHas(app, assert, ['API @ 60', 'Observed API Gravity']);
    },
  },
  {
    name: 'G2 fluid metric (fix): API tab stays tagged in °C after Bubble Point → API Gravity',
    wp: WP,
    run(app, assert) {
      setMetric(app, true);
      app.hook.nav('fluid');
      app.click('flt2');
      app.click('flt1');
      app.flush(50);
      const t = app.el('fp_t');
      assert.equal(t.getAttribute('data-wts-unit-cat'), 'temperature');
      assert.includes(t.parentNode.querySelector('label').textContent, '°C');
      set(app, { fp_api: 25, fp_t: 48.89 });
      clickIn(app, '#pgBody', 'Correct to 60');
      assert.near(rv(app, 'fp_res', 'API @ 60'), refApi60(25, 48.89 * 9 / 5 + 32), 0.051);   // 21.4, not 25.7
      assert.deepEqual(app.consoleErrors(), []);
    },
  },

  // ── Tank ───────────────────────────────────────────────────────────────
  {
    name: 'G2 tank: rectangular / vertical / horizontal volumes and strapping; clamps and validation',
    wp: WP,
    run(app, assert) {
      app.hook.nav('tank');
      set(app, { tr_h: 48, tr_l: 120, tr_w: 60, tr_fl: 24 }); app.win.calcRectTank();
      assert.near(rv(app, 'tr_res', 'Total Capacity'), 48 * 120 * 60 / 9702, 0.001);   // 35.622 bbl
      assert.near(rv(app, 'tr_res', 'Fill'), 50, 1e-9);
      assert.near(rv(app, 'tr_res', 'Strapping'), 7200 / 9702, 1e-4);                   // 0.7421 bbl/in
      set(app, { tr_fl: 60 }); app.win.calcRectTank();                                   // above the roof
      assert.near(rv(app, 'tr_res', 'Fill'), 100, 1e-9);
      assert.near(rv(app, 'tr_res', 'Fluid Volume'), 48 * 120 * 60 / 9702, 0.001);
      set(app, { tr_w: '' }); app.win.calcRectTank();
      assert.match(errText(app, 'tr_res'), /greater than zero/);

      set(app, { tv_d: 120, tv_h: 180, tv_fl: 60 }); app.win.calcVertTank();
      const A = Math.PI * 120 * 120 / 4;
      assert.near(rv(app, 'tv_res', 'Total Capacity'), A * 180 / 9702, 0.01);           // 209.83 bbl
      assert.near(rv(app, 'tv_res', 'Fluid Volume'), A * 60 / 9702, 0.01);              // 69.94 bbl
      assert.near(rv(app, 'tv_res', 'Strapping'), A / 9702, 1e-4);                      // 1.1657 bbl/in

      set(app, { tc_d: 42, tc_l: 10, tc_fl: 21 }); app.win.calcCylTank();               // half full
      assert.near(rv(app, 'tc_res', 'Total Capacity'), Math.PI * 441 * 120 / 9702, 0.01); // 17.14 bbl
      assert.near(rv(app, 'tc_res', 'Fill'), 50, 1e-9);
      assert.near(rv(app, 'tc_res', 'local dV/dh'), 120 * 2 * 21 / 9702, 1e-4);          // 0.5195 bbl/in
      set(app, { tc_fl: 10.5 }); app.win.calcCylTank();                                 // h/D = 0.25 → 19.550 %
      assert.near(rv(app, 'tc_res', 'Fill'), 19.6, 0.051);
      set(app, { tc_l: '' }); app.win.calcCylTank();
      assert.match(errText(app, 'tc_res'), /length/);

      set(app, { tk_v1: 0, tk_v2: 5.2, tk_t1: 0, tk_t2: 1 }); app.win.calcTankRate();
      assert.near(rv(app, 'tk_res', 'Rate', 1), 124.8, 1e-9);
      set(app, { tk_v2: '' }); app.win.calcTankRate();
      assert.match(errText(app, 'tk_res'), /volumes/);

      set(app, { tw_ppg: 8.34, tw_gal: 1000, tw_tare: 4, tw_area: 50 }); app.win.calcTankWeight();
      assert.near(rv(app, 'tw_res', 'Deck Loading'), (4 + 4.17) * 2000 / 50, 0.51);    // 326.8 lb/ft²
      set(app, { tw_area: 0 }); app.win.calcTankWeight();
      assert.match(errText(app, 'tw_res'), /footprint/);
      noBadNumbers(assert, app, 'tank');
      assert.deepEqual(app.consoleErrors(), []);
    },
  },
  {
    name: 'G2 tank metric: 304.8 cm vertical tank → 72.966 L/cm, 33.36 m³ per 457.2 cm',
    wp: WP,
    run(app, assert) {
      setMetric(app, true);
      app.hook.nav('tank');
      set(app, { tv_d: 304.8, tv_h: 457.2, tv_fl: 152.4 });
      app.win.calcVertTank();
      const Acm2 = Math.PI * 304.8 * 304.8 / 4;
      assert.near(rv(app, 'tv_res', 'Strapping'), Acm2 / 1000, 0.002);                  // L/cm
      assert.near(rv(app, 'tv_res', 'Total Capacity'), Acm2 * 457.2 / 1e6, 0.002);       // m³
      reportHas(app, assert, ['Vertical Cylindrical Tank', 'L/cm']);
    },
  },

  // ── Analog signal ──────────────────────────────────────────────────────
  {
    name: 'G2 analogsig: 12 mA → 50 %; PV 75 of 0–100 → 16 mA / 7.5 V; NAMUR fault band flagged; zero span rejected',
    wp: WP,
    run(app, assert) {
      app.hook.nav('analogsig');
      app.select('as_type', 'mA'); set(app, { as_val: 12, as_lo: 0, as_hi: 100 }); app.win.calcAnalogSig();
      assert.near(rv(app, 'as_res', 'Process Value'), 50, 1e-9);
      assert.near(rv(app, 'as_res', 'Voltage'), 5, 1e-9);
      app.select('as_type', 'PV'); set(app, { as_val: 75, as_lo: 0, as_hi: 100 }); app.win.calcAnalogSig();
      assert.near(rv(app, 'as_res', 'Current'), 16, 1e-9);
      assert.near(rv(app, 'as_res', 'Voltage'), 7.5, 1e-9);
      // 0–10 V, range 200–1200 psi: 2.5 V → 450 psi, 8 mA
      app.select('as_type', 'V'); set(app, { as_val: 2.5, as_lo: 200, as_hi: 1200 }); app.win.calcAnalogSig();
      assert.near(rv(app, 'as_res', 'Process Value'), 450, 1e-9);
      assert.near(rv(app, 'as_res', 'Current'), 8, 1e-9);
      app.select('as_type', 'mA'); set(app, { as_val: 2, as_lo: 0, as_hi: 100 }); app.win.calcAnalogSig();
      assert.match(errText(app, 'as_res'), /NAMUR/);
      set(app, { as_val: 12, as_hi: 0 }); app.win.calcAnalogSig();
      assert.match(errText(app, 'as_res'), /differ/);
      set(app, { as_val: '' , as_hi: 100 }); app.win.calcAnalogSig();
      assert.match(errText(app, 'as_res'), /input value/);
      noBadNumbers(assert, app, 'analogsig');
      assert.deepEqual(app.consoleErrors(), []);
    },
  },

  // ── Unit conversions ───────────────────────────────────────────────────
  {
    name: 'G2 units: 1 ft³/min = 256.475 BPD; 1 MMSCF/D = 28 316.8 Sm³/d; 100 °C = 212 °F; SG 0 → API shows —',
    wp: WP,
    run(app, assert) {
      app.hook.nav('units');
      const num = (s) => parseFloat(String(s).replace(/,/g, ''));
      clickIn(app, '#pgBody .tabs', 'Liquid Flow Rate');
      app.change('uc_from', 'ft3/min'); app.change('uc_to', 'BPD'); app.input('uc_val', '1');
      assert.rel(num(app.el('uc_res').value), 1440 * Math.pow(0.3048, 3) / 0.158987294928, 1e-5);
      app.change('uc_from', 'm3/d'); app.input('uc_val', '1');
      assert.rel(num(app.el('uc_res').value), 6.28981, 1e-5);
      clickIn(app, '#pgBody .tabs', 'Gas Flow Rate');
      app.change('uc_from', 'MMSCF/D'); app.change('uc_to', 'Sm3/d'); app.input('uc_val', '1');
      assert.rel(num(app.el('uc_res').value), 28316.8, 1e-4);
      clickIn(app, '#pgBody .tabs', 'Temperature');
      app.change('uc_from', 'C'); app.change('uc_to', 'F'); app.input('uc_val', '100');
      assert.near(num(app.el('uc_res').value), 212, 1e-9);
      app.input('uc_val', '-300');                                   // below absolute zero
      assert.equal(app.el('uc_res').value, '—');
      clickIn(app, '#pgBody .tabs', 'Density');
      app.change('uc_from', 'SG'); app.change('uc_to', 'API'); app.input('uc_val', '0.85');
      assert.near(num(app.el('uc_res').value), 141.5 / 0.85 - 131.5, 1e-4);
      app.input('uc_val', '0');
      assert.equal(app.el('uc_res').value, '—');
      clickIn(app, '#pgBody .tabs', 'Pressure');
      app.change('uc_from', 'bar'); app.change('uc_to', 'psi'); app.input('uc_val', '1');
      assert.rel(num(app.el('uc_res').value), 14.5038, 1e-5);
      noBadNumbers(assert, app, 'units');
      assert.deepEqual(app.consoleErrors(), []);
    },
  },

  // ── Phone width ────────────────────────────────────────────────────────
  {
    name: 'G2 all pages render and calculate at 375 px without console errors',
    wp: WP,
    opts: { viewport: { width: 375, height: 812 } },
    run(app, assert) {
      const pages = [['bottomsup', 'calcBottomsUp'], ['casing', 'calcCasing'], ['oilgas', 'calcOilGas'], ['solgor', 'calcSolGOR'],
        ['fluid', 'calcAPIcorr'], ['tank', 'calcCylTank'], ['analogsig', 'calcAnalogSig'], ['units', null]];
      for (const [p, fn] of pages) {
        app.hook.nav(p);
        if (fn) app.win[fn]();
        noBadNumbers(assert, app, p + ' @375');
        assert.ok(app.findAll('#pgBody .rrow, #pgBody #uc_res').length > 0, p + ' shows results');
      }
      assert.deepEqual(app.consoleErrors(), []);
    },
  },
  {
    name: 'G2 fluid metric (fix): Bubble Point and Shrinkage inputs are unit-tagged; results in kPa(a) / sm³/sm³',
    wp: WP,
    run(app, assert) {
      setMetric(app, true);
      app.hook.nav('fluid');
      app.click('flt2');
      const C = (f) => (f - 32) * 5 / 9;
      const lab = (id) => String(app.el(id).parentNode.querySelector('label').textContent);
      assert.includes(lab('bp_sp'), 'kPa(g)'); assert.includes(lab('bp_rt'), '°C'); assert.includes(lab('bp_gor'), 'sm³/sm³');
      set(app, { bp_api: 45, bp_gor: 300 * 0.178108, bp_gg: 0.7, bp_st: C(110), bp_sp: 500 * 6.89476, bp_rt: C(440) });
      clickIn(app, '#pgBody', 'Calculate Bubble Point');
      const ygs = 0.7 * (1 + 5.912e-5 * 45 * 110 * Math.log10(514.7 / 114.7));
      const pb = 18.2 * (Math.pow(300 / ygs, 0.83) * Math.pow(10, 0.00091 * 440 - 0.0125 * 45) - 1.4);
      assert.rel(rv(app, 'bp_res', 'Bubble Point Pressure', 0), pb * 6.89476, 2e-4);        // kPa(a)
      assert.ok(!/psia/.test(String(app.el('bp_res').textContent)), 'no psia in metric');
      app.click('flt3');
      assert.includes(lab('sf_sp'), 'kPa(g)'); assert.includes(lab('sf_st'), '°C');
      set(app, { sf_sp: 710 * 6.89476, sf_st: C(121), sf_gg: 0.751, sf_api: 52 });
      clickIn(app, '#pgBody', 'Calculate');
      const go = 141.5 / 183.5;
      const rs = 0.751 * Math.pow((724.7 / 18.2 + 1.4) * Math.pow(10, 0.0125 * 52 - 0.00091 * 121), 1.2048);
      const bo = 0.9759 + 0.00012 * Math.pow(rs * Math.sqrt(0.751 / go) + 1.25 * 121, 1.2);
      assert.near(rv(app, 'sf_res', 'Bo (FVF)'), bo, 1e-4);
      assert.near(rv(app, 'sf_res', 'Solution GOR'), rs * 0.178108, 0.011);
      assert.includes(rvText(app, 'sf_res', 'Solution GOR'), 'sm³/sm³');
      // Stored values stay canonical imperial: back in Imperial the inputs read psig / °F.
      setMetric(app, false);
      assert.near(parseFloat(app.el('sf_sp').value), 710, 0.01);
      assert.near(parseFloat(app.el('sf_st').value), 121, 0.01);
      noBadNumbers(assert, app, 'fluid metric bp/sf');
      assert.deepEqual(app.consoleErrors(), []);
    },
  },
  {
    name: 'G2 bottomsup metric (fix): flow rate shown in m³/min; units categories (10³ m³/d, sm³/sm³, AGA-3 dP @ 60 °F)',
    wp: WP,
    run(app, assert) {
      setMetric(app, true);
      app.hook.nav('bottomsup');
      set(app, { bu_q: 5000 * 0.158987, bu_vol: 25 * 0.158987 });
      clickIn(app, '#pgBody', 'Calculate');
      const t = rvText(app, 'bu_res', 'Flow Rate');
      assert.includes(t, 'm³/min');
      assert.near(rv(app, 'bu_res', 'Flow Rate'), 5000 / 1440 * 0.158987, 1e-4);
      const U = app.win.WTS_units;
      assert.equal(U.label('gasRate'), '10³ m³/d');
      assert.rel(U.convertCategory(1000, 'gor', 'imperial', 'metric'), 178.108, 1e-4);
      assert.rel(U.convertCategory(1, 'cgr', 'imperial', 'metric'), 5.61458, 1e-4);
      assert.rel(U.convertCategory(1, 'capacity', 'imperial', 'metric'), 0.521612, 1e-5);
      assert.equal(U.MANIFEST.aga3.inputs.a_dP, 'pressureSmall60');
    },
  },
];
