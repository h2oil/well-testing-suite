// Roadmap calculator #10 — Multiphase Flowline Pressure Drop (route `flowline`,
// prism-build/49-calc-flowline.js).
//
// Expected values are independent of the module:
//   * Published data set: Brill & Mukherjee (1999), "Multiphase Flow in Wells", SPE
//     Monograph 17, Example 4.7 (Beggs & Brill method): 6-in vertical well, vSL 3.97 ft/s,
//     vSg 3.86 ft/s, ρL 47.61, ρg 5.88 lbm/ft³, μL 0.97, μg 0.016 cp, σL 8.41 dyn/cm,
//     ε 0.00006 ft, p 1,700 psia. The worked solution: λL 0.507, NFr 3.81,
//     intermittent, HL(0) 0.574, C < 0 → 0 so HL(90°) = 0.574, ρs ≈ 29.8 lbm/ft³,
//     elevation gradient ≈ 0.207 psi/ft, fn ≈ 0.0155 (Moody), y 1.539, S 0.372,
//     total ≈ 0.215 psi/ft (friction ≈ 0.008 psi/ft).
//   * A step-by-step Beggs & Brill written again below (bb()), Colebrook solved by
//     bisection, smooth-pipe fn from its closed form.
//   * Single-phase water: Darcy-Weisbach with Meehan Bw / McCain μw typed in here.
//   * Single-phase gas line: RK4 integration of dp/dx = f·ρ·v²/(2·gc·D) with Z and μg
//     from the PVT library's DAK / Lee-Gonzalez-Eakin (reference implementation).
'use strict';

const WP = 'FLOW';

function rows(app, resId) {
  return app.findAll('#' + resId + ' .rrow').map((r) => {
    const l = r.querySelector('.rl'), v = r.querySelector('.rv');
    return { l: String(l ? l.textContent : '').trim(), v: String(v ? v.textContent : '').trim() };
  });
}
function rv(app, resId, label, nth) {
  const r = rows(app, resId).find((x) => x.l === label);
  if (!r) throw new Error('no result row "' + label + '": ' + JSON.stringify(rows(app, resId).map((x) => x.l)));
  const nums = r.v.replace(/,/g, '').match(/-?\d+(\.\d+)?(e[-+]?\d+)?/gi);
  if (!nums || nums[nth || 0] == null) throw new Error('row "' + label + '" has no number: ' + r.v);
  return parseFloat(nums[nth || 0]);
}
function rtext(app, resId, label) { const r = rows(app, resId).find((x) => x.l === label); return r ? r.v : null; }
function errText(app) { return app.findAll('#fl_res .val-error').map((e) => e.textContent).join(' | '); }
function noBad(assert, app, where) {
  assert.ok(!/NaN|Infinity|undefined/.test(String(app.el('pgBody').textContent || '')), where + ': NaN/Infinity/undefined on page');
}
function set(app, vals) {
  for (const k of Object.keys(vals)) {
    if (!app.el(k)) throw new Error('no input #' + k);
    if (app.el(k).tagName === 'SELECT') app.select(k, String(vals[k]));
    else app.input(k, String(vals[k]));
  }
}
function open(app) {
  const b = app.find('.nav-btn[data-p="flowline"]');
  if (!b) throw new Error('no flowline nav button');
  app.click(b);
  if (!app.el('fl_root')) throw new Error('flowline page did not render');
}
const calc = (app) => app.click('fl_calc');
const S = (app) => app.win.WTS_state.flowline;

// ── Independent hand calculation of Beggs & Brill ──────────────────
const LG = Math.log10;
function colebrookBisect(re, e) {
  if (re < 2000) return 64 / re;
  let lo = 1e-4, hi = 0.2;
  const g = (f) => 1 / Math.sqrt(f) + 2 * LG(e / 3.7 + 2.51 / (re * Math.sqrt(f)));
  for (let k = 0; k < 200; k++) { const m = (lo + hi) / 2; if (g(lo) * g(m) <= 0) hi = m; else lo = m; }
  return (lo + hi) / 2;
}
function smooth(re) { return re < 2000 ? 64 / re : Math.pow(2 * LG(re / (4.5223 * LG(re) - 3.8215)), -2); }
function hl0(pat, lam, fr) {
  const t = { seg: [0.98, 0.4846, 0.0868], int: [0.845, 0.5351, 0.0173], dist: [1.065, 0.5824, 0.0609] }[pat];
  return Math.max(lam, t[0] * lam ** t[1] / fr ** t[2]);
}
function psiC(pat, lam, nlv, fr, thDeg) {
  if (thDeg === 0) return 1;
  let c;
  if (thDeg < 0) c = [4.7, -0.3692, 0.1244, -0.5056];
  else if (pat === 'seg') c = [0.011, -3.768, 3.539, -1.614];
  else if (pat === 'int') c = [2.96, 0.305, -0.4473, 0.0978];
  else return 1;
  let C = (1 - lam) * Math.log(c[0] * lam ** c[1] * nlv ** c[2] * fr ** c[3]);
  if (!(C > 0)) C = 0;
  const s = Math.sin(1.8 * thDeg * Math.PI / 180);
  return 1 + C * (s - 0.333 * s ** 3);
}
function bb(i) {
  const d = i.d / 12, vm = i.vsl + i.vsg, lam = i.vsl / vm, fr = vm * vm / (32.174 * d);
  const nlv = 1.938 * i.vsl * (i.rhoL / i.sigma) ** 0.25;
  const L2 = 0.0009252 * lam ** -2.4684, L3 = 0.1 * lam ** -1.4516, L1 = 316 * lam ** 0.302, L4 = 0.5 * lam ** -6.738;
  let pat;
  if (fr < L2) pat = 'segregated';
  else if (fr <= L3) pat = 'transition';
  else if ((lam < 0.4 && fr <= L1) || (lam >= 0.4 && fr <= L4)) pat = 'intermittent';
  else pat = 'distributed';
  const pf = i.payne ? (i.theta > 0 ? 0.924 : i.theta < 0 ? 0.685 : 1) : 1;
  const one = (p) => {
    let h = hl0(p, lam, fr) * psiC(p, lam, nlv, fr, i.theta) * pf;
    if (i.theta >= 0) h = Math.max(h, lam);
    return Math.min(1, h);
  };
  let hl;
  if (pat === 'transition') { const A = (L3 - fr) / (L3 - L2); hl = A * one('seg') + (1 - A) * one('int'); }
  else hl = one(pat === 'segregated' ? 'seg' : pat === 'intermittent' ? 'int' : 'dist');
  const rn = i.rhoL * lam + i.rhoG * (1 - lam), mn = i.muL * lam + i.muG * (1 - lam), rs = i.rhoL * hl + i.rhoG * (1 - hl);
  const re = 1488 * rn * vm * d / mn;
  const fn = i.payne ? colebrookBisect(re, i.rough / 12 / d) : smooth(re);
  const y = lam / hl ** 2, x = Math.log(y);
  const Sx = (y > 1 && y < 1.2) ? Math.log(2.2 * y - 1.2) : x / (-0.0523 + 3.182 * x - 0.8725 * x * x + 0.01853 * x ** 4);
  const el = rs * Math.sin(i.theta * Math.PI / 180) / 144;
  const f = fn * Math.exp(Sx) * rn * vm * vm / (2 * 32.174 * d) / 144;
  const Ek = i.accel ? rs * vm * i.vsg / (32.174 * i.p * 144) : 0;
  return { lam, fr, nlv, L1, L2, L3, L4, pat, hl, rs, rn, re, fn, y, S: Sx, el, f, Ek, tot: (el + f) / (1 - Ek) };
}
const EX47 = { vsl: 3.97, vsg: 3.86, d: 6, rhoL: 47.61, rhoG: 5.88, muL: 0.97, muG: 0.016, sigma: 8.41, theta: 90, rough: 0.00072, p: 1700 };

// Meehan Bw and McCain water viscosity, typed from McCain (1990) for this test.
function bwMeehan(P, T) {
  const dT = -1.0001e-2 + 1.33391e-4 * T + 5.50654e-7 * T * T;
  const dP = -1.95301e-9 * P * T - 1.72834e-13 * P * P * T - 3.58922e-7 * P - 2.25341e-10 * P * P;
  return (1 + dT) * (1 + dP);
}

module.exports = [
  {
    name: 'FLOW Beggs & Brill: published Example 4.7 data set (Brill & Mukherjee 1999) — pattern, holdup, gradients',
    wp: WP,
    run(app, assert) {
      const B = app.win.WTS_flowline_bb;
      assert.strictEqual(typeof B, 'function');
      // Original method (smooth-pipe fn), no acceleration
      const r = B(Object.assign({ payne: false, accel: false }, EX47));
      assert.strictEqual(r.pattern, 'intermittent');
      assert.within(r.lambdaL, 0.506, 0.508, 'λL 0.507');
      assert.within(r.NFr, 3.80, 3.82, 'NFr 3.81');
      assert.within(r.L1, 256, 259); assert.within(r.L3, 0.266, 0.270); assert.within(r.L4, 48, 49.5);
      assert.within(r.HL0, 0.572, 0.576, 'HL(0) 0.574');
      assert.within(r.NLV, 11.8, 11.95, 'NLV 11.87');
      assert.strictEqual(r.C, 0, 'C is negative and set to zero');
      assert.within(r.hl, 0.572, 0.576, 'HL(90) = HL(0)');
      assert.within(r.rhoS, 29.7, 29.95, 'ρs 29.8 lbm/ft³');
      assert.within(r.gradEl, 0.2055, 0.2085, 'elevation 0.207 psi/ft');
      assert.within(r.y, 1.53, 1.545); assert.within(r.S, 0.368, 0.376, 'S 0.372');
      // Published solution uses the Moody fn ≈ 0.0155 → total ≈ 0.215 psi/ft (2 % tolerance)
      const m = B(Object.assign({ payne: false, accel: false }, EX47, { theta: 90 }));
      const fnMoody = colebrookBisect(r.NRe, 0.00006 / 0.5);
      assert.within(fnMoody, 0.0150, 0.0160, 'Moody fn ≈ 0.0155');
      const totPub = m.gradEl + fnMoody * Math.exp(m.S) * m.rhoN * m.vm ** 2 / (2 * 32.174 * 0.5) / 144;
      assert.rel(totPub, 0.215, 0.02, 'total ≈ 0.215 psi/ft with the book friction factor');
      // Independent step-by-step hand calculation: every quantity
      const h = bb(Object.assign({ payne: false, accel: false }, EX47));
      assert.strictEqual(h.pat, r.pattern);
      assert.rel(r.hl, h.hl, 1e-9); assert.rel(r.rhoN, h.rn, 1e-12); assert.rel(r.NRe, h.re, 1e-12);
      assert.rel(r.fn, h.fn, 1e-9, 'smooth fn'); assert.rel(r.gradF, h.f, 1e-9); assert.rel(r.grad, h.tot, 1e-9);
      assert.rel(r.grad, 0.2147, 3e-3, 'module total, smooth pipe');
      // With acceleration: Ek = ρs vm vSg / (gc p)
      const a = B(Object.assign({ payne: false, accel: true }, EX47));
      const ha = bb(Object.assign({ payne: false, accel: true }, EX47));
      assert.rel(a.Ek, 29.836 * 7.83 * 3.86 / (32.174 * 1700 * 144), 1e-3, 'Ek hand');
      assert.rel(a.grad, ha.tot, 1e-9);
      // Payne: HL × 0.924 uphill, rough-pipe (Colebrook) fn
      const p = B(Object.assign({ payne: true, accel: false }, EX47));
      const hp = bb(Object.assign({ payne: true, accel: false }, EX47));
      assert.rel(p.hl, 0.924 * 0.57407, 1e-4, 'Payne uphill holdup');
      assert.rel(p.fn, fnMoody, 1e-6, 'Payne uses Colebrook');
      assert.rel(p.grad, hp.tot, 1e-6);
    },
  },
  {
    name: 'FLOW Beggs & Brill: segregated, transition, distributed and downhill (Payne 0.685) against the hand calculation',
    wp: WP,
    run(app, assert) {
      const B = app.win.WTS_flowline_bb;
      const base = { d: 4, rhoL: 50, rhoG: 3, muL: 2, muG: 0.013, sigma: 25, rough: 0.0018, p: 500, accel: false };
      const cases = [
        { vsl: 0.1, vsg: 0.9, theta: 0 },      // low NFr → segregated
        { vsl: 0.5, vsg: 2.2, theta: 5 },      // transition band
        { vsl: 2, vsg: 60, theta: 0 },         // distributed
        { vsl: 1, vsg: 8, theta: -10 },        // downhill
        { vsl: 1, vsg: 8, theta: 15 },         // uphill intermittent
      ];
      const seen = {};
      for (const payne of [false, true]) {
        for (const c of cases) {
          const inp = Object.assign({}, base, c, { payne });
          const r = B(inp), h = bb(inp);
          seen[r.pattern] = 1;
          assert.strictEqual(r.pattern, h.pat, JSON.stringify(c));
          assert.rel(r.hl, h.hl, 1e-9, 'HL ' + JSON.stringify(c) + ' payne=' + payne);
          assert.rel(r.grad, h.tot, 1e-6, 'gradient ' + JSON.stringify(c) + ' payne=' + payne);
        }
      }
      ['segregated', 'transition', 'intermittent', 'distributed'].forEach((p) => assert.ok(seen[p], 'covered ' + p));
      // Transition = A·seg + (1−A)·int
      const t = B(Object.assign({}, base, cases[1], { payne: false }));
      assert.strictEqual(t.pattern, 'transition');
      assert.rel(t.hl, t.A * t.hlSeg + (1 - t.A) * t.hlInt, 1e-12);
      // Downhill Payne factor 0.685 and no λL floor
      const dn0 = B(Object.assign({}, base, cases[3], { payne: false })), dn1 = B(Object.assign({}, base, cases[3], { payne: true }));
      assert.rel(dn1.hl, 0.685 * dn0.hl, 1e-9, 'downhill × 0.685');
      assert.ok(dn1.gradEl < 0, 'downhill elevation term is negative');
      // Horizontal Payne leaves holdup unchanged
      const h0 = B(Object.assign({}, base, cases[0], { payne: false })), h1 = B(Object.assign({}, base, cases[0], { payne: true }));
      assert.rel(h1.hl, h0.hl, 1e-12, 'horizontal unchanged by Payne');
    },
  },
  {
    name: 'FLOW fluid properties: Standing Rs capped at the GOR, oil density, Baker-Swerdloff and Hough surface tension',
    wp: WP,
    run(app, assert) {
      const P = app.win.WTS_flowline_props;
      const f = { qo: 1000, qw: 100, qg: 0.5, api: 35, sgg: 0.75, sgw: 1.05 };
      const pr = P(f, 600, 120);
      // Standing: Rs = γg·[(p/18.2 + 1.4)·10^(0.0125 API − 0.00091 T)]^(1/0.83)
      const rsSt = 0.75 * Math.pow((600 / 18.2 + 1.4) * Math.pow(10, 0.0125 * 35 - 0.00091 * 120), 1 / 0.83);
      assert.rel(pr.rs, rsSt, 1e-9, 'Standing Rs below the GOR');
      assert.ok(rsSt < 500, 'case is undersaturated in gas');
      const go = 141.5 / 166.5;
      const F = rsSt * Math.sqrt(0.75 / go) + 1.25 * 120;
      assert.rel(pr.bo, 0.972 + 0.000147 * Math.pow(F, 1.175), 1e-9, 'Standing Bo (0.972 + 0.000147 F^1.175)');
      assert.rel(pr.bo, 0.9759 + 0.00012 * Math.pow(F, 1.2), 5e-3, 'within 0.5 % of Standing 1947 chart fit');
      assert.rel(pr.rhoO, (62.37 * go + 0.01361 * rsSt * 0.75) / pr.bo, 1e-9, 'oil density');
      assert.rel(pr.freeGas, 0.5e6 - 1000 * rsSt, 1e-9, 'free gas');
      // Above the bubble point: Rs = GOR, no free gas
      const hp = P(f, 4000, 120);
      assert.rel(hp.rs, 500, 1e-12); assert.strictEqual(hp.freeGas, 0);
      // Surface tension (hand values)
      const sg = app.win.WTS_flowline_sigma;
      assert.rel(sg.oil(35, 100, 0), 37.5 - 0.2571 * 35, 1e-12, 'dead oil 100 °F');
      assert.rel(sg.oil(35, 68, 0), 39 - 0.2571 * 35, 1e-12, 'dead oil 68 °F');
      assert.rel(sg.oil(35, 84, 0), (39 - 0.2571 * 35 + 37.5 - 0.2571 * 35) / 2, 1e-12, 'linear between');
      assert.rel(sg.oil(35, 100, 1000), 28.5015 * (1 - 0.024 * Math.pow(1000, 0.45)), 1e-9, 'live oil');
      assert.rel(sg.water(74, 1000), 75 - 1.108 * Math.pow(1000, 0.349), 1e-12, 'water 74 °F');
      assert.rel(sg.water(280, 1000), 53 - 0.1048 * Math.pow(1000, 0.637), 1e-12, 'water 280 °F');
      // Gas density = pM/(ZRT)
      assert.rel(pr.rhoG, 600 * 28.9647 * 0.75 / (pr.z * 10.7316 * 579.67), 1e-9);
      assert.within(pr.z, 0.85, 0.95, 'Z plausible at 600 psia');
    },
  },
  {
    name: 'FLOW full route: single-phase water line equals Darcy-Weisbach with Colebrook; vertical column adds ρ/144',
    wp: WP,
    run(app, assert) {
      const C = app.win.WTS_flowline_compute;
      const inp = { qo: 0, qw: 10000, qg: 0, api: 35, sgg: 0.7, sgw: 1.0, pwh: 300, t0: 100, t1: 100, psep: 0, rough: 0.0018,
        payne: true, accel: true, well: [{ name: 'h', len: 1000, id: 3.826, dz: 0 }], flare: [] };
      const r = C(inp);
      assert.ok(r.ok, JSON.stringify(r.errors));
      assert.strictEqual(r.well.segments[0].patterns.join(), 'liquid');
      // Hand: Bw at mid pressure (~ 300 psig), μw McCain, Darcy
      const pm = 300 + 14.696 - r.well.dp / 2;
      const bw = bwMeehan(pm, 100), rho = 62.366 / bw;
      const mu = 109.574 * Math.pow(100, -1.12166) * (0.9994 + 4.0295e-5 * pm + 3.1062e-9 * pm * pm);
      assert.rel(r.inlet.muw, 109.574 * Math.pow(100, -1.12166), 0.02, 'McCain dead water viscosity (pressure correction ≤ 2 %)');
      const A = Math.PI * (3.826 / 12) ** 2 / 4, v = 10000 * bw * 5.614583 / 86400 / A;
      const re = 1488 * rho * v * (3.826 / 12) / r.inlet.muw;
      const f = colebrookBisect(re, 0.0018 / 3.826);
      const dp = f * rho * v * v / (2 * 32.174 * 3.826 / 12) / 144 * 1000;
      assert.rel(r.well.dp, dp, 3e-3, 'Darcy-Weisbach ' + dp.toFixed(3) + ' psi');
      assert.ok(mu > 0);
      // Vertical riser, 100 ft up, near-zero rate: hydrostatic ≈ ρ·100/144
      const v2 = C(Object.assign({}, inp, { qw: 1, well: [{ name: 'v', len: 100, id: 3.826, dz: 100 }] }));
      assert.rel(v2.well.dp, 62.366 / bwMeehan(300, 100) * 100 / 144, 2e-3, 'static column');
      const v3 = C(Object.assign({}, inp, { qw: 1, well: [{ name: 'v', len: 100, id: 3.826, dz: -100 }] }));
      assert.rel(v3.well.dp, -v2.well.dp, 2e-3, 'downhill gains the same head');
    },
  },
  {
    name: 'FLOW full route: dry gas flare line equals an RK4 integration of the isothermal real-gas equation',
    wp: WP,
    run(app, assert) {
      const C = app.win.WTS_flowline_compute;
      const L = app.win.PRiSM_pvt_correlations;
      const inp = { qo: 0, qw: 0, qg: 3, api: 35, sgg: 0.65, sgw: 1.0, pwh: 150, t0: 80, t1: 80, psep: 100, rough: 0.0018,
        payne: true, accel: false, well: [{ name: 'g', len: 3000, id: 4.026, dz: 0 }], flare: [] };
      const r = C(inp);
      assert.ok(r.ok);
      assert.strictEqual(r.well.segments[0].patterns.join(), 'gas');
      const Tpc = 169.2 + 349.5 * 0.65 - 74 * 0.65 * 0.65, Ppc = 756.8 - 131 * 0.65 - 3.6 * 0.65 * 0.65, TR = 539.67;
      const D = 4.026 / 12, A = Math.PI * D * D / 4;
      const dpdx = (p) => {
        const z = L.Z_dranchukAbouKassem(TR / Tpc, p / Ppc), mu = L.mu_g_leeGonzalezEakin(0.65, 80, z, p);
        const rho = p * 28.9647 * 0.65 / (z * 10.7316 * TR), v = 3e6 * 14.696 * z * TR / (519.67 * p) / 86400 / A;
        const f = colebrookBisect(1488 * rho * v * D / mu, 0.0018 / 4.026);
        return -f * rho * v * v / (2 * 32.174 * D) / 144;
      };
      let p = 164.696; const h = 10;
      for (let x = 0; x < 3000; x += h) {
        const k1 = dpdx(p), k2 = dpdx(p + h * k1 / 2), k3 = dpdx(p + h * k2 / 2), k4 = dpdx(p + h * k3);
        p += h * (k1 + 2 * k2 + 2 * k3 + k4) / 6;
      }
      assert.rel(r.well.pOut, p - 14.696, 2e-3, 'outlet pressure vs RK4 ' + (p - 14.696).toFixed(2));
      assert.ok(r.well.dp > 5, 'meaningful drop ' + r.well.dp);
    },
  },
  {
    name: 'FLOW page: default case renders, arrives above the separator, report sections, state, chart',
    wp: WP,
    run(app, assert) {
      open(app);
      const st = S(app);
      assert.ok(st.ok, JSON.stringify(st.result.errors));
      assert.ok(st.pArr > 250 && st.pArr < 600, 'arrival ' + st.pArr);
      assert.rel(rv(app, 'fl_res', 'Arrival pressure at separator'), st.pArr, 2e-3);
      assert.includes(app.el('fl_res').textContent, '✓ Arrives at the separator');
      assert.ok(st.dpFlare > 0 && st.pFlare < 250, 'flare line computed');
      assert.strictEqual(rtext(app, 'fl_res', 'Flow pattern at inlet'), 'Intermittent');
      // segment ΔP components add up
      st.result.well.segments.forEach((s) => assert.rel(s.dpEl + s.dpF + s.dpAcc, s.dp, 1e-6, s.name));
      assert.ok(app.findAll('#fl_res table.dtable').length >= 2, 'segment tables');
      assert.ok(app.canvasLog('fl_chart', 'lineTo').length > 20, 'pressure chart drawn');
      noBad(assert, app, 'default');
      // Low inlet pressure → does not reach separator
      set(app, { fl_pwh: 260 }); calc(app);
      assert.ok(!S(app).result.well.reaches, 'below separator');
      assert.includes(app.el('fl_res').textContent, '✗ Arrival pressure');
      noBad(assert, app, 'low');
    },
  },
  {
    name: 'FLOW validation: flags bad inputs and incomplete segments, clears on fix',
    wp: WP,
    run(app, assert) {
      open(app);
      set(app, { fl_qo: 0, fl_qw: 0, fl_qg: 0, fl_w2_id: '', fl_w3_dz: 50, fl_api: 5 }); calc(app);
      const e = errText(app);
      assert.includes(e, 'at least one non-zero rate');
      assert.includes(e, 'Segment 2: inside diameter');
      assert.includes(e, 'Segment 3: elevation change cannot exceed');
      assert.includes(e, '°API');
      assert.ok(app.el('fl_w2_id').classList.contains('input-err'), 'segment cell flagged');
      noBad(assert, app, 'validation');
      set(app, { fl_qo: 2000, fl_w2_id: 2.9, fl_w3_dz: 15, fl_api: 35 }); calc(app);
      assert.strictEqual(app.findAll('#fl_root .input-err').length, 0);
      assert.ok(S(app).ok);
    },
  },
  {
    name: 'FLOW metric: labels and headers switch, same physical answer, metric entry converts, flip recalculates',
    wp: WP,
    run(app, assert) {
      open(app);
      const imp = S(app).pArr, impF = S(app).dpFlare;
      const U = app.win.WTS_units;
      app.flush(10);
      U.setSystem('metric');
      try {
        open(app);
        const lab = (id) => String(app.el(id).closest('.fg-item').querySelector('label').textContent);
        assert.match(lab('fl_pwh'), /kPa/);
        assert.match(lab('fl_qo'), /m³\/d/);
        assert.match(lab('fl_rough'), /\(mm\)/);
        assert.includes(app.el('fl_wh_id').textContent, 'mm');
        assert.includes(app.el('fl_wh_len').textContent, '(m)');
        assert.rel(S(app).pArr, imp, 2e-3, 'metric same arrival');
        assert.rel(S(app).dpFlare, impF, 5e-3, 'metric same flare drop');
        assert.includes(rtext(app, 'fl_res', 'Arrival pressure at separator'), 'kPa');
        assert.includes(rtext(app, 'fl_res', 'Pressure gradient at inlet'), 'kPa/m');
        app.input('fl_w1_len', String(150 * 0.3048)); calc(app);
        assert.rel(S(app).pArr, imp, 2e-3, 'metric entry of 45.72 m');
      } finally { U.setSystem('imperial'); }
      assert.rel(S(app).pArr, imp, 2e-3);
      assert.includes(app.el('fl_wh_len').textContent, '(ft)');
    },
  },
  {
    name: 'FLOW report + persistence + link from Line Heat Loss + phone',
    wp: WP,
    opts: { viewport: { width: 375, height: 812 } },
    run(app, assert) {
      // Line Heat Loss first, then use its temperatures here
      const hb = app.find('.nav-btn[data-p="lineheat"]');
      app.click(hb);
      const lh = app.win.WTS_state.lineheat;
      assert.ok(lh && lh.ok);
      open(app);
      app.click('fl_useheat');
      assert.rel(Number(app.el('fl_t0').value), Number(lh.tIn.toFixed(2)), 1e-9, 'inlet T from line heat');
      assert.rel(Number(app.el('fl_t1').value), Number(lh.tArr.toFixed(2)), 1e-9, 'arrival T from line heat');
      set(app, { fl_qg: 4, fl_payne: 'no' }); calc(app);
      const p = S(app).pArr;
      const model = app.win.collectPageReport(app.el('pgBody'), { charts: false });
      const rt = model.results.map((x) => x.title);
      ['Line Summary', 'Inlet Conditions and Fluid Properties', 'Segments: Wellhead to separator', 'Segments: Separator to flare']
        .forEach((t) => assert.ok(rt.indexOf(t) !== -1, 'section ' + t + ': ' + rt.join(' | ')));
      const s = JSON.stringify(model);
      ['Separator gas rate', 'Payne et al. corrections', 'Choke manifold to heater'].forEach((n) => assert.includes(s, n));
      const n0 = app.opened.length;
      app.win.exportPagePDF();
      const pdf = app.opened[n0] && app.opened[n0].html();
      assert.ok(pdf && pdf.indexOf('Multiphase Flowline') !== -1, 'PDF');
      app.flush(1200);
      const rec = JSON.parse(app.storage.getItem('wts_page_flowline') || 'null');
      assert.ok(rec && rec.f && rec.f.fl_qg === '4' && rec.f.fl_payne === 'no', 'autosaved');
      assert.ok(!/width:\s*[4-9]\d\dpx|width:\s*\d{4,}px/.test(app.el('pgBody').innerHTML), 'no wide fixed widths');
      app.flushUntilIdle(10000);
      assert.strictEqual(app.pendingTimers(), 0, 'no timers');
      const app2 = app.reload();
      try {
        open(app2);
        assert.strictEqual(app2.el('fl_qg').value, '4');
        assert.rel(app2.win.WTS_state.flowline.pArr, p, 1e-9, 'restored and recalculated');
        app2.hook.nav('home');
        const titles = app2.findAll('.dash-card').map((c) => String(c.querySelector('h3').textContent).trim());
        assert.ok(titles.indexOf('Multiphase Flowline Pressure Drop') !== -1, 'dashboard tile');
      } finally { app2.dispose(); }
    },
  },
];
