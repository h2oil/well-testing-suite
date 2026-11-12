// Well Performance B, WP27 — the operating envelope and lift screening (49-calc-wp-envelope.js). docs/WELL-PERFORMANCE-PLAN.md §1.4
// G6 / H11, §4.9–§4.12, §7.4, §15.2 (node independence), §16, D17.
//
// WEN1 the deliverability curve is the solver's wellhead-node inflow: at the operating rate THP_av = the THP of the choke solve and the
//      flowline back pressure = the choke-downstream pressure (oil and wet gas); the maximum rate = WTS_wp_system.maxRate
// WEN2 a point of the stable branch is the operating point at that fixed THP (≤ 0.5 % in q); the unstable branch lies left of the
//      THP maximum; at the loading limit a fixed-THP solve has a loading margin ≈ 0 (gas)
// WEN3 limits: drawdown / minimum pwf / bubble point = the IPR rate at that pwf, the facility rate, the wellhead rating crossing,
//      the window = [max lower, min upper] with the binding limits named, the operating point checked; at() interpolation; no window
// WSC1 screening matrix: verdicts on the vertical oil well, deviation first (maximum inclination and dogleg of a built well), the pump
//      setting windows on MD and TVD, gas-well notes, provisional label
// WSC2 screening Job: natural flow = the solve, gas lift = the quick-look optimum on the same list (screening pressure stated when step ④
//      has none), ESP not available without its engine (never the natural-flow number), pump potential = the IPR at the minimum pwf
'use strict';

const S = require('./_wellperf-shapes');

const WP = 'WP27';
const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const app = (ctx) => S.sharedApp(ctx);
const run = (job) => { let s, n = 0; do { s = job.step(); n++; } while (!s.done && n < 2000); return job.result(); };
const _memo = new Map();
const env = (G, M, o) => { const k = JSON.stringify([M, o || null]); if (!_memo.has(k)) _memo.set(k, run(G.WTS_wp_envelope.job(M, o))); return _memo.get(k); };

module.exports = [
  {
    name: 'WEN1 deliverability = wellhead-node inflow: THP and flowline back pressure at the operating rate, maximum rate = maxRate',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, E = G.WTS_wp_envelope, SY = G.WTS_wp_system;
      [['oilWell', 0.05, 0.1], ['gasWell', 4, 1]].forEach(([k, tolThp, tolLine]) => {
        const M = S.FIX[k], R = SY.solve(M), r = env(G, M);
        assert.ok(r.ok && r.op && r.curve.length >= 14, k + ': ' + JSON.stringify(plain(r.errors)));
        const a = E.at(r, R.op.q);
        assert.ok(Math.abs(a.thp - R.surface.thp_psig) < tolThp, k + ' THP ' + a.thp + ' / ' + R.surface.thp_psig);
        assert.ok(Math.abs(a.thpLine - R.surface.pChokeDn_psig) < tolLine, k + ' line ' + a.thpLine + ' / ' + R.surface.pChokeDn_psig);
        const mx = SY.maxRate(M);
        assert.ok(Math.abs(r.max.q / mx.q - 1) < 0.005, k + ' maximum rate ' + r.max.q + ' / ' + mx.q);
        assert.ok(r.op.inside && r.evals <= 60, k + ' inside, ' + r.evals + ' E (one solve + the marches)');
      });
    },
  },
  {
    name: 'WEN2 the stable branch is the fixed-THP operating point; the unstable branch is left of the THP maximum; loading limit ≈ zero margin',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, E = G.WTS_wp_envelope, SY = G.WTS_wp_system;
      const r = env(G, S.FIX.oilWell), q = 0.5 * (r.window.qLo + r.window.qHi), a = E.at(r, q);
      const M = S.FIX.oilWell; M.surface.choke.present = false; M.system.thp_psig = a.thp;
      const R = SY.solve(M);
      assert.ok(R.ok && Math.abs(R.op.q / q - 1) < 0.005, 'fixed THP ' + a.thp + ': ' + R.op.q + ' / ' + q);
      assert.ok(r.curve.filter((c) => c.ok && c.q < r.peak.q).every((c) => !c.stable) && r.curve.filter((c) => c.ok && c.q > r.peak.q).every((c) => c.stable), 'branches split at the THP maximum');
      assert.ok(r.curve.filter((c) => c.ok).every((c) => c.thp <= r.peak.thp + 1e-6), 'the peak is the maximum');
      assert.strictEqual(r.limits.stab.q, r.peak.q);
      const g = env(G, S.FIX.gasWell), L = g.limits.load;
      assert.ok(L && isFinite(L.q) && L.q > g.peak.q, 'loading limit right of the peak');
      const Mg = S.FIX.gasWell; Mg.surface.choke.present = false; Mg.system.thp_psig = E.at(g, L.q).thp;
      const Rg = SY.solve(Mg);
      assert.ok(Math.abs(Rg.loading.margin) < 0.01 && Math.abs(Rg.op.q / L.q - 1) < 0.01, 'margin at the limit ' + Rg.loading.margin);
      assert.strictEqual(g.loadingProvisional, 'provisional — not verified against a published example');
    },
  },
  {
    name: 'WEN3 limits (drawdown, pwf, bubble point, facility, rating), window and binding limits, operating point, at(), no window',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, E = G.WTS_wp_envelope;
      const M = S.FIX.oilWell; M.surface.rating.wellhead_psi = 400;
      const F = G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F }), I = G.WTS_wp_ipr.curve(M.res, F);
      const r = env(G, M, { ddMax: 800, pwfMin: 1500, pbLimit: true, qFac: 1200 });
      assert.ok(Math.abs(r.limits.dd.q - I.qAt(2200)) < 1e-9 && Math.abs(r.limits.pwfMin.q - I.qAt(1500)) < 1e-9, 'drawdown and pwf limits = IPR');
      const pb = G.WTS_wp_fluid.build(M.fluid, { T_F: 200 }).pb(200);
      assert.ok(Math.abs(r.limits.pb.q - I.qAt(pb)) < 1e-6 * r.limits.pb.q, 'bubble-point limit');
      assert.strictEqual(r.limits.fac.q, 1200);
      assert.ok(Math.abs(E.at(r, r.limits.rating.q).thp - 400) < 1, 'rating crossing on the stable branch');
      const lows = ['stab', 'rating'].map((k) => r.limits[k].q), highs = ['max', 'ero', 'dd', 'pwfMin', 'pb', 'fac'].map((k) => r.limits[k] && r.limits[k].q).filter((x) => isFinite(x));
      assert.ok(Math.abs(r.window.qLo - Math.max.apply(null, lows)) < 1e-9 && Math.abs(r.window.qHi - Math.min.apply(null, highs)) < 1e-9, 'window');
      assert.deepStrictEqual(plain(r.window.lo), ['rating']); assert.deepStrictEqual(plain(r.window.hi), ['pb']);
      assert.ok(r.op.inside && r.op.q > r.window.qLo && r.op.q < r.window.qHi, 'operating point inside');
      const a = E.at(r, r.op.q);
      assert.ok(a.inside && a.checks.length === Object.keys(r.limits).filter((k) => isFinite(r.limits[k].q)).length && Math.abs(a.chokeDp - (a.thp - a.thpLine)) < 1e-12, 'at()');
      const r2 = env(G, S.FIX.oilWell, { qFac: 300 });
      assert.ok(!r2.window.ok && r2.warnings.some((w) => w.code === 'NO_WINDOW') && !r2.op.inside && r2.op.violated.indexOf('fac') !== -1, 'no window: facility below the stability limit');
      assert.strictEqual(run(E.job(Object.assign(S.FIX.oilWell, { res: Object.assign(S.FIX.oilWell.res, { pr: null }) }))).code, 'NEEDS_PR');
    },
  },
  {
    name: 'WSC1 screening matrix: verdicts, deviation first (inclination, dogleg), setting windows MD · TVD, gas-well notes, provisional',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, SC = G.WTS_wp_screen, SY = G.WTS_wp_system;
      const M = S.FIX.oilWell, mx = SC.matrix(M, { R: SY.solve(M) });
      assert.ok(mx.ok && mx.verified === false && /provisional — not verified/.test(mx.provisional) && /Clegg, Bucaram & Hein/.test(mx.source), 'labels');
      const by = {}; mx.methods.forEach((m) => { by[m.key] = m; });
      assert.deepStrictEqual(plain(mx.methods.map((m) => m.key)), ['natural', 'gaslift', 'esp', 'rod', 'pcp', 'jet', 'plunger']);
      assert.ok(by.natural.verdict === 'ok' && by.esp.verdict === 'ok' && by.plunger.verdict === 'fail', 'vertical oil well at 914 STB/d');
      assert.ok(by.gaslift.checks.some((c) => c.key === 'gas' && c.st === 'warn'), 'no injection pressure → lift gas not confirmed');
      assert.ok(mx.windows.esp && mx.windows.esp.md1 > 7800 && Math.abs(mx.windows.esp.tvd1 - mx.windows.esp.md1) < 1e-6, 'vertical: the window reaches the perforations');
      // a built well: KOP 1,000 ft, 3°/100 ft to 90° — the rod pump (≤ 2°/100 ft, ≤ 45°) only above the kick-off; ESP to the 60° station
      const D = S.FIX.devSurvey, Md = S.FIX.oilWell, last = D.rows[D.rows.length - 1][0];
      Md.well.survey = D.rows; Md.well.midPerfMd = last - 50; Md.well.perfTopMd = last - 100; Md.well.perfBotMd = last;
      Md.well.strings = [{ kind: 'tubing', tubKey: null, id: 2.441, od: 2.875, wall: 0.217, rough: 0.0006, topMd: 0, botMd: last - 150 }, { kind: 'casing', tubKey: null, id: 6.276, od: 7, wall: 0.362, rough: 0.0006, topMd: last - 150, botMd: last + 10 }];
      const W = G.WTS_wp_well.build(Md.well, { res: Md.res, fluidType: 'oil' }), md2 = SC.matrix(Md, { W });
      const b2 = {}; md2.methods.forEach((m) => { b2[m.key] = m; });
      assert.ok(Math.abs(md2.well.maxInc - 90) < 1e-6 && Math.abs(md2.well.maxDls - 3) < 1e-6, 'deviation read from the survey');
      assert.strictEqual(b2.rod.checks.find((c) => c.key === 'inc').st, 'fail', 'rod pump: 90° fails');
      assert.strictEqual(b2.esp.checks.find((c) => c.key === 'inc').st, 'warn', 'ESP: 90° marginal');
      assert.ok(md2.windows.rod && md2.windows.rod.md0 === 0 && Math.abs(md2.windows.rod.md1 - 1000) < 1e-6, 'rod window: surface to the kick-off');
      const st60 = D.expect[3];
      assert.ok(md2.windows.esp && Math.abs(md2.windows.esp.md1 - st60.md) < 1e-6 && Math.abs(md2.windows.esp.tvd1 - st60.tvd) < 0.01, 'ESP window to the 60° station, TVD by minimum curvature: ' + JSON.stringify(plain(md2.windows.esp)));
      const g = SC.matrix(S.FIX.gasWell, {}), bg = {}; g.methods.forEach((m) => { bg[m.key] = m; });
      assert.ok(bg.esp.checks.some((c) => c.key === 'fluid') && bg.plunger.checks.some((c) => c.key === 'glrd'), 'gas well: pumps for dewatering only, plunger GLR rule');
    },
  },
  {
    name: 'WSC2 screening Job: natural = the solve, gas lift = the quick-look optimum, ESP not available (never natural flow), pump potential = IPR',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, SC = G.WTS_wp_screen, SY = G.WTS_wp_system;
      const M = S.FIX.oilWell; M.fluid.wc = 0.6; M.res.pr = 2600;
      const R = SY.solve(M), r = run(SC.job(M, { R, pwfMin: 500 }));
      assert.ok(r.ok && r.verified === false, JSON.stringify(plain(r.errors)));
      assert.strictEqual(r.natural.ok, R.ok);
      const Mg = JSON.parse(JSON.stringify(M)); Mg.lift.gl.pinj_psig = 1000; Mg.lift.type = 'gaslift';
      const g = run(G.WTS_wp_gl.glpc(Mg, { qinjList: [0, 500, 1000, 2000, 3500] }));
      assert.ok(r.gaslift.ok && r.gaslift.assumedPinj && r.gaslift.pinj_psig === 1000 && Math.abs(r.gaslift.qL - g.optimum.qL) < 1e-9 && r.gaslift.qinj === g.optimum.qinj, 'gas lift = the quick-look optimum: ' + r.gaslift.qL + ' at ' + r.gaslift.qinj);
      assert.ok(r.warnings.some((w) => w.code === 'PINJ_ASSUMED'), 'screening pressure stated');
      assert.ok(!r.esp.ok && r.esp.code === 'ESP_NOT_AVAILABLE' && r.esp.q == null, 'ESP not available, no natural-flow number');
      const F = G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F }), I = G.WTS_wp_ipr.curve(M.res, F);
      assert.ok(Math.abs(r.potential.q - I.qAt(500)) < 1e-9 && r.potential.pwf === 500, 'pump potential');
      assert.ok(r.evals < 120, 'screening ' + r.evals + ' E');
      const rg = run(SC.job(S.FIX.gasWell, {}));
      assert.ok(rg.ok && !rg.gaslift.ok && rg.gaslift.code === 'GL_NOT_APPLICABLE', 'gas well: no gas-lift rate');
    },
  },
];
