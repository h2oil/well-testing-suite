// Roadmap calculator #9 — Choke Performance & Critical Flow (route `chokeperf`,
// prism-build/49-calc-chokeperf.js, Round-9 plug-in registry).
//
// Expected values are independent hand calculations written out below:
//   • critical ratio (2/(k+1))^(k/(k−1)) — textbook values 0.5283 (k = 1.4) and
//     0.5457 (k = 1.3);
//   • gas through a bean: isentropic nozzle mass flow solved in SI,
//     ṁ = Cd·A·√(2·ρ1·p1·k/(k−1)·(r^(2/k) − r^((k+1)/k))), ρ1 = p1·M/(Z·R·T1),
//     q_sc = ṁ/ρ_sc (60 °F, 14.696 psia) — and cross-checked against the
//     field-unit sonic form q = 879·C·A·p1·√(k/(γ·T·Z)·(2/(k+1))^((k+1)/(k−1)))
//     (Guo, Lyons & Ghalambor 2007, Eq. 5.8; 879 is rounded, so ±0.1 %);
//   • multiphase beans q = p1·S^b/(a·GLR^c) with the published constants
//     (Gilbert 10/1.89/0.546, Ros 17.4/2/0.5, Baxendell 9.56/1.93/0.546,
//     Achong 3.82/1.88/0.65), literal values worked by hand at 1500 psig,
//     32/64", GLR 1000 scf/STB: 2414.5, 2791.5, 2901.2, 2976.5 STB/d; and the
//     host Choke Flow Rates page (Gilbert 435·(GLR/1000)^0.546, Ros) agrees;
//   • bean-up: liquid — straight wellhead line meets q = K·pwh in closed form
//     pwh = q0·pws/(K·(pws − p1) + q0); gas — own bisection of the SI nozzle
//     against q = Cw·(pws² − pwh²)^n.
'use strict';

const WP = 'CHOKE';

function rows(app, resId) {
  return app.findAll('#' + resId + ' .rrow').map((r) => {
    const l = r.querySelector('.rl'), v = r.querySelector('.rv');
    return { l: String(l ? l.textContent : '').trim(), v: String(v ? v.textContent : '').trim() };
  });
}
function rv(app, resId, label, nth) {
  const r = rows(app, resId).find((x) => x.l === label);
  if (!r) throw new Error('no result row "' + label + '" in #' + resId + ': ' + JSON.stringify(rows(app, resId).map((x) => x.l)));
  const nums = r.v.replace(/,/g, '').match(/-?\d+(\.\d+)?(e[-+]?\d+)?/gi);
  if (!nums || nums[nth || 0] == null) throw new Error('row "' + label + '" has no number #' + (nth || 0) + ': ' + r.v);
  return parseFloat(nums[nth || 0]);
}
function rtext(app, resId, label) { const r = rows(app, resId).find((x) => x.l === label); return r ? r.v : null; }
function txt(app, id) { const e = app.el(id); return String(e ? e.textContent : '').trim(); }
function errText(app, resId) { return app.findAll('#' + resId + ' .val-error').map((e) => e.textContent).join(' | '); }
function noBadNumbers(assert, app, where) {
  const t = String(app.el('pgBody').textContent || '');
  assert.ok(!/NaN|Infinity|∞|undefined/.test(t), where + ': page shows NaN/Infinity/undefined');
}
function set(app, vals) {
  for (const k of Object.keys(vals)) {
    if (!app.el(k)) throw new Error('no input #' + k);
    if (app.el(k).tagName === 'SELECT') app.select(k, String(vals[k]));
    else app.input(k, String(vals[k]));
  }
}
function open(app) {
  const b = app.find('.nav-btn[data-p="chokeperf"]');
  if (!b) throw new Error('no chokeperf nav button');
  app.click(b);
  if (!app.el('ck_root')) throw new Error('chokeperf page did not render');
}
const calc = (app) => app.click('ck_calc');
const S = (app) => app.win.WTS_state.chokeperf;

// ── Independent references ───────────────────────────────────────────
const PSI = 6894.757, IN2 = 6.4516e-4, RU = 8.314462, MAIR = 0.0289647, SCF = 0.028316846592;
// SI isentropic nozzle; returns Mscf/d at 60 °F / 14.696 psia.
function nozzle(s64, cd, p1a, p2a, TR, sg, k, Z) {
  const rc = Math.pow(2 / (k + 1), k / (k - 1)), r = Math.max(p2a / p1a, rc);
  const A = Math.PI / 4 * Math.pow(s64 / 64, 2) * IN2, p = p1a * PSI, T = TR / 1.8, M = MAIR * sg;
  const rho1 = p * M / (Z * RU * T);
  const mdot = cd * A * Math.sqrt(2 * rho1 * p * k / (k - 1) * (Math.pow(r, 2 / k) - Math.pow(r, (k + 1) / k)));
  const rhoSc = 14.696 * PSI * M / (RU * 519.67 / 1.8);
  return mdot / rhoSc / SCF * 86400 / 1000;
}
// Guo et al. (2007) Eq. 5.8, sonic flow, field units (constant rounded to 879).
function guoSonic(s64, cd, p1a, TR, sg, k, Z) {
  const A = Math.PI / 4 * Math.pow(s64 / 64, 2);
  return 879 * cd * A * p1a * Math.sqrt(k / (sg * TR * Z) * Math.pow(2 / (k + 1), (k + 1) / (k - 1)));
}
// v3.0: Gilbert in his published form q = p1·S^1.89/(435·R^0.546), R in Mscf/bbl (GLR/1000);
// the others as tabulated with GLR in scf/STB.
const CORR = { ros: [17.4, 2, 0.5], baxendell: [9.56, 1.93, 0.546], achong: [3.82, 1.88, 0.65] };
const bean = (key, p, s, glr) => {
  if (key === 'gilbert') return p * Math.pow(s, 1.89) / (435 * Math.pow(glr / 1000, 0.546));
  const [a, b, c] = CORR[key]; return p * Math.pow(s, b) / (a * Math.pow(glr, c));
};

const GAS = { ck_fluid: 'gas', ck_size: 32, ck_sunit: '64', ck_p1: 1000, ck_p2: 200, ck_t: 100, ck_sg: 0.65, ck_cd: 0.85,
  ck_co2: 0, ck_h2s: 0, ck_n2: 0, ck_k: 1.3, ck_z: 0.88, ck_pws: '', ck_qmg: '', ck_n: 1 };
const LIQ = { ck_fluid: 'liquid', ck_size: 32, ck_sunit: '64', ck_p1: 1500, ck_p2: 300, ck_glr: 1000, ck_wc: 20, ck_corr: 'gilbert', ck_pws: '', ck_qml: '' };

module.exports = [
  {
    name: 'CHOKE compute: critical ratio, SI nozzle gas rate (critical and subcritical), Guo sonic form, bean correlations',
    wp: WP,
    run(app, assert) {
      const W = app.win;
      ['renderChokePerf', 'calcChokePerf', 'WTS_chokeperf_compute', 'WTS_chokeperf_criticalRatio', 'WTS_chokeperf_gasRate', 'WTS_chokeperf_multiphaseRate']
        .forEach((f) => assert.strictEqual(typeof W[f], 'function', f));
      assert.near(W.WTS_chokeperf_criticalRatio(1.4), 0.5283, 5e-5, 'rc k=1.4');
      assert.near(W.WTS_chokeperf_criticalRatio(1.3), 0.5457, 5e-5, 'rc k=1.3');
      const F = W.WTS_chokeperf_compute;
      // Critical: 1000 psig → 200 psig, 32/64", Cd 0.85, 100 °F, 0.65, k 1.3, Z 0.88
      const a = F({ fluid: 'gas', s64: 32, p1: 1000, p2: 200, t: 100, sg: 0.65, cd: 0.85, k: 1.3, z: 0.88 });
      assert.ok(a.ok, JSON.stringify(a.errors));
      const ref = nozzle(32, 0.85, 1014.696, 214.696, 559.67, 0.65, 1.3, 0.88);
      assert.rel(a.q, ref, 1e-4, 'critical gas rate vs SI nozzle (' + ref.toFixed(1) + ' Mscf/d)');
      assert.rel(a.q, guoSonic(32, 0.85, 1014.696, 559.67, 0.65, 1.3, 0.88), 1.5e-3, 'Guo Eq. 5.8 sonic form');
      assert.ok(a.critical, 'critical');
      assert.rel(a.qCrit, a.q, 1e-12, 'critical rate = rate');
      assert.near(a.p2CritMax, 0.5457277 * 1014.696 - 14.696, 0.01, 'highest downstream pressure for critical flow');
      // Subcritical: 1000 → 800 psig
      const b = F({ fluid: 'gas', s64: 32, p1: 1000, p2: 800, t: 100, sg: 0.65, cd: 0.85, k: 1.3, z: 0.88 });
      assert.rel(b.q, nozzle(32, 0.85, 1014.696, 814.696, 559.67, 0.65, 1.3, 0.88), 1e-4, 'subcritical gas rate');
      assert.ok(!b.critical && b.q < a.q, 'subcritical is lower');
      // Direct helper, other base conditions: q ∝ Tb/Pb
      const q1 = W.WTS_chokeperf_gasRate({ s64: 20, cd: 0.8, p1a: 2000, p2a: 500, tR: 600, sg: 0.7, k: 1.27, z: 0.85 });
      assert.rel(q1, nozzle(20, 0.8, 2000, 500, 600, 0.7, 1.27, 0.85), 1e-4, 'helper');
      const q2 = W.WTS_chokeperf_gasRate({ s64: 20, cd: 0.8, p1a: 2000, p2a: 500, tR: 600, sg: 0.7, k: 1.27, z: 0.85, Tb_R: 518.67, Pb: 14.65 });
      assert.rel(q2 / q1, (518.67 / 519.67) * (14.696 / 14.65), 1e-9, 'base-condition scaling (q_sc ∝ Tb/Pb)');
      // Multiphase: literal hand values at 1500 psig, 32/64", GLR 1000
      // Gilbert 1500·32^1.89/435 = 2411.77 (was 2414.49 with the rounded a = 10.00)
      const lit = { gilbert: 2411.77, ros: 2791.53, baxendell: 2901.17, achong: 2976.53 };
      for (const k of Object.keys(lit)) {
        assert.rel(W.WTS_chokeperf_multiphaseRate(k, 1500, 32, 1000), lit[k], 2e-6, k);
        assert.rel(W.WTS_chokeperf_multiphaseRate(k, 1500, 32, 1000), bean(k, 1500, 32, 1000), 1e-12, k + ' formula');
      }
      const m = F({ fluid: 'liquid', s64: 32, p1: 1500, p2: 300, glr: 1000, wc: 20, corr: 'ros' });
      assert.ok(m.ok && m.corr === 'ros', 'liquid ok');
      assert.rel(m.q, 2791.53, 2e-6, 'selected Ros');
      assert.rel(m.qOil, 2791.53 * 0.8, 2e-6, 'oil = liquid × (1 − WC)');
      assert.near(m.ratio, 314.696 / 1514.696, 1e-9, 'p2/p1 abs');
      assert.ok(m.critical === true, '0.208 ≤ 0.588');
      assert.rel(m.spreadPct, 100 * (2976.53 / 2411.77 - 1), 1e-4, 'spread');
    },
  },
  {
    name: 'CHOKE gas page: k and Z from Gas PVT by default, entered overrides, bean-up against a back-pressure curve (own bisection)',
    wp: WP,
    run(app, assert) {
      const W = app.win;
      const b = app.find('.nav-btn[data-p="chokeperf"]');
      assert.ok(b, 'sidebar button');
      assert.strictEqual(String(b.closest('.nav-group').querySelector('.nav-group-label').textContent).trim(), 'Metering & Chokes');
      open(app);
      assert.strictEqual(txt(app, 'pgTitle'), 'Choke Performance & Critical Flow');
      // Defaults: 24/64", 1500 → 400 psig, 120 °F, 0.7, k and Z from Gas PVT
      const s0 = S(app);
      assert.ok(s0.ok && s0.fluid === 'gas', 'defaults compute');
      const k0 = W.WTS_gaspvt_k(0.7, 120, 0, 0, 0), z0 = W.WTS_gaspvt_compute({ sg: 0.7, p: 1514.696, t: 120 }).z;
      assert.rel(s0.k, k0, 1e-12, 'k from Gas PVT'); assert.rel(s0.z, z0, 1e-12, 'Z from Gas PVT');
      assert.ok(s0.k > 1.2 && s0.k < 1.3, 'k plausible for a 0.7 gas: ' + s0.k);
      assert.rel(s0.q, nozzle(24, 0.85, 1514.696, 414.696, 579.67, 0.7, k0, z0), 1e-4, 'default rate');
      assert.includes(rtext(app, 'ck_res', 'Cp/Cv (k)'), 'Gas PVT');
      assert.includes(rtext(app, 'ck_res', 'Z at upstream conditions'), 'DAK');
      assert.rel(rv(app, 'ck_res', 'Critical pressure ratio (p2/p1)c'), W.WTS_chokeperf_criticalRatio(k0), 1e-3);
      assert.strictEqual(rtext(app, 'ck_res', 'Flow regime'), 'Critical (sonic)');
      // Overrides + bean-up: pws 1800 psig, n = 0.8
      set(app, Object.assign({}, GAS, { ck_pws: 1800, ck_n: 0.8 })); calc(app);
      const s = S(app);
      assert.strictEqual(s.kSrc, 'input'); assert.strictEqual(s.zSrc, 'input');
      const q0 = nozzle(32, 0.85, 1014.696, 214.696, 559.67, 0.65, 1.3, 0.88);
      assert.rel(s.q, q0, 1e-4, 'current rate');
      assert.rel(rv(app, 'ck_res', 'Gas rate'), q0, 1e-3, 'rate row');
      const pws = 1814.696, Cw = q0 / Math.pow(pws * pws - 1014.696 * 1014.696, 0.8);
      assert.deepEqual(s.beanUp.map((x) => x.s64), [34, 36, 40, 44], 'next four standard beans');
      s.beanUp.forEach((row) => {
        let lo = 214.696, hi = pws;
        for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (nozzle(row.s64, 0.85, mid, 214.696, 559.67, 0.65, 1.3, 0.88) > Cw * Math.pow(pws * pws - mid * mid, 0.8)) hi = mid; else lo = mid; }
        const pwh = (lo + hi) / 2;
        assert.rel(row.pwh + 14.696, pwh, 1e-4, row.s64 + '/64 WHP');
        assert.rel(row.q, Cw * Math.pow(pws * pws - pwh * pwh, 0.8), 1e-4, row.s64 + '/64 rate');
      });
      assert.ok(s.beanUp[0].q > q0 && s.beanUp[0].pwh < 1000, 'bean-up raises rate and lowers WHP');
      const trs = app.findAll('#ck_btbl tbody tr');
      assert.strictEqual(trs.length, 5, 'now + 4 rows');
      assert.includes(txt(app, 'ck_btbl'), '34/64" (0.5313")');
      // Measured rate tunes the bean equation: f = qm / q
      set(app, { ck_qmg: Math.round(q0 * 0.9) }); calc(app);
      assert.rel(S(app).f, Math.round(q0 * 0.9) / q0, 1e-6, 'tuning factor');
      assert.rel(S(app).q0, Math.round(q0 * 0.9), 1e-12, 'current point = measured');
      // Decimal inches: 0.5" = 32/64"
      set(app, { ck_qmg: '', ck_sunit: 'in', ck_size: 0.5 }); calc(app);
      assert.strictEqual(S(app).s64, 32); assert.rel(S(app).q, q0, 1e-4, 'same bean in inches');
      // Chart drawn with one line per bean + wellhead curve + points
      assert.ok(app.canvasLog('ck_chart').length > 20, 'chart drawn');
      noBadNumbers(assert, app, 'gas');
      assert.deepEqual(app.consoleErrors(), []);
    },
  },
  {
    name: 'CHOKE multiphase page: four correlations, host Choke Flow Rates agreement, closed-form bean-up, critical-flow warnings',
    wp: WP,
    run(app, assert) {
      const W = app.win;
      open(app);
      set(app, Object.assign({}, LIQ, { ck_pws: 2400 })); calc(app);
      const s = S(app);
      assert.ok(s.ok && s.fluid === 'liquid', 'liquid');
      assert.rel(s.rates.gilbert, 2411.77, 2e-6); assert.rel(s.rates.ros, 2791.53, 2e-6);
      assert.rel(s.rates.baxendell, 2901.17, 2e-6); assert.rel(s.rates.achong, 2976.53, 2e-6);
      assert.rel(rv(app, 'ck_res', 'Liquid rate (selected)'), 2414, 1e-3);
      assert.rel(rv(app, 'ck_res', 'Oil rate (selected)'), 2411.77 * 0.8, 1e-3);
      assert.strictEqual(app.findAll('#ck_res table.dtable')[0].querySelectorAll('tbody tr').length, 4, 'correlation table');
      // bean-up closed form with Gilbert
      const K = (sz) => Math.pow(sz, 1.89) / (435 * Math.pow(1000 / 1000, 0.546));
      const q0 = bean('gilbert', 1500, 32, 1000);   // 2411.77
      s.beanUp.forEach((row) => {
        const pwh = q0 * 2400 / (K(row.s64) * (2400 - 1500) + q0);
        assert.rel(row.pwh, pwh, 1e-6, row.s64 + ' WHP'); assert.rel(row.q, K(row.s64) * pwh, 1e-6, row.s64 + ' rate');
      });
      // host Choke Flow Rates: same Gilbert form 435·(GLR/1000)^0.546 (v3.0), Ros identical
      app.hook.nav('chokeflow');
      set(app, { cf_op: 1500, cf_ocs: 32, cf_gor: 1000 }); app.win.calcChokeOil();
      const hostG = parseFloat(rows(app, 'cf_ores').find((r) => r.l === 'Gilbert Equation').v.replace(/,/g, ''));
      const hostR = parseFloat(rows(app, 'cf_ores').find((r) => r.l === 'Ros Equation').v.replace(/,/g, ''));
      assert.rel(hostG, s.rates.gilbert, 5e-5, 'Gilbert identical to the host page (display rounding only)');
      assert.rel(hostR, s.rates.ros, 1e-4, 'Ros agrees with the host page');
      // Not critical: p2 1000 psig on 1500 psig
      open(app);
      set(app, Object.assign({}, LIQ, { ck_p2: 1000 })); calc(app);
      assert.strictEqual(S(app).critical, false);
      assert.includes(txt(app, 'ck_res'), '⚠ Not critical');
      set(app, { ck_p2: '' }); calc(app);
      assert.strictEqual(S(app).critical, null);
      assert.includes(txt(app, 'ck_res'), 'Downstream pressure not given');
      assert.includes(txt(app, 'ck_res'), 'Shut-in WHP not given');
      // gas-only fields hidden in liquid mode (not captured by the report)
      assert.strictEqual(app.el('ck_cd_fg').style.display, 'none');
      assert.strictEqual(app.el('ck_glr_fg').style.display, '');
      noBadNumbers(assert, app, 'liquid');
    },
  },
  {
    name: 'CHOKE validation: bad inputs listed and flagged, never NaN; missing k/Z engine message',
    wp: WP,
    run(app, assert) {
      open(app);
      set(app, Object.assign({}, GAS, { ck_size: 1, ck_p2: 1200, ck_cd: 2, ck_k: 0.9 })); calc(app);
      const e = errText(app, 'ck_res');
      assert.includes(e, 'Bean size must be between');
      assert.includes(e, 'Downstream pressure must be below the upstream pressure');
      assert.includes(e, 'Discharge coefficient Cd');
      assert.includes(e, 'Cp/Cv (k)');
      ['ck_size', 'ck_p2', 'ck_cd', 'ck_k'].forEach((id) => assert.ok(app.el(id).classList.contains('input-err'), id + ' flagged'));
      assert.ok(!app.el('ck_p1').classList.contains('input-err'), 'valid input not flagged');
      assert.strictEqual(S(app).q, null);
      set(app, Object.assign({}, GAS, { ck_pws: 900 })); calc(app);
      assert.includes(errText(app, 'ck_res'), 'Shut-in wellhead pressure must be above');
      set(app, Object.assign({}, LIQ, { ck_glr: 0, ck_wc: 100 })); calc(app);
      const e2 = errText(app, 'ck_res');
      assert.includes(e2, 'Gas–liquid ratio'); assert.includes(e2, 'Water cut');
      set(app, { ck_glr: 800, ck_wc: 0 }); calc(app);
      assert.strictEqual(app.findAll('#ck_root .input-err').length, 0, 'flags cleared');
      noBadNumbers(assert, app, 'validation');
      // Engine missing and no overrides → clear message
      const F = app.win.WTS_chokeperf_compute, keep = app.win.WTS_gaspvt_compute;
      app.win.WTS_gaspvt_compute = undefined;
      try {
        const r = F({ fluid: 'gas', s64: 24, p1: 1000, p2: 100, t: 100, sg: 0.7, cd: 0.85 });
        assert.ok(!r.ok && /enter Cp\/Cv/.test(r.errors[0]), 'engine message');
        assert.ok(F({ fluid: 'gas', s64: 24, p1: 1000, p2: 100, t: 100, sg: 0.7, cd: 0.85, k: 1.28, z: 0.9 }).ok, 'overrides work without the engine');
      } finally { app.win.WTS_gaspvt_compute = keep; }
    },
  },
  {
    name: 'CHOKE metric: labels switch, same physical case typed in metric gives the imperial state, unit flip recalculates',
    wp: WP,
    run(app, assert) {
      open(app);
      set(app, Object.assign({}, GAS, { ck_pws: 1800 })); calc(app);
      const imp = JSON.parse(JSON.stringify(S(app)));
      const U = app.win.WTS_units;
      app.flush(10);
      U.setSystem('metric');
      try {
        open(app);
        const lab = (id) => String(app.el(id).closest('.fg-item').querySelector('label').textContent);
        assert.match(lab('ck_p1'), /kPa\(g\)/);
        assert.match(lab('ck_t'), /°C/);
        assert.match(lab('ck_glr'), /sm³\/sm³/);
        ['q', 'k', 'z', 'rc'].forEach((k) => assert.rel(S(app)[k], imp[k], 1e-5, 'restored ' + k));
        assert.includes(rtext(app, 'ck_res', 'Gas rate'), 'm³/d');
        assert.includes(rtext(app, 'ck_res', 'Bean size'), 'mm');
        // metric entry of the same case
        set(app, { ck_p1: 1000 * 6.89476, ck_p2: 200 * 6.89476, ck_t: (100 - 32) / 1.8, ck_pws: 1800 * 6.89476 }); calc(app);
        assert.rel(S(app).q, imp.q, 1e-5, 'metric entry → same rate');
        assert.rel(S(app).beanUp[0].q, imp.beanUp[0].q, 1e-4, 'metric entry → same bean-up');
        // liquid GLR in sm³/sm³: 1000 scf/STB = 178.108 sm³/sm³
        set(app, { ck_fluid: 'liquid', ck_glr: 1000 * 0.0283168466 / 0.158987294928, ck_p1: 1500 * 6.89476, ck_p2: 300 * 6.89476, ck_wc: 20, ck_corr: 'gilbert', ck_pws: '' }); calc(app);
        assert.rel(S(app).rates.gilbert, 2411.77, 1e-4, 'metric GLR');
        assert.includes(rtext(app, 'ck_res', 'Liquid rate (selected)'), 'm³/d');
      } finally { U.setSystem('imperial'); }
      assert.rel(S(app).rates.gilbert, 2411.77, 1e-4, 'recalc after flip');
      assert.includes(rtext(app, 'ck_res', 'Liquid rate (selected)'), 'BPD');
    },
  },
  {
    name: 'CHOKE report + persistence: sections, PDF, autosave restore, no timers',
    wp: WP,
    run(app, assert) {
      open(app);
      set(app, Object.assign({}, GAS, { ck_pws: 1800, ck_size: 28 })); calc(app);
      const q = S(app).q;
      const model = app.win.collectPageReport(app.el('pgBody'), { charts: false });
      const s = JSON.stringify(model);
      const rt = model.results.map((x) => x.title);
      ['Bean', 'Gas Flow Through the Bean', 'Checks', 'Bean-up Planning'].forEach((t) => assert.ok(rt.indexOf(t) !== -1, 'results section ' + t + ': ' + rt.join(' | ')));
      ['Upstream pressure, WHP', 'Shut-in wellhead pressure', 'Critical pressure ratio'].forEach((n) => assert.includes(s, n));
      assert.ok(s.indexOf('Gas–liquid ratio') === -1, 'hidden liquid fields not in the report');
      const n0 = app.opened.length;
      app.win.exportPagePDF();
      const pdf = app.opened[n0] && app.opened[n0].html();
      assert.ok(pdf && pdf.indexOf('Choke Performance') !== -1 && pdf.indexOf('Bean-up Planning') !== -1, 'PDF');
      app.flush(1200);
      const rec = JSON.parse(app.storage.getItem('wts_page_chokeperf') || 'null');
      assert.ok(rec && rec.f && rec.f.ck_size === '28', 'autosaved: ' + JSON.stringify(rec && rec.f));
      app.flushUntilIdle(10000);
      assert.strictEqual(app.pendingTimers(), 0, 'no timers left');
      const app2 = app.reload();
      try {
        const b = app2.find('.nav-btn[data-p="chokeperf"]'); app2.click(b);
        assert.strictEqual(app2.el('ck_size').value, '28', 'restored');
        assert.rel(app2.win.WTS_state.chokeperf.q, q, 1e-9, 'recalculated on restore');
        app2.flushUntilIdle(10000);
        assert.strictEqual(app2.pendingTimers(), 0, 'no timers after reload');
      } finally { app2.dispose(); }
    },
  },
  {
    name: 'CHOKE phone: renders at 375 px with results and a dashboard tile',
    wp: WP,
    opts: { viewport: { width: 375, height: 812 } },
    run(app, assert) {
      open(app);
      assert.ok(app.el('ck_res').querySelector('.rrow'), 'results rendered');
      assert.ok(!/width:\s*[4-9]\d\dpx|width:\s*\d{4,}px/.test(app.el('pgBody').innerHTML), 'no fixed widths above 340 px');
      app.hook.nav('home');
      const titles = app.findAll('.dash-card').map((c) => String(c.querySelector('h3').textContent).trim());
      assert.ok(titles.indexOf('Choke Performance & Critical Flow') !== -1, 'dashboard tile');
    },
  },
];
