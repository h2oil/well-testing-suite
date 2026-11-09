#!/usr/bin/env node
'use strict';
// server/db/migrate.js — applies server/db/migrations/NNN-*.sql in order, each in its own transaction, recording them in
// public.wts_schema_migrations (name, sha256, applied_at). A recorded file whose content changed is refused (migrations are
// never edited after release). Used by the manual tagged migration job (§13.8) and by the server tests.
//
//   node server/db/migrate.js            connection from WTS_MIGRATE_DB_URL (the administrator; never a request credential)
//   require('./migrate').migrate(sql, {dir, log, names?}) → Promise<[applied names]>   (sql = a driver instance from core/db.js;
//        names: apply only these files, each "name" or "name:sha256" — the restore drill rebuilds an export's exact schema)
//   listMigrations(dir) → [{name, file, text, sha}]
//   node server/db/migrate.js --platform   one-login hosting (v4.0, server/README.md "Hosting"): the connection is the
//        database's ONE login (WTS_MIGRATE_DB_URL = the platform's production connection string). Before the migrations the
//        login's capabilities are checked (loginReport: it must be able to create roles, and to create BYPASSRLS roles, or
//        nothing is applied), the wts_* roles are created and granted to the login (prepareLogin: a non-superuser cannot
//        SET ROLE to a role it created without an explicit grant); afterwards the read-only export role
//        (ops/sql/backup-role.sql) is applied and granted the same way. Output: one line per step, never a credential.
//        Last, the role switch of the jobs (wts_jobs) is probed both ways (probeRoleModes): "start-up role ok" (the default
//        works), or "start-up role refused … transaction role ok — set WTS_DB_ROLE_MODE=local on the functions site" (a
//        connection endpoint that refuses start-up parameters; core/db.js roleMode 'local'), or both refused (stop).
//
// Netlify Database (server/README.md "Hosting", "Platform migrations"): there the DEPLOY applies the generated folder
// server/netlify/database/migrations (db/platform-migrations.js, from this folder) — never this script through a direct
// connection. The platform's first file marks public.wts_schema_migrations (a table comment, PLATFORM_MARK); the command line
// below refuses such a database. migrate() itself (the library) stays the path of the tests, the restore drill's scratch
// database and a host without platform migrations.
//   probeRoleModes(url, role?) → {session: true | 'message', local: true | 'message'}
//   platformManaged(sql) → Promise<boolean>   true when the platform deploy migrates this database
//   loginReport(sql) → {user, superuser, createrole, bypassrls, ok, problems:[text]}
//   prepareLogin(sql, {backupRole}) → [granted roles]

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
  let list = listMigrations(o.dir);
  if (o.names) {
    const want = new Map(o.names.map((n) => { const [name, sha] = String(n).split(':'); return [name, sha || null]; }));
    want.forEach((sha, name) => {
      const m = list.find((x) => x.name === name);
      if (!m) throw new Error('migrate: ' + name + ' is not in this release');
      if (sha && sha !== m.sha) throw new Error('migrate: ' + name + ' differs from the one recorded in the export');
    });
    list = list.filter((m) => want.has(m.name));
  }
  for (const m of list) {
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

// the table comment written by server/netlify/database/migrations/0000_platform_roles.sql (db/platform-migrations.js)
async function platformManaged(sql) {
  const r = await sql`select obj_description(to_regclass('public.wts_schema_migrations'), 'pg_class') as c`;
  return /migrated by the platform deploy/.test(String((r[0] && r[0].c) || ''));
}

const RUN_ROLES = ['wts_owner', 'wts_definer', 'wts_api', 'wts_jobs', 'wts_support'];
const INHERITED = ['wts_owner', 'wts_definer'];

async function loginReport(sql) {
  const r = (await sql`select current_user as u, rolsuper, rolcreaterole, rolbypassrls from pg_roles where rolname = current_user`)[0];
  const problems = [];
  if (!r.rolsuper && !r.rolcreaterole) problems.push('the login cannot create roles (CREATEROLE) — the plan\'s separate roles cannot be made');
  if (!r.rolsuper && !r.rolbypassrls) problems.push('the login cannot create BYPASSRLS roles (wts_definer, wts_jobs) — see server/README.md "Hosting", fallback');
  return { user: r.u, superuser: !!r.rolsuper, createrole: !!r.rolcreaterole, bypassrls: !!r.rolbypassrls, ok: problems.length === 0, problems };
}
// the roles block of 001-schema.sql (created only when absent), then each role granted to the login (non-superusers only)
async function prepareLogin(sql, o) {
  o = o || {};
  const rep = await loginReport(sql);
  if (!rep.ok) throw new Error('migrate: ' + rep.problems.join('; '));
  const first = fs.readFileSync(path.join(DIR, '001-schema.sql'), 'utf8');
  const m = /DO \$roles\$[\s\S]*?\$roles\$;/.exec(first);
  if (!m) throw new Error('migrate: roles block not found in 001-schema.sql');
  await sql.unsafe(m[0]);
  if (rep.superuser) return [];
  const want = RUN_ROLES.concat(o.backupRole ? ['wts_backup'] : []);
  const have = new Set((await sql`select r.rolname from pg_auth_members a join pg_roles r on r.oid = a.roleid
    join pg_roles me on me.oid = a.member where me.rolname = current_user and a.set_option
    and (a.inherit_option or not (r.rolname = any(${INHERITED})))`).map((x) => x.rolname));
  const granted = [];
  for (const role of want) {
    if (have.has(role)) continue;
    if (!(await sql`select 1 from pg_roles where rolname = ${role}`).length) continue;
    // the migrator acts with the owner's and the definer's rights (as a superuser migrator would); the run-time roles are
    // only ever entered with SET ROLE, never inherited
    await sql.unsafe('GRANT ' + role + ' TO CURRENT_USER WITH SET TRUE, INHERIT ' + (INHERITED.includes(role) ? 'TRUE' : 'FALSE'));
    granted.push(role);
  }
  return granted;
}

// the jobs' role switch: the start-up parameter (roleMode session) and the per-transaction fallback (roleMode local)
async function probeRoleModes(url, role) {
  const { createDb } = require('../core/db');
  role = role || 'wts_jobs';
  const out = {};
  for (const mode of ['session', 'local']) {
    const d = createDb(url, { role, sessionRole: true, roleMode: mode, max: 1, connectTimeout: 10 });
    try { await d.checkRole(); out[mode] = true; } catch (e) { out[mode] = String((e && e.message) || e).replace(/postgres(ql)?:\/\/\S+/g, '<url>').slice(0, 200); }
    try { await d.close(); } catch (e) { /* closed */ }
  }
  return out;
}

module.exports = { migrate, listMigrations, loginReport, prepareLogin, probeRoleModes, platformManaged, RUN_ROLES, DIR };

if (require.main === module) {
  const url = process.env.WTS_MIGRATE_DB_URL;
  if (!url) { console.error('[migrate] WTS_MIGRATE_DB_URL is not set'); process.exit(2); }
  const platform = process.argv.includes('--platform');
  const { createDb } = require('../core/db');
  const db = createDb(url, { max: 1 });
  (async () => {
    if (await platformManaged(db.sql)) {
      console.error('[migrate] this database is migrated by the platform deploy (server/netlify/database/migrations) — refused; never apply DDL to it through a direct connection');
      process.exitCode = 2; await db.close(); return;
    }
    if (platform) {
      const rep = await loginReport(db.sql);
      console.log('[migrate] login ' + rep.user + ': superuser ' + rep.superuser + ', createrole ' + rep.createrole + ', bypassrls ' + rep.bypassrls);
      const g = await prepareLogin(db.sql);
      console.log('[migrate] roles ready' + (g.length ? ' (granted to the login: ' + g.join(', ') + ')' : ''));
    }
    const a = await migrate(db.sql, { log: console });
    console.log('[migrate] ' + a.length + ' applied');
    if (platform) {
      await db.sql.unsafe(fs.readFileSync(path.join(__dirname, '..', 'ops', 'sql', 'backup-role.sql'), 'utf8'));
      const g = await prepareLogin(db.sql, { backupRole: true });
      console.log('[migrate] export role ready' + (g.length ? ' (granted: ' + g.join(', ') + ')' : ''));
      const p = await probeRoleModes(url);
      if (p.session === true) console.log('[migrate] start-up role ok');
      else if (p.local === true) console.log('[migrate] start-up role refused (' + p.session + '); transaction role ok — set WTS_DB_ROLE_MODE=local on the functions site');
      else { console.error('[migrate] start-up role refused (' + p.session + ') and transaction role refused (' + p.local + ') — stop and tell the developer'); process.exitCode = 1; }
    }
    await db.close();
  })().catch((e) => { console.error('[migrate] ' + e.message); db.close().finally(() => process.exit(1)); });
}
