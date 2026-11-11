// Well Performance vertical lift correlations — docs/WELL-PERFORMANCE-PLAN.md §4.4, §4.5, §15.1–§15.3, §17.1 (WP3, 16 tests).
//
// VL1 registry + D17 gate (provisional labels, Beggs & Brill default while unverified, stubs dropped)
// VL2 every correlation returns SHAPE.G and grad = (gradEl + gradF)/(1 − Ek)
// VL3 hydrostatic limit at a point, any inclination, every correlation
// VL4 hydrostatic limit along a deviated well (water column on TVD), every correlation
// VL5 single phase at rate: Darcy-Weisbach + Colebrook by hand within 0.1 %
// VL6 Hagedorn & Brown: Griffith bubble limit with known numbers (d in FT) and bubble holdup by hand
// VL7 Hagedorn & Brown: holdup ≥ no-slip on a grid; three pinned readings per chart fit
// VL8 Gray: holdup limits, a hand calculation, effective roughness branches
// VL9 Gray: both liquid-ratio ranges, velocity and diameter range warnings
// VL10 gas cross-check: closed-form average T-Z vs the marcher (gasTZ, gray, hb, nsl gas only) within 1 %; zero rate vs the
//      well-kill gas column within 0.2 %
// VL11 average T-Z: the equation by hand (units), s → 0 limit, bottom-up inverse
// VL12 direction agreement: top-down vs bottom-up within 0.5 psi (oil HB, gas Gray, deviated)
// VL13 step convergence (WC1): halving to < 0.1 psi; the 100 ft default within 0.5 psi
// VL14 deviation: MD / TVD / inclination profile, hydrostatic on TVD, friction on MD, vertical-only warning above 30°
// VL15 unknown key; Beggs & Brill through the engine = the marcher bit for bit; curve / family / frozen grid smoothness;
//      multipliers; restrictions
// VL16 published-example gate (Q9: no books): regression pins on the fixtures, labelled provisional, and timing report
'use strict';

const S = require('./_wellperf-shapes');

const WP = 'WP3';
const PATM = 14.696;
const plain = (x) => JSON.parse(JSON.stringify(x));
const app = (ctx) => S.sharedApp(ctx);
const KEYS = ['hb', 'gray', 'nsl', 'single', 'gasTZ'];

// fluids as WTS_wp_fluid.build returns them (the fields the VLP reads; WP1's flowlineFluid accepts the same object)
const oilF = (o) => Object.assign({ ok: true, type: 'oil', rateBasis: 'liquid', api: 35, sgg: 0.65, sgw: 1.07, gor: 500, wc: 0.3, cgr: 0, wgr: 0, refQ: 1000, pvt: {} }, o || {});
const gasF = (o) => Object.assign({ ok: true, type: 'gas', rateBasis: 'gas', api: 55, sgg: 0.65, sgw: 1.07, gor: 0, wc: 0, cgr: 0, wgr: 0, refQ: 1000, pvt: { liquidNoTransfer: true, bc: 1 } }, o || {});
const watF = (o) => Object.assign({ ok: true, type: 'water', rateBasis: 'water', api: 35, sgg: 0.65, sgw: 1.0, gor: 0, wc: 0, cgr: 0, wgr: 0, refQ: 1000, pvt: { liquidNoTransfer: true, bc: 1 } }, o || {});

// a well path as WTS_wp_well.build returns it (segments in flow order, bottom → top)
function vertW(L, id, tTop, tBot, extra) {
  return Object.assign({ segments: [{ name: 'Tubing', len: L, id: id, dz: L, md0: L, md1: 0, tvd0: L, tvd1: 0, inc: 0, rough: 0.0006 }],
    tAt: (md) => tTop + (tBot - tTop) * md / L }, extra || {});
}
// vertical to KOP, a straight slant at inc°, vertical again: TVD closed form; split into ≤ 500 ft pieces
function devW(id, inc, tTop, tBot) {
  const kop = 2000, slant = 4000, tail = 3000, c = Math.cos(inc * Math.PI / 180);
  const legs = [[0, kop, 0], [kop, kop + slant, inc], [kop + slant, kop + slant + tail, 0]];
  const segs = []; let tvd = 0;
  legs.forEach(([a, b, i]) => {
    for (let m = a; m < b; m += 500) {
      const len = Math.min(500, b - m), dz = len * Math.cos(i * Math.PI / 180);
      segs.push({ name: 'Tubing', len, id, dz, md0: m + len, md1: m, tvd0: tvd + dz, tvd1: tvd, inc: i, rough: 0.0006 });
      tvd += dz;
    }
  });
  const mdTD = kop + slant + tail, tvdTD = kop + slant * c + tail;
  return { segments: segs.reverse(), tAt: (md) => tTop + (tBot - tTop) * md / mdTD, mdTD, tvdTD };
}
function gIn(o) { return Object.assign({ vsl: 2, vsg: 6, d: 2.441, rhoL: 50, rhoG: 5, muL: 2, muG: 0.015, sigma: 25, theta: 90, rough: 0.0006, p: 1500, payne: true, accel: false }, o || {}); }
function colebrook(nre, e) {   // independent Colebrook for the hand checks
  let x = -2 * Math.log10(e / 3.7 + 5.74 / Math.pow(nre, 0.9));
  for (let k = 0; k < 100; k++) x = -2 * Math.log10(e / 3.7 + 2.51 * x / nre);
  return 1 / (x * x);
}

module.exports = [
  {
    name: 'VL1 registry: hb, gray, nsl, single, gasTZ registered (merge, bb kept), provisional under the D17 gate, Beggs & Brill is the default while unverified; WP3 stubs dropped',
    wp: WP,
    run(_a, assert, ctx) {
      const W = app(ctx).win, C = W.WTS_flowline_corr, V = W.WTS_wp_vlp;
      assert.ok(C.bb && C.bb.verified === true && typeof C.bb.grad === 'function', 'bb kept');
      KEYS.forEach((k) => {
        const e = C[k];
        assert.ok(e && e.key === k && typeof e.grad === 'function' && typeof e.label === 'string' && e.range && typeof e.kind === 'string', k + ' entry');
        assert.strictEqual(e.verified, false, k + ' is not verified against a published example (Q9)');
        assert.strictEqual(e.provisional, V.PROVISIONAL);
      });
      assert.ok(C.hb.vertical && C.gray.vertical && !C.nsl.vertical && !C.single.vertical, 'vertical-only flags');
      assert.strictEqual(V.PROVISIONAL, 'provisional — not verified against a published example');
      [['oil', 'hb'], ['gas', 'gray'], ['condensate', 'gray'], ['water', 'single'], ['gasinj', 'gasTZ']].forEach(([t, pref]) => {
        const d = plain(V.defaultCorr(t));
        assert.deepStrictEqual([d.key, d.preferred, d.provisional], ['bb', pref, true], t + ': ' + JSON.stringify(d));
        assert.includes(d.reason, 'provisional');
      });
      assert.strictEqual(V.defaultCorr(oilF()).preferred, 'hb', 'accepts F');
      const L = plain(V.list('well')).map((e) => e.key);
      assert.ok(L.includes('hb') && L.includes('bb') && L.includes('nsl') && !L.includes('gray'), 'list(kind): ' + L);
      const stubs = plain(W.__WP_STUBS || []);
      S.STUBS.WP3.forEach((n) => assert.ok(stubs.indexOf(n) === -1, n + ' no longer a stub'));
      ['traverse', 'curve', 'family', 'gasDry', 'singlePhase'].forEach((f) => assert.fn(V[f]));
    },
  },
  {
    name: 'VL2 every correlation returns the Beggs & Brill result shape (SHAPE.G) and grad = (gradEl + gradF)/(1 − Ek) with acceleration on',
    wp: WP,
    run(_a, assert, ctx) {
      const C = app(ctx).win.WTS_flowline_corr;
      KEYS.concat(['bb']).forEach((k) => {
        [gIn(), gIn({ accel: true, p: 300, vsg: 30 }), gIn({ theta: 30 }), gIn({ vsl: 0.2, vsg: 40, rhoL: 45, sigma: 20 })].forEach((inp, i) => {
          const g = plain(C[k].grad(inp));
          const r = S.checkShape('G', g);
          assert.ok(r.ok, k + '#' + i + ': ' + r.errors.join('; '));
          assert.rel(g.grad, (g.gradEl + g.gradF) / (1 - g.Ek), 1e-12, k + '#' + i + ' grad');
          assert.ok(g.hl >= g.lambdaL - 1e-12 && g.hl <= 1, k + '#' + i + ' λL ≤ HL ≤ 1');
          assert.ok(g.rhoN > 0 && g.gradF >= 0, k + '#' + i + ' ρn, friction ≥ 0');
        });
      });
    },
  },
  {
    name: 'VL3 hydrostatic limit at a point: creeping liquid gives gradEl = ρL·sin θ/144 and no friction, every correlation and inclination (gasTZ: the gas column)',
    wp: WP,
    run(_a, assert, ctx) {
      const C = app(ctx).win.WTS_flowline_corr;
      [90, 60, 20, 0].forEach((th) => {
        ['hb', 'gray', 'nsl', 'single'].forEach((k) => {
          const g = C[k].grad(gIn({ vsl: 1e-7, vsg: 0, rhoL: 62.4, theta: th }));
          assert.near(g.gradEl, 62.4 * Math.sin(th * Math.PI / 180) / 144, 1e-12, k + ' θ ' + th);
          assert.ok(g.gradF < 1e-10 && g.hl === 1, k + ' θ ' + th + ' friction ' + g.gradF);
        });
        const gg = C.gasTZ.grad(gIn({ vsl: 0, vsg: 1e-7, rhoG: 4.2, theta: th }));
        assert.near(gg.gradEl, 4.2 * Math.sin(th * Math.PI / 180) / 144, 1e-12, 'gasTZ θ ' + th);
      });
    },
  },
  {
    name: 'VL4 hydrostatic limit along a deviated well: a creeping water column equals p_top + ∫ρw/144 dTVD within 0.01 % (every liquid correlation) and 0.433·SG·TVD within 1 %',
    wp: WP,
    run(_a, assert, ctx) {
      const W = app(ctx).win, V = W.WTS_wp_vlp, Wd = devW(2.441, 50, 80, 80), F = watF();
      // independent integral on TVD with the same water density (WTS_flowline_props), 2,000 RK2 steps
      const ff = { qo: 0, qw: 1e-6, qg: 0, api: 35, sgg: 0.65, sgw: 1.0, pvt: F.pvt };
      let p = 500, n = 2000, h = Wd.tvdTD / n;
      for (let i = 0; i < n; i++) { const g1 = W.WTS_flowline_props(ff, p, 80).rhoL / 144, g2 = W.WTS_flowline_props(ff, p + g1 * h / 2, 80).rhoL / 144; p += g2 * h; }
      ['hb', 'gray', 'nsl', 'single', 'bb'].forEach((k) => {
        const r = V.traverse(F, Wd, 1e-6, { p0: 500, corr: k, accel: false });
        assert.ok(r.ok, k + ' ok');
        assert.rel(r.pEnd - 500, p - 500, 1e-4, k + ' Δp on TVD');
        assert.rel(r.pEnd - 500, 0.4331 * Wd.tvdTD, 0.01, k + ' 0.433·SG·TVD');
        assert.near(r.profile[r.profile.length - 1].tvd, Wd.tvdTD, 1e-6, k + ' TVD at TD');
      });
    },
  },
  {
    name: 'VL5 single phase at rate: water 5,000 BWPD in 2.441 in, Δp = hydrostatic + Darcy-Weisbach (Colebrook) by hand within 0.1 % (single, nsl, hb, gray)',
    wp: WP,
    run(_a, assert, ctx) {
      const W = app(ctx).win, V = W.WTS_wp_vlp, F = watF(), Wv = vertW(6000, 2.441, 100, 100);
      const q = 5000, ff = { qo: 0, qw: q, qg: 0, api: 35, sgg: 0.65, sgw: 1.0, pvt: F.pvt };
      const pr = W.WTS_flowline_props(ff, 1800, 100);   // properties near the mid pressure (weakly pressure dependent)
      const A = Math.PI * Math.pow(2.441 / 12, 2) / 4, v = pr.qL / A, dFt = 2.441 / 12;
      const nre = 1488 * pr.rhoL * v * dFt / pr.muL, f = colebrook(nre, 0.0006 / 2.441);
      const dpHand = 6000 * (pr.rhoL / 144 + f * pr.rhoL * v * v / (2 * 32.174 * dFt) / 144);
      ['single', 'nsl', 'hb', 'gray'].forEach((k) => {
        const r = V.traverse(F, Wv, q, { p0: 300, corr: k, accel: false });
        assert.rel(r.pEnd - 300, dpHand, 1e-3, k + ' Δp vs hand (f ' + f.toFixed(5) + ', Re ' + nre.toFixed(0) + ')');
      });
      const sp = V.singlePhase(F, Wv, q, { p0: 300 });
      assert.ok(sp.ok && sp.pEnd > 300 && Array.isArray(sp.profile), 'singlePhase');
      // Colebrook reused from the flowline file (no duplicate friction code)
      assert.rel(W.WTS_flowline_friction.colebrook(1e5, 0), colebrook(1e5, 0), 1e-9, 'same Colebrook');
      assert.rel(colebrook(1e5, 0), 0.01799, 0.002, 'smooth pipe Re 1e5: f ≈ 0.0180 (Moody)');
    },
  },
  {
    name: 'VL6 Hagedorn & Brown: Griffith bubble limit L_B = 1.071 − 0.2218·v_m²/d with d in FT (≥ 0.13), bubble / non-bubble switch and the bubble holdup by hand',
    wp: WP,
    run(_a, assert, ctx) {
      const W = app(ctx).win, V = W.WTS_wp_vlp, C = W.WTS_flowline_corr;
      assert.near(V.hbBubbleLimit(1, 0.5), 1.071 - 0.2218 / 0.5, 1e-12, 'vm 1 ft/s, d 0.5 ft → 0.6274');
      assert.near(V.hbBubbleLimit(3, 2.441 / 12), 0.13, 1e-12, 'floor 0.13');
      assert.near(V.hbBubbleLimit(2, 1), 1.071 - 0.8872, 1e-12, 'vm 2, d 1 ft → 0.1838');
      // d = 6 in = 0.5 ft, v_m = 1 ft/s: L_B = 0.6274. (With d wrongly in inches L_B would be 1.034 and λg = 0.7 would be bubble.)
      const b = C.hb.grad(gIn({ d: 6, vsl: 0.5, vsg: 0.5, rhoL: 55, rhoG: 6 }));
      assert.strictEqual(b.pattern, 'bubble', 'λg 0.5 < 0.6274');
      assert.near(b.LB, 0.6274, 1e-12);
      const nb = C.hb.grad(gIn({ d: 6, vsl: 0.3, vsg: 0.7, rhoL: 55, rhoG: 6 }));
      assert.strictEqual(nb.pattern, 'slug', 'λg 0.7 > 0.6274');
      // Griffith holdup: H_L = 1 − ½[1 + v_m/v_s − √((1 + v_m/v_s)² − 4 v_sg/v_s)], v_s = 0.8 ft/s
      const a = 1 + 1 / 0.8, hl = 1 - 0.5 * (a - Math.sqrt(a * a - 4 * 0.5 / 0.8));
      assert.near(b.hl, hl, 1e-12, 'bubble holdup');
      // bubble friction on the in-situ liquid velocity v_L = v_sl/H_L, N_Re = 1488 ρL vL d/μL
      const vL = 0.5 / hl, nre = 1488 * 55 * vL * 0.5 / 2, f = colebrook(nre, 0.0006 / 6);
      assert.rel(b.gradF, f * 55 * vL * vL / (2 * 32.174 * 0.5) / 144, 1e-6, 'bubble friction');
      assert.rel(b.gradEl, (55 * hl + 6 * (1 - hl)) / 144, 1e-12, 'elevation on ρs');
    },
  },
  {
    name: 'VL7 Hagedorn & Brown: holdup ≥ no-slip over a grid (rates, sizes, pressures); chart fits pinned at three readings each (fit values, Q9) and their limits',
    wp: WP,
    run(_a, assert, ctx) {
      const W = app(ctx).win, V = W.WTS_wp_vlp, C = W.WTS_flowline_corr, K = V._charts;
      let n = 0;
      [0.05, 0.5, 2, 8].forEach((vsl) => [0.1, 1, 5, 20, 60].forEach((vsg) => [1.995, 2.441, 3.958].forEach((d) => [200, 1500, 4000].forEach((p) => {
        const g = C.hb.grad(gIn({ vsl, vsg, d, p, rhoL: 50, rhoG: p / 300 }));
        assert.ok(g.hl >= g.lambdaL - 1e-15 && g.hl <= 1, 'HL ≥ λL at ' + [vsl, vsg, d, p]);
        n++;
      }))));
      assert.strictEqual(n, 180);
      // the published chart fits (Economides et al. / Guo et al. polynomial forms) — pinned to their own values
      const pins = { cnl: [[0.001, 0.0019510130], [0.1, 0.0056518413], [0.5, 0.012176235]], hlPsi: [[1e-5, 0.12582254], [1e-4, 0.33363236], [1e-3, 0.81169726]],
        psi: [[0.02, 1.1044685], [0.05, 1.6957122], [0.08, 1.7990567]] };
      Object.keys(pins).forEach((k) => pins[k].forEach(([x, y]) => assert.rel(K[k](x), y, 2e-6, k + '(' + x + ')')));
      assert.near(K.cnl(0), 0.0019, 1e-12, 'CN_L → 0.0019');
      assert.strictEqual(K.psi(0.005), 1, 'ψ = 1 below X2 0.01');
      assert.ok(K.hlPsi(1) <= 1 && K.hlPsi(1) > 0.99, 'H_L/ψ → 1');
      for (let x = 1e-6; x < 1; x *= 3) assert.ok(K.hlPsi(x * 3) >= K.hlPsi(x) - 1e-12, 'H_L/ψ monotone');
    },
  },
  {
    name: 'VL8 Gray: holdup → 1 at low N_v and → λL at high N_v; one point by hand; pseudo roughness for R ≥ 0.007, R < 0.007 and the 2.77e-5 ft floor',
    wp: WP,
    run(_a, assert, ctx) {
      const C = app(ctx).win.WTS_flowline_corr;
      const lo = C.gray.grad(gIn({ vsl: 1e-9, vsg: 1e-8, rhoL: 50, rhoG: 5 })), hi = C.gray.grad(gIn({ vsl: 2, vsg: 400 }));
      assert.ok(lo.hl > 0.95, 'low velocity: HL → 1 (' + lo.hl + ')');
      assert.rel(hi.hl, hi.lambdaL, 0.02, 'high velocity: HL → λL');
      // hand calculation at vsl 0.3, vsg 15 ft/s, d 2.441 in, ρL 48, ρg 6, σ 20 dyn/cm
      const i = gIn({ vsl: 0.3, vsg: 15, rhoL: 48, rhoG: 6, sigma: 20 }), g = C.gray.grad(i);
      const sig = 20 * 0.00220462, vm = 15.3, lam = 0.3 / 15.3, rn = 48 * lam + 6 * (1 - lam), dFt = 2.441 / 12, R = 0.3 / 15;
      const Nv = rn * rn * Math.pow(vm, 4) / (32.174 * sig * 42), ND = 32.174 * 42 * dFt * dFt / sig;
      const B = 0.0814 * (1 - 0.0554 * Math.log(1 + 730 * R / (R + 1))), A = -2.314 * Math.pow(Nv * (1 + 205 / ND), B);
      const hl = 1 - (1 - lam) * (1 - Math.exp(A));
      assert.rel(g.hl, hl, 1e-12, 'HL');
      const e2 = 28.5 * sig / (rn * vm * vm), f = colebrook(1e7, Math.max(e2, 2.77e-5) / dFt);
      assert.rel(g.epsEff, Math.max(e2, 2.77e-5), 1e-12, 'ε′ (R ≥ 0.007)');
      assert.rel(g.gradF, f * rn * vm * vm / (2 * 32.174 * dFt) / 144, 1e-6, 'friction at Re 1e7');
      // R < 0.007: interpolated between the pipe roughness and ε″
      const j = gIn({ vsl: 0.05, vsg: 15, rhoL: 48, rhoG: 6, sigma: 20 }), g2 = C.gray.grad(j);
      const R2 = 0.05 / 15, lam2 = 0.05 / 15.05, rn2 = 48 * lam2 + 6 * (1 - lam2), e22 = 28.5 * sig / (rn2 * 15.05 * 15.05);
      const eps = 0.0006 / 12 + R2 * (e22 - 0.0006 / 12) / 0.007;
      assert.rel(g2.epsEff, Math.max(eps, 2.77e-5), 1e-9, 'ε′ (R < 0.007)');
      const g3 = C.gray.grad(gIn({ vsl: 0.001, vsg: 80, rhoL: 48, rhoG: 6, sigma: 2, rough: 0 }));
      assert.near(g3.epsEff, 2.77e-5, 1e-15, 'floor');
    },
  },
  {
    name: 'VL9 Gray ranges: condensate ≤ 50 and water ≤ 5 bbl/MMscf checked separately, v_m < 50 ft/s and d ≤ 3.5 in warned; in range → no range warning',
    wp: WP,
    run(_a, assert, ctx) {
      const V = app(ctx).win.WTS_wp_vlp, Wv = vertW(8000, 2.441, 100, 200);
      const codes = (F, q, Wx) => plain(V.traverse(F, Wx || Wv, q, { p0: 1500, corr: 'gray' }).warnings).map((w) => w.code);
      let c = codes(gasF({ cgr: 20, wgr: 2 }), 3000);
      assert.ok(!c.some((x) => /^RANGE_/.test(x)), 'in range: ' + c);
      assert.ok(c.includes('PROVISIONAL'), 'provisional label');
      c = codes(gasF({ cgr: 60, wgr: 2 }), 3000); assert.ok(c.includes('RANGE_CGR') && !c.includes('RANGE_WGR'), 'CGR: ' + c);
      c = codes(gasF({ cgr: 20, wgr: 8 }), 3000); assert.ok(c.includes('RANGE_WGR') && !c.includes('RANGE_CGR'), 'WGR: ' + c);
      c = codes(gasF({ cgr: 60, wgr: 8 }), 3000); assert.ok(c.includes('RANGE_WGR') && c.includes('RANGE_CGR'), 'both: ' + c);
      c = codes(gasF(), 3000, vertW(8000, 3.958, 100, 200)); assert.ok(c.includes('RANGE_D'), 'd > 3.5 in: ' + c);
      const r = V.traverse(gasF(), vertW(8000, 1.995, 100, 200), 9000, { p0: 600, corr: 'gray' });
      assert.ok(r.vmMax > 50 && plain(r.warnings).some((w) => w.code === 'RANGE_VM'), 'v_m > 50 ft/s: ' + r.vmMax);
    },
  },
  {
    name: 'VL10 gas cross-check: the closed-form average T-Z BHP vs the marcher with gasTZ, gray, hb and nsl (dry gas) within 1 %, vertical and deviated; zero rate vs the well-kill gas column within 0.2 %',
    wp: WP,
    run(_a, assert, ctx) {
      const W = app(ctx).win, V = W.WTS_wp_vlp, F = gasF();
      [vertW(10000, 2.441, 80, 230), devW(2.441, 40, 80, 230)].forEach((Wx, wi) => [1000, 5000, 12000].forEach((q) => {
        const cf = V.gasDry(F, Wx, q, { p0: 1200 });
        assert.ok(cf.ok && cf.pwf > 1200, 'closed form ' + wi + '/' + q);
        ['gasTZ', 'gray', 'hb', 'nsl'].forEach((k) => {
          const m = V.traverse(F, Wx, q, { p0: 1200, corr: k, accel: false });
          assert.rel(m.pEnd, cf.pwf, 0.01, k + ' well ' + wi + ' q ' + q);
        });
      }));
      const Wv = vertW(10000, 2.441, 150, 150), z0 = V.gasDry(F, Wv, 0, { p0: 1500 });
      const gk = W.WTS_gradient_compute({ dir: 's2b', p: 1500 - PATM, tvd: 10000, gasLen: 10000, mixLen: 0, hl: 0, rho: 8.33, sg: 0.65, t: 150, z: z0.zAvg });
      assert.ok(gk.ok, 'well-kill gradient');
      assert.rel(z0.pwf - PATM, gk.pBot, 0.002, 'static gas column');
    },
  },
  {
    name: 'VL11 average T-Z equation by hand: p_wf² = e^s·p_wh² + 25·γ·T̄·Z̄·f·MD·q²·(e^s − 1)/(s·d⁵) (psia, MMscf/d, °R, in, Moody, ft); s → 0 limit; the bottom-up inverse',
    wp: WP,
    run(_a, assert, ctx) {
      const W = app(ctx).win, V = W.WTS_wp_vlp, F = gasF(), Wv = vertW(9000, 2.441, 100, 200);
      const r = V.gasDry(F, Wv, 6000, { p0: 1000 });
      const T = r.tAvg + 459.67, Z = r.zAvg, s = 0.0375 * 0.65 * 9000 / (T * Z), q = 6;
      const mu = W.WTS_flowline_props({ qo: 0, qw: 0, qg: q, api: 55, sgg: 0.65, sgw: 1.07, pvt: F.pvt }, (1000 + r.pwf) / 2, r.tAvg).mug;
      const f = colebrook(20.09 * 0.65 * 6000 / (2.441 * mu), 0.0006 / 2.441);
      const pwf2 = Math.exp(s) * 1000 * 1000 + 25 * 0.65 * T * Z * f * 9000 * q * q * (Math.exp(s) - 1) / (s * Math.pow(2.441, 5));
      assert.rel(r.pwf, Math.sqrt(pwf2), 1e-6, 'closed form');
      assert.rel(r.tAvg, 150, 1e-12, 'T̄');
      // horizontal: s = 0, the friction term alone, (e^s − 1)/s → 1
      const Wh = { segments: [{ len: 3000, id: 2.441, dz: 0, md0: 3000, md1: 0, tvd0: 0, tvd1: 0, inc: 90 }], tAt: () => 150 };
      const h = V.gasDry(F, Wh, 6000, { p0: 1000 });
      const muh = W.WTS_flowline_props({ qo: 0, qw: 0, qg: q, api: 55, sgg: 0.65, sgw: 1.07, pvt: F.pvt }, (1000 + h.pEnd) / 2, 150).mug;
      const fh = colebrook(20.09 * 0.65 * 6000 / (2.441 * muh), 0.0006 / 2.441);
      assert.rel(h.pEnd, Math.sqrt(1e6 + 25 * 0.65 * (609.67) * h.zAvg * fh * 3000 * 36 / Math.pow(2.441, 5)), 1e-6, 's → 0');
      const up = V.gasDry(F, Wv, 6000, { p0: r.pwf, from: 'bottom' });
      assert.near(up.pEnd, 1000, 1e-3, 'inverse');
      const bad = V.gasDry(F, Wv, 60000, { p0: 900, from: 'bottom' });
      assert.ok(bad.ok === false && bad.lost, 'cannot lift: lost');
    },
  },
  {
    name: 'VL12 direction: a top-down march from THP and a bottom-up march from the resulting pwf agree within 0.5 psi (oil HB, gas Gray, deviated well)',
    wp: WP,
    run(_a, assert, ctx) {
      const V = app(ctx).win.WTS_wp_vlp;
      [[oilF(), devW(2.441, 35, 120, 200), 1200, 264.7, 'hb'], [gasF({ cgr: 20, wgr: 2 }), devW(2.441, 35, 120, 230), 6000, 1500, 'gray'],
        [oilF(), vertW(8000, 2.441, 120, 200), 800, 264.7, 'nsl']].forEach(([F, Wx, q, thp, k]) => {
        const dn = V.traverse(F, Wx, q, { p0: thp, corr: k });
        const up = V.traverse(F, Wx, q, { p0: dn.pEnd, corr: k, from: 'bottom' });
        assert.ok(dn.ok && up.ok, k);
        assert.near(up.pEnd, thp, 0.5, k + ' THP back (' + up.pEnd + ')');
        assert.strictEqual(up.profile[0].md, 0); assert.strictEqual(dn.profile[0].md, 0);
        assert.near(up.pTop, up.pEnd, 1e-9, 'pTop is the wellhead');
      });
    },
  },
  {
    name: 'VL13 step convergence (WC1): halving the step until the BHP changes < 0.1 psi; the 100 ft default is within 0.5 psi of the converged value (hb, gray, nsl)',
    wp: WP,
    timeoutMs: 120000,
    run(_a, assert, ctx) {
      const V = app(ctx).win.WTS_wp_vlp;
      [[oilF(), vertW(8000, 2.441, 120, 200), 1000, 264.7, 'hb'], [gasF({ cgr: 20, wgr: 2 }), devW(2.441, 30, 120, 230), 5000, 1500, 'gray'],
        [oilF(), vertW(8000, 2.441, 120, 200), 1500, 264.7, 'nsl']].forEach(([F, Wx, q, thp, k]) => {
        let step = 200, prev = V.traverse(F, Wx, q, { p0: thp, corr: k, stepFt: step }).pEnd, conv = null;
        for (let i = 0; i < 6; i++) {
          step /= 2;
          const p = V.traverse(F, Wx, q, { p0: thp, corr: k, stepFt: step }).pEnd;
          if (Math.abs(p - prev) < 0.1) { conv = p; break; }
          prev = p;
        }
        assert.ok(conv != null, k + ' converged by ' + step + ' ft');
        const def = V.traverse(F, Wx, q, { p0: thp, corr: k }).pEnd;
        assert.near(def, conv, 0.5, k + ' default 100 ft step');
      });
    },
  },
  {
    name: 'VL14 deviation: profile carries MD / TVD / inclination in MD order; hydrostatic on TVD, friction on MD; vertical-only warning above 30° (hb, gray) and not for nsl / bb',
    wp: WP,
    run(_a, assert, ctx) {
      const V = app(ctx).win.WTS_wp_vlp, F = oilF();
      const Wd = devW(2.441, 50, 120, 200), Wv = vertW(Wd.tvdTD, 2.441, 120, 200);
      Wv.tAt = (md) => 120 + 80 * md / Wv.segments[0].len;
      const d = V.traverse(F, Wd, 1500, { p0: 264.7, corr: 'hb' });
      assert.ok(d.ok);
      for (let i = 1; i < d.profile.length; i++) assert.ok(d.profile[i].md >= d.profile[i - 1].md && d.profile[i].tvd >= d.profile[i - 1].tvd - 1e-9, 'MD / TVD monotone');
      const mid = d.profile.find((r) => r.md > 3000 && r.md < 5000);
      assert.strictEqual(mid.inc, 50); assert.ok(Math.abs(mid.tvd - (2000 + (mid.md - 2000) * Math.cos(50 * Math.PI / 180))) < 1e-6, 'TVD on the slant');
      assert.near(d.profile[d.profile.length - 1].md, Wd.mdTD, 1e-9); assert.near(d.profile[d.profile.length - 1].tvd, Wd.tvdTD, 1e-6);
      // friction on MD: the deviated well needs more pressure than a vertical well of the same TVD; elevation the same order
      const v = V.traverse(F, Wv, 1500, { p0: 264.7, corr: 'hb' });
      const fD = d.segments.reduce((a, s) => a + s.dpF, 0), fV = v.segments.reduce((a, s) => a + s.dpF, 0);
      assert.ok(fD > fV * 1.1, 'friction over the longer MD: ' + fD + ' vs ' + fV);
      assert.rel(fD / fV, Wd.mdTD / Wd.tvdTD, 0.1, 'friction scales with MD');
      const eD = d.segments.reduce((a, s) => a + s.dpEl, 0), eV = v.segments.reduce((a, s) => a + s.dpEl, 0);
      assert.rel(eD, eV, 0.1, 'elevation over the same TVD');
      ['hb', 'gray'].forEach((k) => assert.ok(plain(V.traverse(F, Wd, 1500, { p0: 264.7, corr: k }).warnings).some((w) => w.code === 'VERTICAL_ONLY'), k + ' warns'));
      ['nsl', 'bb'].forEach((k) => assert.ok(!plain(V.traverse(F, Wd, 1500, { p0: 264.7, corr: k }).warnings).some((w) => w.code === 'VERTICAL_ONLY'), k + ' no warning'));
      assert.ok(!plain(V.traverse(F, devW(2.441, 25, 120, 200), 1500, { p0: 264.7, corr: 'hb' }).warnings).some((w) => w.code === 'VERTICAL_ONLY'), '25° no warning');
      // every profile row is a number row (SHAPE.R traverse)
      const sr = S.checkShape('R', { ok: true, node: 'bottom', roots: [], op: null, qs: null, vlpMin: null, traverse: { profile: plain(d.profile) }, breakdown: [], surface: {}, rates: {}, flags: [], discontinuities: [], warnings: [], evals: 1 });
      assert.ok(sr.ok, sr.errors.join('; '));
      ['p', 't', 'hl', 'vm', 'vsl', 'vsg', 'rhoS', 'gradEl', 'gradF', 'gradAcc', 'ero'].forEach((f) => assert.ok(d.profile.every((r) => typeof r[f] === 'number' && isFinite(r[f])), 'profile.' + f));
      assert.ok(d.profile.every((r) => typeof r.pattern === 'string'), 'pattern');
    },
  },
  {
    name: 'VL15 unknown key → UNKNOWN_CORR; Beggs & Brill through the engine = WTS_flowline_march bit for bit; curve, family, frozen-grid smoothness, multipliers, restrictions',
    wp: WP,
    timeoutMs: 120000,
    run(_a, assert, ctx) {
      const W = app(ctx).win, V = W.WTS_wp_vlp, F = oilF(), Wv = vertW(8000, 2.441, 120, 200);
      const u = V.traverse(F, Wv, 1000, { p0: 264.7, corr: 'nope' });
      assert.ok(u.ok === false && u.code === 'UNKNOWN_CORR', 'unknown key');
      assert.strictEqual(V.traverse(F, { segments: [] }, 1000, { p0: 264.7 }).code, 'NO_PATH');
      assert.strictEqual(V.traverse(F, Wv, 1000, {}).code, 'NO_P0');
      assert.strictEqual(V.traverse({ ok: false }, Wv, 1000, { p0: 300 }).code, 'NO_FLUID');
      // bb identity (§15.2)
      const e = V.traverse(F, Wv, 1000, { p0: 250 + PATM, corr: 'bb' });
      const ff = { qo: 700, qw: 300, qg: 0.35, api: 35, sgg: 0.65, sgw: 1.07, pvt: {} };
      const m = W.WTS_flowline_march([{ name: 'Tubing', len: 8000, id: 2.441, dz: 8000 }], ff, 250, NaN, NaN,
        { corr: 'bb', reverse: true, tAt: (x) => 120 + 80 * x / 8000, stepFt: 100, detail: true, rough: 0.0006, accel: true, payne: true, refine: true });
      assert.ok(Object.is(e.pEnd, m.pOut + PATM), 'bit-identical BHP: ' + e.pEnd + ' vs ' + (m.pOut + PATM));
      assert.strictEqual(e.profile.length, m.profile.length);
      e.profile.forEach((r, i) => assert.ok(Object.is(r.p, m.profile[i].p + PATM), 'profile ' + i));
      // curve with a frozen grid: smooth p(q) (second differences small) and equal to single traverses on that grid
      const qList = []; for (let q = 600; q <= 1400; q += 50) qList.push(q);
      // continuous correlations give a smooth curve; Hagedorn & Brown's Griffith bubble switch (a published discontinuity of the
      // method) moves one step at a time, so its second differences carry a bounded ±1–2 psi jitter (WP5 detects discontinuities)
      ['nsl', 'gray'].forEach((k) => {
        const cs = V.curve(F, Wv, { qList, p0: 264.7, corr: k, grid: true });
        let prev = null;   // convex and smooth: positive second differences that change slowly (third differences < 0.15 psi)
        for (let i = 1; i < cs.length - 1; i++) {
          const d2 = cs[i + 1].pwf - 2 * cs[i].pwf + cs[i - 1].pwf;
          assert.ok(d2 > 0 && (prev == null || Math.abs(d2 - prev) < 0.15), k + ' smooth at ' + cs[i].q + ': ' + d2 + ' after ' + prev);
          prev = d2;
        }
      });
      const c = V.curve(F, Wv, { qList, p0: 264.7, corr: 'hb', grid: true });
      assert.strictEqual(c.length, qList.length); assert.ok(c.grid && Array.isArray(c.grid.segs), 'grid returned');
      for (let i = 1; i < c.length - 1; i++) assert.ok(Math.abs(c[i + 1].pwf - 2 * c[i].pwf + c[i - 1].pwf) < 3, 'hb bounded at ' + c[i].q + ': ' + (c[i + 1].pwf - 2 * c[i].pwf + c[i - 1].pwf));
      const one = V.traverse(F, Wv, 900, { p0: 264.7, corr: 'hb', grid: c.grid });
      assert.ok(Object.is(one.pEnd, c.find((x) => x.q === 900).pwf), 'warm = cold on the frozen grid');
      const fam = V.family(F, Wv, { qList: [500, 1000], corr: 'hb' }, { key: 'p0', values: [214.7, 314.7, 414.7] });
      assert.strictEqual(fam.length, 3);
      assert.ok(fam[0].curve[1].pwf < fam[1].curve[1].pwf && fam[1].curve[1].pwf < fam[2].curve[1].pwf, 'THP family ordered');
      const fam2 = V.family(F, Wv, { qList: [1000], p0: 264.7 }, { values: ['hb', 'nsl'], apply: (v, x) => ({ o: Object.assign({}, x.o, { corr: v }) }) });
      assert.ok(fam2[1].curve[0].pwf < fam2[0].curve[0].pwf, 'no-slip is the lower bound');
      // multipliers: neutral = identical; m_h > 1 raises the BHP
      const base = V.traverse(F, Wv, 1000, { p0: 264.7, corr: 'hb' }), n1 = V.traverse(F, Wv, 1000, { p0: 264.7, corr: 'hb', mult: { hl: 1, f: 1 } });
      assert.ok(Object.is(base.pEnd, n1.pEnd), 'neutral multipliers');
      const up = V.traverse(F, Wv, 1000, { p0: 264.7, corr: 'hb', mult: { hl: 1.15, f: 1 } }), fr = V.traverse(F, Wv, 1000, { p0: 264.7, corr: 'hb', mult: { hl: 1, f: 1.3 } });
      assert.ok(up.pEnd > base.pEnd && fr.pEnd > base.pEnd, 'multipliers raise the BHP');
      // a restriction (SSSV, 1.5 in in 2.441 in) at 2,000 ft: its loss is reported and added
      const Wr = { segments: [{ name: 'Lower', len: 6000, id: 2.441, dz: 6000, md0: 8000, md1: 2000, tvd0: 8000, tvd1: 2000, inc: 0 },
        { name: 'Upper', len: 2000, id: 2.441, dz: 2000, md0: 2000, md1: 0, tvd0: 2000, tvd1: 0, inc: 0, restr: { d: 1.5, kind: 'sssv' } }], tAt: Wv.tAt };
      const r = V.traverse(F, Wr, 1000, { p0: 264.7, corr: 'hb' });
      assert.ok(r.restrictionsDp > 0 && r.restrictions.length === 1 && r.restrictions[0].md === 2000 && r.restrictions[0].kind === 'sssv', 'restriction listed');
      assert.ok(r.profile.some((x) => x.restr), 'restriction row in the profile');
      assert.ok(r.pEnd > base.pEnd, 'restriction raises the BHP');
    },
  },
  {
    name: 'VL16 published-example gate (Q9: no books — provisional): regression pins of the fixture traverses (not a verification), labels in every result, timing reported',
    wp: WP,
    timeoutMs: 120000,
    run(_a, assert, ctx) {
      const V = app(ctx).win.WTS_wp_vlp;
      // FIX.oilWell: 8,000 ft, 2-7/8" (2.441 in) to 7,950 ft then 7" casing, 35 °API, GOR 500, WC 30 %, THP 250 psig, 1,000 STB/d
      const M = S.FIX.oilWell, s = M.well.strings;
      const Wo = { segments: [{ name: 'Casing', len: 50, id: s[1].id, dz: 50, md0: 8000, md1: 7950, tvd0: 8000, tvd1: 7950, inc: 0, rough: 0.0006 },
        { name: 'Tubing', len: 7950, id: s[0].id, dz: 7950, md0: 7950, md1: 0, tvd0: 7950, tvd1: 0, inc: 0, rough: 0.0006 }], tAt: (md) => 120 + 80 * md / 8000 };
      const pins = { hb: 2209.7, gray: 2272.0, nsl: 2130.9, bb: 2388.1 };
      Object.keys(pins).forEach((k) => {
        const r = V.traverse(oilF(), Wo, 1000, { p0: 264.696, corr: k });
        assert.rel(r.pEnd, pins[k], 1e-3, k + ' regression pin');
        const lab = plain(r.warnings).find((w) => w.code === 'PROVISIONAL');
        if (k === 'bb') assert.ok(!lab, 'bb verified'); else assert.ok(lab && /provisional — not verified against a published example/.test(lab.msg), k + ' labelled');
      });
      // ordering expected of the methods on an oil well: no-slip lowest
      // FIX.gasWell-like wet gas: Gray and the average T-Z closed form
      const g = V.traverse(gasF({ cgr: 20, wgr: 2 }), devW(2.441, 30, 140, 230), 5000, { p0: 814.696, corr: 'gray' });
      assert.ok(g.ok && g.pEnd > 814.696 && plain(g.warnings).some((w) => w.code === 'PROVISIONAL'), 'gray wet gas');
      const t0 = process.hrtime.bigint(), n = 5, Wl = vertW(10000, 2.441, 120, 200);
      for (let i = 0; i < n; i++) V.traverse(oilF(), Wl, 1000, { p0: 264.696, corr: 'hb' });
      const ms = Number(process.hrtime.bigint() - t0) / 1e6 / n;
      console.log('    [VL16] one HB traverse 10,000 ft at 100 ft steps: ' + ms.toFixed(1) + ' ms (E baseline ' + S.BASELINE.E_ms + ' ms, Beggs & Brill)');
      assert.ok(ms < 10 * S.BASELINE.E_ms, 'loose sanity bound (WP11 gates)');
    },
  },
];
