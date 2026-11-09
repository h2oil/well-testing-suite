'use strict';
// server/site/objects-loader.js — the ONE place that chooses the blob store for the API entry and the operations scripts
// (docs/ACCOUNTS-PLAN.md §2, §13.5; WP-OPS). Used by site/handler.js (the functions-site entry), ops/weekly-export.js and
// ops/ledger-replay.js, so the weekly export and the ledger replay read the same store the API writes.
//
//   loadObjects(env, {required?, root?}) → {objects, kind: 'binding' | 'folder' | 'none', source}
//     1. the host binding module: WTS_OBJECTS_BINDING (a .js path relative to the server folder — server/ in the repository,
//        dist/ in the bundle — non-secret), else site/objects-binding.js when that file exists. The module exports
//        createStore(env) → the host blob store {get, set, delete, list({prefix})}; it reads its own credential from the
//        environment (WTS_OBJECTS_CREDENTIAL), so committing the module is safe. Wrapped by site/adapters.js hostObjects()
//        (every key validated).
//     2. WTS_OBJECTS_DIR → the folder store of core/objects.js (local runs, drills).
//     3. none: {objects:null, kind:'none'} — or, with required:true, an error ("no object store configured").
//   A binding or folder that is configured but cannot be loaded is always an error (never a silent fall-through).

const fs = require('fs');
const path = require('path');
const A = require('./adapters');

const SERVER = require('../core/root').SERVER_ROOT;
const BINDING_RE = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,200}\.js$/;
const DEFAULT_BINDING = 'site/objects-binding.js';

function bindingPath(env, root) {
  const rel = env.WTS_OBJECTS_BINDING ? String(env.WTS_OBJECTS_BINDING).trim() : '';
  if (rel) {
    if (!BINDING_RE.test(rel) || rel.split('/').includes('..')) throw new Error('objects: WTS_OBJECTS_BINDING must be a .js path inside the server folder');
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) throw new Error('objects: WTS_OBJECTS_BINDING names a file that does not exist (' + rel + ')');
    return { p, rel };
  }
  const p = path.join(root, DEFAULT_BINDING);
  return fs.existsSync(p) ? { p, rel: DEFAULT_BINDING } : null;
}

function loadObjects(env, o) {
  env = env || process.env; o = o || {};
  const root = o.root || SERVER;
  const b = bindingPath(env, root);
  if (b) {
    const mod = require(b.p);
    if (!mod || typeof mod.createStore !== 'function') throw new Error('objects: ' + b.rel + ' must export createStore(env)');
    return { objects: A.hostObjects(mod.createStore(env)), kind: 'binding', source: b.rel };
  }
  if (env.WTS_OBJECTS_DIR) {
    let core = null;
    try { core = require('../core/objects'); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; }
    if (!core || typeof core.fsObjects !== 'function') throw new Error('objects: WTS_OBJECTS_DIR is set but this build has no folder store (core/objects.js)');
    return { objects: core.fsObjects(env.WTS_OBJECTS_DIR), kind: 'folder', source: 'WTS_OBJECTS_DIR' };
  }
  if (o.required) throw new Error('objects: no object store configured (WTS_OBJECTS_BINDING, ' + DEFAULT_BINDING + ' or WTS_OBJECTS_DIR)');
  return { objects: null, kind: 'none', source: null };
}

module.exports = { loadObjects, DEFAULT_BINDING };
