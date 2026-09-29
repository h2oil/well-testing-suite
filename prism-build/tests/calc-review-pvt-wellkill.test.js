// Adversarial review (batch 2) of Gas PVT (46-calc-gaspvt.js), the PRiSM DAK
// solver (16-pvt.js), Well Kill & Bullhead (48-calc-wellkill.js) and the shared
// tubular table (40-calc-tubulars.js). One regression test per confirmed defect,
// plus independent checks of the reviewed engines.
//
// Independent references used for the expected values:
//   • API Spec 5CT drift-mandrel table and the published drift diameters
//     (9-5/8" 47# 8.525", 53.5# 8.379", 43.5# 8.599", 40# 8.679", 36# 8.765";
//     13-3/8" 72# 12.191", 68# 12.259"; 8-5/8" 32# 7.796"; 7" 26# 6.151";
//     16" 65# 15.062"; 20" 94# 18.936").
//   • Ahmed, Reservoir Engineering Handbook, Lee–Gonzalez–Eakin worked example:
//     γ 0.72, 2000 psia, 140 °F, Z 0.78 → μg ≈ 0.0173 cp.
//   • DAK roots: the DAK equation of state solved here by a dense sign scan +
//     bisection, and the pre-19ec76a successive-substitution solver re-typed from
//     the published DAK form (to show it is unchanged where it converged).
//   • Sutton (1985) Tpc for γ 1.2 = 169.2 + 419.4 − 106.56 = 482.04 °R (22.37 °F).
'use strict';

const WP = 'REVIEW2';

function rows(app, resId) {
  return app.findAll('#' + resId + ' .rrow').map((r) => {
    const l = r.querySelector('.rl'), v = r.querySelector('.rv');
    return { l: String(l ? l.textContent : '').trim(), v: String(v ? v.textContent : '').trim() };
  });
}
function rtext(app, resId, label) { const r = rows(app, resId).find((x) => x.l === label); return r ? r.v : null; }
function txt(app, id) { const e = app.el(id); return String(e ? e.textContent : '').trim(); }
function errText(app, resId) { return app.findAll('#' + resId + ' .val-error').map((e) => e.textContent).join(' | '); }
function open(app, key) {
  const b = app.find('.nav-btn[data-p="' + key + '"]');
  if (!b) throw new Error('no ' + key + ' nav button');
  app.click(b);
}
const report = (app) => app.win.collectPageReport(app.el('pgBody'), { charts: false });
function tables(model) {
  const out = [];
  model.inputs.concat(model.results).forEach((s) => s.items.forEach((it) => { if (it.type === 'table') out.push(Object.assign({ section: s.title }, it)); }));
  return out;
}

// DAK EOS, published constants (Dranchuk & Abou-Kassem 1975).
const A = [0, 0.3265, -1.07, -0.5339, 0.01569, -0.05165, 0.5475, -0.7361, 0.1844, 0.1056, 0.6134, 0.721];
function zeos(T, r) {
  const c1 = A[1] + A[2] / T + A[3] / T ** 3 + A[4] / T ** 4 + A[5] / T ** 5;
  const c2 = A[6] + A[7] / T + A[8] / T ** 2, c3 = A[9] * (A[7] / T + A[8] / T ** 2);
  return 1 + c1 * r + c2 * r * r - c3 * r ** 5 + A[10] * (1 + A[11] * r * r) * (r * r / T ** 3) * Math.exp(-A[11] * r * r);
}
function dakRoots(T, P) {
  const k = 0.27 * P / T, g = (r) => zeos(T, r) - k / r, out = [];
  let a = 1e-6, ga = g(a);
  for (let i = 1; i <= 6000; i++) {
    const b = i * 5e-4, gb = g(b);
    if (ga * gb < 0) {
      let lo = a, hi = b;
      for (let j = 0; j < 80; j++) { const m = (lo + hi) / 2; if (g(lo) * g(m) <= 0) hi = m; else lo = m; }
      out.push(k / ((lo + hi) / 2));
    }
    a = b; ga = gb;
  }
  return out;
}
function dakOld(T, P) {
  let Z = 1;
  for (let i = 0; i < 50; i++) {
    let Zn = zeos(T, 0.27 * P / (Z * T));
    if (!isFinite(Zn) || Zn <= 0) Zn = 1;
    if (Math.abs(Zn - Z) < 1e-8) return { Z: Zn, conv: true };
    Z = Zn;
  }
  return { Z, conv: false };
}

module.exports = [
  {
    name: 'REVIEW2 tubulars: API 5CT casing drift uses d − 5/32" for 9-5/8" (was d − 1/8"), matching published drifts',
    wp: WP,
    run(app, assert) {
      const T = app.win.WTS_tubulars;
      const pub = [
        ['casing-9.625-47', 8.525], ['casing-9.625-53.5', 8.379], ['casing-9.625-43.5', 8.599],
        ['casing-9.625-40', 8.679], ['casing-9.625-36', 8.765], ['casing-13.375-72', 12.191],
        ['casing-13.375-68', 12.259], ['casing-8.625-32', 7.796], ['casing-7-26', 6.151],
        ['casing-16-65', 15.062], ['casing-20-94', 18.936], ['liner-9.625-47', 8.525],
        ['tubing-2.875-6.5', 2.347], ['tubing-3.5-9.3', 2.867],
      ];
      pub.forEach(([k, d]) => {
        const e = T.find(k);
        assert.ok(e, k);
        assert.ok(Math.abs(e.drift - d) <= 1.01e-3, k + ' drift ' + e.drift + ' vs API 5CT ' + d);
      });
    },
  },
  {
    name: 'REVIEW2 DAK solver: unique EOS root on a Tpr 1.05–3 × Ppr 0.5–30 grid, identical to the old solver where it converged',
    wp: WP,
    run(app, assert) {
      const L = app.win.PRiSM_pvt_correlations;
      let nOld = 0;
      for (let T = 1.05; T <= 3.001; T += 0.15) {
        for (let P = 0.5; P <= 30.001; P += 1.5) {
          const z = L.Z_dranchukAbouKassem(T, P), R = dakRoots(T, P);
          assert.strictEqual(R.length, 1, 'one root at ' + T.toFixed(2) + '/' + P);
          assert.ok(Math.abs(z - R[0]) < 1e-7, 'DAK root at ' + T.toFixed(2) + '/' + P + ': ' + z + ' vs ' + R[0]);
          const o = dakOld(T, P);
          if (o.conv) { nOld++; assert.ok(Math.abs(o.Z - z) < 1e-7, 'unchanged where the old solver converged at ' + T.toFixed(2) + '/' + P); }
        }
      }
      assert.ok(nOld > 30, 'old solver converged on part of the grid: ' + nOld);
      // Where the old one diverged (Tpr 1.5, Ppr 8 → 1.603), the new one gives the chart value 0.99.
      assert.ok(!dakOld(1.5, 8).conv, 'old diverged at 1.5/8');
      assert.ok(Math.abs(L.Z_dranchukAbouKassem(1.5, 8) - 0.99) < 0.005, 'new 1.5/8 ≈ 0.99');
      // Lee–Gonzalez–Eakin, Ahmed worked example
      assert.ok(Math.abs(L.mu_g_leeGonzalezEakin(0.72, 140, 0.78, 2000) - 0.0173) < 0.0001, 'LGE 0.0173 cp');
    },
  },
  {
    name: 'REVIEW2 gaspvt: separator below the pseudo-critical temperature is refused (was a liquid-like Z 0.25 with no warning); near-critical separator warns',
    wp: WP,
    run(app, assert) {
      const F = app.win.WTS_gaspvt_compute;
      // γ 1.2: Tpc = 482.04 °R = 22.37 °F. Separator at −40 °F → Tpr 0.871.
      const r = F({ sg: 1.2, p: 3000, t: 200, psep: 1000, tsep: -40 });
      assert.strictEqual(r.ok, false, 'refused');
      assert.deepStrictEqual(Array.from(r.bad), ['tsep']);
      assert.match(r.errors[0], /Separator temperature is below the pseudo-critical temperature \(22\.4 °F\)/);
      // Separator at 30 °F → Tpr = 489.67 / 482.04 = 1.0158: computed, with a range warning.
      const w = F({ sg: 1.2, p: 3000, t: 200, psep: 500, tsep: 30 });
      assert.ok(w.ok && w.sep, 'near-critical separator computed');
      assert.rel(w.sep.Tpr, 489.67 / 482.04, 1e-4, 'sep Tpr');
      assert.ok(w.warnings.some((s) => /Separator Tpr = 1\.016 is below 1\.05/.test(s)), 'warning: ' + w.warnings.join(' | '));
      // Normal separator: no extra warning
      const n = F({ sg: 0.7, p: 3000, t: 200, psep: 1000, tsep: 100 });
      assert.ok(n.ok && !n.warnings.some((s) => /Separator/.test(s)), 'no separator warning at Tpr 1.48');
      // Through the page: message, flagged field, state not ok
      open(app, 'gaspvt');
      app.input('gp_sg', '1.2'); app.input('gp_psep', '1000'); app.input('gp_tsep', '-40');
      app.click('gp_calc');
      assert.includes(errText(app, 'gp_res'), 'Separator temperature is below the pseudo-critical temperature');
      assert.ok(app.el('gp_tsep').classList.contains('input-err'), 'tsep flagged');
      assert.strictEqual(app.win.WTS_state.gaspvt.ok, false);
      app.input('gp_tsep', '30'); app.click('gp_calc');
      assert.includes(txt(app, 'gp_res'), '⚠ Separator Tpr = 1.016');
      assert.ok(!/✓ Inputs are inside the fitted range/.test(txt(app, 'gp_res')), 'no all-clear with a warning');
    },
  },
  {
    name: 'REVIEW2 wellkill metric: "Overbalance as density" in kg/L (was ppg in metric); report captures all result tables',
    wp: WP,
    run(app, assert) {
      open(app, 'wellkill');
      assert.strictEqual(rtext(app, 'wk_res', 'Overbalance as density'), '0.38 ppg', 'imperial unchanged');
      // Report: the four result tables with their headers and rows (table.rows capture)
      const t = tables(report(app));
      const bySec = {};
      t.forEach((x) => { bySec[x.section] = x; });
      assert.ok(bySec['Bullhead Volume'] && bySec['Bullhead Volume'].rows.length === 4, 'section table: ' + t.map((x) => x.section).join(' | '));
      assert.strictEqual(bySec['Bullhead Volume'].head[0], 'Section');
      assert.ok(bySec['Surface Pressure Limits'] && bySec['Surface Pressure Limits'].rows.length === 11, 'schedule table');
      assert.ok(bySec['Brine Selection Guide'] && bySec['Brine Selection Guide'].rows.length === 12, 'brine table');
      assert.ok(bySec['Column Pressures'] && bySec['Column Pressures'].rows.length === 3, 'gradient table');
      open(app, 'gaspvt');
      const g = tables(report(app));
      assert.ok(g.length === 1 && g[0].rows.length === 11 && /Z vs Pressure/.test(g[0].section), 'gaspvt Z table captured');
      const U = app.win.WTS_units;
      app.flush(10);
      U.setSystem('metric');
      try {
        open(app, 'wellkill');
        // 200 psi / (0.052 × 10,000 ft) = 0.3846 ppg × 0.119826 = 0.0461 kg/L
        const v = rtext(app, 'wk_res', 'Overbalance as density');
        assert.ok(/kg\/L/.test(v) && !/ppg/.test(v), 'metric label: ' + v);
        assert.rel(parseFloat(v), 200 / 520 * 0.119826, 2e-2, 'metric value');
      } finally { U.setSystem('imperial'); }
    },
  },
];
