// Build-up Surveillance — WTS_buildup.store (49-calc-buildup-store.js), plan §3.11, §3.12, §6.8, §9 WP6 ST1–ST6.
//
// IndexedDB comes from tests/_buildup-idb-fake.js (the harness has none). ST6 needs PRiSM_autoInterp.drive (WP1);
// when it is missing, an explicit stub with the §4.8 driver semantics is installed in the app (reported in the
// test name only through this header: "drive stub when WP1 is not merged").
'use strict';

const { createFakeIDB } = require('./_buildup-idb-fake');
const { FIX, checkShape } = require('./_buildup-shapes');

const WP = 'WP6';
const DB = 'wts_buildup';

// §4.8 driver, installed only when 53 has no drive yet (WP1 not merged). Evaluated in the app realm so it uses
// the harness's virtual timers.
function DRIVE_STUB(W) {
  var AI = W.PRiSM_autoInterp = W.PRiSM_autoInterp || {};
  if (typeof AI.drive === 'function') return false;
  AI.drive = function (job, opts) {
    opts = opts || {};
    return new Promise(function (res, rej) {
      function tick() {
        var s;
        try { s = job.step(); } catch (e) { rej(e); return; }
        if (opts.onProgress) try { opts.onProgress(s.progress, s.label); } catch (e) { /* cosmetic */ }
        if (s.done) { res(job.result()); return; }
        setTimeout(function () {
          if (opts.shouldCancel && opts.shouldCancel()) { try { job.cancel(); } catch (e) { /* ignore */ } rej({ code: 'CANCELLED' }); return; }
          tick();
        }, 0);
      }
      tick();
    });
  };
  return true;
}
function installDrive(app) { return app.evalInApp('(' + DRIVE_STUB.toString() + ')(window)'); }

// A GaugeRecord copy in the app realm (plain arrays).
function record(app, over) {
  const r = FIX.samples.GaugeRecord;
  return app.toWin(Object.assign(r, over || {}));
}
function synthRecord(n, hash) {
  const t = new Array(n), p = new Array(n);
  for (let i = 0; i < n; i++) { t[i] = 1772323200000 + i * 10000; p[i] = Number((2500 + 40 * Math.sin(i / 997) + (i % 7) * 0.001).toFixed(3)); }
  return { ok: true, origin_ms: t[0], t, p, T: null, n, source: 'csv', name: 'synthetic.csv', zone: { mode: 'utc' }, pUnitIn: 'psia', patm: 14.696, elapsed: false, rollup: false, hash: hash || '0123456789abcdef', warnings: [] };
}
const plain = (rec) => Object.assign({}, rec, { t: Array.from(rec.t), p: Array.from(rec.p), T: rec.T ? Array.from(rec.T) : null });

async function settle(app, n) { for (let i = 0; i < (n || 4); i++) await app.flushAsync(0); }

module.exports = [
  {
    name: 'ST1 store: putRaw/getRaw and putTests/getTests round trips through IndexedDB; a failed open falls back to memory',
    wp: WP,
    async run(app, assert, ctx) {
      const idb = createFakeIDB();
      app.win.indexedDB = idb.indexedDB;
      const S = app.win.WTS_buildup.store;
      assert.ok(S && typeof S.init === 'function', 'WTS_buildup.store loaded');
      const eng = await S.init();
      assert.strictEqual(eng.engine, 'idb');
      const rec = record(app);
      await S.putRaw('w1', rec);
      assert.deepStrictEqual(idb.keys(DB, 'raw'), ['w1'], 'raw record stored under the well id');
      const enc = idb.get(DB, 'raw', 'w1');
      assert.ok(typeof enc.tB64 === 'string' && typeof enc.pB64 === 'string' && enc.n === rec.n, 'encoded form {tB64, pB64, n}');
      S._reset();                                     // cold mirror: the next read comes from IndexedDB
      app.win.indexedDB = idb.indexedDB;
      const back = await S.getRaw('w1');
      assert.ok(back, 'raw record read back');
      assert.strictEqual(back.n, rec.n);
      assert.strictEqual(back.hash, rec.hash, 'record hash kept');
      let maxDp = 0, maxDt = 0;
      for (let i = 0; i < rec.n; i++) { maxDp = Math.max(maxDp, Math.abs(back.p[i] - rec.p[i])); maxDt = Math.max(maxDt, Math.abs(back.t[i] - rec.t[i])); }
      assert.ok(maxDp <= 0.0005 + 1e-9, 'pressures within 0.0005 psi: ' + maxDp);
      assert.strictEqual(maxDt, 0, 'times exact');
      const sh = checkShape('GaugeRecord', plain(back));
      assert.ok(sh.ok, 'decoded record is a GaugeRecord: ' + sh.errors.slice(0, 3).join('; '));
      const tests = app.toWin({ B1: { spec: { dt: [0.1, 1], p: [2500, 2510], n: null }, result: { id: 'B1', final: { k: 45, S: 1.2 } } } });
      await S.putTests('w1', tests);
      S._reset(); app.win.indexedDB = idb.indexedDB;
      const tb = await S.getTests('w1');
      assert.strictEqual(tb.B1.result.final.k, 45, 'overflow tests round trip');
      assert.strictEqual(await S.getRaw('nope'), null, 'unknown well → null');
      // failure path
      const app2 = ctx.loadApp({});
      try {
        const bad = createFakeIDB({ failOpen: true });
        app2.win.indexedDB = bad.indexedDB;
        const S2 = app2.win.WTS_buildup.store;
        assert.strictEqual((await S2.init()).engine, 'memory', 'failed open → memory engine');
        await S2.putRaw('w1', record(app2));
        const r2 = await S2.getRaw('w1');
        assert.ok(r2 && r2.n === FIX.samples.GaugeRecord.n, 'memory engine keeps the record for the session');
        assert.deepStrictEqual(bad.keys(DB, 'raw'), [], 'nothing written to the failed database');
      } finally { app2.dispose(); }
      // write failures do not throw either; they resolve ok:false (the page then records rawStored 'memory')
      idb.failWrites = true;
      const r3 = await S.putRaw('w2', record(app));
      assert.ok(r3 && r3.ok === false, 'a failed IndexedDB write resolves ok:false: ' + JSON.stringify(r3));
      assert.ok(S.hasRaw('w2'), 'mirror holds the record');
      const r4 = await S.putTests('w2', app.toWin({ B1: { spec: {}, result: {} } }));
      assert.ok(r4 && r4.ok === false, 'a failed tests write resolves ok:false');
      idb.failWrites = false;
      const r5 = await S.putRaw('w3', record(app));
      assert.ok(r5 && r5.ok === true && r5.engine === 'idb', 'a stored write resolves ok:true');
    },
  },
  {
    name: 'ST2 store/page: after a project Open whose raw record hash differs from the analysis, raw is treated as absent and the note is shown',
    wp: WP,
    async run(app, assert) {
      const idb = createFakeIDB();
      app.win.indexedDB = idb.indexedDB;
      const W = app.win, S = W.WTS_buildup.store;
      const a = FIX.analysis;
      const payload = W.WTS_project._buildPayload();
      const keys = Object.assign({}, (payload.modules.storage && payload.modules.storage.keys) || {});
      keys.wts_buildup_state = JSON.stringify({ v: 1, appVersion: 'v3.3', savedAt: '2026-10-31T00:00:00Z', input: null, analysis: a, review: null, qa: [], uiSel: {}, signoff: null, overrides: a.overrides, pageHash: 'x', zones: { g: '', pd: '' } });
      const wid = S.wellId();
      const wrong = S.encode(app.toWin(synthRecord(500, 'ffffffffffffffff')));
      payload.modules.storage = { keys, skipped: [] };
      payload.modules.buildup_raw = { wells: { [wid]: JSON.parse(JSON.stringify(wrong)) }, omitted: [] };
      W.WTS_project.loadFromObject(app.toWin(payload));
      assert.ok(S.hasRaw(wid), 'buildup_raw module filled the mirror synchronously');
      W.__WTS_TEST__.nav('buildup');
      await settle(app, 6);
      assert.strictEqual(W.WTS_buildup.page.mem().record, null, 'mismatched raw record is not used');
      const note = String(app.el('bu_raw_note').textContent);
      assert.match(note, /not embedded/i, 'note shown: ' + note);
      assert.ok(app.el('bu_res').getAttribute('data-done') === '1', 'stored analysis rendered');
      // the matching record is used
      const right = S.encode(app.toWin(synthRecord(400, a.record.hash)));
      await S.putRaw(wid, right);
      W.__WTS_TEST__.nav('home'); W.__WTS_TEST__.nav('buildup');
      await settle(app, 6);
      assert.ok(W.WTS_buildup.page.mem().record && W.WTS_buildup.page.mem().record.hash === a.record.hash, 'matching raw record loaded for detection re-runs');
      assert.strictEqual(String(app.el('bu_raw_note').textContent), '', 'no note when raw matches');
      app.flush(5000);
      assert.strictEqual(app.pendingTimers(), 0);
    },
  },
  {
    name: 'ST3 store: opening an old project without buildup_raw / buildup_analysis drops the previous project\'s entries',
    wp: WP,
    async run(app, assert) {
      const idb = createFakeIDB();
      app.win.indexedDB = idb.indexedDB;
      const W = app.win, S = W.WTS_buildup.store;
      await S.putRaw('w1', app.toWin(synthRecord(300)));
      await S.putTests('w1', app.toWin({ B1: { spec: {}, result: {} } }));
      await S.putRaw('w9', app.toWin(synthRecord(200)));
      assert.deepStrictEqual(idb.keys(DB, 'raw'), ['w1', 'w9']);
      W.WTS_project.loadFromObject(app.toWin({ format: 'h2oilproj', version: '1.0', modules: { storage: { keys: { wts_page_aga3: '{"v":1,"f":{}}' }, skipped: [] } } }));
      await settle(app, 8);
      assert.deepStrictEqual(Object.keys(S._mirror().raw), [], 'mirror raw cleared');
      assert.deepStrictEqual(Object.keys(S._mirror().tests), [], 'mirror tests cleared');
      assert.deepStrictEqual(idb.keys(DB, 'raw'), [], 'IndexedDB raw cleared');
      assert.deepStrictEqual(idb.keys(DB, 'tests'), [], 'IndexedDB tests cleared');
      // a project WITH the module keeps only its wells
      await S.putRaw('w1', app.toWin(synthRecord(300)));
      await S.putRaw('w2', app.toWin(synthRecord(300, 'aaaaaaaaaaaaaaaa')));
      const enc = JSON.parse(JSON.stringify(S.encode(app.toWin(synthRecord(100, 'bbbbbbbbbbbbbbbb')))));
      W.WTS_project.loadFromObject(app.toWin({ format: 'h2oilproj', version: '1.0', modules: { storage: { keys: {}, skipped: [] }, buildup_raw: { wells: { w2: enc }, omitted: [] } } }));
      await settle(app, 8);
      assert.deepStrictEqual(Object.keys(S._mirror().raw), ['w2'], 'only the file\'s well kept');
      assert.deepStrictEqual(idb.keys(DB, 'raw'), ['w2']);
      assert.strictEqual(S.rawHash('w2'), 'bbbbbbbbbbbbbbbb', 'the file\'s record replaced the old one');
      // New clears both
      W.WTS_project.new();
      await settle(app, 6);
      assert.deepStrictEqual(Object.keys(S._mirror().raw), []);
      assert.deepStrictEqual(idb.keys(DB, 'raw'), []);
    },
  },
  {
    name: 'ST4 store: a project saved before the page was opened (cold mirror) lists the well as omitted; write() fills the mirror synchronously',
    wp: WP,
    async run(app, assert) {
      const idb = createFakeIDB();
      app.win.indexedDB = idb.indexedDB;
      const W = app.win, S = W.WTS_buildup.store;
      app.storage.setItem('wts_buildup_state', JSON.stringify({ v: 1, analysis: FIX.analysis }));
      const p = W.WTS_project._buildPayload();
      const m = p.modules.buildup_raw;
      assert.ok(m && Array.isArray(m.omitted), 'buildup_raw module present in the payload');
      assert.deepStrictEqual(Object.keys(m.wells), [], 'cold mirror: no wells embedded');
      assert.deepStrictEqual(Array.from(m.omitted), [S.wellId()], 'the well with an analysis is listed as omitted');
      assert.ok(p.modules.storage.keys.wts_buildup_state, 'state travels in the storage module');
      assert.ok(!p.modules.buildup_analysis, 'no overflow → nothing to carry or omit in buildup_analysis');
      app.storage.setItem('wts_buildup_state', JSON.stringify({ v: 1, analysis: FIX.analysis, overflow: { wellId: S.wellId(), tests: ['B1'] } }));
      const pOv = W.WTS_project._buildPayload();
      assert.deepStrictEqual(Array.from(pOv.modules.buildup_analysis.omitted), [S.wellId()], 'an overflowed analysis with a cold mirror is listed as omitted');
      app.storage.setItem('wts_buildup_state', JSON.stringify({ v: 1, analysis: FIX.analysis }));
      // write fills the mirror before IndexedDB
      const enc = JSON.parse(JSON.stringify(S.encode(app.toWin(synthRecord(250, '1111222233334444')))));
      W.WTS_project.loadFromObject(app.toWin({ format: 'h2oilproj', version: '1.0', modules: { storage: p.modules.storage, buildup_raw: { wells: { [S.wellId()]: enc }, omitted: [] },
        buildup_analysis: { wells: { [S.wellId()]: { B1: { spec: { dt: [1], p: [2], n: null }, result: { id: 'B1' } } } }, omitted: [] } } }));
      assert.strictEqual(S.rawHash(S.wellId()), '1111222233334444', 'mirror filled synchronously by write()');
      assert.ok(S._mirror().tests[S.wellId()].B1, 'buildup_analysis mirror filled synchronously');
      await settle(app, 6);
      assert.deepStrictEqual(idb.keys(DB, 'raw'), [S.wellId()], 'then written to IndexedDB');
      const p2 = W.WTS_project._buildPayload();
      assert.strictEqual(p2.modules.buildup_raw.wells[S.wellId()].meta.hash, '1111222233334444', 'warm mirror: read() embeds the record without encoding');
      assert.deepStrictEqual(Array.from(p2.modules.buildup_raw.omitted), []);
    },
  },
  {
    name: 'ST5 store: a 60-test analysis on 3 wells saves within 300 kB per well (overflow to IndexedDB) and WTS_wells.switchTo works',
    wp: WP,
    timeoutMs: 60000,
    async run(app, assert) {
      const idb = createFakeIDB();
      app.win.indexedDB = idb.indexedDB;
      const W = app.win, S = W.WTS_buildup.store;
      const base = FIX.analysis;
      const big = (tag) => {
        const a = JSON.parse(JSON.stringify(base));
        const t0 = a.tests;
        a.tests = [];
        for (let i = 0; i < 60; i++) {
          const t = JSON.parse(JSON.stringify(t0[i % t0.length]));
          t.id = 'B' + (i + 1); if (t.result) t.result.id = t.id;
          a.tests.push(t);
        }
        a.meta.wellName = tag;
        return a;
      };
      const sizes = [];
      const save = () => {
        const st = app.toWin({ v: 1, input: null, analysis: big(S.wellId()), review: null, qa: [], uiSel: {}, signoff: null, overrides: [] });
        const r = S.saveState(st, {});
        sizes.push(r.bytes);
        return r;
      };
      const r1 = save();
      assert.ok(r1.ok && r1.overflow, 'saved with overflow: ' + JSON.stringify(r1));
      assert.ok(r1.bytes <= 300 * 1024, 'state ≤ 300 kB: ' + r1.bytes);
      await settle(app, 4);
      assert.deepStrictEqual(idb.keys(DB, 'tests'), [S.wellId()], 'per-test arrays and results parked in IndexedDB');
      const loaded = S.loadState();
      assert.ok(loaded.overflow && loaded.analysis.tests[0].result.summary, 'state keeps per-test summaries');
      assert.ok(loaded.analysis.tests[5].result.final && loaded.analysis.tests[5].result.confidence, 'summaries keep final values and labels');
      const re = await S.rehydrate(loaded);
      assert.ok(re.analysis.tests[59].result.models && re.analysis.tests[59].spec.dt.length > 0, 'rehydrated from IndexedDB');
      assert.ok(!re.analysis.tests[0].result.curves, 'recomputable curves never stored');
      const first = W.WTS_wells.active();
      let r = W.WTS_wells.create('Well B');
      assert.ok(r.ok, 'create B: ' + JSON.stringify(r));
      assert.ok(save().ok, 'well B saved');
      r = W.WTS_wells.create('Well C');
      assert.ok(r.ok, 'create C');
      assert.ok(save().ok, 'well C saved');
      sizes.forEach((b) => assert.ok(b <= 300 * 1024, 'per well ≤ 300 kB: ' + b));
      const sw = W.WTS_wells.switchTo(first);
      assert.ok(sw.ok, 'switch back to the first well: ' + JSON.stringify(sw));
      const st = S.loadState();
      assert.ok(st && st.analysis && st.analysis.tests.length === 60, 'first well\'s state restored on switch');
      await settle(app, 4);
      assert.strictEqual(idb.keys(DB, 'tests').length, 3, 'one overflow record per well');
    },
  },
  {
    name: 'ST6 store: encodeJob runs in 50k-sample units through drive and leaves no timers; the audit chain verifies and folds',
    wp: WP,
    async run(app, assert) {
      installDrive(app);
      const W = app.win, S = W.WTS_buildup.store;
      const rec = app.toWin(synthRecord(120000, 'abcdefabcdefabcd'));
      const job = S.encodeJob(rec);
      assert.strictEqual(job.units, 3, '120k samples → 3 units of ' + S.ENCODE_UNIT);
      let steps = 0;
      const step = job.step;
      job.step = function () { steps++; return step.apply(this, arguments); };
      const p = W.PRiSM_autoInterp.drive(job, {});
      let enc = null;
      p.then((e) => { enc = e; });
      for (let i = 0; i < 20 && !enc; i++) await app.flushAsync(1);
      assert.ok(enc, 'drive resolved with the encoded record');
      assert.strictEqual(steps, 3, 'one step per 50k-sample unit');
      const sync = S.encode(rec);
      assert.strictEqual(enc.tB64, sync.tB64, 'job output equals the one-shot encode (times)');
      assert.strictEqual(enc.pB64, sync.pB64, 'job output equals the one-shot encode (pressures)');
      const back = S.decode(enc);
      assert.strictEqual(back.n, 120000);
      assert.strictEqual(back.t[119999], rec.t[119999]);
      assert.ok(Math.abs(back.p[77777] - rec.p[77777]) < 0.0006);
      app.flush(5000);
      assert.strictEqual(app.pendingTimers(), 0, 'no timers left');
      // audit chain
      for (let i = 0; i < 520; i++) S.audit.append(app.toWin({ kind: i % 2 ? 'override' : 'run', who: 'A', reason: 'r' + i, target: 'B1', value: i }));
      const v = S.audit.verify();
      assert.ok(v.ok, 'chain verifies after folding: ' + JSON.stringify(v));
      const sum = S.audit.summary();
      assert.ok(sum && sum.n >= 20 && sum.chainHash, 'oldest entries folded into a summary with their chain hash');
      assert.strictEqual(S.audit.list().length + sum.n, 520, 'every entry counted');
      assert.ok(S.audit.list().length <= S.AUDIT_MAX);
      assert.ok(app.storage.getItem('wts_buildup_audit').length <= 200 * 1024, 'audit ≤ 200 kB');
      const raw = JSON.parse(app.storage.getItem('wts_buildup_audit'));
      raw.entries[3].reason = 'tampered';
      app.storage.setItem('wts_buildup_audit', JSON.stringify(raw));
      assert.strictEqual(S.audit.verify().ok, false, 'a tampered entry breaks the chain');
    },
  },
  {
    name: 'ST7 store: init() warms the raw and tests mirrors from IndexedDB, so a project saved in a fresh session embeds the well; newer mirror entries are kept',
    wp: WP,
    async run(app, assert) {
      const idb = createFakeIDB();
      app.win.indexedDB = idb.indexedDB;
      const W = app.win, S = W.WTS_buildup.store, wid = S.wellId();
      idb.set(DB, 'raw', wid, JSON.parse(JSON.stringify(S.encode(app.toWin(synthRecord(300, 'cccccccccccccccc'))))));
      idb.set(DB, 'tests', wid, { B1: { spec: { dt: [1], p: [2], n: null }, result: { id: 'B1' } } });
      idb.set(DB, 'raw', 'w9', JSON.parse(JSON.stringify(S.encode(app.toWin(synthRecord(100, 'dddddddddddddddd'))))));
      app.storage.setItem('wts_buildup_state', JSON.stringify({ v: 1, analysis: FIX.analysis, overflow: { wellId: wid, tests: ['B1'] } }));
      const cold = W.WTS_project._buildPayload();
      assert.deepStrictEqual(Array.from(cold.modules.buildup_raw.omitted), [wid], 'cold mirror: omitted');
      S.putRaw('w9', app.toWin(synthRecord(120, 'eeeeeeeeeeeeeeee')));   // written this session: newer than IndexedDB's copy
      await settle(app, 4);
      idb.set(DB, 'raw', 'w9', JSON.parse(JSON.stringify(S.encode(app.toWin(synthRecord(100, 'dddddddddddddddd'))))));
      const r = await S.init();
      assert.strictEqual(r.engine, 'idb');
      const p = W.WTS_project._buildPayload();
      assert.ok(p.modules.buildup_raw.wells[wid] && p.modules.buildup_raw.wells[wid].meta.hash === 'cccccccccccccccc', 'raw record embedded after the warm-up');
      assert.deepStrictEqual(Array.from(p.modules.buildup_raw.omitted), [], 'nothing omitted');
      assert.ok(p.modules.buildup_analysis && p.modules.buildup_analysis.wells[wid] && p.modules.buildup_analysis.wells[wid].B1, 'parked build-ups embedded');
      assert.strictEqual(S.rawHash('w9'), 'eeeeeeeeeeeeeeee', 'a mirror entry written this session is not replaced by the warm-up');
      app.flush(5000);
      assert.strictEqual(app.pendingTimers(), 0, 'no timers');
    },
  },
  {
    name: 'ST8 store: saveState caps the arrays that grow with the record (qc.gaps first 10 + longest 20 with the counts kept, spike indices, event warnings) before deciding on overflow',
    wp: WP,
    run(app, assert) {
      const S = app.win.WTS_buildup.store;
      const a = FIX.analysis;
      a.qc.gaps = [];
      for (let i = 0; i < 12000; i++) a.qc.gaps.push({ t0_ms: 1772323200000 + i * 900000, t1_ms: 1772323200000 + i * 900000 + (i === 7777 ? 3720000 : 120000), dur_h: i === 7777 ? 1.0333 : 0.0333 });
      a.qc.gapCount = 12000; a.qc.gapTotal_h = 400.6; a.qc.longestGap_h = 1.0333;
      a.qc.spikes = { count: 200, mode: 'flag', idx: Array.from({ length: 200 }, (_, i) => i * 7) };
      a.events[0].warnings = Array.from({ length: 30 }, (_, i) => ({ code: 'W' + i, level: 'info', text: 'Warning ' + i, ev: [] }));
      const st = app.toWin({ v: 1, input: null, analysis: a, review: null, qa: [], uiSel: {}, signoff: null, overrides: [] });
      const r = S.saveState(st, {});
      assert.ok(r.ok && !r.overflow, 'saved without overflow: ' + JSON.stringify(r));
      const back = S.loadState().analysis;
      assert.strictEqual(back.qc.gaps.length, 30, 'first 10 + longest 20 gaps kept');
      assert.ok(back.qc.gaps.some((g) => g.dur_h === 1.0333), 'the longest gap kept');
      assert.ok(back.qc.gaps[0].t0_ms === a.qc.gaps[0].t0_ms, 'the first gap kept, in time order');
      assert.strictEqual(back.qc.gapCount, 12000, 'gap count kept');
      assert.strictEqual(back.qc.gapTotal_h, 400.6, 'total gap time kept');
      assert.strictEqual(back.qc.longestGap_h, 1.0333);
      assert.deepStrictEqual({ kept: back.qc.gapsStored.kept, total: back.qc.gapsStored.total }, { kept: 30, total: 12000 }, 'what was kept is recorded');
      assert.strictEqual(back.qc.spikes.idx.length, 50, 'spike indices capped');
      assert.strictEqual(back.qc.spikes.count, 200, 'spike count kept');
      assert.strictEqual(back.events[0].warnings.length, 8, 'event warnings capped');
      assert.strictEqual(st.analysis.qc.gaps.length, 12000, 'the live analysis is not touched');
      assert.strictEqual(back.tests.length, a.tests.length);
    },
  },
];
