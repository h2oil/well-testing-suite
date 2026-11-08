#!/usr/bin/env node
'use strict';
// server/ops/weekly-export.js — the weekly encrypted logical export (docs/ACCOUNTS-PLAN.md §13.5; procedure in
// server/RUNBOOK.md, "Backups"). Run weekly by the jobs host's scheduler (site/site.json "weekly-export"), never by the static
// site and never from the release workflow.
//
//   WTS_BACKUP_DB_URL=… WTS_BACKUP_KEY=kid:base64 WTS_EXPORT_DIR=<separate store>
//   [WTS_OBJECTS_BINDING=<binding module> | site/objects-binding.js | WTS_OBJECTS_DIR=<blob store folder>]
//   [WTS_PG_BIN=<engine tools>] [WTS_EXPORT_RETAIN_DAYS=28] node server/ops/weekly-export.js [--no-objects]
//
// The blob store is chosen by site/objects-loader.js — the same store the API writes — because plan §13.5 requires the
// deletion ledger and the audit anchors in EVERY weekly export. Without a configured store the export fails (exit 1);
// `--no-objects` exports the database alone on purpose and records objects:'none' in the manifest.
//
// Output: one JSON line {ok, file, bytes, pruned, counts…} — ids, counts and file names only. Exit 1 on any failure (the
// monitor's exportAge alert fires after 8 days without a new file).

const path = require('path');
const { exportDatabase, writeExport, parseKeys } = require('../site/backup');
const { loadObjects } = require('../site/objects-loader');

async function main(env, argv) {
  env = env || process.env;
  const a = argv || process.argv.slice(2);
  if (!env.WTS_BACKUP_DB_URL) throw new Error('WTS_BACKUP_DB_URL is not set');
  const keys = parseKeys(env.WTS_BACKUP_KEY);
  if (!env.WTS_EXPORT_DIR) throw new Error('WTS_EXPORT_DIR is not set');
  const noObjects = a.includes('--no-objects');
  const store = noObjects ? { objects: null, kind: 'none' } : loadObjects(env, { required: true });
  const r = await exportDatabase({ conn: env.WTS_BACKUP_DB_URL, pgBin: env.WTS_PG_BIN || null, objects: store.objects });
  const w = writeExport({ entries: r.entries, keys, dir: env.WTS_EXPORT_DIR, retainDays: env.WTS_EXPORT_RETAIN_DAYS == null ? 28 : Number(env.WTS_EXPORT_RETAIN_DAYS) });
  return { ok: true, file: path.basename(w.file), bytes: w.bytes, pruned: w.pruned, counts: r.manifest.counts, objects: r.manifest.objects, store: store.kind, blobKeys: r.manifest.blobKeys };
}

module.exports = { main };

if (require.main === module) {
  main().then((r) => { process.stdout.write(JSON.stringify(r) + '\n'); },
    (e) => { process.stderr.write(JSON.stringify({ ok: false, error: String(e.message || e) }) + '\n'); process.exitCode = 1; });
}
