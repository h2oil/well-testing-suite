// Well Dynamics WD3 — recorder, replay files and cases (docs/WELL-DYNAMICS-PLAN.md §3.4, §3.7, §3.8, §5.4, §7; RC1–RC16).
//
// The engine (WD1) is not merged on this lane: the recorder is driven by the WD3 stand-in engine (tests/_wd3-mock.js), which has the
// §3.1 / §3.2 / §3.6 contract shapes and is bit-identical on repeat. Truncate / continue with the real engine is PG25+ (integration).
//
// RC1  sampling cadence (every_s), the first sample on attach, no duplicate times
// RC2  event and state-change samples; the applied event log
// RC3  at(t): linear between samples, step channels (bean, open, state, opValve) hold
// RC4  snapshots every snapEvery_s, snapAt(t), frameAt(t) display arrays
// RC5  the cap rule: every second snapshot older than the last hour goes; series are never dropped
// RC6  truncate + restore = an uninterrupted run (bit-identical on the same engine)
// RC7  marks: add / list / remove, ordered, clipped by truncate
// RC8  CSV: chosen columns, field-unit headers, h:mm:ss, state names, from / to / every
// RC9  CSV in Metric: values and headers through the units layer
// RC10 CSV: decimal comma (';' separator), escaping of labels (quotes, formula prefixes)
// RC11 replay file round trip: series identical, marks, events, settings, hash, engineId
// RC12 fromFile errors: FORMAT (malformed / wrong format / bad times), VERSION, TOO_BIG
// RC13 snapshots thinned above the file limit (first / last / events / marks / state changes kept, interval doubled, note); dropped (snaps
//      null + note, NO_SNAPSHOTS) only when the kept set does not fit
// RC14 replay re-run: same engine → identical; a different engineId → within tolerance with an info note; a changed recording → "differs after"
// RC15 the state column indexes STATE_ORDER; summarize() fields (§3.8)
// RC16 cases: save / list / remove / caps (20 cases, 24 kB, oldest unnamed first); the dyn key per well and in the project payload;
//      a record without dyn reads as before
'use strict';

const { installWellDynMock } = require('./_wd3-mock');

const WP = 'WD3';
let _shared = null;
function app0(ctx) {
  const key = ctx.mode;
  if (_shared && _shared.key === key) return _shared.app;
  if (_shared && _shared.app && _shared.app.dispose) { try { _shared.app.dispose(); } catch (_) { /* ignore */ } }
  const app = ctx.loadApp({});
  installWellDynMock(app.win);
  _shared = { key, app, ref: null };
  return app;
}
function loadWell(app, k) {
  const ex = app.win.WTS_wellperf_page.examples()[k || 'oil'];
  app.storage.removeItem('wts_wellperf_model');
  app.win.WTS_wp_model.write(JSON.parse(JSON.stringify(ex.tables)));
  app.storage.setItem('wts_page_wellperf', JSON.stringify({ f: ex.scalars }));
  return app.win.WTS_wp_model.read();
}
function sim(app, o) {
  const M = loadWell(app, (o && o.well) || 'oil');
  const opts = Object.assign({ cells: 40 }, o && o.opts);
  if (_shared.ref && (!o || !o.noRef)) opts.ref = _shared.ref;
  const s = app.win.WTS_wd_engine.create(M, app.toWin(opts));
  if (s && s.ok !== false && !_shared.ref) _shared.ref = s.ref;
  return s;
}
const R = (app) => app.win.WTS_wd_rec;
const plain = (x) => JSON.parse(JSON.stringify(x));
const arr = (a) => Array.prototype.slice.call(a);

module.exports = [
  {
    name: 'RC1 sampling cadence: a first sample on attach, then one per every_s of simulated time; times ascending and unique',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx);
      const s = sim(app), rec = R(app).create({ every_s: 10 });
      assert.ok(rec.attach(s), 'attached');
      assert.strictEqual(rec.count(), 1, 'first sample at attach');
      s.run(600);
      const T = arr(rec.times());
      assert.ok(T.length >= 60 && T.length <= 62, 'about 61 samples in 600 s at 10 s: ' + T.length);
      for (let i = 1; i < T.length; i++) assert.ok(T[i] > T[i - 1], 'ascending');
      T.slice(1).forEach((t) => assert.ok(t % 10 < 5 + 1e-9 || t % 10 > 9.999, 'on the 10 s grid (the mock steps 10 s): ' + t));
      assert.strictEqual(rec.series('t').length, T.length);
      assert.deepStrictEqual(rec.channels().map((c) => c.key), plain(app.win.WTS_wd_engine.CHANNELS), 'channels = the frozen CHANNELS order');
      rec.detach();
    },
  },
  {
    name: 'RC2 an applied event and a state change force a sample; events() is the applied log with the source',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx);
      const s = sim(app), rec = R(app).create({ every_s: 5000 });
      rec.attach(s);
      s.schedule(app.toWin([{ t: 125, type: 'bean', args: { bean64: 24 }, src: 'scenario' }]));
      s.run(700);
      const T = arr(rec.times());
      assert.ok(T.indexOf(125) !== -1, 'a sample at the event time: ' + T.join(','));
      const ev = rec.events();
      assert.strictEqual(ev.length, 1);
      assert.strictEqual(ev[0].type, 'bean'); assert.strictEqual(ev[0].src, 'scenario'); assert.strictEqual(ev[0].t, 125);
      assert.ok(T.indexOf(605) !== -1 || T.indexOf(600) !== -1, 'a state-change sample (start-up → stable after 600 s): ' + T.join(','));
      assert.ok(T.length <= 4, 'nothing else sampled at every_s 5000: ' + T.length);
      rec.detach();
    },
  },
  {
    name: 'RC3 at(t) interpolates continuous channels linearly and holds step channels (bean, open, state, opValve)',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx);
      const s = sim(app), rec = R(app).create({ every_s: 10 });
      rec.attach(s);
      s.schedule(app.toWin([{ t: 300, type: 'bean', args: { bean64: 20 } }]));
      s.run(900);
      const T = arr(rec.times()), q = arr(rec.series('qL')), i = T.findIndex((t) => t > 400);
      const tm = (T[i] + T[i + 1]) / 2, v = rec.at(tm).values;
      assert.near(v.qL, (q[i] + q[i + 1]) / 2, 1e-9, 'linear');
      const ib = T.indexOf(300), b = arr(rec.series('bean'));
      assert.ok(ib > 0 && b[ib - 1] === 32 && b[ib] === 20, 'bean change sampled');
      assert.strictEqual(rec.at((T[ib - 1] + T[ib]) / 2).values.bean, 32, 'bean holds the earlier sample');
      assert.strictEqual(rec.at(T[ib]).values.bean, 20);
      assert.strictEqual(rec.at(-5).values.qL, q[0], 'before the start → first sample');
      assert.strictEqual(rec.at(1e9).values.qL, q[q.length - 1], 'after the end → last');
      rec.detach();
    },
  },
  {
    name: 'RC4 snapshots every snapEvery_s (wd-snap, JSON-safe); snapAt(t) = the latest at or before t; frameAt(t) = its display arrays',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx);
      const s = sim(app), rec = R(app).create({ every_s: 10, snapEvery_s: 60 });
      rec.attach(s);
      s.run(600);
      const sn = rec.snaps();
      assert.ok(sn.length >= 10 && sn.length <= 12, 'about 11 snapshots: ' + sn.length);
      sn.forEach((x) => { assert.strictEqual(x.kind, 'wd-snap'); assert.strictEqual(JSON.stringify(JSON.parse(JSON.stringify(x))), JSON.stringify(x)); });
      const a = rec.snapAt(185);
      assert.ok(a && a.t <= 185 && a.t >= 120, 'snapAt(185) = ' + (a && a.t));
      assert.strictEqual(rec.snapAt(-1), null);
      const f = rec.frameAt(185);
      assert.ok(f && f.t === a.t && f.cells && f.cells.p.length === s.grid.n && f.cells.regime.length === s.grid.n, 'display arrays per cell');
      ['ag', 'ao', 'aw', 'vg', 'vl'].forEach((k) => assert.ok(Array.isArray(f.cells[k]), k));
      rec.detach();
    },
  },
  {
    name: 'RC5 the cap rule: above capMB every second snapshot older than the last hour goes (repeatable); the series are never dropped',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx);
      const s = sim(app), rec = R(app).create({ every_s: 30, snapEvery_s: 60, capMB: 0.25 });
      rec.attach(s);
      s.run(4 * 3600);
      const sn = rec.snaps(), tEnd = rec.span()[1];
      assert.ok(rec.count() >= 4 * 120, 'series kept: ' + rec.count());
      assert.ok(sn.length < 4 * 60, 'snapshots thinned: ' + sn.length);
      const recent = sn.filter((x) => x.t >= tEnd - 3600);
      assert.ok(recent.length >= 55, 'the last hour is kept at the full cadence: ' + recent.length);
      assert.ok(rec.bytes() <= 0.25 * 1048576 * 1.2 || sn.filter((x) => x.t < tEnd - 3600).length <= 2, 'within the cap (or nothing older left to thin)');
      rec.detach();
    },
  },
  {
    name: 'RC6 truncate + restore from a snapshot, then run on = an uninterrupted run, bit for bit (same engine)',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx);
      const ev = [{ t: 900, type: 'bean', args: { bean64: 24 } }, { t: 2400, type: 'shutin', args: {} }];
      const a = sim(app, { opts: { events: ev } }), ra = R(app).create({ every_s: 10, snapEvery_s: 60 });
      ra.attach(a); a.run(3600);
      const b = sim(app, { opts: { events: ev } }), rb = R(app).create({ every_s: 10, snapEvery_s: 60 });
      rb.attach(b); b.run(3600);
      const sn = rb.snapAt(1500);
      rb.truncate(sn.t);
      assert.ok(rb.span()[1] <= sn.t + 1e-9, 'truncated');
      assert.ok(rb.events().every((e) => e.t <= sn.t), 'later events dropped from the log');
      assert.ok(b.restore(sn).ok, 'restored');
      rb.attach(b);
      b.run(3600 - b.state.t);
      ['t', 'qL', 'thp', 'pwf', 'state', 'liq'].forEach((k) => assert.deepStrictEqual(arr(rb.series(k)), arr(ra.series(k)), k + ' bit-identical'));
      const bad = b.restore(Object.assign({}, sn, { mHash: 'x' }));
      assert.strictEqual(bad.code, 'MODEL_MISMATCH');
      ra.detach(); rb.detach();
    },
  },
  {
    name: 'RC7 marks: mark / marks / unmark, ordered by start, reversed bounds swapped, labels cleaned, clipped by truncate',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx);
      const rec = R(app).create({});
      const a = rec.mark(500, 900, 'B'), b = rec.mark(300, 100, 'A\u0007x');
      const m = rec.marks();
      assert.deepStrictEqual(plain(m.map((x) => x.label)), ['A x', 'B']);
      assert.deepStrictEqual(plain([m[0].t0, m[0].t1]), [100, 300]);
      assert.ok(rec.unmark(b) && !rec.unmark('zz'));
      rec.truncate(700);
      assert.deepStrictEqual(plain(rec.marks().map((x) => [x.id, x.t0, x.t1])), [[a, 500, 700]]);
      rec.truncate(400);
      assert.strictEqual(rec.marks().length, 0);
    },
  },
  {
    name: 'RC8 CSV: chosen columns in field units with labelled headers, h:mm:ss, state names, from / to and every_s; marks listed',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx);
      const s = sim(app), rec = R(app).create({ every_s: 10 });
      rec.attach(s); s.run(1800);
      rec.mark(600, 900, 'Window 1');
      const csv = rec.csv(app.toWin({ cols: ['thp', 'pwf', 'qL', 'state'], from: 300, to: 1200, every_s: 60, hms: true, stateNames: true }));
      const L = csv.trim().split('\r\n');
      assert.strictEqual(L[0], 'Time (s),THP (psig),BHP (psia),Liquid rate (STB/d),Well state,Time (h:mm:ss)');   // names in the cells: no index unit (review fix)
      const csvIx = rec.csv(app.toWin({ cols: ['state'], from: 300, to: 300 }));
      assert.ok(/Well state \(index\) \(-\)/.test(csvIx.split('\r\n')[0]), 'without stateNames the index header stays');
      const rows = L.slice(1, L.indexOf(''));
      assert.ok(rows.length >= 15 && rows.length <= 16, 'rows every 60 s in [300, 1200]: ' + rows.length);
      assert.strictEqual(rows[0].split(',')[0], '300');
      assert.ok(rows.every((r) => +r.split(',')[0] >= 300 && +r.split(',')[0] <= 1200));
      assert.ok(/^(startup|stable)$/.test(rows[0].split(',')[4]), 'state as its name: ' + rows[0]);
      assert.strictEqual(rows[0].split(',')[5], '0:05:00');
      assert.ok(csv.indexOf('Window 1,600,900') !== -1, 'marks listed');
      const all = rec.csv(app.toWin({})).split('\r\n')[0].split(',');
      assert.strictEqual(all.length, app.win.WTS_wd_engine.CHANNELS.length, 'all channels by default');
      rec.detach();
    },
  },
  {
    name: 'RC9 CSV in Metric: pressures, rates and volumes converted through the units layer; headers carry the metric labels',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx);
      const s = sim(app), rec = R(app).create({ every_s: 10 });
      rec.attach(s); s.run(120);
      const U = app.win.WTS_units;
      const f = rec.csv(app.toWin({ cols: ['thp', 'pwf', 'qL', 'liq'] })).split('\r\n'), m = rec.csv(app.toWin({ cols: ['thp', 'pwf', 'qL', 'liq'], system: 'metric' })).split('\r\n');
      const hf = f[0].split(','), hm = m[0].split(',');
      assert.ok(hm[1].indexOf(U.CATEGORIES.pressureG.metric.label) !== -1 && hm[3].indexOf(U.CATEGORIES.liquidRate.metric.label) !== -1, 'metric headers: ' + m[0]);
      assert.notStrictEqual(hf[1], hm[1]);
      const vf = f[1].split(',').map(Number), vm = m[1].split(',').map(Number);
      assert.rel(vm[1], U.convertCategory(vf[1], 'pressureG', 'imperial', 'metric'), 1e-3, 'THP converted');
      assert.rel(vm[2], U.convertCategory(vf[2], 'pressure', 'imperial', 'metric'), 1e-3, 'BHP converted');
      assert.rel(vm[3], U.convertCategory(vf[3], 'liquidRate', 'imperial', 'metric'), 1e-3, 'rate converted');
      assert.strictEqual(vm[0], vf[0], 'time stays in s');
      rec.detach();
    },
  },
  {
    name: 'RC10 CSV with a decimal comma uses ";" and "," decimals; labels are quoted and never start a formula',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx);
      const s = sim(app), rec = R(app).create({ every_s: 10 });
      rec.attach(s); s.run(60);
      rec.mark(0, 30, '=HYPERLINK("x");a');
      const c = rec.csv(app.toWin({ cols: ['thp'], decimalComma: true, title: 'Well; "A"' }));
      const L = c.split('\r\n');
      assert.strictEqual(L[0], '"# Well; ""A"""');
      assert.strictEqual(L[1], 'Time (s);THP (psig)');
      assert.ok(/^\d+;\d+,\d$/.test(L[2]), 'decimal comma: ' + L[2]);
      const ml = L.filter((x) => x.indexOf('HYPERLINK') !== -1)[0];
      assert.ok(ml && ml.indexOf('"\'=HYPERLINK(""x"");a"') === 0, 'escaped and defused: ' + ml);
      rec.detach();
    },
  },
  {
    name: 'RC11 replay file round trip: series identical, marks, events, settings, model, hash and engineId; JSON-safe (NaN → null)',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx);
      const s = sim(app, { opts: { events: [{ t: 300, type: 'bean', args: { bean64: 24 } }] } }), rec = R(app).create({ every_s: 10, snapEvery_s: 60 });
      rec.attach(s); s.run(1200); rec.mark(100, 400, 'Bean-up');
      const run = rec.toFile(app.toWin({ model: { scalars: { wp_pr: 3000 }, tables: { survey: [[0, 0, 0], [8000, 0, 0]] } }, settings: { cells: 40, ref: { big: 1 }, snapshot: {} }, well: { name: 'W-1 <b>' }, summary: { a: 1 } }));
      assert.strictEqual(run.format, 'wts-welldyn-run'); assert.strictEqual(run.v, 1);
      assert.ok(!('ref' in run.settings) && !('snapshot' in run.settings), 'ref / snapshot never in a file');
      assert.strictEqual(run.engineId, R(app).engineId());
      assert.ok(/^[0-9a-f]{16}$/.test(run.hash), 'hash16');
      const txt = JSON.stringify(run);
      assert.ok(txt.indexOf('NaN') === -1, 'NaN written as null');
      const o = R(app).fromFile(txt);
      assert.ok(o.ok, 'opened: ' + JSON.stringify(o.errors));
      assert.deepStrictEqual(plain(o.warnings.filter((w) => w.sev === 'warn')), [], 'no warnings');
      ['t', 'qL', 'thp', 'pwf', 'bean', 'state'].forEach((k) => assert.deepStrictEqual(arr(o.rec.series(k)), arr(rec.series(k)), k));
      assert.deepStrictEqual(plain(o.rec.marks().map((m) => [m.t0, m.t1, m.label])), [[100, 400, 'Bean-up']]);
      assert.deepStrictEqual(plain(o.run.events), plain(rec.events()));
      assert.strictEqual(o.run.well.name, 'W-1 <b>', 'kept as text (escaped on display)');
      assert.strictEqual(o.rec.snaps().length, rec.snaps().length, 'snapshots carried');
      assert.ok(o.rec.frameAt(500), 'display frames carried');
      const t2 = JSON.parse(txt); t2.settings.cells = 99;
      assert.ok(R(app).fromFile(JSON.stringify(t2)).warnings.some((w) => w.code === 'HASH'), 'a changed file is flagged (not refused)');
      rec.detach();
    },
  },
  {
    name: 'RC12 fromFile refuses only a malformed file, another format, another version or a file too big (FORMAT / VERSION / TOO_BIG)',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx);
      const F = (x) => R(app).fromFile(x);
      assert.strictEqual(F('{not json').code, 'FORMAT');
      assert.strictEqual(F('{"format":"h2oilproj"}').code, 'FORMAT');
      assert.strictEqual(F(app.toWin({ format: 'wts-welldyn-run', v: 2, rec: { t: [], ch: {} } })).code, 'VERSION');
      assert.strictEqual(F(app.toWin({ format: 'wts-welldyn-run', v: 1 })).code, 'FORMAT', 'no series');
      assert.strictEqual(F(app.toWin({ format: 'wts-welldyn-run', v: 1, rec: { t: [0, 20, 10], ch: {} } })).code, 'FORMAT', 'times not ascending');
      const big = 'x'.repeat(R(app).MAX_OPEN + 1);
      assert.strictEqual(F(big).code, 'TOO_BIG');
      const ok = F(app.toWin({ format: 'wts-welldyn-run', v: 1, rec: { t: [0, 10], ch: { thp: [1, 2], zzz: [1, 2] } } }));
      assert.ok(ok.ok && ok.warnings.some((w) => w.code === 'UNKNOWN_CHANNEL') && ok.warnings.some((w) => w.code === 'NO_SNAPSHOTS'), 'unknown channel skipped with a note');
    },
  },
  {
    name: 'RC13 a replay file above the size limit thins its snapshots (first, last, events, marks, state changes kept; interval doubled, note) and still continues; only a kept set that does not fit drops them (snaps null, NO_SNAPSHOTS)',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx);
      const s = sim(app), rec = R(app).create({ every_s: 10, snapEvery_s: 60 });
      rec.attach(s); s.run(6 * 3600);                                           // a 6 h run (review fix: long runs kept their snapshots)
      rec.mark(7200, 7500, 'W');
      const full = rec.toFile(app.toWin({})), F = JSON.stringify(full).length, nFull = full.snaps.list.length;
      assert.ok(full.snaps && nFull > 20 && F <= R(app).MAX_FILE, 'default limit 5 MB: snapshots kept (' + nFull + ', ' + F + ' B)');
      const base = JSON.stringify(Object.assign({}, full, { snaps: { every_s: 60, list: [], frames: [] } })).length;
      // thinned: a limit between the series alone and the full file
      const lim = Math.round(base + 0.3 * (F - base));
      const run = rec.toFile(app.toWin({ maxBytes: lim }));
      assert.ok(run.snaps && run.snaps.list.length >= 3 && run.snaps.list.length < nFull, 'thinned, not dropped: ' + (run.snaps && run.snaps.list.length));
      assert.ok(JSON.stringify(run).length <= lim, 'fits the limit');
      assert.ok(run.snaps.every_s >= 2 * full.snaps.every_s, 'interval doubled: ' + run.snaps.every_s);
      assert.ok(run.notes && /thinned to every \d+ s/.test(run.notes[0]), run.notes && run.notes[0]);
      const L = run.snaps.list;
      assert.strictEqual(L[0].t, full.snaps.list[0].t, 'first kept'); assert.strictEqual(L[L.length - 1].t, full.snaps.list[nFull - 1].t, 'last kept');
      const atMark = full.snaps.list.filter((x) => x.t <= 7200 + 1e-9).pop();
      assert.ok(L.some((x) => x.t === atMark.t), 'the snapshot at (or just before) the mark start kept: ' + atMark.t);
      assert.strictEqual(run.snaps.frames.length, L.length, 'frames thinned with the snapshots');
      const o = R(app).fromFile(JSON.stringify(run));
      assert.ok(o.ok && o.rec.snaps().length === L.length, 'reopened with its snapshots');
      assert.ok(o.rec.snapAt(4 * 3600 + 30) !== null, 'snapAt works (Continue from here)');
      assert.ok(!o.warnings.some((w) => w.code === 'NO_SNAPSHOTS'));
      // dropped only when even the kept set does not fit
      const run2 = rec.toFile(app.toWin({ maxBytes: base + 10 }));
      assert.strictEqual(run2.snaps, null, 'snapshots dropped');
      assert.ok(run2.notes && /snapshots dropped/.test(run2.notes[0]));
      const o2 = R(app).fromFile(JSON.stringify(run2));
      assert.ok(o2.ok && o2.rec.snaps().length === 0 && o2.rec.snapAt(900) === null);
      assert.ok(o2.warnings.some((w) => w.code === 'NO_SNAPSHOTS'));
      rec.detach();
    },
  },
  {
    name: 'RC14 replay re-run through the page: same engine → identical; another engineId → info note within tolerance (never "corrupt"); a changed recording → "differs after"',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx);
      loadWell(app, 'oil');
      app.hook.nav('welldyn'); app.flush(30);
      const P = app.win.WTS_welldyn_page;
      P.build();
      P.play(); let ts = 0; for (let i = 0; i < 60; i++) { ts += 50; P.frame(ts); } P.pause();
      const run = plain(P.runFile());
      let o = P.load(JSON.stringify(run));
      assert.ok(o.ok, 'loaded');
      let r = P.rerun();
      assert.ok(r.ok && r.cmp.identical && r.sameEngine, 'identical');
      assert.match(r.msg, /identical to the recording/);
      const other = Object.assign({}, run, { engineId: 'feedfacefeedface' });
      P.load(JSON.stringify(other));
      r = P.rerun();
      assert.ok(r.ok && !r.sameEngine && r.cmp.ok, 'within tolerance');
      assert.match(r.msg, /different JavaScript engine/);
      const bent = plain(run); bent.engineId = 'feedfacefeedface';
      bent.rec.ch.thp = bent.rec.ch.thp.map((v, i) => (i > 6 ? v + 5 : v));
      P.load(JSON.stringify(bent));
      r = P.rerun();
      assert.ok(r.ok && !r.cmp.ok, 'differs');
      assert.match(r.msg, /differs from the recording after \d+:\d\d:\d\d/);
      [run, other, bent].forEach(() => assert.ok(!/corrupt/i.test(app.el('wd_banner').textContent), 'never "corrupt"'));
      assert.match(app.el('wd_banner').textContent, /different JavaScript engine/, 'shown as an info note');
      app.hook.nav('home'); app.flush(30);
    },
  },
  {
    name: 'RC15 the state channel indexes STATE_ORDER; summarize() carries the §3.8 fields (states, cumulatives, build-up, engineId)',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx);
      const s = sim(app, { opts: { events: [{ t: 1800, type: 'shutin', args: {} }] } }), rec = R(app).create({ every_s: 10 });
      rec.attach(s); s.run(5400);
      const so = app.win.WTS_wd_engine.STATE_ORDER, st = arr(rec.series('state'));
      assert.ok(st.every((x) => Number.isInteger(x) && x >= 0 && x < so.length), 'indices');
      assert.strictEqual(so[st[st.length - 1]], 'shutin');
      const sum = R(app).summarize(rec, s);
      ['duration_s', 'endState', 'states', 'qo', 'qw', 'qg', 'qgForm', 'gorForm', 'prior', 'thp_psig', 'pwf', 'qMax', 'qMin', 'thpMax_psig', 'pwfMax', 'liqMax_bbl',
        'tLoading_h', 'tDead_h', 'cumO_STB', 'cumW_STB', 'cumG_MMscf', 'buildup', 'gate', 'provisional', 'massErr', 'engineId'].forEach((k) => assert.ok(k in sum, k));
      assert.strictEqual(sum.endState, 'shutin');
      assert.deepStrictEqual(plain(sum.states.map((x) => x.key)), ['startup', 'stable', 'shutin']);
      assert.ok(sum.cumO_STB > 0 && sum.cumO_STB < 640 * 1800 / 86400 * 1.05, 'cumulative oil ≈ q·t: ' + sum.cumO_STB);
      assert.ok(sum.buildup && Number.isFinite(sum.buildup.pws_end), 'build-up read at the end of a shut-in');
      assert.ok(sum.states.length <= 50);
      rec.detach();
    },
  },
  {
    name: 'RC16 cases: save / list / remove; ≤ 20 cases and ≤ 24 kB (oldest unnamed first); per well and in the project payload; a record without dyn reads as before',
    wp: WP,
    run(app, assert, ctx) {
      app = app0(ctx);
      const W = app.win.WTS_wp_model, C = app.win.WTS_wd_cases;
      const M0 = loadWell(app, 'oil');
      assert.ok(!('dyn' in M0), 'no dyn in a record without it');
      const before = JSON.stringify(Object.assign({}, plain(M0), { meta: null }));
      let r = C.save(app.toWin(C.make(app.toWin({ name: 'Base', settings: { a: 1 }, events: [], duration_s: 3600 }))));
      assert.ok(r.ok && r.keys.join() === 'dyn', 'written through WTS_wp_model.write (dyn only)');
      const M1 = W.read();
      assert.strictEqual(M1.dyn.cases.length, 1); assert.strictEqual(M1.dyn.cases[0].name, 'Base');
      assert.strictEqual(JSON.stringify(Object.assign({}, plain(M1), { meta: null, dyn: undefined })), before, 'the rest of the model unchanged');
      // a case with the same name replaces it
      r = C.save(app.toWin(C.make(app.toWin({ name: 'base', settings: { a: 2 } }))));
      assert.ok(r.replaced && C.list().length === 1 && C.list()[0].settings.a === 2);
      // the caps: 25 more (some unnamed) → 20 kept, the oldest unnamed went first
      for (let i = 0; i < 25; i++) C.save(app.toWin(C.make(app.toWin({ name: i % 2 ? 'N' + i : '', settings: { i } }))));
      const L = C.list();
      assert.strictEqual(L.length, 20, '20 cases');
      assert.ok(L.some((c) => c.name === 'base'), 'the named old case survives while unnamed ones go first');
      const big = 'x'.repeat(1500);
      for (let i = 0; i < 20; i++) C.save(app.toWin(C.make(app.toWin({ name: 'Big' + i, note: big, settings: { pad: big.repeat(1) } }))));
      assert.ok(JSON.stringify(W.read().dyn).length <= 24000, 'within 24 kB');
      const id = C.list()[0].id;
      assert.ok(C.remove(id).ok && !C.list().some((c) => c.id === id), 'removed');
      assert.strictEqual(C.remove('nope').code, 'NOT_FOUND');
      // the project payload carries the dyn key (wts_wellperf_model is a project key)
      const pay = app.win.WTS_project._buildPayload({});
      assert.ok(JSON.stringify(pay).indexOf('"dyn"') !== -1 || JSON.stringify(pay).indexOf('\\"dyn\\"') !== -1, 'dyn in the project payload');
      // toScenario
      const sc = C.toScenario(C.list()[0]);
      assert.ok(sc && 'settings' in sc && Array.isArray(sc.events) && Number.isFinite(sc.duration_s));
      // per well: the dyn key lives in the per-well model record (a fresh record has none)
      app.storage.removeItem('wts_wellperf_model');
      assert.deepStrictEqual(plain(C.list()), [], 'another well (no record) has no cases');
      assert.ok(W.TABLE_KEYS.indexOf('dyn') !== -1 && !('dyn' in W.empty()), 'additive table key; empty() unchanged');
    },
  },
];
