// Calculator #7 — Gas PVT (route `gaspvt`, file prism-build/46-calc-gaspvt.js,
// Round-9 plug-in registry) + the "Use calculated Z" buttons on the host
// `gascalc` page.
//
// Expected values are independent hand calculations written out below:
//   • Sutton (1985): Tpc = 169.2 + 349.5γ − 74.0γ², Ppc = 756.8 − 131.0γ − 3.6γ²;
//   • Wichert–Aziz (1972): ε = 120(A^0.9 − A^1.6) + 15(B^0.5 − B^4); the
//     textbook case (5 % CO2, 10 % H2S) gives ε = 20.735 °R;
//   • Standing–Katz chart readings (±0.01) for DAK and Hall–Yarborough;
//   • Bg = 14.696·Z·T/(519.67·p), ρ = p·M/(Z·10.7316·T), Lee–Gonzalez–Eakin,
//     c = √(k·Z·g_c·R·T/M) with R = 1545.35, g_c = 32.174.
'use strict';

const WP = 'GASPVT';

function rows(app, resId) {
  return app.findAll('#' + resId + ' .rrow').map((r) => {
    const l = r.querySelector('.rl'), v = r.querySelector('.rv');
    return { l: String(l ? l.textContent : '').trim(), v: String(v ? v.textContent : '').trim() };
  });
}
function rv(app, resId, label, nth) {
  const r = rows(app, resId).find((x) => x.l === label);
  if (!r) throw new Error('no result row "' + label + '" in #' + resId + ': ' + JSON.stringify(rows(app, resId)));
  const nums = r.v.replace(/,/g, '').match(/-?\d+(\.\d+)?(e[-+]?\d+)?/gi);
  if (!nums || nums[nth || 0] == null) throw new Error('row "' + label + '" has no number #' + (nth || 0) + ': ' + r.v);
  return parseFloat(nums[nth || 0]);
}
function rowText(app, resId, label) {
  const r = rows(app, resId).find((x) => x.l === label);
  return r ? r.v : '';
}
function txt(app, id) { const e = app.el(id); return String(e ? e.textContent : '').trim(); }
function errText(app, resId) { return app.findAll('#' + resId + ' .val-error').map((e) => e.textContent).join(' | '); }
function noBadNumbers(assert, app, where) {
  const t = String(app.el('pgBody').textContent || '');
  assert.ok(!/NaN|Infinity|∞|undefined/.test(t), where + ': page shows NaN/Infinity/undefined');
}
function set(app, vals) {
  for (const k of Object.keys(vals)) {
    if (!app.el(k)) throw new Error('no input #' + k);
    app.input(k, String(vals[k]));
  }
}
function open(app, key) {
  const b = app.find('.nav-btn[data-p="' + (key || 'gaspvt') + '"]');
  if (!b) throw new Error('no ' + (key || 'gaspvt') + ' nav button');
  app.click(b);
}
const calc = (app) => app.click('gp_calc');
const S = (app) => app.win.WTS_state.gaspvt;

// ── Independent hand formulas (not the page's code) ─────────────────
const sutton = (g) => ({ Tpc: 169.2 + 349.5 * g - 74.0 * g * g, Ppc: 756.8 - 131.0 * g - 3.6 * g * g });
function waHand(sg, co2, h2s, n2) {
  const y = { c: co2 / 100, h: h2s / 100, n: n2 / 100 };
  const yh = 1 - y.c - y.h - y.n;
  const ghc = (sg - (y.n * 28.0134 + y.c * 44.010 + y.h * 34.082) / 28.9647) / yh;
  const s = sutton(ghc);
  const Tm = yh * s.Tpc + y.n * 227.16 + y.c * 547.58 + y.h * 672.12;
  const Pm = yh * s.Ppc + y.n * 493.1 + y.c * 1071.0 + y.h * 1300.0;
  const A = y.c + y.h, B = y.h;
  const eps = 120 * (Math.pow(A, 0.9) - Math.pow(A, 1.6)) + 15 * (Math.pow(B, 0.5) - Math.pow(B, 4));
  const Tpc = Tm - eps;
  return { ghc, Tm, Pm, eps, Tpc, Ppc: Pm * Tpc / (Tm + B * (1 - B) * eps) };
}
function lgeHand(sg, tF, Z, p) {
  const M = 28.9647 * sg, T = tF + 459.67;
  const K = (9.4 + 0.02 * M) * Math.pow(T, 1.5) / (209 + 19 * M + T);
  const X = 3.5 + 986 / T + 0.01 * M, Y = 2.4 - 0.2 * X;
  const rho = 1.4935e-3 * p * M / (Z * T);
  return 1e-4 * K * Math.exp(X * Math.pow(rho, Y));
}

// Standing–Katz chart readings [Tpr, Ppr, Z].
const SK = [
  [1.2, 1.0, 0.78], [1.5, 2.0, 0.82], [1.3, 3.0, 0.62], [2.0, 3.0, 0.94], [1.7, 4.0, 0.865],
  [1.2, 6.0, 0.79], [1.5, 8.0, 0.99], [2.0, 8.0, 1.06], [3.0, 10.0, 1.17],
];

module.exports = [
  {
    name: 'GASPVT Z: DAK and Hall–Yarborough reproduce Standing–Katz chart points; PRiSM DAK no longer diverges',
    wp: WP,
    run(app, assert) {
      const L = app.win.PRiSM_pvt_correlations;
      SK.forEach(([t, p, z]) => {
        const d = L.Z_dranchukAbouKassem(t, p), h = L.Z_hallYarborough(t, p);
        assert.ok(Math.abs(d - z) <= 0.02, 'DAK Tpr ' + t + ' Ppr ' + p + ': ' + d + ' vs chart ' + z);
        assert.ok(Math.abs(h - z) <= 0.02, 'HY Tpr ' + t + ' Ppr ' + p + ': ' + h + ' vs chart ' + z);
      });
      // DAK root satisfies its own equation of state (ρr = 0.27·Ppr/(Z·Tpr)).
      [[1.05, 4], [1.1, 5], [1.5, 8], [1.3, 8], [1.2, 15]].forEach(([t, p]) => {
        const Z = L.Z_dranchukAbouKassem(t, p);
        const HY = L.Z_hallYarborough(t, p);
        assert.ok(Z > 0.3 && Z < 2, 'DAK finite at Tpr ' + t + ' Ppr ' + p + ': ' + Z);
        assert.ok(Math.abs(Z - HY) / HY < 0.02, 'DAK ≈ HY within 2 % at Tpr ' + t + ' Ppr ' + p + ': ' + Z + ' / ' + HY);
      });
      // The two correlations agree within 2 % over the working range (the largest
      // gap, ≈ 1.6 %, is near Tpr 1.2 / Ppr 2 where the chart is steepest).
      for (const t of [1.2, 1.4, 1.7, 2.0, 2.5, 3.0]) {
        for (const p of [0.5, 1, 2, 4, 6, 8, 10]) {
          const d = L.Z_dranchukAbouKassem(t, p), h = L.Z_hallYarborough(t, p);
          assert.ok(Math.abs(d - h) / d < 0.02, 'agree at ' + t + '/' + p + ': ' + d + ' vs ' + h);
        }
      }
      assert.strictEqual(L.Z_dranchukAbouKassem(1.5, 0), 1, 'Ppr 0 → 1');
      assert.rel(L.Z_dranchukAbouKassem(1.5, 0.01), 1, 2e-3, 'near-ideal');
    },
  },
  {
    name: 'GASPVT compute: pseudo-criticals (Sutton + Kay + Wichert–Aziz), properties and speed of sound match hand calculations',
    wp: WP,
    run(app, assert) {
      const W = app.win, F = W.WTS_gaspvt_compute;
      ['renderGasPVT', 'calcGasPVT', 'WTS_gaspvt_compute', 'WTS_gaspvt_pseudoCriticals', 'WTS_gaspvt_k']
        .forEach((f) => assert.strictEqual(typeof W[f], 'function', f));
      // Sweet 0.7 gas at 3000 psia, 200 °F
      const a = F({ sg: 0.7, p: 3000, t: 200, co2: 0, h2s: 0, n2: 0 });
      assert.ok(a.ok, 'sweet ok');
      assert.rel(a.Tpc, 377.59, 1e-9, 'Tpc = 169.2 + 244.65 − 36.26');
      assert.rel(a.Ppc, 663.336, 1e-9, 'Ppc = 756.8 − 91.7 − 1.764');
      assert.strictEqual(a.eps, 0, 'no sour correction');
      assert.rel(a.Tpr, 659.67 / 377.59, 1e-12, 'Tpr');
      assert.rel(a.Ppr, 3000 / 663.336, 1e-12, 'Ppr');
      assert.ok(Math.abs(a.zDAK - 0.888) < 0.002 && Math.abs(a.zHY - 0.886) < 0.002, 'Z ≈ 0.888 / 0.886: ' + a.zDAK + ' ' + a.zHY);
      assert.rel(a.zDiff, a.zHY - a.zDAK, 1e-12, 'difference');
      const Z = a.zDAK, T = 659.67, M = 0.7 * 28.9647;
      assert.rel(a.Bg_ft3scf, 14.696 * Z * T / (519.67 * 3000), 1e-9, 'Bg ft3/scf');
      assert.rel(a.Bg_rbMscf, a.Bg_ft3scf * 1000 / 5.614583, 1e-9, 'Bg rb/Mscf');
      assert.rel(a.Bg_rbMscf, 0.9835, 1e-3, 'Bg ≈ 0.98 rb/Mscf');
      assert.rel(a.rho, 3000 * M / (Z * 10.7316 * T), 1e-9, 'density');
      assert.rel(a.rho, 9.676, 1e-3, 'density ≈ 9.68 lb/ft3');
      assert.rel(a.mu, lgeHand(0.7, 200, Z, 3000), 1e-9, 'LGE viscosity');
      assert.rel(a.mu, 0.0200, 1e-2, 'μg ≈ 0.020 cp');
      // cg equals PRiSM's own real-gas cg for a sweet gas (same Sutton + DAK)
      assert.rel(a.cg, W.PRiSM_pvt_correlations.cg_realGas(3000, 200, Z, 0.7), 5e-3, 'cg vs PRiSM cg_realGas');
      assert.rel(a.cpr, a.cg * a.Ppc, 1e-9, 'cpr = cg·Ppc');
      // v3.0: c uses the real-gas k and (∂p/∂ρ)_T (calc-v3-followups.test.js checks it against NIST);
      // the pre-v3.0 ideal-k value is kept as cIdealK.
      assert.rel(a.cIdealK, Math.sqrt(a.k * Z * 32.174 * 1545.35 * T / M), 1e-12, 'pre-v3.0 speed of sound formula');
      assert.ok(a.c > a.cIdealK && a.kReal > a.k, 'real-gas c and k above the ideal-k values at 3,000 psia');
      // Near-ideal gas: cg → 1/p, Z → 1
      const lo = F({ sg: 0.65, p: 15, t: 100 });
      assert.rel(lo.cg, 1 / 15, 5e-3, 'cg ≈ 1/p at 15 psia');
      assert.ok(Math.abs(lo.zDAK - 1) < 0.005, 'Z ≈ 1 at 15 psia');
      // k and speed of sound: methane at 60 °F and 1 atm (reference c ≈ 1,463 ft/s, k ≈ 1.31)
      const m = F({ sg: 16.043 / 28.9647, p: 14.696, t: 60 });
      assert.rel(m.k, 1.307, 1e-2, 'methane k');
      assert.rel(m.c, 1463, 1.5e-2, 'methane speed of sound');
      // 0.65 gravity gas at 60 °F: k ≈ 1.27–1.28 (gravity chart for natural gas)
      assert.ok(Math.abs(W.WTS_gaspvt_k(0.65, 60) - 1.275) < 0.01, 'k(0.65, 60 °F) = ' + W.WTS_gaspvt_k(0.65, 60));
      assert.ok(W.WTS_gaspvt_k(0.65, 300) < W.WTS_gaspvt_k(0.65, 60), 'k falls with temperature');
      assert.ok(W.WTS_gaspvt_k(1.0, 60) < W.WTS_gaspvt_k(0.65, 60), 'k falls with gravity');

      // Sour gas: γ 0.7, CO2 5 %, H2S 10 %, N2 2 %
      const s = F({ sg: 0.7, p: 2000, t: 150, co2: 5, h2s: 10, n2: 2 });
      const h = waHand(0.7, 5, 10, 2);
      assert.ok(s.ok && s.sour, 'sour ok');
      assert.rel(s.eps, 20.735, 1e-4, 'ε textbook value (A = 0.15, B = 0.10)');
      assert.rel(s.eps, h.eps, 1e-12, 'ε hand');
      assert.rel(s.sgHc, h.ghc, 1e-12, 'hydrocarbon gravity');
      assert.rel(s.sgHc, 0.58677, 1e-4, 'γhc = (0.7 − 0.21298)/0.83');
      assert.rel(s.TpcM, h.Tm, 1e-12, 'Kay Tpc'); assert.rel(s.PpcM, h.Pm, 1e-12, 'Kay Ppc');
      assert.rel(s.Tpc, h.Tpc, 1e-12, "Tpc'"); assert.rel(s.Ppc, h.Ppc, 1e-12, "Ppc'");
      assert.rel(s.Tpc, 367.90, 1e-4, "Tpc' ≈ 367.90 °R"); assert.rel(s.Ppc, 712.93, 1e-4, "Ppc' ≈ 712.93 psia");
      // Wichert–Aziz with no N2 and CO2 only: B = 0 → Ppc' = Ppc·Tpc'/Tpc
      const c2 = F({ sg: 0.8, p: 1500, t: 120, co2: 20 }), h2 = waHand(0.8, 20, 0, 0);
      assert.rel(c2.Ppc, h2.Pm * (h2.Tm - h2.eps) / h2.Tm, 1e-12, 'CO2-only Ppc');
      // Separator conditions
      const sp = F({ sg: 0.7, p: 3000, t: 200, psep: 1000, tsep: 100 });
      assert.ok(sp.sep && sp.sep.p === 1000, 'separator state');
      assert.rel(sp.sep.Tpr, 559.67 / 377.59, 1e-12, 'sep Tpr');
      // v3.0 AGA-3 Fpv = √(Zb/Zf); Zb by an independent DAK bisection at 519.67 °R / 14.696 psia on the same Tpc'/Ppc'
      const dakB = (Tpr, Ppr) => {
        const A = [0, 0.3265, -1.07, -0.5339, 0.01569, -0.05165, 0.5475, -0.7361, 0.1844, 0.1056, 0.6134, 0.7210];
        const Zof = (r) => 1 + (A[1] + A[2] / Tpr + A[3] / Tpr ** 3 + A[4] / Tpr ** 4 + A[5] / Tpr ** 5) * r
          + (A[6] + A[7] / Tpr + A[8] / Tpr ** 2) * r * r - A[9] * (A[7] / Tpr + A[8] / Tpr ** 2) * r ** 5
          + A[10] * (1 + A[11] * r * r) * (r * r / Tpr ** 3) * Math.exp(-A[11] * r * r);
        let lo = 1e-9, hi = 3;
        for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; if (Zof(m) - 0.27 * Ppr / (m * Tpr) > 0) hi = m; else lo = m; }
        return 0.27 * Ppr / (((lo + hi) / 2) * Tpr);
      };
      const zbHand = dakB(519.67 / sp.Tpc, 14.696 / sp.Ppc);   // ≈ 0.9971
      assert.near(sp.sep.Zb, zbHand, 1e-6, 'Zb');
      assert.rel(sp.sep.Fpv, Math.sqrt(zbHand / sp.sep.zDAK), 1e-6, 'Fpv = √(Zb/Zf)');
      assert.rel(sp.sep.Bg_ft3scf, 14.696 * sp.sep.zDAK * 559.67 / (519.67 * 1000), 1e-9, 'sep Bg');
      assert.strictEqual(a.sep, null, 'no separator when blank');
      // Z vs pressure table: 11 rows to 5,000 psia, matches the point value at 3,000 psia
      assert.strictEqual(a.pMax, 5000); assert.strictEqual(a.table.length, 11); assert.strictEqual(a.curve.length, 41);
      const row3000 = a.table.find((r) => r.p === 3000);
      assert.rel(row3000.zDAK, a.zDAK, 1e-12, 'table row = point');
      // Validation: errors, never NaN
      const bad = [F({ sg: 0.5, p: 1000, t: 100 }), F({ sg: 0.7, p: 0, t: 100 }), F({ sg: 0.7, p: 1000, t: 900 }),
        F({ sg: 0.7, p: 1000, t: 100, co2: -1 }), F({ sg: 0.7, p: 1000, t: 100, co2: 50, h2s: 30, n2: 20 }),
        F({ sg: 0.7, p: 1000, t: 100, psep: 500 }), F({ sg: 0.6, p: 100, t: 60, co2: 50 }), F({ sg: 1.5, p: 100, t: 0 })];
      bad.forEach((r, i) => { assert.strictEqual(r.ok, false, 'bad ' + i); assert.ok(r.errors.length > 0, 'bad ' + i + ' has errors'); });
      assert.deepStrictEqual(Array.from(bad[5].bad), ['tsep'], 'one separator field alone is flagged');
      assert.match(bad[6].errors[0], /lighter than methane/);
      assert.match(bad[7].errors[0], /pseudo-critical temperature/);
      assert.ok(F({ sg: 0.7, p: 1000, t: 100, co2: '', h2s: null }).ok, 'blank impurities = 0');
    },
  },
  {
    name: 'GASPVT page: registry nav in Fluid & Field Calcs, defaults compute, rows, table, chart, separator card, checks',
    wp: WP,
    run(app, assert) {
      const R = app.win.WTS_calcRegistry.gaspvt;
      assert.ok(R && R.key === 'gaspvt' && typeof R.render === 'function' && R.title === 'Gas PVT', 'registry entry');
      const b = app.find('.nav-btn[data-p="gaspvt"]');
      assert.ok(b, 'sidebar button');
      assert.strictEqual(String(b.closest('.nav-group').querySelector('.nav-group-label').textContent).trim(), 'Fluid & Field Calcs');
      open(app);
      assert.strictEqual(txt(app, 'pgTitle'), 'Gas PVT');
      assert.match(txt(app, 'pgSub'), /Hall–Yarborough/);
      const ref = app.win.WTS_gaspvt_compute({ sg: 0.7, p: 3000, t: 200 });
      assert.rel(S(app).z, ref.zDAK, 1e-12, 'state z');
      assert.rel(rv(app, 'gp_res', 'Z, Dranchuk–Abou-Kassem'), ref.zDAK, 1e-4);
      assert.rel(rv(app, 'gp_res', 'Z, Hall–Yarborough'), ref.zHY, 1e-4);
      assert.rel(rv(app, 'gp_res', 'Difference (HY − DAK)', 1), ref.zDiffPct, 2e-2);
      assert.rel(rv(app, 'gp_res', 'Tpc, corrected'), 377.6, 1e-4);
      assert.rel(rv(app, 'gp_res', 'Ppc, corrected'), 663.3, 1e-4);
      assert.rel(rv(app, 'gp_res', 'Bg'), ref.Bg_ft3scf, 1e-3);
      assert.includes(rowText(app, 'gp_res', 'Bg'), 'ft³/scf');
      assert.rel(rv(app, 'gp_res', 'Bg (reservoir barrels)'), ref.Bg_rbMscf, 1e-3);
      assert.rel(rv(app, 'gp_res', 'Gas density'), ref.rho, 1e-3);
      assert.rel(rv(app, 'gp_res', 'Viscosity (Lee–Gonzalez–Eakin)'), ref.mu, 1e-3);
      assert.rel(rv(app, 'gp_res', 'Gas compressibility cg'), ref.cg, 1e-3);
      assert.rel(rv(app, 'gp_res', 'Speed of sound'), ref.c, 1e-3);
      assert.includes(txt(app, 'gp_res'), '✓ DAK and Hall–Yarborough agree within 1 %.');
      assert.strictEqual(app.findAll('#gp_res table.dtable tbody tr').length, 11, 'Z table rows');
      assert.ok(app.canvasLog('gp_chart').length > 20, 'chart drawn');
      assert.ok(!app.findAll('#gp_res .rbox-title').some((t) => /Separator/.test(t.textContent)), 'no separator card by default');
      // Separator + sour gas
      set(app, { gp_psep: 1000, gp_tsep: 100, gp_co2: 5, gp_h2s: 10, gp_n2: 2 }); calc(app);
      assert.ok(app.findAll('#gp_res .rbox-title').some((t) => t.textContent === 'At Separator Conditions'), 'separator card');
      const sr = app.win.WTS_gaspvt_compute({ sg: 0.7, p: 3000, t: 200, co2: 5, h2s: 10, n2: 2, psep: 1000, tsep: 100 });
      assert.rel(S(app).sep.zDAK, sr.sep.zDAK, 1e-12, 'sep state');
      assert.rel(rv(app, 'gp_res', 'Supercompressibility Fpv = √(Zb/Z)'), sr.sep.Fpv, 1e-4);
      assert.rel(rv(app, 'gp_res', 'Wichert–Aziz ε'), 20.74, 1e-3);
      assert.includes(txt(app, 'gp_res'), '⚠ Sour gas: Wichert–Aziz correction applied');
      // Out-of-range warning (Ppr > 15)
      set(app, { gp_p: 12000 }); calc(app);
      assert.includes(txt(app, 'gp_res'), 'is above 15; Z is extrapolated');
      noBadNumbers(assert, app, 'page');
    },
  },
  {
    name: 'GASPVT validation: messages, flagged inputs, never NaN; cleared on a good run',
    wp: WP,
    run(app, assert) {
      open(app);
      set(app, { gp_sg: 0.3, gp_p: -5 }); calc(app);
      const e = errText(app, 'gp_res');
      assert.includes(e, 'Gas gravity must be between 0.55 and 3.0');
      assert.includes(e, 'Pressure must be above 0 and no more than 30,000 psia');
      assert.ok(app.el('gp_sg').classList.contains('input-err') && app.el('gp_p').classList.contains('input-err'), 'flagged');
      assert.ok(!app.el('gp_t').classList.contains('input-err'), 'valid input not flagged');
      assert.strictEqual(S(app).ok, false); assert.strictEqual(S(app).z, null);
      set(app, { gp_sg: 0.7, gp_p: 3000, gp_psep: 500 }); calc(app);
      assert.includes(errText(app, 'gp_res'), 'Separator temperature must be between');
      set(app, { gp_psep: '', gp_co2: 60, gp_h2s: 30, gp_n2: 10 }); calc(app);
      assert.includes(errText(app, 'gp_res'), 'must be below 95 mol %');
      set(app, { gp_co2: '', gp_h2s: '', gp_n2: '' }); calc(app);
      assert.strictEqual(app.findAll('#gp_root .input-err').length, 0, 'flags cleared');
      assert.strictEqual(app.findAll('#gp_root .val-error').length, 0, 'errors cleared');
      assert.ok(S(app).ok, 'blank impurities compute as 0 %');
      noBadNumbers(assert, app, 'validation');
    },
  },
  {
    name: 'GASPVT metric: tagged labels switch, state equals the imperial run, results in SI, unit flip recalculates',
    wp: WP,
    run(app, assert) {
      open(app);
      set(app, { gp_psep: 1000, gp_tsep: 100 }); calc(app);
      const imp = JSON.parse(JSON.stringify(S(app)));
      const impM = rv(app, 'gp_res', 'Apparent molecular weight');
      assert.includes(rowText(app, 'gp_res', 'Apparent molecular weight'), 'lb/lb-mol');
      const U = app.win.WTS_units;
      app.flush(10);
      U.setSystem('metric');
      try {
        open(app);
        assert.match(String(app.el('gp_p').closest('.fg-item').querySelector('label').textContent), /\(kPa\)/, 'pressure label');
        assert.match(String(app.el('gp_t').closest('.fg-item').querySelector('label').textContent), /\(°C\)/, 'temperature label');
        ['z', 'zHY', 'Tpc', 'Ppc', 'Bg_ft3scf', 'rho', 'mu', 'cg', 'c', 'k'].forEach((k) => assert.rel(S(app)[k], imp[k], 1e-6, 'metric ' + k));
        assert.rel(S(app).sep.zDAK, imp.sep.zDAK, 1e-6, 'metric separator Z');
        assert.rel(rv(app, 'gp_res', 'Gas density'), imp.rho * 16.0185, 1e-3, 'kg/m³');
        assert.includes(rowText(app, 'gp_res', 'Gas density'), 'kg/m³');
        assert.rel(rv(app, 'gp_res', 'Speed of sound'), imp.c * 0.3048, 1e-3, 'm/s');
        assert.rel(rv(app, 'gp_res', 'Ppc, corrected'), imp.Ppc * 6.89476, 1e-3, 'kPa');
        assert.rel(rv(app, 'gp_res', 'Tpc, corrected'), imp.Tpc * 5 / 9, 1e-3, 'K');
        assert.rel(rv(app, 'gp_res', 'Gas compressibility cg'), imp.cg / 6.89476, 1e-3, '1/kPa');
        assert.includes(rowText(app, 'gp_res', 'Bg'), 'rm³/sm³');
        // v3.0: molar mass in kg/kmol in metric (numerically equal to lb/lb-mol)
        assert.includes(rowText(app, 'gp_res', 'Apparent molecular weight'), 'kg/kmol');
        assert.ok(!/lb/.test(rowText(app, 'gp_res', 'Apparent molecular weight')), 'no lb/lb-mol in metric');
        assert.rel(rv(app, 'gp_res', 'Apparent molecular weight'), impM, 1e-9, 'same number');
        // metric entry: 20,684.28 kPa = 3000 psia, 93.333 °C = 200 °F
        app.input('gp_p', '20684.28'); app.input('gp_t', '93.3333333'); calc(app);
        assert.rel(S(app).z, imp.z, 1e-6, 'metric entry converted');
        app.input('gp_p', '0'); calc(app);
        assert.includes(errText(app, 'gp_res'), 'kPa', 'limit shown in display units');
        app.input('gp_p', '20684.28'); calc(app);
      } finally { U.setSystem('imperial'); }
      assert.rel(S(app).z, imp.z, 1e-6, 'recalc after flip keeps the physical value');
      assert.match(String(app.el('gp_p').closest('.fg-item').querySelector('label').textContent), /\(psia?\)/);
    },
  },
  {
    name: 'GASPVT report + persistence: page report sections, PDF, autosave restore after reload, no timers',
    wp: WP,
    run(app, assert) {
      open(app);
      set(app, { gp_p: 2500, gp_h2s: 4, gp_psep: 800, gp_tsep: 90 }); calc(app);
      const model = app.win.collectPageReport(app.el('pgBody'), { charts: false });
      const rt = model.results.map((x) => x.title);
      ['Pseudo-critical Properties', 'Z-factor', 'Gas Properties', 'Checks'].forEach((t) => assert.ok(rt.indexOf(t) !== -1, 'results section ' + t + ': ' + rt.join(' | ')));
      assert.ok(model.inputs.length >= 2, 'input sections: ' + model.inputs.map((x) => x.title).join(' | '));
      assert.includes(JSON.stringify(model), 'Gas gravity (air = 1)');
      const n0 = app.opened.length;
      app.win.exportPagePDF();
      const pdf = app.opened[n0] && app.opened[n0].html();
      assert.ok(pdf && pdf.indexOf('Gas PVT') !== -1 && pdf.indexOf('Hall–Yarborough') !== -1, 'PDF has title and Z rows');
      app.flush(1200);
      const rec = JSON.parse(app.storage.getItem('wts_page_gaspvt') || 'null');
      assert.ok(rec && rec.f && rec.f.gp_p === '2500' && rec.f.gp_h2s === '4', 'autosaved: ' + JSON.stringify(rec));
      app.flushUntilIdle(10000);
      assert.strictEqual(app.pendingTimers(), 0, 'no timers left');
      const z = S(app).z;
      const app2 = app.reload();
      try {
        open(app2);
        assert.strictEqual(app2.el('gp_p').value, '2500', 'restored');
        assert.rel(app2.win.WTS_state.gaspvt.z, z, 1e-12, 'recalculated on restore');
        app2.flushUntilIdle(10000);
        assert.strictEqual(app2.pendingTimers(), 0, 'no timers after reload');
      } finally { app2.dispose(); }
    },
  },
  {
    name: 'GASPVT gascalc: "Use calculated Z" fills each card from WTS_gaspvt_compute and recalculates (imperial and metric)',
    wp: WP,
    run(app, assert) {
      const W = app.win, F = W.WTS_gaspvt_compute;
      open(app, 'gascalc');
      ['gv_usez', 'gg_usez', 'gs_usez'].forEach((id) => assert.ok(app.el(id), id));
      // Simple gradient card: 3731 psia, 0.7, 600 °R
      app.click('gs_usez');
      const zs = F({ sg: 0.7, p: 3731, t: 600 - 459.67 }).z;
      assert.strictEqual(app.el('gs_z').value, zs.toFixed(4), 'gs_z filled');
      assert.rel(rv(app, 'gs_res', 'Gas Gradient'), 0.01875 * 0.7 * 3731 / (Number(zs.toFixed(4)) * 600), 2e-3, 'gradient recalculated');
      assert.includes(txt(app, 'gs_res'), 'Z used (Sutton + DAK, sweet gas)');
      // Velocity card: 4000 psia, 80 °F, gravity 0.65
      app.click('gv_usez');
      const zv = F({ sg: 0.65, p: 4000, t: 80 }).z;
      assert.strictEqual(app.el('gv_z').value, zv.toFixed(4), 'gv_z filled');
      assert.rel(rv(app, 'gv_res', 'Bg (gas FVF)'), 0.02833 * Number(zv.toFixed(4)) * 540 / 4000, 1e-3, 'velocity card recalculated');
      // Column card: Z at the average of wellhead and bottomhole pressure (self-consistent)
      app.click('gg_usez');
      const zg = parseFloat(app.el('gg_z').value);
      const pws = 2500 * Math.exp(0.01875 * 0.7 * 13650 / (zg * 600));
      assert.rel(zg, F({ sg: 0.7, p: (2500 + pws) / 2, t: 600 - 459.67 }).z, 1e-3, 'Z at average column pressure');
      assert.rel(rv(app, 'gg_res', 'BHP (exponential)'), pws, 1e-3, 'BHP recalculated');
      // Validation: bad gravity → message, Z untouched
      app.input('gs_sg', '0.2'); app.click('gs_usez');
      assert.includes(errText(app, 'gs_res'), 'Gas Gravity must be at least 0.55');
      assert.strictEqual(app.el('gs_z').value, zs.toFixed(4), 'Z unchanged on error');
      app.input('gs_sg', '0.7');
      // Metric: inputs shown in SI, Z computed from canonical imperial values
      app.flush(10);
      const U = W.WTS_units;
      U.setSystem('metric');
      try {
        open(app, 'gascalc');
        app.input('gs_z', '0.5');
        app.click('gs_usez');
        assert.strictEqual(app.el('gs_z').value, zs.toFixed(4), 'metric: same Z');
        assert.includes(txt(app, 'gs_res'), 'kPa');
      } finally { U.setSystem('imperial'); }
      noBadNumbers(assert, app, 'gascalc');
    },
  },
  {
    name: 'GASPVT phone: renders at 375 px with results and a dashboard tile',
    wp: WP,
    opts: { viewport: { width: 375, height: 812 } },
    run(app, assert) {
      const b = app.find('.nav-btn[data-p="gaspvt"]');
      assert.ok(b && b.closest('#sidebar'), 'button in the mobile sidebar');
      open(app);
      assert.ok(app.el('gp_res').querySelector('.rrow'), 'results rendered');
      assert.ok(!/width:\s*[4-9]\d\dpx|width:\s*\d{4,}px/.test(app.el('pgBody').innerHTML), 'no fixed widths above 340 px');
      app.hook.nav('home');
      const titles = app.findAll('.dash-card').map((c) => String(c.querySelector('h3').textContent).trim());
      assert.ok(titles.indexOf('Gas PVT') !== -1, 'dashboard tile');
    },
  },
];
