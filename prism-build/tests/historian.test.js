// Mini WellOS historian (prism-build/47-calc-historian.js) — acceptance tests.
//
// Engines: memory (the harness has no IndexedDB), IndexedDB (tests/_idb-mock.js),
// sql.js and the official SQLite WASM build — both loaded from the exact bundled
// files in ios-app/ios-additions/libs through the app's own SHA-384-checked
// loader (the fetch hook only supplies bytes), the latter through the real
// storage-Worker source run in a separate vm context (":memory:" instead of OPFS,
// which node does not have).
//
// Expected numbers are worked by hand in the comments (independent of the code
// under test): bucket statistics, the LTTB example, CSV text, retention rollups
// and the row-cap cut.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { createIndexedDB } = require('./_idb-mock');

const WP = 'HIST';
const REPO = path.resolve(__dirname, '..', '..');
const LIBDIR = path.join(REPO, 'ios-app', 'ios-additions', 'libs');
const T0 = Date.UTC(2026, 8, 29, 9, 0, 0);          // harness virtual "now" (a whole hour)
const MIN = 60000, HOUR = 3600000, DAY = 86400000;

const tick = () => new Promise((r) => setImmediate(r));
// Let promise chains, IndexedDB-mock macrotasks and app timers run until quiet.
async function settle(app, maxRounds) {
  let quiet = 0;
  for (let i = 0; i < (maxRounds || 4000) && quiet < 25; i++) {
    await tick();
    if (app.pendingTimers()) { app.flushUntilIdle(20000); quiet = 0; } else quiet++;
  }
}
function libFile(url) { const b = path.basename(String(url)); return b === 'index.mjs' ? 'sqlite3.mjs' : b; }
// Serve the bundled library files to the app's loader (fetch is unavailable in the harness).
function useLibs(app, o) {
  o = o || {};
  const log = [];
  app.win.WTS_historian._test.fetchBytes = (url) => {
    log.push(url);
    if (o.offline) throw new Error('offline');
    let b = fs.readFileSync(path.join(LIBDIR, libFile(url)));
    if (o.tamper && o.tamper === libFile(url)) b = Buffer.concat([b, Buffer.from(' ')]);
    return b;
  };
  return log;
}
function useIdb(app, idb) { idb = idb || createIndexedDB(); app.win.indexedDB = idb.indexedDB; app.win.IDBKeyRange = idb.IDBKeyRange; return idb; }
function setEngine(app, engine, extra) { app.storage.setItem('wts_historian_settings', JSON.stringify(Object.assign({ engine }, extra || {}))); }
// A Worker stand-in that runs the app's storage-worker source in its own vm realm.
function fakeWorkerClass(getSource, navigatorObj) {
  return class FakeWorker {
    constructor(url) {
      this.url = url; this.onmessage = null; this.onerror = null; this._dead = false;
      const self = {
        console: { log() {}, warn() {}, info() {}, debug() {}, error() {} },
        TextDecoder, TextEncoder, URL, URLSearchParams, performance: { now: () => Date.now() },
        crypto: { getRandomValues: (a) => crypto.randomFillSync(a) }, navigator: navigatorObj || {},
        location: { href: 'blob:http://localhost:8080/hist-worker' }, setTimeout, clearTimeout,
        WorkerGlobalScope: function WorkerGlobalScope() {},
      };
      self.postMessage = (data) => { if (this._dead) return; const d = structuredClone(data); setImmediate(() => { if (this.onmessage) this.onmessage({ data: d }); }); };
      this._ctx = vm.createContext(self);                 // own realm, own WebAssembly/Function (as in a real Worker)
      vm.runInContext('var self = globalThis;', this._ctx);
      vm.runInContext(getSource(), this._ctx, { filename: 'hist-worker.js' });
    }
    postMessage(msg) { if (this._dead) return; const d = structuredClone(msg); setImmediate(() => { const f = this._ctx.onmessage; if (typeof f === 'function') f({ data: d }); }); }
    terminate() { this._dead = true; }
  };
}
const H = (app) => app.win.WTS_historian;
const arr = (a) => Array.from(a);
const plain = (x) => JSON.parse(JSON.stringify(x));      // app-realm objects → node realm for deepStrictEqual

// ── The aggregation data set (B = 10 min before T0, a minute boundary) ──
const B = T0 - 10 * MIN;
const AGG = [
  [B + 0, 10, 'good'], [B + 10000, 20, 'good'], [B + 20000, 90, 'stale'], [B + 30000, null, 'bad'], [B + 40000, 30, 'good'],
  [B + 60000, 5, 'stale'], [B + 70000, 7, 'stale'], [B + 80000, null, undefined],
  [B + 130000, null, 'bad'], [B + 150000, 42, 'bad'],
  [B + 200000, -1.5, 'good'],
];
// Hand values, 60-s buckets (good samples if any, else stale, else a gap):
//   [B, B+60s):      good 10, 20, 30 → avg 20, min 10, max 30, last 30 (t = B+40 s), n 3, good
//   [B+60, B+120s):  no good; stale 5, 7 → avg 6, min 5, max 7, last 7, n 2, stale
//   [B+120, B+180s): only bad (null, and 42 flagged bad) → gap (null, bad)
//   [B+180, B+240s): good −1.5 → −1.5
// 120-s buckets: [B, B+120s) → good 10, 20, 30 → 20 / 10 / 30 / 30; [B+120, B+240s) → −1.5.
const AGG60 = { t: [B, B + MIN, B + 2 * MIN, B + 3 * MIN], avg: [20, 6, null, -1.5], min: [10, 5, null, -1.5], max: [30, 7, null, -1.5],
  last: [30, 7, null, -1.5], q: [0, 1, 2, 0], n: [3, 2, 0, 1] };
function recordAgg(app) {
  return H(app).record(AGG.map(([t, v, q]) => ({ tag: 'AGG', device: 'rtu', unit: 'psig', t, v, q })));
}
async function checkAgg(app, assert, label) {
  const Hh = H(app);
  for (const agg of ['avg', 'min', 'max', 'last']) {
    const r = await Hh.query({ tags: ['AGG'], agg, bucketMs: MIN });
    const s = r.series[0];
    assert.deepStrictEqual(arr(s.t), AGG60.t, label + ' ' + agg + ' bucket starts');
    assert.deepStrictEqual(arr(s.q), AGG60.q, label + ' ' + agg + ' quality');
    assert.deepStrictEqual(arr(s.n), AGG60.n, label + ' ' + agg + ' counts');
    AGG60[agg].forEach((x, i) => { if (x === null) assert.strictEqual(s.v[i], null, label + ' gap'); else assert.near(s.v[i], x, 1e-12, label + ' ' + agg + '[' + i + ']'); });
  }
  const r2 = await Hh.query({ tags: ['AGG'], agg: 'avg', bucketMs: 2 * MIN });
  assert.deepStrictEqual(arr(r2.series[0].t), [B, B + 2 * MIN], label + ' 120-s buckets');
  assert.near(r2.series[0].v[0], 20, 1e-12); assert.near(r2.series[0].v[1], -1.5, 1e-12);
  assert.deepStrictEqual(arr(r2.series[0].min), [10, -1.5]); assert.deepStrictEqual(arr(r2.series[0].max), [30, -1.5]);
  const raw = await Hh.query({ tags: ['AGG'] });
  assert.deepStrictEqual(arr(raw.series[0].t), AGG.map((x) => x[0]), label + ' raw times');
  assert.deepStrictEqual(arr(raw.series[0].v), AGG.map((x) => x[1]), label + ' raw values');
  assert.deepStrictEqual(arr(raw.series[0].q), [0, 0, 1, 2, 0, 1, 1, 2, 2, 2, 0], label + ' raw quality codes');
}

module.exports = [
  {
    name: 'HIST registry: "Mini WellOS" sidebar group + tile; nothing opened, loaded or scheduled at app start',
    wp: WP,
    run(app, assert) {
      const Hh = H(app), reg = app.win.WTS_calcRegistry.historian;
      assert.ok(reg && reg.group === 'Mini WellOS' && reg.key === 'historian' && typeof reg.render === 'function', 'registry entry');
      ['record', 'query', 'listTags', 'stats', 'exportCSV', 'exportXLSX', 'exportDb', 'importFile', 'purge', 'setRetention'].forEach((f) => assert.fn(Hh[f], f));
      const btn = app.find('.nav-btn[data-p="historian"]');
      assert.ok(btn, 'sidebar button');
      const grp = btn.closest('.nav-group'), lbl = grp && grp.querySelector('.nav-group-label');
      assert.strictEqual(lbl && lbl.textContent.trim(), 'Mini WellOS', 'in the Mini WellOS group');
      app.flush(5000);
      assert.strictEqual(app.pendingTimers(), 0, 'no timers after 5 s idle');
      const st = Hh.status();
      assert.strictEqual(st.ready, false, 'store not opened at start');
      assert.deepStrictEqual(Object.keys(st.lib), [], 'no library loaded at start');
      app.hook.nav('home');
      const titles = app.findAll('.dash-card').map((c) => String(c.querySelector('h3').textContent).trim());
      assert.ok(titles.indexOf('Historian') !== -1, 'dashboard tile');
    },
  },
  {
    name: 'HIST record → flush → query (memory engine): debounce, event input, updated event, Modbus metadata, validation',
    wp: WP,
    async run(app, assert) {
      const Hh = H(app), W = app.win;
      W.WTS_modbus = { getTags: () => [{ tag: 'PT-101', device: 'RTU-1', unit: 'psig', pollMs: 1000, desc: 'Wellhead pressure' },
        { name: 'FT-9', device: 'RTU-1', units: 'Mscf/d', enabled: false }] };
      const events = [];
      app.document.addEventListener('wts:historian-updated', (e) => events.push(e.detail));
      const t = T0 - 3000;
      assert.strictEqual(Hh.record([{ tag: 'PT-101', t, v: 1500.5, q: 'good', raw: 15005 }, { tag: 'PT-101', t: t + 1000, v: 1501, q: 'stale' },
        { tag: 'PT-101', t: t + 2000, v: null, q: 'bad' }]), 3);
      assert.strictEqual(app.pendingTimers(), 1, 'one debounce timer while samples wait');
      assert.strictEqual(Hh.status().buffer, 3);
      app.flush(2000);
      await settle(app);
      assert.strictEqual(Hh.status().engine, 'memory', 'no IndexedDB in the harness → memory');
      assert.strictEqual(events.length, 1, 'one updated event');
      assert.strictEqual(events[0].reason, 'flush'); assert.strictEqual(events[0].count, 3);
      app.fire('document', 'wts:modbus-samples', [{ tag: 'TT-102', device: 'RTU-2', unit: 'degF', t: t + 500, v: 71.25, q: 'good' }]);
      app.fire('document', 'wts:modbus-samples', { samples: [{ tag: 'TT-102', t: t + 1500, v: 71.5 }] });
      await Hh.flush();
      const r = await Hh.query({ tags: ['PT-101', 'TT-102', 'NOPE'] });
      assert.deepStrictEqual(arr(r.series[0].t), [t, t + 1000, t + 2000]);
      assert.deepStrictEqual(arr(r.series[0].v), [1500.5, 1501, null]);
      assert.deepStrictEqual(arr(r.series[0].q), [0, 1, 2]);
      assert.strictEqual(r.series[0].unit, 'psig', 'unit from WTS_modbus.getTags()');
      assert.strictEqual(r.series[0].device, 'RTU-1');
      assert.deepStrictEqual(arr(r.series[1].v), [71.25, 71.5], 'event input');
      assert.ok(r.series[2].missing, 'unknown tag flagged');
      const tags = await Hh.listTags(), by = {};
      tags.forEach((x) => { by[x.tag] = x; });
      assert.strictEqual(by['PT-101'].count, 3);
      assert.strictEqual(by['PT-101'].desc, 'Wellhead pressure');
      // last sample t + 2000 = T0 − 1 s; poll 1 s → limit max(3 × 1 s, 10 s) = 10 s → logging; last quality bad
      assert.strictEqual(by['PT-101'].status.code, 'bad', 'logging, last sample bad');
      assert.strictEqual(by['FT-9'].status.code, 'disabled', 'disabled on the Modbus page');
      assert.strictEqual(by['FT-9'].count, 0); assert.strictEqual(by['FT-9'].unit, 'Mscf/d');
      // validation: no tag → rejected; unparsable time → "now"; string value → number
      assert.strictEqual(Hh.record([{ v: 1 }, null, { tag: '', v: 2 }]), 0);
      const nowX = app.win.Date.now();
      assert.strictEqual(Hh.record({ tag: 'X-1', t: 'soon', v: '2.5' }), 1);
      await Hh.flush();
      const x = await Hh.query({ tags: ['X-1'] });
      assert.deepStrictEqual(arr(x.series[0].t), [nowX], 'unparsable time → now'); assert.deepStrictEqual(arr(x.series[0].v), [2.5]);
      // ≥ 2000 waiting samples → flushed at once (0-ms timer), not after the 2-s debounce
      const big = [];
      for (let i = 0; i < 2000; i++) big.push({ tag: 'BIG', t: T0 - DAY + i, v: i });
      Hh.record(big);
      assert.strictEqual(app.timers()[0].delay, 0, 'immediate flush when the buffer is large');
      app.flush(0);
      await settle(app);
      assert.strictEqual((await Hh.stats()).samples, 3 + 2 + 1 + 2000);
      await settle(app);
      assert.strictEqual(app.pendingTimers(), 0, 'nothing pending once written');
      assert.strictEqual(app.win.WTS_state.historian.samples, 2006, 'WTS_state.historian published');
    },
  },
  {
    name: 'HIST aggregation avg/min/max/last per bucket = hand values (memory engine)',
    wp: WP,
    async run(app, assert) {
      recordAgg(app);
      await H(app).flush();
      await checkAgg(app, assert, 'memory');
      // pure reference aggregator gives the same buckets
      const U = H(app).util, p = U.aggregate(AGG.map((x) => x[0]), AGG.map((x) => x[1]), AGG.map((x) => U.qCode(x[2], x[1])), MIN);
      assert.deepStrictEqual(plain(p.map((x) => x.avg)), AGG60.avg);
    },
  },
  {
    name: 'HIST IndexedDB engine: same hand values, duplicates, persistence across a reload',
    wp: WP,
    async run(app, assert, ctx) {
      const idb = useIdb(app);
      setEngine(app, 'idb');
      recordAgg(app);
      await H(app).flush();
      assert.strictEqual(H(app).status().engine, 'idb');
      await checkAgg(app, assert, 'idb');
      assert.strictEqual(idb.dump()['wts-historian'].samples, 11, '11 sample records');
      // the same (tag, t) again: live data overwrites
      H(app).record({ tag: 'AGG', t: B, v: 11, q: 'good' });
      await H(app).flush();
      assert.strictEqual(idb.dump()['wts-historian'].samples, 11, 'no duplicate row');
      const app2 = app.reload();
      try {
        useIdb(app2, idb);
        const r = await H(app2).query({ tags: ['AGG'], to: B });
        assert.strictEqual(H(app2).status().engine, 'idb', 'home engine reopened');
        assert.deepStrictEqual(arr(r.series[0].v), [11], 'value persisted');
      } finally { app2.dispose(); }
    },
  },
  {
    name: 'HIST sql.js engine (bundled 1.14.2, SHA-384 checked): hand values, snapshot saved to IndexedDB and reloaded',
    wp: WP,
    timeoutMs: 120000,
    async run(app, assert) {
      const idb = useIdb(app), log = useLibs(app);
      setEngine(app, 'sqljs');
      recordAgg(app);
      await H(app).flush();
      const st = H(app).status();
      assert.strictEqual(st.engine, 'sqljs', st.reasons.join('; '));
      assert.ok(st.lib.sqljs.verified, 'SHA-384 verified');
      assert.strictEqual(st.lib.sqljs.version, '3.49.1', 'SQLite inside sql.js 1.14.2');
      assert.deepStrictEqual(log.map(libFile).sort(), ['sql-wasm.js', 'sql-wasm.wasm'], 'only sql.js fetched');
      assert.ok(log.every((u) => /^https:\/\/cdn\.jsdelivr\.net\/npm\/sql\.js@1\.14\.2\//.test(u)), 'pinned CDN URLs on the web');
      await checkAgg(app, assert, 'sqljs');
      // the file is saved 1 s after a write while it is small (< 100k rows), else after 8 s
      assert.ok(app.timers().some((t) => t.delay === 1000), 'snapshot timer armed');
      app.flush(1000);
      await settle(app);
      assert.strictEqual(idb.dump()['wts-historian-sqljs'].files, 1, 'SQLite file in IndexedDB');
      const snap = idb.records('wts-historian-sqljs', 'files')[0].value;
      assert.strictEqual(Buffer.from(snap.slice(0, 16)).toString('latin1'), 'SQLite format 3\u0000', 'a real SQLite file');
      const app2 = app.reload();
      try {
        useIdb(app2, idb); useLibs(app2);
        const r = await H(app2).query({ tags: ['AGG'], agg: 'avg', bucketMs: MIN });
        assert.strictEqual(H(app2).status().engine, 'sqljs');
        assert.deepStrictEqual(arr(r.series[0].t), AGG60.t, 'reloaded from the snapshot');
      } finally { app2.dispose(); }
    },
  },
  {
    name: 'HIST official SQLite WASM 3.53.4 through the storage Worker: hand values, .sqlite export, no OPFS → fallback',
    wp: WP,
    timeoutMs: 120000,
    async run(app, assert) {
      const Hh = H(app);
      useLibs(app);
      Hh._test.workerMemory = true;                       // node has no OPFS: ':memory:' in the same worker code
      app.win.Worker = fakeWorkerClass(() => Hh._internal.workerSource());
      recordAgg(app);
      await Hh.flush();
      const st = Hh.status();
      assert.strictEqual(st.engine, 'opfs', st.reasons.join('; '));
      assert.strictEqual(st.lib.sqlite.version, '3.53.4');
      assert.ok(st.lib.sqlite.verified, 'SHA-384 verified');
      await checkAgg(app, assert, 'sqlite-wasm');
      const db = await Hh.exportDb({ download: false });
      assert.strictEqual(db.format, 'sqlite');
      assert.strictEqual(Buffer.from(db.bytes.slice(0, 16)).toString('latin1'), 'SQLite format 3\u0000');
      assert.strictEqual((await Hh.stats()).version, '3.53.4');
      // Same worker, no OPFS and no test override → the engine refuses and the next one is used.
      const app2 = app.reload();
      try {
        useLibs(app2);
        app2.win.Worker = fakeWorkerClass(() => H(app2)._internal.workerSource());
        app2.storage.removeItem('wtshist_home');
        await H(app2).ready();
        assert.strictEqual(H(app2).status().engine, 'memory');
        assert.ok(/OPFS sync access handles are not available/.test(H(app2).status().reasons[0]), H(app2).status().reasons[0]);
      } finally { app2.dispose(); }
    },
  },
  {
    name: 'HIST library integrity: tampered bytes are refused (never run); iOS / no-WebCrypto use the bundled copy only',
    wp: WP,
    timeoutMs: 120000,
    async run(app, assert, ctx) {
      useIdb(app);
      const log = useLibs(app, { tamper: 'sql-wasm.js' });
      setEngine(app, 'sqljs');
      await H(app).ready();
      const st = H(app).status();
      assert.strictEqual(st.engine, 'idb', 'fell back to IndexedDB');
      assert.ok(/SHA-384 mismatch/.test(st.reasons[0]), st.reasons[0]);
      assert.strictEqual(st.lib.sqljs, undefined, 'sql.js never initialised');
      assert.strictEqual(log.filter((u) => /sql-wasm\.js$/.test(u)).length, 2, 'both pinned mirrors tried');
      // Native iOS shell: the bundled copy next to index.html comes first.
      const a2 = ctx.loadApp();
      try {
        useIdb(a2);
        const l2 = useLibs(a2);
        a2.win.Capacitor = { isNativePlatform: () => true };
        setEngine(a2, 'sqljs');
        await H(a2).ready();
        assert.strictEqual(l2[0], 'http://localhost:8080/sql-wasm.js', 'local bundle first');
        assert.ok(H(a2).status().lib.sqljs.verified);
        // Without WebCrypto a CDN copy is never used; the bundled copy is accepted unverified.
        const a3 = ctx.loadApp();
        try {
          useIdb(a3);
          const l3 = useLibs(a3);
          a3.win.crypto = { getRandomValues: (x) => crypto.randomFillSync(x) };
          setEngine(a3, 'sqljs');
          await H(a3).ready();
          assert.strictEqual(H(a3).status().engine, 'idb', 'no WebCrypto on the web → no CDN code');
          assert.strictEqual(l3.length, 0, 'nothing fetched');
        } finally { a3.dispose(); }
        const a4 = ctx.loadApp();
        try {
          useIdb(a4);
          const l4 = useLibs(a4);
          a4.win.crypto = { getRandomValues: (x) => crypto.randomFillSync(x) };
          a4.win.Capacitor = { isNativePlatform: () => true };
          setEngine(a4, 'sqljs');
          await H(a4).ready();
          assert.strictEqual(H(a4).status().engine, 'sqljs', 'app bundle accepted without WebCrypto');
          assert.strictEqual(H(a4).status().lib.sqljs.verified, false, 'reported as not hash-checked');
          assert.ok(l4.every((u) => /^http:\/\/localhost:8080\//.test(u)), 'only the local copy');
        } finally { a4.dispose(); }
      } finally { a2.dispose(); }
    },
  },
  {
    name: 'HIST LTTB = hand-worked example; gap-aware decimation keeps a marker per gap',
    wp: WP,
    async run(app, assert) {
      const U = H(app).util;
      // x = 0…9, y = [0,4,1,2,8,1,0,6,2,3], threshold 6 → every = (10−2)/(6−2) = 2.
      // bucket 1: next-avg (3.5, 5), candidates 1, 2 → areas 4.5, 3.25 → keep 1
      // bucket 2: next-avg (5.5, 0.5), candidates 3, 4 → areas 1, 14.25 → keep 4
      // bucket 3: next-avg (7.5, 4), candidates 5, 6 → areas 10.25, 10 → keep 5
      // bucket 4: next-avg (9, 3), candidates 7, 8 → areas 8, 1 → keep 7;  + first and last.
      const x = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], y = [0, 4, 1, 2, 8, 1, 0, 6, 2, 3];
      assert.deepStrictEqual(arr(U.lttb(x, y, 0, 10, 6)), [0, 1, 4, 5, 7, 9]);
      assert.deepStrictEqual(arr(U.lttb(x, y, 0, 10, 10)), x, 'threshold ≥ n keeps all');
      assert.deepStrictEqual(arr(U.lttb(x, y, 0, 10, 2)), x, 'threshold < 3 keeps all');
      const t = [], v = [], q = [];
      for (let i = 0; i < 20; i++) { t.push(i * 1000); v.push(i === 8 || i === 9 ? null : Math.sin(i)); q.push(i === 8 || i === 9 ? 2 : 0); }
      const k = U.decimate(t, v, q, 8);
      // runs [0,8) and [10,20), one gap marker (8); budget 7 → 3 + 4 points
      assert.strictEqual(k.length, 8);
      assert.ok(k.indexOf(8) !== -1 && k.indexOf(9) === -1, 'one marker for the gap');
      [0, 7, 10, 19].forEach((i) => assert.ok(k.indexOf(i) !== -1, 'run end ' + i + ' kept'));
      assert.strictEqual(U.decimate(t, v, q, 50), null, 'nothing to drop');
      const s = [];
      for (let i = 0; i < 5000; i++) s.push({ tag: 'N', t: T0 - 5000000 + i * 1000, v: i % 100 === 0 ? 500 : Math.sin(i / 50) });
      H(app).record(s);
      const r = await H(app).query({ tags: ['N'], maxPoints: 300 });
      assert.ok(r.series[0].decimated && r.series[0].t.length <= 300 && r.series[0].count === 5000, 'raw query decimated to maxPoints');
      assert.ok(r.series[0].v.indexOf(500) !== -1, 'spikes survive LTTB');
    },
  },
  {
    name: 'HIST CSV export: exact long and wide text',
    wp: WP,
    async run(app, assert) {
      const Hh = H(app);
      Hh.record([{ tag: 'PT-1', unit: 'psig', device: 'rtu1', t: T0, v: 100.5, q: 'good' }, { tag: 'PT-1', unit: 'psig', device: 'rtu1', t: T0 + 1000, v: null, q: 'bad' },
        { tag: 'PT-1', unit: 'psig', device: 'rtu1', t: T0 + 2000, v: 101.25, q: 'stale' }, { tag: 'TT-1', unit: 'degF', t: T0, v: 60 }, { tag: 'TT-1', unit: 'degF', t: T0 + 2000, v: 61 }]);
      const long = await Hh.exportCSV({ tags: ['PT-1'], download: false });
      assert.strictEqual(long.text,
        'time_utc,epoch_ms,tag,value,quality,unit,device,source,n,min,max\r\n' +
        '2026-09-29T09:00:00.000Z,1790672400000,PT-1,100.5,good,psig,rtu1,raw,,,\r\n' +
        '2026-09-29T09:00:01.000Z,1790672401000,PT-1,,bad,psig,rtu1,raw,,,\r\n' +
        '2026-09-29T09:00:02.000Z,1790672402000,PT-1,101.25,stale,psig,rtu1,raw,,,\r\n');
      const wide = await Hh.exportCSV({ tags: ['PT-1', 'TT-1'], layout: 'wide', download: false });
      // 09:00:01 has only a bad PT-1 value → the row is empty and left out
      assert.strictEqual(wide.text,
        'time_utc,epoch_ms,PT-1 [psig],TT-1 [degF]\r\n' +
        '2026-09-29T09:00:00.000Z,1790672400000,100.5,60\r\n' +
        '2026-09-29T09:00:02.000Z,1790672402000,101.25,61\r\n');
      // bucketed export (avg per 1 min): PT-1 good 100.5 only → 100.5, n 1
      const agg = await Hh.exportCSV({ tags: ['PT-1'], agg: 'avg', bucketMs: MIN, download: false });
      assert.strictEqual(agg.text.split('\r\n')[1], '2026-09-29T09:00:00.000Z,1790672400000,PT-1,100.5,good,psig,rtu1,avg 1 min,1,100.5,100.5');
      // the download itself
      const n0 = app.downloads.length;
      await Hh.exportCSV({ tags: ['TT-1'], filename: 'tt.csv' });
      const d = app.downloads[n0];
      assert.ok(d && d.filename === 'tt.csv' && d.content.indexOf('TT-1,60,good,degF') !== -1, 'downloaded');
      await settle(app);
    },
  },
  {
    name: 'HIST Excel export/import through the SheetJS interface (Samples / Tags / Info sheets, round trip)',
    wp: WP,
    async run(app, assert) {
      const Hh = H(app);
      let written = null;
      const wbStore = [];
      app.win.XLSX = {
        utils: {
          book_new: () => ({ SheetNames: [], Sheets: {} }),
          aoa_to_sheet: (aoa) => ({ aoa: aoa.map((r) => r.slice()) }),
          book_append_sheet: (wb, ws, n) => { wb.SheetNames.push(n); wb.Sheets[n] = ws; },
          sheet_to_json: (ws, o) => ws.aoa.map((r) => r.map((c) => (c === null || c === undefined ? (o && o.defval !== undefined ? o.defval : c) : c))),
        },
        write: (wb, o) => { written = { wb, o }; wbStore.push(wb); return new Uint8Array([0x50, 0x4b, 3, 4, 1, 2]); },
        read: () => wbStore[wbStore.length - 1],
      };
      Hh.record([{ tag: 'PT-1', unit: 'psig', device: 'rtu1', t: T0, v: 100.5 }, { tag: 'PT-1', unit: 'psig', device: 'rtu1', t: T0 + 1000, v: null, q: 'bad' }]);
      const r = await Hh.exportXLSX({ tags: ['PT-1'], download: false });
      assert.deepStrictEqual(plain(written.wb.SheetNames), ['Samples', 'Tags', 'Info']);
      assert.strictEqual(written.o.bookType, 'xlsx');
      const aoa = plain(written.wb.Sheets.Samples.aoa);
      assert.deepStrictEqual(aoa[0], ['time_utc', 'epoch_ms', 'tag', 'value', 'quality', 'unit', 'device', 'source', 'n', 'min', 'max']);
      assert.deepStrictEqual(aoa[1], ['2026-09-29T09:00:00.000Z', 1790672400000, 'PT-1', 100.5, 'good', 'psig', 'rtu1', 'raw', null, null, null], 'numbers stay numbers');
      assert.deepStrictEqual(aoa[2].slice(2, 5), ['PT-1', null, 'bad'], 'empty value cell for bad');
      assert.deepStrictEqual(plain(written.wb.Sheets.Tags.aoa[1]).slice(0, 5), ['PT-1', 'rtu1', 'psig', null, 2]);
      assert.strictEqual(r.rows, 2);
      await Hh.purge({ all: true });
      assert.strictEqual((await Hh.stats()).samples, 0);
      const imp = await Hh.importFile({ name: 'back.xlsx', data: new Uint8Array([0x50, 0x4b, 3, 4, 1, 2]) });
      assert.strictEqual(imp.inserted, 2); assert.ok(/^xlsx/.test(imp.format));
      const q = await Hh.query({ tags: ['PT-1'] });
      assert.deepStrictEqual(arr(q.series[0].v), [100.5, null]); assert.deepStrictEqual(arr(q.series[0].q), [0, 2]);
      assert.strictEqual(q.series[0].unit, 'psig');
      await settle(app);
    },
  },
  {
    name: 'HIST restore: CSV merge (skip / overwrite duplicates), wide CSV, JSON replace, SQLite backup round trip',
    wp: WP,
    timeoutMs: 120000,
    async run(app, assert) {
      const Hh = H(app);
      useLibs(app);                                        // sql.js builds / reads the .sqlite backup
      const s = [];
      for (let i = 0; i < 50; i++) s.push({ tag: 'A', unit: 'bar', t: T0 - 50000 + i * 1000, v: i / 4, q: i === 10 ? 'stale' : 'good' });
      s.push({ tag: 'B', unit: 'degC', t: T0 - 1000, v: -3 });
      Hh.record(s);
      const csv = (await Hh.exportCSV({ download: false })).text;
      const js = (await Hh.exportDb({ format: 'json', download: false })).text;
      const sq = await Hh.exportDb({ format: 'sqlite', download: false });
      assert.strictEqual(Buffer.from(sq.bytes.slice(0, 15)).toString('latin1'), 'SQLite format 3', 'memory store → .sqlite via sql.js');
      // merge the same CSV again: every row is a duplicate
      let r = await Hh.importFile(new app.win.File([csv], 'h.csv'));
      assert.deepStrictEqual([r.inserted, r.skipped, r.updated, r.invalid, r.tagsCreated], [0, 51, 0, 0, 0], 'all duplicates kept');
      // overwrite duplicates with changed values
      const changed = csv.replace(',A,12.25,good', ',A,99,good');
      r = await Hh.importFile(changed, { name: 'h.csv', dup: 'overwrite' });
      assert.strictEqual(r.updated, 51);
      assert.deepStrictEqual(arr((await Hh.query({ tags: ['A'], from: T0 - 1000, to: T0 - 1000 })).series[0].v), [99], 'overwritten (i = 49 → 12.25 → 99)');
      // replace everything with the JSON backup → original values back
      r = await Hh.importFile(js, { name: 'b.json', mode: 'replace' });
      assert.strictEqual(r.inserted, 51);
      const q1 = await Hh.query({ tags: ['A'] });
      assert.deepStrictEqual(arr(q1.series[0].v), s.slice(0, 50).map((x) => x.v));
      assert.strictEqual(q1.series[0].q[10], 1, 'quality restored');
      // wipe, then restore the .sqlite backup
      await Hh.purge({ all: true });
      r = await Hh.importFile({ name: 'b.sqlite', data: sq.bytes });
      assert.strictEqual(r.inserted, 51); assert.strictEqual(r.format, 'sqlite');
      const q2 = await Hh.query({ tags: ['A', 'B'] });
      assert.deepStrictEqual(arr(q2.series[0].t), s.slice(0, 50).map((x) => x.t));
      assert.strictEqual(q2.series[1].unit, 'degC');
      // wide CSV (hand-made, a spreadsheet user's layout): quality = good
      r = await Hh.importFile('time_utc,W1 [kPa],W2\r\n2026-09-29T08:00:00Z,1.5,\r\n2026-09-29T08:00:01Z,2,7\r\nnot a time,3,4\r\n', { name: 'w.csv' });
      assert.deepStrictEqual([r.inserted, r.invalid, r.tagsCreated], [3, 1, 2]);
      const w = await Hh.query({ tags: ['W1'] });
      assert.deepStrictEqual(arr(w.series[0].t), [T0 - HOUR, T0 - HOUR + 1000]); assert.strictEqual(w.series[0].unit, 'kPa');
      // not a historian file
      await assert.rejects(Hh.importFile('{"a":1}', { name: 'x.json' }), /Not a historian JSON backup/);
      await assert.rejects(Hh.importFile('x,y\r\n1,2\r\n', { name: 'x.csv' }), /No time column|No header row/);
      await settle(app);
    },
  },
  {
    name: 'HIST retention: delete after N days, 1-min rollups (hand stats), queries merge them, backfill merges into a rollup',
    wp: WP,
    async run(app, assert) {
      const Hh = H(app);
      setEngine(app, 'auto', { days: 3, downsampleAfterDays: 1, maxRows: 0 });   // settings only: the first write runs retention
      const M = T0 - 2 * DAY, rec = [];
      for (let k = 0; k < 6; k++) rec.push({ tag: 'RET', unit: 'bar', t: T0 - 4 * DAY + k * 10000, v: k + 1 });     // older than 3 days
      rec.push({ tag: 'RET', unit: 'bar', t: M, v: 1 }, { tag: 'RET', t: M + 15000, v: 2 }, { tag: 'RET', t: M + 30000, v: 3, q: 'stale' },
        { tag: 'RET', t: M + 45000, v: 4 }, { tag: 'RET', t: M + 60000, v: 10 }, { tag: 'RET', t: M + 75000, v: null, q: 'bad' });
      rec.push({ tag: 'RET', t: T0 - HOUR, v: 55 });
      Hh.record(rec);
      await Hh.flush();                                    // first write → retention runs
      const st = await Hh.stats();
      assert.strictEqual(st.samples, 1, 'only the 1-h-old raw sample stays raw');
      assert.strictEqual(st.rollups, 2, 'two 1-min rollups');
      assert.deepStrictEqual(plain(st.lastRetentionResult), { deleted: 6, deletedRollups: 0, rolledUp: 6, rollups: 2, capped: 0 });
      // rollup M: good 1, 2, 4 → n 3, avg 7/3, min 1, max 4, last 4; rollup M+1 min: good 10 (bad null ignored)
      const raw = await Hh.query({ tags: ['RET'] });
      assert.deepStrictEqual(arr(raw.series[0].t), [M, M + MIN, T0 - HOUR]);
      assert.near(raw.series[0].v[0], 7 / 3, 1e-12); assert.strictEqual(raw.series[0].v[1], 10); assert.strictEqual(raw.series[0].v[2], 55);
      assert.deepStrictEqual(arr(raw.series[0].rollup), [1, 1, 0], 'rolled-up points flagged');
      // 1-h buckets: M's hour holds both rollups → (1 + 2 + 4 + 10) / 4 = 4.25, min 1, max 10, last 10
      const h = await Hh.query({ tags: ['RET'], agg: 'avg', bucketMs: HOUR });
      assert.deepStrictEqual(arr(h.series[0].t), [M, T0 - HOUR]);
      assert.near(h.series[0].v[0], 4.25, 1e-12);
      assert.deepStrictEqual([h.series[0].min[0], h.series[0].max[0], h.series[0].n[0]], [1, 10, 4]);
      assert.strictEqual((await Hh.query({ tags: ['RET'], agg: 'last', bucketMs: HOUR })).series[0].v[0], 10);
      // backfilled raw sample inside minute M (100 at M+20 s) → next run merges it: n 4, avg (1+2+4+100)/4 = 26.75,
      // max 100, last stays 4 (its time M+45 s is later than M+20 s)
      await Hh.importFile('time_utc,epoch_ms,tag,value,quality\r\n,' + (M + 20000) + ',RET,100,good\r\n', { name: 'bf.csv' });
      await Hh._internal.runRetention();
      const m = await Hh.query({ tags: ['RET'], from: M, to: M + 59999, agg: 'avg', bucketMs: MIN });
      assert.near(m.series[0].v[0], 26.75, 1e-12);
      assert.deepStrictEqual([m.series[0].n[0], m.series[0].max[0]], [4, 100]);
      assert.strictEqual((await Hh.query({ tags: ['RET'], from: M, to: M + 59999, agg: 'last', bucketMs: MIN })).series[0].v[0], 4);
      assert.strictEqual((await Hh.stats()).samples, 1, 'backfilled raw row rolled up');
      await assert.rejects(Hh.setRetention({ maxRows: 50 }), /at least 1,000/);
      await assert.rejects(Hh.setRetention({ days: -1 }), /whole number/);
      await settle(app);
    },
  },
  {
    name: 'HIST row cap: the oldest raw rows go first (proportional cut on a minute boundary)',
    wp: WP,
    async run(app, assert) {
      const Hh = H(app);
      await Hh.setRetention({ days: 0, downsampleAfterDays: 0, maxRows: 1000 });
      const s = [];
      for (let i = 0; i < 1500; i++) s.push({ tag: 'CAP', t: T0 - 1499000 + i * 1000, v: i });
      Hh.record(s);
      await Hh.flush();
      // 1500 > 1000: aim 900 → excess 600 → cut = first + 1499 s × 600/1500 = T0 − 899.4 s → minute floor T0 − 900 s
      // → rows T0 − 900 s … T0 stay: 901 (hand count)
      const st = await Hh.stats();
      assert.strictEqual(st.samples, 901);
      assert.strictEqual(st.first, T0 - 900000);
      assert.strictEqual(st.effectiveMaxRows, 1000);
      await settle(app);
    },
  },
  {
    name: 'HIST spool: home engine unavailable → IndexedDB, merged into home when it opens again',
    wp: WP,
    timeoutMs: 120000,
    async run(app, assert) {
      const idb = useIdb(app);
      useLibs(app);
      H(app).record([{ tag: 'S', t: T0 - 5000, v: 1 }]);
      await H(app).flush();
      assert.strictEqual(H(app).status().engine, 'sqljs', 'auto: no Worker → sql.js');
      assert.strictEqual(app.storage.getItem('wtshist_home'), 'sqljs', 'home remembered');
      await H(app).persist();
      const a2 = app.reload();
      try {
        useIdb(a2, idb); useLibs(a2, { offline: true });
        a2.win.WTS_historian.record([{ tag: 'S', t: T0 - 4000, v: 2 }]);
        await H(a2).flush();
        const st = H(a2).status();
        assert.deepStrictEqual([st.engine, st.spoolFor], ['idb', 'sqljs'], 'spooling to IndexedDB');
        assert.strictEqual(idb.dump()['wts-historian'].samples, 1);
      } finally { a2.dispose(); }
      const a3 = app.reload();
      try {
        useIdb(a3, idb); useLibs(a3);
        const r = await H(a3).query({ tags: ['S'] });
        assert.strictEqual(H(a3).status().engine, 'sqljs');
        assert.deepStrictEqual(arr(r.series[0].v), [1, 2], 'spooled sample merged');
        assert.strictEqual(idb.dump()['wts-historian'].samples, 0, 'spool emptied');
        assert.ok(H(a3).status().notes.some((n) => /Merged 1 samples/.test(n)));
      } finally { a3.dispose(); }
    },
  },
  {
    name: 'HIST sql.js: one owning tab (Web Locks) — a second tab spools; hiding the page saves the file at once',
    wp: WP,
    timeoutMs: 120000,
    async run(app, assert) {
      // Web Locks stand-in shared by the "tabs" (ifAvailable semantics; released when the callback's promise settles)
      const held = new Set();
      const locks = { request(name, opts, cb) {
        if (held.has(name)) return Promise.resolve(cb(null));
        held.add(name);
        return Promise.resolve(cb({ name })).then((r) => { held.delete(name); return r; });
      } };
      const idb = useIdb(app); useLibs(app); app.win.navigator.locks = locks;
      setEngine(app, 'sqljs');
      H(app).record([{ tag: 'L', t: T0 - 3000, v: 1 }]);
      await H(app).flush();
      assert.strictEqual(H(app).status().engine, 'sqljs');
      assert.ok(held.has('wts-historian-sqljs'), 'lock held');
      // hidden → saved without waiting for the 8-s timer
      Object.defineProperty(app.document, 'visibilityState', { value: 'hidden', configurable: true });
      app.fire('document', 'visibilitychange');
      await settle(app, 400);
      assert.strictEqual(idb.dump()['wts-historian-sqljs'].files, 1, 'snapshot written on hide');
      const tab2 = app.reload();
      try {
        useIdb(tab2, idb); useLibs(tab2); tab2.win.navigator.locks = locks;
        H(tab2).record([{ tag: 'L', t: T0 - 2000, v: 2 }]);
        await H(tab2).flush();
        const st = H(tab2).status();
        assert.deepStrictEqual([st.engine, st.spoolFor], ['idb', 'sqljs']);
        assert.ok(/open in another tab/.test(st.reasons[0]), st.reasons[0]);
      } finally { tab2.dispose(); }
      await H(app)._internal.E.store.close();                // the first tab goes away → lock released
      assert.ok(!held.has('wts-historian-sqljs'), 'lock released');
      const tab3 = app.reload();
      try {
        useIdb(tab3, idb); useLibs(tab3); tab3.win.navigator.locks = locks;
        const r = await H(tab3).query({ tags: ['L'] });
        assert.strictEqual(H(tab3).status().engine, 'sqljs');
        assert.deepStrictEqual(arr(r.series[0].v), [1, 2], 'saved sample + merged spool');
      } finally { tab3.dispose(); }
    },
  },
  {
    name: 'HIST engine switch moves the data (memory → IndexedDB) and becomes home',
    wp: WP,
    async run(app, assert) {
      const Hh = H(app);
      Hh.record([{ tag: 'E', t: T0 - 1000, v: 5 }, { tag: 'E', t: T0, v: 6 }]);
      await Hh.flush();
      assert.strictEqual(Hh.status().engine, 'memory');
      const idb = useIdb(app);
      const r = await Hh.switchEngine('idb');
      assert.deepStrictEqual([r.engine, r.from, r.moved], ['idb', 'memory', 2]);
      assert.strictEqual(idb.dump()['wts-historian'].samples, 2);
      assert.strictEqual(app.storage.getItem('wtshist_home'), 'idb');
      assert.deepStrictEqual(arr((await Hh.query({ tags: ['E'] })).series[0].v), [5, 6]);
      await settle(app);
    },
  },
  {
    name: 'HIST page: status, tags, trend (lanes, zoom, pan, cursor, PNG), table (paging, sort, filter), report capture, no timers left',
    wp: WP,
    async run(app, assert) {
      const Hh = H(app), s = [];
      for (let k = 0; k <= 180; k++) {
        s.push({ tag: 'PT-101', unit: 'psig', device: 'rtu1', t: T0 - 1800000 + k * 10000, v: 1000 + k, q: 'good' });
        s.push({ tag: 'TT-101', unit: 'degF', device: 'rtu1', t: T0 - 1800000 + k * 10000, v: 60 + (k % 5) });
      }
      Hh.record(s);
      await Hh.flush();
      app.hook.nav('historian');
      await settle(app);
      assert.ok(/Memory only/.test(app.el('hist_status').textContent), 'engine shown');
      const rv = (label) => { const row = app.findAll('#hist_summary .rrow').find((r) => r.querySelector('.rl').textContent === label); return row && row.querySelector('.rv').textContent; };
      assert.strictEqual(rv('Raw samples'), '362');
      assert.strictEqual(rv('Tags'), '2');
      const chips = app.findAll('#hist_tagpick [data-tag]');
      assert.deepStrictEqual(chips.map((c) => c.getAttribute('aria-pressed')), ['true', 'true'], 'both tags auto-selected');
      const texts = app.canvasTexts('hist_cv');
      assert.ok(texts.indexOf('psig') !== -1 && texts.indexOf('degF') !== -1, 'one lane per unit: ' + texts.join('|'));
      assert.ok(app.canvasLog('hist_cv', 'lineTo').length > 300, 'lines drawn');
      assert.ok(/PT-101/.test(app.el('hist_legend').textContent) && /TT-101/.test(app.el('hist_legend').textContent), 'legend');
      // table: 181 time-aligned rows, 100 a page, newest first
      assert.strictEqual(app.findAll('#hist_table tbody tr').length, 100);
      assert.ok(/Rows 1–100 of 181/.test(app.el('hist_pageinfo').textContent), app.el('hist_pageinfo').textContent);
      const firstCells = app.findAll('#hist_table tbody tr')[0].querySelectorAll('td');
      assert.strictEqual(firstCells[1].textContent, '1180'); assert.strictEqual(firstCells[2].textContent, '60');
      app.click('hist_next_btn');
      assert.strictEqual(app.findAll('#hist_table tbody tr').length, 81);
      app.click('hist_sort_btn');
      assert.strictEqual(app.findAll('#hist_table tbody tr')[0].querySelectorAll('td')[1].textContent, '1000', 'oldest first after sort');
      app.change(app.find('#hist_root [data-h="tq"]'), 'issues');
      await settle(app);
      assert.ok(/No rows/.test(app.el('hist_table_wrap').textContent), 'no stale / bad rows');
      app.change(app.find('#hist_root [data-h="tq"]'), 'all');
      app.change(app.find('#hist_root [data-h="tmode"]'), 'avg');
      app.change(app.find('#hist_root [data-h="tbucket"]'), '300000');
      await settle(app);
      // 1-h view (T0 − 1 h … T0) holds data from T0 − 30 min: 5-min buckets T0−30 … T0 → 7 buckets
      assert.strictEqual(app.findAll('#hist_table tbody tr').length, 7);
      // copy
      app.click('hist_copy_btn');
      await settle(app);
      assert.ok(/^time_local\tPT-101 \[psig\]\tTT-101 \[degF\]\n/.test(app.clipboard), 'TSV on the clipboard');
      // zoom (live keeps the right edge on now), pan, cursor
      const V = Hh._internal.V, cv = app.el('hist_cv'), W = app.win;
      const span0 = V.to - V.from, to0 = V.to;
      cv.dispatchEvent(new W.WheelEvent('wheel', { deltaY: -300, clientX: 450, bubbles: true, cancelable: true }));
      assert.near(V.to - V.from, Math.round(span0 * Math.exp(-0.45)), 1, 'wheel zoom ×e^(−300·0.0015)');
      assert.strictEqual(V.to, to0); assert.strictEqual(V.live, true);
      const f0 = V.from, sp = V.to - V.from;
      cv.dispatchEvent(new W.PointerEvent('pointerdown', { clientX: 300, pointerId: 1, bubbles: true }));
      cv.dispatchEvent(new W.PointerEvent('pointermove', { clientX: 400, pointerId: 1, bubbles: true }));
      cv.dispatchEvent(new W.PointerEvent('pointerup', { clientX: 400, pointerId: 1, bubbles: true }));
      const pw = V.geo.plot.w;
      assert.near(V.from, f0 - Math.round(100 / pw * sp), 2, 'dragged right → earlier');
      assert.strictEqual(V.live, false, 'panning leaves live mode');
      cv.dispatchEvent(new W.PointerEvent('pointermove', { clientX: 500, pointerId: 2, bubbles: true }));
      app.flush(20);
      const cur = app.el('hist_cursor');
      assert.strictEqual(cur.style.display, 'block', 'cursor readout shown ' + JSON.stringify({ x: V.cursorX, raf: V.raf, geo: V.geo && V.geo.plot, n: V.data && V.data.series.length, tags: V.tags }));
      assert.ok(/PT-101: \d+/.test(cur.textContent) && /TT-101/.test(cur.textContent), cur.textContent);
      // pinch: fingers 200 → 400 px apart → the span halves; the time under the first midpoint follows the fingers
      const P = V.geo.plot, pf = V.from, pspan = V.to - V.from;
      const touch = (type, id, x) => cv.dispatchEvent(new W.PointerEvent(type, { clientX: x, pointerId: id, pointerType: 'touch', bubbles: true }));
      touch('pointerdown', 11, P.x + 100); touch('pointerdown', 12, P.x + 300); touch('pointermove', 12, P.x + 500);
      const ns = pspan * 200 / 400, tc = pf + 200 / P.w * pspan;          // midpoint was P.x + 200, is now P.x + 300
      assert.near(V.to - V.from, ns, 2, 'pinch zoom');
      assert.near(V.from, tc - 300 / P.w * ns, 2, 'pinch keeps the time under the fingers');
      touch('pointerup', 12, P.x + 500); touch('pointerup', 11, P.x + 100);
      // keyboard: ← pans by 10 % of the span
      const kf = V.from, ks = V.to - V.from;
      app.key(cv, 'ArrowLeft');
      assert.near(V.from, kf - 0.1 * ks, 1, 'arrow-key pan');
      const n0 = app.downloads.length;
      app.click('hist_png_btn');
      assert.ok(app.downloads[n0] && /\.png$/.test(app.downloads[n0].filename), 'PNG download');
      // live refresh on new data
      app.click('hist_live_btn');
      assert.strictEqual(V.live, true);
      app.flush(60000);                                    // time passes
      Hh.record({ tag: 'PT-101', t: T0 + 60000, v: 1200 });
      await Hh.flush();
      await settle(app);
      assert.ok(V.to >= T0 + 60000, 'live window follows new data');
      assert.ok(V.data.series[0].t.indexOf(T0 + 60000) !== -1, 'new sample on the trend');
      // report capture + PDF
      cv.__h2oilSnapshot = () => 'data:image/png;base64,AAAA';   // the harness canvas has no pixels; real browsers read them
      const model = app.win.collectPageReport(app.el('pgBody'), { charts: true });
      const titles = model.results.map((x) => x.title), inputs = model.inputs.map((x) => x.title);
      assert.ok(titles.indexOf('Historian summary') !== -1 && titles.indexOf('Tag logging status') !== -1, titles.join('|'));
      assert.ok(inputs.indexOf('Trend') !== -1 && inputs.indexOf('Storage and retention') !== -1, inputs.join('|'));
      const trend = model.inputs.find((x) => x.title === 'Trend');
      assert.ok(trend.items.some((i) => i.type === 'chart'), 'trend chart captured');
      const tagTbl = model.results.find((x) => x.title === 'Tag logging status').items.find((i) => i.type === 'table');
      assert.strictEqual(tagTbl.rows.length, 2);
      const o0 = app.opened.length;
      app.win.exportPagePDF();
      const pdf = app.opened[o0] && app.opened[o0].html();
      assert.ok(pdf && pdf.indexOf('Historian') !== -1 && pdf.indexOf('Tag logging status') !== -1, 'PDF');
      await settle(app);
      assert.strictEqual(app.pendingTimers(), 0, 'no timers left when idle');
    },
  },
  {
    name: 'HIST page at 375 px: renders, no wide fixed widths, sidebar button and dashboard tile',
    wp: WP,
    opts: { viewport: { width: 375, height: 812 }, layout: { width: 343, height: 420 } },
    async run(app, assert) {
      H(app).record([{ tag: 'P', unit: 'psig', t: T0 - 1000, v: 1 }, { tag: 'P', unit: 'psig', t: T0, v: 2 }]);
      await H(app).flush();
      const b = app.find('.nav-btn[data-p="historian"]');
      assert.ok(b && b.closest('#sidebar'), 'button in the mobile sidebar');
      app.click(b);
      await settle(app);
      const html = app.el('pgBody').innerHTML;
      assert.ok(!/width:\s*[4-9]\d\dpx|width:\s*\d{4,}px/.test(html), 'no fixed widths above 340 px');
      const cv = app.el('hist_cv');
      assert.strictEqual(cv.width, 343 - 12, 'canvas follows the container width (minus the 6-px padding)');
      assert.strictEqual(cv.height, 260, 'shorter chart on a phone');
      assert.ok(app.findAll('#hist_table tbody tr').length === 2, 'table rows');
      assert.ok(/\.hist \.fg\{grid-template-columns:1fr\}/.test(app.el('hist_css').textContent), 'single-column form on phones');
      app.hook.nav('home');
      const titles = app.findAll('.dash-card').map((c) => String(c.querySelector('h3').textContent).trim());
      assert.ok(titles.indexOf('Historian') !== -1);
      await settle(app);
      assert.strictEqual(app.pendingTimers(), 0);
    },
  },
  {
    name: 'HIST without Modbus: "Log form data" (wts:calc + live simulator) and the demo generators',
    wp: WP,
    async run(app, assert) {
      const Hh = H(app);
      app.hook.nav('historian');
      await settle(app);
      const cb = app.find('#hist_root [data-h="logform"]');
      app.win.WTS_state = app.win.WTS_state || {};
      app.win.WTS_state.sim = { running: true, rates: { gas_mmscfd: 9.5, oil_stbd: 1200, water_bpd: 40, gor: 7900, bsw_pct: 3.2 }, cum: { oil_stb: 12, gas_mmscf: 0.1 } };
      app.check(cb, true);
      app.fire('document', 'wts:calc', { inputs: { Pwh: 3000, Twh: 180, Qg: 10, Qo: 1000, Qw: 50, bean: 32, Psep: 150 }, choke: { Pin: 2990, Pout: 520 }, heater: { Tout: 150 } });
      app.flush(5000);                                    // one simulator sample
      await Hh.flush();
      const q = await Hh.query({ tags: ['FORM.WHP', 'FORM.CHOKE_DP', 'FORM.QG', 'SIM.QG', 'SIM.BSW'] });
      assert.deepStrictEqual(plain(q.series.map((s) => s.v[s.v.length - 1])), [3000, 2470, 10, 9.5, 3.2]);
      assert.deepStrictEqual(plain(q.series.map((s) => s.unit)), ['psig', 'psi', 'MMscf/d', 'MMscf/d', '%']);
      app.check(cb, false);
      await settle(app);
      assert.strictEqual(app.pendingTimers(), 0, 'form sampler stopped');
      // demo: 24 h at 10 s → 8641 time steps × 4 tags
      assert.strictEqual(await Hh.demo.history(24, 10000), 34564);
      const nowD = app.win.Date.now();
      Hh.demo.start();
      app.flush(3000);
      await Hh.flush();
      Hh.demo.stop();
      const d = await Hh.query({ tags: ['DEMO.WHP'], from: nowD + 1, to: nowD + 10000 });
      assert.ok(d.series[0].t.length >= 3, 'live demo samples');
      const lt = await Hh.listTags();
      assert.ok(lt.filter((x) => /^DEMO\./.test(x.tag)).every((x) => x.source === 'demo'));
      await settle(app);
      assert.strictEqual(app.pendingTimers(), 0);
    },
  },
  {
    name: 'HIST offline: sw.js routes and precaches the pinned SQLite URLs; iOS bundle = pinned bytes, copied by the sync script',
    wp: WP,
    opts: false,
    timeoutMs: 120000,
    run(app, assert, ctx) {
      const probe = ctx.loadApp();
      let pins, libs;
      try { pins = probe.win.WTS_historian.SHA384; libs = probe.win.WTS_historian.LIBS; } finally { probe.dispose(); }
      const sha = (b) => crypto.createHash('sha384').update(b).digest('base64');
      assert.deepStrictEqual(Object.keys(pins).sort(), ['sql-wasm.js', 'sql-wasm.wasm', 'sqlite3.mjs', 'sqlite3.wasm']);
      Object.keys(pins).forEach((f) => {
        const b = fs.readFileSync(path.join(LIBDIR, f));
        assert.strictEqual(sha(b), pins[f], 'ios-additions/libs/' + f + ' = pinned SHA-384');
        assert.strictEqual(b.length, libs[f].bytes, f + ' size');
        const w = path.join(REPO, 'ios-app', 'www', f);
        assert.ok(fs.existsSync(w) && sha(fs.readFileSync(w)) === pins[f], 'committed www/' + f);
      });
      // sw.js
      const swCtx = { self: {}, caches: {}, fetch: () => Promise.reject(new Error('x')), URL, console };
      swCtx.self = swCtx; swCtx.self.addEventListener = () => {}; swCtx.self.location = { href: 'https://wts.example/app/sw.js' };
      swCtx.self.registration = { scope: 'https://wts.example/app/' };
      vm.createContext(swCtx);
      vm.runInContext(fs.readFileSync(path.join(REPO, 'sw.js'), 'utf8'), swCtx);
      const SW = swCtx.self.WTS_SW, src = fs.readFileSync(path.join(REPO, 'sw.js'), 'utf8');
      Object.keys(libs).forEach((f) => libs[f].urls.forEach((u) => {
        assert.ok(SW.CDN_LIBS.indexOf(u) !== -1, 'sw.js knows ' + u);
        assert.strictEqual(SW.route({ method: 'GET', url: u, mode: 'cors', headers: { get: () => null } }).kind, 'lib', u);
      }));
      const pre = /var PRECACHE_LIBS = (.*);/.exec(src)[1];
      [3, 4, 5, 6].forEach((i) => assert.ok(pre.indexOf('CDN_LIBS[' + i + ']') !== -1, 'precached #' + i));
      assert.ok(/sqlite-wasm@3\.53\.4-build1\/dist\/index\.mjs/.test(SW.CDN_LIBS[3]) && /sql-wasm\.wasm$/.test(SW.CDN_LIBS[6]));
      // sync-from-main.js copies the four files and checks them
      const os = require('os'), { execFileSync } = require('child_process');
      const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-hist-sync-'));
      try {
        const log = execFileSync(process.execPath, [path.join(REPO, 'ios-app', 'scripts', 'sync-from-main.js')], { env: Object.assign({}, process.env, { WTS_SYNC_OUT_DIR: out }), encoding: 'utf8' });
        assert.ok(/historian SQLite libraries: 4 files match their pinned SHA-384/.test(log), log);
        Object.keys(pins).forEach((f) => assert.strictEqual(sha(fs.readFileSync(path.join(out, f))), pins[f], 'www/' + f));
      } finally { fs.rmSync(out, { recursive: true, force: true }); }
    },
  },
];
