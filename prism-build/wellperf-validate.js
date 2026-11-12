#!/usr/bin/env node
// prism-build/wellperf-validate.js — Well Performance benchmark, cross-check and evaluation-budget gate (WP11).
// Plan: docs/WELL-PERFORMANCE-PLAN.md §15 (validation), §16 (performance budgets), D16, D17.
//
//   node prism-build/wellperf-validate.js [--check] [--time] [--gate] [--html] [--json] [--strict]
//
//   --gate     the provisional-label gate (D17, §15.1) only — also part of --check
//   --check    the gate, then the hand-calculation / internal cross-checks of §15.2 and the convergence tests of §15.3 on the
//              contract fixtures (tests/_wellperf-shapes.js); prints one PASS / FAIL row per check and the §15.1 published-example
//              table with each method's status
//   --time     per operation: the evaluation count E (the stable gate: it must stay within the §16 budget) and the milliseconds,
//              reported against a loose cap of 2 × (one fine evaluation measured in this run on the same fixture) × E; the WP0
//              baseline (BASELINE.E_ms, 10 000 ft vertical) is printed for reference
//   (no flag)  --check and --time
//   --html     load the built well-testing-app.html instead of the sources
//   --json     print the summary as JSON on stdout
//   --strict   exit 1 when a millisecond cap is missed too (the evaluation budgets and the checks always count)
//
// Exit codes: 0 ok; 1 a check, the gate or an evaluation budget failed (or a ms cap with --strict); 2 crash.
// Field units throughout. The app is loaded once through tests/_harness.js loadApp (real timers, console errors only).
//
// THE GATE (D17). A method can be the default, and can drop the label "provisional — not verified against a published example",
// only when BENCH below records a verified published example ('verified', a page reference checked against the book) or an
// existing pinned published-example test in the app ('pinned'). Q9 (the owner's textbooks) is open, so every new A1 method is
// 'pending': the gate checks that each of them is verified:false in its registry, carries the label in the list / traverse /
// check validity / loading result, and is never a default. Flipping a method to verified is one BENCH edit plus its benchmark test.
'use strict';

const path = require('path');

const ROOT = __dirname;
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const nowMs = () => Number(process.hrtime.bigint()) / 1e6;
const PATM = 14.696;
const PROVISIONAL = 'provisional — not verified against a published example';

// §15.1: method → published example status. status: 'verified' (page reference checked) | 'pinned' (an existing published-example
// test in the app) | 'pending' (Q9: the book is not available — the method ships provisional). kind = where the gate looks.
const BENCH = [
  { kind: 'corr', key: 'bb', status: 'pinned', source: 'Brill & Mukherjee Ex. 4.7 (calc-flowline tests)' },
  { kind: 'corr', key: 'hb', status: 'pending', source: 'Brown vol. 1; Brill & Mukherjee (Hagedorn & Brown traverse), ±3 % on Δp' },
  { kind: 'corr', key: 'gray', status: 'pending', source: 'Economides et al.; Guo, Lyons & Ghalambor (Gray), ±3 %' },
  { kind: 'corr', key: 'nsl', status: 'pending', source: 'homogeneous no-slip (hand calculation only — a cross-check is not a verification)' },
  { kind: 'corr', key: 'single', status: 'pending', source: 'Darcy-Weisbach + Colebrook (hand calculation only)' },
  { kind: 'corr', key: 'gasTZ', status: 'pending', source: 'Economides et al.; Guo et al. (average T and Z), ±1 %' },
  { kind: 'ipr', key: 'pi', status: 'pinned', source: 'calc-new oilipr tests (WTS_oilipr_compute)' },
  { kind: 'ipr', key: 'vogel', status: 'pinned', source: 'Ahmed; Brown vol. 1 — calc-new oilipr tests' },
  { kind: 'ipr', key: 'composite', status: 'pinned', source: 'Ahmed — calc-new oilipr tests' },
  { kind: 'ipr', key: 'fetkovich', status: 'pinned', source: 'Ahmed — calc-new oilipr tests' },
  { kind: 'ipr', key: 'backPressure', status: 'pinned', source: 'calc-new gasdeliv tests (WTS_gasdeliv_compute)' },
  { kind: 'ipr', key: 'litP2', status: 'pinned', source: 'calc-new gasdeliv tests (WTS_gasdeliv_compute)' },
  { kind: 'ipr', key: 'jbgOil', status: 'pending', source: 'Economides et al.; Golan & Whitson (Jones-Blount-Glaze), ±1 %' },
  { kind: 'ipr', key: 'darcyOil', status: 'pending', source: 'Economides et al. (Darcy radial), ±1 %' },
  { kind: 'ipr', key: 'litMp', status: 'pending', source: 'Golan & Whitson (LIT in m(p)), ±1 %' },
  { kind: 'ipr', key: 'darcyGas', status: 'pending', source: 'Economides et al. (Darcy gas with D), ±1 %' },
  { kind: 'loading', key: 'turner', status: 'pending', source: 'Lea, Nickens & Wells; Guo et al. (Turner critical rate), ±1 %' },
  { kind: 'loading', key: 'coleman', status: 'pending', source: 'Lea, Nickens & Wells (Coleman critical rate), ±1 %' },
  { kind: 'loading', key: 'li', status: 'pending', source: 'Li et al. (2001) flat-droplet critical rate' },
  { kind: 'system', key: 'nodal', status: 'pending', source: 'Beggs, Production Optimization Using Nodal Analysis — operating point ±2 % q' },
  { kind: 'well', key: 'minCurvature', status: 'pinned', source: 'closed-form circular arc (FIX.devSurvey, wellperf-well) ±0.01 ft' },
  { kind: 'temp', key: 'relax', status: 'pending', source: 'Hasan & Kabir, Fluid Flow and Heat Transfer in Wellbores (Ramey / Hasan-Kabir relaxation), ±2 °F — A2 WP14; closed form + RK4 cross-check X16 only' },
];

// §16: evaluation budgets (E = one fine well traverse + flowline march + choke; a coarse evaluation = ½ E)
const BUDGET = {
  traverse: 1, solve1: 20, solve2: 24, page: 26, design: 60, beans6: 50, maxRate: 24, sens10: 80,
};

function _load() {
  const harness = require('./tests/_harness');
  const app = harness.loadApp({ fromSources: !flag('--html'), timers: 'real', console: 'errors', silentBuild: true });
  return app;
}
function _S() { return require('./tests/_wellperf-shapes'); }

// ── the provisional-label gate ──────────────────────────────────────────────────────────────────────────────────────────
function gate(G) {
  const S = _S(), rows = [], errors = [];
  const bad = (key, msg) => { errors.push(key + ': ' + msg); };
  const REG = G.WTS_flowline_corr || {}, V = G.WTS_wp_vlp, IP = (G.WTS_wp_ipr && G.WTS_wp_ipr.models) || {};
  const benchOf = (kind, key) => BENCH.find((b) => b.kind === kind && b.key === key);
  // 1. correlations
  Object.keys(REG).filter((k) => k.indexOf('__') !== 0).forEach((k) => {
    const e = REG[k], b = benchOf('corr', k);
    if (!b) { bad(k, 'no §15.1 entry in BENCH'); return; }
    const verifiedOk = b.status === 'verified' || b.status === 'pinned';
    if (e.verified === true && !verifiedOk) bad(k, 'marked verified without a verified published example');
    if (e.verified !== true && verifiedOk) bad(k, 'has a verified example but the registry still says verified:false');
    if (e.verified !== true) {
      const l = (V && V.list ? V.list() : []).find((x) => x.key === k);
      if (!l || l.provisional !== PROVISIONAL) bad(k, 'list() does not carry the provisional label');
    }
    rows.push({ kind: 'corr', key: k, label: e.label || k, verified: e.verified === true, status: b.status, source: b.source });
  });
  // 2. inflow models
  Object.keys(IP).forEach((k) => {
    const e = IP[k], b = benchOf('ipr', k);
    if (!b) { bad('ipr ' + k, 'no §15.1 entry in BENCH'); return; }
    const verifiedOk = b.status === 'verified' || b.status === 'pinned';
    if (!!e.verified !== verifiedOk) bad('ipr ' + k, 'registry verified=' + e.verified + ' but BENCH status ' + b.status);
    if (!e.verified && e.provisional !== PROVISIONAL) bad('ipr ' + k, 'no provisional label');
    rows.push({ kind: 'ipr', key: k, label: e.label || k, verified: !!e.verified, status: b.status, source: b.source });
  });
  // 3. defaults are verified (D17)
  ['oil', 'gas', 'condensate', 'water', 'waterinj', 'gasinj'].forEach((t) => {
    const d = V.defaultCorr(t), e = REG[d.key];
    if (!e || e.verified !== true) bad('default ' + t, d.key + ' is not verified');
    else if (d.preferred !== d.key && !d.provisional) bad('default ' + t, 'preferred ' + d.preferred + ' replaced without the provisional reason');
  });
  const D = G.WTS_wp_model && G.WTS_wp_model.DEFAULTS;
  if (D) {
    const line = (D.system && D.system.corr && D.system.corr.line) || 'bb';
    if (!REG[line] || REG[line].verified !== true) bad('default line', line + ' is not verified');
    const im = D.res && D.res.model;
    if (im && IP[im] && !IP[im].verified) bad('default inflow', im + ' is not verified');
  }
  // 4. the label reaches the traverse, the check validity (page + report) and the loading result
  const M = S.FIX.oilWell, F = G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F }), W = G.WTS_wp_well.build(M.well, { res: M.res });
  Object.keys(REG).filter((k) => k.indexOf('__') !== 0 && REG[k].verified !== true && REG[k].kind !== 'line').forEach((k) => {
    const tr = V.traverse(F, W, 800, { from: 'top', p0: 300, corr: k, coarse: true });
    if (!(tr.warnings || []).some((w) => w.code === 'PROVISIONAL' && w.msg.indexOf(PROVISIONAL) !== -1)) bad(k, 'traverse has no PROVISIONAL warning');
    const M2 = S.FIX.oilWell; M2.system.corr.well = k;
    const v = (G.WTS_wp_check(M2).validity || []).find((x) => x.corr === k);
    if (!v || v.provisional !== true) bad(k, 'check validity does not mark it provisional');
  });
  const R = G.WTS_wp_system.solve(S.FIX.gasWell);
  const loadPending = BENCH.filter((b) => b.kind === 'loading' && b.status === 'pending').length > 0;
  if (!R.ok || !R.loading) bad('loading', 'no loading result on FIX.gasWell');
  else if (loadPending && (R.loading.verified !== false || R.loading.provisional !== PROVISIONAL)) bad('loading', 'pending methods without the provisional label');
  // 5. the relaxation temperature model (A2, WP14): pending → R.heat carries the label and verified:false, and it is never the default
  const tb = benchOf('temp', 'relax');
  if (tb && G.WTS_wp_well && typeof G.WTS_wp_well.relax === 'function') {
    const Mr = S.FIX.oilWell; Mr.well.heat.mode = 'relax';
    const Rr = G.WTS_wp_system.solve(Mr), pend = tb.status === 'pending';
    if (!Rr.ok || !Rr.heat || Rr.heat.mode !== 'relax') bad('temp relax', 'no relaxation result on FIX.oilWell');
    else if (pend && (Rr.heat.verified !== false || Rr.heat.provisional !== PROVISIONAL)) bad('temp relax', 'pending without the provisional label');
    if (pend && D && D.well && D.well.heat && D.well.heat.mode === 'relax') bad('temp relax', 'a pending method is the default temperature model');
  }
  BENCH.filter((b) => b.kind === 'loading' || b.kind === 'system' || b.kind === 'well' || b.kind === 'temp').forEach((b) => rows.push({ kind: b.kind, key: b.key, label: b.key, verified: b.status !== 'pending', status: b.status, source: b.source }));
  return { ok: errors.length === 0, rows, errors };
}

// ── §15.2 / §15.3 cross-checks ─────────────────────────────────────────────────────────────────────────────────────────
function checks(G) {
  const S = _S(), SY = G.WTS_wp_system, V = G.WTS_wp_vlp, out = [];
  const add = (id, name, ok, value, tol) => out.push({ id, name, ok: !!ok, value, tol });
  const solve = (M, o) => SY.solve(M, o);
  // X1 water column, no flow: p_bottom = p_top + ∫ρ_w(p, T)/144 dTVD on the deviated path, every well correlation
  {
    const M = S.FIX.gasWell; M.fluid.type = 'water'; M.fluid.sgw = 1.07; M.fluid.cgr = 0; M.fluid.wgr = 0;
    const F = G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F }), W = G.WTS_wp_well.build(M.well, { res: M.res });
    let worst = 0;
    ['bb', 'hb', 'gray', 'nsl', 'single'].forEach((k) => {
      const tr = V.traverse(F, W, 1e-6, { from: 'top', p0: 100, corr: k });
      if (!tr.ok) { worst = Infinity; return; }
      // independent: RK2 on the traverse's own MD / TVD stations with the fluid engine's water density
      const pr = tr.profile.filter((r) => !r.restr); let p = 100;
      for (let i = 1; i < pr.length; i++) {
        const dz = pr[i].tvd - pr[i - 1].tvd, tm = 0.5 * (pr[i].t + pr[i - 1].t);
        const r1 = F.at(p, tm).rhoW, r2 = F.at(p + r1 * dz / 144, tm).rhoW;
        p += 0.5 * (r1 + r2) * dz / 144;
      }
      worst = Math.max(worst, Math.abs(tr.pEnd - p) / (p - 100));
    });
    add('X1', 'water column, no flow, every correlation, deviated FIX.gasWell path (hydrostatic on TVD)', worst < 1e-4, worst, 1e-4);
  }
  // X2 dry gas: the marcher (gas only) vs the closed-form average T and Z, within 1 %
  {
    const M = S.FIX.gasWell; M.fluid.cgr = 0; M.fluid.wgr = 0; M.fluid.type = 'gas';
    const F = G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F }), W = G.WTS_wp_well.build(M.well, { res: M.res });
    const cf = V.gasDry(F, W, 8000, { from: 'top', p0: 1500 });
    let worst = 0;
    ['gasTZ', 'gray', 'bb', 'nsl'].forEach((k) => { const tr = V.traverse(F, W, 8000, { from: 'top', p0: 1500, corr: k }); worst = Math.max(worst, tr.ok ? Math.abs(tr.pEnd - cf.pwf) / cf.pwf : Infinity); });
    add('X2', 'dry gas: marcher (average T-Z registry entry, Gray, Beggs & Brill, no-slip) vs the closed form', worst < 0.01, worst, 0.01);
  }
  // X3 top-down vs bottom-up within 0.5 psi (oil, wet gas)
  {
    let worst = 0;
    ['oilWell', 'gasWell'].forEach((k) => {
      const M = S.FIX[k], F = G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F }), W = G.WTS_wp_well.build(M.well, { res: M.res });
      const q = k === 'oilWell' ? 900 : 7000, d = V.traverse(F, W, q, { from: 'top', p0: 500 });
      const u = V.traverse(F, W, q, { from: 'bottom', p0: d.pEnd });
      worst = Math.max(worst, Math.abs(u.pEnd - 500));
    });
    add('X3', 'direction agreement: top-down then bottom-up returns the wellhead pressure', worst < 0.5, worst, 0.5);
  }
  // X4 node independence within 0.5 % in q
  {
    let worst = 0;
    ['oilWell', 'gasWell'].forEach((k) => { const a = solve(S.FIX[k]), M = S.FIX[k]; M.system.node = 'wellhead'; const b = solve(M); worst = Math.max(worst, (a.ok && b.ok) ? Math.abs(b.op.q / a.op.q - 1) : Infinity); });
    add('X4', 'node independence: wellhead node vs bottom-hole node', worst < 0.005, worst, 0.005);
  }
  // X5 the tubing outflow is smooth on the frozen grid (second differences)
  {
    let worst = 0;
    [['gasWell', null, 7000, 20], ['gasWell', 'gray', 7000, 20], ['oilWell', 'nsl', 900, 5]].forEach(([k, c, q0, dq]) => {
      const M = S.FIX[k]; if (c) M.system.corr.well = c; M.surface.choke.present = false; M.surface.flowline = []; M.system.thp_psig = 400;
      const g = SY.evalAt(M, q0).grid, p = [];
      for (let i = 0; i < 10; i++) p.push(SY.evalAt(M, q0 + i * dq, { grid: g }).pOut);
      for (let i = 1; i < 9; i++) worst = Math.max(worst, Math.abs(p[i + 1] - 2 * p[i] + p[i - 1]));
    });
    add('X5', 'p_out(q) smooth on the frozen grid (tubing; gas Beggs & Brill / Gray, oil no-slip)', worst < 0.01, worst, 0.01);
  }
  // X6 choke continuity across the critical ratio
  {
    const find = (M, a, b) => { const ra = SY.boundary(M, a).regime; for (let k = 0; k < 60; k++) { const m = 0.5 * (a + b); if (SY.boundary(M, m).regime === ra) a = m; else b = m; } return 0.5 * (a + b); };
    let worst = 0;
    [['oilWell', 100, 900], ['gasWell', 200, 7000]].forEach(([k, a, b]) => {
      const M = S.FIX[k], q = find(M, a, b), e = 1e-6 * q;
      worst = Math.max(worst, Math.abs(SY.boundary(M, q + e).thp - SY.boundary(M, q - e).thp));
    });
    add('X6', 'choke continuity at the regime change (multiphase max rule, gas nozzle)', worst < 0.1, worst, 0.1);
  }
  // X7 breakdown sums to p̄r − p_sep
  {
    let worst = 0;
    ['oilWell', 'gasWell'].forEach((k) => { const M = S.FIX[k], R = solve(M); worst = Math.max(worst, Math.abs(R.breakdown.reduce((a, b) => a + b.dp, 0) - (M.res.pr - M.surface.psep_psig - PATM))); });
    add('X7', 'Δp breakdown sums to p̄r − p_sep', worst < 1e-6, worst, 1e-6);
  }
  // X8 root tolerance (§15.3): |Δ| < 0.1 psi or Δq < 1e-4 q at every root, on the solve's frozen grid
  {
    let worst = 0, okAll = true;
    ['oilWell', 'gasWell'].forEach((k) => {
      const M = S.FIX[k], R = solve(M);
      R.roots.forEach((r) => { const d = Math.abs(SY.evalAt(M, r.q, { grid: R.grid }).delta); worst = Math.max(worst, d); if (!(d < 0.1 || r.conv === 'x')) okAll = false; });
    });
    add('X8', 'Brent root tolerance (|Δ| < 0.1 psi or Δq < 1e-4·q)', okAll, worst, 0.1);
  }
  // X9 scan density doubling finds no new roots (§15.3)
  {
    const dbl = [0.005, 0.0071, 0.01, 0.0141, 0.02, 0.0316, 0.05, 0.0707, 0.1, 0.1643, 0.2286, 0.2929, 0.3571, 0.4214, 0.4857, 0.55,
      0.6143, 0.6786, 0.7429, 0.8071, 0.8714, 0.9357, 0.97, 0.995];
    let ok = true, worst = 0;
    const hd = S.FIX.fallingBranch; hd.res.params.J = 2; hd.res.pr = 3100;
    [S.FIX.oilWell, S.FIX.gasWell, hd].forEach((M) => {
      const a = solve(M), b = solve(M, { scanFracs: dbl });
      if (a.roots.length !== b.roots.length) ok = false;
      a.roots.forEach((r, i) => { if (b.roots[i]) worst = Math.max(worst, Math.abs(b.roots[i].q / r.q - 1)); });
    });
    add('X9', 'scan density doubling (24 points) finds the same roots', ok && worst < 1e-3, worst, 1e-3);
  }
  // X10 step convergence (§4.5, WC1): halving the step; the 100 ft default within 0.5 psi of the 25 ft march
  {
    let worst = 0, halving = 0;
    ['oilWell', 'gasWell'].forEach((k) => {
      const M = S.FIX[k], F = G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F }), W = G.WTS_wp_well.build(M.well, { res: M.res }), q = k === 'oilWell' ? 900 : 7000;
      const p = [100, 50, 25].map((s) => V.traverse(F, W, q, { from: 'top', p0: 400, stepFt: s }).pEnd);
      worst = Math.max(worst, Math.abs(p[0] - p[2])); halving = Math.max(halving, Math.abs(p[1] - p[2]));
    });
    add('X10', 'step convergence: 100 ft default vs 25 ft (and 50 ft vs 25 ft < 0.1 psi)', worst < 0.5 && halving < 0.1, worst, 0.5);
  }
  // X11 warm start = cold start on the same frozen grid
  {
    let ok = true;
    ['oilWell', 'gasWell'].forEach((k) => { const a = solve(S.FIX[k]), b = solve(S.FIX[k], { warm: a.grid }); if (a.op.q !== b.op.q) ok = false; });
    add('X11', 'warm start = cold start (identical root)', ok, ok ? 0 : 1, 0);
  }
  // X12 shut-in gas column: WTS_gradient_compute vs an RK4 integration with local Z (0.2 %); liquid column 0.433·SG·TVD (0.01 %)
  {
    let wg = 0, wl = 0;
    ['oilWell', 'gasWell'].forEach((k) => {
      const M = S.FIX[k], sh = SY.shutIn(M, { levels: [0] });
      const Mw = 28.9647 * sh.sgCol, TR = sh.tAvg + 459.67, f = (p) => p * Mw / (G.WTS_gaspvt_z({ sg: sh.sgCol, p, t: sh.tAvg }).z * 10.7316 * TR) / 144;
      let p = M.res.pr; const n = 400, h = sh.tvd / n;
      for (let i = 0; i < n; i++) { const k1 = f(p), k2 = f(p - h * k1 / 2), k3 = f(p - h * k2 / 2), k4 = f(p - h * k3); p -= h * (k1 + 2 * k2 + 2 * k3 + k4) / 6; }
      wg = Math.max(wg, Math.abs((sh.gasFilled + PATM) / p - 1));
      if (k === 'gasWell') wl = Math.abs(sh.partLiquid[0].sithp / ((M.res.pr - PATM) - (62.4 / 144) * M.fluid.sgw * sh.tvd) - 1);
    });
    add('X12', 'shut-in gas-filled column vs RK4 (0.2 %)', wg < 0.002, wg, 0.002);
    add('X13', 'shut-in liquid column vs 0.433·SG·TVD (0.01 %)', wl < 1e-4, wl, 1e-4);
  }
  // X14 critical velocity by hand (Turner / Coleman / Li) at the wellhead node of FIX.gasWell
  {
    const M = S.FIX.gasWell, R = solve(M), F = G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F, table: true }), r0 = R.traverse.profile[0], pr = F.at(r0.p, r0.t), L = R.loading.perDepth[0];
    const vc = (C) => C * Math.pow(pr.sigW, 0.25) * Math.pow(pr.rhoW - pr.rhoG, 0.25) / Math.sqrt(pr.rhoG);
    const e = Math.max(Math.abs(L.vc / vc(1.912) - 1), Math.abs(L.vcColeman / vc(1.593) - 1), Math.abs(L.vcLi / vc(0.7241) - 1));
    add('X14', 'critical velocity by hand: Turner 1.912, Coleman 1.593, Li 0.7241', e < 1e-12, e, 1e-12);
  }
  // X15 sensitivity at the base value equals the single solve exactly (§15.2, WP6)
  if (G.WTS_wp_sens && typeof G.WTS_wp_sens.job === 'function' && (G.__WP_STUBS || []).indexOf('WTS_wp_sens.job') === -1) {
    let ok = true, worst = 0;
    const runJ = (job) => { let s, n = 0; do { s = job.step(); n++; } while (!s.done && n < 500); return job.result(); };
    [['oilWell', 'wc', [20, 30, 40]], ['gasWell', 'bean', [16, 24, 32]]].forEach(([k, key, vals]) => {
      const M = S.FIX[k], R = solve(M), r = runJ(G.WTS_wp_sens.job(M, [{ key, values: vals }]));
      const b = r.cases.find((c) => c.R && !c.R.tracked && c.R.ok && r.base.inList && c.values[key] === r.base.value);
      if (!b || b.R.q !== R.op.q || b.R.pwf !== R.pwf) { ok = false; worst = Math.max(worst, b ? Math.abs(b.R.q - R.op.q) : 1); }
    });
    add('X15', 'sensitivity at the base value = the single solve (identical)', ok, worst, 0);
  }
  // X16 flowing temperature (A2, WP14): the piecewise-exact relaxation march vs an RK4 integration of the steady energy balance on the
  // deviated FIX.gasWell path (geotherm on TVD, relaxation along MD), and the large-z limit g_G·A·sinθ on a vertical hole
  if (G.WTS_wellbore && typeof G.WTS_wellbore.flowingTemp === 'function') {
    const WB = G.WTS_wellbore, M = S.FIX.gasWell, W = G.WTS_wp_well.build(M.well, { res: M.res }), mid = W.nodes.midPerfMd;
    const o = { w: 12000, cp: 0.55, U_to: 2, r_to: 2.875 / 24, rwb: 8.5 / 24, t_hr: 720, geo: { points: [[0, 70], [4000, 120], [9300, 230]] }, Tin: 240 };
    const col = { tvdAt: W.tvdAt, mdAt: W.mdAt, datumMd: mid, survey: W.stations.map((x) => [x.md, x.tvd]), segments: [] };
    const r = WB.flowingTemp(col, o), geoF = (tvd) => (tvd <= 4000 ? 70 + 50 * tvd / 4000 : 120 + 110 * (tvd - 4000) / 5300);
    const f = (md, T) => (geoF(W.tvdAt(md)) - T) / r.A;
    let T = 240, md = mid; while (md > 1e-9) { const h = Math.min(2, md), k1 = f(md, T), k2 = f(md - h / 2, T + h * k1 / 2), k3 = f(md - h / 2, T + h * k2 / 2), k4 = f(md - h, T + h * k3); T += h * (k1 + 2 * k2 + 2 * k3 + k4) / 6; md -= h; }
    const e1 = Math.abs(r.tOut - T);
    const cv = WB.column({ datumTvd: 20000, survey: [[0, 0], [20000, 20000]], strings: [{ id: 2.441, od: 2.875, topMd: 0, botMd: 20000 }] });
    const rv = WB.flowingTemp(cv, { w: 1500, cp: 0.55, U_to: 20, r_to: 2.875 / 24, rwb: 8.5 / 24, t_hr: 720, geo: { surfF: 60, gradFper100: 1.6 } });
    const e2 = Math.abs((rv.tOut - rv.teOut) - 0.016 * rv.A);
    add('X16', 'flowing temperature: relaxation march vs RK4 on the deviated path (°F), large-z limit g_G·A·sinθ', e1 < 0.02 && e2 < 1e-6, Math.max(e1, e2), 0.02);
  }
  return { ok: out.every((c) => c.ok), rows: out };
}

// ── §16 timing with evaluation counts ───────────────────────────────────────────────────────────────────────────────────
function timing(G) {
  const S = _S(), SY = G.WTS_wp_system, V = G.WTS_wp_vlp, out = [];
  const run = (job) => { let s, n = 0; do { s = job.step(); n++; } while (!s.done && n < 500); return job.result(); };
  const E = {};
  ['oilWell', 'gasWell'].forEach((k) => {
    // one fine evaluation on this fixture: warm the code paths, then the median of 7
    const M = S.FIX[k], q = k === 'oilWell' ? 900 : 7000, g = SY.evalAt(M, q).grid, t = [];
    for (let i = 0; i < 9; i++) { const t0 = nowMs(); SY.evalAt(M, q * (1 + 0.001 * i), { grid: g }); t.push(nowMs() - t0); }
    t.sort((a, b) => a - b); E[k] = t[4];
  });
  const rec = (op, fx, evals, budget, ms) => out.push({ op, fixture: fx, evals, budget, ms, eMs: E[fx], cap: 2 * E[fx] * Math.max(evals, 1), okE: budget == null || evals <= budget + 1e-9, okMs: ms <= 2 * E[fx] * Math.max(evals, 1) });
  ['oilWell', 'gasWell'].forEach((k) => {
    const M = S.FIX[k], F = G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F }), W = G.WTS_wp_well.build(M.well, { res: M.res });
    let t0 = nowMs(); V.traverse(F, W, k === 'oilWell' ? 900 : 7000, { from: 'top', p0: 400 }); rec('one traverse', k, 1, BUDGET.traverse, nowMs() - t0);
    t0 = nowMs(); const R = SY.solve(M); const ms = nowMs() - t0;
    rec('system solve (' + R.roots.length + ' root' + (R.roots.length === 1 ? '' : 's') + ' + q_s)', k, R.evals, R.roots.length > 1 ? BUDGET.solve2 : BUDGET.solve1, ms);
    t0 = nowMs(); const sh = SY.shutIn(M); const R2 = SY.solve(M); rec('page recompute (solve + shut-in + checks)', k, R2.evals, BUDGET.page, nowMs() - t0 + (G.WTS_wp_check(M) ? 0 : 0));
    void sh;
    t0 = nowMs(); const d = run(SY.designFor(M, { bean: R.op.q * 1.2 })); rec('design bean (' + d.solves + ' solves)', k, d.evals || 0, BUDGET.design, nowMs() - t0);
    t0 = nowMs(); const rows = run(SY.beanSchedule(M, M.surface.beans)); rec('bean schedule, 6 beans', k, rows.reduce((a, r) => a + (r.evals || 0), 0), BUDGET.beans6, nowMs() - t0);
    t0 = nowMs(); const mx = SY.maxRate(M); rec('maximum rate', k, mx.R.evals, BUDGET.maxRate, nowMs() - t0);
  });
  // the relaxation mode (A2, WP14): one profile per rate before the march — the evaluation budget is unchanged
  ['oilWell', 'gasWell'].forEach((k) => {
    const M = S.FIX[k]; M.well.heat.mode = 'relax';
    const t0 = nowMs(); const R = SY.solve(M);
    rec('system solve, relaxation temperature', k, R.evals, R.roots.length > 1 ? BUDGET.solve2 : BUDGET.solve1, nowMs() - t0);
  });
  {
    const M = S.FIX.oilWell; M.surface.choke.present = false; M.system.thp_psig = 300;
    const R = SY.solve(M);
    const t0 = nowMs(); const d = run(SY.designFor(M, { thp: R.op.q * 0.8 })); rec('design THP (' + d.solves + ' solves)', 'oilWell', d.evals || 0, BUDGET.design, nowMs() - t0);
  }
  const sensStub = (G.__WP_STUBS || []).indexOf('WTS_wp_sens.job') !== -1;
  if (!sensStub && G.WTS_wp_sens && typeof G.WTS_wp_sens.job === 'function') {
    const M = S.FIX.oilWell, vals = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((x) => x * 100);
    const t0 = nowMs(); const r = run(G.WTS_wp_sens.job(M, [{ key: 'wc', values: vals }]));
    const ev = r && r.cases ? r.cases.reduce((a, c) => a + ((c.R && c.R.evals) || 0), 0) : null;
    rec('sensitivity, 10 cases', 'oilWell', ev == null ? 0 : ev, BUDGET.sens10, nowMs() - t0);
  } else out.push({ op: 'sensitivity, 10 cases', fixture: 'oilWell', evals: null, budget: BUDGET.sens10, ms: null, okE: true, okMs: true, note: 'WTS_wp_sens not merged (WP6)' });
  return { ok: out.every((r) => r.okE), okMs: out.every((r) => r.okMs), rows: out, E, baselineEms: _S().BASELINE.E_ms };
}

function _fmt(v, d) { return v == null || !isFinite(v) ? '—' : (Math.abs(v) < 1e-3 && v !== 0 ? v.toExponential(2) : v.toFixed(d == null ? 2 : d)); }

async function main() {
  const doGate = flag('--gate'), doCheck = flag('--check') || (!doGate && !flag('--time')), doTime = flag('--time') || (!doGate && !flag('--check'));
  const t0 = nowMs();
  const app = _load(), G = app.win;
  console.log('[wellperf-validate] app loaded from ' + (flag('--html') ? 'the built HTML' : 'sources') + ' in ' + (nowMs() - t0).toFixed(0) + ' ms');
  const summary = { gate: null, checks: null, timing: null };
  let fail = false;
  if (doGate || doCheck) {
    const g = gate(G); summary.gate = g;
    console.log('\nProvisional-label gate (D17, §15.1): ' + (g.ok ? 'PASS' : 'FAIL'));
    g.rows.forEach((r) => console.log('  ' + (r.verified ? 'verified   ' : 'provisional') + '  ' + (r.kind + ' ' + r.key).padEnd(22) + r.status.padEnd(9) + r.source));
    g.errors.forEach((e) => console.log('  FAIL ' + e));
    if (!g.ok) fail = true;
  }
  if (doCheck) {
    const c = checks(G); summary.checks = c;
    console.log('\nCross-checks (§15.2, §15.3):');
    c.rows.forEach((r) => console.log('  ' + (r.ok ? 'PASS' : 'FAIL') + '  ' + r.id.padEnd(4) + r.name + '  [' + _fmt(r.value, 4) + ' / tol ' + _fmt(r.tol, 4) + ']'));
    console.log('  ' + c.rows.filter((r) => r.ok).length + ' / ' + c.rows.length + ' checks pass');
    if (!c.ok) fail = true;
  }
  if (doTime) {
    const t = timing(G); summary.timing = t;
    console.log('\nEvaluation budgets (§16; E = one fine traverse + flowline + choke; measured E here: oil ' + _fmt(t.E.oilWell, 1) + ' ms, wet gas ' + _fmt(t.E.gasWell, 1) + ' ms; WP0 baseline ' + t.baselineEms + ' ms):');
    console.log('  ' + 'operation'.padEnd(46) + 'fixture'.padEnd(10) + 'E'.padStart(7) + ' budget'.padStart(8) + 'ms'.padStart(9) + ' cap ms'.padStart(9) + '  result');
    t.rows.forEach((r) => console.log('  ' + r.op.padEnd(46) + r.fixture.padEnd(10) + _fmt(r.evals, 1).padStart(7) + String(r.budget == null ? '—' : r.budget).padStart(8) + _fmt(r.ms, 0).padStart(9) + _fmt(r.cap, 0).padStart(9) +
      '  ' + (r.note ? 'n/a (' + r.note + ')' : (r.okE ? 'E ok' : 'E OVER') + (r.okMs ? ', ms ok' : ', ms over cap'))));
    if (!t.ok) fail = true;
    if (!t.okMs && flag('--strict')) fail = true;
  }
  if (flag('--json')) console.log(JSON.stringify(summary, (k, v) => (typeof v === 'function' ? undefined : v)));
  console.log('\n[wellperf-validate] ' + (fail ? 'FAIL' : 'ok') + ' (' + ((nowMs() - t0) / 1000).toFixed(1) + ' s)');
  if (app.dispose) try { app.dispose(); } catch (_) { /* ignore */ }
  return fail ? 1 : 0;
}

module.exports = { gate, checks, timing, BENCH, BUDGET, PROVISIONAL };
if (require.main === module) main().then((c) => process.exit(c), (e) => { console.error('[wellperf-validate] crash: ' + (e && e.stack || e)); process.exit(2); });
void path;
