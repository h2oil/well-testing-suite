#!/usr/bin/env node
'use strict';
// server/ops/export-fetch.js — copies the newest weekly export (format 'copy', sealed to WTS_BACKUP_PUBLIC_KEY) from the
// exports store of the functions site to a local folder, for the monthly offline copy and the restore drill (v4.0;
// server/RUNBOOK.md §3N step 14). The file stays sealed: only WTS_BACKUP_PRIVATE_KEY opens it, and this script never needs it.
//
//   WTS_BLOBS_SITE_ID=<the functions site's Project ID> WTS_OBJECTS_CREDENTIAL=<a personal access token>
//   node server/ops/export-fetch.js <folder>
//
// Output: one JSON line {ok, file, bytes} — the file name and size only.

const fs = require('fs');
const path = require('path');

async function main(argv, env, deps) {
  env = env || process.env; deps = deps || {};
  const dir = (argv || process.argv.slice(2))[0];
  if (!dir) throw new Error('usage: export-fetch.js <folder>');
  const { hostObjects } = require('../site/adapters');
  const { newestExportInStore } = require('../site/backup');
  const store = hostObjects(require('../site/netlify-blobs').createStore(env, { name: 'wts-exports', getStore: deps.getStore }));
  const n = await newestExportInStore(store);
  if (!n) throw new Error('no export in the exports store');
  const buf = await store.get(n.key);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, n.name);
  fs.writeFileSync(file + '.part', buf, { mode: 0o600 });
  fs.renameSync(file + '.part', file);
  return { ok: true, file: n.name, bytes: buf.length };
}

module.exports = { main };

if (require.main === module) {
  main().then((r) => { process.stdout.write(JSON.stringify(r) + '\n'); },
    (e) => { process.stderr.write(JSON.stringify({ ok: false, error: String(e.message || e) }) + '\n'); process.exitCode = 1; });
}
