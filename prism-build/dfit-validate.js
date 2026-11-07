#!/usr/bin/env node
// prism-build/dfit-validate.js — DFIT offline benchmark, quick checks, wall-clock budgets and the generator of
// 49-calc-dfit-cal.js. Plan: docs/DFIT-PLAN.md §8.2–§8.5 and §9 WP5 (this tool) / WP8 (runs it, 3.4b).
//
//   node prism-build/dfit-validate.js [--set pre|aca|art|all] [--quick] [--perf] [--seed n] [--folds 5] [--write]
//        [--out <dir>] [--cases id,…] [--strict] [--json] [--cal-out <file>] [--limit n]
//
//   --set s       the benchmark set: pre (720 pre-closure cases), aca (120 after-closure), art (60 artefacts), all (900; default)
//   --quick       the 12-case quick set (PRiSM_dfit_synth.cases('quick')) plus the 20-seed live false-call replay of the reference,
//                 the structural spread of the contact case and the multi-start history match of run A (§8.2)
//   --perf        the wall-clock budgets of D26, §4.20 and §5.8 on real timers (the acceptance clock is virtual)
//   --seed n      base seed (default 1): a case with its own seed runs at seed + n − 1, others at n + index
//   --folds k     out-of-fold calibration folds by seed (default 5; --write)
//   --write       calibration (§8.4): per-mode / per-label hit rates with Wilson 95 % intervals (out of fold), the range interval
//                 score; writes prism-build/49-calc-dfit-cal.js (or --cal-out) with calibrated:true — refused (exit 1) when no case
//                 was scored (the engines are not there yet), so the placeholder is never replaced by an empty table
//   --cases a,b   only these case ids (looked up in the integration, quick and benchmark lists)
//   --limit n     only the first n cases of the selection (dry runs)
//   --out dir     report folder (default $TMPDIR/wts-dfit-validate): dfit-validate.json and dfit-validate.md — never committed
//   --strict      exit 1 when a target is missed (quick checks, budgets, hit-rate targets)
//   --json        print the summary JSON on stdout
//   --stub-engine a stand-in pipeline when 57 is not there (plumbing check of the aggregation, report and --write; scores mean nothing)
//
// Per case: PRiSM_dfit_synth.make(spec, seed) → PRiSM_dfit_pipeline(ds, inputsFor(spec), wellFor(spec), emptyPicks, {fast:false,
// seed}) → PRiSM_dfit_synth.score(run, truth). The app is loaded once through tests/_harness.js loadApp({fromSources:true,
// timers:'real', console:'errors'}). A case whose source is not available (58 for 'lk', PRiSM_mpTable for gas) or whose run fails is
// reported with its code, never scored. Exit codes: 0 ok; 1 a target missed (only with --strict) or --write refused; 2 crash.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const CAL_FILE = path.join(ROOT, '49-calc-dfit-cal.js');
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i !== -1 && i + 1 < argv.length ? argv[i + 1] : d; };
const nowMs = () => Number(process.hrtime.bigint()) / 1e6;
const fin = (x) => typeof x === 'number' && isFinite(x);

// §8.4 targets and the budgets of D26 / §4.20 / §5.8 (desktop, ms)
const TARGETS = { singleHigh: 0.90, singleHighLo: 0.85, singleMedium: 0.70, singleMediumLo: 0.60, rangeMedium: 0.70, falseEarly: 0.05 };
const BUDGETS = {
  analyse: 1500, analyseFast: 50, grid: 600, simulateDisplay: 50, simulateFit: 5, simulateCoarse: 1.2, fit: 1000, uncertainty: 60, designer: 1000,
  redraw: 30, spread: 5000,
};

function wilson(k, n) {
  if (!n) return { p: null, lo: null, hi: null, n: 0 };
  const z = 1.959964, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), w = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return { p: +p.toFixed(4), lo: +((c - w) / d).toFixed(4), hi: +((c + w) / d).toFixed(4), n };
}
function pct(x) { return x == null ? '–' : (100 * x).toFixed(1) + ' %'; }
function emptyPicks() { return { isip: null, closure: null, user: {}, aca: { origin: 'centroid', linWin: null, radWin: null, piLevel: null } }; }
function isStub(f) { return typeof f !== 'function' || f._dfitStub === true; }

// ═════════════════════════════════════════════════════════════════════════════
// App and case selection
// ═════════════════════════════════════════════════════════════════════════════
function loadEnv() {
  const harness = require('./tests/_harness');
  const t0 = nowMs();
  const app = harness.loadApp({ fromSources: true, timers: 'real', console: 'errors', silentBuild: true });
  const W = app.win;
  const S = W.PRiSM_dfit_synth;
  if (flag('--stub-engine')) installStubEngine(W);
  const missing = [];
  if (!S || typeof S.make !== 'function' || S.make._dfitStub) missing.push('PRiSM_dfit_synth (49-calc-dfit-synth.js, WP5)');
  const engines = {
    pipeline: !isStub(W.PRiSM_dfit_pipeline), lk: !isStub(W.PRiSM_dfit_lkSimulate), lkFit: !isStub(W.PRiSM_dfit_lkFit), replay: !isStub(W.PRiSM_dfit_replay),
    design: !isStub(W.PRiSM_dfit_design), uncertainty: !isStub(W.PRiSM_dfit_uncertainty), consensus: !isStub(W.PRiSM_dfit_consensus),
    stubEngine: flag('--stub-engine'), inputs: !!(W.PRiSM_dfit_inputRanges && typeof W.PRiSM_dfit_inputRanges.clamp === 'function'), mpTable: typeof W.PRiSM_mpTable === 'function',
  };
  return { app, W, S, missing, engines, loadMs: nowMs() - t0 };
}
// --stub-engine: a stand-in pipeline (plumbing only: aggregation, report and the --write path; it never measures an engine)
function installStubEngine(W) {
  if (!isStub(W.PRiSM_dfit_pipeline)) return;
  W.PRiSM_dfit_pipeline = function (ds) {
    const p = ds.p.slice().sort((a, b) => a - b), mid = p[Math.floor(p.length * 0.75)];
    return { ok: true, consensus: { mode: 'single', value: mid, range: null, confidence: 'medium', families: {} }, isip: { value: Math.max.apply(null, ds.p) },
             classification: { type: 'normal', alt: [] }, aca: null, frac: { chosen: null }, counts: { evals: 0, refits: 0, draws: 0 } };
  };
}
function selectCases(S) {
  const ids = val('--cases', null), set = val('--set', 'all');
  let list;
  if (ids) {
    const want = ids.split(',').map((s) => s.trim()).filter(Boolean);
    const pool = S.cases('integration').concat(S.cases('quick'), S.cases('benchmark'));
    list = want.map((id) => pool.find((c) => c.id === id)).filter(Boolean);
    const unknown = want.filter((id) => !pool.some((c) => c.id === id));
    if (unknown.length) console.log('[validate] unknown case ids: ' + unknown.join(', '));
  } else if (flag('--quick')) list = S.cases('quick');
  else {
    const all = S.cases('benchmark');
    list = set === 'pre' ? all.filter((c) => c.tags.includes('pre')) : set === 'aca' ? all.filter((c) => c.tags.includes('aca'))
      : set === 'art' ? all.filter((c) => c.tags.includes('artefact')) : all;
  }
  const lim = parseInt(val('--limit', '0'), 10);
  return lim > 0 ? list.slice(0, lim) : list;
}

// ═════════════════════════════════════════════════════════════════════════════
// One case
// ═════════════════════════════════════════════════════════════════════════════
function runCase(env, spec, seed) {
  const { W, S } = env, rec = { id: spec.id, source: spec.source, mechanism: spec.mechanism, tags: spec.tags || [], seed, status: null };
  const t0 = nowMs();
  const m = S.make(spec, seed);
  rec.genMs = +(nowMs() - t0).toFixed(1);
  if (!m || m.ok !== true) { rec.status = 'not-generated'; rec.code = m && m.code; rec.why = m && m.errors && m.errors[0]; return rec; }
  rec.n = m.ds.t.length;
  rec.truth = { sigmaC: m.truth.sigmaC, sigmaCF2: m.truth.sigmaCF2, isip: m.truth.isip, pi: m.truth.pi, k: m.truth.k, mechanism: m.truth.mechanism,
                regimeAtEnd: m.truth.regimeAtEnd, AfCf: m.truth.AfCf, Rvis: m.truth.Rvis, xf: m.truth.xf };
  if (!env.engines.pipeline) { rec.status = 'no-pipeline'; rec.code = 'NOT_IMPLEMENTED'; return rec; }
  const inputs = S.inputsFor(spec, m);
  if (!inputs || inputs.ok === false) { rec.status = 'no-inputs'; rec.code = inputs && inputs.code; return rec; }
  const well = S.wellFor(spec, m);
  let run;
  const t1 = nowMs();
  try { run = W.PRiSM_dfit_pipeline(m.ds, inputs, well, emptyPicks(), { fast: false, seed }); } catch (e) { run = { ok: false, code: 'THREW', errors: [String(e && e.message)] }; }
  rec.runMs = +(nowMs() - t1).toFixed(1);
  if (!run || run.ok !== true) { rec.status = 'run-failed'; rec.code = run && run.code; rec.why = run && run.errors && run.errors[0]; return rec; }
  rec.status = 'scored';
  rec.score = JSON.parse(JSON.stringify(S.score(run, m.truth)));
  rec.counts = run.counts ? JSON.parse(JSON.stringify(run.counts)) : null;
  return rec;
}

// ═════════════════════════════════════════════════════════════════════════════
// Aggregation
// ═════════════════════════════════════════════════════════════════════════════
function aggregate(recs) {
  const by = (f) => recs.reduce((o, r) => { const k = f(r); o[k] = (o[k] || 0) + 1; return o; }, {});
  const scored = recs.filter((r) => r.status === 'scored');
  const out = { n: recs.length, status: by((r) => r.status + (r.code ? ':' + r.code : '')), scored: scored.length };
  const rate = (sel, key) => { const s = scored.filter(sel); return { n: s.length, right: wilson(s.filter((r) => r.score[key].right).length, s.length),
    partial: wilson(s.filter((r) => r.score[key].partial).length, s.length) }; };
  // closure per mode and label (never pooled across modes, §8.3)
  out.closure = {};
  ['single', 'range', 'none'].forEach((mode) => {
    const s = scored.filter((r) => r.score.closure.mode === mode);
    const row = { n: s.length, right: wilson(s.filter((r) => r.score.closure.right).length, s.length), byLabel: {} };
    ['high', 'medium', 'low', 'not-estimable'].forEach((lb) => {
      const t = s.filter((r) => r.score.labels.closure === lb);
      if (t.length) row.byLabel[lb] = wilson(t.filter((r) => r.score.closure.right).length, t.length);
    });
    if (mode === 'range') { const is = s.map((r) => r.score.closure.intervalScore).filter(fin); row.intervalScore = is.length ? +(is.reduce((a, b) => a + b, 0) / is.length).toFixed(1) : null; }
    out.closure[mode] = row;
  });
  out.isip = rate(() => true, 'isip');
  out.pi = rate((r) => r.score.pi.err != null || r.score.pi.partial, 'pi');
  out.k = rate((r) => r.truth && r.truth.k != null, 'k');
  out.regime = rate((r) => r.truth && r.truth.regimeAtEnd, 'regime');
  // mechanism confusion matrix (truth class × reported type)
  const cm = {};
  scored.forEach((r) => { const t = r.score.classify.truth || '?', p = r.score.classify.type || '?'; cm[t] = cm[t] || {}; cm[t][p] = (cm[t][p] || 0) + 1; });
  out.classify = Object.assign(rate(() => true, 'classify'), { confusion: cm });
  // pre-closure chain errors (within 3 % right, 10 % partial)
  out.frac = {};
  ['AfCf', 'Rvis', 'xf'].forEach((k) => {
    const e = scored.map((r) => r.score.frac[k]).filter(fin);
    out.frac[k] = { n: e.length, right: wilson(e.filter((x) => Math.abs(x) <= 0.03).length, e.length), partial: wilson(e.filter((x) => Math.abs(x) <= 0.1).length, e.length) };
  });
  const f2 = scored.map((r) => r.score.frac.sigmaCF2).filter(fin);
  out.f2 = { n: f2.length, medianErr: f2.length ? f2.sort((a, b) => a - b)[Math.floor(f2.length / 2)] : null,
             note: 'F2 (end of stiffening) against the model-equivalent point truth.sigmaCF2, reported separately from the F1-onset truth' };
  out.timing = { genMs: med(recs.map((r) => r.genMs)), runMs: med(scored.map((r) => r.runMs)) };
  return out;
}
function med(a) { const s = a.filter(fin).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; }

// calibration table (§8.4): out-of-fold by seed — the hit rate of each label is measured on the cases of the other folds' seeds
// only in WP8's threshold search; with fixed 3.4a thresholds the per-fold rates are pooled (they are out of fold by construction)
function calibrate(recs, folds) {
  const scored = recs.filter((r) => r.status === 'scored');
  const cell = (mode, lb) => { const s = scored.filter((r) => r.score.closure.mode === mode && r.score.labels.closure === lb); return s.length ? wilson(s.filter((r) => r.score.closure.right).length, s.length) : null; };
  const range = scored.filter((r) => r.score.closure.mode === 'range').map((r) => r.score.closure.intervalScore).filter(fin);
  const foldN = []; for (let f = 0; f < folds; f++) foldN.push(scored.filter((r) => (r.seed % folds) === f).length);
  return {
    calibrated: true, version: 'g1-' + new Date().toISOString().slice(0, 10), generator: 'g1', n: scored.length,
    hitRate: { single: { high: cell('single', 'high'), medium: cell('single', 'medium'), low: cell('single', 'low') },
               range: { medium: cell('range', 'medium'), low: cell('range', 'low') } },
    intervalScore: { range: range.length ? +(range.reduce((a, b) => a + b, 0) / range.length).toFixed(1) : null },
    cusum: { k: 0.5, h: 5, decimate: '2L' }, thresholds: {}, folds: { k: folds, n: foldN },
  };
}
function calSource(tbl) {
  const appVer = (() => { try { const m = /ver:\s*'([0-9.]+)'/.exec(fs.readFileSync(path.join(ROOT, '..', 'well-testing-app.html'), 'utf8').slice(0, 2e6)); return m ? m[1] : null; } catch (e) { return null; } })();
  tbl.date = new Date().toISOString().slice(0, 10); tbl.appVersion = appVer;
  return '// =============================================================================\n'
    + '// WTS — 49-calc-dfit-cal.js  (Round 9)\n'
    + '// GENERATED by dfit-validate.js --write — never edit by hand\n'
    + '// -----------------------------------------------------------------------------\n'
    + '// helper module: does not add a page to window.WTS_calcRegistry\n'
    + '//\n'
    + '// window.PRiSM_dfit_cal — the DFIT confidence-label calibration table (docs/DFIT-PLAN.md §3.9, §8.4), measured on ' + tbl.n + ' synthetic\n'
    + '// cases (generator ' + tbl.generator + '). Loads with no document and no other symbol; the table is deep-frozen.\n'
    + '// =============================================================================\n\n'
    + '(function () {\n    \'use strict\';\n    var G = (typeof window !== \'undefined\') ? window : globalThis;\n'
    + '    function freeze(o) { if (o && typeof o === \'object\' && !Object.isFrozen(o)) { Object.freeze(o); Object.keys(o).forEach(function (k) { freeze(o[k]); }); } return o; }\n'
    + '    G.PRiSM_dfit_cal = freeze(' + JSON.stringify(tbl, null, 4).replace(/\n/g, '\n    ') + ');\n})();\n\n'
    + '// === SELF-TEST ===\n(function () {\n    \'use strict\';\n    var G = (typeof window !== \'undefined\') ? window : globalThis, c = G.PRiSM_dfit_cal;\n'
    + '    if ((!c || c.calibrated !== true || !c.cusum) && typeof console !== \'undefined\') console.warn(\'[49-calc-dfit-cal self-test] table\');\n})();\n';
}

// ═════════════════════════════════════════════════════════════════════════════
// --quick extras: 20-seed live replay, structural spread, multi-start (§8.2)
// ═════════════════════════════════════════════════════════════════════════════
function quickExtras(env) {
  const { W, S } = env, out = {};
  const ref = S.cases('integration')[0], contact = S.cases('integration')[1];
  // 1. live false-call replay: provisional closure calls before the true closure time, 20 seeds of the reference
  if (!env.engines.replay) out.replay = { skipped: 'PRiSM_dfit_replay (57, WP3) is not implemented yet' };
  else {
    const t0 = nowMs(); let n = 0, early = 0, delays = [], fails = [];
    for (let s = 1; s <= 20; s++) {
      const spec = JSON.parse(JSON.stringify(ref)); spec.noise = { sigma: 0.05, rho1: 0, quantum: 0.01 };
      const m = S.make(spec, s);
      if (!m.ok) { fails.push(m.code); continue; }
      let r;
      try { r = W.PRiSM_dfit_replay(m.ds, { inputs: S.inputsFor(spec, m), well: S.wellFor(spec, m) }); } catch (e) { r = null; }
      if (!r || !r.firsts) { fails.push('REPLAY_FAILED'); continue; }
      n++;
      const tcRec = m.truth.tStart + m.truth.tcInj, fp = r.firsts.closureProvisional, fc = r.firsts.closureConfirmed;
      if (fin(fp) && fp < tcRec) early++;
      if (fin(fc)) { const dt = fc - m.truth.ts, dtc = m.truth.dtc; if (dt > 0 && dtc > 0) delays.push(Math.log10(S.G(dt / m.truth.tp, 0.5) / S.G(dtc / m.truth.tp, 0.5))); }
    }
    out.replay = { n, falseEarly: n ? +(early / n).toFixed(3) : null, target: TARGETS.falseEarly, medianDelayGDecade: med(delays), ms: +(nowMs() - t0).toFixed(0),
                   failures: fails, ok: n > 0 && early / n <= TARGETS.falseEarly };
    if (!n) out.replay.skipped = 'no replay ran (' + (fails[0] || 'no generated case') + ')';
  }
  // 2. structural spread of the contact case (3 aperture laws × PDL on / off): σ_c range contains the truth
  if (!env.engines.lkFit || !env.engines.lk) out.spread = { skipped: 'PRiSM_dfit_lkFit / lkSimulate (58, WP4) not implemented yet' };
  else {
    const m = S.make(contact, 1);
    if (!m.ok) out.spread = { skipped: m.code };
    else {
      const t0 = nowMs(), i0 = m.ds.t.findIndex((t) => t > m.truth.ts);
      const data = { t: m.ds.t.slice(i0).map((t) => t - m.truth.tStart), p: m.ds.p.slice(i0) };
      let f;
      try { f = W.PRiSM_dfit_lkFit(data, contact.lk, 'falloff', { structural: true }); } catch (e) { f = { ok: false, code: 'THREW', errors: [String(e && e.message)] }; }
      const ms = nowMs() - t0, sr = f && f.structural && f.structural.sigmaC;
      out.spread = { ok: !!(f && f.ok && Array.isArray(sr) && sr[0] <= m.truth.sigmaC && m.truth.sigmaC <= sr[1]), sigmaC: sr || null, truth: m.truth.sigmaC,
                     ms: +ms.toFixed(0), budgetMs: BUDGETS.spread, code: f && f.ok === false ? f.code : undefined };
    }
  }
  // 3. multi-start history match of run A (the reference falloff, preset 'falloff'): starts converge, truth inside the 95 % CI
  if (!env.engines.lkFit || !env.engines.lk) out.multiStart = { skipped: 'PRiSM_dfit_lkFit (58, WP4) not implemented yet' };
  else {
    const m = S.make(ref, 1);
    if (!m.ok) out.multiStart = { skipped: m.code };
    else {
      const i0 = m.ds.t.findIndex((t) => t > m.truth.ts);
      const data = { t: m.ds.t.slice(i0).map((t) => t - m.truth.tStart), p: m.ds.p.slice(i0) };
      const t0 = nowMs();
      let f;
      try { f = W.PRiSM_dfit_lkFit(data, ref.lk, 'falloff', { starts: 8, seed: 1 }); } catch (e) { f = { ok: false, code: 'THREW' }; }
      const ci = f && f.ci95 && f.ci95.sigmaC;
      out.multiStart = { ok: !!(f && f.ok && f.starts && f.starts.converged >= Math.ceil(0.75 * f.starts.n) && Array.isArray(ci) && ci[0] <= m.truth.sigmaC && m.truth.sigmaC <= ci[1]),
                         starts: f && f.starts, ci95SigmaC: ci || null, ms: +(nowMs() - t0).toFixed(0), code: f && f.ok === false ? f.code : undefined };
    }
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// --perf: wall-clock budgets (real timers)
// ═════════════════════════════════════════════════════════════════════════════
function timeIt(fn, reps) {
  fn();   // warm up
  const t = [];
  for (let i = 0; i < (reps || 3); i++) { const t0 = nowMs(); fn(); t.push(nowMs() - t0); }
  t.sort((a, b) => a - b);
  return +t[Math.floor(t.length / 2)].toFixed(2);
}
function perf(env) {
  const { W, S } = env, out = {};
  const row = (name, ms, budget, note) => { out[name] = { ms, budget, ok: ms == null ? null : ms <= budget, note: note || undefined }; };
  // the generator itself (informational)
  const spec = S.demoSpec('reference');
  out.generate = { ms: timeIt(() => S.make(spec.spec, spec.seed), 3), budget: null, ok: null, note: 'make(reference demo), informational' };
  const ds = S.demo('reference');
  const inputs = S.inputsFor(spec.spec, null), well = S.wellFor(spec.spec, null);
  if (env.engines.pipeline && inputs && inputs.ok !== false) {
    row('analyse', timeIt(() => W.PRiSM_dfit_pipeline(ds, inputs, well, emptyPicks(), { fast: false, seed: 1 }), 3), BUDGETS.analyse, 'PRiSM_dfit_pipeline, full');
    row('analyseFast', timeIt(() => W.PRiSM_dfit_pipeline(ds, inputs, well, emptyPicks(), { fast: true, seed: 1 }), 5), BUDGETS.analyseFast, 'opts.fast');
    if (env.engines.uncertainty) {
      const run = W.PRiSM_dfit_pipeline(ds, inputs, well, emptyPicks(), { fast: false, seed: 1 });
      row('uncertainty', timeIt(() => W.PRiSM_dfit_uncertainty(run, { n: 1000, seed: 1 }), 3), BUDGETS.uncertainty, '1,000 draws');
    } else out.uncertainty = { skipped: 'PRiSM_dfit_uncertainty (57) not implemented yet' };
  } else { out.analyse = { skipped: 'PRiSM_dfit_pipeline (57, WP3) not implemented yet' }; out.uncertainty = { skipped: 'needs the pipeline' }; }
  if (env.engines.lk) {
    const cfg = S.cases('integration')[0].lk;
    row('simulateDisplay', timeIt(() => W.PRiSM_dfit_lkSimulate(cfg, { grid: 'display' }), 5), BUDGETS.simulateDisplay, 'N ≈ 1,840');
    row('simulateFit', timeIt(() => W.PRiSM_dfit_lkSimulate(cfg, { grid: 'fit' }), 9), BUDGETS.simulateFit, 'N ≈ 600');
    row('simulateCoarse', timeIt(() => W.PRiSM_dfit_lkSimulate(cfg, { grid: 'coarse' }), 15), BUDGETS.simulateCoarse, 'N ≈ 232');
    if (env.engines.lkFit) {
      const m = S.make(S.cases('integration')[0], 1);
      if (m.ok) {
        const i0 = m.ds.t.findIndex((t) => t > m.truth.ts), data = { t: m.ds.t.slice(i0).map((t) => t - m.truth.tStart), p: m.ds.p.slice(i0) };
        row('fit', timeIt(() => W.PRiSM_dfit_lkFit(data, cfg, 'falloff', {}), 1), BUDGETS.fit, 'history match, preset falloff');
      }
    } else out.fit = { skipped: 'PRiSM_dfit_lkFit (58) not implemented yet' };
    if (env.engines.design) {
      const ranges = { k: { p10: 1e-4, p90: 1e-2 }, phi: { p10: 0.04, p90: 0.08 }, ct: { p10: 8e-6, p90: 1.5e-5 }, muRes: { p10: 0.3, p90: 0.8 }, h: { p10: 30, p90: 60 },
        hf: { p10: 40, p90: 80 }, hp: 40, Ep: { p50: 5e6, sdLn: 0.25 }, nu: 0.25, sigmaGrad: { p50: 0.7, sd: 0.02 }, piGrad: { p50: 0.45, sd: 0.02 }, datumTvd: 10000,
        strings: [], fluid: { kind: 'slickwater', rhoPpg: 8.43, muCp: 1 }, gauge: { kind: 'bh', sigma: 0.05, resolution: 0.01, hz: 1, driftPsiPerDay: 0.1 },
        V: null, q: null, suggest: true, allowedShutInD: 10, targetW: null, repressurise: false, epsMax: 0.05, leakEps: 0.05 };
      row('designer', timeIt(() => W.PRiSM_dfit_design(ranges, { n: 500, seed: 1, grid: 'coarse' }), 1), BUDGETS.designer, '500 coarse runs');
    } else out.designer = { skipped: 'PRiSM_dfit_design (58) not implemented yet' };
  } else ['simulateDisplay', 'simulateFit', 'simulateCoarse', 'fit', 'designer'].forEach((k) => { out[k] = { skipped: 'PRiSM_dfit_lkSimulate (58, WP4) not implemented yet' }; });
  // stability grid alone (56): the consensus over the closed-form methods
  if (env.engines.consensus && env.engines.pipeline) {
    const run = W.PRiSM_dfit_pipeline(ds, inputs, well, emptyPicks(), { fast: true, seed: 1 });
    if (run && run.ok) row('grid', timeIt(() => W.PRiSM_dfit_consensus(run.picks, { derivs: run.derivs, prep: run.prep, inputs, seed: 1 }), 3), BUDGETS.grid, 'stability grid (closed-form methods)');
  } else out.grid = { skipped: 'PRiSM_dfit_consensus (56, WP2) / the pipeline not implemented yet' };
  // redraw: one DFIT plot through PRiSM_drawPlot (needs the DFIT plot registry of 59)
  const reg = W.PRiSM_PLOT_REGISTRY;
  if (typeof W.PRiSM_drawPlot === 'function' && reg && reg.dfitG && W.document) {
    const cv = W.document.createElement('canvas'); cv.width = 800; cv.height = 500;
    row('redraw', timeIt(() => W.PRiSM_drawPlot(cv, 'dfitG', {}), 5), BUDGETS.redraw, 'dfitG via PRiSM_drawPlot (recording canvas)');
  } else out.redraw = { skipped: 'PRiSM_drawPlot / the dfitG plot (WPH, WP6) not available yet' };
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// Report
// ═════════════════════════════════════════════════════════════════════════════
function markdown(sum) {
  const L = [];
  L.push('# DFIT validation (' + sum.mode + ')', '', 'Generator ' + sum.generator + ', ' + sum.date + '. App built from sources in ' + sum.loadMs + ' ms.', '');
  L.push('Engines: ' + Object.keys(sum.engines).map((k) => k + (sum.engines[k] ? ' ✓' : ' –')).join(', '), '');
  if (sum.agg) {
    const a = sum.agg;
    L.push('## Cases', '', '| status | n |', '|---|---|');
    Object.keys(a.status).forEach((k) => L.push('| ' + k + ' | ' + a.status[k] + ' |'));
    L.push('', 'Scored: ' + a.scored + ' of ' + a.n + '. Median generate ' + a.timing.genMs + ' ms, run ' + a.timing.runMs + ' ms.', '');
    L.push('## Closure (per mode; never pooled)', '', '| mode | n | right | by label |', '|---|---|---|---|');
    Object.keys(a.closure).forEach((m) => { const r = a.closure[m]; L.push('| ' + m + ' | ' + r.n + ' | ' + pct(r.right.p) + ' (' + pct(r.right.lo) + '–' + pct(r.right.hi) + ') | '
      + Object.keys(r.byLabel).map((lb) => lb + ' ' + pct(r.byLabel[lb].p) + ' of ' + r.byLabel[lb].n).join('; ') + (r.intervalScore != null ? '; mean interval score ' + r.intervalScore : '') + ' |'); });
    L.push('', '## Other outputs', '', '| output | n | right | partial |', '|---|---|---|---|');
    ['isip', 'classify', 'pi', 'k', 'regime'].forEach((k) => { const r = a[k]; L.push('| ' + k + ' | ' + r.n + ' | ' + pct(r.right.p) + ' | ' + pct(r.partial.p) + ' |'); });
    ['AfCf', 'Rvis', 'xf'].forEach((k) => { const r = a.frac[k]; L.push('| ' + k + ' (3 % / 10 %) | ' + r.n + ' | ' + pct(r.right.p) + ' | ' + pct(r.partial.p) + ' |'); });
    L.push('', '## Mechanism confusion (truth → reported)', '');
    Object.keys(a.classify.confusion).forEach((t) => L.push('- ' + t + ': ' + Object.keys(a.classify.confusion[t]).map((p) => p + ' ' + a.classify.confusion[t][p]).join(', ')));
    L.push('', 'Caveat: the truth closure is the mini-model\'s contact onset, which embeds the contact physics, so the calibration favours F1 by '
      + 'construction; F2 is checked against its own model-equivalent point (median error ' + (a.f2.medianErr == null ? '–' : a.f2.medianErr.toFixed(1) + ' psi') + ').', '');
  }
  if (sum.quick) {
    L.push('## Quick checks', '');
    Object.keys(sum.quick).forEach((k) => { const q = sum.quick[k]; L.push('- ' + k + ': ' + (q.skipped ? 'skipped — ' + q.skipped : (q.ok ? 'ok' : 'MISSED') + ' ' + JSON.stringify(q))); });
    L.push('');
  }
  if (sum.perf) {
    L.push('## Wall-clock budgets (desktop, ms)', '', '| item | ms | budget | |', '|---|---|---|---|');
    Object.keys(sum.perf).forEach((k) => { const r = sum.perf[k]; L.push('| ' + k + ' | ' + (r.skipped ? '–' : r.ms) + ' | ' + (r.budget == null ? '–' : r.budget) + ' | '
      + (r.skipped ? 'skipped: ' + r.skipped : r.ok === null ? (r.note || '') : (r.ok ? 'ok' : 'MISSED') + (r.note ? ' — ' + r.note : '')) + ' |'); });
    L.push('');
  }
  if (sum.write) L.push('## Calibration', '', sum.write, '');
  return L.join('\n');
}

// ═════════════════════════════════════════════════════════════════════════════
// main
// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  const outDir = val('--out', path.join(os.tmpdir(), 'wts-dfit-validate'));
  const env = loadEnv();
  if (env.missing.length) { console.error('[validate] not runnable, missing: ' + env.missing.join('; ')); env.app.dispose && env.app.dispose(); return 2; }
  const S = env.S;
  const quick = flag('--quick'), doPerf = flag('--perf'), strict = flag('--strict'), base = Math.max(1, parseInt(val('--seed', '1'), 10) || 1);
  const sum = { mode: quick ? 'quick' : (doPerf && !flag('--set') && !flag('--cases') ? 'perf' : 'benchmark ' + val('--set', 'all')), generator: S.version,
                date: new Date().toISOString(), loadMs: +env.loadMs.toFixed(0), engines: env.engines };
  let missed = [];
  const runCases = !(doPerf && !quick && !flag('--set') && !flag('--cases') && !flag('--write'));
  let recs = [];
  if (runCases) {
    const list = selectCases(S);
    console.log('[validate] ' + list.length + ' cases' + (env.engines.pipeline ? '' : ' (PRiSM_dfit_pipeline is not implemented yet: cases are generated, not scored)'));
    const t0 = nowMs();
    list.forEach((spec, i) => {
      const seed = spec.seed ? spec.seed + base - 1 : base + i;
      const r = runCase(env, spec, seed);
      recs.push(r);
      if ((i + 1) % 50 === 0 || i === list.length - 1) console.log('[validate] ' + (i + 1) + '/' + list.length + '  ' + ((nowMs() - t0) / 1000).toFixed(1) + ' s');
    });
    sum.agg = aggregate(recs);
    const a = sum.agg.closure;
    if (sum.agg.scored) {
      const sh = a.single.byLabel.high, sm = a.single.byLabel.medium, rm = a.range.byLabel.medium;
      if (sh && (sh.p < TARGETS.singleHigh || sh.lo < TARGETS.singleHighLo)) missed.push('single high ' + pct(sh.p));
      if (sm && (sm.p < TARGETS.singleMedium || sm.lo < TARGETS.singleMediumLo)) missed.push('single medium ' + pct(sm.p));
      if (rm && rm.p < TARGETS.rangeMedium) missed.push('range medium ' + pct(rm.p));
    }
  }
  if (quick) {
    sum.quick = quickExtras(env);
    Object.keys(sum.quick).forEach((k) => { if (!sum.quick[k].skipped && sum.quick[k].ok === false) missed.push('quick ' + k); });
  }
  if (doPerf) {
    sum.perf = perf(env);
    Object.keys(sum.perf).forEach((k) => { if (sum.perf[k].ok === false) missed.push('budget ' + k); });
  }
  let code = 0;
  if (flag('--write')) {
    const tbl = calibrate(recs, Math.max(2, parseInt(val('--folds', '5'), 10) || 5));
    if (!tbl.n) { sum.write = 'refused: no case was scored (the pipeline and engines are not available yet); the placeholder is kept'; console.log('[validate] --write ' + sum.write); code = 1; }
    else {
      const f = val('--cal-out', CAL_FILE);
      fs.writeFileSync(f, calSource(tbl));
      sum.write = 'wrote ' + path.relative(process.cwd(), f) + ' (n ' + tbl.n + ')';
      console.log('[validate] ' + sum.write);
    }
  }
  sum.missed = missed;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'dfit-validate.json'), JSON.stringify({ summary: sum, cases: recs }, null, 1));
  fs.writeFileSync(path.join(outDir, 'dfit-validate.md'), markdown(sum));
  console.log('[validate] report: ' + path.join(outDir, 'dfit-validate.md'));
  if (sum.agg) console.log('[validate] scored ' + sum.agg.scored + ' of ' + sum.agg.n + '; status ' + JSON.stringify(sum.agg.status));
  if (sum.quick) Object.keys(sum.quick).forEach((k) => console.log('[validate] quick ' + k + ': ' + (sum.quick[k].skipped ? 'skipped — ' + sum.quick[k].skipped : (sum.quick[k].ok ? 'ok' : 'MISSED'))));
  if (sum.perf) Object.keys(sum.perf).forEach((k) => { const r = sum.perf[k]; console.log('[validate] perf ' + k + ': ' + (r.skipped ? 'skipped — ' + r.skipped : r.ms + ' ms' + (r.budget ? ' / ' + r.budget + (r.ok ? ' ok' : ' MISSED') : ''))); });
  if (flag('--json')) console.log(JSON.stringify(sum, null, 1));
  if (missed.length) console.log('[validate] targets missed: ' + missed.join('; '));
  try { env.app.dispose && env.app.dispose(); } catch (e) { /* ignore */ }
  if (strict && missed.length) code = 1;
  return code;
}

if (require.main === module) main().then((c) => process.exit(c), (e) => { console.error('[validate] crash: ' + (e && e.stack || e)); process.exit(2); });
module.exports = { wilson, aggregate, calibrate, calSource, TARGETS, BUDGETS };
