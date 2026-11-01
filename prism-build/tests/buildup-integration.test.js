// Build-up Surveillance — end-to-end integration on the REAL engines, plan §9 WP6 IN1–IN6 (cross-WP tests live
// only here, §2.6 rule 5).
//
// These tests need every engine: PRiSM_autoInterp.interpretJob / drive / stats (WP1, 53-prism-autointerp.js),
// WTS_buildup.data + run (WP2), trend (WP3), synth demos (WP4), review (WP5) and PRiSM_skinCheck (WP7). On a work-
// package branch where any of them is missing, each test prints "[skip] …" with the missing modules and returns
// without asserting — the file can be committed before the integration merge. After the integrator merges WP1–WP7
// nothing is skipped (the [skip] line disappears from the run log).
//
// Budget (plan §9.0): the oil and gas demo analyses run once per file (through the page, so the page's drive chain
// and cancel test are part of the path) and are shared by IN1–IN6.
'use strict';

const WP = 'WP6';

function missing(w, extra) {
  const m = [];
  const AI = w.PRiSM_autoInterp || {}, B = w.WTS_buildup || {};
  if (typeof AI.interpretJob !== 'function') m.push('PRiSM_autoInterp.interpretJob (WP1, 53-prism-autointerp.js)');
  if (typeof AI.drive !== 'function') m.push('PRiSM_autoInterp.drive (WP1)');
  if (!B.run || typeof B.run.analyseAsync !== 'function') m.push('WTS_buildup.run (WP2, 49-calc-buildup-run.js)');
  if (!B.data || typeof B.data.parseJob !== 'function') m.push('WTS_buildup.data (WP2, 49-calc-buildup-data.js)');
  if (!B.synth || typeof B.synth.demo !== 'function') m.push('WTS_buildup.synth (WP4, 49-calc-buildup-synth.js)');
  (extra || []).forEach((k) => {
    if (k === 'review' && !(B.review && typeof B.review.report === 'function')) m.push('WTS_buildup.review (WP5, 49-calc-buildup-review.js)');
    if (k === 'trend' && !(B.trend && typeof B.trend.compute === 'function')) m.push('WTS_buildup.trend (WP3, 49-calc-buildup-trend.js)');
    if (k === 'skin' && !(w.PRiSM_skinCheck && typeof w.PRiSM_skinCheck.rateSkin === 'function')) m.push('PRiSM_skinCheck (WP7, 54-prism-skin.js)');
  });
  return m;
}
function skipped(name, app, extra) {
  const m = missing(app.win, extra);
  if (!m.length) return false;
  console.log('[skip] ' + name + ' — needs the real engines; missing: ' + m.join('; ') + '. Runs after the integrator merges WP1–WP7.');
  return true;
}

const P = (app) => app.win.WTS_buildup.page;
const txt = (el) => String(el ? el.textContent : '').replace(/\s+/g, ' ').trim();
async function idle(app, max) {
  for (let i = 0; i < (max || 200000); i++) {
    await app.flushAsync(1);
    if (!P(app).isRunning()) { for (let k = 0; k < 4; k++) await app.flushAsync(1); return true; }
  }
  return false;
}
// Run a demo through the page; returns {analysis, stats, pending, state, audit}.
const _runs = {};
async function demo(ctx, kind) {
  if (_runs[kind]) return _runs[kind];
  const app = ctx.loadApp({});
  try {
    const AI = app.win.PRiSM_autoInterp;
    if (typeof AI.resetStats === 'function') AI.resetStats();
    app.hook.nav('buildup'); app.flush(20);
    app.select('bu_src', 'demo');
    app.select('bu_demo_kind', kind);
    app.click('bu_demo_load');
    const t0 = Date.now();
    app.click('bu_run');
    const ok = await idle(app);
    const ms = Date.now() - t0;
    if (!ok) throw new Error(kind + ' demo analysis did not finish');
    if (app.el('bu_res').getAttribute('data-done') !== '1') throw new Error(kind + ' demo: no results — ' + txt(app.el('bu_progress')) + ' ' + txt(app.el('bu_val')));
    app.flush(5000);
    const st = P(app).state();
    _runs[kind] = {
      analysis: JSON.parse(JSON.stringify(st.analysis)), truth: JSON.parse(JSON.stringify(app.win.WTS_buildup.synth.demo(kind).truth || {})),
      stats: typeof AI.stats === 'function' ? JSON.parse(JSON.stringify(AI.stats())) : null, pending: app.pendingTimers(), ms,
      storage: { wts_buildup_state: app.storage.getItem('wts_buildup_state'), wts_buildup_audit: app.storage.getItem('wts_buildup_audit'), wts_page_buildup: app.storage.getItem('wts_page_buildup') },
      pub: app.win.WTS_state.buildup ? JSON.parse(JSON.stringify(app.win.WTS_state.buildup)) : null,   // WTS_state.buildup (§3.12)
    };
    console.log('[buildup-integration] ' + kind + ' demo analysed through the page in ' + ms + ' ms (' + st.analysis.tests.length + ' tests)');
  } finally { app.dispose(); }
  return _runs[kind];
}
const interpreted = (a) => a.tests.filter((t) => t.status === 'interpreted' && t.result && t.result.final);
const RANK = { low: 0, medium: 1, high: 2 };
const BAD_TXT = /\b(NaN|Infinity|undefined|null)\b|\[object Object\]/;
function nearestTruth(truth, t) {
  let best = null;
  (truth.tests || []).forEach((x) => { if (!best || Math.abs(x.tc_ms - t.tc_ms) < Math.abs(best.tc_ms - t.tc_ms)) best = x; });
  return best && Math.abs(best.tc_ms - t.tc_ms) <= 2 * 3600000 ? best : null;
}
// Demo truth id (B1…) of an analysis test id. Tests are matched by CLOSING TIME: the analysis numbers every detected
// event (the too-short shut-in and the partial cut take ids too), so demo B6 is not analysis B6.
function demoId(a, truth, id) {
  const t = id ? a.tests.find((x) => x.id === id) : null, tr = t ? nearestTruth(truth, t) : null;
  return tr ? tr.id : null;
}
// {truthId: analysis test} for the interpreted tests, asserting one analysis test per demo build-up
function byClosing(assert, a, truth, ok) {
  const m = {};
  ok.forEach((t) => {
    const tr = nearestTruth(truth, t);
    assert.ok(tr, t.id + ': a demo truth entry within 2 h of the closing (truth.tests[].tc_ms)');
    assert.ok(!m[tr.id], 'one analysis test per demo build-up: ' + tr.id + ' matches ' + (m[tr.id] && m[tr.id].id) + ' and ' + t.id);
    m[tr.id] = t;
  });
  return m;
}

module.exports = [
  {
    name: 'IN1 integration oil demo: 9 interpreted, 1 too short, 1 partial; k within 10 % of 45; S path within ±0.6; expected grades; delta raised B6 / confirmed B7; absolute raised B7; ≥ 8 of 9 k/S labels ≥ medium',
    wp: WP,
    timeoutMs: 600000,
    async run(app, assert, ctx) {
      if (skipped('IN1', app, ['trend', 'review', 'skin'])) return;
      const r = await demo(ctx, 'oil'), a = r.analysis;
      const ok = interpreted(a);
      assert.strictEqual(ok.length, 9, 'interpreted build-ups: ' + a.tests.map((t) => t.id + ':' + t.status).join(' '));
      assert.strictEqual(a.events.filter((e) => e.status === 'too_short').length, 1, 'one short shut-in "too short"');
      assert.strictEqual(a.events.filter((e) => e.kind === 'partial' || e.status === 'partial').length, 1, 'one partial cut');
      // Truth per build-up from synth.demo('oil').truth.tests[] (§3.9): {id, tc_ms, k, S, dtEnd_h, grade}, matched to the
      // analysis by closing time. The expected IARF grade (GE4, truth.tests[].grade) must equal the engine's on all nine
      // (B1 good, B2–B9 fair). The generator grades with the engine's definition — the earliest-run, longest window with
      // the median band, the drift and valley guards, and the OLS slope over its last half cycle — on the noise-free
      // derivative taken against the superposition time of the input-consistent rate history (the given daily volumes).
      // The earlier mismatch on B1 and B2 was that abscissa, not noise: the true rate is smooth and the 3 % day-to-day
      // variation lives in the allocation, so against the true rates the last half cycle slopes at −0.012 / −0.014 per
      // ln Δt_e and against the given rates at −0.003 / −0.010, which is what the engine measured (WP8).
      const m = byClosing(assert, a, r.truth, ok);
      assert.deepStrictEqual(Object.keys(m).sort(), r.truth.tests.map((x) => x.id).sort(), 'every demo build-up interpreted once');
      ok.forEach((t) => {
        const tr = nearestTruth(r.truth, t), lbl = t.id + ' (demo ' + tr.id + ')';
        assert.ok(Math.abs(t.result.final.k / 45 - 1) <= 0.10, lbl + ' k ' + t.result.final.k + ' within 10 % of 45');
        assert.ok(typeof tr.S === 'number', lbl + ': truth S present');
        assert.ok(Math.abs(t.result.final.S - tr.S) <= 0.6, lbl + ' S ' + t.result.final.S + ' within ±0.6 of ' + tr.S);
        assert.ok(/^(good|fair|none)$/.test(String(tr.grade)), lbl + ': expected IARF grade recorded in truth.tests[].grade (got ' + JSON.stringify(tr.grade) + ')');
        const g = t.result.iarf && t.result.iarf.grade;
        assert.strictEqual(g, tr.grade, lbl + ' IARF grade ' + g + ' = the expected ' + tr.grade + ' (GE4)');
      });
      assert.deepStrictEqual(r.truth.tests.map((x) => x.grade), ['good', 'fair', 'fair', 'fair', 'fair', 'fair', 'fair', 'fair', 'fair'], 'the expected grades cover good and fair');
      // the alerts name analysis ids; the plan states them in demo ids
      const al = a.trend.alerts, dn = (id) => demoId(a, r.truth, id) + ' (analysis ' + id + ')';
      assert.strictEqual(demoId(a, r.truth, al.delta.raisedAt), 'B6', 'delta alert raised at B6: ' + dn(al.delta.raisedAt));
      assert.strictEqual(demoId(a, r.truth, al.delta.confirmedAt), 'B7', 'delta alert confirmed at B7: ' + dn(al.delta.confirmedAt));
      assert.strictEqual(demoId(a, r.truth, al.absolute.raisedAt), 'B7', 'absolute alert raised at B7: ' + dn(al.absolute.raisedAt));
      const good = ok.filter((t) => RANK[t.result.confidence.ks] >= RANK.medium).length;
      assert.ok(good >= 8, 'k/S labels ≥ medium on ' + good + ' of 9 tests');
    },
  },
  {
    name: 'IN2 integration gas demo: D resolved (D/se ≥ 2); no delta alert on the 6 constant-skin tests; delta raised at test 7 and confirmed at test 8',
    wp: WP,
    timeoutMs: 600000,
    async run(app, assert, ctx) {
      if (skipped('IN2', app, ['trend', 'review', 'skin'])) return;
      const r = await demo(ctx, 'gas'), a = r.analysis, ok = interpreted(a), rs = a.trend.rateSkin;
      // cross-WP (WP3 × WP7): the trend's expected D is the correlation's central D for the analysis's baseline k and
      // well (PRiSM_skinCheck.expectedDRange(expected).D), not the midpoint of its ×1/3 … ×3 range
      const w = a.well || {}, cmp = a.completion || {}, kB = a.baseline && a.baseline.k > 0 ? a.baseline.k : (a.trend.baseline || {}).k;
      const exp = { k: kB, h: w.h, hp: cmp.hp_ft > 0 ? cmp.hp_ft : w.h, rw: w.rw, sg: w.gas && w.gas.sg, mu_g: w.mu };
      const er = app.win.PRiSM_skinCheck.expectedDRange(app.toWin(exp));
      assert.ok(rs && er && typeof rs.expectedD === 'number' && Math.abs(rs.expectedD / er.D - 1) < 1e-9,
        'Trend.rateSkin.expectedD ' + (rs && rs.expectedD) + ' = PRiSM_skinCheck.expectedDRange(expected).D ' + (er && er.D) + ' for ' + JSON.stringify(exp));
      // every demo build-up interpreted, matched by closing time (8 tests: D needs both rate levels)
      assert.strictEqual(ok.length, 8, 'gas build-ups interpreted: ' + a.tests.map((t) => t.id + ':' + t.status).join(' ') +
        ' / events ' + a.events.map((e) => e.id + ':' + e.status).join(' '));
      const m = byClosing(assert, a, r.truth, ok);
      assert.deepStrictEqual(Object.keys(m).sort(), r.truth.tests.map((x) => x.id).sort(), 'every demo build-up interpreted once');
      assert.ok(rs && rs.resolved, 'rate-dependent skin resolved: ' + (rs && rs.reason));
      assert.ok(rs.seD > 0 && rs.D / rs.seD >= 2, 'D/se = ' + (rs.D / rs.seD));
      // the 6 constant-skin tests are demo B1–B6 (truth.constantSkinTests); test 7 / 8 are demo B7 / B8
      const al = a.trend.alerts.delta, nConst = r.truth.constantSkinTests || 6, at = demoId(a, r.truth, al.raisedAt);
      assert.ok(!(at && Number(at.slice(1)) <= nConst), 'no delta alert on the ' + nConst + ' constant-skin tests (raised at demo ' + at + ', analysis ' + al.raisedAt + ')');
      assert.strictEqual(at, 'B7', 'delta raised at test 7 (analysis ' + al.raisedAt + ')');
      assert.strictEqual(demoId(a, r.truth, al.confirmedAt), 'B8', 'delta confirmed at test 8 (analysis ' + al.confirmedAt + ')');
    },
  },
  {
    name: 'IN3 integration review: the evidence check passes on both real demo analyses (no V14) and the re-derivation rules V23–V27 do not fire',
    wp: WP,
    timeoutMs: 600000,
    async run(app, assert, ctx) {
      if (skipped('IN3', app, ['trend', 'review', 'skin'])) return;
      const R = app.win.WTS_buildup.review;
      for (const kind of ['oil', 'gas']) {
        const a = app.toWin((await demo(ctx, kind)).analysis);
        const idx = R.evidence(a), rv = R.run(a, idx);
        assert.ok(rv.evidenceCheck && rv.evidenceCheck.ok, kind + ': evidence check ok (' + JSON.stringify(rv.evidenceCheck) + ')');
        // Array.from: the findings live in the app realm, and a cross-realm array never deep-equals [] here
        const bad = Array.from(rv.findings).filter((f) => f.rule === 'V14' || /^V2[3-7]$/.test(f.rule)).map((f) => f.rule + ' ' + f.id);
        assert.deepStrictEqual(bad, [], kind + ': no V14 and no V23–V27 findings');
        const rm = R.report(a, rv, [], null, P(app).fmt);
        const chk = R.check(rm, a, idx);
        assert.ok(chk.ok, kind + ': report evidence check (' + chk.nFailed + ' failed: ' + JSON.stringify(chk.failures.slice(0, 2)) + ')');
      }
    },
  },
  {
    name: 'IN4 integration comparison page: the latest skin row after the real oil-demo run',
    wp: WP,
    timeoutMs: 600000,
    async run(app, assert, ctx) {
      if (skipped('IN4', app, ['trend', 'review', 'skin'])) return;
      const r = await demo(ctx, 'oil');
      Object.keys(r.storage).forEach((k) => { if (r.storage[k] != null) app.storage.setItem(k, r.storage[k]); });
      app.hook.nav('buildup'); app.flush(20);
      for (let i = 0; i < 20; i++) await app.flushAsync(1);
      const S = app.win.WTS_state.buildup.latest.S;
      const t = app.win.WTS_wells.table(), row = t.rows.findIndex((x) => x.key === 'buS'), col = t.wells.findIndex((w) => w.active);
      assert.ok(row !== -1, 'latest-skin row on the comparison page');
      assert.strictEqual(t.cells[row][col], Number(S).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 }));
      assert.strictEqual(S, r.pub.latest.S, 'same latest S as the run');
    },
  },
  {
    name: 'IN5 integration report limits on the real oil and gas analyses: notes ≤ 600, verdicts < 300, tables ≤ 30 rows, no "null" / "undefined" text',
    wp: WP,
    timeoutMs: 600000,
    async run(app, assert, ctx) {
      if (skipped('IN5', app, ['trend', 'review', 'skin'])) return;
      for (const kind of ['oil', 'gas']) {
        const r = await demo(ctx, kind);
        const a2 = ctx.loadApp({});
        try {
          Object.keys(r.storage).forEach((k) => { if (r.storage[k] != null) a2.storage.setItem(k, r.storage[k]); });
          a2.hook.nav('buildup'); a2.flush(20);
          for (let i = 0; i < 30; i++) await a2.flushAsync(1);
          assert.strictEqual(a2.el('bu_res').getAttribute('data-done'), '1', kind + ': results rendered');
          const ids = a2.findAll('#bu_res .rbox[data-sec]').map((e) => e.getAttribute('data-sec'));
          for (let i = 1; i <= 12; i++) assert.ok(ids.indexOf('S' + i) !== -1, kind + ': section S' + i);
          const m = a2.win.collectPageReport(a2.el('pgBody'), { charts: false });
          m.results.forEach((s) => s.items.forEach((it) => {
            if (it.type === 'note' && it.verdict) assert.ok(it.text.length < 300, kind + ' verdict < 300: ' + it.text.slice(0, 80));
            if (it.type === 'note' && !it.verdict) assert.ok(it.text.length <= 600, kind + ' note ≤ 600: ' + it.text.slice(0, 80));
            if (it.type === 'table') assert.ok(it.rows.length <= 31, kind + ' table ≤ 30 rows (+1 "older tests" row): ' + it.rows.length);
          }));
          const all = txt(a2.el('bu_res'));
          assert.ok(!BAD_TXT.test(all), kind + ': no null / undefined text: ' + (all.match(BAD_TXT) || [])[0]);
        } finally { a2.dispose(); }
      }
    },
  },
  {
    name: 'IN6 integration sliced end-to-end oil-demo run: zero pending timers afterwards; the stats counters follow the §4.8 slicing rule',
    wp: WP,
    timeoutMs: 600000,
    async run(app, assert, ctx) {
      if (skipped('IN6', app, ['trend', 'review', 'skin'])) return;
      const r = await demo(ctx, 'oil');
      assert.strictEqual(r.pending, 0, 'no timers after the sliced run');
      const s = r.stats || {}, as = r.analysis.stats || {};
      const ev = typeof s.evals === 'number' ? s.evals : as.evals, sl = typeof s.slices === 'number' ? s.slices : as.slices;
      assert.ok(ev > 0 && sl > 0, 'counters recorded: ' + JSON.stringify(s) + ' / ' + JSON.stringify(as));
      assert.ok(sl >= Math.ceil(ev / 24), 'at most 24 evaluations per slice: ' + ev + ' evaluations in ' + sl + ' slices');
      assert.ok(sl <= ev, 'at least one evaluation per slice');
      if (typeof s.fits === 'number' && typeof s.lmIters === 'number') assert.ok(s.lmIters <= 40 * Math.max(1, s.fits), 'LM iterations within maxIterTotal per fit');
    },
  },
  {
    name: 'IN7 integration history before the data: a gas well with 1 MMscf produced before the data at 1,000 Mscf/d gets 24 h prepended (the page\'s AnalysisInput through WTS_buildup.data.rates)',
    wp: WP,
    run(app, assert) {
      const D = app.win.WTS_buildup && app.win.WTS_buildup.data;
      if (!D || typeof D.rates !== 'function') { console.log('[skip] IN7 — needs WTS_buildup.data.rates (WP2, 49-calc-buildup-data.js).'); return; }
      app.hook.nav('buildup'); app.flush(20);
      app.select('bu_fluid', 'gas');
      app.select('bu_hist_mode', 'cum');
      app.input('bu_hist_cumg', '1');
      const inp = P(app).gather().input;
      assert.strictEqual(inp.history.cum, 1000, 'cumulative in Mscf');
      const rows = [];
      for (let d = 1; d <= 5; d++) rows.push({ date: '2026-03-0' + d, oil: 0, gas: 1000, water: 0, hours: 24 });
      const rh = D.rates(null, [], app.toWin(rows), app.toWin({ fluid: 'gas', history: inp.history, day: { zone: { mode: 'utc' }, startHour: 0 }, gas: inp.well.gas, resolution: { oil: 1, gas: 1, water: 1 } }));
      assert.ok(rh && rh.start, 'rate history built: ' + JSON.stringify(rh && rh.errors));
      assert.strictEqual(rh.start.source, 'cum');
      assert.ok(Math.abs(rh.start.prepend_h - 24) < 1e-6, '24 h prepended: ' + rh.start.prepend_h);
    },
  },
];
