// DFIT — WP2 G-function family (docs/DFIT-PLAN.md §4.5, §4.9, §9 WP2 "dfit-gfunction").
//
//   G1  g0 = π/2 (α ½) and 4/3 (α 1)
//   G2  the G table: G(1, ½) 1.27324, G(1, 1) 1.40638, G(10, ½) 6.3159, G(100, ½) 23.5495, G(100, 1) 23.8307
//   G3  64-point Gauss–Legendre quadrature (general α) against the closed forms < 1e-5 at ΔtD 0, 0.1, 1, 10, 61.7
//   G4  g0(8/9, 4/5, 2/3) = 1.37689 / 1.41495 / 1.47835 (radial, PKN, KGD no-leak-off α)
//   G5  G⁻¹(18, ½) = 61.019 (bisection on log ΔtD)
//   G6  η(18, ½) 0.9000 and η(18.276, 1) 0.9150; the α pair is shown when |Δη| > 0.01 (G_c 5) but not at G_c 61; the
//       what-if table always carries both α values
//   G7  local slopes d ln G / d ln ΔtD 0.785 / 0.617 / 0.539 at ΔtD 1 / 10 / 100 (α ½)
//   G8  the data-driven G equals the closed form for a constant-rate schedule within 1e-4 and stays monotone on a ramped
//       two-cycle schedule; Derivs on FIX.ds reports gType 'data' for alpha 'auto'
'use strict';

const S = require('./_dfit-shapes');

const WP = 'DF2';
const near = (assert, a, b, tol, what) => assert(typeof a === 'number' && Math.abs(a - b) <= tol, what + ': ' + a + ' vs ' + b + ' (± ' + tol + ')');
function app(ctx) { const a = S.sharedApp(ctx); S.resetDfit(a); return a.win; }

module.exports = [
  {
    name: 'G1 g0 = π/2 (α ½) and 4/3 (α 1); the general-α g0 at the bounds agrees',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx);
      near(assert, G.PRiSM_dfit_g(0, 0.5), Math.PI / 2, 1e-12, 'g(0, ½)');
      near(assert, G.PRiSM_dfit_g(0, 1), 4 / 3, 1e-12, 'g(0, 1)');
      near(assert, G.PRiSM_dfit_g.g0(0.5), Math.PI / 2, 1e-12, 'g0(½)');
      near(assert, G.PRiSM_dfit_g.quad(0, 1), 4 / 3, 1e-6, 'quadrature g0(1)');
      assert.strictEqual(G.PRiSM_dfit_G(0, 0.5), 0, 'G(0) = 0');
      assert.strictEqual(G.PRiSM_dfit_g(1, 0.4), null, 'α outside (0.5, 1] → null');
      assert.strictEqual(G.PRiSM_dfit_G(-1, 0.5), null, 'negative ΔtD → null');
    },
  },
  {
    name: 'G2 the G table (§4.5 check values)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx);
      near(assert, G.PRiSM_dfit_G(1, 0.5), 1.27324, 1e-5, 'G(1, ½) = 4/π');
      near(assert, G.PRiSM_dfit_G(1, 1), 1.40638, 1e-5, 'G(1, 1)');
      near(assert, G.PRiSM_dfit_G(10, 0.5), 6.3159, 1e-4, 'G(10, ½)');
      near(assert, G.PRiSM_dfit_G(100, 0.5), 23.5495, 1e-4, 'G(100, ½)');
      near(assert, G.PRiSM_dfit_G(100, 1), 23.8307, 1e-4, 'G(100, 1)');
      // asymptotes: ΔtD ≪ 1 G ≈ 2·ΔtD (α ½), (8/π)·ΔtD (α 1)
      near(assert, G.PRiSM_dfit_G(1e-6, 0.5) / 1e-6, 2, 1e-2, 'small-ΔtD slope α ½');
      near(assert, G.PRiSM_dfit_G(1e-6, 1) / 1e-6, 8 / Math.PI, 1e-2, 'small-ΔtD slope α 1');
    },
  },
  {
    name: 'G3 general-α quadrature agrees with the closed forms (< 1e-5) at ΔtD 0, 0.1, 1, 10, 61.7',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx);
      [0, 0.1, 1, 10, 61.7].forEach((d) => {
        near(assert, G.PRiSM_dfit_g.quad(d, 0.5), G.PRiSM_dfit_g(d, 0.5), 1e-5, 'g quad α ½ at ' + d);
        near(assert, G.PRiSM_dfit_g.quad(d, 1), G.PRiSM_dfit_g(d, 1), 1e-5, 'g quad α 1 at ' + d);
        near(assert, G.PRiSM_dfit_gPrime.quad(d, 0.5), G.PRiSM_dfit_gPrime(d, 0.5), 1e-5, "g' quad α ½ at " + d);
        near(assert, G.PRiSM_dfit_gPrime.quad(d, 1), G.PRiSM_dfit_gPrime(d, 1), 1e-5, "g' quad α 1 at " + d);
      });
      // a general α between the bounds lies between them
      const g75 = G.PRiSM_dfit_G(10, 0.75);
      assert(g75 > G.PRiSM_dfit_G(10, 0.5) && g75 < G.PRiSM_dfit_G(10, 1), 'G(10, ¾) between the α bounds');
    },
  },
  {
    name: 'G4 g0 for the no-leak-off geometry α (8/9, 4/5, 2/3) = 1.37689 / 1.41495 / 1.47835',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx);
      near(assert, G.PRiSM_dfit_g.g0(8 / 9), 1.37689, 1e-5, 'radial 8/9');
      near(assert, G.PRiSM_dfit_g.g0(0.8), 1.41495, 1e-5, 'PKN 4/5');
      near(assert, G.PRiSM_dfit_g.g0(2 / 3), 1.47835, 1e-5, 'KGD 2/3');
      near(assert, 4 * G.PRiSM_dfit_g.g0(8 / 9) / Math.PI, 1.7531, 1e-4, '4·g0/π (8/9)');
    },
  },
  {
    name: 'G5 G⁻¹(18, ½) = 61.019 and the inverse round-trips for α ½, 1 and general',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx);
      near(assert, G.PRiSM_dfit_Ginv(18, 0.5), 61.019, 1e-3, 'G⁻¹(18, ½)');
      [0.5, 1, 0.75].forEach((a) => [0.05, 3, 18, 60].forEach((g) => near(assert, G.PRiSM_dfit_G(G.PRiSM_dfit_Ginv(g, a), a), g, 1e-7 * Math.max(1, g), 'round trip α ' + a + ' G ' + g)));
      assert.strictEqual(G.PRiSM_dfit_Ginv(0, 0.5), 0, 'G⁻¹(0) = 0');
    },
  },
  {
    name: 'G6 η(18, ½) 0.9000, η(18.276, 1) 0.9150; the α pair shows when |Δη| > 0.01 (G_c 5), not at G_c 61; what-if carries both',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx);
      near(assert, G.PRiSM_dfit_eta(18, 0.5), 0.9000, 5e-5, 'η(18, ½)');
      near(assert, G.PRiSM_dfit_eta(18.276, 1), 0.9150, 5e-5, 'η(18.276, 1)');
      const p5 = G.PRiSM_dfit_etaPair(G.PRiSM_dfit_Ginv(5, 0.5)), p61 = G.PRiSM_dfit_etaPair(G.PRiSM_dfit_Ginv(61, 0.5));
      assert(p5.delta > 0.01 && p5.showPair === true, 'G_c 5: Δη ' + p5.delta.toFixed(4) + ' > 0.01 → pair shown');
      assert(p61.delta < 0.01 && p61.showPair === false, 'G_c 61: Δη ' + p61.delta.toFixed(4) + ' → pair not shown');
      // the what-if table always carries both α values (FracOutputs.eta.a05 / a1)
      const ds = S.FIX.ds, inputs = S.FIX.state.tests[0].inputs;
      const prep = G.PRiSM_dfit_prepare(ds, inputs, {}), ev = G.PRiSM_dfit_events(prep, inputs.events, {});
      const d = G.PRiSM_dfit_derivs(prep, ev, { alpha: 0.5 });
      const wi = G.PRiSM_dfit_whatIf([{ label: 'A', p: 7000 }, { label: 'B', p: 7500 }], d, { events: ev, isip: 7600, inputs, ViStar: 25 });
      assert.strictEqual(wi.length, 2, 'two what-if rows');
      wi.forEach((r) => { assert(S.checkShape('FracOutputs', r).ok, 'what-if row shape'); assert(r.eta.a05 > 0 && r.eta.a1 > 0, 'both α in the what-if row ' + r.label); });
      wi.forEach((r) => assert.strictEqual(r.eta.showPair, G.PRiSM_dfit_etaPair(r.dtDc).showPair, 'showPair follows the |Δη| > 0.01 rule at G_c ' + r.Gc));
      assert(wi[0].eta.showPair === true && Math.abs(wi[0].eta.a1 - wi[0].eta.a05) > 0.01, 'G_c 18: Δη ≈ 0.015 → the pair is shown (§4.5)');
    },
  },
  {
    name: 'G7 local slopes d ln G / d ln ΔtD = 0.785 / 0.617 / 0.539 at ΔtD 1 / 10 / 100 (α ½)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx);
      const sl = (d) => d * (4 / Math.PI) * G.PRiSM_dfit_gPrime(d, 0.5) / G.PRiSM_dfit_G(d, 0.5);
      near(assert, sl(1), 0.785, 5e-4, 'slope at 1'); near(assert, sl(10), 0.617, 5e-4, 'slope at 10'); near(assert, sl(100), 0.539, 5e-4, 'slope at 100');
      near(assert, sl(0.01), 0.978, 1e-3, 'slope at 0.01'); near(assert, sl(0.1), 0.927, 1e-3, 'slope at 0.1');
    },
  },
  {
    name: 'G8 data-driven G = closed form at constant rate (1e-4); monotone on a ramped two-cycle schedule; auto → data on FIX.ds',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx);
      const tp = 5 / 60, ts = 7 / 60;
      const gs = G.PRiSM_dfit_gFromHistory([{ t: ts - tp, q: 5 }], ts, tp, { alpha: 0.5 });
      assert(gs.ok === true && gs.kind === 'data' && gs.tauNodes.length === 64, 'gSpec');
      near(assert, gs.g0, Math.PI / 2, 1e-4, 'data-driven g0 = π/2');
      [0.01, 0.1, 1, 10, 61.7, 500].forEach((d) => near(assert, gs.G(d), G.PRiSM_dfit_G(d, 0.5), 1e-4, 'data G at ' + d));
      near(assert, G.PRiSM_dfit_G(10, gs), G.PRiSM_dfit_G(10, 0.5), 1e-4, 'PRiSM_dfit_G accepts a gSpec');
      near(assert, G.PRiSM_dfit_Ginv(18, gs), 61.019, 2e-3, 'PRiSM_dfit_Ginv accepts a gSpec');
      const g1 = G.PRiSM_dfit_gFromHistory([{ t: ts - tp, q: 5 }], ts, tp, { alpha: 1 });
      near(assert, g1.G(10), G.PRiSM_dfit_G(10, 1), 1e-4, 'data G α 1');
      // ramped two-cycle schedule: a ramp, a pause and a second cycle
      const sch = [{ t: 0, q: 1 }, { t: 0.02, q: 3 }, { t: 0.04, q: 5 }, { t: 0.06, q: 0 }, { t: 0.09, q: 4 }, { t: 0.12, q: 2 }];
      const g2 = G.PRiSM_dfit_gFromHistory(sch, 0.15, 0.15, { alpha: 0.5 });
      assert(g2.ok === true, 'two-cycle gSpec');
      let prev = -1, mono = true;
      for (let k = 0; k <= 200; k++) { const d = Math.pow(10, -4 + k * 0.035), v = g2.G(d); if (!(v > prev)) mono = false; prev = v; }
      assert(mono, 'the data-driven G is strictly increasing on the two-cycle schedule');
      // model-derived G from an area history: a constant area from t = 0 gives g = 2√(1 + ΔtD) (§4.5, review note 11)
      const gm = G.PRiSM_dfit_gFromHistory(null, ts, tp, { area: 'model', modelHist: { t: [ts - tp, ts - tp + 1e-9, ts], AL: [0, 1, 1] } });
      near(assert, gm.G(3), 4 / Math.PI * (2 * Math.sqrt(4) - 2), 1e-3, 'model G with a constant area');
      // Derivs on FIX.ds: alpha 'auto' with a rate history → the data-driven G, equal to the closed form here (constant rate)
      const ds = S.FIX.ds, inputs = S.FIX.state.tests[0].inputs;
      const prep = G.PRiSM_dfit_prepare(ds, inputs, {}), ev = G.PRiSM_dfit_events(prep, inputs.events, {});
      const d = G.PRiSM_dfit_derivs(prep, ev, { alpha: 'auto' });
      assert(d.ok === true && d.gType === 'data', 'gType data for alpha auto (got ' + d.gType + ')');
      const i = d.G.length >> 1;
      near(assert, d.G[i], G.PRiSM_dfit_G(d.dtD[i], 0.5), 1e-4, 'Derivs G (data) = closed form');
      assert(S.checkShape('Derivs', d).ok, 'Derivs shape: ' + JSON.stringify(S.checkShape('Derivs', d).errors.slice(0, 3)));
    },
  },
];
