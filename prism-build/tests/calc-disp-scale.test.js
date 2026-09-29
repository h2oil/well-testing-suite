// Roadmap calculators #11 (SO2 / H2S Dispersion Screening, route `dispersion`,
// prism-build/49-calc-dispersion.js), #14 (Scale & Water Analysis, route `scale`,
// prism-build/49-calc-scale.js) and #17 (Cement & Completion Fluids, route
// `complfluids`, prism-build/49-calc-fluids.js).
//
// Expected values are independent hand calculations or published worked examples:
//   Gaussian plume  C = Q/(π·u·σy·σz)·exp(−H²/2σz²), Briggs (1973) rural σ, written out again here
//   Briggs rise     Δh = 38.71·F^0.6/u (F ≥ 55), 21.425·F^0.75/u (F < 55), stable 2.6·(F/us)^⅓
//   SCREEN3 flare   F = 1.66e-5·H [cal/s] (55 % radiant loss) — EPA-454/B-95-004
//   USBR MS-2016 "Water Chemistry Analysis for Water Conveyance, Storage and Desalination Projects",
//                   Figure 1: I = 0.0433, LSI 0.18, BaSO4 IP/Ksp 20.94, SrSO4 IP 1.36e-8 / Ksp 1.18e-6
//   Oddo–Tomson     (1994) equations evaluated by hand in this file
//   Cement          API Class G 15.8 ppg 4.97 gal/sk 1.15 ft³/sk; Class H 16.4 ppg 4.3 gal/sk 1.06 ft³/sk;
//                   Class A 15.6 ppg 5.2 gal/sk 1.18 ft³/sk (standard neat-slurry tables)
'use strict';

const WP = 'DSC';

function rows(app, resId) {
  return app.findAll('#' + resId + ' .rrow').map((r) => {
    const l = r.querySelector('.rl'), v = r.querySelector('.rv');
    return { l: String(l ? l.textContent : '').trim(), v: String(v ? v.textContent : '').trim() };
  });
}
function rtext(app, resId, label) { const r = rows(app, resId).find((x) => x.l === label); return r ? r.v : null; }
function rv(app, resId, label, nth) {
  const t = rtext(app, resId, label);
  if (t == null) throw new Error('no result row "' + label + '" in #' + resId + ': ' + JSON.stringify(rows(app, resId).map((x) => x.l)));
  const nums = t.replace(/,/g, '').match(/-?\d+(\.\d+)?(e[-+]?\d+)?/gi);
  return parseFloat(nums[nth || 0]);
}
function txt(app, id) { const e = app.el(id); return String(e ? e.textContent : '').trim(); }
function errText(app, resId) { return app.findAll('#' + resId + ' .val-error').map((e) => e.textContent).join(' | '); }
function noBad(assert, app, where) {
  assert.ok(!/NaN|Infinity|undefined/.test(String(app.el('pgBody').textContent || '')), where + ': NaN/Infinity/undefined on the page');
}
function set(app, vals) {
  for (const k of Object.keys(vals)) {
    if (!app.el(k)) throw new Error('no input #' + k);
    if (app.el(k).tagName === 'SELECT') app.select(k, String(vals[k]));
    else app.input(k, String(vals[k]));
  }
}
function open(app, key, root) {
  const b = app.find('.nav-btn[data-p="' + key + '"]');
  if (!b) throw new Error('no ' + key + ' nav button');
  app.click(b);
  if (!app.el(root)) throw new Error(key + ' page did not render');
}

// ── Independent re-statements of the published formulas ─────────────
const BRIGGS = {
  A: (x) => [0.22 * x / Math.sqrt(1 + 1e-4 * x), 0.20 * x],
  B: (x) => [0.16 * x / Math.sqrt(1 + 1e-4 * x), 0.12 * x],
  C: (x) => [0.11 * x / Math.sqrt(1 + 1e-4 * x), 0.08 * x / Math.sqrt(1 + 2e-4 * x)],
  D: (x) => [0.08 * x / Math.sqrt(1 + 1e-4 * x), 0.06 * x / Math.sqrt(1 + 1.5e-3 * x)],
  E: (x) => [0.06 * x / Math.sqrt(1 + 1e-4 * x), 0.03 * x / (1 + 3e-4 * x)],
  F: (x) => [0.04 * x / Math.sqrt(1 + 1e-4 * x), 0.016 * x / (1 + 3e-4 * x)],
};
const G_S = 453.59237 / 3600;                        // g/s per lb/hr
const ppmOf = (gm3, mw) => gm3 * 1000 * 24.45 / mw;  // 25 °C, 1 atm
function plume(Qgs, u, cls, x, H) {
  const [sy, sz] = BRIGGS[cls](x);
  return Qgs / (Math.PI * u * sy * sz) * Math.exp(-H * H / (2 * sz * sz));
}
const log10 = Math.log10;

module.exports = [
  // ═══════════════════════════ DISPERSION ═══════════════════════════
  {
    name: 'DSC dispersion compute: Briggs σ, ground-level and elevated Gaussian plume, power-law wind, ppm conversion',
    wp: WP,
    run(app, assert) {
      const W = app.win, C = W.WTS_dispersion_compute;
      ['renderDispersion', 'calcDispersion', 'WTS_dispersion_compute', 'WTS_dispersion_sigma', 'WTS_dispersionUseFlare', 'WTS_dispersionUseH2S']
        .forEach((f) => assert.strictEqual(typeof W[f], 'function', f));
      ['A', 'B', 'C', 'D', 'E', 'F'].forEach((c) => [150, 500, 2000, 8000].forEach((x) => {
        const s = W.WTS_dispersion_sigma(c, x), e = BRIGGS[c](x);
        assert.rel(s.sy, e[0], 1e-12, c + ' σy ' + x); assert.rel(s.sz, e[1], 1e-12, c + ' σz ' + x);
      }));
      // Tabulated check: class D at 1 km σy ≈ 76 m, σz ≈ 38 m (Briggs rural curves)
      const d1 = W.WTS_dispersion_sigma('D', 1000);
      assert.ok(Math.abs(d1.sy - 76.3) < 0.1 && Math.abs(d1.sz - 37.9) < 0.1, 'D at 1 km');
      // Ground-level cold vent, 10 lb/hr H2S, class D, 10 mph at 10 m (release below 10 m → u = u10)
      const v = C({ src: 'vent', h2s: 10, so2: 0, hs: 0, u10: 10, cls: 'D', ta: 68 });
      assert.ok(v.ok, 'vent ok');
      assert.rel(v.u_ms, 4.4704, 1e-9, 'u = u10');
      assert.strictEqual(v.F, 0, 'no buoyancy'); assert.strictEqual(v.rise_m, 0, 'no rise');
      [100, 1000, 5000].forEach((x) => assert.rel(v.chi('h2s', x), ppmOf(plume(10 * G_S, 4.4704, 'D', x, 0), 34.081), 1e-9, 'vent ppm at ' + x));
      assert.rel(v.chi('h2s', 1000), 0.02224, 1e-3, 'vent 1 km ≈ 0.0222 ppm');   // 1.26 g/s / (π·4.47·76.3·37.9) → 0.0310 mg/m³
      assert.ok(v.peak.h2s.x <= 10.001, 'ground source: maximum at the nearest distance');
      // Elevated release, no rise: 50 m vent, class C, u10 5 m/s → u = 5·5^0.10
      const e = C({ src: 'vent', h2s: 100, so2: 0, hs: 50 / 0.3048, u10: 5 / 0.44704, cls: 'C', ta: 68 });
      const u = 5 * Math.pow(5, 0.10);
      assert.rel(e.u_ms, u, 1e-9, 'power law C');
      [300, 800, 3000].forEach((x) => assert.rel(e.chi('h2s', x), ppmOf(plume(100 * G_S, u, 'C', x, 50), 34.081), 1e-9, 'elevated ppm at ' + x));
      // Peak: larger than its neighbours
      const pk = e.peak.h2s;
      assert.ok(pk.ppm >= e.chi('h2s', pk.x * 1.02) && pk.ppm >= e.chi('h2s', pk.x / 1.02), 'peak is a maximum');
      assert.rel(pk.ppm, ppmOf(plume(100 * G_S, u, 'C', pk.x, 50), 34.081), 1e-9, 'peak value');
      // Wind floor 1 m/s and exponent per class
      assert.rel(C({ src: 'vent', h2s: 1, hs: 200, u10: 1, cls: 'F', ta: 68 }).u_ms, 0.44704 * Math.pow(6.096, 0.55), 1e-9, 'F exponent 0.55');
      assert.rel(C({ src: 'vent', h2s: 1, hs: 0, u10: 1, cls: 'D', ta: 68 }).u_ms, 1, 1e-12, '1 m/s floor');
    },
  },
  {
    name: 'DSC dispersion flare: buoyancy flux (SCREEN3), Briggs final and gradual rise, stable rise, exceedance distances',
    wp: WP,
    run(app, assert) {
      const C = app.win.WTS_dispersion_compute;
      const base = { src: 'flare', so2: 400, h2s: 4, heat: 100, frad: 55, hs: 30, u10: 20, cls: 'D', ta: 68 };
      const r = C(base);
      assert.ok(r.ok, 'flare ok');
      const Hcal = 100 * 1.05505585262e9 / 3600 / 4.1868;       // cal/s
      assert.rel(r.F, 1.66e-5 * Hcal, 3e-3, 'F = 1.66e-5·H (SCREEN3)');
      const F = r.F, u = 20 * 0.44704;                         // tip at 9.1 m → u = u10
      assert.rel(r.u_ms, u, 1e-9, 'tip below 10 m');
      assert.ok(F >= 55, 'F ≥ 55 branch');
      assert.rel(r.rise_m, 38.71 * Math.pow(F, 0.6) / u, 1e-9, 'final rise');
      assert.rel(r.xf_m, 119 * Math.pow(F, 0.4), 1e-9, 'distance to final rise');
      assert.rel(r.hEff_m, 30 * 0.3048 + r.rise_m, 1e-9, 'effective height');
      // Gradual rise inside x_f, final beyond
      const x1 = 200, dh1 = 1.6 * Math.pow(F, 1 / 3) * Math.pow(x1, 2 / 3) / u;
      assert.ok(dh1 < r.rise_m, 'gradual below final at 200 m');
      assert.rel(r.chi('so2', x1), ppmOf(plume(400 * G_S, u, 'D', x1, 9.144 + dh1), 64.064), 1e-9, 'SO2 at 200 m (gradual rise)');
      assert.rel(r.chi('so2', 3000), ppmOf(plume(400 * G_S, u, 'D', 3000, 9.144 + r.rise_m), 64.064), 1e-9, 'SO2 at 3 km (final rise)');
      assert.rel(r.chi('h2s', 3000) / r.chi('so2', 3000), (4 / 34.081) / (400 / 64.064), 1e-9, 'H2S/SO2 ratio = molar release ratio');
      // F < 55 branch
      const s = C(Object.assign({}, base, { heat: 20 }));
      assert.ok(s.F < 55, 'small flare');
      assert.rel(s.rise_m, 21.425 * Math.pow(s.F, 0.75) / u, 1e-9, 'F < 55 rise');
      assert.rel(s.xf_m, 49 * Math.pow(s.F, 0.625), 1e-9, 'F < 55 x_f');
      // Stable class F, 5 mph: smaller of stable and neutral rise
      const st = C(Object.assign({}, base, { cls: 'F', u10: 5 }));
      const uF = 5 * 0.44704, sP = 9.80665 / 293.15 * 0.035;
      const dhS = 2.6 * Math.pow(st.F / (uF * sP), 1 / 3), dhN = 38.71 * Math.pow(st.F, 0.6) / uF;
      assert.rel(st.rise_m, Math.min(dhS, dhN), 1e-9, 'stable rise');
      assert.ok(st.stableRise, 'stable formula governs');
      assert.rel(st.xf_m, 2.0715 * uF / Math.sqrt(sP), 1e-9, 'stable x_f');
      // Radiant fraction: zero radiant loss → F / 0.45
      assert.rel(C(Object.assign({}, base, { frad: 0 })).F, r.F / 0.45, 1e-9, 'radiant fraction');
      // Exceedance distances: ground vent 50 lb/hr H2S, class F, 5 mph, 10 ft
      const v = C({ src: 'vent', h2s: 50, so2: 0, hs: 10, u10: 5, cls: 'F', ta: 68 });
      const E = v.exceed.h2s;
      assert.ok(!E.idlh.reached && E.stel.reached && E.twa.reached, 'STEL and TWA exceeded, not IDLH');
      const uV = 5 * 0.44704;
      const hand2 = (x) => ppmOf(plume(50 * G_S, uV, 'F', x, 3.048), 34.081);
      assert.rel(hand2(E.stel.from_m), 10, 1e-6, 'STEL near edge = 10 ppm');
      assert.rel(hand2(E.stel.to_m), 10, 1e-6, 'STEL far edge = 10 ppm');
      assert.rel(hand2(E.twa.to_m), 1, 1e-6, 'TWA far edge = 1 ppm');
      assert.ok(hand2(Math.sqrt(E.stel.from_m * E.stel.to_m)) > 10, 'above STEL inside the range');
      assert.rel(E.twa.to_ft, E.twa.to_m / 0.3048, 1e-12, 'ft');
      assert.ok(!v.exceed.so2.idlh.reached && v.exceed.so2.idlh.none, 'no SO2 release');
      // Custom limits
      const c2 = C({ src: 'vent', h2s: 50, so2: 0, hs: 10, u10: 5, cls: 'F', ta: 68, limits: { h2sIdlh: 15 } });
      assert.ok(c2.exceed.h2s.idlh.reached && c2.limits.h2sStel === 10, 'custom IDLH, default STEL');
      // Validation
      [{ u10: 0.5 }, { cls: 'G' }, { hs: -1 }, { heat: 0 }, { frad: 100 }, { so2: 0, h2s: 0 }, { ta: 200 }, { limits: { so2Twa: 0 } }]
        .forEach((o, k) => { const b = C(Object.assign({}, base, o)); assert.ok(!b.ok && b.errors.length && b.bad.length, 'bad ' + k); });
      assert.ok(C({ src: 'vent', h2s: 1, hs: 10, u10: 5, cls: 'D', ta: 68 }).ok, 'vent needs no heat');
    },
  },
  {
    name: 'DSC dispersion page: results, verdicts, chart, Flare Emissions and H2S Safety hand-offs, metric, report, reload',
    wp: WP,
    run(app, assert) {
      // Flare Emissions → state carries duration and unburned H2S
      open(app, 'flareghg', 'fe_res');
      app.win.calcFlareGHG();
      const fe = app.win.WTS_state.flareghg;
      assert.ok(fe.hrs > 0 && fe.so2_t > 0 && fe.h2sUnburned_kg > 0 && fe.E_MMBtu > 0, 'flareghg state: ' + JSON.stringify(fe));
      open(app, 'dispersion', 'ds_root');
      assert.ok(app.el('ds_res').querySelector('.rrow'), 'results rendered on open');
      noBad(assert, app, 'default');
      app.click('ds_useflare');
      const S = () => app.win.WTS_state.dispersion;
      assert.rel(parseFloat(app.el('ds_so2').value), fe.so2_t * 1000 / 0.45359237 / fe.hrs, 1e-6, 'SO2 lb/hr from Flare Emissions');
      assert.rel(parseFloat(app.el('ds_h2s').value), fe.h2sUnburned_kg / 0.45359237 / fe.hrs, 1e-6, 'H2S lb/hr');
      assert.rel(parseFloat(app.el('ds_heat').value), fe.E_MMBtu / fe.hrs * 0.9, 1e-6, 'heat (LHV ≈ 0.9 HHV)');
      const r = S().result;
      assert.ok(r.ok && r.q_gs.so2 > 0, 'recalculated');
      // H2S Safety hand-off (flare card) and cold vent (escape rate)
      open(app, 'h2sroe', 'hs_root');
      app.win.calcH2S();
      const hs = app.win.WTS_state.h2sroe;
      open(app, 'dispersion', 'ds_root');
      app.click('ds_useh2s');
      assert.rel(parseFloat(app.el('ds_so2').value), hs.so2.so2_lbhr, 1e-6, 'SO2 from H2S Safety');
      set(app, { ds_src: 'vent' });
      app.click('ds_useh2s');
      assert.rel(parseFloat(app.el('ds_h2s').value), hs.roe.h2s_lbd / 24, 1e-6, 'vent H2S from escape rate');
      assert.strictEqual(parseFloat(app.el('ds_so2').value), 0, 'vent SO2 0');
      // A vent case with IDLH exceedance
      set(app, { ds_src: 'vent', ds_h2s: 500, ds_so2: 0, ds_hs: 10, ds_u10: 5, ds_cls: 'F' });
      app.click('ds_calc');
      noBad(assert, app, 'vent');
      const t = txt(app, 'ds_res');
      assert.includes(t, 'Screening only, not a substitute for a site dispersion study');
      assert.includes(t, '✗ H2S exceeds IDLH');
      assert.ok(S().h2sIdlh_ft > 0 && S().maxH2S_ppm > 100, 'state');
      assert.rel(rv(app, 'ds_res', 'H2S maximum'), S().maxH2S_ppm, 5e-3, 'shown maximum');
      assert.ok(app.find('#ds_res canvas#ds_chart') && app.canvasLog('ds_chart').length > 10, 'chart drawn');
      assert.ok(app.findAll('#ds_res table.dtable').length >= 2, 'tables');
      // Validation messages
      set(app, { ds_u10: 0 }); app.click('ds_calc');
      assert.includes(errText(app, 'ds_res'), 'Wind speed');
      set(app, { ds_u10: 5 }); app.click('ds_calc');
      // Metric: labels, state unchanged, values converted
      const imp = S().maxH2S_ppm, impX = S().h2sIdlh_ft;
      const U = app.win.WTS_units;
      app.flush(10);
      U.setSystem('metric');
      try {
        open(app, 'dispersion', 'ds_root');
        const lab = (id) => String(app.el(id).closest('.fg-item').querySelector('label').textContent);
        assert.match(lab('ds_hs'), /\(m\)/); assert.match(lab('ds_u10'), /m\/s/); assert.match(lab('ds_h2s'), /kg\/hr/);
        assert.rel(S().maxH2S_ppm, imp, 1e-3, 'metric same physics');
        assert.rel(S().h2sIdlh_ft, impX, 1e-3, 'metric same distance');
        assert.includes(rtext(app, 'ds_res', 'Effective height after final rise'), ' m');
      } finally { U.setSystem('imperial'); }
      // Report + persistence
      const model = app.win.collectPageReport(app.el('pgBody'), { charts: false });
      const titles = model.results.map((x) => x.title);
      ['Screening Only', 'Plume Rise & Effective Height', 'Ground-Level Maximum & Exceedance Distances', 'Concentration vs Distance']
        .forEach((x) => assert.ok(titles.indexOf(x) !== -1, 'section ' + x + ': ' + titles.join(' | ')));
      app.flush(1200);
      const rec = JSON.parse(app.storage.getItem('wts_page_dispersion') || 'null');
      assert.ok(rec && rec.f && rec.f.ds_h2s === '500' && rec.f.ds_cls === 'F', 'autosaved');
      app.flushUntilIdle(10000);
      assert.strictEqual(app.pendingTimers(), 0, 'no timers');
      const app2 = app.reload();
      try {
        open(app2, 'dispersion', 'ds_root');
        assert.strictEqual(app2.el('ds_src').value, 'vent', 'restored');
        assert.rel(app2.win.WTS_state.dispersion.maxH2S_ppm, imp, 1e-6, 'recalculated on restore');
      } finally { app2.dispose(); }
    },
  },

  // ═══════════════════════════ SCALE ═══════════════════════════
  {
    name: 'DSC scale: USBR worked example (ionic strength, LSI, barite and celestite saturation) and charge balance',
    wp: WP,
    run(app, assert) {
      const S = app.win.WTS_scale_compute;
      const w = { na: 93, k: 9, ca: 196.3, mg: 120.4, ba: 0.1426, sr: 0.12, cl: 1.9, hco3: 169.2, so4: 953, ph: 7.5, tds: 1566.56, t: 59, p: 14.7 };
      const r = S(w);
      assert.ok(r.ok, 'ok');
      // Published: I = 0.0433 (includes 0.5 mg/L F⁻ and 10 mg/L NO3⁻, not entered here: −0.2 %)
      assert.rel(r.I, 0.0433, 0.01, 'ionic strength vs USBR');
      assert.ok(Math.abs(r.lsi.value - 0.18) <= 0.06, 'LSI ' + r.lsi.value + ' vs USBR 0.18 (DuPont chart fit; Carrier form here)');
      assert.ok(Math.abs(r.si.barite - log10(20.94)) <= 0.1, 'barite SI ' + r.si.barite + ' vs USBR log10(IP/Ksp) 1.32');
      assert.ok(Math.abs(r.si.celestite - log10(1.36e-8 / 1.18e-6)) <= 0.1, 'celestite SI ' + r.si.celestite + ' vs USBR −1.94');
      // Charge balance by hand (meq/L)
      const cat = 93 / 22.990 + 9 / 39.098 + 2 * 196.3 / 40.078 + 2 * 120.4 / 24.305 + 2 * 0.1426 / 137.327 + 2 * 0.12 / 87.62;
      const an = 1.9 / 35.453 + 169.2 / 61.017 + 2 * 953 / 96.06;
      assert.rel(r.cations_meq, cat, 1e-9, 'cations'); assert.rel(r.anions_meq, an, 1e-9, 'anions');
      assert.rel(r.cbPct, (cat - an) / (cat + an) * 100, 1e-9, 'balance %');
      assert.ok(Math.abs(r.cbPct - 2.4) < 0.6 && r.cb === 'ok', 'balance ≈ USBR 2.4 % (F, NO3 omitted), acceptable');
      // Langelier by hand (Carrier form)
      const tK = 288.15, caC = 196.3 / 40.078 * 100.087, alkC = 169.2 / 61.017 * 50.0435;
      const pHs = 9.3 + (log10(1566.56) - 1) / 10 + (-13.12 * log10(tK) + 34.55) - (log10(caC) - 0.4) - log10(alkC);
      assert.rel(r.lsi.pHs, pHs, 1e-6, 'pHs'); assert.rel(r.lsi.value, 7.5 - pHs, 1e-5, 'LSI');
      // TDS blank → sum of ions
      const r2 = S(Object.assign({}, w, { tds: '' }));
      assert.rel(r2.tds, 93 + 9 + 196.3 + 120.4 + 0.1426 + 0.12 + 1.9 + 169.2 + 953, 1e-12, 'sum of ions');
      assert.strictEqual(r2.tdsMeasured, false);
    },
  },
  {
    name: 'DSC scale: Oddo–Tomson calcite / sulphate SI, Stiff–Davis both branches, SI vs T, verdict bands, validation',
    wp: WP,
    run(app, assert) {
      const S = app.win.WTS_scale_compute;
      const w = { na: 30000, k: 400, ca: 2500, mg: 400, ba: 50, sr: 300, fe: 10, cl: 52000, so4: 20, hco3: 600, co3: 0, ph: 6.8, t: 180, p: 2000 };
      const r = S(w);
      assert.ok(r.ok);
      const m = { na: 30000 / 22990, k: 400 / 39098, ca: 2500 / 40078, mg: 400 / 24305, ba: 50 / 137327, sr: 300 / 87620, fe: 10 / 55845,
        cl: 52000 / 35453, so4: 20 / 96060, hco3: 600 / 61017 };
      const I = 0.5 * (m.na + m.k + 4 * (m.ca + m.mg + m.ba + m.sr + m.fe) + m.cl + 4 * m.so4 + m.hco3);
      assert.rel(r.I, I, 1e-9, 'I');
      const T = 180, P = 2000, sI = Math.sqrt(I);
      const calcite = log10(m.ca * m.hco3) + 6.8 - 2.76 + 0.00988 * T + 0.61e-6 * T * T - 3.03e-5 * P - 2.348 * sI + 0.77 * I;
      const sulph = (me, A, B, Cc, D, E, F, Gg) => log10(me * m.so4) + A + B * T + Cc * T * T + D * P + E * sI + F * I + Gg * sI * T;
      assert.rel(r.si.calcite, calcite, 1e-9, 'calcite');
      assert.rel(r.si.barite, sulph(m.ba, 10.03, -0.0048, 11.4e-6, -4.8e-5, -2.62, 0.89, -0.002), 1e-9, 'barite');
      assert.rel(r.si.celestite, sulph(m.sr, 6.11, 0.002, 6.4e-6, -4.6e-5, -1.89, 0.67, -0.0019), 1e-9, 'celestite');
      assert.rel(r.si.gypsum, sulph(m.ca, 3.47, 0.0018, 2.5e-6, -5.9e-5, -1.13, 0.37, -0.002), 1e-9, 'gypsum');
      assert.rel(r.si.anhydrite, sulph(m.ca, 2.52, 0.00998, -0.97e-6, -3.07e-5, -1.09, 0.50, -0.0033), 1e-9, 'anhydrite');
      // Stiff–Davis, I ≥ 1.2 branch (T in °C)
      const tC = (180 - 32) / 1.8;
      const K2 = -0.1 * I - 0.0002 * tC * tC - 0.00097 * tC + 3.887;
      assert.ok(I > 1.2, 'high-I branch');
      assert.rel(r.sdi.K, K2, 1e-9, 'K (I ≥ 1.2)');
      assert.rel(r.sdi.value, 6.8 + log10(m.ca) + log10(m.hco3) - K2, 1e-9, 'S&DSI');
      assert.ok(!r.lsi.valid, 'LSI flagged above 10,000 mg/L');
      // I < 1.2 branch
      const lo = S({ ca: 100, na: 500, cl: 900, hco3: 250, so4: 50, ph: 7.8, t: 77, p: 14.7 });
      const mi = { ca: 100 / 40078, na: 500 / 22990, cl: 900 / 35453, hco3: 250 / 61017, so4: 50 / 96060 };
      const Il = 0.5 * (4 * mi.ca + mi.na + mi.cl + mi.hco3 + 4 * mi.so4);
      const K1 = 2.022 * Math.exp(Math.pow(Math.log(Il) + 7.544, 2) / 102.6) - 0.0002 * 625 + 0.00097 * 25 + 0.262;
      assert.rel(lo.sdi.K, K1, 1e-9, 'K (I < 1.2)');
      // Carbonate adds 2 eq/mol to alkalinity
      const co3 = S(Object.assign({}, w, { co3: 60 }));
      assert.rel(co3.alkEq, m.hco3 + 2 * 60 / 60009, 1e-9, 'alkalinity with CO3');
      // SI vs temperature: calcite rises, anhydrite rises with T; curve and table rows follow the same equation
      const c0 = r.curve[0], cN = r.curve[r.curve.length - 1];
      assert.ok(cN.calcite > c0.calcite && cN.anhydrite > c0.anhydrite, 'calcite and anhydrite SI rise with T');
      const row = r.table.find((x) => x.t === 300);
      const T3 = 300;
      assert.rel(row.barite, log10(m.ba * m.so4) + 10.03 - 0.0048 * T3 + 11.4e-6 * T3 * T3 - 4.8e-5 * P - 2.62 * sI + 0.89 * I - 0.002 * sI * T3, 1e-9, 'table at 300 °F');
      // Pressure lowers SI (all D coefficients negative)
      const hp = S(Object.assign({}, w, { p: 10000 }));
      assert.rel(r.si.barite - hp.si.barite, 4.8e-5 * 8000, 1e-9, 'pressure term');
      // Bands
      assert.strictEqual(r.verdicts.calcite, r.si.calcite > 0.5 ? 'bad' : r.si.calcite > 0 ? 'warn' : 'ok');
      assert.strictEqual(r.verdicts.gypsum, 'ok');
      const noBa = S(Object.assign({}, w, { ba: 0 }));
      assert.strictEqual(noBa.si.barite, null, 'no barium → no barite SI');
      assert.strictEqual(noBa.verdicts.barite, 'none');
      // Charge balance bands
      assert.strictEqual(S(Object.assign({}, w, { cl: 45000 })).cb, 'warn');
      assert.strictEqual(S(Object.assign({}, w, { cl: 38000 })).cb, 'bad');
      // Validation
      [{ ph: 2 }, { t: 20 }, { p: 1 }, { ca: 0 }, { hco3: 0 }, { na: -5 }, { tds: -1 }].forEach((o, k) => {
        const b = S(Object.assign({}, w, o)); assert.ok(!b.ok && b.errors.length && b.bad.length, 'bad ' + k);
      });
    },
  },
  {
    name: 'DSC scale page: verdicts, tables, chart, metric T and P, report sections, reload',
    wp: WP,
    run(app, assert) {
      open(app, 'scale', 'sc_root');
      const S = () => app.win.WTS_state.scale;
      assert.ok(S() && S().result.ok, 'calculated on open');
      noBad(assert, app, 'default');
      const t = txt(app, 'sc_res');
      assert.includes(t, 'Charge balance');
      assert.includes(t, '✗ Calcite, CaCO3 SI');
      assert.includes(t, 'Langelier index is outside its range');
      assert.ok(app.canvasLog('sc_chart').length > 10, 'chart drawn');
      assert.ok(app.findAll('#sc_res table.dtable').length >= 2, 'tables');
      assert.rel(rv(app, 'sc_res', 'Ionic strength'), S().I, 1e-3, 'shown I');
      set(app, { sc_so4: 1500 }); app.click('sc_calc');
      assert.ok(S().si.barite > 0.5, 'barite scale with sulphate-rich mixing');
      assert.includes(txt(app, 'sc_res'), '✗ Barite, BaSO4 SI');
      set(app, { sc_ph: 1 }); app.click('sc_calc');
      assert.includes(errText(app, 'sc_res'), 'pH');
      set(app, { sc_ph: 6.8 }); app.click('sc_calc');
      const imp = Object.assign({}, S().si);
      const U = app.win.WTS_units;
      app.flush(10);
      U.setSystem('metric');
      try {
        open(app, 'scale', 'sc_root');
        const lab = (id) => String(app.el(id).closest('.fg-item').querySelector('label').textContent);
        assert.match(lab('sc_t'), /°C/); assert.match(lab('sc_p'), /kPa/);
        Object.keys(imp).forEach((k) => assert.ok(Math.abs(S().si[k] - imp[k]) < 1e-3, 'metric SI ' + k));
        assert.includes(rtext(app, 'sc_res', 'Conditions'), 'kPa');
        set(app, { sc_t: '100' }); app.click('sc_calc');          // 100 °C = 212 °F
        assert.rel(S().result.t, 212, 1e-6, 'metric entry converted');
      } finally { U.setSystem('imperial'); }
      set(app, { sc_t: 180 }); app.click('sc_calc');
      const model = app.win.collectPageReport(app.el('pgBody'), { charts: false });
      const titles = model.results.map((x) => x.title);
      ['Water Analysis', 'Calcium Carbonate Indices', 'Oddo–Tomson Saturation Indices', 'Saturation Index vs Temperature']
        .forEach((x) => assert.ok(titles.indexOf(x) !== -1, 'section ' + x));
      app.flush(1200);
      app.flushUntilIdle(10000);
      assert.strictEqual(app.pendingTimers(), 0, 'no timers');
      const app2 = app.reload();
      try {
        open(app2, 'scale', 'sc_root');
        assert.strictEqual(app2.el('sc_so4').value, '1500', 'restored');
        assert.ok(app2.win.WTS_state.scale.si.barite > 0.5, 'recalculated on restore');
      } finally { app2.dispose(); }
    },
  },

  // ═══════════════════════════ COMPLETION FLUIDS ═══════════════════════════
  {
    name: 'DSC complfluids: neat cement water and yield vs published Class A/G/H values, volumes, sacks, displacement',
    wp: WP,
    run(app, assert) {
      const Cm = app.win.WTS_cement_slurry;
      const base = { dh: 8.5, od: 7, cid: 6.276, shoe: 10000, toc: 8000, track: 80, excess: 20, rho: 15.8, sgc: 3.14, sack: 94 };
      const g = Cm(base);
      assert.ok(g.ok);
      assert.ok(Math.abs(g.waterGalSk - 4.97) < 0.03, 'Class G water ' + g.waterGalSk);
      assert.ok(Math.abs(g.yieldFt3 - 1.15) < 0.01, 'Class G yield ' + g.yieldFt3);
      assert.ok(Math.abs(g.wcr - 0.44) < 0.005, 'Class G 44 % water');
      const h = Cm(Object.assign({}, base, { rho: 16.4 }));
      assert.ok(Math.abs(h.waterGalSk - 4.3) < 0.06 && Math.abs(h.yieldFt3 - 1.06) < 0.01, 'Class H 16.4 ppg: ' + h.waterGalSk + ' / ' + h.yieldFt3);
      const a = Cm(Object.assign({}, base, { rho: 15.6 }));
      assert.ok(Math.abs(a.waterGalSk - 5.2) < 0.05 && Math.abs(a.yieldFt3 - 1.18) < 0.01, 'Class A 15.6 ppg: ' + a.waterGalSk + ' / ' + a.yieldFt3);
      // Mass balance closes: slurry density from water + cement
      const vc = 94 / (3.14 * 8.33);
      assert.rel((94 + 8.33 * g.waterGalSk) / (vc + g.waterGalSk), 15.8, 1e-9, 'density back-calc');
      // Volumes by hand (ID²/1029.4)
      const ann = (8.5 * 8.5 - 49) / 1029.4 * 2000, trk = 6.276 * 6.276 / 1029.4 * 80;
      assert.rel(g.annBbl, ann, 1e-9, 'annulus'); assert.rel(g.slurryBbl, ann * 1.2 + trk, 1e-9, 'slurry');
      assert.rel(g.sacks, (ann * 1.2 + trk) * 5.6146 / g.yieldFt3, 1e-9, 'sacks');
      assert.strictEqual(g.sacksRounded, Math.ceil(g.sacks));
      assert.rel(g.mixWaterBbl, g.sacks * g.waterGalSk / 42, 1e-9, 'mix water');
      assert.rel(g.dispBbl, 6.276 * 6.276 / 1029.4 * 9920, 1e-9, 'displacement');
      // Water ratio flags
      assert.ok(Cm(Object.assign({}, base, { rho: 17.5 })).lowWater, 'dense slurry needs dispersant');
      assert.ok(Cm(Object.assign({}, base, { rho: 14.0 })).highWater, 'light slurry needs extender');
      [{ dh: 6 }, { cid: 7.5 }, { toc: 11000 }, { rho: 8.5 }, { rho: 26 }, { sgc: 1 }, { excess: -1 }, { track: 20000 }].forEach((o, k) => {
        const b = Cm(Object.assign({}, base, o)); assert.ok(!b.ok && b.errors.length && b.bad.length, 'bad ' + k);
      });
    },
  },
  {
    name: 'DSC complfluids: brine blend density, target volumes, Well Kill brine guide reuse and crystallisation cautions',
    wp: WP,
    run(app, assert) {
      const W = app.win, B = W.WTS_brine_blend, list = W.WTS_wellkill_brines;
      assert.ok(list && list.length >= 10, 'Well Kill brine guide exposed');
      const ix = (re) => list.findIndex((b) => re.test(b.name));
      const caBr = ix(/^Calcium bromide/), caCl = ix(/^Calcium chloride/), sea = ix(/^Seawater/), kcl = ix(/^Potassium chloride/);
      const r = B({ a: caBr, b: caCl, ra: 14.2, rb: 11.6, va: 100, vb: 100, target: 13.0, vt: 300 });
      assert.ok(r.ok);
      assert.rel(r.mix, (14.2 * 100 + 11.6 * 100) / 200, 1e-12, 'blend = 12.9 ppg');
      assert.rel(r.target.va, 300 * (13 - 11.6) / (14.2 - 11.6), 1e-12, 'CaBr2 for 13.0 ppg');
      assert.rel(r.target.vb, 300 - 300 * 1.4 / 2.6, 1e-12, 'CaCl2 for 13.0 ppg');
      assert.rel(r.target.va * 14.2 + r.target.vb * 11.6, 300 * 13, 1e-12, 'mass balance');
      assert.strictEqual(r.aMax, list[caBr].ppg, 'guide max from the Well Kill table');
      const lv = r.cautions.map((c) => c.lvl + ':' + c.t).join(' | ');
      assert.includes(lv, 'within 3 % of the maximum density', 'near-saturation caution');
      assert.includes(lv, 'Two different salts', 'blend TCT caution');
      const over = B({ a: kcl, b: kcl, ra: 10.2, rb: 9.0, va: 50, vb: 50 });
      assert.ok(over.cautions.some((c) => c.lvl === 'bad'), 'above KCl max → ✗');
      assert.ok(!over.cautions.some((c) => /Two different/.test(c.t)), 'same salt');
      const inc = B({ a: caCl, b: sea, ra: 11.0, rb: 8.55, va: 50, vb: 50 });
      assert.ok(inc.cautions.some((c) => /precipitate/.test(c.t)), 'calcium + seawater');
      const other = B({ a: -1, b: -1, ra: 12, rb: 10, va: 30, vb: 70 });
      assert.ok(other.ok && other.target === null && other.cautions.length === 0 && other.a === 'Other brine', 'other brines, no target');
      assert.rel(other.mix, 10.6, 1e-12);
      [{ ra: 5 }, { va: -1 }, { va: 0, vb: 0 }, { target: 15 }, { target: 11, vt: 0 }].forEach((o, k) => {
        const b = B(Object.assign({ a: -1, b: -1, ra: 12, rb: 10, va: 30, vb: 70 }, o)); assert.ok(!b.ok && b.errors.length, 'bad ' + k);
      });
    },
  },
  {
    name: 'DSC complfluids page: both cards, metric, report sections, reload, phone widths and dashboard tiles for all three pages',
    wp: WP,
    opts: { viewport: { width: 375, height: 812 } },
    run(app, assert) {
      open(app, 'complfluids', 'cmf_root');
      const S = () => app.win.WTS_state.complfluids;
      assert.ok(S().sacks > 0 && S().blendPpg > 0, 'calculated on open');
      noBad(assert, app, 'default');
      assert.strictEqual(rv(app, 'cmf_cres', 'Cement'), Math.ceil(S().sacks), 'sacks shown');
      assert.rel(rv(app, 'cmf_bres', 'Blend density'), 12.9, 1e-9, 'blend shown');
      const bOpts = app.findAll('#cmf_a option').length;
      assert.strictEqual(bOpts, app.win.WTS_wellkill_brines.length + 1, 'brine list = Well Kill guide + other');
      set(app, { cmf_rho: 30 }); app.click('cmf_calc');
      assert.includes(errText(app, 'cmf_cres'), 'Slurry density');
      assert.ok(app.el('cmf_bres').querySelector('.rrow'), 'blend card unaffected');
      set(app, { cmf_rho: 15.8 }); app.click('cmf_calc');
      const imp = Object.assign({}, S());
      const U = app.win.WTS_units;
      app.flush(10);
      U.setSystem('metric');
      try {
        open(app, 'complfluids', 'cmf_root');
        const lab = (id) => String(app.el(id).closest('.fg-item').querySelector('label').textContent);
        assert.match(lab('cmf_dh'), /mm/); assert.match(lab('cmf_shoe'), /\(m\)/); assert.match(lab('cmf_rho'), /kg\/L/);
        ['slurryBbl', 'sacks', 'mixWaterBbl', 'dispBbl', 'blendPpg'].forEach((k) => assert.rel(S()[k], imp[k], 1e-3, 'metric ' + k));
        assert.includes(rtext(app, 'cmf_cres', 'Total slurry'), 'm³');
      } finally { U.setSystem('imperial'); }
      const model = app.win.collectPageReport(app.el('pgBody'), { charts: false });
      const titles = model.results.map((x) => x.title);
      ['Slurry Design', 'Slurry Volume & Sacks', 'Brine Blend'].forEach((x) => assert.ok(titles.indexOf(x) !== -1, 'section ' + x));
      assert.ok(!/width:\s*[4-9]\d\dpx|width:\s*\d{4,}px/.test(app.el('pgBody').innerHTML), 'no fixed widths');
      app.flush(1200);
      app.flushUntilIdle(10000);
      assert.strictEqual(app.pendingTimers(), 0, 'no timers');
      const app2 = app.reload();
      try {
        open(app2, 'complfluids', 'cmf_root');
        assert.rel(app2.win.WTS_state.complfluids.sacks, imp.sacks, 1e-9, 'restored and recalculated');
        app2.hook.nav('home');
        const tiles = app2.findAll('.dash-card').map((c) => String(c.querySelector('h3').textContent).trim());
        ['SO2 / H2S Dispersion Screening', 'Scale & Water Analysis', 'Cement & Completion Fluids'].forEach((x) => assert.ok(tiles.indexOf(x) !== -1, 'tile ' + x));
        ['dispersion', 'scale', 'complfluids'].forEach((k) => {
          const e = app2.win.WTS_calcRegistry[k];
          assert.ok(e && e.key === k && typeof e.render === 'function', 'registry ' + k);
        });
      } finally { app2.dispose(); }
    },
  },
];
