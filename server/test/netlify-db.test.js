'use strict';
// server/test/netlify-db.test.js — one-login hosting on the throwaway cluster (v4.0; server/README.md "Hosting"): a database
// whose only login is a NON-superuser owner (as the platform hands out) is migrated with db/migrate.js --platform; request
// transactions switch to wts_api (forced RLS holds), the jobs and the export run as wts_jobs / wts_backup start-up roles,
// a login without the grant cannot connect as a role, the daily job and the weekly COPY export run through site/netlify.js
// with a fake blob store, and the restore drill rebuilds the export (sealed to the public key) in a scratch database.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const cp = require('child_process');
const path = require('path');
const D = require('./_db');
const { createDb } = require('../core/db');
const { migrate, loginReport, prepareLogin } = require('../db/migrate');

const skip = !D.available() && 'no throwaway database (run through server/test/run.js)';
const LOGIN = 'wts_platform_login';
let H = null; let conn = null; let url = null;

function fakeGetStore() {
  const stores = new Map(); const regions = new Set();
  return {
    regions, stores,
    getStore(o) {
      regions.add(o.region + '/' + o.consistency);
      if (!stores.has(o.name)) stores.set(o.name, new Map());
      const m = stores.get(o.name);
      return {
        async get(k) { return m.has(k) ? m.get(k).slice(0) : null; },
        async set(k, v) { m.set(k, v.slice(0)); },
        async delete(k) { m.delete(k); },
        async list(q) { return { blobs: Array.from(m.keys()).filter((k) => k.startsWith(q.prefix)).map((key) => ({ key })) }; },
      };
    },
  };
}
async function mkUser(sql, id) {
  await sql`insert into wts.users (id, email_bidx, email_enc, terms_version, privacy_version, consented_at, data_key_wrapped, data_key_kid)
            values (${id}, ${crypto.randomBytes(32)}, ${Buffer.from('x')}, '1', '1', now(), ${Buffer.from('k')}, 1)`;
  await sql`insert into wts.projects (id, user_id, meta_enc, created_at, modified_at) values (${crypto.randomUUID()}, ${id}, ${Buffer.from('m')}, now(), now())`;
}

test.describe('one-login hosting (Netlify Database pattern)', { skip }, () => {
  test.before(async () => {
    H = await D.freshDatabase('nf_scratch');       // only for its administrator connection; the platform database is made below
    const db = 'wts_t_nf_platform';
    await H.admin.sql.unsafe('DROP DATABASE IF EXISTS ' + db);
    await H.admin.sql.unsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOGIN}') THEN
      CREATE ROLE ${LOGIN} LOGIN NOSUPERUSER CREATEROLE CREATEDB BYPASSRLS; END IF; END $$`);
    await H.admin.sql.unsafe('CREATE DATABASE ' + db + ' OWNER ' + LOGIN);
    // the wts_* roles are cluster-wide and already exist here (made by the administrator for the other test files); on the
    // platform the login creates them itself and so holds ADMIN OPTION on each (PostgreSQL 16) — the same state, nothing more
    for (const r of await H.admin.sql`select rolname from pg_roles where rolname in ('wts_owner', 'wts_definer', 'wts_api', 'wts_jobs', 'wts_support', 'wts_backup')`) {
      await H.admin.sql.unsafe('GRANT ' + r.rolname + ' TO ' + LOGIN + ' WITH ADMIN TRUE, INHERIT FALSE, SET FALSE');
    }
    conn = Object.assign({}, H.conn, { user: LOGIN, database: db });
    url = 'postgresql://' + LOGIN + '@' + conn.host + ':' + conn.port + '/' + db + '?sslmode=disable&channel_binding=require';
  });
  test.after(async () => { if (H) await H.close(); });

  test('the migration job as the non-superuser login: capability report, roles granted, every migration, the export role', async () => {
    const r = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'db', 'migrate.js'), '--platform'],
      { env: Object.assign({}, process.env, { WTS_MIGRATE_DB_URL: url }), encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /login wts_platform_login: superuser false, createrole true, bypassrls true/);
    assert.match(r.stdout, /applied 001-schema\.sql[\s\S]*applied 050-code-scope\.sql/);
    assert.match(r.stdout, /export role ready/);
    assert.ok(!r.stdout.includes('postgresql://'), 'the connection string is never printed');
    const again = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'db', 'migrate.js'), '--platform'],
      { env: Object.assign({}, process.env, { WTS_MIGRATE_DB_URL: url }), encoding: 'utf8' });
    assert.strictEqual(again.status, 0, again.stderr); assert.match(again.stdout, /0 applied/);
    const own = createDb(conn, { max: 1 });
    try {
      const rows = await own.sql`select c.relname, c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'wts' and c.relkind = 'r'`;
      assert.ok(rows.length >= 20 && rows.every((x) => x.relforcerowsecurity), 'forced RLS on every table');
      const definers = await own.sql`select distinct pg_get_userbyid(p.proowner) as o from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'wts' and p.prosecdef`;
      assert.deepStrictEqual(definers.map((x) => x.o), ['wts_definer']);
      const create = await own.sql`select has_schema_privilege('wts_definer', 'wts', 'CREATE') as c`;
      assert.strictEqual(create[0].c, false, 'CREATE lent to wts_definer for the ownership change is taken back');
      // one membership row per grantor (PostgreSQL 16): the effective options are the OR over the rows
      const m = await own.sql`select r.rolname, bool_or(a.inherit_option) as i, bool_or(a.set_option) as s from pg_auth_members a join pg_roles r on r.oid = a.roleid
        join pg_roles me on me.oid = a.member where me.rolname = ${LOGIN} group by 1 order by 1`;
      assert.deepStrictEqual(m.map((x) => x.rolname + ':' + x.i + ':' + x.s), ['wts_api:false:true', 'wts_backup:false:true', 'wts_definer:true:true',
        'wts_jobs:false:true', 'wts_owner:true:true', 'wts_support:false:true']);
    } finally { await own.close(); }
  });

  test('request transactions run as wts_api: forced RLS holds for the platform login, nothing leaks between transactions', async () => {
    const u1 = crypto.randomUUID(); const u2 = crypto.randomUUID();
    // the test's own rows go in as the cluster administrator (superuser), never through the platform login
    const adm = createDb(Object.assign({}, H.conn, { database: conn.database }), { max: 1 });
    try { await mkUser(adm.sql, u1); await mkUser(adm.sql, u2); } finally { await adm.close(); }
    const api = createDb(url, { role: 'wts_api', max: 1 });
    try {
      const who = await api.anon((tx) => tx`select current_user as c, session_user as s`);
      assert.deepStrictEqual([who[0].c, who[0].s], ['wts_api', LOGIN]);
      assert.strictEqual((await api.asUser(u1, (tx) => tx`select id from wts.projects`)).length, 1, 'own rows only');
      assert.strictEqual((await api.anon((tx) => tx`select id from wts.users`)).length, 0, 'no app.user_id → no rows');
      assert.strictEqual((await api.asUser(u1, (tx) => tx`select id from wts.users where id = ${u2}`)).length, 0, 'another user is invisible');
      await assert.rejects(api.asUser(u1, (tx) => tx`select * from wts.email_codes`), /permission denied/);
      // the role does not outlive its transaction on the pooled connection
      assert.strictEqual((await api.sql`select current_user as c`)[0].c, LOGIN);
    } finally { await api.close(); }
  });

  test('start-up roles for the jobs and the export; a login that is not a member cannot connect as the role', async () => {
    for (const role of ['wts_jobs', 'wts_backup', 'wts_support']) {
      const d = createDb(url, { role, sessionRole: true, max: 1 });
      try { assert.strictEqual(await d.checkRole(), role); } finally { await d.close(); }
    }
    await H.admin.sql.unsafe('DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = \'wts_stranger\') THEN CREATE ROLE wts_stranger LOGIN; END IF; END $$');
    const s = createDb(Object.assign({}, conn, { user: 'wts_stranger' }), { role: 'wts_jobs', sessionRole: true, max: 1 });
    try { await assert.rejects(s.checkRole(), /permission denied to set role|role/); } finally { await s.close(); }
    const plain = createDb(conn, { max: 1 });
    try {
      const rep = await loginReport(plain.sql);
      assert.ok(rep.ok && !rep.superuser);
    } finally { await plain.close(); }
    // a login without BYPASSRLS is refused before anything is applied
    await H.admin.sql.unsafe('DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = \'wts_weak_login\') THEN CREATE ROLE wts_weak_login LOGIN CREATEROLE NOBYPASSRLS; END IF; END $$');
    const weak = createDb(Object.assign({}, conn, { user: 'wts_weak_login' }), { max: 1 });
    try {
      const rep = await loginReport(weak.sql);
      assert.strictEqual(rep.ok, false); assert.ok(rep.problems.some((p) => /BYPASSRLS/.test(p)));
      await assert.rejects(prepareLogin(weak.sql), /BYPASSRLS/);
    } finally { await weak.close(); }
  });

  test('the daily job and the weekly export through site/netlify.js; the restore drill rebuilds the COPY export', async () => {
    const NF = require('../site/netlify');
    const B = require('../site/backup');
    const F = fakeGetStore(); const lines = [];
    const log = { info: (m) => lines.push(m), warn: (m) => lines.push(m) };
    const keys = B.generateBackupKeys(9001);
    const env = { WTS_ENV: 'test', NETLIFY_DB_URL: url, WTS_BACKUP_PUBLIC_KEY: keys.publicKey };
    const j = await NF.runJobs({ env, getStore: F.getStore, log, only: NF.PURGE_STEPS });
    assert.strictEqual(j.ok, true, JSON.stringify(j)); assert.ok(j.did.purge && !j.did.purge.error, JSON.stringify(j.did));
    const full = await NF.runJobs({ env, getStore: F.getStore, log, checkExport: true });
    assert.strictEqual(full.ok, true); assert.strictEqual(full.exportAgeDays, null);
    assert.ok(lines.some((l) => /^alert: exportAge/.test(l)), 'no export yet → alert');
    const e = await NF.runExport({ env, getStore: F.getStore, log });
    assert.strictEqual(e.ok, true, JSON.stringify(e));
    assert.ok(e.counts.users >= 2 && e.counts.projects >= 2);
    assert.deepStrictEqual(Array.from(F.regions), ['eu-central-1/strong']);
    const exportsMap = F.stores.get('wts-exports');
    assert.deepStrictEqual(Array.from(exportsMap.keys()), ['export/' + e.name]);
    const again = await NF.runJobs({ env, getStore: F.getStore, log, only: ['quota'], checkExport: true });
    assert.ok(again.exportAgeDays < 1);
    const buf = Buffer.from(new Uint8Array(exportsMap.get('export/' + e.name)));
    assert.ok(buf.subarray(0, 6).equals(Buffer.from('WTSX2\n')), 'sealed to the public key');
    assert.throws(() => B.open(buf, B.parseKeys('9001:' + crypto.randomBytes(32).toString('base64'))), /no private key/);
    const report = await B.restoreDrill({ buf, keys: B.parsePrivateKeys(keys.privateKey), adminUrl: Object.assign({}, H.conn), env: {} });
    assert.strictEqual(report.ok, true, JSON.stringify(report.mismatches));
    assert.strictEqual(report.format, 'copy'); assert.strictEqual(report.dropped, true);
    assert.strictEqual(report.tables.users, e.counts.users);
    // the export role can read but never write
    const bk = createDb(url, { role: 'wts_backup', sessionRole: true, max: 1 });
    try { await assert.rejects(bk.sql`delete from wts.users`, /permission denied/); } finally { await bk.close(); }
  });
});
