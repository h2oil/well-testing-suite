// Well Performance B — PVT lab match, modified black oil (Rv) and emulsion viscosity (WP23) — docs/WELL-PERFORMANCE-PLAN.md §5.1,
// §1.4 (B4, B5, B7), §3.1 (fluid.match), §3.11 (lab), §15.1 (D17), §17.3 (wellperf-pvtmatch) and US14.
//
// Published examples: none verifiable (owner Q9 — no textbooks), so the tests pin the algebra, self-consistent recovery, the shared
// property path, mass balance and the provisional gate (D17); the Woelflin chart readings are pinned to their own values.
//
// PM1  lab record: normLab cleaning; differential → flash adjustment algebra (at pb Rs = Rsb_f and Bo = Bob_f; above pb Rs = Rsb_f;
//      Bo × Bob_f / Bob_d everywhere); without the separator test → not adjusted, warned
// PM2  fit recovers the example distortion: errors after ≈ 0, Bo a / b and μo a recovered, matched pb = lab pb, LM = closed-form
//      weighted least squares (relative); the Rs / pb pair is a fixed point (Rs reaches Rsb at the lab pb)
// PM3  one lab point → a only (b held at 0); no lab pb → factor 1 with a note; bad lab → refused; gas → NOT_OIL
// PM4  the march uses the matched set: WTS_flowline_props Rs = a·Rs_c(p·f) + b, Bo = a·Bo_c + b, μo = a·μo_c + b; the undersaturated
//      branch starts at the matched pb; a user pb wins (pb = pbUser) with the matched Rs
// PM5  stale match (other correlations) not applied + MATCH_STALE; no match / an unadopted lab = the A2 path bit for bit (Object.is)
// PM6  ranking (families by mean error, viscosity pairs); the Job = fit() and rank(); cancel
// PM7  model: lab record cleaned; adopt → M.fluid.match; scalars wp_rvmode / wp_pdew / wp_emul / wp_emulT / wp_emulInv; DEFAULTS
//      keep the A1 / A2 behaviour (D17: no provisional default)
// PM8  modified black oil: mass conserved to 1e-12 along the well, free liquid falls with Rv, all vaporised at / above pd, dew point
//      from the table, the table lookup (trilinear in gravity) within 2e-3 of the direct path, validity provisional, ignored for oil
// PM9  emulsion: Brinkman closed form, water-continuous above the inversion, Woelflin readings pinned, user table log-interpolated and
//      constant beyond; the solve with an emulsion makes less than the mixture; provisional labels
// PM10 page: example lab data → Match (Job) → KPI chips, flags, parameter / family / viscosity tables, plot; Apply → lab.adopt, every
//      solve uses it (F.match.applied), studies row in #wp_res, case summary, CSV; Remove
// PM11 page: the a / b rails preview without writing and keep an adjusted match on release; Apply writes adopt.edited
// PM12 page: condensate drop-out card (Rv example, KPI MD · TVD, two plots, dew-point handle commits) and the emulsion card
//      (inversion handle commits wp_emulInv, KPI chips); Metric labels; no NaN
'use strict';

const S = require('./_wellperf-shapes');

const WP = 'WP23';
const app0 = (ctx) => S.sharedApp(ctx);
const J = (x) => JSON.parse(JSON.stringify(x));
const txt = (e) => String(e && e.textContent || '').replace(/\s+/g, ' ').trim();
const BAD = /NaN|undefined|Infinity|\[object Object\]/;
const OIL = (extra) => Object.assign({ type: 'oil', api: 35, sgg: 0.75, gor: 600, wc: 0, sgw: 1.07, psep_psig: 100, tsep_F: 80 }, extra || {});

module.exports = [
  {
    name: 'PM1 lab record: normLab cleaning; differential → flash adjustment algebra; without the separator test not adjusted (warned)',
    wp: WP,
    run(_a, assert, ctx) {
      const P = app0(ctx).win.WTS_wp_pvtmatch;
      const n = P.normLab({ T_F: 180, rows: [{ p: 2000, rs: 400 }, { p: 'x', rs: 1 }, { p: 1000, rs: 210, bo: 9 }, { p: 2000, rs: 401 }, [3000, 450, 1.3, 0.9]] });
      assert.ok(n.ok, 'ok'); assert.deepStrictEqual(J(n.lab.rows.map((r) => r.p)), [1000, 2000, 3000], 'sorted, bad / duplicate rows dropped');
      assert.strictEqual(n.lab.rows[0].bo, null, 'Bo 9 out of range → null');
      assert.ok(n.warnings.some((w) => w.code === 'LAB_DUP'));
      assert.ok(!P.normLab({ rows: [{ p: 1000, rs: 100 }] }).ok, 'no temperature → refused');
      assert.ok(!P.normLab({ T_F: 200, rows: [] }).ok, 'no rows → refused');
      const lab = { T_F: 200, basis: 'differential', pb: 2500, rsbF: 480, bobF: 1.25,
        rows: [{ p: 1000, rs: 250, bo: 1.15 }, { p: 2000, rs: 430, bo: 1.24 }, { p: 2500, rs: 520, bo: 1.30 }, { p: 3500, rs: 520, bo: 1.28 }] };
      const d = P.diffToFlash(lab), k = 1.25 / 1.30;
      assert.ok(d.ok && d.applied); assert.near(d.factor, k, 1e-15);
      const at = (p) => d.rows.filter((r) => r.p === p)[0];
      assert.near(at(2500).rs, 480, 1e-12, 'Rs_f(pb) = Rsb_f'); assert.near(at(2500).bo, 1.25, 1e-12, 'Bo_f(pb) = Bob_f');
      assert.near(at(1000).rs, 480 - (520 - 250) * k, 1e-12, 'Rs_f below pb'); assert.near(at(1000).bo, 1.15 * k, 1e-15);
      assert.strictEqual(at(3500).rs, 480, 'above pb Rs = Rsb_f'); assert.near(at(3500).bo, 1.28 * k, 1e-15, 'relative volume above pb');
      assert.ok(d.warnings.some((w) => w.code === 'DIFF_FLASH' && /provisional/.test(w.msg)), 'labelled provisional');
      const u = P.diffToFlash(Object.assign({}, lab, { bobF: null }));
      assert.ok(u.ok && !u.applied && u.warnings.some((w) => w.code === 'DIFF_NO_SEP'), 'no separator Bob → as entered');
      assert.deepStrictEqual(J(u.rows), J(P.normLab(lab).lab.rows), 'rows unchanged');
      assert.ok(!P.diffToFlash(Object.assign({}, lab, { basis: 'flash' })).applied, 'flash basis: nothing to adjust');
    },
  },
  {
    name: 'PM2 fit: the example distortion is recovered (errors ≈ 0; Bo a / b, μo a; matched pb = lab pb); LM = closed-form relative least squares',
    wp: WP,
    run(_a, assert, ctx) {
      const P = app0(ctx).win.WTS_wp_pvtmatch, spec = OIL(), lab = P.example(spec, 200);
      assert.ok(lab && lab.example === true && lab.rows.length === 9, 'example lab table (flagged)');
      const r = P.fit(spec, lab);
      assert.ok(r.ok, JSON.stringify(r.errors));
      ['rs', 'bo', 'muo'].forEach((k) => {
        const q = r.props[k];
        assert.ok(q && q.converged, k + ' converged');
        assert.ok(q.mareAfter < 0.05, k + ' error after ' + q.mareAfter);
        assert.ok(q.mareBefore > q.mareAfter * 10, k + ' improved');
        // LM against the closed-form weighted least squares on the same points
        const cf = P.wls(q.yc, q.y, q.fixedB, q.xb);
        assert.near(q.a, cf.a, 1e-6 * Math.abs(cf.a), k + ' a = closed form'); assert.near(q.b, cf.b, 1e-6 * Math.max(1, Math.abs(cf.b)), k + ' b = closed form');
      });
      assert.near(r.props.bo.a, 1.012, 2e-3); assert.near(r.props.bo.b, -0.004, 2e-3);
      assert.near(r.props.muo.a, 1.3, 5e-3, 'μo multiplier');
      assert.near(r.pb.after, lab.pb, 1e-3 * lab.pb, 'matched pb = lab pb (fixed point of Rs and the factor)');
      assert.ok(r.pb.errPct < -5, 'Standing below the lab pb before the match');
      assert.ok(r.flags.some((f) => f.code === 'MULT_MUO' && f.sev === 'fail'), 'μo multiplier outside 0.8–1.25 flagged');
      assert.ok(r.flags.some((f) => f.code === 'EXAMPLE'), 'example flagged');
      assert.strictEqual(r.match.on, true); assert.deepStrictEqual(J(r.match.corr), { rs: 'standing', bo: 'standing', muod: 'beggsRobinson', muo: 'beggsRobinson' });
    },
  },
  {
    name: 'PM3 one point → a only (b held 0); no lab pb → factor 1 with a note; refusals (bad lab, gas)',
    wp: WP,
    run(_a, assert, ctx) {
      const P = app0(ctx).win.WTS_wp_pvtmatch, spec = OIL();
      const r = P.fit(spec, { T_F: 200, rsbF: 600, rows: [{ p: 1500, rs: 300, bo: 1.2, muo: 1.1 }] });
      assert.ok(r.ok);
      ['rs', 'bo', 'muo'].forEach((k) => { assert.ok(r.props[k].fixedB && r.props[k].b === 0, k + ' b held'); assert.ok(r.props[k].mareAfter < 1e-4, k + ' one point matched (' + r.props[k].mareAfter + ' %)'); });
      assert.strictEqual(r.match.pbFactor, 1); assert.ok(r.warnings.some((w) => w.code === 'PB_NO_LAB'));
      assert.strictEqual(P.fit(spec, { rows: [] }).code, 'BAD_LAB');
      assert.strictEqual(P.fit(OIL({ type: 'gas' }), P.example(spec, 200)).code, 'NOT_OIL');
    },
  },
  {
    name: 'PM4 the march uses the matched set (Rs = a·Rs_c(p·f) + b, Bo / μo = a·y + b); the undersaturated branch starts at the matched pb; a user pb wins',
    wp: WP,
    run(_a, assert, ctx) {
      const G = app0(ctx).win, P = G.WTS_wp_pvtmatch, W = G.WTS_wp_fluid, L = G.PRiSM_pvt_correlations;
      const m = { on: true, pbFactor: 0.9, mult: { rs: 0.95, bo: 1.01, muo: 1.2 }, shift: { rs: 15, bo: -0.002, muo: 0.05 }, corr: { rs: 'standing', bo: 'standing', muod: 'beggsRobinson', muo: 'beggsRobinson' } };
      const s = OIL({ match: m }), F = W.build(s, { T_F: 200 }), F0 = W.build(OIL(), { T_F: 200 });
      assert.ok(F.match && F.match.applied && F.pvt.shift && F.pvt.pbFactor === 0.9, 'pvt carries the match');
      const q = { qo: 1000, qw: 0, qg_Mscfd: 600 }, p = 1200, T = 180;
      const a = F.at(p, T, q), rsc = L.Rs_standing(35, 0.75, p * 0.9, T), rsm = 0.95 * rsc + 15;
      assert.near(a.rs, Math.min(600, rsm), 1e-9, 'Rs');
      assert.near(a.bo, 1.01 * L.Bo_standing(35, 0.75, a.rs, T) - 0.002, 1e-12, 'Bo');
      assert.near(a.muo, 1.2 * L.mu_o_beggsRobinson(L.mu_oD_beggsRobinson(35, T), a.rs) + 0.05, 1e-12, 'μo');
      // the bubble point of the well's oil (GOR 600): the correlation's Pb at (GOR − b)/a, divided by f
      const pbExp = L.Pb_standing(35, 0.75, (600 - 15) / 0.95, 200) / 0.9;
      assert.near(F.pb(200), pbExp, 1e-6 * pbExp, 'matched pb');
      assert.near(F.at(pbExp * (1 - 1e-7), 200, q).rs, 600, 0.01, 'Rs reaches the GOR at the matched pb');
      assert.ok(F.at(pbExp * 1.2, 200, q).bo < F.at(pbExp * 1.0001, 200, q).bo, 'undersaturated (compressed) above the matched pb');
      assert.ok(Math.abs(F0.pb(200) - pbExp) > 50, 'differs from the unmatched pb');
      const Fu = W.build(OIL({ match: m, pbUser: 3000 }), { T_F: 200 });
      assert.near(Fu.pb(200), 3000, 1e-6, 'a user bubble point wins, with the matched Rs');
      assert.ok(Fu.match.pbUserWins);
      // predict = the same path
      const lab = P.example(OIL(), 200), pr = P.predict(OIL(), lab, m, [1500]);
      assert.ok(pr.ok && pr.rows.length === 1 && pr.rows[0].rs > 0);
    },
  },
  {
    name: 'PM5 stale match (other correlations) not applied + MATCH_STALE; no match / an unadopted lab / rv & emul none = the A2 path bit for bit',
    wp: WP,
    run(_a, assert, ctx) {
      const W = app0(ctx).win.WTS_wp_fluid;
      const m = { on: true, pbFactor: 0.9, mult: { rs: 0.95, bo: 1.01, muo: 1.2 }, shift: { rs: 15, bo: 0, muo: 0 }, corr: { rs: 'glaso', bo: 'glaso', muod: 'beggsRobinson', muo: 'beggsRobinson' } };
      const F = W.build(OIL({ match: m }), { T_F: 200 });
      assert.ok(F.ok && F.match.stale && !F.match.applied && !F.pvt.shift && !F.pvt.mult && F.pvt.pbFactor == null, 'not applied');
      assert.ok(F.warnings.some((w) => w.code === 'MATCH_STALE'), 'warned');
      const F0 = W.build(OIL({ wc: 0.3 }), { T_F: 200 });
      const F1 = W.build(OIL({ wc: 0.3, match: { lab: { rows: [] } }, rv: { mode: 'none', rows: [] }, emul: { model: 'none', rows: [] }, lab: null }), { T_F: 200 });
      const keys = ['rs', 'bo', 'muo', 'z', 'mug', 'muL', 'rhoL', 'rhoG', 'qL', 'qG', 'sigL'];
      [[500, 120], [1800, 160], [4000, 200]].forEach(([p, t]) => {
        const a = F0.at(p, t, 900), b = F1.at(p, t, 900);
        keys.forEach((k) => assert.ok(Object.is(a[k], b[k]), k + ' at ' + p + ': ' + a[k] + ' vs ' + b[k]));
      });
      assert.deepStrictEqual(J(F0.pvt), J(F1.pvt), 'the same pvt object');
      assert.strictEqual(F1.match, null); assert.strictEqual(F1.rv, null); assert.strictEqual(F1.emul, null);
    },
  },
  {
    name: 'PM6 ranking: families by mean error (Pb, Rs, Bo), viscosity pairs by μo error; the Job twin = fit() + rank(); cancel',
    wp: WP,
    run(_a, assert, ctx) {
      const P = app0(ctx).win.WTS_wp_pvtmatch, spec = OIL(), lab = P.example(spec, 200);
      const rk = P.rank(spec, lab);
      assert.ok(rk.ok && rk.families.length >= 4, 'families: ' + rk.families.length);
      for (let i = 1; i < rk.families.length; i++) assert.ok(rk.families[i].score >= rk.families[i - 1].score, 'sorted');
      const st = rk.families.filter((f) => f.key === 'standing')[0];
      assert.ok(st && st.verified === true && rk.families.some((f) => f.verified === false), 'provisional families marked');
      assert.ok(rk.viscosity.length >= 2 && rk.viscosity.every((v, i) => i === 0 || v.mare >= rk.viscosity[i - 1].mare), 'viscosity pairs sorted');
      const job = P.job(spec, lab); let s, n = 0;
      do { s = job.step(); n++; assert.ok(s.progress >= 0 && s.progress <= 1); } while (!s.done && n < 200);
      const jr = job.result(), f = P.fit(spec, lab);
      assert.ok(jr.ok && jr.evals > 0, 'Job result');
      assert.deepStrictEqual(J(jr.fit.match.mult), J(f.match.mult), 'Job fit = fit()');
      assert.deepStrictEqual(jr.rank.families.map((x) => x.key), rk.families.map((x) => x.key), 'Job ranking = rank()');
      const jc = P.job(spec, lab); jc.step(); jc.cancel();
      assert.strictEqual(jc.result().code, 'CANCELLED');
    },
  },
  {
    name: 'PM7 model: lab record cleaned; adopt → M.fluid.match; new scalars; DEFAULTS keep the A1 / A2 behaviour (D17)',
    wp: WP,
    run(_a, assert, ctx) {
      const Mm = app0(ctx).win.WTS_wp_model;
      const mem = () => { const d = {}; return { getItem: (k) => (k in d ? d[k] : null), setItem: (k, v) => { d[k] = String(v); }, removeItem: (k) => { delete d[k]; } }; };
      const st = mem();
      const w = Mm.write({ lab: { T_F: '200', basis: 'zzz', pb: 2800, rows: [{ p: 1000, rs: 200 }, { p: 'x' }, { p: 500 }], rv: [[1000, 5], ['a', 2]], emul: [[0.2, 2], [2, 3]],
        adopt: { on: true, pbFactor: 0.9, mult: { rs: 0.95 }, shift: { rs: 12 }, corr: { rs: 'standing', bo: 'bad key!' }, labKey: 'k1' } } }, { storage: st });
      assert.ok(w.ok);
      const M = Mm.read({ storage: st, scalars: { wp_rvmode: 'table', wp_pdew: '4200', wp_emul: 'woelflin', wp_emulT: 'tight', wp_emulInv: '55' } });
      const L = M.fluid.lab;
      assert.strictEqual(L.T_F, 200); assert.strictEqual(L.basis, 'flash'); assert.strictEqual(L.rows.length, 1);
      assert.deepStrictEqual(J(L.rv), [[1000, 5]]); assert.deepStrictEqual(J(L.emul), [[0.2, 2]]);
      assert.ok(M.fluid.match.on && M.fluid.match.mult.rs === 0.95 && M.fluid.match.mult.bo === 1 && M.fluid.match.shift.rs === 12, 'adopt → match');
      assert.deepStrictEqual(J(M.fluid.match.corr), { rs: 'standing' }, 'bad keys dropped');
      assert.strictEqual(M.fluid.rv.mode, 'table'); assert.strictEqual(M.fluid.rv.pd, 4200); assert.deepStrictEqual(J(M.fluid.rv.rows), [[1000, 5]]);
      assert.strictEqual(M.fluid.emul.model, 'woelflin'); assert.strictEqual(M.fluid.emul.tight, 'tight'); assert.near(M.fluid.emul.inv, 0.55, 1e-12);
      const D = Mm.DEFAULTS;
      assert.strictEqual(D.fluid.rv.mode, 'none', 'Rv not the default (D17)'); assert.strictEqual(D.fluid.emul.model, 'none', 'emulsion not the default (D17)');
      assert.strictEqual(D.fluid.match, null);
      assert.ok(Mm.write({ lab: { T_F: 200, rows: [], adopt: { on: false } } }, { storage: st }).ok);
      assert.ok(!Mm.read({ storage: st }).fluid.match.on, 'adopt off → no match');
    },
  },
  {
    name: 'PM8 modified black oil: mass conserved, free liquid falls with Rv, all vaporised at / above pd, dew point from the table, table lookup ≈ direct, provisional, ignored for oil',
    wp: WP,
    run(_a, assert, ctx) {
      const G = app0(ctx).win, W = G.WTS_wp_fluid, P = G.WTS_wp_pvtmatch;
      const rows = P.exampleRv(20, 4200);
      const gs = { type: 'condensate', api: 55, sgg: 0.65, cgr: 20, wgr: 2, sgw: 1.07, rv: { mode: 'table', pd: 4200, rows } };
      const Fr = W.build(gs, { T_F: 230 }), Fw = W.build(Object.assign({}, gs, { rv: null }), { T_F: 230 }), Ft = W.build(gs, { T_F: 230, table: true });
      assert.ok(Fr.ok && Fr.rv && Fr.rv.pd === 4200 && Fr.pvt.rv, 'rv on');
      let prevFree = -1;
      [5000, 4300, 4100, 3000, 2000, 1000, 300].forEach((p) => {
        const a = Fr.at(p, 180, 6000), b = Fw.at(p, 180, 6000);
        const mA = a.qL * a.rhoL + a.qG * a.rhoG, mB = b.qL * b.rhoL + b.qG * b.rhoG;
        assert.near(mA, mB, 1e-12 * mB, 'mass at ' + p);
        assert.ok(a.qoFree <= b.qL * 1e9, 'free');
        if (p >= 4200) assert.near(a.qoFree, 0, 1e-12, 'all vaporised at ' + p);
        assert.ok(a.qoFree >= prevFree - 1e-9, 'free liquid grows as p falls'); prevFree = a.qoFree;
        assert.ok(a.sgGas >= Fw.sgg - 1e-12, 'richer gas');
        const c = Ft.at(p, 180, 6000);
        ['rhoG', 'qG', 'qL', 'mug'].forEach((k) => assert.near(c[k], a[k], 2e-3 * Math.abs(a[k]) + 1e-12, 'table ' + k + ' at ' + p));
      });
      assert.near(G.WTS_flowline_rvAt({ rows, pd: 4200 }, 100, 20), rows[0][1], 1e-12, 'constant below the first row');
      const Fp = W.build(Object.assign({}, gs, { rv: { mode: 'table', rows: [[1000, 5], [3000, 15], [5000, 25]] } }), { T_F: 230 });
      assert.near(Fp.rv.pd, 4000, 1e-9, 'dew point where Rv reaches the CGR');
      assert.ok(Fr.validity.some((v) => v.corr === 'rv' && /provisional/.test(v.msg)) && Fr.provisional.indexOf('Modified black oil (Rv)') !== -1, 'provisional');
      const Fo = W.build(OIL({ rv: { mode: 'table', rows } }), { T_F: 200 });
      assert.ok(!Fo.pvt.rv && Fo.warnings.some((w) => w.code === 'RV_NOT_WET'), 'ignored for oil');
      const Fn = W.build(Object.assign({}, gs, { rv: { mode: 'table', rows: [] } }), { T_F: 230 });
      assert.ok(!Fn.pvt.rv && Fn.warnings.some((w) => w.code === 'RV_NO_TABLE'), 'no table: wet gas');
      // the well: less liquid in the tubing → a lower bottom-hole pressure for the same wellhead
      const M = S.FIX.gasWell, R0 = G.WTS_wp_system.solve(M); M.fluid.rv = { mode: 'table', pd: 4200, rows };
      const R1 = G.WTS_wp_system.solve(M);
      assert.ok(R0.ok && R1.ok && R1.op.q > R0.op.q, 'more gas with part of the condensate vaporised: ' + R0.op.q + ' → ' + R1.op.q);
    },
  },
  {
    name: 'PM9 emulsion: Brinkman closed form, water-continuous above the inversion, Woelflin readings pinned, user table; less rate than the mixture; provisional',
    wp: WP,
    run(_a, assert, ctx) {
      const G = app0(ctx).win, E = G.WTS_flowline_emulsion, W = G.WTS_wp_fluid;
      assert.near(E(0.3, 5, 0.5, { model: 'brinkman' }).mu, 5 * Math.pow(0.7, -2.5), 1e-12, 'Brinkman oil-continuous');
      const wc = E(0.8, 5, 0.5, { model: 'brinkman', inv: 0.6 });
      assert.strictEqual(wc.cont, 'water'); assert.near(wc.mu, 0.5 * Math.pow(0.8, -2.5), 1e-12, 'water-continuous');
      assert.strictEqual(E(0.5, 5, 0.5, { model: 'woelflin', inv: 0.4 }).cont, 'water', 'the inversion point switches');
      const WR = E.WOELFLIN;
      assert.deepStrictEqual(J(WR.fw), [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
      assert.deepStrictEqual(J(WR.medium), [1, 1.45, 2.2, 3.5, 5.6, 9.0, 14.5], 'medium readings pinned');
      ['loose', 'medium', 'tight'].forEach((t) => WR.fw.forEach((f, i) => { if (f < 0.6) assert.near(E(f, 4, 0.5, { model: 'woelflin', tight: t }).ratio, WR[t][i], 1e-12, t + ' at ' + f); }));
      assert.near(E(0.15, 4, 0.5, { model: 'woelflin' }).ratio, Math.sqrt(1.45 * 2.2), 1e-12, 'log-linear between readings');
      const tb = { model: 'table', rows: [[0, 1], [0.2, 2], [0.4, 8]] };
      assert.near(E(0.1, 4, 0.5, tb).ratio, Math.SQRT2, 1e-12); assert.strictEqual(E(0.9, 4, 0.5, tb).ratio, 8, 'constant beyond the table');
      assert.strictEqual(E(0.3, 4, 0.5, { model: 'none' }), null);
      const F = W.build(OIL({ wc: 0.3, emul: { model: 'woelflin', tight: 'medium', inv: 0.6 } }), { T_F: 200 }), F0 = W.build(OIL({ wc: 0.3 }), { T_F: 200 });
      const a = F.at(1500, 150, 900), b = F0.at(1500, 150, 900);
      assert.ok(a.muL > b.muL && a.emulRatio > 1 && a.emulCont === 'oil', 'emulsion more viscous than the mixture');
      assert.ok(F.validity.some((v) => v.corr === 'emulsion' && /provisional/.test(v.msg)), 'provisional');
      assert.ok(W.build(OIL({ wc: 0.3, emul: { model: 'table', rows: [[0, 1], [0.5, 3]] } }), { T_F: 200 }).validity.some((v) => v.corr === 'emulsion' && !v.provisional), 'user data not provisional');
      const M = S.FIX.oilWell, R0 = G.WTS_wp_system.solve(M); M.fluid.emul = { model: 'woelflin', tight: 'tight', inv: 0.6 };
      const R1 = G.WTS_wp_system.solve(M);
      assert.ok(R0.ok && R1.ok && R1.op.q < R0.op.q, 'a tight emulsion makes less: ' + R0.op.q + ' → ' + R1.op.q);
      assert.ok((G.WTS_wp_check(M).validity || []).some((v) => v.corr === 'emulsion'), 'validity reaches the page checks');
    },
  },
  {
    name: 'PM10 page: example lab data → Match (Job) → chips, flags, tables, plot; Apply → lab.adopt and every solve uses it; studies, case, CSV; Remove',
    wp: WP, opts: false,
    async run(_a, assert, ctx) {
      const A = app0(ctx), G = A.win;
      S.resetWellPerf(A); A.hook.nav('wellperf'); A.flush(30);
      G.WTS_wellperf_page.resetJobs(); G.WTS_wellperf_page.budget(5000);
      A.click(A.find('[data-act="example"][data-ex="oil"]')); A.flush(30);
      A.click(A.find('#wp_steps [data-step="1"]')); A.flush(5);
      A.click(A.find('[data-act="labex"]')); A.flush(10);
      assert.ok(A.el('wp_tbl_lab').querySelectorAll('tbody tr').length >= 9, 'lab table rendered');
      assert.strictEqual(Number(A.el('wpl_T').value), 200);
      A.click(A.find('[data-act="pvtmatch"]'));
      for (let i = 0; i < 100 && !(G.WTS_wellperf_page.state().pvtm); i++) await A.flushAsync(1);
      const st = G.WTS_wellperf_page.state();
      assert.ok(st.pvtm && st.pvtm.ok, 'match done');
      const res = A.el('wp_pvtmres'), tab = A.el('wp_pvtmtab');
      assert.ok(res.querySelectorAll('.wp-kpi').length >= 4, 'KPI chips');
      assert.match(txt(res), /outside 0\.8–1\.25/, 'μo flag');
      assert.match(txt(tab), /Matched parameters/); assert.match(txt(tab), /Black-oil families/); assert.match(txt(tab), /Viscosity pairs/);
      assert.ok(A.el('wp_cv_pvtm') && A.el('wp_cv_pvtm')._wpAxes, 'plot drawn');
      assert.ok(!BAD.test(txt(res) + txt(tab)), 'no NaN');
      A.click(A.find('[data-act="pvtadopt"]')); A.flush(30);
      const M = G.WTS_wp_model.read();
      assert.ok(M.fluid.lab.adopt && M.fluid.lab.adopt.on && M.fluid.match.on, 'adopt written');
      assert.ok(G.WTS_wellperf_page.state().F.match.applied, 'the solve uses the matched set');
      assert.match(txt(A.el('wp_studies')), /PVT lab match \(applied\)/, 'studies row in #wp_res');
      assert.match(txt(A.el('wp_case')), /matched to the lab table/, 'case summary');
      assert.match(G.WTS_wellperf_page.csv(), /PVT lab match at/, 'CSV section');
      assert.match(txt(res), /Applied to the model/);
      A.click(A.find('[data-act="pvtunadopt"]')); A.flush(30);
      assert.ok(!G.WTS_wp_model.read().fluid.match.on && !G.WTS_wellperf_page.state().F.match, 'removed');
    },
  },
  {
    name: 'PM11 page: the a / b rails preview without writing and keep the adjusted match on release; Apply writes adopt.edited',
    wp: WP, opts: false,
    async run(_a, assert, ctx) {
      const A = app0(ctx), G = A.win, PG = G.WTS_wellperf_page;
      let st = PG.state();
      if (!st.pvtm || !st.pvtm.ok) {
        S.resetWellPerf(A); A.hook.nav('wellperf'); A.flush(30); PG.resetJobs(); PG.budget(5000);
        A.click(A.find('[data-act="example"][data-ex="oil"]')); A.flush(30);
        A.click(A.find('#wp_steps [data-step="1"]')); A.click(A.find('[data-act="labex"]')); A.flush(10);
        A.click(A.find('[data-act="pvtmatch"]')); for (let i = 0; i < 100 && !(PG.state().pvtm); i++) await A.flushAsync(1);
        st = PG.state();
      }
      const a0 = st.pvtm.fit.match.mult.rs, before = A.storage.getItem('wts_wellperf_model');
      PG.pvtmHandle('a', a0 * 1.05, 'move');
      assert.ok(PG.state().pvtmEdit && Math.abs(PG.state().pvtmEdit.match.mult.rs - Math.round(a0 * 1.05 * 1000) / 1000) < 1e-12, 'preview');
      assert.strictEqual(A.storage.getItem('wts_wellperf_model'), before, 'nothing written while dragging');
      assert.ok(PG.state().pvtmEdit.mare.rs > st.pvtm.fit.props.rs.mareAfter, 'the error follows');
      PG.pvtmHandle('a', a0 * 1.05, 'end'); A.flush(5);
      assert.match(txt(A.el('wp_pvtmres')), /Apply the adjusted match/);
      A.click(A.find('[data-act="pvtadopt"]')); A.flush(30);
      const ad = G.WTS_wp_model.read().fluid.lab.adopt;
      assert.ok(ad.on && ad.edited === true && Math.abs(ad.mult.rs - Math.round(a0 * 1.05 * 1000) / 1000) < 1e-12, 'adjusted match adopted');
      assert.match(txt(A.el('wp_studies')), /adjusted by hand/);
    },
  },
  {
    name: 'PM12 page: condensate drop-out card (Rv example, MD · TVD KPI, plots, dew-point handle commits) and the emulsion card (inversion handle commits); Metric; no NaN',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const A = app0(ctx), G = A.win;
      S.resetWellPerf(A); A.hook.nav('wellperf'); A.flush(30); G.WTS_wellperf_page.resetJobs(); G.WTS_wellperf_page.budget(5000);
      A.click(A.find('[data-act="example"][data-ex="gas"]')); A.flush(30);
      A.click(A.find('#wp_steps [data-step="1"]')); A.flush(5);
      A.select('wp_rvmode', 'table'); A.flush(10);
      A.click(A.find('[data-act="rvex"]')); A.flush(30);
      const F = G.WTS_wellperf_page.state().F;
      assert.ok(F.rv && F.rv.rows.length === 7 && F.rv.pd > 0, 'Rv on with the example');
      const k = txt(A.el('wp_rvk'));
      assert.match(k, /Dew point/); assert.match(k, /MD/); assert.match(k, /provisional/);
      assert.ok(A.el('wp_cv_rv')._wpAxes && A.el('wp_cv_rvd')._wpAxes, 'both plots drawn');
      assert.match(txt(A.el('wp_studies')), /Condensate: modified black oil/);
      // dew-point handle: release commits wp_pdew
      const sp = A.el('wp_cv_rv')._wp.spec, h = sp.handles.filter((x) => x.key === 'pd')[0];
      assert.ok(h && h.kind === 'pointX', 'dew-point handle');
      const calcs0 = G.WTS_wellperf_page.calcs();
      sp.onHandle('pd', 3800, 'move'); A.flush(5);
      assert.strictEqual(G.WTS_wellperf_page.calcs(), calcs0, 'preview: no solve while dragging');
      sp.onHandle('pd', 3900, 'end'); A.flush(30);
      assert.strictEqual(G.WTS_wellperf_page.state().F.rv.pd, 3900, 'release commits the dew point');
      // emulsion on the oil example
      A.click(A.find('[data-act="example"][data-ex="oil"]')); A.flush(30);
      A.select('wp_emul', 'brinkman'); A.flush(30);
      assert.ok(G.WTS_wellperf_page.state().F.emul && G.WTS_wellperf_page.state().F.emul.model === 'brinkman');
      const ek = txt(A.el('wp_emulk'));
      assert.match(ek, /Wellhead liquid/); assert.match(ek, /provisional/);
      assert.ok(A.el('wp_cv_emul')._wpAxes, 'emulsion plot drawn');
      const es = A.el('wp_cv_emul')._wp.spec, eh = es.handles.filter((x) => x.key === 'inv')[0];
      assert.ok(eh && eh.kind === 'lineX' && eh.value === 60, 'inversion handle at the default 60 %');
      es.onHandle('inv', 45, 'move'); es.onHandle('inv', 45, 'end'); A.flush(30);
      assert.near(G.WTS_wellperf_page.state().F.emul.inv, 0.45, 1e-12, 'inversion applied');
      assert.match(txt(A.el('wp_studies')), /Liquid viscosity: emulsion/);
      if (G.WTS_units && G.WTS_units.setSystem) {
        G.WTS_units.setSystem('metric'); A.flush(30);
        assert.ok(!BAD.test(txt(A.el('wp_emulk')) + txt(A.el('wp_studies'))), 'no NaN in Metric');
        G.WTS_units.setSystem('imperial'); A.flush(30);
      }
      A.select('wp_emul', 'none'); A.flush(30);
      assert.ok(!G.WTS_wellperf_page.state().F.emul, 'back to the mixture');
    },
  },
  {
    name: 'PM13 review fixes (v4.5): the Rs shift tapers below the lab pb (Rs at 14.7 / 50 psia stays the correlation\'s), the fit recovers the example with it; a plain mult.rs keeps the A2 bubble point',
    wp: WP,
    run(_a, assert, ctx) {
      const G = app0(ctx).win, P = G.WTS_wp_pvtmatch, spec = OIL(), lab = P.example(spec, 200), r = P.fit(spec, lab);
      assert.ok(r.ok && r.match.rsPb === lab.pb, 'the taper pressure is the lab pb');
      assert.ok(r.props.rs.xb && r.props.rs.xb.every((x, i) => Math.abs(x - Math.min(1, r.props.rs.used[i] / lab.pb)) < 1e-12), 'regressor min(1, p / pb)');
      assert.near(r.props.rs.a, 0.93, 2e-3, 'a recovered'); assert.near(r.props.rs.b, 12, 1.5, 'b recovered');
      const W = G.WTS_wp_fluid, base = Object.assign({}, spec, { corr: { rs: 'standing', bo: 'standing', muod: 'beggsRobinson', muo: 'beggsRobinson' } });
      const mk = (m) => { const s2 = JSON.parse(JSON.stringify(base)); if (m) s2.match = Object.assign({ on: true, corr: base.corr }, m); return W.build(s2, { T_F: 200, table: false }); };
      const F0 = mk(null), Fm = mk({ pbFactor: 1, mult: { rs: 1, bo: 1, muo: 1 }, shift: { rs: 11.8, bo: 0, muo: 0 }, rsPb: 2900 });
      const rs = (F, p) => F.table([p], 200).rows[0].rs;
      // the review's case: b = +11.8 scf/STB used to lift Rs at 14.7 psia from 3.4 to 15.0 — with the taper it moves by ≤ 0.1
      [14.7, 50].forEach((p) => assert.ok(Math.abs(rs(Fm, p) - rs(F0, p)) <= 11.8 * p / 2900 + 1e-9, 'Rs at ' + p + ' psia: ' + rs(Fm, p) + ' vs ' + rs(F0, p)));
      assert.near(rs(Fm, 2000) - rs(F0, 2000), 11.8 * 2000 / 2900, 1e-6, 'the shift scales with p / pb below the lab pb');
      // F26: a fluid with only mult.rs (no match, no shift) keeps the A2 bubble point — pb is the correlation's at the GOR
      const fl = W.flowlineFluid(F0, { qo: 1000, qw: 0, qg_Mscfd: 600 }), pv = JSON.parse(JSON.stringify(fl.pvt || {}));
      const props = (mult) => { const f2 = Object.assign({}, fl, { pvt: Object.assign({}, pv, { undersat: true }, mult ? { mult: { rs: mult } } : {}) }); return G.WTS_flowline_props(f2, 30000, 200); };
      const p1 = props(null), p12 = props(1.2), p08 = props(0.8);
      assert.ok(Number.isFinite(p1.pb) && p12.pb === p1.pb && p08.pb === p1.pb, 'mult.rs alone: pb unchanged (' + p1.pb + ' / ' + p12.pb + ' / ' + p08.pb + ')');
    },
  },
];
