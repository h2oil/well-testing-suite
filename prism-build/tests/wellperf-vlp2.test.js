// Well Performance vertical lift, increment A2 — Duns & Ros and Cullender-Smith (WP12). docs/WELL-PERFORMANCE-PLAN.md §3.4, §4.4,
// §15.1 (D17 gate, Q9: no books → provisional), §15.2 (gas cross-checks), §17.2 (wellperf-vlp2: 8) + the page (2).
//
// VD1 registry: dr and gasCS registered (merge; the A1 entries and the Beggs & Brill default unchanged), provisional under the D17
//     gate with their §15.1 BENCH entries (wellperf-validate gate passes), kinds, vertical flag, the gas-only note; new functions
// VD2 Duns & Ros regions with known numbers: drRegion boundaries L1 + L2·N_Lv, 50 + 36·N_Lv, 75 + 84·N_Lv^0.75 at given points; the
//     dimensionless groups by hand; the region of a gradient = drRegion of its groups; pattern names
// VD3 Duns & Ros regions I and II by hand: slip number S (F1–F7 readings), holdup from the slip velocity (residual of
//     v_s = v_sg/(1 − H) − v_sl/H), friction f_m = f1·f2/f3 on the liquid, no acceleration term
// VD4 Duns & Ros mist and transition: no slip, film roughness by both Weber branches, the large-roughness friction law, the
//     acceleration factor; continuity at the II / transition and transition / III boundaries; the I / II jump is a documented
//     discontinuity
// VD5 the ten chart functions pinned: three readings per curve, log-linear interpolation, constant beyond the table ends
// VD6 Cullender-Smith closed form by hand (two half-lengths then Simpson, units), gasDry({method:'cs'}) = gasCS, gasDry default
//     unchanged, bottom-up inverse, point form = the differentiated integrand
// VD7 gas cross-checks: Cullender-Smith vs average T-Z closed forms (1 %), the marcher with gasCS / gasTZ / gray / bb / nsl / dr vs the
//     Cullender-Smith closed form (1 %), vertical and deviated; zero rate vs the well-kill gas column (0.2 %); hydrostatic on TVD
// VD8 the system: Duns & Ros solves FIX.oilWell (PROVISIONAL flag) and the deviated gas well (VERTICAL_ONLY), gasCS refused for an
//     oil well (solver and WTS_wp_check); direction agreement and step convergence with Duns & Ros; water column on the deviated path;
//     the comparison sets of WTS_wp_match
// VD9 page: the Correlations tab (a traverse per correlation from the solved THP at the operating rate, the selected one = the solve,
//     table with BHP / Δ / provisional chips, closed forms for gas wells), "Use" switches the correlation through the normal input
//     path; gasCS disabled for an oil well; report capture and the Quick Report snapshot ≤ 60 kB
// VD10 page: operating point per correlation (a Job) → diamonds on the system plot and the table column; the Flow-regime map tab
//     (log axes, boundaries, the traverse path per region with station read-outs on MD / TVD, the station counts)
'use strict';

const S = require('./_wellperf-shapes');

const WP = 'WP12';
const PATM = 14.696;
const plain = (x) => JSON.parse(JSON.stringify(x));
const app = (ctx) => S.sharedApp(ctx);
const PROV = 'provisional — not verified against a published example';

const oilF = (o) => Object.assign({ ok: true, type: 'oil', rateBasis: 'liquid', api: 35, sgg: 0.65, sgw: 1.07, gor: 500, wc: 0.3, cgr: 0, wgr: 0, refQ: 1000, pvt: {} }, o || {});
const gasF = (o) => Object.assign({ ok: true, type: 'gas', rateBasis: 'gas', api: 55, sgg: 0.65, sgw: 1.07, gor: 0, wc: 0, cgr: 0, wgr: 0, refQ: 1000, pvt: { liquidNoTransfer: true, bc: 1 } }, o || {});
const watF = (o) => Object.assign({ ok: true, type: 'water', rateBasis: 'water', api: 35, sgg: 0.65, sgw: 1.0, gor: 0, wc: 0, cgr: 0, wgr: 0, refQ: 1000, pvt: { liquidNoTransfer: true, bc: 1 } }, o || {});
function vertW(L, id, tTop, tBot) {
  return { segments: [{ name: 'Tubing', len: L, id: id, dz: L, md0: L, md1: 0, tvd0: L, tvd1: 0, inc: 0, rough: 0.0006 }], tAt: (md) => tTop + (tBot - tTop) * md / L };
}
function devW(id, inc, tTop, tBot) {
  const kop = 2000, slant = 4000, tail = 3000;
  const legs = [[0, kop, 0], [kop, kop + slant, inc], [kop + slant, kop + slant + tail, 0]];
  const segs = []; let tvd = 0;
  legs.forEach(([a, b, i]) => {
    for (let m = a; m < b; m += 500) {
      const len = Math.min(500, b - m), dz = len * Math.cos(i * Math.PI / 180);
      segs.push({ name: 'Tubing', len, id, dz, md0: m + len, md1: m, tvd0: tvd + dz, tvd1: tvd, inc: i, rough: 0.0006 });
      tvd += dz;
    }
  });
  const mdTD = kop + slant + tail;
  return { segments: segs.reverse(), tAt: (md) => tTop + (tBot - tTop) * md / mdTD, mdTD, tvdTD: tvd };
}
// a vertical well in n equal segments (the Cullender-Smith two-step rule per segment, as on the deviated path)
function vSegW(L, n, id, T) {
  const segs = [], h = L / n;
  for (let i = 0; i < n; i++) segs.push({ name: 'Tubing', len: h, id, dz: h, md0: (i + 1) * h, md1: i * h, tvd0: (i + 1) * h, tvd1: i * h, inc: 0, rough: 0.0006 });
  return { segments: segs.reverse(), tAt: () => T };
}
function gIn(o) { return Object.assign({ vsl: 2, vsg: 6, d: 2.441, rhoL: 50, rhoG: 5, muL: 2, muG: 0.015, sigma: 25, theta: 90, rough: 0.0006, p: 1500, payne: true, accel: false }, o || {}); }
function colebrook(nre, e) {   // independent Colebrook for the hand checks
  if (nre < 2000) return 64 / nre;
  let x = -2 * Math.log10(e / 3.7 + 5.74 / Math.pow(nre, 0.9));
  for (let k = 0; k < 100; k++) x = -2 * Math.log10(e / 3.7 + 2.51 * x / nre);
  return 1 / (x * x);
}
function groups(i) {
  const dFt = i.d / 12, q4 = Math.pow(i.rhoL / i.sigma, 0.25);
  return { NLv: 1.938 * i.vsl * q4, Ngv: 1.938 * i.vsg * q4, Nd: 120.872 * dFt * Math.sqrt(i.rhoL / i.sigma),
    NL: 0.15726 * i.muL * Math.pow(1 / (i.rhoL * Math.pow(i.sigma, 3)), 0.25), q4, dFt };
}
const GC = 32.174;

module.exports = [
  {
    name: 'VD1 registry: dr and gasCS registered (A1 entries and the Beggs & Brill default unchanged), provisional under the D17 gate with BENCH entries; kinds, vertical flag, gas-only note; new functions',
    wp: WP,
    run(_a, assert, ctx) {
      const G = app(ctx).win, C = G.WTS_flowline_corr, V = G.WTS_wp_vlp;
      ['bb', 'hb', 'gray', 'nsl', 'single', 'gasTZ'].forEach((k) => assert.ok(C[k] && typeof C[k].grad === 'function', k + ' kept'));
      assert.strictEqual(C.bb.verified, true, 'Beggs & Brill still verified');
      const dr = C.dr, cs = C.gasCS;
      assert.ok(dr && dr.key === 'dr' && dr.kind === 'well' && dr.vertical === true && typeof dr.grad === 'function', 'dr entry');
      assert.ok(cs && cs.key === 'gasCS' && cs.kind === 'gas' && cs.vertical === false && cs.range.note === 'gas only', 'gasCS entry');
      [dr, cs].forEach((e) => { assert.strictEqual(e.verified, false, e.key + ' provisional (Q9)'); assert.strictEqual(e.provisional, PROV); assert.ok(/Duns|Cullender/.test(e.label) && e.source, e.key + ' label / source'); });
      ['oil', 'gas', 'condensate', 'water', 'gasinj'].forEach((t) => assert.strictEqual(V.defaultCorr(t).key, 'bb', t + ': default still the verified Beggs & Brill'));
      const lw = plain(V.list('well')).map((e) => e.key), lg = plain(V.list('gas')).map((e) => e.key);
      assert.ok(lw.includes('dr') && !lw.includes('gasCS') && lg.includes('gasCS'), 'list(kind): ' + lw + ' / ' + lg);
      assert.strictEqual(plain(V.list()).filter((e) => e.key === 'dr')[0].provisional, PROV, 'list carries the label');
      ['gasCS', 'drMap', 'drRegion', 'drBoundaries'].forEach((f) => assert.fn(V[f]));
      assert.ok(V.KEYS.includes('dr') && V.KEYS.includes('gasCS'), 'KEYS');
      // the §15.1 gate of wellperf-validate: every registry key has a BENCH row, unverified ones carry the label everywhere
      const VAL = require('../wellperf-validate');
      ['dr', 'gasCS'].forEach((k) => { const b = VAL.BENCH.find((x) => x.kind === 'corr' && x.key === k); assert.ok(b && b.status === 'pending', k + ' BENCH pending'); });
      const g = VAL.gate(G);
      assert.ok(g.ok, 'gate: ' + g.errors.join('; '));
    },
  },
  {
    name: 'VD2 Duns & Ros regions with known numbers: the three boundaries at given points (N_d interpolation), the dimensionless groups by hand, the region and pattern of a gradient',
    wp: WP,
    run(_a, assert, ctx) {
      const V = app(ctx).win.WTS_wp_vlp, C = app(ctx).win.WTS_flowline_corr;
      // N_d = 30 → L1 = 1.65, L2 = 0.70 (chart readings): at N_Lv = 1 the boundaries are 2.35, 86 and 159
      const r = (nlv, ngv, nd) => plain(V.drRegion(nlv, ngv, nd));
      const a = r(1, 2, 30);
      assert.near(a.LB, 2.35, 1e-12); assert.near(a.LS, 86, 1e-12); assert.near(a.LM, 159, 1e-12);
      assert.deepStrictEqual([r(1, 2, 30).region, r(1, 50, 30).region, r(1, 100, 30).region, r(1, 200, 30).region], ['I', 'II', 'transition', 'III']);
      assert.strictEqual(r(1, a.LB, 30).region, 'I', 'on the I / II line → I'); assert.strictEqual(r(1, a.LS, 30).region, 'II', 'on the II / transition line → II');
      assert.strictEqual(r(1, a.LM, 30).region, 'III', 'on the transition / III line → III');
      // N_Lv = 0.1: L_M = 75 + 84·0.1^0.75 = 89.937; N_d ≤ 10 → L1 = 2, L2 = 0.5; N_d ≥ 100 → 1, 1.1
      assert.near(r(0.1, 1, 30).LM, 75 + 84 * Math.pow(0.1, 0.75), 1e-12);
      assert.near(r(2, 1, 5).LB, 2 + 0.5 * 2, 1e-12); assert.near(r(2, 1, 500).LB, 1 + 1.1 * 2, 1e-12);
      const f = (Math.log10(35) - Math.log10(30)) / (Math.log10(40) - Math.log10(30));
      assert.near(r(0, 1, 35).L1, 1.65 + f * (1.35 - 1.65), 1e-12, 'L1 log-linear in N_d'); assert.near(r(0, 1, 35).L2, 0.70 + f * (0.88 - 0.70), 1e-12);
      // groups by hand (ρ lbm/ft³, σ dyn/cm, μ cp, v ft/s, d in → ft)
      const i = gIn({ vsl: 2, vsg: 6 }), gp = groups(i), g = C.dr.grad(i);
      assert.near(g.NLv, gp.NLv, 1e-12); assert.near(g.Ngv, gp.Ngv, 1e-12); assert.near(g.Nd, gp.Nd, 1e-12); assert.near(g.NL, gp.NL, 1e-12);
      assert.near(gp.Nd, 120.872 * (2.441 / 12) * Math.sqrt(2), 1e-12, 'N_d uses d in FT');
      assert.strictEqual(g.region, plain(V.drRegion(gp.NLv, gp.Ngv, gp.Nd)).region, 'region of the gradient');
      const pat = { I: 'bubble', II: 'slug', transition: 'transition', III: 'mist' };
      [[2, 0.2], [2, 6], [0.5, 60], [0.05, 150]].forEach(([vsl, vsg]) => {
        const ii = gIn({ vsl, vsg }), q = groups(ii), gg = C.dr.grad(ii), reg = V.drRegion(q.NLv, q.Ngv, q.Nd).region;
        assert.strictEqual(gg.region, reg, vsl + '/' + vsg); assert.strictEqual(gg.pattern, pat[reg]);
      });
      const regs = [[2, 0.2], [2, 6], [0.5, 60], [0.05, 150]].map(([vsl, vsg]) => C.dr.grad(gIn({ vsl, vsg })).region);
      assert.deepStrictEqual(regs, ['I', 'II', 'transition', 'III'], 'one point in each region: ' + regs);
    },
  },
  {
    name: 'VD3 Duns & Ros regions I and II by hand: slip number from the chart readings, holdup from the slip velocity, friction f_m = f1·f2/f3 on the liquid, no acceleration term',
    wp: WP,
    run(_a, assert, ctx) {
      const G = app(ctx).win, V = G.WTS_wp_vlp, C = G.WTS_flowline_corr, D = V._drCharts;
      [['I', gIn({ vsl: 2, vsg: 0.2, accel: true })], ['II', gIn({ vsl: 2, vsg: 6, accel: true })], ['II', gIn({ vsl: 1, vsg: 8, theta: 60, accel: true })]].forEach(([reg, i]) => {
        const q = groups(i), g = C.dr.grad(i);
        assert.strictEqual(g.region, reg);
        let Sx;
        if (reg === 'I') Sx = D.F('F1', q.NL) + D.F('F2', q.NL) * q.NLv + (D.F('F3', q.NL) - D.F('F4', q.NL) / q.Nd) * Math.pow(q.Ngv / (1 + q.NLv), 2);
        else Sx = (1 + D.F('F5', q.NL)) * (Math.pow(q.Ngv, 0.982) + 0.029 * q.Nd + D.F('F6', q.NL)) / Math.pow(1 + D.F('F7', q.NL) * q.NLv, 2);
        assert.near(g.S, Sx, 1e-12, reg + ' slip number');
        const vs = Sx / (1.938 * q.q4), vm = i.vsl + i.vsg, lam = i.vsl / vm;
        assert.near(g.vs, vs, 1e-12, 'slip velocity ft/s');
        assert.ok(g.hl >= lam && g.hl <= 1, 'holdup between λ_L and 1');
        assert.near(i.vsg / (1 - g.hl) - i.vsl / g.hl, vs, 1e-9 * vs, 'holdup satisfies v_s = v_sg/(1 − H) − v_sl/H');
        const rhoS = i.rhoL * g.hl + i.rhoG * (1 - g.hl);
        assert.near(g.gradEl, rhoS * Math.sin(i.theta * Math.PI / 180) / 144, 1e-12, 'elevation on ρ_s and the true inclination');
        const f1 = colebrook(1488 * i.rhoL * i.vsl * q.dFt / i.muL, i.rough / 12 / q.dFt), R = i.vsg / i.vsl;
        const f2 = D.f2(f1 * R * Math.pow(q.Nd, 2 / 3)), f3 = 1 + f1 * Math.sqrt(R / 50);
        assert.rel(g.fn, f1 * f2 / f3, 1e-6, 'f_m');
        assert.rel(g.gradF, (f1 * f2 / f3) * i.rhoL * i.vsl * vm / (2 * GC * q.dFt) / 144, 1e-6, 'friction gradient psi/ft');
        assert.strictEqual(g.Ek, 0, 'no acceleration term in regions I / II'); assert.near(g.grad, g.gradEl + g.gradF, 1e-15);
      });
      // single phase: Darcy-Weisbach on the mixture, hydrostatic at a creeping rate
      const w = C.dr.grad(gIn({ vsl: 1e-6, vsg: 0, rhoL: 62.4 }));
      assert.near(w.gradEl, 62.4 / 144, 1e-12); assert.ok(w.gradF < 1e-9 && w.pattern === 'liquid', 'liquid column');
      const z = C.dr.grad(gIn({ vsl: 0, vsg: 0 }));
      assert.ok(z.pattern === 'none' && z.gradF === 0, 'no flow');
    },
  },
  {
    name: 'VD4 Duns & Ros mist and transition: no slip, film roughness by both Weber branches, large-roughness friction, acceleration; continuous at the transition boundaries, a jump at I / II',
    wp: WP,
    run(_a, assert, ctx) {
      const G = app(ctx).win, V = G.WTS_wp_vlp, C = G.WTS_flowline_corr;
      // independent mist gradient (the published rule, three passes of the d − ε / v_sg correction)
      const mist = (i, rhoG) => {
        const dFt = i.d / 12, sig = i.sigma * 0.00220462, mu = i.muL * 6.7197e-4;
        let v = i.vsg, d = dFt, eps = 0;
        for (let pass = 0; pass < 3; pass++) {
          const rv2 = rhoG * v * v, X = rv2 * mu * mu / (i.rhoL * sig * sig);
          eps = X <= 0.005 ? 0.0749 * i.sigma / rv2 : 0.3713 * i.sigma * Math.pow(X, 0.302) / rv2;
          let rel = eps / dFt; rel = Math.min(0.5, Math.max(i.rough / 12 / dFt, rel)); eps = rel * dFt;
          if (pass === 2) break;
          d = Math.max(0.1 * dFt, dFt - eps); v = i.vsg * dFt * dFt / (d * d);
        }
        const rd = eps / d, f = rd < 0.05 ? colebrook(1488 * rhoG * v * d / i.muG, rd) : 4 * (1 / (16 * Math.pow(Math.log10(0.27 * rd), 2)) + 0.067 * Math.pow(rd, 1.73));
        return { gF: f * rhoG * v * v / (2 * GC * d) / 144, f, rd, X: rhoG * i.vsg * i.vsg * mu * mu / (i.rhoL * sig * sig) };
      };
      const branches = {};
      [gIn({ vsl: 0.05, vsg: 150, accel: true }), gIn({ vsl: 0.02, vsg: 80, rhoG: 2, muL: 0.3, sigma: 60, accel: true, d: 1.995 }), gIn({ vsl: 0.05, vsg: 400, muL: 20, rhoG: 8, accel: true })].forEach((i, k) => {
        const g = C.dr.grad(i), m = mist(i, i.rhoG), lam = i.vsl / (i.vsl + i.vsg), rhoN = i.rhoL * lam + i.rhoG * (1 - lam);
        assert.strictEqual(g.region, 'III', 'case ' + k + ' in the mist region');
        assert.near(g.hl, lam, 1e-15, 'no slip'); assert.near(g.rhoS, rhoN, 1e-12);
        assert.rel(g.gradF, m.gF, 1e-6, 'mist friction case ' + k);
        assert.near(g.Ek, rhoN * (i.vsl + i.vsg) * i.vsg / (GC * i.p * 144), 1e-15, 'acceleration factor');
        assert.rel(g.grad, (g.gradEl + g.gradF) / (1 - g.Ek), 1e-12);
        branches[m.X <= 0.005 ? 'low' : 'high'] = true; branches[m.rd < 0.05 ? 'moody' : 'rough'] = true;
      });
      assert.ok(branches.low && branches.high && branches.moody, 'both Weber branches and the Moody branch covered: ' + Object.keys(branches));
      // the large-roughness law by hand (ε/d = 0.1)
      const rd = 0.1, fl = 4 * (1 / (16 * Math.pow(Math.log10(0.027), 2)) + 0.067 * Math.pow(rd, 1.73));
      assert.near(fl, 4 * (1 / Math.pow(4 * Math.log10(0.27 * rd), 2) + 0.067 * Math.pow(0.1, 1.73)), 1e-15, 'f = 4[1/(4 log(0.27 ε/d))² + 0.067 (ε/d)^1.73]');
      // continuity: N_gv ∝ v_sg, so the boundaries are found by scaling v_sg; gradients continuous across L_S and L_M
      const base = gIn({ vsl: 0.5, accel: true }), q0 = groups(Object.assign({}, base, { vsg: 1 }));
      const R0 = V.drRegion(q0.NLv, 1, q0.Nd);
      [['LS', R0.LS], ['LM', R0.LM]].forEach(([nm, Lb]) => {
        const vb = Lb / q0.Ngv, lo = C.dr.grad(Object.assign({}, base, { vsg: vb * (1 - 1e-9) })), hi = C.dr.grad(Object.assign({}, base, { vsg: vb * (1 + 1e-9) }));
        assert.ok(lo.region !== hi.region, nm + ' crossed (' + lo.region + ' → ' + hi.region + ')');
        assert.rel(hi.grad, lo.grad, 1e-6, nm + ': total gradient continuous'); assert.rel(hi.gradEl, lo.gradEl, 1e-6, nm + ': elevation continuous');
      });
      const mid = C.dr.grad(Object.assign({}, base, { vsg: 0.5 * (R0.LS + R0.LM) / q0.Ngv }));
      assert.strictEqual(mid.region, 'transition'); assert.near(mid.A, 0.5, 1e-9, 'A = (L_M − N_gv)/(L_M − L_S)');
      // I / II: a step in the slip law (documented discontinuity of the method; the system solver reports such jumps)
      const vI = R0.LB / q0.Ngv, a = C.dr.grad(Object.assign({}, base, { vsg: vI * (1 - 1e-9) })), b = C.dr.grad(Object.assign({}, base, { vsg: vI * (1 + 1e-9) }));
      assert.deepStrictEqual([a.region, b.region], ['I', 'II']);
      assert.ok(Math.abs(a.S - b.S) > 1e-3, 'slip number jumps at the I / II boundary (' + a.S + ' → ' + b.S + ')');
    },
  },
  {
    name: 'VD5 the ten Duns & Ros chart functions pinned: three readings per curve, log-linear between readings, constant beyond the ends',
    wp: WP,
    run(_a, assert, ctx) {
      const D = app(ctx).win.WTS_wp_vlp._drCharts;
      const pin = { F1: [1.00, 1.95, 0.90], F2: [0.24, 1.00, 0.30], F3: [0.80, 2.40, 3.80], F4: [25, 45, 58], F5: [0.22, 0.08, 0.12], F6: [0.80, 2.10, -0.60], F7: [0.14, 0.06, 0.025] };
      Object.keys(pin).forEach((k) => {
        assert.near(D.F(k, 0.001), pin[k][0], 1e-12, k + '(0.001)'); assert.near(D.F(k, 0.1), pin[k][1], 1e-12, k + '(0.1)'); assert.near(D.F(k, 10), pin[k][2], 1e-12, k + '(10)');
        assert.near(D.F(k, 1e-6), pin[k][0], 1e-12, k + ' constant below'); assert.near(D.F(k, 1e4), pin[k][2], 1e-12, k + ' constant above');
      });
      assert.near(D.F('F1', Math.pow(10, -1.5)), (1.35 + 1.95) / 2, 1e-12, 'log-linear midpoint');
      [[10, 2, 0.5], [40, 1.35, 0.88], [300, 1, 1.1]].forEach(([nd, l1, l2]) => { const L = D.L(nd); assert.near(L.L1, l1, 1e-12, 'L1(' + nd + ')'); assert.near(L.L2, l2, 1e-12, 'L2(' + nd + ')'); });
      [[0.001, 1], [0.1, 0.6], [10, 0.08]].forEach(([x, y]) => assert.near(D.f2(x), y, 1e-12, 'f2(' + x + ')'));
      // the table is exported (for the help / review) and monotone where the published figures are
      const T = plain(D.table);
      assert.ok(T.NL.length === 7 && T.Nd.length === 8 && T.f2x.length === 8, 'table shape');
      for (let i = 1; i < T.L1.length; i++) assert.ok(T.L1[i] <= T.L1[i - 1] && T.L2[i] >= T.L2[i - 1], 'L1 falls and L2 rises with N_d');
      for (let i = 1; i < T.f2y.length; i++) assert.ok(T.f2y[i] < T.f2y[i - 1], 'f2 falls');
    },
  },
  {
    name: 'VD6 Cullender-Smith closed form by hand (two half-lengths, then Simpson; q MMscf/d, d in, T °R), gasDry method switch, bottom-up inverse, point form = the differentiated integrand',
    wp: WP,
    run(_a, assert, ctx) {
      const G = app(ctx).win, V = G.WTS_wp_vlp, C = G.WTS_flowline_corr, F = gasF();
      const L = 9000, d = 2.441, tT = 90, tB = 210, Wx = vertW(L, d, tT, tB), q = 6000, p0 = 1500;
      const r = V.gasCS(F, Wx, q, { from: 'top', p0 });
      assert.ok(r.ok && r.corr === 'gasCS' && r.segments.length === 1, JSON.stringify(plain(r.errors || [])));
      // by hand
      const gas = { qo: 0, qw: 0, qg: q / 1000, api: 55, sgg: 0.65, sgw: 1.07, pvt: F.pvt }, sg = 0.65, qMM = q / 1000;
      const pz = (p, T) => p / ((T + 459.67) * G.WTS_flowline_props(gas, p, T).z);
      let F2 = 0, pOther = p0, pm, pb;
      for (let outer = 0; outer < 2; outer++) {
        const pr0 = G.WTS_flowline_props(gas, outer ? 0.5 * (p0 + pOther) : p0, (tT + tB) / 2);
        const f = colebrook(20.09 * sg * q / (d * pr0.mug), 0.0006 / d);
        F2 = 0.667 * f * qMM * qMM / Math.pow(d, 5);
        const I = (p, T) => { const x = pz(p, T); return x / (F2 + 0.001 * x * x * 1); };
        const K = 18.75 * sg * L, It = I(p0, tT), Tm = (tT + tB) / 2;
        pm = p0; for (let k = 0; k < 80; k++) pm = p0 + K / (It + I(pm, Tm));
        const Im = I(pm, Tm);
        pb = pm; for (let k = 0; k < 80; k++) pb = pm + K / (Im + I(pb, tB));
        for (let k = 0; k < 80; k++) pb = p0 + 6 * K / (It + 4 * Im + I(pb, tB));
        pOther = pb;
      }
      assert.near(r.pwf, pb, 1e-6, 'BHP by hand (Simpson)'); assert.near(r.segments[0].pMid, pm, 1e-6, 'mid-depth pressure');
      assert.near(r.segments[0].F2, F2, 1e-12 * F2, 'F² = 0.667·f·q²/d⁵');
      assert.ok(r.warnings.some((w) => w.code === 'PROVISIONAL'), 'provisional note');
      // the method switch of gasDry; the default stays the A1 average T and Z
      const viaDry = V.gasDry(F, Wx, q, { from: 'top', p0, method: 'cs' });
      assert.strictEqual(viaDry.pwf, r.pwf, 'gasDry({method:"cs"}) = gasCS'); assert.strictEqual(V.gasDry(F, Wx, q, { from: 'top', p0 }).corr, 'gasTZ', 'default unchanged');
      // bottom-up inverse, and a lost march at a rate the BHP cannot lift
      const u = V.gasCS(F, Wx, q, { from: 'bottom', p0: r.pwf });
      assert.ok(u.ok); assert.near(u.pEnd, p0, 0.05, 'bottom-up returns the wellhead pressure');
      const lost = V.gasCS(F, Wx, 60000, { from: 'bottom', p0: 600 });
      assert.ok(!lost.ok && lost.code === 'LOST' && lost.lost, 'lost: ' + lost.code);
      // the point form: dp/dL = 0.01875·γ·(p/TZ)·sin θ + 18.75·γ·F²·TZ/p from the marcher's own props
      const T = 150, p = 2000, pr = G.WTS_flowline_props(Object.assign({}, gas, { qg: 5 }), p, T), Ar = Math.PI * Math.pow(d / 12, 2) / 4;
      const vsg = pr.qG / Ar, g = C.gasCS.grad({ vsl: 0, vsg, d, rhoL: 50, rhoG: pr.rhoG, muL: 1, muG: pr.mug, sigma: 20, theta: 90, rough: 0.0006, p, props: pr });
      const x = p / ((T + 459.67) * pr.z), gam = pr.rhoG * 10.7316 / (28.9647 * x), qx = vsg * Ar * x * (519.67 / 14.696) * 86400 / 1e6;
      assert.near(gam, 0.65, 1e-6, 'γ recovered from the gas density');
      assert.rel(qx, 5 * (14.696 / 519.67) * (520 / 14.696) * (519.67 / 520), 0.01, 'standard rate recovered (MMscf/d, basis within 1 %)');
      const f = colebrook(20.09 * gam * qx * 1000 / (d * pr.mug), 0.0006 / d), F2p = 0.667 * f * qx * qx / Math.pow(d, 5);
      assert.rel(g.gradEl, 0.01875 * gam * x, 1e-9, 'hydrostatic term'); assert.rel(g.gradF, 18.75 * gam * F2p / x, 1e-6, 'friction term');
      assert.ok(g.Ek === 0 && g.hl === 0 && g.pattern === 'gas', 'gas phase, no kinetic term');
    },
  },
  {
    name: 'VD7 gas cross-checks: Cullender-Smith vs average T-Z closed forms (1 %), the marcher with gasCS / gasTZ / gray / bb / nsl / dr vs the Cullender-Smith closed form (1 %), vertical and deviated; zero rate vs the well-kill gas column (0.2 %)',
    wp: WP,
    run(_a, assert, ctx) {
      const G = app(ctx).win, V = G.WTS_wp_vlp, F = gasF();
      [vertW(10000, 2.441, 80, 230), devW(2.441, 40, 80, 230)].forEach((Wx, wi) => [1000, 5000, 12000].forEach((q) => {
        const cs = V.gasCS(F, Wx, q, { p0: 1200 }), tz = V.gasDry(F, Wx, q, { p0: 1200 });
        assert.ok(cs.ok && cs.pwf > 1200, 'closed form ' + wi + '/' + q);
        assert.rel(cs.pwf, tz.pwf, 0.01, 'Cullender-Smith vs average T-Z, well ' + wi + ' q ' + q);
        ['gasCS', 'gasTZ', 'gray', 'bb', 'nsl', 'dr'].forEach((k) => {
          const m = V.traverse(F, Wx, q, { p0: 1200, corr: k, accel: false });
          assert.ok(m.ok, k + ' march'); assert.rel(m.pEnd, cs.pwf, 0.01, k + ' well ' + wi + ' q ' + q);
        });
      }));
      // the marcher with gasCS is the same integral: much closer than 1 %
      const Wv = vertW(10000, 2.441, 80, 230), cs0 = V.gasCS(F, Wv, 8000, { p0: 1500 }), m0 = V.traverse(F, Wv, 8000, { p0: 1500, corr: 'gasCS', stepFt: 50 });
      assert.rel(m0.pEnd, cs0.pwf, 0.001, 'marcher (gasCS) vs closed form within 0.1 %');
      // zero rate: the static gas column of the well-kill engine (Z at the column average) within 0.2 %
      const Wi = vertW(10000, 2.441, 150, 150), z0 = V.gasDry(F, Wi, 0, { p0: 1500 }), c0 = V.gasCS(F, Wi, 0, { p0: 1500 });
      const gk = G.WTS_gradient_compute({ dir: 's2b', p: 1500 - PATM, tvd: 10000, gasLen: 10000, mixLen: 0, hl: 0, rho: 8.33, sg: 0.65, t: 150, z: z0.zAvg });
      assert.ok(gk.ok); assert.rel(c0.pwf - PATM, gk.pBot, 0.002, 'static gas column');
      // hydrostatic on TVD: the deviated well equals a vertical well of the same TVD at zero rate
      const Wd = devW(2.441, 40, 150, 150), Wt = vSegW(Wd.tvdTD, Wd.segments.length, 2.441, 150);
      assert.rel(V.gasCS(F, Wd, 0, { p0: 1500 }).pwf, V.gasCS(F, Wt, 0, { p0: 1500 }).pwf, 1e-4, 'static: TVD controls');
      assert.ok(V.gasCS(F, Wd, 8000, { p0: 1500 }).pwf > V.gasCS(F, Wt, 8000, { p0: 1500 }).pwf, 'flowing: the longer MD adds friction');
      // a wet gas: the liquids are ignored and the result says so
      const wet = V.gasCS(gasF({ cgr: 20, wgr: 2 }), Wv, 5000, { p0: 1500 });
      assert.ok(wet.ok && wet.warnings.some((w) => w.code === 'GAS_ONLY'), 'GAS_ONLY warning');
      const wm = V.traverse(gasF({ cgr: 20, wgr: 2 }), Wv, 5000, { p0: 1500, corr: 'gasCS' });
      assert.ok(wm.warnings.some((w) => w.code === 'GAS_ONLY'), 'marcher GAS_ONLY warning');
    },
  },
  {
    name: 'VD8 the system: Duns & Ros solves FIX.oilWell and the deviated gas well (provisional, vertical-only warning), gasCS refused for oil wells; direction agreement, step convergence, water column, comparison sets',
    wp: WP,
    run(_a, assert, ctx) {
      const G = app(ctx).win, SY = G.WTS_wp_system, V = G.WTS_wp_vlp, Mt = G.WTS_wp_match;
      const Mo = S.FIX.oilWell; Mo.system.corr.well = 'dr';
      const Ro = SY.solve(Mo);
      assert.ok(Ro.ok && Ro.op && Ro.op.q > 100 && Ro.corr.well === 'dr', 'oil solve: ' + JSON.stringify(plain(Ro.errors || [])));
      assert.ok(Ro.flags.some((f) => f.code === 'PROVISIONAL'), 'PROVISIONAL flag');
      assert.ok(Ro.traverse.profile.some((r) => r.pattern === 'bubble') && Ro.traverse.profile.some((r) => r.pattern === 'slug'), 'Duns & Ros patterns on the traverse');
      const Mg = S.FIX.gasWell; Mg.system.corr.well = 'dr';
      const Rg = SY.solve(Mg);
      assert.ok(Rg.ok, 'gas solve'); assert.ok((Rg.flags || []).concat(Rg.warnings || []).some((f) => f.code === 'VERTICAL_ONLY'), 'vertical-only warning on the S-shaped well');
      const Mx = S.FIX.oilWell; Mx.system.corr.well = 'gasCS';
      const Rx = SY.solve(Mx);
      assert.strictEqual(Rx.code, 'CORR_NOT_APPLICABLE'); assert.includes(Rx.errors[0], 'Cullender-Smith');
      const ck = G.WTS_wp_check(Mx);
      assert.ok(ck.items.some((x) => x.code === 'CORR_NOT_APPLICABLE' && x.sev === 'error'), 'check ✗');
      const Mgc = S.FIX.gasWell; Mgc.system.corr.well = 'gasCS';
      assert.ok(SY.solve(Mgc).ok, 'gasCS solves the gas well');
      // direction agreement and step convergence with Duns & Ros (oil vertical, gas deviated)
      [['oilWell', 900], ['gasWell', 7000]].forEach(([k, q]) => {
        const M = S.FIX[k], F = G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F }), W = G.WTS_wp_well.build(M.well, { res: M.res });
        const dn = V.traverse(F, W, q, { from: 'top', p0: 500, corr: 'dr' }), up = V.traverse(F, W, q, { from: 'bottom', p0: dn.pEnd, corr: 'dr' });
        assert.ok(dn.ok && up.ok); assert.near(up.pEnd, 500, 0.5, k + ' top-down then bottom-up');
        const p = [100, 25].map((s) => V.traverse(F, W, q, { from: 'top', p0: 500, corr: 'dr', stepFt: s }).pEnd);
        assert.near(p[0], p[1], 0.5, k + ' 100 ft vs 25 ft');
        // the Ros map of the operating traverse: every station classified, groups positive
        const mp = V.drMap(F, q, dn);
        assert.ok(mp.ok && mp.points.length === dn.profile.filter((r) => !r.restr).length && mp.NdRef > 0 && mp.boundaries.lines.bs.length === 41, k + ' map');
        assert.ok(mp.points.every((x) => x.NLv >= 0 && x.Ngv >= 0 && ['I', 'II', 'transition', 'III', 'single'].includes(x.region) && x.tvd <= x.md + 1e-6), 'stations with MD ≥ TVD');
      });
      // water column on the deviated gas-well path, hydrostatic on TVD (no flow)
      const Mw = S.FIX.gasWell; Mw.fluid.type = 'water'; Mw.fluid.cgr = 0; Mw.fluid.wgr = 0;
      const Fw = G.WTS_wp_fluid.build(Mw.fluid, { T_F: Mw.res.T_F }), Ww = G.WTS_wp_well.build(Mw.well, { res: Mw.res });
      const tw = V.traverse(Fw, Ww, 1e-6, { from: 'top', p0: 100, corr: 'dr' }), tb = V.traverse(Fw, Ww, 1e-6, { from: 'top', p0: 100, corr: 'bb' });
      assert.rel(tw.pEnd, tb.pEnd, 1e-6, 'water column = Beggs & Brill water column (both hydrostatic on TVD)');
      // the comparison sets (§5.2): oil wells take dr, gas wells take dr and gasCS
      const co = Mt.compare(S.FIX.oilWell, S.FIX.test1), kk = plain(co.rows.map((r) => r.corr));
      assert.ok(kk.includes('dr') && !kk.includes('gasCS'), 'oil set: ' + kk);
      const cg = Mt.compare(S.FIX.gasWell, { id: 'G1', q_g: 6000, thp_psig: 2300, tht_F: 140, bean64: 24, gaugeMd: 9800, gauge_psia: 3900 });
      const gk = plain(cg.rows.map((r) => r.corr));
      assert.ok(gk.includes('dr') && gk.includes('gasCS'), 'gas set: ' + gk);
      cg.rows.filter((r) => r.corr === 'dr' || r.corr === 'gasCS').forEach((r) => assert.strictEqual(r.provisional, PROV, r.corr + ' labelled'));
    },
  },
  {
    name: 'VD9 page: Correlations tab (a traverse per correlation from the solved THP, the selected one = the solve, BHP / Δ / provisional chips, closed forms for gas), Use switches the correlation; gasCS disabled for oil; report and snapshot',
    wp: WP,
    run(_a, assert, ctx) {
      const A = app(ctx), G = A.win, txt = (e) => String(e && e.textContent || '').replace(/\s+/g, ' ').trim(), BAD = /NaN|undefined|Infinity|\[object Object\]/;
      S.resetWellPerf(A);
      A.hook.nav('wellperf'); A.flush(30);
      A.click(A.find('[data-act="example"][data-ex="oil"]')); A.flush(30);
      // the gas-only methods are not offered for an oil well
      const opts = Array.from(A.el('wp_corr_well').options);
      ['dr', 'gasCS'].forEach((k) => assert.ok(opts.some((o) => o.value === k), k + ' offered'));
      assert.ok(opts.filter((o) => o.value === 'gasCS')[0].disabled && !opts.filter((o) => o.value === 'dr')[0].disabled, 'gasCS disabled, dr enabled for oil');
      assert.match(txt(opts.filter((o) => o.value === 'dr')[0]), /Duns & Ros.*provisional/);
      A.click(A.find('#wp_trtabs [data-tab="corr"]')); A.flush(5);
      const R = G.WTS_state.wellperf, st = G.WTS_wellperf_page.state(), C = st.cmp;
      assert.ok(C && C.rows.length >= 4, 'comparison computed');
      const sel = C.rows.filter((r) => r.sel)[0];
      assert.strictEqual(sel.key, 'bb'); assert.strictEqual(sel.pwf, R.traverse.pEnd, 'the selected row is the solve itself');
      const dr = C.rows.filter((r) => r.key === 'dr')[0];
      assert.ok(dr && dr.pwf > 0 && !dr.verified && Math.abs(dr.dp - (dr.pwf - sel.pwf)) < 1e-9, 'Duns & Ros row');
      // the same evaluation as the system engine (same THP, same fluid table)
      const Mc = JSON.parse(JSON.stringify(st.M)); Mc.system.corr.well = 'dr'; Mc.system.node = 'bottom';
      assert.strictEqual(G.WTS_wp_system.evalAt(Mc, R.op.q).tr.pEnd, dr.pwf, 'evalAt at the operating rate');
      const cv = A.el('wp_cv_tr'), sp = cv._wp.spec;
      assert.ok(sp.series.length === C.rows.length && sp.series.every((s) => s.pts.length > 10), 'a traverse per correlation');
      assert.ok(sp.y.invert && /TVD/.test(sp.y.label) && sp.readout === 'y', 'depth axis');
      assert.ok(sp.series.filter((s) => s.key === 'c_bb')[0].width > sp.series.filter((s) => s.key === 'c_dr')[0].width, 'the selected correlation drawn thicker');
      assert.deepStrictEqual(plain(sp.series.filter((s) => s.key === 'c_dr')[0].dash), [6, 3], 'provisional dashed');
      A.click(A.find('#wp_depthseg [data-depth="md"]')); A.flush(2);
      assert.match(A.el('wp_cv_tr')._wp.spec.y.label, /MD/, 'MD toggle');
      const t = txt(A.el('wp_corrtbl'));
      assert.match(t, /BHP spread \(multiphase\)/); assert.match(t, /Duns & Ros/); assert.match(t, /Gravity \/ friction/);
      assert.ok(A.findAll('#wp_corrtbl .wp-chip.prov').length >= 3, 'provisional chips');
      assert.ok(!BAD.test(t), 'clean: ' + (t.match(BAD) || [''])[0]);
      // report: the comparison table is inside the compact block; the Use buttons are .rp-skip
      const m = JSON.stringify(G.collectPageReport(A.el('pgBody'), { charts: false }));
      assert.ok(/Duns &(amp;)? Ros/.test(m) && /BHP spread/.test(m), 'comparison captured by the report');
      assert.ok(A.findAll('#wp_corrtbl .rp-skip [data-act="usecorr"]').length >= 3, 'Use buttons skipped in reports');
      A.change('wp_psep', '110'); A.flush(1200);
      const snaps = JSON.parse(A.storage.getItem('wts_report_snapshots') || '{}');
      assert.ok(snaps.wellperf && JSON.stringify(snaps.wellperf).length <= 60 * 1024, 'snapshot ≤ 60 kB with the Correlations tab open');
      // Use → the normal input path (control, autosave, one solve)
      A.click(A.find('#wp_trtabs [data-tab="corr"]')); A.flush(2);
      const n0 = G.WTS_wellperf_page.calcs();
      A.click(A.find('[data-act="usecorr"][data-v="dr"]')); A.flush(30);
      assert.strictEqual(A.el('wp_corr_well').value, 'dr'); assert.strictEqual(G.WTS_wellperf_page.state().M.system.corr.well, 'dr', 'model reads dr');
      assert.ok(G.WTS_wellperf_page.calcs() > n0 && G.WTS_state.wellperf.ok, 'solved again');
      assert.strictEqual(G.WTS_wellperf_page.state().cmp.sel, 'dr', 'the table follows the selection');
      // gas example: closed forms and their agreement chip
      A.click(A.find('[data-act="example"][data-ex="gas"]')); A.flush(30);
      A.click(A.find('#wp_trtabs [data-tab="corr"]')); A.flush(5);
      const Cg = G.WTS_wellperf_page.state().cmp;
      assert.ok(Cg.cf && Cg.cf.tz && Cg.cf.cs && Math.abs(Cg.cf.cs.pwf / Cg.cf.tz.pwf - 1) < 0.01, 'closed forms agree within 1 %');
      assert.ok(Cg.rows.some((r) => r.key === 'gasCS') && Cg.rows.some((r) => r.key === 'dr'), 'gas set');
      assert.match(txt(A.el('wp_corrtbl')), /Cullender-Smith \(closed form\)/);
      assert.ok(A.el('wp_cv_tr')._wp.spec.series.some((s) => s.key === 'cf_cs' && s.kind === 'points'), 'closed-form points on the plot');
      assert.ok(!Array.from(A.el('wp_corr_well').options).filter((o) => o.value === 'gasCS')[0].disabled, 'gasCS enabled for a gas well');
      assert.strictEqual(A.consoleErrors().length, 0, 'no console errors');
      S.resetWellPerf(A);
    },
  },
  {
    name: 'VD10 page: operating point per correlation (a Job) → diamonds on the system plot and the table; Flow-regime map tab (log axes, boundaries, the path per region with MD / TVD read-outs, station counts)',
    wp: WP,
    async run(_a, assert, ctx) {
      const A = app(ctx), G = A.win, txt = (e) => String(e && e.textContent || '').replace(/\s+/g, ' ').trim();
      S.resetWellPerf(A);
      A.hook.nav('wellperf'); A.flush(30);
      A.click(A.find('[data-act="example"][data-ex="oil"]')); A.flush(30);
      A.click(A.find('#wp_trtabs [data-tab="corr"]')); A.flush(5);
      A.click(A.find('[data-act="corrop"]'));
      await A.flushAsync(3000);
      const st = G.WTS_wellperf_page.state(), O = st.cmpOp;
      assert.ok(O && O.ops && O.key === st.cmp.key, 'operating points stored');
      assert.ok(O.ops.bb.q === G.WTS_state.wellperf.op.q, 'the selected correlation = the solve');
      assert.ok(O.ops.dr && O.ops.dr.ok && O.ops.dr.q > 0 && O.ops.hb.ok, 'Duns & Ros and Hagedorn & Brown operating points');
      // the tracking result equals a full solve with that correlation (stable root)
      const Mc = JSON.parse(JSON.stringify(st.M)); Mc.system.corr.well = 'dr';
      assert.rel(O.ops.dr.q, G.WTS_wp_system.solve(Mc).op.q, 0.002, 'tracking = full solve');
      const mk = A.el('wp_cv_sys')._wp.spec.markers.filter((m) => m.kind === 'diamond');
      assert.strictEqual(mk.length, st.cmp.rows.length - 1, 'a diamond per other correlation');
      assert.match(txt(A.el('wp_corrtbl')), /Re-run the operating point/);
      // the Ros flow-regime map
      A.click(A.find('#wp_trtabs [data-tab="map"]')); A.flush(5);
      const sp = A.el('wp_cv_tr')._wp.spec;
      assert.ok(sp.x.log && sp.y.log && sp.readout === 'near', 'log-log map with the nearest-station read-out');
      assert.deepStrictEqual(plain(sp.series.slice(0, 3).map((s) => s.key)), ['b1', 'b2', 'b3'], 'three boundary lines');
      const runs = sp.series.filter((s) => Array.isArray(s.info));
      assert.ok(runs.length >= 1 && runs.every((s) => s.info.length === s.pts.length), 'the traverse path with a read-out per station');
      assert.match(String(runs[0].info[1][0]), /ft MD · [\d,]+ ft TVD/, 'station read-out on MD and TVD: ' + runs[0].info[1][0]);
      assert.ok(sp.markers.some((m) => m.label === 'Wellhead') && sp.markers.some((m) => /^Bottom /.test(m.label || '')), 'wellhead and bottom markers');
      const t = txt(A.el('wp_corrtbl'));
      assert.match(t, /Region I — bubble/); assert.match(t, /N_d = [\d.]+/); assert.match(t, /provisional/);
      assert.ok(!A.find('#wp_depthseg') || A.find('#wp_depthseg').classList.contains('wp-off'), 'no depth toggle on the map');
      // the near read-out of the plotter: the nearest point of a series with info
      const V = G.WTS_wp_view, cv = A.el('wp_cv_tr');
      assert.fn(V.chart);
      const ax = cv._wpAxes, p0 = runs[0].pts[0];
      cv._wp.hover = { x: ax.toX(p0[0]) + 2, y: ax.toY(p0[1]) + 1 };
      V.redraw(cv);
      assert.ok(A.canvasTexts(cv).some((s) => /ft MD/.test(s)), 'hover shows the station');
      A.click(A.find('#wp_trtabs [data-tab="traverse"]')); A.flush(2);
      assert.strictEqual(A.el('wp_corrtbl').innerHTML, '', 'table cleared on the other tabs');
      assert.strictEqual(A.consoleErrors().length, 0, 'no console errors');
      S.resetWellPerf(A);
    },
  },
];
