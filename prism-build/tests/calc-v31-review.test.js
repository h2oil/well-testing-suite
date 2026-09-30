// v3.1 calculator review — regression tests for the fixes in the host calculators and Round 5.
//
//   esdhi   relief set-pressure guidance follows ASME VIII-1 UG-134 (set ≤ MAWP; 110 % of MAWP is
//           accumulation, not a set pressure) — the FAIL advice used to suggest raising the RV to
//           MAWP + 10 %, and an RV above MAWP was only flagged beyond 110 %
//   flare   radiation zones also give the at-grade distance from the stack base (the API 521 point-
//           source radius is measured from the flame centre, up in the air)
//   sep     level basis: a horizontal vessel's level is a height fraction, not a volume fraction
//   prv     inlet-line check includes an upstream rupture disk (K 1.5) when present
//   oilgas  method text states the v3.0 supercompressibility Fpv = √(Zb/Zf) (still said 1/√Z)
//
// Every expected number is an independent hand calculation written out below.
'use strict';

function go(app, route) { app.hook.nav(route); app.flush(200); }
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
function rowNum(app, resId, label) {
  const row = app.findAll('#' + resId + ' .rrow').find((r) => { const l = r.querySelector('.rl'); return l && l.textContent.replace(/\s+/g, ' ').indexOf(label) !== -1; });
  if (!row) throw new Error('row "' + label + '" not found in #' + resId + ': ' + text(app, resId).slice(0, 300));
  const m = /-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/i.exec(row.querySelector('.rv').textContent.replace(/,/g, ''));
  return m ? parseFloat(m[0]) : NaN;
}
function clean(assert, app, resId) {
  const t = text(app, resId);
  assert(!/NaN|Infinity|undefined/.test(t), '#' + resId + ' shows NaN/Infinity/undefined: ' + t.slice(0, 200));
  assert.deepStrictEqual(app.consoleErrors().map(String), [], 'no console errors');
}

module.exports = [
  {
    name: 'v3.1 esdhi: relief set-pressure advice follows ASME UG-134 (set ≤ MAWP, not MAWP + 10 %)',
    wp: 'V31',
    run(app, assert) {
      const C = app.win.WTS_esdHiPilot_compute;
      const base = { sectionVolume_ft3: 10, sectionGasTemp_F: 60, gasSG: 0.7, esdResponseTime_s: 5, mawp_psig: 125 };
      // V_std = 10 scf per 14.7 psi; Q = 0.1 MMscfd = 1.15741 scf/s.
      // HP 110 / RD 112: t_fill = 10·2/14.7 / 1.15741 = 1.1755 s < 5 s → FAIL.
      // RD* = HP + q·t·14.7/V = 110 + 1.15741·5·14.7/10 = 118.51 psig ≤ MAWP → raising is allowed.
      const r1 = C(Object.assign({}, base, { gasFlowRate_MMscfd: 0.1, hiPilotSetting_psig: 110, rdSetting_psig: 112 }));
      assert.strictEqual(r1.pass, false);
      assert.near(r1.timeToReachRV_s, 10 * 2 / 14.7 / (0.1e6 / 86400), 1e-9);
      assert.includes(r1.rationale, 'raise the RV to ≥ 119 psig (at or below MAWP)');
      assert.includes(r1.rationale, 'raising a single RV up to MAWP is permissible');
      assert(r1.rationale.indexOf('MAWP+10') === -1 && r1.rationale.indexOf('MAWP + 10') === -1, 'no MAWP + 10 % advice: ' + r1.rationale);
      // Q = 1 MMscfd: RD* = 110 + 11.5741·5·14.7/10 = 195.07 psig > MAWP 125 → not permitted.
      const r2 = C(Object.assign({}, base, { gasFlowRate_MMscfd: 1, hiPilotSetting_psig: 110, rdSetting_psig: 112 }));
      assert.includes(r2.rationale, 'raising the RV to 195 psig would put its set pressure above MAWP');
      assert(r2.rationale.indexOf('raise the RV to ≥') === -1, 'no "raise the RV" option above MAWP');
      // RD 128 = 102.4 % of MAWP → supplemental-device note; RD 135 = 108 % → above 105 % caution.
      const r3 = C(Object.assign({}, base, { gasFlowRate_MMscfd: 0.01, hiPilotSetting_psig: 110, rdSetting_psig: 128 }));
      assert(r3.notes.some((n) => n.indexOf('is above MAWP (125 psig)') !== -1 && n.indexOf('supplemental') !== -1), 'RD 128 note: ' + r3.notes.join(' | '));
      const r4 = C(Object.assign({}, base, { gasFlowRate_MMscfd: 0.01, hiPilotSetting_psig: 110, rdSetting_psig: 135 }));
      assert(r4.notes.some((n) => n.indexOf('above 105 % of MAWP (131 psig)') !== -1), 'RD 135 note: ' + r4.notes.join(' | '));
      // RD at MAWP → no relief-pressure caution.
      const r5 = C(Object.assign({}, base, { gasFlowRate_MMscfd: 0.01, hiPilotSetting_psig: 110, rdSetting_psig: 125 }));
      assert(!r5.notes.some((n) => /RV set pressure/.test(n)), 'RD = MAWP: ' + r5.notes.join(' | '));
    },
  },
  {
    name: 'v3.1 flare: radiation zones give the at-grade distance from the stack base',
    wp: 'V31',
    run(app, assert) {
      go(app, 'flare');
      setAll(app, { fl_flow: 10, fl_nhv: 1000, fl_mw: 20, fl_eff: 100, fl_H: 5, fl_D: 0.5, fl_F: 0.2, fl_tau: 1, fl_W: 0, fl_Wd: 0, fl_Ta: 15 });
      press(app, 'calcFlare');
      // Q = 10e6/24 scf/h × 1000 Btu/scf = 4.16667e8 Btu/h = 122,113 kW = 1.22113e8 W
      const QkW = 10e6 / 24 * 1000 * 0.000293071, QW = 10e6 / 24 * 1000 * 0.29307107;
      const L = 0.00326 * Math.pow(QW, 0.478);                       // API 521 fit, ≈ 23.9 m
      const Uj = 10e6 * 0.02832 / 86400 / (Math.PI * 0.25 / 4);       // 15 °C tip: 16.69 m/s
      const th = Math.atan2(0.1, Uj);                                 // calm wind floored at 0.1 m/s
      const cx = L / 2 * Math.sin(th), cy = 5 + L / 2 * Math.cos(th);
      const D = (K) => Math.sqrt(0.2 * QkW / (4 * Math.PI * K));
      const row = (lbl) => app.findAll('#fl_res tr').find((r) => { const c = r.querySelector('td'); return c && c.textContent.trim().indexOf(lbl) === 0; });
      const cells = (r) => r.querySelectorAll('td').map ? r.querySelectorAll('td') : Array.from(r.querySelectorAll('td'));
      const r500 = Array.from(cells(row('500 BTU')));
      assert.near(parseFloat(r500[3].textContent), D(1.58), 0.051, 'radius from flame centre (35.1 m)');
      assert.near(parseFloat(r500[5].textContent), cx + Math.sqrt(D(1.58) ** 2 - cy * cy), 0.051, 'at grade from stack base (≈ 30.7 m)');
      // 3000 Btu/h/ft²: D = 14.3 m < flame-centre height 17 m → never reached at grade
      const r3000 = Array.from(cells(row('3000 BTU')));
      assert(D(9.46) < cy);
      assert.strictEqual(r3000[5].textContent.trim(), 'not reached');
      assert.includes(text(app, 'fl_res'), 'measured from the flame centre');
      clean(assert, app, 'fl_res');
    },
  },
  {
    name: 'v3.1 sep: horizontal-vessel level basis converts ID height to liquid volume',
    wp: 'V31',
    run(app, assert) {
      go(app, 'sep');
      setAll(app, { sp_cap: 17.4, sp_lvl: 25, sp_q: 6600, sp_basis: 'vol' });
      press(app, 'calcSepRetention');
      // volume basis: 17.4 × 0.25 = 4.35 bbl; t = 4.35 / (6600/1440) = 0.94909 min
      const minsRow = () => { const r = app.findAll('#sp_res .rrow').filter((x) => /Retention Time/.test(x.querySelector('.rl').textContent)); return parseFloat(r[r.length - 1].querySelector('.rv').textContent); };
      assert.near(minsRow(), 4.35 / (6600 / 1440), 0.006);
      setv(app, 'sp_basis', 'hh');
      press(app, 'calcSepRetention');
      // h = 0.25: θ = 2·acos(0.5) = 2.094395; (θ − sin θ)/(2π) = (2.094395 − 0.866025)/6.283185 = 0.195501
      const frac = (2 * Math.acos(0.5) - Math.sin(2 * Math.acos(0.5))) / (2 * Math.PI);
      assert.near(frac, 0.195501, 1e-6);
      assert.near(rowNum(app, 'sp_res', 'Liquid share of vessel volume'), 19.6, 0.051);
      assert.near(rowNum(app, 'sp_res', 'Fluid Volume in Sep.'), 17.4 * frac, 0.006);
      const rows = app.findAll('#sp_res .rrow').filter((r) => r.querySelector('.rl').textContent.indexOf('minutes') === -1 && /Retention Time/.test(r.querySelector('.rl').textContent));
      const mins = parseFloat(rows[rows.length - 1].querySelector('.rv').textContent);
      assert.near(mins, 17.4 * frac / (6600 / 1440), 0.006, 'retention 0.742 min');
      clean(assert, app, 'sp_res');
    },
  },
  {
    name: 'v3.1 prv inlet: an upstream rupture disk adds K 1.5 to the inlet-line loss',
    wp: 'V31',
    run(app, assert) {
      go(app, 'prv');
      app.click('prvt4'); app.flush(20);
      setAll(app, { pi_ps: 250, pi_id: 3.068, pi_len: 15, pi_f: 0.018, pi_el: 2, pi_gv: 1, pi_w: 50000, pi_rho: 1.2, pi_rd: 'yes' });
      press(app, 'calcPRVinlet');
      // A = π/4·(3.068/12)² = 0.051338 ft²; V = 50000/(3600·1.2·A) = 225.45 ft/s
      const A = Math.PI / 4 * Math.pow(3.068 / 12, 2), V = 50000 / (3600 * 1.2 * A);
      // K = 0.018·15·12/3.068 + 0.5 + 2·30·0.018 + 8·0.018 + 1.5 = 1.05606 + 0.5 + 1.08 + 0.144 + 1.5 = 4.28006
      const K = 0.018 * 15 * 12 / 3.068 + 0.5 + 2 * 30 * 0.018 + 8 * 0.018 + 1.5;
      assert.near(rowNum(app, 'pi_res', 'K (rupture disk)'), 1.5, 1e-9);
      assert.near(rowNum(app, 'pi_res', 'K Total'), K, 0.0006);
      const dp = K * 1.2 * V * V / (2 * 32.174 * 144);                // ≈ 28.1 psi
      assert.near(rowNum(app, 'pi_res', 'Inlet ΔP'), dp, 0.006);
      assert.includes(text(app, 'pi_res'), 'FAIL');                   // 28 psi > 3 % of 250 = 7.5 psi
      setv(app, 'pi_rd', 'no');
      press(app, 'calcPRVinlet');
      assert.near(rowNum(app, 'pi_res', 'K Total'), K - 1.5, 0.0006);
      assert(text(app, 'pi_res').indexOf('rupture disk') === -1, 'no rupture-disk row without one');
      clean(assert, app, 'pi_res');
    },
  },
  {
    name: 'v3.1 oilgas: method text states Fpv = √(Zb/Zf) (was the pre-v3.0 1/√Z)',
    wp: 'V31',
    run(app, assert) {
      go(app, 'oilgas');
      const t = text(app, 'pgBody');
      assert.includes(t, 'Fpv = √(Zb/Zf)');
      assert(t.indexOf('Fpv = 1/√Z') === -1, 'stale 1/√Z text removed');
    },
  },
];
