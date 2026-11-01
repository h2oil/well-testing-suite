// Build-up Surveillance — WP5 review tests (docs/BUILDUP-SURVEILLANCE-PLAN.md §3.10, §7, §8, §9 WP5).
//
//   RV1   evidence index holds every id the report uses; every report statement cites at least one id
//   RV2   each rule V1–V27 fires on a crafted variant of FIX.analysis with the right severity and where; the
//         re-derivation rules V23–V27 reference none of PRiSM_autoInterp, WTS_buildup.run or WTS_buildup.trend
//   RV3   a tampered quoted number → V14 critical, acceptable:false; canSign fails even with every decision recorded
//   RV4   Q&A: 19 sample questions + 3 paraphrases per intent → intent, evidence ids, numbers equal to the analysis;
//         what-if h +20 % → k −16.7 %, S +0.091; "compare B2 and B5" finds both; out of scope → help, no numbers
//   RV5   a failing answer is marked on the answer and adds no review finding
//   RV6   SHA-256 vectors ('' and 'abc', plus Node crypto cross-checks); the hashes use canon/hash16 from file 53
//   RV7   sign-off blocked with open majors; DRAFT → SIGNED → CHANGED after a result edit; same-input re-run stays
//         SIGNED; a different app version stays SIGNED with the info line
//   RV8   AI export: no well, engineer or file name, no reason text, no dates, no URL; includeFreeText adds the reasons
//   RV9   report limits: notes ≤ 600, verdicts < 300, tables ≤ 30 rows (40 tests → 30 rows + "10 older tests"),
//         S9 grouped by rule, no "null"/"undefined" text
//   RV10  every ReportModel number is a Value with a ref; check() uses v, not text (imperial = metric result)
//   RV11  with a metric formatter, report, finding and answer text contains no psi, ft or STB
//   RV12  review.FORMULAS agrees with the shapes FORMULAS on FIX.analysis
//   RV13  the audit chain verifies; folding beyond 500 entries keeps the chain; a 7th-digit edit breaks it
//   RV14  the evidence check uses full-precision stored values (no false V14 from display rounding)
//   RV15  a stored derived number (m, m′, Δp_skin, r_inv, cycles, S_abs, sensitivity rows, T7, T8) that disagrees with FORMULAS
//         raises V14 from run() and from report(); the page and the report show the stored number
// Also: RV4 no-result excluded test, mech questions naming a test, the what-if over every used test; RV7 a stale review cannot be
// signed, a V14 after sign-off reads CHANGED, unknown decision codes are ignored; RV9 S9 without a review, S3 Note column.
// Crafted variants go through refresh(), which recomputes the derived numbers an engine stores, so they stay consistent.
//
// The module is pure, so most tests evaluate prism-build/49-calc-buildup-review.js (with file 53 for canon/hash16)
// in a bare vm context, self-tests stripped exactly as the build strips them. RV6 also checks the app build.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const S = require('./_buildup-shapes');

const WP = 'BU5';
const PB = path.join(__dirname, '..');
const FILE = '49-calc-buildup-review.js';
const SRC = fs.readFileSync(path.join(PB, FILE), 'utf8');
const { stripSelfTest } = require(path.join(PB, 'concat-round8.js'));
const QUIET = { log() {}, warn() {} };

function load(o) {
  o = o || {};
  const ctx = { console: { log() {}, warn() {}, error: (...a) => console.error(...a) } };
  ctx.window = ctx;
  if (o.cal) ctx.PRiSM_autoInterpCal = o.cal;
  vm.createContext(ctx);
  (o.no53 ? [FILE] : ['53-prism-autointerp.js', FILE]).forEach((f) => {
    vm.runInContext(stripSelfTest(fs.readFileSync(path.join(PB, f), 'utf8'), f, QUIET), ctx, { filename: f });
  });
  if (ctx.WTS_buildup_review_selfTest !== undefined) throw new Error('the review self-test was not stripped');
  return { R: ctx.WTS_buildup.review, ctx };
}
let _main = null;
const R0 = () => (_main || (_main = load())).R;
const plain = (o) => JSON.parse(JSON.stringify(o));      // cross-realm objects → main-realm plain data
const clone = (o) => JSON.parse(JSON.stringify(o));
const AT = '2026-07-02T11:00:00Z';

// formatters: imperial (the field units the engines use) and metric (as the units layer would convert)
const IMP = { pressure: 'psi', permeability: 'md', permThickness: 'md·ft', length: 'ft', liquidRate: 'STB/d', gasRateSmall: 'Mscf/d', volume: 'STB', wbStorage: 'bbl/psi',
              productivityIndex: 'STB/d/psi', gasPI: 'Mscf/d/psi', pressurePerDay: 'psi/d', viscosity: 'cp', compressibility: '1/psi' };
const MET = { pressure: ['kPa', 6.894757], permeability: ['mD', 1], permThickness: ['mD·m', 0.3048], length: ['m', 0.3048], liquidRate: ['m³/d', 0.158987],
              gasRateSmall: ['m³/d', 28.3168], volume: ['m³', 0.158987], wbStorage: ['m³/kPa', 0.0230592], productivityIndex: ['m³/d/kPa', 0.0230592],
              gasPI: ['Sm³/d/kPa', 4.10697], pressurePerDay: ['kPa/d', 6.894757], viscosity: ['mPa·s', 1], compressibility: ['1/kPa', 0.145038] };
const imp = (v, cat, dp) => v.toFixed(dp) + (IMP[cat] ? ' ' + IMP[cat] : '');
imp.unit = (cat) => IMP[cat] || '';
const met = (v, cat, dp) => { const m = MET[cat]; return m ? (v * m[1]).toFixed(dp) + ' ' + m[0] : v.toFixed(dp); };
met.unit = (cat) => (MET[cat] ? MET[cat][0] : '');
const BANNED = /\b(null|undefined|NaN|Infinity)\b|\[object Object\]/;
const IMPERIAL_UNITS = /\bpsia?\b|\bft\b|\bSTB\b|\bbbl\b|\bmd\b/;

// crafted variants of FIX.analysis, one per rule (V5 fires on the fixture itself; V14 comes from tampering)
const INTERP = [0, 1, 2, 4, 5];   // tests[] indexes of the interpreted tests (B4 = tests[3] is excluded)
const CASES = {
  V1: (a) => { const r = a.trend.bubble.rows.find((x) => x.id === 'B6'); Object.assign(r, { level: 'major', pwfSand_lo: 2400, pwfSand_hi: 2450, margin: -50 }); },
  V2: (a) => { a.tests[5].pExtDatum = 2400; },
  V3: (a) => { a.well.fluid = 'gas'; a.trend.rateSkin = { resolved: false, S: null, D: null, seD: null, reason: 'Not resolved: the test rates are too close.', dqEffect: 0.8, ev: ['T15'] }; },
  V4: (a) => { a.rates.phaseBasis.wcMax = 0.12; },
  V5: () => {},
  V6: (a) => { a.trend.kStability.cv = 0.09; },
  V7: (a) => { Object.assign(a.tests[5].spec.rateQC, { r3Status: 'fail', r3: 1.31 }); },
  V8: (a) => { a.trend.baseline.unstable = true; },
  V9: (a) => { INTERP.forEach((i) => { Object.assign(a.tests[i].result.reach, { fair_h: 1000, good_h: 3000, fairShut_h: 1200, goodShut_h: 3500, reachable: true }); }); },
  V10: (a) => { a.tests[0].result.quality.rTide = 0.2; },
  V11: (a) => { a.trend.piCheck.rows[0].RJ = 1.6; },
  V12: (a) => { a.trend.bubble.spearman = 0.85; },
  V13: (a) => { a.well.defaulted = ['h']; },
  V15: (a) => { a.tests[0].spec.history.estimated = true; a.tests[0].result.history = { estimated: true, dDerivPct: 2.6, sensitive: true, ev: ['R5'] }; },
  V16: (a) => { a.rates.offsetScan = { current_h: 0, best_h: 6, better: true, improvement: 0.62 }; },
  V17: (a) => { a.tests[1].partialSuspect = true; },
  V18: (a) => { Object.assign(a.tests[2].result.chosen, { key: 'closedCircle', label: 'Closed circle' }); a.trend.pTrend.depletion = false; },
  V19: (a) => { a.tests[2].result.background.boundaryDepends = true; },
  V20: (a) => { a.trend.crossTest.windowLevelInconsistent = ['B2']; },
  V21: (a) => { a.tests[0].result.confidence.outsideCalibration = true; },
  V22: (a) => { a.overrides.push({ id: 'O2', kind: 'window', target: 'B6', value: { dt0_h: 20, dt1_h: 70 }, reason: 'Window moved past the storage hump.', who: 'Engineer A', at: '2026-06-25T08:00:00Z', appVersion: '3.3' }); a.tests[5].overrides = ['O2']; },
  V23: (a) => { a.tests[0].result.final.k = 60; },
  V24: (a) => { a.tests[0].result.final.S = 3.0; },
  V25: (a) => { a.tests[0].spec.Dq = 1100; },
  V26: (a) => { const r = a.tests[2].result, hom = r.bic.rows[0]; r.bic.rows.push({ key: 'linearBoundary', bic: hom.bic - 15, dBicHom: -15, p: 4, eligible: true, why: [] }); },
  V27: (a) => { Object.assign(a.trend.alerts.delta, { status: 'provisional', confirmedAt: null }); },
};
// plan §7.2: severity and where
const PLAN_RULES = {
  V1: ['major', 'S5'], V2: ['critical', 'S5'], V3: ['major', 'S5'], V4: ['major', 'S3'], V5: ['suggestion', 'S7'], V6: ['major', 'S5'], V7: ['critical', 'S3'],
  V8: ['major', 'S5'], V9: ['suggestion', 'S7'], V10: ['minor', 'S2'], V11: ['major', 'S5'], V12: ['major', 'S5'], V13: ['minor', 'S6'], V14: ['critical', 'any'],
  V15: ['major', 'S4'], V16: ['major', 'S3'], V17: ['major', 'S4'], V18: ['minor', 'S4'], V19: ['major', 'S4'], V20: ['major', 'S4'], V21: ['minor', 'S12'],
  V22: ['minor', 'S10'], V23: ['major', 'S4'], V24: ['major', 'S4'], V25: ['major', 'S3'], V26: ['major', 'S4'], V27: ['major', 'S5'],
};
// Recompute the derived numbers an engine stores (final kh, m, m′, Δp_skin, r_inv, T7, oil T8) after a crafted edit, so a variant
// stays engine-consistent: the evidence check recomputes them and would otherwise (rightly) raise V14.
function refresh(a) {
  const F = S.FORMULAS, w = a.well;
  a.tests.forEach((t) => {
    const r = t.result; if (!r || !r.final) return;
    const f = r.final, sw = t.spec.well, ev = r.evidence || {};
    f.kh = f.k * sw.h; f.m = F.m(t.spec.Dq, sw.B, sw.mu, f.k, sw.h); f.mPrime = F.mPrime(f.m); f.dpSkin_psi = F.dpSkin(f.m, f.S);
    f.rinv_ft = F.rinv(f.k, ev.dtEnd_h != null ? ev.dtEnd_h : t.dtEnd_h, sw.phi, sw.mu, sw.ct);
    if (ev.dteEnd_h != null) f.rinvE_ft = F.rinv(f.k, ev.dteEnd_h, sw.phi, sw.mu, sw.ct);
  });
  const tr = a.trend; if (!tr) return a;
  (tr.skinDp || []).forEach((row) => { const t = a.tests.find((x) => x.id === row.id); if (t && t.result) row.dpSkin_psi = t.result.final.dpSkin_psi; });
  const L = [...a.tests].reverse().find((t) => t.result && t.used && t.used.trend), pi = tr.pi, Sb = tr.baseline && tr.baseline.S;
  if (pi && L && !pi.guard && a.well.fluid === 'oil') {
    const Sn = L.result.final.S;
    Object.assign(pi, { ratioNow: F.piRatio(pi.X, Sn), ratioBase: F.piRatio(pi.X, Sb), rateAtStake: F.rateAtStake(L.Dq, pi.X, Sn, Sb), extraDrawdown_psi: F.extraDrawdown(L.Dq, w.B, w.mu, Sn - Sb, L.result.final.k, w.h) });
  }
  return a;
}
const variant = (...rules) => { const a = S.FIX.analysis; rules.forEach((r) => CASES[r](a)); return refresh(a); };
// one analysis with many findings at once (S9 grouping, limits, metric text)
const MANY = ['V1', 'V4', 'V6', 'V7', 'V8', 'V10', 'V11', 'V13', 'V15', 'V16', 'V17', 'V19', 'V20', 'V21', 'V22', 'V26', 'V27'];
function manyVariant() { const a = variant(...MANY); a.tests[1].result.quality.rDrift = 0.09; return a; }
// 40 tests: B7…B40 cloned from B3 (later dates), with their events and trend rows. The clones are interpreted but not used for the
// trend, so the stored trend (baseline, alerts, T8 from B6) stays consistent with the tests.
function fortyTests() {
  const a = S.FIX.analysis, src = a.tests[2], ev = a.events.find((e) => e.id === src.eventId), ser = a.trend.series.find((s) => s.id === 'B3');
  const last = a.tests[a.tests.length - 1].tc_ms, unused = () => ({ baseline: false, trend: false, alert: false });
  for (let n = 7; n <= 40; n++) {
    const t = clone(src), id = 'B' + n, eid = 'E' + (n + 10), tc = last + (n - 6) * 10 * 86400000;
    t.id = id; t.eventId = eid; t.tc_ms = tc; t.date = new Date(tc).toISOString().slice(0, 10); t.result.id = id; t.spec.id = id; t.used = unused();
    a.tests.push(t);
    const e = clone(ev); e.id = eid; e.tc_ms = tc; e.tEnd_ms = tc + 240 * 3600000; a.events.push(e);
    const s = clone(ser); s.id = id; s.tDays = (tc - a.tests[0].tc_ms) / 86400000; s.used = unused(); a.trend.series.push(s);
  }
  return a;
}
// File-level lazy cache (read-only use): the three report cases are built once and shared by RV1, RV9 and RV10.
let _calCtx = null;
const Rcal = () => (_calCtx || (_calCtx = load({ cal: S.FIX.cal }))).R;
const _cases = {};
function prepared(label) {
  if (_cases[label]) return _cases[label];
  const R = Rcal(), an = label === 'FIX' ? S.FIX.analysis : label === 'many findings' ? manyVariant() : fortyTests();
  const idx = R.evidence(an), rv = R.run(an, idx, { at: AT }), model = R.report(an, rv, null, null, imp);
  return (_cases[label] = { label, an, idx, rv, model });
}
const CASE_LABELS = ['FIX', 'many findings', '40 tests'];
// walk every block of a model
function blocksOf(model) { const out = []; model.sections.forEach((s) => s.blocks.forEach((b) => out.push([s.id, b]))); out.push(['repro', model.reproducibility]); return out; }
function textsOf(R, model, fmt) {
  const out = [];
  blocksOf(model).forEach(([sid, b]) => {
    if (b.kind === 'verdict' || b.kind === 'notes') out.push([sid, b.kind, R.fill(b.template, b.values, fmt)]);
    if (b.kind === 'kv') b.rows.forEach((r) => out.push([sid, 'kv', r.label + ': ' + (r.value && typeof r.value.template === 'string' ? R.fill(r.value.template, r.value.values, fmt) : R.fmtValue(r.value, fmt))]));
    if (b.kind === 'kpi') b.items.forEach((it) => out.push([sid, 'kpi', it.label + ': ' + R.fmtValue(it.value, fmt)]));
    if (b.kind === 'table') { out.push([sid, 'head', b.head.map((h) => R.headText(h, fmt)).join(' | ')]); b.rows.forEach((r) => out.push([sid, 'cell', r.map((c) => (typeof c === 'string' ? c : R.fmtValue(c, fmt))).join(' | ')])); }
  });
  return out;
}
const isValue = (o) => o && typeof o === 'object' && typeof o.ref === 'string' && typeof o.dp === 'number' && 'v' in o;
function valuesIn(o, acc) {
  acc = acc || [];
  if (Array.isArray(o)) o.forEach((x) => valuesIn(x, acc));
  else if (o && typeof o === 'object') { if (isValue(o)) acc.push(o); else Object.keys(o).forEach((k) => { if (k !== 'check') valuesIn(o[k], acc); }); }
  return acc;
}

// Q&A corpus: the plan's sample question first, then three paraphrases (the help row: out-of-scope questions)
const QA = {
  why_model: ['why this model?', 'Why was homogeneous chosen for B3?', 'Explain the model choice', 'Which model fits B6 and why?'],
  why_conf: ['why is confidence medium?', 'What limits the confidence label of B5?', 'Why is B2 not labelled high?', 'How reliable is the result for B6?'],
  whatif_input: ['what if h is 20 % higher?', 'What happens if porosity is 10% lower?', 'Suppose the viscosity were 15 % higher', 'If the rate is 10% lower, how do k and skin change?'],
  onset: ['when did skin start rising?', 'When did the skin increase begin?', 'What is the onset date of the damage?', 'Since when has the skin been going up?'],
  alert: ['is there an alert?', 'Has a skin alarm been raised?', 'Which alerts are active?', 'Is the absolute skin threshold exceeded?'],
  value: ['what is k for B3?', 'What is the skin of B6?', 'Give me the permeability of test 2', 'Show the results for build-up 1'],
  compare: ['compare B2 and B5', 'How does B6 differ from B1?', 'B3 versus B4', 'What changed between test 1 and test 6?'],
  excluded: ['why was B4 excluded?', 'Why is B4 not used?', 'Which tests were left out of the trend?', 'What was excluded and why?'],
  shutin_length: ['how long should the shut-in be?', 'What shut-in duration do we need?', 'How many hours should the well be shut in?', 'Is a longer build-up needed?'],
  stake: ['how much production is at stake?', 'How much oil are we losing to skin?', 'What is the production loss from the damage?', 'How many barrels per day could stimulation recover?'],
  kstable: ['is k stable?', 'Is the permeability changing between tests?', 'Does k drift over time?', 'How constant is the permeability?'],
  serr: ['why is the skin uncertainty large?', 'What drives the error on S for B5?', 'How accurate is the skin of B6?', 'Why is S_err so big?'],
  line_vs_match: ['why do line and match disagree for B6?', 'Does the straight line agree with the type-curve match?', 'Why is the semilog skin different from the matched skin?', 'Line versus match for B3'],
  bubble: ['is pwf below the bubble point?', 'Is the flowing pressure under Pb?', 'Are we producing below the saturation pressure?', 'Could gas be coming out of solution near the well?'],
  forecast: ['when will skin cross 5?', 'When will the skin reach the alert threshold?', 'Predict when the skin exceeds the limit', 'What is the skin forecast?'],
  mech: ['what is the mechanical skin?', 'How much of the skin is damage?', 'What is the pseudo-skin from partial penetration?', 'Split the skin into mechanical and geometric parts'],
  depletion: ['is the reservoir depleting?', 'Is the reservoir pressure falling?', 'What is the trend of p*?', 'Is there depletion in the extrapolated pressure?'],
  missed: ['could we have missed shut-ins?', 'Were any shut-ins not detected?', 'Are there shut-ins that were too short to analyse?', 'Did the detection miss events?'],
  help: ['tell me a joke', 'What is the weather tomorrow?', 'Who won the football game?', 'Translate hello into French'],
};
// evidence each intent must cite (exact ids, or a /regex/ one id must match)
const QA_EV = {
  why_model: [/·M4$/, /·M6$/], why_conf: [/·K1$/], whatif_input: ['U2'], onset: ['T4'], alert: ['T2', 'T3', 'T16'], value: [/·A2$/], compare: ['T11'],
  excluded: [/^(D1|B4·A2)$/], shutin_length: ['W4'], stake: ['T8'], kstable: ['T9'], serr: [/·U1$/], line_vs_match: [/·A1$/], bubble: ['T12'], forecast: ['T6'],
  mech: ['T14'], depletion: ['T10'], missed: ['D1'], help: ['D1'],
};

module.exports = [
  {
    name: 'RV1 the evidence index has every id the report uses; every report statement cites at least one id',
    wp: WP,
    opts: false,
    run(app, assert) {
      CASE_LABELS.forEach((label) => {
        const { idx, rv, model } = prepared(label);
        const sh = S.checkShape('EvidenceIndex', plain(idx));
        assert(sh.ok, label + ': EvidenceIndex shape: ' + JSON.stringify(sh.errors.slice(0, 4)));
        assert.strictEqual(idx.order.length, Object.keys(idx.items).length, label + ': order lists every item once');
        const has = (id) => Object.prototype.hasOwnProperty.call(idx.items, id);
        let statements = 0;
        blocksOf(model).forEach(([sid, b]) => {
          if (b.kind === 'chart') return;
          const evs = b.kind === 'kv' ? b.rows.map((r) => r.ev) : b.kind === 'kpi' ? b.items.map((i) => i.ev) : [b.ev];
          evs.forEach((ev, i) => {
            statements++;
            assert(Array.isArray(ev) && ev.length >= 1, label + ': ' + sid + ' ' + b.kind + (b.id ? ' ' + b.id : '') + ' statement ' + i + ' cites no evidence id');
            ev.forEach((id) => assert(has(id), label + ': ' + sid + ' cites ' + id + ', which is not in the evidence index'));
          });
        });
        valuesIn(model).forEach((v) => assert(has(v.ref.split(':')[0]), label + ': Value ref ' + v.ref + ' has no evidence item'));
        rv.findings.forEach((f) => f.ev.forEach((id) => assert(has(id), label + ': finding ' + f.id + ' cites unknown ' + id)));
        assert(statements > 60, label + ': ' + statements + ' statements checked');
        // §8.1 groups present
        ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'D1', 'R3', 'R7', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10', 'T11', 'T12', 'T13', 'T14', 'T15', 'T16', 'V14', 'O1']
          .forEach((id) => assert(has(id), label + ': well-level item ' + id));
        ['D2', 'D3', 'R1', 'R2', 'R3', 'R4', 'R5', 'W1', 'W4', 'I1', 'I3', 'I4', 'I5', 'L1', 'L3', 'M1', 'M2', 'M4', 'M6', 'M7', 'A1', 'A2', 'C1', 'U1', 'U2', 'U3', 'K1', 'K2']
          .forEach((g) => assert(has('B6·' + g), label + ': test-level item B6·' + g));
        assert(has('B5·M8'), label + ': the k-held test has M8');
      });
    },
  },
  {
    name: 'RV2 each rule V1–V27 fires on a crafted variant with its severity and where; V23–V27 never call the engine, run or trend',
    wp: WP,
    opts: false,
    run(app, assert) {
      const R = R0();
      assert.deepStrictEqual(plain(R.RULE_ORDER), Object.keys(PLAN_RULES), 'RULES cover V1–V27 in order');
      Object.keys(PLAN_RULES).forEach((rid) => {
        assert.strictEqual(R.RULES[rid].severity, PLAN_RULES[rid][0], rid + ' severity (plan §7.2)');
        assert.strictEqual(R.RULES[rid].where, PLAN_RULES[rid][1], rid + ' where (plan §7.2)');
        assert.strictEqual(R.RULES[rid].acceptable, rid !== 'V14', rid + ' acceptable');
      });
      // the fixture itself: only the stimulation-candidate suggestion
      const base = R.run(S.FIX.analysis, null, { at: AT });
      assert.deepStrictEqual(plain(base.findings.map((f) => f.rule)), ['V5'], 'FIX.analysis raises only V5');
      assert.strictEqual(base.evidenceCheck.ok, true);
      assert.deepStrictEqual(plain(base.warnings), [], 'no rule errors on FIX');
      Object.keys(CASES).forEach((rid) => {
        const an = variant(rid), rv = R.run(an, null, { at: AT });
        const sh = S.checkShape('Review', plain(rv));
        assert(sh.ok, rid + ': Review shape: ' + JSON.stringify(sh.errors.slice(0, 4)));
        const f = rv.findings.find((x) => x.rule === rid);
        assert(f, rid + ' fires on its crafted variant (got ' + rv.findings.map((x) => x.rule).join(', ') + ')');
        assert.strictEqual(f.severity, PLAN_RULES[rid][0], rid + ' severity');
        assert.strictEqual(f.where, PLAN_RULES[rid][1], rid + ' where');
        assert.strictEqual(rv.evidenceCheck.ok, true, rid + ': its own quoted numbers pass the evidence check');
        assert(!rv.findings.some((x) => x.rule === 'V14'), rid + ': no V14 on an untampered variant');
        assert.deepStrictEqual(plain(rv.warnings), [], rid + ': no rule error');
        const shF = S.checkShape('Finding', plain(f));
        assert(shF.ok, rid + ': Finding shape: ' + JSON.stringify(shF.errors.slice(0, 3)));
        assert(!BANNED.test(R.fill(f.template, f.values, imp)), rid + ': finding text');
      });
      // V14: a quoted number tampered after the review
      const an = S.FIX.analysis, idx = R.evidence(an), rv = R.run(an, idx, { at: AT });
      rv.findings[0].values.cv.v = 12.5;
      R.recheck(rv, an, idx);
      const v14 = rv.findings.find((f) => f.rule === 'V14');
      assert(v14 && v14.severity === 'critical' && v14.where === 'any' && v14.acceptable === false, 'V14 from a tampered quote');
      // source grep: the re-derivation rules and their section never reach the engine, run or trend
      const FORBIDDEN = /PRiSM_autoInterp|WTS_buildup\s*\.\s*(run|trend)|\binterpret(Job)?\s*\(|\.trend\s*\.\s*compute|\banalyse(Async)?\s*\(/;
      ['V23', 'V24', 'V25', 'V26', 'V27'].forEach((rid) => {
        const src = R.RULES[rid].fn.toString();
        assert(src.length > 200, rid + ' has its own function');
        assert(!FORBIDDEN.test(src), rid + ' references the engine, run or trend');
      });
      const a = SRC.indexOf('── RE-DERIVATION START ──'), b = SRC.indexOf('── RE-DERIVATION END ──');
      assert(a > 0 && b > a, 'the re-derivation section is marked');
      const section = SRC.slice(a, b);
      assert(!FORBIDDEN.test(section), 'the re-derivation section references the engine, run or trend');
      ['_V23', '_V24', '_V25', '_V26', '_V27', '_rdBicChoice', '_alertRecompute', '_rdPointSkinMean', '_rdClosingRate'].forEach((fn) => assert(section.indexOf('function ' + fn + '(') !== -1, fn + ' lives in the section'));
      assert(!/Math\.random/.test(SRC), 'no Math.random in the review module');
      assert(!/setTimeout|setInterval|localStorage|indexedDB|document\.|addEventListener|fetch\(|XMLHttpRequest/.test(stripSelfTest(SRC, FILE, QUIET)), 'pure: no timers, storage, DOM or network');
    },
  },
  {
    name: 'RV3 a tampered quoted number → V14 critical, not acceptable; canSign fails even with every decision recorded',
    wp: WP,
    opts: false,
    run(app, assert) {
      const R = R0(), an = S.FIX.analysis, idx = R.evidence(an);
      const rv = R.run(an, idx, { at: AT });
      assert.strictEqual(R.canSign(rv).ok, true, 'only a suggestion: signable before tampering');
      const before = rv.findings[0].values.cv.v;
      rv.findings[0].values.cv.v = before + 12.5;
      const chk = R.check(rv, an, idx);
      assert.strictEqual(chk.ok, false, 'check() sees the tampered quote');
      assert.strictEqual(chk.failures[0].ref, 'T9:cvPct');
      R.recheck(rv, an, idx);
      const v14 = rv.findings.filter((f) => f.rule === 'V14');
      assert.strictEqual(v14.length, 1, 'one V14 finding');
      assert.strictEqual(v14[0].severity, 'critical'); assert.strictEqual(v14[0].acceptable, false);
      assert.strictEqual(rv.evidenceCheck.ok, false);
      assert(S.checkShape('Review', plain(rv)).ok, 'Review shape with V14');
      assert.strictEqual(rv.counts.critical, 1);
      R.recheck(rv, an, idx);
      assert.strictEqual(rv.findings.filter((f) => f.rule === 'V14').length, 1, 'recheck does not duplicate V14');
      // every finding decided (V14 included) → still not signable
      R.applyDecisions(rv, rv.findings.map((f) => ({ target: f.key, d: 'accept', note: 'Seen.', who: 'Reviewer B', at: AT })));
      assert(rv.findings.every((f) => f.decision && f.decision.d === 'accept'), 'decisions recorded');
      const cs = R.canSign(rv);
      assert.strictEqual(cs.ok, false, 'canSign fails with a V14 finding');
      assert(cs.open.indexOf(v14[0].id) !== -1, 'the V14 finding stays open');
      const so = R.signoff({ name: 'Reviewer B', role: 'Reservoir engineer', statement: true, at: AT }, an, rv);
      assert.strictEqual(so.ok, false); assert.strictEqual(so.code, 'EVIDENCE_CHECK_FAILED');
      // the report path: an analysis number changed after the review → report() adds V14 and shows the failure
      const rv2 = R.run(an, idx, { at: AT });
      const an2 = clone(an); an2.trend.kStability.cv = 0.04;
      const model = R.report(an2, rv2, null, null, imp);
      assert(rv2.findings.some((f) => f.rule === 'V14'), 'report() adds V14 to the review');
      const s9 = model.sections.find((s) => s.id === 'S9');
      assert(s9.blocks.some((b) => b.kind === 'verdict' && /^✗ Evidence check/.test(R.fill(b.template, b.values, imp))), 'S9 shows the failed evidence check');
      assert(s9.blocks.some((b) => b.kind === 'table' && b.rows.some((r) => r[0] === 'V14')), 'S9 lists V14');
      // a tampered report Value fails check() (the evidence check runs on the ReportModel too)
      const m0 = R.report(an, R.run(an, idx, { at: AT }), null, null, imp);
      assert.strictEqual(R.check(m0, an, idx).ok, true, 'the untampered model passes');
      const kpi = m0.sections[0].blocks.find((b) => b.kind === 'kpi').items.find((i) => i.label === 'Latest skin');
      kpi.value.v += 0.5;
      const c2 = R.check(m0, an, idx);
      assert.strictEqual(c2.ok, false, 'a tampered report number fails');
      assert(c2.failures.some((f) => f.ref === 'B6·A2:S'));
    },
  },
  {
    name: 'RV4 Q&A: 19 sample questions + 3 paraphrases per intent; what-if h +20 %; compare B2 and B5; out of scope → help',
    wp: WP,
    opts: false,
    run(app, assert) {
      const R = R0(), an = S.FIX.analysis, idx = R.evidence(an);
      assert.deepStrictEqual(plain(R.INTENTS.map((i) => i.id)), Object.keys(QA), 'the 19 intents of §7.4, in table order');
      let n = 0;
      Object.keys(QA).forEach((intent) => {
        assert.strictEqual(QA[intent].length, 4, intent + ': sample + 3 paraphrases');
        QA[intent].forEach((q) => {
          const a = R.ask(q, an, idx, imp);
          n++;
          assert.strictEqual(a.intent, intent, JSON.stringify(q) + ' → ' + a.intent);
          const sh = S.checkShape('Answer', plain(a));
          assert(sh.ok, q + ': Answer shape: ' + JSON.stringify(sh.errors.slice(0, 3)));
          assert.strictEqual(a.check.ok, true, q + ': evidence check ' + JSON.stringify(plain(a.check.failures).slice(0, 2)));
          assert(!a.withheld, q + ': not withheld');
          a.ev.forEach((id) => assert(idx.items[id], q + ': cites unknown ' + id));
          QA_EV[intent].forEach((want) => assert(a.ev.some((id) => (want instanceof RegExp ? want.test(id) : id === want)), q + ': cites ' + want + ' (got ' + a.ev.join(', ') + ')'));
          // numbers equal the analysis: every plain numeric value is the stored value at its evidence path
          Object.keys(a.values).forEach((k) => {
            const v = a.values[k];
            if (typeof v.v !== 'number' || v.calc) return;
            const [id, name] = v.ref.split(':'), iv = idx.items[id].values[name];
            if (!iv.formula) {
              const stored = iv.path.split(/\.|\[|\]/).filter(Boolean).reduce((o, p) => (o == null ? o : o[/^\d+$/.test(p) ? +p : p === 'length' && Array.isArray(o) ? 'length' : p]), an);
              assert.strictEqual(v.v, stored, q + ': ' + v.ref + ' equals the analysis');
            }
          });
          const text = R.fill(a.template, a.values, imp);
          assert(!BANNED.test(text) && text.length <= 600, q + ': answer text');
          if (intent === 'help') { assert.deepStrictEqual(Object.keys(a.values), [], 'help quotes no numbers'); assert.strictEqual(a.grounded, 'none'); assert(!/\d/.test(text), 'help text has no digits'); }
          else assert.notStrictEqual(a.grounded, 'none', q + ': grounded');
        });
      });
      assert.strictEqual(n, 76, '19 × 4 questions');
      // the what-if numbers equal the analytic sensitivity (Appendix A.2): k −16.7 %, S +0.091
      const w = R.ask('what if h is 20 % higher?', an, idx, imp);
      assert.near(w.values.dk.v, 100 * (1 / 1.2 - 1), 1e-9, 'dk');
      assert.near(w.values.ds.v, 1.1513 * Math.log10(1.2), 1e-9, 'dS');
      assert.strictEqual(R.fmtValue(w.values.dk, imp), '-16.7');
      assert.strictEqual(R.fmtValue(w.values.ds, imp), '0.091');
      assert.near(w.values.k1.v, an.tests[5].result.final.k / 1.2, 1e-9, 'latest test k / 1.2');
      assert.near(w.values.s1.v, an.tests[5].result.final.S + 1.1513 * Math.log10(1.2), 1e-9, 'latest test S + ΔS');
      assert.strictEqual(w.values.abs.v, 'provisional', 'the absolute alert after the shift (B6 only)');
      assert(/delta alert is unchanged/.test(w.template), 'states the delta-alert impact');
      const w2 = R.ask('what if rw is 20 % lower?', an, idx, imp);
      assert.near(w2.values.ds.v, 2.3026 * Math.log10(0.8), 1e-9, 'rw −20 %: S −0.223');
      assert.near(w2.values.dk.v, 0, 1e-12, 'rw has no effect on k');
      // compare B2 and B5 finds both tests
      const cmp = R.ask('compare B2 and B5', an, idx, imp);
      assert.strictEqual(cmp.values.a.v, 'B2'); assert.strictEqual(cmp.values.b.v, 'B5');
      assert(cmp.ev.indexOf('B2·A2') !== -1 && cmp.ev.indexOf('B5·A2') !== -1, 'both tests cited');
      assert.near(cmp.values.ds.v, an.tests[4].result.final.S - an.tests[1].result.final.S, 1e-12, 'fitted ΔS');
      const cmp2 = R.ask('How does B6 differ from B1?', an, idx, imp);
      const mf = an.trend.modelFree.find((r) => r.id === 'B6');
      assert.near(cmp2.values.mf.v, -mf.dS, 1e-12, 'model-free ΔS against the reference test');
      // value and why answers quote the analysis
      const val = R.ask('what is k for B3?', an, idx, imp);
      assert.strictEqual(val.values.k.v, an.tests[2].result.final.k); assert.strictEqual(val.values.s.v, an.tests[2].result.final.S);
      assert.strictEqual(val.values.e.v, an.tests[2].result.sErr.value);
      const wn = R.ask('why not a fault for B4?', an, idx, imp);
      assert.strictEqual(wn.intent, 'why_model'); assert(/sealing fault was not fitted/.test(wn.template), 'names the model asked about');
      // a test that does not exist → partial, no invented numbers
      const nx = R.ask('what is k for B9?', an, idx, imp);
      assert.strictEqual(nx.grounded, 'partial'); assert.strictEqual(nx.values.name.v, 'B9'); assert.strictEqual(nx.check.ok, true);
      // out of scope → help, quoting no numbers
      const h = R.ask('What is the capital of France?', an, idx, imp);
      assert.strictEqual(h.intent, 'help'); assert.deepStrictEqual(Object.keys(h.values), []);
      // the question is capped at 300 characters and the index is optional
      const long = R.ask('is there an alert? ' + 'x'.repeat(400), an);
      assert.strictEqual(long.q.length, 300); assert.strictEqual(long.intent, 'alert');
      // the what-if names every used test with its shifted skin
      const usedIds = an.tests.filter((t) => t.used && t.used.trend && t.result).map((t) => t.id);
      usedIds.forEach((id, j) => {
        assert.strictEqual(w.values['t' + j].v, id, 'what-if lists ' + id);
        assert.near(w.values['u' + j].v, an.tests.find((t) => t.id === id).result.final.S + 1.1513 * Math.log10(1.2), 1e-9, id + ' shifted S');
      });
      assert(R.fill(w.template, w.values, imp).length <= 600, 'what-if text ≤ 600');
      // when the stored series cannot re-derive the absolute alert, the answer says so and quotes no stored status
      const amb = S.FIX.analysis; amb.trend.baseline.segments.push({ from: amb.tests[3].date, S: amb.trend.baseline.S, tests: ['B4'] });
      const wa = R.ask('what if h is 20 % higher?', amb, null, imp);
      assert.strictEqual(wa.check.ok, true); assert(!('abs' in wa.values), 'no absolute-alert status quoted');
      assert(/cannot be re-derived from the stored series/.test(wa.template), wa.template);
      // a test named with a mechanical-skin keyword goes to mech, not to value
      ['What is the mechanical skin of B6?', 'How much of the skin of B6 is damage?', 'What is the pseudo-skin for test 3?'].forEach((q) => {
        const a = R.ask(q, an, idx, imp);
        assert.strictEqual(a.intent, 'mech', JSON.stringify(q) + ' → ' + a.intent); assert.strictEqual(a.check.ok, true);
      });
      assert.strictEqual(R.ask('What is the skin of B6?', an, idx, imp).intent, 'value', 'a plain value question stays value');
      // an excluded test without a result (the usual case) still has its A2 item: excluded and shut-in answers are not withheld
      const nr = S.FIX.analysis, b4 = nr.tests[3];
      Object.assign(b4, { result: null, status: 'not_analysable', statusReason: 'Shut-in too short for IARF.' });
      const nidx = R.evidence(nr);
      assert(nidx.items['B4·A2'] && nidx.items['B4·A2'].values.status.v === 'not_analysable', 'B4·A2 exists without a result');
      assert(!('k' in nidx.items['B4·A2'].values), 'and holds no result values');
      const ex = R.ask('why was B4 excluded?', nr, nidx, imp);
      assert.strictEqual(ex.intent, 'excluded'); assert(!ex.withheld, 'excluded answer not withheld: ' + JSON.stringify(plain(ex.check.failures)));
      assert.strictEqual(ex.values.st.v, 'not_analysable'); assert.strictEqual(ex.values.why.v, 'Shut-in too short for IARF.');
      assert(ex.ev.indexOf('B4·A2') !== -1);
      const sl = R.ask('how long should the shut-in be for B4?', nr, nidx, imp);
      assert.strictEqual(sl.intent, 'shutin_length'); assert(!sl.withheld, 'shut-in answer not withheld'); assert.strictEqual(sl.values.test.v, 'B4');
      assert(S.checkShape('EvidenceIndex', plain(nidx)).ok, 'index shape with a no-result test');
      const rvn = R.run(nr, nidx, { at: AT });
      assert(!rvn.findings.some((f) => f.rule === 'V14'), 'no V14 with a no-result test: ' + rvn.findings.filter((f) => f.rule === 'V14').map((f) => f.values.ref.v).join(', '));
    },
  },
  {
    name: 'RV5 a failing answer is marked on the answer and adds no review finding',
    wp: WP,
    opts: false,
    run(app, assert) {
      const R = R0(), an = S.FIX.analysis, idx = R.evidence(an);
      const rv = R.run(an, idx, { at: AT });
      const before = JSON.stringify(rv);
      const an2 = clone(an); an2.tests[2].result.final.k = 50;     // the analysis changed after the index was built
      const a = R.ask('what is k for B3?', an2, idx, imp);
      assert.strictEqual(a.withheld, true, 'marked on the answer');
      assert.strictEqual(a.check.ok, false);
      assert(a.check.failures.some((f) => f.ref === 'B3·A2:k'), 'the failing value is named');
      assert.deepStrictEqual(Object.keys(a.values), [], 'numbers withheld');
      assert(/failed its evidence check; the numbers are withheld/.test(a.template));
      assert(S.checkShape('Answer', plain(a)).ok, 'withheld answer keeps the Answer shape');
      assert.strictEqual(JSON.stringify(rv), before, 'the review is unchanged');
      assert(!rv.findings.some((f) => f.rule === 'V14'), 'no V14 from a Q&A failure');
      R.report(an, rv, null, null, imp);
      assert(!rv.findings.some((f) => f.rule === 'V14'), 'and none after the report either');
      const ok = R.ask('what is k for B3?', an, idx, imp);
      assert.strictEqual(ok.check.ok, true); assert(!ok.withheld);
    },
  },
  {
    name: 'RV6 SHA-256 vectors and cross-checks; the hashes use canon/hash16 from file 53; the build carries the module',
    wp: WP,
    run(app, assert, ctx) {
      const R = R0(), AI = S.autoInterp();
      assert.strictEqual(R.sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', "sha256('')");
      assert.strictEqual(R.sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', "sha256('abc')");
      assert.strictEqual(R.sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1', 'two-block vector');
      const node = (s) => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
      const samples = ['é', '中文 build-up', '😀 skin', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(63), 'a'.repeat(64), 'a'.repeat(119), 'a'.repeat(1000), '\ud800 lone', JSON.stringify(S.FIX.result).slice(0, 5000)];
      let seed = 12345;
      const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
      for (let i = 0; i < 40; i++) { let s = ''; const len = next() % 200; for (let j = 0; j < len; j++) s += String.fromCharCode(32 + (next() % 0x2fd0)); samples.push(s); }
      samples.forEach((s, i) => assert.strictEqual(R.sha256(s), node(s), 'sha256 = Node crypto, sample ' + i));
      assert.strictEqual(R.sha256('a'.repeat(1000000)), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0', 'one million a');
      // hashes come from file 53: results, decisions, signature
      const an = S.FIX.analysis, rv = R.run(an, null, { at: AT });
      R.applyDecisions(rv, [{ target: 'V5', d: 'accept', note: 'Agreed.', who: 'Reviewer B', at: AT }]);
      const h = R.hashes(an, rv);
      const resultsObj = {
        tests: an.tests.map((t) => ({ id: t.id, final: t.result.final, sErr: t.result.sErr.value, labels: { ks: t.result.confidence.ks, model: t.result.confidence.model, headline: t.result.confidence.headline } })),
        alerts: an.trend.alerts, onset: an.trend.onset, recent: an.trend.recent.slopePer30d,
      };
      assert.strictEqual(h.resultsHash, AI.hash16(AI.canon(resultsObj, 'display')), 'resultsHash = hash16(canon(…, display))');
      assert.strictEqual(h.resultsHash, an.resultHash, 'same recipe as the fixture resultHash');
      assert.strictEqual(h.inputsHash, an.inputHash, 'inputsHash is the analysis inputHash');
      const dec = [{ key: 'V5:', rule: 'V5', d: 'accept', note: 'Agreed.', who: 'Reviewer B', at: AT }];
      assert.strictEqual(h.decisionsHash, AI.hash16(AI.canon(dec, 'display')), 'decisionsHash = hash16(canon(decisions, display))');
      const so = R.signoff({ name: 'Reviewer B', role: 'Reservoir engineer', statement: true, at: AT }, an, rv);
      assert.strictEqual(so.ok, true);
      assert.strictEqual(so.hash, node(AI.canon({ inputsHash: h.inputsHash, resultsHash: h.resultsHash, decisionsHash: h.decisionsHash, name: 'Reviewer B', role: 'Reservoir engineer', at: AT }, 'display')),
        'signature = sha256(canon({inputsHash, resultsHash, decisionsHash, name, role, at}, display))');
      assert.strictEqual(R.signature(an, rv, { name: 'Reviewer B', role: 'Reservoir engineer', at: AT }).hash, so.hash, 'signature() = signoff().hash');
      // no own canon/hash16 in the review file; without file 53 the hashes are null (never an own implementation)
      assert(!/0x811c9dc5|0x050c5d1f|16777619|function\s+canon\b|function\s+hash16\b/.test(SRC), 'the review file does not re-implement canon/hash16');
      const bare = load({ no53: true }).R;
      assert.strictEqual(bare.sha256('abc'), R.sha256('abc'), 'loads and hashes SHA-256 without file 53');
      assert.strictEqual(bare.hashes(an, rv).resultsHash, null, 'no file 53 → no hash16');
      assert.strictEqual(bare.status(an, rv, so), 'CHANGED', 'and a signature cannot be confirmed');
      // the build: Round 9 picks the helper up; the self-test is stripped; it adds no page
      if (ctx.mode === 'html' && !fs.readFileSync(path.join(PB, '..', 'well-testing-app.html'), 'utf8').includes('BEGIN 49-calc-buildup-review')) return;
      const W = app.win.WTS_buildup && app.win.WTS_buildup.review;
      assert(W && typeof W.sha256 === 'function', 'app: window.WTS_buildup.review (' + ctx.mode + ' build)');
      assert.strictEqual(W.sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
      assert.strictEqual(app.win.WTS_buildup_review_selfTest, undefined, 'the self-test is stripped from the build');
      const reg = app.win.WTS_calcRegistry || {};
      assert(!Object.keys(reg).some((k) => /review/.test(k)), 'the helper registers no page');
      // file 53 reaches the committed HTML with the integrator's Round-8 rebuild (plan §2.6); until then no hash16
      if (app.win.PRiSM_autoInterp && typeof app.win.PRiSM_autoInterp.hash16 === 'function') assert.strictEqual(W.hashes(an, rv).resultsHash, h.resultsHash, 'app hashes = file hashes');
      else assert.strictEqual(W.hashes(an, rv).resultsHash, null, 'a build without file 53 has no hash16 (no own fallback)');
    },
  },
  {
    name: 'RV7 sign-off: blocked with open majors; DRAFT → SIGNED → CHANGED; same-input re-run and a new app version stay SIGNED',
    wp: WP,
    opts: false,
    run(app, assert) {
      const R = R0();
      const an = variant('V8');                                   // baseline unstable → a major finding
      const form = { name: 'Reviewer B', role: 'Reservoir engineer', statement: true, at: AT };
      const rv = R.run(an, null, { at: AT });
      const v8 = rv.findings.find((f) => f.rule === 'V8');
      assert.strictEqual(R.status(an, rv, null), 'DRAFT');
      let so = R.signoff(form, an, rv);
      assert.strictEqual(so.ok, false); assert.strictEqual(so.code, 'OPEN_FINDINGS'); assert(so.bad.indexOf(v8.id) !== -1, 'the open major is named');
      assert.strictEqual(R.signoff(Object.assign({}, form, { name: '  ' }), an, rv).code, 'NO_NAME');
      assert.strictEqual(R.signoff(Object.assign({}, form, { statement: false }), an, rv).code, 'NO_STATEMENT');
      assert.strictEqual(R.signoff(form, {}, R.run({}, null, { at: AT })).code, 'NO_ANALYSIS', 'nothing to sign without an analysis');
      const m0 = R.report(an, rv, null, null, imp);
      assert.strictEqual(m0.status, 'DRAFT');
      const s11 = (m) => m.sections.find((s) => s.id === 'S11').blocks.filter((b) => b.kind === 'verdict').map((b) => R.fill(b.template, b.values, imp));
      assert(/^⚠ DRAFT — not signed off \(1 finding needs a decision\)/.test(s11(m0)[0]), 'S11 DRAFT with the open count (singular for one): ' + s11(m0)[0]);
      // a rejection needs a note
      R.applyDecisions(rv, [{ target: 'V8', d: 'reject', who: 'Reviewer B', at: AT }]);
      assert.strictEqual(R.canSign(rv).ok, false, 'a rejection without a note stays open');
      R.applyDecisions(rv, [{ target: v8.key, d: 'reject', note: 'Baseline spread is the known gauge swap.', who: 'Reviewer B', at: AT }]);
      assert.strictEqual(R.canSign(rv).ok, true);
      so = R.signoff(form, an, rv);
      assert.strictEqual(so.ok, true, 'signed');
      assert(S.checkShape('Signoff', plain(so)).ok, 'Signoff shape: ' + JSON.stringify(S.checkShape('Signoff', plain(so)).errors));
      assert.strictEqual(R.status(an, rv, so), 'SIGNED');
      const m1 = R.report(an, rv, null, so, imp);
      assert.strictEqual(m1.status, 'SIGNED');
      assert(/^✓ Signed off by Reviewer B \(Reservoir engineer\) on 2026-07-02 · hash [0-9a-f]{16}\.$/.test(s11(m1)[0]), 'S11 ✓ verdict: ' + s11(m1)[0]);
      assert.strictEqual(m1.signature.hash, so.hash);
      assert(R.check(m1, an, R.evidence(an), { review: rv, signoff: so }).ok, 'the signed report passes the evidence check');
      // a result edit → CHANGED
      const an2 = clone(an); an2.tests[5].result.final.S = 6.5;
      assert.strictEqual(R.status(an2, rv, so), 'CHANGED', 'result edit');
      const m2 = R.report(an2, R.applyDecisions(R.run(an2, null, { at: AT }), [{ target: v8.key, d: 'reject', note: 'Baseline spread is the known gauge swap.', who: 'Reviewer B', at: AT }]), null, so, imp);
      assert.strictEqual(m2.status, 'CHANGED');
      assert(/changed after sign-off on 2026-07-02/.test(s11(m2)[0]), 'CHANGED banner');
      // an input change → CHANGED
      const an2b = clone(an); an2b.inputHash = 'ffffffffffffffff';
      assert.strictEqual(R.status(an2b, rv, so), 'CHANGED', 'input change');
      // a re-run with the same inputs (new run time, same numbers) → SIGNED once the decisions are re-applied
      const an3 = clone(an); an3.runAt = '2026-07-05T08:00:00Z';
      const rv3 = R.run(an3, null, { at: '2026-07-05T08:00:01Z' });
      R.applyDecisions(rv3, [{ target: v8.key, d: 'reject', note: 'Baseline spread is the known gauge swap.', who: 'Reviewer B', at: AT }]);
      assert.strictEqual(R.status(an3, rv3, so), 'SIGNED', 're-run with the same inputs stays SIGNED');
      // the decisions may come from the audit trail
      let log = R.audit.append(null, { kind: 'decision', who: 'Reviewer B', at: AT, target: v8.key, value: { d: 'reject', note: 'Baseline spread is the known gauge swap.' }, reason: null });
      const rv3b = R.applyDecisions(R.run(an3, null, { at: AT }), log);
      assert.strictEqual(R.status(an3, rv3b, so), 'SIGNED', 'decisions read from the audit log');
      // a changed decision → CHANGED
      const rv4 = R.applyDecisions(R.run(an, null, { at: AT }), [{ target: v8.key, d: 'accept', who: 'Reviewer B', at: AT }]);
      assert.strictEqual(R.status(an, rv4, so), 'CHANGED', 'decision change');
      // a different app version → SIGNED with the info line
      const an5 = clone(an); an5.appVersion = '3.4';
      const rv5 = R.applyDecisions(R.run(an5, null, { at: AT }), [{ target: v8.key, d: 'reject', note: 'Baseline spread is the known gauge swap.', who: 'Reviewer B', at: AT }]);
      assert.strictEqual(R.status(an5, rv5, so), 'SIGNED', 'app update stays SIGNED');
      const m5 = R.report(an5, rv5, null, so, imp);
      assert(s11(m5).some((t) => t === '⚠ Signed with 3.3; re-run to verify.'), 'info line: ' + JSON.stringify(s11(m5)));
      assert(!s11(m1).some((t) => /re-run to verify/.test(t)), 'no info line with the same version');
      // a tampered sign-off record is not accepted as SIGNED
      const bad = Object.assign({}, so, { name: 'Someone Else' });
      assert.strictEqual(R.status(an, rv, bad), 'CHANGED', 'tampered sign-off record');
      // the review carries the results hash recomputed from the analysis it was run on
      assert.strictEqual(rv.resultHash, R.hashes(an, rv).resultsHash, 'Review.resultHash = recomputed results hash');
      // a review run on an earlier state of the analysis cannot be signed: results edited in place after run()
      const an6 = variant('V8'), rv6 = R.run(an6, null, { at: AT });
      R.applyDecisions(rv6, [{ target: v8.key, d: 'reject', note: 'Baseline spread is the known gauge swap.', who: 'Reviewer B', at: AT }]);
      Object.assign(an6.tests[5].result.final, { S: 9.9, k: 10 });
      const st6 = R.signoff(form, an6, rv6);
      assert.strictEqual(st6.ok, false, 'stale review refused'); assert.strictEqual(st6.code, 'EVIDENCE_CHECK_FAILED');
      assert(/earlier state of the analysis/.test(st6.errors[0]), st6.errors[0]);
      const fresh6 = R.run(an6, null, { at: AT });
      assert(fresh6.findings.some((f) => f.rule === 'V24' || f.rule === 'V23' || f.rule === 'V14'), 'a fresh run sees the edit');
      // … and with changed inputs
      const an7 = clone(an), rv7 = R.applyDecisions(R.run(an7, null, { at: AT }), [{ target: v8.key, d: 'reject', note: 'Baseline spread is the known gauge swap.', who: 'Reviewer B', at: AT }]);
      an7.inputHash = 'eeeeeeeeeeeeeeee';
      assert.strictEqual(R.signoff(form, an7, rv7).code, 'EVIDENCE_CHECK_FAILED', 'inputs changed after the review');
      assert.strictEqual(R.signoff(form, an, null).code, 'EVIDENCE_CHECK_FAILED', 'no review, no sign-off');
      // sign-off re-runs the evidence check of the review: a quote that no longer matches is caught (V14) and blocks it
      const an8 = clone(an), rv8 = R.applyDecisions(R.run(an8, null, { at: AT }), [{ target: v8.key, d: 'reject', note: 'Baseline spread is the known gauge swap.', who: 'Reviewer B', at: AT }]);
      an8.trend.baseline.tests = ['B1', 'B2'];                    // quoted by V8, outside the results hash
      const st8 = R.signoff(form, an8, rv8);
      assert.strictEqual(st8.code, 'EVIDENCE_CHECK_FAILED', 'recheck before canSign'); assert(rv8.findings.some((f) => f.rule === 'V14'), 'V14 added by the recheck');
      // a V14 that appears after sign-off (a field outside the results hash) voids the signature: CHANGED, no ✓ in S11
      const an9 = clone(an), rv9 = R.applyDecisions(R.run(an9, null, { at: AT }), [{ target: v8.key, d: 'reject', note: 'Baseline spread is the known gauge swap.', who: 'Reviewer B', at: AT }]);
      const so9 = R.signoff(form, an9, rv9);
      assert.strictEqual(so9.ok, true); assert.strictEqual(R.status(an9, rv9, so9), 'SIGNED');
      an9.trend.kStability.cv = 0.041;
      const m9 = R.report(an9, rv9, null, so9, imp);
      assert(rv9.findings.some((f) => f.rule === 'V14'), 'report() adds V14');
      assert.strictEqual(R.status(an9, rv9, so9), 'CHANGED', 'V14 after sign-off → CHANGED');
      assert.strictEqual(m9.status, 'CHANGED');
      assert(!s11(m9).some((t) => /^✓/.test(t)), 'S11 has no ✓ verdict: ' + JSON.stringify(s11(m9)));
      // decision codes: only accept | reject | note (null or 'clear' clears); anything else is ignored
      const rv10 = R.run(an, null, { at: AT });
      R.applyDecisions(rv10, [{ target: v8.key, d: 'approve', note: 'Looks fine.', who: 'Reviewer B', at: AT }]);
      assert.strictEqual(rv10.findings.find((f) => f.rule === 'V8').decision, null, "d:'approve' is ignored");
      assert(R.canSign(rv10).open.indexOf(rv10.findings.find((f) => f.rule === 'V8').id) !== -1, 'the major stays open');
      R.applyDecisions(rv10, [{ target: v8.key, d: 'note', note: 'Seen.', who: 'Reviewer B', at: AT }, { target: v8.key, d: 'approve', who: 'Reviewer B', at: AT }]);
      assert.strictEqual(rv10.findings.find((f) => f.rule === 'V8').decision.d, 'note', 'an ignored code does not overwrite a valid decision');
      assert(S.checkShape('Review', plain(rv10)).ok, 'Review shape after decisions');
      rv10.findings.find((f) => f.rule === 'V8').decision = { d: 'approve', note: null, who: 'X', at: AT };
      assert.strictEqual(R.canSign(rv10).ok, false, 'canSign does not count an invalid stored decision');
    },
  },
  {
    name: 'RV8 AI export: no well, engineer or file name, no reason text, no dates, no URL; includeFreeText adds the reasons',
    wp: WP,
    opts: false,
    run(app, assert) {
      const R = R0(), an = S.FIX.analysis;
      an.meta.wellName = 'Test Well North 7'; an.meta.engineer = 'Sam Example'; an.record.name = 'test-well-north-7-gauge.csv';
      const reason = an.overrides[0].reason;
      const rv = R.run(an, null, { at: AT });
      R.applyDecisions(rv, [{ target: 'V5', d: 'accept', note: 'Agreed with the operations team on 2026-07-02.', who: 'Sam Example', at: AT }]);
      const x = R.aiExport(an, rv, {});
      const t = x.text;
      ['Test Well North 7', 'North 7', 'Sam Example', 'test-well-north-7-gauge', reason, 'gauge was swapped', 'operations team'].forEach((s) => assert(t.indexOf(s) === -1, 'leaks ' + JSON.stringify(s)));
      assert(!/\d{4}-\d{2}-\d{2}/.test(t), 'no date strings: ' + (t.match(/.{0,30}\d{4}-\d{2}-\d{2}.{0,10}/) || [''])[0]);
      assert(!/https?:|www\.|\.(com|org|net|uk|io|ai)\b/i.test(t), 'no URL');
      assert(/Well A/.test(t), 'de-identified well label');
      assert(/F1 V5 suggestion \[S7\]/.test(t) && /Decision: accept\./.test(t), 'findings with decision codes only');
      assert(/B6 \| day [\d.]+ \|/.test(t), 'per-test rows with day numbers');
      assert(/T2/.test(t) && /B6·A2/.test(t), 'evidence ids');
      assert(/cite the evidence ids/.test(t) && /extra data/.test(t), 'built-in review prompt');
      assert(/^buildup-review-[0-9a-f]{8}\.txt$/.test(x.filename), 'filename ' + x.filename);
      assert(!BANNED.test(t), 'no null/undefined text');
      const f = R.aiExport(an, rv, { includeFreeText: true }).text;
      assert(f.indexOf(reason) !== -1, 'includeFreeText: the override reason appears');
      assert(f.indexOf('Agreed with the operations team') !== -1, 'includeFreeText: the decision note appears');
      assert(!/\d{4}-\d{2}-\d{2}/.test(f), 'still no dates (free text is de-dated)');
      assert(f.indexOf('Sam Example') === -1 && f.indexOf('Test Well North 7') === -1, 'still de-identified');
      assert(/\d{4}-\d{2}-\d{2}/.test(R.aiExport(an, rv, { includeDates: true }).text), 'includeDates keeps dates');
      assert(R.aiExport(an, rv, { deidentify: false }).text.indexOf('Test Well North 7') !== -1, 'deidentify:false keeps the well name');
    },
  },
  {
    name: 'RV9 report limits on FIX: notes ≤ 600, verdicts < 300, tables ≤ 30 rows (40 tests → 30 + "10 older tests"), S9 by rule, no null text',
    wp: WP,
    opts: false,
    run(app, assert) {
      const R = Rcal();
      CASE_LABELS.forEach((label) => {
        const { rv, model } = prepared(label);
        const sh = S.checkShape('ReportModel', plain(model));
        assert(sh.ok, label + ': ReportModel shape: ' + JSON.stringify(sh.errors.slice(0, 4)));
        assert.deepStrictEqual(plain(model.sections.map((s) => s.id)), ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11', 'S12'], label + ': sections S1–S12');
        [imp, met].forEach((fmt) => {
          textsOf(R, model, fmt).forEach(([sid, kind, text]) => {
            assert(!BANNED.test(text), label + ' ' + sid + ' ' + kind + ': banned word in ' + JSON.stringify(text.slice(0, 120)));
            if (kind === 'verdict') assert(text.length < 300, label + ' ' + sid + ': verdict ' + text.length + ' chars');
            if (kind === 'notes') assert(text.length <= 600, label + ' ' + sid + ': notes ' + text.length + ' chars');
            if (kind === 'kv' || kind === 'kpi') assert(text.length < 600, label + ' ' + sid + ': row ' + text.length);
          });
        });
        blocksOf(model).forEach(([sid, b]) => {
          if (b.kind !== 'table') return;
          const older = b.rows.filter((r) => typeof r[1] === 'string' && / not shown$/.test(r[1]));
          assert(b.rows.length - older.length <= 30, label + ' ' + sid + ' ' + b.id + ': ' + (b.rows.length - older.length) + ' data rows');
          assert(older.length <= 1);
        });
        // S9 grouped by rule: one table row per rule
        const s9 = model.sections.find((s) => s.id === 'S9');
        const tbl = s9.blocks.find((b) => b.kind === 'table');
        if (rv.findings.length) {
          const rules = plain(tbl.rows.map((r) => r[0]));
          assert.strictEqual(new Set(rules).size, rules.length, label + ': one row per rule');
          assert.deepStrictEqual(rules, plain([...new Set(rv.findings.map((f) => f.rule))]), label + ': every rule with findings, in order');
        }
        if (label === 'many findings') {
          const v10 = tbl.rows.find((r) => r[0] === 'V10');
          assert(v10 && v10[4] === 'B1, B2', 'V10 groups both tests: ' + (v10 && v10[4]));
          assert(rv.findings.filter((f) => f.rule === 'V10').length === 2, 'two V10 findings');
        }
      });
      // 40 tests → the latest 30 rows plus one "10 older tests" row
      const { model } = prepared('40 tests');
      const t = model.sections.find((s) => s.id === 'S4').blocks.find((b) => b.id === 'bu_tbl_tests');
      assert.strictEqual(t.rows.length, 31, '30 tests + 1 older row');
      assert.strictEqual(t.rows[0][0].v, 10, '10 older tests'); assert.strictEqual(t.rows[0][1], 'older tests not shown');
      assert.strictEqual(R.fmtValue(t.rows[0][0], imp) + ' ' + t.rows[0][1], '10 older tests not shown');
      assert.strictEqual(t.rows[1][0], 'B11'); assert.strictEqual(t.rows[30][0], 'B40');
      const ev = model.sections.find((s) => s.id === 'S3').blocks.find((b) => b.id === 'bu_tbl_events');
      assert.strictEqual(ev.rows.length, 31); assert.strictEqual(ev.rows[0][0].v, 11, '41 events → 11 older');
      // degenerate inputs: no exception, shape-valid output, no null/undefined text
      const deg = [['{}', {}], ['null', null], ['no trend', (() => { const a = S.FIX.analysis; a.trend = null; return a; })()],
                   ['no results', (() => { const a = S.FIX.analysis; a.tests.forEach((x) => { x.result = null; x.status = 'failed'; }); return a; })()],
                   ['no line', (() => { const a = S.FIX.analysis; a.tests[5].result.line = null; a.tests[5].result.chosen = null; return a; })()],
                   ['gas', variant('V3')], ['injector', (() => { const a = S.FIX.analysis; a.well.fluid = 'water_inj'; a.well.Pb = null; return a; })()],
                   ['no rates or qc', (() => { const a = S.FIX.analysis; a.rates = null; a.qc = null; a.missed = null; return a; })()]];
      deg.forEach(([label, a]) => {
        const rv = R.run(a, null, { at: AT }), m = R.report(a, rv, null, null, imp), q = R.ask('is there an alert?', a, null, imp);
        assert(S.checkShape('Review', plain(rv)).ok && S.checkShape('ReportModel', plain(m)).ok && S.checkShape('Answer', plain(q)).ok, label + ': shapes');
        assert.deepStrictEqual(plain(rv.warnings), [], label + ': no rule error');
        const txt = textsOf(R, m, imp).map((x) => x[2]).concat([R.fill(q.template, q.values, imp), R.aiExport(a, rv, {}).text]).join('\n');
        assert(!BANNED.test(txt), label + ': banned word in the text');
      });
      // the calibration tables (file 55 shape) appear in S12
      const s12 = model.sections.find((s) => s.id === 'S12');
      assert(s12.blocks.some((b) => b.id === 'bu_tbl_cal_ks') && s12.blocks.some((b) => b.id === 'bu_tbl_cal_hl'), 'S12 shows both calibration tables');
      // §8.2 S3: the events table has a Note column; the S2 confirmation setting is a checked T2 value
      const fixM = prepared('FIX').model;
      const evt = fixM.sections.find((s) => s.id === 'S3').blocks.find((b) => b.id === 'bu_tbl_events');
      assert.strictEqual(evt.head[evt.head.length - 1].text, 'Note', 'events table: Note column');
      assert(evt.rows.every((r) => typeof r[r.length - 1] === 'string' && r[r.length - 1].length > 0), 'every event row has a note');
      const s2 = fixM.sections.find((s) => s.id === 'S2').blocks.find((b) => b.kind === 'kv').rows.find((r) => /trend$/.test(r.label));
      assert.strictEqual(s2.value.values.cf.ref, 'T2:confirm'); assert(prepared('FIX').idx.items.T2.values.confirm, 'T2 carries the confirmation setting');
      // the Δp/q overlay mixes pressure and rate: no unit category, so Metric mode does not convert it
      const ov = fixM.sections.find((s) => s.id === 'S5').blocks.find((b) => b.id === 'bu_ch_ov');
      assert(ov && ov.series.every((s) => s.cat === null), 'bu_ch_ov series have cat null');
      // without a review, S9 claims nothing (no ✓): it says the review was not run
      const noRv = R.report(S.FIX.analysis, null, null, null, imp);
      assert(S.checkShape('ReportModel', plain(noRv)).ok, 'report without a review: shape');
      const s9t = textsOf(R, noRv, imp).filter((x) => x[0] === 'S9' && x[1] === 'verdict').map((x) => x[2]);
      assert(s9t.length === 1 && /^⚠ The automated rule-based review has not been run/.test(s9t[0]), 'S9 without a review: ' + JSON.stringify(s9t));
      assert(!textsOf(R, noRv, imp).some((x) => x[0] === 'S9' && /^✓/.test(x[2])), 'no ✓ in S9 without a review');
      assert(!textsOf(R, noRv, imp).some((x) => /—\s*$/.test(x[2]) && /Findings that need a decision/.test(x[2])), 'S11 does not show a blank open count');
    },
  },
  {
    name: 'RV10 every ReportModel number is a Value with a ref; check() uses v, not text (imperial and metric give the same result)',
    wp: WP,
    opts: false,
    run(app, assert) {
      const R = Rcal();
      const REF = /^(B\d+·)?[QDRWILMACUKTVO]\d+(:[A-Za-z0-9_.[\]]+)?$/;
      CASE_LABELS.forEach((label, k) => {
        const { an, idx, rv, model } = prepared(label);
        let nums = 0;
        (function walk(o, p, inValue, inChart) {
          if (typeof o === 'number') { if (!inValue && !inChart) assert.fail('case ' + k + ': bare number at ' + p); nums++; return; }
          if (Array.isArray(o)) { o.forEach((x, i) => walk(x, p + '[' + i + ']', inValue, inChart)); return; }
          if (o && typeof o === 'object') {
            const v = isValue(o);
            if (v) assert(REF.test(o.ref), 'case ' + k + ': ref ' + o.ref + ' at ' + p);
            Object.keys(o).forEach((key) => walk(o[key], p + '.' + key, inValue || v, inChart || o.kind === 'chart'));
          }
        })(model, 'model', false, false);
        assert(nums > 300, 'case ' + k + ': ' + nums + ' numbers seen');
        // templates bind numbers only through values: no digits except evidence and test ids and the fixed "30 days"
        const ID = /\b(?:B\d+·)?[QDRWILMACUKTVOEF]\d+\b|\bK[LKCH]\d\b|\bS(?:1[0-2]|[1-9])\b|\b30 days\b|\bpwf0\b|\blog10\b/g;
        const tpls = [];
        blocksOf(model).forEach(([, b]) => {
          if (b.template) tpls.push(b.template);
          if (b.kind === 'kv') b.rows.forEach((r) => { if (r.value && r.value.template) tpls.push(r.value.template); });
        });
        tpls.forEach((tp) => assert(!/\d/.test(tp.replace(/\{\w+\}/g, '').replace(ID, '')), 'case ' + k + ': digit in a template: ' + tp));
        const chk = R.check(model, an, idx, { review: rv });
        assert.strictEqual(chk.ok, true, 'case ' + k + ': the model passes its evidence check ' + JSON.stringify(plain(chk.failures).slice(0, 3)));
        assert(chk.nChecked > 300, 'case ' + k + ': ' + chk.nChecked + ' values checked');
      });
      // check() reads v: a change below half a displayed unit passes, above it fails; formatters play no part
      const an = S.FIX.analysis, idx = R.evidence(an), rv = R.run(an, idx, { at: AT });
      const model = R.report(an, rv, null, null, imp);
      const kpi = model.sections[0].blocks.find((b) => b.kind === 'kpi').items.find((i) => i.label === 'Latest skin').value;
      assert.strictEqual(kpi.dp, 2);
      const r0 = JSON.stringify(R.check(model, an, idx));
      const tImp = textsOf(R, model, imp).map((x) => x[2]).join('\n'), tMet = textsOf(R, model, met).map((x) => x[2]).join('\n');
      assert.notStrictEqual(tImp, tMet, 'the two formatters render differently');
      assert.strictEqual(JSON.stringify(R.check(model, an, idx)), r0, 'rendering with either formatter does not change the check');
      const v0 = kpi.v;
      kpi.v = v0 + 0.004;
      assert.strictEqual(R.check(model, an, idx).ok, true, 'below half a unit (0.005): ok');
      kpi.v = v0 + 0.006;
      const bad = R.check(model, an, idx);
      assert.strictEqual(bad.ok, false, 'above half a unit: fails');
      assert.strictEqual(bad.failures[0].tol, 0.005);
      assert.strictEqual(R.fmtValue(kpi, met), R.fmtValue(kpi, imp), 'skin is untagged: both formatters show the same text');
      const kv = model.sections[0].blocks.find((b) => b.kind === 'kpi').items.find((i) => i.label === 'k (baseline median)').value;
      assert.notStrictEqual(R.fmtValue(kv, met), R.fmtValue(kv, imp), 'k is tagged (permeability)');
    },
  },
  {
    name: 'RV11 with a metric formatter, report, finding and answer text contains no psi, ft or STB',
    wp: WP,
    opts: false,
    run(app, assert) {
      const R = load({ cal: S.FIX.cal }).R;
      [S.FIX.analysis, manyVariant(), variant('V9', 'V13', 'V25')].forEach((an, k) => {
        const idx = R.evidence(an), rv = R.run(an, idx, { at: AT });
        R.applyDecisions(rv, rv.findings.map((f) => ({ target: f.key, d: 'note', note: 'Noted.', who: 'Reviewer B', at: AT })));
        const so = k === 0 ? R.signoff({ name: 'Reviewer B', role: 'Reservoir engineer', statement: true, at: AT }, an, rv) : null;
        const model = R.report(an, rv, null, so && so.ok ? so : null, met);
        const report = textsOf(R, model, met).map((x) => x[2]);
        const findings = rv.findings.map((f) => R.fill(f.template, f.values, met));
        const answers = [].concat(...Object.values(QA)).map((q) => { const a = R.ask(q, an, idx, met); return R.fill(a.template, a.values, met); });
        [['report', report], ['finding', findings], ['answer', answers]].forEach(([what, list]) => {
          list.forEach((t) => assert(!IMPERIAL_UNITS.test(t), 'case ' + k + ' ' + what + ' text has an imperial unit: ' + JSON.stringify((t.match(/.{0,40}(\bpsia?\b|\bft\b|\bSTB\b|\bbbl\b|\bmd\b).{0,20}/) || [t])[0])));
        });
        assert(textsOf(R, model, imp).map((x) => x[2]).some((t) => /\bpsi\b/.test(t)) && answers.length === 76, 'case ' + k + ': the imperial render does show psi (sanity)');
        assert(report.some((t) => /\bkPa\b/.test(t)) && report.some((t) => /\bmD\b/.test(t)), 'case ' + k + ': metric units are shown');
      });
    },
  },
  {
    name: 'RV12 review.FORMULAS agrees with the shapes FORMULAS on FIX.analysis',
    wp: WP,
    opts: false,
    run(app, assert) {
      const R = R0(), F1 = R.FORMULAS, F2 = S.FORMULAS, an = S.FIX.analysis, sm = S.FIX.samples;
      Object.keys(F2).forEach((k) => {
        assert(typeof F1[k] === 'function', 'review.FORMULAS has ' + k);
        assert.deepStrictEqual(plain(F1[k].args), F2[k].args, k + ': same arguments');
        assert(typeof F1[k].text === 'string' && F1[k].text.length > 3, k + ': has a text');
      });
      const w = an.well, tr = an.trend, L = an.tests[5], Sb = tr.baseline.S, X = tr.pi.X;
      const T = {};
      const add = (k, args) => { (T[k] = T[k] || []).push(args); };
      an.tests.forEach((t) => {
        const r = t.result, f = r.final, sw = t.spec.well, dteEnd = r.bins.dte[r.bins.dte.length - 1];
        add('m', [t.spec.Dq, sw.B, sw.mu, f.k, sw.h]); add('mPrime', [f.m]); add('dpSkin', [f.m, f.S]); add('piRatio', [X, f.S]);
        add('rinv', [f.k, t.dtEnd_h, sw.phi, sw.mu, sw.ct]); add('rinv', [f.k, dteEnd, sw.phi, sw.mu, sw.ct]);
        add('dte', [t.dtEnd_h, 1665]); add('shutOfDte', [dteEnd, 1665]); add('shutOfDte', [2000, 1665]); add('xOfDte', [dteEnd]); add('dteOfX', [Math.log10(dteEnd)]);
        add('logTerm', [f.k, sw.phi, sw.mu, sw.ct, sw.rw]); add('pStar', [t.pwf0, f.m, 1665, F2.logTerm(f.k, sw.phi, sw.mu, sw.ct, sw.rw), f.S]); add('p1hr', [f.pStar || 3999, f.m, 1665]);
        add('reachFair', [r.reach.t5_h, 0.1]); add('reachGood', [r.reach.t5_h, 0.1]); add('sTc', [t.spec.dpdt_flow, t.spec.dtc_h, f.m]); add('sPwf', [t.spec.pwf0SE, f.m]);
        add('rDrift', [w.driftPsiPerDay, t.dtEnd_h, f.mPrime]);
        if (r.line) add('dkPct', [r.line.k, f.k]);
        r.sensitivity.req.concat(r.sensitivity.typ).forEach((row) => { add('sensDS', [row.input, row.f]); add('sensK', [row.input, row.f, f.k]); });
        if (r.kHeld) add('sKAnalytic', [r.kHeld.delta, r.bins.dp[r.bins.dp.length - 1], f.m]);
        add('jPred', [an.baseline.k, w.h, w.B, w.mu, X, f.S]);
      });
      add('X', [tr.pi.re_ft, w.rw]); add('rateAtStake', [L.Dq, X, L.result.final.S, Sb]);
      add('extraDrawdown', [L.Dq, w.B, w.mu, L.result.final.S - Sb, L.result.final.k, w.h]);
      an.rates.days.filter((d) => d.cls === 'clean').forEach((d) => { add('atStakeDay', [d.q, X, L.result.final.S, Sb]); add('jObs', [d.q, 4000, d.pwfMean_psia]); });
      const B1 = an.tests[0].result, B3 = an.tests[2].result;
      add('modelFreeDS', [B3.bins.dp[30], an.tests[2].Dq, B1.bins.dp[30], an.tests[0].Dq, B1.final.m / an.tests[0].Dq, B3.bins.dte[30], B1.bins.dte[30]]);
      add('kStar', [sm.SynthCase.spec.truth, sm.SynthCase.spec.given, 1]); add('SStar', [sm.SynthCase.spec.truth, sm.SynthCase.spec.given, 0.97]);
      let n = 0;
      Object.keys(F2).forEach((k) => {
        assert(T[k] && T[k].length, k + ' is exercised');
        T[k].forEach((args) => {
          const a = F1[k](...args), b = F2[k](...args);
          if (b === null) assert.strictEqual(a, null, k + ' null');
          else assert.rel(a, b, 1e-12, k + '(' + args.map((x) => (typeof x === 'object' ? 'obj' : x)).join(', ') + ')');
          n++;
        });
      });
      assert(n > 300, n + ' formula evaluations compared');
      // the stored derived numbers of FIX equal the review registry at display precision
      an.tests.forEach((t) => {
        const r = t.result, f = r.final, sw = t.spec.well;
        assert(S.nearDisplay('m', f.m, F1.m(t.spec.Dq, sw.B, sw.mu, f.k, sw.h)), t.id + ' m');
        assert(S.nearDisplay('dpSkin_psi', f.dpSkin_psi, F1.dpSkin(f.m, f.S)), t.id + ' Δp_skin');
        assert(S.nearDisplay('rinv_ft', f.rinv_ft, F1.rinv(f.k, t.dtEnd_h, sw.phi, sw.mu, sw.ct)), t.id + ' r_inv');
        assert(S.nearDisplay('sAbs', r.sErr.sAbs, F1.rss(r.sErr.value, r.sErr.sSens)), t.id + ' sAbs');
        r.sensitivity.req.forEach((row) => { assert(S.nearDisplay('dkPct', row.dkPct, F1.sensDkPct(row.input, row.f)), t.id + ' dkPct ' + row.input); assert(S.nearDisplay('dS', row.dS, F1.sensDS(row.input, row.f)), t.id + ' dS ' + row.input); });
      });
      assert(S.nearDisplay('ratioNow', tr.pi.ratioNow, F1.piRatio(X, L.result.final.S)));
      assert(S.nearDisplay('rateAtStake', tr.pi.rateAtStake, F1.rateAtStake(L.Dq, X, L.result.final.S, Sb)));
      assert(S.nearDisplay('X', tr.pi.X, F1.X(tr.pi.re_ft, w.rw)));
    },
  },
  {
    name: 'RV13 the audit chain verifies; folding beyond 500 entries keeps the chain',
    wp: WP,
    opts: false,
    run(app, assert) {
      const R = R0(), A = R.audit, AI = S.autoInterp();
      const iso = (i) => new Date(Date.UTC(2026, 6, 1) + i * 60000).toISOString();
      const entry = (i) => ({ kind: i % 7 === 0 ? 'override' : i % 5 === 0 ? 'decision' : 'run', who: 'Engineer A', at: iso(i), target: 'B' + ((i % 6) + 1), value: { i, x: i / 3 },
                              reason: 'Audit entry number ' + i + '.', appVersion: '3.3', inputsHash: '0123456789abcdef', resultsHash: 'fedcba9876543210' });
      let log = null;
      for (let i = 1; i <= 520; i++) log = A.append(log, entry(i));
      assert.strictEqual(log.entries.length, 500, '500 entries kept');
      assert.deepStrictEqual(plain([log.summary.from, log.summary.to, log.summary.n]), [1, 20, 20], 'the oldest 20 folded into the summary');
      assert.strictEqual(Object.values(log.summary.counts).reduce((s, x) => s + x, 0), 20, 'folded entries counted by kind');
      assert.strictEqual(log.entries[0].seq, 21); assert.strictEqual(log.entries[0].prevHash, log.summary.chainHash, 'the chain continues from the summary');
      let v = A.verify(log);
      assert.strictEqual(v.ok, true, 'verifies after folding: ' + v.reason); assert.strictEqual(v.folded, 20); assert.strictEqual(v.head, log.entries[499].hash);
      assert.strictEqual(A.head(log), v.head);
      // hash rule: hash16(prevHash + canon(entry without hash)) with file 53, every numeric leaf serialised exactly first (lossless)
      const exact = (v) => (typeof v === 'number' ? 'n:' + String(v) : Array.isArray(v) ? v.map(exact)
        : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).map((k) => [k, exact(v[k])])) : v);
      const e = log.entries[123], copy = Object.assign({}, e); delete copy.hash;
      assert.strictEqual(e.hash, AI.hash16(e.prevHash + AI.canon(exact(copy), 'inputs')), 'entry hash = hash16(prevHash + canon(entry, numbers exact))');
      // an edit at the 7th significant digit of an entry value (canon 'inputs' keeps 6) still breaks the chain
      const d7 = clone(log), x0 = d7.entries[20].value.x;
      d7.entries[20].value.x = Number((x0 * (1 + 3e-7)).toPrecision(9));
      assert.notStrictEqual(d7.entries[20].value.x, x0); assert.strictEqual(AI.canon(d7.entries[20].value.x, 'inputs'), AI.canon(x0, 'inputs'), 'the change is below canon’s 6 figures');
      v = A.verify(d7); assert.strictEqual(v.ok, false, 'a 7th-digit edit breaks the chain'); assert.strictEqual(v.brokenAt, d7.entries[20].seq);
      // folding again keeps from = 1 and the chain
      for (let i = 521; i <= 560; i++) log = A.append(log, entry(i));
      assert.deepStrictEqual(plain([log.summary.from, log.summary.to, log.summary.n, log.entries.length]), [1, 60, 60, 500]);
      assert.strictEqual(A.verify(log).ok, true, 'second fold verifies');
      // an edited, removed or reordered entry breaks the chain
      const ed = clone(log); ed.entries[10].reason = 'edited later';
      v = A.verify(ed); assert.strictEqual(v.ok, false); assert.strictEqual(v.brokenAt, ed.entries[10].seq);
      const rm = clone(log); rm.entries.splice(42, 1);
      assert.strictEqual(A.verify(rm).ok, false, 'a removed entry breaks the chain');
      const sw = clone(log); sw.summary.chainHash = '0000000000000000';
      assert.strictEqual(A.verify(sw).ok, false, 'a changed summary chain hash breaks the chain');
      // a size cap folds more; the chain still verifies
      const small = A.fold(log, { maxBytes: 20000 });
      assert(small.entries.length < 500 && small.summary.n === 560 - small.entries.length, 'size cap folds the oldest');
      assert.strictEqual(A.verify(small).ok, true);
      // the report shows the chain head and the folded count (S10), and reads decisions from the log
      const an = S.FIX.analysis, rv = R.run(an, null, { at: AT });
      const model = R.report(an, rv, log, null, imp);
      const s10 = model.sections.find((s) => s.id === 'S10');
      const kv = s10.blocks.find((b) => b.kind === 'kv').rows.find((r) => r.label === 'Audit chain');
      assert.strictEqual(R.fill(kv.value.template, kv.value.values, imp), A.head(log) + ' (60 folded entries)');
      const at = s10.blocks.find((b) => b.id === 'bu_tbl_audit');
      assert.strictEqual(at.rows.length, 30, 'S10 lists the latest 30 entries'); assert.strictEqual(at.rows[29][0], '#560');
      assert(R.check(model, an, R.evidence(an), { review: rv, audit: log }).ok, 'chain values pass the evidence check with the audit context');
      assert.strictEqual(plain(A.decisions(log)).length, log.entries.filter((x) => x.kind === 'decision').length, 'decision entries read back');
    },
  },
  {
    name: 'RV14 the evidence check uses full-precision stored values: inputs that display differently raise no V14',
    wp: WP,
    opts: false,
    run(app, assert) {
      const R = R0(), an = S.FIX.analysis, t = an.tests[0], f = t.result.final;
      f.S = 1.005;                                         // displays as 1.00 (binary 1.00499…)
      f.dpSkin_psi = 0.8686 * f.m * f.S;                   // stored at full precision, as the engine does
      an.trend.skinDp.find((r) => r.id === t.id).dpSkin_psi = f.dpSkin_psi;   // T7 carries the same stored number
      // the rounded-input recomputation would disagree at display precision (so this test is meaningful)
      const fromDisplayed = 0.8686 * Number(f.m.toFixed(1)) * Number(f.S.toFixed(2));
      assert(Math.abs(fromDisplayed - f.dpSkin_psi) > 0.05, 'displayed inputs give a different Δp_skin (' + fromDisplayed.toFixed(2) + ' vs ' + f.dpSkin_psi.toFixed(2) + ')');
      const idx = R.evidence(an), rv = R.run(an, idx, { at: AT });
      const model = R.report(an, rv, null, null, imp);
      assert(!rv.findings.some((x) => x.rule === 'V14'), 'no V14');
      const chk = R.check(model, an, idx, { review: rv });
      assert.strictEqual(chk.ok, true, JSON.stringify(plain(chk.failures).slice(0, 3)));
      const dp = { v: f.dpSkin_psi, cat: 'pressure', dp: 1, ref: 'B1·A2:dpSkin_psi' };
      assert.strictEqual(R.check({ values: { dp } }, an, idx).ok, true, 'Δp_skin recomputed from the full-precision m and S');
      assert(idx.items['B1·A2'].values.dpSkin_psi.formula, 'Δp_skin is a derived (recomputed) value');
      // a quote and a stored value that straddle a display boundary (1.00 vs 1.01) but differ by 2e-7 pass
      f.S = 1.0050001;
      const q = { v: 1.0049999, cat: null, dp: 2, ref: 'B1·A2:S' };
      assert.notStrictEqual(q.v.toFixed(2), f.S.toFixed(2), 'the two display differently');
      assert.strictEqual(R.check({ values: { q } }, an, idx).ok, true, 'no false failure at a rounding boundary');
      // while a real change of one displayed unit fails
      assert.strictEqual(R.check({ values: { q: Object.assign({}, q, { v: 1.0150001 }) } }, an, idx).ok, false, 'a change of one displayed unit fails');
      // derived values from full-precision inputs: k from the IARF level and the mean point skin re-derive without V23/V24
      assert(!rv.findings.some((x) => x.rule === 'V23' || x.rule === 'V24'), 'no V23/V24 on FIX');
    },
  },
  {
    name: 'RV15 a stored derived number that disagrees with FORMULAS raises V14 from run() and report(); the page shows the stored number',
    wp: WP,
    opts: false,
    run(app, assert) {
      const R = R0(), F = R.FORMULAS;
      // FIX is engine-consistent: every stored derived value recomputes, none raises V14, and the T8 cumulative is re-derived
      const an0 = S.FIX.analysis, idx0 = R.evidence(an0), rv0 = R.run(an0, idx0, { at: AT });
      assert(!rv0.findings.some((f) => f.rule === 'V14'), 'no V14 on FIX');
      const stored = [];
      Object.keys(idx0.items).forEach((id) => Object.keys(idx0.items[id].values).forEach((n) => { if (idx0.items[id].values[n].stored) stored.push(id + ':' + n); }));
      ['B6·A2:m', 'B6·A2:mPrime', 'B6·A2:dpSkin_psi', 'B6·A2:rinv_ft', 'B6·A2:rinvE_ft', 'B6·I1:cycles', 'B6·U1:sAbs', 'B6·U2:req0_dS', 'B6·U2:req0_dkPct',
        'T7:B1_dpSkin', 'T7:B6_dpSkin', 'T8:X', 'T8:ratioNow', 'T8:ratioBase', 'T8:rateAtStake', 'T8:extraDrawdown_psi', 'T8:cumAtStake']
        .forEach((ref) => assert(stored.indexOf(ref) !== -1, ref + ' is a stored derived value (got ' + stored.length + ')'));
      assert(rv0.evidenceCheck.nChecked >= stored.length, 'the review checks every stored derived value (' + rv0.evidenceCheck.nChecked + ')');
      assert.rel(F.cumAtStake(an0), an0.trend.pi.cumAtStake, 1e-9, 'T8 cumulative re-derived from the stored series, onset and days');
      // each stored value moved by more than half a displayed unit (and only that value): V14 names it, from run() and from report()
      const at = (a, id) => a.tests.find((t) => t.id === id);
      const T7row = (a, id) => a.trend.skinDp.find((r) => r.id === id);
      const EDITS = [
        ['B6·A2:m', (a) => { at(a, 'B6').result.final.m *= 1.5; }],
        ['B6·A2:mPrime', (a) => { at(a, 'B6').result.final.mPrime *= 1.1; }],
        ['B6·A2:dpSkin_psi', (a) => { at(a, 'B6').result.final.dpSkin_psi *= 2; }],
        ['B6·A2:rinv_ft', (a) => { at(a, 'B6').result.final.rinv_ft *= 2; }],
        ['B6·A2:rinvE_ft', (a) => { at(a, 'B6').result.final.rinvE_ft *= 2; }],
        ['B6·I1:cycles', (a) => { at(a, 'B6').result.iarf.cycles += 0.1; }],
        ['B6·U1:sAbs', (a) => { at(a, 'B6').result.sErr.sAbs *= 2; }],
        ['B6·U2:req0_dS', (a) => { at(a, 'B6').result.sensitivity.req[0].dS *= 5; }],
        ['B6·U2:req0_dkPct', (a) => { at(a, 'B6').result.sensitivity.req[0].dkPct += 5; }],
        ['T7:B6_dpSkin', (a) => { T7row(a, 'B6').dpSkin_psi *= 2; }],
        ['T7:B1_dpSkin', (a) => { T7row(a, 'B1').dpSkin_psi *= 2; }],
        ['T8:X', (a) => { a.trend.pi.X += 1; }],
        ['T8:ratioNow', (a) => { a.trend.pi.ratioNow = 0.1; }],
        ['T8:ratioBase', (a) => { a.trend.pi.ratioBase *= 0.5; }],
        ['T8:rateAtStake', (a) => { a.trend.pi.rateAtStake *= 3; }],
        ['T8:extraDrawdown_psi', (a) => { a.trend.pi.extraDrawdown_psi *= 3; }],
        ['T8:cumAtStake', (a) => { a.trend.pi.cumAtStake *= 3; }],
      ];
      const before = plain(rv0);                                  // the review of the unedited analysis (plain data)
      EDITS.forEach(([ref, edit]) => {
        const a = S.FIX.analysis; edit(a);
        const rv = R.run(a, null, { at: AT }), v14 = rv.findings.filter((f) => f.rule === 'V14');
        assert(v14.some((f) => f.values.ref.v === ref), ref + ': run() raises V14 for it (got ' + v14.map((f) => f.values.ref.v).join(', ') + ')');
        assert.strictEqual(rv.evidenceCheck.ok, false, ref + ': evidence check failed');
        assert.strictEqual(R.canSign(rv).ok, false, ref + ': not signable');
        // the report path: a review run before the edit gains V14 when the report is built on the edited analysis
        const rvb = clone(before);
        R.report(a, rvb, null, null, imp);
        assert(rvb.findings.some((f) => f.rule === 'V14' && f.values.ref.v === ref), ref + ': report() adds V14 for it');
      });
      // the page shows the engine's stored number (not the review's own recomputation)
      const a = S.FIX.analysis; a.trend.pi.ratioNow = 0.1;
      const idx = R.evidence(a), m = R.report(a, R.run(a, idx, { at: AT }), null, null, imp);
      assert.strictEqual(idx.items.T8.values.ratioNow.v, 0.1, 'T8 ratioNow quotes the stored 0.1');
      const s5 = m.sections.find((s) => s.id === 'S5').blocks.find((b) => b.kind === 'kv').rows.find((r) => /^PI ratio/.test(r.label));
      assert.strictEqual(s5.value.values.now.v, 0.1, 'S5 shows the stored PI ratio');
      const s9 = m.sections.find((s) => s.id === 'S9');
      assert(s9.blocks.some((b) => b.kind === 'verdict' && /^✗ Evidence check/.test(R.fill(b.template, b.values, imp))), 'S9 reports the failed evidence check');
      // a stale index passed to report() cannot hide a stored value changed in place (its formula inputs unchanged)
      const c = S.FIX.analysis, ic = R.evidence(c), rvc = R.run(c, ic, { at: AT });
      c.trend.pi.ratioNow = 0.1;
      R.report(c, rvc, null, null, imp, { idx: ic });
      assert(rvc.findings.some((f) => f.rule === 'V14' && f.values.ref.v === 'T8:ratioNow'), 'stale index: the changed stored value is caught');
      // a stored null (engine guard) is quoted as null and raises nothing
      const g = S.FIX.analysis; Object.assign(g.trend.pi, { guard: true, ratioNow: null, ratioBase: null, rateAtStake: null, extraDrawdown_psi: null, cumAtStake: null });
      const rg = R.run(g, null, { at: AT });
      assert(!rg.findings.some((f) => f.rule === 'V14'), 'guarded T8 (stored nulls): no V14');
      // a derived value whose inputs are missing falls back to re-reading the stored field (no false V14)
      const h = S.FIX.analysis; delete h.tests[5].result.final.m;
      const ih = R.evidence(h);
      assert.near(ih.items['B6·A2'].values.m.v, F.m(h.tests[5].spec.Dq, h.tests[5].spec.well.B, h.tests[5].spec.well.mu, h.tests[5].result.final.k, h.tests[5].spec.well.h), 1e-9,
        'nothing stored → the formula value is quoted');
    },
  },
  {
    name: 'RV16 WP9 review fixes: skin change on the baseline basis; decimal-comma questions; plurals; plain labels for codes; limitations never cut or repeated; noise wording',
    wp: WP,
    opts: false,
    run(app, assert) {
      const R = R0();
      const fill = (b) => R.fill(b.template, b.values, imp);
      // (1) gas with D resolved: the baseline is on the rate-corrected basis (series Salert); so is the change since the baseline
      const an = S.FIX.analysis, li = an.tests.map((t) => t.id).lastIndexOf('B6');
      const L = an.tests[li], ser = an.trend.series.find((s) => s.id === L.id);
      ser.Salert = L.result.final.S + 0.75;
      const idx = R.evidence(an), rv = R.run(an, idx, { at: AT }), m = R.report(an, rv, null, null, imp);
      const kpi = m.sections[0].blocks.find((b) => b.kind === 'kpi').items.find((i) => i.label === 'Skin change since the baseline').value;
      assert.near(kpi.v, ser.Salert - an.trend.baseline.S, 1e-9, 'Salert − baseline (both on the rate-corrected basis)');
      const asmt = m.sections[0].blocks.find((b) => b.kind === 'notes' && b.head === 'Assessment');
      assert(/on the rate-corrected basis of the baseline/.test(fill(asmt)), 'the assessment names the basis: ' + fill(asmt));
      assert(R.check(m, an, idx, { review: rv }).ok, 'the model passes its evidence check');
      const plainM = R.report(S.FIX.analysis, null, null, null, imp);
      assert(!/rate-corrected/.test(fill(plainM.sections[0].blocks.find((b) => b.kind === 'notes' && b.head === 'Assessment'))), 'no basis note when the two agree');
      // (2) a decimal comma in a question reads like a point
      const a0 = S.FIX.analysis, i0 = R.evidence(a0);
      const tc = R.ask('What if h is 12,5 % higher?', a0, i0, imp), tp = R.ask('What if h is 12.5 % higher?', a0, i0, imp);
      assert.strictEqual(R.fill(tc.template, tc.values, imp), R.fill(tp.template, tp.values, imp), 'comma = point');
      assert(/12\.5 %/.test(R.fill(tc.template, tc.values, imp)), '12.5 % answered: ' + R.fill(tc.template, tc.values, imp).slice(0, 120));
      const a1 = S.FIX.analysis; a1.trend.alerts.absolute.threshold = 4.5;
      const fc = R.ask('when will skin cross 4,5?', a1, null, imp), fp = R.ask('when will skin cross 4.5?', a1, null, imp);
      assert.strictEqual(R.fill(fc.template, fc.values, imp), R.fill(fp.template, fp.values, imp), 'threshold 4,5 = 4.5');
      // (3) plurals follow the count
      const a2 = S.FIX.analysis; a2.qc.gapCount = 1; a2.qc.longestGap_h = 0.5; a2.qc.gapTotal_h = 0.5;
      const rv2 = R.run(a2, null, { at: AT }); rv2.counts.suggestion = 1;
      const t2 = textsOf(R, R.report(a2, rv2, null, null, imp), imp).map((x) => x[2]).join('\n');
      assert(/\b1 gap, /.test(t2) && /⚠ 1 data gap of /.test(t2), 'one gap: singular');
      assert(/\b1 suggestion\./.test(t2) && !/\b1 suggestions\b/.test(t2), 'one suggestion: singular');
      // (4) codes are shown in words (events table, k-stability reading); the codes stay in the index
      const a3 = S.FIX.analysis; a3.trend.kStability.reading = 'nearWell';
      const m3 = R.report(a3, R.run(a3, null, { at: AT }), null, null, imp), t3 = textsOf(R, m3, imp).map((x) => x[2]).join('\n');
      assert(!/\b(shutin|closingDay|previousDay|nearWell|not_confirmed|too_short|no_alloc|gap_at_closing)\b/.test(t3), 'no engine codes in the report: ' + (t3.match(/\b(shutin|closingDay|nearWell|not_confirmed|too_short)\b/) || [])[0]);
      assert(/reading near-well change/.test(t3), 'k-stability reading in words');
      const evt = m3.sections.find((s) => s.id === 'S3').blocks.find((b) => b.id === 'bu_tbl_events');
      assert(evt.rows.some((r) => r[3] === 'Shut-in'), 'event kind in words');
      assert.strictEqual(R.evidence(a3).items.T9.values.reading.v, 'nearWell', 'the index keeps the code');
      // (5) limitations: every Notes box fits with its references, and no statement is repeated
      const a4 = S.FIX.analysis;
      a4.trend.limitations = (a4.trend.limitations || []).concat([{ code: 'partialCuts', text: 'Partial rate cuts are classified and listed, not interpreted.' },
        { code: 'gradient', text: 'Gradient changes in the wellbore during the build-up are not modelled.' }, { code: 'storage', text: 'Changing wellbore storage is not modelled.' }]);
      const s8 = R.report(a4, null, null, null, imp).sections.find((s) => s.id === 'S8').blocks;
      s8.forEach((b) => assert(fill(b).length + (b.ev && b.ev.length ? 3 + b.ev.join(', ').length : 0) <= 560, 'S8 note with refs ≤ 560: ' + fill(b).length));
      const all8 = s8.map(fill).join(' ');
      assert.strictEqual((all8.match(/gradient changes in the wellbore/gi) || []).length, 1, 'the wellbore-gradient statement once');
      assert.strictEqual((all8.match(/Partial rate cuts/g) || []).length, 1, 'the partial-cut statement once');
      // (6) the noise verdict says what the autocorrelation is of
      const a5 = S.FIX.analysis; a5.qc.noiseCorrelated = true; a5.qc.rho1 = 0.074;
      const nv = textsOf(R, R.report(a5, null, null, null, imp), imp).find((x) => x[0] === 'S2' && /correlated/.test(x[2]));
      assert(nv && /pressure differences 0\.07/.test(nv[2]) && /minus one half/.test(nv[2]), 'noise wording: ' + (nv && nv[2]));
    },
  },
  {
    name: 'RV17 WP9 AI export: with free text, short names, decision and override authors, sign-off and page-supplied names are scrubbed as whole words; d/m/y and month-name dates are removed',
    wp: WP,
    opts: false,
    run(app, assert) {
      const R = R0(), an = S.FIX.analysis;
      an.meta.wellName = 'P7'; an.meta.engineer = 'Bo';
      an.overrides[0].reason = 'Per Bo, P7 gauge swapped.'; an.overrides[0].who = 'Kim Lee';
      const rv = R.run(an, null, { at: AT });
      R.applyDecisions(rv, [{ target: 'V5', d: 'accept', note: 'ok by Bo 3/7/26; Kim agreed on 5 May 2026; checked with Jo Smith.', who: 'Ana Ruiz', at: AT }]);
      const opts = { includeFreeText: true, signoff: { name: 'Sig Ner' }, names: [{ s: 'Jo Smith', role: 'person' }, { s: 'North Field', role: 'well' }] };
      const t = R.aiExport(an, rv, opts).text;
      ['P7', 'Bo', 'Kim', 'Lee', 'Ana', 'Ruiz', 'Jo Smith', '3/7/26', '5 May 2026'].forEach((s) => assert(!new RegExp('(^|[^A-Za-z0-9_])' + s.replace(/\//g, '\\/') + '(?![A-Za-z0-9_])').test(t), 'leaks ' + JSON.stringify(s)));
      assert(/Per the engineer, Well A gauge swapped\./.test(t), 'the reason is scrubbed in place: ' + (t.match(/Override O1[^\n]*/) || [''])[0]);
      assert(/a date/.test(t), 'dates replaced');
      assert(/B6·A2/.test(t) && /\bB6 \|/.test(t), 'evidence and test ids untouched');
      assert(/Well A/.test(t) && /\(de-identified\)/.test(t), 'still de-identified');
      // case-insensitive, whole words only: a name inside another word is not touched
      const an2 = S.FIX.analysis; an2.meta.engineer = 'Al'; an2.overrides[0].reason = 'AL and al checked the alarm log.';
      const t2 = R.aiExport(an2, R.run(an2, null, { at: AT }), { includeFreeText: true }).text;
      assert(/the engineer and the engineer checked the alarm log\./.test(t2), 'whole words, any case: ' + (t2.match(/Override O1[^\n]*/) || [''])[0]);
      // de-identification off: names kept
      assert(R.aiExport(an, rv, { includeFreeText: true, deidentify: false }).text.indexOf('Per Bo, P7') !== -1, 'deidentify:false keeps the text');
    },
  },
  {
    name: 'RV18 WP9 audit: S10 and S11 warn when the chain does not verify (review-format and device-store logs) or an earlier log could not be read; an intact chain gives no warning',
    wp: WP,
    opts: false,
    run(app, assert) {
      const R = R0(), A = R.audit, an = S.FIX.analysis, rv = R.run(an, null, { at: AT });
      let log = null;
      for (let i = 1; i <= 6; i++) log = A.append(log, { kind: 'run', who: 'Engineer A', at: new Date(Date.UTC(2026, 6, 1) + i * 60000).toISOString(), reason: 'entry ' + i });
      const warns = (m, sid) => m.sections.find((s) => s.id === sid).blocks.filter((b) => b.kind === 'verdict' && /Audit trail|audit trail/.test(b.template)).map((b) => String(R.fill(b.template, b.values, imp)));
      const ok = R.report(an, rv, log, null, imp);
      assert.deepStrictEqual(plain(warns(ok, 'S10')), [], 'intact chain: no warning');
      const ed = clone(log); ed.entries[2].reason = 'edited later';
      const m = R.report(an, rv, ed, null, imp);
      assert.deepStrictEqual(plain(warns(m, 'S10')), ['⚠ Audit trail does not verify at entry #3: it was edited or damaged after it was written.'], 'S10 names the entry');
      assert.strictEqual(warns(m, 'S11').length, 1, 'S11 repeats the warning');
      assert(R.check(m, an, R.evidence(an), { review: rv, audit: ed }).ok, 'the warning passes the evidence check');
      // the page's form: an entry array carrying the device store's summary (from / to are times, toSeq the last folded seq)
      const dev = clone(log).entries.slice(2);
      dev.summary = { from: log.entries[0].at, to: log.entries[1].at, n: 2, fromSeq: 1, toSeq: 2, counts: { run: 2 }, chainHash: log.entries[1].hash };
      assert.deepStrictEqual(plain(warns(R.report(an, rv, dev, null, imp), 'S10')), [], 'a folded device log verifies from its summary');
      const kv = R.report(an, rv, dev, null, imp).sections.find((s) => s.id === 'S10').blocks.find((b) => b.kind === 'kv').rows.find((r) => r.label === 'Audit chain');
      assert(/\(2 folded entries\)$/.test(R.fill(kv.value.template, kv.value.values, imp)), 'folded count from the device summary');
      const lost = clone(log).entries; lost.lost = { at: AT, key: 'wts_buildup_audit_corrupt_1782900000000', chars: 812 };
      assert(/could not be read; its text is kept as wts_buildup_audit_corrupt_1782900000000/.test(warns(R.report(an, rv, lost, null, imp), 'S10').join(' ')), 'an earlier unreadable log is reported');
    },
  },
];
