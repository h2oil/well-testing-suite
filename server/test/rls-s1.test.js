'use strict';
// server/test/rls-s1.test.js — the WP-S1 part of the §3.4 isolation contract (rls.test.js holds the WP0 part): the filled
// definer bodies (002-core.sql) return only their listed columns, act only on the transaction's own account, keep one
// address per role across accounts, bind codes exactly; the triggers run for wts_api although no role may call them; the
// audit chain stays linear under concurrent inserts; wts_jobs and wts_support stay within their grants.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const D = require('./_db');

const skip = !D.available() && 'no throwaway database (run through server/test/run.js)';
const b32 = (n) => Buffer.alloc(32, n);

test.describe('definer bodies and triggers (WP-S1)', { skip }, () => {
  let G = null;
  test.before(async () => { G = await D.freshDatabase('rls_s1'); });
  test.after(async () => { if (G) await G.close(); });
  const mkUser = async (api, n) => (await api.sql`select wts.create_user(${b32(n)}, ${Buffer.from('e')}, 'code', '1', '1', now(), ${Buffer.from('k')}, 1) as id`)[0].id;

  test('each definer returns only its listed columns', async () => {
    const want = {
      resolve_session: 'TABLE(user_id uuid, device_id uuid, public_device boolean, auth_at timestamp with time zone, stepup_at timestamp with time zone, auth_method text, identity_id uuid, idle_expires_at timestamp with time zone, abs_expires_at timestamp with time zone, status text)',
      user_by_email: 'TABLE(user_id uuid, status text, role text)',
      code_check: 'TABLE(ok boolean, code_id uuid, attempts_left integer)',
      rate_hit: 'TABLE(allowed boolean, n bigint, retry_after integer)',
      email_revert: 'TABLE(user_id uuid, sessions integer, passkeys integer, identities integer)',
      create_user: 'uuid', allowlist_has: 'boolean',
    };
    for (const [f, r] of Object.entries(want)) {
      const x = await G.admin.sql`select pg_get_function_result(p.oid) as r from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'wts' and p.proname = ${f}`;
      assert.strictEqual(x[0].r, r, f);
    }
  });

  test('create_user: one address, one role, one account (primary, recovery and an address in its revert window)', async () => {
    const api = G.as('wts_api');
    const A = await mkUser(api, 1);
    assert.ok(A);
    assert.strictEqual(await mkUser(api, 1), null, 'the same primary');
    await G.admin.sql`update wts.users set recovery_bidx = ${b32(2)}, email_prev_bidx = ${b32(3)}, email_revert_until = now() + interval '1 day' where id = ${A}`;
    assert.strictEqual(await mkUser(api, 2), null, 'another account\'s recovery address');
    assert.strictEqual(await mkUser(api, 3), null, 'an old address inside its revert window');
    await G.admin.sql`update wts.users set email_revert_until = now() - interval '1 second' where id = ${A}`;
    assert.ok(await mkUser(api, 3), 'free once the window has passed');
    const r = await api.sql`select * from wts.user_by_email(${b32(2)})`;
    assert.deepStrictEqual([r[0].user_id, r[0].role], [A, 'recovery']);
  });

  test('codes: two live per address and purpose, exact bindings, 5 tries, used once', async () => {
    const api = G.as('wts_api');
    const issue = (h, purpose, user, sid) => api.sql`select wts.code_issue(${b32(9)}, ${h}, 1, ${purpose}, ${user || null}, ${sid || null}, ${null}, ${null}, ${null}) as id`;
    const check = (hs, purpose, user, sid) => api.sql`select * from wts.code_check(${b32(9)}, ${purpose}, ${api.sql.array(hs, 17)}, ${user || null}, ${sid || null}, ${null})`.then((r) => r[0]);
    for (const n of [11, 12, 13]) await issue(b32(n), 'signin');
    const live = await G.admin.sql`select count(*)::int as n from wts.email_codes where email_bidx = ${b32(9)} and purpose = 'signin' and used_at is null and invalidated_at is null`;
    assert.strictEqual(live[0].n, 2);
    assert.strictEqual((await check([b32(11)], 'signin')).ok, false, 'the oldest of three is dead');
    const P = crypto.randomUUID();
    assert.strictEqual((await api.asUser(P, (tx) => tx`select * from wts.code_check(${b32(9)}, 'stepup', ${tx.array([b32(12)], 17)}, ${P}, ${b32(1)}, ${null})`))[0].ok, false, 'not another purpose');
    assert.strictEqual((await check([b32(12)], 'signin')).ok, true);
    assert.strictEqual((await check([b32(13)], 'signin')).ok, false, 'a hit invalidates the other live code');
    await assert.rejects(issue(b32(20), 'stepup'), /needs a user and a session/);
    const U = crypto.randomUUID();
    const issueAs = (as, h, purpose, user, sid) => api.asUser(as, (tx) => tx`select wts.code_issue(${b32(9)}, ${h}, 1, ${purpose}, ${user}, ${sid || null}, ${null}, ${null}, ${null}) as id`);
    const checkAs = (as, hs, purpose, user, sid) => api.asUser(as, (tx) => tx`select * from wts.code_check(${b32(9)}, ${purpose}, ${tx.array(hs, 17)}, ${user}, ${sid || null}, ${null})`).then((r) => r[0]);
    // a user-bound code is issued and checked only inside that user's own transaction (p_bound_user = app.user_id)
    await assert.rejects(issue(b32(21), 'stepup', U, b32(30)), /code_issue: not this account/, 'no app.user_id');
    await assert.rejects(issueAs(crypto.randomUUID(), b32(21), 'stepup', U, b32(30)), /code_issue: not this account/, 'another account');
    await assert.rejects(issueAs(crypto.randomUUID(), b32(21), 'email_revert', U), /code_issue: not this account/, 'revert code for another account');
    await issueAs(U, b32(21), 'stepup', U, b32(30));
    await assert.rejects(check([b32(21)], 'stepup', U, b32(30)), /code_check: not this account/, 'no app.user_id');
    await assert.rejects(checkAs(crypto.randomUUID(), [b32(21)], 'stepup', U, b32(30)), /code_check: not this account/, 'another account');
    assert.strictEqual((await checkAs(U, [b32(21)], 'stepup', U, b32(31))).ok, false, 'another session');
    const V2 = crypto.randomUUID();
    assert.strictEqual((await checkAs(V2, [b32(21)], 'stepup', V2, b32(30))).ok, false, 'another user');
    assert.strictEqual((await checkAs(U, [b32(21)], 'stepup', U, b32(30))).ok, true, 'within 5 tries');
    await issue(b32(22), 'signin');
    let left = 5;
    for (let i = 0; i < 5; i++) left = (await check([b32(98)], 'signin')).attempts_left;
    assert.strictEqual(left, 0);
    assert.strictEqual((await check([b32(22)], 'signin')).ok, false, 'burnt after 5 tries');
  });

  test('rate_add: fixed windows, peek does not count, retry-after within the window; not for other roles', async () => {
    const api = G.as('wts_api');
    const hit = (amt) => api.sql`select * from wts.rate_add('t:x', '1 hour'::interval, 3, ${amt})`.then((r) => r[0]);
    for (let i = 1; i <= 3; i++) assert.strictEqual((await hit(1)).allowed, true);
    const over = await hit(1);
    assert.strictEqual(over.allowed, false); assert.strictEqual(Number(over.n), 4); assert.ok(over.retry_after >= 1 && over.retry_after <= 3600);
    assert.strictEqual(Number((await hit(0)).n), 4, 'peek');
    await assert.rejects(G.as('wts_support').sql`select * from wts.rate_add('t:y', '1 hour'::interval, 3, 1)`, /permission denied/);
  });

  test('sessions: a rotated id resolves to its replacement for 30 s; expired sessions stay invisible; account definers refuse other accounts', async () => {
    const api = G.as('wts_api');
    const A = await mkUser(api, 40);
    await api.asUser(A, async (tx) => {
      await tx`insert into wts.sessions (sid_hash, user_id, public_device, created_at, auth_at, stepup_at, last_seen_at, idle_expires_at, abs_expires_at)
        values (${b32(41)}, ${A}, false, now(), now(), now(), now(), now() + interval '1 day', now() + interval '2 days'),
               (${b32(42)}, ${A}, false, now(), now(), null, now(), now() + interval '1 day', now() + interval '2 days')`;
      await tx`update wts.sessions set replaced_by = ${b32(42)}, replaced_at = now() where sid_hash = ${b32(41)}`;
    });
    const r = (await api.sql`select * from wts.resolve_session(${b32(41)})`)[0];
    assert.strictEqual(r.user_id, A); assert.strictEqual(r.stepup_at, null, 'the replacement row');
    await G.admin.sql`update wts.sessions set replaced_at = now() - interval '31 seconds' where sid_hash = ${b32(41)}`;
    assert.strictEqual((await api.sql`select * from wts.resolve_session(${b32(41)})`).length, 0);
    await G.admin.sql`update wts.sessions set idle_expires_at = now() - interval '1 second' where sid_hash = ${b32(42)}`;
    assert.strictEqual((await api.sql`select * from wts.resolve_session(${b32(42)})`).length, 0, 'expired');
    await assert.rejects(api.asUser(crypto.randomUUID(), (tx) => tx`select wts.deletion_request(${A}, now(), now())`), (e) => e.code === '42501');
    await assert.rejects(api.asUser(crypto.randomUUID(), (tx) => tx`select * from wts.identities_remove_since(${A}, null)`), (e) => e.code === '42501');
    await assert.rejects(api.asUser(crypto.randomUUID(), (tx) => tx`select wts.deletion_cancel(${A})`), (e) => e.code === '42501');
  });

  test('triggers run for wts_api although no role may call them: the audit chain stays linear under concurrency; refcounts follow revisions', async () => {
    const api = G.as('wts_api');
    const A = await mkUser(api, 50);
    const conns = [0, 1, 2, 3].map(() => G.as('wts_api'));
    await Promise.all(Array.from({ length: 24 }, (_, i) => conns[i % 4].asUser(A, (tx) => tx`insert into wts.audit (user_id, actor, action, at, detail, hash)
      values (${A}, 'user', 'probe', now(), ${tx.json({ i })}, '\\x'::bytea)`)));
    const rows = await G.admin.sql`select id, prev_hash, hash from wts.audit where user_id = ${A}`;
    assert.strictEqual(rows.length, 24);
    const prevs = rows.map((r) => (r.prev_hash ? r.prev_hash.toString('hex') : 'null'));
    assert.strictEqual(new Set(prevs).size, 24, 'no two rows share a predecessor: one linear chain');
    assert.strictEqual(prevs.filter((p) => p === 'null').length, 1, 'one start');
    const bad = await G.admin.sql`select count(*)::int as n from wts.audit a where a.hash <> wts.audit_row_hash(a.prev_hash, a.actor, a.action, a.target, a.device_id, a.ip_prefix, a.ua_family, a.at, a.detail)`;
    assert.strictEqual(bad[0].n, 0);
    await assert.rejects(api.asUser(A, (tx) => tx`insert into wts.audit (user_id, actor, action, at, hash) values (${A}, 'mallory', 'forged', now(), '\\x'::bytea)`), /bad actor/);
    const pid = crypto.randomUUID(); const h1 = b32(60);
    await api.asUser(A, async (tx) => {
      await tx`insert into wts.projects (id, user_id, meta_enc, created_at, modified_at) values (${pid}, ${A}, '\\x00', now(), now())`;
      await tx`insert into wts.blobs (user_id, hash, zsha, bytes, chunks, complete, created_at) values (${A}, ${h1}, ${h1}, 10, 1, true, now())`;
      for (const rev of [1, 2]) await tx`insert into wts.revisions (project_id, user_id, rev, core_hash, vhash, parts, bytes, reason, saved_at)
        values (${pid}, ${A}, ${rev}, ${h1}, ${h1}, ${tx.json([{ name: 'well/w1', hash: h1.toString('hex'), bytes: 1 }])}, 1, 'save', now())`;
    });
    const rc = async () => (await G.admin.sql`select refcount, unref_at from wts.blobs where hash = ${h1}`)[0];
    assert.strictEqual((await rc()).refcount, 2, 'core and part of one revision count once per revision');
    await api.asUser(A, (tx) => tx`delete from wts.revisions where project_id = ${pid}`);
    const z = await rc();
    assert.strictEqual(z.refcount, 0); assert.ok(z.unref_at, 'unref_at set when the count reaches 0');
  });

  test('wts_jobs and wts_support stay within their grants', async () => {
    const jobs = G.as('wts_jobs'); const sup = G.as('wts_support');
    await assert.rejects(jobs.sql`insert into wts.users (email_bidx, email_enc, terms_version, privacy_version, consented_at, data_key_wrapped, data_key_kid) values (${b32(70)}, '\\x00', '1', '1', now(), '\\x00', 1)`, /permission denied/);
    await assert.rejects(jobs.sql`update wts.users set quota_bytes = 1`, /permission denied/);
    await assert.rejects(jobs.sql`update wts.audit set action = 'x'`, /permission denied/);
    await assert.rejects(sup.sql`select * from wts.sessions`, /permission denied/);
    await assert.rejects(sup.sql`select * from wts.support_lookup('nobody', ${b32(1)})`, /actor/);
  });
});
