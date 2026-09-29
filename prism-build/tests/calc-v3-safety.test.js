// prism-build/tests/calc-v3-safety.test.js — v3.0 safety-page fixes:
//   1. Sand erosion: DNV-RP-O501 (2015) bend / straight pipe, Salama (2000) elbow,
//      legacy calibrated fit (Pipe Service Life, Pipe Sizing sand card).
//   2. "Schedule 180" → ASME B36.10M XXS (migration of saved values).
//   3. ESD Lo-Pilot section temperature (tagged) — trip criterion is in calc-g4.
//   4. Flame arrestor element types (representative K from published correlations).
//   5. Metric gaps: Chemical, Air Compressor, PRV inlet line + PDF export, Liquid Line basis.
//
// Expected values are independent hand calculations written here from the
// published equations (DNVGL-RP-O501 Aug 2015 §3.2, §4.5, §4.7; DNV-RP-O501
// Rev 4.2 2007 §8.2, §8.4; Salama 2000 JERT 122:71; Idelchik 1994 diagrams
// 4-1/4-9, 8-1, 8-6; ASME B36.10M) — not from the app code.
//
//   node prism-build/accept-test.js --html --file calc-v3-safety
'use strict';

const WP = 'V3S';
const PSI_KPA = 6.894757293168;

function go(app, route, system) {
  app.hook.nav(route); app.flush(50);
  if (system) { app.win.WTS_units.setSystem(system); app.flush(10); }
}
function setv(app, vals) {
  for (const id of Object.keys(vals)) {
    const el = app.el(id);
    if (!el) throw new Error('no input #' + id);
    el.value = String(vals[id]);
  }
}
function calc(app, fnName) {
  const btn = app.findAll('#pgBody button').find((b) => (b.getAttribute('onclick') || '').indexOf(fnName + '(') === 0);
  if (!btn) throw new Error('no button for ' + fnName);
  app.click(btn); app.flush(20);
}
function num(s) {
  const m = String(s).replace(/,/g, '').match(/-?\d+(\.\d+)?(e[-+]?\d+)?/i);
  if (!m) throw new Error('no number in: ' + s);
  return parseFloat(m[0]);
}
function row(app, resId, label) {
  const r = app.findAll('#' + resId + ' .rrow').find((x) => x.querySelector('.rl').textContent.trim().indexOf(label) === 0);
  if (!r) throw new Error('no result row "' + label + '" in #' + resId + ': ' + (app.el(resId) ? app.el(resId).textContent : ''));
  return r.querySelector('.rv').textContent.trim();
}
function trow(app, rootId, first) {
  const tr = app.findAll('#' + rootId + ' tr').find((r) => {
    const c = r.querySelector('td'); return c && String(c.textContent).trim().indexOf(first) === 0;
  });
  if (!tr) throw new Error('no table row "' + first + '" in #' + rootId);
  return Array.prototype.map.call(tr.querySelectorAll('td'), (c) => String(c.textContent).trim());
}
function errText(app, resId) { return app.findAll('#' + resId + ' .val-error').map((e) => e.textContent).join(' | '); }
function clean(app, assert, what) {
  assert.ok(!/NaN|Infinity|∞|undefined/.test(String(app.el('pgBody').textContent)), what + ': NaN/Infinity/undefined on page');
  assert.deepEqual(app.consoleErrors(), [], what + ': console errors');
}

// ── Independent references ────────────────────────────────────────────────
// DNV-RP-O501 (2015) §4.7 pipe bend (same steps as 2007 §8.4 eqs 8.15-8.21).
function dnvBend({ kgPerS, UpMs, Dm, rhoKgM3, muPas, dpM, R, GF }) {
  const a = Math.atan(1 / (2 * R));
  const beta = 2650 / rhoKgM3;
  const A = rhoKgM3 * Math.tan(a) * UpMs * Dm / (muPas * beta);          // = Re·tanα/β
  let gc = 1 / (beta * (1.88 * Math.log(A) - 6.04));
  if (!(gc > 0) || gc >= 0.1) gc = 0.1;
  const gam = dpM / Dm;
  const G = gam < gc ? gam / gc : 1;
  const s = Math.sin(a);
  const F = 0.6 * Math.pow(s + 7.2 * (s - s * s), 0.6) * (1 - Math.exp(-20 * a));
  const At = (Math.PI * Dm * Dm / 4) / s;
  const E = 2.0e-9 * F * Math.pow(UpMs, 2.6) * G * 2.5 * (GF || 1) * kgPerS / (7800 * At) * 1000 * 3600 * 24 * 365;
  return { E, G, gc, A, F, alpha: a };
}
const LB = 0.45359237, FT = 0.3048, IN = 0.0254, LBFT3 = 16.018463;

module.exports = [
  // ── 1. Erosion models ─────────────────────────────────────────────────────
  {
    name: 'V3 erosion models: DNV bend / straight / Salama vs hand calc; ∝ sand, ∝ U^2.6; G branches; legacy = v1.8 fit',
    wp: WP,
    run(app, assert) {
      const W = app.win;
      const ero = (o) => W.WTS_sandErosion_compute(app.toWin(o));
      // Case A: 100 lb/d sand, 100 ft/s, 3.826" ID, ρm 3 lb/ft³, μm 0.02 cP, 250 µm, 1.5D bend
      const A = { model: 'dnv_bend', sand_lb_d: 100, v_fps: 100, D_in: 3.826, rho_m_lbft3: 3, mu_m_cp: 0.02, particle_um: 250, bend_RD: 1.5, GF: 1 };
      const ref = dnvBend({ kgPerS: 100 * LB / 86400, UpMs: 100 * FT, Dm: 3.826 * IN, rhoKgM3: 3 * LBFT3, muPas: 2e-5, dpM: 250e-6, R: 1.5 });
      const rA = ero(A);
      assert.rel(rA.E_mm_y, ref.E * 3.15e10 / (1000 * 3600 * 24 * 365), 1e-9, 'DNV bend mm/y (Cunit rounded to 3.15e10 in the RP)');
      assert.near(rA.alpha_deg, Math.atan(1 / 3) * 180 / Math.PI, 1e-9, 'α = 18.43° for R/D 1.5');
      assert.near(rA.F, 0.8729, 5e-4, 'F(18.43°) ductile');
      assert.strictEqual(rA.G, 1, '250 µm in 4": G = 1');
      assert.rel(rA.E_mpy, rA.E_mm_y / 0.0254, 1e-12);
      // Linear in sand, U^2.6, GF, 1/D² at fixed velocity (G = 1)
      assert.rel(ero(Object.assign({}, A, { sand_lb_d: 300 })).E_mm_y / rA.E_mm_y, 3, 1e-9, 'linear in sand');
      assert.rel(ero(Object.assign({}, A, { v_fps: 150 })).E_mm_y / rA.E_mm_y, Math.pow(1.5, 2.6), 1e-9, '∝ U^2.6');
      assert.rel(ero(Object.assign({}, A, { GF: 2 })).E_mm_y / rA.E_mm_y, 2, 1e-12, 'GF 2 doubles');
      assert.ok(ero(Object.assign({}, A, { bend_RD: 5 })).E_mm_y < rA.E_mm_y, '5D bend erodes less than 1.5D');
      // Case B: fine particles (20 µm) → G = γ/γc < 1
      const B = Object.assign({}, A, { particle_um: 20 });
      const refB = dnvBend({ kgPerS: 100 * LB / 86400, UpMs: 100 * FT, Dm: 3.826 * IN, rhoKgM3: 3 * LBFT3, muPas: 2e-5, dpM: 20e-6, R: 1.5 });
      const rB = ero(B);
      assert.ok(refB.G < 1, 'reference G < 1 for 20 µm');
      assert.rel(rB.G, refB.G, 1e-9, 'G = γ/γc'); assert.rel(rB.gammaC, refB.gc, 1e-9, 'γc = 1/(β(1.88 lnA − 6.04))');
      // Case C: very viscous, slow (A small → 1.88 lnA − 6.04 ≤ 0) → γc = 0.1
      const rC = ero(Object.assign({}, A, { v_fps: 1, mu_m_cp: 500, rho_m_lbft3: 55 }));
      assert.strictEqual(rC.gammaC, 0.1, 'γc = 0.1 at low A');
      assert.rel(rC.G, 250e-6 / (3.826 * IN) / 0.1, 1e-9);
      // DNV straight pipe (2015 eq 4.22): 2.5e-5·Up^2.6·D^-2·ṁp mm/y …
      const rS = ero(Object.assign({}, A, { model: 'dnv_straight' }));
      const mp = 100 * LB / 86400;
      assert.rel(rS.E_mm_y, 2.5e-5 * Math.pow(100 * FT, 2.6) * Math.pow(3.826 * IN, -2) * mp, 1e-12, 'straight pipe');
      // … which is the RP's relative form 8.0e-10·Up^2.6·D^-2 mm per tonne (eq 4.21): 1 t/y = 1000/(365·86400) kg/s
      const perTonne = rS.E_mm_y / mp * (1000 / (365 * 86400));
      assert.rel(perTonne, 8.0e-10 * Math.pow(100 * FT, 2.6) * Math.pow(3.826 * IN, -2), 0.012, 'eq 4.21 ↔ 4.22 consistency');
      assert.ok(rS.E_mm_y < rA.E_mm_y / 10, 'straight pipe ≪ bend');
      // Salama (2000): ER = W·V²·d/(Sm·D²·ρm), W kg/d, V m/s, d µm, D mm, ρm kg/m³, Sm 5.5 (elbow)
      const rSal = ero(Object.assign({}, A, { model: 'salama' }));
      const sal = (100 * LB) * Math.pow(100 * FT, 2) * 250 / (5.5 * Math.pow(3.826 * 25.4, 2) * 3 * LBFT3);
      assert.rel(rSal.E_mm_y, sal, 1e-9, 'Salama elbow');
      assert.ok(rSal.E_mm_y / rA.E_mm_y > 0.3 && rSal.E_mm_y / rA.E_mm_y < 3, 'Salama and DNV bend agree within ×3: ' + (rSal.E_mm_y / rA.E_mm_y).toFixed(2));
      // Legacy calibrated fit (v1.8): 2.8·(c/300)·W·v²/D² mpy; old API name is an alias
      const rL = ero({ model: 'legacy', sand_lbMMscf: 50, c: 300, v_fps: 30, D_in: 4 });
      assert.rel(rL.E_mpy, 2.8 * 50 * 900 / 16, 1e-12, 'legacy fit');
      assert.strictEqual(W.WTS_erosion_rate_salama(50, 30, 4, 300), rL.E_mpy, 'deprecated alias = legacy');
      assert.near(W.WTS_dnv_F(Math.PI / 2), 0.6, 1e-12, 'F(90°) = A = 0.6');
      assert.strictEqual(ero(Object.assign({}, A, { sand_lb_d: 0 })).E_mm_y, 0, 'no sand → 0');
    },
  },

  // ── 1b. Pipe Service Life page ────────────────────────────────────────────
  {
    name: 'V3 pipelife: DNV bend default (Choke→Heater 71.9 mm/y, RSL 9.7 d; v1.8 fit 8358 mm/y, 1.8 h); legacy selectable; GF / model inputs',
    wp: WP,
    run(app, assert) {
      app.storage.removeItem && app.storage.removeItem('wts_pipelife');
      go(app, 'pipelife'); app.flush(500);
      const rep = () => app.win.WTS_pipelife_lastReport;
      assert.equal(rep().erosion_model, 'dnv_bend');
      assert.includes(app.el('wts_pl_model_line').textContent, 'DNV-RP-O501 pipe bend');
      // Choke → Heater: 3" XXS (ID 2.300"), 500 psig / 100 °F, 10 MMscfd SG 0.65 + 1000 bpd oil SG 0.8 + 200 bpd water
      const P = 514.696, T = 559.67;
      const qg = 10e6 / 86400 * (14.696 / P) * (T / 519.67), qo = 1000 * 5.615 / 86400, qw = 200 * 5.615 / 86400, q = qg + qo + qw;
      const rhoG = P * 28.9647 * 0.65 / (10.7316 * T);
      const rhoM = (rhoG * qg + 62.37 * 0.8 * qo + 62.37 * qw) / q;          // lb/ft³
      const muM = (0.012 * qg + 1 * qo + 1 * qw) / q;                        // cP
      const D = 2.300, v = q / (Math.PI / 4 * Math.pow(D / 12, 2));
      const seg3 = rep().segments[3];
      assert.rel(seg3.mixture_velocity_fps, v, 1e-9, 'velocity');
      assert.rel(seg3.rho_m_lbft3, rhoM, 1e-9, 'ρm');
      const ref = dnvBend({ kgPerS: 50 * 10 * LB / 86400, UpMs: v * FT, Dm: D * IN, rhoKgM3: rhoM * LBFT3, muPas: muM / 1000, dpM: 250e-6, R: 1.5 });
      const Emm = ref.E * 3.15e10 / (1000 * 3600 * 24 * 365);
      assert.rel(seg3.erosion_rate_mm_yr, Emm, 1e-6, 'DNV bend (hand calc ' + Emm.toFixed(2) + ' mm/y)');   // 71.9 mm/y
      const rsl = (0.600 - 0.525) * 1000 / (Emm / 0.0254) * 365.25;
      assert.rel(seg3.remaining_service_life_days, rsl, 1e-6, 'RSL (' + rsl.toFixed(2) + ' d)');              // 9.67 d
      assert.near(num(app.el('wts_pl_seg3_ero').textContent), Emm / 0.0254, 1, 'mpy cell');
      // Legacy selectable: the v1.8 fit on the same segment
      app.el('wts_pl_model').value = 'legacy'; app.input('wts_pl_c', '300'); app.flush(500);
      assert.equal(rep().erosion_model, 'legacy');
      assert.rel(rep().segments[3].erosion_rate_mils_yr, 2.8 * 50 * v * v / (D * D), 1e-9, 'legacy = 2.8·W·v²/D²');
      assert.includes(app.el('wts_pl_model_line').textContent, 'Legacy');
      // GF 2 doubles the bend erosion
      app.el('wts_pl_model').value = 'dnv_bend'; app.el('wts_pl_gf').value = '2'; app.input('wts_pl_rd', '1.5'); app.flush(500);
      assert.rel(rep().segments[3].erosion_rate_mm_yr, 2 * Emm, 1e-6, 'GF 2');
      // Oil SG is tagged and used in ρm
      app.el('wts_pl_gf').value = '1'; app.input('wts_pl_osg', '0.9'); app.flush(500);
      const rhoM9 = (rhoG * qg + 62.37 * 0.9 * qo + 62.37 * qw) / q;
      assert.rel(rep().segments[3].rho_m_lbft3, rhoM9, 1e-9, 'oil SG 0.9');
      assert.includes(JSON.stringify(app.win.collectPageReport(app.el('pgBody'), { charts: false })), 'Erosion Model');
      clean(app, assert, 'pipelife');
    },
  },
  {
    name: 'V3 pipelife: saved "Schedule 180" loads as ASME B36.10M XXS with a visible note; nominal walls per B36.10M',
    wp: WP,
    run(app, assert) {
      const saved = { wts_pl_seg2_sch: '180', wts_pl_seg2_nps: '4', wts_pl_seg3_sch: '180', wts_pl_seg3_nps: '3', wts_pl_seg4_sch: 'XXH', wts_pl_sand: '50' };
      app.storage.setItem('wts_pipelife', JSON.stringify(saved));
      go(app, 'pipelife'); app.flush(500);
      assert.equal(app.el('wts_pl_seg2_sch').value, 'XXS');
      assert.equal(app.el('wts_pl_seg3_sch').value, 'XXS');
      assert.equal(app.el('wts_pl_seg4_sch').value, 'XXS');
      const note = app.el('wts_pl_schnote').textContent;
      assert.includes(note, 'Schedule 180 is not an ASME B36.10M schedule');
      assert.includes(note, 'SSV → Choke'); assert.includes(note, 'Choke → Heater');
      assert.includes(note, '0.600');                  // 3" XXS nominal
      assert.equal(app.win.WTS_pipelife_lastReport.segments[3].sch, 'XXS');
      // Stored state is migrated too
      assert.equal(JSON.parse(app.storage.getItem('wts_pipelife')).wts_pl_seg3_sch, 'XXS');
      // Pure API: '180' / 'XXH' map to XXS; 8" XXS = 0.875" (v1.8 "180" used 1.000", in no table)
      const seg = app.win.WTS_pipelife_segment(app.toWin({ material: 'A106-B', schedule_in: 180, nps_in: 8, design_pressure_psig: 100 }));
      assert.equal(seg.sch, 'XXS'); assert.near(seg.measured_WT_in, 0.875, 1e-12);
      assert.equal(seg.schedule_migrated_from, '180');
      const opts = Array.prototype.filter.call(app.el('wts_pl_seg0_sch').options, (o) => !o.hidden).map((o) => o.value);
      assert.deepEqual(opts, ['40', '80', '160', 'XXS'], 'visible schedule options');
      clean(app, assert, 'pipelife migration');
    },
  },

  // ── 3. ESD Lo-Pilot temperature ───────────────────────────────────────────
  {
    name: 'V3 esdlo: section temperature tagged (°C in Metric); 15.56 °C typed = 60 °F case; 100 °C → ΔP × 671.67/519.67',
    wp: WP,
    run(app, assert) {
      go(app, 'esdlo', 'metric');
      const lab = app.el('wts_esdlo_temp').closest('.fg-item').querySelector('label').textContent;
      assert.includes(lab, '°C');
      setv(app, { wts_esdlo_volume: 4.36 * 0.028316846592, wts_esdlo_pflow: 1971 * PSI_KPA, wts_esdlo_qleak: 0.05 * 28.3168,
        wts_esdlo_whsip: 2100 * PSI_KPA, wts_esdlo_tresp: 5, wts_esdlo_margin: 5 * PSI_KPA, wts_esdlo_temp: (60 - 32) / 1.8 });
      app.click('wts_esdlo_calc_btn'); app.flush(10);
      const dP = 0.05e6 / 86400 * 5 * 14.7 / 4.36;
      assert.rel(app.win.WTS_state.esdLoPilot.pressureDrop_psi, dP, 1e-4, 'metric 15.56 °C = 60 °F');
      assert.near(app.win.WTS_state.esdLoPilot.sectionTemp_F, 60, 1e-6);
      setv(app, { wts_esdlo_temp: 100 });
      app.click('wts_esdlo_calc_btn'); app.flush(10);
      assert.rel(app.win.WTS_state.esdLoPilot.pressureDrop_psi, dP * (212 + 459.67) / 519.67, 1e-4, 'ΔP ∝ T');
      assert.includes(trow(app, 'wts_esdlo_results', 'Section gas temperature')[1], '°C');
      app.win.WTS_units.setSystem('imperial');
      clean(app, assert, 'esdlo metric');
    },
  },

  // ── 4. Flame arrestor element types ───────────────────────────────────────
  {
    name: 'V3 flamearr: element types (crimped 10, perforated 4.2, mesh 6.6, sintered 90) match their published-correlation derivation; default unchanged; user K',
    wp: WP,
    run(app, assert) {
      // Derivation (in-line housing, element area 4× bore): housing = (1 − 1/4)² + 0.5(1 − 1/4) (Idelchik 4-1 / 4-9)
      const AR = 4, Kh = Math.pow(1 - 1 / AR, 2) + 0.5 * (1 - 1 / AR);
      const f = 0.4;
      const zPlate = Math.pow(0.707 * Math.pow(1 - f, 0.375) + 1 - f, 2) / (f * f);     // Idelchik 8-1, thin plate
      const zScreen = 1.3 * (1 - f) + Math.pow(1 / f - 1, 2);                            // Idelchik 8-6, wire screen
      const Kperf = Kh + 6 * zPlate / (AR * AR), Kmesh = Kh + 30 * zScreen / (AR * AR);
      const Ksint = Kh + (1.8e-5 * (5 / AR) * 0.003 / 5e-11) / (0.5 * 1.2 * 25);          // Darcy, 5 m/s in the pipe
      const crimp = (Vp) => {                                                             // Shah & London fRe 13.33 (Fanning)
        const h = 0.7e-3, Dh = 2 * h / 3, L = 0.025, eps = 0.75, Vc = Vp / AR / eps;
        const Re = 1.2 * Vc * Dh / 1.8e-5, fD = 4 * 13.33 / Re;
        return Kh + (fD * L / Dh + 1.5) / (eps * eps) / (AR * AR);
      };
      assert.near(Kperf, 4.2, 0.05, 'perforated plate ' + Kperf.toFixed(3));
      assert.near(Kmesh, 6.6, 0.05, 'wire mesh ' + Kmesh.toFixed(3));
      assert.rel(Ksint, 90, 0.02, 'sintered ' + Ksint.toFixed(1));
      assert.ok(crimp(3) > 10 && crimp(5) < 10, 'crimped ribbon 10 lies between the 3 m/s (' + crimp(3).toFixed(1) + ') and 5 m/s (' + crimp(5).toFixed(1) + ') estimates');
      // Page: 500 MSCFD MW 18 @ 30 °C, 3" line
      go(app, 'flamearr');
      const TR = 86 + 460, acfm = 500e3 / 1440 * TR / 520, rho = 14.7 * 18 / (10.7316 * TR);
      const dp = (id, K) => { const V = acfm / (Math.PI / 4 * Math.pow(id / 12, 2)) / 60; return K * rho * V * V / (2 * 32.174 * 144); };
      assert.equal(app.el('fa_elem').value, 'crimped', 'default type');
      app.el('fa_type').value = 'il'; calc(app, 'calcFlameArr');
      assert.near(num(trow(app, 'fa_res', '3"')[2]), dp(3.068, 10), 2e-3, 'default in-line K 10 unchanged');
      for (const [t, K] of [['perf', 4.2], ['mesh', 6.6], ['sintered', 90]]) {
        app.el('fa_elem').value = t; calc(app, 'calcFlameArr');
        assert.near(num(trow(app, 'fa_res', '4"')[2]), dp(4.026, K), 2e-3, t);
        assert.near(num(row(app, 'fa_res', 'Element K used')), K, 1e-9);
      }
      app.el('fa_type').value = 'eol'; app.el('fa_elem').value = 'mesh'; calc(app, 'calcFlameArr');
      assert.near(num(row(app, 'fa_res', 'Element K used')), 7.6, 1e-9, 'end-of-line + 1 exit head');
      app.el('fa_elem').value = 'user'; setv(app, { fa_k: '' }); calc(app, 'calcFlameArr');
      assert.match(errText(app, 'fa_res'), /User K/);
      setv(app, { fa_k: 25 }); calc(app, 'calcFlameArr');
      assert.near(num(row(app, 'fa_res', 'Element K used')), 25, 1e-9);
      assert.includes(row(app, 'fa_res', 'Element K used'), 'entered');
      clean(app, assert, 'flamearr');
    },
  },

  // ── 5. Metric gaps ────────────────────────────────────────────────────────
  {
    name: 'V3 metric: Chemical psi/ft → kPa/m and ppg → kg/m³; Air Compressor SCF/D → Sm³/d; Liquid Line basis; flip re-runs',
    wp: WP,
    run(app, assert) {
      // Chloride: A 29.3 ml, N 0.1, D 1 ml → 103,868.5 ppm Cl, NaCl ×1.65, gradient 0.433 + ppmNaCl·3.68e-7
      go(app, 'chem'); calc(app, 'calcChloride');
      const cl = 29.3 * 0.1 * 35450, grad = 0.433 + cl * 1.65 * 3.68e-7, mw = grad / 0.052;
      assert.near(num(row(app, 'cl_res', 'Est. Pressure Gradient')), grad, 6e-4);
      assert.includes(row(app, 'cl_res', 'Est. Pressure Gradient'), 'psi/ft');
      app.win.WTS_units.setSystem('metric'); app.flush(20);
      assert.near(num(row(app, 'cl_res', 'Est. Pressure Gradient')), grad * PSI_KPA / 0.3048, 0.006);   // kPa/m
      assert.includes(row(app, 'cl_res', 'Est. Pressure Gradient'), 'kPa/m');
      assert.near(num(row(app, 'cl_res', 'Est. Equivalent Mud Wt')), mw * 119.826427, 0.6);           // kg/m³
      assert.includes(row(app, 'cl_res', 'Est. Equivalent Mud Wt'), 'kg/m');
      // Air compressor: 150 SCFM → 165 SCFM selected, 237,600 SCF/D = 6,728 Sm³/d
      go(app, 'aircomp'); setv(app, { ac_q: 150, ac_p: 100 * PSI_KPA }); calc(app, 'calcAirComp');
      assert.near(num(row(app, 'ac_res', 'Daily Capacity')), 165 * 1440 * 0.0283168466, 0.6);
      assert.includes(row(app, 'ac_res', 'Daily Capacity'), 'Sm³/d');
      assert.equal(num(row(app, 'ac_res', 'Selected Capacity')), 165);
      app.win.WTS_units.setSystem('imperial'); app.flush(20);
      assert.equal(num(row(app, 'ac_res', 'Daily Capacity')), 165 * 1440);
      assert.includes(row(app, 'ac_res', 'Daily Capacity'), 'SCF/D');
      // Liquid Line basis text follows the unit system
      go(app, 'liquidline', 'metric');
      const btn = app.findAll('#pgBody button').find((b) => /calc|Calculate/i.test(String(b.textContent)));
      if (btn) { app.click(btn); app.flush(50); }
      const txt = String(app.el('pgBody').textContent);
      if (/Standard-volume basis/.test(txt)) {
        assert.includes(trow(app, 'pgBody', 'Standard-volume basis')[1], '15.6 °C / 101.35 kPa');
      } else {
        assert.ok(false, 'liquid line result table not shown');
      }
      app.win.WTS_units.setSystem('imperial');
      clean(app, assert, 'metric gaps');
    },
  },
  {
    name: 'V3 PRV: inlet-line inputs tagged (metric-typed = imperial, kPa results); PDF export in Metric shows kPa / mm², not psia',
    wp: WP,
    run(app, assert) {
      go(app, 'prv'); app.click('prvt4'); app.flush(10);
      app.win.calcPRVinlet(); app.flush(10);
      const A = Math.PI / 4 * Math.pow(3.068 / 12, 2), V = 50000 / (3600 * 1.2 * A);
      const K = 0.018 * 15 * 12 / 3.068 + 0.5 + 2 * 30 * 0.018 + 8 * 0.018;
      const dP = K * 1.2 * V * V / (2 * 32.174 * 144);
      assert.near(num(row(app, 'pi_res', 'Inlet ΔP')), dP, 0.01);
      // Metric: type the same case in kPa(g), mm, m, kg/h, kg/m³
      go(app, 'prv', 'metric'); app.click('prvt4'); app.flush(10);
      const lab = app.el('pi_ps').closest('.fg-item').querySelector('label').textContent;
      assert.includes(lab, 'kPa');
      setv(app, { pi_ps: 250 * PSI_KPA, pi_id: 3.068 * 25.4, pi_len: 15 * 0.3048, pi_w: 50000 * 0.45359237, pi_rho: 1.2 * 16.018463 });
      calc(app, 'calcPRVinlet');
      assert.near(num(row(app, 'pi_res', 'Inlet ΔP')), dP * PSI_KPA, 0.2, 'kPa');
      assert.includes(row(app, 'pi_res', 'Inlet ΔP'), 'kPa');
      assert.near(num(row(app, 'pi_res', 'Gas Velocity')), V * 0.3048, 0.01, 'm/s');
      // PDF export (gas tab) in Metric
      app.click('prvt1'); app.flush(10);
      app.win.calcPRVgas(); app.flush(10);
      let html = '';
      app.win.__reportOverride = (t, c) => { html = String(c); };
      app.win.prvExportPDF('gas');
      assert.ok(html.length > 0, 'report captured');
      assert.ok(!/psia|psig|in²|lb\/h/.test(html), 'no imperial units in the Metric PDF: ' + (html.match(/.{20}(psia|psig|in²|lb\/h).{5}/) || [''])[0]);
      assert.includes(html, 'kPa(a)'); assert.includes(html, 'kPa(g)'); assert.includes(html, 'mm²'); assert.includes(html, 'kg/hr');
      app.win.WTS_units.setSystem('imperial'); app.flush(10);
      app.win.prvExportPDF('gas');
      assert.includes(html, '289.7 psia'); assert.includes(html, 'in²');
      delete app.win.__reportOverride;
      clean(app, assert, 'prv');
    },
  },
];
