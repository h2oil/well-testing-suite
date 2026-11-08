#!/usr/bin/env node
'use strict';
// server/ops/restore-drill.js — the restore drill (docs/ACCOUNTS-PLAN.md §13.1, §13.4, §13.5; server/RUNBOOK.md "Restore drill").
// Quarterly, and before the invite beta (the FIRST drill). Restores one weekly export into an isolated scratch database that
// is created for the drill and dropped afterwards — never production — replays the deletion ledger, and compares the result
// with the export's manifest.
//
//   WTS_BACKUP_KEY=kid:base64[,kid:base64] WTS_DRILL_ADMIN_URL=<administrator of a scratch cluster on this machine>
//   [WTS_PG_BIN=<engine tools>] node server/ops/restore-drill.js <export file | --latest <dir>> [--allow-remote-scratch]
//
// Output: one JSON report {ok, scratch, tables, mismatches, ledger:{objects, replayed, remaining}, restoreMs, dropped}. Record
// it with the date in PROJECT-NOTES.md (the restore time is the measured recovery time). Exit 1 unless ok.

const path = require('path');
const { restoreDrill, parseKeys, newestExport } = require('../site/backup');

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
  if (!file) throw new Error('usage: restore-drill.js <export file> | --latest <dir>');
  const report = await restoreDrill({ file, keys: parseKeys(env.WTS_BACKUP_KEY), adminUrl: env.WTS_DRILL_ADMIN_URL, pgBin: env.WTS_PG_BIN || null,
    allowRemote: a.includes('--allow-remote-scratch'), env });
  report.file = path.basename(file);
  return report;
}

module.exports = { main };

if (require.main === module) {
  main().then((r) => { process.stdout.write(JSON.stringify(r) + '\n'); process.exitCode = r.ok ? 0 : 1; },
    (e) => { process.stderr.write(JSON.stringify({ ok: false, error: String(e.message || e) }) + '\n'); process.exitCode = 1; });
}
