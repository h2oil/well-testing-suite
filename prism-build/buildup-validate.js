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
//   --write        calibration (§5.4): writes file 55 (calibrated:true) and <out>/calibration.md
//   --perf         the §4.8 timing targets on the oil demo and a 500k-row file (wall clock); --strict exits 1 on a miss
//   --workers n    child processes (default min(4, CPUs)); worker i takes the seeds ≡ i (mod n)
//   --out dir      output directory (default $TMPDIR/wts-buildup-validate): cases.jsonl, summary.json, calibration.md
//   --json         print the summary as JSON on stdout
//   --lite         generate every case with the lite settings (60 s sampling, ≤ 30 days; what the in-app check uses)
//   --grid-sample n  evaluate only every n-th combination of the calibration grid (quick dry runs; default 1)
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
const TARGETS = { highRate: 0.95, highLo: 0.90, medRate: 0.80, medLo: 0.70, lowGap: 0.20, falseRival: 0.05, cover: 0.90, abstainHom: 0.10, falseAlarm: 0.05 };
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
function loadEnv() {
  const harness = require('./tests/_harness');
  const app = harness.loadApp({ fromSources: true, timers: 'real', console: 'errors' });
  const W = app.win, BU = W.WTS_buildup || {};
  const missing = [];
  if (!BU.synth || typeof BU.synth.generate !== 'function') missing.push('WTS_buildup.synth (49-calc-buildup-synth.js, WP4)');
  if (!W.PRiSM_autoInterp || typeof W.PRiSM_autoInterp.interpretJob !== 'function') missing.push('PRiSM_autoInterp.interpretJob (53-prism-autointerp.js, WP1)');
  if (!BU.run || typeof BU.run.analyse !== 'function') missing.push('WTS_buildup.run.analyse (49-calc-buildup-run.js, WP2)');
  return { app, W, SY: BU.synth, RUN: BU.run, AI: W.PRiSM_autoInterp, DATA: BU.data, REVIEW: BU.review, missing, build: app.build };
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
      return { truthIdx: i, testId: m.test ? m.test.id : null, outcome: s, test: testSummary(m.test), evidence: (m.test && m.test.result && m.test.result.evidence) || null,
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
function runItems(items, opts, nWorkers, onLine) {
  return new Promise((resolve, reject) => {
    if (!items.length) { resolve([]); return; }
    const W = Math.max(1, Math.min(nWorkers, items.length)), lines = [];
    let done = 0, failed = false;
    for (let w = 0; w < W; w++) {
      const mine = items.filter((_, i) => i % W === w);
      const child = fork(__filename, ['--worker'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
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
// Cluster bootstrap over wells (groups): 2000 resamples with synth.rng(seed) → 2.5 % / 97.5 % of the rate.
function clusterBootstrap(items, rngFactory, B) {
  const groups = new Map();
  items.forEach((it) => { if (!groups.has(it.g)) groups.set(it.g, { k: 0, n: 0 }); const g = groups.get(it.g); g.n++; g.k += it.y ? 1 : 0; });
  const G = Array.from(groups.values());
  if (!G.length) return { lo: null, hi: null };
  const r = rngFactory(MASTER + 77), rates = [];
  for (let b = 0; b < (B || 2000); b++) {
    let k = 0, n = 0;
    for (let i = 0; i < G.length; i++) { const g = G[Math.floor(r.next() * G.length)]; k += g.k; n += g.n; }
    rates.push(n ? k / n : 0);
  }
  return { lo: quantile(rates, 0.025), hi: quantile(rates, 0.975) };
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
function relabel(c, th, env) {
  const ev = c.evidence ? Object.assign({}, c.evidence) : null;
  const t = c.test, r = t && t.result;
  let outcome = c.outcome;
  if (!ev || !r) {
    const lab = c.outcome && c.outcome.label;
    return { ks: lab ? lab.ks : 'low', headline: lab ? lab.headline : 'low', outcome, sErr: r && r.sErr ? r.sErr.value : null };
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
      const label = { homogeneous: 'Homogeneous', composite2: 'Radial composite' }[key] || (m && /fault|bound/i.test(key) ? 'Sealing fault' : 'Closed circle');
      const t2 = JSON.parse(JSON.stringify(t));
      t2.result.chosen = { key, label, fullySeen: { status: m && m.fullySeen ? m.fullySeen : 'n/a' } };
      if (m && t2.result.final) { t2.result.final.k = m.k; t2.result.final.S = m.S; if (t2.result.final.gas) t2.result.final.gas.Sprime = m.S; }
      outcome = env.SY.score(t2, c.truth, { event: c.event });
      ev.chosenKey = key; ev.chosenFullySeen = t2.result.chosen.fullySeen.status;
    }
  }
  ev.outsideEnvelope = false;
  let conf = null;
  try { conf = env.AI.confidence(ev, { version: 'grid', calibrated: true, thresholds: th, envelope: null, ksTable: [], table: [], inApp: [] }); } catch (e) { conf = null; }
  if (!conf || LABELS.indexOf(conf.ks) === -1) return { ks: 'low', headline: 'low', outcome, sErr, error: true };
  return { ks: conf.ks, headline: conf.headline, outcome, sErr };
}
function tables(cases, labels) {
  const ks = {}, hd = {};
  LABELS.forEach((L) => { ks[L] = []; hd[L] = []; });
  cases.forEach((c, i) => {
    const lb = labels[i], o = lb.outcome || {};
    const abst = !!o.abstained;
    const ksL = abst ? 'low' : lb.ks, hdL = abst ? 'low' : lb.headline;
    const dS = typeof o.dS === 'number' ? Math.abs(o.dS) : null, cov = (dS !== null && typeof lb.sErr === 'number') ? dS <= 2 * lb.sErr : null;
    ks[ksL].push({ y: abst ? false : !!o.ksRight, g: c.g, dS, cov });
    hd[hdL].push({ y: abst ? false : !!o.fullyRight, g: c.g, dS, cov, k: !!o.kRight, s: !!o.sRight, m: !!o.modelRight, strict: abst ? false : !!o.strict });
  });
  return { ks, hd };
}
function rowStats(items, yKey) {
  const n = items.length, k = items.filter((x) => x[yKey || 'y']).length, w = wilson(k, n);
  const ds = items.map((x) => x.dS).filter((v) => v !== null), cv = items.map((x) => x.cov).filter((v) => v !== null);
  return { n, rate: w.rate, lo: w.lo, hi: w.hi, medAbsDS: quantile(ds, 0.5), cover2: cv.length ? cv.filter(Boolean).length / cv.length : null };
}
function checkTargets(T) {
  const fails = [];
  [['k/S', T.ks], ['headline', T.hd]].forEach(([name, tb]) => {
    const h = rowStats(tb.high), m = rowStats(tb.medium), l = rowStats(tb.low);
    if (h.n && (h.rate < TARGETS.highRate || h.lo < TARGETS.highLo)) fails.push(name + ' high');
    if (m.n && (m.rate < TARGETS.medRate || m.lo < TARGETS.medLo)) fails.push(name + ' medium');
    if (l.n && m.n && l.rate > m.rate - TARGETS.lowGap) fails.push(name + ' low gap');
    [h, m].forEach((x, i) => { if (x.n && x.cover2 !== null && x.cover2 < TARGETS.cover) fails.push(name + ' cover ' + LABELS[i]); });
  });
  return fails;
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
  return {
    n: seqs.length, falseAlarmDelta: constant.length ? fa / constant.length : null, falseAlarmAbs: constant.length ? faAbs / constant.length : null,
    delayMedian: quantile(delays, 0.5), delayMedianShort: quantile(delaysShort, 0.5), onsetWithin1: onsetN ? onsetOk / onsetN : null, senCover: senN ? senOk / senN : null,
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
function objective(cases, labels) {   // share labelled high (headline), −Infinity when a constraint fails
  const T = tables(cases, labels);
  if (checkTargets(T).length) return -Infinity;
  const fr = falseRivalRate(cases, labels);
  if (fr.rate !== null && fr.rate > TARGETS.falseRival) return -Infinity;
  return T.hd.high.length / Math.max(1, cases.length);
}
function searchThresholds(cases, env, sample) {
  let th = Object.assign({}, PRE_THRESHOLDS), best = -Infinity;
  const evalSet = (cand) => objective(cases, cases.map((c) => relabel(c, cand, env)));
  const stage = (grid) => {
    combos(grid).forEach((cmb, i) => {
      if (sample > 1 && i % sample) return;
      const cand = Object.assign({}, th, cmb), v = evalSet(cand);
      if (v > best) { best = v; th = cand; }
    });
  };
  stage(GRID_STAGE1); stage(GRID_STAGE2); stage(GRID_STAGE1);
  if (best === -Infinity) {   // constraints unmet everywhere: the strictest set (never relaxed targets)
    th = Object.assign({}, PRE_THRESHOLDS, { snrHigh: 30, sErrHigh: 0.3, fairSpanHigh: 1.0, pointSkinSpread: 0.2, sErrLow: 0.8, snrLow: 8, disagreeDS: 0.7, disagreeKPct: 10, reachFactor: 5.0, kHeldRmsK: 2 });
  }
  return { th, best };
}
function calibrate(lines, env, opts) {
  const cases = labelledSet(lines), K = 5, fold = foldsOf(cases, K), oof = new Array(cases.length);
  console.log('[validate] calibration: ' + cases.length + ' labelled build-ups, ' + new Set(cases.map((c) => c.g)).size + ' wells, 5 folds');
  for (let f = 0; f < K; f++) {
    const train = cases.filter((_, i) => fold[i] !== f);
    const { th } = searchThresholds(train, env, opts.gridSample);
    cases.forEach((c, i) => { if (fold[i] === f) oof[i] = relabel(c, th, env); });
    console.log('[validate]   fold ' + (f + 1) + '/5 done');
  }
  const final = searchThresholds(cases, env, opts.gridSample).th;
  // delta-alert form from the sequence false-alarm rate (plain unless it misses 5 %)
  const seqPlain = sequenceMetrics(lines, 'plain'), seqBase = sequenceMetrics(lines, 'basevar');
  final.deltaForm = (seqPlain.falseAlarmDelta !== null && seqPlain.falseAlarmDelta > TARGETS.falseAlarm && seqBase.falseAlarmDelta !== null &&
                     seqBase.falseAlarmDelta <= TARGETS.falseAlarm) ? 'basevar' : 'plain';
  const seqM = final.deltaForm === 'basevar' ? seqBase : seqPlain;
  const T = tables(cases, oof);
  const rng = env.SY.rng;
  const ksRow = (L, items) => { const s = rowStats(items); const cb = clusterBootstrap(items, rng); return { label: L, n: s.n, right: s.rate, lo: s.lo, hi: s.hi, loCluster: cb.lo, hiCluster: cb.hi, medAbsDS: s.medAbsDS, cover2: s.cover2 }; };
  const tbRow = (L, items, yKey) => {
    const s = rowStats(items, yKey); const cb = clusterBootstrap(items.map((x) => ({ g: x.g, y: x[yKey || 'y'] })), rng);
    const fr = (k) => (items.length ? items.filter((x) => x[k]).length / items.length : null);
    return { label: L, n: s.n, fullyRight: s.rate, lo: s.lo, hi: s.hi, loCluster: cb.lo, hiCluster: cb.hi, kRight: fr('k'), sRight: fr('s'), modelRight: fr('m'), medAbsDS: s.medAbsDS, cover2: s.cover2 };
  };
  const sub = (pred) => { const idx = cases.map((c, i) => (pred(c, i) ? i : -1)).filter((i) => i >= 0); return tables(idx.map((i) => cases[i]), idx.map((i) => oof[i])); };
  const Tk = sub((c) => c.test && c.test.result && c.test.result.kHeld), Tg = sub((c) => c.fluid === 'gas');
  // Brier with the out-of-fold headline rates as forecasts; Murphy decomposition
  const rateOf = {}; LABELS.forEach((L) => { rateOf[L] = rowStats(T.hd[L]).rate; });
  let bs = 0, N = 0; const bins = {};
  LABELS.forEach((L) => T.hd[L].forEach((x) => { const p = rateOf[L] || 0, y = x.y ? 1 : 0; bs += (p - y) * (p - y); N++; bins[L] = bins[L] || { n: 0, y: 0, p }; bins[L].n++; bins[L].y += y; }));
  const ybar = N ? LABELS.reduce((a, L) => a + (bins[L] ? bins[L].y : 0), 0) / N : 0;
  let rel = 0, res = 0;
  Object.keys(bins).forEach((L) => { const b = bins[L], yk = b.y / b.n; rel += b.n * (b.p - yk) * (b.p - yk); res += b.n * (yk - ybar) * (yk - ybar); });
  const unc = ybar * (1 - ybar), brier = N ? bs / N : null;
  const env5 = (vals) => [quantile(vals, 0.05), quantile(vals, 0.95)];
  const ev = cases.map((c) => c.evidence).filter(Boolean);
  const rateErr = cases.map((c) => (c.outcome && typeof c.outcome.rateErrPct === 'number' ? Math.abs(c.outcome.rateErrPct) : null)).filter((v) => v !== null);
  const dist = cases.filter((c) => c.truth && c.truth.distractor && c.truth.visible && c.truth.visible.distractor);
  const fr = falseRivalRate(cases, oof);
  const cal = {
    version: 'cal-1', calibrated: true, generated: todayUTC(), app: 'v3.3', engine: (env.AI && env.AI.version) || '1.0',
    seeds: { single: SINGLE.slice(), sequences: SEQ.slice(), master: MASTER },
    nCases: lines.filter((l) => l.kind === 'single' && !l.error).length, nBuildups: cases.length,
    thresholds: final,
    ksTable: LABELS.map((L) => ksRow(L, T.ks[L])), table: LABELS.map((L) => tbRow(L, T.hd[L])), strict: LABELS.map((L) => tbRow(L, T.hd[L], 'strict')),
    kHeldTable: ['medium', 'low'].map((L) => ksRow(L, Tk.ks[L])), gasTable: LABELS.map((L) => tbRow(L, Tg.hd[L])),
    brier, bss: (brier !== null && unc > 0) ? 1 - brier / unc : null, reliability: N ? rel / N : null, resolution: N ? res / N : null, uncertainty: unc, falseRival: fr.rate,
    abstain: abstention(cases), distractorCaught: { n: dist.length, rate: dist.length ? dist.filter((c) => c.outcome && c.outcome.distractorCaught).length / dist.length : null },
    rateAccuracy: { medAbsPct: quantile(rateErr, 0.5), p90AbsPct: quantile(rateErr, 0.9) },
    envelope: {
      CD: env5(cases.map((c) => c.truth && c.truth.Cd)), S: env5(cases.map((c) => c.truth && c.truth.SStar)), tDCDend: env5(cases.map((c) => c.truth && c.truth.tDCDend)),
      snrD: env5(ev.map((e) => e.snrD)), k: env5(cases.map((c) => c.truth && c.truth.kStar)), dtEnd_h: env5(cases.map((c) => c.truth && c.truth.dtEnd_h)),
    },
    sequences: { falseAlarmDelta: seqM.falseAlarmDelta, falseAlarmAbs: seqM.falseAlarmAbs, delayMedian: seqM.delayMedian, delayMedianShort: seqM.delayMedianShort,
                 onsetWithin1: seqM.onsetWithin1, senCover: seqM.senCover },
    inApp: [],
  };
  return { cal, cases, oof, T, seqPlain, seqBase };
}
// Normalised distance of a case's evidence to the nearest label threshold (§5.6 margin).
function marginOf(ev, th) {
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
function chooseInApp(liteLines, th, env) {
  const byStratum = new Map();
  liteLines.filter((l) => !l.error && l.kind === 'single').forEach((l) => {
    const c = labelledSet([l])[0]; if (!c) return;
    const lb = relabel(c, th, env), margin = marginOf(l.evidence, th);
    const item = { seed: l.seed, stratum: l.stratum, margin, expect: { status: l.outcome ? l.outcome.status : null, ks: lb.ks, headline: lb.headline,
                   fullyRight: lb.outcome ? !!lb.outcome.fullyRight : null } };
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
  const out = { cases: singles.length, errors: singles.filter((l) => l.error).length, perStratum: per, timings, sequences: null, falseRival: null,
                cWithin25: { n: cU.length, rate: cU.length ? cOk / cU.length : null }, byRateSource: bySource };
  if (lines.some((l) => l.kind === 'sequence')) out.sequences = { plain: sequenceMetrics(lines, 'plain'), basevar: sequenceMetrics(lines, 'basevar') };
  if (quickFR) {
    const fl = quickFR.filter((l) => !l.error);
    const k = fl.filter((l) => l.test && l.test.result && l.test.result.chosen && l.test.result.chosen.label !== 'Homogeneous').length;
    out.falseRival = { n: fl.length, rivals: k, rate: fl.length ? k / fl.length : null, target: TARGETS.falseRival };
  }
  return out;
}
function pct(v) { return v === null || v === undefined ? '—' : (100 * v).toFixed(1) + ' %'; }
function f2(v) { return v === null || v === undefined ? '—' : (+v).toFixed(2); }
function markdown(cal, summary) {
  const L = ['# Build-up Surveillance — calibration report', '', 'Generated ' + cal.generated + ' by buildup-validate.js (engine ' + cal.engine + ', app ' + cal.app + ').', ''];
  L.push('## Thresholds', '', '| key | value |', '|---|---|');
  Object.keys(cal.thresholds).sort().forEach((k) => L.push('| ' + k + ' | ' + cal.thresholds[k] + ' |'));
  const tbl = (title, rows, yKey) => {
    L.push('', '## ' + title, '', '| label | n | rate | Wilson 95 % | cluster 95 % | median abs ΔS | cover 2·S_err |', '|---|---|---|---|---|---|---|');
    rows.forEach((r) => L.push('| ' + r.label + ' | ' + r.n + ' | ' + pct(r[yKey]) + ' | ' + pct(r.lo) + '–' + pct(r.hi) + ' | ' + pct(r.loCluster) + '–' + pct(r.hiCluster) + ' | ' + f2(r.medAbsDS) + ' | ' + pct(r.cover2) + ' |'));
  };
  tbl('k/S label (k and S right)', cal.ksTable, 'right'); tbl('Headline label (fully right)', cal.table, 'fullyRight'); tbl('Strict (k ±5 %, S ±0.3)', cal.strict, 'fullyRight');
  tbl('k-held sub-table', cal.kHeldTable, 'right'); tbl('Gas sub-table', cal.gasTable, 'fullyRight');
  L.push('', '## Scores', '', '- Brier ' + f2(cal.brier) + ', BSS ' + f2(cal.bss) + ' (reliability ' + f2(cal.reliability) + ', resolution ' + f2(cal.resolution) + ', uncertainty ' + f2(cal.uncertainty) + ')',
    '- False-rival rate on homogeneous truth ' + pct(cal.falseRival), '- Abstention ' + pct(cal.abstain.rate) + ' (hom ' + pct(cal.abstain.rateHom) + ')',
    '- Distractor caught ' + pct(cal.distractorCaught.rate) + ' of ' + cal.distractorCaught.n, '- Rate accuracy: median |error| ' + f2(cal.rateAccuracy.medAbsPct) + ' %, P90 ' + f2(cal.rateAccuracy.p90AbsPct) + ' %');
  L.push('', '## Sequences', '', '- Delta form shipped: ' + cal.thresholds.deltaForm, '- False alarms: delta ' + pct(cal.sequences.falseAlarmDelta) + ', absolute ' + pct(cal.sequences.falseAlarmAbs),
    '- Median confirmed-alert delay ' + f2(cal.sequences.delayMedian) + ' tests (24–48 h wells ' + f2(cal.sequences.delayMedianShort) + ')',
    '- Onset within one interval ' + pct(cal.sequences.onsetWithin1) + '; Sen CI covering the true slope ' + pct(cal.sequences.senCover));
  L.push('', '## Other figures', '', '- C within ±25 % when the unit slope was sampled: ' + pct(summary.cWithin25 ? summary.cWithin25.rate : null) + ' of ' + (summary.cWithin25 ? summary.cWithin25.n : 0));
  Object.keys(summary.byRateSource || {}).forEach((k) => { const b = summary.byRateSource[k]; L.push('- Rate source ' + k + ': ' + b.n + ' cases, fully right ' + b.fullyRight + ', k/S right ' + b.ksRight); });
  L.push('', '## Per stratum', '', '| stratum | n | errors | fully right | k/S right | abstained | high / medium / low | gen ms | analyse ms |', '|---|---|---|---|---|---|---|---|---|');
  Object.keys(summary.perStratum).forEach((s) => { const p = summary.perStratum[s]; L.push('| ' + s + ' | ' + p.n + ' | ' + p.errors + ' | ' + p.fullyRight + ' | ' + p.ksRight + ' | ' + p.abstained + ' | ' + (p.high || 0) + ' / ' + (p.medium || 0) + ' / ' + (p.low || 0) + ' | ' + f2(p.gen_ms) + ' | ' + f2(p.analyse_ms) + ' |'); });
  L.push('', '## In-app cases (24, lite settings)', '', '| seed | stratum | status | k/S | headline | fully right | margin |', '|---|---|---|---|---|---|---|');
  cal.inApp.forEach((c) => L.push('| ' + c.seed + ' | ' + c.stratum + ' | ' + c.expect.status + ' | ' + c.expect.ks + ' | ' + c.expect.headline + ' | ' + c.expect.fullyRight + ' | ' + c.margin + ' |'));
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
  return rows;
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
    if (flag('--write')) {
      const cand = [];
      SY.SEED_TABLE.forEach((e) => { for (let i = 0; i < Math.min(e.n, 6); i++) cand.push(e.from + Math.floor(i * e.n / 6)); });
      IN_APP_PROVISIONAL.forEach(([s]) => { if (!cand.includes(s)) cand.push(s); });
      liteLines = await runItems(cand.map((seed) => ({ kind: 'single', seed })), { lite: true }, nWorkers, null);
    }
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
  if (flag('--write')) {
    const res = calibrate(lines, env, opts);
    res.cal.inApp = chooseInApp(liteLines, res.cal.thresholds, env);
    if (res.cal.inApp.length < 24) fails.push('only ' + res.cal.inApp.length + ' in-app cases with margin ≥ 0.1');
    checkTargets(res.T).forEach((f) => fails.push('calibration: ' + f));
    writeCal(res.cal);
    fs.writeFileSync(path.join(out, 'calibration.md'), markdown(res.cal, summary));
    summary.calibration = { thresholds: res.cal.thresholds, falseRival: res.cal.falseRival, sequences: res.cal.sequences };
    console.log('[validate] wrote ' + path.relative(process.cwd(), CAL_FILE) + ' and ' + path.join(out, 'calibration.md'));
  }
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('[validate] ' + summary.cases + ' cases, ' + summary.errors + ' errors, median per case ' + Math.round(summary.timings.perCaseMedian_ms || 0) + ' ms ' +
              '(generation ' + Math.round(summary.timings.genMedian_ms || 0) + ', analysis ' + Math.round(summary.timings.analyseMedian_ms || 0) + '), elapsed ' + summary.elapsed_s + ' s');
  Object.keys(summary.perStratum).forEach((s) => { const p = summary.perStratum[s]; console.log('  ' + s.padEnd(10) + ' n ' + String(p.n).padStart(3) + '  fully right ' + String(p.fullyRight).padStart(3) + '  k/S right ' + String(p.ksRight).padStart(3) + '  abstained ' + p.abstained + (p.errors ? '  errors ' + p.errors : '')); });
  if (summary.falseRival) console.log('  false-rival check: ' + summary.falseRival.rivals + ' of ' + summary.falseRival.n + ' homogeneous cases chose a rival (' + pct(summary.falseRival.rate) + ', target ≤ 5 %)');
  if (summary.sequences) console.log('  sequences: delta false alarms ' + pct(summary.sequences.plain.falseAlarmDelta) + ' (plain) / ' + pct(summary.sequences.basevar.falseAlarmDelta) + ' (basevar)');
  if (asJson) console.log(JSON.stringify(summary, null, 2));
  if (fails.length) console.log('[validate] targets missed: ' + fails.join('; '));
  return strict && fails.length ? 1 : 0;
}

module.exports = { PRE_THRESHOLDS, GRID_STAGE1, GRID_STAGE2, TARGETS, IN_APP_PROVISIONAL, placeholderCal, calSource, writeCal, parseSeeds, wilson, quantile,
                   clusterBootstrap, marginOf, sequenceMetrics, labelledSet, foldsOf, combos, calibrate, chooseInApp, summarize, markdown, relabel, CAL_FILE };

if (require.main === module) {
  if (IS_WORKER) workerMain();
  else main().then((code) => process.exit(code), (e) => { console.error('[validate] crash: ' + (e && e.stack || e)); process.exit(2); });
}
