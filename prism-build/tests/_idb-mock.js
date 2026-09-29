// prism-build/tests/_idb-mock.js — a small in-memory IndexedDB for the headless
// harness (tests only; the harness itself has no IndexedDB).
//
//   const { createIndexedDB } = require('./_idb-mock');
//   const idb = createIndexedDB();              // { indexedDB, IDBKeyRange, dump() }
//   app.win.indexedDB = idb.indexedDB; app.win.IDBKeyRange = idb.IDBKeyRange;
//   // share `idb` between two app sessions to test persistence across a reload.
//
// Covered (what the app's IndexedDB code uses): open with onupgradeneeded /
// createObjectStore(keyPath | out-of-line keys) / createIndex(unique), transactions
// (readonly / readwrite, oncomplete / onerror / onabort, rollback on abort),
// get / getAll(range, count) / count(range) / put / add (ConstraintError) /
// delete(key | range) / clear / openCursor(range, 'next' | 'prev') + continue,
// index get / getAll / count, IDBKeyRange bound / only / lowerBound / upperBound,
// spec key order (number < date < string < binary < array). Request events are
// delivered one per macrotask (setImmediate) like a browser, so code that awaits
// unrelated promises inside a transaction is not hidden by synchronous delivery;
// a transaction commits once a macrotask passes with no new request.
'use strict';

function domErr(name, msg) { const e = new Error(msg || name); e.name = name; return e; }
function keyType(k) {
  if (typeof k === 'number') { if (Number.isNaN(k)) throw domErr('DataError', 'NaN is not a valid key'); return 1; }
  if (Object.prototype.toString.call(k) === '[object Date]') return 2;
  if (typeof k === 'string') return 3;
  if (Array.isArray(k)) return 5;
  if (k && (k instanceof ArrayBuffer || ArrayBuffer.isView(k) || Object.prototype.toString.call(k) === '[object ArrayBuffer]')) return 4;
  throw domErr('DataError', 'invalid key: ' + String(k));
}
function cmp(a, b) {
  const ta = keyType(a), tb = keyType(b);
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (ta === 5) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) { const c = cmp(a[i], b[i]); if (c) return c; }
    return a.length === b.length ? 0 : (a.length < b.length ? -1 : 1);
  }
  if (ta === 4) {
    const x = new Uint8Array(ArrayBuffer.isView(a) ? a.buffer : a), y = new Uint8Array(ArrayBuffer.isView(b) ? b.buffer : b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return x.length === y.length ? 0 : (x.length < y.length ? -1 : 1);
  }
  const va = ta === 2 ? a.getTime() : a, vb = tb === 2 ? b.getTime() : b;
  return va < vb ? -1 : va > vb ? 1 : 0;
}
function clone(v) { return v === undefined ? undefined : structuredClone(v); }

class IDBKeyRange {
  constructor(lower, upper, lowerOpen, upperOpen) {
    this.lower = lower; this.upper = upper; this.lowerOpen = !!lowerOpen; this.upperOpen = !!upperOpen;
  }
  includes(k) {
    if (this.lower !== undefined) { const c = cmp(k, this.lower); if (c < 0 || (c === 0 && this.lowerOpen)) return false; }
    if (this.upper !== undefined) { const c = cmp(k, this.upper); if (c > 0 || (c === 0 && this.upperOpen)) return false; }
    return true;
  }
  static bound(l, u, lo, uo) { if (cmp(l, u) > 0) throw domErr('DataError', 'lower > upper'); return new IDBKeyRange(l, u, lo, uo); }
  static only(k) { keyType(k); return new IDBKeyRange(k, k, false, false); }
  static lowerBound(l, open) { keyType(l); return new IDBKeyRange(l, undefined, open, false); }
  static upperBound(u, open) { keyType(u); return new IDBKeyRange(undefined, u, false, open); }
}
const asRange = (q) => (q === undefined || q === null) ? null : (q instanceof IDBKeyRange ? q : IDBKeyRange.only(q));
function lowerIndex(recs, key) { let lo = 0, hi = recs.length; while (lo < hi) { const m = (lo + hi) >> 1; if (cmp(recs[m].key, key) < 0) lo = m + 1; else hi = m; } return lo; }
function inRange(recs, range) {
  if (!range) return recs.slice();
  let i = range.lower === undefined ? 0 : lowerIndex(recs, range.lower);
  const out = [];
  for (; i < recs.length; i++) {
    const r = recs[i];
    if (range.upper !== undefined) { const c = cmp(r.key, range.upper); if (c > 0 || (c === 0 && range.upperOpen)) break; }
    if (range.includes(r.key)) out.push(r);
  }
  return out;
}
function nameList(arr) {
  const a = arr.slice().sort();
  return Object.assign(a, { contains: (n) => a.indexOf(n) !== -1, item: (i) => a[i] ?? null });
}

function createIndexedDB() {
  const dbs = new Map();          // name → {version, stores: Map(name → store)}

  class Request {
    constructor(source, tx) { this.source = source; this.transaction = tx; this.result = undefined; this.error = null; this.readyState = 'pending'; this.onsuccess = null; this.onerror = null; }
  }

  class Transaction {
    constructor(conn, names, mode) {
      this.db = conn; this.mode = mode || 'readonly'; this._names = names; this._queue = []; this._journal = [];
      this._done = false; this._scheduled = false; this.error = null;
      this.oncomplete = null; this.onerror = null; this.onabort = null;
      this.objectStoreNames = nameList(names);
      this._kick();
    }
    objectStore(n) {
      if (this._names.indexOf(n) === -1) throw domErr('NotFoundError', 'store ' + n + ' not in this transaction');
      return new ObjectStore(this, n);
    }
    _req(source, fn) {
      if (this._done) throw domErr('TransactionInactiveError', 'transaction has finished');
      const r = new Request(source, this);
      this._queue.push({ r, fn });
      this._kick();
      return r;
    }
    _kick() { if (this._scheduled || this._done) return; this._scheduled = true; setImmediate(() => this._step()); }
    _step() {
      this._scheduled = false;
      if (this._done) return;
      const op = this._queue.shift();
      if (!op) { this._commit(); return; }
      let res, err = null;
      try { res = op.fn(op.r); } catch (e) { err = e; }
      op.r.readyState = 'done';
      if (err) {
        op.r.error = err; op.r.result = undefined;
        const ev = { type: 'error', target: op.r, currentTarget: op.r, defaultPrevented: false, _stop: false,
          preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this._stop = true; } };
        if (typeof op.r.onerror === 'function') op.r.onerror(ev);
        if (!ev._stop && typeof this.onerror === 'function') this.onerror(ev);
        if (!ev.defaultPrevented) { this._abort(err); return; }
      } else {
        op.r.result = res;
        if (typeof op.r.onsuccess === 'function') op.r.onsuccess({ type: 'success', target: op.r, currentTarget: op.r });
      }
      this._kick();
    }
    _commit() {
      if (this._done) return;
      this._done = true;
      if (typeof this.oncomplete === 'function') this.oncomplete({ type: 'complete', target: this });
    }
    _abort(err) {
      if (this._done) return;
      this._done = true;
      for (let i = this._journal.length - 1; i >= 0; i--) this._journal[i]();   // roll back
      this.error = err || domErr('AbortError', 'aborted');
      this._queue.length = 0;
      if (typeof this.onabort === 'function') this.onabort({ type: 'abort', target: this });
    }
    abort() { this._abort(domErr('AbortError', 'aborted')); }
  }

  function storeData(tx, n) { return dbs.get(tx.db.name).stores.get(n); }

  class Index {
    constructor(os, name) { this.objectStore = os; this.name = name; }
    _recs(range) {
      const st = storeData(this.objectStore.transaction, this.objectStore.name), ix = st.indexes[this.name];
      const rows = st.records.map((r) => ({ key: r.value[ix.keyPath], pk: r.key, value: r.value })).filter((r) => { try { keyType(r.key); return true; } catch (e) { return false; } });
      rows.sort((a, b) => cmp(a.key, b.key) || cmp(a.pk, b.pk));
      return inRange(rows, range);
    }
    get(q) { return this.objectStore.transaction._req(this, () => { const r = this._recs(asRange(q))[0]; return r ? clone(r.value) : undefined; }); }
    getAll(q, count) { return this.objectStore.transaction._req(this, () => this._recs(asRange(q)).slice(0, count || undefined).map((r) => clone(r.value))); }
    count(q) { return this.objectStore.transaction._req(this, () => this._recs(asRange(q)).length); }
  }

  class ObjectStore {
    constructor(tx, name) { this.transaction = tx; this.name = name; const st = storeData(tx, name); this.keyPath = st.keyPath; this.autoIncrement = !!st.autoIncrement; this.indexNames = nameList(Object.keys(st.indexes)); }
    _st() { return storeData(this.transaction, this.name); }
    _write(value, key, noOverwrite) {
      if (this.transaction.mode === 'readonly') throw domErr('ReadOnlyError', 'read-only transaction');
      const st = this._st();
      if (st.keyPath != null) { if (key !== undefined) throw domErr('DataError', 'in-line key store given a key'); key = value[st.keyPath]; }
      if (key === undefined) { if (!st.autoIncrement) throw domErr('DataError', 'no key'); key = ++st.seq; }
      keyType(key);
      const v = clone(value), k = clone(key), i = lowerIndex(st.records, k), exists = i < st.records.length && cmp(st.records[i].key, k) === 0;
      if (exists && noOverwrite) throw domErr('ConstraintError', 'Key already exists in the object store.');
      for (const [iname, ix] of Object.entries(st.indexes)) {
        if (!ix.unique) continue;
        const ik = v[ix.keyPath];
        if (ik === undefined) continue;
        if (st.records.some((r, j) => !(exists && j === i) && r.value[ix.keyPath] !== undefined && cmp(r.value[ix.keyPath], ik) === 0)) throw domErr('ConstraintError', 'unique index ' + iname);
      }
      if (exists) { const old = st.records[i]; st.records[i] = { key: k, value: v }; this.transaction._journal.push(() => { const j = lowerIndex(st.records, k); st.records[j] = old; }); }
      else { st.records.splice(i, 0, { key: k, value: v }); this.transaction._journal.push(() => { const j = lowerIndex(st.records, k); st.records.splice(j, 1); }); }
      return k;
    }
    put(value, key) { return this.transaction._req(this, () => this._write(value, key, false)); }
    add(value, key) { return this.transaction._req(this, () => this._write(value, key, true)); }
    get(q) { return this.transaction._req(this, () => { const r = inRange(this._st().records, asRange(q))[0]; return r ? clone(r.value) : undefined; }); }
    getAll(q, count) { return this.transaction._req(this, () => inRange(this._st().records, asRange(q)).slice(0, count || undefined).map((r) => clone(r.value))); }
    getAllKeys(q, count) { return this.transaction._req(this, () => inRange(this._st().records, asRange(q)).slice(0, count || undefined).map((r) => clone(r.key))); }
    count(q) { return this.transaction._req(this, () => inRange(this._st().records, asRange(q)).length); }
    delete(q) {
      return this.transaction._req(this, () => {
        if (this.transaction.mode === 'readonly') throw domErr('ReadOnlyError', 'read-only transaction');
        const st = this._st(), range = asRange(q), keep = [], gone = [];
        st.records.forEach((r) => (range.includes(r.key) ? gone : keep).push(r));
        if (gone.length) { const before = st.records; st.records = keep; this.transaction._journal.push(() => { st.records = before; }); }
        return undefined;
      });
    }
    clear() {
      return this.transaction._req(this, () => {
        if (this.transaction.mode === 'readonly') throw domErr('ReadOnlyError', 'read-only transaction');
        const st = this._st(), before = st.records;
        st.records = [];
        this.transaction._journal.push(() => { st.records = before; });
        return undefined;
      });
    }
    openCursor(q, direction) {
      const tx = this.transaction, range = asRange(q), prev = direction === 'prev' || direction === 'prevunique';
      let pos = null, req = null;
      const step = () => {
        const recs = inRange(this._st().records, range);
        let r;
        if (pos === null) r = prev ? recs[recs.length - 1] : recs[0];
        else r = prev ? recs.filter((x) => cmp(x.key, pos) < 0).pop() : recs.find((x) => cmp(x.key, pos) > 0);
        if (!r) return null;
        pos = r.key;
        return { key: clone(r.key), primaryKey: clone(r.key), value: clone(r.value), direction: direction || 'next',
          continue() { tx._queue.push({ r: req, fn: step }); tx._kick(); } };
      };
      req = tx._req(this, step);
      return req;
    }
    index(n) { if (!this._st().indexes[n]) throw domErr('NotFoundError', 'index ' + n); return new Index(this, n); }
    createIndex(n, keyPath, opts) {
      const st = this._st();
      st.indexes[n] = { keyPath, unique: !!(opts && opts.unique) };
      this.indexNames = nameList(Object.keys(st.indexes));
      return new Index(this, n);
    }
  }

  class Connection {
    constructor(name) { this.name = name; this._closed = false; this.onversionchange = null; this.onclose = null; }
    get version() { return dbs.get(this.name).version; }
    get objectStoreNames() { return nameList(Array.from(dbs.get(this.name).stores.keys())); }
    createObjectStore(n, opts) {
      const d = dbs.get(this.name);
      if (d.stores.has(n)) throw domErr('ConstraintError', 'store exists: ' + n);
      d.stores.set(n, { keyPath: opts && opts.keyPath != null ? opts.keyPath : null, autoIncrement: !!(opts && opts.autoIncrement), records: [], indexes: {}, seq: 0 });
      return new ObjectStore(this._upgradeTx, n);
    }
    deleteObjectStore(n) { dbs.get(this.name).stores.delete(n); }
    transaction(names, mode) {
      if (this._closed) throw domErr('InvalidStateError', 'connection closed');
      const list = Array.isArray(names) ? names.slice() : [names];
      const d = dbs.get(this.name);
      list.forEach((n) => { if (!d.stores.has(n)) throw domErr('NotFoundError', 'no store ' + n); });
      return new Transaction(this, list, mode);
    }
    close() { this._closed = true; }
  }

  const indexedDB = {
    open(name, version) {
      const req = new Request(null, null);
      req.onupgradeneeded = null; req.onblocked = null;
      setImmediate(() => {
        try {
          const want = version === undefined ? (dbs.has(name) ? dbs.get(name).version : 1) : version;
          if (dbs.has(name) && dbs.get(name).version > want) throw domErr('VersionError', 'requested version is lower');
          const needs = !dbs.has(name) || dbs.get(name).version < want;
          if (!dbs.has(name)) dbs.set(name, { version: 0, stores: new Map() });
          const conn = new Connection(name);
          req.result = conn; req.readyState = 'done';
          if (needs) {
            const old = dbs.get(name).version;
            dbs.get(name).version = want;
            const utx = new Transaction(conn, Array.from(dbs.get(name).stores.keys()), 'versionchange');
            conn._upgradeTx = utx;
            req.transaction = utx;
            if (typeof req.onupgradeneeded === 'function') req.onupgradeneeded({ type: 'upgradeneeded', target: req, oldVersion: old, newVersion: want });
            utx._names = Array.from(dbs.get(name).stores.keys());
            conn._upgradeTx = null;
          }
          if (typeof req.onsuccess === 'function') req.onsuccess({ type: 'success', target: req });
        } catch (e) {
          req.error = e; req.readyState = 'done';
          if (typeof req.onerror === 'function') req.onerror({ type: 'error', target: req });
        }
      });
      return req;
    },
    deleteDatabase(name) {
      const req = new Request(null, null);
      setImmediate(() => { dbs.delete(name); req.readyState = 'done'; if (typeof req.onsuccess === 'function') req.onsuccess({ type: 'success', target: req }); });
      return req;
    },
    databases() { return Promise.resolve(Array.from(dbs.entries()).map(([name, d]) => ({ name, version: d.version }))); },
    cmp,
  };

  return {
    indexedDB, IDBKeyRange,
    // Test helper: {dbName: {storeName: count}}
    dump() { const o = {}; dbs.forEach((d, n) => { o[n] = {}; d.stores.forEach((s, sn) => { o[n][sn] = s.records.length; }); }); return o; },
    records(db, store) { const d = dbs.get(db); const s = d && d.stores.get(store); return s ? s.records.map((r) => ({ key: clone(r.key), value: clone(r.value) })) : []; },
  };
}

module.exports = { createIndexedDB, IDBKeyRange, cmp };
