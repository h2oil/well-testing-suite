// prism-build/tests/_buildup-idb-fake.js — a small IndexedDB fake for the Build-up Surveillance store tests (WP6).
//
//   const { createFakeIDB } = require('./_buildup-idb-fake');
//   const idb = createFakeIDB({ failOpen: false, failWrites: false });
//   app.win.indexedDB = idb.indexedDB;          // before the page or the store first opens the database
//   idb.failWrites = true;                      // switch the failure path on later
//   idb.keys('wts_buildup', 'raw')              // → ['w1', …]   idb.get(db, store, key) → stored value (a copy)
//
// Covered (what 49-calc-buildup-store.js uses): indexedDB.open(name, version) with onupgradeneeded / onsuccess /
// onerror, db.objectStoreNames.contains, createObjectStore (out-of-line keys), transaction(store, mode) with
// oncomplete / onerror, objectStore put(value, key) / get / delete / clear / getAllKeys. Requests settle in
// microtasks (no timers, so the harness's virtual clock and its pending-timer checks are not disturbed); a
// transaction completes once every request it issued has settled. Values are stored as structured clones.
// Failure paths: failOpen → open() fires onerror; failWrites → put / delete / clear fire onerror and the
// transaction's onerror.
'use strict';

function domErr(name, msg) { const e = new Error(msg || name); e.name = name; return e; }
function clone(v) { return v === undefined ? undefined : structuredClone(v); }

function createFakeIDB(opts) {
  opts = opts || {};
  const dbs = new Map();   // name → { version, stores: Map(storeName → Map(key → value)) }
  const later = (fn) => { Promise.resolve().then(fn); };
  const request = () => ({ result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null, readyState: 'pending' });
  const fake = { failOpen: !!opts.failOpen, failWrites: !!opts.failWrites, opens: 0, writes: 0 };

  function makeStore(map, tx, mode) {
    const op = (fn, write) => {
      const r = request();
      tx._pending++;
      later(() => {
        tx._pending--;
        if (write && (mode !== 'readwrite' || fake.failWrites)) {
          r.error = domErr(mode !== 'readwrite' ? 'ReadOnlyError' : 'QuotaExceededError');
          r.readyState = 'done';
          tx._failed = true;
          if (typeof r.onerror === 'function') r.onerror({ target: r });
        } else {
          try {
            r.result = fn();
            if (write) fake.writes++;
            r.readyState = 'done';
            if (typeof r.onsuccess === 'function') r.onsuccess({ target: r });
          } catch (e) {
            r.error = e; tx._failed = true;
            if (typeof r.onerror === 'function') r.onerror({ target: r });
          }
        }
        tx._finish();
      });
      return r;
    };
    return {
      put: (v, k) => op(() => { map.set(String(k), clone(v)); return k; }, true),
      get: (k) => op(() => clone(map.get(String(k)))),
      delete: (k) => op(() => { map.delete(String(k)); }, true),
      clear: () => op(() => { map.clear(); }, true),
      getAllKeys: () => op(() => Array.from(map.keys())),
      count: () => op(() => map.size),
    };
  }
  function makeDb(d) {
    return {
      get version() { return d.version; },
      objectStoreNames: { contains: (n) => d.stores.has(n), get length() { return d.stores.size; } },
      createObjectStore(n) { if (!d.stores.has(n)) d.stores.set(n, new Map()); return makeStore(d.stores.get(n), { _pending: 0, _finish() {} }, 'versionchange'); },
      transaction(names, mode) {
        const list = Array.isArray(names) ? names : [names];
        list.forEach((n) => { if (!d.stores.has(n)) throw domErr('NotFoundError', 'no object store ' + n); });
        const tx = { oncomplete: null, onerror: null, onabort: null, error: null, mode: mode || 'readonly', _pending: 0, _failed: false, _done: false };
        tx._finish = () => later(() => {
          if (tx._pending !== 0 || tx._done) return;
          tx._done = true;
          if (tx._failed) { tx.error = domErr('AbortError'); if (typeof tx.onerror === 'function') tx.onerror({ target: tx }); }
          else if (typeof tx.oncomplete === 'function') tx.oncomplete({ target: tx });
        });
        tx.objectStore = (n) => { if (list.indexOf(n) === -1) throw domErr('NotFoundError'); return makeStore(d.stores.get(n), tx, tx.mode); };
        tx._finish();
        return tx;
      },
      close() {},
    };
  }
  fake.indexedDB = {
    open(name, version) {
      const r = request();
      fake.opens++;
      later(() => {
        if (fake.failOpen) {
          r.error = domErr('UnknownError', 'open failed'); r.readyState = 'done';
          if (typeof r.onerror === 'function') r.onerror({ target: r });
          return;
        }
        let d = dbs.get(name);
        if (!d) { d = { version: 0, stores: new Map() }; dbs.set(name, d); }
        const v = version || 1, old = d.version;
        r.result = makeDb(d);
        if (v > old) {
          d.version = v;
          if (typeof r.onupgradeneeded === 'function') r.onupgradeneeded({ target: r, oldVersion: old, newVersion: v });
        }
        r.readyState = 'done';
        if (typeof r.onsuccess === 'function') r.onsuccess({ target: r });
      });
      return r;
    },
    deleteDatabase(name) {
      const r = request();
      dbs.delete(name);
      later(() => { if (typeof r.onsuccess === 'function') r.onsuccess({ target: r }); });
      return r;
    },
  };
  fake.keys = (db, store) => { const d = dbs.get(db); const m = d && d.stores.get(store); return m ? Array.from(m.keys()).sort() : []; };
  fake.get = (db, store, key) => { const d = dbs.get(db); const m = d && d.stores.get(store); return m ? clone(m.get(String(key))) : undefined; };
  fake.set = (db, store, key, value) => {
    let d = dbs.get(db);
    if (!d) { d = { version: 1, stores: new Map() }; dbs.set(db, d); }
    if (!d.stores.has(store)) d.stores.set(store, new Map());
    d.stores.get(store).set(String(key), clone(value));
  };
  return fake;
}

module.exports = { createFakeIDB };
