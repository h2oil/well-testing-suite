// Well Performance vertical lift, increment B — WP21: Orkiszewski, Aziz-Govier-Fogarasi, Mukherjee-Brill, Ansari et al., Hasan-Kabir
// and per-section correlations. docs/WELL-PERFORMANCE-PLAN.md §3.4, §4.4, §15.1 (D17 gate; Q9: no books → every method provisional,
// its explicit equations pinned by hand calculations), §15.2 (cross-checks), §17.3 (wellperf-mech).
//
// VM1  registry: the five keys merged into WTS_flowline_corr (earlier entries and the Beggs & Brill default unchanged), provisional
//      with §15.1 BENCH entries (gate passes), kinds / vertical flags / map kinds, no default model carries sections
// VM2  Orkiszewski by hand: Griffith bubble = the Hagedorn & Brown bubble branch; slug: the v_b iteration, Γ (oil / water, both
//      velocity branches and the lower limit), ρ_s and the friction term; transition / mist = the Duns & Ros regions
// VM3  Aziz-Govier-Fogarasi by hand: N_x / N_y, N1-N3 and the pattern; bubble and slug holdups and friction; the transition blend is
//      continuous at N2 and N3
// VM4  Mukherjee-Brill by hand: boundaries (uphill / downhill), the three holdup coefficient sets, the annular f_R table, the stratified
//      geometry (δ from H_L) and wall shears
// VM5  Ansari by hand: pattern rules, bubble holdup residual, slug unit (H_LLS, film balance, β), annular film equation residual and
//      the core gradient
// VM6  Hasan-Kabir by hand: drift velocities with inclination, pattern thresholds, void fraction per pattern, annular Lockhart-Martinelli
//      void fraction and the interfacial friction
// VM7  cross-checks on the deviated path: single-phase water at rate = Darcy-Weisbach, top-down / bottom-up agreement (0.5 psi), each
//      new correlation solves FIX.oilWell and FIX.gasWell (the water column and the dry-gas closed form: wellperf-validate X1 / X2)
// VM8  per-section correlations: normSections, MD splits, inclination bands, first row wins, identities (one section over the path =
//      that correlation, base key only = no sections), per-section warnings, profile / segment corr, runs, the marcher's segment.corr
//      (unknown key refused), the system / match / check / model contracts
// VM9  patternMap: kinds and axes, the station classification = the correlation's own gradient pattern, the boundary lines
// VM10 page: per-section editor (presets, rows, Covers cells, section bar), schematic band, comparison with the per-section row and
//      pure rows, pattern strips, map switch, section knobs on the traverse with a live drag, case summary in #wp_res, no NaN
'use strict';

const S = require('./_wellperf-shapes');

const WP = 'WP21';
const PATM = 14.696, GC = 32.174, G0 = 32.174, SIG = 0.00220462, MU = 6.7197e-4;
const PROV = 'provisional — not verified against a published example';
const NEW = ['ork', 'agf', 'mb', 'ansari', 'hk'];
const app = (ctx) => S.sharedApp(ctx);
const plain = (x) => JSON.parse(JSON.stringify(x));
function gIn(o) { return Object.assign({ vsl: 2, vsg: 6, d: 2.441, rhoL: 50, rhoG: 5, muL: 2, muG: 0.015, sigma: 25, theta: 90, rough: 0.0006, p: 1500, payne: true, accel: false }, o || {}); }
function colebrook(nre, e) {
  if (nre < 2000) return 64 / nre;
  let x = -2 * Math.log10(e / 3.7 + 5.74 / Math.pow(nre, 0.9));
  for (let k = 0; k < 100; k++) x = -2 * Math.log10(e / 3.7 + 2.51 * x / nre);
  return 1 / (x * x);
}
function groups(i) {
  const dFt = i.d / 12, q4 = Math.pow(i.rhoL / i.sigma, 0.25);
  return { NLv: 1.938 * i.vsl * q4, Ngv: 1.938 * i.vsg * q4, Nd: 120.872 * dFt * Math.sqrt(i.rhoL / i.sigma),
    NL: 0.15726 * i.muL * Math.pow(1 / (i.rhoL * Math.pow(i.sigma, 3)), 0.25), dFt };
}
function devW(id, inc) {
  const kop = 2000, slant = 4000, tail = 3000, segs = []; let tvd = 0;
  [[0, kop, 0], [kop, kop + slant, inc], [kop + slant, kop + slant + tail, 0]].forEach(([a, b, i]) => {
    for (let m = a; m < b; m += 500) {
      const len = Math.min(500, b - m), dz = len * Math.cos(i * Math.PI / 180);
      segs.push({ name: 'Tubing', len, id, dz, md0: m + len, md1: m, tvd0: tvd + dz, tvd1: tvd, inc: i, rough: 0.0006 });
      tvd += dz;
    }
  });
  return { segments: segs.reverse(), tAt: (md) => 100 + 100 * md / 9000 };
}
const oilF = (o) => Object.assign({ ok: true, type: 'oil', rateBasis: 'liquid', api: 35, sgg: 0.65, sgw: 1.07, gor: 500, wc: 0.3, cgr: 0, wgr: 0, refQ: 1000, pvt: {} }, o || {});

module.exports = [
  {
    name: 'VM1 registry: Orkiszewski, AGF, Mukherjee-Brill, Ansari, Hasan-Kabir merged and provisional (D17 gate with BENCH entries); kinds, vertical flags, map kinds; defaults unchanged, no default sections',
    wp: WP,
    run(_a, assert, ctx) {
      const A = app(ctx), G = A.win, C = G.WTS_flowline_corr, V = G.WTS_wp_vlp;
      ['bb', 'hb', 'gray', 'nsl', 'single', 'gasTZ', 'dr', 'gasCS'].concat(NEW).forEach((k) => assert.fn(C[k].grad, k + ' registered'));
      NEW.forEach((k) => {
        assert.strictEqual(C[k].verified, false, k + ' verified:false');
        assert.strictEqual(C[k].provisional, PROV, k + ' label');
        const l = V.list().find((x) => x.key === k);
        assert.ok(l && l.provisional === PROV, k + ' list label');
      });
      assert.deepStrictEqual(plain(NEW.map((k) => C[k].kind)), ['well', 'well', 'any', 'well', 'well'], 'kinds (Mukherjee-Brill also for flowlines)');
      assert.deepStrictEqual(NEW.map((k) => !!C[k].vertical), [true, true, false, true, false], 'vertical-only flags');
      assert.deepStrictEqual(NEW.map((k) => C[k].map), ['ros', 'agf', 'mb', 'mech', 'mech'], 'map kinds');
      ['oil', 'gas', 'condensate', 'water'].forEach((t) => assert.strictEqual(V.defaultCorr(t).key, 'bb', 'default stays Beggs & Brill for ' + t));
      assert.deepStrictEqual(plain(G.WTS_wp_model.DEFAULTS.system.corr.sections), [], 'no default sections');
      assert.ok(G.WTS_wp_model.TABLE_KEYS.indexOf('corrSections') !== -1, 'corrSections table key');
      const VV = require('../wellperf-validate');
      NEW.forEach((k) => assert.ok(VV.BENCH.some((b) => b.kind === 'corr' && b.key === k && b.status === 'pending'), k + ' BENCH pending'));
      const g = VV.gate(G);
      assert.ok(g.ok, 'gate: ' + g.errors.join('; '));
      ['normSections', 'sectionsFor', 'patternMap', 'agfMap', 'mbPattern', 'mbHoldup', 'mbFr', 'orkGamma', 'ansariPattern', 'hkPattern'].forEach((f) => assert.fn(V[f], f));
    },
  },
  {
    name: 'VM2 Orkiszewski by hand: Griffith bubble, slug (v_b iteration, Γ oil / water both branches, lower limit, ρ_s, friction), Duns & Ros transition and mist',
    wp: WP,
    run(_a, assert, ctx) {
      const G = app(ctx).win, C = G.WTS_flowline_corr, V = G.WTS_wp_vlp;
      // bubble: λ_g below L_B → the Hagedorn & Brown bubble branch exactly
      const ib = gIn({ vsl: 6, vsg: 0.5 }), gb = C.ork.grad(ib), hb = C.hb.grad(ib);
      assert.strictEqual(gb.pattern, 'bubble'); assert.rel(gb.hl, hb.hl, 1e-12, 'bubble holdup'); assert.rel(gb.gradF, hb.gradF, 1e-12, 'bubble friction');
      // slug by hand
      const i = gIn({ vsl: 2, vsg: 6, props: { fw: 0 } }), g = C.ork.grad(i), gp = groups(i), d = gp.dFt;
      assert.strictEqual(g.pattern, 'slug'); assert.ok(gp.Ngv < 50 + 36 * gp.NLv, 'below L_S');
      const vm = 8, nreL = 1488 * 50 * vm * d / 2, sq = Math.sqrt(G0 * d);
      let vb = 0.5 * sq;
      for (let k = 0; k < 200; k++) {
        const nb = 1488 * 50 * vb * d / 2;
        let v2; if (nb <= 3000) v2 = (0.546 + 8.74e-6 * nreL) * sq; else if (nb >= 8000) v2 = (0.35 + 8.74e-6 * nreL) * sq;
        else { const vbs = (0.251 + 8.74e-6 * nreL) * sq; v2 = 0.5 * (vbs + Math.sqrt(vbs * vbs + 13.59 * 2 / (50 * Math.sqrt(d)))); }
        vb = 0.5 * (vb + v2);
      }
      assert.rel(g.vb, vb, 1e-6, 'v_b');
      const G0m = 0.0127 * Math.log10(3) / Math.pow(d, 1.415) - 0.284 + 0.167 * Math.log10(vm) + 0.113 * Math.log10(d);
      assert.rel(g.Gamma0, G0m, 1e-12, 'Γ oil, v_m < 10');
      const rs0 = (50 * (2 + vb) + 5 * 6) / (vm + vb), Gm = Math.max(G0m, -0.065 * vm);
      const rhoS = Math.min(50, Math.max(5, rs0 + Gm * 50));
      assert.rel(g.rhoS, rhoS, 1e-9, 'ρ_s');
      // review fix (v4.5): the published ρ_s is not held at the no-slip density — hand point vsl 2, vsg 3 ft/s: Γ −0.1878, v_b 1.741 ft/s,
      // ρ_s ≈ 20.6 lbm/ft³ (no-slip 23.0), elevation gradient ≈ 0.143 psi/ft
      const h = C.ork.grad(gIn({ vsl: 2, vsg: 3, props: { fw: 0 } }));
      assert.strictEqual(h.pattern, 'slug');
      assert.ok(Math.abs(h.Gamma - (-0.1878)) < 5e-4, 'Γ ' + h.Gamma); assert.ok(Math.abs(h.vb - 1.741) < 2e-3, 'v_b ' + h.vb);
      assert.ok(Math.abs(h.rhoS - 20.6) < 0.1 && h.rhoS < 50 * 0.4 + 5 * 0.6, 'ρ_s below no-slip ' + h.rhoS);
      assert.ok(Math.abs(h.gradEl - 0.143) < 0.002, 'elevation ' + h.gradEl);
      const f = colebrook(nreL, 0.0006 / 12 / d);
      assert.rel(g.gradF, f * 50 * vm * vm / (2 * GC * d) * ((2 + vb) / (vm + vb) + Gm) / 144, 1e-6, 'slug friction');
      assert.ok(Math.abs(g.gradAcc) < 1e-15 && g.Ek === 0, 'no acceleration term');
      // Γ: the other three formulas
      const dd = 0.2, lm = Math.log10(2), lm1 = Math.log10(3);
      assert.rel(V.orkGamma(5, dd, 2, true), 0.013 * lm / Math.pow(dd, 1.38) - 0.681 + 0.232 * Math.log10(5) - 0.428 * Math.log10(dd), 1e-12, 'Γ water < 10');
      assert.rel(V.orkGamma(15, dd, 2, true), 0.045 * lm / Math.pow(dd, 0.799) - 0.709 - 0.162 * Math.log10(15) - 0.888 * Math.log10(dd), 1e-12, 'Γ water ≥ 10');
      assert.rel(V.orkGamma(15, dd, 2, false), 0.0274 * lm1 / Math.pow(dd, 1.371) + 0.161 + 0.569 * Math.log10(dd) - Math.log10(15) * (0.01 * lm1 / Math.pow(dd, 1.571) + 0.397 + 0.63 * Math.log10(dd)), 1e-12, 'Γ oil ≥ 10');
      const gw = C.ork.grad(gIn({ vsl: 2, vsg: 6, props: { fw: 0.9 } }));
      assert.ok(gw.water === true && gw.Gamma0 !== g.Gamma0, 'water-continuous above 75 % water');
      // transition and mist: the Duns & Ros regions
      [gIn({ vsl: 0.5, vsg: 40 }), gIn({ vsl: 0.1, vsg: 120 })].forEach((x) => {
        const a = C.ork.grad(x), b = C.dr.grad(x);
        assert.ok(a.pattern === b.pattern && (a.pattern === 'mist' || a.pattern === 'transition'), 'D&R region ' + a.pattern);
        assert.strictEqual(a.grad, b.grad, 'same gradient'); assert.strictEqual(a.corr, 'ork');
      });
    },
  },
  {
    name: 'VM3 Aziz-Govier-Fogarasi by hand: map numbers and patterns, bubble and slug holdup / friction, the transition continuous at N2 and N3',
    wp: WP,
    run(_a, assert, ctx) {
      const G = app(ctx).win, C = G.WTS_flowline_corr, V = G.WTS_wp_vlp;
      const map = (i) => { const cL = Math.pow((i.rhoL / 62.4) * (72 / i.sigma), 0.25); return { Nx: i.vsg * Math.pow(i.rhoG / 0.0764, 1 / 3) * cL, Ny: i.vsl * cL }; };
      const i = gIn({ vsl: 2, vsg: 2 }), m = map(i), g = C.agf.grad(i);
      assert.rel(g.Nx, m.Nx, 1e-12, 'N_x'); assert.rel(g.Ny, m.Ny, 1e-12, 'N_y');
      assert.rel(g.N1, 0.51 * Math.pow(100 * m.Ny, 0.172), 1e-12, 'N1'); assert.rel(g.N2, 8.6 + 3.8 * m.Ny, 1e-12, 'N2'); assert.rel(g.N3, 70 * Math.pow(100 * m.Ny, -0.152), 1e-12, 'N3');
      const pat = (Nx, Ny) => { const N1 = 0.51 * Math.pow(100 * Ny, 0.172), N2 = 8.6 + 3.8 * Ny, N3 = 70 * Math.pow(100 * Ny, -0.152); return Nx < N1 ? 'bubble' : Ny < 4 ? (Nx < N2 ? 'slug' : Nx < N3 ? 'transition' : 'mist') : (Nx < 26.5 ? 'slug' : 'mist'); };
      [[6, 0.1], [2, 2], [0.5, 20], [2, 30], [1, 6]].forEach(([vsl, vsg]) => { const x = gIn({ vsl, vsg }), mm = map(x); assert.strictEqual(C.agf.grad(x).pattern, pat(mm.Nx, mm.Ny), 'pattern at ' + vsl + '/' + vsg); });
      // slug by hand
      const s = C.agf.grad(gIn({ vsl: 2, vsg: 3 })), d = 2.441 / 12, sM = 25 * SIG, dr = 45;
      assert.strictEqual(s.pattern, 'slug');
      const NE = G0 * d * d * dr / sM, Nv0 = 0, Nv = Math.sqrt(G0 * d ** 3 * 50 * dr) / (2 * MU), mm = Nv <= 18 ? 25 : Nv >= 250 ? 10 : 69 * Math.pow(Nv, -0.35);
      const Cc = 0.345 * (1 - Math.exp(-0.029 * Nv)) * (1 - Math.exp((3.37 - NE) / mm)), vbf = 1.2 * 5 + Cc * Math.sqrt(G0 * d * dr / 50), hl = Math.max(0.4, 1 - 3 / vbf);
      assert.rel(s.hl, hl, 1e-12, 'slug holdup');
      assert.rel(s.gradF, colebrook(1488 * 50 * 5 * d / 2, 0.0006 / 12 / d) * 50 * hl * 25 / (2 * GC * d) / 144, 1e-6, 'slug friction');
      // bubble by hand
      const bi = gIn({ vsl: 6, vsg: 0.1 }), b = C.agf.grad(bi), vbs = 1.41 * Math.pow(G0 * sM * dr / 2500, 0.25), hb = 1 - 0.1 / (1.2 * 6.1 + vbs);
      assert.strictEqual(b.pattern, 'bubble'); assert.rel(b.hl, hb, 1e-12, 'bubble holdup');
      // the transition blend reaches the slug value at N2 and the mist value at N3
      const at = (Nx) => { const x = gIn({ vsl: 1 }); const cL = Math.pow((x.rhoL / 62.4) * (72 / x.sigma), 0.25); x.vsg = Nx / (Math.pow(x.rhoG / 0.0764, 1 / 3) * cL); return C.agf.grad(x); };
      const g0 = C.agf.grad(gIn({ vsl: 1 })), N2 = g0.N2, N3 = g0.N3;
      assert.rel(at(N2 * (1 - 1e-9)).grad, at(N2 * (1 + 1e-9)).grad, 1e-6, 'continuous at N2');
      assert.rel(at(N3 * (1 - 1e-9)).grad, at(N3 * (1 + 1e-9)).grad, 1e-6, 'continuous at N3');
      assert.strictEqual(V.agfMap({ vsl: 1, vsg: 1, rL: 50, rG: 5, sig: 25 }).pattern !== undefined, true);
    },
  },
  {
    name: 'VM4 Mukherjee-Brill by hand: pattern boundaries uphill / downhill, the three holdup sets, the annular f_R table, the stratified geometry and wall shears',
    wp: WP,
    run(_a, assert, ctx) {
      const G = app(ctx).win, C = G.WTS_flowline_corr, V = G.WTS_wp_vlp, th = Math.PI / 4, s = Math.sin(th);
      const NLv = 2, Ngv = 5, NL = 0.01;
      const p = V.mbPattern(NLv, Ngv, NL, th);
      assert.rel(p.NgvSM, Math.pow(10, 1.401 - 2.694 * NL + 0.521 * Math.pow(NLv, 0.329)), 1e-12, 'slug / annular');
      assert.rel(p.NLvBS, Math.pow(10, Math.log10(Ngv) + 0.940 + 0.074 * s - 0.855 * s * s + 3.695 * NL), 1e-12, 'bubble / slug uphill (N_LvBS of N_gv)');
      assert.strictEqual(p.pattern, NLv > p.NLvBS ? 'bubble' : 'slug');
      // review fix (v4.5) hand point: vertical, N_Lv = N_gv = 1, N_L = 0.01 → N_LvBS = 10^0.19595 ≈ 1.57 > 1 → slug (the swapped form said bubble)
      const pv = V.mbPattern(1, 1, 0.01, Math.PI / 2);
      assert.rel(pv.NLvBS, Math.pow(10, 0.940 + 0.074 - 0.855 + 0.03695), 1e-12, 'N_LvBS vertical'); assert.strictEqual(pv.pattern, 'slug', 'hand point slug');
      assert.strictEqual(V.mbPattern(3, 1, 0.01, Math.PI / 2).pattern, 'bubble', 'more liquid → bubble');
      const pd = V.mbPattern(NLv, Ngv, NL, -th), lg = Math.log10(Ngv), lgL = Math.log10(NLv);
      assert.rel(pd.NgvBS, Math.pow(10, 0.431 - 3.003 * NL - 1.138 * lgL * -s - 0.429 * lgL * lgL * -s + 1.132 * -s), 1e-12, 'N_gvBS downhill (of N_Lv)');
      assert.rel(pd.NLvST, Math.pow(10, 0.321 - 0.017 * Ngv - 4.267 * -s - 2.972 * NL - 0.033 * lg * lg - 3.925 * s * s), 1e-12, 'N_LvST downhill');
      assert.strictEqual(V.mbPattern(0.05, 500, NL, th).pattern, 'annular');
      // holdup sets (Brill & Mukherjee coefficient table, pinned)
      const Cs = V.MB_C;
      assert.deepStrictEqual(plain(Cs.up), [-0.380113, 0.129875, -0.119788, 2.343227, 0.475686, 0.288657]);
      assert.deepStrictEqual(plain(Cs.downStrat), [-1.330282, 4.808139, 4.171584, 56.262268, 0.079951, 0.504887]);
      assert.deepStrictEqual(plain(Cs.downOther), [-0.516644, 0.789805, 0.551627, 15.519214, 0.371771, 0.393952]);
      const c = Cs.up, hl = Math.exp((c[0] + c[1] * s + c[2] * s * s + c[3] * NL * NL) * Math.pow(Ngv, c[4]) / Math.pow(NLv, c[5]));
      assert.rel(V.mbHoldup(NLv, Ngv, NL, th, 'up'), hl, 1e-12, 'uphill holdup');
      // f_R table: readings and log-linear interpolation
      assert.rel(V.mbFr(0.5), 1.30, 1e-12); assert.rel(V.mbFr(1), 1.0, 1e-12); assert.rel(V.mbFr(0.01), 1.0, 1e-12); assert.rel(V.mbFr(20), 1.0, 1e-12);
      assert.rel(V.mbFr(Math.sqrt(0.2 * 0.3)), 0.5 * (0.98 + 1.20), 1e-12, 'log-linear');
      // a gradient: uphill slug by hand
      const i = gIn({ vsl: 2, vsg: 6, theta: 45 }), gp = groups(i), g = C.mb.grad(i);
      const h2 = Math.max(0.25, V.mbHoldup(gp.NLv, gp.Ngv, gp.NL, th, 'up')), rhoS = 50 * h2 + 5 * (1 - h2);
      assert.rel(g.hl, h2, 1e-12, 'holdup in the gradient'); assert.rel(g.gradEl, rhoS * s / 144, 1e-12, 'elevation on the true inclination');
      const rn = 50 * 0.25 + 5 * 0.75, mn = 2 * 0.25 + 0.015 * 0.75, d = 2.441 / 12;
      if (g.pattern !== 'annular' && g.pattern !== 'stratified') assert.rel(g.gradF, colebrook(1488 * rn * 8 * d / mn, 0.0006 / 12 / d) * rhoS * 64 / (2 * GC * d) / 144, 1e-6, 'bubble / slug friction');
      // stratified (level pipe, low liquid number): the geometry closes and the wall shears add up
      const st = C.mb.grad(gIn({ vsl: 0.05, vsg: 3, theta: 0 }));
      assert.strictEqual(st.pattern, 'stratified');
      assert.rel((st.delta - Math.sin(st.delta)) / (2 * Math.PI), st.hl, 1e-9, 'H_L = (δ − sin δ)/2π');
      const A0 = Math.PI * d * d / 4, PL = st.delta * d / 2, Pg = (2 * Math.PI - st.delta) * d / 2;
      assert.rel(st.gradF, (st.tauL * PL + st.tauG * Pg) / A0 / 144, 1e-12, 'wall shears');
      assert.strictEqual(st.set, 'up', 'level pipe takes the uphill set');
      const sd = C.mb.grad(gIn({ vsl: 0.05, vsg: 3, theta: -30 }));
      assert.ok(sd.set === 'downStrat' || sd.set === 'downOther', 'downhill sets');
      // annular friction = f_R·f_n
      const an = C.mb.grad(gIn({ vsl: 0.05, vsg: 80, theta: 90 }));
      assert.strictEqual(an.pattern, 'annular'); assert.rel(an.fR, V.mbFr(an.HR), 1e-12, 'f_R at H_R');
    },
  },
  {
    name: 'VM5 Ansari by hand: pattern rules, bubble holdup residual, slug unit (H_LLS, film balance, β, ρ_s, friction), annular film equation and core gradient',
    wp: WP,
    run(_a, assert, ctx) {
      const G = app(ctx).win, C = G.WTS_flowline_corr, V = G.WTS_wp_vlp, d = 2.441 / 12, sM = 25 * SIG, dr = 45;
      const vs = 1.53 * Math.pow(G0 * sM * dr / 2500, 0.25), vsgA = 3.1 * Math.pow(G0 * sM * dr / 25, 0.25);
      const P = V.ansariPattern(gIn({ vsl: 2, vsg: 6 }));
      assert.rel(P.vs, vs, 1e-12, 'bubble rise'); assert.rel(P.vsgA, vsgA, 1e-12, 'annular limit'); assert.rel(P.vsgBS, 0.25 * vs + 0.333 * 2, 1e-12, 'bubble / slug');
      // bubble
      const b = C.ansari.grad(gIn({ vsl: 3, vsg: 0.3 }));
      assert.strictEqual(b.pattern, 'bubble');
      assert.ok(Math.abs(0.3 / (1 - b.hl) - 1.2 * 3.3 - vs * Math.sqrt(b.hl)) < 1e-6, 'bubble holdup residual');
      // slug
      const s = C.ansari.grad(gIn({ vsl: 1, vsg: 2 }));
      assert.strictEqual(s.pattern, 'slug');
      const vm = 3, vTB = 1.2 * vm + 0.35 * Math.sqrt(G0 * d * dr / 50), HLLS = 1 / (1 + Math.pow(vm / 28.4, 1.39));
      assert.rel(s.vTB, vTB, 1e-12); assert.rel(s.HLLS, HLLS, 1e-12);
      const vgLS = 1.2 * vm + vs * Math.sqrt(HLLS), vLLS = (vm - vgLS * (1 - HLLS)) / HLLS;
      const film = (vTB + 9.916 * Math.sqrt(G0 * d * (1 - Math.sqrt(1 - s.HLTB)))) * s.HLTB - (vTB - vLLS) * HLLS;
      assert.ok(Math.abs(film) < 1e-8, 'film mass balance ' + film);
      const beta = (2 - vgLS * (1 - HLLS)) / (vTB * (1 - s.HLTB) - vgLS * (1 - HLLS));
      assert.rel(s.beta, Math.min(1, Math.max(0, beta)), 1e-12, 'β');
      const rLS = 50 * HLLS + 5 * (1 - HLLS);
      assert.rel(s.rhoS, (1 - s.beta) * rLS + s.beta * 5, 1e-12, 'ρ_s');
      // annular
      const a = C.ansari.grad(gIn({ vsl: 0.2, vsg: 30 }));
      assert.strictEqual(a.pattern, 'annular');
      const w = 4 * a.delta * (1 - a.delta), res = a.YM - a.Z / (w * Math.pow(1 - w, 2.5)) + a.XM2 / (w * w * w);
      assert.ok(Math.abs(res) < 1e-6 * Math.max(1, a.XM2 / (w * w * w)), 'film equation residual ' + res);
      assert.rel(a.gradEl, a.rhoC / 144, 1e-12, 'core elevation (vertical)');
      assert.rel(a.hl, 4 * a.delta * (1 - a.delta) + a.lambdaLC * Math.pow(1 - 2 * a.delta, 2), 1e-12, 'holdup');
      // dispersed bubble at a high mixture velocity and little gas
      assert.strictEqual(C.ansari.grad(gIn({ vsl: 25, vsg: 2 })).pattern, 'dispersed bubble');
    },
  },
  {
    name: 'VM6 Hasan-Kabir by hand: drift velocities and inclination, pattern thresholds, void fraction per pattern, annular void fraction and friction',
    wp: WP,
    run(_a, assert, ctx) {
      const G = app(ctx).win, C = G.WTS_flowline_corr, V = G.WTS_wp_vlp, d = 2.441 / 12, sM = 25 * SIG, dr = 45;
      const th = 60 * Math.PI / 180, P = V.hkPattern(gIn({ vsl: 2, vsg: 3, theta: 60 }));
      const vinf = 1.53 * Math.pow(G0 * sM * dr / 2500, 0.25), vinfT = 0.35 * Math.sqrt(G0 * d * dr / 50) * Math.sqrt(Math.sin(th)) * Math.pow(1 + Math.cos(th), 1.2);
      assert.rel(P.vinf, vinf, 1e-12); assert.rel(P.vinfT, vinfT, 1e-12, 'Taylor bubble with inclination');
      assert.rel(P.vsgB, 0.429 * 2 + 0.357 * vinf * Math.sin(th), 1e-12); assert.rel(P.vsgC, 1.083 * 2 + 0.52 * vinfT, 1e-12);
      assert.strictEqual(V.hkPattern(gIn({ vsl: 2, vsg: 3, theta: 0 })).vinfT, 0, 'no Taylor drift at horizontal');
      const nuL = 2e-3 / (50 * 16.0185), vDB = 4 * Math.pow(d * 0.3048, 0.429) * Math.pow(25e-3 / (50 * 16.0185), 0.089) / Math.pow(nuL, 0.072) * Math.pow(9.80665 * dr / 50, 0.446) / 0.3048;
      assert.rel(P.vDB, vDB, 1e-12, 'dispersed-bubble velocity');
      const g = C.hk.grad(gIn({ vsl: 2, vsg: 3, theta: 60 }));
      assert.strictEqual(g.pattern, P.pattern);
      const C0 = g.pattern === 'churn' ? 1.15 : 1.2, vd = (g.pattern === 'slug' || g.pattern === 'churn') ? vinfT : vinf * Math.sin(th);
      assert.rel(g.hl, Math.max(0.4, 1 - 3 / (C0 * 5 + vd)), 1e-12, 'void fraction');
      // annular
      const a = C.hk.grad(gIn({ vsl: 0.2, vsg: 40 }));
      assert.strictEqual(a.pattern, 'annular');
      const fSL = colebrook(1488 * 50 * 0.2 * d / 2, 0.0006 / 12 / d), fSG = colebrook(1488 * 5 * 40 * d / 0.015, 0.0006 / 12 / d);
      const X = Math.sqrt(fSL * 50 * 0.04 / (fSG * 5 * 1600)), al = Math.pow(1 + Math.pow(X, 0.8), -0.378);
      assert.rel(a.X, X, 1e-6, 'Lockhart-Martinelli X'); assert.rel(1 - a.hl, Math.min(al, 1 - 0.2 / 40.2), 1e-6, 'annular void fraction');
      assert.rel(a.gradF, a.fi * a.rhoC * a.vc * a.vc / (2 * GC * d) / 144, 1e-12, 'interfacial friction');
    },
  },
  {
    name: 'VM7 cross-checks on the deviated path: single-phase water at rate = Darcy-Weisbach, direction agreement; the five solve both fixtures (provisional, vertical-only warning) — water column / dry gas in wellperf-validate X1 / X2',
    wp: WP,
    run(_a, assert, ctx) {
      const G = app(ctx).win, V = G.WTS_wp_vlp, SY = G.WTS_wp_system;
      // (the full cross-checks X1, X2, X22–X24 run in wellperf-validate --check; here the cheap ones on the deviated test path)
      const W = devW(2.441, 50), Fw = Object.assign(oilF({ type: 'water', rateBasis: 'water', wc: 1, gor: 0 }), { pvt: { liquidNoTransfer: true, bc: 1 } });
      const ref = V.traverse(Fw, W, 3000, { from: 'top', p0: 200, corr: 'single' });
      NEW.forEach((k) => {
        const t = V.traverse(Fw, W, 3000, { from: 'top', p0: 200, corr: k });
        assert.rel(t.pEnd, ref.pEnd, 1e-9, k + ' single-phase water = Darcy-Weisbach');
        const d = V.traverse(oilF(), W, 800, { from: 'top', p0: 300, corr: k }), u = V.traverse(oilF(), W, 800, { from: 'bottom', p0: d.pEnd, corr: k });
        assert.ok(d.ok && u.ok && Math.abs(u.pEnd - 300) < 0.5, k + ' direction agreement ' + (u.pEnd - 300));
      });
      NEW.forEach((k) => {
        ['oilWell', 'gasWell'].forEach((fx) => {
          const M = S.FIX[fx]; M.system.corr.well = k;
          const R = SY.solve(M);
          assert.ok(R.ok && R.op.q > 0, k + ' solves ' + fx + ' ' + (R.errors || []).join(' '));
          assert.ok(R.flags.some((f) => f.code === 'PROVISIONAL'), k + ' provisional flag');
          if (fx === 'gasWell' && G.WTS_flowline_corr[k].vertical) assert.ok((R.traverse.warnings || []).some((w) => w.code === 'VERTICAL_ONLY'), k + ' vertical-only warning');
        });
      });
      // Mukherjee-Brill as the flowline correlation (kind any)
      const Ml = S.FIX.oilWell; Ml.system.corr.line = 'mb';
      assert.ok(SY.solve(Ml).ok, 'Mukherjee-Brill on the flowline');
      void V;
    },
  },
  {
    name: 'VM8 per-section correlations: normalising, MD splits, inclination bands, first row wins, identities, warnings, profile / segment keys, runs; marcher segment.corr; system, match, check and model contracts',
    wp: WP,
    run(_a, assert, ctx) {
      const A = app(ctx), G = A.win, V = G.WTS_wp_vlp, SY = G.WTS_wp_system, F = oilF(), W = devW(2.441, 50);
      const n = V.normSections([{ by: 'md', from: 0, to: 1000, corr: 'mb' }, { by: 'inc', from: 30, corr: 'zz' }, { by: 'inc', from: 40, to: 20, corr: 'hk' }, { corr: 'hk' }]);
      assert.strictEqual(n.rows.length, 2, 'two valid rows'); assert.strictEqual(n.warnings.filter((w) => w.code === 'SECTION_SKIPPED').length, 2, 'skipped rows warned');
      assert.strictEqual(n.rows[1].to, Infinity, 'open MD interval');
      // MD split + inclination band, first row wins
      const secs = [{ by: 'md', from: 3200, to: 4700, corr: 'ansari' }, { by: 'inc', from: 30, to: 180, corr: 'mb' }];
      const tr = V.traverse(F, W, 800, { from: 'top', p0: 300, corr: 'hb', sections: secs });
      assert.ok(tr.ok && tr.sections, 'traverse with sections');
      assert.deepStrictEqual(plain(tr.sections.map((r) => [r.corr, Math.round(r.mdTop), Math.round(r.mdBot)])), [['hb', 0, 2000], ['mb', 2000, 3200], ['ansari', 3200, 4700], ['mb', 4700, 6000], ['hb', 6000, 9000]], 'runs');
      assert.ok(tr.segments.every((s) => s.corr) && tr.profile.filter((r) => !r.restr).every((r) => r.corr), 'keys on segments and rows');
      const len = tr.segments.reduce((a, s) => a + s.len, 0); assert.rel(len, 9000, 1e-12, 'split lengths add up');
      const sp = tr.segments.find((s) => Math.abs(s.mdTop - 3000) < 1e-6);
      assert.ok(sp && Math.abs(sp.tvdBot - (2000 + 1200 * Math.cos(50 * Math.PI / 180))) < 1e-6, 'split TVD on the straight segment');
      assert.ok(tr.warnings.some((w) => w.code === 'VERTICAL_ONLY' && /Ansari/.test(w.msg) && /section/.test(w.msg)), 'vertical-only on the Ansari section');
      ['Hagedorn', 'Mukherjee', 'Ansari'].forEach((x) => assert.ok(tr.warnings.some((w) => w.code === 'PROVISIONAL' && w.msg.indexOf(x) === 0), x + ' provisional'));
      // identities
      const a = V.traverse(F, W, 800, { from: 'top', p0: 300, corr: 'mb' }), b = V.traverse(F, W, 800, { from: 'top', p0: 300, corr: 'hb', sections: [{ by: 'inc', from: 0, to: 180, corr: 'mb' }] });
      assert.strictEqual(b.pEnd, a.pEnd, 'one section over the path = that correlation');
      const c0 = V.traverse(F, W, 800, { from: 'top', p0: 300, corr: 'hb' }), c1 = V.traverse(F, W, 800, { from: 'top', p0: 300, corr: 'hb', sections: [] });
      assert.strictEqual(c1.pEnd, c0.pEnd); assert.ok(!('sections' in c1) && !('corr' in c1.profile[1]), 'no sections → the A2 result shape');
      const e = V.traverse(F, W, 800, { from: 'top', p0: 300, corr: 'hb', sections: [{ by: 'md', from: 20000, to: 30000, corr: 'mb' }] });
      assert.ok(e.warnings.some((w) => w.code === 'SECTION_EMPTY'), 'empty section warned');
      // bottom-up with sections agrees
      const up = V.traverse(F, W, 800, { from: 'bottom', p0: tr.pEnd, corr: 'hb', sections: secs });
      assert.ok(Math.abs(up.pEnd - 300) < 0.5, 'direction agreement with sections ' + up.pEnd);
      const sf = V.sectionsFor(W, secs, 'hb'); assert.strictEqual(sf.runs.length, 5); assert.strictEqual(sf.runs[2].row, 0, 'run → row');
      // the marcher's segment.corr
      const m = G.WTS_flowline_march([{ len: 1000, id: 2.441, dz: 1000, corr: 'nope' }], { qo: 1, qw: 0, qg: 0.1, api: 35, sgg: 0.65, sgw: 1.07 }, 100, 100, 150, {});
      assert.strictEqual(m.code, 'UNKNOWN_CORR', 'unknown segment key refused');
      // system
      const M = S.FIX.gasWell; M.system.corr.sections = [{ by: 'inc', from: 30, to: 180, corr: 'mb' }];
      const R = SY.solve(M);
      assert.ok(R.ok && R.traverse.sections && R.traverse.sections.some((x) => x.corr === 'mb'), 'the solve marches the sections');
      assert.deepStrictEqual(plain(R.corr.sections), [{ by: 'inc', from: 30, to: 180, corr: 'mb' }], 'R.corr.sections');
      assert.ok(R.flags.some((f) => f.code === 'PROVISIONAL' && /section/.test(f.msg)), 'section provisional flag');
      const R0 = SY.solve(S.FIX.gasWell); assert.ok(!('sections' in R0.corr), 'no sections key without sections');
      const Mo = S.FIX.oilWell; Mo.system.corr.sections = [{ by: 'md', from: 0, to: 2000, corr: 'gasTZ' }];
      assert.strictEqual(SY.solve(Mo).code, 'CORR_NOT_APPLICABLE', 'dry-gas key in an oil section refused');
      const ck = G.WTS_wp_check(Mo); assert.ok(ck.items.some((x) => x.code === 'CORR_NOT_APPLICABLE' && x.field === 'wp_sections'), 'check error');
      const M2 = S.FIX.gasWell; M2.system.corr.sections = [{ by: 'inc', from: 40, to: 180, corr: 'ansari' }];
      const v = G.WTS_wp_check(M2).validity.find((x) => x.section === 1);
      assert.ok(v && v.corr === 'ansari' && v.provisional && v.inRange === false, 'validity per section (vertical-only above 30°)');
      // match: pure comparison rows, the model's sections for the model's own correlation
      const Mm = S.FIX.oilWell; Mm.system.corr.well = 'hb'; Mm.system.corr.sections = [{ by: 'md', from: 0, to: 4000, corr: 'mb' }];
      const t = S.FIX.test1, cmp = G.WTS_wp_match.compare(Mm, t, ['hb']), cmp0 = G.WTS_wp_match.compare(S.FIX.oilWell, t, ['hb']);
      if (cmp.ok && cmp0.ok) assert.strictEqual(cmp.rows[0].pCalc, cmp0.rows[0].pCalc, 'comparison rows are pure');
      // model round trip
      const st = A.storage, MD = G.WTS_wp_model, w = MD.write({ corrSections: [{ by: 'inc', from: 30, to: 180, corr: 'mb' }, { by: 'bad', from: 0, to: 100, corr: 'hk' }, { by: 'md', from: 10, to: 5, corr: 'hk' }, { corr: '<x>' }] });
      assert.ok(w.ok, 'write');
      assert.deepStrictEqual(plain(MD.read().system.corr.sections), [{ by: 'inc', from: 30, to: 180, corr: 'mb' }, { by: 'md', from: 0, to: 100, corr: 'hk' }], 'validated rows read back');
      MD.write({ corrSections: [] }); void st;
    },
  },
  {
    name: 'VM9 patternMap: kinds and axes, each station classified by the map correlation itself (= its gradient pattern), boundary lines and labels',
    wp: WP,
    run(_a, assert, ctx) {
      const G = app(ctx).win, V = G.WTS_wp_vlp, M = S.FIX.gasWell, F = G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F }), W = G.WTS_wp_well.build(M.well, { res: M.res });
      const tr = V.traverse(F, W, 7000, { from: 'top', p0: 600, corr: 'bb' });
      [['agf', 'agf', 'N_x'], ['mb', 'mb', 'N_Lv'], ['mech', 'ansari', 'v_sg']].forEach(([kind, ck, xl]) => {
        const pm = V.patternMap(F, 7000, tr, { kind });
        assert.ok(pm.ok && pm.kind === kind && pm.corr === ck && pm.axes.x.label === xl && pm.axes.x.log, kind + ' map');
        assert.ok(pm.lines.length >= 2 && pm.lines.every((l) => l.pts.length >= 2), kind + ' boundaries');
        const tot = Object.keys(pm.counts).reduce((a, k) => a + pm.counts[k], 0);
        assert.strictEqual(tot, pm.points.length + (pm.counts.single || 0), 'counts');
        // the classification = the correlation's own gradient pattern at that station (same inputs as the marcher)
        const rows = tr.profile.filter((r) => !r.restr);
        pm.points.slice(0, 40).forEach((p) => {
          const r = rows.find((x) => x.md === p.md), pr = G.WTS_flowline_props(G.WTS_wp_fluid.flowlineFluid(F, 7000), r.p, r.t);
          const seg = tr.segments.find((s) => p.md >= s.mdTop - 1e-6 && p.md <= s.mdBot + 1e-6);
          const g = G.WTS_flowline_corr[ck].grad({ vsl: r.vsl, vsg: r.vsg, d: seg.id, rhoL: pr.rhoL, rhoG: pr.rhoG, muL: pr.muL, muG: pr.mug, sigma: pr.sigL, theta: 90 - r.inc, rough: tr.rough, p: r.p, props: pr });
          assert.strictEqual(p.pattern, g.pattern, kind + ' station ' + Math.round(p.md));
        });
      });
      assert.strictEqual(V.patternMap(F, 7000, tr, { kind: 'mech', corr: 'hk' }).corr, 'hk', 'Hasan-Kabir boundaries on request');
      assert.strictEqual(V.patternMap(F, 7000, null, { kind: 'agf' }).ok, false);
    },
  },
  {
    name: 'VM10 page: per-section editor (presets, rows, Covers, section bar), schematic band, comparison per-section row + pure rows with pattern strips, map switch, section knobs and a live drag, case summary, no NaN',
    wp: WP,
    run(_a, assert, ctx) {
      const A = app(ctx), G = A.win, txt = (e) => String(e && e.textContent || '').replace(/\s+/g, ' ').trim(), BAD = /NaN|undefined|Infinity|\[object Object\]/;
      S.resetWellPerf(A);
      A.hook.nav('wellperf'); A.flush(30);
      A.click(A.find('[data-act="example"][data-ex="gas"]')); A.flush(30);
      assert.ok(A.el('wp_tbl_corrSections'), 'section editor');
      A.click(A.find('[data-act="secpreset"][data-v="dev"]')); A.flush(30);
      let st = G.WTS_wellperf_page.state();
      assert.deepStrictEqual(plain(st.M.system.corr.sections), [{ by: 'inc', from: 30, to: 180, corr: 'mb' }], 'preset written to the model');
      assert.ok(G.WTS_state.wellperf.ok && G.WTS_state.wellperf.traverse.sections, 'solved with sections');
      assert.match(txt(A.find('#wp_tbl_corrSections td.wp-seccov')), /MD · .* TVD ft, \d+/, 'Covers on MD · TVD: ' + txt(A.find('#wp_tbl_corrSections td.wp-seccov')));
      assert.ok(A.findAll('#wp_secbar .wp-secbar i').length >= 3, 'section bar');
      assert.match(A.el('wp_sch').innerHTML, /wp-secband/, 'schematic band');
      assert.match(txt(A.el('wp_sch_cap')), /correlations by section/);
      // an MD row through the table editor (the normal change path)
      A.click(A.find('[data-act="secpreset"][data-v="clear"]')); A.flush(30);
      A.click(A.find('[data-act="add"][data-t="corrSections"]')); A.flush(1);
      const tr = A.find('#wp_tbl_corrSections tbody tr');
      A.change(tr.querySelector('[data-c="by"]'), 'md'); A.flush(2);
      A.change(tr.querySelector('[data-c="from"]'), '2000'); A.flush(2);
      A.change(tr.querySelector('[data-c="to"]'), '5000'); A.flush(2);
      A.change(tr.querySelector('[data-c="corr"]'), 'hk'); A.flush(30);
      st = G.WTS_wellperf_page.state();
      assert.deepStrictEqual(plain(st.M.system.corr.sections), [{ by: 'md', from: 2000, to: 5000, corr: 'hk' }], 'table → model');
      // traverse tab: lines at the changes and two knobs; a drag re-solves live and the release writes the table
      A.click(A.find('#wp_trtabs [data-tab="traverse"]')); A.click(A.find('#wp_depthseg [data-depth="md"]')); A.flush(5);
      const sp = A.el('wp_cv_tr')._wp.spec, kn = sp.handles.filter((h) => /^sec0/.test(h.key));
      assert.strictEqual(kn.length, 2, 'two section knobs'); assert.ok(sp.hlines.length >= 2, 'section boundary lines');
      const n0 = G.WTS_wellperf_page.calcs();
      sp.onHandle('sec0t', 6000, 'move'); A.flush(2);
      assert.ok(G.WTS_wellperf_page.calcs() > n0, 'live solve');
      assert.strictEqual(G.WTS_wellperf_page.state().M.system.corr.sections[0].to, 6000, 'live model');
      sp.onHandle('sec0t', 6000, 'end'); A.flush(30);
      assert.strictEqual(G.WTS_wp_model.read().system.corr.sections[0].to, 6000, 'release writes the table');
      // comparison: the per-section row is the solve, every other row is pure
      A.click(A.find('#wp_trtabs [data-tab="corr"]')); A.flush(5);
      const R = G.WTS_state.wellperf, C = G.WTS_wellperf_page.state().cmp;
      const sel = C.rows.filter((r) => r.sel)[0];
      assert.strictEqual(sel.key, '__sec'); assert.strictEqual(sel.pwf, R.traverse.pEnd, 'per-section row = the solve');
      const hk = C.rows.find((r) => r.key === 'hk'), Mc = JSON.parse(JSON.stringify(G.WTS_wellperf_page.state().M));
      Mc.system.corr.well = 'hk'; Mc.system.node = 'bottom'; Mc.system.corr.sections = [];
      assert.strictEqual(G.WTS_wp_system.evalAt(Mc, R.op.q).tr.pEnd, hk.pwf, 'pure row');
      NEW.forEach((k) => assert.ok(C.rows.some((r) => r.key === k), k + ' compared'));
      assert.ok(A.findAll('#wp_corrtbl svg.wp-pstrip').length >= C.rows.length, 'a pattern strip per row');
      assert.match(txt(A.el('wp_corrtbl')), /Per-section correlations \(in use\)/);
      // the map switch
      A.click(A.find('#wp_trtabs [data-tab="map"]')); A.flush(5);
      ['agf', 'mb', 'mech', 'ros'].forEach((k) => {
        A.click(A.find('[data-mapk="' + k + '"]')); A.flush(3);
        const s2 = A.el('wp_cv_tr')._wp.spec;
        assert.ok(s2.x.log && s2.y.log && s2.series.length >= 2, k + ' map drawn');
        assert.ok(A.find('[data-mapk="' + k + '"]').classList.contains('on'), k + ' on');
        if (k !== 'ros') assert.ok(s2.series.some((x) => Array.isArray(x.info) && /MD · /.test(x.info[0][0])), k + ' station read-outs on MD · TVD');
        assert.ok(!BAD.test(txt(A.el('wp_corrtbl'))), k + ' clean');
      });
      // report capture: the case summary inside #wp_res
      assert.match(txt(A.el('wp_case')), /Per-section correlations.*MD/);
      const m = JSON.stringify(G.collectPageReport(A.el('pgBody'), { charts: false }));
      assert.match(m, /Per-section correlations/, 'captured by the report');
      assert.ok(!BAD.test(txt(A.el('wp_root'))), 'page clean');
      assert.strictEqual(A.consoleErrors().length, 0, 'no console errors');
      G.WTS_wp_model.write({ corrSections: [] });
      S.resetWellPerf(A);
    },
  },
  {
    name: 'VM11 review fixes (v4.5): Ansari takes the thin film root and bridges a thick film to slug; FIX.gasWell at 2600 psia flows; outflow steps bounded; Orkiszewski / Hasan-Kabir pattern-step note',
    wp: WP,
    run(_a, assert, ctx) {
      const G = app(ctx).win, C = G.WTS_flowline_corr, V = G.WTS_wp_vlp, SY = G.WTS_wp_system;
      // three roots at v_sg 15 ft/s on a wet-gas point: the thin one is taken (the residual vanishes and it is the smallest sign change)
      const x = { vsl: 0.05, vsg: 10, d: 2.441, rhoL: 45, rhoG: 6, muL: 0.5, muG: 0.016, sigma: 20, theta: 90, rough: 0.0006, p: 1500 };
      const a = C.ansari.grad(x);
      assert.strictEqual(a.pattern, 'annular'); assert.ok(a.delta < 0.01 && a.hl < 0.12, 'thin film δ ' + a.delta + ' H_L ' + a.hl);
      const zc = 24 * Math.pow(45 / 6, 1 / 3), fd = (d) => { const w = 4 * d * (1 - d); return a.YM - (a.FE > 0.9 ? 1 + 300 * d : 1 + zc * d) / (w * Math.pow(1 - w, 2.5)) + a.XM2 / (w * w * w); };
      for (let d = 1e-7; d < a.delta * 0.98; d *= 1.05) assert.ok(fd(d) > 0, 'no smaller root at ' + d);
      // a thick film only (lower gas rate): bridged → slug, and the pattern rule agrees with the gradient
      const xb = Object.assign({}, x, { vsg: 5 }), b = C.ansari.grad(xb);
      assert.strictEqual(b.pattern, 'slug'); assert.strictEqual(V.ansariPattern(xb).pattern, 'slug'); assert.ok(V.ansariPattern(xb).bridged === true, 'bridged');
      // FIX.gasWell at 2600 psia: Ansari flows like the other correlations (was UNSTABLE_ONLY)
      const M = S.FIX.gasWell; M.res.pr = 2600; M.system.corr.well = 'ansari';
      const R = SY.solve(M);
      assert.ok(R.ok && R.op.q > 3000 && R.op.q < 4500, 'Ansari operating rate ' + (R.op && R.op.q));
      // the outflow along a rate grid has no step above 10 % (it was 27 % at 4,750 → 5,000 Mscf/d)
      const Mg = S.FIX.gasWell, F = G.WTS_wp_fluid.build(Mg.fluid, { T_F: Mg.res.T_F }), W = G.WTS_wp_well.build(Mg.well, { res: Mg.res });
      let prev = null, worst = 0;
      for (let q = 3000; q <= 7000; q += 250) { const tr = V.traverse(F, W, q, { from: 'top', p0: 1000, corr: 'ansari' }); assert.ok(tr.ok); if (prev) worst = Math.max(worst, Math.abs(tr.pEnd - prev) / prev); prev = tr.pEnd; }
      assert.ok(worst < 0.10, 'largest step ' + worst);
      // the Orkiszewski / Hasan-Kabir boundary note: present when a traverse crosses it, absent otherwise
      const tk = V.traverse(F, W, 1280, { from: 'top', p0: 1000, corr: 'hk' }), pats = new Set(tk.profile.map((r) => r.pattern));
      const crosses = pats.has('churn') && pats.has('annular');
      assert.strictEqual(tk.warnings.some((w) => w.code === 'PATTERN_STEP'), crosses, 'HK note ⇔ the traverse crosses churn / annular');
      const tb = V.traverse(F, W, 1280, { from: 'top', p0: 1000, corr: 'bb' });
      assert.ok(!tb.warnings.some((w) => w.code === 'PATTERN_STEP'), 'no note for Beggs & Brill');
    },
  },
];
