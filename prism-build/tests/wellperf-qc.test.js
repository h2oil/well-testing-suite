// Well Performance production-test QC — docs/WELL-PERFORMANCE-PLAN.md §3.7, §5.4, §17.1 (WP7, WTS_wp_qc).
//
// One test per QC code (8): QC_BHP_GT_PR, QC_Q_GT_AOF, QC_GOR_LT_RSB ("not applicable" without a user bubble point), QC_CHOKE
// (choke-model rate at the measured THP within / beyond 20 %, sub-critical with a critical correlation), QC_THT, QC_VLP (best
// correlation within / beyond 5 % at the gauge), QC_WC (negative rate, jump by date), QC_SEP (Separator QC total / separator basis)
// — each with its check row, its flag, the score (100 − 30 per fail − 10 per warn) and the rank.
'use strict';

const S = require('./_wellperf-shapes');

const WP = 'WP7';
const PATM = 14.696;
const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const app = (ctx) => S.sharedApp(ctx);
const chk = (row, code) => row.checks.filter((c) => c.code === code)[0];
const flag = (row, code) => row.flags.filter((f) => f.code === code)[0];
// a test whose gauge is exactly the Beggs & Brill answer at its THP (QC_VLP ok) — built through the comparison itself
function consistent(G, M, t) { const c = G.WTS_wp_match.compare(M, t, ['bb']); return Object.assign({}, t, { gauge_psia: c.rows[0].pCalc }); }

module.exports = [
  {
    name: 'WQC1 QC_BHP_GT_PR: a gauge at or above p̄r fails (score −30, ranked last); the fixture test passes with its drawdown; no p̄r → not applicable',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, M = S.FIX.oilWell, t = S.FIX.test1;
      const bad = Object.assign({}, t, { id: 'TB', gauge_psia: 3050 });
      const q = G.WTS_wp_qc(M, [t, bad], { sepqc: null });
      assert.ok(q.ok && q.rows.length === 2 && plain(q.codes).length === 8);
      const r0 = q.rows[0], r1 = q.rows[1];
      assert.strictEqual(chk(r0, 'QC_BHP_GT_PR').st, 'ok'); assert.includes(chk(r0, 'QC_BHP_GT_PR').msg, 'drawdown');
      assert.strictEqual(chk(r1, 'QC_BHP_GT_PR').st, 'fail'); assert.strictEqual(flag(r1, 'QC_BHP_GT_PR').sev, 'fail');
      assert.ok(r1.checks.length === 8 && r1.checks.every((c) => ['ok', 'warn', 'fail', 'na'].includes(c.st)), 'a check per code');
      const pen = (r) => r.checks.reduce((s, c) => s + (c.st === 'fail' ? 30 : c.st === 'warn' ? 10 : 0), 0);
      q.rows.forEach((r) => assert.strictEqual(r.score, Math.max(0, 100 - pen(r)), r.id + ' score'));
      assert.ok(r1.score < r0.score && r0.rank === 1 && r1.rank === 2, 'ranked by score');
      const Mn = S.FIX.oilWell; Mn.res.pr = null;
      assert.strictEqual(chk(G.WTS_wp_qc(Mn, [t]).rows[0], 'QC_BHP_GT_PR').st, 'na', 'p̄r is never defaulted');
    },
  },
  {
    name: 'WQC2 QC_Q_GT_AOF: a rate above the model AOF fails; the fixture rate is a share of the AOF',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, M = S.FIX.oilWell, t = S.FIX.test1;
      const q = G.WTS_wp_qc(M, [t, Object.assign({}, t, { id: 'TQ', q_o: 4900, q_w: 2100, q_g: 2450 })]);
      assert.strictEqual(chk(q.rows[0], 'QC_Q_GT_AOF').st, 'ok'); assert.includes(chk(q.rows[0], 'QC_Q_GT_AOF').msg, '17 %');
      const c = chk(q.rows[1], 'QC_Q_GT_AOF');
      assert.strictEqual(c.st, 'fail'); assert.includes(c.msg, '7,000'); assert.includes(c.msg, '6,000');
    },
  },
  {
    name: 'WQC3 QC_GOR_LT_RSB: "not applicable" without a user bubble point; with pbUser above p̄r (saturated) a GOR below Standing Rsb warns; undersaturated passes; gas wells n/a',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, t = S.FIX.test1, L = G.PRiSM_pvt_correlations;
      const c0 = chk(G.WTS_wp_qc(S.FIX.oilWell, [t]).rows[0], 'QC_GOR_LT_RSB');
      assert.strictEqual(c0.st, 'na'); assert.includes(c0.msg, 'Not applicable'); assert.includes(c0.msg, 'by construction');
      const Ms = S.FIX.oilWell; Ms.fluid.pbUser = 3500;
      const rsb = L.Rs_standing(35, 0.65, 3500, 200);
      assert.ok(rsb > 500 / 0.95, 'Rsb at 3,500 psia above the producing GOR: ' + rsb);
      const c1 = chk(G.WTS_wp_qc(Ms, [t]).rows[0], 'QC_GOR_LT_RSB');
      assert.strictEqual(c1.st, 'warn', c1.msg); assert.includes(c1.msg, String(Math.round(rsb)).replace(/\B(?=(\d{3})+$)/g, ','));
      const Mu = S.FIX.oilWell; Mu.fluid.pbUser = 1500;
      const c2 = chk(G.WTS_wp_qc(Mu, [t]).rows[0], 'QC_GOR_LT_RSB');
      assert.strictEqual(c2.st, 'ok'); assert.includes(c2.msg, 'undersaturated');
      const gt = { id: 'G1', q_g: 6000, thp_psig: 2300, tht_F: 140, bean64: 24, gaugeMd: 9800, gauge_psia: 3900 };
      assert.strictEqual(chk(G.WTS_wp_qc(S.FIX.gasWell, [gt]).rows[0], 'QC_GOR_LT_RSB').st, 'na');
    },
  },
  {
    name: 'WQC4 QC_CHOKE: the test at the THP its choke + flowline need passes (≈ 0 %), double the THP warns beyond 20 %, a high separator pressure (sub-critical) warns that the critical correlation does not apply; no choke → n/a',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, M = S.FIX.oilWell, t = S.FIX.test1, SY = G.WTS_wp_system;
      const b = SY.boundary(Object.assign(S.FIX.oilWell, {}), 1000, {});
      assert.ok(b.ok && b.regime === 'critical', JSON.stringify(plain(b)));
      const tOk = Object.assign({}, t, { thp_psig: b.thp_psig });
      const c = chk(G.WTS_wp_qc(M, [tOk]).rows[0], 'QC_CHOKE');
      assert.strictEqual(c.st, 'ok', c.msg); assert.match(c.msg, /within [01] %/);
      const cHi = chk(G.WTS_wp_qc(M, [Object.assign({}, tOk, { thp_psig: 2 * b.thp_psig })]).rows[0], 'QC_CHOKE');
      assert.strictEqual(cHi.st, 'warn', cHi.msg); assert.match(cHi.msg, /\+\d+ %/);
      const Mh = S.FIX.oilWell; Mh.surface.psep_psig = 600;
      const cSub = chk(G.WTS_wp_qc(Mh, [t]).rows[0], 'QC_CHOKE');
      assert.strictEqual(cSub.st, 'warn'); assert.includes(cSub.msg, 'sub-critical');
      const Mn = S.FIX.oilWell; Mn.surface.choke.present = false;
      assert.strictEqual(chk(G.WTS_wp_qc(Mn, [t]).rows[0], 'QC_CHOKE').st, 'na');
    },
  },
  {
    name: 'WQC5 QC_THT: a THT above the bottom-hole temperature warns; the fixture THT passes; no THT → n/a',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, M = S.FIX.oilWell, t = S.FIX.test1;
      const q = G.WTS_wp_qc(M, [t, Object.assign({}, t, { id: 'TH', tht_F: 250 }), Object.assign({}, t, { id: 'TN', tht_F: null })]);
      assert.strictEqual(chk(q.rows[0], 'QC_THT').st, 'ok');
      const c = chk(q.rows[1], 'QC_THT'); assert.strictEqual(c.st, 'warn'); assert.includes(c.msg, '250 °F'); assert.includes(c.msg, '200 °F');
      assert.strictEqual(chk(q.rows[2], 'QC_THT').st, 'na');
    },
  },
  {
    name: 'WQC6 QC_VLP: a gauge on the Beggs & Brill answer passes (0 %), a gauge 15 % off warns with the best correlation named; no gauge → n/a; the comparison is carried in the row',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, M = S.FIX.oilWell;
      const tc = consistent(G, M, S.FIX.test1);
      const q = G.WTS_wp_qc(M, [tc, Object.assign({}, tc, { id: 'TV', gauge_psia: tc.gauge_psia * 1.15 }), Object.assign({}, tc, { id: 'TG', gauge_psia: null })], { corrKeys: ['bb', 'hb'] });
      const c0 = chk(q.rows[0], 'QC_VLP');
      assert.strictEqual(c0.st, 'ok', c0.msg); assert.includes(c0.msg, 'Beggs & Brill');
      assert.strictEqual(q.rows[0].compare.best, 'bb'); assert.near(q.rows[0].compare.rows[0].err, 0, 1e-6);
      const c1 = chk(q.rows[1], 'QC_VLP');
      assert.strictEqual(c1.st, 'warn'); assert.match(c1.msg, /misses the gauge/);
      assert.strictEqual(chk(q.rows[2], 'QC_VLP').st, 'na');
      assert.strictEqual(q.rows[2].pwfMethod, 'thp', 'no gauge: pwf from the THP');
    },
  },
  {
    name: 'WQC7 QC_WC: a negative rate fails; a water-cut jump of more than 20 points from the previous test BY DATE warns (input order does not matter); the earlier test passes',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, M = S.FIX.oilWell, t = S.FIX.test1;
      const t2 = Object.assign({}, t, { id: 'T2', date: '2026-11-05', q_o: 400, q_w: 600, q_g: 200 });
      const q = G.WTS_wp_qc(M, [t2, t]);
      const c2 = chk(q.rows[0], 'QC_WC');
      assert.strictEqual(c2.st, 'warn', c2.msg); assert.includes(c2.msg, 'jumped 30 points'); assert.includes(c2.msg, 'T1');
      assert.strictEqual(chk(q.rows[1], 'QC_WC').st, 'ok');
      const cn = chk(G.WTS_wp_qc(M, [Object.assign({}, t, { q_w: -5 })]).rows[0], 'QC_WC');
      assert.strictEqual(cn.st, 'fail'); assert.includes(cn.msg, 'negative');
      // a missing water rate comes from the model water cut and is said so
      const cd = chk(G.WTS_wp_qc(M, [Object.assign({}, t, { q_w: null })]).rows[0], 'QC_WC');
      assert.strictEqual(cd.st, 'ok'); assert.includes(cd.msg, 'from the model');
    },
  },
  {
    name: 'WQC8 QC_SEP: n/a without a Separator QC result; a GOR on its total basis passes; a GOR equal to its separator-basis GOR or 20 % off warns; WTS_state.sepqc is read by default',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, M = S.FIX.oilWell, t = S.FIX.test1;     // producing GOR 350 Mscf/d / 700 STB/d = 500 scf/STB
      const sq = { ok: true, gorTotal: 500, gorSepCorr: 420, gorSTCorr: 80 };
      assert.strictEqual(chk(G.WTS_wp_qc(M, [t], { sepqc: null }).rows[0], 'QC_SEP').st, 'na');
      assert.strictEqual(chk(G.WTS_wp_qc(M, [t], { sepqc: sq }).rows[0], 'QC_SEP').st, 'ok');
      const cs = chk(G.WTS_wp_qc(M, [Object.assign({}, t, { q_g: 294 })], { sepqc: sq }).rows[0], 'QC_SEP');
      assert.strictEqual(cs.st, 'warn'); assert.includes(cs.msg, 'separator-basis');
      const cd = chk(G.WTS_wp_qc(M, [Object.assign({}, t, { q_g: 266 })], { sepqc: sq }).rows[0], 'QC_SEP');
      assert.strictEqual(cd.st, 'warn'); assert.match(cd.msg, /differs by −24 %/);
      G.WTS_state = G.WTS_state || {};
      const keep = G.WTS_state.sepqc;
      G.WTS_state.sepqc = app(ctx).toWin ? app(ctx).toWin(sq) : sq;
      try { assert.strictEqual(chk(G.WTS_wp_qc(M, [t]).rows[0], 'QC_SEP').st, 'ok', 'reads WTS_state.sepqc'); }
      finally { if (keep === undefined) delete G.WTS_state.sepqc; else G.WTS_state.sepqc = keep; }
      const gt = { id: 'G1', q_g: 6000, thp_psig: 2300, tht_F: 140, bean64: 24, gaugeMd: 9800, gauge_psia: 3900 };
      const qg = G.WTS_wp_qc(S.FIX.gasWell, [gt], { sepqc: sq });
      assert.strictEqual(chk(qg.rows[0], 'QC_SEP').st, 'na'); assert.ok(qg.warnings.some((w) => w.code === 'QC_GAS'));
      assert.strictEqual(G.WTS_wp_qc(M, []).code, 'NO_TEST');
    },
  },
];
