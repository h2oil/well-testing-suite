// Well Performance skin table — docs/WELL-PERFORMANCE-PLAN.md §4.3, §17.1 (wellperf-skin, 7 tests; WP2).
//
// S_t = S_pp + S_θ + S_f + (h/h_p)·(S_d + S_perf + S_dp + S_gp) + D·q
// SK1 Hawkins damage; SK2 McLeod crushed zone; SK3 gravel pack in the tunnels (the 96 field form, cross-checked against linear
// Darcy flow through the tunnels — the textbook example is not verified (Q9), so the part carries the provisional label); SK4 the
// h / h_p scaling with b < 1 and the geometric skins of PRiSM_skinDecomposition; SK5 total, the rate-dependent part and
// PRiSM_rateDependentSkin; SK6 Karakas-Tariq disabled while UNVERIFIED (D11), user-entered perforation skin; SK7 Δp_skin and FE
// through PRiSM_skinCheck.products, and the gas Δp_skin through m(p).
'use strict';

const S = require('./_wellperf-shapes');

const WP = 'WP2';
const app0 = (ctx) => S.sharedApp(ctx);
const part = (T, key) => T.parts.filter((p) => p.key === key)[0];

module.exports = [
  {
    name: 'SK1 Hawkins damage: S_d = (k/k_s − 1)·ln(r_s/r_w) on the open interval (basis h_p); needs k, k_s and r_s > r_w; SHAPE.SkinTable',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const W = app0(ctx).win.WTS_wp_ipr;
      const T = W.skin({ k: 100, h: 50, rw: 0.354, ks: 10, rs: 2 });
      const sh = S.checkShape('SkinTable', T); assert.ok(sh.ok, sh.errors.join('; '));
      const d = part(T, 'damage');
      assert.ok(d && d.basis === 'hp' && /Hawkins/.test(d.source));
      assert.rel(d.S, 9 * Math.log(2 / 0.354), 1e-15); assert.rel(T.total, d.S, 1e-15, 'h_p = h → S_h = S');
      assert.rel(d.S, 15.584449917674771, 1e-13, 'hand value');
      // a stimulated zone (k_s > k) gives a negative skin
      assert.ok(part(W.skin({ k: 10, h: 50, rw: 0.354, ks: 50, rs: 3 }), 'damage').S < 0);
      const n1 = W.skin({ h: 50, rw: 0.354, ks: 10, rs: 2 });
      assert.ok(!part(n1, 'damage') && n1.warnings.some((w) => w.code === 'NEEDS_K'));
      const n2 = W.skin({ k: 100, h: 50, rw: 0.354, ks: 10, rs: 0.2 });
      assert.ok(!part(n2, 'damage') && n2.warnings.some((w) => w.code === 'NEEDS_DAMAGE'));
      assert.strictEqual(W.skin({ k: 100 }).code, 'NEEDS_H');
      // the res-shaped spec (M.res: {params, pr}) is accepted too
      assert.rel(W.skin({ pr: 3000, params: { k: 100, h: 50, rw: 0.354, ks: 10, rs: 2 } }).total, T.total, 0);
    },
  },
  {
    name: 'SK2 McLeod crushed zone: S_dp = (h_p/(L_p·n))·(k/k_dp − k/k_d)·ln(r_dp/r_p), L_p in ft, n = shots per ft × h_p (or entered), k_d = k unless entered',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const W = app0(ctx).win.WTS_wp_ipr;
      const P = { k: 100, h: 40, rw: 0.354, kdp: 20, Lp_in: 12, rp_in: 0.2, rdp_in: 0.7, spf: 4 };
      const T = W.skin(P), c = part(T, 'crushed'), n = 4 * 40;
      assert.ok(c && c.basis === 'hp' && /McLeod/.test(c.source));
      assert.rel(c.S, (40 / (1 * n)) * (100 / 20 - 100 / 100) * Math.log(0.7 / 0.2), 1e-14);
      assert.rel(c.S, 1.2527629684953681, 1e-13, 'hand value');
      // perforations inside a damaged zone: k_d entered
      const T2 = W.skin(Object.assign({ kd: 50 }, P));
      assert.rel(part(T2, 'crushed').S, (40 / n) * (100 / 20 - 100 / 50) * Math.log(3.5), 1e-14);
      // number of open perforations entered instead of the shot density
      const T3 = W.skin(Object.assign({}, P, { spf: undefined, nperf: 80 }));
      assert.rel(part(T3, 'crushed').S, (40 / 80) * 4 * Math.log(3.5), 1e-14);
      const bad = W.skin(Object.assign({}, P, { rdp_in: 0.1 }));
      assert.ok(!part(bad, 'crushed') && bad.warnings.some((w) => w.code === 'NEEDS_CRUSHED'));
    },
  },
  {
    name: 'SK3 gravel pack: S_gp = 96·k·h_p·L_g/(k_g·n·d_p²) (h_p ft, L_g and d_p in) equals the skin of linear Darcy flow through n open tunnels (8·k·h_p·L/(k_g·n·d²) in consistent units); worked example; provisional label',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const W = app0(ctx).win.WTS_wp_ipr;
      // worked example: k 100 md, h = h_p 25 ft, 12 spf → 300 open perforations, tunnel L_g 6 in, d_p 0.5 in, gravel 50 darcy
      const P = { k: 100, h: 25, rw: 0.354, kg: 50000, Lg_in: 6, dp_in: 0.5, spf: 12 };
      const g = part(W.skin(P), 'gravel');
      assert.ok(g && g.basis === 'hp' && /provisional/.test(g.source));
      assert.rel(g.S, 96 * 100 * 25 * 6 / (50000 * 300 * 0.25), 1e-15); assert.rel(g.S, 0.384, 1e-13);
      // cross-check from first principles: Δp of linear flow q·B·μ·L/(1.127e-3·k_g·A) through A = n·π·d²/4 (ft²), as a skin
      // S = Δp·k·h/(141.2·q·B·μ): the 96 field constant is 144/12 × 8 = 141.2·1.127e-3·π/4 inverted
      const q = 1000, B = 1.2, mu = 1.1, L = 6 / 12, d = 0.5 / 12, A = 300 * Math.PI * d * d / 4;
      const dp = q * B * mu * L / (1.127e-3 * 50000 * A);
      assert.rel(dp * 100 * 25 / (141.2 * q * B * mu), g.S, 3e-4, 'linear-flow skin = the 96 form (Darcy constants rounded)');
      assert.rel(141.2 * 1.127e-3 * Math.PI / 4, 1 / 8, 2e-4, 'consistent-unit constant 8');
      const bad = W.skin({ k: 100, h: 25, rw: 0.354, kg: 50000, Lg_in: 6 });
      assert.ok(!part(bad, 'gravel') && bad.warnings.some((w) => w.code === 'NEEDS_GP'));
    },
  },
  {
    name: 'SK4 h / h_p scaling with b < 1: open-interval parts × h/h_p, partial penetration (Brons-Marting) / deviation / fracture from PRiSM_skinDecomposition on h; total = Σ S_h',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app0(ctx).win, W = G.WTS_wp_ipr;
      const P = { k: 100, h: 80, hp: 20, rw: 0.354, ks: 20, rs: 1.5, Sperf: 0.8, theta: 30, kvkh: 0.1 };
      const T = W.skin(P);
      const ref = G.PRiSM_skinDecomposition({ S_total: 0, geom: { h: 80, rw: 0.354, hp: 20, kvkh: 0.1, theta: 30 } });
      assert.rel(T.hOverHp, 4, 0); assert.strictEqual(T.hp, 20);
      const pp = part(T, 'pp'), th = part(T, 'theta'), dm = part(T, 'damage'), pf = part(T, 'perf');
      assert.ok(pp && pp.basis === 'h' && pp.source === 'PRiSM_skinDecomposition'); assert.ok(Object.is(pp.S, ref.S_pp));
      assert.ok(th && Object.is(th.S, ref.S_theta) && th.basis === 'h');
      assert.ok(pp.S > 0 && th.S < 0, 'partial penetration adds, deviation removes');
      assert.rel(dm.Sh, 4 * dm.S, 1e-15, 'damage referred to h'); assert.rel(pf.Sh, 3.2, 1e-15, 'perforation referred to h');
      assert.rel(T.total, pp.S + th.S + 4 * (dm.S + 0.8), 1e-14, 'S_t');
      assert.ok(T.notes.some((n) => /h\/h_p = 4\.000/.test(n)) && T.notes.some((n) => /not modelled/.test(n)));
      // fracture: r_w′ = x_f/2 → S_f = ln(2·rw/x_f)
      const F = W.skin({ h: 50, rw: 0.354, xf: 100 });
      assert.rel(part(F, 'frac').S, Math.log(2 * 0.354 / 100), 1e-12);
      const hb = W.skin({ k: 100, h: 50, hp: 80, rw: 0.354, ks: 10, rs: 2 });
      assert.ok(hb.hp === 50 && hb.warnings.some((w) => w.code === 'HP_GT_H'));
    },
  },
  {
    name: 'SK5 total with the rate-dependent part: D from PRiSM_rateDependentSkin (S′ = S + D·q) or entered, D·q at the reference rate on h; Sconst = total − D·q',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app0(ctx).win, W = G.WTS_wp_ipr;
      const rows = [{ q: 2000, S: 2.4 }, { q: 4000, S: 2.8 }, { q: 6000, S: 3.2 }];
      const rd = G.PRiSM_rateDependentSkin(rows);
      const T = W.skin({ k: 10, h: 40, rw: 0.354, ks: 2, rs: 1, rateRows: rows, q: 5000 });
      const nd = part(T, 'nonDarcy');
      assert.ok(nd && nd.basis === 'h' && nd.source === 'PRiSM_rateDependentSkin' && T.Dsource === 'PRiSM_rateDependentSkin');
      assert.rel(T.D, rd.D, 1e-15); assert.rel(T.D, 2e-4, 1e-9); assert.rel(nd.S, 2e-4 * 5000, 1e-9);
      assert.rel(T.total, part(T, 'damage').S + nd.S, 1e-14); assert.rel(T.Sconst, part(T, 'damage').S, 1e-14);
      const T2 = W.skin({ k: 10, h: 40, rw: 0.354, D: 1e-4, q: 3000 });
      assert.rel(part(T2, 'nonDarcy').S, 0.3, 1e-14); assert.strictEqual(T2.Dsource, 'input');
      const T3 = W.skin({ k: 10, h: 40, rw: 0.354, D: 1e-4 });
      assert.ok(!part(T3, 'nonDarcy') && T3.D === 1e-4 && T3.total === 0, 'no reference rate → D kept, no part');
    },
  },
  {
    name: 'SK6 perforation skin: Karakas-Tariq disabled while PRiSM_skinCheck marks its table UNVERIFIED (message, no part); a user-entered S_perf is used and labelled',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app0(ctx).win, W = G.WTS_wp_ipr;
      const kt = G.PRiSM_skinCheck.perforationSkin({ rw_ft: 0.354, lp_in: 12, rp_in: 0.2, spf: 12, phase_deg: 90, kvkh: 1 });
      const geo = { k: 100, h: 50, rw: 0.354, Lp_in: 12, rp_in: 0.2, spf: 12, phase_deg: 90 };
      const T = W.skin(geo);
      if (kt.ok) {
        assert.ok(part(T, 'perf') && part(T, 'perf').source === 'PRiSM_skinCheck.perforationSkin', 'table verified → used');
      } else {
        assert.strictEqual(kt.code, 'UNVERIFIED');
        assert.ok(!part(T, 'perf'), 'no Karakas-Tariq part');
        const w = T.warnings.filter((x) => x.code === 'KT_DISABLED')[0];
        assert.ok(w && /disabled/.test(w.msg) && /enter the perforation skin/.test(w.msg));
      }
      const U = W.skin(Object.assign({ Sperf: 1.7 }, geo));
      const p = part(U, 'perf');
      assert.ok(p && p.S === 1.7 && p.source === 'user' && /user-entered/.test(p.label) && p.basis === 'hp');
      assert.ok(!U.warnings.some((x) => x.code === 'KT_DISABLED'), 'no message once entered');
    },
  },
  {
    name: 'SK7 Δp_skin = 141.2·q·B·μ·S/(k·h) and FE = (p̄r − pwf − Δp_skin)/(p̄r − pwf) through PRiSM_skinCheck.products; PI-ratio FE without a test point; gas Δp_skin through m(p)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app0(ctx).win, W = G.WTS_wp_ipr;
      const P = { k: 50, h: 30, rw: 0.354, re: 1490, ks: 5, rs: 1.5, Bo: 1.2, muo: 1.5, D: 1e-4 };
      const T = W.skin(P), S0 = T.Sconst;
      // products: Δp_skin = 0.8686·m·S with m = 162.6·q·B·μ/(k·h) — i.e. 141.2·q·B·μ·S/(k·h) to the rounding of the constants
      const C = 0.8686 * 162.6;
      assert.rel(C, 141.2, 3e-4, 'the semilog constants give 141.2');
      assert.rel(T.dpSkin(800), C * 800 * 1.2 * 1.5 * (S0 + 1e-4 * 800) / (50 * 30), 1e-12, 'Δp_skin(q) with D·q');
      assert.strictEqual(T.dpSkin(0), null);
      const X = Math.log(1490 / 0.354) - 0.75;
      assert.rel(T.FE, X / (X + S0), 1e-14); assert.ok(/PI ratio/.test(T.FEbasis));
      const Tt = W.skin(Object.assign({ pbar: 3000, pwf: 2200, q: 800 }, P));
      const dps = C * 800 * 1.2 * 1.5 * (S0 + 0.08) / 1500;
      assert.rel(Tt.FE, (800 - dps) / 800, 1e-12); assert.ok(/test point/.test(Tt.FEbasis));
      // through the inflow: a Darcy oil curve carries the table
      const I = W.curve({ model: 'darcyOil', pr: 3000, params: P });
      assert.ok(I.skin && I.skin.parts.length === 1 && I.form.Ssource === 'skin table');
      // gas: Δp_skin = p(m(pwf) + 1422·q·T·S/(k·h)) − pwf
      const Tg = W.skin({ k: 5, h: 40, rw: 0.354, ks: 1, rs: 1, kind: 'gas', T_F: 220, sg: 0.68, pbar: 4000 });
      const tb = G.PRiSM_mpTable({ T_F: 220, sg: 0.68, pmax: Math.max(1.2 * 4000, 4500) });
      const dm = 1422 * 3000 * (220 + 459.67) * Tg.Sconst / (5 * 40);
      assert.rel(Tg.dpSkin(3000, 2500), tb.pOf(tb.mOf(2500) + dm) - 2500, 1e-6, 'gas Δp_skin');
      assert.ok(Tg.dpSkin(3000, 2500) > 0); assert.strictEqual(Tg.dpSkin(3000), null, 'gas needs pwf'); assert.strictEqual(Tg.FE, null);
    },
  },
];
