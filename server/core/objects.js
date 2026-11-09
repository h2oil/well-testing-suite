'use strict';
// server/core/objects.js — the object (blob) store seam (docs/ACCOUNTS-PLAN.md D2, §3.4 blob object keys, §13.5 ledger and
// anchor objects). The host's blob store adapter is written by WP-OPS against this interface; the server core only ever
// builds keys from the SESSION's user id (never from the request), so one account can never name another's objects.
//
//   interface ObjectStore { put(key, Buffer) → Promise, get(key) → Promise<Buffer|null>, del(key) → Promise,
//                           list(prefix) → Promise<[key]>, delPrefix(prefix) → Promise<n> }
//   memoryObjects()       in-process (tests, the fake server)
//   fsObjects(root)       a folder (local runs, restore drills); keys map to files below root, nothing outside it
//   KEYS                  blob(uid, hex, n) 'u/<uid>/b/<hex>/<n>' · library(uid, hex) 'u/<uid>/lib/<hex>' · user(uid) 'u/<uid>/'
//                         ledger(uid) 'ledger/<uid>' · chain(date) 'chain/<YYYY-MM-DD>'

const fs = require('fs');
const path = require('path');

const KEY_RE = /^(u\/[0-9a-f-]{36}\/(b\/[0-9a-f]{64}\/\d{1,6}|lib\/[0-9a-f]{64})|ledger\/[0-9a-f-]{36}|chain\/\d{4}-\d{2}-\d{2})$/;
const PREFIX_RE = /^(u\/[0-9a-f-]{36}\/((b\/([0-9a-f]{64}\/)?)|lib\/)?|ledger\/|chain\/)$/;
function checkKey(k) { if (typeof k !== 'string' || !KEY_RE.test(k)) throw new Error('objects: bad key'); return k; }
function checkPrefix(p) { if (typeof p !== 'string' || !PREFIX_RE.test(p)) throw new Error('objects: bad prefix'); return p; }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEYS = {
  blob(uid, hex, n) { if (!UUID.test(uid)) throw new Error('objects: user id'); return checkKey('u/' + uid + '/b/' + hex + '/' + n); },
  blobPrefix(uid, hex) { return checkPrefix('u/' + uid + '/b/' + hex + '/'); },
  library(uid, hex) { if (!UUID.test(uid)) throw new Error('objects: user id'); return checkKey('u/' + uid + '/lib/' + hex); },
  user(uid) { if (!UUID.test(uid)) throw new Error('objects: user id'); return checkPrefix('u/' + uid + '/'); },
  ledger(uid) { return checkKey('ledger/' + uid); },
  chain(date) { return checkKey('chain/' + date); },
};

function memoryObjects() {
  const m = new Map();
  return {
    kind: 'memory', map: m,
    async put(k, buf) { checkKey(k); m.set(k, Buffer.from(buf)); },
    async get(k) { checkKey(k); const v = m.get(k); return v ? Buffer.from(v) : null; },
    async del(k) { checkKey(k); m.delete(k); },
    async list(p) { checkPrefix(p); return Array.from(m.keys()).filter((k) => k.startsWith(p)).sort(); },
    async delPrefix(p) { checkPrefix(p); let n = 0; for (const k of Array.from(m.keys())) if (k.startsWith(p)) { m.delete(k); n++; } return n; },
  };
}

function fsObjects(root) {
  const base = path.resolve(root);
  const file = (k) => { const f = path.resolve(base, k); if (!f.startsWith(base + path.sep)) throw new Error('objects: outside root'); return f; };
  async function walk(dir, out) {
    let ents = [];
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { return out; }
    for (const e of ents) { const f = path.join(dir, e.name); if (e.isDirectory()) await walk(f, out); else out.push(path.relative(base, f).split(path.sep).join('/')); }
    return out;
  }
  return {
    kind: 'fs',
    async put(k, buf) { const f = file(checkKey(k)); await fs.promises.mkdir(path.dirname(f), { recursive: true }); const t = f + '.tmp' + process.pid; await fs.promises.writeFile(t, buf); await fs.promises.rename(t, f); },
    async get(k) { try { return await fs.promises.readFile(file(checkKey(k))); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } },
    async del(k) { try { await fs.promises.unlink(file(checkKey(k))); } catch (e) { if (e.code !== 'ENOENT') throw e; } },
    async list(p) { checkPrefix(p); return (await walk(base, [])).filter((k) => k.startsWith(p) && KEY_RE.test(k)).sort(); },
    async delPrefix(p) { const ks = await this.list(p); for (const k of ks) await this.del(k); return ks.length; },
  };
}

module.exports = { KEYS, memoryObjects, fsObjects, checkKey };
