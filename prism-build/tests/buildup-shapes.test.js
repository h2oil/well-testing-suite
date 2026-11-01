// Build-up Surveillance — WP0 contract tests (docs/BUILDUP-SURVEILLANCE-PLAN.md §3.13, §9 WP0).
//
//   SH1  every fixture passes its own shape check (all §3.13 names covered); broken copies fail with a path; the WP0
//        resolutions (categorical model params, se/ci95 keys, typed settings, event_add target, Infinity in text)
//   SH2  fixture self-consistency: every derived number equals FORMULAS applied to its stored inputs (display precision),
//        including the X axes (log10 Δt_e), window and shift geometry, p*, p1hr, S_kAnalytic, the trend copies, the T8
//        cumulative, T11, T13, and the one gauge record the analysis is derived from
//   SH3  canon / hash16 vectors: fixed inputs → fixed hex; key order does not matter; a 1e-15 perturbation does not
//        change a display-mode hash; inputs mode rounds to 6 significant figures; the Round-8 build carries file 53
'use strict';

const fs = require('fs');
const path = require('path');
const S = require('./_buildup-shapes');

const WP = 'BU0';

// Apply fn to a deep copy and return the shape errors.
function broken(name, base, fn) { const o = JSON.parse(JSON.stringify(base)); fn(o); return S.checkShape(name, o); }
function expectFail(assert, res, pathPrefix, what) {
  assert.strictEqual(res.ok, false, what + ': a broken copy must fail');
  assert(res.errors.some((e) => e.split(': ')[0] === pathPrefix || e.startsWith(pathPrefix + ': ') || e.startsWith(pathPrefix + '.') || e.startsWith(pathPrefix + '[')),
    what + ': expected an error at ' + pathPrefix + ', got ' + JSON.stringify(res.errors.slice(0, 4)));
}
// Recursively visit every number (path, value, parent, key).
function eachNumber(o, fn, p) {
  if (Array.isArray(o)) o.forEach((v, i) => (typeof v === 'number' ? fn(p + '[' + i + ']', v, o, i) : eachNumber(v, fn, p + '[' + i + ']')));
  else if (o && typeof o === 'object') Object.keys(o).forEach((k) => (typeof o[k] === 'number' ? fn(p + '.' + k, o[k], o, k) : eachNumber(o[k], fn, p + '.' + k)));
}
function reverseKeys(o) {
  if (Array.isArray(o)) return o.map(reverseKeys);
  if (o && typeof o === 'object') { const r = {}; Object.keys(o).reverse().forEach((k) => { r[k] = reverseKeys(o[k]); }); return r; }
  return o;
}
const last = (a) => a[a.length - 1];

module.exports = [
  {
    name: 'SH1 fixtures pass their shape checks (all §3.13 names); broken copies fail with a path',
    wp: WP,
    opts: false,
    run(app, assert) {
      const fx = S.FIX, an = fx.analysis, res = fx.result, sm = fx.samples;
      const covered = new Set();
      const ok = (name, obj, label) => {
        const r = S.checkShape(name, obj);
        assert(r.ok, (label || name) + ' must pass: ' + JSON.stringify(r.errors.slice(0, 6)));
        covered.add(name);
      };
      ok('BuildupResult', res, 'FIX.result');
      ok('Analysis', an, 'FIX.analysis');
      ok('Reach', res.reach); ok('ModelFit', res.models[0]); ok('QC', an.qc); ok('RateHistory', an.rates); ok('Trend', an.trend);
      an.events.forEach((e, i) => ok('Event', e, 'analysis.events[' + i + ']'));
      an.tests.forEach((t, i) => {
        ok('TestEntry', t, 'analysis.tests[' + i + ']');
        ok('BuildupResult', t.result, 'analysis.tests[' + i + '].result');
        if (t.result.kHeld) ok('KHeld', t.result.kHeld, 'analysis.tests[' + i + '].result.kHeld');
      });
      sm.TrendTests.forEach((t, i) => ok('TrendTest', t, 'samples.TrendTests[' + i + ']'));
      ['BuildupSpec', 'GaugeRecord', 'AnalysisInput', 'Review', 'Finding', 'Answer', 'ReportModel', 'CaseSpec', 'SynthCase', 'Score'].forEach((n) => ok(n, sm[n], 'samples.' + n));
      ok('Signoff', sm.Signoff); ok('EvidenceIndex', sm.EvidenceIndex);
      ok('ModelFit', sm.ModelFitFault, 'samples.ModelFitFault (categorical BC in params)');
      ok('Cal', fx.cal, 'FIX.cal');
      assert.deepStrictEqual(S.SHAPE_NAMES.filter((n) => !covered.has(n)), [], 'every §3.13 name has a passing fixture');
      // fixture facts the other work packages build on
      assert.strictEqual(an.tests.length, 6, '6 tests');
      assert.deepStrictEqual(an.tests.filter((t) => t.status === 'excluded').map((t) => t.id), ['B4'], 'one excluded test (override)');
      assert.deepStrictEqual(an.tests.filter((t) => t.result && t.result.kHeld).map((t) => t.id), ['B5'], 'one k-held test');
      assert.strictEqual(an.trend.alerts.delta.status, 'confirmed', 'confirmed delta alert');
      assert.strictEqual(an.trend.alerts.delta.raisedAt, 'B5'); assert.strictEqual(an.trend.alerts.delta.confirmedAt, 'B6');
      assert.strictEqual(res.iarf.grade, 'fair', 'reference case: fair'); assert.strictEqual(res.agreement.agree, true); assert.strictEqual(res.chosen.key, 'homogeneous');

      // every name rejects an empty object and null; unknown names fail
      S.SHAPE_NAMES.forEach((n) => {
        assert.strictEqual(S.checkShape(n, {}).ok, false, n + ' rejects {}');
        assert.strictEqual(S.checkShape(n, null).ok, false, n + ' rejects null');
      });
      assert.strictEqual(S.checkShape('NoSuchShape', {}).ok, false, 'unknown shape');

      // broken copies: each fails with the path of the break
      expectFail(assert, broken('Analysis', an, (o) => { delete o.tests[2].result.iarf.cycles; }), 'tests[2].result.iarf.cycles', 'missing key');
      expectFail(assert, broken('Analysis', an, (o) => { o.tests[1].result.final.k = 'n/a'; }), 'tests[1].result.final.k', 'string in a number field');
      expectFail(assert, broken('Analysis', an, (o) => { o.events[0].tc_ms = 1234.5; }), 'events[0].tc_ms', 'hours where epoch ms are due');
      expectFail(assert, broken('Analysis', an, (o) => { o.tests[0].spec.dt[3] = 0.0123456789; }), 'tests[0].spec.dt[3]', 'stored spec not at 6 significant figures');
      expectFail(assert, broken('Analysis', an, (o) => { o.tests[0].used.trend = !o.tests[0].used.trend; }), 'tests[0].used', 'TestEntry.used not copied from the trend');
      expectFail(assert, broken('Analysis', an, (o) => { o.tests[3].spec.stepRef.to = 0; }), 'tests[3].spec.stepRef.to', 'stepRef not at the q = 0 step');
      expectFail(assert, broken('Analysis', an, (o) => { o.trend.alerts.delta.status = 'raised'; }), 'trend.alerts.delta.status', 'enum');
      expectFail(assert, broken('Analysis', an, (o) => { o.zones.gauge = { mode: 'device' }; }), 'zones.gauge.mode', 'unresolved zone in an Analysis');
      expectFail(assert, broken('BuildupResult', res, (o) => { o.iarf.grade = 'great'; }), 'iarf.grade', 'enum');
      expectFail(assert, broken('BuildupResult', res, (o) => { o.confidence.headline = 'high'; }), 'confidence.headline', 'headline = min(ks, model)');
      expectFail(assert, broken('BuildupResult', res, (o) => { o.confidence.model = 'high'; o.confidence.ks = 'medium'; }), 'confidence.model', 'K2 above K1');
      expectFail(assert, broken('BuildupResult', res, (o) => { o.quality.ev = ['Q9']; }), 'quality.ev[0]', 'evidence id outside the listed set');
      expectFail(assert, broken('BuildupResult', res, (o) => { o.final.ev = ['B1·A2']; }), 'final.ev[0]', 'absolute id in a test-level result');
      expectFail(assert, broken('BuildupResult', res, (o) => { const i = o.bins.full.indexOf(false); o.bins.deriv[i] = 1.5; }), 'bins.deriv[0]', 'masked derivative not null');
      expectFail(assert, broken('BuildupResult', res, (o) => { o.bins.dp.pop(); }), 'bins.dp', 'array lengths differ');
      expectFail(assert, broken('BuildupResult', res, (o) => { o.warnings = [{ code: 'X', level: 'warn', text: 'value is undefined', ev: [] }]; }), 'warnings[0].text', 'banned word in text');
      expectFail(assert, broken('BuildupResult', res, (o) => { o.models[0].key = 'closedCircle'; o.models.push(JSON.parse(JSON.stringify(o.models[0]))); }), 'models[0].key', 'homogeneous first');
      expectFail(assert, broken('BuildupResult', res, (o) => { o.sErr.driver = 'noise'; }), 'sErr.driver', 'enum');
      expectFail(assert, broken('BuildupSpec', sm.BuildupSpec, (o) => { last(o.steps).q = 5; }), 'steps[' + (sm.BuildupSpec.steps.length - 1) + '].q', 'last step not q = 0');
      expectFail(assert, broken('BuildupSpec', sm.BuildupSpec, (o) => { o.dt[2] = o.dt[1]; }), 'dt[2]', 'dt not ascending');
      expectFail(assert, broken('BuildupSpec', sm.BuildupSpec, (o) => { o.gas = undefined; delete o.gas; }), 'gas', 'missing key in an input');
      expectFail(assert, broken('BuildupSpec', sm.BuildupSpec, (o) => { o.well.re_ft = null; o.well.h = null; }), 'well.h', 'null in a strict input number');
      expectFail(assert, broken('GaugeRecord', sm.GaugeRecord, (o) => { o.origin_ms = o.t[1]; }), 'origin_ms', 'origin is the first sample');
      expectFail(assert, broken('Finding', sm.Finding, (o) => { o.template += ' {missing}'; }), 'template', 'unbound placeholder');
      expectFail(assert, broken('Finding', sm.Finding, (o) => { o.values.cv.ref = 'cv'; }), 'values.cv.ref', 'Value.ref pattern');
      expectFail(assert, broken('Review', sm.Review, (o) => { o.counts.suggestion = 0; }), 'counts.suggestion', 'counts follow the findings');
      expectFail(assert, broken('Answer', sm.Answer, (o) => { o.intent = 'chat'; }), 'intent', 'intent enum');
      expectFail(assert, broken('ReportModel', sm.ReportModel, (o) => { o.sections[1].blocks[0].rows[0].pop(); }), 'sections[1].blocks[0].rows[0]', 'table row length');
      expectFail(assert, broken('ReportModel', sm.ReportModel, (o) => { o.sections[0].blocks[0].kind = 'gauge'; }), 'sections[0].blocks[0].kind', 'block kind');
      expectFail(assert, broken('AnalysisInput', sm.AnalysisInput, (o) => { o.overrides[0].reason = 'no'; }), 'overrides[0].reason', 'override reason ≥ 5 characters');
      expectFail(assert, broken('CaseSpec', sm.CaseSpec, (o) => { o.stratum = 'other'; }), 'stratum', 'stratum enum');
      expectFail(assert, broken('Cal', fx.cal, (o) => { o.thresholds.tauBic = null; }), 'thresholds.tauBic', 'threshold never null');
      expectFail(assert, broken('TrendTest', sm.TrendTests[0], (o) => { o.fullySeen = { status: 'n/a' }; }), 'fullySeen', 'TrendTest.fullySeen is the status string');
      expectFail(assert, broken('BuildupResult', res, (o) => { o.warnings = [{ code: 'X', level: 'warn', text: 'value is Infinity', ev: [] }]; }), 'warnings[0].text', 'Infinity in text');
      // WP0 resolutions: categorical model parameters (PRiSM keeps BC in params) pass in ModelFit and fitC4
      assert.strictEqual(sm.ModelFitFault.params.BC, 'noflow');
      const withFault = JSON.parse(JSON.stringify(res));
      withFault.models.push(JSON.parse(JSON.stringify(sm.ModelFitFault)));
      withFault.fitC4 = { modelKey: 'linearBoundary', params: Object.assign({}, sm.ModelFitFault.params), phys: Object.assign({}, sm.ModelFitFault.phys), r2: 0.9998, converged: true };
      assert(S.checkShape('BuildupResult', withFault).ok, 'a linearBoundary rival and fitC4 with BC pass: ' + JSON.stringify(S.checkShape('BuildupResult', withFault).errors.slice(0, 4)));
      expectFail(assert, broken('ModelFit', sm.ModelFitFault, (o) => { o.params.BC = { v: 'noflow' }; }), 'params.BC', 'object in params');
      expectFail(assert, broken('ModelFit', res.models[0], (o) => { o.se = {}; }), 'se.k', 'se must carry k, S, C');
      expectFail(assert, broken('ModelFit', res.models[0], (o) => { delete o.ci95.S; }), 'ci95.S', 'ci95 must carry k, S, C');
      assert(S.checkShape('ModelFit', Object.assign(JSON.parse(JSON.stringify(res.models[0])), { se: { k: null, S: 0.1, C: null, extra: 2 } })).ok, 'se keys may be null; other keys open');
      // typed settings: partial boolean, band/slope fractions, kHeld and confirm enums
      expectFail(assert, broken('Settings', an.settings, (o) => { o.detect.partial = 'banana'; }), 'detect.partial', 'partial is a boolean');
      expectFail(assert, broken('Settings', an.settings, (o) => { o.interp.band = 10; }), 'interp.band', 'band is a fraction, not %');
      expectFail(assert, broken('Settings', an.settings, (o) => { o.interp.kHeld = 42; }), 'interp.kHeld', 'kHeld enum');
      expectFail(assert, broken('Settings', an.settings, (o) => { o.trend.confirm = {}; }), 'trend.confirm', 'confirm enum');
      expectFail(assert, broken('AnalysisInput', sm.AnalysisInput, (o) => { o.settings.interp.slope = 3; }), 'settings.interp.slope', 'slope is a fraction (in an AnalysisInput)');
      assert.strictEqual(an.settings.detect.partial, true, 'FIX partial cuts classified (checkbox on)');
      // WellInput.defaulted takes any key name (gas keys included), never an empty string
      assert(S.checkShape('WellInput', Object.assign({}, an.well, { defaulted: ['sg', 'T_F'] })).ok, 'gas keys may be defaulted');
      expectFail(assert, S.checkShape('WellInput', Object.assign({}, an.well, { defaulted: [''] })), 'defaulted[0]', 'empty defaulted key');
      // Override.target: null only for event_add
      const evAdd = { id: 'O2', kind: 'event_add', target: null, value: { t_ms: an.events[0].tc_ms + 3 * 86400000 }, reason: 'Typed closing time from the daily report.', who: 'Engineer A', at: '2026-06-21T08:00:00Z', appVersion: '3.3' };
      assert(S.checkShape('Override', evAdd).ok, 'event_add with target null: ' + JSON.stringify(S.checkShape('Override', evAdd).errors));
      expectFail(assert, S.checkShape('Override', Object.assign({}, evAdd, { kind: 'exclude' })), 'target', 'target null outside event_add');
      // the null rule: an output number may be null, NaN never
      assert(S.checkShape('BuildupResult', Object.assign(JSON.parse(JSON.stringify(res)), { final: Object.assign({}, res.final, { rinv_ft: null }) })).ok, 'null passes in an output number');
      const nan = JSON.parse(JSON.stringify(res)); nan.final.rinv_ft = NaN;
      expectFail(assert, S.checkShape('BuildupResult', nan), 'final.rinv_ft', 'NaN in an output number');
    },
  },
  {
    name: 'SH2 fixture self-consistency: derived numbers equal FORMULAS at display precision',
    wp: WP,
    opts: false,
    run(app, assert) {
      // one copy of each fixture (every FIX access is a fresh deep copy)
      const F = S.FORMULAS, fx = { analysis: S.FIX.analysis, result: S.FIX.result, samples: S.FIX.samples, inputs: S.FIX.inputs }, an = fx.analysis, w = an.well;
      let n = 0;
      const eq = (key, stored, recomputed, where) => {
        n++;
        assert(S.nearDisplay(key, stored, recomputed), where + ' ' + key + ': stored ' + stored + ' ≠ recomputed ' + recomputed);
      };
      // every formula carries its argument list and text
      Object.keys(F).forEach((k) => { assert.strictEqual(typeof F[k], 'function', k); assert(Array.isArray(F[k].args) && F[k].text, k + ' has args and text'); });
      // Appendix A.2 values
      eq('dS', F.sensDS('h', 1.2), 0.091, 'A.2'); eq('dS', F.sensDS('h', 0.8), -0.112, 'A.2'); eq('dS', F.sensDS('rw', 1.2), 0.182, 'A.2');
      eq('dS', F.sensDS('rw', 0.8), -0.223, 'A.2'); eq('dS', F.sensDS('q', 1.1), -0.048, 'A.2'); eq('dkPct', F.dkPct(F.sensK('h', 0.8, 45), 45), 25, 'A.2');

      const checkResult = (r, spec, Dq, dtEnd, where) => {
        const f = r.final, dte = last(r.bins.dte), dtl = last(r.bins.dt);
        const tp = dtl * dte / (dtl - dte);                      // effective producing time from the last bin
        eq('m', f.m, F.m(Dq, w.B, w.mu, f.k, w.h), where + ' final');
        eq('mPrime', f.mPrime, F.mPrime(f.m), where + ' final');
        eq('kh', f.kh, f.k * w.h, where + ' final');
        eq('dpSkin_psi', f.dpSkin_psi, F.dpSkin(f.m, f.S), where + ' final');
        eq('rinv_ft', f.rinv_ft, F.rinv(f.k, dtEnd, w.phi, w.mu, w.ct), where + ' final');
        eq('rinvE_ft', f.rinvE_ft, F.rinv(f.k, dte, w.phi, w.mu, w.ct), where + ' final');
        eq('dte', dte, F.dte(dtEnd, tp), where + ' bins');
        eq('fair_h', r.reach.fair_h, F.reachFair(r.reach.t5_h, spec.opts.Lcyc), where + ' reach');
        eq('good_h', r.reach.good_h, F.reachGood(r.reach.t5_h, spec.opts.Lcyc), where + ' reach');
        if (r.reach.fairShut_h !== null) eq('fairShut_h', r.reach.fairShut_h, F.shutOfDte(r.reach.fair_h, tp), where + ' reach');
        if (r.reach.goodShut_h !== null) eq('goodShut_h', r.reach.goodShut_h, F.shutOfDte(r.reach.good_h, tp), where + ' reach');
        eq('rDrift', r.quality.rDrift, F.rDrift(spec.driftPsiPerDay, dtEnd, f.mPrime), where + ' quality');
        eq('dpdt_flow', spec.dpdt_flow, -f.m / (Math.LN10 * tp), where + ' spec (slope of the drawdown at closing)');
        if (f.pStar !== null) eq('pStar', f.pStar, F.pStar(spec.pwf0, f.m, tp, F.logTerm(f.k, w.phi, w.mu, w.ct, w.rw), f.S), where + ' final p* from pwf0');
        if (r.iarf.found) {
          // X0, X1 and line.shifts[].dX are log10 Δt_e (cycles); dt0_h/dt1_h are their shut-in times with the test's tp
          eq('cycles', r.iarf.cycles, r.iarf.X1 - r.iarf.X0, where + ' iarf (cycles = X1 − X0, log10 Δt_e)');
          eq('X0', r.iarf.X0, F.xOfDte(r.reach.t5_h), where + ' iarf (window starts at t5 %)');
          eq('X1', r.iarf.X1, F.xOfDte(dte) - spec.opts.Lcyc, where + ' iarf (last full-window bin)');
          eq('dt0_h', r.iarf.dt0_h, F.shutOfDte(F.dteOfX(r.iarf.X0), tp), where + ' iarf');
          eq('dt1_h', r.iarf.dt1_h, F.shutOfDte(F.dteOfX(r.iarf.X1), tp), where + ' iarf');
          eq('level_psi', r.iarf.level_psi, F.mPrime(F.m(Dq, w.B, w.mu, f.k, w.h)), where + ' iarf (m′ = 70.6·qBμ/kh)');
        }
        if (r.line) {
          eq('kh', r.line.kh, r.line.k * w.h, where + ' line');
          eq('m', r.line.m, F.m(Dq, w.B, w.mu, r.line.k, w.h), where + ' line');
          eq('dkPct', r.agreement.dkPct, F.dkPct(r.line.k, f.k), where + ' agreement');
          eq('dS', r.agreement.dS, r.line.S - f.S, where + ' agreement');
          eq('khDiffPct', r.line.plateauCheck.khDiffPct, F.dkPct(r.line.kh, f.kh), where + ' plateau check');
          eq('p1hr', r.line.p1hr, F.p1hr(r.line.pStar, r.line.m, tp), where + ' line (Horner at 1 h)');
          eq('dt0_h', r.line.dt0_h, r.iarf.dt0_h, where + ' line window'); eq('dt1_h', r.line.dt1_h, r.iarf.dt1_h, where + ' line window');
          r.line.shifts.forEach((sh, j) => {
            eq('dX', Math.abs(sh.dX), Math.min(0.25, 0.2 * r.iarf.cycles), where + ' line.shifts[' + j + '] (δ = min(0.25, 0.2·span) cycle)');
            eq('dt0_h', sh.dt0_h, F.shutOfDte(F.dteOfX(r.iarf.X0 + sh.dX), tp), where + ' line.shifts[' + j + '] window');
            eq('dt1_h', sh.dt1_h, F.shutOfDte(F.dteOfX(r.iarf.X1 + sh.dX), tp), where + ' line.shifts[' + j + '] window');
          });
        }
        // S_err composition (§4.6 item 15)
        const e = r.sErr;
        eq('sTc', e.sTc, F.sTc(spec.dpdt_flow, spec.dtc_h, f.m), where + ' sErr');
        eq('sPwf', e.sPwf, F.sPwf(spec.pwf0SE, f.m), where + ' sErr');
        if (e.mode === 'line') {
          eq('dLineMatch', e.dLineMatch, Math.abs(r.line.S - f.S), where + ' sErr');
          const sh = r.line.shifts;
          if (sh.length === 1) eq('sWin', e.sWin, Math.abs(sh[0].S - r.line.S), where + ' sErr (one-sided, raw mode)');
          eq('seS', e.seS, r.models.find((mm) => mm.key === r.chosen.key).se.S, where + ' sErr (inflated fit se)');
          eq('value', e.value, Math.max(e.floor, e.seS, e.dLineMatch, e.sWin, e.sTc, e.sPwf), where + ' sErr');
        } else if (e.mode === 'kHeld') {
          eq('S_k', r.kHeld.S_k, Math.abs(r.kHeld.refits[0].S - r.kHeld.refits[1].S) / 2, where + ' kHeld');
          eq('S_kAnalytic', r.kHeld.S_kAnalytic, F.sKAnalytic(r.kHeld.delta, last(r.bins.dp), f.m), where + ' kHeld (§4.6 item 18)');
          eq('sK', e.sK, r.kHeld.S_k, where + ' sErr');
          eq('value', e.value, Math.max(e.floor, e.seS, e.sTc, e.sPwf, e.sK), where + ' sErr');
        }
        eq('value', e.ext.value, Math.max(e.value, e.ext.S_C), where + ' sErr.ext');
        eq('sSens', e.sSens, r.sensitivity.sSens, where + ' sErr');
        eq('sAbs', e.sAbs, Math.sqrt(e.value * e.value + e.sSens * e.sSens), where + ' sErr');
        // sensitivity rows (Appendix A.2) and S_sens (RSS over the typical ranges of the larger |ΔS|)
        r.sensitivity.req.concat(r.sensitivity.typ).forEach((row) => {
          eq('dS', row.dS, F.sensDS(row.input, row.f), where + ' sensitivity ' + row.input);
          eq('k', row.k, F.sensK(row.input, row.f, f.k), where + ' sensitivity ' + row.input);
          eq('dkPct', row.dkPct, F.dkPct(row.k, f.k), where + ' sensitivity ' + row.input);
          eq('S', row.S, f.S + row.dS, where + ' sensitivity ' + row.input);
        });
        const big = {};
        r.sensitivity.typ.forEach((row) => { big[row.input] = Math.max(big[row.input] || 0, Math.abs(row.dS)); });
        eq('sSens', r.sensitivity.sSens, Math.sqrt(Object.keys(big).reduce((s, k) => s + big[k] * big[k], 0)), where + ' sensitivity');
        assert.strictEqual(r.sensitivity.dominantK.req, 'h', where + ' dominant k input (requirement ranges)');
        assert.strictEqual(r.sensitivity.dominantS.req, 'rw', where + ' dominant S input (requirement ranges)');
        assert.strictEqual(r.sensitivity.dominantS.typ, 'ct', where + ' dominant S input (typical ranges)');
      };
      const ref = fx.inputs.reference;
      checkResult(fx.result, fx.inputs.specReference, ref.q, ref.dtEnd, 'FIX.result');
      // reference-case closed forms (Appendix A.1, §4.6 item 5b): t5 % 15.5 h, reach.fair 62 h, reach.good 196 h
      assert.near(fx.result.reach.t5_h, 15.5, 0.1, 't5 %'); assert.near(fx.result.reach.fair_h, 62, 0.5, 'reach.fair'); assert.near(fx.result.reach.good_h, 196, 0.5, 'reach.good');
      assert.near(fx.result.quality.rDrift, 0.001, 0.0001, 'r_drift 0.001 at 72 h (§4.2)');
      assert.near(fx.result.storage.tHump_h, 0.34, 0.005, 'hump 0.34 h (A.1)');
      assert.within(fx.result.iarf.cycles, 0.5, 0.65, 'reference window span');
      assert.near(fx.result.agreement.dkPct, -2.6, 0.05, 'line k −2.6 % (EN6)'); assert.near(fx.result.agreement.dS, -0.33, 0.005, 'line S −0.33 (EN6)');

      an.tests.forEach((t, i) => {
        assert.strictEqual(t.result.id, t.id);
        checkResult(t.result, t.spec, t.Dq, t.dtEnd_h, 'analysis.tests[' + i + ']');
        eq('pExtDatum', t.pExtDatum, t.result.final.pExt, t.id + ' datum (no depth correction)');
      });
      // trend products (§4.7 T7, T8) from the latest used test against the baseline
      const tr = an.trend;
      const used = an.tests.filter((t) => t.used.trend);
      const now = last(used), Sb = tr.baseline.S;
      const median = (a) => { const s = a.slice().sort((x, y) => x - y); const k = s.length; return k % 2 ? s[(k - 1) / 2] : (s[k / 2 - 1] + s[k / 2]) / 2; };
      eq('S', Sb, median(tr.baseline.tests.map((id) => an.tests.find((t) => t.id === id).result.final.S)), 'trend baseline (median)');
      tr.skinDp.forEach((row) => { const t = an.tests.find((x) => x.id === row.id); eq('dpSkin_psi', row.dpSkin_psi, F.dpSkin(t.result.final.m, t.result.final.S), 'trend skinDp ' + row.id); });
      const X = F.X(w.re_ft, w.rw);
      eq('X', tr.pi.X, X, 'trend pi');
      eq('ratioNow', tr.pi.ratioNow, F.piRatio(X, now.result.final.S), 'trend pi');
      eq('ratioBase', tr.pi.ratioBase, F.piRatio(X, Sb), 'trend pi');
      eq('rateAtStake', tr.pi.rateAtStake, F.rateAtStake(now.Dq, X, now.result.final.S, Sb), 'trend pi');
      eq('extraDrawdown_psi', tr.pi.extraDrawdown_psi, F.extraDrawdown(now.Dq, w.B, w.mu, now.result.final.S - Sb, now.result.final.k, w.h), 'trend pi');
      // alerts follow the plain delta form on the used tests
      const ex = (t) => t.result.final.S - t.result.sErr.value - Sb > tr.alerts.delta.threshold;
      const firstEx = used.find(ex);
      assert.strictEqual(tr.alerts.delta.raisedAt, firstEx.id, 'delta raised at the first used test that exceeds');
      assert.strictEqual(tr.alerts.delta.confirmedAt, used.slice(used.indexOf(firstEx) + 1).find(ex).id, 'delta confirmed at the next used test that exceeds');

      // trend copies: series[] and TrendTest are copied from the tests
      const DAY = 86400000, t0 = an.tests[0].tc_ms, tD = (ms) => (ms - t0) / DAY;
      const byId = (id) => an.tests.find((t) => t.id === id);
      tr.series.forEach((sr) => {
        const t = byId(sr.id), r = t.result;
        [['tDays', sr.tDays, tD(t.tc_ms)], ['S', sr.S, r.final.S], ['Serr', sr.Serr, r.sErr.value], ['k', sr.k, r.final.k], ['pExt', sr.pExt, r.final.pExt],
         ['pwf0Datum', sr.pwf0Datum, t.pwf0Datum]].forEach((c) => eq(c[0], c[1], c[2], 'trend.series ' + sr.id));
        assert.deepStrictEqual(sr.conf, { ks: r.confidence.ks, model: r.confidence.model, headline: r.confidence.headline }, 'trend.series ' + sr.id + ' conf');
      });
      fx.samples.TrendTests.forEach((tt) => {
        const t = byId(tt.id), r = t.result;
        [['t_ms', tt.t_ms, t.tc_ms], ['tDays', tt.tDays, tD(t.tc_ms)], ['S', tt.S, r.final.S], ['Serr', tt.Serr, r.sErr.value], ['SerrExt', tt.SerrExt, r.sErr.ext.value],
         ['k', tt.k, r.final.k], ['kh', tt.kh, r.final.kh], ['C', tt.C, r.final.C], ['m', tt.m, r.final.m], ['mPrime', tt.mPrime, r.final.mPrime],
         ['pStarDatum', tt.pStarDatum, t.pStarDatum], ['pExtDatum', tt.pExtDatum, t.pExtDatum], ['piModelDatum', tt.piModelDatum, r.final.piModel],
         ['pwf0Datum', tt.pwf0Datum, t.pwf0Datum], ['Dq', tt.Dq, t.Dq], ['rinv_ft', tt.rinv_ft, r.final.rinv_ft], ['dpSkin_psi', tt.dpSkin_psi, r.final.dpSkin_psi],
         ['iarfDt0_h', tt.iarfDt0_h, r.iarf.dt0_h], ['dtEnd_h', tt.dtEnd_h, t.dtEnd_h], ['dteEnd_h', tt.dteEnd_h, last(r.bins.dte)],
         ['reachFair_h', tt.reachFair_h, r.reach.fair_h], ['reachGood_h', tt.reachGood_h, r.reach.good_h],
         ['reachFairShut_h', tt.reachFairShut_h, r.reach.fairShut_h], ['reachGoodShut_h', tt.reachGoodShut_h, r.reach.goodShut_h]].forEach((c) => eq(c[0], c[1], c[2], 'TrendTest ' + tt.id));
        assert.strictEqual(tt.SerrMode, r.sErr.mode); assert.strictEqual(tt.chosen, r.chosen.key); assert.strictEqual(tt.fullySeen, r.chosen.fullySeen.status);
        assert.strictEqual(tt.kHeld, !!r.kHeld); assert.strictEqual(tt.excluded, t.status === 'excluded'); assert.strictEqual(tt.date, t.date);
        assert.deepStrictEqual(tt.conf, { ks: r.confidence.ks, model: r.confidence.model, headline: r.confidence.headline }, 'TrendTest ' + tt.id + ' conf');
        assert.deepStrictEqual(tt.bins, { dte: r.bins.dte, dp: r.bins.dp }, 'TrendTest ' + tt.id + ' bins');
      });

      // S(t) for T8 and T13: piecewise linear through the used tests with the onset knot (τ̂, S_base) inserted between tests
      // (a used test at τ̂ keeps its own value — the refreshed onset sits on B3); constant outside
      const tau = tr.onset.tauDays;
      const vals = used.map((t) => [tD(t.tc_ms), t.result.final.S]);
      const knots = vals.some((k) => Math.abs(k[0] - tau) < 1e-9) ? vals
        : vals.filter((k) => k[0] < tau).concat([[tau, Sb]]).concat(vals.filter((k) => k[0] > tau));
      const lin = (k, x) => { if (x <= k[0][0]) return k[0][1]; for (let i = 1; i < k.length; i++) if (x <= k[i][0]) return k[i - 1][1] + (k[i][1] - k[i - 1][1]) * (x - k[i - 1][0]) / (k[i][0] - k[i - 1][0]); return last(k)[1]; };
      const days = an.rates.days, midD = (d) => tD(0.5 * (d.t0_ms + d.t1_ms));
      // T8 cumulative since τ̂ = Σ_days q_d·[(X + S(t_d))/(X + S_base) − 1]
      eq('cumAtStake', tr.pi.cumAtStake, days.filter((d) => midD(d) >= tau).reduce((a, d) => a + F.atStakeDay(d.q, X, lin(knots, midD(d)), Sb), 0), 'trend pi (T8 cumulative)');
      // T5: the recent trend needs ≥ 3 tests after τ̂
      const nPost = used.filter((t) => tD(t.tc_ms) > tau).length;
      assert.strictEqual(tr.recent.n, nPost, 'recent.n = tests after the onset');
      if (nPost < 3) ['slopePer30d', 'wlsSlopePer30d', 'mkZ', 'mkP'].forEach((k) => assert.strictEqual(tr.recent[k], null, 'recent.' + k + ' is null with n < 3'));
      // T11 model-free ΔS at Δt_ref (used tests with an IARF window, reference = the first)
      const wins = used.filter((t) => t.result.iarf.dt0_h !== null);
      const minEnd = Math.min.apply(null, wins.map((t) => t.dtEnd_h));
      const dtRef = Math.max.apply(null, wins.map((t) => t.result.iarf.dt0_h).filter((x) => x <= minEnd));
      const atRef = (t) => {
        const b = t.result.bins, dteEnd = last(b.dte), dte = F.dte(dtRef, t.dtEnd_h * dteEnd / (t.dtEnd_h - dteEnd));
        const i = b.dte.findIndex((x) => x >= dte);
        return { dte, dp: b.dp[i - 1] + (b.dp[i] - b.dp[i - 1]) * Math.log(dte / b.dte[i - 1]) / Math.log(b.dte[i] / b.dte[i - 1]) };
      };
      assert.deepStrictEqual(tr.modelFree.map((r) => r.id), wins.slice(1).map((t) => t.id), 'T11 rows: the used tests with a window after the reference');
      tr.modelFree.forEach((row) => {
        const t = byId(row.id), b = byId(row.refId), a = atRef(t), c = atRef(b);
        assert.strictEqual(row.refId, wins[0].id, 'T11 reference');
        eq('dS', row.dS, F.modelFreeDS(a.dp, t.Dq, c.dp, b.Dq, b.result.final.m / b.Dq, a.dte, c.dte), 'trend modelFree ' + row.id);
        eq('fittedDS', row.fittedDS, t.result.final.S - b.result.final.S, 'trend modelFree ' + row.id);
        assert.strictEqual(row.agrees, Math.abs(row.dS - row.fittedDS) <= Math.max(0.3, t.result.sErr.value), 'T11 agrees ' + row.id);
      });
      // T13 PI cross-check: median J_obs/J_pred on clean flowing days between consecutive used tests
      const pK = used.filter((t) => t.result.final.pExt !== null).map((t) => [t.tc_ms, t.result.final.pExt]);
      tr.piCheck.rows.forEach((row, i) => {
        const a = used[i], b = used[i + 1];
        assert.deepStrictEqual([row.from, row.to], [a.id, b.id], 'T13 interval ' + i);
        const rj = days.filter((d) => d.cls === 'clean' && d.pwfMean_psia !== null && 0.5 * (d.t0_ms + d.t1_ms) > a.tc_ms && 0.5 * (d.t0_ms + d.t1_ms) < b.tc_ms)
          .map((d) => F.jObs(d.q, lin(pK, 0.5 * (d.t0_ms + d.t1_ms)), d.pwfMean_psia) / F.jPred(an.baseline.k, w.h, w.B, w.mu, X, lin(knots, midD(d))));
        assert(rj.length >= 5, 'T13 interval ' + i + ' has clean days');
        eq('RJ', row.RJ, median(rj), 'trend piCheck ' + row.from + '→' + row.to);
      });
      assert.strictEqual(tr.piCheck.consistent, tr.piCheck.rows.every((r) => r.RJ >= 0.8 && r.RJ <= 1.25), 'T13 consistent = every RJ in [0.8, 1.25]');

      // the one gauge record: analysis.record, QC, events, spec sampling and daily pwf are derived from it
      const rec = fx.samples.GaugeRecord, ai = fx.samples.AnalysisInput;
      ['n', 'origin_ms', 'hash'].forEach((k) => assert.strictEqual(an.record[k], rec[k], 'analysis.record.' + k + ' = GaugeRecord.' + k));
      assert.strictEqual(an.record.end_ms, last(rec.t), 'analysis.record.end_ms = last sample');
      assert.strictEqual(ai.record.hash, an.record.hash, 'AnalysisInput.record is the analysed record (raw usable per §3.11)');
      assert.strictEqual(an.qc.n, rec.n, 'qc.n');
      const diffs = []; for (let j = 1; j < rec.n; j++) diffs.push((rec.t[j] - rec.t[j - 1]) / 1000);
      const sorted = diffs.slice().sort((x, y) => x - y), q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
      assert.strictEqual(an.qc.dtMed_s, median(diffs), 'qc.dtMed_s'); assert.strictEqual(an.qc.dtP05_s, q(0.05), 'qc.dtP05_s'); assert.strictEqual(an.qc.dtP95_s, q(0.95), 'qc.dtP95_s');
      an.events.forEach((e) => {
        assert.strictEqual(e.j1, e.j0 + 1, e.id + ' j1 = j0 + 1');
        assert(rec.t[e.j0] <= e.tc_ms && rec.t[e.j1] > e.tc_ms, e.id + ': j0 is the last sample at or before t_c, j1 the first after it');
        assert.near(rec.p[e.j0], e.pwf0, 0.0006, e.id + ' pwf0 = record pressure at t_c');
      });
      an.tests.forEach((t) => {
        const e = an.events.find((x) => x.id === t.eventId);
        eq('pwf0', t.spec.pwf0, e.pwf0, t.id + ' spec.pwf0 = event pwf0');
        const d = []; for (let j = e.j1 + 1; j < rec.n && rec.t[j] <= e.tEnd_ms; j++) d.push((rec.t[j] - rec.t[j - 1]) / 3600000);
        eq('dtSample_h', t.spec.dtSample_h, median(d), t.id + ' spec.dtSample_h = median shut-in sampling');
      });
      const shutIn = (ms) => an.events.some((e) => ms > e.tc_ms && ms <= e.tEnd_ms);
      let jr = 0;
      days.forEach((d) => {
        let sum = 0, c = 0;
        while (jr < rec.n && rec.t[jr] < d.t0_ms) jr++;
        for (let j = jr; j < rec.n && rec.t[j] < d.t1_ms; j++) if (!shutIn(rec.t[j])) { sum += rec.p[j]; c++; }
        if (d.pwfMean_psia !== null) eq('pwfMean_psia', d.pwfMean_psia, sum / c, 'rates.days ' + d.date + ' (mean flowing sample)');
        else assert(d.hOn < 0.5, 'rates.days ' + d.date + ': pwfMean null only on a shut day');
      });
      // the SynthCase record matches its own spec
      const sr = fx.samples.SynthCase, sd = []; for (let j = 1; j < sr.record.n; j++) sd.push((sr.record.t[j] - sr.record.t[j - 1]) / 1000);
      assert.strictEqual(median(sd), sr.spec.test.dtSample_s, 'SynthCase record sampling = spec.test.dtSample_s');
      assert(sr.record.t[0] < sr.truth.tc_ms && last(sr.record.t) <= sr.truth.tc_ms + sr.spec.test.dtEnd_h * 3600000, 'SynthCase record spans the closing');
      assert.strictEqual(new Date(sr.truth.tc_ms).getUTCHours(), sr.spec.test.closeHour, 'SynthCase closeHour');
      eq('hours', sr.allocation.rows.reduce((a, r) => a + r.hours, 0), sr.spec.history.days * 24, 'SynthCase flowing hours = history');
      // synthetic truth (§5.3) and score
      const sc = fx.samples.SynthCase, cs = sc.spec;
      eq('kStar', sc.truth.kStar, F.kStar(cs.truth, cs.given, sc.truth.f), 'SynthCase truth');
      eq('SStar', sc.truth.SStar, F.SStar(cs.truth, cs.given, sc.truth.f), 'SynthCase truth');
      eq('dkPct', fx.samples.Score.dkPct, F.dkPct(fx.inputs.score.kHat, sc.truth.kStar), 'Score');
      eq('dS', fx.samples.Score.dS, fx.inputs.score.SHat - sc.truth.SStar, 'Score');
      assert(n > 300, 'checked ' + n + ' derived numbers');
    },
  },
  {
    name: 'SH3 canon / hash16 vectors, key order, 1e-15 robustness, 6 significant figures; Round 8 carries file 53',
    wp: WP,
    run(app, assert, ctx) {
      const AI = S.autoInterp();
      // fixed vectors (frozen after WP0)
      assert.strictEqual(AI.version, '1.0');
      assert.strictEqual(AI.hash16(''), '811c9dc5050c5d1f', "hash16('')");
      assert.strictEqual(AI.hash16('a'), 'e40c292c70772d5a', "hash16('a') — first half = standard FNV-1a");
      assert.strictEqual(AI.hash16('abc'), '1a47e90bb9de7311', "hash16('abc')");
      assert.strictEqual(AI.hash16('é中'), '7e872b4b6357dabd', 'hash16 over UTF-16 code units');
      assert.strictEqual(AI.hash16(null), AI.hash16(''), 'null hashes as the empty string');
      assert.strictEqual(AI.canon({ b: [1, { d: 2, c: null }], a: 'x' }), '{"a":"x","b":[1,{"c":null,"d":2}]}', 'sorted keys, no whitespace');
      assert.strictEqual(AI.hash16(AI.canon({ b: 2, a: 1 })), '5314055bf9405315', 'hash16(canon({b:2,a:1}))');
      assert.strictEqual(AI.canon([NaN, Infinity, -Infinity, -0, undefined, () => 1]), '[null,null,null,0,null,null]', 'non-finite, −0, undefined and functions in arrays');
      assert.strictEqual(AI.canon({ a: 1e-15, b: -9e-13, c: 2e-12 }, 'display'), '{"a":0,"b":0,"c":2e-12}', '|v| < 1e-12 serialises as 0');
      assert.strictEqual(AI.canon({ u: undefined, f() {}, d: new Date(0), t: new Float64Array([0.5, 2]) }), '{"d":"1970-01-01T00:00:00.000Z","t":[0.5,2]}', 'dropped keys, Date, typed array');
      const cyc = { x: 1 }; cyc.self = cyc;
      assert.strictEqual(AI.canon(cyc), '{"self":null,"x":1}', 'a cycle becomes null');
      // inputs mode: 6 significant figures; epoch ms to whole seconds; the default mode is inputs
      assert.strictEqual(AI.canon({ x: 1.23456789, y: 123456789, z: 0.000123456789, tc_ms: 1772366400499 }, 'inputs'),
        '{"tc_ms":1772366400000,"x":1.23457,"y":123457000,"z":0.000123457}', 'inputs mode');
      assert.strictEqual(AI.canon({ x: 1.23456789 }), AI.canon({ x: 1.23456789 }, 'inputs'), 'default mode = inputs');
      assert.notStrictEqual(AI.canon({ x: 1.2345 }, 'inputs'), AI.canon({ x: 1.2346 }, 'inputs'), 'inputs mode keeps the 5th figure');
      // display mode: per-key precision (§8.4)
      assert.strictEqual(AI.canon({ k: 45.678, kh: 2283.9, S: 4.6666, Serr: 0.3349, sErr: { value: 0.33333, ext: { value: 0.4444 } }, C: 0.0201234, pStar: 3999.96,
                                    sigma_psi: 0.012345, dkPct: -2.6049, dBicHom: -12.345, dt0_h: 15.88888, dt: [0.0028123, 12.3456], rinv_ft: 1308.44, rw: 0.354,
                                    Dq: 805.234, n: 12345678, cycles: 0.56789, tc_ms: 1772366400499, range: { k: [45.678], S: [4.6666] } }, 'display'),
        '{"C":0.0201,"Dq":805.2,"S":4.67,"Serr":0.33,"cycles":0.5679,"dBicHom":-12.3,"dkPct":-2.6,"dt":[0.00281,12.346],"dt0_h":15.889,"k":45.7,"kh":2280,' +
        '"n":12345678,"pStar":4000,"range":{"S":[4.67],"k":[45.7]},"rinv_ft":1308,"rw":0.354,"sErr":{"ext":{"value":0.44},"value":0.33},"sigma_psi":0.0123,"tc_ms":1772366400000}',
        'display mode');
      // key order does not matter (deep), in both modes
      const res = S.FIX.result, an = S.FIX.analysis;
      ['inputs', 'display'].forEach((m) => {
        assert.strictEqual(AI.canon(reverseKeys(res), m), AI.canon(res, m), 'key order (' + m + ')');
        assert.strictEqual(AI.hash16(AI.canon(reverseKeys(an), m)), AI.hash16(AI.canon(an, m)), 'key order, analysis (' + m + ')');
      });
      // a 1e-15 perturbation of every number leaves the display-mode hash unchanged
      const resultsOf = (a) => ({ tests: a.tests.map((t) => ({ id: t.id, final: t.result.final, sErr: t.result.sErr, conf: t.result.confidence })),
                                  alerts: a.trend.alerts, onset: a.trend.onset, recent: a.trend.recent });
      // (Exact half-unit ties — e.g. the sensitivity row k = 45/0.8 = 56.25 — flip under any perturbation by construction,
      //  so the check runs on what the results hash covers: final values, S_err and labels, alerts, onset, recent slope.)
      const resOf = (r) => ({ final: r.final, sErr: r.sErr, conf: r.confidence, reach: r.reach, agreement: r.agreement });
      const h0 = AI.hash16(AI.canon(resultsOf(an), 'display')), hr0 = AI.hash16(AI.canon(resOf(res), 'display'));
      const relP = JSON.parse(JSON.stringify(an)), absP = JSON.parse(JSON.stringify(an)), resP = JSON.parse(JSON.stringify(res));
      let np = 0;
      eachNumber(relP, (p, v, o, k) => { o[k] = v * (1 + 1e-15); np++; }, '');
      eachNumber(absP, (p, v, o, k) => { o[k] = v + 1e-15; }, '');
      eachNumber(resP, (p, v, o, k) => { o[k] = v * (1 - 1e-15); }, '');
      assert(np > 1000, 'perturbed ' + np + ' numbers');
      assert.strictEqual(AI.hash16(AI.canon(resultsOf(relP), 'display')), h0, 'relative 1e-15 perturbation');
      assert.strictEqual(AI.hash16(AI.canon(resultsOf(absP), 'display')), h0, 'absolute 1e-15 perturbation');
      assert.strictEqual(AI.hash16(AI.canon(resOf(resP), 'display')), hr0, 'reference result, relative −1e-15');
      // …while a displayed change does change it
      const moved = JSON.parse(JSON.stringify(an)); moved.tests[5].result.final.S += 0.01;
      assert.notStrictEqual(AI.hash16(AI.canon(resultsOf(moved), 'display')), h0, 'a 0.01 skin change moves the results hash');
      // Round 8: FILES carries 53-55, the built app exposes the same canon / hash16 with the self-test stripped
      const FILES = require(path.join(__dirname, '..', 'concat-round8.js')).FILES;
      ['53-prism-autointerp.js', '54-prism-skin.js', '55-prism-autointerp-cal.js'].forEach((f) => assert(FILES.indexOf(f) !== -1, 'concat-round8 FILES has ' + f));
      assert(FILES.indexOf('53-prism-autointerp.js') > FILES.indexOf('52-prism-gas.js'), '53 after 52');
      // In --html mode the committed HTML carries file 53 only after the integrator's Round-8 rebuild (plan §2.6).
      if (ctx.mode === 'html' && !fs.readFileSync(path.join(__dirname, '..', '..', 'well-testing-app.html'), 'utf8').includes('BEGIN 53-prism-autointerp')) return;
      const W = app.win.PRiSM_autoInterp;
      assert(W && typeof W.canon === 'function' && typeof W.hash16 === 'function', 'app: window.PRiSM_autoInterp.canon / hash16 (' + ctx.mode + ' build)');
      assert.strictEqual(W.version, '1.0');
      assert.strictEqual(W.hash16('abc'), AI.hash16('abc'), 'app hash16 = file hash16');
      assert.strictEqual(W.canon(res, 'display'), AI.canon(res, 'display'), 'app canon = file canon (display)');
      assert.strictEqual(W.canon(an.tests[0].spec, 'inputs'), AI.canon(an.tests[0].spec, 'inputs'), 'app canon = file canon (inputs)');
      assert.strictEqual(app.win.PRiSM_autoInterp_selfTest, undefined, 'the self-test is stripped from the build');
    },
  },
];
