// Build-up Surveillance — benchmark acceptance (docs/BUILDUP-SURVEILLANCE-PLAN.md §5.6, §9 WP8).
//
//   BM1  the 10 fixed seeds (hom short, hom long, fault seen, comp, closed, gas, inj, dualpor, partial, baddata), generated
//        with the lite settings (60 s sampling, ≤ 30 days), end to end through the pipeline with the calibrated file 55:
//        the snapshot outcomes recorded by buildup-validate.js --write (status, k/S and headline labels, fully right) and,
//        for every interpreted seed, the evidence still at least 0.1 (normalised) from every calibrated threshold, so the
//        snapshot cannot flip on a last-bit difference
//   BM2  no "high" case is wrong: every BM1 seed, every in-app case of file 55 and the recorded high lite cases whose
//        expected label is high are re-run; each gets its calibrated label, a high k/S label has k and S right, and a high
//        headline label is fully right
//   BM3  the page's 24-case check repeats the calibration run: with file 55's first three in-app cases, the check reports
//        "3 of 3 cases as expected" (lite case, the generator's own AnalysisInput, synth.scoreAnalysis)
//
// The snapshot is the BM1 table of <out>/calibration.md (buildup-validate.js --sequences --write); regenerate both
// together. The full benchmark (640 single cases, 120 sequences) runs only in buildup-validate.js. Budget ≤ 9 s.
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
  // BM2-HIGH (buildup-validate.js --sequences --write, 2026-11-01)
  { seed: 100418, stratum: 'gas', expect: { status: 'interpreted', ks: 'high', headline: 'high', fullyRight: true }, margin: 0.324 },
  { seed: 100092, stratum: 'hom', expect: { status: 'interpreted', ks: 'high', headline: 'medium', fullyRight: true }, margin: 0.333 },
  { seed: 100111, stratum: 'hom', expect: { status: 'interpreted', ks: 'high', headline: 'medium', fullyRight: true }, margin: 0.333 },
];

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
      assert.ok(nKs + nHd >= 1, 'a high label was produced and checked (k/S ' + nKs + ', headline ' + nHd + ')');
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
];
