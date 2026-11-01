#!/usr/bin/env node
// prism-build/buildup-validate.js — Build-up Surveillance offline benchmark, calibration and the generator of file 55.
// Plan: docs/BUILDUP-SURVEILLANCE-PLAN.md §5.2–§5.6 and §9 WP4 (this tool) / WP8 (runs it).
//
//   node prism-build/buildup-validate.js [--quick] [--strata hom,fault] [--seeds 100000-100639] [--sequences]
//        [--workers 4] [--out <dir>] [--write] [--placeholder] [--perf] [--strict] [--json]
//
//   --placeholder  write prism-build/55-prism-autointerp-cal.js with calibrated:false and the pre-calibration thresholds,
//                  without running anything (works on any checkout)
//   --quick        60 cases (4 per stratum) plus the 20-seed false-rival check on homogeneous truth
//   --seeds a-b    single-case seeds (ranges and comma lists; default the full table 100000–100639)
//   --strata s,t   keep only these strata
//   --sequences    also run the 120 multi-test wells (200000–200119)
//   --write        calibration (§5.4): the threshold searches (5 training folds + all folds, in parallel worker processes),
//                  the first out-of-fold pass (no KC2 cap), the candidate table <out>/cal-candidate.js, a re-run of every
//                  item with it, the second out-of-fold pass with the engine's KC2 envelope flags (the shipped tables, as
//                  the app labels), the in-app and benchmark seeds; writes file 55 (calibrated:true), <out>/calibration.md
//                  and <out>/benchmark-snapshot.js (the BM1 / BM2 arrays of buildup-benchmark.test.js); exits 1 and leaves
//                  file 55 alone unless all 24 in-app cases meet margin ≥ 0.1 (the lite candidate pool widens before it gives up)
//   --perf         the §4.8 timing targets (wall clock) on the oil demo, the reference case (US4, 72 h; per stage), the
//                  365-daily-step reference and a 500k-row file; --strict exits 1 on a miss
//   --workers n    child processes (default min(4, CPUs)); worker i takes the seeds ≡ i (mod n)
//   --out dir      output directory (default $TMPDIR/wts-buildup-validate): cases.jsonl, summary.json, calibration.md
//   --json         print the summary as JSON on stdout
//   --lite         generate every case with the lite settings (60 s sampling, ≤ 30 days; what the in-app check uses)
//   --grid-sample n  evaluate only every n-th combination of the calibration grid (quick dry runs; default 1)
//   --cal-out f    write the calibration file to f instead of prism-build/55-prism-autointerp-cal.js (dry runs)
//   --stub-engine  plumbing check only: an empty analysis stands in for WP1/WP2 (workers, case file, summary, --write path)
//
// Pipeline per case: synth.generate(synth.caseFromSeed(seed)) → run.analyse(synth.toInput(case)) → synth.scoreAnalysis.
// The app is loaded once per worker through tests/_harness.js loadApp({fromSources:true, timers:'real', console:'errors'}).
// One JSON line per case goes to <out>/cases.jsonl (seed, stratum, truth, outcome, evidence vector, labels, timings).
//
// Exit codes: 0 ok; 1 targets missed (only with --strict); 2 crash, or not runnable (a prerequisite engine is missing: the
// run needs PRiSM_autoInterp.interpretJob (WP1) and WTS_buildup.run.analyse (WP2); --placeholder needs neither).
// Only file 55 is ever committed; reports and case files stay in --out.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');

const ROOT = __dirname;
const CAL_FILE = path.join(ROOT, '55-prism-autointerp-cal.js');
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i !== -1 && i + 1 < argv.length ? argv[i + 1] : d; };
const nowMs = () => Number(process.hrtime.bigint()) / 1e6;
const IS_WORKER = flag('--worker');

// Pre-calibration thresholds (§4.10 and §5.1 defaults; the values the engine uses until WP8 calibrates).
const PRE_THRESHOLDS = {
  snrHigh: 20, sErrHigh: 0.5, fairSpanHigh: 0.7, pointSkinSpread: 0.3, tauBic: 10, rateTolPct: 15, sErrFloor: 0.2, deltaForm: 'plain',
  sErrLow: 1.0, snrLow: 5, disagreeDS: 1.0, disagreeKPct: 15, reachFactor: 3.98, distractorRule: true, kHeldRmsK: 3,
};
// §5.4 staged grid
const GRID_STAGE1 = { sErrLow: [0.8, 1.0, 1.2], snrLow: [3, 5, 8], disagreeDS: [0.7, 1.0], disagreeKPct: [10, 15], reachFactor: [3.16, 3.98, 5.0],
                      distractorRule: [true, false], kHeldRmsK: [2, 3, 4] };
const GRID_STAGE2 = { snrHigh: [10, 15, 20, 30], sErrHigh: [0.3, 0.4, 0.5, 0.6], fairSpanHigh: [0.6, 0.7, 0.8, 1.0], pointSkinSpread: [0.2, 0.3, 0.4],
                      tauBic: [6, 10, 20, 40], rateTolPct: [10, 15, 20], sErrFloor: [0.2, 0.25, 0.3, 0.4] };
// reach: share of analysable-truth single cases whose true closing reaches an analysable test of the pipeline (per stratum; a
// check on detection, implied by the ≤ 10 % abstention constraint on hom); stimShutin / gasNoAlert: the §5.2 sequence targets.
const TARGETS = { highRate: 0.95, highLo: 0.90, medRate: 0.80, medLo: 0.70, lowGap: 0.20, falseRival: 0.05, cover: 0.90, abstainHom: 0.10, falseAlarm: 0.05,
                  reach: 0.90, stimShutin: 0.95, gasNoAlert: 1.0 };
const SINGLE = [100000, 100639], SEQ = [200000, 200119], MASTER = 3300;

// ═════════════════════════════════════════════════════════════════════════════
// File 55
// ═════════════════════════════════════════════════════════════════════════════
const LABELS = ['high', 'medium', 'low'];
function emptyKsRow(label) { return { label, n: 0, right: null, lo: null, hi: null, loCluster: null, hiCluster: null, medAbsDS: null, cover2: null }; }
function emptyTblRow(label) { return { label, n: 0, fullyRight: null, lo: null, hi: null, loCluster: null, hiCluster: null, kRight: null, sRight: null, modelRight: null, medAbsDS: null, cover2: null }; }
function todayUTC() { return new Date().toISOString().slice(0, 10); }
// The provisional 24 in-app cases (WP8 replaces them by seeds chosen with margin ≥ 0.1). Kept in step with synth's IN_APP_DEFAULT.
const IN_APP_PROVISIONAL = [
  [100003, 'hom'], [100017, 'hom'], [100041, 'hom'], [100088, 'hom'], [100120, 'hom'], [100160, 'hom'], [100205, 'hom'],
  [100236, 'fault'], [100270, 'fault'], [100300, 'comp'], [100340, 'comp'], [100360, 'closed'], [100380, 'closed'],
  [100400, 'gas'], [100430, 'gas'], [100460, 'gas'], [100470, 'inj'], [100485, 'inj'], [100500, 'dualpor'], [100530, 'channel'],
  [100555, 'wbschange'], [100598, 'constp'], [100620, 'partial'], [100630, 'baddata'],
];
function placeholderCal(date) {
  return {
    version: 'cal-0', calibrated: false, generated: date || todayUTC(), app: 'v3.3', engine: '1.0',
    seeds: { single: SINGLE.slice(), sequences: SEQ.slice(), master: MASTER }, nCases: 0, nBuildups: 0,
    thresholds: Object.assign({}, PRE_THRESHOLDS),
    ksTable: LABELS.map(emptyKsRow), table: LABELS.map(emptyTblRow), strict: LABELS.map(emptyTblRow),
    kHeldTable: ['medium', 'low'].map(emptyKsRow), gasTable: LABELS.map(emptyTblRow),
    brier: null, bss: null, reliability: null, resolution: null, uncertainty: null, falseRival: null,
    abstain: { n: 0, rate: null, rateHom: null }, distractorCaught: { n: 0, rate: null }, rateAccuracy: { medAbsPct: null, p90AbsPct: null },
    // design ranges of §5.2 (wide): KC2 caps every label anyway while calibrated is false
    envelope: { CD: [null, null], S: [-2, 15], tDCDend: [null, null], snrD: [null, null], k: [1, 2000], dtEnd_h: [2, 200] },
    sequences: { falseAlarmDelta: null, falseAlarmAbs: null, delayMedian: null, delayMedianShort: null, onsetWithin1: null, senCover: null },
    inApp: IN_APP_PROVISIONAL.map(([seed, stratum]) => ({ seed, stratum, expect: { status: null, ks: null, headline: null, fullyRight: null }, margin: null })),
  };
}
function stableJSON(o, ind) {
  const sortKeys = (v) => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') { const r = {}; Object.keys(v).sort().forEach((k) => { r[k] = sortKeys(v[k]); }); return r; }
    return v;
  };
  return JSON.stringify(sortKeys(o), (k, v) => (typeof v === 'number' && !isFinite(v) ? null : v), ind);
}
function calSource(cal) {
  const head = [
    '// =============================================================================',
    '// PRiSM — 55-prism-autointerp-cal.js  (Round 8)',
    '// GENERATED by buildup-validate.js — do not edit by hand',
    '// version ' + cal.version + (cal.calibrated ? ' (calibrated)' : ' (placeholder, not calibrated)') + ' · generated ' + cal.generated +
      ' · seeds single ' + cal.seeds.single.join('–') + ', sequences ' + cal.seeds.sequences.join('–') + ', master ' + cal.seeds.master,
    '// -----------------------------------------------------------------------------',
    '// window.PRiSM_autoInterpCal — the confidence-label calibration table (docs/BUILDUP-SURVEILLANCE-PLAN.md §3.5, §5.4).',
    cal.calibrated
      ? '// Thresholds and both reliability tables come from ' + cal.nBuildups + ' labelled build-ups (' + cal.nCases + ' single cases plus the sequences).'
      : '// calibrated:false: the engine uses the pre-calibration thresholds, KC2 caps every label at medium and the page shows',
    cal.calibrated
      ? '// Regenerate with: node prism-build/buildup-validate.js --sequences --write'
      : '// "labels not yet calibrated". WP8 regenerates this file with: node prism-build/buildup-validate.js --sequences --write',
    '// Loads with no document and no other symbol; the table is deep-frozen.',
    '// =============================================================================',
    '',
    '(function () {',
    "    'use strict';",
    "    var G = (typeof window !== 'undefined') ? window : globalThis;",
    '    function freeze(o) { if (o && typeof o === \'object\' && !Object.isFrozen(o)) { Object.freeze(o); Object.keys(o).forEach(function (k) { freeze(o[k]); }); } return o; }',
    '    G.PRiSM_autoInterpCal = freeze(' + stableJSON(cal, 2).split('\n').join('\n    ') + ');',
    '})();',
    '',
    '// === SELF-TEST ===',
    '(function () {',
    "    'use strict';",
    "    var G = (typeof window !== 'undefined') ? window : globalThis, c = G.PRiSM_autoInterpCal, bad = [];",
    "    if (!c || typeof c !== 'object') bad.push('missing table');",
    "    else ['ksTable', 'table', 'strict', 'kHeldTable', 'gasTable', 'inApp'].forEach(function (k) { if (!Array.isArray(c[k])) bad.push(k + ' not an array'); });",
    "    if (c && (!c.thresholds || typeof c.thresholds.tauBic !== 'number')) bad.push('thresholds');",
    "    if (bad.length) console.warn('[55-prism-autointerp-cal self-test] ' + bad.join('; '));",
    '})();',
    '',
  ];
  return head.join('\n');
}
function writeCal(cal, file) {
  const src = calSource(cal);
  fs.writeFileSync(file || CAL_FILE, src, 'utf8');
  return src;
}

// ═════════════════════════════════════════════════════════════════════════════
// App environment
// ═════════════════════════════════════════════════════════════════════════════
// BUV_CAL_SRC (a file path): the workers load that calibration file in place of prism-build/55-prism-autointerp-cal.js
// (the --write verification runs the candidate table before it is committed to file 55).
function loadEnv() {
  const harness = require('./tests/_harness');
  const calSrc = process.env.BUV_CAL_SRC ? fs.readFileSync(process.env.BUV_CAL_SRC, 'utf8') : null;
  const app = harness.loadApp(Object.assign({ fromSources: true, timers: 'real', console: 'errors' },
    calSrc ? { sourceOverrides: { '55-prism-autointerp-cal.js': calSrc } } : {}));
  const W = app.win, BU = W.WTS_buildup || {};
  if (process.env.BUV_STUB_ENGINE === '1') installStubEngine(W);
  const missing = [];
  if (!BU.synth || typeof BU.synth.generate !== 'function') missing.push('WTS_buildup.synth (49-calc-buildup-synth.js, WP4)');
  if (!W.PRiSM_autoInterp || typeof W.PRiSM_autoInterp.interpretJob !== 'function') missing.push('PRiSM_autoInterp.interpretJob (53-prism-autointerp.js, WP1)');
  if (!BU.run || typeof BU.run.analyse !== 'function') missing.push('WTS_buildup.run.analyse (49-calc-buildup-run.js, WP2)');
  return { app, W, SY: BU.synth, RUN: BU.run, AI: W.PRiSM_autoInterp, DATA: BU.data, REVIEW: BU.review, missing, build: app.build };
}
// --stub-engine: no interpretation at all (every case scores as missed); exercises the tool, never the engine
function installStubEngine(W) {
  W.PRiSM_autoInterp = W.PRiSM_autoInterp || {};
  if (typeof W.PRiSM_autoInterp.interpretJob !== 'function') W.PRiSM_autoInterp.interpretJob = function () { return { step() { return { done: true, progress: 1, label: '' }; }, result() { return null; }, cancel() {} }; };
  if (typeof W.PRiSM_autoInterp.confidence !== 'function') W.PRiSM_autoInterp.confidence = function () { return { ks: 'low', model: 'low', headline: 'low' }; };
  W.WTS_buildup.run = W.WTS_buildup.run || {};
  if (typeof W.WTS_buildup.run.analyse !== 'function') W.WTS_buildup.run.analyse = function () { return { ok: true, events: [], tests: [], trend: { alerts: {} } }; };
}
function notRunnable(missing) {
  const msg = [
    '[validate] cannot run the benchmark: ' + missing.length + ' prerequisite' + (missing.length > 1 ? 's are' : ' is') + ' missing from the app build:',
    ...missing.map((m) => '  • ' + m),
    '[validate] The benchmark needs the PRiSM automatic interpretation engine (WP1) and the Build-up pipeline (WP2) merged.',
    '[validate] Writing the placeholder calibration file needs neither: node prism-build/buildup-validate.js --placeholder',
  ];
  console.error(msg.join('\n'));
  return 2;
}

// ═════════════════════════════════════════════════════════════════════════════
// Seeds
// ═════════════════════════════════════════════════════════════════════════════
function parseSeeds(spec) {
  const out = [];
  String(spec).split(',').map((s) => s.trim()).filter(Boolean).forEach((part) => {
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (m) { for (let s = +m[1]; s <= +m[2]; s++) out.push(s); } else if (/^\d+$/.test(part)) out.push(+part);
    else throw new Error('bad --seeds item: ' + part);
  });
  return out;
}
function seedTable(SY) { return SY.SEED_TABLE; }
function quickSeeds(SY) {
  const out = [];
  seedTable(SY).forEach((e) => { [0, 0.25, 0.5, 0.75].forEach((q) => out.push(e.from + Math.floor(q * e.n))); });
  return out;   // 15 strata × 4 = 60
}
function falseRivalSeeds(SY) {   // 20 homogeneous seeds with long tests (≥ 24 h)
  const hom = seedTable(SY).find((e) => e.stratum === 'hom'), out = [];
  for (let s = hom.from; s <= hom.to && out.length < 20; s++) { const cs = SY.caseFromSeed(s); if (cs.test.dtEnd_h >= 24) out.push(s); }
  return out;
}
function strataOf(SY, seed) { const e = seedTable(SY).find((x) => seed >= x.from && seed <= x.to); return e ? e.stratum : null; }

// ═════════════════════════════════════════════════════════════════════════════
// One case / one sequence (inside a worker)
// ═════════════════════════════════════════════════════════════════════════════
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
function testSummary(t) {
  if (!t) return null;
  const r = t.result || null;
  const out = { id: t.id, status: t.status, Dq: num(t.Dq), tc_ms: t.tc_ms, dtEnd_h: num(t.dtEnd_h), result: null };
  if (r) {
    out.result = {
      final: r.final ? { k: num(r.final.k), S: num(r.final.S), C: num(r.final.C), source: r.final.source, gas: r.final.gas ? { Sprime: num(r.final.gas.Sprime) } : null } : null,
      chosen: r.chosen ? { key: r.chosen.key, label: r.chosen.label, fullySeen: r.chosen.fullySeen ? { status: r.chosen.fullySeen.status } : null } : null,
      flags: (r.flags || []).map((f) => ({ code: f.code })), triggers: r.triggers ? { fired: (r.triggers.fired || []).slice() } : null,
      confidence: r.confidence ? { ks: r.confidence.ks, model: r.confidence.model, headline: r.confidence.headline,
                                   reasons: (r.confidence.reasons || []).map((x) => x.rule) } : null,
      iarf: r.iarf ? { grade: r.iarf.grade, cycles: num(r.iarf.cycles), status: r.iarf.status } : null,
      sErr: r.sErr ? { value: num(r.sErr.value), mode: r.sErr.mode, floor: num(r.sErr.floor), seS: num(r.sErr.seS), dLineMatch: num(r.sErr.dLineMatch),
                       sWin: num(r.sErr.sWin), sTc: num(r.sErr.sTc), sPwf: num(r.sErr.sPwf), sK: num(r.sErr.sK) } : null,
      bic: r.bic ? { rows: (r.bic.rows || []).map((x) => ({ key: x.key, bic: num(x.bic), dBicHom: num(x.dBicHom), eligible: !!x.eligible })), chosen: r.bic.chosen } : null,
      models: (r.models || []).map((m) => ({ key: m.key, k: m.phys ? num(m.phys.k) : null, S: m.phys ? num(m.phys.S) : null, eligible: !!m.eligible,
                                             fullySeen: m.fullySeen ? m.fullySeen.status : null })),
      kHeld: !!r.kHeld,
    };
  }
  return out;
}
function truthSummary(tr, cs) {
  const t = cs ? cs.truth : null;
  const Cd = t ? 0.8936 * t.C / (t.phi * t.ct * t.h * t.rw * t.rw) : null;
  const tdc = t ? 0.0002637 * t.k / (t.phi * t.mu * t.ct * t.rw * t.rw) : null;
  return {
    tc_ms: tr.tc_ms, model: tr.model, k: tr.k, S: tr.S, C: t ? t.C : null, kStar: tr.kStar, SStar: tr.SStar, f: tr.f, qCorrect: tr.qCorrect, visible: tr.visible,
    notAnalysable: tr.notAnalysable, partial: tr.partial, distractor: !!tr.distractor, stratum: tr.stratum, grade: tr.grade,
    dtEnd_h: tr.dtEnd_h, dteEnd_h: tr.dteEnd_h, reachFair_h: tr.reach ? tr.reach.fair_h : null, Cd, tDCDend: (Cd && tdc) ? tdc * tr.dteEnd_h / Cd : null,
  };
}
function runCase(env, seed, opts) {
  const { SY, RUN } = env;
  const line = { kind: 'single', seed, stratum: strataOf(SY, seed), lite: !!opts.lite, error: null };
  try {
    const t0 = nowMs();
    const cs = SY.caseFromSeed(seed, opts.lite ? { lite: true } : undefined);
    const sc = SY.generate(cs);
    const t1 = nowMs();
    line.row = cs.row; line.durClass = cs.test.dtEnd_h < 8 ? 'short' : 'long'; line.fluid = cs.fluid; line.rateSource = cs.rateSource;
    line.gen_ms = Math.round(t1 - t0); line.nSamples = sc.record.n;
    line.truth = truthSummary(sc.truth, cs);
    const an = RUN.analyse(SY.toInput(sc), { cache: null });
    const t2 = nowMs();
    line.analyse_ms = Math.round(t2 - t1);
    const m = SY.scoreAnalysis(an, sc);
    line.outcome = m.score;
    line.event = m.event ? { id: m.event.id, kind: m.event.kind, status: m.event.status } : null;
    line.test = testSummary(m.test);
    line.evidence = (m.test && m.test.result && m.test.result.evidence) ? m.test.result.evidence : null;
    line.analysis = { ok: !!(an && an.ok), nTests: an && an.tests ? an.tests.length : 0, nEvents: an && an.events ? an.events.length : 0 };
  } catch (e) {
    line.error = String(e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e);
  }
  return line;
}
function trendSummary(tr) {
  if (!tr) return null;
  const a = tr.alerts || {};
  return {
    delta: a.delta ? { status: a.delta.status, raisedAt: a.delta.raisedAt, confirmedAt: a.delta.confirmedAt } : null,
    absolute: a.absolute ? { status: a.absolute.status, raisedAt: a.absolute.raisedAt, confirmedAt: a.absolute.confirmedAt } : null,
    onset: tr.onset ? { tauDays: num(tr.onset.tauDays), interval: tr.onset.interval || null } : null,
    recent: tr.recent ? { slopePer30d: num(tr.recent.slopePer30d), ci: tr.recent.ci || null } : null,
    rateSkin: tr.rateSkin ? { resolved: !!tr.rateSkin.resolved } : null,
  };
}
function runSequence(env, seed, opts) {
  const { SY, RUN } = env;
  const line = { kind: 'sequence', seed, error: null };
  try {
    const t0 = nowMs();
    const sq = SY.generateSequence(seed, opts.lite ? { lite: true } : undefined);
    const t1 = nowMs();
    line.path = sq.truth.path; line.shutClass = sq.spec.shutClass; line.fluid = sq.spec.fluid; line.gen_ms = Math.round(t1 - t0); line.nSamples = sq.record.n;
    line.truth = { path: sq.truth.path, onsetIdx: sq.truth.onsetIdx, slopePer30d: sq.truth.slopePer30d, constantS: sq.truth.constantS, workover: sq.truth.workover,
                   tests: sq.truth.tests.map((t) => ({ id: t.id, tc_ms: t.tc_ms, S: t.S, SStar: t.SStar, kStar: t.kStar, f: t.f, tDays: t.tDays, dtEnd_h: t.dtEnd_h })) };
    const input = SY.toInput(sq);
    const an = RUN.analyse(input, { cache: null });
    const t2 = nowMs();
    line.analyse_ms = Math.round(t2 - t1);
    // the basevar delta form re-uses the per-test results (cache), so only trend and labels re-run
    const input2 = SY.toInput(sq); input2.settings.trend.basevar = true;
    let an2 = null;
    try { an2 = RUN.analyse(input2, { cache: an }); } catch (e) { an2 = null; }
    line.alerts = { plain: trendSummary(an.trend), basevar: an2 ? trendSummary(an2.trend) : null };
    line.matched = sq.truth.tests.map((tt, i) => {
      const truthT = { tc_ms: tt.tc_ms, model: 'homogeneous', kStar: tt.kStar, SStar: tt.SStar, qCorrect: sq.truth.tests[i].qCorrect, visible: {},
                       notAnalysable: false, partial: false, distractor: false, stratum: sq.spec.fluid === 'gas' ? 'gas' : 'hom' };
      const m = SY.match(an, truthT);
      const s = SY.score(m.test, truthT, { event: m.event });
      return { truthIdx: i, testId: m.test ? m.test.id : null, event: m.event ? { id: m.event.id, kind: m.event.kind, status: m.event.status } : null,
               outcome: s, test: testSummary(m.test), evidence: (m.test && m.test.result && m.test.result.evidence) || null,
               truth: Object.assign({}, truthT, { visible: undefined, f: tt.f, dtEnd_h: tt.dtEnd_h }) };
    });
  } catch (e) {
    line.error = String(e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e);
  }
  return line;
}

// ═════════════════════════════════════════════════════════════════════════════
// Workers
// ═════════════════════════════════════════════════════════════════════════════
function workerMain() {
  let env = null;
  process.on('message', (msg) => {
    if (msg.type === 'init') {
      env = loadEnv();
      process.send({ type: 'ready', missing: env.missing });
      return;
    }
    if (msg.type === 'job') {
      for (const item of msg.items) {
        const line = item.kind === 'sequence' ? runSequence(env, item.seed, msg.opts) : runCase(env, item.seed, msg.opts);
        process.send({ type: 'line', line });
      }
      process.send({ type: 'done' });
      return;
    }
    if (msg.type === 'exit') process.exit(0);
  });
}
function runItems(items, opts, nWorkers, onLine, calSrcFile) {
  return new Promise((resolve, reject) => {
    if (!items.length) { resolve([]); return; }
    const W = Math.max(1, Math.min(nWorkers, items.length)), lines = [];
    let done = 0, failed = false;
    const envW = Object.assign({}, process.env);
    if (calSrcFile) envW.BUV_CAL_SRC = calSrcFile; else delete envW.BUV_CAL_SRC;
    for (let w = 0; w < W; w++) {
      const mine = items.filter((_, i) => i % W === w);
      const child = fork(__filename, ['--worker'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: envW });
      child.on('message', (msg) => {
        if (msg.type === 'ready') {
          if (msg.missing && msg.missing.length) { failed = true; child.send({ type: 'exit' }); reject(Object.assign(new Error('missing'), { missing: msg.missing })); return; }
          child.send({ type: 'job', items: mine, opts });
        } else if (msg.type === 'line') { lines.push(msg.line); if (onLine) onLine(msg.line, lines.length, items.length); }
        else if (msg.type === 'done') { child.send({ type: 'exit' }); if (++done === W && !failed) resolve(lines); }
      });
      child.on('exit', (code) => { if (code && !failed) { failed = true; reject(new Error('worker ' + w + ' exited with code ' + code)); } });
      child.send({ type: 'init' });
    }
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Statistics
// ═════════════════════════════════════════════════════════════════════════════
function wilson(k, n, z) {
  if (!n) return { rate: null, lo: null, hi: null };
  z = z || 1.959964;
  const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return { rate: p, lo: Math.max(0, (c - h) / d), hi: Math.min(1, (c + h) / d) };
}
function quantile(arr, q) {
  const s = arr.filter((v) => typeof v === 'number' && isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
// Cluster bootstrap over wells (groups): B resamples (2,000 for every reported bound and the confirmation of the chosen
// thresholds; BOOT_GRID inside the grid search) with synth.rng(MASTER + 77) → 2.5 % / 97.5 % of the rate. Resample b draws
// group i from position b·G + i of the seeded uniform stream, which is generated once and kept (same numbers as drawing it
// afresh each call, much faster in the grid search).
const BOOT_FULL = 2000, BOOT_GRID = 400;
const _uStreams = new Map();
function _uStream(rngFactory, len) {
  let s = _uStreams.get(rngFactory);
  if (!s || s.u.length < len) {
    const u = new Float64Array(Math.max(len, s ? 2 * s.u.length : 0)), r = rngFactory(MASTER + 77);
    for (let i = 0; i < u.length; i++) u[i] = r.next();
    s = { u }; _uStreams.set(rngFactory, s);
  }
  return s.u;
}
function clusterBootstrap(items, rngFactory, B) {
  const groups = new Map();
  items.forEach((it) => { if (!groups.has(it.g)) groups.set(it.g, { k: 0, n: 0 }); const g = groups.get(it.g); g.n++; g.k += it.y ? 1 : 0; });
  const G = Array.from(groups.values()), nG = G.length;
  if (!nG) return { lo: null, hi: null };
  B = B || BOOT_FULL;
  const u = _uStream(rngFactory, B * nG), K = new Float64Array(nG), N = new Float64Array(nG), rates = new Array(B);
  for (let i = 0; i < nG; i++) { K[i] = G[i].k; N[i] = G[i].n; }
  for (let b = 0, p = 0; b < B; b++) {
    let k = 0, n = 0;
    for (let i = 0; i < nG; i++, p++) { const j = Math.floor(u[p] * nG); k += K[j]; n += N[j]; }
    rates[b] = n ? k / n : 0;
  }
  return { lo: quantile(rates, 0.025), hi: quantile(rates, 0.975) };
}
// cached bootstrap of one label row (the grid search meets the same rows many times): key = B + a 2×32-bit FNV over (case, y)
function bootRow(items, rngFactory, B, cache) {
  if (!cache) return clusterBootstrap(items, rngFactory, B);
  let h1 = 0x811c9dc5 | 0, h2 = 0x050c5d1f | 0;
  for (const x of items) { const v = (x.i << 1) | (x.y ? 1 : 0); h1 = Math.imul(h1 ^ v, 16777619); h2 = Math.imul(h2 ^ (v + 0x9e3779b9), 16777619); }
  const key = B + ':' + items.length + ':' + (h1 >>> 0) + ':' + (h2 >>> 0);
  let r = cache.get(key);
  if (!r) { r = clusterBootstrap(items, rngFactory, B); cache.set(key, r); }
  return r;
}

// ═════════════════════════════════════════════════════════════════════════════
// Labelled set, relabelling under a threshold set, tables
// ═════════════════════════════════════════════════════════════════════════════
function labelledSet(lines) {
  const out = [];
  lines.forEach((l) => {
    if (l.error) return;
    if (l.kind === 'single') {
      out.push({ g: 's' + l.seed, seed: l.seed, stratum: l.stratum, durClass: l.durClass, fluid: l.fluid, truth: l.truth, test: l.test, event: l.event,
                 outcome: l.outcome, evidence: l.evidence, single: true });
    } else if (l.kind === 'sequence') {
      (l.matched || []).forEach((m) => out.push({ g: 'q' + l.seed, seed: l.seed, stratum: l.fluid === 'gas' ? 'gas' : 'hom', durClass: 'long', fluid: l.fluid,
        truth: m.truth, test: m.test, event: null, outcome: m.outcome, evidence: m.evidence, single: false }));
    }
  });
  return out;
}
function round1(v) { return Math.round(v * 10) / 10; }
// Re-derive the evidence and the outcome of one case under thresholds th (approximate where §5.4 needs upstream values:
// S_err with another floor from the stored parts, R3 with another tolerance from the stored ratio, the model choice with
// another τ from the stored ΔBIC rows and the rival fits).
// unlabelled: a truth that is not analysable (partial, baddata) and that the engine left without a label. §5.3 counts only
// abstention on ANALYSABLE truth as "low, y = 0"; these cases stay out of both tables (their status accuracy is reported
// separately). A non-analysable truth the engine interpreted keeps its label, with y = false.
// keepEnvelope: keep the evidence's own KC2 flag (outsideEnvelope, computed by the engine against the envelope of the
// table that was loaded when the case ran). Without it the flag is cleared, i.e. the labels are re-derived without the
// envelope cap (the grid search and the first pass: the envelope is not yet fixed).
function relabel(c, th, env, keepEnvelope) {
  const ev = c.evidence ? Object.assign({}, c.evidence) : null;
  const t = c.test, r = t && t.result;
  let outcome = c.outcome;
  if (!ev || !r) {
    const lab = c.outcome && c.outcome.label, nonAnal = !!(c.truth && (c.truth.notAnalysable || c.truth.partial));
    return { ks: lab ? lab.ks : 'low', headline: lab ? lab.headline : 'low', outcome, sErr: r && r.sErr ? r.sErr.value : null, unlabelled: !lab && nonAnal };
  }
  let sErr = r.sErr ? r.sErr.value : ev.sErr;
  if (r.sErr) {
    const s = r.sErr, parts = s.mode === 'kHeld' ? [s.seS, s.sTc, s.sPwf, s.sK] : (s.mode === 'model' ? [s.seS, s.sTc, s.sPwf] : [s.seS, s.dLineMatch, s.sWin, s.sTc, s.sPwf]);
    sErr = Math.max(th.sErrFloor, ...parts.filter((v) => typeof v === 'number' && isFinite(v)));
    ev.sErr = sErr;
  }
  if (typeof ev.r3 === 'number' && (ev.r3Status === 'pass' || ev.r3Status === 'fail')) ev.r3Status = Math.abs(ev.r3 - 1) * 100 <= th.rateTolPct ? 'pass' : 'fail';
  if (r.bic && r.bic.rows && r.bic.rows.length && th.tauBic !== PRE_THRESHOLDS.tauBic) {
    const elig = r.bic.rows.filter((x) => x.key !== 'homogeneous' && x.eligible && typeof x.dBicHom === 'number' && round1(x.dBicHom) <= -th.tauBic)
      .sort((a, b) => a.bic - b.bic);
    const key = elig.length ? elig[0].key : 'homogeneous';
    if (key !== (r.chosen && r.chosen.key)) {
      const m = (r.models || []).find((x) => x.key === key);
      // the engine's display labels (§3.1 chosen.label) for its four model keys
      const label = key === 'homogeneous' ? 'Homogeneous' : key === 'composite2' ? 'Radial composite' : /fault|bound/i.test(key) ? 'Sealing fault' : 'Closed circle';
      const t2 = JSON.parse(JSON.stringify(t));
      t2.result.chosen = { key, label, fullySeen: { status: m && m.fullySeen ? m.fullySeen : 'n/a' } };
      if (m && t2.result.final) { t2.result.final.k = m.k; t2.result.final.S = m.S; if (t2.result.final.gas) t2.result.final.gas.Sprime = m.S; }
      outcome = env.SY.score(t2, c.truth, { event: c.event });
      ev.chosenKey = key; ev.chosenFullySeen = t2.result.chosen.fullySeen.status;
    }
  }
  if (!keepEnvelope) ev.outsideEnvelope = false;
  let conf = null;
  try { conf = env.AI.confidence(ev, { version: 'grid', calibrated: true, thresholds: th, envelope: null, ksTable: [], table: [], inApp: [] }); } catch (e) { conf = null; }
  if (!conf || LABELS.indexOf(conf.ks) === -1) return { ks: 'low', headline: 'low', outcome, sErr, error: true };
  return { ks: conf.ks, headline: conf.headline, outcome, sErr };
}
// Items carry i (case index), g (well), single (a single case, not a sequence test) and y.
function tables(cases, labels) {
  const ks = {}, hd = {};
  LABELS.forEach((L) => { ks[L] = []; hd[L] = []; });
  cases.forEach((c, i) => {
    const lb = labels[i], o = lb.outcome || {};
    if (lb.unlabelled) return;
    const abst = !!o.abstained, nonAnal = !!(c.truth && (c.truth.notAnalysable || c.truth.partial)), wrong = abst || nonAnal;
    const ksL = abst ? 'low' : lb.ks, hdL = abst ? 'low' : lb.headline;
    const dS = typeof o.dS === 'number' ? Math.abs(o.dS) : null, cov = (dS !== null && typeof lb.sErr === 'number') ? dS <= 2 * lb.sErr : null;
    const single = c.single !== false;
    ks[ksL].push({ i, y: wrong ? false : !!o.ksRight, g: c.g, single, dS, cov });
    hd[hdL].push({ i, y: wrong ? false : !!o.fullyRight, g: c.g, single, dS, cov, k: !!o.kRight, s: !!o.sRight, m: !!o.modelRight, strict: wrong ? false : !!o.strict });
  });
  return { ks, hd };
}
function rowStats(items, yKey) {
  const n = items.length, k = items.filter((x) => x[yKey || 'y']).length, w = wilson(k, n);
  const ds = items.map((x) => x.dS).filter((v) => v !== null), cv = items.map((x) => x.cov).filter((v) => v !== null);
  return { n, rate: w.rate, lo: w.lo, hi: w.hi, medAbsDS: quantile(ds, 0.5), cover2: cv.length ? cv.filter(Boolean).length / cv.length : null };
}
// §5.4 step 3 constraints for both tables: rate(high) ≥ 0.95 and rate(medium) ≥ 0.80 on the pooled table; their lower bounds
// (≥ 0.90 / ≥ 0.70) twice: Wilson on the single-case subset and a cluster bootstrap over wells on the pooled table (tests of
// one sequence well are correlated, so a pooled Wilson bound would be anti-conservative); rate(low) ≤ rate(medium) − 0.20;
// S_err coverage ≥ 0.90 for high and medium. opts {B (resamples, default 2,000), cache (Map), rng (synth.rng)}.
function checkTargets(T, opts) {
  opts = opts || {};
  const B = opts.B || BOOT_FULL, rng = opts.rng || _defaultRng();
  const fails = [];
  [['k/S', T.ks], ['headline', T.hd]].forEach(([name, tb]) => {
    const h = rowStats(tb.high), m = rowStats(tb.medium), l = rowStats(tb.low);
    [[h, 'high', TARGETS.highRate, TARGETS.highLo], [m, 'medium', TARGETS.medRate, TARGETS.medLo]].forEach(([s, L, rate, lo]) => {
      if (!s.n) return;
      if (s.rate < rate) { fails.push(name + ' ' + L); return; }
      const sg = rowStats(tb[L].filter((x) => x.single !== false));
      if (sg.n && sg.lo < lo) { fails.push(name + ' ' + L + ' (Wilson bound, single cases)'); return; }
      const cb = bootRow(tb[L], rng, B, opts.cache || null);
      if (cb.lo !== null && cb.lo < lo) fails.push(name + ' ' + L + ' (cluster-bootstrap bound)');
    });
    if (l.n && m.n && l.rate > m.rate - TARGETS.lowGap) fails.push(name + ' low gap');
    [h, m].forEach((x, i) => { if (x.n && x.cover2 !== null && x.cover2 < TARGETS.cover) fails.push(name + ' cover ' + LABELS[i]); });
  });
  return fails;
}
// the generator's PRNG for the bootstrap when no environment is passed (stand-alone use of the helpers)
let _rngCache = null;
function _defaultRng() {
  if (_rngCache) return _rngCache;
  const vm = require('vm'), c = { console: { log() {}, warn() {} } }; c.window = c; vm.createContext(c);
  vm.runInContext(fs.readFileSync(path.join(ROOT, '49-calc-buildup-synth.js'), 'utf8').split('// === SELF-TEST ===')[0], c);
  _rngCache = c.WTS_buildup.synth.rng;
  return _rngCache;
}
function falseRivalRate(cases, labels) {
  let n = 0, k = 0;
  cases.forEach((c, i) => {
    if (!(c.truth && c.truth.model === 'homogeneous') || !c.test || !c.test.result || !c.test.result.chosen) return;
    if (c.stratum !== 'hom') return;
    n++;
    const o = labels ? labels[i].outcome : c.outcome;
    if (o && !o.modelRight) k++;
  });
  return { n, rate: n ? k / n : null };
}
function abstention(cases) {
  const all = cases.filter((c) => c.truth && !c.truth.notAnalysable && !c.truth.partial), hom = all.filter((c) => c.stratum === 'hom');
  const a = (arr) => arr.filter((c) => c.outcome && c.outcome.abstained).length;
  return { n: a(all), rate: all.length ? a(all) / all.length : null, rateHom: hom.length ? a(hom) / hom.length : null };
}

// ═════════════════════════════════════════════════════════════════════════════
// Sequence metrics (§5.2 targets)
// ═════════════════════════════════════════════════════════════════════════════
function sequenceMetrics(lines, form) {
  const seqs = lines.filter((l) => l.kind === 'sequence' && !l.error);
  const raised = (a) => a && (a.status === 'provisional' || a.status === 'confirmed');
  const pick = (l) => (l.alerts && (form === 'basevar' ? l.alerts.basevar : l.alerts.plain)) || null;
  const constant = seqs.filter((l) => l.truth.constantS);
  const fa = constant.filter((l) => { const a = pick(l); return a && raised(a.delta); }).length;
  const faAbs = constant.filter((l) => { const a = pick(l); return a && raised(a.absolute); }).length;
  const delays = [], delaysShort = []; let onsetN = 0, onsetOk = 0, senN = 0, senOk = 0;
  seqs.filter((l) => !l.truth.constantS).forEach((l) => {
    const a = pick(l); if (!a || !a.delta) return;
    const T = l.truth.tests, base = (T[0].S + T[1].S + T[2].S) / 3;
    const jStar = T.findIndex((t) => t.S - base > 2.5);
    if (jStar >= 0 && a.delta.confirmedAt) {
      const m = (l.matched || []).find((x) => x.testId === a.delta.confirmedAt);
      if (m) { delays.push(m.truthIdx - jStar); if (l.shutClass === '24-48') delaysShort.push(m.truthIdx - jStar); }
    }
    if (l.truth.onsetIdx != null && a.onset && typeof a.onset.tauDays === 'number') {
      const k = l.truth.onsetIdx, tau = 0.5 * (T[k - 1].tDays + T[k].tDays), spacing = quantile(T.slice(1).map((t, i) => t.tDays - T[i].tDays), 0.5);
      onsetN++; if (Math.abs(a.onset.tauDays - tau) <= spacing) onsetOk++;
    }
    if (l.truth.path === 'linear' && a.recent && Array.isArray(a.recent.ci)) {
      senN++; if (l.truth.slopePer30d >= a.recent.ci[0] && l.truth.slopePer30d <= a.recent.ci[1]) senOk++;
    }
  });
  // the stimulation drop on wells without an entered workover date: the post-workover test is classified as a shut-in
  // (event kind shutin, analysable or excluded), not a partial cut or an unconfirmed event (§5.2 target ≥ 95 %)
  let stimN = 0, stimOk = 0;
  seqs.filter((l) => l.truth.path === 'stimulation' && l.truth.workover && !l.truth.workover.entered).forEach((l) => {
    const m = (l.matched || [])[l.truth.workover.afterTest + 1];
    if (!m) return;
    stimN++;
    if (m.event && m.event.kind === 'shutin' && (m.event.status === 'analysable' || m.event.status === 'excluded')) stimOk++;
  });
  // constant-S gas wells (rate changes only) where D is resolved: no delta alert (§5.2 target: none)
  const gasRes = seqs.filter((l) => { const a = pick(l); return l.truth.path === 'gasRate' && a && a.rateSkin && a.rateSkin.resolved; });
  const gasQuiet = gasRes.filter((l) => !raised(pick(l).delta)).length;
  return {
    n: seqs.length, falseAlarmDelta: constant.length ? fa / constant.length : null, falseAlarmAbs: constant.length ? faAbs / constant.length : null,
    delayMedian: quantile(delays, 0.5), delayMedianShort: quantile(delaysShort, 0.5), onsetWithin1: onsetN ? onsetOk / onsetN : null, senCover: senN ? senOk / senN : null,
    stimShutinRate: stimN ? stimOk / stimN : null, stimN, gasNoAlertWhenDResolved: gasRes.length ? gasQuiet / gasRes.length : null, gasResolvedN: gasRes.length,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Calibration (§5.4)
// ═════════════════════════════════════════════════════════════════════════════
function combos(grid) {
  const keys = Object.keys(grid);
  let list = [{}];
  keys.forEach((k) => { const nx = []; list.forEach((c) => grid[k].forEach((v) => nx.push(Object.assign({}, c, { [k]: v })))); list = nx; });
  return list;
}
function foldsOf(cases, K) {   // groups (wells) to folds, stratified by stratum and duration class, deterministic
  const byGroup = new Map();
  cases.forEach((c) => { if (!byGroup.has(c.g)) byGroup.set(c.g, c.stratum + '|' + c.durClass); });
  const strata = new Map();
  Array.from(byGroup.keys()).sort().forEach((g) => { const s = byGroup.get(g); if (!strata.has(s)) strata.set(s, []); strata.get(s).push(g); });
  const fold = new Map(); let off = 0;
  Array.from(strata.keys()).sort().forEach((s) => { strata.get(s).forEach((g, i) => fold.set(g, (i + off) % K)); off += strata.get(s).length; });
  return cases.map((c) => fold.get(c.g));
}
// share labelled high (headline) among the labelled cases, −Infinity when a constraint fails. With `floor`, a candidate whose
// share cannot beat it is not checked (it could not replace the incumbent anyway). opts as checkTargets.
function objective(cases, labels, opts, floor) {
  const T = tables(cases, labels);
  const nLab = LABELS.reduce((a, L) => a + T.hd[L].length, 0), share = T.hd.high.length / Math.max(1, nLab);
  if (floor !== undefined && !(share > floor)) return -Infinity;
  const fr = falseRivalRate(cases, labels);
  if (fr.rate !== null && fr.rate > TARGETS.falseRival) return -Infinity;
  if (checkTargets(T, opts).length) return -Infinity;
  return share;
}
// Staged exhaustive grid (stage 1 LOW thresholds, stage 2 HIGH thresholds and τ, stage 1 again). The pre-calibration set is
// the incumbent: a candidate replaces it only when strictly better, so ties keep the documented defaults. Inside the grid the
// cluster bootstrap uses BOOT_GRID resamples (cached per label row); the winner is confirmed with the full 2,000, and when it
// fails there the whole search is repeated at 2,000.
// An infeasible incumbent can never be replaced by a candidate that differs from it in one stage only, so while no feasible
// point has been found the search adds two passes: stage 2 from the strict stage-1 set (STRICT_STAGE1), then stage 1 from
// the strict stage-2 set (STRICT_STAGE2). Every candidate evaluated while the incumbent is infeasible is checked against all
// constraints, so `feasible` counts the feasible points among the `evaluated` ones exactly (once a feasible incumbent exists,
// a candidate whose share cannot beat it is not checked).
// When nothing is feasible the stricter set is shipped (§5.4: the targets are never relaxed): every LOW and HIGH label
// threshold of the grid at its strictest value, the rate tolerance included (10 %). The S_err floor (0.2) and τ (10) keep
// their pre-calibration values: the floor changes S_err itself (0.4 removes every high label, so the high constraints become
// vacuous while the medium bound still fails) and τ also sets the model choice, not only a label boundary.
const STRICT_STAGE1 = { sErrLow: 0.8, snrLow: 8, disagreeDS: 0.7, disagreeKPct: 10, reachFactor: 5.0, distractorRule: true, kHeldRmsK: 2 };
const STRICT_STAGE2 = { snrHigh: 30, sErrHigh: 0.3, fairSpanHigh: 1.0, pointSkinSpread: 0.2, rateTolPct: 10 };
function strictSet() { return Object.assign({}, PRE_THRESHOLDS, STRICT_STAGE1, STRICT_STAGE2); }
function searchThresholds(cases, env, sample, opts) {
  opts = opts || {};
  const cache = new Map(), rng = env.SY.rng;
  let evaluated = 0, feasible = 0;
  const run = (B) => {
    const evalSet = (cand, floor) => {
      const v = objective(cases, cases.map((c) => relabel(c, cand, env)), { B, cache, rng }, floor);
      evaluated++; if (v > -Infinity) feasible++;
      return v;
    };
    let th = Object.assign({}, PRE_THRESHOLDS), best = evalSet(th);
    const stage = (grid) => {
      combos(grid).forEach((cmb, i) => {
        if (sample > 1 && i % sample) return;
        const cand = Object.assign({}, th, cmb), v = evalSet(cand, best);
        if (v > best) { best = v; th = cand; }
      });
    };
    stage(GRID_STAGE1); stage(GRID_STAGE2); stage(GRID_STAGE1);
    if (best === -Infinity) {
      th = Object.assign({}, PRE_THRESHOLDS, STRICT_STAGE1); stage(GRID_STAGE2);
      if (best === -Infinity) { th = Object.assign({}, PRE_THRESHOLDS, STRICT_STAGE2); stage(GRID_STAGE1); }
      else stage(GRID_STAGE1);
      if (best === -Infinity) th = Object.assign({}, PRE_THRESHOLDS);
    }
    return { th, best, evalSet };
  };
  const Bg = opts.bootGrid || BOOT_GRID;
  let res = run(Bg), confirmed = Bg >= BOOT_FULL;
  if (res.best > -Infinity && !confirmed) {
    const T = tables(cases, cases.map((c) => relabel(c, res.th, env)));
    confirmed = checkTargets(T, { B: BOOT_FULL, cache, rng }).length === 0;
    if (!confirmed) res = run(BOOT_FULL);
  }
  let th = res.th;
  if (res.best === -Infinity) th = strictSet();   // constraints unmet everywhere: the stricter set (never relaxed targets)
  return { th, best: res.best, evaluated, feasible };
}
// The threshold searches of one calibration (one per training fold and the final one on every fold), run in parallel in
// child processes (each loads the app once; the staged grid is single-threaded). jobs: [{idx: case indices}] → results in
// job order, each {th, best, evaluated, feasible}.
function searchMany(cases, jobs, opts, nWorkers) {
  return new Promise((resolve, reject) => {
    const out = new Array(jobs.length);
    let next = 0, done = 0, failed = false;
    const W = Math.max(1, Math.min(nWorkers || 1, jobs.length));
    const start = () => {
      if (next >= jobs.length || failed) return;
      const j = next++;
      const child = fork(__filename, ['--search-worker'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: Object.assign({}, process.env) });
      child.on('message', (msg) => {
        if (msg.type === 'ready') {
          if (msg.missing && msg.missing.length) { failed = true; child.send({ type: 'exit' }); reject(Object.assign(new Error('missing'), { missing: msg.missing })); return; }
          child.send({ type: 'search', cases: jobs[j].idx.map((i) => cases[i]), sample: opts.gridSample, bootGrid: opts.bootGrid || null });
        } else if (msg.type === 'searched') {
          out[j] = msg.result; child.send({ type: 'exit' });
          if (opts.onDone) opts.onDone(j, msg.result);
          if (++done === jobs.length) resolve(out); else start();
        }
      });
      child.on('exit', (code) => { if (code && !failed) { failed = true; reject(new Error('search worker ' + j + ' exited with code ' + code)); } });
      child.send({ type: 'init' });
    };
    for (let w = 0; w < W; w++) start();
  });
}
function searchWorkerMain() {
  let env = null;
  process.on('message', (msg) => {
    if (msg.type === 'init') { env = loadEnv(); process.send({ type: 'ready', missing: env.missing }); return; }
    if (msg.type === 'search') {
      const r = searchThresholds(msg.cases, env, msg.sample, { bootGrid: msg.bootGrid || undefined });
      process.send({ type: 'searched', result: { th: r.th, best: r.best === -Infinity ? null : r.best, evaluated: r.evaluated, feasible: r.feasible } });
      return;
    }
    if (msg.type === 'exit') process.exit(0);
  });
}
// One out-of-fold pass: each held-out fold is labelled with its training fold's thresholds (foldTh[f]); the forecast of a
// held-out case is the TRAINING-fold rate of its headline label (so the reliability term of the Murphy decomposition
// measures something: the out-of-fold rates are not their own forecasts). keepEnvelope: see relabel.
function oofPass(cases, fold, foldTh, env, keepEnvelope) {
  const oof = new Array(cases.length), fcst = new Array(cases.length).fill(null);
  foldTh.forEach((th, f) => {
    const train = cases.filter((_, i) => fold[i] !== f);
    const Ttr = tables(train, train.map((c) => relabel(c, th, env, keepEnvelope))), rateTr = {};
    LABELS.forEach((L) => { rateTr[L] = rowStats(Ttr.hd[L]).rate; });
    cases.forEach((c, i) => {
      if (fold[i] !== f) return;
      oof[i] = relabel(c, th, env, keepEnvelope);
      const o = oof[i].outcome || {}, L = o.abstained ? 'low' : oof[i].headline;
      if (!oof[i].unlabelled) fcst[i] = { p: rateTr[L] === null ? 0 : rateTr[L], bin: f + ':' + L };
    });
  });
  return { oof, fcst, T: tables(cases, oof) };
}
// The tables and scores of one pass (file 55 fields). single: the single-case rows of the same label (Wilson interval; the
// harder population, with the distractor strata and the crossed factors, that the single-case Wilson bound of the §5.4
// constraints is taken on).
function passTables(cases, P, env) {
  const { oof, fcst, T } = P, rng = env.SY.rng;
  const sgl = (items, yKey) => { const sg = items.filter((x) => x.single !== false), w = wilson(sg.filter((x) => x[yKey || 'y']).length, sg.length); return { n: sg.length, rate: w.rate, lo: w.lo, hi: w.hi }; };
  const ksRow = (L, items) => { const s = rowStats(items); const cb = clusterBootstrap(items, rng); return { label: L, n: s.n, right: s.rate, lo: s.lo, hi: s.hi, loCluster: cb.lo, hiCluster: cb.hi, medAbsDS: s.medAbsDS, cover2: s.cover2, single: sgl(items) }; };
  const tbRow = (L, items, yKey) => {
    const s = rowStats(items, yKey); const cb = clusterBootstrap(items.map((x) => ({ g: x.g, y: x[yKey || 'y'] })), rng);
    const fr = (k) => (items.length ? items.filter((x) => x[k]).length / items.length : null);
    return { label: L, n: s.n, fullyRight: s.rate, lo: s.lo, hi: s.hi, loCluster: cb.lo, hiCluster: cb.hi, kRight: fr('k'), sRight: fr('s'), modelRight: fr('m'), medAbsDS: s.medAbsDS, cover2: s.cover2, single: sgl(items, yKey) };
  };
  const sub = (pred) => { const idx = cases.map((c, i) => (pred(c, i) ? i : -1)).filter((i) => i >= 0); return tables(idx.map((i) => cases[i]), idx.map((i) => oof[i])); };
  const Tk = sub((c) => c.test && c.test.result && c.test.result.kHeld), Tg = sub((c) => c.fluid === 'gas');
  // Brier score of the headline label: forecast = the training-fold rate of the case's label (fcst), outcome y = fully right
  // (abstention on analysable truth: y = 0). Murphy decomposition over the forecast bins (fold × label; one forecast value each),
  // so BS = REL − RES + UNC exactly.
  const yOf = new Map(); LABELS.forEach((L) => T.hd[L].forEach((x) => yOf.set(x.i, x.y ? 1 : 0)));
  let bs = 0, N = 0, ysum = 0; const bins = {};
  cases.forEach((c, i) => {
    if (!fcst[i] || !yOf.has(i)) return;
    const p = fcst[i].p, y = yOf.get(i), b = bins[fcst[i].bin] = bins[fcst[i].bin] || { n: 0, y: 0, p };
    bs += (p - y) * (p - y); N++; ysum += y; b.n++; b.y += y;
  });
  const ybar = N ? ysum / N : 0;
  let rel = 0, res = 0;
  Object.keys(bins).forEach((k) => { const b = bins[k], yk = b.y / b.n; rel += b.n * (b.p - yk) * (b.p - yk); res += b.n * (yk - ybar) * (yk - ybar); });
  const unc = ybar * (1 - ybar), brier = N ? bs / N : null;
  const fr = falseRivalRate(cases, oof);
  return {
    nBuildups: LABELS.reduce((a, L) => a + T.hd[L].length, 0),
    ksTable: LABELS.map((L) => ksRow(L, T.ks[L])), table: LABELS.map((L) => tbRow(L, T.hd[L])), strict: LABELS.map((L) => tbRow(L, T.hd[L], 'strict')),
    kHeldTable: ['medium', 'low'].map((L) => ksRow(L, Tk.ks[L])), gasTable: LABELS.map((L) => tbRow(L, Tg.hd[L])),
    brier, bss: (brier !== null && unc > 0) ? 1 - brier / unc : null, reliability: N ? rel / N : null, resolution: N ? res / N : null, uncertainty: unc, falseRival: fr.rate,
  };
}
// Share labelled high (pooled and single cases) of one pass, for the report.
function shares(T) {
  const out = {};
  [['ks', T.ks], ['headline', T.hd]].forEach(([k, tb]) => {
    const all = LABELS.reduce((a, L) => a + tb[L].length, 0), sAll = LABELS.reduce((a, L) => a + tb[L].filter((x) => x.single !== false).length, 0);
    const h = tb.high.length, hs = tb.high.filter((x) => x.single !== false).length;
    out[k] = { high: h, n: all, share: all ? h / all : null, highSingle: hs, nSingle: sAll, shareSingle: sAll ? hs / sAll : null };
  });
  return out;
}
// Calibration (§5.4), first pass: the threshold searches (5 training folds + all folds), the out-of-fold labels WITHOUT the
// KC2 envelope cap (the envelope is fixed by this pass), the envelope and the candidate table. The second pass
// (finishCalibration) relabels the same folds with the evidence of a re-run that had the candidate table loaded, so the
// shipped tables carry the KC2 cap exactly as the app applies it.
//   calibrate(lines, env, opts)            synchronous, the searches in this process (env may be a stub labeller)
//   calibrateParallel(lines, env, opts)    the --write path: the six searches in parallel worker processes (opts.workers)
function calibrationJobs(cases, fold, K) {
  const jobs = [];
  for (let f = 0; f < K; f++) jobs.push({ idx: cases.map((_, i) => i).filter((i) => fold[i] !== f) });
  jobs.push({ idx: cases.map((_, i) => i) });
  return jobs;
}
function calibrate(lines, env, opts) {
  const cases = labelledSet(lines), K = 5, fold = foldsOf(cases, K);
  const search = calibrationJobs(cases, fold, K).map((j) => {
    const r = searchThresholds(j.idx.map((i) => cases[i]), env, opts.gridSample, opts);
    return { th: r.th, best: r.best === -Infinity ? null : r.best, evaluated: r.evaluated, feasible: r.feasible };
  });
  return calibrateWith(lines, env, opts, cases, fold, search);
}
async function calibrateParallel(lines, env, opts) {
  const cases = labelledSet(lines), K = 5, fold = foldsOf(cases, K);
  console.log('[validate] calibration: ' + cases.length + ' labelled build-ups, ' + new Set(cases.map((c) => c.g)).size + ' wells, 5 folds');
  const search = await searchMany(cases, calibrationJobs(cases, fold, K), Object.assign({}, opts, {
    onDone: (j, r) => console.log('[validate]   search ' + (j < K ? 'fold ' + (j + 1) : 'all folds') + ' done: ' + r.evaluated + ' candidates, ' + r.feasible + ' feasible'),
  }), opts.workers || 1);
  return calibrateWith(lines, env, opts, cases, fold, search);
}
function calibrateWith(lines, env, opts, cases, fold, search) {
  const K = search.length - 1;
  const foldTh = search.slice(0, K).map((r) => r.th), final = Object.assign({}, search[K].th);
  // delta-alert form from the sequence false-alarm rate (plain unless it misses 5 %)
  const seqPlain = sequenceMetrics(lines, 'plain'), seqBase = sequenceMetrics(lines, 'basevar');
  final.deltaForm = (seqPlain.falseAlarmDelta !== null && seqPlain.falseAlarmDelta > TARGETS.falseAlarm && seqBase.falseAlarmDelta !== null &&
                     seqBase.falseAlarmDelta <= TARGETS.falseAlarm) ? 'basevar' : 'plain';
  const seqM = final.deltaForm === 'basevar' ? seqBase : seqPlain;
  const P1 = oofPass(cases, fold, foldTh, env, false), T1 = passTables(cases, P1, env);
  const env5 = (vals) => [quantile(vals, 0.05), quantile(vals, 0.95)];
  const ev = cases.map((c) => c.evidence).filter(Boolean);
  const rateErr = cases.map((c) => (c.outcome && typeof c.outcome.rateErrPct === 'number' ? Math.abs(c.outcome.rateErrPct) : null)).filter((v) => v !== null);
  const dist = cases.filter((c) => c.truth && c.truth.distractor && c.truth.visible && c.truth.visible.distractor);
  const cal = Object.assign({
    version: 'cal-1', calibrated: true, generated: todayUTC(), app: 'v3.3', engine: (env.AI && env.AI.version) || '1.0',
    seeds: { single: SINGLE.slice(), sequences: SEQ.slice(), master: MASTER },
    nCases: lines.filter((l) => l.kind === 'single' && !l.error).length,
    thresholds: final,
  }, T1, {
    abstain: abstention(cases), distractorCaught: { n: dist.length, rate: dist.length ? dist.filter((c) => c.outcome && c.outcome.distractorCaught).length / dist.length : null },
    rateAccuracy: { medAbsPct: quantile(rateErr, 0.5), p90AbsPct: quantile(rateErr, 0.9) },
    envelope: {
      CD: env5(cases.map((c) => c.truth && c.truth.Cd)), S: env5(cases.map((c) => c.truth && c.truth.SStar)), tDCDend: env5(cases.map((c) => c.truth && c.truth.tDCDend)),
      snrD: env5(ev.map((e) => e.snrD)), k: env5(cases.map((c) => c.truth && c.truth.kStar)), dtEnd_h: env5(cases.map((c) => c.truth && c.truth.dtEnd_h)),
    },
    sequences: { falseAlarmDelta: seqM.falseAlarmDelta, falseAlarmAbs: seqM.falseAlarmAbs, delayMedian: seqM.delayMedian, delayMedianShort: seqM.delayMedianShort,
                 onsetWithin1: seqM.onsetWithin1, senCover: seqM.senCover },
    envelopeCapped: false,
    inApp: [],
  });
  return { cal, cases, fold, foldTh, search, oof: P1.oof, T: P1.T, T1, seqPlain, seqBase };
}
// Second pass: rerunLines are the same items run with the candidate table loaded (BUV_CAL_SRC), so each evidence carries the
// engine's KC2 flag against the candidate's envelope (and the pass-2 evidence of the sequences under its labels). The
// out-of-fold labels are re-derived with the first pass's fold thresholds, keeping that flag: the tables, the Brier score
// and the shares then describe the labels the app shows. The first-pass (uncapped) tables are kept in cal.uncapped.
function finishCalibration(res, rerunLines, env) {
  const cases2 = labelledSet(rerunLines), K = res.foldTh.length;
  if (cases2.length !== res.cases.length || cases2.some((c, i) => c.g !== res.cases[i].g)) throw new Error('second pass: the re-run does not give the same labelled build-ups (' + cases2.length + ' vs ' + res.cases.length + ')');
  const fold2 = foldsOf(cases2, K);
  const P2 = oofPass(cases2, fold2, res.foldTh, env, true), T2 = passTables(cases2, P2, env);
  const cal = res.cal;
  cal.uncapped = { ksTable: cal.ksTable, table: cal.table, shares: shares(res.T) };
  Object.assign(cal, T2);
  cal.envelopeCapped = true;
  cal.capped = { outsideEnvelope: cases2.filter((c) => c.evidence && c.evidence.outsideEnvelope).length, shares: shares(P2.T) };
  res.T2 = P2.T; res.oof2 = P2.oof;
  return res;
}
// Normalised distance of a case's evidence to the nearest label threshold (§5.6 margin). The engine's own
// PRiSM_autoInterp.thresholdMargin is used when an environment is given (one implementation for the tool, the page's
// 24-case check and the benchmark test); the copy below is the stand-alone fallback and must stay identical.
let _marginAI = null;
function marginOf(ev, th) {
  if (_marginAI && typeof _marginAI.thresholdMargin === 'function') return _marginAI.thresholdMargin(ev, th);
  if (!ev) return 0;
  const d = [];
  const add = (v, t) => { if (typeof v === 'number' && isFinite(v) && t) d.push(Math.abs(v - t) / Math.abs(t)); };
  add(ev.snrD, th.snrHigh); add(ev.snrD, th.snrLow); add(ev.sErr, th.sErrHigh); add(ev.sErr, th.sErrLow);
  if (ev.grade === 'fair') add(ev.span, th.fairSpanHigh);
  add(ev.pointSkinSpread, th.pointSkinSpread);
  if (ev.agree === false) { add(Math.abs(ev.dS), th.disagreeDS); add(Math.abs(ev.dkPct), th.disagreeKPct); }
  if (typeof ev.dteEnd_h === 'number' && typeof ev.t10_h === 'number' && ev.t10_h > 0) add(ev.dteEnd_h / ev.t10_h, th.reachFactor);
  if (ev.kHeld) add(ev.kHeldRmsRatio, th.kHeldRmsK);
  if (typeof ev.r3 === 'number') add(Math.abs(ev.r3 - 1) * 100, th.rateTolPct);
  if (typeof ev.dBicChosen === 'number' && ev.chosenKey && ev.chosenKey !== 'homogeneous') add(Math.abs(ev.dBicChosen), th.tauBic);
  return d.length ? Math.min.apply(null, d) : 1;
}
// actual: the lite lines were run with the calibrated table loaded (BUV_CAL_SRC), so their labels are the app's own (with
// pass 2 and the envelope cap); without it the labels are re-derived from the evidence (relabel).
function liteItem(l, th, env, actual) {
  const c = labelledSet([l])[0]; if (!c) return null;
  const margin = marginOf(l.evidence, th), o = l.outcome || {};
  let expect;
  if (actual) expect = { status: o.status || null, ks: o.label ? o.label.ks : null, headline: o.label ? o.label.headline : null, fullyRight: !!o.fullyRight };
  else { const lb = relabel(c, th, env); expect = { status: o.status || null, ks: lb.ks, headline: lb.headline, fullyRight: lb.outcome ? !!lb.outcome.fullyRight : null }; }
  return { seed: l.seed, stratum: l.stratum, margin, expect, durClass: l.durClass, visible: l.truth ? l.truth.visible : null, hasEvidence: !!l.evidence };
}
function chooseInApp(liteLines, th, env, actual) {
  if (env && env.AI) _marginAI = env.AI;
  const byStratum = new Map();
  liteLines.filter((l) => !l.error && l.kind === 'single').forEach((l) => {
    const item = liteItem(l, th, env, actual); if (!item) return;
    if (!byStratum.has(l.stratum)) byStratum.set(l.stratum, []);
    byStratum.get(l.stratum).push(item);
  });
  const want = {}; IN_APP_PROVISIONAL.forEach(([, s]) => { want[s] = (want[s] || 0) + 1; });
  const out = [];
  Object.keys(want).forEach((s) => {
    const list = (byStratum.get(s) || []).filter((x) => x.margin >= 0.1).sort((a, b) => b.margin - a.margin || a.seed - b.seed);
    list.slice(0, want[s]).forEach((x) => out.push(x));
  });
  // fill from any stratum when one ran short
  if (out.length < 24) {
    const rest = [].concat(...Array.from(byStratum.values())).filter((x) => x.margin >= 0.1 && !out.some((o) => o.seed === x.seed)).sort((a, b) => b.margin - a.margin || a.seed - b.seed);
    rest.slice(0, 24 - out.length).forEach((x) => out.push(x));
  }
  return out.sort((a, b) => a.seed - b.seed).slice(0, 24).map((x) => ({ seed: x.seed, stratum: x.stratum, expect: x.expect, margin: Math.round(x.margin * 1000) / 1000 }));
}
// The 10 acceptance seeds of §5.6 (buildup-benchmark.test.js BM1): hom short, hom long, fault seen, comp, closed, gas, inj,
// dualpor, partial, baddata, from the lite lines run with the calibrated table. Each interpreted case has margin ≥ 0.1;
// the two hom slots take the highest headline label available (so the snapshot covers more than "low"), the others the
// largest margin; partial and baddata are judged on their status alone (no label, no threshold: margin null).
const BENCH_SLOTS = [
  ['hom short', (x) => x.stratum === 'hom' && x.durClass === 'short'], ['hom long', (x) => x.stratum === 'hom' && x.durClass !== 'short'],
  ['fault seen', (x) => x.stratum === 'fault' && x.visible && x.visible.fault], ['comp', (x) => x.stratum === 'comp'], ['closed', (x) => x.stratum === 'closed'],
  ['gas', (x) => x.stratum === 'gas'], ['inj', (x) => x.stratum === 'inj'], ['dualpor', (x) => x.stratum === 'dualpor'],
  ['partial', (x) => x.stratum === 'partial' && x.expect.status === 'partial'], ['baddata', (x) => x.stratum === 'baddata' && (x.expect.status === 'missed' || x.expect.status === 'not_analysable')],
];
const RANK_L = { low: 1, medium: 2, high: 3 };
const BENCH_HIGH = 8;
// The sequence well BM2 re-runs (lite; see the --write flow): {seed, nSamples, tests: [{truthIdx, expect, margin}]}.
function chooseBenchSequence(seqLines, th, env) {
  if (env && env.AI) _marginAI = env.AI;
  const cand = seqLines.filter((l) => !l.error && l.kind === 'sequence').map((l) => {
    const tests = (l.matched || []).map((m) => {
      const o = m.outcome || {}, lab = o.label || null, mg = m.evidence ? marginOf(m.evidence, th) : null;
      return { truthIdx: m.truthIdx, expect: { status: o.status || null, ks: lab ? lab.ks : null, headline: lab ? lab.headline : null, fullyRight: !!o.fullyRight }, margin: mg };
    }).filter((x) => x.margin !== null && x.margin >= 0.1 && (x.expect.ks === 'high' || x.expect.headline === 'high'));
    return { seed: l.seed, nSamples: l.nSamples, tests, nHH: tests.filter((x) => x.expect.headline === 'high').length };
  }).filter((c) => c.nHH >= 1);
  if (!cand.length) return null;
  const two = cand.filter((c) => c.nHH >= 2);
  const pick = (two.length ? two.sort((a, b) => a.nSamples - b.nSamples || a.seed - b.seed) : cand.sort((a, b) => b.nHH - a.nHH || a.nSamples - b.nSamples || a.seed - b.seed))[0];
  return { seed: pick.seed, nSamples: pick.nSamples, tests: pick.tests.map((x) => ({ truthIdx: x.truthIdx, expect: x.expect, margin: Math.round(x.margin * 1000) / 1000 })) };
}
// The BM1 / BM2 arrays of buildup-benchmark.test.js, as written by this run (<out>/benchmark-snapshot.js).
function benchSnapshotSource(summary) {
  const lit = (v) => (v && typeof v === 'object' ? '{ ' + Object.keys(v).map((k) => k + ': ' + lit(v[k])).join(', ') + ' }' : typeof v === 'string' ? "'" + v + "'" : String(v));
  const row = (o) => '  ' + lit(o) + ',';
  const L = ['// BM1-SNAPSHOT (buildup-validate.js --sequences --write, ' + todayUTC() + ')'];
  (summary.bench || []).forEach((b) => L.push(row({ slot: b.slot, seed: b.seed, expect: b.expect, margin: b.margin })));
  L.push('// BM2-HIGH (buildup-validate.js --sequences --write, ' + todayUTC() + ')');
  (summary.benchHigh || []).forEach((b) => L.push(row({ seed: b.seed, stratum: b.stratum, expect: b.expect, margin: b.margin })));
  if (summary.benchSeq) {
    L.push('// BM2-SEQUENCE (buildup-validate.js --sequences --write, ' + todayUTC() + ')');
    L.push('const HIGH_SEQ = { seed: ' + summary.benchSeq.seed + ', tests: [');
    summary.benchSeq.tests.forEach((t) => L.push('  ' + row({ truthIdx: t.truthIdx, expect: t.expect, margin: t.margin })));
    L.push('] };');
  }
  return L.join('\n') + '\n';
}
// The §5.4 constraint values of one pass (both tables), for the report: rate, single-case Wilson lower bound, cluster lower bound.
function constraintRows(T, rng) {
  const out = {};
  [['ks', T.ks], ['headline', T.hd]].forEach(([name, tb]) => {
    const r = {};
    LABELS.forEach((L) => {
      const s = rowStats(tb[L]), sg = rowStats(tb[L].filter((x) => x.single !== false)), cb = tb[L].length ? clusterBootstrap(tb[L], rng) : { lo: null };
      r[L] = { n: s.n, rate: s.rate, singleN: sg.n, singleRate: sg.rate, singleLo: sg.lo, clusterLo: cb.lo, cover2: s.cover2 };
    });
    out[name] = r;
  });
  return out;
}
function chooseBench(liteLines, th, env) {
  if (env && env.AI) _marginAI = env.AI;
  const items = liteLines.filter((l) => !l.error && l.kind === 'single').map((l) => liteItem(l, th, env, true)).filter(Boolean);
  const out = [];
  BENCH_SLOTS.forEach(([slot, pred]) => {
    const statusOnly = slot === 'partial' || slot === 'baddata';
    const list = items.filter((x) => pred(x) && !out.some((o) => o.seed === x.seed) && (statusOnly ? !x.hasEvidence : (x.hasEvidence && x.margin >= 0.1)))
      .sort((a, b) => (/^hom /.test(slot) ? (RANK_L[b.expect.headline] || 0) - (RANK_L[a.expect.headline] || 0) : 0) || b.margin - a.margin || a.seed - b.seed);
    if (list.length) out.push({ slot, seed: list[0].seed, stratum: list[0].stratum, expect: list[0].expect, margin: statusOnly ? null : Math.round(list[0].margin * 1000) / 1000 });
  });
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// Summary and report
// ═════════════════════════════════════════════════════════════════════════════
function summarize(lines, env, quickFR) {
  const singles = lines.filter((l) => l.kind === 'single');
  const per = {};
  singles.forEach((l) => {
    const p = per[l.stratum] = per[l.stratum] || { n: 0, errors: 0, fullyRight: 0, ksRight: 0, abstained: 0, high: 0, medium: 0, low: 0, gen_ms: [], analyse_ms: [] };
    p.n++;
    if (l.error) { p.errors++; return; }
    const o = l.outcome || {};
    if (o.fullyRight) p.fullyRight++; if (o.ksRight) p.ksRight++; if (o.abstained) p.abstained++;
    if (o.label) p[o.label.headline] = (p[o.label.headline] || 0) + 1;
    p.gen_ms.push(l.gen_ms); p.analyse_ms.push(l.analyse_ms);
  });
  Object.keys(per).forEach((k) => { const p = per[k]; p.gen_ms = quantile(p.gen_ms, 0.5); p.analyse_ms = quantile(p.analyse_ms, 0.5); });
  const all = singles.filter((l) => !l.error);
  const timings = {
    genMedian_ms: quantile(all.map((l) => l.gen_ms), 0.5), genP90_ms: quantile(all.map((l) => l.gen_ms), 0.9),
    analyseMedian_ms: quantile(all.map((l) => l.analyse_ms), 0.5), analyseP90_ms: quantile(all.map((l) => l.analyse_ms), 0.9),
    perCaseMedian_ms: quantile(all.map((l) => l.gen_ms + l.analyse_ms), 0.5),
  };
  // C within ±25 % when the unit slope was sampled; outcomes by rate source (allocation / table)
  const cU = all.filter((l) => l.evidence && l.evidence.unitSlope && l.test && l.test.result && l.test.result.final && l.truth && l.truth.C);
  const cOk = cU.filter((l) => Math.abs(l.test.result.final.C / l.truth.C - 1) <= 0.25).length;
  const bySource = {};
  all.forEach((l) => { const k = l.rateSource || 'allocation'; const b = bySource[k] = bySource[k] || { n: 0, fullyRight: 0, ksRight: 0 }; b.n++; if (l.outcome && l.outcome.fullyRight) b.fullyRight++; if (l.outcome && l.outcome.ksRight) b.ksRight++; });
  // reach per stratum: analysable truth whose closing reached a test entry that is not "not analysable" (target TARGETS.reach)
  const reach = {};
  all.filter((l) => l.truth && !l.truth.notAnalysable && !l.truth.partial).forEach((l) => {
    const r = reach[l.stratum] = reach[l.stratum] || { n: 0, reached: 0, rate: null, target: TARGETS.reach };
    r.n++; if (l.test && l.test.status !== 'not_analysable') r.reached++;
  });
  Object.keys(reach).forEach((k) => { reach[k].rate = reach[k].n ? reach[k].reached / reach[k].n : null; });
  // status accuracy on non-analysable truth (kept out of the label tables, §5.3): partial → classified partial, baddata →
  // not analysable (or not detected at all)
  const statusAccuracy = {};
  [['partial', (l) => l.truth && l.truth.partial], ['baddata', (l) => l.truth && l.truth.notAnalysable && !l.truth.partial]].forEach(([k, pred]) => {
    const arr = all.filter(pred), ok = arr.filter((l) => l.outcome && l.outcome.fullyRight).length, by = {};
    arr.forEach((l) => { const s = (l.outcome && l.outcome.status) || 'missed'; by[s] = (by[s] || 0) + 1; });
    statusAccuracy[k] = { n: arr.length, right: ok, rate: arr.length ? ok / arr.length : null, byStatus: by };
  });
  const out = { cases: singles.length, errors: singles.filter((l) => l.error).length, perStratum: per, timings, sequences: null, falseRival: null,
                cWithin25: { n: cU.length, rate: cU.length ? cOk / cU.length : null }, byRateSource: bySource, reach, statusAccuracy };
  if (lines.some((l) => l.kind === 'sequence')) out.sequences = { plain: sequenceMetrics(lines, 'plain'), basevar: sequenceMetrics(lines, 'basevar') };
  if (quickFR) {
    const fl = quickFR.filter((l) => !l.error && l.test && l.test.result && l.test.result.chosen);   // cases with a chosen model
    const k = fl.filter((l) => l.test && l.test.result && l.test.result.chosen && l.test.result.chosen.label !== 'Homogeneous').length;
    out.falseRival = { n: fl.length, rivals: k, rate: fl.length ? k / fl.length : null, target: TARGETS.falseRival };
  }
  return out;
}
function pct(v) { return v === null || v === undefined ? '—' : (100 * v).toFixed(1) + ' %'; }
function f2(v) { return v === null || v === undefined ? '—' : (+v).toFixed(2); }
function dash(v) { return v === null || v === undefined || (typeof v === 'number' && !isFinite(v)) ? '—' : String(v); }
function markdown(cal, summary) {
  const L = ['# Build-up Surveillance — calibration report', '', 'Generated ' + cal.generated + ' by buildup-validate.js (engine ' + cal.engine + ', app ' + cal.app + ').', ''];
  L.push('## Thresholds', '', '| key | value |', '|---|---|');
  Object.keys(cal.thresholds).sort().forEach((k) => L.push('| ' + k + ' | ' + cal.thresholds[k] + ' |'));
  const tbl = (title, rows, yKey) => {
    L.push('', '## ' + title, '', '| label | n | rate | Wilson 95 % | cluster 95 % | median abs ΔS | cover 2·S_err | single cases: n, rate, Wilson 95 % |', '|---|---|---|---|---|---|---|---|');
    rows.forEach((r) => L.push('| ' + r.label + ' | ' + r.n + ' | ' + pct(r[yKey]) + ' | ' + pct(r.lo) + '–' + pct(r.hi) + ' | ' + pct(r.loCluster) + '–' + pct(r.hiCluster) + ' | ' + f2(r.medAbsDS) + ' | ' + pct(r.cover2) + ' | ' +
                               (r.single ? r.single.n + ', ' + pct(r.single.rate) + ', ' + pct(r.single.lo) + '–' + pct(r.single.hi) : '—') + ' |'));
  };
  const capNote = cal.envelopeCapped ? ' — with the KC2 envelope cap, as the app labels' : ' — without the KC2 envelope cap';
  tbl('k/S label (k and S right)' + capNote, cal.ksTable, 'right'); tbl('Headline label (fully right)' + capNote, cal.table, 'fullyRight'); tbl('Strict (k ±5 %, S ±0.3)', cal.strict, 'fullyRight');
  tbl('k-held sub-table', cal.kHeldTable, 'right'); tbl('Gas sub-table', cal.gasTable, 'fullyRight');
  if (cal.uncapped) { tbl('k/S label — first pass, without the KC2 envelope cap', cal.uncapped.ksTable, 'right'); tbl('Headline label — first pass, without the KC2 envelope cap', cal.uncapped.table, 'fullyRight'); }
  const shr = (sh) => sh ? 'headline ' + sh.headline.high + ' of ' + sh.headline.n + ' (' + pct(sh.headline.share) + '; single cases ' + sh.headline.highSingle + ' of ' + sh.headline.nSingle + ', ' + pct(sh.headline.shareSingle) + '), k/S ' +
                           sh.ks.high + ' of ' + sh.ks.n + ' (' + pct(sh.ks.share) + '; single cases ' + sh.ks.highSingle + ' of ' + sh.ks.nSingle + ', ' + pct(sh.ks.shareSingle) + ')' : '—';
  L.push('', '## Share labelled high', '');
  if (cal.capped) L.push('- With the KC2 envelope cap (the app): ' + shr(cal.capped.shares) + '; ' + cal.capped.outsideEnvelope + ' build-ups outside the envelope');
  if (cal.uncapped) L.push('- First pass, without the cap: ' + shr(cal.uncapped.shares));
  if (summary.constraints) {
    const C = summary.constraints, f3 = (v) => (v === null || v === undefined ? '—' : (+v).toFixed(3));
    L.push('', '## Threshold search', '', '| search | candidates evaluated | feasible |', '|---|---|---|');
    C.search.forEach((r) => L.push('| ' + r.job + ' | ' + r.evaluated + ' | ' + r.feasible + ' |'));
    [['with the KC2 envelope cap (shipped tables)', C.capped], ['first pass, without the cap', C.uncapped]].forEach(([title, cr]) => {
      L.push('', '## Constraint check — ' + title, '', '| table | label | n | rate | single cases: n, rate, Wilson lower | cluster lower | cover 2·S_err |', '|---|---|---|---|---|---|---|');
      ['ks', 'headline'].forEach((k) => LABELS.forEach((lb) => { const r = cr[k][lb]; L.push('| ' + k + ' | ' + lb + ' | ' + r.n + ' | ' + f3(r.rate) + ' | ' + r.singleN + ', ' + f3(r.singleRate) + ', ' + f3(r.singleLo) + ' | ' + f3(r.clusterLo) + ' | ' + f3(r.cover2) + ' |'); }));
    });
    L.push('', '- Constraints missed without the cap: ' + (C.failsUncapped.length ? C.failsUncapped.join('; ') : 'none'));
  }
  L.push('', '## Scores', '', '- Brier ' + f2(cal.brier) + ', BSS ' + f2(cal.bss) + ' (reliability ' + f2(cal.reliability) + ', resolution ' + f2(cal.resolution) + ', uncertainty ' + f2(cal.uncertainty) + ')',
    '- False-rival rate on homogeneous truth ' + pct(cal.falseRival), '- Abstention ' + pct(cal.abstain.rate) + ' (hom ' + pct(cal.abstain.rateHom) + ')',
    '- Distractor caught ' + pct(cal.distractorCaught.rate) + ' of ' + cal.distractorCaught.n, '- Rate accuracy: median |error| ' + f2(cal.rateAccuracy.medAbsPct) + ' %, P90 ' + f2(cal.rateAccuracy.p90AbsPct) + ' %');
  const sq = (summary.sequences && (cal.thresholds.deltaForm === 'basevar' ? summary.sequences.basevar : summary.sequences.plain)) || {};
  L.push('', '## Sequences', '', '- Delta form shipped: ' + cal.thresholds.deltaForm, '- False alarms: delta ' + pct(cal.sequences.falseAlarmDelta) + ', absolute ' + pct(cal.sequences.falseAlarmAbs),
    '- Median confirmed-alert delay ' + f2(cal.sequences.delayMedian) + ' tests (24–48 h wells ' + f2(cal.sequences.delayMedianShort) + ')',
    '- Onset within one interval ' + pct(cal.sequences.onsetWithin1) + '; Sen CI covering the true slope ' + pct(cal.sequences.senCover),
    '- Stimulation drop without a workover date classified as a shut-in: ' + pct(sq.stimShutinRate) + ' of ' + dash(sq.stimN) + ' (target ≥ ' + pct(TARGETS.stimShutin) + ')',
    '- Constant-skin gas wells with D resolved and no delta alert: ' + pct(sq.gasNoAlertWhenDResolved) + ' of ' + dash(sq.gasResolvedN) + ' (target ' + pct(TARGETS.gasNoAlert) + ')');
  L.push('', '## Non-analysable truth (not in the label tables)', '', '| stratum | n | status right | rate | statuses |', '|---|---|---|---|---|');
  Object.keys(summary.statusAccuracy || {}).forEach((k) => { const s = summary.statusAccuracy[k]; L.push('| ' + k + ' | ' + s.n + ' | ' + s.right + ' | ' + pct(s.rate) + ' | ' + Object.keys(s.byStatus).map((x) => x + ' ' + s.byStatus[x]).join(', ') + ' |'); });
  L.push('', '## Reach (analysable truth reaching an analysable test; target ≥ ' + pct(TARGETS.reach) + ')', '', '| stratum | n | reached | rate |', '|---|---|---|---|');
  Object.keys(summary.reach || {}).forEach((k) => { const r = summary.reach[k]; L.push('| ' + k + ' | ' + r.n + ' | ' + r.reached + ' | ' + pct(r.rate) + ' |'); });
  L.push('', '## Other figures', '', '- C within ±25 % when the unit slope was sampled: ' + pct(summary.cWithin25 ? summary.cWithin25.rate : null) + ' of ' + (summary.cWithin25 ? summary.cWithin25.n : 0));
  Object.keys(summary.byRateSource || {}).forEach((k) => { const b = summary.byRateSource[k]; L.push('- Rate source ' + k + ': ' + b.n + ' cases, fully right ' + b.fullyRight + ', k/S right ' + b.ksRight); });
  L.push('', '## Per stratum (labels as first run, with the table loaded at the start)', '', '| stratum | n | errors | fully right | k/S right | abstained | high / medium / low | gen ms | analyse ms |', '|---|---|---|---|---|---|---|---|---|');
  Object.keys(summary.perStratum).forEach((s) => { const p = summary.perStratum[s]; L.push('| ' + s + ' | ' + p.n + ' | ' + p.errors + ' | ' + p.fullyRight + ' | ' + p.ksRight + ' | ' + p.abstained + ' | ' + (p.high || 0) + ' / ' + (p.medium || 0) + ' / ' + (p.low || 0) + ' | ' + f2(p.gen_ms) + ' | ' + f2(p.analyse_ms) + ' |'); });
  L.push('', '## In-app cases (24, lite settings, run with the calibrated table)', '', '| seed | stratum | status | k/S | headline | fully right | margin |', '|---|---|---|---|---|---|---|');
  cal.inApp.forEach((c) => L.push('| ' + c.seed + ' | ' + c.stratum + ' | ' + dash(c.expect.status) + ' | ' + dash(c.expect.ks) + ' | ' + dash(c.expect.headline) + ' | ' +
                                  dash(c.expect.fullyRight) + ' | ' + dash(c.margin) + ' |'));
  if (summary.bench) {
    L.push('', '## Benchmark acceptance seeds (BM1, lite, run with the calibrated table)', '', '| slot | seed | status | k/S | headline | fully right | margin |', '|---|---|---|---|---|---|---|');
    summary.bench.forEach((c) => L.push('| ' + c.slot + ' | ' + c.seed + ' | ' + dash(c.expect.status) + ' | ' + dash(c.expect.ks) + ' | ' + dash(c.expect.headline) + ' | ' + dash(c.expect.fullyRight) + ' | ' + dash(c.margin) + ' |'));
  }
  if (summary.benchHigh) {
    L.push('', '## High cases re-run by BM2 (lite, run with the calibrated table)', '', '| seed | stratum | status | k/S | headline | fully right | margin |', '|---|---|---|---|---|---|---|');
    summary.benchHigh.forEach((c) => L.push('| ' + c.seed + ' | ' + c.stratum + ' | ' + dash(c.expect.status) + ' | ' + dash(c.expect.ks) + ' | ' + dash(c.expect.headline) + ' | ' + dash(c.expect.fullyRight) + ' | ' + dash(c.margin) + ' |'));
  }
  if (summary.benchSeq) {
    L.push('', '## Sequence well re-run by BM2 (lite, run with the calibrated table): ' + summary.benchSeq.seed + ' (' + summary.benchSeq.nSamples + ' samples)', '', '| test (truth index) | status | k/S | headline | fully right | margin |', '|---|---|---|---|---|---|');
    summary.benchSeq.tests.forEach((c) => L.push('| ' + c.truthIdx + ' | ' + dash(c.expect.status) + ' | ' + dash(c.expect.ks) + ' | ' + dash(c.expect.headline) + ' | ' + dash(c.expect.fullyRight) + ' | ' + dash(c.margin) + ' |'));
  }
  if (summary.sequencesCalibrated) {
    const a = summary.sequencesCalibrated;
    L.push('', '## Sequences re-run with the calibrated table', '', '| form | delta false alarms | absolute false alarms | median delay | delay 24–48 h | onset within 1 | Sen CI cover | stimulation → shut-in | gas quiet |', '|---|---|---|---|---|---|---|---|---|');
    ['plain', 'basevar'].forEach((k) => { const q = a[k]; L.push('| ' + k + ' | ' + pct(q.falseAlarmDelta) + ' | ' + pct(q.falseAlarmAbs) + ' | ' + f2(q.delayMedian) + ' | ' + f2(q.delayMedianShort) + ' | ' + pct(q.onsetWithin1) + ' | ' + pct(q.senCover) + ' | ' + pct(q.stimShutinRate) + ' | ' + pct(q.gasNoAlertWhenDResolved) + ' |'); });
  }
  return L.join('\n') + '\n';
}

// ═════════════════════════════════════════════════════════════════════════════
// --perf (§4.8, wall clock)
// ═════════════════════════════════════════════════════════════════════════════
function perf(env) {
  const { SY, RUN, DATA, REVIEW } = env, rows = [];
  const add = (item, ms, target) => rows.push({ item, ms: ms === null ? null : Math.round(ms * 10) / 10, target, ok: ms === null ? null : ms <= target });
  let t0 = nowMs(); const demo = SY.demo('oil'); add('oil demo generation (synth, sync)', nowMs() - t0, 2000);
  let an = null;
  t0 = nowMs(); an = RUN.analyse(SY.toInput(demo), { cache: null }); const tAll = nowMs() - t0;
  const nT = an && an.tests ? an.tests.length : 0;
  add('oil demo analysis, ' + nT + ' tests (target scaled from 8 tests ≤ 1.7 s)', tAll, 1700 * Math.max(1, nT) / 8);
  add('typical test (analysis / tests)', nT ? tAll / nT : null, 200);
  t0 = nowMs(); RUN.analyse(SY.toInput(demo), { cache: an }); add('re-analysis with the cache', nowMs() - t0, 400);
  if (REVIEW && typeof REVIEW.evidence === 'function') {
    t0 = nowMs();
    try { const idx = REVIEW.evidence(an); const rv = REVIEW.run(an, idx); REVIEW.report(an, rv, [], null, (v) => String(v)); add('review + report model', nowMs() - t0, 50); } catch (e) { add('review + report model (failed: ' + e.message + ')', null, 50); }
  }
  if (DATA && typeof DATA.parse === 'function') {
    // 500k-row CSV from the oil demo record tiled in time
    const r = demo.record, span = r.t[r.n - 1] - r.t[0] + 60000, parts = ['time,pressure_psia'];
    let n = 0;
    for (let rep = 0; n < 500000; rep++) for (let i = 0; i < r.n && n < 500000; i++, n++) parts.push(new Date(r.t[i] + rep * span).toISOString() + ',' + r.p[i].toFixed(3));
    const text = parts.join('\n');
    try {
      const sn = typeof DATA.sniff === 'function' ? DATA.sniff(text.slice(0, 65536)) : null;
      const popt = { cols: sn ? sn.cols : { t: 0, p: 1, T: -1, q: -1 }, timeFormat: sn ? sn.timeFormat : 'iso', zone: { mode: 'utc' }, pUnit: 'psia', patm: 14.696 };
      t0 = nowMs(); const pr = DATA.parse(text, popt); add('parse 500k rows', nowMs() - t0, 1500);
      const rec = pr.record || pr;
      t0 = nowMs(); const qc = DATA.qc(rec, {}); DATA.detect(rec, qc, {}); add('QC + detection, 500k samples', nowMs() - t0, 400);
    } catch (e) { add('parse / detection (failed: ' + e.message + ')', null, 1500); }
  }
  perfReference(env, add);
  return rows;
}
// The reference case (US4: k 45, S 5, C 0.02, h 50, μ 1, 72 h after t_p 720 h; synth.reference) through the pipeline, then
// the §4.8 per-stage rows timed on its BuildupSpec with the §3.1 functions, each with the PRiSM_autoInterp.stats() counters it
// used; and the homogeneous fit on the 365-daily-step reference (±15 % day variation).
function perfReference(env, add) {
  const { SY, RUN, AI } = env;
  if (!SY || typeof SY.reference !== 'function' || !AI || !RUN) return;
  const runJob = (j) => { let s, g = 0; do { s = j.step(); } while (!s.done && ++g < 1e6); return j.result(); };
  const timed = (label, target, fn) => {
    let out = null;
    try {
      if (typeof AI.resetStats === 'function') AI.resetStats();
      const t0 = nowMs(); out = fn(); const ms = nowMs() - t0;
      const st = typeof AI.stats === 'function' ? AI.stats() : null;
      const used = st ? ['evals', 'gridBuilds', 'fits', 'lmIters', 'slices', 'lines'].filter((k) => typeof st[k] === 'number' && st[k]).map((k) => k + ' ' + st[k]) : null;
      const cnt = used ? ' [' + (used.length ? used.join(', ') : 'no evaluation run') + ']' : '';
      add(label + cnt, ms, target);
    } catch (e) { add(label + ' (failed: ' + e.message + ')', null, target); }
    return out;
  };
  // a TestEntry keeps the stored BuildupSpec (no rate steps, §3.7); the run layer's rehydrate restores the steps from the
  // analysis rate history when it is exported
  const full = (an, t) => ((t.spec && t.spec.steps) || typeof RUN.rehydrate !== 'function' || !an.rates || !an.record) ? t.spec : RUN.rehydrate(t.spec, an.rates, an.record.origin_ms);
  const specOf = (sc) => { const an = RUN.analyse(SY.toInput(sc), { cache: null }); const t = an && an.tests && an.tests.find((x) => x.spec && x.status === 'interpreted'); return { an, spec: t ? full(an, t) : null }; };
  let ref, r365;
  try { ref = SY.reference({ days: 30 }); } catch (e) { add('reference case generation (failed: ' + e.message + ')', null, 2000); return; }
  const t0 = nowMs(); const R = specOf(ref); add('reference case, whole analysis (1 test, ≤ typical test + trend/review)', nowMs() - t0, 250);
  if (!R.spec) { add('reference case: no analysable test (stage rows skipped)', null, 0); return; }
  const spec = R.spec;
  timed('reference: interpret (typical test)', 200, () => AI.interpret(spec));
  let prep = null, ir = null, hom = null;
  timed('reference: per-test prep (prepare, storage, IARF, line)', 40, () => { prep = AI.prepare(spec); AI.storage(prep); ir = AI.iarf(prep); AI.line(prep, ir); return prep; });
  if (!prep || prep.ok === false) return;
  hom = timed('reference: homogeneous fit (30 daily steps)', 60, () => AI.fit('homogeneous', prep));
  if (hom) {
    // 'extended' runs the ×0.8 / ×1.25 refit pair even when the unit slope is sampled (in 'auto' it is skipped then)
    timed('reference: C-held refit pair, forced (target per refit ≤ 30 ms, pair ≤ 60)', 60, () => runJob(AI.cHeldJob(prep, hom, { mode: 'extended' })));
    timed('reference: k-held fit + 2 refits', 80, () => runJob(AI.kHeldJob(prep, { k: hom.phys ? hom.phys.k : 45, delta: 0.05 })));
  }
  timed('reference: fault fit', 100, () => AI.fit('linearBoundary', prep));
  timed('reference: composite fit, F frozen', 300, () => AI.fit('composite2', prep, { freeze: { F: true } }));
  timed('reference: closed-circle fit', 150, () => AI.fit('closedCircle', prep));
  try { r365 = SY.reference({ days: 365, variationPct: 15, rateTable: true }); } catch (e) { r365 = null; }
  if (r365) {
    const R2 = specOf(r365);
    if (R2.spec) { const p2 = AI.prepare(R2.spec); if (p2 && p2.ok !== false) timed('homogeneous fit, 365 daily steps (reference)', 60, () => AI.fit('homogeneous', p2)); }
    else add('365-step reference: no analysable test', null, 60);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// main
// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  if (flag('--help') || flag('-h')) {
    const src = fs.readFileSync(__filename, 'utf8').split('\n');
    console.log(src.slice(1, src.findIndex((l) => l.startsWith("'use strict'"))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return 0;
  }
  if (flag('--placeholder')) {
    const cal = placeholderCal();
    writeCal(cal);
    console.log('[validate] wrote ' + path.relative(process.cwd(), CAL_FILE) + ' (placeholder: calibrated:false, pre-calibration thresholds, ' + cal.inApp.length + ' provisional in-app cases)');
    return 0;
  }
  const out = path.resolve(val('--out', path.join(os.tmpdir(), 'wts-buildup-validate')));
  const calOut = val('--cal-out', null) ? path.resolve(val('--cal-out')) : CAL_FILE;
  if (flag('--stub-engine')) { process.env.BUV_STUB_ENGINE = '1'; console.log('[validate] --stub-engine: plumbing check only, no interpretation'); }
  const strict = flag('--strict'), asJson = flag('--json');
  const nWorkers = Math.max(1, +val('--workers', Math.min(4, os.cpus().length)) || 1);
  const t0 = nowMs();
  let env;
  try { env = loadEnv(); } catch (e) { console.error('[validate] crash while loading the app: ' + (e && e.stack || e)); return 2; }
  if (env.missing.length) return notRunnable(env.missing);
  fs.mkdirSync(out, { recursive: true });
  let fails = [];
  if (flag('--perf')) {
    const rows = perf(env);
    console.log('[validate] --perf (wall clock, this machine)');
    rows.forEach((r) => console.log('  ' + (r.ok === null ? '?' : r.ok ? 'ok ' : 'MISS') + '  ' + r.item + ': ' + (r.ms === null ? 'n/a' : r.ms + ' ms') + ' (target ≤ ' + Math.round(r.target) + ' ms)'));
    rows.filter((r) => r.ok === false).forEach((r) => fails.push('perf: ' + r.item));
    fs.writeFileSync(path.join(out, 'perf.json'), JSON.stringify(rows, null, 2));
    if (!flag('--quick') && !flag('--seeds') && !flag('--strata') && !flag('--sequences') && !flag('--write')) {
      if (asJson) console.log(JSON.stringify({ perf: rows }, null, 2));
      return strict && fails.length ? 1 : 0;
    }
  }
  const SY = env.SY;
  let seeds = flag('--quick') ? quickSeeds(SY) : (flag('--seeds') ? parseSeeds(val('--seeds')) : parseSeeds(SINGLE.join('-')));
  if (flag('--strata')) { const keep = new Set(val('--strata').split(',').map((s) => s.trim())); seeds = seeds.filter((s) => keep.has(strataOf(SY, s))); }
  seeds = seeds.filter((s) => s >= SINGLE[0] && s <= SINGLE[1]);
  const items = seeds.map((seed) => ({ kind: 'single', seed }));
  if (flag('--sequences') && !flag('--quick')) for (let s = SEQ[0]; s <= SEQ[1]; s++) items.push({ kind: 'sequence', seed: s });
  const frSeeds = flag('--quick') ? falseRivalSeeds(SY) : null;
  const opts = { lite: flag('--lite'), gridSample: Math.max(1, +val('--grid-sample', 1) || 1) };
  console.log('[validate] ' + items.length + ' items (' + seeds.length + ' single' + (items.length > seeds.length ? ', ' + (items.length - seeds.length) + ' sequences' : '') + ')' +
              (frSeeds ? ' + ' + frSeeds.length + ' false-rival seeds' : '') + ' on ' + nWorkers + ' worker(s); output ' + out);
  let lines, frLines = null, liteLines = null;
  const progress = (l, k, n) => { if (k % 20 === 0 || k === n) process.stdout.write('[validate]   ' + k + '/' + n + '\n'); };
  try {
    lines = await runItems(items, opts, nWorkers, progress);
    if (frSeeds) frLines = await runItems(frSeeds.map((seed) => ({ kind: 'single', seed })), opts, nWorkers, null);
  } catch (e) {
    if (e && e.missing) return notRunnable(e.missing);
    console.error('[validate] crash: ' + (e && e.stack || e)); return 2;
  }
  const order = (a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.seed - b.seed);
  lines.sort(order);
  fs.writeFileSync(path.join(out, 'cases.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  if (frLines) fs.writeFileSync(path.join(out, 'false-rival.jsonl'), frLines.sort(order).map((l) => JSON.stringify(l)).join('\n') + '\n');
  const summary = summarize(lines, env, frLines);
  summary.elapsed_s = Math.round((nowMs() - t0) / 100) / 10;
  if (summary.falseRival && summary.falseRival.rate !== null && summary.falseRival.rate > TARGETS.falseRival) fails.push('false-rival rate ' + pct(summary.falseRival.rate));
  if (summary.errors) fails.push(summary.errors + ' case errors');
  Object.keys(summary.reach).forEach((k) => { const r = summary.reach[k]; if (r.rate !== null && r.rate < TARGETS.reach) fails.push('reach ' + k + ' ' + pct(r.rate)); });
  if (summary.sequences) {
    const sp = summary.sequences.plain;
    if (sp.stimShutinRate !== null && sp.stimShutinRate < TARGETS.stimShutin) fails.push('stimulation drop classified as a shut-in ' + pct(sp.stimShutinRate));
    if (sp.gasNoAlertWhenDResolved !== null && sp.gasNoAlertWhenDResolved < TARGETS.gasNoAlert) fails.push('delta alerts on constant-skin gas wells with D resolved');
  }
  let calFailed = false;
  if (flag('--write')) {
    let res;
    try { res = await calibrateParallel(lines, env, Object.assign({}, opts, { workers: nWorkers })); }
    catch (e) { if (e && e.missing) return notRunnable(e.missing); console.error('[validate] crash: ' + (e && e.stack || e)); return 2; }
    // The candidate table goes to <out>/cal-candidate.js and the workers load it (BUV_CAL_SRC). Every item is re-run with it:
    // the singles and the sequences carry the engine's KC2 flag against the candidate's envelope (second pass: the shipped
    // tables are capped as in the app), the sequences' alerts and pass-2 evidence follow its labels (through the used set),
    // and the lite in-app pool runs with it, so the in-app expectations are the app's own labels and their margins come from
    // that evidence.
    const candFile = path.join(out, 'cal-candidate.js');
    writeCal(res.cal, candFile);
    let reLines;
    try { reLines = await runItems(lines.filter((l) => !l.error).map((l) => ({ kind: l.kind, seed: l.seed })), opts, nWorkers, progress, candFile); }
    catch (e) { if (e && e.missing) return notRunnable(e.missing); console.error('[validate] crash: ' + (e && e.stack || e)); return 2; }
    reLines.sort(order);
    fs.writeFileSync(path.join(out, 'cases-calibrated.jsonl'), reLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const reErr = reLines.filter((l) => l.error).length;
    if (reErr) { console.error('[validate] ' + reErr + ' errors in the re-run with the candidate table'); return 2; }
    try { finishCalibration(res, reLines, env); }
    catch (e) { console.error('[validate] crash: ' + (e && e.stack || e)); return 2; }
    console.log('[validate] second pass (KC2 envelope cap as in the app): ' + res.cal.capped.outsideEnvelope + ' build-ups outside the envelope; headline high ' +
                res.cal.uncapped.shares.headline.high + ' → ' + res.cal.capped.shares.headline.high + ', k/S high ' + res.cal.uncapped.shares.ks.high + ' → ' + res.cal.capped.shares.ks.high);
    const seqLines = reLines.filter((l) => l.kind === 'sequence');
    if (seqLines.length) {
      fs.writeFileSync(path.join(out, 'sequences-calibrated.jsonl'), seqLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      const sp = sequenceMetrics(seqLines, 'plain'), sb = sequenceMetrics(seqLines, 'basevar');
      res.cal.thresholds.deltaForm = (sp.falseAlarmDelta !== null && sp.falseAlarmDelta > TARGETS.falseAlarm && sb.falseAlarmDelta !== null &&
                                      sb.falseAlarmDelta <= TARGETS.falseAlarm) ? 'basevar' : 'plain';
      const sm = res.cal.thresholds.deltaForm === 'basevar' ? sb : sp;
      res.cal.sequences = { falseAlarmDelta: sm.falseAlarmDelta, falseAlarmAbs: sm.falseAlarmAbs, delayMedian: sm.delayMedian, delayMedianShort: sm.delayMedianShort,
                            onsetWithin1: sm.onsetWithin1, senCover: sm.senCover };
      summary.sequencesCalibrated = { plain: sp, basevar: sb };
      if (sm.falseAlarmDelta !== null && sm.falseAlarmDelta > TARGETS.falseAlarm) fails.push('calibration: sequence delta false-alarm rate ' + pct(sm.falseAlarmDelta));
    }
    writeCal(res.cal, candFile);
    // the 24 in-app cases need margin ≥ 0.1 (§5.6); the candidate pool widens (6, 15, then every seed per stratum) before
    // giving up, and file 55 is never written as calibrated with fewer than 24
    const seen = new Set(), pools = [6, 15, Infinity];
    liteLines = [];
    for (const per of pools) {
      const cand = [];
      SY.SEED_TABLE.forEach((e) => { const m = Math.min(e.n, per); for (let i = 0; i < m; i++) cand.push(e.from + Math.floor(i * e.n / m)); });
      if (per === pools[0]) IN_APP_PROVISIONAL.forEach(([s]) => cand.push(s));
      const fresh = cand.filter((s) => !seen.has(s) && seen.add(s));
      if (fresh.length) {
        try { liteLines = liteLines.concat(await runItems(fresh.map((seed) => ({ kind: 'single', seed })), { lite: true }, nWorkers, null, candFile)); }
        catch (e) { if (e && e.missing) return notRunnable(e.missing); console.error('[validate] crash: ' + (e && e.stack || e)); return 2; }
      }
      res.cal.inApp = chooseInApp(liteLines, res.cal.thresholds, env, true);
      console.log('[validate] in-app cases with margin ≥ 0.1: ' + res.cal.inApp.length + ' of 24 (pool ' + seen.size + ' lite cases)');
      if (res.cal.inApp.length === 24) break;
    }
    fs.writeFileSync(path.join(out, 'lite-calibrated.jsonl'), liteLines.slice().sort(order).map((l) => JSON.stringify(l)).join('\n') + '\n');
    summary.bench = chooseBench(liteLines, res.cal.thresholds, env);
    // a slot still empty (or hom long without a high case for BM2): widen the lite pool for that stratum (up to 40 more seeds)
    const wantSlots = BENCH_SLOTS.map((b) => b[0]).filter((sl) => !summary.bench.some((b) => b.slot === sl) || (sl === 'hom long' && !summary.bench.some((b) => b.slot === sl && b.expect.headline === 'high')));
    if (wantSlots.length) {
      const strataW = new Set(wantSlots.map((sl) => sl.split(' ')[0]).map((x) => (x === 'fault' ? 'fault' : x)));
      const more = [];
      SY.SEED_TABLE.forEach((e) => {
        if (!strataW.has(e.stratum)) return;
        let k = 0;
        for (let sd = e.from; sd <= e.to && k < 40; sd++) {
          if (seen.has(sd)) continue;
          if (e.stratum === 'hom') { const short = SY.caseFromSeed(sd).test.dtEnd_h < 8; if (short !== wantSlots.includes('hom short') && !wantSlots.includes('hom long')) continue; }
          seen.add(sd); more.push(sd); k++;
        }
      });
      if (more.length) {
        try { liteLines = liteLines.concat(await runItems(more.map((seed) => ({ kind: 'single', seed })), { lite: true }, nWorkers, null, candFile)); }
        catch (e) { if (e && e.missing) return notRunnable(e.missing); console.error('[validate] crash: ' + (e && e.stack || e)); return 2; }
        summary.bench = chooseBench(liteLines, res.cal.thresholds, env);
        fs.writeFileSync(path.join(out, 'lite-calibrated.jsonl'), liteLines.slice().sort(order).map((l) => JSON.stringify(l)).join('\n') + '\n');
      }
    }
    // BM2 needs high cases to check: up to BENCH_HIGH lite cases labelled high (k/S or headline; headline high first) with
    // margin ≥ 0.1; when the pool holds fewer, every hom and gas seed not yet run is run lite with the candidate table
    const highsOf = () => liteLines.filter((l) => !l.error && l.kind === 'single').map((l) => liteItem(l, res.cal.thresholds, env, true)).filter((x) => x && x.hasEvidence && x.margin >= 0.1 &&
      (x.expect.ks === 'high' || x.expect.headline === 'high')).sort((a, b) => (b.expect.headline === 'high') - (a.expect.headline === 'high') || b.margin - a.margin || a.seed - b.seed);
    if (highsOf().length < BENCH_HIGH) {
      const more2 = [];
      SY.SEED_TABLE.forEach((e) => { if (e.stratum !== 'hom' && e.stratum !== 'gas') return; for (let sd = e.from; sd <= e.to; sd++) if (!seen.has(sd)) { seen.add(sd); more2.push(sd); } });
      if (more2.length) {
        try { liteLines = liteLines.concat(await runItems(more2.map((seed) => ({ kind: 'single', seed })), { lite: true }, nWorkers, null, candFile)); }
        catch (e) { if (e && e.missing) return notRunnable(e.missing); console.error('[validate] crash: ' + (e && e.stack || e)); return 2; }
        fs.writeFileSync(path.join(out, 'lite-calibrated.jsonl'), liteLines.slice().sort(order).map((l) => JSON.stringify(l)).join('\n') + '\n');
      }
    }
    summary.bench = chooseBench(liteLines, res.cal.thresholds, env);
    summary.benchHigh = highsOf().slice(0, BENCH_HIGH).map((x) => ({ seed: x.seed, stratum: x.stratum, expect: x.expect, margin: Math.round(x.margin * 1000) / 1000 }));
    // BM2 also re-runs one sequence well (lite): the sequence tests carry almost every pooled high label. Every sequence is
    // run lite with the candidate table; the well with at least 2 headline-high tests (margin ≥ 0.1) and the fewest samples
    // is taken (else the most headline-high tests), with every test labelled high (k/S or headline) at margin ≥ 0.1.
    if (lines.some((l) => l.kind === 'sequence')) {
      let seqLite;
      try { seqLite = await runItems(lines.filter((l) => l.kind === 'sequence' && !l.error).map((l) => ({ kind: 'sequence', seed: l.seed })), { lite: true }, nWorkers, null, candFile); }
      catch (e) { if (e && e.missing) return notRunnable(e.missing); console.error('[validate] crash: ' + (e && e.stack || e)); return 2; }
      summary.benchSeq = chooseBenchSequence(seqLite, res.cal.thresholds, env);
      console.log('[validate] sequence well for BM2: ' + (summary.benchSeq ? summary.benchSeq.seed + ' (' + summary.benchSeq.tests.length + ' high tests, ' + summary.benchSeq.nSamples + ' samples)' : 'none'));
    }
    console.log('[validate] high cases for BM2: ' + (summary.benchHigh.map((b) => b.seed + ' (' + b.expect.ks + '/' + b.expect.headline + ')').join(', ') || 'none'));
    console.log('[validate] benchmark seeds (BM1): ' + summary.bench.map((b) => b.slot + ' ' + b.seed + ' (' + (b.expect.headline || b.expect.status) + ')').join(', '));
    if (res.cal.inApp.length !== 24) { calFailed = true; fails.push('only ' + res.cal.inApp.length + ' in-app cases with margin ≥ 0.1: file 55 not written'); }
    // the constraint check on the shipped (capped) tables; the first-pass (uncapped) check is reported alongside
    summary.constraints = { capped: constraintRows(res.T2, SY.rng), uncapped: constraintRows(res.T, SY.rng),
                            failsUncapped: checkTargets(res.T, { rng: SY.rng }), search: res.search.map((r, j) => ({ job: j < res.foldTh.length ? 'fold ' + (j + 1) : 'all folds', evaluated: r.evaluated, feasible: r.feasible })) };
    checkTargets(res.T2, { rng: SY.rng }).forEach((f) => fails.push('calibration: ' + f));
    fs.writeFileSync(path.join(out, 'benchmark-snapshot.js'), benchSnapshotSource(summary));
    if (!calFailed) writeCal(res.cal, calOut);
    fs.writeFileSync(path.join(out, 'calibration.md'), markdown(res.cal, summary));
    summary.calibration = { thresholds: res.cal.thresholds, falseRival: res.cal.falseRival, sequences: res.cal.sequences, written: !calFailed, inApp: res.cal.inApp.length };
    console.log('[validate] wrote ' + (calFailed ? '' : path.relative(process.cwd(), calOut) + ' and ') + path.join(out, 'calibration.md'));
  }
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('[validate] ' + summary.cases + ' cases, ' + summary.errors + ' errors, median per case ' + Math.round(summary.timings.perCaseMedian_ms || 0) + ' ms ' +
              '(generation ' + Math.round(summary.timings.genMedian_ms || 0) + ', analysis ' + Math.round(summary.timings.analyseMedian_ms || 0) + '), elapsed ' + summary.elapsed_s + ' s');
  Object.keys(summary.perStratum).forEach((s) => { const p = summary.perStratum[s]; console.log('  ' + s.padEnd(10) + ' n ' + String(p.n).padStart(3) + '  fully right ' + String(p.fullyRight).padStart(3) + '  k/S right ' + String(p.ksRight).padStart(3) + '  abstained ' + p.abstained + (p.errors ? '  errors ' + p.errors : '')); });
  if (summary.falseRival) console.log('  false-rival check: ' + summary.falseRival.rivals + ' of ' + summary.falseRival.n + ' homogeneous cases chose a rival (' + pct(summary.falseRival.rate) + ', target ≤ 5 %)');
  if (summary.sequences) console.log('  sequences: delta false alarms ' + pct(summary.sequences.plain.falseAlarmDelta) + ' (plain) / ' + pct(summary.sequences.basevar.falseAlarmDelta) + ' (basevar)');
  if (asJson) console.log(JSON.stringify(summary, null, 2));
  if (fails.length) console.log('[validate] targets missed: ' + fails.join('; '));
  if (calFailed) return 1;   // --write without 24 in-app cases: never a silent success
  return strict && fails.length ? 1 : 0;
}

module.exports = { PRE_THRESHOLDS, GRID_STAGE1, GRID_STAGE2, TARGETS, IN_APP_PROVISIONAL, BOOT_FULL, BOOT_GRID, placeholderCal, calSource, writeCal, parseSeeds, wilson,
                   quantile, clusterBootstrap, bootRow, checkTargets, tables, rowStats, marginOf, sequenceMetrics, labelledSet, foldsOf, combos, calibrate, chooseInApp,
                   summarize, markdown, relabel, CAL_FILE, chooseBench, liteItem, searchThresholds, calibrateParallel, oofPass, passTables, finishCalibration, shares,
                   constraintRows, STRICT_STAGE1, STRICT_STAGE2, strictSet, BENCH_HIGH, chooseBenchSequence };

if (require.main === module) {
  if (flag('--search-worker')) searchWorkerMain();
  else if (IS_WORKER) workerMain();
  else main().then((code) => process.exit(code), (e) => { console.error('[validate] crash: ' + (e && e.stack || e)); process.exit(2); });
}
