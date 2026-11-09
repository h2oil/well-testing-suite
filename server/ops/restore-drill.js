#!/usr/bin/env node
'use strict';
// server/ops/restore-drill.js — the restore drill (docs/ACCOUNTS-PLAN.md §13.1, §13.4, §13.5; server/RUNBOOK.md "Restore drill").
// Quarterly, and before the invite beta (the FIRST drill). Restores one weekly export into an isolated scratch database that
// is created for the drill and dropped afterwards — never production — replays the deletion ledger, and compares the result
// with the export's manifest.
//
//   WTS_BACKUP_KEY=kid:base64[,kid:base64] WTS_DRILL_ADMIN_URL=<administrator of a scratch cluster on this machine>
//   [WTS_PG_BIN=<engine tools>] node server/ops/restore-drill.js <export file | --latest <dir> | --from-store> [--allow-remote-scratch]
//   A weekly export written by the functions site (format 'copy', sealed to the owner's public key) is opened with
//   WTS_BACKUP_PRIVATE_KEY=kid:base64 instead of (or beside) WTS_BACKUP_KEY. --from-store reads the newest export from the
//   exports store (site/netlify-blobs.js 'wts-exports'; WTS_BLOBS_SITE_ID + WTS_OBJECTS_CREDENTIAL outside the site).
//
// Output: one JSON report {ok, scratch, tables, mismatches, ledger:{objects, replayed, remaining}, restoreMs, dropped}. Record
// it with the date in PROJECT-NOTES.md (the restore time is the measured recovery time). Exit 1 unless ok.

const path = require('path');
const { restoreDrill, parseKeys, parsePrivateKeys, newestExport, newestExportInStore } = require('../site/backup');

function drillKeys(env) {
  let keys = [];
  if (env.WTS_BACKUP_KEY) keys = keys.concat(parseKeys(env.WTS_BACKUP_KEY));
  if (env.WTS_BACKUP_PRIVATE_KEY) keys = keys.concat(parsePrivateKeys(env.WTS_BACKUP_PRIVATE_KEY));
  if (!keys.length) throw new Error('WTS_BACKUP_PRIVATE_KEY (or WTS_BACKUP_KEY) is not set');
  return keys;
}

async function main(argv, env) {
  env = env || process.env;
  const a = argv || process.argv.slice(2);
  let file = a.find((x) => !x.startsWith('--') && a[a.indexOf(x) - 1] !== '--latest');
  const li = a.indexOf('--latest');
  if (li !== -1) {
    const dir = a[li + 1];
    const n = dir && newestExport(dir);
    if (!n) throw new Error('no export file in ' + dir);
    file = path.join(dir, n.name);
  }
  let buf = null;
  if (a.includes('--from-store')) {
    const { hostObjects } = require('../site/adapters');
    const store = hostObjects(require('../site/netlify-blobs').createStore(env, { name: 'wts-exports' }));
    const n = await newestExportInStore(store);
    if (!n) throw new Error('no export in the exports store');
    buf = await store.get(n.key); file = n.name;
  }
  if (!file) throw new Error('usage: restore-drill.js <export file> | --latest <dir> | --from-store');
  const report = await restoreDrill({ file: buf ? null : file, buf, keys: drillKeys(env), adminUrl: env.WTS_DRILL_ADMIN_URL, pgBin: env.WTS_PG_BIN || null,
    allowRemote: a.includes('--allow-remote-scratch'), env });
  report.file = path.basename(file);
  return report;
}

module.exports = { main, drillKeys };

if (require.main === module) {
  main().then((r) => { process.stdout.write(JSON.stringify(r) + '\n'); process.exitCode = r.ok ? 0 : 1; },
    (e) => { process.stderr.write(JSON.stringify({ ok: false, error: String(e.message || e) }) + '\n'); process.exitCode = 1; });
}
