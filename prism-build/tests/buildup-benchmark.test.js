// Build-up Surveillance — benchmark acceptance (docs/BUILDUP-SURVEILLANCE-PLAN.md §5.6, §9 WP8).
//
//   BM1  the 10 fixed seeds (hom short, hom long, fault seen, comp, closed, gas, inj, dualpor, partial, baddata), generated
//        with the lite settings (60 s sampling, ≤ 30 days), end to end through the pipeline with the calibrated file 55:
//        the snapshot outcomes recorded by buildup-validate.js --write (status, k/S and headline labels, fully right) and,
//        for every interpreted seed, the evidence still at least 0.1 (normalised) from every calibrated threshold, so the
//        snapshot cannot flip on a last-bit difference
//   BM2  no "high" case is wrong: every BM1 seed, every in-app case of file 55 and the recorded high lite cases whose
//        expected label is high are re-run, and one recorded sequence well (lite; the sequence tests carry almost every
//        pooled high label); each recorded case gets its calibrated label, a high k/S label has k and S right, and a high
//        headline label is fully right (every test of the sequence the run labels high is checked)
//   BM3  the page's 24-case check repeats the calibration run: with file 55's first three in-app cases, the check reports
//        "3 of 3 cases as expected" (lite case, the generator's own AnalysisInput, synth.scoreAnalysis)
//   BM4  a wrong expectation is reported as different, never as a pass: two in-app cases whose labels were replaced give
//        "⚠ 0 of 2 cases as expected; different: seeds …" (no ✓; BM3 covers the as-expected path)
//   BM5  PRiSM_autoInterp.nearThreshold: "near a threshold" only when the evidence is within the selection margin (0.1) of a
//        calibrated threshold and moving that one threshold by 0.1 reproduces the expected labels; confidence().rates
//        quote the single-build-up row of the label next to the pooled rate
//
// SNAPSHOT, HIGH and HIGH_SEQ are <out>/benchmark-snapshot.js of the buildup-validate.js --sequences --write run that wrote
// file 55 (the same tables are in <out>/calibration.md); regenerate them together. The full benchmark (640 single cases, 120 sequences) runs only in buildup-validate.js. Budget ≤ 9 s.
'use strict';

const WP = 'BU8';

// slot, seed, expected {status, ks, headline, fullyRight}; margin as recorded (null: judged on the status alone)
const SNAPSHOT = [
  // BM1-SNAPSHOT (buildup-validate.js --sequences --write, 2026-11-01)
  { slot: 'hom short', seed: 100078, expect: { status: 'interpreted', ks: 'low', headline: 'low', fullyRight: false }, margin: 1 },
  { slot: 'hom long', seed: 100224, expect: { status: 'interpreted', ks: 'medium', headline: 'medium', fullyRight: true }, margin: 0.419 },
  { slot: 'fault seen', seed: 100232, expect: { status: 'interpreted', ks: 'low', headline: 'low', fullyRight: false }, margin: 0.331 },
  { slot: 'comp', seed: 100332, expect: { status: 'interpreted', ks: 'low', headline: 'low', fullyRight: false }, margin: 0.135 },
  { slot: 'closed', seed: 100376, expect: { status: 'interpreted', ks: 'low', headline: 'low', fullyRight: false }, margin: 0.753 },
  { slot: 'gas', seed: 100390, expect: { status: 'interpreted', ks: 'low', headline: 'low', fullyRight: false }, margin: 0.957 },
  { slot: 'inj', seed: 100485, expect: { status: 'interpreted', ks: 'low', headline: 'low', fullyRight: false }, margin: 0.851 },
  { slot: 'dualpor', seed: 100498, expect: { status: 'interpreted', ks: 'low', headline: 'low', fullyRight: false }, margin: 1.125 },
  { slot: 'partial', seed: 100619, expect: { status: 'partial', ks: null, headline: null, fullyRight: true }, margin: null },
  { slot: 'baddata', seed: 100628, expect: { status: 'missed', ks: null, headline: null, fullyRight: true }, margin: null },
];
// lite cases the calibrated table labels high (k/S or headline), margin ≥ 0.1 — re-run by BM2 with the in-app cases
const HIGH = [
  // BM2-HIGH (buildup-validate.js --sequences --write, 2026-11-01): every hom and gas lite seed with a high label at margin ≥ 0.1
  { seed: 100418, stratum: 'gas', expect: { status: 'interpreted', ks: 'high', headline: 'high', fullyRight: true }, margin: 0.324 },
  { seed: 100092, stratum: 'hom', expect: { status: 'interpreted', ks: 'high', headline: 'medium', fullyRight: true }, margin: 0.333 },
  { seed: 100111, stratum: 'hom', expect: { status: 'interpreted', ks: 'high', headline: 'medium', fullyRight: true }, margin: 0.333 },
  { seed: 100153, stratum: 'hom', expect: { status: 'interpreted', ks: 'high', headline: 'medium', fullyRight: true }, margin: 0.333 },
  { seed: 100395, stratum: 'gas', expect: { status: 'interpreted', ks: 'high', headline: 'medium', fullyRight: true }, margin: 0.333 },
  { seed: 100567, stratum: 'wbschange', expect: { status: 'interpreted', ks: 'high', headline: 'medium', fullyRight: true }, margin: 0.291 },
];

// a sequence well (lite) whose tests the calibrated table labels high, margin ≥ 0.1 — re-run by BM2
const HIGH_SEQ = { seed: 200036, tests: [
  // BM2-SEQUENCE (buildup-validate.js --sequences --write, 2026-11-01): the tests labelled high at margin ≥ 0.1 (truth index)
  { truthIdx: 0, expect: { status: 'interpreted', ks: 'high', headline: 'medium', fullyRight: true }, margin: 0.333 },
  { truthIdx: 2, expect: { status: 'interpreted', ks: 'high', headline: 'high', fullyRight: true }, margin: 0.333 },
  { truthIdx: 6, expect: { status: 'interpreted', ks: 'high', headline: 'high', fullyRight: true }, margin: 0.333 },
  { truthIdx: 7, expect: { status: 'interpreted', ks: 'high', headline: 'medium', fullyRight: true }, margin: 0.333 },
] };

let _env = null;
function env(ctx) {
  if (_env) return _env;
  const app = ctx.loadApp({ console: 'errors' });
  const W = app.win, B = W.WTS_buildup || {};
  _env = { app, W, SY: B.synth, RUN: B.run, AI: W.PRiSM_autoInterp, cal: W.PRiSM_autoInterpCal, runs: {} };
  return _env;
}
function runSeed(e, seed) {
  if (e.runs[seed]) return e.runs[seed];
  const sc = e.SY.generate(e.SY.caseFromSeed(seed, { lite: true }));
  const an = e.RUN.analyse(e.SY.toInput(sc), { cache: null });
  const m = e.SY.scoreAnalysis(an, sc);
  const ev = m.test && m.test.result ? m.test.result.evidence : null;
  const out = { score: JSON.parse(JSON.stringify(m.score)), evidence: ev ? JSON.parse(JSON.stringify(ev)) : null };
  e.runs[seed] = out;
  return out;
}
const lab = (s) => (s.label ? { ks: s.label.ks, headline: s.label.headline } : { ks: null, headline: null });

const fs = require('fs');
const path = require('path');
const vm = require('vm');

module.exports = [
  {
    name: 'BM1 benchmark: the 10 acceptance seeds (lite) reproduce their calibrated snapshot outcomes — status, k/S and headline labels, fully right — each interpreted seed ≥ 0.1 from every threshold',
    wp: WP, opts: false, timeoutMs: 60000,
    run(app, assert, ctx) {
      const e = env(ctx);
      assert.ok(e.SY && e.RUN && e.AI, 'synth, run and the PRiSM automatic interpretation are loaded');
      assert.ok(e.cal && e.cal.calibrated === true, 'file 55 is calibrated (buildup-validate.js --sequences --write)');
      assert.strictEqual(SNAPSHOT.length, 10, 'ten acceptance seeds');
      assert.deepStrictEqual(SNAPSHOT.map((c) => c.slot), ['hom short', 'hom long', 'fault seen', 'comp', 'closed', 'gas', 'inj', 'dualpor', 'partial', 'baddata'], 'the §5.6 slots');
      SNAPSHOT.forEach((c) => {
        const r = runSeed(e, c.seed), s = r.score, l = lab(s), what = c.slot + ' seed ' + c.seed;
        assert.strictEqual(s.status, c.expect.status, what + ': status');
        assert.strictEqual(l.ks, c.expect.ks, what + ': k/S label');
        assert.strictEqual(l.headline, c.expect.headline, what + ': headline label');
        assert.strictEqual(!!s.fullyRight, c.expect.fullyRight, what + ': fully right');
        if (c.margin !== null) {
          const mg = e.AI.thresholdMargin(r.evidence, e.cal.thresholds);
          assert.ok(mg >= 0.1, what + ': evidence margin ' + mg.toFixed(3) + ' ≥ 0.1 (recorded ' + c.margin + ')');
        }
      });
    },
  },
  {
    name: 'BM2 benchmark: no "high" case is wrong — every BM1 seed and in-app case of file 55 expected high is re-run; high k/S → k and S right, high headline → fully right',
    wp: WP, opts: false, timeoutMs: 60000,
    run(app, assert, ctx) {
      const e = env(ctx);
      assert.ok(e.cal && e.cal.calibrated === true, 'file 55 is calibrated');
      const pool = new Map();
      SNAPSHOT.concat(HIGH).forEach((c) => pool.set(c.seed, c.expect));
      (e.cal.inApp || []).forEach((c) => { if (!pool.has(c.seed)) pool.set(c.seed, c.expect); });
      const highs = Array.from(pool.entries()).filter(([, x]) => x.ks === 'high' || x.headline === 'high');
      assert.ok(highs.length >= 1, 'at least one expected-high case to check (' + pool.size + ' cases in the pool)');
      let nKs = 0, nHd = 0;
      highs.forEach(([seed, x]) => {
        const s = runSeed(e, seed).score, l = lab(s);
        assert.strictEqual(l.ks, x.ks, 'seed ' + seed + ': k/S label as calibrated');
        assert.strictEqual(l.headline, x.headline, 'seed ' + seed + ': headline label as calibrated');
        if (l.ks === 'high') { nKs++; assert.ok(s.ksRight, 'seed ' + seed + ': k/S label high and k, S right (Δk ' + s.dkPct + ' %, ΔS ' + s.dS + ')'); }
        if (l.headline === 'high') { nHd++; assert.ok(s.fullyRight, 'seed ' + seed + ': headline high and fully right'); }
      });
      // the recorded sequence well (lite): its tests carry the pooled high labels; every recorded high test gets its
      // calibrated label, and every test the run labels high (k/S or headline) is right
      const sq = e.SY.generateSequence(HIGH_SEQ.seed, { lite: true }), an = e.RUN.analyse(e.SY.toInput(sq), { cache: null });
      const scored = sq.truth.tests.map((tt) => {
        const truthT = { tc_ms: tt.tc_ms, model: 'homogeneous', kStar: tt.kStar, SStar: tt.SStar, qCorrect: tt.qCorrect, visible: {}, notAnalysable: false, partial: false,
                         distractor: false, stratum: sq.spec.fluid === 'gas' ? 'gas' : 'hom' };
        const m = e.SY.match(an, truthT);
        return e.SY.score(m.test, truthT, { event: m.event });
      });
      HIGH_SEQ.tests.forEach((x) => {
        const s = scored[x.truthIdx], l = lab(s), what = 'sequence ' + HIGH_SEQ.seed + ' test ' + x.truthIdx;
        assert.strictEqual(s.status, x.expect.status, what + ': status');
        assert.strictEqual(l.ks, x.expect.ks, what + ': k/S label as calibrated');
        assert.strictEqual(l.headline, x.expect.headline, what + ': headline label as calibrated');
      });
      scored.forEach((s, i) => {
        const l = lab(s), what = 'sequence ' + HIGH_SEQ.seed + ' test ' + i;
        if (l.ks === 'high') { nKs++; assert.ok(s.ksRight, what + ': k/S label high and k, S right (Δk ' + s.dkPct + ' %, ΔS ' + s.dS + ')'); }
        if (l.headline === 'high') { nHd++; assert.ok(s.fullyRight, what + ': headline high and fully right'); }
      });
      assert.ok(nKs + nHd >= 1, 'a high label was produced and checked (k/S ' + nKs + ', headline ' + nHd + ')');
      assert.ok(nHd >= 3, 'at least three headline-high labels checked (' + nHd + ')');
    },
  },
  {
    name: 'BM3 benchmark: the page\'s 24-case check repeats the calibration run — three in-app cases of file 55 give "3 of 3 cases as expected"',
    wp: WP, opts: false, timeoutMs: 60000,
    async run(app, assert, ctx) {
      const tool = require('../buildup-validate.js');
      const src = fs.readFileSync(path.join(__dirname, '..', '55-prism-autointerp-cal.js'), 'utf8').split('// === SELF-TEST ===')[0];
      const c = { console: { log() {}, warn() {} } }; c.window = c; vm.createContext(c); vm.runInContext(src, c);
      const cal = JSON.parse(JSON.stringify(c.PRiSM_autoInterpCal));
      assert.ok(cal.calibrated === true && cal.inApp.length === 24, 'file 55 calibrated with 24 in-app cases');
      cal.inApp = cal.inApp.slice(0, 3);
      const a = ctx.loadApp({ console: 'errors', sourceOverrides: { '55-prism-autointerp-cal.js': tool.calSource(cal) } });
      const P = a.win.WTS_buildup.page;
      a.hook.nav('buildup'); a.flush(20);
      assert.strictEqual(a.el('bu_val_run').disabled, false, 'the check is enabled with a calibrated file 55');
      a.click('bu_val_run');
      let k = 0;
      while (P.isRunning() && k++ < 200000) await a.flushAsync(1);
      for (let i = 0; i < 4; i++) await a.flushAsync(1);
      const out = String(a.el('bu_val_out').textContent).replace(/\s+/g, ' ').trim();
      assert.match(out, /^✓ 3 of 3 cases as expected\.$/, 'check result: ' + out);
      a.flush(5000);   // the page's debounced snapshot / autosave
      assert.strictEqual(a.pendingTimers(), 0, 'no timers left');
    },
  },
  {
    name: 'BM4 benchmark: the page\'s 24-case check reports a wrong expectation as different, never as a pass — two in-app cases with corrupted labels give "⚠ 0 of 2 cases as expected; different: seeds …"',
    wp: WP, opts: false, timeoutMs: 60000,
    async run(app, assert, ctx) {
      const src = fs.readFileSync(path.join(__dirname, '..', '55-prism-autointerp-cal.js'), 'utf8').split('// === SELF-TEST ===')[0];
      const c = { console: { log() {}, warn() {} } }; c.window = c; vm.createContext(c); vm.runInContext(src, c);
      const cal = JSON.parse(JSON.stringify(c.PRiSM_autoInterpCal));
      // two interpreted BM1 seeds far from every threshold (margin ≥ 0.1), their labels replaced by other labels: a label
      // difference with no threshold near the evidence (the earlier rule counted both as "near a threshold")
      const pickSlot = (slot) => SNAPSHOT.find((x) => x.slot === slot);
      const other = (L) => (L === 'high' ? 'low' : 'high'), otherM = (L) => (L === 'medium' ? 'low' : 'medium');
      const a = pickSlot('dualpor'), b = pickSlot('inj');
      assert.ok(a.margin >= 0.1 && b.margin >= 0.1 && a.expect.status === 'interpreted' && b.expect.status === 'interpreted', 'two interpreted seeds with margin ≥ 0.1');
      cal.inApp = [
        { seed: a.seed, stratum: 'dualpor', expect: Object.assign({}, a.expect, { ks: other(a.expect.ks), headline: other(a.expect.headline) }), margin: a.margin },
        { seed: b.seed, stratum: 'inj', expect: Object.assign({}, b.expect, { ks: otherM(b.expect.ks), headline: otherM(b.expect.headline) }), margin: b.margin }];
      // the cached build with the table replaced on window (BM3 covers the generated-file route; no second in-memory build)
      const ap = ctx.loadApp({ console: 'errors' });
      ap.win.PRiSM_autoInterpCal = ap.toWin(cal);
      const P = ap.win.WTS_buildup.page;
      ap.hook.nav('buildup'); ap.flush(20);
      ap.click('bu_val_run');
      let k = 0;
      while (P.isRunning() && k++ < 200000) await ap.flushAsync(1);
      for (let i = 0; i < 4; i++) await ap.flushAsync(1);
      const out = String(ap.el('bu_val_out').textContent).replace(/\s+/g, ' ').trim();
      assert.ok(!/✓/.test(out), 'no ✓ when a case differs: ' + out);
      assert.match(out, new RegExp('^⚠ 0 of 2 cases as expected; different: seeds ' + a.seed + ', ' + b.seed + '\\.$'), 'check result: ' + out);
      ap.flush(5000);
      assert.strictEqual(ap.pendingTimers(), 0, 'no timers left');
    },
  },
  {
    name: 'BM5 benchmark: nearThreshold — a label difference is "near" only when the evidence is within 0.1 of a threshold AND moving that one threshold by 0.1 reproduces the expected labels',
    wp: WP, opts: false,
    run(app, assert, ctx) {
      const e = env(ctx), AI = e.AI, cal = e.cal, th = cal.thresholds;
      assert.strictEqual(typeof AI.nearThreshold, 'function', 'PRiSM_autoInterp.nearThreshold');
      // an evidence vector every rule labels high with the calibrated table
      const hi = { grade: 'good', noiseWidened: false, span: 1.5, pointSkinSpread: 0.1, agree: true, agreeMode: 'raw', dkPct: 1, dS: 0.1, sErr: 0.2, sErrMode: 'line',
        unitSlope: true, cheldRejectedBoth: false, rateSource: 'allocation', r3: 1.01, r3Status: 'pass', r4: null, r4Status: 'unavailable', dqKnown: true, fRate: 1,
        equalRateAssumed: false, snrD: 3 * th.snrHigh, rDrift: 0.01, rTide: 0.02, tideRemoved: false, flags: [], distractorAtOrBeforeIarf: false, humpAfterIarf: false,
        dtEnd_h: 72, dteEnd_h: 65, t10_h: 1, t5_h: 2, historySensitive: false, outsideEnvelope: false, kHeld: false, kHeldConverged: null, kHeldCorrCS: null,
        kHeldRmsRatio: null, partialSuspect: null, windowLevelInconsistent: null, chosenKey: 'homogeneous', chosenFullySeen: 'n/a', triggers: [],
        dBicChosen: 0, dBicNext: null, boundaryDepends: null };
      const W = (o) => e.app.toWin(o);
      const lab = (ev) => { const r = AI.confidence(W(ev)); return { ks: r.ks, headline: r.headline }; };
      assert.deepStrictEqual(lab(hi), { ks: 'high', headline: 'high' }, 'the vector is high');
      // the quoted rates carry the single-build-up row of the label next to the pooled one (§5.1, §5.7)
      const rq = AI.confidence(W(Object.assign({}, hi, { snrD: 0.97 * th.snrHigh }))).rates;
      const mRow = cal.ksTable.find((x) => x.label === 'medium'), hRow = cal.table.find((x) => x.label === 'medium');
      assert.ok(rq && rq.ks.single && rq.headline.single, 'single-case rows quoted');
      assert.strictEqual(rq.ks.single.n, mRow.single.n); assert.ok(Math.abs(rq.ks.single.rate - mRow.single.rate) < 1e-5, 'k/S medium single rate');
      assert.strictEqual(rq.headline.single.n, hRow.single.n); assert.ok(Math.abs(rq.headline.single.lo - hRow.single.lo) < 1e-5, 'headline medium single lower bound');
      const HIGH = { status: 'interpreted', ks: 'high', headline: 'high' };
      // SNR 3 % below SNR high: medium now; moving SNR high down by 10 % gives high back → near
      const n1 = AI.nearThreshold(W(Object.assign({}, hi, { snrD: 0.97 * th.snrHigh })), cal, W(HIGH));
      assert.deepStrictEqual(lab(Object.assign({}, hi, { snrD: 0.97 * th.snrHigh })), { ks: 'medium', headline: 'medium' });
      assert.ok(n1.near && n1.key === 'snrHigh' && n1.dir === -1 && n1.margin < 0.1, 'near SNR high: ' + JSON.stringify(n1));
      // the same distance, but the label changed by a flag (KH6 unmet whatever the thresholds): not near
      const n2 = AI.nearThreshold(W(Object.assign({}, hi, { snrD: 0.97 * th.snrHigh, flags: ['negLate'] })), cal, W(HIGH));
      assert.ok(!n2.near, 'a flag explains the difference, not a threshold: ' + JSON.stringify(n2));
      // evidence far from every threshold, expectation high, label medium through KC4 (R3 unavailable): not near
      const n3 = AI.nearThreshold(W(Object.assign({}, hi, { r3: null, r3Status: 'unavailable' })), cal, W(HIGH));
      assert.ok(!n3.near && n3.margin >= 0.1, 'a cap far from every threshold: ' + JSON.stringify(n3));
      // the BM1 dualpor seed: evidence far from every threshold, a wrong expectation is never near
      const a = SNAPSHOT.find((x) => x.slot === 'dualpor'), r = runSeed(e, a.seed);
      const n4 = AI.nearThreshold(W(r.evidence), cal, W({ status: a.expect.status, ks: 'high', headline: 'high' }));
      assert.ok(!n4.near && n4.margin >= 0.1, 'dualpor seed ' + a.seed + ': ' + JSON.stringify(n4));
    },
  },
];
