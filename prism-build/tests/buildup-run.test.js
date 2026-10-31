// Build-up Surveillance — WP2 pipeline tests (docs/BUILDUP-SURVEILLANCE-PLAN.md §3.7, §4.6 item 18, §4.8, §4.9, §9 WP2):
//   RU1 the Analysis passes checkShape                     RU6  stored (no record) reproduces the result hash
//   RU2 analyse = analyseAsync (resultHash), no timers     RU7  stage order; trend caps change K2/headline only
//   RU3 cancel rejects CANCELLED, no timers                RU8  spec.rateQC (daily, table), R4 in stage 3
//   RU4 an override re-runs exactly one test               RU9  80 detected tests → 60 kept by selection
//   RU5 the cache reuses unchanged tests                   RU10 WTS_buildup_compute({}) and inputHash
//
// WP1 (PRiSM_autoInterp.interpretJob, prepare, kHeldJob, backgroundCheck, confidence, drive) and WP3 (WTS_buildup.trend
// baseline / compute) are not merged on this branch: every test installs explicit stubs (§3, §9 WP2). interpretJob returns
// FIX.result with the test id; drive is a one-shot setTimeout(0) chain on the harness clock; trend.compute builds a
// Trend from FIX.analysis.trend with series for the tests it receives. Gauge records come from a small analytic
// generator in this file.
'use strict';

const S = require('./_buildup-shapes');

const WP = 'BU2';
const HOUR = 3600000, DAY = 86400000;
const J = (x) => JSON.parse(JSON.stringify(x));
const T0 = Date.UTC(2026, 2, 1);
const RANK = { low: 0, medium: 1, high: 2 };

// ── analytic generator (homogeneous reservoir, wellbore storage and skin, superposed over the rate steps) ────────────
const W0 = { k: 45, h: 50, phi: 0.2, mu: 1, B: 1.2, ct: 1e-5, rw: 0.354, C: 0.02, S: 2, q: 800, pInit: 4000 };
function rng(seed) {
  let s = seed >>> 0;
  const next = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { normal() { const u = Math.max(1e-12, next()), v = next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); } };
}
function makeRecord(o) {
  const w = W0, r = rng(o.seed || 1);
  const m1 = 162.6 * w.B * w.mu / (w.k * w.h), lt = Math.log10(w.k / (w.phi * w.mu * w.ct * w.rw * w.rw)) - 3.2275;
  const g = (t) => { if (!(t > 0)) return 0; const a = m1 * (Math.log10(t) + lt + 0.8686 * w.S), b = w.B * t / (24 * w.C); return a > 0 ? a * (1 - Math.exp(-b / a)) : b; };
  const st = [{ t: o.start_ms - 720 * HOUR, dq: w.q }];
  o.events.forEach((e) => { st.push({ t: e.t_ms, dq: -w.q }); st.push({ t: e.t_ms + e.dur_h * HOUR, dq: w.q }); });
  st.sort((a, b) => a.t - b.t);
  const dt = o.sample_s * 1000, n = Math.floor(o.days * DAY / dt) + 1, t = new Float64Array(n), p = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const ms = o.start_ms + i * dt;
    let s = 0;
    for (let j = 0; j < st.length && st[j].t < ms; j++) s += st[j].dq * g((ms - st[j].t) / HOUR);
    t[i] = ms; p[i] = w.pInit - s + 0.02 * r.normal();
  }
  return { t, p };
}
function allocRows(o) {
  const rows = [];
  for (let a = Date.UTC(2026, 2, 1); a < o.start_ms + o.days * DAY; a += DAY) {
    const cuts = [a, a + DAY];
    o.events.forEach((e) => [e.t_ms, e.t_ms + e.dur_h * HOUR].forEach((x) => { if (x > a && x < a + DAY) cuts.push(x); }));
    cuts.sort((x, y) => x - y);
    let V = 0, h = 0;
    for (let i = 0; i + 1 < cuts.length; i++) {
      const mid = (cuts[i] + cuts[i + 1]) / 2, shut = o.events.some((e) => mid >= e.t_ms && mid < e.t_ms + e.dur_h * HOUR);
      if (!shut) { V += 800 * (cuts[i + 1] - cuts[i]) / DAY; h += (cuts[i + 1] - cuts[i]) / HOUR; }
    }
    rows.push({ date: new Date(a).toISOString().slice(0, 10), oil: Math.round(V * 10) / 10, gas: Math.round(V * 400) / 1000, water: 0, hours: Math.round(h * 100) / 100 });
  }
  return rows;
}
const SCHED = [2, 6, 10, 14, 18, 22].map((d, i) => ({ t_ms: T0 + d * DAY + (9 + i) * HOUR, dur_h: [36, 24, 48, 30, 12, 40][i] }));
const WELL = { fluid: 'oil', h: 50, phi: 0.2, mu: 1, B: 1.2, ct: 1e-5, rw: 0.354, re_ft: null, Pb: null, Rs: null, gas: null, Bw: 1.02, muw: 0.5, allocAccPct: 5,
  driftPsiPerDay: 0.01, defaulted: [], sens: { h: 0.2, phi: 0.1, ct: 0.3, rw: 0.05, B: 0.05, mu: 0.2, q: 0.1 } };
let _recCache = {};
function makeInput(app, o) {
  o = o || {};
  const D = app.win.WTS_buildup.data, sched = o.sched || SCHED, days = o.days || 26, ss = o.sample_s || 300;
  const key = days + '|' + ss + '|' + JSON.stringify(sched);
  const g = _recCache[key] || (_recCache[key] = makeRecord({ start_ms: T0, days, sample_s: ss, events: sched, seed: 21 }));
  const record = { ok: true, origin_ms: g.t[0], t: g.t, p: g.p, T: null, n: g.t.length, source: 'csv', name: 'run-test.csv', zone: { mode: 'utc' }, pUnitIn: 'psia', patm: 14.696,
    elapsed: false, rollup: false, hash: D.recordHash(g.t, g.p), warnings: [] };
  return {
    record, stored: null, allocation: o.table ? null : { rows: allocRows({ start_ms: T0, days, events: sched }), gUnit: 'Mscf', resolution: { oil: 0.1, gas: 0.1, water: 0.1 } },
    rateTable: o.table ? [{ t_ms: T0 - 30 * DAY, q: 800 }].concat(...sched.map((e) => [{ t_ms: e.t_ms, q: 0 }, { t_ms: e.t_ms + e.dur_h * HOUR, q: 800 }])) : null,
    well: J(WELL), completion: null, depth: null, history: o.history || { mode: 'date', date: '2026-01-15', cum: null },
    zones: o.zones || { gauge: { mode: 'utc' }, day: { zone: { mode: 'utc' }, startHour: 0 } }, settings: J(S.FIX.inputs.settings),
    overrides: o.overrides || [], workovers: [], meta: { wellName: 'Well A', engineer: 'Engineer A', appVersion: '3.3' },
  };
}

// ── stubs for WP1 and WP3 ─────────────────────────────────────────────────────────────────────────────────────────
const FIXR = S.FIX.result, FIXA = S.FIX.analysis;
const KHELD = FIXA.tests.find((t) => t.result && t.result.kHeld).result.kHeld;
function setLabels(c, ks, model) {
  c.ks = ks; c.model = RANK[model] > RANK[ks] ? ks : model; c.headline = RANK[c.ks] < RANK[c.model] ? c.ks : c.model;
}
// o {pass1: {id: [ks, model]}, final: {id: [ks, model]}, kHeldIds: [id], cwd: [id] (closed without depletion)}
function stubs(app, o) {
  o = o || {};
  const W = app.win, log = [], specs = {};
  // an HTML built before Round 8 carried file 53 has no PRiSM_autoInterp: canon/hash16 then come from file 53 itself
  const AI = W.PRiSM_autoInterp || (W.PRiSM_autoInterp = { canon: S.autoInterp().canon, hash16: S.autoInterp().hash16 });
  AI.interpretJob = function (spec) {
    log.push('interpret:' + spec.id);
    specs[spec.id] = AI.canon(spec, 'inputs');
    const r = J(FIXR);
    r.id = spec.id; r.inputHash = AI.hash16(AI.canon(spec, 'inputs'));
    r.evidence._id = spec.id;
    const l = (o.pass1 || {})[spec.id];
    if (l) setLabels(r.confidence, l[0], l[1]);
    if ((o.kHeldIds || []).indexOf(spec.id) >= 0) { r.iarf.grade = 'none'; r.iarf.found = false; r.triggers.noneSkipped = true; }
    let n = 0;
    return { step() { n++; return { done: n >= 2, progress: Math.min(1, n / 2), label: 'stub ' + spec.id }; }, result() { return n >= 2 ? r : null; }, cancel() {} };
  };
  AI.prepare = function (spec) { log.push('prepare:' + spec.id); return { ok: true, id: spec.id }; };
  AI.kHeldJob = function (prep, ko) {
    log.push('kHeld:' + prep.id);
    const kh = J(KHELD); kh.k = ko.k; kh.delta = ko.delta; kh.fit.phys.k = ko.k;
    let n = 0;
    return { step() { n++; return { done: true, progress: 1, label: 'k-held' }; }, result() { return n ? kh : null; }, cancel() {} };
  };
  AI.backgroundCheck = function (res) { log.push('background:' + res.id); return { applied: true, slopeSource: 'pstar', triggersBefore: [], triggersAfter: [], boundaryDepends: false, ev: ['M7'] }; };
  AI.confidence = function (ev) {
    log.push('confidence:' + ev._id);
    const c = J(FIXR.confidence);
    const l = (o.final || {})[ev._id] || (o.pass1 || {})[ev._id];
    if (l) setLabels(c, l[0], l[1]);
    if (ev.kHeld) setLabels(c, 'medium', 'medium');
    return c;
  };
  AI.drive = function (job, d) {
    d = d || {};
    return new W.Promise(function (resolve, reject) {
      function tick() {
        let s;
        try { s = job.step(); } catch (e) { reject(e); return; }
        if (d.onProgress) d.onProgress(s.progress, s.label);
        if (s.done) { resolve(job.result()); return; }
        W.setTimeout(function () {
          if (d.shouldCancel && d.shouldCancel()) { job.cancel(); reject({ code: 'CANCELLED' }); return; }
          tick();
        }, 0);
      }
      tick();
    });
  };
  W.WTS_buildup.trend = {
    baseline(tt, n) { log.push('baseline:' + tt.map((x) => x.id).join(',')); return { tests: tt.slice(0, n).map((x) => x.id) }; },
    compute(tt) {
      log.push('trend:' + tt.map((x) => x.id + '=' + x.conf.ks).join(','));
      const T = J(FIXA.trend), used = tt.filter((x) => !x.excluded && RANK[x.conf.ks] >= 1), base = used.slice(0, 3).map((x) => x.id);
      T.n = tt.length; T.nUsed = used.length;
      T.baseline.tests = base; T.baseline.segments = base.length ? [{ from: tt[0].date, S: T.baseline.S, tests: base }] : [];
      T.series = tt.map((x) => ({ id: x.id, tDays: x.tDays, S: x.S, Serr: x.Serr, k: x.k, pExt: x.pExtDatum, pwf0Datum: x.pwf0Datum, Smech: null, SmechErr: null, Sd: null,
        conf: x.conf, used: { baseline: base.indexOf(x.id) >= 0, trend: used.indexOf(x) >= 0, alert: used.indexOf(x) >= 0 } }));
      ['delta', 'absolute'].forEach((k) => { T.alerts[k].raisedAt = null; T.alerts[k].confirmedAt = null; T.alerts[k].status = 'none'; });
      T.alerts.absolute.robustness = { lo: null, hi: null, unchanged: true };
      T.onset.cusum = { alarmAt: null, onsetAt: null };
      T.skinDp = tt.map((x) => ({ id: x.id, dpSkin_psi: x.dpSkin_psi }));
      T.modelFree = []; T.bubble.rows = []; T.piCheck.rows = []; T.excludedLow = { n: 0, ids: [], S: null, ev: ['T16'] };
      T.crossTest = { windowLevelInconsistent: [], closedWithoutDepletion: (o.cwd || []).slice() };
      return T;
    },
  };
  return { log, specs };
}
function shapeOk(assert, name, obj, what) {
  const r = S.checkShape(name, obj);
  assert.ok(r.ok, (what || name) + ' shape: ' + JSON.stringify(r.errors.slice(0, 6)));
}
async function settle(app, pr) {
  let done = false, val, err;
  pr.then((v) => { done = true; val = v; }, (e) => { done = true; err = e || { code: 'REJECTED' }; });
  for (let i = 0; i < 5000 && !done; i++) await app.flushAsync(5);
  return { done, val, err };
}
const R = (app) => app.win.WTS_buildup.run;

module.exports = [
  {
    name: 'RU1 the Analysis passes checkShape (tests, events, rates, QC, trend) and its input passes AnalysisInput',
    wp: WP,
    run(app, assert) {
      const st = stubs(app);
      const input = makeInput(app);
      shapeOk(assert, 'AnalysisInput', input);
      const an = R(app).analyse(input);
      assert.strictEqual(an.ok, true, 'ok: ' + JSON.stringify(an.errors || ''));
      shapeOk(assert, 'Analysis', J(an));
      assert.strictEqual(an.tests.length, 6, '6 build-ups');
      assert.deepStrictEqual(J(an.tests.map((t) => t.status)), Array(6).fill('interpreted'));
      assert.strictEqual(st.log.filter((l) => /^interpret:/.test(l)).length, 6);
      an.tests.forEach((t) => {
        assert.strictEqual(an.rates.steps[t.spec.stepRef.to].t_ms, t.tc_ms, t.id + ' stepRef.to is the q = 0 step at t_c');
        assert.ok(/^[0-9a-f]{16}$/.test(t.inputHash), t.id + ' per-test cache key');
        assert.strictEqual(t.result.confidence.stage, 'final');
      });
      assert.strictEqual(an.inputHash, R(app).inputHash(input));
      assert.ok(/^[0-9a-f]{16}$/.test(an.resultHash));
      assert.strictEqual(an.record.hash, input.record.hash);
      assert.deepStrictEqual(J(an.zones), { gauge: { mode: 'utc' }, day: { zone: { mode: 'utc' }, startHour: 0 } });
      assert.ok(an.baseline && an.baseline.k > 0, 'baseline from stage 2');
    },
  },
  {
    name: 'RU2 analyse and analyseAsync give the same resultHash, and no timers remain',
    wp: WP,
    async run(app, assert) {
      stubs(app);
      const input = makeInput(app);
      const a = R(app).analyse(input);
      let steps = 0;
      const r = await settle(app, R(app).analyseAsync(input, { onProgress: () => { steps++; } }));
      assert.ok(r.done && !r.err, 'async run resolved: ' + JSON.stringify(r.err || ''));
      assert.strictEqual(r.val.resultHash, a.resultHash, 'same resultHash');
      assert.strictEqual(r.val.inputHash, a.inputHash);
      assert.ok(steps > 6, 'sliced into units (' + steps + ')');
      app.flush(5000);
      assert.strictEqual(app.pendingTimers(), 0, 'no pending timers');
    },
  },
  {
    name: 'RU3 a cancel rejects CANCELLED and leaves no timers',
    wp: WP,
    async run(app, assert) {
      stubs(app);
      let n = 0;
      const r = await settle(app, R(app).analyseAsync(makeInput(app), { shouldCancel: () => ++n > 4 }));
      assert.ok(r.done, 'settled');
      assert.ok(r.err && r.err.code === 'CANCELLED', 'rejected CANCELLED');
      app.flush(5000);
      assert.strictEqual(app.pendingTimers(), 0, 'no pending timers');
      // without the engine's driver the async path refuses cleanly
      delete app.win.PRiSM_autoInterp.drive;
      const r2 = await settle(app, R(app).analyseAsync(makeInput(app)));
      assert.ok(r2.err && r2.err.code === 'NO_ENGINE');
    },
  },
  {
    name: 'RU4 an override re-runs exactly one test (stub call counter) plus stages 2–5',
    wp: WP,
    run(app, assert) {
      const st = stubs(app);
      const input = makeInput(app);
      const a = R(app).analyse(input);
      st.log.length = 0;
      const ov = { id: 'O1', kind: 'window', target: 'B2', value: { dt0_h: 2, dt1_h: 8 }, reason: 'Window after the phase-redistribution hump.', who: 'Engineer A', at: '2026-07-01T09:00:00Z', appVersion: '3.3' };
      const b = R(app).analyse(Object.assign({}, input, { overrides: [ov] }), { cache: a });
      assert.deepStrictEqual(J(st.log.filter((l) => /^interpret:/.test(l))), ['interpret:B2'], 'only B2 re-interpreted');
      assert.ok(st.log.some((l) => /^baseline:/.test(l)), 'stage 2 ran');
      assert.ok(st.log.some((l) => /^confidence:/.test(l)), 'stage 3 ran');
      assert.ok(st.log.some((l) => /^trend:/.test(l)), 'stage 4 ran');
      const t2 = b.tests.find((t) => t.id === 'B2');
      assert.deepStrictEqual(J(t2.spec.overrides.window), { dt0_h: 2, dt1_h: 8 });
      assert.deepStrictEqual(J(t2.overrides), ['O1']);
      assert.notStrictEqual(b.inputHash, a.inputHash, 'the override changes the input hash');
      shapeOk(assert, 'Analysis', J(b));
      // an exclusion changes no spec: nothing is re-interpreted, B4 is excluded
      st.log.length = 0;
      const c = R(app).analyse(Object.assign({}, input, { overrides: [Object.assign({}, ov, { id: 'O2', kind: 'exclude', target: 'B4', value: true })] }), { cache: a });
      assert.strictEqual(st.log.filter((l) => /^interpret:/.test(l)).length, 0);
      assert.strictEqual(c.tests.find((t) => t.id === 'B4').status, 'excluded');
      assert.ok(/O2/.test(c.tests.find((t) => t.id === 'B4').statusReason));
    },
  },
  {
    name: 'RU5 the cache reuses unchanged tests (no engine call, same result hash)',
    wp: WP,
    run(app, assert) {
      const st = stubs(app, { pass1: { B3: ['medium', 'medium'] } });
      const input = makeInput(app);
      const a = R(app).analyse(input);
      st.log.length = 0;
      const b = R(app).analyse(input, { cache: a });
      assert.strictEqual(st.log.filter((l) => /^interpret:/.test(l)).length, 0, 'no engine call');
      assert.strictEqual(b.resultHash, a.resultHash);
      assert.deepStrictEqual(J(b.tests.map((t) => t.inputHash)), J(a.tests.map((t) => t.inputHash)));
      assert.strictEqual(b.tests[2].result.confidence.ks, 'medium', 'pass-1 labels restored from the cache, then final labels again');
      // a cache from a JSON round trip (the stored state) works the same way
      st.log.length = 0;
      R(app).analyse(input, { cache: J(a) });
      assert.strictEqual(st.log.filter((l) => /^interpret:/.test(l)).length, 0);
    },
  },
  {
    name: 'RU6 stored (no record) reproduces the same result hash from the stored events, rates and per-test specs',
    wp: WP,
    run(app, assert) {
      const st = stubs(app);
      const input = makeInput(app);
      const a = R(app).analyse(input);
      const specsA = Object.assign({}, st.specs);
      const aj = J(a);
      const stored = { events: aj.events, rates: aj.rates, qc: aj.qc, tests: aj.tests.map((t) => ({ id: t.id, eventId: t.eventId, spec: t.spec })), record: aj.record, missed: aj.missed };
      const input2 = Object.assign({}, input, { record: null, stored });
      shapeOk(assert, 'AnalysisInput', input2);
      const b = R(app).analyse(input2);
      assert.strictEqual(b.ok, true);
      assert.strictEqual(b.resultHash, a.resultHash, 'same result hash');
      assert.strictEqual(b.inputHash, a.inputHash, 'same input hash (record hash from the stored summary)');
      Object.keys(specsA).forEach((id) => assert.strictEqual(st.specs[id], specsA[id], id + ': the engine sees the same spec'));
      shapeOk(assert, 'Analysis', J(b));
    },
  },
  {
    name: 'RU7 stage order: pass-1 labels → baseline (≥ medium) → pass 2 → final labels → trend → caps; a closed-without-depletion cap changes K2 and the headline only',
    wp: WP,
    run(app, assert) {
      const st = stubs(app, { pass1: { B3: ['low', 'low'], B2: ['high', 'high'] }, final: { B2: ['high', 'high'] }, kHeldIds: ['B5'], cwd: ['B2'] });
      const an = R(app).analyse(makeInput(app));
      const L = st.log, idx = (re) => L.findIndex((l) => re.test(l)), last = (re) => { let k = -1; L.forEach((l, i) => { if (re.test(l)) k = i; }); return k; };
      assert.ok(last(/^interpret:/) < idx(/^baseline:/), 'every pass-1 interpretation before the baseline');
      assert.strictEqual(L[idx(/^baseline:/)], 'baseline:B1,B2,B4,B5,B6', 'baseline over the pass-1 tests ≥ medium (B3 low excluded)');
      assert.ok(idx(/^baseline:/) < idx(/^kHeld:/) && idx(/^kHeld:/) < idx(/^confidence:/), 'pass 2 (k-held) after the baseline, before the final labels');
      assert.ok(idx(/^background:/) > idx(/^baseline:/), 'background check in pass 2');
      assert.ok(last(/^confidence:/) < idx(/^trend:/), 'final labels before the trend');
      assert.strictEqual(L.filter((l) => /^kHeld:/.test(l)).join(), 'kHeld:B5', 'k-held only for the eligible test');
      const b5 = an.tests.find((t) => t.id === 'B5').result;
      assert.strictEqual(b5.final.source, 'kHeld'); assert.strictEqual(b5.sErr.mode, 'kHeld'); assert.ok(b5.kHeld && b5.kHeld.k === an.baseline.k);
      assert.ok(b5.sErr.value >= b5.kHeld.S_k, 'S_err includes S_k');
      // trend caps: B2 closed without depletion → model and headline ≤ medium; k/S label and the used set unchanged
      const b2 = an.tests.find((t) => t.id === 'B2');
      assert.strictEqual(b2.result.confidence.ks, 'high');
      assert.strictEqual(b2.result.confidence.model, 'medium'); assert.strictEqual(b2.result.confidence.headline, 'medium');
      assert.ok(/B2=high/.test(L[idx(/^trend:/)]), 'the trend saw the final k/S label');
      const ser = an.trend.series.find((s) => s.id === 'B2');
      assert.deepStrictEqual(J(b2.used), J(ser.used), 'used set copied from the trend, not changed by the cap');
      assert.strictEqual(b2.used.trend, true);
      assert.strictEqual(an.tests.find((t) => t.id === 'B3').used.trend, false, 'a low test is not used');
      assert.strictEqual(b2.pass1.confidence.stage, 'pass1'); assert.strictEqual(b2.result.confidence.stage, 'final');
      shapeOk(assert, 'Analysis', J(an));
    },
  },
  {
    name: 'RU8 spec.rateQC is filled (allocation and table mode, dqSource, fRate); R4 is filled in stage 3 and unavailable with an estimated history',
    wp: WP,
    run(app, assert) {
      stubs(app);
      const a = R(app).analyse(makeInput(app));
      a.tests.forEach((t) => {
        const q = t.spec.rateQC;
        assert.strictEqual(q.source, 'allocation'); assert.strictEqual(q.dqSource, 'closingDay'); assert.strictEqual(q.r3Status, 'pass');
        assert.strictEqual(t.spec.fRate, 1); assert.strictEqual(q.dqKnown, true);
        assert.ok(q.r4Status === 'pass' || q.r4Status === 'fail', t.id + ' R4 evaluated in stage 3 (' + q.r4Status + ')');
        assert.ok(typeof q.r4 === 'number', 'R4 ratio');
        assert.strictEqual(t.result.evidence.r4Status, q.r4Status, 'evidence carries R4');
      });
      assert.ok(a.rates.days.some((d) => d.R4 && d.R4.status), 'days[].R4 filled');
      const u = R(app).analyse(makeInput(app, { history: { mode: 'unknown', date: null, cum: null } }));
      assert.strictEqual(u.rates.start.flag, true);
      u.tests.forEach((t) => { assert.strictEqual(t.spec.rateQC.r4Status, 'unavailable'); assert.strictEqual(t.spec.history.estimated, true); });
      const tb = R(app).analyse(makeInput(app, { table: true }));
      assert.strictEqual(tb.ok, true); assert.strictEqual(tb.rates.mode, 'table');
      assert.strictEqual(tb.tests.length, 6);
      tb.tests.forEach((t) => {
        const q = t.spec.rateQC;
        assert.strictEqual(q.source, 'table'); assert.strictEqual(q.r3Status, 'n/a'); assert.strictEqual(q.r4Status, 'n/a'); assert.strictEqual(q.dqSource, 'table');
        assert.strictEqual(t.Dq, 800);
      });
      shapeOk(assert, 'Analysis', J(tb));
    },
  },
  {
    name: 'RU9 80 detected tests → 60 kept by selection (longest per day, then per week; baseline tests kept), the others excluded with “test cap”',
    wp: WP,
    run(app, assert) {
      const st = stubs(app);
      const sched = [];
      // two shut-ins on every other day, reopened by 11:00 (the days between are clean, so the allocation can confirm them)
      for (let d = 1; d <= 40; d++) { const day = 2 * d - 1; sched.push({ t_ms: T0 + day * DAY + 1 * HOUR, dur_h: 3 }); sched.push({ t_ms: T0 + day * DAY + 7 * HOUR, dur_h: 4 }); }
      const an = R(app).analyse(makeInput(app, { sched, days: 82, sample_s: 300 }));
      assert.strictEqual(an.tests.length, 80, '80 tests');
      const kept = an.tests.filter((t) => t.status !== 'excluded'), capped = an.tests.filter((t) => t.statusReason === 'test cap');
      assert.strictEqual(kept.length, 60); assert.strictEqual(capped.length, 20);
      assert.strictEqual(st.log.filter((l) => /^interpret:/.test(l)).length, 60, 'capped tests are not interpreted');
      capped.forEach((t) => { assert.strictEqual(t.result, null); assert.ok(t.dtEnd_h < 3.5, t.id + ' capped is the shorter test of its day'); });
      const byDay = {};
      an.tests.forEach((t) => { if (!byDay[t.date] || t.dtEnd_h > byDay[t.date].dtEnd_h) byDay[t.date] = t; });
      Object.keys(byDay).forEach((d) => assert.notStrictEqual(byDay[d].status, 'excluded', 'longest test of ' + d + ' kept'));
      ['B1', 'B2', 'B3'].forEach((id) => assert.notStrictEqual(an.tests.find((t) => t.id === id).status, 'excluded', id + ' (baseline) kept'));
      assert.ok(an.tests.slice(-8).every((t) => t.status !== 'excluded'), 'the newest tests are kept');
      shapeOk(assert, 'Analysis', J(an));
    },
  },
  {
    name: 'RU10 WTS_buildup_compute({}) → {ok:false, code:NO_DATA} without throwing; inputHash changes with the resolved zone name, not with a unit-system flip',
    wp: WP,
    run(app, assert) {
      stubs(app);
      const W = app.win;
      assert.fn(W.WTS_buildup_compute);
      [{}, null, undefined, { record: null }].forEach((x) => {
        const r = W.WTS_buildup_compute(x);
        assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'NO_DATA');
        assert.ok(Array.isArray(r.errors) && Array.isArray(r.bad));
      });
      const bad = W.WTS_buildup_compute(Object.assign(makeInput(app), { well: Object.assign(J(WELL), { h: -1 }) }));
      assert.strictEqual(bad.code, 'BAD_WELL'); assert.ok(J(bad.bad).indexOf('h') >= 0);
      const R0 = R(app), base = makeInput(app);
      const zone = (tz) => Object.assign({}, base, { zones: { gauge: { mode: 'iana', tz }, day: { zone: { mode: 'iana', tz }, startHour: 0 } } });
      const hL = R0.inputHash(zone('Europe/London')), hP = R0.inputHash(zone('Europe/Paris'));
      assert.notStrictEqual(hL, hP, 'resolved zone name is hashed');
      assert.strictEqual(R0.inputHash(zone('Europe/London')), hL, 'deterministic');
      // a Metric/Imperial round trip leaves last-bit differences only
      const flip = J(base.well); ['h', 'phi', 'mu', 'B', 'ct', 'rw', 'Bw', 'muw'].forEach((k) => { flip[k] = flip[k] * (1 + 3e-12); });
      assert.strictEqual(R0.inputHash(Object.assign({}, base, { well: flip })), R0.inputHash(base), 'unit flip does not change the hash');
      const moved = J(base.well); moved.h = 51;
      assert.notStrictEqual(R0.inputHash(Object.assign({}, base, { well: moved })), R0.inputHash(base), 'a real input change does');
      // 'device' resolves to the device IANA name before hashing
      const dev = Object.assign({}, base, { zones: { gauge: { mode: 'device' }, day: { zone: { mode: 'device' }, startHour: 0 } } });
      assert.strictEqual(R0.inputHash(dev), R0.inputHash(zone(W.Intl.DateTimeFormat().resolvedOptions().timeZone)));
    },
  },
];
