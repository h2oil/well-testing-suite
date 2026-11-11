// Well Performance system solver — docs/WELL-PERFORMANCE-PLAN.md §3.5, §4.7–§4.10, §4.13, §4.14, §15.2, §15.3, §16, §17.1 (WP5).
//
// WSY1 roots: every sign change found, |Δ| < 0.1 psi or Δq < 1e-4·q, SHAPE.R, the operating point = the highest stable root
// WSY2 stability label vs shading: stable ⇔ dΔ/dq > 0, no stable root left of q_s, the operating point right of q_s
// WSY3 falling branch (FIX.fallingBranch, Hagedorn & Brown): stable root left of the tubing-curve minimum, right of q_s, in the
//      conventional-rule note, outside the shading
// WSY4 q_s left of the tubing-curve minimum on every fixture that has both
// WSY5 heading flag on q_s (within 10 % above), none on FIX.oilWell
// WSY6 nodes agree: wellhead node vs bottom-hole node within 0.5 % in q
// WSY7 choke continuity across the critical ratio: multiphase max-rule bound and the gas nozzle, |jump| < 0.1 psi
// WSY8 discontinuity detection: a synthetic jump correlation and the Hagedorn & Brown pattern step are reported, never roots
// WSY9 p_out(q) smooth on the frozen grid: second differences < 0.01 psi
// WSY10 warm start = cold start; a tracking solve finds the same root
// WSY11 design bean for a target rate
// WSY12 design THP for a target rate
// WSY13 maximum rate: no choke, THP = separator + flowline Δp, above the choked rate
// WSY14 breakdown sums to p̄r − p_sep exactly (oil and wet gas)
// WSY15 shut-in, gas-filled column vs WTS_gradient_compute and an independent RK4 integration (0.2 %)
// WSY16 shut-in, liquid columns vs 0.433·SG·TVD (0.01 %) and the partly liquid-filled list
// WSY17 bean schedule: monotone in bean on FIX.oilWell, warm tracking solves, evaluation budget
// WSY18 maximum THT and SITHP verdicts against the equipment ratings (✓ / ⚠ / ✗ / none)
// WSY19 WTS_wp_check: survey, strings, p̄r never defaulted, saturated reservoir, GOR ≥ Rsb only with a user bubble point, validity
// WSY20 the page on the real engines: KPIs, operating point, checks, hydrate and loading verdicts, no NaN, stubs gone; a live drag
//       runs the warm tracking solve
// WSY21 the provisional-label gate of wellperf-validate.js (D17, §15.1): no unverified method is a default or loses its label
'use strict';

const S = require('./_wellperf-shapes');

const WP = 'WP5';
const PATM = 14.696;
const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const app = (ctx) => S.sharedApp(ctx);
// one solve per distinct model in this file (the engine is pure; the app is shared)
const _memo = new Map();
const sol = (SY, M) => { const k = JSON.stringify(M); if (!_memo.has(k)) _memo.set(k, SY.solve(M)); return _memo.get(k); };
const run = (job) => { let s, n = 0; do { s = job.step(); n++; } while (!s.done && n < 200); return job.result(); };
// FIX.fallingBranch (frozen, J 0.3) does not flow with any A1 correlation; WP5 confirms the falling branch at J = 1 with the D5 oil
// correlation Hagedorn & Brown (lead: update the fixture's J)
const fbHB = () => { const M = S.FIX.fallingBranch; M.system.corr.well = 'hb'; M.res.params.J = 1; return M; };
const headingM = () => { const M = S.FIX.fallingBranch; M.res.params.J = 2; M.res.pr = 3100; return M; };   // Beggs & Brill default

module.exports = [
  {
    name: 'WSY1 roots: both crossings of FIX.oilWell found and converged, SHAPE.R, the operating point is the highest stable root; the stubs are gone',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, SY = G.WTS_wp_system;
      S.STUBS.WP5.forEach((n) => assert.ok((G.__WP_STUBS || []).indexOf(n) === -1, n + ' left __WP_STUBS'));
      const M = S.FIX.oilWell, R = sol(SY, M);
      const sh = S.checkShape('R', plain(R));
      assert.ok(sh.ok, sh.errors.join('; '));
      assert.ok(R.ok, JSON.stringify(R.errors));
      assert.strictEqual(R.roots.length, 2, 'two crossings: ' + JSON.stringify(plain(R.roots)));
      R.roots.forEach((r) => {
        const e = SY.evalAt(M, r.q, { grid: R.grid });
        assert.ok(Math.abs(e.delta) < 0.1 || r.conv === 'x', 'converged at ' + r.q + ': Δ = ' + e.delta);
        assert.near(r.p, e.pIn, 1e-9, 'root pressure = IPR pwf');
        assert.ok(r.evals <= 20, 'root evaluations ≤ 20: ' + r.evals);
      });
      const st = R.roots.filter((r) => r.stable);
      assert.strictEqual(R.op.q, st[st.length - 1].q, 'highest stable root');
      assert.ok(!R.roots[0].stable && R.roots[1].stable, 'low root unstable, high root stable');
      assert.within(R.op.q, 850, 980, 'oil operating rate (Beggs & Brill default)');
      assert.ok(R.evals <= 24, 'two roots + q_s within the §16 budget (≤ 20 E + 4 E): ' + R.evals + ' ' + JSON.stringify(R.counts));
      assert.strictEqual(R.corr.well, 'bb', 'the provisional correlations are not defaults (D17)');
      // the traverse is the wellhead → mid-perforation march at the operating point, MD and TVD on every row
      assert.near(R.traverse.profile[0].md, 0, 1e-6); assert.near(R.traverse.pBottom, R.pwf, 0.11, 'traverse ends at pwf');
      assert.ok(R.traverse.profile.every((p) => isFinite(p.md) && isFinite(p.tvd) && isFinite(p.inc)), 'MD / TVD / inclination');
      // the 'pressure' mode reports the node pressures at a target rate
      const Mp = S.FIX.oilWell; Mp.system.mode = 'pressure'; Mp.system.target = { kind: 'bean', q: 600 };
      const Rp = sol(SY, Mp);
      assert.ok(Rp.atTarget && Rp.atTarget.q === 600 && Rp.atTarget.flows === true && Rp.atTarget.pwfVlp < Rp.atTarget.pwfIpr, 'pressure mode at 600 STB/d: ' + JSON.stringify(plain(Rp.atTarget)));
    },
  },
  {
    name: 'WSY2 stability label always agrees with the shading: stable ⇔ dΔ/dq > 0, no stable root below q_s, the operating point above q_s',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const SY = app(ctx).win.WTS_wp_system;
      [S.FIX.oilWell, S.FIX.gasWell, fbHB(), headingM()].forEach((M, i) => {
        const R = sol(SY, M);
        assert.ok(R.ok, 'case ' + i + ': ' + JSON.stringify(R.errors));
        R.roots.forEach((r) => {
          assert.strictEqual(r.stable, r.dDdq > 0, 'case ' + i + ' root ' + r.q.toFixed(1) + ' label vs slope');
          if (R.qs && r.q < R.qs.q) assert.ok(!r.stable, 'case ' + i + ': a root in the shaded range (q < q_s) is unstable');
        });
        if (R.qs) assert.ok(R.op.q > R.qs.q, 'case ' + i + ': operating point right of q_s');
        // the curve the page shades: dΔ/dq on the frozen fine grid is negative just left of q_s and positive at the operating point
        if (R.qs) {
          const h = 0.02 * R.qs.q, a = SY.evalAt(M, R.qs.q * 0.8 - h, { grid: R.grid }).delta, b = SY.evalAt(M, R.qs.q * 0.8 + h, { grid: R.grid }).delta;
          assert.ok(b - a < 0.5, 'case ' + i + ': Δ falls (or is flat) inside the shaded range');
        }
      });
    },
  },
  {
    name: 'WSY3 FIX.fallingBranch (Hagedorn & Brown): the stable root sits on the falling VLP branch — left of the tubing-curve minimum, right of q_s, inside the conventional-rule note, outside the shading',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const SY = app(ctx).win.WTS_wp_system, M = fbHB(), R = sol(SY, M);
      assert.ok(R.ok, JSON.stringify(R.errors));
      assert.deepStrictEqual(plain(S.FIX.fallingBranch.expect), { opLeftOfVlpMin: true, opRightOfQs: true, stable: true, confirmedBy: 'WP5' });
      assert.ok(R.op.stable, 'stable');
      assert.ok(R.vlpMin && R.op.q < R.vlpMin.q, 'left of the tubing-curve minimum: ' + R.op.q + ' < ' + (R.vlpMin && R.vlpMin.q));
      assert.ok(R.qs && R.op.q > R.qs.q, 'right of q_s: ' + R.op.q + ' > ' + (R.qs && R.qs.q));
      assert.ok(R.flags.some((f) => f.code === 'LEFT_OF_MIN' && f.sev === 'info'), 'conventional-rule note');
      assert.ok(!R.flags.some((f) => f.code === 'HEADING'), 'no heading flag (more than 10 % above q_s)');
      // the VLP really falls at the operating point (dp_out/dq < 0) while dΔ/dq > 0
      const e1 = SY.evalAt(M, R.op.q * 0.97, { grid: R.grid }), e2 = SY.evalAt(M, R.op.q * 1.03, { grid: R.grid });
      assert.ok(e2.pOut < e1.pOut, 'falling outflow branch');
      assert.ok(R.op.dDdq > 0, 'statically stable');
      // with the Beggs & Brill default the frozen fixture does not flow (documented: the fixture assumed the D5 default)
      const Rb = sol(SY, S.FIX.fallingBranch);
      assert.strictEqual(Rb.code, 'NO_FLOW', 'Beggs & Brill: ' + Rb.code);
    },
  },
  {
    name: 'WSY4 q_s lies left of the tubing-curve minimum (dp_out/dq = −1/J < 0 at q_s)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const SY = app(ctx).win.WTS_wp_system;
      let n = 0;
      [S.FIX.oilWell, S.FIX.gasWell, fbHB(), headingM()].forEach((M, i) => {
        const R = sol(SY, M);
        if (!(R.qs && R.vlpMin)) return;
        n++;
        assert.ok(R.qs.q < R.vlpMin.q, 'case ' + i + ': q_s ' + R.qs.q.toFixed(1) + ' < tubing-curve minimum ' + R.vlpMin.q.toFixed(1));
        assert.ok(R.vlpMin.p > 0 && R.qs.p > 0, 'pressures');
      });
      assert.ok(n >= 3, 'checked on ' + n + ' fixtures');
    },
  },
  {
    name: 'WSY5 heading flag on q_s: ⚠ when the operating point is within 10 % above q_s; FIX.oilWell has none; a near-tangent case is "marginal"',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const SY = app(ctx).win.WTS_wp_system;
      const R = sol(SY, headingM());
      assert.ok(R.ok && R.qs, JSON.stringify(R.errors));
      assert.ok(R.op.q <= R.qs.q * 1.1, 'within 10 %: ' + (R.op.q / R.qs.q).toFixed(3));
      const f = R.flags.find((x) => x.code === 'HEADING');
      assert.ok(f && f.sev === 'warn', 'HEADING flag');
      assert.strictEqual(R.roots.length, 2, 'unstable + stable root');
      const R0 = sol(SY, S.FIX.oilWell);
      assert.ok(R0.op.q > R0.qs.q * 1.1 && !R0.flags.some((x) => x.code === 'HEADING'), 'no flag on FIX.oilWell');
      const Mm = headingM(); Mm.res.pr = 3080;
      const Rm = sol(SY, Mm);
      assert.ok(!Rm.ok && Rm.code === 'NO_FLOW' && Rm.marginal.length === 1 && Rm.flags.some((x) => x.code === 'MARGINAL'), 'tangency → marginal: ' + JSON.stringify(plain(Rm.marginal)));
    },
  },
  {
    name: 'WSY6 node independence: the wellhead node gives the bottom-hole node rate within 0.5 % (oil and wet gas); the separator node says so',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const SY = app(ctx).win.WTS_wp_system;
      ['oilWell', 'gasWell'].forEach((k) => {
        const Rb = sol(SY, S.FIX[k]), Mw = S.FIX[k]; Mw.system.node = 'wellhead';
        const Rw = sol(SY, Mw);
        assert.ok(Rw.ok && Rw.node === 'wellhead', k + ' wellhead node');
        assert.rel(Rw.op.q, Rb.op.q, 0.005, k + ' node independence');
        assert.ok(Rw.curves.ipr.length && Rw.curves.vlp.length, k + ' node curves: THP available / required');
      });
      const Ms = S.FIX.oilWell; Ms.system.node = 'separator';
      const Rs = sol(SY, Ms);
      assert.ok(Rs.ok && Rs.flags.some((f) => f.code === 'NODE_SEPARATOR'), 'separator node note');
    },
  },
  {
    name: 'WSY7 choke continuity: p1(q) = max(p1_crit, p2/y_c) has no jump at the regime change (multiphase), nor the gas nozzle at its critical ratio (|jump| < 0.1 psi)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const SY = app(ctx).win.WTS_wp_system;
      const find = (M, a, b) => {
        let ra = SY.boundary(M, a).regime;
        for (let k = 0; k < 60; k++) { const m = 0.5 * (a + b), r = SY.boundary(M, m).regime; if (r === ra) a = m; else b = m; if (b - a < 1e-7 * b) break; }
        return 0.5 * (a + b);
      };
      const M = S.FIX.oilWell;
      assert.strictEqual(SY.boundary(M, 100).regime, 'subcritical-bound');
      assert.strictEqual(SY.boundary(M, 900).regime, 'critical');
      const qc = find(M, 100, 900), e = 1e-4 * qc;
      const lo = SY.boundary(M, qc - e), hi = SY.boundary(M, qc + e);
      assert.ok(lo.regime !== hi.regime, 'straddles the switch');
      assert.ok(Math.abs(hi.thp - lo.thp) < 0.1, 'multiphase |jump| = ' + Math.abs(hi.thp - lo.thp));
      assert.near(lo.thp / lo.p2, 1 / 0.588, 1e-3, 'the bound is p2 / y_c (y_c = 0.588)');
      // the operating-point traverse inherits it: Δ(q) through the switch is continuous
      // (on the smooth no-slip tubing correlation: Beggs & Brill pattern switches in an oil well step by up to ~1 psi, WSY9)
      const Mn = S.FIX.oilWell; Mn.system.corr.well = 'nsl';
      const g0 = SY.evalAt(Mn, qc).grid, e6 = 1e-6 * qc, d1 = SY.evalAt(Mn, qc - e6, { grid: g0 }).delta, d2 = SY.evalAt(Mn, qc + e6, { grid: g0 }).delta;
      assert.ok(Math.abs(d2 - d1) < 0.1, 'Δ continuous: ' + Math.abs(d2 - d1));
      const Gm = S.FIX.gasWell;
      assert.strictEqual(SY.boundary(Gm, 200).regime, 'subcritical');
      assert.strictEqual(SY.boundary(Gm, 7000).regime, 'critical');
      const qg = find(Gm, 200, 7000), eg = 1e-5 * qg, l2 = SY.boundary(Gm, qg - eg), h2 = SY.boundary(Gm, qg + eg);
      assert.ok(Math.abs(h2.thp - l2.thp) < 0.1, 'gas nozzle |jump| = ' + Math.abs(h2.thp - l2.thp));
      // the nozzle passes exactly q at the solved p1
      const z = app(ctx).win.WTS_wp_fluid.build(Gm.fluid, { T_F: Gm.res.T_F });
      assert.ok(z.ok);
    },
  },
  {
    name: 'WSY8 discontinuity detection: a sign change whose |Δ| stays above the tolerance at both collapsed bracket ends is a discontinuity (q, jump), never a root',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, SY = G.WTS_wp_system, REG = G.WTS_flowline_corr;
      // synthetic: Beggs & Brill + 0.5 psi/ft of extra gradient once the in-situ liquid velocity passes 2.2 ft/s
      REG.__wsyJump = { key: '__wsyJump', label: 'jump test', kind: 'any', verified: true, range: {},
        grad: function (inp) { const g = REG.bb.grad(inp); if (inp.vsl > 2.2) { g.gradEl += 0.5; g.grad += 0.5; } return g; } };
      try {
        const M = S.FIX.oilWell; M.surface.choke.present = false; M.surface.flowline = []; M.system.thp_psig = 200; M.res.params.J = 3; M.system.corr.well = '__wsyJump';
        const R = sol(SY, M);
        assert.ok(R.discontinuities.length >= 1, 'discontinuity reported: ' + JSON.stringify(plain(R.discontinuities)));
        const d = R.discontinuities[0];
        assert.ok(d.jump > 0.5 && d.q > 0, 'q and jump');
        assert.ok(!R.roots.some((r) => Math.abs(r.q - d.q) < 1e-3 * d.q), 'not a root');
        const a = SY.evalAt(M, d.q * (1 - 2e-4), { grid: R.grid }).delta, b = SY.evalAt(M, d.q * (1 + 2e-4), { grid: R.grid }).delta;
        assert.ok(Math.abs(a) > 0.1 && Math.abs(b) > 0.1 && (a > 0) !== (b > 0), 'jumps over zero: ' + a + ' → ' + b);
        assert.ok(R.flags.some((f) => f.code === 'DISCONTINUITY'), 'flag');
      } finally { delete REG.__wsyJump; }
      // a real correlation step: Hagedorn & Brown on the falling-branch well (pattern switch of a march step at the low crossing)
      const R2 = sol(SY, fbHB());
      assert.ok(R2.discontinuities.length >= 1 && R2.discontinuities.every((x) => x.kind === 'jump' && x.jump > 0.5), 'Hagedorn & Brown step: ' + JSON.stringify(plain(R2.discontinuities)));
      assert.ok(R2.discontinuities[0].side === 'unstable', 'on the unstable (Δ falling) side');
    },
  },
  {
    name: 'WSY9 the tubing outflow p_out(q) is smooth on the frozen grid: second differences < 0.01 psi (gas Beggs & Brill and Gray, oil no-slip; fixed THP)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const SY = app(ctx).win.WTS_wp_system;
      [['gasWell', null, 7000, 20], ['gasWell', 'gray', 7000, 20], ['oilWell', 'nsl', 900, 5]].forEach(([k, corr, q0, dq]) => {
        const M = S.FIX[k]; if (corr) M.system.corr.well = corr;
        M.surface.choke.present = false; M.surface.flowline = []; M.system.thp_psig = 400;   // the tubing alone (the pattern switches of the
        // flowline correlation, and of Beggs & Brill / Hagedorn & Brown in oil wells, add ±0.2–1 psi steps: the discontinuity rule, WSY8)
        const g = SY.evalAt(M, q0).grid, p = [];
        for (let i = 0; i < 10; i++) p.push(SY.evalAt(M, q0 + i * dq, { grid: g }).pOut);
        let m = 0; for (let i = 1; i < p.length - 1; i++) m = Math.max(m, Math.abs(p[i + 1] - 2 * p[i] + p[i - 1]));
        assert.ok(m < 0.01, k + ' ' + (corr || 'bb') + ': max |Δ²p_out| = ' + m.toExponential(2));
      });
    },
  },
  {
    name: 'WSY10 warm start = cold start (identical root on the same frozen grid); a tracking solve from a neighbouring setting finds the full-solve root',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const SY = app(ctx).win.WTS_wp_system;
      ['oilWell', 'gasWell'].forEach((k) => {
        const R1 = sol(SY, S.FIX[k]), R2 = SY.solve(S.FIX[k], { warm: R1.grid });
        assert.strictEqual(R2.op.q, R1.op.q, k + ' warm = cold');
        assert.strictEqual(R2.qs && R2.qs.q, R1.qs && R1.qs.q, k + ' q_s');
        const M2 = S.FIX[k]; M2.surface.choke.bean64 += 4;
        const Rf = sol(SY, M2), Rt = SY.solve(M2, { warm: R1.grid, track: { q: R1.op.q, slope: R1.op.dDdq } });
        assert.ok(Rt.tracked && Rt.ok, k + ' tracked');
        assert.rel(Rt.op.q, Rf.op.q, 2e-4, k + ' tracking = full');
        assert.ok(Rt.evals <= 8, k + ' tracking cost ' + Rt.evals + ' E');
      });
    },
  },
  {
    name: 'WSY11 design bean: the Job finds the bean that gives a target rate; solving at that bean gives the target within 1 %',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const SY = app(ctx).win.WTS_wp_system, M = S.FIX.oilWell, R0 = sol(SY, M), qT = Math.round(R0.op.q * 1.2);
      const job = SY.designFor(M, { bean: qT });
      ['step', 'done', 'result'].forEach((f) => assert.fn(job[f]));
      const r = run(job);
      assert.ok(r.ok, JSON.stringify(r.errors));
      assert.within(r.bean, 32, 48, 'bean');
      const M2 = S.FIX.oilWell; M2.surface.choke.bean64 = r.bean;
      assert.rel(sol(SY, M2).op.q, qT, 0.01, 'rate at the design bean');
      assert.ok(r.solves <= 8 && r.evals <= 60, '§16: ≤ 8 solves, ≤ 60 E: ' + r.solves + ' / ' + r.evals);
      const bad = run(SY.designFor(M, { bean: R0.aof * 2 }));
      assert.ok(!bad.ok, 'unreachable target → not ok');
    },
  },
  {
    name: 'WSY12 design THP: the fixed wellhead pressure that gives a target rate (no choke)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const SY = app(ctx).win.WTS_wp_system, M = S.FIX.oilWell;
      M.surface.choke.present = false; M.system.thp_psig = 300;
      const R0 = sol(SY, M), qT = Math.round(R0.op.q * 0.8);
      const r = run(SY.designFor(M, { thp: qT }));
      assert.ok(r.ok && r.thp > 300, 'higher THP for a lower rate: ' + JSON.stringify({ thp: r.thp, q: r.q, e: r.errors }));
      const M2 = S.FIX.oilWell; M2.surface.choke.present = false; M2.system.thp_psig = r.thp;
      assert.rel(sol(SY, M2).op.q, qT, 0.01, 'rate at the design THP');
    },
  },
  {
    name: 'WSY13 maximum rate: no choke, THP = separator + flowline Δp, above the choked rate',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const SY = app(ctx).win.WTS_wp_system;
      ['oilWell', 'gasWell'].forEach((k) => {
        const M = S.FIX[k], R = sol(SY, M), mx = SY.maxRate(M);
        assert.ok(mx.ok, k + ' ' + JSON.stringify(mx.errors));
        assert.ok(mx.q > R.op.q, k + ' maximum rate above the choked rate');
        assert.near(mx.R.surface.thp, mx.R.surface.pChokeDn, 1e-9, k + ' THP = flowline inlet pressure');
        assert.ok(mx.thp_psig > M.surface.psep_psig, k + ' above the separator');
        assert.ok(!mx.R.breakdown.some((b) => b.key === 'choke'), k + ' no choke term');
      });
    },
  },
  {
    name: 'WSY14 the Δp breakdown sums to p̄r − p_sep (reservoir, tubing gravity / friction / acceleration, choke, flowline)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const SY = app(ctx).win.WTS_wp_system;
      ['oilWell', 'gasWell'].forEach((k) => {
        const M = S.FIX[k], R = sol(SY, M), sum = R.breakdown.reduce((a, b) => a + b.dp, 0);
        assert.near(sum, M.res.pr - (M.surface.psep_psig + PATM), 1e-6, k + ' sum');
        ['reservoir', 'gravity', 'friction', 'acceleration', 'choke', 'flowline'].forEach((key) => assert.ok(R.breakdown.some((b) => b.key === key), k + ' ' + key));
        const g = R.breakdown.find((b) => b.key === 'gravity').dp, el = R.traverse.segments.reduce((a, s) => a + s.dpEl, 0);
        assert.near(g, el, 0.1, k + ' gravity = the marcher hydrostatic sum (on TVD), up to the root tolerance');
      });
    },
  },
  {
    name: 'WSY15 shut-in gas-filled column: WTS_gradient_compute with the iterated average Z, and an independent RK4 integration with local Z (0.2 %)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, SY = G.WTS_wp_system;
      ['oilWell', 'gasWell'].forEach((k) => {
        const M = S.FIX[k], sh = SY.shutIn(M);
        assert.ok(sh.ok, k + JSON.stringify(sh.errors));
        const gc = G.WTS_gradient_compute({ dir: 'b2s', p: M.res.pr - PATM, tvd: sh.tvd, gasLen: sh.tvd, mixLen: 0, hl: 0, rho: 8.33, sg: sh.sgCol, t: sh.tAvg, z: sh.zAvg });
        assert.rel(sh.gasFilled, gc.pSurf, 1e-9, k + ' = WTS_gradient_compute');
        // RK4 bottom → top, dp/dz = p·M/(z·R·T)/144 with z(p) local
        const Mw = 28.9647 * sh.sgCol, TR = sh.tAvg + 459.67, zf = (p) => G.WTS_gaspvt_z({ sg: sh.sgCol, p, t: sh.tAvg }).z;
        const f = (p) => p * Mw / (zf(p) * 10.7316 * TR) / 144;
        let p = M.res.pr; const n = 400, h = sh.tvd / n;
        for (let i = 0; i < n; i++) { const k1 = f(p), k2 = f(p - h * k1 / 2), k3 = f(p - h * k2 / 2), k4 = f(p - h * k3); p -= h * (k1 + 2 * k2 + 2 * k3 + k4) / 6; }
        assert.rel(sh.gasFilled + PATM, p, 0.002, k + ' vs RK4');
        assert.strictEqual(sh.sgCol, k === 'gasWell' ? G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F }).sgWell : 0.65, k + ' gravity: well stream for the wet gas (D14)');
      });
    },
  },
  {
    name: 'WSY16 shut-in liquid columns: 0.433·SG·TVD (0.01 %), the actual-fluid column and the partly liquid-filled list',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const SY = app(ctx).win.WTS_wp_system, M = S.FIX.gasWell;
      const sh = SY.shutIn(M, { levels: [0] });
      // liquid top at the surface: a full column of water (the well makes water) — p_sithp = p̄r − (62.4/144)·SG·TVD
      const exp = (M.res.pr - PATM) - (62.4 / 144) * M.fluid.sgw * sh.tvd;
      assert.rel(sh.partLiquid[0].sithp, exp, 1e-4, 'liquid column');
      const def = SY.shutIn(M);
      assert.strictEqual(def.partLiquid.length, 3, 'levels at 25 / 50 / 75 % of the TVD');
      for (let i = 1; i < 3; i++) assert.ok(def.partLiquid[i].sithp > def.partLiquid[i - 1].sithp, 'deeper liquid top → higher SITHP');
      assert.ok(def.partLiquid.every((r) => r.sithp < def.gasFilled), 'below the gas-filled bound');
      assert.ok(def.partLiquid.every((r) => r.liquidTopMd >= r.liquidTopTvd - 1e-6), 'MD ≥ TVD on the deviated well');
      const so = SY.shutIn(S.FIX.oilWell);
      assert.ok(so.actualFluid >= 0 && so.actualFluid < so.gasFilled && so.sithp === so.gasFilled, 'oil: live-liquid column below the gas bound');
      const sf = SY.shutIn(S.FIX.fallingBranch);
      assert.ok(sf.actualFluid === 0 && sf.liquidLevelTvd > 0, 'liquid level below surface: ' + sf.liquidLevelTvd);
      const sn = SY.shutIn(Object.assign(S.FIX.oilWell, { res: Object.assign(S.FIX.oilWell.res, { pr: null }) }));
      assert.ok(!sn.ok && sn.code === 'NEEDS_PR', 'p̄r never defaulted');
    },
  },
  {
    name: 'WSY17 bean schedule: monotone in bean on FIX.oilWell (rate up, THP down), warm tracking solves, ≤ 50 E for six beans',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const SY = app(ctx).win.WTS_wp_system, M = S.FIX.oilWell;
      const rows = run(SY.beanSchedule(M, M.surface.beans));
      assert.strictEqual(rows.length, 6);
      rows.forEach((r) => assert.ok(r.ok && r.stable && isFinite(r.q) && isFinite(r.thp) && isFinite(r.dpChoke) && r.regime, 'row ' + r.bean + ': ' + JSON.stringify(r)));
      for (let i = 1; i < rows.length; i++) {
        assert.ok(rows[i].q > rows[i - 1].q, 'rate rises with the bean');
        assert.ok(rows[i].thp < rows[i - 1].thp, 'THP falls with the bean');
      }
      assert.ok(rows.slice(1).every((r) => r.tracked), 'warm tracking solves after the first');
      const E = rows.reduce((a, r) => a + r.evals, 0);
      assert.ok(E <= 50, '§16 budget: ' + E + ' E');
      const R32 = sol(SY, M);
      assert.rel(rows.find((r) => r.bean === 32).q, R32.op.q, 2e-4, 'the 32/64 row = the single solve');
    },
  },
  {
    name: 'WSY18 equipment ratings: maximum flowing THT and SITHP verdicts (✓ / ⚠ within 10 % / ✗), none without a rating (Q20)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const SY = app(ctx).win.WTS_wp_system;
      const t = (r) => { const M = S.FIX.oilWell; M.surface.rating.tht_max_F = r; return SY.maxRate(M).rating.verdict; };
      assert.strictEqual(t(null), 'none'); assert.strictEqual(t(100), 'fail'); assert.strictEqual(t(125), 'warn'); assert.strictEqual(t(200), 'ok');
      const mx = SY.maxRate(S.FIX.oilWell);
      assert.strictEqual(mx.thtMax, mx.tht); assert.includes(mx.thtNote, 'A1');
      const s = (r) => { const M = S.FIX.oilWell; M.surface.rating.wellhead_psi = r; return SY.shutIn(M).rating; };
      const base = SY.shutIn(S.FIX.oilWell);
      assert.strictEqual(s(null).verdict, 'none');
      assert.strictEqual(s(base.sithp - 10).verdict, 'fail');
      assert.strictEqual(s(base.sithp + 100).verdict, 'warn');
      assert.strictEqual(s(base.sithp * 1.5).verdict, 'ok');
      assert.near(s(5000).margin, 5000 - base.sithp, 1e-6, 'margin = rating − worst SITHP');
    },
  },
  {
    name: 'WSY19 WTS_wp_check: survey / strings / mid-perforation, p̄r never defaulted, saturated reservoir with a PI, GOR ≥ Rsb only with a user bubble point, correlation validity with the provisional label',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, CK = G.WTS_wp_check;
      const c0 = CK(S.FIX.oilWell);
      assert.ok(c0.ok && c0.errors.length === 0, JSON.stringify(c0.errors));
      assert.ok(c0.items.some((i) => i.code === 'GOR_LT_RSB_NA' && i.sev === 'info'), 'GOR ≥ Rsb: not applicable without pbUser');
      assert.ok(c0.validity.some((v) => v.corr === 'bb' && !v.provisional), 'Beggs & Brill validity');
      assert.ok(c0.validity.every((v) => !/^[✓⚠✗]/.test(v.msg)), 'plain messages');
      const M1 = S.FIX.oilWell; M1.res.pr = null;
      const c1 = CK(M1);
      assert.ok(!c1.ok && c1.items.some((i) => i.code === 'PR_MISSING' && i.field === 'wp_pr'), 'p̄r needed');
      const M2 = S.FIX.oilWell; M2.well.survey = [[0, 0], [5000, 5000], [4000, 4000]];
      assert.ok(CK(M2).items.some((i) => i.code === 'SURVEY_MD'), 'MD strictly increasing');
      const M3 = S.FIX.oilWell; M3.well.midPerfMd = 9000;
      assert.ok(CK(M3).items.some((i) => i.code === 'MIDPERF_TD'), 'mid-perforation within the survey');
      const M4 = S.FIX.oilWell; M4.res.pr = 1500; M4.fluid.gor = 900;
      const c4 = CK(M4);
      assert.ok(c4.items.some((i) => i.code === 'SATURATED' && i.sev === 'warn'), 'saturated + PI → warn: ' + JSON.stringify(c4.items.map((i) => i.code)));
      const M5 = S.FIX.oilWell; M5.system.corr.well = 'hb'; M5.well.strings[0].id = 4.892; M5.well.strings[0].od = 5.5;
      const v5 = CK(M5).validity.find((v) => v.corr === 'hb');
      assert.ok(v5 && v5.provisional === true && v5.inRange === false, 'Hagedorn & Brown: provisional, out of range: ' + JSON.stringify(v5));
      const M6 = S.FIX.oilWell; M6.surface.choke.present = false; M6.system.thp_psig = 3200;
      assert.ok(CK(M6).items.some((i) => i.code === 'THP_GE_PR'), 'THP < p̄r');
    },
  },
  {
    name: 'WSY20 the page on the real engines: oil and wet-gas examples solve, KPIs / operating point / checks / hydrate and loading verdicts filled, no NaN, no stubs left in WP5',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const A = app(ctx), G = A.win, txt = (e) => String(e && e.textContent || '').replace(/\s+/g, ' ').trim(), BAD = /NaN|undefined|Infinity|\[object Object\]/;
      if (G.__WP_MOCK) return assert.ok(true, 'mock installed in this app');
      S.resetWellPerf(A);
      A.hook.nav('wellperf'); A.flush(30);
      A.click(A.find('[data-act="example"][data-ex="oil"]')); A.flush(30);
      let st = G.WTS_state.wellperf;
      assert.ok(st.ok && st.op && st.op.stable, 'oil solved: ' + JSON.stringify(plain(st.code)));
      assert.ok(!(st.stubs || []).some((n) => /system|loading|check/.test(n)), 'no WP5 stub in use');
      const k = A.findAll('#wp_kpis .kpi').map(txt).join(' | ');
      assert.match(k, /Liquid rate\s*[\d,]+ STB\/d/); assert.match(k, /Hydrate margin[\d.]+ °F/);
      assert.match(txt(A.el('wp_verd')), /✓ Stable operating point/);
      assert.match(txt(A.el('wp_op')), /Choke regime/);
      ['wp_res', 'wp_kpis'].forEach((id) => assert.ok(!BAD.test(txt(A.el(id))), id + ' clean: ' + (txt(A.el(id)).match(BAD) || [''])[0]));
      const cv = A.el('wp_cv_sys');
      assert.ok(cv._wp && cv._wp.spec.series.find((s) => s.key === 'vlp').pts.length > 10, 'outflow curve with the choke in line (R.curves)');
      // a live drag of p̄r runs the warm tracking solve (≈ 5 E) and keeps the last full solve's outflow curve; release = full solve
      const P = G.WTS_wellperf_page, q0 = st.op.q, pst = P.state();
      P.handle('pr', 3200, 'move'); A.flush(5);
      assert.ok(pst.R.ok && pst.R.tracked && pst.R.carried && pst.R.evals <= 8, 'live drag: tracking solve (' + pst.R.evals + ' E)');
      assert.ok(pst.R.op.q > q0, 'higher p̄r → higher rate live');
      assert.ok(cv._wp.spec.series.find((s) => s.key === 'vlp').pts.length > 10, 'outflow curve kept during the drag');
      P.handle('pr', 3200, 'end'); A.flush(30);
      assert.ok(pst.R.ok && !pst.R.tracked && pst.R.qs, 'release: full solve with q_s');
      A.click(A.find('[data-act="example"][data-ex="gas"]')); A.flush(30);
      st = G.WTS_state.wellperf;
      assert.ok(st.ok && st.loading && isFinite(st.loading.margin), 'gas solved with loading');
      assert.match(txt(A.el('wp_verd')), /critical rate/);
      assert.ok(!BAD.test(txt(A.el('wp_res'))), 'gas page clean');
      assert.strictEqual(A.consoleErrors().length, 0, 'no console errors');
    },
  },
  {
    name: 'WSY21 provisional-label gate (wellperf-validate.js gate, D17 / §15.1): every unverified method is labelled and never a default; every verified one has a published or pinned example',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const V = require('../wellperf-validate.js');
      const g = V.gate(app(ctx).win);
      assert.ok(g.ok, g.errors.join('; '));
      assert.ok(g.rows.some((r) => r.key === 'hb' && !r.verified && r.status === 'pending'), 'Hagedorn & Brown pending (Q9)');
      assert.ok(g.rows.some((r) => r.key === 'bb' && r.verified), 'Beggs & Brill pinned');
      assert.strictEqual(V.PROVISIONAL, 'provisional — not verified against a published example');
    },
  },
];
