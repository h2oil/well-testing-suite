#!/usr/bin/env node
'use strict';
// server/ops/weekly-export.js — the weekly encrypted logical export (docs/ACCOUNTS-PLAN.md §13.5; procedure in
// server/RUNBOOK.md, "Backups"). Run weekly by the jobs host's scheduler (site/site.json "weekly-export"), never by the static
// site and never from the release workflow.
//
//   WTS_BACKUP_DB_URL=… WTS_BACKUP_KEY=kid:base64 WTS_EXPORT_DIR=<separate store> [WTS_OBJECTS_DIR=<blob store folder>]
//   [WTS_PG_BIN=<engine tools>] [WTS_EXPORT_RETAIN_DAYS=28] node server/ops/weekly-export.js
//
// Output: one JSON line {ok, file, bytes, pruned, counts…} — ids, counts and file names only. Exit 1 on any failure (the
// monitor's exportAge alert fires after 8 days without a new file).

const { exportDatabase, writeExport, parseKeys } = require('../site/backup');

async function main(env) {
  env = env || process.env;
  if (!env.WTS_BACKUP_DB_URL) throw new Error('WTS_BACKUP_DB_URL is not set');
  const keys = parseKeys(env.WTS_BACKUP_KEY);
  let objects = null;
  if (env.WTS_OBJECTS_DIR) objects = require('../core/objects').fsObjects(env.WTS_OBJECTS_DIR);
  const r = await exportDatabase({ conn: env.WTS_BACKUP_DB_URL, pgBin: env.WTS_PG_BIN || null, objects });
  const w = writeExport({ entries: r.entries, keys, dir: env.WTS_EXPORT_DIR, retainDays: env.WTS_EXPORT_RETAIN_DAYS == null ? 28 : Number(env.WTS_EXPORT_RETAIN_DAYS) });
  return { ok: true, file: require('path').basename(w.file), bytes: w.bytes, pruned: w.pruned, counts: r.manifest.counts, objects: r.manifest.objects, blobKeys: r.manifest.blobKeys };
}

module.exports = { main };

if (require.main === module) {
  main().then((r) => { process.stdout.write(JSON.stringify(r) + '\n'); },
    (e) => { process.stderr.write(JSON.stringify({ ok: false, error: String(e.message || e) }) + '\n'); process.exitCode = 1; });
}
