'use strict';
// server/test/account.test.js — export with the read-rate unlock, delete with the 7-day grace and cancel, the daily job
// (purges, outbox retry, trash, unreferenced blobs, account purge with tombstones and the ledger, inactivity, quota,
// audit chain and anchor), ledger replay after a simulated restore, ops-daily through the HMAC rule, csp-report
// aggregates, the audited support functions and master-key rotation (docs/ACCOUNTS-PLAN.md §3.3 Account, §3.5, §8.5, §13.4–13.7).

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const zlib = require('zlib');
const { harness, available } = require('./_api');
const C = require('../core/contract');
const H = require('../core/http');
const { createKeys } = require('../core/keys');
const { loadJobsConfig } = require('../core/config');
const O = require('../core/ops');
const J = require('../core/jobs');

const skip = !available() && 'no throwaway database (run through server/test/run.js)';
let T = null;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
function part(obj) { const json = Buffer.from(JSON.stringify(obj)); const z = zlib.gzipSync(json); return { hash: sha(json), zsha: sha(z), z, bytes: json.length }; }
async function project(br, name, nParts) {
  const pid = (await br.call('POST', '/projects', { name, meta: { client: 'Operator Energy Ltd', well: 'Example-1', field: '', operator: '' } })).json.id;
  const core = part({ core: name }); const parts = [];
  for (let i = 0; i < (nParts || 1); i++) {
    const p = part({ well: i, d: crypto.randomBytes(200).toString('hex') });
    await br.call('PUT', '/blobs/' + p.hash + '/0?of=1', null, { raw: p.z, ct: 'application/octet-stream', headers: { 'x-wts-zsha': p.zsha, 'x-wts-chunk-sha': sha(p.z) } });
    parts.push(p);
  }
  const r = await br.call('POST', '/projects/' + pid + '/commit', { pushId: crypto.randomUUID(), baseRev: 0, reason: 'save',
    core: { hash: core.hash, vhash: core.hash, zsha: core.zsha, bytes: core.bytes, inline: core.z.toString('base64') },
    parts: parts.map((p, i) => ({ name: 'well/w' + i, hash: p.hash, bytes: p.bytes })),
    meta: { name, client: 'Operator Energy Ltd', well: 'Example-1', field: '', operator: '' }, wells: parts.map((p, i) => ({ id: 'w' + i, name: 'W' + i })), fmt: 2, appVer: '4.0' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  return { pid, parts, core };
}

test.describe('account, jobs, ops (§3.3, §3.5, §8.5, §13)', { skip }, () => {
  test.before(async () => { T = await harness('account'); });
  test.after(async () => { if (T) await T.close(); });

  test('export: step-up, the account JSON, 300 MB/h read unlock for this session for 2 h, notice, 5 per day', async () => {
    const br = T.browser(); const email = 'xena@company.example';
    await T.signIn(br, email, { deviceLabel: 'Laptop' });
    await project(br, 'Export me');
    const r = await br.call('POST', '/account/export', {});
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.ok(C.checkShape('ExportRes', r.json).ok, JSON.stringify(C.checkShape('ExportRes', r.json).errors));
    assert.strictEqual(r.json.user.email, email);
    assert.strictEqual(r.json.projects.length, 1); assert.strictEqual(r.json.projects[0].name, 'Export me'); assert.strictEqual(r.json.projects[0].revs.length, 1);
    assert.ok(r.json.audit.some((a) => a.action === 'signin'));
    assert.ok(!JSON.stringify(r.json.audit).includes('@'), 'no address in audit rows');
    assert.ok(T.lastMail(email, 'notice_export'));
    const s = await T.db.sql`select extract(epoch from read_unlock_until - now())::int as d from wts.sessions where user_id = ${await T.userId(email)} and replaced_by is null`;
    assert.ok(s.some((x) => x.d > 7100 && x.d <= 7200), 'this session is unlocked for 2 hours');
    // the unlock: this session may read past the normal 100 MB/h (per user and per session) — up to 300 MB/h
    const uid = await T.userId(email);
    const head = (await br.call('GET', '/projects/' + (await br.call('GET', '/projects')).json[0].id + '/head')).json;
    const win = 'to_timestamp(floor(extract(epoch from now()) / 3600) * 3600)';
    await T.db.sql.unsafe("insert into wts.rate_counters (bucket, window_start, n) values ('blobReadUserHour:" + uid + "', " + win + ", 100000000) on conflict do nothing");
    assert.strictEqual((await br.call('GET', '/blobs/' + head.parts[0].hash + '/0')).status, 200, 'unlocked: 300 MB/h');
    const other = T.browser(); await T.signIn(other, email, { consent: false });
    assert.strictEqual((await other.call('GET', '/blobs/' + head.parts[0].hash + '/0')).status, 429, 'another session of the account stays at 100 MB/h');
    // the daily cap rises with the unlock too (600 MB = two hours at 300 MB/h); other sessions keep 300 MB/day
    const day = 'to_timestamp(floor(extract(epoch from now()) / 86400) * 86400)';
    await T.db.sql.unsafe("update wts.rate_counters set n = 0 where bucket = 'blobReadUserHour:" + uid + "'");
    await T.db.sql.unsafe("insert into wts.rate_counters (bucket, window_start, n) values ('blobReadUserDay:" + uid + "', " + day + ", 400000000) on conflict (bucket, window_start) do update set n = 400000000");
    assert.strictEqual((await br.call('GET', '/blobs/' + head.parts[0].hash + '/0')).status, 200, 'unlocked: past 300 MB in the day');
    assert.strictEqual((await other.call('GET', '/blobs/' + head.parts[0].hash + '/0')).status, 429, 'not unlocked: 300 MB/day');
    for (let i = 0; i < 4; i++) assert.strictEqual((await br.call('POST', '/account/export', {})).status, 200);
    const sixth = await br.call('POST', '/account/export', {});
    assert.strictEqual(sixth.status, 429, '5 exports a day');
  });

  test('delete: grace, sessions out, identities released, everything hidden; a sign-in in the grace sees only /me and cancel', async () => {
    const br = T.browser(); const email = 'yuri@company.example';
    const s = await T.signIn(br, email);
    const id = s.user.id;
    await project(br, 'Doomed');
    await T.db.sql`insert into wts.identities (id, user_id, provider, issuer, subject_bidx, subject_enc, email_verified_at_link, linked_at, linked_via)
      values (gen_random_uuid(), ${id}, 'google', 'https://issuer.example', ${Buffer.alloc(32, 5)}, ${Buffer.from('s')}, true, now(), 'signup')`;
    assert.strictEqual((await br.call('POST', '/account/delete', { confirm: 'NOPE' })).status, 400);
    // immediate needs a fresh (second) step-up
    await T.age`update wts.sessions set stepup_at = now() - interval '5 minutes' where user_id = ${id}`;
    assert.strictEqual((await br.call('POST', '/account/delete', { confirm: 'DELETE', immediate: true })).json.error, 'reauth');
    const d = await br.call('POST', '/account/delete', { confirm: 'DELETE' });
    assert.strictEqual(d.status, 200); assert.ok(C.checkShape('DeleteRes', d.json).ok);
    assert.ok(Math.abs(Date.parse(d.json.deleteAt) - Date.now() - 7 * 86400e3) < 60e3, 'purge in 7 days');
    assert.strictEqual(br.cookie('__Host-wts_sid'), null);
    assert.strictEqual((await T.db.sql`select count(*)::int as n from wts.sessions where user_id = ${id}`)[0].n, 0);
    assert.strictEqual((await T.db.sql`select count(*)::int as n from wts.identities where user_id = ${id}`)[0].n, 0, 'identities released at the request');
    assert.strictEqual((await T.db.sql`select count(*)::int as n from wts.deletion_ledger where user_id = ${id} and purged_at is null`)[0].n, 1);
    assert.ok(T.lastMail(email, 'notice_delete_requested'));
    const b2 = T.browser(); await T.signIn(b2, email, { consent: false });
    const me = await b2.call('GET', '/me');
    assert.strictEqual(me.json.user.status, 'deleting'); assert.ok(me.json.user.deleteAt);
    const g = await b2.call('GET', '/projects');
    assert.strictEqual(g.status, 410); assert.strictEqual(g.json.error, 'gone');
    assert.strictEqual((await b2.call('POST', '/account/delete/cancel', {})).status, 200);
    assert.strictEqual((await b2.call('GET', '/me')).json.user.status, 'active');
    assert.strictEqual((await b2.call('GET', '/projects')).json.length, 1, 'the projects are back');
    assert.ok(T.lastMail(email, 'notice_delete_cancelled'));
    assert.strictEqual((await T.db.sql`select count(*)::int as n from wts.deletion_ledger where user_id = ${id}`)[0].n, 0);
    // a cancel that did not happen is never reported as one
    const again = await b2.call('POST', '/account/delete/cancel', {});
    assert.strictEqual(again.status, 410); assert.strictEqual(again.json.error, 'gone');
  });

  test('the daily job purges an account after its grace: rows, objects, tombstoned audit, ledger row and ledger object; replay after a restore', async () => {
    const br = T.browser(); const email = 'zack@company.example';
    const s = await T.signIn(br, email); const id = s.user.id;
    const { parts } = await project(br, 'Purge me', 2);
    const audit0 = (await T.db.sql`select count(*)::int as n from wts.audit where user_id = ${id}`)[0].n;
    assert.ok(audit0 >= 2);
    assert.ok((await T.objects.list('u/' + id + '/')).length >= 3);
    await T.stepUp(br);
    assert.strictEqual((await br.call('POST', '/account/delete', { confirm: 'DELETE', immediate: true })).status, 200, 'immediate after a fresh step-up');
    const did = await T.jobs.run();
    assert.strictEqual(did.accounts.purged, 1, JSON.stringify(did));
    assert.strictEqual(await T.userId(email), null);
    assert.strictEqual((await T.db.sql`select count(*)::int as n from wts.blobs where user_id = ${id}`)[0].n, 0);
    assert.deepStrictEqual(await T.objects.list('u/' + id + '/'), [], 'every object of the account is gone');
    assert.strictEqual((await T.db.sql`select count(*)::int as n from wts.audit where user_id = ${id}`)[0].n, 0, 'no audit row keeps the id');
    assert.ok((await T.db.sql`select count(*)::int as n from wts.audit where action = 'signin'`)[0].n >= audit0 - 1, 'the rows themselves are kept (tombstone)');
    const ledger = await T.db.sql`select purged_at from wts.deletion_ledger where user_id = ${id}`;
    assert.ok(ledger[0] && ledger[0].purged_at, 'ledger stamped');
    const obj = JSON.parse((await T.objects.get('ledger/' + id)).toString());
    assert.strictEqual(obj.userId, id); assert.ok(!JSON.stringify(obj).includes('@'), 'ids and dates only');
    assert.ok(T.lastMail(email, 'notice_delete_done'));
    void parts;
    // a database restore brings the account back; the replay removes it again before the API re-opens
    await T.db.sql`insert into wts.users (id, email_bidx, email_enc, terms_version, privacy_version, consented_at, data_key_wrapped, data_key_kid)
      values (${id}, ${T.keys.emailBidx(email)}, '\\x00', '1', '1', now(), '\\x00', 1)`;
    await T.db.sql`delete from wts.deletion_ledger where user_id = ${id}`;
    const rep = await J.ledgerReplay({ db: T.jobsDb, objects: T.objects });
    assert.strictEqual(rep.replayed, 1);
    assert.strictEqual(await T.userId(email), null);
    assert.strictEqual((await T.db.sql`select count(*)::int as n from wts.deletion_ledger where user_id = ${id} and purged_at is not null`)[0].n, 1);
  });

  test('daily job: expired codes / sessions / receipts / counters purged, mail retried, old trash purged, unreferenced blobs dropped, quota recomputed', async () => {
    const br = T.browser(); const email = 'amy@company.example';
    const s = await T.signIn(br, email); const id = s.user.id;
    const { pid, parts } = await project(br, 'Old trash', 1);
    await br.call('POST', '/projects/' + pid + '/trash', {});
    await T.age`update wts.projects set deleted_at = now() - interval '31 days' where id = ${pid}`;
    await T.age`update wts.email_codes set expires_at = now() - interval '25 hours'`;
    await T.age`insert into wts.sessions (sid_hash, user_id, public_device, created_at, auth_at, last_seen_at, idle_expires_at, abs_expires_at)
      values (${crypto.randomBytes(32)}, ${id}, false, now(), now(), now(), now() - interval '1 minute', now() + interval '1 day')`;
    await T.age`update wts.push_receipts set at = now() - interval '25 hours'`;
    // an unsent mail row: the transport failed at the time
    const failing = { send() { return Promise.reject(new Error('down')); } };
    const saved = T.app; T.app = require('../core/app').createApp({ config: T.config, db: T.api, mail: failing, objects: T.objects, keys: T.keys, log: T.log });
    await T.browser().call('POST', '/auth/code/start', { email: 'retry@company.example', purpose: 'signin' });
    T.app = saved;
    await T.age`update wts.mail_outbox set created_at = now() - interval '6 minutes' where sent_at is null`;
    const before = T.mailsTo('retry@company.example').length;
    const did = await T.jobs.run();
    assert.ok(did.purge.codes >= 1 && did.purge.sessions >= 1 && did.purge.receipts >= 1, JSON.stringify(did.purge));
    assert.strictEqual(did.mail.sent >= 1, true, JSON.stringify(did.mail));
    assert.strictEqual(T.mailsTo('retry@company.example').length, before + 1, 'the queued code mail is retried');
    assert.strictEqual(did.trash.projects, 1);
    assert.strictEqual((await T.db.sql`select count(*)::int as n from wts.projects where id = ${pid}`)[0].n, 0);
    // the part is now unreferenced; after 7 days the blob and its objects go
    const hb = Buffer.from(parts[0].hash, 'hex');
    assert.strictEqual(Number((await T.db.sql`select refcount from wts.blobs where hash = ${hb}`)[0].refcount), 0);
    await T.age`update wts.blobs set unref_at = now() - interval '8 days' where hash = ${hb}`;
    const d2 = await T.jobs.run({ only: ['blobs', 'quota'] });
    assert.ok(d2.blobs.blobs >= 1);
    assert.strictEqual(await T.objects.get('u/' + id + '/b/' + parts[0].hash + '/0'), null);
    const u = (await T.db.sql`select used_bytes from wts.users where id = ${id}`)[0];
    const sum = (await T.db.sql`select coalesce(sum(bytes), 0)::bigint as s from wts.blobs where user_id = ${id} and complete`)[0].s;
    assert.strictEqual(Number(u.used_bytes), Number(sum), 'quota recomputed from complete blobs');
  });

  test('inactivity: warnings at 23 months, a deletion request with grace at 24 months', async () => {
    const br = T.browser(); const email = 'old@company.example';
    const s = await T.signIn(br, email); const id = s.user.id;
    await T.age`update wts.users set last_sign_in_at = now() - interval '23 months 2 days' where id = ${id}`;
    const d1 = await T.jobs.run({ only: ['inactive'] });
    assert.strictEqual(d1.inactive.warned, 1); assert.ok(T.lastMail(email, 'notice_inactivity'));
    assert.strictEqual((await T.jobs.run({ only: ['inactive'] })).inactive.warned, 0, 'one warning, not one per day');
    await T.age`update wts.users set last_sign_in_at = now() - interval '25 months' where id = ${id}`;
    const d2 = await T.jobs.run({ only: ['inactive'] });
    assert.strictEqual(d2.inactive.started, 1);
    const u = (await T.db.sql`select status, delete_at from wts.users where id = ${id}`)[0];
    assert.strictEqual(u.status, 'deleting'); assert.ok(+u.delete_at > Date.now() + 6 * 86400e3);
    const a = await T.db.sql`select actor, detail from wts.audit where user_id = ${id} and action = 'delete_request'`;
    assert.strictEqual(a.length, 1); assert.strictEqual(a[0].actor, 'system'); assert.strictEqual(a[0].detail.reason, 'inactivity');
    const m = T.lastMail(email, 'notice_delete_requested');
    assert.ok(m && /cancel/i.test(m.text) && /LinkedIn/.test(m.text), 'the deletion notice, with how to cancel');
    assert.strictEqual((await T.db.sql`select count(*)::int as n from wts.mail_outbox where sent_at is null`)[0].n, 0, 'queued and sent');
    assert.ok((await J.auditVerify(T.db.sql)).bad.length === 0, 'the system row keeps the chain valid');
  });

  test('purge: the rows are committed before the objects go; a failed object delete is finished from the ledger by the next run', async () => {
    const br = T.browser(); const email = 'yara@company.example';
    const s = await T.signIn(br, email); const id = s.user.id;
    await project(br, 'Purge later', 1);
    await T.stepUp(br);
    assert.strictEqual((await br.call('POST', '/account/delete', { confirm: 'DELETE', immediate: true })).status, 200);
    const flaky = Object.assign({}, T.objects, { delPrefix() { return Promise.reject(new Error('store down')); } });
    const d1 = await J.runDaily({ db: T.jobsDb, keys: T.keys, objects: flaky, mail: T.mail, log: T.log, only: ['accounts'] });
    assert.strictEqual(d1.accounts.purged, 1, JSON.stringify(d1));
    assert.strictEqual(await T.userId(email), null, 'the rows are gone');
    assert.ok((await T.objects.list('u/' + id + '/')).length >= 1, 'the objects are still there');
    assert.ok(await T.objects.get('ledger/' + id), 'the ledger object was written before the object delete');
    const d2 = await T.jobs.run({ only: ['accounts'] });
    assert.ok(d2.accounts.retried >= 1, JSON.stringify(d2));
    assert.deepStrictEqual(await T.objects.list('u/' + id + '/'), [], 'finished from the ledger');
  });

  test('audit: a hash chain per account, append-only for wts_api, verified and anchored daily (chain/<date> with a Merkle root); tamper is found', async () => {
    const v = await J.auditVerify(T.db.sql);
    assert.deepStrictEqual(v.bad, []); assert.deepStrictEqual(v.broken, []);
    assert.ok(v.heads.length >= 2);
    const did = await T.jobs.run({ only: ['anchor'] });
    const date = new Date().toISOString().slice(0, 10);
    const a = JSON.parse((await T.objects.get('chain/' + date)).toString());
    assert.strictEqual(a.root, did.anchor.root); assert.strictEqual(a.root, J.merkle(a.heads.map((h) => h.chain + ':' + h.head)));
    // wts_api may add rows but never change them
    const br = T.browser(); const s = await T.signIn(br, 'audit@company.example');
    await assert.rejects(T.api.asUser(s.user.id, (tx) => tx`update wts.audit set action = 'x' where user_id = ${s.user.id}`), /permission denied/);
    await assert.rejects(T.api.asUser(s.user.id, (tx) => tx`delete from wts.audit where user_id = ${s.user.id}`), /permission denied/);
    // a database-level edit is found by the next check
    await T.db.sql`alter table wts.audit disable trigger audit_guard`;
    await T.db.sql`update wts.audit set action = 'forged' where id = (select max(id) from wts.audit where user_id = ${s.user.id})`;
    await T.db.sql`alter table wts.audit enable trigger audit_guard`;
    const v2 = await J.auditVerify(T.db.sql);
    assert.strictEqual(v2.bad.length, 1);
    await T.jobs.run({ only: ['anchor'] });
    assert.ok(T.logs.some((l) => /audit chain check failed/.test(l)));
  });

  test('ops-daily through the pipeline: HMAC, one-time nonce shared through the database, runs the jobs', async () => {
    const opsKey = T.config.secrets.opsHmac;
    const ts = String(Math.floor(Date.now() / 1000)); const nonce = crypto.randomBytes(12).toString('hex');
    const sig = H.opsSignature(opsKey, 'POST', C.BASE + '/ops/daily', ts, nonce);
    const call = () => T.app.handle({ method: 'POST', url: C.BASE + '/ops/daily', headers: { host: 'welltest.h2oil.co.uk', 'content-type': 'application/json',
      'x-wts-ts': ts, 'x-wts-nonce': nonce, 'x-wts-sig': sig }, body: Buffer.from('{}'), remoteAddress: '203.0.113.5' });
    const r = await call();
    assert.strictEqual(r.status, 200, r.body);
    const b = JSON.parse(r.body);
    assert.ok(C.checkShape('OpsDailyRes', b).ok); assert.ok(b.did.purge && b.did.anchor);
    assert.strictEqual((await call()).status, 403, 'replay refused');
  });

  test('csp-report: aggregate counts per directive and blocked host only; strict per-prefix limit', async () => {
    const send = (body, ip) => T.app.handle({ method: 'POST', url: C.BASE + '/csp-report', headers: { host: 'welltest.h2oil.co.uk', 'content-type': 'application/csp-report' },
      body: Buffer.from(JSON.stringify(body)), remoteAddress: ip || '198.51.100.77' });
    const rep = { 'csp-report': { 'document-uri': 'https://welltest.h2oil.co.uk/well-testing-app.html?secret=1', 'effective-directive': 'script-src-elem',
      'blocked-uri': 'https://cdn.example/lib.js?token=abc' } };
    assert.strictEqual((await send(rep)).status, 204);
    const rows = await T.db.sql`select bucket, n from wts.rate_counters where bucket like 'cspCountDay:%'`;
    assert.deepStrictEqual(rows.map((r) => r.bucket), ['cspCountDay:script-src-elem|cdn.example']);
    assert.ok(!JSON.stringify(await T.db.sql`select * from wts.rate_counters`).includes('secret'), 'no page URL, no query string');
    for (let i = 0; i < 120; i++) await send(rep, '198.51.100.88');
    const over = await send(rep, '198.51.100.88');
    assert.strictEqual(over.status, 429);
    const arr = [{ type: 'csp-violation', body: { effectiveDirective: 'connect-src', blockedURL: 'wss://other.example/x' } }];
    const r2 = await T.app.handle({ method: 'POST', url: C.BASE + '/csp-report', headers: { host: 'welltest.h2oil.co.uk', 'content-type': 'application/reports+json' }, body: Buffer.from(JSON.stringify(arr)), remoteAddress: '192.0.2.1' });
    assert.strictEqual(r2.status, 204);
    assert.strictEqual((await T.db.sql`select count(*)::int as n from wts.rate_counters where bucket = 'cspCountDay:connect-src|other.example'`)[0].n, 1);
  });

  test('support functions (wts_support): audited lookup, allow-list, security reset and recovery; nothing else reachable', async () => {
    const sup = T.H.as('wts_support');
    const br = T.browser(); const email = 'sue@company.example';
    const s = await T.signIn(br, email); const id = s.user.id;
    const found = await O.lookup({ db: sup, keys: T.keys, actor: 'support:owner', email });
    assert.strictEqual(found.userId, id);
    assert.strictEqual(await O.lookup({ db: sup, keys: T.keys, actor: 'support:owner', email: 'none@company.example' }), null);
    await assert.rejects(O.lookup({ db: sup, keys: T.keys, actor: 'mallory', email }), /actor/);
    const rows = await T.db.sql`select actor, action from wts.audit where actor like 'support:%'`;
    assert.ok(rows.filter((r) => r.action === 'support_lookup').length >= 2, 'one audit row per lookup');
    await assert.rejects(sup.sql`select * from wts.users`, /permission denied/);
    // allow-list
    T.setEnv({ ACCOUNTS_SIGNUP: 'invite' });
    assert.strictEqual(await O.allowlistAdd({ db: sup, keys: T.keys, actor: 'support:owner', email: 'beta@company.example', note: 'beta wave 1' }), true);
    await T.signIn(T.browser(), 'beta@company.example');
    T.setEnv({ ACCOUNTS_SIGNUP: 'open' });
    // security reset: sessions out, a recent identity removed with its sessions
    await T.db.sql`insert into wts.identities (id, user_id, provider, issuer, subject_bidx, subject_enc, email_verified_at_link, linked_at, linked_via)
      values (gen_random_uuid(), ${id}, 'linkedin', 'https://issuer.example', ${Buffer.alloc(32, 8)}, ${Buffer.from('s')}, false, now(), 'account_page')`;
    const reset = await O.securityReset({ db: sup, actor: 'support:owner', userId: id, since: new Date(Date.now() - 3600e3) });
    assert.strictEqual(reset.identities, 1); assert.ok(reset.sessions >= 1);
    assert.strictEqual((await br.call('GET', '/me')).json.error, 'signed_out');
    // recovery: the new address becomes the primary; the old one keeps a revert window
    await O.recover({ db: sup, jobsDb: T.jobsDb, keys: T.keys, actor: 'support:owner', userId: id, newEmail: 'sue.new@company.example' });
    assert.strictEqual(await T.userId('sue.new@company.example'), id);
    const b3 = T.browser(); const s3 = await T.signIn(b3, 'sue.new@company.example', { consent: false });
    assert.strictEqual(s3.user.id, id);
    const w1 = (await T.db.sql`select email_prev_bidx, email_changed_at, email_revert_until from wts.users where id = ${id}`)[0];
    assert.ok(w1.email_revert_until);
    // a second recovery inside the window keeps the ORIGINAL address revertible (same rule as email_move, T18)
    await O.recover({ db: sup, jobsDb: T.jobsDb, keys: T.keys, actor: 'support:owner', userId: id, newEmail: 'sue.third@company.example' });
    const w2 = (await T.db.sql`select email_prev_bidx, email_changed_at, email_revert_until from wts.users where id = ${id}`)[0];
    assert.ok(Buffer.from(w2.email_prev_bidx).equals(T.keys.emailBidx(email)), 'still the first address');
    assert.strictEqual(+w2.email_changed_at, +w1.email_changed_at); assert.strictEqual(+w2.email_revert_until, +w1.email_revert_until);
    assert.strictEqual(await T.userId('sue.third@company.example'), id);
  });

  test('master-key rotation: rewrap every key ring with a new kid, data stays readable, the old kid can then be retired', async () => {
    const br = T.browser(); const email = 'rot@company.example';
    await T.signIn(br, email);
    await project(br, 'Rotate');
    const kid1 = T.config.secrets.masterKeys[0];
    const k2 = crypto.randomBytes(32).toString('base64');
    const both = createKeys(loadJobsConfig(Object.assign({}, process.env, { WTS_ENV: 'test', WTS_MASTER_KEYS: kid1.kid + ':' + kid1.key.toString('base64') + ',2:' + k2,
      WTS_MASTER_KID: '2', WTS_INDEX_PEPPER: T.config.secrets.indexPepper.toString('base64'),
      WTS_CODE_PEPPERS: T.config.secrets.codePeppers.map((p) => p.kid + ':' + p.key.toString('base64')).join(',') })));
    const st0 = await O.ringStatus({ db: T.jobsDb, keys: both });
    assert.ok(st0.byKid[1] >= 1);
    const r = await O.rewrapAll({ db: T.jobsDb, keys: both, toKid: 2 });
    assert.strictEqual(r.rewrapped, st0.total);
    const st1 = await O.ringStatus({ db: T.jobsDb, keys: both });
    assert.deepStrictEqual(Object.keys(st1.byKid), ['2'], 'no ring left on kid 1');
    // the functions now run with kid 2 only: sign-in, the project list and the blobs still read
    const only2 = { WTS_MASTER_KEYS: '2:' + k2, WTS_MASTER_KID: '2' };
    T.setEnv(only2);
    const b2 = T.browser(); await T.signIn(b2, email, { consent: false });
    const list = (await b2.call('GET', '/projects')).json;
    assert.strictEqual(list[0].name, 'Rotate');
    const head = (await b2.call('GET', '/projects/' + list[0].id + '/head')).json;
    const g = await b2.call('GET', '/blobs/' + head.parts[0].hash + '/0');
    assert.strictEqual(g.status, 200, 'chunks written under kid 1 read through the re-wrapped ring');
  });
});
