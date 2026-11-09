// Accounts WP-H — host and shared-file hooks (docs/ACCOUNTS-PLAN.md §5.4 H1–H15, §12.2 acct-host).
//
//   HO1–HO3   H1  wts:ls-write from WTS_lsSet / WTS_lsRemove; {raw:true} is the plain write (throws like setItem, no eviction)
//   HO4–HO8   H2  every moved site fires wts:ls-write: a broad session (every route, PRiSM, wells, units, New) in which
//                 every raw storage write of a wts_ / h2oil_ key is matched by the event, and targeted sites
//   HO9–HO14  H3  loadFromObject source / keep / ready (build-up raw kept, IndexedDB writes awaited, no opts = as before)
//   HO15–HO18 H4  applyChanges → wts:project-changed (build-up hasRaw still true, simulator untouched, refusals, listeners)
//   HO19–HO20 H5  registerToolbarItems
//   HO21–HO23 H14 registerGuard (none = today's flow; cancel; proceed; a failing guard cancels)
//   HO24      H15 flushIfDirty
//   HO25–HO26 H13 captureWell
//   HO27–HO28 H7 / H10 navHidden, skip tables, NO_COPY
//   HO29      H6  PREF_RE
//   HO30–HO31 H12 RELEASE_NOTES platform:'web'; H8 / H9 / H11 markup and privacy branches
'use strict';

const fs = require('fs');
const path = require('path');
const { createFakeIDB } = require('./_buildup-idb-fake');
const { FIX } = require('./_buildup-shapes');

const WP = 'WP-H';
const ROOT = path.resolve(__dirname, '..', '..');
const HTML = path.join(ROOT, 'well-testing-app.html');
const PROD = { href: 'https://welltest.h2oil.co.uk/well-testing-app.html', origin: 'https://welltest.h2oil.co.uk', protocol: 'https:',
  host: 'welltest.h2oil.co.uk', hostname: 'welltest.h2oil.co.uk', port: '', pathname: '/well-testing-app.html', search: '', hash: '',
  reload() {}, assign() {}, replace() {}, toString() { return this.href; } };

// A plain storage (the harness one is a Proxy whose property writes become items) that records every raw write and can
// refuse writes above a size limit like a full browser store.
function recStorage(limit) {
  const data = new Map(), raw = [];
  limit = limit || { n: Infinity };
  const used = () => { let n = 0; for (const [k, v] of data) n += k.length + v.length; return n; };
  return {
    raw, limit, used,
    getItem: (k) => (data.has(String(k)) ? data.get(String(k)) : null),
    setItem(k, v) {
      k = String(k); v = String(v);
      const prev = data.has(k) ? k.length + data.get(k).length : 0;
      if (used() - prev + k.length + v.length > limit.n) { const e = new Error('quota'); e.name = 'QuotaExceededError'; e.code = 22; throw e; }
      data.set(k, v);
      raw.push({ key: k, removed: false });
    },
    removeItem(k) { k = String(k); const had = data.has(k); data.delete(k); raw.push({ key: k, removed: true, had }); },
    clear: () => data.clear(),
    key: (i) => Array.from(data.keys())[i] ?? null,
    get length() { return data.size; },
  };
}
// Collect wts:ls-write events (and, with a recStorage, the raw writes).
function watch(app, rec) {
  const ev = [];
  const raw = rec ? rec.raw : [];
  app.document.addEventListener('wts:ls-write', (e) => ev.push(Object.assign({}, e.detail)));
  return {
    ev, raw,
    keys: () => ev.map((e) => e.key),
    has: (k, removed) => ev.some((e) => e.key === k && !!e.removed === !!removed),
    hasPrefix: (p) => ev.some((e) => e.key.indexOf(p) === 0),
    reset: () => { ev.length = 0; raw.length = 0; },
  };
}
const PROJ_KEY = /^(wts_|h2oil_)/;
// Raw writes the scan allow-lists (simulator / DFIT workstreams, storage.write load path, the availability probe).
const RAW_OK = /^(wts_sim_|h2viz3d_|wts_prism_dfit_|wts_wts3d|__prism_ls_probe__)/;

function navAll(app) {
  const routes = Array.from(new Set(app.findAll('.nav-btn[data-p]').map((b) => b.getAttribute('data-p'))));
  return routes;
}
// An in-memory registry page with navHidden (the shape 68 registers in WP-C1).
const HIDDEN = [
  '(function () {',
  "    'use strict';",
  "    var G = (typeof window !== 'undefined') ? window : globalThis;",
  '    G.WTS_calcRegistry = G.WTS_calcRegistry || {};',
  "    G.WTS_calcRegistry.account = { key: 'account', title: 'Account', sub: 'Hidden page', group: 'Overview', icon: '&#9729;', navHidden: true,",
  "        render: function (b) { b.innerHTML = '<div id=\"acct_root\"><input id=\"acct_x\" value=\"1\"></div>'; } };",
  '})();',
  '',
  '// === SELF-TEST ===',
  '',
].join('\n');
const record = (app) => app.toWin(JSON.parse(JSON.stringify(FIX.samples.GaugeRecord)));

module.exports = [
  // ── H1 ──────────────────────────────────────────────────────────────────────────────
  {
    name: 'HO1 H1 WTS_lsSet fires wts:ls-write {key}; WTS_lsRemove fires {key, removed:true}; both return booleans', wp: WP,
    run(app, assert) {
      const w = watch(app), W = app.win;
      assert.strictEqual(typeof W.WTS_lsSet, 'function');
      assert.strictEqual(typeof W.WTS_lsRemove, 'function');
      assert.strictEqual(W.WTS_lsSet('wts_acct_test_k', 'v1'), true);
      assert.deepStrictEqual(w.ev.slice(-1)[0], { key: 'wts_acct_test_k' });
      assert.strictEqual(app.storage.getItem('wts_acct_test_k'), 'v1');
      assert.strictEqual(W.WTS_lsSet('wts_acct_test_k', 'v2', { raw: true }), true);
      assert.deepStrictEqual(w.ev.slice(-1)[0], { key: 'wts_acct_test_k' });
      assert.strictEqual(W.WTS_lsRemove('wts_acct_test_k'), true);
      assert.deepStrictEqual(w.ev.slice(-1)[0], { key: 'wts_acct_test_k', removed: true });
      assert.strictEqual(app.storage.getItem('wts_acct_test_k'), null);
      assert.strictEqual(w.ev.length, 3);
    },
  },
  {
    name: 'HO2 H1 a failed write fires no event; {raw:true} throws like setItem and never evicts report snapshots', wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const st = recStorage();
      const app = ctx.loadApp({ storage: st });
      try {
      const W = app.win;
      W.WTS_lsSet('wts_report_snapshots', JSON.stringify({ a: { title: 'A', at: '2026-01-01', results: [] }, b: { title: 'B', at: '2026-01-02', results: [] } }));
      const w = watch(app);
      st.limit.n = st.used() + 10;
      let threw = null;
      try { W.WTS_lsSet('wts_acct_big', 'x'.repeat(200), { raw: true }); } catch (e) { threw = e; }
      assert.ok(threw && threw.name === 'QuotaExceededError', 'raw write throws the quota error');
      assert.ok(JSON.parse(app.storage.getItem('wts_report_snapshots')).a, 'no snapshot evicted by a raw write');
      assert.strictEqual(w.ev.length, 0, 'no event for a failed write');
      assert.strictEqual(W.WTS_lsSet('wts_acct_big', 'x'.repeat(200)), false, 'the quota-safe write returns false');
      assert.ok(!w.has('wts_acct_big'), 'still no event for the key that did not fit');
      } finally { app.dispose(); }
    },
  },
  {
    name: 'HO3 H1 the snapshot eviction inside __lsSet fires wts:ls-write for wts_report_snapshots', wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const st = recStorage();
      const app = ctx.loadApp({ storage: st });
      try {
      const W = app.win;
      // seed the in-memory snapshot cache through a real calculation so the evictor has something to drop
      app.hook.nav('flareghg');
      const ids = app.findAll('#pgBody input[id]').filter((e) => e.type !== 'checkbox').slice(0, 1);
      if (ids.length) { app.input(ids[0], '7.5'); }
      app.flush(1200);
      const snaps = JSON.parse(app.storage.getItem('wts_report_snapshots') || '{}');
      assert.ok(Object.keys(snaps).length >= 1, 'a snapshot was captured: ' + Object.keys(snaps).join(','));
      const w = watch(app);
      st.limit.n = st.used() + 5;
      const r = W.WTS_lsSet('wts_acct_big2', 'y'.repeat(JSON.stringify(snaps).length - 10));
      assert.ok(w.has('wts_report_snapshots') || w.has('wts_report_snapshots', true), 'eviction announced');
      assert.strictEqual(typeof r, 'boolean');
      } finally { app.dispose(); }
    },
  },
  // ── H2 ──────────────────────────────────────────────────────────────────────────────
  {
    name: 'HO4 H2 a broad session (every route, PRiSM, wells, units, decimal comma, New): every raw wts_ / h2oil_ write has its event', wp: WP,
    integration: true,
    opts: false,
    run(_a, assert, ctx) {
      const st = recStorage();
      const app = ctx.loadApp({ storage: st });
      try {
      const W = app.win;
      const w = watch(app, st);
      const routes = navAll(app);
      assert.ok(routes.length > 40, routes.length + ' routes');
      for (const r of routes) {
        if (r === 'wts') continue;   // the simulator page writes its own keys (31 / 32 / 38 allow-listed)
        try { app.hook.nav(r); } catch (e) { continue; }
        const el = app.findAll('#pgBody input[id]').find((e) => e.type !== 'checkbox' && e.type !== 'file' && !e.disabled);
        if (el) { try { app.input(el, '3'); } catch (e) { /* a page handler may throw on odd input; not under test */ } }
        app.flush(400);
      }
      app.openPRiSM(); app.seedSample();
      try { W.PRiSM_setWell(app.toWin({ q: 800, h: 40 }), app.toWin({ source: 'user' })); } catch (e) { /* optional */ }
      for (let n = 1; n <= 7; n++) { try { app.renderTab(n); } catch (e) { /* not under test */ } }
      app.flush(2000);
      W.WTS_units.setSystem('metric'); W.WTS_units.setSystem('imperial');
      if (W.WTS_a11y) { W.WTS_a11y.decimalComma(true); W.WTS_a11y.decimalComma(false); }
      if (W.WTS_baseConditions) { W.WTS_baseConditions.set('60F_14.65'); W.WTS_baseConditions.set('calc'); }
      const c = W.WTS_wells.create('B'); assert.ok(c.ok, 'well created');
      W.WTS_wells.switchTo(W.WTS_wells.list()[0].id);
      W.WTS_wells.remove(W.WTS_wells.list()[1].id);
      W.WTS_project['new']();
      app.flush(2000);
      const evKeys = new Set(w.ev.map((e) => e.key + (e.removed ? '#rm' : '')));
      const miss = [];
      for (const r of w.raw) {
        if (!PROJ_KEY.test(r.key) || RAW_OK.test(r.key)) continue;
        if (r.removed && !r.had) continue;     // removing a missing key changes nothing
        const id = r.key + (r.removed ? '#rm' : '');
        if (!evKeys.has(id)) miss.push(id);
      }
      assert.deepStrictEqual(Array.from(new Set(miss)), [], 'raw writes without wts:ls-write');
      assert.ok(w.ev.length > 50, w.ev.length + ' events');
      for (const k of ['wts_unit_system', 'wts_base_conditions', 'wts_prism_state', 'wts_prism_pvt', 'wts_wells']) {
        assert.ok(w.has(k), 'event for ' + k);
      }
      assert.ok(w.hasPrefix('wts_page_'), 'page autosave');
      assert.ok(w.ev.some((e) => e.removed), 'New removes keys with events');
      } finally { app.dispose(); }
    },
  },
  {
    name: 'HO5 H2 host sites: favourite toggle, nav group, hub member, client-info clear, flare legacy list', wp: WP,
    run(app, assert) {
      const W = app.win;
      const w = watch(app);
      app.hook.nav('home');
      const fav = app.find('.dc-fav[data-fav]');
      assert.ok(fav, 'favourite star');
      app.click(fav);
      assert.ok(w.has('wts_ui_favs'), 'favourites list');
      app.hook.nav('esdhi');
      assert.ok(w.has('wts_ui_nav_open') || w.has('wts_ui_hub_last'), 'nav prefs');
      W.WTS_lsSet('h2oil_client_info', JSON.stringify({ client: 'Operator Energy Ltd' }));
      w.reset();
      W.clearClientInfo();
      assert.ok(w.has('h2oil_client_info', true), 'client info cleared with an event');
      w.reset();
      W.WTS_lsSet('wts_flare', JSON.stringify({ fl_V: '1', fl_q: '2' }));
      w.reset();
      app.hook.nav('flare');
      assert.ok(w.has('wts_flare'), 'legacy flare list rewritten with an event');
    },
  },
  {
    name: 'HO6 H2 PRiSM sites: data paste, sample suppress, multi-rate, presets, report notes, state, PVT', wp: WP,
    integration: true,
    run(app, assert) {
      const W = app.win;
      app.openPRiSM(); app.seedSample(); app.flush(500);
      const w = watch(app);
      if (typeof W.PRiSM_saveState === 'function') W.PRiSM_saveState();
      assert.ok(w.has('wts_prism_state'), '33 state');
      W.PRiSM_setWell(app.toWin({ q: 812 }), app.toWin({ source: 'user' }));
      app.flush(1500);
      assert.ok(w.has('wts_prism_pvt'), '16 / 37 PVT store');
      if (W.PRiSM && Array.isArray(W.PRiSM.multiRate)) {
        W.PRiSM.multiRate = app.toWin([{ t: 0, q: 500 }, { t: 10, q: 0 }]);
        const mr = W.PRiSM_fieldTools && W.PRiSM_fieldTools.persistMultiRate;
        if (typeof W.PRiSM_persistMultiRate === 'function') W.PRiSM_persistMultiRate();
        else if (typeof mr === 'function') mr(W.PRiSM.multiRate);
      }
      app.renderTab(7); app.flush(200);
      const notes = app.el('prism_report_notes');
      if (notes) { notes.value = 'note'; notes.oninput(); assert.ok(w.has('wts_prism_report_notes'), '36 report notes'); }
      if (typeof W.PRiSM_clearData === 'function') { try { W.PRiSM_clearData(); } catch (e) { /* optional */ } }
      const evs = w.keys();
      assert.ok(evs.some((k) => /^wts_prism/.test(k)), 'PRiSM keys announced: ' + Array.from(new Set(evs)).join(', '));
    },
  },
  {
    name: 'HO7 H2 wells: create / switch / remove announce the parked blobs, the list and the mid-switch writes', wp: WP,
    run(app, assert) {
      const W = app.win;
      app.hook.nav('flareghg');
      const el = app.findAll('#pgBody input[id]').find((e) => e.type !== 'checkbox');
      if (el) app.input(el, '7.5');
      app.flush(400);
      const w = watch(app);
      const a = W.WTS_wells.active();
      assert.ok(W.WTS_wells.create('Second').ok);
      assert.ok(w.has('wts_well_' + a), 'parked blob written');
      assert.ok(w.has('wts_wells'), 'well list');
      assert.ok(w.has('h2oil_client_info'), 'new well client info (mid-switch raw write announced)');
      const b = W.WTS_wells.active();
      w.reset();
      assert.ok(W.WTS_wells.switchTo(a).ok);
      assert.ok(w.has('wts_well_' + a, true), 'target blob removed with an event');
      assert.ok(w.has('wts_well_' + b), 'previous well parked');
      w.reset();
      assert.ok(W.WTS_wells.remove(b).ok);
      assert.ok(w.has('wts_well_' + b, true), 'removed well blob');
    },
  },
  {
    name: 'HO8 H2 other modules: Modbus config, Mini WellOS view, help preference, build-up state, decimal comma, base conditions', wp: WP,
    run(app, assert) {
      const W = app.win;
      const w = watch(app);
      if (W.WTS_modbus && typeof W.WTS_modbus.saveConfig === 'function') {
        const r = W.WTS_modbus.saveConfig(W.WTS_modbus.getConfig(), { keepStation: true });
        assert.ok(r && r.ok !== false, 'saveConfig ok');
        assert.ok(w.ev.some((e) => /modbus/.test(e.key)), '61 modbus config announced: ' + w.keys().join(','));
      }
      W.WTS_a11y.decimalComma(true);
      assert.ok(w.ev.some((e) => !e.removed && /decimal|comma|a11y/i.test(e.key)), '50 decimal comma on');
      W.WTS_a11y.decimalComma(false);
      assert.ok(w.ev.some((e) => e.removed && /decimal|comma|a11y/i.test(e.key)), '50 decimal comma off');
      W.WTS_baseConditions.set('60F_14.73');
      assert.ok(w.has('wts_base_conditions'), '22 base conditions');
      W.WTS_baseConditions.set('calc');
      if (W.WTS_buildup && W.WTS_buildup.store && typeof W.WTS_buildup.store.saveState === 'function') {
        const r = W.WTS_buildup.store.saveState(app.toWin({ v: 1, input: null, analysis: null, review: null, qa: [], uiSel: {}, signoff: null }));
        assert.ok(r && r.ok, 'state saved');
        assert.ok(w.has(W.WTS_buildup.store.STATE_KEY), '49-calc-buildup-store state announced');
      }
      app.hook.nav('wellos'); app.flush(100);
      app.hook.nav('pipelife'); app.flush(100);
      if (typeof W.calcPipeLife === 'function') { try { W.calcPipeLife(); } catch (e) { /* optional */ } }
      assert.ok(w.ev.length > 3, 'events: ' + Array.from(new Set(w.keys())).join(', '));
    },
  },
  // ── H3 ──────────────────────────────────────────────────────────────────────────────
  {
    name: 'HO9 H3 loadFromObject without opts: same result shape plus `ready`; the event detail is {loaded, skipped, pending}', wp: WP,
    async run(app, assert) {
      const P = app.win.WTS_project;
      let detail = null;
      app.document.addEventListener('wts:project-loaded', (e) => { detail = e.detail; });
      const pay = P._buildPayload();
      const r = P.loadFromObject(pay);
      assert.ok(Array.isArray(r.loaded) && r.loaded.length > 0 && r.error === null);
      assert.ok(!('kept' in r), 'no keep → no kept field');
      assert.ok(r.ready && typeof r.ready.then === 'function', 'ready is a Promise');
      assert.strictEqual(await r.ready, true);
      assert.deepStrictEqual(Object.keys(detail).sort(), ['loaded', 'pending', 'skipped']);
      assert.ok(!('source' in detail) && !('keep' in detail));
    },
  },
  {
    name: 'HO10 H3 opts.source reaches the wts:project-loaded detail', wp: WP,
    run(app, assert) {
      const P = app.win.WTS_project;
      let detail = null;
      app.document.addEventListener('wts:project-loaded', (e) => { detail = e.detail; });
      P.loadFromObject(P._buildPayload(), app.toWin({ source: 'cloud' }));
      assert.strictEqual(detail.source, 'cloud');
    },
  },
  {
    name: 'HO11 H3 opts.keep:[storage] leaves every local project key untouched and is reported as kept', wp: WP,
    run(app, assert) {
      const W = app.win, P = W.WTS_project;
      W.WTS_lsSet('wts_page_flareghg', JSON.stringify({ v: 1, t: 1, f: { fe_qg: 'LOCAL' } }));
      const pay = P._buildPayload();
      pay.modules.storage = { keys: { wts_page_flareghg: JSON.stringify({ v: 1, t: 2, f: { fe_qg: 'FILE' } }), wts_page_choke: '{"v":1,"f":{}}' }, skipped: [] };
      let detail = null;
      app.document.addEventListener('wts:project-loaded', (e) => { detail = e.detail; });
      const r = P.loadFromObject(app.toWin(pay), app.toWin({ keep: ['storage'], source: 'cloud' }));
      assert.ok(r.loaded.indexOf('storage') === -1 && r.kept.indexOf('storage') !== -1);
      assert.strictEqual(JSON.parse(app.storage.getItem('wts_page_flareghg')).f.fe_qg, 'LOCAL');
      assert.strictEqual(app.storage.getItem('wts_page_choke'), null);
      assert.deepStrictEqual(Array.from(detail.keep), ['storage']);
      // the same load without keep replaces the keys (today's behaviour)
      P.loadFromObject(app.toWin(pay));
      assert.strictEqual(JSON.parse(app.storage.getItem('wts_page_flareghg')).f.fe_qg, 'FILE');
    },
  },
  {
    name: 'HO12 H3 keep:[buildup_raw] — the build-up store is not pruned (hasRaw stays true); without keep it is (today)', wp: WP,
    async run(app, assert) {
      const W = app.win, P = W.WTS_project, S = W.WTS_buildup.store;
      const idb = createFakeIDB();
      W.indexedDB = idb.indexedDB;
      await S.init();
      const wid = S.wellId();
      await S.putRaw(wid, record(app));
      assert.ok(S.hasRaw(wid));
      const pay = P._buildPayload();
      delete pay.modules.buildup_raw;
      const r = P.loadFromObject(app.toWin(pay), app.toWin({ keep: ['buildup_raw'] }));
      await r.ready;
      assert.ok(S.hasRaw(wid), 'kept → still there');
      const r2 = P.loadFromObject(app.toWin(pay));
      await r2.ready;
      assert.ok(!S.hasRaw(wid), 'no keep → pruned (unchanged behaviour)');
      assert.deepStrictEqual(idb.keys('wts_buildup', 'raw'), [], 'IndexedDB pruned before ready resolved');
    },
  },
  {
    name: 'HO13 H3 `ready` waits for the build-up IndexedDB module writes (buildup_raw / buildup_analysis)', wp: WP,
    async run(app, assert) {
      const W = app.win, P = W.WTS_project, S = W.WTS_buildup.store;
      const idb = createFakeIDB();
      W.indexedDB = idb.indexedDB;
      await S.init();
      const enc = S.encode(record(app));
      const wid = S.wellId();
      const pay = P._buildPayload();
      pay.modules.buildup_raw = { wells: { [wid]: JSON.parse(JSON.stringify(enc)) }, omitted: [] };
      pay.modules.buildup_analysis = { wells: { [wid]: { B1: { spec: { dt: [0.1], p: [1] }, result: { id: 'B1' } } } }, omitted: [] };
      const r = P.loadFromObject(app.toWin(pay));
      await r.ready;
      assert.deepStrictEqual(idb.keys('wts_buildup', 'raw'), [wid], 'raw record in IndexedDB once ready resolved');
      assert.deepStrictEqual(idb.keys('wts_buildup', 'tests'), [wid], 'tests record in IndexedDB once ready resolved');
    },
  },
  {
    name: 'HO14 H3 the gauge module (19) write returns its Promise; keep:[prism_gauges] never calls it', wp: WP,
    async run(app, assert) {
      const W = app.win, P = W.WTS_project;
      const M = P._internals.modules();
      assert.ok(M.prism_gauges, 'prism_gauges registered');
      const w = M.prism_gauges.write(app.toWin({ activeAnalysisId: null, gaugeData: [], analysisData: [] }));
      assert.ok(w && typeof w.then === 'function', 'write → Promise');
      await w;
      let called = 0;
      const orig = M.prism_gauges.write;
      M.prism_gauges.write = function () { called++; return orig.apply(this, arguments); };
      try {
        const pay = P._buildPayload();
        pay.modules.prism_gauges = { activeAnalysisId: null, gaugeData: [], analysisData: [] };
        const r = P.loadFromObject(app.toWin(pay), app.toWin({ keep: ['prism_gauges'] }));
        await r.ready;
        assert.strictEqual(called, 0, 'kept module not written');
        assert.ok(r.kept.indexOf('prism_gauges') !== -1);
        const r2 = P.loadFromObject(app.toWin(pay));
        await r2.ready;
        assert.strictEqual(called, 1, 'written without keep');
      } finally { M.prism_gauges.write = orig; }
    },
  },
  // ── H4 ──────────────────────────────────────────────────────────────────────────────
  {
    name: 'HO15 H4 applyChanges writes / removes keys, fires wts:project-changed (never project-loaded), re-renders the open page', wp: WP,
    run(app, assert) {
      const W = app.win, P = W.WTS_project;
      app.hook.nav('flareghg');
      const el = app.findAll('#pgBody input[id]').find((e) => e.type !== 'checkbox');
      const id = el.id;
      W.WTS_lsSet('wts_page_choke', '{"v":1,"f":{}}');
      const evs = [];
      app.document.addEventListener('wts:project-changed', (e) => evs.push(e.detail));
      let loaded = 0;
      app.document.addEventListener('wts:project-loaded', () => loaded++);
      const rec = JSON.stringify({ v: 1, t: 5, f: { [id]: '9.25' } });
      const r = P.applyChanges(app.toWin({ set: { wts_page_flareghg: rec }, remove: ['wts_page_choke'] }), app.toWin({ source: 'cloud' }));
      assert.deepStrictEqual(Array.from(r.applied).sort(), ['wts_page_choke', 'wts_page_flareghg']);
      assert.strictEqual(loaded, 0, 'no wts:project-loaded');
      assert.strictEqual(evs.length, 1);
      assert.strictEqual(evs[0].source, 'cloud');
      assert.deepStrictEqual(Array.from(evs[0].keys).sort(), ['wts_page_choke', 'wts_page_flareghg']);
      assert.strictEqual(app.storage.getItem('wts_page_choke'), null);
      assert.strictEqual(app.el(id).value, '9.25', 'open page re-rendered from the applied record');
    },
  },
  {
    name: 'HO16 H4 applyChanges refuses library keys, device preferences, well blobs and unknown modules', wp: WP,
    run(app, assert) {
      const W = app.win, P = W.WTS_project;
      const r = P.applyChanges(app.toWin({ set: { wts_prism_user_curves: '{}', wts_unit_system: 'metric', wts_ui_favs: '[]', wts_wells: '{}', wts_acct_x: '1', other_key: '1' },
        remove: ['wts_prism_presets'], modules: { storage: {}, units: { system: 'metric' } } }));
      assert.deepStrictEqual(Array.from(r.applied), []);
      assert.deepStrictEqual(Array.from(r.skipped).sort(), ['other_key', 'storage', 'units', 'wts_acct_x', 'wts_prism_presets', 'wts_prism_user_curves', 'wts_ui_favs', 'wts_unit_system', 'wts_wells'].sort());
      assert.strictEqual(app.storage.getItem('wts_unit_system'), null);
    },
  },
  {
    name: 'HO17 H4 applyChanges keeps the build-up store (hasRaw) and the simulator state; PRiSM modules apply', wp: WP,
    integration: true,
    async run(app, assert) {
      const W = app.win, P = W.WTS_project, S = W.WTS_buildup.store;
      await S.init();
      const wid = S.wellId();
      await S.putRaw(wid, record(app));
      const simBefore = JSON.stringify(W.WTS_state && W.WTS_state.sim || null);
      const pvt = JSON.parse(JSON.stringify(W.PRiSM_pvt || {}));
      pvt.h = 77;
      const r = P.applyChanges(app.toWin({ set: { wts_page_choke: '{"v":1,"f":{}}' }, modules: { pvt } }), app.toWin({ source: 'cloud' }));
      assert.ok(Array.from(r.applied).indexOf('pvt') !== -1, 'pvt module applied');
      assert.strictEqual(W.PRiSM_pvt.h, 77);
      assert.ok(S.hasRaw(wid), 'build-up raw record not pruned');
      assert.strictEqual(JSON.stringify(W.WTS_state && W.WTS_state.sim || null), simBefore, 'simulator state unchanged');
    },
  },
  {
    name: 'HO18 H4 wts:project-changed listeners: base conditions (22-units) and the report-snapshot cache (host)', wp: WP,
    run(app, assert) {
      const W = app.win, P = W.WTS_project;
      let fired = 0;
      app.document.addEventListener('wts:base-conditions-changed', () => fired++);
      app.win.addEventListener('wts:base-conditions-changed', () => fired++);
      const before = W.WTS_baseConditions.get();
      P.applyChanges(app.toWin({ set: { wts_base_conditions: '60F_14.65' } }));
      assert.notDeepStrictEqual(W.WTS_baseConditions.get(), before);
      assert.strictEqual(String(W.WTS_baseConditions.get().key || W.WTS_baseConditions.get()), String(W.WTS_baseConditions.get().key || '60F_14.65'));
      const sel = app.el('wts_base_select');
      if (sel) assert.strictEqual(sel.value, '60F_14.65', 'header selector follows');
      const snaps = { flareghg: { title: 'Applied', subtitle: '', inputs: [], results: [{ title: 'R', rows: [] }], at: '2026-11-08T00:00:00Z' } };
      P.applyChanges(app.toWin({ set: { wts_report_snapshots: JSON.stringify(snaps) } }));
      // the cache is used by the next snapshot write: a new page snapshot keeps the applied entry
      app.hook.nav('choke'); app.flush(50);
      const el = app.findAll('#pgBody input[id]').find((e) => e.type !== 'checkbox');
      if (el) { app.input(el, '1'); app.flush(1200); }
      const now = JSON.parse(app.storage.getItem('wts_report_snapshots') || '{}');
      assert.ok(now.flareghg && now.flareghg.title === 'Applied', 'applied snapshot kept in the in-memory cache');
    },
  },
  // ── H5 ──────────────────────────────────────────────────────────────────────────────
  {
    name: 'HO19 H5 no registered items → the File toolbar markup is exactly as before (New, Open, Save, Save As, status, picker)', wp: WP,
    run(app, assert) {
      const tb = app.find('[data-wts-project-toolbar="1"]');
      assert.ok(tb, 'toolbar mounted');
      assert.ok(!tb.querySelector('[data-role="items"]'), 'no items container');
      assert.deepStrictEqual(Array.from(tb.querySelectorAll('button')).map((b) => b.getAttribute('data-act')), ['new', 'open', 'save', 'saveas']);
    },
  },
  {
    name: 'HO20 H5 registerToolbarItems renders after Save As (text labels), when() hides, refresh re-evaluates, click runs, unregister removes', wp: WP,
    run(app, assert) {
      const P = app.win.WTS_project;
      let show = true, runs = 0;
      const n = P.registerToolbarItems(([
        { id: 'cloud', label: '☁ <b>x</b>', title: 'Cloud', run: () => { runs++; }, when: () => show },
        { id: 'BAD id', label: 'no', run: () => {} },
        { id: 'norun', label: 'no' },
      ]));
      assert.strictEqual(n, 1, 'only the valid item registered');
      const tb = app.find('[data-wts-project-toolbar="1"]');
      const box = tb.querySelector('[data-role="items"]');
      assert.ok(box && box.previousSibling && box.previousSibling.getAttribute('data-act') === 'saveas', 'right after Save As');
      const b = box.querySelector('[data-item="cloud"]');
      assert.strictEqual(b.textContent, '☁ <b>x</b>', 'label is text');
      assert.ok(!box.querySelector('b'), 'no markup from the label');
      app.click(b);
      assert.strictEqual(runs, 1);
      show = false; P.refreshToolbarItems();
      assert.ok(!box.querySelector('[data-item="cloud"]'), 'hidden by when()');
      show = true; P.refreshToolbarItems();
      assert.ok(box.querySelector('[data-item="cloud"]'));
      assert.strictEqual(P.unregisterToolbarItem('cloud'), true);
      assert.ok(!tb.querySelector('[data-role="items"]'), 'container gone with the last item');
    },
  },
  // ── H14 ─────────────────────────────────────────────────────────────────────────────
  {
    name: 'HO21 H14 no guard: New runs synchronously in the click (today\'s flow)', wp: WP,
    run(app, assert) {
      app.win.WTS_lsSet('wts_page_choke', '{"v":1,"f":{"x":"1"}}');
      const tb = app.find('[data-wts-project-toolbar="1"]');
      app.click(tb.querySelector('[data-act="new"]'));
      assert.strictEqual(app.storage.getItem('wts_page_choke'), null, 'cleared before the click returned');
      assert.ok(app.dialogs.some((d) => d.type === 'confirm'), 'confirm asked');
    },
  },
  {
    name: 'HO22 H14 a guard is asked first: cancel keeps everything; proceed runs New after the guard resolved; unregister', wp: WP,
    async run(app, assert) {
      const P = app.win.WTS_project;
      const seen = [];
      let answer = 'cancel';
      const un = P.registerGuard((o) => { seen.push(o.action); return Promise.resolve(answer); });
      app.win.WTS_lsSet('wts_page_choke', '{"v":1,"f":{"x":"1"}}');
      const tb = app.find('[data-wts-project-toolbar="1"]');
      app.click(tb.querySelector('[data-act="new"]'));
      assert.ok(app.storage.getItem('wts_page_choke'), 'nothing changed in the click');
      await app.flushAsync(0); await app.flushAsync(0);
      assert.ok(app.storage.getItem('wts_page_choke'), 'cancel → kept');
      assert.deepStrictEqual(seen, ['new']);
      answer = 'proceed';
      app.click(tb.querySelector('[data-act="new"]'));
      await app.flushAsync(0); await app.flushAsync(0); await app.flushAsync(0);
      assert.strictEqual(app.storage.getItem('wts_page_choke'), null, 'proceed → New ran');
      un();
      app.win.WTS_lsSet('wts_page_choke', '{"v":1,"f":{"x":"1"}}');
      app.click(tb.querySelector('[data-act="new"]'));
      assert.strictEqual(app.storage.getItem('wts_page_choke'), null, 'unregistered → synchronous again');
      assert.strictEqual(seen.length, 2);
    },
  },
  {
    name: 'HO23 H14 Open-from-file is guarded before the load; a throwing guard cancels', wp: WP,
    async run(app, assert) {
      const P = app.win.WTS_project;
      const pay = P._buildPayload();
      pay.modules.storage = { keys: { wts_page_choke: '{"v":1,"f":{"from":"file"}}' }, skipped: [] };
      const seen = [];
      let mode = 'throw';
      P.registerGuard((o) => { seen.push(o.action); if (mode === 'throw') throw new Error('boom'); return 'proceed'; });
      const tb = app.find('[data-wts-project-toolbar="1"]');
      const picker = tb.querySelector('[data-role="picker"]');
      const file = { name: 'p.h2oilproj', text: () => Promise.resolve(JSON.stringify(pay)), _text: JSON.stringify(pay) };
      const fire = () => { Object.defineProperty(picker, 'files', { value: [file], configurable: true }); app.fire(picker, 'change'); };
      fire();
      await app.flushAsync(50); await app.flushAsync(50);
      assert.deepStrictEqual(seen, ['open-file']);
      assert.strictEqual(app.storage.getItem('wts_page_choke'), null, 'throwing guard → not opened');
      mode = 'ok';
      fire();
      for (let i = 0; i < 6; i++) await app.flushAsync(50);
      assert.deepStrictEqual(seen, ['open-file', 'open-file']);
      assert.strictEqual(JSON.parse(app.storage.getItem('wts_page_choke') || '{}').f.from, 'file', 'opened after the guard');
    },
  },
  {
    name: 'HO32 H14 Client Info "Import session" asks the guard: cancel changes no key (project file and legacy session); no guard = applied at once', wp: WP,
    async run(app, assert) {
      const W = app.win, P = W.WTS_project;
      assert.strictEqual(typeof P.guarded, 'function', 'public WTS_project.guarded');
      const pay = P._buildPayload();
      pay.modules.storage = { keys: { wts_page_choke: '{"v":1,"f":{"from":"proj"}}' }, skipped: [] };
      const legacy = { _format: 'H2Oil_WTS_Session_v1', wts_page_flareghg: { v: 1, f: { fe_qg: 'LEGACY' } } };
      const imp = (obj, name) => {
        const inp = { files: [{ name, _text: JSON.stringify(obj), size: 1, type: 'application/json' }], value: name };
        const w = app.toWin(inp);
        W.importSession(w);
        return w;
      };
      const snap = () => { const o = []; for (let i = 0; i < app.storage.length; i++) { const k = app.storage.key(i); o.push([k, app.storage.getItem(k)]); } return JSON.stringify(o.sort()); };
      const settle = async () => { for (let i = 0; i < 6; i++) { app.flush(50); await app.flushAsync(0); } };
      // no guard: today's flow (applied as soon as the file is read)
      imp(pay, 'a.h2oilproj'); app.flush(50);
      assert.strictEqual(JSON.parse(app.storage.getItem('wts_page_choke')).f.from, 'proj', 'no guard → project loaded');
      W.WTS_lsSet('wts_page_choke', '{"v":1,"f":{"from":"local"}}');
      W.WTS_lsSet('wts_page_flareghg', '{"v":1,"f":{"fe_qg":"LOCAL"}}');
      // a cancelling guard: neither branch touches storage
      const seen = [];
      let answer = 'cancel';
      const un = P.registerGuard((o) => { seen.push(o.action); return Promise.resolve(answer); });
      app.flush(5000); await app.flushAsync(0);   // let earlier one-shot saves (PRiSM state debounce) run first
      const before = snap();
      const i1 = imp(pay, 'b.h2oilproj'); await settle();
      const i2 = imp(legacy, 'c.txt'); await settle();
      assert.deepStrictEqual(seen, ['open-file', 'open-file'], 'both branches asked the guard');
      assert.strictEqual(snap(), before, 'cancel → no key changed');
      assert.strictEqual(i1.value, '', 'input reset after a cancel');
      assert.strictEqual(i2.value, '');
      // proceed: both apply after the guard resolved
      answer = 'proceed';
      imp(pay, 'd.h2oilproj'); await settle();
      assert.strictEqual(JSON.parse(app.storage.getItem('wts_page_choke')).f.from, 'proj', 'proceed → project loaded');
      imp(legacy, 'e.txt'); await settle();
      assert.strictEqual(JSON.parse(app.storage.getItem('wts_page_flareghg')).f.fe_qg, 'LEGACY', 'proceed → legacy session restored');
      un();
    },
  },
  {
    name: 'HO33 H4 applyChanges to the open page\'s legacy list (wts_flare on flare) cancels the pending legacy write', wp: WP,
    run(app, assert) {
      const W = app.win, P = W.WTS_project;
      assert.strictEqual(W.WTS_project._internals.pageKeyMatch('flare', 'wts_flare'), true);
      assert.strictEqual(W.WTS_project._internals.pageKeyMatch('pipelife', 'wts_pl_x'), true);
      assert.strictEqual(W.WTS_project._internals.pageKeyMatch('flare', 'wts_flareghg'), false, 'another route');
      assert.strictEqual(W.WTS_project._internals.pageKeyMatch('flare', 'wts_page_flareghg'), false);
      app.hook.nav('flare');
      app.input(app.el('fl_flow'), '111');      // schedules the 300 ms legacy write of wts_flare
      const remote = JSON.stringify({ fl_flow: '999' });
      const r = P.applyChanges(app.toWin({ set: { wts_flare: remote } }), app.toWin({ source: 'cloud' }));
      assert.deepStrictEqual(Array.from(r.applied), ['wts_flare']);
      app.flush(1000);
      assert.strictEqual(JSON.parse(app.storage.getItem('wts_flare')).fl_flow, '999', 'the pending legacy write did not overwrite the applied value');
    },
  },
  {
    name: 'HO34 H3 keep rule: keep:[prism] alone still lets storage replace wts_prism_* keys; keeping every PRiSM module and storage leaves them', wp: WP,
    run(app, assert) {
      const W = app.win, P = W.WTS_project;
      W.WTS_lsSet('wts_prism_state', '{"local":true}');
      const pay = P._buildPayload();
      pay.modules.storage = { keys: { wts_prism_state: '{"file":true}' }, skipped: [] };
      const ALL = ['prism', 'pvt', 'prism_dataset', 'storage'];
      const r1 = P.loadFromObject(app.toWin(JSON.parse(JSON.stringify(pay))), app.toWin({ keep: ALL }));
      assert.ok(['prism', 'storage'].every((m) => Array.from(r1.kept).indexOf(m) !== -1), 'kept: ' + Array.from(r1.kept).join(','));
      app.flush(5000);
      assert.strictEqual(JSON.parse(app.storage.getItem('wts_prism_state') || 'null').local, true, 'PRiSM modules + storage kept → PRiSM keys untouched');
      const src = fs.readFileSync(path.join(ROOT, 'prism-build', '29-project-save.js'), 'utf8');
      assert.ok(/keeping prism, pvt or\s*\n\s*\/\/ prism_dataset leaves PRiSM untouched only when 'storage' is kept too, and with it every PRiSM module/.test(src), 'rule documented at loadFromObject');
      P.loadFromObject(app.toWin(JSON.parse(JSON.stringify(pay))), app.toWin({ keep: ['prism'] }));
      assert.ok(!/"local":true/.test(app.storage.getItem('wts_prism_state') || ''), 'prism kept, storage loaded → storage replaced the key');
    },
  },
  // ── H15 ─────────────────────────────────────────────────────────────────────────────
  {
    name: 'HO24 H15 flushIfDirty writes only with unsaved edits (no `t` rewrite otherwise); flush always rewrites', wp: WP,
    run(app, assert) {
      const PA = app.win.WTS_pageAutosave;
      assert.strictEqual(typeof PA.flushIfDirty, 'function');
      app.hook.nav('flareghg');
      const el = app.findAll('#pgBody input[id]').find((e) => e.type !== 'checkbox');
      app.input(el, '4.5');
      assert.strictEqual(PA.flushIfDirty(), true, 'dirty → written');
      const t1 = JSON.parse(app.storage.getItem('wts_page_flareghg')).t;
      app.flush(1000);
      assert.strictEqual(PA.flushIfDirty(), false, 'clean → nothing');
      assert.strictEqual(JSON.parse(app.storage.getItem('wts_page_flareghg')).t, t1, 't unchanged');
      PA.flush();
      assert.ok(JSON.parse(app.storage.getItem('wts_page_flareghg')).t > t1, 'flush() still rewrites');
    },
  },
  // ── H13 ─────────────────────────────────────────────────────────────────────────────
  {
    name: 'HO25 H13 captureWell(active) = the live keys and modules; two captures with no edit are equal apart from savedAt', wp: WP,
    run(app, assert) {
      const W = app.win;
      app.hook.nav('flareghg');
      const el = app.findAll('#pgBody input[id]').find((e) => e.type !== 'checkbox');
      app.input(el, '6.25');
      const a0 = W.WTS_wells.captureWell();
      assert.ok(a0 && a0.v === 1 && a0.keys && a0.modules && typeof a0.savedAt === 'string');
      assert.strictEqual(JSON.parse(a0.keys.wts_page_flareghg).f[el.id], '6.25', 'pending edit flushed into the capture');
      assert.ok(!('wts_wells' in a0.keys) && !('wts_unit_system' in a0.keys), 'only well keys');
      app.flush(2000);                                   // let the report snapshot / results cache settle
      const a = W.WTS_wells.captureWell();
      const t = JSON.parse(app.storage.getItem('wts_page_flareghg')).t;
      app.flush(2000);
      const b = W.WTS_wells.captureWell(W.WTS_wells.active());
      assert.strictEqual(JSON.parse(app.storage.getItem('wts_page_flareghg')).t, t, 'no page rewrite without an edit');
      const strip = (c) => { const o = JSON.parse(JSON.stringify(c)); delete o.savedAt; delete o.keys.wts_prism_state; return o; };
      assert.deepStrictEqual(strip(b), strip(a));
    },
  },
  {
    name: 'HO26 H13 captureWell(parked) = a copy of its blob; unknown id → null', wp: WP,
    run(app, assert) {
      const W = app.win;
      app.hook.nav('flareghg');
      const el = app.findAll('#pgBody input[id]').find((e) => e.type !== 'checkbox');
      app.input(el, '8');
      const first = W.WTS_wells.active();
      assert.ok(W.WTS_wells.create('Second').ok);
      const c = W.WTS_wells.captureWell(first);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(c)), JSON.parse(app.storage.getItem('wts_well_' + first)));
      c.keys.x = 1;
      assert.ok(!JSON.parse(app.storage.getItem('wts_well_' + first)).keys.x, 'a copy');
      assert.strictEqual(W.WTS_wells.captureWell('w999'), null);
    },
  },
  // ── H7 / H10 ────────────────────────────────────────────────────────────────────────
  {
    name: 'HO27 H7 navHidden registry entry: routed with title, no sidebar button, no home tile, no recent chip', wp: WP,
    opts: { sourceOverrides: { '49-calc-zz-hidden.js': HIDDEN } },
    run(app, assert) {
      assert.ok(app.win.WTS_calcRegistry.account, 'registered');
      assert.ok(!app.find('.nav-btn[data-p="account"]'), 'no sidebar button');
      app.hook.nav('home');
      assert.ok(!app.find('.dc-fav[data-fav="account"]') && !app.find('[data-fav="account"]'), 'no home tile');
      app.hook.nav('account');
      assert.strictEqual(app.el('pgTitle').textContent, 'Account');
      assert.ok(app.el('acct_root'), 'page rendered');
      app.input('acct_x', '2'); app.flush(1500);
      assert.strictEqual(app.storage.getItem('wts_page_account'), null, 'PAGE_AUTOSAVE_SKIP');
      assert.ok((app.storage.getItem('wts_report_snapshots') || '').indexOf('"account"') === -1, '_REPORT_SKIP');
      app.hook.nav('home');
      assert.ok((app.storage.getItem('wts_ui_recent') || '').indexOf('account') === -1, '__UI_NOT_TILE (no recent chip)');
    },
  },
  {
    name: 'HO28 H10 NO_COPY: copying inputs into the account page is refused; skip tables carry account in the host', wp: WP,
    run(app, assert) {
      const W = app.win;
      assert.ok(W.WTS_wells.create('Second').ok);
      const other = W.WTS_wells.list().find((w) => !w.active).id;
      const r = W.WTS_wells.copyPage(other, 'account');
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.error, 'no inputs on this page');
      const html = fs.readFileSync(HTML, 'utf8');
      for (const re of [/const PAGE_AUTOSAVE_SKIP = \{[^}]*account:1/, /const _REPORT_SKIP = \{[^}]*account:1/, /const __UI_NOT_TILE = \{[^}]*account:1/]) {
        assert.ok(re.test(html), String(re));
      }
    },
  },
  // ── H6 ──────────────────────────────────────────────────────────────────────────────
  {
    name: 'HO29 H6 PREF_RE: wts_acct_* / wts_sync_* are device state — not in project files, kept by New and Open', wp: WP,
    run(app, assert) {
      const W = app.win, P = W.WTS_project;
      W.WTS_lsSet('wts_acct_probe', '1'); W.WTS_lsSet('wts_sync_probe', '2'); W.WTS_lsSet('wts_page_choke', '{"v":1,"f":{}}');
      const pay = P._buildPayload();
      const keys = pay.modules.storage.keys;
      assert.ok(!('wts_acct_probe' in keys) && !('wts_sync_probe' in keys), 'not saved');
      assert.ok('wts_page_choke' in keys);
      pay.modules.storage.keys.wts_acct_probe = 'FROM_FILE';
      P.loadFromObject(pay);
      assert.strictEqual(app.storage.getItem('wts_acct_probe'), '1', 'not overwritten by Open');
      P['new']();
      assert.strictEqual(app.storage.getItem('wts_acct_probe'), '1', 'kept by New');
      assert.strictEqual(app.storage.getItem('wts_sync_probe'), '2');
    },
  },
  // ── H12 / H8 / H9 / H11 ─────────────────────────────────────────────────────────────
  {
    name: 'HO30 H12 RELEASE_NOTES: platform:\'web\' items / entries hidden in the iOS app, shown on the web; every entry keeps a neutral item', wp: WP,
    opts: false,
    run(app, assert, ctx) {
      let html = fs.readFileSync(HTML, 'utf8');
      const start = html.indexOf('const RELEASE_NOTES = [');
      const block = html.slice(start, html.indexOf('\n];', start));
      // every entry has at least one item without platform:'web'
      const entries = block.split(/\n    \{ ver:/).slice(1);
      assert.ok(entries.length > 20, entries.length + ' entries');
      entries.forEach((e, i) => assert.ok(/\n\s+\['[a-z]+', '(?![^\n]*platform\s*:\s*'web')/.test(e), 'entry ' + i + ' has a neutral item'));
      // a web-only item and entry injected for the test
      html = html.replace("const RELEASE_NOTES = [\n", "const RELEASE_NOTES = [\n    { ver:'v9.9', date:'2026-12-01', title:'Web entry', platform:'web', items:[['platform','WEBENTRY','x']] },\n");
      html = html.replace(/(items:\[\n)/, "$1        ['platform', 'WEBONLYITEM', 'web text', { platform:'web' }],\n");
      const web = ctx.loadApp({ fromSources: false, html });
      try {
        web.hook.nav('releasenotes');
        const t = web.el('pgBody').textContent;
        assert.ok(t.indexOf('WEBONLYITEM') !== -1 && t.indexOf('WEBENTRY') !== -1, 'web shows both');
      } finally { web.dispose(); }
      const ios = ctx.loadApp({ fromSources: false, html, globals: { isIOSApp: true } });
      try {
        ios.hook.nav('releasenotes');
        const t = ios.el('pgBody').textContent;
        assert.ok(t.indexOf('WEBONLYITEM') === -1 && t.indexOf('WEBENTRY') === -1, 'iOS hides both');
        assert.ok(t.indexOf('DFIT') !== -1, 'neutral items still shown');
      } finally { ios.dispose(); }
    },
  },
  {
    name: 'HO31 H8 / H9 / H11 account hosts and privacy cards only between ACCT markers; privacy = v3.4 text unless the web beta is on', wp: WP,
    run(app, assert, ctx) {
      const html = fs.readFileSync(HTML, 'utf8');
      assert.ok(/<div class="page-actions"[^>]*>\s*<!-- ACCT:START --><div id="wts_account_host"><\/div><!-- ACCT:END -->/.test(html), 'H8 first child of .page-actions');
      assert.ok(/Privacy — how your data is stored<\/a><!-- ACCT:START --><div id="sbAccountLine"><\/div><!-- ACCT:END -->/.test(html), 'H9 footer line + link text');
      const stripped = html.replace(/\/\/ ── ACCT:START[\s\S]*?\/\/ ── ACCT:END ──/g, '').replace(/<!--\s*ACCT:START[\s\S]*?ACCT:END\s*-->/g, '');
      for (const s of ['wts_account_host', 'sbAccountLine', 'Accounts and cloud projects', 'Sign in with LinkedIn', 'LinkedIn', 'unless you sign in to the cloud']) {
        assert.ok(html.indexOf(s) !== -1, 'present on the web: ' + s);
        assert.ok(stripped.indexOf(s) === -1, 'stripped for iOS: ' + s);
      }
      // the harness page (http://localhost, no account client eligible) = today's text
      app.hook.nav('privacy');
      const t = app.el('pgBody').textContent;
      assert.ok(t.indexOf('Your well data never leaves your device.') !== -1 && t.indexOf('no user accounts') !== -1);
      assert.ok(!app.el('privacy_accounts'), 'no account card');
      // H17: "This build" follows __wtsGaLoaded (gtag is defined even when the guard skipped the tag)
      assert.ok(t.indexOf('usage analytics are active') !== -1, 'no hint → analytics active (v3.4 line)');
      app.win.__wtsGaLoaded = false;
      app.hook.nav('home'); app.hook.nav('privacy');
      const tg = app.el('pgBody').textContent;
      assert.ok(tg.indexOf('analytics are not loaded') !== -1 && tg.indexOf('analytics are active') === -1, 'tag skipped → not loaded');
      app.win.__wtsGaLoaded = true;
      // production web location with the beta flag: the cards and the web banner
      const st = ctx.createStorage ? ctx.createStorage() : null;
      const web = ctx.loadApp(Object.assign({ globals: { location: Object.assign({}, PROD, { search: '?cloud=1' }), fetch: () => Promise.reject(new Error('offline')) } }, st ? { storage: st } : {}));
      try {
        const A = web.win.WTS_account;
        assert.ok(A && A.eligible === true && typeof A.betaEnabled === 'function' && A.betaEnabled() === true, 'web client eligible under PROD + ?cloud=1');
        web.hook.nav('privacy');
        const tw = web.el('pgBody').textContent;
        assert.ok(web.el('privacy_accounts') && web.el('privacy_providers'), 'account and provider cards');
        assert.ok(tw.indexOf('Your well data stays on this device unless you sign in to the cloud.') !== -1, 'web banner');
        assert.ok(tw.indexOf('no user accounts') === -1, 'no "no accounts" claim while accounts exist');
      } finally { web.dispose(); }
      // the iOS branch never shows them, even with an eligible-looking client
      const ios = ctx.loadApp({ globals: { isIOSApp: true, location: Object.assign({}, PROD, { search: '?cloud=1' }), fetch: () => Promise.reject(new Error('offline')) } });
      try {
        ios.hook.nav('privacy');
        assert.ok(!ios.el('privacy_accounts'), 'iOS: no account card');
        assert.ok(ios.el('pgBody').textContent.indexOf('no user accounts') !== -1);
      } finally { ios.dispose(); }
    },
  },
];
