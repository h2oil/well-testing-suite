// WP4b — Model kernels II + decline models (06, 08, 09, 10).
// Acceptance items a–f of the plan's WP4b section plus contract checks.
'use strict';

// ---------------------------------------------------------------------------
// helpers (Node realm — values are passed into app code as plain numbers /
// arrays; app code uses Array.isArray, so cross-realm arrays are fine)
// ---------------------------------------------------------------------------
const logspace = (lo, hi, perDecade) => {
  const out = [];
  const n = Math.round((hi - lo) * perDecade);
  for (let i = 0; i <= n; i++) out.push(Math.pow(10, lo + (hi - lo) * i / n));
  return out;
};
const clone = (o) => JSON.parse(JSON.stringify(o));

const PRESSURE_06 = ['doublePorosity', 'partialPen', 'verticalPulse'];
const PRESSURE_08 = ['twoLayerXF', 'radialComposite', 'multiLayerXF', 'multiLayerNoXF',
  'linearComposite', 'genHetRadialLinear', 'genHetRadial'];
const PRESSURE_09A = ['interference', 'mlNoXFFrac', 'inclinedMLXF', 'mlMultiPerf',
  'mlMultiPerfInterference', 'inclinedInterference', 'linearCompInterference',
  'mlInterferenceXF', 'radialCompInterference', 'generalMLNoXF'];
const PRESSURE_09B = ['mlHorizontalXF', 'mlNoXFHoriz', 'multiLatMLXF', 'mlHorizInterference',
  'linearCompMultiLat', 'linearCompMultiLatInterference'];
const PRESSURE_10 = ['waterInjection'];
const DECLINE = ['arps', 'duong', 'sepd', 'fetkovich'];

// Registry scan (plan WP4a-a applied to WP4b models): finite, ≥ 0,
// non-decreasing over td ∈ logspace(−2, 7), no throw, at S ∈ {−2, 0, 2.5};
// rw-type models honour pure storage at early time.
function scanModel(app, assert, key) {
  const M = app.win.PRiSM_MODELS[key];
  assert.ok(M, key + ' registered');
  const tds = logspace(-2, 7, 3);
  const obs = /nterference/.test(key) || key === 'verticalPulse';
  const days = M.timeInput === 'days';
  for (const S of [-2, 0, 2.5]) {
    const P = clone(M.defaults);
    if ('S' in P) P.S = S; else P.S_perf = S;
    let v, d;
    try { v = M.pd(tds, P); d = M.pdPrime(tds, P); } catch (e) {
      throw new Error(key + ' threw at S=' + S + ': ' + e.message);
    }
    assert.equal(v.length, tds.length);
    for (let i = 0; i < v.length; i++) {
      assert.finite(v[i], key + ' S=' + S + ' pd finite at td=' + tds[i]);
      assert.finite(d[i], key + ' S=' + S + ' pdPrime finite at td=' + tds[i]);
      assert.ok(v[i] >= 0, key + ' S=' + S + ' pd ≥ 0 at td=' + tds[i] + ' (' + v[i] + ')');
      if (i > 0) {
        assert.ok(v[i] >= v[i - 1] - 1e-9 * Math.abs(v[i - 1]),
          key + ' S=' + S + ' non-decreasing at td=' + tds[i] + ' (' + v[i - 1] + ' → ' + v[i] + ')');
      }
    }
    if (!obs && !days && P.Cd > 0) {
      // pure storage: td ≤ 1e-3·Cd for every S; td ≤ 0.1·Cd for positive skin
      const lim = (S > 0 ? 0.1 : 1e-3) * P.Cd;
      for (const t of tds.filter((x) => x <= lim)) {
        const r = M.pd([t], P)[0] / (t / P.Cd);
        assert.within(r, 0.95, 1.05, key + ' S=' + S + ' unit-slope storage at td=' + t);
      }
    }
  }
}

// Independent closed-circle constant-pwf reference (Stehfest N = 12) with
// test-local Bessel functions (integral / series forms; no shared code).
function besselRef() {
  const Ke = (nu, x) => { let s = 0.5; const h = Math.min(0.1, 0.25 / Math.sqrt(x));
    for (let k = 1; k < 100000; k++) { const t = k * h, e = Math.exp(-x * (Math.cosh(t) - 1)) * (nu ? Math.cosh(t) : 1); s += e; if (e < 1e-18 * s) break; }
    return s * h; };                                   // K_nu(x)·e^x
  const I = (nu, x) => { const q = x * x / 4; let term = nu ? x / 2 : 1, s = term;
    for (let k = 1; k < 400; k++) { term *= q / (k * (k + nu)); s += term; if (term < 1e-18 * s) break; } return s; };
  const W = (() => { const N = 12, f = [1]; for (let i = 1; i <= N; i++) f[i] = f[i - 1] * i; const w = [];
    for (let i = 1; i <= N; i++) { let s = 0; for (let k = Math.floor((i + 1) / 2); k <= Math.min(i, N / 2); k++) s += Math.pow(k, N / 2) * f[2 * k] / (f[N / 2 - k] * f[k] * f[k - 1] * f[i - k] * f[2 * k - i]); w.push(((i + N / 2) % 2 === 0 ? 1 : -1) * s); } return w; })();
  const steh = (F, t) => { const a = Math.LN2 / t; let s = 0; for (let i = 1; i <= 12; i++) s += W[i - 1] * F(i * a); return a * s; };
  // unscaled (valid while reD·√s < ~600): q̄D = 1/(s² p̄wD)
  const qDbar = (s, reD) => { const y = Math.sqrt(s), x = reD * y;
    const K0y = Ke(0, y) * Math.exp(-y), K1y = Ke(1, y) * Math.exp(-y), K1x = Ke(1, x) * Math.exp(-x);
    const pw = (I(1, x) * K0y + K1x * I(0, y)) / (Math.pow(s, 1.5) * (I(1, x) * K1y - K1x * I(1, y)));
    return 1 / (s * s * pw); };
  return { steh, qDbar };
}

module.exports = [
  // ── (a) registry scan ─────────────────────────────────────────────────────
  {
    name: 'a. registry scan — 06 pressure models (doublePorosity, partialPen, verticalPulse)',
    wp: 'WP4b',
    run(app, assert) { for (const k of PRESSURE_06) scanModel(app, assert, k); },
  },
  {
    name: 'a. registry scan — 08 composite / multilayer models',
    wp: 'WP4b',
    run(app, assert) { for (const k of PRESSURE_08) scanModel(app, assert, k); },
  },
  {
    name: 'a. registry scan — 09 vertical-well, fracture and interference models',
    wp: 'WP4b',
    run(app, assert) { for (const k of PRESSURE_09A) scanModel(app, assert, k); },
  },
  {
    name: 'a. registry scan — 09 horizontal / multi-lateral models',
    wp: 'WP4b',
    timeoutMs: 300000,
    run(app, assert) { for (const k of PRESSURE_09B) scanModel(app, assert, k); },
  },
  {
    name: 'a. registry scan — 10 waterInjection (time in days)',
    wp: 'WP4b',
    run(app, assert) { for (const k of PRESSURE_10) scanModel(app, assert, k); },
  },
  {
    name: 'a. inclinedMLXF, mlMultiPerf, multiLatMLXF monotone over td 1–1e4 at λ ∈ {1e-4, 1e-6}',
    wp: 'WP4b',
    run(app, assert) {
      const tds = logspace(0, 4, 10);
      for (const lam of [1e-4, 1e-6]) {
        for (const key of ['inclinedMLXF', 'mlMultiPerf', 'multiLatMLXF']) {
          const M = app.win.PRiSM_MODELS[key];
          const P = clone(M.defaults);
          P.layers = P.layers.map((L) => Object.assign({}, L, { lambda: lam }));
          const v = M.pd(tds, P), d = M.pdPrime(tds, P);
          for (let i = 0; i < v.length; i++) {
            assert.finite(v[i]); assert.ok(d[i] > 0, key + ' λ=' + lam + ' derivative > 0 at ' + tds[i]);
            if (i) assert.ok(v[i] >= v[i - 1], key + ' λ=' + lam + ' monotone at td=' + tds[i]);
          }
        }
      }
    },
  },

  // ── (b) partial penetration pseudo-skin ───────────────────────────────────
  {
    name: 'b. partialPen(td=1e6) − homogeneous = Brons-Marting(0.2, 98.9) = 10.79 ± 0.05',
    wp: 'WP4b',
    run(app, assert) {
      const W = app.win;
      const P = { Cd: 100, S_perf: 0, S_global: 1.2, KvKh: 1, hp_to_h: 0.2, zw_to_h: 0.5, h_eff: 1, __h_rw: 35 / 0.354 };
      const pp = W.PRiSM_MODELS.partialPen.pd([1e6], P)[0];
      const hom = W.PRiSM_MODELS.homogeneous.pd([1e6], { Cd: 100, S: 1.2 });
      const h = Array.isArray(hom) ? hom[0] : hom;
      assert.near(pp - h, 10.79, 0.05, 'partialPen − homogeneous');
      assert.near(W.PRiSM_MODELS.partialPen.pseudoSkin(P), 10.79, 0.02, 'registry pseudoSkin(b=0.2)');
      assert.near(W.PRiSM_MODELS.partialPen.pseudoSkin(Object.assign({}, P, { hp_to_h: 0.5 })), 3.05, 0.02, 'b = 0.5');
      assert.deepEqual(Array.from(W.PRiSM_MODELS.partialPen.defaultFrozen), ['S_global']);
    },
  },

  // ── (c) radial composite ──────────────────────────────────────────────────
  {
    name: 'c. radialComposite R ∈ {1000, 1e4} = homogeneous ± 1% before tD = R²/4, no spikes',
    wp: 'WP4b',
    run(app, assert) {
      const W = app.win;
      for (const R of [1000, 1e4]) {
        const tds = logspace(-2, Math.log10(R * R / 4), 8);
        const P = { Cd: 100, S: 0, M: 2, F: 1, R };
        const v = W.PRiSM_MODELS.radialComposite.pd(tds, P);
        const hom = W.PRiSM_MODELS.homogeneous.pd(tds, { Cd: 100, S: 0 });
        for (let i = 0; i < tds.length; i++) assert.rel(v[i], hom[i], 0.01, 'R=' + R + ' td=' + tds[i]);
        const all = logspace(-2, R > 1000 ? 12 : 9, 8);
        const d = W.PRiSM_MODELS.radialComposite.pdPrime(all, P);
        for (let i = 1; i < d.length - 1; i++) {
          assert.finite(d[i]);
          assert.ok(Math.abs(d[i] - 0.5 * (d[i - 1] + d[i + 1])) <= 0.05 * Math.abs(d[i]) + 1e-6,
            'no spike in derivative at td=' + all[i]);
        }
        assert.near(d[d.length - 1], 1.0, 0.02, 'late derivative 0.5·M');
      }
    },
  },

  // ── (d) Arps ──────────────────────────────────────────────────────────────
  {
    name: 'd. Arps: small-b branch, t = 0, closed-form EUR, Dmin continuity, helpers',
    wp: 'WP4b',
    run(app, assert) {
      const W = app.win, A = W.PRiSM_MODELS.arps;
      assert.equal(A.timeInput, 'days');
      assert.near(A.pd([100], { qi: 1000, Di: 0.01, b: 1e-17 })[0], 367.879, 1e-3, 'b = 1e-17');
      const P = { qi: 1000, Di: 0.01, b: 0.5 };
      assert.equal(A.pd([0], P)[0], 1000, 'q(0) = qi');
      assert.equal(A.pdPrime([0], P)[0], 0, 't·dq/dt = 0 at t = 0');
      assert.rel(W.PRiSM_eur_arps(P, 3650), 189610, 1e-3, 'EUR(3650 d, b 0.5)');
      assert.rel(W.PRiSM_eur_arps(3650, P), 189610, 1e-3, 'EUR accepts (t_end, params)');
      assert.rel(A.eur(P, 3650), 189610, 1e-3, 'registry eur');
      // numeric integration cross-checks (trapezoid, 2e5 steps)
      const integ = (f, T) => { const n = 200000; let s = 0; for (let i = 0; i <= n; i++) s += (i === 0 || i === n ? 0.5 : 1) * f(T * i / n); return s * T / n; };
      for (const Q of [{ qi: 1000, Di: 0.01, b: 0 }, { qi: 1000, Di: 0.01, b: 1 }, { qi: 1000, Di: 0.01, b: 0.5 },
                       { qi: 1000, Di: 0.01, b: 1.5 }, { qi: 1000, Di: 0.01, b: 0.8, Dmin: 0.0005 }]) {
        const tab = W.PRiSM_arps_timeToRate(5, Q);
        assert.rel(W.PRiSM_arps_q(tab, Q), 5, 1e-9, 't_ab inverse ' + JSON.stringify(Q));
        assert.rel(W.PRiSM_arps_eurToRate(5, Q), integ((t) => W.PRiSM_arps_q(t, Q), tab), 1e-3, 'EUR to q_ab ' + JSON.stringify(Q));
        assert.rel(W.PRiSM_arps_Np(tab, Q), integ((t) => W.PRiSM_arps_q(t, Q), tab), 1e-3, 'Np closed form');
      }
      // modified hyperbolic: C¹ at the switch
      const MH = { qi: 1000, Di: 0.01, b: 0.8, Dmin: 0.0005 };
      const tsw = W.PRiSM_arps_tSwitch(MH);
      assert.near(tsw, (0.01 / 0.0005 - 1) / (0.8 * 0.01), 1e-9, 't_sw');
      const e = 1e-9 * tsw;
      assert.rel(W.PRiSM_arps_q(tsw - e, MH), W.PRiSM_arps_q(tsw + e, MH), 1e-6, 'q continuous');
      assert.rel(W.PRiSM_arps_D(tsw - e, MH), W.PRiSM_arps_D(tsw + e, MH), 1e-6, 'D continuous (C¹)');
      assert.near(W.PRiSM_arps_De({ qi: 1000, Di: 0.01, b: 0 }), 1 - Math.exp(-3.65), 1e-12, 'effective annual decline');
      assert.ok(W.PRiSM_DECLINE && typeof W.PRiSM_DECLINE.arpsEurToRate === 'function', 'PRiSM_DECLINE group');
      // SEPD t = 0
      assert.equal(W.PRiSM_MODELS.sepd.pd([0], { qi: 500, tau: 100, n: 0.5 })[0], 500);
      for (const k of DECLINE) assert.equal(W.PRiSM_MODELS[k].timeInput, 'days', k + ' timeInput');
    },
  },

  // ── (e) Fetkovich ─────────────────────────────────────────────────────────
  {
    name: 'e. Fetkovich: b = 0 stems = exp(−tDd) for tDd > 0.3; transient = closed-circle Stehfest ± 1%; Di, b matter',
    wp: 'WP4b',
    run(app, assert) {
      const W = app.win;
      assert.fn(W.PRiSM_fetkovich_typecurve, 'PRiSM_fetkovich_typecurve exported');
      for (const reD of [10, 100, 1000, 1e4]) {
        const t = [0.31, 0.5, 1, 2, 5];
        const q = W.PRiSM_fetkovich_typecurve(reD, 0, t);
        t.forEach((x, i) => assert.rel(q[i], Math.exp(-x), 0.01, 'reD=' + reD + ' tDd=' + x));
      }
      const ref = besselRef();
      for (const reD of [10, 30, 100]) {
        const lnr = Math.log(reD) - 0.5, fac = 0.5 * (reD * reD - 1) * lnr;
        for (const tDd of [1e-3, 1e-2, 0.05, 0.1]) {
          if (tDd * fac < 0.05) continue;
          const r = ref.steh((s) => ref.qDbar(s, reD), tDd * fac) * lnr;
          assert.rel(W.PRiSM_fetkovich_typecurve(reD, 0.5, [tDd])[0], r, 0.01, 'transient reD=' + reD + ' tDd=' + tDd);
        }
      }
      const F = W.PRiSM_MODELS.fetkovich;
      assert.ok(!/placeholder/i.test(F.description), 'no placeholder text');
      const base = { qi: 1000, Di: 0.02, b: 0.5, reD: 1000 };
      const q0 = F.pd([100], base)[0];
      assert.ok(Math.abs(F.pd([100], Object.assign({}, base, { Di: 0.04 }))[0] - q0) > 1, 'Di changes q');
      assert.ok(Math.abs(F.pd([100], Object.assign({}, base, { b: 1.5 }))[0] - q0) > 1, 'b changes q');
      assert.equal(F.pd([0], base)[0], 1000, 'q(0) = qi');
      const ts = logspace(-3, 4, 6), q = F.pd(ts, base);
      for (let i = 1; i < q.length; i++) assert.ok(q[i] <= q[i - 1], 'decreasing at t=' + ts[i]);
      const eur = W.PRiSM_eur_fetkovich(base, 3650);
      assert.ok(eur > 0 && isFinite(eur), 'EUR finite');
      assert.includes(F.paramSpec.find((p) => p.key === 'reD').label, 'rwa', 'reD relabelled re/rwa');
    },
  },

  // ── (f) horizontal family late radial ─────────────────────────────────────
  {
    name: 'f. horizontal-family late derivative 0.5 ± 0.02 (single lateral)',
    wp: 'WP4b',
    run(app, assert) {
      const M = app.win.PRiSM_MODELS;
      const cases = [
        ['mlHorizontalXF', clone(M.mlHorizontalXF.defaults)],
        ['mlNoXFHoriz', clone(M.mlNoXFHoriz.defaults)],
        ['multiLatMLXF', Object.assign(clone(M.multiLatMLXF.defaults), { nLegs: 1 })],
        ['linearCompMultiLat', Object.assign(clone(M.linearCompMultiLat.defaults), { nLegs: 1, zones: [{ M: 1, W: 1 }] })],
      ];
      for (const [k, P] of cases) {
        const d = M[k].pdPrime([1e5, 1e6], P);
        d.forEach((x) => assert.near(x, 0.5, 0.02, k + ' late derivative'));
        assert.equal(M[k].refLength, 'Lh', k + ' refLength');
      }
      // early vertical-radial plateau ≈ 0.5·(h/L)·√(kh/kv) (finite wellbore, rw/h = 0.01)
      const P = { Cd: 1e-9, S_perf: 0, S_global: 0, KvKh: 0.1, L_to_h: 5, layers: [{ kh: 1, omega: 1, lambda: 0 }], __h_rw: 100 };
      const pk = Math.max.apply(null, M.mlNoXFHoriz.pdPrime(logspace(-4, -1, 10), P));
      assert.within(pk, 0.27, 0.33, 'early radial plateau (0.316)');
    },
  },

  // ── negative skin (19-model pole) ─────────────────────────────────────────
  {
    name: 'negative skin: late pd = 0.5(ln td + 0.80907) + S for S = −3 and −7; monotone',
    wp: 'WP4b',
    run(app, assert) {
      const M = app.win.PRiSM_MODELS;
      const cases = [
        ['doublePorosity', { Cd: 100, omega: 0.1, lambda: 1e-5, interporosityMode: 'pss' }],
        ['twoLayerXF', { Cd: 100, kappa: 1, lambda: 1e-5, omega: 0.5 }],
        ['radialComposite', { Cd: 100, M: 1, F: 1, R: 50 }],
        ['multiLayerNoXF', { Cd: 100, N: 3, perms: [1, 1, 1], khFracs: [1 / 3, 1 / 3, 1 / 3] }],
        ['genHetRadial', { Cd: 100, R1: 30, R2: 200, M1: 1, M2: 1, M3: 1, F1: 1, F2: 1, F3: 1 }],
      ];
      for (const [k, base] of cases) {
        for (const S of [-3, -7]) {
          const P = Object.assign({}, base, { S, Cd: S === -7 ? 1e4 : base.Cd });
          const late = M[k].pd([1e10], P)[0];
          assert.near(late, 0.5 * (Math.log(1e10) + 0.80907) + S, 0.01, k + ' S=' + S);
          const v = M[k].pd(logspace(0, 6, 3), P);
          for (let i = 1; i < v.length; i++) assert.ok(v[i] >= v[i - 1] && v[i] > 0, k + ' S=' + S + ' monotone');
        }
      }
    },
  },

  // ── pseudo-skins and registry metadata ────────────────────────────────────
  {
    name: 'pseudo-skins (Brons-Marting, Cinco-Ley) and registry metadata',
    wp: 'WP4b',
    run(app, assert) {
      const M = app.win.PRiSM_MODELS;
      // inclinedMLXF slant skin: θ 45°, kv/kh 1, h 100 ft, rw 0.354 ft → −1.511
      const sI = M.inclinedMLXF.pseudoSkin({ theta_deg: 45, KvKh: 1, hp_to_h: 1, __h_rw: 100 / 0.354 });
      assert.near(sI, -1.511, 0.01, 'Cinco-Ley 45°');
      assert.near(M.inclinedMLXF.pseudoSkin({ theta_deg: 60, KvKh: 1, hp_to_h: 1, __h_rw: 100 / 0.354 }), -2.704, 0.01, 'Cinco-Ley 60°');
      // multi-perf: Brons-Marting on the combined open fraction
      const mp = M.mlMultiPerf.pseudoSkin({ KvKh: 1, perfs: [{ hp_to_h: 0.1 }, { hp_to_h: 0.1 }], __h_rw: 35 / 0.354 });
      assert.near(mp, 10.79, 0.02, 'mlMultiPerf b = 0.2');
      const all = PRESSURE_06.concat(PRESSURE_08, PRESSURE_09A, PRESSURE_09B, PRESSURE_10);
      for (const k of all) {
        assert.ok(['rw', 'Lh', 'xf'].indexOf(M[k].refLength) !== -1, k + ' refLength');
        const keys = M[k].paramSpec.map((p) => p.key);
        if (keys.indexOf('S_perf') !== -1 && keys.indexOf('S_global') !== -1) {
          assert.ok(Array.from(M[k].defaultFrozen || []).indexOf('S_global') !== -1, k + ' freezes S_global');
        }
      }
      assert.equal(M.waterInjection.timeInput, 'days');
      assert.equal(M.mlNoXFFrac.refLength, 'xf');
    },
  },

  // ── interference family ───────────────────────────────────────────────────
  {
    name: 'interference: no tiny negatives, line-source early tail, late 0.5·E1',
    wp: 'WP4b',
    run(app, assert) {
      const M = app.win.PRiSM_MODELS;
      const E1 = (x) => { if (x <= 1) { let s = 0, t = 1; for (let n = 1; n < 60; n++) { t *= -x / n; s += -t / n; } return -Math.log(x) - 0.5772156649015329 + s; }
        let b = x + 1, c = 1e300, d = 1 / b, h = d; for (let i = 1; i < 300; i++) { const a = -i * i; b += 2; d = 1 / (a * d + b); c = b + a / c; const del = c * d; h *= del; if (Math.abs(del - 1) < 1e-15) break; } return h * Math.exp(-x); };
      for (const S of [-2, 0, 2.5]) {
        const P = { Cd: 100, S, rxObs: 1000 };
        const ts = logspace(2, 9, 10);
        const v = M.interference.pd(ts, P);
        v.forEach((x, i) => { assert.ok(x >= 0, 'no negative at ' + ts[i]); if (i) assert.ok(x >= v[i - 1], 'monotone at ' + ts[i]); });
        assert.rel(M.interference.pd([1e9], P)[0], 0.5 * E1(1e6 / 4e9), 0.005, 'late line source S=' + S);
      }
      // storage-free obs response follows the line source everywhere
      const tf = [1e4, 2e4, 1e5, 2e5, 1e6];
      const free = M.interference.pd(tf, { Cd: 1e-6, S: 0, rxObs: 1000 });
      tf.forEach((t, i) => {
        const ex = 0.5 * E1(1e6 / (4 * t));
        if (ex < 1e-10) assert.equal(free[i], 0, 'zero-clamp below 1e-10 at ' + t);
        else assert.rel(free[i], ex, 2e-3, 'no-storage line source at ' + t);
      });
    },
  },

  // ── fractured commingled layers (Laplace fold) ────────────────────────────
  {
    name: 'mlNoXFFrac: Laplace kernel = Gringarten uniform-flux closed form; skin at late time',
    wp: 'WP4b',
    run(app, assert) {
      const M = app.win.PRiSM_MODELS.mlNoXFFrac;
      const erfc = (x) => { const t = 1 / (1 + 0.5 * x); return t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))))); };
      const E1 = (x) => { let s = 0, t = 1; if (x <= 1) { for (let n = 1; n < 60; n++) { t *= -x / n; s += -t / n; } return -Math.log(x) - 0.5772156649015329 + s; }
        let b = x + 1, c = 1e300, d = 1 / b, h = d; for (let i = 1; i < 300; i++) { const a = -i * i; b += 2; d = 1 / (a * d + b); c = b + a / c; const del = c * d; h *= del; if (Math.abs(del - 1) < 1e-15) break; } return h * Math.exp(-x); };
      const P = { Cd: 0, S: 0, layers: [{ kh: 1, omega: 1, lambda: 0, extras: { xf_ratio: 1 } }] };
      for (const t of [0.01, 1, 100, 1e4]) {
        const closed = Math.sqrt(Math.PI * t) * (1 - erfc(1 / (2 * Math.sqrt(t)))) + 0.5 * E1(1 / (4 * t));
        assert.rel(M.pd([t], P)[0], closed, 1e-4, 'uniform-flux fracture at tD=' + t);
      }
      const P2 = Object.assign({}, P, { Cd: 1e-3, S: 0.7 });
      assert.near(M.pd([1e6], P2)[0] - M.pd([1e6], P)[0], 0.7, 0.01, 'skin adds at late time');
    },
  },

  // ── integration: shared exports from WP4a (03-models.js) ──────────────────
  {
    name: 'integration: WP4a shared exports agree with the WP4b local kernels',
    wp: 'WP4b',
    integration: true,
    run(app, assert) {
      const W = app.win;
      const lib = W.PRiSM_pseudoSkin;
      assert.ok(lib, 'window.PRiSM_pseudoSkin present');
      assert.near(lib.bronsMarting(0.2, 35 / 0.354), 10.79, 0.02, 'bronsMarting');
      assert.near(lib.cincoLey(45, 1, 100 / 0.354), -1.511, 0.01, 'cincoLey (degrees)');
      assert.fn(W.PRiSM_evalWbsSkin, 'PRiSM_evalWbsSkin');
      // a WP4b model through the shared fold equals the homogeneous model
      const v = W.PRiSM_MODELS.twoLayerXF.pd([1, 100, 1e4], { Cd: 100, S: 2.5, kappa: 1, lambda: 1, omega: 0.999 });
      const h = W.PRiSM_MODELS.homogeneous.pd([1, 100, 1e4], { Cd: 100, S: 2.5 });
      v.forEach((x, i) => assert.rel(x, h[i], 2e-3, 'twoLayerXF(κ=1, ω→1) = homogeneous'));
      if (typeof W.PRiSM_lap_horizontal === 'function') {
        const P = { KvKh: 0.1, L_to_h: 5, zw_to_h: 0.5, __h_rw: 100 };
        for (const u of [1e-3, 1, 100]) {
          assert.rel(u * W.PRiSM_lap_horizontal(u, P), W.PRiSM_horizontalKernelH(u, P, { line: true, local: true }), 1e-3,
            'horizontal kernel u=' + u);
        }
      }
    },
  },
  {
    name: 'integration: physical-model wrapper accepts WP4b metadata (timeInput, refLength)',
    wp: 'WP4b',
    integration: true,
    run(app, assert) {
      const W = app.win;
      assert.fn(W.PRiSM_physicalModel, 'PRiSM_physicalModel (WP1)');
      app.seedSample();
      const well = typeof W.PRiSM_getWell === 'function' ? W.PRiSM_getWell() : null;
      const ad = typeof W.PRiSM_getAnalysisData === 'function' ? W.PRiSM_getAnalysisData() : null;
      for (const key of ['radialComposite', 'doublePorosity', 'partialPen']) {
        const pm = W.PRiSM_physicalModel(key, well, ad, {});
        assert.ok(pm && pm.ok, key + ' physical model ok');
        const phys = pm.seed();
        const dp = pm.dp(ad.t.slice(0, 10), phys);
        dp.forEach((x) => assert.finite(x, key + ' Δp finite'));
      }
    },
  },
];
