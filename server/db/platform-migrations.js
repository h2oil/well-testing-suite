#!/usr/bin/env node
'use strict';
// server/db/platform-migrations.js — GENERATES server/netlify/database/migrations/ from server/db/migrations/ (the source of
// truth). Netlify Database applies that folder itself at each production deploy, in lexicographic order, and records what it
// applied; an applied file must never change or disappear, and a failure blocks the publish (server/README.md "Hosting",
// "Platform migrations"). Agents and scripts never apply DDL to the platform database through a direct connection.
//
//   node server/db/platform-migrations.js --write   (re)writes the folder; refuses to change or drop a file that exists
//                                                   unless --force (only for a backend that has never been deployed)
//   node server/db/platform-migrations.js --check   exit 1 unless the folder equals what --write would produce
//   require('./platform-migrations').build(dir?) → [{name, text, source?}]   (pure; no file system writes)
//
// Names: the source NNN-slug.sql becomes NNN0_slug.sql (hyphens → underscores), so every source file keeps its order and the
// slots ending in a non-zero digit belong to the platform's own steps, which no source file can ever take:
//   0000_platform_roles.sql          before everything: the login's capability check (fails with a clear message, nothing
//                                    applied), the wts_* roles (the roles block of 001-schema.sql, created only when absent),
//                                    each granted to the login (owner / definer inherited, the run-time roles SET only — what
//                                    db/migrate.js --platform prepareLogin does) and public.wts_schema_migrations, marked
//                                    (PLATFORM_MARK, a table comment) so db/migrate.js refuses a direct run on this database
//   NNN0_<slug>.sql                  BEGIN; the source body BYTE-IDENTICAL; RESET ROLE; the source's name and sha256 recorded in
//                                    public.wts_schema_migrations (so the weekly export manifest and the restore drill see the
//                                    same history as a db/migrate.js database); COMMIT;
//   0501_platform_export_role.sql    after 050: ops/sql/backup-role.sql byte-identical (the read-only export role) and its grant
//                                    to the login (SET only)
// Every file runs in its OWN explicit transaction (BEGIN … COMMIT), whether or not the platform's runner opens one: the bodies
// use SET LOCAL (role, search_path), which outside a transaction would silently do nothing and create objects in the wrong
// schema with the wrong owner. On an error the transaction is aborted and the rest of the file is skipped — never half-applied.
// Everything is idempotent where it touches cluster-wide state (roles, memberships) and safe when run by the database owner
// login that the platform hands out (a non-superuser with CREATEROLE and BYPASSRLS; a superuser needs no grant).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { listMigrations, RUN_ROLES } = require('./migrate');

const OUT = path.join(__dirname, '..', 'netlify', 'database', 'migrations');
const SRC = path.join(__dirname, 'migrations');
const BACKUP_SQL = path.join(__dirname, '..', 'ops', 'sql', 'backup-role.sql');
const INHERITED = ['wts_owner', 'wts_definer'];
const PLATFORM_RE = /^(0000|\d{3}[1-9])_platform_[a-z0-9_]+\.sql$/;
const NAME_RE = /^\d+_[a-z0-9_]+\.sql$/;
const PLATFORM_MARK = 'wts: migrated by the platform deploy from server/netlify/database/migrations';

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
function platformName(src) {
  const m = /^(\d{3})-([a-z0-9-]+)\.sql$/.exec(src);
  if (!m) throw new Error('platform-migrations: unexpected source name ' + src);
  return m[1] + '0_' + m[2].replace(/-/g, '_') + '.sql';
}
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";

// the GRANT of each role to the login, skipped when an equivalent membership exists (prepareLogin's rule)
function grantBlock(tag, roles) {
  const arr = 'ARRAY[' + roles.map(lit).join(', ') + ']';
  return 'DO $' + tag + '$\n' +
    'DECLARE r text;\n' +
    'BEGIN\n' +
    '  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN RETURN; END IF;\n' +
    '  FOREACH r IN ARRAY ' + arr + ' LOOP\n' +
    '    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);\n' +
    '    CONTINUE WHEN EXISTS (SELECT 1 FROM pg_auth_members a JOIN pg_roles g ON g.oid = a.roleid JOIN pg_roles me ON me.oid = a.member\n' +
    '      WHERE me.rolname = current_user AND g.rolname = r AND a.set_option\n' +
    '        AND (a.inherit_option OR NOT (r = ANY (ARRAY[' + INHERITED.map(lit).join(', ') + ']))));\n' +
    "    EXECUTE format('GRANT %I TO CURRENT_USER WITH SET TRUE, INHERIT %s', r,\n" +
    "      CASE WHEN r = ANY (ARRAY[" + INHERITED.map(lit).join(', ') + "]) THEN 'TRUE' ELSE 'FALSE' END);\n" +
    '  END LOOP;\n' +
    'END\n' +
    '$' + tag + '$;\n';
}

function rolesFile(src001) {
  const m = /DO \$roles\$[\s\S]*?\$roles\$;/.exec(src001);
  if (!m) throw new Error('platform-migrations: roles block not found in 001-schema.sql');
  return [
    '-- server/netlify/database/migrations/0000_platform_roles.sql — GENERATED by server/db/platform-migrations.js; never edit.',
    '-- The platform step before the first migration (what db/migrate.js --platform does before migrate()): the login must be',
    '-- able to create the wts_* roles (CREATEROLE) including the BYPASSRLS ones (wts_definer, wts_jobs), or this file fails',
    '-- with a clear message and NOTHING is applied (the deploy is not published). Fallback: server/README.md "Hosting".',
    '-- Then the roles (created only when absent; the roles block of 001-schema.sql), each granted to the login (a non-superuser',
    '-- cannot SET ROLE to a role it created without an explicit grant), and the migration record table. Idempotent.',
    'BEGIN;',
    '',
    'DO $platform$',
    'DECLARE me record;',
    'BEGIN',
    '  SELECT rolsuper, rolcreaterole, rolbypassrls INTO me FROM pg_roles WHERE rolname = current_user;',
    '  IF me.rolsuper THEN RETURN; END IF;',
    "  IF current_setting('server_version_num')::int < 160000 THEN",
    "    RAISE EXCEPTION 'wts platform migrations: PostgreSQL 16 or newer is needed for a non-superuser migration login'",
    "      USING HINT = 'see server/README.md \"Hosting\" (platform migrations)';",
    '  END IF;',
    '  IF NOT me.rolcreaterole THEN',
    "    RAISE EXCEPTION 'wts platform migrations: the login % cannot create roles (CREATEROLE) — nothing was applied', current_user",
    "      USING HINT = 'the plan''s separate roles cannot be made; see server/README.md \"Hosting\", fallback';",
    '  END IF;',
    '  IF NOT me.rolbypassrls THEN',
    "    RAISE EXCEPTION 'wts platform migrations: the login % cannot create BYPASSRLS roles (wts_definer, wts_jobs) — nothing was applied', current_user",
    "      USING HINT = 'fallback: permissive policies TO wts_definer / wts_jobs in a new migration, see server/README.md \"Hosting\"';",
    '  END IF;',
    'END',
    '$platform$;',
    '',
    m[0],
    '',
    grantBlock('grants', RUN_ROLES),
    'CREATE TABLE IF NOT EXISTS public.wts_schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());',
    '-- the marker db/migrate.js reads: this database is migrated by the platform deploy, never by a direct connection',
    'COMMENT ON TABLE public.wts_schema_migrations IS ' + lit(PLATFORM_MARK) + ';',
    '',
    'COMMIT;',
    '',
  ].join('\n');
}

// Files already applied on the live database (generated with their own BEGIN … COMMIT) keep that form byte for byte. Every
// later file runs INSIDE the platform runner's transaction: the runner opens one transaction for all pending files and commits
// it itself, so a file's own COMMIT ended it early and the deploy failed ("committing migrations: unexpected transaction status
// idle", v4.0 admin deploy). Those files set search_path at session level first, so the body's SET LOCAL lines are also
// covered by a runner that does not open a transaction, and reset it at the end.
const OWN_TXN_LAST = '050-code-scope.sql';
function ownTransaction(name) { return name <= OWN_TXN_LAST; }
function wrapSource(m) {
  if (!ownTransaction(m.name)) return wrapInRunner(m);
  return [
    '-- server/netlify/database/migrations/' + platformName(m.name) + ' — GENERATED by server/db/platform-migrations.js from',
    '-- server/db/migrations/' + m.name + ' (sha256 ' + m.sha + '); never edit. The body between the markers is that file,',
    '-- byte for byte; the explicit transaction keeps its SET LOCAL statements meaningful under any runner.',
    'BEGIN;',
    '-- ── source body START ──',
    m.text.endsWith('\n') ? m.text : m.text + '\n',
    '-- ── source body END ──',
    'RESET ROLE;',
    'INSERT INTO public.wts_schema_migrations (name, sha256) VALUES (' + lit(m.name) + ', ' + lit(m.sha) + ') ON CONFLICT (name) DO NOTHING;',
    'COMMIT;',
    '',
  ].join('\n');
}

function wrapInRunner(m) {
  return [
    '-- server/netlify/database/migrations/' + platformName(m.name) + ' — GENERATED by server/db/platform-migrations.js from',
    '-- server/db/migrations/' + m.name + ' (sha256 ' + m.sha + '); never edit. The body between the markers is that file,',
    "-- byte for byte. It runs inside the platform runner's transaction (no BEGIN / COMMIT here); search_path is set for the session",
    "-- too, so the body's SET LOCAL lines hold under any runner.",
    'SET search_path = wts, pg_temp;',
    '-- ── source body START ──',
    m.text.endsWith('\n') ? m.text : m.text + '\n',
    '-- ── source body END ──',
    'RESET ROLE;',
    'RESET search_path;',
    'INSERT INTO public.wts_schema_migrations (name, sha256) VALUES (' + lit(m.name) + ', ' + lit(m.sha) + ') ON CONFLICT (name) DO NOTHING;',
    '',
  ].join('\n');
}

function exportRoleFile(backupSql) {
  return [
    '-- server/netlify/database/migrations/0501_platform_export_role.sql — GENERATED by server/db/platform-migrations.js; never',
    '-- edit. The read-only export role (server/ops/sql/backup-role.sql, byte for byte between the markers) and its grant to the',
    '-- login (SET only), as db/migrate.js --platform does after the migrations. Idempotent.',
    'BEGIN;',
    '-- ── ops/sql/backup-role.sql START ──',
    backupSql.endsWith('\n') ? backupSql : backupSql + '\n',
    '-- ── ops/sql/backup-role.sql END ──',
    grantBlock('grants', ['wts_backup']),
    'COMMIT;',
    '',
  ].join('\n');
}

function build(srcDir) {
  const list = listMigrations(srcDir || SRC);
  const first = list.find((m) => m.name === '001-schema.sql');
  if (!first) throw new Error('platform-migrations: 001-schema.sql missing');
  const out = [{ name: '0000_platform_roles.sql', text: rolesFile(first.text) }];
  list.forEach((m) => {
    out.push({ name: platformName(m.name), text: wrapSource(m), source: m.name, sha: m.sha });
    if (m.name === '050-code-scope.sql') out.push({ name: '0501_platform_export_role.sql', text: exportRoleFile(fs.readFileSync(BACKUP_SQL, 'utf8')) });
  });
  const names = out.map((f) => f.name);
  if (names.some((n) => !NAME_RE.test(n))) throw new Error('platform-migrations: a name does not match <digits>_<slug>.sql');
  if (JSON.stringify(names) !== JSON.stringify(names.slice().sort())) throw new Error('platform-migrations: order changed');
  return out;
}

// → [problems] comparing the folder with build()
function check(dir, srcDir) {
  dir = dir || OUT;
  const want = build(srcDir);
  const have = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort() : [];
  const problems = [];
  want.forEach((f) => {
    if (!have.includes(f.name)) problems.push(f.name + ': missing (run node server/db/platform-migrations.js --write)');
    else if (fs.readFileSync(path.join(dir, f.name), 'utf8') !== f.text) problems.push(f.name + ': differs from its source (an applied platform migration must never change)');
  });
  have.forEach((n) => { if (!want.some((f) => f.name === n)) problems.push(n + ': has no source in server/db/migrations'); });
  return problems;
}

function write(dir, o) {
  dir = dir || OUT; o = o || {};
  const want = build(o.srcDir);
  fs.mkdirSync(dir, { recursive: true });
  const have = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'));
  const changed = [];
  want.forEach((f) => {
    const p = path.join(dir, f.name);
    if (fs.existsSync(p) && fs.readFileSync(p, 'utf8') === f.text) return;
    if (fs.existsSync(p) && !o.force) throw new Error(f.name + ' exists with other content — refused (applied platform migrations never change; --force only before the first deploy)');
    fs.writeFileSync(p, f.text);
    changed.push(f.name);
  });
  have.forEach((n) => {
    if (want.some((f) => f.name === n)) return;
    if (!o.force) throw new Error(n + ' has no source — refused (never remove an applied platform migration)');
    fs.unlinkSync(path.join(dir, n)); changed.push('-' + n);
  });
  return changed;
}

module.exports = { build, check, write, platformName, OUT, PLATFORM_RE, PLATFORM_MARK };

if (require.main === module) {
  const args = process.argv.slice(2);
  try {
    if (args.includes('--write')) {
      const c = write(OUT, { force: args.includes('--force') });
      console.log('[platform-migrations] ' + (c.length ? 'wrote ' + c.join(', ') : 'up to date'));
    } else {
      const p = check();
      if (p.length) { console.error('[platform-migrations] out of sync:\n  ' + p.join('\n  ')); process.exit(1); }
      console.log('[platform-migrations] ok — ' + build().length + ' files in sync with server/db/migrations');
    }
  } catch (e) { console.error('[platform-migrations] ' + e.message); process.exit(1); }
}
