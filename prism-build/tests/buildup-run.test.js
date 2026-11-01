// Build-up Surveillance — WP2 pipeline tests (docs/BUILDUP-SURVEILLANCE-PLAN.md §3.7, §4.6 item 18, §4.8, §4.9, §9 WP2):
//   RU1 the Analysis passes checkShape                     RU6  stored (no record) reproduces the result hash
//   RU2 analyse = analyseAsync (resultHash), no timers     RU7  stage order; trend caps change K2/headline only
//   RU3 cancel rejects CANCELLED, no timers                RU8  spec.rateQC (daily, table), R4 in stage 3
//   RU4 an override re-runs exactly one test               RU9  80 detected tests → 60 kept by selection
//   RU5 the cache reuses unchanged tests                   RU10 WTS_buildup_compute({}) and inputHash
//   RU15 inputHash of the clean input (deep copies, stored re-run)   RU16 gas B ≥ 0.3   RU17 test-cap re-admission
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
// ln Δt_e over a spec's rate history, as the engine's prepare builds it (§3.1, D6; steps scaled so the final drop is Δq)
function lnDteOf(spec) {
  const st = spec.steps.map((s) => ({ t: s.t, q: Math.abs(s.q) })), n = st.length, scale = spec.Dq / st[n - 2].q;
  const u = st.map((s) => ({ t: s.t, q: s.q * scale })), dqn = u[n - 1].q - u[n - 2].q, terms = [];
  for (let i = 0; i < n - 1; i++) { const dq = u[i].q - (i > 0 ? u[i - 1].q : 0); if (dq !== 0) terms.push({ w: dq / dqn, off: spec.tc_h - u[i].t }); }
  return (dt) => { let v = Math.log(dt); for (const tm of terms) v += tm.w * (Math.log(tm.off + dt) - Math.log(tm.off)); return v; };
}
// o {pass1: {id: [ks, model]}, final: {id: [ks, model]}, kHeldIds: [id], cwd: [id] (closed without depletion),
//    finalPatch: {id: {final fields}} (pass-1 final values), consistentBins (bins from the spec, Δt_e from its rate steps),
//    prepareExtra(spec) (fields merged into the prepare result), kHeldFail (the k-held job returns a failure)}
function stubs(app, o) {
  o = o || {};
  const W = app.win, log = [], specs = {}, evs = {}, out = { log, specs, evs, tt: null, version: null };
  // an HTML built before Round 8 carried file 53 has no PRiSM_autoInterp: canon/hash16 then come from file 53 itself
  const AI = W.PRiSM_autoInterp || (W.PRiSM_autoInterp = { canon: S.autoInterp().canon, hash16: S.autoInterp().hash16 });
  AI.interpretJob = function (spec, jo) {
    log.push('interpret:' + spec.id);
    specs[spec.id] = AI.canon(spec, 'inputs');
    out.jobOpts = jo;
    const r = J(FIXR);
    r.id = spec.id; r.inputHash = AI.hash16(AI.canon(spec, 'inputs'));
    r.evidence._id = spec.id;
    const l = (o.pass1 || {})[spec.id];
    if (l) setLabels(r.confidence, l[0], l[1]);
    if ((o.kHeldIds || []).indexOf(spec.id) >= 0) { r.iarf.grade = 'none'; r.iarf.found = false; r.triggers.noneSkipped = true; }
    if (o.finalPatch && o.finalPatch[spec.id]) Object.assign(r.final, J(o.finalPatch[spec.id]));
    if (o.consistentBins) {
      const f = lnDteOf(spec), n = spec.dt.length;
      r.bins = { dt: spec.dt.slice(), dp: spec.p.map((p) => p - spec.pwf0), n: (spec.n || spec.dt.map(() => 1)).slice(), deriv: spec.dt.map(() => 1), full: spec.dt.map(() => true) };
      r.bins.X = r.bins.dt.map(f); r.bins.dte = r.bins.X.map(Math.exp);
      r.evidence.dteEnd_h = r.bins.dte[n - 1]; r.evidence.dtEnd_h = spec.dt[n - 1];
    }
    let n = 0;
    return { step() { n++; return { done: n >= 2, progress: Math.min(1, n / 2), label: 'stub ' + spec.id }; }, result() { return n >= 2 ? r : null; }, cancel() {} };
  };
  AI.prepare = function (spec) { log.push('prepare:' + spec.id); return Object.assign({ ok: true, id: spec.id }, o.prepareExtra ? o.prepareExtra(spec) : {}); };
  AI.kHeldJob = function (prep, ko) {
    log.push('kHeld:' + prep.id);
    const kh = o.kHeldFail ? { ok: false, code: 'FAILED' } : J(KHELD);
    if (!o.kHeldFail) { kh.k = ko.k; kh.delta = ko.delta; kh.fit.phys.k = ko.k; }
    let n = 0;
    return { step() { n++; return { done: true, progress: 1, label: 'k-held' }; }, result() { return n ? kh : null; }, cancel() {} };
  };
  AI.backgroundCheck = function (res) { log.push('background:' + res.id); return { applied: true, slopeSource: 'pstar', triggersBefore: [], triggersAfter: [], boundaryDepends: false, ev: ['M7'] }; };
  AI.confidence = function (ev) {
    log.push('confidence:' + ev._id);
    evs[ev._id] = J(ev);
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
      out.tt = J(tt);
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
  return out;
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
      // the IARF settings reach the engine through spec.opts (band and slope fractions, minCycles)
      an.tests.forEach((t) => {
        assert.strictEqual(t.spec.opts.band, an.settings.interp.band, t.id + ' spec.opts.band');
        assert.strictEqual(t.spec.opts.slope, an.settings.interp.slope, t.id + ' spec.opts.slope');
        assert.strictEqual(t.spec.opts.minCycles, an.settings.interp.minCycles, t.id + ' spec.opts.minCycles');
      });
      st.log.length = 0;
      const wide = Object.assign({}, input, { settings: Object.assign(J(input.settings), { interp: Object.assign(J(input.settings.interp), { band: 0.15, slope: 0.05, minCycles: 0.4 }) }) });
      R(app).analyse(wide, { cache: an });
      assert.strictEqual(st.log.filter((l) => /^interpret:/.test(l)).length, 6, 'new IARF settings re-run every test');
      const seen = JSON.parse(st.specs.B1).opts;
      assert.deepStrictEqual([seen.band, seen.slope, seen.minCycles], [0.15, 0.05, 0.4], 'the engine sees the new IARF settings');
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
      // event_drop removes a detection; event_add at the typed closing time brings it back as a manual event
      const ovd = Object.assign({}, ov, { id: 'O3', kind: 'event_drop', target: 'E1', value: true });
      const d = R(app).analyse(Object.assign({}, input, { overrides: [ovd] }), { cache: a });
      assert.strictEqual(d.tests.length, 5); assert.strictEqual(d.events.find((e) => e.id === 'E1').status, 'excluded');
      const ova = Object.assign({}, ov, { id: 'O4', kind: 'event_add', target: null, value: { t_ms: SCHED[0].t_ms, exact: true } });
      const e2 = R(app).analyse(Object.assign({}, input, { overrides: [ovd, ova] }), { cache: a });
      const added = e2.events.find((e) => e.manual && !e.dropped);
      assert.ok(added && added.id === 'E7', 'manual event added with the next id');
      assert.strictEqual(e2.tests.length, 6); assert.strictEqual(e2.tests[0].eventId, 'E7');
      assert.strictEqual(added.tc_ms, SCHED[0].t_ms); assert.near(added.dtEnd_h, 36, 0.1);
      shapeOk(assert, 'Analysis', J(e2));
      // the page's 'input' audit entry: a field diff of the inputs
      const diff = J(R(app).inputDiff(input, Object.assign({}, input, { well: Object.assign(J(WELL), { h: 60 }) })));
      assert.deepStrictEqual(diff, [{ field: 'well.h', from: 50, to: 60 }]);
      assert.deepStrictEqual(J(R(app).inputDiff(input, input)), []);
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
      // results of another engine or app version are never reused (§4.9)
      const AI = app.win.PRiSM_autoInterp, v0 = AI.version;
      st.log.length = 0;
      AI.version = '9.9';
      R(app).analyse(input, { cache: a });
      assert.strictEqual(st.log.filter((l) => /^interpret:/.test(l)).length, 6, 'engine version change re-runs every test');
      AI.version = v0;
      st.log.length = 0;
      R(app).analyse(Object.assign({}, input, { meta: Object.assign({}, input.meta, { appVersion: '3.4' }) }), { cache: a });
      assert.strictEqual(st.log.filter((l) => /^interpret:/.test(l)).length, 6, 'app version change re-runs every test');
    },
  },
  {
    name: 'RU5b a cache from the stored copy (no curves, bins.X, bins.dte) gives the trend the same Δt_e axis as a fresh run',
    wp: WP,
    run(app, assert) {
      const st = stubs(app, { consistentBins: true });
      const input = makeInput(app);
      const a = R(app).analyse(input);
      const fresh = {};
      st.tt.forEach((x) => { fresh[x.id] = x.bins.dte; });
      assert.ok(Object.keys(fresh).length === 6 && fresh.B1.length > 10);
      const cache = J(a);
      cache.tests.forEach((t) => { delete t.result.curves; delete t.result.bins.X; delete t.result.bins.dte; });
      st.log.length = 0; st.tt = null;
      const b = R(app).analyse(input, { cache });
      assert.strictEqual(st.log.filter((l) => /^interpret:/.test(l)).length, 0, 'cache hit');
      assert.strictEqual(b.resultHash, a.resultHash);
      st.tt.forEach((x) => {
        assert.strictEqual(x.bins.dte.length, fresh[x.id].length, x.id + ' same bins');
        x.bins.dte.forEach((v, i) => assert.rel(v, fresh[x.id][i], 1e-12, x.id + ' Δt_e[' + i + ']'));
        assert.ok(x.bins.dte[x.bins.dte.length - 1] < b.tests.find((t) => t.id === x.id).result.bins.dt.slice(-1)[0], x.id + ': Δt_e, not Δt');
      });
      b.tests.forEach((t) => assert.strictEqual(t.result.bins.dte.length, t.result.bins.dt.length, t.id + ' bins.dte restored'));
      shapeOk(assert, 'Analysis', J(b));
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
      // event-level overrides need the raw record: one the stored events do not reflect is reported, never silently ignored
      const ovd = { id: 'O1', kind: 'event_drop', target: 'E2', value: true, reason: 'Gauge swapped during this shut-in.', who: 'Engineer A', at: '2026-07-01T09:00:00Z', appVersion: '3.3' };
      const c = R(app).analyse(Object.assign({}, input2, { overrides: [ovd] }));
      assert.strictEqual(c.ok, true);
      assert.ok(c.warnings.some((w) => w.code === 'OVERRIDE_NOT_APPLIED' && /O1/.test(w.text)), 'warning in Analysis.warnings');
      assert.strictEqual(c.overrides[0].warnings[0].code, 'OVERRIDE_NOT_APPLIED', 'warning on the override');
      assert.strictEqual(c.tests.length, 6, 'nothing dropped without the record');
      shapeOk(assert, 'Analysis', J(c));
      // an analysis made with the drop applied reproduces from its stored state without a warning
      const d = J(R(app).analyse(Object.assign({}, input, { overrides: [ovd] })));
      const sd = { events: d.events, rates: d.rates, qc: d.qc, tests: d.tests.map((t) => ({ id: t.id, eventId: t.eventId, spec: t.spec })), record: d.record, missed: d.missed };
      const e = R(app).analyse(Object.assign({}, input, { record: null, stored: sd, overrides: [ovd] }));
      assert.ok(!e.warnings.some((w) => w.code === 'OVERRIDE_NOT_APPLIED'), 'applied drop: no warning');
      assert.strictEqual(e.resultHash, d.resultHash, 'and the same result hash');
      assert.deepStrictEqual(J(e.tests.map((t) => t.id)), J(d.tests.map((t) => t.id)), 'and the same test ids');
      // incomplete stored states are refused, never returned as an analysis that fails its shape
      [{ events: [], rates: {}, qc: {}, tests: [] }, Object.assign({}, stored, { qc: {} }), Object.assign({}, stored, { rates: Object.assign({}, aj.rates, { steps: [] }) })].forEach((s2, i) => {
        const r = R(app).analyse(Object.assign({}, input, { record: null, stored: s2 }));
        assert.strictEqual(r.ok, false, 'incomplete stored state ' + i); assert.strictEqual(r.code, 'NO_DATA');
      });
      // no stored record summary: the origin comes from the stored specs
      const f = R(app).analyse(Object.assign({}, input2, { stored: Object.assign({}, stored, { record: undefined }) }));
      assert.strictEqual(f.ok, true); assert.near(f.record.origin_ms, a.record.origin_ms, 1, 'origin from the stored specs');
      shapeOk(assert, 'Analysis', J(f));
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
      // the cap runs before the labels are known: the first 2·baseN tests are kept as baseline candidates
      ['B1', 'B2', 'B3', 'B4', 'B5', 'B6'].forEach((id) => assert.notStrictEqual(an.tests.find((t) => t.id === id).status, 'excluded', id + ' (baseline candidate) kept'));
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
      // the allocation's volume resolution changes the R3 tolerance (hashed); the report detail changes no number (not hashed)
      const res10 = Object.assign({}, base, { allocation: Object.assign({}, base.allocation, { resolution: { oil: 10, gas: 10, water: 10 } }) });
      assert.notStrictEqual(R0.inputHash(res10), R0.inputHash(base), 'allocation resolution hashed');
      const det = Object.assign({}, base, { settings: Object.assign(J(base.settings), { report: { detail: 'all' } }) });
      assert.strictEqual(R0.inputHash(det), R0.inputHash(base), 'report detail not hashed');
      // a null override neither throws nor changes the hash
      assert.strictEqual(R0.inputHash(Object.assign({}, base, { overrides: [null] })), R0.inputHash(base));
      const withNull = R0.analyse(Object.assign({}, base, { overrides: [null] }));
      assert.strictEqual(withNull.ok, true); assert.deepStrictEqual(J(withNull.overrides), []);
      // non-finite samples (a store decode, an external generator) are skipped, never passed to the engine
      const nanRec = Object.assign({}, base.record, { t: Float64Array.from(base.record.t), p: Float64Array.from(base.record.p) });
      [100, 2000, 2001, 3500].forEach((i) => { nanRec.p[i] = NaN; });
      const an = R0.analyse(Object.assign({}, base, { record: nanRec }));
      assert.strictEqual(an.ok, true, 'NaN samples: ' + JSON.stringify(an.errors || ''));
      assert.ok(an.warnings.some((w) => w.code === 'SAMPLES_SKIPPED'));
      an.tests.forEach((t) => assert.ok(t.spec.p.every((v) => typeof v === 'number' && isFinite(v)), t.id + ' finite spec.p'));
      shapeOk(assert, 'Analysis', J(an));
      // the §3.7 four-argument specFor gets its noise from data.qc when no QC is passed
      const D = W.WTS_buildup.data, sc = D.scan(base.record, { allocation: base.allocation, zones: { day: base.zones.day }, settings: { detect: {} }, history: base.history, well: base.well });
      const sp = R0.specFor(sc.events[1], sc.record, sc.rates, base);
      assert.ok(sp.sigma_psi > 0 && sp.sigmaFlow_psi > 0, 'σ from data.qc (' + sp.sigma_psi + ')');
      shapeOk(assert, 'BuildupSpec', sp);
    },
  },
  {
    name: 'RU11 k-held final values scale the pass-1 values by k_old/k_new (gas: pseudo-pressure m, Δm_skin, Δp_skin), never the liquid m with the oil B and μ',
    wp: WP,
    run(app, assert) {
      const k0 = FIXR.final.k, Sh = KHELD.fit.phys.S, m0 = 1.2e5, dp0 = 300.9;
      const patch = { B5: { k: 2 * k0, kh: 2 * k0 * 50, S: Sh, m: m0, mPrime: m0 / Math.LN10, dpSkin_psi: dp0, rinv_ft: 900, rinvE_ft: 800,
                            gas: { Sprime: Sh, dmSkin: 0.8686 * m0 * Sh, dpSkin_psi: dp0 } } };
      const st = stubs(app, { kHeldIds: ['B5'], finalPatch: patch });
      const input = makeInput(app);
      input.well = Object.assign(J(WELL), { fluid: 'gas', gas: { sg: 0.65, T_F: 200, co2: 0, h2s: 0, n2: 0, pseudoTime: false, pdew: null, apiCond: null, Mo: null } });
      input.allocation.rows = input.allocation.rows.map((r) => Object.assign({}, r, { oil: 0, gas: r.oil, water: 0 }));
      const an = R(app).analyse(input);
      assert.strictEqual(an.ok, true, JSON.stringify(an.errors || ''));
      assert.strictEqual(an.rates.unit, 'Mscf/d');
      const t5 = an.tests.find((t) => t.id === 'B5'), f = t5.result.final, kNew = an.baseline.k, ratio = 2 * k0 / kNew;
      assert.strictEqual(f.source, 'kHeld'); assert.strictEqual(f.k, kNew); assert.rel(ratio, 2, 1e-12);
      assert.rel(f.m, m0 * ratio, 1e-12, 'm scales by k_old/k_new');
      assert.rel(f.mPrime, m0 / Math.LN10 * ratio, 1e-12, "m' scales by k_old/k_new");
      assert.rel(f.gas.dmSkin, 0.8686 * f.m * f.S, 1e-12, 'Δm_skin = 0.8686·m·S');
      assert.rel(f.gas.dpSkin_psi, dp0 * ratio, 1e-12, 'Δp_skin scales with Δm_skin (S unchanged here)');
      assert.strictEqual(f.dpSkin_psi, f.gas.dpSkin_psi, 'dpSkin_psi from final.gas');
      assert.strictEqual(f.gas.Sprime, f.S);
      assert.rel(f.rinv_ft, 900 / Math.sqrt(ratio), 1e-12, 'r_inv ∝ √k'); assert.rel(f.rinvE_ft, 800 / Math.sqrt(ratio), 1e-12);
      assert.rel(t5.result.sErr.sPwf, 1.1513 * t5.spec.pwf0SE / f.m, 1e-9, 'S_pwf from the scaled m');
      assert.rel(t5.result.sErr.sTc, 1.1513 * Math.abs(t5.spec.dpdt_flow) * t5.spec.dtc_h / f.m, 1e-9, 'S_tc from the scaled m');
      assert.strictEqual(st.tt.find((x) => x.id === 'B5').dpSkin_psi, f.dpSkin_psi, 'the trend gets the same Δp_skin');
      shapeOk(assert, 'Analysis', J(an));
      // with the prepare's gas table, Δp_skin comes from the table
      stubs(app, { kHeldIds: ['B5'], finalPatch: patch, prepareExtra: (spec) => ({ gasTable: { pOfPn: (pn) => pn + 0.5 * (pn - spec.pwf0) }, adata: { pRef: spec.pwf0 }, sign: 1 }) });
      const f2 = R(app).analyse(input).tests.find((t) => t.id === 'B5').result.final;
      assert.rel(f2.gas.dpSkin_psi, 1.5 * Math.abs(f2.gas.dmSkin), 1e-12, 'Δp_skin through the gas table');
      // oil well: the same scaling, Δp_skin = 0.8686·m·S, no gas block
      const lp = { B5: { k: 2 * k0, kh: 2 * k0 * 50, S: Sh, m: 40, mPrime: 40 / Math.LN10, dpSkin_psi: 0.8686 * 40 * Sh, gas: null } };
      stubs(app, { kHeldIds: ['B5'], finalPatch: lp });
      const f3 = R(app).analyse(makeInput(app)).tests.find((t) => t.id === 'B5').result.final;
      assert.rel(f3.m, 80, 1e-12); assert.rel(f3.dpSkin_psi, 0.8686 * 80 * f3.S, 1e-12); assert.strictEqual(f3.gas, null);
    },
  },
  {
    name: 'RU12 test ids are stable: an exclusion stays on its build-up when an earlier test is included (with or without the cache); previous ids are reused, never moved',
    wp: WP,
    run(app, assert) {
      stubs(app);
      const sched = [SCHED[0], { t_ms: T0 + 4 * DAY + 15 * HOUR, dur_h: 1 }].concat(SCHED.slice(1));
      const input = makeInput(app, { sched });
      const a = R(app).analyse(input);
      assert.strictEqual(a.events.find((e) => e.id === 'E2').status, 'too_short');
      assert.deepStrictEqual(J(a.tests.map((t) => t.eventId)), ['E1', 'E3', 'E4', 'E5', 'E6', 'E7']);
      const idE3 = a.tests.find((t) => t.eventId === 'E3').id;
      const ov = (id, kind, target) => ({ id, kind, target, value: true, reason: 'Engineer decision on this test.', who: 'Engineer A', at: '2026-07-01T09:00:00Z', appVersion: '3.3' });
      const exc = ov('O1', 'exclude', idE3), inc = ov('O2', 'include', 'E2');
      const b = R(app).analyse(Object.assign({}, input, { overrides: [exc] }), { cache: a });
      assert.strictEqual(b.tests.find((t) => t.eventId === 'E3').status, 'excluded');
      [b, null].forEach((cache) => {
        const c = R(app).analyse(Object.assign({}, input, { overrides: [exc, inc] }), { cache });
        const t2 = c.tests.find((t) => t.eventId === 'E2'), t3 = c.tests.find((t) => t.eventId === 'E3');
        assert.ok(t2 && t2.status === 'interpreted', 'E2 included (' + (cache ? 'cache' : 'no cache') + ')');
        assert.strictEqual(t3.id, idE3, 'E3 keeps its id'); assert.strictEqual(t3.status, 'excluded', 'E3 stays excluded');
        assert.notStrictEqual(t2.id, idE3);
        assert.deepStrictEqual(J(t3.overrides), ['O1']);
        c.tests.filter((t) => t.eventId !== 'E3').forEach((t) => assert.notStrictEqual(t.status, 'excluded', t.id + ' not excluded'));
        shapeOk(assert, 'Analysis', J(c));
      });
      // ids of an earlier analysis (another numbering) are kept for the same closings; a new test never takes one of them
      const old = J(a);
      old.tests.forEach((t, i) => { t.id = 'B' + (11 + i); t.result.id = t.id; });
      const d = R(app).analyse(Object.assign({}, input, { overrides: [inc] }), { cache: old });
      d.tests.forEach((t) => { const o = old.tests.find((x) => x.eventId === t.eventId); if (o) assert.strictEqual(t.id, o.id, t.eventId + ' keeps ' + o.id); });
      const d2 = d.tests.find((t) => t.eventId === 'E2');
      assert.ok(old.tests.every((x) => x.id !== d2.id), 'the new test takes a free id (' + d2.id + ')');
      // an override on an old id still reaches its build-up
      const e = R(app).analyse(Object.assign({}, input, { overrides: [ov('O3', 'exclude', 'B12')] }), { cache: old });
      assert.strictEqual(e.tests.find((t) => t.id === 'B12').eventId, 'E3'); assert.strictEqual(e.tests.find((t) => t.id === 'B12').status, 'excluded');
      shapeOk(assert, 'Analysis', J(d));
    },
  },
  {
    name: 'RU13 work units: at most one engine call (prepare or background check) per step; a failed k-held pass reaches the final labels as kHeldConverged false',
    wp: WP,
    run(app, assert) {
      const st = stubs(app, { kHeldIds: ['B2', 'B5'], kHeldFail: true });
      const j = R(app).job(makeInput(app));
      let s, guard = 0, maxCalls = 0, steps = 0;
      do {
        const n0 = st.log.length;
        s = j.step(); steps++;
        maxCalls = Math.max(maxCalls, st.log.slice(n0).filter((l) => /^(prepare|background):/.test(l)).length);
      } while (!s.done && ++guard < 10000);
      const an = j.result();
      assert.strictEqual(an.ok, true);
      assert.strictEqual(maxCalls, 1, 'at most one engine call per unit');
      assert.strictEqual(st.log.filter((l) => /^background:/.test(l)).length, 6, 'a background check for every test');
      assert.strictEqual(st.log.filter((l) => /^prepare:/.test(l)).length, 2, 'one prepare per k-held test');
      ['B2', 'B5'].forEach((id) => {
        const t = an.tests.find((x) => x.id === id);
        assert.strictEqual(st.evs[id].kHeldConverged, false, id + ': the failed k-held pass is seen by the final labels');
        assert.strictEqual(t.result.evidence.kHeldConverged, false);
        assert.strictEqual(t.result.kHeld, null);
      });
      assert.strictEqual(st.evs.B1.kHeldConverged, null, 'not eligible: null');
      shapeOk(assert, 'Analysis', J(an));
    },
  },
  {
    name: 'RU14 manual events never disturb detected ones: a flowing-period time, a time before the record, a detected closing',
    wp: WP,
    run(app, assert) {
      stubs(app);
      const input = makeInput(app);
      const a = R(app).analyse(input);
      const ov = (id, value) => ({ id, kind: 'event_add', target: null, value, reason: 'Shut-in reported by the operator.', who: 'Engineer A', at: '2026-07-01T09:00:00Z', appVersion: '3.3' });
      // (1) a flowing period 34 h before the 03-07 closing: no rise → refused; forced (exact) → bounded before E2
      const flow = Date.UTC(2026, 2, 6, 0);
      const b0 = R(app).analyse(Object.assign({}, input, { overrides: [ov('O1', { t_ms: flow })] }), { cache: a });
      assert.ok(/no pressure rise/.test(b0.overrides[0].warnings[0].text), 'refused without a rise');
      assert.strictEqual(b0.resultHash, a.resultHash, 'nothing changed');
      const b = R(app).analyse(Object.assign({}, input, { overrides: [ov('O1', { t_ms: flow, exact: true })] }), { cache: a });
      const m = b.events.find((e) => e.manual), E2 = b.events.find((e) => e.id === 'E2');
      assert.ok(m && m.id === 'E7', 'forced manual event added');
      assert.ok(m.tEnd_ms < E2.tc_ms - 30 * 60000, 'it ends before the next closing');
      const t2 = b.tests.find((t) => t.eventId === 'E2'), a2 = a.tests.find((t) => t.eventId === 'E2');
      assert.ok(t2 && t2.status === 'interpreted', 'E2 still interpreted'); assert.strictEqual(t2.id, a2.id, 'same test id'); assert.ok(t2.Dq > 0);
      shapeOk(assert, 'Analysis', J(b));
      // (2) ten days before the record, (3) at a detected closing: refused with a warning, nothing changes
      const c = R(app).analyse(Object.assign({}, input, { overrides: [ov('O2', { t_ms: input.record.t[0] - 10 * DAY }), ov('O3', { t_ms: SCHED[1].t_ms + 60000, exact: true })] }), { cache: a });
      assert.strictEqual(c.events.length, a.events.length, 'no event added');
      assert.deepStrictEqual(J(c.tests.map((t) => [t.id, t.status])), J(a.tests.map((t) => [t.id, t.status])), 'tests unchanged');
      assert.strictEqual(c.resultHash, a.resultHash);
      ['O2', 'O3'].forEach((id) => {
        const o = c.overrides.find((x) => x.id === id);
        assert.ok(o.warnings && o.warnings[0].code === 'OVERRIDE_NOT_APPLIED', id + ' carries the refusal');
        assert.ok(c.warnings.some((w) => w.code === 'OVERRIDE_NOT_APPLIED' && w.text.indexOf(id) >= 0), id + ' in Analysis.warnings');
      });
      assert.ok(/outside the gauge record/.test(c.overrides[0].warnings[0].text));
      assert.ok(/already closes/.test(c.overrides[1].warnings[0].text));
      shapeOk(assert, 'Analysis', J(c));
    },
  },
  {
    name: 'RU15 inputHash is the hash of the input as given: deep copies (as the page hands them) of a record-mode run and of its stored re-run hash the same; the input is never written',
    wp: WP,
    run(app, assert) {
      stubs(app);
      const input = makeInput(app), before = R(app).inputHash(input), rowsCopy = J(input.allocation.rows);
      const copyOf = (x) => Object.assign(J(Object.assign({}, x, { record: null })), { record: x.record });
      const a = R(app).analyse(copyOf(input));
      assert.strictEqual(a.inputHash, before, 'record mode: the hash of the clean input');
      const b = R(app).analyse(input);
      assert.strictEqual(b.inputHash, before, 'same input object: same hash');
      assert.deepStrictEqual(J(input.allocation.rows), rowsCopy, 'the allocation rows are not written (no _V)');
      const aj = J(a);
      const stored = { events: aj.events, rates: aj.rates, qc: aj.qc, tests: aj.tests.map((t) => ({ id: t.id, eventId: t.eventId, spec: t.spec })), record: aj.record, missed: aj.missed };
      // the page's reload path: a fresh deep copy of the stored input (no raw record)
      const c = R(app).analyse(J(Object.assign({}, input, { record: null, stored })));
      assert.strictEqual(c.ok, true);
      assert.strictEqual(c.inputHash, a.inputHash, 'a re-run from the stored build-ups keeps the record-mode hash (a signed report stays SIGNED)');
      assert.strictEqual(c.resultHash, a.resultHash, 'and the result hash');
    },
  },
  {
    name: 'RU16 well checks: a gas formation volume factor down to 0.3 RB/Mscf is accepted (deep dry gas); oil keeps 0.5; below 0.3 is refused',
    wp: WP,
    run(app, assert) {
      stubs(app);
      const gasWell = (B) => Object.assign(J(WELL), { fluid: 'gas', B, mu: 0.025, ct: 1e-4, gas: { sg: 0.65, T_F: 220 } });
      const ok = R(app).analyse(Object.assign(makeInput(app), { well: gasWell(0.32) }));
      assert.ok(!(ok.ok === false && ok.code === 'BAD_WELL'), 'gas B 0.32 accepted: ' + JSON.stringify(ok.errors || ''));
      const low = R(app).analyse(Object.assign(makeInput(app), { well: gasWell(0.25) }));
      assert.strictEqual(low.code, 'BAD_WELL'); assert.ok(low.bad.indexOf('B') >= 0);
      assert.ok(/0\.3 and 5/.test(low.errors.join(' ')), 'the message names the gas range: ' + low.errors.join(' '));
      const oil = R(app).analyse(Object.assign(makeInput(app), { well: Object.assign(J(WELL), { B: 0.32 }) }));
      assert.strictEqual(oil.code, 'BAD_WELL', 'oil B 0.32 refused'); assert.ok(/0\.5 and 5/.test(oil.errors.join(' ')));
    },
  },
  {
    name: 'RU17 test cap re-admission: when the kept baseline candidates of a segment turn out low, its earliest capped tests are interpreted after all and join the baseline',
    wp: WP,
    run(app, assert) {
      const sched = [];
      for (let d = 1; d <= 40; d++) { const day = 2 * d - 1; sched.push({ t_ms: T0 + day * DAY + 1 * HOUR, dur_h: 3 }); sched.push({ t_ms: T0 + day * DAY + 7 * HOUR, dur_h: 4 }); }
      // the six kept baseline candidates (B1–B6) come out low after pass 1; every other test medium
      const pass1 = {};
      for (let i = 1; i <= 80; i++) pass1['B' + i] = i <= 6 ? ['low', 'low'] : ['medium', 'medium'];
      const st = stubs(app, { pass1 });
      const an = R(app).analyse(makeInput(app, { sched, days: 82, sample_s: 300 }));
      assert.strictEqual(an.tests.length, 80, '80 tests');
      const capped = an.tests.filter((t) => t.statusReason === 'test cap'), interp = st.log.filter((l) => /^interpret:/.test(l));
      assert.strictEqual(capped.length, 17, '3 of the 20 capped tests re-admitted (baseN = 3)');
      assert.strictEqual(interp.length, 63, '60 + 3 interpretations');
      const re = an.tests.filter((t) => t.status === 'interpreted' && t.result && interp.indexOf('interpret:' + t.id) > 59);
      assert.strictEqual(re.length, 3, 're-admitted tests interpreted: ' + re.map((t) => t.id).join(','));
      // they are the earliest capped tests of the segment
      const firstCapped = an.tests.filter((t) => t.statusReason === 'test cap' || re.indexOf(t) >= 0).slice(0, 3).map((t) => t.id);
      assert.deepStrictEqual(re.map((t) => t.id), firstCapped, 'the earliest capped tests');
      assert.ok(an.baseline && re.some((t) => an.baseline.tests.indexOf(t.id) >= 0), 'a re-admitted test is in the baseline: ' + JSON.stringify(an.baseline && an.baseline.tests));
      assert.ok(an._order.some((o) => /^readmit:/.test(o)), 'readmit step in the stage order');
      shapeOk(assert, 'Analysis', J(an));
    },
  },
  {
    name: 'RU18 a summarised cache (the stored state after an overflow: summary:true, no bins, quality, storage) is never reused: those tests are re-interpreted and every result passes checkShape',
    wp: WP,
    run(app, assert) {
      const st = stubs(app);
      const input = makeInput(app);
      const a = R(app).analyse(input);
      // what the store writes for each test when the state overflows (49-calc-buildup-store.js _sumResult)
      const summarise = (r) => ({ ok: r.ok, id: r.id, version: r.version, inputHash: r.inputHash, testType: r.testType, reason: r.reason || null, final: r.final || null,
        sErr: r.sErr ? { value: r.sErr.value, mode: r.sErr.mode } : null,
        confidence: r.confidence ? { ks: r.confidence.ks, model: r.confidence.model, headline: r.confidence.headline, stage: r.confidence.stage } : null,
        chosen: r.chosen ? { key: r.chosen.key, label: r.chosen.label } : null,
        iarf: r.iarf ? { found: r.iarf.found, grade: r.iarf.grade, cycles: r.iarf.cycles, dt0_h: r.iarf.dt0_h, dt1_h: r.iarf.dt1_h } : null,
        evidence: r.evidence || null, summary: true });
      const cache = J(a);
      cache.tests.forEach((t) => { if (t.result) t.result = summarise(t.result); });
      assert.ok(cache.tests.every((t) => t.inputHash && t.pass1 && t.result && t.result.summary), 'summaries keep inputHash and pass1');
      st.log.length = 0;
      const b = R(app).analyse(input, { cache });
      assert.strictEqual(st.log.filter((l) => /^interpret:/.test(l)).length, 6, 'every summarised test re-interpreted');
      b.tests.forEach((t) => {
        assert.ok(!t.result.summary, t.id + ' is a whole result');
        shapeOk(assert, 'BuildupResult', J(t.result), t.id + ' BuildupResult');
      });
      shapeOk(assert, 'Analysis', J(b));
      assert.strictEqual(b.resultHash, a.resultHash, 'the same analysis as a fresh run');
      // a mixed cache: the complete results are still reused, only the summarised one runs again
      const mixed = J(a);
      mixed.tests[1].result = summarise(mixed.tests[1].result);
      st.log.length = 0;
      const c = R(app).analyse(input, { cache: mixed });
      assert.deepStrictEqual(st.log.filter((l) => /^interpret:/.test(l)), ['interpret:' + a.tests[1].id], 'only the summarised test re-runs');
      assert.strictEqual(c.resultHash, a.resultHash);
    },
  },
  {
    name: 'RU19 anchored event overrides follow their closing when detection renumbers the events (event_drop, tc, an E-id exclude); a vanished closing is reported, never moved; legacy overrides keep the id rule',
    wp: WP,
    run(app, assert) {
      stubs(app);
      const base = { reason: 'Gauge swapped during this shut-in.', who: 'Engineer A', at: '2026-07-01T09:00:00Z', appVersion: '3.3' };
      const full = R(app).analyse(makeInput(app));
      const e3 = full.events.find((e) => e.id === 'E3');
      assert.ok(e3 && Math.abs(e3.tc_ms - SCHED[2].t_ms) <= 5 * 60000, 'E3 is the third closing in the full record');
      const anchor = e3.tc_ms;
      // the first shut-in is no longer detected (a shorter record, a stricter setting): every later event id shifts down
      const shifted = SCHED.slice(1);
      const dropOv = Object.assign({ id: 'O1', kind: 'event_drop', target: 'E3', value: { anchor_ms: anchor } }, base);
      const a = R(app).analyse(makeInput(app, { sched: shifted, overrides: [dropOv] }));
      assert.strictEqual(a.events.find((e) => e.id === 'E3').tc_ms > anchor + DAY, true, 'E3 is now the next closing');
      const dropped = a.events.filter((e) => e.dropped);
      assert.strictEqual(dropped.length, 1, 'one event dropped');
      assert.ok(Math.abs(dropped[0].tc_ms - anchor) <= 5 * 60000, 'the anchored closing is dropped (' + dropped[0].id + '), not the new E3');
      assert.ok(!a.warnings.some((w) => w.code === 'OVERRIDE_NOT_APPLIED'), 'applied: no warning');
      assert.ok(a.tests.every((t) => Math.abs(t.tc_ms - anchor) > HOUR), 'no test at the dropped closing');
      shapeOk(assert, 'Analysis', J(a));
      // the named closing itself vanishes: not applied (with the reason), and nothing else is dropped
      const gone = R(app).analyse(makeInput(app, { sched: SCHED.filter((e, i) => i !== 2), overrides: [dropOv] }));
      assert.strictEqual(gone.events.filter((e) => e.dropped).length, 0, 'nothing dropped');
      const w = gone.warnings.find((x) => x.code === 'OVERRIDE_NOT_APPLIED' && /O1/.test(x.text));
      assert.ok(w && /no longer detected/.test(w.text), 'OVERRIDE_NOT_APPLIED: ' + (w && w.text));
      assert.strictEqual(gone.overrides[0].warnings[0].code, 'OVERRIDE_NOT_APPLIED');
      // legacy (no anchor) keeps the id rule
      const legacy = R(app).analyse(makeInput(app, { sched: shifted, overrides: [Object.assign({}, dropOv, { value: true })] }));
      assert.strictEqual(legacy.events.find((e) => e.dropped).id, 'E3', 'legacy override: by id');
      // a closing-time override follows its anchor too, and so does an exclude that names the event
      const tcOv = Object.assign({ id: 'O2', kind: 'tc', target: 'E3', value: { tc_ms: anchor + 30 * 60000, anchor_ms: anchor } }, base);
      const exOv = Object.assign({ id: 'O3', kind: 'exclude', target: 'E4', value: { anchor_ms: full.events.find((e) => e.id === 'E4').tc_ms } }, base);
      const b = R(app).analyse(makeInput(app, { sched: shifted, overrides: [tcOv, exOv] }));
      const moved = b.events.find((e) => (e.overrideIds || []).indexOf('O2') >= 0);
      assert.ok(moved && moved.tc_ms === anchor + 30 * 60000 && moved.id === 'E2', 'tc override on the anchored event (now E2): ' + (moved && moved.id));
      assert.ok(!b.events.some((e) => e.id === 'E3' && e.manual), 'the new E3 keeps its detected closing');
      const tEx = b.tests.find((t) => t.status === 'excluded');
      assert.ok(tEx && Math.abs(tEx.tc_ms - SCHED[3].t_ms) <= 5 * 60000 && tEx.overrides.indexOf('O3') >= 0, 'the exclude follows its closing: ' + (tEx && tEx.id));
      assert.strictEqual(b.tests.filter((t) => t.status === 'excluded').length, 1);
      assert.ok(b.tests.find((t) => t.eventId === 'E2').overrides.indexOf('O2') >= 0, 'the tc override is listed on its test');
      shapeOk(assert, 'Analysis', J(b));
    },
  },
  {
    name: 'RU20 missed-shut-in detectability is sign-aware: an injector whose fall-offs end 300 psi below pwf (|p* − pwf| ≥ 2·T_s) is detectable; a producer 1 psi above is not',
    wp: WP,
    run(app, assert) {
      stubs(app);
      const AI = app.win.PRiSM_autoInterp, ij = AI.interpretJob;
      let dp = 300;
      AI.interpretJob = function (spec, jo) {
        const j = ij(spec, jo);
        return { step: j.step, cancel: j.cancel, result() { const r = j.result(); if (r) r.final.pStar = spec.pwf0 + (spec.testType === 'falloff' ? -1 : 1) * dp; return r; } };
      };
      // the producer record mirrored about 4,000 psia: injection raises the pressure, each shut-in is a fall-off
      const inj = makeInput(app);
      const D = app.win.WTS_buildup.data, p = Float64Array.from(inj.record.p, (v) => 8000 - v);
      inj.record = Object.assign({}, inj.record, { p, hash: D.recordHash(inj.record.t, p) });
      inj.well = Object.assign(J(WELL), { fluid: 'water_inj' });
      inj.allocation.rows = inj.allocation.rows.map((r) => ({ date: r.date, oil: null, gas: null, water: r.oil, hours: r.hours }));
      const a = R(app).analyse(inj);
      assert.strictEqual(a.ok, true, JSON.stringify(a.errors || ''));
      assert.ok(a.tests.length >= 5 && a.tests.every((t) => t.spec.testType === 'falloff'), 'fall-offs: ' + a.tests.map((t) => t.spec.testType).join(','));
      const d = a.missed.detectability;
      assert.ok(d.Ts_psi > 0 && 300 >= 2 * d.Ts_psi, 'the case meets |p* − pwf| ≥ 2·T_s (T_s ' + d.Ts_psi + ')');
      assert.near(d.pStarMinusPwf_psi, 300, 1e-6, 'the sign-aware size of the change, not −300');
      assert.strictEqual(d.ok, true, 'detectable');
      shapeOk(assert, 'Analysis', J(a));
      // a producer whose build-ups end only 1 psi above pwf: not detectable
      dp = 1;
      const b = R(app).analyse(makeInput(app));
      assert.near(b.missed.detectability.pStarMinusPwf_psi, 1, 1e-6);
      assert.strictEqual(b.missed.detectability.ok, false, 'below 2·T_s');
    },
  },
  {
    name: 'RU21 a previous id moves by event number only with a closing-time override: a vanished closing 4 h earlier with the same E number keeps its id (and its exclusion) to itself; a tc-moved closing keeps its own id',
    wp: WP,
    run(app, assert) {
      stubs(app);
      const base = { reason: 'bad gauge on that short shut-in', who: 'Engineer A', at: '2026-07-01T09:00:00Z', appVersion: '3.3' };
      const input = makeInput(app);
      const a = R(app).analyse(input);
      const t2 = a.tests.find((t) => t.eventId === 'E2');
      assert.strictEqual(t2.id, 'B2');
      // the cache holds an earlier, short shut-in that is no longer detected: same E number, closing 4 h before E2
      const cache = J(a);
      const c2 = cache.tests.find((t) => t.eventId === 'E2');
      c2.id = 'B99'; c2.tc_ms = t2.tc_ms - 4 * HOUR; if (c2.result) c2.result.id = 'B99';
      const ov = Object.assign({ id: 'O1', kind: 'exclude', target: 'B99', value: true }, base);
      const b = R(app).analyse(Object.assign({}, input, { overrides: [ov] }), { cache });
      const n2 = b.tests.find((t) => t.eventId === 'E2');
      assert.notStrictEqual(n2.id, 'B99', 'the id of the vanished shut-in is not given to E2');
      assert.strictEqual(n2.status, 'interpreted', 'and its exclusion does not follow: ' + n2.statusReason);
      assert.ok(!b.tests.some((t) => t.id === 'B99'), 'no test B99');
      shapeOk(assert, 'Analysis', J(b));
      // a closing-time override moving E3 by 2 h keeps its previous id (anchored and legacy)
      const tc3 = a.tests.find((t) => t.eventId === 'E3').tc_ms;
      [{ tc_ms: tc3 + 2 * HOUR, anchor_ms: tc3 }, { tc_ms: tc3 + 2 * HOUR }].forEach((value, i) => {
        const tcOv = Object.assign({ id: 'O2', kind: 'tc', target: 'E3', value }, base);
        const c = R(app).analyse(Object.assign({}, input, { overrides: [tcOv] }), { cache: a });
        const m = c.tests.find((t) => t.tc_ms === tc3 + 2 * HOUR);
        assert.ok(m && m.id === 'B3', (i ? 'legacy' : 'anchored') + ' tc override keeps B3: ' + (m && m.id));
      });
    },
  },
  {
    name: 'RU22 gas wells need the gas gravity and the reservoir temperature: a gas well without well.gas, or with sg / T_F missing or out of range, is refused (BAD_WELL), never analysed as a liquid or with silent defaults',
    wp: WP,
    run(app, assert) {
      stubs(app);
      const gasWell = (gas) => Object.assign(J(WELL), { fluid: 'gas', B: 0.8, mu: 0.025, ct: 1e-4 }, gas === undefined ? {} : { gas });
      const ok = R(app).analyse(Object.assign(makeInput(app), { well: gasWell({ sg: 0.65, T_F: 220 }) }));
      assert.ok(!(ok.ok === false && ok.code === 'BAD_WELL'), 'complete gas inputs accepted: ' + JSON.stringify(ok.errors || ''));
      [[undefined, ['gas.sg', 'gas.T_F']], [null, ['gas.sg', 'gas.T_F']], [{ sg: 0.65, T_F: null }, ['gas.T_F']], [{ sg: null, T_F: 220 }, ['gas.sg']],
       [{ sg: 0.4, T_F: 220 }, ['gas.sg']], [{ sg: 0.65, T_F: 900 }, ['gas.T_F']]].forEach(([gas, bad]) => {
        const r = R(app).analyse(Object.assign(makeInput(app), { well: gasWell(gas) }));
        assert.strictEqual(r.code, 'BAD_WELL', JSON.stringify(gas) + ' refused');
        assert.deepStrictEqual(J(r.bad), bad, JSON.stringify(gas) + ' names ' + bad.join(', '));
        assert.ok(/gas gravity|reservoir temperature/.test(r.errors.join(' ')), r.errors.join(' '));
      });
      // oil and injector wells need no gas block
      const oil = R(app).analyse(makeInput(app));
      assert.notStrictEqual(oil.code, 'BAD_WELL');
    },
  },
  {
    name: 'RU23 wet-gas equivalent: the spec\'s gas table uses the recombined well-stream gravity (sgSeparator keeps the entry); the dry-gas basis keeps the separator gravity',
    wp: WP,
    run(app, assert) {
      stubs(app);
      const D = app.win.WTS_buildup.data, rh0 = D.rates(null, [], [{ date: '2026-03-01', oil: 700, gas: 10000, water: 0, hours: 24 }, { date: '2026-03-02', oil: 700, gas: 10000, water: 0, hours: 24 }],
        { fluid: 'gas', day: { zone: { mode: 'utc' }, startHour: 0 }, gas: { sg: 0.68, T_F: 220, apiCond: 50 } });
      const input = makeInput(app);
      input.well = Object.assign(J(WELL), { fluid: 'gas', B: 0.8, mu: 0.025, ct: 1e-4, gas: { sg: 0.68, T_F: 220, co2: 0, h2s: 0, n2: 0, pseudoTime: false, pdew: null, apiCond: 50, Mo: null } });
      const ev = { id: 'E1', kind: 'shutin', tc_ms: SCHED[1].t_ms, tEnd_ms: SCHED[1].t_ms + 24 * HOUR, dtEnd_h: 24, pwf0: 3500, pwf0SE: 0.1, dtc_s: 0, trend: { b: 0 } };
      const mk = (pb) => R(app).specFor(app.toWin(ev), input.record, app.toWin({ mode: 'daily', unit: 'Mscf/d', phaseBasis: pb, byEvent: { E1: { Dq: 5000 } },
        steps: [{ t_ms: T0 - 30 * DAY, q: 5000 }, { t_ms: SCHED[1].t_ms, q: 0 }], start: { source: 'date', prepend_h: 0, q: 5000, flag: false }, days: [] }), input, { qc: { sigma_psi: 0.02, dtMed_s: 300 } });
      assert.strictEqual(rh0.phaseBasis.used, 'gasEq');
      const wet = mk(J(rh0.phaseBasis));
      assert.ok(wet && wet.gas, 'spec built: ' + JSON.stringify(wet && wet.errors));
      assert.near(wet.gas.sg, rh0.phaseBasis.wellStreamSg, 1e-12, 'well-stream gravity');
      assert.deepStrictEqual([wet.gas.sgSeparator, wet.gas.sgBasis], [0.68, 'wellStream']);
      const dry = mk({ used: 'gas', wcMax: null, gorRatioMax: null, twoPhaseCt: false });
      assert.deepStrictEqual([dry.gas.sg, dry.gas.sgSeparator], [0.68, undefined], 'dry gas: the entered gravity');
    },
  },
];
