'use strict';
// server/test/rls.test.js — the schema, roles, forced RLS and definer-function contract of docs/ACCOUNTS-PLAN.md §3.4 / D12
// against a freshly migrated database in the throwaway cluster (skips without one).

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const D = require('./_db');

const USER_TABLES = ['users', 'passkeys', 'identities', 'devices', 'sessions', 'projects', 'revisions', 'blobs', 'push_receipts',
  'historian_backups', 'audit'];
const SYSTEM_TABLES = ['oauth_attempts', 'oidc_keys', 'email_codes', 'webauthn_challenges', 'mail_outbox', 'signup_allowlist',
  'deletion_ledger', 'rate_counters', 'ops_nonces'];
// definer function → the one role that may execute it
const DEFINERS = {
  resolve_session: 'wts_api', user_by_email: 'wts_api', user_by_credential: 'wts_api', create_user: 'wts_api',
  user_by_identity: 'wts_api', oauth_attempt_create: 'wts_api', oauth_attempt_take: 'wts_api', oauth_attempt_result: 'wts_api',
  oauth_attempt_extend: 'wts_api', oauth_attempt_finish: 'wts_api', identity_link: 'wts_api', identity_touch: 'wts_api',
  identity_unlink: 'wts_api', oidc_key_get: 'wts_api', oidc_key_put: 'wts_api', code_issue: 'wts_api', code_check: 'wts_api',
  challenge_issue: 'wts_api', challenge_take: 'wts_api', rate_hit: 'wts_api', allowlist_has: 'wts_api', mail_queue: 'wts_api',
  deletion_request: 'wts_api', email_move: 'wts_api', recovery_set: 'wts_api', audit_system: 'wts_api', ops_nonce_claim: 'wts_api',
  support_lookup: 'wts_support', support_recover: 'wts_support', support_security_reset: 'wts_support',
  // WP-S1 (002-core.sql): new definers, and definer helpers / triggers that no role may call directly (null)
  rate_add: 'wts_api', mail_mark: 'wts_api', email_revert: 'wts_api', identities_remove_since: 'wts_api', deletion_cancel: 'wts_api',
  support_allowlist_add: 'wts_support', address_in_use: null, audit_chain_trg: null, audit_guard_trg: null, revisions_refs_trg: null,
};
// still WP0 stubs after WP-S1: the provider definers (WP-O)
const WPO_STUBS = ['user_by_identity', 'oauth_attempt_take', 'oidc_key_get'];
const ROLES = ['wts_api', 'wts_jobs', 'wts_support'];

const skip = !D.available() && 'no throwaway database (run through server/test/run.js)';
let H = null;
const uid = () => crypto.randomUUID();
async function mkUser(sql, id) {
  // the owner path of a test: insert as the administrator (superuser bypasses RLS), never through wts_api
  await sql`insert into wts.users (id, email_bidx, email_enc, terms_version, privacy_version, consented_at, data_key_wrapped, data_key_kid)
            values (${id}, ${crypto.randomBytes(32)}, ${Buffer.from('x')}, '1', '1', now(), ${Buffer.from('k')}, 1)`;
  await sql`insert into wts.sessions (sid_hash, user_id, public_device, created_at, auth_at, last_seen_at, idle_expires_at, abs_expires_at)
            values (${crypto.randomBytes(32)}, ${id}, false, now(), now(), now(), now() + interval '1 day', now() + interval '2 days')`;
  await sql`insert into wts.projects (id, user_id, meta_enc, created_at, modified_at) values (${uid()}, ${id}, ${Buffer.from('m')}, now(), now())`;
}

test.describe('schema and RLS (§3.4)', { skip }, () => {
  test.before(async () => { H = await D.freshDatabase('rls'); });
  test.after(async () => { if (H) await H.close(); });

  test('migration recorded; every §3.4 table exists in schema wts', async () => {
    const m = await H.admin.sql`select name from public.wts_schema_migrations`;
    assert.deepStrictEqual(m.map((r) => r.name), ['001-schema.sql', '002-core.sql']);
    const t = (await H.admin.sql`select tablename from pg_tables where schemaname = 'wts'`).map((r) => r.tablename).sort();
    assert.deepStrictEqual(t, USER_TABLES.concat(SYSTEM_TABLES).sort());
  });

  test('every table has RLS enabled AND forced; user tables carry the own_rows policy on user_id', async () => {
    const rows = await H.admin.sql`select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c
      join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'wts' and c.relkind = 'r'`;
    rows.forEach((r) => { assert.ok(r.relrowsecurity && r.relforcerowsecurity, r.relname + ': RLS must be enabled and forced'); });
    const pol = await H.admin.sql`select tablename, policyname, qual, with_check from pg_policies where schemaname = 'wts'`;
    assert.deepStrictEqual(pol.map((p) => p.tablename).sort(), USER_TABLES.slice().sort());
    pol.forEach((p) => { assert.match(p.qual, /user_id = wts\.current_user_id\(\)/); assert.match(p.with_check, /user_id = wts\.current_user_id\(\)/); });
  });

  test('roles: wts_api / wts_support have no BYPASSRLS, no superuser, no CREATE; wts_jobs bypasses; owner does not', async () => {
    const r = await H.admin.sql`select rolname, rolbypassrls, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin from pg_roles where rolname like 'wts\\_%'`;
    const by = Object.fromEntries(r.map((x) => [x.rolname, x]));
    ['wts_owner', 'wts_definer', 'wts_api', 'wts_jobs', 'wts_support'].forEach((n) => assert.ok(by[n], n + ' exists'));
    assert.strictEqual(by.wts_api.rolbypassrls, false); assert.strictEqual(by.wts_support.rolbypassrls, false);
    assert.strictEqual(by.wts_owner.rolbypassrls, false); assert.strictEqual(by.wts_jobs.rolbypassrls, true);
    assert.strictEqual(by.wts_definer.rolcanlogin, false); assert.strictEqual(by.wts_owner.rolcanlogin, false);
    ROLES.forEach((n) => { assert.strictEqual(by[n].rolsuper, false); assert.strictEqual(by[n].rolcreaterole, false); assert.strictEqual(by[n].rolcreatedb, false); });
    for (const role of ROLES) {
      const [p] = await H.admin.sql`select has_schema_privilege(${role}, 'wts', 'CREATE') as c, has_schema_privilege(${role}, 'public', 'CREATE') as pc`;
      assert.strictEqual(p.c, false, role + ' must not CREATE in wts'); assert.strictEqual(p.pc, false, role + ' must not CREATE in public');
    }
  });

  test('wts_api: no rows without app.user_id; A never sees or writes B; app.user_id never outlives its transaction', async () => {
    const A = uid(); const B = uid();
    await mkUser(H.admin.sql, A); await mkUser(H.admin.sql, B);
    const api = H.as('wts_api');
    assert.strictEqual((await api.sql`select count(*)::int as n from wts.users`)[0].n, 0, 'users without app.user_id');
    assert.strictEqual((await api.sql`select count(*)::int as n from wts.sessions`)[0].n, 0, 'sessions without app.user_id');
    const seen = await api.asUser(A, async (tx) => ({
      users: (await tx`select id from wts.users`).map((r) => r.id),
      projects: (await tx`select user_id from wts.projects`).map((r) => r.user_id),
      updB: (await tx`update wts.projects set well_count = 9 where user_id = ${B} returning id`).length,
    }));
    assert.deepStrictEqual(seen.users, [A]);
    assert.deepStrictEqual(seen.projects, [A]);
    assert.strictEqual(seen.updB, 0, 'A cannot update B');
    await assert.rejects(api.asUser(A, (tx) => tx`insert into wts.projects (id, user_id, meta_enc, created_at, modified_at)
      values (${uid()}, ${B}, ${Buffer.from('m')}, now(), now())`), /row-level security/, 'A cannot insert a row for B');
    // after the transaction the pooled connection carries no user id
    const after = await api.sql`select wts.current_user_id() as u, (select count(*)::int from wts.projects) as n`;
    assert.strictEqual(after[0].u, null); assert.strictEqual(after[0].n, 0);
  });

  test('wts_api cannot read pre-auth / system tables at all, nor change its own status or quota', async () => {
    const api = H.as('wts_api');
    for (const t of SYSTEM_TABLES) await assert.rejects(api.sql.unsafe('select 1 from wts.' + t + ' limit 1'), /permission denied/, t);
    await assert.rejects(api.asUser(uid(), (tx) => tx`update wts.users set status = 'active'`), /permission denied/);
    await assert.rejects(api.asUser(uid(), (tx) => tx`update wts.users set quota_bytes = 1`), /permission denied/);
    await assert.rejects(api.asUser(uid(), (tx) => tx`insert into wts.identities (id, user_id, provider, issuer, subject_bidx, subject_enc, email_verified_at_link, linked_at, linked_via) values (${uid()}, ${uid()}, 'google', 'x', '\\x00', '\\x00', true, now(), 'signup')`), /permission denied/,
      'identities are written only through identity_link');
    await assert.rejects(api.sql`create table wts.x (a int)`, /permission denied/);
  });

  test('definer functions: SECURITY DEFINER, fixed search_path, owned by wts_definer, EXECUTE for their one role only (helpers: none)', async () => {
    const fns = await H.admin.sql`select p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as owner, p.oid::regprocedure::text as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'wts' and p.prosecdef`;
    assert.deepStrictEqual(fns.map((f) => f.proname).sort(), Object.keys(DEFINERS).sort());
    for (const f of fns) {
      assert.strictEqual(f.owner, 'wts_definer', f.proname + ' owner');
      assert.deepStrictEqual(f.proconfig, ['search_path=wts, pg_temp'], f.proname + ' search_path');
      for (const role of ROLES.concat(['public'])) {
        const [x] = role === 'public'
          ? await H.admin.sql`select bool_or(a.grantee = 0) as e from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = ${f.sig}::regprocedure and a.privilege_type = 'EXECUTE'`
          : await H.admin.sql`select has_function_privilege(${role}, ${f.sig}, 'EXECUTE') as e`;
        assert.strictEqual(!!x.e, DEFINERS[f.proname] === role, f.proname + ' EXECUTE for ' + role);
      }
    }
    const api = H.as('wts_api');
    assert.strictEqual((await api.sql`select * from wts.resolve_session(${Buffer.alloc(32)})`).length, 0, 'WP-S1 bodies: no such session');
    assert.strictEqual((await api.sql`select wts.allowlist_has(${Buffer.alloc(32)}) as ok`)[0].ok, false);
    await assert.rejects(api.sql`select * from wts.user_by_identity('google', ${Buffer.alloc(32)})`, (e) => e.code === '0A000', 'the provider definers stay with WP-O');
    void WPO_STUBS;
    const sup = H.as('wts_support');
    await assert.rejects(sup.sql`select * from wts.resolve_session(${Buffer.alloc(32)})`, /permission denied/);
  });

  test('provider columns and constraints are in the first schema (§3.4 last bullet)', async () => {
    const cols = await H.admin.sql`select table_name, column_name, column_default from information_schema.columns where table_schema = 'wts'`;
    const has = (t, c) => cols.some((r) => r.table_name === t && r.column_name === c);
    [['sessions', 'auth_method'], ['sessions', 'stepup_at'], ['sessions', 'identity_id'], ['users', 'signup_method'],
      ['email_codes', 'bound_attempt'], ['identities', 'email_ack_bidx'], ['oauth_attempts', 'fresh_login']].forEach(([t, c]) => assert.ok(has(t, c), t + '.' + c));
    const uq = await H.admin.sql`select pg_get_constraintdef(c.oid) as d from pg_constraint c join pg_class t on t.oid = c.conrelid
      where t.relname = 'identities' and c.contype = 'u'`;
    assert.deepStrictEqual(uq.map((r) => r.d).sort(), ['UNIQUE (provider, subject_bidx)', 'UNIQUE (user_id, provider)']);
  });

  test('addresses only through definers: wts_api cannot write email / recovery index columns; pre-auth audit via audit_system', async () => {
    const A = uid(); await mkUser(H.admin.sql, A);
    const api = H.as('wts_api');
    for (const col of ['email_bidx', 'email_enc', 'recovery_bidx', 'recovery_enc']) {
      await assert.rejects(api.asUser(A, (tx) => tx.unsafe('update wts.users set ' + col + " = '\\x01'::bytea")), /permission denied/, col);
    }
    // own columns stay writable
    assert.strictEqual((await api.asUser(A, (tx) => tx`update wts.users set opt_historian = true returning id`)).length, 1);
    // a pre-auth audit row (user_id NULL) is refused to wts_api directly; the definer exists for it
    await assert.rejects(api.asUser(A, (tx) => tx`insert into wts.audit (user_id, actor, action, at, hash) values (null, 'system', 'x', now(), '\\x00')`), /row-level security/);
    // the address definers act only on the transaction's own account
    await assert.rejects(api.sql`select wts.email_move(${A}, ${Buffer.alloc(32)}, ${Buffer.from('e')})`, (e) => e.code === '42501', 'no app.user_id');
    await assert.rejects(api.asUser(uid(), (tx) => tx`select wts.recovery_set(${A}, ${null}, ${null})`), (e) => e.code === '42501', 'another account');
    assert.strictEqual((await api.asUser(A, (tx) => tx`select wts.recovery_set(${A}, ${null}, ${null}) as ok`))[0].ok, true);
    const sys = (await api.sql`select wts.audit_system('probe', null, null, null, null, '{}'::jsonb) as id`)[0].id;
    assert.ok(Number(sys) > 0, 'a pre-auth audit row through the definer');
  });

  test('cross-tenant references: a revision or conflict row cannot point at another account\'s project (no existence probe)', async () => {
    const A = uid(); const B = uid(); await mkUser(H.admin.sql, A); await mkUser(H.admin.sql, B);
    const [bp] = await H.admin.sql`select id from wts.projects where user_id = ${B}`;
    const [ap] = await H.admin.sql`select id from wts.projects where user_id = ${A}`;
    const api = H.as('wts_api');
    const rev = (tx, pid) => tx`insert into wts.revisions (project_id, user_id, rev, core_hash, vhash, parts, bytes, reason, saved_at)
      values (${pid}, ${A}, 1, '\\x00', '\\x00', '{}'::jsonb, 1, 'save', now())`;
    const errB = await api.asUser(A, (tx) => rev(tx, bp.id)).then(() => null, (e) => e);
    const errNone = await api.asUser(A, (tx) => rev(tx, uid())).then(() => null, (e) => e);
    assert.ok(errB && errNone, 'both refused');
    assert.strictEqual(errB.code, '23503'); assert.strictEqual(errNone.code, '23503');
    assert.strictEqual(errB.constraint_name, errNone.constraint_name, 'another account\'s id fails exactly like a missing id');
    assert.ok(!String(errB.detail || '').includes(B), 'the error never names the other account');
    await api.asUser(A, (tx) => rev(tx, ap.id));                    // own project: fine
    const conflict = (tx, of) => tx`insert into wts.projects (id, user_id, meta_enc, created_at, modified_at, is_conflict_of)
      values (${uid()}, ${A}, ${Buffer.from('m')}, now(), now(), ${of})`;
    await assert.rejects(api.asUser(A, (tx) => conflict(tx, bp.id)), (e) => e.code === '23503');
    await api.asUser(A, (tx) => conflict(tx, ap.id));
    const fks = await H.admin.sql`select pg_get_constraintdef(c.oid) as d from pg_constraint c join pg_class t on t.oid = c.conrelid
      where t.relname in ('projects', 'revisions') and c.contype = 'f' and pg_get_constraintdef(c.oid) like '%REFERENCES wts.projects%'`;
    assert.strictEqual(fks.length, 2);
    fks.forEach((f) => assert.match(f.d, /user_id\) REFERENCES wts\.projects\(id, user_id\)/));
  });

  test('ops-daily nonce store: claimed once across connections; wts_api cannot read the table', async () => {
    const api = H.as('wts_api'); const api2 = H.as('wts_api');
    const n = crypto.randomBytes(12).toString('hex');
    assert.strictEqual((await api.sql`select wts.ops_nonce_claim(${n}) as ok`)[0].ok, true);
    assert.strictEqual((await api2.sql`select wts.ops_nonce_claim(${n}) as ok`)[0].ok, false, 'a replay on another instance');
    assert.strictEqual((await api.sql`select wts.ops_nonce_claim('short') as ok`)[0].ok, false);
    await assert.rejects(api.sql`select * from wts.ops_nonces`, /permission denied/);
    const H2 = require('../core/http');
    const store = H2.dbNonceStore(api);
    const n2 = crypto.randomBytes(12).toString('hex');
    assert.strictEqual(await store.claim(n2), true); assert.strictEqual(await store.claim(n2), false);
    await H.admin.sql`update wts.ops_nonces set seen_at = now() - interval '11 minutes' where nonce = ${n}`;
    assert.strictEqual((await api.sql`select wts.ops_nonce_claim(${n}) as ok`)[0].ok, true, 'expired after 10 minutes');
  });

  test('a changed migration file is refused once applied', async () => {
    const { migrate } = require('../db/migrate');
    const fs = require('fs'); const os = require('os'); const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-mig-'));
    try {
      fs.writeFileSync(path.join(dir, '001-schema.sql'), 'select 1;');
      await assert.rejects(migrate(H.admin.sql, { dir }), /changed after it was applied/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
