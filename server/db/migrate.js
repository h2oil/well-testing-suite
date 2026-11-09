#!/usr/bin/env node
'use strict';
// server/db/migrate.js — applies server/db/migrations/NNN-*.sql in order, each in its own transaction, recording them in
// public.wts_schema_migrations (name, sha256, applied_at). A recorded file whose content changed is refused (migrations are
// never edited after release). Used by the manual tagged migration job (§13.8) and by the server tests.
//
//   node server/db/migrate.js            connection from WTS_MIGRATE_DB_URL (the administrator; never a request credential)
//   require('./migrate').migrate(sql, {dir, log}) → Promise<[applied names]>   (sql = a driver instance from core/db.js)
//   listMigrations(dir) → [{name, file, text, sha}]

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(__dirname, 'migrations');

function listMigrations(dir) {
  dir = dir || DIR;
  return fs.readdirSync(dir).filter((f) => /^\d{3}-[a-z0-9-]+\.sql$/.test(f)).sort().map((name) => {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    return { name, file: path.join(dir, name), text, sha: crypto.createHash('sha256').update(text).digest('hex') };
  });
}

async function migrate(sql, o) {
  o = o || {};
  const log = o.log || { log() {} };
  await sql.unsafe('CREATE TABLE IF NOT EXISTS public.wts_schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Map((await sql`select name, sha256 from public.wts_schema_migrations`).map((r) => [r.name, r.sha256]));
  const applied = [];
  for (const m of listMigrations(o.dir)) {
    if (done.has(m.name)) {
      if (done.get(m.name) !== m.sha) throw new Error('migrate: ' + m.name + ' changed after it was applied');
      continue;
    }
    await sql.begin(async (tx) => {
      await tx.unsafe(m.text);
      await tx`insert into public.wts_schema_migrations (name, sha256) values (${m.name}, ${m.sha})`;
    });
    log.log('[migrate] applied ' + m.name);
    applied.push(m.name);
  }
  return applied;
}

module.exports = { migrate, listMigrations, DIR };

if (require.main === module) {
  const url = process.env.WTS_MIGRATE_DB_URL;
  if (!url) { console.error('[migrate] WTS_MIGRATE_DB_URL is not set'); process.exit(2); }
  const { createDb } = require('../core/db');
  const db = createDb(url, { max: 1 });
  migrate(db.sql, { log: console }).then((a) => { console.log('[migrate] ' + a.length + ' applied'); return db.close(); })
    .catch((e) => { console.error('[migrate] ' + e.message); db.close().finally(() => process.exit(1)); });
}
