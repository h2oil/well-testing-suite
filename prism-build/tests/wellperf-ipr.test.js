// Well Performance inflow — docs/WELL-PERFORMANCE-PLAN.md §3.3, §4.2, §15.1, §15.2, §17.1 (wellperf-ipr, 12 tests; WP2).
//
// IP1 / IP2 delegation identity: WTS_oilipr_model / WTS_gasdeliv_model (and WTS_wp_ipr.curve on top of them) reproduce the
//   compute() tables of the two calculators exactly (Object.is); IP3 fit() delegates to the calculators' fitters;
// IP4 Jones-Blount-Glaze; IP5 Darcy oil, the three reference forms and the general-area form; IP6 Darcy gas (m(p) and p²);
// IP7 m(p) LIT through WTS_gasdeliv_fitAB; IP8 the non-Darcy D estimate and its coefficients (Geertsma β in 1/ft, Forchheimer);
// IP9 inverses and bounds for every model + SHAPE.I; IP10 PRiSM import with provenance (read only); IP11 the stored gas
// deliverability summary; IP12 a missing p̄r is never defaulted + future IPR rules.
// Benchmarks (§15.1, Q9): the textbooks were not provided, so the methods without a verified published example ship with
// verified:false and the provisional label (D17); their tests are hand calculations and internal cross-checks (§15.2). The
// delegated Vogel / composite / Fetkovich / back-pressure / LIT p² paths keep the calculators' pinned examples.
'use strict';

const S = require('./_wellperf-shapes');

const WP = 'WP2';
const app0 = (ctx) => S.sharedApp(ctx);
const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const OIL_VECTORS = [
  { method: 'pi', pr: 3000, points: [{ q: 1000, pwf: 2500 }] },
  { method: 'vogel', pr: 2400, pb: 2400, fe: 1, points: [{ q: 100, pwf: 1800 }] },
  { method: 'vogel', pr: 2400, pb: 2600, fe: 0.7, points: [{ q: 100, pwf: 1800 }] },
  { method: 'vogel', pr: 2400, pb: 2400, fe: 1.3, points: [{ q: 100, pwf: 1800 }] },
  { method: 'vogel', pr: 3000, pb: 2000, fe: 1, points: [{ q: 900, pwf: 2500 }] },
  { method: 'vogel', pr: 3000, pb: 2000, fe: 1, points: [{ q: 1500, pwf: 1500 }] },
  { method: 'fetk', pr: 2000, points: [{ q: 880, pwf: 1600 }, { q: 1320, pwf: 1200 }, { q: 1560, pwf: 800 }] },
];
const GAS_PTS = (k, q, pwf, pws) => ({ kind: k, q, pwf, pws });
const GAS_VECTORS = [
  { type: 'faf', pr: 1952, pb: 14.65, points: [GAS_PTS('stab', 2624.6, 1700), GAS_PTS('stab', 4154.7, 1500), GAS_PTS('stab', 5425.1, 1300)] },
  { type: 'iso', pr: 3000, pb: 14.65, points: [GAS_PTS('trans', 3534.6, 2800), GAS_PTS('trans', 5790.1, 2600), GAS_PTS('trans', 7636.8, 2400), GAS_PTS('stab', 4727.1, 2500)] },
  { type: 'miso', pr: 3000, pb: 14.65, points: [GAS_PTS('trans', 3000, 2800, 3000), GAS_PTS('trans', 5000, 2550, 2980), GAS_PTS('trans', 6500, 2300, 2960), GAS_PTS('stab', 4200, 2450)] },
  { type: 'single', pr: 2500, pb: 14.65, nAssumed: 0.8, points: [GAS_PTS('stab', 3000, 2000)] },
];
// a fake WP1 fluid object (the §3.2 contract members the inflow reads: ok, at(p, T) → {bo, muo}, pb(T), sg)
const FAKE_F = { ok: true, at: () => ({ bo: 1.25, muo: 0.9 }), pb: () => 2000, sgWell: 0.72 };

module.exports = [
  {
    name: 'IP1 delegation identity (oil): WTS_oilipr_model and WTS_wp_ipr.curve reproduce WTS_oilipr_compute tables and curves exactly (PI, Vogel FE < 1 / = 1 / > 1, composite, Fetkovich)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app0(ctx).win, W = G.WTS_wp_ipr;
      OIL_VECTORS.forEach((v, i) => {
        const r = G.WTS_oilipr_compute(v);
        assert.ok(r.ok, 'vector ' + i + ' solved');
        let spec, key, params;
        if (r.mode === 'pi') { spec = { mode: 'pi', pr: v.pr, J: r.J }; key = 'pi'; params = { J: r.J }; }
        else if (r.mode === 'vogel-sat') { spec = { mode: 'vogel', pr: v.pr, qmax: r.qmaxFE1, FE: v.fe }; key = 'vogel'; params = { qmax: r.qmaxFE1, FE: v.fe }; }
        else if (r.mode === 'composite') { spec = { mode: 'composite', pr: v.pr, pb: v.pb, J: r.J }; key = 'composite'; params = { J: r.J }; }
        else { spec = { mode: 'fetkovich', pr: v.pr, C: r.C, n: r.n }; key = 'fetkovich'; params = { C: r.C, n: r.n }; }
        const m = G.WTS_oilipr_model(spec);
        assert.ok(m.ok, i + ' model ok');
        assert.ok(Object.is(m.aof, r.qmax), i + ' aof = compute qmax');
        const I = W.curve({ model: key, pr: v.pr, pb: v.pb, params });
        assert.ok(I.ok, i + ' curve ok ' + JSON.stringify(plain(I.errors)));
        r.table.concat(r.curve).forEach((t) => {
          if (t.pwf <= 0 && !t.heldAtMax) return;               // q(0) is the AOF in both
          assert.ok(Object.is(m.qAt(t.pwf), t.q), i + ' model q(' + t.pwf + ') = ' + t.q + ', got ' + m.qAt(t.pwf));
          assert.ok(Object.is(I.qAt(t.pwf), t.q), i + ' curve q(' + t.pwf + ')');
        });
        if (r.pwfAtQ != null) assert.ok(Object.is(m.pwfAt(v.qTarget), r.pwfAtQ));
        ['qt'].forEach(() => {
          const r2 = G.WTS_oilipr_compute(Object.assign({}, v, { qTarget: r.qmax * 0.37 }));
          assert.ok(Object.is(m.pwfAt(r.qmax * 0.37), r2.pwfAtQ), i + ' pwf(q) = compute pwfAtQ');
        });
        assert.strictEqual(I.engine.indexOf('WTS_oilipr_model'), 0, 'delegated');
      });
    },
  },
  {
    name: 'IP2 delegation identity (gas): WTS_gasdeliv_model and WTS_wp_ipr.curve reproduce WTS_gasdeliv_compute tables exactly (flow-after-flow, isochronal, modified isochronal, single point); fitAB = compute LIT',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app0(ctx).win, W = G.WTS_wp_ipr;
      GAS_VECTORS.forEach((v, i) => {
        const r = G.WTS_gasdeliv_compute(Object.assign({ pwfDesign: v.pr * 0.6, qTarget: 1000 }, v));
        assert.ok(r.ok, 'vector ' + i);
        const cn = G.WTS_gasdeliv_model({ cn: { C: r.cn.C, n: r.cn.n }, pr: v.pr, pAof: v.pb });
        const Icn = W.curve({ model: 'backPressure', pr: v.pr, params: { C: r.cn.C, n: r.cn.n, pAof: v.pb } });
        assert.ok(Object.is(cn.aof, r.cn.aof) && Object.is(Icn.aof, r.cn.aof), i + ' C&n AOF');
        assert.ok(Object.is(cn.qAt(v.pr * 0.6), r.cn.qAtPwf), i + ' C&n q at the design pwf');
        assert.ok(Object.is(cn.pwfAt(1000), r.cn.pwfAtQ), i + ' C&n pwf at the target rate');
        r.table.forEach((t) => { if (t.pwf > v.pb) { assert.ok(Object.is(cn.qAt(t.pwf), t.qCn), i + ' table qCn'); assert.ok(Object.is(Icn.qAt(t.pwf), t.qCn)); } });
        if (!r.lit.ok) { assert.strictEqual(v.type, 'single', 'LIT only skipped for a single point'); return; }
        const lit = G.WTS_gasdeliv_model({ lit: { a: r.lit.a, b: r.lit.b }, pr: v.pr, pAof: v.pb });
        const Il = W.curve({ model: 'litP2', pr: v.pr, params: { a: r.lit.a, b: r.lit.b, pAof: v.pb } });
        assert.ok(Object.is(lit.aof, r.lit.aof) && Object.is(Il.aof, r.lit.aof), i + ' LIT AOF');
        assert.ok(Object.is(lit.qAt(v.pr * 0.6), r.lit.qAtPwf), i + ' LIT q at the design pwf');
        assert.ok(Object.is(lit.pwfAt(1000), r.lit.pwfAtQ), i + ' LIT pwf at the target rate');
        r.table.forEach((t) => { if (t.pwf > v.pb) assert.ok(Object.is(lit.qAt(t.pwf), t.qLit), i + ' table qLit'); });
        // the generic fitter on Δ = p̄r² − pwf² (Δ from pws for transient points of a modified isochronal test)
        const slope = v.type === 'faf' ? r.points : r.points.filter((p) => p.kind === 'trans');
        const stab = v.type === 'faf' ? null : r.points.filter((p) => p.kind === 'stab').pop();
        const ab = G.WTS_gasdeliv_fitAB(slope, (p) => p.delta, stab ? { stab } : {});
        assert.ok(ab.ok && Object.is(ab.a, r.lit.a) && Object.is(ab.b, r.lit.b), i + ' fitAB = compute LIT');
      });
    },
  },
  {
    name: 'IP3 fit() delegates: PI / Vogel / composite / Fetkovich → WTS_oilipr_compute, back-pressure / LIT p² → WTS_gasdeliv_compute; a curve from test points = the curve from the fitted parameters',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app0(ctx).win, W = G.WTS_wp_ipr;
      const f1 = W.fit('vogel', [{ q: 100, pwf: 1800 }], { pr: 2400 });
      const r1 = G.WTS_oilipr_compute({ method: 'vogel', pr: 2400, pb: 2400, points: [{ q: 100, pwf: 1800 }] });
      assert.ok(f1.ok && f1.source === 'WTS_oilipr_compute' && Object.is(f1.params.qmax, r1.qmaxFE1));
      assert.rel(r1.qmax, 250, 1e-3, 'textbook Vogel qmax = 250 (the calculator\'s pinned example)');
      const f2 = W.fit('composite', [{ q: 900, pwf: 2500 }], { pr: 3000, pb: 2000 });
      assert.ok(f2.ok && Object.is(f2.params.J, 900 / 500));
      const pts = [{ q: 880, pwf: 1600 }, { q: 1320, pwf: 1200 }, { q: 1560, pwf: 800 }];
      const f3 = W.fit('fetkovich', pts, { pr: 2000 }), r3 = G.WTS_oilipr_compute({ method: 'fetk', pr: 2000, points: pts });
      assert.ok(Object.is(f3.params.C, r3.C) && Object.is(f3.params.n, r3.n) && Object.is(f3.r2, r3.r2));
      const gp = GAS_VECTORS[0].points;
      const f4 = W.fit('backPressure', gp, { pr: 1952 }), f5 = W.fit('litP2', gp, { pr: 1952 });
      const g = G.WTS_gasdeliv_compute(GAS_VECTORS[0]);
      assert.ok(f4.ok && Object.is(f4.params.C, g.cn.C) && Object.is(f4.params.n, g.cn.n) && f4.source === 'WTS_gasdeliv_compute');
      assert.ok(f5.ok && Object.is(f5.params.a, g.lit.a) && Object.is(f5.params.b, g.lit.b));
      assert.rel(g.cn.aof, 9033.5, 1e-3, 'textbook flow-after-flow AOF (the calculator\'s pinned example)');
      const Ip = W.curve({ model: 'litP2', pr: 1952, points: gp }), Iq = W.curve({ model: 'litP2', pr: 1952, params: f5.params });
      assert.ok(Ip.ok && Ip.warnings.some((w) => w.code === 'FITTED'));
      assert.deepStrictEqual(plain(Ip.curve), plain(Iq.curve), 'fitted curve = curve from the parameters');
      const nf = W.fit('darcyOil', gp, { pr: 1952 });
      assert.ok(!nf.ok && nf.code === 'NOT_FITTABLE');
      assert.strictEqual(W.fit('pi', gp, {}).code, 'PR_NEEDED');
    },
  },
  {
    name: 'IP4 Jones-Blount-Glaze: p̄r − pwf = A·q + B·q² fitted by WTS_gasdeliv_fitAB recovers A and B; q(pwf) is the positive root (hand value); provisional label',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const W = app0(ctx).win.WTS_wp_ipr, A = 0.4, B = 1e-4, pr = 3000;
      const pts = [500, 1000, 2000, 3000].map((q) => ({ q, pwf: pr - (A * q + B * q * q) }));
      const f = W.fit('jbgOil', pts, { pr });
      assert.ok(f.ok && f.source === 'WTS_gasdeliv_fitAB');
      assert.rel(f.params.A, A, 1e-10, 'A'); assert.rel(f.params.B, B, 1e-10, 'B'); assert.rel(f.r2, 1, 1e-12, 'exact points');
      const I = W.curve({ model: 'jbgOil', pr, params: { A, B } });
      assert.ok(I.ok && I.kind === 'oil' && I.verified === false && /provisional/.test(I.provisional));
      assert.ok(I.warnings.some((w) => w.code === 'PROVISIONAL'));
      // hand: Δp = 1000 psi → q = (−0.4 + √(0.16 + 0.4))/(2e-4) = 1741.657…
      assert.rel(I.qAt(2000), (-0.4 + Math.sqrt(0.16 + 4 * 1e-4 * 1000)) / 2e-4, 1e-12, 'positive root');
      assert.rel(I.qAt(2000), 1741.657386773941, 1e-12);
      assert.rel(I.aof, (-0.4 + Math.sqrt(0.16 + 4 * 1e-4 * 3000)) / 2e-4, 1e-12, 'AOF at pwf = 0');
      I.curve.forEach((c) => assert.near(pr - c.pwf, A * c.q + B * c.q * c.q, 1e-8, 'relation on the curve'));
      assert.rel(I.J, 1 / A, 1e-15, 'J at zero rate = 1/A');
      // one point with a fixed B (opts.b): A from the point
      const f1 = W.fit('jbgOil', [pts[1]], { pr, b: B });
      assert.ok(f1.ok); assert.rel(f1.params.A, A, 1e-10);
      assert.ok(!W.fit('jbgOil', [pts[1]], { pr }).ok, 'one point and no B → no fit');
    },
  },
  {
    name: 'IP5 Darcy oil: J = k·h/(141.2·Bo·μo·[X + S]) with X = ln(re/rw) − 0.75 | − 0.5 | 0 (three reference forms) and the general-area form; composite below pb; Bo / μo and pb from the fluid; S from the skin table',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const W = app0(ctx).win.WTS_wp_ipr;
      const base = { k: 50, h: 30, rw: 0.354, re: 1490, S: 2, Bo: 1.2, muo: 1.5 };
      const lnr = Math.log(1490 / 0.354);
      [['pss', 0.75], ['ss', 0.5], ['ssPe', 0], [0, 0.75], [1, 0.5], [2, 0]].forEach(([ref, c]) => {
        const I = W.curve({ model: 'darcyOil', pr: 3000, params: Object.assign({ ref }, base) });
        const J = 50 * 30 / (141.2 * 1.2 * 1.5 * (lnr - c + 2));
        assert.ok(I.ok); assert.rel(I.J, J, 1e-14, 'J ' + ref); assert.rel(I.aof, J * 3000, 1e-12, 'no pb → straight line');
        assert.ok(I.warnings.some((w) => w.code === 'NO_PB'));
      });
      assert.rel(W.darcyX({ rw: 0.354, re: 1490 }).X, lnr - 0.75, 1e-15);
      // general area: ½·ln(10.06·A/(C_A·rw²)) − 0.75 with the circle's C_A = 31.62 equals ln(re/rw) − 0.75 to 3e-4
      const Acir = Math.PI * 1490 * 1490 / 43560;
      const xg = W.darcyX({ rw: 0.354, A_acres: Acir, CA: 31.62 });
      assert.ok(xg.ok); assert.near(xg.X, lnr - 0.75, 3e-4, 'circle C_A');
      // below pb: composite with the Darcy J (oilipr builder): q(pwf < pb) = qb + J·pb/1.8·V(pwf/pb)
      const Ic = W.curve({ model: 'darcyOil', pr: 3000, pb: 2000, params: base });
      const J = Ic.J, x = 1000 / 2000;
      assert.ok(Ic.pb === 2000 && /composite/.test(Ic.engine));
      assert.rel(Ic.qAt(1000), J * 1000 + J * 2000 / 1.8 * (1 - 0.2 * x - 0.8 * x * x), 1e-14);
      // Bo / μo and pb from the fluid model when they are not entered
      const If = W.curve({ model: 'darcyOil', pr: 3000, params: { k: 50, h: 30, rw: 0.354, re: 1490, S: 2 } }, FAKE_F);
      assert.ok(If.ok && If.pb === 2000 && If.form.BmuSource === 'fluid at p̄r');
      assert.rel(If.J, 50 * 30 / (141.2 * 1.25 * 0.9 * (lnr - 0.75 + 2)), 1e-14);
      // S from the skin table when S is not entered (Hawkins damage, h_p = h)
      const Is = W.curve({ model: 'darcyOil', pr: 3000, params: { k: 50, h: 30, rw: 0.354, re: 1490, Bo: 1.2, muo: 1.5, ks: 5, rs: 1.5 } });
      const Sd = (50 / 5 - 1) * Math.log(1.5 / 0.354);
      assert.ok(Is.form.Ssource === 'skin table' && Is.skin && Is.skin.parts[0].key === 'damage');
      assert.rel(Is.params.S, Sd, 1e-14);
      assert.ok(W.curve({ model: 'darcyOil', pr: 3000, params: { k: 50, h: 30, rw: 0.354, re: 1490 } }).code === 'NEEDS', 'no Bo / μo and no fluid → NEEDS');
      assert.strictEqual(W.curve({ model: 'darcyOil', pr: 3000, params: Object.assign({}, base, { S: -9 }) }).code, 'BAD_SKIN');
    },
  },
  {
    name: 'IP6 Darcy gas: m(p̄r) − m(pwf) = 1422·T·q/(k·h)·[X + S + D·q] on PRiSM_mpTable; D = 0 → linear in m(p); the p² form uses μ̄z̄ at the mean pressure',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app0(ctx).win, W = G.WTS_wp_ipr;
      const P = { k: 5, h: 50, rw: 0.354, re: 1490, S: 1, D: 2e-4, sg: 0.7 }, T = 230, TR = T + 459.67, pr = 5000;
      const I = W.curve({ model: 'darcyGas', pr, T_F: T, params: P });
      assert.ok(I.ok && I.kind === 'gas' && I.verified === false && I.form.delta === 'm(p)');
      const X = Math.log(1490 / 0.354) - 0.75, a = 1422 * TR * (X + 1) / (5 * 50), b = 1422 * TR * 2e-4 / (5 * 50);
      assert.rel(I.form.a, a, 1e-14); assert.rel(I.form.b, b, 1e-14);
      const tb = G.PRiSM_mpTable({ T_F: T, sg: 0.7, pmax: 1.2 * pr });
      [1000, 2500, 4000].forEach((pwf) => {
        const q = I.qAt(pwf);
        assert.rel(tb.mOf(pr) - tb.mOf(pwf), a * q + b * q * q, 1e-12, 'relation at ' + pwf);
      });
      assert.rel(I.aof, I.qAt(14.65), 0, 'AOF at 14.65 psia'); assert.strictEqual(I.pAof, 14.65);
      const I0 = W.curve({ model: 'darcyGas', pr, T_F: T, params: Object.assign({}, P, { D: 0 }) });
      assert.rel(I0.qAt(2500), (tb.mOf(pr) - tb.mOf(2500)) / a, 1e-12, 'D = 0 → linear');
      // p² form: (p̄r² − pwf²) = μ̄z̄·(a·q + b·q²) with μ̄, z̄ at pMean
      const L = G.PRiSM_pvt_correlations, pM = 3500;
      const z = L.Z_dranchukAbouKassem(TR / L.Tpc_sutton(0.7), pM / L.Ppc_sutton(0.7)), mu = L.mu_g_leeGonzalezEakin(0.7, T, z, pM);
      const I2 = W.curve({ model: 'darcyGas', pr, T_F: T, params: Object.assign({ p2: 1, pMean: pM }, P) });
      const q2 = I2.qAt(2500);
      assert.rel(pr * pr - 2500 * 2500, mu * z * (a * q2 + b * q2 * q2), 1e-12, 'p² form');
      assert.ok(I2.warnings.some((w) => w.code === 'P2_APPROX'));
      // gravity from the fluid (the reservoir / recombined gas, D14) when not entered
      const If = W.curve({ model: 'darcyGas', pr, T_F: T, params: { k: 5, h: 50, rw: 0.354, re: 1490, S: 1 } }, FAKE_F);
      assert.ok(If.ok && If.params.sg === 0.72 && If.warnings.some((w) => w.code === 'D_ZERO'));
      assert.strictEqual(W.curve({ model: 'darcyGas', pr, T_F: T, params: { k: 5, h: 50, rw: 0.354, re: 1490 } }).code, 'NEEDS_SG');
      assert.strictEqual(W.curve({ model: 'darcyGas', pr, params: P }).code, 'NEEDS_T');
    },
  },
  {
    name: 'IP7 LIT in m(p): WTS_gasdeliv_fitAB with Δ = m(p̄r) − m(pwf) recovers a and b from exact points; the curve satisfies the relation; a curve fitted to the points matches the parameter curve',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app0(ctx).win, W = G.WTS_wp_ipr, T = 230, pr = 5000, sg = 0.7, a = 30000, b = 3;
      const tb = G.PRiSM_mpTable({ T_F: T, sg, pmax: 1.2 * pr });
      const I = W.curve({ model: 'litMp', pr, T_F: T, params: { a, b, sg } });
      assert.ok(I.ok && I.verified === false && /fitAB|mpTable/.test(I.engine));
      const pts = [2000, 5000, 9000, 14000].map((q) => ({ q, pwf: I.pwfAt(q) }));
      pts.forEach((p) => assert.rel(tb.mOf(pr) - tb.mOf(p.pwf), a * p.q + b * p.q * p.q, 1e-10, 'relation at q = ' + p.q));
      const f = W.fit('litMp', pts, { pr, T_F: T, sg });
      assert.ok(f.ok && f.source === 'WTS_gasdeliv_fitAB');
      assert.rel(f.params.a, a, 1e-8, 'a'); assert.rel(f.params.b, b, 1e-6, 'b');
      const If = W.curve({ model: 'litMp', pr, T_F: T, points: pts, params: { sg } });
      assert.ok(If.ok && If.warnings.some((w) => w.code === 'FITTED'));
      assert.rel(If.aof, I.aof, 1e-8, 'AOF from the fitted curve');
      assert.strictEqual(W.fit('litMp', pts, { pr }).code, 'NEEDS', 'm(p) fit needs T and sg');
    },
  },
  {
    name: 'IP8 D estimate: β = 4.85e4/(φ^5.5·√k) 1/ft is Geertsma\'s 0.005/(φ^5.5·√k[cm²]) cm⁻¹; D = (3.161e-12/1422)·β·k·γg/(μg·h_p·rw) d/Mscf (the Forchheimer term in m(p) units); labelled an estimate',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app0(ctx).win, W = G.WTS_wp_ipr, K = W.CONST;
      // unit derivation of both coefficients
      const md_cm2 = 9.869233e-12, ft_cm = 30.48;
      assert.rel(0.005 * ft_cm / Math.sqrt(md_cm2), K.C_BETA, 2e-3, 'β coefficient from the cgs form (k in cm², β in cm⁻¹ → md, ft⁻¹)');
      assert.rel(K.C_D, 2.222e-15, 5e-4, 'D coefficient = 3.161e-12/1422');
      assert.rel(K.C_D * K.C_DARCY_GAS, K.C_FORCH, 1e-15, 'b·q² of the Darcy gas form = the Forchheimer Δm term');
      const e = W.estimateD({ k: 10, phi: 0.12, sg: 0.65, mu: 0.025, hp: 40, rw: 0.354 });
      const beta = 4.85e4 / (Math.pow(0.12, 5.5) * Math.sqrt(10));
      assert.ok(e.ok && /estimate/.test(e.label) && /provisional/.test(e.label));
      assert.rel(e.beta, beta, 1e-14); assert.rel(e.D, 3.161e-12 / 1422 * beta * 10 * 0.65 / (0.025 * 40 * 0.354), 1e-14);
      assert.within(e.D, 1e-5, 1e-2, 'a plausible D in d/Mscf');
      assert.strictEqual(W.estimateD({ k: 10, phi: 1.2, sg: 0.65, mu: 0.025, hp: 40, rw: 0.354 }).code, 'NEEDS', 'φ as a fraction');
      // Darcy gas with Dest = 1 uses it, μg at pD (default p̄r)
      const L = G.PRiSM_pvt_correlations, T = 230, TR = T + 459.67, pD = 3000;
      const z = L.Z_dranchukAbouKassem(TR / L.Tpc_sutton(0.7), pD / L.Ppc_sutton(0.7)), mu = L.mu_g_leeGonzalezEakin(0.7, T, z, pD);
      const I = W.curve({ model: 'darcyGas', pr: 5000, T_F: T, params: { k: 10, h: 40, rw: 0.354, re: 1490, S: 0, sg: 0.7, phi: 0.12, Dest: 1, pD } });
      assert.ok(I.ok && /estimate/.test(I.Dsource) && I.warnings.some((w) => w.code === 'D_ESTIMATE'));
      assert.rel(I.D, W.estimateD({ k: 10, phi: 0.12, sg: 0.7, mu, hp: 40, rw: 0.354 }).D, 1e-14);
    },
  },
  {
    name: 'IP9 inverses and bounds for every model: q(pwf(q)) = q and pwf(q(pwf)) = pwf within 1e-9 relative; q ≤ 0 → p̄r, q > AOF → null, pwf ≥ p̄r → 0; every curve has SHAPE.I',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const W = app0(ctx).win.WTS_wp_ipr;
      const SPECS = [
        { model: 'pi', pr: 3000, params: { J: 2 } },
        { model: 'vogel', pr: 2400, params: { qmax: 250, FE: 0.8 } },
        { model: 'vogel', pr: 2400, params: { qmax: 250, FE: 1.3 } },
        { model: 'composite', pr: 3000, pb: 2000, params: { J: 2 } },
        { model: 'fetkovich', pr: 2000, params: { C: 2.9e-3, n: 0.8 } },
        { model: 'jbgOil', pr: 3000, params: { A: 0.4, B: 1e-4 } },
        { model: 'darcyOil', pr: 3000, pb: 2000, params: { k: 50, h: 30, rw: 0.354, re: 1490, S: 2, Bo: 1.2, muo: 1.5 } },
        { model: 'backPressure', pr: 1952, params: { C: 0.017, n: 0.87 } },
        { model: 'litP2', pr: 5000, params: { a: 500, b: 0.05 } },
        { model: 'litMp', pr: 5000, T_F: 230, params: { a: 30000, b: 3, sg: 0.7 } },
        { model: 'darcyGas', pr: 5000, T_F: 230, params: { k: 5, h: 50, rw: 0.354, re: 1490, S: 1, D: 2e-4, sg: 0.7 } },
      ];
      const keys = new Set();
      SPECS.forEach((s) => {
        const I = W.curve(s);
        keys.add(s.model);
        assert.ok(I.ok, s.model + ' ' + JSON.stringify(plain(I.errors)));
        const sh = S.checkShape('I', I); assert.ok(sh.ok, s.model + ': ' + sh.errors.join('; '));
        [0.02, 0.2, 0.5, 0.8, 0.98].forEach((f) => {
          const q = f * I.aof, p = I.pwfAt(q);
          assert.rel(I.qAt(p), q, 1e-9, s.model + ' q(pwf(q)) at ' + f);
          const pw = I.pAof + f * (s.pr - I.pAof);
          if (I.key === 'vogel' && s.params.FE > 1 && pw < s.pr * (1 - 1 / s.params.FE)) return;   // held at qmax there
          assert.rel(I.pwfAt(I.qAt(pw)), pw, 1e-9, s.model + ' pwf(q(pwf)) at ' + f);
        });
        assert.strictEqual(I.pwfAt(0), s.pr); assert.strictEqual(I.pwfAt(-5), s.pr);
        assert.strictEqual(I.pwfAt(I.aof * 1.01), null, s.model + ' above the AOF');
        assert.strictEqual(I.qAt(s.pr), 0); assert.strictEqual(I.qAt(s.pr + 100), 0);
        assert.strictEqual(I.curve.length, 41); assert.strictEqual(I.curve[0].q, 0); assert.rel(I.curve[40].q, I.aof, 1e-12);
        for (let i = 1; i < 41; i++) assert.ok(I.curve[i].q >= I.curve[i - 1].q, s.model + ' monotone');
      });
      assert.deepStrictEqual([...keys].sort(), Object.keys(W.models).filter((k) => (W.B_KEYS || []).indexOf(k) === -1).sort(), 'every A1 model covered (the increment-B models: wellperf-ipr2)');
      Object.keys(W.models).filter((k) => (W.B_KEYS || []).indexOf(k) === -1).forEach((k) => { const m = W.models[k]; assert.ok(m.key === k && (m.kind === 'oil' || m.kind === 'gas') && Array.isArray(m.needs) && typeof m.curve === 'function'); });
      ['jbgOil', 'darcyOil', 'litMp', 'darcyGas'].forEach((k) => assert.ok(W.models[k].verified === false && /provisional/.test(W.models[k].provisional), k + ' provisional (D17)'));
      ['pi', 'vogel', 'composite', 'fetkovich', 'backPressure', 'litP2'].forEach((k) => assert.ok(W.models[k].verified === true, k + ' delegated, pinned'));
      assert.strictEqual(W.curve({ model: 'nope', pr: 1 }).code, 'UNKNOWN_MODEL');
      assert.strictEqual(W.models.pi.curve({ pr: 3000, params: { J: 2 } }).aof, 6000, 'registry curve');
    },
  },
  {
    name: 'IP10 PRiSM import (fromWell): k and S from the last fit, h / rw / φ / Bo / μo from PRiSM_getWell, each with its provenance; a trusted p̄r is taken; nothing is written back',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app0(ctx).win, W = G.WTS_wp_ipr;
      const sv = { gw: G.PRiSM_getWell, lf: G.PRiSM_getLastFit, st: G.PRiSM_state && G.PRiSM_state.deliverability };
      const before = JSON.stringify(G.PRiSM_pvt || null), beforeSt = JSON.stringify(G.PRiSM_state || null);
      try {
        G.PRiSM_getWell = () => ({ fluid: 'oil', pi: 3200, T_F: 190, h: 40, rw: 0.354, phi: 0.18, ct: 1.2e-5, B: 1.25, mu: 0.9, sg: 0.7,
          provenance: { pi: 'user', h: 'user', rw: 'default', phi: 'dataset', B: 'correlation', mu: 'correlation', ct: 'correlation' } });
        G.PRiSM_getLastFit = () => ({ modelKey: 'homogeneous', phys: { k: 35, S: 3.2, C: 0.01 }, params: {} });
        if (G.PRiSM_state) delete G.PRiSM_state.deliverability;
        const r = W.fromWell();
        assert.ok(r.ok && r.spec.model === 'darcyOil' && r.spec.pr === 3200 && r.spec.T_F === 190);
        const P = plain(r.spec.params);
        assert.deepStrictEqual([P.k, P.S, P.h, P.rw, P.phi, P.Bo, P.muo], [35, 3.2, 40, 0.354, 0.18, 1.25, 0.9]);
        assert.strictEqual(r.provenance.k, 'PRiSM fit (homogeneous)');
        assert.strictEqual(r.provenance.h, 'PRiSM well (user)'); assert.strictEqual(r.provenance.rw, 'PRiSM well (default)');
        assert.strictEqual(r.provenance.Bo, 'PRiSM well (correlation)'); assert.strictEqual(r.provenance.pr, 'PRiSM well (user)');
        assert.ok(r.warnings.some((w) => w.code === 'NEEDS_RE'), 're is asked for');
        // the imported spec draws once re is added
        const I = W.curve(Object.assign({}, r.spec, { params: Object.assign({ re: 1490 }, r.spec.params) }));
        assert.ok(I.ok); assert.rel(I.J, 35 * 40 / (141.2 * 1.25 * 0.9 * (Math.log(1490 / 0.354) - 0.75 + 3.2)), 1e-14);
        // no fit → k, S missing, said so
        G.PRiSM_getLastFit = () => null;
        const r2 = W.fromWell();
        assert.ok(r2.ok && r2.spec.params.k === undefined && r2.warnings.some((w) => w.code === 'NO_FIT') && r2.warnings.some((w) => w.code === 'NEEDS_KH'));
      } finally {
        G.PRiSM_getWell = sv.gw; G.PRiSM_getLastFit = sv.lf; if (sv.st && G.PRiSM_state) G.PRiSM_state.deliverability = sv.st;
      }
      assert.strictEqual(JSON.stringify(G.PRiSM_pvt || null), before, 'PRiSM well store unchanged');
      assert.strictEqual(JSON.stringify(G.PRiSM_state || null), beforeSt, 'PRiSM state unchanged');
    },
  },
  {
    name: 'IP11 gas deliverability import: the stored PRiSM deliverability summary of the current dataset gives C, n, a, b and the AOF back-pressure (LIT p² model); a summary of another dataset is not imported',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app0(ctx).win, W = G.WTS_wp_ipr;
      const sv = { gw: G.PRiSM_getWell, lf: G.PRiSM_getLastFit, dh: G.PRiSM_datasetHash };
      G.PRiSM_state = G.PRiSM_state || {};
      const svD = G.PRiSM_state.deliverability;
      try {
        G.PRiSM_getWell = () => ({ fluid: 'gas', pi: 1952, T_F: 200, h: 30, rw: 0.3, phi: 0.15, B: 0.9, mu: 0.02, sg: 0.65, provenance: { pi: 'dataset' } });
        G.PRiSM_getLastFit = () => ({ modelKey: 'homogeneous', phys: { k: 8, S: 1.5, D: 3e-4 } });
        G.PRiSM_datasetHash = () => 'H1';
        const g = G.WTS_gasdeliv_compute(GAS_VECTORS[0]);
        G.PRiSM_state.deliverability = { kind: 'gas', datasetHash: 'H1', summary: { n: g.cn.n, C: g.cn.C, r2: g.cn.r2, aofCn: g.cn.aof, a: g.lit.a, b: g.lit.b,
          aofLit: g.lit.aof, type: 'faf', pr: 1952, pb: 14.65 } };
        const r = W.fromWell();
        assert.ok(r.ok && r.spec.model === 'litP2');
        const P = r.spec.params;
        assert.ok(Object.is(P.a, g.lit.a) && Object.is(P.b, g.lit.b) && Object.is(P.C, g.cn.C) && P.pAof === 14.65 && P.D === 3e-4 && P.sg === 0.65);
        assert.ok(/PRiSM gas deliverability/.test(r.provenance.a) && r.provenance.D === 'PRiSM fit (homogeneous)');
        const I = W.curve(r.spec);
        assert.ok(I.ok && Object.is(I.aof, g.lit.aof), 'AOF = the stored LIT AOF');
        G.PRiSM_datasetHash = () => 'H2';
        const r2 = W.fromWell();
        assert.ok(r2.spec.model === 'darcyGas' && r2.spec.params.a === undefined && r2.warnings.some((w) => w.code === 'DELIV_STALE'));
      } finally {
        G.PRiSM_getWell = sv.gw; G.PRiSM_getLastFit = sv.lf; G.PRiSM_datasetHash = sv.dh;
        if (svD === undefined) delete G.PRiSM_state.deliverability; else G.PRiSM_state.deliverability = svD;
      }
    },
  },
  {
    name: 'IP12 a missing p̄r is never defaulted (PRiSM default provenance → null + PR_NEEDED; curve → PR_NEEDED); future IPR: Vogel cube rule, Fetkovich C·ratio, others p̄r only',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app0(ctx).win, W = G.WTS_wp_ipr;
      const w = G.PRiSM_getWell();
      if (w.provenance && w.provenance.pi === 'default') {
        const r = W.fromWell();
        assert.ok(r.ok && r.spec.pr === null && r.warnings.some((x) => x.code === 'PR_NEEDED'), 'real PRiSM store: default p̄r left empty');
      }
      const sv = G.PRiSM_getWell;
      try {
        G.PRiSM_getWell = () => ({ fluid: 'oil', pi: null, piStored: 4000, h: 20, provenance: { pi: 'default' } });
        const r = W.fromWell();
        assert.ok(r.spec.pr === null && r.provenance.pr === undefined && r.warnings.some((x) => x.code === 'PR_NEEDED'));
      } finally { G.PRiSM_getWell = sv; }
      ['pi', 'vogel', 'darcyGas', 'litP2'].forEach((k) => {
        const I = W.curve({ model: k, pr: null, params: { J: 2, qmax: 100, a: 1, b: 1 } });
        assert.ok(!I.ok && I.code === 'PR_NEEDED' && /never defaulted/.test(I.errors[0]), k);
      });
      const v = W.curve({ model: 'vogel', pr: 2400, params: { qmax: 250 } }).future(2000);
      assert.ok(v.ok && v.warnings.some((x) => x.code === 'FUTURE_RULE'));
      assert.rel(v.aof, 250 * Math.pow(2000 / 2400, 3), 1e-14, 'cube rule');
      const f = W.curve({ model: 'fetkovich', pr: 2000, params: { C: 3e-3, n: 0.8 } }).future(1600);
      assert.rel(f.aof, 3e-3 * 0.8 * Math.pow(1600, 1.6), 1e-12, 'Fetkovich C·(p̄r,f/p̄r)');
      const p = W.curve({ model: 'pi', pr: 3000, params: { J: 2 } }).future(2500);
      assert.ok(p.ok && p.J === 2 && p.aof === 5000, 'J held, p̄r changed');
      assert.strictEqual(W.curve({ model: 'pi', pr: 3000, params: { J: 2 } }).future(-1).code, 'BAD_PRF');
    },
  },
];
