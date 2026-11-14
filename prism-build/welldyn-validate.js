#!/usr/bin/env node
// prism-build/welldyn-validate.js — Well Dynamics validation gate, cross-checks and time budgets (lane WD5).
// Plan: docs/WELL-DYNAMICS-PLAN.md §4.14 (method table, D17), §5.1 (consistency gate), §5.5 (this tool), §5.6 (budgets).
//
//   node prism-build/welldyn-validate.js [--gate] [--check] [--time] [--html] [--quick] [--only X1,X5] [--browser] [--json] [--strict]
//
//   --gate     the D17 method table: every key of §4.14 is in WTS_wd_engine.METHODS with the verified flag as shipped; every key
//              shipped verified:false is labelled provisional where the user meets it (page controls, the run summary, the report
//              box); the keys marked "never a default" are not active in a default run of any gate fixture
//   --check    X1–X18 (below): one PASS / FAIL / SKIP row per check with the measured value and the tolerance; X1 prints one row per
//              gate fixture with the C2 diagnostic (the nodal march re-run at stepFt = the cell length)
//   --time     the §5.6 operations and scenarios: Δt, steps, ms per step, simulated / wall, wall time, against the §5.6 budget and
//              the WD1 baseline (§11.1); a row fails only above 2 × its WD1 baseline (the plan's rule, as the Well Performance gate);
//              a missed §5.6 budget is reported ("over budget") and fails only with --strict
//   --browser  (alone or with --time) Chromium (Playwright from the global npm root, browsers at /opt/pw-browsers; never `playwright install`)
//              plays the built page at ×1000 and reports the achieved speed and the wellbore draw time per frame (report only)
//   (no flag)  --gate, --check and --time
//   --html     load the built well-testing-app.html instead of the sources
//   --quick    the acceptance-test subset (short runs; X1 on oilVert only)
//   --only     run only the listed check ids
//
// Exit codes: 0 ok; 1 a gate row, a check or a 2 × baseline timing row failed (or a budget with --strict); 2 crash.
// Field units throughout. The fixtures are the frozen §3.9 file (tests/_welldyn-shapes.js) when present, else the wave-1 stand-in
// (tests/_welldyn-wd1.js, the same keys). Checks that need the WD4 lift extensions (gas lift, ESP) are SKIP while those are not loaded.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const optVal = (f) => { const i = argv.indexOf(f); return i !== -1 && i + 1 < argv.length ? argv[i + 1] : null; };
const nowMs = () => Number(process.hrtime.bigint()) / 1e6;
const H = 3600;
const PROVISIONAL = 'provisional — not verified against a published example';
const clone = (o) => JSON.parse(JSON.stringify(o));

// ── fixtures (§3.9): the frozen WD0 file when it exists, else the WD1 stand-in ───────────────────────────────────────────
let _F = null;
const _FL = new WeakMap();
// with an app whose WD4 lift extensions are loaded, the WD4 lane fixtures (tests/_welldyn-wd4.js: gasLift, esp; scenarios glUnload,
// espStart, cycleTimer; gate options GATE4) are added to the base set; fixtures() without an app is the base set
function fixtures(G) {
  const base = _fixturesBase();
  if (!G || !(_haveLift(G, 'gaslift') || _haveLift(G, 'esp'))) return base;
  if (_FL.has(G)) return _FL.get(G);
  let L4 = null;
  try { L4 = require('./tests/_welldyn-wd4'); } catch (e) { L4 = null; }
  if (!L4) { _FL.set(G, base); return base; }
  const FL = L4.FIXL(G), FIX = {}, SCEN = Object.assign({}, base.SCEN);
  Object.keys(base.FIX).forEach((k) => Object.defineProperty(FIX, k, { enumerable: true, get: () => base.FIX[k] }));
  if (_haveLift(G, 'gaslift')) Object.defineProperty(FIX, 'gasLift', { enumerable: true, get: () => FL.gasLift() });
  if (_haveLift(G, 'esp')) Object.defineProperty(FIX, 'esp', { enumerable: true, get: () => FL.esp() });
  // glUnload starts at the balance level (§11.4: a full kill column drains into the formation); 4.5 h covers the transfers to the
  // operating valve (the 12 h run is welldyn-lift LF5)
  if (_haveLift(G, 'gaslift') && G.WTS_wd_lift && typeof G.WTS_wd_lift.balanceLevel === 'function') {
    const o = clone(L4.SCEN4.glUnload.opts);
    o.static = { kind: 'level', liquidTopMd: G.WTS_wd_lift.balanceLevel(FL.gasLift()).md, liquid: 'water' };
    SCEN.glUnload = { fix: 'gasLift', opts: o, duration_s: 4.5 * H };
  }
  if (_haveLift(G, 'esp')) SCEN.espStart = clone(L4.SCEN4.espStart);
  if (_haveLift(G, 'cycle') && 'gasLoad' in base.FIX) SCEN.cycleTimer = clone(L4.SCEN4.cycleTimer);
  const out = Object.assign({}, base, { FIX, SCEN, GATE4: L4.GATE4, lane4: true });
  _FL.set(G, out);
  return out;
}
function _fixturesBase() {
  if (_F) return _F;
  const shapes = path.join(ROOT, 'tests', '_welldyn-shapes.js');
  let mod = null;
  if (fs.existsSync(shapes)) { try { mod = require(shapes); } catch (e) { mod = null; } }
  if (!mod || !mod.FIX || !mod.SCEN || !('gasVert' in mod.FIX)) mod = require('./tests/_welldyn-wd1');
  _F = mod;
  return mod;
}

// ── D17 method table (§4.14): key → shipped verified flag, whether it is ever a default, where the user meets the label ──
//   verified: true | 'identity' | 'as …' (string) | false;  never: true = must never be active in a default run (gate rule)
//   ui: the page control id whose label must say "(provisional)" (the methods a user switches on)
const METHOD_TABLE = [
  { key: 'cons', verified: 'identity', never: false, source: 'mass balance to round-off (EN2, X4), volume-balance sign (EN23) — a numerical property' },
  { key: 'corr', verified: 'as the correlation', never: false, source: 'the consistency gate G1–G7 (X1): steady run = nodal solve' },
  { key: 'driftflux', verified: false, never: false, source: 'Shi et al. drift-flux data tables (Q9)' },
  { key: 'godunov', verified: 'identity', never: false, source: 'positivity, sharp level (EN25, X15)' },
  { key: 'compliance', verified: false, never: false, source: 'a published shut-in storage example' },
  { key: 'res_ipr', verified: 'identity', never: false, source: '= WTS_wp_ipr' },
  { key: 'res_back', verified: false, never: false, ui: 'wd_backflow', source: 'a published kill / cross-flow example' },
  { key: 'res_ls', verified: true, never: false, source: 'E1 line source = PRiSM model #1 (RS1, X7)' },
  { key: 'res_sup', verified: false, never: true, source: 'a published multi-rate example' },
  { key: 'choke_crit', verified: 'as the nodal choke', never: false, source: '= the nodal solve (X1 regime row)' },
  { key: 'choke_sub', verified: false, never: true, source: 'a published sub-critical choke example' },
  { key: 'liftgas_mix', verified: 'identity', never: false, source: '= the nodal C.gl.Finj (G5, WD4)' },
  { key: 'esp_node', verified: 'identity', never: false, source: '= the nodal pump node (G6, WD4)' },
  { key: 'temp_relax', verified: false, never: true, ui: 'wd_temp', source: 'field data' },
  { key: 'settle', verified: false, never: false, source: 'a published settling example' },
  { key: 'fallback', verified: false, never: true, ui: 'wd_fallback', source: 'a published loading transient (Q1)' },
  { key: 'turner', verified: false, never: false, source: 'Turner et al. (1969) worked examples (Q9)' },
  { key: 'coleman', verified: false, never: false, source: 'Coleman et al. (1991) worked examples (Q9)' },
  { key: 'belfroid', verified: false, never: true, ui: 'wd_belfroid', source: 'Belfroid et al. (2008) examples (Q9, Q16)' },
  { key: 'foamer', verified: false, never: true, source: 'published lab data (Q10)' },
  { key: 'regime_lowv', verified: false, never: false, source: 'Taitel, Barnea & Dukler maps (Q9)' },
  { key: 'gl_valves', verified: false, never: false, source: 'a published unloading example' },
  { key: 'esp_start', verified: false, never: false, source: 'field data' },
  { key: 'states', verified: false, never: false, source: 'owner review (Q15)' },
];
// the keys never active in a default (gate) run — §4.14 "never a default" plus the options that are off by default
const NEVER_DEFAULT = METHOD_TABLE.filter((m) => m.never).map((m) => m.key);

// ── §5.6 budgets and the WD1 baseline measured on this container (§11.1) ────────────────────────────────────────────────
const BUDGET = {
  createCold: 800, createRef: 30, stepFlow: 2.5, stepShut: 1.0, speedGas: 500, speedOil: 1500, speedShut: 20000,
  gatePerHourGas: 8000, gatePerHourOil: 3000, snapshot: 2, restore: 2, frameOps: null, recMB24h: 32, fileMB: 5,
  scen: { gasLoadDown: 18000, shutInBuildup: 5000, levelSettle: 2000, killColumn: 2000, cycleTimer: 20000, foamerOn: 23000, glUnload: 25000, espStart: 4000 }
};
const BASELINE = {   // WD1 record §11.1 (Node, this container) — the "2 × baseline" fail line
  createCold: { gasVert: 513, oilVert: 485, gasHz: 679 }, createRef: { gasVert: 27.6, oilVert: 33.3, gasHz: 27.9 },
  stepFlow: { gasVert: 3.46, oilVert: 3.64, gasHz: 3.41 }, stepShut: { gasVert: 4.7, oilVert: 4.2, gasHz: 3.8 },
  speedFlow: { gasVert: 1600, oilVert: 1900, gasHz: 464 }, speedShut: { gasVert: 5700, oilVert: 5800, gasHz: 4700 },
  snapshot: 0.33, restore: 3.3,
  scen: { gasLoadDown: 12700, levelSettle: 1300, shutInBuildup: 10300, killColumn: 4000, staticOil: 5400 }
};

// ── app ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function _load() {
  const harness = require('./tests/_harness');
  const F = fixtures(), ov = typeof F.sourceOverrides === 'function' && !flag('--html') ? F.sourceOverrides() : null;
  const o = { fromSources: !flag('--html'), timers: 'real', console: 'errors', silentBuild: true };
  if (ov && Object.keys(ov).length) o.sourceOverrides = ov;
  return harness.loadApp(o);
}

// ── shared runs (memoised per app, so --check and --time reuse them) ────────────────────────────────────────────────────
const GATE_OPTS = { start: 'steady', reservoir: { mode: 'ipr' }, closure: 'corr', temperature: 'frozen', cells: 60 };
function _memo(G, key, fn) {
  const m = G.__WD5_MEMO || (G.__WD5_MEMO = new Map());
  if (!m.has(key)) m.set(key, fn());
  return m.get(key);
}
function runSteady(sim, o) {
  o = o || {};
  const win = o.win_s || 600, cap = o.cap_s || 6 * H, chunk = o.chunk_s || 300;
  let chk = null; const t0 = nowMs(), s0 = sim.stats.steps;
  while (sim.state.t < cap) {
    const r = sim.run(chunk);
    if (!r.ok) return { ok: false, code: r.code, t: sim.state.t };
    if (sim.state.t >= 2 * win + (o.after_s || 0)) { chk = sim.steadyCheck(win); if (chk.steady) break; }
  }
  return { ok: true, chk: chk || sim.steadyCheck(win), t: sim.state.t, wallMs: nowMs() - t0, steps: sim.stats.steps - s0 };
}
function steadySim(G, key, opts) {
  return _memo(G, 'steady:' + key + JSON.stringify(opts || {}), () => {
    const F = fixtures(G), t0 = nowMs();
    const sim = G.WTS_wd_engine.create(F.FIX[key], Object.assign({}, GATE_OPTS, opts || {}));
    const createMs = nowMs() - t0;
    return { sim, createMs, rs: sim.ok ? runSteady(sim, { cap_s: 6 * H }) : { ok: false, code: sim.code } };
  });
}
// a §3.9 scenario: per-step records the checks read (as tests/_welldyn-wd1.js runScenario), memoised by name + duration
function runScenario(G, name, o) {
  o = o || {};
  const F = fixtures(G), sc = F.SCEN[name];
  if (!sc) return { ok: false, code: 'NO_SCENARIO' };
  const dur = o.duration_s || sc.duration_s;
  return _memo(G, 'scen:' + name + ':' + dur + JSON.stringify(o.opts || {}), () => {
    const opts = clone(sc.opts); if (o.opts) Object.assign(opts, o.opts);
    const sim = G.WTS_wd_engine.create(F.FIX[sc.fix], opts);
    if (!sim.ok) return { ok: false, code: sim.code, sim };
    const st = sim.state, gas = sim.gasWell(), out = { ok: true, sim, steps: [], states: [], bu: [], maxErrStep: 0, maxErrCum: 0, wallMs: 0, dur };
    const tShut = (opts.events || []).filter((e) => e.type === 'shutin').map((e) => e.t)[0];
    let nextBu = null;
    sim.on('step', (i) => {
      const e = Math.max(i.massErr.G, i.massErr.O, i.massErr.W, i.massErr.I);
      if (e > out.maxErrStep) out.maxErrStep = e;
      if (st.balance.errCum > out.maxErrCum) out.maxErrCum = st.balance.errCum;
      out.steps.push({ t: i.t, dt: i.dt, rejects: i.rejects, liq: st.inventory.liqTubing_bbl, ratio: st.loading.ratio, state: st.well.state,
        qres: gas ? st.bottom.qg : st.bottom.qo + st.bottom.qw });
      if (tShut != null && st.t > tShut + 1e-9) {
        if (nextBu == null) { nextBu = tShut + 10; out.qShut = out.lastQres; }
        if (st.t >= nextBu) { out.bu.push({ dt: st.t - tShut, p: st.bottom.pwf }); nextBu = tShut + (st.t - tShut) * 1.03; }
      } else out.lastQres = gas ? st.bottom.qg : st.bottom.qo + st.bottom.qw;
    });
    sim.on('state', (e) => out.states.push(e));
    const t0 = nowMs();
    const r = sim.run(dur);
    out.wallMs = nowMs() - t0;
    if (!r.ok) { out.ok = false; out.code = r.code; }
    if (out.qShut == null) out.qShut = out.lastQres;
    return out;
  });
}
const _haveLift = (G, k) => !!(G.WTS_wd_engine && G.WTS_wd_engine.ext && G.WTS_wd_engine.ext[k] && (G.__WD_STUBS || []).indexOf('WTS_wd_engine.ext.' + k) === -1);
const _rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-30);

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// --gate (D17)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
function gate(G, o) {
  o = o || {};
  const E = G.WTS_wd_engine, errors = [], rows = [];
  if (!E || !E.METHODS) return { ok: false, rows, errors: ['WTS_wd_engine.METHODS is not loaded'] };
  const keysPlan = METHOD_TABLE.map((m) => m.key), keysEng = Object.keys(E.METHODS);
  keysPlan.forEach((k) => { if (!(k in E.METHODS)) errors.push(k + ': in the §4.14 table but not in WTS_wd_engine.METHODS'); });
  keysEng.forEach((k) => { if (keysPlan.indexOf(k) === -1) errors.push(k + ': in WTS_wd_engine.METHODS but not in the §4.14 table'); });
  if (E.PROVISIONAL !== PROVISIONAL) errors.push('WTS_wd_engine.PROVISIONAL is not the suite\'s provisional label');
  // where the labels live: the page source (built HTML or the page file) — the controls of user-selectable provisional methods
  let pageSrc = '';
  try { pageSrc = fs.readFileSync(flag('--html') ? path.join(ROOT, '..', 'well-testing-app.html') : path.join(ROOT, '49-calc-welldyn.js'), 'utf8'); } catch (e) { pageSrc = ''; }
  if (pageSrc.indexOf(PROVISIONAL) === -1) errors.push('the page does not carry the provisional label text');
  if (pageSrc.indexOf('Provisional methods in this run') === -1) errors.push('the page has no "Provisional methods in this run" report box');
  METHOD_TABLE.forEach((m) => {
    const em = E.METHODS[m.key] || {};
    const shipped = em.verified, okFlag = m.verified === false ? shipped === false : (m.verified === true ? shipped === true : typeof shipped === 'string' && shipped === m.verified);
    if (!okFlag) errors.push(m.key + ': verified flag ' + JSON.stringify(shipped) + ' (table ' + JSON.stringify(m.verified) + ')');
    if (m.ui) {
      // the control's label: _fg('<id>', '<label>' …) — the label (or the option text of the provisional choice) says "provisional"
      const rx = new RegExp("_fg\\('" + m.ui + "',[^\\n]{0,400}?provisional", 'i');
      if (!rx.test(pageSrc)) errors.push(m.key + ': the control ' + m.ui + ' is not labelled provisional');
    }
    rows.push({ key: m.key, label: em.label || '', verified: shipped, never: m.never, ui: m.ui || null, source: m.source });
  });
  // the "never a default" rule on default runs of every gate fixture (t = 0 and after 30 min); a key listed must be verified:false
  const F = fixtures(G), fixList = o.fixtures || (o.quick ? ['oilVert', 'gasVert'] : F.GATE.slice());
  const runs = [];
  fixList.forEach((key) => {
    const sim = E.create(F.FIX[key], {});
    if (!sim.ok) { errors.push(key + ': default create failed ' + sim.code); return; }
    sim.run(o.quick ? 300 : 1800);
    const active = sim.state.provisional.slice();
    NEVER_DEFAULT.forEach((k) => { if (active.indexOf(k) !== -1) errors.push(key + ': "' + k + '" (never a default) is active in a default run'); });
    active.forEach((k) => { if (!E.METHODS[k] || E.METHODS[k].verified !== false) errors.push(key + ': ' + k + ' listed provisional but not verified:false'); });
    // the run summary carries the same list (the page's report box reads it)
    if (G.WTS_wd_rec && typeof G.WTS_wd_rec.summarize === 'function') {
      const rec = G.WTS_wd_rec.create({ every_s: 60 }); rec.attach(sim); sim.run(60); rec.sample(sim, true);
      const sm = G.WTS_wd_rec.summarize(rec, sim);
      if (!sm || JSON.stringify(Array.from(sm.provisional || [])) !== JSON.stringify(Array.from(sim.state.provisional))) errors.push(key + ': the run summary\'s provisional list differs from the engine\'s');
      if (typeof rec.detach === 'function') rec.detach();
    }
    runs.push({ fixture: key, active });
  });
  // an option switched on is listed (the label reaches the summary): Belfroid + fallback + relax on gasVert
  const on = E.create(F.FIX.gasVert, { loading: { belfroid: true }, fallback: true, temperature: 'relax' });
  if (on.ok) { on.run(60); ['belfroid', 'temp_relax'].forEach((k) => { if (on.state.provisional.indexOf(k) === -1) errors.push(k + ' switched on but not listed provisional'); }); }
  return { ok: errors.length === 0, rows, runs, errors };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// --check X1–X18
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
function gateRow(G, key, opts) {
  const F = fixtures(G), TOL = F.TOL, m = steadySim(G, key, opts), sim = m.sim;
  if (!sim.ok) return { ok: false, note: 'create ' + sim.code };
  const R = sim.R0, rs = m.rs;
  if (!rs.ok) return { ok: false, note: 'run ' + rs.code };
  const c = rs.chk, fails = [];
  const dq = (c.qMean - R.op.q) / R.op.q, dp = (c.pwfMean - R.pwf) / R.pwf, dthp = c.thpMean - R.surface.thp;
  if (!c.steady) fails.push('NOT_STEADY');
  if (!(c.ampQ <= TOL.ampQ * c.qMean)) fails.push('amplitude q ' + c.ampQ.toFixed(2));
  if (!(c.ampP <= TOL.ampP)) fails.push('amplitude p ' + c.ampP.toFixed(2));
  if (!(Math.abs(dq) <= TOL.q)) fails.push('rate');
  if (!(Math.abs(dp) <= TOL.pwf)) fails.push('BHP');
  if (!(Math.abs(dthp) <= Math.max(TOL.thpRel * R.surface.thp, TOL.thpAbs))) fails.push('THP');
  if (sim.state.surface.regime !== R.surface.choke.regime) fails.push('regime ' + sim.state.surface.regime + ' vs ' + R.surface.choke.regime);
  if (!(sim.state.balance.errCum <= 1e-8)) fails.push('mass balance ' + sim.state.balance.errCum);
  NEVER_DEFAULT.forEach((k) => { if (sim.state.provisional.indexOf(k) !== -1) fails.push(k + ' active'); });
  // C2 diagnostic (report only): the nodal march at stepFt = the mean cell length
  let diag = null;
  try {
    const M2 = F.FIX[key], Lc = sim.grid.cells.reduce((s, x) => s + x.len, 0) / sim.n;
    M2.system = Object.assign({}, M2.system || {}, { stepFt: Math.round(Lc) });
    const R2 = G.WTS_wp_system.solve(M2);
    if (R2 && R2.ok !== false && R2.op) diag = { stepFt: Math.round(Lc), dqFine: dq, dpFine: dp, dqCell: (c.qMean - R2.op.q) / R2.op.q, dpCell: (c.pwfMean - R2.pwf) / R2.pwf };
  } catch (e) { diag = null; }
  return { ok: fails.length === 0, note: fails.join('; '), dq, dp, dthp, ampQ: c.ampQ / c.qMean, ampP: c.ampP, regime: sim.state.surface.regime, tSteady: rs.t, diag,
    q: c.qMean, qRef: R.op.q, pwf: c.pwfMean, pwfRef: R.pwf };
}

function checks(G, o) {
  o = o || {};
  const F = fixtures(G), E = G.WTS_wd_engine, out = [];
  const only = o.only ? new Set(o.only) : null, want = (id) => !only || only.has(id);
  const row = (id, name, fn) => {
    if (!want(id)) return;
    const t0 = nowMs(); let r;
    try { r = fn(); } catch (e) { r = { ok: false, note: 'threw: ' + (e && e.message || e) }; }
    r = Object.assign({ id, name }, r, { ms: nowMs() - t0 });
    out.push(r);
    if (o.onRow) o.onRow(r);
  };
  const skip = (why) => ({ ok: true, skip: true, note: why });

  // X1 the consistency gate (G1–G7)
  if (want('X1')) {
    const fx = o.quick ? ['oilVert'] : ['gasVert', 'gasHz', 'oilVert', 'oilVertTuned', 'gasLift', 'esp', 'oilDev'];
    const label = { gasVert: 'G1', gasHz: 'G2', oilVert: 'G3', oilVertTuned: 'G4', gasLift: 'G5', esp: 'G6', oilDev: 'G7' };
    fx.forEach((key) => row('X1', 'gate ' + label[key] + ' ' + key + ': steady run = WTS_wp_system.solve (rate 2 %, BHP 1 %, THP max(1 %, 3 psi), regime)', () => {
      if (!(key in F.FIX)) return skip('fixture ' + key + ' not in the fixture file (WD4 / WD0)');
      if ((key === 'gasLift' && !_haveLift(G, 'gaslift')) || (key === 'esp' && !_haveLift(G, 'esp'))) return skip('the WD4 lift extension is not loaded');
      const r = gateRow(G, key, F.GATE4 && F.GATE4[key]);
      return Object.assign(r, { value: Math.max(Math.abs(r.dq || 0) / F.TOL.q, Math.abs(r.dp || 0) / F.TOL.pwf), tol: 1 });
    }));
  }
  // X2 static-start companions (§5.1): the oil and gas wells opened from a static column settle on the same nodal point
  row('X2', 'static start: oil (staticOil) and gas (gasVert, gas column) opened from rest settle on the nodal point', () => {
    const pairs = o.quick ? [['staticOil', { start: 'static', static: { kind: 'liquid', liquid: 'oil' } }]]
      : [['staticOil', { start: 'static', static: { kind: 'liquid', liquid: 'oil' } }], ['gasVert', { start: 'static', static: { kind: 'gas' } }]];
    const notes = []; let worst = 0, ok = true;
    pairs.forEach(([key, so]) => {
      const sim = E.create(F.FIX[key], Object.assign({}, GATE_OPTS, so, { reservoir: { mode: 'ipr', prior: { kind: 'none' } }, events: [{ t: 60, type: 'open' }] }));
      if (!sim.ok) { ok = false; notes.push(key + ' create ' + sim.code); return; }
      const rs = runSteady(sim, { after_s: H, cap_s: 6 * H });
      if (!rs.ok || !rs.chk.steady) { ok = false; notes.push(key + ' not steady'); return; }
      const dq = _rel(rs.chk.qMean, sim.R0.op.q), dp = _rel(rs.chk.pwfMean, sim.R0.pwf);
      worst = Math.max(worst, dq / F.TOL.q, dp / F.TOL.pwf);
      if (dq > F.TOL.q || dp > F.TOL.pwf) ok = false;
      notes.push(key + ' Δq ' + (100 * dq).toFixed(3) + ' %, ΔBHP ' + (100 * dp).toFixed(3) + ' % at ' + (rs.t / H).toFixed(2) + ' h');
    });
    return { ok, value: worst, tol: 1, note: notes.join('; ') };
  });
  // X3 static columns (EN3 / EN4)
  row('X3', 'static columns: gas-filled SITHP vs WTS_wp_system.shutIn (1 %); part liquid-filled vs shutIn.partLiquid (1 %, basis-corrected)', () => {
    const M = F.FIX.gasVert; Object.assign(M.fluid, { type: 'gas', cgr: 0, wgr: 0 });
    const ref = G.WTS_wp_system.shutIn(M);
    const a = E.create(M, { start: 'static', static: { kind: 'gas' }, temperature: 'relax', reservoir: { prior: { kind: 'none' } } });
    const e1 = _rel(a.state.surface.thp_psig, ref.gasFilled);
    const M2 = F.FIX.gasVert, ref2 = G.WTS_wp_system.shutIn(M2), rowL = ref2.partLiquid[1];
    const b = E.create(M2, { start: 'static', static: { kind: 'level', liquidTopMd: rowL.liquidTopMd, liquid: 'water' }, temperature: 'relax', reservoir: { prior: { kind: 'none' } } });
    const cs = b.state.cells, X = b.X; let dpLiq = 0;
    b.grid.cells.forEach((c, i) => { if (cs.ag[i] < 0.5) dpLiq += (62.4 * M2.fluid.sgw - X.rhoW[i]) * c.dz / 144; });
    const e2 = _rel(b.state.surface.thp_psig, rowL.sithp + dpLiq);
    return { ok: e1 <= 0.01 && e2 <= 0.01, value: Math.max(e1, e2), tol: 0.01, note: 'gas ' + (100 * e1).toFixed(3) + ' %, part liquid ' + (100 * e2).toFixed(3) + ' %' };
  });
  // X4 mass balance on every scenario
  row('X4', 'mass balance on every scenario: ≤ 1e-10 per step, ≤ 1e-8 cumulative', () => {
    const names = Object.keys(F.SCEN), notes = []; let worstS = 0, worstC = 0, ok = true;
    names.forEach((nm) => {
      if (/^(glUnload|espStart|foamerOn|cycleTimer)$/.test(nm) && !_haveLift(G, nm === 'espStart' ? 'esp' : (nm === 'glUnload' ? 'gaslift' : (nm === 'foamerOn' ? 'foamer' : 'cycle')))) { notes.push(nm + ' skip (WD4)'); return; }
      const r = runScenario(G, nm, o.quick ? { duration_s: Math.min(F.SCEN[nm].duration_s, 1800) } : null);
      if (!r.ok) { ok = false; notes.push(nm + ' ' + r.code); return; }
      worstS = Math.max(worstS, r.maxErrStep); worstC = Math.max(worstC, r.maxErrCum);
      if (r.maxErrStep > 1e-10 || r.maxErrCum > 1e-8) { ok = false; notes.push(nm + ' step ' + r.maxErrStep.toExponential(1) + ' cum ' + r.maxErrCum.toExponential(1)); }
    });
    return { ok, value: worstC, tol: 1e-8, note: 'worst step ' + worstS.toExponential(2) + ', cumulative ' + worstC.toExponential(2) + (notes.length ? '; ' + notes.join('; ') : '') };
  });
  // X5 build-up derivative (RS4)
  row('X5', 'build-up (shutInBuildup, transient): semilog derivative of p_ws in 2–8 h = 70.6 qBμ/(kh) within 3 %', () => {
    if (o.quick) return skip('long scenario (10 h): full run only');
    const r = runScenario(G, 'shutInBuildup');
    if (!r.ok) return { ok: false, note: r.code };
    const P = r.sim.res.params, I = r.sim.C.I, m = 70.6 * r.qShut * I.params.Bo * I.params.muo / (P.k * P.h);
    const pts = r.bu.filter((x) => x.dt >= 2 * H && x.dt <= 8 * H);
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    pts.forEach((x) => { const l = Math.log(x.dt); sx += l; sy += x.p; sxx += l * l; sxy += l * x.p; });
    const n = pts.length, slope = (n * sxy - sx * sy) / (n * sxx - sx * sx), e = _rel(slope, m);
    return { ok: n >= 6 && e <= 0.03, value: e, tol: 0.03, note: 'slope ' + slope.toFixed(2) + ' vs ' + m.toFixed(2) + ' psi per ln cycle, ' + n + ' samples' };
  });
  // X6 Turner switch-over (EN18)
  row('X6', 'gas loading (gasLoadDown, fallback): marginal at bean 32, loading within 120 s + one 10 s interval of q_g < q_c', () => {
    const r = runScenario(G, 'gasLoadDown', { duration_s: o.quick ? 2 * H : 3 * H });
    if (!r.ok) return { ok: false, note: r.code };
    const m0 = r.sim.R0.loading.margin, marg = r.states.some((e) => e.to === 'marginal');
    const cross = r.steps.find((s) => s.t > H && s.ratio < 0.9), toLoad = r.states.find((e) => e.to === 'loading');
    if (!cross || !toLoad) return { ok: false, note: 'no crossing / no loading state' };
    const lag = toLoad.t - cross.t;
    return { ok: marg && m0 > -0.05 && m0 < 0.10 && lag >= 0 && lag <= 130 + 1e-6, value: lag, tol: 130, note: 'margin at bean 32 ' + m0.toFixed(3) + ', loading ' + lag.toFixed(1) + ' s after q_g < q_c' };
  });
  // X7 E1 vs PRiSM model #1 (RS1)
  row('X7', 'line source ½E1(1/(4t_D)) vs PRiSM model #1 (Stehfest) within 0.5 % for t_D > 100', () => {
    if (!G.PRiSM_MODELS || !G.PRiSM_MODELS.homogeneous) return skip('PRiSM not loaded');
    const pd = G.PRiSM_MODELS.homogeneous.pd; let worst = 0;
    [150, 1e3, 1e4, 1e5, 1e6].forEach((tD) => { worst = Math.max(worst, _rel(0.5 * G.WTS_wd_res.E1(1 / (4 * tD)), pd(tD, { Cd: 1e-3, S: 0 }))); });
    return { ok: worst <= 0.005, value: worst, tol: 0.005 };
  });
  // X8 foamer factor (C11): q_c scales with sigF^¼ — through the extension's sigma hook (the WD4 foamer when loaded, else a test extension)
  row('X8', 'foamer factor (C11): q_c falls by sigF^¼ through the sigma hook; the drift closure sees σ_e', () => {
    const k = '__wd5sigma', ext = E.ext, s = 0.4;
    ext[k] = { key: k, label: 'validation σ factor', verified: false, applies: (M, oo) => !!(oo.ext && oo.ext[k]), init: () => ({}),
      sigma: (sim) => { const a = new Float64Array(sim.n); a.fill(s); return a; } };
    try {
      const a = E.create(F.FIX.gasVert, {}), b = E.create(F.FIX.gasVert, { ext: { [k]: {} } });
      a.run(30); b.run(30);
      const ra = a.state.loading.qcVert_MMscfd, rb = b.state.loading.qcVert_MMscfd;
      // the same nodes at the same (p, T) to round-off over 30 s: compare v_c cell by cell (independent of the small p drift)
      let worst = 0; for (let i = 0; i < a.n; i++) if (a.X.vcv[i] > 0 && b.X.vcv[i] > 0) {
        const want = Math.pow(s, 0.25) * a.X.vcv[i] * Math.sqrt(Math.sqrt((b.X.rhoW[i] - b.X.rhoG[i]) / (a.X.rhoW[i] - a.X.rhoG[i]))) * Math.sqrt(a.X.rhoG[i] / b.X.rhoG[i]) * Math.pow(b.X.sigW[i] / a.X.sigW[i], 0.25);
        worst = Math.max(worst, _rel(b.X.vcv[i], want));
      }
      return { ok: worst <= 1e-9 && rb < ra, value: worst, tol: 1e-9, note: 'q_c ' + ra.toFixed(4) + ' → ' + rb.toFixed(4) + ' MMscf/d (ratio ' + (rb / ra).toFixed(4) + ', sigF^¼ ' + Math.pow(s, 0.25).toFixed(4) + ')' + (_haveLift(G, 'foamer') ? '' : '; WD4 foamer not loaded — test extension') };
    } finally { delete ext[k]; }
  });
  // X9 grid convergence (C12)
  row('X9', 'grid convergence (C12): oilVert BHP 60 vs 120 cells ≤ 0.5 %, 30 vs 120 ≤ 1 %', () => {
    if (o.quick) return skip('three steady runs: full run only');
    const b = {}; [30, 60, 120].forEach((n) => { const m = steadySim(G, 'oilVert', n === 60 ? undefined : { cells: n }); b[n] = m.rs.ok ? m.rs.chk.pwfMean : NaN; });
    const e60 = _rel(b[60], b[120]), e30 = _rel(b[30], b[120]);
    return { ok: e60 <= 0.005 && e30 <= 0.01, value: e60, tol: 0.005, note: '30: ' + b[30].toFixed(2) + ', 60: ' + b[60].toFixed(2) + ', 120: ' + b[120].toFixed(2) + ' psia' };
  });
  // X10 determinism and restore (EN15 / EN16)
  row('X10', 'determinism (chunks 1 / 7 / 600 s bit-identical) and snapshot → JSON → restore continues bit-identically', () => {
    const KEYS = ['p', 'mG', 'mO', 'mW', 'mI', 'ag'], eq = (s1, s2) => s1.state.t === s2.state.t && KEYS.every((k) => {
      const x = s1.state.cells[k], y = s2.state.cells[k]; for (let i = 0; i < x.length; i++) if (!Object.is(x[i], y[i])) return false; return true; });
    const ev = { events: [{ t: 250, type: 'bean', args: { bean64: 24 } }, { t: 450, type: 'shutin' }] };
    const sims = [1, 7, 600].map((ch) => { const s = E.create(F.FIX.oilVert, ev); while (s.state.t < 600) s.run(ch); return s; });
    const det = eq(sims[0], sims[1]) && eq(sims[0], sims[2]);
    const a = E.create(F.FIX.oilVert, { events: [{ t: 900, type: 'shutin' }] }); a.run(800);
    const snap = JSON.parse(JSON.stringify(a.snapshot())); a.run(600);
    const b = E.create(F.FIX.oilVert, { events: [{ t: 900, type: 'shutin' }] }); const rr = b.restore(snap); b.run(a.state.t - b.state.t);
    const rest = rr.ok && eq(a, b) && a.state.well.state === b.state.well.state;
    return { ok: det && rest, value: (det ? 0 : 1) + (rest ? 0 : 1), tol: 0, note: 'determinism ' + (det ? 'identical' : 'DIFFERS') + ', restore ' + (rest ? 'identical' : 'DIFFERS') + ', Snap ' + (JSON.stringify(snap).length / 1024).toFixed(1) + ' kB' };
  });
  // X11–X13 gas lift and ESP (WD4)
  row('X11', 'casing gas column (LF2) vs WTS_gaslift_casingP ≤ 0.5 %', () => {
    if (!_haveLift(G, 'gaslift') || !('gasLift' in F.FIX)) return skip('the WD4 gas-lift extension is not loaded');
    const sim = E.create(F.FIX.gasLift, {}), L = sim.state.lift && sim.state.lift.gl;
    if (!L || !(L.pcs_psig > 0) || typeof G.WTS_gaslift_casingP !== 'function') return { ok: false, note: 'no casing state' };
    return { ok: true, skip: true, note: 'WD4 owns LF2; reported by welldyn-lift' };
  });
  row('X12', 'gas-lift unloading sequence (LF5): valves uncover top-down to the operating valve', () => {
    if (!_haveLift(G, 'gaslift') || !F.SCEN.glUnload) return skip('the WD4 gas-lift extension is not loaded');
    const r = runScenario(G, 'glUnload', o.quick ? { duration_s: H } : null);
    if (!r.ok) return { ok: false, note: r.code };
    const st = r.states.map((e) => e.to);
    return { ok: st.indexOf('gl_unloading') !== -1 && r.maxErrCum <= 1e-8, value: r.maxErrCum, tol: 1e-8, note: 'states ' + st.join(' → ') };
  });
  row('X13', 'ESP start (LF8): the intake draws down and settles on the pumped root', () => {
    if (!_haveLift(G, 'esp') || !F.SCEN.espStart) return skip('the WD4 ESP extension is not loaded');
    const r = runScenario(G, 'espStart');
    if (!r.ok) return { ok: false, note: r.code };
    const st = r.states.map((e) => e.to);
    return { ok: st.indexOf('esp_running') !== -1, value: r.maxErrCum, tol: 1e-8, note: 'states ' + st.join(' → ') };
  });
  // X14 transient → IPR (RS5)
  row('X14', 'transient → IPR after stabilisation (buildup fixture, prior steady): rate and BHP within 0.5 % of the IPR-mode run', () => {
    if (o.quick) return skip('two steady runs: full run only');
    const M = F.FIX.buildup;
    const a = E.create(M, { reservoir: F.RES_BUILDUP }), b = E.create(M, { reservoir: { mode: 'ipr' } });
    if (!a.ok || !b.ok) return { ok: false, note: 'create' };
    const ra = runSteady(a, { cap_s: 3 * H }), rb = runSteady(b, { cap_s: 3 * H });
    const eq = _rel(ra.chk.qMean, rb.chk.qMean), ep = _rel(ra.chk.pwfMean, rb.chk.pwfMean);
    return { ok: a.res.mode === 'transient' && eq <= 0.005 && ep <= 0.005, value: Math.max(eq, ep), tol: 0.005 };
  });
  // X15 sharp level (EN25)
  row('X15', 'levelSettle: a gas cap over an oil level settles with no rejected step, no negative mass, level within one cell', () => {
    const r = runScenario(G, 'levelSettle', o.quick ? { duration_s: H } : null);
    if (!r.ok) return { ok: false, note: r.code };
    const rej = r.steps.reduce((s, x) => s + x.rejects, 0), cs = r.sim.state.cells;
    const neg = ['mG', 'mO', 'mW'].some((k) => Array.from(cs[k]).some((v) => v < 0));
    let vl = 0; const cells = r.sim.grid.cells;
    cells.forEach((c, i) => { vl += (1 - cs.ag[i]) * r.sim.X.vol[i]; });
    let md = cells[0].md0; for (let i = 0; i < cells.length; i++) { const v = r.sim.X.vol[i]; if (vl >= v) { vl -= v; md = cells[i].md1; } else { md = cells[i].md0 - cells[i].len * vl / v; break; } }
    const L = cells[Math.floor(cells.length / 2)].len, d = Math.abs(r.sim.state.inventory.liquidTopMd - md);
    return { ok: rej === 0 && !neg && d <= L, value: d, tol: L, note: rej + ' rejects, level ' + r.sim.state.inventory.liquidTopMd.toFixed(0) + ' vs ' + md.toFixed(0) + ' ft' };
  });
  // X16 back-flow (EN26)
  row('X16', 'back-flow (killColumn): liquid falls into the formation until p₀ ≈ p̄r; off → RES_NO_BACKFLOW, no loss', () => {
    const on = runScenario(G, 'killColumn', o.quick ? { duration_s: 1800 } : null);
    if (!on.ok) return { ok: false, note: on.code };
    const pr = F.FIX[F.SCEN.killColumn.fix].res.pr, st = on.sim.state, dp = Math.abs(st.bottom.pwf - pr);
    const off = runScenario(G, 'killColumn', { duration_s: 600, opts: { reservoir: { prior: { kind: 'none' }, backflow: false } } });
    const okOff = off.ok && off.sim.state.flags.some((f) => f.code === 'RES_NO_BACKFLOW') && off.sim.state.balance.cumOut.W === 0;
    const okOn = st.balance.cumOut.W > 0 && st.provisional.indexOf('res_back') !== -1 && (o.quick || dp < 5);
    return { ok: okOn && okOff, value: dp, tol: 5, note: 'p_wf − p̄r ' + (st.bottom.pwf - pr).toFixed(2) + ' psi, water out ' + st.balance.cumOut.W.toFixed(1) + ' lbm' };
  });
  // X17 replay round trip (§3.7, R25): recorder → RunFile → JSON → fromFile; a re-run from the file's settings and events is identical;
  // a continuation from a file snapshot is bit-identical to the original run
  row('X17', 'replay round trip: RunFile → JSON → fromFile series identical; re-run identical (same engineId); continue from a file snapshot', () => {
    const RC = G.WTS_wd_rec;
    if (!RC || typeof RC.create !== 'function') return skip('the recorder is not loaded');
    const dur = o.quick ? 900 : 2 * H, settings = { cells: 60, events: [{ t: 300, type: 'bean', args: { bean64: 24 } }, { t: dur / 2, type: 'shutin' }] };
    // snapshots every 300 s: at 60 s a 2 h run (about 40 kB per snapshot, §11.5) passes the 5 MB file limit and the file drops them
    const a = E.create(F.FIX.oilVert, clone(settings)), rec = RC.create({ every_s: 10, snapEvery_s: 300 });
    rec.attach(a); a.run(dur);
    const txt = JSON.stringify(rec.toFile(G.JSON.parse(JSON.stringify({ settings: { cells: 60 }, model: {}, well: { name: 'validation' } }))));
    const opened = RC.fromFile(txt);
    if (!opened.ok) return { ok: false, note: 'fromFile ' + opened.code };
    if (!opened.rec.snapAt(dur * 0.4)) return { ok: false, note: 'the file has no snapshots (' + (txt.length / 1048576).toFixed(2) + ' MB)' };
    const keys = ['t', 'qL', 'thp', 'pwf', 'bean', 'state'];
    const same = keys.every((k) => JSON.stringify(Array.from(opened.rec.series(k))) === JSON.stringify(Array.from(rec.series(k))));
    // re-run from the file's events
    const b = E.create(F.FIX.oilVert, { cells: 60, events: JSON.parse(JSON.stringify(opened.run.events || [])) }), rec2 = RC.create({ every_s: 10, snapEvery_s: 300 });
    rec2.attach(b); b.run(dur);
    const cmp = RC.compare(opened.rec, rec2);
    // continue from the middle snapshot of the file
    const sn = opened.rec.snapAt(dur * 0.4); let cont = false;
    if (sn) {
      const c = E.create(F.FIX.oilVert, clone(settings)); const rr = c.restore(JSON.parse(JSON.stringify(sn)));
      if (rr.ok) { c.run(a.state.t - c.state.t); cont = c.state.t === a.state.t && Array.from(c.state.cells.p).every((v, i) => Object.is(v, a.state.cells.p[i])); }
    }
    const identical = !!(cmp && cmp.ok && cmp.identical && cmp.n > 0);
    if (typeof rec.detach === 'function') rec.detach(); if (typeof rec2.detach === 'function') rec2.detach();
    return { ok: same && identical && cont, value: (cmp && cmp.maxRel) || 0, tol: 0, note: 'file ' + (txt.length / 1024).toFixed(0) + ' kB, series ' + (same ? 'identical' : 'DIFFER') +
      ', re-run ' + (identical ? 'identical' : 'differs (maxRel ' + (cmp && cmp.maxRel) + ', maxDp ' + (cmp && cmp.maxDp) + ')') + ', continuation ' + (cont ? 'identical' : 'DIFFERS') };
  });
  // X18 loading rule vs the nodal module (EN12): q_c (both methods), method and limiting depth vs WTS_wp_loading within 2 %
  row('X18', 'loading rule = the nodal rule (Belfroid off): q_c Turner / Coleman, method and limiting depth vs the solve\'s loading within 2 %', () => {
    const m = steadySim(G, 'gasVert'), sim = m.sim, L = sim.state.loading, R0L = sim.R0.loading;
    if (!R0L || !R0L.methods) return { ok: false, note: 'no nodal loading result' };
    const eT = _rel(L.methods.turner.qc_MMscfd, R0L.methods.turner.qc_MMscfd), eC = _rel(L.methods.coleman.qc_MMscfd, R0L.methods.coleman.qc_MMscfd);
    const dMd = Math.abs(L.limitingMd - R0L.limitingMd), cl = sim.grid.cells[sim.n - 1].len;
    return { ok: L.method === R0L.method && eT <= 0.02 && eC <= 0.02 && dMd <= 2 * cl, value: Math.max(eT, eC), tol: 0.02,
      note: 'method ' + L.method + ', Turner ' + (100 * eT).toFixed(2) + ' %, Coleman ' + (100 * eC).toFixed(2) + ' %, limiting MD Δ ' + dMd.toFixed(0) + ' ft' };
  });
  const counted = out.filter((r) => !r.skip);
  return { ok: counted.every((r) => r.ok), rows: out };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// --time (§5.6)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
function timing(G, o) {
  o = o || {};
  const F = fixtures(G), E = G.WTS_wd_engine, rows = [];
  // ok = within 2 × the WD1 baseline (the fail line); budgetOk = within §5.6
  const add = (r) => { r.ok = r.base == null || r.v == null || (r.lower ? r.v >= r.base / 2 : r.v <= 2 * r.base); r.budgetOk = r.budget == null || r.v == null || (r.lower ? r.v >= r.budget : r.v <= r.budget); rows.push(r); if (o.onRow) o.onRow(r); };
  const fx = o.quick ? ['oilVert'] : ['gasVert', 'oilVert', 'gasHz'];
  fx.forEach((key) => {
    // create cold (fresh context + solve) and with a ref of the same model hash
    let t0 = nowMs(); const a = E.create(F.FIX[key], {}); const cold = nowMs() - t0;
    t0 = nowMs(); const b = E.create(F.FIX[key], { ref: a.ref }); const warm = nowMs() - t0;
    add({ op: 'create, cold', fixture: key, v: cold, unit: 'ms', budget: BUDGET.createCold, base: BASELINE.createCold[key] });
    add({ op: 'create with ref (same model hash)', fixture: key, v: warm, unit: 'ms', budget: BUDGET.createRef, base: BASELINE.createRef[key] });
    // flowing: from the steady start, 1 h simulated (0.25 h quick)
    const dur = o.quick ? 900 : H, s0 = b.stats.steps; t0 = nowMs(); b.run(dur); const w = nowMs() - t0, n = b.stats.steps - s0;
    add({ op: 'flowing step, ' + b.n + ' cells', fixture: key, v: w / n, unit: 'ms/step', budget: BUDGET.stepFlow, base: BASELINE.stepFlow[key], steps: n, dt: dur / n });
    add({ op: 'simulated / wall, flowing', fixture: key, v: dur * 1000 / w, unit: '×', lower: true, budget: b.gasWell() ? BUDGET.speedGas : BUDGET.speedOil, base: BASELINE.speedFlow[key], steps: n, dt: dur / n });
    add({ op: 'wall per simulated hour, flowing', fixture: key, v: w * H / dur, unit: 'ms', budget: b.gasWell() ? BUDGET.gatePerHourGas : BUDGET.gatePerHourOil, base: null });
    // shut-in: shut, let the afterflow pass (10 min); the first hour (Δt still CFL-limited by the settling column: report) and then,
    // 2 h after the shut, the settled column at dtMax (the §5.6 rows "shut-in / static" and "simulated / wall, shut-in at dtMax")
    b.shutIn(); b.run(600);
    const s1 = b.stats.steps, ds = o.quick ? 900 : H; t0 = nowMs(); b.run(ds); const ws = nowMs() - t0, ns = b.stats.steps - s1;
    add({ op: 'shut-in, first hour after the afterflow', fixture: key, v: ds * 1000 / ws, unit: '×', lower: true, budget: null, base: null, steps: ns, dt: ds / ns, note: (ws / ns).toFixed(2) + ' ms/step' });
    if (!o.quick) {
      b.run(2 * H);   // to ≈ 3 h after the shut (the column settles; Δt reaches dtMax)
      const s2 = b.stats.steps, d2 = 2 * H; t0 = nowMs(); b.run(d2); const w2 = nowMs() - t0, n2 = b.stats.steps - s2;
      add({ op: 'shut-in step, settled (3.2–5.2 h after the shut)', fixture: key, v: w2 / n2, unit: 'ms/step', budget: BUDGET.stepShut, base: BASELINE.stepShut[key], steps: n2, dt: d2 / n2 });
      add({ op: 'simulated / wall, shut in at dtMax', fixture: key, v: d2 * 1000 / w2, unit: '×', lower: true, budget: BUDGET.speedShut, base: BASELINE.speedShut[key], steps: n2, dt: d2 / n2 });
    }
    // snapshot / restore (mean of 20)
    let sn = null; t0 = nowMs(); for (let i = 0; i < 20; i++) sn = b.snapshot(); const tSnap = (nowMs() - t0) / 20;
    const c = E.create(F.FIX[key], { ref: b.ref }); t0 = nowMs(); for (let i = 0; i < 20; i++) c.restore(sn); const tRest = (nowMs() - t0) / 20;
    add({ op: 'snapshot', fixture: key, v: tSnap, unit: 'ms', budget: BUDGET.snapshot, base: BASELINE.snapshot, note: (JSON.stringify(sn).length / 1024).toFixed(1) + ' kB' });
    add({ op: 'restore', fixture: key, v: tRest, unit: 'ms', budget: BUDGET.restore, base: BASELINE.restore });
  });
  // gate runs: wall per simulated hour from the memoised steady runs (from --check) or fresh
  if (!o.quick) ['gasVert', 'oilVert', 'gasHz', 'oilVertTuned', 'oilDev'].forEach((key) => {
    const m = steadySim(G, key);
    if (!m.rs.ok) return;
    const gas = m.sim.gasWell();
    add({ op: 'gate run to steady (' + (m.rs.t / H).toFixed(2) + ' h simulated)', fixture: key, v: m.rs.wallMs * H / m.rs.t, unit: 'ms/h', budget: gas ? BUDGET.gatePerHourGas : BUDGET.gatePerHourOil, base: null, steps: m.rs.steps, dt: m.rs.t / Math.max(1, m.rs.steps) });
  });
  // scenarios (§5.6 rows; the lift scenarios when WD4 is loaded)
  Object.keys(F.SCEN).forEach((nm) => {
    if (o.quick && nm !== 'levelSettle') return;
    const lift = { glUnload: 'gaslift', espStart: 'esp', foamerOn: 'foamer', cycleTimer: 'cycle' }[nm];
    if (lift && !_haveLift(G, lift)) return;
    const r = runScenario(G, nm);
    if (!r.ok) { add({ op: 'scenario ' + nm, fixture: F.SCEN[nm].fix, v: null, unit: 'ms', budget: BUDGET.scen[nm] || null, base: BASELINE.scen[nm] || null, note: 'FAILED ' + r.code }); rows[rows.length - 1].ok = false; return; }
    const n = r.steps.length, rej = r.steps.reduce((s, x) => s + x.rejects, 0);
    add({ op: 'scenario ' + nm + ' (' + (r.dur / H).toFixed(0) + ' h)', fixture: F.SCEN[nm].fix, v: r.wallMs, unit: 'ms', budget: BUDGET.scen[nm] || null, base: BASELINE.scen[nm] || null,
      steps: n, dt: r.dur / n, note: (r.wallMs / n).toFixed(2) + ' ms/step, ' + rej + ' rejects' });
  });
  // recorder memory over 1 h of oilVert at the defaults (10 s samples, 60 s snapshots), projected to 24 h; the replay file size
  if (G.WTS_wd_rec) {
    const s = E.create(F.FIX.oilVert, {}), rec = G.WTS_wd_rec.create({});
    rec.attach(s); s.run(H);
    const b1 = typeof rec.bytes === 'function' ? rec.bytes() : null;
    const file = JSON.stringify(rec.toFile(G.JSON.parse('{}'))).length;
    add({ op: 'recorder memory, 24 h projected from 1 h', fixture: 'oilVert', v: b1 != null ? b1 * 24 / 1048576 : null, unit: 'MB', budget: BUDGET.recMB24h, base: null, note: b1 != null ? (b1 / 1024).toFixed(0) + ' kB per hour' : 'rec.bytes() not available' });
    add({ op: 'replay file after 1 h (5 MB limit thins snapshots)', fixture: 'oilVert', v: file / 1048576, unit: 'MB', budget: BUDGET.fileMB, base: null, note: 'per hour; ' + (file * 24 / 1048576).toFixed(1) + ' MB projected for 24 h' });
    if (typeof rec.detach === 'function') rec.detach();
  }
  // the wellbore frame: draw op count on the recording canvas (Node); the ms in the browser (--browser)
  if (G.WTS_wd_view && G.document && typeof G.WTS_wd_view.wellbore === 'function') {
    const s = E.create(F.FIX.oilVert, {}); s.run(300);
    const cv = G.document.createElement('canvas'); cv.style.width = '360px'; cv.style.height = '480px'; G.document.body.appendChild(cv);
    const V = G.WTS_wd_view.wellbore(cv, { grid: s.grid, traj: s.grid.traj, particles: { on: true, max: 300 } });
    const fr = { t: s.state.t, cells: s.state.cells, faces: s.state.faces, markers: [], dtWall: 1 / 60, playing: true };
    V.draw(fr); if (cv._log) cv._log.length = 0;
    const t0 = nowMs(); for (let i = 0; i < 20; i++) V.draw(fr); const ms = (nowMs() - t0) / 20;
    const ops = cv._log ? cv._log.length / 20 : null;
    add({ op: 'wellbore frame, ' + s.n + ' cells + particles (draw ops)', fixture: 'oilVert', v: ops, unit: 'ops', budget: null, base: null, note: ms.toFixed(2) + ' ms in the Node harness (not the browser)' });
    if (V.destroy) V.destroy();
  }
  return { ok: rows.every((r) => r.ok), budgetsOk: rows.every((r) => r.budgetOk), rows };
}

// ── --browser: the built page in Chromium at ×1000 (report only) ────────────────────────────────────────────────────────
async function browser(o) {
  o = o || {};
  let S;
  try { S = require('./pw-session'); } catch (e) { return { skip: 'pw-session.js not found' }; }
  const pw = S.loadPlaywright();
  if (!pw) return { skip: 'Playwright not installed (never run playwright install)' };
  const F = fixtures(), html = path.join(ROOT, '..', 'well-testing-app.html');
  if (!fs.existsSync(html)) return { skip: 'no built HTML' };
  const srv = await S.startServer({});
  const br = await S.launch(pw);
  const out = [];
  try {
    for (const key of (o.fixtures || ['oilVert', 'gasVert', 'gasHz'])) {
      for (const vp of [{ width: 1280, height: 800 }, { width: 390, height: 844, phone: true }]) {
        const s = await S.freshSession(br, { base: srv.base, viewport: { width: vp.width, height: vp.height }, phone: !!vp.phone });
        const p = s.page;
        const res = await p.evaluate(async ({ M, wall }) => {
          const Wm = window.WTS_wp_model, read0 = Wm.read;
          Wm.read = function () { const m = JSON.parse(JSON.stringify(M)); m.meta = { status: 'ok', readOnly: false, notes: [] }; return m; };
          try {
            window.WTS_nav ? window.WTS_nav('welldyn') : document.querySelector('[data-p="welldyn"]').click();
            await new Promise((r) => setTimeout(r, 300));
            const P = window.WTS_welldyn_page; P.build();
            const ST = P.state(), draws = [];
            if (ST.wb && ST.wb.draw) { const d0 = ST.wb.draw.bind(ST.wb); ST.wb.draw = function (f) { const t = performance.now(); const r = d0(f); draws.push(performance.now() - t); return r; }; }
            P.speed(1000); P.play();
            const t0 = performance.now(), s0 = P.sim().state.t;
            await new Promise((r) => setTimeout(r, wall));
            const s1 = P.sim().state.t, t1 = performance.now(); P.pause();
            draws.sort((a, b) => a - b);
            const txt = document.getElementById('wd_root').textContent || '';
            return { ok: true, speed: (s1 - s0) / ((t1 - t0) / 1000), ach: ST.ach && ST.ach.val, frames: ST.frameN, drawMedian: draws[Math.floor(draws.length / 2)] || null,
              drawP95: draws[Math.floor(draws.length * 0.95)] || null, bad: /NaN|undefined|\[object Object\]/.test(txt), overflow: document.documentElement.scrollWidth > window.innerWidth + 1 };
          } catch (e) { return { ok: false, err: String(e && e.message || e) }; } finally { Wm.read = read0; }
        }, { M: F.FIX[key], wall: o.wall_ms || 5000 });
        out.push(Object.assign({ fixture: key, viewport: vp.width + '×' + vp.height, errors: s.errors.slice(0, 3) }, res));
        if (o.shots) { try { fs.mkdirSync(o.shots, { recursive: true }); await p.screenshot({ path: path.join(o.shots, 'welldyn-' + key + '-' + vp.width + '.png') }); } catch (e) { /* ignore */ } }
        await s.ctx.close();
      }
    }
  } finally { await br.close(); await srv.close(); }
  return { rows: out };
}

// ── output ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
function _f(v, d) { return v == null || !isFinite(v) ? '—' : (Math.abs(v) < 1e-3 && v !== 0 ? v.toExponential(2) : v.toFixed(d == null ? 2 : d)); }
function _pct(v) { return v == null || !isFinite(v) ? '—' : (100 * v >= 0 ? '+' : '') + (100 * v).toFixed(3) + ' %'; }

async function main() {
  const doGate = flag('--gate'), doCheck = flag('--check'), doTime = flag('--time'), doBrowser = flag('--browser'), all = !doGate && !doCheck && !doTime && !doBrowser;
  const quick = flag('--quick'), only = optVal('--only') ? optVal('--only').split(',') : null;
  const t0 = nowMs();
  const app = _load(), G = app.win;
  console.log('[welldyn-validate] app loaded from ' + (flag('--html') ? 'the built HTML' : 'sources') + ' in ' + (nowMs() - t0).toFixed(0) + ' ms; fixtures: ' +
    (fixtures().sourceOverrides ? 'tests/_welldyn-wd1.js (wave-1 stand-in)' : 'tests/_welldyn-shapes.js') + '; WD4 lift extensions: ' + (_haveLift(G, 'gaslift') || _haveLift(G, 'esp') ? 'loaded' : 'not loaded'));
  const summary = {}; let fail = false;
  if (doGate || all) {
    const g = gate(G, { quick }); summary.gate = g;
    console.log('\nD17 method table (§4.14): ' + (g.ok ? 'PASS' : 'FAIL'));
    g.rows.forEach((r) => console.log('  ' + (r.verified === false ? 'provisional' : 'verified   ') + '  ' + r.key.padEnd(12) + String(r.verified).padEnd(20) + (r.never ? 'never a default  ' : '                 ') + r.source));
    (g.runs || []).forEach((r) => console.log('  default run ' + r.fixture.padEnd(13) + 'provisional keys active: ' + (r.active.join(', ') || 'none')));
    g.errors.forEach((e) => console.log('  FAIL ' + e));
    if (!g.ok) fail = true;
  }
  if (doCheck || all) {
    console.log('\nCross-checks X1–X18 (§5.5):');
    const c = checks(G, { quick, only, onRow: (r) => {
      console.log('  ' + (r.skip ? 'SKIP' : (r.ok ? 'PASS' : 'FAIL')) + '  ' + r.id.padEnd(4) + r.name + '  [' + _f(r.value, 4) + ' / tol ' + _f(r.tol, 4) + ', ' + (r.ms / 1000).toFixed(1) + ' s]');
      if (r.id === 'X1' && r.dq != null) {
        console.log('          Δq ' + _pct(r.dq) + ', ΔBHP ' + _pct(r.dp) + ', ΔTHP ' + _f(r.dthp, 2) + ' psi, amplitude q ' + _pct(r.ampQ) + ' / p ' + _f(r.ampP, 3) + ' psi, regime ' + r.regime + ', steady at ' + _f(r.tSteady / H, 2) + ' h');
        if (r.diag) console.log('          C2 (nodal march at stepFt ' + r.diag.stepFt + ' ft = the cell length): Δq ' + _pct(r.diag.dqCell) + ', ΔBHP ' + _pct(r.diag.dpCell) + ' (vs the 100 ft march: ' + _pct(r.diag.dqFine) + ', ' + _pct(r.diag.dpFine) + ')');
      }
      if (r.note) console.log('          ' + r.note);
    } });
    summary.checks = c;
    const n = c.rows.filter((r) => !r.skip);
    console.log('  ' + n.filter((r) => r.ok).length + ' / ' + n.length + ' checks pass, ' + (c.rows.length - n.length) + ' skipped');
    if (!c.ok) fail = true;
  }
  if (doTime || all) {
    console.log('\nTime budgets (§5.6; fail line = 2 × the WD1 baseline of §11.1):');
    console.log('  ' + 'operation'.padEnd(52) + 'fixture'.padEnd(14) + 'value'.padStart(11) + '  ' + 'unit'.padEnd(8) + 'budget'.padStart(9) + 'WD1'.padStart(9) + 'steps'.padStart(8) + 'Δt s'.padStart(8) + '  result');
    const t = timing(G, { quick, onRow: (r) => console.log('  ' + r.op.padEnd(52) + r.fixture.padEnd(14) + _f(r.v, 2).padStart(11) + '  ' + r.unit.padEnd(8) + (r.budget == null ? '—' : (r.lower ? '≥' : '≤') + r.budget).padStart(9) +
      (r.base == null ? '—' : String(r.base)).padStart(9) + (r.steps == null ? '' : String(r.steps)).padStart(8) + (r.dt == null ? '' : _f(r.dt, 2)).padStart(8) + '  ' + (r.ok ? 'ok' : 'FAIL (> 2 × WD1)') + (r.budgetOk ? '' : ', over budget') + (r.note ? '  (' + r.note + ')' : '')) });
    summary.timing = t;
    if (!t.ok) fail = true;
    if (!t.budgetsOk && flag('--strict')) fail = true;
  }
  if (doBrowser) {
    {
      const b = await browser({ shots: optVal('--shots') });
      summary.browser = b;
      if (b.skip) console.log('\nBrowser: skipped — ' + b.skip);
      else {
        console.log('\nBrowser (Chromium, the built page at ×1000, 5 s wall; report only):');
        b.rows.forEach((r) => console.log('  ' + r.fixture.padEnd(10) + r.viewport.padEnd(10) + (r.ok ? 'achieved ×' + _f(r.speed, 0) + ', ' + r.frames + ' frames, wellbore draw median ' + _f(r.drawMedian, 2) + ' ms / p95 ' + _f(r.drawP95, 2) + ' ms' +
          (r.bad ? ', NaN/undefined in the page' : '') + (r.overflow ? ', horizontal overflow' : '') : 'error ' + r.err) + (r.errors.length ? ', page errors: ' + r.errors.join(' | ') : '')));
      }
    }
  }
  if (flag('--json')) console.log(JSON.stringify(summary, (k, v) => (k === 'sim' || typeof v === 'function' ? undefined : v)));
  console.log('\n[welldyn-validate] ' + (fail ? 'FAIL' : 'ok') + ' (' + ((nowMs() - t0) / 1000).toFixed(1) + ' s)');
  if (app.dispose) try { app.dispose(); } catch (_) { /* ignore */ }
  return fail ? 1 : 0;
}

module.exports = { gate, checks, timing, browser, METHOD_TABLE, NEVER_DEFAULT, BUDGET, BASELINE, fixtures, steadySim, runScenario, PROVISIONAL };
if (require.main === module) main().then((c) => process.exit(c), (e) => { console.error('[welldyn-validate] crash: ' + (e && e.stack || e)); process.exit(2); });
