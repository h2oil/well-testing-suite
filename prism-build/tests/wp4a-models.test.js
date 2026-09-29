// WP4a — model kernels I (prism-build/03-models.js) acceptance tests.
//
// Plan §WP4a acceptance a–i plus the shared-export contract (C3 registry
// metadata, PRiSM_evalWbsSkin, PRiSM_pseudoSkin, PRiSM_lap_horizontal).
// All tests run inside the app built from sources (03 after 01, as in the HTML)
// except the foundation cross-check, which loads 01's math sections in a vm.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MODELS_03 = ['homogeneous', 'infiniteFrac', 'finiteFrac', 'inclined', 'horizontal',
  'linearBoundary', 'parallelChannel', 'closedChannel3', 'closedRectangle', 'intersecting',
  'fogBoundary', 'finiteFracSkin', 'partialPenFrac'];
const RW_MODELS = ['homogeneous', 'inclined', 'linearBoundary', 'parallelChannel', 'closedChannel3',
  'closedRectangle', 'intersecting', 'fogBoundary'];

function logspace(a, b, perDecade) {
  const out = [];
  const n = Math.round((b - a) * perDecade);
  for (let i = 0; i <= n; i++) out.push(Math.pow(10, a + (b - a) * i / n));
  return out;
}
function withSkin(entry, S) {
  const p = Object.assign({}, entry.defaults);
  if ('S' in p) p.S = S; else p.S_perf = S;
  return p;
}
// local log-log slope of y(t) between t1 and t2
const slope = (y1, y2, t1, t2) => Math.log(y2 / y1) / Math.log(t2 / t1);

// Load the pure-math part of 01-foundation.js (sections 1–3) and 03-models.js
// into one vm context, exactly in build order, without the UI sections.
function loadMathContext() {
  const dir = path.join(__dirname, '..');
  const f01 = fs.readFileSync(path.join(dir, '01-foundation.js'), 'utf8');
  const cut = f01.indexOf('// SECTION 4');
  const math01 = f01.slice(0, cut > 0 ? f01.lastIndexOf('// ====', cut) : f01.length);
  const f03 = fs.readFileSync(path.join(dir, '03-models.js'), 'utf8');
  const ctx = { console: { log() {}, warn() {}, error() {} }, Math, isFinite, isNaN, Object, Array, Error, JSON };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(math01 + '\n;this.__hom = PRiSM_model_homogeneous; this.__homP = PRiSM_model_homogeneous_pd_prime;', ctx);
  vm.runInContext(f03, ctx);
  return ctx;
}

module.exports = [
  // ── a. registry scan ────────────────────────────────────────────────────
  {
    name: 'a. registry scan: every 03 model finite, >= 0, non-decreasing, no throw (S = -3, 0, 2.5; td 1e-2..1e7)',
    wp: 'WP4a',
    timeoutMs: 60000,
    run(app, assert) {
      const M = app.win.PRiSM_MODELS;
      const td = logspace(-2, 7, 4);
      for (const key of MODELS_03) {
        const m = M[key];
        assert.ok(m && typeof m.pd === 'function' && typeof m.pdPrime === 'function', key + ' registered');
        for (const S of [-3, 0, 2.5]) {
          const p = withSkin(m, S);
          const pd = m.pd(td, p);
          const dp = m.pdPrime(td, p);
          for (let i = 0; i < td.length; i++) {
            assert.ok(Number.isFinite(pd[i]) && pd[i] >= 0, `${key} S=${S} pd(${td[i]}) = ${pd[i]}`);
            assert.ok(Number.isFinite(dp[i]), `${key} S=${S} pd'(${td[i]}) = ${dp[i]}`);
            if (i > 0) assert.ok(pd[i] >= pd[i - 1] * (1 - 1e-9), `${key} S=${S} monotone at td=${td[i]}: ${pd[i - 1]} -> ${pd[i]}`);
          }
        }
      }
    },
  },
  {
    name: 'a. rw-based models follow pure storage pd = td/Cd ± 5% (td <= 0.1·Cd, shrunk by e^{2S} for S < 0)',
    wp: 'WP4a',
    run(app, assert) {
      // For S >= 0 the unit-slope window is td <= 0.1·Cd (plan). For S < 0 the
      // effective storage is Cd·e^{2S}, so the same window is td <= 0.1·Cd·e^{2S}:
      // at S = -3, Cd = 100 the true response at td = 10 is 35 % below td/Cd.
      const M = app.win.PRiSM_MODELS;
      for (const key of RW_MODELS) {
        const m = M[key];
        for (const S of [-3, 0, 2.5]) {
          const p = withSkin(m, S);
          // the inclined model's total skin includes its (negative) geometric pseudo-skin
          const Stot = S + (typeof m.pseudoSkin === 'function' ? m.pseudoSkin(p) : 0);
          const tmax = 0.1 * p.Cd * Math.min(1, Math.exp(2 * Stot));
          const td = logspace(-2, Math.log10(tmax), 4).filter((t) => t <= tmax * (1 + 1e-12));
          const pd = m.pd(td, p);
          td.forEach((t, i) => assert.rel(pd[i], t / p.Cd, 0.05, `${key} S=${S} td=${t}`));
        }
      }
    },
  },
  // ── b. homogeneous, negative skin ───────────────────────────────────────
  {
    name: 'b. homogeneous negative skin: Cd 100 S -3 monotone, late pd = 0.5(ln td + 0.80907) - 3; S -7 Cd 1e4 finite',
    wp: 'WP4a',
    run(app, assert) {
      const hom = app.win.PRiSM_MODELS.homogeneous;
      assert.equal(hom.refLength, 'rw');
      const td = logspace(-2, 8, 5);
      const pd = hom.pd(td, { Cd: 100, S: -3 });
      for (let i = 1; i < td.length; i++) assert.ok(pd[i] >= pd[i - 1], 'monotone at ' + td[i]);
      for (const t of [1e6, 1e7, 1e8]) {
        assert.near(hom.pd(t, { Cd: 100, S: -3 }), 0.5 * (Math.log(t) + 0.80907) - 3, 0.01, 'late pd td=' + t);
        assert.near(hom.pdPrime(t, { Cd: 100, S: -3 }), 0.5, 0.005, 'late pd\' td=' + t);
      }
      const td2 = logspace(0, 6, 6);
      const pd2 = hom.pd(td2, { Cd: 1e4, S: -7 });
      const dp2 = hom.pdPrime(td2, { Cd: 1e4, S: -7 });
      td2.forEach((t, i) => {
        assert.ok(Number.isFinite(pd2[i]) && pd2[i] > 0 && Number.isFinite(dp2[i]) && dp2[i] > 0, 'S=-7 finite at ' + t);
        if (i > 0) assert.ok(pd2[i] >= pd2[i - 1], 'S=-7 monotone at ' + t);
      });
      // stimulation lowers the late pressure by exactly |S|
      assert.near(hom.pd(1e7, { Cd: 100, S: 0 }) - hom.pd(1e7, { Cd: 100, S: -3 }), 3, 0.01);
    },
  },
  {
    name: 'b. homogeneous: 03 wrapper equals the foundation closed form for S >= 0 (Cd 1..1e4)',
    wp: 'WP4a',
    opts: false,
    run(app, assert) {
      const ctx = loadMathContext();
      const reg = ctx.PRiSM_MODELS.homogeneous;
      const td = logspace(-1, 7, 3);
      for (const [Cd, S] of [[100, 0], [80, 2.5], [1, 10], [1e4, 0.5]]) {
        const a = reg.pd(td, { Cd, S }), b = ctx.__hom(td, { Cd, S });
        const da = reg.pdPrime(td, { Cd, S }), db = ctx.__homP(td, { Cd, S });
        td.forEach((t, i) => {
          assert.rel(a[i], b[i], 1e-5, `pd Cd=${Cd} S=${S} td=${t}`);
          assert.rel(da[i], db[i], 1e-4, `pd' Cd=${Cd} S=${S} td=${t}`);
        });
      }
    },
  },
  // ── c. inclined ─────────────────────────────────────────────────────────
  {
    name: 'c. inclined: theta 0 equals homogeneous; Cinco-Ley S_theta(45) = -1.511, S_theta(60) = -2.704; pd never throws',
    wp: 'WP4a',
    run(app, assert) {
      const M = app.win.PRiSM_MODELS;
      const td = logspace(-1, 7, 3);
      for (const S of [-2, 0, 3]) {
        const a = M.inclined.pd(td, { Cd: 100, S_perf: S, S_global: 0, KvKh: 1, theta_deg: 0, hp_to_h: 1 });
        const b = M.homogeneous.pd(td, { Cd: 100, S });
        td.forEach((t, i) => assert.near(a[i], b[i], 1e-6, `theta 0 S=${S} td=${t}`));
      }
      const cl = app.win.PRiSM_pseudoSkin.cincoLey;
      assert.near(cl(45, 1, 100, 0.354), -1.511, 0.01, 'S_theta(45°)');
      assert.near(cl(60, 1, 100, 0.354), -2.704, 0.01, 'S_theta(60°)');
      assert.near(cl(45, 1, 100 / 0.354), -1.511, 0.01, 'S_theta(45°) with h/rw form');
      // inclined pd at the defaults and at 60° does not throw and equals the
      // homogeneous curve with the total skin
      const d = M.inclined.defaults;
      assert.doesNotThrow(() => M.inclined.pd(td, d));
      const p60 = { Cd: 100, S_perf: 1, S_global: 0, KvKh: 1, theta_deg: 60, hp_to_h: 1, __h_rw: 100 / 0.354 };
      const a60 = M.inclined.pd(td, p60), b60 = M.homogeneous.pd(td, { Cd: 100, S: 1 + cl(60, 1, 100, 0.354) });
      td.forEach((t, i) => assert.near(a60[i], b60[i], 1e-9, '60° td=' + t));
      assert.near(M.inclined.pseudoSkin(p60, { h: 100, rw: 0.354 }), -2.704, 0.01, 'registry pseudoSkin');
      assert.ok(M.inclined.defaultFrozen.includes('S_global'), 'S_global frozen by default');
    },
  },
  // ── d. infiniteFrac ─────────────────────────────────────────────────────
  {
    name: 'd. infiniteFrac: Cd 1e-6 vs 0 continuous; half-slope pd\'(0.01) = 0.0886; late pd = 0.5(ln tD + 2.20)',
    wp: 'WP4a',
    run(app, assert) {
      const m = app.win.PRiSM_MODELS.infiniteFrac;
      assert.equal(m.refLength, 'xf');
      for (const t of [1e2, 1e4]) {
        assert.rel(m.pd(t, { Cd: 1e-6, S: 0 }), m.pd(t, { Cd: 0, S: 0 }), 0.005, 'continuity at td=' + t);
      }
      assert.rel(m.pdPrime(0.01, { Cd: 0, S: 0 }), 0.5 * Math.sqrt(Math.PI * 0.01), 0.03, 'half slope');
      assert.near(slope(m.pdPrime(1e-3, { Cd: 0, S: 0 }), m.pdPrime(1e-2, { Cd: 0, S: 0 }), 1e-3, 1e-2), 0.5, 0.02, 'half-slope derivative');
      for (const t of [1e4, 1e5, 1e6]) {
        assert.near(m.pd(t, { Cd: 0, S: 0 }), 0.5 * (Math.log(t) + 2.20), 0.03, 'late pd td=' + t);
      }
      // uniform-flux flag
      const uf = m.pd(1e5, { Cd: 0, S: 0, uniformFlux: true });
      assert.near(uf, 0.5 * (Math.log(1e5) + 0.80907) + 1, 0.03, 'uniform-flux late pd (rw\' = xf/e)');
      // equivalent skin
      assert.near(m.equivalentSkin({}, { xf: 100, rw: 0.354 }), Math.log(2 * 0.354 / 100), 1e-12);
    },
  },
  // ── e. finiteFrac ───────────────────────────────────────────────────────
  {
    name: 'e. finiteFrac: FcD 1 bilinear 2.45 tD^1/4; FcD 500 within 2% of infiniteFrac; late pd\' = 0.5',
    wp: 'WP4a',
    run(app, assert) {
      const M = app.win.PRiSM_MODELS;
      for (const t of [3e-4, 1e-3, 3e-3]) {
        assert.rel(M.finiteFrac.pd(t, { Cd: 0, S: 0, FcD: 1 }), 2.45 * Math.pow(t, 0.25), 0.05, 'bilinear td=' + t);
      }
      const b = M.finiteFrac.pdPrime(1e-3, { Cd: 0, S: 0, FcD: 1 }) / M.finiteFrac.pd(1e-3, { Cd: 0, S: 0, FcD: 1 });
      assert.near(b, 0.25, 0.03, 'quarter-slope (pd\'/pd = 1/4 in bilinear flow)');
      // xD = 0.732 surrogate vs rigorous segments: agree within 2% once tD >= 0.1
      // (at tD <= 0.03 the surrogate misses 2-3 % of the tip effect)
      for (const t of [0.1, 0.3, 1, 10, 100, 1e3]) {
        assert.rel(M.finiteFrac.pd(t, { Cd: 0, S: 0, FcD: 500 }), M.infiniteFrac.pd(t, { Cd: 0, S: 0 }), 0.02, 'FcD 500 td=' + t);
      }
      for (const FcD of [1, 10, 100]) {
        assert.near(M.finiteFrac.pdPrime(1e5, { Cd: 0, S: 0, FcD }), 0.5, 0.01, 'late derivative FcD=' + FcD);
      }
      // continuity in Cd (no Cd == 0 special case) and ordering in FcD
      assert.rel(M.finiteFrac.pd(10, { Cd: 1e-6, S: 0, FcD: 10 }), M.finiteFrac.pd(10, { Cd: 0, S: 0, FcD: 10 }), 0.005);
      assert.ok(M.finiteFrac.pd(1, { Cd: 0, S: 0, FcD: 1 }) > M.finiteFrac.pd(1, { Cd: 0, S: 0, FcD: 100 }), 'lower FcD → more pressure drop');
      // fracture-face skin raises the early response, fades into a constant later
      const a = M.finiteFracSkin.pd(1e-3, { Cd: 0, S: 0, FcD: 10, Sf: 1 });
      const c = M.finiteFracSkin.pd(1e-3, { Cd: 0, S: 0, FcD: 10, Sf: 0 });
      assert.ok(a > c + 0.1, 'Sf visible at early time');
      assert.rel(M.finiteFracSkin.pd(1e-3, { Cd: 0, S: 0, FcD: 10, Sf: 0 }), M.finiteFrac.pd(1e-3, { Cd: 0, S: 0, FcD: 10 }), 1e-12);
    },
  },
  // ── f. horizontal ───────────────────────────────────────────────────────
  {
    name: 'f. horizontal (KvKh 0.1, L/h 5): early radial pd\' = 0.316; late pd\' = 0.500; linear half-slope for a long well',
    wp: 'WP4a',
    run(app, assert) {
      const m = app.win.PRiSM_MODELS.horizontal;
      assert.equal(m.refLength, 'Lh');
      const p = { Cd: 0, S_perf: 0, S_global: 0, KvKh: 0.1, L_to_h: 5, zw_to_h: 0.5 };
      const early = 0.5 * (1 / 5) * Math.sqrt(10);
      const tdE = logspace(-3, -2, 8);
      const dpE = m.pdPrime(tdE, p);
      assert.rel(Math.max.apply(null, dpE), early, 0.05, 'early radial plateau');
      for (const t of [1e4, 1e5]) assert.near(m.pdPrime(t, p), 0.5, 0.01, 'late pseudo-radial td=' + t);
      // L/h 5 at kv/kh 0.1 (LD = 0.79) is too short for a clean linear-flow
      // regime; show the half slope on a long well (LD = 15.8), where the
      // kernel must reproduce uniform-flux linear flow at xD = 0.732.
      const pl = Object.assign({}, p, { L_to_h: 100 });
      const t1 = 1e-3, t2 = 1e-2;
      assert.near(slope(m.pdPrime(t1, pl), m.pdPrime(t2, pl), t1, t2), 0.5, 0.06, 'half-slope window');
      assert.rel(m.pdPrime(0.01, pl), 0.5 * Math.sqrt(Math.PI * 0.01) * 0.5 * (1 + 0.94229), 0.01, 'linear-flow level');
      // the window also exists (as a rising, then 0.5-plateau derivative) at the defaults
      const dpd = m.pdPrime([0.1, 0.3, 1], p);
      assert.ok(dpd[0] < dpd[1] && dpd[1] < dpd[2], 'derivative rises between vertical radial and pseudo-radial');
      // no additive geometric skin: late pd - 0.5 ln td is S-shifted exactly
      const shift = m.pd(1e5, Object.assign({}, p, { S_perf: 2 })) - m.pd(1e5, p);
      assert.near(shift, 2, 1e-3, 'S_perf adds directly');
      // exported Laplace kernel
      assert.fn(app.win.PRiSM_lap_horizontal);
      assert.ok(app.win.PRiSM_lap_horizontal(1, p) > 0);
      assert.ok(m.defaultFrozen.includes('S_global'));
      // injected __Lh_h (Lh/h from a physical wrapper) overrides L_to_h
      const viaLh = m.pdPrime([0.01, 1], Object.assign({}, p, { L_to_h: 40, __Lh_h: 2.5 }));
      const viaL = m.pdPrime([0.01, 1], p);
      assert.near(viaLh[0], viaL[0], 1e-12); assert.near(viaLh[1], viaL[1], 1e-12);
    },
  },
  // ── g. channels ─────────────────────────────────────────────────────────
  {
    name: 'g. parallelChannel dF 500/500: pd\'(1e8) = 17.73, pd\'(1e9) = 56.05; closedChannel3 -> 2√(πtD)/W',
    wp: 'WP4a',
    run(app, assert) {
      const M = app.win.PRiSM_MODELS;
      assert.rel(M.parallelChannel.pdPrime(1e8, { Cd: 100, S: 0, dF1: 500, dF2: 500 }), 17.73, 0.02);
      assert.rel(M.parallelChannel.pdPrime(1e9, { Cd: 100, S: 0, dF1: 500, dF2: 500 }), 56.05, 0.02);
      // off-centre well: same late linear flow (all four images per shell)
      assert.rel(M.parallelChannel.pdPrime(1e9, { Cd: 100, S: 0, dF1: 200, dF2: 800 }), 56.05, 0.02);
      for (const t of [1e8, 1e9]) {
        assert.rel(M.closedChannel3.pdPrime(t, M.closedChannel3.defaults), 2 * Math.sqrt(Math.PI * t) / 1000, 0.03, 'closedChannel3 td=' + t);
      }
      // derivative doubles after the end wall is felt
      const r = M.closedChannel3.pdPrime(1e9, M.closedChannel3.defaults) / M.parallelChannel.pdPrime(1e9, M.parallelChannel.defaults);
      assert.near(r, 2, 0.05);
    },
  },
  // ── h. closed rectangle ─────────────────────────────────────────────────
  {
    name: 'h. closedRectangle: centred 1000x1000 PSS pd\' = 2π tDA; off-centre (dN 100, dS 900) nearest-fault response',
    wp: 'WP4a',
    run(app, assert) {
      const m = app.win.PRiSM_MODELS.closedRectangle;
      assert.rel(m.pdPrime(1e7, m.defaults), 62.83, 0.03, 'tDA 10');
      assert.rel(m.pdPrime(1e8, m.defaults), 628.3, 0.03, 'tDA 100');
      // Off-centre values are the single-fault image response
      // ½(1 + e^{-(2·100)²/(4 tD)}), i.e. without wellbore storage (at Cd = 100
      // the storage hump still adds ~0.05 at tD = 1e4 — see the Cd = 100 check).
      const off = { Cd: 0, S: 0, dN: 100, dS: 900, dE: 500, dW: 500 };
      assert.near(m.pdPrime(1e4, off), 0.684, 0.02, 'td 1e4');
      assert.near(m.pdPrime(3e4, off), 0.859, 0.02, 'td 3e4');
      const cen = { Cd: 0, S: 0, dN: 500, dS: 500, dE: 500, dW: 500 };
      assert.ok(Math.abs(m.pdPrime(3e4, cen) - m.pdPrime(3e4, off)) > 0.3, 'well position matters');
      // Cd = 100: rectangle equals homogeneous + boundary increment
      const hom = app.win.PRiSM_MODELS.homogeneous;
      const inc = m.pdPrime(1e4, Object.assign({}, off, { Cd: 100 })) - hom.pdPrime(1e4, { Cd: 100, S: 0 });
      assert.near(inc, 0.684 - 0.5, 0.02, 'boundary increment on top of the storage tail');
      // late PSS for an off-centre well is still 2π tDA
      assert.rel(m.pdPrime(1e8, off), 628.3, 0.03, 'off-centre PSS');
    },
  },
  {
    name: 'h. image lattice (theta-function Laplace integral) equals a brute-force image sum',
    wp: 'WP4a',
    run(app, assert) {
      const w = app.win;
      const img = w.PRiSM_lap_imageTerm, well = w.PRiSM_lap_wellTerm;
      // brute-force closed rectangle 600 x 400 rw, well at (dW 150, dS 100)
      const Lx = 600, Ly = 400, xw = 150, yw = 100;
      const brute = (s) => {
        let v = well(s);
        const X = [], Y = [];
        for (let i = -40; i <= 40; i++) { X.push(2 * i * Lx, 2 * xw + 2 * i * Lx); Y.push(2 * i * Ly, 2 * yw + 2 * i * Ly); }
        for (const x of X) for (const y of Y) { const r = Math.hypot(x, y); if (r > 0) v += img(s, r); }
        return v;
      };
      const td = [1e3, 1e4, 3e4, 1e5];
      const ref = w.PRiSM_evalWbsSkin(brute, td, 0, 0);
      const got = w.PRiSM_MODELS.closedRectangle.pd(td, { Cd: 0, S: 0, dN: Ly - yw, dS: yw, dE: Lx - xw, dW: xw });
      td.forEach((t, i) => assert.rel(got[i], ref[i], 1e-6, 'td=' + t));
      // parallel channel vs brute force (4 images per shell)
      const W = 700, d1 = 250;
      const bruteC = (s) => {
        let v = well(s);
        for (let n = 1; n <= 400; n++) v += 2 * img(s, 2 * n * W) + img(s, 2 * n * W - 2 * d1) + img(s, 2 * n * W - 2 * (W - d1));
        return v;
      };
      const refC = w.PRiSM_evalWbsSkin(bruteC, td, 0, 0);
      const gotC = w.PRiSM_MODELS.parallelChannel.pd(td, { Cd: 0, S: 0, dF1: d1, dF2: W - d1 });
      td.forEach((t, i) => assert.rel(gotC[i], refC[i], 1e-6, 'channel td=' + t));
    },
  },
  // ── i. pseudo-skin library ──────────────────────────────────────────────
  {
    name: 'i. pseudo-skin library: Brons-Marting(0.2) = 10.79, (0.5) = 3.05; fracture and horizontal equivalents',
    wp: 'WP4a',
    run(app, assert) {
      const ps = app.win.PRiSM_pseudoSkin;
      ['bronsMarting', 'cincoLey', 'fracture', 'horizontalEquivalent'].forEach((k) => assert.fn(ps[k], k));
      assert.near(ps.bronsMarting(0.2, 35, 0.354, 1), 10.79, 0.02);
      assert.near(ps.bronsMarting(0.5, 35, 0.354, 1), 3.05, 0.02);
      assert.near(ps.bronsMarting(0.2, (35 / 0.354)), 10.79, 0.02, 'two-argument (b, hD) form');
      assert.equal(ps.bronsMarting(1, 98.9), 0, 'full penetration → 0');
      assert.near(ps.fracture(100, 0.354, 'infinite'), Math.log(2 * 0.354 / 100), 1e-12);
      assert.near(ps.fracture(100, 0.354, 'uniformFlux'), Math.log(Math.E * 0.354 / 100), 1e-12);
      assert.near(ps.fracture(100, 0.354, 'finite', 1e6), Math.log(2 * 0.354 / 100), 0.05, 'finite → infinite as FcD → ∞');
      assert.ok(ps.fracture(100, 0.354, 'finite', 1) > ps.fracture(100, 0.354, 'finite', 100), 'low FcD less stimulating');
      const heq = ps.horizontalEquivalent(2000, 50, 0.354, 0.1);
      assert.ok(Number.isFinite(heq) && heq < -4, 'long horizontal well is strongly stimulating: ' + heq);
      assert.ok(Number.isFinite(app.win.PRiSM_MODELS.horizontal.equivalentSkin({ L_to_h: 40, KvKh: 0.1 }, { h: 50, rw: 0.354 })));
    },
  },
  // ── shared contract / registry metadata ─────────────────────────────────
  {
    name: 'contract: registry metadata (refLength, defaultFrozen, log scale, timeInput, kind) on every 03 model',
    wp: 'WP4a',
    run(app, assert) {
      const M = app.win.PRiSM_MODELS;
      const ref = { homogeneous: 'rw', infiniteFrac: 'xf', finiteFrac: 'xf', inclined: 'rw', horizontal: 'Lh',
        linearBoundary: 'rw', parallelChannel: 'rw', closedChannel3: 'rw', closedRectangle: 'rw',
        intersecting: 'rw', fogBoundary: 'rw', finiteFracSkin: 'xf', partialPenFrac: 'xf' };
      const logKeys = /^(Cd|dF|dF1|dF2|dEnd|dN|dS|dE|dW|FcD|L_to_h|KvKh)$/;
      for (const key of MODELS_03) {
        const m = M[key];
        assert.equal(m.refLength, ref[key], key + ' refLength');
        assert.ok(Array.isArray(m.defaultFrozen), key + ' defaultFrozen');
        assert.equal(m.timeInput, 'td', key + ' timeInput');
        assert.equal(m.kind, 'pressure', key + ' kind');
        for (const ps of m.paramSpec) {
          if (logKeys.test(ps.key)) assert.equal(ps.scale, 'log', key + '.' + ps.key + ' log scale');
          assert.ok(ps.key in m.defaults, key + '.' + ps.key + ' has a default');
        }
        const both = m.paramSpec.some((s) => s.key === 'S_perf') && m.paramSpec.some((s) => s.key === 'S_global');
        if (both) assert.ok(m.defaultFrozen.includes('S_global'), key + ' freezes S_global');
        for (const f of m.defaultFrozen) assert.ok(m.paramSpec.some((s) => s.key === f), key + ' frozen key ' + f + ' exists');
      }
      assert.ok(/leaky fault/i.test(M.fogBoundary.description), 'fogBoundary relabelled');
      assert.equal(M.homogeneous.pd, app.win.PRiSM_model_homogeneous_rwa, '03 owns the homogeneous entry');
    },
  },
  {
    name: 'contract: PRiSM_evalWbsSkin / PRiSM_pd_lap_homogeneous exports (fold, S<0 transform, storage guard)',
    wp: 'WP4a',
    run(app, assert) {
      const w = app.win;
      assert.fn(w.PRiSM_evalWbsSkin);
      assert.fn(w.PRiSM_pd_lap_homogeneous);
      // K0(1)/K1(1) at s = 1
      assert.near(w.PRiSM_pd_lap_homogeneous(1), 0.42102443824070834 / 0.6019072301972346, 1e-12);
      const td = [0.1, 10, 1e3, 1e5];
      // evalWbsSkin with the homogeneous kernel reproduces the registry entry
      const a = w.PRiSM_evalWbsSkin(w.PRiSM_pd_lap_homogeneous, td, 100, -2);
      const b = w.PRiSM_MODELS.homogeneous.pd(td, { Cd: 100, S: -2 });
      td.forEach((t, i) => assert.near(a[i], b[i], 1e-12));
      // S < 0: dScale = e^S is handed to the callback (rw-scaled distances)
      let seen = null;
      w.PRiSM_evalWbsSkin((s, d) => { seen = d; return w.PRiSM_pd_lap_homogeneous(s); }, 100, 10, -1.5);
      assert.near(seen, Math.exp(-1.5), 1e-15);
      w.PRiSM_evalWbsSkin((s, d) => { seen = d; return w.PRiSM_pd_lap_homogeneous(s); }, 100, 10, -1.5, { scaleDistances: false });
      assert.equal(seen, 1);
      // derivative option = td·d(pd)/d(td) (central difference check)
      const t = 50, h = 1e-3;
      const up = w.PRiSM_evalWbsSkin(w.PRiSM_pd_lap_homogeneous, t * Math.exp(h), 20, 1);
      const dn = w.PRiSM_evalWbsSkin(w.PRiSM_pd_lap_homogeneous, t * Math.exp(-h), 20, 1);
      assert.rel(w.PRiSM_evalWbsSkin(w.PRiSM_pd_lap_homogeneous, t, 20, 1, { derivative: true }), (up - dn) / (2 * h), 1e-3);
      // scalar in → scalar out; td <= 0 → 0; NaN params rejected
      assert.equal(typeof w.PRiSM_MODELS.homogeneous.pd(1, { Cd: 1, S: 0 }), 'number');
      assert.equal(w.PRiSM_MODELS.homogeneous.pd(0, { Cd: 1, S: 0 }), 0);
      assert.throws(() => w.PRiSM_MODELS.homogeneous.pd(1, { Cd: 1, S: NaN }));
      // missing shape params fall back to the registry defaults
      assert.doesNotThrow(() => w.PRiSM_MODELS.inclined.pd([1, 10], { Cd: 10, S_perf: 0 }));
    },
  },
  {
    name: 'no console errors or pending timers from 03 at load',
    wp: 'WP4a',
    run(app, assert) {
      const errs = app.consoleErrors().filter((e) => /03-models|PRiSM 03/.test(String(e)));
      assert.equal(errs.length, 0, errs.join('\n'));
      const mine = app.timers().filter((t) => /03-models/.test(String(t.where || '')));
      assert.equal(mine.length, 0, 'no timers created by 03');
    },
  },
];
