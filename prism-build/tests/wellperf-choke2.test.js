// Well Performance A2, WP15 — the continuous critical / sub-critical choke (Sachdeva et al. 1986), the liquid valve-coefficient
// law and the rate factor. docs/WELL-PERFORMANCE-PLAN.md §4.7, §15.1 (Sachdeva: Brill & Mukherjee choke chapter — the book is not
// available (Q9), so the model ships provisional through the D17 gate), §15.3 (fixed point ≤ 30 iterations), §17.2 (6 tests).
//
// WCK1 critical ratio y_c: the gas-only limit is the isentropic (2/(k+1))^(k/(k−1)) exactly; the published implicit equation is
//      satisfied (y = F(y)) and the fixed point converges in ≤ 30 iterations over the whole input grid
// WCK2 sub-critical mass flux: the liquid limit is the incompressible orifice, the gas limit the isentropic nozzle; choked (flat)
//      below y_c, falling to 0 at y = 1; WTS_chokeperf_liquidCv = 34.2857·Cv·√(Δp/SG) = the solver's 1022.7 orifice
// WCK3 continuity in the solver: p1(q) has no jump at the regime change (|jump| < 0.1 psi) for the scaled default and for the
//      Sachdeva model alone; p1 rises with q
// WCK4 rate factor: in critical flow the scaled default gives the correlation's p1 exactly; chokeFactor() makes the Sachdeva model
//      equal Gilbert at the operating point; the factor scales the mass rate linearly
// WCK5 the A2 default replaces the A1 conservative bound: FIX.oilWell keeps its operating point (critical there), loses the
//      bound's unstable low root, flags and validity carry the provisional label, the bean design is no longer capped; the A1 rule
//      stays as surface.choke.subcritical 'bound'; a gas well with the Sachdeva model carries its liquids through the bean
// WCK6 the page: the choke model / sub-critical / Cd / rate factor controls, the Fit button, the Choke tab (curve, critical
//      ratios, operating point, bean handle that re-solves), the operating point rows, Notes and the case summary
'use strict';

const S = require('./_wellperf-shapes');

const WP = 'WP15';
const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const app = (ctx) => S.sharedApp(ctx);
const run = (job) => { let s, n = 0; do { s = job.step(); n++; } while (!s.done && n < 200); return job.result(); };
const GC = 32.174;

module.exports = [
  {
    name: 'WCK1 critical ratio: gas-only limit = isentropic ratio; y_c satisfies the published implicit equation; fixed point ≤ 30 iterations over the input grid',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, sd = G.WTS_chokeperf_sachdeva;
      assert.strictEqual(typeof sd, 'function');
      assert.strictEqual(G.WTS_chokeperf_SACHDEVA.verified, false, 'provisional (D17): no verified published example (Q9)');
      [1.1, 1.25, 1.3, 1.4, 1.6].forEach((k) => {
        const r = sd({ s64: 32, p1a: 1000, p2a: 100, x1: 1, rhoG1: 3.5, k, sg: 0.65 });
        assert.near(r.yc, Math.pow(2 / (k + 1), k / (k - 1)), 1e-8, 'gas limit k ' + k);
      });
      let worst = 0, n = 0;
      [1e-4, 1e-3, 0.01, 0.05, 0.2, 0.5, 0.9, 0.999].forEach((x1) => [1.15, 1.3, 1.5].forEach((k) => [[50, 1], [50, 8], [62, 0.3], [40, 20]].forEach(([rL, rG]) => {
        const r = sd({ s64: 24, p1a: 1500, p2a: 100, x1, rhoL: rL, rhoG1: rG, k, sg: 0.7, cL: 0.6 });
        n++;
        assert.ok(r.ok && r.converged, 'converged x1 ' + x1 + ' k ' + k + ': ' + JSON.stringify(plain(r)));
        assert.ok(r.it <= 30, 'iterations ' + r.it);
        assert.ok(r.yc > 0 && r.yc < 1, 'y_c in (0, 1)');
        worst = Math.max(worst, r.it);
        // the published implicit equation at y_c (v_L, v_G1 in ft³/lbm; n the polytropic exponent)
        const vL = 1 / rL, vG1 = 1 / rG, kk = k / (k - 1), y = r.yc, vG2 = vG1 * Math.pow(y, -1 / k), a = (1 - x1) * vL / x1, b = a / vG2;
        const rhs = Math.pow((kk + a * (1 - y) / vG1) / (kk + r.n / 2 + r.n * b + (r.n / 2) * b * b), kk);
        assert.ok(Math.abs(rhs - y) < 1e-7, 'y = F(y) at x1 ' + x1 + ': ' + rhs + ' vs ' + y);
      })));
      assert.ok(n === 96 && worst <= 30, 'grid of ' + n + ', worst ' + worst + ' iterations');
      // continuous towards the gas limit
      const yc = (x1) => sd({ s64: 24, p1a: 1500, p2a: 100, x1, rhoL: 50, rhoG1: 5, k: 1.3, sg: 0.7 }).yc;
      assert.ok(Math.abs(yc(1 - 1e-7) - yc(1)) < 1e-4, 'y_c continuous at x1 → 1: ' + yc(1 - 1e-7) + ' vs ' + yc(1));
      assert.ok(!sd({ s64: 24, p1a: 1500, p2a: 100, x1: 0.2, rhoG1: 5 }).ok, 'liquid density needed');
    },
  },
  {
    name: 'WCK2 sub-critical flux: liquid limit = incompressible orifice, gas limit = isentropic nozzle, choked below y_c; liquidCv = the 1022.7 orifice',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, sd = G.WTS_chokeperf_sachdeva, lc = G.WTS_chokeperf_liquidCv;
      const d = 32 / 64, A = Math.PI / 4 * (d / 12) * (d / 12);
      // liquid only: Cd·A·√(2·g_c·144·ρ·Δp), no critical flow
      const L = sd({ s64: 32, cd: 0.8, p1a: 600, p2a: 200, x1: 0, rhoL: 55 });
      assert.near(L.w, 0.8 * A * Math.sqrt(2 * GC * 144 * 55 * 400), 1e-9 * L.w, 'orifice');
      assert.strictEqual(L.yc, 0);
      // gas only, sub-critical: Cd·A·√(2 g_c 144 p1 ρ1 k/(k−1) (y^(2/k) − y^((k+1)/k)))
      const k = 1.3, rho1 = 3.2, p1 = 1000, y = 0.8, Gs = sd({ s64: 32, cd: 0.85, p1a: p1, p2a: y * p1, x1: 1, rhoG1: rho1, k, sg: 0.65 });
      const ref = 0.85 * A * Math.sqrt(2 * GC * 144 * p1 * rho1 * k / (k - 1) * (Math.pow(y, 2 / k) - Math.pow(y, (k + 1) / k)));
      assert.near(Gs.w, ref, 1e-9 * ref, 'isentropic nozzle');
      assert.strictEqual(Gs.regime, 'subcritical');
      // two-phase: flat (choked) below y_c, monotone falling to 0 at y = 1
      const o = { s64: 24, p1a: 1200, x1: 0.08, rhoL: 50, rhoG1: 4.5, k: 1.28, sg: 0.7 };
      const w = (yy) => sd(Object.assign({ p2a: yy * 1200 }, o));
      const yc = w(0.5).yc, wc = w(yc * 0.5).w;
      assert.ok(w(yc * 0.5).critical && Math.abs(w(yc * 0.9).w - wc) < 1e-12 * wc, 'choked below y_c');
      let prev = Infinity; [yc + 0.01, 0.7, 0.8, 0.9, 0.97, 0.995].forEach((yy) => { const v = w(yy).w; assert.ok(v < prev && v <= wc * (1 + 1e-12), 'falls at ' + yy); prev = v; });
      assert.near(w(1 - 1e-12).w, 0, 1e-3 * wc, '0 at y = 1');
      assert.near(w(yc * (1 + 1e-9)).w, wc, 1e-6 * wc, 'continuous at y_c');
      // liquid valve coefficient: q = 34.2857 Cv √(Δp/SG); the bean's Cv = (1022.7/34.2857)·Cd·d²; inverse round trip
      const c1 = lc({ s64: 32, cd: 0.85, sg: 1.05, dp_psi: 250 });
      assert.near(c1.q_bpd, 1022.7 * 0.85 * d * d * Math.sqrt(250 / 1.05), 1e-9, 'the solver orifice (1022.7)');
      assert.near(lc({ cv: c1.cv, sg: 1.05, q_bpd: c1.q_bpd }).dp_psi, 250, 1e-9, 'inverse');
      assert.near(lc({ cv: 10, sg: 1, dp_psi: 1 }).q_bpd, 342.857, 1e-9, 'Cv definition (US gal/min at 1 psi)');
      assert.ok(!lc({ s64: 32, sg: 1 }).ok && !lc({ sg: 1, dp_psi: 1 }).ok, 'refused without Δp / q or a size');
    },
  },
  {
    name: 'WCK3 continuity: p1(q) has no jump at the regime change (scaled default and the Sachdeva model alone), p1 rises with q',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const SY = app(ctx).win.WTS_wp_system;
      const find = (M, a, b) => { const ra = SY.boundary(M, a).regime; for (let k = 0; k < 60; k++) { const m = 0.5 * (a + b); if (SY.boundary(M, m).regime === ra) a = m; else b = m; if (b - a < 1e-7 * b) break; } return 0.5 * (a + b); };
      const Md = S.FIX.oilWell;                                   // A2 default: Gilbert + the scaled Sachdeva sub-critical branch
      const b1 = SY.boundary(Md, 100), b2 = SY.boundary(Md, 900);
      assert.ok(b1.regime === 'subcritical' && b2.regime === 'critical', b1.regime + ' / ' + b2.regime);
      assert.ok(b1.yc > 0.5 && b1.yc < 0.7, 'Sachdeva y_c ' + b1.yc);
      const qc = find(Md, 100, 900), e = 1e-5 * qc, lo = SY.boundary(Md, qc - e), hi = SY.boundary(Md, qc + e);
      assert.ok(lo.regime !== hi.regime, 'straddles');
      assert.ok(Math.abs(hi.thp - lo.thp) < 0.1, 'scaled |jump| ' + Math.abs(hi.thp - lo.thp));
      assert.ok(Math.abs(lo.ratio - lo.yc) < 1e-3, 'the switch is at the Sachdeva critical ratio');
      const Ms = S.FIX.oilWell; Ms.surface.choke.corr = 'sachdeva';
      assert.strictEqual(SY.boundary(Ms, 150).regime, 'subcritical');
      const qs = find(Ms, 150, 3000), es = 1e-5 * qs, l2 = SY.boundary(Ms, qs - es), h2 = SY.boundary(Ms, qs + es);
      assert.ok(l2.regime !== h2.regime && Math.abs(h2.thp - l2.thp) < 0.1, 'Sachdeva alone |jump| ' + Math.abs(h2.thp - l2.thp));
      [Md, Ms].forEach((M, i) => { let p = 0; [50, 150, 300, 500, 700, 900, 1200].forEach((q) => { const t = SY.boundary(M, q).thp; assert.ok(t > p, 'case ' + i + ': p1 rises at q ' + q); p = t; }); });
    },
  },
  {
    name: 'WCK4 rate factor: critical flow keeps the correlation exactly; chokeFactor makes Sachdeva equal Gilbert at the operating point; the factor scales the rate',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, SY = G.WTS_wp_system;
      const Mb = S.FIX.oilWell; Mb.surface.choke.subcritical = 'bound';
      const Md = S.FIX.oilWell;
      [700, 900, 1100].forEach((q) => { const a = SY.boundary(Md, q), b = SY.boundary(Mb, q); assert.ok(a.regime === 'critical' && b.regime === 'critical'); assert.near(a.thp, b.thp, 1e-9 * b.thp, 'critical: the correlation p1 at q ' + q); });
      const R = SY.solve(Md);
      assert.ok(R.ok && R.surface.choke.regime === 'critical' && R.surface.choke.model === 'sachdeva-scaled' && R.surface.choke.rateFactor > 0, JSON.stringify(plain(R.surface.choke)));
      const cf = SY.chokeFactor(Md, 'gilbert', { R });
      assert.ok(cf.ok && cf.factor > 0.2 && cf.factor < 5, JSON.stringify(plain(cf)));
      assert.near(cf.factor, R.surface.choke.rateFactor, 1e-4 * cf.factor, 'the factor of the scaled default at the operating point');
      const Mf = S.FIX.oilWell; Mf.surface.choke.corr = 'sachdeva'; Mf.surface.choke.rateFactor = cf.factor;
      const bf = SY.boundary(Mf, R.op.q);
      assert.ok(Math.abs(bf.thp - R.surface.thp) < 0.1, 'Sachdeva × factor = Gilbert at the operating point: ' + bf.thp + ' vs ' + R.surface.thp);
      // linear in the factor: p1(q, 2·f) = p1(q/2, f) with a fixed downstream pressure (no flowline)
      const M1 = S.FIX.oilWell; M1.surface.flowline = []; M1.surface.choke.corr = 'sachdeva'; M1.surface.choke.rateFactor = 1;
      const M2 = S.FIX.oilWell; M2.surface.flowline = []; M2.surface.choke.corr = 'sachdeva'; M2.surface.choke.rateFactor = 2;
      [400, 1600].forEach((q) => assert.near(SY.boundary(M2, q).thp, SY.boundary(M1, q / 2).thp, 1e-6, 'linear at q ' + q));
      assert.ok(SY.chokeFactor(S.FIX.gasWell, 'gilbert').code === 'NOT_APPLICABLE', 'gas wells: no critical multiphase correlation to match');
      const cc = SY.chokeCurve(Md, { R });
      assert.ok(cc.ok && cc.series.sachdeva.length === 40 && cc.series.corr.length > 10, 'choke curve series');
      const atOp = cc.series.corr[0].q;
      assert.near(cc.series.sachdeva[0].q, atOp, 1e-6 * atOp, 'scaled curve = the correlation in critical flow');
      assert.ok(cc.op.y < cc.ycSachdeva && Math.abs(cc.op.q - R.op.q) < 1e-9, 'operating point on the critical plateau');
    },
  },
  {
    name: 'WCK5 the A2 default replaces the A1 bound: same operating point, no bound root, provisional flags / validity, design no longer capped; the bound stays selectable; Sachdeva carries the liquids of a gas well',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, SY = G.WTS_wp_system;
      const Mb = S.FIX.oilWell; Mb.surface.choke.subcritical = 'bound';
      const Rb = SY.solve(Mb), Rd = SY.solve(S.FIX.oilWell);
      assert.ok(Rb.ok && Rd.ok);
      assert.near(Rd.op.q, Rb.op.q, 2e-4 * Rb.op.q, 'critical at the operating point: same rate (within the root tolerance 1e-4·q)');
      assert.strictEqual(Rb.roots.length, 2, 'A1 bound: the unstable low root');
      assert.strictEqual(Rd.roots.length, 1, 'A2: the bound\'s low root is gone (the continuous branch is lower)');
      assert.ok(SY.boundary(S.FIX.oilWell, 200).thp < SY.boundary(Mb, 200).thp - 30, 'the bound over-states p1 in sub-critical flow');
      const Mlo = S.FIX.oilWell; Mlo.surface.choke.bean64 = 64;
      const Rlo = SY.solve(Mlo);
      assert.ok(Rlo.ok && Rlo.surface.choke.regime === 'subcritical', 'large bean: ' + Rlo.surface.choke.regime);
      assert.ok(Rlo.flags.some((f) => f.code === 'CHOKE_SUBCRITICAL' && /provisional/.test(f.msg)) && !Rlo.flags.some((f) => f.code === 'SUBCRITICAL_BOUND'), 'flag');
      const v = (G.WTS_wp_check(Mlo).validity || []).find((x) => x.corr === 'sachdeva');
      assert.ok(v && v.provisional === true && v.inRange === false, 'validity: provisional, bean 64 outside 8–40');
      assert.ok(G.WTS_wp_check(S.FIX.oilWell).validity.find((x) => x.corr === 'sachdeva').inRange, 'bean 32 in range');
      assert.ok(!G.WTS_wp_check(Mb).validity.some((x) => x.corr === 'sachdeva'), 'not listed with the A1 bound');
      // the bean design that the A1 bound capped (WRV8) reaches higher rates now
      const d = run(SY.designFor(S.FIX.oilWell, { bean: 1250 }));
      assert.ok(!(d.errors || []).some((t) => /sub-critical bound/.test(t)), 'no bound cap: ' + (d.errors || []).join(' '));
      assert.ok(d.ok || d.best.q > 1150, 'design above the bound cap: ' + JSON.stringify(plain(d.best || d.q)));
      // QC: a sub-critical test still warns (provisional branch)
      const Mh = S.FIX.oilWell; Mh.surface.psep_psig = 600;
      const c = G.WTS_wp_qc(Mh, [S.FIX.test1]).rows[0].checks.find((x) => x.code === 'QC_CHOKE');
      assert.ok(c.st === 'warn' && /Sachdeva/.test(c.msg) && /sub-critical/.test(c.msg), c.msg);
      // gas well: the Sachdeva model carries the condensate and water through the bean (the nozzle carries the gas only)
      const Mg = S.FIX.gasWell; Mg.surface.choke.corr = 'sachdeva';
      const Rg = SY.solve(Mg), Rn = SY.solve(S.FIX.gasWell);
      assert.ok(Rg.ok && Rg.surface.choke.model === 'sachdeva' && Rg.surface.choke.x1 > 0.5 && Rg.surface.choke.x1 < 1, JSON.stringify(plain(Rg.surface.choke)));
      assert.ok(!Rg.flags.some((f) => f.code === 'NOZZLE_GAS_ONLY') && Rg.flags.some((f) => f.code === 'CHOKE_PROVISIONAL'), 'flags');
      assert.ok(Rn.flags.some((f) => f.code === 'NOZZLE_GAS_ONLY'), 'the nozzle still says so');
      assert.ok(Rg.op.q < Rn.op.q, 'the liquids load the bean: lower rate than the gas-only nozzle');
    },
  },
  {
    name: 'WCK6 page: choke model / sub-critical / Cd / rate factor controls, Fit, the Choke tab with the bean handle, operating-point rows, Notes and case summary',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const A = app(ctx), G = A.win, txt = (e) => String(e && e.textContent || '').replace(/\s+/g, ' ').trim(), BAD = /NaN|undefined|Infinity|\[object Object\]/;
      if (G.__WP_MOCK) return assert.ok(true, 'mock installed in this app');
      S.resetWellPerf(A); G.WTS_wellperf_page.resetJobs();
      A.hook.nav('wellperf'); A.flush(30);
      A.click(A.find('[data-act="example"][data-ex="oil"]')); A.flush(30);
      const opts = Array.from(A.el('wp_ckcorr').options).map((o) => o.value);
      assert.deepStrictEqual(opts, ['gilbert', 'ros', 'baxendell', 'achong', 'sachdeva']);
      assert.match(A.el('wp_ckcorr').options[4].textContent, /provisional/);
      assert.strictEqual(A.el('wp_cksub').value, 'sachdeva', 'A2 default: the continuous sub-critical branch');
      const off = (id) => /wp-off/.test(A.el(id).closest('.fg-item').className);
      assert.ok(off('wp_ckrf') && !off('wp_cksub'), 'critical correlation: rate factor hidden, sub-critical rule shown');
      assert.match(txt(A.el('wp_op')), /critical ratio 0\.\d{3}/);
      assert.match(txt(A.el('wp_case')), /sub-critical: Sachdeva branch/);
      assert.match(txt(A.el('wp_notesbox')), /Sachdeva et al\. \(1986\)/);
      assert.match(txt(A.el('wp_valid')), /Sachdeva et al\. \(1986\) sub-critical choke branch: inside the published data range/);
      // the Choke tab: curve, critical ratios, operating point, the bean handle
      A.click(A.find('#wp_trtabs [data-tab="choke"]')); A.flush(5);
      const cv = A.el('wp_cv_tr'), sp = cv._wp.spec;
      assert.ok(sp.series.some((s) => s.key === 'sach' && s.pts.length === 40) && sp.series.some((s) => s.key === 'corr'), 'series');
      assert.ok(sp.vlines.length >= 1 && sp.markers.length === 1 && /critical/.test(sp.markers[0].label), 'y_c lines + operating point');
      assert.ok(sp.handles.length === 1 && sp.handles[0].key === 'bean', 'bean handle');
      const q0 = G.WTS_state.wellperf.op.q;
      G.WTS_wellperf_page.handle('bean', 40, 'end'); A.flush(30);
      assert.ok(G.WTS_state.wellperf.op.q > q0 && A.el('wp_bean').value === '40', 'the handle re-solves at the new bean');
      // the Sachdeva model alone + Fit to Gilbert
      A.select('wp_ckcorr', 'sachdeva'); A.flush(30);
      assert.ok(!off('wp_ckrf') && off('wp_cksub'), 'Sachdeva: rate factor shown, sub-critical rule hidden');
      A.click(A.find('[data-act="ckfit"]')); A.flush(30);
      const rf = +A.el('wp_ckrf').value;
      assert.ok(rf > 0.2 && rf < 5, 'fitted rate factor ' + rf);
      assert.match(txt(A.el('wp_ckfitmsg')), /✓ Rate factor/);
      assert.strictEqual(G.WTS_state.wellperf.surface.choke.model, 'sachdeva');
      assert.ok(!BAD.test(txt(A.el('wp_res'))) && !BAD.test(txt(A.el('wp_step_5'))), 'clean');
      assert.strictEqual(A.consoleErrors().length, 0, 'no console errors');
      A.select('wp_ckcorr', 'gilbert'); A.change('wp_bean', '32'); A.flush(30);
    },
  },
];
