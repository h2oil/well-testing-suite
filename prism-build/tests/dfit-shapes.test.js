// DFIT — WP0 contract tests (docs/DFIT-PLAN.md §3.13, §9 WP0).
//
//   SH1  every fixture passes its shape check (all §3.13 names covered) and agrees with the §4.21 reference chain; broken
//        copies fail with the path of the break; the failure form passes engine-output shapes only; {} / null never pass
//   SH2  the §3.2 range table clamps blank / 0 / −1 / 1e12 (and an unparsable string) for every field, keeps integers
//        integral and writes plain warnings; clampInputs gives inputs that pass DfitInputs; 56 carries the same table and
//        clamp; the nine skeleton files load in a bare context (no document) and export every §3 name as a
//        NOT_IMPLEMENTED stub; concat-round8 lists 56–59 after 55
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const S = require('./_dfit-shapes');

const WP = 'DF0';
const BUILD = path.join(__dirname, '..');
const BBL = 5.614583;

function broken(name, base, fn) { const o = JSON.parse(JSON.stringify(base)); fn(o); return S.checkShape(name, o); }
function expectFail(assert, res, pathPrefix, what) {
  assert.strictEqual(res.ok, false, what + ': a broken copy must fail');
  assert(res.errors.some((e) => e.startsWith(pathPrefix + ': ') || e.startsWith(pathPrefix + '.') || e.startsWith(pathPrefix + '[')),
    what + ': expected an error at ' + pathPrefix + ', got ' + JSON.stringify(res.errors.slice(0, 4)));
}
const near = (assert, a, b, tol, what) => assert(typeof a === 'number' && Math.abs(a - b) <= tol, what + ': ' + a + ' vs ' + b + ' (± ' + tol + ')');

// Load a source file in a bare vm context (no document), with Round 8's / Round 9's own self-test stripper.
function loadBare(files) {
  const { stripSelfTest } = require(path.join(BUILD, 'concat-round8.js'));
  const quiet = { log() {}, warn() {} };
  const warns = [];
  const ctx = { console: { log() {}, warn: (...a) => warns.push(a.join(' ')), error: (...a) => warns.push(a.join(' ')) } };
  ctx.window = ctx;
  vm.createContext(ctx);
  files.forEach((f) => vm.runInContext(stripSelfTest(fs.readFileSync(path.join(BUILD, f), 'utf8'), f, quiet), ctx, { filename: f }));
  return { ctx, warns };
}

// §3 names per skeleton file (functions unless noted)
const NAMES = {
  '56-prism-dfit-core.js': ['PRiSM_dfit_dsHash', 'PRiSM_dfit_prepare', 'PRiSM_dfit_resample', 'PRiSM_dfit_events', 'PRiSM_dfit_g', 'PRiSM_dfit_gPrime',
    'PRiSM_dfit_G', 'PRiSM_dfit_Ginv', 'PRiSM_dfit_gFromHistory', 'PRiSM_dfit_hFn', 'PRiSM_dfit_derivs', 'PRiSM_dfit_isip', 'PRiSM_dfit_closurePicks',
    'PRiSM_dfit_varComplianceFit', 'PRiSM_dfit_vcModel', 'PRiSM_dfit_consensus', 'PRiSM_dfit_consensusLite', 'PRiSM_dfit_bounds', 'PRiSM_dfit_classify',
    'PRiSM_dfit_frac', 'PRiSM_dfit_whatIf', 'PRiSM_dfit_leakoffRate', 'PRiSM_dfit_kBeforeClosure', 'PRiSM_dfit_farField', 'PRiSM_dfit_forecastClosure'],
  '57-prism-dfit-aca.js': ['PRiSM_dfit_pipeline', 'PRiSM_dfit_summarise', 'PRiSM_dfit_timeFns', 'PRiSM_dfit_centroid', 'PRiSM_dfit_acaDiag', 'PRiSM_dfit_nolte',
    'PRiSM_dfit_impulseLines', 'PRiSM_dfit_acaBounds', 'PRiSM_dfit_piConsensus', 'PRiSM_dfit_gasAdjust', 'PRiSM_dfit_crTransform', 'PRiSM_dfit_acaMatch',
    'PRiSM_dfit_aca', 'PRiSM_dfit_leakPlot', 'PRiSM_dfit_uncertainty', 'PRiSM_dfit_replay', 'PRiSM_dfit_evidence', 'PRiSM_dfit_reportModel',
    'PRiSM_dfit_checkQuoted', 'PRiSM_dfit_exportText', 'PRiSM_dfit_fracSheet', 'PRiSM_dfit_handoff'],
  '58-prism-dfit-leakoff.js': ['PRiSM_dfit_lkDefaults', 'PRiSM_dfit_lkToEngine', 'PRiSM_dfit_lkSimulate', 'PRiSM_dfit_lkSample', 'PRiSM_dfit_lkQuick',
    'PRiSM_dfit_lkSolveCL', 'PRiSM_dfit_lkGoalSeek', 'PRiSM_dfit_lkFit', 'PRiSM_dfit_lkFisher', 'PRiSM_dfit_lkGroups', 'PRiSM_dfit_identify',
    'PRiSM_dfit_lkVerify', 'PRiSM_dfit_design', 'PRiSM_dfit_leakBudget'],
  '59-prism-dfit-ui.js': ['PRiSM_dfit_renderStep2', 'PRiSM_dfit_renderStep4', 'PRiSM_dfit_state', 'PRiSM_dfit_test', 'PRiSM_dfit_selectTest',
    'PRiSM_dfit_addTest', 'PRiSM_dfit_setPick', 'PRiSM_dfit_applyHandoff', 'PRiSM_dfit_results', 'PRiSM_plot_dfitDual', 'PRiSM_plot_dfitStrip', 'PRiSM_plot_dfitStack'],
  '49-calc-dfit-triage.js': ['PRiSM_dfit_triage', 'PRiSM_dfit_blunders', 'PRiSM_dfit_repump', 'PRiSM_dfit_grade'],
};
const JOBS = {
  '56-prism-dfit-core.js': ['PRiSM_dfit_consensusJob'],
  '57-prism-dfit-aca.js': ['PRiSM_dfit_pipelineJob', 'PRiSM_dfit_acaMatchJob', 'PRiSM_dfit_uncertaintyJob', 'PRiSM_dfit_replayJob'],
  '58-prism-dfit-leakoff.js': ['PRiSM_dfit_lkFitJob', 'PRiSM_dfit_designJob'],
};
const WELLBORE = ['column', 'csys', 'tempProfile', 'hydrostatic', 'pipeFriction', 'perfFriction', 'nwbLoss', 'bleedOff', 'convert', 'vacuum',
  'stepDown', 'stepDownDesignCheck', 'stepRate', 'ramp', 'hammerQuick', 'align'];
const SKELETONS = ['56-prism-dfit-core.js', '57-prism-dfit-aca.js', '58-prism-dfit-leakoff.js', '59-prism-dfit-ui.js',
  '48-calc-wellbore.js', '49-calc-dfit-triage.js', '49-calc-dfit-info.js', '49-calc-dfit-synth.js', '49-calc-dfit-cal.js'];

module.exports = [
  {
    name: 'SH1 fixtures pass their shape checks (all §3.13 names) and the §4.21 chain; broken copies fail with a path',
    wp: WP,
    opts: false,
    run(app, assert) {
      const ds = S.FIX.ds, run = S.FIX.run, st = S.FIX.state, aca = S.FIX.aca, sm = S.FIX.samples, REF = S.FIX.ref.REF;
      const covered = new Set();
      const ok = (name, obj, label) => { const r = S.checkShape(name, obj); assert(r.ok, (label || name) + ' must pass: ' + JSON.stringify(r.errors.slice(0, 6))); covered.add(name); };
      ok('DfitDataset', ds, 'FIX.ds'); ok('DfitRun', run, 'FIX.run'); ok('DfitState', st, 'FIX.state'); ok('AcaResult', aca, 'FIX.aca (example B)');
      st.tests.forEach((t, i) => { ok('DfitTest', t, 'state.tests[' + i + ']'); ok('DfitInputs', t.inputs, 'state.tests[' + i + '].inputs'); });
      ok('Prepared', run.prep); ok('Events', run.events); ok('Derivs', run.derivs); ok('IsipResult', run.isip); ok('Consensus', run.consensus);
      ok('ConsensusLite', run.consensusLite); ok('Classification', run.classification); ok('FracOutputs', run.frac.chosen); ok('Triage', run.triage);
      ok('AcaResult', run.aca, 'run.aca'); ok('LeakPlot', run.leak); ok('Uncertainty', run.unc); ok('EvidenceIndex', run.evidence); ok('ReportModel', run.report);
      run.picks.forEach((p, i) => ok('ClosurePick', p, 'run.picks[' + i + ']'));
      ['StepDown', 'StepRate', 'Ramp', 'Hammer', 'LkConfig', 'LkResult', 'LkFit', 'Identify', 'DesignRanges', 'Design', 'LiveVerdict', 'HandoffPacket', 'CaseSpec']
        .forEach((n) => ok(n, sm[n], 'samples.' + n));
      ok('Summary', run.summary); ok('Failure', sm.Failure); ok('AcaDiag', aca.diag); ok('LkConfig', st.tests[1].lk.cfg, 'state.tests[1].lk.cfg');
      assert.deepStrictEqual(S.SHAPE_NAMES.filter((n) => !covered.has(n)), [], 'every §3.13 name has a passing fixture');
      assert.strictEqual(S.SHAPE_NAMES.length, 33, '33 §3.13 names');

      // ── FIX.ds is the §4.21 reference: 600 samples, 25 bbl in 5.0 min, the closed-form falloff to ±0.006 psi ──
      assert.strictEqual(ds.t.length, 600, '600 samples');
      // pumping samples are 2.5 s apart from the pump start (2 min) to the shut-in; the rate is held over each interval
      let V = 0, prev = 2 / 60; for (let i = 0; i < ds.t.length; i++) if (ds.q[i] > 0) { V += ds.q[i] / 1440 * (ds.t[i] - prev) * 60; prev = ds.t[i]; }
      near(assert, V, 25, 1e-5, 'injected volume (bbl)');
      const iS = ds.q.lastIndexOf(7200);
      near(assert, ds.t[iS], 7 / 60, 1e-9, 'shut-in at 7 min'); near(assert, ds.t[iS] - (ds.t[ds.q.indexOf(7200)] - 2.5 / 3600), 5 / 60, 1e-8, 'tp 5.0 min');
      let maxErr = 0; for (let i = iS + 1; i < ds.t.length; i++) maxErr = Math.max(maxErr, Math.abs(ds.p[i] - S.FIX.ref.pFall(ds.t[i] - ds.t[iS])));
      assert(maxErr <= 0.006, 'falloff reproduces the closed form, max error ' + maxErr);
      near(assert, S.FIX.ref.pFall(REF.dtc), 7000, 1e-6, 'continuous at closure'); near(assert, REF.dtc * 60, 305.1, 0.05, 'Δt_c 305.1 min');
      near(assert, S.G.G(1, 0.5), 1.27324, 1e-5, 'G(1, ½)'); near(assert, S.G.G(1, 1), 1.40638, 1e-5, 'G(1, 1)'); near(assert, S.G.G(10, 0.5), 6.3159, 1e-4, 'G(10, ½)');
      near(assert, S.G.G(100, 0.5), 23.5495, 1e-4, 'G(100, ½)'); near(assert, S.G.G(100, 1), 23.8307, 1e-4, 'G(100, 1)'); near(assert, S.G.Ginv(18, 0.5), 61.019, 1e-3, 'G⁻¹(18, ½)');

      // ── FIX.run agrees with the §4.21 table ──
      const c = run.frac.chosen, P = c.geometry.byModel;
      near(assert, run.isip.value, 7600, 0.05, 'ISIP'); assert.strictEqual(run.isip.confidence, 'high', 'ISIP label'); near(assert, run.isip.spread, 9.5, 1e-9, 'ISIP spread');
      assert.strictEqual(run.consensus.mode, 'single'); near(assert, run.consensus.value, 7000, 1e-9, 'closure'); assert.strictEqual(run.consensus.confidence, 'high');
      near(assert, run.consensus.tau, 21, 1e-9, 'τ = max(15, 21, 18)');
      near(assert, c.Gc, 18.0, 0.001, 'G_c'); near(assert, c.dtc * 60, 305.1, 0.05, 'Δt_c'); near(assert, c.eta.a05, 0.900, 5e-4, 'η_G α = ½'); near(assert, c.eta.a1, 0.915, 5e-4, 'η_G α = 1');
      near(assert, c.eta.etaF, 0.898, 5e-4, 'η_f'); near(assert, c.pn, 600, 1e-9, 'p_n'); near(assert, c.chi, 1.00, 5e-3, 'χ');
      near(assert, c.Csys * BBL, 0.2105, 5e-5, 'C_sys ft³/psi'); near(assert, c.AfCf * BBL, 0.2061, 5e-5, 'A_f·c_f ft³/psi'); near(assert, c.Rvis, 0.979, 5e-4, 'R_vis');
      near(assert, c.VwCw * BBL, 4.44e-3, 5e-6, 'V_w·c_w ft³/psi'); near(assert, 5 / c.VwCw, 6323, 2, 'ramp psi/min');
      near(assert, P.PKN.xf, 131.2, 0.05, 'PKN xf'); near(assert, P.PKN.Af, 13121, 1, 'PKN A_f'); near(assert, P.PKN.wAvg, 0.113, 5e-4, 'PKN w̄');
      near(assert, P.PKN.CL, 1.903e-4, 2e-7, 'PKN CL'); near(assert, P.KGD.xf, 57.3, 0.05, 'KGD xf'); near(assert, P.KGD.CL, 4.361e-4, 2e-7, 'KGD CL');
      near(assert, P.radial.R, 57.8, 0.05, 'radial R'); near(assert, P.radial.CL, 4.409e-4, 3e-7, 'radial CL'); near(assert, P.radial.rp, 0.432, 1e-3, 'radial r_p');
      near(assert, P.PKN.Vf, 22.0, 0.05, 'V_f bbl'); near(assert, P.PKN.VLpump * BBL, 14.04, 0.01, 'V_L pumping ft³');
      near(assert, c.Gamma, 9.49, 5e-3, 'Γ'); near(assert, c.GammaPKN, 15.2, 0.05, 'Γ_PKN'); near(assert, c.kBefore.kCL.k, 2.75e-3, 5e-6, 'k from CL'); near(assert, c.kBefore.kCL.dpCL, 2800, 1e-6, 'Δp_CL');
      assert(c.geometry.msgs.some((m) => /115\.6 ft/.test(m)), '2R 115.6 ft > 50 ft barriers');
      near(assert, run.consensus.forecast[0].dtc, 2.46, 5e-3, 'forecast σ 7,200'); near(assert, run.consensus.forecast[1].dtc, 8.63, 5e-3, 'forecast σ 6,800');
      // derivative identities (exact arrays): GdPdG = G·dPdG, D = dt·ppd, sdPds = 2D, normal leak-off ⇒ GdPdG = m_G·G before closure
      const d = run.derivs;
      for (let i = 0; i < d.dt.length; i++) {
        near(assert, d.GdPdG[i], d.G[i] * d.dPdG[i], 1e-6 * Math.max(1, d.GdPdG[i]), 'GdPdG[' + i + ']');
        near(assert, d.sdPds[i], 2 * d.D[i], 1e-6 * Math.max(1, d.D[i]), 'sdPds[' + i + ']');
        if (d.G[i] < 17.9) near(assert, d.GdPdG[i] / (d.mG * d.G[i]), 1, 1e-5, 'normal leak-off before closure [' + i + ']');
      }
      // the brackets contain the truth (p_i 4,500) wherever they exist; the after-closure k lies inside its bounds
      [run.aca, aca].forEach((a, j) => {
        a.diag.piLo.forEach((lo, i) => { if (lo !== null) assert(lo <= 4500.01 && a.diag.piHi[i] >= 4499.99, (j ? 'example B' : 'reference') + ' bracket ' + i + ': [' + lo + ', ' + a.diag.piHi[i] + ']'); });
        assert(a.pi.lo <= 4500 && a.pi.hi >= 4500 && a.pi.label === 'medium', 'p_i inside the combined bracket, medium');
        const k = a.nolte.lin.k; assert(a.bounds.kLo <= k && k <= a.bounds.kHi, 'k ' + k + ' inside [' + a.bounds.kLo + ', ' + a.bounds.kHi + ']');
      });
      near(assert, aca.nolte.lin.k, 0.0100, 1e-6, 'example B k'); near(assert, run.aca.nolte.lin.mL, 2500, 0.01, 'reference m_L = σ_c − p_r');
      // hashes and summaries are consistent; the state holds two tests, one with a closure range and a user F1 choice
      assert.strictEqual(run.dsHash, S.dsHash(ds), 'run.dsHash'); assert.strictEqual(st.tests[0].dsRef.hash, run.dsHash, 't1 bound to FIX.ds');
      assert.strictEqual(run.summary.resultHash, S.resultHash(run.summary), 'resultHash'); assert.strictEqual(run.summary.inputHash, S.inputHash(st.tests[0].inputs), 'inputHash');
      assert.deepStrictEqual(st.tests[0].summary, run.summary, 't1.summary = FIX.run.summary');
      assert.strictEqual(st.tests.length, 2); const t2 = st.tests[1].summary.closure;
      assert(t2.mode === 'range' && t2.lo === 6495 && t2.hi === 7004 && t2.families.F1.p50 === 6998 && t2.families.F2.p50 === 6507 && t2.label === 'medium', 't2 closure range');
      assert(st.tests[1].picks.closure.mode === 'family' && st.tests[1].picks.closure.family === 'F1' && st.tests[1].log.length === 3, 't2 user F1 choice and log');
      assert(JSON.stringify(st).length < 100 * 1024, 'st.dfit under 100 kB');
      assert(/^DFIT · closure 7,000 psia \(single, high\) · p_i 4,500 ±\d+ psia$/.test(run.report.keyLine), 'key line: ' + run.report.keyLine);
      // every evidence id used in the run is in the index
      const used = new Set(); JSON.stringify(run, (k, v) => { if (k === 'ev' && Array.isArray(v)) v.forEach((x) => used.add(x)); return v; });
      assert.deepStrictEqual(Array.from(used).filter((id) => !run.evidence.items[id]), [], 'every ev id is in the evidence index');
      // fixtures are deep copies
      const r1 = S.FIX.run; r1.isip.value = 1; assert.strictEqual(S.FIX.run.isip.value, run.isip.value, 'FIX returns deep copies');

      // ── broken copies fail with the path of the break ──
      expectFail(assert, broken('DfitRun', run, (o) => { o.derivs.GdPdG[3] = 'x'; }), 'derivs.GdPdG[3]', 'string in a derivative');
      expectFail(assert, broken('DfitRun', run, (o) => { o.consensus.value = null; }), 'consensus.value', 'single mode without a value');
      expectFail(assert, broken('DfitRun', run, (o) => { o.picks[1].vote = true; }), 'picks[1].vote', 'a dependent member votes');
      expectFail(assert, broken('DfitRun', run, (o) => { o.unc.outputs.closure.bimodal = true; }), 'unc.outputs.closure.p50', 'bimodal with quantiles');
      expectFail(assert, broken('DfitRun', run, (o) => { o.report.sections[0].blocks[0].rows[0][1] = '7,000 psia [C1·K1]'; }), 'report.sections[0].blocks[0].rows[0][1]', 'inline evidence bracket');
      expectFail(assert, broken('DfitRun', run, (o) => { o.warnings.push({ code: 'X', level: 'warn', text: 'value is NaN', ev: [] }); }), 'warnings[0].text', 'banned word');
      expectFail(assert, broken('DfitRun', run, (o) => { o.evidence.order.pop(); }), 'evidence.order', 'evidence order');
      expectFail(assert, broken('DfitRun', run, (o) => { o.fast = true; }), 'unc', 'a fast run with uncertainty');
      expectFail(assert, broken('DfitRun', run, (o) => { o.prep.pw.pop(); }), 'prep.pw', 'prepared lengths');
      expectFail(assert, broken('DfitRun', run, (o) => { o.events.ev = ['Z1']; }), 'events.ev[0]', 'evidence id');
      expectFail(assert, broken('DfitState', st, (o) => { o.active = 't9'; }), 'active', 'active id');
      expectFail(assert, broken('DfitState', st, (o) => { o.tests[1].picks.closure.reason = ' '; }), 'tests[1].picks.closure.reason', 'user closure without a reason');
      expectFail(assert, broken('DfitState', st, (o) => { o.tests[0].inputs.fluid.muCp = 1e12; }), 'tests[0].inputs.fluid.muCp', 'input outside the range table');
      expectFail(assert, broken('DfitState', st, (o) => { o.tests[0].inputs.options.unc.n = 1000.5; }), 'tests[0].inputs.options.unc.n', 'integer input');
      expectFail(assert, broken('DfitState', st, (o) => { o.tests[1].log[2].seq = 1; }), 'tests[1].log[2].seq', 'append-only log');
      expectFail(assert, broken('DfitState', st, (o) => { o.tests[1].id = 't1'; }), 'tests', 'duplicate test ids');
      expectFail(assert, broken('DfitDataset', ds, (o) => { o.p.pop(); }), 'p', 'dataset lengths');
      expectFail(assert, broken('DfitDataset', ds, (o) => { o.q[5] = -1; }), 'q[5]', 'negative rate');
      expectFail(assert, broken('AcaResult', aca, (o) => { o.pi.label = 'certain'; }), 'pi.label', 'p_i label');
      expectFail(assert, broken('AcaResult', aca, (o) => { o.bounds.kLo = 1; }), 'bounds.kLo', 'k bounds order');
      expectFail(assert, broken('Hammer', sm.Hammer, (o) => { delete o.c; }), 'c', 'missing wave speed');
      expectFail(assert, broken('Consensus', run.consensus, (o) => { o.mode = 'range'; }), 'range', 'range mode without a range');
      expectFail(assert, broken('ClosurePick', run.picks[6], (o) => { o.vote = true; }), 'vote', 'F3 votes');

      // ── failure form, {} and null ──
      assert(S.checkShape('Prepared', sm.Failure).ok && S.checkShape('DfitRun', sm.Failure).ok && S.checkShape('Hammer', sm.Failure).ok, 'failure form passes engine outputs');
      assert(!S.checkShape('DfitInputs', sm.Failure).ok && !S.checkShape('DfitState', sm.Failure).ok, 'failure form never passes inputs or state');
      assert(!S.checkShape('Prepared', { ok: false, code: 'not upper', errors: [], bad: [] }).ok, 'failure code is UPPER_SNAKE');
      S.SHAPE_NAMES.forEach((n) => { assert(!S.checkShape(n, {}).ok, n + ' rejects {}'); assert(!S.checkShape(n, null).ok, n + ' rejects null'); });
      assert(!S.checkShape('NoSuchShape', {}).ok, 'unknown shape');
    },
  },
  {
    name: 'SH2 the range table clamps blank / 0 / −1 / 1e12 for every field and keeps integers integral; 56 carries the same table; skeletons export every §3 name',
    wp: WP,
    opts: false,
    run(app, assert) {
      const BAN = /\b(null|undefined|NaN|Infinity)\b|\[object Object\]/;
      const fields = Object.keys(S.RANGES).filter((k) => !S.RANGES[k].rows);
      assert(fields.length >= 50, 'range table fields: ' + fields.length);
      const probes = ['', 0, -1, 1e12, 'abc', '1,5', null, undefined];
      fields.forEach((k) => {
        const r = S.RANGES[k];
        assert(r.min < r.max && (r.def === null || r.def === 'auto' || (r.def >= r.min && r.def <= r.max)), k + ': min < max and the default inside');
        probes.forEach((v) => {
          const c = S.clampValue(k, v);
          const blank = v === '' || v === null || v === undefined, bad = v === 'abc';
          if (blank || bad) assert(c.value === r.def, k + ' ' + JSON.stringify(v) + ' → default, got ' + c.value);
          else assert(typeof c.value === 'number' && c.value >= r.min && c.value <= r.max, k + ' ' + v + ' → inside [' + r.min + ', ' + r.max + '], got ' + c.value);
          if (r.integer && typeof c.value === 'number') assert(Math.floor(c.value) === c.value, k + ' ' + v + ' stays integral, got ' + c.value);
          if (typeof v === 'number' && (v < r.min || v > r.max)) assert(c.warning && c.warning.code === 'INPUT_CLAMPED', k + ' ' + v + ' warns INPUT_CLAMPED');
          if (bad || (blank && r.def !== null && r.def !== 'auto')) assert(c.warning && c.warning.code === 'INPUT_DEFAULT', k + ' ' + JSON.stringify(v) + ' warns INPUT_DEFAULT');
          if (c.warning) { assert(S.checkShape('Warning', c.warning).ok, k + ' warning shape: ' + JSON.stringify(S.checkShape('Warning', c.warning).errors)); assert(!BAN.test(c.warning.text), k + ' warning text'); }
        });
        if (r.integer) { const c = S.clampValue(k, Math.min(r.max, r.min + 2.6)); assert(c.value === Math.round(Math.min(r.max, r.min + 2.6)) && c.warning.code === 'INPUT_ROUNDED', k + ' rounds'); }
      });
      near(assert, S.clampValue('fluid.muCp', '1,5').value, 1.5, 1e-12, 'decimal comma');
      assert(S.clampValue('options.gMin', 'auto').value === 'auto' && S.clampValue('options.gMin', 3).value === 3, "gMin keeps 'auto'");
      // whole-object clamp: every inputs field set to each probe gives inputs that pass the DfitInputs shape
      const inFields = fields.filter((k) => S.RANGES[k].scope === 'inputs');
      probes.forEach((v) => {
        const raw = S.defaultInputs();
        inFields.forEach((k) => { const ks = k.split('.'); let o = raw; for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]]; o[ks[ks.length - 1]] = v; });
        const out = S.clampInputs(raw), sh = S.checkShape('DfitInputs', out.inputs);
        assert(sh.ok, 'clampInputs(' + JSON.stringify(v) + ') passes DfitInputs: ' + JSON.stringify(sh.errors.slice(0, 4)));
      });
      const big = S.defaultInputs(); big.strings = new Array(14).fill(0).map(() => ({ tubKey: null, id: 4.778, od: 5.5, wall: 0.361, topMd: 0, botMd: 100 })); big.fluid.kind = 'mud';
      const cb = S.clampInputs(big);
      assert(cb.inputs.strings.length === 10 && cb.inputs.fluid.kind === 'water' && cb.warnings.some((w) => w.code === 'ROWS_TRUNCATED'), 'row caps and enums');
      assert(S.checkShape('DfitInputs', S.defaultInputs()).ok, 'the defaults pass DfitInputs');

      // ── 56 carries the same table, enums, defaults and clamp ──
      const { ctx, warns } = loadBare(['56-prism-dfit-core.js']);
      const IR = ctx.PRiSM_dfit_inputRanges;
      assert(IR && typeof IR.clamp === 'function', '56 exports PRiSM_dfit_inputRanges.clamp');
      const plain = (o) => JSON.parse(JSON.stringify(o));
      assert.deepStrictEqual(plain(IR.table), plain(S.RANGES), '56 table = the frozen range table');
      assert.deepStrictEqual(plain(IR.enums), plain(S.ENUMS), '56 enums');
      assert.deepStrictEqual(plain(IR.defaults()), plain(S.defaultInputs()), '56 defaults');
      fields.forEach((k) => probes.concat([2.6, '7.25', 1e-9]).forEach((v) => assert.deepStrictEqual(plain(IR.clampValue(k, v)), plain(S.clampValue(k, v)), '56 clampValue(' + k + ', ' + JSON.stringify(v) + ')')));
      assert.deepStrictEqual(plain(IR.clamp(plain(big))), plain(cb), '56 clamp = reference clamp');
      assert.deepStrictEqual(warns, [], 'no warnings while loading 56');

      // ── skeletons: load in one bare context (no document), export every §3 name as a NOT_IMPLEMENTED stub ──
      const sk = loadBare(SKELETONS), G = sk.ctx;
      assert.deepStrictEqual(sk.warns, [], 'skeletons load silently');
      assert(typeof G.document === 'undefined', 'no document in the bare context');
      const isNI = (r) => r && r.ok === false && r.code === 'NOT_IMPLEMENTED' && Array.isArray(r.errors) && r.errors.length === 1 && Array.isArray(r.bad);
      Object.keys(NAMES).forEach((f) => NAMES[f].forEach((n) => {
        assert(typeof G[n] === 'function', f + ': ' + n + ' exported');
        assert(isNI(G[n]()), n + '() returns NOT_IMPLEMENTED');
        assert(S.checkShape('Failure', G[n]()).ok, n + ' failure shape');
      }));
      Object.keys(JOBS).forEach((f) => JOBS[f].forEach((n) => {
        const j = G[n](); assert(S.checkShape('Job', j).ok && j.step().done === true && isNI(j.result()), n + ' returns a finished Job with a NOT_IMPLEMENTED result');
      }));
      WELLBORE.forEach((n) => assert(typeof G.WTS_wellbore[n] === 'function' && isNI(G.WTS_wellbore[n]()), 'WTS_wellbore.' + n));
      ['make', 'demo', 'cases', 'score'].forEach((n) => assert(isNI(G.PRiSM_dfit_synth[n]()), 'PRiSM_dfit_synth.' + n));
      assert.strictEqual(G.PRiSM_dfit_synth.version, 'g1', 'synth version');
      assert(isNI(G.WTS_dfitInfo.open()) && typeof G.WTS_dfitInfo.notes === 'object', 'WTS_dfitInfo');
      assert(isNI(G.PRiSM_dfit_live.create()), 'PRiSM_dfit_live.create');
      assert.strictEqual(G.PRiSM_dfit_kConstraint(), null, 'kConstraint: null (no DFIT k)');
      assert(typeof G.PRiSM_dfit_analyse === 'function' && typeof G.PRiSM_dfit_analyse().then === 'function', 'PRiSM_dfit_analyse returns a Promise');
      assert(G.PRiSM_dfit_hooks && G.PRiSM_dfit_hooks.liveVerdict === null && Array.isArray(G.PRiSM_dfit_hooks.railRows) && Array.isArray(G.PRiSM_dfit_hooks.step2Cards), 'PRiSM_dfit_hooks');
      assert(G.PRiSM_dfit_units && typeof G.PRiSM_dfit_units.table === 'object' && isNI(G.PRiSM_dfit_units.toEngine()), 'PRiSM_dfit_units');
      assert.deepStrictEqual(plain(G.PRiSM_dfit_cal), { calibrated: false, version: null, generator: null, n: 0,
        hitRate: { single: { high: null, medium: null, low: null }, range: { medium: null, low: null } }, intervalScore: { range: null },
        cusum: { k: 0.5, h: 5, decimate: '2L' }, thresholds: {} }, 'PRiSM_dfit_cal placeholder (§3.9)');
      assert(Object.isFrozen(G.PRiSM_dfit_cal.hitRate.single), 'cal table deep-frozen');
      assert(!G.PRiSM_modeExt || !G.PRiSM_modeExt.dfit, 'the skeleton registers no mode extension');
      assert.deepStrictEqual(Object.keys(G).filter((k) => /^PRiSM_render[A-Za-z0-9_]*(Panel|Manager|Toolbar|Tool|Picker)$/.test(k)), [],
        'no PRiSM_render*Tool export before WP6 (37 would list it under "More")');
      assert(!G.WTS_calcRegistry || Object.keys(G.WTS_calcRegistry).length === 0, 'helper modules add no page');
      // source rules
      SKELETONS.forEach((f) => {
        const src = fs.readFileSync(path.join(BUILD, f), 'utf8');
        assert(!/Math\.random/.test(src), f + ': no Math.random');
        assert(!/\bset(Timeout|Interval)\s*\(|requestAnimationFrame\s*\(/.test(src), f + ': no timers');
        assert((src.match(/^\/\/ === SELF-TEST ===$/gm) || []).length === 1, f + ': exactly one self-test marker');
        if (/^4[89]-calc-/.test(f)) assert(/helper module: does not add a page to window\.WTS_calcRegistry/.test(src), f + ': helper-module header line');
        assert(!/\b(const|let)\s|=>/.test(src.replace(/\/\/.*$/gm, '')), f + ': ES5 style (no const / let / arrow functions)');
      });
      // concat-round8 lists 56–59 after 55, in order
      const { FILES } = require(path.join(BUILD, 'concat-round8.js'));
      const i55 = FILES.indexOf('55-prism-autointerp-cal.js');
      assert.deepStrictEqual(FILES.slice(i55 + 1, i55 + 5), ['56-prism-dfit-core.js', '57-prism-dfit-aca.js', '58-prism-dfit-leakoff.js', '59-prism-dfit-ui.js'], 'Round-8 FILES += 56–59');
    },
  },
];
