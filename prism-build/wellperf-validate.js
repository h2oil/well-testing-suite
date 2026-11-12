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
  // WP12 (A2): Q9 — no books, so both ship provisional; the chart readings of Duns & Ros are pinned to their own values (wellperf-vlp2)
  { kind: 'corr', key: 'dr', status: 'pending', source: 'Brill & Mukherjee (Duns & Ros traverse), ±3 % on Δp' },
  { kind: 'corr', key: 'gasCS', status: 'pending', source: 'Economides et al.; Brill & Mukherjee (Cullender-Smith), ±1 %' },
  // WP21 (B): Q9 — no books, so all five ship provisional; their explicit equations are pinned by hand calculations (wellperf-vlp3)
  { kind: 'corr', key: 'ork', status: 'pending', source: 'Brill & Mukherjee §4.2.3; Brown vol. 1 (Orkiszewski traverse), ±3 % on Δp' },
  { kind: 'corr', key: 'agf', status: 'pending', source: 'Brill & Mukherjee §4.2.5 (Aziz, Govier & Fogarasi traverse), ±3 % on Δp' },
  { kind: 'corr', key: 'mb', status: 'pending', source: 'Brill & Mukherjee §4.3.3; Mukherjee & Brill (1985) example, ±3 % on Δp' },
  { kind: 'corr', key: 'ansari', status: 'pending', source: 'Brill & Mukherjee §4.4 (Ansari et al. 1994 example), ±3 % on Δp' },
  { kind: 'corr', key: 'hk', status: 'pending', source: 'Hasan & Kabir, Fluid Flow and Heat Transfer in Wellbores ch. 4 (drift-flux example), ±3 % on Δp' },
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
  // B (WP22)
  { kind: 'temp', key: 'enthalpy', status: 'pending', source: 'Alves, Alhanati & Shoham (1992) unified wellbore temperature model; Hasan & Kabir — no verifiable published traverse (Q9); identities X40–X42 only' },
  // A2
  { kind: 'lift', key: 'glpc', status: 'pending', source: 'Takacs, Gas Lift Manual (GLPC), ±3 % — a B item; A2 checks the point of balance and the natural-flow identity only' },
  // B (WP23): PVT lab match (least squares — needs no published example), the differential → flash adjustment, the modified black oil
  // and the emulsion viscosity (Q9: no books → provisional, never a default)
  { kind: 'pvt', key: 'pvtmatch', status: 'pinned', source: 'least squares on the user\'s lab points; LM = closed-form weighted least squares (X22)' },
  { kind: 'pvt', key: 'diffFlash', status: 'pending', source: 'McCain, The Properties of Petroleum Fluids (differential to flash adjustment) — algebra pinned (wellperf-pvtmatch PM1)' },
  { kind: 'pvt', key: 'rv', status: 'pending', source: 'modified black oil with an Rv table (Whitson & Torp; Coats) — mass balance X23 only' },
  { kind: 'pvt', key: 'woelflin', status: 'pending', source: 'Woelflin (1942) emulsion curves — chart readings to verify against the figure' },
  { kind: 'pvt', key: 'brinkman', status: 'pending', source: 'Brinkman (1952) suspension viscosity — closed form only' },
  { kind: 'pvt', key: 'table', status: 'pinned', source: 'user emulsion table (user data)' },
  // B (WP24): the increment-B inflow models — Q9, no books, all pending (provisional, never a default)
  { kind: 'ipr', key: 'wcComposite', status: 'pending', source: 'Brown, The Technology of Artificial Lift Methods vol. 4 / Ahmed (water-cut-weighted composite), ±1 %' },
  { kind: 'ipr', key: 'joshi', status: 'pending', source: 'Joshi (1988); Economides et al. (horizontal well, anisotropy form), ±1 %' },
  { kind: 'ipr', key: 'babuOdeh', status: 'pending', source: 'Babu & Odeh (1989) worked example; Economides et al., ±1 %' },
  { kind: 'ipr', key: 'furui', status: 'pending', source: 'Furui, Zhu & Hill (2003); Economides et al., ±1 %' },
  { kind: 'ipr', key: 'frac', status: 'pending', source: 'Cinco-Ley & Samaniego (1981) F_cD curve; Economides et al. (closed-form fit), ±2 %' },
  { kind: 'ipr', key: 'fracGas', status: 'pending', source: 'as frac, gas form (Darcy gas with s_f)' },
  { kind: 'ipr', key: 'transient', status: 'pending', source: 'Lee / Earlougher line-source log approximation — cross-checked against the exponential-integral solution (X30) only' },
  { kind: 'ipr', key: 'multilayer', status: 'pending', source: 'commingled layers with crossflow (Economides et al.) — mass balance and single-layer identities (X31) only' },
  { kind: 'ipr', key: 'injector', status: 'pending', source: 'injectivity index with a fracture limit (Economides et al.) — closure and march identities (X32, X33) only' },
  { kind: 'choke', key: 'sachdeva', status: 'pending', source: 'Brill & Mukherjee, choke chapter (Sachdeva et al. 1986), ±3 % — limits checked: isentropic gas, incompressible liquid' },
  // B (WP20): a table export is a format, not a method — no published example applies; the gate checks that the table carries the
  // provisional label of every unverified method it used and changes no default (the round trip and the solver identity are X43–X46)
  { kind: 'export', key: 'liftTable', status: 'format', source: 'lift-curve table text format (producer / injector) + CSV — round-trip parser, solver identity (X43–X45)' },
  { kind: 'export', key: 'pvtTable', status: 'format', source: 'PVT table CSV + black-oil PVT table text format — the fluid engine\'s rows, round trip (X46)' },
  // B (WP27): the depletion-forecast tank models and the lift-screening ranges — no published example checked (Q9); closed-form and
  // material-balance identities only (X49 / X50), so they ship provisional and the tank is never the default forecast mode
  { kind: 'forecast', key: 'gasTank', status: 'pending', source: 'volumetric gas p/Z material balance (e.g. Craft & Hawkins) — closed form X49 only' },
  { kind: 'forecast', key: 'oilTank', status: 'pending', source: 'Havlena & Odeh (1963) straight line with Corey gas flow above S_gc — identity X50 only' },
  { kind: 'screen', key: 'lift', status: 'pending', source: 'Brown (1982); Clegg, Bucaram & Hein (1993) — indicative screening ranges' },
  // B (WP25): the gas-lift design is the existing API RP 11V6 engine (49-calc-gaslift.js, pinned by calc-gaslift against an independent
  // RK4 gas column) on the shared model (identity X55); the valve throughput and the stability numbers have no checked example (Q9)
  { kind: 'lift', key: 'glDesign', status: 'pinned', source: 'API RP 11V6 spacing — calc-gaslift tests (independent RK4 gas column); vertical-path identity X55' },
  { kind: 'lift', key: 'thornhillCraver', status: 'pending', source: 'Thornhill & Craver; API RP 11V2, Brown vol. 2a — no worked example checked (Q9); isentropic-nozzle cross-check X54 only' },
  { kind: 'lift', key: 'asheim', status: 'pending', source: 'Asheim (1988) gas-lift stability criteria — written from the lumped model, coefficients not checked (Q9); identities X57 only' },
  // B (WP26): the ESP — the affinity laws are exact similarity relations (pinned: X60); the viscosity correction, the natural separation,
  // the gas criterion and the motor / cable basics have no checked published example (Q9: Takacs, Electrical Submersible Pumps Manual)
  { kind: 'esp', key: 'affinity', status: 'pinned', source: 'affinity laws q ∝ f, H ∝ f², P ∝ f³ — exact (X60, wellperf-esp ES2)' },
  { kind: 'esp', key: 'turzo', status: 'pending', source: 'Turzo, Takacs & Zsuga (2000); Takacs, Electrical Submersible Pumps Manual — coefficients to verify (Q9); water identity only' },
  { kind: 'esp', key: 'alhanati', status: 'pending', source: 'Alhanati (1993) natural separation (simplified v∞ / (v∞ + v_SL)); Takacs ESP manual, ±3 % — hand check only' },
  { kind: 'esp', key: 'turpin', status: 'pending', source: 'Turpin, Lea & Bearden (1986) gas-handling criterion — closed form only' },
  { kind: 'esp', key: 'motor', status: 'pending', source: 'motor load and copper cable voltage drop (basics) — hand check only' },
];

// §16: evaluation budgets (E = one fine well traverse + flowline march + choke; a coarse evaluation = ½ E)
const BUDGET = {
  traverse: 1, solve1: 20, solve2: 24, solveEnth1: 30, solveEnth2: 34, page: 26, design: 60, beans6: 50, maxRate: 24, sens10: 80, sens2x10: 160, glpc12: 200,
  lift800: 800, lift3200: 3200,          // B (WP20): one traverse per lift-table point (§9: 3,200 points ≤ 60 s)
  // B (WP27): the envelope (one solve + ≈ 22 marches with the flowline), a 24-step forecast, the tornado (one solve + ≤ 8 E per case),
  // the 3 × 3 × 3 × 3 matrix, the lift screening (one solve + the short performance curve), two cases compared (a cold solve each)
  envelope: 60, forecast24: 160, tornadoPerCase: 8, matrix81: 500, screening: 120, cases2: 48,
  // B (WP25): the gas-lift valve design (marches of the RP 11V6 engine on the model path, each ≤ 1 E: the traverses below and above the
  // point of injection, the GLR bisection and the spacing) and the diagnosis of a test (two marches)
  glDesign: 120, glDiag: 3,
  // B (WP26): ESP stage sizing (≤ 3 evaluations at the target rate) and the rate-against-frequency Job (7 tracking solves ≈ like the bean schedule)
  espSize: 3, espSweep7: 70,
};
const LIFT3200_MS = 60000;               // §16: the 3,200-point lift table within 60 s in the container

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
    const secs = D.system && D.system.corr && D.system.corr.sections;
    if (secs && secs.length) bad('default sections', 'the default model carries per-section correlations (none is the default, D17)');
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
  // 5b. the enthalpy-balance temperature (B, WP22): pending → R.heat carries the label and verified:false, never the default
  const te = benchOf('temp', 'enthalpy');
  if (te && G.WTS_wp_well && typeof G.WTS_wp_well.enthalpy === 'function') {
    const Me = S.FIX.gasWell; Me.well.heat.mode = 'enthalpy';
    const Re = G.WTS_wp_system.solve(Me), pend = te.status === 'pending';
    if (!Re.ok || !Re.heat || Re.heat.mode !== 'enthalpy') bad('temp enthalpy', 'no enthalpy result on FIX.gasWell');
    else if (pend && (Re.heat.verified !== false || Re.heat.provisional !== PROVISIONAL || !Re.flags.some((x) => x.code === 'PROVISIONAL_TEMP'))) bad('temp enthalpy', 'pending without the provisional label');
    if (pend && D && D.well && D.well.heat && D.well.heat.mode === 'enthalpy') bad('temp enthalpy', 'a pending method is the default temperature model');
  }
  // 6. the choke model (A2, WP15): pending → verified:false, the provisional label on every flag / validity line, never the default
  const SD = G.WTS_chokeperf_SACHDEVA, bS = benchOf('choke', 'sachdeva');
  if (SD) {
    const okS = bS && (bS.status === 'verified' || bS.status === 'pinned');
    if (!!SD.verified !== !!okS) bad('choke sachdeva', 'registry verified=' + SD.verified + ' but BENCH status ' + (bS && bS.status));
    if (!SD.verified) {
      if (D && D.surface && D.surface.choke && D.surface.choke.corr === 'sachdeva') bad('choke sachdeva', 'is the default choke model');
      if (D && D.surface && D.surface.choke && D.surface.choke.subcritical !== 'bound') bad('choke sachdeva', 'the sub-critical default is not the A1 bound (subcritical ' + JSON.stringify(D.surface.choke.subcritical) + ')');
      const M0 = S.FIX.oilWell; M0.surface.choke.bean64 = 64; delete M0.surface.choke.subcritical;
      const R0 = G.WTS_wp_system.solve(M0);
      if (!R0.ok || !R0.surface || !R0.surface.choke || R0.surface.choke.model) bad('choke sachdeva', 'a model without surface.choke.subcritical runs on the Sachdeva branch (model ' + (R0.surface && R0.surface.choke && R0.surface.choke.model) + ')');
      const Mc = S.FIX.oilWell; Mc.surface.choke.bean64 = 64; Mc.surface.choke.subcritical = 'sachdeva';
      const Rc = G.WTS_wp_system.solve(Mc), f = (Rc.flags || []).find((x) => x.code === 'CHOKE_SUBCRITICAL');
      if (!f || f.msg.indexOf(PROVISIONAL) === -1) bad('choke sachdeva', 'the sub-critical flag does not carry the provisional label');
      const vv = (G.WTS_wp_check(Mc).validity || []).find((x) => x.corr === 'sachdeva');
      if (!vv || vv.provisional !== true) bad('choke sachdeva', 'check validity does not mark it provisional');
    }
    rows.push({ kind: 'choke', key: 'sachdeva', label: SD.label, verified: !!SD.verified, status: bS ? bS.status : 'missing', source: bS ? bS.source : '' });
  }
  // 7. B (WP23): the PVT methods — registry flags agree with BENCH, provisional ones are labelled where they are used and never a default
  const PM = G.WTS_wp_pvtmatch && G.WTS_wp_pvtmatch.METHODS;
  if (PM) {
    Object.keys(PM).forEach((k) => {
      const e = PM[k], b = benchOf('pvt', k);
      if (!b) { bad('pvt ' + k, 'no §15.1 entry in BENCH'); return; }
      const okV = b.status === 'verified' || b.status === 'pinned';
      if (!!e.verified !== okV) bad('pvt ' + k, 'registry verified=' + e.verified + ' but BENCH status ' + b.status);
      if (!e.verified && e.provisional !== PROVISIONAL) bad('pvt ' + k, 'no provisional label');
      rows.push({ kind: 'pvt', key: k, label: e.label, verified: !!e.verified, status: b.status, source: b.source });
    });
    if (D && D.fluid && D.fluid.rv && D.fluid.rv.mode !== 'none') bad('pvt rv', 'the modified black oil is the default');
    if (D && D.fluid && D.fluid.emul && D.fluid.emul.model !== 'none') bad('pvt emulsion', 'an emulsion model is the default');
    const Mg = S.FIX.gasWell; Mg.fluid.rv = { mode: 'table', pd: 4200, rows: G.WTS_wp_pvtmatch.exampleRv(20, 4200) };
    const vr = (G.WTS_wp_check(Mg).validity || []).find((x) => x.corr === 'rv');
    if (!vr || vr.msg.indexOf(PROVISIONAL) === -1) bad('pvt rv', 'the check validity does not carry the provisional label');
    ['woelflin', 'brinkman'].forEach((m) => {
      const Mo = S.FIX.oilWell; Mo.fluid.emul = { model: m, tight: 'medium', inv: 0.6 };
      const ve = (G.WTS_wp_check(Mo).validity || []).find((x) => x.corr === 'emulsion');
      if (!ve || ve.msg.indexOf(PROVISIONAL) === -1) bad('pvt ' + m, 'the check validity does not carry the provisional label');
    });
  }
  // 8. the increment-B inflow models (WP24): each one in use is named provisional in the check validity (page + report), and the
  // injector is solved through WTS_wp_inj with its provisional flag
  (G.WTS_wp_ipr && G.WTS_wp_ipr.B_KEYS || []).forEach((k) => {
    const e = IP[k]; if (!e) { bad('ipr ' + k, 'increment-B model missing from the registry'); return; }
    const Mb = S.FIX.oilWell; Mb.res.model = k;
    const v = (G.WTS_wp_check(Mb).validity || []).find((x) => x.corr === k);
    if (!e.verified && (!v || v.provisional !== true)) bad('ipr ' + k, 'check validity does not mark it provisional');
  });
  if (G.WTS_wp_inj) {
    const Mi = S.FIX.oilWell; Mi.fluid.type = 'waterinj'; Mi.res = { model: 'injector', pr: 3000, T_F: 200, params: { II: 5, pfrac: 4500 }, points: [], layers: [] }; Mi.system.thp_psig = 1000; Mi.surface.choke.present = false;
    const Ri = G.WTS_wp_system.solve(Mi);
    if (!Ri.ok || !Ri.injector || !(Ri.flags || []).some((f) => f.code === 'PROVISIONAL_INJ' && f.msg.indexOf(PROVISIONAL) !== -1)) bad('ipr injector', 'the injector solve does not carry the provisional flag');
  }
  // 9. the exports (B, WP20): a lift table built with a provisional correlation (and a PVT table with a provisional family) carries the
  // label in its notes and in the text header; the export changes no default; on the default model the table carries none
  const XP = G.WTS_wp_export;
  if (XP && typeof XP.liftTable === 'function') {
    const sp = { flo: { type: 'OIL', values: [300, 900] }, thp: [300], wfr: { type: 'WCT', values: [0.3] }, gfr: { type: 'GOR', values: [0.5] }, alq: { type: '', values: [0] } };
    const T0 = XP.liftTable(S.FIX.oilWell, sp);
    if (!T0.ok) bad('export liftTable', 'the default oil table failed: ' + (T0.errors || []).join('; '));
    else if (T0.provisional.length || XP.text(T0).indexOf(PROVISIONAL) !== -1) bad('export liftTable', 'the default model (verified Beggs & Brill) carries a provisional label');
    const Mh = S.FIX.oilWell; Mh.system.corr.well = 'hb';
    const T1 = XP.liftTable(Mh, sp);
    if (!T1.ok || !T1.provisional.some((p) => p.indexOf(PROVISIONAL) !== -1) || XP.text(T1).indexOf(PROVISIONAL) === -1) bad('export liftTable', 'a provisional correlation is not labelled in the table');
    if (D && D.system && D.system.corr && D.system.corr.well && REG[D.system.corr.well] && REG[D.system.corr.well].verified !== true) bad('export liftTable', 'the model default well correlation is provisional');
    const Mv = S.FIX.oilWell; Mv.fluid.corr.pb = 'vasquezBeggs'; Mv.fluid.corr.rs = 'vasquezBeggs'; Mv.fluid.corr.bo = 'vasquezBeggs';
    const Pv = XP.pvtTable(Mv), P0 = XP.pvtTable(S.FIX.oilWell);
    if (!Pv.ok || XP.pvtText(Pv).indexOf(PROVISIONAL) === -1) bad('export pvtTable', 'a provisional PVT family is not labelled in the PVT text table');
    if (!P0.ok || XP.pvtText(P0).indexOf(PROVISIONAL) !== -1) bad('export pvtTable', 'the default (Standing) PVT table carries a provisional label');
    ['liftTable', 'pvtTable'].forEach((k) => { const b = benchOf('export', k); rows.push({ kind: 'export', key: k, label: k, verified: true, status: b ? b.status : 'missing', source: b ? b.source : '' }); });
  }
  // 10. the forecast tank models and the lift screening (B, WP27): pending → verified:false, the provisional label, never the default
  const FC = G.WTS_wp_forecast, SCR = G.WTS_wp_screen;
  if (FC && typeof FC.tank === 'function') {
    const pend = (k) => { const b = benchOf('forecast', k); return !b || b.status === 'pending'; };
    const tg = FC.tank(S.FIX.gasWell, { G_Bscf: 20 }), to = FC.tank(S.FIX.oilWell, { N_MMstb: 20 });
    if (pend('gasTank') && (!tg.ok || tg.verified !== false || tg.provisional !== PROVISIONAL)) bad('forecast gasTank', 'pending without the provisional label');
    if (pend('oilTank') && (!to.ok || to.verified !== false || to.provisional !== PROVISIONAL)) bad('forecast oilTank', 'pending without the provisional label');
    if ((pend('gasTank') || pend('oilTank')) && FC.DEFAULT_MODE !== 'steps') bad('forecast', 'a pending tank model is the default forecast mode');
  }
  if (SCR && typeof SCR.matrix === 'function') {
    const b = benchOf('screen', 'lift'), m = SCR.matrix(S.FIX.oilWell, {});
    if ((!b || b.status === 'pending') && (!m.ok || m.verified !== false || m.provisional !== PROVISIONAL)) bad('screen lift', 'pending without the provisional label');
  }
  // 11. the gas-lift throughput and stability numbers (B, WP25): pending → verified:false and the provisional label where they are shown
  const GLB = G.WTS_wp_gl;
  if (GLB && typeof GLB.tc === 'function') {
    const pend = (k) => { const b = benchOf('lift', k); return !b || b.status === 'pending'; };
    if (pend('thornhillCraver') && GLB.TC.verified !== false) bad('lift thornhillCraver', 'pending but the registry says verified');
    const Ml = S.FIX.oilWell; Ml.fluid.wc = 0.6; Ml.res.pr = 2600; Ml.lift = { type: 'gaslift', gl: { qinj_Mscfd: 800, pinj_psig: 1200, sginj: 0.65, dpValve: 100, packerMd: 7800 } };
    const Rl = G.WTS_wp_system.solve(Ml), a = GLB.asheim(Ml, Rl, { port64: 16 });
    if (pend('asheim') && (!a.ok || a.verified !== false || a.provisional !== PROVISIONAL)) bad('lift asheim', 'pending without the provisional label');
    let s0, j = GLB.design(Ml, Rl), n0 = 0; do { s0 = j.step(); n0++; } while (!s0.done && n0 < 20);
    const Dl = j.result();
    if (pend('thornhillCraver') && (!Dl.ok || !Dl.warnings.some((w) => w.code === 'TC_PROVISIONAL' && w.msg.indexOf(PROVISIONAL) !== -1))) bad('lift thornhillCraver', 'the design does not carry the provisional note');
  }
  // 12. the ESP (B, WP26): the method flags agree with BENCH, a pending method is labelled provisional where it is used (the solve's flags
  // and the check validity), and the default lift type stays natural flow
  const EP = G.WTS_wp_esp;
  if (EP && EP.METHODS) {
    Object.keys(EP.METHODS).forEach((k) => {
      const e = EP.METHODS[k], b = benchOf('esp', k);
      if (!b) { bad('esp ' + k, 'no §15.1 entry in BENCH'); return; }
      const okV = b.status === 'verified' || b.status === 'pinned';
      if (!!e.verified !== okV) bad('esp ' + k, 'registry verified=' + e.verified + ' but BENCH status ' + b.status);
      rows.push({ kind: 'esp', key: k, label: e.label, verified: !!e.verified, status: b.status, source: b.source });
    });
    if (D && D.lift && D.lift.type !== 'none') bad('esp', 'the default lift type is not natural flow');
    const Me = S.FIX.oilWell; Me.res.pr = 2200; Me.fluid.wc = 0.6; Me.lift = { type: 'esp', gl: {}, esp: { pump: EP.example(), pumpMd: 7900, stages: 120 } };
    const Re = G.WTS_wp_system.solve(Me), ck = G.WTS_wp_check(Me);
    if (!Re.ok || !(Re.flags || []).some((x) => x.code === 'PROVISIONAL_ESP' && x.msg.indexOf(PROVISIONAL) !== -1)) bad('esp', 'a provisional ESP method in use is not labelled in the solve');
    if (!(ck.validity || []).some((v) => /^esp_/.test(v.corr) && v.provisional && v.msg.indexOf(PROVISIONAL) !== -1)) bad('esp', 'the check validity does not label the provisional ESP methods');
  }
  BENCH.filter((b) => b.kind === 'loading' || b.kind === 'system' || b.kind === 'well' || b.kind === 'temp' || b.kind === 'lift' || b.kind === 'forecast' || b.kind === 'screen').forEach((b) => rows.push({ kind: b.kind, key: b.key, label: b.key, verified: b.status !== 'pending', status: b.status, source: b.source }));
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
    ['bb', 'hb', 'gray', 'nsl', 'single', 'dr', 'ork', 'agf', 'mb', 'ansari', 'hk'].forEach((k) => {
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
    add('X1', 'water column, no flow, every correlation (incl. the five B correlations), deviated FIX.gasWell path (hydrostatic on TVD)', worst < 1e-4, worst, 1e-4);
  }
  // X2 dry gas: the marcher (gas only) vs the closed-form average T and Z, within 1 %
  {
    const M = S.FIX.gasWell; M.fluid.cgr = 0; M.fluid.wgr = 0; M.fluid.type = 'gas';
    const F = G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F }), W = G.WTS_wp_well.build(M.well, { res: M.res });
    const cf = V.gasDry(F, W, 8000, { from: 'top', p0: 1500 });
    let worst = 0;
    ['gasTZ', 'gray', 'bb', 'nsl', 'dr', 'gasCS', 'ork', 'agf', 'mb', 'ansari', 'hk'].forEach((k) => { const tr = V.traverse(F, W, 8000, { from: 'top', p0: 1500, corr: k }); worst = Math.max(worst, tr.ok ? Math.abs(tr.pEnd - cf.pwf) / cf.pwf : Infinity); });
    add('X2', 'dry gas: marcher (average T-Z and Cullender-Smith entries, Gray, Beggs & Brill, no-slip, Duns & Ros; B: Orkiszewski, AGF, Mukherjee-Brill, Ansari, Hasan-Kabir) vs the closed form', worst < 0.01, worst, 0.01);
    // X16 (A2, WP12): the Cullender-Smith closed form vs the average T-Z closed form (1 %) and its bottom-up inverse (0.05 psi)
    if (typeof V.gasCS === 'function') {
      const cs = V.gasCS(F, W, 8000, { from: 'top', p0: 1500 }), up = cs.ok ? V.gasCS(F, W, 8000, { from: 'bottom', p0: cs.pwf }) : null;
      const e = cs.ok ? Math.abs(cs.pwf / cf.pwf - 1) : Infinity, inv = up && up.ok ? Math.abs(up.pEnd - 1500) : Infinity;
      add('X16', 'dry gas: Cullender-Smith closed form vs average T-Z (and its bottom-up inverse within 0.05 psi), deviated FIX.gasWell', e < 0.01 && inv < 0.05, e, 0.01);
    }
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
      const M = S.FIX[k]; if (k === 'oilWell') M.surface.choke.subcritical = 'sachdeva';   // the provisional option (the default is the bound, X6b)
      const q = find(M, a, b), e = 1e-6 * q;
      worst = Math.max(worst, Math.abs(SY.boundary(M, q + e).thp - SY.boundary(M, q - e).thp));
    });
    add('X6', 'choke continuity at the regime change (multiphase Sachdeva-scaled option, gas nozzle)', worst < 0.1, worst, 0.1);
    let wb = 0;
    [['oilWell', 'bound', 100, 900], ['oilWell', 'sachdeva', 150, 3000]].forEach(([k, mode, a, b]) => {
      const M = S.FIX[k]; if (mode === 'bound') M.surface.choke.subcritical = 'bound'; else M.surface.choke.corr = 'sachdeva';
      const q = find(M, a, b), e = 1e-6 * q;
      wb = Math.max(wb, Math.abs(SY.boundary(M, q + e).thp - SY.boundary(M, q - e).thp));
    });
    add('X6b', 'choke continuity: the A1 bound (subcritical \'bound\') and the Sachdeva model alone', wb < 0.1, wb, 0.1);
  }
  // X20 (§15.3, A2; X16 on its branch) the Sachdeva critical-ratio fixed point converges in ≤ 30 iterations over the input grid
  if (typeof G.WTS_chokeperf_sachdeva === 'function') {
    let worst = 0, ok = true;
    [1e-4, 1e-3, 0.01, 0.05, 0.2, 0.5, 0.9, 0.999, 1].forEach((x1) => [1.1, 1.3, 1.6].forEach((k) => [[50, 0.5], [55, 5], [62, 25]].forEach(([rL, rG]) => {
      const r = G.WTS_chokeperf_sachdeva({ s64: 32, p1a: 1500, p2a: 100, x1, rhoL: rL, rhoG1: rG, k, sg: 0.7 });
      if (!r.ok || !r.converged || !(r.yc > 0 && r.yc < 1)) ok = false;
      worst = Math.max(worst, r.it || 0);
    })));
    add('X20', 'Sachdeva critical ratio: fixed point ≤ 30 iterations over the input grid (81 cases)', ok && worst <= 30, worst, 30);
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
    // X17 (A2, WP16) two variables: the start cell (both model values) = the single solve exactly
    const M = S.FIX.oilWell, R = solve(M), r2 = runJ(G.WTS_wp_sens.job(M, [{ key: 'wc', values: [20, 30, 40] }, { key: 'pr', values: [2800, 3000] }]));
    const c = r2.ok && r2.cases.find((x) => x.values.wc === 30 && x.values.pr === 3000);
    add('X17', 'two-variable sensitivity: the start cell = the single solve (identical)', !!(c && c.R.q === R.op.q && c.R.pwf === R.pwf), c ? Math.abs(c.R.q - R.op.q) : 1, 0);
  }
  // X18 (A2, WP18) gas lift at q_inj = 0 equals natural flow exactly (§15.2); the point of balance p_cas − ΔP_valve = p_tub
  if (G.WTS_wp_gl && typeof G.WTS_wp_gl.glpc === 'function') {
    const Mn = S.FIX.oilWell, Rn = solve(Mn), M0 = S.FIX.oilWell; M0.lift = { type: 'gaslift', gl: { qinj_Mscfd: 0, pinj_psig: 1200 } };
    const R0 = solve(M0);
    add('X18', 'gas lift at q_inj = 0 = natural flow (identical)', R0.op.q === Rn.op.q && R0.pwf === Rn.pwf, Math.abs(R0.op.q - Rn.op.q), 0);
    const Ml = S.FIX.oilWell; Ml.fluid.wc = 0.6; Ml.res.pr = 2600; Ml.lift = { type: 'gaslift', gl: { qinj_Mscfd: 500, pinj_psig: 1200, sginj: 0.65, dpValve: 100, packerMd: 7800 } };
    const Rl = solve(Ml), e = Rl.ok && Rl.lift ? Math.abs(Rl.lift.pCas - 100 - Rl.lift.pTub) : Infinity;
    add('X19', 'gas lift: point of balance p_cas − ΔP_valve = p_tub at the injection depth (psi)', e < 1, e, 1);
  }
  // X21 flowing temperature (A2, WP14; X16 on its branch): the piecewise-exact relaxation march vs an RK4 integration of the steady energy balance on the
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
    add('X21', 'flowing temperature: relaxation march vs RK4 on the deviated path (°F), large-z limit g_G·A·sinθ', e1 < 0.02 && e2 < 1e-6, Math.max(e1, e2), 0.02);
  }
  // X22 (B, WP23) the PVT lab match: PRiSM_lm = the closed-form relative weighted least squares on every property of the example lab
  // table, and the matched pb equals the lab pb (Rs and the factor solved together)
  if (G.WTS_wp_pvtmatch) {
    const P = G.WTS_wp_pvtmatch, sp = { type: 'oil', api: 35, sgg: 0.75, gor: 600, psep_psig: 100, tsep_F: 80 }, lab = P.example(sp, 200), r = P.fit(sp, lab);
    let worst = r.ok ? 0 : Infinity;
    if (r.ok) Object.keys(r.props).forEach((k) => { const q = r.props[k], cf = P.wls(q.yc, q.y, q.fixedB); worst = Math.max(worst, Math.abs(q.a / cf.a - 1), Math.abs(q.b - cf.b) / Math.max(1, Math.abs(cf.b))); });
    const ep = r.ok ? Math.abs(r.pb.after / lab.pb - 1) : Infinity;
    add('X22', 'PVT lab match: LM = closed-form weighted least squares (a, b of Rs / Bo / μo); matched pb = lab pb (1e-4)', worst < 1e-6 && ep < 1e-4, worst, 1e-6);
    // X23 modified black oil: total mass flow equal at the top and bottom of the deviated FIX.gasWell traverse (and at every station)
    const Mg = S.FIX.gasWell; Mg.fluid.rv = { mode: 'table', pd: 4200, rows: P.exampleRv(20, 4200) };
    const F = G.WTS_wp_fluid.build(Mg.fluid, { T_F: Mg.res.T_F }), W = G.WTS_wp_well.build(Mg.well, { res: Mg.res }), tr = V.traverse(F, W, 7000, { from: 'top', p0: 1500 });
    let wm = tr.ok ? 0 : Infinity, m0 = null;
    if (tr.ok) tr.profile.filter((x) => !x.restr).forEach((x) => { const a = F.at(x.p, x.t, 7000), m = a.qL * a.rhoL + a.qG * a.rhoG; if (m0 == null) m0 = m; wm = Math.max(wm, Math.abs(m / m0 - 1)); });
    add('X23', 'modified black oil (Rv): mass flow constant along the deviated FIX.gasWell traverse', wm < 1e-9, wm, 1e-9);
    // X24 identity: a match with a = 1, b = 0, f = 1 and the emulsion / Rv set to none solve exactly as the A2 model
    const Mi = S.FIX.oilWell, R0 = SY.solve(Mi); Mi.fluid.match = { on: true, pbFactor: 1, mult: { rs: 1, bo: 1, muo: 1 }, shift: { rs: 0, bo: 0, muo: 0 }, corr: { rs: 'standing', bo: 'standing', muod: 'beggsRobinson', muo: 'beggsRobinson' } };
    Mi.fluid.rv = { mode: 'none' }; Mi.fluid.emul = { model: 'none' };
    const R1 = SY.solve(Mi);
    add('X24', 'unit match (a = 1, b = 0, f = 1) and no Rv / emulsion = the A2 solve (identical)', R0.ok && R1.ok && R0.op.q === R1.op.q && R0.pwf === R1.pwf, R0.ok && R1.ok ? Math.abs(R0.op.q - R1.op.q) : 1, 0);
  }
  // X25 (B, WP21) per-section correlations: one section over the whole path with key k = the whole-well traverse with k (bit-identical);
  // sections naming only the base key = no sections; an MD section split with the same key moves the step layout only (< 0.5 psi)
  {
    const M = S.FIX.gasWell, F = G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F }), W = G.WTS_wp_well.build(M.well, { res: M.res });
    let worst = 0, okId = true;
    ['mb', 'hk', 'bb'].forEach((k) => {
      const a = V.traverse(F, W, 7000, { from: 'top', p0: 500, corr: k });
      const b = V.traverse(F, W, 7000, { from: 'top', p0: 500, corr: 'hb', sections: [{ by: 'inc', from: 0, to: 180, corr: k }] });
      if (!(a.ok && b.ok) || a.pEnd !== b.pEnd) okId = false;
      const c = V.traverse(F, W, 7000, { from: 'top', p0: 500, corr: k, sections: [{ by: 'md', from: 3333, to: 6666, corr: k }] });
      worst = Math.max(worst, c.ok ? Math.abs(c.pEnd - a.pEnd) : Infinity);
    });
    const n0 = V.traverse(F, W, 7000, { from: 'top', p0: 500, corr: 'gray' }), n1 = V.traverse(F, W, 7000, { from: 'top', p0: 500, corr: 'gray', sections: [{ by: 'md', from: 0, to: 4000, corr: 'gray' }, { by: 'inc', from: 0, to: 180, corr: 'gray' }] });
    if (!(n0.ok && n1.ok) || Math.abs(n0.pEnd - n1.pEnd) > 0.5) okId = false;
    add('X25', 'per-section correlations: one section over the path = that correlation (identical); an MD split with the same key < 0.5 psi', okId && worst < 0.5, worst, 0.5);
  }
  // X26 (B, WP21) single-phase liquid at rate: each new correlation = Darcy-Weisbach with Colebrook (0.1 %), vertical water well
  {
    const M = S.FIX.gasWell; M.fluid.type = 'water'; M.fluid.sgw = 1.07; M.fluid.cgr = 0; M.fluid.wgr = 0;
    const F = G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F }), W = G.WTS_wp_well.build(M.well, { res: M.res });
    const ref = V.traverse(F, W, 3000, { from: 'top', p0: 200, corr: 'single' });
    let worst = 0;
    ['ork', 'agf', 'mb', 'ansari', 'hk'].forEach((k) => { const tr = V.traverse(F, W, 3000, { from: 'top', p0: 200, corr: k }); worst = Math.max(worst, tr.ok && ref.ok ? Math.abs(tr.pEnd - ref.pEnd) / (ref.pEnd - 200) : Infinity); });
    add('X26', 'single-phase water at 3,000 BWPD: the five B correlations vs Darcy-Weisbach / Colebrook (deviated path)', worst < 0.001, worst, 0.001);
  }
  // X27 (B, WP21) direction agreement for each new correlation (oil and wet gas): top-down then bottom-up within 0.5 psi
  {
    let worst = 0;
    ['oilWell', 'gasWell'].forEach((fx) => {
      const M = S.FIX[fx], F = G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F }), W = G.WTS_wp_well.build(M.well, { res: M.res }), q = fx === 'oilWell' ? 900 : 7000;
      ['ork', 'agf', 'mb', 'ansari', 'hk'].forEach((k) => {
        const d = V.traverse(F, W, q, { from: 'top', p0: 500, corr: k }), u = d.ok ? V.traverse(F, W, q, { from: 'bottom', p0: d.pEnd, corr: k }) : null;
        worst = Math.max(worst, u && u.ok ? Math.abs(u.pEnd - 500) : Infinity);
      });
    });
    add('X27', 'direction agreement, the five B correlations (oil and wet gas): top-down then bottom-up returns the wellhead pressure', worst < 0.5, worst, 0.5);
  }
  // X40 enthalpy balance (B, WP22): the piecewise-exact march with a step source and two U layers vs RK4 on the deviated FIX.gasWell path (°F),
  // and the adiabatic gravity lapse TVD / (J c_p) with U → 0
  if (G.WTS_wellbore && typeof G.WTS_wellbore.flowingTemp === 'function') {
    const WB = G.WTS_wellbore, M = S.FIX.gasWell, W = G.WTS_wp_well.build(M.well, { res: M.res }), mid = W.nodes.midPerfMd;
    const o = { w: 12000, cp: 0.55, U_to: 2, ke: 1.4, r_to: 2.875 / 24, rwb: 8.5 / 24, t_hr: 720, geo: { points: [[0, 70], [4000, 120], [9300, 230]] }, Tin: 240 };
    const col = { tvdAt: W.tvdAt, mdAt: W.mdAt, datumMd: mid, survey: W.stations.map((x) => [x.md, x.tvd]), segments: [] };
    const ly = [{ topMd: 0, botMd: 2500, U_to: 12, ke: 1.1 }, { topMd: 6000, botMd: 7000, U_to: 0.3 }], psiAt = (md) => (md < 3000 ? 0.012 : md < 6500 ? -0.004 : 0.0021);
    const r = WB.flowingTemp(col, Object.assign({}, o, { layers: ly, src: (a, b) => psiAt(0.5 * (a + b)), srcCuts: [3000, 6500] }));
    const Aof = (md) => { const L = md <= 2500 ? ly[0] : (md >= 6000 && md <= 7000 ? ly[1] : null); if (!L) return r.A; const ke = L.ke || 1.4; return (o.w * o.cp / (2 * Math.PI)) * (ke + o.r_to * L.U_to * r.fTD) / (o.r_to * L.U_to * ke); };
    const geoF = (tvd) => (tvd <= 4000 ? 70 + 50 * tvd / 4000 : 120 + 110 * (tvd - 4000) / 5300), f = (md, T) => (geoF(W.tvdAt(md)) - T) / Aof(md) + psiAt(md);
    let T = 240, md = mid; while (md > 1e-9) { const h = Math.min(1, md), k1 = f(md, T), k2 = f(md - h / 2, T + h * k1 / 2), k3 = f(md - h / 2, T + h * k2 / 2), k4 = f(md - h, T + h * k3); T += h * (k1 + 2 * k2 + 2 * k3 + k4) / 6; md -= h; }
    const e1 = Math.abs(r.tOut - T);
    const ad = WB.flowingTemp(col, Object.assign({}, o, { U_to: 1e-9, src: (a, b) => -((W.tvdAt(b) - W.tvdAt(a)) / (b - a)) / (778.17 * o.cp) }));
    const e2 = Math.abs(ad.tOut - (240 - W.nodes.midPerfTvd / (778.17 * o.cp)));
    add('X40', 'enthalpy balance: march with a step source and U layers vs RK4 on the deviated path; adiabatic gravity lapse (°F)', e1 < 0.02 && e2 < 1e-3, Math.max(e1, e2), 0.02);
  }
  // X41 the liquid identity (J-T + gravity = −β T_R sinθ / (J c_p) in a hydrostatic water column), η_gas = the real-gas μ_JT of WTS_gaspvt_state
  // (≤ 0.5 %), and the energy budget of FIX.gasWell closes (T_in + loss + J-T + gravity + kinetic = THT)
  if (G.WTS_wp_well && typeof G.WTS_wp_well.jtMix === 'function') {
    const N = G.WTS_wp_well, Mw = S.FIX.oilWell; Mw.fluid.wc = 1; Mw.fluid.gor = 0;
    const Fw = G.WTS_wp_fluid.build(Mw.fluid, { T_F: Mw.res.T_F, table: true }), hw = N.heatFlow(Fw, 1000, { T: 150, p: 2000 });
    const jw = N.jtMix(Fw, 1000, 3000, 200, hw), pr = G.WTS_flowline_props(G.WTS_wp_fluid.flowlineFluid(Fw, 1000), 3000, 200), TR = 659.67;
    const e1 = Math.abs((jw.eta * (-pr.rhoW / 144) - 1 / (778.17 * hw.cp)) - (-N.ENTH.beta.water * TR / (778.17 * hw.cp)));
    const Mg = S.FIX.gasWell, Fg = G.WTS_wp_fluid.build(Mg.fluid, { T_F: Mg.res.T_F, table: true }), hg = N.heatFlow(Fg, 7400, { T: 160, p: 2500 });
    const jg = N.jtMix(Fg, 7400, 2500, 160, hg), st = G.WTS_gaspvt_state(Fg.sgg, 2500, 160, 0, 0, 0), e2 = Math.abs(jg.etaGas * hg.cpParts.gas / (st.cpReal / 4.1868 / st.M) / st.muJT - 1);
    Mg.well.heat.mode = 'enthalpy';
    const Re = G.WTS_wp_system.solve(Mg), b = Re.ok && Re.heat && Re.heat.budget, e3 = b ? Math.abs(b.tIn + b.loss + b.jt + b.grav + b.kin - b.tOut) : 1;
    add('X41', 'enthalpy balance: liquid adiabatic identity (°F/ft), η_gas vs real-gas μ_JT (rel.), energy budget closure (°F)', e1 < 1e-12 && e2 < 0.005 && e3 < 1e-9, Math.max(e1, e3), 1e-9);
  }
  // X42 the predictor pass: the enthalpy THT re-run on the reported traverse's pressures moves < 0.5 °F (both fixtures)
  if (G.WTS_wp_well && typeof G.WTS_wp_well.enthalpy === 'function') {
    let w = 0;
    ['oilWell', 'gasWell'].forEach((k) => { const M = S.FIX[k]; M.well.heat.mode = 'enthalpy'; const R = G.WTS_wp_system.solve(M); w = Math.max(w, R.ok && R.heat && Number.isFinite(R.heat.passCheck) ? R.heat.passCheck : 99); });
    add('X42', 'enthalpy balance: predictor pass check, THT on the solution pressures vs the predictor (°F)', w < 0.5, w, 0.5);
  }
  // ── increment B inflow (WP24) ──
  const IPR = G.WTS_wp_ipr;
  if (IPR && IPR.models && IPR.models.wcComposite) {
    // X28 water-cut composite limits: WC 0 = the composite oil IPR, WC 1 = the straight-line PI, and the weighted curve between
    {
      const c0 = IPR.curve({ model: 'wcComposite', pr: 3000, pb: 2000, params: { J: 2, fw: 0 } }), oil = IPR.curve({ model: 'composite', pr: 3000, pb: 2000, params: { J: 2 } });
      const c1 = IPR.curve({ model: 'wcComposite', pr: 3000, pb: 2000, params: { J: 2, fw: 1 } }), cm = IPR.curve({ model: 'wcComposite', pr: 3000, pb: 2000, params: { J: 2, fw: 0.4 } });
      let w = 0;
      [0.1, 0.4, 0.7, 0.95].forEach((f) => {
        const q = f * oil.aof; w = Math.max(w, Math.abs(c0.pwfAt(q) - oil.pwfAt(q)), Math.abs(c1.pwfAt(q) - Math.max(0, 3000 - q / 2)), Math.abs(cm.pwfAt(q) - (0.4 * Math.max(0, 3000 - q / 2) + 0.6 * oil.pwfAt(q))));
      });
      add('X28', 'water-cut composite: WC 0 = composite oil, WC 1 = PI line, weighted in between (psi)', w < 1e-9, w, 1e-9);
    }
    // X29 fracture: s_f of an infinite-conductivity fracture = ln(2·rw/x_f) (Prats); the F_cD fit tends to it (F_cD 1,000 within 3 %);
    // the frac model = Darcy oil with S = s_f exactly
    {
      const a = IPR.fracSkin({ xf: 300, rw: 0.354 }), b = IPR.fracSkin({ xf: 300, rw: 0.354, FcD: 1000 });
      const e1 = Math.abs(a.sf - Math.log(2 * 0.354 / 300)), e2 = Math.abs(b.f / Math.log(2) - 1);
      const P = { k: 2, h: 40, rw: 0.354, re: 1490, Bo: 1.2, muo: 1.1 }, fr = IPR.curve({ model: 'frac', pr: 3000, params: Object.assign({ xf: 300, FcD: 5 }, P) });
      const sf = IPR.fracSkin({ xf: 300, rw: 0.354, FcD: 5 }).sf, da = IPR.curve({ model: 'darcyOil', pr: 3000, params: Object.assign({ S: sf }, P) });
      const e3 = Math.abs(fr.J / da.J - 1);
      add('X29', 'fracture: Prats limit ln(2rw/x_f), F_cD fit → ln 2 (3 %), frac = Darcy with S = s_f', e1 < 1e-12 && e2 < 0.03 && e3 < 1e-12, Math.max(e1, e3), 1e-12);
    }
    // X30 transient: the log approximation vs the exponential-integral line source at t_D > 100 (0.2 %)
    {
      const E1 = (x) => { let s = -0.5772156649 - Math.log(x), t = 1; for (let n = 1; n < 60; n++) { t *= -x / n; s -= t / n; } return s; };
      const k = 20, h = 40, phi = 0.15, ct = 1.5e-5, rw = 0.354, B = 1.2, mu = 0.8, q = 500;
      let w = 0;
      [5, 24, 200].forEach((t) => {
        const r = IPR.transientJ({ k, h, phi, ct, rw, t, B, mu, S: 0 }), dpLog = q / r.J;
        const dpEi = 70.6 * q * B * mu / (k * h) * E1(948 * phi * mu * ct * rw * rw / (k * t));
        w = Math.max(w, Math.abs(dpLog / dpEi - 1));
      });
      add('X30', 'transient IPR: log approximation vs the exponential-integral line source (t_D > 100)', w < 0.002, w, 0.002);
    }
    // X31 multilayer: one layer = the PI exactly; at the commingled static pressure the layer rates sum to 0 (crossflow balance)
    {
      const one = IPR.curve({ model: 'multilayer', pr: 3000, layers: [{ name: 'A', topMd: 7990, botMd: 8010, pr: 3000, J: 2 }], perf: { midMd: 8000 }, params: {} });
      const pi = IPR.curve({ model: 'pi', pr: 3000, params: { J: 2 } });
      let w = 0; [0.1, 0.5, 0.9].forEach((f) => { const q = f * pi.aof; w = Math.max(w, Math.abs(one.pwfAt(q) - pi.pwfAt(q))); });
      const two = IPR.curve({ model: 'multilayer', pr: 3000, layers: [{ name: 'A', topMd: 7800, botMd: 7850, pr: 3100, J: 1.2 }, { name: 'B', topMd: 8150, botMd: 8200, pr: 2400, J: 0.9 }], perf: { midMd: 8000 }, params: {} });
      const bal = two.crossflow.layers.reduce((s, r) => s + r.q, 0);
      add('X31', 'multilayer: one layer = the PI (psi); layer rates at p_ws sum to 0 (crossflow balance)', w < 1e-6 && Math.abs(bal) < 1e-6 && two.crossflow.thief.length === 1, Math.max(w, Math.abs(bal)), 1e-6);
    }
    // X32 injector: the operating point closes (|pwf_VLP − pwf_IPR| < 0.1 psi) and the fracture-limit THP marched back down gives
    // p_frac at q_frac (injection direction agreement, 0.5 psi)
    {
      const Mi = S.FIX.gasWell; Mi.fluid = Object.assign(Mi.fluid, { type: 'waterinj', cgr: 0, wgr: 0, sgw: 1.05 }); Mi.res = { model: 'injector', pr: 3200, T_F: 230, params: { II: 4, pfrac: 5200 }, points: [], layers: [] };
      Mi.system.thp_psig = 1200; Mi.surface.choke.present = false; Mi.surface.flowline = []; Mi.well.heat.tht_F = 80;
      const R = solve(Mi), F = G.WTS_wp_fluid.build(Mi.fluid, { T_F: 230 }), W = G.WTS_wp_well.build(Mi.well, { res: Mi.res });
      const tr = V.traverse(F, W, R.op.q, { from: 'top', p0: 1200 + PATM, inject: true, corr: R.corr.well });
      const e1 = Math.abs(tr.pEnd - (3200 + R.op.q / 4));
      const tf = V.traverse(F, W, R.inj.qFrac, { from: 'top', p0: R.inj.thpFrac_psig + PATM, inject: true, corr: R.corr.well }), e2 = Math.abs(tf.pEnd - 5200);
      add('X32', 'injector: operating point closes (psi) and the fracture-limit THP gives p_frac at q_frac (psi), deviated path', e1 < 0.15 && e2 < 0.5, Math.max(e1, e2), 0.5);
      // X33 injection column, no flow: the marcher down the deviated path vs RK2 on ρ_w(p, T)
      const t0 = V.traverse(F, W, 1e-6, { from: 'top', p0: 1200 + PATM, inject: true, corr: 'bb' }), pr = t0.profile.filter((r) => !r.restr);
      let p = 1200 + PATM;
      for (let i = 1; i < pr.length; i++) { const dz = pr[i].tvd - pr[i - 1].tvd, tm = 0.5 * (pr[i].t + pr[i - 1].t), r1 = F.at(p, tm).rhoW, r2 = F.at(p + r1 * dz / 144, tm).rhoW; p += 0.5 * (r1 + r2) * dz / 144; }
      const e3 = Math.abs(t0.pEnd - p) / (p - 1200 - PATM);
      add('X33', 'injection column at no flow: march down the deviated path vs RK2 (hydrostatic on TVD)', e3 < 1e-4, e3, 1e-4);
    }
    // X34 Babu-Odeh: s_R = 0 at full penetration and falls as the lateral fills the box
    {
      const g = { a: 2000, b: 4000, h: 50, rw: 0.354, kx: 50, ky: 50, kz: 5 }, s = [2000, 3000, 4000].map((L) => IPR.babuOdehX(Object.assign({ L }, g)).sR);
      add('X34', 'Babu-Odeh partial penetration: s_R(L = b) = 0, decreasing with L', s[2] === 0 && s[0] > s[1] && s[1] > 0, s[2], 0);
    }
    // X35 Build-up hand-off: the latest interpreted test → k, h, S; p̄r moved from the datum by the static gradient
    {
      const st = { v: 1, analysis: { well: { fluid: 'oil', h: 40, rw: 0.354 }, depth: { datumTVD: 7900, grad: 0.35 }, tests: [
        { id: 'B1', status: 'interpreted', tc_ms: 1, date: '2026-01-01', pExtDatum: 3100, result: { final: { k: 10, kh: 400, S: 3, pExtKind: 'pbar' } } },
        { id: 'B2', status: 'interpreted', tc_ms: 2, date: '2026-03-01', pExtDatum: 3000, result: { final: { k: 12, kh: 480, S: 4, pExtKind: 'pbar' } } }] } };
      const r = IPR.fromBuildup(st, { midPerfTvd: 8000 });
      add('X35', 'Build-up hand-off: latest test k / h / S, p̄r at the mid-perforations (datum + 0.35 psi/ft × 100 ft)', r.ok && r.spec.params.k === 12 && r.spec.params.h === 40 && r.spec.params.S === 4 && Math.abs(r.spec.pr - 3035) < 1e-9, r.ok ? Math.abs(r.spec.pr - 3035) : 1, 1e-9);
    }
  }
  // B (WP20) lift-curve and PVT tables
  const XP = G.WTS_wp_export;
  if (XP && typeof XP.liftTable === 'function') {
    // X43 every lift-table point = the solver's own top-down evaluation at that THP (evalAt, outflowOnly), oil and the deviated wet gas
    let w43 = 0, ok43 = true;
    const evalP = (M, thpA, q, mut) => { const Mx = JSON.parse(JSON.stringify(M)); Mx.surface.choke.present = false; Mx.system.thp_psig = thpA - PATM; Mx.system.node = 'bottom'; Mx.system.mode = 'rate'; if (mut) mut(Mx); return SY.evalAt(Mx, q, { outflowOnly: true }); };
    const spO = { flo: { type: 'OIL', values: [150, 500, 1000] }, thp: [200, 500], wfr: { type: 'WCT', values: [0.3, 0.7] }, gfr: { type: 'GOR', values: [0.5] }, alq: { type: '', values: [0] } };
    const spG = { flo: { type: 'GAS', values: [2000, 6000, 12000] }, thp: [800, 1600], wfr: { type: 'WGR', values: [0.002] }, gfr: { type: 'OGR', values: [0.02, 0.05] }, alq: { type: '', values: [0] } };
    const TO = XP.liftTable(S.FIX.oilWell, spO), TG = XP.liftTable(S.FIX.gasWell, spG);
    if (!TO.ok || !TG.ok) ok43 = false;
    else {
      TO.points.forEach((p) => { const e = evalP(S.FIX.oilWell, p.thp, p.flo / (1 - p.wfr), (Mx) => { Mx.fluid.wc = p.wfr; Mx.fluid.gor = p.gfr * 1000; }); if (!e.ok) ok43 = false; else w43 = Math.max(w43, Math.abs(e.pOut - p.bhp)); });
      TG.points.forEach((p) => { const e = evalP(S.FIX.gasWell, p.thp, p.flo, (Mx) => { Mx.fluid.wgr = p.wfr * 1000; Mx.fluid.cgr = p.gfr * 1000; }); if (!e.ok) ok43 = false; else w43 = Math.max(w43, Math.abs(e.pOut - p.bhp)); });
    }
    add('X43', 'lift table: every point = the solver\'s top-down evaluation at its THP (oil, deviated wet gas; psi)', ok43 && w43 < 0.1, w43, 0.1);
    // X44 the text format and the CSV read back: axes exactly, BHP within the printed 0.005 psi; one CSV row per point
    let w44 = 0, ok44 = true;
    [TO, TG].forEach((T) => {
      if (!T.ok) { ok44 = false; return; }
      const P = XP.parseText(XP.text(T)); if (!P.ok || JSON.stringify(P.axes) !== JSON.stringify(T.axes)) { ok44 = false; return; }
      T.points.forEach((p) => { w44 = Math.max(w44, Math.abs(P.bhp[p.t][p.w][p.g][p.a][p.f] - p.bhp)); });
      if (XP.csv(T).trim().split('\n').length - 2 !== T.n) ok44 = false;
    });
    add('X44', 'lift-curve table text format and CSV round trip (axes exact, BHP within 0.005 psi)', ok44 && w44 <= 0.005 + 1e-9, w44, 0.005);
    // X45 monotonicity: BHP rises with THP on every column; every oil rate row has a single minimum (falling branch, then rising)
    const ok45 = TO.ok && TG.ok && TO.monotone.thp.ok && TG.monotone.thp.ok && TO.monotone.rate.ok;
    add('X45', 'lift table: BHP rises with THP on every column (oil, gas); oil rate rows single-minimum', ok45, ok45 ? 0 : 1, 0);
    // X46 the PVT table rows are the fluid engine's (identical) and the black-oil text table reads back (Bo within the printed 5e-6)
    const M = S.FIX.oilWell, P = XP.pvtTable(M), F = G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F });
    const tb = G.WTS_wp_fluid.table(F, P.rows.map((r) => r.p), M.res.T_F), Q = XP.parsePvtText(XP.pvtText(P));
    let w46 = JSON.stringify(P.rows) === JSON.stringify(tb.rows) ? 0 : 1;
    if (Q.ok) Q.oil.forEach((rc) => rc.rows.forEach((r) => { const row = P.rows.find((x) => Math.abs(x.p - r.p) < 1e-3); w46 = Math.max(w46, row ? Math.abs(row.bo - r.bo) : 1); }));
    add('X46', 'PVT table: the fluid engine\'s rows (identical); black-oil text table round trip (Bo)', P.ok && Q.ok && w46 <= 5e-6 + 1e-12, w46, 5e-6);
  }
  // B (WP27): the envelope, the forecast tanks, the tornado and the matrix
  const runJ2 = (job) => { let s, n = 0; do { s = job.step(); n++; } while (!s.done && n < 3000); return job.result(); };
  if (G.WTS_wp_envelope && typeof G.WTS_wp_envelope.job === 'function') {
    // X47 node independence of the envelope: at the operating rate the wellhead deliverability = the THP of the choke solve, the
    // flowline back pressure = the choke-downstream pressure; X48 its maximum rate = WTS_wp_system.maxRate
    let w1 = 0, w2 = 0;
    ['oilWell', 'gasWell'].forEach((k) => {
      const M = S.FIX[k], R = solve(M), e = runJ2(G.WTS_wp_envelope.job(M, { R })), a = G.WTS_wp_envelope.at(e, R.op.q);
      w1 = Math.max(w1, a ? Math.abs(a.thp / R.surface.thp_psig - 1) : Infinity);
      w2 = Math.max(w2, e.max ? Math.abs(e.max.q / SY.maxRate(M).q - 1) : Infinity);
    });
    add('X47', 'operating envelope: wellhead deliverability at the operating rate = the THP of the choke solve (node independence)', w1 < 0.005, w1, 0.005);
    add('X48', 'operating envelope: maximum rate = WTS_wp_system.maxRate', w2 < 0.005, w2, 0.005);
  }
  if (G.WTS_wp_forecast && typeof G.WTS_wp_forecast.tank === 'function') {
    // X49 gas tank on its p/Z line; X50 oil tank on the Havlena-Odeh line (N·E_t = F) at every step of a 24-step forecast
    const FC = G.WTS_wp_forecast, T = FC.tank(S.FIX.gasWell, { G_Bscf: 20 });
    const rg = runJ2(FC.job(S.FIX.gasWell, { mode: 'tank', tank: { G_Bscf: 20 }, horizon_d: 3650, n: 24 }));
    let e1 = 0; rg.rows.forEach((x) => { e1 = Math.max(e1, Math.abs(x.mb.poz / (T.piz * (1 - x.Gp / T.G)) - 1)); });
    add('X49', 'forecast, gas tank: every step on the p/Z line (relative)', e1 < 1e-6, e1, 1e-6);
    const ro = runJ2(FC.job(S.FIX.oilWell, { mode: 'tank', tank: { N_MMstb: 20 }, horizon_d: 3650, n: 24 }));
    let e2 = 0; ro.rows.forEach((x) => { if (x.mb) e2 = Math.max(e2, Math.abs(20e6 * x.mb.Et - x.mb.F) / Math.max(1, x.mb.F)); });
    add('X50', 'forecast, oil tank: N·E_t = F at every step (relative)', e2 < 1e-5, e2, 1e-5);
    // X51 explicit stepping converges at first order: |C24 − C48| < 0.6·|C12 − C24|, and within 2.5 % of C48
    const c = [12, 24, 48].map((n) => runJ2(FC.job(S.FIX.gasWell, { mode: 'tank', tank: { G_Bscf: 20 }, horizon_d: 1825, n })).totals.produced);
    const ratio = Math.abs(c[1] - c[2]) / Math.abs(c[0] - c[1]), rel = Math.abs(c[1] - c[2]) / c[2];
    add('X51', 'forecast, explicit time steps: first-order convergence 12 / 24 / 48 steps (ratio; 24 steps within 2.5 %)', ratio < 0.6 && rel < 0.025, ratio, 0.6);
  }
  if (G.WTS_wp_sens && typeof G.WTS_wp_sens.tornado === 'function') {
    // X52 the tornado base and the start cell of a three-variable matrix = the single solve exactly (§15.2)
    const M = S.FIX.oilWell, R = solve(M), t = runJ2(G.WTS_wp_sens.tornado(M, { vars: [{ key: 'wc' }] }));
    const m = runJ2(G.WTS_wp_sens.job(M, [{ key: 'wc', values: [20, 30] }, { key: 'pr', values: [3000] }, { key: 'bean', values: [32, 40] }]));
    const c0 = m.ok && m.cases.find((x) => x.values.wc === 30 && x.values.pr === 3000 && x.values.bean === 32);
    const okx = t.ok && t.q0 === R.op.q && c0 && c0.R.q === R.op.q;
    add('X52', 'tornado base and the matrix start cell = the single solve (identical)', okx, okx ? 0 : 1, 0);
  }
  // X53a / X53b (B, WP28): the batch over wells — each well stored as a project keeps it (WTS_wp_batch.storedFrom, read back through
  // WTS_wp_model.read) gives exactly the single solve; the deviation marks of the schematic on FIX.devSurvey (closed form: KOP at 3° =
  // 1,000 ft + 3 / (3°/100 ft) = 1,100 ft MD on the linear build; the 90° hold = 500 ft)
  if (G.WTS_wp_batch && typeof G.WTS_wp_batch.job === 'function') {
    const BT = G.WTS_wp_batch, fx = ['oilWell', 'gasWell'];
    const wells = fx.map((k, i) => ({ id: 'w' + (i + 1), name: k, active: i === 0, keys: BT.storedFrom(S.FIX[k]) }));
    const runJ = (job) => { let st, n = 0; do { st = job.step(); n++; } while (!st.done && n < 50); return job.result(); };
    const r = runJ(BT.job({ wells }));
    let ok = r.rows.length === 2, worst = 0;
    fx.forEach((k, i) => { const R = solve(S.FIX[k]), row = r.rows[i]; const d = row && R.ok ? Math.abs(row.q - R.op.q) : Infinity; worst = Math.max(worst, d); if (!(row && row.status === 'ok' && row.q === R.op.q && row.pwf === (Number.isFinite(R.pwf) ? R.pwf : R.op.p))) ok = false; });
    add('X53a', 'batch over wells: each stored well = its single solve (identical q and p_wf, oil + wet gas)', ok, worst, 0);
    const dv = S.FIX.devSurvey, V2 = G.WTS_wp_view;
    if (V2 && typeof V2.devInfo === 'function') {
      const d = V2.devInfo(dv.expect.map((e, i) => ({ md: e.md, tvd: e.tvd, inc: dv.rows[i][1] })));
      const eK = Math.abs(d.kopMd - 1100), eH = d.hz.length === 1 ? Math.abs((d.hz[0].md1 - d.hz[0].md0) - 500) : Infinity;
      add('X53b', 'schematic deviation marks: KOP at 3° and the horizontal hold on FIX.devSurvey (ft)', eK < 0.01 && eH < 0.01, Math.max(eK, eH), 0.01);
    }
  }
  // X54–X58 (B, WP25): gas-lift design on the shared model, Thornhill-Craver, diagnosis, Asheim and the gradient survey
  const GL = G.WTS_wp_gl;
  if (GL && typeof GL.tc === 'function' && typeof G.WTS_gaslift_compute === 'function') {
    // X54 Thornhill-Craver = the isentropic gas nozzle of 49-calc-chokeperf.js at z = 1 and the same Cd (the 155.5·√(2g) constant against
    // the nozzle's K_G at 60 °F / 14.696 psia), over a grid of ports, ratios (critical and sub-critical), temperatures and gravities
    let wTC = 0;
    [8, 16, 24, 32].forEach((p64) => [0.3, 0.55, 0.8, 0.95].forEach((r) => [100, 200].forEach((T) => [0.6, 0.8].forEach((sg) => {
      const t = GL.tc({ port64: p64, p1: 1200, p2: 1200 * r, T: T, sg: sg, cd: 0.85 });
      const nz = G.WTS_chokeperf_gasRate({ s64: p64, cd: 0.85, p1a: 1200, p2a: 1200 * r, tR: T + 459.67, sg: sg, k: 1.27, z: 1 });
      wTC = Math.max(wTC, Math.abs(t.q / nz - 1));
    }))));
    add('X54', 'Thornhill-Craver = the isentropic nozzle at z = 1 (critical and sub-critical; relative)', wTC < 0.005, wTC, 0.005);
    // X55 the additive inputs of WTS_gaslift_compute: a one-segment vertical path + a straight-line inflow object = the vertical design
    const B0 = { qo: 800, qw: 400, gor: 300, api: 35, sgg: 0.7, sgw: 1.07, sginj: 0.65, pr: 3000, pi: 2, dperf: 8000, dmax: 7700, tub: 'tubing-2.875-6.5', rough: 0.0018,
      pwh: 120, twh: 110, bht: 190, pko: 1100, pso: 1000, glr: 800, dpv: 100, dpdrop: 25, gs: 0.465, ftub: 20, minsp: 250, R: 0.067 };
    const a0 = G.WTS_gaslift_compute(B0), a1 = G.WTS_gaslift_compute(Object.assign({}, B0, { segments: [{ len: 8000, id: 2.441, dz: 8000 }], ipr: { pr: 3014.696, pwfAt: (q) => 3014.696 - q / 2 } }));
    let w55 = a0.ok && a1.ok && a0.valves.length === a1.valves.length ? 0 : Infinity;
    if (w55 === 0) a0.valves.forEach((v, i) => { w55 = Math.max(w55, Math.abs(v.d - a1.valves[i].d), Math.abs(v.ptro - a1.valves[i].ptro)); });
    add('X55', 'gas-lift design: vertical path + straight-line ipr = the vertical design (valve depth ft, p_tro psi)', w55 < 1e-6, w55, 1e-6);
    // X56 the design and the diagnosis agree: at the design's operating surface pressure (+5 psi) and the operating rates the valve that
    // passes the gas is the design's operating valve, alone
    const Ml = S.FIX.oilWell; Ml.fluid.wc = 0.6; Ml.res.pr = 2600; Ml.lift = { type: 'gaslift', gl: { qinj_Mscfd: 800, pinj_psig: 1200, sginj: 0.65, dpValve: 100, packerMd: 7800 } };
    const Rl = solve(Ml), runJ = (job) => { let st, n = 0; do { st = job.step(); n++; } while (!st.done && n < 20); return job.result(); }, Dl = runJ(GL.design(Ml, Rl));
    if (Dl.ok) {
      const opv = Dl.valves[Dl.valves.length - 1], dg = GL.diagnose(Ml, Rl, GL.valvesFromDesign(Dl), { chp_psig: opv.pso + 5, thp_psig: Rl.surface.thp_psig, qinj_Mscfd: 800, q_o: Rl.rates.qo, q_w: Rl.rates.qw, q_g: Rl.rates.qg + 800 });
      const ok56 = dg.ok && dg.operating && dg.operating.n === Dl.valves.length && !dg.multi;
      add('X56', 'diagnosis at the design operating surface pressure = the design operating valve, alone', ok56, ok56 ? 0 : 1, 0);
    } else add('X56', 'diagnosis at the design operating surface pressure = the design operating valve, alone', false, 1, 0);
    // X57 Asheim: F1 > 1 exactly when the solver's static criterion dΔ/dq > 0; a critical port gives F2 = 0
    const a = GL.asheim(Ml, Rl, { port64: 16 }), Mc = S.FIX.oilWell; Mc.fluid.wc = 0.6; Mc.res.pr = 2600; Mc.lift = { type: 'gaslift', gl: { qinj_Mscfd: 800, pinj_psig: 1200, sginj: 0.65, dpValve: 700, packerMd: 7800 } };
    const ac = GL.asheim(Mc, solve(Mc), { port64: 16 }), ok57 = a.ok && a.stable1 === (Rl.op.dDdq > 0) && ac.ok && ac.parts.critical && ac.F2 === 0;
    add('X57', 'Asheim F1 > 1 ⇔ dΔ/dq > 0; a critical port gives F2 = 0', ok57, ok57 ? 0 : 1, 0);
    // X58 the solve's own traverse read as a survey matches it exactly, and its gradient break lies at the injection point
    const rows = Rl.traverse.profile.filter((r, i) => !r.restr && i % 4 === 0).map((r) => ({ md: r.md, p: r.p }));
    const ms = GL.matchSurvey(Ml, Rl, rows), dB = ms.ok && ms.brk ? Math.abs(ms.brk.md - Rl.lift.injMd) : Infinity;
    add('X58', 'gradient survey = the solved traverse: RMS 0 psi, break at the injection point (ft MD)', ms.ok && ms.rms < 1e-6 && dB < 400, dB, 400);
  }
  // X60–X63 (B, WP26; numbered from X60 to stay clear of a parallel package): the ESP
  const EP = G.WTS_wp_esp;
  if (EP && typeof EP.pump === 'function') {
    const espM = (o) => { const M = S.FIX.oilWell; M.res.pr = 2200; M.fluid.wc = 0.6; M.well.strings.push({ kind: 'casing', tubKey: null, rough: 0.0006, topMd: 0, botMd: 7950, id: 6.276, od: 7, wall: 0.362 });
      M.lift = { type: 'esp', gl: {}, esp: Object.assign({ pump: EP.example(), pumpMd: 7900, freq: 60, stages: 120 }, o || {}) }; return M; };
    // X60 affinity laws on the curve: H(q·r; f) = r²·H(q; 60), P ∝ r³ (relative)
    const P0 = EP.normPump(EP.example()).pump, c60 = EP.curve(P0, 60); let wA = 0;
    [40, 50, 70].forEach((f) => { const r = f / 60, c = EP.curve(P0, f); [300, 1200, 2100].forEach((q) => { wA = Math.max(wA, Math.abs(c.head(q * r) / (r * r * c60.head(q)) - 1), Math.abs(c.bhp(q * r, 1) / (r * r * r * c60.bhp(q, 1)) - 1)); }); });
    add('X60', 'ESP affinity laws on the pump curve: H ∝ f², P ∝ f³ at q ∝ f (relative)', wA < 1e-12, wA, 1e-12);
    // X61 at the operating point the pump's discharge pressure = the pressure the tubing needs (psi), and the breakdown closes on p̄r − p_sep
    const M = espM(), R = solve(M), dD = R.ok ? Math.abs(R.lift.pDisReq - R.lift.pDis) : Infinity;
    const cl = R.ok ? Math.abs(R.breakdown.reduce((a, b) => a + b.dp, 0) - (R.pr - (M.surface.psep_psig + 14.696))) : Infinity;
    add('X61', 'ESP node: discharge pressure made = needed at the root; breakdown closure with the pump gain (psi)', dD < 0.5 && cl < 0.5, Math.max(dD, cl), 0.5);
    // X62 node independence (bottom vs wellhead, relative q) and the top-down evaluation without inflow = the bottom-node pwf (relative)
    const Mh = espM(); Mh.system.node = 'wellhead'; const Rh = solve(Mh), SY2 = G.WTS_wp_system;
    const e = SY2.evalAt(M, R.op.q, { outflowOnly: true, thp_psig: R.surface.thp_psig, ctx: SY2.context(M, { outflowOnly: true }) });
    const n1 = Rh.ok ? Math.abs(Rh.op.q / R.op.q - 1) : Infinity, n2 = e.ok ? Math.abs(e.pOut / R.pwf - 1) : Infinity;
    add('X62', 'ESP: node independence (q) and the top-down pumped march = the bottom-node pwf (relative)', n1 < 0.005 && n2 < 0.0015, Math.max(n1, n2), 0.005);
    // X63 a water pump: Δp stage by stage = ρ̄·N·H(Q)/144 (relative), the frequency sweep row at 60 Hz = the single solve
    const W = G.WTS_wp_well.build(M.well, { res: M.res }), Mw = JSON.parse(JSON.stringify(M)); Mw.fluid.type = 'water'; Mw.fluid.sgw = 1.0;
    const Fw = G.WTS_wp_fluid.build(Mw.fluid, { T_F: 150, table: false }), Pw = EP.prepare(Mw, W), st = EP.pump(Pw, Fw, 1500, 1500, 150);
    const a = Fw.at(1500, 150, 1500), b2 = Fw.at(st.pDis, 150, 1500), cw = EP.curve(Pw.pump, 60, Math.max(0.5, a.muL / (a.rhoL / 62.428)));
    const hand = (a.rhoL + b2.rhoL) / 2 * 120 * cw.head(a.qL * 86400 / 5.614583) / 144, w1 = Math.abs(st.dp / hand - 1);
    const runS = (job) => { let x, n = 0; do { x = job.step(); n++; } while (!x.done && n < 50); return job.result(); };
    const sw = runS(EP.sweep(M, { freqs: [55, 60] })), r60 = sw.rows.find((x) => x.f === 60), w2 = r60 && r60.ok ? Math.abs(r60.q / R.op.q - 1) : Infinity;
    add('X63', 'ESP: water pump Δp = ρ·N·H/144 stage by stage; the sweep row at 60 Hz = the single solve (relative)', w1 < 1e-3 && w2 < 0.005, Math.max(w1, w2), 0.005);
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
    // WP12 (A2): one Duns & Ros traverse, and the page's correlation comparison at the operating point (one evaluation per correlation)
    t0 = nowMs(); V.traverse(F, W, k === 'oilWell' ? 900 : 7000, { from: 'top', p0: 400, corr: 'dr' }); rec('one traverse (Duns & Ros)', k, 1, BUDGET.traverse, nowMs() - t0);
    // WP21 (B): one traverse per new correlation, and a per-section traverse (three correlations along one path: still one march)
    [['ork', 'Orkiszewski'], ['agf', 'Aziz-Govier-Fogarasi'], ['mb', 'Mukherjee-Brill'], ['ansari', 'Ansari'], ['hk', 'Hasan-Kabir']].forEach(([c, n]) => {
      t0 = nowMs(); V.traverse(F, W, k === 'oilWell' ? 900 : 7000, { from: 'top', p0: 400, corr: c }); rec('one traverse (' + n + ')', k, 1, BUDGET.traverse, nowMs() - t0);
    });
    t0 = nowMs(); V.traverse(F, W, k === 'oilWell' ? 900 : 7000, { from: 'top', p0: 400, corr: 'hb', sections: [{ by: 'md', from: 0, to: 2000, corr: 'ansari' }, { by: 'inc', from: 30, to: 180, corr: 'mb' }] });
    rec('one traverse, per-section correlations', k, 1, BUDGET.traverse, nowMs() - t0);
    {
      const R0 = SY.solve(M), keys = (V.list() || []).filter((e) => e.kind === 'any' || e.kind === 'well' || (M.fluid.type !== 'oil' && e.kind === 'gas')).map((e) => e.key);
      const t1 = nowMs();
      keys.forEach((c) => { const Mc = JSON.parse(JSON.stringify(M)); Mc.system.corr.well = c; Mc.system.node = 'bottom'; SY.evalAt(Mc, R0.op.q); });
      rec('correlation comparison (' + keys.length + ' correlations)', k, keys.length, keys.length, nowMs() - t1);
    }
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
  // the enthalpy balance (B, WP22): + one ¼ E predictor traverse per distinct rate (R.counts.pred)
  ['oilWell', 'gasWell'].forEach((k) => {
    const M = S.FIX[k]; M.well.heat.mode = 'enthalpy';
    const t0 = nowMs(); const R = SY.solve(M);
    rec('system solve, enthalpy temperature (' + ((R.counts && R.counts.pred) || 0) + ' predictors)', k, R.evals, R.roots.length > 1 ? BUDGET.solveEnth2 : BUDGET.solveEnth1, nowMs() - t0);
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
    const t1 = nowMs(); const r2 = run(G.WTS_wp_sens.job(M, [{ key: 'wc', values: vals }, { key: 'pr', values: [2600, 3000] }]));
    rec('sensitivity, 2 × 10 cases', 'oilWell', r2 && r2.ok ? r2.evals : 0, BUDGET.sens2x10, nowMs() - t1);
    if (G.WTS_wp_gl && typeof G.WTS_wp_gl.glpc === 'function') {
      const Ml = S.FIX.oilWell; Ml.fluid.wc = 0.6; Ml.res.pr = 2600; Ml.lift = { type: 'gaslift', gl: { qinj_Mscfd: 500, pinj_psig: 1200, sginj: 0.65, dpValve: 100, packerMd: 7800 } };
      const t2 = nowMs(); const g = run(G.WTS_wp_gl.glpc(Ml));
      rec('gas-lift performance curve, 12 points', 'oilWell', g && g.ok ? g.evals : 0, BUDGET.glpc12, nowMs() - t2);
    }
  } else out.push({ op: 'sensitivity, 10 cases', fixture: 'oilWell', evals: null, budget: BUDGET.sens10, ms: null, okE: true, okMs: true, note: 'WTS_wp_sens not merged (WP6)' });
  // B (WP25): the gas-lift valve design on the shared model and a test diagnosis — every WTS_flowline_march call counted as 1 E (the
  // marches of the design run over the hole or part of it; the tool counts them, the app never wraps the function)
  if (G.WTS_wp_gl && typeof G.WTS_wp_gl.design === 'function') {
    const Ml = S.FIX.oilWell; Ml.fluid.wc = 0.6; Ml.res.pr = 2600; Ml.lift = { type: 'gaslift', gl: { qinj_Mscfd: 800, pinj_psig: 1200, sginj: 0.65, dpValve: 100, packerMd: 7800 } };
    const Rl = SY.solve(Ml), orig = G.WTS_flowline_march; let nM = 0;
    G.WTS_flowline_march = function () { nM++; return orig.apply(this, arguments); };
    try {
      let t0 = nowMs(); const Dl = run(G.WTS_wp_gl.design(Ml, Rl)); rec('gas-lift valve design (' + (Dl.ok ? Dl.valves.length : 0) + ' valves, model path)', 'oilWell', nM, BUDGET.glDesign, nowMs() - t0);
      if (Dl.ok) {
        nM = 0; const opv = Dl.valves[Dl.valves.length - 1];
        t0 = nowMs(); G.WTS_wp_gl.diagnose(Ml, Rl, G.WTS_wp_gl.valvesFromDesign(Dl), { chp_psig: opv.pso + 5, thp_psig: Rl.surface.thp_psig, qinj_Mscfd: 800, q_o: Rl.rates.qo, q_w: Rl.rates.qw, q_g: Rl.rates.qg + 800 });
        rec('gas-lift diagnosis of a test', 'oilWell', nM, BUDGET.glDiag, nowMs() - t0);
      }
    } finally { G.WTS_flowline_march = orig; }
  }
  // B (WP24): the injector solve (flow down the path; one root, no q_s) and a two-layer solve
  if (G.WTS_wp_inj) {
    const Mi = S.FIX.gasWell; Mi.fluid = Object.assign(Mi.fluid, { type: 'waterinj', cgr: 0, wgr: 0, sgw: 1.05 }); Mi.res = { model: 'injector', pr: 3200, T_F: 230, params: { II: 4, pfrac: 5200 }, points: [], layers: [] };
    Mi.system.thp_psig = 1200; Mi.surface.choke.present = false; Mi.surface.flowline = [];
    let t0 = nowMs(); const Ri = SY.solve(Mi); rec('injector solve (water, deviated, fracture limit)', 'gasWell', Ri.evals, BUDGET.solve1, nowMs() - t0);
    const Mm = S.FIX.oilWell; Mm.res = { model: 'multilayer', pr: 3000, T_F: 200, params: {}, points: [], layers: [{ name: 'A', topMd: 7800, botMd: 7850, pr: 3100, J: 1.2 }, { name: 'B', topMd: 8150, botMd: 8200, pr: 2400, J: 0.9 }], perf: { midMd: 8000 } };
    t0 = nowMs(); const Rm = SY.solve(Mm); rec('system solve, two layers with crossflow', 'oilWell', Rm.evals, Rm.roots.length > 1 ? BUDGET.solve2 : BUDGET.solve1, nowMs() - t0);
  }
  // B (WP27): envelope, forecast, tornado, matrix, screening, cases
  if (G.WTS_wp_envelope && typeof G.WTS_wp_envelope.job === 'function') {
    ['oilWell', 'gasWell'].forEach((k) => {
      let t0 = nowMs(); const e = run(G.WTS_wp_envelope.job(S.FIX[k])); rec('operating envelope (solve + marches)', k, e.evals || 0, BUDGET.envelope, nowMs() - t0);
    });
    const run3 = (job) => { let s, n = 0; do { s = job.step(); n++; } while (!s.done && n < 3000); return job.result(); };
    let t0 = nowMs(); const fg = run3(G.WTS_wp_forecast.job(S.FIX.gasWell, { mode: 'tank', tank: { G_Bscf: 20 }, horizon_d: 3650, n: 24 })); rec('depletion forecast, gas tank, 24 steps', 'gasWell', fg.evals || 0, BUDGET.forecast24, nowMs() - t0);
    t0 = nowMs(); const fo = run3(G.WTS_wp_forecast.job(S.FIX.oilWell, { mode: 'tank', tank: { N_MMstb: 20 }, horizon_d: 3650, n: 24 })); rec('depletion forecast, oil tank (to lift needed)', 'oilWell', fo.evals || 0, BUDGET.forecast24, nowMs() - t0);
    t0 = nowMs(); const tn = run3(G.WTS_wp_sens.tornado(S.FIX.oilWell)); rec('tornado (' + tn.bars.length + ' variables)', 'oilWell', tn.evals || 0, BUDGET.solve2 + 2 * tn.bars.length * BUDGET.tornadoPerCase, nowMs() - t0);
    t0 = nowMs(); const m4 = run3(G.WTS_wp_sens.job(S.FIX.oilWell, [{ key: 'wc', values: [20, 30, 40] }, { key: 'pr', values: [2800, 3000, 3200] }, { key: 'bean', values: [24, 32, 40] }, { key: 'gor', values: [400, 500, 600] }]));
    rec('sensitivity matrix 3 × 3 × 3 × 3', 'oilWell', m4.evals || 0, BUDGET.matrix81, nowMs() - t0);
    const Ms = S.FIX.oilWell; Ms.fluid.wc = 0.6; Ms.res.pr = 2600;
    t0 = nowMs(); const sc = run3(G.WTS_wp_screen.job(Ms)); rec('lift screening (solve + short performance curve)', 'oilWell', sc.evals || 0, BUDGET.screening, nowMs() - t0);
  }
  // B (WP28): the batch over wells = one full solve per well (no shut-in, no page extras): budget 2 × the two-root solve for 2 wells
  if (G.WTS_wp_batch && typeof G.WTS_wp_batch.job === 'function') {
    const BT = G.WTS_wp_batch, wells = ['oilWell', 'gasWell'].map((k, i) => ({ id: 'w' + (i + 1), name: k, active: i === 0, keys: BT.storedFrom(S.FIX[k]) }));
    const t0 = nowMs(); const r = run(BT.job({ wells }));
    out.push({ op: 'all wells, 2 wells (oil + wet gas)', fixture: 'oilWell', evals: r.evals, budget: 2 * BUDGET.solve2, ms: nowMs() - t0, eMs: E.oilWell,
      cap: 2 * Math.max(E.oilWell, E.gasWell) * Math.max(r.evals, 1), okE: r.evals <= 2 * BUDGET.solve2 + 1e-9, okMs: nowMs() - t0 <= 2 * Math.max(E.oilWell, E.gasWell) * Math.max(r.evals, 1) });
  }
  // B (WP26): the ESP solve (one traverse per evaluation: the intake and discharge segments), stage sizing (≤ 3 evaluations), the
  // rate-against-frequency Job (7 warm solves) and a lift table on the frequency axis (one top-down pumped march per point, reported)
  if (G.WTS_wp_esp && typeof G.WTS_wp_esp.sweep === 'function') {
    const EP = G.WTS_wp_esp, Me = S.FIX.oilWell; Me.res.pr = 2200; Me.fluid.wc = 0.6; Me.lift = { type: 'esp', gl: {}, esp: { pump: EP.example(), pumpMd: 7900, freq: 60, stages: 120 } };
    let t0 = nowMs(); const Re = SY.solve(Me); rec('system solve with an ESP', 'oilWell', Re.evals, Re.roots.length > 1 ? BUDGET.solve2 : BUDGET.solve1, nowMs() - t0);
    t0 = nowMs(); const z = EP.sizeStages(Me, 1100); rec('ESP stages for a rate', 'oilWell', z.evals || 0, BUDGET.espSize, nowMs() - t0);
    t0 = nowMs(); const sw = run(EP.sweep(Me, { freqs: [40, 45, 50, 55, 60, 65, 70] })); rec('ESP rate against frequency, 7 frequencies', 'oilWell', sw.evals || 0, BUDGET.espSweep7, nowMs() - t0);
    t0 = nowMs(); const dz = run(SY.designFor(Me, { freq: 750 })); rec('ESP frequency for a rate (' + (dz.solves || 0) + ' solves)', 'oilWell', dz.evals || 0, BUDGET.design, nowMs() - t0);
    if (G.WTS_wp_export) {
      t0 = nowMs(); const T = G.WTS_wp_export.liftTable(Me, { flo: { type: 'LIQ', values: [400, 800, 1200] }, thp: [150, 300], wfr: { type: 'WCT', values: [0.6] }, gfr: { type: 'GOR', values: [0.5] }, alq: { type: 'FREQ', values: [50, 60] } });
      out.push({ op: 'lift table on the ESP frequency axis, 12 points', fixture: 'oilWell', evals: T.ok ? T.evals : null, budget: null, ms: nowMs() - t0, eMs: E.oilWell, cap: 2 * E.oilWell * Math.max(T.evals || 1, 1), okE: true, okMs: true, note: 'reported only' });
    }
  }
  // VLP tuning (A2, WP17; §5.2): PRiSM_lm on the gauge residuals — each residual is one wellhead → gauge march (counted as 1 E;
  // no flowline). Reported only: §16 has no tuning budget.
  const tuneStub = (G.__WP_STUBS || []).indexOf('WTS_wp_match.tune') !== -1;
  if (!tuneStub && G.WTS_wp_match && typeof G.WTS_wp_match.tune === 'function') {
    const M = S.FIX.oilWell, t = S.FIX.test1;
    let t0 = nowMs(); const r1 = G.WTS_wp_match.tune(M, [t], 'bb');
    out.push({ op: 'VLP tuning, 1 test (m_h)', fixture: 'oilWell', evals: r1 && r1.lm ? r1.lm.nEval : null, budget: null, ms: nowMs() - t0, okE: true, okMs: true, note: 'reported only' });
    // three self-consistent tests over 3:1 in rate whose gauges are the Beggs & Brill answer at m_h 1.08, m_f 1.15
    const mk = (id, qo) => { const t2 = Object.assign(S.FIX.test1, { id, q_o: qo, q_w: qo * 3 / 7, q_g: qo * 0.5 });
      t2.gauge_psia = G.WTS_wp_match.compare(M, t2, ['bb'], { mult: { hl: 1.08, f: 1.15 }, profiles: false }).rows[0].pCalc; return t2; };
    const ts = [mk('A', 350), mk('B', 700), mk('C', 1100)];
    t0 = nowMs(); const r3 = G.WTS_wp_match.tune(M, ts, 'bb', { free: ['hl', 'f'] });
    out.push({ op: 'VLP tuning, 3 tests (m_h, m_f)', fixture: 'oilWell', evals: r3 && r3.lm ? r3.lm.nEval : null, budget: null, ms: nowMs() - t0, okE: true, okMs: true, note: 'reported only' });
  }
  // B (WP23): the solves with the modified black oil (gas) and an emulsion (oil) keep the solve budget; the lab-match Job is property
  // evaluations only (no march) — reported
  if (G.WTS_wp_pvtmatch) {
    const P = G.WTS_wp_pvtmatch, Mg = S.FIX.gasWell; Mg.fluid.rv = { mode: 'table', pd: 4200, rows: P.exampleRv(20, 4200) };
    let t0 = nowMs(); const Rg = SY.solve(Mg); rec('system solve, modified black oil (Rv)', 'gasWell', Rg.evals, Rg.roots.length > 1 ? BUDGET.solve2 : BUDGET.solve1, nowMs() - t0);
    const Mo = S.FIX.oilWell; Mo.fluid.emul = { model: 'woelflin', tight: 'medium', inv: 0.6 };
    t0 = nowMs(); const Ro = SY.solve(Mo); rec('system solve, emulsion viscosity', 'oilWell', Ro.evals, Ro.roots.length > 1 ? BUDGET.solve2 : BUDGET.solve1, nowMs() - t0);
    const sp = { type: 'oil', api: 35, sgg: 0.75, gor: 600, psep_psig: 100, tsep_F: 80 }, lab = P.example(sp, 200);
    t0 = nowMs(); const j = run(P.job(sp, lab));
    out.push({ op: 'PVT lab match Job (9 points, ranking)', fixture: 'oilWell', evals: null, budget: null, ms: nowMs() - t0, okE: true, okMs: true, note: 'reported only: ' + (j && j.evals) + ' property evaluations, no march' });
  }
  // B (WP20) lift-curve tables: one traverse per point (the evaluation count is the stable gate). Measured on 800 points (10 rates × 5 THP ×
  // 4 WC × 4 GOR, FIX.oilWell); the §9 3,200-point table is that per-point time × 3,200 against its own 60 s cap (§16).
  const XP = G.WTS_wp_export;
  if (XP && typeof XP.liftTable === 'function') {
    const M = S.FIX.oilWell, sp = XP.suggest(M, SY.solve(M));
    const t0 = nowMs(); const T = XP.liftTable(M, sp); const ms = nowMs() - t0;
    rec('lift table, 800 points (10 × 5 × 4 × 4)', 'oilWell', T.ok ? T.evals : 0, BUDGET.lift800, ms);
    const per = ms / Math.max(1, T.n);
    out.push({ op: 'lift table, 3,200 points (projected)', fixture: 'oilWell', evals: T.ok ? T.evals / T.n * 3200 : null, budget: BUDGET.lift3200, ms: per * 3200, eMs: E.oilWell, cap: LIFT3200_MS,
      okE: !!T.ok && T.evals / T.n * 3200 <= BUDGET.lift3200 + 1e-9, okMs: per * 3200 <= LIFT3200_MS });
    const Ml = S.FIX.oilWell; Ml.fluid.wc = 0.6; Ml.res.pr = 2600; Ml.lift = { type: 'gaslift', gl: { qinj_Mscfd: 500, pinj_psig: 1200, sginj: 0.65, dpValve: 100, packerMd: 7800 } };
    const sl = { flo: { type: 'OIL', values: [100, 300, 500, 700, 900] }, thp: [150, 300, 450], wfr: { type: 'WCT', values: [0.6] }, gfr: { type: 'GOR', values: [0.5] }, alq: { type: 'GRAT', values: [0, 250, 500, 1000] } };
    const t1 = nowMs(); const TL = XP.liftTable(Ml, sl);
    out.push({ op: 'lift table with lift gas, 60 points (3 of 4 lifted)', fixture: 'oilWell', evals: TL.ok ? TL.evals : null, budget: null, ms: nowMs() - t1, eMs: E.oilWell, cap: 2 * E.oilWell * Math.max(TL.evals || 1, 1), okE: true, okMs: true, note: 'reported only' });
  }
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
    c.rows.forEach((r) => console.log('  ' + (r.ok ? 'PASS' : 'FAIL') + '  ' + r.id.padEnd(5) + r.name + '  [' + _fmt(r.value, 4) + ' / tol ' + _fmt(r.tol, 4) + ']'));
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
